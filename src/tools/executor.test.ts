import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createTestDb, closeTestDb, getTestDb, seedProject, seedTask, parseToolResult, createToolCaller,
} from '../test-helpers/setup.js';

vi.mock('../db/connection.js', () => ({
  getDb: () => getTestDb(),
  closeDb: () => closeTestDb(),
}));

import { registerTaskTools } from './tasks.js';
import { registerSpecTools } from './specs.js';
import { registerDecisionTools } from './decisions.js';
import { registerExecutorTools } from './executor.js';
import { registerReviewTools } from './review.js';
import { registerVerifierTools } from './verifier.js';
import { BRIEF_TOKEN_BUDGET, estimateTokens } from '../domain/brief.js';
import { changeStatusAsHuman } from '../domain/status-change.js';
import { UI_ACTOR } from '../domain/lifecycle.js';
import { acceptTask } from '../domain/verification.js';
import { registerTestVerifier, runVerification } from '../test-helpers/verifier.js';

let callTool: ReturnType<typeof createToolCaller>;

beforeEach(() => {
  createTestDb();
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerTaskTools(server);
  registerSpecTools(server);
  registerDecisionTools(server);
  registerExecutorTools(server);
  registerReviewTools(server);
  registerVerifierTools(server);
  callTool = createToolCaller(server);
  const db = getTestDb();
  seedProject(db, { id: 'p1', name: 'P', tech_stack: 'C#, .NET 9, PostgreSQL' });
  db.prepare(
    `UPDATE projects SET slug = 'p', conventions = 'Async all the way down.',
     verification_defaults = '{"build":"dotnet build","unit":"dotnet test tests/unit"}' WHERE id = 'p1'`,
  ).run();
});

afterEach(() => {
  closeTestDb();
});

const call = async (name: string, args: Record<string, unknown>) => parseToolResult(await callTool(name, args));
const status = (id: string) => (getTestDb().prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }).status;
const expireLease = (taskId: string) =>
  getTestDb().prepare("UPDATE tasks SET lease_expires_at = datetime('now', '-1 minute') WHERE id = ?").run(taskId);

const SPEC = {
  project: 'P',
  actor: 'agent:architect',
  title: 'Conversation inactivity timeout',
  objective: 'Close conversations after 30 minutes of inactivity.',
  why: 'Idle conversations hold agent capacity and skew handling-time reports.',
  approach: 'Scheduled sweep plus last-activity timestamp; no per-conversation timers.',
  risk_level: 'medium',
  criteria: [
    { statement: 'Closes after 30 min with no activity', verify_kind: 'test', verify_ref: 'InactivityTimeoutTests.ClosesAfterThirtyMinutes' },
    { statement: 'Never closes a conversation an agent is handling', verify_kind: 'test', verify_ref: 'InactivityTimeoutTests.SkipsActiveHandling' },
  ],
};

async function readyTask(spec: Partial<typeof SPEC> = {}, task: Record<string, unknown> = {}) {
  const s = await call('create_spec', { ...SPEC, ...spec });
  const t = await call('create_task', {
    project: 'P', title: 'Implement inactivity timeout', priority: 'high', spec_id: s.key,
    branch: 'feature/p-1-inactivity-timeout', ...task,
  });
  await call('approve_spec', { spec_id: s.key, project: 'P', actor: 'human:umit' });
  return { spec: s, task: t };
}

const passAll = (claim: any) => claim.brief.criteria.map((c: any) => ({ criterion_id: c.key, result: 'pass', evidence: `${c.verify_ref} passed` }));
const submit = (claim: any, extra: Record<string, unknown> = {}) => call('submit_task', {
  claim_token: claim.claim_token, branch: 'feature/p-1-inactivity-timeout', head_sha: 'a1b2c3d4e5f6',
  files_touched: ['src/Sweep.cs'], summary: 'Sweep closes idle conversations.', criteria_results: passAll(claim), ...extra,
});

