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
import { UI_ACTOR, parseActor } from './lifecycle.js';
import {
  acceptTask, authenticateVerifier, reopenTask, revokeVerifier, setVerificationMode, setVerifierConfig, startVerification,
  verificationMode, verificationSetup,
} from './verification.js';
import { registerTestVerifier, runVerification } from '../test-helpers/verifier.js';

// Verification is opt-in per project (3.1). With it off, a human accepts or
// reopens submitted work straight from needs_verification; with it on, the
// 3.0 gate applies unchanged (verification.test.ts).

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

describe('verification off (the default)', () => {
  it('is off for a new project', () => {
    expect(verificationMode(db(), 'p1')).toBe('off');
  });

  it('accepts low risk from needs_verification with accept_tasks on behalf of a human', async () => {
    const t = await submitted('low');
    const out = await call('accept_tasks', { actor: 'agent:assistant', on_behalf_of: 'human:umit', task_ids: [t.task_id] });
    expect(out).toEqual({ accepted: [t.key], refused: [] });
    expect(status(t.task_id)).toBe('done');
  });

  it('accepts medium and high risk in the UI only', async () => {
    const med = await submitted('medium', 'abcdef1');
    const high = await submitted('high', 'abcdef2');
    const out = await call('accept_tasks', { actor: 'agent:assistant', on_behalf_of: 'human:umit', task_ids: [med.task_id, high.task_id] });
    expect(out.accepted).toEqual([]);
    expect(out.refused.map((r: any) => r.reason)).toEqual([expect.stringMatching(/medium risk.*Kanban UI/), expect.stringMatching(/high risk.*Kanban UI/)]);
    expect((await call('update_task', { task_id: med.task_id, status: 'done', actor: 'human:umit' })).error).toBe('illegal_transition');
    expect(() => acceptTask(db(), high.task_id, parseActor('human:ui')!)).toThrow(/Kanban UI/);

    acceptTask(db(), med.task_id, UI_ACTOR);
    acceptTask(db(), high.task_id, UI_ACTOR);
    expect([status(med.task_id), status(high.task_id)]).toEqual(['done', 'done']);
  });

  it('still refuses an agent accepting work it submitted, or without a human', async () => {
    const t = await submitted('low');
    const own = await call('accept_tasks', { actor: 'agent:cli-a', on_behalf_of: 'human:umit', task_ids: [t.task_id] });
    expect(own.refused).toEqual([{ task_id: t.task_id, reason: expect.stringMatching(/submitted this work/) }]);
    expect((await call('accept_tasks', { actor: 'agent:assistant', task_ids: [t.task_id] })).error).toBe('forbidden');
    expect(status(t.task_id)).toBe('needs_verification');
  });

  it('reopens from needs_verification in the UI only, with findings, using an attempt', async () => {
    const t = await submitted('medium');
    expect(() => reopenTask(db(), t.task_id, 'Wrong index', parseActor('human:umit')!)).toThrow(/Kanban UI/);
    expect(() => reopenTask(db(), t.task_id, ' ', UI_ACTOR)).toThrow(/findings/);
    expect(reopenTask(db(), t.task_id, 'Uses the wrong index', UI_ACTOR)).toEqual({ task_id: t.task_id, status: 'ready' });
    const c = await call('claim_task', { task_id: t.task_id, actor: 'agent:cli-b' });
    expect(c.brief.task.attempts_left).toBe(1);
    expect(c.brief.previous_attempts[0].review_findings).toBe('Uses the wrong index');
  });

  it('hides the task from verifiers, and leaves verified unused', async () => {
    const t = await submitted('low');
    const key = registerTestVerifier(db());
    expect(await call('pending_verifications', { verifier_key: key })).toEqual([]);
    expect((await call('start_verification', { verifier_key: key, task_id: t.task_id })).error).toBe('verification_off');
  });

  it('leaves verifier_checks out of the brief, and lists submitted work as awaiting acceptance', async () => {
    setVerifierConfig(db(), 'p1', { checks: { unit: { command: 'npm test' } } }, UI_ACTOR);
    const low = await submitted('low', 'abcdef1');
    const med = await submitted('medium', 'abcdef2');
    expect(await call('get_task_brief', { task_id: low.task_id })).not.toHaveProperty('verifier_checks');
    const brief = await call('get_session_brief', { project: 'P' });
    expect(brief.awaiting_acceptance.low_risk).toEqual([expect.objectContaining({ key: low.key, risk_level: 'low' })]);
    expect(brief.awaiting_acceptance.needs_ui).toEqual([expect.objectContaining({ key: med.key, risk_level: 'medium' })]);
  });
});

describe('verification on', () => {
  it('refuses a direct accept from needs_verification and lists the task for the verifier', async () => {
    const key = readyToTurnOn();
    setVerificationMode(db(), 'p1', 'on', UI_ACTOR);
    const t = await submitted('low');
    expect((await call('accept_tasks', { actor: 'agent:assistant', on_behalf_of: 'human:umit', task_ids: [t.task_id] })).refused).toHaveLength(1);
    expect(() => acceptTask(db(), t.task_id, UI_ACTOR)).toThrow(/a verifier must verify it/);
    expect(() => reopenTask(db(), t.task_id, 'Nope', UI_ACTOR)).toThrow(/only verified tasks/);
    expect((await call('pending_verifications', { verifier_key: key })).map((p: any) => p.key)).toEqual([t.key]);
    expect((await call('get_task_brief', { task_id: t.task_id })).verifier_checks).toEqual([{ name: 'unit', command: 'npm test' }]);
  });
});

