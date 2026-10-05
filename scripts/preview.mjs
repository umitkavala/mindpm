#!/usr/bin/env node
// npm run preview [-- <path to memory.db>] [--no-build]
//
// Builds, copies a mindpm database to a temporary directory and serves the
// Kanban UI from it on port 3132 (MINDPM_PREVIEW_PORT overrides; MINDPM_PORT
// is ignored, since it usually names the live server's port), with no MCP client
// attached. The copy is what gets migrated and written to; the original is
// only read. Uses MINDPM_DB_PATH, else ~/.mindpm/memory.db; with neither,
// it starts from an empty database.

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const build = !args.includes('--no-build');
const explicit = args.find(a => !a.startsWith('--'));

// C:\Users\me\.mindpm\memory.db -> /mnt/c/Users/me/.mindpm/memory.db under WSL.
function localPath(p) {
  const win = p.match(/^([A-Za-z]):[\\/](.*)$/);
  if (win && process.platform === 'linux' && /microsoft/i.test(release())) {
    return `/mnt/${win[1].toLowerCase()}/${win[2].replace(/\\/g, '/')}`;
  }
  return p.replace(/^~/, homedir());
}

const source = localPath(explicit ?? process.env.MINDPM_DB_PATH ?? join(homedir(), '.mindpm', 'memory.db'));
const port = process.env.MINDPM_PREVIEW_PORT || '3132';

if (build) {
  const r = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const dir = mkdtempSync(join(tmpdir(), 'mindpm-preview-'));
const target = join(dir, 'memory.db');
if (existsSync(source)) {
  // The WAL holds writes not yet checkpointed into the main file. The -shm
  // index is rebuilt on open; a stale copy of it gives inconsistent reads.
  copyFileSync(source, target);
  if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${target}-wal`);
  console.log(`[preview] copied ${source} to ${target}`);
} else if (explicit) {
  console.error(`[preview] ${source} does not exist.`);
  process.exit(1);
} else {
  console.log(`[preview] no database at ${source}; starting from an empty one in ${dir}`);
}

// stdin is a pipe nobody writes to, so the MCP transport waits quietly;
// stdout carries MCP frames and is dropped.
const child = spawn(process.execPath, [join(root, 'dist', 'index.js')], {
  cwd: root,
  env: { ...process.env, MINDPM_DB_PATH: target, MINDPM_PORT: port },
  stdio: ['pipe', 'ignore', 'inherit'],
});
console.log(`[preview] http://localhost:${port}  (Ctrl+C to stop; the copy is deleted on exit)`);

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  child.kill('SIGTERM');
  child.once('exit', () => {
    rmSync(dir, { recursive: true, force: true });
    process.exit(code);
  });
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
child.on('exit', code => {
  if (stopping) return;
  rmSync(dir, { recursive: true, force: true });
  process.exit(code ?? 1);
});
