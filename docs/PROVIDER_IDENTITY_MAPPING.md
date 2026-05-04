# Provider Identity Mapping

How Recondo derives session identity, user attribution, and agent metadata from each LLM provider's traffic. Based on reverse-engineering captured request/response data flowing through the gateway.

Last updated: 2026-03-20

---

## Overview

Each LLM provider's agent tooling sends identity signals differently. Recondo must extract a common set of identity primitives from each provider to enable consistent session tracking, user attribution, and compliance reporting across all providers.

### Common identity model

Every captured session resolves to these fields on `SessionRecord`:

| Field | Purpose | Required for |
|-------|---------|-------------|
| `session_id` | Groups turns into one conversation | Session timeline, turn sequencing |
| `account_uuid` | Identifies the user account | Cross-session attribution, cost allocation, compliance audit trail |
| `device_id` | Identifies the machine | Multi-device usage analysis |
| `framework` | Identifies the agent (Claude Code, Codex, etc.) | Agent-level analytics, framework detection |
| `agent_version` | Agent software version | Version tracking, regression correlation |

---

## Anthropic (Claude Code)

**Transport:** HTTP SSE to `api.anthropic.com`
**Identity source:** JSON request body field `metadata.user_id`

### How it works

Claude Code sends a JSON string inside `metadata.user_id` on every API request to the Anthropic Messages API. The string contains nested JSON with three identity fields.

### Raw example (captured 2026-03-20)

```json
{
  "model": "claude-sonnet-4-20250514",
  "messages": [...],
  "metadata": {
    "user_id": "{\"device_id\":\"5a65b564c1c7...\",\"account_uuid\":\"a154da90-5c17-4b33-...\",\"session_id\":\"7a1bfa93-2985-479e-...\"}"
  },
  "max_tokens": 16384,
  "stream": true
}
```

### Field mapping

| Source field | Recondo field | Stability | Notes |
|-------------|---------------|-----------|-------|
| `metadata.user_id.session_id` | `session_id` | Stable for one Claude Code CLI instance | Changes when a new CLI session starts |
| `metadata.user_id.account_uuid` | `account_uuid` | Stable across all sessions, all devices | Anthropic user account UUID |
| `metadata.user_id.device_id` | `device_id` | Stable across all sessions on one machine | SHA-256 of machine-specific data |

### Extraction path

1. Parse request body as JSON (strip HTTP headers first via `stream::strip_http_headers`)
2. Read `metadata.user_id` as a string
3. Parse that string as nested JSON
4. Extract `session_id`, `account_uuid`, `device_id`

### Implementation

- **Module:** `gateway/src/session/mod.rs`
- **Function:** `extract_client_metadata(request_body: &[u8]) -> ClientMetadata`
- **Called from:** `process_capture` in `gateway/src/gateway/mod.rs`
- **Fallback:** Returns `ClientMetadata::default()` (all `None`) on any parse failure

### Security

Self-asserted by the client (Claude Code). Not cryptographically verified. A malicious agent could forge any field. Safe for audit attribution and usage analytics. Do NOT use for access control without server-side verification.

---

## OpenAI (Codex CLI)

**Transport:** WebSocket to `chatgpt.com` (path: `/backend-api/codex/responses`)
**Identity source:** HTTP headers on the WebSocket upgrade request + JWT Bearer token

### How it works

Codex CLI (Rust binary) opens a WebSocket connection to `chatgpt.com`. The identity metadata is carried in HTTP headers on the initial `GET` upgrade request — not in the WebSocket message payloads. Each WebSocket connection represents one conversation turn.

### Raw example (captured 2026-03-20, Codex CLI v0.116.0)

```
GET /backend-api/codex/responses HTTP/1.1
Host: chatgpt.com
Connection: Upgrade
Upgrade: websocket
Sec-WebSocket-Version: 13
Sec-WebSocket-Key: nbRo0WrJbL0MftpKD1AdQA==
chatgpt-account-id: b9f1456e-6e84-4215-929e-c6bb856f090e
originator: codex_cli_rs
openai-beta: responses_websockets=2026-02-06
session_id: 019d0d8e-03be-7382-9e5f-3cc32940c9cb
version: 0.116.0
x-codex-beta-features: prevent_idle_sleep
x-codex-turn-metadata: {"turn_id":"","sandbox":"seatbelt"}
x-client-request-id: 019d0d8e-03be-7382-9e5f-3cc32940c9cb
authorization: Bearer eyJhbGciOiJSUzI1NiIs...
sec-websocket-extensions: permessage-deflate; client_max_window_bits
```

