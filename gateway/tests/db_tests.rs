//! Category D: SQLite Database tests.
//!
//! These tests verify that the db module correctly creates tables, inserts records,
//! and queries data with proper relationships and constraints.

use recondo_gateway::db::{self, SessionRecord, ToolCallRecord, TurnRecord};
use rusqlite::Connection;

// ---------------------------------------------------------------------------
// Helper: create an in-memory database and initialize schema
// NOTE: This setup_db helper is duplicated in schema_expansion_tests.rs.
// This is acceptable — each Rust integration test file is a separate crate,
// so sharing test helpers requires a separate test-utils crate or module,
// which is not recondoed for a two-function helper.
// ---------------------------------------------------------------------------

fn setup_db() -> Connection {
    let conn = db::open_in_memory().expect("Must open in-memory SQLite with FK enforcement");
    db::initialize(&conn).expect("Must initialize database schema");
    conn
}

fn sample_session(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.to_string(),
        provider: "anthropic".to_string(),
        model: None,
        started_at: "2026-03-17T10:00:00Z".to_string(),
        last_active_at: "2026-03-17T10:05:00Z".to_string(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash: "abc123def456".to_string(),
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
    }
}

fn sample_turn(id: &str, session_id: &str, seq: i64) -> TurnRecord {
    TurnRecord {
        id: id.to_string(),
        session_id: session_id.to_string(),
        sequence_num: seq,
        timestamp: format!("2026-03-17T10:{:02}:00Z", seq),
        request_hash: format!("req_hash_{}", seq),
        response_hash: format!("resp_hash_{}", seq),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some("claude-sonnet-4-20250514".to_string()),
        response_text: None,
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 100 * seq,
        output_tokens: 50 * seq,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: format!("2026-03-17T10:{:02}:00Z", seq),
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
    }
}

fn sample_tool_call(id: &str, turn_id: &str) -> ToolCallRecord {
    ToolCallRecord {
        id: id.to_string(),
        turn_id: turn_id.to_string(),
        tool_name: "read_file".to_string(),
        tool_input: r#"{"path":"src/main.rs"}"#.to_string(),
        input_hash: None,
        sequence_num: None,
        output: None,
        output_hash: None,
        duration_ms: None,
        error: None,
        status: None,
        artifacts_created: None,
        artifact_hashes: None,
    }
}

// ===========================================================================
// D.1 Initialize creates all 3 tables
// ===========================================================================

/// **Proves:** After initialization, the sessions, turns, and tool_calls tables exist.
#[test]
fn initialize_creates_sessions_table() {
    let conn = setup_db();

    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='sessions'",
            [],
            |row| row.get(0),
        )
        .unwrap();

    assert_eq!(count, 1, "sessions table must exist after initialization");
}

#[test]
fn initialize_creates_turns_table() {
    let conn = setup_db();

    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='turns'",
            [],
            |row| row.get(0),
        )
        .unwrap();

    assert_eq!(count, 1, "turns table must exist after initialization");
}

#[test]
fn initialize_creates_tool_calls_table() {
    let conn = setup_db();

    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='tool_calls'",
            [],
            |row| row.get(0),
        )
        .unwrap();

    assert_eq!(count, 1, "tool_calls table must exist after initialization");
}

/// **Proves:** Calling initialize twice does not error (idempotent).
#[test]
fn initialize_is_idempotent() {
    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();
    let result = db::initialize(&conn);
    assert!(
        result.is_ok(),
        "Calling initialize twice must not produce an error"
    );
}

// ===========================================================================
// D.2 Insert and retrieve a session
// ===========================================================================

/// **Proves:** A session can be inserted and retrieved by ID with all fields intact.
#[test]
fn insert_and_get_session_by_id() {
    let conn = setup_db();
    let session = sample_session("sess_001");

    db::insert_session(&conn, &session).unwrap();

    let retrieved = db::get_session(&conn, "sess_001")
        .unwrap()
        .expect("Session must be found by ID");

    assert_eq!(retrieved.id, "sess_001");
    assert_eq!(retrieved.system_prompt_hash, "abc123def456");
    assert_eq!(retrieved.started_at, "2026-03-17T10:00:00Z");
    assert_eq!(retrieved.last_active_at, "2026-03-17T10:05:00Z");
    assert_eq!(retrieved.provider, "anthropic");
}

/// **Proves:** Getting a non-existent session returns None, not an error.
#[test]
fn get_nonexistent_session_returns_none() {
    let conn = setup_db();

    let result = db::get_session(&conn, "does_not_exist").unwrap();
    assert!(result.is_none(), "Non-existent session ID must return None");
}