describe('executor flow from the Phase 1 doc', () => {
  it('fails once on a deadlock, then succeeds using what the first attempt recorded', async () => {
    const { task } = await readyTask();
    expect(status(task.task_id)).toBe('ready');

    // A picks and claims.
    const picked = await call('pick_task', { project: 'P', actor: 'agent:cli-a' });
    expect(picked).toMatchObject({ task_id: task.task_id, key: 'p-1', spec_key: 'SPEC-1', risk_level: 'medium' });
    const a = await call('claim_task', { task_id: picked.task_id, actor: 'agent:cli-a' });
    expect(a.attempt_no).toBe(1);
    expect(a.brief.task).toMatchObject({ key: 'p-1', attempt_no: 1, attempts_left: 2, branch: 'feature/p-1-inactivity-timeout' });
    expect(a.brief.spec).toMatchObject({ key: 'SPEC-1', version: 1, risk_level: 'medium' });
    expect(a.brief.criteria.map((c: any) => c.key)).toEqual(['AC-1.1', 'AC-1.2']);
    expect(a.brief.verification).toEqual({ build: 'dotnet build', unit: 'dotnet test tests/unit' });
    expect(a.brief.project.conventions).toBe('Async all the way down.');
    expect(status(task.task_id)).toBe('claimed');

    expect((await call('heartbeat', { claim_token: a.claim_token, phase: 'implementing' })).spec_changed).toBe(false);
    await call('heartbeat', { claim_token: a.claim_token, phase: 'testing' });
    const phases = getTestDb().prepare("SELECT new_value FROM task_history WHERE task_id = ? AND event = 'phase' ORDER BY rowid").all(task.task_id);
    expect(phases).toEqual([{ new_value: 'implementing' }, { new_value: 'testing' }]);

    // A fails on a deadlock.
    const failed = await call('report_failure', {
      claim_token: a.claim_token, failure_type: 'test_failure',
      root_cause: 'Deadlock in ConversationRepository when sweep and message handler update status concurrently',
      notes: 'Row lock ordering differs between paths. Avoid SELECT then UPDATE; use a single conditional UPDATE.',
    });
    expect(failed).toEqual({ status: 'ready', attempts_left: 2 });

    // B claims and sees attempt 1's root cause.
    const b = await call('claim_task', { task_id: 'p-1', actor: 'agent:cli-b' });
    expect(b.attempt_no).toBe(2);
    expect(b.brief.task.attempts_left).toBe(1);
    expect(b.brief.previous_attempts).toEqual([expect.objectContaining({
      attempt_no: 1, outcome: 'failed', failure_type: 'test_failure',
      notes: expect.stringContaining('single conditional UPDATE'),
    })]);

    expect(await submit(b)).toEqual({ status: 'needs_verification' });

    // Nobody accepts unverified work; after a verifier passes it, medium risk is accepted in the UI only.
    expect((await call('review_task', { task_id: 'p-1', actor: 'agent:reviewer', decision: 'accept' })).error).toBe('forbidden');
    expect((await call('review_task', { task_id: 'p-1', actor: 'agent:cli-b', decision: 'accept' })).error).toBe('forbidden');
    expect((await call('review_task', { task_id: 'p-1', actor: 'human:umit', decision: 'accept' })).error).toBe('illegal_transition');
    expect(runVerification(getTestDb(), registerTestVerifier(getTestDb()), 'p-1').result).toEqual({ run_status: 'passed', task_status: 'verified' });
    expect((await call('accept_tasks', { actor: 'agent:assistant', on_behalf_of: 'human:umit', task_ids: ['p-1'] })).refused).toHaveLength(1);
    acceptTask(getTestDb(), 'p-1', UI_ACTOR);
    expect(status(task.task_id)).toBe('done');

    const attempt = getTestDb().prepare('SELECT * FROM attempts WHERE task_id = ? AND attempt_no = 2').get(task.task_id) as any;
    expect(attempt).toMatchObject({ outcome: 'submitted', head_sha: 'a1b2c3d4e5f6', verification_outcome: 'passed' });
    expect(JSON.parse(attempt.criteria_results).map((r: any) => r.key)).toEqual(['AC-1.1', 'AC-1.2']);
  });

  it('escalates an ambiguous spec and is answered with revise_spec', async () => {
    const { task } = await readyTask();
    const b = await call('claim_task', { task_id: task.task_id, actor: 'agent:cli-b' });
    const out = await call('escalate', {
      claim_token: b.claim_token,
      question: 'Does "handling" include a conversation waiting on a customer reply?',
      options: ['Yes', 'No'],
    });
    expect(out.status).toBe('needs_human');

    expect((await call('resolve_needs_human', { task_id: task.task_id, actor: 'agent:architect', action: 'requeue', note: 'x' })).error).toBe('forbidden');
    const resolved = await call('resolve_needs_human', { task_id: task.task_id, actor: 'human:umit', action: 'revise_spec', note: 'Waiting counts as handling.' });
    expect(resolved.status).toBe('backlog');
    expect(resolved.attempts_left).toBe(3); // escalation doesn't use an attempt
    expect((await call('get_spec', { spec_id: 'SPEC-1' })).status).toBe('draft');

    await call('update_spec', {
      spec_id: 'SPEC-1', actor: 'agent:architect', expected_version: 1,
      criteria_upsert: [{ seq: 2, statement: 'Never closes a handled or waiting conversation', verify_kind: 'test', verify_ref: 'T.SkipsWaiting' }],
    });
    const approved = await call('approve_spec', { spec_id: 'SPEC-1', actor: 'human:umit' });
    expect(approved.version).toBe(2);
    expect(approved.tasks_made_ready).toEqual(['p-1']);

    const brief = await call('get_task_brief', { task_id: 'p-1' });
    expect(brief.previous_attempts[0].escalation.question).toMatch(/waiting on a customer reply/);
    expect(brief.criteria[1].statement).toBe('Never closes a handled or waiting conversation');
  });
});

