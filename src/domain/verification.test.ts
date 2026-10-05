import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb, closeTestDb, getTestDb, seedProject, seedTask, parseToolResult, createToolCaller } from '../test-helpers/setup.js';

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
import { changeStatusAsHuman } from './status-change.js';
import {
  acceptTask, authenticateVerifier, finishVerification, hashKey, recordChecks, recordCriteria, registerVerifier, reopenTask,
  revokeVerifier, runsForTask, setVerifierConfig, startVerification,
} from './verification.js';
import { registerTestVerifier, runVerification } from '../test-helpers/verifier.js';

let callTool: ReturnType<typeof createToolCaller>;
const call = async (name: string, args: Record<string, unknown>) => parseToolResult(await callTool(name, args));
const db = () => getTestDb();
const status = (id: string) => (db().prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }).status;
const attempt = (taskId: string, no: number) => db().prepare('SELECT * FROM attempts WHERE task_id = ? AND attempt_no = ?').get(taskId, no) as any;

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
  seedProject(db(), { id: 'p1', name: 'P' });
  db().prepare(`UPDATE projects SET slug = 'p' WHERE id = 'p1'`).run();
  setVerifierConfig(db(), 'p1', { checks: { build: { command: 'dotnet build' }, unit: { command: 'dotnet test' } } }, UI_ACTOR);
});

afterEach(() => closeTestDb());

const SPEC = {
  project: 'P',
  actor: 'agent:architect',
  title: 'Conversation inactivity timeout',
  objective: 'Close conversations after 30 minutes of inactivity.',
  why: 'Idle conversations hold agent capacity.',
  risk_level: 'medium',
  criteria: [
    { statement: 'Closes after 30 min', verify_kind: 'test', verify_ref: 'InactivityTimeoutTests.ClosesAfterThirtyMinutes' },
    { statement: 'Never closes a handled conversation', verify_kind: 'test', verify_ref: 'InactivityTimeoutTests.SkipsActiveHandling' },
    { statement: 'The sweep query uses the last_activity_at index', verify_kind: 'review', verify_ref: 'Check the sweep query plan' },
  ],
};

async function submitted(spec: Record<string, unknown> = {}, sha = '9cd821e0aa') {
  const s = await call('create_spec', { ...SPEC, ...spec });
  const t = await call('create_task', { project: 'P', title: 'Implement inactivity timeout', spec_id: s.key });
  await call('approve_spec', { spec_id: s.key, project: 'P', actor: 'human:umit' });
  return { spec: s, task: t, sha, claim: await claimAndSubmit(t.task_id, 'agent:cli-b', sha) };
}

async function claimAndSubmit(taskId: string, actor: string, sha: string) {
  const claim = await call('claim_task', { task_id: taskId, actor });
  const out = await call('submit_task', {
    claim_token: claim.claim_token, branch: 'feature/p-1', head_sha: sha, files_touched: ['src/Sweep.cs'], summary: 'Done.',
    criteria_results: claim.brief.criteria.map((c: any) => ({ criterion_id: c.key, result: 'pass', evidence: 'passed' })),
  });
  expect(out).toEqual({ status: 'needs_verification' });
  return claim;
}

function keys() {
  return { local: registerTestVerifier(db(), 'local-1', 'local'), reviewer: registerTestVerifier(db(), 'claude-review', 'reviewer') };
}

