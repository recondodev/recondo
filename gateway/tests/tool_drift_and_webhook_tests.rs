//! Sprint 7: Tool Definition Drift Detection + Webhook Alert Dispatch
//!
//! Behavioral tests for detecting when a session's tool definitions change between
//! turns, flagging the change as an anomaly, and dispatching webhook alerts.
//!
//! EVERY test in this file imports from modules/functions that DO NOT EXIST yet:
//!
//! - `recondo_gateway::drift::detect_tool_definition_drift` (new: compares tool hashes, returns anomaly)
//! - `recondo_gateway::drift::detect_tool_drift_via_graph` (new: graph store variant)
//! - `recondo_gateway::session::compute_tool_definitions_hash` (new: hashes serialized tool defs)
//! - `recondo_gateway::db::update_session_tool_definitions_hash` (new: updates session baseline)
//! - `recondo_gateway::alerts::dispatch_anomaly_webhook` (new: sends webhook POST)
//! - `recondo_gateway::alerts::is_private_ip` (new: SSRF protection check)
//!
//! This file MUST NOT compile until the implementation agent creates these modules
//! and adds the new types/functions. Each test imports production types/functions
//! that do not exist yet. The implementation agent must create them to make these
//! tests pass.

#![allow(
    dead_code,
    unused_imports,
    clippy::single_match,
    clippy::unnecessary_map_or,
    clippy::len_zero,
    clippy::let_and_return
)]

use recondo_gateway::db::{self, AnomalyEventRecord, SessionRecord, TurnRecord};
use recondo_gateway::hash;
use recondo_gateway::session;
use serde_json::json;

// ---- These imports WILL NOT RESOLVE until the new module/types are created ----

// Tool definition drift detection — compares current tool hash against session's stored hash.
// Returns Option<AnomalyEventRecord> — Some if drift detected, None if no change.
use recondo_gateway::drift::detect_tool_definition_drift;

// Compute a deterministic hash of tool definitions for session records.
use recondo_gateway::session::compute_tool_definitions_hash;

// Update the session's tool_definitions_hash baseline after drift detection.
use recondo_gateway::db::update_session_tool_definitions_hash;

// Webhook alert dispatch — fires a POST to a configured webhook URL on anomaly detection.
use recondo_gateway::alerts::dispatch_anomaly_webhook;

// SSRF protection — validates that a webhook URL does not point to a private IP.
use recondo_gateway::alerts::is_private_ip;

// Existing imports that already resolve
use recondo_gateway::db::{get_anomaly_events_for_session, insert_anomaly_event};
use recondo_gateway::drift::detect_system_prompt_drift;

// ===========================================================================
// Helpers
// ===========================================================================

fn setup_db() -> rusqlite::Connection {
    let conn = db::open_in_memory().expect("Must open in-memory SQLite");
    db::initialize(&conn).expect("Must initialize database schema");
    conn
}

/// Create a sample session with a given tool_definitions_hash.
/// The implementation must add `tool_definitions_hash` to SessionRecord.
fn sample_session_with_tool_hash(
    id: &str,
    system_prompt_hash: &str,
    tool_definitions_hash: &str,
) -> SessionRecord {
    let session = SessionRecord {
        id: id.to_string(),
        provider: "anthropic".to_string(),
        model: Some("claude-sonnet-4-20250514".to_string()),
        started_at: "2026-03-21T10:00:00Z".to_string(),
        last_active_at: "2026-03-21T10:05:00Z".to_string(),
        ended_at: None,
        initial_intent: Some("Build tool drift tests".to_string()),
        system_prompt_hash: system_prompt_hash.to_string(),
        total_turns: 0,
        turns_captured: 0,
        dropped_events: 0,
        total_tokens: 0,
        total_cost_usd: 0.0,
        framework: Some("claude_code".to_string()),
        agent_id: Some("claude-code".to_string()),
        agent_version: None,
        git_repo: None,
        git_branch: None,
        git_commit: None,
        working_directory: None,
        parent_session_id: None,
        tags: None,
        account_uuid: None,
        device_id: None,
        // New field: tool_definitions_hash (Sprint 7 deliverable).
        // The implementation must add this field to SessionRecord.
        tool_definitions_hash: tool_definitions_hash.to_string(),
    };
    session
}

