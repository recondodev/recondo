//! Feature 3: messages_delta compression tests.
//!
//! These tests verify that the gateway compares the messages array from the
//! current request to the previous turn's messages, stores only the NEW
//! messages as messages_delta, and records messages_delta_count.
//!
//! Design reference: IMPLEMENTATION_ROADMAP.md Week 2 Tasks 5 (messages_delta
//! compression), SQLite schema lines 411-413.
//!
//! Key invariants:
//! - messages_delta stores ONLY new messages since the previous turn
//! - messages_delta_count is the count of new messages
//! - content_hash is ALWAYS computed from FULL raw request bytes (not delta)
//! - Full conversation is recoverable by walking the PRECEDED_BY chain
//! - First turn in a session: messages_delta == full messages array

use serde_json::json;

use recondo_gateway::providers::anthropic;

// ---------------------------------------------------------------------------
// Helper: build a request body with a specific messages array
// ---------------------------------------------------------------------------

fn request_with_messages(messages: &serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 1024,
        "system": "You are helpful.",
        "messages": messages
    }))
    .unwrap()
}

// ===========================================================================
// 3.1 First turn: delta equals the full messages array
// ===========================================================================

/// **Proves:** On the first turn of a session (no previous messages), the
/// messages_delta is the entire messages array and messages_delta_count equals
/// the total number of messages.
///
/// **Anti-fake property:** A delta function that always returns empty would fail.
/// A delta function that returns hardcoded data would fail on a different
/// messages array in test 3.2.
#[test]
fn first_turn_delta_is_full_messages() {
    let messages = json!([
        {"role": "user", "content": "What is 2+2?"}
    ]);

    let request_bytes = request_with_messages(&messages);
    let parsed = anthropic::parse_request(&request_bytes).unwrap();

    // For first turn, previous_messages is None
    let delta = anthropic::compute_messages_delta(&parsed.messages, None);

    assert_eq!(
        delta.messages_delta.len(),
        1,
        "First turn delta must contain all messages"
    );
    assert_eq!(
        delta.messages_delta_count, 1,
        "First turn delta_count must be 1"
    );

    // The delta message must match the original
    let delta_msg = &delta.messages_delta[0];
    assert_eq!(
        delta_msg["role"].as_str().unwrap(),
        "user",
        "Delta message role must be 'user'"
    );
    assert_eq!(
        delta_msg["content"].as_str().unwrap(),
        "What is 2+2?",
        "Delta message content must match original"
    );
}

// ===========================================================================
// 3.2 Second turn: delta contains only new messages
// ===========================================================================

/// **Proves:** When the second turn's messages array is a superset of the
/// first turn's, the delta contains only the NEW messages (those not present
/// in the previous turn).
///
/// **Anti-fake property:** A delta function that returns the full messages
/// array every time would fail because the delta length would be 3 instead
/// of 2.
#[test]
fn second_turn_delta_contains_only_new_messages() {
    // Turn 1: user asks a question
    let turn1_messages = json!([
        {"role": "user", "content": "What is 2+2?"}
    ]);

    // Turn 2: assistant replied, user asks follow-up (messages array is superset)
    let turn2_messages = json!([
        {"role": "user", "content": "What is 2+2?"},
        {"role": "assistant", "content": "2 + 2 = 4"},
        {"role": "user", "content": "And 3+3?"}
    ]);

    let req1 = request_with_messages(&turn1_messages);
    let req2 = request_with_messages(&turn2_messages);

    let parsed1 = anthropic::parse_request(&req1).unwrap();
    let parsed2 = anthropic::parse_request(&req2).unwrap();

    let delta = anthropic::compute_messages_delta(&parsed2.messages, Some(&parsed1.messages));

    assert_eq!(
        delta.messages_delta_count, 2,
        "Delta must contain 2 new messages (assistant reply + user follow-up)"
    );
    assert_eq!(delta.messages_delta.len(), 2);

    // First new message should be the assistant reply
    assert_eq!(
        delta.messages_delta[0]["role"].as_str().unwrap(),
        "assistant"
    );
    assert_eq!(
        delta.messages_delta[0]["content"].as_str().unwrap(),
        "2 + 2 = 4"
    );

    // Second new message should be the user follow-up
    assert_eq!(delta.messages_delta[1]["role"].as_str().unwrap(), "user");
    assert_eq!(
        delta.messages_delta[1]["content"].as_str().unwrap(),
        "And 3+3?"
    );
}

// ===========================================================================
// 3.3 No new messages: delta is empty
// ===========================================================================

