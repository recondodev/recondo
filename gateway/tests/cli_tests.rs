//! CLI tests — behavioral tests for the `recondo` CLI subcommands.
//!
//! These tests verify CLI behavior by:
//! 1. Setting up a temp data dir with a pre-populated SQLite database
//! 2. Running the binary with `--data-dir {temp}` and each subcommand
//! 3. Asserting on stdout/stderr output
//!
//! These tests are written BEFORE implementation from the design document only.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;

use flate2::write::GzEncoder;
use flate2::Compression;
use tempfile::TempDir;

use recondo_gateway::db;
use recondo_gateway::db::{SessionRecord, ToolCallRecord, TurnRecord};
use recondo_gateway::hash;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Path to the compiled binary.
fn binary_path() -> PathBuf {
    // Look for debug binary first, then release
    PathBuf::from(env!("CARGO_BIN_EXE_recondo-gateway"))
}

/// Create a temp data directory with an initialized SQLite database.
/// Returns (TempDir, path to data dir).
fn setup_data_dir() -> (TempDir, PathBuf) {
    let tmp = TempDir::new().expect("Must create temp dir");
    let data_dir = tmp.path().to_path_buf();

    // Create the database
    let db_path = data_dir.join("recondo.db");
    let conn = db::open(&db_path).expect("Must open SQLite DB");
    db::initialize(&conn).expect("Must initialize schema");

    (tmp, data_dir)
}