describe('the switch', () => {
  it('is only possible in the UI, and no MCP tool can change it', () => {
    readyToTurnOn();
    expect(() => setVerificationMode(db(), 'p1', 'on', parseActor('human:umit')!)).toThrow(/Kanban UI/);
    expect(() => setVerificationMode(db(), 'p1', 'on', parseActor('agent:cli-a', 'human:umit')!)).toThrow(/Kanban UI/);
    expect(() => setVerificationMode(db(), 'p1', 'on', parseActor('human:ui')!)).toThrow(/Kanban UI/);
    expect(() => setVerificationMode(db(), 'p1', 'maybe', UI_ACTOR)).toThrow(/"on" or "off"/);
    expect(tools.filter(t => /verification_mode|set_verification/.test(t))).toEqual([]);
    expect(verificationMode(db(), 'p1')).toBe('off');
  });

  it('refuses to turn on without a local verifier key and a saved config', () => {
    expect(() => setVerificationMode(db(), 'p1', 'on', UI_ACTOR)).toThrow(/local verifier key.*saved verifier config/);
    seedProject(db(), { id: 'p2', name: 'Other' });
    registerTestVerifier(db(), 'review-only', 'reviewer', ['p1']);
    registerTestVerifier(db(), 'other-project', 'local', ['p2']);
    expect(() => setVerificationMode(db(), 'p1', 'on', UI_ACTOR)).toThrow(/local verifier key/);
    registerTestVerifier(db(), 'local-1', 'local', ['p1']);
    expect(() => setVerificationMode(db(), 'p1', 'on', UI_ACTOR)).toThrow(/saved verifier config/);
    setVerifierConfig(db(), 'p1', { checks: { unit: { command: 'npm test' } } }, UI_ACTOR);
    expect(setVerificationMode(db(), 'p1', 'on', UI_ACTOR)).toEqual({ mode: 'on', missing: [], warning: null });
  });

  it('is logged in project_history with the human actor', () => {
    readyToTurnOn();
    setVerificationMode(db(), 'p1', 'on', UI_ACTOR);
    setVerificationMode(db(), 'p1', 'off', UI_ACTOR);
    setVerificationMode(db(), 'p1', 'off', UI_ACTOR); // no change, no row
    expect(db().prepare('SELECT event, old_value, new_value, actor FROM project_history WHERE project_id = ? ORDER BY rowid').all('p1')).toEqual([
      { event: 'verification_changed', old_value: 'off', new_value: 'on', actor: 'human:ui' },
      { event: 'verification_changed', old_value: 'on', new_value: 'off', actor: 'human:ui' },
    ]);
  });

  it('off -> on: a task already in needs_verification waits for the verifier', async () => {
    const key = readyToTurnOn();
    const t = await submitted('low');
    setVerificationMode(db(), 'p1', 'on', UI_ACTOR);
    expect(() => acceptTask(db(), t.task_id, UI_ACTOR)).toThrow(/a verifier must verify it/);
    expect(runVerification(db(), key, t.task_id).result.task_status).toBe('verified');
    acceptTask(db(), t.task_id, UI_ACTOR);
    expect(status(t.task_id)).toBe('done');
  });

  it('on -> off: needs_verification becomes acceptable, verified stays acceptable, a running run is superseded', async () => {
    const key = readyToTurnOn();
    setVerificationMode(db(), 'p1', 'on', UI_ACTOR);
    const verified = await submitted('low', 'abcdef1');
    runVerification(db(), key, verified.task_id);
    const running = await submitted('low', 'abcdef2');
    const verifier = authenticateVerifier(db(), key);
    const run = startVerification(db(), verifier, running.task_id);
    const waiting = await submitted('medium', 'abcdef3');

    setVerificationMode(db(), 'p1', 'off', UI_ACTOR);
    const out = await call('accept_tasks', { actor: 'agent:assistant', on_behalf_of: 'human:umit', task_ids: [verified.task_id, running.task_id] });
    expect(out).toEqual({ accepted: [verified.key, running.key], refused: [] });
    expect(db().prepare('SELECT status FROM verification_runs WHERE id = ?').get(run.run_id)).toEqual({ status: 'superseded' });
    expect((await call('finish_verification', { verifier_key: key, run_id: run.run_id })).error).toBe('run_ended');
    acceptTask(db(), waiting.task_id, UI_ACTOR);
    expect(status(waiting.task_id)).toBe('done');
  });

  it('revoking the last key leaves it on, with a warning', () => {
    readyToTurnOn();
    setVerificationMode(db(), 'p1', 'on', UI_ACTOR);
    const id = (db().prepare("SELECT id FROM verifiers WHERE name = 'local-1'").get() as { id: string }).id;
    revokeVerifier(db(), id, UI_ACTOR);
    expect(verificationSetup(db(), 'p1')).toEqual({
      mode: 'on', missing: ['a local verifier key that covers this project'], warning: expect.stringMatching(/Verification is on.*turn verification off/),
    });
  });
});
