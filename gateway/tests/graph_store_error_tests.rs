//! Behavioral tests for `GraphStoreError` typed error enum.
//!
//! These tests WILL NOT COMPILE until `GraphStoreError` and `GraphStoreResult`
//! are implemented in `recondo_gateway::storage::graph`. They define the
//! behavioral contract that the implementation must satisfy:
//!
//! 1. `GraphStoreError::DuplicateKey` is returned on duplicate writes (not an
//!    anyhow string).
//! 2. Callers can pattern-match on variants without string matching.
//! 3. SQLite (and PostgreSQL) implementations map native constraint errors to
//!    the typed enum.
//! 4. Zero `msg.contains("immutability")` or `msg.contains("UNIQUE constraint")`
//!    needed anywhere for duplicate detection.

use recondo_gateway::db::{SessionRecord, ToolCallRecord, TurnRecord};
use recondo_gateway::storage::graph::{
    GraphStore, GraphStoreError, GraphStoreResult, SqliteGraphStore,
};
use recondo_gateway::storage::object::LocalObjectStore;
use recondo_gateway::storage::pipeline::WritePipeline;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

fn sample_session(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.to_string(),
        provider: "anthropic".to_string(),
        model: Some("claude-sonnet-4-20250514".to_string()),
        started_at: "2026-03-19T10:00:00Z".to_string(),
        last_active_at: "2026-03-19T10:05:00Z".to_string(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash: "abc123".to_string(),
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

fn sample_turn(id: &str, session_id: &str, seq: i64) -> TurnRecord {
    TurnRecord {
        id: id.to_string(),
        session_id: session_id.to_string(),
        sequence_num: seq,
        timestamp: format!("2026-03-19T10:{:02}:00Z", seq),
        request_hash: format!("req_hash_{}", seq),
        response_hash: format!("resp_hash_{}", seq),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some("claude-sonnet-4-20250514".to_string()),
        response_text: None,
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 100 * seq,
        output_tokens: 50 * seq,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: format!("2026-03-19T10:{:02}:00Z", seq),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: None,
        parser_version: None,
        parse_errors: None,
        provider: None,
        transport: None,
        ws_direction: None,
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

fn sample_tool_call(id: &str, turn_id: &str) -> ToolCallRecord {
    ToolCallRecord {
        id: id.to_string(),
        turn_id: turn_id.to_string(),
        tool_name: "read_file".to_string(),
        tool_input: r#"{"path":"src/main.rs"}"#.to_string(),
        input_hash: None,
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
// Section 1: Error Enum Shape (4 tests)
// ===========================================================================

/// **Proves:** `GraphStoreError::DuplicateKey` exposes `entity` and `id` fields
/// that callers can read directly without downcasting or string parsing.
///
/// **Anti-fake:** Constructs the variant directly and reads both fields. If the
/// fields do not exist or have wrong types, the test will not compile.
#[test]
fn duplicate_key_error_contains_entity_and_id() {
    let err = GraphStoreError::DuplicateKey {
        entity: "session".to_string(),
        id: "sess_123".to_string(),
    };

    // Destructure to prove field access works at the type level.
    if let GraphStoreError::DuplicateKey { entity, id } = &err {
        assert_eq!(entity, "session");
        assert_eq!(id, "sess_123");
    } else {
        panic!("Expected DuplicateKey variant");
    }
}

/// **Proves:** The Display impl for `DuplicateKey` produces a human-readable
/// message containing the entity name, id, and the phrase "already exists".
///
/// **Anti-fake:** Checks three substrings in the formatted output. A trivial
/// Display impl (e.g., "error") would fail.
#[test]
fn duplicate_key_error_displays_readable_message() {
    let err = GraphStoreError::DuplicateKey {
        entity: "turn".to_string(),
        id: "turn_456".to_string(),
    };

    let msg = format!("{}", err);
    assert!(
        msg.contains("turn"),
        "Display should contain entity name, got: {}",
        msg
    );
    assert!(
        msg.contains("turn_456"),
        "Display should contain the id, got: {}",
        msg
    );
    assert!(
        msg.contains("already exists"),
        "Display should contain 'already exists', got: {}",
        msg
    );
}

/// **Proves:** `GraphStoreError::ConnectionFailed` wraps a message string and
/// displays it via the Display impl.
///
/// **Anti-fake:** Checks the exact inner message appears in formatted output.
#[test]
fn connection_failed_error_displays_message() {
    let err = GraphStoreError::ConnectionFailed("pool exhausted".to_string());

    let msg = format!("{}", err);
    assert!(
        msg.contains("pool exhausted"),
        "Display should contain the inner message, got: {}",
        msg
    );
}

/// **Proves:** `GraphStoreError::Other` wraps an `anyhow::Error` and displays
/// its message.
///
/// **Anti-fake:** Constructs via `anyhow::anyhow!()` and verifies the inner
/// message is preserved in Display output.
#[test]
fn other_error_wraps_anyhow() {
    let err = GraphStoreError::Other(anyhow::anyhow!("something unexpected"));

    let msg = format!("{}", err);
    assert!(
        msg.contains("something unexpected"),
        "Display should contain the wrapped anyhow message, got: {}",
        msg
    );
}

// ===========================================================================
// Section 2: SqliteGraphStore Returns Typed Errors (5 tests)
// ===========================================================================

/// **Proves:** Writing the same session ID twice returns
/// `GraphStoreError::DuplicateKey { entity: "session", .. }` on the second write.
///
/// **Anti-fake:** Pattern-matches on the exact variant and checks entity field.
/// If the implementation returns `anyhow::Error` instead of `GraphStoreError`,
/// this will not compile (the match arm requires `GraphStoreError::DuplicateKey`).
#[test]
fn sqlite_duplicate_session_returns_duplicate_key_variant() {
    let store = SqliteGraphStore::new_in_memory().expect("create store");
    let session = sample_session("sess_dup_test");

    // First write succeeds.
    let first: GraphStoreResult<()> = store.write_session(&session);
    assert!(first.is_ok(), "First session write should succeed");

    // Second write must return DuplicateKey.
    let second: GraphStoreResult<()> = store.write_session(&session);
    match second {
        Err(GraphStoreError::DuplicateKey { entity, id }) => {
            assert_eq!(entity, "session");
            assert_eq!(id, "sess_dup_test");
        }
        Err(other) => panic!(
            "Expected DuplicateKey for session, got different error: {:?}",
            other
        ),
        Ok(()) => panic!("Expected error on duplicate session write, got Ok"),
    }
}

/// **Proves:** Re-inserting the SAME turn (same id, same session, same
/// seq) is an idempotent retry — the SQL `ON CONFLICT (id) DO NOTHING`
/// clause absorbs the PK collision at the DB layer, so the second write
/// returns `Ok(())` rather than `Err(DuplicateKey)`.
///
/// **Why this changed (Batch 11):** when both PK and the secondary
/// `UNIQUE(session_id, sequence_num)` would collide, SQLite reports the
/// secondary constraint first. Without `ON CONFLICT (id) DO NOTHING` the
/// classifier would mis-surface a true idempotent retry as a
/// `UniqueViolation`. The DB-level conflict-resolution handles PK
/// collisions correctly; only DIFFERENT rows colliding on the secondary
/// UNIQUE reach the classifier — covered by
/// `batch11_silent_dup_loss_tests::write_turn_distinguishes_pk_from_secondary_unique_violations`.
#[test]
fn sqlite_duplicate_turn_returns_ok_idempotent_retry() {
    let store = SqliteGraphStore::new_in_memory().expect("create store");
    let session = sample_session("sess_for_dup_turn");
    store.write_session(&session).expect("session write");

    let turn = sample_turn("turn_dup_test", "sess_for_dup_turn", 1);

    let first: GraphStoreResult<()> = store.write_turn(&turn);
    assert!(first.is_ok(), "First turn write should succeed");

    let second: GraphStoreResult<()> = store.write_turn(&turn);
    assert!(
        second.is_ok(),
        "Re-inserting the SAME turn must be an idempotent Ok (PK absorbed \
         by ON CONFLICT). Got: {:?}",
        second.err()
    );
}

/// **Proves:** Writing the same tool_call ID twice returns
/// `GraphStoreError::DuplicateKey { entity: "tool_call", .. }`.
///
/// **Anti-fake:** Requires parent session and turn. Checks entity field value.
#[test]
fn sqlite_duplicate_tool_call_returns_duplicate_key_variant() {
    let store = SqliteGraphStore::new_in_memory().expect("create store");
    let session = sample_session("sess_for_dup_tc");
    store.write_session(&session).expect("session write");
    let turn = sample_turn("turn_for_dup_tc", "sess_for_dup_tc", 1);
    store.write_turn(&turn).expect("turn write");

    let tc = sample_tool_call("tc_dup_test", "turn_for_dup_tc");

    let first: GraphStoreResult<()> = store.write_tool_call(&tc);
    assert!(first.is_ok(), "First tool_call write should succeed");

    let second: GraphStoreResult<()> = store.write_tool_call(&tc);
    match second {
        Err(GraphStoreError::DuplicateKey { entity, id }) => {
            assert_eq!(entity, "tool_call");
            assert_eq!(id, "tc_dup_test");
        }
        Err(other) => panic!(
            "Expected DuplicateKey for tool_call, got different error: {:?}",
            other
        ),
        Ok(()) => panic!("Expected error on duplicate tool_call write, got Ok"),
    }
}

/// **Proves:** A non-duplicate error (e.g., FK violation) is NOT wrapped as
/// `DuplicateKey` — it comes back as `GraphStoreError::Other`.
///
/// **Anti-fake:** Writes a turn referencing a non-existent session (violating
/// the FK constraint). Verifies the error is NOT the DuplicateKey variant.
#[test]
fn sqlite_non_duplicate_error_is_not_duplicate_key() {
    let store = SqliteGraphStore::new_in_memory().expect("create store");

    // Write a turn without first creating its parent session.
    // This should fail with a FK constraint error, not a duplicate key error.
    let turn = sample_turn("turn_no_parent", "nonexistent_session", 1);

    let result: GraphStoreResult<()> = store.write_turn(&turn);
    match result {
        Err(GraphStoreError::DuplicateKey { .. }) => {
            panic!("FK violation should NOT be reported as DuplicateKey");
        }
        Err(GraphStoreError::Other(_)) => {
            // Correct: FK violation is an Other error.
        }
        Err(GraphStoreError::ConnectionFailed(_)) => {
            // Also acceptable — implementation could classify this differently.
        }
        Ok(()) => panic!("Expected FK violation error, got Ok"),
        Err(_) => {
            // Future variants — acceptable as long as it's not DuplicateKey.
        }
    }
}

/// **Proves:** A normal write returns `Ok(())`, confirming the happy path works
/// with the new `GraphStoreResult` return type.
///
/// **Anti-fake:** Asserts `is_ok()` on the typed result.
#[test]
fn sqlite_successful_write_returns_ok() {
    let store = SqliteGraphStore::new_in_memory().expect("create store");
    let session = sample_session("sess_ok_write");
    let result: GraphStoreResult<()> = store.write_session(&session);
    assert!(result.is_ok(), "Normal write should return Ok");

    let turn = sample_turn("turn_ok_write", "sess_ok_write", 1);
    let result: GraphStoreResult<()> = store.write_turn(&turn);
    assert!(result.is_ok(), "Normal turn write should return Ok");

    let tc = sample_tool_call("tc_ok_write", "turn_ok_write");
    let result: GraphStoreResult<()> = store.write_tool_call(&tc);
    assert!(result.is_ok(), "Normal tool_call write should return Ok");
}

// ===========================================================================
// Section 3: Caller Pattern Matching (4 tests)
// ===========================================================================

/// **Proves:** A caller can identify a duplicate-key error purely via pattern
/// matching — no `.to_string()`, no `.contains()`, no string operations at all.
///
/// **Anti-fake:** Uses `if let` with the `DuplicateKey` variant. The entire
/// test body contains zero string matching on the error. If the type were
/// `anyhow::Error`, this pattern match would not compile.
#[test]
fn caller_can_match_duplicate_key_without_string_matching() {
    let store = SqliteGraphStore::new_in_memory().expect("create store");
    let session = sample_session("sess_match_dup");
    store.write_session(&session).expect("first write");

    let result = store.write_session(&session);

    // Pure pattern match — no string ops anywhere.
    let is_duplicate = matches!(result, Err(GraphStoreError::DuplicateKey { .. }));
    assert!(
        is_duplicate,
        "Duplicate session should be identified via pattern match alone"
    );
}

/// **Proves:** A caller can distinguish `DuplicateKey` from `Other` errors
/// using pattern matching, confirming the two variants are structurally different.
///
/// **Anti-fake:** Creates both error types from real store operations and
/// verifies they match different arms of a match expression.
#[test]
fn caller_can_distinguish_duplicate_from_other_errors() {
    let store = SqliteGraphStore::new_in_memory().expect("create store");

    // Produce an Other error: write turn with no parent session (FK violation).
    let turn_orphan = sample_turn("turn_orphan", "no_such_session", 1);
    let fk_result = store.write_turn(&turn_orphan);
    assert!(
        matches!(fk_result, Err(GraphStoreError::Other(_))),
        "FK violation should produce Other variant, got: {:?}",
        fk_result
    );

    // Produce a DuplicateKey error: write same session twice.
    let session = sample_session("sess_distinguish");
    store.write_session(&session).expect("first write");
    let dup_result = store.write_session(&session);
    assert!(
        matches!(dup_result, Err(GraphStoreError::DuplicateKey { .. })),
        "Duplicate write should produce DuplicateKey variant, got: {:?}",
        dup_result
    );

    // Prove they are different at the type level.
    let fk_is_dup = matches!(fk_result, Err(GraphStoreError::DuplicateKey { .. }));
    let dup_is_other = matches!(dup_result, Err(GraphStoreError::Other(_)));
    assert!(!fk_is_dup, "FK error must not match DuplicateKey");
    assert!(!dup_is_other, "Duplicate error must not match Other");
}

/// **Proves:** `WritePipeline` handles duplicate sessions internally via typed
/// pattern matching (not string matching). Writing the same session twice via
/// `write_capture` succeeds because the pipeline ignores `DuplicateKey` for
/// sessions (the session may already exist from a previous turn).
///
/// **Anti-fake:** Calls `write_capture` twice with the same session but different
/// turns. Both calls must return `Ok`. If the pipeline still uses string matching
/// internally, it would need to be updated to use `GraphStoreError::DuplicateKey`
/// — and this test proves the updated pipeline works.
#[test]
fn pipeline_ignores_duplicate_session_via_pattern_match() {
    let store = SqliteGraphStore::new_in_memory().expect("create store");
    let tmp_dir = tempfile::tempdir().expect("create temp dir");
    let obj_store = LocalObjectStore::new(tmp_dir.path());
    let dlq_dir = tmp_dir.path().join("dlq");

    let pipeline = WritePipeline::new(Box::new(store), Box::new(obj_store), dlq_dir);

    let session = sample_session("sess_pipe_dup");
    let turn1 = sample_turn("turn_pipe_1", "sess_pipe_dup", 1);
    let turn2 = sample_turn("turn_pipe_2", "sess_pipe_dup", 2);
    let req_bytes = b"request body";
    let resp_bytes = b"response body";

    // First capture: creates session + turn1.
    let result1 = pipeline.write_capture(&session, &turn1, &[], req_bytes, resp_bytes);
    assert!(
        result1.is_ok(),
        "First write_capture should succeed: {:?}",
        result1
    );

    // Second capture: same session (already exists), different turn.
    // Pipeline must handle the duplicate session via pattern match, not string match.
    let result2 = pipeline.write_capture(&session, &turn2, &[], req_bytes, resp_bytes);
    assert!(
        result2.is_ok(),
        "Second write_capture with same session should succeed: {:?}",
        result2
    );
}

/// **Proves:** The `entity` field in `DuplicateKey` correctly identifies which
/// record type was duplicated: "session" for sessions, "turn" for turns,
/// "tool_call" for tool calls.
///
/// **Anti-fake:** Creates duplicates for all three entity types and verifies
/// the `entity` field in each case. A lazy implementation that always says
/// "record" would fail.
#[test]
fn duplicate_key_entity_field_is_correct() {
    let store = SqliteGraphStore::new_in_memory().expect("create store");

    // Session duplicate.
    let session = sample_session("sess_entity_check");
    store.write_session(&session).expect("first session");
    let sess_err = store.write_session(&session).unwrap_err();
    if let GraphStoreError::DuplicateKey { entity, .. } = &sess_err {
        assert_eq!(
            entity, "session",
            "Session dup should have entity='session'"
        );
    } else {
        panic!("Expected DuplicateKey for session, got: {:?}", sess_err);
    }

    // Turn idempotent retry: same id, same session, same seq. After Batch 11,
    // ON CONFLICT (id) DO NOTHING absorbs the PK collision so the second
    // write is Ok. SECONDARY UNIQUE collisions on a DIFFERENT row are
    // covered by the entity-tagged UniqueViolation variant —
    // see `batch11_silent_dup_loss_tests`.
    let turn = sample_turn("turn_entity_check", "sess_entity_check", 1);
    store.write_turn(&turn).expect("first turn");
    let turn_redo = store.write_turn(&turn);
    assert!(
        turn_redo.is_ok(),
        "Idempotent turn re-insert must be Ok; got: {:?}",
        turn_redo.err()
    );

    // Tool call duplicate.
    let tc = sample_tool_call("tc_entity_check", "turn_entity_check");
    store.write_tool_call(&tc).expect("first tool_call");
    let tc_err = store.write_tool_call(&tc).unwrap_err();
    if let GraphStoreError::DuplicateKey { entity, .. } = &tc_err {
        assert_eq!(
            entity, "tool_call",
            "Tool call dup should have entity='tool_call'"
        );
    } else {
        panic!("Expected DuplicateKey for tool_call, got: {:?}", tc_err);
    }
}

// ===========================================================================
// Section 4: Negative Tests (3 tests)
// ===========================================================================

/// **Proves:** The return type of `write_session` is `GraphStoreResult<()>`
/// (i.e., `Result<(), GraphStoreError>`), NOT `anyhow::Result<()>`. This is
/// verified by pattern-matching on `GraphStoreError` variants directly — if the
/// return type were `anyhow::Result<()>`, the match arms would not compile
/// because `anyhow::Error` does not have a `DuplicateKey` variant.
///
/// **Anti-fake:** The match expression exhaustively handles `GraphStoreError`
/// variants. If the type were `anyhow::Error`, rustc would reject the pattern.
#[test]
fn graph_store_result_type_is_not_anyhow_result() {
    let store = SqliteGraphStore::new_in_memory().expect("create store");
    let session = sample_session("sess_type_check");

    // Explicitly annotate the type to prove it compiles as GraphStoreResult.
    let result: GraphStoreResult<()> = store.write_session(&session);

    // Match on GraphStoreError variants — this would not compile if the Err
    // type were anyhow::Error.
    match result {
        Ok(()) => { /* expected */ }
        Err(GraphStoreError::DuplicateKey { entity, id }) => {
            panic!("Unexpected DuplicateKey: entity={}, id={}", entity, id);
        }
        Err(GraphStoreError::ConnectionFailed(msg)) => {
            panic!("Unexpected ConnectionFailed: {}", msg);
        }
        Err(GraphStoreError::Other(e)) => {
            panic!("Unexpected Other error: {}", e);
        }
        Err(e) => {
            panic!("Unexpected error variant: {:?}", e);
        }
    }
}

/// **Proves:** Duplicate detection works via match expression ONLY — no
/// `.to_string()`, no `.contains()`, no string operations whatsoever. The entire
/// identification of a duplicate-key error is done structurally.
///
/// **Anti-fake:** The test deliberately avoids calling any method on the error
/// that returns a string. If this test passes, it proves that callers never
/// need string matching to detect duplicates.
#[test]
fn no_string_matching_needed_for_duplicate_detection() {
    let store = SqliteGraphStore::new_in_memory().expect("create store");
    let session = sample_session("sess_no_strings");
    store.write_session(&session).expect("first write");

    let result = store.write_session(&session);

    // Identify the duplicate using ONLY pattern matching — no string ops.
    let detected_duplicate: bool = match result {
        Ok(()) => false,
        Err(GraphStoreError::DuplicateKey { .. }) => true,
        Err(GraphStoreError::ConnectionFailed(_)) => false,
        Err(GraphStoreError::Other(_)) => false,
        Err(_) => false, // Future variants — not a duplicate.
    };

    assert!(
        detected_duplicate,
        "Must detect duplicate via pattern match without any string operations"
    );
}

/// **Proves:** `GraphStoreError::Other` preserves the wrapped source error.
/// Callers can use `std::error::Error::source()` or downcast to access the
/// original error.
///
/// **Anti-fake:** Wraps a known anyhow error, then verifies the Display output
/// of the source chain preserves the original message. Also verifies that
/// `GraphStoreError` implements `std::error::Error`.
#[test]
fn other_variant_preserves_source_error() {
    let original_msg = "database disk image is malformed";
    let err = GraphStoreError::Other(anyhow::anyhow!(original_msg));

    // GraphStoreError must implement std::error::Error.
    let std_err: &dyn std::error::Error = &err;

    // The Display representation should contain the original message.
    let display = format!("{}", std_err);
    assert!(
        display.contains(original_msg),
        "Display should preserve the source message, got: {}",
        display
    );

    // The source() chain should eventually contain the original message.
    // (Implementation may vary — source() might return the anyhow::Error directly,
    // or it might be None if Display already includes it. We just verify the
    // message is accessible via the error somehow.)
    let debug = format!("{:?}", err);
    assert!(
        debug.contains(original_msg),
        "Debug should preserve the source message, got: {}",
        debug
    );
}
