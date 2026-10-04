// A separate OS process that claims tasks through the real claim_task tool
// on a shared database file (MINDPM_DB_PATH). Driven over IPC by
// src/tools/claim-race.test.ts to prove claims hold across processes.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { closeDb, getDb } from '../db/connection.js';
import { registerExecutorTools } from '../tools/executor.js';

const actor = process.argv[2];
const server = new McpServer({ name: 'claim-worker', version: '0.0.0' }, { capabilities: { tools: {} } });
registerExecutorTools(server);
const claim = (server as any)._registeredTools.claim_task.handler;

type Message = { type: 'claim'; round: number; taskId: string; at: number } | { type: 'exit' };

process.on('message', async (msg: Message) => {
  if (msg.type === 'exit') {
    closeDb();
    process.exit(0);
  }
  // Both workers spin until the same wall-clock instant, then claim.
  while (Date.now() < msg.at) { /* spin */ }
  try {
    const result = await claim({ task_id: msg.taskId, actor }, {});
    const body = JSON.parse(result.content[0].text);
    process.send!({ round: msg.round, actor, won: typeof body.claim_token === 'string', error: body.error ?? null });
  } catch (err) {
    // Report thrown errors (SQLITE_BUSY and the like) instead of going silent.
    process.send!({ round: msg.round, actor, won: false, error: `threw: ${(err as Error).message}` });
  }
});

getDb(); // open and initialize before reporting ready
process.send!({ type: 'ready' });
