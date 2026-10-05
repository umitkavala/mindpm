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

- **Tasks** — handoff status, priority, blockers, sub-tasks
- **Specs** — objective, why, approach, constraints and acceptance criteria an agent can execute against
- **Attempts** — every agent run on a task: outcome, root cause, what to avoid next time
- **Verification runs** — what a verifier executed on a submitted commit (checks, exit codes, test reports) and what it concluded for each acceptance criterion, with evidence
- **Verifiers** — the registered processes allowed to verify work, identified by a secret key stored only as a hash
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

The board writes to your database as `human:ui`, so the port is locked down:

- It listens on `127.0.0.1` only. `MINDPM_HOST` opts in to another interface (`0.0.0.0` for all); the server warns when it listens on all of them. Requests must address an allowed host name (loopback, the `MINDPM_HOST` address, and anything in `MINDPM_ALLOWED_HOSTS`, comma-separated), which stops DNS rebinding.
- Writes need an `Origin` matching the board and a token that changes every time the server starts and is embedded only in the page it serves, so other websites you visit can't post to it. The page refuses to be framed.
- **WSL2:** with the default NAT networking, a Windows browser can't reach a server bound to `127.0.0.1` inside WSL. The better fix is mirrored networking, which makes WSL and Windows share `localhost`, so the default binding works and you don't need `MINDPM_HOST`. Add this to `%UserProfile%\.wslconfig` and run `wsl --shutdown`:

  ```ini
  [wsl2]
  networkingMode=mirrored
  ```

  If you stay on NAT, `MINDPM_HOST=0.0.0.0` also works, because WSL's NAT keeps the port off your LAN unless you add a port proxy. The server prints this hint when it detects WSL.
- **Never combine mirrored mode with `MINDPM_HOST=0.0.0.0`.** In mirrored mode, `0.0.0.0` is your real network interface, so anyone on your LAN can reach the board and act as `human:ui`.

By default the board groups statuses into five lanes that fit a laptop screen: **Planned** (backlog, ready), **In progress** (claimed), **Review** (needs_verification, verified), **Needs attention** (needs_human, blocked) and **Done** (last 7 days). Each card shows its exact status as a chip. **All statuses** switches to one column per status, with empty columns collapsed. The Review lane is where you accept submitted work (verified work, when verification is on): low-risk tasks in one batch, medium and high risk one by one, or reopen them with findings. The **Verifiers** tab turns verification on or off for the project and registers and revokes verifier keys. `?task=<key>` in the URL opens that task.

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
  "notes_since_count": 3,
  "awaiting_acceptance": {
    "low_risk": [{ "task_id": "a1b2c3d4", "key": "my-app-14", "title": "Document the JSON report format", "risk_level": "low", "waiting_hours": 5.2 }],
    "needs_ui": [{ "task_id": "b2c3d4e5", "key": "my-app-12", "title": "Inactivity timeout", "risk_level": "medium", "waiting_hours": 20.1,
                   "kanban_url": "http://localhost:3131?project=<project-id>&task=my-app-12" }],
    "hint": "Show this to the user. ..."
  }
}
```

`awaiting_acceptance` lists work waiting for a human: submitted tasks when the project's verification is off, verified ones when it is on. Agents show it at the start of a session; low-risk tasks can be accepted from chat with `accept_tasks`, medium and high risk only in the Kanban UI.

`gap.label` is `same-day` (<6h), `overnight` (6-20h), `multi-day` (20h-14d), or `stale` (>14d) — a stale gap adds a `gap.hint` telling the agent to re-verify context rather than trust `next_steps` at face value.

The git delta is anchored on the exact commit sha recorded when the prior session ended (via `end_session`), not on a timestamp — sha-based anchoring survives rebases and amends that would break a clock-based diff. If that sha becomes unreachable (force-push, rebase, or the repo was pruned), the brief transparently falls back to a timestamp anchor and reports it in `degraded_reasons`. A broken or missing repo never fails the brief — it just comes back with `git.available: false` and `degraded: true`, while the task/blocker/decision delta is unaffected.

## Agent Execution

mindpm can hand a task to a coding agent that has no conversation context, and keep parallel agents from colliding.

**Lifecycle.** Task statuses are handoffs, enforced by the server:

```
backlog ──approve_spec──► ready ──claim_task──► claimed ──submit_task──► needs_verification ──verifier──► verified ──accept──► done
                                                                                  └──────── accept, when verification is off ───────┘
                            ▲                     │                             │      ▲    │                      │
                            │      report_failure / release_task / lease expiry │      └────┘ run error            │ reopen
                            ├─────────────────────┘          verification failed│      (no attempt used)           │ (UI, findings)
                            └───────────────────────────────────────────────────┴──────────────────────────────────┘
                     blocked ◄── dependency          needs_human ◄── spec_gap, design_conflict, escalate, attempts exhausted, 3 run errors in a row
