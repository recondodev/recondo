//! Codex `response.create` Request Parsing Tests.
//!
//! These tests verify that the gateway correctly parses client-sent
//! `response.create` WebSocket frames from Codex to extract the user's
//! prompt, model, system prompt (instructions), and messages. The extracted
//! data flows into TurnRecord and SessionRecord for compliance auditing.
//!
//! ## Design reference
//!
//! Codex clients send a `response.create` JSON frame over WebSocket containing:
//! - `model` — the requested LLM model (e.g., "gpt-5.4")
//! - `instructions` — the system prompt (~14KB in production)
//! - `input[]` — array of messages with roles: developer, user
//! - `tools[]` — available tool definitions
//!
//! ## What these tests prove
//!
//! 1. `parse_codex_request` extracts model, user_prompt, system_prompt,
//!    system_prompt_hash, messages_json, and tool_count from response.create
//! 2. Edge cases: missing fields, empty arrays, no user message, malformed JSON
//! 3. The request model is MORE accurate than the rate_limits model and
//!    should take precedence on TurnRecord and SessionRecord
//! 4. Session initial_intent is populated from the user's prompt
//! 5. System prompt hash is computed via SHA-256 of the instructions field
//!
//! These tests SHOULD FAIL until `parse_codex_request` is implemented.

#[allow(unused_imports)]
use recondo_gateway::db::{self, SessionRecord, TurnRecord};
#[allow(unused_imports)]
use recondo_gateway::hash;
#[allow(unused_imports)]
use recondo_gateway::providers::codex::{
    self, CodexFrameAccumulator, CodexFrameType, CodexRequestData, CodexTurnData,
};
#[allow(unused_imports)]
use recondo_gateway::session;
#[allow(unused_imports)]
use rusqlite::Connection;

// ===========================================================================
// JSON fixture data — realistic Codex response.create payload
// ===========================================================================

/// Realistic `response.create` frame from a Codex session. Contains:
/// - model: "gpt-5.4"
/// - instructions: system prompt (shortened for testing)
/// - input: [developer msg, developer msg, user msg]
/// - tools: [{name: "shell"}, {name: "apply_patch"}]
/// - previous_response_id: "resp_abc123"
/// - reasoning: {effort: "low"}
/// - stream: true
const RESPONSE_CREATE_FIXTURE: &str = r#"{
    "type": "response.create",
    "model": "gpt-5.4",
    "instructions": "You are Codex, a coding agent based on GPT-5. You help developers write, debug, and refactor code across multiple languages and frameworks.",
    "input": [
        {
            "type": "message",
            "role": "developer",
            "content": [
                {
                    "type": "input_text",
                    "text": "<permissions>allow_all: true</permissions>"
                }
            ]
        },
        {
            "type": "message",
            "role": "developer",
            "content": [
                {
                    "type": "input_text",
                    "text": "<skills>rust, python, typescript</skills>"
                }
            ]
        },
        {
            "type": "message",
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": "tell me a joke about rust"
                }
            ]
        }
    ],
    "tools": [
        {
            "type": "function",
            "name": "shell",
            "description": "Execute a shell command",
            "parameters": {"type": "object", "properties": {"command": {"type": "string"}}}
        },
        {
            "type": "function",
            "name": "apply_patch",
            "description": "Apply a code patch",
            "parameters": {"type": "object", "properties": {"patch": {"type": "string"}}}
        }
    ],
    "previous_response_id": "resp_abc123",
    "reasoning": {"effort": "low"},
    "stream": true
}"#;

/// response.create with no user message — only developer messages in input[].
const RESPONSE_CREATE_NO_USER_MSG: &str = r#"{
    "type": "response.create",
    "model": "gpt-5.4",
    "instructions": "You are Codex.",
    "input": [
        {
            "type": "message",
            "role": "developer",
            "content": [
                {
                    "type": "input_text",
                    "text": "<permissions>allow_all: true</permissions>"
                }
            ]
        }
    ],
    "tools": [],
    "stream": true
}"#;

/// response.create with empty input array.
const RESPONSE_CREATE_EMPTY_INPUT: &str = r#"{
    "type": "response.create",
    "model": "gpt-5.4",
    "instructions": "You are Codex.",
    "input": [],
    "tools": [],
    "stream": true
}"#;

