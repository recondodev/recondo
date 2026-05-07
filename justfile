# List all available targets
default:
    @echo "Build & Quality (Rust gateway)"
    @echo "  just setup            One-time setup — installs cargo-nextest"
    @echo "  just check            cargo fmt + clippy (no binary, fast feedback)"
    @echo "  just build            check, then builds the dev binary"
    @echo "  just release          check, then builds an optimized release binary"
    @echo "  just lint-arch        Architecture lint (forbids driver crates in use-case modules)"
    @echo "  just watch            Auto-rebuild on file changes"
    @echo ""
    @echo "Testing"
    @echo "  just test             Gateway tests (no testcontainers; gated by fmt+clippy+lint-arch)"
    @echo "  just test-all         Gateway tests + PG/S3 testcontainers (requires docker)"
    @echo "  just verify           Alias for test (full definition-of-done)"
    @echo "  just ci               Same as test (CI gateway-only)"
    @echo "  just ci-all           Same as test-all (CI with testcontainers)"
    @echo "  just ci-typescript    Full TS CI: data lint + version-check + build + tests + api tests"
    @echo ""
    @echo "Running the Gateway"
    @echo "  just run              Starts the gateway on :8443 with SQLite"
    @echo "  just trace            Same as run but with live req/resp trace output"
    @echo "  just recondo <args>   Runs any recondo CLI command against SQLite"
    @echo "  just pg <args>        Runs any recondo CLI command against PostgreSQL"
    @echo ""
    @echo "Local Dev Infrastructure"
    @echo "  just dev-infra        Starts MiniStack + PostgreSQL via Docker Compose"
    @echo "  just dev-setup        Starts dev-infra then runs api-migrate"
    @echo "  just dev-infra-down   Stops containers (data preserved)"
    @echo "  just dev-infra-reset  Stops containers and wipes all data volumes"
    @echo "  just dev-run-sqlite   Gateway with SQLite + local filesystem (no Docker needed)"
    @echo "  just dev-run          Gateway with PostgreSQL + MiniStack S3 (prod-like)"
    @echo "  just dev-run-local    Gateway with PostgreSQL + local filesystem objects"
    @echo "  just dev-trace        Same as dev-run but with live trace output"
    @echo "  just fullstack        Fully containerized: gateway + API + dashboard + PG + S3"
    @echo "  just fullstack-no-gw  Containerized API + dashboard + PG (run gateway yourself)"
    @echo "  just fullstack-down   Stops full stack (data preserved)"
    @echo "  just fullstack-reset  Stops full stack and wipes all data"
    @echo "  just fullstack-logs   View full-stack logs"
    @echo ""
    @echo "Routing AI Agents Through the Gateway (additive CA trust)"
    @echo "  just dev-trust        Sync gateway CA to ~/.recondo/ca/ca.crt (after fullstack)"
    @echo "  just dev-trust-local  Sync CA from a local-driver gateway data dir"
    @echo "  just dev-trust-reset  Wipe trusted CA and re-sync from gateway"
    @echo "  just cl               Launches Claude Code proxied through the gateway"
    @echo "  just gemini           Launches Gemini CLI proxied through the gateway"
    @echo "  just codex            Launches Codex (OpenAI) proxied through the gateway"
    @echo ""
    @echo "Terraform"
    @echo "  just tf-init          Terraform init against MiniStack"
    @echo "  just tf-plan          Terraform init + plan against MiniStack"
    @echo "  just tf-apply         Applies Terraform to MiniStack"
    @echo ""
    @echo "API Server (TypeScript GraphQL)"
    @echo "  just api-setup            Install API npm dependencies"
    @echo "  just api-migrate          Run all pending migrations (single source of truth)"
    @echo "  just api-migrate-create   Create a new migration file: just api-migrate-create <name>"
    @echo "  just api-migrate-down     Roll back the last applied migration"
    @echo "  just api-dev              Start API server in dev mode against local PostgreSQL"
    @echo "  just api-test             Run API tests (requires dev-infra)"
    @echo "  just api-check            Type-check API without running it"
    @echo ""
    @echo "Dashboard (React frontend)"
    @echo "  just dashboard-setup  Install dashboard npm dependencies"
    @echo "  just dashboard-dev    Start dashboard dev server on :5173"
    @echo ""
    @echo "TUI (Rust)"
    @echo "  just tui-build        Build the recondo-tui crate"
    @echo "  just tui [ARGS]       Run the recondo-tui binary (args after --)"
    @echo "  just tui-test         Run TUI tests via nextest"
    @echo ""
    @echo "@recondo/data Package"
    @echo "  just data-build       Build @recondo/data"
    @echo "  just data-test        Run @recondo/data tests"
    @echo "  just data-test-types  Type-check @recondo/data tests (tsc --noEmit)"
    @echo "  just data-lint-arch   Architecture lint for @recondo/data (no transport imports)"
    @echo ""
    @echo "MCP Server (recondo-mcp)"
    @echo "  just mcp-test         Build + run mcp tests (integration needs dev-infra+migrate)"
    @echo "  just mcp-lint-parity  Catalog parity lint (Phase 1 stub until C11)"
    @echo ""
    @echo "Workspace Pipeline (pnpm)"
    @echo "  just ws-install       pnpm install (workspace)"
    @echo "  just ws-build         pnpm -r build"
    @echo "  just ws-test          pnpm -r test"
    @echo "  just check-versions   Verify @recondo/data consumers all pin the same version"
    @echo ""
    @echo "Cleanup & Docs"
    @echo "  just clean            Remove build artifacts"
    @echo "  just doc              Build and open Rust docs in browser"

