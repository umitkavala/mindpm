import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, closeTestDb, getTestDb, seedProject, parseToolResult, createToolCaller } from '../test-helpers/setup.js';

vi.mock('../db/connection.js', () => ({
  getDb: () => getTestDb(),
  closeDb: () => closeTestDb(),
}));

import { registerTaskTools } from '../tools/tasks.js';
import { registerSpecTools } from '../tools/specs.js';
import { registerExecutorTools } from '../tools/executor.js';
import { UI_ACTOR } from '../domain/lifecycle.js';
import { authenticateVerifier, setVerifierConfig } from '../domain/verification.js';
import { registerTestVerifier } from '../test-helpers/verifier.js';
import { parseReviewOutput, parseVerifyArgs, verifyOnce } from './run.js';

let callTool: ReturnType<typeof createToolCaller>;
let repo: string;
const call = async (name: string, args: Record<string, unknown>) => parseToolResult(await callTool(name, args));
const db = () => getTestDb();
const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const logs: string[] = [];
const opts = { log: (l: string) => logs.push(l) };

// A test runner that writes a JUnit report; T.B passes once impl.txt says "fixed".
const TEST_SCRIPT = `
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
const ok = readFileSync('impl.txt', 'utf8').trim() === 'fixed';
mkdirSync('reports', { recursive: true });
writeFileSync('reports/junit.xml', '<testsuite><testcase classname="T" name="A" time="0.01"/>' +
  '<testcase classname="T" name="B">' + (ok ? '' : '<failure message="Expected Open, got Closed"/>') + '</testcase></testsuite>');
console.log(ok ? 'all passed' : 'T.B failed: Expected Open, got Closed');
process.exit(ok ? 0 : 1);
`;

function commit(impl: string): string {
  writeFileSync(join(repo, 'impl.txt'), impl);
  g('add', '.');
  g('commit', '-q', '-m', `impl ${impl}`);
  return g('rev-parse', 'HEAD');
}

async function submit(sha: string, actor: string) {
  const claim = await call('claim_task', { task_id: 'p-1', actor });
  return call('submit_task', {
    claim_token: claim.claim_token, branch: 'feature/p-1', head_sha: sha, files_touched: ['impl.txt'], summary: 'Done.',
    criteria_results: claim.brief.criteria.map((c: any) => ({ criterion_id: c.key, result: 'pass', evidence: 'passed' })),
  });
}

beforeEach(async () => {
  createTestDb();
  logs.length = 0;
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerTaskTools(server);
  registerSpecTools(server);
  registerExecutorTools(server);
  callTool = createToolCaller(server);

  repo = mkdtempSync(join(tmpdir(), 'mindpm-verify-test-'));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  writeFileSync(join(repo, 'test.mjs'), TEST_SCRIPT);
  writeFileSync(join(repo, '.gitignore'), 'reports/\n');
  commit('base');
  g('checkout', '-q', '-b', 'feature/p-1');

  seedProject(db(), { id: 'p1', name: 'P', repo_path: repo });
  db().prepare('UPDATE projects SET slug = ? WHERE id = ?').run('p', 'p1');
  setVerifierConfig(db(), 'p1', {
    checks: {
      unit: { command: 'node test.mjs', report: { path: 'reports/junit.xml', format: 'junit' } },
      // Fails if a verifier key leaks into the environment of a check.
      lint: { command: 'node -e "process.exit(process.env.MINDPM_VERIFIER_KEY || process.env.MINDPM_REVIEWER_KEY ? 3 : 0)"' },
    },
    reviewer: { command: `cat > /dev/null; echo '{"results":[{"criterion":"AC-1.3","result":"pass","rationale":"impl.txt:1 says fixed"}]}'` },
  }, UI_ACTOR);

  const s = await call('create_spec', {
    project: 'P', actor: 'agent:architect', title: 'Timeout', objective: 'Close idle conversations.', why: 'Capacity.', risk_level: 'medium',
    criteria: [
      { statement: 'Closes after 30 min', verify_kind: 'test', verify_ref: 'T.A' },
      { statement: 'Skips active handling', verify_kind: 'test', verify_ref: 'T.B' },
      { statement: 'Uses the index', verify_kind: 'review', verify_ref: 'Query plan' },
    ],
  });
  await call('create_task', { project: 'P', title: 'Implement', spec_id: s.key });
  await call('approve_spec', { spec_id: s.key, project: 'P', actor: 'human:umit' });
});

afterEach(() => {
  closeTestDb();
  rmSync(repo, { recursive: true, force: true });
  delete process.env.MINDPM_VERIFIER_KEY;
});