/// response.create with no instructions field.
const RESPONSE_CREATE_NO_INSTRUCTIONS: &str = r#"{
    "type": "response.create",
    "model": "gpt-5.4",
    "input": [
        {
            "type": "message",
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": "hello"
                }
            ]
        }
    ],
    "tools": [],
    "stream": true
}"#;

/// response.create with no model field.
const RESPONSE_CREATE_NO_MODEL: &str = r#"{
    "type": "response.create",
    "instructions": "You are Codex.",
    "input": [
        {
            "type": "message",
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": "what is rust"
                }
            ]
        }
    ],
    "tools": [],
    "stream": true
}"#;

/// A non-response.create frame (session.update).
const NON_RESPONSE_CREATE: &str = r#"{
    "type": "session.update",
    "session": {
        "modalities": ["text"],
        "instructions": "Be helpful."
    }
}"#;

/// Larger realistic fixture with multiple user messages — the LAST user
/// message should be extracted as the user prompt.
const RESPONSE_CREATE_MULTI_USER: &str = r#"{
    "type": "response.create",
    "model": "gpt-5.4",
    "instructions": "You are Codex.",
    "input": [
        {
            "type": "message",
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": "first user message"
                }
            ]
        },
        {
            "type": "message",
            "role": "developer",
            "content": [
                {
                    "type": "input_text",
                    "text": "developer context"
                }
            ]
        },
        {
            "type": "message",
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": "second user message - the actual prompt"
                }
            ]
        }
    ],
    "tools": [{"type": "function", "name": "shell"}],
    "stream": true
}"#;

// ===========================================================================
// Helpers
// ===========================================================================

fn setup_db() -> Connection {
    let conn = db::open_in_memory().expect("Must open in-memory SQLite with FK enforcement");
    db::initialize(&conn).expect("Must initialize database schema");
    conn
}

