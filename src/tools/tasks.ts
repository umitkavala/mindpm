import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type Database from 'better-sqlite3';
import { getDb, generateId, resolveProjectOrDefault, resolveProjectError, recordTaskHistory, resolveTaskId } from '../db/queries.js';
import { maybeAutoSession } from './auto-session.js';
import {
  LEGACY_STATUS_ALIASES, TASK_STATUSES, openBlockers, parseActor, parseIdList, setStatus, ToolError,
  ACTOR_FORMAT_HINT, type TaskStatus,
} from '../domain/lifecycle.js';
import { changeStatusAsHuman, normalizeStatus } from '../domain/status-change.js';
import { criteriaOf, criterionKey, resolveCriteria, resolveSpec, specKey } from '../domain/specs.js';
import { attemptsLeft, expireLeases } from '../domain/attempts.js';
import { errorResult, guarded, publicTask } from './results.js';

const STATUS_INPUT = z.enum([...TASK_STATUSES, ...Object.keys(LEGACY_STATUS_ALIASES)] as [string, ...string[]]);
const verificationSchema = z.record(z.string(), z.string())
  .describe('Verification commands keyed by kind (build, unit, integration, lint). Overrides project defaults per key');

// Blocker refs may be hex ids or short ids. Unresolvable refs are kept as
// given; they count as open blockers until a human clears them.
function resolveBlockerRefs(refs: string[]): string[] {
  return [...new Set(refs.map(r => resolveTaskId(r) ?? r))];
}

function taskKey(db: Database.Database, taskId: string): string | null {
  const row = db.prepare("SELECT p.slug || '-' || t.seq AS key FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.id = ?").get(taskId) as { key: string | null } | undefined;
  return row?.key ?? null;
}