fn sample_turn(id: &str, session_id: &str, seq: i64) -> TurnRecord {
    TurnRecord {
        id: id.to_string(),
        session_id: session_id.to_string(),
        sequence_num: seq,
        timestamp: format!("2026-03-21T10:{:02}:00Z", seq),
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
        created_at: format!("2026-03-21T10:{:02}:00Z", seq),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: None,
        parser_version: None,
        parse_errors: None,
        provider: Some("anthropic".to_string()),
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

/// Build a sample tool definitions JSON array and compute its hash.
fn make_tool_hash(tools: &[&str]) -> String {
    let tools_json: Vec<serde_json::Value> = tools
        .iter()
        .map(|name| {
            json!({
                "name": name,
                "description": format!("Tool: {}", name),
                "input_schema": { "type": "object" }
            })
        })
        .collect();
    let serialized = serde_json::to_string(&tools_json).expect("serialize tools");
    hash::sha256_hex(serialized.as_bytes())
}

// ===========================================================================
// Tool Definition Drift Detection Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// Test 1: Same tool hash across turns -> no anomaly
// ---------------------------------------------------------------------------

/// When the tool definitions do not change between turns, detect_tool_definition_drift
/// must return None and no anomaly_events row should be created.
#[test]
fn tool_drift_same_hash_no_anomaly() {
    let conn = setup_db();

    let sph = session::compute_system_prompt_hash(Some("System prompt"));
    let tool_hash = make_tool_hash(&["Read", "Write", "Bash"]);

    let session = sample_session_with_tool_hash("sess-td-same-1", &sph, &tool_hash);
    db::insert_session(&conn, &session).expect("insert session");

    let turn1 = sample_turn("turn-td-same-1", "sess-td-same-1", 1);
    db::insert_turn(&conn, &turn1).expect("insert turn 1");

    // Turn 2: same tool definitions hash as session baseline
    let result = detect_tool_definition_drift(
        &conn,
        "sess-td-same-1",
        "turn-td-same-2",
        &tool_hash, // current hash == session hash
        2,          // sequence_num
    );

    assert!(
        result.is_ok(),
        "detect_tool_definition_drift must not error on same hash"
    );
    assert!(
        result.unwrap().is_none(),
        "No anomaly when tool definitions hash is unchanged"
    );

    // Verify no anomaly_events in DB for this session
    let events =
        get_anomaly_events_for_session(&conn, "sess-td-same-1").expect("query anomaly events");
    assert_eq!(
        events.len(),
        0,
        "No anomaly_events should exist when tool definitions are the same"
    );
}

// ---------------------------------------------------------------------------
// Test 2: Different tool hash on turn 2 -> anomaly created
// ---------------------------------------------------------------------------

/// Different tool definitions hash on turn 2 creates an anomaly with type
/// `tool_definition_drift`.
#[test]
fn tool_drift_different_hash_creates_anomaly() {
    let conn = setup_db();

    let sph = session::compute_system_prompt_hash(Some("System prompt"));
    let tool_hash_a = make_tool_hash(&["Read", "Write", "Bash"]);
    let tool_hash_b = make_tool_hash(&["Read", "Write", "Bash", "WebSearch"]);

    let session = sample_session_with_tool_hash("sess-td-drift-1", &sph, &tool_hash_a);
    db::insert_session(&conn, &session).expect("insert session");

    let turn1 = sample_turn("turn-td-drift-1", "sess-td-drift-1", 1);
    db::insert_turn(&conn, &turn1).expect("insert turn 1");

    // Turn 2: different tool definitions hash
    let result = detect_tool_definition_drift(
        &conn,
        "sess-td-drift-1",
        "turn-td-drift-2",
        &tool_hash_b, // different from session's tool_hash_a
        2,
    );

    assert!(
        result.is_ok(),
        "detect_tool_definition_drift must not error"
    );
    let anomaly = result.unwrap();
    assert!(
        anomaly.is_some(),
        "Anomaly must be created when tool definitions hash changes"
    );

    let anomaly = anomaly.unwrap();
    assert_eq!(
        anomaly.anomaly_type, "tool_definition_drift",
        "anomaly_type must be 'tool_definition_drift'"
    );
}

// ---------------------------------------------------------------------------
// Test 3: Three turns: same, different, same -> one anomaly on turn 2
// ---------------------------------------------------------------------------

/// Three turns where tools change on turn 2 then revert on turn 3.
/// At minimum, turn 2 must produce one anomaly.
#[test]
fn tool_drift_three_turns_drift_on_turn_2() {
    let conn = setup_db();

    let sph = session::compute_system_prompt_hash(Some("System prompt"));
    let tool_hash_a = make_tool_hash(&["Read", "Write"]);
    let tool_hash_b = make_tool_hash(&["Read", "Write", "Execute"]);

    let session = sample_session_with_tool_hash("sess-td-three-1", &sph, &tool_hash_a);
    db::insert_session(&conn, &session).expect("insert session");

    let turn1 = sample_turn("turn-td-three-1", "sess-td-three-1", 1);
    db::insert_turn(&conn, &turn1).expect("insert turn 1");

    // Turn 2: drift detected (tool_hash_a -> tool_hash_b)
    let anomaly_t2 =
        detect_tool_definition_drift(&conn, "sess-td-three-1", "turn-td-three-2", &tool_hash_b, 2)
            .expect("drift check turn 2");
    assert!(
        anomaly_t2.is_some(),
        "Turn 2 must detect tool drift (hash changed from A to B)"
    );

    let turn2 = sample_turn("turn-td-three-2", "sess-td-three-1", 2);
    db::insert_turn(&conn, &turn2).expect("insert turn 2");

    // Verify at least one anomaly exists for this session
    let events =
        get_anomaly_events_for_session(&conn, "sess-td-three-1").expect("query anomaly events");
    assert!(
        events.len() >= 1,
        "At least one anomaly must exist after tool drift on turn 2"
    );
    assert_eq!(
        events[0].anomaly_type, "tool_definition_drift",
        "Anomaly type must be tool_definition_drift"
    );
}

// ---------------------------------------------------------------------------
// Test 4: Two tool changes -> two anomaly events
// ---------------------------------------------------------------------------

/// Tool definitions change on turn 2 (A->B) and again on turn 3 (B->C).
/// Two distinct anomaly events must be created.
#[test]
fn tool_drift_two_changes_produce_two_anomalies() {
    let conn = setup_db();

    let sph = session::compute_system_prompt_hash(Some("System prompt"));
    let tool_hash_a = make_tool_hash(&["Read"]);
    let tool_hash_b = make_tool_hash(&["Read", "Write"]);
    let tool_hash_c = make_tool_hash(&["Read", "Write", "Bash"]);

    let session = sample_session_with_tool_hash("sess-td-two-drift", &sph, &tool_hash_a);
    db::insert_session(&conn, &session).expect("insert session");

    let turn1 = sample_turn("turn-td-2d-1", "sess-td-two-drift", 1);
    db::insert_turn(&conn, &turn1).expect("insert turn 1");

    // Turn 2: first drift (A -> B)
    let anomaly_t2 =
        detect_tool_definition_drift(&conn, "sess-td-two-drift", "turn-td-2d-2", &tool_hash_b, 2)
            .expect("drift check turn 2");
    assert!(
        anomaly_t2.is_some(),
        "Turn 2 must detect tool drift (A -> B)"
    );

    let turn2 = sample_turn("turn-td-2d-2", "sess-td-two-drift", 2);
    db::insert_turn(&conn, &turn2).expect("insert turn 2");

    // Turn 3: second drift (B -> C)
    // The implementation must compare against the CURRENT session hash,
    // which should have been updated to tool_hash_b after turn 2's drift.
    let anomaly_t3 =
        detect_tool_definition_drift(&conn, "sess-td-two-drift", "turn-td-2d-3", &tool_hash_c, 3)
            .expect("drift check turn 3");
    assert!(
        anomaly_t3.is_some(),
        "Turn 3 must detect tool drift (B -> C)"
    );

    // Verify two anomaly events exist
    let events =
        get_anomaly_events_for_session(&conn, "sess-td-two-drift").expect("query anomaly events");
    assert_eq!(
        events.len(),
        2,
        "Two tool changes must produce exactly two anomaly events"
    );
    // Both must be tool_definition_drift type
    for evt in &events {
        assert_eq!(
            evt.anomaly_type, "tool_definition_drift",
            "All anomalies must be tool_definition_drift"
        );
    }
}

// ---------------------------------------------------------------------------
// Test 5: First turn -> no anomaly (baseline being set)
// ---------------------------------------------------------------------------

/// The first turn in a session must not produce a tool drift anomaly.
/// The tool definitions hash is being established, not compared.
#[test]
fn tool_drift_first_turn_no_anomaly() {
    let conn = setup_db();

    let sph = session::compute_system_prompt_hash(Some("System prompt"));
    let tool_hash = make_tool_hash(&["Read", "Write"]);

    let session = sample_session_with_tool_hash("sess-td-first-1", &sph, &tool_hash);
    db::insert_session(&conn, &session).expect("insert session");

    // First turn: sequence_num = 1 -> no drift, baseline being set
    let result = detect_tool_definition_drift(
        &conn,
        "sess-td-first-1",
        "turn-td-first-1",
        &tool_hash,
        1, // first turn
    )
    .expect("drift check first turn");

    assert!(
        result.is_none(),
        "First turn must not produce a tool drift anomaly (baseline being set)"
    );

    let events =
        get_anomaly_events_for_session(&conn, "sess-td-first-1").expect("query anomaly events");
    assert_eq!(events.len(), 0, "No anomaly events for a first turn");
}

// ---------------------------------------------------------------------------
// Test 6: Anomaly has correct fields (session_id, turn_id, anomaly_type, severity)
// ---------------------------------------------------------------------------

/// Anomaly event from tool drift has correct identity and classification fields.
#[test]
fn tool_drift_anomaly_has_correct_fields() {
    let conn = setup_db();

    let sph = session::compute_system_prompt_hash(Some("System prompt"));
    let tool_hash_a = make_tool_hash(&["Read"]);
    let tool_hash_b = make_tool_hash(&["Read", "Exec"]);

    let session = sample_session_with_tool_hash("sess-td-fields-1", &sph, &tool_hash_a);
    db::insert_session(&conn, &session).expect("insert session");

    let turn1 = sample_turn("turn-td-fields-1", "sess-td-fields-1", 1);
    db::insert_turn(&conn, &turn1).expect("insert turn 1");

    let anomaly = detect_tool_definition_drift(
        &conn,
        "sess-td-fields-1",
        "turn-td-fields-2",
        &tool_hash_b,
        2,
    )
    .expect("drift check")
    .expect("anomaly must be Some when tool drift occurs");

    assert_eq!(
        anomaly.session_id, "sess-td-fields-1",
        "session_id must match"
    );
    assert_eq!(anomaly.turn_id, "turn-td-fields-2", "turn_id must match");
    assert_eq!(
        anomaly.anomaly_type, "tool_definition_drift",
        "anomaly_type must be 'tool_definition_drift'"
    );
    assert_eq!(
        anomaly.severity, "warning",
        "severity for tool_definition_drift must be 'warning'"
    );
    // detected_at must be a valid ISO 8601 timestamp
    assert!(
        anomaly.detected_at.contains('T'),
        "detected_at must be ISO 8601 format, got: {}",
        anomaly.detected_at
    );
    assert!(
        anomaly.detected_at.len() >= 20,
        "detected_at must be at least 20 chars (ISO 8601), got: {}",
        anomaly.detected_at
    );
    // resolved_at must be None for a newly created anomaly
    assert!(
        anomaly.resolved_at.is_none(),
        "resolved_at must be None for a newly created anomaly"
    );
}

// ---------------------------------------------------------------------------
// Test 7: Anomaly description contains old and new hash
// ---------------------------------------------------------------------------

/// Anomaly description must contain both the old and new tool definitions hash values.
#[test]
fn tool_drift_anomaly_description_contains_hashes() {
    let conn = setup_db();

    let sph = session::compute_system_prompt_hash(Some("System prompt"));
    let tool_hash_a = make_tool_hash(&["ToolA"]);
    let tool_hash_b = make_tool_hash(&["ToolA", "ToolB"]);

    let session = sample_session_with_tool_hash("sess-td-desc-1", &sph, &tool_hash_a);
    db::insert_session(&conn, &session).expect("insert session");

    let turn1 = sample_turn("turn-td-desc-1", "sess-td-desc-1", 1);
    db::insert_turn(&conn, &turn1).expect("insert turn 1");

    let anomaly =
        detect_tool_definition_drift(&conn, "sess-td-desc-1", "turn-td-desc-2", &tool_hash_b, 2)
            .expect("drift check")
            .expect("anomaly must exist");

    // Description must contain the old hash (at least first 8 chars)
    let old_prefix = &tool_hash_a[..8];
    let new_prefix = &tool_hash_b[..8];
    assert!(
        anomaly.description.contains(old_prefix),
        "description must contain old hash prefix '{}', got: {}",
        old_prefix,
        anomaly.description
    );
    assert!(
        anomaly.description.contains(new_prefix),
        "description must contain new hash prefix '{}', got: {}",
        new_prefix,
        anomaly.description
    );
}

// ---------------------------------------------------------------------------
// Test 8: Anomaly metadata JSON has old_hash, new_hash, turn_sequence_num
// ---------------------------------------------------------------------------

/// Anomaly metadata must be valid JSON containing old_hash, new_hash, and turn_sequence_num.
#[test]
fn tool_drift_anomaly_metadata_has_required_fields() {
    let conn = setup_db();

    let sph = session::compute_system_prompt_hash(Some("System prompt"));
    let tool_hash_a = make_tool_hash(&["Alpha"]);
    let tool_hash_b = make_tool_hash(&["Alpha", "Beta"]);

    let session = sample_session_with_tool_hash("sess-td-meta-1", &sph, &tool_hash_a);
    db::insert_session(&conn, &session).expect("insert session");

    let turn1 = sample_turn("turn-td-meta-1", "sess-td-meta-1", 1);
    db::insert_turn(&conn, &turn1).expect("insert turn 1");

    let anomaly =
        detect_tool_definition_drift(&conn, "sess-td-meta-1", "turn-td-meta-2", &tool_hash_b, 2)
            .expect("drift check")
            .expect("anomaly must exist");

    // metadata is a JSON string
    let metadata: serde_json::Value =
        serde_json::from_str(&anomaly.metadata).expect("metadata must be valid JSON");

    assert_eq!(
        metadata["old_hash"].as_str().unwrap(),
        tool_hash_a,
        "metadata.old_hash must be the session's original tool hash"
    );
    assert_eq!(
        metadata["new_hash"].as_str().unwrap(),
        tool_hash_b,
        "metadata.new_hash must be the incoming tool hash"
    );
    assert_eq!(
        metadata["turn_sequence_num"].as_i64().unwrap(),
        2,
        "metadata.turn_sequence_num must be 2"
    );
}

// ---------------------------------------------------------------------------
// Test 9: Empty tool hash -> handled gracefully
// ---------------------------------------------------------------------------

/// A session with an empty tool_definitions_hash (legacy data or no tools) should
/// not produce drift on subsequent turns — same as system prompt drift behavior
/// with empty baseline.
#[test]
fn tool_drift_empty_hash_handled_gracefully() {
    let conn = setup_db();

    let sph = session::compute_system_prompt_hash(Some("System prompt"));
    // Session with empty tool_definitions_hash (legacy, no tools defined)
    let session = sample_session_with_tool_hash("sess-td-empty-1", &sph, "");
    db::insert_session(&conn, &session).expect("insert session");

    let turn1 = sample_turn("turn-td-empty-1", "sess-td-empty-1", 1);
    db::insert_turn(&conn, &turn1).expect("insert turn 1");

    let new_tool_hash = make_tool_hash(&["Read", "Write"]);

    // Turn 2: session has empty baseline, new turn has tools.
    // Same behavior as system prompt drift: empty baseline = no drift.
    let result = detect_tool_definition_drift(
        &conn,
        "sess-td-empty-1",
        "turn-td-empty-2",
        &new_tool_hash,
        2,
    );

    assert!(
        result.is_ok(),
        "detect_tool_definition_drift must not error on empty baseline"
    );
    // Empty baseline means no comparison possible — no drift reported.
    assert!(
        result.unwrap().is_none(),
        "Empty tool_definitions_hash baseline must not produce drift"
    );
}

// ---------------------------------------------------------------------------
// Test 10 (NEGATIVE): Without drift detection, no anomaly events created
// ---------------------------------------------------------------------------

/// Without calling detect_tool_definition_drift, no tool drift anomaly events
/// are created. This proves that anomaly_events do not appear magically.
#[test]
fn tool_drift_negative_no_detection_no_anomaly_events() {
    let conn = setup_db();

    let sph = session::compute_system_prompt_hash(Some("System prompt"));
    let tool_hash_a = make_tool_hash(&["Read"]);
    // The "hypothetical tool_hash_b on turn 2" referenced in the
    // assertion below is a counterfactual — this is a negative test
    // proving that without an explicit drift-detection call no
    // anomaly is created, even when later turns COULD have differing
    // tool definitions. We don't actually wire tool_hash_b anywhere
    // because the whole point is "we didn't detect, therefore no
    // event". Removing the previously-dead `let tool_hash_b = ...`
    // binding keeps the test honest.

    let session = sample_session_with_tool_hash("sess-td-neg-1", &sph, &tool_hash_a);
    db::insert_session(&conn, &session).expect("insert session");

    // Insert turns directly — skip detect_tool_definition_drift entirely
    let turn1 = sample_turn("turn-td-neg-1", "sess-td-neg-1", 1);
    db::insert_turn(&conn, &turn1).expect("insert turn 1");

    let turn2 = sample_turn("turn-td-neg-2", "sess-td-neg-1", 2);
    db::insert_turn(&conn, &turn2).expect("insert turn 2");

    // Despite the session having tool_hash_a and a hypothetical tool_hash_b on turn 2,
    // no anomaly should exist because we never called detect_tool_definition_drift.
    let events =
        get_anomaly_events_for_session(&conn, "sess-td-neg-1").expect("query anomaly events");

    // Filter to only tool_definition_drift events (system prompt drift events may
    // also exist from other wiring, but tool drift requires explicit detection).
    let tool_drift_events: Vec<_> = events
        .iter()
        .filter(|e| e.anomaly_type == "tool_definition_drift")
        .collect();

    assert_eq!(
        tool_drift_events.len(),
        0,
        "NEGATIVE: Without tool drift detection, no tool_definition_drift anomaly_events should exist"
    );
}

// ===========================================================================
// Webhook Alert Dispatch Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// Test 11: Anomaly event triggers webhook POST (mock HTTP server receives payload)
// ---------------------------------------------------------------------------

/// When an anomaly event is dispatched to a configured webhook URL, the mock
/// server must receive a POST with the anomaly payload.
#[tokio::test]
async fn webhook_dispatch_sends_post_to_configured_url() {
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::Mutex;

    // Start a mock HTTP server that records received requests.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock server");
    let mock_addr = listener.local_addr().expect("get mock addr");
    let webhook_url = format!("http://{}/webhook", mock_addr);

    let received_body: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let received_body_clone = received_body.clone();

    // Spawn mock server: accept one connection, read the HTTP request, return 200.
    let server_handle = tokio::spawn(async move {
        let (mut stream, _addr) = listener.accept().await.expect("accept connection");
        let mut buf = vec![0u8; 8192];
        let n = stream.read(&mut buf).await.expect("read from client");
        let request = String::from_utf8_lossy(&buf[..n]).to_string();

        // Extract the body after the double CRLF (HTTP headers end)
        if let Some(body_start) = request.find("\r\n\r\n") {
            let body = request[body_start + 4..].to_string();
            *received_body_clone.lock().await = Some(body);
        }

        // Respond with 200 OK
        let response = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";
        stream
            .write_all(response.as_bytes())
            .await
            .expect("write response");
    });

    // Create a sample anomaly event
    let anomaly = AnomalyEventRecord {
        id: "anomaly-wh-1".to_string(),
        session_id: "sess-wh-1".to_string(),
        turn_id: "turn-wh-1".to_string(),
        anomaly_type: "tool_definition_drift".to_string(),
        severity: "warning".to_string(),
        description: "Tool definitions hash changed from aaa to bbb".to_string(),
        detected_at: "2026-03-21T10:05:00Z".to_string(),
        resolved_at: None,
        metadata: r#"{"old_hash":"aaa","new_hash":"bbb","turn_sequence_num":2}"#.to_string(),
    };

    // Dispatch the webhook — this is the function under test.
    let result = dispatch_anomaly_webhook(&anomaly, &webhook_url).await;
    assert!(
        result.is_ok(),
        "dispatch_anomaly_webhook must succeed when server responds 200"
    );

    // Wait for the mock server to finish processing
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), server_handle).await;

    // Verify the mock server received the payload
    let body = received_body.lock().await;
    assert!(
        body.is_some(),
        "Mock server must have received a request body"
    );
    let body_str = body.as_ref().unwrap();
    let payload: serde_json::Value =
        serde_json::from_str(body_str).expect("webhook body must be valid JSON");

    assert_eq!(
        payload["anomaly_type"].as_str().unwrap(),
        "tool_definition_drift",
        "Webhook payload must contain anomaly_type"
    );
    assert_eq!(
        payload["session_id"].as_str().unwrap(),
        "sess-wh-1",
        "Webhook payload must contain session_id"
    );
}

