// Session Brief: a deterministic delta between the end of a project's last
// session and now. See README for the payload shape. Every piece here is
// designed to degrade rather than throw — a broken repo or a missing
// project must never break start_session.

import type Database from 'better-sqlite3';
import type { GitAnchor, CommitInfo, FileStat } from '../utils/git.js';
import { shaExists, currentBranch, logSince, diffStatSince, isDirty, untrackedCount, stashCount } from '../utils/git.js';
import { getDb, resolveRepoPath } from '../db/queries.js';
import { getHttpPort } from '../server/http.js';
import { awaitingAcceptance, type AwaitingAcceptance } from '../domain/verification.js';

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
  claimed_now: TaskSummary[];
  next_suggested: NextSuggestedTask[];
  blockers: BlockerInfo[];
  decisions_since: DecisionSummary[];
  notes_since_count: number;
}

const NEXT_SUGGESTED_LIMIT = 5;

// Pure SQL — no git. `cutoff` is an ISO timestamp (typically the last
// session's ended_at) or null when there was no prior session, in which case
// there's nothing to diff so the "since" sections come back empty. Current-
// state sections (claimed_now, next_suggested, blockers) don't depend on
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

  const claimed_now = db
    .prepare(`SELECT id, title FROM tasks WHERE project_id = ? AND status = 'claimed' ORDER BY updated_at DESC`)
    .all(projectId) as TaskSummary[];

  const next_suggested = db
    .prepare(
      `SELECT id, title, priority FROM tasks
       WHERE project_id = ? AND status IN ('ready', 'claimed')
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

  return { changed, claimed_now, next_suggested, blockers, decisions_since, notes_since_count };
}

const COMMIT_CAP = 20;
const FILE_CAP = 40;
const STALE_DAYS = 14;
const STALE_HINT = 'Last session ended over 14 days ago — next_steps may be stale. Re-read project context (get_project_status) rather than trusting the handoff at face value.';

export type GapLabel = 'same-day' | 'overnight' | 'multi-day' | 'stale';

export interface Gap {
  last_session_ended_at: string;
  hours_elapsed: number;
  label: GapLabel;
  hint?: string;
}

export function computeGap(endedAtIso: string, now: Date): Gap {
  const endedAt = new Date(endedAtIso);
  const hoursElapsed = (now.getTime() - endedAt.getTime()) / (1000 * 60 * 60);

  let label: GapLabel;
  if (hoursElapsed < 6) label = 'same-day';
  else if (hoursElapsed < 20) label = 'overnight';
  else if (hoursElapsed < STALE_DAYS * 24) label = 'multi-day';
  else label = 'stale';

  const gap: Gap = { last_session_ended_at: endedAtIso, hours_elapsed: Math.round(hoursElapsed * 10) / 10, label };
  if (label === 'stale') gap.hint = STALE_HINT;
  return gap;
}

export interface GitSection {
  available: boolean;
  anchor: AnchorLabel;
  branch_then: string | null;
  branch_now: string | null;
  branch_changed: boolean;
  commits: CommitInfo[];
  commit_count: number;
  commits_truncated: boolean;
  files_changed: FileStat[];
  files_changed_truncated: boolean;
  working_tree_dirty: boolean;
  untracked_count: number;
  stash_count: number;
}

const EMPTY_GIT_SECTION: GitSection = {
  available: false,
  anchor: 'none',
  branch_then: null,
  branch_now: null,
  branch_changed: false,
  commits: [],
  commit_count: 0,
  commits_truncated: false,
  files_changed: [],
  files_changed_truncated: false,
  working_tree_dirty: false,
  untracked_count: 0,
  stash_count: 0,
};

// Assemble the git.* section, degrading field-by-field instead of failing
// outright when individual git calls fail. Returns any degraded reasons
// picked up along the way (anchor fallback, unreadable repo, etc).
function buildGitSection(repoPath: string | null, lastSession: LastSessionRow | null): { git: GitSection; degradedReasons: string[] } {
  if (!repoPath) {
    return { git: EMPTY_GIT_SECTION, degradedReasons: [] };
  }

  const branchThen = lastSession?.end_git_branch ?? null;
  const branchNowResult = currentBranch(repoPath);
  if (!branchNowResult.ok) {
    return {
      git: { ...EMPTY_GIT_SECTION, branch_then: branchThen },
      degradedReasons: [`git repository at repo_path is not accessible: ${branchNowResult.reason}`],
    };
  }
  const branchNow = branchNowResult.branch;

  const degradedReasons: string[] = [];
  const anchorRes = resolveAnchor(repoPath, lastSession);
  degradedReasons.push(...anchorRes.degradedReasons);

  let commits: CommitInfo[] = [];
  let commitCount = 0;
  let commitsTruncated = false;
  let files: FileStat[] = [];
  let filesTruncated = false;

  if (anchorRes.anchor) {
    const logResult = logSince(repoPath, anchorRes.anchor);
    if (logResult.ok) {
      commitCount = logResult.commits.length;
      commitsTruncated = commitCount > COMMIT_CAP;
      commits = logResult.commits.slice(0, COMMIT_CAP);
    } else {
      degradedReasons.push(`could not read git log: ${logResult.reason}`);
    }

    const diffResult = diffStatSince(repoPath, anchorRes.anchor);
    if (diffResult.ok) {
      // Sorted by churn (added + deleted), most-changed first.
      const sorted = [...diffResult.files].sort((a, b) => b.added + b.deleted - (a.added + a.deleted));
      filesTruncated = sorted.length > FILE_CAP;
      files = sorted.slice(0, FILE_CAP);
    } else {
      degradedReasons.push(`could not read git diff stat: ${diffResult.reason}`);
    }
  }

  const dirtyResult = isDirty(repoPath);
  if (!dirtyResult.ok) degradedReasons.push(`could not read working tree status: ${dirtyResult.reason}`);
  const untrackedResult = untrackedCount(repoPath);
  if (!untrackedResult.ok) degradedReasons.push(`could not count untracked files: ${untrackedResult.reason}`);
  const stashResult = stashCount(repoPath);
  if (!stashResult.ok) degradedReasons.push(`could not count stashes: ${stashResult.reason}`);

  return {
    git: {
      available: true,
      anchor: anchorRes.anchorLabel,
      branch_then: branchThen,
      branch_now: branchNow,
      branch_changed: branchThen !== null && branchNow !== null && branchThen !== branchNow,
      commits,
      commit_count: commitCount,
      commits_truncated: commitsTruncated,
      files_changed: files,
      files_changed_truncated: filesTruncated,
      working_tree_dirty: dirtyResult.ok ? dirtyResult.dirty : false,
      untracked_count: untrackedResult.ok ? untrackedResult.count : 0,
      stash_count: stashResult.ok ? stashResult.count : 0,
    },
    degradedReasons,
  };
}

export interface SessionBrief {
  project: string;
  degraded: boolean;
  degraded_reasons: string[];
  gap: Gap | null;
  handoff: { last_session_summary: string; next_steps: string | null } | null;
  git: GitSection;
  tasks: {
    changed: TaskStatusChange[];
    claimed_now: TaskSummary[];
    next_suggested: NextSuggestedTask[];
  };
  blockers: BlockerInfo[];
  decisions_since: DecisionSummary[];
  notes_since_count: number;
  awaiting_acceptance: AwaitingAcceptance;
}

// Compose the full session brief: a deterministic delta between the end of
// a project's last session and now. Never throws — every sub-section
// degrades independently (see buildGitSection / getTaskAndDecisionDelta),
// and a missing prior session simply yields a brief with gap/handoff null
// rather than an error.
export function buildSessionBrief(projectId: string, projectName: string): SessionBrief {
  const db = getDb();
  const lastSession = (db
    .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(projectId) as LastSessionRow | undefined) ?? null;

  const repoPath = resolveRepoPath(projectId);
  const { git, degradedReasons } = buildGitSection(repoPath, lastSession);

  const cutoff = lastSession ? lastSession.ended_at ?? lastSession.created_at : null;
  const delta = getTaskAndDecisionDelta(db, projectId, cutoff);

  const gap = lastSession ? computeGap(lastSession.ended_at ?? lastSession.created_at, new Date()) : null;
  const handoff = lastSession ? { last_session_summary: lastSession.summary, next_steps: lastSession.next_steps } : null;
  const port = getHttpPort();

  return {
    project: projectName,
    degraded: degradedReasons.length > 0,
    degraded_reasons: degradedReasons,
    gap,
    handoff,
    git,
    tasks: {
      changed: delta.changed,
      claimed_now: delta.claimed_now,
      next_suggested: delta.next_suggested,
    },
    blockers: delta.blockers,
    decisions_since: delta.decisions_since,
    notes_since_count: delta.notes_since_count,
    awaiting_acceptance: awaitingAcceptance(db, projectId, port ? `http://localhost:${port}?project=${projectId}` : null),
  };
}
