import { IncomingMessage, ServerResponse } from 'node:http';
import { getDb, generateId, resolveProjectOrDefault, resolveProjectId, recordTaskHistory, resolveTaskId } from '../db/queries.js';
import { generateSlug } from '../utils/ids.js';
import { computeDeliveryMetrics } from '../db/metrics.js';
import { matchRoute, parseBody, sendJson } from './http.js';
import { openBlockers, setStatus, ToolError, UI_ACTOR } from '../domain/lifecycle.js';
import { changeStatusAsHuman } from '../domain/status-change.js';
import { expireLeases } from '../domain/attempts.js';
import { publicTask } from '../tools/results.js';
import { resolveNeedsHuman, type Resolution } from '../domain/needs-human.js';
import {
  acceptTasks, expireRuns, listVerifiers, registerVerifier, reopenTask, revokeVerifier, runsForTask, setVerificationMode, setVerifierConfig,
  verificationMode, verificationSetup, verifierConfig, type VerifierKind,
} from '../domain/verification.js';

// Anything reaching the HTTP port is the local Kanban UI and counts as a
// human (UI_ACTOR, channel 'ui'). Same trust model as declared actor ids:
// local only.

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void>;

interface Route {
  method: string;
  pattern: string;
  handler: RouteHandler;
}

// Parse a query-param integer, clamping to [min, max]; returns fallback when absent/invalid.
function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// --- Project handlers ---

const listProjects: RouteHandler = async (_req, res) => {
  const db = getDb();
  const url = new URL(_req.url || '/', 'http://localhost');
  const status = url.searchParams.get('status');

  const sql = `
    SELECT p.*,
      (SELECT COUNT(*) FROM tasks WHERE project_id = p.id AND status NOT IN ('done','cancelled')) AS active_task_count,
      (SELECT COUNT(*) FROM tasks WHERE project_id = p.id AND status = 'done') AS done_task_count
    FROM projects p
    ${status ? 'WHERE p.status = ?' : ''}
    ORDER BY p.updated_at DESC
  `;
  const rows = status
    ? db.prepare(sql).all(status)
    : db.prepare(sql).all();
  sendJson(res, 200, rows);
};

const getProject: RouteHandler = async (_req, res, params) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(params.id) as Record<string, unknown> | undefined;
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return;
  }

  const taskCounts = db
    .prepare('SELECT status, COUNT(*) as count FROM tasks WHERE project_id = ? GROUP BY status')
    .all(params.id);

  sendJson(res, 200, { ...project, task_counts: taskCounts });
};

const updateProject: RouteHandler = async (req, res, params) => {
  const db = getDb();
  const body = await parseBody(req);

  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(params.id) as Record<string, unknown> | undefined;
  if (!existing) {
    sendJson(res, 404, { error: 'Project not found' });
    return;
  }

  const updates: string[] = [];
  const sqlParams: unknown[] = [];

  if (body.name !== undefined) {
    updates.push('name = ?');
    sqlParams.push(body.name);
  }
  if (body.description !== undefined) {
    updates.push('description = ?');
    sqlParams.push(body.description);
  }
  if (body.status !== undefined) {
    updates.push('status = ?');
    sqlParams.push(body.status);
  }

  if (updates.length === 0) {
    sendJson(res, 400, { error: 'No updates provided' });
    return;
  }

  sqlParams.push(params.id);
  try {
    db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...sqlParams);
  } catch (e: any) {
    if (e.message?.includes('UNIQUE constraint failed')) {
      sendJson(res, 409, { error: 'A project with that name already exists' });
      return;
    }
    throw e;
  }

  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(params.id);
  sendJson(res, 200, updated);
};

// --- Task handlers ---

// What a board card shows besides the task row: spec and risk, the attempt in
// play, the verifier running on it, and a needs_human task's question.
const CARD_COLUMNS = `p.slug || '-' || t.seq AS short_id,
  CASE WHEN s.id IS NULL THEN NULL ELSE 'SPEC-' || s.seq END AS spec_key,
  COALESCE(s.risk_level, 'medium') AS risk_level,
  (SELECT MAX(attempt_no) FROM attempts a WHERE a.task_id = t.id) AS attempt_no,
  (SELECT 'verifier:' || v.name FROM verification_runs r JOIN verifiers v ON v.id = r.verifier_id
     WHERE r.task_id = t.id AND r.status = 'running') AS running_verifier,
  CASE WHEN t.status = 'needs_human' THEN
    (SELECT a.escalation FROM attempts a WHERE a.task_id = t.id ORDER BY a.attempt_no DESC LIMIT 1) END AS escalation`;

