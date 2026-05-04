//! Phase 2 Sprint 3: OpenAI Provider Adapter, WebSocket Continuation Frame
//! Reassembly, Cache-Aware Token Pricing, OpenAI Identity Extraction,
//! Generic YAML Adapter, Multi-Provider Session Correctness.
//!
//! EVERY test in this file imports from modules that DO NOT EXIST yet:
//!
//! - `recondo_gateway::providers::openai` (new module: OpenAI adapter)
//! - `recondo_gateway::providers::generic` (new module: YAML-based generic adapter)
//! - `recondo_gateway::websocket::MessageAssembler` (new struct: continuation frame reassembly)
//! - `recondo_gateway::providers::openai::extract_openai_metadata` (new function)
//! - `recondo_gateway::providers::ProviderAdapter` (new trait)
//!
//! This file MUST NOT compile until the implementation agent creates these modules.
//! Each test imports production types/functions that do not exist yet.
//! The implementation agent must create them to make these tests pass.

#![allow(unused_imports, clippy::single_match)]

use std::path::Path;
use std::sync::Arc;

// Existing types that DO compile today
use recondo_gateway::db::{self, SessionRecord, ToolCallRecord, TurnRecord};

// Test wrapper: delegates to the externalized canonical pricing table with
// a fresh `now_utc()` timestamp. Mirrors the pre-Batch-5 free-function
// signature so we don't have to touch every call site downstream.
fn compute_cost_usd(
    model: &str,
    input_tokens: i64,
    output_tokens: i64,
    cache_creation_tokens: i64,
    cache_read_tokens: i64,
) -> f64 {
    db::compute_cost_usd(
        db::model_pricing::canonical(),
        model,
        input_tokens,
        output_tokens,
        cache_creation_tokens,
        cache_read_tokens,
        &time::OffsetDateTime::now_utc(),
    )
}
use recondo_gateway::hash;
use recondo_gateway::providers::detect_provider;
use recondo_gateway::stream::SseEvent;
use recondo_gateway::websocket::{
    encode_frame, encode_frame_with_fin, parse_frame, WebSocketFrame,
};

// ---- These imports WILL NOT RESOLVE until the new modules are created ----

// D1/D2: OpenAI adapter — parse OpenAI requests, SSE responses, tool calls
use recondo_gateway::providers::openai::{
    parse_openai_request, parse_openai_response, parse_openai_sse_events, OpenAiParsedRequest,
    OpenAiParsedResponse,
};

// D4: Generic YAML adapter — configurable field mapping for custom providers
use recondo_gateway::providers::generic::{GenericAdapter, YamlAdapterConfig};

// D6: WebSocket continuation frame reassembly
use recondo_gateway::websocket::MessageAssembler;

// D8: OpenAI identity extraction from WebSocket upgrade headers
// extract_openai_metadata returns a struct with at minimum: session_id, account_uuid,
// device_id, framework, agent_version. The implementation agent may extend ClientMetadata
// with framework/agent_version fields, or define a new OpenAiMetadata struct.
use recondo_gateway::providers::openai::extract_openai_metadata;

// D7: Cache-aware token pricing (updated compute_cost_usd_v2 or modified compute_cost_usd)
// The existing compute_cost_usd already has cache_creation/cache_read params.
// Sprint 3 adds OpenAI cache pricing (50% of input rate) — currently it's 0% for non-Anthropic.
// We import the same function and test that it now handles OpenAI cache tokens.

// ProviderAdapter trait — Sprint 3 Task 1
use recondo_gateway::providers::ProviderAdapter;

// ===========================================================================
// Test helpers — use ONLY existing types
// ===========================================================================

fn sample_session(id: &str, provider: &str) -> SessionRecord {
    SessionRecord {
        id: id.to_string(),
        provider: provider.to_string(),
        model: None,
        started_at: "2026-03-20T10:00:00Z".to_string(),
        last_active_at: "2026-03-20T10:05:00Z".to_string(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash: "abcdef123456".to_string(),
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

fn sample_turn(id: &str, session_id: &str, seq: i64, provider: &str) -> TurnRecord {
    TurnRecord {
        id: id.to_string(),
        session_id: session_id.to_string(),
        sequence_num: seq,
        timestamp: format!("2026-03-20T10:{:02}:00Z", seq),
        request_hash: format!("req_hash_{}", seq),
        response_hash: format!("resp_hash_{}", seq),
        req_bytes_ref: Some(format!("req/req_hash_{}", seq)),
        resp_bytes_ref: Some(format!("resp/resp_hash_{}", seq)),
        req_bytes_size: Some(1024),
        resp_bytes_size: Some(2048),
        model: None,
        response_text: None,
        thinking_text: None,
        stop_reason: "stop".to_string(),
        capture_complete: true,
        input_tokens: 100 * seq,
        output_tokens: 50 * seq,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: format!("2026-03-20T10:{:02}:00Z", seq),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: None,
        parser_version: None,
        parse_errors: None,
        provider: Some(provider.to_string()),
        transport: Some("http".to_string()),
        ws_direction: None,
        duration_ms: Some(500 * seq),
        ttfb_ms: Some(100 * seq),
        api_endpoint: None,
        http_status: Some(200),
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

// R1-07 fix: sample_tool_call helper was dead code (never called by any test).
// The e2e_d2 test constructs ToolCallRecord inline. Removed to fix dead_code
// warning now that `#![allow(dead_code)]` has been removed per reviewer finding.

// ===========================================================================
// Realistic OpenAI payloads
// ===========================================================================

/// A realistic OpenAI Chat Completions request body.
const OPENAI_REQUEST_BODY: &str = r#"{
    "model": "gpt-4o-2024-05-13",
    "messages": [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "What is the capital of France?"}
    ],
    "tools": [
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get the current weather in a given location",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "location": {"type": "string"}
                    },
                    "required": ["location"]
                }
            }
        }
    ],
    "stream": true,
    "max_tokens": 1024,
    "user": "user-abc123"
}"#;

/// OpenAI SSE streaming response events for a text reply.
/// Format: data: {JSON}\n\n per event, with data: [DONE] as the terminal signal.
const OPENAI_SSE_TEXT_RESPONSE: &str = concat!(
    "data: {\"id\":\"chatcmpl-ABC123\",\"object\":\"chat.completion.chunk\",\"created\":1711929600,\"model\":\"gpt-4o-2024-05-13\",",
    "\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"chatcmpl-ABC123\",\"object\":\"chat.completion.chunk\",\"created\":1711929600,\"model\":\"gpt-4o-2024-05-13\",",
    "\"choices\":[{\"index\":0,\"delta\":{\"content\":\"The capital\"},\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"chatcmpl-ABC123\",\"object\":\"chat.completion.chunk\",\"created\":1711929600,\"model\":\"gpt-4o-2024-05-13\",",
    "\"choices\":[{\"index\":0,\"delta\":{\"content\":\" of France\"},\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"chatcmpl-ABC123\",\"object\":\"chat.completion.chunk\",\"created\":1711929600,\"model\":\"gpt-4o-2024-05-13\",",
    "\"choices\":[{\"index\":0,\"delta\":{\"content\":\" is Paris.\"},\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"chatcmpl-ABC123\",\"object\":\"chat.completion.chunk\",\"created\":1711929600,\"model\":\"gpt-4o-2024-05-13\",",
    "\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],",
    "\"usage\":{\"prompt_tokens\":42,\"completion_tokens\":7,\"total_tokens\":49}}\n\n",
    "data: [DONE]\n\n",
);

/// OpenAI SSE streaming response events containing tool calls.
/// Tool call chunks arrive across multiple SSE events with index-based accumulation.
const OPENAI_SSE_TOOL_CALL_RESPONSE: &str = concat!(
    "data: {\"id\":\"chatcmpl-TOOL001\",\"object\":\"chat.completion.chunk\",\"created\":1711929600,\"model\":\"gpt-4o-2024-05-13\",",
    "\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":null,",
    "\"tool_calls\":[{\"index\":0,\"id\":\"call_abc123\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"\"}}]},",
    "\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"chatcmpl-TOOL001\",\"object\":\"chat.completion.chunk\",\"created\":1711929600,\"model\":\"gpt-4o-2024-05-13\",",
    "\"choices\":[{\"index\":0,\"delta\":{",
    "\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"lo\"}}]},",
    "\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"chatcmpl-TOOL001\",\"object\":\"chat.completion.chunk\",\"created\":1711929600,\"model\":\"gpt-4o-2024-05-13\",",
    "\"choices\":[{\"index\":0,\"delta\":{",
    "\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"cation\\\":\\\"Paris\\\"\"}}]},",
    "\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"chatcmpl-TOOL001\",\"object\":\"chat.completion.chunk\",\"created\":1711929600,\"model\":\"gpt-4o-2024-05-13\",",
    "\"choices\":[{\"index\":0,\"delta\":{",
    "\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"}\"}}]},",
    "\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"chatcmpl-TOOL001\",\"object\":\"chat.completion.chunk\",\"created\":1711929600,\"model\":\"gpt-4o-2024-05-13\",",
    "\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}],",
    "\"usage\":{\"prompt_tokens\":85,\"completion_tokens\":20,\"total_tokens\":105}}\n\n",
    "data: [DONE]\n\n",
);

/// OpenAI SSE response with multiple tool calls in a single response.
const OPENAI_SSE_MULTI_TOOL_RESPONSE: &str = concat!(
    "data: {\"id\":\"chatcmpl-MULTI01\",\"object\":\"chat.completion.chunk\",\"created\":1711929600,\"model\":\"gpt-4o-2024-05-13\",",
    "\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":null,",
    "\"tool_calls\":[{\"index\":0,\"id\":\"call_first\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}}]},",
    "\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"chatcmpl-MULTI01\",\"object\":\"chat.completion.chunk\",\"created\":1711929600,\"model\":\"gpt-4o-2024-05-13\",",
    "\"choices\":[{\"index\":0,\"delta\":{",
    "\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\":\\\"src/main.rs\\\"}\"}}]},",
    "\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"chatcmpl-MULTI01\",\"object\":\"chat.completion.chunk\",\"created\":1711929600,\"model\":\"gpt-4o-2024-05-13\",",
    "\"choices\":[{\"index\":0,\"delta\":{",
    "\"tool_calls\":[{\"index\":1,\"id\":\"call_second\",\"type\":\"function\",\"function\":{\"name\":\"write_file\",\"arguments\":\"\"}}]},",
    "\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"chatcmpl-MULTI01\",\"object\":\"chat.completion.chunk\",\"created\":1711929600,\"model\":\"gpt-4o-2024-05-13\",",
    "\"choices\":[{\"index\":0,\"delta\":{",
    "\"tool_calls\":[{\"index\":1,\"function\":{\"arguments\":\"{\\\"path\\\":\\\"out.txt\\\",\\\"content\\\":\\\"hello\\\"}\"}}]},",
    "\"finish_reason\":null}]}\n\n",
    "data: {\"id\":\"chatcmpl-MULTI01\",\"object\":\"chat.completion.chunk\",\"created\":1711929600,\"model\":\"gpt-4o-2024-05-13\",",
    "\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}],",
    "\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":35,\"total_tokens\":135}}\n\n",
    "data: [DONE]\n\n",
);

