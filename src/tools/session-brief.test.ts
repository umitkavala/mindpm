import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createSchema } from '../db/schema.js';
import { createTestDb, closeTestDb, getTestDb, seedProject, seedSession, seedTask } from '../test-helpers/setup.js';

vi.mock('../db/connection.js', () => ({
  getDb: () => getTestDb(),
  closeDb: () => closeTestDb(),
}));

import { resolveAnchor, getTaskAndDecisionDelta, computeGap, buildSessionBrief, type LastSessionRow } from './session-brief.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function baseSession(overrides: Partial<LastSessionRow> = {}): LastSessionRow {
  return {
    id: 's1',
    summary: 'Did stuff',
    next_steps: 'Do more',
    ended_at: '2026-08-08T22:00:00.000Z',
    end_git_sha: null,
    end_git_branch: null,
    created_at: '2026-08-08T22:00:00.000Z',
    ...overrides,
  };
}

describe('resolveAnchor', () => {
  it('returns none with no degraded reasons when there is no prior session', () => {
    const result = resolveAnchor('/some/repo', null);
    expect(result).toEqual({ anchor: null, anchorLabel: 'none', degradedReasons: [] });
  });

  it('returns a timestamp anchor with no degraded reasons when no repo is configured', () => {
    const result = resolveAnchor(null, baseSession());
    expect(result).toEqual({
      anchor: { type: 'date', date: '2026-08-08T22:00:00.000Z' },
      anchorLabel: 'timestamp',
      degradedReasons: [],
    });
  });

  it('falls back to created_at when ended_at is null', () => {
    const result = resolveAnchor(null, baseSession({ ended_at: null, created_at: '2026-08-01T00:00:00.000Z' }));
    expect((result.anchor as any).date).toBe('2026-08-01T00:00:00.000Z');
  });

  describe('with a real repo', () => {
    let repo: string;

    beforeEach(() => {
      repo = mkdtempSync(join(tmpdir(), 'mindpm-anchor-'));
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.email', 't@e.com']);
      git(repo, ['config', 'user.name', 'T']);
      git(repo, ['config', 'commit.gpgsign', 'false']);
      writeFileSync(join(repo, 'a.txt'), 'v1');
      git(repo, ['add', 'a.txt']);
      git(repo, ['commit', '-q', '-m', 'Initial']);
    });

    afterEach(() => {
      rmSync(repo, { recursive: true, force: true });
    });

    it('uses the stored sha when it is still reachable', () => {
      const sha = git(repo, ['rev-parse', 'HEAD']).trim();
      const result = resolveAnchor(repo, baseSession({ end_git_sha: sha }));
      expect(result).toEqual({ anchor: { type: 'sha', sha }, anchorLabel: 'sha', degradedReasons: [] });
    });

    it('falls back to timestamp and records a degraded reason when the sha is unreachable', () => {
      const result = resolveAnchor(repo, baseSession({ end_git_sha: '0000000000000000000000000000000000dead' }));
      expect(result.anchorLabel).toBe('timestamp');
      expect(result.anchor).toEqual({ type: 'date', date: '2026-08-08T22:00:00.000Z' });
      expect(result.degradedReasons).toHaveLength(1);
      expect(result.degradedReasons[0]).toMatch(/unreachable/);
    });

    it('falls back to timestamp and records a degraded reason when no sha was stored at all', () => {
      const result = resolveAnchor(repo, baseSession({ end_git_sha: null }));
      expect(result.anchorLabel).toBe('timestamp');
      expect(result.degradedReasons[0]).toMatch(/no git sha recorded/);
    });

    it('never throws even if the repo path is bogus', () => {
      const sha = 'deadbeef00000000000000000000000000000000';
      expect(() => resolveAnchor(join(repo, 'does-not-exist'), baseSession({ end_git_sha: sha }))).not.toThrow();
    });
  });
});

