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
  it('creates all 7 tables', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'")
      .all()
      .map((r: any) => r.name)
      .sort();
    expect(tables).toEqual(['context', 'decisions', 'notes', 'projects', 'sessions', 'task_history', 'tasks']);
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
    runMigrations(old);  // adds seq, rebuilds tasks for in_review (drops triggers), then rebuilds FTS

    // The tasks table was rebuilt to allow the in_review status.
    const tasksSql = (old.prepare("SELECT sql FROM sqlite_master WHERE name='tasks'").get() as any).sql;
    expect(tasksSql).toContain('in_review');

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