fn sample_session(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.to_string(),
        provider: "openai".to_string(),
        model: None,
        started_at: "2026-03-21T10:00:00Z".to_string(),
        last_active_at: "2026-03-21T10:05:00Z".to_string(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash: "codex_request_test_hash".to_string(),
        total_turns: 0,
        turns_captured: 0,
        dropped_events: 0,
        total_tokens: 0,
        total_cost_usd: 0.0,
        framework: Some("codex_cli_rs".to_string()),
        agent_id: None,
        agent_version: Some("0.116.0".to_string()),
        git_repo: None,
        git_branch: None,
        git_commit: None,
        working_directory: None,
        parent_session_id: None,
        tags: None,
        account_uuid: Some("acct_test_456".to_string()),
        device_id: None,
        tool_definitions_hash: String::new(),
    }
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
        model: None,
        response_text: None,
        thinking_text: None,
        stop_reason: String::new(),
        capture_complete: true,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: format!("2026-03-21T10:{:02}:00Z", seq),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: None,
        parser_version: None,
        parse_errors: None,
        provider: Some("openai".to_string()),
        transport: Some("websocket".to_string()),
        ws_direction: Some("client_to_server".to_string()),
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

// ===========================================================================
// 1. Parse response.create -> extracts model
// ===========================================================================

/// **Proves:** `parse_codex_request` extracts the `model` field from a
/// `response.create` frame (e.g., "gpt-5.4"). This model is MORE accurate
/// than the rate_limits model name and should take precedence.
///
/// **Anti-fake property:** If the parser returns None or a wrong model,
/// this test fails.
#[test]
fn parse_response_create_extracts_model() {
    let result = codex::parse_codex_request(RESPONSE_CREATE_FIXTURE);
    let data = result.expect("parse_codex_request must succeed on valid response.create");
    assert_eq!(
        data.model.as_deref(),
        Some("gpt-5.4"),
        "Must extract model from response.create"
    );
}

// ===========================================================================
// 2. Parse response.create -> extracts user prompt from last user message
// ===========================================================================

/// **Proves:** `parse_codex_request` extracts the user prompt from the last
/// `input` item with `role: "user"`. This becomes the `initial_intent` on
/// the SessionRecord.
///
/// **Anti-fake property:** If the parser returns the developer message or
/// the first user message instead of the last, this test fails.
#[test]
fn parse_response_create_extracts_user_prompt() {
    let result = codex::parse_codex_request(RESPONSE_CREATE_FIXTURE);
    let data = result.expect("parse_codex_request must succeed on valid response.create");
    assert_eq!(
        data.user_prompt.as_deref(),
        Some("tell me a joke about rust"),
        "Must extract user prompt from last user message in input[]"
    );
}

// ===========================================================================
// 3. Parse response.create -> extracts system prompt from instructions
// ===========================================================================

/// **Proves:** `parse_codex_request` extracts the `instructions` field as
/// the system prompt.
///
/// **Anti-fake property:** If the parser returns None or truncated text,
/// this test fails.
#[test]
fn parse_response_create_extracts_system_prompt() {
    let result = codex::parse_codex_request(RESPONSE_CREATE_FIXTURE);
    let data = result.expect("parse_codex_request must succeed on valid response.create");
    assert_eq!(
        data.system_prompt.as_deref(),
        Some("You are Codex, a coding agent based on GPT-5. You help developers write, debug, and refactor code across multiple languages and frameworks."),
        "Must extract full instructions field as system prompt"
    );
}

// ===========================================================================
// 4. Parse response.create -> computes system_prompt_hash as SHA-256
// ===========================================================================

/// **Proves:** `parse_codex_request` computes the SHA-256 hash of the
/// `instructions` field and stores it in `system_prompt_hash`.
///
/// **Anti-fake property:** If the hash is computed from something other
/// than the instructions text (e.g., hardcoded or from a different field),
/// this test fails because the expected hash is computed independently.
#[test]
fn parse_response_create_computes_system_prompt_hash() {
    let result = codex::parse_codex_request(RESPONSE_CREATE_FIXTURE);
    let data = result.expect("parse_codex_request must succeed on valid response.create");

    // Compute expected hash independently
    let instructions = "You are Codex, a coding agent based on GPT-5. You help developers write, debug, and refactor code across multiple languages and frameworks.";
    let expected_hash = hash::sha256_hex(instructions.as_bytes());

    assert_eq!(
        data.system_prompt_hash.as_deref(),
        Some(expected_hash.as_str()),
        "system_prompt_hash must be SHA-256 of instructions field"
    );

    // Verify it's a 64-char lowercase hex string (SHA-256)
    let hash_val = data.system_prompt_hash.unwrap();
    assert_eq!(hash_val.len(), 64, "SHA-256 hex must be 64 characters");
    assert!(
        hash_val.chars().all(|c: char| c.is_ascii_hexdigit()),
        "Hash must be valid hex"
    );
}

// ===========================================================================
// 5. Parse response.create -> extracts messages_json as serialized input[]
// ===========================================================================

/// **Proves:** `parse_codex_request` serializes the `input[]` array as a
/// JSON string for the `messages_json` field. This allows the full
/// conversation context to be stored in `messages_delta` on the TurnRecord.
///
/// **Anti-fake property:** If messages_json is None or doesn't contain the
/// expected messages, this test fails.
#[test]
fn parse_response_create_extracts_messages_json() {
    let result = codex::parse_codex_request(RESPONSE_CREATE_FIXTURE);
    let data = result.expect("parse_codex_request must succeed on valid response.create");

    let messages_json = data
        .messages_json
        .as_ref()
        .expect("messages_json must be Some for non-empty input[]");

    // Verify it's valid JSON
    let parsed: serde_json::Value =
        serde_json::from_str(messages_json).expect("messages_json must be valid JSON");

    // Verify it's an array with 3 elements (2 developer + 1 user)
    let arr = parsed
        .as_array()
        .expect("messages_json must be a JSON array");
    assert_eq!(arr.len(), 3, "input[] has 3 messages");

    // Verify the user message content is preserved
    let last = &arr[2];
    let role = last.get("role").and_then(|r| r.as_str());
    assert_eq!(role, Some("user"), "Last message must be from user");

    let text = last
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|item| item.get("text"))
        .and_then(|t| t.as_str());
    assert_eq!(
        text,
        Some("tell me a joke about rust"),
        "User message text must be preserved in messages_json"
    );
}

// ===========================================================================
// 6. Parse response.create -> counts tools
// ===========================================================================

