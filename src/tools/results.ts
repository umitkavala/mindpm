import { ToolError } from '../domain/lifecycle.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(code: string, message: string, extra: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: code, message, ...extra }) }], isError: true };
}

// Run a tool body, turning ToolError into a structured error result. Other
// errors propagate so real bugs stay loud.
export async function guarded(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ToolError) return errorResult(err.code, err.message);
    throw err;
  }
}

// Claim tokens authorize executor writes; never echo them outside claim_task.
export function publicTask<T extends Record<string, unknown>>(row: T): Omit<T, 'claim_token'> {
  const { claim_token: _omit, ...rest } = row;
  return rest;
}
