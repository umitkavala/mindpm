import type Database from 'better-sqlite3';
import { generateId } from '../utils/ids.js';

// Handoff states. A status changes only when ownership or stage changes
// hands; phases inside one run (implementing, testing) are heartbeat events
// in task_history. 'verified' is reserved for the Phase 2 verifier.
export const TASK_STATUSES = [
  'backlog', 'ready', 'claimed', 'blocked', 'needs_verification', 'verified', 'needs_human', 'done', 'cancelled',
] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

// Pre-Phase-1 names, accepted by update_task for one release.
export const LEGACY_STATUS_ALIASES: Record<string, TaskStatus> = {
  todo: 'ready',
  in_progress: 'ready',
  in_review: 'needs_verification',
};

export type ActorKind = 'human' | 'architect' | 'reviewer' | 'executor';
export interface Actor { id: string; kind: ActorKind }

// human:<name>, agent:architect, agent:reviewer, agent:cli-<id>. Any other
// agent:<name> is treated as an executor. Identity is declared, not
// authenticated: mindpm is local-only for now.
export function parseActor(raw: string | undefined | null): Actor | null {
  if (!raw) return null;
  const m = raw.match(/^(human|agent):([A-Za-z0-9._-]+)$/);
  if (!m) return null;
  const [, type, name] = m;
  if (type === 'human') return { id: raw, kind: 'human' };
  if (name === 'architect') return { id: raw, kind: 'architect' };
  if (name === 'reviewer') return { id: raw, kind: 'reviewer' };
  return { id: raw, kind: 'executor' };
}

export const ACTOR_FORMAT_HINT = 'Actor must look like human:<name>, agent:architect, agent:reviewer or agent:cli-<id>.';

// Who causes a transition. 'system' covers server-side effects: lease expiry,
// spec approval releasing backlog tasks, blockers finishing.
type Mover = ActorKind | 'system';

const TRANSITIONS: Record<string, Mover[]> = {
  'backlog->ready': ['system', 'human'],
  'backlog->blocked': ['system', 'human'],
  'ready->backlog': ['system', 'human'],
  'ready->blocked': ['system', 'human'],
  'ready->claimed': ['executor', 'human'],
  'ready->needs_human': ['human'],
  'claimed->ready': ['executor', 'system', 'human'],
  'claimed->blocked': ['executor', 'human'],
  'claimed->needs_human': ['executor', 'system', 'human'],
  'claimed->needs_verification': ['executor', 'human'],
  'blocked->ready': ['system', 'human'],
  'blocked->backlog': ['system', 'human'],
  'needs_verification->done': ['human', 'reviewer'],
  'needs_verification->ready': ['human', 'reviewer'],
  'needs_verification->needs_human': ['human', 'reviewer'],
  'needs_human->ready': ['human'],
  'needs_human->backlog': ['human'],
  'needs_human->blocked': ['human'],
  'done->ready': ['human'],
};

export function canTransition(from: string, to: string, mover: Mover): boolean {
  if (from === to) return false;
  // A human can cancel anything except done work.
  if (to === 'cancelled') return from !== 'done' && (mover === 'human' || mover === 'system');
  if (from === 'cancelled') return to === 'backlog' || to === 'ready' ? mover === 'human' : false;
  return TRANSITIONS[`${from}->${to}`]?.includes(mover) ?? false;
}

export class ToolError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export function recordHistory(
  db: Database.Database,
  taskId: string,
  event: string,
  oldValue: string | null,
  newValue: string | null,
  actor: string | null = null,
  attemptId: string | null = null,
): void {
  db.prepare(
    'INSERT INTO task_history (id, task_id, event, old_value, new_value, actor, attempt_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(generateId(), taskId, event, oldValue, newValue, actor, attemptId);
}

// Write a status change, its history row and its side effects. Callers have
// already checked canTransition. Leaving 'claimed' always drops the lease.
export function setStatus(
  db: Database.Database,
  taskId: string,
  from: string,
  to: TaskStatus,
  actor: string,
  attemptId: string | null = null,
): void {
  const extra: string[] = [];
  if (to === 'done') extra.push('completed_at = CURRENT_TIMESTAMP');
  else if (from === 'done') extra.push('completed_at = NULL');
  if (from === 'claimed') extra.push('claimed_by = NULL', 'claim_token = NULL', 'lease_expires_at = NULL');
  db.prepare(`UPDATE tasks SET ${['status = ?', ...extra].join(', ')} WHERE id = ?`).run(to, taskId);
  recordHistory(db, taskId, 'status_changed', from, to, actor, attemptId);
  if (to === 'done') unblockDependents(db, taskId);
}

export function parseIdList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// Ids in blocked_by whose task is not done. Unknown ids count as open, so a
// typo never silently unblocks work.
export function openBlockers(db: Database.Database, blockedBy: string[]): string[] {
  if (blockedBy.length === 0) return [];
  const done = new Set(
    (db.prepare(`SELECT id FROM tasks WHERE status = 'done' AND id IN (${blockedBy.map(() => '?').join(',')})`)
      .all(...blockedBy) as { id: string }[]).map(r => r.id),
  );
  return blockedBy.filter(id => !done.has(id));
}

// True when the task's spec (if any) currently allows work to start.
export function specAllowsWork(db: Database.Database, specId: string | null): boolean {
  if (!specId) return true;
  const spec = db.prepare('SELECT status FROM specs WHERE id = ?').get(specId) as { status: string } | undefined;
  return spec?.status === 'approved';
}

// Where a task with no open blockers goes: ready, or backlog while its spec
// isn't approved.
export function releasedStatus(db: Database.Database, specId: string | null): TaskStatus {
  return specAllowsWork(db, specId) ? 'ready' : 'backlog';
}

// When a task reaches done, any blocked task whose blockers are now all done
// moves on. Blocked tasks with no named blockers wait for a human.
export function unblockDependents(db: Database.Database, doneTaskId: string): void {
  const candidates = db
    .prepare(`SELECT id, blocked_by, spec_id FROM tasks WHERE status = 'blocked' AND blocked_by LIKE ?`)
    .all(`%"${doneTaskId}"%`) as { id: string; blocked_by: string; spec_id: string | null }[];
  for (const t of candidates) {
    const ids = parseIdList(t.blocked_by);
    if (!ids.includes(doneTaskId) || openBlockers(db, ids).length > 0) continue;
    setStatus(db, t.id, 'blocked', releasedStatus(db, t.spec_id), 'system');
  }
}
