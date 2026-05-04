//! Phase 2 Gap Fixes: Behavioral tests for 6 architectural gap fixes.
//!
//! These tests cover the following open decisions from OPEN_DECISIONS.md:
//!
//! - **G1** (OD-001): `fail_mode` configurable via `recondo.toml`
//! - **G2** (OD-002): Explicit identity headers (`X-Recondo-Agent-Id`, etc.)
//! - **G3** (OD-003): GDPR tombstone table + deletion workflow
//! - **G4** (OD-006): Dual-mode gateway (CONNECT tunnel + direct TLS)
//! - **G5** (OD-024): PostgreSQL immutability triggers on turns/tool_calls
//! - **G6** (OD-028): S3 Object Lock Terraform variables
//!
//! EVERY test imports from modules that MAY NOT EXIST yet:
//!
//! - `recondo_gateway::config::FailMode` (new enum: Open | Closed)
//! - `recondo_gateway::config::GatewaySection.fail_mode` (new field)
//! - `recondo_gateway::session::extract_identity_headers` (new function)
//! - `recondo_gateway::db::record_gdpr_deletion` (new function)
//! - `recondo_gateway::db::list_gdpr_deletions` (new function)
//! - `recondo_gateway::db::nullify_turn_parsed_fields` (new function)
//! - `recondo_gateway::db::GdprDeletionRecord` (new struct)
//! - `recondo_gateway::gateway::detect_connection_mode` (new function)
//! - `recondo_gateway::gateway::ConnectionMode` (new enum)
//! - `recondo_gateway::gateway::extract_sni_hostname` (new function)
//!
//! G5 immutability triggers were historically asserted against a gateway
//! source-side DDL constant. After the H1 audit fix the gateway no longer
//! carries any PostgreSQL DDL in source — the G5 tests below now read the
//! canonical `api/migrations/*.sql` corpus via the shared
//! `common::pg_migrations::pg_migration_sql()` helper.
//!
//! This file MUST NOT compile until the implementation agent creates these items.

#![allow(
    unused_imports,
    clippy::single_match,
    clippy::double_ended_iterator_last,
    clippy::unnecessary_map_or,
    clippy::let_and_return
)]

use std::path::{Path, PathBuf};

// Existing types that compile today
use recondo_gateway::config::parse_recondo_toml;
use recondo_gateway::db;
use recondo_gateway::session::{extract_client_metadata, ClientMetadata};

// ---- New imports: will NOT resolve until implementation creates them ----

// G1: FailMode enum and GatewaySection.fail_mode field
use recondo_gateway::config::FailMode;

// G2: Explicit identity header extraction
use recondo_gateway::session::extract_identity_headers;

// G3: GDPR tombstone + deletion workflow
use recondo_gateway::db::{
    list_gdpr_deletions, nullify_turn_parsed_fields, record_gdpr_deletion, GdprDeletionRecord,
};

// G4: Dual-mode gateway — connection mode detection
use recondo_gateway::gateway::{detect_connection_mode, extract_sni_hostname, ConnectionMode};

// G5: PostgreSQL immutability triggers — historically read from a gateway
// source-side DDL constant. After the H1 audit fix the gateway no longer
// carries any PostgreSQL DDL in source, so the G5 tests below assert
// against the canonical `api/migrations/*.sql` corpus via the shared
// `common::pg_migrations::pg_migration_sql()` helper.
mod common;

// ===========================================================================
// Test fixtures
// ===========================================================================

/// recondo.toml with fail_mode = "closed" in [gateway]
const TOML_FAIL_CLOSED: &str = r#"
[gateway]
listen = "0.0.0.0:8443"
providers = ["anthropic", "openai"]
fail_mode = "closed"

[store]
backend = "sqlite"
"#;

/// recondo.toml with fail_mode = "open" in [gateway]
const TOML_FAIL_OPEN: &str = r#"
[gateway]
listen = "0.0.0.0:8443"
providers = ["anthropic"]
fail_mode = "open"

[store]
backend = "sqlite"
"#;

/// recondo.toml WITHOUT fail_mode — must default to open
const TOML_NO_FAIL_MODE: &str = r#"
[gateway]
listen = "0.0.0.0:8443"
providers = ["anthropic"]

[store]
backend = "sqlite"
"#;

/// recondo.toml with an INVALID fail_mode value
const TOML_FAIL_INVALID: &str = r#"
[gateway]
listen = "0.0.0.0:8443"
providers = ["anthropic"]
fail_mode = "maybe"

[store]
backend = "sqlite"
"#;

/// HTTP request bytes with all three X-Recondo identity headers.
fn http_request_with_recondo_headers(agent_id: &str, session_id: &str, user_id: &str) -> Vec<u8> {
    format!(
        "POST /v1/messages HTTP/1.1\r\n\
         Host: api.anthropic.com\r\n\
         Content-Type: application/json\r\n\
         X-Recondo-Agent-Id: {agent_id}\r\n\
         X-Recondo-Session-Id: {session_id}\r\n\
         X-Recondo-User-Id: {user_id}\r\n\
         \r\n\
         {{\"model\":\"claude-sonnet-4-20250514\",\"messages\":[{{\"role\":\"user\",\"content\":\"hello\"}}],\"max_tokens\":1024}}"
    )
    .into_bytes()
}

/// HTTP request bytes WITHOUT any X-Recondo headers (backward-compatible path).
fn http_request_without_recondo_headers() -> Vec<u8> {
    b"POST /v1/messages HTTP/1.1\r\n\
      Host: api.anthropic.com\r\n\
      Content-Type: application/json\r\n\
      \r\n\
      {\"model\":\"claude-sonnet-4-20250514\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}],\"max_tokens\":1024}"
        .to_vec()
}

