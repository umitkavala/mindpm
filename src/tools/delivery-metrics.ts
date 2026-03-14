import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { getDb, resolveProjectOrDefault } from '../db/queries.js';
import { computeDeliveryMetrics } from '../db/metrics.js';

export function registerDeliveryMetricsTools(server: McpServer): void {
  server.registerTool(
    'get_delivery_metrics',
    {
      title: 'Get Delivery Metrics',
      description:
        'DORA-inspired delivery metrics for a project: throughput, lead time, flow efficiency, and performance tier. Use to understand delivery health and trends.',
      inputSchema: {
        project: z.string().optional().describe('Project name or ID (defaults to most recent active project)'),
        days: z.number().int().min(1).max(365).optional().describe('Time window in days (default: 30)'),
      },
    },
    async ({ project, days = 30 }) => {
      const resolved = resolveProjectOrDefault(project);
      if (!resolved) {
        return {
          content: [{ type: 'text' as const, text: project ? `Project "${project}" not found.` : 'No active projects found.' }],
          isError: true,
        };
      }

      const db = getDb();
      const result = computeDeliveryMetrics(db, resolved.id, resolved.name, days);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );
}
