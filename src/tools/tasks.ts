import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { getDb, generateId, resolveProjectOrDefault } from '../db/queries.js';
import { maybeAutoSession } from './auto-session.js';

export function registerTaskTools(server: McpServer): void {
  server.registerTool(
    'create_task',
    {
      title: 'Create Task',
      description:
        'Create a new task in a project. Proactively use this when the user mentions something that needs to be done, a bug to fix, or a feature to build.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID (defaults to most recent active project)'),
        title: z.string().describe('Short task title'),
        description: z.string().optional().describe('Detailed description of the task'),
        priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Task priority (default: medium)'),
        tags: z.array(z.string()).optional().describe('Tags like "backend", "auth", "bug"'),
        parent_task_id: z.string().optional().describe('Parent task ID for sub-tasks'),
      },
    },
    async ({ project, title, description, priority, tags, parent_task_id }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: project ? `Project "${project}" not found.` : 'No active projects found. Create a project first.' }], isError: true };
      }

      const sessionPreamble = maybeAutoSession(resolved.id);
      const db = getDb();
      const id = generateId();
      const seqRow = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM tasks WHERE project_id = ?').get(resolved.id) as { next_seq: number };
      const seq = seqRow.next_seq;
      db.prepare(
        `INSERT INTO tasks (id, project_id, seq, title, description, priority, tags, parent_task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        resolved.id,
        seq,
        title,
        description ?? null,
        priority ?? 'medium',
        tags ? JSON.stringify(tags) : null,
        parent_task_id ?? null,
      );

      const proj = db.prepare('SELECT slug FROM projects WHERE id = ?').get(resolved.id) as { slug: string } | undefined;
      const short_id = proj?.slug ? `${proj.slug}-${seq}` : null;

      const resultText = JSON.stringify({
        task_id: id,
        short_id,
        message: `Task created: "${title}" in ${resolved.name} (priority: ${priority ?? 'medium'})`,
      });
      return {
        content: [{
          type: 'text' as const,
          text: sessionPreamble ? `${sessionPreamble}\n\n---\n\n${resultText}` : resultText,
        }],
      };
    },
  );

  server.registerTool(
    'update_task',
    {
      title: 'Update Task',
      description:
        'Update any field of a task. Proactively use this when a task status changes, priorities shift, or new information comes in.',
      inputSchema: {
        task_id: z.string().describe('Task ID to update'),
        title: z.string().optional().describe('New title'),
        description: z.string().optional().describe('New description'),
        status: z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']).optional().describe('New status'),
        priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('New priority'),
        tags: z.array(z.string()).optional().describe('New tags (replaces existing)'),
        blocked_by: z.array(z.string()).optional().describe('Task IDs that block this task'),
      },
    },
    async ({ task_id, title, description, status, priority, tags, blocked_by }) => {
      const db = getDb();
      const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task_id) as Record<string, any> | undefined;
      if (!existing) {
        return { content: [{ type: 'text' as const, text: `Task "${task_id}" not found.` }], isError: true };
      }

      const sessionPreamble = maybeAutoSession(existing.project_id);
      const updates: string[] = [];
      const params: any[] = [];

      if (title !== undefined) { updates.push('title = ?'); params.push(title); }
      if (description !== undefined) { updates.push('description = ?'); params.push(description); }
      if (status !== undefined) {
        updates.push('status = ?');
        params.push(status);
        if (status === 'done') {
          updates.push('completed_at = CURRENT_TIMESTAMP');
        }
      }
      if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }
      if (tags !== undefined) { updates.push('tags = ?'); params.push(JSON.stringify(tags)); }
      if (blocked_by !== undefined) {
        updates.push('blocked_by = ?');
        params.push(JSON.stringify(blocked_by));
        if (blocked_by.length > 0 && status === undefined) {
          updates.push("status = 'blocked'");
        }
      }

      if (updates.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No updates provided.' }], isError: true };
      }

      params.push(task_id);
      db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);

      const resultText = JSON.stringify({ task_id, message: `Task "${existing.title}" updated.` });
      return {
        content: [{ type: 'text' as const, text: sessionPreamble ? `${sessionPreamble}\n\n---\n\n${resultText}` : resultText }],
      };
    },
  );

  server.registerTool(
    'list_tasks',
    {
      title: 'List Tasks',
      description:
        'List tasks with filters. Defaults to showing non-completed tasks for the most recent active project.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID'),
        status: z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']).optional().describe('Filter by status'),
        priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Filter by priority'),
        tag: z.string().optional().describe('Filter by tag'),
        include_done: z.boolean().optional().describe('Include completed tasks (default: false)'),
      },
    },
    async ({ project, status, priority, tag, include_done }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: project ? `Project "${project}" not found.` : 'No active projects found.' }], isError: true };
      }

      const sessionPreamble = maybeAutoSession(resolved.id);
      const db = getDb();
      const conditions: string[] = ['t.project_id = @projectId'];
      const params: Record<string, any> = { projectId: resolved.id };

      if (status) {
        conditions.push('t.status = @status');
        params.status = status;
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

      const sql = `SELECT t.*, p.slug || '-' || t.seq AS short_id FROM tasks t JOIN projects p ON t.project_id = p.id WHERE ${conditions.join(' AND ')} ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, t.created_at DESC`;
      const rows = db.prepare(sql).all(params);

      const resultText = JSON.stringify({ project: resolved.name, tasks: rows }, null, 2);
      return {
        content: [{ type: 'text' as const, text: sessionPreamble ? `${sessionPreamble}\n\n---\n\n${resultText}` : resultText }],
      };
    },
  );

  server.registerTool(
    'get_task',
    {
      title: 'Get Task',
      description: 'Get full detail for a specific task including sub-tasks and related notes.',
      inputSchema: {
        task_id: z.string().describe('Task ID'),
      },
    },
    async ({ task_id }) => {
      const db = getDb();
      const task = db.prepare('SELECT t.*, p.slug || \'-\' || t.seq AS short_id FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.id = ?').get(task_id) as Record<string, any> | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Task "${task_id}" not found.` }], isError: true };
      }

      const sessionPreamble = maybeAutoSession(task.project_id);
      const subtasks = db.prepare('SELECT t.*, p.slug || \'-\' || t.seq AS short_id FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.parent_task_id = ?').all(task_id);
      const notes = db.prepare('SELECT * FROM notes WHERE task_id = ? ORDER BY created_at DESC').all(task_id);

      const resultText = JSON.stringify({ task, subtasks, notes }, null, 2);
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
        'Smart query: what should be worked on next? Returns highest priority non-blocked tasks for a project.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID'),
        limit: z.number().optional().describe('Max number of tasks to return (default: 5)'),
      },
    },
    async ({ project, limit }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: project ? `Project "${project}" not found.` : 'No active projects found.' }], isError: true };
      }

      const sessionPreamble = maybeAutoSession(resolved.id);
      const db = getDb();
      const rows = db
        .prepare(
          `SELECT t.*, p.slug || '-' || t.seq AS short_id FROM tasks t JOIN projects p ON t.project_id = p.id
           WHERE t.project_id = ? AND t.status IN ('todo', 'in_progress')
           ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
                    t.created_at ASC
           LIMIT ?`
        )
        .all(resolved.id, limit ?? 5);

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