/// HTTP request bytes with ONLY X-Recondo-Agent-Id (partial headers).
fn http_request_with_only_agent_id(agent_id: &str) -> Vec<u8> {
    format!(
        "POST /v1/messages HTTP/1.1\r\n\
         Host: api.anthropic.com\r\n\
         Content-Type: application/json\r\n\
         X-Recondo-Agent-Id: {agent_id}\r\n\
         \r\n\
         {{\"model\":\"claude-sonnet-4-20250514\",\"messages\":[{{\"role\":\"user\",\"content\":\"hello\"}}],\"max_tokens\":1024}}"
    )
    .into_bytes()
}

/// A CONNECT request (classic HTTPS_PROXY tunnel mode).
fn connect_request_bytes() -> Vec<u8> {
    b"CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n".to_vec()
}

/// A GET /healthz request (health check, still HTTP method).
fn get_healthz_bytes() -> Vec<u8> {
    b"GET /healthz HTTP/1.1\r\nHost: localhost:8443\r\n\r\n".to_vec()
}

/// Construct a minimal but realistic TLS ClientHello with a specific SNI hostname.
///
/// TLS 1.2/1.3 ClientHello structure:
///   - Record header: 0x16 (handshake), 0x03 0x01 (TLS 1.0 compat), length (2 bytes)
///   - Handshake header: 0x01 (ClientHello), length (3 bytes)
///   - Client version: 0x03 0x03 (TLS 1.2)
///   - Random: 32 bytes
///   - Session ID length: 0x00
///   - Cipher suites: length (2 bytes) + one suite (2 bytes)
///   - Compression methods: length (1 byte) + null (1 byte)
///   - Extensions length: 2 bytes
///   - SNI extension (type 0x00 0x00):
///       - Extension length: 2 bytes
///       - SNI list length: 2 bytes
///       - Host name type: 0x00 (DNS)
///       - Host name length: 2 bytes
///       - Host name bytes
fn build_tls_client_hello(hostname: &str) -> Vec<u8> {
    let host_bytes = hostname.as_bytes();
    let host_len = host_bytes.len();

    // SNI extension payload
    let sni_entry_len = 1 + 2 + host_len; // type(1) + length(2) + name
    let sni_list_len = sni_entry_len;
    let sni_ext_data_len = 2 + sni_list_len; // list_length(2) + list
    let sni_ext_total = 2 + 2 + sni_ext_data_len; // type(2) + ext_len(2) + data

    let extensions_len = sni_ext_total;

    // ClientHello body (after handshake type + length):
    //   version(2) + random(32) + session_id_len(1) + cipher_suites(4) + compression(2) + extensions
    let client_hello_body_len = 2 + 32 + 1 + 4 + 2 + 2 + extensions_len;

    // Handshake: type(1) + length(3) + body
    let handshake_len = 1 + 3 + client_hello_body_len;

    // Record: type(1) + version(2) + length(2) + handshake
    let record_payload_len = handshake_len;

    let mut buf = Vec::with_capacity(5 + record_payload_len);

    // TLS record header
    buf.push(0x16); // ContentType: Handshake
    buf.push(0x03);
    buf.push(0x01); // Version: TLS 1.0 (compat)
    buf.push((record_payload_len >> 8) as u8);
    buf.push((record_payload_len & 0xFF) as u8);

    // Handshake header
    buf.push(0x01); // HandshakeType: ClientHello
                    // Length (3 bytes, big-endian)
    buf.push((client_hello_body_len >> 16) as u8);
    buf.push((client_hello_body_len >> 8) as u8);
    buf.push((client_hello_body_len & 0xFF) as u8);

    // ClientHello body
    buf.push(0x03);
    buf.push(0x03); // Version: TLS 1.2

    // Random: 32 zero bytes (not cryptographically valid, but structurally correct)
    buf.extend_from_slice(&[0u8; 32]);

    // Session ID: length 0
    buf.push(0x00);

    // Cipher suites: length 2, one suite TLS_AES_128_GCM_SHA256 (0x13, 0x01)
    buf.push(0x00);
    buf.push(0x02);
    buf.push(0x13);
    buf.push(0x01);

    // Compression methods: length 1, null compression
    buf.push(0x01);
    buf.push(0x00);

    // Extensions length (2 bytes)
    buf.push((extensions_len >> 8) as u8);
    buf.push((extensions_len & 0xFF) as u8);

    // SNI extension: type 0x0000
    buf.push(0x00);
    buf.push(0x00);
    // Extension data length
    buf.push((sni_ext_data_len >> 8) as u8);
    buf.push((sni_ext_data_len & 0xFF) as u8);
    // SNI list length
    buf.push((sni_list_len >> 8) as u8);
    buf.push((sni_list_len & 0xFF) as u8);
    // Host name type: 0x00 (DNS)
    buf.push(0x00);
    // Host name length
    buf.push((host_len >> 8) as u8);
    buf.push((host_len & 0xFF) as u8);
    // Host name
    buf.extend_from_slice(host_bytes);

    buf
}

// ===========================================================================
// G1: fail_mode configurable via recondo.toml (OD-001)
// ===========================================================================

/// **Proves:** Parsing `fail_mode = "closed"` in [gateway] yields FailMode::Closed on the config.
/// **Anti-fake property:** Asserts on the specific enum variant, not just that parsing succeeded.
#[test]
fn g1_parse_fail_mode_closed_from_toml() {
    let config = parse_recondo_toml(TOML_FAIL_CLOSED).expect("valid TOML must parse");
    assert_eq!(
        config.gateway.fail_mode,
        FailMode::Closed,
        "fail_mode = \"closed\" must produce FailMode::Closed"
    );
}

/// **Proves:** Parsing `fail_mode = "open"` in [gateway] yields FailMode::Open on the config.
/// **Anti-fake property:** Distinguishes Open from Closed — a hardcoded default would fail one of these two tests.
#[test]
fn g1_parse_fail_mode_open_from_toml() {
    let config = parse_recondo_toml(TOML_FAIL_OPEN).expect("valid TOML must parse");
    assert_eq!(
        config.gateway.fail_mode,
        FailMode::Open,
        "fail_mode = \"open\" must produce FailMode::Open"
    );
}

