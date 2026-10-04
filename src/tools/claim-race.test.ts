import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSchema, runMigrations } from '../db/schema.js';

// Several CLI agents run as separate processes on one SQLite file. Two real
// processes race claim_task on the same task every round; exactly one wins.
const ROUNDS = 40;
const WORKER = resolve(__dirname, '../test-helpers/claim-worker.ts');

let dir: string;
let db: Database.Database;
let workers: ChildProcess[] = [];
const stderr: string[] = [];

type Reply = { round: number; actor: string; won: boolean; error: string | null };

function nextReply(worker: ChildProcess, round: number): Promise<Reply> {
  return new Promise((ok) => {
    const onMessage = (m: Reply) => {
      if (m.round !== round) return;
      worker.off('message', onMessage);
      ok(m);
    };
    worker.on('message', onMessage);
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mindpm-race-'));
  const path = join(dir, 'memory.db');
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  runMigrations(db);
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1', 'Race', 'race')").run();

  workers = ['agent:cli-a', 'agent:cli-b'].map((actor) => {
    const w = fork(WORKER, [actor], {
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, MINDPM_DB_PATH: path },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    w.stderr!.on('data', (d) => stderr.push(String(d)));
    return w;
  });
  await Promise.all(workers.map((w) => new Promise<void>((ok, fail) => {
    w.once('message', () => ok());
    w.once('exit', (code) => fail(new Error(`worker exited early (${code}): ${stderr.join('')}`)));
  })));
}, 30_000);

afterAll(async () => {
  await Promise.all(workers.map((w) => new Promise<void>((ok) => {
    if (w.exitCode !== null) return ok();
    w.once('exit', () => ok());
    w.send({ type: 'exit' });
  })));
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('claim_task across processes', () => {
  it(`exactly one of two processes wins each of ${ROUNDS} rounds`, async () => {
    const wins: Record<string, number> = {};
    for (let round = 1; round <= ROUNDS; round++) {
      const taskId = `task${round}`;
      db.prepare("INSERT INTO tasks (id, project_id, seq, title, status) VALUES (?, 'p1', ?, ?, 'ready')").run(taskId, round, `Race ${round}`);

      const at = Date.now() + 25;
      const replies = Promise.all(workers.map((w) => nextReply(w, round)));
      for (const w of workers) w.send({ type: 'claim', round, taskId, at });
      const [a, b] = await replies;

      const winners = [a, b].filter((r) => r.won);
      expect(winners, `round ${round}: ${JSON.stringify([a, b])}`).toHaveLength(1);
      expect([a, b].find((r) => !r.won)!.error).toBe('already_claimed');

      const row = db.prepare('SELECT status, claimed_by FROM tasks WHERE id = ?').get(taskId);
      expect(row).toEqual({ status: 'claimed', claimed_by: winners[0].actor });
      const attempts = db.prepare('SELECT actor FROM attempts WHERE task_id = ?').all(taskId);
      expect(attempts).toEqual([{ actor: winners[0].actor }]);
      wins[winners[0].actor] = (wins[winners[0].actor] ?? 0) + 1;
    }
    // Not asserted (timing-dependent), but useful when reading a failure.
    console.log(`claim race wins: ${JSON.stringify(wins)}`);
  }, 60_000);
});
