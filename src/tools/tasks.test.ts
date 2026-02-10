import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createTestDb, closeTestDb, getTestDb, seedProject, seedTask,
  seedNote, parseToolResult, createToolCaller,
} from '../test-helpers/setup.js';

vi.mock('../db/connection.js', () => ({
  getDb: () => getTestDb(),
  closeDb: () => closeTestDb(),
}));

import { registerTaskTools } from './tasks.js';

let callTool: ReturnType<typeof createToolCaller>;

beforeEach(() => {
  createTestDb();
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerTaskTools(server);
  callTool = createToolCaller(server);
});

afterEach(() => {
  closeTestDb();
});

describe('create_task', () => {
  it('creates task in specified project', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'Proj' });

    const result = await callTool('create_task', { project: 'Proj', title: 'Do stuff' });
    const parsed = parseToolResult(result);
    expect(parsed.task_id).toMatch(/^[0-9a-f]{8}$/);
    expect(parsed.message).toContain('Do stuff');
    expect(parsed.message).toContain('Proj');
  });

  it('defaults to most recent project when project omitted', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'Active' });

    const result = await callTool('create_task', { title: 'No project arg' });
    const parsed = parseToolResult(result);
    expect(parsed.message).toContain('Active');
  });

  it('stores tags as JSON array', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    const result = await callTool('create_task', { project: 'P', title: 'T', tags: ['backend', 'auth'] });
    const parsed = parseToolResult(result);
    const row = db.prepare('SELECT tags FROM tasks WHERE id = ?').get(parsed.task_id) as any;
    expect(JSON.parse(row.tags)).toEqual(['backend', 'auth']);
  });

  it('defaults priority to medium', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    const result = await callTool('create_task', { project: 'P', title: 'T' });
    const parsed = parseToolResult(result);
    const row = db.prepare('SELECT priority FROM tasks WHERE id = ?').get(parsed.task_id) as any;
    expect(row.priority).toBe('medium');
  });

  it('returns error when project not found', async () => {
    const result = await callTool('create_task', { project: 'nope', title: 'T' });
    expect(result.isError).toBe(true);
  });

  it('returns error when no active projects and no project specified', async () => {
    const result = await callTool('create_task', { title: 'T' });
    expect(result.isError).toBe(true);
  });

  it('creates subtask with parent_task_id', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 'parent1', title: 'Parent' });

    const result = await callTool('create_task', { project: 'P', title: 'Sub', parent_task_id: 'parent1' });
    const parsed = parseToolResult(result);
    const row = db.prepare('SELECT parent_task_id FROM tasks WHERE id = ?').get(parsed.task_id) as any;
    expect(row.parent_task_id).toBe('parent1');
  });
});

describe('update_task', () => {
  it('updates task title', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', title: 'Old' });

    await callTool('update_task', { task_id: 't1', title: 'New Title' });
    const row = db.prepare('SELECT title FROM tasks WHERE id = ?').get('t1') as any;
    expect(row.title).toBe('New Title');
  });

  it('updates task status to done and sets completed_at', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1' });

    await callTool('update_task', { task_id: 't1', status: 'done' });
    const row = db.prepare('SELECT status, completed_at FROM tasks WHERE id = ?').get('t1') as any;
    expect(row.status).toBe('done');
    expect(row.completed_at).not.toBeNull();
  });

  it('updates multiple fields at once', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1' });

    await callTool('update_task', { task_id: 't1', title: 'Updated', priority: 'critical', status: 'in_progress' });
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get('t1') as any;
    expect(row.title).toBe('Updated');
    expect(row.priority).toBe('critical');
    expect(row.status).toBe('in_progress');
  });

  it('setting blocked_by auto-sets status to blocked', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1' });
    seedTask(db, 'p1', { id: 't2' });

    await callTool('update_task', { task_id: 't1', blocked_by: ['t2'] });
    const row = db.prepare('SELECT status, blocked_by FROM tasks WHERE id = ?').get('t1') as any;
    expect(row.status).toBe('blocked');
    expect(JSON.parse(row.blocked_by)).toEqual(['t2']);
  });

  it('setting blocked_by with explicit status uses explicit status', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1' });

    await callTool('update_task', { task_id: 't1', blocked_by: ['x'], status: 'in_progress' });
    const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get('t1') as any;
    expect(row.status).toBe('in_progress');
  });

  it('replaces tags entirely', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', tags: '["old"]' });

    await callTool('update_task', { task_id: 't1', tags: ['new', 'tags'] });
    const row = db.prepare('SELECT tags FROM tasks WHERE id = ?').get('t1') as any;
    expect(JSON.parse(row.tags)).toEqual(['new', 'tags']);
  });

  it('returns error for nonexistent task_id', async () => {
    const result = await callTool('update_task', { task_id: 'nope', title: 'X' });
    expect(result.isError).toBe(true);
  });

  it('returns error when no updates provided', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1' });

    const result = await callTool('update_task', { task_id: 't1' });
    expect(result.isError).toBe(true);
  });
});

