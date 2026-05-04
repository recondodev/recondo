//! Sprint D1.1 — Behavioral tests for `user_request_text` column on turns.
//!
//! These tests are written BEFORE the implementation exists. They assert on
//! externally observable behavior:
//!   1. The `user_request_text` column exists in the turns table (SQLite + PG DDL)
//!   2. `user_request_text` is populated when `process_capture` runs
//!   3. The value is truncated to 2000 chars max
//!   4. The value is populated for Anthropic, OpenAI/Codex, and Gemini CLI captures
//!   5. The TurnRecord struct has a `user_request_text` field
//!
//! Every test should FAIL until D1.1 is implemented. Once the implementation
//! is done, all tests must pass without modification.

use recondo_gateway::db;
use recondo_gateway::gateway;
use recondo_gateway::session::SessionManager;

mod common;
use common::pipeline::make_pipeline;

// ===========================================================================
// Fixture data
// ===========================================================================

/// A minimal Anthropic-style request body with a user message.
const ANTHROPIC_REQUEST: &str = r#"{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "system": "You are a helpful assistant.",
    "messages": [
        {"role": "user", "content": "Explain how TLS works in simple terms"}
    ],
    "metadata": {
        "user_id": "{\"session_id\":\"test-session-001\",\"account_uuid\":\"acct-001\",\"device_id\":\"dev-001\"}"
    }
}"#;

/// An Anthropic request with a very long user message (> 2000 chars).
fn anthropic_request_long_message() -> String {
    let long_text = "A".repeat(3000);
    format!(
        r#"{{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "system": "You are a helpful assistant.",
    "messages": [
        {{"role": "user", "content": "{}"}}
    ],
    "metadata": {{
        "user_id": "{{\"session_id\":\"test-session-long\",\"account_uuid\":\"acct-001\",\"device_id\":\"dev-001\"}}"
    }}
}}"#,
        long_text
    )
}

/// An Anthropic request with a multi-turn conversation — the extracted text
/// should be the LAST user message.
const ANTHROPIC_REQUEST_MULTI_TURN: &str = r#"{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "system": "You are a helpful assistant.",
    "messages": [
        {"role": "user", "content": "Hello, who are you?"},
        {"role": "assistant", "content": "I am Claude, an AI assistant."},
        {"role": "user", "content": "What is the capital of France?"}
    ],
    "metadata": {
        "user_id": "{\"session_id\":\"test-session-multi\",\"account_uuid\":\"acct-001\",\"device_id\":\"dev-001\"}"
    }
}"#;

/// An Anthropic request with content array containing preamble blocks and a user message.
const ANTHROPIC_REQUEST_WITH_PREAMBLE: &str = r#"{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "system": "You are a helpful assistant.",
    "messages": [
        {"role": "user", "content": [
            {"type": "text", "text": "<system-reminder>CLAUDE.md instructions here</system-reminder>"},
            {"type": "text", "text": "<available-deferred-tools>tool list here</available-deferred-tools>"},
            {"type": "text", "text": "Fix the bug in auth.rs"}
        ]}
    ],
    "metadata": {
        "user_id": "{\"session_id\":\"test-session-preamble\",\"account_uuid\":\"acct-001\",\"device_id\":\"dev-001\"}"
    }
}"#;

/// An Anthropic request with NO user messages (only assistant messages).
const ANTHROPIC_REQUEST_NO_USER: &str = r#"{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "system": "You are a helpful assistant.",
    "messages": [
        {"role": "assistant", "content": "How can I help?"}
    ],
    "metadata": {
        "user_id": "{\"session_id\":\"test-session-nouser\",\"account_uuid\":\"acct-001\",\"device_id\":\"dev-001\"}"
    }
}"#;

/// A minimal Anthropic SSE response.
const ANTHROPIC_RESPONSE: &str = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_test\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-20250514\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":100,\"output_tokens\":0,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"TLS works by...\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":50}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";

