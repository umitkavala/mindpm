import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createTestDb, closeTestDb, getTestDb, seedProject, seedTask,
  seedDecision, seedSession, parseToolResult, createToolCaller,
} from '../test-helpers/setup.js';

vi.mock('../db/connection.js', () => ({
  getDb: () => getTestDb(),
  closeDb: () => closeTestDb(),
}));

import { registerProjectTools } from './projects.js';

let callTool: ReturnType<typeof createToolCaller>;

beforeEach(() => {
  createTestDb();
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerProjectTools(server);
  callTool = createToolCaller(server);
});

afterEach(() => {
  closeTestDb();
});

describe('create_project', () => {
  it('creates a project and returns id and message', async () => {
    const result = await callTool('create_project', { name: 'My Project', description: 'A test' });
    const parsed = parseToolResult(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.project_id).toMatch(/^[0-9a-f]{8}$/);
    expect(parsed.message).toContain('My Project');

    const db = getTestDb();
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(parsed.project_id) as any;
    expect(row.name).toBe('My Project');
    expect(row.status).toBe('active');
  });

  it('stores tech_stack as JSON array', async () => {
    const result = await callTool('create_project', {
      name: 'TechProj',
      tech_stack: ['React', 'Node', 'SQLite'],
    });
    const parsed = parseToolResult(result);
    const db = getTestDb();
    const row = db.prepare('SELECT tech_stack FROM projects WHERE id = ?').get(parsed.project_id) as any;
    expect(JSON.parse(row.tech_stack)).toEqual(['React', 'Node', 'SQLite']);
  });

  it('returns error for duplicate project name', async () => {
    await callTool('create_project', { name: 'Dupe' });
    const result = await callTool('create_project', { name: 'Dupe' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already exists');
  });

  it('handles optional fields being omitted', async () => {
    const result = await callTool('create_project', { name: 'Minimal' });
    const parsed = parseToolResult(result);
    const db = getTestDb();
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(parsed.project_id) as any;
    expect(row.description).toBeNull();
    expect(row.tech_stack).toBeNull();
    expect(row.repo_path).toBeNull();
  });
});

describe('list_projects', () => {
  it('returns empty array when no projects exist', async () => {
    const result = await callTool('list_projects', {});
    const parsed = parseToolResult(result);
    expect(parsed).toEqual([]);
  });

  it('returns all projects when no status filter', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'A' });
    seedProject(db, { id: 'p2', name: 'B', status: 'paused' });

    const result = await callTool('list_projects', {});
    const parsed = parseToolResult(result);
    expect(parsed).toHaveLength(2);
  });

  it('filters by status', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'Active', status: 'active' });
    seedProject(db, { id: 'p2', name: 'Paused', status: 'paused' });

    const result = await callTool('list_projects', { status: 'paused' });
    const parsed = parseToolResult(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('Paused');
  });

  it('orders by updated_at DESC', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'First' });
    seedProject(db, { id: 'p2', name: 'Second' });
    db.prepare("UPDATE projects SET description = 'touched' WHERE id = 'p1'").run();

    const result = await callTool('list_projects', {});
    const parsed = parseToolResult(result);
    expect(parsed[0].name).toBe('First');
  });
});

describe('get_project_status', () => {
  it('returns full project overview', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'MyProj' });
    seedTask(db, 'p1', { id: 't1', title: 'Task 1', priority: 'high' });
    seedDecision(db, 'p1', { id: 'd1', title: 'Dec 1' });
    seedSession(db, 'p1', { id: 's1', summary: 'Did stuff', next_steps: 'Do more' });

    const result = await callTool('get_project_status', { project: 'MyProj' });
    const parsed = parseToolResult(result);
    expect(parsed.project.name).toBe('MyProj');
    expect(parsed.active_tasks).toHaveLength(1);
    expect(parsed.recent_decisions).toHaveLength(1);
    expect(parsed.last_session.summary).toBe('Did stuff');
  });

  it('returns error for nonexistent project', async () => {
    const result = await callTool('get_project_status', { project: 'nope' });
    expect(result.isError).toBe(true);
  });

  it('resolves project by name', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'ByName' });

    const result = await callTool('get_project_status', { project: 'ByName' });
    const parsed = parseToolResult(result);
    expect(parsed.project.id).toBe('p1');
  });

  it('includes task counts grouped by status', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', status: 'todo' });
    seedTask(db, 'p1', { id: 't2', status: 'todo' });
    seedTask(db, 'p1', { id: 't3', status: 'done' });

    const result = await callTool('get_project_status', { project: 'P' });
    const parsed = parseToolResult(result);
    const todoCount = parsed.task_summary.find((s: any) => s.status === 'todo');
    const doneCount = parsed.task_summary.find((s: any) => s.status === 'done');
    expect(todoCount.count).toBe(2);
    expect(doneCount.count).toBe(1);
  });
});
