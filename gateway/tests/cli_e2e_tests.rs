//! End-to-end behavioral tests for the recondo capture pipeline and CLI query functions.
//!
//! These tests validate that data flowing through the full capture pipeline
//! (realistic Anthropic SSE responses with HTTP headers) produces correct,
//! queryable results via CLI-visible database functions.
//!
//! ## Known bugs these tests are designed to catch
//!
//! 1. **HTTP headers in response bytes**: The captured response includes
//!    `HTTP/1.1 200 OK\r\n...headers...\r\n\r\n` before the SSE body. The SSE
//!    parser expects pure SSE events. It needs to strip HTTP headers first.
//!
//! 2. **HTTP headers in request bytes**: The captured request includes
//!    `POST /v1/messages HTTP/1.1\r\n...headers...\r\n\r\n` before the JSON body.
//!    The JSON parser expects pure JSON. It needs to strip HTTP headers first.
//!
//! 3. **Session identity**: Session ID = sha256(org_id + first_user_message).
//!    Same first user message = same session (regardless of time gap or system
//!    prompt changes). Different first user message = different session.

use tempfile::TempDir;

use recondo_gateway::db;
use recondo_gateway::providers::anthropic;
use recondo_gateway::session::SessionManager;
use recondo_gateway::storage::graph::SqliteGraphStore;
use recondo_gateway::storage::object::LocalObjectStore;
use recondo_gateway::storage::pipeline::WritePipeline;
use recondo_gateway::stream;

// ---------------------------------------------------------------------------
// Test data — realistic captured bytes from the gateway
// ---------------------------------------------------------------------------

/// Realistic captured response bytes. This is what the gateway actually captures:
/// HTTP status line + headers + \r\n\r\n + SSE body.
/// The SSE parser must strip the HTTP headers before parsing.
fn response_bytes_with_http_headers() -> Vec<u8> {
    b"HTTP/1.1 200 OK\r\n\
Content-Type: text/event-stream\r\n\
\r\n\
event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_test123\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-opus-4-6-20250219\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":1500,\"output_tokens\":0}}}\n\
\n\
event: content_block_start\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\
\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello! I can help you with that.\"}}\n\
\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":12}}\n\
\n\
event: message_stop\n\
data: {\"type\":\"message_stop\"}\n\
\n"
        .to_vec()
}

/// Pure SSE body without HTTP headers (for comparison).
fn response_bytes_pure_sse() -> Vec<u8> {
    b"event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_test123\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-opus-4-6-20250219\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":1500,\"output_tokens\":0}}}\n\
\n\
event: content_block_start\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\
\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello! I can help you with that.\"}}\n\
\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":12}}\n\
\n\
event: message_stop\n\
data: {\"type\":\"message_stop\"}\n\
\n"
        .to_vec()
}

/// Realistic captured request bytes with HTTP headers.
fn request_bytes_with_http_headers() -> Vec<u8> {
    b"POST /v1/messages HTTP/1.1\r\n\
Content-Type: application/json\r\n\
x-api-key: sk-ant-test\r\n\
\r\n\
{\"model\":\"claude-opus-4-6-20250219\",\"max_tokens\":8096,\"messages\":[{\"role\":\"user\",\"content\":\"What is 2+2?\"}],\"system\":\"You are a helpful assistant.\",\"stream\":true}"
        .to_vec()
}

/// Pure JSON request body without HTTP headers.
fn request_bytes_pure_json() -> Vec<u8> {
    b"{\"model\":\"claude-opus-4-6-20250219\",\"max_tokens\":8096,\"messages\":[{\"role\":\"user\",\"content\":\"What is 2+2?\"}],\"system\":\"You are a helpful assistant.\",\"stream\":true}"
        .to_vec()
}

/// Request bytes with a different system prompt but the SAME first user message.
/// Under the content-based session model, session ID = sha256(org_id + first_user_message),
/// so changing only the system prompt must NOT create a new session.
fn request_bytes_different_system_prompt() -> Vec<u8> {
    b"POST /v1/messages HTTP/1.1\r\n\
Content-Type: application/json\r\n\
x-api-key: sk-ant-test\r\n\
\r\n\
{\"model\":\"claude-opus-4-6-20250219\",\"max_tokens\":8096,\"messages\":[{\"role\":\"user\",\"content\":\"What is 2+2?\"}],\"system\":\"You are a comedian.\",\"stream\":true}"
        .to_vec()
}

/// Request bytes with a completely different first user message (for different-session tests).
/// Under the content-based session model, a different first user message produces a different session.
fn request_bytes_different_first_message() -> Vec<u8> {
    b"POST /v1/messages HTTP/1.1\r\n\
Content-Type: application/json\r\n\
x-api-key: sk-ant-test\r\n\
\r\n\
{\"model\":\"claude-opus-4-6-20250219\",\"max_tokens\":8096,\"messages\":[{\"role\":\"user\",\"content\":\"Tell me a joke.\"}],\"system\":\"You are a helpful assistant.\",\"stream\":true}"
        .to_vec()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Create a WritePipeline backed by in-memory SQLite + temp filesystem.
fn create_test_pipeline() -> (WritePipeline, TempDir) {
    let tmp = TempDir::new().expect("Must create temp dir");
    let data_dir = tmp.path().to_path_buf();
    let dlq_dir = data_dir.join("dlq");

    let graph = SqliteGraphStore::new_in_memory().expect("Must create in-memory graph store");
    let objects = LocalObjectStore::new(&data_dir);

    let pipeline = WritePipeline::new(Box::new(graph), Box::new(objects), dlq_dir);

    (pipeline, tmp)
}

/// Create an in-memory DB connection for direct query tests.
#[allow(dead_code)]
fn create_test_db() -> rusqlite::Connection {
    let conn = db::open_in_memory().expect("Must open in-memory DB");
    db::initialize(&conn).expect("Must initialize schema");
    conn
}

// =============================================================================
// Section 1: Response Parsing with HTTP Headers (5 tests)
//
// These test that the SSE parser correctly handles response bytes that include
// HTTP headers. The tests import `strip_http_headers` from
// `recondo_gateway::stream` and verify header stripping + SSE parsing works.
// =============================================================================

/// Feed the realistic response bytes (with HTTP headers) through the parser
/// pipeline. Assert model is "claude-opus-4-6-20250219", NOT empty.
#[test]
fn response_with_http_headers_parses_model() {
    let raw = response_bytes_with_http_headers();

    // strip_http_headers must exist and correctly strip HTTP headers before SSE parsing.
    let sse_bytes = stream::strip_http_headers(&raw);
    let accumulated = stream::parse_sse_stream(sse_bytes);
    let parsed = anthropic::parse_response(&accumulated.events)
        .expect("parse_response must succeed on stripped SSE bytes");

    assert_eq!(
        parsed.model, "claude-opus-4-6-20250219",
        "Model must be parsed from SSE events after stripping HTTP headers. \
         Got empty or wrong model: {:?}",
        parsed.model
    );
    assert!(
        !parsed.model.is_empty(),
        "Model must NOT be empty — this indicates HTTP headers were not stripped"
    );
}

/// Feed realistic response bytes (with HTTP headers) through the parser.
/// Assert input_tokens=1500, output_tokens=12, NOT 0.
#[test]
fn response_with_http_headers_parses_tokens() {
    let raw = response_bytes_with_http_headers();
    let sse_bytes = stream::strip_http_headers(&raw);
    let accumulated = stream::parse_sse_stream(sse_bytes);
    let parsed =
        anthropic::parse_response(&accumulated.events).expect("parse_response must succeed");

    assert_eq!(
        parsed.input_tokens, 1500,
        "input_tokens must be 1500, got {}. If 0, HTTP headers were not stripped.",
        parsed.input_tokens
    );
    assert_eq!(
        parsed.output_tokens, 12,
        "output_tokens must be 12, got {}. If 0, HTTP headers were not stripped.",
        parsed.output_tokens
    );
}

/// Assert response_text contains "Hello! I can help you with that.", NOT empty.
#[test]
fn response_with_http_headers_parses_response_text() {
    let raw = response_bytes_with_http_headers();
    let sse_bytes = stream::strip_http_headers(&raw);
    let accumulated = stream::parse_sse_stream(sse_bytes);
    let parsed =
        anthropic::parse_response(&accumulated.events).expect("parse_response must succeed");

    assert!(
        !parsed.response_text.is_empty(),
        "response_text must NOT be empty — this indicates HTTP headers broke SSE parsing"
    );
    assert!(
        parsed
            .response_text
            .contains("Hello! I can help you with that."),
        "response_text must contain the expected text. Got: {:?}",
        parsed.response_text
    );
}

/// Assert stop_reason is "end_turn", NOT empty.
#[test]
fn response_with_http_headers_parses_stop_reason() {
    let raw = response_bytes_with_http_headers();
    let sse_bytes = stream::strip_http_headers(&raw);
    let accumulated = stream::parse_sse_stream(sse_bytes);
    let parsed =
        anthropic::parse_response(&accumulated.events).expect("parse_response must succeed");

    assert_eq!(
        parsed.stop_reason, "end_turn",
        "stop_reason must be 'end_turn', got {:?}. If empty, HTTP headers were not stripped.",
        parsed.stop_reason
    );
}

/// The raw bytes include HTTP headers. After stripping, the first SSE event
/// should be "message_start". Test that the stripping function exists and works.
#[test]
fn response_with_http_headers_strips_headers_before_sse() {
    let raw = response_bytes_with_http_headers();
    let sse_bytes = stream::strip_http_headers(&raw);

    // The stripped bytes should NOT start with "HTTP/"
    let starts_with_http = sse_bytes.starts_with(b"HTTP/");
    assert!(
        !starts_with_http,
        "After strip_http_headers, bytes must NOT start with 'HTTP/' — \
         HTTP headers were not stripped"
    );

    // The stripped bytes should start with SSE content (event: ...)
    let starts_with_event = sse_bytes.starts_with(b"event:");
    assert!(
        starts_with_event,
        "After strip_http_headers, bytes must start with 'event:' — \
         got: {:?}",
        String::from_utf8_lossy(&sse_bytes[..std::cmp::min(50, sse_bytes.len())])
    );

    // Parse and verify the first event is message_start
    let accumulated = stream::parse_sse_stream(sse_bytes);
    assert!(
        !accumulated.events.is_empty(),
        "Must have at least one SSE event after stripping headers"
    );
    assert_eq!(
        accumulated.events[0].event_type, "message_start",
        "First SSE event must be 'message_start', got {:?}",
        accumulated.events[0].event_type
    );

    // Pure SSE bytes (without HTTP headers) should pass through unchanged
    let pure_sse = response_bytes_pure_sse();
    let stripped_pure = stream::strip_http_headers(&pure_sse);
    assert_eq!(
        stripped_pure,
        &pure_sse[..],
        "strip_http_headers on pure SSE bytes must return them unchanged"
    );
}

// =============================================================================
// Section 2: Full Pipeline E2E — Capture to CLI Query (6 tests)
//
// These create a WritePipeline with SqliteGraphStore + LocalObjectStore, push
// realistic capture data through it, then query via the GraphStore to verify
// CLI-visible fields.
//
// NOTE: These tests call `process_capture_with_pipeline` which currently passes
// raw response bytes (including HTTP headers) directly to the SSE parser. The
// tests will FAIL until the HTTP header stripping bug is fixed inside
// `process_capture_with_pipeline`.
// =============================================================================

/// After capture, list_sessions returns 1 session with non-empty model,
/// non-zero total_tokens, non-empty initial_intent.
#[test]
fn e2e_capture_produces_queryable_session() {
    let (pipeline, _tmp) = create_test_pipeline();
    let mut session_mgr = SessionManager::new();

    let req_bytes = request_bytes_with_http_headers();
    let resp_bytes = response_bytes_with_http_headers();

    let turn = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes,
        &resp_bytes,
        None,
        None, // no metrics registry
    )
    .expect("process_capture_with_pipeline must succeed");

    // Query sessions via the GraphStore (simulating CLI `recondo sessions` command)
    let sessions = pipeline
        .graph()
        .list_sessions(None)
        .expect("list_sessions must succeed");

    assert_eq!(
        sessions.len(),
        1,
        "Must have exactly 1 session after one capture, got {}",
        sessions.len()
    );

    let session = &sessions[0];
    assert!(
        session.model.is_some() && !session.model.as_ref().unwrap().is_empty(),
        "Session model must be non-empty. Got: {:?}. \
         If None/empty, the SSE parser failed to extract the model (HTTP header bug).",
        session.model
    );
    assert_eq!(
        session.model.as_deref(),
        Some("claude-opus-4-6-20250219"),
        "Session model must match the model from SSE events"
    );
    assert!(
        session.total_tokens > 0,
        "Session total_tokens must be > 0, got {}. \
         If 0, the SSE parser failed to extract tokens (HTTP header bug).",
        session.total_tokens
    );
    assert!(
        session.initial_intent.is_some(),
        "Session initial_intent must be non-empty. Got: {:?}. \
         If None, the request parser failed to extract the user message (HTTP header bug).",
        session.initial_intent
    );
    assert!(
        session.initial_intent.as_ref().unwrap().contains("2+2"),
        "Initial intent must contain the user's question. Got: {:?}",
        session.initial_intent
    );

    // Verify the turn also has the correct session_id
    assert_eq!(turn.session_id, session.id);
}