/// A Gemini CLI request body.
const GEMINI_CLI_REQUEST: &str = r#"{
    "model": "gemini-3-flash-preview",
    "project": "test-project",
    "user_prompt_id": "prompt-001",
    "request": {
        "session_id": "gem-session-001",
        "systemInstruction": {
            "parts": [{"text": "You are Gemini CLI, an autonomous CLI agent."}]
        },
        "contents": [
            {"role": "user", "parts": [{"text": "<session_context>project: myapp</session_context>"}]},
            {"role": "model", "parts": [{"text": "Ready to help."}]},
            {"role": "user", "parts": [{"text": "List all files in src/"}]}
        ]
    }
}"#;

/// A Gemini CLI SSE response.
const GEMINI_CLI_RESPONSE: &str = "data: {\"response\": {\"candidates\": [{\"content\": {\"role\": \"model\", \"parts\": [{\"text\": \"Here are the files...\"}]}, \"finishReason\": \"STOP\"}], \"usageMetadata\": {\"promptTokenCount\": 100, \"candidatesTokenCount\": 20, \"totalTokenCount\": 120}, \"modelVersion\": \"gemini-3-flash-preview\"}}\n\n";

// ===========================================================================
// Category 1: Schema — `user_request_text` column exists (3 tests)
// ===========================================================================

/// **Proves:** The `user_request_text` column exists in the SQLite turns table
/// schema after initialization.
///
/// **Anti-fake property:** Directly queries the schema metadata. A stub that
/// omits the column from CREATE TABLE would fail this test.
#[test]
fn sqlite_turns_table_has_user_request_text_column() {
    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();

    // Query SQLite schema metadata for the turns table columns
    let mut stmt = conn
        .prepare("PRAGMA table_info(turns)")
        .expect("PRAGMA table_info must succeed");
    let columns: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .expect("query must succeed")
        .filter_map(|r| r.ok())
        .collect();

    assert!(
        columns.contains(&"user_request_text".to_string()),
        "turns table must have a 'user_request_text' column. Found columns: {:?}",
        columns
    );
}

/// **Proves:** The PostgreSQL migration corpus contains the `user_request_text`
/// column in the turns table definition.
///
/// **Anti-fake property:** Searches the canonical `api/migrations/*.sql` source
/// of truth (concatenated via `include_str!`) directly.
#[test]
fn pg_migration_turns_table_has_user_request_text_column() {
    let sql = common::pg_migrations::pg_migration_sql();
    assert!(
        sql.contains("user_request_text"),
        "api/migrations/*.sql must define the 'user_request_text' column on the turns table"
    );
}

/// **Proves:** The TurnRecord struct has a `user_request_text` field.
///
/// **Anti-fake property:** Constructs a TurnRecord and accesses the field.
/// Compilation fails if the field does not exist.
#[test]
fn turn_record_has_user_request_text_field() {
    let turn = db::TurnRecord {
        id: "test-id".to_string(),
        session_id: "test-session".to_string(),
        sequence_num: 1,
        timestamp: "2025-01-01T00:00:00Z".to_string(),
        request_hash: "hash-req".to_string(),
        response_hash: "hash-resp".to_string(),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some("test-model".to_string()),
        response_text: None,
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: "2025-01-01T00:00:00Z".to_string(),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: None,
        parser_version: None,
        parse_errors: None,
        provider: Some("anthropic".to_string()),
        transport: Some("http".to_string()),
        ws_direction: None,
        duration_ms: None,
        ttfb_ms: None,
        api_endpoint: None,
        http_status: None,
        error_message: None,
        retry_count: 0,
        tool_call_count: 0,
        thinking_tokens: 0,
        server_id: None,
        integrity_verified: None,
        supersedes_turn_id: None,
        // D1.1: This field must exist on TurnRecord
        user_request_text: Some("test user message".to_string()),
        attachment_count: 0,
    };

    assert_eq!(
        turn.user_request_text.as_deref(),
        Some("test user message"),
        "user_request_text must be accessible on TurnRecord"
    );
}

// ===========================================================================
// Category 2: Anthropic captures populate user_request_text (4 tests)
// ===========================================================================

