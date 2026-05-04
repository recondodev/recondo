//! Category A: SSE Stream Accumulator tests.
//!
//! These tests verify that the stream module correctly parses Server-Sent Events
//! from the Anthropic Messages API, accumulates events, detects completion, and
//! handles edge cases.

use recondo_gateway::stream::{parse_sse_stream, SseAccumulator};

// ---------------------------------------------------------------------------
// Helper: build a realistic SSE byte stream from event/data pairs
// ---------------------------------------------------------------------------

fn build_sse_bytes(events: &[(&str, &str)]) -> Vec<u8> {
    let mut buf = String::new();
    for (event_type, data) in events {
        buf.push_str(&format!("event: {}\ndata: {}\n\n", event_type, data));
    }
    buf.into_bytes()
}

/// A complete, minimal SSE stream representing a simple text response.
fn simple_text_stream() -> Vec<u8> {
    build_sse_bytes(&[
        (
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_01ABC","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":25,"output_tokens":1}}}"#,
        ),
        (
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}"#,
        ),
        (
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        (
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}"#,
        ),
        ("message_stop", r#"{"type":"message_stop"}"#),
    ])
}

// ===========================================================================
// A.1 Complete SSE stream with text response accumulates all text deltas
// ===========================================================================

/// **Proves:** A complete SSE stream is parsed into the correct number of events
/// and marked as complete.
#[test]
fn complete_text_stream_accumulates_all_events() {
    let raw = simple_text_stream();
    let result = parse_sse_stream(&raw);

    // Must have 7 events (message_start, content_block_start, 2 deltas, content_block_stop, message_delta, message_stop)
    assert_eq!(
        result.events.len(),
        7,
        "Complete text stream must produce 7 events"
    );

    // Must be marked complete (message_stop was received)
    assert!(
        result.complete,
        "Stream with message_stop must be marked complete"
    );

    // Raw bytes must be non-empty
    assert!(
        !result.raw_bytes.is_empty(),
        "Accumulated raw bytes must not be empty"
    );
}

/// **Proves:** Each parsed event has the correct event_type field.
#[test]
fn complete_text_stream_has_correct_event_types() {
    let raw = simple_text_stream();
    let result = parse_sse_stream(&raw);

    let types: Vec<&str> = result
        .events
        .iter()
        .map(|e| e.event_type.as_str())
        .collect();
    assert_eq!(
        types,
        vec![
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ]
    );
}

/// **Proves:** The data field of each event contains the correct JSON payload,
/// parseable as valid JSON.
#[test]
fn event_data_contains_valid_json_payloads() {
    let raw = simple_text_stream();
    let result = parse_sse_stream(&raw);

    for event in &result.events {
        let parsed: Result<serde_json::Value, _> = serde_json::from_str(&event.data);
        assert!(
            parsed.is_ok(),
            "Event data for '{}' must be valid JSON, got: {}",
            event.event_type,
            event.data
        );
    }
}

/// **Proves:** The text_delta data values are accessible from the parsed events.
#[test]
fn text_delta_events_contain_expected_text() {
    let raw = simple_text_stream();
    let result = parse_sse_stream(&raw);

    let deltas: Vec<&str> = result
        .events
        .iter()
        .filter(|e| e.event_type == "content_block_delta")
        .map(|e| e.data.as_str())
        .collect();

    assert_eq!(deltas.len(), 2, "Must have exactly 2 delta events");

    // First delta must contain "Hello"
    let d0: serde_json::Value = serde_json::from_str(deltas[0]).unwrap();
    assert_eq!(d0["delta"]["text"].as_str().unwrap(), "Hello");

    // Second delta must contain " world"
    let d1: serde_json::Value = serde_json::from_str(deltas[1]).unwrap();
    assert_eq!(d1["delta"]["text"].as_str().unwrap(), " world");
}

// ===========================================================================
// A.2 SSE stream with thinking blocks
// ===========================================================================