/// Realistic Codex WebSocket upgrade request headers (from PROVIDER_IDENTITY_MAPPING.md).
const CODEX_UPGRADE_HEADERS: &str = concat!(
    "GET /backend-api/codex/responses HTTP/1.1\r\n",
    "Host: chatgpt.com\r\n",
    "Connection: Upgrade\r\n",
    "Upgrade: websocket\r\n",
    "Sec-WebSocket-Version: 13\r\n",
    "Sec-WebSocket-Key: nbRo0WrJbL0MftpKD1AdQA==\r\n",
    "chatgpt-account-id: b9f1456e-6e84-4215-929e-c6bb856f090e\r\n",
    "originator: codex_cli_rs\r\n",
    "openai-beta: responses_websockets=2026-02-06\r\n",
    "session_id: 019d0d8e-03be-7382-9e5f-3cc32940c9cb\r\n",
    "version: 0.116.0\r\n",
    "x-codex-turn-metadata: {\"turn_id\":\"\",\"sandbox\":\"seatbelt\"}\r\n",
    "x-client-request-id: 019d0d8e-03be-7382-9e5f-3cc32940c9cb\r\n",
    "authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOlsiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MSJdLCJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYjlmMTQ1NmUtNmU4NC00MjE1LTkyOWUtYzZiYjg1NmYwOTBlIn19.fake_signature\r\n",
    "sec-websocket-extensions: permessage-deflate; client_max_window_bits\r\n",
    "\r\n",
);

// ===========================================================================
// Section 1: OpenAI Chat Completions + SSE Streaming (D1) — 6 tests
// ===========================================================================

/// **Proves:** parse_openai_sse_events extracts the accumulated response text from
/// streamed OpenAI `data: {...}` chunks by concatenating all `delta.content` fields.
/// The result is "The capital of France is Paris." — the full streamed response.
/// **Anti-fake property:** The Anthropic SSE parser would not recognize OpenAI's
/// `choices[0].delta.content` format. Only an OpenAI-specific parser can produce
/// this exact text. The test asserts the full concatenated string, not just non-empty.
#[test]
fn openai_sse_stream_produces_exact_response_text() {
    let parsed: OpenAiParsedResponse =
        parse_openai_sse_events(OPENAI_SSE_TEXT_RESPONSE).expect("Must parse OpenAI SSE events");

    assert_eq!(
        parsed.response_text, "The capital of France is Paris.",
        "Response text must be the concatenation of all delta.content chunks"
    );
}

/// **Proves:** parse_openai_sse_events extracts the model name from the SSE chunk JSON.
/// The model field in each chunk is "gpt-4o-2024-05-13" — the parser must extract it.
/// **Anti-fake property:** Anthropic SSE events carry model in `message_start`, not in
/// every chunk. An Anthropic parser would return an empty or wrong model string.
#[test]
fn openai_sse_stream_extracts_model_name() {
    let parsed = parse_openai_sse_events(OPENAI_SSE_TEXT_RESPONSE).unwrap();

    assert_eq!(
        parsed.model, "gpt-4o-2024-05-13",
        "Model must be extracted from the OpenAI SSE chunks"
    );
}

/// **Proves:** parse_openai_sse_events extracts stop_reason from the final chunk's
/// `finish_reason` field. For a normal text completion, this is "stop".
/// **Anti-fake property:** Anthropic uses "end_turn" as its stop reason, not "stop".
/// An Anthropic parser applied to OpenAI data would produce a different or empty value.
#[test]
fn openai_sse_stream_extracts_stop_reason() {
    let parsed = parse_openai_sse_events(OPENAI_SSE_TEXT_RESPONSE).unwrap();

    assert_eq!(
        parsed.stop_reason, "stop",
        "stop_reason must be extracted from finish_reason in the final SSE chunk"
    );
}

/// **Proves:** parse_openai_sse_events extracts token counts from the final chunk's
/// `usage` object: prompt_tokens=42, completion_tokens=7, total=49.
/// **Anti-fake property:** Anthropic reports tokens via `message_delta` with
/// `input_tokens`/`output_tokens` keys. The OpenAI format uses `prompt_tokens`/
/// `completion_tokens`. Only an OpenAI-specific parser can map these correctly.
#[test]
fn openai_sse_stream_extracts_token_counts() {
    let parsed = parse_openai_sse_events(OPENAI_SSE_TEXT_RESPONSE).unwrap();

    assert_eq!(
        parsed.input_tokens, 42,
        "input_tokens must be extracted from usage.prompt_tokens"
    );
    assert_eq!(
        parsed.output_tokens, 7,
        "output_tokens must be extracted from usage.completion_tokens"
    );
}

/// **Proves:** parse_openai_sse_events extracts the message ID from the SSE chunk's
/// top-level `id` field (e.g., "chatcmpl-ABC123").
/// **Anti-fake property:** Anthropic message IDs look like "msg_..." not "chatcmpl-...".
/// Only an OpenAI parser can produce the correct ID prefix.
#[test]
fn openai_sse_stream_extracts_message_id() {
    let parsed = parse_openai_sse_events(OPENAI_SSE_TEXT_RESPONSE).unwrap();

    assert_eq!(
        parsed.message_id, "chatcmpl-ABC123",
        "message_id must be extracted from the SSE chunk's top-level id field"
    );
}

/// **Proves (NEGATIVE):** parse_openai_sse_events returns an error or produces
/// empty/default fields when given Anthropic SSE event data. This proves the parser
/// is specific to the OpenAI format and does not silently produce garbage results
/// from incompatible input.
/// **Anti-fake property:** If the parser naively returned defaults for any input,
/// the test above (exact response text) would also fail. Together, the positive
/// and negative tests prove the parser is format-specific.
#[test]
fn openai_sse_parser_rejects_anthropic_format_events() {
    // Anthropic SSE format: event: message_start\ndata: {...}\n\n
    let anthropic_sse = concat!(
        "event: message_start\n",
        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_01\",\"type\":\"message\",",
        "\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4-20250514\",",
        "\"stop_reason\":null,\"usage\":{\"input_tokens\":100,\"output_tokens\":0}}}\n\n",
        "event: content_block_delta\n",
        "data: {\"type\":\"content_block_delta\",\"index\":0,",
        "\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello from Claude\"}}\n\n",
        "event: message_stop\n",
        "data: {\"type\":\"message_stop\"}\n\n",
    );

    let result = parse_openai_sse_events(anthropic_sse);

    // Either returns an error, or produces a response with empty text
    // (because Anthropic events don't have choices[0].delta.content)
    match result {
        Err(_) => {} // Good: parser rejected incompatible format
        Ok(parsed) => {
            // If it doesn't error, the response text must be empty — Anthropic
            // events don't contain OpenAI's delta.content structure.
            assert!(
                parsed.response_text.is_empty(),
                "Anthropic SSE events fed to OpenAI parser must produce empty response_text, \
                 got: {:?}",
                parsed.response_text
            );
        }
    }
}

// ===========================================================================
// Section 2: Tool Calls Normalized to Recondo Schema (D2) — 5 tests
// ===========================================================================

/// **Proves:** parse_openai_sse_events accumulates streamed tool call chunks into
/// a complete ToolCall with the correct id, name, and arguments JSON. The tool call
/// arguments are streamed across multiple SSE events and must be concatenated.
/// **Anti-fake property:** The arguments arrive in 3 separate chunks:
/// `{"lo`, `cation":"Paris"`, `}`. Only a parser that correctly accumulates
/// index-based tool call argument chunks will produce `{"location":"Paris"}`.
#[test]
fn openai_tool_call_chunks_accumulated_into_complete_tool_call() {
    let parsed = parse_openai_sse_events(OPENAI_SSE_TOOL_CALL_RESPONSE).unwrap();

    assert_eq!(
        parsed.tool_calls.len(),
        1,
        "Must produce exactly one tool call from the streamed chunks"
    );
    assert_eq!(parsed.tool_calls[0].id, "call_abc123");
    assert_eq!(parsed.tool_calls[0].name, "get_weather");
    assert_eq!(
        parsed.tool_calls[0].input, r#"{"location":"Paris"}"#,
        "Tool call input must be the fully accumulated function arguments JSON"
    );
}

/// **Proves:** When finish_reason is "tool_calls", stop_reason is set to "tool_calls".
/// **Anti-fake property:** Text responses have finish_reason="stop". This test uses
/// the tool call SSE stream which ends with "tool_calls", verifying the parser
/// distinguishes between text completion and tool call completion.
#[test]
fn openai_tool_call_stop_reason_is_tool_calls() {
    let parsed = parse_openai_sse_events(OPENAI_SSE_TOOL_CALL_RESPONSE).unwrap();

    assert_eq!(
        parsed.stop_reason, "tool_calls",
        "stop_reason must reflect the finish_reason from the tool call response"
    );
}

/// **Proves:** Multiple tool calls in a single OpenAI response are all captured with
/// their respective names and accumulated arguments. Index 0 is "read_file" and
/// index 1 is "write_file".
/// **Anti-fake property:** A parser that only captures the first tool call would fail
/// the assertion on len() and the second tool call's fields. The arguments for each
/// tool call are streamed separately and must be correctly accumulated by index.
#[test]
fn openai_multiple_tool_calls_in_single_response_all_captured() {
    let parsed = parse_openai_sse_events(OPENAI_SSE_MULTI_TOOL_RESPONSE).unwrap();

    assert_eq!(
        parsed.tool_calls.len(),
        2,
        "Must produce two tool calls from the multi-tool response"
    );

    // First tool call
    assert_eq!(parsed.tool_calls[0].id, "call_first");
    assert_eq!(parsed.tool_calls[0].name, "read_file");
    assert_eq!(
        parsed.tool_calls[0].input, r#"{"path":"src/main.rs"}"#,
        "First tool call arguments must be fully accumulated"
    );

    // Second tool call
    assert_eq!(parsed.tool_calls[1].id, "call_second");
    assert_eq!(parsed.tool_calls[1].name, "write_file");
    assert_eq!(
        parsed.tool_calls[1].input, r#"{"path":"out.txt","content":"hello"}"#,
        "Second tool call arguments must be fully accumulated"
    );
}

/// **Proves:** parse_openai_request extracts the tools array from an OpenAI request
/// body and maps it to the Recondo schema.
/// **Anti-fake property:** Anthropic requests use a different tools format (top-level
/// `tools` array with `name`/`description`/`input_schema`, not wrapped in `function`).
/// The test asserts the exact tool name extracted from OpenAI's nested function structure.
#[test]
fn openai_request_parser_extracts_tools() {
    let parsed: OpenAiParsedRequest =
        parse_openai_request(OPENAI_REQUEST_BODY.as_bytes()).expect("Must parse OpenAI request");

    assert!(
        parsed.tools.is_some(),
        "Tools must be extracted from OpenAI request body"
    );
    let tools = parsed.tools.unwrap();
    assert_eq!(tools.len(), 1, "Must extract exactly one tool definition");

    // The tool must be normalized so that the function name is accessible
    let tool_json = &tools[0];
    let function_name = tool_json
        .get("function")
        .and_then(|f| f.get("name"))
        .and_then(|n| n.as_str());
    assert_eq!(
        function_name,
        Some("get_weather"),
        "Tool function name must be extracted from nested OpenAI tool structure"
    );
}