describe('verifier keys', () => {
  it('are issued once, stored only as a hash, and only through the UI', () => {
    const human = parseActor('human:umit')!;
    expect(() => registerVerifier(db(), { name: 'mine', kind: 'local', project_ids: ['*'] }, human)).toThrow(/Kanban UI/);
    expect(() => registerVerifier(db(), { name: 'mine', kind: 'local', project_ids: ['*'] }, parseActor('human:ui')!)).toThrow(/Kanban UI/);
    const { key, verifier } = registerVerifier(db(), { name: 'local-1', kind: 'local', project_ids: ['p1'] }, UI_ACTOR);
    expect(key).toMatch(/^mpv_/);
    expect(verifier).not.toHaveProperty('key_hash');
    const row = db().prepare('SELECT key_hash FROM verifiers').get() as { key_hash: string };
    expect(row.key_hash).toBe(hashKey(key));
    expect(JSON.stringify(db().prepare('SELECT * FROM verifiers').all())).not.toContain(key);
    expect(authenticateVerifier(db(), key).actor).toMatchObject({ id: 'verifier:local-1', kind: 'verifier' });
    expect(() => authenticateVerifier(db(), 'mpv_guess')).toThrow(/Unknown verifier key/);
  });

  it('cannot be declared: verifier:<name> is not a valid actor', () => {
    expect(parseActor('verifier:local-1')).toBeNull();
  });

  it('only cover the projects they were issued for', async () => {
    const { task } = await submitted();
    seedProject(db(), { id: 'p2', name: 'Other' });
    const other = registerVerifier(db(), { name: 'other', kind: 'local', project_ids: ['p2'] }, UI_ACTOR).key;
    expect((await call('pending_verifications', { verifier_key: other })).length).toBe(0);
    expect(() => startVerification(db(), authenticateVerifier(db(), other), task.task_id)).toThrow(/does not cover/);
  });

  it('revoking disables the key and errors its running runs', async () => {
    const { task } = await submitted();
    const { local } = keys();
    const v = authenticateVerifier(db(), local);
    const run = startVerification(db(), v, task.task_id);
    revokeVerifier(db(), v.row.id, UI_ACTOR);
    expect(() => authenticateVerifier(db(), local)).toThrow(/revoked/);
    expect(db().prepare('SELECT status, error_reason FROM verification_runs WHERE id = ?').get(run.run_id))
      .toEqual({ status: 'error', error_reason: 'Verifier key revoked.' });
    expect(status(task.task_id)).toBe('needs_verification');
  });
});

