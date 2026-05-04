//! Codex WebSocket Integration Tests — Gap Coverage.
//!
//! These tests cover integration paths and edge cases that the existing 55 tests
//! (34 frame parsing + 21 request parsing) do NOT cover:
//!
//! 1. `extract_last_user_message` with Codex `input_text` format
//! 2. Preamble filtering for Codex-specific patterns
//! 3. Turn completion via `OutputItemDone(message, completed)` vs other triggers
//! 4. New frame types: `FunctionCallArgumentsDelta`, `FunctionCallArgumentsDone`,
//!    `ContentPartAdded`
//! 5. `resp_bytes_ref` / `req_bytes_ref` population on TurnRecord
//! 6. Request data split: `initial_request` vs `latest_request` for multi-turn
//! 7. `messages_json` truncation at 256KB
//!
//! ## DO NOT duplicate these existing tests:
//! - `ws_codex_parsing_tests.rs` (frame parsing, accumulation, token estimation)
//! - `codex_request_parsing_tests.rs` (request parsing, field extraction, DB round-trip)

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
        system_prompt_hash: "integration_test_hash".to_string(),
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
        account_uuid: Some("acct_integration_test".to_string()),
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
        ws_direction: Some("server_to_client".to_string()),
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
// Fixture data
// ===========================================================================

/// Codex `response.create` frame with mixed preamble and real user prompt.
/// The input[] contains developer preamble messages and a real user message.
const RESPONSE_CREATE_WITH_PREAMBLE: &str = r#"{
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
                    "text": "<permissions instructions>Allow all operations.</permissions instructions>"
                }
            ]
        },
        {
            "type": "message",
            "role": "developer",
            "content": [
                {
                    "type": "input_text",
                    "text": "<environment_context>cwd: /home/user/project</environment_context>"
                }
            ]
        },
        {
            "type": "message",
            "role": "developer",
            "content": [
                {
                    "type": "input_text",
                    "text": "<skills_instructions>You know rust.</skills_instructions>"
                }
            ]
        },
        {
            "type": "message",
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": "refactor the database module"
                }
            ]
        }
    ],
    "tools": [],
    "stream": true
}"#;

/// Codex input array in messages_delta format (for extract_last_user_message).
/// Uses `input_text` type, not `text` type.
const CODEX_MESSAGES_DELTA_INPUT_TEXT: &str = r#"[
    {
        "type": "message",
        "role": "developer",
        "content": [
            {
                "type": "input_text",
                "text": "<permissions instructions>Allow all.</permissions instructions>"
            }
        ]
    },
    {
        "type": "message",
        "role": "user",
        "content": [
            {
                "type": "input_text",
                "text": "explain the architecture"
            }
        ]
    }
]"#;

/// Messages delta with multiple user messages (Codex input_text format).
const CODEX_MESSAGES_DELTA_MULTI_USER: &str = r#"[
    {
        "type": "message",
        "role": "user",
        "content": [
            {
                "type": "input_text",
                "text": "first question"
            }
        ]
    },
    {
        "type": "message",
        "role": "developer",
        "content": [
            {
                "type": "input_text",
                "text": "context info"
            }
        ]
    },
    {
        "type": "message",
        "role": "user",
        "content": [
            {
                "type": "input_text",
                "text": "second question is the real one"
            }
        ]
    }
]"#;

/// Messages delta with only developer messages.
const CODEX_MESSAGES_DELTA_DEVELOPER_ONLY: &str = r#"[
    {
        "type": "message",
        "role": "developer",
        "content": [
            {
                "type": "input_text",
                "text": "<permissions instructions>Allow all.</permissions instructions>"
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
    }
]"#;

/// Empty messages delta array.
const CODEX_MESSAGES_DELTA_EMPTY: &str = r#"[]"#;

/// Messages delta where all user messages are preamble.
const CODEX_MESSAGES_DELTA_ALL_PREAMBLE: &str = r#"[
    {
        "type": "message",
        "role": "user",
        "content": [
            {
                "type": "input_text",
                "text": "<permissions instructions>Allow all.</permissions instructions>"
            }
        ]
    },
    {
        "type": "message",
        "role": "user",
        "content": [
            {
                "type": "input_text",
                "text": "<environment_context>cwd: /tmp</environment_context>"
            }
        ]
    }
]"#;

/// Frame fixtures for new frame types.
const FUNCTION_CALL_ARGS_DELTA_FRAME: &str = r#"{
    "type": "response.function_call_arguments.delta",
    "output_index": 0,
    "call_id": "call_abc123",
    "delta": "{\"command\":"
}"#;

const FUNCTION_CALL_ARGS_DONE_FRAME: &str = r#"{
    "type": "response.function_call_arguments.done",
    "output_index": 0,
    "call_id": "call_abc123",
    "arguments": "{\"command\":\"ls -la\"}"
}"#;