/// get_turns_for_session returns turns with: model="claude-opus-4-6-20250219",
/// input_tokens=1500, output_tokens=12, stop_reason="end_turn",
/// response_text containing "Hello".
#[test]
fn e2e_capture_produces_queryable_turns() {
    let (pipeline, _tmp) = create_test_pipeline();
    let mut session_mgr = SessionManager::new();

    let req_bytes = request_bytes_with_http_headers();
    let resp_bytes = response_bytes_with_http_headers();

    let turn = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes,
        &resp_bytes,
        None,
        None, // no metrics registry
    )
    .expect("process_capture_with_pipeline must succeed");

    let turns = pipeline
        .graph()
        .get_turns_for_session(&turn.session_id)
        .expect("get_turns_for_session must succeed");

    assert_eq!(turns.len(), 1, "Must have exactly 1 turn");
    let t = &turns[0];

    assert_eq!(
        t.model.as_deref(),
        Some("claude-opus-4-6-20250219"),
        "Turn model must be 'claude-opus-4-6-20250219', got {:?}. \
         If None/empty, HTTP headers broke SSE parsing.",
        t.model
    );
    assert_eq!(
        t.input_tokens, 1500,
        "Turn input_tokens must be 1500, got {}. If 0, HTTP header bug.",
        t.input_tokens
    );
    assert_eq!(
        t.output_tokens, 12,
        "Turn output_tokens must be 12, got {}. If 0, HTTP header bug.",
        t.output_tokens
    );
    assert_eq!(
        t.stop_reason, "end_turn",
        "Turn stop_reason must be 'end_turn', got {:?}. If empty, HTTP header bug.",
        t.stop_reason
    );
    assert!(
        t.response_text.is_some(),
        "Turn response_text must be Some, got None. HTTP header bug."
    );
    assert!(
        t.response_text.as_ref().unwrap().contains("Hello"),
        "Turn response_text must contain 'Hello'. Got: {:?}. HTTP header bug.",
        t.response_text
    );
    assert!(
        t.capture_complete,
        "Turn capture_complete must be true (message_stop was in the SSE stream)"
    );
}

/// verify_integrity returns all passed for the captured session.
#[test]
fn e2e_capture_produces_verifiable_hashes() {
    let (pipeline, _tmp) = create_test_pipeline();
    let mut session_mgr = SessionManager::new();

    let req_bytes = request_bytes_with_http_headers();
    let resp_bytes = response_bytes_with_http_headers();

    let turn = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes,
        &resp_bytes,
        None,
        None, // no metrics registry
    )
    .expect("process_capture_with_pipeline must succeed");

    // Verify integrity with deep verification (re-reads objects from disk)
    let results = pipeline
        .graph()
        .verify_integrity(&turn.session_id, Some(pipeline.objects()))
        .expect("verify_integrity must succeed");

    assert!(
        !results.is_empty(),
        "verify_integrity must return at least 1 result"
    );
    for result in &results {
        assert!(
            result.passed,
            "Integrity check must pass for turn {}. Details: {:?}",
            result.turn_id, result.details
        );
    }
}

/// After capture, search_turns("Hello") returns the turn.
#[test]
fn e2e_search_finds_captured_response_text() {
    // This test uses the db module's search_turns which requires a raw Connection.
    // We set up a file-backed DB in a temp dir so the pipeline and direct queries
    // use the same database.
    let tmp = TempDir::new().expect("Must create temp dir");
    let data_dir = tmp.path().to_path_buf();
    let db_path = data_dir.join("recondo.db");
    let dlq_dir = data_dir.join("dlq");

    // Create a file-backed pool so we can also open a direct connection for search
    let pool = recondo_gateway::storage::pool::ConnectionPool::sqlite(&db_path)
        .expect("Must create sqlite pool");
    let graph = pool.graph_store();
    let objects = LocalObjectStore::new(&data_dir);

    let pipeline = WritePipeline::new(graph, Box::new(objects), dlq_dir);
    let mut session_mgr = SessionManager::new();

    let req_bytes = request_bytes_with_http_headers();
    let resp_bytes = response_bytes_with_http_headers();

    recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes,
        &resp_bytes,
        None,
        None, // no metrics registry
    )
    .expect("process_capture_with_pipeline must succeed");

    // Open a direct connection to search turns (simulating CLI `recondo search` command)
    let conn = db::open(&db_path).expect("Must open DB for search query");
    let results = db::search_turns(&conn, "Hello", None).expect("search_turns must succeed");

    assert!(
        !results.is_empty(),
        "search_turns('Hello') must return at least 1 result. \
         If empty, the response_text was not stored (HTTP header bug)."
    );
    assert!(
        results[0].response_text.as_ref().unwrap().contains("Hello"),
        "Search result response_text must contain 'Hello'. Got: {:?}",
        results[0].response_text
    );
}

