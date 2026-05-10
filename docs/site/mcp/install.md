# Recondo MCP — Installation Overview

The Recondo MCP (Model Context Protocol) server is a long-running remote Streamable HTTP service that exposes your captured LLM traffic as MCP tools—allowing agents (Claude Code, Cursor, Goose, and others) to query sessions, turns, costs, agent activity, compliance data, and more. The service runs at `http://localhost:4001/mcp` in fullstack development.

## What Is the MCP?

Recondo's MCP is a **peer transport**, not a wrapper over the API. It imports the `recondo-data` library directly and exposes its operations—query reads and governance mutations—as MCP tools. This architecture means:

- **Independent from GraphQL** — the MCP doesn't make HTTP calls to the GraphQL API; it accesses the database and object store in-process
- **Agent-native** — agents register the MCP service once and gain access to structured tools like `recondo_list_sessions`, `recondo_get_turn`, `recondo_search`, etc.
- **Cross-client** — the same MCP service works with Claude Code, Cursor, Goose, and any other MCP-capable agent

For the full architecture story, see [architecture.md](../architecture.md).

## Starting the MCP Service

In fullstack development, start the complete stack (gateway, API, dashboard, and MCP) in one command:

```bash
just fullstack
```

This spins up all containers, including the MCP service on port 4001. The service logs will show `MCP server listening on http://0.0.0.0:4001/mcp` (exposed to your host as `http://localhost:4001/mcp`).

If you already have the API running and want to start just the MCP:

```bash
# Terminal 1: Start infrastructure
just dev-infra
# (wait for "PostgreSQL is ready")
just api-migrate

# Terminal 2: Start the MCP service
cd mcp && pnpm dev
```

## Configuring Your Agent

### The `recondo-mcp config` Helper

Instead of writing MCP config by hand, use the built-in helper:

```bash
recondo-mcp config <flavor>
```

This emits a JSON snippet for your chosen agent. Replace `<flavor>` with one of:

- `claude-code` — Claude Code's `~/.claude/mcp_servers.json`
- `cursor` — Cursor's `~/.cursor/mcp.json`
- `goose` — Goose's config file

### Default Mode (No Authentication)

In development, the MCP runs with `RECONDO_DEV_BYPASS=1` and `NODE_ENV=development`, allowing connections without credentials:

```bash
recondo-mcp config claude-code
```

Output:
```json
{
  "mcpServers": {
    "recondo": {
      "type": "streamable-http",
      "url": "http://localhost:4001/mcp",
      "headers": {}
    }
  }
}
```

**Workflow:**

```bash
# 1. Start fullstack (includes MCP on :4001)
just fullstack

# 2. Generate the config snippet
recondo-mcp config claude-code >> ~/.claude/mcp_servers.json

# 3. Restart Claude Code to reload MCP servers
# (or use your agent's reload mechanism)

# 4. Verify: in a Claude Code session, type `/mcp` to see registered servers
```

### Opt-In Key Mode (Production)

In production or when connecting to a remote Recondo instance, pass `--scoped` to mint a bearer token:

```bash
recondo-mcp config claude-code --scoped <project_id>
```

This mints a scoped API key and emits it in the `Authorization: Bearer` header:

```json
{
  "mcpServers": {
    "recondo": {
      "type": "streamable-http",
      "url": "https://recondo.example.com/mcp",
      "headers": {
        "Authorization": "Bearer wrt_..."
      }
    }
  }
}
```

Replace `https://recondo.example.com/mcp` with your remote Recondo instance URL.

## Per-Client Installation

For step-by-step instructions specific to your agent, see:

- **[Claude Code](./install-claude-code.md)** — `~/.claude/mcp_servers.json` setup and verification
- **[Cursor](./install-cursor.md)** — `~/.cursor/mcp.json` setup and debugging
- **[Goose](./install-goose.md)** — YAML config and Goose-specific verification

## Authentication Modes

The MCP supports two authentication modes:

1. **Dev Bypass** — `RECONDO_DEV_BYPASS=1` with `NODE_ENV=development`. No bearer token required. Used in local fullstack.
2. **Bearer Token** — Clients send `Authorization: Bearer wrt_...` header. The MCP validates the token against the database and enforces project-scoped access.

For a detailed walkthrough, see [auth-modes.md](./auth-modes.md).

## Next Steps

- **Just getting started?** Follow the [quickstart](../quickstart.md) to spin up fullstack and connect Claude Code.
- **Want to enable mutations?** See the [auth-modes.md](./auth-modes.md) section on `--allow-actions` and `--allow-destructive`.
- **Need the full tool reference?** Check the tool catalog (coming in Task 6) for all 25+ read and action tools.