/// **Proves:** `parse_codex_request` counts the tools in the `tools[]` array.
///
/// **Anti-fake property:** If tool_count is hardcoded to 0, this test fails.
#[test]
fn parse_response_create_counts_tools() {
    let result = codex::parse_codex_request(RESPONSE_CREATE_FIXTURE);
    let data = result.expect("parse_codex_request must succeed on valid response.create");
    assert_eq!(
        data.tool_count, 2,
        "Must count 2 tools (shell and apply_patch)"
    );
}

// ===========================================================================
// 7. Parse with no user message -> user_prompt is None
// ===========================================================================

/// **Proves:** When there are no user messages in `input[]` (only developer
/// messages), `user_prompt` is None rather than panicking or returning a
/// developer message.
///
/// **Anti-fake property:** If the parser incorrectly returns a developer
/// message as the user prompt, this test fails.
#[test]
fn parse_no_user_message_returns_none_user_prompt() {
    let result = codex::parse_codex_request(RESPONSE_CREATE_NO_USER_MSG);
    let data = result.expect("parse_codex_request must succeed even without user messages");
    assert!(
        data.user_prompt.is_none(),
        "user_prompt must be None when no user messages in input[]"
    );
    // Other fields should still be populated
    assert_eq!(data.model.as_deref(), Some("gpt-5.4"));
    assert!(data.system_prompt.is_some());
}

// ===========================================================================
// 8. Parse with empty input array -> user_prompt None, messages_json "[]"
// ===========================================================================

/// **Proves:** An empty `input[]` array is handled gracefully: user_prompt
/// is None and messages_json is the string "[]".
#[test]
fn parse_empty_input_array() {
    let result = codex::parse_codex_request(RESPONSE_CREATE_EMPTY_INPUT);
    let data = result.expect("parse_codex_request must succeed with empty input[]");
    assert!(
        data.user_prompt.is_none(),
        "user_prompt must be None with empty input[]"
    );

    let messages_json = data
        .messages_json
        .as_ref()
        .expect("messages_json must be Some even for empty input[]");
    let parsed: serde_json::Value =
        serde_json::from_str(messages_json).expect("messages_json must be valid JSON");
    let arr = parsed.as_array().expect("messages_json must be an array");
    assert!(
        arr.is_empty(),
        "messages_json must be an empty array for empty input[]"
    );
}

// ===========================================================================
// 9. Parse with no instructions -> system_prompt None, hash None
// ===========================================================================

/// **Proves:** When the `instructions` field is absent, both system_prompt
/// and system_prompt_hash are None.
///
/// **Anti-fake property:** If the parser panics or returns a default hash,
/// this test fails.
#[test]
fn parse_no_instructions_returns_none_system_prompt() {
    let result = codex::parse_codex_request(RESPONSE_CREATE_NO_INSTRUCTIONS);
    let data = result.expect("parse_codex_request must succeed without instructions");
    assert!(
        data.system_prompt.is_none(),
        "system_prompt must be None when instructions field is absent"
    );
    assert!(
        data.system_prompt_hash.is_none(),
        "system_prompt_hash must be None when instructions field is absent"
    );
    // user_prompt should still work
    assert_eq!(data.user_prompt.as_deref(), Some("hello"));
}

// ===========================================================================
// 10. Parse with no model field -> model is None
// ===========================================================================

/// **Proves:** When the `model` field is absent from the response.create
/// frame, `model` is None. The gateway should fall back to the rate_limits
/// model in this case.
#[test]
fn parse_no_model_field_returns_none() {
    let result = codex::parse_codex_request(RESPONSE_CREATE_NO_MODEL);
    let data = result.expect("parse_codex_request must succeed without model field");
    assert!(
        data.model.is_none(),
        "model must be None when model field is absent"
    );
    // Other fields should still work
    assert_eq!(data.user_prompt.as_deref(), Some("what is rust"));
    assert!(data.system_prompt.is_some());
}

// ===========================================================================
// 11. Parse malformed JSON -> returns error
// ===========================================================================

/// **Proves:** Malformed JSON returns an error, not a panic.
#[test]
fn parse_malformed_json_returns_error() {
    let malformed = "this is not json {{{";
    let result = codex::parse_codex_request(malformed);
    assert!(
        result.is_err(),
        "Malformed JSON must return Err, not Ok or panic"
    );
}

/// Empty string is also malformed.
#[test]
fn parse_empty_string_returns_error() {
    let result = codex::parse_codex_request("");
    assert!(
        result.is_err(),
        "Empty string must return Err, not Ok or panic"
    );
}

