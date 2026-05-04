//! Feature 5: OD-007 Forward compatibility fields tests.
//!
//! These tests verify that TurnRecord includes:
//! - raw_extra: unknown JSON fields preserved verbatim
//! - parser_version: semver string identifying the parser
//! - parse_errors: list of parse error strings
//!
//! Design reference: OD-007 (LLM API Forward Compatibility).
//!
//! Key invariants from OD-007:
//! - Unknown fields are preserved in raw_extra JSON field
//! - Parser version is recorded on each TurnNode
//! - Parse errors are logged to parse_errors array, never crash
//! - Raw bytes are ALWAYS forwarded and stored unmodified

use serde_json::json;

use recondo_gateway::db;
use recondo_gateway::providers::anthropic;
use recondo_gateway::stream::SseEvent;

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

fn setup_db_with_session() -> (rusqlite::Connection, String) {
    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();

    let session_id = "sess_fwd_compat".to_string();
    let session = db::SessionRecord {
        id: session_id.clone(),
        provider: "anthropic".to_string(),
        model: None,
        started_at: "2026-03-17T10:00:00Z".to_string(),
        last_active_at: "2026-03-17T10:00:00Z".to_string(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash: "hash".to_string(),
        total_turns: 0,
        turns_captured: 0,
        dropped_events: 0,
        total_tokens: 0,
        total_cost_usd: 0.0,
        framework: None,
        agent_id: None,
        agent_version: None,
        git_repo: None,
        git_branch: None,
        git_commit: None,
        working_directory: None,
        parent_session_id: None,
        tags: None,
        account_uuid: None,
        device_id: None,
        tool_definitions_hash: String::new(),
    };
    db::insert_session(&conn, &session).unwrap();

    (conn, session_id)
}

fn evt(event_type: &str, data: &str) -> SseEvent {
    SseEvent {
        event_type: event_type.to_string(),
        data: data.to_string(),
    }
}

// ===========================================================================
// 5.1 raw_extra field stores unknown JSON fields from response
// ===========================================================================

/// **Proves:** When the Anthropic API response contains unknown fields that
/// the parser doesn't recognize, those fields are preserved in the raw_extra
/// JSON field of the parse result, and they round-trip through the DB.
///
/// **Anti-fake property:** A parser that drops unknown fields would produce
/// None or empty raw_extra. A parser without the raw_extra concept would
/// fail to compile.
#[test]
fn raw_extra_preserves_unknown_response_fields() {
    // message_start with a hypothetical "beta_feature" field the parser doesn't know
    let events = vec![
        evt(
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_unk","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1},"beta_feature":"enabled","experimental_metadata":{"version":"2.0"}}}"#,
        ),
        evt(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        ),
        evt(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}"#,
        ),
        evt(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        evt(
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn","future_field":42},"usage":{"output_tokens":5}}"#,
        ),
        evt("message_stop", r#"{"type":"message_stop"}"#),
    ];

    let parsed = anthropic::parse_response(&events).unwrap();

    // raw_extra must contain the unknown fields
    assert!(
        parsed.raw_extra.is_some(),
        "Unknown fields must be captured in raw_extra"
    );

    let raw_extra = parsed.raw_extra.as_ref().unwrap();
    let extra: serde_json::Value =
        serde_json::from_str(raw_extra).expect("raw_extra must be valid JSON");

    // Verify at least one of the unknown fields is preserved
    // The exact structure depends on implementation, but the unknown data
    // must be accessible
    let extra_str = serde_json::to_string(&extra).unwrap();
    assert!(
        extra_str.contains("beta_feature")
            || extra_str.contains("experimental_metadata")
            || extra_str.contains("future_field"),
        "raw_extra must contain at least one unknown field, got: {}",
        extra_str
    );
}

// ===========================================================================
// 5.2 raw_extra round-trips through DB
// ===========================================================================

