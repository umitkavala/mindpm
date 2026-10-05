# Development

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

[← Documentation](README.md)