describe('claims and leases', () => {
  it('lets exactly one of two racing claims win', async () => {
    const { task } = await readyTask();
    const results = await Promise.all([
      call('claim_task', { task_id: task.task_id, actor: 'agent:cli-a' }),
      call('claim_task', { task_id: task.task_id, actor: 'agent:cli-b' }),
    ]);
    expect(results.filter(r => r.claim_token)).toHaveLength(1);
    expect(results.filter(r => r.error === 'already_claimed')).toHaveLength(1);
    expect((getTestDb().prepare('SELECT COUNT(*) AS n FROM attempts').get() as any).n).toBe(1);
  });

  it('expires a lapsed lease lazily, counts it, and fences out the stale agent', async () => {
    const { task } = await readyTask();
    const a = await call('claim_task', { task_id: task.task_id, actor: 'agent:cli-a' });
    expireLease(task.task_id);

    expect((await call('heartbeat', { claim_token: a.claim_token })).error).toBe('lease_expired');
    expect(status(task.task_id)).toBe('ready');
    const attempt = getTestDb().prepare('SELECT outcome FROM attempts WHERE claim_token = ?').get(a.claim_token) as any;
    expect(attempt.outcome).toBe('expired');

    const b = await call('claim_task', { task_id: task.task_id, actor: 'agent:cli-b' });
    expect(b.brief.task.attempts_left).toBe(1);
    // The stale agent can't write over the new attempt.
    expect((await submit(a)).error).toBe('lease_expired');
    expect((await call('release_task', { claim_token: a.claim_token, reason: 'late' })).error).toBe('lease_expired');
    expect(status(task.task_id)).toBe('claimed');
    expect((await call('heartbeat', { claim_token: 'not-a-token' })).error).toBe('invalid_token');
  });

  it('expires leases on plain reads too', async () => {
    const { task } = await readyTask();
    await call('claim_task', { task_id: task.task_id, actor: 'agent:cli-a' });
    expireLease(task.task_id);
    await call('get_task_brief', { task_id: task.task_id });
    expect(status(task.task_id)).toBe('ready');
  });

  it('heartbeat extends the lease by its original length', async () => {
    const { task } = await readyTask();
    const a = await call('claim_task', { task_id: task.task_id, actor: 'agent:cli-a', lease_minutes: 10 });
    getTestDb().prepare("UPDATE tasks SET lease_expires_at = datetime('now', '+1 minute') WHERE id = ?").run(task.task_id);
    const hb = await call('heartbeat', { claim_token: a.claim_token });
    const minutes = (Date.parse(hb.lease_expires_at + 'Z') - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10.1);
  });

  it('never exposes claim tokens through get_task or list_tasks', async () => {
    const { task } = await readyTask();
    const a = await call('claim_task', { task_id: task.task_id, actor: 'agent:cli-a' });
    const got = await callTool('get_task', { task_id: task.task_id });
    const listed = await callTool('list_tasks', { project: 'P' });
    expect(got.content[0].text).not.toContain(a.claim_token);
    expect(listed.content[0].text).not.toContain(a.claim_token);
  });

  it('refuses claims that are not allowed', async () => {
    const s = await call('create_spec', SPEC);
    const draft = await call('create_task', { project: 'P', title: 'Draft-spec task', spec_id: s.key });
    getTestDb().prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(draft.task_id);
    expect((await call('claim_task', { task_id: draft.task_id, actor: 'agent:cli-a' })).error).toBe('spec_not_approved');

    seedTask(getTestDb(), 'p1', { id: 'dep' });
    seedTask(getTestDb(), 'p1', { id: 'waits', blocked_by: '["dep"]' });
    expect((await call('claim_task', { task_id: 'waits', actor: 'agent:cli-a' })).error).toBe('blocked');
    seedTask(getTestDb(), 'p1', { id: 'bk', status: 'backlog' });
    expect((await call('claim_task', { task_id: 'bk', actor: 'agent:cli-a' })).error).toBe('not_ready');
    expect((await call('claim_task', { task_id: 'dep', actor: 'agent:reviewer' })).error).toBe('forbidden');
  });
});

