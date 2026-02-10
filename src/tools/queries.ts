import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { getDb, resolveProjectOrDefault } from '../db/queries.js';

export function registerQueryTools(server: McpServer): void {
  server.registerTool(
    'query',
    {
      title: 'Query Database',
      description:
        'Execute a read-only SQL query against the database. Only SELECT statements are allowed. Use this for custom queries not covered by other tools.',
      inputSchema: {
        sql: z.string().describe('SQL SELECT query to execute'),
      },
    },
    async ({ sql }) => {
      const trimmed = sql.trim();
      if (!trimmed.toUpperCase().startsWith('SELECT')) {
        return { content: [{ type: 'text' as const, text: 'Only SELECT queries are allowed.' }], isError: true };
      }

      const db = getDb();
      try {
        const stmt = db.prepare(trimmed);
        if (!stmt.reader) {
          return { content: [{ type: 'text' as const, text: 'Only read-only queries are allowed.' }], isError: true };
        }
        const rows = stmt.all();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ rows, count: rows.length }, null, 2) }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Query error: ${e.message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    'get_project_summary',
    {
      title: 'Get Project Summary',
      description:
        'High-level summary of a project: total tasks by status, recent activity, open blockers, and upcoming priorities.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID'),
      },
    },
    async ({ project }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: project ? `Project "${project}" not found.` : 'No active projects found.' }], isError: true };
      }

      const db = getDb();
      const tasksByStatus = db
        .prepare('SELECT status, COUNT(*) as count FROM tasks WHERE project_id = ? GROUP BY status')
        .all(resolved.id);

      const blockers = db
        .prepare("SELECT id, title, blocked_by FROM tasks WHERE project_id = ? AND status = 'blocked'")
        .all(resolved.id);

      const upcomingPriorities = db
        .prepare(
          `SELECT id, title, priority, status FROM tasks
           WHERE project_id = ? AND status IN ('todo', 'in_progress')
           ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END
           LIMIT 10`
        )
        .all(resolved.id);

      const recentActivity = db
        .prepare(
          `SELECT 'task' as type, title, updated_at FROM tasks WHERE project_id = ? AND updated_at > datetime('now', '-7 days')
           UNION ALL
           SELECT 'decision' as type, title, created_at as updated_at FROM decisions WHERE project_id = ? AND created_at > datetime('now', '-7 days')
           UNION ALL
           SELECT 'note' as type, substr(content, 1, 50) as title, created_at as updated_at FROM notes WHERE project_id = ? AND created_at > datetime('now', '-7 days')
           ORDER BY updated_at DESC
           LIMIT 20`
        )
        .all(resolved.id, resolved.id, resolved.id);

      const totalNotes = db
        .prepare('SELECT COUNT(*) as count FROM notes WHERE project_id = ?')
        .get(resolved.id) as { count: number };

      const totalDecisions = db
        .prepare('SELECT COUNT(*) as count FROM decisions WHERE project_id = ?')
        .get(resolved.id) as { count: number };

      const totalSessions = db
        .prepare('SELECT COUNT(*) as count FROM sessions WHERE project_id = ?')
        .get(resolved.id) as { count: number };

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(
            {
              project: resolved.name,
              tasks_by_status: tasksByStatus,
              blockers,
              upcoming_priorities: upcomingPriorities,
              recent_activity: recentActivity,
              totals: { notes: totalNotes.count, decisions: totalDecisions.count, sessions: totalSessions.count },
            },
            null,
            2,
          ),
        }],
      };
    },
  );

  server.registerTool(
    'get_blockers',
    {
      title: 'Get Blockers',
      description: 'List all blocked tasks with what\'s blocking them.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID'),
      },
    },
    async ({ project }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: project ? `Project "${project}" not found.` : 'No active projects found.' }], isError: true };
      }

      const db = getDb();
      const blockers = db
        .prepare("SELECT * FROM tasks WHERE project_id = ? AND status = 'blocked'")
        .all(resolved.id) as Record<string, any>[];

      // Resolve blocking task titles
      const enriched = blockers.map((task) => {
        let blockingTasks: any[] = [];
        if (task.blocked_by) {
          try {
            const ids = JSON.parse(task.blocked_by) as string[];
            blockingTasks = ids.map((id) => {
              const blocking = db.prepare('SELECT id, title, status FROM tasks WHERE id = ?').get(id);
              return blocking ?? { id, title: 'Unknown task', status: 'unknown' };
            });
          } catch {
            // ignore parse errors
          }
        }
        return { ...task, blocking_tasks: blockingTasks };
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ project: resolved.name, blockers: enriched }, null, 2) }],
      };
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Search Everything',
      description: 'Full-text search across tasks, notes, and decisions for a project.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID'),
        query: z.string().describe('Search query'),
      },
    },
    async ({ project, query }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: project ? `Project "${project}" not found.` : 'No active projects found.' }], isError: true };
      }

      const db = getDb();
      const pattern = `%${query}%`;

      const tasks = db
        .prepare("SELECT id, title, description, status, priority, 'task' as type FROM tasks WHERE project_id = ? AND (title LIKE ? OR description LIKE ?)")
        .all(resolved.id, pattern, pattern);

      const notes = db
        .prepare("SELECT id, content, category, 'note' as type FROM notes WHERE project_id = ? AND content LIKE ?")
        .all(resolved.id, pattern);

      const decisions = db
        .prepare("SELECT id, title, decision, reasoning, 'decision' as type FROM decisions WHERE project_id = ? AND (title LIKE ? OR decision LIKE ? OR reasoning LIKE ?)")
        .all(resolved.id, pattern, pattern, pattern);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(
            {
              project: resolved.name,
              query,
              results: { tasks, notes, decisions },
              total: tasks.length + notes.length + decisions.length,
            },
            null,
            2,
          ),
        }],
      };
    },
  );
}
