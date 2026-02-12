import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { homedir } from 'os';
import { createSchema } from './schema.js';

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
  mkdirSync(dirname(dbPath), { recursive: true });
}

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = resolveDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('wal_autocheckpoint = 100');
  db.pragma('foreign_keys = ON');

  createSchema(db);

  return db;
}

export function closeDb(): void {
  if (db) {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    db = null;
  }
}
