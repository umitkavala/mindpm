// `mindpm verify`: the local verifier. Runs outside the MCP server, against the
// same database, and authenticates with MINDPM_VERIFIER_KEY. For each task
// waiting in needs_verification it checks out the submitted SHA in a temporary
// worktree (never the executor's working tree), runs the project's checks,
// maps criteria to evidence, and lets the server compute the outcome.

import type Database from 'better-sqlite3';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, platform, release } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { resolveProjectId } from '../db/queries.js';
import { buildBrief } from '../domain/brief.js';
import { ToolError } from '../domain/lifecycle.js';
import {
  authenticateVerifier, finishVerification, OUTPUT_TAIL_MAX, pendingVerifications, recordChecks, recordCriteria, shaMatches,
  startVerification, type CriterionInput, type StartedRun, type Verifier,
} from '../domain/verification.js';
import { matchTest, parseJsonReport, parseJunit, summarize, type TestCase } from './reports.js';

export const DEFAULT_CHECK_TIMEOUT_MINUTES = 15;
export const DEFAULT_REVIEWER_COMMAND = 'claude -p';
const DIFF_MAX = 60_000;
const SECRET_ENV = ['MINDPM_VERIFIER_KEY', 'MINDPM_REVIEWER_KEY'];

export interface VerifyOptions {
  once: boolean;
  task?: string;
  project?: string;
  intervalSeconds: number;
  log: (line: string) => void;
}

// Raised for "the check broke" situations: the run ends as error, not failed.
class VerifierError extends Error {}

// Check commands run the executor's code. They must never see a verifier key.
export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of SECRET_ENV) delete env[k];
  return env;
}

interface ExecResult { exit_code: number | null; output: string; duration_ms: number; timed_out: boolean }

export function exec(command: string, cwd: string, timeoutMs: number, input?: string): Promise<ExecResult> {
  return new Promise(resolvePromise => {
    const started = Date.now();
    const child = spawn(command, { cwd, env: childEnv(), shell: true, detached: process.platform !== 'win32' });
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL_MAX * 4);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // Kill the whole process group so test runners don't outlive the check.
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* already gone */ }
    }, timeoutMs);
    child.on('error', err => {
      output += `\n${err.message}`;
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolvePromise({ exit_code: timedOut ? null : code, output, duration_ms: Date.now() - started, timed_out: timedOut });
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: childEnv() });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function checkoutWorktree(repoPath: string, sha: string): string {
  if (!existsSync(repoPath)) throw new VerifierError(`repo_path ${repoPath} does not exist.`);
  const dir = mkdtempSync(join(tmpdir(), 'mindpm-verify-'));
  let add = git(repoPath, ['worktree', 'add', '--detach', dir, sha]);
  if (!add.ok) {
    // The commit may only exist on the remote.
    git(repoPath, ['fetch', '--all', '--quiet']);
    add = git(repoPath, ['worktree', 'add', '--detach', dir, sha]);
  }
  if (!add.ok) {
    rmSync(dir, { recursive: true, force: true });
    throw new VerifierError(`Could not check out ${sha}: ${add.out.slice(0, 300)}`);
  }
  const head = git(dir, ['rev-parse', 'HEAD']);
  if (!head.ok || !shaMatches(head.out, sha)) {
    removeWorktree(repoPath, dir);
    throw new VerifierError(`Worktree HEAD is ${head.out || 'unknown'}, expected ${sha}.`);
  }
  return dir;
}

function removeWorktree(repoPath: string, dir: string): void {
  git(repoPath, ['worktree', 'remove', '--force', dir]);
  rmSync(dir, { recursive: true, force: true });
  git(repoPath, ['worktree', 'prune']);
}

// Resolve a report path inside the worktree; a path escaping it is refused.
function reportPath(worktree: string, path: string): string {
  const full = resolve(worktree, path);
  const rel = relative(worktree, full);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new VerifierError(`Report path ${path} is outside the checkout.`);
  return full;
}

function readReport(worktree: string, path: string, format: 'junit' | 'json'): TestCase[] | null {
  const full = reportPath(worktree, path);
  if (!existsSync(full)) return null;
  const text = readFileSync(full, 'utf8');
  try {
    return format === 'junit' ? parseJunit(text, path) : parseJsonReport(text, path);
  } catch (err) {
    throw new VerifierError(`Could not parse ${format} report ${path}: ${(err as Error).message}`);
  }
}

const tail = (s: string, n: number) => (s.length > n ? s.slice(-n) : s);

