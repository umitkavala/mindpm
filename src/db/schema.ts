import type Database from 'better-sqlite3';
import { generateSlug, generateId } from '../utils/ids.js';

// Task columns, shared by createSchema and the tasks-table rebuild migration.
// Statuses are handoff states only; see src/domain/lifecycle.ts. 'verified' was
// reserved in 2.0 so the Phase 2 verifier didn't need another rebuild.
const TASKS_COLUMNS = `
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      seq INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'ready' CHECK(status IN ('backlog', 'ready', 'claimed', 'blocked', 'needs_verification', 'verified', 'needs_human', 'done', 'cancelled')),
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('critical', 'high', 'medium', 'low')),
      tags TEXT,
      parent_task_id TEXT REFERENCES tasks(id),
      blocked_by TEXT,
      spec_id TEXT REFERENCES specs(id),
      verification TEXT,
      branch TEXT,
      claimed_by TEXT,
      claim_token TEXT,
      lease_expires_at DATETIME,
      max_attempts INTEGER DEFAULT 3,
      verified_run_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME`;

// Legacy status → new status, applied once by the tasks-table rebuild.
const LEGACY_STATUS_SQL = `CASE status
  WHEN 'todo' THEN 'ready'
  WHEN 'in_progress' THEN 'ready'
  WHEN 'in_review' THEN 'needs_verification'
  ELSE status END`;

const PHASE1_TABLES = `
    CREATE TABLE IF NOT EXISTS specs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      seq INTEGER NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      why TEXT NOT NULL,
      approach TEXT,
      constraints TEXT,
      out_of_scope TEXT,
      risk_level TEXT NOT NULL DEFAULT 'medium' CHECK(risk_level IN ('low', 'medium', 'high')),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'approved', 'superseded', 'cancelled')),
      version INTEGER NOT NULL DEFAULT 1,
      superseded_by TEXT REFERENCES specs(id),
      approved_by TEXT,
      approved_at DATETIME,
      approved_hash TEXT,
      created_by TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, seq)
    );

    CREATE TABLE IF NOT EXISTS acceptance_criteria (
      id TEXT PRIMARY KEY,
      spec_id TEXT NOT NULL REFERENCES specs(id),
      seq INTEGER NOT NULL,
      statement TEXT NOT NULL,
      verify_kind TEXT NOT NULL DEFAULT 'test' CHECK(verify_kind IN ('test', 'command', 'review')),
      verify_ref TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(spec_id, seq)
    );

    CREATE TABLE IF NOT EXISTS task_criteria (
      task_id TEXT NOT NULL REFERENCES tasks(id),
      criterion_id TEXT NOT NULL REFERENCES acceptance_criteria(id),
      PRIMARY KEY (task_id, criterion_id)
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      attempt_no INTEGER NOT NULL,
      actor TEXT NOT NULL,
      claim_token TEXT NOT NULL UNIQUE,
      lease_minutes INTEGER NOT NULL DEFAULT 30,
      spec_version INTEGER,
      outcome TEXT NOT NULL DEFAULT 'active'
        CHECK(outcome IN ('active', 'submitted', 'failed', 'abandoned', 'expired')),
      failure_type TEXT CHECK(failure_type IN ('build_error', 'test_failure', 'spec_gap',
        'environment', 'dependency', 'design_conflict', 'timeout', 'other')),
      root_cause TEXT CHECK(length(root_cause) <= 600),
      notes TEXT CHECK(length(notes) <= 1500),
      branch TEXT,
      head_sha TEXT,
      files_touched TEXT,
      summary TEXT CHECK(length(summary) <= 1500),
      criteria_results TEXT,
      escalation TEXT,
      review_decision TEXT CHECK(review_decision IN ('accept', 'reject')),
      review_findings TEXT CHECK(length(review_findings) <= 1500),
      reviewed_by TEXT,
      verification_outcome TEXT CHECK(verification_outcome IN ('passed', 'failed')),
      verification_findings TEXT,
      self_report_mismatch INTEGER NOT NULL DEFAULT 0,
      consecutive_errors INTEGER NOT NULL DEFAULT 0,
      submitted_from TEXT,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME,
      UNIQUE(task_id, attempt_no)
    );

    CREATE TRIGGER IF NOT EXISTS trg_specs_updated_at
    AFTER UPDATE ON specs
    FOR EACH ROW
    WHEN NEW.updated_at = OLD.updated_at
    BEGIN
      UPDATE specs SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;`;

