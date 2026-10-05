import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb, closeTestDb, getTestDb, seedProject, parseToolResult, createToolCaller } from '../test-helpers/setup.js';

vi.mock('../db/connection.js', () => ({
  getDb: () => getTestDb(),
  closeDb: () => closeTestDb(),
}));

import { registerTaskTools } from '../tools/tasks.js';
import { registerSpecTools } from '../tools/specs.js';
import { registerExecutorTools } from '../tools/executor.js';
import { registerVerifierTools } from '../tools/verifier.js';
import { registerSessionTools } from '../tools/sessions.js';
import { registerProjectTools } from '../tools/projects.js';
import { registerReviewTools } from '../tools/review.js';
import { newConnectionForTests } from '../utils/session-state.js';
import { UI_ACTOR, parseActor } from './lifecycle.js';
import {
  acceptTask, authenticateVerifier, reopenTask, revokeVerifier, setVerificationMode, setVerifierConfig, startVerification,
  verificationMode, verificationSetup,
} from './verification.js';
import { registerTestVerifier, runVerification } from '../test-helpers/verifier.js';

// An executor must never accept its own work. Actor ids are declared, so the
// server ties each submission to the connection (MCP client process) it came
// from and refuses acceptance from that connection under any actor.

let callTool: ReturnType<typeof createToolCaller>;
let tools: string[];
const call = async (name: string, args: Record<string, unknown>) => parseToolResult(await callTool(name, args));
const db = () => getTestDb();
const status = (id: string) => (db().prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }).status;

beforeEach(() => {
  createTestDb();
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerTaskTools(server);
  registerSpecTools(server);
  registerExecutorTools(server);
  registerVerifierTools(server);
  registerSessionTools(server);
  registerProjectTools(server);
  registerReviewTools(server);
  callTool = createToolCaller(server);
  tools = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  seedProject(db(), { id: 'p1', name: 'P' });
  db().prepare(`UPDATE projects SET slug = 'p' WHERE id = 'p1'`).run();
});

afterEach(() => closeTestDb());

const CRITERIA = [{ statement: 'Closes after 30 min', verify_kind: 'test', verify_ref: 'InactivityTimeoutTests.ClosesAfterThirtyMinutes' }];

// A task submitted by agent:cli-a at the given risk level.
async function submitted(risk: 'low' | 'medium' | 'high', sha = 'abcdef1') {
  const s = await call('create_spec', {
    project: 'P', actor: 'agent:architect', title: `A ${risk} change`, objective: 'Close idle conversations.',
    why: 'Idle conversations hold capacity.', risk_level: risk, criteria: CRITERIA,
  });
  const t = await call('create_task', { project: 'P', title: `${risk} task`, spec_id: s.key });
  await call('approve_spec', { spec_id: s.key, project: 'P', actor: 'human:umit' });
  const claim = await call('claim_task', { task_id: t.task_id, actor: 'agent:cli-a' });
  const out = await call('submit_task', {
    claim_token: claim.claim_token, branch: 'feature/x', head_sha: sha, files_touched: ['src/a.ts'], summary: 'Done.',
    criteria_results: claim.brief.criteria.map((c: any) => ({ criterion_id: c.key, result: 'pass', evidence: 'test passed' })),
  });
  expect(out).toEqual({ status: 'needs_verification' });
  return t as { task_id: string; key: string };
}

function readyToTurnOn() {
  setVerifierConfig(db(), 'p1', { checks: { unit: { command: 'npm test' } } }, UI_ACTOR);
  return registerTestVerifier(db(), 'local-1', 'local', ['p1']);
}


describe('an executor accepting its own work', () => {
  // Every way the submitting session might name itself. Actor ids are
  // declared, so only the connection tells them apart.
  const routes: [string, string, Record<string, unknown>][] = [
    ['accept_tasks as itself', 'accept_tasks', { actor: 'agent:cli-a' }],
    ['accept_tasks as itself for a human', 'accept_tasks', { actor: 'agent:cli-a', on_behalf_of: 'human:umit' }],
    ['accept_tasks under another agent id for a human', 'accept_tasks', { actor: 'agent:assistant', on_behalf_of: 'human:umit' }],
    ['accept_tasks declaring a human', 'accept_tasks', { actor: 'human:umit' }],
    ['update_task to done as itself', 'update_task', { actor: 'agent:cli-a', status: 'done' }],
    ['update_task to done under another agent id for a human', 'update_task', { actor: 'agent:assistant', on_behalf_of: 'human:umit', status: 'done' }],
    ['update_task to done declaring a human', 'update_task', { actor: 'human:umit', status: 'done' }],
    ['review_task accept under another agent id for a human', 'review_task', { actor: 'agent:assistant', on_behalf_of: 'human:umit', decision: 'accept' }],
  ];

  async function submittedIn(mode: 'off' | 'on') {
    const t = await submitted('low');
    if (mode === 'on') {
      const key = readyToTurnOn();
      setVerificationMode(db(), 'p1', 'on', UI_ACTOR);
      runVerification(db(), key, t.key);
    }
    return t;
  }

  for (const mode of ['off', 'on'] as const) {
    const waiting = mode === 'off' ? 'needs_verification' : 'verified';
    for (const [label, tool, args] of routes) {
      it(`refuses ${label} from the submitting session (verification ${mode})`, async () => {
        const t = await submittedIn(mode);
        const ids = tool === 'accept_tasks' ? { task_ids: [t.key] } : { task_id: t.key };
        await call(tool, { ...ids, ...args });
        expect(status(t.task_id)).toBe(waiting);
      });
    }

    it(`lets another session accept on a human's behalf (verification ${mode})`, async () => {
      const t = await submittedIn(mode);
      newConnectionForTests();
      expect(await call('accept_tasks', { actor: 'agent:assistant', on_behalf_of: 'human:umit', task_ids: [t.key] }))
        .toEqual({ accepted: [t.key], refused: [] });
      expect(status(t.task_id)).toBe('done');
    });

    it(`lets the Kanban UI accept, though it shares the process (verification ${mode})`, async () => {
      const t = await submittedIn(mode);
      acceptTask(db(), t.key, UI_ACTOR);
      expect(status(t.task_id)).toBe('done');
    });
  }

  it('says why, and where to accept instead', async () => {
    const t = await submittedIn('off');
    expect(await call('accept_tasks', { actor: 'human:umit', task_ids: [t.key] })).toEqual({
      accepted: [],
      refused: [{ task_id: t.key, reason: expect.stringMatching(/submitted from this session.*Kanban UI or from another session/) }],
    });
  });

  it('leaves submissions from before 3.2 (no recorded connection) to the actor checks', async () => {
    const t = await submittedIn('off');
    db().prepare('UPDATE attempts SET submitted_from = NULL').run();
    expect(await call('accept_tasks', { actor: 'agent:assistant', on_behalf_of: 'human:umit', task_ids: [t.key] }))
      .toMatchObject({ accepted: [t.key] });
  });
});