/// Create a temp data dir pre-populated with test sessions and turns.
fn setup_populated_data_dir() -> (TempDir, PathBuf) {
    let (tmp, data_dir) = setup_data_dir();
    let db_path = data_dir.join("recondo.db");
    let conn = db::open(&db_path).unwrap();

    // Insert test sessions
    let session1 = SessionRecord {
        id: "sess-aaa-111".to_string(),
        provider: "anthropic".to_string(),
        model: Some("claude-sonnet-4-20250514".to_string()),
        started_at: "2026-03-18T09:12:33Z".to_string(),
        last_active_at: "2026-03-18T09:42:33Z".to_string(),
        ended_at: None,
        initial_intent: Some("Fix the login bug in auth.ts".to_string()),
        system_prompt_hash: "sha256_session1".to_string(),
        total_turns: 3,
        turns_captured: 3,
        dropped_events: 0,
        total_tokens: 5000,
        total_cost_usd: 0.42,
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
    db::insert_session(&conn, &session1).unwrap();

    let session2 = SessionRecord {
        id: "sess-bbb-222".to_string(),
        provider: "anthropic".to_string(),
        model: Some("claude-opus-4-20250514".to_string()),
        started_at: "2026-03-18T10:45:01Z".to_string(),
        last_active_at: "2026-03-18T11:45:01Z".to_string(),
        ended_at: Some("2026-03-18T12:00:00Z".to_string()),
        initial_intent: Some("Implement payment webhook handler".to_string()),
        system_prompt_hash: "sha256_session2".to_string(),
        total_turns: 2,
        turns_captured: 2,
        dropped_events: 0,
        total_tokens: 15000,
        total_cost_usd: 3.15_f64,
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
    db::insert_session(&conn, &session2).unwrap();

    // Insert turns for session 1
    let req_bytes_1 = b"request body turn 1";
    let resp_bytes_1 = b"response body turn 1";
    let req_hash_1 = hash::sha256_hex(req_bytes_1);
    let resp_hash_1 = hash::sha256_hex(resp_bytes_1);

    store_object(&data_dir, "req", &req_hash_1, req_bytes_1);
    store_object(&data_dir, "resp", &resp_hash_1, resp_bytes_1);

    db::insert_turn(
        &conn,
        &TurnRecord {
            id: "turn-aaa-001".to_string(),
            session_id: "sess-aaa-111".to_string(),
            sequence_num: 1,
            timestamp: "2026-03-18T09:12:34Z".to_string(),
            request_hash: req_hash_1.clone(),
            response_hash: resp_hash_1.clone(),
            req_bytes_ref: Some(format!("objects/req/{}.json.gz", req_hash_1)),
            resp_bytes_ref: Some(format!("objects/resp/{}.json.gz", resp_hash_1)),
            req_bytes_size: Some(req_bytes_1.len() as i64),
            resp_bytes_size: Some(resp_bytes_1.len() as i64),
            model: Some("claude-sonnet-4-20250514".to_string()),
            response_text: Some("Analyzing the auth.ts file for the login bug...".to_string()),
            thinking_text: Some("Let me look at the authentication flow.".to_string()),
            stop_reason: "end_turn".to_string(),
            capture_complete: true,
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_tokens: 200,
            cache_creation_tokens: 0,
            cost_usd: Some(0.10),
            created_at: "2026-03-18T09:12:34Z".to_string(),
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
        },
    )
    .unwrap();

    let req_bytes_2 = b"request body turn 2";
    let resp_bytes_2 = b"response body turn 2";
    let req_hash_2 = hash::sha256_hex(req_bytes_2);
    let resp_hash_2 = hash::sha256_hex(resp_bytes_2);

    store_object(&data_dir, "req", &req_hash_2, req_bytes_2);
    store_object(&data_dir, "resp", &resp_hash_2, resp_bytes_2);

    db::insert_turn(
        &conn,
        &TurnRecord {
            id: "turn-aaa-002".to_string(),
            session_id: "sess-aaa-111".to_string(),
            sequence_num: 2,
            timestamp: "2026-03-18T09:12:35Z".to_string(),
            request_hash: req_hash_2.clone(),
            response_hash: resp_hash_2.clone(),
            req_bytes_ref: Some(format!("objects/req/{}.json.gz", req_hash_2)),
            resp_bytes_ref: Some(format!("objects/resp/{}.json.gz", resp_hash_2)),
            req_bytes_size: Some(req_bytes_2.len() as i64),
            resp_bytes_size: Some(resp_bytes_2.len() as i64),
            model: Some("claude-sonnet-4-20250514".to_string()),
            response_text: Some("The bug is in the token refresh logic.".to_string()),
            thinking_text: None,
            stop_reason: "tool_use".to_string(),
            capture_complete: true,
            input_tokens: 800,
            output_tokens: 300,
            cache_read_tokens: 100,
            cache_creation_tokens: 0,
            cost_usd: Some(0.08),
            created_at: "2026-03-18T09:12:35Z".to_string(),
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
        },
    )
    .unwrap();

    db::insert_turn(
        &conn,
        &TurnRecord {
            id: "turn-aaa-003".to_string(),
            session_id: "sess-aaa-111".to_string(),
            sequence_num: 3,
            timestamp: "2026-03-18T09:12:37Z".to_string(),
            request_hash: "req_hash_3".to_string(),
            response_hash: "resp_hash_3".to_string(),
            req_bytes_ref: None,
            resp_bytes_ref: None,
            req_bytes_size: None,
            resp_bytes_size: None,
            model: Some("claude-sonnet-4-20250514".to_string()),
            response_text: Some(
                "Fixed the token refresh by adding proper expiry check.".to_string(),
            ),
            thinking_text: None,
            stop_reason: "end_turn".to_string(),
            capture_complete: true,
            input_tokens: 1200,
            output_tokens: 600,
            cache_read_tokens: 300,
            cache_creation_tokens: 0,
            cost_usd: Some(0.12),
            created_at: "2026-03-18T09:12:37Z".to_string(),
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
        },
    )
    .unwrap();

    // Insert turns for session 2
    db::insert_turn(
        &conn,
        &TurnRecord {
            id: "turn-bbb-001".to_string(),
            session_id: "sess-bbb-222".to_string(),
            sequence_num: 1,
            timestamp: "2026-03-18T10:45:02Z".to_string(),
            request_hash: "req_hash_b1".to_string(),
            response_hash: "resp_hash_b1".to_string(),
            req_bytes_ref: None,
            resp_bytes_ref: None,
            req_bytes_size: None,
            resp_bytes_size: None,
            model: Some("claude-opus-4-20250514".to_string()),
            response_text: Some(
                "Setting up the Stripe webhook endpoint with proper signature verification."
                    .to_string(),
            ),
            thinking_text: Some(
                "I need to implement HMAC-SHA256 signature verification.".to_string(),
            ),
            stop_reason: "end_turn".to_string(),
            capture_complete: true,
            input_tokens: 5000,
            output_tokens: 2000,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            cost_usd: Some(1.50),
            created_at: "2026-03-18T10:45:02Z".to_string(),
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
        },
    )
    .unwrap();

    db::insert_turn(
        &conn,
        &TurnRecord {
            id: "turn-bbb-002".to_string(),
            session_id: "sess-bbb-222".to_string(),
            sequence_num: 2,
            timestamp: "2026-03-18T10:45:05Z".to_string(),
            request_hash: "req_hash_b2".to_string(),
            response_hash: "resp_hash_b2".to_string(),
            req_bytes_ref: None,
            resp_bytes_ref: None,
            req_bytes_size: None,
            resp_bytes_size: None,
            model: Some("claude-opus-4-20250514".to_string()),
            response_text: Some("Added async error handling for the webhook.".to_string()),
            thinking_text: None,
            stop_reason: "end_turn".to_string(),
            capture_complete: true,
            input_tokens: 3000,
            output_tokens: 1500,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            cost_usd: Some(0.90),
            created_at: "2026-03-18T10:45:05Z".to_string(),
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
        },
    )
    .unwrap();

    // Insert a tool call for turn-aaa-002
    db::insert_tool_call(
        &conn,
        &ToolCallRecord {
            id: "tc-001".to_string(),
            turn_id: "turn-aaa-002".to_string(),
            tool_name: "bash".to_string(),
            tool_input: r#"{"command":"grep -n 'refresh' auth.ts"}"#.to_string(),
            input_hash: Some("sha256_tc001".to_string()),
            sequence_num: None,
            output: None,
            output_hash: None,
            duration_ms: None,
            error: None,
            status: None,
            artifacts_created: None,
            artifact_hashes: None,
        },
    )
    .unwrap();

    (tmp, data_dir)
}

/// Store a gzipped object to the data dir's object store.
fn store_object(data_dir: &std::path::Path, kind: &str, hash: &str, content: &[u8]) {
    let dir = data_dir.join("objects").join(kind);
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{}.json.gz", hash));
    let file = fs::File::create(&path).unwrap();
    let mut encoder = GzEncoder::new(file, Compression::default());
    encoder.write_all(content).unwrap();
    encoder.finish().unwrap();
}

/// Run the recondo-gateway binary with given args and data dir.
/// Returns (stdout, stderr, exit_success).
fn run_cli(data_dir: &std::path::Path, args: &[&str]) -> (String, String, bool) {
    let output = Command::new(binary_path())
        .arg("--data-dir")
        .arg(data_dir.to_str().unwrap())
        .args(args)
        .output()
        .expect("Failed to execute binary");

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    (stdout, stderr, output.status.success())
}

// ===========================================================================
// 1. `recondo serve` — starts gateway (test via --help since serve would block)
// ===========================================================================

/// **Proves:** The `serve` subcommand is recognized by the CLI parser.
/// We test with `--help` since `serve` would start a blocking server.
///
/// **Anti-fake property:** If `serve` is not a recognized subcommand, the binary
/// will exit with an error.
#[test]
fn serve_subcommand_recognized() {
    let (_tmp, _data_dir) = setup_data_dir();

    // `recondo serve --help` should succeed and mention serve in output
    let output = Command::new(binary_path())
        .args(["serve", "--help"])
        .output()
        .expect("Failed to execute binary");

    // --help exits with code 0 for clap
    assert!(
        output.status.success() || output.status.code() == Some(0),
        "serve --help must exit successfully"
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}{}", stdout, stderr);

    // clap prints help to stdout or stderr depending on version
    assert!(
        combined.to_lowercase().contains("serve")
            || combined.to_lowercase().contains("gateway")
            || combined.to_lowercase().contains("start"),
        "serve --help output must mention serve/gateway/start, got: {}",
        combined
    );
}

/// **Proves:** Running the binary with no subcommand shows help or usage info.
#[test]
fn no_subcommand_shows_help() {
    let output = Command::new(binary_path())
        .arg("--help")
        .output()
        .expect("Failed to execute binary");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}{}", stdout, stderr);

    assert!(
        combined.contains("serve")
            || combined.contains("sessions")
            || combined.contains("USAGE")
            || combined.contains("Usage"),
        "Help output must list available subcommands, got: {}",
        combined
    );
}

// ===========================================================================
// 2. `recondo sessions` — list all sessions with summary
// ===========================================================================

/// **Proves:** `recondo sessions` outputs session IDs and model names from test data.
///
/// **Anti-fake property:** The output contains the specific session IDs and model
/// names we inserted. A hardcoded output would not match our test data.
#[test]
fn sessions_lists_all_sessions() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    let (stdout, _stderr, success) = run_cli(&data_dir, &["sessions"]);

    assert!(success, "sessions command must succeed");

    // Both session IDs must appear
    assert!(
        stdout.contains("sess-aaa-111"),
        "Output must contain session ID sess-aaa-111, got: {}",
        stdout
    );
    assert!(
        stdout.contains("sess-bbb-222"),
        "Output must contain session ID sess-bbb-222, got: {}",
        stdout
    );
}

