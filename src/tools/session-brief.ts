// Session Brief: a deterministic delta between the end of a project's last
// session and now. See README for the payload shape. Every piece here is
// designed to degrade rather than throw — a broken repo or a missing
// project must never break start_session.

import type Database from 'better-sqlite3';
import type { GitAnchor } from '../utils/git.js';
import { shaExists } from '../utils/git.js';

export interface LastSessionRow {
  id: string;
  summary: string;
  next_steps: string | null;
  ended_at: string | null;
  end_git_sha: string | null;
  end_git_branch: string | null;
  created_at: string;
}

export type AnchorLabel = 'sha' | 'timestamp' | 'none';

export interface AnchorResolution {
  anchor: GitAnchor | null;
  anchorLabel: AnchorLabel;
  degradedReasons: string[];
}

// Pick the diff anchor for a project's git delta: the sha recorded at the end
// of the last session if it's still reachable, else the timestamp that
// session ended, else no anchor at all (nothing to diff against).
export function resolveAnchor(repoPath: string | null, lastSession: LastSessionRow | null): AnchorResolution {
  if (!lastSession) {
    return { anchor: null, anchorLabel: 'none', degradedReasons: [] };
  }

  const fallbackDate = lastSession.ended_at ?? lastSession.created_at;

  if (!repoPath) {
    // No repo configured — timestamp is still a valid (non-degraded) anchor
    // for the task/decision/note delta, which doesn't need git at all.
    return { anchor: { type: 'date', date: fallbackDate }, anchorLabel: 'timestamp', degradedReasons: [] };
  }

  if (lastSession.end_git_sha) {
    const exists = shaExists(repoPath, lastSession.end_git_sha);
    if (exists.ok && exists.exists) {
      return { anchor: { type: 'sha', sha: lastSession.end_git_sha }, anchorLabel: 'sha', degradedReasons: [] };
    }
    return {
      anchor: { type: 'date', date: fallbackDate },
      anchorLabel: 'timestamp',
      degradedReasons: ['stored git sha is unreachable (force-push, rebase, or prune) — fell back to timestamp anchor'],
    };
  }

  return {
    anchor: { type: 'date', date: fallbackDate },
    anchorLabel: 'timestamp',
    degradedReasons: ['no git sha recorded for the last session — fell back to timestamp anchor'],
  };
}

export interface TaskStatusChange {
  id: string;
  title: string;
  from_status: string | null;
  to_status: string;
  at: string;
}

export interface TaskSummary {
  id: string;
  title: string;
}

export interface NextSuggestedTask {
  id: string;
  title: string;
  priority: string;
}

export interface BlockerInfo {
  task_id: string;
  title: string;
  blocked_by: string | null;
}

export interface DecisionSummary {
  id: string;
  title: string;
  at: string;
}

export interface TaskDelta {
  changed: TaskStatusChange[];
  in_progress_now: TaskSummary[];
  next_suggested: NextSuggestedTask[];
  blockers: BlockerInfo[];
  decisions_since: DecisionSummary[];
  notes_since_count: number;
}

const NEXT_SUGGESTED_LIMIT = 5;

// Pure SQL — no git. `cutoff` is an ISO timestamp (typically the last
// session's ended_at) or null when there was no prior session, in which case
// there's nothing to diff so the "since" sections come back empty. Current-
// state sections (in_progress_now, next_suggested, blockers) don't depend on
// a cutoff and are always populated.
export function getTaskAndDecisionDelta(db: Database.Database, projectId: string, cutoff: string | null): TaskDelta {
  const changed = cutoff
    ? (db
        .prepare(
          `SELECT th.task_id as id, t.title, th.old_value as from_status, th.new_value as to_status, th.created_at as at
           FROM task_history th
           JOIN tasks t ON t.id = th.task_id
           WHERE t.project_id = ? AND th.event = 'status_changed' AND th.created_at > ?
           ORDER BY th.created_at ASC`,
        )
        .all(projectId, cutoff) as TaskStatusChange[])
    : [];

  const in_progress_now = db
    .prepare(`SELECT id, title FROM tasks WHERE project_id = ? AND status = 'in_progress' ORDER BY updated_at DESC`)
    .all(projectId) as TaskSummary[];

  const next_suggested = db
    .prepare(
      `SELECT id, title, priority FROM tasks
       WHERE project_id = ? AND status IN ('todo', 'in_progress')
       ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
                created_at ASC
       LIMIT ?`,
    )
    .all(projectId, NEXT_SUGGESTED_LIMIT) as NextSuggestedTask[];

  const blockers = db
    .prepare(`SELECT id as task_id, title, blocked_by FROM tasks WHERE project_id = ? AND status = 'blocked'`)
    .all(projectId) as BlockerInfo[];

  const decisions_since = cutoff
    ? (db
        .prepare(`SELECT id, title, created_at as at FROM decisions WHERE project_id = ? AND created_at > ? ORDER BY created_at ASC`)
        .all(projectId, cutoff) as DecisionSummary[])
    : [];

  const notes_since_count = cutoff
    ? (db.prepare(`SELECT COUNT(*) as n FROM notes WHERE project_id = ? AND created_at > ?`).get(projectId, cutoff) as { n: number }).n
    : 0;

  return { changed, in_progress_now, next_suggested, blockers, decisions_since, notes_since_count };
}