# Dev environment setup (run once after clone)
setup: _setup-cargo

_setup-cargo:
    cargo install --locked cargo-nextest

# Format + lint (fast feedback, no binaries)
check:
    cd gateway && cargo fmt --all
    cd gateway && cargo clippy -- -D warnings
    # Lint with the union of features so PG/S3-gated test files
    # (under #[cfg(feature = "postgres-tests")] / "s3-tests") get
    # type-checked. clippy doesn't run code, so no docker needed.
    cd gateway && cargo clippy --features test-support,postgres-tests,s3-tests --tests -- -D warnings

# Format + lint + build dev binary
build: check
    cd gateway && cargo build

# Build xtask (used by batch8_m4_tests). Pre-building once
# eliminates a parallel-cargo race that caused intermittent
# `spawn xtask: NotFound` flakes when many test binaries each
# invoked `cargo build --package xtask` simultaneously.
_build-xtask:
    cargo build --package xtask

# Architecture-discipline lint (M4): forbid driver crate imports in use-case modules.
lint-arch:
    cargo run --quiet --package xtask -- lint-arch

# Run every test that doesn't need testcontainers, gated by fmt +
# clippy + arch-lint. Fast pre-merge check, no docker required.
test: check lint-arch _build-xtask
    cd gateway && cargo nextest run --features test-support

# Run EVERY test, including PG + S3 testcontainers. Same gates as
# `just test`. Docker must be running and `cd api && npm ci` must
# have been run once (the pg_container fixture shells out to
# `npm run migrate`).
test-all: check lint-arch _build-xtask
    cd gateway && cargo nextest run --features test-support,postgres-tests,s3-tests

# Aliases for the old recipe names. Each lists the same prerequisites
# explicitly (rather than chaining through `test`/`test-all`) so the
# `m4_justfile_ci_runs_lint_arch` self-check sees `lint-arch` in the
# recipe body.
ci: check lint-arch _build-xtask
    cd gateway && cargo nextest run --features test-support

ci-all: check lint-arch _build-xtask
    cd gateway && cargo nextest run --features test-support,postgres-tests,s3-tests

# Full definition of done (alias for ci)
verify: test

# Build optimized release
release: check
    cd gateway && cargo build --release

# Run any recondo CLI command against SQLite (e.g., just recondo sessions)
recondo *args:
    cd gateway && cargo run -- {{args}}

# Run any recondo CLI command against PostgreSQL (e.g., just pg sessions)
pg *args:
    cd gateway && \
      RECONDO_STORE=postgres \
      RECONDO_DB_URL="postgres://recondo:recondo_dev@localhost:5432/recondo" \
      cargo run --features postgres -- {{args}}

