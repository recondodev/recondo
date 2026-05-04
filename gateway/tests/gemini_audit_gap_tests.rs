//! Behavioral tests for Gemini audit gap findings.
//!
//! These tests were written BEFORE the implementation exists. Each test targets
//! a specific audit finding and asserts on externally observable behavior.
//!
//! Audit findings covered:
//!   F1 — compute_cost_usd returns $0.00 for all Gemini models
//!   F2 — detect_agent_framework does not recognize Gemini CLI
//!   F3 — GeminiCliRequestData.project parsed but never stored
//!   F4 — Standard Gemini API path does not parse requests
//!   F8 — Gemini tool format differs from Anthropic (functionDeclarations)
//!   F9 — KNOWN_TOP_LEVEL_FIELDS duplicated between CLI and standard parsers
//!  F10 — Misleading sentinel hash comment (sha256 of empty string vs sentinel)
//!  F11 — Standard Gemini parse_response hardcodes thinking_text: None

use recondo_gateway::db;
use recondo_gateway::gateway;
use recondo_gateway::hash;

// Test wrapper: delegates to the externalized canonical pricing table with
// a fresh `now_utc()` timestamp. Lets these tests keep their original
// (model, input, output, cc, cr) shape after Batch 5 H4.
fn compute_cost_usd_now(
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

use recondo_gateway::providers;
use recondo_gateway::session;
use recondo_gateway::session::SessionManager;
use recondo_gateway::stream;

mod common;
use common::pipeline::make_pipeline;

// ===========================================================================
// Fixture data
// ===========================================================================

/// Gemini CLI request with a system prompt containing "You are Gemini CLI".
const GEMINI_CLI_REQUEST_WITH_SYSTEM: &str = r#"{
    "model": "gemini-2.5-flash",
    "project": "my-project-abc123",
    "user_prompt_id": "prompt-001",
    "request": {
        "session_id": "f1a2b3c4-d5e6-7890-abcd-ef1234567890",
        "systemInstruction": {
            "parts": [{"text": "You are Gemini CLI, an autonomous CLI agent designed to help developers with coding tasks."}]
        },
        "contents": [
            {"role": "user", "parts": [{"text": "What is 2+2?"}]}
        ],
        "tools": [
            {"functionDeclarations": [{"name": "execute_command"}, {"name": "read_file"}]}
        ]
    }
}"#;

/// Standard Gemini API request (no `request` wrapper — top-level `contents`).
const STANDARD_GEMINI_REQUEST: &str = r#"{
    "contents": [
        {"role": "user", "parts": [{"text": "Explain quantum computing"}]},
        {"role": "model", "parts": [{"text": "Quantum computing uses qubits..."}]},
        {"role": "user", "parts": [{"text": "Give me an example"}]}
    ],
    "systemInstruction": {
        "parts": [{"text": "You are a helpful science tutor."}]
    },
    "tools": [
        {"functionDeclarations": [{"name": "search_web", "description": "Search the web"}]}
    ]
}"#;

/// Standard Gemini SSE response with thinking parts (Gemini 2.5+ thinking).
/// Uses bare top-level format (no `response` wrapper — standard API format).
fn standard_gemini_sse_with_thinking() -> Vec<u8> {
    let event1_data = r#"{"candidates":[{"content":{"parts":[{"thought":true,"text":"Let me think about this carefully."}],"role":"model"}}],"usageMetadata":{"promptTokenCount":100},"modelVersion":"gemini-2.5-pro"}"#;
    let event2_data = r#"{"candidates":[{"content":{"parts":[{"text":"Here is my answer."}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":25,"totalTokenCount":175,"cachedContentTokenCount":50,"thoughtsTokenCount":40},"modelVersion":"gemini-2.5-pro"}"#;
    let mut buf = String::new();
    buf.push_str(&format!("event: message\ndata: {}\n\n", event1_data));
    buf.push_str(&format!("event: message\ndata: {}\n\n", event2_data));
    buf.into_bytes()
}

/// Standard Gemini SSE response without thinking (basic text response).
fn standard_gemini_sse_basic() -> Vec<u8> {
    let event_data = r#"{"candidates":[{"content":{"parts":[{"text":"Hello from Gemini!"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15},"modelVersion":"gemini-2.5-flash"}"#;
    let mut buf = String::new();
    buf.push_str(&format!("event: message\ndata: {}\n\n", event_data));
    buf.into_bytes()
}

/// Standard Gemini SSE response with cache tokens but no thinking.
fn standard_gemini_sse_with_cache() -> Vec<u8> {
    let event_data = r#"{"candidates":[{"content":{"parts":[{"text":"Cached response."}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":200,"candidatesTokenCount":10,"totalTokenCount":260,"cachedContentTokenCount":150},"modelVersion":"gemini-2.5-flash"}"#;
    let mut buf = String::new();
    buf.push_str(&format!("event: message\ndata: {}\n\n", event_data));
    buf.into_bytes()
}

