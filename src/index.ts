#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerProjectTools } from './tools/projects.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerDecisionTools } from './tools/decisions.js';
import { registerNoteTools } from './tools/notes.js';
import { registerSessionTools } from './tools/sessions.js';
import { registerQueryTools } from './tools/queries.js';
import { closeDb, ensureDbDirectory } from './db/connection.js';

const server = new McpServer(
  {
    name: 'mindpm',
    version: '1.1.0',
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

// Start the server
async function main() {
  ensureDbDirectory();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  closeDb();
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeDb();
  process.exit(0);
});