# Start the gateway on :8443
run:
    cd gateway && cargo run -- serve

# Start the gateway with live trace output
trace:
    cd gateway && cargo run -- serve --trace

# Auto-rebuild on file changes
watch:
    cd gateway && cargo watch -x 'clippy'

# ---------- Local dev infrastructure (MiniStack + PostgreSQL) ----------

# Start local AWS emulator (MiniStack) + PostgreSQL via Docker Compose
dev-infra:
    docker compose -f docker-compose.dev.yml up -d
    @echo "Waiting for services..."
    @sleep 3
    @echo "PostgreSQL: localhost:5432 (recondo/recondo_dev)"
    @echo "MiniStack:  localhost:4566 (S3, KMS, IAM)"
    @echo ""
    @echo "Run 'just tf-plan' to validate Terraform against MiniStack."

# Start dev infrastructure and run migrations in one step.
#
# FIND-6-M: creates `recondo_test_empty` alongside `recondo` so the
# PG integration test `pg_without_tables_returns_actionable_error`
# has a legitimately-empty database to probe. The test expects to
# connect, fail to find recondo tables, and see an actionable error
# mentioning `api-migrate`. Without this DB existing, the test
# panics with "cannot connect" instead of exercising the real error
# path.
dev-setup:
    just dev-infra
    just api-setup
    @echo "Waiting for PostgreSQL to accept connections..."
    @until PGPASSWORD=recondo_dev psql -h localhost -p 5432 -U recondo -d postgres -c "SELECT 1" >/dev/null 2>&1; do sleep 1; done
    @PGPASSWORD=recondo_dev psql -h localhost -p 5432 -U recondo -d postgres -c "SELECT 1 FROM pg_database WHERE datname = 'recondo_test_empty'" | grep -q 1 \
      || PGPASSWORD=recondo_dev psql -h localhost -p 5432 -U recondo -d postgres -c "CREATE DATABASE recondo_test_empty;"
    just api-migrate

# Stop local dev infrastructure
dev-infra-down:
    docker compose -f docker-compose.dev.yml down

# Stop and wipe all local dev data (volumes)
dev-infra-reset:
    docker compose -f docker-compose.dev.yml down -v

# ---------- Fully containerized stack (gateway + PG + S3 in Docker) ----------

# Build and start everything: gateway + API + dashboard + PostgreSQL + MiniStack S3
fullstack:
    docker compose -f docker-compose.fullstack.yml up --build -d
    @echo ""
    @echo "Recondo full stack running:"
    @echo "  Dashboard:  http://localhost:3000"
    @echo "  API:        http://localhost:4000  (GraphQL)"
    @echo "  Gateway:    localhost:8443         (HTTPS proxy)"
    @echo "  PostgreSQL: localhost:5432"
    @echo "  MiniStack:  localhost:4566         (S3/KMS)"
    @echo ""
    @echo "Route agents through the gateway (additive trust — never disable TLS):"
    @echo "  just dev-trust       # one-time: copy gateway CA to ~/.recondo/ca/ca.crt"
    @echo "  just cl              # launch Claude Code through the gateway"
    @echo "  just gemini          # launch Gemini CLI through the gateway"
    @echo "  CODEX_CA_CERTIFICATE=\$HOME/.recondo/ca/ca.crt HTTPS_PROXY=http://localhost:8443 codex"
    @echo ""
    @echo "View captures:"
    @echo "  just pg sessions"
    @echo "  Open http://localhost:3000 in your browser"

# Build and start API + dashboard + Postgres (skip gateway — run it yourself with `just dev-run-local`)
fullstack-no-gw:
    docker compose -f docker-compose.fullstack.yml up --build -d postgres migrations api dashboard
    @echo ""
    @echo "Recondo stack (no gateway) running:"
    @echo "  Dashboard:  http://localhost:3000"
    @echo "  API:        http://localhost:4000  (GraphQL)"
    @echo "  PostgreSQL: localhost:5432"
    @echo ""
    @echo "Start the gateway on your host:"
    @echo "  just dev-run-local"