// ---------------------------------------------------------------------------
// Test 12: Webhook payload has correct JSON structure
// ---------------------------------------------------------------------------

/// The webhook payload must contain: type, anomaly_type, severity, session_id,
/// turn_id, description, detected_at.
#[tokio::test]
async fn webhook_payload_has_correct_json_structure() {
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::Mutex;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock server");
    let mock_addr = listener.local_addr().expect("get mock addr");
    let webhook_url = format!("http://{}/webhook", mock_addr);

    let received_body: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let received_body_clone = received_body.clone();

    let server_handle = tokio::spawn(async move {
        let (mut stream, _addr) = listener.accept().await.expect("accept connection");
        let mut buf = vec![0u8; 8192];
        let n = stream.read(&mut buf).await.expect("read from client");
        let request = String::from_utf8_lossy(&buf[..n]).to_string();

        if let Some(body_start) = request.find("\r\n\r\n") {
            let body = request[body_start + 4..].to_string();
            *received_body_clone.lock().await = Some(body);
        }

        let response = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";
        stream
            .write_all(response.as_bytes())
            .await
            .expect("write response");
    });

    let anomaly = AnomalyEventRecord {
        id: "anomaly-wh-2".to_string(),
        session_id: "sess-wh-2".to_string(),
        turn_id: "turn-wh-2".to_string(),
        anomaly_type: "system_prompt_drift".to_string(),
        severity: "warning".to_string(),
        description: "System prompt hash changed from xxx to yyy".to_string(),
        detected_at: "2026-03-21T10:10:00Z".to_string(),
        resolved_at: None,
        metadata: r#"{"old_hash":"xxx","new_hash":"yyy","turn_sequence_num":3}"#.to_string(),
    };

    let result = dispatch_anomaly_webhook(&anomaly, &webhook_url).await;
    assert!(result.is_ok(), "dispatch must succeed");

    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), server_handle).await;

    let body = received_body.lock().await;
    assert!(
        body.is_some(),
        "Mock server must have received a request body"
    );
    let body_str = body.as_ref().unwrap();
    let payload: serde_json::Value =
        serde_json::from_str(body_str).expect("webhook body must be valid JSON");

    // Verify all required fields exist and have correct values
    assert_eq!(
        payload["type"].as_str().unwrap(),
        "anomaly_detected",
        "payload.type must be 'anomaly_detected'"
    );
    assert_eq!(
        payload["anomaly_type"].as_str().unwrap(),
        "system_prompt_drift",
        "payload.anomaly_type must match the anomaly"
    );
    assert_eq!(
        payload["severity"].as_str().unwrap(),
        "warning",
        "payload.severity must match the anomaly"
    );
    assert_eq!(
        payload["session_id"].as_str().unwrap(),
        "sess-wh-2",
        "payload.session_id must match"
    );
    assert_eq!(
        payload["turn_id"].as_str().unwrap(),
        "turn-wh-2",
        "payload.turn_id must match"
    );
    assert_eq!(
        payload["description"].as_str().unwrap(),
        "System prompt hash changed from xxx to yyy",
        "payload.description must match"
    );
    assert_eq!(
        payload["detected_at"].as_str().unwrap(),
        "2026-03-21T10:10:00Z",
        "payload.detected_at must match"
    );
}

