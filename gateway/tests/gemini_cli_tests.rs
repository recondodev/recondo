//! Tests for Gemini CLI capture support in the Recondo gateway.
//!
//! Covers:
//! - Provider detection for `cloudcode-*.googleapis.com` hosts
//! - Path matching for `/v1internal:generateContent` and `/v1internal:streamGenerateContent`
//! - Request parsing (model, session_id, system prompt, user prompt, project, tools)
//! - SSE response parsing (thinking, text, usage metadata with token counts)
//! - End-to-end DB round-trip through `process_capture`
//!
//! The Gemini CLI format differs from the standard Gemini API: requests are
//! wrapped in a `request` object with `session_id` and `project` fields, and
//! SSE response events wrap their payload in a `response` object.

use recondo_gateway::gateway;
use recondo_gateway::providers;
use recondo_gateway::session::SessionManager;

mod common;
use common::pipeline::make_pipeline;

// ===========================================================================
// Fixture data: realistic Gemini CLI request/response payloads
// ===========================================================================

/// A realistic Gemini CLI request body, based on captured traffic.
/// Note the nested `request` object and top-level `model`/`project`/`user_prompt_id`.
const GEMINI_CLI_REQUEST: &str = r#"{
    "model": "gemini-3-flash-preview",
    "project": "mindful-fulcrum-5jkxm",
    "user_prompt_id": "6ccb0bd170c9c8",
    "request": {
        "session_id": "e508fe15-a7a6-470a-b74e-ce94b0da7079",
        "systemInstruction": {
            "parts": [{"text": "You are Gemini CLI, an autonomous CLI agent designed to help developers."}]
        },
        "contents": [
            {"role": "user", "parts": [{"text": "<session_context>project: myapp</session_context>"}]},
            {"role": "model", "parts": [{"text": "I understand. How can I help?"}]},
            {"role": "user", "parts": [{"text": "say hello"}]}
        ],
        "tools": [
            {"functionDeclarations": [{"name": "list_directory"}, {"name": "read_file"}, {"name": "write_file"}]}
        ],
        "generationConfig": {
            "temperature": 1,
            "thinkingConfig": {"includeThoughts": true, "thinkingLevel": "HIGH"}
        }
    }
}"#;

/// A Gemini CLI request with no systemInstruction.
const GEMINI_CLI_REQUEST_NO_SYSTEM: &str = r#"{
    "model": "gemini-3-flash-preview",
    "project": "mindful-fulcrum-5jkxm",
    "user_prompt_id": "abc123",
    "request": {
        "session_id": "aaaa-bbbb-cccc-dddd",
        "contents": [
            {"role": "user", "parts": [{"text": "what time is it?"}]}
        ]
    }
}"#;

/// SSE event 1: thinking part (thought=true).
const SSE_EVENT_THINKING: &str = r#"{"response": {"candidates": [{"content": {"role": "model", "parts": [{"thought": true, "text": "The user wants a greeting. I should respond with a friendly hello."}]}}], "usageMetadata": {"trafficType": "PROVISIONED_THROUGHPUT"}, "modelVersion": "gemini-3-flash-preview"}}"#;

/// SSE event 2: partial text output.
const SSE_EVENT_TEXT_PARTIAL: &str = r#"{"response": {"candidates": [{"content": {"role": "model", "parts": [{"text": "Hello! I'm Gemini CLI"}]}}], "modelVersion": "gemini-3-flash-preview"}}"#;

/// SSE event 3: final text with finishReason and full usageMetadata.
const SSE_EVENT_FINAL: &str = r#"{"response": {"candidates": [{"content": {"role": "model", "parts": [{"text": ", your assistant."}]}, "finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 7535, "candidatesTokenCount": 24, "totalTokenCount": 7621, "cachedContentTokenCount": 7093, "thoughtsTokenCount": 62}, "modelVersion": "gemini-3-flash-preview"}}"#;

/// Build raw SSE bytes from a list of data strings (no event type prefix needed
/// for Gemini CLI -- it uses bare `data:` lines).
fn build_gemini_cli_sse_bytes(events: &[&str]) -> Vec<u8> {
    let mut buf = String::new();
    for data in events {
        buf.push_str(&format!("data: {}\n\n", data));
    }
    buf.into_bytes()
}

