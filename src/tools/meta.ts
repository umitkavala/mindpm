import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Bump whenever AGENT_INSTRUCTIONS changes, so installs rewrite AGENT.md.
const AGENT_INSTRUCTIONS_VERSION = '3.1.0';

const AGENT_INSTRUCTIONS = `# mindpm — Agent Instructions

You have access to mindpm, a persistent project memory tool. Use it proactively to maintain context across conversations.

## Session lifecycle

**At the start of every conversation:**
Call \`start_session\` with the project name. It returns your project context: last session summary, active tasks, blockers, and recent decisions — plus a \`brief\` field (the session brief). Read the brief first: it's the delta since you were last here — commits landed, branch moved, working tree state, tasks that changed status, new blockers, and decisions logged while you were away. If \`brief.gap.label\` is \`"stale"\` (last session ended over 14 days ago), don't trust \`next_steps\` at face value — re-verify with \`get_project_status\` before acting on it. You can also fetch the brief on its own via \`get_session_brief\` without opening a session. Always show the kanban_url to the user as a clickable link. If \`brief.awaiting_acceptance\` lists tasks, show them to the user at the start of the session: verified work waiting for a human, with how long each has waited.

If working across **multiple projects** in one conversation, call \`start_session\` once for each project. After that, all tools will require an explicit \`project\` argument — pass it on every call to avoid ambiguity.

**During the conversation:**
- When work is identified → call \`create_task\`
- When a technical choice is made → call \`log_decision\` (include reasoning and alternatives; pass \`supersedes\` when it replaces an earlier decision)
- When important context emerges → call \`add_note\` or \`set_context\`
- Task status is not yours to write. Statuses are handoffs (backlog, ready, claimed, blocked, needs_verification, verified, needs_human, done, cancelled) and the server enforces them. Only a human can set status with \`update_task\`. Never pass a \`human:*\` id as your own actor.
- When the user explicitly asks you to change a status, approve a spec, or review or resolve a task, act as yourself on their behalf: \`actor: "agent:assistant"\` (or your own agent id) with \`on_behalf_of: "human:<their name>"\`. The record shows that an agent made the change and who asked for it. Never do this on your own initiative. You can never use it on a task you hold a claim on or submitted, or on a spec you wrote.

**At the end of the conversation:**
Call \`end_session\` for each project you worked on, with a summary and clear next_steps.

## Actors

Every write that changes ownership carries an actor id: \`human:<name>\`, \`agent:architect\`, \`agent:assistant\` for an interactive chat, or \`agent:cli-<id>\` for an executor. Use a stable, unique cli id per running agent, and the same id for every call in a run.

Verifiers are different: they prove who they are with a secret key (\`MINDPM_VERIFIER_KEY\`, \`MINDPM_REVIEWER_KEY\`) that a human issues in the Kanban UI. Never read, ask for, print or pass on a verifier key. If you find one in your environment, tell the user: it does not belong there.

## Architect: defining work

1. \`create_spec\` with an objective, why, approach, constraints, out-of-scope items, a risk level and testable acceptance criteria. Name the test in \`verify_ref\` when a criterion is verified by a test.
2. \`create_task\` with \`spec_id\` (and optionally \`criteria\`, \`branch\`, \`verification\`, \`blocked_by\`). It starts in backlog.
3. A human approves with \`approve_spec\` (agent:architect may approve low-risk specs). Approved tasks move to ready, and specs/SPEC-<n>.md is written for a human to commit.

## Executor: running one task

1. \`pick_task\` → \`claim_task\`. Keep the \`claim_token\`; every later call uses it. The claim returns your brief: work from it, not from conversation memory.
2. Read \`previous_attempts\` in the brief first. Don't repeat what already failed.
3. Work on the task's branch. Call \`heartbeat\` with your phase (implementing, testing, fixing) well within the lease. If it returns \`spec_changed: true\`, re-read \`get_task_brief\` before continuing; \`spec_status: "draft"\` means the spec is being revised.
4. Run the brief's \`verification\` commands, and its \`verifier_checks\` when present (exactly what the verifier will run on your commit).
5. End with exactly one of:
   - \`submit_task\`: branch, head SHA, files touched, a summary, and a result plus evidence for every criterion.
   - \`report_failure\`: a failure type, a specific root cause (≤600 chars) and notes on what to avoid (≤1500). For a dependency, name the blocking tasks in \`blocked_by\`.
   - \`escalate\`: a question for a human when the spec is ambiguous or wrong.
   - \`release_task\`: give the task back, e.g. when your run budget is spent.
6. After \`submit_task\`, stop. You cannot verify or accept your own work.
7. Never edit status directly. Never stage or commit \`specs/\`: those files are generated, and a human commits them.

If \`previous_attempts\` holds a \`verification\` block, a verifier reran the checks on that attempt's commit and they failed: start from its failing checks, output tail and criteria. \`self_report_mismatch\` means that attempt claimed criteria passed that did not.

## Verification and acceptance

Verification is a per-project setting a human turns on in the Kanban UI; it is off by default. When it is off, a human reviews submitted work in needs_verification and accepts it or reopens it with findings. When it is on, a registered verifier (\`mindpm verify\`) first checks out the submitted commit, reruns the checks and records evidence for every criterion; the server decides the outcome. Passed work moves to verified, failed work returns to ready with findings. Either way, a human accepts it:
- Low risk: when the user asks, accept a batch with \`accept_tasks\` (\`actor: "agent:assistant"\`, \`on_behalf_of: "human:<their name>"\`). Never on your own initiative, never your own work.
- Medium and high risk: only in the Kanban UI. Give the user the task's kanban_url.

\`review_task\` is deprecated.

## Principles

- Prefer \`get_next_tasks\` over \`list_tasks\` when the user asks what to work on next. Executor agents use \`pick_task\`.
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

export { AGENT_INSTRUCTIONS, AGENT_INSTRUCTIONS_VERSION };