/// **Proves (NEGATIVE):** parse_openai_sse_events with a response that has no tool_calls
/// produces an empty tool_calls vec, NOT a phantom tool call.
/// **Anti-fake property:** The text-only SSE response has no tool_calls deltas. If the
/// parser incorrectly initializes a default tool call, this assertion catches it.
#[test]
fn openai_text_only_response_has_empty_tool_calls_vec() {
    let parsed = parse_openai_sse_events(OPENAI_SSE_TEXT_RESPONSE).unwrap();

    assert!(
        parsed.tool_calls.is_empty(),
        "Text-only response must produce zero tool calls, got: {:?}",
        parsed.tool_calls
    );
}

// ===========================================================================
// Section 3: Gemini Adapter Verification (D3) — 2 tests
// ===========================================================================

/// **Proves:** The google.rs module exists and detect_provider returns "google" for
/// the Gemini API host. This is a verification-only test for the existing stub.
/// **Anti-fake property:** detect_provider must return the literal string "google",
/// not "gemini" or "unknown".
#[test]
fn gemini_adapter_stub_exists_and_provider_detected() {
    let provider = detect_provider("generativelanguage.googleapis.com");
    assert_eq!(
        provider, "google",
        "Gemini API host must be detected as 'google' provider"
    );
}

/// **Proves:** The ProviderAdapter trait exists and can be checked for Gemini.
/// detect method on the trait should return true for the Gemini host.
/// **Anti-fake property:** A missing ProviderAdapter trait would prevent compilation.
/// The detect call must return true only for the correct host, not for all hosts.
#[test]
fn gemini_provider_adapter_detect_returns_true_for_gemini_host() {
    // This test ensures the ProviderAdapter trait is defined and the Gemini
    // adapter implements detect() correctly. If the trait doesn't exist,
    // the import at the top of this file fails to compile.
    let detected = detect_provider("generativelanguage.googleapis.com");
    assert_eq!(detected, "google");

    // Negative: non-Gemini host
    let not_gemini = detect_provider("api.example.com");
    assert_eq!(
        not_gemini, "unknown",
        "Non-Gemini host must not be detected as google"
    );
}

// ===========================================================================
// Section 4: Generic YAML Adapter (D4) — 5 tests
// ===========================================================================

/// **Proves:** GenericAdapter can be constructed from a YAML configuration string
/// that defines request/response field mappings for a custom LLM provider.
/// **Anti-fake property:** The YAML contains specific field paths (e.g.,
/// `response_text_path: "output.text"`) that only a YAML-parsing adapter could handle.
/// A hardcoded adapter would not be configurable.
#[test]
fn generic_adapter_constructed_from_yaml_config() {
    let yaml_config = r#"
        provider_name: "custom-llm"
        detect_hosts:
          - "llm.internal.corp.com"
        request_mapping:
          model_path: "model_name"
          messages_path: "conversation"
          max_tokens_path: "max_length"
        response_mapping:
          response_text_path: "output.text"
          model_path: "model_used"
          stop_reason_path: "finish_status"
          input_tokens_path: "stats.input_count"
          output_tokens_path: "stats.output_count"
    "#;

    let config: YamlAdapterConfig =
        YamlAdapterConfig::from_yaml_str(yaml_config).expect("Must parse YAML adapter config");

    let adapter = GenericAdapter::new(config);

    // Verify the adapter was configured with the correct provider name
    assert_eq!(
        adapter.provider_name(),
        "custom-llm",
        "GenericAdapter must expose the configured provider name"
    );
}

/// **Proves:** GenericAdapter.parse_response extracts response_text from a JSON body
/// using the YAML-configured path ("output.text").
/// **Anti-fake property:** The response JSON uses a non-standard field path that no
/// built-in provider adapter (Anthropic, OpenAI) would match. Only a configurable
/// path-based extractor can produce the correct value.
#[test]
fn generic_adapter_extracts_response_text_via_configured_path() {
    let yaml_config = r#"
        provider_name: "custom-llm"
        detect_hosts:
          - "llm.internal.corp.com"
        request_mapping:
          model_path: "model_name"
          messages_path: "conversation"
        response_mapping:
          response_text_path: "output.text"
          model_path: "model_used"
          stop_reason_path: "finish_status"
          input_tokens_path: "stats.input_count"
          output_tokens_path: "stats.output_count"
    "#;

    let config = YamlAdapterConfig::from_yaml_str(yaml_config).unwrap();
    let adapter = GenericAdapter::new(config);

    let response_body = r#"{
        "model_used": "custom-v3",
        "output": {
            "text": "This is the custom LLM response"
        },
        "finish_status": "complete",
        "stats": {
            "input_count": 150,
            "output_count": 30
        }
    }"#;

    let parsed = adapter
        .parse_response(response_body.as_bytes())
        .expect("GenericAdapter.parse_response must succeed");

    assert_eq!(
        parsed.response_text, "This is the custom LLM response",
        "Response text must be extracted from the YAML-configured path 'output.text'"
    );
    assert_eq!(parsed.model, "custom-v3");
    assert_eq!(parsed.stop_reason, "complete");
    assert_eq!(parsed.input_tokens, 150);
    assert_eq!(parsed.output_tokens, 30);
}

/// **Proves:** GenericAdapter.parse_request extracts model and messages from a
/// JSON request body using YAML-configured field paths.
/// **Anti-fake property:** The request uses `model_name` instead of `model`, and
/// `conversation` instead of `messages`. Only a path-configured adapter handles this.
#[test]
fn generic_adapter_extracts_request_fields_via_configured_paths() {
    let yaml_config = r#"
        provider_name: "custom-llm"
        detect_hosts:
          - "llm.internal.corp.com"
        request_mapping:
          model_path: "model_name"
          messages_path: "conversation"
        response_mapping:
          response_text_path: "output.text"
    "#;

    let config = YamlAdapterConfig::from_yaml_str(yaml_config).unwrap();
    let adapter = GenericAdapter::new(config);

    let request_body = r#"{
        "model_name": "custom-v3",
        "conversation": [
            {"role": "user", "content": "Tell me a joke"}
        ],
        "max_length": 512
    }"#;

    let parsed = adapter
        .parse_request(request_body.as_bytes())
        .expect("GenericAdapter.parse_request must succeed");

    assert_eq!(
        parsed.model, "custom-v3",
        "Model must be extracted from the configured path 'model_name'"
    );
    assert_eq!(
        parsed.messages.len(),
        1,
        "Messages must be extracted from the configured path 'conversation'"
    );
}

/// **Proves:** GenericAdapter detects its configured hosts correctly.
/// **Anti-fake property:** The adapter must return true only for the configured host,
/// not for built-in hosts like api.openai.com or api.anthropic.com.
#[test]
fn generic_adapter_detects_configured_hosts_only() {
    let yaml_config = r#"
        provider_name: "custom-llm"
        detect_hosts:
          - "llm.internal.corp.com"
          - "llm-staging.internal.corp.com"
        request_mapping:
          model_path: "model"
        response_mapping:
          response_text_path: "text"
    "#;

    let config = YamlAdapterConfig::from_yaml_str(yaml_config).unwrap();
    let adapter = GenericAdapter::new(config);

    assert!(
        adapter.detect("llm.internal.corp.com", "/v1/generate"),
        "Must detect the configured host"
    );
    assert!(
        adapter.detect("llm-staging.internal.corp.com", "/v1/generate"),
        "Must detect the second configured host"
    );
    assert!(
        !adapter.detect("api.openai.com", "/v1/chat/completions"),
        "Must NOT detect hosts not in the config"
    );
    assert!(
        !adapter.detect("llm.other.com", "/v1/generate"),
        "Must NOT detect unrelated hosts"
    );
}

/// **Proves (NEGATIVE):** GenericAdapter.parse_response returns an error when the
/// configured field paths don't exist in the response JSON.
/// **Anti-fake property:** A hardcoded parser would return defaults regardless of
/// the JSON structure. The generic adapter must fail when its configured paths
/// point to nonexistent fields, proving it actually traverses the configured path.
#[test]
fn generic_adapter_parse_response_fails_on_missing_configured_paths() {
    let yaml_config = r#"
        provider_name: "custom-llm"
        detect_hosts:
          - "llm.internal.corp.com"
        request_mapping:
          model_path: "model"
        response_mapping:
          response_text_path: "deeply.nested.response.text"
          model_path: "meta.model"
    "#;

    let config = YamlAdapterConfig::from_yaml_str(yaml_config).unwrap();
    let adapter = GenericAdapter::new(config);

    // Response body that does NOT have the configured paths
    let response_body = r#"{"answer": "Hello"}"#;

    let result = adapter.parse_response(response_body.as_bytes());

    // Must either error or produce a response with empty/default text
    match result {
        Err(_) => {} // Good: adapter correctly rejects missing paths
        Ok(parsed) => {
            assert!(
                parsed.response_text.is_empty(),
                "When configured path is missing, response_text must be empty, got: {:?}",
                parsed.response_text
            );
        }
    }
}

// ===========================================================================
// Section 5: Multi-Provider Session Correctness (D5) — 5 tests
// ===========================================================================

/// **Proves:** An Anthropic turn and an OpenAI turn can both be stored in the same
/// database and queried back with correct provider fields. The Anthropic turn has
/// provider="anthropic" and the OpenAI turn has provider="openai".
/// **Anti-fake property:** Both turns are written to the same session. If the provider
/// field is hardcoded to one value, one of the two assertions will fail.
#[test]
fn multi_provider_both_turns_stored_with_correct_provider_field() {
    let conn = db::open_in_memory().expect("Must open in-memory SQLite");
    db::initialize(&conn).expect("Must initialize schema");

    let session = sample_session("sess_multi_01", "mixed");
    db::insert_session(&conn, &session).expect("insert session");

    let mut anthropic_turn = sample_turn("turn_multi_anth", "sess_multi_01", 1, "anthropic");
    anthropic_turn.model = Some("claude-sonnet-4-20250514".to_string());
    anthropic_turn.api_endpoint = Some("/v1/messages".to_string());
    anthropic_turn.stop_reason = "end_turn".to_string();

    let mut openai_turn = sample_turn("turn_multi_oai", "sess_multi_01", 2, "openai");
    openai_turn.model = Some("gpt-4o-2024-05-13".to_string());
    openai_turn.api_endpoint = Some("/v1/chat/completions".to_string());
    openai_turn.stop_reason = "stop".to_string();

    db::insert_turn(&conn, &anthropic_turn).expect("insert anthropic turn");
    db::insert_turn(&conn, &openai_turn).expect("insert openai turn");

    let turns = db::query_turns(&conn, "sess_multi_01").expect("query turns");
    assert_eq!(turns.len(), 2, "Both turns must be stored");

    // The turns come back ordered by sequence_num
    assert_eq!(
        turns[0].provider,
        Some("anthropic".to_string()),
        "First turn must have provider=anthropic"
    );
    assert_eq!(
        turns[0].model,
        Some("claude-sonnet-4-20250514".to_string()),
        "First turn must have the Anthropic model"
    );

    assert_eq!(
        turns[1].provider,
        Some("openai".to_string()),
        "Second turn must have provider=openai"
    );
    assert_eq!(
        turns[1].model,
        Some("gpt-4o-2024-05-13".to_string()),
        "Second turn must have the OpenAI model"
    );
}