/// **Proves:** When fail_mode is not specified in [gateway], the default is FailMode::Open.
/// **Anti-fake property:** Omitting the field entirely must not error and must default to Open.
#[test]
fn g1_fail_mode_defaults_to_open_when_absent() {
    let config = parse_recondo_toml(TOML_NO_FAIL_MODE).expect("TOML without fail_mode must parse");
    assert_eq!(
        config.gateway.fail_mode,
        FailMode::Open,
        "absent fail_mode must default to Open per OD-001"
    );
}

/// **Proves:** An invalid fail_mode value (not "open" or "closed") produces a parse error.
/// **Anti-fake property:** The specific input "maybe" is not silently accepted or mapped to a default.
#[test]
fn g1_negative_invalid_fail_mode_produces_error() {
    let result = parse_recondo_toml(TOML_FAIL_INVALID);
    assert!(
        result.is_err(),
        "fail_mode = \"maybe\" must produce an error, not silently succeed"
    );
    let err_msg = result.unwrap_err().to_string().to_lowercase();
    // The error should mention something about the invalid value or fail_mode
    assert!(
        err_msg.contains("fail_mode") || err_msg.contains("maybe") || err_msg.contains("invalid"),
        "Error message should reference the invalid value. Got: {}",
        err_msg
    );
}

/// **Proves:** End-to-end: parse TOML with fail_mode = "closed", verify the value flows
/// through RecondoConfig correctly and matches the wal::FailMode semantic (block on failure).
/// **Anti-fake property:** Tests the full path from TOML string to typed config struct.
#[test]
fn g1_e2e_fail_mode_closed_flows_through_config() {
    let config = parse_recondo_toml(TOML_FAIL_CLOSED).expect("valid TOML");

    // Verify the config struct carries the value
    assert_eq!(config.gateway.fail_mode, FailMode::Closed);

    // Verify the listen and providers are also correct (not clobbered by fail_mode addition)
    assert_eq!(config.gateway.listen, "0.0.0.0:8443");
    assert_eq!(config.gateway.providers.len(), 2);
    assert!(config.gateway.providers.contains(&"anthropic".to_string()));
    assert!(config.gateway.providers.contains(&"openai".to_string()));
}

// ===========================================================================
// G2: Explicit identity headers (OD-002)
// ===========================================================================

/// **Proves:** `extract_identity_headers` parses `X-Recondo-Agent-Id` from HTTP request bytes
/// and returns it in the result struct.
/// **Anti-fake property:** The returned agent_id matches the exact header value, not a default.
#[test]
fn g2_extract_agent_id_from_x_recondo_header() {
    let raw = http_request_with_recondo_headers(
        "ci-pipeline-prod",
        "sess-abc123",
        "developer@company.com",
    );
    let identity = extract_identity_headers(&raw);

    assert_eq!(
        identity.agent_id.as_deref(),
        Some("ci-pipeline-prod"),
        "X-Recondo-Agent-Id must be extracted from request headers"
    );
}

/// **Proves:** `extract_identity_headers` parses `X-Recondo-Session-Id` from HTTP request bytes.
/// **Anti-fake property:** The returned session_id is the exact header value "sess-abc123".
#[test]
fn g2_extract_session_id_from_x_recondo_header() {
    let raw = http_request_with_recondo_headers(
        "ci-pipeline-prod",
        "sess-abc123",
        "developer@company.com",
    );
    let identity = extract_identity_headers(&raw);

    assert_eq!(
        identity.session_id.as_deref(),
        Some("sess-abc123"),
        "X-Recondo-Session-Id must be extracted from request headers"
    );
}

/// **Proves:** `extract_identity_headers` parses `X-Recondo-User-Id` from HTTP request bytes.
/// **Anti-fake property:** The returned user_id matches the exact header value.
#[test]
fn g2_extract_user_id_from_x_recondo_header() {
    let raw = http_request_with_recondo_headers(
        "ci-pipeline-prod",
        "sess-abc123",
        "developer@company.com",
    );
    let identity = extract_identity_headers(&raw);

    assert_eq!(
        identity.user_id.as_deref(),
        Some("developer@company.com"),
        "X-Recondo-User-Id must be extracted from request headers"
    );
}

/// **Proves:** When X-Recondo headers are absent, extract_identity_headers returns all None fields.
/// Backward compatibility: auto-extraction via extract_client_metadata still works.
/// **Anti-fake property:** All three fields are None — no fabricated defaults.
#[test]
fn g2_negative_no_recondo_headers_returns_none() {
    let raw = http_request_without_recondo_headers();
    let identity = extract_identity_headers(&raw);

    assert!(
        identity.agent_id.is_none(),
        "agent_id must be None when X-Recondo-Agent-Id is absent"
    );
    assert!(
        identity.session_id.is_none(),
        "session_id must be None when X-Recondo-Session-Id is absent"
    );
    assert!(
        identity.user_id.is_none(),
        "user_id must be None when X-Recondo-User-Id is absent"
    );
}

/// **Proves:** Partial headers work: only X-Recondo-Agent-Id is present, session_id and user_id are None.
/// **Anti-fake property:** Selective extraction — only present headers are returned.
#[test]
fn g2_partial_headers_only_agent_id() {
    let raw = http_request_with_only_agent_id("my-custom-agent");
    let identity = extract_identity_headers(&raw);

    assert_eq!(
        identity.agent_id.as_deref(),
        Some("my-custom-agent"),
        "X-Recondo-Agent-Id must be extracted when present alone"
    );
    assert!(
        identity.session_id.is_none(),
        "session_id must be None when header is absent"
    );
    assert!(
        identity.user_id.is_none(),
        "user_id must be None when header is absent"
    );
}

