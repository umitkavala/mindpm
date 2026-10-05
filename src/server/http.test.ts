import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, Server } from 'node:http';
import { createTestDb, closeTestDb, getTestDb, seedProject, seedTask } from '../test-helpers/setup.js';

vi.mock('../db/connection.js', () => ({
  getDb: () => getTestDb(),
  closeDb: () => closeTestDb(),
}));

import { allowedHostnames, bindHost, checkRequest, renderIndex, startHttpServer } from './http.js';

const fake = (headers: Record<string, string>, method = 'POST') => ({ method, headers } as unknown as IncomingMessage);
const TOKEN = 'tok-123';

describe('checkRequest', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('lets the served page write: local host, same origin, right token', () => {
    expect(checkRequest(fake({ host: 'localhost:3131', origin: 'http://localhost:3131', 'x-mindpm-token': TOKEN }), TOKEN)).toBeNull();
    expect(checkRequest(fake({ host: '127.0.0.1:3131', origin: 'http://127.0.0.1:3131', 'x-mindpm-token': TOKEN }), TOKEN)).toBeNull();
  });

  it('refuses a rebound or foreign Host, even for reads', () => {
    expect(checkRequest(fake({ host: 'attacker.example:3131' }, 'GET'), TOKEN)).toBe('Host not allowed');
    expect(checkRequest(fake({}, 'GET'), TOKEN)).toBe('Host not allowed');
    expect(checkRequest(fake({ host: 'localhost:3131' }, 'GET'), TOKEN)).toBeNull();
  });

  it('refuses writes from another site, without an Origin, or without the token', () => {
    const host = 'localhost:3131';
    expect(checkRequest(fake({ host, origin: 'https://evil.example', 'x-mindpm-token': TOKEN }), TOKEN)).toBe('Origin not allowed');
    expect(checkRequest(fake({ host, origin: 'http://localhost:5173', 'x-mindpm-token': TOKEN }), TOKEN)).toBe('Origin not allowed');
    expect(checkRequest(fake({ host, 'x-mindpm-token': TOKEN }), TOKEN)).toBe('Origin required');
    expect(checkRequest(fake({ host, origin: 'http://localhost:3131' }), TOKEN)).toMatch(/token/);
    expect(checkRequest(fake({ host, origin: 'http://localhost:3131', 'x-mindpm-token': 'wrong' }), TOKEN)).toMatch(/token/);
  });

  it('binds to loopback unless MINDPM_HOST opts in, and allows only named hosts', () => {
    delete process.env.MINDPM_HOST;
    expect(bindHost()).toBe('127.0.0.1');
    process.env.MINDPM_HOST = '0.0.0.0';
    expect(allowedHostnames().has('0.0.0.0')).toBe(false);
    process.env.MINDPM_ALLOWED_HOSTS = 'devbox.lan';
    expect(checkRequest(fake({ host: 'devbox.lan:3131' }, 'GET'), TOKEN)).toBeNull();
    process.env.MINDPM_HOST = '192.168.1.20';
    expect(checkRequest(fake({ host: '192.168.1.20:3131' }, 'GET'), TOKEN)).toBeNull();
  });
});

describe('renderIndex', () => {
  it('embeds the token for the page to send back', () => {
    expect(renderIndex('<html><head><title>x</title></head><body></body></html>', TOKEN))
      .toContain('<meta name="mindpm-token" content="tok-123">');
  });
});

describe('the running server', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    delete process.env.MINDPM_HOST;
    createTestDb();
    seedProject(getTestDb(), { id: 'p1', name: 'P' });
    seedTask(getTestDb(), 'p1', { id: 't1', status: 'needs_verification' });
    server = startHttpServer(0);
    await new Promise<void>(r => server.once('listening', () => r()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()));
    closeTestDb();
  });

  const send = (method: string, path: string, headers: Record<string, string>) => new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : '{}');
  });

  it('listens on loopback only', () => {
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('refuses a cross-site accept, and the task stays where it was', async () => {
    const res = await send('POST', '/api/tasks/t1/accept', { host: `localhost:${port}`, origin: 'https://evil.example', 'content-type': 'application/json' });
    expect(res.status).toBe(403);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect((getTestDb().prepare("SELECT status FROM tasks WHERE id = 't1'").get() as any).status).toBe('needs_verification');
  });

  it('refuses to switch verification without the UI token', async () => {
    const res = await send('PUT', '/api/projects/p1/verification', { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'content-type': 'application/json' });
    expect(res.status).toBe(403);
    expect((getTestDb().prepare("SELECT verification FROM projects WHERE id = 'p1'").get() as any).verification).toBe('off');
  });

  it('refuses reads addressed to another host name (DNS rebinding)', async () => {
    expect((await send('GET', '/api/projects', { host: `attacker.example:${port}` })).status).toBe(403);
    expect((await send('GET', '/api/projects', { host: `localhost:${port}` })).status).toBe(200);
  });
});