/// Build SSE bytes in the Gemini CLI format (bare `data:` lines, `response` wrapper).
fn build_gemini_cli_sse_bytes(events: &[&str]) -> Vec<u8> {
    let mut buf = String::new();
    for data in events {
        buf.push_str(&format!("data: {}\n\n", data));
    }
    buf.into_bytes()
}

/// SSE event for a Gemini CLI response with thinking + text + usage.
const CLI_SSE_FINAL: &str = r#"{"response": {"candidates": [{"content": {"role": "model", "parts": [{"thought": true, "text": "Thinking..."}, {"text": "The answer is 4."}]}, "finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 500, "candidatesTokenCount": 10, "cachedContentTokenCount": 200, "thoughtsTokenCount": 30}, "modelVersion": "gemini-2.5-flash"}}"#;

// ===========================================================================
// Finding 1: compute_cost_usd returns $0.00 for all Gemini models
//
// The pricing function has entries for Anthropic and OpenAI models but
// returns 0.0 for any Gemini model prefix. These tests assert that
// Gemini models produce non-zero costs.
// ===========================================================================

/// **Proves:** compute_cost_usd returns non-zero for gemini-2.5-flash.
/// **Anti-fake:** A function that only matches "claude-*" and "gpt-*" prefixes
/// would return 0.0, failing this test.
#[test]
fn cost_gemini_2_5_flash_is_nonzero() {
    let cost = compute_cost_usd_now("gemini-2.5-flash", 1_000_000, 1_000_000, 0, 0);
    assert!(
        cost > 0.0,
        "gemini-2.5-flash must have non-zero cost, got {}",
        cost
    );
}

/// **Proves:** compute_cost_usd returns non-zero for gemini-2.5-pro.
/// **Anti-fake:** gemini-2.5-pro is a different price tier than flash.
#[test]
fn cost_gemini_2_5_pro_is_nonzero() {
    let cost = compute_cost_usd_now("gemini-2.5-pro", 1_000_000, 1_000_000, 0, 0);
    assert!(
        cost > 0.0,
        "gemini-2.5-pro must have non-zero cost, got {}",
        cost
    );
}

/// **Proves:** compute_cost_usd returns non-zero for gemini-2.5-flash-lite.
/// **Anti-fake:** flash-lite is a distinct SKU from flash; must not fall through.
#[test]
fn cost_gemini_2_5_flash_lite_is_nonzero() {
    let cost = compute_cost_usd_now("gemini-2.5-flash-lite", 1_000_000, 1_000_000, 0, 0);
    assert!(
        cost > 0.0,
        "gemini-2.5-flash-lite must have non-zero cost, got {}",
        cost
    );
}

/// **Proves:** gemini-2.5-pro is more expensive than gemini-2.5-flash.
/// **Anti-fake:** If all Gemini models share the same price, this fails.
#[test]
fn cost_gemini_pro_more_expensive_than_flash() {
    let pro_cost = compute_cost_usd_now("gemini-2.5-pro", 1_000_000, 1_000_000, 0, 0);
    let flash_cost = compute_cost_usd_now("gemini-2.5-flash", 1_000_000, 1_000_000, 0, 0);
    assert!(
        pro_cost > flash_cost,
        "gemini-2.5-pro (${}) must cost more than gemini-2.5-flash (${})",
        pro_cost,
        flash_cost
    );
}

/// **Proves:** gemini-2.5-flash-lite is cheaper than gemini-2.5-flash.
/// **Anti-fake:** flash-lite must have a lower rate than flash.
#[test]
fn cost_gemini_flash_lite_cheaper_than_flash() {
    let flash_cost = compute_cost_usd_now("gemini-2.5-flash", 1_000_000, 1_000_000, 0, 0);
    let lite_cost = compute_cost_usd_now("gemini-2.5-flash-lite", 1_000_000, 1_000_000, 0, 0);
    assert!(
        lite_cost < flash_cost,
        "gemini-2.5-flash-lite (${}) must cost less than gemini-2.5-flash (${})",
        lite_cost,
        flash_cost
    );
}

/// **Proves (negative):** An unknown model prefix still returns $0.00.
/// **Anti-fake:** Ensures the Gemini pricing additions do not accidentally
/// catch all model names.
#[test]
fn cost_unknown_model_still_zero() {
    let cost = compute_cost_usd_now("totally-unknown-model-xyz", 1_000_000, 1_000_000, 0, 0);
    assert_eq!(cost, 0.0, "Unknown model must still return $0.00");
}

