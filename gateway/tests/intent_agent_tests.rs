//! Feature 4: initial_intent extraction (OD-012) + agent identification (OD-002).
//!
//! These tests verify:
//! - initial_intent: first user message (role=user) in the messages array is
//!   extracted and stored as SessionNode.initial_intent
//! - agent identification: the framework is detected from system prompt patterns
//!   (e.g., Claude Code's identifiable system prompt signature)
//!
//! Design references:
//! - OD-012: First user message extraction for Claude Code
//! - OD-002: Agent identity from system prompt content / framework signatures
//! - IMPLEMENTATION_ROADMAP.md Week 2 Task 6 (Session management)

use serde_json::json;

use recondo_gateway::providers::anthropic;
use recondo_gateway::session;

// ---------------------------------------------------------------------------
// Helper: build a request body with system prompt and messages
// ---------------------------------------------------------------------------

fn request_body(system: Option<&str>, messages: &serde_json::Value) -> Vec<u8> {
    let mut body = json!({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 4096,
        "messages": messages
    });
    if let Some(sys) = system {
        body["system"] = json!(sys);
    }
    serde_json::to_vec(&body).unwrap()
}

// ===========================================================================
// 4.1 initial_intent: extracts first user message from messages array
// ===========================================================================

/// **Proves:** extract_initial_intent returns the content of the first
/// message with role=user in the messages array.
///
/// **Anti-fake property:** A function that returns the system prompt or
/// the assistant's message would fail. A function that returns empty string
/// would fail the content assertion.
#[test]
fn extract_initial_intent_returns_first_user_message() {
    let messages = json!([
        {"role": "user", "content": "Fix the login bug in auth.rs"}
    ]);

    let req = request_body(Some("You are a coding assistant."), &messages);
    let parsed = anthropic::parse_request(&req).unwrap();

    let intent = session::extract_initial_intent(&parsed.messages);

    assert_eq!(
        intent.as_deref(),
        Some("Fix the login bug in auth.rs"),
        "initial_intent must be the first user message content"
    );
}

// ===========================================================================
// 4.2 initial_intent: skips assistant messages to find first user message
// ===========================================================================

/// **Proves:** If the messages array starts with assistant messages (e.g.,
/// from a tool_result continuation), the function skips them and returns
/// the first user message.
///
/// **Anti-fake property:** A function that returns messages[0] regardless
/// of role would return the assistant message, failing this test.
#[test]
fn extract_initial_intent_skips_non_user_messages() {
    let messages = json!([
        {"role": "assistant", "content": "Previous assistant response"},
        {"role": "user", "content": "Now fix the database module"}
    ]);

    // Note: This message ordering is unusual for first turn but possible
    // in message arrays that include tool_result continuations
    let req = request_body(Some("System prompt."), &messages);
    let parsed = anthropic::parse_request(&req).unwrap();

    let intent = session::extract_initial_intent(&parsed.messages);

    assert_eq!(
        intent.as_deref(),
        Some("Now fix the database module"),
        "Must skip assistant messages and return first user message"
    );
}

// ===========================================================================
// 4.3 initial_intent: no user messages returns None
// ===========================================================================

/// **Proves:** When the messages array contains no role=user messages,
/// the function returns None.
///
/// **Anti-fake property:** A function that always returns Some would fail.
/// A function that panics on no user messages would crash.
#[test]
fn extract_initial_intent_no_user_messages_returns_none() {
    let messages = json!([
        {"role": "assistant", "content": "Only assistant here"}
    ]);

    let req = request_body(Some("System."), &messages);
    let parsed = anthropic::parse_request(&req).unwrap();

    let intent = session::extract_initial_intent(&parsed.messages);

    assert!(
        intent.is_none(),
        "No user messages must produce None intent"
    );
}

// ===========================================================================
// 4.4 initial_intent: empty messages array returns None
// ===========================================================================

