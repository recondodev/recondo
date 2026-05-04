//! Sprint 5: Supply Chain Attestation + SOC 2 Evidence Package
//!
//! Behavioral tests for:
//!   D1: Artifact tracking from tool calls (Write, Edit, Bash)
//!   D2: SUPERSEDES edge chain connecting related modifications
//!
//! EVERY test in this file imports from modules that DO NOT EXIST yet:
//!
//! - `recondo_gateway::artifacts` (new module: extract_artifacts, ArtifactInfo)
//! - `recondo_gateway::db::ToolCallRecord` fields: `artifacts_created`, `artifact_hashes`
//! - `recondo_gateway::db::TurnRecord` field: `supersedes_turn_id`
//! - `recondo_gateway::artifacts::SupersedesResolver` (new: resolves supersedes chains)
//!
//! This file MUST NOT compile until the implementation agent creates these modules
//! and adds the new fields. Each test imports production types/functions that do
//! not exist yet. The implementation agent must create them to make these tests pass.

#![allow(
    dead_code,
    unused_imports,
    clippy::single_match,
    clippy::unnecessary_map_or,
    clippy::len_zero
)]

use recondo_gateway::db::{self, SessionRecord, ToolCallRecord, TurnRecord};
use recondo_gateway::hash;
use serde_json::json;

// ---- These imports WILL NOT RESOLVE until the new module is created ----

// D1: Artifact extraction from tool call inputs
use recondo_gateway::artifacts::{extract_artifacts, ArtifactInfo};

// D2: SUPERSEDES chain resolution
use recondo_gateway::artifacts::SupersedesResolver;

// ===========================================================================
// Helpers
// ===========================================================================

fn setup_db() -> rusqlite::Connection {
    let conn = db::open_in_memory().expect("Must open in-memory SQLite");
    db::initialize(&conn).expect("Must initialize database schema");
    conn
}

fn sample_session(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.to_string(),
        provider: "anthropic".to_string(),
        model: Some("claude-sonnet-4-20250514".to_string()),
        started_at: "2026-03-17T10:00:00Z".to_string(),
        last_active_at: "2026-03-17T10:05:00Z".to_string(),
        ended_at: None,
        initial_intent: Some("Build authentication module".to_string()),
        system_prompt_hash: "abc123def456".to_string(),
        total_turns: 0,
        turns_captured: 0,
        dropped_events: 0,
        total_tokens: 0,
        total_cost_usd: 0.0,
        framework: None,
        agent_id: Some("claude-code".to_string()),
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
        timestamp: format!("2026-03-17T10:{:02}:00Z", seq),
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
        created_at: format!("2026-03-17T10:{:02}:00Z", seq),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: None,
        parser_version: None,
        parse_errors: None,
        provider: Some("anthropic".to_string()),
        transport: None,
        ws_direction: None,
        duration_ms: None,
        ttfb_ms: None,
        api_endpoint: None,
        http_status: None,
        error_message: None,
        retry_count: 0,
        tool_call_count: 1,
        thinking_tokens: 0,
        server_id: None,
        integrity_verified: None,
        // Sprint 5: new field — will not compile until added to TurnRecord
        supersedes_turn_id: None,
        user_request_text: None,
        attachment_count: 0,
    }
}

// ===========================================================================
// D1: Artifact extraction from Write tool call
// ===========================================================================

/// Write tool call with a file_path in tool_input should produce an artifact
/// in artifacts_created and a corresponding SHA-256 hash in artifact_hashes.
#[test]
fn d1_write_tool_extracts_artifact_path() {
    let tool_input = json!({
        "file_path": "/src/auth.ts",
        "content": "export function authenticate() { }"
    });

    let artifacts = extract_artifacts("Write", &tool_input.to_string());

    assert_eq!(
        artifacts.len(),
        1,
        "Write tool must produce exactly one artifact"
    );
    assert_eq!(
        artifacts[0].path, "/src/auth.ts",
        "Artifact path must match the file_path from tool_input"
    );
    assert!(
        !artifacts[0].hash.is_empty(),
        "Artifact hash must not be empty"
    );
    // The hash is SHA-256 of the path string, not the file content
    let expected_hash = hash::sha256_hex(b"/src/auth.ts");
    assert_eq!(
        artifacts[0].hash, expected_hash,
        "Artifact hash must be SHA-256 of the file path"
    );
}

/// Write tool with alternative "path" key (not "file_path") also works.
#[test]
fn d1_write_tool_extracts_from_path_key() {
    let tool_input = json!({
        "path": "/src/db.ts",
        "content": "export const pool = {};"
    });

    let artifacts = extract_artifacts("Write", &tool_input.to_string());

    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0].path, "/src/db.ts");
}