describe('spec changes mid-claim', () => {
  it('heartbeat reports spec_changed after the spec is revised and re-approved', async () => {
    // Two tasks on one spec: A works on one while the other escalates a spec gap.
    const { spec } = await readyTask();
    const sibling = await call('create_task', { project: 'P', title: 'Sibling', spec_id: spec.key });
    const a = await call('claim_task', { task_id: 'p-1', actor: 'agent:cli-a' });
    const b = await call('claim_task', { task_id: sibling.task_id, actor: 'agent:cli-b' });
    await call('escalate', { claim_token: b.claim_token, question: 'Ambiguous AC-1.2' });
    await call('resolve_needs_human', { task_id: sibling.task_id, actor: 'human:umit', action: 'revise_spec', note: 'Clarifying' });

    // While in draft, A keeps its claim and is told the spec is under revision.
    const during = await call('heartbeat', { claim_token: a.claim_token });
    expect(during).toMatchObject({ spec_changed: false, spec_status: 'draft' });
    // pick_task doesn't hand out work on a spec under revision.
    expect((await call('pick_task', { project: 'P', actor: 'agent:cli-c' })).task).toBeNull();

    await call('update_spec', { spec_id: spec.key, actor: 'agent:architect', expected_version: 1, approach: 'Sweep every minute.' });
    await call('approve_spec', { spec_id: spec.key, actor: 'human:umit' });

    const after = await call('heartbeat', { claim_token: a.claim_token });
    expect(after.spec_changed).toBe(true);
    expect(after.spec_status).toBeUndefined();
    expect((await call('get_task_brief', { task_id: 'p-1' })).spec.version).toBe(2);
  });

  it('re-approving an unchanged spec keeps its version', async () => {
    const { spec } = await readyTask();
    const a = await call('claim_task', { task_id: 'p-1', actor: 'agent:cli-a' });
    await call('escalate', { claim_token: a.claim_token, question: '?' });
    await call('resolve_needs_human', { task_id: 'p-1', actor: 'human:umit', action: 'revise_spec', note: 'Looked again, it is fine' });
    expect((await call('approve_spec', { spec_id: spec.key, actor: 'human:umit' })).version).toBe(1);
  });

  it('heartbeat reports spec_changed after an approved spec is edited directly', async () => {
    const { spec } = await readyTask();
    const a = await call('claim_task', { task_id: 'p-1', actor: 'agent:cli-a' });
    await call('update_spec', { spec_id: spec.key, actor: 'human:umit', expected_version: 1, why: 'Also skews SLA reports.' });
    expect((await call('heartbeat', { claim_token: a.claim_token })).spec_changed).toBe(true);
  });
});

