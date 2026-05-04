//! Category F: Negative tests for Week 2 modules.
//!
//! These tests verify correct error handling for edge cases and malformed inputs
//! across all new Week 2 modules.

use recondo_gateway::providers::anthropic::{parse_request, parse_response};
use recondo_gateway::stream::{parse_sse_stream, SseEvent};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

fn evt(event_type: &str, data: &str) -> SseEvent {
    SseEvent {
        event_type: event_type.to_string(),
        data: data.to_string(),
    }
}

fn build_sse_bytes(events: &[(&str, &str)]) -> Vec<u8> {
    let mut buf = String::new();
    for (event_type, data) in events {
        buf.push_str(&format!("event: {}\ndata: {}\n\n", event_type, data));
    }
    buf.into_bytes()
}

// ===========================================================================
// F.1 Truncated SSE stream (missing message_stop) -> capture_complete = false
// ===========================================================================

/// **Proves:** An SSE stream that has message_start and content but no message_stop
/// is marked incomplete.
#[test]
fn truncated_stream_after_content_delta_is_incomplete() {
    let raw = build_sse_bytes(&[
        (
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_trunc","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}"#,
        ),
        (
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"This response was cut off"}}"#,
        ),
        // Connection dropped here — no content_block_stop, no message_delta, no message_stop
    ]);

    let result = parse_sse_stream(&raw);

    assert!(
        !result.complete,
        "Stream truncated mid-content must be marked incomplete"
    );
    // Events that were received should still be accessible
    assert_eq!(result.events.len(), 3);
}

/// **Proves:** A stream with message_delta but no message_stop is incomplete.
#[test]
fn stream_with_message_delta_but_no_stop_is_incomplete() {
    let raw = build_sse_bytes(&[
        (
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_nd","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}"#,
        ),
        (
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"text"}}"#,
        ),
        (
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        (
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}"#,
        ),
        // No message_stop!
    ]);

    let result = parse_sse_stream(&raw);

    assert!(
        !result.complete,
        "Stream without message_stop must be marked incomplete even with message_delta"
    );
}

// ===========================================================================
// F.2 Malformed SSE line -> skipped without panic
// ===========================================================================

/// **Proves:** Lines with `data:` but invalid JSON are still captured as events
/// (the data is a raw string) OR they are skipped. Either way, no panic.
#[test]
fn data_with_invalid_json_does_not_panic() {
    let raw = b"event: message_start\ndata: {not valid json at all\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";

    // This must not panic
    let result = parse_sse_stream(raw);

    // The stream should still detect message_stop if it's present after the bad event
    // Implementation may either skip the bad event or include it with raw data
    assert!(
        result.complete,
        "Stream should still detect message_stop after malformed data"
    );
}

/// **Proves:** Completely empty data lines are handled.
#[test]
fn empty_data_lines_handled() {
    let raw = b"event: ping\ndata: \n\nevent: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_e\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-20250514\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":5,\"output_tokens\":1}}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";

    let result = parse_sse_stream(raw);

    // Must not panic, and valid events should be parsed
    assert!(result.complete);
}

/// **Proves:** Lines without the expected SSE format (no colon separator) are ignored.
#[test]
fn lines_without_colon_are_ignored() {
    let raw = b"some random text without colon\nanother line\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";

    let result = parse_sse_stream(raw);
    assert!(result.complete);
}

// ===========================================================================
// F.3 Request with no messages -> handled
// ===========================================================================

/// **Proves:** A request body with an empty messages array is parseable
/// (it's valid JSON, just no messages).
#[test]
fn request_with_empty_messages_array_is_parseable() {
    let body = br#"{
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 1024,
        "messages": []
    }"#;

    // Empty messages array is valid JSON structure. The parser should either
    // accept it (messages.len() == 0) or reject it — but must not panic.
    let result = parse_request(body);

    match result {
        Ok(parsed) => {
            assert!(
                parsed.messages.is_empty(),
                "Empty messages array must produce empty messages vec"
            );
        }
        Err(_) => {
            // Also acceptable: the parser may reject empty messages as invalid
        }
    }
}