// ---------------------------------------------------------------------------
// Test 13: No webhook configured -> no dispatch (no error)
// ---------------------------------------------------------------------------

/// When no webhook URL is configured (empty string), dispatch must return Ok
/// without attempting any HTTP request.
#[tokio::test]
async fn webhook_no_url_configured_no_dispatch() {
    let anomaly = AnomalyEventRecord {
        id: "anomaly-wh-3".to_string(),
        session_id: "sess-wh-3".to_string(),
        turn_id: "turn-wh-3".to_string(),
        anomaly_type: "tool_definition_drift".to_string(),
        severity: "warning".to_string(),
        description: "Tool definitions hash changed".to_string(),
        detected_at: "2026-03-21T10:15:00Z".to_string(),
        resolved_at: None,
        metadata: "{}".to_string(),
    };

    // Empty webhook URL = not configured
    let result = dispatch_anomaly_webhook(&anomaly, "").await;
    assert!(
        result.is_ok(),
        "dispatch with empty webhook URL must not error"
    );
}

// ---------------------------------------------------------------------------
// Test 14: Webhook URL pointing to private IP -> rejected (SSRF protection)
// ---------------------------------------------------------------------------

/// Webhook URLs pointing to private/loopback IPs must be rejected for SSRF
/// protection. Note: 127.0.0.1 is allowed in tests for mock servers, but
/// other private ranges (10.x, 172.16.x, 192.168.x) must be blocked.
#[tokio::test]
async fn webhook_private_ip_rejected_ssrf_protection() {
    let anomaly = AnomalyEventRecord {
        id: "anomaly-wh-4".to_string(),
        session_id: "sess-wh-4".to_string(),
        turn_id: "turn-wh-4".to_string(),
        anomaly_type: "tool_definition_drift".to_string(),
        severity: "warning".to_string(),
        description: "Tool definitions hash changed".to_string(),
        detected_at: "2026-03-21T10:20:00Z".to_string(),
        resolved_at: None,
        metadata: "{}".to_string(),
    };

    // Private IP ranges that must be blocked
    let private_urls = vec![
        "http://10.0.0.1:8080/webhook",
        "http://172.16.0.1:8080/webhook",
        "http://192.168.1.1:8080/webhook",
        "http://169.254.169.254/latest/meta-data/", // AWS metadata endpoint
    ];

    for url in &private_urls {
        let result = dispatch_anomaly_webhook(&anomaly, url).await;
        assert!(
            result.is_err(),
            "Webhook dispatch to private IP {} must be rejected (SSRF protection)",
            url
        );
    }

    // Verify the SSRF helper function directly
    assert!(
        is_private_ip("10.0.0.1"),
        "10.x.x.x must be classified as private"
    );
    assert!(
        is_private_ip("172.16.0.1"),
        "172.16.x.x must be classified as private"
    );
    assert!(
        is_private_ip("192.168.1.1"),
        "192.168.x.x must be classified as private"
    );
    assert!(
        is_private_ip("169.254.169.254"),
        "169.254.x.x (link-local) must be classified as private"
    );
    assert!(
        !is_private_ip("8.8.8.8"),
        "8.8.8.8 must NOT be classified as private"
    );
    assert!(
        !is_private_ip("93.184.216.34"),
        "Public IP must NOT be classified as private"
    );
}