// ===========================================================================
// Category 1: Provider detection (3 tests)
// ===========================================================================

/// **Proves:** `cloudcode-pa.googleapis.com` is detected as provider "google".
/// **Anti-fake property:** The detection must match the `cloudcode-*` pattern,
/// not just `generativelanguage.googleapis.com`.
#[test]
fn cloudcode_pa_detected_as_google_provider() {
    let provider = providers::detect_provider("cloudcode-pa.googleapis.com");
    assert_eq!(
        provider, "google",
        "cloudcode-pa.googleapis.com must be detected as 'google'"
    );
}

/// **Proves:** `cloudcode-us-central1.googleapis.com` is detected as "google".
/// **Anti-fake property:** Region-specific cloudcode hosts must match.
#[test]
fn cloudcode_us_central1_detected_as_google_provider() {
    let provider = providers::detect_provider("cloudcode-us-central1.googleapis.com");
    assert_eq!(
        provider, "google",
        "cloudcode-us-central1.googleapis.com must be detected as 'google'"
    );
}

/// **Proves:** `cloudcode-europe-west1.googleapis.com` is detected as "google".
/// **Anti-fake property:** European regions must also be detected.
#[test]
fn cloudcode_europe_west1_detected_as_google_provider() {
    let provider = providers::detect_provider("cloudcode-europe-west1.googleapis.com");
    assert_eq!(
        provider, "google",
        "cloudcode-europe-west1.googleapis.com must be detected as 'google'"
    );
}

// ===========================================================================
// Category 2: Path matching via should_intercept (3 tests)
// ===========================================================================

/// **Proves:** POST to `/v1internal:generateContent` is intercepted for provider "google".
/// **Anti-fake property:** The gateway must recognize Gemini CLI's non-standard
/// colon-separated path format, not just standard `/v1beta/models/*/generateContent`.
#[test]
fn v1internal_generate_content_is_intercepted() {
    let request_line =
        b"POST /v1internal:generateContent HTTP/1.1\r\nHost: cloudcode-pa.googleapis.com\r\n\r\n";
    let decision = gateway::should_intercept(request_line, "google");
    assert!(
        decision.should_capture,
        "POST /v1internal:generateContent must be captured for provider 'google'"
    );
    assert_eq!(decision.method.as_deref(), Some("POST"));
}

/// **Proves:** POST to `/v1internal:streamGenerateContent` is intercepted for provider "google".
/// **Anti-fake property:** The streaming variant must also be captured.
#[test]
fn v1internal_stream_generate_content_is_intercepted() {
    let request_line = b"POST /v1internal:streamGenerateContent HTTP/1.1\r\nHost: cloudcode-pa.googleapis.com\r\n\r\n";
    let decision = gateway::should_intercept(request_line, "google");
    assert!(
        decision.should_capture,
        "POST /v1internal:streamGenerateContent must be captured for provider 'google'"
    );
    assert_eq!(decision.method.as_deref(), Some("POST"));
}

/// **Proves:** POST to `/v1internal:loadCodeAssist` is NOT intercepted.
/// **Anti-fake property:** Only generation endpoints should be captured, not
/// arbitrary v1internal paths.
#[test]
fn v1internal_load_code_assist_is_not_intercepted() {
    let request_line =
        b"POST /v1internal:loadCodeAssist HTTP/1.1\r\nHost: cloudcode-pa.googleapis.com\r\n\r\n";
    let decision = gateway::should_intercept(request_line, "google");
    assert!(
        !decision.should_capture,
        "POST /v1internal:loadCodeAssist must NOT be captured"
    );
}

// ===========================================================================
// Category 3: Request parsing (8 tests)
//
// These tests call `providers::google::parse_gemini_cli_request` which does
// not exist yet -- they SHOULD FAIL until implemented.
// ===========================================================================

/// **Proves:** Gemini CLI request parsing extracts the model name from the
/// top-level `model` field (not from the URL path like standard Gemini).
/// **Anti-fake property:** Must return "gemini-3-flash-preview", not an empty string.
#[test]
fn parse_gemini_cli_request_extracts_model() {
    let parsed = providers::google::parse_gemini_cli_request(GEMINI_CLI_REQUEST.as_bytes())
        .expect("parse must succeed for valid request");
    assert_eq!(
        parsed.model, "gemini-3-flash-preview",
        "Model must be extracted from the top-level 'model' field"
    );
}

