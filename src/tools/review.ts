import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { getDb, resolveTaskId } from '../db/queries.js';
import {
  ACTOR_FORMAT_HINT, actorLabel, assertDelegateMayAct, canTransition, openBlockers, parseActor, parseIdList, recordHistory, releasedStatus, setStatus, ToolError,
  type TaskStatus,
} from '../domain/lifecycle.js';
import { afterUsedAttempt, attemptsLeft, attemptsUsed, expireLeases } from '../domain/attempts.js';
import { specKey, type SpecRow } from '../domain/specs.js';
import { errorResult, guarded, jsonResult } from './results.js';

interface TaskRow { id: string; status: string; spec_id: string | null; blocked_by: string | null; max_attempts: number | null }

function requireTask(ref: string): TaskRow {
  const id = resolveTaskId(ref);
  if (!id) throw new ToolError('not_found', `Task "${ref}" not found.`);
  return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow;
}

export function registerReviewTools(server: McpServer): void {
  server.registerTool(
    'review_task',
    {
      title: 'Review Task',
      description:
        'Accept or reject submitted work (Phase 1 stand-in for the verifier). Run the verification commands first. ' +
        'agent:reviewer may accept low-risk specs only; medium and high risk need human:*. Nobody reviews their own submission. ' +
        'Reject requires findings: they go into the next attempt\'s brief, and the task returns to ready (or to a human once attempts are exhausted).',
      inputSchema: {
        task_id: z.string(),
        actor: z.string(),
        decision: z.enum(['accept', 'reject']),
        findings: z.string().max(1500).optional().describe('Required on reject: what failed and what to change'),
        on_behalf_of: z.string().optional().describe('When a human explicitly asked you (an agent) to review: their id. You still cannot review work you submitted or hold'),
      },
    },
    async ({ task_id, actor, decision, findings, on_behalf_of }) => guarded(() => {
      const who = parseActor(actor, on_behalf_of);
      if (!who) return errorResult('invalid_actor', ACTOR_FORMAT_HINT);
      if (who.kind !== 'human' && who.kind !== 'reviewer') {
        throw new ToolError('forbidden', `${who.id} cannot review. Use human:* or agent:reviewer.`);
      }
      if (decision === 'reject' && !findings?.trim()) throw new ToolError('findings_required', 'A rejection needs findings.');
      if (findings && findings.length > 1500) throw new ToolError('too_long', 'findings are capped at 1500 characters.');

      const db = getDb();
      const status = db.transaction(() => {
        const task = requireTask(task_id);
        if (task.status !== 'needs_verification') {
          throw new ToolError('illegal_transition', `Only tasks in needs_verification can be reviewed; this one is ${task.status}.`);
        }
        const spec = task.spec_id ? (db.prepare('SELECT * FROM specs WHERE id = ?').get(task.spec_id) as SpecRow) : null;
        // A plain task has no declared risk, so it is treated as medium.
        const risk = spec?.risk_level ?? 'medium';
        if (decision === 'accept' && who.kind === 'reviewer' && risk !== 'low') {
          throw new ToolError('forbidden', `${spec ? specKey(spec) : 'This task'} is ${risk} risk; a human (human:*) must accept it.`);
        }
        const attempt = db.prepare(
          "SELECT id, actor FROM attempts WHERE task_id = ? AND outcome = 'submitted' ORDER BY attempt_no DESC LIMIT 1",
        ).get(task.id) as { id: string; actor: string } | undefined;
        if (attempt?.actor === who.id) throw new ToolError('forbidden', 'You submitted this work; someone else must review it.');
        assertDelegateMayAct(db, who, task.id);

        if (attempt) {
          db.prepare('UPDATE attempts SET review_decision = ?, review_findings = ?, reviewed_by = ? WHERE id = ?')
            .run(decision, findings ?? null, actorLabel(who), attempt.id);
        }
        const to: TaskStatus = decision === 'accept' ? 'done' : afterUsedAttempt(db, task);
        if (!canTransition(task.status, to, who.kind)) throw new ToolError('illegal_transition', `${task.status} → ${to} is not allowed for ${who.id}.`);
        setStatus(db, task.id, task.status, to, who, attempt?.id ?? null);
        return to;
      }).immediate();
      return jsonResult({ status });
    }),
  );

  server.registerTool(
    'resolve_needs_human',
    {
      title: 'Resolve Needs Human',
      description:
        'Human only: answer a task waiting in needs_human. requeue returns it to the queue (granting one more attempt if the budget is spent); ' +
        'cancel ends it; revise_spec sends it to backlog and returns its spec to draft until the revised spec is approved again.',
      inputSchema: {
        task_id: z.string(),
        actor: z.string(),
        action: z.enum(['requeue', 'cancel', 'revise_spec']),
        note: z.string().min(1).max(1500).describe('The answer or reason. Recorded in the task history'),
        on_behalf_of: z.string().optional().describe("When a human explicitly gave you (an agent) this answer: their id"),
      },
    },
    async ({ task_id, actor, action, note, on_behalf_of }) => guarded(() => {
      const who = parseActor(actor, on_behalf_of);
      if (!who) return errorResult('invalid_actor', ACTOR_FORMAT_HINT);
      if (who.kind !== 'human') throw new ToolError('forbidden', 'Only a human (human:*, or an agent with on_behalf_of) can resolve needs_human.');

      const db = getDb();
      expireLeases(db);
      const result = db.transaction(() => {
        const task = requireTask(task_id);
        if (task.status !== 'needs_human') throw new ToolError('illegal_transition', `This task is ${task.status}, not needs_human.`);
        assertDelegateMayAct(db, who, task.id);
        recordHistory(db, task.id, 'resolution', null, JSON.stringify({ action, note }), who);

        let to: TaskStatus;
        let specNote: string | undefined;
        if (action === 'cancel') {
          to = 'cancelled';
        } else if (action === 'revise_spec') {
          if (!task.spec_id) throw new ToolError('invalid_state', 'This task has no spec to revise.');
          const spec = db.prepare('SELECT * FROM specs WHERE id = ?').get(task.spec_id) as SpecRow;
          if (spec.status === 'superseded' || spec.status === 'cancelled') {
            throw new ToolError('invalid_state', `${specKey(spec)} is ${spec.status}; link the task to its replacement instead.`);
          }
          // Back to draft: pick_task stops handing out sibling tasks until
          // the revision is approved, which also bumps the version.
          if (spec.status === 'approved') db.prepare("UPDATE specs SET status = 'draft' WHERE id = ?").run(spec.id);
          specNote = `${specKey(spec)} is back in draft. Edit it with update_spec, then approve_spec.`;
          to = 'backlog';
        } else {
          if (attemptsLeft(db, task) === 0) {
            db.prepare('UPDATE tasks SET max_attempts = ? WHERE id = ?').run(attemptsUsed(db, task.id) + 1, task.id);
          }
          to = openBlockers(db, parseIdList(task.blocked_by)).length > 0 ? 'blocked' : releasedStatus(db, task.spec_id);
        }
        setStatus(db, task.id, 'needs_human', to, who);
        const fresh = db.prepare('SELECT id, max_attempts FROM tasks WHERE id = ?').get(task.id) as { id: string; max_attempts: number | null };
        return { status: to, attempts_left: attemptsLeft(db, fresh), ...(specNote ? { note: specNote } : {}) };
      }).immediate();
      return jsonResult(result);
    }),
  );
}
