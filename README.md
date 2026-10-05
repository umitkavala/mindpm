# mindpm

**Project memory and a control plane for AI coding agents.**

mindpm is an MCP (Model Context Protocol) server that gives LLMs a SQLite-backed brain for your projects. It tracks tasks, decisions, architecture notes, and session context — so every new conversation picks up exactly where you left off. It also hands specced tasks to coding agents, keeps parallel agents from colliding, and only counts work as done once a human has accepted it. For agents that run unattended, an optional verifier reruns the checks itself first.

## The Problem

Every new LLM chat starts from zero:

- *"Let me remind you about my project..."*
- *"Last time we decided to use Redis for..."*
- *"Where did we leave off?"*

## The Solution

mindpm persists your project state in a local SQLite database. The LLM reads and writes to it via MCP tools. No chat history needed. No memory features needed.

```
You: "What should I work on next?"
LLM: [queries mindpm] "Last session you finished the auth refactor.
      You have 3 high-priority tasks: rate limiting, API docs, and
      the webhook retry bug. Rate limiting is unblocked — start there."
```

## What It Tracks

- **Tasks, specs and acceptance criteria**, with handoff statuses, priorities and blockers
- **Decisions**: what was decided, why, and what was rejected
- **Notes and context**: architecture, bugs, ideas, tech stack, conventions
- **Sessions**: what was done and what's next, plus a brief of what changed while you were away
- **Agent attempts**: every run on a task, and what the next attempt should avoid

## Quick start

```bash
claude mcp add mindpm -e MINDPM_DB_PATH=~/.mindpm/memory.db -- npx -y mindpm
```

That's Claude Code, and `npx` fetches mindpm, so there's nothing to install first. [Claude Desktop, Cursor, VS Code, Cline and Windsurf](https://github.com/umitkavala/mindpm/blob/main/docs/setup.md#configure-your-mcp-client) use the same JSON config in a different file. Then just talk about your project. The LLM calls `start_session` to load its context, records tasks, decisions and notes as you go, and calls `end_session` to save what's next. A Kanban board runs at `http://localhost:3131`.

## How it works

```
┌──────────────┐     MCP      ┌─────────┐     SQLite     ┌───────────┐
│ Claude Code, │ ◄──────────► │ mindpm  │ ◄────────────► │ memory.db │
│ Cursor, ...  │    tools     │ server  │   read/write   │           │
└──────────────┘              └─────────┘                └───────────┘
```

Everything stays on your machine, in one SQLite file (`~/.mindpm/memory.db` by default). mindpm can also hand specced tasks to coding agents with no conversation context: claims with leases keep parallel agents from colliding, and you accept submitted work on the board. For agents that run unattended, an optional verifier reruns the checks on each submitted commit first.

**Security:** mindpm has no user accounts and can't stop a process on your own machine. An agent with a shell can call the board's routes as you or edit the database directly. Read the [security model](https://github.com/umitkavala/mindpm/blob/main/docs/security.md) before you let agents run unattended.

## Documentation

- [Setup](https://github.com/umitkavala/mindpm/blob/main/docs/setup.md): every MCP client, agent instructions for any LLM, storage
- [Kanban board](https://github.com/umitkavala/mindpm/blob/main/docs/kanban-board.md): lanes, accepting work, network binding and WSL
- [Session brief](https://github.com/umitkavala/mindpm/blob/main/docs/session-brief.md): what changed while you were away
- [Agent execution](https://github.com/umitkavala/mindpm/blob/main/docs/agent-execution.md): lifecycle, specs, claims and briefs
- [Advanced: unattended agents and verification](https://github.com/umitkavala/mindpm/blob/main/docs/advanced-verification.md)
- [Security model](https://github.com/umitkavala/mindpm/blob/main/docs/security.md)
- [MCP tools](https://github.com/umitkavala/mindpm/blob/main/docs/tools.md)
- [Development](https://github.com/umitkavala/mindpm/blob/main/docs/development.md)
- [Changelog](https://github.com/umitkavala/mindpm/blob/main/CHANGELOG.md)

## License

MIT
