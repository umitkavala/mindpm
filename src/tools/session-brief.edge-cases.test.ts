// Dedicated edge-case coverage for the session brief (see mindpm §T9):
// no repo configured; path configured but .git missing; fresh repo with
// zero commits; detached HEAD; branch changed between sessions; force-push
// making the stored sha unreachable; dirty tree with untracked files;
// first-ever session; 20+ commits (truncation); shallow clone.
//
// The bar for every case: buildSessionBrief must never throw and must
// return a valid payload.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, closeTestDb, getTestDb, seedProject } from '../test-helpers/setup.js';

vi.mock('../db/connection.js', () => ({
  getDb: () => getTestDb(),
  closeDb: () => closeTestDb(),
}));

import { buildSessionBrief } from './session-brief.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@e.com']);
  git(dir, ['config', 'user.name', 'T']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

function commit(dir: string, file: string, content: string, message: string): string {
  writeFileSync(join(dir, file), content);
  git(dir, ['add', file]);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

function seedSessionRow(overrides: Partial<{
  ended_at: string; created_at: string; end_git_sha: string | null; end_git_branch: string | null;
  summary: string; next_steps: string | null;
}> = {}): void {
  const db = getTestDb();
  db.prepare(
    `INSERT INTO sessions (id, project_id, summary, next_steps, ended_at, end_git_sha, end_git_branch, created_at)
     VALUES ('s1', 'p1', ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.summary ?? 'Did X',
    overrides.next_steps ?? 'Do Y',
    overrides.ended_at ?? '2026-08-08T22:00:00.000Z',
    overrides.end_git_sha ?? null,
    overrides.end_git_branch ?? null,
    overrides.created_at ?? overrides.ended_at ?? '2026-08-08T22:00:00.000Z',
  );
}

let dirs: string[];

beforeEach(() => {
  createTestDb();
  dirs = [];
});

afterEach(() => {
  closeTestDb();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmpRepoDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `mindpm-edge-${prefix}-`));
  dirs.push(dir);
  return dir;
}

describe('session brief edge cases', () => {
  it('no repo configured: degrades cleanly, git unavailable, tasks/blockers unaffected', () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedSessionRow();

    expect(() => buildSessionBrief('p1', 'P')).not.toThrow();
    const brief = buildSessionBrief('p1', 'P');
    expect(brief.git.available).toBe(false);
    expect(brief.git.anchor).toBe('none');
    expect(brief.degraded).toBe(false);
    expect(brief.handoff).toEqual({ last_session_summary: 'Did X', next_steps: 'Do Y' });
  });

  it('repo_path configured but .git missing: degrades, does not throw', () => {
    const dir = tmpRepoDir('nogit');
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P', repo_path: dir });
    seedSessionRow();

    expect(() => buildSessionBrief('p1', 'P')).not.toThrow();
    const brief = buildSessionBrief('p1', 'P');
    expect(brief.git.available).toBe(false);
    expect(brief.degraded).toBe(true);
    expect(brief.degraded_reasons.length).toBeGreaterThan(0);
  });

  it('fresh repo with zero commits: degrades to a timestamp/none anchor, no throw', () => {
    const dir = tmpRepoDir('zero-commits');
    initRepo(dir);
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P', repo_path: dir });
    // Mirrors what end_session would have stored: resolveHead fails on a
    // commit-less repo, so end_git_sha is null.
    seedSessionRow({ end_git_sha: null, end_git_branch: 'main' });

    expect(() => buildSessionBrief('p1', 'P')).not.toThrow();
    const brief = buildSessionBrief('p1', 'P');
    expect(brief.git.available).toBe(true);
    expect(brief.git.branch_now).toBe('main');
    expect(brief.git.commit_count).toBe(0);
    expect(brief.git.commits).toEqual([]);
  });

  it('detached HEAD: branch_now is null, not a crash', () => {
    const dir = tmpRepoDir('detached');
    initRepo(dir);
    const first = commit(dir, 'a.txt', 'v1', 'First');
    commit(dir, 'b.txt', 'v1', 'Second');
    git(dir, ['checkout', '-q', first]);

    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P', repo_path: dir });
    seedSessionRow({ end_git_sha: first, end_git_branch: 'main' });

    expect(() => buildSessionBrief('p1', 'P')).not.toThrow();
    const brief = buildSessionBrief('p1', 'P');
    expect(brief.git.available).toBe(true);
    expect(brief.git.branch_now).toBeNull();
    // Both endpoints must be known non-null branch names to call it "changed".
    expect(brief.git.branch_changed).toBe(false);
  });

  it('branch changed between sessions: branch_then vs branch_now differ', () => {
    const dir = tmpRepoDir('branch-changed');
    initRepo(dir);
    const anchorSha = commit(dir, 'a.txt', 'v1', 'First');
    git(dir, ['checkout', '-q', '-b', 'feature/y']);

    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P', repo_path: dir });
    seedSessionRow({ end_git_sha: anchorSha, end_git_branch: 'main' });

    const brief = buildSessionBrief('p1', 'P');
    expect(brief.git.branch_then).toBe('main');
    expect(brief.git.branch_now).toBe('feature/y');
    expect(brief.git.branch_changed).toBe(true);
  });

  it('force-push making the stored sha unreachable: falls back to timestamp, flags degraded, no throw', () => {
    const dir = tmpRepoDir('force-push');
    initRepo(dir);
    const original = commit(dir, 'a.txt', 'v1', 'First');
    // Rewrite history the way a force-push / rebase / amend would.
    writeFileSync(join(dir, 'a.txt'), 'v2');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-q', '--amend', '-m', 'First (rewritten)']);

    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P', repo_path: dir });
    seedSessionRow({ end_git_sha: original, end_git_branch: 'main' });

    expect(() => buildSessionBrief('p1', 'P')).not.toThrow();
    const brief = buildSessionBrief('p1', 'P');
    expect(brief.git.anchor).toBe('timestamp');
    expect(brief.degraded).toBe(true);
    expect(brief.degraded_reasons.some((r) => r.includes('unreachable'))).toBe(true);
  });

  it('dirty tree with untracked files: both reported, no throw', () => {
    const dir = tmpRepoDir('dirty');
    initRepo(dir);
    const anchorSha = commit(dir, 'a.txt', 'v1', 'First');
    writeFileSync(join(dir, 'a.txt'), 'v2 (uncommitted)');
    writeFileSync(join(dir, 'new.txt'), 'untracked');

    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P', repo_path: dir });
    seedSessionRow({ end_git_sha: anchorSha, end_git_branch: 'main' });

    const brief = buildSessionBrief('p1', 'P');
    expect(brief.git.working_tree_dirty).toBe(true);
    expect(brief.git.untracked_count).toBe(1);
  });

  it('first-ever session: no prior session yields gap: null, handoff: null, degraded: false', () => {
    const dir = tmpRepoDir('first-session');
    initRepo(dir);
    commit(dir, 'a.txt', 'v1', 'First');

    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P', repo_path: dir });
    // No sessions row inserted at all.

    expect(() => buildSessionBrief('p1', 'P')).not.toThrow();
    const brief = buildSessionBrief('p1', 'P');
    expect(brief.gap).toBeNull();
    expect(brief.handoff).toBeNull();
    expect(brief.degraded).toBe(false);
    expect(brief.git.anchor).toBe('none');
  });

  it('20+ commits: capped at 20 with truncated flag, no throw', () => {
    const dir = tmpRepoDir('many-commits');
    initRepo(dir);
    const anchorSha = commit(dir, 'seed.txt', 'v1', 'Seed');
    for (let i = 0; i < 23; i++) {
      commit(dir, `f${i}.txt`, 'x', `Commit ${i}`);
    }

    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P', repo_path: dir });
    seedSessionRow({ end_git_sha: anchorSha, end_git_branch: 'main' });

    const brief = buildSessionBrief('p1', 'P');
    expect(brief.git.commit_count).toBe(23);
    expect(brief.git.commits).toHaveLength(20);
    expect(brief.git.commits_truncated).toBe(true);
  });

  it('shallow clone: anchor sha absent from the clone\'s truncated history degrades cleanly, no throw', () => {
    const source = tmpRepoDir('shallow-source');
    initRepo(source);
    const first = commit(source, 'a.txt', 'v1', 'First');
    commit(source, 'b.txt', 'v1', 'Second');
    commit(source, 'c.txt', 'v1', 'Third');

    const cloneDir = tmpRepoDir('shallow-clone');
    rmSync(cloneDir, { recursive: true, force: true }); // clone needs to create the target itself
    // git ignores --depth for local-path clones unless given a file:// URL
    // (it otherwise takes a hardlink shortcut and clones full history).
    execFileSync('git', ['clone', '-q', '--depth=1', '--branch', 'main', `file://${source}`, cloneDir]);
    git(cloneDir, ['config', 'user.email', 't@e.com']);
    git(cloneDir, ['config', 'user.name', 'T']);
    git(cloneDir, ['config', 'commit.gpgsign', 'false']);

    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P', repo_path: cloneDir });
    // The anchor sha (the very first commit) was truncated out of the shallow history.
    seedSessionRow({ end_git_sha: first, end_git_branch: 'main' });

    expect(() => buildSessionBrief('p1', 'P')).not.toThrow();
    const brief = buildSessionBrief('p1', 'P');
    expect(brief.git.available).toBe(true);
    expect(brief.git.anchor).toBe('timestamp');
    expect(brief.degraded).toBe(true);
  });
});