describe('getTaskAndDecisionDelta', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'P')").run();
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty since-sections and zero note count when cutoff is null (first-ever session)', () => {
    db.prepare("INSERT INTO tasks (id, project_id, title, status) VALUES ('t1', 'p1', 'T1', 'claimed')").run();
    db.prepare("INSERT INTO decisions (id, project_id, title, decision) VALUES ('d1', 'p1', 'D1', 'x')").run();
    db.prepare("INSERT INTO notes (id, project_id, content) VALUES ('n1', 'p1', 'note')").run();

    const delta = getTaskAndDecisionDelta(db, 'p1', null);
    expect(delta.changed).toEqual([]);
    expect(delta.decisions_since).toEqual([]);
    expect(delta.notes_since_count).toBe(0);
    // Current-state sections still populate even with no cutoff.
    expect(delta.claimed_now).toEqual([{ id: 't1', title: 'T1' }]);
  });

  it('lists status changes after the cutoff, excluding ones before it', () => {
    db.prepare("INSERT INTO tasks (id, project_id, title, status) VALUES ('t1', 'p1', 'T1', 'done')").run();
    db.prepare(
      `INSERT INTO task_history (id, task_id, event, old_value, new_value, created_at) VALUES ('h1', 't1', 'status_changed', 'ready', 'claimed', '2026-08-08T10:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO task_history (id, task_id, event, old_value, new_value, created_at) VALUES ('h2', 't1', 'status_changed', 'claimed', 'done', '2026-08-09T10:00:00.000Z')`,
    ).run();

    const delta = getTaskAndDecisionDelta(db, 'p1', '2026-08-09T00:00:00.000Z');
    expect(delta.changed).toEqual([
      { id: 't1', title: 'T1', from_status: 'claimed', to_status: 'done', at: '2026-08-09T10:00:00.000Z' },
    ]);
  });

  it('ignores non-status-changed history events', () => {
    db.prepare("INSERT INTO tasks (id, project_id, title) VALUES ('t1', 'p1', 'T1')").run();
    db.prepare(
      `INSERT INTO task_history (id, task_id, event, new_value, created_at) VALUES ('h1', 't1', 'created', '{}', '2026-08-09T10:00:00.000Z')`,
    ).run();

    const delta = getTaskAndDecisionDelta(db, 'p1', '2026-08-01T00:00:00.000Z');
    expect(delta.changed).toEqual([]);
  });

  it('lists open blockers with blocked_by', () => {
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, status, blocked_by) VALUES ('t1', 'p1', 'Blocked task', 'blocked', '["t2"]')`,
    ).run();
    db.prepare("INSERT INTO tasks (id, project_id, title, status) VALUES ('t2', 'p1', 'Blocker', 'ready')").run();

    const delta = getTaskAndDecisionDelta(db, 'p1', null);
    expect(delta.blockers).toEqual([{ task_id: 't1', title: 'Blocked task', blocked_by: '["t2"]' }]);
  });

  it('orders next_suggested by priority then age, capped at 5', () => {
    db.prepare("INSERT INTO tasks (id, project_id, title, status, priority) VALUES ('t1', 'p1', 'Low', 'ready', 'low')").run();
    db.prepare("INSERT INTO tasks (id, project_id, title, status, priority) VALUES ('t2', 'p1', 'Critical', 'ready', 'critical')").run();
    db.prepare("INSERT INTO tasks (id, project_id, title, status, priority) VALUES ('t3', 'p1', 'Done', 'done', 'critical')").run();

    const delta = getTaskAndDecisionDelta(db, 'p1', null);
    expect(delta.next_suggested.map((t) => t.id)).toEqual(['t2', 't1']);
  });

  it('counts decisions and notes created after the cutoff only', () => {
    db.prepare("INSERT INTO decisions (id, project_id, title, decision, created_at) VALUES ('d1', 'p1', 'Old', 'x', '2026-08-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO decisions (id, project_id, title, decision, created_at) VALUES ('d2', 'p1', 'New', 'y', '2026-08-09T00:00:00.000Z')").run();
    db.prepare("INSERT INTO notes (id, project_id, content, created_at) VALUES ('n1', 'p1', 'old note', '2026-08-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO notes (id, project_id, content, created_at) VALUES ('n2', 'p1', 'new note', '2026-08-09T00:00:00.000Z')").run();

    const delta = getTaskAndDecisionDelta(db, 'p1', '2026-08-05T00:00:00.000Z');
    expect(delta.decisions_since).toEqual([{ id: 'd2', title: 'New', at: '2026-08-09T00:00:00.000Z' }]);
    expect(delta.notes_since_count).toBe(1);
  });
});

describe('computeGap', () => {
  const now = new Date('2026-08-09T12:00:00.000Z');

  it('labels same-day for under 6 hours', () => {
    const gap = computeGap('2026-08-09T08:00:00.000Z', now);
    expect(gap.label).toBe('same-day');
    expect(gap.hours_elapsed).toBe(4);
    expect(gap.hint).toBeUndefined();
  });

  it('labels overnight for 6-20 hours', () => {
    const gap = computeGap('2026-08-08T22:00:00.000Z', now);
    expect(gap.label).toBe('overnight');
    expect(gap.hours_elapsed).toBe(14);
  });

  it('labels multi-day for 20 hours to 14 days', () => {
    const gap = computeGap('2026-08-05T12:00:00.000Z', now);
    expect(gap.label).toBe('multi-day');
  });

  it('labels stale beyond 14 days and sets a hint', () => {
    const gap = computeGap('2026-07-01T12:00:00.000Z', now);
    expect(gap.label).toBe('stale');
    expect(gap.hint).toMatch(/re-read project context/i);
  });
});

describe('buildSessionBrief', () => {
  beforeEach(() => {
    createTestDb();
  });

  afterEach(() => {
    closeTestDb();
  });

  it('returns gap: null and handoff: null with degraded: false for a first-ever session', () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', status: 'claimed' });

    const brief = buildSessionBrief('p1', 'P');
    expect(brief.gap).toBeNull();
    expect(brief.handoff).toBeNull();
    expect(brief.degraded).toBe(false);
    expect(brief.degraded_reasons).toEqual([]);
    expect(brief.git.available).toBe(false);
    // Current-state task sections are unaffected by there being no prior session.
    expect(brief.tasks.claimed_now).toEqual([{ id: 't1', title: 'Test Task' }]);
  });

  it('behaves like today plus a task delta when no repo_path is configured', () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    db.prepare(
      `INSERT INTO sessions (id, project_id, summary, next_steps, ended_at, created_at) VALUES ('s1', 'p1', 'Did X', 'Do Y', '2026-08-08T22:00:00.000Z', '2026-08-08T22:00:00.000Z')`,
    ).run();
    seedTask(db, 'p1', { id: 't1', status: 'blocked', blocked_by: '["t2"]' });

    const brief = buildSessionBrief('p1', 'P');
    expect(brief.git.available).toBe(false);
    expect(brief.git.anchor).toBe('none');
    expect(brief.degraded).toBe(false);
    expect(brief.handoff).toEqual({ last_session_summary: 'Did X', next_steps: 'Do Y' });
    expect(brief.blockers).toEqual([{ task_id: 't1', title: 'Test Task', blocked_by: '["t2"]' }]);
  });

  describe('with a real repo', () => {
    let repo: string;

    function git(args: string[]): string {
      return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    }

    beforeEach(() => {
      repo = mkdtempSync(join(tmpdir(), 'mindpm-brief-'));
      git(['init', '-q', '-b', 'main']);
      git(['config', 'user.email', 't@e.com']);
      git(['config', 'user.name', 'T']);
      git(['config', 'commit.gpgsign', 'false']);
    });

    afterEach(() => {
      rmSync(repo, { recursive: true, force: true });
    });

    it('reports commits, branch, and dirty state since the anchored sha', () => {
      writeFileSync(join(repo, 'a.txt'), 'v1');
      git(['add', 'a.txt']);
      git(['commit', '-q', '-m', 'Initial']);
      const anchorSha = git(['rev-parse', 'HEAD']).trim();

      writeFileSync(join(repo, 'b.txt'), 'v1');
      git(['add', 'b.txt']);
      git(['commit', '-q', '-m', 'Second commit']);
      writeFileSync(join(repo, 'untracked.txt'), 'x');

      const db = getTestDb();
      seedProject(db, { id: 'p1', name: 'P', repo_path: repo });
      db.prepare(
        `INSERT INTO sessions (id, project_id, summary, ended_at, end_git_sha, end_git_branch, created_at)
         VALUES ('s1', 'p1', 'Did X', '2026-08-08T22:00:00.000Z', ?, 'main', '2026-08-08T22:00:00.000Z')`,
      ).run(anchorSha);

      const brief = buildSessionBrief('p1', 'P');
      expect(brief.degraded).toBe(false);
      expect(brief.git.available).toBe(true);
      expect(brief.git.anchor).toBe('sha');
      expect(brief.git.branch_then).toBe('main');
      expect(brief.git.branch_now).toBe('main');
      expect(brief.git.branch_changed).toBe(false);
      expect(brief.git.commit_count).toBe(1);
      expect(brief.git.commits[0].subject).toBe('Second commit');
      expect(brief.git.files_changed).toEqual([{ path: 'b.txt', added: 1, deleted: 0 }]);
      expect(brief.git.untracked_count).toBe(1);
    });

    it('detects a branch change since the last session', () => {
      writeFileSync(join(repo, 'a.txt'), 'v1');
      git(['add', 'a.txt']);
      git(['commit', '-q', '-m', 'Initial']);
      const anchorSha = git(['rev-parse', 'HEAD']).trim();
      git(['checkout', '-q', '-b', 'feature/x']);

      const db = getTestDb();
      seedProject(db, { id: 'p1', name: 'P', repo_path: repo });
      db.prepare(
        `INSERT INTO sessions (id, project_id, summary, ended_at, end_git_sha, end_git_branch, created_at)
         VALUES ('s1', 'p1', 'Did X', '2026-08-08T22:00:00.000Z', ?, 'main', '2026-08-08T22:00:00.000Z')`,
      ).run(anchorSha);

      const brief = buildSessionBrief('p1', 'P');
      expect(brief.git.branch_then).toBe('main');
      expect(brief.git.branch_now).toBe('feature/x');
      expect(brief.git.branch_changed).toBe(true);
    });

    it('falls back to a timestamp anchor and flags degraded when the stored sha is unreachable', () => {
      writeFileSync(join(repo, 'a.txt'), 'v1');
      git(['add', 'a.txt']);
      git(['commit', '-q', '-m', 'Initial']);

      const db = getTestDb();
      seedProject(db, { id: 'p1', name: 'P', repo_path: repo });
      db.prepare(
        `INSERT INTO sessions (id, project_id, summary, ended_at, end_git_sha, end_git_branch, created_at)
         VALUES ('s1', 'p1', 'Did X', '2026-08-08T22:00:00.000Z', '0000000000000000000000000000000000dead', 'main', '2026-08-08T22:00:00.000Z')`,
      ).run();

      const brief = buildSessionBrief('p1', 'P');
      expect(brief.git.anchor).toBe('timestamp');
      expect(brief.degraded).toBe(true);
      expect(brief.degraded_reasons.some((r) => r.includes('unreachable'))).toBe(true);
    });

    it('marks git unavailable and degraded when the configured repo_path no longer has a .git directory', () => {
      writeFileSync(join(repo, 'a.txt'), 'v1');
      git(['add', 'a.txt']);
      git(['commit', '-q', '-m', 'Initial']);

      const db = getTestDb();
      seedProject(db, { id: 'p1', name: 'P', repo_path: repo });
      db.prepare(
        `INSERT INTO sessions (id, project_id, summary, ended_at, end_git_branch, created_at)
         VALUES ('s1', 'p1', 'Did X', '2026-08-08T22:00:00.000Z', 'main', '2026-08-08T22:00:00.000Z')`,
      ).run();

      rmSync(join(repo, '.git'), { recursive: true, force: true });

      const brief = buildSessionBrief('p1', 'P');
      expect(brief.git.available).toBe(false);
      expect(brief.degraded).toBe(true);
    });

    it('caps commits at 20 and flags truncation', () => {
      writeFileSync(join(repo, 'a.txt'), 'v1');
      git(['add', 'a.txt']);
      git(['commit', '-q', '-m', 'Initial']);
      const anchorSha = git(['rev-parse', 'HEAD']).trim();

      for (let i = 0; i < 25; i++) {
        writeFileSync(join(repo, `f${i}.txt`), 'x');
        git(['add', `f${i}.txt`]);
        git(['commit', '-q', '-m', `Commit ${i}`]);
      }

      const db = getTestDb();
      seedProject(db, { id: 'p1', name: 'P', repo_path: repo });
      db.prepare(
        `INSERT INTO sessions (id, project_id, summary, ended_at, end_git_sha, end_git_branch, created_at)
         VALUES ('s1', 'p1', 'Did X', '2026-08-08T22:00:00.000Z', ?, 'main', '2026-08-08T22:00:00.000Z')`,
      ).run(anchorSha);

      const brief = buildSessionBrief('p1', 'P');
      expect(brief.git.commit_count).toBe(25);
      expect(brief.git.commits).toHaveLength(20);
      expect(brief.git.commits_truncated).toBe(true);
    });
  });
});