function testEvidence(ref: string, cases: TestCase[]): { result: CriterionInput['result']; evidence: string } {
  const m = matchTest(cases, ref);
  if (m.kind === 'none') return { result: 'missing', evidence: `No test matching ${ref} ran in the parsed reports.` };
  if (m.kind === 'ambiguous') {
    return { result: 'missing', evidence: tail(`verify_ref ${ref} matches more than one test (a spec error): ${m.candidates.join(', ')}`, 1500) };
  }
  const t = m.test;
  const time = t.duration_ms !== undefined ? ` in ${t.duration_ms} ms` : '';
  if (t.status === 'passed') return { result: 'pass', evidence: `Test ${t.id} passed${time} (report ${t.report}).` };
  if (t.status === 'skipped') return { result: 'missing', evidence: `Test ${t.id} was skipped (report ${t.report}).` };
  return { result: 'fail', evidence: tail(`Test ${t.id} failed${time} (report ${t.report})${t.message ? `: ${t.message}` : ''}`, 1500) };
}

function reviewPrompt(db: Database.Database, run: StartedRun, diff: string): string {
  const brief = buildBrief(db, run.task_id);
  const review = run.criteria.filter(c => c.verify_kind === 'review');
  return [
    'You are reviewing a code change against acceptance criteria. You did not write it.',
    'Judge each criterion below only from the diff and the files in the current directory, which is a checkout of the submitted commit.',
    'A criterion passes only if you can point at the code that satisfies it. If unsure, it fails.',
    '',
    `Task: ${brief.task.key} ${brief.task.title}`,
    brief.spec ? `Spec ${brief.spec.key} v${brief.spec.version}: ${brief.spec.title}\nObjective: ${brief.spec.objective}\nApproach: ${brief.spec.approach ?? '-'}` : '',
    '',
    'Criteria to judge:',
    ...review.map(c => `- ${c.key}: ${c.statement}${c.verify_ref ? ` (check: ${c.verify_ref})` : ''}`),
    '',
    'Reply with JSON only, no prose and no code fence:',
    '{"results":[{"criterion":"<key>","result":"pass"|"fail","rationale":"<why, citing files and lines>"}]}',
    '',
    'Diff against the base branch:',
    diff,
  ].join('\n');
}

// The reviewer's stdout: the first JSON object holding a results array.
export function parseReviewOutput(out: string): { criterion: string; result: string; rationale: string }[] {
  let text = out.trim();
  // `claude -p --output-format json` wraps the answer in { result: "..." }.
  try {
    const outer = JSON.parse(text);
    if (outer && typeof outer.result === 'string') text = outer.result;
    else if (outer && Array.isArray(outer.results)) return outer.results;
  } catch { /* plain text, look for the object below */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new VerifierError('The reviewer returned no JSON.');
  let parsed: any;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new VerifierError('The reviewer output is not valid JSON.');
  }
  if (!Array.isArray(parsed?.results)) throw new VerifierError('The reviewer JSON has no results array.');
  return parsed.results;
}

async function runReview(db: Database.Database, run: StartedRun, worktree: string, reviewer: Verifier, timeoutMs: number): Promise<void> {
  const review = run.criteria.filter(c => c.verify_kind === 'review');
  const base = run.config.reviewer?.base_branch ?? 'main';
  let diff = git(worktree, ['diff', `${base}...HEAD`]);
  if (!diff.ok) diff = git(worktree, ['diff', `origin/${base}...HEAD`]);
  if (!diff.ok) throw new VerifierError(`Could not diff against ${base}: ${diff.out.slice(0, 200)}`);
  const text = diff.out.length > DIFF_MAX ? `${diff.out.slice(0, DIFF_MAX)}\n[diff truncated]` : diff.out;
  const command = run.config.reviewer?.command ?? DEFAULT_REVIEWER_COMMAND;
  const res = await exec(command, worktree, timeoutMs, reviewPrompt(db, run, text));
  if (res.timed_out) throw new VerifierError(`Reviewer command timed out after ${Math.round(timeoutMs / 60000)} minutes.`);
  if (res.exit_code !== 0) throw new VerifierError(`Reviewer command exited ${res.exit_code}: ${tail(res.output, 300)}`);
  const verdicts = parseReviewOutput(res.output);
  const results: CriterionInput[] = review.map(c => {
    const v = verdicts.find(x => typeof x?.criterion === 'string' && x.criterion.toLowerCase() === c.key.toLowerCase());
    if (!v || (v.result !== 'pass' && v.result !== 'fail')) return { criterion_id: c.id, result: 'missing', evidence: 'The reviewer gave no verdict.' };
    const rationale = String(v.rationale ?? '').trim();
    if (v.result === 'pass' && !rationale) return { criterion_id: c.id, result: 'missing', evidence: 'The reviewer passed it without a rationale.' };
    return { criterion_id: c.id, result: v.result, evidence: tail(rationale || 'No rationale given.', 1500) };
  });
  recordCriteria(db, reviewer, run.run_id, results, run.head_sha);
}

