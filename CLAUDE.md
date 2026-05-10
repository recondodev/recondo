# Recondo

AI Governance Gateway. Every agent-to-LLM call flows through it for compliance auditing (SOC 2, ISO 42001), usage intelligence, and centralized reporting across all platforms.

## Build & Run

```bash
just setup               # one-time: installs cargo-nextest
just build               # fmt + clippy + build
just run                 # starts gateway on :8443
just test                # runs all 678 tests via nextest
just ci                  # fmt + clippy + test (what CI runs)
```

Or without `just`:
```bash
cd gateway && cargo build
cd gateway && cargo run
cd gateway && cargo nextest run --features test-support
cd gateway && cargo clippy --features test-support --tests -- -D warnings
```

## Test the gateway

### Automated tests (678 tests, ~5 seconds)

```bash
just test
```

Run a specific test suite:
```bash
cd gateway && cargo nextest run --test tls_mitm_tests      # TLS MITM pipeline (8 tests)
cd gateway && cargo nextest run --test tcp_listener_tests   # TCP listener (6 tests)
cd gateway && cargo nextest run --test wal_tests            # WAL module (12 tests)
cd gateway && cargo nextest run --test session_tests        # Session management (16 tests)
cd gateway && cargo nextest run --test capture_integration_tests  # Capture pipeline (8 tests)
```

### Test suite map

| Test file | Tests | What it covers |
|-----------|-------|---------------|
| `week4_tests` | 57 | Schema v2 migration, Gemini provider/endpoint, fixture validation, compliance docs |
| `week4_phase2_tests` | 53 | Gemini response parser, mock LLM servers, struct v2 wiring |
| `schema_expansion_tests` | 51 | Schema field coverage, DB roundtrips |
| `proxy_tests` | 37 | CONNECT request parsing, host classification, server config |
| `intercept_tests` | 37 | Request interception: path matching, method filtering, Gemini endpoints |
| `cli_tests` | 28 | CLI commands: sessions, session, turn, search, stats, verify |
| `websocket_tests` | 26 | WebSocket frame parsing, encoding, masking |
| `code_review_fixes_tests` | 24 | Fixes from prior code reviews |
| `db_tests` | 18 | SQLite schema, insert/query, v2 struct round-trips |
| `session_tests` | 16 | Session boundaries, prompt hash, time gaps, sequence |
| `schema_full_tests` | 15 | Full schema validation with all fields |
| `websocket_integration_tests` | 14 | WebSocket relay, frame capture, DB integration |
| `intent_agent_tests` | 14 | Initial intent extraction, agent framework detection |
| `anthropic_response_tests` | 14 | SSE event parsing: text, thinking, tool_use, usage |
| `week2_negative_tests` | 13 | Week 2 negative/edge case tests |
| `stream_tests` | 13 | SSE accumulator: chunking, message_stop, truncation |
| `wal_tests` | 12 | WAL: append, flush, mark_flushed, persistence, fail modes |
| `gap_fix_tests` | 12 | Gap fixes from compliance analysis |
| `anthropic_request_tests` | 12 | Request body parsing: system prompt, messages, tools |
| `migration_tests` | 11 | Additive migration framework, idempotency |
| `forward_compat_tests` | 11 | OD-007: raw_extra, parser_version, parse_errors |
| `tls_tests` | 10 | CA generation, leaf cert generation, extra CA cert loading |
| `store_tests` | 9 | Object store: gzip, content-addressable, dedup |
| `tls_mitm_tests` | 8 | End-to-end TLS MITM: CONNECT → TLS handshake → capture to disk |
| `messages_delta_tests` | 8 | Messages delta compression, DB roundtrip |
| `capture_metadata_tests` | 8 | Capture record metadata fields |
| `capture_integration_tests` | 8 | Full capture pipeline: req → hash → store → DB |
| `provider_tests` | 7 | Provider detection: Anthropic, OpenAI, Gemini |
| `negative_tests` | 7 | Negative/boundary tests |
| `hash_tests` | 7 | SHA-256 computation |
| `tcp_listener_tests` | 6 | TCP listener: bind, accept, CONNECT 200, concurrent connections |
| `pipeline_tests` | 5 | Capture pipeline orchestration |
| `schema_tests` | 3 | Schema type definitions |
| `gemini_integration_tests` | 3 | Gemini process_capture → DB round-trip (text, tool calls, raw_extra) |