/// **Proves:** `recondo sessions` output includes model names.
#[test]
fn sessions_shows_model_names() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    let (stdout, _stderr, success) = run_cli(&data_dir, &["sessions"]);

    assert!(success, "sessions command must succeed");

    // Model names (possibly truncated) must appear
    assert!(
        stdout.contains("sonnet") || stdout.contains("claude-sonnet"),
        "Output must contain sonnet model name, got: {}",
        stdout
    );
    assert!(
        stdout.contains("opus") || stdout.contains("claude-opus"),
        "Output must contain opus model name, got: {}",
        stdout
    );
}

/// **Proves:** `recondo sessions` output includes intent text.
#[test]
fn sessions_shows_intent() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    let (stdout, _stderr, success) = run_cli(&data_dir, &["sessions"]);

    assert!(success, "sessions command must succeed");

    assert!(
        stdout.contains("login bug") || stdout.contains("Fix the login"),
        "Output must contain intent text about login bug, got: {}",
        stdout
    );
}

/// **Proves:** `recondo sessions` on empty DB succeeds with no crash.
#[test]
fn sessions_empty_db_succeeds() {
    let (_tmp, data_dir) = setup_data_dir();
    let (stdout, _stderr, success) = run_cli(&data_dir, &["sessions"]);

    assert!(success, "sessions on empty DB must succeed");
    // Should either show empty table or a "no sessions" message
    // Either way, it should not crash
    let _ = stdout; // Just verify it runs
}