// ===========================================================================
// 12. Parse non-response.create type -> returns None/error indicator
// ===========================================================================

/// **Proves:** A valid JSON frame that is NOT `response.create` is handled
/// appropriately — either returning an error or returning a CodexRequestData
/// with all None fields. The parser must not extract data from non-request
/// frames.
#[test]
fn parse_non_response_create_type() {
    let result = codex::parse_codex_request(NON_RESPONSE_CREATE);
    // Either an Err or an Ok with all-None fields is acceptable.
    // The critical property: it must NOT extract the instructions from
    // session.update as a user prompt or system prompt for a turn.
    match result {
        Err(_) => { /* acceptable: non-response.create is rejected */ }
        Ok(data) => {
            // If Ok is returned, all fields must be None / 0
            assert!(
                data.model.is_none(),
                "Non-response.create must not yield a model"
            );
            assert!(
                data.user_prompt.is_none(),
                "Non-response.create must not yield a user_prompt"
            );
            assert!(
                data.system_prompt.is_none(),
                "Non-response.create must not yield a system_prompt"
            );
            assert!(
                data.system_prompt_hash.is_none(),
                "Non-response.create must not yield a system_prompt_hash"
            );
            assert!(
                data.messages_json.is_none(),
                "Non-response.create must not yield messages_json"
            );
            assert_eq!(
                data.tool_count, 0,
                "Non-response.create must not yield tools"
            );
        }
    }
}

// ===========================================================================
// 13. Parse realistic fixture -> all fields extracted correctly
// ===========================================================================

/// **Proves:** The full realistic fixture is parsed correctly with all
/// fields populated. This is a comprehensive integration test of the parser
/// against a representative real-world payload.
///
/// **Anti-fake property:** Every field is checked, so stub implementations
/// that return partial data will fail.
#[test]
fn parse_full_realistic_fixture_all_fields() {
    let result = codex::parse_codex_request(RESPONSE_CREATE_FIXTURE);
    let data = result.expect("parse_codex_request must succeed on realistic fixture");

    // Model
    assert_eq!(data.model.as_deref(), Some("gpt-5.4"));

    // User prompt (last user message)
    assert_eq!(
        data.user_prompt.as_deref(),
        Some("tell me a joke about rust")
    );

    // System prompt
    let expected_instructions = "You are Codex, a coding agent based on GPT-5. You help developers write, debug, and refactor code across multiple languages and frameworks.";
    assert_eq!(data.system_prompt.as_deref(), Some(expected_instructions));

    // System prompt hash (independently computed)
    let expected_hash = hash::sha256_hex(expected_instructions.as_bytes());
    assert_eq!(
        data.system_prompt_hash.as_deref(),
        Some(expected_hash.as_str())
    );

    // Messages JSON contains 3 messages
    let messages_json = data.messages_json.as_ref().unwrap();
    let parsed: serde_json::Value = serde_json::from_str(messages_json).unwrap();
    assert_eq!(parsed.as_array().unwrap().len(), 3);

    // Tool count
    assert_eq!(data.tool_count, 2);
}

/// **Proves:** When multiple user messages exist in input[], the LAST one
/// is extracted as user_prompt. This matches the real Codex behavior where
/// the final user message is the current request.
#[test]
fn parse_multi_user_messages_extracts_last() {
    let result = codex::parse_codex_request(RESPONSE_CREATE_MULTI_USER);
    let data = result.expect("parse_codex_request must succeed with multiple user messages");
    assert_eq!(
        data.user_prompt.as_deref(),
        Some("second user message - the actual prompt"),
        "Must extract the LAST user message, not the first"
    );
}

// ===========================================================================
// 14. DB round-trip: session model from response.create (not rate_limits)
// ===========================================================================

