import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, closeTestDb, getTestDb, seedProject } from '../test-helpers/setup.js';

vi.mock('./connection.js', () => ({
  getDb: () => getTestDb(),
  closeDb: () => closeTestDb(),
}));

import { resolveProjectId, getMostRecentProject, resolveProjectOrDefault } from './queries.js';

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
  it('returns most recently updated active project', () => {
    const db = getTestDb();
    db.prepare("INSERT INTO projects (id, name, status, updated_at) VALUES ('p1', 'Old', 'active', '2025-01-01 00:00:00')").run();
    db.prepare("INSERT INTO projects (id, name, status, updated_at) VALUES ('p2', 'New', 'active', '2025-06-01 00:00:00')").run();

    const result = getMostRecentProject();
    expect(result).not.toBeNull();
    expect(result!.name).toBe('New');
  });

  it('returns null when no active projects exist', () => {
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
});
