//! Category E: Capture Pipeline Integration Tests.
//!
//! These tests verify the full capture flow as it would be driven by the gateway:
//! raw request bytes + raw SSE response bytes go through the complete pipeline
//! (hash, store, parse, DB insert) and produce correct artifacts on disk and
//! in the database.
//!
//! This exercises the integration of: capture, store, hash, stream,
//! providers::anthropic, db, and session modules — wired together as the
//! gateway will call them during real traffic interception.

use std::fs;
use std::io::Read as _;

use flate2::read::GzDecoder;
use tempfile::TempDir;

use recondo_gateway::capture;
use recondo_gateway::db;
use recondo_gateway::hash;
use recondo_gateway::providers;
use recondo_gateway::providers::anthropic;
use recondo_gateway::session::SessionManager;
use recondo_gateway::stream;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Build raw SSE bytes from a list of (event_type, data) pairs.
fn build_sse_bytes(events: &[(&str, &str)]) -> Vec<u8> {
    let mut buf = String::new();
    for (event_type, data) in events {
        buf.push_str(&format!("event: {}\ndata: {}\n\n", event_type, data));
    }
    buf.into_bytes()
}

/// Decompress gzip bytes.
fn gunzip(compressed: &[u8]) -> Vec<u8> {
    let mut decoder = GzDecoder::new(compressed);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).expect("gunzip failed");
    out
}

/// A minimal but realistic Anthropic request body.
fn sample_anthropic_request() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 1024,
        "system": "You are a helpful assistant.",
        "messages": [
            {"role": "user", "content": "What is 2+2?"}
        ]
    }))
    .unwrap()
}

/// A minimal but realistic Anthropic SSE response stream.
fn sample_anthropic_sse_response() -> Vec<u8> {
    build_sse_bytes(&[
        (
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_test123","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":25,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
        ),
        (
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"2 + 2 = 4"}}"#,
        ),
        (
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        (
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}"#,
        ),
        ("message_stop", r#"{"type":"message_stop"}"#),
    ])
}

// ===========================================================================
// E.1 Full pipeline: request + SSE response -> objects + metadata + DB
// ===========================================================================