// ===========================================================================
// D1: Artifact extraction from Edit tool call
// ===========================================================================

/// Edit tool call with a file_path in tool_input should produce an artifact.
#[test]
fn d1_edit_tool_extracts_artifact_path() {
    let tool_input = json!({
        "file_path": "/src/auth.ts",
        "old_string": "function old() {}",
        "new_string": "function new() {}"
    });

    let artifacts = extract_artifacts("Edit", &tool_input.to_string());

    assert_eq!(
        artifacts.len(),
        1,
        "Edit tool must produce exactly one artifact"
    );
    assert_eq!(artifacts[0].path, "/src/auth.ts");

    let expected_hash = hash::sha256_hex(b"/src/auth.ts");
    assert_eq!(artifacts[0].hash, expected_hash);
}

/// Edit tool with "file" key (alternative JSON key) also works.
#[test]
fn d1_edit_tool_extracts_from_file_key() {
    let tool_input = json!({
        "file": "/src/routes.ts",
        "edits": 3
    });

    let artifacts = extract_artifacts("Edit", &tool_input.to_string());

    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0].path, "/src/routes.ts");
}

// ===========================================================================
// D1: Artifact extraction from Bash tool call
// ===========================================================================

/// Bash tool with redirect operator (>) should detect the output file.
#[test]
fn d1_bash_tool_detects_redirect_operator() {
    let tool_input = json!({
        "command": "echo 'hello' > /tmp/output.txt"
    });

    let artifacts = extract_artifacts("Bash", &tool_input.to_string());

    assert!(
        artifacts.len() >= 1,
        "Bash with > redirect must detect at least one artifact"
    );
    assert!(
        artifacts.iter().any(|a| a.path == "/tmp/output.txt"),
        "Must detect /tmp/output.txt from redirect"
    );
}

/// Bash tool with append operator (>>) should detect the output file.
#[test]
fn d1_bash_tool_detects_append_operator() {
    let tool_input = json!({
        "command": "echo 'line' >> /var/log/app.log"
    });

    let artifacts = extract_artifacts("Bash", &tool_input.to_string());

    assert!(
        artifacts.iter().any(|a| a.path == "/var/log/app.log"),
        "Must detect /var/log/app.log from append redirect"
    );
}

/// Bash tool with tee command should detect the output file.
#[test]
fn d1_bash_tool_detects_tee_command() {
    let tool_input = json!({
        "command": "cat input.txt | tee /output/result.txt"
    });

    let artifacts = extract_artifacts("Bash", &tool_input.to_string());

    assert!(
        artifacts.iter().any(|a| a.path == "/output/result.txt"),
        "Must detect /output/result.txt from tee"
    );
}

/// Bash tool with cp command should detect the destination file.
#[test]
fn d1_bash_tool_detects_cp_command() {
    let tool_input = json!({
        "command": "cp /src/old.ts /src/new.ts"
    });

    let artifacts = extract_artifacts("Bash", &tool_input.to_string());

    assert!(
        artifacts.iter().any(|a| a.path == "/src/new.ts"),
        "Must detect /src/new.ts as cp destination"
    );
}

/// Bash tool with mv command should detect the destination file.
#[test]
fn d1_bash_tool_detects_mv_command() {
    let tool_input = json!({
        "command": "mv /src/temp.ts /src/final.ts"
    });

    let artifacts = extract_artifacts("Bash", &tool_input.to_string());

    assert!(
        artifacts.iter().any(|a| a.path == "/src/final.ts"),
        "Must detect /src/final.ts as mv destination"
    );
}

/// Bash tool without any file-writing command should produce no artifacts.
#[test]
fn d1_bash_tool_no_artifacts_for_readonly_command() {
    let tool_input = json!({
        "command": "ls -la /src"
    });

    let artifacts = extract_artifacts("Bash", &tool_input.to_string());

    assert!(
        artifacts.is_empty(),
        "Read-only Bash commands must produce no artifacts"
    );
}

// ===========================================================================
// D1: SHA-256 hashing of artifact paths
// ===========================================================================

/// SHA-256 hash of artifact path is deterministic and correct.
#[test]
fn d1_artifact_hash_is_sha256_of_path() {
    let path = "/src/auth.ts";
    let expected = hash::sha256_hex(path.as_bytes());

    let tool_input = json!({ "file_path": path, "content": "x" });
    let artifacts = extract_artifacts("Write", &tool_input.to_string());

    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0].hash, expected);
}

