import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveHead, currentBranch, shaExists, logSince, diffStatSince,
  isDirty, untrackedCount, stashCount,
} from './git.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

function commit(dir: string, file: string, content: string, message: string): string {
  writeFileSync(join(dir, file), content);
  git(dir, ['add', file]);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'mindpm-git-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('resolveHead', () => {
  it('returns the HEAD sha for a repo with commits', () => {
    initRepo(repo);
    const sha = commit(repo, 'a.txt', 'hello', 'Initial commit');
    const result = resolveHead(repo);
    expect(result.ok).toBe(true);
    expect((result as any).sha).toBe(sha);
  });

  it('degrades gracefully for a fresh repo with zero commits', () => {
    initRepo(repo);
    const result = resolveHead(repo);
    expect(result.ok).toBe(false);
  });

  it('degrades gracefully for a non-git directory', () => {
    const result = resolveHead(repo);
    expect(result.ok).toBe(false);
  });
});

describe('currentBranch', () => {
  it('returns the branch name on a normal checkout', () => {
    initRepo(repo);
    commit(repo, 'a.txt', 'hello', 'Initial commit');
    const result = currentBranch(repo);
    expect(result).toEqual({ ok: true, branch: 'main' });
  });

  it('returns null for detached HEAD', () => {
    initRepo(repo);
    const sha = commit(repo, 'a.txt', 'hello', 'Initial commit');
    commit(repo, 'b.txt', 'world', 'Second commit');
    git(repo, ['checkout', '-q', sha]);
    const result = currentBranch(repo);
    expect(result).toEqual({ ok: true, branch: null });
  });

  it('is ok:true with a branch name even before the first commit', () => {
    initRepo(repo);
    const result = currentBranch(repo);
    expect(result).toEqual({ ok: true, branch: 'main' });
  });
});

describe('shaExists', () => {
  it('is true for HEAD itself', () => {
    initRepo(repo);
    const sha = commit(repo, 'a.txt', 'hello', 'Initial commit');
    expect(shaExists(repo, sha)).toEqual({ ok: true, exists: true });
  });

  it('is true for an ancestor of HEAD, not just HEAD itself', () => {
    initRepo(repo);
    const first = commit(repo, 'a.txt', 'v1', 'First');
    commit(repo, 'b.txt', 'v1', 'Second');
    expect(shaExists(repo, first)).toEqual({ ok: true, exists: true });
  });

  it('is false for a sha that does not exist at all', () => {
    initRepo(repo);
    commit(repo, 'a.txt', 'hello', 'Initial commit');
    expect(shaExists(repo, '0000000000000000000000000000000000dead')).toEqual({ ok: true, exists: false });
  });

  it('is false for a sha rewritten away by amend/force-push, even though the object still exists', () => {
    // The old commit object typically survives in the odb until gc runs, so
    // this specifically guards against checking object existence instead of
    // ancestry (see the comment on shaExists).
    initRepo(repo);
    const original = commit(repo, 'a.txt', 'v1', 'First');
    writeFileSync(join(repo, 'a.txt'), 'v2');
    git(repo, ['add', 'a.txt']);
    git(repo, ['commit', '-q', '--amend', '-m', 'First (amended)']);

    expect(shaExists(repo, original)).toEqual({ ok: true, exists: false });
  });
});

describe('logSince', () => {
  it('lists commits after a sha anchor, most recent first', () => {
    initRepo(repo);
    const first = commit(repo, 'a.txt', 'v1', 'First');
    commit(repo, 'b.txt', 'v1', 'Second');
    commit(repo, 'c.txt', 'v1', 'Third');

    const result = logSince(repo, { type: 'sha', sha: first });
    expect(result.ok).toBe(true);
    const commits = (result as any).commits;
    expect(commits.map((c: any) => c.subject)).toEqual(['Third', 'Second']);
    expect(commits[0].sha).toHaveLength(7);
    expect(commits[0].author).toBe('Test');
  });

  it('returns an empty list when nothing changed since HEAD', () => {
    initRepo(repo);
    const sha = commit(repo, 'a.txt', 'v1', 'First');
    const result = logSince(repo, { type: 'sha', sha });
    expect(result).toEqual({ ok: true, commits: [] });
  });

  it('lists commits after a date anchor', () => {
    initRepo(repo);
    commit(repo, 'a.txt', 'v1', 'First');
    const result = logSince(repo, { type: 'date', date: '1970-01-01' });
    expect(result.ok).toBe(true);
    expect((result as any).commits.map((c: any) => c.subject)).toEqual(['First']);
  });

  it('respects maxCount', () => {
    initRepo(repo);
    const first = commit(repo, 'a.txt', 'v1', 'First');
    commit(repo, 'b.txt', 'v1', 'Second');
    commit(repo, 'c.txt', 'v1', 'Third');
    const result = logSince(repo, { type: 'sha', sha: first }, { maxCount: 1 });
    expect((result as any).commits).toHaveLength(1);
  });
});

