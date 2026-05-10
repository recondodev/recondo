# Recondo MCP — Goose Installation

This guide walks you through registering the Recondo MCP with Goose so the agent can query captured LLM traffic, session history, and analytics.

## Prerequisites

- Goose installed and working
- Recondo MCP service running (typically at `http://localhost:4001/mcp` in fullstack)
- Bearer token (if connecting to production; dev mode does not require one)

## Step 1: Generate the Config Snippet

In your terminal, run:

```bash
recondo-mcp config goose
```

This outputs a YAML-compatible configuration object for Goose's extension registry. For example:

```json
{
  "extensions": {
    "recondo": {
      "name": "recondo",
      "enabled": true,
      "type": "streamable-http",
      "url": "http://localhost:4001/mcp",
      "headers": {}
    }
  }
}
```

If you're using a scoped key (production setup), use:

```bash
recondo-mcp config goose --scoped <project_id>
```

Output with credentials:

```json
{
  "extensions": {
    "recondo": {
      "name": "recondo",
      "enabled": true,
      "type": "streamable-http",
      "url": "https://recondo.example.com/mcp",
      "headers": {
        "Authorization": "Bearer wrt_abc123def456..."
      }
    }
  }
}
```

## Step 2: Update Goose's Configuration

Goose stores extension and MCP server registrations in its configuration file. The exact location depends on your Goose installation, but it is typically one of:

- `~/.goose/config.toml` (TOML)
- `~/.goose/config.yaml` (YAML)
- `~/.config/goose/config.yaml` (Linux, XDG-compliant)
- Check your Goose docs for your version's configuration path

Open the relevant config file and merge the `extensions` section from the config snippet into the existing configuration.

### Example: Adding to YAML Config

If your Goose config is YAML (e.g., `~/.goose/config.yaml`), add:

```yaml
extensions:
  recondo:
    name: recondo
    enabled: true
    type: streamable-http
    url: http://localhost:4001/mcp
    headers: {}
```

If `extensions` already exists, add the `recondo` entry as a sibling:

```yaml
extensions:
  recondo:
    name: recondo
    enabled: true
    type: streamable-http
    url: http://localhost:4001/mcp
    headers: {}
  other-extension:
    # ... existing config
```

### Example: With Bearer Token (Production)

```yaml
extensions:
  recondo:
    name: recondo
    enabled: true
    type: streamable-http
    url: https://recondo.example.com/mcp
    headers:
      Authorization: "Bearer wrt_abc123def456..."
```

## Step 3: Restart Goose

Restart Goose for it to reload the configuration and discover the new MCP server:

```bash
goose
```

## Verifying the Installation

Once Goose restarts, test the MCP connection:

1. **Check available extensions** — In Goose, list extensions to confirm `recondo` is loaded and enabled:
   ```
   goose extensions
   ```
   or similar (check your Goose version's command syntax).

2. **Request tool usage** — Ask Goose to query your Recondo data:
   ```
   List my captured sessions from today using Recondo.
   ```

   Goose should invoke one of the Recondo tools (e.g., `recondo_list_sessions`) and display the results.

3. **Check logs** — Review Goose logs or verbose output to confirm tool invocation:
   ```
   goose --verbose
   ```

If the tool call fails, check:
- The MCP service is running and accessible on `http://localhost:4001/mcp`
- The `url` in Goose's config matches where your MCP is listening
- Bearer token (if used) is valid and correctly formatted in the `Authorization` header
- The Goose configuration file is valid YAML or TOML

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

These flags gate the availability of action tools in the MCP tool list. Goose will not see or invoke action tools unless the service has started with the corresponding flags. This is a startup configuration, not a per-request override.

Restart Goose after restarting the MCP service with new flags.

## Prompt Injection Protection

All captured content returned by the MCP is wrapped in XML delimiters to prevent prompt injection. If you ask Goose to analyze a captured prompt or response, the MCP structures its output with explicit metadata:

```
<captured_content role="user" session_id="abc123" turn_id="1">
What is 2 + 2?
</captured_content>
```

The role and turn metadata are explicit in the XML, preventing confusion even if the captured content contains malicious payloads.

## Troubleshooting

### Extension not loading or disabled

- Verify Goose's config file is valid YAML/TOML
- Check that `enabled: true` is set for the `recondo` extension
- Restart Goose completely
- Check Goose's error logs for configuration parsing errors

### "Session not found" or connection errors

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

### Tools not appearing or not callable

- Restart Goose completely (not just reload)
- Re-run `recondo-mcp config goose` to regenerate the config
- Ensure the `recondo` entry is directly under `extensions` in the config file
- Check that `url` points to a running MCP service
- Verify the configuration syntax is valid (`yamllint` or similar)

## Finding Your Goose Config

If you're unsure where Goose's config file lives, check:

```bash
# Common locations
cat ~/.goose/config.yaml
cat ~/.goose/config.toml
cat ~/.config/goose/config.yaml

# Or ask Goose directly (varies by version)
goose --config-path
goose --show-config
```

Consult your Goose documentation for the exact command and path for your version.

## Next Steps

- For authentication details and production setups, see [auth-modes.md](./auth-modes.md)
- For a list of all available tools, see the tool catalog (coming in Task 6)
- For the full Recondo quickstart, see [quickstart.md](../quickstart.md)