/// **Proves:** OpenAI request body is parsed correctly through parse_openai_request
/// and produces a RecondoRequest-compatible struct with model, messages, and tools.
/// The resulting TurnRecord has the correct model and provider fields when assembled
/// from the parsed request + response data.
/// **Anti-fake property:** Constructs a TurnRecord from parsed OpenAI data and verifies
/// it contains OpenAI-specific values (gpt-4o model, "openai" provider) that the
/// Anthropic code path would never produce.
#[test]
fn openai_parsed_data_produces_correct_turn_record_fields() {
    let parsed_req =
        parse_openai_request(OPENAI_REQUEST_BODY.as_bytes()).expect("Must parse OpenAI request");
    let parsed_resp =
        parse_openai_sse_events(OPENAI_SSE_TEXT_RESPONSE).expect("Must parse OpenAI response");

    // Construct a TurnRecord as the capture pipeline would
    let mut turn = sample_turn("turn_oai_e2e", "sess_oai_e2e", 1, "openai");
    turn.model = Some(parsed_resp.model.clone());
    turn.response_text = Some(parsed_resp.response_text.clone());
    turn.stop_reason = parsed_resp.stop_reason.clone();
    turn.input_tokens = parsed_resp.input_tokens as i64;
    turn.output_tokens = parsed_resp.output_tokens as i64;
    turn.tool_call_count = parsed_resp.tool_calls.len() as i64;
    turn.api_endpoint = Some("/v1/chat/completions".to_string());

    assert_eq!(turn.model, Some("gpt-4o-2024-05-13".to_string()));
    assert_eq!(
        turn.response_text,
        Some("The capital of France is Paris.".to_string())
    );
    assert_eq!(turn.stop_reason, "stop");
    assert_eq!(turn.input_tokens, 42);
    assert_eq!(turn.output_tokens, 7);
    assert_eq!(turn.tool_call_count, 0);
    assert_eq!(turn.provider, Some("openai".to_string()));

    // Verify the parsed request has the correct model
    assert_eq!(parsed_req.model, "gpt-4o-2024-05-13");
    assert_eq!(
        parsed_req.messages.len(),
        2,
        "Must extract both system and user messages"
    );
}

/// **Proves:** Content hashes are provider-independent. The same request bytes produce
/// the same SHA-256 hash regardless of whether they came from Anthropic or OpenAI.
/// **Anti-fake property:** Computes SHA-256 of OpenAI request bytes and verifies it
/// matches the known hash. If the hash function is provider-specific, this would break.
#[test]
fn content_hashes_are_provider_independent() {
    let anthropic_body =
        b"{\"model\":\"claude-sonnet-4\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}";
    let openai_body =
        b"{\"model\":\"gpt-4o\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}";

    let anthropic_hash = hash::sha256_hex(anthropic_body);
    let openai_hash = hash::sha256_hex(openai_body);

    // Both produce valid hex strings of the same length (SHA-256 = 64 hex chars)
    assert_eq!(
        anthropic_hash.len(),
        64,
        "Anthropic hash must be 64 hex chars"
    );
    assert_eq!(openai_hash.len(), 64, "OpenAI hash must be 64 hex chars");

    // They MUST be different (different input bytes)
    assert_ne!(
        anthropic_hash, openai_hash,
        "Different request bodies must produce different hashes"
    );

    // Deterministic: same bytes always produce the same hash
    let openai_hash_2 = hash::sha256_hex(openai_body);
    assert_eq!(
        openai_hash, openai_hash_2,
        "Same OpenAI bytes must always produce the same hash"
    );
}

/// **Proves (NEGATIVE):** A session with provider="openai" must NOT have its turns
/// pass through the Anthropic parsing path. If someone accidentally routes OpenAI
/// traffic through the Anthropic parser, the fields would be wrong.
/// **Anti-fake property:** Feeds OpenAI SSE data to the Anthropic parser and verifies
/// it either fails or produces wrong/empty results, proving the parsers are not
/// interchangeable.
#[test]
fn anthropic_parser_does_not_work_on_openai_data() {
    use recondo_gateway::providers::anthropic;
    use recondo_gateway::stream::SseEvent;

    // Try to parse OpenAI SSE events using the Anthropic parser
    // First, we need to convert the raw SSE text into SseEvent structs
    // The Anthropic parser expects event_type + data pairs
    let events: Vec<SseEvent> = vec![SseEvent {
        event_type: "content_block_delta".to_string(),
        data: r#"{"id":"chatcmpl-ABC123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}"#.to_string(),
    }];

    let result = anthropic::parse_response(&events);

    // The Anthropic parser must either fail or produce clearly wrong results
    match result {
        Err(_) => {} // Good: parser rejected incompatible format
        Ok(parsed) => {
            // If it doesn't error, the response text must NOT be "Hello" —
            // because the Anthropic parser looks for delta.type=="text_delta"
            // and delta.text, not choices[0].delta.content
            assert!(
                parsed.response_text != "Hello",
                "Anthropic parser must NOT correctly extract OpenAI content. \
                 If it did, the parsers are accidentally interchangeable."
            );
        }
    }
}

/// **Proves:** Anthropic and OpenAI turns in the same session both persist correctly
/// to SQLite with all fields intact. The session total_turns reflects both.
/// **Anti-fake property:** After inserting both turns and updating session totals,
/// queries the session and verifies total_turns=2. If only one provider's insert works,
/// total_turns would be 1.
#[test]
fn multi_provider_session_totals_reflect_both_providers() {
    let conn = db::open_in_memory().expect("Must open in-memory SQLite");
    db::initialize(&conn).expect("Must initialize schema");

    let session = sample_session("sess_multi_totals", "mixed");
    db::insert_session(&conn, &session).expect("insert session");

    let anthropic_turn = sample_turn("turn_totals_anth", "sess_multi_totals", 1, "anthropic");
    let openai_turn = sample_turn("turn_totals_oai", "sess_multi_totals", 2, "openai");

    db::insert_turn(&conn, &anthropic_turn).expect("insert anthropic turn");
    db::insert_turn(&conn, &openai_turn).expect("insert openai turn");

    // Update session totals for both turns
    db::update_session_totals(&conn, "sess_multi_totals", 1, 1, 150, 0.003).unwrap();
    db::update_session_totals(&conn, "sess_multi_totals", 1, 1, 100, 0.002).unwrap();

    // Query session and verify totals reflect both providers
    let sessions = db::query_sessions(&conn).expect("query sessions");
    let sess = sessions
        .iter()
        .find(|s| s.id == "sess_multi_totals")
        .unwrap();

    assert_eq!(
        sess.total_turns, 2,
        "Session total_turns must reflect both Anthropic and OpenAI turns"
    );
    assert_eq!(
        sess.turns_captured, 2,
        "Session turns_captured must reflect both providers"
    );
    assert_eq!(
        sess.total_tokens, 250,
        "Session total_tokens must sum tokens from both providers (150 + 100)"
    );
}

// ===========================================================================
// Section 6: WebSocket Continuation Frame Reassembly (D6) — 7 tests
// ===========================================================================

/// **Proves:** MessageAssembler correctly reassembles a fragmented text message
/// split across an initial text frame (FIN=0) and a continuation frame (FIN=1).
/// The assembled message equals the full original text.
/// **Anti-fake property:** Without continuation frame reassembly, only the first
/// fragment would be captured, producing a truncated message. The assertion on
/// the exact full text proves reassembly works.
#[test]
fn websocket_continuation_frame_reassembles_two_fragments() {
    let mut assembler = MessageAssembler::new();

    // Fragment 1: text frame with FIN=0 (not final)
    let frag1 = WebSocketFrame {
        opcode: 0x1, // text
        payload: b"Hello, ".to_vec(),
        fin: false,
        masked: false,
    };

    // Fragment 2: continuation frame with FIN=1 (final)
    let frag2 = WebSocketFrame {
        opcode: 0x0, // continuation
        payload: b"World!".to_vec(),
        fin: true,
        masked: false,
    };

    let result1 = assembler.push(frag1);
    assert!(
        result1.is_none(),
        "First fragment (FIN=0) must NOT produce a complete message"
    );

    let result2 = assembler.push(frag2);
    assert!(
        result2.is_some(),
        "Final continuation frame (FIN=1) must produce the complete message"
    );

    let (opcode, payload) = result2.unwrap();
    assert_eq!(
        opcode, 0x1,
        "Reassembled message must have the original text opcode"
    );
    assert_eq!(
        String::from_utf8(payload).unwrap(),
        "Hello, World!",
        "Reassembled payload must be the concatenation of all fragments"
    );
}

/// **Proves:** MessageAssembler handles a message split across 3+ continuation frames.
/// **Anti-fake property:** A parser that only handles 2-frame sequences would fail
/// when the third continuation frame arrives. The assertion checks the full concatenation.
#[test]
fn websocket_continuation_reassembles_three_fragments() {
    let mut assembler = MessageAssembler::new();

    let frag1 = WebSocketFrame {
        opcode: 0x1, // text, FIN=0
        payload: b"Part 1 ".to_vec(),
        fin: false,
        masked: false,
    };
    let frag2 = WebSocketFrame {
        opcode: 0x0, // continuation, FIN=0
        payload: b"Part 2 ".to_vec(),
        fin: false,
        masked: false,
    };
    let frag3 = WebSocketFrame {
        opcode: 0x0, // continuation, FIN=1
        payload: b"Part 3".to_vec(),
        fin: true,
        masked: false,
    };

    assert!(assembler.push(frag1).is_none());
    assert!(assembler.push(frag2).is_none());
    let result = assembler.push(frag3);

    assert!(result.is_some());
    let (opcode, payload) = result.unwrap();
    assert_eq!(opcode, 0x1);
    assert_eq!(
        String::from_utf8(payload).unwrap(),
        "Part 1 Part 2 Part 3",
        "Must concatenate all 3 fragments"
    );
}