export function registerTaskTools(server: McpServer): void {
  server.registerTool(
    'create_task',
    {
      title: 'Create Task',
      description:
        'Create a new task in a project. Proactively use this when the user mentions something that needs to be done, a bug to fix, or a feature to build. ' +
        'Link it to a spec (spec_id) to make it executable by an agent: it then starts in backlog until the spec is approved.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID (defaults to most recent active project)'),
        title: z.string().describe('Short task title'),
        description: z.string().optional().describe('Detailed description of the task'),
        priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Task priority (default: medium)'),
        tags: z.array(z.string()).optional().describe('Tags like "backend", "auth", "bug"'),
        parent_task_id: z.string().optional().describe('Parent task ID for sub-tasks'),
        blocked_by: z.array(z.string()).optional().describe('Task IDs that must be done before this one can start'),
        spec_id: z.string().optional().describe('Spec this task implements (spec id or key like "SPEC-12")'),
        criteria: z.array(z.string()).optional().describe('Acceptance criteria this task is responsible for (ids or keys like "AC-12.1"). Defaults to all criteria of the spec'),
        verification: verificationSchema.optional(),
        branch: z.string().optional().describe('Expected branch, e.g. feature/T-142-timeout'),
        actor: z.string().optional().describe('Who is creating the task, e.g. human:umit or agent:architect'),
      },
    },
    async ({ project, title, description, priority, tags, parent_task_id, blocked_by, spec_id, criteria, verification, branch, actor }) => guarded(() => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: resolveProjectError(project) }], isError: true };
      }
      if (actor !== undefined && !parseActor(actor)) return errorResult('invalid_actor', ACTOR_FORMAT_HINT);

      const db = getDb();
      const spec = spec_id ? resolveSpec(db, spec_id, resolved.id) : null;
      if (spec && spec.project_id !== resolved.id) {
        throw new ToolError('invalid_spec', `${specKey(spec)} belongs to a different project.`);
      }
      if (spec && (spec.status === 'superseded' || spec.status === 'cancelled')) {
        throw new ToolError('invalid_spec', `${specKey(spec)} is ${spec.status}; link the task to its replacement.`);
      }
      if (!spec && criteria?.length) throw new ToolError('invalid_criteria', 'criteria require a spec_id.');
      const linked = spec ? (criteria ? resolveCriteria(db, spec, criteria) : criteriaOf(db, spec.id)) : [];

      const blockers = blocked_by ? resolveBlockerRefs(blocked_by) : [];
      let status: TaskStatus;
      if (spec && spec.status !== 'approved') status = 'backlog';
      else status = openBlockers(db, blockers).length > 0 ? 'blocked' : 'ready';

      const id = generateId();
      db.transaction(() => {
        const seqRow = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM tasks WHERE project_id = ?').get(resolved.id) as { next_seq: number };
        db.prepare(
          `INSERT INTO tasks (id, project_id, seq, title, description, status, priority, tags, parent_task_id, blocked_by, spec_id, verification, branch)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          resolved.id,
          seqRow.next_seq,
          title,
          description ?? null,
          status,
          priority ?? 'medium',
          tags ? JSON.stringify(tags) : null,
          parent_task_id ?? null,
          blockers.length ? JSON.stringify(blockers) : null,
          spec?.id ?? null,
          verification ? JSON.stringify(verification) : null,
          branch ?? null,
        );
        const link = db.prepare('INSERT INTO task_criteria (task_id, criterion_id) VALUES (?, ?)');
        for (const c of linked) link.run(id, c.id);
        recordTaskHistory(id, 'created', null, JSON.stringify({ status, priority: priority ?? 'medium' }), actor ?? null);
      })();

      const short_id = taskKey(db, id);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            task_id: id,
            short_id,
            key: short_id,
            status,
            ...(spec ? { spec_key: specKey(spec), criteria: linked.map(c => criterionKey(spec, c)) } : {}),
            message: `Task created: "${title}" in ${resolved.name} (priority: ${priority ?? 'medium'}, status: ${status})`,
          }),
        }],
      };
    }),
  );

  server.registerTool(
    'update_task',
    {
      title: 'Update Task',
      description:
        'Update fields of a task. Proactively use this when priorities shift or new information comes in. ' +
        'Changing status directly is reserved for humans (actor human:*); agents move tasks with claim_task, submit_task, report_failure, escalate and release_task.',
      inputSchema: {
        task_id: z.string().describe('Task ID to update (hex ID or short ID like "zrdt-180")'),
        title: z.string().optional().describe('New title'),
        description: z.string().optional().describe('New description'),
        status: STATUS_INPUT.optional().describe(`New status (${TASK_STATUSES.join(', ')}). Requires a human actor`),
        priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('New priority'),
        tags: z.array(z.string()).optional().describe('New tags (replaces existing)'),
        blocked_by: z.array(z.string()).optional().describe('Task IDs that block this task (replaces existing list)'),
        addBlockedBy: z.array(z.string()).optional().describe('Task IDs that block this task (appended to existing list)'),
        verification: verificationSchema.optional(),
        branch: z.string().optional().describe('Expected branch'),
        actor: z.string().optional().describe('Who is making the change, e.g. human:umit. Required for status changes'),
      },
    },
    async ({ task_id, title, description, status, priority, tags, blocked_by, addBlockedBy, verification, branch, actor }) => guarded(() => {
      const db = getDb();
      const resolvedId = resolveTaskId(task_id);
      if (!resolvedId) {
        return { content: [{ type: 'text' as const, text: `Task "${task_id}" not found.` }], isError: true };
      }
      const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(resolvedId) as Record<string, any> | undefined;
      if (!existing) {
        return { content: [{ type: 'text' as const, text: `Task "${task_id}" not found.` }], isError: true };
      }
      if (actor !== undefined && !parseActor(actor)) return errorResult('invalid_actor', ACTOR_FORMAT_HINT);
      // Validate the status change up front so a rejected change writes nothing.
      if (status !== undefined) normalizeStatus(status);

      const updates: string[] = [];
      const params: any[] = [];

      if (title !== undefined) { updates.push('title = ?'); params.push(title); }
      if (description !== undefined) { updates.push('description = ?'); params.push(description); }
      if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }
      if (tags !== undefined) { updates.push('tags = ?'); params.push(JSON.stringify(tags)); }
      if (verification !== undefined) { updates.push('verification = ?'); params.push(JSON.stringify(verification)); }
      if (branch !== undefined) { updates.push('branch = ?'); params.push(branch); }
      let newBlockers: string[] | null = null;
      if (blocked_by !== undefined) newBlockers = resolveBlockerRefs(blocked_by);
      if (addBlockedBy !== undefined && addBlockedBy.length > 0) {
        newBlockers = [...new Set([...(newBlockers ?? parseIdList(existing.blocked_by)), ...resolveBlockerRefs(addBlockedBy)])];
      }
      if (newBlockers !== null) { updates.push('blocked_by = ?'); params.push(JSON.stringify(newBlockers)); }

      if (updates.length === 0 && status === undefined) {
        return { content: [{ type: 'text' as const, text: 'No updates provided.' }], isError: true };
      }

      let warning: string | null = null;
      db.transaction(() => {
        if (updates.length > 0) {
          db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params, resolvedId);
        }
        if (status !== undefined) {
          warning = changeStatusAsHuman(db, resolvedId, status, actor);
        } else if (newBlockers && openBlockers(db, newBlockers).length > 0 && ['ready', 'backlog'].includes(existing.status)) {
          // Naming an open blocker on work nobody has started blocks it.
          setStatus(db, resolvedId, existing.status, 'blocked', actor ?? 'system');
        }
      })();

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ task_id: resolvedId, message: `Task "${existing.title}" updated.`, ...(warning ? { warning } : {}) }),
        }],
      };
    }),
  );

  server.registerTool(
    'list_tasks',
    {
      title: 'List Tasks',
      description:
        'List tasks with filters. Defaults to showing non-completed tasks for the most recent active project.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID'),
        status: STATUS_INPUT.optional().describe('Filter by status'),
        priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Filter by priority'),
        tag: z.string().optional().describe('Filter by tag'),
        include_done: z.boolean().optional().describe('Include completed tasks (default: false)'),
        limit: z.number().int().min(1).max(200).optional().describe('Max tasks to return (default: 50)'),
        offset: z.number().int().min(0).optional().describe('Number of tasks to skip for pagination (default: 0)'),
      },
    },
    async ({ project, status, priority, tag, include_done, limit = 50, offset = 0 }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: resolveProjectError(project) }], isError: true };
      }

      const db = getDb();
      expireLeases(db);
      const conditions: string[] = ['t.project_id = @projectId'];
      const params: Record<string, any> = { projectId: resolved.id };

      if (status) {
        conditions.push('t.status = @status');
        params.status = LEGACY_STATUS_ALIASES[status] ?? status;
      } else if (!include_done) {
        conditions.push("t.status NOT IN ('done', 'cancelled')");
      }

      if (priority) {
        conditions.push('t.priority = @priority');
        params.priority = priority;
      }

      if (tag) {
        conditions.push("t.tags LIKE '%' || @tag || '%'");
        params.tag = `"${tag}"`;
      }

      const whereClause = conditions.join(' AND ');
      const orderClause = `ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, t.created_at DESC`;
      const total = (db.prepare(`SELECT COUNT(*) as n FROM tasks t WHERE ${whereClause}`).get(params) as { n: number }).n;
      const sql = `SELECT t.id, t.seq, t.title, t.status, t.priority, t.tags, t.parent_task_id, t.blocked_by, t.spec_id, t.claimed_by, t.created_at, p.slug || '-' || t.seq AS short_id FROM tasks t JOIN projects p ON t.project_id = p.id WHERE ${whereClause} ${orderClause} LIMIT ${limit} OFFSET ${offset}`;
      const rows = db.prepare(sql).all(params);

      const tasks = rows.map(row => Object.fromEntries(Object.entries(row as Record<string, unknown>).filter(([, v]) => v != null)));
      const hasMore = offset + tasks.length < total;
      const header = hasMore ? `Showing ${offset + 1}–${offset + tasks.length} of ${total} tasks. Use limit/offset or filters to paginate.\n` : '';
      const resultText = header + JSON.stringify({ project: resolved.name, total, limit, offset, tasks });
      return {
        content: [{ type: 'text' as const, text: resultText }],
      };
    },
  );

  server.registerTool(
    'get_task',
    {
      title: 'Get Task',
      description: 'Get full detail for a specific task including sub-tasks, related notes, its spec criteria and its attempts.',
      inputSchema: {
        task_id: z.string().describe('Task ID (hex ID or short ID like "zrdt-180")'),
      },
    },
    async ({ task_id }) => {
      const db = getDb();
      expireLeases(db);
      const resolvedId = resolveTaskId(task_id);
      if (!resolvedId) {
        return { content: [{ type: 'text' as const, text: `Task "${task_id}" not found.` }], isError: true };
      }
      const task = db.prepare('SELECT t.*, p.slug || \'-\' || t.seq AS short_id FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.id = ?').get(resolvedId) as Record<string, any> | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Task "${task_id}" not found.` }], isError: true };
      }

      const sessionPreamble = maybeAutoSession(task.project_id);
      const subtasks = (db.prepare('SELECT t.*, p.slug || \'-\' || t.seq AS short_id FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.parent_task_id = ?').all(resolvedId) as Record<string, unknown>[]).map(publicTask);
      const notes = db.prepare('SELECT * FROM notes WHERE task_id = ? ORDER BY created_at DESC').all(resolvedId);

      const spec = task.spec_id ? resolveSpec(db, task.spec_id) : null;
      const criteria = spec
        ? (db.prepare('SELECT c.* FROM acceptance_criteria c JOIN task_criteria tc ON tc.criterion_id = c.id WHERE tc.task_id = ? ORDER BY c.seq').all(resolvedId) as { id: string; seq: number; statement: string }[])
            .map(c => ({ id: c.id, key: criterionKey(spec, c), statement: c.statement }))
        : [];
      const attempts = db.prepare(
        `SELECT attempt_no, actor, outcome, failure_type, root_cause, notes, escalation, review_decision, review_findings, branch, head_sha, started_at, ended_at
         FROM attempts WHERE task_id = ? ORDER BY attempt_no`,
      ).all(resolvedId);

      const resultText = JSON.stringify({
        task: publicTask(task),
        ...(spec ? { spec: { key: specKey(spec), title: spec.title, status: spec.status, version: spec.version, risk_level: spec.risk_level }, criteria } : {}),
        attempts,
        attempts_left: attemptsLeft(db, task as { id: string; max_attempts: number | null }),
        subtasks,
        notes,
      }, null, 2);
      return {
        content: [{ type: 'text' as const, text: sessionPreamble ? `${sessionPreamble}\n\n---\n\n${resultText}` : resultText }],
      };
    },
  );

  server.registerTool(
    'get_next_tasks',
    {
      title: 'Get Next Tasks',
      description:
        'Planning view: what should be worked on next? Returns the highest priority ready or claimed tasks for a project. Executor agents use pick_task instead.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID'),
        limit: z.number().optional().describe('Max number of tasks to return (default: 5)'),
      },
    },
    async ({ project, limit }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: resolveProjectError(project) }], isError: true };
      }

      const sessionPreamble = maybeAutoSession(resolved.id);
      const db = getDb();
      expireLeases(db);
      const rows = (db
        .prepare(
          `SELECT t.*, p.slug || '-' || t.seq AS short_id FROM tasks t JOIN projects p ON t.project_id = p.id
           WHERE t.project_id = ? AND t.status IN ('ready', 'claimed')
           ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
                    t.created_at ASC
           LIMIT ?`
        )
        .all(resolved.id, limit ?? 5) as Record<string, unknown>[]).map(publicTask);

      const resultText = JSON.stringify({ project: resolved.name, next_tasks: rows }, null, 2);
      return {
        content: [{
          type: 'text' as const,
          text: sessionPreamble ? `${sessionPreamble}\n\n---\n\n${resultText}` : resultText,
        }],
      };
    },
  );
}
