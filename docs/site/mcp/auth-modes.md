# Recondo MCP — Authentication Modes

The Recondo MCP supports two authentication modes: **dev bypass** (local development) and **bearer token** (production and remote). This document explains the design, workflow, and security implications of each.

## Overview

| Mode | Env | Mechanism | Use Case | Security |
|------|-----|-----------|----------|----------|
| **Dev Bypass** | `NODE_ENV=development` + `RECONDO_DEV_BYPASS=1` | No credentials required | Local development with fullstack | Dev-only, not suitable for production |
| **Bearer Token** | `NODE_ENV=production` (default) | HTTP `Authorization: Bearer wrt_...` header | Production and remote instances | Per-client scoped keys, no dev-bypass fallback |

## Dev Bypass Mode (Local Development)

### Enable Dev Bypass

When starting the MCP in development with the fullstack:

```bash
just fullstack
```

This automatically starts the MCP with:
- `NODE_ENV=development`
- `RECONDO_DEV_BYPASS=1`
- Other required env vars (DATABASE_URL, object store config)

The service accepts any HTTP request without an `Authorization` header.

### Configuration for Agents

Generate config for dev bypass mode:

```bash
recondo-mcp config claude-code
# or: recondo-mcp config cursor
# or: recondo-mcp config goose
```

Output has no `headers` or `Authorization`:

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

No bearer token is generated or required. Any agent registered with this snippet can immediately use all available tools.

### Security Posture

**Dev bypass is development-only and intentionally insecure:**

- No authentication is performed
- No project isolation (all agents see all captures)
- No audit trail of which agent invoked which tool
- Suitable only for local testing on trusted networks

**Dev bypass is never active in production:**

If the MCP is started with `NODE_ENV=production` (the default), `RECONDO_DEV_BYPASS=1` is ignored, and all HTTP requests require an `Authorization: Bearer` header.

## Bearer Token Mode (Production)

### Enable Bearer Token Auth

Start the MCP in production mode:

```bash
NODE_ENV=production \
  DATABASE_URL="postgres://..." \
  RECONDO_OBJECT_STORE_PATH="/data/objects" \
  pnpm dev
```

Or, in a container (the fullstack uses production mode by default in Kubernetes/Docker):

```yaml
env:
  - name: NODE_ENV
    value: production
  - name: DATABASE_URL
    valueFrom: ...
```

With `NODE_ENV=production`, the MCP refuses all requests without a valid bearer token, even if `RECONDO_DEV_BYPASS=1` is set.

### Minting Scoped Keys

In production, clients need bearer tokens. Use the `recondo-mcp config` helper with `--scoped` to mint a key:

```bash
recondo-mcp config claude-code --scoped <project_id>
```

This command:
1. Connects to the database using `DATABASE_URL`
2. Mints a new scoped API key for the given `project_id`
3. Returns the raw secret (prefixed `wrt_`)
4. Emits config JSON with the token in the `Authorization` header

**Example output:**

```json
{
  "mcpServers": {
    "recondo": {
      "type": "streamable-http",
      "url": "https://recondo.example.com/mcp",
      "headers": {
        "Authorization": "Bearer wrt_abc123xyz789..."
      }
    }
  }
}
```

### Scoped Key Workflow

1. **Operator creates a scoped key for a project:**
   ```bash
   recondo-mcp config claude-code --scoped "my-project-id" > claude-config.json
   ```

2. **Distribute the config to the team:**
   - Send `claude-config.json` to your team or embed it in CI/CD
   - Each agent registers the MCP using the snippet

3. **All requests from that agent are scoped to the project:**
   - The MCP extracts the token from the `Authorization` header
   - The token is validated in the database (checks expiry, revocation, project membership)
   - Tools can only access captures tagged with the scoped project ID

4. **Revoke access if needed:**
   - Call the data-layer function `revokeApiKey(token)` to disable the key
   - All agents using that token immediately lose access

### Bearer Token Header Format

Clients send the token as an HTTP header (case-insensitive for the header name, case-sensitive for the scheme and token):

```
Authorization: Bearer wrt_abc123xyz789...
```

The scheme must be `Bearer` (capital B), followed by a space and the token. The token itself is opaque to the client; the MCP validates it in the database.

**Invalid formats (rejected):**

```
Authorization: bearer wrt_abc123...  # wrong case for scheme
Authorization: Bearer wrt_abc123     # missing the token entirely
Authorization: wrt_abc123            # missing the scheme
Authorization: Bearer abc123         # wrong token prefix
```