# Stop full stack (data preserved in volumes)
fullstack-down:
    docker compose -f docker-compose.fullstack.yml down

# Stop full stack and wipe all data
fullstack-reset:
    docker compose -f docker-compose.fullstack.yml down -v

# View full stack logs
fullstack-logs:
    docker compose -f docker-compose.fullstack.yml logs -f gateway

# Terraform init + plan against MiniStack (the local AWS emulator).
# TF_VAR_environment=local activates the endpoint overrides in provider.tf.
tf-init:
    cd deploy/terraform/aws && terraform init

tf-plan: tf-init
    cd deploy/terraform/aws && TF_VAR_environment=local terraform plan

tf-apply: tf-init
    cd deploy/terraform/aws && TF_VAR_environment=local terraform apply -auto-approve

# Run gateway against local PostgreSQL + MiniStack S3 (full production-like stack)
dev-run:
    cd gateway && \
      RECONDO_STORE=postgres \
      RECONDO_DB_URL="postgres://recondo:recondo_dev@localhost:5432/recondo" \
      RECONDO_OBJECTS=s3 \
      RECONDO_S3_BUCKET=recondo-objects-dev \
      AWS_ENDPOINT_URL=http://localhost:4566 \
      AWS_ACCESS_KEY_ID=test \
      AWS_SECRET_ACCESS_KEY=test \
      AWS_DEFAULT_REGION=us-east-1 \
      cargo run --features postgres,s3 -- serve

# Run gateway with SQLite + local filesystem objects (no Docker needed)
dev-run-sqlite:
    cd gateway && \
      RECONDO_STORE=sqlite \
      RECONDO_OBJECTS=local \
      cargo run -- serve

# Run gateway against local PostgreSQL + local object store (no S3 needed)
dev-run-local:
    cd gateway && \
      RECONDO_STORE=postgres \
      RECONDO_DB_URL="postgres://recondo:recondo_dev@localhost:5432/recondo" \
      RECONDO_OBJECTS=local \
      cargo run --features postgres -- serve

# Same as dev-run but with live req/resp trace output
dev-trace:
    cd gateway && \
      RECONDO_STORE=postgres \
      RECONDO_DB_URL="postgres://recondo:recondo_dev@localhost:5432/recondo" \
      RECONDO_OBJECTS=s3 \
      RECONDO_S3_BUCKET=recondo-objects-dev \
      AWS_ENDPOINT_URL=http://localhost:4566 \
      AWS_ACCESS_KEY_ID=test \
      AWS_SECRET_ACCESS_KEY=test \
      AWS_DEFAULT_REGION=us-east-1 \
      cargo run --features postgres,s3 -- serve --trace


# Copy the running gateway's CA into ~/.recondo/ca/ca.crt so host-side
# agents (Claude Code, Gemini CLI, Codex) can trust the gateway via
# NODE_EXTRA_CA_CERTS / CODEX_CA_CERTIFICATE — additive trust, never
# `NODE_TLS_REJECT_UNAUTHORIZED=0`. See docs/Recondo_MITM_and_CA_Strategy.md.
# Idempotent — re-run after `just fullstack-reset` (which wipes the gateway's
# named volume and triggers regeneration of the CA).
dev-trust:
    @mkdir -p "$HOME/.recondo/ca"
    @if docker ps --format '{{{{.Names}}' | grep -q '^recondo-gateway-1$'; then \
        docker cp recondo-gateway-1:/home/recondo/.recondo/ca/ca.crt "$HOME/.recondo/ca/ca.crt"; \
        echo "Installed gateway CA at $HOME/.recondo/ca/ca.crt"; \
        echo "  Claude Code:  uses NODE_EXTRA_CA_CERTS via 'just cl'"; \
        echo "  Codex:        uses CODEX_CA_CERTIFICATE pointing at the same path"; \
    else \
        echo "Gateway container not running — start it with 'just fullstack' first"; \
        exit 1; \
    fi