```

Phases inside a run (implementing, testing, fixing) are heartbeat events, not statuses. Agents can't write status; only a human (`human:<name>`) can, through `update_task` or the Kanban board. An agent that a human explicitly asks to make such a change passes its own id with `on_behalf_of: "human:<name>"`: it gets the human's permissions, history records both, and it is refused on work the agent claimed or submitted itself. When a task reaches done, blocked tasks whose blockers are all done move to ready.

**Specs.** An architect (`agent:architect` or a human) writes a spec with acceptance criteria and a risk level, then links tasks to it. Tasks wait in backlog until the spec is approved. Medium and high risk need a human to approve. Every task is accepted by a human (after a verifier, when the project's verification is on): low-risk work in batches (the board, or `accept_tasks` from chat when you ask), medium and high risk one by one in the Kanban UI. Approval writes `specs/SPEC-<n>.md` into the repo for a human to commit. The database stays the source of truth.

**Claims.** `claim_task` is atomic and returns a claim token plus the task brief. The lease (30 minutes by default, 120 max) is extended by `heartbeat`; an expired lease ends the attempt, counts toward `max_attempts` (3 by default), and returns the task to the queue. Every write after the claim is authorized by the token, so an agent whose lease lapsed can't overwrite a newer attempt.

**Brief.** `get_task_brief` returns the whole contract for one run in under about 2,000 tokens: task, spec, criteria, conventions, verification commands (project defaults, overridden per task), relevant decisions (spec-linked plus the top 5 by full-text rank; superseded decisions never appear), dependencies, and what previous attempts learned.

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

## Accepting work

Work an agent submits waits in `needs_verification` for you. Accept it, or reopen it with findings for the next attempt: low-risk tasks in a batch (the board, or `accept_tasks` from chat when you ask), medium and high risk one by one in the Kanban UI. An agent can never accept its own work.

**Verification (optional, for unattended agents).** Turn it on per project in the **Verifiers** tab, and a registered verifier must rebuild and test each submitted commit in a clean checkout before you can accept it. It is off by default. See [Advanced: unattended agents and verification](docs/advanced-verification.md).

### Trust model: what this does and doesn't stop

mindpm runs on your machine with no user accounts. Within that:

- **Verifiers are authenticated.** Only a request carrying a verifier key can move work to `verified`, and only for the commit that was submitted. Keys are issued in the UI and stored as hashes.
- **The UI is guarded against the network and other websites**, as described under [Kanban Board](#kanban-board): loopback only, allowed host names, a matching `Origin` and a per-start token for writes.
- **Everything else is declared, not proven.** `human:<name>`, `agent:architect` and the other actor ids are whatever the caller says they are.

**It does not stop a process on your own machine.** An agent with a shell can read the board page, take its token and call the UI's routes as `human:ui`, which includes accepting medium and high risk work. It can also read a verifier key from any environment or file it can see, or write to the SQLite file directly. mindpm can't tell those apart from you. Keeping executors away from `localhost:3131`, the verifier key variables and `~/.mindpm/` is the job of your agent's sandbox: Claude Code deny rules for executors are planned for Phase 3. Until then, run executor agents where they can't reach those, and treat a clean verification run as strong evidence, not proof.

## MCP Tools

### Projects
| Tool | Description |
|------|-------------|
| `create_project` | Create a new project |
| `list_projects` | List all projects |
| `get_project_status` | Full project overview |
| `set_project_repo_path` | Set/update the project's local git repo path (enables the session brief's git delta) |
| `set_execution_defaults` | Coding conventions and verification commands included in every task brief |

### Tasks
| Tool | Description |
|------|-------------|
| `create_task` | Add a task, optionally linked to a spec and its criteria |
| `update_task` | Update fields; status changes need a human actor |
| `list_tasks` | List with filters |
| `get_task` | Full task detail with sub-tasks, notes, criteria and attempts |
| `get_next_tasks` | Planning view: highest priority ready or claimed tasks |

### Specs
| Tool | Description |
|------|-------------|
| `create_spec` | Draft a spec with acceptance criteria and a risk level |
| `update_spec` | Edit a spec (optimistic `expected_version`); editing an approved spec bumps its version |
| `approve_spec` | Approve a draft; releases its backlog tasks and writes `specs/SPEC-<n>.md` |
| `supersede_spec` | Replace a spec; cancels its unfinished tasks |
| `get_spec` | Spec, criteria, linked tasks and decisions |

### Executor
| Tool | Description |
|------|-------------|
| `pick_task` | Next workable task: ready, spec approved, blockers done, no live lease |
| `claim_task` | Exclusive claim with a lease; returns the claim token and the brief |
| `get_task_brief` | Everything needed to execute a task, in one read |
| `heartbeat` | Extend the lease, log the phase, learn whether the spec changed |
| `submit_task` | Hand over work with branch, head SHA and a result per criterion |
| `report_failure` | End the attempt with a root cause the next attempt will see |
| `escalate` | Ask a human; doesn't use up an attempt |
| `release_task` | Give the task back; doesn't use up an attempt |

### Verifier
These require a verifier key. `mindpm verify` uses them through the database directly; a reviewer agent can call them over MCP.

| Tool | Description |
|------|-------------|
| `pending_verifications` | Tasks waiting for a verifier in the projects the key covers and that have verification on, oldest first |
| `start_verification` | Open a run on a task's submitted SHA; returns the checks and criteria (local keys) |
| `record_checks` | Record what was executed: command, exit code, duration, output tail, report (local keys) |
| `record_criteria` | Record a result and evidence per criterion (test/command: local keys; review: reviewer keys) |
| `finish_verification` | End the run; the server computes passed or failed, or records an error |

### Review
| Tool | Description |
|------|-------------|
| `accept_tasks` | Move low-risk verified tasks (or submitted ones, with verification off) to done, when a human asked (`on_behalf_of`). Medium and high risk are refused |
| `resolve_needs_human` | Requeue, cancel, send the spec back for revision, or hand a stuck submission back to the verifier |
| `review_task` | **Deprecated.** `accept` behaves like `accept_tasks` for one task; `reject` is refused. Removed in the next release |

### Decisions
| Tool | Description |
|------|-------------|
| `log_decision` | Record a decision with reasoning, optionally linked to a spec or superseding an older one |
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
| `search` | Full-text search across tasks, notes, decisions, specs and attempt root causes |

## How It Works

```
┌─────────────┐     MCP      ┌─────────┐     SQLite     ┌──────────┐
│  Claude Code │ ◄──────────► │ mindpm  │ ◄────────────► │ memory.db│
│  / Desktop   │   tools      │ server  │   read/write   │          │
└─────────────┘               └─────────┘                └──────────┘
                                                               ▲
