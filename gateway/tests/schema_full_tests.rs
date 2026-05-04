//! Schema full tests — behavioral tests for the expanded schema required by CLI views.
//!
//! These tests verify that:
//! 1. The expanded schema has all required columns for CLI commands
//! 2. New DB query functions (get_stats, search_turns with limit) work correctly
//! 3. All CLI-required data round-trips through the DB
//! 4. Aggregate statistics are computed correctly
//!
//! These tests are written BEFORE implementation from the design document only.

use recondo_gateway::db::{self, SessionRecord, TurnRecord};
use rusqlite::Connection;

// ---------------------------------------------------------------------------
// Helper: create an in-memory database and initialize schema
// ---------------------------------------------------------------------------

fn setup_db() -> Connection {
    let conn = db::open_in_memory().expect("Must open in-memory SQLite with FK enforcement");
    db::initialize(&conn).expect("Must initialize database schema");
    conn
}

/// Build a full SessionRecord with all fields populated for CLI display.
fn cli_session(
    id: &str,
    model: &str,
    intent: &str,
    turns: i64,
    tokens: i64,
    cost: f64,
) -> SessionRecord {
    SessionRecord {
        id: id.to_string(),
        provider: "anthropic".to_string(),
        model: Some(model.to_string()),
        started_at: "2026-03-18T09:00:00Z".to_string(),
        last_active_at: "2026-03-18T09:30:00Z".to_string(),
        ended_at: None,
        initial_intent: Some(intent.to_string()),
        system_prompt_hash: format!("sha256_{}", id),
        total_turns: turns,
        turns_captured: turns,
        dropped_events: 0,
        total_tokens: tokens,
        total_cost_usd: cost,
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

/// Build a turn with specific response_text for search testing.
fn search_turn(id: &str, session_id: &str, seq: i64, response_text: &str) -> TurnRecord {
    TurnRecord {
        id: id.to_string(),
        session_id: session_id.to_string(),
        sequence_num: seq,
        timestamp: format!("2026-03-18T09:{:02}:00Z", seq),
        request_hash: format!("req_{}", id),
        response_hash: format!("resp_{}", id),
        req_bytes_ref: Some(format!("objects/req/{}.json.gz", id)),
        resp_bytes_ref: Some(format!("objects/resp/{}.json.gz", id)),
        req_bytes_size: Some(1024),
        resp_bytes_size: Some(2048),
        model: Some("claude-sonnet-4-20250514".to_string()),
        response_text: Some(response_text.to_string()),
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 500,
        output_tokens: 200,
        cache_read_tokens: 100,
        cache_creation_tokens: 50,
        cost_usd: Some(0.03),
        created_at: format!("2026-03-18T09:{:02}:00Z", seq),
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

// ===========================================================================
// 1. Schema has all CLI-required columns for sessions
// ===========================================================================

/// **Proves:** The sessions table has all columns required by `recondo sessions` CLI view:
/// ID, model, turns, tokens, cost, started, intent.
///
/// **Anti-fake property:** Each column is individually verified to hold the exact value
/// inserted. A missing column would cause a compile error or runtime SQLite error.
#[test]
fn sessions_table_has_all_cli_required_columns() {
    let conn = setup_db();
    let session = cli_session(
        "sess_cli_cols",
        "claude-sonnet-4-20250514",
        "Fix the login bug in auth.ts",
        14,
        28403,
        0.42,
    );
    db::insert_session(&conn, &session).unwrap();

    let s = db::get_session(&conn, "sess_cli_cols").unwrap().unwrap();

    // All columns from the CLI session list view
    assert_eq!(s.id, "sess_cli_cols", "ID column required for session list");
    assert_eq!(
        s.model,
        Some("claude-sonnet-4-20250514".to_string()),
        "Model column required for session list"
    );
    assert_eq!(s.total_turns, 14, "Turns column required for session list");
    assert_eq!(
        s.total_tokens, 28403,
        "Tokens column required for session list"
    );
    assert!(
        (s.total_cost_usd - 0.42).abs() < f64::EPSILON,
        "Cost column required for session list"
    );
    assert_eq!(
        s.started_at, "2026-03-18T09:00:00Z",
        "Started column required for session list"
    );
    assert_eq!(
        s.initial_intent,
        Some("Fix the login bug in auth.ts".to_string()),
        "Intent column required for session list"
    );
}

// ===========================================================================
// 2. Schema has all CLI-required columns for session detail view
// ===========================================================================

/// **Proves:** The sessions table has columns for the session detail header:
/// provider, system_prompt_hash, turns_captured, dropped_events.
///
/// **Anti-fake property:** These columns are needed for the `recondo session <id>` header
/// display showing "14/14 captured | Dropped: 0 | Complete".
#[test]
fn session_detail_header_columns_present() {
    let conn = setup_db();
    let mut session = cli_session(
        "sess_detail",
        "claude-sonnet-4-20250514",
        "Implement webhook",
        14,
        50000,
        1.25,
    );
    session.turns_captured = 13;
    session.dropped_events = 2;
    db::insert_session(&conn, &session).unwrap();

    let s = db::get_session(&conn, "sess_detail").unwrap().unwrap();
    assert_eq!(
        s.provider, "anthropic",
        "Provider required for session detail header"
    );
    assert!(
        s.system_prompt_hash.starts_with("sha256_"),
        "System prompt hash required for session detail"
    );
    assert_eq!(
        s.total_turns, 14,
        "total_turns required for 'N/M captured' display"
    );
    assert_eq!(
        s.turns_captured, 13,
        "turns_captured required for 'N/M captured' display"
    );
    assert_eq!(
        s.dropped_events, 2,
        "dropped_events required for 'Dropped: N' display"
    );
}

// ===========================================================================
// 3. Turns table has all CLI-required columns for turn detail
// ===========================================================================

/// **Proves:** The turns table has response_text, thinking_text, req_bytes_ref,
/// resp_bytes_ref, req_bytes_size, resp_bytes_size, capture_complete, and cost_usd --
/// all columns required for `recondo turn <id>` and `recondo session <id>` views.
///
/// **Anti-fake property:** Each column is individually verified.
#[test]
fn turns_table_has_all_cli_required_columns() {
    let conn = setup_db();
    db::insert_session(
        &conn,
        &cli_session(
            "sess_turn_cols",
            "claude-sonnet-4-20250514",
            "test",
            1,
            700,
            0.03,
        ),
    )
    .unwrap();

    let turn = TurnRecord {
        id: "turn_cli_cols".to_string(),
        session_id: "sess_turn_cols".to_string(),
        sequence_num: 1,
        timestamp: "2026-03-18T09:01:00Z".to_string(),
        request_hash: "req_hash_cli".to_string(),
        response_hash: "resp_hash_cli".to_string(),
        req_bytes_ref: Some("objects/req/abc.json.gz".to_string()),
        resp_bytes_ref: Some("objects/resp/def.json.gz".to_string()),
        req_bytes_size: Some(4096),
        resp_bytes_size: Some(8192),
        model: Some("claude-sonnet-4-20250514".to_string()),
        response_text: Some("Here is the refactored code with proper error handling.".to_string()),
        thinking_text: Some("Let me analyze the current code structure...".to_string()),
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 500,
        output_tokens: 200,
        cache_read_tokens: 100,
        cache_creation_tokens: 50,
        cost_usd: Some(0.03),
        created_at: "2026-03-18T09:01:00Z".to_string(),
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

    let t = db::get_turn(&conn, "turn_cli_cols").unwrap().unwrap();

    // All columns required for `recondo turn <id>` display
    assert_eq!(
        t.response_text.as_deref(),
        Some("Here is the refactored code with proper error handling.")
    );
    assert_eq!(
        t.thinking_text.as_deref(),
        Some("Let me analyze the current code structure...")
    );
    assert_eq!(t.req_bytes_ref.as_deref(), Some("objects/req/abc.json.gz"));
    assert_eq!(
        t.resp_bytes_ref.as_deref(),
        Some("objects/resp/def.json.gz")
    );
    assert_eq!(t.req_bytes_size, Some(4096));
    assert_eq!(t.resp_bytes_size, Some(8192));
    assert!(t.capture_complete);
    assert!((t.cost_usd.unwrap() - 0.03).abs() < f64::EPSILON);
    assert_eq!(t.input_tokens, 500);
    assert_eq!(t.output_tokens, 200);
    assert_eq!(t.cache_read_tokens, 100);
    assert_eq!(t.cache_creation_tokens, 50);
    assert_eq!(t.request_hash, "req_hash_cli");
    assert_eq!(t.response_hash, "resp_hash_cli");
}

// ===========================================================================
// 4. get_stats returns correct aggregate statistics
// ===========================================================================

/// **Proves:** get_stats computes correct totals across all sessions.
/// This is the data source for `recondo stats`.
///
/// **Anti-fake property:** Totals are verified against manually computed sums.
/// A hardcoded implementation would fail if the test data changes.
#[test]
fn get_stats_returns_correct_totals() {
    let conn = setup_db();

    // Insert 3 sessions with different models and token counts
    db::insert_session(
        &conn,
        &cli_session(
            "stats_s1",
            "claude-sonnet-4-20250514",
            "Fix bug",
            5,
            10000,
            0.30,
        ),
    )
    .unwrap();
    db::insert_session(
        &conn,
        &cli_session(
            "stats_s2",
            "claude-opus-4-20250514",
            "Add feature",
            12,
            50000,
            2.50,
        ),
    )
    .unwrap();
    db::insert_session(
        &conn,
        &cli_session(
            "stats_s3",
            "claude-sonnet-4-20250514",
            "Refactor",
            3,
            5000,
            0.10,
        ),
    )
    .unwrap();

    // Insert turns for the sessions
    db::insert_turn(&conn, &search_turn("stats_t1", "stats_s1", 1, "response 1")).unwrap();
    db::insert_turn(&conn, &search_turn("stats_t2", "stats_s1", 2, "response 2")).unwrap();
    db::insert_turn(&conn, &search_turn("stats_t3", "stats_s2", 1, "response 3")).unwrap();

    let stats = db::get_stats(&conn).expect("get_stats must succeed");

    assert_eq!(stats.total_sessions, 3, "Must count 3 sessions");
    assert_eq!(stats.total_turns, 3, "Must count 3 turns in DB");
    assert_eq!(
        stats.total_tokens,
        10000 + 50000 + 5000,
        "total_tokens must sum across sessions"
    );

    // Models used should include both distinct models
    assert!(
        stats
            .models_used
            .contains(&"claude-sonnet-4-20250514".to_string()),
        "models_used must include claude-sonnet"
    );
    assert!(
        stats
            .models_used
            .contains(&"claude-opus-4-20250514".to_string()),
        "models_used must include claude-opus"
    );
    assert_eq!(
        stats.models_used.len(),
        2,
        "Must have exactly 2 distinct models"
    );
}

/// **Proves:** get_stats returns zeros/empty on an empty database.
///
/// **Anti-fake property:** Ensures the function handles the empty case gracefully.
#[test]
fn get_stats_empty_db_returns_zeros() {
    let conn = setup_db();

    let stats = db::get_stats(&conn).expect("get_stats on empty DB must succeed");

    assert_eq!(stats.total_sessions, 0);
    assert_eq!(stats.total_turns, 0);
    assert_eq!(stats.total_tokens, 0);
    assert!(stats.models_used.is_empty(), "No models used in empty DB");
}

// ===========================================================================
// 5. search_turns with limit parameter
// ===========================================================================

/// **Proves:** search_turns with a limit returns at most N results.
///
/// **Anti-fake property:** We insert more turns than the limit and verify
/// the result count equals the limit.
#[test]
fn search_turns_with_limit_caps_results() {
    let conn = setup_db();
    db::insert_session(
        &conn,
        &cli_session(
            "sess_lim",
            "claude-sonnet-4-20250514",
            "test",
            10,
            5000,
            0.10,
        ),
    )
    .unwrap();

    // Insert 5 turns all matching "async"
    for i in 1..=5 {
        let mut turn = search_turn(
            &format!("turn_lim_{}", i),
            "sess_lim",
            i,
            &format!("Using async pattern {}", i),
        );
        turn.model = Some("claude-sonnet-4-20250514".to_string());
        db::insert_turn(&conn, &turn).unwrap();
    }

    // Search with limit of 3
    let results = db::search_turns(&conn, "async", Some(3)).unwrap();
    assert_eq!(
        results.len(),
        3,
        "search_turns with limit=3 must return at most 3 results"
    );
}

/// **Proves:** search_turns with limit=None returns all results.
#[test]
fn search_turns_without_limit_returns_all() {
    let conn = setup_db();
    db::insert_session(
        &conn,
        &cli_session(
            "sess_nolim",
            "claude-sonnet-4-20250514",
            "test",
            5,
            5000,
            0.10,
        ),
    )
    .unwrap();

    for i in 1..=5 {
        db::insert_turn(
            &conn,
            &search_turn(
                &format!("turn_nolim_{}", i),
                "sess_nolim",
                i,
                &format!("async handler version {}", i),
            ),
        )
        .unwrap();
    }

    let results = db::search_turns(&conn, "async", None).unwrap();
    assert_eq!(
        results.len(),
        5,
        "search_turns without limit must return all matches"
    );
}

// ===========================================================================
// 6. list_sessions returns sessions sorted for CLI display
// ===========================================================================

/// **Proves:** list_sessions returns all sessions with the fields needed for the
/// `recondo sessions` table view.
///
/// **Anti-fake property:** We insert sessions with different model/intent values
/// and verify they are all returned with correct fields.
#[test]
fn list_sessions_returns_all_cli_fields() {
    let conn = setup_db();

    db::insert_session(
        &conn,
        &cli_session(
            "ls_s1",
            "claude-sonnet-4-20250514",
            "Fix login bug",
            14,
            28403,
            0.42,
        ),
    )
    .unwrap();
    db::insert_session(
        &conn,
        &cli_session(
            "ls_s2",
            "claude-opus-4-20250514",
            "Implement webhook",
            47,
            142891,
            8.14,
        ),
    )
    .unwrap();

    let sessions = db::list_sessions(&conn, None).unwrap();
    assert_eq!(sessions.len(), 2);

    let s1 = sessions.iter().find(|s| s.id == "ls_s1").unwrap();
    assert_eq!(s1.model.as_deref(), Some("claude-sonnet-4-20250514"));
    assert_eq!(s1.total_turns, 14);
    assert_eq!(s1.total_tokens, 28403);
    assert!((s1.total_cost_usd - 0.42).abs() < f64::EPSILON);
    assert_eq!(s1.initial_intent.as_deref(), Some("Fix login bug"));

    let s2 = sessions.iter().find(|s| s.id == "ls_s2").unwrap();
    assert_eq!(s2.model.as_deref(), Some("claude-opus-4-20250514"));
    assert_eq!(s2.total_turns, 47);
    assert_eq!(s2.total_tokens, 142891);
    assert!((s2.total_cost_usd - 8.14).abs() < f64::EPSILON);
    assert_eq!(s2.initial_intent.as_deref(), Some("Implement webhook"));
}

// ===========================================================================
// 7. Multi-session stats aggregation
// ===========================================================================

/// **Proves:** get_stats total_tokens sums from the sessions table, not individual turns.
///
/// **Anti-fake property:** Session total_tokens and per-turn tokens are set to
/// different values to verify the function reads from the correct source.
#[test]
fn get_stats_tokens_from_sessions_table() {
    let conn = setup_db();

    // Session says 10000 tokens, but individual turns have 500+200=700 each
    db::insert_session(
        &conn,
        &cli_session(
            "stats_tok_s1",
            "claude-sonnet-4-20250514",
            "test",
            2,
            10000,
            0.50,
        ),
    )
    .unwrap();

    db::insert_turn(
        &conn,
        &search_turn("stats_tok_t1", "stats_tok_s1", 1, "response"),
    )
    .unwrap();
    db::insert_turn(
        &conn,
        &search_turn("stats_tok_t2", "stats_tok_s1", 2, "response"),
    )
    .unwrap();

    let stats = db::get_stats(&conn).unwrap();

    // total_tokens should come from sessions.total_tokens (10000), not sum of turn tokens
    assert_eq!(
        stats.total_tokens, 10000,
        "total_tokens must sum from sessions table"
    );
}

// ===========================================================================
// 8. Negative tests
// ===========================================================================

/// **Proves:** get_session returns None for a non-existent session ID.
/// This is the error path for `recondo session <nonexistent-id>`.
#[test]
fn get_session_nonexistent_returns_none() {
    let conn = setup_db();

    let result = db::get_session(&conn, "does_not_exist").unwrap();
    assert!(result.is_none(), "Non-existent session ID must return None");
}

/// **Proves:** get_turn returns None for a non-existent turn ID.
/// This is the error path for `recondo turn <nonexistent-id>`.
#[test]
fn get_turn_nonexistent_returns_none() {
    let conn = setup_db();

    let result = db::get_turn(&conn, "does_not_exist").unwrap();
    assert!(result.is_none(), "Non-existent turn ID must return None");
}

/// **Proves:** get_turns_for_session returns empty vec for a session with no turns.
#[test]
fn get_turns_for_session_empty_returns_empty() {
    let conn = setup_db();
    db::insert_session(
        &conn,
        &cli_session(
            "sess_empty_turns",
            "claude-sonnet-4-20250514",
            "test",
            0,
            0,
            0.0,
        ),
    )
    .unwrap();

    let turns = db::get_turns_for_session(&conn, "sess_empty_turns").unwrap();
    assert!(
        turns.is_empty(),
        "Session with no turns must return empty vec"
    );
}

/// **Proves:** search_turns returns empty for a query that matches nothing.
#[test]
fn search_turns_no_match_returns_empty() {
    let conn = setup_db();
    db::insert_session(
        &conn,
        &cli_session(
            "sess_nomatch",
            "claude-sonnet-4-20250514",
            "test",
            1,
            700,
            0.03,
        ),
    )
    .unwrap();
    db::insert_turn(
        &conn,
        &search_turn(
            "turn_nomatch",
            "sess_nomatch",
            1,
            "This is about Rust programming",
        ),
    )
    .unwrap();

    let results = db::search_turns(&conn, "xyzzy_nonexistent_term_12345", None).unwrap();
    assert!(
        results.is_empty(),
        "Search for non-matching term must return empty"
    );
}

// ===========================================================================
// 9. Verify command data requirements
// ===========================================================================

/// **Proves:** The turn record has request_hash and response_hash fields that
/// the `recondo verify` command needs to recompute and compare SHA-256 hashes.
///
/// **Anti-fake property:** The verify command needs both hashes AND byte refs
/// to locate files on disk and compare. All four fields must be present.
#[test]
fn turn_has_verify_command_required_fields() {
    let conn = setup_db();
    db::insert_session(
        &conn,
        &cli_session(
            "sess_verify",
            "claude-sonnet-4-20250514",
            "test",
            1,
            700,
            0.03,
        ),
    )
    .unwrap();

    let turn = TurnRecord {
        id: "turn_verify".to_string(),
        session_id: "sess_verify".to_string(),
        sequence_num: 1,
        timestamp: "2026-03-18T09:01:00Z".to_string(),
        request_hash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
            .to_string(),
        response_hash: "f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5"
            .to_string(),
        req_bytes_ref: Some("objects/req/a1b2c3d4.json.gz".to_string()),
        resp_bytes_ref: Some("objects/resp/f6e5d4c3.json.gz".to_string()),
        req_bytes_size: Some(2048),
        resp_bytes_size: Some(4096),
        model: Some("claude-sonnet-4-20250514".to_string()),
        response_text: Some("test response".to_string()),
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 500,
        output_tokens: 200,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: Some(0.03),
        created_at: "2026-03-18T09:01:00Z".to_string(),
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

    let t = db::get_turn(&conn, "turn_verify").unwrap().unwrap();

    // Verify command needs these 4 fields
    assert_eq!(
        t.request_hash.len(),
        64,
        "request_hash must be 64-char hex (SHA-256)"
    );
    assert_eq!(
        t.response_hash.len(),
        64,
        "response_hash must be 64-char hex (SHA-256)"
    );
    assert!(
        t.req_bytes_ref.is_some(),
        "req_bytes_ref needed to locate file for verification"
    );
    assert!(
        t.resp_bytes_ref.is_some(),
        "resp_bytes_ref needed to locate file for verification"
    );
}

// ===========================================================================
// 10. Stats struct has required fields
// ===========================================================================

/// **Proves:** The Stats struct returned by get_stats has all fields needed
/// for `recondo stats` display: total_sessions, total_turns, total_tokens, models_used.
///
/// **Anti-fake property:** Each field is accessed and verified.
#[test]
fn stats_struct_has_all_required_fields() {
    let conn = setup_db();

    db::insert_session(
        &conn,
        &cli_session(
            "stats_fields_s1",
            "claude-sonnet-4-20250514",
            "test",
            5,
            10000,
            0.50,
        ),
    )
    .unwrap();

    let stats = db::get_stats(&conn).unwrap();

    // All fields that `recondo stats` displays
    let _: i64 = stats.total_sessions;
    let _: i64 = stats.total_turns;
    let _: i64 = stats.total_tokens;
    let _: Vec<String> = stats.models_used;

    // Verify correct values
    assert_eq!(stats.total_sessions, 1);
    assert!(stats.total_turns >= 0);
    assert_eq!(stats.total_tokens, 10000);
    assert_eq!(stats.models_used.len(), 1);
}