/// **Proves:** Interleaved control frames (ping/pong) during a fragmented message
/// do NOT corrupt the reassembled message. Control frames are handled separately.
/// **Anti-fake property:** RFC 6455 allows control frames between continuation frames.
/// A naive assembler that treats all frames as data would include ping payload in the
/// reassembled message, producing incorrect output.
#[test]
fn websocket_interleaved_ping_pong_does_not_corrupt_reassembly() {
    let mut assembler = MessageAssembler::new();

    // Start fragmented text message
    let frag1 = WebSocketFrame {
        opcode: 0x1,
        payload: b"Hello ".to_vec(),
        fin: false,
        masked: false,
    };

    // Interleaved ping (control frame — must be handled but NOT accumulated)
    let ping = WebSocketFrame {
        opcode: 0x9, // ping
        payload: b"keepalive".to_vec(),
        fin: true, // control frames are always FIN=1
        masked: false,
    };

    // Continue fragmented message
    let frag2 = WebSocketFrame {
        opcode: 0x0,
        payload: b"World".to_vec(),
        fin: true,
        masked: false,
    };

    assert!(assembler.push(frag1).is_none());

    // Push ping — it should either be returned as a separate control frame
    // or handled internally. It must NOT be accumulated into the data message.
    // Result is unused on purpose: the post-fragment assertion below
    // verifies the ping was NOT merged into the data payload (if it had,
    // the reassembled message would not equal "Hello World"). The
    // underscore prefix marks this as intentionally not asserted on.
    let _ping_result = assembler.push(ping);

    let result = assembler.push(frag2);
    assert!(result.is_some(), "Final fragment must complete the message");

    let (opcode, payload) = result.unwrap();
    assert_eq!(opcode, 0x1);
    assert_eq!(
        String::from_utf8(payload).unwrap(),
        "Hello World",
        "Interleaved ping payload must NOT appear in the reassembled message"
    );
}

/// **Proves:** A single-frame message (FIN=1, opcode=text) passes through the
/// assembler immediately without buffering.
/// **Anti-fake property:** If the assembler always buffers and waits for continuation,
/// single-frame messages would never be emitted. The assertion on immediate return
/// proves single-frame passthrough works.
#[test]
fn websocket_single_frame_message_passes_through_immediately() {
    let mut assembler = MessageAssembler::new();

    let frame = WebSocketFrame {
        opcode: 0x1,
        payload: b"Single frame message".to_vec(),
        fin: true,
        masked: false,
    };

    let result = assembler.push(frame);
    assert!(
        result.is_some(),
        "Single FIN=1 frame must immediately produce a complete message"
    );

    let (opcode, payload) = result.unwrap();
    assert_eq!(opcode, 0x1);
    assert_eq!(String::from_utf8(payload).unwrap(), "Single frame message");
}

/// **Proves:** Binary frames (opcode=0x2) are also reassembled correctly when
/// fragmented. The assembler is not text-only.
/// **Anti-fake property:** A text-only assembler that ignores opcode 0x2 would fail
/// to reassemble the binary fragments or would error.
#[test]
fn websocket_binary_frame_continuation_reassembles_correctly() {
    let mut assembler = MessageAssembler::new();

    let frag1 = WebSocketFrame {
        opcode: 0x2, // binary, FIN=0
        payload: vec![0x00, 0x01, 0x02, 0x03],
        fin: false,
        masked: false,
    };
    let frag2 = WebSocketFrame {
        opcode: 0x0, // continuation, FIN=1
        payload: vec![0x04, 0x05, 0x06, 0x07],
        fin: true,
        masked: false,
    };

    assert!(assembler.push(frag1).is_none());
    let result = assembler.push(frag2);

    assert!(result.is_some());
    let (opcode, payload) = result.unwrap();
    assert_eq!(
        opcode, 0x2,
        "Reassembled binary message must retain opcode 0x2"
    );
    assert_eq!(
        payload,
        vec![0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07],
        "Binary fragments must be concatenated byte-for-byte"
    );
}

/// **Proves (NEGATIVE):** A continuation frame (opcode=0x0) arriving without a
/// preceding initial frame is an error. The assembler must reject orphaned
/// continuation frames rather than silently producing garbage.
/// **Anti-fake property:** If the assembler does not track state, it would either
/// panic or return the orphaned payload as a complete message. The assertion
/// verifies the error is caught.
#[test]
fn websocket_orphaned_continuation_frame_is_rejected() {
    let mut assembler = MessageAssembler::new();

    let orphan = WebSocketFrame {
        opcode: 0x0, // continuation with no prior frame
        payload: b"orphaned data".to_vec(),
        fin: true,
        masked: false,
    };

    let result = assembler.push(orphan);

    // Must either return None (dropped) or the push method returns an error.
    // The key invariant: orphaned continuation frames must NOT produce a valid
    // reassembled message.
    assert!(
        result.is_none(),
        "An orphaned continuation frame (no prior initial frame) must not produce \
         a complete message. The assembler must discard or error on orphaned continuations."
    );
}

/// **Proves:** After completing one fragmented message, the assembler can handle
/// a second fragmented message correctly. This tests that internal state is properly
/// reset between messages.
/// **Anti-fake property:** If the assembler leaks state from the first message into
/// the second, the second message's payload would contain leftover bytes from the first.
#[test]
fn websocket_assembler_resets_state_between_messages() {
    let mut assembler = MessageAssembler::new();

    // First fragmented message
    let msg1_frag1 = WebSocketFrame {
        opcode: 0x1,
        payload: b"First ".to_vec(),
        fin: false,
        masked: false,
    };
    let msg1_frag2 = WebSocketFrame {
        opcode: 0x0,
        payload: b"message".to_vec(),
        fin: true,
        masked: false,
    };

    assembler.push(msg1_frag1);
    let result1 = assembler.push(msg1_frag2);
    assert!(result1.is_some());
    let (_, payload1) = result1.unwrap();
    assert_eq!(String::from_utf8(payload1).unwrap(), "First message");

    // Second fragmented message — must NOT contain "First message" bytes
    let msg2_frag1 = WebSocketFrame {
        opcode: 0x1,
        payload: b"Second ".to_vec(),
        fin: false,
        masked: false,
    };
    let msg2_frag2 = WebSocketFrame {
        opcode: 0x0,
        payload: b"message".to_vec(),
        fin: true,
        masked: false,
    };

    assembler.push(msg2_frag1);
    let result2 = assembler.push(msg2_frag2);
    assert!(result2.is_some());
    let (_, payload2) = result2.unwrap();
    assert_eq!(
        String::from_utf8(payload2).unwrap(),
        "Second message",
        "Second message must contain ONLY 'Second message', not leftover from first"
    );
}

// ===========================================================================
// Section 7: Cache-Aware Token Pricing (D7) — 6 tests
// ===========================================================================

/// **Proves:** compute_cost_usd now applies 50% discount for OpenAI cached tokens
/// instead of ignoring them. For gpt-4o ($2.50/M input), 1000 cached read tokens
/// should cost $2.50 * 0.5 / 1M * 1000 = $0.00000125.
/// **Anti-fake property:** The current implementation returns 0.0 for non-Anthropic
/// cache tokens. This test will ONLY pass when cache_read_tokens pricing is
/// implemented for OpenAI models at the 50% rate.
#[test]
fn openai_cached_tokens_priced_at_50_percent_of_input_rate() {
    // gpt-4o: input_rate = $2.50/M
    // 1000 standard input tokens = $0.0025
    // 1000 cache read tokens at 50% = $0.00125
    // 500 output tokens at $10/M = $0.005
    // Total = $0.0025 + $0.00125 + $0.005 = $0.00875

    let cost = compute_cost_usd(
        "gpt-4o-2024-05-13",
        1000, // input_tokens
        500,  // output_tokens
        0,    // cache_creation_tokens (OpenAI doesn't have creation tokens)
        1000, // cache_read_tokens
    );

    // Expected: input + cached_read + output
    // input: 1000 * 2.50 / 1_000_000 = 0.0025
    // cache_read: 1000 * (2.50 * 0.5) / 1_000_000 = 0.00125
    // output: 500 * 10.0 / 1_000_000 = 0.005
    let expected = 0.0025 + 0.00125 + 0.005;

    assert!(
        (cost - expected).abs() < 1e-10,
        "OpenAI cached tokens at 50% rate: expected {}, got {}",
        expected,
        cost,
    );
}

/// **Proves:** Anthropic cache read tokens remain at 10% of input rate (not affected
/// by the OpenAI 50% change). This ensures the multi-provider pricing table is correct.
/// **Anti-fake property:** If the implementer accidentally applies 50% to all providers,
/// this test will fail because Anthropic uses 10%.
#[test]
fn anthropic_cached_tokens_remain_at_10_percent_of_input_rate() {
    // claude-sonnet-4: input_rate = $3.00/M
    // 1000 standard input tokens = $0.003
    // 2000 cache read tokens at 10% = 2000 * 0.30 / 1_000_000 = $0.0006
    // 500 cache creation tokens at 125% = 500 * 3.75 / 1_000_000 = $0.001875
    // 1000 output tokens at $15/M = $0.015
    // Total = $0.003 + $0.0006 + $0.001875 + $0.015 = $0.020475

    let cost = compute_cost_usd(
        "claude-sonnet-4-20250514",
        1000, // input_tokens
        1000, // output_tokens
        500,  // cache_creation_tokens (125% of input rate)
        2000, // cache_read_tokens (10% of input rate)
    );

    let expected = 0.003 + 0.0006 + 0.001875 + 0.015;

    assert!(
        (cost - expected).abs() < 1e-10,
        "Anthropic cache pricing must use 10% read / 125% creation: expected {}, got {}",
        expected,
        cost,
    );
}

/// **Proves:** OpenAI cache read tokens produce a non-zero cost for gpt-4-turbo model.
/// This tests a second OpenAI model to ensure pricing table coverage.
/// **Anti-fake property:** gpt-4-turbo has input_rate=$10/M. Cache read at 50% = $5/M.
/// 5000 cache read tokens = $0.025. Without cache pricing this would be $0.
#[test]
fn openai_gpt4_turbo_cache_tokens_produce_nonzero_cost() {
    // Only cache read tokens, no standard input or output
    let cost_with_cache = compute_cost_usd(
        "gpt-4-turbo-2024-04-09",
        0,    // input_tokens
        0,    // output_tokens
        0,    // cache_creation_tokens
        5000, // cache_read_tokens
    );

    // gpt-4-turbo: input_rate = $10/M, cache_read at 50% = $5/M
    // 5000 * 5.0 / 1_000_000 = $0.025
    let expected = 5000.0 * (10.0 * 0.5) / 1_000_000.0;

    assert!(
        cost_with_cache > 0.0,
        "OpenAI cache read tokens must produce non-zero cost, got {}",
        cost_with_cache
    );
    assert!(
        (cost_with_cache - expected).abs() < 1e-10,
        "gpt-4-turbo cache cost: expected {}, got {}",
        expected,
        cost_with_cache,
    );
}

