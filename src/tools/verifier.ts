import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { getDb, resolveProjectId } from '../db/queries.js';
import { ACTOR_FORMAT_HINT, parseActor, ToolError } from '../domain/lifecycle.js';
import {
  acceptTasks, authenticateVerifier, finishVerification, pendingVerifications, recordChecks, recordCriteria, startVerification,
} from '../domain/verification.js';
import { errorResult, guarded, jsonResult } from './results.js';

const KEY = z.string().describe('Your verifier key (MINDPM_VERIFIER_KEY or MINDPM_REVIEWER_KEY). Never pass it to an executor');
const SHA = z.string().regex(/^[0-9a-f]{7,40}$/i, 'head_sha must be a 7 to 40 character hex commit SHA')
  .describe('The commit these results are for. Rejected unless it is the run\'s head_sha');

export function registerVerifierTools(server: McpServer): void {
  server.registerTool(
    'pending_verifications',
    {
      title: 'Pending Verifications',
      description:
        'Verifier: tasks in needs_verification with a submitted commit and no run in progress, in projects your key covers, oldest submission first.',
      inputSchema: {
        verifier_key: KEY,
        project: z.string().optional().describe('Project name or ID'),
      },
    },
    async ({ verifier_key, project }) => guarded(() => {
      const db = getDb();
      const verifier = authenticateVerifier(db, verifier_key);
      const projectId = project ? resolveProjectId(project) : undefined;
      if (project && !projectId) throw new ToolError('not_found', `Project "${project}" not found.`);
      return jsonResult(pendingVerifications(db, verifier, projectId ?? undefined));
    }),
  );

  server.registerTool(
    'start_verification',
    {
      title: 'Start Verification',
      description:
        'Local verifier: open a run on a task\'s submitted head_sha. Returns the run id, the SHA to check out, the checks to run and the criteria to judge. ' +
        'The run lease is 30 minutes; every record_* call extends it. Check out exactly head_sha in a clean worktree, never the executor\'s working tree.',
      inputSchema: {
        verifier_key: KEY,
        task_id: z.string().describe('Task id or key'),
      },
    },
    async ({ verifier_key, task_id }) => guarded(() => {
      const db = getDb();
      return jsonResult(startVerification(db, authenticateVerifier(db, verifier_key), task_id));
    }),
  );

  server.registerTool(
    'record_checks',
    {
      title: 'Record Checks',
      description: 'Local verifier: record what was executed in the run. Re-recording a check name replaces it.',
      inputSchema: {
        verifier_key: KEY,
        run_id: z.string(),
        head_sha: SHA.optional(),
        checks: z.array(z.object({
          name: z.string().min(1).describe('build, unit, integration, lint, ...'),
          command: z.string().min(1),
          exit_code: z.number().int().nullable(),
          duration_ms: z.number().int().nonnegative().optional(),
          output_tail: z.string().optional().describe('The end of the output; trimmed to 4000 characters'),
          report: z.unknown().optional().describe('Parsed test report summary'),
        })).min(1),
      },
    },
    async ({ verifier_key, run_id, head_sha, checks }) => guarded(() => {
      const db = getDb();
      return jsonResult(recordChecks(db, authenticateVerifier(db, verifier_key), run_id, checks, head_sha));
    }),
  );

  server.registerTool(
    'record_criteria',
    {
      title: 'Record Criteria',
      description:
        'Verifier: record a result and evidence for acceptance criteria. test and command criteria need a local key, review criteria a reviewer key. ' +
        'A criterion passes only on positive evidence: a skipped or unmatched test is missing.',
      inputSchema: {
        verifier_key: KEY,
        run_id: z.string(),
        head_sha: SHA.optional(),
        results: z.array(z.object({
          criterion_id: z.string().describe('Criterion id or key like "AC-12.1"'),
          result: z.enum(['pass', 'fail', 'missing']),
          evidence: z.string().min(1).max(1500).describe('Test id and outcome, command and exit code, or a rationale citing files or lines'),
        })).min(1),
      },
    },
    async ({ verifier_key, run_id, head_sha, results }) => guarded(() => {
      const db = getDb();
      return jsonResult(recordCriteria(db, authenticateVerifier(db, verifier_key), run_id, results, head_sha));
    }),
  );

  server.registerTool(
    'finish_verification',
    {
      title: 'Finish Verification',
      description:
        'Local verifier: end the run. The server computes the outcome: passed only if every check exited 0 and every criterion is pass (task → verified); ' +
        'otherwise failed (task → ready with findings, attempt used). Pass error_reason when the check itself broke (checkout, timeout, missing report): ' +
        'the task stays in needs_verification and no attempt is used.',
      inputSchema: {
        verifier_key: KEY,
        run_id: z.string(),
        error_reason: z.string().max(600).optional(),
        environment: z.record(z.string(), z.unknown()).optional().describe('os, runtime versions'),
      },
    },
    async ({ verifier_key, run_id, error_reason, environment }) => guarded(() => {
      const db = getDb();
      return jsonResult(finishVerification(db, authenticateVerifier(db, verifier_key), run_id, { errorReason: error_reason, environment }));
    }),
  );

  server.registerTool(
    'accept_tasks',
    {
      title: 'Accept Tasks',
      description:
        'Move low-risk verified tasks to done, only when the user explicitly asked: act as yourself with on_behalf_of: "human:<their name>". ' +
        'Medium and high risk are refused: they are accepted in the Kanban UI only. You cannot accept work you submitted. Each task is accepted or refused on its own.',
      inputSchema: {
        actor: z.string().describe('Your own agent id, e.g. agent:assistant'),
        on_behalf_of: z.string().optional().describe('The human who asked, e.g. human:umit'),
        task_ids: z.array(z.string()).min(1).describe('Task ids or keys'),
      },
    },
    async ({ actor, on_behalf_of, task_ids }) => guarded(() => {
      const who = parseActor(actor, on_behalf_of);
      if (!who) return errorResult('invalid_actor', ACTOR_FORMAT_HINT);
      if (who.kind !== 'human') throw new ToolError('forbidden', `${who.id} cannot accept work. Pass on_behalf_of with the human who asked.`);
      return jsonResult(acceptTasks(getDb(), task_ids, who));
    }),
  );
}