const listTasks: RouteHandler = async (req, res, params) => {
  const db = getDb();
  const url = new URL(req.url || '/', 'http://localhost');
  const includeDone = url.searchParams.get('include_done') === 'true';
  const status = url.searchParams.get('status');
  const hasLimit = url.searchParams.has('limit');
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

  expireLeases(db);
  expireRuns(db);
  const conditions = ['t.project_id = ?'];
  const sqlParams: unknown[] = [params.pid];
  if (status) {
    conditions.push('t.status = ?');
    sqlParams.push(status);
  } else if (!includeDone) {
    conditions.push("t.status NOT IN ('done', 'cancelled')");
  }
  const where = conditions.join(' AND ');

  // Terminal columns (done/cancelled) are an archive — order by recency.
  const order = status === 'done' || status === 'cancelled'
    ? 'ORDER BY COALESCE(t.completed_at, t.updated_at) DESC'
    : "ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, t.created_at DESC";

  let sql = `SELECT t.*, ${CARD_COLUMNS} FROM tasks t JOIN projects p ON t.project_id = p.id LEFT JOIN specs s ON s.id = t.spec_id WHERE ${where} ${order}`;
  // Paginate only when the caller asks (limit/offset) or when terminal tasks are
  // requested without an explicit limit — never dump the full done archive.
  if (hasLimit || status === 'done' || status === 'cancelled') {
    sql += ` LIMIT ${limit} OFFSET ${offset}`;
  }

  const rows = (db.prepare(sql).all(...sqlParams) as Record<string, unknown>[]).map(publicTask);
  sendJson(res, 200, rows);
};

const createTask: RouteHandler = async (req, res, params) => {
  const db = getDb();
  const body = await parseBody(req);

  if (!body.title || typeof body.title !== 'string') {
    sendJson(res, 400, { error: 'title is required' });
    return;
  }

  // Verify project exists
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(params.pid);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return;
  }

  const id = generateId();
  const priority = (body.priority as string) || 'medium';
  const tags = Array.isArray(body.tags) ? JSON.stringify(body.tags) : null;
  const seqRow = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM tasks WHERE project_id = ?').get(params.pid) as { next_seq: number };
  const seq = seqRow.next_seq;

  db.prepare(
    'INSERT INTO tasks (id, project_id, seq, title, description, priority, tags, parent_task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    params.pid,
    seq,
    body.title,
    (body.description as string) ?? null,
    priority,
    tags,
    (body.parent_task_id as string) ?? null,
  );

  const task = db.prepare('SELECT t.*, p.slug || \'-\' || t.seq AS short_id FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.id = ?').get(id);
  recordTaskHistory(id, 'created', null, JSON.stringify({ status: 'ready', priority }), UI_ACTOR.id);
  sendJson(res, 201, publicTask(task as Record<string, unknown>));
};