describe('submit_task', () => {
  it('requires a result for every criterion and a real SHA', async () => {
    const { task } = await readyTask();
    const a = await call('claim_task', { task_id: task.task_id, actor: 'agent:cli-a' });
    const missing = await submit(a, { criteria_results: [{ criterion_id: 'AC-1.1', result: 'pass', evidence: 'ok' }] });
    expect(missing.error).toBe('missing_criteria');
    expect(missing.message).toContain('AC-1.2');
    expect((await submit(a, { criteria_results: [...passAll(a), { criterion_id: 'AC-9.9', result: 'pass', evidence: '' }] })).error).toBe('invalid_criteria');
    expect((await submit(a, { head_sha: 'main' })).error).toBe('invalid_sha');
    expect(status(task.task_id)).toBe('claimed');
  });
});

describe('report_failure routing', () => {
  it('sends spec gaps and design conflicts to a human', async () => {
    await readyTask();
    const a = await call('claim_task', { task_id: 'p-1', actor: 'agent:cli-a' });
    const out = await call('report_failure', { claim_token: a.claim_token, failure_type: 'spec_gap', root_cause: 'AC-1.2 does not say what handling means' });
    expect(out.status).toBe('needs_human');
  });

  it('blocks on a named dependency and unblocks itself when it is done', async () => {
    seedTask(getTestDb(), 'p1', { id: 'migration', title: 'Add last_activity_at column', status: 'needs_verification' });
    getTestDb().prepare("UPDATE tasks SET seq = 139 WHERE id = 'migration'").run();
    const { task } = await readyTask();
    const a = await call('claim_task', { task_id: task.task_id, actor: 'agent:cli-a' });
    const out = await call('report_failure', {
      claim_token: a.claim_token, failure_type: 'dependency', root_cause: 'last_activity_at column missing', blocked_by: ['p-139'],
    });
    expect(out.status).toBe('blocked');
    expect(status(task.task_id)).toBe('blocked');

    changeStatusAsHuman(getTestDb(), 'migration', 'done', UI_ACTOR);
    expect(status(task.task_id)).toBe('ready');
    expect((await call('get_task_brief', { task_id: task.task_id })).dependencies).toEqual([
      { key: 'p-139', title: 'Add last_activity_at column', status: 'done' },
    ]);
  });

  it('leaves an unnamed dependency blocked for a human', async () => {
    const { task } = await readyTask();
    const a = await call('claim_task', { task_id: task.task_id, actor: 'agent:cli-a' });
    await call('report_failure', { claim_token: a.claim_token, failure_type: 'dependency', root_cause: 'Upstream API not deployed' });
    expect(status(task.task_id)).toBe('blocked');
    await call('update_task', { task_id: task.task_id, status: 'ready', actor: 'human:umit' });
    expect(status(task.task_id)).toBe('ready');
  });

  it('moves to needs_human once attempts are exhausted, and requeue grants one more', async () => {
    const { task } = await readyTask();
    for (let i = 0; i < 3; i++) {
      const c = await call('claim_task', { task_id: task.task_id, actor: `agent:cli-${i}` });
      const out = await call('report_failure', { claim_token: c.claim_token, failure_type: 'build_error', root_cause: `Broke ${i}` });
      expect(out.attempts_left).toBe(2 - i);
    }
    expect(status(task.task_id)).toBe('needs_human');
    expect((await call('pick_task', { project: 'P', actor: 'agent:cli-x' })).task).toBeNull();

    const resolved = await call('resolve_needs_human', { task_id: task.task_id, actor: 'human:umit', action: 'requeue', note: 'Fixed the build agent' });
    expect(resolved).toMatchObject({ status: 'ready', attempts_left: 1 });
    expect((await call('claim_task', { task_id: task.task_id, actor: 'agent:cli-y' })).attempt_no).toBe(4);
  });

  it('does not count escalations or releases', async () => {
    const { task } = await readyTask();
    const a = await call('claim_task', { task_id: task.task_id, actor: 'agent:cli-a' });
    expect(await call('release_task', { claim_token: a.claim_token, reason: 'Run budget spent' })).toEqual({ status: 'ready' });
    const b = await call('claim_task', { task_id: task.task_id, actor: 'agent:cli-b' });
    expect(b.brief.task.attempts_left).toBe(2);
    expect(b.brief.previous_attempts[0]).toMatchObject({ outcome: 'abandoned', notes: 'Run budget spent' });
  });
});

