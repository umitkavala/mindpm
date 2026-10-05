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

describe('backup before the Phase 2 migration', () => {
  // A 2.0 database: Phase 1 schema, none of the verification tables or columns.
  function v2Db(path: string): void {
    process.env.MINDPM_DB_PATH = path;
    getDb();
    closeDb();
    const db = new Database(path);
    db.exec(`
      DROP TABLE criterion_results; DROP TABLE check_results; DROP TABLE verification_runs; DROP TABLE verifiers;
      ALTER TABLE attempts DROP COLUMN verification_outcome; ALTER TABLE attempts DROP COLUMN verification_findings;
      ALTER TABLE attempts DROP COLUMN self_report_mismatch; ALTER TABLE attempts DROP COLUMN consecutive_errors;
      ALTER TABLE tasks DROP COLUMN verified_run_id; ALTER TABLE projects DROP COLUMN verifier_config;
      ALTER TABLE task_history DROP COLUMN verifier_id; ALTER TABLE projects DROP COLUMN verification; DROP TABLE project_history;
      INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p');
      INSERT INTO tasks (id, project_id, seq, title, status) VALUES ('t1', 'p1', 1, 'Submitted', 'needs_verification');
      INSERT INTO attempts (id, task_id, attempt_no, actor, claim_token, outcome, head_sha) VALUES ('a1', 't1', 1, 'agent:cli-a', 'tok', 'submitted', 'abcdef1');
    `);
    db.close();
  }

  it('snapshots the 2.0 database once, then adds the verification schema without touching data', () => {
    const path = join(dir, 'memory.db');
    v2Db(path);
    expect(existsSync(`${path}.pre-3.0.0`)).toBe(false);

    const db = getDb();
    expect(existsSync(`${path}.pre-3.0.0`)).toBe(true);
    expect(statusOf(`${path}.pre-3.0.0`)).toBe('needs_verification');
    expect(db.prepare("SELECT verification_outcome, consecutive_errors FROM attempts WHERE id = 'a1'").get())
      .toEqual({ verification_outcome: null, consecutive_errors: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM verifiers").get()).toEqual({ n: 0 });
    closeDb();
    expect(statusOf(path)).toBe('needs_verification');
  });
});

describe('the 3.1 migration: verification becomes opt-in per project', () => {
  // A 3.0 database: the gate is always on and there is no per-project setting.
  function v3Db(path: string, keys: { kind: string; project_ids: string[]; revoked?: boolean }[]): void {
    process.env.MINDPM_DB_PATH = path;
    getDb();
    closeDb();
    const db = new Database(path);
    db.exec(`
      ALTER TABLE projects DROP COLUMN verification; DROP TABLE project_history;
      INSERT INTO projects (id, name, slug) VALUES ('p1', 'Covered', 'p1'), ('p2', 'Revoked key', 'p2'), ('p3', 'Reviewer only', 'p3'), ('p4', 'None', 'p4');
    `);
    const insert = db.prepare(
      "INSERT INTO verifiers (id, name, kind, key_hash, project_ids, created_by, revoked_at) VALUES (?, ?, ?, ?, ?, 'human:ui', ?)",
    );
    keys.forEach((k, i) => insert.run(`v${i}`, `v${i}`, k.kind, `hash${i}`, JSON.stringify(k.project_ids), k.revoked ? '2026-10-01' : null));
    db.close();
  }

  const modes = (db: Database.Database) =>
    Object.fromEntries((db.prepare('SELECT id, verification FROM projects ORDER BY id').all() as { id: string; verification: string }[]).map(r => [r.id, r.verification]));

  it('turns it on only where an active local key covers the project, and backs up first', () => {
    const path = join(dir, 'memory.db');
    v3Db(path, [
      { kind: 'local', project_ids: ['p1'] },
      { kind: 'local', project_ids: ['p2'], revoked: true },
      { kind: 'reviewer', project_ids: ['p3'] },
    ]);
    const db = getDb();
    expect(existsSync(`${path}.pre-3.1.0`)).toBe(true);
    expect(modes(db)).toEqual({ p1: 'on', p2: 'off', p3: 'off', p4: 'off' });
    expect(db.prepare('SELECT project_id, new_value, actor FROM project_history').all())
      .toEqual([{ project_id: 'p1', new_value: 'on', actor: 'system:migration' }]);
  });

  it('turns it on everywhere for a key that covers all projects', () => {
    const path = join(dir, 'memory.db');
    v3Db(path, [{ kind: 'local', project_ids: ['*'] }]);
    expect(modes(getDb())).toEqual({ p1: 'on', p2: 'on', p3: 'on', p4: 'on' });
  });

  it('runs once: a later start keeps what the human chose', () => {
    const path = join(dir, 'memory.db');
    v3Db(path, [{ kind: 'local', project_ids: ['p1'] }]);
    getDb().prepare("UPDATE projects SET verification = 'off' WHERE id = 'p1'").run();
    closeDb();
    expect(modes(getDb()).p1).toBe('off');
  });
});