### Manual testing with Claude Code

**One-time setup:**
```bash
# 1. Build the gateway
just build

# 2. If behind a corporate TLS inspection firewall, copy your corporate CA:
cp /path/to/corporate/CA.pem ~/.recondo/ca/extra_roots.pem
```

**Run the gateway (background):**
```bash
cd gateway && cargo run &
```

**Route Claude Code through it (same terminal):**
```bash
HTTPS_PROXY=http://localhost:8443 NODE_TLS_REJECT_UNAUTHORIZED=0 claude
```

Or in two terminals:
```bash
# Terminal 1: start gateway
just run

# Terminal 2: route Claude Code through it
HTTPS_PROXY=http://localhost:8443 NODE_TLS_REJECT_UNAUTHORIZED=0 claude
```

**Verify captures after a session:**
```bash
ls ~/.recondo/objects/req/    # gzipped request bodies
ls ~/.recondo/objects/resp/   # gzipped response bodies
ls ~/.recondo/captures/       # JSON metadata linking req/resp hashes
```

### Development with PostgreSQL + MiniStack

Run the full production-like stack locally (PostgreSQL + S3 emulation via MiniStack):

```bash
# Terminal 1: start PostgreSQL + MiniStack containers
just dev-infra          # Start PostgreSQL + MiniStack
# Wait for PostgreSQL to be ready, then:
just api-migrate        # Run all migrations (single source of truth)
# Alternatively, use `just dev-setup` to run both steps with automatic readiness check.

# Terminal 2: start gateway connected to local PG (expects tables to exist)
just dev-run-local

# Terminal 3: start API server (expects tables to exist)
just api-dev

# Terminal 4: start dashboard
just dashboard-dev

# Terminal 5: route Claude Code through the gateway
just dev-claude
```

| Command | What it does |
|---------|-------------|
| `just dev-setup` | Start dev-infra + run migrations in one step (with PG readiness check) |
| `just dev-infra` | Start MiniStack (S3, KMS, IAM on :4566) + PostgreSQL 16 (:5432) |
| `just api-migrate` | Run all migrations (single source of truth for the PostgreSQL schema) |
| `just api-migrate-create <name>` | Create a new migration file with a timestamp prefix |
| `just api-migrate-down` | Roll back the last applied migration |
| `just dev-infra-down` | Stop containers (data preserved in volumes) |
| `just dev-infra-reset` | Stop containers and delete all data volumes |
| `just dev-run-local` | Start gateway with `RECONDO_STORE=postgres` + `RECONDO_OBJECTS=local` |
| `just dev-run` | Start gateway with PG + S3 (requires S3 implementation) |
| `just api-dev` | Start API server in dev mode (expects tables to exist) |
| `just dashboard-dev` | Start dashboard dev server on :5173 |
| `just dev-claude` | Route Claude Code through the gateway |
| `just test-pg` | Run PostgreSQL integration tests against dev-infra |
| `just tf-plan` | Terraform init + plan against MiniStack |
| `just tf-apply` | Apply Terraform to MiniStack (creates resources) |

PostgreSQL connection: `localhost:5432`, database `recondo`, user `recondo`, password `recondo_dev`.

### Corporate TLS inspection (SSL re-signing firewalls)

If your network re-signs TLS certificates (Zscaler, Blue Coat, Palo Alto, etc.), the gateway needs your corporate CA to trust the re-signed upstream certs. Two options:

```bash
# Option A: copy to auto-discovery path (recommended — do once)
cp /path/to/corporate/CA.pem ~/.recondo/ca/extra_roots.pem

# Option B: env var (per-session)
RECONDO_EXTRA_CA_CERTS=/path/to/corporate/CA.pem cargo run
```