/// get_stats returns total_sessions >= 1, total_turns >= 1, total_tokens > 0,
/// models_used contains "claude-opus-4-6-20250219".
#[test]
fn e2e_stats_reflect_captured_data() {
    let tmp = TempDir::new().expect("Must create temp dir");
    let data_dir = tmp.path().to_path_buf();
    let db_path = data_dir.join("recondo.db");
    let dlq_dir = data_dir.join("dlq");

    let pool = recondo_gateway::storage::pool::ConnectionPool::sqlite(&db_path)
        .expect("Must create sqlite pool");
    let graph = pool.graph_store();
    let objects = LocalObjectStore::new(&data_dir);

    let pipeline = WritePipeline::new(graph, Box::new(objects), dlq_dir);
    let mut session_mgr = SessionManager::new();

    let req_bytes = request_bytes_with_http_headers();
    let resp_bytes = response_bytes_with_http_headers();

    recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes,
        &resp_bytes,
        None,
        None, // no metrics registry
    )
    .expect("process_capture_with_pipeline must succeed");

    // Query stats (simulating CLI `recondo stats` command)
    let conn = db::open(&db_path).expect("Must open DB for stats query");
    let stats = db::get_stats(&conn).expect("get_stats must succeed");

    assert!(
        stats.total_sessions >= 1,
        "total_sessions must be >= 1, got {}",
        stats.total_sessions
    );
    assert!(
        stats.total_turns >= 1,
        "total_turns must be >= 1, got {}",
        stats.total_turns
    );
    assert!(
        stats.total_tokens > 0,
        "total_tokens must be > 0, got {}. If 0, tokens were not parsed (HTTP header bug).",
        stats.total_tokens
    );
    assert!(
        stats
            .models_used
            .contains(&"claude-opus-4-6-20250219".to_string()),
        "models_used must contain 'claude-opus-4-6-20250219'. Got: {:?}. \
         If empty, model was not parsed (HTTP header bug).",
        stats.models_used
    );
}

/// Push two captures with the same first user message. Assert they land in the
/// SAME session (1 session, 2 turns), not 2 separate sessions.
/// Under the content-based model: same first user message = same session.
#[test]
fn e2e_two_turns_same_session_not_fragmented() {
    let (pipeline, _tmp) = create_test_pipeline();
    let mut session_mgr = SessionManager::new();

    let req_bytes = request_bytes_with_http_headers();
    let resp_bytes = response_bytes_with_http_headers();

    // First capture
    let turn1 = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes,
        &resp_bytes,
        None,
        None, // no metrics registry
    )
    .expect("First capture must succeed");

    // Second capture — same request (same system prompt)
    let turn2 = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes,
        &resp_bytes,
        None,
        None, // no metrics registry
    )
    .expect("Second capture must succeed");

    // Both turns must be in the same session (same first user message = same session)
    assert_eq!(
        turn1.session_id, turn2.session_id,
        "Two captures with the same first user message must be in the same session. \
         Session ID = sha256(org_id + first_user_message). \
         Got different sessions: {:?} vs {:?}.",
        turn1.session_id, turn2.session_id
    );

    // Verify via list_sessions
    let sessions = pipeline
        .graph()
        .list_sessions(None)
        .expect("list_sessions must succeed");
    assert_eq!(
        sessions.len(),
        1,
        "Must have 1 session (not fragmented into {}). \
         Same first user message must always produce the same session.",
        sessions.len()
    );

    // Verify 2 turns in the session
    let turns = pipeline
        .graph()
        .get_turns_for_session(&turn1.session_id)
        .expect("get_turns_for_session must succeed");
    assert_eq!(
        turns.len(),
        2,
        "Must have 2 turns in the session, got {}",
        turns.len()
    );
    assert_eq!(
        turns[0].sequence_num, 1,
        "First turn sequence_num must be 1"
    );
    assert_eq!(
        turns[1].sequence_num, 2,
        "Second turn sequence_num must be 2"
    );
}

// =============================================================================
// Section 3: Session Boundary Tests — Content-Based Session Identity
//
// Session ID = sha256(org_id + first_user_message_content).
// Same first user message + same org -> same session (regardless of time gap
// or system prompt changes). Different first user message -> different session.
// =============================================================================

/// Two captures with identical first user messages -> 1 session.
/// This tests the fundamental content-based identity rule.
#[test]
fn same_first_message_same_session() {
    let (pipeline, _tmp) = create_test_pipeline();
    let mut session_mgr = SessionManager::new();

    let req_bytes = request_bytes_with_http_headers();
    let resp_bytes = response_bytes_with_http_headers();

    let turn1 = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes,
        &resp_bytes,
        None,
        None, // no metrics registry
    )
    .expect("First capture must succeed");

    let turn2 = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes,
        &resp_bytes,
        None,
        None, // no metrics registry
    )
    .expect("Second capture must succeed");

    assert_eq!(
        turn1.session_id, turn2.session_id,
        "Same first user message must produce same session. \
         Session ID = sha256(org_id + first_user_message). Got {:?} vs {:?}",
        turn1.session_id, turn2.session_id
    );

    let sessions = pipeline.graph().list_sessions(None).expect("list_sessions");
    assert_eq!(sessions.len(), 1, "Must have exactly 1 session");
}

/// Two captures with different system prompts but the SAME first user message
/// must stay in the SAME session. Session identity is content-based:
/// session_id = sha256(org_id + first_user_message). System prompt changes
/// (which happen every request in Claude Code due to dynamic tool lists)
/// do NOT split sessions.
#[test]
fn different_system_prompt_same_session_same_first_message() {
    let (pipeline, _tmp) = create_test_pipeline();
    let mut session_mgr = SessionManager::new();

    let req_bytes_1 = request_bytes_with_http_headers();
    let resp_bytes = response_bytes_with_http_headers();

    // First capture: system="You are a helpful assistant.", first_msg="What is 2+2?"
    let turn1 = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes_1,
        &resp_bytes,
        None,
        None, // no metrics registry
    )
    .expect("First capture must succeed");

    // Second capture: system="You are a comedian.", first_msg="What is 2+2?" (same!)
    let req_bytes_2 = request_bytes_different_system_prompt();
    let turn2 = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes_2,
        &resp_bytes,
        None,
        None, // no metrics registry
    )
    .expect("Second capture must succeed");

    // Content-based session model: same first user message = same session.
    // System prompt changes are irrelevant to session identity.
    assert_eq!(
        turn1.session_id, turn2.session_id,
        "Same first user message must produce same session regardless of system prompt. \
         Session ID = sha256(org_id + first_user_message)."
    );

    let sessions = pipeline.graph().list_sessions(None).expect("list_sessions");
    assert_eq!(
        sessions.len(),
        1,
        "Must have exactly 1 session (system prompt changes don't split sessions), got {}",
        sessions.len()
    );
}

/// Two captures with DIFFERENT first user messages must create DIFFERENT sessions,
/// even if they have the same system prompt. Session identity is content-based:
/// session_id = sha256(org_id + first_user_message).
#[test]
fn different_first_message_creates_different_session() {
    let (pipeline, _tmp) = create_test_pipeline();
    let mut session_mgr = SessionManager::new();

    let resp_bytes = response_bytes_with_http_headers();

    // First capture: first_msg="What is 2+2?"
    let req_bytes_1 = request_bytes_with_http_headers();
    let turn1 = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes_1,
        &resp_bytes,
        None,
        None, // no metrics registry
    )
    .expect("First capture must succeed");

    // Second capture: first_msg="Tell me a joke." (different first message!)
    let req_bytes_2 = request_bytes_different_first_message();
    let turn2 = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes_2,
        &resp_bytes,
        None,
        None, // no metrics registry
    )
    .expect("Second capture must succeed");

    // Content-based session model: different first user message = different session.
    assert_ne!(
        turn1.session_id, turn2.session_id,
        "Different first user messages must produce different sessions. \
         Session ID = sha256(org_id + first_user_message)."
    );

    let sessions = pipeline.graph().list_sessions(None).expect("list_sessions");
    assert_eq!(
        sessions.len(),
        2,
        "Must have 2 sessions (different first user messages), got {}",
        sessions.len()
    );
}

/// Same first user message across any time gap stays in the same session.
/// Session identity is content-based (sha256(org_id + first_user_message)),
/// NOT time-based. A 31-minute gap does NOT split the session.
#[test]
fn same_first_message_stays_same_session_regardless_of_time() {
    let mut session_mgr = SessionManager::new();
    let msgs = [serde_json::json!({"role":"user","content":"What is 2+2?"})];

    let r1 = session_mgr
        .resolve(
            &msgs,
            None,
            Some("prompt"),
            "2026-03-19T10:00:00Z",
            None,
            None,
        )
        .expect("First resolve must succeed");

    // Even 31 minutes later — same first message = same session
    let r2 = session_mgr
        .resolve(
            &msgs,
            None,
            Some("prompt"),
            "2026-03-19T10:31:01Z",
            None,
            None,
        )
        .expect("Second resolve must succeed");

    assert_eq!(
        r1.session_id, r2.session_id,
        "Same content = same session regardless of time gap"
    );
    assert!(!r2.is_new_session);
}

/// Two captures with same first user message 1 second apart -> 1 session.
/// Under the content-based model, the time gap is irrelevant; what matters
/// is the first user message being the same.
#[test]
fn short_gap_same_session() {
    let mut session_mgr = SessionManager::new();

    let t1 = "2026-03-19T10:00:00Z";
    let res1 = session_mgr
        .resolve(
            &[serde_json::json!({"role":"user","content":"What is 2+2?"})],
            None,
            Some("You are a helpful assistant."),
            t1,
            None,
            None,
        )
        .expect("First resolve must succeed");

    let t2 = "2026-03-19T10:00:01Z";
    let res2 = session_mgr
        .resolve(
            &[serde_json::json!({"role":"user","content":"What is 2+2?"})],
            None,
            Some("You are a helpful assistant."),
            t2,
            None,
            None,
        )
        .expect("Second resolve must succeed");

    assert!(
        !res2.is_new_session,
        "Same first user message must NOT create a new session (time gap is irrelevant)"
    );
    assert_eq!(
        res1.session_id, res2.session_id,
        "Same first user message must keep the same session ID"
    );
    assert_eq!(
        res2.sequence_num, 2,
        "Second resolve must be sequence_num 2"
    );
}