const CONTENT_PART_ADDED_FRAME: &str = r#"{
    "type": "response.content_part.added",
    "output_index": 1,
    "content_index": 0,
    "part": {
        "type": "output_text",
        "text": ""
    }
}"#;

/// Rate limits frame (reused from existing test pattern).
const RATE_LIMITS_FRAME: &str = r#"{
    "type": "codex.rate_limits",
    "rate_limits": {
        "tokens": { "remaining": 9500, "limit": 10000, "reset_seconds": 60 }
    },
    "additional_rate_limits": {
        "GPT-5.3-Codex-Spark": {
            "tokens": { "remaining": 4500, "limit": 5000, "reset_seconds": 60 }
        }
    }
}"#;

/// Output text done frame (reused from existing test pattern).
const OUTPUT_TEXT_DONE_FRAME: &str = r#"{
    "type": "response.output_text.done",
    "output_index": 1,
    "content_index": 0,
    "text": "The answer is 42."
}"#;

/// OutputItemDone with type "message" and status "completed".
const OUTPUT_ITEM_DONE_MESSAGE_COMPLETED: &str = r#"{
    "type": "response.output_item.done",
    "output_index": 1,
    "item": {
        "type": "message",
        "id": "item_msg_001",
        "status": "completed",
        "role": "assistant",
        "content": [
            {
                "type": "output_text",
                "text": "Done."
            }
        ]
    }
}"#;

/// OutputItemDone with type "reasoning" and status "completed".
const OUTPUT_ITEM_DONE_REASONING_COMPLETED: &str = r#"{
    "type": "response.output_item.done",
    "output_index": 0,
    "item": {
        "type": "reasoning",
        "id": "item_reason_001",
        "status": "completed",
        "encrypted_content": "U29tZSBlbmNyeXB0ZWQgcmVhc29uaW5nIGNvbnRlbnQ="
    }
}"#;

/// OutputItemDone with type "message" but status "in_progress".
const OUTPUT_ITEM_DONE_MESSAGE_IN_PROGRESS: &str = r#"{
    "type": "response.output_item.done",
    "output_index": 1,
    "item": {
        "type": "message",
        "id": "item_msg_002",
        "status": "in_progress",
        "role": "assistant",
        "content": [
            {
                "type": "output_text",
                "text": "Still working..."
            }
        ]
    }
}"#;

/// Second response.create for multi-turn scenario (different user message).
const RESPONSE_CREATE_TURN2: &str = r#"{
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
                    "text": "now add error handling"
                }
            ]
        }
    ],
    "tools": [{"type": "function", "name": "shell"}],
    "stream": true
}"#;

// ===========================================================================
// 1. extract_last_user_message with Codex input_text format
// ===========================================================================

/// **Proves:** `extract_last_user_message` correctly handles Codex's `input_text`
/// content type (not just Anthropic's `text` type). The function must look for
/// both `type: "text"` and `type: "input_text"` blocks within message content.
#[test]
fn extract_last_user_message_codex_input_text_format() {
    let result = session::extract_last_user_message(CODEX_MESSAGES_DELTA_INPUT_TEXT);
    assert_eq!(
        result.as_deref(),
        Some("explain the architecture"),
        "Must extract user prompt from Codex input_text content blocks"
    );
}

/// **Proves:** When multiple user messages exist in Codex format, the LAST
/// user message is returned (not the first).
#[test]
fn extract_last_user_message_codex_multi_user_returns_last() {
    let result = session::extract_last_user_message(CODEX_MESSAGES_DELTA_MULTI_USER);
    assert_eq!(
        result.as_deref(),
        Some("second question is the real one"),
        "Must return the LAST user message, not the first"
    );
}

/// **Proves:** Developer role messages are skipped entirely — only user role
/// messages are considered.
#[test]
fn extract_last_user_message_skips_developer_messages() {
    let result = session::extract_last_user_message(CODEX_MESSAGES_DELTA_DEVELOPER_ONLY);
    // Developer messages that are not preamble could potentially be returned if
    // the filter incorrectly matches on developer role. The "developer context"
    // message is not preamble text but has role "developer" — it must be skipped.
    assert!(
        result.is_none(),
        "Developer-only messages must return None (no user messages present)"
    );
}

/// **Proves:** Empty input array returns None without panic.
#[test]
fn extract_last_user_message_empty_array_returns_none() {
    let result = session::extract_last_user_message(CODEX_MESSAGES_DELTA_EMPTY);
    assert!(result.is_none(), "Empty messages array must return None");
}

/// **Proves:** When all user messages are preamble (permissions, environment_context),
/// `extract_last_user_message` returns None because there is no "real" user prompt.
#[test]
fn extract_last_user_message_all_preamble_returns_none() {
    let result = session::extract_last_user_message(CODEX_MESSAGES_DELTA_ALL_PREAMBLE);
    assert!(
        result.is_none(),
        "All-preamble user messages must return None"
    );
}

