import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAnchor, type LastSessionRow } from './session-brief.js';

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