/// **Proves:** Gemini model with suffixed version (e.g., "gemini-2.5-flash-preview-05-20")
/// still gets a non-zero cost because the pricing uses starts_with matching.
#[test]
fn cost_gemini_model_with_version_suffix() {
    let cost = compute_cost_usd_now("gemini-2.5-flash-preview-05-20", 1_000_000, 1_000_000, 0, 0);
    assert!(
        cost > 0.0,
        "gemini-2.5-flash with version suffix must have non-zero cost, got {}",
        cost
    );
}

/// **Proves:** Gemini cache tokens produce a cost contribution.
/// **Anti-fake:** Cache read tokens at a non-zero rate must increase total cost
/// compared to the same call with zero cache tokens.
#[test]
fn cost_gemini_cache_tokens_contribute() {
    let cost_without_cache = compute_cost_usd_now("gemini-2.5-flash", 500_000, 100_000, 0, 0);
    let cost_with_cache = compute_cost_usd_now("gemini-2.5-flash", 500_000, 100_000, 0, 500_000);
    assert!(
        cost_with_cache > cost_without_cache,
        "Cache read tokens must increase cost: without={}, with={}",
        cost_without_cache,
        cost_with_cache
    );
}

// ===========================================================================
// Finding 1 E2E: Gemini turn cost_usd is populated in DB
// ===========================================================================

/// **Proves:** A Gemini CLI capture round-trip produces a non-zero cost_usd
/// in the TurnRecord when the model is a known Gemini model.
/// **Anti-fake:** Without Gemini pricing in compute_cost_usd, cost_usd would be
/// None or Some(0.0).
#[test]
fn e2e_gemini_turn_has_nonzero_cost() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let request_bytes = GEMINI_CLI_REQUEST_WITH_SYSTEM.as_bytes();
    let response_bytes = build_gemini_cli_sse_bytes(&[CLI_SSE_FINAL]);

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "google",
        request_bytes,
        &response_bytes,
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed");

    assert!(
        turn.cost_usd.is_some(),
        "cost_usd must be Some for a known Gemini model"
    );
    assert!(
        turn.cost_usd.unwrap() > 0.0,
        "cost_usd must be > 0.0 for gemini-2.5-flash, got {:?}",
        turn.cost_usd
    );

    // Verify the graph-store round-trip also has the cost
    let db_turn = pipeline
        .graph()
        .get_turn(&turn.id)
        .expect("graph query must succeed")
        .expect("Turn must exist");
    assert!(
        db_turn.cost_usd.is_some() && db_turn.cost_usd.unwrap() > 0.0,
        "graph turn cost_usd must be non-zero, got {:?}",
        db_turn.cost_usd
    );
}

// ===========================================================================
// Finding 2: detect_agent_framework does not recognize Gemini CLI
//
// The system prompt for Gemini CLI contains "You are Gemini CLI" but the
// framework detection only checks for "claude code", "cursor", "aider".
// ===========================================================================

/// **Proves:** detect_agent_framework returns "gemini_cli" for a system prompt
/// containing the Gemini CLI signature.
/// **Anti-fake:** A function that only checks for "claude code", "cursor", "aider"
/// would return None.
#[test]
fn detect_gemini_cli_from_system_prompt() {
    let gemini_cli_prompt = "You are Gemini CLI, an autonomous CLI agent designed \
        to help developers with coding tasks.";

    let framework = session::detect_agent_framework(gemini_cli_prompt);

    assert_eq!(
        framework.as_deref(),
        Some("gemini_cli"),
        "Must detect Gemini CLI from system prompt containing 'Gemini CLI'"
    );
}

/// **Proves:** detect_agent_framework returns "gemini_cli" even when the Gemini
/// CLI signature appears mid-prompt with different casing.
/// **Anti-fake:** Case-insensitive matching must work.
#[test]
fn detect_gemini_cli_case_insensitive() {
    let prompt = "This system uses GEMINI CLI to process developer requests.";

    let framework = session::detect_agent_framework(prompt);

    assert_eq!(
        framework.as_deref(),
        Some("gemini_cli"),
        "Must detect Gemini CLI case-insensitively"
    );
}

/// **Proves (negative):** A prompt mentioning "Gemini" alone (without "CLI")
/// does not trigger gemini_cli detection.
/// **Anti-fake:** Must not match on just "gemini" — requires "gemini cli" as
/// a phrase.
#[test]
fn detect_gemini_without_cli_returns_none() {
    let prompt = "You are powered by Gemini, Google's large language model.";

    let framework = session::detect_agent_framework(prompt);

    // Should NOT return "gemini_cli" — "Gemini" alone is not a framework indicator
    assert!(
        framework.as_deref() != Some("gemini_cli"),
        "Mentioning 'Gemini' without 'CLI' must not detect as gemini_cli, got {:?}",
        framework
    );
}

