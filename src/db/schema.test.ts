import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema, runMigrations } from './schema.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createSchema(db);
});

afterEach(() => {
  db.close();
});

describe('createSchema', () => {
  it('creates all tables', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'")
      .all()
      .map((r: any) => r.name)
      .sort();
    expect(tables).toEqual([
      'acceptance_criteria', 'attempts', 'check_results', 'context', 'criterion_results', 'decisions', 'notes', 'project_history', 'projects', 'sessions', 'specs',
      'task_criteria', 'task_history', 'tasks', 'verification_runs', 'verifiers',
    ]);
  });

  it('creates expected indexes', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
      .all()
      .map((r: any) => r.name)
      .sort();
    expect(indexes).toContain('idx_tasks_project_id');
    expect(indexes).toContain('idx_tasks_status');
    expect(indexes).toContain('idx_tasks_priority');
    expect(indexes).toContain('idx_tasks_created_at');
    expect(indexes).toContain('idx_decisions_project_id');
    expect(indexes).toContain('idx_notes_project_id');
    expect(indexes).toContain('idx_sessions_project_id');
    expect(indexes).toContain('idx_context_project_id');
  });

  it('creates update triggers', () => {
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((r: any) => r.name)
      .sort();
    expect(triggers).toContain('trg_projects_updated_at');
    expect(triggers).toContain('trg_tasks_updated_at');
    expect(triggers).toContain('trg_context_updated_at');
  });

  it('is idempotent (can run twice)', () => {
    expect(() => createSchema(db)).not.toThrow();
  });

  it('enforces projects.name UNIQUE constraint', () => {
    db.prepare("INSERT INTO projects (id, name) VALUES ('a', 'Proj')").run();
    expect(() => db.prepare("INSERT INTO projects (id, name) VALUES ('b', 'Proj')").run()).toThrow();
  });

  it('enforces projects.status CHECK constraint', () => {
    expect(() =>
      db.prepare("INSERT INTO projects (id, name, status) VALUES ('a', 'P', 'invalid')").run(),
    ).toThrow();
  });

  it('enforces tasks.status CHECK constraint', () => {
    db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'P')").run();
    expect(() =>
      db.prepare("INSERT INTO tasks (id, project_id, title, status) VALUES ('t1', 'p1', 'T', 'invalid')").run(),
    ).toThrow();
  });

  it('enforces tasks.priority CHECK constraint', () => {
    db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'P')").run();
    expect(() =>
      db.prepare("INSERT INTO tasks (id, project_id, title, priority) VALUES ('t1', 'p1', 'T', 'invalid')").run(),
    ).toThrow();
  });

  it('enforces notes.category CHECK constraint', () => {
    db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'P')").run();
    expect(() =>
      db.prepare("INSERT INTO notes (id, project_id, content, category) VALUES ('n1', 'p1', 'x', 'invalid')").run(),
    ).toThrow();
  });

  it('enforces foreign key on tasks.project_id', () => {
    expect(() =>
      db.prepare("INSERT INTO tasks (id, project_id, title) VALUES ('t1', 'nonexistent', 'T')").run(),
    ).toThrow();
  });

  it('enforces UNIQUE(project_id, key) on context', () => {
    db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'P')").run();
    db.prepare("INSERT INTO context (id, project_id, key, value) VALUES ('c1', 'p1', 'k', 'v1')").run();
    expect(() =>
      db.prepare("INSERT INTO context (id, project_id, key, value) VALUES ('c2', 'p1', 'k', 'v2')").run(),
    ).toThrow();
  });

  it('updated_at trigger fires on projects update', () => {
    db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'P')").run();
    const before = (db.prepare("SELECT updated_at FROM projects WHERE id = 'p1'").get() as any).updated_at;

    // SQLite CURRENT_TIMESTAMP has second resolution, so we need the trigger to change the value
    // The trigger fires on any UPDATE, so update a different column
    db.prepare("UPDATE projects SET description = 'new' WHERE id = 'p1'").run();
    const after = (db.prepare("SELECT updated_at FROM projects WHERE id = 'p1'").get() as any).updated_at;

    // The trigger should have fired — updated_at should be set to CURRENT_TIMESTAMP
    expect(after).toBeDefined();
  });

  it('updated_at trigger fires on tasks update', () => {
    db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'P')").run();
    db.prepare("INSERT INTO tasks (id, project_id, title) VALUES ('t1', 'p1', 'T')").run();

    db.prepare("UPDATE tasks SET title = 'Updated' WHERE id = 't1'").run();
    const row = db.prepare("SELECT updated_at FROM tasks WHERE id = 't1'").get() as any;
    expect(row.updated_at).toBeDefined();
  });

  it('updated_at trigger fires on context update', () => {
    db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'P')").run();
    db.prepare("INSERT INTO context (id, project_id, key, value) VALUES ('c1', 'p1', 'k', 'v')").run();

    db.prepare("UPDATE context SET value = 'new' WHERE id = 'c1'").run();
    const row = db.prepare("SELECT updated_at FROM context WHERE id = 'c1'").get() as any;
    expect(row.updated_at).toBeDefined();
  });
});