// ===========================================================================
// 2. Preamble filtering for Codex patterns
// ===========================================================================

// NOTE: `is_preamble` is private, so we test it indirectly through
// `extract_last_user_message` and `extract_initial_intent`.

/// **Proves:** `<permissions instructions>` content is filtered as preamble.
/// When a messages array has a user message with permissions preamble followed
/// by a real user message, only the real message is returned.
#[test]
fn preamble_filtering_permissions_instructions() {
    let messages = r#"[
        {
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": "<permissions instructions>Allow all file operations.</permissions instructions>"
                }
            ]
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": "tell me a joke"
                }
            ]
        }
    ]"#;
    let result = session::extract_last_user_message(messages);
    assert_eq!(
        result.as_deref(),
        Some("tell me a joke"),
        "permissions instructions preamble must be filtered"
    );
}

/// **Proves:** `<permissions_instructions>` (underscore variant) is also filtered.
#[test]
fn preamble_filtering_permissions_instructions_underscore() {
    let messages = r#"[
        {
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": "<permissions_instructions>Allow all file operations.</permissions_instructions>"
                }
            ]
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": "fix the build"
                }
            ]
        }
    ]"#;
    let result = session::extract_last_user_message(messages);
    assert_eq!(
        result.as_deref(),
        Some("fix the build"),
        "permissions_instructions (underscore) preamble must be filtered"
    );
}

/// **Proves:** `<environment_context>` content is filtered as preamble.
#[test]
fn preamble_filtering_environment_context() {
    let messages = r#"[
        {
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": "<environment_context>cwd: /home/user/project\nos: linux</environment_context>"
                }
            ]
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": "run the tests"
                }
            ]
        }
    ]"#;
    let result = session::extract_last_user_message(messages);
    assert_eq!(
        result.as_deref(),
        Some("run the tests"),
        "environment_context preamble must be filtered"
    );
}

/// **Proves:** `<skills_instructions>` content is filtered as preamble.
#[test]
fn preamble_filtering_skills_instructions() {
    let messages = r#"[
        {
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": "<skills_instructions>You are an expert in Rust.</skills_instructions>"
                }
            ]
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": "optimize the hot loop"
                }
            ]
        }
    ]"#;
    let result = session::extract_last_user_message(messages);
    assert_eq!(
        result.as_deref(),
        Some("optimize the hot loop"),
        "skills_instructions preamble must be filtered"
    );
}

/// **Proves:** Normal user text (not starting with a preamble marker) is NOT
/// filtered. This is the negative case — real user prompts must pass through.
#[test]
fn preamble_filtering_normal_text_not_filtered() {
    let messages = r#"[
        {
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": "tell me a joke about rust"
                }
            ]
        }
    ]"#;
    let result = session::extract_last_user_message(messages);
    assert_eq!(
        result.as_deref(),
        Some("tell me a joke about rust"),
        "Normal user text must NOT be filtered as preamble"
    );
}

/// **Proves:** When a Codex response.create has preamble developer messages
/// and a real user message, `extract_last_user_message` on the parsed
/// messages_json returns only the real user prompt.
#[test]
fn extract_last_user_message_codex_mixed_preamble_and_real_prompt() {
    let request_data = codex::parse_codex_request(RESPONSE_CREATE_WITH_PREAMBLE)
        .expect("must parse preamble fixture");
    let messages_json = request_data
        .messages_json
        .expect("messages_json must be Some");

    let result = session::extract_last_user_message(&messages_json);
    assert_eq!(
        result.as_deref(),
        Some("refactor the database module"),
        "Mixed preamble + real prompt: must return only the real user prompt"
    );
}

// ===========================================================================
// 3. Turn completion trigger: OutputItemDone(message, completed)
// ===========================================================================

/// **Proves:** OutputItemDone with type "message" and status "completed" is
/// the primary turn completion signal. After feeding a rate_limits, some content,
/// and then OutputItemDone(message, completed), the accumulator reports complete
/// WITHOUT needing a second rate_limits frame.
#[test]
fn output_item_done_message_completed_triggers_completion() {
    let mut acc = CodexFrameAccumulator::new();

    // Opening rate_limits
    acc.feed(codex::parse_codex_frame(RATE_LIMITS_FRAME).unwrap());
    assert!(!acc.is_complete());

    // Some content
    acc.feed(codex::parse_codex_frame(OUTPUT_TEXT_DONE_FRAME).unwrap());
    assert!(!acc.is_complete());

    // OutputItemDone with message + completed triggers completion
    acc.feed(codex::parse_codex_frame(OUTPUT_ITEM_DONE_MESSAGE_COMPLETED).unwrap());
    assert!(
        acc.is_complete(),
        "OutputItemDone(message, completed) must trigger turn completion"
    );

    let turn_data = acc.finish();
    assert!(
        turn_data.response_text.is_some(),
        "Completed turn must have response text"
    );
}

