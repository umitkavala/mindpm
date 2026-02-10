import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createTestDb, closeTestDb, getTestDb, seedProject, seedDecision,
  parseToolResult, createToolCaller,
} from '../test-helpers/setup.js';

vi.mock('../db/connection.js', () => ({
  getDb: () => getTestDb(),
  closeDb: () => closeTestDb(),
}));

import { registerDecisionTools } from './decisions.js';

let callTool: ReturnType<typeof createToolCaller>;

beforeEach(() => {
  createTestDb();
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerDecisionTools(server);
  callTool = createToolCaller(server);
});

afterEach(() => {
  closeTestDb();
});

describe('log_decision', () => {
  it('logs a decision with all fields', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    const result = await callTool('log_decision', {
      project: 'P',
      title: 'Auth strategy',
      decision: 'Use JWT',
      reasoning: 'Stateless',
      alternatives: ['Sessions', 'OAuth'],
      tags: ['auth', 'architecture'],
    });
    const parsed = parseToolResult(result);
    expect(parsed.decision_id).toMatch(/^[0-9a-f]{8}$/);

    const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(parsed.decision_id) as any;
    expect(row.title).toBe('Auth strategy');
    expect(row.decision).toBe('Use JWT');
    expect(JSON.parse(row.alternatives)).toEqual(['Sessions', 'OAuth']);
    expect(JSON.parse(row.tags)).toEqual(['auth', 'architecture']);
  });

  it('stores alternatives as JSON array', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });

    const result = await callTool('log_decision', {
      project: 'P', title: 'DB', decision: 'SQLite', alternatives: ['Postgres', 'Mongo'],
    });
    const parsed = parseToolResult(result);
    const row = db.prepare('SELECT alternatives FROM decisions WHERE id = ?').get(parsed.decision_id) as any;
    expect(JSON.parse(row.alternatives)).toEqual(['Postgres', 'Mongo']);
  });

  it('defaults to most recent project', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'Active' });

    const result = await callTool('log_decision', { title: 'X', decision: 'Y' });
    const parsed = parseToolResult(result);
    expect(parsed.message).toContain('Active');
  });

  it('returns error when project not found', async () => {
    const result = await callTool('log_decision', { project: 'nope', title: 'X', decision: 'Y' });
    expect(result.isError).toBe(true);
  });
});

describe('list_decisions', () => {
  it('lists decisions for a project', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedDecision(db, 'p1', { id: 'd1', title: 'Dec 1' });
    seedDecision(db, 'p1', { id: 'd2', title: 'Dec 2' });

    const result = await callTool('list_decisions', { project: 'P' });
    const parsed = parseToolResult(result);
    expect(parsed.decisions).toHaveLength(2);
  });

  it('filters by tag', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedDecision(db, 'p1', { id: 'd1', tags: '["auth"]' });
    seedDecision(db, 'p1', { id: 'd2', tags: '["db"]' });

    const result = await callTool('list_decisions', { project: 'P', tag: 'auth' });
    const parsed = parseToolResult(result);
    expect(parsed.decisions).toHaveLength(1);
  });

  it('respects limit parameter', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    for (let i = 0; i < 5; i++) {
      seedDecision(db, 'p1', { id: `d${i}`, title: `Dec ${i}` });
    }

    const result = await callTool('list_decisions', { project: 'P', limit: 2 });
    const parsed = parseToolResult(result);
    expect(parsed.decisions).toHaveLength(2);
  });

  it('defaults limit to 20', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    for (let i = 0; i < 25; i++) {
      seedDecision(db, 'p1', { id: `d${String(i).padStart(2, '0')}`, title: `Dec ${i}` });
    }

    const result = await callTool('list_decisions', { project: 'P' });
    const parsed = parseToolResult(result);
    expect(parsed.decisions).toHaveLength(20);
  });
});
