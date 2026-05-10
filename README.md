# Recondo

[![CI](https://github.com/recondodev/recondo/actions/workflows/gateway-ci.yml/badge.svg)](https://github.com/recondodev/recondo/actions/workflows/gateway-ci.yml)
[![Rust](https://img.shields.io/badge/rust-1.95.0-orange.svg)](rust-toolchain.toml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

**The visibility and control layer for coding-agent traffic.**

Self-hosted. Multi-vendor. Zero touch.

Run on-prem or in your own cloud account (AWS Terraform module included).

Recondo sits on the network path between coding agents (Claude Code, Codex, Cursor, Aider, Gemini-based agents) and their LLM providers. Every request and response flows through it — visible in one place, controllable at the wire. Cap spend per team, redact secrets before they leave the network, route or block by provider, model, or developer.

Under the hood, it's a transparent TLS-intercepting proxy: traffic is captured, hashed, compressed, and stored in a content-addressable object store, then structured into sessions, turns, and tool calls. No SDKs, no instrumentation, no developer workflow change.

## Demo

### TUI: cross-tool god-view (60s)

<!-- video: docs/site/demos/assets/tui-60s.mp4 -->

### MCP: your agents introspect their own history (30s)

<!-- video: docs/site/demos/assets/mcp-30s.mp4 -->

## Why Teams Run It

- **Network-Layer Capture** — Sit on the wire between agents and providers. No SDK swap, no agent code modification, no developer workflow change.
- **Single Vantage Across Providers** — Anthropic, OpenAI / Codex, and Gemini through one gateway. One dashboard, one set of controls, one invoice reconciliation.
- **Per-Team Attribution & Spend Caps** — Trace every request to a developer, repo, or team. Cap spend per team before the next runaway loop closes the books.
- **Wire-Level Control** — Redact secrets, route by model, throttle by team, or block a provider — at the network layer, before bytes leave your network.
- **Hash-Verified Capture** — Every request and response is SHA-256 hashed and stored content-addressed. Bytes don't change silently after the fact.
- **BYOC** — Keep agent data in your environment: local filesystem or your own S3 + KMS.

## Who It's For

- **Platform and engineering leaders** — visibility into real coding-agent usage across teams, providers, and projects.
- **FinOps and engineering finance** — per-team and per-developer attribution so the next $380K Anthropic invoice has names attached.
- **Security and infrastructure teams** — secret redaction at the wire, plus a single chokepoint for routing, blocking, or rate-limiting providers.

## Key Features

- **Transparent Proxy** — Zero-config HTTPS MITM proxy via `CONNECT` tunneling. Agents connect through it without code changes.
- **Multi-Provider Support** — Anthropic (Claude), OpenAI (GPT/Codex), and Google (Gemini) with automatic provider detection.
- **Content-Addressable Storage** — SHA-256 content-addressable object store with gzip compression. Every request and response body is independently re-hashable; `recondo verify <session-id>` re-hashes and compares.
- **Session Intelligence** — Automatic session boundary detection (time gaps, prompt changes), turn-by-turn tracing, intent extraction, and cost accounting.
- **Append-Only Capture Storage** — `turns` and `tool_calls` are write-once (a PostgreSQL trigger blocks `UPDATE` and `DELETE`). Bodies live in an S3 Object Lock bucket with KMS customer-managed encryption. What was captured stays captured.
- **WebSocket Support** — Captures WebSocket-based protocols (e.g., OpenAI Codex via `chatgpt.com`).
- **CLI Inspector** — Built-in CLI for browsing sessions, searching turns, viewing stats, and verifying content hashes.
- **Corporate Firewall Compatible** — Works behind SSL-inspecting firewalls (Zscaler, Blue Coat, Palo Alto) with extra CA certificate loading.

## Architecture

```
Coding Agent (Claude Code / Codex)
  │
  │  CONNECT gateway:8443
  ▼
┌─────────────────────────────────┐
│         Recondo Gateway         │
│                                 │
│  ┌─────────┐    ┌────────────┐  │
│  │   TLS   │───▶│  Capture   │  │
│  │  MITM   │    │  Pipeline  │  │
│  └─────────┘    └─────┬──────┘  │
│                       │         │
│         ┌─────────────┼─────┐   │
│         ▼             ▼     ▼   │
│    ┌─────────┐  ┌────────┐ ┌──┐ │
│    │ Provider│  │ Object │ │DB│ │
│    │ Parser  │  │ Store  │ │  │ │
│    └─────────┘  └────────┘ └──┘ │
└─────────────────────────────────┘
         │              │       │
         ▼              ▼       ▼
    Anthropic/     S3 / Local  PostgreSQL /
    OpenAI/        Filesystem  SQLite
    Gemini
```

**Language:** Rust (gateway + CLI + TUI), TypeScript (API + dashboard + MCP server + `@recondo/data` package)
**Storage:** SQLite (dev) / PostgreSQL (prod)
**Object Store:** Local filesystem (dev) / S3 with Object Lock (prod)
**Encryption:** KMS customer-managed keys (prod)
**Infrastructure:** Terraform (AWS), Docker Compose (local dev)

### Gateway Modules

| Module | Purpose |
|--------|---------|
| `tls/` | CA generation, per-host leaf certificates, system trust store management |
| `capture/` | Request/response interception, capture pipeline orchestration |
| `stream/` | SSE stream accumulator for streaming LLM responses |
| `websocket/` | WebSocket frame parsing, encoding, masking, and relay |
| `providers/` | LLM provider detection and response parsing (Anthropic, OpenAI, Gemini) |
| `schema/` | Core capture data type: `CaptureRecord` |
| `db/` | Session/turn record types (`SessionRecord`, `TurnRecord`) and database operations — SQLite and PostgreSQL with additive migrations |
| `session/` | Session boundary detection (time gaps, prompt hash changes, sequences) |
| `store/` | Content-addressable object storage (local filesystem, S3) |
| `storage/` | Storage backend abstractions, graph store, pipeline |
| `hash/` | SHA-256 content hashing |
| `wal/` | Write-ahead log for crash-safe capture persistence |
| `gateway/` | Main gateway server: TCP listener, TLS handshake, request routing |
| `operator/` | Operator sidecar (exposed via `cargo run -- operator`) for runtime control and reporting |
| `config/`, `health/`, `status/`, `metrics/`, `alerts/`, `drift/`, `artifacts/` | Operational subsystems: configuration, liveness, status reporting, metrics, alerting, drift/anomaly detection, code-artifact extraction |

### Data Flow

```
Agent → CONNECT gateway:8443 → TLS MITM → capture req/resp bytes
  → SHA-256 hash → gzip → object store (S3 or local)
  → parse provider response (tokens, model, cost, tool calls)
  → session boundary detection → DB insert (sessions, turns, tool_calls)
  → metadata → captures/{timestamp}_{uuid}.json
```

### Database Schema

| Table | Purpose |
|-------|---------|
| `sessions` | Session metadata: provider, model, token/cost totals, intent, git context |
| `turns` | Append-only turn records with content hashes, token counts, and object store refs |
| `tool_calls` | Append-only tool invocations within a turn |
| `anomaly_events` | Detected anomalies: prompt injection, secret exposure, drift, and other detector hits |
| `access_audit_log` | Append-only log of API-key access events |

Operational tables (alerts, GDPR deletion requests, agent baselines, session risk, export schedules, attachments, heartbeats, policies, registered keys, compliance frameworks) are defined in [`api/migrations/`](api/migrations/).

`turns` and `tool_calls` are **append-only** — a PostgreSQL trigger refuses any `UPDATE` or `DELETE` on either table (`api/migrations/003_triggers-indexes.sql`), so capture content cannot be silently rewritten after the fact.

## Quick Start

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [just](https://github.com/casey/just) (optional, recommended)
- [Docker](https://docs.docker.com/get-docker/) (for PostgreSQL + MiniStack dev stack)

### Build & Run

```bash
# One-time setup
just setup               # installs cargo-nextest

# Build (includes fmt + clippy)
just build

# Start the gateway on :8443
just run
```

Or without `just`:
```bash
cd gateway && cargo build
cd gateway && cargo run -- init        # one-time: generate CA + install into trust store
cd gateway && cargo run -- serve
```

### Route Claude Code Through the Gateway

```bash
# Terminal 1: start the gateway
just run

# Terminal 2: launch Claude Code with the gateway CA trusted
NODE_EXTRA_CA_CERTS=$HOME/.recondo/ca/ca.crt HTTPS_PROXY=http://localhost:8443 claude
```

> `NODE_EXTRA_CA_CERTS` adds the gateway CA to Node.js's bundled trust list (Node.js does not read the OS trust store by default). Do **not** use `NODE_TLS_REJECT_UNAUTHORIZED=0` — it disables all certificate validation and defeats the purpose of running a CA.

### Route Codex Through the Gateway

```bash
CODEX_CA_CERTIFICATE=$HOME/.recondo/ca/ca.crt HTTPS_PROXY=http://localhost:8443 codex
```

> **Note:** The proxy URL is `http://` — the CONNECT handshake is plain HTTP; TLS happens inside the tunnel. `NODE_TLS_REJECT_UNAUTHORIZED=0` tells Node.js to trust the gateway's self-signed MITM cert. Codex uses `CODEX_CA_CERTIFICATE` instead.

### Verify Captures

```bash
ls ~/.recondo/objects/req/    # gzipped request bodies
ls ~/.recondo/objects/resp/   # gzipped response bodies
ls ~/.recondo/captures/       # JSON metadata linking req/resp hashes
```

## CLI

Recondo includes a built-in CLI for inspecting captured data.

```bash
# List all captured sessions
just recondo sessions

# Show turn-by-turn trace for a session
just recondo session <session-id>

# Compact turn list (no response text)
just recondo session <session-id> --turns

# Show single turn detail (tokens, hashes, tool calls, full text)
just recondo turn <turn-id>

# Search turns by content
just recondo search "error handling"

# Aggregate statistics
just recondo stats

# Verify content hashes for a session (re-hash + compare)
just recondo verify <session-id>
```

### CA Certificate Management

```bash
just recondo init              # Generate CA + install into system trust store
just recondo ca show           # Show CA fingerprint, subject, validity
just recondo ca export cert.pem  # Export CA cert to file
just recondo ca revoke         # Remove CA from system trust store
```

## TUI

Terminal UI for live audit + spend visibility against a running gateway. Five lenses:

| Lens | Purpose |
|------|---------|
| **Realtime** | Live gateway throughput, provider mix, recent turns |
| **Sessions** | Audit trail by user/device/account with drill-to-turn |
| **Cost** | Token spend by model/provider, daily trends, sparklines |
| **Agents** | Agent-framework distribution, top developers, repo hotspots |
| **Audit** | Compliance audit trail with GraphQL polling |

```bash
just tui-build                 # build the recondo-tui crate
just tui                       # launch against the local API
```

See [`docs/site/tui/`](docs/site/tui/) for first-run, install, and keybinding reference.

## MCP Server

Model Context Protocol server (`recondo-mcp`) exposes the capture corpus to coding agents as 60+ tools — read paths (sessions, turns, search, compliance), action tools (gated by an injection-warning guard), 4 prompts, and 3 resources. Agents like Claude Code or Cursor connect via the MCP transport and introspect their own history.

```bash
just mcp-test                  # build + run MCP test suite
just mcp-lint-parity           # catalog name-parity lint
```

Install guides: [Claude Code](docs/site/mcp/install-claude-code.md) · [Cursor](docs/site/mcp/install-cursor.md) · [Goose](docs/site/mcp/install-goose.md). Tool catalog: [`docs/site/mcp/tool-catalog.md`](docs/site/mcp/tool-catalog.md).

## Development

### Running Tests

```bash
just test                # 1,530 tests that don't need testcontainers (no docker)
just test-all            # 1,574 tests including PG + S3 testcontainers (needs docker)
```

Both recipes run `fmt + clippy + lint-arch` first, so they're full pre-merge
gates rather than bare `nextest` invocations. `just ci` and `just ci-all` are
aliases for the matching test recipe.

Integration tests that need PostgreSQL or S3 spawn their own ephemeral
containers via [`testcontainers-rs`](https://docs.rs/testcontainers) — there
is no `just dev-infra` prerequisite. The only requirements for `just test-all`
are a running Docker daemon and `cd api && npm ci` having been run once (the
PG fixture shells out to `npm run migrate` for schema setup).

Run a specific test suite:
```bash
cd gateway && cargo nextest run --test tls_mitm_tests
cd gateway && cargo nextest run --test session_tests
cd gateway && cargo nextest run --test capture_integration_tests
```

### PostgreSQL + MiniStack (Production-Like Stack)

For development with PostgreSQL and S3 emulation:

```bash
# Terminal 1: start infrastructure + run migrations (single source of truth)
just dev-setup           # = just dev-infra + just api-migrate

# Terminal 2: start gateway connected to local PG
just dev-run-local

# Terminal 3: start the API server
just api-dev

# Terminal 4: start the dashboard
just dashboard-dev

# Terminal 5: route Claude Code through the gateway
just cl                  # = HTTPS_PROXY + NODE_EXTRA_CA_CERTS, then `claude`
```

| Command | Description |
|---------|-------------|
| `just dev-setup` | Start dev-infra + run all migrations (with PG readiness check) |
| `just dev-infra` | Start MiniStack (S3, KMS, IAM on :4566) + PostgreSQL 17 (:5432) |
| `just dev-infra-down` | Stop containers (data preserved in volumes) |
| `just dev-infra-reset` | Stop containers and delete all data volumes |
| `just api-migrate` | Run all migrations (single source of truth for the PostgreSQL schema) |
| `just api-migrate-down` | Roll back the last applied migration |
| `just dev-run-local` | Gateway with PostgreSQL + local object store |
| `just dev-run` | Gateway with PostgreSQL + S3 (full prod-like stack) |
| `just dev-trace` | Same as `dev-run` with live request/response tracing |
| `just api-dev` | Start the TypeScript GraphQL API server |
| `just dashboard-dev` | Start the dashboard dev server on :5173 |
| `just cl` / `just gemini` / `just codex` | Launch the matching agent through the gateway with the CA pre-loaded |
| `just test-all` | Run every gateway test, including PG + S3 testcontainers (needs docker) |
| `just tf-plan` | Terraform plan against MiniStack |
| `just tf-apply` | Apply Terraform to MiniStack |

PostgreSQL connection: `localhost:5432`, database `recondo`, user `recondo`, password `recondo_dev`.

### Terraform (AWS Infrastructure)

The `deploy/terraform/aws/` module provisions:

- **S3** — Content-addressable object store with versioning, Object Lock (COMPLIANCE mode, 365-day retention), lifecycle policies (IA at 90d, Glacier at 365d), and public access block
- **KMS** — Customer-managed encryption key with automatic rotation
- **IAM** — Gateway execution role with least-privilege S3/KMS access, plus cross-account ops role for control plane access

```bash
# Validate against MiniStack
just tf-plan
just tf-apply

# Real AWS deployment
cd deploy/terraform/aws && terraform plan
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RECONDO_STORE` | `sqlite` | Storage backend: `sqlite` or `postgres` |
| `RECONDO_DB_URL` | — | PostgreSQL connection string |
| `RECONDO_OBJECTS` | `local` | Object store: `local` or `s3` |
| `RECONDO_S3_BUCKET` | — | S3 bucket name for object storage |
| `RECONDO_DATA_DIR` | `~/.recondo` | Override the gateway's local data directory |
| `RECONDO_EXTRA_CA_CERTS` | — | Path to extra CA certs (corporate firewalls) |
| `AWS_ENDPOINT_URL` | — | S3-compatible endpoint override for MiniStack/LocalStack/MinIO (e.g. `http://localhost:4566`) |

### Corporate TLS Inspection

If your network re-signs TLS certificates (Zscaler, Blue Coat, Palo Alto, etc.):

```bash
# Option A: auto-discovery path (recommended — do once)
cp /path/to/corporate/CA.pem ~/.recondo/ca/extra_roots.pem

# Option B: env var (per-session)
RECONDO_EXTRA_CA_CERTS=/path/to/corporate/CA.pem just run
```

The gateway logs `Loaded extra CA certificates for upstream TLS` on startup when detected.

### Project Layout

```
recondo/
├── gateway/                  # Rust gateway binary + library
│   ├── src/
│   │   ├── main.rs           # CLI entry point + command handlers
│   │   ├── lib.rs            # Public module exports
│   │   ├── tls/              # TLS/CA certificate management
│   │   ├── gateway/          # TCP listener, proxy server
│   │   ├── capture/          # Capture pipeline
│   │   ├── stream/           # SSE accumulator
│   │   ├── websocket/        # WebSocket support
│   │   ├── providers/        # LLM provider parsers
│   │   ├── schema/           # Core data types
│   │   ├── db/               # Database layer
│   │   ├── session/          # Session detection
│   │   ├── store/            # Object store
│   │   ├── storage/          # Storage abstractions
│   │   ├── hash/             # SHA-256 hashing
│   │   └── wal/              # Write-ahead log
│   └── tests/                # 1,556 integration tests (1,530 default-feature + 44 testcontainer-gated)
├── tui/                      # recondo-tui — terminal UI (Rust, ratatui + tokio)
├── mcp/                      # recondo-mcp — Model Context Protocol server (TypeScript)
├── packages/
│   └── recondo-data/         # @recondo/data — shared data layer (queries, marshalling, transport)
├── api/                      # Fastify + Apollo GraphQL API (TypeScript)
├── dashboard/                # React + Vite dashboard (TypeScript)
├── compliance/               # Provider-compatibility / control-mapping reference docs
├── docs/                     # Design and reference documentation
├── deploy/
│   ├── terraform/aws/        # Production AWS infrastructure
│   └── local-dev/            # Local dev init scripts (PostgreSQL + MiniStack)
├── docker-compose.dev.yml    # PostgreSQL + MiniStack
└── justfile                  # Task runner commands
```

## Storage and Hardening

Operational properties of the capture pipeline:

- **Append-only capture** — `turns` and `tool_calls` are write-once. A PostgreSQL trigger blocks `UPDATE` and `DELETE`; captures cannot be silently rewritten.
- **Hash-verified bytes** — Every request and response is SHA-256 hashed and stored content-addressed. Run `recondo verify <session-id>` to re-hash and compare.
- **Encryption at rest** — KMS customer-managed keys, S3 server-side encryption.
- **Encryption in transit** — TLS to and from the gateway; the gateway terminates the agent leg only to capture plaintext bytes, then re-encrypts upstream.
- **Object Lock** — S3 bucket runs in Object Lock `COMPLIANCE` mode (365-day retention by default). Deleted from the database is not the same as deleted from the object store.
- **Lifecycle policies** — Standard → Infrequent Access at 90 days → Glacier at 365 days.

## License

[Apache License 2.0](LICENSE).
