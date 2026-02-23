#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerProjectTools } from './tools/projects.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerDecisionTools } from './tools/decisions.js';
import { registerNoteTools } from './tools/notes.js';
import { registerSessionTools } from './tools/sessions.js';
import { registerQueryTools } from './tools/queries.js';
import { registerMetaTools } from './tools/meta.js';
import { closeDb, ensureDbDirectory } from './db/connection.js';
import { startHttpServer } from './server/http.js';
import { Server } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const server = new McpServer(
  {
    name: 'mindpm',
    version,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Register all tool groups
registerProjectTools(server);
registerTaskTools(server);
registerDecisionTools(server);
registerNoteTools(server);
registerSessionTools(server);
registerQueryTools(server);
registerMetaTools(server);

// Start the server
let httpServer: Server | undefined;

async function main() {
  ensureDbDirectory();

  // Start HTTP server for Kanban UI
  const port = parseInt(process.env.MINDPM_PORT || '3131', 10);
  httpServer = startHttpServer(port);

  // Start MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  httpServer?.close();
  closeDb();
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  httpServer?.close();
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  httpServer?.close();
  closeDb();
  process.exit(0);
});
