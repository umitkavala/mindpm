# Setup

## Install

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

## Configure your MCP client

All clients use the same JSON format — just different config file locations. They all share the same `~/.mindpm/memory.db`, so you can switch tools mid-project without losing context.

**Claude Code** — one command:
```bash
claude mcp add mindpm -e MINDPM_DB_PATH=~/.mindpm/memory.db -- npx -y mindpm
```

**Claude Desktop** — `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`)
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

## Using mindpm with any LLM

On first run, mindpm writes `~/.mindpm/AGENT.md` — a ready-to-paste system prompt that tells your LLM how to use mindpm proactively. Paste its contents into your client's custom instructions or system prompt box.

You can also call the `get_agent_instructions` tool at any time to retrieve the instructions.

## Start Using

That's it. The LLM now has access to mindpm tools. Just start talking about your projects.

## Storage

Default: `~/.mindpm/memory.db`

Override with `MINDPM_DB_PATH` or `PROJECT_MEMORY_DB_PATH` environment variable.

Database and tables are created automatically on first run. Before a migration changes an existing database, the server saves a copy next to it: `<db>.pre-2.0.0` before the 2.0.0 tasks-table rebuild, `<db>.pre-3.0.0` before the 3.0.0 verification tables, `<db>.pre-3.1.0` before the 3.1.0 per-project verification setting. An existing backup is never overwritten.

Verifier keys are stored only as SHA-256 hashes.

[← Documentation](index.md)
