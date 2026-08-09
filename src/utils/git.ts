// Read-only wrapper around the `git` CLI. Every exported function returns a
// typed result and never throws — a broken repo, a missing binary, or a
// timeout all degrade to `{ ok: false, reason }` so callers (the session
// brief) can produce a partial result instead of failing outright.
//
// No subcommand here ever touches the network (no fetch/pull/push/clone) —
// mindpm stays local-first. See NETWORK_SUBCOMMANDS below for the guard.

import { spawnSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 2000;

// git's well-known empty-tree object, used as a diff base for root commits.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const NETWORK_SUBCOMMANDS = new Set(['fetch', 'pull', 'push', 'clone', 'remote', 'submodule']);

export type Ok<T> = { ok: true } & T;
export type Err = { ok: false; reason: string };
export type Result<T> = Ok<T> | Err;

export type GitAnchor = { type: 'sha'; sha: string } | { type: 'date'; date: string };

export interface CommitInfo {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

export interface FileStat {
  path: string;
  added: number;
  deleted: number;
}

interface RawResult {
  status: number | null;
  stdout: string;
  stderr: string;
  reason: string | null; // set when the invocation itself failed (spawn error, timeout, disallowed command)
}

function runGit(repoPath: string, args: string[]): RawResult {
  if (args.length > 0 && NETWORK_SUBCOMMANDS.has(args[0])) {
    return { status: null, stdout: '', stderr: '', reason: `git ${args[0]} is disallowed (network access is never permitted)` };
  }

  try {
    const result = spawnSync('git', args, {
      cwd: repoPath,
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.error) {
      return { status: null, stdout: '', stderr: '', reason: result.error.message };
    }
    if (result.status === null) {
      // Killed by signal — spawnSync's `timeout` kills via SIGTERM with no `error` set.
      return { status: null, stdout: '', stderr: '', reason: `git ${args[0]} timed out after ${GIT_TIMEOUT_MS}ms` };
    }
    return { status: result.status, stdout: result.stdout ?? '', stderr: (result.stderr ?? '').trim(), reason: null };
  } catch (err: any) {
    return { status: null, stdout: '', stderr: '', reason: err?.message ?? String(err) };
  }
}

export function resolveHead(repoPath: string): Result<{ sha: string }> {
  const raw = runGit(repoPath, ['rev-parse', 'HEAD']);
  if (raw.reason) return { ok: false, reason: raw.reason };
  if (raw.status !== 0) return { ok: false, reason: raw.stderr || 'git rev-parse HEAD failed' };
  const sha = raw.stdout.trim();
  if (!sha) return { ok: false, reason: 'HEAD did not resolve to a commit (empty repository?)' };
  return { ok: true, sha };
}

export function currentBranch(repoPath: string): Result<{ branch: string | null }> {
  const raw = runGit(repoPath, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (raw.reason) return { ok: false, reason: raw.reason };
  if (raw.status === 0) {
    const branch = raw.stdout.trim();
    return { ok: true, branch: branch || null };
  }
  // `-q` suppresses the error message; a quiet non-zero exit means detached
  // HEAD, not a real failure.
  if (raw.status === 1 && !raw.stderr) {
    return { ok: true, branch: null };
  }
  return { ok: false, reason: raw.stderr || 'git symbolic-ref failed' };
}

// Checks reachability from HEAD, not just object existence: after a
// force-push, rebase, or amend, the old commit object often still lives in
// the object database (until gc runs), so a plain `cat-file -e` would wrongly
// report it as usable and produce a garbage `sha..HEAD` range. `merge-base
// --is-ancestor` answers the question we actually need — "is this sha still
// part of HEAD's history" — and exits non-zero for both "not an ancestor"
// and "not a valid commit at all", both of which mean the anchor should fall
// back to a timestamp.
export function shaExists(repoPath: string, sha: string): Result<{ exists: boolean }> {
  const raw = runGit(repoPath, ['merge-base', '--is-ancestor', sha, 'HEAD']);
  if (raw.reason) return { ok: false, reason: raw.reason };
  return { ok: true, exists: raw.status === 0 };
}

export function logSince(
  repoPath: string,
  anchor: GitAnchor,
  opts: { maxCount?: number } = {},
): Result<{ commits: CommitInfo[] }> {
  const args = ['log', `--format=%H%x1f%an%x1f%aI%x1f%s`];
  if (opts.maxCount) args.push(`--max-count=${opts.maxCount}`);
  if (anchor.type === 'sha') {
    args.push(`${anchor.sha}..HEAD`);
  } else {
    args.push(`--since=${anchor.date}`);
  }

  const raw = runGit(repoPath, args);
  if (raw.reason) return { ok: false, reason: raw.reason };
  if (raw.status !== 0) return { ok: false, reason: raw.stderr || 'git log failed' };

  const commits = raw.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, author, date, subject] = line.split('\x1f');
      return { sha: sha.slice(0, 7), author, date, subject };
    });
  return { ok: true, commits };
}

export function diffStatSince(repoPath: string, anchor: GitAnchor): Result<{ files: FileStat[] }> {
  let baseRef: string;

  if (anchor.type === 'sha') {
    baseRef = anchor.sha;
  } else {
    const earliest = runGit(repoPath, ['log', `--since=${anchor.date}`, '--format=%H', '--reverse', '-1']);
    if (earliest.reason) return { ok: false, reason: earliest.reason };
    if (earliest.status !== 0) return { ok: false, reason: earliest.stderr || 'git log failed' };
    const earliestSha = earliest.stdout.trim();
    if (!earliestSha) return { ok: true, files: [] }; // nothing committed since the anchor date

    const parent = runGit(repoPath, ['rev-parse', `${earliestSha}^`]);
    baseRef = parent.status === 0 ? parent.stdout.trim() : EMPTY_TREE_SHA;
  }

  const raw = runGit(repoPath, ['diff', '--numstat', `${baseRef}..HEAD`]);
  if (raw.reason) return { ok: false, reason: raw.reason };
  if (raw.status !== 0) return { ok: false, reason: raw.stderr || 'git diff failed' };

  const files = raw.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, deleted, path] = line.split('\t');
      // Binary files report '-' instead of a line count.
      return { path, added: added === '-' ? 0 : parseInt(added, 10), deleted: deleted === '-' ? 0 : parseInt(deleted, 10) };
    });
  return { ok: true, files };
}

export function isDirty(repoPath: string): Result<{ dirty: boolean }> {
  const raw = runGit(repoPath, ['status', '--porcelain', '--untracked-files=no']);
  if (raw.reason) return { ok: false, reason: raw.reason };
  if (raw.status !== 0) return { ok: false, reason: raw.stderr || 'git status failed' };
  return { ok: true, dirty: raw.stdout.trim().length > 0 };
}

export function untrackedCount(repoPath: string): Result<{ count: number }> {
  const raw = runGit(repoPath, ['status', '--porcelain', '--untracked-files=all']);
  if (raw.reason) return { ok: false, reason: raw.reason };
  if (raw.status !== 0) return { ok: false, reason: raw.stderr || 'git status failed' };
  const count = raw.stdout.split('\n').filter((line) => line.startsWith('?? ')).length;
  return { ok: true, count };
}

export function stashCount(repoPath: string): Result<{ count: number }> {
  const raw = runGit(repoPath, ['stash', 'list']);
  if (raw.reason) return { ok: false, reason: raw.reason };
  if (raw.status !== 0) return { ok: false, reason: raw.stderr || 'git stash list failed' };
  const count = raw.stdout.split('\n').filter(Boolean).length;
  return { ok: true, count };
}