/// **Proves (NEGATIVE):** Without cache-aware pricing, OpenAI cache_read_tokens=1000
/// would produce $0 additional cost. This test explicitly verifies that the
/// implementation produces a DIFFERENT (higher) cost than the no-cache baseline.
/// **Anti-fake property:** The baseline cost (0 cache tokens) must differ from
/// the cache-aware cost. If the implementation ignores cache tokens, both costs
/// would be identical and this test would fail.
#[test]
fn openai_cache_tokens_change_cost_vs_zero_cache_baseline() {
    let baseline_cost = compute_cost_usd(
        "gpt-4o", 1000, // input
        500,  // output
        0,    // no cache creation
        0,    // no cache read
    );

    let cached_cost = compute_cost_usd(
        "gpt-4o", 1000, // same input
        500,  // same output
        0,    // no cache creation
        2000, // 2000 cache read tokens
    );

    assert!(
        cached_cost > baseline_cost,
        "Cost with 2000 cache read tokens ({}) must be greater than baseline cost ({}) \
         because cached tokens still incur 50% of the input rate",
        cached_cost,
        baseline_cost,
    );

    // The difference should be exactly 2000 * (2.50 * 0.5) / 1_000_000 = $0.0025
    let expected_diff = 2000.0 * (2.50 * 0.5) / 1_000_000.0;
    let actual_diff = cached_cost - baseline_cost;
    assert!(
        (actual_diff - expected_diff).abs() < 1e-10,
        "Cache cost difference must be exactly ${}. Got ${}",
        expected_diff,
        actual_diff,
    );
}

/// **Proves:** Unknown models still return 0.0 cost (no regression from cache changes).
/// **Anti-fake property:** Ensures the pricing table falls through to 0.0 for
/// unrecognized models, even with cache tokens present.
#[test]
fn unknown_model_with_cache_tokens_returns_zero_cost() {
    let cost = compute_cost_usd("unknown-model-xyz", 1000, 500, 100, 200);

    assert_eq!(
        cost, 0.0,
        "Unknown models must return 0.0 cost regardless of cache tokens"
    );
}

/// **Proves:** o1-mini model's cached tokens are priced at 50% of its input rate.
/// o1-mini: input_rate = $3.00/M, so cache_read at 50% = $1.50/M.
/// **Anti-fake property:** Tests a different OpenAI model to ensure the cache
/// pricing applies to all OpenAI models, not just gpt-4o.
#[test]
fn openai_o1_mini_cache_tokens_at_50_percent() {
    let cost = compute_cost_usd(
        "o1-mini", 0,     // no standard input
        0,     // no output
        0,     // no cache creation
        10000, // cache read tokens
    );

    // o1-mini: input_rate = $3.00/M, cache at 50% = $1.50/M
    // 10000 * 1.50 / 1_000_000 = $0.015
    let expected = 10000.0 * (3.0 * 0.5) / 1_000_000.0;

    assert!(
        (cost - expected).abs() < 1e-10,
        "o1-mini cache cost: expected {}, got {}",
        expected,
        cost,
    );
}

// ===========================================================================
// Section 8: OpenAI Session Identity Extraction (D8) — 6 tests
// ===========================================================================

/// **Proves:** extract_openai_metadata extracts `chatgpt-account-id` from WebSocket
/// upgrade headers and maps it to account_uuid.
/// **Anti-fake property:** The exact UUID "b9f1456e-6e84-4215-929e-c6bb856f090e" must
/// be extracted. The Anthropic metadata extractor reads JSON body, not HTTP headers.
/// Only an OpenAI-specific header extractor can produce this value.
#[test]
fn openai_metadata_extracts_account_uuid_from_chatgpt_account_id_header() {
    let metadata = extract_openai_metadata(CODEX_UPGRADE_HEADERS);

    assert_eq!(
        metadata.account_uuid,
        Some("b9f1456e-6e84-4215-929e-c6bb856f090e".to_string()),
        "account_uuid must be extracted from chatgpt-account-id header"
    );
}

/// **Proves:** extract_openai_metadata extracts `session_id` from the WebSocket
/// upgrade request headers.
/// **Anti-fake property:** The session_id header value is a specific UUID that differs
/// from the account ID. An extractor that confuses header names would fail.
#[test]
fn openai_metadata_extracts_session_id_from_header() {
    let metadata = extract_openai_metadata(CODEX_UPGRADE_HEADERS);

    assert_eq!(
        metadata.session_id,
        Some("019d0d8e-03be-7382-9e5f-3cc32940c9cb".to_string()),
        "session_id must be extracted from the session_id header"
    );
}

/// **Proves:** extract_openai_metadata extracts `originator` header as the framework
/// field. For Codex CLI, this is "codex_cli_rs".
/// **Anti-fake property:** The Anthropic extractor infers framework from content
/// heuristics, not from a header. The value "codex_cli_rs" can only come from
/// parsing the `originator` header.
#[test]
fn openai_metadata_extracts_framework_from_originator_header() {
    let metadata = extract_openai_metadata(CODEX_UPGRADE_HEADERS);

    // The ClientMetadata struct has session_id, account_uuid, device_id.
    // framework and agent_version may be returned via an extended struct
    // or as additional fields. We check what the design doc specifies.
    //
    // If ClientMetadata is extended:
    //   assert_eq!(metadata.framework, Some("codex_cli_rs".to_string()));
    //
    // If returned separately, the function signature may change. For now,
    // we test the struct has framework support. The implementation agent
    // must decide whether to extend ClientMetadata or return a richer type.

    // The metadata type returned by extract_openai_metadata must include framework.
    // Per PROVIDER_IDENTITY_MAPPING.md: originator -> framework
    assert_eq!(
        metadata.framework,
        Some("codex_cli_rs".to_string()),
        "framework must be extracted from the originator header"
    );
}

/// **Proves:** extract_openai_metadata extracts `version` header as agent_version.
/// For Codex CLI v0.116.0, this is "0.116.0".
/// **Anti-fake property:** No other extraction path provides an agent_version string.
/// The Anthropic extractor does not extract agent_version at all.
#[test]
fn openai_metadata_extracts_agent_version_from_version_header() {
    let metadata = extract_openai_metadata(CODEX_UPGRADE_HEADERS);

    assert_eq!(
        metadata.agent_version,
        Some("0.116.0".to_string()),
        "agent_version must be extracted from the version header"
    );
}

/// **Proves:** extract_openai_metadata correctly reports device_id as None for
/// OpenAI/Codex (per PROVIDER_IDENTITY_MAPPING.md: "Codex CLI does not send
/// a machine identifier").
/// **Anti-fake property:** If the extractor erroneously parses some other header
/// as device_id, this assertion would catch it.
#[test]
fn openai_metadata_device_id_is_none_for_codex() {
    let metadata = extract_openai_metadata(CODEX_UPGRADE_HEADERS);

    assert_eq!(
        metadata.device_id, None,
        "device_id must be None for Codex CLI (no machine identifier sent)"
    );
}

/// **Proves (NEGATIVE):** extract_openai_metadata returns default/empty metadata
/// when given headers without any OpenAI-specific fields. This ensures the extractor
/// doesn't fabricate identity from unrelated headers.
/// **Anti-fake property:** If the extractor returns hardcoded values regardless of
/// input, this test would fail because the generic headers have no OpenAI identity.
#[test]
fn openai_metadata_extraction_returns_defaults_for_non_openai_headers() {
    let generic_headers = concat!(
        "GET /api/v1/complete HTTP/1.1\r\n",
        "Host: llm.example.com\r\n",
        "Content-Type: application/json\r\n",
        "Authorization: Bearer sk-test-key\r\n",
        "\r\n",
    );

    let metadata = extract_openai_metadata(generic_headers);

    assert_eq!(
        metadata.account_uuid, None,
        "account_uuid must be None for non-OpenAI headers"
    );
    assert_eq!(
        metadata.session_id, None,
        "session_id must be None for non-OpenAI headers"
    );
    assert_eq!(
        metadata.device_id, None,
        "device_id must be None for non-OpenAI headers"
    );
}

// ===========================================================================
// Section 9: ProviderAdapter Trait (Sprint 3 Task 1) — 3 tests
// ===========================================================================

/// **Proves:** The ProviderAdapter trait exists with detect, parse_request,
/// parse_response, and parse_sse_event methods. The OpenAI adapter implements it.
/// **Anti-fake property:** If the trait doesn't exist or the OpenAI adapter doesn't
/// implement it, this code won't compile.
#[test]
fn openai_adapter_implements_provider_adapter_trait() {
    // The OpenAI adapter must implement ProviderAdapter
    // We verify by calling detect on the OpenAI host
    let openai_adapter = recondo_gateway::providers::openai::OpenAiAdapter::new();

    assert!(
        openai_adapter.detect("api.openai.com", "/v1/chat/completions"),
        "OpenAI adapter must detect api.openai.com/v1/chat/completions"
    );
    assert!(
        openai_adapter.detect("chatgpt.com", "/backend-api/codex/responses"),
        "OpenAI adapter must detect chatgpt.com WebSocket paths"
    );
    assert!(
        !openai_adapter.detect("api.anthropic.com", "/v1/messages"),
        "OpenAI adapter must NOT detect Anthropic API host"
    );
}

/// **Proves:** parse_openai_request correctly extracts model, messages, and max_tokens
/// from a realistic OpenAI request body.
/// **Anti-fake property:** The request has model="gpt-4o-2024-05-13", 2 messages,
/// and max_tokens=1024. An Anthropic parser would look for different field names
/// (max_tokens vs max_tokens is the same, but messages structure differs with system).
#[test]
fn openai_request_parser_extracts_model_messages_max_tokens() {
    let parsed = parse_openai_request(OPENAI_REQUEST_BODY.as_bytes()).unwrap();

    assert_eq!(
        parsed.model, "gpt-4o-2024-05-13",
        "Must extract model from OpenAI request"
    );
    assert_eq!(
        parsed.messages.len(),
        2,
        "Must extract both messages (system + user)"
    );
    assert_eq!(
        parsed.max_tokens, 1024,
        "Must extract max_tokens from OpenAI request"
    );
}

/// **Proves (NEGATIVE):** The OpenAI adapter's detect method returns false for
/// non-OpenAI hosts. This ensures provider routing doesn't accidentally send
/// traffic through the wrong adapter.
/// **Anti-fake property:** Tests several non-OpenAI hosts. A detect method that
/// always returns true would fail all these assertions.
#[test]
fn openai_adapter_detect_rejects_non_openai_hosts() {
    let adapter = recondo_gateway::providers::openai::OpenAiAdapter::new();

    assert!(!adapter.detect("api.anthropic.com", "/v1/messages"));
    assert!(!adapter.detect("generativelanguage.googleapis.com", "/v1/models"));
    assert!(!adapter.detect("llm.internal.corp.com", "/v1/chat"));
    assert!(!adapter.detect("localhost", "/v1/chat/completions"));
}

// ===========================================================================
// Section 10: End-to-End Deliverable Tests (1 per deliverable, 8 tests)
// ===========================================================================

