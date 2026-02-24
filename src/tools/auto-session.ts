import type Database from 'better-sqlite3';
import { getDb, generateId } from '../db/queries.js';
import { getHttpPort } from '../server/http.js';

interface ActivityItem {
  type: string;
  id: string;
  title: string;
  timestamp: string;
}

// Per-process set: tracks which project IDs have had a session started this run
const autoStartedProjects = new Set<string>();

export function markSessionStarted(projectId: string): void {
  autoStartedProjects.add(projectId);
}

function getActivitySince(db: Database.Database, projectId: string, cutoffTime: string): ActivityItem[] {
  return db.prepare(`
    SELECT 'task_created' as type, id, title, created_at as timestamp
    FROM tasks WHERE project_id = ? AND created_at > ?
    UNION ALL
    SELECT 'task_updated' as type, id, title, updated_at as timestamp
    FROM tasks WHERE project_id = ? AND updated_at > ? AND updated_at != created_at
    UNION ALL
    SELECT 'decision' as type, id, title, created_at as timestamp
    FROM decisions WHERE project_id = ? AND created_at > ?
    UNION ALL
    SELECT 'note' as type, id, substr(content, 1, 80) as title, created_at as timestamp
    FROM notes WHERE project_id = ? AND created_at > ?
    ORDER BY timestamp DESC
  `).all(
    projectId, cutoffTime,
    projectId, cutoffTime,
    projectId, cutoffTime,
    projectId, cutoffTime,
  ) as ActivityItem[];
}

export function buildSessionText(projectId: string): string {
  const db = getDb();
  const projectRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);

  let lastSession = db
    .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(projectId) as Record<string, any> | undefined;

  const cutoffTime = lastSession?.created_at ?? '1970-01-01';
  const recentActivity = getActivitySince(db, projectId, cutoffTime);

  if (recentActivity.length > 0) {
    const taskIds = [...new Set(
      recentActivity
        .filter(a => a.type === 'task_created' || a.type === 'task_updated')
        .map(a => a.id),
    )];
    const decisionIds = [...new Set(
      recentActivity.filter(a => a.type === 'decision').map(a => a.id),
    )];

    const syntheticId = generateId();
    db.prepare(
      `INSERT INTO sessions (id, project_id, summary, tasks_worked_on, decisions_made) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      syntheticId,
      projectId,
      `Auto-generated: ${recentActivity.length} activities since last session`,
      taskIds.length > 0 ? JSON.stringify(taskIds) : null,
      decisionIds.length > 0 ? JSON.stringify(decisionIds) : null,
    );

    lastSession = db
      .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(projectId) as Record<string, any> | undefined;
  }

  const activeTasks = db
    .prepare(
      `SELECT id, title, status, priority, tags FROM tasks
       WHERE project_id = ? AND status NOT IN ('done', 'cancelled')
       ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END`
    )
    .all(projectId);

  const blockedTasks = db
    .prepare("SELECT id, title, blocked_by FROM tasks WHERE project_id = ? AND status = 'blocked'")
    .all(projectId);

  const recentDecisions = db
    .prepare('SELECT id, title, decision, created_at FROM decisions WHERE project_id = ? ORDER BY created_at DESC LIMIT 5')
    .all(projectId);

  const taskCounts = db
    .prepare('SELECT status, COUNT(*) as count FROM tasks WHERE project_id = ? GROUP BY status')
    .all(projectId);

  const contextItems = db
    .prepare('SELECT key, value, category FROM context WHERE project_id = ? ORDER BY category, key')
    .all(projectId);

  db.prepare('UPDATE projects SET status = status WHERE id = ?').run(projectId);

  const port = getHttpPort();
  const kanbanUrl = port ? `http://localhost:${port}?project=${projectId}` : null;

  const result = {
    kanban_url: kanbanUrl,
    project: projectRow,
    last_session: lastSession
      ? {
          summary: lastSession.summary,
          next_steps: lastSession.next_steps,
          when: lastSession.created_at,
        }
      : null,
    recent_activity: recentActivity.slice(0, 20),
    task_summary: taskCounts,
    active_tasks: activeTasks,
    blocked_tasks: blockedTasks,
    recent_decisions: recentDecisions,
    context: contextItems,
  };

  const kanbanLine = kanbanUrl
    ? `Kanban board: ${kanbanUrl}`
    : 'Kanban board: unavailable (HTTP server not running)';

  return `${kanbanLine}\n\n${JSON.stringify(result, null, 2)}`;
}

/**
 * If this project hasn't had a session started yet this process run,
 * runs the session logic and returns the session text to prepend to the tool response.
 * Returns null if the session was already started (no-op).
 */
export function maybeAutoSession(projectId: string): string | null {
  if (autoStartedProjects.has(projectId)) return null;
  autoStartedProjects.add(projectId);
  return buildSessionText(projectId);
}
