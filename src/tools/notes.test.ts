import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createTestDb, closeTestDb, getTestDb, seedProject, seedTask, seedNote,
  seedContext, parseToolResult, createToolCaller,
} from '../test-helpers/setup.js';

vi.mock('../db/connection.js', () => ({
  getDb: () => getTestDb(),
  closeDb: () => closeTestDb(),
}));

import { registerNoteTools } from './notes.js';

let callTool: ReturnType<typeof createToolCaller>;

beforeEach(() => {
  createTestDb();
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerNoteTools(server);
  callTool = createToolCaller(server);
});

afterEach(() => {
  closeTestDb();
});

describe('add_note', () => {
  it('adds a note to a project', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    const result = await callTool('add_note', { project: 'P', content: 'Important info' });
    const parsed = parseToolResult(result);
    expect(parsed.note_id).toMatch(/^[0-9a-f]{8}$/);

    const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(parsed.note_id) as any;
    expect(row.content).toBe('Important info');
    expect(row.project_id).toBe('p1');
  });

  it('links note to a task', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1' });

    const result = await callTool('add_note', { project: 'P', content: 'Note on task', task_id: 't1' });
    const parsed = parseToolResult(result);
    const row = db.prepare('SELECT task_id FROM notes WHERE id = ?').get(parsed.note_id) as any;
    expect(row.task_id).toBe('t1');
  });

  it('defaults category to general', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    const result = await callTool('add_note', { project: 'P', content: 'X' });
    const parsed = parseToolResult(result);
    const row = db.prepare('SELECT category FROM notes WHERE id = ?').get(parsed.note_id) as any;
    expect(row.category).toBe('general');
  });

  it('stores tags as JSON array', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    const result = await callTool('add_note', { project: 'P', content: 'X', tags: ['a', 'b'] });
    const parsed = parseToolResult(result);
    const row = db.prepare('SELECT tags FROM notes WHERE id = ?').get(parsed.note_id) as any;
    expect(JSON.parse(row.tags)).toEqual(['a', 'b']);
  });

  it('returns error when project not found', async () => {
    const result = await callTool('add_note', { project: 'nope', content: 'X' });
    expect(result.isError).toBe(true);
  });
});

describe('search_notes', () => {
  it('finds notes matching query text', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedNote(db, 'p1', { id: 'n1', content: 'Redis caching strategy' });
    seedNote(db, 'p1', { id: 'n2', content: 'Auth flow diagram' });

    const result = await callTool('search_notes', { project: 'P', query: 'Redis' });
    const parsed = parseToolResult(result);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].content).toContain('Redis');
  });

  it('returns empty results for no match', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedNote(db, 'p1', { id: 'n1', content: 'Something' });

    const result = await callTool('search_notes', { project: 'P', query: 'nonexistent' });
    const parsed = parseToolResult(result);
    expect(parsed.results).toEqual([]);
  });

  it('filters by category', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedNote(db, 'p1', { id: 'n1', content: 'arch note', category: 'architecture' });
    seedNote(db, 'p1', { id: 'n2', content: 'arch bug', category: 'bug' });

    const result = await callTool('search_notes', { project: 'P', query: 'arch', category: 'architecture' });
    const parsed = parseToolResult(result);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].category).toBe('architecture');
  });

  it('returns error when project not found', async () => {
    const result = await callTool('search_notes', { project: 'nope', query: 'x' });
    expect(result.isError).toBe(true);
  });
});

describe('set_context', () => {
  it('sets a new context key-value', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    const result = await callTool('set_context', { project: 'P', key: 'auth', value: 'JWT' });
    const parsed = parseToolResult(result);
    expect(parsed.message).toContain('auth');
    expect(parsed.message).toContain('JWT');

    const row = db.prepare("SELECT * FROM context WHERE project_id = 'p1' AND key = 'auth'").get() as any;
    expect(row.value).toBe('JWT');
  });

  it('upserts existing key (updates value)', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedContext(db, 'p1', 'auth', 'old_value');

    await callTool('set_context', { project: 'P', key: 'auth', value: 'new_value' });
    const rows = db.prepare("SELECT * FROM context WHERE project_id = 'p1' AND key = 'auth'").all();
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).value).toBe('new_value');
  });

  it('upserts existing key (updates category)', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedContext(db, 'p1', 'auth', 'JWT', { category: 'general' });

    await callTool('set_context', { project: 'P', key: 'auth', value: 'JWT', category: 'architecture' });
    const row = db.prepare("SELECT category FROM context WHERE project_id = 'p1' AND key = 'auth'").get() as any;
    expect(row.category).toBe('architecture');
  });

  it('returns error when project not found', async () => {
    const result = await callTool('set_context', { project: 'nope', key: 'k', value: 'v' });
    expect(result.isError).toBe(true);
  });
});

describe('get_context', () => {
  it('returns specific context by key', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedContext(db, 'p1', 'auth', 'JWT');
    seedContext(db, 'p1', 'db', 'SQLite', { id: 'ctx2' });

    const result = await callTool('get_context', { project: 'P', key: 'auth' });
    const parsed = parseToolResult(result);
    expect(parsed.context).toHaveLength(1);
    expect(parsed.context[0].value).toBe('JWT');
  });

  it('returns all context when key omitted', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedContext(db, 'p1', 'auth', 'JWT');
    seedContext(db, 'p1', 'db', 'SQLite', { id: 'ctx2' });

    const result = await callTool('get_context', { project: 'P' });
    const parsed = parseToolResult(result);
    expect(parsed.context).toHaveLength(2);
  });

  it('returns empty array for nonexistent key', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    const result = await callTool('get_context', { project: 'P', key: 'nope' });
    const parsed = parseToolResult(result);
    expect(parsed.context).toEqual([]);
  });

  it('returns error when project not found', async () => {
    const result = await callTool('get_context', { project: 'nope' });
    expect(result.isError).toBe(true);
  });
});
