import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createTestDb, closeTestDb, getTestDb, seedProject, seedTask,
  seedDecision, seedNote, parseToolResult, createToolCaller,
} from '../test-helpers/setup.js';

vi.mock('../db/connection.js', () => ({
  getDb: () => getTestDb(),
  closeDb: () => closeTestDb(),
}));

import { registerQueryTools } from './queries.js';

let callTool: ReturnType<typeof createToolCaller>;

beforeEach(() => {
  createTestDb();
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerQueryTools(server);
  callTool = createToolCaller(server);
});

afterEach(() => {
  closeTestDb();
});

describe('query', () => {
  it('executes valid SELECT query', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    const result = await callTool('query', { sql: 'SELECT * FROM projects' });
    const parsed = parseToolResult(result);
    expect(parsed.count).toBe(1);
    expect(parsed.rows[0].name).toBe('P');
  });

  it('rejects non-SELECT query (INSERT)', async () => {
    const result = await callTool('query', { sql: "INSERT INTO projects (id, name) VALUES ('x', 'X')" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Only SELECT');
  });

  it('rejects non-SELECT query (DROP)', async () => {
    const result = await callTool('query', { sql: 'DROP TABLE projects' });
    expect(result.isError).toBe(true);
  });

  it('handles SQL syntax errors gracefully', async () => {
    const result = await callTool('query', { sql: 'SELECT * FORM projects' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Query error');
  });

  it('works with queries that return zero rows', async () => {
    const result = await callTool('query', { sql: "SELECT * FROM projects WHERE name = 'nonexistent'" });
    const parsed = parseToolResult(result);
    expect(parsed.count).toBe(0);
    expect(parsed.rows).toEqual([]);
  });

  it('handles case-insensitive SELECT check', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    const result = await callTool('query', { sql: 'select * from projects' });
    const parsed = parseToolResult(result);
    expect(parsed.count).toBe(1);
  });
});

describe('get_project_summary', () => {
  it('returns full summary with all sections', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', status: 'todo', priority: 'high' });
    seedTask(db, 'p1', { id: 't2', status: 'blocked', blocked_by: '["t1"]' });
    seedDecision(db, 'p1', { id: 'd1' });
    seedNote(db, 'p1', { id: 'n1' });

    const result = await callTool('get_project_summary', { project: 'P' });
    const parsed = parseToolResult(result);
    expect(parsed.project).toBe('P');
    expect(parsed.tasks_by_status.length).toBeGreaterThan(0);
    expect(parsed.blockers).toHaveLength(1);
    expect(parsed.upcoming_priorities).toHaveLength(1);
    expect(parsed.totals.notes).toBe(1);
    expect(parsed.totals.decisions).toBe(1);
  });

  it('returns error when project not found', async () => {
    const result = await callTool('get_project_summary', { project: 'nope' });
    expect(result.isError).toBe(true);
  });

  it('handles project with no data', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'Empty' });

    const result = await callTool('get_project_summary', { project: 'Empty' });
    const parsed = parseToolResult(result);
    expect(parsed.tasks_by_status).toEqual([]);
    expect(parsed.blockers).toEqual([]);
    expect(parsed.upcoming_priorities).toEqual([]);
    expect(parsed.totals.notes).toBe(0);
  });
});

describe('get_blockers', () => {
  it('returns blocked tasks with enriched blocking task info', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', title: 'Blocker', status: 'in_progress' });
    seedTask(db, 'p1', { id: 't2', title: 'Blocked', status: 'blocked', blocked_by: '["t1"]' });

    const result = await callTool('get_blockers', { project: 'P' });
    const parsed = parseToolResult(result);
    expect(parsed.blockers).toHaveLength(1);
    expect(parsed.blockers[0].title).toBe('Blocked');
    expect(parsed.blockers[0].blocking_tasks).toHaveLength(1);
    expect(parsed.blockers[0].blocking_tasks[0].title).toBe('Blocker');
  });

  it('handles blocked_by referencing unknown task IDs', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', status: 'blocked', blocked_by: '["unknown123"]' });

    const result = await callTool('get_blockers', { project: 'P' });
    const parsed = parseToolResult(result);
    expect(parsed.blockers[0].blocking_tasks[0].title).toBe('Unknown task');
    expect(parsed.blockers[0].blocking_tasks[0].status).toBe('unknown');
  });

  it('returns empty blockers when none exist', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', status: 'todo' });

    const result = await callTool('get_blockers', { project: 'P' });
    const parsed = parseToolResult(result);
    expect(parsed.blockers).toEqual([]);
  });

  it('returns error when project not found', async () => {
    const result = await callTool('get_blockers', { project: 'nope' });
    expect(result.isError).toBe(true);
  });
});

describe('search', () => {
  it('searches across tasks, notes, and decisions', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', title: 'Auth task' });
    seedNote(db, 'p1', { id: 'n1', content: 'Auth notes here' });
    seedDecision(db, 'p1', { id: 'd1', title: 'Auth decision', decision: 'Use JWT' });

    const result = await callTool('search', { project: 'P', query: 'Auth' });
    const parsed = parseToolResult(result);
    expect(parsed.results.tasks).toHaveLength(1);
    expect(parsed.results.notes).toHaveLength(1);
    expect(parsed.results.decisions).toHaveLength(1);
    expect(parsed.total).toBe(3);
  });

  it('returns total count', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', title: 'Match' });
    seedTask(db, 'p1', { id: 't2', title: 'Match too' });

    const result = await callTool('search', { project: 'P', query: 'Match' });
    const parsed = parseToolResult(result);
    expect(parsed.total).toBe(2);
  });

  it('returns empty results for no match', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    const result = await callTool('search', { project: 'P', query: 'nothing' });
    const parsed = parseToolResult(result);
    expect(parsed.total).toBe(0);
    expect(parsed.results.tasks).toEqual([]);
    expect(parsed.results.notes).toEqual([]);
    expect(parsed.results.decisions).toEqual([]);
  });

  it('returns error when project not found', async () => {
    const result = await callTool('search', { project: 'nope', query: 'x' });
    expect(result.isError).toBe(true);
  });
});
