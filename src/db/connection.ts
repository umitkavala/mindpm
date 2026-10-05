import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { homedir } from 'os';
import { createSchema, needsPhase1Migration, needsPhase2Migration, runMigrations } from './schema.js';
import { AGENT_INSTRUCTIONS, AGENT_INSTRUCTIONS_VERSION } from '../tools/meta.js';

const MARKER_RE = /^<!-- mindpm agent instructions v(\S+) -->/;

// Keep AGENT.md in step with the server. The first line carries the
// instructions version; on a mismatch the file is rewritten, and the old copy
// is kept as AGENT.md.bak-<old version> in case the user edited it.
export function syncAgentInstructions(path: string): 'created' | 'updated' | 'current' {
  const content = `<!-- mindpm agent instructions v${AGENT_INSTRUCTIONS_VERSION} -->\n\n${AGENT_INSTRUCTIONS}`;
  if (!existsSync(path)) {
    writeFileSync(path, content, 'utf8');
    return 'created';
  }
  const old = readFileSync(path, 'utf8');
  const version = old.match(MARKER_RE)?.[1];
  if (version === AGENT_INSTRUCTIONS_VERSION) return 'current';
  const backup = `${path}.bak-${version ?? 'pre-2.0.0'}`;
  if (!existsSync(backup)) copyFileSync(path, backup);
  writeFileSync(path, content, 'utf8');
  return 'updated';
}

// Copy the database before a migration changes it: the Phase 1 rebuild of the
// tasks table (backup .pre-2.0.0) or the Phase 2 verification columns
// (.pre-3.0.0). VACUUM INTO writes a consistent snapshot even in WAL mode with
// other connections open. An existing backup is never overwritten: the first
// one is the pre-migration state. If the copy fails, the migration doesn't run.
export function backupBeforeMigration(database: Database.Database, dbPath: string): string | null {
  if (dbPath === ':memory:') return null;
  const suffix = needsPhase1Migration(database) ? 'pre-2.0.0' : needsPhase2Migration(database) ? 'pre-3.0.0' : null;
  if (!suffix) return null;
  const backup = `${dbPath}.${suffix}`;
  if (existsSync(backup)) return backup;
  try {
    database.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  } catch (err) {
    throw new Error(`Could not back up the database to ${backup} before migrating, so the migration did not run: ${err}`);
  }
  return backup;
}

let db: Database.Database | null = null;

function resolveDbPath(): string {
  const envPath = process.env.MINDPM_DB_PATH || process.env.PROJECT_MEMORY_DB_PATH;
  if (envPath) {
    return envPath.replace(/^~/, homedir());
  }
  return resolve(homedir(), '.mindpm', 'memory.db');
}

export function ensureDbDirectory(): void {
  const dbPath = resolveDbPath();
  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true });

  const agentMdPath = resolve(dir, 'AGENT.md');
  const result = syncAgentInstructions(agentMdPath);
  if (result === 'created') process.stderr.write(`[mindpm] Created ${agentMdPath}\n`);
  if (result === 'updated') process.stderr.write(`[mindpm] Updated ${agentMdPath} (previous copy kept alongside as .bak)\n`);
}

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = resolveDbPath();
  process.stderr.write(`[mindpm] Opening database: ${dbPath}\n`);
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('wal_autocheckpoint = 100');
  db.pragma('foreign_keys = ON');
  // Wait (instead of throwing SQLITE_BUSY) when another connection holds the
  // write lock — e.g. a WAL checkpoint overlapping an MCP write. Keeps
  // log_decision/create_task resilient under concurrent UI reads.
  db.pragma('busy_timeout = 5000');

  try {
    const backup = backupBeforeMigration(db, dbPath);
    if (backup) process.stderr.write(`[mindpm] Pre-migration backup: ${backup}\n`);
    process.stderr.write('[mindpm] Running createSchema...\n');
    createSchema(db);
    process.stderr.write('[mindpm] Running runMigrations...\n');
    runMigrations(db);
    process.stderr.write('[mindpm] Database ready.\n');
  } catch (err) {
    process.stderr.write(`[mindpm] Database init failed: ${err}\n`);
    // Don't cache a half-initialized connection: the next call retries.
    db.close();
    db = null;
    throw err;
  }

  return db;
}

export function closeDb(): void {
  if (db) {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    db = null;
  }
}