const updateTask: RouteHandler = async (req, res, params) => {
  const db = getDb();
  const body = await parseBody(req);

  const resolvedId = resolveTaskId(params.id as string);
  if (!resolvedId) {
    sendJson(res, 404, { error: 'Task not found' });
    return;
  }
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(resolvedId) as Record<string, unknown> | undefined;
  if (!existing) {
    sendJson(res, 404, { error: 'Task not found' });
    return;
  }

  const updates: string[] = [];
  const sqlParams: unknown[] = [];

  if (body.title !== undefined) { updates.push('title = ?'); sqlParams.push(body.title); }
  if (body.description !== undefined) { updates.push('description = ?'); sqlParams.push(body.description); }
  if (body.priority !== undefined) { updates.push('priority = ?'); sqlParams.push(body.priority); }
  if (body.tags !== undefined) {
    updates.push('tags = ?');
    sqlParams.push(Array.isArray(body.tags) ? JSON.stringify(body.tags) : null);
  }
  if (body.blocked_by !== undefined) {
    updates.push('blocked_by = ?');
    sqlParams.push(Array.isArray(body.blocked_by) ? JSON.stringify(body.blocked_by) : null);
  }

  if (updates.length === 0 && body.status === undefined) {
    sendJson(res, 400, { error: 'No updates provided' });
    return;
  }

  try {
    db.transaction(() => {
      if (updates.length > 0) {
        db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...sqlParams, resolvedId);
      }
      if (body.status !== undefined) {
        changeStatusAsHuman(db, resolvedId, String(body.status), UI_ACTOR);
      } else if (Array.isArray(body.blocked_by) && ['ready', 'backlog'].includes(existing.status as string)
        && openBlockers(db, body.blocked_by as string[]).length > 0) {
        setStatus(db, resolvedId, existing.status as string, 'blocked', UI_ACTOR);
      }
      // Record history for meaningful field changes
      if (body.priority !== undefined && body.priority !== existing.priority) {
        recordTaskHistory(resolvedId, 'priority_changed', existing.priority as string, body.priority as string, UI_ACTOR.id);
      }
      if (body.title !== undefined && body.title !== existing.title) {
        recordTaskHistory(resolvedId, 'title_changed', existing.title as string, body.title as string, UI_ACTOR.id);
      }
    }).immediate();
  } catch (e) {
    if (e instanceof ToolError) {
      sendJson(res, e.code === 'not_found' ? 404 : 409, { error: e.message, code: e.code });
      return;
    }
    throw e;
  }

  const updated = db.prepare('SELECT t.*, p.slug || \'-\' || t.seq AS short_id FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.id = ?').get(resolvedId);
  sendJson(res, 200, publicTask(updated as Record<string, unknown>));
};

const deleteTask: RouteHandler = async (_req, res, params) => {
  const db = getDb();

  const resolvedId = resolveTaskId(params.id as string);
  if (!resolvedId) {
    sendJson(res, 404, { error: 'Task not found' });
    return;
  }

  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(resolvedId);
  if (!existing) {
    sendJson(res, 404, { error: 'Task not found' });
    return;
  }

  // History rows reference attempts, so they go first.
  const deleteRows = (taskId: string) => {
    db.prepare('DELETE FROM task_history WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM notes WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM task_criteria WHERE task_id = ?').run(taskId);
    const runs = 'SELECT id FROM verification_runs WHERE task_id = ?';
    db.prepare(`DELETE FROM check_results WHERE run_id IN (${runs})`).run(taskId);
    db.prepare(`DELETE FROM criterion_results WHERE run_id IN (${runs})`).run(taskId);
    db.prepare('UPDATE tasks SET verified_run_id = NULL WHERE id = ?').run(taskId);
    db.prepare('DELETE FROM verification_runs WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM attempts WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  };
  const deleteTransaction = db.transaction((taskId: string) => {
    const subtasks = db.prepare('SELECT id FROM tasks WHERE parent_task_id = ?').all(taskId) as { id: string }[];
    for (const sub of subtasks) deleteRows(sub.id);
    deleteRows(taskId);
  });

  deleteTransaction.immediate(resolvedId);
  sendJson(res, 200, { message: 'Task deleted' });
};

// --- Task history handler ---

const getTaskHistory: RouteHandler = async (_req, res, params) => {
  const db = getDb();
  const resolvedId = resolveTaskId(params.id as string);
  if (!resolvedId) {
    sendJson(res, 200, []);
    return;
  }
  const rows = db.prepare(
    'SELECT * FROM task_history WHERE task_id = ? ORDER BY created_at ASC'
  ).all(resolvedId);
  sendJson(res, 200, rows);
};

// --- Metrics handler ---

const getMetrics: RouteHandler = async (req, res, params) => {
  const db = getDb();
  const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(params.pid) as { id: string; name: string } | undefined;
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return;
  }
  const url = new URL(req.url || '/', 'http://localhost');
  const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10)));
  const metrics = computeDeliveryMetrics(db, project.id, project.name, days);
  sendJson(res, 200, metrics);
};

// --- Session handlers ---

const createSession: RouteHandler = async (req, res, params) => {
  const db = getDb();
  const body = await parseBody(req);

  if (!body.summary || typeof body.summary !== 'string') {
    sendJson(res, 400, { error: 'summary is required' });
    return;
  }

  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(params.pid);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return;
  }

  const id = generateId();
  db.prepare(
    'INSERT INTO sessions (id, project_id, summary, next_steps) VALUES (?, ?, ?, ?)',
  ).run(id, params.pid, body.summary, (body.next_steps as string) ?? null);

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  sendJson(res, 201, session);
};

// --- Note handlers ---