/// **Proves:** Thinking content blocks are captured as separate events from text blocks.
#[test]
fn thinking_block_events_are_captured() {
    let raw = build_sse_bytes(&[
        (
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_think","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":50,"output_tokens":1}}}"#,
        ),
        (
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think..."}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" The answer is 4."}}"#,
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
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}"#,
        ),
        ("message_stop", r#"{"type":"message_stop"}"#),
    ]);

    let result = parse_sse_stream(&raw);

    assert!(result.complete, "Stream must be marked complete");
    assert_eq!(result.events.len(), 10, "Must have 10 events");

    // Verify both thinking and text content_block_start events exist
    let block_starts: Vec<&str> = result
        .events
        .iter()
        .filter(|e| e.event_type == "content_block_start")
        .map(|e| e.data.as_str())
        .collect();
    assert_eq!(block_starts.len(), 2, "Must have 2 content block starts");

    let b0: serde_json::Value = serde_json::from_str(block_starts[0]).unwrap();
    assert_eq!(b0["content_block"]["type"].as_str().unwrap(), "thinking");

    let b1: serde_json::Value = serde_json::from_str(block_starts[1]).unwrap();
    assert_eq!(b1["content_block"]["type"].as_str().unwrap(), "text");
}

// ===========================================================================
// A.3 SSE stream with tool_use
// ===========================================================================

/// **Proves:** Tool use content blocks appear as events with correct structure.
#[test]
fn tool_use_events_are_captured() {
    let raw = build_sse_bytes(&[
        (
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_tool","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":100,"output_tokens":1}}}"#,
        ),
        (
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01ABC","name":"read_file","input":{}}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"main.rs\"}"}}"#,
        ),
        (
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        (
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":30}}"#,
        ),
        ("message_stop", r#"{"type":"message_stop"}"#),
    ]);

    let result = parse_sse_stream(&raw);

    assert!(result.complete, "Stream must be complete");

    // Find the tool_use content_block_start
    let tool_start = result
        .events
        .iter()
        .find(|e| e.event_type == "content_block_start")
        .expect("Must have content_block_start");

    let parsed: serde_json::Value = serde_json::from_str(&tool_start.data).unwrap();
    assert_eq!(
        parsed["content_block"]["type"].as_str().unwrap(),
        "tool_use"
    );
    assert_eq!(
        parsed["content_block"]["name"].as_str().unwrap(),
        "read_file"
    );
}

// ===========================================================================
// A.4 Incomplete stream (no message_stop) is marked incomplete
// ===========================================================================

/// **Proves:** A stream that ends without `message_stop` is marked as incomplete.
#[test]
fn stream_without_message_stop_is_incomplete() {
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
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial response"}}"#,
        ),
        // Stream ends abruptly — no message_stop
    ]);

    let result = parse_sse_stream(&raw);

    assert!(
        !result.complete,
        "Stream without message_stop must be marked incomplete"
    );
    assert_eq!(
        result.events.len(),
        3,
        "Must still have the 3 events that were received"
    );
}

// ===========================================================================
// A.5 Ping events are ignored
// ===========================================================================