describe('review_task (deprecated)', () => {
  it('can no longer reject; failed verification and the UI Reopen replace it', async () => {
    const { task } = await readyTask({ risk_level: 'low' });
    const a = await call('claim_task', { task_id: task.task_id, actor: 'agent:cli-a' });
    await submit(a);
    const out = await call('review_task', { task_id: task.task_id, actor: 'human:umit', decision: 'reject', findings: 'Not asserted.' });
    expect(out.error).toBe('deprecated');
    expect(status(task.task_id)).toBe('needs_verification');
  });

  it('accepts only verified low-risk work, and never for agent:reviewer', async () => {
    const { task } = await readyTask({ risk_level: 'low' });
    const a = await call('claim_task', { task_id: task.task_id, actor: 'agent:cli-a' });
    await submit(a);
    runVerification(getTestDb(), registerTestVerifier(getTestDb()), task.task_id);
    expect((await call('review_task', { task_id: task.task_id, actor: 'agent:reviewer', decision: 'accept' })).error).toBe('forbidden');
    const out = await call('review_task', { task_id: task.task_id, actor: 'human:umit', decision: 'accept' });
    expect(out).toMatchObject({ status: 'done', deprecated: expect.stringMatching(/accept_tasks/) });
  });

  it('treats plain tasks as medium risk and refuses tasks that are not verified', async () => {
    seedTask(getTestDb(), 'p1', { id: 'plain', status: 'verified' });
    expect((await call('review_task', { task_id: 'plain', actor: 'human:umit', decision: 'accept' })).error).toBe('illegal_transition');
    seedTask(getTestDb(), 'p1', { id: 'r', status: 'ready' });
    expect((await call('review_task', { task_id: 'r', actor: 'human:umit', decision: 'accept' })).error).toBe('illegal_transition');
  });
});