// Project-level changes a human made, such as turning verification on or off.
const PROJECT_HISTORY_TABLE = `
    CREATE TABLE IF NOT EXISTS project_history (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      event TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      actor TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_project_history_project_id ON project_history(project_id);`;

// Phase 2: verifiers and their runs. A run belongs to one attempt and one SHA;
// check_results hold what was executed, criterion_results what was concluded.
const PHASE2_TABLES = `
    CREATE TABLE IF NOT EXISTS verifiers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('local', 'reviewer')),
      key_hash TEXT NOT NULL UNIQUE,
      project_ids TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME,
      revoked_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS verification_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      attempt_id TEXT NOT NULL REFERENCES attempts(id),
      verifier_id TEXT NOT NULL REFERENCES verifiers(id),
      head_sha TEXT NOT NULL,
      spec_version INTEGER,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('running', 'passed', 'failed', 'error', 'superseded')),
      error_reason TEXT CHECK(length(error_reason) <= 600),
      environment TEXT,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      lease_expires_at DATETIME NOT NULL,
      ended_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS check_results (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES verification_runs(id),
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      exit_code INTEGER,
      duration_ms INTEGER,
      output_tail TEXT CHECK(length(output_tail) <= 4000),
      report TEXT,
      UNIQUE(run_id, name)
    );

    CREATE TABLE IF NOT EXISTS criterion_results (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES verification_runs(id),
      criterion_id TEXT NOT NULL REFERENCES acceptance_criteria(id),
      result TEXT NOT NULL CHECK(result IN ('pass', 'fail', 'missing')),
      source TEXT NOT NULL CHECK(source IN ('test', 'command', 'review')),
      evidence TEXT NOT NULL CHECK(length(evidence) <= 1500),
      recorded_by TEXT NOT NULL REFERENCES verifiers(id),
      UNIQUE(run_id, criterion_id)
    );

    CREATE INDEX IF NOT EXISTS idx_verification_runs_task_id ON verification_runs(task_id);
    CREATE INDEX IF NOT EXISTS idx_verification_runs_attempt_id ON verification_runs(attempt_id);
    -- At most one running run per task.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_runs_one_running
      ON verification_runs(task_id) WHERE status = 'running';
    CREATE INDEX IF NOT EXISTS idx_check_results_run_id ON check_results(run_id);
    CREATE INDEX IF NOT EXISTS idx_criterion_results_run_id ON criterion_results(run_id);`;