/// **Proves:** detect_agent_framework still returns "claude_code" for Claude Code
/// prompts after adding Gemini CLI support.
/// **Anti-fake:** Ensures the Gemini CLI addition did not break existing detection.
#[test]
fn detect_claude_code_still_works_after_gemini_cli_addition() {
    let prompt = "You are Claude Code, Anthropic's official CLI for Claude.";
    let framework = session::detect_agent_framework(prompt);
    assert_eq!(
        framework.as_deref(),
        Some("claude_code"),
        "Claude Code detection must still work"
    );
}

// ===========================================================================
// Finding 2 E2E: Gemini CLI session has framework="gemini_cli"
// ===========================================================================

/// **Proves:** A Gemini CLI capture round-trip populates the SessionRecord.framework
/// with "gemini_cli" based on the system prompt.
/// **Anti-fake:** Without the Gemini CLI detection, framework would be None.
#[test]
fn e2e_gemini_cli_session_has_framework() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let request_bytes = GEMINI_CLI_REQUEST_WITH_SYSTEM.as_bytes();
    let response_bytes = build_gemini_cli_sse_bytes(&[CLI_SSE_FINAL]);

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "google",
        request_bytes,
        &response_bytes,
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed");

    let session = pipeline
        .graph()
        .get_session(&turn.session_id)
        .expect("graph query must succeed")
        .expect("Session must exist");

    assert_eq!(
        session.framework.as_deref(),
        Some("gemini_cli"),
        "Session framework must be 'gemini_cli' for Gemini CLI requests"
    );
}

// ===========================================================================
// Finding 3: GeminiCliRequestData.project parsed but never stored
//
// The `project` field is extracted in parse_gemini_cli_request but never
// flows into ParsedFields or the DB. It is either wired to storage or
// removed from the struct.
//
// We test the observable outcome: either the project value appears somewhere
// in the DB (e.g., raw_extra, a new column, or tags), OR the field is removed
// from GeminiCliRequestData entirely. Since we are behavioral test writers,
// we test that the field is NOT silently discarded.
// ===========================================================================

/// **Proves:** The `project` field from a Gemini CLI request either:
///   (a) appears in a queryable DB field (raw_extra, tags, etc.), OR
///   (b) has been removed from GeminiCliRequestData (compile error if accessed).
///
/// This test checks option (a). If the implementation chooses option (b) and
/// removes the field, this test should be updated accordingly.
///
/// **Anti-fake:** Without wiring the project field, it would be parsed and
/// immediately discarded — silently lost data.
#[test]
fn gemini_cli_project_field_is_observable() {
    let parsed =
        providers::google::parse_gemini_cli_request(GEMINI_CLI_REQUEST_WITH_SYSTEM.as_bytes())
            .expect("parse must succeed");

    // The project field must be parsed from the request
    assert_eq!(
        parsed.project.as_deref(),
        Some("my-project-abc123"),
        "project must be extracted from the request"
    );

    // Now verify it flows through the capture pipeline into the graph store.
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let response_bytes = build_gemini_cli_sse_bytes(&[CLI_SSE_FINAL]);

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "google",
        GEMINI_CLI_REQUEST_WITH_SYSTEM.as_bytes(),
        &response_bytes,
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed");

    // Check if the project appears in any of the queryable fields.
    // The implementation may store it in raw_extra, tags, or a dedicated column.
    let db_turn = pipeline
        .graph()
        .get_turn(&turn.id)
        .expect("graph query must succeed")
        .expect("Turn must exist");

    let session = pipeline
        .graph()
        .get_session(&turn.session_id)
        .expect("graph query must succeed")
        .expect("Session must exist");

    // The project must appear somewhere observable — check raw_extra or tags.
    let project_in_turn_raw_extra = db_turn
        .raw_extra
        .as_ref()
        .map(|re| re.contains("my-project-abc123"))
        .unwrap_or(false);
    let project_in_session_tags = session
        .tags
        .as_ref()
        .map(|t| t.contains("my-project-abc123"))
        .unwrap_or(false);
    let project_in_session_git_repo = session
        .git_repo
        .as_ref()
        .map(|r| r.contains("my-project-abc123"))
        .unwrap_or(false);

    assert!(
        project_in_turn_raw_extra || project_in_session_tags || project_in_session_git_repo,
        "project 'my-project-abc123' must be stored somewhere in the DB \
         (raw_extra, tags, or git_repo). Turn raw_extra={:?}, Session tags={:?}, git_repo={:?}",
        db_turn.raw_extra,
        session.tags,
        session.git_repo
    );
}