describe('mindpm verify', () => {
  it('fails a broken commit from a clean checkout, then passes the fix', async () => {
    const local = authenticateVerifier(db(), registerTestVerifier(db(), 'local-1', 'local'));
    const reviewer = authenticateVerifier(db(), registerTestVerifier(db(), 'claude-review', 'reviewer'));
    process.env.MINDPM_VERIFIER_KEY = 'must-not-leak';

    const broken = commit('broken');
    // The executor's working tree moves on; the verifier must use the SHA.
    writeFileSync(join(repo, 'impl.txt'), 'fixed');
    await submit(broken, 'agent:cli-b');
    expect(await verifyOnce(db(), local, reviewer, opts)).toEqual([{ key: 'p-1', run_status: 'failed', task_status: 'ready' }]);
    const a1 = db().prepare('SELECT * FROM attempts WHERE attempt_no = 1').get() as any;
    const findings = JSON.parse(a1.verification_findings);
    expect(findings.failing_checks).toEqual(['unit']);
    expect(findings.output_tail).toContain('Expected Open, got Closed');
    expect(findings.criteria).toEqual([expect.objectContaining({ key: 'AC-1.2', result: 'fail' })]);
    expect(a1.self_report_mismatch).toBe(1);

    g('checkout', '-q', '--', 'impl.txt');
    const fixed = commit('fixed');
    await submit(fixed, 'agent:cli-c');
    expect(await verifyOnce(db(), local, reviewer, opts)).toEqual([{ key: 'p-1', run_status: 'passed', task_status: 'verified' }]);
    const evidence = db().prepare('SELECT source, evidence FROM criterion_results cr JOIN verification_runs r ON r.id = cr.run_id WHERE r.status = ? ORDER BY source').all('passed') as any[];
    expect(evidence.map(e => e.source)).toEqual(['review', 'test', 'test']);
    expect(evidence[0].evidence).toContain('impl.txt:1');

    // Worktrees are removed.
    expect(g('worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('ends as error, not failed, when the commit cannot be checked out', async () => {
    const local = authenticateVerifier(db(), registerTestVerifier(db(), 'local-1', 'local'));
    const reviewer = authenticateVerifier(db(), registerTestVerifier(db(), 'claude-review', 'reviewer'));
    await submit('deadbeef0000', 'agent:cli-b');
    expect(await verifyOnce(db(), local, reviewer, opts)).toEqual([{ key: 'p-1', run_status: 'error', task_status: 'needs_verification' }]);
    const run = db().prepare('SELECT error_reason FROM verification_runs').get() as any;
    expect(run.error_reason).toMatch(/Could not check out deadbeef0000/);
    expect((db().prepare('SELECT verification_outcome FROM attempts').get() as any).verification_outcome).toBeNull();
  });

  it('ends as error when review criteria exist but no reviewer key is set', async () => {
    const local = authenticateVerifier(db(), registerTestVerifier(db(), 'local-1', 'local'));
    await submit(commit('fixed'), 'agent:cli-b');
    expect(await verifyOnce(db(), local, null, opts)).toEqual([{ key: 'p-1', run_status: 'error', task_status: 'needs_verification' }]);
    expect((db().prepare('SELECT error_reason FROM verification_runs').get() as any).error_reason).toMatch(/MINDPM_REVIEWER_KEY/);
  });
});

describe('command criteria', () => {
  it('run only on a spec a human approved', async () => {
    const local = authenticateVerifier(db(), registerTestVerifier(db(), 'local-1', 'local'));
    const make = async (title: string, approver: string) => {
      const s = await call('create_spec', {
        project: 'P', actor: 'agent:architect', title, objective: 'x', why: 'y', risk_level: 'low',
        criteria: [{ statement: 'Impl says fixed', verify_kind: 'command', verify_ref: 'grep -q fixed impl.txt' }],
      });
      const t = await call('create_task', { project: 'P', title, spec_id: s.key });
      await call('approve_spec', { spec_id: s.key, project: 'P', actor: approver });
      return t.key;
    };
    const byAgent = await make('Agent-approved', 'agent:architect');
    const byHuman = await make('Human-approved', 'human:umit');
    const sha = commit('fixed');
    for (const key of [byAgent, byHuman]) {
      const claim = await call('claim_task', { task_id: key, actor: 'agent:cli-b' });
      await call('submit_task', {
        claim_token: claim.claim_token, branch: 'feature/p-1', head_sha: sha, files_touched: ['impl.txt'], summary: 'Done.',
        criteria_results: claim.brief.criteria.map((c: any) => ({ criterion_id: c.key, result: 'pass', evidence: 'ok' })),
      });
    }
    const out = await verifyOnce(db(), local, null, { ...opts, project: 'P' });
    expect(out.find(o => o.key === byAgent)).toMatchObject({ run_status: 'error' });
    expect(out.find(o => o.key === byHuman)).toMatchObject({ run_status: 'passed' });
  });
});

describe('parseReviewOutput', () => {
  it('reads plain JSON, JSON with prose around it, and the claude --output-format json wrapper', () => {
    const inner = '{"results":[{"criterion":"AC-1.3","result":"pass","rationale":"x"}]}';
    expect(parseReviewOutput(inner)).toHaveLength(1);
    expect(parseReviewOutput(`Here you go:\n${inner}\n`)).toHaveLength(1);
    expect(parseReviewOutput(JSON.stringify({ type: 'result', result: inner }))).toHaveLength(1);
    expect(() => parseReviewOutput('I think it is fine')).toThrow(/no JSON/);
  });
});

describe('parseVerifyArgs', () => {
  it('parses flags; --task implies --once', () => {
    expect(parseVerifyArgs(['--task', 'p-1'])).toMatchObject({ once: true, task: 'p-1' });
    expect(parseVerifyArgs(['--project', 'P', '--interval', '60'])).toMatchObject({ once: false, project: 'P', intervalSeconds: 60 });
    expect(() => parseVerifyArgs(['--nope'])).toThrow(/Unknown option/);
  });
});
