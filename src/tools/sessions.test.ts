import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createTestDb, closeTestDb, getTestDb, seedProject, seedTask,
  seedDecision, seedSession, seedContext, parseToolResult, createToolCaller,
} from '../test-helpers/setup.js';

vi.mock('../db/connection.js', () => ({
  getDb: () => getTestDb(),
  closeDb: () => closeTestDb(),
}));

import { registerSessionTools } from './sessions.js';

let callTool: ReturnType<typeof createToolCaller>;

beforeEach(() => {
  createTestDb();
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerSessionTools(server);
  callTool = createToolCaller(server);
});

afterEach(() => {
  closeTestDb();
});

describe('start_session', () => {
  it('returns full project overview with context', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', priority: 'high' });
    seedDecision(db, 'p1', { id: 'd1', title: 'Dec' });
    seedContext(db, 'p1', 'auth', 'JWT');

    const result = await callTool('start_session', { project: 'P' });
    const parsed = parseToolResult(result);
    expect(parsed.project.name).toBe('P');
    expect(parsed.active_tasks).toHaveLength(1);
    expect(parsed.recent_decisions).toHaveLength(1);
    expect(parsed.context).toHaveLength(1);
    expect(parsed.context[0].key).toBe('auth');
  });

  it('includes last session summary and next_steps', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedSession(db, 'p1', { id: 's1', summary: 'Did X', next_steps: 'Do Y' });

    const result = await callTool('start_session', { project: 'P' });
    const parsed = parseToolResult(result);
    expect(parsed.last_session.summary).toBe('Did X');
    expect(parsed.last_session.next_steps).toBe('Do Y');
  });

  it('returns null for last_session when none exist', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    const result = await callTool('start_session', { project: 'P' });
    const parsed = parseToolResult(result);
    expect(parsed.last_session).toBeNull();
  });

  it('includes task counts by status', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', status: 'todo' });
    seedTask(db, 'p1', { id: 't2', status: 'todo' });
    seedTask(db, 'p1', { id: 't3', status: 'in_progress' });

    const result = await callTool('start_session', { project: 'P' });
    const parsed = parseToolResult(result);
    const todo = parsed.task_summary.find((s: any) => s.status === 'todo');
    expect(todo.count).toBe(2);
  });

  it('returns error when project not found', async () => {
    const result = await callTool('start_session', { project: 'nope' });
    expect(result.isError).toBe(true);
  });
});

describe('end_session', () => {
  it('creates session record with all fields', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    const result = await callTool('end_session', {
      project: 'P',
      summary: 'Built auth system',
      tasks_worked_on: ['t1', 't2'],
      decisions_made: ['d1'],
      next_steps: 'Write tests',
    });
    const parsed = parseToolResult(result);
    expect(parsed.session_id).toMatch(/^[0-9a-f]{8}$/);

    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(parsed.session_id) as any;
    expect(row.summary).toBe('Built auth system');
    expect(row.next_steps).toBe('Write tests');
  });

  it('stores tasks_worked_on and decisions_made as JSON', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    const result = await callTool('end_session', {
      project: 'P',
      summary: 'S',
      tasks_worked_on: ['t1', 't2'],
      decisions_made: ['d1'],
    });
    const parsed = parseToolResult(result);
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(parsed.session_id) as any;
    expect(JSON.parse(row.tasks_worked_on)).toEqual(['t1', 't2']);
    expect(JSON.parse(row.decisions_made)).toEqual(['d1']);
  });

  it('handles optional fields (next_steps omitted)', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    const result = await callTool('end_session', { project: 'P', summary: 'Done' });
    const parsed = parseToolResult(result);
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(parsed.session_id) as any;
    expect(row.next_steps).toBeNull();
    expect(row.tasks_worked_on).toBeNull();
  });

  it('returns error when project not found', async () => {
    const result = await callTool('end_session', { project: 'nope', summary: 'S' });
    expect(result.isError).toBe(true);
  });
});