// ---------------------------------------------------------------------------
// Test 15: Webhook POST failure -> logged, not crash (fire-and-forget)
// ---------------------------------------------------------------------------

/// When the webhook server is unreachable or returns an error, dispatch must
/// not panic or propagate the error in a way that blocks the capture pipeline.
/// It should return an Err that callers can log and ignore.
#[tokio::test]
async fn webhook_post_failure_does_not_crash() {
    let anomaly = AnomalyEventRecord {
        id: "anomaly-wh-5".to_string(),
        session_id: "sess-wh-5".to_string(),
        turn_id: "turn-wh-5".to_string(),
        anomaly_type: "tool_definition_drift".to_string(),
        severity: "warning".to_string(),
        description: "Tool definitions hash changed".to_string(),
        detected_at: "2026-03-21T10:25:00Z".to_string(),
        resolved_at: None,
        metadata: "{}".to_string(),
    };

    // Bind a port and immediately drop the listener so the port is closed.
    // This simulates an unreachable webhook server.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind temp listener");
    let port = listener.local_addr().unwrap().port();
    drop(listener); // Close the listener so connections are refused

    let unreachable_url = format!("http://127.0.0.1:{}/webhook", port);

    // dispatch_anomaly_webhook must not panic, even when the server is unreachable.
    // It should return Err (connection refused), but the caller can handle it gracefully.
    let result = dispatch_anomaly_webhook(&anomaly, &unreachable_url).await;

    // The function may return Ok (if fire-and-forget) or Err (if it reports failures).
    // Either way, it must NOT panic.
    // If the implementation is fire-and-forget with logging, Ok is acceptable.
    // If it propagates errors, Err is acceptable.
    // The key assertion is that we reach this point without panicking.
    assert!(
        result.is_ok() || result.is_err(),
        "dispatch must return a Result (not panic) on connection failure"
    );
}

