//! Category B: Anthropic Response Parser tests.
//!
//! These tests verify that the providers::anthropic module correctly parses
//! accumulated SSE events into structured ParsedResponse fields.

use recondo_gateway::providers::anthropic::parse_response;
use recondo_gateway::stream::SseEvent;

// ---------------------------------------------------------------------------
// Helper: build SseEvent from event type and JSON data
// ---------------------------------------------------------------------------

fn evt(event_type: &str, data: &str) -> SseEvent {
    SseEvent {
        event_type: event_type.to_string(),
        data: data.to_string(),
    }
}

/// Build a complete set of SSE events for a simple text-only response.
fn simple_text_events() -> Vec<SseEvent> {
    vec![
        evt(
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_01XFDUDYJgAACzvnptvVoYEL","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":25,"output_tokens":1}}}"#,
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
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":", "}}"#,
        ),
        evt(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world!"}}"#,
        ),
        evt(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        evt(
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}"#,
        ),
        evt("message_stop", r#"{"type":"message_stop"}"#),
    ]
}

// ===========================================================================
// B.1 Parse complete response with text only
// ===========================================================================

/// **Proves:** Text deltas are concatenated into response_text.
#[test]
fn text_deltas_concatenated_into_response_text() {
    let events = simple_text_events();
    let parsed = parse_response(&events).expect("Must parse valid events");

    assert_eq!(
        parsed.response_text, "Hello, world!",
        "response_text must concatenate all text_delta values in order"
    );
}

/// **Proves:** When there are no thinking blocks, thinking_text is None.
#[test]
fn no_thinking_blocks_means_thinking_text_is_none() {
    let events = simple_text_events();
    let parsed = parse_response(&events).unwrap();

    assert!(
        parsed.thinking_text.is_none(),
        "thinking_text must be None when no thinking content blocks exist"
    );
}

/// **Proves:** When there are no tool_use blocks, tool_calls is empty.
#[test]
fn no_tool_use_blocks_means_empty_tool_calls() {
    let events = simple_text_events();
    let parsed = parse_response(&events).unwrap();

    assert!(
        parsed.tool_calls.is_empty(),
        "tool_calls must be empty when no tool_use content blocks exist"
    );
}

// ===========================================================================
// B.2 Parse response with thinking + text
// ===========================================================================

/// **Proves:** Thinking deltas are concatenated into thinking_text, separate from response_text.
#[test]
fn thinking_and_text_blocks_parsed_separately() {
    let events = vec![
        evt(
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_think01","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":50,"output_tokens":1}}}"#,
        ),
        // Thinking block (index 0)
        evt(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
        ),
        evt(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me analyze this. "}}"#,
        ),
        evt(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"The answer is clear."}}"#,
        ),
        evt(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        // Text block (index 1)
        evt(
            "content_block_start",
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"#,
        ),
        evt(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"The answer is 42."}}"#,
        ),
        evt(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":1}"#,
        ),
        evt(
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":30}}"#,
        ),
        evt("message_stop", r#"{"type":"message_stop"}"#),
    ];

    let parsed = parse_response(&events).unwrap();

    assert_eq!(
        parsed.thinking_text.as_deref(),
        Some("Let me analyze this. The answer is clear."),
        "thinking_text must concatenate all thinking_delta values"
    );
    assert_eq!(
        parsed.response_text, "The answer is 42.",
        "response_text must only contain text_delta values, not thinking"
    );
}

// ===========================================================================
// B.3 Parse response with tool_use blocks
// ===========================================================================

/// **Proves:** Tool use blocks are extracted with correct id, name, and input.
#[test]
fn tool_use_blocks_extracted_as_tool_calls() {
    let events = vec![
        evt(
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_tool01","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":100,"output_tokens":1}}}"#,
        ),
        evt(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01ABC","name":"read_file","input":{}}}"#,
        ),
        evt(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"src/main.rs\"}"}}"#,
        ),
        evt(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        evt(
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":25}}"#,
        ),
        evt("message_stop", r#"{"type":"message_stop"}"#),
    ];

    let parsed = parse_response(&events).unwrap();

    assert_eq!(parsed.tool_calls.len(), 1, "Must extract 1 tool call");
    assert_eq!(parsed.tool_calls[0].id, "toolu_01ABC");
    assert_eq!(parsed.tool_calls[0].name, "read_file");

    // The input should be the concatenated JSON from input_json_delta events
    let input_parsed: serde_json::Value =
        serde_json::from_str(&parsed.tool_calls[0].input).unwrap();
    assert_eq!(
        input_parsed["path"].as_str().unwrap(),
        "src/main.rs",
        "Tool call input must contain the assembled JSON"
    );
}

