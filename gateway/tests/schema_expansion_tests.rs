//! Schema expansion tests — behavioral tests for the full design-spec schema.
//!
//! These tests verify that the expanded SessionRecord, TurnRecord, and ToolCallRecord
//! structs round-trip correctly through SQLite, that new query functions work, and
//! that nullable/default fields behave as expected.

use recondo_gateway::db::{self, SessionRecord, ToolCallRecord, TurnRecord};
use rusqlite::Connection;

// ---------------------------------------------------------------------------
// Helper: create an in-memory database and initialize schema
// NOTE: This setup_db helper is duplicated in db_tests.rs. This is acceptable —
// each Rust integration test file is a separate crate, so sharing test helpers
// requires a separate test-utils crate or module, which is not recondoed for
// a two-function helper.
// ---------------------------------------------------------------------------

fn setup_db() -> Connection {
    let conn = db::open_in_memory().expect("Must open in-memory SQLite with FK enforcement");
    db::initialize(&conn).expect("Must initialize database schema");
    conn
}

/// Build a full SessionRecord with all fields populated (non-None).
fn full_session(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.to_string(),
        provider: "anthropic".to_string(),
        model: Some("claude-sonnet-4-20250514".to_string()),
        started_at: "2026-03-17T10:00:00Z".to_string(),
        last_active_at: "2026-03-17T10:30:00Z".to_string(),
        ended_at: Some("2026-03-17T11:00:00Z".to_string()),
        initial_intent: Some("Refactor the auth module".to_string()),
        system_prompt_hash: "sha256_abc123".to_string(),
        total_turns: 15,
        turns_captured: 14,
        dropped_events: 1,
        total_tokens: 50000,
        total_cost_usd: 1.25,
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

/// Build a minimal SessionRecord with all optional fields set to None and counters at zero.
fn minimal_session(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.to_string(),
        provider: "openai".to_string(),
        model: None,
        started_at: "2026-03-17T09:00:00Z".to_string(),
        last_active_at: "2026-03-17T09:00:00Z".to_string(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash: "sha256_minimal".to_string(),
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

/// Build a full TurnRecord with all fields populated (non-None).
fn full_turn(id: &str, session_id: &str, seq: i64) -> TurnRecord {
    TurnRecord {
        id: id.to_string(),
        session_id: session_id.to_string(),
        sequence_num: seq,
        timestamp: format!("2026-03-17T10:{:02}:00Z", seq),
        request_hash: format!("req_hash_{}", seq),
        response_hash: format!("resp_hash_{}", seq),
        req_bytes_ref: Some(format!("objects/req/{}.json.gz", seq)),
        resp_bytes_ref: Some(format!("objects/resp/{}.json.gz", seq)),
        req_bytes_size: Some(4096),
        resp_bytes_size: Some(8192),
        model: Some("claude-sonnet-4-20250514".to_string()),
        response_text: Some("Here is the refactored code...".to_string()),
        thinking_text: Some("I need to consider the edge cases...".to_string()),
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_tokens: 200,
        cache_creation_tokens: 100,
        cost_usd: Some(0.05),
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

/// Build a minimal TurnRecord with all optional fields set to None.
fn minimal_turn(id: &str, session_id: &str, seq: i64) -> TurnRecord {
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
        model: Some("claude-opus-4-20250514".to_string()),
        response_text: None,
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 100,
        output_tokens: 50,
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

/// Insert a session and return the connection for further use.
fn setup_with_session(session: &SessionRecord) -> Connection {
    let conn = setup_db();
    db::insert_session(&conn, session).unwrap();
    conn
}

// ===========================================================================
// 1. New fields round-trip correctly through insert/retrieve
// ===========================================================================

// ---- Session new fields ----

/// Session: model field round-trips with a populated value.
#[test]
fn session_model_field_roundtrips() {
    let conn = setup_with_session(&full_session("sess_model"));

    let s = db::get_session(&conn, "sess_model").unwrap().unwrap();
    assert_eq!(
        s.model,
        Some("claude-sonnet-4-20250514".to_string()),
        "model must round-trip as Some"
    );
}

/// Session: initial_intent field round-trips with a populated value.
#[test]
fn session_initial_intent_field_roundtrips() {
    let conn = setup_with_session(&full_session("sess_intent"));

    let s = db::get_session(&conn, "sess_intent").unwrap().unwrap();
    assert_eq!(
        s.initial_intent,
        Some("Refactor the auth module".to_string()),
        "initial_intent must round-trip as Some"
    );
}

/// Session: ended_at field round-trips with a populated value.
#[test]
fn session_ended_at_field_roundtrips() {
    let conn = setup_with_session(&full_session("sess_ended"));

    let s = db::get_session(&conn, "sess_ended").unwrap().unwrap();
    assert_eq!(
        s.ended_at,
        Some("2026-03-17T11:00:00Z".to_string()),
        "ended_at must round-trip as Some"
    );
}

/// Session: total_turns, turns_captured, dropped_events round-trip.
#[test]
fn session_counter_fields_roundtrip() {
    let conn = setup_with_session(&full_session("sess_counters"));

    let s = db::get_session(&conn, "sess_counters").unwrap().unwrap();
    assert_eq!(s.total_turns, 15, "total_turns must be 15");
    assert_eq!(s.turns_captured, 14, "turns_captured must be 14");
    assert_eq!(s.dropped_events, 1, "dropped_events must be 1");
}

/// Session: total_tokens round-trips.
#[test]
fn session_total_tokens_roundtrips() {
    let conn = setup_with_session(&full_session("sess_tokens"));

    let s = db::get_session(&conn, "sess_tokens").unwrap().unwrap();
    assert_eq!(s.total_tokens, 50000, "total_tokens must be 50000");
}

/// Session: total_cost_usd round-trips.
#[test]
fn session_total_cost_usd_roundtrips() {
    let conn = setup_with_session(&full_session("sess_cost"));

    let s = db::get_session(&conn, "sess_cost").unwrap().unwrap();
    assert!(
        (s.total_cost_usd - 1.25).abs() < f64::EPSILON,
        "total_cost_usd must be 1.25, got {}",
        s.total_cost_usd
    );
}

/// Session: all new fields survive a full round-trip together.
#[test]
fn session_all_new_fields_roundtrip_together() {
    let session = full_session("sess_all_new");
    let conn = setup_with_session(&session);

    let s = db::get_session(&conn, "sess_all_new").unwrap().unwrap();
    assert_eq!(s.id, "sess_all_new");
    assert_eq!(s.provider, "anthropic");
    assert_eq!(s.model, Some("claude-sonnet-4-20250514".to_string()));
    assert_eq!(s.started_at, "2026-03-17T10:00:00Z");
    assert_eq!(s.last_active_at, "2026-03-17T10:30:00Z");
    assert_eq!(s.ended_at, Some("2026-03-17T11:00:00Z".to_string()));
    assert_eq!(
        s.initial_intent,
        Some("Refactor the auth module".to_string())
    );
    assert_eq!(s.system_prompt_hash, "sha256_abc123");
    assert_eq!(s.total_turns, 15);
    assert_eq!(s.turns_captured, 14);
    assert_eq!(s.dropped_events, 1);
    assert_eq!(s.total_tokens, 50000);
    assert!((s.total_cost_usd - 1.25).abs() < f64::EPSILON);
}

// ---- Turn new fields ----

/// Turn: response_text round-trips with a populated value.
#[test]
fn turn_response_text_roundtrips() {
    let conn = setup_with_session(&full_session("sess_rt_text"));
    db::insert_turn(&conn, &full_turn("turn_rt_text", "sess_rt_text", 1)).unwrap();

    let turns = db::get_turns_for_session(&conn, "sess_rt_text").unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(
        turns[0].response_text,
        Some("Here is the refactored code...".to_string()),
        "response_text must round-trip as Some"
    );
}

/// Turn: thinking_text round-trips with a populated value.
#[test]
fn turn_thinking_text_roundtrips() {
    let conn = setup_with_session(&full_session("sess_rt_think"));
    db::insert_turn(&conn, &full_turn("turn_rt_think", "sess_rt_think", 1)).unwrap();

    let turns = db::get_turns_for_session(&conn, "sess_rt_think").unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(
        turns[0].thinking_text,
        Some("I need to consider the edge cases...".to_string()),
        "thinking_text must round-trip as Some"
    );
}

/// Turn: req_bytes_ref and resp_bytes_ref round-trip with populated values.
#[test]
fn turn_bytes_ref_fields_roundtrip() {
    let conn = setup_with_session(&full_session("sess_rt_refs"));
    db::insert_turn(&conn, &full_turn("turn_rt_refs", "sess_rt_refs", 1)).unwrap();

    let turns = db::get_turns_for_session(&conn, "sess_rt_refs").unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(
        turns[0].req_bytes_ref,
        Some("objects/req/1.json.gz".to_string()),
        "req_bytes_ref must round-trip"
    );
    assert_eq!(
        turns[0].resp_bytes_ref,
        Some("objects/resp/1.json.gz".to_string()),
        "resp_bytes_ref must round-trip"
    );
}

/// Turn: req_bytes_size and resp_bytes_size round-trip with populated values.
#[test]
fn turn_bytes_size_fields_roundtrip() {
    let conn = setup_with_session(&full_session("sess_rt_sizes"));
    db::insert_turn(&conn, &full_turn("turn_rt_sizes", "sess_rt_sizes", 1)).unwrap();

    let turns = db::get_turns_for_session(&conn, "sess_rt_sizes").unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(
        turns[0].req_bytes_size,
        Some(4096),
        "req_bytes_size must be 4096"
    );
    assert_eq!(
        turns[0].resp_bytes_size,
        Some(8192),
        "resp_bytes_size must be 8192"
    );
}

/// Turn: capture_complete round-trips as true.
#[test]
fn turn_capture_complete_true_roundtrips() {
    let conn = setup_with_session(&full_session("sess_rt_cc_t"));
    db::insert_turn(&conn, &full_turn("turn_rt_cc_t", "sess_rt_cc_t", 1)).unwrap();

    let turns = db::get_turns_for_session(&conn, "sess_rt_cc_t").unwrap();
    assert_eq!(turns.len(), 1);
    assert!(turns[0].capture_complete, "capture_complete must be true");
}

/// Turn: capture_complete round-trips as false.
#[test]
fn turn_capture_complete_false_roundtrips() {
    let conn = setup_with_session(&full_session("sess_rt_cc_f"));
    let mut turn = full_turn("turn_rt_cc_f", "sess_rt_cc_f", 1);
    turn.capture_complete = false;
    db::insert_turn(&conn, &turn).unwrap();

    let turns = db::get_turns_for_session(&conn, "sess_rt_cc_f").unwrap();
    assert_eq!(turns.len(), 1);
    assert!(!turns[0].capture_complete, "capture_complete must be false");
}

/// Turn: cost_usd round-trips with a populated value.
#[test]
fn turn_cost_usd_roundtrips() {
    let conn = setup_with_session(&full_session("sess_rt_cost"));
    db::insert_turn(&conn, &full_turn("turn_rt_cost", "sess_rt_cost", 1)).unwrap();

    let turns = db::get_turns_for_session(&conn, "sess_rt_cost").unwrap();
    assert_eq!(turns.len(), 1);
    let cost = turns[0].cost_usd.expect("cost_usd must be Some");
    assert!(
        (cost - 0.05).abs() < f64::EPSILON,
        "cost_usd must be 0.05, got {}",
        cost
    );
}

/// Turn: timestamp field round-trips correctly.
#[test]
fn turn_timestamp_roundtrips() {
    let conn = setup_with_session(&full_session("sess_rt_ts"));
    db::insert_turn(&conn, &full_turn("turn_rt_ts", "sess_rt_ts", 1)).unwrap();

    let turns = db::get_turns_for_session(&conn, "sess_rt_ts").unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(
        turns[0].timestamp, "2026-03-17T10:01:00Z",
        "timestamp must round-trip"
    );
}

/// Turn: all new fields survive a full round-trip together.
#[test]
fn turn_all_new_fields_roundtrip_together() {
    let conn = setup_with_session(&full_session("sess_turn_all"));
    let turn = full_turn("turn_all", "sess_turn_all", 3);
    db::insert_turn(&conn, &turn).unwrap();

    let turns = db::get_turns_for_session(&conn, "sess_turn_all").unwrap();
    assert_eq!(turns.len(), 1);
    let t = &turns[0];

    assert_eq!(t.id, "turn_all");
    assert_eq!(t.session_id, "sess_turn_all");
    assert_eq!(t.sequence_num, 3);
    assert_eq!(t.timestamp, "2026-03-17T10:03:00Z");
    assert_eq!(t.request_hash, "req_hash_3");
    assert_eq!(t.response_hash, "resp_hash_3");
    assert_eq!(t.req_bytes_ref, Some("objects/req/3.json.gz".to_string()));
    assert_eq!(t.resp_bytes_ref, Some("objects/resp/3.json.gz".to_string()));
    assert_eq!(t.req_bytes_size, Some(4096));
    assert_eq!(t.resp_bytes_size, Some(8192));
    assert_eq!(t.model, Some("claude-sonnet-4-20250514".to_string()));
    assert_eq!(
        t.response_text,
        Some("Here is the refactored code...".to_string())
    );
    assert_eq!(
        t.thinking_text,
        Some("I need to consider the edge cases...".to_string())
    );
    assert_eq!(t.stop_reason, "end_turn");
    assert!(t.capture_complete);
    assert_eq!(t.input_tokens, 1000);
    assert_eq!(t.output_tokens, 500);
    assert_eq!(t.cache_read_tokens, 200);
    assert_eq!(t.cache_creation_tokens, 100);
    assert!((t.cost_usd.unwrap() - 0.05).abs() < f64::EPSILON);
    assert_eq!(t.created_at, "2026-03-17T10:03:00Z");
}

// ---- ToolCall new field ----

/// ToolCall: input_hash round-trips with a populated value.
#[test]
fn tool_call_input_hash_roundtrips() {
    let conn = setup_with_session(&full_session("sess_tc_hash"));
    db::insert_turn(&conn, &full_turn("turn_tc_hash", "sess_tc_hash", 1)).unwrap();

    let tc = ToolCallRecord {
        id: "tc_hash_1".to_string(),
        turn_id: "turn_tc_hash".to_string(),
        tool_name: "bash".to_string(),
        tool_input: r#"{"command":"ls"}"#.to_string(),
        input_hash: Some("sha256_input_abc".to_string()),
        sequence_num: None,
        output: None,
        output_hash: None,
        duration_ms: None,
        error: None,
        status: None,
        artifacts_created: None,
        artifact_hashes: None,
    };
    db::insert_tool_call(&conn, &tc).unwrap();

    let tool_calls = db::get_tool_calls_for_turn(&conn, "turn_tc_hash").unwrap();
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(
        tool_calls[0].input_hash,
        Some("sha256_input_abc".to_string()),
        "input_hash must round-trip as Some"
    );
}

/// ToolCall: input_hash round-trips as None when not set.
#[test]
fn tool_call_input_hash_none_roundtrips() {
    let conn = setup_with_session(&full_session("sess_tc_hash_n"));
    db::insert_turn(&conn, &full_turn("turn_tc_hash_n", "sess_tc_hash_n", 1)).unwrap();

    let tc = ToolCallRecord {
        id: "tc_hash_n1".to_string(),
        turn_id: "turn_tc_hash_n".to_string(),
        tool_name: "read_file".to_string(),
        tool_input: r#"{"path":"foo.rs"}"#.to_string(),
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
    db::insert_tool_call(&conn, &tc).unwrap();

    let tool_calls = db::get_tool_calls_for_turn(&conn, "turn_tc_hash_n").unwrap();
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(
        tool_calls[0].input_hash, None,
        "input_hash must round-trip as None"
    );
}

// ===========================================================================
// 2. Optional fields can be NULL
// ===========================================================================

/// Session with model=None, initial_intent=None retrieves as None.
#[test]
fn session_optional_fields_null_roundtrip() {
    let conn = setup_with_session(&minimal_session("sess_null"));

    let s = db::get_session(&conn, "sess_null").unwrap().unwrap();
    assert_eq!(s.model, None, "model must be None");
    assert_eq!(s.initial_intent, None, "initial_intent must be None");
    assert_eq!(s.ended_at, None, "ended_at must be None");
}

/// Turn with response_text=None, thinking_text=None, req_bytes_ref=None retrieves as None.
#[test]
fn turn_optional_fields_null_roundtrip() {
    let conn = setup_with_session(&minimal_session("sess_tnull"));
    db::insert_turn(&conn, &minimal_turn("turn_null", "sess_tnull", 1)).unwrap();

    let turns = db::get_turns_for_session(&conn, "sess_tnull").unwrap();
    assert_eq!(turns.len(), 1);
    let t = &turns[0];

    assert_eq!(t.response_text, None, "response_text must be None");
    assert_eq!(t.thinking_text, None, "thinking_text must be None");
    assert_eq!(t.req_bytes_ref, None, "req_bytes_ref must be None");
    assert_eq!(t.resp_bytes_ref, None, "resp_bytes_ref must be None");
    assert_eq!(t.req_bytes_size, None, "req_bytes_size must be None");
    assert_eq!(t.resp_bytes_size, None, "resp_bytes_size must be None");
    assert_eq!(t.cost_usd, None, "cost_usd must be None");
}

/// Turn with only some optional fields populated and others None.
#[test]
fn turn_mixed_optional_fields() {
    let conn = setup_with_session(&minimal_session("sess_tmixed"));
    let mut turn = minimal_turn("turn_mixed", "sess_tmixed", 1);
    turn.response_text = Some("partial response".to_string());
    // thinking_text stays None
    turn.req_bytes_ref = Some("objects/req/mixed.json.gz".to_string());
    // resp_bytes_ref stays None
    turn.cost_usd = Some(0.01);
    db::insert_turn(&conn, &turn).unwrap();

    let turns = db::get_turns_for_session(&conn, "sess_tmixed").unwrap();
    assert_eq!(turns.len(), 1);
    let t = &turns[0];

    assert_eq!(
        t.response_text,
        Some("partial response".to_string()),
        "response_text must be Some"
    );
    assert_eq!(t.thinking_text, None, "thinking_text must be None");
    assert_eq!(
        t.req_bytes_ref,
        Some("objects/req/mixed.json.gz".to_string()),
        "req_bytes_ref must be Some"
    );
    assert_eq!(t.resp_bytes_ref, None, "resp_bytes_ref must be None");
    assert!((t.cost_usd.unwrap() - 0.01).abs() < f64::EPSILON);
}

// ===========================================================================
// 3. New query functions
// ===========================================================================

// ---- get_turn ----

/// get_turn returns a turn by ID.
#[test]
fn get_turn_by_id() {
    let conn = setup_with_session(&full_session("sess_gt"));
    db::insert_turn(&conn, &full_turn("turn_gt_1", "sess_gt", 1)).unwrap();
    db::insert_turn(&conn, &full_turn("turn_gt_2", "sess_gt", 2)).unwrap();

    let turn = db::get_turn(&conn, "turn_gt_1")
        .unwrap()
        .expect("Must find turn by ID");

    assert_eq!(turn.id, "turn_gt_1");
    assert_eq!(turn.session_id, "sess_gt");
    assert_eq!(turn.sequence_num, 1);
    assert_eq!(turn.model, Some("claude-sonnet-4-20250514".to_string()));
    assert_eq!(
        turn.response_text,
        Some("Here is the refactored code...".to_string())
    );
}

/// get_turn returns None for a non-existent ID.
#[test]
fn get_turn_nonexistent_returns_none() {
    let conn = setup_db();

    let result = db::get_turn(&conn, "does_not_exist").unwrap();
    assert!(result.is_none(), "Non-existent turn ID must return None");
}

/// get_turn returns correct turn when multiple turns exist.
#[test]
fn get_turn_returns_correct_turn_among_many() {
    let conn = setup_with_session(&full_session("sess_gt_many"));
    db::insert_turn(&conn, &full_turn("turn_many_1", "sess_gt_many", 1)).unwrap();
    db::insert_turn(&conn, &full_turn("turn_many_2", "sess_gt_many", 2)).unwrap();
    db::insert_turn(&conn, &full_turn("turn_many_3", "sess_gt_many", 3)).unwrap();

    let turn = db::get_turn(&conn, "turn_many_2").unwrap().unwrap();
    assert_eq!(turn.id, "turn_many_2", "Must return the requested turn");
    assert_eq!(turn.sequence_num, 2, "Must have correct sequence_num");
}

// ---- search_turns ----

/// search_turns finds turns matching response_text.
#[test]
fn search_turns_matches_response_text() {
    let conn = setup_with_session(&full_session("sess_st_rt"));

    let mut turn1 = full_turn("turn_st_rt_1", "sess_st_rt", 1);
    turn1.response_text = Some("The function uses a HashMap for lookups.".to_string());
    db::insert_turn(&conn, &turn1).unwrap();

    let mut turn2 = full_turn("turn_st_rt_2", "sess_st_rt", 2);
    turn2.response_text = Some("I recommend using a BTreeMap instead.".to_string());
    db::insert_turn(&conn, &turn2).unwrap();

    let results = db::search_turns(&conn, "HashMap", None).unwrap();
    assert_eq!(
        results.len(),
        1,
        "Must find exactly 1 turn matching HashMap"
    );
    assert_eq!(results[0].id, "turn_st_rt_1");
}

/// search_turns finds turns matching model.
#[test]
fn search_turns_matches_model() {
    let conn = setup_with_session(&full_session("sess_st_model"));

    let mut turn1 = full_turn("turn_st_m_1", "sess_st_model", 1);
    turn1.model = Some("claude-opus-4-20250514".to_string());
    db::insert_turn(&conn, &turn1).unwrap();

    let mut turn2 = full_turn("turn_st_m_2", "sess_st_model", 2);
    turn2.model = Some("claude-sonnet-4-20250514".to_string());
    db::insert_turn(&conn, &turn2).unwrap();

    let results = db::search_turns(&conn, "opus", None).unwrap();
    assert_eq!(results.len(), 1, "Must find exactly 1 turn matching opus");
    assert_eq!(results[0].id, "turn_st_m_1");
    assert_eq!(results[0].model, Some("claude-opus-4-20250514".to_string()));
}

/// search_turns returns empty vec for no matches.
#[test]
fn search_turns_no_matches_returns_empty() {
    let conn = setup_with_session(&full_session("sess_st_none"));
    db::insert_turn(&conn, &full_turn("turn_st_none_1", "sess_st_none", 1)).unwrap();

    let results = db::search_turns(&conn, "xyzzy_nonexistent_term", None).unwrap();
    assert!(
        results.is_empty(),
        "Search with no matches must return empty vec"
    );
}

/// search_turns finds turns matching stop_reason.
#[test]
fn search_turns_matches_stop_reason() {
    let conn = setup_with_session(&full_session("sess_st_sr"));

    let mut turn1 = full_turn("turn_st_sr_1", "sess_st_sr", 1);
    turn1.stop_reason = "tool_use".to_string();
    db::insert_turn(&conn, &turn1).unwrap();

    let mut turn2 = full_turn("turn_st_sr_2", "sess_st_sr", 2);
    turn2.stop_reason = "end_turn".to_string();
    db::insert_turn(&conn, &turn2).unwrap();

    let results = db::search_turns(&conn, "tool_use", None).unwrap();
    assert_eq!(
        results.len(),
        1,
        "Must find exactly 1 turn matching tool_use stop_reason"
    );
    assert_eq!(results[0].id, "turn_st_sr_1");
}

/// search_turns can return multiple results across sessions.
#[test]
fn search_turns_returns_multiple_matches() {
    let conn = setup_db();
    db::insert_session(&conn, &full_session("sess_st_multi_a")).unwrap();
    db::insert_session(&conn, &full_session("sess_st_multi_b")).unwrap();

    let mut turn1 = full_turn("turn_multi_1", "sess_st_multi_a", 1);
    turn1.response_text = Some("Using async/await pattern".to_string());
    db::insert_turn(&conn, &turn1).unwrap();

    let mut turn2 = full_turn("turn_multi_2", "sess_st_multi_b", 1);
    turn2.response_text = Some("The async runtime handles this".to_string());
    db::insert_turn(&conn, &turn2).unwrap();

    let results = db::search_turns(&conn, "async", None).unwrap();
    assert_eq!(
        results.len(),
        2,
        "Must find 2 turns matching 'async' across sessions"
    );
    let ids: Vec<&str> = results.iter().map(|t| t.id.as_str()).collect();
    assert!(ids.contains(&"turn_multi_1"));
    assert!(ids.contains(&"turn_multi_2"));
}

// ---- update_session_totals ----

/// update_session_totals updates the aggregate fields.
#[test]
fn update_session_totals_updates_fields() {
    let conn = setup_with_session(&minimal_session("sess_ust"));

    // Verify initial state
    let before = db::get_session(&conn, "sess_ust").unwrap().unwrap();
    assert_eq!(before.total_turns, 0);
    assert_eq!(before.turns_captured, 0);
    assert_eq!(before.total_tokens, 0);
    assert!((before.total_cost_usd - 0.0).abs() < f64::EPSILON);

    // Update — parameters are deltas (added to current values).
    // Session starts at (0, 0, 0, 0.0), so deltas produce the same absolute values.
    db::update_session_totals(&conn, "sess_ust", 10, 9, 25000, 0.75).unwrap();

    // Verify updated state
    let after = db::get_session(&conn, "sess_ust").unwrap().unwrap();
    assert_eq!(after.total_turns, 10, "total_turns must be updated to 10");
    assert_eq!(
        after.turns_captured, 9,
        "turns_captured must be updated to 9"
    );
    assert_eq!(
        after.total_tokens, 25000,
        "total_tokens must be updated to 25000"
    );
    assert!(
        (after.total_cost_usd - 0.75).abs() < f64::EPSILON,
        "total_cost_usd must be updated to 0.75, got {}",
        after.total_cost_usd
    );
}

/// update_session_totals does not affect other session fields.
#[test]
fn update_session_totals_preserves_other_fields() {
    let conn = setup_with_session(&full_session("sess_ust_pres"));

    // Parameters are deltas. full_session starts at (15, 14, 50000, 1.25),
    // so deltas of (84, 84, 50000, 4.25) produce the asserted absolute values.
    db::update_session_totals(&conn, "sess_ust_pres", 84, 84, 50000, 4.25).unwrap();

    let s = db::get_session(&conn, "sess_ust_pres").unwrap().unwrap();
    // Updated fields
    assert_eq!(s.total_turns, 99);
    assert_eq!(s.turns_captured, 98);
    assert_eq!(s.total_tokens, 100000);
    assert!((s.total_cost_usd - 5.50).abs() < f64::EPSILON);
    // Preserved fields
    assert_eq!(s.provider, "anthropic", "provider must be preserved");
    assert_eq!(
        s.model,
        Some("claude-sonnet-4-20250514".to_string()),
        "model must be preserved"
    );
    assert_eq!(
        s.started_at, "2026-03-17T10:00:00Z",
        "started_at must be preserved"
    );
    assert_eq!(
        s.system_prompt_hash, "sha256_abc123",
        "system_prompt_hash must be preserved"
    );
    assert_eq!(
        s.initial_intent,
        Some("Refactor the auth module".to_string()),
        "initial_intent must be preserved"
    );
    // dropped_events is NOT updated by update_session_totals
    assert_eq!(
        s.dropped_events, 1,
        "dropped_events must be preserved (not part of update_session_totals)"
    );
}

/// update_session_totals can be called multiple times.
#[test]
fn update_session_totals_idempotent_overwrite() {
    let conn = setup_with_session(&minimal_session("sess_ust_multi"));

    // Parameters are deltas. First call: (0,0,0,0) + (5,5,10000,0.25) = (5,5,10000,0.25).
    db::update_session_totals(&conn, "sess_ust_multi", 5, 5, 10000, 0.25).unwrap();
    // Second call: (5,5,10000,0.25) + (7,6,20000,0.55) = (12,11,30000,0.80).
    db::update_session_totals(&conn, "sess_ust_multi", 7, 6, 20000, 0.55).unwrap();

    let s = db::get_session(&conn, "sess_ust_multi").unwrap().unwrap();
    assert_eq!(
        s.total_turns, 12,
        "total_turns must reflect the last update"
    );
    assert_eq!(
        s.turns_captured, 11,
        "turns_captured must reflect the last update"
    );
    assert_eq!(
        s.total_tokens, 30000,
        "total_tokens must reflect the last update"
    );
    assert!(
        (s.total_cost_usd - 0.80).abs() < f64::EPSILON,
        "total_cost_usd must reflect the last update"
    );
}

// ===========================================================================
// 4. Defaults work
// ===========================================================================

/// New session with total_turns=0 round-trips correctly.
#[test]
fn session_zero_defaults_roundtrip() {
    let conn = setup_with_session(&minimal_session("sess_defaults"));

    let s = db::get_session(&conn, "sess_defaults").unwrap().unwrap();
    assert_eq!(s.total_turns, 0, "total_turns default must be 0");
    assert_eq!(s.turns_captured, 0, "turns_captured default must be 0");
    assert_eq!(s.dropped_events, 0, "dropped_events default must be 0");
    assert_eq!(s.total_tokens, 0, "total_tokens default must be 0");
    assert!(
        (s.total_cost_usd - 0.0).abs() < f64::EPSILON,
        "total_cost_usd default must be 0.0"
    );
}

/// New turn with capture_complete=true round-trips correctly.
#[test]
fn turn_capture_complete_default_true_roundtrips() {
    let conn = setup_with_session(&minimal_session("sess_cc_def"));
    let turn = minimal_turn("turn_cc_def", "sess_cc_def", 1);
    // capture_complete is set to true in minimal_turn helper
    assert!(turn.capture_complete, "Precondition: helper sets true");

    db::insert_turn(&conn, &turn).unwrap();

    let turns = db::get_turns_for_session(&conn, "sess_cc_def").unwrap();
    assert_eq!(turns.len(), 1);
    assert!(
        turns[0].capture_complete,
        "capture_complete=true must survive round-trip"
    );
}

// ===========================================================================
// 5. Negative / edge cases
// ===========================================================================

/// search_turns with empty string: documents behavior.
/// An empty search string matches all turns because LIKE '%%' matches everything.
#[test]
fn search_turns_empty_string_matches_all() {
    let conn = setup_with_session(&full_session("sess_st_empty"));
    db::insert_turn(&conn, &full_turn("turn_empty_1", "sess_st_empty", 1)).unwrap();
    db::insert_turn(&conn, &full_turn("turn_empty_2", "sess_st_empty", 2)).unwrap();

    let results = db::search_turns(&conn, "", None).unwrap();
    // With empty query, LIKE '%%' matches all non-null text columns.
    // Since our turns have model and stop_reason (non-null), this should match all.
    assert_eq!(
        results.len(),
        2,
        "Empty search string must match all turns (LIKE '%%' matches everything)"
    );
}

/// get_turn retrieves all fields correctly (mirrors get_turns_for_session fidelity).
#[test]
fn get_turn_returns_all_fields_correctly() {
    let conn = setup_with_session(&full_session("sess_gt_full"));
    let turn = full_turn("turn_gt_full", "sess_gt_full", 1);
    db::insert_turn(&conn, &turn).unwrap();

    let t = db::get_turn(&conn, "turn_gt_full")
        .unwrap()
        .expect("Must find turn");

    assert_eq!(t.id, "turn_gt_full");
    assert_eq!(t.session_id, "sess_gt_full");
    assert_eq!(t.sequence_num, 1);
    assert_eq!(t.timestamp, "2026-03-17T10:01:00Z");
    assert_eq!(t.request_hash, "req_hash_1");
    assert_eq!(t.response_hash, "resp_hash_1");
    assert_eq!(t.req_bytes_ref, Some("objects/req/1.json.gz".to_string()));
    assert_eq!(t.resp_bytes_ref, Some("objects/resp/1.json.gz".to_string()));
    assert_eq!(t.req_bytes_size, Some(4096));
    assert_eq!(t.resp_bytes_size, Some(8192));
    assert_eq!(t.model, Some("claude-sonnet-4-20250514".to_string()));
    assert_eq!(
        t.response_text,
        Some("Here is the refactored code...".to_string())
    );
    assert_eq!(
        t.thinking_text,
        Some("I need to consider the edge cases...".to_string())
    );
    assert_eq!(t.stop_reason, "end_turn");
    assert!(t.capture_complete);
    assert_eq!(t.input_tokens, 1000);
    assert_eq!(t.output_tokens, 500);
    assert_eq!(t.cache_read_tokens, 200);
    assert_eq!(t.cache_creation_tokens, 100);
    assert!((t.cost_usd.unwrap() - 0.05).abs() < f64::EPSILON);
    assert_eq!(t.created_at, "2026-03-17T10:01:00Z");
}

/// Session list_sessions returns expanded fields for all sessions.
#[test]
fn list_sessions_returns_expanded_fields() {
    let conn = setup_db();
    db::insert_session(&conn, &full_session("sess_list_1")).unwrap();
    db::insert_session(&conn, &minimal_session("sess_list_2")).unwrap();

    let sessions = db::list_sessions(&conn, None).unwrap();
    assert_eq!(sessions.len(), 2);

    let full = sessions.iter().find(|s| s.id == "sess_list_1").unwrap();
    assert_eq!(full.model, Some("claude-sonnet-4-20250514".to_string()));
    assert_eq!(full.total_turns, 15);
    assert!((full.total_cost_usd - 1.25).abs() < f64::EPSILON);

    let min = sessions.iter().find(|s| s.id == "sess_list_2").unwrap();
    assert_eq!(min.model, None);
    assert_eq!(min.total_turns, 0);
    assert!((min.total_cost_usd - 0.0).abs() < f64::EPSILON);
}

/// search_turns with NULL response_text: only matches on model or stop_reason.
#[test]
fn search_turns_null_response_text_matches_model() {
    let conn = setup_with_session(&minimal_session("sess_st_null_rt"));
    let turn = minimal_turn("turn_null_rt", "sess_st_null_rt", 1);
    // response_text is None, model is "claude-opus-4-20250514"
    db::insert_turn(&conn, &turn).unwrap();

    // Should match on model even though response_text is NULL
    let results = db::search_turns(&conn, "opus", None).unwrap();
    assert_eq!(
        results.len(),
        1,
        "Must match on model even when response_text is NULL"
    );
    assert_eq!(results[0].id, "turn_null_rt");
}

/// search_turns does not match on NULL response_text for a text search.
#[test]
fn search_turns_null_response_text_no_false_match() {
    let conn = setup_with_session(&minimal_session("sess_st_null_rt2"));
    let turn = minimal_turn("turn_null_rt2", "sess_st_null_rt2", 1);
    // response_text is None, model is "claude-opus-4-20250514", stop_reason is "end_turn"
    db::insert_turn(&conn, &turn).unwrap();

    // Search for something that only would match response_text
    let results = db::search_turns(&conn, "refactored code", None).unwrap();
    assert!(
        results.is_empty(),
        "Must not match NULL response_text for text content search"
    );
}

// ===========================================================================
// 6. LIKE escape logic tests (NOTE #1)
// ===========================================================================

/// search_turns: `%` in query matches literally, not as wildcard.
#[test]
fn search_turns_percent_matches_literally() {
    let conn = setup_with_session(&full_session("sess_like_pct"));

    let mut turn1 = full_turn("turn_like_pct_1", "sess_like_pct", 1);
    turn1.response_text = Some("100% complete".to_string());
    turn1.model = Some("model-a".to_string());
    db::insert_turn(&conn, &turn1).unwrap();

    let mut turn2 = full_turn("turn_like_pct_2", "sess_like_pct", 2);
    turn2.response_text = Some("100 percent complete".to_string());
    turn2.model = Some("model-b".to_string());
    db::insert_turn(&conn, &turn2).unwrap();

    let results = db::search_turns(&conn, "100%", None).unwrap();
    assert_eq!(
        results.len(),
        1,
        "Searching for '100%' must match only the literal '100%', not '100 percent'"
    );
    assert_eq!(results[0].id, "turn_like_pct_1");
}

/// search_turns: `_` in query matches literally, not as single-char wildcard.
#[test]
fn search_turns_underscore_matches_literally() {
    let conn = setup_with_session(&full_session("sess_like_und"));

    let mut turn1 = full_turn("turn_like_und_1", "sess_like_und", 1);
    turn1.model = Some("test_model".to_string());
    db::insert_turn(&conn, &turn1).unwrap();

    let mut turn2 = full_turn("turn_like_und_2", "sess_like_und", 2);
    turn2.model = Some("testXmodel".to_string());
    db::insert_turn(&conn, &turn2).unwrap();

    // If `_` were treated as a wildcard, it would match both "test_model" and "testXmodel".
    // With proper escaping, only the literal underscore matches.
    let results = db::search_turns(&conn, "test_model", None).unwrap();
    assert_eq!(
        results.len(),
        1,
        "Searching for 'test_model' must match only the literal underscore, not single-char wildcard"
    );
    assert_eq!(results[0].id, "turn_like_und_1");
}

/// search_turns: `\` in query matches literally, not as escape character.
#[test]
fn search_turns_backslash_matches_literally() {
    let conn = setup_with_session(&full_session("sess_like_bs"));

    let mut turn1 = full_turn("turn_like_bs_1", "sess_like_bs", 1);
    turn1.response_text = Some(r"path\to\file".to_string());
    db::insert_turn(&conn, &turn1).unwrap();

    let mut turn2 = full_turn("turn_like_bs_2", "sess_like_bs", 2);
    turn2.response_text = Some("pathXtoYfile".to_string());
    db::insert_turn(&conn, &turn2).unwrap();

    let results = db::search_turns(&conn, r"path\to", None).unwrap();
    assert_eq!(
        results.len(),
        1,
        r"Searching for 'path\to' must match only the literal backslash"
    );
    assert_eq!(results[0].id, "turn_like_bs_1");
}

// ===========================================================================
// 7. Update functions on missing sessions (NOTE #2)
// ===========================================================================

/// update_session_last_active on a non-existent session returns Err.
#[test]
fn update_session_last_active_missing_session_returns_err() {
    let conn = setup_db();

    let result =
        db::update_session_last_active(&conn, "nonexistent_session", "2026-03-17T12:00:00Z");
    assert!(
        result.is_err(),
        "update_session_last_active on non-existent session must return Err"
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("session not found"),
        "Error message must mention 'session not found', got: {}",
        err_msg
    );
}

/// update_session_totals on a non-existent session returns Err.
#[test]
fn update_session_totals_missing_session_returns_err() {
    let conn = setup_db();

    let result = db::update_session_totals(&conn, "nonexistent_session", 10, 9, 25000, 0.75);
    assert!(
        result.is_err(),
        "update_session_totals on non-existent session must return Err"
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("session not found"),
        "Error message must mention 'session not found', got: {}",
        err_msg
    );
}

// ===========================================================================
// 8. Schema version guard tests (NOTE #3)
// ===========================================================================

/// initialize() succeeds on a database with a newer schema version.
/// Data is sacred — we never fail on existing data. A newer schema just
/// means the DB was written by a newer binary. Old queries tolerate NULL
/// for columns they don't know about.
#[test]
fn initialize_accepts_newer_schema_version() {
    let conn = db::open_in_memory().expect("Must open in-memory SQLite");
    conn.execute_batch("PRAGMA user_version = 999;").unwrap();

    let result = db::initialize(&conn);
    assert!(
        result.is_ok(),
        "initialize must accept a database with a newer schema version (backward compat)"
    );
}

/// initialize() rejects a database with an outdated schema version.
/// Note: SCHEMA_VERSION is 1 during pre-production, so we can't trigger
/// the outdated path with a real version < 1 (0 means fresh DB).
/// This test will become active when SCHEMA_VERSION is bumped for release 1.0.0.
/// initialize() on an older schema runs additive migrations (CREATE TABLE
/// IF NOT EXISTS adds missing tables, existing data is preserved).
#[test]
fn initialize_migrates_older_schema_additively() {
    let conn = db::open_in_memory().expect("Must open in-memory SQLite");

    // Fresh DB (version 0) initializes tables
    let result = db::initialize(&conn);
    assert!(result.is_ok(), "Fresh DB must initialize successfully");

    // Re-initialize at same version is a no-op
    let result2 = db::initialize(&conn);
    assert!(
        result2.is_ok(),
        "Re-initialize at same version must succeed"
    );

    // Simulate an older version by rolling back user_version
    // initialize() should succeed (additive migration)
    conn.execute_batch("PRAGMA user_version = 0;").unwrap();
    let result3 = db::initialize(&conn);
    assert!(
        result3.is_ok(),
        "Initializing from older version must succeed (additive migration)"
    );
}

// ===========================================================================
// 9. Duplicate primary key test (NOTE #8)
// ===========================================================================

/// Inserting a session with a duplicate primary key returns Err.
#[test]
fn insert_duplicate_session_id_returns_err() {
    let conn = setup_db();

    let session1 = full_session("sess_dup_pk");
    db::insert_session(&conn, &session1).unwrap();

    let mut session2 = minimal_session("sess_dup_pk");
    session2.provider = "openai".to_string(); // different data, same ID
    let result = db::insert_session(&conn, &session2);
    assert!(
        result.is_err(),
        "Inserting a session with a duplicate ID must return Err"
    );
}

/// Inserting two turns with the same `id` is an idempotent no-op (Batch 11:
/// `ON CONFLICT (id) DO NOTHING`). The original row is preserved.
#[test]
fn insert_duplicate_turn_id_is_idempotent_no_op() {
    let conn = setup_db();

    db::insert_session(&conn, &full_session("sess_dup_turn_a")).unwrap();
    db::insert_session(&conn, &full_session("sess_dup_turn_b")).unwrap();

    let turn1 = full_turn("turn_same_id", "sess_dup_turn_a", 1);
    db::insert_turn(&conn, &turn1).unwrap();

    // Different session_id and sequence_num, but same turn id. After Batch
    // 11, ON CONFLICT (id) DO NOTHING absorbs the PK collision silently
    // and returns Ok. The original row stays intact (no overwrite).
    let turn2 = full_turn("turn_same_id", "sess_dup_turn_b", 2);
    db::insert_turn(&conn, &turn2).expect("idempotent retry must be Ok");

    // Verify the original row is preserved (session_id from turn1, not turn2).
    let stored_session_id: String = conn
        .query_row(
            "SELECT session_id FROM turns WHERE id = ?1",
            rusqlite::params!["turn_same_id"],
            |row| row.get(0),
        )
        .expect("read back original turn");
    assert_eq!(
        stored_session_id, "sess_dup_turn_a",
        "Original row must NOT be overwritten by the second insert"
    );
}

/// Inserting two tool_calls with the same `id` fails.
#[test]
fn insert_duplicate_tool_call_id_returns_err() {
    let conn = setup_db();

    db::insert_session(&conn, &full_session("sess_dup_tc")).unwrap();
    db::insert_turn(&conn, &full_turn("turn_dup_tc_1", "sess_dup_tc", 1)).unwrap();
    db::insert_turn(&conn, &full_turn("turn_dup_tc_2", "sess_dup_tc", 2)).unwrap();

    let tc1 = ToolCallRecord {
        id: "tc_same_id".to_string(),
        turn_id: "turn_dup_tc_1".to_string(),
        tool_name: "bash".to_string(),
        tool_input: r#"{"command":"ls"}"#.to_string(),
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

    // Different turn_id and tool_name, but same tool_call id — must fail on PK
    let tc2 = ToolCallRecord {
        id: "tc_same_id".to_string(),
        turn_id: "turn_dup_tc_2".to_string(),
        tool_name: "read_file".to_string(),
        tool_input: r#"{"path":"foo.rs"}"#.to_string(),
        input_hash: Some("sha256_xyz".to_string()),
        sequence_num: None,
        output: None,
        output_hash: None,
        duration_ms: None,
        error: None,
        status: None,
        artifacts_created: None,
        artifact_hashes: None,
    };
    let result = db::insert_tool_call(&conn, &tc2);
    assert!(
        result.is_err(),
        "Inserting a tool_call with a duplicate ID must return Err"
    );
}

// ===========================================================================
// 10. Foreign key enforcement tests (NOTE #9)
// ===========================================================================

/// Inserting a turn with a nonexistent session_id fails due to FK constraint.
#[test]
fn insert_turn_with_nonexistent_session_fails() {
    let conn = setup_db();

    let turn = full_turn("turn_orphan", "nonexistent_session", 1);
    let result = db::insert_turn(&conn, &turn);
    assert!(
        result.is_err(),
        "Inserting a turn referencing a nonexistent session must fail due to FK constraint"
    );
}

/// Inserting a tool_call with a nonexistent turn_id fails due to FK constraint.
#[test]
fn insert_tool_call_with_nonexistent_turn_fails() {
    let conn = setup_db();

    let tc = ToolCallRecord {
        id: "tc_orphan".to_string(),
        turn_id: "nonexistent_turn".to_string(),
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
    };
    let result = db::insert_tool_call(&conn, &tc);
    assert!(
        result.is_err(),
        "Inserting a tool_call referencing a nonexistent turn must fail due to FK constraint"
    );
}
