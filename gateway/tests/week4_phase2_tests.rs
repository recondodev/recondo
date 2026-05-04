//! Week 4 Phase 2 tests: Gemini response parser, mock LLM servers,
//! and struct wiring for v2 columns.
//!
//! These tests are written BEFORE the implementation exists. They define the
//! behavioral contract for three undelivered Week 4 items. The implementation
//! agent's job is to make every test in this file pass.
//!
//! Organization:
//!   1. Gemini parser tests (parse valid response, extract text, extract tool calls,
//!      handle stop reasons, handle usage, handle unknown fields, parse errors on malformed input)
//!   2. Mock LLM server tests (Anthropic, OpenAI, Gemini fixture SSE servers)
//!   3. Struct wiring tests (SessionRecord, TurnRecord, ToolCallRecord v2 field round-trips)
//!   4. Negative tests (malformed Gemini SSE, empty candidates, missing fields, None round-trips)

use recondo_gateway::db::{self, SessionRecord, ToolCallRecord, TurnRecord};
use recondo_gateway::providers::anthropic::{ParsedResponse, ToolCall};
use recondo_gateway::providers::google;
use recondo_gateway::stream::SseEvent;

// ===========================================================================
// Helpers
// ===========================================================================

/// Build an SseEvent from event type and data strings.
fn evt(event_type: &str, data: &str) -> SseEvent {
    SseEvent {
        event_type: event_type.to_string(),
        data: data.to_string(),
    }
}

/// Open an in-memory DB and initialize the schema.
fn setup_db() -> rusqlite::Connection {
    let conn = db::open_in_memory().expect("Must open in-memory SQLite");
    db::initialize(&conn).expect("Must initialize database schema");
    conn
}

/// Build a minimal Gemini SSE event sequence for a simple text response.
///
/// Gemini streaming format: each SSE event has event_type "message" and the data
/// payload is a JSON object with candidates, usageMetadata, and modelVersion.
fn gemini_text_events() -> Vec<SseEvent> {
    vec![
        evt(
            "message",
            r#"{"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},"index":0}],"modelVersion":"gemini-1.5-pro"}"#,
        ),
        evt(
            "message",
            r#"{"candidates":[{"content":{"parts":[{"text":", world!"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15},"modelVersion":"gemini-1.5-pro"}"#,
        ),
    ]
}

/// Build a Gemini SSE event sequence with a tool call (function call).
fn gemini_tool_call_events() -> Vec<SseEvent> {
    vec![evt(
        "message",
        r#"{"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"location":"San Francisco","unit":"celsius"}}}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":10,"totalTokenCount":30},"modelVersion":"gemini-1.5-flash"}"#,
    )]
}

/// Build a Gemini SSE event with both text and tool call parts in the same message.
fn gemini_mixed_parts_events() -> Vec<SseEvent> {
    vec![evt(
        "message",
        r#"{"candidates":[{"content":{"parts":[{"text":"Let me check the weather."},{"functionCall":{"name":"get_weather","args":{"location":"NYC"}}}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":15,"candidatesTokenCount":12,"totalTokenCount":27},"modelVersion":"gemini-1.5-pro"}"#,
    )]
}

/// Build a Gemini SSE event with multiple text parts spread across multiple events
/// to verify concatenation across streaming chunks.
fn gemini_multi_chunk_text_events() -> Vec<SseEvent> {
    vec![
        evt(
            "message",
            r#"{"candidates":[{"content":{"parts":[{"text":"First chunk. "}],"role":"model"},"index":0}],"modelVersion":"gemini-1.5-pro"}"#,
        ),
        evt(
            "message",
            r#"{"candidates":[{"content":{"parts":[{"text":"Second chunk. "}],"role":"model"},"index":0}],"modelVersion":"gemini-1.5-pro"}"#,
        ),
        evt(
            "message",
            r#"{"candidates":[{"content":{"parts":[{"text":"Third chunk."}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":20,"totalTokenCount":28},"modelVersion":"gemini-1.5-pro"}"#,
        ),
    ]
}

/// Build a SessionRecord with ALL v2 fields populated.
fn full_v2_session(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.to_string(),
        provider: "google".to_string(),
        model: Some("gemini-1.5-pro".to_string()),
        started_at: "2026-03-18T10:00:00Z".to_string(),
        last_active_at: "2026-03-18T10:30:00Z".to_string(),
        ended_at: Some("2026-03-18T11:00:00Z".to_string()),
        initial_intent: Some("Generate test data".to_string()),
        system_prompt_hash: "sha256_v2sess".to_string(),
        total_turns: 10,
        turns_captured: 9,
        dropped_events: 1,
        total_tokens: 30000,
        total_cost_usd: 0.75,
        framework: Some("langchain".to_string()),
        // v2 fields
        agent_id: Some("agent-gemini-001".to_string()),
        agent_version: Some("2.0.0".to_string()),
        git_repo: Some("github.com/org/llm-app".to_string()),
        git_branch: Some("main".to_string()),
        git_commit: Some("deadbeef1234".to_string()),
        working_directory: Some("/home/user/llm-app".to_string()),
        parent_session_id: Some("sess_parent_abc".to_string()),
        tags: Some(r#"["compliance","gemini","prod"]"#.to_string()),
        account_uuid: None,
        device_id: None,
        tool_definitions_hash: String::new(),
    }
}