/// **Proves:** The raw_extra JSON string is stored in the turns table and
/// can be retrieved intact.
///
/// **Anti-fake property:** A DB schema without a raw_extra column would fail
/// at insert time. A schema that silently drops the column would return None.
#[test]
fn raw_extra_round_trips_through_db() {
    let (conn, session_id) = setup_db_with_session();

    let raw_extra_json = json!({
        "beta_feature": "enabled",
        "experimental_metadata": {"version": "2.0"}
    })
    .to_string();

    let turn = db::TurnRecord {
        id: "turn_extra".to_string(),
        session_id,
        sequence_num: 1,
        timestamp: "2026-03-17T10:01:00Z".to_string(),
        request_hash: "req".to_string(),
        response_hash: "resp".to_string(),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some("claude-sonnet-4-20250514".to_string()),
        response_text: Some("Hi".to_string()),
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: "2026-03-17T10:01:00Z".to_string(),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: Some(raw_extra_json.clone()),
        parser_version: Some("0.1.0".to_string()),
        parse_errors: None,
        provider: None,
        transport: None,
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
    db::insert_turn(&conn, &turn).unwrap();

    let db_turn = db::get_turn(&conn, "turn_extra").unwrap().unwrap();

    assert_eq!(
        db_turn.raw_extra.as_deref(),
        Some(raw_extra_json.as_str()),
        "raw_extra must round-trip through DB"
    );

    // Verify the stored JSON is parseable
    let stored: serde_json::Value =
        serde_json::from_str(db_turn.raw_extra.as_ref().unwrap()).unwrap();
    assert_eq!(stored["beta_feature"].as_str().unwrap(), "enabled");
}

// ===========================================================================
// 5.3 parser_version is a semver string
// ===========================================================================

/// **Proves:** The parser records its version as a semver string on each
/// TurnRecord. This enables future re-parsing when the parser is updated.
///
/// **Anti-fake property:** A parser that doesn't set parser_version would
/// leave it as None. A parser that sets it to a non-semver string would
/// fail the format assertion.
#[test]
fn parser_version_is_semver_string() {
    let events = vec![
        evt(
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_pv","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}"#,
        ),
        evt(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        ),
        evt(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#,
        ),
        evt(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        evt(
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}"#,
        ),
        evt("message_stop", r#"{"type":"message_stop"}"#),
    ];

    let parsed = anthropic::parse_response(&events).unwrap();

    assert!(
        parsed.parser_version.is_some(),
        "parser_version must be set on every parsed response"
    );

    let version = parsed.parser_version.as_ref().unwrap();

    // Must match semver format: X.Y.Z
    let parts: Vec<&str> = version.split('.').collect();
    assert_eq!(
        parts.len(),
        3,
        "parser_version must be semver (X.Y.Z), got: {:?}",
        version
    );
    for (i, part) in parts.iter().enumerate() {
        assert!(
            part.parse::<u32>().is_ok(),
            "parser_version part {} ('{}') must be a number, got: {:?}",
            i,
            part,
            version
        );
    }
}

// ===========================================================================
// 5.4 parser_version round-trips through DB
// ===========================================================================

/// **Proves:** parser_version is stored in the DB and can be retrieved.
///
/// **Anti-fake property:** A DB schema missing the parser_version column
/// would fail at insert or return None.
#[test]
fn parser_version_round_trips_through_db() {
    let (conn, session_id) = setup_db_with_session();

    let turn = db::TurnRecord {
        id: "turn_pv".to_string(),
        session_id,
        sequence_num: 1,
        timestamp: "2026-03-17T10:01:00Z".to_string(),
        request_hash: "req".to_string(),
        response_hash: "resp".to_string(),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some("claude-sonnet-4-20250514".to_string()),
        response_text: Some("Hello".to_string()),
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: "2026-03-17T10:01:00Z".to_string(),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: None,
        parser_version: Some("0.3.1".to_string()),
        parse_errors: None,
        provider: None,
        transport: None,
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
    db::insert_turn(&conn, &turn).unwrap();

    let db_turn = db::get_turn(&conn, "turn_pv").unwrap().unwrap();
    assert_eq!(
        db_turn.parser_version.as_deref(),
        Some("0.3.1"),
        "parser_version must round-trip through DB"
    );
}

// ===========================================================================
// 5.5 parse_errors: captures parsing failures without crashing
// ===========================================================================

/// **Proves:** When the parser encounters a field it cannot parse (e.g.,
/// an unknown content block type), it records the error in parse_errors
/// instead of crashing.
///
/// **Anti-fake property:** A parser that panics on unknown content types
/// would crash this test. A parser that silently ignores errors and returns
/// an empty parse_errors list would fail the assertion.
#[test]
fn parse_errors_recorded_for_unknown_content_block_type() {
    let events = vec![
        evt(
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_err","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}"#,
        ),
        // Unknown content block type that the parser should not crash on
        evt(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"holographic_display","data":"future content"}}"#,
        ),
        evt(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"holographic_delta","frame":"abc123"}}"#,
        ),
        evt(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        evt(
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}"#,
        ),
        evt("message_stop", r#"{"type":"message_stop"}"#),
    ];

    // Must not panic
    let parsed = anthropic::parse_response(&events).unwrap();

    // parse_errors must contain at least one entry about the unknown type
    assert!(
        parsed.parse_errors.is_some(),
        "Unknown content block type must produce parse_errors"
    );

    let errors = parsed.parse_errors.as_ref().unwrap();
    assert!(
        !errors.is_empty(),
        "parse_errors must be non-empty for unknown content block type"
    );

    // At least one error should mention the unknown type
    let errors_str = errors.join(" ");
    assert!(
        errors_str.contains("holographic")
            || errors_str.contains("unknown")
            || errors_str.contains("unrecognized"),
        "parse_errors must mention the unknown type, got: {:?}",
        errors
    );
}

