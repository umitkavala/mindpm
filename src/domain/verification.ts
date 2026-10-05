import type Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { generateId } from '../utils/ids.js';
import { resolveRepoPath, resolveTaskId } from '../db/queries.js';
import { afterUsedAttempt, type AttemptRow } from './attempts.js';
import { assertDelegateMayAct, canTransition, moverOf, recordHistory, setStatus, ToolError, type Actor, type TaskStatus } from './lifecycle.js';
import { criterionKey, type CriterionRow, type RiskLevel, type SpecRow } from './specs.js';

// The verification gate (Phase 2). Verifiers authenticate with a key mindpm
// issues once; they record evidence, and the server decides the outcome.
// Shared by the MCP verifier tools, the HTTP routes and `mindpm verify`.

export const RUN_LEASE_MINUTES = 30;
export const MAX_CONSECUTIVE_ERRORS = 3;
export const OUTPUT_TAIL_MAX = 4000;
export const FINDINGS_TAIL_MAX = 1500;
const EVIDENCE_MAX = 1500;
const ERROR_REASON_MAX = 600;
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export type VerifierKind = 'local' | 'reviewer';

export interface VerifierRow {
  id: string;
  name: string;
  kind: VerifierKind;
  key_hash: string;
  project_ids: string;
  created_by: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface RunRow {
  id: string;
  task_id: string;
  attempt_id: string;
  verifier_id: string;
  head_sha: string;
  spec_version: number | null;
  status: 'running' | 'passed' | 'failed' | 'error' | 'superseded';
  error_reason: string | null;
  environment: string | null;
  started_at: string;
  lease_expires_at: string;
  ended_at: string | null;
}

// An authenticated verifier: its row plus the actor its writes are recorded as.
export interface Verifier { row: VerifierRow; actor: Actor }

export interface CheckPlan { name: string; command: string }

// Per-project settings for `mindpm verify`, edited in the UI only. They hold
// every command the verifier executes: an agent that could change them could
// set the unit check to `true` or point the reviewer at `echo pass`. The
// project's verification_defaults and a task's verification are hints for
// the executor's brief and are never run by the verifier.
export interface CheckConfig { command: string; report?: { path: string; format: 'junit' | 'json' }; timeout_minutes?: number }
export interface VerifierConfig {
  check_timeout_minutes?: number;
  checks?: Record<string, CheckConfig>;
  reviewer?: { command?: string; base_branch?: string };
}

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const projectIdsOf = (v: VerifierRow) => parseJson<string[]>(v.project_ids, []);
const covers = (v: VerifierRow, projectId: string) => {
  const ids = projectIdsOf(v);
  return ids.includes('*') || ids.includes(projectId);
};

function requireUi(actor: Actor, what: string): void {
  if (actor.channel !== 'ui') throw new ToolError('forbidden', `${what} is only possible in the Kanban UI.`);
}

export function publicVerifier(v: VerifierRow) {
  const { key_hash: _omit, project_ids, ...rest } = v;
  return { ...rest, actor: `verifier:${v.name}`, project_ids: parseJson<string[]>(project_ids, []) };
}

// --- Keys -----------------------------------------------------------------

// Creates a verifier and returns its key. The key is shown once; only its hash
// is stored. UI only, so an agent cannot mint its own key.
export function registerVerifier(
  db: Database.Database,
  input: { name: string; kind: VerifierKind; project_ids: string[] },
  actor: Actor,
): { verifier: ReturnType<typeof publicVerifier>; key: string } {
  requireUi(actor, 'Registering a verifier');
  if (!NAME_RE.test(input.name)) throw new ToolError('invalid_name', 'Verifier names are 1-64 letters, digits, dots, dashes or underscores.');
  if (input.kind !== 'local' && input.kind !== 'reviewer') throw new ToolError('invalid_kind', 'kind must be local or reviewer.');
  const ids = [...new Set(input.project_ids)];
  if (ids.length === 0) throw new ToolError('invalid_projects', 'Name at least one project, or "*" for all.');
  for (const id of ids) {
    if (id !== '*' && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) {
      throw new ToolError('not_found', `Project "${id}" not found.`);
    }
  }
  if (db.prepare('SELECT 1 FROM verifiers WHERE name = ?').get(input.name)) {
    throw new ToolError('name_taken', `A verifier named "${input.name}" already exists.`);
  }
  const key = `mpv_${randomBytes(32).toString('base64url')}`;
  const id = generateId();
  db.prepare(
    'INSERT INTO verifiers (id, name, kind, key_hash, project_ids, created_by) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, input.name, input.kind, hashKey(key), JSON.stringify(ids), actor.id);
  const row = db.prepare('SELECT * FROM verifiers WHERE id = ?').get(id) as VerifierRow;
  return { verifier: publicVerifier(row), key };
}

export function listVerifiers(db: Database.Database) {
  return (db.prepare('SELECT * FROM verifiers ORDER BY revoked_at IS NOT NULL, created_at DESC').all() as VerifierRow[]).map(publicVerifier);
}

// Disables a key at once. Runs in progress under it end as error.
export function revokeVerifier(db: Database.Database, verifierId: string, actor: Actor): void {
  requireUi(actor, 'Revoking a verifier');
  db.transaction(() => {
    const v = db.prepare('SELECT * FROM verifiers WHERE id = ?').get(verifierId) as VerifierRow | undefined;
    if (!v) throw new ToolError('not_found', 'Verifier not found.');
    if (v.revoked_at) return;
    db.prepare('UPDATE verifiers SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?').run(v.id);
    const running = db.prepare("SELECT * FROM verification_runs WHERE verifier_id = ? AND status = 'running'").all(v.id) as RunRow[];
    for (const run of running) endRunAsError(db, run, 'Verifier key revoked.', actor);
  }).immediate();
}

export function authenticateVerifier(db: Database.Database, key: string | undefined | null): Verifier {
  if (!key) throw new ToolError('invalid_key', 'A verifier key is required.');
  const row = db.prepare('SELECT * FROM verifiers WHERE key_hash = ?').get(hashKey(key)) as VerifierRow | undefined;
  if (!row) throw new ToolError('invalid_key', 'Unknown verifier key.');
  if (row.revoked_at) throw new ToolError('revoked', `The key for verifier:${row.name} was revoked.`);
  db.prepare('UPDATE verifiers SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
  return { row, actor: { id: `verifier:${row.name}`, kind: 'verifier', verifierId: row.id } };
}

// --- Runs -----------------------------------------------------------------

interface TaskRow {
  id: string;
  project_id: string;
  status: string;
  spec_id: string | null;
  max_attempts: number | null;
  verification: string | null;
  key: string;
  title: string;
}

function requireTask(db: Database.Database, ref: string): TaskRow {
  const id = resolveTaskId(ref);
  if (!id) throw new ToolError('not_found', `Task "${ref}" not found.`);
  return db.prepare(
    "SELECT t.*, p.slug || '-' || t.seq AS key FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.id = ?",
  ).get(id) as TaskRow;
}

export function latestSubmission(db: Database.Database, taskId: string): AttemptRow | undefined {
  return db.prepare(
    "SELECT * FROM attempts WHERE task_id = ? AND outcome = 'submitted' ORDER BY attempt_no DESC LIMIT 1",
  ).get(taskId) as AttemptRow | undefined;
}

export function riskOf(db: Database.Database, task: { spec_id: string | null }): RiskLevel {
  // A plain task has no declared risk, so it is treated as medium.
  if (!task.spec_id) return 'medium';
  return (db.prepare('SELECT risk_level FROM specs WHERE id = ?').get(task.spec_id) as { risk_level: RiskLevel }).risk_level;
}

// Checks the verifier runs: the human-owned verifier config, nothing else.
export function plannedChecks(db: Database.Database, projectId: string): CheckPlan[] {
  return Object.entries(verifierConfig(db, projectId).checks ?? {})
    .filter(([, c]) => typeof c?.command === 'string' && c.command.trim())
    .map(([name, c]) => ({ name, command: c.command }));
}

export function verifierConfig(db: Database.Database, projectId: string): VerifierConfig {
  const row = db.prepare('SELECT verifier_config FROM projects WHERE id = ?').get(projectId) as { verifier_config: string | null } | undefined;
  return parseJson<VerifierConfig>(row?.verifier_config ?? null, {});
}

export function setVerifierConfig(db: Database.Database, projectId: string, config: unknown, actor: Actor): VerifierConfig {
  requireUi(actor, 'Changing the verifier config');
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new ToolError('invalid_config', 'The verifier config must be a JSON object.');
  const c = config as VerifierConfig;
  if (c.reviewer !== undefined && (typeof c.reviewer !== 'object' || (c.reviewer.command !== undefined && typeof c.reviewer.command !== 'string'))) {
    throw new ToolError('invalid_config', 'reviewer.command must be a string.');
  }
  if (c.check_timeout_minutes !== undefined && !(typeof c.check_timeout_minutes === 'number' && c.check_timeout_minutes > 0)) {
    throw new ToolError('invalid_config', 'check_timeout_minutes must be a positive number.');
  }
  if (c.checks !== undefined && (typeof c.checks !== 'object' || Array.isArray(c.checks))) {
    throw new ToolError('invalid_config', 'checks must be an object keyed by check name.');
  }
  for (const [name, check] of Object.entries(c.checks ?? {})) {
    if (!check || typeof check.command !== 'string' || !check.command.trim()) {
      throw new ToolError('invalid_config', `checks.${name} needs a command.`);
    }
    if (check.timeout_minutes !== undefined && !(typeof check.timeout_minutes === 'number' && check.timeout_minutes > 0)) {
      throw new ToolError('invalid_config', `checks.${name}.timeout_minutes must be a positive number.`);
    }
    const fmt = check?.report?.format;
    if (check?.report && (!check.report.path || (fmt !== 'junit' && fmt !== 'json'))) {
      throw new ToolError('invalid_config', `checks.${name}.report needs a path and a format of junit or json.`);
    }
  }
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new ToolError('not_found', 'Project not found.');
  db.prepare('UPDATE projects SET verifier_config = ? WHERE id = ?').run(JSON.stringify(c), projectId);
  return c;
}

// --- The per-project switch -------------------------------------------------

// Off (the default): a human accepts submitted work straight from
// needs_verification. On: a verifier must pass it first. UI only, like the
// config: an agent that could switch it off could skip its own checks.
export type VerificationMode = 'off' | 'on';

export function verificationMode(db: Database.Database, projectId: string): VerificationMode {
  const row = db.prepare('SELECT verification FROM projects WHERE id = ?').get(projectId) as { verification: string | null } | undefined;
  return row?.verification === 'on' ? 'on' : 'off';
}

export interface VerificationSetup {
  mode: VerificationMode;
  // What turning it on still needs; empty when it can be turned on.
  missing: string[];
  // Set when it is on but can no longer run, e.g. after the last key was revoked.
  warning: string | null;
}

export function verificationSetup(db: Database.Database, projectId: string): VerificationSetup {
  const mode = verificationMode(db, projectId);
  const missing: string[] = [];
  const active = (db.prepare("SELECT * FROM verifiers WHERE revoked_at IS NULL AND kind = 'local'").all() as VerifierRow[])
    .some(v => covers(v, projectId));
  if (!active) missing.push('a local verifier key that covers this project');
  if (plannedChecks(db, projectId).length === 0) missing.push('a saved verifier config with at least one check');
  const warning = mode === 'on' && missing.length > 0
    ? `Verification is on, but this project has no ${missing.join(' and no ')}. Submitted tasks will wait until you fix that or turn verification off.`
    : null;
  return { mode, missing, warning };
}

export function setVerificationMode(db: Database.Database, projectId: string, mode: unknown, actor: Actor): VerificationSetup {
  requireUi(actor, 'Turning verification on or off');
  if (mode !== 'on' && mode !== 'off') throw new ToolError('invalid_mode', 'verification must be "on" or "off".');
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new ToolError('not_found', 'Project not found.');
    const before = verificationSetup(db, projectId);
    if (before.mode === mode) return before;
    if (mode === 'on' && before.missing.length > 0) {
      throw new ToolError('not_ready', `Verification stays off: this project needs ${before.missing.join(' and ')}.`);
    }
    db.prepare('UPDATE projects SET verification = ? WHERE id = ?').run(mode, projectId);
    db.prepare(
      'INSERT INTO project_history (id, project_id, event, old_value, new_value, actor) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(generateId(), projectId, 'verification_changed', before.mode, mode, actor.id);
    return verificationSetup(db, projectId);
  }).immediate();
}

function taskCriteria(db: Database.Database, task: { id: string; spec_id: string | null }) {
  if (!task.spec_id) return [];
  const spec = db.prepare('SELECT * FROM specs WHERE id = ?').get(task.spec_id) as SpecRow;
  const rows = db.prepare(
    'SELECT c.* FROM acceptance_criteria c JOIN task_criteria tc ON tc.criterion_id = c.id WHERE tc.task_id = ? ORDER BY c.seq',
  ).all(task.id) as CriterionRow[];
  return rows.map(c => ({ id: c.id, key: criterionKey(spec, c), statement: c.statement, verify_kind: c.verify_kind, verify_ref: c.verify_ref }));
}

// Lazy lease expiry for runs, run at the start of every verifier call and
// every read that lists work waiting for a verifier.
export function expireRuns(db: Database.Database): void {
  const expired = db.prepare(
    "SELECT * FROM verification_runs WHERE status = 'running' AND lease_expires_at <= datetime('now')",
  ).all() as RunRow[];
  if (expired.length === 0) return;
  db.transaction(() => {
    for (const run of expired) endRunAsError(db, run, 'Run lease expired.', 'system');
  }).immediate();
}

// A verifier error: the check broke, not the code. The task stays in
// needs_verification and no attempt is used, until the third error in a row
// on the same attempt sends it to a human.
function endRunAsError(db: Database.Database, run: RunRow, reason: string, actor: Actor | 'system'): { task_status: string } {
  const trimmed = reason.slice(0, ERROR_REASON_MAX);
  db.prepare("UPDATE verification_runs SET status = 'error', error_reason = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?").run(trimmed, run.id);
  db.prepare('UPDATE attempts SET consecutive_errors = consecutive_errors + 1 WHERE id = ?').run(run.attempt_id);
  recordHistory(db, run.task_id, 'verification_error', null, JSON.stringify({ run_id: run.id, reason: trimmed }), actor, run.attempt_id);
  const errors = (db.prepare('SELECT consecutive_errors FROM attempts WHERE id = ?').get(run.attempt_id) as { consecutive_errors: number }).consecutive_errors;
  const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(run.task_id) as { status: string };
  if (errors >= MAX_CONSECUTIVE_ERRORS && task.status === 'needs_verification') {
    const reasons = (db.prepare(
      "SELECT error_reason FROM verification_runs WHERE attempt_id = ? AND status IN ('error', 'superseded') AND error_reason IS NOT NULL ORDER BY started_at DESC LIMIT ?",
    ).all(run.attempt_id, MAX_CONSECUTIVE_ERRORS) as { error_reason: string }[]).map(r => r.error_reason);
    recordHistory(db, run.task_id, 'verification_stuck', null, JSON.stringify({ consecutive_errors: errors, reasons }), actor, run.attempt_id);
    setStatus(db, run.task_id, 'needs_verification', 'needs_human', actor === 'system' ? 'system' : actor, run.attempt_id);
    return { task_status: 'needs_human' };
  }
  return { task_status: task.status };
}

export interface PendingVerification { task_id: string; key: string; title: string; head_sha: string; risk_level: RiskLevel; submitted_at: string }

// Tasks waiting for a verifier: in needs_verification with a submitted SHA
// and no running run, in projects the key covers, oldest submission first.
// Legacy tasks without a submission can't be verified and are left out, and
// so are projects with verification off: a human accepts those directly.
export function pendingVerifications(db: Database.Database, verifier: Verifier, projectId?: string): PendingVerification[] {
  expireRuns(db);
  const rows = db.prepare(
    `SELECT t.id AS task_id, p.slug || '-' || t.seq AS key, t.title, t.project_id, t.spec_id, a.head_sha, a.ended_at AS submitted_at
     FROM tasks t
     JOIN projects p ON p.id = t.project_id
     JOIN attempts a ON a.id = (SELECT id FROM attempts WHERE task_id = t.id AND outcome = 'submitted' ORDER BY attempt_no DESC LIMIT 1)
     WHERE t.status = 'needs_verification' AND a.head_sha IS NOT NULL AND p.verification = 'on'
       AND NOT EXISTS (SELECT 1 FROM verification_runs r WHERE r.task_id = t.id AND r.status = 'running')
       ${projectId ? 'AND t.project_id = ?' : ''}
     ORDER BY a.ended_at ASC, t.seq ASC`,
  ).all(...(projectId ? [projectId] : [])) as (Omit<PendingVerification, 'risk_level'> & { project_id: string; spec_id: string | null })[];
  return rows
    .filter(r => covers(verifier.row, r.project_id))
    .map(({ project_id: _p, spec_id, ...r }) => ({ ...r, risk_level: riskOf(db, { spec_id }) }));
}

export interface StartedRun {
  run_id: string;
  task_id: string;
  key: string;
  head_sha: string;
  branch: string | null;
  repo_path: string | null;
  lease_expires_at: string;
  spec_version: number | null;
  // Who approved the spec; the verifier runs command criteria only when a
  // human did.
  spec_approved_by: string | null;
  checks: CheckPlan[];
  criteria: ReturnType<typeof taskCriteria>;
  config: VerifierConfig;
}

export function startVerification(db: Database.Database, verifier: Verifier, taskRef: string): StartedRun {
  if (verifier.row.kind !== 'local') throw new ToolError('forbidden', 'Only a local verifier key can start a run. Reviewer keys record review criteria in a run a local verifier started.');
  expireRuns(db);
  return db.transaction(() => {
    const task = requireTask(db, taskRef);
    if (!covers(verifier.row, task.project_id)) throw new ToolError('forbidden', `verifier:${verifier.row.name} does not cover this project.`);
    if (verificationMode(db, task.project_id) === 'off') {
      throw new ToolError('verification_off', `Verification is off for ${task.key}'s project; a human accepts its work directly.`);
    }
    if (task.status !== 'needs_verification') throw new ToolError('not_pending', `${task.key} is ${task.status}, not needs_verification.`);
    const attempt = latestSubmission(db, task.id);
    if (!attempt?.head_sha) {
      throw new ToolError('not_verifiable', `${task.key} has no submitted commit to verify. A human can accept legacy tasks in the UI.`);
    }
    if (db.prepare("SELECT 1 FROM verification_runs WHERE task_id = ? AND status = 'running'").get(task.id)) {
      throw new ToolError('already_running', `${task.key} already has a verification run in progress.`);
    }
    db.prepare(
      "UPDATE verification_runs SET status = 'superseded' WHERE attempt_id = ? AND status IN ('passed', 'failed', 'error')",
    ).run(attempt.id);
    const specVersion = task.spec_id
      ? (db.prepare('SELECT version FROM specs WHERE id = ?').get(task.spec_id) as { version: number }).version
      : null;
    const runId = generateId();
    db.prepare(
      `INSERT INTO verification_runs (id, task_id, attempt_id, verifier_id, head_sha, spec_version, lease_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`,
    ).run(runId, task.id, attempt.id, verifier.row.id, attempt.head_sha, specVersion, `+${RUN_LEASE_MINUTES} minutes`);
    recordHistory(db, task.id, 'verification_started', null, JSON.stringify({ run_id: runId, head_sha: attempt.head_sha }), verifier.actor, attempt.id);
    const run = db.prepare('SELECT * FROM verification_runs WHERE id = ?').get(runId) as RunRow;
    return {
      run_id: runId,
      task_id: task.id,
      key: task.key,
      head_sha: attempt.head_sha,
      branch: (db.prepare('SELECT branch FROM attempts WHERE id = ?').get(attempt.id) as { branch: string | null }).branch,
      repo_path: resolveRepoPath(task.project_id),
      lease_expires_at: run.lease_expires_at,
      spec_version: specVersion,
      checks: plannedChecks(db, task.project_id),
      spec_approved_by: task.spec_id
        ? (db.prepare('SELECT approved_by FROM specs WHERE id = ?').get(task.spec_id) as { approved_by: string | null }).approved_by
        : null,
      criteria: taskCriteria(db, task),
      config: verifierConfig(db, task.project_id),
    };
  }).immediate();
}

// Short SHAs are allowed on either side; they must agree on the shorter one.
export function shaMatches(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return Math.min(x.length, y.length) >= 7 && (x.startsWith(y) || y.startsWith(x));
}

function requireRun(db: Database.Database, verifier: Verifier, runId: string, opts: { owner: boolean; headSha?: string }): { run: RunRow; task: TaskRow } {
  const run = db.prepare('SELECT * FROM verification_runs WHERE id = ?').get(runId) as RunRow | undefined;
  if (!run) throw new ToolError('not_found', `Run "${runId}" not found.`);
  const task = requireTask(db, run.task_id);
  if (!covers(verifier.row, task.project_id)) throw new ToolError('forbidden', `verifier:${verifier.row.name} does not cover this project.`);
  if (opts.owner && run.verifier_id !== verifier.row.id) throw new ToolError('forbidden', 'This run belongs to another verifier.');
  if (run.status !== 'running') {
    throw new ToolError(run.error_reason === 'Run lease expired.' ? 'lease_expired' : 'run_ended', `This run already ended (${run.status}${run.error_reason ? `: ${run.error_reason}` : ''}).`);
  }
  if (opts.headSha !== undefined && !shaMatches(opts.headSha, run.head_sha)) {
    throw new ToolError('sha_mismatch', `Results are for ${opts.headSha}, but this run verifies ${run.head_sha}.`);
  }
  return { run, task };
}

function extendLease(db: Database.Database, runId: string): string {
  db.prepare("UPDATE verification_runs SET lease_expires_at = datetime('now', ?) WHERE id = ?").run(`+${RUN_LEASE_MINUTES} minutes`, runId);
  return (db.prepare('SELECT lease_expires_at FROM verification_runs WHERE id = ?').get(runId) as { lease_expires_at: string }).lease_expires_at;
}

export interface CheckInput { name: string; command: string; exit_code: number | null; duration_ms?: number | null; output_tail?: string | null; report?: unknown }

// What was executed. Local keys only; re-recording a check name replaces it.
export function recordChecks(db: Database.Database, verifier: Verifier, runId: string, checks: CheckInput[], headSha?: string): { lease_expires_at: string } {
  if (verifier.row.kind !== 'local') throw new ToolError('forbidden', 'Only a local verifier key can record check results.');
  expireRuns(db);
  return db.transaction(() => {
    const { run } = requireRun(db, verifier, runId, { owner: true, headSha });
    const upsert = db.prepare(
      `INSERT INTO check_results (id, run_id, name, command, exit_code, duration_ms, output_tail, report) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, name) DO UPDATE SET command = excluded.command, exit_code = excluded.exit_code,
         duration_ms = excluded.duration_ms, output_tail = excluded.output_tail, report = excluded.report`,
    );
    for (const c of checks) {
      if (!c.name?.trim() || !c.command?.trim()) throw new ToolError('invalid_check', 'Every check needs a name and the command that ran.');
      const tail = c.output_tail ? c.output_tail.slice(-OUTPUT_TAIL_MAX) : null;
      upsert.run(generateId(), run.id, c.name, c.command, c.exit_code ?? null, c.duration_ms ?? null, tail, c.report === undefined ? null : JSON.stringify(c.report));
    }
    return { lease_expires_at: extendLease(db, run.id) };
  }).immediate();
}

export interface CriterionInput { criterion_id: string; result: 'pass' | 'fail' | 'missing'; evidence: string }

// What was concluded. test and command criteria: local keys. review
// criteria: reviewer keys only.
export function recordCriteria(
  db: Database.Database, verifier: Verifier, runId: string, results: CriterionInput[], headSha?: string,
): { lease_expires_at: string; criteria_remaining: string[] } {
  expireRuns(db);
  return db.transaction(() => {
    const { run, task } = requireRun(db, verifier, runId, { owner: verifier.row.kind === 'local', headSha });
    const criteria = taskCriteria(db, task);
    const upsert = db.prepare(
      `INSERT INTO criterion_results (id, run_id, criterion_id, result, source, evidence, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, criterion_id) DO UPDATE SET result = excluded.result, source = excluded.source,
         evidence = excluded.evidence, recorded_by = excluded.recorded_by`,
    );
    for (const r of results) {
      const c = criteria.find(x => x.id === r.criterion_id || x.key.toLowerCase() === r.criterion_id.toLowerCase());
      if (!c) throw new ToolError('invalid_criteria', `"${r.criterion_id}" is not a criterion of this task.`);
      if (!['pass', 'fail', 'missing'].includes(r.result)) throw new ToolError('invalid_result', 'result must be pass, fail or missing.');
      if (c.verify_kind === 'review' && verifier.row.kind !== 'reviewer') {
        throw new ToolError('forbidden', `${c.key} is a review criterion; only a reviewer key can judge it.`);
      }
      if (c.verify_kind !== 'review' && verifier.row.kind !== 'local') {
        throw new ToolError('forbidden', `${c.key} is a ${c.verify_kind} criterion; a reviewer key can only judge review criteria.`);
      }
      if (!r.evidence?.trim()) throw new ToolError('evidence_required', `${c.key} needs evidence.`);
      if (r.evidence.length > EVIDENCE_MAX) throw new ToolError('too_long', `Evidence is capped at ${EVIDENCE_MAX} characters.`);
      upsert.run(generateId(), run.id, c.id, r.result, c.verify_kind, r.evidence, verifier.row.id);
    }
    const recorded = new Set((db.prepare('SELECT criterion_id FROM criterion_results WHERE run_id = ?').all(run.id) as { criterion_id: string }[]).map(r => r.criterion_id));
    return {
      lease_expires_at: extendLease(db, run.id),
      criteria_remaining: criteria.filter(c => !recorded.has(c.id)).map(c => c.key),
    };
  }).immediate();
}

interface CheckResultRow { name: string; command: string; exit_code: number | null; duration_ms: number | null; output_tail: string | null; report: string | null }
interface CriterionResultRow { criterion_id: string; result: string; source: string; evidence: string; recorded_by: string }

export interface VerificationFindings {
  run_id: string;
  head_sha: string;
  failing_checks: string[];
  output_tail?: string;
  criteria: { key: string; result: string; evidence: string }[];
  spec_changed?: { submitted_against: number | null; verified_against: number | null; note: string };
}

// Executor said pass, verifier found otherwise.
function selfReportMismatch(attempt: AttemptRow, verdicts: Map<string, string>): boolean {
  const reported = parseJson<{ criterion_id: string; result: string }[]>(attempt.criteria_results, []);
  return reported.some(r => r.result === 'pass' && verdicts.has(r.criterion_id) && verdicts.get(r.criterion_id) !== 'pass');
}

// Ends a run. With errorReason the run is an error (the check broke). Without,
// the server computes the outcome from what was recorded: passed only if every
// planned check ran and exited 0 and every criterion on the task is pass.
export function finishVerification(
  db: Database.Database, verifier: Verifier, runId: string, opts: { errorReason?: string; environment?: unknown } = {},
): { run_status: 'passed' | 'failed' | 'error'; task_status: string } {
  if (verifier.row.kind !== 'local') throw new ToolError('forbidden', 'Only the local verifier that started a run can finish it.');
  expireRuns(db);
  return db.transaction(() => {
    const { run, task } = requireRun(db, verifier, runId, { owner: true });
    if (opts.environment !== undefined) {
      db.prepare('UPDATE verification_runs SET environment = ? WHERE id = ?').run(JSON.stringify(opts.environment), run.id);
    }
    if (opts.errorReason?.trim()) {
      return { run_status: 'error' as const, ...endRunAsError(db, run, opts.errorReason.trim(), verifier.actor) };
    }

    const planned = plannedChecks(db, task.project_id);
    const criteria = taskCriteria(db, task);
    const checks = db.prepare('SELECT * FROM check_results WHERE run_id = ? ORDER BY rowid').all(run.id) as CheckResultRow[];
    if (planned.length === 0 && criteria.length === 0 && checks.length === 0) {
      return {
        run_status: 'error' as const,
        ...endRunAsError(db, run, 'Nothing to verify: no checks are configured and the task has no acceptance criteria.', verifier.actor),
      };
    }
    const results = db.prepare('SELECT * FROM criterion_results WHERE run_id = ?').all(run.id) as CriterionResultRow[];
    const byCriterion = new Map(results.map(r => [r.criterion_id, r]));

    const failingChecks = checks.filter(c => c.exit_code !== 0).map(c => c.name);
    const notRun = planned.filter(p => !checks.some(c => c.name === p.name)).map(p => p.name);
    const criteriaFindings = criteria
      .map(c => {
        const r = byCriterion.get(c.id);
        return r ? { key: c.key, result: r.result, evidence: r.evidence } : { key: c.key, result: 'missing', evidence: 'No result was recorded for this criterion.' };
      })
      .filter(f => f.result !== 'pass');
    const passed = failingChecks.length === 0 && notRun.length === 0 && criteriaFindings.length === 0;

    const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(run.attempt_id) as AttemptRow;
    const runStatus = passed ? 'passed' : 'failed';
    db.prepare('UPDATE verification_runs SET status = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?').run(runStatus, run.id);

    if (passed) {
      db.prepare("UPDATE attempts SET verification_outcome = 'passed', consecutive_errors = 0 WHERE id = ?").run(attempt.id);
      if (!canTransition(task.status, 'verified', 'verifier')) throw new ToolError('illegal_transition', `${task.status} → verified is not allowed.`);
      setStatus(db, task.id, task.status, 'verified', verifier.actor, attempt.id);
      db.prepare('UPDATE tasks SET verified_run_id = ? WHERE id = ?').run(run.id, task.id);
      return { run_status: 'passed' as const, task_status: 'verified' };
    }

    const firstFailing = checks.find(c => c.exit_code !== 0);
    const findings: VerificationFindings = {
      run_id: run.id,
      head_sha: run.head_sha,
      failing_checks: [...failingChecks, ...notRun.map(n => `${n} (not run)`)],
      ...(firstFailing?.output_tail ? { output_tail: firstFailing.output_tail.slice(-FINDINGS_TAIL_MAX) } : {}),
      criteria: criteriaFindings,
    };
    if (run.spec_version !== null && attempt.spec_version !== run.spec_version) {
      findings.spec_changed = {
        submitted_against: attempt.spec_version,
        verified_against: run.spec_version,
        note: 'The spec changed after this attempt was submitted. Its self-report was against the old criteria; this run used the new ones.',
      };
    }
    const buildFailed = failingChecks.some(n => /build|compile/i.test(n));
    const mismatch = selfReportMismatch(attempt, new Map(criteria.map(c => [c.id, byCriterion.get(c.id)?.result ?? 'missing'])));
    db.prepare(
      `UPDATE attempts SET verification_outcome = 'failed', verification_findings = ?, failure_type = ?,
       self_report_mismatch = ?, consecutive_errors = 0 WHERE id = ?`,
    ).run(JSON.stringify(findings), buildFailed ? 'build_error' : 'test_failure', mismatch ? 1 : 0, attempt.id);
    const to = afterUsedAttempt(db, task);
    if (!canTransition(task.status, to, 'verifier')) throw new ToolError('illegal_transition', `${task.status} → ${to} is not allowed.`);
    setStatus(db, task.id, task.status, to, verifier.actor, attempt.id);
    return { run_status: 'failed' as const, task_status: to };
  }).immediate();
}

// --- Human acceptance ------------------------------------------------------

// With verification off, needs_verification is where a human reviews
// submitted work: it can be accepted or reopened directly. A run a verifier
// started before the switch is superseded so it can't move the task later.
function unverifiedReviewAllowed(db: Database.Database, task: TaskRow): boolean {
  return task.status === 'needs_verification' && verificationMode(db, task.project_id) === 'off';
}

function supersedeRunningRuns(db: Database.Database, taskId: string, reason: string): void {
  db.prepare("UPDATE verification_runs SET status = 'superseded', error_reason = ?, ended_at = CURRENT_TIMESTAMP WHERE task_id = ? AND status = 'running'")
    .run(reason, taskId);
}

// verified → done. Through the UI for any risk; elsewhere (accept_tasks with a
// human or delegate) low risk only. With verification off, the same rules
// apply to needs_verification → done. With it on, legacy tasks that never had
// a submission can be accepted from needs_verification in the UI.
export function acceptTask(db: Database.Database, taskRef: string, actor: Actor): { task_id: string; key: string; status: TaskStatus } {
  const task = requireTask(db, taskRef);
  const ui = actor.channel === 'ui';
  if (actor.kind !== 'human') throw new ToolError('forbidden', `${actor.id} cannot accept work. Pass on_behalf_of with the human who asked.`);
  assertDelegateMayAct(db, actor, task.id);
  const direct = unverifiedReviewAllowed(db, task);
  if (task.status === 'needs_verification' && !direct) {
    if (!ui) throw new ToolError('illegal_transition', `${task.key} has not been verified yet.`);
    if (latestSubmission(db, task.id)?.head_sha) {
      throw new ToolError('illegal_transition', `${task.key} has a submitted commit; a verifier must verify it before it can be accepted.`);
    }
  } else if (task.status !== 'verified' && !direct) {
    throw new ToolError('illegal_transition', `${task.key} is ${task.status}; only verified tasks can be accepted.`);
  }
  const risk = riskOf(db, task);
  if (!ui && risk !== 'low') {
    throw new ToolError('illegal_transition', `${task.key} is ${risk} risk; it can only be accepted in the Kanban UI.`);
  }
  if (!direct && !canTransition(task.status, 'done', moverOf(actor))) {
    throw new ToolError('illegal_transition', `${task.status} → done is not allowed for ${actor.id}.`);
  }
  if (direct) supersedeRunningRuns(db, task.id, 'Accepted with verification off.');
  setStatus(db, task.id, task.status, 'done', actor, latestSubmission(db, task.id)?.id ?? null);
  return { task_id: task.id, key: task.key, status: 'done' };
}

// Accept several tasks; each one is accepted or refused on its own.
export function acceptTasks(db: Database.Database, taskRefs: string[], actor: Actor): { accepted: string[]; refused: { task_id: string; reason: string }[] } {
  const accepted: string[] = [];
  const refused: { task_id: string; reason: string }[] = [];
  for (const ref of taskRefs) {
    try {
      db.transaction(() => accepted.push(acceptTask(db, ref, actor).key)).immediate();
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
      refused.push({ task_id: ref, reason: err.message });
    }
  }
  return { accepted, refused };
}

// verified → ready with findings: a human overrides a pass. With verification
// off, also needs_verification → ready: a human rejects submitted work. The
// findings go into the attempt and the next brief, and the attempt is used.
export function reopenTask(db: Database.Database, taskRef: string, findings: string, actor: Actor): { task_id: string; status: TaskStatus } {
  requireUi(actor, 'Reopening submitted work');
  if (!findings?.trim()) throw new ToolError('findings_required', 'Reopening needs findings: what is wrong and what to change.');
  if (findings.length > 1500) throw new ToolError('too_long', 'findings are capped at 1500 characters.');
  return db.transaction(() => {
    const task = requireTask(db, taskRef);
    const direct = unverifiedReviewAllowed(db, task);
    if (task.status !== 'verified' && !direct) {
      throw new ToolError('illegal_transition', `${task.key} is ${task.status}; only verified tasks${task.status === 'needs_verification' ? ' (or submitted ones, with verification off)' : ''} can be reopened.`);
    }
    const attempt = latestSubmission(db, task.id);
    if (attempt) {
      db.prepare("UPDATE attempts SET review_decision = 'reject', review_findings = ?, reviewed_by = ? WHERE id = ?").run(findings, actor.id, attempt.id);
    }
    const to = afterUsedAttempt(db, task);
    if (!direct && !canTransition(task.status, to, moverOf(actor))) throw new ToolError('illegal_transition', `${task.status} → ${to} is not allowed.`);
    if (direct) supersedeRunningRuns(db, task.id, 'Reopened with verification off.');
    setStatus(db, task.id, task.status, to, actor, attempt?.id ?? null);
    return { task_id: task.id, status: to };
  }).immediate();
}

// --- Reads -----------------------------------------------------------------

export interface AwaitingTask { task_id: string; key: string; title: string; risk_level: RiskLevel; waiting_hours: number; kanban_url?: string }
export interface AwaitingAcceptance {
  low_risk: AwaitingTask[];
  needs_ui: AwaitingTask[];
  hint: string;
}

// Work waiting for a human, for the session brief: verified tasks, plus
// submitted ones when the project's verification is off.
export function awaitingAcceptance(db: Database.Database, projectId: string, kanbanBase: string | null): AwaitingAcceptance {
  const statuses = verificationMode(db, projectId) === 'off' ? "('verified', 'needs_verification')" : "('verified')";
  // Waiting since the verifier passed it, or else since it was submitted.
  const rows = db.prepare(
    `SELECT task_id, key, title, spec_id, (julianday('now') - julianday(since)) * 24 AS waiting_hours FROM (
       SELECT t.id AS task_id, p.slug || '-' || t.seq AS key, t.title, t.spec_id, COALESCE(
         (SELECT ended_at FROM verification_runs WHERE id = t.verified_run_id),
         (SELECT ended_at FROM attempts WHERE task_id = t.id AND outcome = 'submitted' ORDER BY attempt_no DESC LIMIT 1),
         t.updated_at) AS since
       FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.project_id = ? AND t.status IN ${statuses})
     ORDER BY since ASC`,
  ).all(projectId) as { task_id: string; key: string; title: string; spec_id: string | null; waiting_hours: number }[];
  const low_risk: AwaitingTask[] = [];
  const needs_ui: AwaitingTask[] = [];
  for (const r of rows) {
    const risk = riskOf(db, r);
    const item: AwaitingTask = { task_id: r.task_id, key: r.key, title: r.title, risk_level: risk, waiting_hours: Math.round(r.waiting_hours * 10) / 10 };
    if (risk === 'low') low_risk.push(item);
    else needs_ui.push(kanbanBase ? { ...item, kanban_url: `${kanbanBase}&task=${encodeURIComponent(r.key)}` } : item);
  }
  return {
    low_risk,
    needs_ui,
    hint: 'Show this to the user. Low-risk tasks can be accepted together with accept_tasks once the user asks; medium and high risk are accepted in the Kanban UI only.',
  };
}

// Every run on a task, newest first, with what was executed and concluded.
export function runsForTask(db: Database.Database, taskId: string) {
  const runs = db.prepare(
    `SELECT r.*, v.name AS verifier_name, a.attempt_no FROM verification_runs r
     JOIN verifiers v ON v.id = r.verifier_id JOIN attempts a ON a.id = r.attempt_id
     WHERE r.task_id = ? ORDER BY r.started_at DESC, r.rowid DESC`,
  ).all(taskId) as (RunRow & { verifier_name: string; attempt_no: number })[];
  const keyOf = new Map(taskCriteria(db, { id: taskId, spec_id: (db.prepare('SELECT spec_id FROM tasks WHERE id = ?').get(taskId) as { spec_id: string | null }).spec_id })
    .map(c => [c.id, c]));
  return runs.map(({ verifier_id: _v, environment, ...r }) => ({
    ...r,
    verifier: `verifier:${r.verifier_name}`,
    environment: parseJson<unknown>(environment, null),
    checks: (db.prepare('SELECT name, command, exit_code, duration_ms, output_tail, report FROM check_results WHERE run_id = ? ORDER BY rowid').all(r.id) as CheckResultRow[])
      .map(c => ({ ...c, report: parseJson<unknown>(c.report, null) })),
    criteria: (db.prepare(
      `SELECT cr.criterion_id, cr.result, cr.source, cr.evidence, v.name AS recorded_by FROM criterion_results cr
       JOIN verifiers v ON v.id = cr.recorded_by WHERE cr.run_id = ?`,
    ).all(r.id) as CriterionResultRow[]).map(c => ({
      ...c,
      key: keyOf.get(c.criterion_id)?.key ?? c.criterion_id,
      statement: keyOf.get(c.criterion_id)?.statement ?? null,
      recorded_by: `verifier:${c.recorded_by}`,
    })),
  }));
}