describe('the flow from the Phase 2 doc', () => {
  it('fails attempt 2 on a failing test, flags the self-report, then passes attempt 3 and waits for the UI', async () => {
    const { task } = await submitted();
    const { local, reviewer } = keys();

    // Step 2: the verifier sees it and starts a run on 9cd821e.
    const pending = await call('pending_verifications', { verifier_key: local });
    expect(pending).toEqual([expect.objectContaining({ key: 'p-1', head_sha: '9cd821e0aa', risk_level: 'medium' })]);
    const run = await call('start_verification', { verifier_key: local, task_id: 'p-1' });
    expect(run).toMatchObject({ head_sha: '9cd821e0aa', branch: 'feature/p-1', checks: [{ name: 'build', command: 'dotnet build' }, { name: 'unit', command: 'dotnet test' }] });
    expect(run.criteria.map((c: any) => c.key)).toEqual(['AC-1.1', 'AC-1.2', 'AC-1.3']);
    expect((await call('pending_verifications', { verifier_key: local })).length).toBe(0);
    expect((await call('start_verification', { verifier_key: local, task_id: 'p-1' })).error).toBe('already_running');

    // Step 3-4: build passes, unit fails; AC-1.2 fails; the reviewer judges AC-1.3.
    expect((await call('record_checks', {
      verifier_key: local, run_id: run.run_id, head_sha: 'e41a07b', checks: [{ name: 'build', command: 'dotnet build', exit_code: 0 }],
    })).error).toBe('sha_mismatch');
    await call('record_checks', {
      verifier_key: local, run_id: run.run_id, head_sha: '9cd821e',
      checks: [
        { name: 'build', command: 'dotnet build', exit_code: 0, duration_ms: 9000 },
        { name: 'unit', command: 'dotnet test', exit_code: 1, duration_ms: 4000, output_tail: 'Expected Open, got Closed' },
      ],
    });
    expect((await call('record_criteria', {
      verifier_key: local, run_id: run.run_id, results: [{ criterion_id: 'AC-1.3', result: 'pass', evidence: 'looks fine' }],
    })).error).toBe('forbidden');
    const recorded = await call('record_criteria', {
      verifier_key: local, run_id: run.run_id, results: [
        { criterion_id: 'AC-1.1', result: 'pass', evidence: 'InactivityTimeoutTests.ClosesAfterThirtyMinutes passed in 412 ms' },
        { criterion_id: 'AC-1.2', result: 'fail', evidence: 'InactivityTimeoutTests.SkipsActiveHandling failed: Expected Open, got Closed' },
      ],
    });
    expect(recorded.criteria_remaining).toEqual(['AC-1.3']);
    expect((await call('record_criteria', {
      verifier_key: reviewer, run_id: run.run_id, results: [{ criterion_id: 'AC-1.1', result: 'pass', evidence: 'x' }],
    })).error).toBe('forbidden');
    await call('record_criteria', {
      verifier_key: reviewer, run_id: run.run_id, results: [{ criterion_id: 'AC-1.3', result: 'pass', evidence: 'Sweep.cs:42 filters on last_activity_at' }],
    });
    expect((await call('finish_verification', { verifier_key: reviewer, run_id: run.run_id })).error).toBe('forbidden');

    // Step 5: the server computes failed; the attempt is used and flagged.
    expect(await call('finish_verification', { verifier_key: local, run_id: run.run_id })).toEqual({ run_status: 'failed', task_status: 'ready' });
    const a1 = attempt(task.task_id, 1);
    expect(a1).toMatchObject({ verification_outcome: 'failed', failure_type: 'test_failure', self_report_mismatch: 1 });

    // Step 6: executor C sees the failing check, its output and the mismatch.
    const c = await call('claim_task', { task_id: 'p-1', actor: 'agent:cli-c' });
    expect(c.brief.task.attempts_left).toBe(1);
    expect(c.brief.previous_attempts[0].verification).toMatchObject({
      outcome: 'failed',
      findings: { failing_checks: ['unit'], output_tail: 'Expected Open, got Closed', criteria: [expect.objectContaining({ key: 'AC-1.2', result: 'fail' })] },
      self_report_mismatch: expect.any(String),
    });

    // Steps 7-8: attempt at e41a07b passes everything.
    await call('submit_task', {
      claim_token: c.claim_token, branch: 'feature/p-1', head_sha: 'e41a07b', files_touched: ['src/Sweep.cs'], summary: 'Fixed.',
      criteria_results: c.brief.criteria.map((x: any) => ({ criterion_id: x.key, result: 'pass', evidence: 'passed' })),
    });
    const v = authenticateVerifier(db(), local);
    const run3 = startVerification(db(), v, 'p-1');
    expect(run3.head_sha).toBe('e41a07b');
    recordChecks(db(), v, run3.run_id, run3.checks.map(x => ({ ...x, exit_code: 0 })), 'e41a07b');
    recordCriteria(db(), v, run3.run_id, [
      { criterion_id: 'AC-1.1', result: 'pass', evidence: 'passed' }, { criterion_id: 'AC-1.2', result: 'pass', evidence: 'passed' },
    ]);
    recordCriteria(db(), authenticateVerifier(db(), reviewer), run3.run_id, [{ criterion_id: 'AC-1.3', result: 'pass', evidence: 'Sweep.cs:42' }]);
    expect(finishVerification(db(), v, run3.run_id)).toEqual({ run_status: 'passed', task_status: 'verified' });

    // Step 9: medium risk waits in verified for a UI click.
    expect((await call('accept_tasks', { actor: 'agent:assistant', on_behalf_of: 'human:umit', task_ids: ['p-1'] })).accepted).toEqual([]);
    acceptTask(db(), 'p-1', UI_ACTOR);
    expect(status(task.task_id)).toBe('done');
  });

  it('passes when every check exits 0 and every criterion passes, and records the run on the task', async () => {
    const { task } = await submitted({ risk_level: 'low', criteria: SPEC.criteria.slice(0, 2) });
    const { local } = keys();
    const { run, result } = runVerification(db(), local, task.task_id);
    expect(result).toEqual({ run_status: 'passed', task_status: 'verified' });
    expect(db().prepare('SELECT verified_run_id FROM tasks WHERE id = ?').get(task.task_id)).toEqual({ verified_run_id: run.run_id });
    const history = db().prepare("SELECT actor, verifier_id FROM task_history WHERE task_id = ? AND new_value = 'verified'").get(task.task_id) as any;
    expect(history.actor).toBe('verifier:local-1');
    expect(history.verifier_id).toBeTruthy();
    expect(runsForTask(db(), task.task_id)[0]).toMatchObject({ status: 'passed', verifier: 'verifier:local-1', checks: expect.any(Array), criteria: expect.any(Array) });
  });

  it('treats an unrecorded criterion or planned check as not passed', async () => {
    const { task } = await submitted({ criteria: SPEC.criteria.slice(0, 2) });
    const { local } = keys();
    const v = authenticateVerifier(db(), local);
    const run = startVerification(db(), v, task.task_id);
    recordChecks(db(), v, run.run_id, [{ name: 'build', command: 'dotnet build', exit_code: 0 }]);
    recordCriteria(db(), v, run.run_id, [{ criterion_id: 'AC-1.1', result: 'pass', evidence: 'ok' }]);
    expect(finishVerification(db(), v, run.run_id).run_status).toBe('failed');
    const findings = JSON.parse(attempt(task.task_id, 1).verification_findings);
    expect(findings.failing_checks).toEqual(['unit (not run)']);
    expect(findings.criteria).toEqual([expect.objectContaining({ key: 'AC-1.2', result: 'missing' })]);
  });
});

