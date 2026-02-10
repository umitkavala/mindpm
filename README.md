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

### Configure with Claude Code

Add to your MCP config (`~/.claude/claude_desktop_config.json` or similar):

```json
{
  "mcpServers": {
    "mindpm": {
      "command": "mindpm",
      "env": {
        "MINDPM_DB_PATH": "~/.mindpm/memory.db"
      }
    }
  }
}
```

If running from source, use the built file directly:

```json
{
  "mcpServers": {
    "mindpm": {
      "command": "node",
      "args": ["/path/to/mindpm/dist/index.js"],
      "env": {
        "MINDPM_DB_PATH": "~/.mindpm/memory.db"
      }
    }
  }
}
```

### Start Using

That's it. The LLM now has access to mindpm tools. Just start talking about your projects.

## MCP Tools

### Projects
| Tool | Description |
|------|-------------|
| `create_project` | Create a new project |
| `list_projects` | List all projects |
| `get_project_status` | Full project overview |

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
| `start_session` | Get full project context + last session's next steps |
| `end_session` | Record summary + what to do next time |

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
