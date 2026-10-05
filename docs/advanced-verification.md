# Advanced: unattended agents and verification

Verification is optional. It is off for every project by default, and for good reason: while you watch your agents work and review what they submit, a verifier adds setup without catching much. Turn it on when agents run unattended, for example overnight or from a runner, and nobody reads a submission before it lands.

## Off and on

Each project has a **Verification** switch at the top of the Kanban UI's **Verifiers** tab. Only the UI can change it, so an agent can't switch off its own checks.

- **Off** (the default): `submit_task` moves the task to `needs_verification`, as always. You review it there and either **Accept** it (straight to `done`) or **Reopen** it with findings, which sends it back to `ready` and uses an attempt. Low-risk work can be accepted in a batch on the board, or from chat with `accept_tasks` when you ask; medium and high risk only in the UI. An agent still can't accept work it submitted. `verified` is not used and verifiers get no work from the project.
- **On**: a verifier must rebuild and test every submission first, as described below. Accepting straight from `needs_verification` is refused; you accept from `verified`.

To turn it on, the project needs a `local` verifier key that covers it and a saved verifier config with at least one check. The tab tells you what is missing. If you later revoke the last key, verification stays on and the tab shows a warning; submitted work waits until you register a new key or turn verification off.

Switching with work in flight:

- **Off → on**: tasks already in `needs_verification` wait for the verifier.
- **On → off**: tasks in `needs_verification` can be accepted directly; tasks already `verified` stay acceptable. A run a verifier had in progress on a task you accept or reopen is marked superseded.

Both switches are recorded in `project_history` with who made them. Executor agents work the same way in both modes: after `submit_task`, they stop.

## How a verification run works

Done means independently verified. A **verifier** reruns a task's checks itself, from a clean checkout of the submitted commit, and records evidence for every acceptance criterion. The server, not the verifier, decides the outcome: a run passes only if every check exited 0 and every criterion has positive evidence. A skipped, missing or ambiguous test counts as not passed.

- **Passed**: the task moves to `verified` and waits for a human to accept it.
- **Failed**: the task returns to `ready`, the attempt is used, and the findings (failing checks, the first failing check's output, each failing criterion with its evidence) go into the next executor's brief. If the executor had reported a criterion as passing that the verifier found failing, the attempt is flagged `self_report_mismatch`.
- **Error** (the check broke, not the code: checkout failed, a check timed out, no report configured): the task stays in `needs_verification` and no attempt is used. After three errors in a row it goes to `needs_human`; once the verifier is fixed, resolve it with `reverify`.

## Setting it up

**Registering a verifier.** Open the **Verifiers** tab in the Kanban UI and register one. Only the UI can do this, so an agent can't mint its own key. The key is shown once; mindpm stores only its hash. There are two kinds:

- `local`: starts runs, records check results and test or command criteria, finishes runs. Used as `MINDPM_VERIFIER_KEY`.
- `reviewer`: judges `review` criteria only. Used as `MINDPM_REVIEWER_KEY`.

**What the verifier runs is human-owned.** Every command it executes comes from the project's verifier config, which only the Kanban UI can change: the checks, the reviewer command, and nothing else. The project's verification commands (`set_execution_defaults`) and a task's own `verification` are hints for the executor's brief; an agent can edit them, so the verifier never runs them. The brief lists what the verifier will run as `verifier_checks`. A `command` criterion's `verify_ref` is run only when a human approved its spec (a declared `agent:architect` can approve a low-risk spec on its own); otherwise the run ends as an error.

**Keys never go in an agent's environment.** Run the verifier in its own terminal or as a service, not in the shell your coding agent uses. mindpm can't detect a leaked key; revoke it in the Verifiers tab and runs under it end as errors. `mindpm verify` strips both keys from the environment of every check it runs.

**Running it.**

```bash
export MINDPM_VERIFIER_KEY=mpv_...      # local key
export MINDPM_REVIEWER_KEY=mpv_...      # optional, for review criteria
npx mindpm verify                       # poll for work every 30 s
npx mindpm verify --once                # verify everything waiting, then exit
npx mindpm verify --task my-app-12      # one task
npx mindpm verify --project my-app      # one project
```

For each task waiting in `needs_verification` it adds a temporary `git worktree` at the submitted SHA (never the executor's working tree), confirms `HEAD`, runs the project's verification commands, maps criteria to evidence, runs the reviewer for review criteria, and removes the worktree. It talks to the same database as the MCP server; it is not part of it.

## Verification config

Edited in the Verifiers tab only. It names every check the verifier runs, where each writes its test report, and the reviewer. **Start from project commands** copies the project's verification commands in for you to review first.

```json
{
  "check_timeout_minutes": 15,
  "checks": {
    "build": { "command": "npm run build" },
    "unit": { "command": "npm test -- --reporter=junit --outputFile=reports/junit.xml",
              "report": { "path": "reports/junit.xml", "format": "junit" } },
    "e2e": { "command": "npm run e2e", "report": { "path": "reports/e2e.json", "format": "json" }, "timeout_minutes": 30 }
  },
  "reviewer": { "command": "claude -p", "base_branch": "main" }
}
```

- **Timeout**: 15 minutes per check by default. A timeout is an error, not a failure.
- **Reports**: JUnit XML (dotnet, Java/surefire, pytest, vitest and jest with a JUnit reporter) or a simple JSON format for runners without JUnit output. A `test` criterion's `verify_ref` is matched against `classname.name`, then `name` alone. A task with test criteria and no configured report ends as an error.

  ```json
  {
    "tests": [
      { "id": "InactivityTimeoutTests.ClosesAfterThirtyMinutes", "status": "passed", "duration_ms": 412 },
      { "id": "InactivityTimeoutTests.SkipsActiveHandling", "status": "failed", "message": "Expected Open, got Closed" }
    ]
  }
  ```

  `status` is `passed`, `failed` or `skipped`; `duration_ms` and `message` are optional.
- **`command` criteria**: `verify_ref` runs in the checkout; exit 0 passes.
- **Reviewer**: for `review` criteria, `reviewer.command` (default `claude -p`) gets a fixed prompt with the spec, the criteria and the diff against `base_branch` on stdin, and must answer `{"results":[{"criterion":"AC-12.3","result":"pass","rationale":"..."}]}`. A pass without a rationale counts as missing.

[← Documentation](README.md)