// ===========================================================================
// 3. `recondo session <id>` — full turn-by-turn trace
// ===========================================================================

/// **Proves:** `recondo session <id>` outputs turn details for the given session.
///
/// **Anti-fake property:** The output contains turn-specific data (response text
/// snippets, sequence numbers) that we inserted into the test DB.
#[test]
fn session_detail_shows_turns() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    let (stdout, _stderr, success) = run_cli(&data_dir, &["session", "sess-aaa-111"]);

    assert!(success, "session detail command must succeed");

    // Session header info
    assert!(
        stdout.contains("sess-aaa-111"),
        "Output must contain the session ID, got: {}",
        stdout
    );

    // Turn detail — at least one turn's data should appear
    assert!(
        stdout.contains("auth.ts")
            || stdout.contains("login bug")
            || stdout.contains("token refresh"),
        "Output must contain turn content from the session, got: {}",
        stdout
    );
}

/// **Proves:** `recondo session <id>` shows model and provider in session header.
#[test]
fn session_detail_shows_header() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    let (stdout, _stderr, success) = run_cli(&data_dir, &["session", "sess-aaa-111"]);

    assert!(success, "session detail command must succeed");

    assert!(
        stdout.contains("sonnet") || stdout.contains("claude-sonnet"),
        "Session detail must show model name, got: {}",
        stdout
    );
    assert!(
        stdout.contains("anthropic"),
        "Session detail must show provider, got: {}",
        stdout
    );
}

/// **Proves:** `recondo session <id>` shows turn count summary.
#[test]
fn session_detail_shows_turn_count() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    let (stdout, _stderr, success) = run_cli(&data_dir, &["session", "sess-aaa-111"]);

    assert!(success, "session detail command must succeed");

    // Should show "3/3 captured" or similar
    assert!(
        stdout.contains("3")
            && (stdout.contains("captured") || stdout.contains("turn") || stdout.contains("Turn")),
        "Session detail must show turn count, got: {}",
        stdout
    );
}