/// **Proves:** Gemini CLI request parsing extracts the session_id from
/// `request.session_id`.
/// **Anti-fake property:** Must return the exact UUID from the fixture.
#[test]
fn parse_gemini_cli_request_extracts_session_id() {
    let parsed = providers::google::parse_gemini_cli_request(GEMINI_CLI_REQUEST.as_bytes())
        .expect("parse must succeed for valid request");
    assert_eq!(
        parsed.session_id.as_deref(),
        Some("e508fe15-a7a6-470a-b74e-ce94b0da7079"),
        "session_id must be extracted from request.session_id"
    );
}

/// **Proves:** Gemini CLI request parsing extracts the system prompt from
/// `request.systemInstruction.parts[0].text`.
/// **Anti-fake property:** Must contain the actual system prompt text, not None.
#[test]
fn parse_gemini_cli_request_extracts_system_prompt() {
    let parsed = providers::google::parse_gemini_cli_request(GEMINI_CLI_REQUEST.as_bytes())
        .expect("parse must succeed for valid request");
    assert!(
        parsed.system.is_some(),
        "system must be Some when systemInstruction is present"
    );
    let system = parsed.system.unwrap();
    assert!(
        system.contains("Gemini CLI"),
        "System prompt must contain the instruction text, got: {:?}",
        system
    );
}