describe('acting on behalf of a human', () => {
  it('gives an agent human permissions but records the agent and who asked', async () => {
    const { task } = await readyTask({ risk_level: 'low' });
    const a = await call('claim_task', { task_id: task.task_id, actor: 'agent:cli-a' });
    await submit(a);
    runVerification(getTestDb(), registerTestVerifier(getTestDb()), task.task_id);
    const out = await call('accept_tasks', { actor: 'agent:assistant', on_behalf_of: 'human:umit', task_ids: [task.task_id] });
    expect(out).toEqual({ accepted: ['p-1'], refused: [] });
    const row = getTestDb().prepare("SELECT actor, on_behalf_of FROM task_history WHERE task_id = ? AND new_value = 'done'").get(task.task_id);
    expect(row).toEqual({ actor: 'agent:assistant', on_behalf_of: 'human:umit' });
  });

  it('never lets an agent act on behalf of a human on work it holds or submitted', async () => {
    const { task } = await readyTask();
    const a = await call('claim_task', { task_id: task.task_id, actor: 'agent:cli-a' });
    const mid = await call('update_task', { task_id: task.task_id, status: 'needs_human', actor: 'agent:cli-a', on_behalf_of: 'human:umit' });
    expect(mid.error).toBe('forbidden');
    expect(status(task.task_id)).toBe('claimed');

    await submit(a);
    const accept = await call('review_task', { task_id: task.task_id, actor: 'agent:cli-a', on_behalf_of: 'human:umit', decision: 'accept' });
    expect(accept.error).toBe('forbidden');
    const done = await call('update_task', { task_id: task.task_id, status: 'done', actor: 'agent:cli-a', on_behalf_of: 'human:umit' });
    expect(done.error).toBe('forbidden');
    expect(status(task.task_id)).toBe('needs_verification');
  });

  it('rejects malformed delegation', async () => {
    seedTask(getTestDb(), 'p1', { id: 't' });
    for (const args of [
      { actor: 'human:umit', on_behalf_of: 'human:ana' },
      { actor: 'agent:assistant', on_behalf_of: 'agent:architect' },
    ]) {
      expect((await call('update_task', { task_id: 't', status: 'blocked', ...args })).error).toBe('invalid_actor');
    }
  });

  it('lets an assistant approve a spec for a human, but not a spec it wrote', async () => {
    await call('create_spec', SPEC);
    const own = await call('approve_spec', { spec_id: 'SPEC-1', actor: 'agent:architect', on_behalf_of: 'human:umit' });
    expect(own.error).toBe('forbidden');
    const out = await call('approve_spec', { spec_id: 'SPEC-1', actor: 'agent:assistant', on_behalf_of: 'human:umit' });
    expect(out.status).toBe('approved');
    expect((await call('get_spec', { spec_id: 'SPEC-1' })).approved_by).toBe('agent:assistant for human:umit');
  });

  it('keeps claims as the agent\'s own: claim_task ignores on_behalf_of', async () => {
    const { task } = await readyTask();
    const out = await call('claim_task', { task_id: task.task_id, actor: 'agent:assistant', on_behalf_of: 'human:umit' });
    expect(out.attempt_no).toBe(1);
    // on_behalf_of is not a claim_task parameter: the claim is the agent's own.
    expect(getTestDb().prepare('SELECT claimed_by FROM tasks WHERE id = ?').get(task.task_id)).toEqual({ claimed_by: 'agent:assistant' });
  });
});

describe('pick_task', () => {
  it('orders by priority then age and skips what cannot be worked', async () => {
    const db = getTestDb();
    seedTask(db, 'p1', { id: 'low', priority: 'low' });
    seedTask(db, 'p1', { id: 'crit-blocked', priority: 'critical', blocked_by: '["low"]' });
    seedTask(db, 'p1', { id: 'high', priority: 'high' });
    db.prepare("UPDATE tasks SET seq = rowid").run();
    const out = await call('pick_task', { project: 'P', actor: 'agent:cli-a' });
    expect(out.task_id).toBe('high');
    expect(out.spec_key).toBeNull();
    await call('claim_task', { task_id: 'high', actor: 'agent:cli-a' });
    expect((await call('pick_task', { project: 'P', actor: 'agent:cli-a' })).task_id).toBe('low');
  });

  it('explains why nothing is available', async () => {
    seedTask(getTestDb(), 'p1', { id: 'b', blocked_by: '["missing"]' });
    const out = await call('pick_task', { project: 'P', actor: 'agent:cli-a' });
    expect(out.task).toBeNull();
    expect(out.reason).toMatch(/1 blocked/);
  });
});