# Ensure the gateway CA exists and the key matches the cert, for the LOCAL
# (native) dev stack. Use this when running the gateway via `just dev-run-local`
# or `just run` (the gateway as a host process), rather than `just fullstack`
# (which uses the container-mode `dev-trust`).
#
# Self-healing: no-op when ~/.recondo/ca/ is already valid. Regenerates only
# when no CA exists or when ca.crt and ca.key are out of sync. The destructive
# rotate path is `dev-trust-reset`.
dev-trust-local:
    @set -e; \
    CA_DIR="$HOME/.recondo/ca"; \
    CRT="$CA_DIR/ca.crt"; \
    KEY="$CA_DIR/ca.key"; \
    if [ -f "$CRT" ] && [ -f "$KEY" ]; then \
        cert_pub=$(openssl x509 -in "$CRT" -pubkey -noout 2>/dev/null \
                   | openssl pkey -pubin -outform DER 2>/dev/null \
                   | shasum -a 256 | cut -d' ' -f1); \
        key_pub=$(openssl pkey -in "$KEY" -pubout -outform DER 2>/dev/null \
                  | shasum -a 256 | cut -d' ' -f1); \
        if [ -n "$cert_pub" ] && [ "$cert_pub" = "$key_pub" ]; then \
            echo "✓ CA is valid: cert and key match."; \
            echo "  Path: $CRT"; \
            echo "  (use 'just dev-trust-reset' to force-rotate)"; \
            exit 0; \
        fi; \
        echo "✗ CA cert/key mismatch detected — regenerating."; \
    else \
        echo "→ No CA found at $CA_DIR — generating."; \
    fi; \
    if lsof -ti:8443 >/dev/null 2>&1; then \
        echo "✗ Port 8443 is bound. Stop the gateway, then re-run."; \
        exit 1; \
    fi; \
    cd gateway && cargo run --quiet -- ca revoke >/dev/null 2>&1 || true; \
    rm -rf "$CA_DIR"; \
    cd gateway && cargo run -- init; \
    cd gateway && cargo run --quiet -- ca show; \
    echo ""; \
    echo "✓ CA installed at $CRT"; \
    echo "  Next: start the gateway ('just dev-run-local' or 'just run'), then 'just cl'."

# Force-rotate the gateway CA — destructive. Wipes ~/.recondo/ca/, revokes the
# CA from the system trust store, re-issues a fresh key + cert pair, and
# re-installs. Use when you want to rotate keys, when `dev-trust-local`
# diagnoses a mismatch you can't otherwise resolve, or after `fullstack-reset`
# wiped the gateway's volume.
dev-trust-reset:
    @if lsof -ti:8443 >/dev/null 2>&1; then \
        echo "✗ Port 8443 is bound — stop the gateway, then re-run."; \
        exit 1; \
    fi
    @echo "→ Revoking any installed CA from the system trust store ..."
    @cd gateway && cargo run --quiet -- ca revoke >/dev/null 2>&1 || true
    @echo "→ Wiping local CA directory ..."
    @rm -rf "$HOME/.recondo/ca"
    @echo "→ Generating fresh CA and installing into system trust store ..."
    @cd gateway && cargo run -- init
    @cd gateway && cargo run --quiet -- ca show
    @echo ""
    @echo "✓ Fresh CA installed at $HOME/.recondo/ca/ca.crt"
    @echo "  Next: start the gateway, then 'just cl'."

# Route Claude Code through the gateway with additive CA trust.
# Run `just dev-trust` once after `just fullstack` so ~/.recondo/ca/ca.crt
# matches the gateway's current CA. Never set NODE_TLS_REJECT_UNAUTHORIZED=0
# — that disables ALL TLS validation, not just for the gateway.
cl:
    HTTPS_PROXY=http://localhost:8443 \
        NODE_EXTRA_CA_CERTS="$HOME/.recondo/ca/ca.crt" \
        claude --dangerously-skip-permissions

# Route Gemini CLI through the gateway with additive CA trust.
gemini:
    HTTPS_PROXY=http://localhost:8443 \
        NODE_EXTRA_CA_CERTS="$HOME/.recondo/ca/ca.crt" \
        gemini

