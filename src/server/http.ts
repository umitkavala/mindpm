import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { release } from 'node:os';
import { handleApiRequest } from './routes.js';

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// In bundled output (dist/index.js), UI is at dist/ui/
// __dirname points to the directory of the actual file, not the symlink
function resolveStaticDir(): string {
  return join(__dirname, 'ui');
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

export function matchRoute(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// --- Who may talk to this server ---------------------------------------
//
// The UI routes write to the database as human:ui, so the port is guarded:
// - it binds to 127.0.0.1 unless MINDPM_HOST says otherwise;
// - every request must name an allowed Host (stops DNS rebinding, where a
//   page on attacker.example resolves its own name to 127.0.0.1);
// - writes must come with a matching Origin and the per-start UI token that
//   only the served page carries (stops other sites POSTing to localhost);
// - the page can't be framed (stops clickjacking the Accept button).
// A process on this machine can still read the page and send the token: an
// agent with a shell is kept off the port by Claude Code deny rules (Phase 3).

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]', '::1'];
const WILDCARD_HOSTS = ['0.0.0.0', '::', '[::]'];

// MINDPM_UI_TOKEN pins the token, e.g. for the Vite dev server's proxy.
const UI_TOKEN = process.env.MINDPM_UI_TOKEN || randomBytes(32).toString('base64url');

export function bindHost(): string {
  return process.env.MINDPM_HOST?.trim() || '127.0.0.1';
}

// Hostnames requests may address: loopback, the bind host when it is a
// specific address, and anything listed in MINDPM_ALLOWED_HOSTS.
export function allowedHostnames(): Set<string> {
  const names = new Set(LOCAL_HOSTNAMES);
  const host = bindHost().toLowerCase();
  if (!WILDCARD_HOSTS.includes(host)) names.add(host);
  for (const h of (process.env.MINDPM_ALLOWED_HOSTS ?? '').split(',')) {
    if (h.trim()) names.add(h.trim().toLowerCase());
  }
  return names;
}

function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

// null when the request may proceed, otherwise why it was refused.
export function checkRequest(req: IncomingMessage, token = UI_TOKEN): string | null {
  const allowed = allowedHostnames();
  const host = req.headers.host;
  if (!host || !allowed.has(hostnameOf(host))) return 'Host not allowed';
  if (SAFE_METHODS.includes(req.method ?? 'GET')) return null;
  const origin = req.headers.origin;
  if (!origin) return 'Origin required';
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return 'Origin not allowed';
  }
  if (!allowed.has(originUrl.hostname.toLowerCase()) || originUrl.host.toLowerCase() !== host.toLowerCase()) {
    return 'Origin not allowed';
  }
  const sent = req.headers['x-mindpm-token'];
  const a = Buffer.from(typeof sent === 'string' ? sent : '');
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'UI token missing or wrong; reload the page';
  return null;
}

// The served page carries the token for its own API calls.
export function renderIndex(html: string, token = UI_TOKEN): string {
  const meta = `<meta name="mindpm-token" content="${token}">`;
  return html.includes('</head>') ? html.replace('</head>', `  ${meta}\n  </head>`) : meta + html;
}

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

async function serveIndex(res: ServerResponse, path: string): Promise<void> {
  const html = await readFile(path, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(renderIndex(html));
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const staticDir = resolveStaticDir();
  const url = new URL(req.url || '/', 'http://localhost');
  let filePath = join(staticDir, url.pathname === '/' ? 'index.html' : url.pathname);

  // Never serve outside the UI directory.
  if (!filePath.startsWith(staticDir)) filePath = join(staticDir, 'index.html');

  try {
    if (filePath.endsWith('index.html')) {
      await serveIndex(res, filePath);
      return;
    }
    const content = await readFile(filePath);
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    // SPA fallback: serve index.html for any non-file route
    try {
      await serveIndex(res, join(staticDir, 'index.html'));
    } catch {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<html><body><h1>mindpm UI not built</h1><p>Run <code>npm run build:ui</code> to build the Kanban UI.</p></body></html>',
      );
    }
  }
}

let _httpPort: number | null = null;

export function getHttpPort(): number | null {
  return _httpPort;
}

export function startHttpServer(port: number, host = bindHost()): Server {
  // Set optimistically so getHttpPort() works immediately for tools called right after startup
  _httpPort = port;

  const server = createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const refused = checkRequest(req);
    if (refused) {
      process.stderr.write(`[mindpm] Refused ${req.method} ${req.url}: ${refused}\n`);
      sendJson(res, 403, { error: refused });
      return;
    }
    try {
      if (req.url?.startsWith('/api/')) {
        process.stderr.write(`[mindpm] API request: ${req.method} ${req.url}\n`);
        await handleApiRequest(req, res);
      } else {
        await serveStatic(req, res);
      }
    } catch (err) {
      process.stderr.write(`[mindpm] HTTP error on ${req.method} ${req.url}: ${err}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error', detail: String(err) });
      }
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Keep _httpPort set — the existing process on this port is still serving the Kanban UI
      process.stderr.write(
        `[mindpm] Port ${port} already in use. Kanban UI served by existing process at http://localhost:${port}\n`,
      );
    } else {
      _httpPort = null;
      process.stderr.write(`[mindpm] HTTP server error: ${err.message}\n`);
    }
  });

  server.listen(port, host, () => {
    const url = `http://localhost:${port}`;
    if (!WILDCARD_HOSTS.includes(host) && release().toLowerCase().includes('microsoft')) {
      // WSL2's default NAT networking doesn't forward loopback-bound ports to
      // Windows, so a Windows browser gets "connection refused".
      process.stderr.write(
        '[mindpm] Running under WSL: with NAT networking a Windows browser can\'t reach a server bound to 127.0.0.1. ' +
          'Prefer networkingMode=mirrored in .wslconfig (no MINDPM_HOST needed). Under NAT, MINDPM_HOST=0.0.0.0 also works, ' +
          'but never combine it with mirrored mode: there 0.0.0.0 is your real network interface and the board is on your LAN.\n',
      );
    }
    if (WILDCARD_HOSTS.includes(host)) {
      process.stderr.write(`[mindpm] Kanban UI listening on all interfaces (MINDPM_HOST=${host}). Anyone who can reach this port can act as human:ui.\n`);
    }
    process.stderr.write(`[mindpm] Kanban UI available at ${url}\n`);
    if (process.env.MINDPM_OPEN_BROWSER === '1') {
      openBrowser(url);
    }
  });

  return server;
}