describe('list_tasks', () => {
  it('lists non-done tasks by default', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', status: 'todo' });
    seedTask(db, 'p1', { id: 't2', status: 'done' });

    const result = await callTool('list_tasks', { project: 'P' });
    const parsed = parseToolResult(result);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].id).toBe('t1');
  });

  it('includes done tasks when include_done is true', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', status: 'todo' });
    seedTask(db, 'p1', { id: 't2', status: 'done' });

    const result = await callTool('list_tasks', { project: 'P', include_done: true });
    const parsed = parseToolResult(result);
    expect(parsed.tasks).toHaveLength(2);
  });

  it('filters by status', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', status: 'todo' });
    seedTask(db, 'p1', { id: 't2', status: 'blocked' });

    const result = await callTool('list_tasks', { project: 'P', status: 'blocked' });
    const parsed = parseToolResult(result);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].status).toBe('blocked');
  });

  it('filters by priority', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', priority: 'high' });
    seedTask(db, 'p1', { id: 't2', priority: 'low' });

    const result = await callTool('list_tasks', { project: 'P', priority: 'high' });
    const parsed = parseToolResult(result);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].priority).toBe('high');
  });

  it('filters by tag', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', tags: '["backend","auth"]' });
    seedTask(db, 'p1', { id: 't2', tags: '["frontend"]' });

    const result = await callTool('list_tasks', { project: 'P', tag: 'auth' });
    const parsed = parseToolResult(result);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].id).toBe('t1');
  });

  it('orders by priority then created_at', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', priority: 'low', title: 'Low' });
    seedTask(db, 'p1', { id: 't2', priority: 'critical', title: 'Critical' });
    seedTask(db, 'p1', { id: 't3', priority: 'high', title: 'High' });

    const result = await callTool('list_tasks', { project: 'P' });
    const parsed = parseToolResult(result);
    expect(parsed.tasks[0].priority).toBe('critical');
    expect(parsed.tasks[1].priority).toBe('high');
    expect(parsed.tasks[2].priority).toBe('low');
  });
});

describe('get_task', () => {
  it('returns task with subtasks and notes', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', title: 'Parent' });
    seedTask(db, 'p1', { id: 't2', title: 'Child', parent_task_id: 't1' });
    seedNote(db, 'p1', { id: 'n1', task_id: 't1', content: 'Note on task' });

    const result = await callTool('get_task', { task_id: 't1' });
    const parsed = parseToolResult(result);
    expect(parsed.task.title).toBe('Parent');
    expect(parsed.subtasks).toHaveLength(1);
    expect(parsed.subtasks[0].title).toBe('Child');
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0].content).toBe('Note on task');
  });

  it('returns error for nonexistent task', async () => {
    const result = await callTool('get_task', { task_id: 'nope' });
    expect(result.isError).toBe(true);
  });

  it('returns empty subtasks and notes when none exist', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1' });

    const result = await callTool('get_task', { task_id: 't1' });
    const parsed = parseToolResult(result);
    expect(parsed.subtasks).toEqual([]);
    expect(parsed.notes).toEqual([]);
  });
});

describe('get_next_tasks', () => {
  it('returns highest priority todo/in_progress tasks', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', priority: 'low', status: 'todo' });
    seedTask(db, 'p1', { id: 't2', priority: 'critical', status: 'in_progress' });

    const result = await callTool('get_next_tasks', { project: 'P' });
    const parsed = parseToolResult(result);
    expect(parsed.next_tasks[0].priority).toBe('critical');
    expect(parsed.next_tasks[1].priority).toBe('low');
  });

  it('excludes blocked, done, cancelled tasks', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', status: 'blocked' });
    seedTask(db, 'p1', { id: 't2', status: 'done' });
    seedTask(db, 'p1', { id: 't3', status: 'cancelled' });
    seedTask(db, 'p1', { id: 't4', status: 'todo' });

    const result = await callTool('get_next_tasks', { project: 'P' });
    const parsed = parseToolResult(result);
    expect(parsed.next_tasks).toHaveLength(1);
    expect(parsed.next_tasks[0].id).toBe('t4');
  });

  it('respects limit parameter', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    for (let i = 0; i < 10; i++) {
      seedTask(db, 'p1', { id: `t${i}`, title: `Task ${i}` });
    }

    const result = await callTool('get_next_tasks', { project: 'P', limit: 3 });
    const parsed = parseToolResult(result);
    expect(parsed.next_tasks).toHaveLength(3);
  });

  it('defaults limit to 5', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    for (let i = 0; i < 10; i++) {
      seedTask(db, 'p1', { id: `t${i}`, title: `Task ${i}` });
    }

    const result = await callTool('get_next_tasks', { project: 'P' });
    const parsed = parseToolResult(result);
    expect(parsed.next_tasks).toHaveLength(5);
  });
});