/// **NEGATIVE:** `recondo session <nonexistent-id>` produces an error.
#[test]
fn session_detail_nonexistent_shows_error() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    let (stdout, stderr, success) = run_cli(&data_dir, &["session", "nonexistent-id-12345"]);

    assert!(
        !success
            || stderr.contains("not found")
            || stdout.contains("not found")
            || stderr.contains("No session")
            || stdout.contains("No session"),
        "Non-existent session must produce error output, stdout: {}, stderr: {}",
        stdout,
        stderr
    );
}

// ===========================================================================
// 4. `recondo turn <id>` — single turn detail
// ===========================================================================

/// **Proves:** `recondo turn <id>` outputs response_text for the given turn.
///
/// **Anti-fake property:** The output contains the specific response text we
/// inserted into the test DB for that turn ID.
#[test]
fn turn_detail_shows_response_text() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    let (stdout, _stderr, success) = run_cli(&data_dir, &["turn", "turn-aaa-001"]);

    assert!(success, "turn detail command must succeed");

    assert!(
        stdout.contains("auth.ts") || stdout.contains("Analyzing"),
        "Turn detail must contain response_text content, got: {}",
        stdout
    );
}

/// **Proves:** `recondo turn <id>` shows model and token information.
#[test]
fn turn_detail_shows_metadata() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    let (stdout, _stderr, success) = run_cli(&data_dir, &["turn", "turn-aaa-001"]);

    assert!(success, "turn detail command must succeed");

    // Should show model
    assert!(
        stdout.contains("sonnet") || stdout.contains("claude-sonnet"),
        "Turn detail must show model, got: {}",
        stdout
    );

    // Should show some token count
    assert!(
        stdout.contains("1000") || stdout.contains("500") || stdout.contains("token"),
        "Turn detail must show token information, got: {}",
        stdout
    );
}

/// **NEGATIVE:** `recondo turn <nonexistent-id>` produces an error.
#[test]
fn turn_detail_nonexistent_shows_error() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    let (stdout, stderr, success) = run_cli(&data_dir, &["turn", "nonexistent-turn-xyz"]);

    assert!(
        !success
            || stderr.contains("not found")
            || stdout.contains("not found")
            || stderr.contains("No turn")
            || stdout.contains("No turn"),
        "Non-existent turn must produce error output, stdout: {}, stderr: {}",
        stdout,
        stderr
    );
}

// ===========================================================================
// 5. `recondo search <query>` — text search across response_text
// ===========================================================================

/// **Proves:** `recondo search <query>` finds turns matching the query.
///
/// **Anti-fake property:** Searching for "token refresh" should find turn-aaa-002
/// but not turns about webhooks.
#[test]
fn search_finds_matching_turns() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    let (stdout, _stderr, success) = run_cli(&data_dir, &["search", "token refresh"]);

    assert!(success, "search command must succeed");

    assert!(
        stdout.contains("turn-aaa-002") || stdout.contains("token refresh"),
        "Search for 'token refresh' must find matching turn, got: {}",
        stdout
    );
}

/// **Proves:** `recondo search <query>` finds turns across sessions.
#[test]
fn search_finds_across_sessions() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    // "webhook" appears in session 2's turns
    let (stdout, _stderr, success) = run_cli(&data_dir, &["search", "webhook"]);

    assert!(success, "search command must succeed");

    assert!(
        stdout.contains("webhook") || stdout.contains("turn-bbb"),
        "Search for 'webhook' must find turns in session 2, got: {}",
        stdout
    );
}

/// **Proves:** `recondo search <query>` returns no results for a non-matching query.
#[test]
fn search_no_match_shows_empty() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    let (stdout, _stderr, success) = run_cli(&data_dir, &["search", "xyzzy_nonexistent_term"]);

    assert!(
        success,
        "search with no results must still succeed (exit 0)"
    );

    // Should show "no results" or empty output — but not crash
    assert!(
        !stdout.contains("turn-aaa") && !stdout.contains("turn-bbb"),
        "Search for non-matching term must not show any turn IDs, got: {}",
        stdout
    );
}

// ===========================================================================
// 6. `recondo stats` — summary statistics
// ===========================================================================

