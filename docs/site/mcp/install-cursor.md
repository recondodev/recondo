# Recondo MCP — Cursor Installation

This guide walks you through registering the Recondo MCP with Cursor so your editor agent can query captured LLM traffic, session history, and analytics.

## Prerequisites

- Cursor installed and working (v0.10+)
- Recondo MCP service running (typically at `http://localhost:4001/mcp` in fullstack)
- Bearer token (if connecting to production; dev mode does not require one)

## Step 1: Generate the Config Snippet

In your terminal, run:

```bash
recondo-mcp config cursor
```

This outputs a JSON object ready to merge into Cursor's MCP server config. For example:

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
recondo-mcp config cursor --scoped <project_id>
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

## Step 2: Update Cursor's MCP Config

Cursor stores MCP server registrations in `~/.cursor/mcp.json`. If this file does not exist, create it. Otherwise, merge the snippet from Step 1 into the existing `mcpServers` object.

### Option A: If `mcp.json` Doesn't Exist

```bash
# Create the directory if needed
mkdir -p ~/.cursor

# Create the config file
cat > ~/.cursor/mcp.json << 'EOF'
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

### Option B: If `mcp.json` Already Exists

Open `~/.cursor/mcp.json` in your editor and add the `recondo` entry under the `mcpServers` object:

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

Ensure the JSON is valid (`jq . ~/.cursor/mcp.json` should parse without error).

## Step 3: Restart Cursor

Fully restart Cursor (close all windows and reopen). The editor will discover and load all MCP servers from `mcp.json` on startup.

## Verifying the Installation

Once Cursor restarts, test the MCP connection:

1. **Open the MCP debug panel** — In Cursor, open **Settings → Extensions → Model Context Protocol**. You should see `recondo` listed under available servers.

2. **Request a tool** — In a chat or command context, ask Cursor to query your sessions:
   ```
   Show me a summary of sessions from today using Recondo.
   ```

   Cursor should invoke one of the Recondo tools (e.g., `recondo_list_sessions`) and display the results.

3. **Check MCP debug logs** — The MCP debug panel will show the tool calls and responses. Confirm that `recondo_list_sessions` or similar tools are being invoked.

If the tool call fails, check:
- The MCP service is running and accessible on `http://localhost:4001/mcp`
- The `url` in `mcp.json` matches where your MCP is listening
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

These flags gate the availability of action tools in the MCP tool list. Cursor will not see or invoke action tools unless the service has started with the corresponding flags. This is a startup configuration, not a per-request override.

Restart Cursor after restarting the MCP service with new flags.

## Prompt Injection Protection

All captured content returned by the MCP is wrapped in XML delimiters to prevent prompt injection. If you ask Cursor to analyze a captured prompt or response, the MCP structures its output with explicit metadata:

```
<captured_content role="user" session_id="abc123" turn_id="1">
What is 2 + 2?
</captured_content>
```

The role and turn metadata are explicit in the XML, preventing confusion even if the captured content contains malicious payloads.

## Troubleshooting

### MCP server doesn't appear in debug panel

- Verify `mcp.json` exists at `~/.cursor/mcp.json`
- Check the JSON is valid (`jq . ~/.cursor/mcp.json`)
- Fully restart Cursor (not just reload)
- Check Cursor's error logs for parsing errors

### "Session not found" or 404 errors

Ensure the MCP service is running and reachable:

```bash
curl -s http://localhost:4001/mcp/health || echo "MCP is not responding"
```

If the service is not responding, start it:

```bash
just fullstack  # or: cd mcp && pnpm dev
```

### Bearer token rejected

If using `--scoped`, verify:
- The token was generated with the correct `project_id`
- The `Authorization` header format is exactly `Bearer wrt_...` (case-sensitive)
- The token has not expired

### Tools not appearing in MCP panel

- Restart Cursor completely (not a reload)
- Re-run `recondo-mcp config cursor` to regenerate the config
- Ensure the `recondo` entry is directly under the `mcpServers` object
- Check that `url` points to a running MCP service

## Next Steps

- For authentication details and production setups, see [auth-modes.md](./auth-modes.md)
- For a list of all available tools, see the tool catalog (coming in Task 6)
- For the full Recondo quickstart, see [quickstart.md](../quickstart.md)