/// **Proves:** Gemini CLI request parsing extracts the user prompt as the last
/// contents entry with role "user".
/// **Anti-fake property:** Must pick the last user message ("say hello"),
/// not the first ("<session_context>...").
#[test]
fn parse_gemini_cli_request_extracts_last_user_prompt() {
    let parsed = providers::google::parse_gemini_cli_request(GEMINI_CLI_REQUEST.as_bytes())
        .expect("parse must succeed for valid request");
    // messages should contain the contents array
    assert!(!parsed.messages.is_empty(), "messages must not be empty");
    // The last user message text should be "say hello"
    let last_user = parsed
        .messages
        .iter()
        .rev()
        .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        .expect("Must have at least one user message");
    let text = last_user
        .get("parts")
        .and_then(|p| p.as_array())
        .and_then(|arr| arr.first())
        .and_then(|p| p.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
    assert_eq!(text, "say hello", "Last user message must be 'say hello'");
}

/// **Proves:** Gemini CLI request parsing extracts the project field.
/// **Anti-fake property:** Must return the exact project string from the fixture.
#[test]
fn parse_gemini_cli_request_extracts_project() {
    let parsed = providers::google::parse_gemini_cli_request(GEMINI_CLI_REQUEST.as_bytes())
        .expect("parse must succeed for valid request");
    assert_eq!(
        parsed.project.as_deref(),
        Some("mindful-fulcrum-5jkxm"),
        "project must be extracted from the top-level 'project' field"
    );
}

/// **Proves:** Gemini CLI request parsing counts tools correctly from the
/// nested `functionDeclarations` arrays.
/// **Anti-fake property:** The fixture has 3 tools (list_directory, read_file,
/// write_file). Must not return 0 or 1.
#[test]
fn parse_gemini_cli_request_extracts_tool_count() {
    let parsed = providers::google::parse_gemini_cli_request(GEMINI_CLI_REQUEST.as_bytes())
        .expect("parse must succeed for valid request");
    assert!(
        parsed.tools.is_some(),
        "tools must be Some when tools are present"
    );
    let tools = parsed.tools.unwrap();
    // tools should contain the functionDeclarations array
    assert!(!tools.is_empty(), "tools array must not be empty");
    // Count total function declarations across all tool entries
    let total_functions: usize = tools
        .iter()
        .filter_map(|t| t.get("functionDeclarations"))
        .filter_map(|fd| fd.as_array())
        .map(|arr| arr.len())
        .sum();
    assert_eq!(
        total_functions, 3,
        "Must have 3 function declarations: list_directory, read_file, write_file"
    );
}

/// **Proves:** Gemini CLI request parsing handles missing systemInstruction gracefully.
/// **Anti-fake property:** Must return system=None, not panic or error.
#[test]
fn parse_gemini_cli_request_no_system_instruction() {
    let parsed =
        providers::google::parse_gemini_cli_request(GEMINI_CLI_REQUEST_NO_SYSTEM.as_bytes())
            .expect("parse must succeed even without systemInstruction");
    assert!(
        parsed.system.is_none(),
        "system must be None when systemInstruction is absent"
    );
    assert_eq!(
        parsed.model, "gemini-3-flash-preview",
        "Model must still be extracted"
    );
}

/// **Proves:** Gemini CLI request parsing does not panic on malformed JSON.
/// **Anti-fake property:** Must return Err, not panic.
#[test]
fn parse_gemini_cli_request_malformed_json() {
    let garbage = b"this is not json {{{";
    let result = providers::google::parse_gemini_cli_request(garbage);
    assert!(result.is_err(), "Malformed JSON must return Err, not panic");
}

// ===========================================================================
// Category 4: Response parsing (8 tests)
//
// These tests call `providers::google::parse_gemini_cli_sse_response` which
// does not exist yet -- they SHOULD FAIL until implemented.
// ===========================================================================

/// **Proves:** Gemini CLI SSE parsing extracts thinking text from parts with
/// `thought: true`.
/// **Anti-fake property:** Must distinguish thinking parts from regular text.
#[test]
fn parse_gemini_cli_response_extracts_thinking_text() {
    let sse_bytes = build_gemini_cli_sse_bytes(&[SSE_EVENT_THINKING]);
    let parsed =
        providers::google::parse_gemini_cli_sse_response(&sse_bytes).expect("parse must succeed");
    assert!(
        parsed.thinking_text.is_some(),
        "thinking_text must be Some for events with thought=true parts"
    );
    let thinking = parsed.thinking_text.unwrap();
    assert!(
        thinking.contains("The user wants a greeting"),
        "thinking_text must contain the thought content, got: {:?}",
        thinking
    );
}

/// **Proves:** Gemini CLI SSE parsing extracts regular text parts (non-thinking).
/// **Anti-fake property:** Text from thinking parts must NOT appear in response_text.
#[test]
fn parse_gemini_cli_response_extracts_text() {
    let sse_bytes = build_gemini_cli_sse_bytes(&[SSE_EVENT_TEXT_PARTIAL, SSE_EVENT_FINAL]);
    let parsed =
        providers::google::parse_gemini_cli_sse_response(&sse_bytes).expect("parse must succeed");
    assert_eq!(
        parsed.response_text, "Hello! I'm Gemini CLI, your assistant.",
        "Text parts must be concatenated into response_text"
    );
}

/// **Proves:** Gemini CLI SSE parsing extracts finishReason as stop_reason.
/// **Anti-fake property:** Must map "STOP" appropriately (either "STOP" or "end_turn").
#[test]
fn parse_gemini_cli_response_extracts_stop_reason() {
    let sse_bytes = build_gemini_cli_sse_bytes(&[SSE_EVENT_FINAL]);
    let parsed =
        providers::google::parse_gemini_cli_sse_response(&sse_bytes).expect("parse must succeed");
    // The existing Gemini parser maps STOP -> end_turn. The CLI parser
    // should use the same mapping for consistency.
    assert!(
        !parsed.stop_reason.is_empty(),
        "stop_reason must not be empty when finishReason is present"
    );
    // Accept either "end_turn" (mapped) or "STOP" (raw) -- implementation decides
    assert!(
        parsed.stop_reason == "end_turn" || parsed.stop_reason == "STOP",
        "stop_reason must be 'end_turn' or 'STOP', got: {:?}",
        parsed.stop_reason
    );
}

/// **Proves:** Gemini CLI SSE parsing extracts full usage metadata including
/// thinking tokens and cache tokens from the final event.
/// **Anti-fake property:** All four token fields must match the fixture values.
#[test]
fn parse_gemini_cli_response_extracts_usage_metadata() {
    let sse_bytes = build_gemini_cli_sse_bytes(&[SSE_EVENT_FINAL]);
    let parsed =
        providers::google::parse_gemini_cli_sse_response(&sse_bytes).expect("parse must succeed");
    assert_eq!(
        parsed.input_tokens, 7535,
        "input_tokens must be extracted from promptTokenCount"
    );
    assert_eq!(
        parsed.output_tokens, 24,
        "output_tokens must be extracted from candidatesTokenCount"
    );
    assert_eq!(
        parsed.cache_read_tokens, 7093,
        "cache_read_tokens must be extracted from cachedContentTokenCount"
    );
    // G-N1 fix: Assert the exact thinking_tokens value directly from the
    // dedicated field. The fixture SSE_EVENT_FINAL has thoughtsTokenCount: 62.
    assert_eq!(
        parsed.thinking_tokens,
        Some(62),
        "thinking_tokens must be extracted as 62 from usageMetadata.thoughtsTokenCount"
    );
}

/// **Proves:** Gemini CLI SSE parsing extracts modelVersion as the model name.
/// **Anti-fake property:** Must return "gemini-3-flash-preview" from the SSE event,
/// not empty string.
#[test]
fn parse_gemini_cli_response_extracts_model_version() {
    let sse_bytes = build_gemini_cli_sse_bytes(&[SSE_EVENT_FINAL]);
    let parsed =
        providers::google::parse_gemini_cli_sse_response(&sse_bytes).expect("parse must succeed");
    assert_eq!(
        parsed.model, "gemini-3-flash-preview",
        "model must be extracted from response.modelVersion"
    );
}

/// **Proves:** Gemini CLI SSE parsing concatenates text across multiple events.
/// **Anti-fake property:** With 3 events (thinking + 2 text), response_text
/// must contain both text fragments but NOT the thinking text.
#[test]
fn parse_gemini_cli_response_multi_event_concatenation() {
    let sse_bytes =
        build_gemini_cli_sse_bytes(&[SSE_EVENT_THINKING, SSE_EVENT_TEXT_PARTIAL, SSE_EVENT_FINAL]);
    let parsed =
        providers::google::parse_gemini_cli_sse_response(&sse_bytes).expect("parse must succeed");

    // Text from text-only parts should be concatenated
    assert_eq!(
        parsed.response_text, "Hello! I'm Gemini CLI, your assistant.",
        "Text parts across events must be concatenated"
    );
    // Thinking text should be separate
    assert!(
        parsed.thinking_text.is_some(),
        "thinking_text must be populated from thought=true parts"
    );
    // response_text must NOT contain thinking text
    assert!(
        !parsed.response_text.contains("The user wants a greeting"),
        "response_text must NOT include thinking text"
    );
}

/// **Proves:** Gemini CLI SSE parsing correctly unwraps the `response` object
/// wrapper that distinguishes CLI format from standard Gemini.
/// **Anti-fake property:** A parser that expects bare candidates (like the
/// standard Gemini parser) would fail to find any data inside the wrapper.
#[test]
fn parse_gemini_cli_response_unwraps_response_object() {
    // Single event with response wrapper
    let sse_bytes = build_gemini_cli_sse_bytes(&[SSE_EVENT_TEXT_PARTIAL]);
    let parsed =
        providers::google::parse_gemini_cli_sse_response(&sse_bytes).expect("parse must succeed");
    assert_eq!(
        parsed.response_text, "Hello! I'm Gemini CLI",
        "Parser must unwrap the 'response' object to access candidates"
    );
    assert_eq!(
        parsed.model, "gemini-3-flash-preview",
        "Parser must unwrap 'response' to access modelVersion"
    );
}

/// **Proves:** Gemini CLI SSE parsing handles empty/malformed data gracefully.
/// **Anti-fake property:** Must not panic; must return safe defaults or Err.
#[test]
fn parse_gemini_cli_response_empty_input() {
    let empty = b"";
    let result = providers::google::parse_gemini_cli_sse_response(empty);
    // Either Err or Ok with empty defaults — must not panic
    match result {
        Ok(parsed) => {
            assert!(
                parsed.response_text.is_empty(),
                "Empty input should produce empty response_text"
            );
        }
        Err(_) => {
            // Also acceptable: returning an error for no events
        }
    }
}

// ===========================================================================
// Category 5: End-to-end DB round-trip (3 tests)
//
// These tests exercise the full `process_capture` pipeline with Gemini CLI
// request and response payloads.
// ===========================================================================

/// **Proves:** A Gemini CLI request+response round-trips through process_capture
/// and produces a SessionRecord with model, system_prompt_hash, and initial_intent.
///
/// **Anti-fake property:** Without Gemini CLI request parsing, model would come
/// only from the response (which is acceptable), but system_prompt_hash would be
/// the sentinel value and initial_intent would be None.
#[test]
fn e2e_gemini_cli_session_record_populated() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let request_bytes = GEMINI_CLI_REQUEST.as_bytes();
    let response_bytes =
        build_gemini_cli_sse_bytes(&[SSE_EVENT_THINKING, SSE_EVENT_TEXT_PARTIAL, SSE_EVENT_FINAL]);

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "google",
        request_bytes,
        &response_bytes,
        None, // no WAL
        None, // no metrics registry
    )
    .expect("process_capture_with_pipeline must succeed for Gemini CLI");

    // Model should be extracted (from request or response)
    assert_eq!(
        turn.model.as_deref(),
        Some("gemini-3-flash-preview"),
        "Model must be extracted from Gemini CLI request/response"
    );

    // Session should exist in graph store
    let session = pipeline
        .graph()
        .get_session(&turn.session_id)
        .expect("graph query must succeed")
        .expect("Session must exist");
    assert_eq!(
        session.model.as_deref(),
        Some("gemini-3-flash-preview"),
        "Session model must be populated"
    );

    // With Gemini CLI request parsing, the system prompt should produce
    // a non-sentinel hash. The sentinel is sha256(b"__RECONDO_NO_SYSTEM_PROMPT__"),
    // NOT sha256 of the empty string.
    let sentinel_hash = recondo_gateway::session::compute_system_prompt_hash(None);
    assert_ne!(
        session.system_prompt_hash, sentinel_hash,
        "system_prompt_hash must NOT be the no-system-prompt sentinel when a system prompt is present"
    );

    // initial_intent should be extracted from the last user message
    assert!(
        session.initial_intent.is_some(),
        "initial_intent must be populated from the last user message"
    );
    let intent = session.initial_intent.unwrap();
    assert!(
        intent.contains("say hello"),
        "initial_intent should contain 'say hello', got: {:?}",
        intent
    );
}

