# Session brief

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

[← Documentation](README.md)
