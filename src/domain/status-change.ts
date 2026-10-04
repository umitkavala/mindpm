import type Database from 'better-sqlite3';
import { endAttempt } from './attempts.js';
import {
  canTransition, LEGACY_STATUS_ALIASES, parseActor, setStatus, TASK_STATUSES, ToolError,
  ACTOR_FORMAT_HINT, type TaskStatus,
} from './lifecycle.js';

// Normalize a requested status, mapping legacy names. Returns the warning to
// surface when an alias was used.
export function normalizeStatus(raw: string): { status: TaskStatus; warning: string | null } {
  if ((TASK_STATUSES as readonly string[]).includes(raw)) return { status: raw as TaskStatus, warning: null };
  const alias = LEGACY_STATUS_ALIASES[raw];
  if (alias) {
    return {
      status: alias,
      warning: `Status "${raw}" is deprecated and was mapped to "${alias}". It will be rejected in the next release.`,
    };
  }
  throw new ToolError('invalid_status', `Unknown status "${raw}". Valid: ${TASK_STATUSES.join(', ')}.`);
}

// A direct status write, as done by update_task and the Kanban UI. Only
// humans may do this; agents move tasks through the executor and review
// tools. Taking a task out of 'claimed' abandons the live attempt.
export function changeStatusAsHuman(db: Database.Database, taskId: string, rawStatus: string, rawActor: string | undefined): string | null {
  const actor = parseActor(rawActor);
  if (!actor) {
    throw new ToolError('illegal_transition', `Changing status directly requires a human actor. ${ACTOR_FORMAT_HINT}`);
  }
  if (actor.kind !== 'human') {
    throw new ToolError(
      'illegal_transition',
      'Agents cannot write task status. Use claim_task, submit_task, report_failure, escalate or release_task.',
    );
  }
  const { status: to, warning } = normalizeStatus(rawStatus);
  const task = db.prepare('SELECT status, claim_token FROM tasks WHERE id = ?').get(taskId) as
    | { status: string; claim_token: string | null }
    | undefined;
  if (!task) throw new ToolError('not_found', 'Task not found.');
  if (task.status === to) return warning;
  if (to === 'claimed') {
    throw new ToolError('illegal_transition', 'A task can only be claimed through claim_task, which issues a claim token.');
  }
  if (!canTransition(task.status, to, 'human')) {
    throw new ToolError('illegal_transition', `${task.status} → ${to} is not allowed.`);
  }
  db.transaction(() => {
    let attemptId: string | null = null;
    if (task.status === 'claimed' && task.claim_token) {
      const attempt = db.prepare(`SELECT id FROM attempts WHERE claim_token = ? AND outcome = 'active'`).get(task.claim_token) as
        | { id: string }
        | undefined;
      if (attempt) {
        endAttempt(db, attempt.id, 'abandoned', { notes: `Claim ended by ${actor.id} (status set to ${to}).` });
        attemptId = attempt.id;
      }
    }
    setStatus(db, taskId, task.status, to, actor.id, attemptId);
  })();
  return warning;
}