## Transition from Dev to Production

### Local Development

```bash
# Start fullstack (dev bypass enabled)
just fullstack

# Register agents (no token needed)
recondo-mcp config claude-code >> ~/.claude/mcp_servers.json
```

### Production Deployment

```bash
# Start MCP in production mode
NODE_ENV=production pnpm dev

# For each team or project, mint a scoped key
recondo-mcp config claude-code --scoped "team-a" > /tmp/claude-team-a.json
recondo-mcp config cursor --scoped "team-b" > /tmp/cursor-team-b.json

# Distribute to teams (via secure channel)
```

Each team gets their own bearer token and project isolation.

## Security Details

### No Silent Fallback

If a client sends no `Authorization` header and the MCP is in production mode, the request is **rejected with a 401 Unauthorized error**. The MCP does not silently downgrade to dev bypass; the error is explicit.

### Token Expiry and Revocation

Scoped keys support optional expiry dates and revocation. The MCP checks the token state on every request:

- **Expired token** → 401 Unauthorized
- **Revoked token** → 401 Unauthorized
- **Valid token** → request proceeds with token's project scope

### Audit Trail

When a token is used to invoke a tool, the audit log records:
- The token ID (not the raw secret)
- The tool name and arguments
- The response size
- The timestamp

This enables compliance teams to answer "which agent invoked which tools, and when?"

### Prompt Injection Mitigation

Bearer tokens are sent once during the handshake and do not appear in tool requests or responses. Tool responses are wrapped in XML delimiters (load-bearing injection protection), but the authentication header is never embedded in captured content.

## Configuration Reference

### Environment Variables

| Variable | Mode | Default | Example |
|----------|------|---------|---------|
| `NODE_ENV` | Both | `production` | `development` or `production` |
| `RECONDO_DEV_BYPASS` | Dev only | (unset) | `1` |
| `DATABASE_URL` | Both | (required) | `postgres://user:pass@host/recondo` |
| `RECONDO_OBJECT_STORE_PATH` | Both | (required) | `/data/objects` |
| `RECONDO_MCP_HOST` | Both | `127.0.0.1` | `0.0.0.0` or `127.0.0.1` |
| `RECONDO_MCP_PORT` | Both | `4001` | `4001` or `3000` |
| `RECONDO_MCP_URL` | CLI helper | `http://localhost:${PORT}/mcp` | `https://recondo.example.com/mcp` |

### recondo-mcp config Flags

```bash
recondo-mcp config <flavor> [--scoped <project_id>] [--emit-args] [--allow-actions]
```

| Flag | Meaning | Example |
|------|---------|---------|
| `<flavor>` | Target client (required) | `claude-code`, `cursor`, `goose` |
| `--scoped <project_id>` | Mint a bearer token for the given project | `--scoped "team-alpha"` |
| `--emit-args` | Include startup flags in the output (advanced) | `--emit-args` |
| `--allow-actions` | Mark action tools as enabled in output (server must start with this flag) | `--allow-actions` |

## Examples

### Dev: Local fullstack with Claude Code

```bash
# Terminal 1: Start fullstack
just fullstack

# Terminal 2: Register MCP with Claude Code
recondo-mcp config claude-code >> ~/.claude/mcp_servers.json

# Terminal 3: Start Claude Code
claude
```

No bearer token is needed.

### Prod: Remote instance with scoped keys

```bash
# On the ops machine (has DATABASE_URL)
recondo-mcp config claude-code --scoped "platform-team"

# Output:
# {
#   "mcpServers": {
#     "recondo": {
#       "type": "streamable-http",
#       "url": "https://governance.company.com/mcp",
#       "headers": {
#         "Authorization": "Bearer wrt_prod_abc123..."
#       }
#     }
#   }
# }

# Distribute to platform-team (via secure channel)
```

All agents using this token access only the "platform-team" project.

### Prod: Revoke a compromised token

```bash
# In code or via CLI (revokeApiKey function)
await revokeApiKey("wrt_prod_abc123...");

# All agents using this token immediately get 401 responses
```

## Next Steps

- For per-client setup, see [install-claude-code.md](./install-claude-code.md), [install-cursor.md](./install-cursor.md), or [install-goose.md](./install-goose.md)
- For the full MCP overview, see [install.md](./install.md)
- For architectural context, see [architecture.md](../architecture.md)