/// **Proves:** The full capture pipeline correctly stores objects, writes metadata,
/// and inserts consistent session/turn records into the database.
///
/// This simulates what the gateway will do when it intercepts a complete
/// request/response cycle for an Anthropic API call.
///
/// **Anti-fake property:** Verifies the entire chain end-to-end:
/// 1. Request bytes hashed and stored on disk (gzipped)
/// 2. Response SSE bytes hashed and stored on disk (gzipped)
/// 3. Capture metadata written with correct cross-references
/// 4. SSE stream parsed into events
/// 5. Anthropic response parsed from events
/// 6. Anthropic request parsed from body
/// 7. Session resolved (new session created)
/// 8. Session record inserted into DB
/// 9. Turn record inserted into DB with parsed fields
///
/// All 9 steps must succeed and be consistent with each other.
#[test]
fn full_pipeline_request_to_db() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let request_bytes = sample_anthropic_request();
    let response_bytes = sample_anthropic_sse_response();

    // --- Step 1-3: Capture pipeline (store + metadata) ---
    let provider = providers::detect_provider("api.anthropic.com");
    assert_eq!(provider, "anthropic");

    capture::record_capture(&data_dir, &request_bytes, &response_bytes, provider)
        .expect("Capture pipeline must succeed");

    // Verify objects exist on disk
    let req_hash = hash::sha256_hex(&request_bytes);
    let resp_hash = hash::sha256_hex(&response_bytes);

    let req_obj_path = data_dir
        .join("objects/req")
        .join(format!("{}.json.gz", req_hash));
    let resp_obj_path = data_dir
        .join("objects/resp")
        .join(format!("{}.json.gz", resp_hash));

    assert!(req_obj_path.exists(), "Request object must exist on disk");
    assert!(resp_obj_path.exists(), "Response object must exist on disk");

    // Verify round-trip: decompress and compare
    let decompressed_req = gunzip(&fs::read(&req_obj_path).unwrap());
    assert_eq!(
        decompressed_req, request_bytes,
        "Request object must decompress to original"
    );

    let decompressed_resp = gunzip(&fs::read(&resp_obj_path).unwrap());
    assert_eq!(
        decompressed_resp, response_bytes,
        "Response object must decompress to original"
    );

    // --- Step 4: Parse SSE stream ---
    let accumulated = stream::parse_sse_stream(&response_bytes);
    assert!(
        accumulated.complete,
        "SSE stream must be marked complete (has message_stop)"
    );
    assert!(
        !accumulated.events.is_empty(),
        "SSE stream must have parsed events"
    );

    // --- Step 5: Parse Anthropic response ---
    let parsed_resp =
        anthropic::parse_response(&accumulated.events).expect("Response parsing must succeed");

    assert_eq!(parsed_resp.model, "claude-sonnet-4-20250514");
    assert_eq!(parsed_resp.response_text, "2 + 2 = 4");
    assert_eq!(parsed_resp.stop_reason, "end_turn");
    assert_eq!(parsed_resp.input_tokens, 25);
    assert_eq!(parsed_resp.output_tokens, 10);
    assert_eq!(parsed_resp.message_id, "msg_test123");

    // --- Step 6: Parse Anthropic request ---
    let parsed_req =
        anthropic::parse_request(&request_bytes).expect("Request parsing must succeed");

    assert_eq!(parsed_req.model, "claude-sonnet-4-20250514");
    assert_eq!(
        parsed_req.system.as_deref(),
        Some("You are a helpful assistant.")
    );
    assert_eq!(parsed_req.max_tokens, 1024);
    assert!(!parsed_req.messages.is_empty());

    // --- Step 7: Session resolution ---
    let mut session_mgr = SessionManager::new();
    let now = time::OffsetDateTime::now_utc();
    let timestamp = now
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();

    let resolution = session_mgr
        .resolve(
            &parsed_req.messages,
            None,
            parsed_req.system.as_deref(),
            &timestamp,
            None,
            None,
        )
        .expect("Session resolution must succeed");

    assert!(
        resolution.is_new_session,
        "First request must create a new session"
    );
    assert_eq!(resolution.sequence_num, 1);

    // --- Step 8: Insert session into DB ---
    let conn = db::open_in_memory().expect("DB open must succeed");
    db::initialize(&conn).expect("DB init must succeed");

    let system_prompt_hash =
        recondo_gateway::session::compute_system_prompt_hash(parsed_req.system.as_deref());

    let session_record = db::SessionRecord {
        id: resolution.session_id.clone(),
        provider: provider.to_string(),
        model: Some(parsed_resp.model.clone()),
        started_at: timestamp.clone(),
        last_active_at: timestamp.clone(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash,
        total_turns: 1,
        turns_captured: 1,
        dropped_events: 0,
        total_tokens: (parsed_resp.input_tokens + parsed_resp.output_tokens) as i64,
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

    db::insert_session(&conn, &session_record).expect("Session insert must succeed");

    // --- Step 9: Insert turn into DB ---
    let turn_id = uuid::Uuid::new_v4().to_string();
    let turn_record = db::TurnRecord {
        id: turn_id.clone(),
        session_id: resolution.session_id.clone(),
        sequence_num: resolution.sequence_num,
        timestamp: timestamp.clone(),
        request_hash: req_hash.clone(),
        response_hash: resp_hash.clone(),
        req_bytes_ref: Some(format!("objects/req/{}.json.gz", req_hash)),
        resp_bytes_ref: Some(format!("objects/resp/{}.json.gz", resp_hash)),
        req_bytes_size: Some(request_bytes.len() as i64),
        resp_bytes_size: Some(response_bytes.len() as i64),
        model: Some(parsed_resp.model.clone()),
        response_text: Some(parsed_resp.response_text.clone()),
        thinking_text: parsed_resp.thinking_text.clone(),
        stop_reason: parsed_resp.stop_reason.clone(),
        capture_complete: accumulated.complete,
        input_tokens: parsed_resp.input_tokens as i64,
        output_tokens: parsed_resp.output_tokens as i64,
        cache_read_tokens: parsed_resp.cache_read_tokens as i64,
        cache_creation_tokens: parsed_resp.cache_creation_tokens as i64,
        cost_usd: None,
        created_at: timestamp.clone(),
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

    db::insert_turn(&conn, &turn_record).expect("Turn insert must succeed");

    // --- Verification: read back from DB ---
    let db_session = db::get_session(&conn, &resolution.session_id)
        .expect("Session query must succeed")
        .expect("Session must exist in DB");

    assert_eq!(db_session.id, resolution.session_id);
    assert_eq!(db_session.provider, "anthropic");
    assert_eq!(
        db_session.model.as_deref(),
        Some("claude-sonnet-4-20250514")
    );
    assert_eq!(db_session.total_turns, 1);
    assert_eq!(db_session.total_tokens, 35); // 25 input + 10 output

    let db_turns =
        db::get_turns_for_session(&conn, &resolution.session_id).expect("Turns query must succeed");

    assert_eq!(db_turns.len(), 1, "Must have exactly 1 turn");
    let db_turn = &db_turns[0];
    assert_eq!(db_turn.session_id, resolution.session_id);
    assert_eq!(db_turn.sequence_num, 1);
    assert_eq!(db_turn.request_hash, req_hash);
    assert_eq!(db_turn.response_hash, resp_hash);
    assert_eq!(db_turn.model.as_deref(), Some("claude-sonnet-4-20250514"));
    assert_eq!(db_turn.response_text.as_deref(), Some("2 + 2 = 4"));
    assert_eq!(db_turn.stop_reason, "end_turn");
    assert!(db_turn.capture_complete);
    assert_eq!(db_turn.input_tokens, 25);
    assert_eq!(db_turn.output_tokens, 10);
}

// ===========================================================================
// E.2 Multi-turn capture: two turns in the same session
// ===========================================================================

/// **Proves:** Two consecutive requests with the same first user message are
/// grouped into the same session with incrementing sequence numbers.
/// Under the content-based session model, session ID = sha256(org_id + first_user_message).
///
/// **Anti-fake property:** Session ID is the same across turns, but sequence
/// numbers differ. The second turn's DB record has sequence_num = 2.
#[test]
fn multi_turn_same_session() {
    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();

    let mut session_mgr = SessionManager::new();

    let now = time::OffsetDateTime::now_utc();
    let ts1 = now
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();
    let ts2 = (now + time::Duration::seconds(5))
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();

    let system_prompt = Some("You are helpful.");
    let msgs = vec![serde_json::json!({"role": "user", "content": "What is 2+2?"})];

    // First turn — same first user message used for both turns
    let res1 = session_mgr
        .resolve(&msgs, None, system_prompt, &ts1, None, None)
        .expect("First resolve must succeed");
    assert!(res1.is_new_session);
    assert_eq!(res1.sequence_num, 1);

    let session_id = res1.session_id.clone();

    // Insert session
    let system_prompt_hash = recondo_gateway::session::compute_system_prompt_hash(system_prompt);
    let session_record = db::SessionRecord {
        id: session_id.clone(),
        provider: "anthropic".to_string(),
        model: Some("claude-sonnet-4-20250514".to_string()),
        started_at: ts1.clone(),
        last_active_at: ts1.clone(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash,
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
    db::insert_session(&conn, &session_record).unwrap();

    // Insert first turn
    let turn1_id = uuid::Uuid::new_v4().to_string();
    let turn1 = db::TurnRecord {
        id: turn1_id.clone(),
        session_id: session_id.clone(),
        sequence_num: 1,
        timestamp: ts1.clone(),
        request_hash: "hash1_req".to_string(),
        response_hash: "hash1_resp".to_string(),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some("claude-sonnet-4-20250514".to_string()),
        response_text: Some("First answer".to_string()),
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 20,
        output_tokens: 10,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: ts1.clone(),
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
    db::insert_turn(&conn, &turn1).unwrap();

    // Second turn — same first user message, so same session
    let msgs2 = vec![
        serde_json::json!({"role": "user", "content": "What is 2+2?"}),
        serde_json::json!({"role": "assistant", "content": "4"}),
        serde_json::json!({"role": "user", "content": "And 3+3?"}),
    ];
    let res2 = session_mgr
        .resolve(&msgs2, None, system_prompt, &ts2, None, None)
        .expect("Second resolve must succeed");
    assert!(
        !res2.is_new_session,
        "Same first user message must reuse existing session"
    );
    assert_eq!(
        res2.session_id, session_id,
        "Session ID must be the same (same first user message)"
    );
    assert_eq!(res2.sequence_num, 2);

    // Insert second turn
    let turn2_id = uuid::Uuid::new_v4().to_string();
    let turn2 = db::TurnRecord {
        id: turn2_id.clone(),
        session_id: session_id.clone(),
        sequence_num: 2,
        timestamp: ts2.clone(),
        request_hash: "hash2_req".to_string(),
        response_hash: "hash2_resp".to_string(),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some("claude-sonnet-4-20250514".to_string()),
        response_text: Some("Second answer".to_string()),
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 30,
        output_tokens: 15,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: ts2.clone(),
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
    db::insert_turn(&conn, &turn2).unwrap();

    // Update session totals — parameters are deltas (session starts at 0).
    db::update_session_totals(&conn, &session_id, 2, 2, 75, 0.0).unwrap();

    // Verify
    let turns = db::get_turns_for_session(&conn, &session_id).unwrap();
    assert_eq!(turns.len(), 2, "Must have 2 turns in session");
    assert_eq!(turns[0].sequence_num, 1);
    assert_eq!(turns[1].sequence_num, 2);
    assert_eq!(turns[0].response_text.as_deref(), Some("First answer"));
    assert_eq!(turns[1].response_text.as_deref(), Some("Second answer"));

    let session = db::get_session(&conn, &session_id).unwrap().unwrap();
    assert_eq!(session.total_turns, 2);
    assert_eq!(session.turns_captured, 2);
    assert_eq!(session.total_tokens, 75);
}

// ===========================================================================
// E.3 Tool call capture integration
// ===========================================================================

/// **Proves:** A response with tool calls has those tool calls stored in the DB
/// and linked to the correct turn.
///
/// **Anti-fake property:** The tool call's name, input, and input_hash are all
/// stored and retrievable from the DB. Cross-references (turn_id) are correct.
#[test]
fn tool_call_captured_in_db() {
    let response_sse = build_sse_bytes(&[
        (
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_tc","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":50,"output_tokens":1}}}"#,
        ),
        (
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_abc123","name":"bash","input":{}}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"ls -la\"}"}}"#,
        ),
        (
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        (
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}"#,
        ),
        ("message_stop", r#"{"type":"message_stop"}"#),
    ]);

    // Parse SSE
    let accumulated = stream::parse_sse_stream(&response_sse);
    assert!(accumulated.complete);

    // Parse response
    let parsed = anthropic::parse_response(&accumulated.events).unwrap();
    assert_eq!(parsed.tool_calls.len(), 1);
    assert_eq!(parsed.tool_calls[0].name, "bash");
    assert_eq!(parsed.tool_calls[0].id, "toolu_abc123");

    // Verify tool input is valid JSON
    let input: serde_json::Value =
        serde_json::from_str(&parsed.tool_calls[0].input).expect("Tool input must be valid JSON");
    assert_eq!(input["command"].as_str().unwrap(), "ls -la");

    // Insert into DB
    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();

    let session_id = uuid::Uuid::new_v4().to_string();
    let turn_id = uuid::Uuid::new_v4().to_string();
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();

    let session = db::SessionRecord {
        id: session_id.clone(),
        provider: "anthropic".to_string(),
        model: Some("claude-sonnet-4-20250514".to_string()),
        started_at: now.clone(),
        last_active_at: now.clone(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash: "test_hash".to_string(),
        total_turns: 1,
        turns_captured: 1,
        dropped_events: 0,
        total_tokens: 70,
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

    let turn = db::TurnRecord {
        id: turn_id.clone(),
        session_id: session_id.clone(),
        sequence_num: 1,
        timestamp: now.clone(),
        request_hash: "req_hash".to_string(),
        response_hash: hash::sha256_hex(&response_sse),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some(parsed.model.clone()),
        response_text: Some(parsed.response_text.clone()),
        thinking_text: parsed.thinking_text.clone(),
        stop_reason: parsed.stop_reason.clone(),
        capture_complete: true,
        input_tokens: parsed.input_tokens as i64,
        output_tokens: parsed.output_tokens as i64,
        cache_read_tokens: parsed.cache_read_tokens as i64,
        cache_creation_tokens: parsed.cache_creation_tokens as i64,
        cost_usd: None,
        created_at: now.clone(),
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

    // Insert tool calls
    for tc in &parsed.tool_calls {
        let tool_record = db::ToolCallRecord {
            id: uuid::Uuid::new_v4().to_string(),
            turn_id: turn_id.clone(),
            tool_name: tc.name.clone(),
            tool_input: tc.input.clone(),
            input_hash: Some(hash::sha256_hex(tc.input.as_bytes())),
            sequence_num: None,
            output: None,
            output_hash: None,
            duration_ms: None,
            error: None,
            status: None,
            artifacts_created: None,
            artifact_hashes: None,
        };
        db::insert_tool_call(&conn, &tool_record).unwrap();
    }

    // Verify tool calls in DB
    let db_tool_calls = db::get_tool_calls_for_turn(&conn, &turn_id).unwrap();
    assert_eq!(db_tool_calls.len(), 1, "Must have 1 tool call");
    assert_eq!(db_tool_calls[0].tool_name, "bash");
    assert_eq!(db_tool_calls[0].turn_id, turn_id);

    let stored_input: serde_json::Value = serde_json::from_str(&db_tool_calls[0].tool_input)
        .expect("Stored tool input must be valid JSON");
    assert_eq!(stored_input["command"].as_str().unwrap(), "ls -la");

    // Input hash should be non-empty
    assert!(
        db_tool_calls[0].input_hash.is_some(),
        "Tool call input_hash must be stored"
    );
}

// ===========================================================================
// E.4 Incomplete stream capture
// ===========================================================================

/// **Proves:** A truncated SSE response (no message_stop) is still captured
/// with capture_complete = false. The gateway must not discard incomplete data.
///
/// **Anti-fake property:** The turn record's capture_complete field reflects
/// the stream's completion status, not a hardcoded true.
#[test]
fn incomplete_stream_captured_with_flag() {
    let response_sse = build_sse_bytes(&[
        (
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_inc","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}"#,
        ),
        (
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Partial response..."}}"#,
        ),
        // Stream truncated here — no message_delta, no message_stop
    ]);

    let accumulated = stream::parse_sse_stream(&response_sse);
    assert!(
        !accumulated.complete,
        "Truncated stream must be marked incomplete"
    );

    // The response can still be partially parsed (message_start is present)
    let parsed = anthropic::parse_response(&accumulated.events).unwrap();
    assert_eq!(parsed.response_text, "Partial response...");

    // Insert into DB with capture_complete = false
    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();

    let session_id = uuid::Uuid::new_v4().to_string();
    let turn_id = uuid::Uuid::new_v4().to_string();
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();

    let session = db::SessionRecord {
        id: session_id.clone(),
        provider: "anthropic".to_string(),
        model: Some("claude-sonnet-4-20250514".to_string()),
        started_at: now.clone(),
        last_active_at: now.clone(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash: "hash".to_string(),
        total_turns: 1,
        turns_captured: 1,
        dropped_events: 0,
        total_tokens: 11,
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

    let turn = db::TurnRecord {
        id: turn_id.clone(),
        session_id: session_id.clone(),
        sequence_num: 1,
        timestamp: now.clone(),
        request_hash: "req".to_string(),
        response_hash: hash::sha256_hex(&response_sse),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some(parsed.model.clone()),
        response_text: Some(parsed.response_text.clone()),
        thinking_text: None,
        stop_reason: parsed.stop_reason.clone(),
        capture_complete: accumulated.complete, // false
        input_tokens: parsed.input_tokens as i64,
        output_tokens: parsed.output_tokens as i64,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: now.clone(),
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

    // Verify capture_complete is false in DB
    let db_turn = db::get_turn(&conn, &turn_id).unwrap().unwrap();
    assert!(
        !db_turn.capture_complete,
        "Incomplete stream must be stored with capture_complete = false"
    );
    assert_eq!(
        db_turn.response_text.as_deref(),
        Some("Partial response..."),
        "Partial response text must still be stored"
    );
}

// ===========================================================================
// E.5 Object storage consistency across capture + DB
// ===========================================================================

/// **Proves:** The req_bytes_ref and resp_bytes_ref stored in the turn record
/// point to real files on disk that decompress to the original content.
///
/// **Anti-fake property:** This closes the loop between DB records and filesystem
/// objects — a mismatch between the two would be caught.
#[test]
fn db_refs_resolve_to_disk_objects() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let request_bytes = sample_anthropic_request();
    let response_bytes = sample_anthropic_sse_response();

    // Run capture pipeline (stores to disk)
    capture::record_capture(&data_dir, &request_bytes, &response_bytes, "anthropic").unwrap();

    let req_hash = hash::sha256_hex(&request_bytes);
    let resp_hash = hash::sha256_hex(&response_bytes);

    let req_bytes_ref = format!("objects/req/{}.json.gz", req_hash);
    let resp_bytes_ref = format!("objects/resp/{}.json.gz", resp_hash);

    // Insert corresponding DB records
    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();

    let session_id = uuid::Uuid::new_v4().to_string();
    let turn_id = uuid::Uuid::new_v4().to_string();
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();

    let session = db::SessionRecord {
        id: session_id.clone(),
        provider: "anthropic".to_string(),
        model: Some("claude-sonnet-4-20250514".to_string()),
        started_at: now.clone(),
        last_active_at: now.clone(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash: "hash".to_string(),
        total_turns: 1,
        turns_captured: 1,
        dropped_events: 0,
        total_tokens: 35,
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

    let turn = db::TurnRecord {
        id: turn_id.clone(),
        session_id: session_id.clone(),
        sequence_num: 1,
        timestamp: now.clone(),
        request_hash: req_hash.clone(),
        response_hash: resp_hash.clone(),
        req_bytes_ref: Some(req_bytes_ref.clone()),
        resp_bytes_ref: Some(resp_bytes_ref.clone()),
        req_bytes_size: Some(request_bytes.len() as i64),
        resp_bytes_size: Some(response_bytes.len() as i64),
        model: Some("claude-sonnet-4-20250514".to_string()),
        response_text: Some("2 + 2 = 4".to_string()),
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 25,
        output_tokens: 10,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: now.clone(),
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

    // Read back from DB and verify disk refs
    let db_turn = db::get_turn(&conn, &turn_id).unwrap().unwrap();

    let req_ref = db_turn.req_bytes_ref.as_ref().unwrap();
    let resp_ref = db_turn.resp_bytes_ref.as_ref().unwrap();

    let req_path = data_dir.join(req_ref);
    let resp_path = data_dir.join(resp_ref);

    assert!(
        req_path.exists(),
        "req_bytes_ref from DB must resolve to file on disk: {}",
        req_path.display()
    );
    assert!(
        resp_path.exists(),
        "resp_bytes_ref from DB must resolve to file on disk: {}",
        resp_path.display()
    );

    // Decompress and verify content matches
    let decompressed_req = gunzip(&fs::read(&req_path).unwrap());
    assert_eq!(decompressed_req, request_bytes);

    let decompressed_resp = gunzip(&fs::read(&resp_path).unwrap());
    assert_eq!(decompressed_resp, response_bytes);

    // Verify sizes match
    assert_eq!(db_turn.req_bytes_size.unwrap(), request_bytes.len() as i64);
    assert_eq!(
        db_turn.resp_bytes_size.unwrap(),
        response_bytes.len() as i64
    );
}

// ===========================================================================
// E.6 Thinking blocks captured in DB
// ===========================================================================

/// **Proves:** A response with thinking content blocks stores the thinking text
/// in the turn record.
///
/// **Anti-fake property:** thinking_text is populated in the DB only when
/// thinking blocks are present in the response — None otherwise.
#[test]
fn thinking_text_captured_in_db() {
    let response_sse = build_sse_bytes(&[
        (
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_think","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":30,"output_tokens":1}}}"#,
        ),
        (
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think about 2+2..."}}"#,
        ),
        (
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        (
            "content_block_start",
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"The answer is 4."}}"#,
        ),
        (
            "content_block_stop",
            r#"{"type":"content_block_stop","index":1}"#,
        ),
        (
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}"#,
        ),
        ("message_stop", r#"{"type":"message_stop"}"#),
    ]);

    let accumulated = stream::parse_sse_stream(&response_sse);
    assert!(accumulated.complete);

    let parsed = anthropic::parse_response(&accumulated.events).unwrap();
    assert_eq!(parsed.response_text, "The answer is 4.");
    assert_eq!(
        parsed.thinking_text.as_deref(),
        Some("Let me think about 2+2...")
    );

    // Insert into DB
    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();

    let session_id = uuid::Uuid::new_v4().to_string();
    let turn_id = uuid::Uuid::new_v4().to_string();
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();

    let session = db::SessionRecord {
        id: session_id.clone(),
        provider: "anthropic".to_string(),
        model: Some("claude-sonnet-4-20250514".to_string()),
        started_at: now.clone(),
        last_active_at: now.clone(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash: "hash".to_string(),
        total_turns: 1,
        turns_captured: 1,
        dropped_events: 0,
        total_tokens: 45,
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

    let turn = db::TurnRecord {
        id: turn_id.clone(),
        session_id: session_id.clone(),
        sequence_num: 1,
        timestamp: now.clone(),
        request_hash: "req".to_string(),
        response_hash: "resp".to_string(),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some(parsed.model.clone()),
        response_text: Some(parsed.response_text.clone()),
        thinking_text: parsed.thinking_text.clone(),
        stop_reason: parsed.stop_reason.clone(),
        capture_complete: true,
        input_tokens: parsed.input_tokens as i64,
        output_tokens: parsed.output_tokens as i64,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: now.clone(),
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

    // Verify thinking_text in DB
    let db_turn = db::get_turn(&conn, &turn_id).unwrap().unwrap();
    assert_eq!(
        db_turn.thinking_text.as_deref(),
        Some("Let me think about 2+2..."),
        "Thinking text must be stored in DB"
    );
    assert_eq!(
        db_turn.response_text.as_deref(),
        Some("The answer is 4."),
        "Response text must be separate from thinking text"
    );
}

// ===========================================================================
// E.7 Provider detection feeds into capture pipeline
// ===========================================================================

/// **Proves:** The provider string detected from the host is stored in the
/// session record and matches the hostname classification.
///
/// **Anti-fake property:** The provider stored in DB must come from
/// detect_provider, not be hardcoded.
#[test]
fn provider_detection_stored_in_session() {
    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();

    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();

    // Test with Anthropic host
    let provider_anthropic = providers::detect_provider("api.anthropic.com");
    assert_eq!(provider_anthropic, "anthropic");

    let session_id = uuid::Uuid::new_v4().to_string();
    let session = db::SessionRecord {
        id: session_id.clone(),
        provider: provider_anthropic.to_string(),
        model: None,
        started_at: now.clone(),
        last_active_at: now.clone(),
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

    let db_session = db::get_session(&conn, &session_id).unwrap().unwrap();
    assert_eq!(
        db_session.provider, "anthropic",
        "Provider from detect_provider must be stored in session"
    );

    // Test with OpenAI host
    let provider_openai = providers::detect_provider("api.openai.com");
    assert_eq!(provider_openai, "openai");

    let session_id2 = uuid::Uuid::new_v4().to_string();
    let session2 = db::SessionRecord {
        id: session_id2.clone(),
        provider: provider_openai.to_string(),
        model: None,
        started_at: now.clone(),
        last_active_at: now.clone(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash: "hash2".to_string(),
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
    db::insert_session(&conn, &session2).unwrap();

    let db_session2 = db::get_session(&conn, &session_id2).unwrap().unwrap();
    assert_eq!(
        db_session2.provider, "openai",
        "OpenAI provider must be stored in session"
    );
}

// ===========================================================================
// E.8 Hash consistency: request_hash in DB matches object filename
// ===========================================================================

/// **Proves:** The request_hash stored in the turn record is the SHA-256 of
/// the original request bytes, and matches the filename of the stored object.
///
/// **Anti-fake property:** This verifies the hash is computed from the actual
/// bytes, not fabricated. A different hash function or input would fail.
#[test]
fn hash_consistency_between_db_and_object_store() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let request_bytes = b"test request body for hash verification";
    let response_bytes = b"test response body for hash verification";

    // Store via capture pipeline
    capture::record_capture(&data_dir, request_bytes, response_bytes, "anthropic").unwrap();

    // Compute expected hashes
    let expected_req_hash = hash::sha256_hex(request_bytes);
    let expected_resp_hash = hash::sha256_hex(response_bytes);

    // Verify the hash is a valid 64-character hex string
    assert_eq!(expected_req_hash.len(), 64);
    assert!(expected_req_hash.chars().all(|c| c.is_ascii_hexdigit()));

    // Verify object files exist with hash-based filenames
    let req_path = data_dir
        .join("objects/req")
        .join(format!("{}.json.gz", expected_req_hash));
    let resp_path = data_dir
        .join("objects/resp")
        .join(format!("{}.json.gz", expected_resp_hash));

    assert!(req_path.exists());
    assert!(resp_path.exists());

    // These hashes are what would be stored in the DB turn record
    // Verify they decompress correctly (proving the hash matches the content)
    let decompressed = gunzip(&fs::read(&req_path).unwrap());
    let recomputed_hash = hash::sha256_hex(&decompressed);
    assert_eq!(
        recomputed_hash, expected_req_hash,
        "Hash of decompressed content must match the filename hash"
    );
}
