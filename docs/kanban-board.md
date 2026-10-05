# Kanban board

mindpm includes a built-in Kanban UI. When the MCP server starts, it serves a web interface at `http://localhost:3131`.

Every `start_session` call returns a direct link to your project's board:

```
Kanban board: http://localhost:3131?project=<project-id>
```

The port is configurable via the `MINDPM_PORT` environment variable.

By default the board groups statuses into five lanes that fit a laptop screen: **Planned** (backlog, ready), **In progress** (claimed), **Review** (needs_verification, verified), **Needs attention** (needs_human, blocked) and **Done** (last 7 days). Each card shows its exact status as a chip. **All statuses** switches to one column per status, with empty columns collapsed. The Review lane is where you accept submitted work (verified work, when verification is on): low-risk tasks in one batch, medium and high risk one by one, or reopen them with findings. The **Verifiers** tab turns verification on or off for the project and registers and revokes verifier keys. `?task=<key>` in the URL opens that task.

## Network and WSL

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

See [Security model](security.md) for what this does and doesn't protect against.