/// **Proves:** list_sessions returns all inserted sessions.
#[test]
fn list_sessions_returns_all() {
    let conn = setup_db();

    db::insert_session(&conn, &sample_session("sess_A")).unwrap();
    db::insert_session(&conn, &sample_session("sess_B")).unwrap();
    db::insert_session(&conn, &sample_session("sess_C")).unwrap();

    let sessions = db::list_sessions(&conn, None).unwrap();
    assert_eq!(sessions.len(), 3, "Must return all 3 sessions");

    let ids: Vec<&str> = sessions.iter().map(|s| s.id.as_str()).collect();
    assert!(ids.contains(&"sess_A"));
    assert!(ids.contains(&"sess_B"));
    assert!(ids.contains(&"sess_C"));
}

/// **Proves:** list_sessions on empty database returns empty vec.
#[test]
fn list_sessions_empty_returns_empty() {
    let conn = setup_db();
    let sessions = db::list_sessions(&conn, None).unwrap();
    assert!(sessions.is_empty(), "Empty database must return empty vec");
}

// ===========================================================================
// D.3 Insert and retrieve turns for a session
// ===========================================================================

/// **Proves:** Turns can be inserted and retrieved for a session.
#[test]
fn insert_and_get_turns_for_session() {
    let conn = setup_db();

    db::insert_session(&conn, &sample_session("sess_turn")).unwrap();
    db::insert_turn(&conn, &sample_turn("turn_1", "sess_turn", 1)).unwrap();
    db::insert_turn(&conn, &sample_turn("turn_2", "sess_turn", 2)).unwrap();

    let turns = db::get_turns_for_session(&conn, "sess_turn").unwrap();
    assert_eq!(turns.len(), 2, "Must return both turns");
}

