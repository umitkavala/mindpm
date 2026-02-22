import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
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

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const staticDir = resolveStaticDir();
  const url = new URL(req.url || '/', 'http://localhost');
  let filePath = join(staticDir, url.pathname === '/' ? 'index.html' : url.pathname);

  try {
    const content = await readFile(filePath);
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    // SPA fallback: serve index.html for any non-file route
    try {
      const indexPath = join(staticDir, 'index.html');
      const content = await readFile(indexPath);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
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

export function startHttpServer(port: number): Server {
  // Set optimistically so getHttpPort() works immediately for tools called right after startup
  _httpPort = port;

  const server = createServer(async (req, res) => {
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

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    process.stderr.write(`[mindpm] Kanban UI available at ${url}\n`);
    if (process.env.MINDPM_OPEN_BROWSER === '1') {
      openBrowser(url);
    }
  });

  return server;
}