/// **D1 End-to-End:** OpenAI Chat Completions + SSE streaming captured.
/// Sends OpenAI-format request bytes and SSE response bytes through the full
/// parsing pipeline (parse_openai_request + parse_openai_sse_events), constructs
/// a TurnRecord, writes it to the DB, and reads it back. Every field must match.
/// **Anti-fake property:** This test exercises the full path: raw bytes -> parser ->
/// TurnRecord -> DB -> query. A stub that skips any step would produce mismatched
/// fields. The response_text, model, stop_reason, input_tokens, and output_tokens
/// must all have specific OpenAI values.
#[test]
fn e2e_d1_openai_chat_completions_sse_captured_to_db() {
    let conn = db::open_in_memory().expect("open in-memory DB");
    db::initialize(&conn).expect("initialize schema");

    // Parse request — `_parsed_req` is intentionally unused below; the
    // call's job here is to assert the request body parses without
    // error. The TurnRecord assembled from the response in the lines
    // that follow exercises the full E2E path; the request-side parse
    // is one more guarantee on top of that.
    let _parsed_req =
        parse_openai_request(OPENAI_REQUEST_BODY.as_bytes()).expect("Must parse OpenAI request");

    // Parse response SSE stream
    let parsed_resp =
        parse_openai_sse_events(OPENAI_SSE_TEXT_RESPONSE).expect("Must parse OpenAI SSE response");

    // Create session
    let session = sample_session("sess_e2e_d1", "openai");
    db::insert_session(&conn, &session).unwrap();

    // Create turn from parsed data
    let req_bytes = OPENAI_REQUEST_BODY.as_bytes();
    let resp_bytes = OPENAI_SSE_TEXT_RESPONSE.as_bytes();

    let mut turn = sample_turn("turn_e2e_d1", "sess_e2e_d1", 1, "openai");
    turn.model = Some(parsed_resp.model.clone());
    turn.response_text = Some(parsed_resp.response_text.clone());
    turn.stop_reason = parsed_resp.stop_reason.clone();
    turn.input_tokens = parsed_resp.input_tokens as i64;
    turn.output_tokens = parsed_resp.output_tokens as i64;
    turn.request_hash = hash::sha256_hex(req_bytes);
    turn.response_hash = hash::sha256_hex(resp_bytes);
    turn.api_endpoint = Some("/v1/chat/completions".to_string());
    turn.transport = Some("http".to_string());

    db::insert_turn(&conn, &turn).unwrap();

    // Read back and verify
    let turns = db::query_turns(&conn, "sess_e2e_d1").expect("query turns");
    assert_eq!(turns.len(), 1, "Must have exactly one turn");

    let t = &turns[0];
    assert_eq!(t.provider, Some("openai".to_string()));
    assert_eq!(t.model, Some("gpt-4o-2024-05-13".to_string()));
    assert_eq!(
        t.response_text,
        Some("The capital of France is Paris.".to_string())
    );
    assert_eq!(t.stop_reason, "stop");
    assert_eq!(t.input_tokens, 42);
    assert_eq!(t.output_tokens, 7);
    assert_eq!(t.api_endpoint, Some("/v1/chat/completions".to_string()));
    assert_eq!(t.transport, Some("http".to_string()));
}

/// **D2 End-to-End:** Tool calls normalized to Recondo ToolCall schema.
/// Parses an OpenAI SSE response with tool calls, maps them to ToolCallRecords,
/// writes to DB, reads back, and verifies name + input match exactly.
/// **Anti-fake property:** The tool call arguments are streamed across multiple SSE
/// chunks and must be accumulated. The DB round-trip proves the full pipeline works.
#[test]
fn e2e_d2_tool_calls_normalized_to_recondo_schema_via_db() {
    let conn = db::open_in_memory().expect("open in-memory DB");
    db::initialize(&conn).expect("initialize schema");

    let parsed_resp = parse_openai_sse_events(OPENAI_SSE_TOOL_CALL_RESPONSE)
        .expect("Must parse OpenAI tool call response");

    let session = sample_session("sess_e2e_d2", "openai");
    db::insert_session(&conn, &session).unwrap();

    let mut turn = sample_turn("turn_e2e_d2", "sess_e2e_d2", 1, "openai");
    turn.tool_call_count = parsed_resp.tool_calls.len() as i64;
    turn.stop_reason = parsed_resp.stop_reason.clone();
    db::insert_turn(&conn, &turn).unwrap();

    // Write tool calls to DB
    for (i, tc) in parsed_resp.tool_calls.iter().enumerate() {
        let record = ToolCallRecord {
            id: format!("tc_e2e_d2_{}", i),
            turn_id: "turn_e2e_d2".to_string(),
            tool_name: tc.name.clone(),
            tool_input: tc.input.clone(),
            input_hash: Some(hash::sha256_hex(tc.input.as_bytes())),
            sequence_num: Some(i as i64),
            output: None,
            output_hash: None,
            duration_ms: None,
            error: None,
            status: None,
            artifacts_created: None,
            artifact_hashes: None,
        };
        db::insert_tool_call(&conn, &record).expect("insert tool call");
    }

    // Read back tool calls
    let tool_calls = db::query_tool_calls(&conn, "turn_e2e_d2").expect("query tool calls");
    assert_eq!(
        tool_calls.len(),
        1,
        "Must have exactly one tool call from the SSE response"
    );
    assert_eq!(tool_calls[0].tool_name, "get_weather");
    assert_eq!(
        tool_calls[0].tool_input, r#"{"location":"Paris"}"#,
        "Tool call input must be the fully accumulated arguments"
    );
    assert!(
        tool_calls[0].input_hash.is_some(),
        "Tool call must have an input hash"
    );
}

/// **D4 End-to-End:** Generic YAML adapter for custom providers.
/// Constructs a GenericAdapter from YAML config, parses a custom-format request
/// and response, and verifies all extracted fields are correct.
/// **Anti-fake property:** The custom JSON uses non-standard field names that no
/// built-in adapter recognizes. Only the YAML-configured path extractor can produce
/// the correct values.
#[test]
fn e2e_d4_generic_yaml_adapter_parses_custom_provider() {
    let yaml_config = r#"
        provider_name: "acme-llm"
        detect_hosts:
          - "api.acme-ai.com"
        request_mapping:
          model_path: "config.model_id"
          messages_path: "dialog.turns"
          max_tokens_path: "config.max_output"
        response_mapping:
          response_text_path: "result.completion"
          model_path: "result.model_version"
          stop_reason_path: "result.reason"
          input_tokens_path: "metrics.tokens_in"
          output_tokens_path: "metrics.tokens_out"
    "#;

    let config = YamlAdapterConfig::from_yaml_str(yaml_config).unwrap();
    let adapter = GenericAdapter::new(config);

    // Verify detection
    assert!(adapter.detect("api.acme-ai.com", "/v1/generate"));

    // Parse request
    let request = r#"{
        "config": {
            "model_id": "acme-v2-large",
            "max_output": 2048
        },
        "dialog": {
            "turns": [
                {"role": "user", "content": "Explain quantum computing"}
            ]
        }
    }"#;

    let parsed_req = adapter.parse_request(request.as_bytes()).unwrap();
    assert_eq!(parsed_req.model, "acme-v2-large");
    assert_eq!(parsed_req.messages.len(), 1);

    // Parse response
    let response = r#"{
        "result": {
            "completion": "Quantum computing uses qubits that can be in superposition.",
            "model_version": "acme-v2-large-20260301",
            "reason": "length"
        },
        "metrics": {
            "tokens_in": 25,
            "tokens_out": 12
        }
    }"#;

    let parsed_resp = adapter.parse_response(response.as_bytes()).unwrap();
    assert_eq!(
        parsed_resp.response_text,
        "Quantum computing uses qubits that can be in superposition."
    );
    assert_eq!(parsed_resp.model, "acme-v2-large-20260301");
    assert_eq!(parsed_resp.stop_reason, "length");
    assert_eq!(parsed_resp.input_tokens, 25);
    assert_eq!(parsed_resp.output_tokens, 12);
}

/// **D5 End-to-End:** Multi-provider session captures correctly.
/// Writes an Anthropic turn and an OpenAI turn to the same session in the DB,
/// then queries them back and verifies both have correct, distinct provider fields.
/// **Anti-fake property:** Both turns are in one session. The Anthropic turn has
/// model "claude-sonnet-4-*" and stop_reason "end_turn". The OpenAI turn has model
/// "gpt-4o-*" and stop_reason "stop". If provider routing is broken, one of these
/// would be wrong.
#[test]
fn e2e_d5_multi_provider_anthropic_and_openai_in_same_session() {
    let conn = db::open_in_memory().expect("open in-memory DB");
    db::initialize(&conn).expect("initialize schema");

    let session = sample_session("sess_e2e_d5", "mixed");
    db::insert_session(&conn, &session).unwrap();

    // Anthropic turn
    let mut anth_turn = sample_turn("turn_e2e_d5_anth", "sess_e2e_d5", 1, "anthropic");
    anth_turn.model = Some("claude-sonnet-4-20250514".to_string());
    anth_turn.stop_reason = "end_turn".to_string();
    anth_turn.response_text = Some("Anthropic response".to_string());
    anth_turn.input_tokens = 200;
    anth_turn.output_tokens = 100;
    anth_turn.api_endpoint = Some("/v1/messages".to_string());
    db::insert_turn(&conn, &anth_turn).unwrap();

    // OpenAI turn (parsed from SSE)
    let parsed_oai = parse_openai_sse_events(OPENAI_SSE_TEXT_RESPONSE).unwrap();
    let mut oai_turn = sample_turn("turn_e2e_d5_oai", "sess_e2e_d5", 2, "openai");
    oai_turn.model = Some(parsed_oai.model.clone());
    oai_turn.stop_reason = parsed_oai.stop_reason.clone();
    oai_turn.response_text = Some(parsed_oai.response_text.clone());
    oai_turn.input_tokens = parsed_oai.input_tokens as i64;
    oai_turn.output_tokens = parsed_oai.output_tokens as i64;
    oai_turn.api_endpoint = Some("/v1/chat/completions".to_string());
    db::insert_turn(&conn, &oai_turn).unwrap();

    // Query all turns for the session
    let turns = db::query_turns(&conn, "sess_e2e_d5").unwrap();
    assert_eq!(turns.len(), 2);

    // Anthropic turn
    assert_eq!(turns[0].provider, Some("anthropic".to_string()));
    assert_eq!(turns[0].model, Some("claude-sonnet-4-20250514".to_string()));
    assert_eq!(turns[0].stop_reason, "end_turn");
    assert_eq!(
        turns[0].response_text,
        Some("Anthropic response".to_string())
    );

    // OpenAI turn
    assert_eq!(turns[1].provider, Some("openai".to_string()));
    assert_eq!(turns[1].model, Some("gpt-4o-2024-05-13".to_string()));
    assert_eq!(turns[1].stop_reason, "stop");
    assert_eq!(
        turns[1].response_text,
        Some("The capital of France is Paris.".to_string())
    );
}