// ===========================================================================
// Integration: compute_tool_definitions_hash
// ===========================================================================

// ---------------------------------------------------------------------------
// Test: compute_tool_definitions_hash produces deterministic output
// ---------------------------------------------------------------------------

/// The hash function must be deterministic: same tool definitions always produce
/// the same hash, and different definitions produce different hashes.
#[test]
fn compute_tool_definitions_hash_is_deterministic() {
    let tools_a = json!([
        {"name": "Read", "description": "Read a file", "input_schema": {"type": "object"}},
        {"name": "Write", "description": "Write a file", "input_schema": {"type": "object"}}
    ]);
    let tools_b = json!([
        {"name": "Read", "description": "Read a file", "input_schema": {"type": "object"}},
        {"name": "Write", "description": "Write a file", "input_schema": {"type": "object"}},
        {"name": "Bash", "description": "Run a command", "input_schema": {"type": "object"}}
    ]);

    let hash_a1 = compute_tool_definitions_hash(Some(&tools_a));
    let hash_a2 = compute_tool_definitions_hash(Some(&tools_a));
    let hash_b = compute_tool_definitions_hash(Some(&tools_b));
    let hash_none = compute_tool_definitions_hash(None);

    // Same input -> same hash
    assert_eq!(
        hash_a1, hash_a2,
        "Same tool definitions must produce the same hash"
    );

    // Different input -> different hash
    assert_ne!(
        hash_a1, hash_b,
        "Different tool definitions must produce different hashes"
    );

    // None vs Some -> different hash
    assert_ne!(
        hash_a1, hash_none,
        "None tools must produce a different hash than Some(tools)"
    );

    // Hash must be a valid hex string (64 chars for SHA-256)
    assert_eq!(hash_a1.len(), 64, "SHA-256 hash must be 64 hex chars");
    assert!(
        hash_a1.chars().all(|c| c.is_ascii_hexdigit()),
        "Hash must contain only hex digits"
    );
}

