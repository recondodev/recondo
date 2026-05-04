//! Category C: Anthropic Request Parser tests.
//!
//! These tests verify that the providers::anthropic module correctly parses
//! raw JSON request bodies for the Anthropic Messages API.

use recondo_gateway::providers::anthropic::parse_request;

// ===========================================================================
// C.1 Parse request with string system prompt
// ===========================================================================

/// **Proves:** A request with a string system prompt extracts it correctly.
#[test]
fn parse_request_with_string_system_prompt() {
    let body = br#"{
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 1024,
        "system": "You are a helpful assistant.",
        "messages": [
            {"role": "user", "content": "Hello"}
        ]
    }"#;

    let parsed = parse_request(body).expect("Must parse valid request");

    assert_eq!(
        parsed.system.as_deref(),
        Some("You are a helpful assistant."),
        "system prompt must be extracted as a string"
    );
}

/// **Proves:** A request with an array-style system prompt (content blocks)
/// extracts it as a string.
#[test]
fn parse_request_with_array_system_prompt() {
    let body = br#"{
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 2048,
        "system": [
            {"type": "text", "text": "You are a coding assistant."},
            {"type": "text", "text": " Be precise."}
        ],
        "messages": [
            {"role": "user", "content": "Write hello world"}
        ]
    }"#;

    let parsed = parse_request(body).expect("Must parse valid request");

    // The system prompt should be the concatenation of all text blocks
    let system = parsed
        .system
        .expect("system must be Some for array system prompt");
    assert!(
        system.contains("You are a coding assistant."),
        "System prompt must contain first text block"
    );
    assert!(
        system.contains("Be precise."),
        "System prompt must contain second text block"
    );
}

// ===========================================================================
// C.2 Parse request with messages array
// ===========================================================================

/// **Proves:** The messages array is extracted preserving the original structure.
#[test]
fn parse_request_extracts_messages_array() {
    let body = br#"{
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 1024,
        "messages": [
            {"role": "user", "content": "What is 2+2?"},
            {"role": "assistant", "content": "4"},
            {"role": "user", "content": "And 3+3?"}
        ]
    }"#;

    let parsed = parse_request(body).unwrap();

    assert_eq!(parsed.messages.len(), 3, "Must extract all 3 messages");
    assert_eq!(parsed.messages[0]["role"].as_str().unwrap(), "user");
    assert_eq!(parsed.messages[1]["role"].as_str().unwrap(), "assistant");
    assert_eq!(parsed.messages[2]["content"].as_str().unwrap(), "And 3+3?");
}

// ===========================================================================
// C.3 Parse request with tools
// ===========================================================================

/// **Proves:** Tool definitions are extracted when present.
#[test]
fn parse_request_extracts_tools() {
    let body = br#"{
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 4096,
        "tools": [
            {
                "name": "read_file",
                "description": "Read a file from disk",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"}
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "write_file",
                "description": "Write a file to disk",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "content": {"type": "string"}
                    },
                    "required": ["path", "content"]
                }
            }
        ],
        "messages": [
            {"role": "user", "content": "Read main.rs"}
        ]
    }"#;

    let parsed = parse_request(body).unwrap();

    let tools = parsed
        .tools
        .expect("tools must be Some when tools array is present");
    assert_eq!(tools.len(), 2, "Must extract 2 tool definitions");
    assert_eq!(tools[0]["name"].as_str().unwrap(), "read_file");
    assert_eq!(tools[1]["name"].as_str().unwrap(), "write_file");
}

// ===========================================================================
// C.4 Extract model name
// ===========================================================================

/// **Proves:** The model field is correctly extracted.
#[test]
fn parse_request_extracts_model() {
    let body = br#"{
        "model": "claude-opus-4-20250514",
        "max_tokens": 8192,
        "messages": [
            {"role": "user", "content": "Hi"}
        ]
    }"#;

    let parsed = parse_request(body).unwrap();

    assert_eq!(
        parsed.model, "claude-opus-4-20250514",
        "model must be extracted correctly"
    );
}

/// **Proves:** max_tokens is extracted correctly.
#[test]
fn parse_request_extracts_max_tokens() {
    let body = br#"{
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 4096,
        "messages": [
            {"role": "user", "content": "Hi"}
        ]
    }"#;

    let parsed = parse_request(body).unwrap();

    assert_eq!(
        parsed.max_tokens, 4096,
        "max_tokens must be extracted correctly"
    );
}

// ===========================================================================
// C.5 Handle missing optional fields
// ===========================================================================

/// **Proves:** When system prompt is absent, system is None.
#[test]
fn missing_system_prompt_is_none() {
    let body = br#"{
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 1024,
        "messages": [
            {"role": "user", "content": "Hello"}
        ]
    }"#;

    let parsed = parse_request(body).unwrap();

    assert!(
        parsed.system.is_none(),
        "system must be None when not present in request"
    );
}

/// **Proves:** When tools are absent, tools is None.
#[test]
fn missing_tools_is_none() {
    let body = br#"{
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 1024,
        "messages": [
            {"role": "user", "content": "Hello"}
        ]
    }"#;

    let parsed = parse_request(body).unwrap();

    assert!(
        parsed.tools.is_none(),
        "tools must be None when not present in request"
    );
}

// ===========================================================================
// Negative: Invalid JSON request body
// ===========================================================================

/// **Proves:** Malformed JSON returns an error, not a panic.
#[test]
fn invalid_json_body_returns_error() {
    let body = b"this is not JSON at all {{{";
    let result = parse_request(body);

    assert!(result.is_err(), "Malformed JSON must return an error");
}

/// **Proves:** A valid JSON body missing required fields returns an error.
#[test]
fn missing_required_model_field_returns_error() {
    let body = br#"{
        "max_tokens": 1024,
        "messages": [
            {"role": "user", "content": "Hello"}
        ]
    }"#;

    let result = parse_request(body);

    assert!(
        result.is_err(),
        "Request missing 'model' field must return an error"
    );
}

/// **Proves:** Request with no messages field returns an error.
#[test]
fn missing_messages_field_returns_error() {
    let body = br#"{
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 1024
    }"#;

    let result = parse_request(body);

    assert!(
        result.is_err(),
        "Request missing 'messages' field must return an error"
    );
}

/// **Proves:** Empty body (zero bytes) returns an error.
#[test]
fn empty_body_returns_error() {
    let result = parse_request(b"");

    assert!(result.is_err(), "Empty request body must return an error");
}