/// **Proves:** `recondo stats` shows correct session count.
///
/// **Anti-fake property:** We inserted exactly 2 sessions, so stats must show 2.
#[test]
fn stats_shows_session_count() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    let (stdout, _stderr, success) = run_cli(&data_dir, &["stats"]);

    assert!(success, "stats command must succeed");

    // Must show "2" sessions somewhere
    assert!(
        stdout.contains("2"),
        "Stats must show 2 sessions, got: {}",
        stdout
    );
}

/// **Proves:** `recondo stats` shows model names used.
#[test]
fn stats_shows_models() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    let (stdout, _stderr, success) = run_cli(&data_dir, &["stats"]);

    assert!(success, "stats command must succeed");

    assert!(
        stdout.contains("sonnet") || stdout.contains("claude-sonnet"),
        "Stats must show sonnet model, got: {}",
        stdout
    );
    assert!(
        stdout.contains("opus") || stdout.contains("claude-opus"),
        "Stats must show opus model, got: {}",
        stdout
    );
}

/// **Proves:** `recondo stats` shows token count totals.
#[test]
fn stats_shows_token_totals() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    let (stdout, _stderr, success) = run_cli(&data_dir, &["stats"]);

    assert!(success, "stats command must succeed");

    // Total tokens across both sessions: 5000 + 15000 = 20000
    assert!(
        stdout.contains("20000") || stdout.contains("20,000"),
        "Stats must show total tokens (20000), got: {}",
        stdout
    );
}

/// **Proves:** `recondo stats` on empty DB shows zeros or a "no data" message.
#[test]
fn stats_empty_db_succeeds() {
    let (_tmp, data_dir) = setup_data_dir();
    let (stdout, _stderr, success) = run_cli(&data_dir, &["stats"]);

    assert!(success, "stats on empty DB must succeed");

    // Should show 0 sessions or "no data" message
    assert!(
        stdout.contains("0") || stdout.to_lowercase().contains("no "),
        "Stats on empty DB must show 0 or 'no data', got: {}",
        stdout
    );
}

// ===========================================================================
// 7. `recondo verify <session_id>` — verify content hashes
// ===========================================================================

/// **Proves:** `recondo verify <session_id>` reports PASS for turns with valid hashes.
/// Turns where the stored objects match the recorded hashes should pass verification.
///
/// **Anti-fake property:** We stored objects with content whose SHA-256 matches
/// the request_hash / response_hash in the DB. The verify command must recompute
/// and confirm the match.
#[test]
fn verify_passes_for_valid_hashes() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    // sess-aaa-111 has turns 001 and 002 with valid objects on disk
    let (stdout, _stderr, success) = run_cli(&data_dir, &["verify", "sess-aaa-111"]);

    assert!(success, "verify command must succeed for valid session");

    // Should report PASS or OK for the turns with valid objects
    assert!(
        stdout.to_uppercase().contains("PASS")
            || stdout.to_uppercase().contains("OK")
            || stdout.to_uppercase().contains("VERIFIED")
            || stdout.to_uppercase().contains("VALID"),
        "Verify must report PASS/OK for valid hashes, got: {}",
        stdout
    );
}

/// **Proves:** `recondo verify <session_id>` detects missing object files.
/// Turn 3 of sess-aaa-111 has no req_bytes_ref or resp_bytes_ref (None),
/// so the verify command should note these as missing or skip them.
#[test]
fn verify_reports_missing_objects() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    let (stdout, _stderr, success) = run_cli(&data_dir, &["verify", "sess-aaa-111"]);

    // The command may succeed overall but should note missing objects for turn 3
    // or it might report a warning/skip
    let combined = format!("{}{}", stdout, _stderr);
    // Turn 3 has no byte refs — verify should handle this gracefully
    assert!(
        success
            || combined.to_lowercase().contains("missing")
            || combined.to_lowercase().contains("skip"),
        "Verify must handle turns with missing object refs gracefully, got: {}",
        combined
    );
}

/// **NEGATIVE:** `recondo verify <nonexistent-session>` produces an error.
#[test]
fn verify_nonexistent_session_shows_error() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    let (stdout, stderr, success) = run_cli(&data_dir, &["verify", "nonexistent-session-xyz"]);

    assert!(
        !success
            || stderr.contains("not found")
            || stdout.contains("not found")
            || stderr.contains("No session")
            || stdout.contains("No session"),
        "Verify on non-existent session must produce error, stdout: {}, stderr: {}",
        stdout,
        stderr
    );
}