const listNotes: RouteHandler = async (req, res, params) => {
  const db = getDb();
  const url = new URL(req.url || '/', 'http://localhost');
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
  const rows = db
    .prepare('SELECT * FROM notes WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(params.pid, limit, offset);
  sendJson(res, 200, rows);
};

// --- Decision handlers ---

const listDecisions: RouteHandler = async (req, res, params) => {
  const db = getDb();
  const url = new URL(req.url || '/', 'http://localhost');
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
  const rows = db
    .prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(params.pid, limit, offset);
  sendJson(res, 200, rows);
};

// --- Verification handlers (human:ui only; deliberately not MCP tools) ---

// Run a handler body, mapping ToolError to 404/409 like updateTask does.
async function withToolErrors(res: ServerResponse, fn: () => void): Promise<void> {
  try {
    fn();
  } catch (e) {
    if (e instanceof ToolError) {
      const code = e.code === 'not_found' ? 404 : e.code === 'forbidden' ? 403 : e.code.startsWith('invalid') || e.code.endsWith('_required') || e.code === 'too_long' ? 400 : 409;
      sendJson(res, code, { error: e.message, code: e.code });
      return;
    }
    throw e;
  }
}

const getVerifiers: RouteHandler = async (_req, res) => {
  sendJson(res, 200, listVerifiers(getDb()));
};

// Shows the key once. Only its hash is stored.
const createVerifier: RouteHandler = async (req, res) => {
  const body = await parseBody(req);
  await withToolErrors(res, () => {
    const created = registerVerifier(getDb(), {
      name: String(body.name ?? ''),
      kind: String(body.kind ?? '') as VerifierKind,
      project_ids: Array.isArray(body.project_ids) ? body.project_ids.map(String) : [],
    }, UI_ACTOR);
    sendJson(res, 201, created);
  });
};

const revokeVerifierRoute: RouteHandler = async (_req, res, params) => {
  await withToolErrors(res, () => {
    revokeVerifier(getDb(), params.id, UI_ACTOR);
    sendJson(res, 200, { revoked: params.id });
  });
};

// The config, plus the project's agent-editable verification commands so a
// human can review them and copy them over; the verifier never runs those.
const getVerifierConfig: RouteHandler = async (_req, res, params) => {
  const db = getDb();
  const row = db.prepare('SELECT verification_defaults FROM projects WHERE id = ?').get(params.pid) as { verification_defaults: string | null } | undefined;
  if (!row) {
    sendJson(res, 404, { error: 'Project not found' });
    return;
  }
  let suggested: Record<string, string> = {};
  try {
    suggested = row.verification_defaults ? JSON.parse(row.verification_defaults) : {};
  } catch {}
  sendJson(res, 200, { config: verifierConfig(db, params.pid), project_verification_commands: suggested });
};

const putVerifierConfig: RouteHandler = async (req, res, params) => {
  const body = await parseBody(req);
  await withToolErrors(res, () => sendJson(res, 200, setVerifierConfig(getDb(), params.pid, body, UI_ACTOR)));
};

// Whether the project's verification gate is on, and what turning it on
// still needs (or, when on, what it lost, e.g. its last key).
const getVerificationSetup: RouteHandler = async (_req, res, params) => {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(params.pid)) {
    sendJson(res, 404, { error: 'Project not found' });
    return;
  }
  sendJson(res, 200, verificationSetup(db, params.pid));
};

const putVerificationSetup: RouteHandler = async (req, res, params) => {
  const body = await parseBody(req);
  await withToolErrors(res, () => sendJson(res, 200, setVerificationMode(getDb(), params.pid, body.mode, UI_ACTOR)));
};

const getTaskVerification: RouteHandler = async (_req, res, params) => {
  const db = getDb();
  const id = resolveTaskId(params.id);
  if (!id) {
    sendJson(res, 404, { error: 'Task not found' });
    return;
  }
  expireRuns(db);
  const task = db.prepare('SELECT t.status, t.project_id, t.verified_run_id, t.spec_id, s.risk_level FROM tasks t LEFT JOIN specs s ON s.id = t.spec_id WHERE t.id = ?')
    .get(id) as { status: string; project_id: string; verified_run_id: string | null; spec_id: string | null; risk_level: string | null };
  const attempt = db.prepare(
    `SELECT attempt_no, actor, head_sha, branch, summary, criteria_results, verification_outcome, self_report_mismatch, ended_at
     FROM attempts WHERE task_id = ? AND outcome = 'submitted' ORDER BY attempt_no DESC LIMIT 1`,
  ).get(id) as Record<string, unknown> | undefined;
  sendJson(res, 200, {
    status: task.status,
    risk_level: task.risk_level ?? 'medium',
    verification: verificationMode(db, task.project_id),
    verified_run_id: task.verified_run_id,
    submission: attempt ? { ...attempt, criteria_results: attempt.criteria_results ? JSON.parse(String(attempt.criteria_results)) : [] } : null,
    runs: runsForTask(db, id),
  });
};

