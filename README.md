# mindpm

**Persistent project memory for LLMs.** Never re-explain your project again.

mindpm is an MCP (Model Context Protocol) server that gives LLMs a SQLite-backed brain for your projects. It tracks tasks, decisions, architecture notes, and session context — so every new conversation picks up exactly where you left off.

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

- **Tasks** — status, priority, blockers, sub-tasks
- **Decisions** — what was decided, why, what alternatives were rejected
- **Notes** — architecture, bugs, ideas, research
- **Context** — key-value pairs (tech stack, conventions, config)
- **Sessions** — what was done, what's next

## Kanban Board

mindpm includes a built-in Kanban UI. When the MCP server starts, it serves a web interface at `http://localhost:3131`.

Every `start_session` call returns a direct link to your project's board:

```
Kanban board: http://localhost:3131?project=<project-id>
```

The port is configurable via the `MINDPM_PORT` environment variable.

## Session Brief

`get_project_status` tells you what you were doing. The **session brief** tells you what *changed while you were away* — commits landed, the branch moved, the working tree got dirty, tasks changed status, blockers appeared, a decision was logged.

Every `start_session` call embeds a brief automatically (pass `brief: false` to skip it), and you can also fetch one without opening a session via `get_session_brief`. It's fully deterministic — no LLM calls happen inside mindpm — and it never touches the network: everything comes from local git subprocess calls and the local SQLite database.

To get git activity in the brief, tell mindpm where your repo lives:

```
set_project_repo_path(project: "my-app", repo_path: "/Users/you/code/my-app")
```

(or pass `repo_path` directly to `create_project`). Without a configured repo, the brief still reports the task/blocker/decision delta — it just skips the git section.

Example output:

```jsonc
{
  "project": "my-app",
  "degraded": false,
  "degraded_reasons": [],
  "gap": {
    "last_session_ended_at": "2026-08-08T22:14:03.000Z",
    "hours_elapsed": 11.3,
    "label": "overnight"
  },
  "handoff": {
    "last_session_summary": "Finished the auth refactor",
    "next_steps": "Wire up rate limiting, then tackle the webhook retry bug"
  },
  "git": {
    "available": true,
    "anchor": "sha",
    "branch_then": "feat/phase-3",
    "branch_now": "feat/phase-3",
    "branch_changed": false,
    "commits": [
      { "sha": "a1b2c3d", "author": "umit", "date": "2026-08-09T09:02:11+00:00", "subject": "Add rate limit middleware" }
    ],
    "commit_count": 4,
    "commits_truncated": false,
    "files_changed": [
      { "path": "src/middleware/rate-limit.ts", "added": 82, "deleted": 11 }
    ],
    "files_changed_truncated": false,
    "working_tree_dirty": true,
    "untracked_count": 2,
    "stash_count": 0
  },
  "tasks": {
    "changed": [
      { "id": "a1b2c3d4", "title": "Add rate limiting", "from_status": "in_progress", "to_status": "done", "at": "2026-08-09T09:05:00.000Z" }
    ],
    "claimed_now": [{ "id": "e5f6a7b8", "title": "Webhook retry bug" }],
    "next_suggested": [{ "id": "c9d0e1f2", "title": "Write API docs", "priority": "high" }]
  },
  "blockers": [],
  "decisions_since": [
    { "id": "9f8e7d6c", "title": "Use token bucket for rate limiting", "at": "2026-08-09T09:00:00.000Z" }
  ],
  "notes_since_count": 3
}
```

`gap.label` is `same-day` (<6h), `overnight` (6-20h), `multi-day` (20h-14d), or `stale` (>14d) — a stale gap adds a `gap.hint` telling the agent to re-verify context rather than trust `next_steps` at face value.

The git delta is anchored on the exact commit sha recorded when the prior session ended (via `end_session`), not on a timestamp — sha-based anchoring survives rebases and amends that would break a clock-based diff. If that sha becomes unreachable (force-push, rebase, or the repo was pruned), the brief transparently falls back to a timestamp anchor and reports it in `degraded_reasons`. A broken or missing repo never fails the brief — it just comes back with `git.available: false` and `degraded: true`, while the task/blocker/decision delta is unaffected.

## Setup

### Install

```bash
npm install -g mindpm
```

Or run from source:

```bash
git clone https://github.com/umitkavala/mindpm.git
cd mindpm
npm install
npm run build
```

### Configure your MCP client

All clients use the same JSON format — just different config file locations. They all share the same `~/.mindpm/memory.db`, so you can switch tools mid-project without losing context.