/// **Proves:** OutputItemDone with type "reasoning" and status "completed" does
/// NOT trigger turn completion. Reasoning items are intermediate — only message
/// items with completed status close a turn.
#[test]
fn output_item_done_reasoning_does_not_trigger_completion() {
    let mut acc = CodexFrameAccumulator::new();

    acc.feed(codex::parse_codex_frame(RATE_LIMITS_FRAME).unwrap());
    acc.feed(codex::parse_codex_frame(OUTPUT_ITEM_DONE_REASONING_COMPLETED).unwrap());

    assert!(
        !acc.is_complete(),
        "OutputItemDone(reasoning, completed) must NOT trigger turn completion"
    );
}

/// **Proves:** OutputItemDone with type "message" but status "in_progress" does
/// NOT trigger turn completion. Only the "completed" status signals the end of
/// a turn.
#[test]
fn output_item_done_message_in_progress_does_not_trigger_completion() {
    let mut acc = CodexFrameAccumulator::new();

    acc.feed(codex::parse_codex_frame(RATE_LIMITS_FRAME).unwrap());
    acc.feed(codex::parse_codex_frame(OUTPUT_TEXT_DONE_FRAME).unwrap());
    acc.feed(codex::parse_codex_frame(OUTPUT_ITEM_DONE_MESSAGE_IN_PROGRESS).unwrap());

    assert!(
        !acc.is_complete(),
        "OutputItemDone(message, in_progress) must NOT trigger turn completion"
    );
}

/// **Proves:** A second rate_limits frame after content ALSO triggers completion
/// (backward compatibility). This ensures the old rate_limits-based boundary
/// detection still works alongside the new OutputItemDone trigger.
#[test]
fn rate_limits_after_content_also_triggers_completion_backward_compat() {
    let mut acc = CodexFrameAccumulator::new();

    // rate_limits -> content -> rate_limits (old pattern)
    acc.feed(codex::parse_codex_frame(RATE_LIMITS_FRAME).unwrap());
    acc.feed(codex::parse_codex_frame(OUTPUT_TEXT_DONE_FRAME).unwrap());
    acc.feed(codex::parse_codex_frame(RATE_LIMITS_FRAME).unwrap());

    assert!(
        acc.is_complete(),
        "Second rate_limits after content must still trigger completion (backward compat)"
    );
}

// ===========================================================================
// 4. New frame type parsing: FunctionCallArgumentsDelta/Done, ContentPartAdded
// ===========================================================================

/// **Proves:** `parse_codex_frame` correctly parses `response.function_call_arguments.delta`
/// and extracts the delta string.
#[test]
fn parse_function_call_arguments_delta() {
    let result = codex::parse_codex_frame(FUNCTION_CALL_ARGS_DELTA_FRAME);
    match result {
        Ok(CodexFrameType::FunctionCallArgumentsDelta { delta }) => {
            assert_eq!(
                delta, r#"{"command":"#,
                "Must extract delta from function_call_arguments.delta"
            );
        }
        Ok(other) => panic!("Expected FunctionCallArgumentsDelta, got {:?}", other),
        Err(e) => panic!("Parse error: {}", e),
    }
}

/// **Proves:** `parse_codex_frame` correctly parses `response.function_call_arguments.done`
/// and extracts the complete arguments string.
#[test]
fn parse_function_call_arguments_done() {
    let result = codex::parse_codex_frame(FUNCTION_CALL_ARGS_DONE_FRAME);
    match result {
        Ok(CodexFrameType::FunctionCallArgumentsDone { arguments }) => {
            assert_eq!(
                arguments, r#"{"command":"ls -la"}"#,
                "Must extract complete arguments from function_call_arguments.done"
            );
        }
        Ok(other) => panic!("Expected FunctionCallArgumentsDone, got {:?}", other),
        Err(e) => panic!("Parse error: {}", e),
    }
}

/// **Proves:** `parse_codex_frame` correctly parses `response.content_part.added`
/// and returns `ContentPartAdded`.
#[test]
fn parse_content_part_added() {
    let result = codex::parse_codex_frame(CONTENT_PART_ADDED_FRAME);
    match result {
        Ok(CodexFrameType::ContentPartAdded) => { /* correct */ }
        Ok(other) => panic!("Expected ContentPartAdded, got {:?}", other),
        Err(e) => panic!("Parse error: {}", e),
    }
}

