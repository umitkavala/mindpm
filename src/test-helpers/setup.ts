import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createSchema } from '../db/schema.js';
import { resetAutoSession } from '../tools/auto-session.js';

let testDb: Database.Database | null = null;

export function createTestDb(): Database.Database {
  resetAutoSession();
  testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('foreign_keys = ON');
  createSchema(testDb);
  return testDb;
}

export function getTestDb(): Database.Database {
  if (!testDb) throw new Error('Test DB not initialized. Call createTestDb() first.');
  return testDb;
}

export function closeTestDb(): void {
  if (testDb) {
    testDb.close();
    testDb = null;
  }
}

export function seedProject(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    name: string;
    description: string;
    status: string;
    tech_stack: string;
    repo_path: string;
  }> = {},
): string {
  const id = overrides.id ?? 'proj0001';
  db.prepare(
    `INSERT INTO projects (id, name, description, status, tech_stack, repo_path) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.name ?? 'Test Project',
    overrides.description ?? null,
    overrides.status ?? 'active',
    overrides.tech_stack ?? null,
    overrides.repo_path ?? null,
  );
  return id;
}

export function seedTask(
  db: Database.Database,
  projectId: string,
  overrides: Partial<{
    id: string;
    title: string;
    description: string;
    status: string;
    priority: string;
    tags: string;
    parent_task_id: string;
    blocked_by: string;
  }> = {},
): string {
  const id = overrides.id ?? 'task0001';
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, status, priority, tags, parent_task_id, blocked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    overrides.title ?? 'Test Task',
    overrides.description ?? null,
    overrides.status ?? 'todo',
    overrides.priority ?? 'medium',
    overrides.tags ?? null,
    overrides.parent_task_id ?? null,
    overrides.blocked_by ?? null,
  );
  return id;
}

export function seedDecision(
  db: Database.Database,
  projectId: string,
  overrides: Partial<{
    id: string;
    title: string;
    decision: string;
    reasoning: string;
    alternatives: string;
    tags: string;
  }> = {},
): string {
  const id = overrides.id ?? 'dec00001';
  db.prepare(
    `INSERT INTO decisions (id, project_id, title, decision, reasoning, alternatives, tags) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    overrides.title ?? 'Test Decision',
    overrides.decision ?? 'We decided X',
    overrides.reasoning ?? null,
    overrides.alternatives ?? null,
    overrides.tags ?? null,
  );
  return id;
}

export function seedNote(
  db: Database.Database,
  projectId: string,
  overrides: Partial<{
    id: string;
    task_id: string;
    content: string;
    category: string;
    tags: string;
  }> = {},
): string {
  const id = overrides.id ?? 'note0001';
  db.prepare(
    `INSERT INTO notes (id, project_id, task_id, content, category, tags) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    overrides.task_id ?? null,
    overrides.content ?? 'Test note content',
    overrides.category ?? 'general',
    overrides.tags ?? null,
  );
  return id;
}

export function seedSession(
  db: Database.Database,
  projectId: string,
  overrides: Partial<{
    id: string;
    summary: string;
    tasks_worked_on: string;
    decisions_made: string;
    next_steps: string;
  }> = {},
): string {
  const id = overrides.id ?? 'sess0001';
  db.prepare(
    `INSERT INTO sessions (id, project_id, summary, tasks_worked_on, decisions_made, next_steps) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    overrides.summary ?? 'Test session summary',
    overrides.tasks_worked_on ?? null,
    overrides.decisions_made ?? null,
    overrides.next_steps ?? null,
  );
  return id;
}

export function seedContext(
  db: Database.Database,
  projectId: string,
  key: string,
  value: string,
  overrides: Partial<{ id: string; category: string }> = {},
): string {
  const id = overrides.id ?? 'ctx00001';
  db.prepare(
    `INSERT INTO context (id, project_id, key, value, category) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, projectId, key, value, overrides.category ?? 'general');
  return id;
}

export function parseToolResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }): any {
  let text = result.content[0].text;
  // Strip auto-session preamble if present (format: "...\n\n---\n\n{json}")
  const sep = '\n\n---\n\n';
  const sepIdx = text.indexOf(sep);
  if (sepIdx !== -1) text = text.slice(sepIdx + sep.length);
  try {
    return JSON.parse(text);
  } catch {
    // Handle start_session format: "Kanban board: ...\n\n{json}"
    const nnIdx = text.indexOf('\n\n');
    if (nnIdx !== -1) {
      try { return JSON.parse(text.slice(nnIdx + 2)); } catch {}
    }
    return text;
  }
}

export function createToolCaller(server: McpServer) {
  return async function callTool(name: string, args: Record<string, any> = {}) {
    const tool = (server as any)._registeredTools[name];
    if (!tool) throw new Error(`Tool "${name}" not registered`);
    return tool.handler(args, {});
  };
}