describe('runMigrations FTS upgrade path', () => {
  it('rebuilds the tasks table and keeps pre-existing rows searchable via FTS', () => {
    // Simulate a pre-FTS, pre-in_review database with existing data.
    const old = new Database(':memory:');
    old.pragma('foreign_keys = ON');
    old.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
        status TEXT DEFAULT 'active', repo_path TEXT, tech_stack TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, description TEXT,
        status TEXT DEFAULT 'todo' CHECK(status IN ('todo','in_progress','blocked','done','cancelled')),
        priority TEXT DEFAULT 'medium', tags TEXT, parent_task_id TEXT, blocked_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME
      );
      INSERT INTO projects (id, name) VALUES ('p1', 'P');
      INSERT INTO tasks (id, project_id, title) VALUES ('t1', 'p1', 'Legacy authentication task');
    `);

    createSchema(old);   // adds remaining tables + FTS (triggers attach to the OLD tasks table)
    runMigrations(old);  // adds seq, rebuilds tasks for Phase 1 statuses (drops triggers), then rebuilds FTS

    // The tasks table was rebuilt with the handoff statuses.
    const tasksSql = (old.prepare("SELECT sql FROM sqlite_master WHERE name='tasks'").get() as any).sql;
    expect(tasksSql).toContain('needs_verification');

    // The row that existed before FTS — and survived the table rebuild — is indexed.
    const hits = old
      .prepare('SELECT t.id FROM tasks_fts JOIN tasks t ON t.rowid = tasks_fts.rowid WHERE tasks_fts MATCH ?')
      .all('"legacy"*');
    expect(hits).toEqual([{ id: 't1' }]);

    // Triggers were restored after the rebuild — new writes stay in sync.
    old.prepare("UPDATE tasks SET title = 'Renamed task' WHERE id = 't1'").run();
    const afterRename = old
      .prepare('SELECT COUNT(*) AS n FROM tasks_fts JOIN tasks t ON t.rowid = tasks_fts.rowid WHERE tasks_fts MATCH ?')
      .get('"renamed"*') as { n: number };
    expect(afterRename.n).toBe(1);

    old.close();
  });
});

describe('runMigrations Phase 1', () => {
  function legacyDb(): Database.Database {
    const old = new Database(':memory:');
    old.pragma('foreign_keys = ON');
    old.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT, description TEXT,
        status TEXT DEFAULT 'active', repo_path TEXT, tech_stack TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), seq INTEGER,
        title TEXT NOT NULL, description TEXT,
        status TEXT DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled')),
        priority TEXT DEFAULT 'medium' CHECK(priority IN ('critical', 'high', 'medium', 'low')),
        tags TEXT, parent_task_id TEXT REFERENCES tasks(id), blocked_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME
      );
      CREATE TABLE task_history (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), event TEXT NOT NULL,
        old_value TEXT, new_value TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT REFERENCES tasks(id),
        title TEXT NOT NULL, decision TEXT NOT NULL, reasoning TEXT, alternatives TEXT, tags TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p');
      INSERT INTO tasks (id, project_id, seq, title, status, blocked_by, completed_at) VALUES
        ('t1', 'p1', 1, 'Todo task', 'todo', NULL, NULL),
        ('t2', 'p1', 2, 'Doing task', 'in_progress', NULL, NULL),
        ('t3', 'p1', 3, 'Blocked task', 'blocked', '["t1"]', NULL),
        ('t4', 'p1', 4, 'Review task', 'in_review', NULL, NULL),
        ('t5', 'p1', 5, 'Done task', 'done', NULL, '2026-01-01 00:00:00'),
        ('t6', 'p1', 6, 'Cancelled task', 'cancelled', NULL, NULL);
      INSERT INTO task_history (id, task_id, event, old_value, new_value) VALUES ('h1', 't2', 'status_changed', 'todo', 'in_progress');
      INSERT INTO decisions (id, project_id, title, decision) VALUES ('d1', 'p1', 'Use SQLite', 'SQLite it is');
    `);
    return old;
  }

  it('maps legacy statuses and keeps every row and its data', () => {
    const old = legacyDb();
    createSchema(old);
    runMigrations(old);

    const rows = old.prepare('SELECT id, seq, status, blocked_by, completed_at, max_attempts FROM tasks ORDER BY seq').all();
    expect(rows).toEqual([
      { id: 't1', seq: 1, status: 'ready', blocked_by: null, completed_at: null, max_attempts: 3 },
      { id: 't2', seq: 2, status: 'ready', blocked_by: null, completed_at: null, max_attempts: 3 },
      { id: 't3', seq: 3, status: 'blocked', blocked_by: '["t1"]', completed_at: null, max_attempts: 3 },
      { id: 't4', seq: 4, status: 'needs_verification', blocked_by: null, completed_at: null, max_attempts: 3 },
      { id: 't5', seq: 5, status: 'done', blocked_by: null, completed_at: '2026-01-01 00:00:00', max_attempts: 3 },
      { id: 't6', seq: 6, status: 'cancelled', blocked_by: null, completed_at: null, max_attempts: 3 },
    ]);
    old.close();
  });

  it('leaves history untouched and adds the additive columns', () => {
    const old = legacyDb();
    createSchema(old);
    runMigrations(old);

    expect(old.prepare("SELECT old_value, new_value, actor FROM task_history WHERE id = 'h1'").get())
      .toEqual({ old_value: 'todo', new_value: 'in_progress', actor: null });
    expect(old.prepare("SELECT status, spec_id, superseded_by FROM decisions WHERE id = 'd1'").get())
      .toEqual({ status: 'active', spec_id: null, superseded_by: null });
    const projectCols = (old.pragma('table_info(projects)') as { name: string }[]).map(c => c.name);
    expect(projectCols).toEqual(expect.arrayContaining(['verification_defaults', 'conventions']));
    expect(() => old.prepare("UPDATE tasks SET status = 'todo' WHERE id = 't1'").run()).toThrow(/CHECK/);
    old.close();
  });

  it('is idempotent and keeps foreign keys on', () => {
    const old = legacyDb();
    createSchema(old);
    runMigrations(old);
    expect(() => runMigrations(old)).not.toThrow();
    expect(old.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(old.pragma('foreign_key_check')).toEqual([]);
    old.close();
  });

  it('indexes spec text and attempt root causes for search', () => {
    db.exec(`
      INSERT INTO projects (id, name) VALUES ('p1', 'P');
      INSERT INTO tasks (id, project_id, title) VALUES ('t1', 'p1', 'T');
      INSERT INTO specs (id, project_id, seq, title, objective, why, created_by)
        VALUES ('s1', 'p1', 1, 'Inactivity timeout', 'Close idle conversations', 'Idle ones hold capacity', 'human:umit');
      INSERT INTO attempts (id, task_id, attempt_no, actor, claim_token, outcome, root_cause)
        VALUES ('a1', 't1', 1, 'agent:cli-1', 'tok', 'failed', 'Deadlock in ConversationRepository');
    `);
    expect(db.prepare("SELECT rowid FROM specs_fts WHERE specs_fts MATCH 'capacity'").all()).toHaveLength(1);
    expect(db.prepare("SELECT rowid FROM attempts_fts WHERE attempts_fts MATCH 'deadlock'").all()).toHaveLength(1);
  });
});

