# Changelog

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