// ===========================================================================
// Finding 4: Standard Gemini API path does not parse requests
//
// When is_cli_format is false, parse_capture_data sets system_prompt: None,
// messages: Vec::new(), tools: None. This means no intent, no messages_delta,
// and no system_prompt_hash for standard Gemini API calls.
// ===========================================================================

/// **Proves:** parse_capture_data for a standard Gemini request (non-CLI format)
/// extracts system_prompt, messages, and tools from the request body.
/// **Anti-fake:** Without standard Gemini request parsing, system_prompt would be
/// None, messages would be empty, and tools would be None.
#[test]
fn standard_gemini_parse_capture_data_extracts_request() {
    let request_bytes = STANDARD_GEMINI_REQUEST.as_bytes();
    let response_bytes = standard_gemini_sse_basic();

    let fields = gateway::parse_capture_data("google", request_bytes, &response_bytes);

    // system_prompt must be extracted
    assert!(
        fields.system_prompt.is_some(),
        "Standard Gemini request must have system_prompt extracted, got None"
    );
    let system = fields.system_prompt.as_ref().unwrap();
    assert!(
        system.contains("helpful science tutor"),
        "system_prompt must contain the instruction text, got {:?}",
        system
    );

    // messages must be non-empty
    assert!(
        !fields.messages.is_empty(),
        "Standard Gemini request must have messages extracted, got empty Vec"
    );

    // tools must be extracted
    assert!(
        fields.tools.is_some(),
        "Standard Gemini request must have tools extracted, got None"
    );
}

/// **Proves:** Standard Gemini request parsing extracts the correct number of
/// user messages for initial_intent extraction.
/// **Anti-fake:** Without request parsing, messages is empty and extract_initial_intent
/// returns None.
#[test]
fn standard_gemini_messages_enable_intent_extraction() {
    let request_bytes = STANDARD_GEMINI_REQUEST.as_bytes();
    let response_bytes = standard_gemini_sse_basic();

    let fields = gateway::parse_capture_data("google", request_bytes, &response_bytes);

    // extract_initial_intent should work on the parsed messages
    let intent = session::extract_initial_intent(&fields.messages);
    assert!(
        intent.is_some(),
        "initial_intent must be extractable from standard Gemini messages, got None"
    );
    let intent_text = intent.unwrap();
    assert!(
        intent_text.contains("Explain quantum computing"),
        "initial_intent must be from the first user message, got {:?}",
        intent_text
    );
}

/// **Proves:** Standard Gemini request parsing produces a non-sentinel
/// system_prompt_hash when a system prompt is present.
/// **Anti-fake:** Without request parsing, system_prompt is None and the hash
/// would be the sentinel value.
#[test]
fn standard_gemini_system_prompt_hash_is_not_sentinel() {
    let request_bytes = STANDARD_GEMINI_REQUEST.as_bytes();
    let response_bytes = standard_gemini_sse_basic();

    let fields = gateway::parse_capture_data("google", request_bytes, &response_bytes);

    let hash = session::compute_system_prompt_hash(fields.system_prompt.as_deref());
    let sentinel_hash = session::compute_system_prompt_hash(None);

    assert_ne!(
        hash, sentinel_hash,
        "Standard Gemini system_prompt_hash must NOT be the sentinel (no-prompt) hash"
    );
}

/// **Proves (E2E):** A standard Gemini API capture produces a session with
/// a populated initial_intent and non-sentinel system_prompt_hash.
/// **Anti-fake:** Without standard Gemini request parsing, both would be
/// missing/sentinel.
#[test]
fn e2e_standard_gemini_session_has_intent_and_system_hash() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let request_bytes = STANDARD_GEMINI_REQUEST.as_bytes();
    let response_bytes = standard_gemini_sse_basic();

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "google",
        request_bytes,
        &response_bytes,
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed for standard Gemini");

    let session = pipeline
        .graph()
        .get_session(&turn.session_id)
        .expect("graph query must succeed")
        .expect("Session must exist");

    // initial_intent must be populated
    assert!(
        session.initial_intent.is_some(),
        "Standard Gemini session must have initial_intent, got None"
    );
    let intent = session.initial_intent.as_ref().unwrap();
    assert!(
        intent.contains("Explain quantum computing"),
        "initial_intent must come from the first user message, got {:?}",
        intent
    );

    // system_prompt_hash must not be the sentinel
    let sentinel_hash = session::compute_system_prompt_hash(None);
    assert_ne!(
        session.system_prompt_hash, sentinel_hash,
        "Session system_prompt_hash must not be the sentinel for a request with a system prompt"
    );
}