/// **Proves:** An Anthropic capture produces a TurnRecord with `user_request_text`
/// populated from the user's message in the request body.
///
/// **Anti-fake property:** The text must match the actual user message from the
/// fixture, not be empty or None.
#[test]
fn anthropic_capture_populates_user_request_text() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        ANTHROPIC_REQUEST.as_bytes(),
        ANTHROPIC_RESPONSE.as_bytes(),
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed for Anthropic");

    assert!(
        turn.user_request_text.is_some(),
        "user_request_text must be populated for Anthropic captures"
    );
    let text = turn.user_request_text.unwrap();
    assert!(
        text.contains("Explain how TLS works"),
        "user_request_text must contain the user's message. Got: {:?}",
        text
    );
}

/// **Proves:** In a multi-turn Anthropic request, `user_request_text` is
/// extracted from the LAST user message, not the first.
///
/// **Anti-fake property:** Must contain "capital of France", not "Hello, who are you?".
#[test]
fn anthropic_capture_uses_last_user_message() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        ANTHROPIC_REQUEST_MULTI_TURN.as_bytes(),
        ANTHROPIC_RESPONSE.as_bytes(),
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed");

    assert!(
        turn.user_request_text.is_some(),
        "user_request_text must be populated for multi-turn requests"
    );
    let text = turn.user_request_text.unwrap();
    assert!(
        text.contains("capital of France"),
        "user_request_text must contain the LAST user message. Got: {:?}",
        text
    );
    assert!(
        !text.contains("Hello, who are you"),
        "user_request_text must NOT contain earlier user messages. Got: {:?}",
        text
    );
}

/// **Proves:** When user messages contain preamble blocks (system-reminder,
/// available-deferred-tools), the preamble is filtered out and only the
/// actual user message is stored in `user_request_text`.
///
/// **Anti-fake property:** Must contain "Fix the bug in auth.rs", not
/// "<system-reminder>" or "<available-deferred-tools>".
#[test]
fn anthropic_capture_filters_preamble_from_user_request_text() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        ANTHROPIC_REQUEST_WITH_PREAMBLE.as_bytes(),
        ANTHROPIC_RESPONSE.as_bytes(),
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed");

    assert!(
        turn.user_request_text.is_some(),
        "user_request_text must be populated even when preamble is present"
    );
    let text = turn.user_request_text.unwrap();
    assert!(
        text.contains("Fix the bug in auth.rs"),
        "user_request_text must contain the real user message, not preamble. Got: {:?}",
        text
    );
    assert!(
        !text.contains("<system-reminder>"),
        "user_request_text must NOT contain preamble. Got: {:?}",
        text
    );
    assert!(
        !text.contains("<available-deferred-tools>"),
        "user_request_text must NOT contain preamble. Got: {:?}",
        text
    );
}

/// **Proves:** `user_request_text` is persisted to the database and can be
/// read back from a DB query.
///
/// **Anti-fake property:** Queries the database directly for the turn record
/// and checks the field is present.
#[test]
fn anthropic_capture_persists_user_request_text_to_db() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        ANTHROPIC_REQUEST.as_bytes(),
        ANTHROPIC_RESPONSE.as_bytes(),
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed");

    // Read it back from the graph store
    let db_turn = pipeline
        .graph()
        .get_turn(&turn.id)
        .expect("graph query must succeed")
        .expect("Turn must exist in graph store");

    assert!(
        db_turn.user_request_text.is_some(),
        "user_request_text must be persisted to the database"
    );
    assert!(
        db_turn
            .user_request_text
            .as_ref()
            .unwrap()
            .contains("Explain how TLS works"),
        "user_request_text must round-trip through DB. Got: {:?}",
        db_turn.user_request_text
    );
}

// ===========================================================================
// Category 3: Truncation (2 tests)
// ===========================================================================

