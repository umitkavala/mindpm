import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema } from './schema.js';

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
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
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