┌──────────────────────────┐   verifier key, read/write        │
│ mindpm verify            │ ──────────────────────────────────┘
│ (own terminal / service) │ ── git worktree at head_sha, runs checks
└──────────────────────────┘
```

1. You start a conversation and mention your project
2. The LLM calls `start_session` → gets full context
3. During the conversation, it creates tasks, logs decisions, adds notes
4. When you're done, it calls `end_session` → saves what's next
5. Next conversation: instant context, zero re-explanation

## Storage

Default: `~/.mindpm/memory.db`

Override with `MINDPM_DB_PATH` or `PROJECT_MEMORY_DB_PATH` environment variable.

Database and tables are created automatically on first run. Before a migration changes an existing database, the server saves a copy next to it: `<db>.pre-2.0.0` before the 2.0.0 tasks-table rebuild, `<db>.pre-3.0.0` before the 3.0.0 verification tables, `<db>.pre-3.1.0` before the 3.1.0 per-project verification setting. An existing backup is never overwritten.

Verifier keys are stored only as SHA-256 hashes.

## Development

```bash
npm install
npm run build       # Build with tsup
npm run typecheck   # Type-check without emitting
npm run dev         # Build in watch mode
npm run preview     # Build, then serve the UI on :3132 from a temporary copy of your database
```

`npm run preview` copies `MINDPM_DB_PATH` (or `~/.mindpm/memory.db`, or a path given after `--`) with its WAL into a temporary directory, migrates and serves that copy with no MCP client attached, and deletes it on exit. Your real database is only read. `--no-build` skips the build; `MINDPM_PREVIEW_PORT` changes the port.

UI development with the Vite dev server: the page Vite serves doesn't carry the server's token, so pin one on both sides.

```bash
export MINDPM_UI_TOKEN=dev-$(openssl rand -hex 16)
node dist/index.js        # in one terminal (keep stdin open, e.g. under your MCP client)
npm run dev:ui            # in another; its proxy sends the token and the server's origin
```

## License

MIT