/// **Proves:** Multiple tool calls in one response are all extracted.
#[test]
fn multiple_tool_calls_all_extracted() {
    let events = vec![
        evt(
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_multi_tool","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":150,"output_tokens":1}}}"#,
        ),
        // Tool call 0
        evt(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01A","name":"read_file","input":{}}}"#,
        ),
        evt(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"a.rs\"}"}}"#,
        ),
        evt(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        // Tool call 1
        evt(
            "content_block_start",
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01B","name":"write_file","input":{}}}"#,
        ),
        evt(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"b.rs\",\"content\":\"hello\"}"}}"#,
        ),
        evt(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":1}"#,
        ),
        evt(
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":50}}"#,
        ),
        evt("message_stop", r#"{"type":"message_stop"}"#),
    ];

    let parsed = parse_response(&events).unwrap();

    assert_eq!(parsed.tool_calls.len(), 2, "Must extract 2 tool calls");
    assert_eq!(parsed.tool_calls[0].name, "read_file");
    assert_eq!(parsed.tool_calls[1].name, "write_file");
    assert_eq!(parsed.tool_calls[0].id, "toolu_01A");
    assert_eq!(parsed.tool_calls[1].id, "toolu_01B");
}

// ===========================================================================
// B.4 Extract token usage
// ===========================================================================

/// **Proves:** Input tokens come from message_start, output tokens from message_delta.
#[test]
fn token_usage_extracted_correctly() {
    let events = simple_text_events();
    let parsed = parse_response(&events).unwrap();

    assert_eq!(
        parsed.input_tokens, 25,
        "input_tokens must come from message_start usage"
    );
    assert_eq!(
        parsed.output_tokens, 12,
        "output_tokens must come from message_delta usage"
    );
}

/// **Proves:** Cache tokens are extracted when present, default to 0 when absent.
#[test]
fn cache_tokens_extracted_when_present() {
    let events = vec![
        evt(
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_cache","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":100,"output_tokens":1,"cache_read_input_tokens":500,"cache_creation_input_tokens":200}}}"#,
        ),
        evt(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        ),
        evt(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Cached response."}}"#,
        ),
        evt(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        evt(
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}"#,
        ),
        evt("message_stop", r#"{"type":"message_stop"}"#),
    ];

    let parsed = parse_response(&events).unwrap();

    assert_eq!(
        parsed.cache_read_tokens, 500,
        "cache_read_tokens must be extracted from usage"
    );
    assert_eq!(
        parsed.cache_creation_tokens, 200,
        "cache_creation_tokens must be extracted from usage"
    );
}

/// **Proves:** When cache token fields are absent, they default to 0.
#[test]
fn cache_tokens_default_to_zero_when_absent() {
    let events = simple_text_events();
    let parsed = parse_response(&events).unwrap();

    assert_eq!(
        parsed.cache_read_tokens, 0,
        "cache_read_tokens must default to 0"
    );
    assert_eq!(
        parsed.cache_creation_tokens, 0,
        "cache_creation_tokens must default to 0"
    );
}

// ===========================================================================
// B.5 Extract stop_reason
// ===========================================================================

/// **Proves:** stop_reason is extracted from message_delta event.
#[test]
fn stop_reason_extracted_from_message_delta() {
    let events = simple_text_events();
    let parsed = parse_response(&events).unwrap();

    assert_eq!(
        parsed.stop_reason, "end_turn",
        "stop_reason must be extracted from message_delta"
    );
}

/// **Proves:** stop_reason "tool_use" is correctly extracted.
#[test]
fn stop_reason_tool_use_extracted() {
    let events = vec![
        evt(
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_sr","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}"#,
        ),
        evt(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_x","name":"bash","input":{}}}"#,
        ),
        evt(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}"#,
        ),
        evt(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        evt(
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}"#,
        ),
        evt("message_stop", r#"{"type":"message_stop"}"#),
    ];

    let parsed = parse_response(&events).unwrap();
    assert_eq!(parsed.stop_reason, "tool_use");
}

// ===========================================================================
// B.6 Extract model and message_id
// ===========================================================================

/// **Proves:** model and message_id are extracted from message_start event.
#[test]
fn model_and_message_id_extracted_from_message_start() {
    let events = simple_text_events();
    let parsed = parse_response(&events).unwrap();

    assert_eq!(
        parsed.model, "claude-sonnet-4-20250514",
        "model must be extracted from message_start"
    );
    assert_eq!(
        parsed.message_id, "msg_01XFDUDYJgAACzvnptvVoYEL",
        "message_id must be extracted from message_start"
    );
}

// ===========================================================================
// B.7 Response with mixed text and tool_use
// ===========================================================================

