import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupBeforeMigration, closeDb, getDb, syncAgentInstructions } from './connection.js';
import { AGENT_INSTRUCTIONS_VERSION } from '../tools/meta.js';

let dir: string;
const savedEnv = process.env.MINDPM_DB_PATH;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mindpm-conn-'));
});

afterEach(() => {
  closeDb();
  if (savedEnv === undefined) delete process.env.MINDPM_DB_PATH;
  else process.env.MINDPM_DB_PATH = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

function legacyDb(path: string): void {
  const old = new Database(path);
  old.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT, description TEXT,
      status TEXT DEFAULT 'active', repo_path TEXT, tech_stack TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), seq INTEGER,
      title TEXT NOT NULL, description TEXT,
      status TEXT DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled')),
      priority TEXT DEFAULT 'medium', tags TEXT, parent_task_id TEXT, blocked_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME);
    INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p');
    INSERT INTO tasks (id, project_id, seq, title, status) VALUES ('t1', 'p1', 1, 'Legacy', 'in_progress');
  `);
  old.close();
}

const statusOf = (path: string) => {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }).status;
  } finally {
    db.close();
  }
};

describe('backup before the Phase 1 migration', () => {
  it('snapshots the old database once, then migrates', () => {
    const path = join(dir, 'memory.db');
    legacyDb(path);
    process.env.MINDPM_DB_PATH = path;

    getDb();
    closeDb();
    expect(statusOf(`${path}.pre-2.0.0`)).toBe('in_progress');
    expect(statusOf(path)).toBe('ready');

    // Later starts neither migrate again nor touch the backup.
    getDb();
    closeDb();
    expect(statusOf(`${path}.pre-2.0.0`)).toBe('in_progress');
  });

  it('does not back up a new or already migrated database', () => {
    const path = join(dir, 'fresh.db');
    process.env.MINDPM_DB_PATH = path;
    getDb();
    closeDb();
    expect(existsSync(`${path}.pre-2.0.0`)).toBe(false);
  });

  it('refuses to migrate when the backup cannot be written', () => {
    const path = join(dir, 'memory.db');
    legacyDb(path);
    const db = new Database(path);
    // Point the backup at a path inside a missing directory.
    expect(() => backupBeforeMigration(db, join(dir, 'missing', 'memory.db'))).toThrow(/did not run/);
    db.close();
    expect(statusOf(path)).toBe('in_progress');
  });
});

describe('AGENT.md sync', () => {
  const header = `<!-- mindpm agent instructions v${AGENT_INSTRUCTIONS_VERSION} -->`;

  it('creates the file with a version line', () => {
    const path = join(dir, 'AGENT.md');
    expect(syncAgentInstructions(path)).toBe('created');
    expect(readFileSync(path, 'utf8').split('\n')[0]).toBe(header);
    expect(syncAgentInstructions(path)).toBe('current');
  });

  it('rewrites a pre-2.0.0 file and keeps the old copy', () => {
    const path = join(dir, 'AGENT.md');
    writeFileSync(path, '# mindpm — Agent Instructions\nWhen task status changes → call update_task\nMy own edit\n');
    expect(syncAgentInstructions(path)).toBe('updated');
    expect(readFileSync(path, 'utf8')).toContain('claim_task');
    expect(readFileSync(`${path}.bak-pre-2.0.0`, 'utf8')).toContain('My own edit');
  });

  it('rewrites an older versioned file, backing it up under its version', () => {
    const path = join(dir, 'AGENT.md');
    writeFileSync(path, '<!-- mindpm agent instructions v1.9.0 -->\n\nold\n');
    expect(syncAgentInstructions(path)).toBe('updated');
    expect(readFileSync(`${path}.bak-1.9.0`, 'utf8')).toContain('old');
    expect(readFileSync(path, 'utf8').startsWith(header)).toBe(true);
  });
});