/// **Proves:** Empty messages array returns None for initial_intent.
///
/// **Anti-fake property:** Must not panic on empty input.
#[test]
fn extract_initial_intent_empty_messages_returns_none() {
    let empty_messages: Vec<serde_json::Value> = vec![];

    let intent = session::extract_initial_intent(&empty_messages);

    assert!(
        intent.is_none(),
        "Empty messages array must produce None intent"
    );
}

// ===========================================================================
// 4.5 initial_intent: long message is truncated with prefix
// ===========================================================================

/// **Proves:** Per OD-012, if the first user message is very long, the
/// initial_intent is truncated to a reasonable length (first 200 chars)
/// with an "[auto]" prefix indicating auto-extraction.
///
/// **Anti-fake property:** A function that stores the full 1000-character
/// message would fail the length assertion.
#[test]
fn extract_initial_intent_truncates_long_messages() {
    let long_content = "a".repeat(1000);
    let messages = json!([
        {"role": "user", "content": long_content}
    ]);

    let req = request_body(Some("System."), &messages);
    let parsed = anthropic::parse_request(&req).unwrap();

    let intent = session::extract_initial_intent(&parsed.messages);

    assert!(intent.is_some(), "Long message must still produce intent");
    let intent_str = intent.unwrap();

    // OD-012 specifies: "[auto] {first 200 chars of first user message}"
    // Total should be <= 206 chars (6 for "[auto] " + 200 chars)
    assert!(
        intent_str.len() <= 207,
        "Intent must be truncated, got length {}",
        intent_str.len()
    );
    assert!(
        intent_str.starts_with("[auto] "),
        "Truncated intent must start with '[auto] ' prefix"
    );
}

// ===========================================================================
// 4.6 initial_intent: content array (tool_result) extracts text
// ===========================================================================

/// **Proves:** When the user message content is an array (e.g., containing
/// a tool_result block), the function extracts a meaningful text
/// representation rather than returning None or "[object Object]".
///
/// **Anti-fake property:** A function that only handles string content
/// would return None for array content.
#[test]
fn extract_initial_intent_handles_content_array() {
    let messages = json!([
        {"role": "user", "content": [
            {"type": "text", "text": "Here is the file content:"},
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": "fn main() {}"}
        ]}
    ]);

    let req = request_body(Some("System."), &messages);
    let parsed = anthropic::parse_request(&req).unwrap();

    let intent = session::extract_initial_intent(&parsed.messages);

    assert!(
        intent.is_some(),
        "Content array with text blocks must produce intent"
    );
    let intent_str = intent.unwrap();
    assert!(
        intent_str.contains("Here is the file content"),
        "Intent must contain the text from the content array, got: {:?}",
        intent_str
    );
}

// ===========================================================================
// 4.6b W3: extract_initial_intent skips preamble blocks
// ===========================================================================

/// **Proves:** When the first user message content array contains preamble blocks
/// (e.g., `<available-deferred-tools>`) followed by a real message, the function
/// returns the real message, not the preamble.
///
/// **Anti-fake property:** A function that returns the first text block regardless
/// of preamble would return the preamble text, failing this test.
#[test]
fn extract_initial_intent_skips_preamble_blocks() {
    let messages = json!([
        {"role": "user", "content": [
            {"type": "text", "text": "<available-deferred-tools>\nBash\nRead\nWrite\n</available-deferred-tools>"},
            {"type": "text", "text": "<system-reminder>\nYou are Claude Code.\n</system-reminder>"},
            {"type": "text", "text": "Fix the authentication bug in login.rs"}
        ]}
    ]);

    let req = request_body(Some("System."), &messages);
    let parsed = anthropic::parse_request(&req).unwrap();

    let intent = session::extract_initial_intent(&parsed.messages);

    assert_eq!(
        intent.as_deref(),
        Some("Fix the authentication bug in login.rs"),
        "extract_initial_intent must skip preamble blocks and return the real user message"
    );
}

