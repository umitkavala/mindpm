import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createTestDb, closeTestDb, getTestDb, seedProject, seedTask,
  parseToolResult, createToolCaller,
} from '../test-helpers/setup.js';

vi.mock('../db/connection.js', () => ({
  getDb: () => getTestDb(),
  closeDb: () => closeTestDb(),
}));

import { registerDeliveryMetricsTools } from './delivery-metrics.js';

let callTool: ReturnType<typeof createToolCaller>;

beforeEach(() => {
  createTestDb();
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerDeliveryMetricsTools(server);
  callTool = createToolCaller(server);
});

afterEach(() => {
  closeTestDb();
});

function seedCompletedTask(projectId: string, leadDays: number, daysAgo: number, id: string) {
  const db = getTestDb();
  const completedAt = `datetime('now', '-${daysAgo} days')`;
  const createdAt = `datetime('now', '-${daysAgo + leadDays} days')`;
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, status, priority, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, 'done', 'medium', ${createdAt}, ${completedAt}, ${completedAt})`,
  ).run(id, projectId, `Task ${id}`);
}

function seedHistoryEvent(
  taskId: string,
  oldValue: string,
  newValue: string,
  daysAgo: number,
  id: string,
) {
  const db = getTestDb();
  db.prepare(
    `INSERT INTO task_history (id, task_id, event, old_value, new_value, created_at)
     VALUES (?, ?, 'status_changed', ?, ?, datetime('now', '-${daysAgo} days'))`,
  ).run(id, taskId, oldValue, newValue);
}

describe('get_delivery_metrics', () => {
  it('returns error when project not found', async () => {
    const result = await callTool('get_delivery_metrics', { project: 'nonexistent' });
    expect(result.isError).toBe(true);
  });

  it('handles no completed tasks gracefully', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1' });

    const result = await callTool('get_delivery_metrics', { project: 'P' });
    const parsed = parseToolResult(result);
    expect(parsed.throughput.tasks_completed).toBe(0);
    expect(parsed.lead_time.note).toContain('No completed tasks');
    expect(parsed.dora_tier).toBe('unknown');
  });

  it('computes throughput and lead time from completed tasks', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    // 3 tasks completed in last 30 days, each with 5 day lead time
    seedCompletedTask('p1', 5, 5, 't1');
    seedCompletedTask('p1', 5, 10, 't2');
    seedCompletedTask('p1', 5, 20, 't3');

    const result = await callTool('get_delivery_metrics', { project: 'P', days: 30 });
    const parsed = parseToolResult(result);
    expect(parsed.throughput.tasks_completed).toBe(3);
    expect(parsed.lead_time.median_days).toBeCloseTo(5, 0);
    expect(parsed.lead_time.p90_days).toBeCloseTo(5, 0);
  });

  it('classifies dora_tier correctly', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedCompletedTask('p1', 2, 5, 't1'); // 2 day lead time => High
    seedCompletedTask('p1', 3, 10, 't2');

    const result = await callTool('get_delivery_metrics', { project: 'P', days: 30 });
    const parsed = parseToolResult(result);
    expect(parsed.dora_tier).toBe('High');
  });

  it('reports currently blocked tasks', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1', status: 'blocked' });
    seedTask(db, 'p1', { id: 't2', status: 'blocked' });

    const result = await callTool('get_delivery_metrics', { project: 'P', days: 30 });
    const parsed = parseToolResult(result);
    expect(parsed.flow_efficiency.currently_blocked).toBe(2);
    expect(parsed.insights.some((s: string) => s.includes('blocked'))).toBe(true);
  });

  it('computes blocked_rate_pct from task_history events', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1' });
    seedTask(db, 'p1', { id: 't2' });
    // t1 got blocked then unblocked
    seedHistoryEvent('t1', 'in_progress', 'blocked', 10, 'h1');
    seedHistoryEvent('t1', 'blocked', 'in_progress', 8, 'h2');
    // t2 had a status change but no block
    seedHistoryEvent('t2', 'todo', 'in_progress', 5, 'h3');

    const result = await callTool('get_delivery_metrics', { project: 'P', days: 30 });
    const parsed = parseToolResult(result);
    // 1 of 2 touched tasks hit blocked => 50%
    expect(parsed.flow_efficiency.blocked_rate_pct).toBe(50);
  });

  it('computes avg_blocked_days from paired history events', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedTask(db, 'p1', { id: 't1' });
    // blocked for ~2 days
    seedHistoryEvent('t1', 'in_progress', 'blocked', 10, 'h1');
    seedHistoryEvent('t1', 'blocked', 'in_progress', 8, 'h2');

    const result = await callTool('get_delivery_metrics', { project: 'P', days: 30 });
    const parsed = parseToolResult(result);
    expect(parsed.flow_efficiency.avg_blocked_days).toBeCloseTo(2, 0);
  });

  it('excludes tasks completed outside the time window', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedCompletedTask('p1', 5, 5, 't1');   // in window
    seedCompletedTask('p1', 5, 45, 't2');  // outside 30-day window

    const result = await callTool('get_delivery_metrics', { project: 'P', days: 30 });
    const parsed = parseToolResult(result);
    expect(parsed.throughput.tasks_completed).toBe(1);
  });

  it('respects custom days parameter', async () => {
    const db = getTestDb();
    seedProject(db, { id: 'p1', name: 'P' });
    seedCompletedTask('p1', 5, 5, 't1');   // in 7-day window
    seedCompletedTask('p1', 5, 45, 't2');  // outside 7-day window

    const result = await callTool('get_delivery_metrics', { project: 'P', days: 7 });
    const parsed = parseToolResult(result);
    expect(parsed.throughput.tasks_completed).toBe(1);
    expect(parsed.period).toBe('last 7 days');
  });
});