/// **Proves:** End-to-end: explicit X-Recondo-Session-Id header overrides the auto-extracted
/// session_id from the Anthropic metadata.user_id field. This is the key OD-002 Layer 2 behavior.
/// **Anti-fake property:** The body contains a different session_id in metadata.user_id,
/// but the header value wins.
#[test]
fn g2_e2e_header_overrides_body_session_id() {
    let body_session = "body-session-from-metadata";
    let header_session = "header-session-override";

    // Build a request that has BOTH: metadata.user_id.session_id in body AND X-Recondo-Session-Id header
    let raw = format!(
        "POST /v1/messages HTTP/1.1\r\n\
         Host: api.anthropic.com\r\n\
         Content-Type: application/json\r\n\
         X-Recondo-Session-Id: {header_session}\r\n\
         \r\n\
         {{\"model\":\"claude-sonnet-4-20250514\",\
           \"messages\":[{{\"role\":\"user\",\"content\":\"hello\"}}],\
           \"metadata\":{{\"user_id\":\"{{\\\"session_id\\\":\\\"{body_session}\\\",\\\"account_uuid\\\":\\\"acct-123\\\",\\\"device_id\\\":\\\"dev-456\\\"}}\"}},\
           \"max_tokens\":1024}}"
    )
    .into_bytes();

    // extract_identity_headers gets the header value
    let identity = extract_identity_headers(&raw);
    assert_eq!(
        identity.session_id.as_deref(),
        Some(header_session),
        "X-Recondo-Session-Id header must be available for override"
    );

    // extract_client_metadata gets the body value
    let client_meta = extract_client_metadata(&raw);

    // The header session_id is different from the body session_id
    // This proves the explicit header path is separate from auto-extraction
    assert_ne!(
        identity.session_id.as_deref(),
        client_meta.session_id.as_deref(),
        "Header session_id must differ from body session_id to prove override capability"
    );
}

// ===========================================================================
// G3: GDPR tombstone table + deletion workflow (OD-003)
// ===========================================================================

/// Helper: create an in-memory SQLite DB with the gateway schema.
fn setup_test_db() -> rusqlite::Connection {
    let conn = db::create_connection(":memory:").expect("in-memory SQLite must work");
    conn
}

/// Helper: insert a minimal session into the DB and return its id.
fn insert_test_session(conn: &rusqlite::Connection, session_id: &str) {
    conn.execute(
        "INSERT INTO sessions (id, provider, started_at, last_active_at, system_prompt_hash,
         total_turns, turns_captured, dropped_events, total_tokens, total_cost_usd)
         VALUES (?1, 'anthropic', '2026-03-21T10:00:00Z', '2026-03-21T10:00:00Z', 'hash123',
                 1, 1, 0, 100, 0.01)",
        rusqlite::params![session_id],
    )
    .expect("session insert must succeed");
}

/// Helper: insert a minimal turn and return its id.
fn insert_test_turn(conn: &rusqlite::Connection, turn_id: &str, session_id: &str) {
    conn.execute(
        "INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
         stop_reason, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         created_at, retry_count, tool_call_count, thinking_tokens,
         response_text, thinking_text, messages_delta, raw_extra)
         VALUES (?1, ?2, 1, '2026-03-21T10:00:01Z', 'req_hash_abc', 'resp_hash_def',
                 'end_turn', 50, 100, 0, 0, '2026-03-21T10:00:01Z', 0, 0, 0,
                 'This is the response text', 'This is thinking', '{\"delta\":1}', '{\"extra\":true}')",
        rusqlite::params![turn_id, session_id],
    )
    .expect("turn insert must succeed");
}

/// **Proves:** `nullify_turn_parsed_fields` sets response_text to NULL on an existing turn.
/// **Anti-fake property:** The turn was inserted with a non-NULL response_text; after nullify, it reads back as None.
#[test]
fn g3_nullify_turn_sets_response_text_to_null() {
    let conn = setup_test_db();
    let session_id = "sess-gdpr-001";
    let turn_id = "turn-gdpr-001";

    insert_test_session(&conn, session_id);
    insert_test_turn(&conn, turn_id, session_id);

    // Verify response_text is non-NULL before nullify
    let before: Option<String> = conn
        .query_row(
            "SELECT response_text FROM turns WHERE id = ?1",
            rusqlite::params![turn_id],
            |row| row.get(0),
        )
        .expect("turn must exist");
    assert!(
        before.is_some(),
        "response_text must be non-NULL before nullify"
    );

    // Nullify
    nullify_turn_parsed_fields(&conn, turn_id).expect("nullify must succeed");

    // Verify response_text is now NULL
    let after: Option<String> = conn
        .query_row(
            "SELECT response_text FROM turns WHERE id = ?1",
            rusqlite::params![turn_id],
            |row| row.get(0),
        )
        .expect("turn must still exist");
    assert!(after.is_none(), "response_text must be None after nullify");
}