/// **Proves (negative):** Standard Gemini request without a systemInstruction
/// still parses messages and tools; system_prompt is correctly None.
#[test]
fn standard_gemini_no_system_instruction_still_parses_messages() {
    let request_json = r#"{
        "contents": [
            {"role": "user", "parts": [{"text": "Hello"}]}
        ]
    }"#;
    let request_bytes = request_json.as_bytes();
    let response_bytes = standard_gemini_sse_basic();

    let fields = gateway::parse_capture_data("google", request_bytes, &response_bytes);

    // system_prompt should be None (no systemInstruction in request)
    assert!(
        fields.system_prompt.is_none(),
        "system_prompt must be None when no systemInstruction is present"
    );

    // messages should still be extracted
    assert!(
        !fields.messages.is_empty(),
        "messages must be extracted even without systemInstruction"
    );
}

// ===========================================================================
// Finding 8: Gemini tool format (functionDeclarations) hash stability
//
// Gemini uses {"functionDeclarations": [...]} while Anthropic uses a flat
// tool array. The tool_definitions_hash must still be deterministic.
// ===========================================================================

/// **Proves:** Tool definitions hash for Gemini's functionDeclarations format
/// is deterministic — same input always produces the same hash.
/// **Anti-fake:** If the hash function chokes on the nested format or
/// produces random output, the two calls would differ.
#[test]
fn gemini_tool_hash_is_deterministic() {
    let gemini_tools = serde_json::json!([
        {"functionDeclarations": [
            {"name": "read_file", "description": "Read a file"},
            {"name": "write_file", "description": "Write a file"}
        ]}
    ]);

    let hash1 = session::compute_tool_definitions_hash(Some(&gemini_tools));
    let hash2 = session::compute_tool_definitions_hash(Some(&gemini_tools));

    assert_eq!(hash1, hash2, "Gemini tool hash must be deterministic");
}

/// **Proves:** The Gemini tool hash is different from the Anthropic tool hash
/// for the same logical tools, because the formats differ structurally.
/// **Anti-fake:** This documents the known divergence — analytics consumers
/// must account for format differences.
#[test]
fn gemini_tool_hash_differs_from_anthropic_for_same_tools() {
    let gemini_tools = serde_json::json!([
        {"functionDeclarations": [
            {"name": "read_file", "description": "Read a file"}
        ]}
    ]);

    let anthropic_tools = serde_json::json!([
        {"name": "read_file", "description": "Read a file", "input_schema": {"type": "object"}}
    ]);

    let gemini_hash = session::compute_tool_definitions_hash(Some(&gemini_tools));
    let anthropic_hash = session::compute_tool_definitions_hash(Some(&anthropic_tools));

    assert_ne!(
        gemini_hash, anthropic_hash,
        "Gemini and Anthropic tool hashes must differ because their JSON structures differ"
    );
}

// ===========================================================================
// Finding 9: KNOWN_TOP_LEVEL_FIELDS duplicated
//
// Two identical constants exist in google.rs: KNOWN_CLI_RESPONSE_FIELDS and
// KNOWN_TOP_LEVEL_FIELDS, both = ["candidates", "usageMetadata", "modelVersion"].
// After deduplication, behavior must be unchanged.
// ===========================================================================

/// **Proves:** After deduplication of the known-fields constants, the standard
/// Gemini parser still correctly identifies unknown fields and puts them in
/// raw_extra.
/// **Anti-fake:** If deduplication accidentally changed the field list, a field
/// like "serverTiming" would not appear in raw_extra.
#[test]
fn standard_gemini_raw_extra_still_captures_unknown_fields_after_dedup() {
    let event_data = r#"{"candidates":[{"content":{"parts":[{"text":"Hi"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3},"modelVersion":"gemini-2.5-flash","serverTiming":{"latencyMs":42}}"#;

    let events = vec![stream::SseEvent {
        event_type: "message".to_string(),
        data: event_data.to_string(),
    }];

    let parsed = providers::google::parse_response(&events).expect("parse must succeed");

    assert!(
        parsed.raw_extra.is_some(),
        "raw_extra must capture unknown fields like serverTiming"
    );
    let raw_extra = parsed.raw_extra.unwrap();
    assert!(
        raw_extra.contains("serverTiming"),
        "raw_extra must contain serverTiming, got {:?}",
        raw_extra
    );
}

/// **Proves:** After deduplication, the CLI parser still correctly identifies
/// unknown fields and puts them in raw_extra.
#[test]
fn gemini_cli_raw_extra_still_captures_unknown_fields_after_dedup() {
    let cli_event = r#"{"response": {"candidates": [{"content": {"parts": [{"text": "Hi"}]}, "finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 3}, "modelVersion": "gemini-2.5-flash", "customField": "test_value"}}"#;
    let sse_bytes = build_gemini_cli_sse_bytes(&[cli_event]);

    let parsed =
        providers::google::parse_gemini_cli_sse_response(&sse_bytes).expect("parse must succeed");

    assert!(
        parsed.raw_extra.is_some(),
        "CLI raw_extra must capture unknown fields"
    );
    let raw_extra = parsed.raw_extra.unwrap();
    assert!(
        raw_extra.contains("customField"),
        "CLI raw_extra must contain customField, got {:?}",
        raw_extra
    );
}