/// **Proves:** Turn fields are preserved through insert/retrieve.
#[test]
fn turn_fields_preserved_through_roundtrip() {
    let conn = setup_db();

    db::insert_session(&conn, &sample_session("sess_rt")).unwrap();

    let turn = TurnRecord {
        id: "turn_rt".to_string(),
        session_id: "sess_rt".to_string(),
        sequence_num: 5,
        timestamp: "2026-03-17T12:00:00Z".to_string(),
        request_hash: "req_hash_abc".to_string(),
        response_hash: "resp_hash_def".to_string(),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some("claude-opus-4-20250514".to_string()),
        response_text: None,
        thinking_text: None,
        stop_reason: "tool_use".to_string(),
        capture_complete: true,
        input_tokens: 500,
        output_tokens: 250,
        cache_read_tokens: 100,
        cache_creation_tokens: 50,
        cost_usd: None,
        created_at: "2026-03-17T12:00:00Z".to_string(),
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

    let turns = db::get_turns_for_session(&conn, "sess_rt").unwrap();
    assert_eq!(turns.len(), 1);
    let t = &turns[0];

    assert_eq!(t.id, "turn_rt");
    assert_eq!(t.session_id, "sess_rt");
    assert_eq!(t.sequence_num, 5);
    assert_eq!(t.request_hash, "req_hash_abc");
    assert_eq!(t.response_hash, "resp_hash_def");
    assert_eq!(t.model, Some("claude-opus-4-20250514".to_string()));
    assert_eq!(t.input_tokens, 500);
    assert_eq!(t.output_tokens, 250);
    assert_eq!(t.cache_read_tokens, 100);
    assert_eq!(t.cache_creation_tokens, 50);
    assert_eq!(t.stop_reason, "tool_use");
    assert_eq!(t.created_at, "2026-03-17T12:00:00Z");
    // NOTE #14: Assert the 9 fields not previously checked
    assert_eq!(t.timestamp, "2026-03-17T12:00:00Z");
    assert!(t.capture_complete);
    assert_eq!(t.response_text, None);
    assert_eq!(t.thinking_text, None);
    assert_eq!(t.req_bytes_ref, None);
    assert_eq!(t.resp_bytes_ref, None);
    assert_eq!(t.req_bytes_size, None);
    assert_eq!(t.resp_bytes_size, None);
    assert_eq!(t.cost_usd, None);
}

// ===========================================================================
// D.4 Insert and retrieve tool_calls for a turn
// ===========================================================================

/// **Proves:** Tool calls can be inserted and retrieved for a turn.
#[test]
fn insert_and_get_tool_calls_for_turn() {
    let conn = setup_db();

    db::insert_session(&conn, &sample_session("sess_tc")).unwrap();
    db::insert_turn(&conn, &sample_turn("turn_tc", "sess_tc", 1)).unwrap();

    let tc1 = ToolCallRecord {
        id: "tc_1".to_string(),
        turn_id: "turn_tc".to_string(),
        tool_name: "read_file".to_string(),
        tool_input: r#"{"path":"a.rs"}"#.to_string(),
        input_hash: None,
        sequence_num: None,
        output: None,
        output_hash: None,
        duration_ms: None,
        error: None,
        status: None,
        artifacts_created: None,
        artifact_hashes: None,
    };
    let tc2 = ToolCallRecord {
        id: "tc_2".to_string(),
        turn_id: "turn_tc".to_string(),
        tool_name: "write_file".to_string(),
        tool_input: r#"{"path":"b.rs","content":"hello"}"#.to_string(),
        input_hash: None,
        sequence_num: None,
        output: None,
        output_hash: None,
        duration_ms: None,
        error: None,
        status: None,
        artifacts_created: None,
        artifact_hashes: None,
    };

    db::insert_tool_call(&conn, &tc1).unwrap();
    db::insert_tool_call(&conn, &tc2).unwrap();

    let tool_calls = db::get_tool_calls_for_turn(&conn, "turn_tc").unwrap();
    assert_eq!(tool_calls.len(), 2, "Must return both tool calls");

    let names: Vec<&str> = tool_calls.iter().map(|tc| tc.tool_name.as_str()).collect();
    assert!(names.contains(&"read_file"));
    assert!(names.contains(&"write_file"));
}

/// **Proves:** Tool call fields are preserved through roundtrip.
#[test]
fn tool_call_fields_preserved_through_roundtrip() {
    let conn = setup_db();

    db::insert_session(&conn, &sample_session("sess_tcrt")).unwrap();
    db::insert_turn(&conn, &sample_turn("turn_tcrt", "sess_tcrt", 1)).unwrap();
    db::insert_tool_call(&conn, &sample_tool_call("tc_rt", "turn_tcrt")).unwrap();

    let tool_calls = db::get_tool_calls_for_turn(&conn, "turn_tcrt").unwrap();
    assert_eq!(tool_calls.len(), 1);
    let tc = &tool_calls[0];

    assert_eq!(tc.id, "tc_rt");
    assert_eq!(tc.turn_id, "turn_tcrt");
    assert_eq!(tc.tool_name, "read_file");
    assert_eq!(tc.tool_input, r#"{"path":"src/main.rs"}"#);
    // NOTE #13: Assert input_hash field
    assert_eq!(tc.input_hash, None);
}

/// **Proves:** Getting tool calls for a turn with no tool calls returns empty vec.
#[test]
fn no_tool_calls_returns_empty() {
    let conn = setup_db();

    db::insert_session(&conn, &sample_session("sess_notc")).unwrap();
    db::insert_turn(&conn, &sample_turn("turn_notc", "sess_notc", 1)).unwrap();

    let tool_calls = db::get_tool_calls_for_turn(&conn, "turn_notc").unwrap();
    assert!(
        tool_calls.is_empty(),
        "Turn with no tool calls must return empty vec"
    );
}

// ===========================================================================
// D.5 Turns are ordered by sequence_num
// ===========================================================================

/// **Proves:** get_turns_for_session returns turns ordered by sequence_num,
/// regardless of insertion order.
#[test]
fn turns_ordered_by_sequence_num() {
    let conn = setup_db();

    db::insert_session(&conn, &sample_session("sess_ord")).unwrap();

    // Insert out of order: 3, 1, 2
    db::insert_turn(&conn, &sample_turn("turn_3", "sess_ord", 3)).unwrap();
    db::insert_turn(&conn, &sample_turn("turn_1", "sess_ord", 1)).unwrap();
    db::insert_turn(&conn, &sample_turn("turn_2", "sess_ord", 2)).unwrap();

    let turns = db::get_turns_for_session(&conn, "sess_ord").unwrap();
    assert_eq!(turns.len(), 3);

    assert_eq!(
        turns[0].sequence_num, 1,
        "First turn must have sequence_num 1"
    );
    assert_eq!(
        turns[1].sequence_num, 2,
        "Second turn must have sequence_num 2"
    );
    assert_eq!(
        turns[2].sequence_num, 3,
        "Third turn must have sequence_num 3"
    );
}

// ===========================================================================
// D.6 Turn uniqueness: (session_id, sequence_num) is unique
// ===========================================================================

/// **Proves:** Inserting two turns with the same (session_id, sequence_num) fails.
#[test]
fn duplicate_session_sequence_num_fails() {
    let conn = setup_db();

    db::insert_session(&conn, &sample_session("sess_dup")).unwrap();
    db::insert_turn(&conn, &sample_turn("turn_dup1", "sess_dup", 1)).unwrap();

    // Try to insert another turn with same session_id and sequence_num but different turn id
    let duplicate = TurnRecord {
        id: "turn_dup2".to_string(),
        ..sample_turn("turn_dup2", "sess_dup", 1)
    };

    let result = db::insert_turn(&conn, &duplicate);
    assert!(
        result.is_err(),
        "Inserting duplicate (session_id, sequence_num) must fail"
    );
}

// ===========================================================================
// D.7 Cross-session isolation
// ===========================================================================

/// **Proves:** Turns from different sessions are not mixed up.
#[test]
fn turns_isolated_between_sessions() {
    let conn = setup_db();

    db::insert_session(&conn, &sample_session("sess_iso_A")).unwrap();
    db::insert_session(&conn, &sample_session("sess_iso_B")).unwrap();

    db::insert_turn(&conn, &sample_turn("turn_A1", "sess_iso_A", 1)).unwrap();
    db::insert_turn(&conn, &sample_turn("turn_A2", "sess_iso_A", 2)).unwrap();
    db::insert_turn(&conn, &sample_turn("turn_B1", "sess_iso_B", 1)).unwrap();

    let turns_a = db::get_turns_for_session(&conn, "sess_iso_A").unwrap();
    let turns_b = db::get_turns_for_session(&conn, "sess_iso_B").unwrap();

    assert_eq!(turns_a.len(), 2, "Session A must have 2 turns");
    assert_eq!(turns_b.len(), 1, "Session B must have 1 turn");

    // Verify no cross-contamination
    for t in &turns_a {
        assert_eq!(t.session_id, "sess_iso_A");
    }
    for t in &turns_b {
        assert_eq!(t.session_id, "sess_iso_B");
    }
}

/// **Proves:** Tool calls are isolated to their specific turn.
#[test]
fn tool_calls_isolated_between_turns() {
    let conn = setup_db();

    db::insert_session(&conn, &sample_session("sess_tciso")).unwrap();
    db::insert_turn(&conn, &sample_turn("turn_iso1", "sess_tciso", 1)).unwrap();
    db::insert_turn(&conn, &sample_turn("turn_iso2", "sess_tciso", 2)).unwrap();

    db::insert_tool_call(
        &conn,
        &ToolCallRecord {
            id: "tc_iso1".to_string(),
            turn_id: "turn_iso1".to_string(),
            tool_name: "bash".to_string(),
            tool_input: "{}".to_string(),
            input_hash: None,
            sequence_num: None,
            output: None,
            output_hash: None,
            duration_ms: None,
            error: None,
            status: None,
            artifacts_created: None,
            artifact_hashes: None,
        },
    )
    .unwrap();

    db::insert_tool_call(
        &conn,
        &ToolCallRecord {
            id: "tc_iso2a".to_string(),
            turn_id: "turn_iso2".to_string(),
            tool_name: "read_file".to_string(),
            tool_input: "{}".to_string(),
            input_hash: None,
            sequence_num: None,
            output: None,
            output_hash: None,
            duration_ms: None,
            error: None,
            status: None,
            artifacts_created: None,
            artifact_hashes: None,
        },
    )
    .unwrap();
    db::insert_tool_call(
        &conn,
        &ToolCallRecord {
            id: "tc_iso2b".to_string(),
            turn_id: "turn_iso2".to_string(),
            tool_name: "write_file".to_string(),
            tool_input: "{}".to_string(),
            input_hash: None,
            sequence_num: None,
            output: None,
            output_hash: None,
            duration_ms: None,
            error: None,
            status: None,
            artifacts_created: None,
            artifact_hashes: None,
        },
    )
    .unwrap();

    let tc1 = db::get_tool_calls_for_turn(&conn, "turn_iso1").unwrap();
    let tc2 = db::get_tool_calls_for_turn(&conn, "turn_iso2").unwrap();

    assert_eq!(tc1.len(), 1, "Turn 1 must have 1 tool call");
    assert_eq!(tc2.len(), 2, "Turn 2 must have 2 tool calls");

    assert_eq!(tc1[0].tool_name, "bash");
}

// ===========================================================================
// D.8 Update session last_active_at
// ===========================================================================

/// **Proves:** update_session_last_active changes the stored last_active_at value.
#[test]
fn update_session_last_active_at() {
    let conn = setup_db();

    db::insert_session(&conn, &sample_session("sess_upd")).unwrap();

    // Verify original value
    let before = db::get_session(&conn, "sess_upd").unwrap().unwrap();
    assert_eq!(before.last_active_at, "2026-03-17T10:05:00Z");

    // Update
    db::update_session_last_active(&conn, "sess_upd", "2026-03-17T11:00:00Z").unwrap();

    // Verify updated value
    let after = db::get_session(&conn, "sess_upd").unwrap().unwrap();
    assert_eq!(
        after.last_active_at, "2026-03-17T11:00:00Z",
        "last_active_at must be updated"
    );
    // Other fields unchanged
    assert_eq!(after.started_at, "2026-03-17T10:00:00Z");
    assert_eq!(after.provider, "anthropic");
}