describe('the commands a verifier runs', () => {
  it('come from the human-owned verifier config, never from what an agent can set', async () => {
    const { task } = await submitted({ criteria: SPEC.criteria.slice(0, 2) });
    // An agent rewrites the project defaults and the task's own commands.
    await call('set_execution_defaults', { project: 'P', verification_defaults: { build: 'true', unit: 'true', lint: 'true' } });
    await call('update_task', { task_id: task.task_id, verification: { unit: 'true' } });
    const run = startVerification(db(), authenticateVerifier(db(), keys().local), task.task_id);
    expect(run.checks).toEqual([{ name: 'build', command: 'dotnet build' }, { name: 'unit', command: 'dotnet test' }]);
    // The executor's brief shows both: its hints and what the verifier will run.
    const brief = await call('get_task_brief', { task_id: task.task_id });
    expect(brief.verification).toMatchObject({ unit: 'true' });
    expect(brief.verifier_checks).toEqual(run.checks);
  });

  it('can only be configured through the UI, and every check needs a command', () => {
    expect(() => setVerifierConfig(db(), 'p1', { checks: { unit: { command: 'true' } } }, parseActor('human:umit')!)).toThrow(/Kanban UI/);
    expect(() => setVerifierConfig(db(), 'p1', { checks: { unit: {} } }, UI_ACTOR)).toThrow(/needs a command/);
  });
});