// =============================================================================
// Section 4: Negative Tests (3 tests)
// =============================================================================

/// Empty response bytes produce a turn with capture_complete=false or empty
/// fields, no crash.
#[test]
fn empty_response_bytes_still_creates_turn() {
    let (pipeline, _tmp) = create_test_pipeline();
    let mut session_mgr = SessionManager::new();

    // Use pure JSON request (no HTTP headers) so request parsing succeeds
    // while response is empty — isolating the empty-response behavior.
    let req_bytes = request_bytes_pure_json();
    let resp_bytes: Vec<u8> = Vec::new();

    let result = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes,
        &resp_bytes,
        None,
        None, // no metrics registry
    );

    // The function should not panic. It may return Ok (with a degraded turn)
    // or Err (if it rejects empty responses). Either is acceptable.
    // What matters is NO CRASH.
    match result {
        Ok(turn) => {
            // If it returns Ok, the turn should indicate incomplete capture
            // or have empty/None parsed fields.
            assert!(
                !turn.capture_complete || turn.model.is_none(),
                "Empty response should produce incomplete capture or missing model"
            );
        }
        Err(e) => {
            // If it returns Err, that's also acceptable — just verify it's
            // a controlled error, not a panic.
            let err_msg = format!("{}", e);
            assert!(
                !err_msg.is_empty(),
                "Error message must be non-empty for empty response bytes"
            );
        }
    }
}

/// Garbage response bytes produce parse_errors in the turn, not a crash.
#[test]
fn malformed_sse_records_parse_errors() {
    let (pipeline, _tmp) = create_test_pipeline();
    let mut session_mgr = SessionManager::new();

    let req_bytes = request_bytes_pure_json();
    let resp_bytes = b"THIS IS NOT SSE DATA AT ALL\n\nJUST RANDOM GARBAGE\x00\xFF\xFE".to_vec();

    let result = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes,
        &resp_bytes,
        None,
        None, // no metrics registry
    );

    // Should not panic. May return Ok (with parse_errors) or Err.
    match result {
        Ok(turn) => {
            // Garbage SSE data should result in parse errors being recorded
            assert!(
                turn.parse_errors.is_some() || !turn.capture_complete || turn.model.is_none(),
                "Malformed SSE should produce parse_errors, incomplete capture, or missing model. \
                 Turn: model={:?}, capture_complete={}, parse_errors={:?}",
                turn.model,
                turn.capture_complete,
                turn.parse_errors
            );
        }
        Err(e) => {
            // Controlled error, not a panic
            let err_msg = format!("{}", e);
            assert!(
                !err_msg.is_empty(),
                "Error message must be non-empty for malformed SSE data"
            );
        }
    }
}

/// search_turns("xyznonexistent") returns empty vec.
#[test]
fn search_no_results_returns_empty() {
    let tmp = TempDir::new().expect("Must create temp dir");
    let data_dir = tmp.path().to_path_buf();
    let db_path = data_dir.join("recondo.db");
    let dlq_dir = data_dir.join("dlq");

    let pool = recondo_gateway::storage::pool::ConnectionPool::sqlite(&db_path)
        .expect("Must create sqlite pool");
    let graph = pool.graph_store();
    let objects = LocalObjectStore::new(&data_dir);

    let pipeline = WritePipeline::new(graph, Box::new(objects), dlq_dir);
    let mut session_mgr = SessionManager::new();

    // Push one capture so the DB has data
    let req_bytes = request_bytes_with_http_headers();
    let resp_bytes = response_bytes_with_http_headers();

    recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes,
        &resp_bytes,
        None,
        None, // no metrics registry
    )
    .expect("Capture must succeed");

    // Search for a string that does NOT appear in any captured data
    let conn = db::open(&db_path).expect("Must open DB");
    let results =
        db::search_turns(&conn, "xyznonexistent", None).expect("search_turns must succeed");

    assert!(
        results.is_empty(),
        "search_turns('xyznonexistent') must return empty vec, got {} results",
        results.len()
    );
}

// =============================================================================
// Section 5: Proving the fix is necessary (W3) — raw bytes break SSE parsing
// =============================================================================

/// The SSE parser silently ignores HTTP header lines (they don't match `event:` or `data:`).
/// However, when the Content-Type header happens to contain "event" (e.g., "text/event-stream"),
/// it could be mis-parsed. More importantly, feeding raw bytes with HTTP headers to the
/// Anthropic response parser (which expects SSE) still fails to produce correct structured data
/// because the raw_bytes include the HTTP framing. strip_http_headers ensures clean input.
///
/// This test verifies that: (1) strip_http_headers produces correct output, (2) the stripped
/// output parses into a valid Anthropic response, and (3) the request parser also works after
/// stripping.
#[test]
fn raw_http_response_needs_stripping_for_correct_parsing() {
    let raw_resp = response_bytes_with_http_headers();
    let raw_req = request_bytes_with_http_headers();

    // strip_http_headers must remove the HTTP headers
    let stripped_resp = stream::strip_http_headers(&raw_resp);
    let stripped_req = stream::strip_http_headers(&raw_req);

    // Verify the stripping actually removed content
    assert!(
        stripped_resp.len() < raw_resp.len(),
        "Stripped response must be smaller than raw (headers removed). \
         Raw: {} bytes, stripped: {} bytes",
        raw_resp.len(),
        stripped_resp.len()
    );
    assert!(
        stripped_req.len() < raw_req.len(),
        "Stripped request must be smaller than raw (headers removed). \
         Raw: {} bytes, stripped: {} bytes",
        raw_req.len(),
        stripped_req.len()
    );

    // The stripped bytes must NOT start with HTTP
    assert!(
        !stripped_resp.starts_with(b"HTTP/"),
        "Stripped response must not start with HTTP/"
    );
    assert!(
        !stripped_req.starts_with(b"POST "),
        "Stripped request must not start with POST"
    );

    // SSE parsing on stripped bytes must succeed
    let accumulated = stream::parse_sse_stream(stripped_resp);
    assert!(accumulated.complete, "Stripped SSE stream must be complete");
    assert_eq!(accumulated.events.len(), 5, "Must have 5 SSE events");

    // Anthropic response parser must succeed on stripped+parsed events
    let parsed_resp = anthropic::parse_response(&accumulated.events)
        .expect("Anthropic response parsing must succeed on stripped bytes");
    assert_eq!(parsed_resp.model, "claude-opus-4-6-20250219");
    assert_eq!(parsed_resp.input_tokens, 1500);
    assert_eq!(parsed_resp.output_tokens, 12);

    // Anthropic request parser must succeed on stripped bytes
    let parsed_req = anthropic::parse_request(stripped_req)
        .expect("Anthropic request parsing must succeed on stripped bytes");
    assert_eq!(
        parsed_req.system.as_deref(),
        Some("You are a helpful assistant.")
    );

    // Without stripping, the request parser FAILS (raw bytes start with "POST /v1/messages...")
    let raw_req_parse = anthropic::parse_request(&raw_req);
    assert!(
        raw_req_parse.is_err(),
        "Raw request bytes (with HTTP headers) must fail JSON parsing. \
         If this passes, the request doesn't have HTTP headers."
    );
}

// =============================================================================
// Section 6: Chunked transfer encoding decoding (W1)
// =============================================================================

/// Response bytes with chunked transfer encoding framing, split across multiple
/// chunks. When SSE data is split across chunks, the hex chunk-size line
/// appears mid-stream and breaks SSE event parsing. prepare_response_body must
/// reassemble the chunks before SSE parsing.
#[test]
fn chunked_response_decoded_before_sse_parsing() {
    // Simulate a realistic chunked response with MULTIPLE chunks. When the
    // server sends events in separate chunks, the hex size lines land between
    // SSE events, corrupting the data: lines and breaking event boundaries.
    let chunk1 = b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_chunked\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-opus-4-6-20250219\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":100,\"output_tokens\":0}}}\n\n";
    let chunk2 = b"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\n";
    let chunk3 = b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";

    // Build chunked framing with multiple chunks (realistic server behavior)
    let mut chunked_body = Vec::new();
    for chunk in [chunk1.as_slice(), chunk2.as_slice(), chunk3.as_slice()] {
        chunked_body.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
        chunked_body.extend_from_slice(chunk);
        chunked_body.extend_from_slice(b"\r\n");
    }
    chunked_body.extend_from_slice(b"0\r\n\r\n");

    // Build full HTTP response with chunked TE header
    let mut raw = Vec::new();
    raw.extend_from_slice(
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
    );
    raw.extend_from_slice(&chunked_body);

    // Without prepare_response_body, SSE parsing sees hex chunk-size lines
    // between events, which corrupts data: lines (the hex line gets concatenated
    // with the next event line in the line buffer).
    let body_without_dechunk = stream::strip_http_headers(&raw);
    let _broken = stream::parse_sse_stream(body_without_dechunk);

    // With prepare_response_body (which detects chunked TE and decodes it)
    let dechunked = stream::prepare_response_body(&raw);
    let correct = stream::parse_sse_stream(&dechunked);

    // The correct (dechunked) parse must work perfectly.
    assert!(
        correct.complete,
        "Dechunked SSE stream must be complete (message_stop found)"
    );
    assert_eq!(
        correct.events.len(),
        3,
        "Dechunked SSE stream must have 3 events, got {}",
        correct.events.len()
    );
    assert_eq!(correct.events[0].event_type, "message_start");
    assert_eq!(correct.events[1].event_type, "message_delta");
    assert_eq!(correct.events[2].event_type, "message_stop");

    // Verify the broken parse is actually broken by checking the raw data line.
    // With multi-chunk framing, the hex size lines (e.g., "5a") appear between
    // SSE events and are not valid SSE. The SSE parser ignores them, but if
    // a chunk boundary falls mid-line, data gets corrupted. At minimum, the
    // raw_bytes differ because they include the hex framing.
    assert_ne!(
        body_without_dechunk.len(),
        dechunked.len(),
        "Raw chunked body must be larger than dechunked body (contains hex framing). \
         Raw: {} bytes, dechunked: {} bytes",
        body_without_dechunk.len(),
        dechunked.len(),
    );

    // Verify the model was correctly parsed from the dechunked stream
    let parsed = anthropic::parse_response(&correct.events)
        .expect("parse_response must succeed on dechunked events");
    assert_eq!(parsed.model, "claude-opus-4-6-20250219");
    assert_eq!(parsed.input_tokens, 100);
    assert_eq!(parsed.output_tokens, 5);
    assert_eq!(parsed.stop_reason, "end_turn");
}