/// **Proves:** If the messages array is identical to the previous turn's,
/// the delta is empty and messages_delta_count is 0.
///
/// **Anti-fake property:** A delta function that returns the full array
/// regardless would produce count > 0.
#[test]
fn identical_messages_produce_empty_delta() {
    let messages = json!([
        {"role": "user", "content": "Hello"}
    ]);

    let request_bytes = request_with_messages(&messages);
    let parsed = anthropic::parse_request(&request_bytes).unwrap();

    // Previous messages are identical
    let delta = anthropic::compute_messages_delta(&parsed.messages, Some(&parsed.messages));

    assert_eq!(
        delta.messages_delta_count, 0,
        "Identical messages must produce delta_count of 0"
    );
    assert!(
        delta.messages_delta.is_empty(),
        "Identical messages must produce empty delta"
    );
}

// ===========================================================================
// 3.4 Empty messages array
// ===========================================================================

/// **Proves:** An empty messages array (valid but unusual) produces an empty
/// delta with count 0.
///
/// **Anti-fake property:** A delta function that panics on empty input would
/// crash this test.
#[test]
fn empty_messages_array_produces_empty_delta() {
    let empty_messages: Vec<serde_json::Value> = vec![];

    let delta = anthropic::compute_messages_delta(&empty_messages, None);

    assert_eq!(
        delta.messages_delta_count, 0,
        "Empty messages must produce delta_count of 0"
    );
    assert!(delta.messages_delta.is_empty());
}

// ===========================================================================
// 3.5 messages_delta stored in DB turn record
// ===========================================================================