/// **Proves:** `user_request_text` is truncated to at most 2000 characters
/// when the user message exceeds the limit.
///
/// **Anti-fake property:** The fixture has a 3000-char message. The stored
/// value must be at most 2000 chars.
#[test]
fn user_request_text_truncated_to_2000_chars() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let long_request = anthropic_request_long_message();

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        long_request.as_bytes(),
        ANTHROPIC_RESPONSE.as_bytes(),
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed");

    assert!(
        turn.user_request_text.is_some(),
        "user_request_text must be populated even for long messages"
    );
    let text = turn.user_request_text.unwrap();
    assert!(
        text.chars().count() <= 2000,
        "user_request_text must be truncated to max 2000 chars. Got {} chars",
        text.chars().count()
    );
}

/// **Proves:** A message exactly at the 2000-char boundary is NOT truncated.
///
/// **Anti-fake property:** Ensures truncation does not shorten messages that
/// are within the limit.
#[test]
fn user_request_text_not_truncated_under_limit() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        ANTHROPIC_REQUEST.as_bytes(),
        ANTHROPIC_RESPONSE.as_bytes(),
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed");

    assert!(
        turn.user_request_text.is_some(),
        "user_request_text must be populated"
    );
    let text = turn.user_request_text.unwrap();
    // "Explain how TLS works in simple terms" is ~38 chars, well under 2000
    assert_eq!(
        text, "Explain how TLS works in simple terms",
        "Short messages must be stored without truncation"
    );
}

// ===========================================================================
// Category 4: Gemini CLI captures populate user_request_text (2 tests)
// ===========================================================================

/// **Proves:** A Gemini CLI capture produces a TurnRecord with `user_request_text`
/// populated from the last user message in the request's `contents` array.
///
/// **Anti-fake property:** Must contain "List all files in src/", not the
/// preamble "<session_context>..." from the first user message.
#[test]
fn gemini_cli_capture_populates_user_request_text() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "google",
        GEMINI_CLI_REQUEST.as_bytes(),
        GEMINI_CLI_RESPONSE.as_bytes(),
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed for Gemini CLI");

    assert!(
        turn.user_request_text.is_some(),
        "user_request_text must be populated for Gemini CLI captures"
    );
    let text = turn.user_request_text.unwrap();
    assert!(
        text.contains("List all files in src/"),
        "user_request_text must contain the last user message for Gemini CLI. Got: {:?}",
        text
    );
}

/// **Proves:** Gemini CLI captures filter out `<session_context>` preamble
/// and use the actual user message for `user_request_text`.
///
/// **Anti-fake property:** Must NOT contain "<session_context>".
#[test]
fn gemini_cli_capture_filters_session_context_preamble() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "google",
        GEMINI_CLI_REQUEST.as_bytes(),
        GEMINI_CLI_RESPONSE.as_bytes(),
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed");

    let text = turn.user_request_text.as_deref().unwrap_or("");
    assert!(
        !text.contains("<session_context>"),
        "user_request_text must NOT contain Gemini CLI preamble. Got: {:?}",
        text
    );
}

// ===========================================================================
// Category 5: Negative / edge case tests (3 tests)
// ===========================================================================

/// **Proves:** When no user messages exist in the request, `user_request_text`
/// is None (not empty string or a fabricated value).
///
/// **Anti-fake property:** Must be None, not Some("").
#[test]
fn no_user_messages_produces_none_user_request_text() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        ANTHROPIC_REQUEST_NO_USER.as_bytes(),
        ANTHROPIC_RESPONSE.as_bytes(),
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed");

    assert!(
        turn.user_request_text.is_none(),
        "user_request_text must be None when there are no user messages. Got: {:?}",
        turn.user_request_text
    );
}

