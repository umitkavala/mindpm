import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { randomUUID } from 'node:crypto';
import { getDb, generateId, resolveProjectOrDefault, resolveProjectError, resolveTaskId } from '../db/queries.js';
import {
  ACTOR_FORMAT_HINT, openBlockers, parseActor, parseIdList, recordHistory, specAllowsWork, ToolError,
} from '../domain/lifecycle.js';
import { afterUsedAttempt, attemptsLeft, closeClaim, expireLeases, requireLiveClaim } from '../domain/attempts.js';
import { buildBrief } from '../domain/brief.js';
import { criterionKey, specKey, type SpecRow } from '../domain/specs.js';
import { errorResult, guarded, jsonResult } from './results.js';

const PRIORITY_ORDER = "CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END";
const DEFAULT_LEASE_MINUTES = 30;
const MAX_LEASE_MINUTES = 120;
const SHA = z.string().regex(/^[0-9a-f]{7,40}$/i, 'head_sha must be a 7 to 40 character hex commit SHA');
const FAILURE_TYPES = ['build_error', 'test_failure', 'spec_gap', 'environment', 'dependency', 'design_conflict', 'timeout', 'other'] as const;

interface TaskRow {
  id: string;
  project_id: string;
  status: string;
  spec_id: string | null;
  blocked_by: string | null;
  max_attempts: number | null;
  claim_token: string | null;
  key: string;
  title: string;
  priority: string;
}

function requireTask(ref: string): TaskRow {
  const id = resolveTaskId(ref);
  if (!id) throw new ToolError('not_found', `Task "${ref}" not found.`);
  return getDb().prepare(
    "SELECT t.*, p.slug || '-' || t.seq AS key FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.id = ?",
  ).get(id) as TaskRow;
}

// Why a ready-looking task can't be worked on now, or null when it can.
function workBlocker(task: TaskRow): string | null {
  const db = getDb();
  if (!specAllowsWork(db, task.spec_id)) return 'spec_not_approved';
  if (openBlockers(db, parseIdList(task.blocked_by)).length > 0) return 'blocked';
  if (attemptsLeft(db, task) === 0) return 'attempts_exhausted';
  return null;
}