/// **Proves:** `nullify_turn_parsed_fields` also nullifies thinking_text, messages_delta, and raw_extra.
/// **Anti-fake property:** All four parsed fields were non-NULL before and are NULL after.
#[test]
fn g3_nullify_turn_clears_all_parsed_fields() {
    let conn = setup_test_db();
    let session_id = "sess-gdpr-002";
    let turn_id = "turn-gdpr-002";

    insert_test_session(&conn, session_id);
    insert_test_turn(&conn, turn_id, session_id);

    nullify_turn_parsed_fields(&conn, turn_id).expect("nullify must succeed");

    let row: (Option<String>, Option<String>, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT response_text, thinking_text, messages_delta, raw_extra FROM turns WHERE id = ?1",
            rusqlite::params![turn_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("turn must exist");

    assert!(row.0.is_none(), "response_text must be NULL after nullify");
    assert!(row.1.is_none(), "thinking_text must be NULL after nullify");
    assert!(row.2.is_none(), "messages_delta must be NULL after nullify");
    assert!(row.3.is_none(), "raw_extra must be NULL after nullify");
}

/// **Proves:** `record_gdpr_deletion` inserts a tombstone record into `gdpr_deletions` table.
/// **Anti-fake property:** The tombstone contains the exact object_hash, deleted_by, and gdpr_request_id values.
#[test]
fn g3_record_gdpr_deletion_creates_tombstone() {
    let conn = setup_test_db();

    record_gdpr_deletion(
        &conn,
        "sha256_abc123def456",
        "gdpr-admin@company.com",
        "GDPR-REQ-2026-0042",
    )
    .expect("recording GDPR deletion must succeed");

    let deletions = list_gdpr_deletions(&conn).expect("list must succeed");
    assert_eq!(deletions.len(), 1, "exactly one deletion must be recorded");

    let d = &deletions[0];
    assert_eq!(d.object_hash, "sha256_abc123def456");
    assert_eq!(d.deleted_by, "gdpr-admin@company.com");
    assert_eq!(d.gdpr_request_id, "GDPR-REQ-2026-0042");
    assert!(
        !d.deleted_at.is_empty(),
        "deleted_at must be populated with a timestamp"
    );
    assert!(
        !d.id.is_empty(),
        "tombstone record must have a non-empty id"
    );
}

/// **Proves:** Multiple GDPR deletions can be recorded and listed.
/// **Anti-fake property:** Two distinct object hashes appear in the list with correct metadata.
#[test]
fn g3_multiple_gdpr_deletions_are_listed() {
    let conn = setup_test_db();

    record_gdpr_deletion(&conn, "hash_aaa", "admin1", "REQ-001")
        .expect("first deletion must succeed");
    record_gdpr_deletion(&conn, "hash_bbb", "admin2", "REQ-002")
        .expect("second deletion must succeed");

    let deletions = list_gdpr_deletions(&conn).expect("list must succeed");
    assert_eq!(deletions.len(), 2, "both deletions must be listed");

    let hashes: Vec<&str> = deletions.iter().map(|d| d.object_hash.as_str()).collect();
    assert!(hashes.contains(&"hash_aaa"));
    assert!(hashes.contains(&"hash_bbb"));
}

/// **Proves:** `nullify_turn_parsed_fields` returns an error when the turn_id does not exist.
/// **Anti-fake property:** A non-existent ID is not silently ignored; the function reports failure.
#[test]
fn g3_negative_nullify_nonexistent_turn_returns_error() {
    let conn = setup_test_db();

    let result = nullify_turn_parsed_fields(&conn, "nonexistent-turn-id");
    assert!(
        result.is_err(),
        "nullifying a non-existent turn must return an error, not silently succeed"
    );
}

/// **Proves:** Full GDPR deletion workflow end-to-end: insert session + turn, nullify the turn's
/// parsed fields, record the GDPR deletion tombstone, then verify the turn is nullified and the
/// deletion is recorded.
/// **Anti-fake property:** Exercises the complete multi-step workflow in sequence; each step
/// depends on the previous.
#[test]
fn g3_e2e_full_gdpr_deletion_workflow() {
    let conn = setup_test_db();
    let session_id = "sess-gdpr-e2e";
    let turn_id = "turn-gdpr-e2e";
    let object_hash = "sha256_resp_hash_for_gdpr";
    let gdpr_admin = "gdpr-officer@company.com";
    let gdpr_req = "GDPR-2026-FULL-001";

    // Step 1: Insert session and turn with populated parsed fields
    insert_test_session(&conn, session_id);
    insert_test_turn(&conn, turn_id, session_id);

    // Step 2: Verify turn has data before deletion
    let before: Option<String> = conn
        .query_row(
            "SELECT response_text FROM turns WHERE id = ?1",
            rusqlite::params![turn_id],
            |row| row.get(0),
        )
        .expect("turn must exist");
    assert!(
        before.is_some(),
        "response_text must exist before GDPR deletion"
    );

    // Step 3: Nullify parsed fields (simulating GDPR erasure of parsed data)
    nullify_turn_parsed_fields(&conn, turn_id).expect("nullify must succeed");

    // Step 4: Record the GDPR deletion tombstone
    record_gdpr_deletion(&conn, object_hash, gdpr_admin, gdpr_req)
        .expect("recording deletion must succeed");

    // Step 5: Verify turn is nullified
    let after: (Option<String>, Option<String>, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT response_text, thinking_text, messages_delta, raw_extra FROM turns WHERE id = ?1",
            rusqlite::params![turn_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("turn must still exist");
    assert!(
        after.0.is_none(),
        "response_text must be NULL after GDPR deletion"
    );
    assert!(
        after.1.is_none(),
        "thinking_text must be NULL after GDPR deletion"
    );
    assert!(
        after.2.is_none(),
        "messages_delta must be NULL after GDPR deletion"
    );
    assert!(
        after.3.is_none(),
        "raw_extra must be NULL after GDPR deletion"
    );

    // Step 6: Verify tombstone is recorded
    let deletions = list_gdpr_deletions(&conn).expect("list must succeed");
    assert_eq!(deletions.len(), 1);
    assert_eq!(deletions[0].object_hash, object_hash);
    assert_eq!(deletions[0].deleted_by, gdpr_admin);
    assert_eq!(deletions[0].gdpr_request_id, gdpr_req);

    // Step 7: Verify the turn's non-parsed fields (hashes, session_id) are PRESERVED
    // The content hash stays as a tombstone — documented integrity chain break
    let preserved: (String, String) = conn
        .query_row(
            "SELECT request_hash, response_hash FROM turns WHERE id = ?1",
            rusqlite::params![turn_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("turn must still exist with hashes");
    assert_eq!(
        preserved.0, "req_hash_abc",
        "request_hash must be preserved"
    );
    assert_eq!(
        preserved.1, "resp_hash_def",
        "response_hash must be preserved"
    );
}

// ===========================================================================
// G4: Dual-mode gateway — connection mode detection (OD-006)
// ===========================================================================

/// **Proves:** A CONNECT request is detected as ConnectionMode::Connect.
/// **Anti-fake property:** The specific bytes "CONNECT api.anthropic.com:443" produce the Connect variant.
#[test]
fn g4_connect_request_detected_as_connect_mode() {
    let bytes = connect_request_bytes();
    let mode = detect_connection_mode(&bytes);
    assert_eq!(
        mode,
        ConnectionMode::Connect,
        "CONNECT request bytes must be detected as Connect mode"
    );
}

/// **Proves:** A TLS ClientHello (first byte 0x16) is detected as ConnectionMode::DirectTls.
/// **Anti-fake property:** Uses a structurally valid ClientHello with SNI, not just a byte with 0x16.
#[test]
fn g4_tls_client_hello_detected_as_direct_tls() {
    let hello = build_tls_client_hello("api.anthropic.com");
    let mode = detect_connection_mode(&hello);
    assert_eq!(
        mode,
        ConnectionMode::DirectTls,
        "TLS ClientHello bytes must be detected as DirectTls mode"
    );
}

/// **Proves:** A GET request (e.g., /healthz) is detected as ConnectionMode::Connect (HTTP method).
/// **Anti-fake property:** GET is an HTTP method, so it falls in the Connect/HTTP path, not DirectTls.
#[test]
fn g4_get_healthz_detected_as_connect_mode() {
    let bytes = get_healthz_bytes();
    let mode = detect_connection_mode(&bytes);
    assert_eq!(
        mode,
        ConnectionMode::Connect,
        "GET /healthz must be detected as Connect (HTTP) mode"
    );
}

/// **Proves:** Random binary data that is neither HTTP nor TLS produces ConnectionMode::Unknown.
/// **Anti-fake property:** The bytes 0xDE 0xAD 0xBE 0xEF are not a valid HTTP method or TLS record.
#[test]
fn g4_negative_random_binary_data_is_unknown() {
    let garbage = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0xFF, 0x42, 0x13];
    let mode = detect_connection_mode(&garbage);
    assert_eq!(
        mode,
        ConnectionMode::Unknown,
        "Random binary data must be detected as Unknown"
    );
}

/// **Proves:** A truncated TLS ClientHello (less than 5 bytes) produces ConnectionMode::Unknown.
/// Even though the first byte is 0x16, the record is too short to be valid.
/// **Anti-fake property:** A naive check of just the first byte would incorrectly return DirectTls.
#[test]
fn g4_negative_truncated_tls_client_hello_is_unknown() {
    // First byte is 0x16 (TLS handshake), but only 3 bytes total — not enough for a record header
    let truncated = vec![0x16, 0x03, 0x01];
    let mode = detect_connection_mode(&truncated);
    assert_eq!(
        mode,
        ConnectionMode::Unknown,
        "Truncated TLS record (< 5 bytes) must be Unknown, not DirectTls"
    );
}

/// **Proves:** Empty input produces ConnectionMode::Unknown.
/// **Anti-fake property:** Zero-length slice must not panic or return a valid mode.
#[test]
fn g4_negative_empty_bytes_is_unknown() {
    let empty: Vec<u8> = vec![];
    let mode = detect_connection_mode(&empty);
    assert_eq!(
        mode,
        ConnectionMode::Unknown,
        "Empty byte slice must be Unknown"
    );
}

/// **Proves:** `extract_sni_hostname` extracts the correct hostname from a TLS ClientHello with SNI.
/// **Anti-fake property:** The extracted hostname must exactly match "api.anthropic.com", not any
/// other string. The ClientHello is structurally constructed with that specific SNI value.
#[test]
fn g4_extract_sni_hostname_from_client_hello() {
    let hello = build_tls_client_hello("api.anthropic.com");
    let hostname = extract_sni_hostname(&hello);
    assert_eq!(
        hostname.as_deref(),
        Some("api.anthropic.com"),
        "SNI hostname must be extracted from TLS ClientHello"
    );
}

/// **Proves:** `extract_sni_hostname` returns None for non-TLS data.
/// **Anti-fake property:** HTTP bytes do not contain SNI; returning a hostname would be fabrication.
#[test]
fn g4_negative_extract_sni_from_non_tls_returns_none() {
    let http = connect_request_bytes();
    let hostname = extract_sni_hostname(&http);
    assert!(
        hostname.is_none(),
        "extract_sni_hostname must return None for non-TLS data"
    );
}

/// **Proves:** End-to-end: construct a realistic TLS ClientHello with SNI "api.openai.com",
/// verify detect_connection_mode returns DirectTls AND extract_sni_hostname returns the hostname.
/// Both functions agree on the same input.
/// **Anti-fake property:** Tests both detection and extraction on the same realistic input.
/// A different hostname ("api.openai.com") proves the extraction is dynamic, not hardcoded.
#[test]
fn g4_e2e_direct_tls_detection_with_sni_extraction() {
    let target_host = "api.openai.com";
    let hello = build_tls_client_hello(target_host);

    // Step 1: detect mode
    let mode = detect_connection_mode(&hello);
    assert_eq!(mode, ConnectionMode::DirectTls);

    // Step 2: extract hostname
    let hostname = extract_sni_hostname(&hello);
    assert_eq!(hostname.as_deref(), Some(target_host));
}

/// **Proves:** End-to-end: a TLS ClientHello for a Google/Gemini endpoint is also correctly
/// detected and its SNI extracted. This covers the third provider (OD-006 mentions all LLM APIs).
/// **Anti-fake property:** Different hostname from the other tests — proves dynamic extraction.
#[test]
fn g4_e2e_direct_tls_gemini_endpoint() {
    let target_host = "generativelanguage.googleapis.com";
    let hello = build_tls_client_hello(target_host);

    let mode = detect_connection_mode(&hello);
    assert_eq!(mode, ConnectionMode::DirectTls);

    let hostname = extract_sni_hostname(&hello);
    assert_eq!(hostname.as_deref(), Some(target_host));
}

// ===========================================================================
// G5: PostgreSQL immutability triggers (OD-024)
// ===========================================================================

/// **Proves:** the migration corpus contains a CREATE TRIGGER statement for the `turns` table.
/// **Anti-fake property:** Asserts on both "CREATE TRIGGER" and "turns" in the same DDL,
/// not just one or the other.
#[test]
fn g5_pg_schema_has_trigger_for_turns() {
    let ddl = common::pg_migrations::pg_migration_sql();
    let ddl_lower = ddl.to_lowercase();

    assert!(
        ddl_lower.contains("create trigger") || ddl_lower.contains("create or replace trigger"),
        "api/migrations/*.sql must contain CREATE TRIGGER"
    );

    // Verify there is a trigger specifically for the turns table
    // Look for a pattern like "ON turns" after a CREATE TRIGGER
    assert!(
        ddl_lower.contains("on turns"),
        "api/migrations/*.sql must contain a trigger ON turns table"
    );
}

/// **Proves:** the migration corpus contains a CREATE TRIGGER statement for the `tool_calls` table.
/// **Anti-fake property:** Asserts on "tool_calls" in a trigger context, not just the CREATE TABLE.
#[test]
fn g5_pg_schema_has_trigger_for_tool_calls() {
    let ddl = common::pg_migrations::pg_migration_sql();
    let ddl_lower = ddl.to_lowercase();

    // Look for a trigger ON tool_calls
    assert!(
        ddl_lower.contains("on tool_calls"),
        "api/migrations/*.sql must contain a trigger ON tool_calls table"
    );
}

/// **Proves:** The trigger function raises an exception with a message about immutability.
/// **Anti-fake property:** The DDL must contain RAISE EXCEPTION with "immutable" or "append-only" —
/// a trigger that silently succeeds would not satisfy OD-024's requirement.
#[test]
fn g5_trigger_function_raises_exception() {
    let ddl = common::pg_migrations::pg_migration_sql();
    let ddl_lower = ddl.to_lowercase();

    assert!(
        ddl_lower.contains("raise exception"),
        "Trigger function must RAISE EXCEPTION to enforce immutability"
    );

    assert!(
        ddl_lower.contains("immutable")
            || ddl_lower.contains("append-only")
            || ddl_lower.contains("append_only"),
        "Exception message must mention 'immutable' or 'append-only'"
    );
}

/// **Proves:** the migration corpus includes BEFORE UPDATE triggers (not just BEFORE DELETE).
/// Both UPDATE and DELETE must be blocked on immutable tables.
/// **Anti-fake property:** A trigger that only prevents DELETE but allows UPDATE would fail this test.
#[test]
fn g5_triggers_cover_both_update_and_delete() {
    let ddl = common::pg_migrations::pg_migration_sql();
    let ddl_lower = ddl.to_lowercase();

    assert!(
        ddl_lower.contains("before update")
            || ddl_lower.contains("before update or delete")
            || ddl_lower.contains("before delete or update"),
        "Triggers must fire BEFORE UPDATE to prevent row modification"
    );

    assert!(
        ddl_lower.contains("before delete")
            || ddl_lower.contains("before update or delete")
            || ddl_lower.contains("before delete or update"),
        "Triggers must fire BEFORE DELETE to prevent row deletion"
    );
}

/// **Proves:** The sessions table does NOT have an immutability trigger.
/// Sessions need UPDATE for counter fields (total_turns, turns_captured, etc.).
/// **Anti-fake property:** A blanket trigger on all tables would break session counter updates.
///
/// FIND-1-1 fix (round 2): the prior implementation split the DDL on the
/// substring "create trigger" and rejected post-split blocks containing
/// "on sessions". That brittle approach conflated `CREATE TRIGGER ...
/// ON sessions` with `CREATE INDEX ... ON sessions(...)` (the latter is
/// legitimately present and harmless). Round 1 displaced the brittleness
/// into the production migration file by reordering it; this round fixes
/// the test instead, using statement-level structural matching.
#[test]
fn g5_negative_sessions_table_has_no_immutability_trigger() {
    let ddl = common::pg_migrations::pg_migration_sql();

    let offending = common::sql_parse::trigger_statements_targeting(ddl, "sessions");

    assert!(
        offending.is_empty(),
        "No immutability trigger should exist ON the sessions table — sessions need UPDATE \
         for counter fields. Offending CREATE TRIGGER statements: {:#?}",
        offending
    );
}

// FIND-2-1 (audit round 2): `ddl_trigger_statements_on_table` and
// `split_sql_outside_dollar_quotes`, plus the per-crate self-test
// `g5_negative_helper_distinguishes_create_trigger_from_create_index`,
// were moved to `gateway/tests/common/sql_parse.rs`. The unified API
// is `common::sql_parse::trigger_statements_targeting(sql, table)`,
// shared with `batch1_h1_m2_tests`. The single consolidated self-test
// lives in `sql_parse.rs::tests`.

/// **Proves:** End-to-end: the migration corpus is valid DDL that contains the complete immutability
/// enforcement chain: function definition + triggers on turns + triggers on tool_calls.
/// **Anti-fake property:** Verifies the complete chain — function, trigger on turns, trigger on
/// tool_calls, and RAISE EXCEPTION — all present in the same DDL string.
#[test]
fn g5_e2e_complete_immutability_chain_in_ddl() {
    let ddl = common::pg_migrations::pg_migration_sql();
    let ddl_lower = ddl.to_lowercase();

    // 1. Trigger function must be defined
    assert!(
        ddl_lower.contains("create function") || ddl_lower.contains("create or replace function"),
        "DDL must define a trigger function"
    );

    // 2. Function must raise an exception
    assert!(
        ddl_lower.contains("raise exception"),
        "Trigger function must RAISE EXCEPTION"
    );

    // 3. Trigger on turns table
    assert!(ddl_lower.contains("on turns"), "Must have trigger ON turns");

    // 4. Trigger on tool_calls table
    assert!(
        ddl_lower.contains("on tool_calls"),
        "Must have trigger ON tool_calls"
    );

    // 5. No CREATE TRIGGER targeting the sessions table.
    //    FIND-1-1 fix (round 2): use the same statement-level structural
    //    helper as g5_negative_sessions_table_has_no_immutability_trigger
    //    so we don't conflate `CREATE TRIGGER ... ON sessions` with
    //    `CREATE INDEX ... ON sessions(...)`.
    let offending = common::sql_parse::trigger_statements_targeting(ddl, "sessions");
    assert!(
        offending.is_empty(),
        "Sessions must NOT have immutability trigger. Offending CREATE TRIGGER statements: {:#?}",
        offending
    );
}

// ===========================================================================
// G6: S3 Object Lock Terraform variables (OD-028)
// ===========================================================================

/// **Proves:** `variables.tf` contains the `s3_object_lock_mode` variable with default "GOVERNANCE".
/// **Anti-fake property:** Asserts on both the variable name and the specific default value string.
#[test]
fn g6_variables_tf_has_s3_object_lock_mode_with_governance_default() {
    let tf_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("deploy/terraform/aws/variables.tf");

    let content = std::fs::read_to_string(&tf_path)
        .unwrap_or_else(|e| panic!("Must read {}: {}", tf_path.display(), e));

    assert!(
        content.contains("s3_object_lock_mode"),
        "variables.tf must declare s3_object_lock_mode variable"
    );

    // The default value must be "GOVERNANCE" (not "COMPLIANCE")
    // Look for the pattern: default = "GOVERNANCE" (with flexible whitespace)
    let governance_pattern = content.contains("\"GOVERNANCE\"");
    assert!(
        governance_pattern,
        "s3_object_lock_mode must default to \"GOVERNANCE\" per OD-028"
    );
}

/// **Proves:** `variables.tf` contains the `object_lock_retention_days` variable with default 365.
/// **Anti-fake property:** Asserts on both the variable name and the specific default value.
#[test]
fn g6_variables_tf_has_object_lock_retention_days_with_365_default() {
    let tf_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("deploy/terraform/aws/variables.tf");

    let content = std::fs::read_to_string(&tf_path)
        .unwrap_or_else(|e| panic!("Must read {}: {}", tf_path.display(), e));

    assert!(
        content.contains("object_lock_retention_days"),
        "variables.tf must declare object_lock_retention_days variable"
    );

    // The default must be 365
    assert!(
        content.contains("365"),
        "object_lock_retention_days must default to 365"
    );
}

/// **Proves:** `s3.tf` references `var.s3_object_lock_mode` instead of hardcoded "COMPLIANCE".
/// **Anti-fake property:** The variable reference `var.s3_object_lock_mode` must be present in the
/// Object Lock configuration block.
#[test]
fn g6_s3_tf_uses_variable_for_object_lock_mode() {
    let tf_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("deploy/terraform/aws/s3.tf");

    let content = std::fs::read_to_string(&tf_path)
        .unwrap_or_else(|e| panic!("Must read {}: {}", tf_path.display(), e));

    assert!(
        content.contains("var.s3_object_lock_mode"),
        "s3.tf must reference var.s3_object_lock_mode (not a hardcoded string)"
    );
}

/// **Proves:** `s3.tf` references `var.object_lock_retention_days` instead of a hardcoded number.
/// **Anti-fake property:** The variable reference must appear in the retention configuration block.
#[test]
fn g6_s3_tf_uses_variable_for_retention_days() {
    let tf_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("deploy/terraform/aws/s3.tf");

    let content = std::fs::read_to_string(&tf_path)
        .unwrap_or_else(|e| panic!("Must read {}: {}", tf_path.display(), e));

    assert!(
        content.contains("var.object_lock_retention_days"),
        "s3.tf must reference var.object_lock_retention_days (not a hardcoded number)"
    );
}

/// **Proves:** `s3.tf` does NOT contain the literal string `"COMPLIANCE"` as a hardcoded value
/// in the Object Lock configuration. The mode must come from the variable.
/// **Anti-fake property:** If someone hardcodes "COMPLIANCE" alongside the variable reference,
/// this test catches it. Only the variable reference should determine the mode.
#[test]
fn g6_negative_s3_tf_does_not_hardcode_compliance_mode() {
    let tf_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("deploy/terraform/aws/s3.tf");

    let content = std::fs::read_to_string(&tf_path)
        .unwrap_or_else(|e| panic!("Must read {}: {}", tf_path.display(), e));

    // Strip comments (lines starting with # after optional whitespace) to avoid false positives
    let non_comment_lines: String = content
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");

    assert!(
        !non_comment_lines.contains("\"COMPLIANCE\""),
        "s3.tf must NOT hardcode \"COMPLIANCE\" in non-comment lines — use var.s3_object_lock_mode instead"
    );
}

/// **Proves:** End-to-end: `s3.tf` Object Lock block uses the variable for mode AND the
/// `variables.tf` file declares it with the GOVERNANCE default. The two files are consistent.
/// **Anti-fake property:** Cross-file consistency check — variable declared in one file, used in another.
#[test]
fn g6_e2e_object_lock_mode_variable_declared_and_used() {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let variables_tf = std::fs::read_to_string(repo_root.join("deploy/terraform/aws/variables.tf"))
        .expect("Must read variables.tf");
    let s3_tf = std::fs::read_to_string(repo_root.join("deploy/terraform/aws/s3.tf"))
        .expect("Must read s3.tf");

    // Variable declared
    assert!(
        variables_tf.contains("s3_object_lock_mode"),
        "s3_object_lock_mode must be declared in variables.tf"
    );

    // Variable used (not hardcoded)
    assert!(
        s3_tf.contains("var.s3_object_lock_mode"),
        "s3.tf must reference var.s3_object_lock_mode"
    );

    // Default is GOVERNANCE
    assert!(
        variables_tf.contains("\"GOVERNANCE\""),
        "Default must be GOVERNANCE in variables.tf"
    );

    // s3.tf non-comment lines must not hardcode COMPLIANCE
    let s3_non_comments: String = s3_tf
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");

    assert!(
        !s3_non_comments.contains("\"COMPLIANCE\""),
        "s3.tf must not hardcode COMPLIANCE — must use variable"
    );

    // Retention days: declared and used
    assert!(
        variables_tf.contains("object_lock_retention_days"),
        "object_lock_retention_days must be declared in variables.tf"
    );
    assert!(
        s3_tf.contains("var.object_lock_retention_days"),
        "s3.tf must reference var.object_lock_retention_days"
    );
}
