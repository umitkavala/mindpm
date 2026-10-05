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
import { registerDeliveryMetricsTools } from './tools/delivery-metrics.js';
import { registerSpecTools } from './tools/specs.js';
import { registerExecutorTools } from './tools/executor.js';
import { registerReviewTools } from './tools/review.js';
import { registerVerifierTools } from './tools/verifier.js';
import { closeDb, ensureDbDirectory, getDb } from './db/connection.js';
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
registerDeliveryMetricsTools(server);
registerSpecTools(server);
registerExecutorTools(server);
registerReviewTools(server);
registerVerifierTools(server);

// Start the server
let httpServer: Server | undefined;

async function main() {
  // `mindpm verify`: the local verifier, a separate process from the MCP
  // server that talks to the same database.
  if (process.argv[2] === 'verify') {
    const { runVerifyCli } = await import('./verify/run.js');
    const code = await runVerifyCli(process.argv.slice(3), getDb());
    closeDb();
    process.exit(code);
  }

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