# Route Codex through the gateway (start gateway first with dev-run-local)
codex:
    CODEX_CA_CERTIFICATE=$HOME/.recondo/ca/ca.crt HTTPS_PROXY=http://localhost:8443 codex

# ---------- API server (TypeScript GraphQL) ----------

# Install API dependencies (pnpm workspace install — also links @recondo/data)
api-setup:
    pnpm install

# Run API database migrations via node-pg-migrate
api-migrate:
    cd api && \
      DATABASE_URL="postgres://recondo:recondo_dev@localhost:5432/recondo" \
      pnpm run migrate up

# Create a new migration file (e.g., just api-migrate-create add-notification-system)
api-migrate-create name:
    cd api && \
      DATABASE_URL="postgres://recondo:recondo_dev@localhost:5432/recondo" \
      pnpm run migrate create -- {{name}}

# Roll back the last applied migration
api-migrate-down:
    cd api && \
      DATABASE_URL="postgres://recondo:recondo_dev@localhost:5432/recondo" \
      pnpm run migrate down

# Start API server against local PostgreSQL (dev mode)
api-dev:
    cd api && \
      DATABASE_URL="postgres://recondo:recondo_dev@localhost:5432/recondo" \
      NODE_ENV=development \
      npx tsx src/index.ts

# Run API tests (requires dev-infra running)
api-test:
    @PGPASSWORD=recondo_dev psql -h localhost -p 5432 -U recondo -d postgres -tc \
      "SELECT 1 FROM pg_database WHERE datname = 'recondo_test'" | grep -q 1 \
      || PGPASSWORD=recondo_dev psql -h localhost -p 5432 -U recondo -d postgres -c \
      "CREATE DATABASE recondo_test;"
    @echo "Starting API server..."
    @cd api && DATABASE_URL="postgres://recondo:recondo_dev@localhost:5432/recondo_test" \
      NODE_ENV=test npx tsx src/index.ts &
    @sleep 3
    cd api && pnpm test; \
      EXIT=$?; \
      pkill -f "tsx src/index.ts" 2>/dev/null; \
      exit $EXIT

# Type-check API without running
api-check:
    cd api && npx tsc --noEmit

# ---------- Dashboard (React frontend) ----------

# Install dashboard dependencies (pnpm workspace install)
dashboard-setup:
    pnpm install

# Start dashboard dev server (hot-reload on :5173, talks to API on :4000)
dashboard-dev:
    cd dashboard && pnpm run dev


# ---------- Cleanup ----------

# Remove build artifacts
clean:
    cd gateway && cargo clean

# Build and open docs in browser
doc:
    cd gateway && cargo doc --no-deps --open

# ---------- TUI ----------

# Build the recondo-tui crate
tui-build:
    cd tui && cargo build

# Run the recondo-tui binary (pass args after `--`)
tui *ARGS:
    cd tui && cargo run -- {{ARGS}}

# Run TUI tests via nextest (matches the workspace test runner)
tui-test:
    cd tui && cargo nextest run

# @recondo/data package
data-build:
    pnpm --filter @recondo/data build

data-test:
    pnpm --filter @recondo/data test

data-test-types:
    pnpm --filter @recondo/data run test:types

data-lint-arch:
    pnpm --filter @recondo/data run lint:arch

# Workspace pipeline
ws-install:
    pnpm install

ws-build:
    pnpm -r build

ws-test:
    pnpm -r test

check-versions:
    node scripts/version-check.mjs

# Full TypeScript-side CI (data lint + version check + build + tests + api tests + mcp tests)
ci-typescript: ws-install data-lint-arch check-versions data-build data-test data-test-types
    cd api && pnpm test
    pnpm --filter recondo-mcp build
    pnpm --filter recondo-mcp test

# ---------- MCP Server (recondo-mcp) ----------

# MCP test runner (unit + integration; integration requires `just dev-infra` + `just api-migrate`)
mcp-test:
    pnpm --filter recondo-mcp build
    pnpm --filter recondo-mcp test

# Catalog parity lint (Phase 1 — name parity only; replaced in C11)
mcp-lint-parity:
    pnpm --filter recondo-mcp build
    node mcp/dist/scripts/catalog-parity-lint.js