// Indexes on Phase 1 columns. Kept out of createSchema's main block because on
// an existing database those columns only exist after runMigrations.
function createPhase1Indexes(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_spec_id ON tasks(spec_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_claim_token ON tasks(claim_token);
    CREATE INDEX IF NOT EXISTS idx_specs_project_id ON specs(project_id);
    CREATE INDEX IF NOT EXISTS idx_acceptance_criteria_spec_id ON acceptance_criteria(spec_id);
    CREATE INDEX IF NOT EXISTS idx_attempts_task_id ON attempts(task_id);
    CREATE INDEX IF NOT EXISTS idx_decisions_spec_id ON decisions(spec_id);
  `);
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map(c => c.name);
}

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
      verification_defaults TEXT,
      conventions TEXT,
      verifier_config TEXT,
      verification TEXT NOT NULL DEFAULT 'off' CHECK(verification IN ('off', 'on')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tasks (
${TASKS_COLUMNS}
    );

    CREATE TABLE IF NOT EXISTS task_history (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      event TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      actor TEXT,
      on_behalf_of TEXT,
      attempt_id TEXT REFERENCES attempts(id),
      verifier_id TEXT,
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
      spec_id TEXT REFERENCES specs(id),
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'superseded')),
      superseded_by TEXT REFERENCES decisions(id),
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

${PHASE1_TABLES}

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

  if (columnsOf(db, 'tasks').includes('spec_id') && columnsOf(db, 'decisions').includes('spec_id')) {
    createPhase1Indexes(db);
  }
  // Phase 2 tables reference attempts and acceptance_criteria, which exist by
  // now on any database (PHASE1_TABLES above creates them if missing).
  db.exec(PHASE2_TABLES);
  db.exec(PROJECT_HISTORY_TABLE);

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
      CREATE VIRTUAL TABLE IF NOT EXISTS specs_fts USING fts5(
        title, objective, why, content='specs', content_rowid='rowid'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS attempts_fts USING fts5(
        root_cause, content='attempts', content_rowid='rowid'
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

      CREATE TRIGGER IF NOT EXISTS trg_specs_fts_ai AFTER INSERT ON specs BEGIN
        INSERT INTO specs_fts(rowid, title, objective, why) VALUES (new.rowid, new.title, new.objective, new.why);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_specs_fts_ad AFTER DELETE ON specs BEGIN
        INSERT INTO specs_fts(specs_fts, rowid, title, objective, why) VALUES('delete', old.rowid, old.title, old.objective, old.why);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_specs_fts_au AFTER UPDATE ON specs BEGIN
        INSERT INTO specs_fts(specs_fts, rowid, title, objective, why) VALUES('delete', old.rowid, old.title, old.objective, old.why);
        INSERT INTO specs_fts(rowid, title, objective, why) VALUES (new.rowid, new.title, new.objective, new.why);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_attempts_fts_ai AFTER INSERT ON attempts BEGIN
        INSERT INTO attempts_fts(rowid, root_cause) VALUES (new.rowid, new.root_cause);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_attempts_fts_ad AFTER DELETE ON attempts BEGIN
        INSERT INTO attempts_fts(attempts_fts, rowid, root_cause) VALUES('delete', old.rowid, old.root_cause);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_attempts_fts_au AFTER UPDATE ON attempts BEGIN
        INSERT INTO attempts_fts(attempts_fts, rowid, root_cause) VALUES('delete', old.rowid, old.root_cause);
        INSERT INTO attempts_fts(rowid, root_cause) VALUES (new.rowid, new.root_cause);
      END;
    `);

    if (rebuild) {
      db.exec(`
        INSERT INTO tasks_fts(tasks_fts) VALUES('rebuild');
        INSERT INTO notes_fts(notes_fts) VALUES('rebuild');
        INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild');
        INSERT INTO specs_fts(specs_fts) VALUES('rebuild');
        INSERT INTO attempts_fts(attempts_fts) VALUES('rebuild');
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

  migratePhase1(db);
  migratePhase2(db);
  migrateVerificationSetting(db);
  migrateSubmittedFrom(db);

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

// True when this database predates Phase 1 and the next runMigrations will
// rebuild its tasks table. A brand-new database (no tasks table) is false.
export function needsPhase1Migration(db: Database.Database): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string } | undefined;
  return !!row && !row.sql.includes('needs_verification');
}

// True when this database predates Phase 2 and the next runMigrations will add
// verification columns. Checked on attempts, which every 2.0 database has.
export function needsPhase2Migration(db: Database.Database): boolean {
  const hasAttempts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attempts'").get();
  return !!hasAttempts && !columnsOf(db, 'attempts').includes('verification_outcome');
}

// True when this database predates 3.1 and the next runMigrations will add
// the per-project verification setting.
export function needsVerificationSettingMigration(db: Database.Database): boolean {
  const hasProjects = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get();
  return !!hasProjects && !columnsOf(db, 'projects').includes('verification');
}

// True when this database predates 3.2 and the next runMigrations will add
// attempts.submitted_from.
export function needsSubmittedFromMigration(db: Database.Database): boolean {
  const hasAttempts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attempts'").get();
  return !!hasAttempts && !columnsOf(db, 'attempts').includes('submitted_from');
}

// 3.2: the connection that submitted an attempt, so that connection can't
// accept the work under another actor id. Older submissions stay NULL.
function migrateSubmittedFrom(db: Database.Database): void {
  if (needsSubmittedFromMigration(db)) db.exec('ALTER TABLE attempts ADD COLUMN submitted_from TEXT');
}

// 3.1: verification became opt-in per project. Projects an active local
// verifier key covers at upgrade time keep the gate; all others turn it off.
function migrateVerificationSetting(db: Database.Database): void {
  if (!needsVerificationSettingMigration(db)) return;
  db.transaction(() => {
    db.exec("ALTER TABLE projects ADD COLUMN verification TEXT NOT NULL DEFAULT 'off' CHECK(verification IN ('off', 'on'))");
    db.exec(PROJECT_HISTORY_TABLE);
    const keys = db.prepare("SELECT project_ids FROM verifiers WHERE revoked_at IS NULL AND kind = 'local'").all() as { project_ids: string }[];
    const covered = new Set<string>();
    for (const k of keys) {
      try {
        const ids = JSON.parse(k.project_ids);
        if (Array.isArray(ids)) ids.forEach(id => covered.add(String(id)));
      } catch {}
    }
    const turnOn = db.prepare("UPDATE projects SET verification = 'on' WHERE id = ?");
    const log = db.prepare(
      "INSERT INTO project_history (id, project_id, event, old_value, new_value, actor) VALUES (?, ?, 'verification_changed', NULL, 'on', 'system:migration')",
    );
    for (const { id } of db.prepare('SELECT id FROM projects').all() as { id: string }[]) {
      if (!covered.has('*') && !covered.has(id)) continue;
      turnOn.run(id);
      log.run(generateId(), id);
    }
  })();
}

// Phase 2 (verification gate). Additive only: the new tables come from
// createSchema, this adds nullable columns to existing tables. 'verified' has
// been in the tasks CHECK since 2.0, so no rebuild.
function migratePhase2(db: Database.Database): void {
  const add = (table: string, column: string, ddl: string) => {
    if (!columnsOf(db, table).includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  };
  db.transaction(() => {
    add('tasks', 'verified_run_id', 'TEXT');
    add('projects', 'verifier_config', 'TEXT');
    add('task_history', 'verifier_id', 'TEXT');
    add('attempts', 'verification_outcome', "TEXT CHECK(verification_outcome IN ('passed', 'failed'))");
    add('attempts', 'verification_findings', 'TEXT');
    add('attempts', 'self_report_mismatch', 'INTEGER NOT NULL DEFAULT 0');
    add('attempts', 'consecutive_errors', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(PHASE2_TABLES);
  })();
}

// Phase 1 (specs, attempts, handoff statuses). Runs as one transaction: the
// tasks table is rebuilt because SQLite can't alter a CHECK constraint, legacy
// statuses are mapped, and additive columns land on projects, decisions and
// task_history. Detected by the new CHECK set, so it runs exactly once.
function migratePhase1(db: Database.Database): void {
  const tasksSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string } | undefined)?.sql ?? '';
  if (tasksSql.includes('needs_verification')) {
    createPhase1Indexes(db);
    return;
  }

  // foreign_keys can't be toggled inside a transaction.
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      const oldCols = columnsOf(db, 'tasks');
      db.exec(`CREATE TABLE tasks_new (${TASKS_COLUMNS}\n);`);
      const newCols = columnsOf(db, 'tasks_new');
      const shared = oldCols.filter(c => newCols.includes(c) && c !== 'status');
      db.exec(`
        INSERT INTO tasks_new (${shared.join(', ')}, status)
        SELECT ${shared.join(', ')}, ${LEGACY_STATUS_SQL} FROM tasks;
        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;
      `);

      const projectCols = columnsOf(db, 'projects');
      if (!projectCols.includes('verification_defaults')) db.exec('ALTER TABLE projects ADD COLUMN verification_defaults TEXT');
      if (!projectCols.includes('conventions')) db.exec('ALTER TABLE projects ADD COLUMN conventions TEXT');

      const decisionCols = columnsOf(db, 'decisions');
      if (!decisionCols.includes('spec_id')) db.exec('ALTER TABLE decisions ADD COLUMN spec_id TEXT REFERENCES specs(id)');
      if (!decisionCols.includes('status')) {
        db.exec("ALTER TABLE decisions ADD COLUMN status TEXT DEFAULT 'active' CHECK(status IN ('active', 'superseded'))");
      }
      if (!decisionCols.includes('superseded_by')) db.exec('ALTER TABLE decisions ADD COLUMN superseded_by TEXT REFERENCES decisions(id)');

      const historyCols = columnsOf(db, 'task_history');
      if (!historyCols.includes('actor')) db.exec('ALTER TABLE task_history ADD COLUMN actor TEXT');
      if (!historyCols.includes('attempt_id')) db.exec('ALTER TABLE task_history ADD COLUMN attempt_id TEXT REFERENCES attempts(id)');
      if (!historyCols.includes('on_behalf_of')) db.exec('ALTER TABLE task_history ADD COLUMN on_behalf_of TEXT');

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
      createPhase1Indexes(db);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
