# Changelog

## 2.0.0

Phase 1 of agent execution: a task can be run by an agent with no conversation context, parallel agents never collide, and every attempt leaves a memory for the next one.

### Breaking

- Task statuses are now handoff states: `backlog`, `ready`, `claimed`, `blocked`, `needs_verification`, `needs_human`, `done`, `cancelled` (`verified` is reserved). The migration maps `todo` and `in_progress` to `ready` and `in_review` to `needs_verification`. Old `in_progress` work has no claim, so it returns to the queue.
- Setting status through `update_task` or the Kanban board requires a human actor (`actor: "human:<name>"`; the board counts as `human:ui`) and a legal transition. Agents get `illegal_transition`. An agent asked by a human to make a change passes its own id with `on_behalf_of: "human:<name>"`. Old status names are still accepted by `update_task` for this release, with a deprecation warning.
- The session brief's `in_progress_now` is renamed `claimed_now`.
- `get_next_tasks` and the session brief's suggestions now list `ready` and `claimed` tasks.

### Added

- Specs with acceptance criteria and risk levels: `create_spec`, `update_spec`, `approve_spec`, `supersede_spec`, `get_spec`. Approval writes `specs/SPEC-<n>.md` into the repo after the database commits.
- Executor protocol: `pick_task`, `claim_task`, `get_task_brief`, `heartbeat`, `submit_task`, `report_failure`, `escalate`, `release_task`. Claims are atomic, leased and fenced by a claim token.
- Human and reviewer gates: `review_task`, `resolve_needs_human`.
- `set_execution_defaults` and new `create_project` parameters for coding conventions and verification commands.
- `create_task` takes `spec_id`, `criteria`, `verification`, `branch` and `blocked_by`. `update_task` takes `verification`, `branch`, `criteria` and `actor`. `log_decision` takes `spec_id` and `supersedes`.
- `on_behalf_of` on `update_task`, `review_task`, `resolve_needs_human`, `approve_spec`, `update_spec` and `supersede_spec`: an agent acting on a human's explicit request gets that human's permissions, and history records both (`task_history.on_behalf_of`). It is refused on a task the agent holds a claim on or submitted, and on a spec it wrote.
- A task reaching done moves blocked tasks whose blockers are all done to ready.
- `search` covers spec text and attempt root causes.
- `get_agent_instructions` describes the architect, executor and review protocol.

### Notes

- The migration rebuilds the `tasks` table in one transaction and is additive everywhere else. Task history keeps its original status names.
- Actor ids are declared, not authenticated. mindpm is local-only, and anything reaching the HTTP port is treated as a human.
- On first start, the server copies the database to `<db>.pre-2.0.0` (a consistent `VACUUM INTO` snapshot) before migrating. If the copy fails, the migration doesn't run.
- `~/.mindpm/AGENT.md` now starts with a version line and is rewritten when the instructions change. The previous copy is kept as `AGENT.md.bak-<version>` (`.bak-pre-2.0.0` for unversioned files).
- Write transactions that read before they write now take the write lock up front (`BEGIN IMMEDIATE`), so concurrent agents wait on `busy_timeout` instead of failing with `database is locked`. This also fixes a race where two concurrent `create_task` calls could get the same sequence number.
- Delivery metrics only look at `done` and `blocked`, which didn't change, so lead time and flow efficiency read the same on both sides of the migration.

## 1.4.0

### Added

- **Session Brief**: `start_session` now embeds a `brief` field (a deterministic delta between the end of the previous session and now) — commits landed, branch moved, working-tree/dirty state, tasks that changed status, new blockers, decisions logged, and a note count. Pass `brief: false` to skip it.
- New read-only `get_session_brief(project)` tool for fetching the brief without opening a session.
- New `set_project_repo_path(project, repo_path)` tool. `create_project` now validates `repo_path` (must exist, be a directory, and contain `.git`) instead of accepting anything.
- `sessions` gains `ended_at`, `end_git_sha`, and `end_git_branch` columns; `end_session` captures HEAD's sha/branch for the configured repo (or leaves them null — this never fails `end_session`).
- `get_agent_instructions` now tells calling agents to read the brief first and to re-verify context with `get_project_status` when `brief.gap.label` is `"stale"` (last session ended over 14 days ago).

### Notes

- The git delta is anchored on the exact commit sha recorded when the prior session ended, not a timestamp, so it survives rebases/amends. If that sha becomes unreachable (force-push, rebase, prune), the brief falls back to a timestamp anchor and reports it in `degraded_reasons`.
- All git access is read-only local subprocess calls (no `fetch`/`pull`/`push`/`clone`) with a 2s timeout; a broken or missing repo degrades the brief (`git.available: false`, `degraded: true`) rather than failing `start_session`.
- Existing projects/sessions are unaffected: the schema migration is additive-only, and a project with no `repo_path` behaves exactly as before, plus the task/blocker/decision delta.

## Earlier versions

Not tracked in this file. See git history.