The gateway logs `Loaded extra CA certificates for upstream TLS` on startup when it finds the file.

### Testing with Codex (OpenAI)

```bash
CODEX_CA_CERTIFICATE=$HOME/.recondo/ca/ca.crt HTTPS_PROXY=http://localhost:8443 codex
```

Codex is a Rust binary — it uses `CODEX_CA_CERTIFICATE` (not `NODE_TLS_REJECT_UNAUTHORIZED`) to trust the gateway's CA. Codex connects to `chatgpt.com` via WebSocket (not `api.openai.com` via HTTP SSE).

**Note:** The gateway URL is `http://` (not `https://`). The CONNECT handshake is plain HTTP; TLS happens inside the tunnel. `NODE_TLS_REJECT_UNAUTHORIZED=0` tells Claude Code (Node.js) to trust the gateway's self-signed MITM certificate. Codex (Rust) uses `CODEX_CA_CERTIFICATE` instead.

## Architecture

- **Language:** Rust (gateway), TypeScript (API/dashboard — future)
- **Storage:** SQLite (dev) → PostgreSQL (prod)
- **Data dir:** `~/.recondo/` (objects, CA certs, captures, SQLite DB)
- **Data layer:** `@recondo/data` (workspace package at `packages/recondo-data/`) — see `api/src/resolvers/README.md` for the resolver-adapter pattern.

### Gateway module map

| Module | Purpose |
|--------|---------|
| `tls/` | CA cert generation, per-host leaf certs, CertCache (LRU), trust store injection |
| `capture/` | Request/response interception, capture pipeline |
| `stream/` | SSE stream accumulator, `strip_http_headers`, `prepare_response_body` (chunked TE + gzip decompression) |
| `hash/` | SHA-256 content hashing |
| `store/` | Object storage (local filesystem) |
| `storage/` | Storage abstraction layer: `GraphStore` trait (SQLite + PostgreSQL), `ObjectStore` trait (local + S3), `WritePipeline` (retry + dead-letter queue), `ConnectionPool` (r2d2) |
| `providers/` | LLM provider detection + response parsing (Anthropic, Google/Gemini, mock servers) |
| `schema/` | Data types (CaptureRecord) |
| `db/` | SQLite schema, insert/query operations, cost calculation |
| `session/` | Session identity (metadata-based), user message extraction, agent framework detection |

### Session identity model

Claude Code sends identity metadata in every API request via `metadata.user_id`:

| Field | What it identifies | Stable across |
|-------|-------------------|---------------|
| `metadata.user_id.session_id` | One Claude CLI instance | All requests in that CLI session |
| `metadata.user_id.account_uuid` | The Anthropic user account | All sessions, all devices |
| `metadata.user_id.device_id` | The machine | All sessions on that machine |

- **Session** = `sha256(metadata.user_id.session_id)` — unique per CLI instance, deterministic, works across any number of stateless gateways
- **Identity** = `metadata.user_id.account_uuid` — links all sessions for the same user account
- **Device** = `metadata.user_id.device_id` — groups sessions by machine

When metadata is not available (non-Claude-Code agents), falls back to content-based session derivation using the first user message hash.

**Security:** These values are self-asserted by the client, not cryptographically verified. Safe for audit attribution and usage analytics. Do NOT use for access control without cross-referencing against a server-verified identity.

### Data flow

```
Agent (Claude Code) → CONNECT gateway:8443 → TLS MITM → capture req/resp bytes
  → SHA-256 hash → gzip → ObjectStore (local filesystem or S3)
  → strip HTTP headers → decode chunked TE → decompress gzip → parse SSE events
  → extract metadata (session_id, account_uuid, device_id) from request body
  → resolve session (metadata-based or content-based fallback)
  → GraphStore (SQLite or PostgreSQL) via WritePipeline (retry + dead-letter queue)
```

### Driver/use-case boundary (architecture lint)

Recondo splits `gateway/src/` into two layers:

