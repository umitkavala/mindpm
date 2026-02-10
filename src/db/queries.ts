import { getDb } from './connection.js';
import { generateId } from '../utils/ids.js';

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

// Get the most recently active project
export function getMostRecentProject(): { id: string; name: string } | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT id, name FROM projects WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`
  ).get() as { id: string; name: string } | undefined;
  return row ?? null;
}

// Resolve project ref or fall back to most recent
export function resolveProjectOrDefault(projectRef?: string): { id: string; name: string } | null {
  const db = getDb();

  if (projectRef) {
    const id = resolveProjectId(projectRef);
    if (!id) return null;
    const row = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(id) as { id: string; name: string } | undefined;
    return row ?? null;
  }

  return getMostRecentProject();
}

export { generateId, getDb };