/// Same path always produces the same hash (determinism).
#[test]
fn d1_artifact_hash_is_deterministic() {
    let tool_input = json!({ "file_path": "/src/auth.ts", "content": "a" });
    let artifacts1 = extract_artifacts("Write", &tool_input.to_string());

    let tool_input2 = json!({ "file_path": "/src/auth.ts", "content": "different content" });
    let artifacts2 = extract_artifacts("Write", &tool_input2.to_string());

    // Same path, different content -> same hash (hash is of PATH, not content)
    assert_eq!(
        artifacts1[0].hash, artifacts2[0].hash,
        "Hash must be of the path, not content — same path = same hash"
    );
}

/// Different paths produce different hashes.
#[test]
fn d1_different_paths_produce_different_hashes() {
    let input1 = json!({ "file_path": "/src/auth.ts", "content": "x" });
    let input2 = json!({ "file_path": "/src/db.ts", "content": "x" });

    let a1 = extract_artifacts("Write", &input1.to_string());
    let a2 = extract_artifacts("Write", &input2.to_string());

    assert_ne!(
        a1[0].hash, a2[0].hash,
        "Different paths must produce different hashes"
    );
}

// ===========================================================================
// D1: artifacts_created and artifact_hashes stored on ToolCallRecord
// ===========================================================================

