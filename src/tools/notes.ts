import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { getDb, generateId, resolveProjectOrDefault } from '../db/queries.js';
import { maybeAutoSession } from './auto-session.js';

export function registerNoteTools(server: McpServer): void {
  server.registerTool(
    'add_note',
    {
      title: 'Add Note',
      description:
        'Add a note to a project or task. Proactively use this when the user shares context about architecture, bugs, ideas, research findings, or any important information worth remembering. Always specify the project parameter when you know which project is active.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID (always pass this when known — omitting may target the wrong project)'),
        content: z.string().describe('The note content'),
        category: z
          .enum(['general', 'architecture', 'bug', 'idea', 'research', 'meeting', 'review'])
          .optional()
          .describe('Note category (default: general)'),
        task_id: z.string().optional().describe('Link this note to a specific task'),
        tags: z.array(z.string()).optional().describe('Tags for categorization'),
      },
    },
    async ({ project, content, category, task_id, tags }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: project ? `Project "${project}" not found.` : 'No active projects found. Create a project first.' }], isError: true };
      }

      const db = getDb();
      const id = generateId();
      db.prepare(
        `INSERT INTO notes (id, project_id, task_id, content, category, tags) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        resolved.id,
        task_id ?? null,
        content,
        category ?? 'general',
        tags ? JSON.stringify(tags) : null,
      );

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ note_id: id, message: `Note added to ${resolved.name} (${category ?? 'general'})` }),
        }],
      };
    },
  );

  server.registerTool(
    'search_notes',
    {
      title: 'Search Notes',
      description: 'Full-text search across notes for a project.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID'),
        query: z.string().describe('Search query'),
        category: z
          .enum(['general', 'architecture', 'bug', 'idea', 'research', 'meeting', 'review'])
          .optional()
          .describe('Filter by category'),
      },
    },
    async ({ project, query, category }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: project ? `Project "${project}" not found.` : 'No active projects found.' }], isError: true };
      }

      const sessionPreamble = maybeAutoSession(resolved.id);
      const db = getDb();
      const conditions: string[] = ['project_id = ?'];
      const params: any[] = [resolved.id];

      conditions.push("content LIKE '%' || ? || '%'");
      params.push(query);

      if (category) {
        conditions.push('category = ?');
        params.push(category);
      }

      const sql = `SELECT * FROM notes WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`;
      const rows = db.prepare(sql).all(...params);

      const resultText = JSON.stringify({ project: resolved.name, results: rows }, null, 2);
      return {
        content: [{ type: 'text' as const, text: sessionPreamble ? `${sessionPreamble}\n\n---\n\n${resultText}` : resultText }],
      };
    },
  );

  server.registerTool(
    'set_context',
    {
      title: 'Set Context',
      description:
        'Set a key-value context pair for a project (upsert). Proactively use this when the user shares important project context like architecture decisions, config values, conventions, or constraints.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID'),
        key: z.string().describe('Context key, e.g. "auth_approach", "deployment_target", "api_base_url"'),
        value: z.string().describe('Context value'),
        category: z.string().optional().describe('Category like "architecture", "config", "convention", "constraint"'),
      },
    },
    async ({ project, key, value, category }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: project ? `Project "${project}" not found.` : 'No active projects found. Create a project first.' }], isError: true };
      }

      const db = getDb();
      const id = generateId();
      db.prepare(
        `INSERT INTO context (id, project_id, key, value, category)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value, category = excluded.category`
      ).run(id, resolved.id, key, value, category ?? 'general');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ message: `Context set: "${key}" = "${value}" in ${resolved.name}` }),
        }],
      };
    },
  );

  server.registerTool(
    'get_context',
    {
      title: 'Get Context',
      description: 'Get context by key or list all context for a project.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID'),
        key: z.string().optional().describe('Specific context key to retrieve. If omitted, returns all context.'),
      },
    },
    async ({ project, key }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: project ? `Project "${project}" not found.` : 'No active projects found.' }], isError: true };
      }

      const sessionPreamble = maybeAutoSession(resolved.id);
      const db = getDb();
      let rows;
      if (key) {
        rows = db.prepare('SELECT * FROM context WHERE project_id = ? AND key = ?').all(resolved.id, key);
      } else {
        rows = db.prepare('SELECT * FROM context WHERE project_id = ? ORDER BY category, key').all(resolved.id);
      }

      const resultText = JSON.stringify({ project: resolved.name, context: rows }, null, 2);
      return {
        content: [{ type: 'text' as const, text: sessionPreamble ? `${sessionPreamble}\n\n---\n\n${resultText}` : resultText }],
      };
    },
  );
}