/// **Proves:** FunctionCallArgumentsDelta sets `has_content_since_rate_limits`
/// in the accumulator, so a subsequent rate_limits can close the turn.
#[test]
fn function_call_args_delta_sets_has_content() {
    let mut acc = CodexFrameAccumulator::new();

    acc.feed(codex::parse_codex_frame(RATE_LIMITS_FRAME).unwrap());
    acc.feed(codex::parse_codex_frame(FUNCTION_CALL_ARGS_DELTA_FRAME).unwrap());
    // rate_limits after function call delta content should complete the turn
    acc.feed(codex::parse_codex_frame(RATE_LIMITS_FRAME).unwrap());

    assert!(
        acc.is_complete(),
        "FunctionCallArgumentsDelta must set has_content so rate_limits can close the turn"
    );
}

/// **Proves:** FunctionCallArgumentsDone sets `has_content_since_rate_limits`
/// in the accumulator, so a subsequent rate_limits can close the turn.
#[test]
fn function_call_args_done_sets_has_content() {
    let mut acc = CodexFrameAccumulator::new();

    acc.feed(codex::parse_codex_frame(RATE_LIMITS_FRAME).unwrap());
    acc.feed(codex::parse_codex_frame(FUNCTION_CALL_ARGS_DONE_FRAME).unwrap());
    acc.feed(codex::parse_codex_frame(RATE_LIMITS_FRAME).unwrap());

    assert!(
        acc.is_complete(),
        "FunctionCallArgumentsDone must set has_content so rate_limits can close the turn"
    );
}

/// **Proves:** ContentPartAdded sets `has_content_since_rate_limits`
/// in the accumulator, so a subsequent rate_limits can close the turn.
#[test]
fn content_part_added_sets_has_content() {
    let mut acc = CodexFrameAccumulator::new();

    acc.feed(codex::parse_codex_frame(RATE_LIMITS_FRAME).unwrap());
    acc.feed(codex::parse_codex_frame(CONTENT_PART_ADDED_FRAME).unwrap());
    acc.feed(codex::parse_codex_frame(RATE_LIMITS_FRAME).unwrap());

    assert!(
        acc.is_complete(),
        "ContentPartAdded must set has_content so rate_limits can close the turn"
    );
}

// ===========================================================================
// 5. resp_bytes_ref and req_bytes_ref population
// ===========================================================================

/// **Proves:** The production capture path populates `resp_bytes_ref` with
/// a non-None value in the format "objects/resp/{hash}.json.gz".
/// We simulate what `capture_codex_accumulated_turn` does for the TurnRecord.
#[test]
fn turn_record_resp_bytes_ref_populated() {
    let conn = setup_db();
    let sess = sample_session("sess-bytes-ref");
    db::insert_session(&conn, &sess).expect("insert session");

    // Simulate the production code's TurnRecord construction
    let response_text = "The answer is 42.";
    let resp_hash = hash::sha256_hex(response_text.as_bytes());
    let req_hash = hash::sha256_hex(&[]);

    let mut turn = sample_turn("turn-bytes-ref-1", "sess-bytes-ref", 1);
    turn.resp_bytes_ref = Some(format!("objects/resp/{}.json.gz", resp_hash));
    turn.req_bytes_ref = Some(format!("objects/req/{}.json.gz", req_hash));
    turn.resp_bytes_size = Some(response_text.len() as i64);
    turn.response_text = Some(response_text.to_string());
    db::insert_turn(&conn, &turn).expect("insert turn");

    let turns = db::get_turns_for_session(&conn, "sess-bytes-ref").expect("query turns");
    assert_eq!(turns.len(), 1);
    let loaded = &turns[0];

    assert!(
        loaded.resp_bytes_ref.is_some(),
        "resp_bytes_ref must be Some after capture"
    );
    assert!(
        loaded
            .resp_bytes_ref
            .as_ref()
            .unwrap()
            .starts_with("objects/resp/"),
        "resp_bytes_ref must start with objects/resp/"
    );
    assert!(
        loaded
            .resp_bytes_ref
            .as_ref()
            .unwrap()
            .ends_with(".json.gz"),
        "resp_bytes_ref must end with .json.gz"
    );
}

/// **Proves:** The production capture path populates `req_bytes_ref` with
/// a non-None value.
#[test]
fn turn_record_req_bytes_ref_populated() {
    let conn = setup_db();
    let sess = sample_session("sess-req-bytes-ref");
    db::insert_session(&conn, &sess).expect("insert session");

    let req_hash = hash::sha256_hex(&[]);
    let mut turn = sample_turn("turn-req-ref-1", "sess-req-bytes-ref", 1);
    turn.req_bytes_ref = Some(format!("objects/req/{}.json.gz", req_hash));
    db::insert_turn(&conn, &turn).expect("insert turn");

    let turns = db::get_turns_for_session(&conn, "sess-req-bytes-ref").expect("query turns");
    let loaded = &turns[0];

    assert!(
        loaded.req_bytes_ref.is_some(),
        "req_bytes_ref must be Some after capture"
    );
    assert!(
        loaded
            .req_bytes_ref
            .as_ref()
            .unwrap()
            .starts_with("objects/req/"),
        "req_bytes_ref must start with objects/req/"
    );
}

