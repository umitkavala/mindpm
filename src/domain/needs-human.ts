import type Database from 'better-sqlite3';
import { resolveTaskId } from '../db/queries.js';
import { attemptsLeft, attemptsUsed, expireLeases } from './attempts.js';
import {
  assertDelegateMayAct, openBlockers, parseIdList, recordHistory, releasedStatus, setStatus, ToolError, type Actor, type TaskStatus,
} from './lifecycle.js';
import { specKey, type SpecRow } from './specs.js';

export type Resolution = 'requeue' | 'cancel' | 'revise_spec' | 'reverify';

// A human answers a task waiting in needs_human. Shared by the
// resolve_needs_human tool and the Kanban UI's Resolve.
export function resolveNeedsHuman(db: Database.Database, taskRef: string, action: Resolution, note: string, who: Actor) {
  if (who.kind !== 'human') throw new ToolError('forbidden', 'Only a human (human:*, or an agent with on_behalf_of) can resolve needs_human.');
  if (!note?.trim()) throw new ToolError('note_required', 'A resolution needs a note: the answer or reason.');
  if (note.length > 1500) throw new ToolError('too_long', 'note is capped at 1500 characters.');
  expireLeases(db);
  return db.transaction(() => {
    const id = resolveTaskId(taskRef);
    if (!id) throw new ToolError('not_found', `Task "${taskRef}" not found.`);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as { id: string; status: string; spec_id: string | null; blocked_by: string | null; max_attempts: number | null };
    if (task.status !== 'needs_human') throw new ToolError('illegal_transition', `This task is ${task.status}, not needs_human.`);
    assertDelegateMayAct(db, who, task.id);
    recordHistory(db, task.id, 'resolution', null, JSON.stringify({ action, note }), who);

    let to: TaskStatus;
    let specNote: string | undefined;
    if (action === 'cancel') {
      to = 'cancelled';
    } else if (action === 'reverify') {
      // The verifier broke, not the code: hand the same submission back to it.
      const last = db.prepare(
        "SELECT id, head_sha, verification_outcome FROM attempts WHERE task_id = ? ORDER BY attempt_no DESC LIMIT 1",
      ).get(task.id) as { id: string; head_sha: string | null; verification_outcome: string | null } | undefined;
      if (!last?.head_sha || last.verification_outcome) {
        throw new ToolError('invalid_state', 'reverify is for a submission whose verification kept erroring; this task has none waiting.');
      }
      db.prepare('UPDATE attempts SET consecutive_errors = 0 WHERE id = ?').run(last.id);
      to = 'needs_verification';
    } else if (action === 'revise_spec') {
      if (!task.spec_id) throw new ToolError('invalid_state', 'This task has no spec to revise.');
      const spec = db.prepare('SELECT * FROM specs WHERE id = ?').get(task.spec_id) as SpecRow;
      if (spec.status === 'superseded' || spec.status === 'cancelled') {
        throw new ToolError('invalid_state', `${specKey(spec)} is ${spec.status}; link the task to its replacement instead.`);
      }
      // Back to draft: pick_task stops handing out sibling tasks until
      // the revision is approved, which also bumps the version.
      if (spec.status === 'approved') db.prepare("UPDATE specs SET status = 'draft' WHERE id = ?").run(spec.id);
      specNote = `${specKey(spec)} is back in draft. Edit it with update_spec, then approve_spec.`;
      to = 'backlog';
    } else {
      if (attemptsLeft(db, task) === 0) {
        db.prepare('UPDATE tasks SET max_attempts = ? WHERE id = ?').run(attemptsUsed(db, task.id) + 1, task.id);
      }
      to = openBlockers(db, parseIdList(task.blocked_by)).length > 0 ? 'blocked' : releasedStatus(db, task.spec_id);
    }
    setStatus(db, task.id, 'needs_human', to, who);
    const fresh = db.prepare('SELECT id, max_attempts FROM tasks WHERE id = ?').get(task.id) as { id: string; max_attempts: number | null };
    return { status: to, attempts_left: attemptsLeft(db, fresh), ...(specNote ? { note: specNote } : {}) };
  }).immediate();
}