/// The bare \\n\\n boundary fallback works for non-CRLF HTTP responses.
#[test]
fn bare_lf_header_boundary_stripped() {
    // Some HTTP implementations use bare \n instead of \r\n
    let raw = b"HTTP/1.1 200 OK\nContent-Type: text/event-stream\n\nevent: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_lf\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-opus-4-6-20250219\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":50,\"output_tokens\":0}}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";

    let stripped = stream::strip_http_headers(raw);
    assert!(
        !stripped.starts_with(b"HTTP/"),
        "Bare LF boundary must be detected and headers stripped"
    );
    assert!(
        stripped.starts_with(b"event:"),
        "After stripping bare LF headers, body must start with SSE events. Got: {:?}",
        String::from_utf8_lossy(&stripped[..std::cmp::min(50, stripped.len())])
    );

    let accumulated = stream::parse_sse_stream(stripped);
    assert!(
        accumulated.complete,
        "SSE stream after bare LF header strip must be complete"
    );
    assert_eq!(
        accumulated.events.len(),
        2,
        "Must have 2 events after bare LF header strip"
    );
}

/// extract_headers returns the HTTP header portion correctly.
#[test]
fn extract_headers_returns_header_text() {
    let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/event-stream\r\n\r\nbody here";
    let headers = stream::extract_headers(raw);
    assert!(headers.is_some(), "extract_headers must find headers");
    let h = headers.unwrap();
    assert!(
        h.contains("Transfer-Encoding: chunked"),
        "Headers must contain Transfer-Encoding. Got: {:?}",
        h
    );
    assert!(
        !h.contains("body here"),
        "Headers must not contain body content"
    );
}

/// is_chunked_transfer_encoding detects the header correctly.
#[test]
fn is_chunked_transfer_encoding_detection() {
    assert!(stream::is_chunked_transfer_encoding(
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/event-stream"
    ));
    assert!(stream::is_chunked_transfer_encoding(
        "Transfer-Encoding: gzip, chunked"
    ));
    assert!(!stream::is_chunked_transfer_encoding(
        "Content-Type: text/event-stream"
    ));
    assert!(!stream::is_chunked_transfer_encoding(
        "Transfer-Encoding: gzip"
    ));
}

/// decode_chunked correctly strips chunked framing.
#[test]
fn decode_chunked_strips_framing() {
    let chunked = b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
    let decoded = stream::decode_chunked(chunked).expect("decode must succeed");
    assert_eq!(
        String::from_utf8_lossy(&decoded),
        "hello world",
        "Decoded chunked body must be 'hello world'"
    );
}

/// decode_chunked returns error for non-hex first line.
#[test]
fn decode_chunked_rejects_non_hex() {
    let not_chunked = b"event: message_start\r\ndata: test\r\n\r\n";
    let result = stream::decode_chunked(not_chunked);
    assert!(
        result.is_err(),
        "decode_chunked must reject non-chunked data"
    );
}

// =============================================================================
// Section 7: Cache Token Accounting Tests (5 tests)
//
// These tests verify that cache tokens (cache_read_input_tokens and
// cache_creation_input_tokens) are included in total token counts, cost
// calculations, and display/aggregation paths.
//
// Per Anthropic's API, the token fields are disjoint:
//   input_tokens: non-cached input tokens
//   cache_creation_input_tokens: tokens written to cache this request
//   cache_read_input_tokens: tokens read from cache this request
//   output_tokens: output tokens
//
// Total tokens = input + output + cache_creation + cache_read.
//
// compute_cost_usd takes 5 arguments:
//   (model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens)
//
// Cache pricing (Anthropic only):
//   - Standard input: 1x rate
//   - Cache creation: 1.25x rate
//   - Cache read: 0.1x rate
// =============================================================================

/// Realistic SSE response bytes with prompt caching tokens.
/// This simulates what the gateway captures when Anthropic returns cache tokens:
///   input_tokens: 3 (only the non-cached portion)
///   cache_creation_input_tokens: 14631
///   cache_read_input_tokens: 0
///   output_tokens: 375
fn response_bytes_with_cache_tokens() -> Vec<u8> {
    b"HTTP/1.1 200 OK\r\n\
Content-Type: text/event-stream\r\n\
\r\n\
event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_cache_test\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-20250514\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":3,\"cache_creation_input_tokens\":14631,\"cache_read_input_tokens\":0,\"output_tokens\":0}}}\n\
\n\
event: content_block_start\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\
\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Here is my cached response.\"}}\n\
\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":375}}\n\
\n\
event: message_stop\n\
data: {\"type\":\"message_stop\"}\n\
\n"
        .to_vec()
}

/// Request bytes for the cache token tests.
fn request_bytes_cache_test() -> Vec<u8> {
    b"POST /v1/messages HTTP/1.1\r\n\
Content-Type: application/json\r\n\
x-api-key: sk-ant-test\r\n\
\r\n\
{\"model\":\"claude-sonnet-4-20250514\",\"max_tokens\":8096,\"messages\":[{\"role\":\"user\",\"content\":\"Summarize the codebase.\"}],\"system\":\"You are a helpful assistant.\",\"stream\":true}"
        .to_vec()
}

/// Test 1: Session total_tokens must include cache tokens.
///
/// When a turn has input_tokens=3, output_tokens=375, cache_creation_tokens=14631,
/// the session's total_tokens must be 3 + 375 + 14631 = 15009, NOT 378.
#[test]
fn session_total_tokens_includes_cache_tokens() {
    let (pipeline, _tmp) = create_test_pipeline();
    let mut session_mgr = SessionManager::new();

    let req_bytes = request_bytes_cache_test();
    let resp_bytes = response_bytes_with_cache_tokens();

    let turn = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes,
        &resp_bytes,
        None,
        None, // no metrics registry
    )
    .expect("process_capture_with_pipeline must succeed");

    // Verify the turn itself captured all 4 token fields correctly
    assert_eq!(turn.input_tokens, 3, "input_tokens must be 3");
    assert_eq!(turn.output_tokens, 375, "output_tokens must be 375");
    assert_eq!(
        turn.cache_creation_tokens, 14631,
        "cache_creation_tokens must be 14631"
    );
    assert_eq!(turn.cache_read_tokens, 0, "cache_read_tokens must be 0");

    // Now check the session's total_tokens
    let sessions = pipeline
        .graph()
        .list_sessions(None)
        .expect("list_sessions must succeed");
    assert_eq!(sessions.len(), 1);

    let session = &sessions[0];

    // The correct total is input + output + cache_creation + cache_read
    // = 3 + 375 + 14631 + 0 = 15009
    let expected_total: i64 = 3 + 375 + 14631;
    assert_eq!(
        session.total_tokens, expected_total,
        "Session total_tokens must include cache tokens. \
         Expected {} (3 input + 375 output + 14631 cache_creation + 0 cache_read), \
         got {} (likely just input + output = 378). \
         The bug is in process_capture_with_pipeline where total_tokens \
         is computed as parsed.input_tokens + parsed.output_tokens, \
         ignoring cache_read_tokens and cache_creation_tokens.",
        expected_total, session.total_tokens
    );
}

