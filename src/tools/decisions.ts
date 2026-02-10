import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { getDb, generateId, resolveProjectOrDefault } from '../db/queries.js';

export function registerDecisionTools(server: McpServer): void {
  server.registerTool(
    'log_decision',
    {
      title: 'Log Decision',
      description:
        'Record a decision with reasoning and alternatives considered. Proactively use this when the user makes a technical decision, chooses between options, or settles a debate.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID'),
        title: z.string().describe('Short title for the decision'),
        decision: z.string().describe('What was decided'),
        reasoning: z.string().optional().describe('Why this was decided'),
        alternatives: z.array(z.string()).optional().describe('Rejected alternatives'),
        tags: z.array(z.string()).optional().describe('Tags like "architecture", "database", "api"'),
      },
    },
    async ({ project, title, decision, reasoning, alternatives, tags }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: project ? `Project "${project}" not found.` : 'No active projects found. Create a project first.' }], isError: true };
      }

      const db = getDb();
      const id = generateId();
      db.prepare(
        `INSERT INTO decisions (id, project_id, title, decision, reasoning, alternatives, tags) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        resolved.id,
        title,
        decision,
        reasoning ?? null,
        alternatives ? JSON.stringify(alternatives) : null,
        tags ? JSON.stringify(tags) : null,
      );

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ decision_id: id, message: `Decision logged: "${title}" in ${resolved.name}` }),
        }],
      };
    },
  );

  server.registerTool(
    'list_decisions',
    {
      title: 'List Decisions',
      description: 'List decisions for a project. Filter by tags to find specific decisions.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID'),
        tag: z.string().optional().describe('Filter by tag'),
        limit: z.number().optional().describe('Max number of decisions to return (default: 20)'),
      },
    },
    async ({ project, tag, limit }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: project ? `Project "${project}" not found.` : 'No active projects found.' }], isError: true };
      }

      const db = getDb();
      let sql: string;
      const params: any[] = [resolved.id];

      if (tag) {
        sql = `SELECT * FROM decisions WHERE project_id = ? AND tags LIKE ? ORDER BY created_at DESC LIMIT ?`;
        params.push(`%"${tag}"%`, limit ?? 20);
      } else {
        sql = `SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`;
        params.push(limit ?? 20);
      }

      const rows = db.prepare(sql).all(...params);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ project: resolved.name, decisions: rows }, null, 2) }],
      };
    },
  );
}
