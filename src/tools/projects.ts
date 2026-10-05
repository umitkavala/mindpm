import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { getDb, generateId, resolveProjectId, resolveProjectOrDefault, resolveProjectError, validateRepoPath } from '../db/queries.js';
import { generateSlug } from '../utils/ids.js';
import { maybeAutoSession } from './auto-session.js';

const VERIFICATION = z.record(z.string(), z.string())
  .describe('Verification commands keyed by kind, e.g. {"build": "dotnet build", "unit": "dotnet test tests/unit"}');

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    'create_project',
    {
      title: 'Create Project',
      description:
        'Create a new project to track. Use this when starting a new project or when a user mentions a project that doesn\'t exist yet.',
      inputSchema: {
        name: z.string().describe('Project name (unique)'),
        description: z.string().optional().describe('What this project is about'),
        tech_stack: z.array(z.string()).optional().describe('Technologies used, e.g. ["FastAPI", "React", "PostgreSQL"]'),
        repo_path: z.string().optional().describe('Path to the project repository'),
        conventions: z.string().optional().describe('Short coding conventions, included in every task brief'),
        verification_defaults: VERIFICATION.optional(),
      },
    },
    async ({ name, description, tech_stack, repo_path, conventions, verification_defaults }) => {
      if (repo_path) {
        const validation = validateRepoPath(repo_path);
        if (!validation.ok) {
          return { content: [{ type: 'text' as const, text: validation.reason }], isError: true };
        }
      }

      const db = getDb();
      const id = generateId();
      // Generate unique slug
      let slug = generateSlug(name);
      const existing = db.prepare('SELECT slug FROM projects WHERE slug LIKE ?').all(`${slug}%`) as { slug: string }[];
      const usedSlugs = new Set(existing.map(r => r.slug));
      let candidate = slug;
      let n = 2;
      while (usedSlugs.has(candidate)) candidate = slug + n++;
      slug = candidate;

      try {
        db.prepare(
          `INSERT INTO projects (id, name, slug, description, tech_stack, repo_path, conventions, verification_defaults) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id, name, slug, description ?? null, tech_stack ? JSON.stringify(tech_stack) : null, repo_path ?? null,
          conventions ?? null, verification_defaults ? JSON.stringify(verification_defaults) : null,
        );
      } catch (e: any) {
        if (e.message?.includes('UNIQUE constraint failed')) {
          return { content: [{ type: 'text' as const, text: `Project "${name}" already exists.` }], isError: true };
        }
        throw e;
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ project_id: id, message: `Project created: "${name}"` }) }],
      };
    },
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List Projects',
      description: 'List all tracked projects. Filter by status to see active, paused, completed, or archived projects.',
      inputSchema: {
        status: z
          .enum(['active', 'paused', 'completed', 'archived'])
          .optional()
          .describe('Filter by project status'),
      },
    },
    async ({ status }) => {
      const db = getDb();
      let rows;
      if (status) {
        rows = db.prepare('SELECT * FROM projects WHERE status = ? ORDER BY updated_at DESC').all(status);
      } else {
        rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }],
      };
    },
  );

  server.registerTool(
    'get_project_status',
    {
      title: 'Get Project Status',
      description:
        'Get a full overview of a project: active tasks, recent decisions, blockers, and last session summary. Great for getting up to speed.',
      inputSchema: {
        project: z.string().describe('Project name or ID'),
      },
    },
    async ({ project }) => {
      const db = getDb();
      const projectId = resolveProjectId(project);
      if (!projectId) {
        return { content: [{ type: 'text' as const, text: `Project "${project}" not found.` }], isError: true };
      }

      const sessionPreamble = maybeAutoSession(projectId);
      const projectRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);

      const activeTasks = db
        .prepare("SELECT id, title, status, priority, tags FROM tasks WHERE project_id = ? AND status NOT IN ('done', 'cancelled') ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END")
        .all(projectId);

      const blockedTasks = db
        .prepare("SELECT id, title, blocked_by FROM tasks WHERE project_id = ? AND status = 'blocked'")
        .all(projectId);

      const recentDecisions = db
        .prepare('SELECT id, title, decision, created_at FROM decisions WHERE project_id = ? ORDER BY created_at DESC LIMIT 5')
        .all(projectId);

      const lastSession = db
        .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(projectId);

      const taskCounts = db
        .prepare('SELECT status, COUNT(*) as count FROM tasks WHERE project_id = ? GROUP BY status')
        .all(projectId);

      const result = {
        project: projectRow,
        task_summary: taskCounts,
        active_tasks: activeTasks,
        blocked_tasks: blockedTasks,
        recent_decisions: recentDecisions,
        last_session: lastSession,
      };

      const resultText = JSON.stringify(result, null, 2);
      return {
        content: [{ type: 'text' as const, text: sessionPreamble ? `${sessionPreamble}\n\n---\n\n${resultText}` : resultText }],
      };
    },
  );

  server.registerTool(
    'set_project_repo_path',
    {
      title: 'Set Project Repo Path',
      description:
        'Set or update the local git repository path for a project. Required for the session brief to include git activity (commits, branch, working-tree state) since the last session.',
      inputSchema: {
        project: z.string().describe('Project name or ID'),
        repo_path: z.string().describe('Absolute path to the project repository (must contain a .git directory)'),
      },
    },
    async ({ project, repo_path }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: resolveProjectError(project) }], isError: true };
      }

      const validation = validateRepoPath(repo_path);
      if (!validation.ok) {
        return { content: [{ type: 'text' as const, text: validation.reason }], isError: true };
      }

      const db = getDb();
      db.prepare('UPDATE projects SET repo_path = ? WHERE id = ?').run(repo_path, resolved.id);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ project_id: resolved.id, repo_path, message: `Repo path set for "${resolved.name}"` }),
        }],
      };
    },
  );

  server.registerTool(
    'set_execution_defaults',
    {
      title: 'Set Execution Defaults',
      description:
        'Set the coding conventions and verification commands (build, unit, integration, lint) that go into every task brief for this project. ' +
        'Tasks can override individual commands with their own verification. These are hints for the executor: the verifier never runs them. ' +
        'It runs only the checks a human configures in the Kanban UI (Verifiers tab), which the brief lists as verifier_checks.',
      inputSchema: {
        project: z.string().describe('Project name or ID'),
        conventions: z.string().optional().describe('Short coding conventions'),
        verification_defaults: VERIFICATION.optional(),
      },
    },
    async ({ project, conventions, verification_defaults }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: resolveProjectError(project) }], isError: true };
      }
      if (conventions === undefined && verification_defaults === undefined) {
        return { content: [{ type: 'text' as const, text: 'Nothing to set: pass conventions and/or verification_defaults.' }], isError: true };
      }
      const db = getDb();
      if (conventions !== undefined) db.prepare('UPDATE projects SET conventions = ? WHERE id = ?').run(conventions, resolved.id);
      if (verification_defaults !== undefined) {
        db.prepare('UPDATE projects SET verification_defaults = ? WHERE id = ?').run(JSON.stringify(verification_defaults), resolved.id);
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ project_id: resolved.id, message: `Execution defaults set for "${resolved.name}"` }) }],
      };
    },
  );
}