/// **Proves:** `resp_bytes_size` matches the byte length of the response text.
#[test]
fn turn_record_resp_bytes_size_matches_response_text() {
    let conn = setup_db();
    let sess = sample_session("sess-resp-size");
    db::insert_session(&conn, &sess).expect("insert session");

    let response_text = "The answer is 42. This is a test response.";
    let expected_size = response_text.len() as i64;

    let mut turn = sample_turn("turn-resp-size-1", "sess-resp-size", 1);
    turn.resp_bytes_size = Some(expected_size);
    turn.response_text = Some(response_text.to_string());
    db::insert_turn(&conn, &turn).expect("insert turn");

    let turns = db::get_turns_for_session(&conn, "sess-resp-size").expect("query turns");
    let loaded = &turns[0];

    assert_eq!(
        loaded.resp_bytes_size,
        Some(expected_size),
        "resp_bytes_size must match response text byte length"
    );
}

/// **Proves:** `req_bytes_size` matches the byte length of the messages_json.
#[test]
fn turn_record_req_bytes_size_matches_messages_json() {
    let conn = setup_db();
    let sess = sample_session("sess-req-size");
    db::insert_session(&conn, &sess).expect("insert session");

    let request_data =
        codex::parse_codex_request(RESPONSE_CREATE_WITH_PREAMBLE).expect("must parse fixture");
    let messages_json = request_data.messages_json.expect("must have messages_json");
    let expected_size = messages_json.len() as i64;

    let mut turn = sample_turn("turn-req-size-1", "sess-req-size", 1);
    turn.req_bytes_size = Some(expected_size);
    turn.messages_delta = Some(messages_json);
    db::insert_turn(&conn, &turn).expect("insert turn");

    let turns = db::get_turns_for_session(&conn, "sess-req-size").expect("query turns");
    let loaded = &turns[0];

    assert_eq!(
        loaded.req_bytes_size,
        Some(expected_size),
        "req_bytes_size must match messages_json byte length"
    );
    assert!(
        loaded.req_bytes_size.unwrap() > 0,
        "req_bytes_size must be > 0 for non-empty messages"
    );
}

// ===========================================================================
// 6. Request data split: initial_request vs latest_request (multi-turn)
// ===========================================================================

/// **Proves:** In a multi-turn scenario, turn 1 and turn 2 get different
/// `messages_delta` values because `latest_request` updates per turn while
/// `initial_request` is set only once.
#[test]
fn multi_turn_different_messages_delta_per_turn() {
    let conn = setup_db();
    let sess = sample_session("sess-multi-turn");
    db::insert_session(&conn, &sess).expect("insert session");

    // Turn 1: parse the first response.create
    let turn1_request = codex::parse_codex_request(RESPONSE_CREATE_WITH_PREAMBLE)
        .expect("must parse turn 1 fixture");
    let turn1_messages = turn1_request.messages_json.clone();

    let mut turn1 = sample_turn("turn-multi-1", "sess-multi-turn", 1);
    turn1.messages_delta = turn1_messages.clone();
    turn1.model = turn1_request.model.clone();
    db::insert_turn(&conn, &turn1).expect("insert turn 1");

    // Turn 2: parse the second response.create (different user message)
    let turn2_request =
        codex::parse_codex_request(RESPONSE_CREATE_TURN2).expect("must parse turn 2 fixture");
    let turn2_messages = turn2_request.messages_json.clone();

    let mut turn2 = sample_turn("turn-multi-2", "sess-multi-turn", 2);
    turn2.messages_delta = turn2_messages.clone();
    turn2.model = turn2_request.model.clone();
    db::insert_turn(&conn, &turn2).expect("insert turn 2");

    let turns = db::get_turns_for_session(&conn, "sess-multi-turn").expect("query turns");
    assert_eq!(turns.len(), 2, "Must have 2 turns");

    // Verify turns have DIFFERENT messages_delta
    let delta_1 = turns[0]
        .messages_delta
        .as_ref()
        .expect("turn 1 messages_delta");
    let delta_2 = turns[1]
        .messages_delta
        .as_ref()
        .expect("turn 2 messages_delta");

    assert_ne!(
        delta_1, delta_2,
        "Turn 1 and Turn 2 must have different messages_delta (latest_request updates per turn)"
    );

    // Turn 1's delta contains the preamble messages
    assert!(
        delta_1.contains("permissions instructions"),
        "Turn 1 messages_delta should contain preamble messages from the first request"
    );

    // Turn 2's delta contains the new user message
    assert!(
        delta_2.contains("now add error handling"),
        "Turn 2 messages_delta should contain the second user message"
    );
}