// ===========================================================================
// Finding 10: Misleading sentinel hash comment
//
// The comment in gemini_cli_tests.rs says "sentinel is sha256 of empty string"
// but the actual sentinel is sha256(b"__RECONDO_NO_SYSTEM_PROMPT__").
// ===========================================================================

/// **Proves:** The sentinel hash for "no system prompt" is sha256 of the
/// sentinel bytes b"__RECONDO_NO_SYSTEM_PROMPT__", NOT sha256 of the empty string.
/// **Anti-fake:** If the sentinel were sha256(""), this test would fail because
/// the two hashes are different.
#[test]
fn sentinel_hash_is_not_sha256_of_empty_string() {
    let sentinel_hash = session::compute_system_prompt_hash(None);
    let empty_string_hash = hash::sha256_hex(b"");

    assert_ne!(
        sentinel_hash, empty_string_hash,
        "Sentinel hash must NOT be sha256 of empty string. \
         Sentinel={}, Empty={}\n\
         The sentinel is sha256(b\"__RECONDO_NO_SYSTEM_PROMPT__\")",
        sentinel_hash, empty_string_hash
    );
}

/// **Proves:** The sentinel hash matches sha256(b"__RECONDO_NO_SYSTEM_PROMPT__").
/// **Anti-fake:** Pinpoints the exact sentinel value.
#[test]
fn sentinel_hash_matches_expected_value() {
    let sentinel_hash = session::compute_system_prompt_hash(None);
    let expected = hash::sha256_hex(b"__RECONDO_NO_SYSTEM_PROMPT__");

    assert_eq!(
        sentinel_hash, expected,
        "Sentinel hash must be sha256 of b\"__RECONDO_NO_SYSTEM_PROMPT__\""
    );
}

/// **Proves:** compute_system_prompt_hash(Some("")) produces a different hash
/// than compute_system_prompt_hash(None) — empty string is not the same as absent.
/// **Anti-fake:** Ensures the sentinel distinguishes None from Some("").
#[test]
fn sentinel_hash_differs_from_empty_prompt_hash() {
    let none_hash = session::compute_system_prompt_hash(None);
    let empty_hash = session::compute_system_prompt_hash(Some(""));

    assert_ne!(
        none_hash, empty_hash,
        "None (sentinel) and Some(\"\") must produce different hashes"
    );
}

// ===========================================================================
// Finding 11: Standard Gemini parse_response hardcodes thinking_text: None
//
// Standard Gemini API parse_response() sets thinking_text: None, cache_read_tokens: 0,
// thinking_tokens: None. But Gemini 2.5+ supports thinking and caching via
// the standard API.
// ===========================================================================

/// **Proves:** Standard Gemini parse_response extracts thinking_text from
/// thought=true parts in the response.
/// **Anti-fake:** If thinking_text is hardcoded to None, this fails.
#[test]
fn standard_gemini_parse_response_extracts_thinking_text() {
    // Build SSE events with thinking parts (standard format, no response wrapper)
    let event1_data = r#"{"candidates":[{"content":{"parts":[{"thought":true,"text":"Let me reason about this."}],"role":"model"}}],"modelVersion":"gemini-2.5-pro"}"#;
    let event2_data = r#"{"candidates":[{"content":{"parts":[{"text":"Here is my answer."}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":20,"thoughtsTokenCount":35},"modelVersion":"gemini-2.5-pro"}"#;

    let events = vec![
        stream::SseEvent {
            event_type: "message".to_string(),
            data: event1_data.to_string(),
        },
        stream::SseEvent {
            event_type: "message".to_string(),
            data: event2_data.to_string(),
        },
    ];

    let parsed = providers::google::parse_response(&events).expect("parse must succeed");

    // thinking_text must be extracted
    assert!(
        parsed.thinking_text.is_some(),
        "Standard Gemini parse_response must extract thinking_text from thought=true parts, got None"
    );
    let thinking = parsed.thinking_text.unwrap();
    assert!(
        thinking.contains("Let me reason about this"),
        "thinking_text must contain the thought content, got {:?}",
        thinking
    );

    // response_text must NOT contain thinking text
    assert!(
        !parsed.response_text.contains("Let me reason"),
        "response_text must not include thinking text"
    );
    assert_eq!(
        parsed.response_text, "Here is my answer.",
        "response_text must contain only non-thinking parts"
    );
}

