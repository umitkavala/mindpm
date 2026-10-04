import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { getDb, resolveProjectOrDefault, resolveProjectError } from '../db/queries.js';
import { maybeAutoSession } from './auto-session.js';
import { buildFtsMatch, ftsReady } from '../utils/fts.js';

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
        return { content: [{ type: 'text' as const, text: resolveProjectError(project) }], isError: true };
      }

      const sessionPreamble = maybeAutoSession(resolved.id);
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
           WHERE project_id = ? AND status IN ('ready', 'claimed')
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

      const resultText = JSON.stringify(
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
      );
      return {
        content: [{
          type: 'text' as const,
          text: sessionPreamble ? `${sessionPreamble}\n\n---\n\n${resultText}` : resultText,
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
        return { content: [{ type: 'text' as const, text: resolveProjectError(project) }], isError: true };
      }

      const sessionPreamble = maybeAutoSession(resolved.id);
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

      const resultText = JSON.stringify({ project: resolved.name, blockers: enriched }, null, 2);
      return {
        content: [{ type: 'text' as const, text: sessionPreamble ? `${sessionPreamble}\n\n---\n\n${resultText}` : resultText }],
      };
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Search Everything',
      description: 'Full-text search (FTS5, ranked by relevance) across tasks, notes, decisions, specs and attempt root causes for a project.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID'),
        query: z.string().describe('Search query'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results per category (default: 20)'),
      },
    },
    async ({ project, query, limit = 20 }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: resolveProjectError(project) }], isError: true };
      }

      const sessionPreamble = maybeAutoSession(resolved.id);
      const db = getDb();
      const match = buildFtsMatch(query);

      // Each result set is bounded (limit per category) and we count true totals
      // separately, so a broad query never returns an unbounded payload.
      let tasks: unknown[];
      let notes: unknown[];
      let decisions: unknown[];
      let specs: unknown[];
      let attempts: unknown[];
      let taskTotal: number;
      let noteTotal: number;
      let decisionTotal: number;
      let specTotal: number;
      let attemptTotal: number;
      let engine: 'fts' | 'like';

      if (match && ftsReady(db)) {
        engine = 'fts';
        // Ranked by bm25 (lower = more relevant). Join FTS rowid back to the base row.
        tasks = db
          .prepare("SELECT t.id, t.title, t.description, t.status, t.priority, 'task' as type FROM tasks_fts JOIN tasks t ON t.rowid = tasks_fts.rowid WHERE tasks_fts MATCH ? AND t.project_id = ? ORDER BY bm25(tasks_fts) LIMIT ?")
          .all(match, resolved.id, limit);
        notes = db
          .prepare("SELECT n.id, n.content, n.category, 'note' as type FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid WHERE notes_fts MATCH ? AND n.project_id = ? ORDER BY bm25(notes_fts) LIMIT ?")
          .all(match, resolved.id, limit);
        decisions = db
          .prepare("SELECT d.id, d.title, d.decision, d.reasoning, 'decision' as type FROM decisions_fts JOIN decisions d ON d.rowid = decisions_fts.rowid WHERE decisions_fts MATCH ? AND d.project_id = ? ORDER BY bm25(decisions_fts) LIMIT ?")
          .all(match, resolved.id, limit);
        taskTotal = (db.prepare('SELECT COUNT(*) as n FROM tasks_fts JOIN tasks t ON t.rowid = tasks_fts.rowid WHERE tasks_fts MATCH ? AND t.project_id = ?').get(match, resolved.id) as { n: number }).n;
        noteTotal = (db.prepare('SELECT COUNT(*) as n FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid WHERE notes_fts MATCH ? AND n.project_id = ?').get(match, resolved.id) as { n: number }).n;
        decisionTotal = (db.prepare('SELECT COUNT(*) as n FROM decisions_fts JOIN decisions d ON d.rowid = decisions_fts.rowid WHERE decisions_fts MATCH ? AND d.project_id = ?').get(match, resolved.id) as { n: number }).n;
        specs = db
          .prepare(`SELECT s.id, 'SPEC-' || s.seq AS key, s.title, s.objective, s.status, 'spec' as type FROM specs_fts JOIN specs s ON s.rowid = specs_fts.rowid WHERE specs_fts MATCH ? AND s.project_id = ? ORDER BY bm25(specs_fts) LIMIT ?`)
          .all(match, resolved.id, limit);
        specTotal = (db.prepare('SELECT COUNT(*) as n FROM specs_fts JOIN specs s ON s.rowid = specs_fts.rowid WHERE specs_fts MATCH ? AND s.project_id = ?').get(match, resolved.id) as { n: number }).n;
        attempts = db
          .prepare(`SELECT a.task_id, p.slug || '-' || t.seq AS task_key, a.attempt_no, a.outcome, a.failure_type, a.root_cause, 'attempt' as type
                    FROM attempts_fts JOIN attempts a ON a.rowid = attempts_fts.rowid JOIN tasks t ON t.id = a.task_id JOIN projects p ON p.id = t.project_id
                    WHERE attempts_fts MATCH ? AND t.project_id = ? ORDER BY bm25(attempts_fts) LIMIT ?`)
          .all(match, resolved.id, limit);
        attemptTotal = (db.prepare('SELECT COUNT(*) as n FROM attempts_fts JOIN attempts a ON a.rowid = attempts_fts.rowid JOIN tasks t ON t.id = a.task_id WHERE attempts_fts MATCH ? AND t.project_id = ?').get(match, resolved.id) as { n: number }).n;
      } else {
        engine = 'like';
        const pattern = `%${query}%`;
        taskTotal = (db.prepare('SELECT COUNT(*) as n FROM tasks WHERE project_id = ? AND (title LIKE ? OR description LIKE ?)').get(resolved.id, pattern, pattern) as { n: number }).n;
        noteTotal = (db.prepare('SELECT COUNT(*) as n FROM notes WHERE project_id = ? AND content LIKE ?').get(resolved.id, pattern) as { n: number }).n;
        decisionTotal = (db.prepare('SELECT COUNT(*) as n FROM decisions WHERE project_id = ? AND (title LIKE ? OR decision LIKE ? OR reasoning LIKE ?)').get(resolved.id, pattern, pattern, pattern) as { n: number }).n;
        tasks = db
          .prepare("SELECT id, title, description, status, priority, 'task' as type FROM tasks WHERE project_id = ? AND (title LIKE ? OR description LIKE ?) ORDER BY updated_at DESC LIMIT ?")
          .all(resolved.id, pattern, pattern, limit);
        notes = db
          .prepare("SELECT id, content, category, 'note' as type FROM notes WHERE project_id = ? AND content LIKE ? ORDER BY created_at DESC LIMIT ?")
          .all(resolved.id, pattern, limit);
        decisions = db
          .prepare("SELECT id, title, decision, reasoning, 'decision' as type FROM decisions WHERE project_id = ? AND (title LIKE ? OR decision LIKE ? OR reasoning LIKE ?) ORDER BY created_at DESC LIMIT ?")
          .all(resolved.id, pattern, pattern, pattern, limit);
        specTotal = (db.prepare('SELECT COUNT(*) as n FROM specs WHERE project_id = ? AND (title LIKE ? OR objective LIKE ? OR why LIKE ?)').get(resolved.id, pattern, pattern, pattern) as { n: number }).n;
        specs = db
          .prepare("SELECT id, 'SPEC-' || seq AS key, title, objective, status, 'spec' as type FROM specs WHERE project_id = ? AND (title LIKE ? OR objective LIKE ? OR why LIKE ?) ORDER BY updated_at DESC LIMIT ?")
          .all(resolved.id, pattern, pattern, pattern, limit);
        attemptTotal = (db.prepare('SELECT COUNT(*) as n FROM attempts a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ? AND a.root_cause LIKE ?').get(resolved.id, pattern) as { n: number }).n;
        attempts = db
          .prepare(`SELECT a.task_id, p.slug || '-' || t.seq AS task_key, a.attempt_no, a.outcome, a.failure_type, a.root_cause, 'attempt' as type
                    FROM attempts a JOIN tasks t ON t.id = a.task_id JOIN projects p ON p.id = t.project_id
                    WHERE t.project_id = ? AND a.root_cause LIKE ? ORDER BY a.started_at DESC LIMIT ?`)
          .all(resolved.id, pattern, limit);
      }

      const truncated = taskTotal > tasks.length || noteTotal > notes.length || decisionTotal > decisions.length
        || specTotal > specs.length || attemptTotal > attempts.length;
      const resultText = JSON.stringify(
        {
          project: resolved.name,
          query,
          engine,
          limit,
          truncated,
          counts: { tasks: taskTotal, notes: noteTotal, decisions: decisionTotal, specs: specTotal, attempts: attemptTotal },
          results: { tasks, notes, decisions, specs, attempts },
          total: taskTotal + noteTotal + decisionTotal + specTotal + attemptTotal,
        },
        null,
        2,
      );
      return {
        content: [{
          type: 'text' as const,
          text: sessionPreamble ? `${sessionPreamble}\n\n---\n\n${resultText}` : resultText,
        }],
      };
    },
  );
}