- **Drivers** — own async runtimes, sockets, TLS, DB clients, CLI, and HTTP. They are allowed to import `tokio`, `tokio_postgres`, `rustls`, `clap`, `reqwest`, `aws_sdk_s3`, `aws_config`.
- **Use-case modules** — pure business logic. Tested without spinning up a runtime. They MUST NOT import any of the crates above.

The `xtask` crate parses every `.rs` file under `gateway/src/` with `syn` and rejects forbidden references in non-driver files. The lint catches BOTH `use <forbidden_crate>::...;` statements AND qualified-path expressions like `reqwest::Client::builder()` (a use-case module cannot bypass the rule by writing fully-qualified paths). CI runs it via:

```bash
just lint-arch                                    # invoke directly
cargo run --quiet --package xtask -- lint-arch    # equivalent
```

First invocation triggers a one-time `xtask` build (~10-30s). Subsequent runs use the cached binary.

`just ci` chains it after `check` and `test`.

Driver paths (relative to `gateway/src/`, trailing `/` means the whole subtree):

```
main.rs
gateway/
storage/postgres.rs
storage/pipeline.rs
storage/pool.rs
storage/object.rs
storage/mod.rs
providers/mock.rs
capture/attachments.rs
alerts/
health/
metrics/
operator/
```

`capture/attachments.rs` is in the driver list because it owns external HTTP fetches (timeout, redirect policy, SSRF guards) via `reqwest`.

To add a new driver, append its path to `DRIVER_PATHS` in `xtask/src/main.rs` and document why in the commit message. Do NOT silence the lint by suppressing imports — the boundary exists so use-case logic stays runtime-free.

The workspace `Cargo.lock` lives at the repo root (`./Cargo.lock`), not under `gateway/`. Cargo generates and updates it from the root workspace manifest; the per-crate `gateway/Cargo.lock` is no longer used and is not tracked.

## Operations

### Orphan capture recovery

When the gateway crashes between writing capture metadata to disk and committing the corresponding `turns` row to the DB, the capture is "orphaned" — the bytes survive but no row exists. Recovery is automatic:

- **Startup hook** — `gateway::run_listener` sweeps `<data_dir>/captures/` before the TCP listener accepts traffic, replaying every orphan through the live parse + insert path. Runs synchronously, idempotent across restarts.
- **Manual reprocess** — `recondo-gateway reprocess [--dry-run] [--data-dir <path>]` runs the same sweep on demand. Use `--dry-run` to count orphans without writing.

### Recovery lock file

`<data_dir>/.recovery.lock` is an exclusive cross-process advisory file lock. Both the startup hook and the `reprocess` CLI acquire it before scanning, so an ops-mistake `reprocess` against a running daemon cannot race the live capture path. The lock is released automatically on process exit.

**Wedged-lock recovery procedure** — if a peer process crashed while holding the lock and the recovery hook reports `another recovery in progress`:

```bash
# 1. Identify the holder.
lsof <data_dir>/.recovery.lock

# 2a. If the PID is alive but stuck, signal it.
kill <PID>

# 2b. If lsof reports no holder (process is dead but the inode still exists),
# remove the lock file. The next gateway boot or `recondo reprocess`
# invocation will re-create it.
rm <data_dir>/.recovery.lock
```

Recovery failures are non-fatal: the gateway continues startup without recovery, and orphans remain on disk until the next boot or manual `reprocess` call.

### Recovery metrics

- `recondo_recovery_runs_total` — increments once per recovery invocation.
- `recondo_recovery_orphans_found_total` — orphans classified across runs.
- `recondo_recovery_recovered_total` — orphans successfully replayed.
- `recondo_recovery_failures_total{reason=...}` — per-reason failures (`parse`, `verify`, `insert`, `transient`, `validation`, `other`).

Operators should alert on sustained `recovery_failures_total{reason="transient"}` (suggests a downstream outage) and on any nonzero `recovery_failures_total{reason="verify"}` (suggests on-disk tampering).