/// **Proves:** Standard Gemini parse_response extracts cachedContentTokenCount
/// as cache_read_tokens.
/// **Anti-fake:** If cache_read_tokens is hardcoded to 0, this fails.
#[test]
fn standard_gemini_parse_response_extracts_cache_tokens() {
    let event_data = r#"{"candidates":[{"content":{"parts":[{"text":"Cached result."}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":200,"candidatesTokenCount":10,"cachedContentTokenCount":150},"modelVersion":"gemini-2.5-flash"}"#;

    let events = vec![stream::SseEvent {
        event_type: "message".to_string(),
        data: event_data.to_string(),
    }];

    let parsed = providers::google::parse_response(&events).expect("parse must succeed");

    assert_eq!(
        parsed.cache_read_tokens, 150,
        "Standard Gemini parse_response must extract cachedContentTokenCount as cache_read_tokens"
    );
}

/// **Proves:** Standard Gemini parse_response extracts thoughtsTokenCount
/// into the thinking_tokens field.
/// **Anti-fake:** If thinking_tokens is hardcoded to None, this fails.
#[test]
fn standard_gemini_parse_response_extracts_thinking_tokens() {
    let event_data = r#"{"candidates":[{"content":{"parts":[{"thought":true,"text":"thinking..."},{"text":"answer"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":20,"thoughtsTokenCount":45},"modelVersion":"gemini-2.5-pro"}"#;

    let events = vec![stream::SseEvent {
        event_type: "message".to_string(),
        data: event_data.to_string(),
    }];

    let parsed = providers::google::parse_response(&events).expect("parse must succeed");

    assert_eq!(
        parsed.thinking_tokens,
        Some(45),
        "Standard Gemini parse_response must extract thoughtsTokenCount into thinking_tokens"
    );
}

/// **Proves (negative):** When no thinking parts exist, thinking_text remains None.
/// **Anti-fake:** Ensures thinking extraction only activates on thought=true parts.
#[test]
fn standard_gemini_no_thinking_parts_means_none_thinking_text() {
    let event_data = r#"{"candidates":[{"content":{"parts":[{"text":"Simple answer."}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5},"modelVersion":"gemini-2.5-flash"}"#;

    let events = vec![stream::SseEvent {
        event_type: "message".to_string(),
        data: event_data.to_string(),
    }];

    let parsed = providers::google::parse_response(&events).expect("parse must succeed");

    assert!(
        parsed.thinking_text.is_none(),
        "thinking_text must be None when no thought=true parts exist"
    );
    assert_eq!(
        parsed.thinking_tokens, None,
        "thinking_tokens must be None when no thoughtsTokenCount in usageMetadata"
    );
}

/// **Proves (E2E):** Standard Gemini API with thinking parts flows through
/// process_capture and the thinking_text appears in the DB TurnRecord.
/// **Anti-fake:** Without thinking extraction in the standard parser,
/// thinking_text would be None in the DB.
#[test]
fn e2e_standard_gemini_thinking_text_in_db() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let request_bytes = STANDARD_GEMINI_REQUEST.as_bytes();
    let response_bytes = standard_gemini_sse_with_thinking();

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "google",
        request_bytes,
        &response_bytes,
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed");

    // thinking_text must be populated
    assert!(
        turn.thinking_text.is_some(),
        "TurnRecord thinking_text must be populated for standard Gemini with thinking"
    );
    let thinking = turn.thinking_text.as_ref().unwrap();
    assert!(
        thinking.contains("think about this carefully"),
        "thinking_text must contain the thought content, got {:?}",
        thinking
    );

    // Verify in graph store
    let db_turn = pipeline
        .graph()
        .get_turn(&turn.id)
        .expect("graph query must succeed")
        .expect("Turn must exist");
    assert!(
        db_turn.thinking_text.is_some(),
        "graph thinking_text must be populated"
    );
}

/// **Proves (E2E):** Standard Gemini API with cache tokens flows through
/// process_capture and cache_read_tokens appears in the DB TurnRecord.
/// **Anti-fake:** Without cache token extraction, cache_read_tokens would be 0.
#[test]
fn e2e_standard_gemini_cache_tokens_in_db() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let request_bytes = STANDARD_GEMINI_REQUEST.as_bytes();
    let response_bytes = standard_gemini_sse_with_cache();

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "google",
        request_bytes,
        &response_bytes,
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed");

    assert_eq!(
        turn.cache_read_tokens, 150,
        "TurnRecord cache_read_tokens must be 150 from cachedContentTokenCount"
    );

    let db_turn = pipeline
        .graph()
        .get_turn(&turn.id)
        .expect("graph query must succeed")
        .expect("Turn must exist");
    assert_eq!(
        db_turn.cache_read_tokens, 150,
        "graph cache_read_tokens must match"
    );
}
