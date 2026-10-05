# Changelog

## Unreleased

Fixes from a dry run of the agent workflow on a small demo project.

### Security

- An executor could accept its own low-risk work by calling `accept_tasks` as `human:<name>`, or under another agent id with `on_behalf_of`: the checks only compared declared actor ids. `submit_task` now records the connection (MCP client process) it came from, and that connection can't accept or move the submission under any actor. The Kanban UI and other sessions can.

### Fixed

- `test` criteria can name a test group. `verify_ref` is matched against `classname.name`, then as a path through the report's nested `<testsuite>` groups (`slugify`, `slugify > keeps digits`), outer groups optional. A group passes when at least one of its tests ran and none failed, and fails when all were skipped. With Node's built-in runner, which puts `describe()` names only on the enclosing `<testsuite>`, no criterion could match a group before, so verification failed although every test passed.
- A ref that matches a group and a test, or the same group in two files, is reported as ambiguous with every candidate.

### Added

- The executor brief explains how `verify_ref` is matched (`test_ref_rule`) when the task has test criteria.
- `create_task` and `update_task` warn when a `test` or `command` criterion is also on another open task: each task is verified on its own commit, so a shared one fails whichever is verified first.
- Docs: Node's built-in test runner (`node --test --test-reporter=junit`) is a supported reporter.

### Notes

- The migration adds a nullable `attempts.submitted_from` column. The server first copies the database to `<db>.pre-3.2.0`. Submissions from before the upgrade keep the actor checks only.

## 3.1.2

### Fixed

- Kanban: columns with more tasks than fit on screen now scroll. In the grouped view a lane grew past the window with no scrollbar, and in the all-statuses view the columns' bottoms were cut off, so the overflowing tasks couldn't be reached.

### Docs

- The documentation site is built with MkDocs Material, and its diagrams are Mermaid instead of ASCII art.

## 3.1.1

Documentation only; no code changes.

- The README is now a short overview with a one-command quick start. Everything else moved into a documentation site at https://umitkavala.github.io/mindpm/, served by GitHub Pages from `docs/`.
- Setup docs: the Claude Code config path was wrong (`~/.claude/claude_desktop_config.json`). Claude Code now uses `claude mcp add`, and Claude Desktop's real config locations are listed.
- `package.json` `homepage` points to the documentation site.

## 3.1.0

Verification is opt-in per project, and off by default. While a human reviews every submission, the gate adds setup without catching much; it stays fully intact for agents that run unattended.

### Changed

- New per-project setting `verification`, `off` (default) or `on`, changed only in the Kanban UI's Verifiers tab. No MCP tool can change it.
- **Off**: a human accepts submitted work straight from `needs_verification` to `done`, under the same rules as verified work: low risk in a batch on the board or with `accept_tasks` and `on_behalf_of`, medium and high risk in the UI only. An agent still can't accept work it submitted. **Reopen** with findings sends it back to `ready` and uses an attempt (UI only). `pending_verifications` returns nothing for the project and `start_verification` is refused.
- **On**: exactly the 3.0 behaviour. Turning it on requires a `local` verifier key that covers the project and a saved verifier config with at least one check. Revoking the last key leaves it on, and the tab shows a warning.
- Switching: off → on, tasks already in `needs_verification` wait for the verifier; on → off, they can be accepted directly and `verified` tasks stay acceptable. A run in progress on a task accepted or reopened directly is superseded.
- Session brief `awaiting_acceptance` includes submitted tasks when verification is off. The task brief has `verifier_checks` only when it is on.
- Kanban: with verification off, Review lane cards in `needs_verification` show Accept and Reopen, and the batch counts low-risk ones. The task modal shows the executor's self-reported criteria instead of a verifier run.
- The README's verification guide moved to [docs/advanced-verification.md](docs/advanced-verification.md).

### Added

- `GET` and `PUT /api/projects/:id/verification`, and a `project_history` table recording each switch with its actor.
- `npm run preview`: builds, copies your database to a temporary file and serves the UI on port 3132, with no MCP client attached.

### Notes

- Migration: projects that an active `local` verifier key covers (directly or with `*`) are set to `on`, all others to `off`. The server first copies the database to `<db>.pre-3.1.0`.
- Agent instructions are now version 3.1.0; `AGENT.md` is rewritten on start.

