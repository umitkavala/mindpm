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
    seedTask(db, 'p1', { id: 't1', status: 'ready', priority: 'high' });
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
    seedTask(db, 'p1', { id: 't1', title: 'Blocker', status: 'claimed' });
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
    seedTask(db, 'p1', { id: 't1', status: 'ready' });

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

  it('searches spec objectives and attempt root causes', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    db.prepare("UPDATE projects SET slug = 'p' WHERE id = 'p1'").run();
    seedTask(db, 'p1', { id: 't1', title: 'Timeout' });
    db.prepare("UPDATE tasks SET seq = 1 WHERE id = 't1'").run();
    db.prepare(
      `INSERT INTO specs (id, project_id, seq, title, objective, why, created_by)
       VALUES ('s1', 'p1', 4, 'Timeout', 'Close idle conversations', 'Idle ones hold capacity', 'human:umit')`,
    ).run();
    db.prepare(
      `INSERT INTO attempts (id, task_id, attempt_no, actor, claim_token, outcome, root_cause)
       VALUES ('a1', 't1', 1, 'agent:cli-1', 'tok', 'failed', 'Deadlock between sweep and handler')`,
    ).run();

    const specs = parseToolResult(await callTool('search', { project: 'P', query: 'idle' }));
    expect(specs.results.specs).toEqual([expect.objectContaining({ key: 'SPEC-4', type: 'spec' })]);
    const attempts = parseToolResult(await callTool('search', { project: 'P', query: 'deadlock' }));
    expect(attempts.results.attempts).toEqual([expect.objectContaining({ task_key: 'p-1', attempt_no: 1, type: 'attempt' })]);
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

  it('uses the FTS engine and matches by prefix', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', title: 'Authentication rewrite' });

    const result = await callTool('search', { project: 'P', query: 'auth' });
    const parsed = parseToolResult(result);
    expect(parsed.engine).toBe('fts');
    expect(parsed.results.tasks).toHaveLength(1);
    expect(parsed.counts.tasks).toBe(1);
  });

  it('reflects updates via FTS sync triggers', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', title: 'Original title' });

    expect(parseToolResult(await callTool('search', { project: 'P', query: 'renamed' })).total).toBe(0);
    db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Renamed widget', 't1');
    expect(parseToolResult(await callTool('search', { project: 'P', query: 'renamed' })).results.tasks).toHaveLength(1);
  });

  it('respects the per-category limit and reports truncation', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    for (let i = 0; i < 5; i++) {
      seedTask(db, 'p1', { id: `t${i}`, title: `Widget number ${i}` });
    }

    const result = await callTool('search', { project: 'P', query: 'widget', limit: 2 });
    const parsed = parseToolResult(result);
    expect(parsed.results.tasks).toHaveLength(2);
    expect(parsed.counts.tasks).toBe(5);
    expect(parsed.truncated).toBe(true);
  });
});
