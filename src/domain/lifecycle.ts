import type Database from 'better-sqlite3';
import { generateId } from '../utils/ids.js';
import { connectionId } from '../utils/session-state.js';

// Handoff states. A status changes only when ownership or stage changes
// hands; phases inside one run (implementing, testing) are heartbeat events
// in task_history. Only a verifier moves work to 'verified'.
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

export type ActorKind = 'human' | 'architect' | 'reviewer' | 'executor' | 'verifier';
// onBehalfOf marks a delegate: an agent doing what a named human asked. It
// gets a human's permissions, but the record keeps the agent's own id.
// channel 'ui' is set only by the HTTP routes: a request that came through
// the Kanban UI, never a declared id. verifierId is set only after a verifier
// key was checked.
export interface Actor { id: string; kind: ActorKind; onBehalfOf?: string; channel?: 'ui'; verifierId?: string }

// The Kanban UI. Only src/server/routes.ts uses this; an MCP caller declaring
// "human:ui" gets a plain declared human without the channel.
export const UI_ACTOR: Actor = { id: 'human:ui', kind: 'human', channel: 'ui' };

const ACTOR_RE = /^(human|agent):([A-Za-z0-9._-]+)$/;

// human:<name>, agent:architect, agent:reviewer, agent:cli-<id>. Any other
// agent:<name> is treated as an executor. With onBehalfOf (a human:<name>),
// an agent id becomes a delegate with human permissions. Identity is
// declared, not authenticated: mindpm is local-only for now.
export function parseActor(raw: string | undefined | null, onBehalfOf?: string | null): Actor | null {
  if (!raw) return null;
  const m = raw.match(ACTOR_RE);
  if (!m) return null;
  const [, type, name] = m;
  if (onBehalfOf) {
    if (type !== 'agent' || !/^human:[A-Za-z0-9._-]+$/.test(onBehalfOf)) return null;
    return { id: raw, kind: 'human', onBehalfOf };
  }
  if (type === 'human') return { id: raw, kind: 'human' };
  if (name === 'architect') return { id: raw, kind: 'architect' };
  if (name === 'reviewer') return { id: raw, kind: 'reviewer' };
  return { id: raw, kind: 'executor' };
}

export const ACTOR_FORMAT_HINT =
  'Actor must look like human:<name>, agent:architect, agent:reviewer or agent:cli-<id>. ' +
  'on_behalf_of, when given, must be human:<name> and the actor an agent:* id.';

// How an actor is written into single text fields (approved_by, reviewed_by).
export function actorLabel(actor: Actor): string {
  return actor.onBehalfOf ? `${actor.id} for ${actor.onBehalfOf}` : actor.id;
}

// A delegate acts for a human, but never on work it owns: not while it holds
// the task's live claim, and not on a submission it made itself. This is what
// stops an executor from approving its own work by asking on a human's behalf.
export function assertDelegateMayAct(db: Database.Database, actor: Actor, taskId: string): void {
  if (!actor.onBehalfOf) return;
  const task = db.prepare('SELECT claimed_by, status FROM tasks WHERE id = ?').get(taskId) as { claimed_by: string | null; status: string } | undefined;
  if (task?.status === 'claimed' && task.claimed_by === actor.id) {
    throw new ToolError('forbidden', `${actor.id} holds the live claim on this task and cannot act on it on behalf of ${actor.onBehalfOf}.`);
  }
  const submitted = db.prepare(
    "SELECT actor FROM attempts WHERE task_id = ? AND outcome = 'submitted' ORDER BY attempt_no DESC LIMIT 1",
  ).get(taskId) as { actor: string } | undefined;
  if ((task?.status === 'needs_verification' || task?.status === 'verified') && submitted?.actor === actor.id) {
    throw new ToolError('forbidden', `${actor.id} submitted this work and cannot accept or move it on behalf of ${actor.onBehalfOf}.`);
  }
  assertNotSubmitter(db, actor, taskId);
}