// Accept one task (any risk) or a batch. A UI click is the only way to done
// for medium and high risk.
const acceptRoute: RouteHandler = async (req, res, params) => {
  const body = await parseBody(req);
  const ids = params.id ? [params.id] : Array.isArray(body.task_ids) ? body.task_ids.map(String) : [];
  if (ids.length === 0) {
    sendJson(res, 400, { error: 'task_ids is required' });
    return;
  }
  const result = acceptTasks(getDb(), ids, UI_ACTOR);
  sendJson(res, params.id && result.refused.length ? 409 : 200, params.id && result.refused.length ? { error: result.refused[0].reason, ...result } : result);
};

const resolveRoute: RouteHandler = async (req, res, params) => {
  const body = await parseBody(req);
  await withToolErrors(res, () => sendJson(res, 200, resolveNeedsHuman(getDb(), params.id, String(body.action ?? '') as Resolution, String(body.note ?? ''), UI_ACTOR)));
};

const reopenRoute: RouteHandler = async (req, res, params) => {
  const body = await parseBody(req);
  await withToolErrors(res, () => sendJson(res, 200, reopenTask(getDb(), params.id, String(body.findings ?? ''), UI_ACTOR)));
};

// --- Route table ---

const routes: Route[] = [
  { method: 'GET', pattern: '/api/projects', handler: listProjects },
  { method: 'GET', pattern: '/api/projects/:id', handler: getProject },
  { method: 'PATCH', pattern: '/api/projects/:id', handler: updateProject },
  { method: 'POST', pattern: '/api/projects/:pid/sessions', handler: createSession },
  { method: 'GET', pattern: '/api/projects/:pid/notes', handler: listNotes },
  { method: 'GET', pattern: '/api/projects/:pid/decisions', handler: listDecisions },
  { method: 'GET', pattern: '/api/projects/:pid/metrics', handler: getMetrics },
  { method: 'GET', pattern: '/api/projects/:pid/tasks', handler: listTasks },
  { method: 'POST', pattern: '/api/projects/:pid/tasks', handler: createTask },
  { method: 'PATCH', pattern: '/api/tasks/:id', handler: updateTask },
  { method: 'DELETE', pattern: '/api/tasks/:id', handler: deleteTask },
  { method: 'GET', pattern: '/api/tasks/:id/history', handler: getTaskHistory },
  { method: 'GET', pattern: '/api/tasks/:id/verification', handler: getTaskVerification },
  { method: 'POST', pattern: '/api/tasks/:id/accept', handler: acceptRoute },
  { method: 'POST', pattern: '/api/tasks/:id/reopen', handler: reopenRoute },
  { method: 'POST', pattern: '/api/tasks/:id/resolve', handler: resolveRoute },
  { method: 'POST', pattern: '/api/accept', handler: acceptRoute },
  { method: 'GET', pattern: '/api/verifiers', handler: getVerifiers },
  { method: 'POST', pattern: '/api/verifiers', handler: createVerifier },
  { method: 'POST', pattern: '/api/verifiers/:id/revoke', handler: revokeVerifierRoute },
  { method: 'GET', pattern: '/api/projects/:pid/verifier-config', handler: getVerifierConfig },
  { method: 'PUT', pattern: '/api/projects/:pid/verifier-config', handler: putVerifierConfig },
  { method: 'GET', pattern: '/api/projects/:pid/verification', handler: getVerificationSetup },
  { method: 'PUT', pattern: '/api/projects/:pid/verification', handler: putVerificationSetup },
];

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const method = req.method || 'GET';

  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchRoute(route.pattern, url.pathname);
    if (params) {
      await route.handler(req, res, params);
      return;
    }
  }

  sendJson(res, 404, { error: 'Not found' });
}