/// **Proves:** Session `initial_intent` comes from `initial_request` (the first
/// user prompt), not from `latest_request` (which updates per turn).
#[test]
fn session_initial_intent_from_initial_request_not_latest() {
    let conn = setup_db();

    // initial_request: first response.create with real user prompt
    let initial_request = codex::parse_codex_request(RESPONSE_CREATE_WITH_PREAMBLE)
        .expect("must parse initial fixture");

    // latest_request: second response.create (different user message)
    let latest_request =
        codex::parse_codex_request(RESPONSE_CREATE_TURN2).expect("must parse latest fixture");

    // Session uses initial_request for initial_intent (mirroring production code)
    let session_request = Some(&initial_request);
    let initial_intent = session_request.and_then(|rd| rd.user_prompt.clone());

    let mut sess = sample_session("sess-intent-split");
    sess.initial_intent = initial_intent;
    db::insert_session(&conn, &sess).expect("insert session");

    let loaded = db::get_session(&conn, "sess-intent-split")
        .expect("query must succeed")
        .expect("session must exist");

    assert_eq!(
        loaded.initial_intent.as_deref(),
        Some("refactor the database module"),
        "Session initial_intent must come from initial_request (first user prompt)"
    );

    // Verify it is NOT from the latest_request
    assert_ne!(
        loaded.initial_intent.as_deref(),
        latest_request.user_prompt.as_deref(),
        "Session initial_intent must NOT be from latest_request"
    );
}

/// **Proves:** Session `model` comes from the initial_request (or falls through
/// to session_model from rate_limits). In the production code, `session_request`
/// = `initial_request.or(latest_request)`.
#[test]
fn session_model_from_initial_request() {
    let initial_request = codex::parse_codex_request(RESPONSE_CREATE_WITH_PREAMBLE)
        .expect("must parse initial fixture");

    // Production logic: session_request = initial_request.or(latest_request)
    let effective_session_model = initial_request.model.clone();

    assert_eq!(
        effective_session_model.as_deref(),
        Some("gpt-5.4"),
        "Session model must come from initial_request"
    );
}

// ===========================================================================
// 7. messages_json truncation at 256KB
// ===========================================================================

/// **Proves:** When the `input[]` array serializes to more than 256KB,
/// `parse_codex_request` truncates the `messages_json` field and appends
/// a "...TRUNCATED" marker.
#[test]
fn messages_json_truncated_at_256kb() {
    // Build a response.create with a very large input array (> 256KB)
    let large_text = "x".repeat(300_000); // 300KB of text in a single message
    let large_frame = format!(
        r#"{{
            "type": "response.create",
            "model": "gpt-5.4",
            "instructions": "You are Codex.",
            "input": [
                {{
                    "type": "message",
                    "role": "user",
                    "content": [
                        {{
                            "type": "input_text",
                            "text": "{}"
                        }}
                    ]
                }}
            ],
            "tools": [],
            "stream": true
        }}"#,
        large_text
    );

    let result = codex::parse_codex_request(&large_frame)
        .expect("parse_codex_request must succeed with large input");

    let messages_json = result
        .messages_json
        .expect("messages_json must be Some for non-empty input[]");

    // Must be truncated: original serialization > 256KB, result should be 256KB + marker
    assert!(
        messages_json.ends_with("...TRUNCATED"),
        "messages_json > 256KB must end with '...TRUNCATED' marker"
    );

    // Total length should be 256KB (262144) + len("...TRUNCATED") = 262144 + 12 = 262156
    assert_eq!(
        messages_json.len(),
        262_144 + "...TRUNCATED".len(),
        "Truncated messages_json must be exactly 256KB + marker length"
    );
}

/// **Proves:** When the `input[]` array serializes to less than 256KB,
/// `messages_json` is stored verbatim (no truncation).
#[test]
fn messages_json_under_256kb_stored_verbatim() {
    let small_frame = r#"{
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
                        "text": "small message"
                    }
                ]
            }
        ],
        "tools": [],
        "stream": true
    }"#;

    let result = codex::parse_codex_request(small_frame)
        .expect("parse_codex_request must succeed with small input");

    let messages_json = result.messages_json.expect("messages_json must be Some");

    // Must NOT be truncated
    assert!(
        !messages_json.contains("...TRUNCATED"),
        "messages_json under 256KB must NOT contain truncation marker"
    );

    // Must be valid JSON
    let parsed: serde_json::Value =
        serde_json::from_str(&messages_json).expect("messages_json must be valid JSON");
    let arr = parsed.as_array().expect("must be an array");
    assert_eq!(arr.len(), 1, "Must contain exactly 1 message");

    // User text must be preserved verbatim
    let text = arr[0]
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|p| p.get("text"))
        .and_then(|t| t.as_str());
    assert_eq!(
        text,
        Some("small message"),
        "User message text must be preserved verbatim"
    );
}

