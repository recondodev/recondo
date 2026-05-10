# Recondo MCP — Claude Code Installation

This guide walks you through registering the Recondo MCP with Claude Code so your agent can query captured LLM traffic, session history, costs, and agent activity.

## Prerequisites

- Claude Code installed and working
- Recondo MCP service running (typically at `http://localhost:4001/mcp` in fullstack)
- Bearer token (if connecting to production; dev mode does not require one)

## Step 1: Generate the Config Snippet

In your terminal, run:

```bash
recondo-mcp config claude-code
```

This outputs a JSON object ready to merge into Claude Code's MCP server config. For example:

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

If you're using a scoped key (production setup), use:

```bash
recondo-mcp config claude-code --scoped <project_id>
```

Output with credentials:

```json
{
  "mcpServers": {
    "recondo": {
      "type": "streamable-http",
      "url": "https://recondo.example.com/mcp",
      "headers": {
        "Authorization": "Bearer wrt_abc123def456..."
      }
    }
  }
}
```

## Step 2: Update Claude Code's MCP Config

Claude Code stores MCP server registrations in `~/.claude/mcp_servers.json`. If this file does not exist, create it. Otherwise, merge the snippet from Step 1 into the existing `mcpServers` object.

### Option A: If `mcp_servers.json` Doesn't Exist

```bash
# Create the file
mkdir -p ~/.claude
cat > ~/.claude/mcp_servers.json << 'EOF'
{
  "mcpServers": {
    "recondo": {
      "type": "streamable-http",
      "url": "http://localhost:4001/mcp",
      "headers": {}
    }
  }
}
EOF
```

### Option B: If `mcp_servers.json` Already Exists

Open `~/.claude/mcp_servers.json` in your editor and add the `recondo` entry under the `mcpServers` object:

```json
{
  "mcpServers": {
    "recondo": {
      "type": "streamable-http",
      "url": "http://localhost:4001/mcp",
      "headers": {}
    },
    "other-server": { ... }
  }
}
```

Ensure the JSON is valid (`jq . ~/.claude/mcp_servers.json` should parse without error).

## Step 3: Restart Claude Code

Restart your Claude Code session (or reload if supported by your editor extension):

```bash
claude
```

The agent will discover and load all MCP servers from `mcp_servers.json` on startup.

## Verifying the Installation

Once Claude Code restarts, test the MCP connection:

1. **In Claude Code, type `/mcp`** — This lists all registered MCP servers. You should see `recondo` in the output.

2. **Ask Claude Code a question about your sessions:**
   ```
   What sessions did I run today?
   ```

   Claude Code should invoke the `recondo_list_sessions` tool and return your captured sessions.

3. **Confirm tool invocation** — Check the Claude Code logs or verbose output to confirm the tool was called and returned data.

If the tool call fails, check:
- The MCP service is running and accessible on `http://localhost:4001/mcp`
- The `url` in `mcp_servers.json` matches where your MCP is listening
- Bearer token (if used) is valid and correctly formatted in the `Authorization` header

## Advanced: Enabling Actions

By default, the MCP exposes read tools only. To enable mutations (create, update, delete operations), start the MCP with `--allow-actions`:

```bash
cd mcp && pnpm dev -- --allow-actions
```

To further enable destructive operations (like deleting captures), add `--allow-destructive`:

```bash
cd mcp && pnpm dev -- --allow-actions --allow-destructive
```

**Warning:** Destructive actions are permanent. Enable only in development or with explicit user intent.

These flags gate the availability of action tools in the MCP tool list. Claude Code will not see or invoke action tools unless the service has started with the corresponding flags. This is a startup configuration, not a per-request override.

## Prompt Injection Protection

All captured content returned by the MCP is wrapped in XML delimiters to prevent prompt injection. If you ask Claude Code to analyze a captured prompt or response, the MCP structures its output like:

```
<captured_content role="user" session_id="abc123" turn_id="1">
What is 2 + 2?
</captured_content>
```

The role and turn metadata are explicit in the XML, preventing confusion even if the captured content contains malicious payloads. This is a load-bearing security measure; do not disable it.

## Troubleshooting

### "Session not found" or 404 errors

Ensure the MCP service is running and reachable. If using `http://localhost:4001/mcp`, check:

```bash
curl -s http://localhost:4001/mcp/health || echo "MCP is not responding"
```

### Bearer token rejected

If using `--scoped`, verify:
- The token was generated with the correct `project_id`
- The `Authorization` header format is exactly `Bearer wrt_...` (case-sensitive)
- The token has not expired

### Tools not appearing in `/mcp` output

- Restart Claude Code (the agent caches the server list on startup)
- Check that `mcp_servers.json` is valid JSON (`jq . ~/.claude/mcp_servers.json`)
- Ensure the `recondo` entry is directly under the `mcpServers` object

## Next Steps

- For authentication details and production setups, see [auth-modes.md](./auth-modes.md)
- For a list of all available tools, see the tool catalog (coming in Task 6)
- For the full Recondo quickstart, see [quickstart.md](../quickstart.md)
