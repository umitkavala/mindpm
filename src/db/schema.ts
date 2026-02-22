import type Database from 'better-sqlite3';
import { generateSlug, generateId } from '../utils/ids.js';

export function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      slug TEXT,
      description TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'archived')),
      repo_path TEXT,
      tech_stack TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      seq INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('critical', 'high', 'medium', 'low')),
      tags TEXT,
      parent_task_id TEXT REFERENCES tasks(id),
      blocked_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS task_history (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      event TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_task_history_task_id ON task_history(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_history_created_at ON task_history(created_at);

    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT REFERENCES tasks(id),
      title TEXT NOT NULL,
      decision TEXT NOT NULL,
      reasoning TEXT,
      alternatives TEXT,
      tags TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      task_id TEXT REFERENCES tasks(id),
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general' CHECK(category IN ('general', 'architecture', 'bug', 'idea', 'research', 'meeting', 'review')),
      tags TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      summary TEXT NOT NULL,
      tasks_worked_on TEXT,
      decisions_made TEXT,
      next_steps TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS context (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, key)
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);

    CREATE INDEX IF NOT EXISTS idx_decisions_project_id ON decisions(project_id);
    CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at);

    CREATE INDEX IF NOT EXISTS idx_notes_project_id ON notes(project_id);
    CREATE INDEX IF NOT EXISTS idx_notes_task_id ON notes(task_id);
    CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(category);
    CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at);

    CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);

    CREATE INDEX IF NOT EXISTS idx_context_project_id ON context(project_id);

    -- Triggers for updated_at (WHEN clause prevents infinite recursion)
    CREATE TRIGGER IF NOT EXISTS trg_projects_updated_at
    AFTER UPDATE ON projects
    FOR EACH ROW
    WHEN NEW.updated_at = OLD.updated_at
    BEGIN
      UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_tasks_updated_at
    AFTER UPDATE ON tasks
    FOR EACH ROW
    WHEN NEW.updated_at = OLD.updated_at
    BEGIN
      UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_context_updated_at
    AFTER UPDATE ON context
    FOR EACH ROW
    WHEN NEW.updated_at = OLD.updated_at
    BEGIN
      UPDATE context SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;
  `);
}

// Idempotent migrations for columns added after initial release
export function runMigrations(db: Database.Database): void {
  // Add slug to projects if missing
  const projectCols = (db.pragma('table_info(projects)') as { name: string }[]).map(c => c.name);
  if (!projectCols.includes('slug')) {
    db.exec('ALTER TABLE projects ADD COLUMN slug TEXT');
    // Backfill slugs for existing projects, making each unique
    const projects = db.prepare('SELECT id, name FROM projects').all() as { id: string; name: string }[];
    const usedSlugs = new Set<string>();
    for (const p of projects) {
      let slug = generateSlug(p.name);
      let candidate = slug;
      let n = 2;
      while (usedSlugs.has(candidate)) {
        candidate = slug + n++;
      }
      usedSlugs.add(candidate);
      db.prepare('UPDATE projects SET slug = ? WHERE id = ?').run(candidate, p.id);
    }
  }

  // Add seq to tasks if missing
  const taskCols = (db.pragma('table_info(tasks)') as { name: string }[]).map(c => c.name);
  if (!taskCols.includes('seq')) {
    db.exec('ALTER TABLE tasks ADD COLUMN seq INTEGER');
    // Backfill seq per project ordered by created_at
    const projects = db.prepare('SELECT id FROM projects').all() as { id: string }[];
    for (const p of projects) {
      const tasks = db.prepare(
        'SELECT id FROM tasks WHERE project_id = ? ORDER BY created_at ASC, id ASC'
      ).all(p.id) as { id: string }[];
      tasks.forEach((t, i) => {
        db.prepare('UPDATE tasks SET seq = ? WHERE id = ?').run(i + 1, t.id);
      });
    }
  }

  // Create idx_tasks_seq here (after seq column is guaranteed to exist)
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_seq'").get()) {
    db.exec('CREATE INDEX idx_tasks_seq ON tasks(project_id, seq)');
  }

  // Add task_id to decisions if missing
  const decisionCols = (db.pragma('table_info(decisions)') as { name: string }[]).map(c => c.name);
  if (!decisionCols.includes('task_id')) {
    db.exec('ALTER TABLE decisions ADD COLUMN task_id TEXT REFERENCES tasks(id)');
  }

  // Backfill task_history created events for existing tasks (run once)
  const historyCount = (db.prepare('SELECT COUNT(*) as n FROM task_history').get() as { n: number }).n;
  if (historyCount === 0) {
    const tasks = db.prepare('SELECT id, status, priority, created_at FROM tasks').all() as { id: string; status: string; priority: string; created_at: string }[];
    const insert = db.prepare('INSERT INTO task_history (id, task_id, event, new_value, created_at) VALUES (?, ?, ?, ?, ?)');
    const insertMany = db.transaction(() => {
      for (const t of tasks) {
        insert.run(generateId(), t.id, 'created', JSON.stringify({ status: t.status, priority: t.priority }), t.created_at);
      }
    });
    insertMany();
  }
}