// Verify one started run end to end. Returns the server's verdict.
async function verifyRun(db: Database.Database, local: Verifier, reviewer: Verifier | null, run: StartedRun, log: (l: string) => void) {
  const timeoutMs = (run.config.check_timeout_minutes ?? DEFAULT_CHECK_TIMEOUT_MINUTES) * 60_000;
  const environment = { os: `${platform()} ${release()}`, node: process.version, verifier: local.actor.id };
  let worktree: string | null = null;
  try {
    if (!run.repo_path) throw new VerifierError('The project has no repo_path; set it with set_project_repo_path.');
    const tests = run.criteria.filter(c => c.verify_kind === 'test');
    const reports = Object.entries(run.config.checks ?? {}).filter(([name, c]) => c?.report && run.checks.some(k => k.name === name));
    if (tests.length && reports.length === 0) {
      throw new VerifierError('The task has test criteria but no check names a test report in the verifier config.');
    }
    // A command criterion's verify_ref is executed. Run it only when a human
    // approved the spec it comes from: a declared agent:architect can approve
    // a low-risk spec on its own.
    if (run.criteria.some(c => c.verify_kind === 'command') && !/(^|\s)human:/.test(run.spec_approved_by ?? '')) {
      throw new VerifierError('The task has command criteria on a spec no human approved; the verifier runs only human-approved commands.');
    }
    if (run.criteria.some(c => c.verify_kind === 'review') && !reviewer) {
      throw new VerifierError('The task has review criteria but MINDPM_REVIEWER_KEY is not set.');
    }

    worktree = checkoutWorktree(run.repo_path, run.head_sha);
    log(`  checked out ${run.head_sha} in ${worktree}`);

    const cases: TestCase[] = [];
    for (const check of run.checks) {
      const cfg = run.config.checks?.[check.name];
      const res = await exec(check.command, worktree, (cfg?.timeout_minutes ?? timeoutMs / 60_000) * 60_000);
      if (res.timed_out) throw new VerifierError(`Check ${check.name} timed out after ${Math.round((cfg?.timeout_minutes ?? timeoutMs / 60_000))} minutes.`);
      let report: ReturnType<typeof summarize> | undefined;
      if (cfg?.report) {
        const parsed = readReport(worktree, cfg.report.path, cfg.report.format);
        if (parsed) {
          cases.push(...parsed);
          report = summarize(parsed, cfg.report.path, cfg.report.format);
        } else if (res.exit_code === 0) {
          throw new VerifierError(`Check ${check.name} passed but wrote no report at ${cfg.report.path}.`);
        }
      }
      log(`  ${check.name}: exit ${res.exit_code} (${res.duration_ms} ms)${report ? `, ${report.passed}/${report.total} tests passed` : ''}`);
      recordChecks(db, local, run.run_id, [{
        name: check.name, command: check.command, exit_code: res.exit_code, duration_ms: res.duration_ms,
        output_tail: tail(res.output, OUTPUT_TAIL_MAX), ...(report ? { report } : {}),
      }], run.head_sha);
    }

    const results: CriterionInput[] = [];
    for (const c of run.criteria) {
      if (c.verify_kind === 'test') {
        results.push({ criterion_id: c.id, ...(c.verify_ref ? testEvidence(c.verify_ref, cases) : { result: 'missing', evidence: 'No test named in verify_ref.' }) });
      } else if (c.verify_kind === 'command') {
        if (!c.verify_ref) {
          results.push({ criterion_id: c.id, result: 'missing', evidence: 'No command named in verify_ref.' });
          continue;
        }
        const res = await exec(c.verify_ref, worktree, timeoutMs);
        if (res.timed_out) throw new VerifierError(`Command for ${c.key} timed out.`);
        results.push({
          criterion_id: c.id,
          result: res.exit_code === 0 ? 'pass' : 'fail',
          evidence: tail(`$ ${c.verify_ref}\nexit ${res.exit_code}\n${tail(res.output, 1000)}`, 1500),
        });
      }
    }
    if (results.length) recordCriteria(db, local, run.run_id, results, run.head_sha);
    if (reviewer && run.criteria.some(c => c.verify_kind === 'review')) {
      log('  running reviewer');
      await runReview(db, run, worktree, reviewer, timeoutMs);
    }
    return finishVerification(db, local, run.run_id, { environment });
  } catch (err) {
    if (err instanceof VerifierError) {
      log(`  error: ${err.message}`);
      return finishVerification(db, local, run.run_id, { errorReason: err.message, environment });
    }
    if (err instanceof ToolError && (err.code === 'lease_expired' || err.code === 'run_ended')) {
      log(`  run ended: ${err.message}`);
      return { run_status: 'error' as const, task_status: 'needs_verification' };
    }
    // Anything else is a bug in the verifier: end the run as error so the
    // task isn't stuck until the lease expires, then rethrow.
    try {
      finishVerification(db, local, run.run_id, { errorReason: `Verifier crashed: ${(err as Error).message}`, environment });
    } catch { /* the run may already be over */ }
    throw err;
  } finally {
    if (worktree && run.repo_path) removeWorktree(run.repo_path, worktree);
  }
}

