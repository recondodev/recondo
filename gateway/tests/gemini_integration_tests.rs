//! Integration test: process_capture_with_pipeline with provider="google" and Gemini SSE bytes.
//!
//! Verifies the full production path: raw Gemini SSE response bytes flow through
//! the capture pipeline and produce a graph-store turn record with parsed fields populated.

use recondo_gateway::gateway;
use recondo_gateway::session::SessionManager;

mod common;
use common::pipeline::make_pipeline;

/// Build raw SSE bytes from a list of (event_type, data) pairs.
fn build_sse_bytes(events: &[(&str, &str)]) -> Vec<u8> {
    let mut buf = String::new();
    for (event_type, data) in events {
        buf.push_str(&format!("event: {}\ndata: {}\n\n", event_type, data));
    }
    buf.into_bytes()
}

/// A minimal Gemini SSE response with text, stop reason, and usage metadata.
fn sample_gemini_sse_response() -> Vec<u8> {
    build_sse_bytes(&[(
        "message",
        r#"{"candidates":[{"content":{"parts":[{"text":"Hello from Gemini!"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":8,"totalTokenCount":20},"modelVersion":"gemini-1.5-pro"}"#,
    )])
}

/// A minimal request body (Gemini request format).
fn sample_gemini_request() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "contents": [
            {"parts": [{"text": "Say hello"}]}
        ]
    }))
    .unwrap()
}

/// A Gemini SSE response with a tool call (functionCall).
fn sample_gemini_tool_call_response() -> Vec<u8> {
    build_sse_bytes(&[(
        "message",
        r#"{"candidates":[{"content":{"parts":[{"text":"Let me check."},{"functionCall":{"name":"get_weather","args":{"location":"NYC"}}}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":15,"candidatesTokenCount":10,"totalTokenCount":25},"modelVersion":"gemini-1.5-flash"}"#,
    )])
}

/// **Proves:** process_capture_with_pipeline with provider="google" correctly parses
/// Gemini SSE response bytes and populates the graph-store turn record with model,
/// response_text, stop_reason, input_tokens, output_tokens, and parser_version.
///
/// **Anti-fake:** Without the "google" match arm in the capture pipeline, the turn
/// would have model=None, response_text=None, tokens=0 -- all assertions fail.
#[test]
fn process_capture_gemini_parses_text_response() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let request_bytes = sample_gemini_request();
    let response_bytes = sample_gemini_sse_response();

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "google",
        &request_bytes,
        &response_bytes,
        None, // no WAL
        None, // no metrics registry
    )
    .expect("process_capture_with_pipeline must succeed for Gemini");

    // Verify parsed fields from Gemini response
    assert_eq!(
        turn.model.as_deref(),
        Some("gemini-1.5-pro"),
        "Model must be extracted from Gemini response"
    );
    assert_eq!(
        turn.response_text.as_deref(),
        Some("Hello from Gemini!"),
        "Response text must be extracted from Gemini candidates"
    );
    assert_eq!(
        turn.stop_reason, "end_turn",
        "STOP must be mapped to end_turn"
    );
    assert_eq!(turn.input_tokens, 12, "Input tokens must be parsed");
    assert_eq!(turn.output_tokens, 8, "Output tokens must be parsed");
    assert_eq!(
        turn.provider.as_deref(),
        Some("google"),
        "Provider must be google"
    );
    assert!(
        turn.parser_version.is_some(),
        "Parser version must be set for Gemini"
    );

    // Verify graph-store round-trip
    let db_turn = pipeline.graph().get_turn(&turn.id).unwrap().unwrap();
    assert_eq!(db_turn.model.as_deref(), Some("gemini-1.5-pro"));
    assert_eq!(db_turn.response_text.as_deref(), Some("Hello from Gemini!"));
    assert_eq!(db_turn.stop_reason, "end_turn");
    assert_eq!(db_turn.input_tokens, 12);
    assert_eq!(db_turn.output_tokens, 8);
}

/// **Proves:** process_capture_with_pipeline with provider="google" correctly counts
/// tool calls and sets tool_call_count to a non-zero value when tool calls are present.
///
/// **Anti-fake:** Without the Gemini match arm and tool_call_count fix,
/// tool_call_count would be 0.
#[test]
fn process_capture_gemini_counts_tool_calls() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let request_bytes = sample_gemini_request();
    let response_bytes = sample_gemini_tool_call_response();

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "google",
        &request_bytes,
        &response_bytes,
        None,
        None, // no metrics registry
    )
    .expect("process_capture_with_pipeline must succeed for Gemini tool call");

    assert_eq!(
        turn.tool_call_count, 1,
        "tool_call_count must reflect the actual number of tool calls"
    );
    assert_eq!(
        turn.response_text.as_deref(),
        Some("Let me check."),
        "Text parts must still be extracted alongside tool calls"
    );
    assert_eq!(
        turn.model.as_deref(),
        Some("gemini-1.5-flash"),
        "Model must be extracted"
    );

    // Verify tool calls in graph store
    let tool_calls = pipeline.graph().get_tool_calls_for_turn(&turn.id).unwrap();
    assert_eq!(tool_calls.len(), 1, "Must have 1 tool call in graph store");
    assert_eq!(tool_calls[0].tool_name, "get_weather");
}

/// **Proves:** process_capture_with_pipeline with provider="google" stores raw_extra
/// for unknown Gemini fields and sets parser_version.
#[test]
fn process_capture_gemini_preserves_raw_extra_and_parser_version() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    // Include an unknown field "serverTiming" that should end up in raw_extra
    let response_bytes = build_sse_bytes(&[(
        "message",
        r#"{"candidates":[{"content":{"parts":[{"text":"Hi"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3,"totalTokenCount":8},"modelVersion":"gemini-1.5-pro","serverTiming":{"latencyMs":42}}"#,
    )]);
    let request_bytes = sample_gemini_request();

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "google",
        &request_bytes,
        &response_bytes,
        None,
        None, // no metrics registry
    )
    .expect("process_capture_with_pipeline must succeed");

    // raw_extra should contain the unknown "serverTiming" field
    assert!(
        turn.raw_extra.is_some(),
        "raw_extra must be populated for unknown Gemini fields"
    );
    let raw_extra = turn.raw_extra.as_ref().unwrap();
    assert!(
        raw_extra.contains("serverTiming"),
        "raw_extra must contain the unknown serverTiming field"
    );

    // parser_version must be set
    assert!(
        turn.parser_version.is_some(),
        "parser_version must be set for Gemini"
    );
    assert_eq!(turn.parser_version.as_deref(), Some("0.1.0"));
}