// ===========================================================================
// F.4 Empty response body -> handled
// ===========================================================================

/// **Proves:** Parsing an empty SSE stream for response produces an appropriate result.
#[test]
fn parse_response_from_empty_events_returns_error() {
    let events: Vec<SseEvent> = vec![];
    let result = parse_response(&events);

    assert!(
        result.is_err(),
        "Parsing response from empty events must return an error"
    );
}

/// **Proves:** A response with only message_start and message_stop (no content)
/// produces empty text.
#[test]
fn response_with_no_content_blocks_has_empty_text() {
    let events = vec![
        evt(
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_empty","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}"#,
        ),
        evt(
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}"#,
        ),
        evt("message_stop", r#"{"type":"message_stop"}"#),
    ];

    let parsed = parse_response(&events).unwrap();

    assert!(
        parsed.response_text.is_empty(),
        "Response with no content blocks must have empty response_text"
    );
    assert!(parsed.tool_calls.is_empty());
    assert!(parsed.thinking_text.is_none());
}

// ===========================================================================
// F.5 Response parser with only pings
// ===========================================================================

/// **Proves:** A stream of only ping events, when parsed as a response, fails
/// because there is no message_start.
#[test]
fn only_ping_events_returns_error() {
    let events = vec![
        evt("ping", r#"{"type":"ping"}"#),
        evt("ping", r#"{"type":"ping"}"#),
    ];

    let result = parse_response(&events);

    assert!(
        result.is_err(),
        "Response with only ping events must fail (no message_start)"
    );
}

// ===========================================================================
// F.6 SSE stream with only whitespace and newlines
// ===========================================================================

/// **Proves:** A stream of only whitespace/newlines produces no events.
#[test]
fn whitespace_only_stream_produces_no_events() {
    let raw = b"\n\n\n   \n\n";
    let result = parse_sse_stream(raw);

    assert!(result.events.is_empty());
    assert!(!result.complete);
}

// ===========================================================================
// F.7 Tool call with multi-chunk JSON assembly
// ===========================================================================

/// **Proves:** Tool call input JSON that arrives in multiple delta chunks
/// is correctly assembled.
#[test]
fn tool_call_input_assembled_from_multiple_deltas() {
    let events = vec![
        evt(
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_tc_multi","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":50,"output_tokens":1}}}"#,
        ),
        evt(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_chunk","name":"bash","input":{}}}"#,
        ),
        evt(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"com"}}"#,
        ),
        evt(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"mand\":"}}"#,
        ),
        evt(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"ls -la\"}"}}"#,
        ),
        evt(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        evt(
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}"#,
        ),
        evt("message_stop", r#"{"type":"message_stop"}"#),
    ];

    let parsed = parse_response(&events).unwrap();

    assert_eq!(parsed.tool_calls.len(), 1);

    // The assembled JSON must be valid and contain the right command
    let input: serde_json::Value = serde_json::from_str(&parsed.tool_calls[0].input)
        .expect("Assembled tool call input must be valid JSON");
    assert_eq!(
        input["command"].as_str().unwrap(),
        "ls -la",
        "Multi-chunk tool call input must be correctly assembled"
    );
}

// ===========================================================================
// F.8 Request parser: unexpected JSON structure
// ===========================================================================

/// **Proves:** A JSON body that is valid JSON but has wrong types for fields
/// returns an error.
#[test]
fn request_with_wrong_field_types_returns_error() {
    // model is a number instead of string
    let body = br#"{
        "model": 12345,
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": "hi"}]
    }"#;

    let result = parse_request(body);
    assert!(
        result.is_err(),
        "Request with wrong field types must return an error"
    );
}

/// **Proves:** A JSON body that is a JSON array (not object) returns an error.
#[test]
fn request_body_as_array_returns_error() {
    let body = br#"[{"not": "a request"}]"#;

    let result = parse_request(body);
    assert!(
        result.is_err(),
        "Request body as JSON array must return an error"
    );
}