describe('task brief', () => {
  it('merges task verification over project defaults', async () => {
    const { task } = await readyTask({}, { verification: { unit: 'dotnet test tests/unit --filter Inactivity', lint: 'dotnet format --verify-no-changes' } });
    const brief = await call('get_task_brief', { task_id: task.task_id });
    expect(brief.verification).toEqual({
      build: 'dotnet build',
      unit: 'dotnet test tests/unit --filter Inactivity',
      lint: 'dotnet format --verify-no-changes',
    });
    expect(brief.project.tech_stack).toBe('C#, .NET 9, PostgreSQL');
  });

  it('includes spec-linked and FTS-ranked decisions but never superseded ones, with hostile spec text', async () => {
    const hostile = {
      title: 'Timeout: "sweep" AND/OR NEAR(close idle) -- conversations*',
      objective: 'Close idle conversations (status:closed) after 30-minute "inactivity"; NOT per-tenant.',
      approach: 'Sweep job ^ last_activity_at OR "unbalanced quote',
    };
    const s = await call('create_spec', { ...SPEC, ...hostile });
    const linked = await call('log_decision', { project: 'P', title: 'Conversation state in PostgreSQL', decision: 'Store state in PostgreSQL', spec_id: s.key });
    await call('log_decision', { project: 'P', title: 'Sweep cadence', decision: 'Run the sweep job every minute', reasoning: 'Idle conversations close within a minute of the limit' });
    const old = await call('log_decision', { project: 'P', title: 'Idle timers', decision: 'Per-conversation idle timers for inactivity' });
    await call('log_decision', { project: 'P', title: 'Idle timers replaced', decision: 'Use the sweep, not timers', supersedes: old.decision_id });
    await call('log_decision', { project: 'P', title: 'Unrelated', decision: 'Use pnpm for the frontend' });
    const t = await call('create_task', { project: 'P', title: 'T', spec_id: s.key });

    const brief = await call('get_task_brief', { task_id: t.task_id });
    const titles = brief.decisions.map((d: any) => d.title);
    expect(titles[0]).toBe('Conversation state in PostgreSQL');
    expect(titles).toContain('Sweep cadence');
    expect(titles).not.toContain('Idle timers');
    expect(titles).not.toContain('Unrelated');
    expect(linked.spec_key).toBe(s.key);
  });

  it('stays under budget by trimming older attempts first, keeping the latest', async () => {
    const { task } = await readyTask();
    for (let i = 0; i < 6; i++) {
      const c = await call('claim_task', { task_id: task.task_id, actor: `agent:cli-${i}` });
      await call('report_failure', {
        claim_token: c.claim_token, failure_type: 'environment',
        root_cause: `Attempt ${i}: ` + 'r'.repeat(560), notes: 'n'.repeat(1400),
      });
      getTestDb().prepare('UPDATE tasks SET max_attempts = 99 WHERE id = ?').run(task.task_id);
      if (status(task.task_id) === 'needs_human') {
        await call('resolve_needs_human', { task_id: task.task_id, actor: 'human:umit', action: 'requeue', note: 'again' });
      }
    }
    const brief = await call('get_task_brief', { task_id: task.task_id });
    expect(estimateTokens(brief)).toBeLessThanOrEqual(BRIEF_TOKEN_BUDGET);
    expect(brief.previous_attempts[0].attempt_no).toBe(6);
    expect(brief.trimmed.previous_attempts).toBeGreaterThan(0);
  });
});