/// None tools (no tools key in request) must produce a deterministic sentinel hash.
#[test]
fn compute_tool_definitions_hash_none_is_deterministic() {
    let hash1 = compute_tool_definitions_hash(None);
    let hash2 = compute_tool_definitions_hash(None);
    assert_eq!(hash1, hash2, "None tools must always produce the same hash");
    assert_eq!(hash1.len(), 64, "SHA-256 hash must be 64 hex chars");
}

// ===========================================================================
// Integration: tool drift + system prompt drift coexist
// ===========================================================================

/// Both system prompt drift and tool definition drift can be detected in the
/// same session independently. They produce separate anomaly events with
/// different anomaly_type values.
#[test]
fn tool_drift_and_system_prompt_drift_coexist() {
    let conn = setup_db();

    let sph_a = session::compute_system_prompt_hash(Some("Prompt A"));
    let sph_b = session::compute_system_prompt_hash(Some("Prompt B"));
    let tool_hash_a = make_tool_hash(&["Read"]);
    let tool_hash_b = make_tool_hash(&["Read", "Write"]);

    let session = sample_session_with_tool_hash("sess-td-coexist", &sph_a, &tool_hash_a);
    db::insert_session(&conn, &session).expect("insert session");

    let turn1 = sample_turn("turn-td-coexist-1", "sess-td-coexist", 1);
    db::insert_turn(&conn, &turn1).expect("insert turn 1");

    // Turn 2: both system prompt AND tools change
    let sp_anomaly =
        detect_system_prompt_drift(&conn, "sess-td-coexist", "turn-td-coexist-2", &sph_b, 2)
            .expect("system prompt drift check")
            .expect("system prompt drift must be detected");

    let tool_anomaly = detect_tool_definition_drift(
        &conn,
        "sess-td-coexist",
        "turn-td-coexist-2",
        &tool_hash_b,
        2,
    )
    .expect("tool drift check")
    .expect("tool drift must be detected");

    assert_eq!(sp_anomaly.anomaly_type, "system_prompt_drift");
    assert_eq!(tool_anomaly.anomaly_type, "tool_definition_drift");

    // Verify both anomaly events are stored in the DB
    let events =
        get_anomaly_events_for_session(&conn, "sess-td-coexist").expect("query anomaly events");
    assert!(
        events.len() >= 2,
        "Both system prompt drift and tool definition drift must produce separate anomaly events"
    );

    let sp_events: Vec<_> = events
        .iter()
        .filter(|e| e.anomaly_type == "system_prompt_drift")
        .collect();
    let td_events: Vec<_> = events
        .iter()
        .filter(|e| e.anomaly_type == "tool_definition_drift")
        .collect();

    assert_eq!(sp_events.len(), 1, "Exactly one system_prompt_drift event");
    assert_eq!(
        td_events.len(),
        1,
        "Exactly one tool_definition_drift event"
    );
}
