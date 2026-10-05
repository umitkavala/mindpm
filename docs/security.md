# Security model

mindpm runs on your machine with no user accounts. Within that:

- **Verifiers are authenticated.** Only a request carrying a verifier key can move work to `verified`, and only for the commit that was submitted. Keys are issued in the UI and stored as hashes.
- **The UI is guarded against the network and other websites**, as described under [Kanban board: network and WSL](kanban-board.md#network-and-wsl): loopback only, allowed host names, a matching `Origin` and a per-start token for writes.
- **Everything else is declared, not proven.** `human:<name>`, `agent:architect` and the other actor ids are whatever the caller says they are.

**It does not stop a process on your own machine.** An agent with a shell can read the board page, take its token and call the UI's routes as `human:ui`, which includes accepting medium and high risk work. It can also read a verifier key from any environment or file it can see, or write to the SQLite file directly. mindpm can't tell those apart from you. Keeping executors away from `localhost:3131`, the verifier key variables and `~/.mindpm/` is the job of your agent's sandbox: Claude Code deny rules for executors are planned for Phase 3. Until then, run executor agents where they can't reach those, and treat a clean verification run as strong evidence, not proof.

[← Documentation](README.md)