## 3.0.0

Phase 2, the verification gate: done now means independently verified. A registered verifier reruns the checks itself from a clean checkout of the submitted commit, and a human accepts every task into done.

### Breaking

- Only a verifier can move a task to `verified`, and only from a passing run. `needs_verification → done` is gone, except for legacy tasks with no submitted commit, which the Kanban UI can accept directly.
- `verified → done`: medium and high risk only through the Kanban UI. Low risk also through the new `accept_tasks` with `on_behalf_of`. `update_task` can't set `verified` or `done` for submitted work, and an MCP caller declaring `human:ui` is not the UI.
- `review_task` is deprecated: `accept` behaves like `accept_tasks` for one task (verified, low risk), `reject` returns `deprecated`. `agent:reviewer` can no longer accept anything. It will be removed in the next release.
- A failed verification uses an attempt; findings go into the next brief. A verifier error does not.

### Added

- Verifier keys: registered and revoked in the new Verifiers tab, shown once, stored as SHA-256 hashes. Kinds `local` and `reviewer`, scoped to projects. Actor `verifier:<name>`, recorded in `task_history.verifier_id`.
- Verifier tools: `pending_verifications`, `start_verification`, `record_checks`, `record_criteria`, `finish_verification`. Runs are bound to the submitted `head_sha`, leased for 30 minutes (extended by every record call), and the server computes the outcome.
- `mindpm verify` (`--once`, `--task`, `--project`, `--interval`): the local verifier. Checks out the submitted SHA in a temporary git worktree, runs the verification commands with a 15-minute timeout, reads JUnit XML or a simple JSON report, runs `command` criteria, and asks a reviewer command (default `claude -p`) to judge `review` criteria. Verifier keys are stripped from every child process.
- Per-project verifier config, editable in the UI only. It holds every command the verifier runs: the checks, their report paths and formats, timeouts and the reviewer command. `verification_defaults` and a task's `verification` stay as hints for the executor's brief and are never run by the verifier; the brief lists what will run as `verifier_checks`. A `command` criterion is run only when a human approved its spec.
- `accept_tasks` for batches of low-risk verified work. `resolve_needs_human` gains `reverify` for a submission whose verification kept erroring.
- Failed runs write findings into the attempt (failing checks, output tail, failing criteria with evidence) and flag `self_report_mismatch` when the executor claimed a pass. The brief shows them under `previous_attempts[].verification`.
- Session brief `awaiting_acceptance`: verified work waiting for a human, split into low-risk and UI-only, with Kanban links.
- Delivery metrics: first-run pass rate, self-report mismatch rate, median hours from submission to verified, tasks awaiting acceptance.
- `get_task` lists verification runs.
- Kanban redesign: five grouped lanes (Planned, In progress, Review, Needs attention, Done) with status chips, an All statuses toggle, done limited to the last 7 days by default, cancelled hidden by default, empty columns collapsed. Review lane batch accept for low risk, Accept and Reopen on medium and high risk cards, Resolve on needs_human cards. A verification panel in the task modal shows runs, checks, output and criteria evidence. `?task=<key>` opens a task.

### Security

- The Kanban UI listens on `127.0.0.1` by default (it listened on all interfaces before). `MINDPM_HOST` opts in to another interface, `MINDPM_ALLOWED_HOSTS` adds host names. Under WSL2 NAT networking, set `MINDPM_HOST=0.0.0.0` to reach the board from a Windows browser; the server prints a hint when it detects WSL.
- Requests must address an allowed host name (DNS rebinding). Writes need a matching `Origin` and a per-start token embedded in the served page (cross-site requests). The page can't be framed (clickjacking). `MINDPM_UI_TOKEN` pins the token for the Vite dev server.
- A process on the same machine can still read the page's token; see the README's trust model.

### Notes

- The migration is additive: four new tables (`verifiers`, `verification_runs`, `check_results`, `criterion_results`) and nullable columns on `tasks`, `attempts`, `projects` and `task_history`. The server first copies the database to `<db>.pre-3.0.0`.
- Agent instructions are now version 3.0.0; `AGENT.md` is rewritten on start and the old copy kept as `.bak-2.0.0`.

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
