import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { getDb, generateId, resolveProjectOrDefault, resolveProjectError } from '../db/queries.js';
import { maybeAutoSession } from './auto-session.js';
import { ToolError } from '../domain/lifecycle.js';
import { resolveSpec, specKey } from '../domain/specs.js';
import { guarded } from './results.js';

export function registerDecisionTools(server: McpServer): void {
  server.registerTool(
    'log_decision',
    {
      title: 'Log Decision',
      description:
        'Record a decision with reasoning and alternatives considered. Proactively use this when the user makes a technical decision, chooses between options, or settles a debate.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID'),
        task_id: z.string().optional().describe('Task ID to associate this decision with (omit for project-level)'),
        title: z.string().describe('Short title for the decision'),
        decision: z.string().describe('What was decided'),
        reasoning: z.string().optional().describe('Why this was decided'),
        alternatives: z.array(z.string()).optional().describe('Rejected alternatives'),
        tags: z.array(z.string()).optional().describe('Tags like "architecture", "database", "api"'),
        spec_id: z.string().optional().describe('Spec this decision shaped (id or key like "SPEC-12"). Linked decisions appear in task briefs'),
        supersedes: z.string().optional().describe('Decision id this one replaces. The old one is marked superseded and never appears in a brief'),
      },
    },
    async ({ project, task_id, title, decision, reasoning, alternatives, tags, spec_id, supersedes }) => guarded(() => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: resolveProjectError(project) }], isError: true };
      }

      const db = getDb();
      const spec = spec_id ? resolveSpec(db, spec_id, resolved.id) : null;
      if (spec && spec.project_id !== resolved.id) throw new ToolError('invalid_spec', `${specKey(spec)} belongs to a different project.`);
      if (supersedes) {
        const old = db.prepare('SELECT project_id, status FROM decisions WHERE id = ?').get(supersedes) as { project_id: string; status: string } | undefined;
        if (!old || old.project_id !== resolved.id) throw new ToolError('not_found', `Decision "${supersedes}" not found in ${resolved.name}.`);
        if (old.status === 'superseded') throw new ToolError('invalid_state', `Decision "${supersedes}" is already superseded.`);
      }

      const id = generateId();
      db.transaction(() => {
        db.prepare(
          `INSERT INTO decisions (id, project_id, task_id, title, decision, reasoning, alternatives, tags, spec_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          resolved.id,
          task_id ?? null,
          title,
          decision,
          reasoning ?? null,
          alternatives ? JSON.stringify(alternatives) : null,
          tags ? JSON.stringify(tags) : null,
          spec?.id ?? null,
        );
        if (supersedes) {
          db.prepare("UPDATE decisions SET status = 'superseded', superseded_by = ? WHERE id = ?").run(id, supersedes);
        }
      }).immediate();

      const scope = task_id ? `task ${task_id} in ${resolved.name}` : resolved.name;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            decision_id: id,
            message: `Decision logged: "${title}" in ${scope}`,
            ...(spec ? { spec_key: specKey(spec) } : {}),
            ...(supersedes ? { superseded: supersedes } : {}),
          }),
        }],
      };
    }),
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
        return { content: [{ type: 'text' as const, text: resolveProjectError(project) }], isError: true };
      }

      const sessionPreamble = maybeAutoSession(resolved.id);
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

      const resultText = JSON.stringify({ project: resolved.name, decisions: rows }, null, 2);
      return {
        content: [{ type: 'text' as const, text: sessionPreamble ? `${sessionPreamble}\n\n---\n\n${resultText}` : resultText }],
      };
    },
  );
}