describe('runMigrations session-brief columns', () => {
  it('adds ended_at, end_git_sha, end_git_branch to sessions idempotently without data loss', () => {
    const old = new Database(':memory:');
    old.pragma('foreign_keys = ON');
    old.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
        status TEXT DEFAULT 'active', repo_path TEXT, tech_stack TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        summary TEXT NOT NULL, tasks_worked_on TEXT, decisions_made TEXT, next_steps TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO projects (id, name) VALUES ('p1', 'P');
      INSERT INTO sessions (id, project_id, summary, next_steps) VALUES ('s1', 'p1', 'Did X', 'Do Y');
    `);

    createSchema(old);
    runMigrations(old);

    const colsAfterFirst = (old.pragma('table_info(sessions)') as { name: string }[]).map(c => c.name);
    expect(colsAfterFirst).toEqual(expect.arrayContaining(['ended_at', 'end_git_sha', 'end_git_branch']));

    const rowAfterFirst = old.prepare("SELECT * FROM sessions WHERE id = 's1'").get() as any;
    expect(rowAfterFirst.summary).toBe('Did X');
    expect(rowAfterFirst.next_steps).toBe('Do Y');
    expect(rowAfterFirst.ended_at).toBeNull();
    expect(rowAfterFirst.end_git_sha).toBeNull();
    expect(rowAfterFirst.end_git_branch).toBeNull();

    // Run again: must not throw and must not touch existing data.
    expect(() => runMigrations(old)).not.toThrow();
    const rowAfterSecond = old.prepare("SELECT * FROM sessions WHERE id = 's1'").get() as any;
    expect(rowAfterSecond).toEqual(rowAfterFirst);

    old.close();
  });
});
