import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const AGENT_INSTRUCTIONS = `# mindpm — Agent Instructions

You have access to mindpm, a persistent project memory tool. Use it proactively to maintain context across conversations.

## Session lifecycle

**At the start of every conversation:**
Call \`start_session\` with the project name. It returns your project context: last session summary, active tasks, blockers, and recent decisions. Always show the kanban_url to the user as a clickable link.

If working across **multiple projects** in one conversation, call \`start_session\` once for each project. After that, all tools will require an explicit \`project\` argument — pass it on every call to avoid ambiguity.

**During the conversation:**
- When work is identified → call \`create_task\`
- When a technical choice is made → call \`log_decision\` (include reasoning and alternatives)
- When important context emerges → call \`add_note\` or \`set_context\`
- When task status changes → call \`update_task\`

**At the end of the conversation:**
Call \`end_session\` for each project you worked on, with a summary and clear next_steps.

## Principles

- Prefer \`get_next_tasks\` over \`list_tasks\` when the user asks what to work on next — it returns the highest priority unblocked tasks
- Log decisions even for small choices — future sessions benefit from knowing *why*
- Keep task titles short and actionable (imperative form: "Add rate limiting", not "Rate limiting")
- Use \`search\` when the user references something you don't have in current context

## Works across all MCP clients

mindpm stores everything in a local SQLite database (~/.mindpm/memory.db). Any MCP-compatible client (Claude Code, Cursor, Cline, Copilot, Gemini) connecting to the same mindpm instance shares the same memory. You can switch tools mid-project without losing context.
`;

export function registerMetaTools(server: McpServer): void {
  server.registerTool(
    'get_agent_instructions',
    {
      title: 'Get Agent Instructions',
      description:
        'Returns the recommended instructions for using mindpm effectively. Call this once if you are unsure how to use mindpm, or share it with the user to paste into other LLM clients.',
      inputSchema: {},
    },
    async () => {
      return {
        content: [{ type: 'text' as const, text: AGENT_INSTRUCTIONS }],
      };
    },
  );
}

export { AGENT_INSTRUCTIONS };