export async function verifyOnce(db: Database.Database, local: Verifier, reviewer: Verifier | null, opts: Pick<VerifyOptions, 'task' | 'project' | 'log'>) {
  const projectId = opts.project ? resolveProjectId(opts.project) : undefined;
  if (opts.project && !projectId) throw new ToolError('not_found', `Project "${opts.project}" not found.`);
  const pending = opts.task
    ? [{ key: opts.task }]
    : pendingVerifications(db, local, projectId ?? undefined);
  const outcomes: { key: string; run_status: string; task_status: string }[] = [];
  for (const p of pending) {
    let run: StartedRun;
    try {
      run = startVerification(db, local, p.key);
    } catch (err) {
      if (err instanceof ToolError) {
        opts.log(`${p.key}: ${err.message}`);
        continue;
      }
      throw err;
    }
    opts.log(`${run.key}: verifying ${run.head_sha}`);
    const out = await verifyRun(db, local, reviewer, run, opts.log);
    opts.log(`${run.key}: ${out.run_status} → ${out.task_status}`);
    outcomes.push({ key: run.key, ...out });
  }
  return outcomes;
}

export function parseVerifyArgs(argv: string[]): VerifyOptions {
  const opts: VerifyOptions = { once: false, intervalSeconds: 30, log: line => process.stderr.write(`${line}\n`) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--once') opts.once = true;
    else if (a === '--task') opts.task = value();
    else if (a === '--project') opts.project = value();
    else if (a === '--interval') opts.intervalSeconds = Math.max(5, parseInt(value(), 10) || 30);
    else if (a === '--help' || a === '-h') throw new Error('help');
    else throw new Error(`Unknown option ${a}`);
  }
  if (opts.task) opts.once = true;
  return opts;
}

export const VERIFY_USAGE = `Usage: mindpm verify [--once] [--task <key>] [--project <name>] [--interval <seconds>]

Verifies tasks waiting in needs_verification from a clean checkout of the
submitted commit. Reads MINDPM_VERIFIER_KEY (a local key) and, for review
criteria, MINDPM_REVIEWER_KEY. Register keys in the Kanban UI. Never put
either key in the environment an agent runs in.`;

export async function runVerifyCli(argv: string[], db: Database.Database): Promise<number> {
  let opts: VerifyOptions;
  try {
    opts = parseVerifyArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message === 'help' ? '' : `${(err as Error).message}\n\n`}${VERIFY_USAGE}\n`);
    return (err as Error).message === 'help' ? 0 : 2;
  }
  let local: Verifier;
  let reviewer: Verifier | null = null;
  try {
    local = authenticateVerifier(db, process.env.MINDPM_VERIFIER_KEY);
    if (local.row.kind !== 'local') throw new ToolError('forbidden', 'MINDPM_VERIFIER_KEY must be a local verifier key.');
    if (process.env.MINDPM_REVIEWER_KEY) {
      reviewer = authenticateVerifier(db, process.env.MINDPM_REVIEWER_KEY);
      if (reviewer.row.kind !== 'reviewer') throw new ToolError('forbidden', 'MINDPM_REVIEWER_KEY must be a reviewer key.');
    }
  } catch (err) {
    process.stderr.write(`[mindpm verify] ${(err as Error).message}\n`);
    return 1;
  }
  opts.log(`[mindpm verify] running as ${local.actor.id}${reviewer ? ` with ${reviewer.actor.id}` : ''}`);
  for (;;) {
    const outcomes = await verifyOnce(db, local, reviewer, opts);
    if (opts.once) return outcomes.some(o => o.run_status === 'error') ? 1 : 0;
    await new Promise(r => setTimeout(r, opts.intervalSeconds * 1000));
  }
}