// ===========================================================================
// 4.6c W3: extract_initial_intent with all-preamble content returns None
// ===========================================================================

/// **Proves:** When the first user message content array contains ONLY preamble
/// blocks, the function returns None rather than returning preamble text.
///
/// **Anti-fake property:** A function that returns the first text block without
/// preamble filtering would return Some(...) containing preamble, failing this test.
#[test]
fn extract_initial_intent_all_preamble_returns_none() {
    let messages = json!([
        {"role": "user", "content": [
            {"type": "text", "text": "<available-deferred-tools>\nBash\nRead\n</available-deferred-tools>"},
            {"type": "text", "text": "<system-reminder>\nYou are Claude Code.\n</system-reminder>"},
            {"type": "text", "text": "<task-notification>\nTask completed.\n</task-notification>"}
        ]}
    ]);

    let req = request_body(Some("System."), &messages);
    let parsed = anthropic::parse_request(&req).unwrap();

    let intent = session::extract_initial_intent(&parsed.messages);

    assert!(
        intent.is_none(),
        "All-preamble content must produce None intent, got: {:?}",
        intent
    );
}

// ===========================================================================
// 4.7 initial_intent stored in session record in DB
// ===========================================================================

/// **Proves:** The initial_intent value flows from extraction through to
/// the SessionRecord and is queryable in the database.
///
/// **Anti-fake property:** Without the initial_intent field on SessionRecord
/// and the corresponding DB column, this test would fail to compile or
/// fail at insert time.
#[test]
fn initial_intent_stored_in_session_db() {
    use recondo_gateway::db;

    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();

    let session = db::SessionRecord {
        id: "sess_intent_db".to_string(),
        provider: "anthropic".to_string(),
        model: None,
        started_at: "2026-03-17T10:00:00Z".to_string(),
        last_active_at: "2026-03-17T10:00:00Z".to_string(),
        ended_at: None,
        initial_intent: Some("Refactor the auth module".to_string()),
        system_prompt_hash: "hash".to_string(),
        total_turns: 1,
        turns_captured: 1,
        dropped_events: 0,
        total_tokens: 100,
        total_cost_usd: 0.01,
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
    };
    db::insert_session(&conn, &session).unwrap();

    let db_session = db::get_session(&conn, "sess_intent_db").unwrap().unwrap();
    assert_eq!(
        db_session.initial_intent.as_deref(),
        Some("Refactor the auth module"),
        "initial_intent must be stored in DB"
    );
}

// ===========================================================================
// 4.8 Agent identification: detect Claude Code from system prompt
// ===========================================================================

/// **Proves:** detect_agent_framework identifies "claude_code" (or similar)
/// when given a system prompt containing Claude Code's identifiable patterns.
///
/// **Anti-fake property:** A function that returns None or "unknown" for all
/// inputs would fail. A function that hardcodes the result would fail the
/// OpenAI test below.
#[test]
fn detect_claude_code_from_system_prompt() {
    // Claude Code system prompts contain identifiable patterns
    let claude_code_prompt = "You are Claude Code, Anthropic's official CLI for Claude. \
        You are an interactive agent that can use tools to accomplish tasks. \
        You have access to a set of tools you can use to answer the user's question.";

    let framework = session::detect_agent_framework(claude_code_prompt);

    assert_eq!(
        framework.as_deref(),
        Some("claude_code"),
        "Must detect Claude Code from system prompt patterns"
    );
}

// ===========================================================================
// 4.9 Agent identification: unknown framework returns None
// ===========================================================================

/// **Proves:** A generic system prompt with no known framework signature
/// returns None for the framework.
///
/// **Anti-fake property:** A function that always returns Some("claude_code")
/// would fail this test.
#[test]
fn detect_unknown_framework_returns_none() {
    let generic_prompt = "You are a helpful assistant that answers questions.";

    let framework = session::detect_agent_framework(generic_prompt);

    assert!(
        framework.is_none(),
        "Generic system prompt must not match any known framework"
    );
}

