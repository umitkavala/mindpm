# MCP tools

## Projects

| Tool | Description |
|------|-------------|
| `create_project` | Create a new project |
| `list_projects` | List all projects |
| `get_project_status` | Full project overview |
| `set_project_repo_path` | Set/update the project's local git repo path (enables the session brief's git delta) |
| `set_execution_defaults` | Coding conventions and verification commands included in every task brief |

## Tasks

| Tool | Description |
|------|-------------|
| `create_task` | Add a task, optionally linked to a spec and its criteria |
| `update_task` | Update fields; status changes need a human actor |
| `list_tasks` | List with filters |
| `get_task` | Full task detail with sub-tasks, notes, criteria and attempts |
| `get_next_tasks` | Planning view: highest priority ready or claimed tasks |

## Specs

| Tool | Description |
|------|-------------|
| `create_spec` | Draft a spec with acceptance criteria and a risk level |
| `update_spec` | Edit a spec (optimistic `expected_version`); editing an approved spec bumps its version |
| `approve_spec` | Approve a draft; releases its backlog tasks and writes `specs/SPEC-<n>.md` |
| `supersede_spec` | Replace a spec; cancels its unfinished tasks |
| `get_spec` | Spec, criteria, linked tasks and decisions |

## Executor

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

## Verifier
These require a verifier key. `mindpm verify` uses them through the database directly; a reviewer agent can call them over MCP.

| Tool | Description |
|------|-------------|
| `pending_verifications` | Tasks waiting for a verifier in the projects the key covers and that have verification on, oldest first |
| `start_verification` | Open a run on a task's submitted SHA; returns the checks and criteria (local keys) |
| `record_checks` | Record what was executed: command, exit code, duration, output tail, report (local keys) |
| `record_criteria` | Record a result and evidence per criterion (test/command: local keys; review: reviewer keys) |
| `finish_verification` | End the run; the server computes passed or failed, or records an error |

## Review

| Tool | Description |
|------|-------------|
| `accept_tasks` | Move low-risk verified tasks (or submitted ones, with verification off) to done, when a human asked (`on_behalf_of`). Medium and high risk are refused |
| `resolve_needs_human` | Requeue, cancel, send the spec back for revision, or hand a stuck submission back to the verifier |
| `review_task` | **Deprecated.** `accept` behaves like `accept_tasks` for one task; `reject` is refused. Removed in the next release |

## Decisions

| Tool | Description |
|------|-------------|
| `log_decision` | Record a decision with reasoning, optionally linked to a spec or superseding an older one |
| `list_decisions` | Browse decision history |

## Notes & Context

| Tool | Description |
|------|-------------|
| `add_note` | Add a note (architecture, bug, idea, etc.) |
| `search_notes` | Full-text search |
| `set_context` | Store key-value context |
| `get_context` | Retrieve context |

## Sessions

| Tool | Description |
|------|-------------|
| `start_session` | Get full project context + last session's next steps + session brief |
| `end_session` | Record summary + what to do next time |
| `get_session_brief` | Read-only: what changed since the last session ended, without opening a session |

## Query

| Tool | Description |
|------|-------------|
| `query` | Read-only SQL against the database |
| `get_project_summary` | Tasks by status, blockers, recent activity |
| `get_blockers` | All blocked tasks with what's blocking them |
| `search` | Full-text search across tasks, notes, decisions, specs and attempt root causes |