/// Test 2: Turn display must report total input including cache tokens.
///
/// A turn with input_tokens=3 and cache_creation_tokens=14631 should report
/// a total input count of 14634 (3 + 14631 + 0), not just 3. The turn record
/// must provide a way to compute the total input that includes cache tokens.
///
/// This test verifies via get_turn that the individual fields are stored AND
/// that the total can be computed correctly from them.
#[test]
fn turn_display_shows_total_input_including_cache() {
    let (pipeline, _tmp) = create_test_pipeline();
    let mut session_mgr = SessionManager::new();

    let req_bytes = request_bytes_cache_test();
    let resp_bytes = response_bytes_with_cache_tokens();

    let turn = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes,
        &resp_bytes,
        None,
        None, // no metrics registry
    )
    .expect("process_capture_with_pipeline must succeed");

    // Retrieve the turn from the graph store (simulating CLI query)
    let retrieved = pipeline
        .graph()
        .get_turn(&turn.id)
        .expect("get_turn must succeed")
        .expect("Turn must exist");

    // Verify all 4 token fields are stored correctly
    assert_eq!(retrieved.input_tokens, 3);
    assert_eq!(retrieved.output_tokens, 375);
    assert_eq!(retrieved.cache_creation_tokens, 14631);
    assert_eq!(retrieved.cache_read_tokens, 0);

    // The "total input" for display purposes should be:
    // input_tokens + cache_read_tokens + cache_creation_tokens = 3 + 0 + 14631 = 14634
    let total_input =
        retrieved.input_tokens + retrieved.cache_read_tokens + retrieved.cache_creation_tokens;
    assert_eq!(
        total_input, 14634,
        "Total input tokens (input + cache_read + cache_creation) must be 14634, got {}",
        total_input
    );

    // The session's total_tokens must reflect this total input, not just input_tokens
    let sessions = pipeline
        .graph()
        .list_sessions(None)
        .expect("list_sessions must succeed");
    let session = &sessions[0];

    // session.total_tokens should be total_input + output_tokens = 14634 + 375 = 15009
    assert_eq!(
        session.total_tokens,
        total_input + retrieved.output_tokens,
        "Session total_tokens must equal total_input ({}) + output_tokens ({}) = {}, \
         but got {}. The display would show 'Tokens: 3 in / 375 out' instead of \
         'Tokens: 14634 in / 375 out'.",
        total_input,
        retrieved.output_tokens,
        total_input + retrieved.output_tokens,
        session.total_tokens
    );
}

/// Test 3: Cost calculation must account for cache token pricing.
///
/// compute_cost_usd accepts 5 arguments:
///   (model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens)
///
/// Anthropic charges different rates for cached vs non-cached input tokens:
/// - Standard input: 1x the input token price
/// - Cache creation: 1.25x the input token price
/// - Cache read: 0.1x the input token price
///
/// With input_tokens=3, cache_creation_tokens=14631, cache_read_tokens=0,
/// output_tokens=375 on Sonnet 4 ($3/$15 per MTok), the cost with cache
/// tokens must be significantly higher than without them.
#[test]
fn cost_calculation_accounts_for_cache_tokens() {
    let model = "claude-sonnet-4-20250514";
    let input_tokens: i64 = 3;
    let output_tokens: i64 = 375;
    let cache_creation_tokens: i64 = 14631;
    let cache_read_tokens: i64 = 0;

    // Cost WITHOUT cache tokens (zero cache_creation, zero cache_read)
    let cost_no_cache = db::compute_cost_usd(
        db::model_pricing::canonical(),
        model,
        input_tokens,
        output_tokens,
        0,
        0,
        &time::OffsetDateTime::now_utc(),
    );

    // Cost WITH cache tokens (non-zero cache_creation)
    let cost_with_cache = db::compute_cost_usd(
        db::model_pricing::canonical(),
        model,
        input_tokens,
        output_tokens,
        cache_creation_tokens,
        cache_read_tokens,
        &time::OffsetDateTime::now_utc(),
    );

    // The cost with cache tokens must be significantly higher than without.
    // Without cache: input_cost = 3 * 3.0/1M = 0.000009, output = 375 * 15.0/1M = 0.005625
    // Total no cache ~ $0.005634
    //
    // With cache: same + cache_creation_cost = 14631 * 3.75/1M = 0.054866
    // Total with cache ~ $0.060500
    //
    // The cache cost adds roughly 10x more.
    assert!(
        cost_with_cache > cost_no_cache * 5.0,
        "Cost with cache tokens (${:.6}) must be significantly higher (>5x) \
         than cost without (${:.6}). cache_creation_tokens={}, cache_read_tokens={}.",
        cost_with_cache,
        cost_no_cache,
        cache_creation_tokens,
        cache_read_tokens,
    );

    // Verify exact expected values for Sonnet 4 pricing:
    // Standard input: 3 * 3.0/1M = 0.000009
    // Cache creation: 14631 * 3.75/1M = 0.054866...
    // Cache read: 0
    // Output: 375 * 15.0/1M = 0.005625
    let expected_input = 3.0 * 3.0 / 1_000_000.0;
    let expected_cache_creation = 14631.0 * (3.0 * 1.25) / 1_000_000.0;
    let expected_output = 375.0 * 15.0 / 1_000_000.0;
    let expected_total = expected_input + expected_cache_creation + expected_output;

    assert!(
        (cost_with_cache - expected_total).abs() < 0.000001,
        "Cost must match expected calculation. Expected: ${:.6}, got: ${:.6}",
        expected_total,
        cost_with_cache,
    );
}

/// Test 4: get_stats().total_tokens must include cache tokens across all sessions.
///
/// When multiple sessions have turns with cache tokens, the aggregate
/// total_tokens from get_stats must include all cache tokens.
///
/// get_stats reads total_tokens from the sessions table, which includes
/// all 4 token types (input + output + cache_creation + cache_read).
#[test]
fn stats_total_tokens_includes_cache() {
    let tmp = TempDir::new().expect("Must create temp dir");
    let data_dir = tmp.path().to_path_buf();
    let db_path = data_dir.join("recondo.db");
    let dlq_dir = data_dir.join("dlq");

    let pool = recondo_gateway::storage::pool::ConnectionPool::sqlite(&db_path)
        .expect("Must create sqlite pool");
    let graph = pool.graph_store();
    let objects = LocalObjectStore::new(&data_dir);

    let pipeline = WritePipeline::new(graph, Box::new(objects), dlq_dir);
    let mut session_mgr = SessionManager::new();

    // Push a capture with cache tokens
    let req_bytes = request_bytes_cache_test();
    let resp_bytes = response_bytes_with_cache_tokens();

    recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes,
        &resp_bytes,
        None,
        None, // no metrics registry
    )
    .expect("process_capture_with_pipeline must succeed");

    // Query stats (simulating CLI `recondo stats` command)
    let conn = db::open(&db_path).expect("Must open DB for stats query");
    let stats = db::get_stats(&conn).expect("get_stats must succeed");

    // Expected total: input(3) + output(375) + cache_creation(14631) + cache_read(0) = 15009
    let expected_total: i64 = 3 + 375 + 14631;

    // stats.total_tokens comes from SUM(sessions.total_tokens), which now
    // correctly includes all 4 token types.
    assert_eq!(
        stats.total_tokens, expected_total,
        "get_stats().total_tokens must include cache tokens. \
         Expected {} (3 input + 375 output + 14631 cache_creation + 0 cache_read), \
         got {} (likely just input + output = 378). \
         The bug cascades from session.total_tokens being set incorrectly.",
        expected_total, stats.total_tokens
    );
}

/// Test 5: SSE response with cache tokens parsed correctly.
///
/// Create realistic SSE data with cache tokens in the usage block, parse it,
/// and verify all 4 token fields are extracted. This test verifies the parser
/// works correctly (it does) — the bug is in aggregation, not parsing.
#[test]
fn sse_response_with_cache_tokens_parsed_correctly() {
    let raw = response_bytes_with_cache_tokens();

    // Strip HTTP headers and parse SSE
    let sse_bytes = stream::strip_http_headers(&raw);
    let accumulated = stream::parse_sse_stream(sse_bytes);
    let parsed = anthropic::parse_response(&accumulated.events)
        .expect("parse_response must succeed on cache token SSE data");

    // All 4 token fields must be extracted correctly
    assert_eq!(
        parsed.input_tokens, 3,
        "input_tokens must be 3 (non-cached portion), got {}",
        parsed.input_tokens
    );
    assert_eq!(
        parsed.cache_creation_tokens, 14631,
        "cache_creation_tokens must be 14631, got {}. \
         If 0, the parser is not extracting cache_creation_input_tokens from usage.",
        parsed.cache_creation_tokens
    );
    assert_eq!(
        parsed.cache_read_tokens, 0,
        "cache_read_tokens must be 0, got {}",
        parsed.cache_read_tokens
    );
    assert_eq!(
        parsed.output_tokens, 375,
        "output_tokens must be 375, got {}",
        parsed.output_tokens
    );
    assert_eq!(
        parsed.model, "claude-sonnet-4-20250514",
        "model must be claude-sonnet-4-20250514, got {}",
        parsed.model
    );
    assert_eq!(
        parsed.stop_reason, "end_turn",
        "stop_reason must be end_turn, got {}",
        parsed.stop_reason
    );

    // Verify the total input calculation that *should* be used for aggregation
    let total_input = parsed.input_tokens + parsed.cache_read_tokens + parsed.cache_creation_tokens;
    assert_eq!(
        total_input, 14634,
        "Total input (input + cache_read + cache_creation) must be 14634, got {}. \
         The parser extracts all fields correctly; the bug is in how these fields \
         are aggregated into session.total_tokens and cost calculations.",
        total_input
    );

    // Now push this through the full pipeline and verify the session total
    // correctly includes cache tokens.
    let (pipeline, _tmp) = create_test_pipeline();
    let mut session_mgr = SessionManager::new();

    let req_bytes = request_bytes_cache_test();

    let turn = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes,
        &raw,
        None,
        None, // no metrics registry
    )
    .expect("process_capture_with_pipeline must succeed");

    // The turn record stores all 4 fields correctly
    assert_eq!(turn.input_tokens, 3);
    assert_eq!(turn.output_tokens, 375);
    assert_eq!(turn.cache_creation_tokens, 14631);
    assert_eq!(turn.cache_read_tokens, 0);

    // Verify the session total counts all 4 token types
    let sessions = pipeline
        .graph()
        .list_sessions(None)
        .expect("list_sessions must succeed");
    let session = &sessions[0];

    // This assertion FAILS because session.total_tokens = 3 + 375 = 378
    // instead of 3 + 375 + 14631 + 0 = 15009
    assert_eq!(
        session.total_tokens,
        (turn.input_tokens
            + turn.output_tokens
            + turn.cache_creation_tokens
            + turn.cache_read_tokens),
        "Session total_tokens must equal sum of all token types from the turn. \
         Turn has: input={}, output={}, cache_creation={}, cache_read={}. \
         Expected total={}, got={}.",
        turn.input_tokens,
        turn.output_tokens,
        turn.cache_creation_tokens,
        turn.cache_read_tokens,
        turn.input_tokens
            + turn.output_tokens
            + turn.cache_creation_tokens
            + turn.cache_read_tokens,
        session.total_tokens
    );
}