/// **Proves:** The messages_delta JSON and messages_delta_count values
/// are correctly stored in and retrieved from the SQLite turns table.
///
/// **Anti-fake property:** A TurnRecord without messages_delta and
/// messages_delta_count fields would fail to compile. A DB schema without
/// the corresponding columns would fail at insert time.
#[test]
fn messages_delta_stored_and_retrieved_from_db() {
    use recondo_gateway::db;

    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();

    let session = db::SessionRecord {
        id: "sess_delta".to_string(),
        provider: "anthropic".to_string(),
        model: None,
        started_at: "2026-03-17T10:00:00Z".to_string(),
        last_active_at: "2026-03-17T10:00:00Z".to_string(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash: "hash".to_string(),
        total_turns: 1,
        turns_captured: 1,
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

    let delta_json = json!([
        {"role": "assistant", "content": "4"},
        {"role": "user", "content": "And 5+5?"}
    ])
    .to_string();

    let turn = db::TurnRecord {
        id: "turn_delta".to_string(),
        session_id: "sess_delta".to_string(),
        sequence_num: 2,
        timestamp: "2026-03-17T10:01:00Z".to_string(),
        request_hash: "req_hash".to_string(),
        response_hash: "resp_hash".to_string(),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some("claude-sonnet-4-20250514".to_string()),
        response_text: None,
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: "2026-03-17T10:01:00Z".to_string(),
        messages_delta: Some(delta_json.clone()),
        messages_delta_count: Some(2),
        // forward compat fields (may be None for this test)
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

    // Retrieve and verify
    let db_turn = db::get_turn(&conn, "turn_delta").unwrap().unwrap();

    assert_eq!(
        db_turn.messages_delta.as_deref(),
        Some(delta_json.as_str()),
        "messages_delta must round-trip through DB"
    );
    assert_eq!(
        db_turn.messages_delta_count,
        Some(2),
        "messages_delta_count must round-trip through DB"
    );

    // Parse the stored JSON to verify it's valid
    let stored_delta: serde_json::Value =
        serde_json::from_str(db_turn.messages_delta.as_ref().unwrap()).unwrap();
    assert_eq!(stored_delta.as_array().unwrap().len(), 2);
}

// ===========================================================================
// 3.6 Multi-turn delta chain reconstruction
// ===========================================================================

/// **Proves:** Storing deltas for 3 consecutive turns and then concatenating
/// them in order reconstructs the full messages array of the final turn.
/// This validates the "full messages_snapshot recoverable by walking
/// PRECEDED_BY chain" invariant.
///
/// **Anti-fake property:** A delta that silently drops messages would produce
/// a shorter reconstruction than expected. A delta that duplicates messages
/// would produce a longer one.
#[test]
fn delta_chain_reconstructs_full_conversation() {
    // Turn 1: user message only
    let turn1_msgs = json!([
        {"role": "user", "content": "Hello"}
    ]);

    // Turn 2: adds assistant reply + user follow-up
    let turn2_msgs = json!([
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi there!"},
        {"role": "user", "content": "How are you?"}
    ]);

    // Turn 3: adds another assistant reply + user follow-up
    let turn3_msgs = json!([
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi there!"},
        {"role": "user", "content": "How are you?"},
        {"role": "assistant", "content": "I'm doing well."},
        {"role": "user", "content": "Great!"}
    ]);

    let req1 = request_with_messages(&turn1_msgs);
    let req2 = request_with_messages(&turn2_msgs);
    let req3 = request_with_messages(&turn3_msgs);

    let p1 = anthropic::parse_request(&req1).unwrap();
    let p2 = anthropic::parse_request(&req2).unwrap();
    let p3 = anthropic::parse_request(&req3).unwrap();

    let delta1 = anthropic::compute_messages_delta(&p1.messages, None);
    let delta2 = anthropic::compute_messages_delta(&p2.messages, Some(&p1.messages));
    let delta3 = anthropic::compute_messages_delta(&p3.messages, Some(&p2.messages));

    // Reconstruct full conversation from deltas
    let mut reconstructed: Vec<serde_json::Value> = Vec::new();
    reconstructed.extend(delta1.messages_delta.iter().cloned());
    reconstructed.extend(delta2.messages_delta.iter().cloned());
    reconstructed.extend(delta3.messages_delta.iter().cloned());

    assert_eq!(
        reconstructed.len(),
        5,
        "Reconstructed conversation must have 5 messages total"
    );

    // Verify delta counts
    assert_eq!(delta1.messages_delta_count, 1);
    assert_eq!(delta2.messages_delta_count, 2);
    assert_eq!(delta3.messages_delta_count, 2);

    // Verify final message
    assert_eq!(
        reconstructed[4]["content"].as_str().unwrap(),
        "Great!",
        "Last reconstructed message must be 'Great!'"
    );
}

// ===========================================================================
// 3.7 NEGATIVE: Without delta compression, full messages stored every turn
// ===========================================================================

/// **Proves:** When compute_messages_delta receives None for previous_messages
/// (simulating no delta compression), it returns the FULL messages array.
/// This demonstrates the storage savings of delta compression: turn 3 of a
/// long conversation would store ~5x more data without delta.
///
/// **Anti-fake property:** If delta compression is not implemented and the
/// system stores full messages every turn, the "second turn delta" test (3.2)
/// would also fail.
#[test]
fn without_previous_context_delta_equals_full_messages() {
    let long_conversation = json!([
        {"role": "user", "content": "First question"},
        {"role": "assistant", "content": "First answer"},
        {"role": "user", "content": "Second question"},
        {"role": "assistant", "content": "Second answer"},
        {"role": "user", "content": "Third question"}
    ]);

    let req = request_with_messages(&long_conversation);
    let parsed = anthropic::parse_request(&req).unwrap();

    // Without previous context (simulating first turn or broken chain)
    let delta = anthropic::compute_messages_delta(&parsed.messages, None);

    assert_eq!(
        delta.messages_delta_count, 5,
        "Without previous context, delta must contain ALL 5 messages"
    );

    // With previous context from the same array, delta is 0
    let delta_same = anthropic::compute_messages_delta(&parsed.messages, Some(&parsed.messages));

    assert_eq!(
        delta_same.messages_delta_count, 0,
        "With identical previous, delta must be 0 — savings of 5 messages"
    );
}

// ===========================================================================
// 3.8 Messages with tool_result and complex content
// ===========================================================================

/// **Proves:** Delta computation works correctly with complex message
/// structures (tool_use, tool_result, content arrays) that are common
/// in Claude Code conversations.
///
/// **Anti-fake property:** A naive delta based only on "role" matching
/// would incorrectly identify messages. This test uses identical roles
/// across turns but different content.
#[test]
fn delta_handles_complex_message_structures() {
    let turn1_msgs = json!([
        {"role": "user", "content": "Read main.rs"},
        {"role": "assistant", "content": [
            {"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {"path": "main.rs"}}
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": "fn main() {}"}
        ]}
    ]);

    let turn2_msgs = json!([
        {"role": "user", "content": "Read main.rs"},
        {"role": "assistant", "content": [
            {"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {"path": "main.rs"}}
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": "fn main() {}"}
        ]},
        {"role": "assistant", "content": "The main.rs file contains a basic main function."},
        {"role": "user", "content": "Now add error handling"}
    ]);

    let req1 = request_with_messages(&turn1_msgs);
    let req2 = request_with_messages(&turn2_msgs);

    let p1 = anthropic::parse_request(&req1).unwrap();
    let p2 = anthropic::parse_request(&req2).unwrap();

    let delta = anthropic::compute_messages_delta(&p2.messages, Some(&p1.messages));

    assert_eq!(
        delta.messages_delta_count, 2,
        "Delta must contain only the 2 new messages after tool_result"
    );
    assert_eq!(
        delta.messages_delta[1]["content"].as_str().unwrap(),
        "Now add error handling"
    );
}