/// **Proves:** A response with text before a tool call captures both.
#[test]
fn mixed_text_and_tool_use_both_captured() {
    let events = vec![
        evt(
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_mixed","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":80,"output_tokens":1}}}"#,
        ),
        // Text block first
        evt(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        ),
        evt(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I will read that file for you."}}"#,
        ),
        evt(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        // Then tool_use
        evt(
            "content_block_start",
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_mix","name":"read_file","input":{}}}"#,
        ),
        evt(
            "content_block_delta",
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"test.rs\"}"}}"#,
        ),
        evt(
            "content_block_stop",
            r#"{"type":"content_block_stop","index":1}"#,
        ),
        evt(
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":40}}"#,
        ),
        evt("message_stop", r#"{"type":"message_stop"}"#),
    ];

    let parsed = parse_response(&events).unwrap();

    assert_eq!(
        parsed.response_text, "I will read that file for you.",
        "response_text must contain the text block"
    );
    assert_eq!(parsed.tool_calls.len(), 1, "Must have 1 tool call");
    assert_eq!(parsed.tool_calls[0].name, "read_file");
    assert_eq!(parsed.stop_reason, "tool_use");
}

// ===========================================================================
// Negative: empty events list
// ===========================================================================

/// **Proves:** Parsing an empty event list returns an error or sensible defaults.
#[test]
fn empty_events_returns_error() {
    let events: Vec<SseEvent> = vec![];
    let result = parse_response(&events);

    // An empty event list has no message_start, so parsing should fail.
    assert!(
        result.is_err(),
        "Parsing empty events must return an error (no message_start)"
    );
}

// ===========================================================================
// Non-streaming JSON responses (Content-Type: application/json)
//
// Claude Code's first request in every session is a quota preflight
// (POST /v1/messages, max_tokens=1, no stream:true). The response is one
// JSON document instead of an SSE stream. parse_response_json handles it.
// ===========================================================================

use recondo_gateway::providers::anthropic::parse_response_json;

/// **Proves:** A non-streaming text-only response populates the same
/// ParsedResponse fields as the SSE parser would for an equivalent stream.
#[test]
fn json_response_text_only_populates_all_core_fields() {
    let body = br#"{
      "id": "msg_01ABC",
      "type": "message",
      "role": "assistant",
      "model": "claude-haiku-4-5-20251001",
      "content": [{"type": "text", "text": "Hello, world!"}],
      "stop_reason": "end_turn",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 12,
        "output_tokens": 5,
        "cache_read_input_tokens": 7,
        "cache_creation_input_tokens": 0
      }
    }"#;

    let parsed = parse_response_json(body).expect("non-streaming JSON must parse");

    assert_eq!(parsed.message_id, "msg_01ABC");
    assert_eq!(parsed.model, "claude-haiku-4-5-20251001");
    assert_eq!(parsed.response_text, "Hello, world!");
    assert_eq!(parsed.stop_reason, "end_turn");
    assert_eq!(parsed.input_tokens, 12);
    assert_eq!(parsed.output_tokens, 5);
    assert_eq!(parsed.cache_read_tokens, 7);
    assert_eq!(parsed.cache_creation_tokens, 0);
    assert!(parsed.tool_calls.is_empty());
    assert!(parsed.thinking_text.is_none());
    assert_eq!(parsed.parser_version.as_deref(), Some("0.1.0"));
}

/// **Proves:** Multiple text content blocks concatenate in array order, matching
/// the SSE parser's behavior when several `text_delta` events arrive.
#[test]
fn json_response_multiple_text_blocks_concatenate() {
    let body = br#"{
      "id": "msg_concat",
      "model": "claude-haiku-4-5",
      "content": [
        {"type": "text", "text": "First. "},
        {"type": "text", "text": "Second. "},
        {"type": "text", "text": "Third."}
      ],
      "stop_reason": "end_turn",
      "usage": {"input_tokens": 1, "output_tokens": 1}
    }"#;

    let parsed = parse_response_json(body).expect("must parse");

    assert_eq!(parsed.response_text, "First. Second. Third.");
}

/// **Proves:** A non-streaming response with a tool_use block extracts the tool
/// call (id, name, input as JSON string) the same way the SSE parser does.
#[test]
fn json_response_tool_use_extracts_tool_call() {
    let body = br#"{
      "id": "msg_tool",
      "model": "claude-opus-4-7",
      "content": [
        {"type": "text", "text": "Reading the file."},
        {
          "type": "tool_use",
          "id": "toolu_01XYZ",
          "name": "read_file",
          "input": {"path": "src/main.rs"}
        }
      ],
      "stop_reason": "tool_use",
      "usage": {"input_tokens": 100, "output_tokens": 30}
    }"#;

    let parsed = parse_response_json(body).expect("must parse");

    assert_eq!(parsed.response_text, "Reading the file.");
    assert_eq!(parsed.stop_reason, "tool_use");
    assert_eq!(parsed.tool_calls.len(), 1);
    assert_eq!(parsed.tool_calls[0].id, "toolu_01XYZ");
    assert_eq!(parsed.tool_calls[0].name, "read_file");
    // Input is preserved as a JSON string (matches SSE parser invariant).
    assert!(parsed.tool_calls[0].input.contains("src/main.rs"));
}

