import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type Database from 'better-sqlite3';
import { getDb, generateId, resolveProjectOrDefault } from '../db/queries.js';
import { getHttpPort } from '../server/http.js';

interface ActivityItem {
  type: string;
  id: string;
  title: string;
  timestamp: string;
}

function getActivitySince(db: Database.Database, projectId: string, cutoffTime: string): ActivityItem[] {
  return db.prepare(`
    SELECT 'task_created' as type, id, title, created_at as timestamp
    FROM tasks
    WHERE project_id = ? AND created_at > ?
    UNION ALL
    SELECT 'task_updated' as type, id, title, updated_at as timestamp
    FROM tasks
    WHERE project_id = ? AND updated_at > ? AND updated_at != created_at
    UNION ALL
    SELECT 'decision' as type, id, title, created_at as timestamp
    FROM decisions
    WHERE project_id = ? AND created_at > ?
    UNION ALL
    SELECT 'note' as type, id, substr(content, 1, 80) as title, created_at as timestamp
    FROM notes
    WHERE project_id = ? AND created_at > ?
    ORDER BY timestamp DESC
  `).all(
    projectId, cutoffTime,
    projectId, cutoffTime,
    projectId, cutoffTime,
    projectId, cutoffTime,
  ) as ActivityItem[];
}

export function registerSessionTools(server: McpServer): void {
  server.registerTool(
    'start_session',
    {
      title: 'Start Session',
      description:
        'Begin a work session for a project. Returns the full project overview including last session\'s next_steps, active tasks, blockers, and recent decisions. Call this at the start of every conversation. IMPORTANT: Always show the kanban_url to the user as a clickable link so they can open the Kanban board.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID'),
      },
    },
    async ({ project }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: project ? `Project "${project}" not found.` : 'No active projects found. Create a project first.' }], isError: true };
      }

      const db = getDb();
      const projectRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(resolved.id);

      let lastSession = db
        .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(resolved.id) as Record<string, any> | undefined;

      const cutoffTime = lastSession?.created_at ?? '1970-01-01';
      const recentActivity = getActivitySince(db, resolved.id, cutoffTime);

      // Auto-close: create synthetic session if there's unrecorded activity
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
          resolved.id,
          `Auto-generated: ${recentActivity.length} activities since last session`,
          taskIds.length > 0 ? JSON.stringify(taskIds) : null,
          decisionIds.length > 0 ? JSON.stringify(decisionIds) : null,
        );

        lastSession = db
          .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
          .get(resolved.id) as Record<string, any> | undefined;
      }

      const activeTasks = db
        .prepare(
          `SELECT id, title, status, priority, tags FROM tasks
           WHERE project_id = ? AND status NOT IN ('done', 'cancelled')
           ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END`
        )
        .all(resolved.id);

      const blockedTasks = db
        .prepare("SELECT id, title, blocked_by FROM tasks WHERE project_id = ? AND status = 'blocked'")
        .all(resolved.id);

      const recentDecisions = db
        .prepare('SELECT id, title, decision, created_at FROM decisions WHERE project_id = ? ORDER BY created_at DESC LIMIT 5')
        .all(resolved.id);

      const taskCounts = db
        .prepare('SELECT status, COUNT(*) as count FROM tasks WHERE project_id = ? GROUP BY status')
        .all(resolved.id);

      const contextItems = db
        .prepare('SELECT key, value, category FROM context WHERE project_id = ? ORDER BY category, key')
        .all(resolved.id);

      // Touch the project to update its updated_at
      db.prepare('UPDATE projects SET status = status WHERE id = ?').run(resolved.id);

      const port = getHttpPort();
      const result = {
        kanban_url: port ? `http://localhost:${port}?project=${resolved.id}` : null,
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

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    'end_session',
    {
      title: 'End Session',
      description:
        'End a work session with a summary of what was accomplished and what to do next. Call this when the user is done working.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID'),
        summary: z.string().describe('Summary of what was accomplished this session'),
        tasks_worked_on: z.array(z.string()).optional().describe('Task IDs that were worked on'),
        decisions_made: z.array(z.string()).optional().describe('Decision IDs that were made'),
        next_steps: z.string().optional().describe('What to do next time'),
      },
    },
    async ({ project, summary, tasks_worked_on, decisions_made, next_steps }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: project ? `Project "${project}" not found.` : 'No active projects found.' }], isError: true };
      }

      const db = getDb();
      const id = generateId();
      db.prepare(
        `INSERT INTO sessions (id, project_id, summary, tasks_worked_on, decisions_made, next_steps) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        resolved.id,
        summary,
        tasks_worked_on ? JSON.stringify(tasks_worked_on) : null,
        decisions_made ? JSON.stringify(decisions_made) : null,
        next_steps ?? null,
      );

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ session_id: id, message: `Session ended for ${resolved.name}. Summary saved.` }),
        }],
      };
    },
  );
}