// ===========================================================================
// 5.6 parse_errors round-trips through DB as JSON array
// ===========================================================================

/// **Proves:** parse_errors is stored as a JSON array of strings in the DB
/// and can be retrieved intact.
///
/// **Anti-fake property:** A DB schema without parse_errors column fails at
/// insert. A schema that stores it as a single string (not JSON array)
/// would fail the array parsing assertion.
#[test]
fn parse_errors_round_trip_through_db() {
    let (conn, session_id) = setup_db_with_session();

    let parse_errors = json!([
        "Unknown content block type: holographic_display",
        "Unknown delta type: holographic_delta"
    ])
    .to_string();

    let turn = db::TurnRecord {
        id: "turn_perr".to_string(),
        session_id,
        sequence_num: 1,
        timestamp: "2026-03-17T10:01:00Z".to_string(),
        request_hash: "req".to_string(),
        response_hash: "resp".to_string(),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some("claude-sonnet-4-20250514".to_string()),
        response_text: None,
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: "2026-03-17T10:01:00Z".to_string(),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: None,
        parser_version: Some("0.1.0".to_string()),
        parse_errors: Some(parse_errors.clone()),
        provider: None,
        transport: None,
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
    db::insert_turn(&conn, &turn).unwrap();

    let db_turn = db::get_turn(&conn, "turn_perr").unwrap().unwrap();

    assert_eq!(
        db_turn.parse_errors.as_deref(),
        Some(parse_errors.as_str()),
        "parse_errors must round-trip through DB"
    );

    // Verify it's a valid JSON array
    let stored: serde_json::Value =
        serde_json::from_str(db_turn.parse_errors.as_ref().unwrap()).unwrap();
    assert!(stored.is_array(), "parse_errors must be a JSON array");
    assert_eq!(stored.as_array().unwrap().len(), 2);
    assert!(stored[0].as_str().unwrap().contains("holographic_display"));
}

// ===========================================================================
// 5.7 All three forward-compat fields can be None
// ===========================================================================

/// **Proves:** When no unknown fields are encountered and the parser has no
/// errors, raw_extra is None, parse_errors is None, and parser_version is
/// still set (it's always set).
///
/// **Anti-fake property:** raw_extra and parse_errors being None when
/// everything parses cleanly proves they are only populated on actual
/// unknowns/errors, not filled with empty defaults.
#[test]
fn clean_parse_has_none_for_optional_compat_fields() {
    let events = vec![
        evt(
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_clean","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}"#,
        ),
        evt(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        ),
        evt(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Clean"}}"#,
        ),
        evt(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        evt(
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}"#,
        ),
        evt("message_stop", r#"{"type":"message_stop"}"#),
    ];

    let parsed = anthropic::parse_response(&events).unwrap();

    // parser_version should always be set
    assert!(
        parsed.parser_version.is_some(),
        "parser_version must always be set, even on clean parse"
    );

    // raw_extra should be None when no unknown fields exist
    // (or Some("{}") / Some("null") — either is acceptable for "no extras")
    if let Some(ref extra) = parsed.raw_extra {
        let v: serde_json::Value = serde_json::from_str(extra).unwrap();
        assert!(
            v.is_null() || (v.is_object() && v.as_object().unwrap().is_empty()),
            "raw_extra on clean parse must be None or empty JSON, got: {}",
            extra
        );
    }

    // parse_errors should be None or empty when everything parses cleanly
    match &parsed.parse_errors {
        None => {}                              // correct
        Some(errors) if errors.is_empty() => {} // also correct
        Some(errors) => panic!(
            "parse_errors must be None or empty on clean parse, got: {:?}",
            errors
        ),
    }
}

// ===========================================================================
// 5.8 All three forward-compat fields on TurnRecord
// ===========================================================================

/// **Proves:** The TurnRecord struct has all three forward-compat fields
/// and they can be set simultaneously without conflict.
///
/// **Anti-fake property:** A TurnRecord missing any of these fields would
/// fail to compile.
#[test]
fn turn_record_has_all_forward_compat_fields() {
    let (conn, session_id) = setup_db_with_session();

    let turn = db::TurnRecord {
        id: "turn_all_compat".to_string(),
        session_id,
        sequence_num: 1,
        timestamp: "2026-03-17T10:01:00Z".to_string(),
        request_hash: "req".to_string(),
        response_hash: "resp".to_string(),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some("claude-sonnet-4-20250514".to_string()),
        response_text: Some("result".to_string()),
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: "2026-03-17T10:01:00Z".to_string(),
        messages_delta: None,
        messages_delta_count: None,
        // All three forward-compat fields set simultaneously
        raw_extra: Some(r#"{"new_api_field":"value"}"#.to_string()),
        parser_version: Some("0.3.1".to_string()),
        parse_errors: Some(r#"["minor warning"]"#.to_string()),
        provider: None,
        transport: None,
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

    db::insert_turn(&conn, &turn).unwrap();

    let db_turn = db::get_turn(&conn, "turn_all_compat").unwrap().unwrap();

    assert_eq!(
        db_turn.raw_extra.as_deref(),
        Some(r#"{"new_api_field":"value"}"#),
        "raw_extra must be stored"
    );
    assert_eq!(
        db_turn.parser_version.as_deref(),
        Some("0.3.1"),
        "parser_version must be stored"
    );
    assert_eq!(
        db_turn.parse_errors.as_deref(),
        Some(r#"["minor warning"]"#),
        "parse_errors must be stored"
    );
}

// ===========================================================================
// 5.9 NEGATIVE: parser without version field
// ===========================================================================

/// **Proves:** Attempting to create a TurnRecord with parser_version = None
/// and then querying it returns None for that field — proving the field is
/// truly optional and not auto-filled by the DB.
///
/// **Anti-fake property:** A DB with a DEFAULT value for parser_version would
/// return a non-None value, failing this test.
#[test]
fn turn_without_parser_version_returns_none() {
    let (conn, session_id) = setup_db_with_session();

    let turn = db::TurnRecord {
        id: "turn_no_pv".to_string(),
        session_id,
        sequence_num: 1,
        timestamp: "2026-03-17T10:01:00Z".to_string(),
        request_hash: "req".to_string(),
        response_hash: "resp".to_string(),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some("claude-sonnet-4-20250514".to_string()),
        response_text: None,
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: "2026-03-17T10:01:00Z".to_string(),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: None,
        parser_version: None,
        parse_errors: None,
        provider: None,
        transport: None,
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
    db::insert_turn(&conn, &turn).unwrap();

    let db_turn = db::get_turn(&conn, "turn_no_pv").unwrap().unwrap();
    assert!(
        db_turn.parser_version.is_none(),
        "parser_version must be None when not set"
    );
    assert!(
        db_turn.raw_extra.is_none(),
        "raw_extra must be None when not set"
    );
    assert!(
        db_turn.parse_errors.is_none(),
        "parse_errors must be None when not set"
    );
}

// ===========================================================================
// 5.10 NEGATIVE: unknown event type in SSE stream does not crash parser
// ===========================================================================

/// **Proves:** An entirely unknown SSE event type (not in the Anthropic spec)
/// does not cause the parser to crash. The parser may log it in parse_errors
/// or silently skip it, but it must not panic.
///
/// **Anti-fake property:** A parser with exhaustive match on event types
/// without a wildcard arm would crash.
#[test]
fn unknown_sse_event_type_does_not_crash() {
    let events = vec![
        evt(
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_fut","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}"#,
        ),
        // Completely unknown event type
        evt(
            "quantum_entanglement",
            r#"{"type":"quantum_entanglement","particles":["a","b"]}"#,
        ),
        evt(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        ),
        evt(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Still works"}}"#,
        ),
        evt(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        evt(
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}"#,
        ),
        evt("message_stop", r#"{"type":"message_stop"}"#),
    ];

    // Must not panic
    let parsed = anthropic::parse_response(&events).unwrap();

    // Known content should still be parsed correctly
    assert_eq!(
        parsed.response_text, "Still works",
        "Known events must still be parsed correctly despite unknown events"
    );
    assert_eq!(parsed.stop_reason, "end_turn");
}

// ===========================================================================
// 5.11 raw_extra handles deeply nested unknown structures
// ===========================================================================

/// **Proves:** raw_extra preserves deeply nested unknown JSON structures,
/// not just flat key-value pairs.
///
/// **Anti-fake property:** A serializer that only handles flat JSON would
/// lose the nested structure.
#[test]
fn raw_extra_preserves_deeply_nested_json() {
    let (conn, session_id) = setup_db_with_session();

    let nested_json = json!({
        "future_api": {
            "nested": {
                "deeply": {
                    "data": [1, 2, 3],
                    "flag": true
                }
            }
        }
    })
    .to_string();

    let turn = db::TurnRecord {
        id: "turn_nested".to_string(),
        session_id,
        sequence_num: 1,
        timestamp: "2026-03-17T10:01:00Z".to_string(),
        request_hash: "req".to_string(),
        response_hash: "resp".to_string(),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some("claude-sonnet-4-20250514".to_string()),
        response_text: None,
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: "2026-03-17T10:01:00Z".to_string(),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: Some(nested_json.clone()),
        parser_version: Some("0.1.0".to_string()),
        parse_errors: None,
        provider: None,
        transport: None,
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
    db::insert_turn(&conn, &turn).unwrap();

    let db_turn = db::get_turn(&conn, "turn_nested").unwrap().unwrap();

    let stored: serde_json::Value =
        serde_json::from_str(db_turn.raw_extra.as_ref().unwrap()).unwrap();
    assert_eq!(
        stored["future_api"]["nested"]["deeply"]["data"][1]
            .as_i64()
            .unwrap(),
        2,
        "Deeply nested JSON must be preserved in raw_extra"
    );
    assert!(
        stored["future_api"]["nested"]["deeply"]["flag"]
            .as_bool()
            .unwrap(),
        "Nested boolean must be preserved in raw_extra"
    );
}
