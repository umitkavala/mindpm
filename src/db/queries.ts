import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { getDb } from './connection.js';
import { generateId } from '../utils/ids.js';
import { getSessionStartedProjects } from '../utils/session-state.js';

// Helper to resolve a project by name or ID
export function resolveProjectId(projectRef: string): string | null {
  const db = getDb();
  // Try as ID first
  const byId = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectRef) as { id: string } | undefined;
  if (byId) return byId.id;

  // Try as name (case-insensitive)
  const byName = db.prepare('SELECT id FROM projects WHERE LOWER(name) = LOWER(?)').get(projectRef) as { id: string } | undefined;
  if (byName) return byName.id;

  return null;
}

// Get the sole active project, or null if there are 0 or more than 1.
export function getMostRecentProject(): { id: string; name: string } | null {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, name FROM projects WHERE status = 'active' ORDER BY updated_at DESC LIMIT 2`
  ).all() as { id: string; name: string }[];
  return rows.length === 1 ? rows[0] : null;
}

// Generate a helpful error message when resolveProjectOrDefault returns null.
export function resolveProjectError(projectRef?: string): string {
  if (projectRef) return `Project "${projectRef}" not found.`;

  // If multiple projects were session-started, list those specifically.
  const sessionProjects = getSessionStartedProjects();
  if (sessionProjects.length > 1) {
    const db = getDb();
    const names = (db.prepare(
      `SELECT name FROM projects WHERE id IN (${sessionProjects.map(() => '?').join(',')}) ORDER BY name`
    ).all(...sessionProjects) as { name: string }[]).map(p => p.name);
    return `Working across multiple projects this session. Please specify a project: ${names.join(', ')}`;
  }

  const db = getDb();
  const active = db.prepare(
    `SELECT name FROM projects WHERE status = 'active' ORDER BY name`
  ).all() as { name: string }[];
  if (active.length === 0) return 'No active projects found. Create a project first.';
  return `Multiple active projects found. Please specify a project: ${active.map(p => p.name).join(', ')}`;
}

// Resolve project ref or fall back to:
// 1. The sole session-started project (if exactly one start_session was called this run), or
// 2. The sole active project in the DB (if only one exists).
export function resolveProjectOrDefault(projectRef?: string): { id: string; name: string } | null {
  const db = getDb();

  if (projectRef) {
    const id = resolveProjectId(projectRef);
    if (!id) return null;
    const row = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(id) as { id: string; name: string } | undefined;
    return row ?? null;
  }

  // Prefer the session-started project when unambiguous.
  const sessionProjects = getSessionStartedProjects();
  if (sessionProjects.length === 1) {
    const row = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(sessionProjects[0]) as { id: string; name: string } | undefined;
    if (row) return row;
  }
  if (sessionProjects.length > 1) return null; // ambiguous — require explicit project

  // No sessions started yet — fall back to the sole active project.
  return getMostRecentProject();
}

// Resolve a task_id that may be a hex ID or a short_id like "zrdt-180"
export function resolveTaskId(taskRef: string): string | null {
  const db = getDb();

  // Try direct hex ID first
  const byId = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskRef) as { id: string } | undefined;
  if (byId) return byId.id;

  // Try as short_id: slug-seq (e.g. "zrdt-180")
  const match = taskRef.match(/^(.+)-(\d+)$/);
  if (match) {
    const [, slug, seqStr] = match;
    const row = db.prepare(
      'SELECT t.id FROM tasks t JOIN projects p ON t.project_id = p.id WHERE LOWER(p.slug) = LOWER(?) AND t.seq = ?'
    ).get(slug, parseInt(seqStr, 10)) as { id: string } | undefined;
    if (row) return row.id;
  }

  return null;
}

export function recordTaskHistory(
  taskId: string,
  event: string,
  oldValue: string | null,
  newValue: string | null,
): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO task_history (id, task_id, event, old_value, new_value) VALUES (?, ?, ?, ?, ?)'
  ).run(generateId(), taskId, event, oldValue, newValue);
}

// Validate a candidate repo_path: must exist, be a directory, and contain .git.
export function validateRepoPath(repoPath: string): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(repoPath)) {
    return { ok: false, reason: `Path does not exist: ${repoPath}` };
  }
  let stat;
  try {
    stat = statSync(repoPath);
  } catch {
    return { ok: false, reason: `Path is not accessible: ${repoPath}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: `Path is not a directory: ${repoPath}` };
  }
  if (!existsSync(join(repoPath, '.git'))) {
    return { ok: false, reason: `Path is not a git repository (no .git found): ${repoPath}` };
  }
  return { ok: true };
}

// Resolve a project's repo path: the typed column first, then the legacy
// context key 'repo_path' for projects that predate the column, else null.
export function resolveRepoPath(projectId: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT repo_path FROM projects WHERE id = ?').get(projectId) as
    | { repo_path: string | null }
    | undefined;
  if (row?.repo_path) return row.repo_path;

  const ctx = db.prepare("SELECT value FROM context WHERE project_id = ? AND key = 'repo_path'").get(projectId) as
    | { value: string }
    | undefined;
  return ctx?.value ?? null;
}

export { generateId, getDb };