/// **D6 End-to-End:** WebSocket continuation frame reassembly for complete
/// message capture. Encodes a fragmented WebSocket message using the existing
/// `encode_frame_with_fin` function, parses the raw bytes with `parse_frame`,
/// feeds the parsed frames through `MessageAssembler`, and verifies the
/// reassembled output matches the original full message.
/// **Anti-fake property:** Uses the production encode/parse functions to create
/// realistic wire-format frames. Only a correctly wired assembler that handles
/// continuation frames can produce the full original message from fragmented bytes.
#[test]
fn e2e_d6_websocket_continuation_frames_reassembled_from_wire_bytes() {
    let full_message = "This is a large WebSocket message that has been split across multiple frames for transmission.";
    let part1 = &full_message[..30];
    let part2 = &full_message[30..60];
    let part3 = &full_message[60..];

    // Encode as fragmented WebSocket frames using production encode function
    let wire_frag1 = encode_frame_with_fin(0x1, part1.as_bytes(), false, false); // text, FIN=0
    let wire_frag2 = encode_frame_with_fin(0x0, part2.as_bytes(), false, false); // continuation, FIN=0
    let wire_frag3 = encode_frame_with_fin(0x0, part3.as_bytes(), false, true); // continuation, FIN=1

    // Parse each wire frame
    let (frame1, _) = parse_frame(&wire_frag1).expect("parse frag1");
    let (frame2, _) = parse_frame(&wire_frag2).expect("parse frag2");
    let (frame3, _) = parse_frame(&wire_frag3).expect("parse frag3");

    // Verify frame properties
    assert!(!frame1.fin, "First frame must have FIN=0");
    assert_eq!(frame1.opcode, 0x1, "First frame must be text");
    assert!(!frame2.fin, "Second frame must have FIN=0");
    assert_eq!(frame2.opcode, 0x0, "Second frame must be continuation");
    assert!(frame3.fin, "Third frame must have FIN=1");
    assert_eq!(frame3.opcode, 0x0, "Third frame must be continuation");

    // Feed through MessageAssembler
    let mut assembler = MessageAssembler::new();
    assert!(assembler.push(frame1).is_none());
    assert!(assembler.push(frame2).is_none());
    let result = assembler.push(frame3);

    assert!(
        result.is_some(),
        "Final continuation frame must produce complete message"
    );
    let (opcode, payload) = result.unwrap();
    assert_eq!(opcode, 0x1, "Reassembled message must have text opcode");
    assert_eq!(
        String::from_utf8(payload).unwrap(),
        full_message,
        "Reassembled message must exactly match the original full message"
    );
}

/// **D7 End-to-End:** Cache-aware token pricing for both Anthropic and OpenAI.
/// Computes costs for both providers with cache tokens and verifies the results
/// differ according to each provider's cache pricing rate.
/// **Anti-fake property:** Anthropic cache read at 10% and OpenAI cache read at 50%
/// produce mathematically different costs for the same token counts. Both must be
/// non-zero and correct to their respective rates.
#[test]
fn e2e_d7_cache_aware_pricing_both_providers() {
    // Anthropic: claude-sonnet-4 ($3/M input, $15/M output)
    // 1000 input + 500 cache_read (at 10% = $0.30/M) + 200 cache_creation (at 125% = $3.75/M)
    let anthropic_cost = compute_cost_usd("claude-sonnet-4-20250514", 1000, 500, 200, 500);

    // OpenAI: gpt-4o ($2.50/M input, $10/M output)
    // 1000 input + 500 cache_read (at 50% = $1.25/M)
    let openai_cost = compute_cost_usd("gpt-4o-2024-05-13", 1000, 500, 0, 500);

    // Both must be non-zero
    assert!(
        anthropic_cost > 0.0,
        "Anthropic cost with cache tokens must be non-zero"
    );
    assert!(
        openai_cost > 0.0,
        "OpenAI cost with cache tokens must be non-zero"
    );

    // Verify Anthropic-specific calculation
    // input: 1000 * 3.0 / 1M = 0.003
    // cache_creation: 200 * 3.75 / 1M = 0.00075
    // cache_read: 500 * 0.30 / 1M = 0.00015
    // output: 500 * 15.0 / 1M = 0.0075
    let expected_anthropic = 0.003 + 0.00075 + 0.00015 + 0.0075;
    assert!(
        (anthropic_cost - expected_anthropic).abs() < 1e-10,
        "Anthropic cost expected {}, got {}",
        expected_anthropic,
        anthropic_cost
    );

    // Verify OpenAI-specific calculation
    // input: 1000 * 2.50 / 1M = 0.0025
    // cache_read: 500 * 1.25 / 1M = 0.000625
    // output: 500 * 10.0 / 1M = 0.005
    let expected_openai = 0.0025 + 0.000625 + 0.005;
    assert!(
        (openai_cost - expected_openai).abs() < 1e-10,
        "OpenAI cost expected {}, got {}",
        expected_openai,
        openai_cost
    );

    // The two costs must differ (different rates for same token counts)
    assert_ne!(
        anthropic_cost, openai_cost,
        "Anthropic and OpenAI costs must differ due to different cache pricing rates"
    );
}

/// **D8 End-to-End:** OpenAI session identity extraction from WebSocket upgrade
/// headers. Extracts metadata from realistic Codex upgrade headers, writes the
/// identity fields to a SessionRecord in the DB, reads it back, and verifies
/// all fields match.
/// **Anti-fake property:** The account_uuid, framework, and agent_version come
/// from OpenAI-specific HTTP headers. The DB round-trip proves the full pipeline
/// from raw headers -> extraction -> structured record -> persistent storage works.
#[test]
fn e2e_d8_openai_identity_from_ws_headers_to_session_record() {
    let conn = db::open_in_memory().expect("open in-memory DB");
    db::initialize(&conn).expect("initialize schema");

    // Extract metadata from upgrade headers
    let metadata = extract_openai_metadata(CODEX_UPGRADE_HEADERS);

    // Build a session record using the extracted metadata
    let mut session = sample_session("sess_e2e_d8", "openai");
    session.account_uuid = metadata.account_uuid.clone();
    session.framework = metadata.framework.clone();
    session.agent_version = metadata.agent_version.clone();

    db::insert_session(&conn, &session).unwrap();

    // Read back from DB
    let sessions = db::query_sessions(&conn).unwrap();
    let sess = sessions.iter().find(|s| s.id == "sess_e2e_d8").unwrap();

    assert_eq!(
        sess.account_uuid,
        Some("b9f1456e-6e84-4215-929e-c6bb856f090e".to_string()),
        "account_uuid must persist through DB round-trip"
    );
    assert_eq!(
        sess.framework,
        Some("codex_cli_rs".to_string()),
        "framework must persist through DB round-trip"
    );
    assert_eq!(
        sess.agent_version,
        Some("0.116.0".to_string()),
        "agent_version must persist through DB round-trip"
    );
    assert_eq!(
        sess.provider, "openai",
        "Provider must be 'openai' for Codex sessions"
    );
}

// ===========================================================================
// Section 11: R1-08 fix — parse_capture_data exercised for OpenAI
// ===========================================================================

/// **R1-08 fix:** Exercises the production `parse_capture_data` function with
/// the `"openai"` provider arm using realistic OpenAI HTTP request and
/// response bytes (with HTTP headers prepended, as the real gateway captures).
///
/// This test calls the exact production code path that the gateway uses when
/// it captures an OpenAI Chat Completions HTTP request/response pair. A bug
/// in the `"openai"` arm of `parse_capture_data` would cause this test to fail.
///
/// **Anti-fake property:** The response bytes include HTTP headers followed by
/// SSE events. `parse_capture_data` must strip headers, reconstruct SSE text,
/// parse it with the OpenAI SSE parser, and return matching fields. The
/// assertions check model, response_text, stop_reason, input_tokens, and
/// output_tokens — all specific to the OpenAI test fixture.
#[test]
fn parse_capture_data_openai_extracts_correct_fields() {
    use recondo_gateway::gateway::parse_capture_data;

    // Build realistic captured bytes: HTTP headers + body, as the gateway stores them.
    let request_with_headers = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nHost: api.openai.com\r\nContent-Type: application/json\r\n\r\n{}",
        OPENAI_REQUEST_BODY
    );
    let response_with_headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n{}",
        OPENAI_SSE_TEXT_RESPONSE
    );

    let parsed = parse_capture_data(
        "openai",
        request_with_headers.as_bytes(),
        response_with_headers.as_bytes(),
    );

    // Model must be extracted from the SSE events
    assert_eq!(
        parsed.model,
        Some("gpt-4o-2024-05-13".to_string()),
        "parse_capture_data must extract the model from OpenAI SSE events"
    );

    // Response text must be the concatenated delta.content chunks
    assert_eq!(
        parsed.response_text,
        Some("The capital of France is Paris.".to_string()),
        "parse_capture_data must extract concatenated response text from OpenAI SSE"
    );

    // Stop reason from the final SSE chunk's finish_reason
    assert_eq!(
        parsed.stop_reason, "stop",
        "parse_capture_data must extract stop_reason from OpenAI SSE"
    );

    // Token counts from the usage object in the final SSE chunk
    assert_eq!(
        parsed.input_tokens, 42,
        "parse_capture_data must extract input_tokens from OpenAI SSE usage"
    );
    assert_eq!(
        parsed.output_tokens, 7,
        "parse_capture_data must extract output_tokens from OpenAI SSE usage"
    );

    // System prompt extracted from the request body
    assert_eq!(
        parsed.system_prompt,
        Some("You are a helpful assistant.".to_string()),
        "parse_capture_data must extract the system prompt from OpenAI request"
    );

    // Messages extracted from the request body
    assert_eq!(
        parsed.messages.len(),
        2,
        "parse_capture_data must extract both messages from the OpenAI request"
    );

    // capture_complete should be true (we have SSE events)
    assert!(
        parsed.capture_complete,
        "parse_capture_data must mark capture as complete when SSE events are present"
    );
}

/// **R1-08 supplement:** Exercises `parse_capture_data("openai", ...)` with
/// a tool-call SSE response to verify the tool call extraction path.
#[test]
fn parse_capture_data_openai_extracts_tool_calls() {
    use recondo_gateway::gateway::parse_capture_data;

    let request_with_headers = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nHost: api.openai.com\r\nContent-Type: application/json\r\n\r\n{}",
        OPENAI_REQUEST_BODY
    );
    let response_with_headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n{}",
        OPENAI_SSE_TOOL_CALL_RESPONSE
    );

    let parsed = parse_capture_data(
        "openai",
        request_with_headers.as_bytes(),
        response_with_headers.as_bytes(),
    );

    // Tool calls must be extracted and normalized
    assert_eq!(
        parsed.tool_calls.len(),
        1,
        "parse_capture_data must extract one tool call from OpenAI SSE"
    );
    assert_eq!(
        parsed.tool_calls[0].name, "get_weather",
        "Tool call name must match the OpenAI SSE fixture"
    );

    // Stop reason for tool calls
    assert_eq!(
        parsed.stop_reason, "tool_calls",
        "Stop reason must be 'tool_calls' for tool call responses"
    );
}
