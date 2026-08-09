import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { getDb, generateId, resolveProjectOrDefault, resolveProjectError, resolveRepoPath } from '../db/queries.js';
import { buildSessionText, markSessionStarted } from './auto-session.js';
import { resolveHead, currentBranch } from '../utils/git.js';

// Best-effort snapshot of HEAD sha + branch for a project's repo. Never
// throws — a missing/unconfigured/broken repo just yields null fields, since
// ending a session must never fail because of git.
function captureGitState(projectId: string): { sha: string | null; branch: string | null } {
  const repoPath = resolveRepoPath(projectId);
  if (!repoPath) return { sha: null, branch: null };

  const head = resolveHead(repoPath);
  const branch = currentBranch(repoPath);
  return {
    sha: head.ok ? head.sha : null,
    branch: branch.ok ? branch.branch : null,
  };
}

export function registerSessionTools(server: McpServer): void {
  server.registerTool(
    'start_session',
    {
      title: 'Start Session',
      description:
        'Begin a work session for a project. Returns the full project overview including last session\'s next_steps, active tasks, blockers, and recent decisions. Call this at the start of every conversation. For multi-project conversations, call once per project — after that, pass `project` explicitly on every tool call. IMPORTANT: Always show the kanban_url to the user as a clickable link so they can open the Kanban board.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID'),
      },
    },
    async ({ project }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: resolveProjectError(project) }], isError: true };
      }

      markSessionStarted(resolved.id);
      return {
        content: [{ type: 'text' as const, text: buildSessionText(resolved.id) }],
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
        return { content: [{ type: 'text' as const, text: resolveProjectError(project) }], isError: true };
      }

      const db = getDb();
      const id = generateId();
      const gitState = captureGitState(resolved.id);
      db.prepare(
        `INSERT INTO sessions (id, project_id, summary, tasks_worked_on, decisions_made, next_steps, ended_at, end_git_sha, end_git_branch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        resolved.id,
        summary,
        tasks_worked_on ? JSON.stringify(tasks_worked_on) : null,
        decisions_made ? JSON.stringify(decisions_made) : null,
        next_steps ?? null,
        new Date().toISOString(),
        gitState.sha,
        gitState.branch,
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