### JWT payload (decoded from Bearer token)

```json
{
  "aud": ["https://api.openai.com/v1"],
  "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
  "https://api.openai.com/auth": {
    "chatgpt_account_id": "b9f1456e-6e84-4215-929e-c6bb856f090e",
    "chatgpt_user_id": "user-Oc2KvYS7iGtVsvhiZ8YLRGfw",
    "chatgpt_plan_type": "pro",
    "user_id": "user-Oc2KvYS7iGtVsvhiZ8YLRGfw"
  },
  "https://api.openai.com/profile": {
    "email": "...",
    "email_verified": true
  },
  "session_id": "authsess_iCpbUtxGu5dCGdKudUvtpO2l",
  "sub": "google-oauth2|116702623196741431869"
}
```

### Field mapping

| Source | Recondo field | Stability | Notes |
|--------|---------------|-----------|-------|
| Header `session_id` | `session_id` | Per WebSocket connection | Changes on every new WS connection. Each connection is one conversation. |
| Header `chatgpt-account-id` | `account_uuid` | Stable across all sessions, all devices | OpenAI account UUID. Also in JWT as `chatgpt_account_id`. |
| *(not available)* | `device_id` | — | Codex CLI does not send a machine identifier |
| Header `originator` | `framework` | Stable for all Codex sessions | Value: `codex_cli_rs` |
| Header `version` | `agent_version` | Until agent upgrade | e.g., `0.116.0` |
| JWT `chatgpt_plan_type` | *(new field TBD)* | Stable until plan change | `pro`, `plus`, `free`, etc. |
| Header `x-codex-turn-metadata` | *(per-turn metadata)* | Per request | JSON with `turn_id`, `sandbox` mode |

### Observed session_id behavior

Captured two consecutive requests from the same Codex CLI instance:

| Capture | `session_id` header | `chatgpt-account-id` header |
|---------|--------------------|-----------------------------|
| 1st request | `019d0d8e-03be-7382-9e5f-3cc32940c9cb` | `b9f1456e-6e84-4215-929e-c6bb856f090e` |
| 2nd request | `019d0d8e-a133-7960-8c19-afe8a3795bdd` | `b9f1456e-6e84-4215-929e-c6bb856f090e` |

- `session_id` **changes per WebSocket connection** (per turn)
- `chatgpt-account-id` **is stable** across connections

This means the header `session_id` is NOT equivalent to Anthropic's CLI session. It's a per-connection/per-turn ID. For Recondo's session grouping, we should use the WebSocket connection lifetime (one WS connection = one session) or group by `chatgpt-account-id` + time window.

### JWT additional fields (available but not yet extracted)