/// **Proves:** A Gemini CLI request+response round-trips through process_capture
/// and produces a TurnRecord with response_text, thinking_text, and correct
/// token counts.
///
/// **Anti-fake property:** Without the CLI-specific response parser that unwraps
/// the `response` object, the standard Gemini parser would find no candidates
/// and return empty response_text and zero tokens.
#[test]
fn e2e_gemini_cli_turn_record_populated() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let request_bytes = GEMINI_CLI_REQUEST.as_bytes();
    let response_bytes =
        build_gemini_cli_sse_bytes(&[SSE_EVENT_THINKING, SSE_EVENT_TEXT_PARTIAL, SSE_EVENT_FINAL]);

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "google",
        request_bytes,
        &response_bytes,
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed for Gemini CLI");

    // Response text must be the concatenation of non-thinking text parts
    assert_eq!(
        turn.response_text.as_deref(),
        Some("Hello! I'm Gemini CLI, your assistant."),
        "response_text must concatenate all non-thinking text parts"
    );

    // Thinking text must be captured separately
    assert!(
        turn.thinking_text.is_some(),
        "thinking_text must be populated from thought=true parts"
    );
    let thinking = turn.thinking_text.as_ref().unwrap();
    assert!(
        thinking.contains("The user wants a greeting"),
        "thinking_text must contain the thought content"
    );

    // Token counts must come from the final usageMetadata
    assert_eq!(
        turn.input_tokens, 7535,
        "input_tokens must be extracted from promptTokenCount"
    );
    assert_eq!(
        turn.output_tokens, 24,
        "output_tokens must be extracted from candidatesTokenCount"
    );
    assert_eq!(
        turn.cache_read_tokens, 7093,
        "cache_read_tokens must be extracted from cachedContentTokenCount"
    );

    // Provider must be google
    assert_eq!(
        turn.provider.as_deref(),
        Some("google"),
        "Provider must be google for Gemini CLI"
    );

    // Verify graph-store round-trip
    let db_turn = pipeline
        .graph()
        .get_turn(&turn.id)
        .expect("graph query must succeed")
        .expect("Turn must exist in graph store");
    assert_eq!(
        db_turn.response_text.as_deref(),
        Some("Hello! I'm Gemini CLI, your assistant.")
    );
    assert_eq!(db_turn.input_tokens, 7535);
    assert_eq!(db_turn.output_tokens, 24);
}

