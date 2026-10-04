import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type Database from 'better-sqlite3';
import { getDb, generateId, resolveProjectOrDefault, resolveProjectError } from '../db/queries.js';
import { ACTOR_FORMAT_HINT, actorLabel, openBlockers, parseActor, parseIdList, setStatus, ToolError, type Actor } from '../domain/lifecycle.js';
import { attemptsLeft, endAttempt } from '../domain/attempts.js';
import {
  assertCanApprove, assertCanAuthor, criteriaOf, criterionKey, parseJsonArray, resolveSpec, specContentHash, specKey,
  type RiskLevel, type SpecRow,
} from '../domain/specs.js';
import { writeSpecFile } from '../domain/spec-file.js';
import { errorResult, guarded, jsonResult } from './results.js';

const RISK = z.enum(['low', 'medium', 'high']);
const VERIFY_KIND = z.enum(['test', 'command', 'review']);
const criterionInput = z.object({
  statement: z.string().min(1).describe('Observable behaviour, worded so it can be tested'),
  verify_kind: VERIFY_KIND.describe('How it is verified'),
  verify_ref: z.string().optional().describe('Test name, command, or review checklist item. Name the test when verify_kind is test'),
});

const SPEC_FIELDS = ['title', 'objective', 'why', 'approach', 'constraints', 'out_of_scope', 'risk_level'] as const;
const RISK_ORDER: RiskLevel[] = ['low', 'medium', 'high'];
const stricter = (a: RiskLevel, b: RiskLevel): RiskLevel => (RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b);

const ON_BEHALF_OF = z.string().optional()
  .describe('When a human explicitly asked you (an agent) to do this: their id, e.g. human:umit. You cannot approve a spec you authored');

function requireActor(raw: string, onBehalfOf?: string): Actor {
  const actor = parseActor(raw, onBehalfOf);
  if (!actor) throw new ToolError('invalid_actor', ACTOR_FORMAT_HINT);
  return actor;
}

function taskKeyRows(db: Database.Database, specId: string) {
  return db.prepare(
    `SELECT t.id AS task_id, p.slug || '-' || t.seq AS key, t.title, t.status, t.max_attempts, t.blocked_by
     FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.spec_id = ? ORDER BY t.seq`,
  ).all(specId) as { task_id: string; key: string; title: string; status: string; max_attempts: number | null; blocked_by: string | null }[];
}

function projectIdFor(project: string | undefined): string | undefined {
  if (!project) return undefined;
  const resolved = resolveProjectOrDefault(project);
  if (!resolved) throw new ToolError('not_found', resolveProjectError(project));
  return resolved.id;
}

// A delegate gets a human's approval rights, but not over its own spec.
function assertNotOwnSpec(actor: Actor, spec: SpecRow): void {
  if (actor.onBehalfOf && spec.created_by === actor.id) {
    throw new ToolError('forbidden', `${actor.id} authored ${specKey(spec)} and cannot approve it on behalf of ${actor.onBehalfOf}.`);
  }
}

// Release a spec's backlog tasks once it is approved: ready when nothing they
// depend on is open, blocked otherwise.
function releaseBacklog(db: Database.Database, spec: SpecRow, actor: Actor): string[] {
  const madeReady: string[] = [];
  for (const t of taskKeyRows(db, spec.id).filter(t => t.status === 'backlog')) {
    const open = openBlockers(db, parseIdList(t.blocked_by));
    setStatus(db, t.task_id, 'backlog', open.length ? 'blocked' : 'ready', actor);
    if (!open.length) madeReady.push(t.key);
  }
  return madeReady;
}

