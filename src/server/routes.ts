import { IncomingMessage, ServerResponse } from 'node:http';
import { getDb, generateId, resolveProjectOrDefault, resolveProjectId, recordTaskHistory } from '../db/queries.js';
import { generateSlug } from '../utils/ids.js';
import { matchRoute, parseBody, sendJson } from './http.js';

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

const listTasks: RouteHandler = async (req, res, params) => {
  const db = getDb();
  const url = new URL(req.url || '/', 'http://localhost');
  const includeDone = url.searchParams.get('include_done') === 'true';

  let sql = 'SELECT t.*, p.slug || \'-\' || t.seq AS short_id FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.project_id = ?';
  if (!includeDone) {
    sql += " AND t.status NOT IN ('done', 'cancelled')";
  }
  sql += " ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, t.created_at DESC";

  const rows = db.prepare(sql).all(params.pid);
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
  recordTaskHistory(id, 'created', null, JSON.stringify({ status: priority === 'medium' ? 'todo' : priority, priority }));
  sendJson(res, 201, task);
};

const updateTask: RouteHandler = async (req, res, params) => {
  const db = getDb();
  const body = await parseBody(req);

  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id) as Record<string, unknown> | undefined;
  if (!existing) {
    sendJson(res, 404, { error: 'Task not found' });
    return;
  }

  const updates: string[] = [];
  const sqlParams: unknown[] = [];

  if (body.title !== undefined) { updates.push('title = ?'); sqlParams.push(body.title); }
  if (body.description !== undefined) { updates.push('description = ?'); sqlParams.push(body.description); }
  if (body.status !== undefined) {
    updates.push('status = ?');
    sqlParams.push(body.status);
    if (body.status === 'done') {
      updates.push('completed_at = CURRENT_TIMESTAMP');
    } else {
      updates.push('completed_at = NULL');
    }
  }
  if (body.priority !== undefined) { updates.push('priority = ?'); sqlParams.push(body.priority); }
  if (body.tags !== undefined) {
    updates.push('tags = ?');
    sqlParams.push(Array.isArray(body.tags) ? JSON.stringify(body.tags) : null);
  }
  if (body.blocked_by !== undefined) {
    updates.push('blocked_by = ?');
    sqlParams.push(Array.isArray(body.blocked_by) ? JSON.stringify(body.blocked_by) : null);
    if (Array.isArray(body.blocked_by) && body.blocked_by.length > 0 && body.status === undefined) {
      updates.push("status = 'blocked'");
    }
  }

  if (updates.length === 0) {
    sendJson(res, 400, { error: 'No updates provided' });
    return;
  }

  sqlParams.push(params.id);
  db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...sqlParams);

  // Record history for meaningful field changes
  if (body.status !== undefined && body.status !== existing.status) {
    recordTaskHistory(params.id, 'status_changed', existing.status as string, body.status as string);
  }
  if (body.priority !== undefined && body.priority !== existing.priority) {
    recordTaskHistory(params.id, 'priority_changed', existing.priority as string, body.priority as string);
  }
  if (body.title !== undefined && body.title !== existing.title) {
    recordTaskHistory(params.id, 'title_changed', existing.title as string, body.title as string);
  }

  const updated = db.prepare('SELECT t.*, p.slug || \'-\' || t.seq AS short_id FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.id = ?').get(params.id);
  sendJson(res, 200, updated);
};

const deleteTask: RouteHandler = async (_req, res, params) => {
  const db = getDb();

  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(params.id);
  if (!existing) {
    sendJson(res, 404, { error: 'Task not found' });
    return;
  }

  const deleteTransaction = db.transaction((taskId: string) => {
    // Get subtask IDs
    const subtasks = db.prepare('SELECT id FROM tasks WHERE parent_task_id = ?').all(taskId) as { id: string }[];
    for (const sub of subtasks) {
      db.prepare('DELETE FROM task_history WHERE task_id = ?').run(sub.id);
      db.prepare('DELETE FROM notes WHERE task_id = ?').run(sub.id);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(sub.id);
    }
    // Delete history and notes linked to this task
    db.prepare('DELETE FROM task_history WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM notes WHERE task_id = ?').run(taskId);
    // Delete the task
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  });

  deleteTransaction(params.id);
  sendJson(res, 200, { message: 'Task deleted' });
};

// --- Task history handler ---

const getTaskHistory: RouteHandler = async (_req, res, params) => {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM task_history WHERE task_id = ? ORDER BY created_at ASC'
  ).all(params.id);
  sendJson(res, 200, rows);
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

// --- Decision handlers ---

const listDecisions: RouteHandler = async (_req, res, params) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at DESC').all(params.pid);
  sendJson(res, 200, rows);
};

// --- Route table ---

const routes: Route[] = [
  { method: 'GET', pattern: '/api/projects', handler: listProjects },
  { method: 'GET', pattern: '/api/projects/:id', handler: getProject },
  { method: 'PATCH', pattern: '/api/projects/:id', handler: updateProject },
  { method: 'POST', pattern: '/api/projects/:pid/sessions', handler: createSession },
  { method: 'GET', pattern: '/api/projects/:pid/decisions', handler: listDecisions },
  { method: 'GET', pattern: '/api/projects/:pid/tasks', handler: listTasks },
  { method: 'POST', pattern: '/api/projects/:pid/tasks', handler: createTask },
  { method: 'PATCH', pattern: '/api/tasks/:id', handler: updateTask },
  { method: 'DELETE', pattern: '/api/tasks/:id', handler: deleteTask },
  { method: 'GET', pattern: '/api/tasks/:id/history', handler: getTaskHistory },
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
