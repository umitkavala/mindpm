import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTestDb, closeTestDb, getTestDb, seedProject, seedTask, parseToolResult, createToolCaller,
} from '../test-helpers/setup.js';

vi.mock('../db/connection.js', () => ({
  getDb: () => getTestDb(),
  closeDb: () => closeTestDb(),
}));

import { registerTaskTools } from './tasks.js';
import { registerSpecTools } from './specs.js';
import { registerDecisionTools } from './decisions.js';

let callTool: ReturnType<typeof createToolCaller>;
let repo: string;

beforeEach(() => {
  createTestDb();
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerTaskTools(server);
  registerSpecTools(server);
  registerDecisionTools(server);
  callTool = createToolCaller(server);
  repo = mkdtempSync(join(tmpdir(), 'mindpm-spec-'));
  const db = getTestDb();
  seedProject(db, { id: 'p1', name: 'P', repo_path: repo });
  db.prepare("UPDATE projects SET slug = 'p' WHERE id = 'p1'").run();
});

afterEach(() => {
  closeTestDb();
  rmSync(repo, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>) => parseToolResult(await callTool(name, args));

const SPEC = {
  project: 'P',
  actor: 'agent:architect',
  title: 'Conversation inactivity timeout',
  objective: 'Close conversations after 30 minutes of inactivity.',
  why: 'Idle conversations hold agent capacity.',
  approach: 'Scheduled sweep plus last-activity timestamp.',
  constraints: ['Existing API contracts stay compatible'],
  out_of_scope: ['Configurable timeout per tenant'],
  risk_level: 'medium',
  criteria: [
    { statement: 'Closes after 30 min with no activity', verify_kind: 'test', verify_ref: 'InactivityTimeoutTests.ClosesAfterThirtyMinutes' },
    { statement: 'Never closes a conversation an agent is handling', verify_kind: 'test', verify_ref: 'InactivityTimeoutTests.SkipsActiveHandling' },
  ],
};

const status = (id: string) => (getTestDb().prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }).status;

describe('create_spec', () => {
  it('creates a draft with keyed criteria', async () => {
    const out = await call('create_spec', SPEC);
    expect(out.key).toBe('SPEC-1');
    expect(out.status).toBe('draft');
    expect(out.criteria.map((c: any) => c.key)).toEqual(['AC-1.1', 'AC-1.2']);
  });

  it('only lets architects and humans author', async () => {
    const out = await call('create_spec', { ...SPEC, actor: 'agent:cli-1' });
    expect(out.error).toBe('forbidden');
    expect((await call('create_spec', { ...SPEC, actor: 'nobody' })).error).toBe('invalid_actor');
  });

  it('requires at least one criterion and warns about unnamed tests', async () => {
    expect((await call('create_spec', { ...SPEC, criteria: [] })).error).toBe('invalid_criteria');
    const out = await call('create_spec', { ...SPEC, criteria: [{ statement: 'X works', verify_kind: 'test' }] });
    expect(out.warnings[0]).toMatch(/AC-1.1/);
  });
});

describe('create_task with a spec', () => {
  it('starts in backlog and links every criterion by default', async () => {
    await call('create_spec', SPEC);
    const task = await call('create_task', { project: 'P', title: 'Implement timeout', spec_id: 'SPEC-1' });
    expect(task.status).toBe('backlog');
    expect(task.key).toBe('p-1');
    expect(task.criteria).toEqual(['AC-1.1', 'AC-1.2']);
  });

  it('rejects criteria from another spec', async () => {
    await call('create_spec', SPEC);
    await call('create_spec', { ...SPEC, title: 'Other' });
    const out = await call('create_task', { project: 'P', title: 'T', spec_id: 'SPEC-1', criteria: ['AC-2.1'] });
    expect(out.error).toBe('invalid_criteria');
  });

  it('starts blocked when a plain task names an open blocker', async () => {
    seedTask(getTestDb(), 'p1', { id: 'dep' });
    const out = await call('create_task', { project: 'P', title: 'T', blocked_by: ['dep'] });
    expect(out.status).toBe('blocked');
  });
});

describe('approve_spec', () => {
  it('needs a human for medium risk and releases backlog tasks', async () => {
    await call('create_spec', SPEC);
    const ready = await call('create_task', { project: 'P', title: 'A', spec_id: 'SPEC-1' });
    seedTask(getTestDb(), 'p1', { id: 'dep', status: 'ready' });
    const waiting = await call('create_task', { project: 'P', title: 'B', spec_id: 'SPEC-1', blocked_by: ['dep'] });

    expect((await call('approve_spec', { spec_id: 'SPEC-1', project: 'P', actor: 'agent:architect' })).error).toBe('forbidden');
    const out = await call('approve_spec', { spec_id: 'SPEC-1', project: 'P', actor: 'human:umit' });
    expect(out.status).toBe('approved');
    expect(out.version).toBe(1);
    expect(out.tasks_made_ready).toEqual([ready.key]);
    expect(status(ready.task_id)).toBe('ready');
    expect(status(waiting.task_id)).toBe('blocked');
  });

  it('lets the architect approve low risk', async () => {
    await call('create_spec', { ...SPEC, risk_level: 'low' });
    expect((await call('approve_spec', { spec_id: 'SPEC-1', actor: 'agent:architect' })).status).toBe('approved');
  });

  it('writes the spec file into the repo after approval', async () => {
    await call('create_spec', SPEC);
    const out = await call('approve_spec', { spec_id: 'SPEC-1', actor: 'human:umit' });
    const path = join(repo, 'specs', 'SPEC-1.md');
    expect(out.spec_file).toBe(path);
    const md = readFileSync(path, 'utf8');
    expect(md).toContain('# SPEC-1: Conversation inactivity timeout');
    expect(md).toContain('**AC-1.2** Never closes a conversation an agent is handling');
    expect(md).toContain('Do not edit');
  });

  it('keeps the approval when the file cannot be written', async () => {
    writeFileSync(join(repo, 'specs'), 'a file where the directory should be');
    await call('create_spec', SPEC);
    const out = await call('approve_spec', { spec_id: 'SPEC-1', actor: 'human:umit' });
    expect(out.status).toBe('approved');
    expect(out.warning).toMatch(/Could not write/);
    expect((await call('get_spec', { spec_id: 'SPEC-1' })).status).toBe('approved');
  });

  it('warns but approves when the project has no repo path', async () => {
    getTestDb().prepare("UPDATE projects SET repo_path = NULL WHERE id = 'p1'").run();
    await call('create_spec', SPEC);
    const out = await call('approve_spec', { spec_id: 'SPEC-1', actor: 'human:umit' });
    expect(out.status).toBe('approved');
    expect(out.warning).toMatch(/No repo_path/);
  });

  it('rejects approving a spec that is not a draft', async () => {
    await call('create_spec', SPEC);
    await call('approve_spec', { spec_id: 'SPEC-1', actor: 'human:umit' });
    expect((await call('approve_spec', { spec_id: 'SPEC-1', actor: 'human:umit' })).error).toBe('invalid_state');
  });
});

describe('update_spec', () => {
  it('fails on a stale expected_version', async () => {
    await call('create_spec', SPEC);
    const out = await call('update_spec', { spec_id: 'SPEC-1', actor: 'agent:architect', expected_version: 2, title: 'X' });
    expect(out.error).toBe('version_conflict');
  });

  it('does not bump a draft, and bumps and republishes an approved spec', async () => {
    await call('create_spec', SPEC);
    const draft = await call('update_spec', { spec_id: 'SPEC-1', actor: 'agent:architect', expected_version: 1, approach: 'Sweep every minute.' });
    expect(draft.version).toBe(1);

    await call('approve_spec', { spec_id: 'SPEC-1', actor: 'human:umit' });
    const forbidden = await call('update_spec', { spec_id: 'SPEC-1', actor: 'agent:architect', expected_version: 1, approach: 'X' });
    expect(forbidden.error).toBe('forbidden');

    const out = await call('update_spec', {
      spec_id: 'SPEC-1', actor: 'human:umit', expected_version: 1,
      criteria_upsert: [{ seq: 2, statement: 'Never closes a handled or waiting conversation', verify_kind: 'test', verify_ref: 'T.Skips' }],
    });
    expect(out.version).toBe(2);
    expect(readFileSync(join(repo, 'specs', 'SPEC-1.md'), 'utf8')).toContain('Version 2');
    expect(readFileSync(join(repo, 'specs', 'SPEC-1.md'), 'utf8')).toContain('handled or waiting');
  });

  it('does not bump an approved spec when nothing changed', async () => {
    await call('create_spec', SPEC);
    await call('approve_spec', { spec_id: 'SPEC-1', actor: 'human:umit' });
    const out = await call('update_spec', { spec_id: 'SPEC-1', actor: 'human:umit', expected_version: 1, title: SPEC.title });
    expect(out.version).toBe(1);
  });

  it('adds and removes criteria but never removes the last one', async () => {
    await call('create_spec', SPEC);
    const out = await call('update_spec', {
      spec_id: 'SPEC-1', actor: 'agent:architect', expected_version: 1,
      criteria_remove: [1], criteria_upsert: [{ statement: 'Logs the closure', verify_kind: 'review' }],
    });
    expect(out.criteria_added).toEqual([expect.objectContaining({ key: 'AC-1.3' })]);
    const empty = await call('update_spec', { spec_id: 'SPEC-1', actor: 'agent:architect', expected_version: 1, criteria_remove: [2, 3] });
    expect(empty.error).toBe('invalid_criteria');
    expect((await call('get_spec', { spec_id: 'SPEC-1' })).criteria).toHaveLength(2);
  });
});

describe('supersede_spec', () => {
  it('cancels unfinished tasks of the old spec', async () => {
    await call('create_spec', SPEC);
    await call('create_spec', { ...SPEC, title: 'Timeout v2' });
    const t = await call('create_task', { project: 'P', title: 'A', spec_id: 'SPEC-1' });
    const out = await call('supersede_spec', { spec_id: 'SPEC-1', replacement_spec_id: 'SPEC-2', project: 'P', actor: 'human:umit', reason: 'Rescoped' });
    expect(out.cancelled_tasks).toEqual([t.key]);
    expect(status(t.task_id)).toBe('cancelled');
    const spec = await call('get_spec', { spec_id: 'SPEC-1' });
    expect(spec.status).toBe('superseded');
    expect(spec.superseded_by).toBe('SPEC-2');
  });
});

describe('log_decision with specs', () => {
  it('links to a spec and supersedes an older decision', async () => {
    await call('create_spec', SPEC);
    const old = await call('log_decision', { project: 'P', title: 'Timers', decision: 'Per-conversation timers', spec_id: 'SPEC-1' });
    const neu = await call('log_decision', { project: 'P', title: 'Sweep', decision: 'Scheduled sweep', spec_id: 'SPEC-1', supersedes: old.decision_id });
    expect(neu.superseded).toBe(old.decision_id);
    const spec = await call('get_spec', { spec_id: 'SPEC-1' });
    expect(spec.decisions.map((d: any) => d.title)).toEqual(['Sweep']);
    const again = await call('log_decision', { project: 'P', title: 'X', decision: 'Y', supersedes: old.decision_id });
    expect(again.error).toBe('invalid_state');
  });
});

describe('spec files', () => {
  it('are not written for drafts', async () => {
    await call('create_spec', SPEC);
    expect(existsSync(join(repo, 'specs', 'SPEC-1.md'))).toBe(false);
  });
});