export function registerSpecTools(server: McpServer): void {
  server.registerTool(
    'create_spec',
    {
      title: 'Create Spec',
      description:
        'Define a spec: the objective, why it matters, the chosen approach, constraints and acceptance criteria an executor agent works against. ' +
        'Created as a draft; approve_spec makes its tasks workable. Architect or human only.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID'),
        actor: z.string().describe('human:<name> or agent:architect'),
        title: z.string().min(1),
        objective: z.string().min(1).describe('What outcome, one paragraph'),
        why: z.string().min(1).describe('Problem it solves, why now'),
        approach: z.string().optional().describe('Chosen approach, short'),
        constraints: z.array(z.string()).optional(),
        out_of_scope: z.array(z.string()).optional(),
        risk_level: RISK.describe('low, medium or high. Medium and high need a human to approve and accept'),
        criteria: z.array(criterionInput).min(1).describe('At least one acceptance criterion'),
      },
    },
    async ({ project, actor, title, objective, why, approach, constraints, out_of_scope, risk_level, criteria }) => guarded(() => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) return errorResult('not_found', resolveProjectError(project));
      const who = requireActor(actor);
      assertCanAuthor(who);
      if (!criteria?.length) throw new ToolError('invalid_criteria', 'A spec needs at least one acceptance criterion.');

      const db = getDb();
      const id = generateId();
      const created = db.transaction(() => {
        const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM specs WHERE project_id = ?').get(resolved.id) as { n: number }).n;
        db.prepare(
          `INSERT INTO specs (id, project_id, seq, title, objective, why, approach, constraints, out_of_scope, risk_level, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id, resolved.id, seq, title, objective, why, approach ?? null,
          constraints ? JSON.stringify(constraints) : null,
          out_of_scope ? JSON.stringify(out_of_scope) : null,
          risk_level, who.id,
        );
        const insert = db.prepare('INSERT INTO acceptance_criteria (id, spec_id, seq, statement, verify_kind, verify_ref) VALUES (?, ?, ?, ?, ?, ?)');
        return criteria.map((c, i) => {
          const cid = generateId();
          insert.run(cid, id, i + 1, c.statement, c.verify_kind, c.verify_ref ?? null);
          return { id: cid, key: `AC-${seq}.${i + 1}` };
        });
      }).immediate();
      const spec = resolveSpec(db, id);
      const warnings = criteria
        .map((c, i) => (c.verify_kind === 'test' && !c.verify_ref ? `${created[i].key} is verified by a test but names none in verify_ref.` : null))
        .filter(Boolean);
      return jsonResult({ spec_id: id, key: specKey(spec), status: spec.status, criteria: created, ...(warnings.length ? { warnings } : {}) });
    }),
  );

  server.registerTool(
    'update_spec',
    {
      title: 'Update Spec',
      description:
        'Edit a spec. Pass the version you read as expected_version; a stale version fails with version_conflict. ' +
        'Editing an approved spec republishes it: the version bumps and agents working on its tasks see spec_changed on their next heartbeat.',
      inputSchema: {
        spec_id: z.string().describe('Spec id or key like "SPEC-12"'),
        project: z.string().optional().describe('Project, needed only when a spec key exists in several projects'),
        actor: z.string(),
        on_behalf_of: ON_BEHALF_OF,
        expected_version: z.number().int().describe('The version you last read'),
        title: z.string().min(1).optional(),
        objective: z.string().min(1).optional(),
        why: z.string().min(1).optional(),
        approach: z.string().optional(),
        constraints: z.array(z.string()).optional(),
        out_of_scope: z.array(z.string()).optional(),
        risk_level: RISK.optional(),
        criteria_upsert: z.array(criterionInput.extend({
          seq: z.number().int().optional().describe('Existing criterion number to replace; omit to add a new one'),
        })).optional(),
        criteria_remove: z.array(z.number().int()).optional().describe('Criterion numbers (seq) to remove'),
      },
    },
    async ({ spec_id, project, actor, on_behalf_of, expected_version, criteria_upsert, criteria_remove, ...fields }) => guarded(() => {
      const db = getDb();
      const who = requireActor(actor, on_behalf_of);
      const spec = resolveSpec(db, spec_id, projectIdFor(project));
      if (spec.status === 'approved') assertNotOwnSpec(who, spec);
      if (spec.status === 'superseded' || spec.status === 'cancelled') {
        throw new ToolError('invalid_state', `${specKey(spec)} is ${spec.status} and can no longer be edited.`);
      }
      if (spec.status === 'approved') assertCanApprove(who, stricter(spec.risk_level, fields.risk_level ?? spec.risk_level));
      else assertCanAuthor(who);

      const result = db.transaction(() => {
        const current = resolveSpec(db, spec.id);
        if (current.version !== expected_version) {
          throw new ToolError('version_conflict', `${specKey(spec)} is at version ${current.version}, not ${expected_version}. Re-read it with get_spec.`);
        }
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const k of SPEC_FIELDS) {
          const v = fields[k];
          if (v === undefined) continue;
          sets.push(`${k} = ?`);
          params.push(Array.isArray(v) ? JSON.stringify(v) : v);
        }
        if (sets.length) db.prepare(`UPDATE specs SET ${sets.join(', ')} WHERE id = ?`).run(...params, spec.id);

        for (const seq of criteria_remove ?? []) {
          const c = db.prepare('SELECT id FROM acceptance_criteria WHERE spec_id = ? AND seq = ?').get(spec.id, seq) as { id: string } | undefined;
          if (!c) throw new ToolError('invalid_criteria', `${specKey(spec)} has no criterion ${seq}.`);
          db.prepare('DELETE FROM task_criteria WHERE criterion_id = ?').run(c.id);
          db.prepare('DELETE FROM acceptance_criteria WHERE id = ?').run(c.id);
        }
        const added: { id: string; key: string }[] = [];
        for (const c of criteria_upsert ?? []) {
          if (c.seq !== undefined) {
            const r = db.prepare('UPDATE acceptance_criteria SET statement = ?, verify_kind = ?, verify_ref = ? WHERE spec_id = ? AND seq = ?')
              .run(c.statement, c.verify_kind, c.verify_ref ?? null, spec.id, c.seq);
            if (r.changes === 0) throw new ToolError('invalid_criteria', `${specKey(spec)} has no criterion ${c.seq}.`);
          } else {
            const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM acceptance_criteria WHERE spec_id = ?').get(spec.id) as { n: number }).n;
            const id = generateId();
            db.prepare('INSERT INTO acceptance_criteria (id, spec_id, seq, statement, verify_kind, verify_ref) VALUES (?, ?, ?, ?, ?, ?)')
              .run(id, spec.id, seq, c.statement, c.verify_kind, c.verify_ref ?? null);
            added.push({ id, key: `AC-${spec.seq}.${seq}` });
          }
        }
        const criteria = criteriaOf(db, spec.id);
        if (criteria.length === 0) throw new ToolError('invalid_criteria', 'A spec needs at least one acceptance criterion.');

        // An approved spec is republished on every content change, so it
        // bumps here. Draft edits bump at approval instead (approve_spec).
        const updated = resolveSpec(db, spec.id);
        const hash = specContentHash(updated, criteria);
        let bumped = false;
        if (updated.status === 'approved' && hash !== updated.approved_hash) {
          db.prepare('UPDATE specs SET version = version + 1, approved_hash = ? WHERE id = ?').run(hash, spec.id);
          bumped = true;
        }
        return { bumped, added };
      }).immediate();

      const fileWrite = result.bumped ? writeSpecFile(db, spec.id) : null;
      const after = resolveSpec(db, spec.id);
      const affected = taskKeyRows(db, spec.id)
        .filter(t => t.status !== 'done' && t.status !== 'cancelled')
        .map(t => ({ task_id: t.task_id, key: t.key, status: t.status }));
      return jsonResult({
        spec_id: spec.id,
        key: specKey(after),
        status: after.status,
        version: after.version,
        affected_tasks: affected,
        ...(result.added.length ? {
          criteria_added: result.added,
          note: 'New criteria are not linked to any task. Link them with update_task (criteria).',
        } : {}),
        ...(fileWrite?.warning ? { warning: fileWrite.warning } : {}),
      });
    }),
  );

  server.registerTool(
    'approve_spec',
    {
      title: 'Approve Spec',
      description:
        'Approve a draft spec so agents can work on its tasks. Medium and high risk need human:*; low risk also allows agent:architect. ' +
        'Moves linked backlog tasks with no open blockers to ready and writes specs/SPEC-<n>.md into the repo (a human commits it).',
      inputSchema: {
        spec_id: z.string(),
        project: z.string().optional(),
        actor: z.string(),
        on_behalf_of: ON_BEHALF_OF,
      },
    },
    async ({ spec_id, project, actor, on_behalf_of }) => guarded(() => {
      const db = getDb();
      const who = requireActor(actor, on_behalf_of);
      const spec = resolveSpec(db, spec_id, projectIdFor(project));
      if (spec.status !== 'draft') throw new ToolError('invalid_state', `${specKey(spec)} is ${spec.status}; only drafts can be approved.`);
      assertCanApprove(who, spec.risk_level);
      assertNotOwnSpec(who, spec);

      const tasksMadeReady = db.transaction(() => {
        const current = resolveSpec(db, spec.id);
        if (current.status !== 'draft') throw new ToolError('invalid_state', `${specKey(spec)} is ${current.status}; only drafts can be approved.`);
        const hash = specContentHash(current, criteriaOf(db, spec.id));
        // Content changed since the last approval (a revision): publish it
        // under a new version so attempts and heartbeats can tell.
        const bump = current.approved_hash !== null && current.approved_hash !== hash ? 1 : 0;
        db.prepare(
          `UPDATE specs SET status = 'approved', version = version + ?, approved_hash = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        ).run(bump, hash, actorLabel(who), spec.id);
        return releaseBacklog(db, resolveSpec(db, spec.id), who);
      }).immediate();

      // After commit: a file error must never roll back the approval.
      const file = writeSpecFile(db, spec.id);
      const after = resolveSpec(db, spec.id);
      return jsonResult({
        spec_id: spec.id,
        key: specKey(after),
        status: 'approved',
        version: after.version,
        tasks_made_ready: tasksMadeReady,
        ...(file.path ? { spec_file: file.path } : {}),
        ...(file.warning ? { warning: file.warning } : {}),
      });
    }),
  );

  server.registerTool(
    'supersede_spec',
    {
      title: 'Supersede Spec',
      description: 'Replace a spec with another one. Cancels the old spec\'s unfinished tasks; any live claim on them ends.',
      inputSchema: {
        spec_id: z.string(),
        replacement_spec_id: z.string(),
        project: z.string().optional(),
        actor: z.string(),
        on_behalf_of: ON_BEHALF_OF,
        reason: z.string().min(1),
      },
    },
    async ({ spec_id, replacement_spec_id, project, actor, on_behalf_of, reason }) => guarded(() => {
      const db = getDb();
      const who = requireActor(actor, on_behalf_of);
      const projectId = projectIdFor(project);
      const spec = resolveSpec(db, spec_id, projectId);
      const replacement = resolveSpec(db, replacement_spec_id, projectId ?? spec.project_id);
      if (spec.status === 'superseded' || spec.status === 'cancelled') {
        throw new ToolError('invalid_state', `${specKey(spec)} is already ${spec.status}.`);
      }
      if (replacement.id === spec.id || replacement.project_id !== spec.project_id) {
        throw new ToolError('invalid_spec', 'The replacement must be a different spec in the same project.');
      }
      if (replacement.status === 'superseded' || replacement.status === 'cancelled') {
        throw new ToolError('invalid_spec', `${specKey(replacement)} is ${replacement.status}.`);
      }
      assertCanApprove(who, spec.risk_level);

      const cancelled = db.transaction(() => {
        db.prepare("UPDATE specs SET status = 'superseded', superseded_by = ? WHERE id = ?").run(replacement.id, spec.id);
        const keys: string[] = [];
        for (const t of taskKeyRows(db, spec.id).filter(t => t.status !== 'done' && t.status !== 'cancelled')) {
          let attemptId: string | null = null;
          if (t.status === 'claimed') {
            const a = db.prepare(`SELECT a.id FROM attempts a JOIN tasks t ON t.claim_token = a.claim_token WHERE t.id = ? AND a.outcome = 'active'`)
              .get(t.task_id) as { id: string } | undefined;
            if (a) {
              endAttempt(db, a.id, 'abandoned', { notes: `Spec superseded by ${specKey(replacement)}: ${reason}`.slice(0, 1500) });
              attemptId = a.id;
            }
          }
          setStatus(db, t.task_id, t.status, 'cancelled', who, attemptId);
          keys.push(t.key);
        }
        return keys;
      }).immediate();
      return jsonResult({ spec_id: spec.id, key: specKey(spec), status: 'superseded', superseded_by: specKey(replacement), cancelled_tasks: cancelled });
    }),
  );

  server.registerTool(
    'get_spec',
    {
      title: 'Get Spec',
      description: 'A spec with its acceptance criteria, linked tasks (status and attempts) and the active decisions that shaped it.',
      inputSchema: {
        spec_id: z.string(),
        project: z.string().optional(),
      },
    },
    async ({ spec_id, project }) => guarded(() => {
      const db = getDb();
      const spec = resolveSpec(db, spec_id, projectIdFor(project));
      const criteria = criteriaOf(db, spec.id).map(c => ({
        id: c.id, key: criterionKey(spec, c), statement: c.statement, verify_kind: c.verify_kind, verify_ref: c.verify_ref,
      }));
      const tasks = taskKeyRows(db, spec.id).map(t => ({
        task_id: t.task_id,
        key: t.key,
        title: t.title,
        status: t.status,
        attempts: (db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?').get(t.task_id) as { n: number }).n,
        attempts_left: attemptsLeft(db, { id: t.task_id, max_attempts: t.max_attempts }),
      }));
      const decisions = db.prepare(
        "SELECT id, title, decision, reasoning, created_at FROM decisions WHERE spec_id = ? AND status = 'active' ORDER BY created_at",
      ).all(spec.id);
      const { approved_hash: _hash, constraints, out_of_scope, ...rest } = spec;
      return jsonResult({
        ...rest,
        key: specKey(spec),
        constraints: parseJsonArray(constraints),
        out_of_scope: parseJsonArray(out_of_scope),
        superseded_by: spec.superseded_by ? specKey(resolveSpec(db, spec.superseded_by)) : null,
        criteria,
        tasks,
        decisions,
      });
    }),
  );
}