export function registerExecutorTools(server: McpServer): void {
  server.registerTool(
    'pick_task',
    {
      title: 'Pick Task',
      description:
        'Executor: return the next task to work on: ready, spec approved (or no spec), all blockers done, no live lease. ' +
        'Ordered by priority, then oldest. Does not claim; call claim_task next.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID'),
        actor: z.string().describe('Your actor id, e.g. agent:cli-7f3a'),
      },
    },
    async ({ project, actor }) => guarded(() => {
      if (!parseActor(actor)) return errorResult('invalid_actor', ACTOR_FORMAT_HINT);
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) return errorResult('not_found', resolveProjectError(project));
      const db = getDb();
      expireLeases(db);
      const candidates = db.prepare(
        `SELECT t.*, p.slug || '-' || t.seq AS key FROM tasks t JOIN projects p ON t.project_id = p.id
         WHERE t.project_id = ? AND t.status = 'ready' AND t.claim_token IS NULL
         ORDER BY ${PRIORITY_ORDER}, t.created_at ASC, t.seq ASC`,
      ).all(resolved.id) as TaskRow[];
      const skipped: Record<string, number> = {};
      for (const t of candidates) {
        const why = workBlocker(t);
        if (why) {
          skipped[why] = (skipped[why] ?? 0) + 1;
          continue;
        }
        const spec = t.spec_id ? (db.prepare('SELECT seq, risk_level FROM specs WHERE id = ?').get(t.spec_id) as Pick<SpecRow, 'seq' | 'risk_level'>) : null;
        return jsonResult({
          task_id: t.id,
          key: t.key,
          title: t.title,
          priority: t.priority,
          spec_key: spec ? specKey(spec) : null,
          risk_level: spec?.risk_level ?? null,
        });
      }
      const reason = candidates.length === 0
        ? 'No ready tasks in this project.'
        : `${candidates.length} ready task(s), none workable now: ${Object.entries(skipped).map(([k, n]) => `${n} ${k}`).join(', ')}.`;
      return jsonResult({ task: null, reason });
    }),
  );

  server.registerTool(
    'claim_task',
    {
      title: 'Claim Task',
      description:
        'Executor: take exclusive ownership of a ready task. Returns a claim_token that authorizes every later write, ' +
        'the lease expiry, and the task brief. Heartbeat before the lease runs out or the claim expires and counts as a used attempt.',
      inputSchema: {
        task_id: z.string().describe('Task id or key'),
        actor: z.string().describe('Your actor id, e.g. agent:cli-7f3a'),
        lease_minutes: z.number().int().min(1).max(MAX_LEASE_MINUTES).optional().describe(`Lease length (default ${DEFAULT_LEASE_MINUTES}, max ${MAX_LEASE_MINUTES})`),
      },
    },
    async ({ task_id, actor, lease_minutes }) => guarded(() => {
      const who = parseActor(actor);
      if (!who) return errorResult('invalid_actor', ACTOR_FORMAT_HINT);
      if (who.kind !== 'executor' && who.kind !== 'human') {
        throw new ToolError('forbidden', `${who.id} cannot claim tasks. Executors use agent:cli-<id>.`);
      }
      const minutes = Math.min(MAX_LEASE_MINUTES, Math.max(1, lease_minutes ?? DEFAULT_LEASE_MINUTES));
      const db = getDb();
      expireLeases(db);
      const token = randomUUID();
      const attemptId = generateId();

      const claimed = db.transaction(() => {
        const task = requireTask(task_id);
        if (task.status === 'claimed') throw new ToolError('already_claimed', `${task.key} is already claimed.`);
        if (task.status === 'blocked') throw new ToolError('blocked', `${task.key} is blocked.`);
        if (task.status !== 'ready') throw new ToolError('not_ready', `${task.key} is ${task.status}, not ready.`);
        const why = workBlocker(task);
        if (why === 'spec_not_approved') throw new ToolError('spec_not_approved', `${task.key}'s spec is not approved.`);
        if (why === 'blocked') throw new ToolError('blocked', `${task.key} depends on tasks that are not done.`);
        if (why === 'attempts_exhausted') throw new ToolError('attempts_exhausted', `${task.key} has used all its attempts.`);

        // Conditional on status and lease: of two racing claims, one wins.
        const won = db.prepare(
          `UPDATE tasks SET status = 'claimed', claimed_by = ?, claim_token = ?, lease_expires_at = datetime('now', ?)
           WHERE id = ? AND status = 'ready' AND claim_token IS NULL`,
        ).run(who.id, token, `+${minutes} minutes`, task.id);
        if (won.changes === 0) throw new ToolError('already_claimed', `${task.key} was claimed by someone else.`);

        const attemptNo = (db.prepare('SELECT COALESCE(MAX(attempt_no), 0) + 1 AS n FROM attempts WHERE task_id = ?').get(task.id) as { n: number }).n;
        const specVersion = task.spec_id
          ? (db.prepare('SELECT version FROM specs WHERE id = ?').get(task.spec_id) as { version: number }).version
          : null;
        db.prepare(
          'INSERT INTO attempts (id, task_id, attempt_no, actor, claim_token, lease_minutes, spec_version) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(attemptId, task.id, attemptNo, who.id, token, minutes, specVersion);
        recordHistory(db, task.id, 'status_changed', 'ready', 'claimed', who.id, attemptId);
        return { taskId: task.id, attemptNo };
      }).immediate();

      const lease = db.prepare('SELECT lease_expires_at FROM tasks WHERE id = ?').get(claimed.taskId) as { lease_expires_at: string };
      return jsonResult({
        claim_token: token,
        attempt_no: claimed.attemptNo,
        lease_expires_at: lease.lease_expires_at,
        brief: buildBrief(db, claimed.taskId),
      });
    }),
  );

  server.registerTool(
    'get_task_brief',
    {
      title: 'Get Task Brief',
      description:
        'Everything needed to execute a task in one read: task, spec and acceptance criteria, project conventions, verification commands, ' +
        'relevant decisions, dependencies and what previous attempts learned.',
      inputSchema: {
        task_id: z.string().describe('Task id or key'),
      },
    },
    async ({ task_id }) => guarded(() => {
      const db = getDb();
      expireLeases(db);
      return jsonResult(buildBrief(db, requireTask(task_id).id));
    }),
  );

  server.registerTool(
    'heartbeat',
    {
      title: 'Heartbeat',
      description:
        'Executor: extend your lease by its original length and log the phase you are in. ' +
        'If spec_changed comes back true, the spec was revised since you claimed: re-read it with get_task_brief before continuing.',
      inputSchema: {
        claim_token: z.string(),
        phase: z.enum(['implementing', 'testing', 'fixing']).optional(),
        note: z.string().max(500).optional(),
      },
    },
    async ({ claim_token, phase, note }) => guarded(() => {
      const db = getDb();
      expireLeases(db);
      const result = db.transaction(() => {
        const { attempt, task } = requireLiveClaim(db, claim_token);
        db.prepare("UPDATE tasks SET lease_expires_at = datetime('now', ?) WHERE id = ?").run(`+${attempt.lease_minutes} minutes`, task.id);
        if (phase) recordHistory(db, task.id, 'phase', null, phase, attempt.actor, attempt.id);
        if (note) recordHistory(db, task.id, 'note', null, note, attempt.actor, attempt.id);
        const spec = task.spec_id
          ? (db.prepare('SELECT version, status FROM specs WHERE id = ?').get(task.spec_id) as { version: number; status: string })
          : null;
        const lease = db.prepare('SELECT lease_expires_at FROM tasks WHERE id = ?').get(task.id) as { lease_expires_at: string };
        return {
          lease_expires_at: lease.lease_expires_at,
          spec_changed: spec !== null && spec.version !== attempt.spec_version,
          ...(spec && spec.status !== 'approved' ? { spec_status: spec.status } : {}),
        };
      }).immediate();
      return jsonResult(result);
    }),
  );

  server.registerTool(
    'submit_task',
    {
      title: 'Submit Task',
      description:
        'Executor: hand finished work over for verification. Requires the branch, head commit SHA, files touched, a summary, ' +
        'and a result for every acceptance criterion on the task. Moves the task to needs_verification.',
      inputSchema: {
        claim_token: z.string(),
        branch: z.string().min(1),
        head_sha: SHA,
        files_touched: z.array(z.string()),
        summary: z.string().min(1).max(1500),
        criteria_results: z.array(z.object({
          criterion_id: z.string().describe('Criterion id or key like "AC-12.1"'),
          result: z.enum(['pass', 'fail', 'not_run']),
          evidence: z.string().describe('Test name and outcome, command output summary, or what was checked'),
        })),
      },
    },
    async ({ claim_token, branch, head_sha, files_touched, summary, criteria_results }) => guarded(() => {
      if (!/^[0-9a-f]{7,40}$/i.test(head_sha)) throw new ToolError('invalid_sha', 'head_sha must be a 7 to 40 character hex commit SHA.');
      const db = getDb();
      expireLeases(db);
      const status = db.transaction(() => {
        const claim = requireLiveClaim(db, claim_token);
        const spec = claim.task.spec_id ? (db.prepare('SELECT seq FROM specs WHERE id = ?').get(claim.task.spec_id) as { seq: number }) : null;
        const owned = (db.prepare(
          'SELECT c.id, c.seq FROM acceptance_criteria c JOIN task_criteria tc ON tc.criterion_id = c.id WHERE tc.task_id = ? ORDER BY c.seq',
        ).all(claim.task.id) as { id: string; seq: number }[]).map(c => ({ id: c.id, key: spec ? criterionKey(spec, c) : c.id }));

        const results = criteria_results.map(r => {
          const c = owned.find(o => o.id === r.criterion_id || o.key.toLowerCase() === r.criterion_id.toLowerCase());
          if (!c) throw new ToolError('invalid_criteria', `"${r.criterion_id}" is not a criterion of this task.`);
          return { criterion_id: c.id, key: c.key, result: r.result, evidence: r.evidence };
        });
        const missing = owned.filter(o => !results.some(r => r.criterion_id === o.id)).map(o => o.key);
        if (missing.length) throw new ToolError('missing_criteria', `Report a result for every criterion. Missing: ${missing.join(', ')}.`);

        return closeClaim(db, claim, 'submitted', {
          branch, head_sha, summary,
          files_touched: JSON.stringify(files_touched),
          criteria_results: JSON.stringify(results),
        }, () => 'needs_verification');
      }).immediate();
      return jsonResult({ status });
    }),
  );

  server.registerTool(
    'report_failure',
    {
      title: 'Report Failure',
      description:
        'Executor: end your attempt as failed, with a root cause and notes the next attempt will see in its brief. ' +
        'spec_gap and design_conflict go to a human. dependency goes to blocked (name the blocking tasks in blocked_by so it unblocks itself). ' +
        'Anything else returns the task to ready, or to a human once attempts are exhausted.',
      inputSchema: {
        claim_token: z.string(),
        failure_type: z.enum(FAILURE_TYPES),
        root_cause: z.string().min(1).max(600).describe('What actually went wrong, specific enough to act on'),
        notes: z.string().max(1500).optional().describe('What was tried and what to avoid next time'),
        branch: z.string().optional(),
        head_sha: SHA.optional(),
        files_touched: z.array(z.string()).optional(),
        blocked_by: z.array(z.string()).optional().describe('For dependency failures: ids or keys of the tasks that must finish first'),
      },
    },
    async ({ claim_token, failure_type, root_cause, notes, branch, head_sha, files_touched, blocked_by }) => guarded(() => {
      if (root_cause.length > 600) throw new ToolError('too_long', 'root_cause is capped at 600 characters. Summarize; logs do not belong here.');
      if (notes && notes.length > 1500) throw new ToolError('too_long', 'notes are capped at 1500 characters.');
      const db = getDb();
      expireLeases(db);
      const result = db.transaction(() => {
        const claim = requireLiveClaim(db, claim_token);
        let blockers = parseIdList(claim.task.blocked_by);
        if (failure_type === 'dependency' && blocked_by?.length) {
          const named = blocked_by.map(ref => {
            const id = resolveTaskId(ref);
            if (!id) throw new ToolError('not_found', `Blocking task "${ref}" not found.`);
            return id;
          });
          blockers = [...new Set([...blockers, ...named])];
          db.prepare('UPDATE tasks SET blocked_by = ? WHERE id = ?').run(JSON.stringify(blockers), claim.task.id);
        }
        const status = closeClaim(db, claim, 'failed', {
          failure_type, root_cause,
          notes: notes ?? null,
          branch: branch ?? null,
          head_sha: head_sha ?? null,
          files_touched: files_touched ? JSON.stringify(files_touched) : null,
        }, task => {
          if (failure_type === 'spec_gap' || failure_type === 'design_conflict') return 'needs_human';
          if (failure_type === 'dependency') {
            // Unnamed dependency: blocked until a human clears it.
            if (!blocked_by?.length || openBlockers(db, blockers).length > 0) return 'blocked';
          }
          return afterUsedAttempt(db, task);
        });
        return { status, attempts_left: attemptsLeft(db, claim.task) };
      }).immediate();
      return jsonResult(result);
    }),
  );

  server.registerTool(
    'escalate',
    {
      title: 'Escalate',
      description:
        'Executor: stop and ask a human, for example when the spec is ambiguous. Ends the attempt as abandoned (it does not use up an attempt) ' +
        'and moves the task to needs_human with your question attached.',
      inputSchema: {
        claim_token: z.string(),
        question: z.string().min(1).max(1000),
        options: z.array(z.string()).optional().describe('Possible answers you see, if any'),
      },
    },
    async ({ claim_token, question, options }) => guarded(() => {
      const db = getDb();
      expireLeases(db);
      const status = db.transaction(() => {
        const claim = requireLiveClaim(db, claim_token);
        return closeClaim(db, claim, 'abandoned', {
          escalation: JSON.stringify({ question, ...(options?.length ? { options } : {}) }),
        }, () => 'needs_human');
      }).immediate();
      return jsonResult({ status });
    }),
  );

  server.registerTool(
    'release_task',
    {
      title: 'Release Task',
      description: 'Executor: give the task back voluntarily, for example when your run budget is spent. Does not use up an attempt.',
      inputSchema: {
        claim_token: z.string(),
        reason: z.string().min(1).max(1500),
      },
    },
    async ({ claim_token, reason }) => guarded(() => {
      const db = getDb();
      expireLeases(db);
      const status = db.transaction(() => {
        const claim = requireLiveClaim(db, claim_token);
        return closeClaim(db, claim, 'abandoned', { notes: reason }, () => 'ready');
      }).immediate();
      return jsonResult({ status });
    }),
  );
}