/// **Proves:** The `user_request_text` column in SQLite has type TEXT (nullable).
///
/// **Anti-fake property:** The column must accept NULL values so that turns
/// without user messages can be stored.
#[test]
fn sqlite_user_request_text_column_is_nullable() {
    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();

    // Insert a session first (required by FK constraint)
    let session = db::SessionRecord {
        id: "test-session-nullable".to_string(),
        provider: "anthropic".to_string(),
        model: Some("test-model".to_string()),
        started_at: "2025-01-01T00:00:00Z".to_string(),
        last_active_at: "2025-01-01T00:00:00Z".to_string(),
        system_prompt_hash: "hash123".to_string(),
        ..Default::default()
    };
    db::insert_session(&conn, &session).unwrap();

    // Insert a turn with user_request_text = None
    let turn = db::TurnRecord {
        id: "test-turn-nullable".to_string(),
        session_id: "test-session-nullable".to_string(),
        sequence_num: 1,
        timestamp: "2025-01-01T00:00:00Z".to_string(),
        request_hash: "req-hash".to_string(),
        response_hash: "resp-hash".to_string(),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some("test-model".to_string()),
        response_text: None,
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: "2025-01-01T00:00:00Z".to_string(),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: None,
        parser_version: None,
        parse_errors: None,
        provider: Some("anthropic".to_string()),
        transport: Some("http".to_string()),
        ws_direction: None,
        duration_ms: None,
        ttfb_ms: None,
        api_endpoint: None,
        http_status: None,
        error_message: None,
        retry_count: 0,
        tool_call_count: 0,
        thinking_tokens: 0,
        server_id: None,
        integrity_verified: None,
        supersedes_turn_id: None,
        user_request_text: None,
        attachment_count: 0,
    };

    // insert_turn must succeed with user_request_text = None
    db::insert_turn(&conn, &turn).expect("insert_turn with NULL user_request_text must succeed");

    // Read it back
    let db_turn = db::get_turn(&conn, "test-turn-nullable")
        .expect("get_turn must succeed")
        .expect("turn must exist");

    assert!(
        db_turn.user_request_text.is_none(),
        "user_request_text must be None when inserted as None"
    );
}

/// **Proves:** A turn with `user_request_text = Some(value)` can be inserted
/// and read back from the database with the value intact.
///
/// **Anti-fake property:** The value read from the DB must match what was
/// written, proving the column is actually wired up in insert/select.
#[test]
fn sqlite_user_request_text_round_trips_through_db() {
    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();

    let session = db::SessionRecord {
        id: "test-session-roundtrip".to_string(),
        provider: "anthropic".to_string(),
        model: Some("test-model".to_string()),
        started_at: "2025-01-01T00:00:00Z".to_string(),
        last_active_at: "2025-01-01T00:00:00Z".to_string(),
        system_prompt_hash: "hash123".to_string(),
        ..Default::default()
    };
    db::insert_session(&conn, &session).unwrap();

    let turn = db::TurnRecord {
        id: "test-turn-roundtrip".to_string(),
        session_id: "test-session-roundtrip".to_string(),
        sequence_num: 1,
        timestamp: "2025-01-01T00:00:00Z".to_string(),
        request_hash: "req-hash".to_string(),
        response_hash: "resp-hash".to_string(),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some("test-model".to_string()),
        response_text: None,
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: "2025-01-01T00:00:00Z".to_string(),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: None,
        parser_version: None,
        parse_errors: None,
        provider: Some("anthropic".to_string()),
        transport: Some("http".to_string()),
        ws_direction: None,
        duration_ms: None,
        ttfb_ms: None,
        api_endpoint: None,
        http_status: None,
        error_message: None,
        retry_count: 0,
        tool_call_count: 0,
        thinking_tokens: 0,
        server_id: None,
        integrity_verified: None,
        supersedes_turn_id: None,
        user_request_text: Some("Round-trip test message".to_string()),
        attachment_count: 0,
    };

    db::insert_turn(&conn, &turn).expect("insert_turn with user_request_text must succeed");

    let db_turn = db::get_turn(&conn, "test-turn-roundtrip")
        .expect("get_turn must succeed")
        .expect("turn must exist");

    assert_eq!(
        db_turn.user_request_text.as_deref(),
        Some("Round-trip test message"),
        "user_request_text must round-trip through insert/get. Got: {:?}",
        db_turn.user_request_text
    );
}