// Actor ids are declared, so an executor could accept its own work by calling
// itself human:<name> or another agent id. The connection it submitted from
// can't be declared: outside the Kanban UI, that connection can't accept or
// move the submission, whatever actor it names.
export function assertNotSubmitter(db: Database.Database, actor: Actor, taskId: string): void {
  if (actor.channel === 'ui') return;
  const submitted = db.prepare(
    "SELECT submitted_from FROM attempts WHERE task_id = ? AND outcome = 'submitted' ORDER BY attempt_no DESC LIMIT 1",
  ).get(taskId) as { submitted_from: string | null } | undefined;
  if (submitted?.submitted_from && submitted.submitted_from === connectionId()) {
    throw new ToolError('forbidden', 'This work was submitted from this session, which cannot accept or move it under any actor. Accept it in the Kanban UI or from another session.');
  }
}

export type ActorRef = string | Actor | null;

// Who causes a transition. 'system' covers server-side effects: lease expiry,
// spec approval releasing backlog tasks, blockers finishing. 'ui' is a human
// acting through the Kanban UI: it may do anything 'human' may, plus the
// UI-only moves.
export type Mover = ActorKind | 'system' | 'ui';

export function moverOf(actor: Actor): Mover {
  return actor.channel === 'ui' ? 'ui' : actor.kind;
}

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
  'needs_verification->verified': ['verifier'],
  'needs_verification->ready': ['verifier'],
  'needs_verification->needs_human': ['human', 'verifier', 'system'],
  // Legacy tasks with no submitted attempt only; acceptTask checks that. With
  // the project's verification off, acceptTask and reopenTask also allow
  // needs_verification -> done and -> ready under the verified rules.
  'needs_verification->done': ['ui'],
  // Medium and high risk: UI only. Low risk: also accept_tasks, which checks
  // the risk level itself.
  'verified->done': ['ui', 'human'],
  'verified->ready': ['ui'],
  'needs_human->ready': ['human'],
  'needs_human->needs_verification': ['human'],
  'needs_human->backlog': ['human'],
  'needs_human->blocked': ['human'],
  'done->ready': ['human'],
};

export function canTransition(from: string, to: string, mover: Mover): boolean {
  if (from === to) return false;
  const human = mover === 'human' || mover === 'ui';
  // A human can cancel anything except done work.
  if (to === 'cancelled') return from !== 'done' && (human || mover === 'system');
  if (from === 'cancelled') return to === 'backlog' || to === 'ready' ? human : false;
  const allowed = TRANSITIONS[`${from}->${to}`] ?? [];
  return allowed.includes(mover) || (mover === 'ui' && allowed.includes('human'));
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
  actor: ActorRef = null,
  attemptId: string | null = null,
): void {
  const id = typeof actor === 'string' || actor === null ? actor : actor.id;
  const onBehalfOf = actor && typeof actor !== 'string' ? actor.onBehalfOf ?? null : null;
  const verifierId = actor && typeof actor !== 'string' ? actor.verifierId ?? null : null;
  db.prepare(
    'INSERT INTO task_history (id, task_id, event, old_value, new_value, actor, on_behalf_of, attempt_id, verifier_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(generateId(), taskId, event, oldValue, newValue, id, onBehalfOf, attemptId, verifierId);
}

// Write a status change, its history row and its side effects. Callers have
// already checked canTransition. Leaving 'claimed' always drops the lease.
export function setStatus(
  db: Database.Database,
  taskId: string,
  from: string,
  to: TaskStatus,
  actor: Exclude<ActorRef, null>,
  attemptId: string | null = null,
): void {
  const extra: string[] = [];
  if (to === 'done') extra.push('completed_at = CURRENT_TIMESTAMP');
  else if (from === 'done') extra.push('completed_at = NULL');
  if (from === 'claimed') extra.push('claimed_by = NULL', 'claim_token = NULL', 'lease_expires_at = NULL');
  // verified_run_id names the run behind the current verified/done state.
  if (to !== 'verified' && to !== 'done') extra.push('verified_run_id = NULL');
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