/// **Proves (negative):** Without Gemini CLI-specific parsing, the standard
/// Gemini response parser cannot extract data from response-wrapped SSE events.
///
/// **Anti-fake property:** This test demonstrates that passing CLI-format SSE
/// through the standard `google::parse_response` (which expects bare candidates)
/// produces empty/zero results, proving the CLI parser adds real value.
#[test]
fn negative_standard_gemini_parser_fails_on_cli_format() {
    use recondo_gateway::stream;

    let sse_bytes = build_gemini_cli_sse_bytes(&[SSE_EVENT_TEXT_PARTIAL, SSE_EVENT_FINAL]);

    // Parse SSE events using the standard stream parser
    let accumulated = stream::parse_sse_stream(&sse_bytes);

    // The standard google::parse_response expects bare candidates at top level,
    // but CLI format wraps everything in a "response" object. The standard
    // parser should fail to extract meaningful data.
    let result = providers::google::parse_response(&accumulated.events);
    match result {
        Ok(parsed) => {
            // If it doesn't error, it should produce empty/zero values because
            // the candidates are nested under "response" and not at top level.
            let has_no_text = parsed.response_text.is_empty();
            let has_no_tokens = parsed.input_tokens == 0 && parsed.output_tokens == 0;
            let has_no_model = parsed.model.is_empty();
            assert!(
                has_no_text || has_no_tokens || has_no_model,
                "Standard Gemini parser should NOT extract full data from CLI-wrapped format. \
                 Got response_text={:?}, input_tokens={}, model={:?}",
                parsed.response_text,
                parsed.input_tokens,
                parsed.model,
            );
        }
        Err(_) => {
            // Also acceptable: the standard parser errors on CLI format
        }
    }
}