| JWT claim | Value | Potential use |
|-----------|-------|--------------|
| `sub` | `google-oauth2\|116702...` | OAuth provider + external user ID |
| `session_id` (JWT-level) | `authsess_iCpbUtxGu5dCGdKudUvtpO2l` | Auth session — stable across CLI invocations until token expiry |
| `chatgpt_user_id` | `user-Oc2KvYS7iGtVsvhiZ8YLRGfw` | OpenAI's user ID (stable, alternative to account_id) |
| `email` | (user's email) | PII — do not store without consent |
| `exp` / `iat` | Unix timestamps | Token validity window |

### Extraction path

1. Parse the WebSocket upgrade request (HTTP GET with `Upgrade: websocket`)
2. Extract identity from HTTP headers:
   - `chatgpt-account-id` -> `account_uuid`
   - `session_id` -> per-connection session ID
   - `originator` -> `framework`
   - `version` -> `agent_version`
   - `x-codex-turn-metadata` -> per-turn metadata (JSON)
3. Optionally: decode JWT from `authorization: Bearer ...` for `chatgpt_user_id`, plan type
   - JWT is RS256-signed by OpenAI — verifiable if we fetch OpenAI's JWKS, but not required for audit purposes

### Implementation (Sprint 3 — not yet built)

- **Extract from:** WebSocket upgrade request headers (already captured to disk as `objects/req/`)
- **New function needed:** `extract_openai_metadata(upgrade_headers: &str) -> ClientMetadata`
- **Called from:** `websocket_relay` or `capture_websocket_frame_via_pipeline` in `gateway/src/gateway/mod.rs`
- **Key difference from Anthropic:** Identity is in HTTP headers, not JSON body

### Security

The `chatgpt-account-id` header is client-asserted (same caveat as Anthropic). However, the JWT Bearer token IS cryptographically signed (RS256 by `https://auth.openai.com`). In principle, Recondo could verify the JWT signature against OpenAI's public JWKS endpoint to get server-verified identity — stronger than Anthropic's fully self-asserted metadata. Not implemented yet; not required for Phase 2.

---

## Google (Gemini)

**Transport:** HTTP SSE to `generativelanguage.googleapis.com`
**Identity source:** TBD — not yet reverse-engineered

Gemini is detected as a provider (`providers::detect_provider` returns `"google"`) and responses are parsed (`providers/google.rs`), but no agent CLI equivalent to Claude Code or Codex has been captured through the gateway yet. Session identity extraction for Gemini will be added when a Gemini-based agent is available for traffic capture.

### Expected approach

Google's API uses API keys or OAuth2 tokens in the `Authorization` header or `x-goog-api-key` header. Identity extraction will likely come from:
- API key hash (for key-based auth)
- OAuth2 token claims (for user-based auth)
- Request body metadata (if the agent framework adds any)

---

## Parity matrix

| Capability | Anthropic | OpenAI/Codex | Google/Gemini |
|-----------|-----------|-------------|---------------|
| Session tracking | `metadata.user_id.session_id` | Header `session_id` (per-WS-conn) | TBD |
| Account attribution | `metadata.user_id.account_uuid` | Header `chatgpt-account-id` | TBD |
| Device grouping | `metadata.user_id.device_id` | *Not available* | TBD |
| Framework detection | Content heuristic | Header `originator` | TBD |
| Agent version | *Not available* | Header `version` | TBD |
| Plan/tier | *Not available* | JWT `chatgpt_plan_type` | TBD |
| Server-verifiable | No (self-asserted) | Yes (JWT RS256) | TBD |
| Transport | HTTP SSE | WebSocket | HTTP SSE |

### Gaps and mitigations

| Gap | Impact | Mitigation |
|-----|--------|-----------|
| No OpenAI `device_id` | Cannot group sessions by machine | Group by `chatgpt-account-id` + IP subnet (if available from gateway connection metadata) |
| OpenAI `session_id` is per-connection, not per-CLI-instance | Sessions are more granular than Anthropic | Use WS connection lifetime as session boundary; the `chatgpt-account-id` still links all sessions for one user |
| Gemini identity not yet mapped | No session/user tracking for Gemini | Capture Gemini agent traffic when available; API key hash provides minimal attribution |

---

## Implementation notes

### ClientMetadata struct

The existing `ClientMetadata` struct in `gateway/src/session/mod.rs` supports all providers:

```rust
pub struct ClientMetadata {
    pub session_id: Option<String>,
    pub account_uuid: Option<String>,
    pub device_id: Option<String>,
}
```

For OpenAI, `device_id` will be `None`. The struct may be extended with optional fields for provider-specific data (e.g., `framework`, `agent_version`, `plan_type`) as needed.

### Extraction dispatch

The gateway should dispatch metadata extraction based on provider:

```
provider == "anthropic" -> extract from JSON request body (metadata.user_id)
provider == "openai"    -> extract from WebSocket upgrade HTTP headers
provider == "google"    -> TBD
provider == "unknown"   -> content-based fallback (first user message hash)
```

### What we do NOT extract

- **Email addresses** from JWT claims — PII, not needed for session tracking
- **Full JWT tokens** — stored in raw captured bytes but not parsed into structured fields
- **OAuth `sub` claims** — external identity provider IDs, not useful for Recondo's identity model