/// **Proves:** A `thinking` content block populates `thinking_text`, used by
/// extended-thinking models.
#[test]
fn json_response_thinking_block_populates_thinking_text() {
    let body = br#"{
      "id": "msg_thinking",
      "model": "claude-opus-4-7",
      "content": [
        {"type": "thinking", "thinking": "Let me consider this carefully."},
        {"type": "text", "text": "The answer is 42."}
      ],
      "stop_reason": "end_turn",
      "usage": {"input_tokens": 50, "output_tokens": 80}
    }"#;

    let parsed = parse_response_json(body).expect("must parse");

    assert_eq!(parsed.response_text, "The answer is 42.");
    assert_eq!(
        parsed.thinking_text.as_deref(),
        Some("Let me consider this carefully.")
    );
}

/// **Proves:** Claude Code's actual quota preflight shape parses without error.
/// `max_tokens=1` typically returns `stop_reason="max_tokens"` with a one-token
/// response. This is the exact failure mode that produced "No message_start
/// event found in events" in user reports before the JSON branch was added.
#[test]
fn json_response_claude_code_quota_preflight() {
    // Real-shape preflight response: max_tokens=1 → server stops at first token.
    let body = br#"{
      "id": "msg_quota_probe",
      "type": "message",
      "role": "assistant",
      "model": "claude-haiku-4-5-20251001",
      "content": [{"type": "text", "text": "Q"}],
      "stop_reason": "max_tokens",
      "stop_sequence": null,
      "usage": {"input_tokens": 8, "output_tokens": 1}
    }"#;

    let parsed = parse_response_json(body).expect("preflight must parse");

    assert_eq!(parsed.stop_reason, "max_tokens");
    assert_eq!(parsed.output_tokens, 1);
    assert_eq!(parsed.model, "claude-haiku-4-5-20251001");
    // capture_complete (set by the caller in gateway/mod.rs) will be true
    // because parse_response_json returned Ok.
}

/// **Proves:** Invalid JSON bytes return an error rather than panic. The error
/// message includes a body preview to aid debugging when this fires in prod.
#[test]
fn json_response_invalid_body_returns_error_with_preview() {
    let body = b"not json at all, just plain text from somewhere";

    let result = parse_response_json(body);

    assert!(result.is_err(), "non-JSON body must return an error");
    let msg = format!("{}", result.unwrap_err());
    assert!(
        msg.contains("non-streaming JSON parse error"),
        "error must identify the parser; got: {}",
        msg
    );
    assert!(
        msg.contains("not json at all"),
        "error must include body preview; got: {}",
        msg
    );
}

/// **Proves:** Missing optional fields don't crash the parser. Defends against
/// API shape drift (e.g., the API skipping `cache_read_input_tokens` for
/// non-cached requests, or `stop_reason` being null mid-stream-from-batch).
#[test]
fn json_response_missing_fields_use_safe_defaults() {
    let body = br#"{
      "id": "msg_minimal",
      "model": "claude-haiku-4-5",
      "content": [{"type": "text", "text": "ok"}],
      "usage": {"input_tokens": 1, "output_tokens": 1}
    }"#;

    let parsed = parse_response_json(body).expect("must parse minimal body");

    assert_eq!(parsed.response_text, "ok");
    assert_eq!(parsed.stop_reason, ""); // default for missing field
    assert_eq!(parsed.cache_read_tokens, 0); // default
    assert_eq!(parsed.cache_creation_tokens, 0); // default
}

/// **Proves:** The Content-Type extractor in the stream module pulls the media
/// type cleanly from a real Anthropic response header block, lower-cased and
/// stripped of charset. This is the gate that decides between SSE vs JSON
/// parsing in parse_capture_data.
#[test]
fn extract_content_type_handles_real_anthropic_headers() {
    use recondo_gateway::stream::extract_content_type;

    let json_headers = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 123";
    assert_eq!(
        extract_content_type(json_headers).as_deref(),
        Some("application/json")
    );

    let sse_headers =
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nServer: cf";
    assert_eq!(
        extract_content_type(sse_headers).as_deref(),
        Some("text/event-stream")
    );

    // Case-insensitive header name (RFC 7230 §3.2)
    let lowercase = "content-type: application/json\r\n";
    assert_eq!(
        extract_content_type(lowercase).as_deref(),
        Some("application/json")
    );

    // Missing header → None
    let no_ct = "HTTP/1.1 200 OK\r\nServer: nginx";
    assert!(extract_content_type(no_ct).is_none());
}
