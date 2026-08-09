// Session Brief: a deterministic delta between the end of a project's last
// session and now. See README for the payload shape. Every piece here is
// designed to degrade rather than throw — a broken repo or a missing
// project must never break start_session.

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