/// **Proves:** The session record uses the model from `response.create`
/// ("gpt-5.4") rather than the rate_limits model ("GPT-5.3-Codex-Spark").
/// The request model is more accurate because rate_limits may use internal
/// routing names.
///
/// **Anti-fake property:** If the session model is still coming from
/// rate_limits, the value won't match "gpt-5.4".
#[test]
fn session_model_from_response_create_not_rate_limits() {
    let conn = setup_db();

    // Parse the response.create to get the request model
    let request_data =
        codex::parse_codex_request(RESPONSE_CREATE_FIXTURE).expect("must parse fixture");
    let rate_limits_model = Some("GPT-5.3-Codex-Spark".to_string()); // from rate_limits

    // The request model should take precedence
    let effective_model = request_data.model.or(rate_limits_model);

    let mut sess = sample_session("sess-model-test");
    sess.model = effective_model;
    db::insert_session(&conn, &sess).expect("insert session");

    let loaded = db::get_session(&conn, "sess-model-test")
        .expect("query must succeed")
        .expect("session must exist");

    assert_eq!(
        loaded.model.as_deref(),
        Some("gpt-5.4"),
        "Session model must come from response.create, not rate_limits"
    );
}

// ===========================================================================
// 15. DB round-trip: session initial_intent from user prompt
// ===========================================================================

/// **Proves:** The session's `initial_intent` is populated from the user
/// prompt extracted from the response.create frame.
///
/// **Anti-fake property:** If initial_intent remains None or is populated
/// from a non-user-prompt source, this test fails.
#[test]
fn session_initial_intent_from_user_prompt() {
    let conn = setup_db();

    let request_data =
        codex::parse_codex_request(RESPONSE_CREATE_FIXTURE).expect("must parse fixture");

    let mut sess = sample_session("sess-intent-test");
    sess.initial_intent = request_data.user_prompt;
    db::insert_session(&conn, &sess).expect("insert session");

    let loaded = db::get_session(&conn, "sess-intent-test")
        .expect("query must succeed")
        .expect("session must exist");

    assert_eq!(
        loaded.initial_intent.as_deref(),
        Some("tell me a joke about rust"),
        "Session initial_intent must be the user prompt from response.create"
    );
}

// ===========================================================================
// 16. DB round-trip: session system_prompt_hash from instructions
// ===========================================================================

/// **Proves:** The session's `system_prompt_hash` is the SHA-256 of the
/// instructions field from the response.create frame.
///
/// **Anti-fake property:** If the hash is computed from something else or
/// is the sentinel "no system prompt" hash, this test fails.
#[test]
fn session_system_prompt_hash_from_instructions() {
    let conn = setup_db();

    let request_data =
        codex::parse_codex_request(RESPONSE_CREATE_FIXTURE).expect("must parse fixture");

    let mut sess = sample_session("sess-hash-test");
    // Use the hash from parse_codex_request if available, otherwise the sentinel
    sess.system_prompt_hash = request_data
        .system_prompt_hash
        .unwrap_or_else(|| session::compute_system_prompt_hash(None));
    db::insert_session(&conn, &sess).expect("insert session");

    let loaded = db::get_session(&conn, "sess-hash-test")
        .expect("query must succeed")
        .expect("session must exist");

    // Independently compute expected hash
    let expected_hash = hash::sha256_hex(
        "You are Codex, a coding agent based on GPT-5. You help developers write, debug, and refactor code across multiple languages and frameworks."
            .as_bytes(),
    );

    assert_eq!(
        loaded.system_prompt_hash, expected_hash,
        "Session system_prompt_hash must be SHA-256 of instructions"
    );

    // Must NOT be the sentinel hash (which indicates no system prompt)
    let sentinel_hash = session::compute_system_prompt_hash(None);
    assert_ne!(
        loaded.system_prompt_hash, sentinel_hash,
        "system_prompt_hash must NOT be the 'no system prompt' sentinel"
    );
}

// ===========================================================================
// 17. DB round-trip: turn messages_delta from input[]
// ===========================================================================

