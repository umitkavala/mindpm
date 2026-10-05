# mindpm

**Project memory and a control plane for AI coding agents.** mindpm is an MCP server that keeps your projects' tasks, decisions, notes and sessions in a local SQLite database, so every new conversation picks up where the last one stopped. It can also hand specced tasks to coding agents, keep parallel agents from colliding, and count work as done only once a human has accepted it.

## Why

Every new LLM chat starts from zero:

- *"Let me remind you about my project..."*
- *"Last time we decided to use Redis for..."*
- *"Where did we leave off?"*

mindpm gives the LLM a memory it reads and writes through MCP tools. No chat history and no memory features needed:

```
You: "What should I work on next?"
LLM: [queries mindpm] "Last session you finished the auth refactor.
      You have 3 high-priority tasks: rate limiting, API docs, and
      the webhook retry bug. Rate limiting is unblocked — start there."
```

## Two ways to use it

| | What you get |
| --- | --- |
| **Project memory** | Tasks, decisions with their reasons, notes and context that survive across conversations and tools. A [session brief](session-brief.md) tells you what changed while you were away: commits, task moves, new blockers. |
| **Control plane for agents** | Specs with acceptance criteria, atomic claims with leases, a self-contained brief per task, and a record of every attempt. You review and accept submitted work on the [Kanban board](kanban-board.md). See [agent execution](agent-execution.md). |

For agents that run unattended, an optional verifier rebuilds and tests each submitted commit before you accept it. See [unattended agents and verification](advanced-verification.md).

## Try it

```bash
claude mcp add mindpm -e MINDPM_DB_PATH=~/.mindpm/memory.db -- npx -y mindpm
```

Then talk about your project. The board runs at `http://localhost:3131`. [Getting started](setup.md) covers Claude Desktop, Cursor, VS Code, Cline and Windsurf, and how to use mindpm with any other LLM.

!!! warning "Local trust model"
    mindpm has no user accounts and can't stop a process on your own machine: an agent with a shell can call the board's routes as you or edit the database directly. Read the [security model](security.md) before you let agents run unattended.