describe('errors', () => {
  it('keep the task in needs_verification without using an attempt, until the third in a row', async () => {
    const { task } = await submitted();
    const { local } = keys();
    for (let i = 1; i <= 3; i++) {
      const run = await call('start_verification', { verifier_key: local, task_id: task.task_id });
      const out = await call('finish_verification', { verifier_key: local, run_id: run.run_id, error_reason: `worktree failed: 9cd821e not found (${i})` });
      expect(out).toEqual({ run_status: 'error', task_status: i < 3 ? 'needs_verification' : 'needs_human' });
    }
    expect(attempt(task.task_id, 1)).toMatchObject({ consecutive_errors: 3, verification_outcome: null });
    const stuck = db().prepare("SELECT new_value FROM task_history WHERE task_id = ? AND event = 'verification_stuck'").get(task.task_id) as any;
    expect(JSON.parse(stuck.new_value).reasons).toHaveLength(3);
    // No attempt was used, and the human can hand it back to a fixed verifier.
    expect((await call('get_task_brief', { task_id: task.task_id })).task.attempts_left).toBe(2);
    const { resolveNeedsHuman } = await import('./needs-human.js');
    expect(resolveNeedsHuman(db(), task.task_id, 'reverify', 'Pushed the branch', UI_ACTOR).status).toBe('needs_verification');
    expect(attempt(task.task_id, 1).consecutive_errors).toBe(0);
    expect((await call('pending_verifications', { verifier_key: local })).length).toBe(1);
  });

  it('end a run whose lease expired, and the task becomes pending again', async () => {
    const { task } = await submitted();
    const { local } = keys();
    const run = await call('start_verification', { verifier_key: local, task_id: task.task_id });
    db().prepare("UPDATE verification_runs SET lease_expires_at = datetime('now', '-1 minute') WHERE id = ?").run(run.run_id);
    expect((await call('pending_verifications', { verifier_key: local })).length).toBe(1);
    expect((await call('finish_verification', { verifier_key: local, run_id: run.run_id })).error).toBe('lease_expired');
    expect(status(task.task_id)).toBe('needs_verification');
    // A new run supersedes the old one, never deletes it.
    await call('start_verification', { verifier_key: local, task_id: task.task_id });
    expect(db().prepare('SELECT status FROM verification_runs WHERE id = ?').get(run.run_id)).toEqual({ status: 'superseded' });
  });

  it('refuse a run with nothing to verify', async () => {
    setVerifierConfig(db(), 'p1', {}, UI_ACTOR);
    seedTask(db(), 'p1', { id: 'plain', status: 'ready' });
    await claimAndSubmit('plain', 'agent:cli-a', 'abcdef1');
    const { local } = keys();
    expect(runVerification(db(), local, 'plain').result).toEqual({ run_status: 'error', task_status: 'needs_verification' });
  });
});