// =============================================================================
// Section 8: Cache Token Pricing Unit Tests (N2)
//
// Dedicated unit tests for compute_cost_usd with non-zero cache tokens,
// verifying exact expected values.
// =============================================================================

/// N2: compute_cost_usd with non-zero cache_creation_tokens returns the
/// correct cost using Anthropic's tiered pricing (1.25x for creation).
#[test]
fn compute_cost_usd_cache_creation_pricing() {
    // Sonnet 4: input=$3/MTok, output=$15/MTok
    // Cache creation: 1.25x input = $3.75/MTok
    let cost = db::compute_cost_usd(
        db::model_pricing::canonical(),
        "claude-sonnet-4-20250514",
        1000,
        500,
        2000,
        0,
        &time::OffsetDateTime::now_utc(),
    );

    // Expected:
    // input: 1000 * 3.0 / 1M = 0.003000
    // cache_creation: 2000 * 3.75 / 1M = 0.007500
    // output: 500 * 15.0 / 1M = 0.007500
    // total = 0.018000
    let expected = 0.003000 + 0.007500 + 0.007500;
    assert!(
        (cost - expected).abs() < 0.000001,
        "Cache creation pricing: expected ${:.6}, got ${:.6}",
        expected,
        cost
    );
}

/// N2: compute_cost_usd with non-zero cache_read_tokens returns the
/// correct cost using Anthropic's tiered pricing (0.1x for reads).
#[test]
fn compute_cost_usd_cache_read_pricing() {
    // Sonnet 4: input=$3/MTok, output=$15/MTok
    // Cache read: 0.1x input = $0.30/MTok
    let cost = db::compute_cost_usd(
        db::model_pricing::canonical(),
        "claude-sonnet-4-20250514",
        1000,
        500,
        0,
        5000,
        &time::OffsetDateTime::now_utc(),
    );

    // Expected:
    // input: 1000 * 3.0 / 1M = 0.003000
    // cache_read: 5000 * 0.30 / 1M = 0.001500
    // output: 500 * 15.0 / 1M = 0.007500
    // total = 0.012000
    let expected = 0.003000 + 0.001500 + 0.007500;
    assert!(
        (cost - expected).abs() < 0.000001,
        "Cache read pricing: expected ${:.6}, got ${:.6}",
        expected,
        cost
    );
}

/// N2: compute_cost_usd with both cache_creation and cache_read non-zero.
#[test]
fn compute_cost_usd_both_cache_types() {
    // Opus 4.5: input=$5/MTok, output=$25/MTok (H1 fix)
    // Cache creation: 1.25x = $6.25/MTok
    // Cache read: 0.1x = $0.50/MTok
    let cost = db::compute_cost_usd(
        db::model_pricing::canonical(),
        "claude-opus-4-5-20250514",
        100,
        200,
        3000,
        4000,
        &time::OffsetDateTime::now_utc(),
    );

    // Expected:
    // input: 100 * 5.0 / 1M = 0.000500
    // cache_creation: 3000 * 6.25 / 1M = 0.018750
    // cache_read: 4000 * 0.50 / 1M = 0.002000
    // output: 200 * 25.0 / 1M = 0.005000
    // total = 0.026250
    let expected = 0.000500 + 0.018750 + 0.002000 + 0.005000;
    assert!(
        (cost - expected).abs() < 0.000001,
        "Both cache types pricing: expected ${:.6}, got ${:.6}",
        expected,
        cost
    );
}

/// H1: Opus 4.5 and 4.6 should use $5/$25 pricing, not $15/$75.
#[test]
fn compute_cost_usd_opus_4_5_and_4_6_pricing() {
    // Opus 4.6 at $5/$25
    let cost_46 = db::compute_cost_usd(
        db::model_pricing::canonical(),
        "claude-opus-4-6-20250219",
        1_000_000,
        1_000_000,
        0,
        0,
        &time::OffsetDateTime::now_utc(),
    );
    let expected_46 = 5.0 + 25.0; // $5 input + $25 output per MTok
    assert!(
        (cost_46 - expected_46).abs() < 0.01,
        "Opus 4.6: expected ${:.2}, got ${:.2}",
        expected_46,
        cost_46
    );

    // Opus 4.5 at $5/$25
    let cost_45 = db::compute_cost_usd(
        db::model_pricing::canonical(),
        "claude-opus-4-5-20250514",
        1_000_000,
        1_000_000,
        0,
        0,
        &time::OffsetDateTime::now_utc(),
    );
    let expected_45 = 5.0 + 25.0;
    assert!(
        (cost_45 - expected_45).abs() < 0.01,
        "Opus 4.5: expected ${:.2}, got ${:.2}",
        expected_45,
        cost_45
    );

    // Opus 4 base at $15/$75 (should NOT match the cheaper rate)
    let cost_4 = db::compute_cost_usd(
        db::model_pricing::canonical(),
        "claude-opus-4-20250514",
        1_000_000,
        1_000_000,
        0,
        0,
        &time::OffsetDateTime::now_utc(),
    );
    let expected_4 = 15.0 + 75.0;
    assert!(
        (cost_4 - expected_4).abs() < 0.01,
        "Opus 4 base: expected ${:.2}, got ${:.2}",
        expected_4,
        cost_4
    );
}

/// M1: Haiku 4.x should use $1/$5 pricing, not $0.80/$4.
#[test]
fn compute_cost_usd_haiku_4_pricing() {
    // Haiku 4 at $1/$5
    let cost_h4 = db::compute_cost_usd(
        db::model_pricing::canonical(),
        "claude-haiku-4-20250514",
        1_000_000,
        1_000_000,
        0,
        0,
        &time::OffsetDateTime::now_utc(),
    );
    let expected_h4 = 1.0 + 5.0;
    assert!(
        (cost_h4 - expected_h4).abs() < 0.01,
        "Haiku 4: expected ${:.2}, got ${:.2}",
        expected_h4,
        cost_h4
    );

    // Haiku 3.5 at $0.80/$4 (should still use old pricing)
    let cost_h35 = db::compute_cost_usd(
        db::model_pricing::canonical(),
        "claude-3-5-haiku-20250514",
        1_000_000,
        1_000_000,
        0,
        0,
        &time::OffsetDateTime::now_utc(),
    );
    let expected_h35 = 0.80 + 4.0;
    assert!(
        (cost_h35 - expected_h35).abs() < 0.01,
        "Haiku 3.5: expected ${:.2}, got ${:.2}",
        expected_h35,
        cost_h35
    );
}

// =============================================================================
// Section 9: User Message Extraction from messages_delta (5 tests)
//
// These tests verify extract_last_user_message, which parses the JSON
// messages_delta string from a TurnRecord and returns the text content of
// the last user message. This function is used by the CLI `recondo session <id>`
// and `recondo turn <id>` displays to show the user's message alongside the
// assistant's response.
//
// The function does NOT exist yet in recondo_gateway::session. These tests
// imports extract_last_user_message from session module.
// =============================================================================

use recondo_gateway::session::extract_last_user_message;

/// Simple delta with a single user message. Must return its content.
#[test]
fn extract_last_user_message_from_simple_delta() {
    let delta = r#"[{"role":"user","content":"Hello"}]"#;
    let result = extract_last_user_message(delta);
    assert_eq!(
        result,
        Some("Hello".to_string()),
        "Single user message delta must return 'Hello', got {:?}",
        result
    );
}

/// Delta with an assistant reply followed by a user message.
/// Must return the LAST user message ("What is 2+2?"), not the assistant's.
#[test]
fn extract_last_user_message_from_multi_message_delta() {
    let delta = r#"[{"role":"assistant","content":"Hi"},{"role":"user","content":"What is 2+2?"}]"#;
    let result = extract_last_user_message(delta);
    assert_eq!(
        result,
        Some("What is 2+2?".to_string()),
        "Multi-message delta must return the last user message, got {:?}",
        result
    );
}

/// Delta containing a user message that starts with `<available-deferred-tools>`.
/// This is preamble injected by Claude Code and should be skipped. The function
/// should find the next user message that does NOT start with that tag, or
/// truncate/skip the preamble content.
#[test]
fn extract_last_user_message_skips_preamble() {
    let delta = r#"[{"role":"user","content":"<available-deferred-tools>\nBash\nRead\n</available-deferred-tools>\n\nPlease fix the bug in auth.ts"},{"role":"assistant","content":"Sure"},{"role":"user","content":"Now add tests"}]"#;
    let result = extract_last_user_message(delta);
    assert_eq!(
        result,
        Some("Now add tests".to_string()),
        "Must skip preamble user message and return last real user message, got {:?}",
        result
    );
}

