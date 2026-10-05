import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { getDb } from '../db/queries.js';
import { ACTOR_FORMAT_HINT, parseActor, ToolError } from '../domain/lifecycle.js';
import { acceptTask } from '../domain/verification.js';
import { resolveNeedsHuman } from '../domain/needs-human.js';
import { errorResult, guarded, jsonResult } from './results.js';

const REVIEW_DEPRECATED =
  'review_task is deprecated and will be removed in the next release. A registered verifier (mindpm verify) moves submitted work to verified; ' +
  'low-risk verified work is accepted with accept_tasks, medium and high risk in the Kanban UI.';

export function registerReviewTools(server: McpServer): void {
  server.registerTool(
    'review_task',
    {
      title: 'Review Task (deprecated)',
      description:
        'Deprecated: a verifier now checks submitted work (see `mindpm verify`), and a human accepts it. ' +
        'accept behaves like accept_tasks for one task: only verified, low-risk work, never your own submission. ' +
        'reject is no longer possible here: failed verification returns work to the executor, and a human reopens verified work in the Kanban UI.',
      inputSchema: {
        task_id: z.string(),
        actor: z.string(),
        decision: z.enum(['accept', 'reject']),
        findings: z.string().max(1500).optional(),
        on_behalf_of: z.string().optional().describe('When a human explicitly asked you (an agent) to accept: their id'),
      },
    },
    async ({ task_id, actor, decision, on_behalf_of }) => guarded(() => {
      const who = parseActor(actor, on_behalf_of);
      if (!who) return errorResult('invalid_actor', ACTOR_FORMAT_HINT);
      if (decision === 'reject') throw new ToolError('deprecated', REVIEW_DEPRECATED);
      if (who.kind !== 'human') throw new ToolError('forbidden', `${who.id} cannot accept work. ${REVIEW_DEPRECATED}`);
      const db = getDb();
      const result = db.transaction(() => acceptTask(db, task_id, who)).immediate();
      return jsonResult({ status: result.status, deprecated: REVIEW_DEPRECATED });
    }),
  );

  server.registerTool(
    'resolve_needs_human',
    {
      title: 'Resolve Needs Human',
      description:
        'Human only: answer a task waiting in needs_human. requeue returns it to the queue (granting one more attempt if the budget is spent); ' +
        'cancel ends it; revise_spec sends it to backlog and returns its spec to draft until the revised spec is approved again; ' +
        'reverify hands a submission whose verification kept erroring back to the verifier, once the verifier is fixed.',
      inputSchema: {
        task_id: z.string(),
        actor: z.string(),
        action: z.enum(['requeue', 'cancel', 'revise_spec', 'reverify']),
        note: z.string().min(1).max(1500).describe('The answer or reason. Recorded in the task history'),
        on_behalf_of: z.string().optional().describe("When a human explicitly gave you (an agent) this answer: their id"),
      },
    },
    async ({ task_id, actor, action, note, on_behalf_of }) => guarded(() => {
      const who = parseActor(actor, on_behalf_of);
      if (!who) return errorResult('invalid_actor', ACTOR_FORMAT_HINT);
      const result = resolveNeedsHuman(getDb(), task_id, action, note, who);
      return jsonResult(result);
    }),
  );
}