describe('diffStatSince', () => {
  it('reports added/deleted lines per file since a sha anchor', () => {
    initRepo(repo);
    const first = commit(repo, 'a.txt', 'line1\nline2\n', 'First');
    appendFileSync(join(repo, 'a.txt'), 'line3\n');
    git(repo, ['add', 'a.txt']);
    git(repo, ['commit', '-q', '-m', 'Second']);

    const result = diffStatSince(repo, { type: 'sha', sha: first });
    expect(result.ok).toBe(true);
    const files = (result as any).files;
    expect(files).toEqual([{ path: 'a.txt', added: 1, deleted: 0 }]);
  });

  it('returns no files when nothing committed since a date anchor', () => {
    initRepo(repo);
    commit(repo, 'a.txt', 'v1', 'First');
    // A day in the future relative to "now" — nothing can be committed after this.
    // (Using a far-future date like year 2999 overflows 32-bit time_t in some
    // git/libc builds and wraps around to match everything, so keep this close.)
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const result = diffStatSince(repo, { type: 'date', date: tomorrow });
    expect(result).toEqual({ ok: true, files: [] });
  });

  it('handles a date anchor against the very first (root) commit', () => {
    initRepo(repo);
    commit(repo, 'a.txt', 'line1\n', 'First');
    const result = diffStatSince(repo, { type: 'date', date: '1970-01-01' });
    expect(result.ok).toBe(true);
    expect((result as any).files).toEqual([{ path: 'a.txt', added: 1, deleted: 0 }]);
  });
});

describe('isDirty / untrackedCount / stashCount', () => {
  it('reports a clean tree with no untracked files or stashes', () => {
    initRepo(repo);
    commit(repo, 'a.txt', 'v1', 'First');
    expect(isDirty(repo)).toEqual({ ok: true, dirty: false });
    expect(untrackedCount(repo)).toEqual({ ok: true, count: 0 });
    expect(stashCount(repo)).toEqual({ ok: true, count: 0 });
  });

  it('detects a modified tracked file as dirty', () => {
    initRepo(repo);
    commit(repo, 'a.txt', 'v1', 'First');
    writeFileSync(join(repo, 'a.txt'), 'v2');
    expect(isDirty(repo)).toEqual({ ok: true, dirty: true });
  });

  it('counts untracked files without affecting isDirty', () => {
    initRepo(repo);
    commit(repo, 'a.txt', 'v1', 'First');
    writeFileSync(join(repo, 'new-file.txt'), 'x');
    writeFileSync(join(repo, 'another.txt'), 'y');
    expect(untrackedCount(repo)).toEqual({ ok: true, count: 2 });
    expect(isDirty(repo)).toEqual({ ok: true, dirty: false });
  });

  it('counts stashes', () => {
    initRepo(repo);
    commit(repo, 'a.txt', 'v1', 'First');
    writeFileSync(join(repo, 'a.txt'), 'v2');
    git(repo, ['stash', 'push', '-q', '-m', 'wip']);
    expect(stashCount(repo)).toEqual({ ok: true, count: 1 });
  });
});

describe('non-repo directories never throw', () => {
  it('every function degrades to ok:false or a safe default instead of throwing', () => {
    expect(() => resolveHead(repo)).not.toThrow();
    expect(() => currentBranch(repo)).not.toThrow();
    expect(() => shaExists(repo, 'deadbeef')).not.toThrow();
    expect(() => logSince(repo, { type: 'date', date: '1970-01-01' })).not.toThrow();
    expect(() => diffStatSince(repo, { type: 'date', date: '1970-01-01' })).not.toThrow();
    expect(() => isDirty(repo)).not.toThrow();
    expect(() => untrackedCount(repo)).not.toThrow();
    expect(() => stashCount(repo)).not.toThrow();

    expect(resolveHead(repo).ok).toBe(false);
    expect(logSince(repo, { type: 'date', date: '1970-01-01' }).ok).toBe(false);
    expect(isDirty(repo).ok).toBe(false);
  });

  it('degrades gracefully for a path that does not exist at all', () => {
    const missing = join(repo, 'does-not-exist');
    expect(resolveHead(missing).ok).toBe(false);
    expect(isDirty(missing).ok).toBe(false);
  });
});