// ===========================================================================
// Category 6: Session identity from client_session_id (G-N3)
//
// Verifies that the Gemini CLI `request.session_id` produces deterministic
// session identity: two requests with the same session_id should resolve
// to the same session hash.
// ===========================================================================

/// **Proves:** Two Gemini CLI requests with the same `request.session_id` produce
/// the same session ID in the database, demonstrating deterministic session
/// identity propagation.
///
/// **Anti-fake property:** Without `client_session_id` propagation, each request
/// would fall back to content-based session derivation, which would produce
/// different session IDs for requests with different user messages.
#[test]
fn gemini_cli_session_id_deterministic_from_client_session_id() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    // First request with session_id "e508fe15-a7a6-470a-b74e-ce94b0da7079"
    let request1 = GEMINI_CLI_REQUEST.as_bytes();
    let response1 = build_gemini_cli_sse_bytes(&[SSE_EVENT_FINAL]);

    let turn1 = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "google",
        request1,
        &response1,
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed for first request");

    // Second request with SAME session_id but different user message
    let request2_json = r#"{
        "model": "gemini-3-flash-preview",
        "project": "mindful-fulcrum-5jkxm",
        "user_prompt_id": "different-prompt-id",
        "request": {
            "session_id": "e508fe15-a7a6-470a-b74e-ce94b0da7079",
            "systemInstruction": {
                "parts": [{"text": "You are Gemini CLI, an autonomous CLI agent designed to help developers."}]
            },
            "contents": [
                {"role": "user", "parts": [{"text": "now say goodbye"}]}
            ]
        }
    }"#;
    let request2 = request2_json.as_bytes();
    let response2 = build_gemini_cli_sse_bytes(&[SSE_EVENT_FINAL]);

    let turn2 = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "google",
        request2,
        &response2,
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed for second request");

    // Both turns must be in the same session because they share the same
    // client session_id ("e508fe15-a7a6-470a-b74e-ce94b0da7079").
    assert_eq!(
        turn1.session_id, turn2.session_id,
        "Two requests with the same Gemini CLI session_id must produce the same \
         session hash. Got turn1={}, turn2={}",
        turn1.session_id, turn2.session_id
    );

    // The session ID should be a SHA-256 hash of the session_id value,
    // not the raw session_id itself (H1 normalization).
    assert_ne!(
        turn1.session_id, "e508fe15-a7a6-470a-b74e-ce94b0da7079",
        "Session ID must be a SHA-256 hash of the client session_id, not the raw value"
    );
}
