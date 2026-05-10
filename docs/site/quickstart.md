# Quickstart: From Clone to First Capture (10 Minutes)

> **Note:** This quickstart assumes the local-dev stack. For production deploys, see [architecture.md](./architecture.md) and the deployment guide.

## 1. What You'll Have at the End

After 10 minutes, you'll have:

- A running Recondo gateway on port 8443, capturing all agent-to-LLM traffic through TLS MITM
- A PostgreSQL database with your first captured sessions
- A live dashboard at `http://localhost:5173` showing realtime analytics
- A TUI (terminal UI) in another pane rendering metric cards with 500 ms latency
- Claude Code querying its own past sessions via MCP — ask "what tools have I called in the last hour?" and it invokes the recondo_tool_call_stats function

**Total time:** ~10 minutes on a fresh clone (Intel/Apple Silicon, 2024+).

## 2. Prerequisites

**Required:**

- **Git** — to clone the repo
- **Docker + Docker Compose** — for PostgreSQL and S3 emulation (MiniStack)
- **Rust toolchain** — [install via rustup](https://rustup.rs/) (1.80+)
- **Node.js** — v20+ ([install via nvm or Homebrew](https://nodejs.org/))
- **pnpm** — v10+ (install via `npm install -g pnpm`)
- **One supported agent client:** Claude Code, Cursor, or Goose
- **Disk space:** ~2 GB for containers, build artifacts, and test data
- **Ports:** 8443 (gateway), 4000 (API), 5173 (dashboard), 5432 (PostgreSQL), 4566 (MiniStack) must be free

**Optional but recommended:**

- **tmux or screen** — to manage multiple terminals easily
- **just** — command runner (install via `brew install just` or `cargo install just`)

## 3. Step 1 — Clone and Bootstrap

Clone the repo and run the one-time setup:

```bash
git clone https://github.com/anthropics/recondo
cd recondo
just setup           # installs cargo-nextest (one-time, ~30s)
just dev-setup       # starts Postgres + MiniStack + runs migrations (~2 min)
```

`just dev-setup` does two things in one call:
- Starts Docker containers (PostgreSQL and MiniStack for S3/IAM/KMS emulation)
- Waits for PostgreSQL to be ready
- Runs all database migrations

If you prefer manual control:
```bash
just dev-infra          # Start PostgreSQL + MiniStack
# (wait for "PostgreSQL is ready" in logs)
just api-migrate        # Run migrations
```

## 4. Step 2 — Start the Stack

Open **four terminals** (or use tmux panes) in the repo root and run each command:

**Terminal 1: Gateway**
```bash
just dev-run-local       # Listens on :8443, writes to Postgres + local disk
```

You should see:
```
[INFO] Loaded extra CA certificates for upstream TLS (if applicable)
[INFO] TCP listener bound to 127.0.0.1:8443
```

**Terminal 2: API server**
```bash
just api-dev             # GraphQL API on :4000
```

You should see:
```
Server running at http://localhost:4000/
```

**Terminal 3: Dashboard**
```bash
just dashboard-dev       # Dev server on :5173
```

You should see:
```
Local:   http://localhost:5173/
```

**Terminal 4: Ready for Claude Code (Step 4)**

Keep this terminal available for the next step.

## 5. Step 3 — Install Gateway CA

Your agent (Claude Code) must trust the gateway's self-signed TLS certificate. The simplest way:

```bash
# Sync gateway CA to system trust store (one-time)
just dev-trust
```

**If behind a corporate TLS inspection firewall** (Zscaler, Blue Coat, Palo Alto):

Copy your corporate CA to the gateway's trusted roots:

```bash
# Option A: auto-discovery (recommended — do once)
cp /path/to/corporate/CA.pem ~/.recondo/ca/extra_roots.pem

# Option B: per-session via env var
RECONDO_EXTRA_CA_CERTS=/path/to/corporate/CA.pem just dev-run-local
```

The gateway logs `Loaded extra CA certificates for upstream TLS` on startup when it finds the file.

## 6. Step 4 — Route Claude Code Through the Gateway

In Terminal 4:

```bash
HTTPS_PROXY=http://localhost:8443 NODE_TLS_REJECT_UNAUTHORIZED=0 claude
```

Send a simple prompt (e.g., "What time is it?"). Wait for a response.

**Verify it worked:**

Open the dashboard at `http://localhost:5173/` in your browser. Within 5 seconds, you should see a new row in the **Realtime feed** with your session's metadata (user ID, timestamp, token count).

If nothing appears:
- Check gateway logs: `[INFO] Captured session ...`
- Check dashboard network tab: did the GraphQL query succeed?
- See "Common first-run problems" below.

## 7. Step 5 — Run the TUI

In a fifth terminal:

```bash
cargo run -p recondo-tui
```

Note: This will take 30–60 seconds on first run (Rust compilation). Subsequent runs are faster.

The TUI should launch with three panes:

1. **Realtime metrics** — live token counts, session throughput, cache hit rate
2. **Sessions** — list of all captured sessions
3. **Details** — selected session's turns and tool calls

Press `d` to toggle the realtime lens. Metrics should update every ~500 ms and match the dashboard cards.

For more TUI keybindings and features, see [tui/first-run.md](./tui/first-run.md).

## 8. Step 6 — Register the MCP (Optional)

The Recondo MCP lets Claude Code query its own past sessions directly. This step is optional — the core quickstart works without it.

To set it up, see the [MCP install guide](./mcp/install-claude-code.md).

**Verify:** Once installed, ask Claude Code in a new session:

```
What tools have I called in the last hour?
```

Claude Code should invoke `recondo_tool_call_stats` and show you the results.

## 9. Verify Everything Works

Check these boxes before moving to production:

- [ ] Dashboard at `http://localhost:5173` shows **non-zero session count** (at least 1 from Step 4)
- [ ] API GraphQL endpoint responds at `http://localhost:4000/graphql`
- [ ] TUI realtime lens (`d` key) renders metric cards within **500 ms** of the dashboard
- [ ] Claude Code, when asked "what tools have I called in the last hour?", invokes **recondo_tool_call_stats**

If all three pass, Recondo is working end-to-end.

## 10. Where Data Lives

Your captured data is stored in three places:

| Location | Contents |
|----------|----------|
| `~/.recondo/objects/req/` | Gzipped request bodies (content-addressable, deduplicated) |
| `~/.recondo/objects/resp/` | Gzipped response bodies |
| `~/.recondo/captures/` | JSON metadata linking req/resp hashes, session ID, timestamps |
| **PostgreSQL** (localhost:5432) | Normalized schema: sessions, turns, tool calls, costs, tokens |

For architecture details, see [./architecture.md](./architecture.md).

## 11. Common First-Run Problems

### "Connection refused" on `:8443`

The gateway didn't start. Check:

```bash
# In Terminal 1, do you see "[INFO] TCP listener bound to 127.0.0.1:8443"?
# If not, check the full error output.
```

Common causes:
- Port 8443 already in use: `lsof -i :8443` and kill the process
- Rust not installed: `rustup --version`

### "Invalid CA cert" or "CERTIFICATE_VERIFY_FAILED"

Your agent didn't trust the gateway's self-signed certificate.

```bash
# Did you run Step 3?
just dev-trust

# Still broken? Set the fallback:
NODE_TLS_REJECT_UNAUTHORIZED=0 claude
```

### Dashboard shows "No data" or GraphQL 500 error

The API can't connect to PostgreSQL.

```bash
# Is Postgres running?
docker ps | grep postgres

# Is the API running?
# (check Terminal 2 logs)

# Can you connect to Postgres?
psql -h localhost -U recondo -d recondo -c "SELECT COUNT(*) FROM sessions;"
# Password: recondo_dev
```

You should see at least 1 row (the captures from Step 4). If COUNT(*) = 0, the gateway didn't write captures to the database.

### "Another recovery in progress"

A previous gateway process crashed while holding the recovery lock. Fix it:

```bash
# 1. Check if the lock holder is still alive
lsof ~/.recondo/.recovery.lock

# 2a. If a PID is listed and it's stuck, kill it
kill <PID>

# 2b. If no PID (process crashed), remove the lock
rm ~/.recondo/.recovery.lock

# 3. Restart the gateway
just dev-run-local
```

### TUI doesn't show data

- Is the gateway running? (Terminal 1 logs)
- Is the API running? (Terminal 2 logs)
- Did you send a prompt through Claude Code? (Step 4)
- Check TUI logs: `cargo run -p recondo-tui 2>&1 | tee tui.log`

## 12. Next Steps

Congratulations! You now have Recondo running locally. Here's where to go next:

- **Understand the architecture** — [./architecture.md](./architecture.md)
- **Write custom forensics queries** — [./forensics/unredacted-access.md](./forensics/unredacted-access.md)
- **Integrate MCP with more clients** — [./mcp/install.md](./mcp/install.md)

> **Note:** Links in this section will resolve once those docs are published. This is not a blocker for spec compliance.

---

<!-- IMPLEMENTATION NOTE: Time this quickstart on a clean clone (fresh system, no cached artifacts).
Target: under 10 minutes. Track:
- `git clone + cd`: ~5-10s
- `just setup`: ~30s (cargo-nextest compile, one-time)
- `just dev-setup`: ~2 min (docker pull, postgres init, migrations)
- `just dev-run-local + others`: ~10-15s to bind ports
- Step 4 (send prompt): ~5s
- Step 5 (cargo run -p recondo-tui): ~10-15s

If total > 10 min, file a friction-fix issue before merging. Common suspects:
- cargo-nextest compile in setup (check: does cargo-nextest binary already exist?)
- docker pull (check: are latest images cached locally?)
- migrations taking >30s (check: are they sequential or parallel?)
- TUI compile taking >15s (check: can we use prebuilt binaries or release cache?)
-->
