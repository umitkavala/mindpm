import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createTestDb, closeTestDb, getTestDb, seedProject, seedTask,
  seedDecision, seedSession, seedNote, seedContext, parseToolResult, createToolCaller,
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

  it('returns null for last_session when no sessions and no activity', async () => {
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

describe('start_session - auto-close stale sessions', () => {
  it('creates synthetic session when activity exists but no session', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', title: 'Task 1' });
    seedDecision(db, 'p1', { id: 'd1', title: 'Decision 1' });

    const result = await callTool('start_session', { project: 'P' });
    const parsed = parseToolResult(result);

    expect(parsed.last_session).not.toBeNull();
    expect(parsed.last_session.summary).toContain('Auto-generated');

    const sessions = db.prepare('SELECT * FROM sessions WHERE project_id = ?').all('p1') as any[];
    expect(sessions).toHaveLength(1);
    expect(JSON.parse(sessions[0].tasks_worked_on)).toContain('t1');
    expect(JSON.parse(sessions[0].decisions_made)).toContain('d1');
  });

  it('creates synthetic session when activity exists after last session', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    // Create session in the past
    db.prepare(
      `INSERT INTO sessions (id, project_id, summary, created_at) VALUES (?, ?, ?, datetime('now', '-1 day'))`,
    ).run('old-sess', 'p1', 'Old session');

    // Create task after the session (uses default CURRENT_TIMESTAMP which is "now")
    seedTask(db, 'p1', { id: 't1', title: 'New task' });

    const result = await callTool('start_session', { project: 'P' });
    const parsed = parseToolResult(result);

    const sessions = db.prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC').all('p1') as any[];
    expect(sessions).toHaveLength(2);
    expect(sessions[0].summary).toContain('Auto-generated');
    expect(JSON.parse(sessions[0].tasks_worked_on)).toContain('t1');
  });

  it('does not create synthetic session when no activity since last session', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    // Create task in the past
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-2 days'), datetime('now', '-2 days'))`,
    ).run('t1', 'p1', 'Old task', 'todo', 'medium');

    // Create session after the task
    db.prepare(
      `INSERT INTO sessions (id, project_id, summary, created_at) VALUES (?, ?, ?, datetime('now', '-1 day'))`,
    ).run('s1', 'p1', 'Recent session');

    await callTool('start_session', { project: 'P' });

    const sessions = db.prepare('SELECT * FROM sessions WHERE project_id = ?').all('p1') as any[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('s1');
  });

  it('includes decision IDs in synthetic session', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedDecision(db, 'p1', { id: 'd1', title: 'Dec 1' });
    seedDecision(db, 'p1', { id: 'd2', title: 'Dec 2' });

    await callTool('start_session', { project: 'P' });

    const sessions = db.prepare('SELECT * FROM sessions WHERE project_id = ?').all('p1') as any[];
    const decisionIds = JSON.parse(sessions[0].decisions_made);
    expect(decisionIds).toContain('d1');
    expect(decisionIds).toContain('d2');
  });

  it('deduplicates task IDs when task is created and updated', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', title: 'Task' });
    // Simulate an update (updated_at differs from created_at)
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run('t1');

    await callTool('start_session', { project: 'P' });

    const sessions = db.prepare('SELECT * FROM sessions WHERE project_id = ?').all('p1') as any[];
    const taskIds = JSON.parse(sessions[0].tasks_worked_on);
    expect(taskIds).toEqual(['t1']);
  });
});

describe('start_session - recent activity', () => {
  it('includes recent_activity in response', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', title: 'Task 1' });
    seedDecision(db, 'p1', { id: 'd1', title: 'Decision 1' });
    seedNote(db, 'p1', { id: 'n1', content: 'A note' });

    const result = await callTool('start_session', { project: 'P' });
    const parsed = parseToolResult(result);

    expect(parsed.recent_activity).toBeDefined();
    expect(parsed.recent_activity.length).toBeGreaterThan(0);

    const types = parsed.recent_activity.map((a: any) => a.type);
    expect(types).toContain('task_created');
    expect(types).toContain('decision');
    expect(types).toContain('note');
  });

  it('limits recent_activity to 20 items', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    for (let i = 0; i < 25; i++) {
      seedTask(db, 'p1', { id: `t${i}`, title: `Task ${i}` });
    }

    const result = await callTool('start_session', { project: 'P' });
    const parsed = parseToolResult(result);

    expect(parsed.recent_activity.length).toBeLessThanOrEqual(20);
  });

  it('only includes activity since last session', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    // Create old task
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-3 days'), datetime('now', '-3 days'))`,
    ).run('t-old', 'p1', 'Old task', 'todo', 'medium');

    // Create session after old task
    db.prepare(
      `INSERT INTO sessions (id, project_id, summary, created_at) VALUES (?, ?, ?, datetime('now', '-2 days'))`,
    ).run('sess1', 'p1', 'Session');

    // Create new task after session
    seedTask(db, 'p1', { id: 't-new', title: 'New task' });

    const result = await callTool('start_session', { project: 'P' });
    const parsed = parseToolResult(result);

    const ids = parsed.recent_activity.map((a: any) => a.id);
    expect(ids).toContain('t-new');
    expect(ids).not.toContain('t-old');
  });

  it('returns empty recent_activity when no new activity', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    // Create task in the past
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-2 days'), datetime('now', '-2 days'))`,
    ).run('t1', 'p1', 'Old task', 'todo', 'medium');

    // Session after the task
    db.prepare(
      `INSERT INTO sessions (id, project_id, summary, created_at) VALUES (?, ?, ?, datetime('now', '-1 day'))`,
    ).run('s1', 'p1', 'Session');

    const result = await callTool('start_session', { project: 'P' });
    const parsed = parseToolResult(result);

    expect(parsed.recent_activity).toEqual([]);
  });

  it('includes task_updated type when a task is modified', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    // Create task with an older created_at so the trigger-set updated_at will differ
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now', '-1 hour'), datetime('now', '-1 hour'))`,
    ).run('t1', 'p1', 'Task', 'todo', 'medium');
    // Update triggers updated_at to CURRENT_TIMESTAMP (now), which differs from created_at (-1 hour)
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run('t1');

    const result = await callTool('start_session', { project: 'P' });
    const parsed = parseToolResult(result);

    const types = parsed.recent_activity.map((a: any) => a.type);
    expect(types).toContain('task_created');
    expect(types).toContain('task_updated');
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