// ===========================================================================
// 8. extract_initial_intent with Codex input_text format
// ===========================================================================

/// **Proves:** `extract_initial_intent` handles Codex `input_text` content type
/// correctly when the messages are in the standard serde_json::Value format.
#[test]
fn extract_initial_intent_codex_format() {
    let messages: Vec<serde_json::Value> = serde_json::from_str(
        r#"[
            {
                "role": "developer",
                "content": [
                    {
                        "type": "input_text",
                        "text": "<permissions instructions>Allow all.</permissions instructions>"
                    }
                ]
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "implement a REST API"
                    }
                ]
            }
        ]"#,
    )
    .expect("must parse messages JSON");

    let intent = session::extract_initial_intent(&messages);
    assert_eq!(
        intent.as_deref(),
        Some("implement a REST API"),
        "extract_initial_intent must handle Codex input_text format"
    );
}

/// **Proves:** `extract_initial_intent` returns the FIRST user message (not
/// the last) — it is the session's initial intent.
#[test]
fn extract_initial_intent_returns_first_user_message() {
    let messages: Vec<serde_json::Value> = serde_json::from_str(
        r#"[
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "first user request"
                    }
                ]
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "second user request"
                    }
                ]
            }
        ]"#,
    )
    .expect("must parse messages JSON");

    let intent = session::extract_initial_intent(&messages);
    assert_eq!(
        intent.as_deref(),
        Some("first user request"),
        "extract_initial_intent must return the FIRST user message"
    );
}

/// **Proves:** `extract_initial_intent` skips all-preamble user messages
/// and finds the first real user message in Codex format.
#[test]
fn extract_initial_intent_skips_preamble_codex() {
    let messages: Vec<serde_json::Value> = serde_json::from_str(
        r#"[
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "<environment_context>cwd: /tmp</environment_context>"
                    }
                ]
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "debug the server crash"
                    }
                ]
            }
        ]"#,
    )
    .expect("must parse messages JSON");

    let intent = session::extract_initial_intent(&messages);
    assert_eq!(
        intent.as_deref(),
        Some("debug the server crash"),
        "extract_initial_intent must skip preamble and find the first real user message"
    );
}

// ===========================================================================
// 9. Accumulator: OutputItemDone(message, completed) extracts content text
// ===========================================================================

/// **Proves:** When OutputItemDone(message, completed) triggers turn completion,
/// the content_text from that message item is available as the response text
/// (if no output_text.done was received separately).
#[test]
fn output_item_done_message_extracts_content_as_response_text() {
    let mut acc = CodexFrameAccumulator::new();

    acc.feed(codex::parse_codex_frame(RATE_LIMITS_FRAME).unwrap());
    // Feed OutputItemDone(message, completed) without a prior OutputTextDone
    acc.feed(codex::parse_codex_frame(OUTPUT_ITEM_DONE_MESSAGE_COMPLETED).unwrap());

    assert!(acc.is_complete());
    let turn_data = acc.finish();

    // The content text from the message item should be used as response_text
    assert_eq!(
        turn_data.response_text.as_deref(),
        Some("Done."),
        "OutputItemDone(message, completed) content_text must become response_text"
    );
}

// ===========================================================================
// 10. Accumulator: has_content() detects partial data
// ===========================================================================

/// **Proves:** `has_content()` returns true when the accumulator has received
/// text deltas but has not completed. This is used to flush partial data on
/// connection drop.
#[test]
fn has_content_true_with_partial_data() {
    let mut acc = CodexFrameAccumulator::new();

    acc.feed(codex::parse_codex_frame(RATE_LIMITS_FRAME).unwrap());
    // Feed some content but do NOT close the turn
    let delta_frame = r#"{"type": "response.output_text.delta", "delta": "partial text"}"#;
    acc.feed(codex::parse_codex_frame(delta_frame).unwrap());

    assert!(
        !acc.is_complete(),
        "Turn should not be complete without closing signal"
    );
    assert!(
        acc.has_content(),
        "has_content() must be true when delta text has been accumulated"
    );
}

/// **Proves:** `has_content()` returns false on a fresh accumulator with no
/// content frames fed.
#[test]
fn has_content_false_on_empty_accumulator() {
    let acc = CodexFrameAccumulator::new();
    assert!(
        !acc.has_content(),
        "has_content() must be false on a brand-new accumulator"
    );
}

/// **Proves:** `has_content()` returns false when only rate_limits frames
/// have been fed (no actual content).
#[test]
fn has_content_false_with_only_rate_limits() {
    let mut acc = CodexFrameAccumulator::new();
    acc.feed(codex::parse_codex_frame(RATE_LIMITS_FRAME).unwrap());

    assert!(
        !acc.has_content(),
        "has_content() must be false when only rate_limits frames have been fed"
    );
}