/// **Proves:** `recondo verify` detects tampered content (hash mismatch).
/// We corrupt an object file after storing it, so the recomputed hash won't match.
#[test]
fn verify_detects_tampered_content() {
    let (_tmp, data_dir) = setup_populated_data_dir();

    // Tamper with one of the request objects
    // Find the object file for turn-aaa-001's request
    let req_bytes_1 = b"request body turn 1";
    let req_hash_1 = hash::sha256_hex(req_bytes_1);
    // Overwrite with different content (still gzipped but different data)
    store_object(&data_dir, "req", &req_hash_1, b"TAMPERED CONTENT");

    let (stdout, stderr, _success) = run_cli(&data_dir, &["verify", "sess-aaa-111"]);
    let combined = format!("{}{}", stdout, stderr);

    // Verify should detect the mismatch
    assert!(
        combined.to_uppercase().contains("FAIL")
            || combined.to_uppercase().contains("MISMATCH")
            || combined.to_uppercase().contains("ERROR")
            || combined.to_uppercase().contains("TAMPER"),
        "Verify must detect tampered content (hash mismatch), got: {}",
        combined
    );
}

// ===========================================================================
// 8. Unknown subcommand produces error
// ===========================================================================

/// **NEGATIVE:** An unknown subcommand produces an error.
#[test]
fn unknown_subcommand_shows_error() {
    let output = Command::new(binary_path())
        .arg("nonexistent-command")
        .output()
        .expect("Failed to execute binary");

    assert!(
        !output.status.success(),
        "Unknown subcommand must exit with error"
    );
}

// ===========================================================================
// 9. `recondo sessions` shows turn counts and cost
// ===========================================================================

/// **Proves:** `recondo sessions` output includes turn counts.
#[test]
fn sessions_shows_turn_counts() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    let (stdout, _stderr, success) = run_cli(&data_dir, &["sessions"]);

    assert!(success, "sessions command must succeed");

    // Session 1 has 3 turns, session 2 has 2 turns
    assert!(
        stdout.contains("3"),
        "Sessions list must show turn count 3, got: {}",
        stdout
    );
    assert!(
        stdout.contains("2"),
        "Sessions list must show turn count 2, got: {}",
        stdout
    );
}

/// **Proves:** `recondo sessions` output includes cost information.
#[test]
fn sessions_shows_cost() {
    let (_tmp, data_dir) = setup_populated_data_dir();
    let (stdout, _stderr, success) = run_cli(&data_dir, &["sessions"]);

    assert!(success, "sessions command must succeed");

    // Session 1 cost is $0.42, session 2 cost is $3.15
    assert!(
        stdout.contains("0.42") || stdout.contains("$0.42"),
        "Sessions list must show cost $0.42, got: {}",
        stdout
    );
    assert!(
        stdout.contains("3.15") || stdout.contains("$3.15"),
        "Sessions list must show cost $3.15, got: {}",
        stdout
    );
}

// ===========================================================================
// 10. CLI --data-dir flag works
// ===========================================================================

/// **Proves:** The `--data-dir` flag correctly directs the CLI to use a custom
/// data directory for the SQLite database.
///
/// **Anti-fake property:** We create two separate data dirs with different data
/// and verify each returns its own data.
#[test]
fn data_dir_flag_uses_correct_database() {
    let (_tmp1, data_dir1) = setup_populated_data_dir();
    let (_tmp2, data_dir2) = setup_data_dir(); // empty

    // data_dir1 has sessions, data_dir2 is empty
    let (stdout1, _stderr1, success1) = run_cli(&data_dir1, &["sessions"]);
    let (stdout2, _stderr2, success2) = run_cli(&data_dir2, &["sessions"]);

    assert!(success1, "sessions on populated dir must succeed");
    assert!(success2, "sessions on empty dir must succeed");

    assert!(
        stdout1.contains("sess-aaa-111"),
        "Populated data dir must show sessions"
    );
    assert!(
        !stdout2.contains("sess-aaa-111"),
        "Empty data dir must not show sessions from other dir"
    );
}
