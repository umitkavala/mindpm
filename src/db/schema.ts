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
      status TEXT DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled')),
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
      ended_at TEXT,
      end_git_sha TEXT,
      end_git_branch TEXT,
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

  // Rebuild so the index is consistent with any rows that already exist before
  // the sync triggers start firing. Without this, the first UPDATE/DELETE on a
  // pre-existing (unindexed) row issues an FTS 'delete' that corrupts the index.
  setupFts(db, true);
}

// Create FTS5 virtual tables (external-content, indexing the base tables) plus
// the triggers that keep them in sync. Idempotent. Pass rebuild=true to
// backfill the index from existing rows (used by runMigrations for DBs whose
// data predates FTS, and after the tasks-table rebuild migration). If FTS5 is
// unavailable in this SQLite build, search silently falls back to LIKE.
export function setupFts(db: Database.Database, rebuild = false): void {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
        title, description, content='tasks', content_rowid='rowid'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        content, content='notes', content_rowid='rowid'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
        title, decision, reasoning, content='decisions', content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS trg_tasks_fts_ai AFTER INSERT ON tasks BEGIN
        INSERT INTO tasks_fts(rowid, title, description) VALUES (new.rowid, new.title, new.description);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_tasks_fts_ad AFTER DELETE ON tasks BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, title, description) VALUES('delete', old.rowid, old.title, old.description);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_tasks_fts_au AFTER UPDATE ON tasks BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, title, description) VALUES('delete', old.rowid, old.title, old.description);
        INSERT INTO tasks_fts(rowid, title, description) VALUES (new.rowid, new.title, new.description);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_notes_fts_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_notes_fts_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_notes_fts_au AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO notes_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_decisions_fts_ai AFTER INSERT ON decisions BEGIN
        INSERT INTO decisions_fts(rowid, title, decision, reasoning) VALUES (new.rowid, new.title, new.decision, new.reasoning);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_decisions_fts_ad AFTER DELETE ON decisions BEGIN
        INSERT INTO decisions_fts(decisions_fts, rowid, title, decision, reasoning) VALUES('delete', old.rowid, old.title, old.decision, old.reasoning);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_decisions_fts_au AFTER UPDATE ON decisions BEGIN
        INSERT INTO decisions_fts(decisions_fts, rowid, title, decision, reasoning) VALUES('delete', old.rowid, old.title, old.decision, old.reasoning);
        INSERT INTO decisions_fts(rowid, title, decision, reasoning) VALUES (new.rowid, new.title, new.decision, new.reasoning);
      END;
    `);

    if (rebuild) {
      db.exec(`
        INSERT INTO tasks_fts(tasks_fts) VALUES('rebuild');
        INSERT INTO notes_fts(notes_fts) VALUES('rebuild');
        INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild');
      `);
    }
  } catch (err) {
    process.stderr.write(`[mindpm] FTS5 setup skipped (search will use LIKE fallback): ${err}\n`);
  }
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

  // Migrate tasks table CHECK constraint to add in_review status
  const tasksSchemaSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string } | undefined)?.sql ?? '';
  if (!tasksSchemaSql.includes('in_review')) {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE tasks_new (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          seq INTEGER,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled')),
          priority TEXT DEFAULT 'medium' CHECK(priority IN ('critical', 'high', 'medium', 'low')),
          tags TEXT,
          parent_task_id TEXT REFERENCES tasks(id),
          blocked_by TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          completed_at DATETIME
        );
        INSERT INTO tasks_new (id, project_id, seq, title, description, status, priority, tags, parent_task_id, blocked_by, created_at, updated_at, completed_at)
        SELECT id, project_id, seq, title, description, status, priority, tags, parent_task_id, blocked_by, created_at, updated_at, completed_at FROM tasks;
        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;
      `);
    })();
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_tasks_updated_at
      AFTER UPDATE ON tasks
      FOR EACH ROW
      WHEN NEW.updated_at = OLD.updated_at
      BEGIN
        UPDATE tasks SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;
      CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_seq ON tasks(project_id, seq);
    `);
  }

  // Add session-brief columns to sessions if missing
  const sessionCols = (db.pragma('table_info(sessions)') as { name: string }[]).map(c => c.name);
  if (!sessionCols.includes('ended_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN ended_at TEXT');
  }
  if (!sessionCols.includes('end_git_sha')) {
    db.exec('ALTER TABLE sessions ADD COLUMN end_git_sha TEXT');
  }
  if (!sessionCols.includes('end_git_branch')) {
    db.exec('ALTER TABLE sessions ADD COLUMN end_git_branch TEXT');
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

  // Ensure FTS tables/triggers exist and are populated. Runs last so it survives
  // the tasks-table rebuild above and backfills rows that predate FTS.
  setupFts(db, true);
}
