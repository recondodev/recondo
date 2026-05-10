# Recondo TUI — First-Run Guide

After launching `recondo-tui`, you should see the realtime lens within 500 milliseconds, displaying live metrics from your Recondo gateway and API.

## What You Should See

The realtime lens shows three main sections:

1. **Header strip** — Gateway status pill (green = live, gray = offline), listening port, active provider count, active agent count
2. **Metric cards** — Five cards displaying live statistics:
   - User Turns / Min (with optional wire-call count)
   - Active Sessions (count across providers)
   - Tokens Last Hour (with cache-read delta)
   - Cost Last Hour (with projected-today delta)
   - P50 Latency / P50 Capture (with P99 and sample count)
3. **Live traffic table** — 50-row virtualized scroll showing recent turns: Time, Provider, Model, Agent/Intent (with framework pill), Tokens, Cost, Status

## Configuration

### Environment Variables

Control the TUI's connection to the Recondo API via two env vars:

| Variable | Default | Meaning |
|----------|---------|---------|
| `RECONDO_API_URL` | `http://localhost:4000/graphql` | The GraphQL endpoint the TUI polls for metrics and session data. Set this to point to your deployed API if not running locally. |
| `RECONDO_API_KEY` | unset | Optional API key for authentication. If unset, the TUI sends no `Authorization` header and uses the API's dev-mode bypass (for local development). If set to a `wrt_...` value, sent as `Authorization: Bearer ...` |

### CLI Flags

Flags mirror the env vars and override them:

```bash
recondo-tui --api-url http://staging-api.example.com:4000/graphql
recondo-tui --api-key wrt_abc123def456
```

Combine them:

```bash
recondo-tui --api-url http://staging.example.com:4000/graphql --api-key wrt_abc123
```

## Authentication Models

### Default (No Auth Setup Required)

Recommended for local development. Works out of the box:

- API runs with `NODE_ENV=development` (default for `just api-dev`)
- TUI sends no `Authorization` header
- API synthesizes an admin `ApiKeyInfo` (full access, cross-project)
- **Effective scope:** Full historical access, all sessions, all projects

This is the same posture the web dashboard uses when running locally.

### Opt-In Real Auth

For shared deployments or production use:

1. Generate or obtain a `wrt_...` API key from your Recondo admin
2. Set the key:
   ```bash
   export RECONDO_API_KEY=wrt_abc123def456xyz
   recondo-tui
   ```
   or inline:
   ```bash
   RECONDO_API_KEY=wrt_abc123def456xyz recondo-tui
   ```
3. TUI sends `Authorization: Bearer wrt_abc123def456xyz` on every API request
4. API validates the key against its `api_keys` table and scopes results accordingly

### Production (Required Auth)

Once the API runs outside `NODE_ENV=development`:

- The dev-mode bypass is disabled
- TUI **must** set `RECONDO_API_KEY` or requests are rejected with a 401
- Set the key via env var or CLI flag (above)

## Common First-Run Scenarios

### "Cannot reach Recondo API at http://localhost:4000/graphql"

The TUI could not connect to the API. Troubleshoot:

1. **Is the API running?**
   ```bash
   curl http://localhost:4000/graphql
   ```
   Should return a GraphQL 400 (method not allowed for GET) or 200, not a connection error.

2. **Is the gateway running?**
   ```bash
   # The API depends on the gateway for captured data
   just dev-run-local    # in another terminal
   ```

3. **Wrong URL?**
   ```bash
   recondo-tui --api-url http://your-actual-api-host:4000/graphql
   ```

4. **Network / firewall?**
   ```bash
   # Test connectivity
   telnet localhost 4000
   ```

### "Empty realtime feed" / "No sessions"

Data exists but the TUI isn't showing it. Verify:

1. **Is the gateway capturing traffic?**
   ```bash
   # Check captured files
   ls ~/.recondo/objects/req/ | head -5
   ls ~/.recondo/captures/ | head -5
   ```
   If empty, the gateway never received traffic. Send a prompt through Claude Code:
   ```bash
   HTTPS_PROXY=http://localhost:8443 NODE_TLS_REJECT_UNAUTHORIZED=0 claude
   # Type a prompt and wait for response
   ```

2. **Did the API ingest the captures?**
   ```bash
   psql -h localhost -U recondo -d recondo -c "SELECT COUNT(*) FROM sessions;"
   # Password: recondo_dev
   ```
   Should show at least 1 row.

3. **Is the TUI connected to the right API?**
   ```bash
   recondo-tui --api-url http://localhost:4000/graphql
   # Then check the header strip — does the gateway-status pill show green or gray?
   ```

### "Auth rejected" / "401 Unauthorized"

Your API key is invalid or missing. Troubleshoot:

1. **Key format correct?**
   ```bash
   # Should start with wrt_
   echo $RECONDO_API_KEY
   ```

2. **Key registered in the API?**
   ```bash
   # Check the api_keys table (requires admin access to the database)
   psql -h localhost -U recondo -d recondo \
     -c "SELECT id, name, created_at FROM api_keys WHERE key_hash = ... LIMIT 1;"
   ```
   The key is hashed server-side; you'll need the API logs or admin panel to verify.

3. **API running in production mode?**
   ```bash
   # If NODE_ENV=production, the API will reject requests without a valid key
   # For local dev, run with: NODE_ENV=development just api-dev
   ```

## Basic Navigation

The TUI is a k9s-style terminal interface. Here are the most useful first-run keys:

| Key | Action |
|-----|--------|
| `d` | Open realtime lens (default on startup) |
| `s` | Open sessions lens (list of all sessions) |
| `c` | Open cost lens (spending breakdown) |
| `/` | Fuzzy search within current view |
| `:` | Command palette (type `:realtime`, `:sessions`, `:cost`, etc.) |
| `j` / `k` | Scroll down / up |
| `Enter` | Drill into a row (e.g., click a session to see turns) |
| `q` | Quit |
| `?` | Show help overlay |

## Time Windows

Switch time windows via the command palette:

```
:today      # Show only today's sessions
:week       # Show last 7 days
:month      # Show last 30 days
:all        # Show all sessions
:since 2026-04-01    # Custom start date
```

The active time window persists as you switch lenses.

## Pinning Views and Selection

The TUI maintains selection across lenses:

- **Pin a view:** Press `*` to bookmark the current lens as a pinned tab
- **Jump to pinned tab:** Press `1`–`9` to switch to pinned tabs
- **Selection follows:** Highlight a session in the `s` (sessions) lens, then press `c` (cost) — the cost lens will scope to that session's costs. Switch back to `s` and the selection is preserved.

## Next Steps

For a complete keybinding reference, see [keybindings.md](./keybindings.md).

For detailed information on each lens (realtime metrics, sessions, cost, agents), see the [TUI architecture doc](../architecture.md).