/// Content is an array of content blocks (e.g., [{"type":"text","text":"Hello"}]).
/// Must extract the text from the first text block.
#[test]
fn extract_last_user_message_handles_array_content() {
    let delta = r#"[{"role":"user","content":[{"type":"text","text":"Hello"}]}]"#;
    let result = extract_last_user_message(delta);
    assert_eq!(
        result,
        Some("Hello".to_string()),
        "Array content must extract text from text block, got {:?}",
        result
    );
}

/// W1: Messages longer than 500 chars are truncated to 500 chars + "..." (503 total).
#[test]
fn extract_last_user_message_truncates_at_500_chars() {
    // Build a 600-char message (all ASCII 'x')
    let long_msg: String = "x".repeat(600);
    let delta = format!(r#"[{{"role":"user","content":"{}"}}]"#, long_msg);
    let result = extract_last_user_message(&delta);
    assert!(result.is_some(), "600-char message must return Some");
    let text = result.unwrap();
    assert_eq!(
        text.chars().count(),
        503,
        "Truncated message must be 500 chars + '...' = 503 chars, got {}",
        text.chars().count()
    );
    assert!(
        text.ends_with("..."),
        "Truncated message must end with '...', got: {:?}",
        &text[text.len() - 10..]
    );
    // First 500 chars should be all 'x'
    assert!(
        text[..500].chars().all(|c| c == 'x'),
        "First 500 chars must be preserved"
    );
}

/// Empty or invalid delta returns None, no crash.
#[test]
fn extract_last_user_message_empty_delta_returns_none() {
    assert_eq!(extract_last_user_message(""), None);
    assert_eq!(extract_last_user_message("null"), None);
    assert_eq!(extract_last_user_message("[]"), None);
    assert_eq!(extract_last_user_message("not json at all"), None);
}

/// Sprint 3 update: OpenAI models now price cache_read_tokens at 50% of input rate.
// cache_creation_tokens remain ignored for OpenAI (they don't have that concept).
// This test verifies that cache_read_tokens produce non-zero cost for OpenAI models,
// while cache_creation_tokens are still ignored.
#[test]
fn compute_cost_usd_non_anthropic_cache_read_priced_at_50_percent() {
    // GPT-4o with cache tokens: cache_read at 50% of input rate ($2.50 * 0.5 = $1.25/M)
    // cache_creation is ignored for OpenAI.
    let cost_with_cache = db::compute_cost_usd(
        db::model_pricing::canonical(),
        "gpt-4o-2024-05-13",
        1000,
        500,
        5000,
        3000,
        &time::OffsetDateTime::now_utc(),
    );
    let cost_without_cache = db::compute_cost_usd(
        db::model_pricing::canonical(),
        "gpt-4o-2024-05-13",
        1000,
        500,
        0,
        0,
        &time::OffsetDateTime::now_utc(),
    );

    // cache_read: 3000 * (2.50 * 0.5) / 1_000_000 = $0.00375
    let expected_diff = 3000.0 * (2.50 * 0.5) / 1_000_000.0;
    let actual_diff = cost_with_cache - cost_without_cache;

    assert!(
        (actual_diff - expected_diff).abs() < 1e-10,
        "OpenAI cache_read tokens must be priced at 50% of input rate. \
         Expected diff: ${:.10}, actual diff: ${:.10}",
        expected_diff,
        actual_diff
    );
}

// =============================================================================
// Section 10: Multi-Block Content Array — User Message Extraction Bug (5 tests)
//
// Claude Code sends user messages with content as an ARRAY of text blocks:
//   {"role":"user","content":[
//     {"type":"text","text":"<system-reminder>\nThe following skills..."},
//     {"type":"text","text":"<system-reminder>\nAs you answer...claudeMd..."},
//     {"type":"text","text":"hi this is session 1"}
//   ]}
//
// The user's actual typed message is the LAST text block that doesn't start
// with a system preamble marker (<system-reminder>, <available-deferred-tools>,
// <task-notification>). But `extract_content_text` currently returns the FIRST
// text block, which is always the system-injected preamble.
//
// These tests call `session::extract_last_user_message` and MUST FAIL on the
// current code.
// =============================================================================

/// Test 1: Content array has 3 text blocks — two <system-reminder> preambles
/// and "hi this is session 1". Must return "hi this is session 1", NOT the preamble.
///
/// Verifies extract_content_text returns the LAST non-preamble text
/// block (the <system-reminder> preamble), and that preamble is not filtered
/// out by extract_last_user_message (which only filters <available-deferred-tools>).
#[test]
fn extract_user_message_from_multi_block_content() {
    let delta = r#"[{"role":"user","content":[
        {"type":"text","text":"<system-reminder>\nThe following skills are available..."},
        {"type":"text","text":"<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# claudeMd\nContents of CLAUDE.md..."},
        {"type":"text","text":"hi this is session 1"}
    ]}]"#;

    let result = extract_last_user_message(delta);

    assert_eq!(
        result,
        Some("hi this is session 1".to_string()),
        "Must return the user's actual message ('hi this is session 1'), \
         not a <system-reminder> preamble. Got: {:?}. \
         The bug is in extract_content_text which returns the FIRST text block \
         (the preamble) instead of the LAST non-preamble text block.",
        result
    );
}

/// Test 2: Content array has all three preamble types plus the real message.
/// <available-deferred-tools>, <system-reminder>, <task-notification>, then "ABRACADABRA".
/// Must return "ABRACADABRA".
///
/// Verifies extract_content_text returns the LAST non-preamble text
/// block (<available-deferred-tools>). Even though extract_last_user_message
/// filters <available-deferred-tools> at the message level, it does NOT filter
/// at the content-block level inside the array — and for <system-reminder> and
/// <task-notification>, it has no filter at all.
#[test]
fn extract_user_message_skips_all_preamble_types() {
    let delta = r#"[{"role":"user","content":[
        {"type":"text","text":"<available-deferred-tools>\nBash\nRead\nGrep\n</available-deferred-tools>"},
        {"type":"text","text":"<system-reminder>\nAs you answer the user's questions..."},
        {"type":"text","text":"<task-notification>\nYou have 3 pending tasks..."},
        {"type":"text","text":"ABRACADABRA"}
    ]}]"#;

    let result = extract_last_user_message(delta);

    assert_eq!(
        result,
        Some("ABRACADABRA".to_string()),
        "Must return 'ABRACADABRA' — the only text block that is not a system \
         preamble. Got: {:?}. The function must skip all three preamble markers: \
         <system-reminder>, <available-deferred-tools>, <task-notification>.",
        result
    );
}

/// Test 3: Content array has ONLY preamble blocks, no real user message.
/// Must return None.
///
/// Verifies extract_content_text returns the last non-preamble text
/// <system-reminder> block, which is not filtered by extract_last_user_message
/// (only <available-deferred-tools> is filtered), so it incorrectly returns
/// the preamble text as if it were the user's message.
#[test]
fn extract_user_message_only_preamble_returns_none() {
    let delta = r#"[{"role":"user","content":[
        {"type":"text","text":"<system-reminder>\nYou are Claude Code, Anthropic's official CLI..."},
        {"type":"text","text":"<system-reminder>\nAs you answer the user's questions, context:\n# claudeMd\nContents of CLAUDE.md..."}
    ]}]"#;

    let result = extract_last_user_message(delta);

    assert_eq!(
        result, None,
        "When ALL content blocks are system preamble, must return None. \
         Got: {:?}. The function must recognize <system-reminder> as preamble \
         and filter it out, not just <available-deferred-tools>.",
        result
    );
}

/// Test 4: Content array has preamble, then "my actual question", then another
/// preamble block. Must return "my actual question" (the LAST non-preamble).
///
/// Verifies extract_content_text returns the LAST non-preamble text
/// block (the <system-reminder> preamble), ignoring the real message entirely.
#[test]
fn extract_user_message_real_message_in_middle() {
    let delta = r#"[{"role":"user","content":[
        {"type":"text","text":"<system-reminder>\nYou are Claude Code..."},
        {"type":"text","text":"my actual question"},
        {"type":"text","text":"<system-reminder>\nAs you answer the user's questions..."}
    ]}]"#;

    let result = extract_last_user_message(delta);

    assert_eq!(
        result,
        Some("my actual question".to_string()),
        "Must return the last non-preamble text block ('my actual question'), \
         not a preamble. Got: {:?}. When preamble appears after the real message, \
         the function must still find the last non-preamble block.",
        result
    );
}

/// Test 5: Content is a plain string "hello", not an array.
/// Must return "hello" (backward-compatible with simple content format).
///
/// This test verifies the plain-string path still works. It PASSES on the
/// current code (the bug only manifests with array content), included for
/// completeness to ensure the fix doesn't break the simple case.
#[test]
fn extract_user_message_string_content_not_array() {
    let delta = r#"[{"role":"user","content":"hello"}]"#;

    let result = extract_last_user_message(delta);

    assert_eq!(
        result,
        Some("hello".to_string()),
        "Plain string content must return 'hello'. Got: {:?}. \
         This is the simple case — content is a string, not an array.",
        result
    );
}