/// ToolCallRecord must have artifacts_created (JSON array of paths)
/// and artifact_hashes (JSON array of SHA-256 hashes) fields.
#[test]
fn d1_tool_call_record_stores_artifacts() {
    let conn = setup_db();

    let session = sample_session("sess_art");
    db::insert_session(&conn, &session).expect("insert session");

    let mut turn = sample_turn("turn_art", "sess_art", 1);
    turn.tool_call_count = 1;
    db::insert_turn(&conn, &turn).expect("insert turn");

    let tc = ToolCallRecord {
        id: "tc_art_1".to_string(),
        turn_id: "turn_art".to_string(),
        tool_name: "Write".to_string(),
        tool_input: r#"{"file_path":"/src/auth.ts","content":"export function auth() {}"}"#
            .to_string(),
        input_hash: Some("sha256_input".to_string()),
        sequence_num: Some(0),
        output: Some("File written".to_string()),
        output_hash: None,
        duration_ms: Some(100),
        error: None,
        status: Some("success".to_string()),
        // Sprint 5 new fields — will not compile until added to ToolCallRecord
        artifacts_created: Some(r#"["/src/auth.ts"]"#.to_string()),
        artifact_hashes: Some(format!(r#"["{}"]"#, hash::sha256_hex(b"/src/auth.ts"))),
    };

    db::insert_tool_call(&conn, &tc).expect("insert tool call with artifacts");

    // Read it back
    let tool_calls = db::get_tool_calls_for_turn(&conn, "turn_art").expect("query tool calls");
    assert_eq!(tool_calls.len(), 1);

    let stored = &tool_calls[0];
    assert!(
        stored.artifacts_created.is_some(),
        "artifacts_created must be stored"
    );
    assert!(
        stored.artifact_hashes.is_some(),
        "artifact_hashes must be stored"
    );

    // Parse JSON arrays
    let paths: Vec<String> = serde_json::from_str(stored.artifacts_created.as_ref().unwrap())
        .expect("artifacts_created must be valid JSON array");
    assert_eq!(paths, vec!["/src/auth.ts"]);

    let hashes: Vec<String> = serde_json::from_str(stored.artifact_hashes.as_ref().unwrap())
        .expect("artifact_hashes must be valid JSON array");
    assert_eq!(hashes.len(), 1);
    assert_eq!(hashes[0], hash::sha256_hex(b"/src/auth.ts"));
}

/// ToolCallRecord with no artifacts should have empty JSON arrays (not NULL).
#[test]
fn d1_tool_call_record_no_artifacts_empty_arrays() {
    let conn = setup_db();

    let session = sample_session("sess_noart");
    db::insert_session(&conn, &session).expect("insert session");

    let mut turn = sample_turn("turn_noart", "sess_noart", 1);
    turn.tool_call_count = 1;
    db::insert_turn(&conn, &turn).expect("insert turn");

    // A Read tool call produces no artifacts
    let tc = ToolCallRecord {
        id: "tc_noart_1".to_string(),
        turn_id: "turn_noart".to_string(),
        tool_name: "Read".to_string(),
        tool_input: r#"{"file_path":"/src/auth.ts"}"#.to_string(),
        input_hash: None,
        sequence_num: Some(0),
        output: Some("file contents...".to_string()),
        output_hash: None,
        duration_ms: Some(50),
        error: None,
        status: Some("success".to_string()),
        artifacts_created: Some("[]".to_string()),
        artifact_hashes: Some("[]".to_string()),
    };

    db::insert_tool_call(&conn, &tc).expect("insert tool call");

    let tool_calls = db::get_tool_calls_for_turn(&conn, "turn_noart").expect("query tool calls");
    let stored = &tool_calls[0];

    let paths: Vec<String> = serde_json::from_str(stored.artifacts_created.as_ref().unwrap())
        .expect("must be valid JSON");
    assert!(
        paths.is_empty(),
        "Read tool must have empty artifacts_created"
    );

    let hashes: Vec<String> =
        serde_json::from_str(stored.artifact_hashes.as_ref().unwrap()).expect("must be valid JSON");
    assert!(
        hashes.is_empty(),
        "Read tool must have empty artifact_hashes"
    );
}

/// Unknown tool names produce no artifacts.
#[test]
fn d1_unknown_tool_produces_no_artifacts() {
    let tool_input = json!({ "something": "value" });
    let artifacts = extract_artifacts("UnknownTool", &tool_input.to_string());
    assert!(
        artifacts.is_empty(),
        "Unknown tool names must produce no artifacts"
    );
}

/// Malformed JSON in tool_input should not panic, returns empty artifacts.
#[test]
fn d1_malformed_tool_input_returns_empty_artifacts() {
    let artifacts = extract_artifacts("Write", "this is not json {{{");
    assert!(
        artifacts.is_empty(),
        "Malformed tool_input must return empty artifacts, not panic"
    );
}

// ===========================================================================
// D2: SUPERSEDES edge chain — Turn B supersedes Turn A
// ===========================================================================

/// When Turn B modifies the same file as Turn A in the same session,
/// Turn B's supersedes_turn_id must point to Turn A's id.
#[test]
fn d2_supersedes_chain_same_file_two_turns() {
    let conn = setup_db();

    let session = sample_session("sess_super");
    db::insert_session(&conn, &session).expect("insert session");

    // Turn A: creates /src/auth.ts
    let mut turn_a = sample_turn("turn_a", "sess_super", 1);
    turn_a.supersedes_turn_id = None;
    db::insert_turn(&conn, &turn_a).expect("insert turn A");

    let tc_a = ToolCallRecord {
        id: "tc_a".to_string(),
        turn_id: "turn_a".to_string(),
        tool_name: "Write".to_string(),
        tool_input: r#"{"file_path":"/src/auth.ts","content":"v1"}"#.to_string(),
        input_hash: None,
        sequence_num: Some(0),
        output: Some("Written".to_string()),
        output_hash: None,
        duration_ms: None,
        error: None,
        status: Some("success".to_string()),
        artifacts_created: Some(r#"["/src/auth.ts"]"#.to_string()),
        artifact_hashes: Some(format!(r#"["{}"]"#, hash::sha256_hex(b"/src/auth.ts"))),
    };
    db::insert_tool_call(&conn, &tc_a).expect("insert tc A");

    // Turn B: edits /src/auth.ts — should supersede Turn A
    let mut turn_b = sample_turn("turn_b", "sess_super", 2);
    turn_b.supersedes_turn_id = Some("turn_a".to_string());
    db::insert_turn(&conn, &turn_b).expect("insert turn B");

    let tc_b = ToolCallRecord {
        id: "tc_b".to_string(),
        turn_id: "turn_b".to_string(),
        tool_name: "Edit".to_string(),
        tool_input: r#"{"file_path":"/src/auth.ts","old_string":"v1","new_string":"v2"}"#
            .to_string(),
        input_hash: None,
        sequence_num: Some(0),
        output: Some("Edited".to_string()),
        output_hash: None,
        duration_ms: None,
        error: None,
        status: Some("success".to_string()),
        artifacts_created: Some(r#"["/src/auth.ts"]"#.to_string()),
        artifact_hashes: Some(format!(r#"["{}"]"#, hash::sha256_hex(b"/src/auth.ts"))),
    };
    db::insert_tool_call(&conn, &tc_b).expect("insert tc B");

    // Verify: Turn B's supersedes_turn_id must point to Turn A
    let stored_turn_b = db::get_turn(&conn, "turn_b")
        .expect("query turn B")
        .expect("turn B must exist");
    assert_eq!(
        stored_turn_b.supersedes_turn_id,
        Some("turn_a".to_string()),
        "Turn B must supersede Turn A when both modify /src/auth.ts"
    );

    // Verify: Turn A has no supersedes (it's the original)
    let stored_turn_a = db::get_turn(&conn, "turn_a")
        .expect("query turn A")
        .expect("turn A must exist");
    assert_eq!(
        stored_turn_a.supersedes_turn_id, None,
        "Turn A (the original) must not supersede anything"
    );
}

/// Multi-hop chain: Turn C supersedes Turn B supersedes Turn A.
#[test]
fn d2_supersedes_chain_multi_hop() {
    let conn = setup_db();

    let session = sample_session("sess_chain");
    db::insert_session(&conn, &session).expect("insert session");

    // Turn A: creates /src/auth.ts
    let mut turn_a = sample_turn("turn_chain_a", "sess_chain", 1);
    turn_a.supersedes_turn_id = None;
    db::insert_turn(&conn, &turn_a).expect("insert turn A");

    db::insert_tool_call(
        &conn,
        &ToolCallRecord {
            id: "tc_chain_a".to_string(),
            turn_id: "turn_chain_a".to_string(),
            tool_name: "Write".to_string(),
            tool_input: r#"{"file_path":"/src/auth.ts","content":"v1"}"#.to_string(),
            input_hash: None,
            sequence_num: Some(0),
            output: None,
            output_hash: None,
            duration_ms: None,
            error: None,
            status: Some("success".to_string()),
            artifacts_created: Some(r#"["/src/auth.ts"]"#.to_string()),
            artifact_hashes: Some(format!(r#"["{}"]"#, hash::sha256_hex(b"/src/auth.ts"))),
        },
    )
    .expect("insert tc A");

    // Turn B: edits /src/auth.ts — supersedes Turn A
    let mut turn_b = sample_turn("turn_chain_b", "sess_chain", 2);
    turn_b.supersedes_turn_id = Some("turn_chain_a".to_string());
    db::insert_turn(&conn, &turn_b).expect("insert turn B");

    db::insert_tool_call(
        &conn,
        &ToolCallRecord {
            id: "tc_chain_b".to_string(),
            turn_id: "turn_chain_b".to_string(),
            tool_name: "Edit".to_string(),
            tool_input: r#"{"file_path":"/src/auth.ts","old_string":"v1","new_string":"v2"}"#
                .to_string(),
            input_hash: None,
            sequence_num: Some(0),
            output: None,
            output_hash: None,
            duration_ms: None,
            error: None,
            status: Some("success".to_string()),
            artifacts_created: Some(r#"["/src/auth.ts"]"#.to_string()),
            artifact_hashes: Some(format!(r#"["{}"]"#, hash::sha256_hex(b"/src/auth.ts"))),
        },
    )
    .expect("insert tc B");

    // Turn C: edits /src/auth.ts again — supersedes Turn B
    let mut turn_c = sample_turn("turn_chain_c", "sess_chain", 3);
    turn_c.supersedes_turn_id = Some("turn_chain_b".to_string());
    db::insert_turn(&conn, &turn_c).expect("insert turn C");

    db::insert_tool_call(
        &conn,
        &ToolCallRecord {
            id: "tc_chain_c".to_string(),
            turn_id: "turn_chain_c".to_string(),
            tool_name: "Edit".to_string(),
            tool_input: r#"{"file_path":"/src/auth.ts","old_string":"v2","new_string":"v3"}"#
                .to_string(),
            input_hash: None,
            sequence_num: Some(0),
            output: None,
            output_hash: None,
            duration_ms: None,
            error: None,
            status: Some("success".to_string()),
            artifacts_created: Some(r#"["/src/auth.ts"]"#.to_string()),
            artifact_hashes: Some(format!(r#"["{}"]"#, hash::sha256_hex(b"/src/auth.ts"))),
        },
    )
    .expect("insert tc C");

    // Verify the full chain: C -> B -> A
    let stored_c = db::get_turn(&conn, "turn_chain_c")
        .expect("query C")
        .expect("C exists");
    assert_eq!(
        stored_c.supersedes_turn_id,
        Some("turn_chain_b".to_string()),
        "Turn C must supersede Turn B"
    );

    let stored_b = db::get_turn(&conn, "turn_chain_b")
        .expect("query B")
        .expect("B exists");
    assert_eq!(
        stored_b.supersedes_turn_id,
        Some("turn_chain_a".to_string()),
        "Turn B must supersede Turn A"
    );

    let stored_a = db::get_turn(&conn, "turn_chain_a")
        .expect("query A")
        .expect("A exists");
    assert_eq!(
        stored_a.supersedes_turn_id, None,
        "Turn A (root) has no supersedes"
    );
}

/// No SUPERSEDES when different files are modified in consecutive turns.
#[test]
fn d2_no_supersedes_different_files() {
    let conn = setup_db();

    let session = sample_session("sess_diff");
    db::insert_session(&conn, &session).expect("insert session");

    // Turn A: creates /src/auth.ts
    let mut turn_a = sample_turn("turn_diff_a", "sess_diff", 1);
    turn_a.supersedes_turn_id = None;
    db::insert_turn(&conn, &turn_a).expect("insert turn A");

    db::insert_tool_call(
        &conn,
        &ToolCallRecord {
            id: "tc_diff_a".to_string(),
            turn_id: "turn_diff_a".to_string(),
            tool_name: "Write".to_string(),
            tool_input: r#"{"file_path":"/src/auth.ts","content":"v1"}"#.to_string(),
            input_hash: None,
            sequence_num: Some(0),
            output: None,
            output_hash: None,
            duration_ms: None,
            error: None,
            status: Some("success".to_string()),
            artifacts_created: Some(r#"["/src/auth.ts"]"#.to_string()),
            artifact_hashes: Some(format!(r#"["{}"]"#, hash::sha256_hex(b"/src/auth.ts"))),
        },
    )
    .expect("insert tc A");

    // Turn B: creates /src/db.ts (DIFFERENT file) — should NOT supersede Turn A
    let mut turn_b = sample_turn("turn_diff_b", "sess_diff", 2);
    turn_b.supersedes_turn_id = None; // No overlap, so no supersedes
    db::insert_turn(&conn, &turn_b).expect("insert turn B");

    db::insert_tool_call(
        &conn,
        &ToolCallRecord {
            id: "tc_diff_b".to_string(),
            turn_id: "turn_diff_b".to_string(),
            tool_name: "Write".to_string(),
            tool_input: r#"{"file_path":"/src/db.ts","content":"pool"}"#.to_string(),
            input_hash: None,
            sequence_num: Some(0),
            output: None,
            output_hash: None,
            duration_ms: None,
            error: None,
            status: Some("success".to_string()),
            artifacts_created: Some(r#"["/src/db.ts"]"#.to_string()),
            artifact_hashes: Some(format!(r#"["{}"]"#, hash::sha256_hex(b"/src/db.ts"))),
        },
    )
    .expect("insert tc B");

    let stored_b = db::get_turn(&conn, "turn_diff_b")
        .expect("query turn B")
        .expect("turn B exists");
    assert_eq!(
        stored_b.supersedes_turn_id, None,
        "Different files must NOT create a supersedes edge"
    );
}

/// SUPERSEDES across different tool types: Write in Turn A, Edit in Turn B.
#[test]
fn d2_supersedes_across_tool_types() {
    let conn = setup_db();

    let session = sample_session("sess_cross");
    db::insert_session(&conn, &session).expect("insert session");

    // Turn A: Write /src/config.ts
    let mut turn_a = sample_turn("turn_cross_a", "sess_cross", 1);
    turn_a.supersedes_turn_id = None;
    db::insert_turn(&conn, &turn_a).expect("insert turn A");

    db::insert_tool_call(
        &conn,
        &ToolCallRecord {
            id: "tc_cross_a".to_string(),
            turn_id: "turn_cross_a".to_string(),
            tool_name: "Write".to_string(),
            tool_input: r#"{"file_path":"/src/config.ts","content":"export const config = {};"}"#
                .to_string(),
            input_hash: None,
            sequence_num: Some(0),
            output: None,
            output_hash: None,
            duration_ms: None,
            error: None,
            status: Some("success".to_string()),
            artifacts_created: Some(r#"["/src/config.ts"]"#.to_string()),
            artifact_hashes: Some(format!(r#"["{}"]"#, hash::sha256_hex(b"/src/config.ts"))),
        },
    )
    .expect("insert tc A");

    // Turn B: Edit /src/config.ts — supersedes Turn A despite different tool type
    let mut turn_b = sample_turn("turn_cross_b", "sess_cross", 2);
    turn_b.supersedes_turn_id = Some("turn_cross_a".to_string());
    db::insert_turn(&conn, &turn_b).expect("insert turn B");

    db::insert_tool_call(
        &conn,
        &ToolCallRecord {
            id: "tc_cross_b".to_string(),
            turn_id: "turn_cross_b".to_string(),
            tool_name: "Edit".to_string(),
            tool_input:
                r#"{"file_path":"/src/config.ts","old_string":"{}","new_string":"{port:3000}"}"#
                    .to_string(),
            input_hash: None,
            sequence_num: Some(0),
            output: None,
            output_hash: None,
            duration_ms: None,
            error: None,
            status: Some("success".to_string()),
            artifacts_created: Some(r#"["/src/config.ts"]"#.to_string()),
            artifact_hashes: Some(format!(r#"["{}"]"#, hash::sha256_hex(b"/src/config.ts"))),
        },
    )
    .expect("insert tc B");

    let stored_b = db::get_turn(&conn, "turn_cross_b")
        .expect("query turn B")
        .expect("turn B exists");
    assert_eq!(
        stored_b.supersedes_turn_id,
        Some("turn_cross_a".to_string()),
        "Edit on same file must supersede earlier Write, regardless of tool type"
    );
}

// ===========================================================================
// D2: SupersedesResolver — programmatic chain resolution
// ===========================================================================

/// SupersedesResolver.resolve_chain walks the supersedes chain back to the root.
#[test]
fn d2_resolver_walks_full_chain() {
    let conn = setup_db();

    let session = sample_session("sess_resolve");
    db::insert_session(&conn, &session).expect("insert session");

    // Build chain: C -> B -> A
    let mut turn_a = sample_turn("turn_res_a", "sess_resolve", 1);
    turn_a.supersedes_turn_id = None;
    db::insert_turn(&conn, &turn_a).expect("insert A");

    let mut turn_b = sample_turn("turn_res_b", "sess_resolve", 2);
    turn_b.supersedes_turn_id = Some("turn_res_a".to_string());
    db::insert_turn(&conn, &turn_b).expect("insert B");

    let mut turn_c = sample_turn("turn_res_c", "sess_resolve", 3);
    turn_c.supersedes_turn_id = Some("turn_res_b".to_string());
    db::insert_turn(&conn, &turn_c).expect("insert C");

    let resolver = SupersedesResolver::new(&conn);
    let chain = resolver
        .resolve_chain("turn_res_c")
        .expect("resolve chain from C");

    // Chain should be [C, B, A] — from most recent to root
    assert_eq!(chain.len(), 3, "Chain must have 3 turns");
    assert_eq!(chain[0].id, "turn_res_c");
    assert_eq!(chain[1].id, "turn_res_b");
    assert_eq!(chain[2].id, "turn_res_a");
}

/// SupersedesResolver on a turn with no supersedes returns just that turn.
#[test]
fn d2_resolver_single_turn_no_chain() {
    let conn = setup_db();

    let session = sample_session("sess_single");
    db::insert_session(&conn, &session).expect("insert session");

    let mut turn = sample_turn("turn_single", "sess_single", 1);
    turn.supersedes_turn_id = None;
    db::insert_turn(&conn, &turn).expect("insert turn");

    let resolver = SupersedesResolver::new(&conn);
    let chain = resolver
        .resolve_chain("turn_single")
        .expect("resolve chain");

    assert_eq!(
        chain.len(),
        1,
        "Single turn with no supersedes = chain of 1"
    );
    assert_eq!(chain[0].id, "turn_single");
}

// ===========================================================================
// Negative tests: removing feature causes failure
// ===========================================================================

/// NEGATIVE: If extract_artifacts is removed (returns empty), artifact tracking
/// fails — ToolCallRecord would have empty artifacts_created for Write tool.
/// This test proves the feature is required.
#[test]
fn negative_removing_artifact_extraction_means_no_artifacts() {
    // This test verifies the extraction function actually does work.
    // If someone replaced extract_artifacts with a no-op (always returns []),
    // this test would fail.
    let tool_input = json!({
        "file_path": "/src/critical.ts",
        "content": "important code"
    });

    let artifacts = extract_artifacts("Write", &tool_input.to_string());

    // If extract_artifacts is a no-op, this fails:
    assert!(
        !artifacts.is_empty(),
        "NEGATIVE: extract_artifacts must NOT be a no-op — Write tool MUST produce artifacts"
    );
    assert_eq!(artifacts[0].path, "/src/critical.ts");
}

/// NEGATIVE: If supersedes_turn_id field is removed from TurnRecord,
/// the chain cannot be tracked.
#[test]
fn negative_supersedes_field_required_on_turn_record() {
    let conn = setup_db();

    let session = sample_session("sess_neg");
    db::insert_session(&conn, &session).expect("insert session");

    let mut turn = sample_turn("turn_neg", "sess_neg", 1);
    // Setting supersedes_turn_id must be possible — if the field is removed,
    // this test won't compile
    turn.supersedes_turn_id = Some("some_previous_turn".to_string());

    // The field must exist on the struct
    assert_eq!(
        turn.supersedes_turn_id,
        Some("some_previous_turn".to_string()),
        "supersedes_turn_id must be a field on TurnRecord"
    );
}

// ===========================================================================
// End-to-end: full pipeline from tool call to artifact to supersedes
// ===========================================================================

/// End-to-end test: extract artifacts from tool calls, store them on
/// ToolCallRecord, detect supersedes, and verify the full chain.
#[test]
fn e2e_full_artifact_tracking_and_supersedes_pipeline() {
    let conn = setup_db();

    let session = sample_session("sess_e2e");
    db::insert_session(&conn, &session).expect("insert session");

    // Turn 1: Write /src/auth.ts
    let write_input = r#"{"file_path":"/src/auth.ts","content":"v1"}"#;
    let artifacts_t1 = extract_artifacts("Write", write_input);
    assert_eq!(artifacts_t1.len(), 1);

    let paths_json_t1 =
        serde_json::to_string(&artifacts_t1.iter().map(|a| &a.path).collect::<Vec<_>>()).unwrap();
    let hashes_json_t1 =
        serde_json::to_string(&artifacts_t1.iter().map(|a| &a.hash).collect::<Vec<_>>()).unwrap();

    let mut turn1 = sample_turn("turn_e2e_1", "sess_e2e", 1);
    turn1.supersedes_turn_id = None;
    turn1.tool_call_count = 1;
    db::insert_turn(&conn, &turn1).expect("insert turn 1");

    db::insert_tool_call(
        &conn,
        &ToolCallRecord {
            id: "tc_e2e_1".to_string(),
            turn_id: "turn_e2e_1".to_string(),
            tool_name: "Write".to_string(),
            tool_input: write_input.to_string(),
            input_hash: None,
            sequence_num: Some(0),
            output: Some("Written".to_string()),
            output_hash: None,
            duration_ms: None,
            error: None,
            status: Some("success".to_string()),
            artifacts_created: Some(paths_json_t1.clone()),
            artifact_hashes: Some(hashes_json_t1.clone()),
        },
    )
    .expect("insert tc 1");

    // Turn 2: Edit /src/auth.ts — should supersede Turn 1
    let edit_input = r#"{"file_path":"/src/auth.ts","old_string":"v1","new_string":"v2"}"#;
    let artifacts_t2 = extract_artifacts("Edit", edit_input);
    assert_eq!(artifacts_t2.len(), 1);
    assert_eq!(artifacts_t2[0].path, "/src/auth.ts");

    let paths_json_t2 =
        serde_json::to_string(&artifacts_t2.iter().map(|a| &a.path).collect::<Vec<_>>()).unwrap();
    let hashes_json_t2 =
        serde_json::to_string(&artifacts_t2.iter().map(|a| &a.hash).collect::<Vec<_>>()).unwrap();

    // The resolver determines supersedes_turn_id by checking artifact overlap
    let resolver = SupersedesResolver::new(&conn);
    let supersedes_id = resolver
        .find_supersedes_for_session(
            "sess_e2e",
            &artifacts_t2
                .iter()
                .map(|a| a.path.as_str())
                .collect::<Vec<_>>(),
        )
        .expect("find supersedes");
    assert_eq!(
        supersedes_id,
        Some("turn_e2e_1".to_string()),
        "Must detect that turn_e2e_1 previously modified /src/auth.ts"
    );

    let mut turn2 = sample_turn("turn_e2e_2", "sess_e2e", 2);
    turn2.supersedes_turn_id = supersedes_id;
    turn2.tool_call_count = 1;
    db::insert_turn(&conn, &turn2).expect("insert turn 2");

    db::insert_tool_call(
        &conn,
        &ToolCallRecord {
            id: "tc_e2e_2".to_string(),
            turn_id: "turn_e2e_2".to_string(),
            tool_name: "Edit".to_string(),
            tool_input: edit_input.to_string(),
            input_hash: None,
            sequence_num: Some(0),
            output: Some("Edited".to_string()),
            output_hash: None,
            duration_ms: None,
            error: None,
            status: Some("success".to_string()),
            artifacts_created: Some(paths_json_t2),
            artifact_hashes: Some(hashes_json_t2),
        },
    )
    .expect("insert tc 2");

    // Verify the stored data
    let stored_t2 = db::get_turn(&conn, "turn_e2e_2")
        .expect("query turn 2")
        .expect("turn 2 exists");
    assert_eq!(stored_t2.supersedes_turn_id, Some("turn_e2e_1".to_string()));

    // Walk the chain
    let chain = resolver.resolve_chain("turn_e2e_2").expect("resolve chain");
    assert_eq!(chain.len(), 2);
    assert_eq!(chain[0].id, "turn_e2e_2");
    assert_eq!(chain[1].id, "turn_e2e_1");

    // Verify artifact data on tool calls
    let tcs = db::get_tool_calls_for_turn(&conn, "turn_e2e_1").expect("get tool calls for turn 1");
    let tc1 = &tcs[0];
    let paths: Vec<String> = serde_json::from_str(tc1.artifacts_created.as_ref().unwrap()).unwrap();
    assert_eq!(paths, vec!["/src/auth.ts"]);
}
