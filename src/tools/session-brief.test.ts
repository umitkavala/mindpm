import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createSchema } from '../db/schema.js';
import { resolveAnchor, getTaskAndDecisionDelta, type LastSessionRow } from './session-brief.js';

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
    db.prepare("INSERT INTO tasks (id, project_id, title, status) VALUES ('t1', 'p1', 'T1', 'in_progress')").run();
    db.prepare("INSERT INTO decisions (id, project_id, title, decision) VALUES ('d1', 'p1', 'D1', 'x')").run();
    db.prepare("INSERT INTO notes (id, project_id, content) VALUES ('n1', 'p1', 'note')").run();

    const delta = getTaskAndDecisionDelta(db, 'p1', null);
    expect(delta.changed).toEqual([]);
    expect(delta.decisions_since).toEqual([]);
    expect(delta.notes_since_count).toBe(0);
    // Current-state sections still populate even with no cutoff.
    expect(delta.in_progress_now).toEqual([{ id: 't1', title: 'T1' }]);
  });

  it('lists status changes after the cutoff, excluding ones before it', () => {
    db.prepare("INSERT INTO tasks (id, project_id, title, status) VALUES ('t1', 'p1', 'T1', 'done')").run();
    db.prepare(
      `INSERT INTO task_history (id, task_id, event, old_value, new_value, created_at) VALUES ('h1', 't1', 'status_changed', 'todo', 'in_progress', '2026-08-08T10:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO task_history (id, task_id, event, old_value, new_value, created_at) VALUES ('h2', 't1', 'status_changed', 'in_progress', 'done', '2026-08-09T10:00:00.000Z')`,
    ).run();

    const delta = getTaskAndDecisionDelta(db, 'p1', '2026-08-09T00:00:00.000Z');
    expect(delta.changed).toEqual([
      { id: 't1', title: 'T1', from_status: 'in_progress', to_status: 'done', at: '2026-08-09T10:00:00.000Z' },
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
    db.prepare("INSERT INTO tasks (id, project_id, title, status) VALUES ('t2', 'p1', 'Blocker', 'todo')").run();

    const delta = getTaskAndDecisionDelta(db, 'p1', null);
    expect(delta.blockers).toEqual([{ task_id: 't1', title: 'Blocked task', blocked_by: '["t2"]' }]);
  });

  it('orders next_suggested by priority then age, capped at 5', () => {
    db.prepare("INSERT INTO tasks (id, project_id, title, status, priority) VALUES ('t1', 'p1', 'Low', 'todo', 'low')").run();
    db.prepare("INSERT INTO tasks (id, project_id, title, status, priority) VALUES ('t2', 'p1', 'Critical', 'todo', 'critical')").run();
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