/// Build a SessionRecord with all v2 fields set to None.
fn minimal_v2_session(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.to_string(),
        provider: "anthropic".to_string(),
        model: None,
        started_at: "2026-03-18T09:00:00Z".to_string(),
        last_active_at: "2026-03-18T09:00:00Z".to_string(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash: "sha256_minimal_v2".to_string(),
        total_turns: 0,
        turns_captured: 0,
        dropped_events: 0,
        total_tokens: 0,
        total_cost_usd: 0.0,
        framework: None,
        // v2 fields — all None
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

/// Build a TurnRecord with ALL v2 fields populated.
fn full_v2_turn(id: &str, session_id: &str, seq: i64) -> TurnRecord {
    TurnRecord {
        id: id.to_string(),
        session_id: session_id.to_string(),
        sequence_num: seq,
        timestamp: format!("2026-03-18T10:{:02}:00Z", seq),
        request_hash: format!("req_hash_v2_{}", seq),
        response_hash: format!("resp_hash_v2_{}", seq),
        req_bytes_ref: Some(format!("objects/req/v2_{}.json.gz", seq)),
        resp_bytes_ref: Some(format!("objects/resp/v2_{}.json.gz", seq)),
        req_bytes_size: Some(2048),
        resp_bytes_size: Some(4096),
        model: Some("gemini-1.5-pro".to_string()),
        response_text: Some("Here is the generated code.".to_string()),
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 800,
        output_tokens: 400,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: Some(0.03),
        created_at: format!("2026-03-18T10:{:02}:00Z", seq),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: None,
        parser_version: Some("0.1.0".to_string()),
        parse_errors: None,
        provider: Some("google".to_string()),
        transport: Some("http".to_string()),
        ws_direction: None,
        // v2 fields
        duration_ms: Some(1500),
        ttfb_ms: Some(120),
        api_endpoint: Some("/v1beta/models/gemini-1.5-pro:streamGenerateContent".to_string()),
        http_status: Some(200),
        error_message: None,
        retry_count: 0,
        tool_call_count: 2,
        thinking_tokens: 0,
        server_id: Some("srv-us-east-1".to_string()),
        integrity_verified: None,
        supersedes_turn_id: None,
        user_request_text: None,
        attachment_count: 0,
    }
}

/// Build a TurnRecord with ALL v2 fields set to None/default.
fn minimal_v2_turn(id: &str, session_id: &str, seq: i64) -> TurnRecord {
    TurnRecord {
        id: id.to_string(),
        session_id: session_id.to_string(),
        sequence_num: seq,
        timestamp: format!("2026-03-18T10:{:02}:00Z", seq),
        request_hash: format!("req_hash_min_{}", seq),
        response_hash: format!("resp_hash_min_{}", seq),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: None,
        response_text: None,
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 50,
        output_tokens: 25,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: format!("2026-03-18T10:{:02}:00Z", seq),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: None,
        parser_version: None,
        parse_errors: None,
        provider: None,
        transport: None,
        ws_direction: None,
        // v2 fields — all None/default
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

/// Build a ToolCallRecord with ALL v2 fields populated.
fn full_v2_tool_call(id: &str, turn_id: &str) -> ToolCallRecord {
    ToolCallRecord {
        id: id.to_string(),
        turn_id: turn_id.to_string(),
        tool_name: "get_weather".to_string(),
        tool_input: r#"{"location":"NYC"}"#.to_string(),
        input_hash: Some("sha256_tool_input".to_string()),
        // v2 fields
        sequence_num: Some(1),
        output: Some(r#"{"temp":72,"unit":"F"}"#.to_string()),
        output_hash: Some("sha256_tool_output".to_string()),
        duration_ms: Some(350),
        error: None,
        status: Some("success".to_string()),
        artifacts_created: None,
        artifact_hashes: None,
    }
}

/// Build a ToolCallRecord with ALL v2 fields set to None.
fn minimal_v2_tool_call(id: &str, turn_id: &str) -> ToolCallRecord {
    ToolCallRecord {
        id: id.to_string(),
        turn_id: turn_id.to_string(),
        tool_name: "Read".to_string(),
        tool_input: r#"{"path":"/foo"}"#.to_string(),
        input_hash: None,
        // v2 fields — all None
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
// Section 1: Gemini Parser Tests
// ===========================================================================

/// **Proves:** google::parse_response accepts a valid Gemini SSE event sequence and
/// returns Ok(ParsedResponse). The function exists and has the correct signature.
/// **Anti-fake:** Before implementation, the module `providers::google` does not exist,
/// so this test fails at compile time.
#[test]
fn gemini_parser_returns_ok_for_valid_events() {
    let events = gemini_text_events();
    let result = google::parse_response(&events);
    assert!(
        result.is_ok(),
        "parse_response must succeed for valid Gemini events: {:?}",
        result.err()
    );
}

/// **Proves:** Text parts from candidates[0].content.parts are concatenated into
/// response_text across multiple streaming events.
/// **Anti-fake:** A stub returning empty string would fail; the parser must actually
/// extract and concatenate text from the Gemini JSON structure.
#[test]
fn gemini_parser_extracts_concatenated_text() {
    let events = gemini_text_events();
    let parsed = google::parse_response(&events).unwrap();
    assert_eq!(
        parsed.response_text, "Hello, world!",
        "response_text must be the concatenation of all text parts across events"
    );
}

/// **Proves:** Multi-chunk streaming text is correctly concatenated across three events.
/// **Anti-fake:** Only parsing the last event would give "Third chunk." — this test
/// requires concatenation across all events.
#[test]
fn gemini_parser_concatenates_text_across_multiple_chunks() {
    let events = gemini_multi_chunk_text_events();
    let parsed = google::parse_response(&events).unwrap();
    assert_eq!(
        parsed.response_text, "First chunk. Second chunk. Third chunk.",
        "Text from multiple streaming chunks must be concatenated in order"
    );
}

/// **Proves:** thinking_text is None for Gemini responses (Gemini has no thinking blocks).
/// **Anti-fake:** Setting thinking_text to Some("") or any other value would fail.
#[test]
fn gemini_parser_thinking_text_is_none() {
    let events = gemini_text_events();
    let parsed = google::parse_response(&events).unwrap();
    assert!(
        parsed.thinking_text.is_none(),
        "Gemini does not have thinking blocks — thinking_text must be None"
    );
}

/// **Proves:** Tool calls are extracted from functionCall parts in candidates.
/// **Anti-fake:** A parser that ignores functionCall parts would return an empty vec.
#[test]
fn gemini_parser_extracts_tool_calls() {
    let events = gemini_tool_call_events();
    let parsed = google::parse_response(&events).unwrap();
    assert_eq!(
        parsed.tool_calls.len(),
        1,
        "Must extract exactly one tool call from functionCall part"
    );
    assert_eq!(
        parsed.tool_calls[0].name, "get_weather",
        "Tool call name must be extracted from functionCall.name"
    );
    // The input should be the JSON-serialized args
    let input_parsed: serde_json::Value =
        serde_json::from_str(&parsed.tool_calls[0].input).unwrap();
    assert_eq!(
        input_parsed["location"], "San Francisco",
        "Tool call args must be extracted from functionCall.args"
    );
    assert_eq!(
        input_parsed["unit"], "celsius",
        "All tool call args must be preserved"
    );
}

/// **Proves:** When a message has both text and functionCall parts, both are extracted.
/// **Anti-fake:** A parser that only handles one part type would miss either text or tool call.
#[test]
fn gemini_parser_extracts_mixed_text_and_tool_calls() {
    let events = gemini_mixed_parts_events();
    let parsed = google::parse_response(&events).unwrap();
    assert_eq!(
        parsed.response_text, "Let me check the weather.",
        "Text part must be extracted even when functionCall is present"
    );
    assert_eq!(
        parsed.tool_calls.len(),
        1,
        "functionCall part must be extracted even when text is present"
    );
    assert_eq!(parsed.tool_calls[0].name, "get_weather");
}

/// **Proves:** finishReason "STOP" is mapped to stop_reason "end_turn".
/// **Anti-fake:** Passing through "STOP" verbatim or returning empty string would fail.
#[test]
fn gemini_parser_maps_stop_reason_to_end_turn() {
    let events = gemini_text_events();
    let parsed = google::parse_response(&events).unwrap();
    assert_eq!(
        parsed.stop_reason, "end_turn",
        "Gemini finishReason 'STOP' must map to 'end_turn'"
    );
}

/// **Proves:** finishReason "MAX_TOKENS" is mapped to stop_reason "max_tokens".
/// **Anti-fake:** A hardcoded "end_turn" would fail this test.
#[test]
fn gemini_parser_maps_max_tokens_stop_reason() {
    let events = vec![evt(
        "message",
        r#"{"candidates":[{"content":{"parts":[{"text":"truncated output"}],"role":"model"},"finishReason":"MAX_TOKENS","index":0}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":4096,"totalTokenCount":4196},"modelVersion":"gemini-1.5-pro"}"#,
    )];
    let parsed = google::parse_response(&events).unwrap();
    assert_eq!(
        parsed.stop_reason, "max_tokens",
        "Gemini finishReason 'MAX_TOKENS' must map to 'max_tokens'"
    );
}

/// **Proves:** finishReason "SAFETY" is mapped to stop_reason "safety".
/// **Anti-fake:** Only mapping STOP and MAX_TOKENS would fail this.
#[test]
fn gemini_parser_maps_safety_stop_reason() {
    let events = vec![evt(
        "message",
        r#"{"candidates":[{"content":{"parts":[],"role":"model"},"finishReason":"SAFETY","index":0}],"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":0,"totalTokenCount":50},"modelVersion":"gemini-1.5-pro"}"#,
    )];
    let parsed = google::parse_response(&events).unwrap();
    assert_eq!(
        parsed.stop_reason, "safety",
        "Gemini finishReason 'SAFETY' must map to 'safety'"
    );
}

/// **Proves:** finishReason "RECITATION" is mapped to stop_reason "recitation".
/// **Anti-fake:** Only mapping STOP, MAX_TOKENS, and SAFETY would fail this.
#[test]
fn gemini_parser_maps_recitation_stop_reason() {
    let events = vec![evt(
        "message",
        r#"{"candidates":[{"content":{"parts":[],"role":"model"},"finishReason":"RECITATION","index":0}],"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":0,"totalTokenCount":50},"modelVersion":"gemini-1.5-pro"}"#,
    )];
    let parsed = google::parse_response(&events).unwrap();
    assert_eq!(
        parsed.stop_reason, "recitation",
        "Gemini finishReason 'RECITATION' must map to 'recitation'"
    );
}

/// **Proves:** input_tokens is extracted from usageMetadata.promptTokenCount.
/// **Anti-fake:** A parser returning 0 for all token counts would fail.
#[test]
fn gemini_parser_extracts_input_tokens() {
    let events = gemini_text_events();
    let parsed = google::parse_response(&events).unwrap();
    assert_eq!(
        parsed.input_tokens, 10,
        "input_tokens must be extracted from usageMetadata.promptTokenCount"
    );
}

/// **Proves:** output_tokens is extracted from usageMetadata.candidatesTokenCount.
/// **Anti-fake:** Using totalTokenCount instead would give 15, not 5.
#[test]
fn gemini_parser_extracts_output_tokens() {
    let events = gemini_text_events();
    let parsed = google::parse_response(&events).unwrap();
    assert_eq!(
        parsed.output_tokens, 5,
        "output_tokens must be extracted from usageMetadata.candidatesTokenCount"
    );
}

/// **Proves:** model is extracted from the modelVersion field.
/// **Anti-fake:** A parser returning empty string or hardcoded value would fail.
#[test]
fn gemini_parser_extracts_model_version() {
    let events = gemini_text_events();
    let parsed = google::parse_response(&events).unwrap();
    assert_eq!(
        parsed.model, "gemini-1.5-pro",
        "model must be extracted from modelVersion field"
    );
}

/// **Proves:** A different model version (gemini-1.5-flash) is correctly extracted.
/// **Anti-fake:** Hardcoding "gemini-1.5-pro" would fail this.
#[test]
fn gemini_parser_extracts_flash_model_version() {
    let events = gemini_tool_call_events();
    let parsed = google::parse_response(&events).unwrap();
    assert_eq!(
        parsed.model, "gemini-1.5-flash",
        "model must reflect the actual modelVersion from the response"
    );
}

/// **Proves:** parser_version is set to "0.1.0" for the Gemini parser.
/// **Anti-fake:** A None or different version would fail.
#[test]
fn gemini_parser_sets_parser_version() {
    let events = gemini_text_events();
    let parsed = google::parse_response(&events).unwrap();
    assert_eq!(
        parsed.parser_version,
        Some("0.1.0".to_string()),
        "parser_version must be '0.1.0'"
    );
}

/// **Proves:** Unknown top-level fields in the Gemini response are preserved in raw_extra.
/// **Anti-fake:** A parser that drops unknown fields would return raw_extra as None.
#[test]
fn gemini_parser_preserves_unknown_fields_in_raw_extra() {
    let events = vec![evt(
        "message",
        r#"{"candidates":[{"content":{"parts":[{"text":"hi"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1,"totalTokenCount":6},"modelVersion":"gemini-1.5-pro","serverTiming":{"latencyMs":42},"experimentalField":"test"}"#,
    )];
    let parsed = google::parse_response(&events).unwrap();
    assert!(
        parsed.raw_extra.is_some(),
        "Unknown fields must be captured in raw_extra"
    );
    let extra: serde_json::Value =
        serde_json::from_str(parsed.raw_extra.as_ref().unwrap()).unwrap();
    assert!(
        extra.get("serverTiming").is_some() || extra.get("experimentalField").is_some(),
        "At least one unknown field must be preserved in raw_extra"
    );
}

/// **Proves:** When no unknown fields are present, raw_extra is None.
/// **Anti-fake:** Always setting raw_extra to Some("{}") would fail.
#[test]
fn gemini_parser_raw_extra_is_none_when_no_unknown_fields() {
    let events = gemini_text_events();
    let parsed = google::parse_response(&events).unwrap();
    assert!(
        parsed.raw_extra.is_none(),
        "raw_extra must be None when no unknown fields exist"
    );
}

/// **Proves:** cache_read_tokens defaults to 0 for Gemini (no cache fields).
/// **Anti-fake:** Gemini doesn't have cache tokens; a non-zero value would be wrong.
#[test]
fn gemini_parser_cache_tokens_are_zero() {
    let events = gemini_text_events();
    let parsed = google::parse_response(&events).unwrap();
    assert_eq!(
        parsed.cache_read_tokens, 0,
        "Gemini has no cache tokens — must default to 0"
    );
    assert_eq!(
        parsed.cache_creation_tokens, 0,
        "Gemini has no cache creation tokens — must default to 0"
    );
}

/// **Proves:** Tool call with no text parts results in empty response_text.
/// **Anti-fake:** A parser that fails or returns placeholder text would fail.
#[test]
fn gemini_parser_tool_call_only_has_empty_response_text() {
    let events = gemini_tool_call_events();
    let parsed = google::parse_response(&events).unwrap();
    assert_eq!(
        parsed.response_text, "",
        "When only functionCall parts exist, response_text must be empty"
    );
}

/// **Proves:** Multiple tool calls in one response are all extracted.
/// **Anti-fake:** A parser that only extracts the first tool call would fail.
#[test]
fn gemini_parser_extracts_multiple_tool_calls() {
    let events = vec![evt(
        "message",
        r#"{"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"location":"NYC"}}},{"functionCall":{"name":"get_time","args":{"timezone":"EST"}}}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":25,"candidatesTokenCount":15,"totalTokenCount":40},"modelVersion":"gemini-1.5-pro"}"#,
    )];
    let parsed = google::parse_response(&events).unwrap();
    assert_eq!(
        parsed.tool_calls.len(),
        2,
        "Must extract all functionCall parts, not just the first"
    );
    assert_eq!(parsed.tool_calls[0].name, "get_weather");
    assert_eq!(parsed.tool_calls[1].name, "get_time");
}

// ===========================================================================
// Section 2: Mock LLM Server Tests
// ===========================================================================

// The mock servers live in a test utility module. They are not part of the
// library crate — they exist only for integration tests.
//
// The expected API:
//   recondo_gateway::providers::mock::start_mock_server(fixture: &str, provider: &str)
//     -> (String, tokio::sync::oneshot::Sender<()>)
//
//   - fixture: raw SSE text to return as the response body
//   - provider: "anthropic", "openai", or "google" (used for naming/logging)
//   - returns (url, shutdown_tx)

#[cfg(feature = "test-support")]
use recondo_gateway::providers::mock;

/// Anthropic fixture SSE data for mock server tests.
#[cfg(feature = "test-support")]
const ANTHROPIC_FIXTURE: &str = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_mock\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-20250514\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Mock response\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";

/// OpenAI fixture SSE data for mock server tests.
#[cfg(feature = "test-support")]
const OPENAI_FIXTURE: &str = "data: {\"id\":\"chatcmpl-mock\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Mock\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"chatcmpl-mock\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" response\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\ndata: [DONE]\n\n";

/// Gemini fixture SSE data for mock server tests.
#[cfg(feature = "test-support")]
const GEMINI_FIXTURE: &str = "event: message\ndata: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Mock response\"}],\"role\":\"model\"},\"finishReason\":\"STOP\",\"index\":0}],\"usageMetadata\":{\"promptTokenCount\":10,\"candidatesTokenCount\":5,\"totalTokenCount\":15},\"modelVersion\":\"gemini-1.5-pro\"}\n\n";

/// **Proves:** The Anthropic mock server starts, accepts HTTP POST, and returns the
/// fixture SSE data with correct Content-Type header.
/// **Anti-fake:** Without the mock server implementation, the module does not exist.
#[cfg(feature = "test-support")]
#[tokio::test]
async fn mock_anthropic_server_returns_sse_with_correct_content_type() {
    let (url, shutdown_tx) = mock::start_mock_server(ANTHROPIC_FIXTURE, "anthropic").await;

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(r#"{"model":"claude-sonnet-4-20250514","messages":[]}"#)
        .send()
        .await
        .expect("Must connect to mock server");

    assert_eq!(resp.status(), 200, "Mock server must return HTTP 200");
    let content_type = resp
        .headers()
        .get("content-type")
        .expect("Must have Content-Type header")
        .to_str()
        .unwrap();
    assert!(
        content_type.contains("text/event-stream"),
        "Content-Type must be text/event-stream, got: {}",
        content_type
    );

    let body = resp.text().await.unwrap();
    assert!(
        body.contains("message_start"),
        "Response body must contain Anthropic SSE fixture data"
    );

    let _ = shutdown_tx.send(());
}

/// **Proves:** The OpenAI mock server starts, accepts HTTP POST, and returns SSE data.
/// **Anti-fake:** A non-existent or broken mock server would fail to connect.
#[cfg(feature = "test-support")]
#[tokio::test]
async fn mock_openai_server_returns_sse_fixture() {
    let (url, shutdown_tx) = mock::start_mock_server(OPENAI_FIXTURE, "openai").await;

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(r#"{"model":"gpt-4o","messages":[]}"#)
        .send()
        .await
        .expect("Must connect to mock server");

    assert_eq!(resp.status(), 200);
    let body = resp.text().await.unwrap();
    assert!(
        body.contains("chatcmpl-mock"),
        "Response body must contain OpenAI SSE fixture data"
    );
    assert!(
        body.contains("[DONE]"),
        "OpenAI SSE must end with [DONE] marker"
    );

    let _ = shutdown_tx.send(());
}

/// **Proves:** The Gemini mock server starts, accepts HTTP POST, and returns SSE data.
/// **Anti-fake:** The fixture contains Gemini-specific JSON; a generic stub would not match.
#[cfg(feature = "test-support")]
#[tokio::test]
async fn mock_gemini_server_returns_sse_fixture() {
    let (url, shutdown_tx) = mock::start_mock_server(GEMINI_FIXTURE, "google").await;

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(r#"{"contents":[{"parts":[{"text":"Hello"}]}]}"#)
        .send()
        .await
        .expect("Must connect to mock server");

    assert_eq!(resp.status(), 200);
    let content_type = resp
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(
        content_type.contains("text/event-stream"),
        "Gemini mock must also use text/event-stream Content-Type"
    );

    let body = resp.text().await.unwrap();
    assert!(
        body.contains("gemini-1.5-pro"),
        "Response body must contain Gemini fixture data"
    );

    let _ = shutdown_tx.send(());
}

/// **Proves:** Mock server responses are deterministic — same fixture yields identical
/// response bytes on two sequential requests.
/// **Anti-fake:** A server that injects timestamps or random data would fail.
#[cfg(feature = "test-support")]
#[tokio::test]
async fn mock_server_is_deterministic() {
    let (url, shutdown_tx) = mock::start_mock_server(ANTHROPIC_FIXTURE, "anthropic").await;

    let client = reqwest::Client::new();

    let body1 = client
        .post(&url)
        .body("{}")
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();

    let body2 = client
        .post(&url)
        .body("{}")
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();

    assert_eq!(
        body1, body2,
        "Two requests to the same mock server must produce identical response bytes"
    );

    let _ = shutdown_tx.send(());
}

/// **Proves:** Mock server binds to a random port (not a hardcoded one), so multiple
/// servers can run concurrently without port conflicts.
/// **Anti-fake:** A hardcoded port would cause the second server to fail to bind.
#[cfg(feature = "test-support")]
#[tokio::test]
async fn mock_servers_bind_to_different_random_ports() {
    let (url1, shutdown_tx1) = mock::start_mock_server(ANTHROPIC_FIXTURE, "anthropic").await;
    let (url2, shutdown_tx2) = mock::start_mock_server(OPENAI_FIXTURE, "openai").await;

    assert_ne!(url1, url2, "Two mock servers must bind to different ports");

    // Both must be reachable
    let client = reqwest::Client::new();
    let resp1 = client.post(&url1).body("{}").send().await.unwrap();
    let resp2 = client.post(&url2).body("{}").send().await.unwrap();
    assert_eq!(resp1.status(), 200);
    assert_eq!(resp2.status(), 200);

    let _ = shutdown_tx1.send(());
    let _ = shutdown_tx2.send(());
}

/// **Proves:** Mock server shuts down cleanly when shutdown_tx is sent.
/// **Anti-fake:** A leaking server would keep the port open indefinitely.
#[cfg(feature = "test-support")]
#[tokio::test]
async fn mock_server_shuts_down_via_oneshot() {
    let (url, shutdown_tx) = mock::start_mock_server(ANTHROPIC_FIXTURE, "anthropic").await;

    // Verify it works before shutdown
    let client = reqwest::Client::new();
    let resp = client.post(&url).body("{}").send().await.unwrap();
    assert_eq!(resp.status(), 200);

    // Send shutdown signal
    shutdown_tx.send(()).expect("Must send shutdown signal");

    // Give the server a moment to shut down
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // After shutdown, the connection should be refused
    let result = client.post(&url).body("{}").send().await;
    assert!(
        result.is_err(),
        "After shutdown, requests to the mock server must fail"
    );
}

/// **Proves:** Mock server with empty fixture returns HTTP 200 with empty body.
/// **Anti-fake:** A server that panics or returns 500 on empty fixture would fail.
#[cfg(feature = "test-support")]
#[tokio::test]
async fn mock_server_with_empty_fixture_returns_200() {
    let (url, shutdown_tx) = mock::start_mock_server("", "anthropic").await;

    let client = reqwest::Client::new();
    let resp = client.post(&url).body("{}").send().await.unwrap();
    assert_eq!(
        resp.status(),
        200,
        "Empty fixture must still return HTTP 200"
    );
    let body = resp.text().await.unwrap();
    assert_eq!(body, "", "Empty fixture must produce empty response body");

    let _ = shutdown_tx.send(());
}

// ===========================================================================
// Section 3: Struct Wiring Tests (v2 fields through insert/select)
// ===========================================================================

/// **Proves:** SessionRecord has agent_id, agent_version, git_repo, git_branch,
/// git_commit, working_directory, parent_session_id, and tags fields.
/// insert_session writes them and list_sessions reads them back.
/// **Anti-fake:** The current SessionRecord does not have these fields. This test
/// would fail to compile without them.
#[test]
fn session_v2_fields_round_trip_through_insert_and_list() {
    let conn = setup_db();
    let session = full_v2_session("sess_v2_full");
    db::insert_session(&conn, &session).expect("Must insert session with v2 fields");

    let sessions = db::list_sessions(&conn, Some(10)).expect("Must list sessions");
    assert_eq!(sessions.len(), 1);
    let s = &sessions[0];

    assert_eq!(s.agent_id, Some("agent-gemini-001".to_string()));
    assert_eq!(s.agent_version, Some("2.0.0".to_string()));
    assert_eq!(s.git_repo, Some("github.com/org/llm-app".to_string()));
    assert_eq!(s.git_branch, Some("main".to_string()));
    assert_eq!(s.git_commit, Some("deadbeef1234".to_string()));
    assert_eq!(s.working_directory, Some("/home/user/llm-app".to_string()));
    assert_eq!(s.parent_session_id, Some("sess_parent_abc".to_string()));
    assert_eq!(
        s.tags,
        Some(r#"["compliance","gemini","prod"]"#.to_string())
    );
}

/// **Proves:** SessionRecord v2 fields round-trip through get_session (by ID).
/// **Anti-fake:** get_session must also read the v2 columns, not just list_sessions.
#[test]
fn session_v2_fields_round_trip_through_get_session() {
    let conn = setup_db();
    let session = full_v2_session("sess_v2_get");
    db::insert_session(&conn, &session).unwrap();

    let s = db::get_session(&conn, "sess_v2_get")
        .unwrap()
        .expect("Must find session by ID");

    assert_eq!(s.agent_id, Some("agent-gemini-001".to_string()));
    assert_eq!(s.git_commit, Some("deadbeef1234".to_string()));
    assert_eq!(
        s.tags,
        Some(r#"["compliance","gemini","prod"]"#.to_string())
    );
}

/// **Proves:** TurnRecord has duration_ms, ttfb_ms, api_endpoint, http_status,
/// error_message, retry_count, tool_call_count, thinking_tokens, and server_id fields.
/// insert_turn writes them and get_turns_for_session reads them back.
/// **Anti-fake:** The current TurnRecord does not have these fields in the struct.
/// The current insert_turn does not write them. Both must be updated.
#[test]
fn turn_v2_fields_round_trip_through_insert_and_get_turns() {
    let conn = setup_db();
    let session = full_v2_session("sess_turns_v2");
    db::insert_session(&conn, &session).unwrap();

    let turn = full_v2_turn("turn_v2_full", "sess_turns_v2", 1);
    db::insert_turn(&conn, &turn).expect("Must insert turn with v2 fields");

    let turns = db::get_turns_for_session(&conn, "sess_turns_v2").unwrap();
    assert_eq!(turns.len(), 1);
    let t = &turns[0];

    assert_eq!(t.duration_ms, Some(1500));
    assert_eq!(t.ttfb_ms, Some(120));
    assert_eq!(
        t.api_endpoint,
        Some("/v1beta/models/gemini-1.5-pro:streamGenerateContent".to_string())
    );
    assert_eq!(t.http_status, Some(200));
    assert!(t.error_message.is_none());
    assert_eq!(t.retry_count, 0);
    assert_eq!(t.tool_call_count, 2);
    assert_eq!(t.thinking_tokens, 0);
    assert_eq!(t.server_id, Some("srv-us-east-1".to_string()));
}

/// **Proves:** TurnRecord v2 fields round-trip through get_turn (by turn ID).
/// **Anti-fake:** get_turn must include v2 columns in its SELECT and turn_from_row mapping.
#[test]
fn turn_v2_fields_round_trip_through_get_turn() {
    let conn = setup_db();
    let session = full_v2_session("sess_turn_get_v2");
    db::insert_session(&conn, &session).unwrap();

    let turn = full_v2_turn("turn_get_v2", "sess_turn_get_v2", 1);
    db::insert_turn(&conn, &turn).unwrap();

    let t = db::get_turn(&conn, "turn_get_v2")
        .unwrap()
        .expect("Must find turn by ID");

    assert_eq!(t.duration_ms, Some(1500));
    assert_eq!(t.ttfb_ms, Some(120));
    assert_eq!(t.http_status, Some(200));
    assert_eq!(t.retry_count, 0);
    assert_eq!(t.tool_call_count, 2);
    assert_eq!(t.thinking_tokens, 0);
    assert_eq!(t.server_id, Some("srv-us-east-1".to_string()));
}

/// **Proves:** TurnRecord v2 fields with non-zero retry_count and error_message round-trip.
/// **Anti-fake:** A default-only implementation would give retry_count=0 and error_message=None.
#[test]
fn turn_v2_error_fields_round_trip() {
    let conn = setup_db();
    let session = minimal_v2_session("sess_turn_err");
    db::insert_session(&conn, &session).unwrap();

    let mut turn = full_v2_turn("turn_err_v2", "sess_turn_err", 1);
    turn.retry_count = 3;
    turn.error_message = Some("upstream timeout after 30s".to_string());
    turn.http_status = Some(504);
    db::insert_turn(&conn, &turn).unwrap();

    let t = db::get_turn(&conn, "turn_err_v2").unwrap().unwrap();
    assert_eq!(t.retry_count, 3, "Non-zero retry_count must round-trip");
    assert_eq!(
        t.error_message,
        Some("upstream timeout after 30s".to_string()),
        "error_message must round-trip"
    );
    assert_eq!(t.http_status, Some(504), "http_status 504 must round-trip");
}

/// **Proves:** TurnRecord v2 fields with thinking_tokens > 0 round-trip correctly.
/// **Anti-fake:** A parser that ignores thinking_tokens would leave it at 0.
#[test]
fn turn_v2_thinking_tokens_round_trip() {
    let conn = setup_db();
    let session = minimal_v2_session("sess_thinking");
    db::insert_session(&conn, &session).unwrap();

    let mut turn = minimal_v2_turn("turn_thinking", "sess_thinking", 1);
    turn.thinking_tokens = 500;
    db::insert_turn(&conn, &turn).unwrap();

    let t = db::get_turn(&conn, "turn_thinking").unwrap().unwrap();
    assert_eq!(
        t.thinking_tokens, 500,
        "thinking_tokens must round-trip non-zero value"
    );
}

/// **Proves:** ToolCallRecord has sequence_num, output, output_hash, duration_ms,
/// error, and status fields. insert_tool_call writes them and
/// get_tool_calls_for_turn reads them back.
/// **Anti-fake:** The current ToolCallRecord does not have these fields, and
/// insert_tool_call/get_tool_calls_for_turn do not handle them.
#[test]
fn tool_call_v2_fields_round_trip_through_insert_and_get() {
    let conn = setup_db();
    let session = full_v2_session("sess_tc_v2");
    db::insert_session(&conn, &session).unwrap();
    let turn = full_v2_turn("turn_tc_v2", "sess_tc_v2", 1);
    db::insert_turn(&conn, &turn).unwrap();

    let tc = full_v2_tool_call("tc_v2_full", "turn_tc_v2");
    db::insert_tool_call(&conn, &tc).expect("Must insert tool call with v2 fields");

    let tool_calls = db::get_tool_calls_for_turn(&conn, "turn_tc_v2").unwrap();
    assert_eq!(tool_calls.len(), 1);
    let tc_read = &tool_calls[0];

    assert_eq!(tc_read.sequence_num, Some(1));
    assert_eq!(
        tc_read.output,
        Some(r#"{"temp":72,"unit":"F"}"#.to_string())
    );
    assert_eq!(tc_read.output_hash, Some("sha256_tool_output".to_string()));
    assert_eq!(tc_read.duration_ms, Some(350));
    assert!(tc_read.error.is_none());
    assert_eq!(tc_read.status, Some("success".to_string()));
}

/// **Proves:** ToolCallRecord with error status round-trips correctly.
/// **Anti-fake:** A parser that drops error/status fields would return None.
#[test]
fn tool_call_v2_error_fields_round_trip() {
    let conn = setup_db();
    let session = minimal_v2_session("sess_tc_err");
    db::insert_session(&conn, &session).unwrap();
    let turn = minimal_v2_turn("turn_tc_err", "sess_tc_err", 1);
    db::insert_turn(&conn, &turn).unwrap();

    let tc = ToolCallRecord {
        id: "tc_err_v2".to_string(),
        turn_id: "turn_tc_err".to_string(),
        tool_name: "Bash".to_string(),
        tool_input: r#"{"command":"rm -rf /"}"#.to_string(),
        input_hash: Some("sha256_danger".to_string()),
        sequence_num: Some(3),
        output: None,
        output_hash: None,
        duration_ms: Some(50),
        error: Some("permission denied".to_string()),
        status: Some("error".to_string()),
        artifacts_created: None,
        artifact_hashes: None,
    };
    db::insert_tool_call(&conn, &tc).unwrap();

    let tool_calls = db::get_tool_calls_for_turn(&conn, "turn_tc_err").unwrap();
    assert_eq!(tool_calls.len(), 1);
    let tc_read = &tool_calls[0];
    assert_eq!(tc_read.error, Some("permission denied".to_string()));
    assert_eq!(tc_read.status, Some("error".to_string()));
    assert_eq!(tc_read.sequence_num, Some(3));
    assert!(tc_read.output.is_none());
}

/// **Proves:** Multiple tool calls for the same turn are all returned by
/// get_tool_calls_for_turn, each with correct v2 fields.
/// **Anti-fake:** A query that returns only the first tool call would fail.
#[test]
fn multiple_tool_calls_v2_round_trip() {
    let conn = setup_db();
    let session = minimal_v2_session("sess_multi_tc");
    db::insert_session(&conn, &session).unwrap();
    let turn = minimal_v2_turn("turn_multi_tc", "sess_multi_tc", 1);
    db::insert_turn(&conn, &turn).unwrap();

    let tc1 = ToolCallRecord {
        id: "tc_multi_1".to_string(),
        turn_id: "turn_multi_tc".to_string(),
        tool_name: "Read".to_string(),
        tool_input: r#"{"path":"/a"}"#.to_string(),
        input_hash: None,
        sequence_num: Some(1),
        output: Some("file contents".to_string()),
        output_hash: Some("sha256_out_1".to_string()),
        duration_ms: Some(10),
        error: None,
        status: Some("success".to_string()),
        artifacts_created: None,
        artifact_hashes: None,
    };
    let tc2 = ToolCallRecord {
        id: "tc_multi_2".to_string(),
        turn_id: "turn_multi_tc".to_string(),
        tool_name: "Write".to_string(),
        tool_input: r#"{"path":"/b","content":"x"}"#.to_string(),
        input_hash: None,
        sequence_num: Some(2),
        output: Some("ok".to_string()),
        output_hash: Some("sha256_out_2".to_string()),
        duration_ms: Some(20),
        error: None,
        status: Some("success".to_string()),
        artifacts_created: None,
        artifact_hashes: None,
    };

    db::insert_tool_call(&conn, &tc1).unwrap();
    db::insert_tool_call(&conn, &tc2).unwrap();

    let tool_calls = db::get_tool_calls_for_turn(&conn, "turn_multi_tc").unwrap();
    assert_eq!(
        tool_calls.len(),
        2,
        "Both tool calls must be returned for the turn"
    );
    // Check that both have their v2 fields
    let names: Vec<&str> = tool_calls.iter().map(|tc| tc.tool_name.as_str()).collect();
    assert!(names.contains(&"Read"));
    assert!(names.contains(&"Write"));
}

// ===========================================================================
// Section 4: Negative Tests
// ===========================================================================

/// **Proves:** Malformed JSON in a Gemini SSE event produces an Err, not a panic.
/// **Anti-fake:** A parser that blindly unwraps JSON parsing would panic.
#[test]
fn gemini_parser_returns_error_on_malformed_json() {
    let events = vec![evt("message", "this is not valid JSON at all")];
    let result = google::parse_response(&events);
    assert!(
        result.is_err(),
        "Malformed JSON must cause parse_response to return Err"
    );
}

/// **Proves:** An empty event list produces an Err (no data to parse).
/// **Anti-fake:** A parser that returns a default ParsedResponse would succeed incorrectly.
#[test]
fn gemini_parser_returns_error_on_empty_events() {
    let events: Vec<SseEvent> = vec![];
    let result = google::parse_response(&events);
    assert!(
        result.is_err(),
        "Empty event list must cause parse_response to return Err"
    );
}

/// **Proves:** A Gemini event with empty candidates array produces an Err or records
/// a parse error — it does not panic or produce garbage output.
/// **Anti-fake:** A parser that indexes candidates[0] without checking would panic.
#[test]
fn gemini_parser_handles_empty_candidates() {
    let events = vec![evt(
        "message",
        r#"{"candidates":[],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":0,"totalTokenCount":5},"modelVersion":"gemini-1.5-pro"}"#,
    )];
    let result = google::parse_response(&events);
    // Either returns Err or returns Ok with parse_errors recording the issue.
    // Both are acceptable — what matters is no panic.
    match result {
        Err(_) => {} // Acceptable: empty candidates is an error condition
        Ok(parsed) => {
            // If it returns Ok, response_text should be empty and there should be
            // evidence that something was off (parse_errors or empty response)
            assert_eq!(
                parsed.response_text, "",
                "Empty candidates must not produce phantom text"
            );
        }
    }
}

/// **Proves:** A Gemini event missing the candidates field entirely is handled gracefully.
/// **Anti-fake:** A parser that assumes candidates always exists would panic on None access.
#[test]
fn gemini_parser_handles_missing_candidates_field() {
    let events = vec![evt(
        "message",
        r#"{"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":0,"totalTokenCount":5},"modelVersion":"gemini-1.5-pro"}"#,
    )];
    let result = google::parse_response(&events);
    match result {
        Err(_) => {} // Acceptable
        Ok(parsed) => {
            assert_eq!(parsed.response_text, "");
        }
    }
}

/// **Proves:** A Gemini event with missing usageMetadata defaults to 0 tokens.
/// **Anti-fake:** A parser that panics on missing usageMetadata would fail.
#[test]
fn gemini_parser_handles_missing_usage_metadata() {
    let events = vec![evt(
        "message",
        r#"{"candidates":[{"content":{"parts":[{"text":"no usage"}],"role":"model"},"finishReason":"STOP","index":0}],"modelVersion":"gemini-1.5-pro"}"#,
    )];
    let result = google::parse_response(&events);
    assert!(result.is_ok(), "Missing usageMetadata must not cause error");
    let parsed = result.unwrap();
    assert_eq!(parsed.response_text, "no usage");
    // Token counts should default to 0 when usageMetadata is absent
    assert_eq!(
        parsed.input_tokens, 0,
        "Missing usageMetadata must default input_tokens to 0"
    );
    assert_eq!(
        parsed.output_tokens, 0,
        "Missing usageMetadata must default output_tokens to 0"
    );
}

/// **Proves:** A Gemini event with missing modelVersion defaults model to empty string.
/// **Anti-fake:** A parser that panics on missing modelVersion would fail.
#[test]
fn gemini_parser_handles_missing_model_version() {
    let events = vec![evt(
        "message",
        r#"{"candidates":[{"content":{"parts":[{"text":"no model"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}"#,
    )];
    let result = google::parse_response(&events);
    assert!(result.is_ok(), "Missing modelVersion must not cause error");
    let parsed = result.unwrap();
    assert!(
        parsed.model.is_empty() || parsed.model == "unknown",
        "Missing modelVersion must default model to empty or 'unknown', got: '{}'",
        parsed.model
    );
}

/// **Proves:** A Gemini event with an unknown finishReason passes it through or records
/// a parse error — it does not panic.
/// **Anti-fake:** A match statement without a default arm would panic on unknown variants.
#[test]
fn gemini_parser_handles_unknown_finish_reason() {
    let events = vec![evt(
        "message",
        r#"{"candidates":[{"content":{"parts":[{"text":"hmm"}],"role":"model"},"finishReason":"BLOCKLIST","index":0}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1,"totalTokenCount":6},"modelVersion":"gemini-1.5-pro"}"#,
    )];
    let result = google::parse_response(&events);
    assert!(
        result.is_ok(),
        "Unknown finishReason must not cause an error"
    );
    let parsed = result.unwrap();
    // Either mapped to something or stored as-is or recorded in parse_errors
    assert!(
        !parsed.stop_reason.is_empty(),
        "stop_reason must not be empty for unknown finishReason"
    );
}

/// **Proves:** A Gemini event with missing finishReason (streaming in-progress)
/// defaults stop_reason to empty or a sensible value, not a panic.
/// **Anti-fake:** A parser that requires finishReason would fail.
#[test]
fn gemini_parser_handles_missing_finish_reason() {
    let events = vec![evt(
        "message",
        r#"{"candidates":[{"content":{"parts":[{"text":"still streaming"}],"role":"model"},"index":0}],"modelVersion":"gemini-1.5-pro"}"#,
    )];
    let result = google::parse_response(&events);
    assert!(result.is_ok(), "Missing finishReason must not cause error");
    let parsed = result.unwrap();
    assert_eq!(
        parsed.response_text, "still streaming",
        "Text must still be extracted when finishReason is absent"
    );
}

/// **Proves:** SessionRecord with None v2 fields round-trips through insert/select.
/// **Anti-fake:** A broken INSERT that doesn't handle NULL for v2 columns would error.
#[test]
fn session_none_v2_fields_round_trip() {
    let conn = setup_db();
    let session = minimal_v2_session("sess_none_v2");
    db::insert_session(&conn, &session).expect("Must insert session with None v2 fields");

    let s = db::get_session(&conn, "sess_none_v2").unwrap().unwrap();
    assert!(
        s.agent_id.is_none(),
        "agent_id None must round-trip as None"
    );
    assert!(
        s.agent_version.is_none(),
        "agent_version None must round-trip as None"
    );
    assert!(
        s.git_repo.is_none(),
        "git_repo None must round-trip as None"
    );
    assert!(
        s.git_branch.is_none(),
        "git_branch None must round-trip as None"
    );
    assert!(
        s.git_commit.is_none(),
        "git_commit None must round-trip as None"
    );
    assert!(
        s.working_directory.is_none(),
        "working_directory None must round-trip as None"
    );
    assert!(
        s.parent_session_id.is_none(),
        "parent_session_id None must round-trip as None"
    );
    assert!(s.tags.is_none(), "tags None must round-trip as None");
}

/// **Proves:** TurnRecord with None v2 fields round-trips through insert/select.
/// **Anti-fake:** A broken INSERT for turns would error on NULL v2 columns.
#[test]
fn turn_none_v2_fields_round_trip() {
    let conn = setup_db();
    let session = minimal_v2_session("sess_turn_none_v2");
    db::insert_session(&conn, &session).unwrap();

    let turn = minimal_v2_turn("turn_none_v2", "sess_turn_none_v2", 1);
    db::insert_turn(&conn, &turn).expect("Must insert turn with None v2 fields");

    let t = db::get_turn(&conn, "turn_none_v2").unwrap().unwrap();
    assert!(
        t.duration_ms.is_none(),
        "duration_ms None must round-trip as None"
    );
    assert!(t.ttfb_ms.is_none(), "ttfb_ms None must round-trip as None");
    assert!(
        t.api_endpoint.is_none(),
        "api_endpoint None must round-trip as None"
    );
    assert!(
        t.http_status.is_none(),
        "http_status None must round-trip as None"
    );
    assert!(
        t.error_message.is_none(),
        "error_message None must round-trip as None"
    );
    assert_eq!(
        t.retry_count, 0,
        "retry_count must default to 0 when not set"
    );
    assert_eq!(
        t.tool_call_count, 0,
        "tool_call_count must default to 0 when not set"
    );
    assert_eq!(
        t.thinking_tokens, 0,
        "thinking_tokens must default to 0 when not set"
    );
    assert!(
        t.server_id.is_none(),
        "server_id None must round-trip as None"
    );
}

/// **Proves:** ToolCallRecord with None v2 fields round-trips through insert/select.
/// **Anti-fake:** A broken INSERT for tool_calls would error on NULL v2 columns.
#[test]
fn tool_call_none_v2_fields_round_trip() {
    let conn = setup_db();
    let session = minimal_v2_session("sess_tc_none_v2");
    db::insert_session(&conn, &session).unwrap();
    let turn = minimal_v2_turn("turn_tc_none_v2", "sess_tc_none_v2", 1);
    db::insert_turn(&conn, &turn).unwrap();

    let tc = minimal_v2_tool_call("tc_none_v2", "turn_tc_none_v2");
    db::insert_tool_call(&conn, &tc).expect("Must insert tool call with None v2 fields");

    let tool_calls = db::get_tool_calls_for_turn(&conn, "turn_tc_none_v2").unwrap();
    assert_eq!(tool_calls.len(), 1);
    let tc_read = &tool_calls[0];
    assert!(
        tc_read.sequence_num.is_none(),
        "sequence_num None must round-trip as None"
    );
    assert!(
        tc_read.output.is_none(),
        "output None must round-trip as None"
    );
    assert!(
        tc_read.output_hash.is_none(),
        "output_hash None must round-trip as None"
    );
    assert!(
        tc_read.duration_ms.is_none(),
        "duration_ms None must round-trip as None"
    );
    assert!(
        tc_read.error.is_none(),
        "error None must round-trip as None"
    );
    assert!(
        tc_read.status.is_none(),
        "status None must round-trip as None"
    );
}

/// **Proves:** A Gemini event where candidates[0].content.parts contains an unknown
/// part type records a parse error (not a panic).
/// **Anti-fake:** A parser with exhaustive part matching would fail on unknown types.
#[test]
fn gemini_parser_records_parse_error_on_unknown_part_type() {
    let events = vec![evt(
        "message",
        r#"{"candidates":[{"content":{"parts":[{"text":"known"},{"videoData":{"url":"http://example.com"}}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3,"totalTokenCount":8},"modelVersion":"gemini-1.5-pro"}"#,
    )];
    let result = google::parse_response(&events);
    assert!(
        result.is_ok(),
        "Unknown part type must not cause a fatal error"
    );
    let parsed = result.unwrap();
    assert_eq!(
        parsed.response_text, "known",
        "Known text parts must still be extracted"
    );
    // parse_errors should contain something about the unknown part
    assert!(
        parsed.parse_errors.is_some(),
        "Unknown part type must be recorded in parse_errors"
    );
    let errors = parsed.parse_errors.unwrap();
    assert!(
        !errors.is_empty(),
        "parse_errors must contain at least one error for unknown part type"
    );
}

/// **Proves:** SESSION_COLUMNS includes the v2 fields so that list_sessions
/// and get_session return them.
/// **Anti-fake:** If SESSION_COLUMNS is not updated, the v2 fields would be missing
/// from query results (None even when populated in the DB).
#[test]
fn session_columns_includes_v2_fields() {
    let conn = setup_db();
    let session = full_v2_session("sess_cols_v2");
    db::insert_session(&conn, &session).unwrap();

    // Use list_sessions (which uses SESSION_COLUMNS) and verify v2 fields came back
    let sessions = db::list_sessions(&conn, Some(10)).unwrap();
    let s = &sessions[0];

    // If SESSION_COLUMNS didn't include these, they'd all be None
    assert!(
        s.agent_id.is_some(),
        "SESSION_COLUMNS must include agent_id for it to be read back"
    );
    assert!(
        s.tags.is_some(),
        "SESSION_COLUMNS must include tags for it to be read back"
    );
}

/// **Proves:** TURN_COLUMNS includes the v2 fields so that get_turns_for_session
/// and get_turn return them.
/// **Anti-fake:** If TURN_COLUMNS is not updated, the v2 fields would be missing.
#[test]
fn turn_columns_includes_v2_fields() {
    let conn = setup_db();
    let session = full_v2_session("sess_tcols_v2");
    db::insert_session(&conn, &session).unwrap();
    let turn = full_v2_turn("turn_cols_v2", "sess_tcols_v2", 1);
    db::insert_turn(&conn, &turn).unwrap();

    // Use get_turn (which uses TURN_COLUMNS) and verify v2 fields came back
    let t = db::get_turn(&conn, "turn_cols_v2").unwrap().unwrap();

    // If TURN_COLUMNS didn't include these, they'd all be None/0
    assert!(
        t.duration_ms.is_some(),
        "TURN_COLUMNS must include duration_ms for it to be read back"
    );
    assert!(
        t.server_id.is_some(),
        "TURN_COLUMNS must include server_id for it to be read back"
    );
    assert_eq!(
        t.tool_call_count, 2,
        "TURN_COLUMNS must include tool_call_count for it to be read back"
    );
}

/// **Proves:** Gemini parser produces a ParsedResponse that is the same struct type
/// as the Anthropic parser's output — ensuring type-level compatibility.
/// **Anti-fake:** If google::parse_response returned a different struct type,
/// assigning to ParsedResponse would fail to compile.
#[test]
fn gemini_parser_returns_same_parsed_response_type_as_anthropic() {
    let events = gemini_text_events();
    let parsed: ParsedResponse = google::parse_response(&events).unwrap();
    // Type assertion: this line compiles only if google::parse_response
    // returns the same ParsedResponse type used by the Anthropic parser.
    assert!(!parsed.response_text.is_empty());
}

/// **Proves:** Gemini parser tool calls use the same ToolCall type as Anthropic parser.
/// **Anti-fake:** A different ToolCall struct would fail the type annotation.
#[test]
fn gemini_parser_tool_calls_are_same_type_as_anthropic() {
    let events = gemini_tool_call_events();
    let parsed = google::parse_response(&events).unwrap();
    let _tool_calls: &Vec<ToolCall> = &parsed.tool_calls;
    assert_eq!(_tool_calls.len(), 1);
}

/// **Proves:** Gemini parser handles a response with only usageMetadata and no candidates
/// (e.g., a billing-only event sometimes sent at end of stream).
/// **Anti-fake:** A parser that requires candidates in every event would fail.
#[test]
fn gemini_parser_handles_usage_only_event() {
    let events = vec![
        evt(
            "message",
            r#"{"candidates":[{"content":{"parts":[{"text":"hello"}],"role":"model"},"finishReason":"STOP","index":0}],"modelVersion":"gemini-1.5-pro"}"#,
        ),
        evt(
            "message",
            r#"{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}"#,
        ),
    ];
    let result = google::parse_response(&events);
    assert!(
        result.is_ok(),
        "Usage-only event at end of stream must not cause error"
    );
    let parsed = result.unwrap();
    assert_eq!(parsed.response_text, "hello");
    assert_eq!(parsed.input_tokens, 10);
    assert_eq!(parsed.output_tokens, 5);
}