/// **Proves:** Ping events are either filtered out or present but do not affect
/// the stream completion status.
#[test]
fn ping_events_do_not_affect_stream_behavior() {
    let raw = build_sse_bytes(&[
        ("ping", r#"{"type":"ping"}"#),
        (
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_ping","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}"#,
        ),
        ("ping", r#"{"type":"ping"}"#),
        (
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}"#,
        ),
        (
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        ("ping", r#"{"type":"ping"}"#),
        (
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}"#,
        ),
        ("message_stop", r#"{"type":"message_stop"}"#),
    ]);

    let result = parse_sse_stream(&raw);

    assert!(result.complete, "Stream must be marked complete");

    // The non-ping events must all be present. Ping events may or may not be
    // included in the events list — the key invariant is that they don't break parsing.
    let non_ping_events: Vec<_> = result
        .events
        .iter()
        .filter(|e| e.event_type != "ping")
        .collect();
    assert_eq!(
        non_ping_events.len(),
        6,
        "Must have 6 non-ping events (message_start, block_start, delta, block_stop, message_delta, message_stop)"
    );
}

// ===========================================================================
// A.6 Empty stream is handled gracefully
// ===========================================================================

/// **Proves:** An empty byte input produces no events and is marked incomplete.
#[test]
fn empty_stream_produces_no_events_and_is_incomplete() {
    let result = parse_sse_stream(b"");

    assert!(
        result.events.is_empty(),
        "Empty stream must produce no events"
    );
    assert!(!result.complete, "Empty stream must be marked incomplete");
}

// ===========================================================================
// A.7 Multiple content blocks are all accumulated
// ===========================================================================

/// **Proves:** When a response contains multiple text content blocks, all are captured.
#[test]
fn multiple_content_blocks_all_accumulated() {
    let raw = build_sse_bytes(&[
        (
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_multi","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":30,"output_tokens":1}}}"#,
        ),
        // Block 0: text
        (
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"First block."}}"#,
        ),
        (
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        // Block 1: text
        (
            "content_block_start",
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Second block."}}"#,
        ),
        (
            "content_block_stop",
            r#"{"type":"content_block_stop","index":1}"#,
        ),
        (
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}"#,
        ),
        ("message_stop", r#"{"type":"message_stop"}"#),
    ]);

    let result = parse_sse_stream(&raw);

    assert!(result.complete);

    let block_starts: Vec<_> = result
        .events
        .iter()
        .filter(|e| e.event_type == "content_block_start")
        .collect();
    assert_eq!(
        block_starts.len(),
        2,
        "Must accumulate both content block starts"
    );

    let deltas: Vec<_> = result
        .events
        .iter()
        .filter(|e| e.event_type == "content_block_delta")
        .collect();
    assert_eq!(deltas.len(), 2, "Must accumulate both content block deltas");
}

// ===========================================================================
// A.8 Incremental feeding produces same result as single-shot
// ===========================================================================

/// **Proves:** Feeding data in chunks (simulating network packets) produces the
/// same result as feeding it all at once.
#[test]
fn incremental_feed_produces_same_result_as_single_shot() {
    let raw = simple_text_stream();

    // Single-shot
    let single = parse_sse_stream(&raw);

    // Chunked: feed in 50-byte chunks
    let mut acc = SseAccumulator::new();
    for chunk in raw.chunks(50) {
        acc.feed(chunk);
    }
    let chunked = acc.finish();

    assert_eq!(
        single.events.len(),
        chunked.events.len(),
        "Chunked and single-shot must produce same number of events"
    );
    assert_eq!(
        single.complete, chunked.complete,
        "Chunked and single-shot must agree on completion"
    );

    for (s, c) in single.events.iter().zip(chunked.events.iter()) {
        assert_eq!(s.event_type, c.event_type, "Event types must match");
        assert_eq!(s.data, c.data, "Event data must match");
    }
}

// ===========================================================================
// A.9 Raw bytes accumulation
// ===========================================================================

/// **Proves:** The raw_bytes field contains all the original SSE bytes.
#[test]
fn raw_bytes_contains_all_input_data() {
    let raw = simple_text_stream();
    let result = parse_sse_stream(&raw);

    // The raw_bytes should contain the original stream data
    assert!(
        !result.raw_bytes.is_empty(),
        "raw_bytes must not be empty for non-empty input"
    );
    // The raw_bytes length should match the input (it stores the original bytes)
    assert_eq!(
        result.raw_bytes.len(),
        raw.len(),
        "raw_bytes length must match input length"
    );
}

// ===========================================================================
// Negative: Malformed SSE line does not panic
// ===========================================================================

/// **Proves:** Lines that don't follow SSE format (no `data:` or `event:` prefix)
/// are skipped without panicking.
#[test]
fn malformed_sse_lines_are_skipped_without_panic() {
    let raw = b"this is not SSE format\nrandom garbage\n\nevent: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_ok\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-20250514\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}\n\nmore garbage\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";

    let result = parse_sse_stream(raw);

    // Must not panic, and should still parse the valid events
    assert!(
        result.complete,
        "Valid message_stop in stream with garbage lines must still mark complete"
    );

    let valid_events: Vec<_> = result
        .events
        .iter()
        .filter(|e| e.event_type == "message_start" || e.event_type == "message_stop")
        .collect();
    assert!(
        valid_events.len() >= 2,
        "Must parse at least the 2 valid events among garbage"
    );
}