describe('acceptance', () => {
  it('medium and high risk: only the UI; low risk: accept_tasks with on_behalf_of', async () => {
    const med = await submitted();
    const { local } = keys();
    setVerifierConfig(db(), 'p1', {}, UI_ACTOR);
    runVerification(db(), local, med.task.task_id);
    // Medium had a review criterion and no reviewer: failed. Re-do with only test criteria.
    const low = await call('create_spec', { ...SPEC, risk_level: 'low', criteria: SPEC.criteria.slice(0, 1) });
    const lt = await call('create_task', { project: 'P', title: 'Low task', spec_id: low.key });
    await call('approve_spec', { spec_id: low.key, project: 'P', actor: 'human:umit' });
    await claimAndSubmit(lt.task_id, 'agent:cli-a', 'abcdef1');
    expect(runVerification(db(), local, lt.task_id).result.task_status).toBe('verified');

    const hi = await call('create_spec', { ...SPEC, risk_level: 'high', criteria: SPEC.criteria.slice(0, 1) });
    const ht = await call('create_task', { project: 'P', title: 'High task', spec_id: hi.key });
    await call('approve_spec', { spec_id: hi.key, project: 'P', actor: 'human:umit' });
    await claimAndSubmit(ht.task_id, 'agent:cli-a', 'abcdef2');
    expect(runVerification(db(), local, ht.task_id).result.task_status).toBe('verified');

    // The submitter cannot accept its own work, even for a human.
    expect((await call('accept_tasks', { actor: 'agent:cli-a', on_behalf_of: 'human:umit', task_ids: [lt.task_id] })).refused).toHaveLength(1);
    const out = await call('accept_tasks', { actor: 'agent:assistant', on_behalf_of: 'human:umit', task_ids: [lt.task_id, ht.task_id] });
    expect(out.accepted).toEqual([lt.key]);
    expect(out.refused).toEqual([{ task_id: ht.task_id, reason: expect.stringMatching(/high risk.*Kanban UI/) }]);
    expect((await call('update_task', { task_id: ht.task_id, status: 'done', actor: 'human:umit' })).error).toBe('illegal_transition');
    expect((await call('accept_tasks', { actor: 'agent:assistant', task_ids: [ht.task_id] })).error).toBe('forbidden');

    acceptTask(db(), ht.task_id, UI_ACTOR);
    expect(status(ht.task_id)).toBe('done');
  });

  it('a declared human:ui over MCP is not the UI', async () => {
    const { task } = await submitted({ criteria: SPEC.criteria.slice(0, 2) });
    runVerification(db(), keys().local, task.task_id);
    expect(status(task.task_id)).toBe('verified');
    expect((await call('update_task', { task_id: task.task_id, status: 'done', actor: 'human:ui' })).error).toBe('illegal_transition');
    expect(() => acceptTask(db(), task.task_id, parseActor('human:ui')!)).toThrow(/Kanban UI/);
  });

  it('only a verifier reaches verified', async () => {
    const { task } = await submitted();
    expect((await call('update_task', { task_id: task.task_id, status: 'verified', actor: 'human:umit' })).error).toBe('illegal_transition');
    expect(() => changeStatusAsHuman(db(), task.task_id, 'verified', UI_ACTOR)).toThrow(/verifier/);
  });

  it('reopen sends verified work back with findings and uses an attempt', async () => {
    const { task } = await submitted({ criteria: SPEC.criteria.slice(0, 2) });
    runVerification(db(), keys().local, task.task_id);
    expect(() => reopenTask(db(), task.task_id, '', UI_ACTOR)).toThrow(/findings/);
    expect(() => reopenTask(db(), task.task_id, 'Wrong index', parseActor('human:umit')!)).toThrow(/Kanban UI/);
    expect(reopenTask(db(), task.task_id, 'Uses the wrong index', UI_ACTOR)).toEqual({ task_id: task.task_id, status: 'ready' });
    const c = await call('claim_task', { task_id: task.task_id, actor: 'agent:cli-c' });
    expect(c.brief.task.attempts_left).toBe(1);
    expect(c.brief.previous_attempts[0].review_findings).toBe('Uses the wrong index');
  });

  it('legacy tasks with no submission are accepted from needs_verification in the UI only', () => {
    seedTask(db(), 'p1', { id: 'legacy', status: 'needs_verification' });
    expect(() => acceptTask(db(), 'legacy', parseActor('human:umit')!)).toThrow(/not been verified/);
    acceptTask(db(), 'legacy', UI_ACTOR);
    expect(status('legacy')).toBe('done');
  });

  it('the session brief lists verified work waiting for a human', async () => {
    const { task } = await submitted({ risk_level: 'low', criteria: SPEC.criteria.slice(0, 2) });
    runVerification(db(), keys().local, task.task_id);
    const brief = await call('get_session_brief', { project: 'P' });
    expect(brief.awaiting_acceptance.low_risk).toEqual([expect.objectContaining({ key: 'p-1', risk_level: 'low' })]);
    expect(brief.awaiting_acceptance.needs_ui).toEqual([]);
  });
});

describe('delivery metrics', () => {
  it('report first-run pass rate, self-report mismatches and time to verified', async () => {
    const { computeVerificationMetrics } = await import('../db/metrics.js');
    const { task } = await submitted({ criteria: SPEC.criteria.slice(0, 2) });
    const { local } = keys();
    runVerification(db(), local, task.task_id, ['AC-1.2']);
    await claimAndSubmit(task.task_id, 'agent:cli-c', 'e41a07b');
    runVerification(db(), local, task.task_id);
    expect(computeVerificationMetrics(db(), 'p1', 30)).toMatchObject({
      verified_submissions: 2, first_run_pass_rate_pct: 0, self_report_mismatch_rate_pct: 100, awaiting_acceptance: 1,
      median_hours_to_verified: expect.any(Number),
    });
  });
});