**Claude Code** — `~/.claude/claude_desktop_config.json`
```json
{
  "mcpServers": {
    "mindpm": {
      "command": "mindpm",
      "env": {
        "MINDPM_DB_PATH": "~/.mindpm/memory.db",
        "MINDPM_PORT": "3131"
      }
    }
  }
}
```

Or use the one-liner:
```bash
claude mcp add mindpm -e MINDPM_DB_PATH=~/.mindpm/memory.db -- npx -y mindpm
```

**Cursor** — `.cursor/mcp.json` in your project root (or `~/.cursor/mcp.json` globally)
```json
{
  "mcpServers": {
    "mindpm": {
      "command": "npx",
      "args": ["-y", "mindpm"],
      "env": {
        "MINDPM_DB_PATH": "~/.mindpm/memory.db"
      }
    }
  }
}
```

**VS Code + Copilot** — `.vscode/mcp.json` in your project root
```json
{
  "servers": {
    "mindpm": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mindpm"],
      "env": {
        "MINDPM_DB_PATH": "~/.mindpm/memory.db"
      }
    }
  }
}
```

**Cline** — Add via VS Code settings → Cline → MCP Servers, or edit `cline_mcp_settings.json`:
```json
{
  "mcpServers": {
    "mindpm": {
      "command": "npx",
      "args": ["-y", "mindpm"],
      "env": {
        "MINDPM_DB_PATH": "~/.mindpm/memory.db"
      }
    }
  }
}
```

**Windsurf** — Settings → Cascade → MCP, using the same JSON structure as Cline above.

### Using mindpm with any LLM

On first run, mindpm writes `~/.mindpm/AGENT.md` — a ready-to-paste system prompt that tells your LLM how to use mindpm proactively. Paste its contents into your client's custom instructions or system prompt box.

You can also call the `get_agent_instructions` tool at any time to retrieve the instructions.

### Start Using

That's it. The LLM now has access to mindpm tools. Just start talking about your projects.

## MCP Tools

### Projects
| Tool | Description |
|------|-------------|
| `create_project` | Create a new project |
| `list_projects` | List all projects |
| `get_project_status` | Full project overview |
| `set_project_repo_path` | Set/update the project's local git repo path (enables the session brief's git delta) |

### Tasks
| Tool | Description |
|------|-------------|
| `create_task` | Add a task |
| `update_task` | Update status, priority, etc. |
| `list_tasks` | List with filters |
| `get_task` | Full task detail with sub-tasks and notes |
| `get_next_tasks` | Smart: highest priority, unblocked |

### Decisions
| Tool | Description |
|------|-------------|
| `log_decision` | Record a decision with reasoning |
| `list_decisions` | Browse decision history |

### Notes & Context
| Tool | Description |
|------|-------------|
| `add_note` | Add a note (architecture, bug, idea, etc.) |
| `search_notes` | Full-text search |
| `set_context` | Store key-value context |
| `get_context` | Retrieve context |

### Sessions
| Tool | Description |
|------|-------------|
| `start_session` | Get full project context + last session's next steps + session brief |
| `end_session` | Record summary + what to do next time |
| `get_session_brief` | Read-only: what changed since the last session ended, without opening a session |

### Query
| Tool | Description |
|------|-------------|
| `query` | Read-only SQL against the database |
| `get_project_summary` | Tasks by status, blockers, recent activity |
| `get_blockers` | All blocked tasks with what's blocking them |
| `search` | Full-text search across everything |

## How It Works

```
┌─────────────┐     MCP      ┌─────────┐     SQLite     ┌──────────┐
│  Claude Code │ ◄──────────► │ mindpm  │ ◄────────────► │ memory.db│
│  / Desktop   │   tools      │ server  │   read/write   │          │
└─────────────┘               └─────────┘                └──────────┘
```

1. You start a conversation and mention your project
2. The LLM calls `start_session` → gets full context
3. During the conversation, it creates tasks, logs decisions, adds notes
4. When you're done, it calls `end_session` → saves what's next
5. Next conversation: instant context, zero re-explanation

## Storage

Default: `~/.mindpm/memory.db`

Override with `MINDPM_DB_PATH` or `PROJECT_MEMORY_DB_PATH` environment variable.

Database and tables are created automatically on first run.

## Development

```bash
npm install
npm run build       # Build with tsup
npm run typecheck   # Type-check without emitting
npm run dev         # Build in watch mode
```

## License

MIT
