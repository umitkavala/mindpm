import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, closeTestDb, getTestDb, seedProject } from '../test-helpers/setup.js';

vi.mock('./connection.js', () => ({
  getDb: () => getTestDb(),
  closeDb: () => closeTestDb(),
}));

import { resolveProjectId, getMostRecentProject, resolveProjectOrDefault, resolveProjectError } from './queries.js';
import { markSessionStarted } from '../utils/session-state.js';

beforeEach(() => {
  createTestDb();
});

afterEach(() => {
  closeTestDb();
});

describe('resolveProjectId', () => {
  it('returns id when given a valid project id', () => {
    const db = getTestDb();
    seedProject(db, { id: 'abc12345', name: 'MyProject' });
    expect(resolveProjectId('abc12345')).toBe('abc12345');
  });

  it('returns id when given a project name (exact case)', () => {
    const db = getTestDb();
    seedProject(db, { id: 'abc12345', name: 'MyProject' });
    expect(resolveProjectId('MyProject')).toBe('abc12345');
  });

  it('returns id when given a project name (case insensitive)', () => {
    const db = getTestDb();
    seedProject(db, { id: 'abc12345', name: 'MyProject' });
    expect(resolveProjectId('myproject')).toBe('abc12345');
    expect(resolveProjectId('MYPROJECT')).toBe('abc12345');
  });

  it('returns null for nonexistent project', () => {
    expect(resolveProjectId('nonexistent')).toBeNull();
  });
});

describe('getMostRecentProject', () => {
  it('returns the project when exactly one active project exists', () => {
    const db = getTestDb();
    db.prepare("INSERT INTO projects (id, name, status, updated_at) VALUES ('p1', 'Solo', 'active', '2025-01-01 00:00:00')").run();

    const result = getMostRecentProject();
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Solo');
  });

  it('returns null when no active projects exist', () => {
    expect(getMostRecentProject()).toBeNull();
  });

  it('returns null when multiple active projects exist (ambiguous)', () => {
    const db = getTestDb();
    db.prepare("INSERT INTO projects (id, name, status, updated_at) VALUES ('p1', 'Old', 'active', '2025-01-01 00:00:00')").run();
    db.prepare("INSERT INTO projects (id, name, status, updated_at) VALUES ('p2', 'New', 'active', '2025-06-01 00:00:00')").run();

    expect(getMostRecentProject()).toBeNull();
  });

  it('ignores non-active projects', () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'Paused', status: 'paused' });
    seedProject(db, { id: 'p2', name: 'Completed', status: 'completed' });
    expect(getMostRecentProject()).toBeNull();
  });
});

describe('resolveProjectOrDefault', () => {
  it('resolves by name when project ref given', () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'MyProj' });

    const result = resolveProjectOrDefault('MyProj');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('p1');
    expect(result!.name).toBe('MyProj');
  });

  it('returns null when project ref not found', () => {
    expect(resolveProjectOrDefault('nonexistent')).toBeNull();
  });

  it('falls back to most recent when no ref given', () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'Active' });

    const result = resolveProjectOrDefault();
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Active');
  });

  it('returns null when no ref and no active projects', () => {
    expect(resolveProjectOrDefault()).toBeNull();
  });

  it('returns null when no ref and multiple active projects exist', () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'Alpha' });
    seedProject(db, { id: 'p2', name: 'Beta' });
    expect(resolveProjectOrDefault()).toBeNull();
  });

  it('returns the session-started project when exactly one session was started', () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'Alpha' });
    seedProject(db, { id: 'p2', name: 'Beta' });
    markSessionStarted('p1');
    const result = resolveProjectOrDefault();
    expect(result).not.toBeNull();
    expect(result!.id).toBe('p1');
  });

  it('returns null when multiple sessions were started (require explicit project)', () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'Alpha' });
    seedProject(db, { id: 'p2', name: 'Beta' });
    markSessionStarted('p1');
    markSessionStarted('p2');
    expect(resolveProjectOrDefault()).toBeNull();
  });
});

describe('resolveProjectError', () => {
  it('returns not-found message when project ref given', () => {
    expect(resolveProjectError('Ghost')).toBe('Project "Ghost" not found.');
  });

  it('returns create-first message when no projects exist', () => {
    expect(resolveProjectError()).toBe('No active projects found. Create a project first.');
  });

  it('lists active projects when multiple exist and no sessions started', () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'Alpha' });
    seedProject(db, { id: 'p2', name: 'Beta' });
    const msg = resolveProjectError();
    expect(msg).toContain('Multiple active projects found');
    expect(msg).toContain('Alpha');
    expect(msg).toContain('Beta');
  });

  it('lists session-started projects when multiple sessions were started', () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'Alpha' });
    seedProject(db, { id: 'p2', name: 'Beta' });
    markSessionStarted('p1');
    markSessionStarted('p2');
    const msg = resolveProjectError();
    expect(msg).toContain('multiple projects this session');
    expect(msg).toContain('Alpha');
    expect(msg).toContain('Beta');
  });
});