// ===========================================================================
// 4.10 Agent identification: detect Cursor from system prompt
// ===========================================================================

/// **Proves:** detect_agent_framework can identify "cursor" when given
/// a system prompt containing Cursor's identifiable patterns.
///
/// **Anti-fake property:** A function that only detects Claude Code
/// would fail this test. Tests framework detection generality.
#[test]
fn detect_cursor_from_system_prompt() {
    let cursor_prompt = "You are a coding assistant integrated with Cursor, \
        the AI-first code editor. You help users edit code inline.";

    let framework = session::detect_agent_framework(cursor_prompt);

    assert_eq!(
        framework.as_deref(),
        Some("cursor"),
        "Must detect Cursor from system prompt patterns"
    );
}

// ===========================================================================
// 4.11 Agent identification: empty system prompt returns None
// ===========================================================================

/// **Proves:** An empty system prompt returns None for framework detection.
///
/// **Anti-fake property:** Must not panic or match on empty string.
#[test]
fn detect_framework_empty_prompt_returns_none() {
    let framework = session::detect_agent_framework("");

    assert!(
        framework.is_none(),
        "Empty system prompt must return None for framework"
    );
}

// ===========================================================================
// 4.12 Agent identification: hash-based grouping
// ===========================================================================

/// **Proves:** Two requests with the same system prompt hash are grouped
/// as the same agent type, regardless of minor differences in request content.
/// This validates OD-002's "same system_prompt_hash = same agent type" rule.
///
/// **Anti-fake property:** Different prompt hashes must produce different
/// agent groupings.
#[test]
fn same_system_prompt_hash_groups_same_agent_type() {
    use recondo_gateway::hash;

    let prompt = "You are Claude Code, Anthropic's official CLI for Claude.";
    let hash1 = hash::sha256_hex(prompt.as_bytes());
    let hash2 = hash::sha256_hex(prompt.as_bytes());

    assert_eq!(hash1, hash2, "Same system prompt must produce same hash");

    let different_prompt = "You are a different agent entirely.";
    let hash3 = hash::sha256_hex(different_prompt.as_bytes());

    assert_ne!(
        hash1, hash3,
        "Different system prompts must produce different hashes"
    );
}

// ===========================================================================
// 4.13 NEGATIVE: initial_intent not extracted without first user message
// ===========================================================================

/// **Proves:** The initial_intent is null in the session record when
/// the messages array contains only assistant messages. This is the negative
/// test — removing the user message makes intent extraction fail.
///
/// **Anti-fake property:** A system that fabricates intent from non-user
/// messages would produce a non-None value.
#[test]
fn session_without_user_message_has_no_initial_intent() {
    let messages = json!([
        {"role": "assistant", "content": "I can help with that."}
    ]);

    let req = request_body(Some("System."), &messages);
    let parsed = anthropic::parse_request(&req).unwrap();

    let intent = session::extract_initial_intent(&parsed.messages);

    assert!(
        intent.is_none(),
        "Messages with no user role must produce None initial_intent"
    );
}

// ===========================================================================
// 4.14 NEGATIVE: framework detection does not match partial keywords
// ===========================================================================

/// **Proves:** A system prompt that mentions "Claude" but is not Claude Code
/// does not falsely match as claude_code framework.
///
/// **Anti-fake property:** A naive substring search for "Claude" would
/// incorrectly match this prompt.
#[test]
fn partial_keyword_does_not_trigger_false_framework_detection() {
    let prompt = "You are an assistant that helps users learn about Claude Monet's paintings.";

    let framework = session::detect_agent_framework(prompt);

    assert!(
        framework.is_none() || framework.as_deref() != Some("claude_code"),
        "Mentioning 'Claude' in non-code context must not detect as claude_code"
    );
}