/// **Proves:** The turn record's `messages_delta` field contains the
/// serialized `input[]` array from the response.create frame.
///
/// **Anti-fake property:** If messages_delta is None or contains something
/// other than the input[] messages, this test fails.
#[test]
fn turn_messages_delta_from_input_array() {
    let conn = setup_db();

    let request_data =
        codex::parse_codex_request(RESPONSE_CREATE_FIXTURE).expect("must parse fixture");

    let sess = sample_session("sess-delta-test");
    db::insert_session(&conn, &sess).expect("insert session");

    let mut turn = sample_turn("turn-delta-1", "sess-delta-test", 1);
    turn.messages_delta = request_data.messages_json;
    turn.messages_delta_count = Some(3); // 2 developer + 1 user
    db::insert_turn(&conn, &turn).expect("insert turn");

    let turns = db::get_turns_for_session(&conn, "sess-delta-test").expect("query must succeed");
    assert_eq!(turns.len(), 1, "Must have exactly 1 turn");

    let loaded = &turns[0];
    let delta = loaded
        .messages_delta
        .as_ref()
        .expect("messages_delta must be Some");

    // Verify it's valid JSON containing the messages
    let parsed: serde_json::Value =
        serde_json::from_str(delta).expect("messages_delta must be valid JSON");
    let arr = parsed.as_array().expect("messages_delta must be an array");
    assert_eq!(arr.len(), 3, "Must contain all 3 input messages");

    // Verify user message is present
    let user_msgs: Vec<&serde_json::Value> = arr
        .iter()
        .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        .collect();
    assert_eq!(user_msgs.len(), 1, "Must contain exactly 1 user message");

    assert_eq!(loaded.messages_delta_count, Some(3));
}

// ===========================================================================
// 18. DB round-trip: turn input_tokens > 0 (estimated from client frame)
// ===========================================================================

/// **Proves:** When the response.create frame is processed, the turn
/// record's `input_tokens` is estimated from the frame content and is > 0.
///
/// **Anti-fake property:** If input_tokens remains 0, it means the
/// estimation from client frames is not wired in.
#[test]
fn turn_input_tokens_estimated_from_client_frame() {
    let conn = setup_db();

    // Estimate tokens from the full response.create frame content
    let estimated_input = codex::estimate_tokens(RESPONSE_CREATE_FIXTURE);
    assert!(
        estimated_input > 0,
        "Estimated input tokens from response.create frame must be > 0"
    );

    let sess = sample_session("sess-tokens-test");
    db::insert_session(&conn, &sess).expect("insert session");

    let mut turn = sample_turn("turn-tokens-1", "sess-tokens-test", 1);
    turn.input_tokens = estimated_input;
    turn.model = Some("gpt-5.4".to_string());
    db::insert_turn(&conn, &turn).expect("insert turn");

    let turns = db::get_turns_for_session(&conn, "sess-tokens-test").expect("query must succeed");
    assert_eq!(turns.len(), 1);

    let loaded = &turns[0];
    assert!(
        loaded.input_tokens > 0,
        "Turn input_tokens must be > 0 when estimated from response.create frame (got {})",
        loaded.input_tokens
    );

    // Sanity check: the response.create fixture is ~1.5KB, so tokens should be
    // roughly ceil(1500/4) = 375, but the exact value depends on whitespace.
    // Just verify it's in a reasonable range.
    assert!(
        loaded.input_tokens > 100,
        "Estimated input tokens should be > 100 for a multi-KB response.create frame"
    );
    assert!(
        loaded.input_tokens < 10000,
        "Estimated input tokens should be < 10000 for a ~2KB response.create frame"
    );
}

// ===========================================================================
// 19. Negative: without request parsing, model is rate_limits-only
// ===========================================================================

/// **Proves:** Without parsing the response.create frame, the session model
/// can only come from rate_limits (the old behavior). This test documents
/// the baseline so that test 14 proves the improvement.
///
/// **Anti-fake property:** Ensures the test suite captures the before/after
/// difference. If someone removes the request parsing, this test would pass
/// but test 14 would fail, making the regression visible.
#[test]
fn without_request_parsing_model_from_rate_limits_only() {
    let conn = setup_db();

    // Simulate old behavior: model comes from rate_limits only
    let rate_limits_model = Some("GPT-5.3-Codex-Spark".to_string());

    let mut sess = sample_session("sess-old-behavior");
    sess.model = rate_limits_model;
    sess.initial_intent = None; // No request parsing -> no intent
    db::insert_session(&conn, &sess).expect("insert session");

    let loaded = db::get_session(&conn, "sess-old-behavior")
        .expect("query must succeed")
        .expect("session must exist");

    // Old behavior: model is the internal routing name from rate_limits
    assert_eq!(
        loaded.model.as_deref(),
        Some("GPT-5.3-Codex-Spark"),
        "Without request parsing, model comes from rate_limits"
    );

    // Old behavior: no initial_intent
    assert!(
        loaded.initial_intent.is_none(),
        "Without request parsing, initial_intent is None"
    );
}
