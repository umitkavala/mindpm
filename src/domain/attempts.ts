import type Database from 'better-sqlite3';
import { canTransition, setStatus, ToolError, type TaskStatus } from './lifecycle.js';

export interface AttemptRow {
  id: string;
  task_id: string;
  attempt_no: number;
  actor: string;
  claim_token: string;
  lease_minutes: number;
  spec_version: number | null;
  outcome: string;
  failure_type: string | null;
  root_cause: string | null;
  notes: string | null;
  review_decision: string | null;
  review_findings: string | null;
  head_sha: string | null;
  criteria_results: string | null;
  verification_outcome: string | null;
  consecutive_errors: number;
}

export interface ClaimedTask {
  id: string;
  project_id: string;
  status: string;
  spec_id: string | null;
  blocked_by: string | null;
  max_attempts: number | null;
  claim_token: string | null;
}

// Attempts that count toward max_attempts: failures, expired leases,
// submissions that failed verification and submissions a human reopened.
// Escalations, voluntary releases and verifier errors don't count.
export function attemptsUsed(db: Database.Database, taskId: string): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?
     AND (outcome IN ('failed', 'expired')
          OR (outcome = 'submitted' AND (review_decision = 'reject' OR verification_outcome = 'failed')))`,
  ).get(taskId) as { n: number }).n;
}

export function maxAttempts(task: { max_attempts: number | null }): number {
  return task.max_attempts ?? 3;
}

export function attemptsLeft(db: Database.Database, task: { id: string; max_attempts: number | null }): number {
  return Math.max(0, maxAttempts(task) - attemptsUsed(db, task.id));
}

// After an attempt is used up: back to ready, or needs_human once the
// budget is spent.
export function afterUsedAttempt(db: Database.Database, task: { id: string; max_attempts: number | null }): TaskStatus {
  return attemptsLeft(db, task) > 0 ? 'ready' : 'needs_human';
}

export function endAttempt(
  db: Database.Database,
  attemptId: string,
  outcome: 'submitted' | 'failed' | 'abandoned' | 'expired',
  fields: Record<string, string | null> = {},
): void {
  const keys = Object.keys(fields);
  db.prepare(
    `UPDATE attempts SET outcome = ?, ended_at = CURRENT_TIMESTAMP${keys.map(k => `, ${k} = ?`).join('')} WHERE id = ?`,
  ).run(outcome, ...keys.map(k => fields[k]), attemptId);
}

// Lazy lease expiry, run at the start of every executor read and claim. An
// expired claim marks its attempt expired, which counts toward max_attempts.
export function expireLeases(db: Database.Database): void {
  const expired = db
    .prepare(`SELECT id, max_attempts, claim_token FROM tasks
              WHERE status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= datetime('now')`)
    .all() as { id: string; max_attempts: number | null; claim_token: string | null }[];
  if (expired.length === 0) return;
  db.transaction(() => {
    for (const t of expired) {
      const attempt = t.claim_token
        ? (db.prepare(`SELECT id FROM attempts WHERE claim_token = ? AND outcome = 'active'`).get(t.claim_token) as { id: string } | undefined)
        : undefined;
      if (attempt) endAttempt(db, attempt.id, 'expired');
      setStatus(db, t.id, 'claimed', afterUsedAttempt(db, t), 'system', attempt?.id ?? null);
    }
  }).immediate();
}

// Resolve a claim token to its live attempt and task. Every executor write
// after claim_task goes through here, so a stale agent whose lease lapsed
// can't overwrite a newer attempt. Callers run expireLeases first, outside
// their transaction, so the expiry commits even when this throws.
export function requireLiveClaim(db: Database.Database, claimToken: string): { attempt: AttemptRow; task: ClaimedTask } {
  const attempt = db.prepare('SELECT * FROM attempts WHERE claim_token = ?').get(claimToken) as AttemptRow | undefined;
  if (!attempt) throw new ToolError('invalid_token', 'No attempt holds this claim token.');
  if (attempt.outcome === 'expired') {
    throw new ToolError('lease_expired', 'The lease on this claim expired and the task was returned to the queue. Pick a task again.');
  }
  if (attempt.outcome !== 'active') {
    throw new ToolError('invalid_token', `This claim already ended (attempt outcome: ${attempt.outcome}).`);
  }
  const task = db.prepare(
    "SELECT *, lease_expires_at <= datetime('now') AS lapsed FROM tasks WHERE id = ?",
  ).get(attempt.task_id) as ClaimedTask & { lapsed: number };
  if (task.status !== 'claimed' || task.claim_token !== claimToken) {
    throw new ToolError('invalid_token', 'This claim token no longer holds the task.');
  }
  if (task.lapsed) throw new ToolError('lease_expired', 'The lease on this claim expired. Pick a task again.');
  return { attempt, task };
}

// Close a live claim: end the attempt, move the task. Shared by submit,
// report_failure, escalate and release.
export function closeClaim(
  db: Database.Database,
  claim: { attempt: AttemptRow; task: ClaimedTask },
  outcome: 'submitted' | 'failed' | 'abandoned',
  fields: Record<string, string | null>,
  nextStatus: (task: ClaimedTask) => TaskStatus,
): TaskStatus {
  endAttempt(db, claim.attempt.id, outcome, fields);
  const to = nextStatus(claim.task);
  if (!canTransition('claimed', to, 'executor') && !canTransition('claimed', to, 'system')) {
    throw new ToolError('illegal_transition', `claimed → ${to} is not allowed.`);
  }
  setStatus(db, claim.task.id, 'claimed', to, claim.attempt.actor, claim.attempt.id);
  return to;
}
