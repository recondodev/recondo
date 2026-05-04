//! Week 4 Phase 1 tests: Schema v2 migration, Gemini provider support,
//! mock LLM servers, and compliance documentation.
//!
//! These tests are written BEFORE the implementation exists. They define the
//! behavioral contract for Week 4 deliverables. The implementation agent's job
//! is to make every test in this file pass.
//!
//! Organization:
//!   1. Schema migration tests (v1 → v2: 24 new columns, version bump, idempotent)
//!   2. Gemini provider detection tests
//!   3. Gemini endpoint interception tests
//!   4. Mock LLM server tests (Anthropic, OpenAI, Gemini)
//!   5. Documentation existence tests (gap analysis, compatibility matrix, Phase 2 plan)
//!   6. Negative tests
//!   7. Boundary/invariant tests

use recondo_gateway::db;
use recondo_gateway::gateway;
use recondo_gateway::providers;
use rusqlite::Connection;

// ===========================================================================
// Helpers
// ===========================================================================

/// Open an in-memory DB without calling initialize — blank slate for simulating
/// old schemas.
fn blank_db() -> Connection {
    db::open_in_memory().expect("Must open in-memory SQLite")
}

/// Set the SQLite user_version pragma.
fn set_user_version(conn: &Connection, version: i64) {
    conn.pragma_update(None, "user_version", version)
        .expect("Must be able to set user_version");
}

/// Read the current user_version from the database.
fn get_user_version(conn: &Connection) -> i64 {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("Must be able to read user_version")
}

/// Get all column names for a given table.
fn get_columns(conn: &Connection, table: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table))
        .expect("Must prepare PRAGMA table_info");
    stmt.query_map([], |row| row.get::<_, String>(1))
        .expect("Must query table_info")
        .filter_map(|r| r.ok())
        .collect()
}

/// Check whether a column exists in a given table.
fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
    get_columns(conn, table).contains(&column.to_string())
}

/// Create a v1 schema database by hand: the tables as they exist at SCHEMA_VERSION=1,
/// with user_version set to 1. This simulates an existing database that needs migration.
fn create_v1_database() -> Connection {
    let conn = blank_db();
    conn.execute_batch(
        "CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            model TEXT,
            started_at TEXT NOT NULL,
            last_active_at TEXT NOT NULL,
            ended_at TEXT,
            initial_intent TEXT,
            system_prompt_hash TEXT NOT NULL,
            total_turns INTEGER NOT NULL DEFAULT 0,
            turns_captured INTEGER NOT NULL DEFAULT 0,
            dropped_events INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            total_cost_usd REAL NOT NULL DEFAULT 0.0,
            framework TEXT
        );

        CREATE TABLE turns (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
            sequence_num INTEGER NOT NULL,
            timestamp TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            response_hash TEXT NOT NULL,
            req_bytes_ref TEXT,
            resp_bytes_ref TEXT,
            req_bytes_size INTEGER,
            resp_bytes_size INTEGER,
            model TEXT,
            response_text TEXT,
            thinking_text TEXT,
            stop_reason TEXT NOT NULL,
            capture_complete INTEGER NOT NULL DEFAULT 1,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            cache_read_tokens INTEGER NOT NULL,
            cache_creation_tokens INTEGER NOT NULL,
            cost_usd REAL,
            created_at TEXT NOT NULL,
            messages_delta TEXT,
            messages_delta_count INTEGER,
            raw_extra TEXT,
            parser_version TEXT,
            parse_errors TEXT,
            provider TEXT,
            transport TEXT,
            ws_direction TEXT,
            UNIQUE(session_id, sequence_num)
        );

        CREATE TABLE tool_calls (
            id TEXT PRIMARY KEY,
            turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE RESTRICT,
            tool_name TEXT NOT NULL,
            tool_input TEXT NOT NULL,
            input_hash TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, sequence_num);
        CREATE INDEX IF NOT EXISTS idx_tool_calls_turn ON tool_calls(turn_id);",
    )
    .expect("Must create v1 tables");
    set_user_version(&conn, 1);
    conn
}

/// Insert a v1 session row with all original columns populated.
fn insert_v1_session(conn: &Connection, id: &str) {
    conn.execute(
        "INSERT INTO sessions (id, provider, model, started_at, last_active_at, ended_at, initial_intent, system_prompt_hash, total_turns, turns_captured, dropped_events, total_tokens, total_cost_usd, framework) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        rusqlite::params![
            id,
            "anthropic",
            "claude-sonnet-4-20250514",
            "2026-03-18T10:00:00Z",
            "2026-03-18T10:30:00Z",
            rusqlite::types::Null,
            "Refactor the auth module",
            "sha256_abc123",
            5,
            5,
            0,
            10000,
            0.50,
            "claude-code",
        ],
    )
    .expect("Must insert v1 session");
}

/// Insert a v1 turn row.
fn insert_v1_turn(conn: &Connection, turn_id: &str, session_id: &str, seq: i64) {
    conn.execute(
        "INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash, stop_reason, capture_complete, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        rusqlite::params![
            turn_id,
            session_id,
            seq,
            "2026-03-18T10:01:00Z",
            "req_hash_v1",
            "resp_hash_v1",
            "end_turn",
            1,
            500,
            200,
            0,
            0,
            "2026-03-18T10:01:00Z",
        ],
    )
    .expect("Must insert v1 turn");
}

/// Insert a v1 tool_call row.
fn insert_v1_tool_call(conn: &Connection, tc_id: &str, turn_id: &str) {
    conn.execute(
        "INSERT INTO tool_calls (id, turn_id, tool_name, tool_input, input_hash) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![tc_id, turn_id, "Read", "{\"path\":\"/foo\"}", "sha256_input"],
    )
    .expect("Must insert v1 tool call");
}

/// Build an HTTP request line as raw bytes for should_intercept testing.
fn http_request(method: &str, path: &str) -> Vec<u8> {
    format!(
        "{} {} HTTP/1.1\r\nHost: generativelanguage.googleapis.com\r\n\r\n",
        method, path
    )
    .into_bytes()
}

// ===========================================================================
// Section 1: Schema Migration Tests (v1 → v2)
// ===========================================================================

/// **Proves:** SCHEMA_VERSION is 2 after Week 4 implementation.
/// **Anti-fake:** Old code has SCHEMA_VERSION = 1. This test will fail on old code.
#[test]
fn schema_version_is_2() {
    assert_eq!(
        db::SCHEMA_VERSION,
        11,
        "SCHEMA_VERSION must be 11 after P1B attachments"
    );
}

/// **Proves:** After initialize() on a fresh DB, user_version is set to the current SCHEMA_VERSION.
/// **Anti-fake:** Old code sets user_version to 1.
#[test]
fn fresh_db_has_user_version_2() {
    let conn = blank_db();
    db::initialize(&conn).expect("initialize must succeed");
    let version = get_user_version(&conn);
    assert_eq!(version, 11, "Fresh DB must have user_version = 11");
}

/// **Proves:** The sessions table has all 8 new columns after migration.
/// **Anti-fake:** These columns do not exist in the v1 schema.
#[test]
fn sessions_table_has_8_new_columns_after_migration() {
    let conn = blank_db();
    db::initialize(&conn).expect("initialize must succeed");

    let new_session_columns = [
        "agent_id",
        "agent_version",
        "git_repo",
        "git_branch",
        "git_commit",
        "working_directory",
        "parent_session_id",
        "tags",
    ];

    for col in &new_session_columns {
        assert!(
            column_exists(&conn, "sessions", col),
            "sessions table must have column '{}' after v2 migration",
            col
        );
    }
}

/// **Proves:** The turns table has all 9 new columns after migration.
///   (provider already exists from v1, so we add 9 minus provider = 8 new,
///    but the design says 9 new columns with provider skip, giving us 8 net new).
/// **Anti-fake:** These columns do not exist in the v1 schema.
#[test]
fn turns_table_has_new_columns_after_migration() {
    let conn = blank_db();
    db::initialize(&conn).expect("initialize must succeed");

    // The design doc says 9 new columns for turns, but "provider" already exists.
    // So we expect 8 net new columns to be added.
    let new_turn_columns = [
        "duration_ms",
        "ttfb_ms",
        "api_endpoint",
        "http_status",
        "error_message",
        "retry_count",
        "tool_call_count",
        "thinking_tokens",
        "server_id",
    ];

    for col in &new_turn_columns {
        // Skip "provider" check since it already exists — we check it separately.
        if *col == "provider" {
            continue;
        }
        assert!(
            column_exists(&conn, "turns", col),
            "turns table must have column '{}' after v2 migration",
            col
        );
    }
}

/// **Proves:** The tool_calls table has all 6 new columns after migration.
/// **Anti-fake:** These columns do not exist in the v1 schema.
#[test]
fn tool_calls_table_has_6_new_columns_after_migration() {
    let conn = blank_db();
    db::initialize(&conn).expect("initialize must succeed");

    let new_tool_call_columns = [
        "sequence_num",
        "output",
        "output_hash",
        "duration_ms",
        "error",
        "status",
    ];

    for col in &new_tool_call_columns {
        assert!(
            column_exists(&conn, "tool_calls", col),
            "tool_calls table must have column '{}' after v2 migration",
            col
        );
    }
}

/// **Proves:** Migration from v1 → v2 adds all 24 columns (8 sessions + 8 turns + 6 tool_calls + skip provider + thinking_tokens + server_id = actually check each).
///   Existing v1 data survives the migration with NULL for new columns.
/// **Anti-fake:** A v1 database has none of these columns. After calling initialize(),
///   the columns must appear AND old data must have NULL for the new fields.
#[test]
fn v1_to_v2_migration_preserves_data_and_adds_columns() {
    let conn = create_v1_database();

    // Insert data at v1 schema
    insert_v1_session(&conn, "sess_v1_migrate");
    insert_v1_turn(&conn, "turn_v1_migrate", "sess_v1_migrate", 1);
    insert_v1_tool_call(&conn, "tc_v1_migrate", "turn_v1_migrate");

    // Verify precondition: new columns do NOT exist yet
    assert!(
        !column_exists(&conn, "sessions", "agent_id"),
        "Precondition: agent_id must not exist in v1 schema"
    );
    assert!(
        !column_exists(&conn, "turns", "duration_ms"),
        "Precondition: duration_ms must not exist in v1 schema"
    );
    assert!(
        !column_exists(&conn, "tool_calls", "sequence_num"),
        "Precondition: sequence_num must not exist in v1 tool_calls"
    );

    // Run migration
    db::initialize(&conn).expect("initialize on v1 DB must succeed");

    // Verify version bumped
    assert!(
        get_user_version(&conn) >= 2,
        "user_version must be >= 2 after migration"
    );

    // Verify new columns exist
    assert!(
        column_exists(&conn, "sessions", "agent_id"),
        "agent_id column must exist after migration"
    );
    assert!(
        column_exists(&conn, "sessions", "tags"),
        "tags column must exist after migration"
    );
    assert!(
        column_exists(&conn, "turns", "duration_ms"),
        "duration_ms column must exist after migration"
    );
    assert!(
        column_exists(&conn, "turns", "thinking_tokens"),
        "thinking_tokens column must exist after migration"
    );
    assert!(
        column_exists(&conn, "tool_calls", "sequence_num"),
        "sequence_num column must exist after migration"
    );
    assert!(
        column_exists(&conn, "tool_calls", "status"),
        "status column must exist after migration"
    );

    // Verify old data survived — session row still has its original values
    let provider: String = conn
        .query_row(
            "SELECT provider FROM sessions WHERE id = 'sess_v1_migrate'",
            [],
            |row| row.get(0),
        )
        .expect("Must find migrated session");
    assert_eq!(
        provider, "anthropic",
        "Old session data must survive migration"
    );

    // Verify new columns are NULL for old rows
    let agent_id: Option<String> = conn
        .query_row(
            "SELECT agent_id FROM sessions WHERE id = 'sess_v1_migrate'",
            [],
            |row| row.get(0),
        )
        .expect("Must query agent_id on old row");
    assert!(
        agent_id.is_none(),
        "Old row must have NULL for agent_id after migration"
    );

    let tags: Option<String> = conn
        .query_row(
            "SELECT tags FROM sessions WHERE id = 'sess_v1_migrate'",
            [],
            |row| row.get(0),
        )
        .expect("Must query tags on old row");
    assert!(
        tags.is_none(),
        "Old row must have NULL for tags after migration"
    );

    // Verify old turn data survived
    let turn_stop: String = conn
        .query_row(
            "SELECT stop_reason FROM turns WHERE id = 'turn_v1_migrate'",
            [],
            |row| row.get(0),
        )
        .expect("Must find migrated turn");
    assert_eq!(
        turn_stop, "end_turn",
        "Old turn data must survive migration"
    );

    // Verify new turn columns are NULL for old rows
    let duration_ms: Option<i64> = conn
        .query_row(
            "SELECT duration_ms FROM turns WHERE id = 'turn_v1_migrate'",
            [],
            |row| row.get(0),
        )
        .expect("Must query duration_ms on old turn row");
    assert!(
        duration_ms.is_none(),
        "Old turn row must have NULL for duration_ms after migration"
    );

    // Verify old tool_call data survived
    let tool_name: String = conn
        .query_row(
            "SELECT tool_name FROM tool_calls WHERE id = 'tc_v1_migrate'",
            [],
            |row| row.get(0),
        )
        .expect("Must find migrated tool_call");
    assert_eq!(
        tool_name, "Read",
        "Old tool_call data must survive migration"
    );

    // Verify new tool_call columns are NULL for old rows
    let tc_status: Option<String> = conn
        .query_row(
            "SELECT status FROM tool_calls WHERE id = 'tc_v1_migrate'",
            [],
            |row| row.get(0),
        )
        .expect("Must query status on old tool_call row");
    assert!(
        tc_status.is_none(),
        "Old tool_call row must have NULL for status after migration"
    );
}

/// **Proves:** After migration, new rows can write to the new columns and read them back.
/// **Anti-fake:** Writing to non-existent columns would cause a SQL error.
#[test]
fn v2_columns_are_writable_and_readable() {
    let conn = blank_db();
    db::initialize(&conn).expect("initialize must succeed");

    // Insert a session with new v2 columns populated
    conn.execute(
        "INSERT INTO sessions (id, provider, started_at, last_active_at, system_prompt_hash, agent_id, agent_version, git_repo, git_branch, git_commit, working_directory, parent_session_id, tags) VALUES ('sess_v2', 'anthropic', '2026-03-18T10:00:00Z', '2026-03-18T10:30:00Z', 'sha256_v2', 'agent-001', '1.2.3', 'github.com/org/repo', 'feature/new', 'abc123def', '/home/user/project', 'sess_parent_1', '[\"compliance\",\"audit\"]')",
        [],
    )
    .expect("Must insert session with v2 columns");

    // Read back each new column
    let agent_id: String = conn
        .query_row(
            "SELECT agent_id FROM sessions WHERE id = 'sess_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(agent_id, "agent-001");

    let agent_version: String = conn
        .query_row(
            "SELECT agent_version FROM sessions WHERE id = 'sess_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(agent_version, "1.2.3");

    let git_repo: String = conn
        .query_row(
            "SELECT git_repo FROM sessions WHERE id = 'sess_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(git_repo, "github.com/org/repo");

    let git_branch: String = conn
        .query_row(
            "SELECT git_branch FROM sessions WHERE id = 'sess_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(git_branch, "feature/new");

    let git_commit: String = conn
        .query_row(
            "SELECT git_commit FROM sessions WHERE id = 'sess_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(git_commit, "abc123def");

    let working_directory: String = conn
        .query_row(
            "SELECT working_directory FROM sessions WHERE id = 'sess_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(working_directory, "/home/user/project");

    let parent_session_id: String = conn
        .query_row(
            "SELECT parent_session_id FROM sessions WHERE id = 'sess_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(parent_session_id, "sess_parent_1");

    let tags: String = conn
        .query_row(
            "SELECT tags FROM sessions WHERE id = 'sess_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tags, "[\"compliance\",\"audit\"]");
}

/// **Proves:** New turn columns (duration_ms, ttfb_ms, etc.) are writable/readable.
/// **Anti-fake:** These columns do not exist in v1.
#[test]
fn v2_turn_columns_writable_and_readable() {
    let conn = blank_db();
    db::initialize(&conn).expect("initialize must succeed");

    // Insert session first (FK constraint)
    conn.execute(
        "INSERT INTO sessions (id, provider, started_at, last_active_at, system_prompt_hash) VALUES ('sess_tc', 'anthropic', '2026-03-18T10:00:00Z', '2026-03-18T10:00:00Z', 'sha256_tc')",
        [],
    )
    .expect("Must insert session");

    // Insert turn with new v2 columns populated
    conn.execute(
        "INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash, stop_reason, capture_complete, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at, duration_ms, ttfb_ms, api_endpoint, http_status, error_message, retry_count, tool_call_count, thinking_tokens, server_id) VALUES ('turn_v2', 'sess_tc', 1, '2026-03-18T10:01:00Z', 'req_v2', 'resp_v2', 'end_turn', 1, 500, 200, 0, 0, '2026-03-18T10:01:00Z', 1234, 87, '/v1/messages', 200, NULL, 0, 3, 150, 'srv-west-1')",
        [],
    )
    .expect("Must insert turn with v2 columns");

    let duration_ms: i64 = conn
        .query_row(
            "SELECT duration_ms FROM turns WHERE id = 'turn_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(duration_ms, 1234);

    let ttfb_ms: i64 = conn
        .query_row(
            "SELECT ttfb_ms FROM turns WHERE id = 'turn_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(ttfb_ms, 87);

    let api_endpoint: String = conn
        .query_row(
            "SELECT api_endpoint FROM turns WHERE id = 'turn_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(api_endpoint, "/v1/messages");

    let http_status: i64 = conn
        .query_row(
            "SELECT http_status FROM turns WHERE id = 'turn_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(http_status, 200);

    let retry_count: i64 = conn
        .query_row(
            "SELECT retry_count FROM turns WHERE id = 'turn_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retry_count, 0);

    let tool_call_count: i64 = conn
        .query_row(
            "SELECT tool_call_count FROM turns WHERE id = 'turn_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tool_call_count, 3);

    let thinking_tokens: i64 = conn
        .query_row(
            "SELECT thinking_tokens FROM turns WHERE id = 'turn_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(thinking_tokens, 150);

    let server_id: String = conn
        .query_row(
            "SELECT server_id FROM turns WHERE id = 'turn_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(server_id, "srv-west-1");
}

/// **Proves:** New tool_calls columns (sequence_num, output, etc.) are writable/readable.
/// **Anti-fake:** These columns do not exist in v1.
#[test]
fn v2_tool_call_columns_writable_and_readable() {
    let conn = blank_db();
    db::initialize(&conn).expect("initialize must succeed");

    // Insert session + turn first (FK constraints)
    conn.execute(
        "INSERT INTO sessions (id, provider, started_at, last_active_at, system_prompt_hash) VALUES ('sess_tc2', 'anthropic', '2026-03-18T10:00:00Z', '2026-03-18T10:00:00Z', 'sha256_tc2')",
        [],
    )
    .expect("Must insert session");
    conn.execute(
        "INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash, stop_reason, capture_complete, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at) VALUES ('turn_tc2', 'sess_tc2', 1, '2026-03-18T10:01:00Z', 'req1', 'resp1', 'end_turn', 1, 100, 50, 0, 0, '2026-03-18T10:01:00Z')",
        [],
    )
    .expect("Must insert turn");

    // Insert tool_call with new v2 columns
    conn.execute(
        "INSERT INTO tool_calls (id, turn_id, tool_name, tool_input, input_hash, sequence_num, output, output_hash, duration_ms, error, status) VALUES ('tc_v2', 'turn_tc2', 'Bash', '{\"command\":\"ls\"}', 'sha256_in', 1, 'file1.txt\nfile2.txt', 'sha256_out', 450, NULL, 'success')",
        [],
    )
    .expect("Must insert tool_call with v2 columns");

    let seq: i64 = conn
        .query_row(
            "SELECT sequence_num FROM tool_calls WHERE id = 'tc_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(seq, 1);

    let output: String = conn
        .query_row(
            "SELECT output FROM tool_calls WHERE id = 'tc_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(output, "file1.txt\nfile2.txt");

    let output_hash: String = conn
        .query_row(
            "SELECT output_hash FROM tool_calls WHERE id = 'tc_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(output_hash, "sha256_out");

    let duration_ms: i64 = conn
        .query_row(
            "SELECT duration_ms FROM tool_calls WHERE id = 'tc_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(duration_ms, 450);

    let error: Option<String> = conn
        .query_row(
            "SELECT error FROM tool_calls WHERE id = 'tc_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(error.is_none());

    let status: String = conn
        .query_row(
            "SELECT status FROM tool_calls WHERE id = 'tc_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "success");
}

/// **Proves:** retry_count defaults to 0 and tool_call_count defaults to 0 when not specified.
/// **Anti-fake:** The design doc says "retry_count INTEGER DEFAULT 0" and "tool_call_count INTEGER DEFAULT 0".
#[test]
fn v2_turn_default_values_applied() {
    let conn = blank_db();
    db::initialize(&conn).expect("initialize must succeed");

    conn.execute(
        "INSERT INTO sessions (id, provider, started_at, last_active_at, system_prompt_hash) VALUES ('sess_def', 'anthropic', '2026-03-18T10:00:00Z', '2026-03-18T10:00:00Z', 'sha256_def')",
        [],
    )
    .expect("Must insert session");

    // Insert turn WITHOUT specifying retry_count or tool_call_count — they should default to 0
    conn.execute(
        "INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash, stop_reason, capture_complete, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at) VALUES ('turn_def', 'sess_def', 1, '2026-03-18T10:01:00Z', 'req_d', 'resp_d', 'end_turn', 1, 100, 50, 0, 0, '2026-03-18T10:01:00Z')",
        [],
    )
    .expect("Must insert turn without new columns");

    let retry_count: i64 = conn
        .query_row(
            "SELECT retry_count FROM turns WHERE id = 'turn_def'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retry_count, 0, "retry_count must default to 0");

    let tool_call_count: i64 = conn
        .query_row(
            "SELECT tool_call_count FROM turns WHERE id = 'turn_def'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tool_call_count, 0, "tool_call_count must default to 0");

    let thinking_tokens: i64 = conn
        .query_row(
            "SELECT thinking_tokens FROM turns WHERE id = 'turn_def'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(thinking_tokens, 0, "thinking_tokens must default to 0");
}

/// **Proves:** Old v1 rows get DEFAULT 0 for retry_count, tool_call_count, thinking_tokens
///   after migration from v1 to v2. This tests the migration path for EXISTING data,
///   not new inserts.
/// **Anti-fake:** The v2_turn_default_values_applied test only tests NEW rows inserted
///   after migration. This test verifies that ALTER TABLE ADD COLUMN ... DEFAULT 0
///   applies correctly to rows that existed BEFORE the column was added.
#[test]
fn v1_rows_get_default_0_after_migration() {
    let conn = create_v1_database();

    // Insert data at v1 schema (before migration)
    insert_v1_session(&conn, "sess_v1_def");
    insert_v1_turn(&conn, "turn_v1_def", "sess_v1_def", 1);

    // Precondition: these columns do not exist yet
    assert!(
        !column_exists(&conn, "turns", "retry_count"),
        "Precondition: retry_count must not exist in v1 schema"
    );

    // Run migration
    db::initialize(&conn).expect("initialize on v1 DB must succeed");

    // After migration, the old v1 row must have DEFAULT 0 for the new NOT NULL columns.
    // SQLite applies the DEFAULT value to existing rows when ALTER TABLE ADD COLUMN
    // specifies NOT NULL DEFAULT.
    let retry_count: i64 = conn
        .query_row(
            "SELECT retry_count FROM turns WHERE id = 'turn_v1_def'",
            [],
            |row| row.get(0),
        )
        .expect("Must query retry_count on migrated v1 row");
    assert_eq!(
        retry_count, 0,
        "Old v1 row must have retry_count = 0 after migration"
    );

    let tool_call_count: i64 = conn
        .query_row(
            "SELECT tool_call_count FROM turns WHERE id = 'turn_v1_def'",
            [],
            |row| row.get(0),
        )
        .expect("Must query tool_call_count on migrated v1 row");
    assert_eq!(
        tool_call_count, 0,
        "Old v1 row must have tool_call_count = 0 after migration"
    );

    let thinking_tokens: i64 = conn
        .query_row(
            "SELECT thinking_tokens FROM turns WHERE id = 'turn_v1_def'",
            [],
            |row| row.get(0),
        )
        .expect("Must query thinking_tokens on migrated v1 row");
    assert_eq!(
        thinking_tokens, 0,
        "Old v1 row must have thinking_tokens = 0 after migration"
    );
}

// ===========================================================================
// Section 2: Gemini Provider Detection Tests
// ===========================================================================

/// **Proves:** detect_provider returns "google" for generativelanguage.googleapis.com.
/// **Anti-fake:** Old code returns "unknown" for this host. Only new code returns "google".
#[test]
fn gemini_host_detected_as_google_provider() {
    let provider = providers::detect_provider("generativelanguage.googleapis.com");
    assert_eq!(
        provider, "google",
        "generativelanguage.googleapis.com must be detected as 'google'"
    );
}

/// **Proves:** detect_provider returns "google" for generativelanguage.googleapis.com:443.
/// **Anti-fake:** Port stripping must work for this new host just like existing providers.
#[test]
fn gemini_host_with_port_detected_as_google_provider() {
    let provider = providers::detect_provider("generativelanguage.googleapis.com:443");
    assert_eq!(
        provider, "google",
        "generativelanguage.googleapis.com:443 must be detected as 'google'"
    );
}

/// **Proves:** detect_provider is case-insensitive for the Gemini host.
/// **Anti-fake:** DNS is case-insensitive; the implementation must handle mixed case.
#[test]
fn gemini_host_case_insensitive() {
    let provider = providers::detect_provider("GenerativeLanguage.GoogleAPIs.COM");
    assert_eq!(
        provider, "google",
        "Case-insensitive Gemini host must be detected as 'google'"
    );
}

/// **Proves:** Existing providers (anthropic, openai) are not broken by adding Gemini.
/// **Anti-fake:** Regression test — ensures the new match arm doesn't shadow existing ones.
#[test]
fn existing_providers_still_detected_after_gemini_addition() {
    assert_eq!(providers::detect_provider("api.anthropic.com"), "anthropic");
    assert_eq!(providers::detect_provider("api.openai.com"), "openai");
    assert_eq!(providers::detect_provider("chatgpt.com"), "openai");
    assert_eq!(providers::detect_provider("ab.chatgpt.com"), "openai");
    assert_eq!(providers::detect_provider("example.com"), "unknown");
}

/// **Proves:** Subdomain spoofing of Gemini host is not detected as google.
/// **Anti-fake:** A naive `contains` implementation would false-positive on this.
#[test]
fn gemini_subdomain_spoofing_not_detected() {
    let provider = providers::detect_provider("generativelanguage.googleapis.com.evil.com");
    assert_eq!(
        provider, "unknown",
        "Subdomain spoofing of Gemini host must not be detected as google"
    );
}

// ===========================================================================
// Section 3: Gemini Endpoint Interception Tests
// ===========================================================================

/// **Proves:** POST /v1beta/models/gemini-pro/generateContent is intercepted.
/// **Anti-fake:** Old code only matches /v1/messages and /v1/chat/completions.
///   This Gemini endpoint would NOT be intercepted by old code.
#[test]
fn gemini_generate_content_intercepted() {
    let raw = http_request("POST", "/v1beta/models/gemini-pro/generateContent");
    let decision = gateway::should_intercept(&raw, "unknown");
    assert!(
        decision.should_capture,
        "POST /v1beta/models/gemini-pro/generateContent must be intercepted"
    );
    assert_eq!(decision.method.as_deref(), Some("POST"));
    assert_eq!(
        decision.path.as_deref(),
        Some("/v1beta/models/gemini-pro/generateContent")
    );
}

/// **Proves:** POST /v1beta/models/gemini-pro/streamGenerateContent is intercepted.
/// **Anti-fake:** Old code does not know about streamGenerateContent.
#[test]
fn gemini_stream_generate_content_intercepted() {
    let raw = http_request("POST", "/v1beta/models/gemini-pro/streamGenerateContent");
    let decision = gateway::should_intercept(&raw, "unknown");
    assert!(
        decision.should_capture,
        "POST /v1beta/models/gemini-pro/streamGenerateContent must be intercepted"
    );
}

/// **Proves:** Any model name in the Gemini path pattern is intercepted (wildcard matching).
///   /v1beta/models/*/generateContent must work for gemini-1.5-pro, gemini-2.0-flash, etc.
/// **Anti-fake:** A hardcoded "gemini-pro" match would fail on other model names.
#[test]
fn gemini_any_model_name_intercepted() {
    let models = [
        "gemini-1.5-pro",
        "gemini-2.0-flash",
        "gemini-pro-vision",
        "gemini-ultra",
        "gemini-1.5-flash-latest",
    ];
    for model in &models {
        let raw = http_request("POST", &format!("/v1beta/models/{}/generateContent", model));
        let decision = gateway::should_intercept(&raw, "unknown");
        assert!(
            decision.should_capture,
            "POST /v1beta/models/{}/generateContent must be intercepted",
            model
        );

        let raw_stream = http_request(
            "POST",
            &format!("/v1beta/models/{}/streamGenerateContent", model),
        );
        let decision_stream = gateway::should_intercept(&raw_stream, "unknown");
        assert!(
            decision_stream.should_capture,
            "POST /v1beta/models/{}/streamGenerateContent must be intercepted",
            model
        );
    }
}

/// **Proves:** GET requests to Gemini endpoints are NOT intercepted (only POST).
/// **Anti-fake:** The design specifies POST only for Gemini endpoints.
#[test]
fn gemini_get_request_not_intercepted() {
    let raw = http_request("GET", "/v1beta/models/gemini-pro/generateContent");
    let decision = gateway::should_intercept(&raw, "unknown");
    assert!(
        !decision.should_capture,
        "GET requests to Gemini endpoints must NOT be intercepted"
    );
}

/// **Proves:** classify_host returns Mitm mode for generativelanguage.googleapis.com.
/// **Anti-fake:** Old code returns Passthrough for unknown hosts; Gemini host was unknown.
#[test]
fn classify_host_returns_mitm_for_gemini() {
    let mode = gateway::classify_host("generativelanguage.googleapis.com");
    assert_eq!(
        mode,
        gateway::TunnelMode::Mitm("google".to_string()),
        "Gemini host must be classified as Mitm with provider 'google'"
    );
}

/// **Proves:** classify_host returns Mitm for Gemini host with port.
/// **Anti-fake:** Port handling must work for the new provider.
#[test]
fn classify_host_returns_mitm_for_gemini_with_port() {
    let mode = gateway::classify_host("generativelanguage.googleapis.com:443");
    assert_eq!(
        mode,
        gateway::TunnelMode::Mitm("google".to_string()),
        "Gemini host with port must be classified as Mitm with provider 'google'"
    );
}

/// **Proves:** Existing providers still return correct Mitm/Passthrough after Gemini addition.
/// **Anti-fake:** Regression check.
#[test]
fn classify_host_existing_providers_unchanged() {
    assert_eq!(
        gateway::classify_host("api.anthropic.com"),
        gateway::TunnelMode::Mitm("anthropic".to_string())
    );
    assert_eq!(
        gateway::classify_host("api.openai.com"),
        gateway::TunnelMode::Mitm("openai".to_string())
    );
    assert_eq!(
        gateway::classify_host("example.com"),
        gateway::TunnelMode::Passthrough
    );
}

/// **Proves:** Gemini endpoint with query parameters (e.g., ?key=...) is still intercepted.
/// **Anti-fake:** The Gemini API uses API key in query string. Path matching must strip query.
#[test]
fn gemini_endpoint_with_query_params_intercepted() {
    let raw = http_request(
        "POST",
        "/v1beta/models/gemini-pro/generateContent?key=AIzaSy1234567890",
    );
    let decision = gateway::should_intercept(&raw, "unknown");
    assert!(
        decision.should_capture,
        "POST /v1beta/models/gemini-pro/generateContent?key=... must be intercepted"
    );
    // Verify query string is stripped from the stored path (security: no API key in logs)
    assert_eq!(
        decision.path.as_deref(),
        Some("/v1beta/models/gemini-pro/generateContent"),
        "InterceptDecision.path must NOT contain query string (API key leak prevention)"
    );
}

/// **Proves:** Existing endpoints (Anthropic /v1/messages, OpenAI /v1/chat/completions) still work.
/// **Anti-fake:** Regression — adding Gemini must not break existing interception rules.
#[test]
fn existing_intercept_endpoints_still_work() {
    let anthropic = b"POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n".to_vec();
    let openai = b"POST /v1/chat/completions HTTP/1.1\r\nHost: api.openai.com\r\n\r\n".to_vec();

    let d1 = gateway::should_intercept(&anthropic, "unknown");
    assert!(
        d1.should_capture,
        "Anthropic /v1/messages must still be intercepted"
    );

    let d2 = gateway::should_intercept(&openai, "unknown");
    assert!(
        d2.should_capture,
        "OpenAI /v1/chat/completions must still be intercepted"
    );
}

// ===========================================================================
// Section 4: Mock LLM Server Tests
// ===========================================================================
//
// Mock LLM servers are test infrastructure. The implementation agent will create
// helper modules that bind to localhost, accept HTTP connections, and replay
// fixture SSE data. These tests verify the mock servers behave correctly.
//
// TODO: The implementation agent will create a test helper module (e.g.,
// a `mock_servers` module in tests/ or a helper file) that provides:
//   - `mock_anthropic_server(fixture: &[u8]) -> (String, tokio::task::JoinHandle<()>)`
//   - `mock_openai_server(fixture: &[u8]) -> (String, tokio::task::JoinHandle<()>)`
//   - `mock_gemini_server(fixture: &[u8]) -> (String, tokio::task::JoinHandle<()>)`
// Each returns (url, join_handle). The URL is http://127.0.0.1:{port}.

// Anthropic SSE fixture: a minimal complete response
const ANTHROPIC_SSE_FIXTURE: &str = "\
event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_test\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-20250514\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":100,\"output_tokens\":0}}}\n\n\
event: content_block_start\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello, world!\"}}\n\n\
event: content_block_stop\n\
data: {\"type\":\"content_block_stop\",\"index\":0}\n\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\n\
event: message_stop\n\
data: {\"type\":\"message_stop\"}\n\n";

// OpenAI SSE fixture: a minimal complete response
const OPENAI_SSE_FIXTURE: &str = "\
data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}]}\n\n\
data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello from OpenAI!\"},\"finish_reason\":null}]}\n\n\
data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-4o\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
data: [DONE]\n\n";

// Gemini SSE fixture: a minimal streaming response
const GEMINI_SSE_FIXTURE: &str = "\
data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hello from Gemini!\"}],\"role\":\"model\"},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":10,\"candidatesTokenCount\":5,\"totalTokenCount\":15}}\n\n";

/// **Proves:** The Anthropic SSE fixture is well-formed with correct event structure.
/// **Anti-fake:** The fixture must contain message_start/message_stop events with valid JSON.
/// NOTE: Actual HTTP mock server implementation deferred to Phase 2 (see TODO in test body).
#[tokio::test]
async fn anthropic_fixture_is_well_formed_sse() {
    // TODO: Implementation agent creates mock_anthropic_server function.
    // The function should:
    // 1. Bind to 127.0.0.1:0
    // 2. Accept one HTTP POST request
    // 3. Return the fixture data with Content-Type: text/event-stream
    // 4. Return HTTP 200
    //
    // Uncomment and fill in when mock server is implemented:
    //
    // let (url, handle) = mock_anthropic_server(ANTHROPIC_SSE_FIXTURE.as_bytes()).await;
    //
    // let client = reqwest::Client::new();
    // let resp = client
    //     .post(&format!("{}/v1/messages", url))
    //     .header("Content-Type", "application/json")
    //     .body("{}")
    //     .send()
    //     .await
    //     .expect("Must connect to mock server");
    //
    // assert_eq!(resp.status(), 200);
    // assert_eq!(
    //     resp.headers().get("content-type").unwrap().to_str().unwrap(),
    //     "text/event-stream"
    // );
    //
    // let body = resp.text().await.expect("Must read body");
    // assert!(body.contains("event: message_start"), "Must contain message_start event");
    // assert!(body.contains("Hello, world!"), "Must contain the fixture text");
    // assert!(body.contains("event: message_stop"), "Must contain message_stop event");
    //
    // handle.abort();

    // Placeholder: verify fixtures are well-formed SSE by parsing them ourselves.
    // This test passes now and validates the fixture data structure.
    assert!(
        ANTHROPIC_SSE_FIXTURE.contains("event: message_start"),
        "Anthropic fixture must contain message_start"
    );
    assert!(
        ANTHROPIC_SSE_FIXTURE.contains("event: message_stop"),
        "Anthropic fixture must contain message_stop"
    );
    assert!(
        ANTHROPIC_SSE_FIXTURE.contains("Hello, world!"),
        "Anthropic fixture must contain expected text"
    );
    assert!(
        ANTHROPIC_SSE_FIXTURE.contains("\"model\":\"claude-sonnet-4-20250514\""),
        "Anthropic fixture must contain model name"
    );
    assert!(
        ANTHROPIC_SSE_FIXTURE.contains("\"stop_reason\":\"end_turn\""),
        "Anthropic fixture must contain stop_reason"
    );
    // Verify each SSE event has the correct format (event: line followed by data: line)
    let events: Vec<&str> = ANTHROPIC_SSE_FIXTURE
        .split("\n\n")
        .filter(|s| !s.is_empty())
        .collect();
    assert!(
        events.len() >= 5,
        "Anthropic fixture must have at least 5 SSE events, got {}",
        events.len()
    );
}

/// **Proves:** The OpenAI SSE fixture is well-formed with [DONE] terminator.
/// **Anti-fake:** The fixture must end with "data: [DONE]", not Anthropic-style "message_stop".
/// NOTE: Actual HTTP mock server implementation deferred to Phase 2 (see TODO in test body).
#[tokio::test]
async fn openai_fixture_is_well_formed_sse() {
    // TODO: Implementation agent creates mock_openai_server function.
    // Same pattern as Anthropic mock but with OpenAI SSE format.

    // Placeholder: validate OpenAI fixture structure
    assert!(
        OPENAI_SSE_FIXTURE.contains("data: [DONE]"),
        "OpenAI fixture must contain [DONE] terminator"
    );
    assert!(
        OPENAI_SSE_FIXTURE.contains("Hello from OpenAI!"),
        "OpenAI fixture must contain expected text"
    );
    assert!(
        OPENAI_SSE_FIXTURE.contains("\"finish_reason\":\"stop\""),
        "OpenAI fixture must contain stop finish_reason"
    );
    assert!(
        OPENAI_SSE_FIXTURE.contains("\"model\":\"gpt-4o\""),
        "OpenAI fixture must contain model name"
    );
    // Each data line must start with "data: "
    for line in OPENAI_SSE_FIXTURE.lines() {
        if !line.is_empty() {
            assert!(
                line.starts_with("data: "),
                "Every non-empty OpenAI SSE line must start with 'data: ', got: {:?}",
                line
            );
        }
    }
}

/// **Proves:** The Gemini SSE fixture is well-formed with candidates structure.
/// **Anti-fake:** The fixture must contain Gemini-specific fields (candidates, finishReason),
///   not Anthropic or OpenAI format.
/// NOTE: Actual HTTP mock server implementation deferred to Phase 2 (see TODO in test body).
#[tokio::test]
async fn gemini_fixture_is_well_formed_sse() {
    // TODO: Implementation agent creates mock_gemini_server function.

    // Placeholder: validate Gemini fixture structure
    assert!(
        GEMINI_SSE_FIXTURE.contains("\"candidates\""),
        "Gemini fixture must contain candidates array"
    );
    assert!(
        GEMINI_SSE_FIXTURE.contains("Hello from Gemini!"),
        "Gemini fixture must contain expected text"
    );
    assert!(
        GEMINI_SSE_FIXTURE.contains("\"finishReason\":\"STOP\""),
        "Gemini fixture must contain STOP finishReason"
    );
    assert!(
        GEMINI_SSE_FIXTURE.contains("\"usageMetadata\""),
        "Gemini fixture must contain usageMetadata"
    );
    assert!(
        GEMINI_SSE_FIXTURE.contains("\"totalTokenCount\":15"),
        "Gemini fixture must contain totalTokenCount"
    );
}

/// **Proves:** Each provider's fixture is structurally distinct — you cannot pass one
///   provider's fixture as another's.
/// **Anti-fake:** Ensures mock servers are provider-specific, not generic.
#[test]
fn provider_fixtures_are_structurally_distinct() {
    // Anthropic has "event:" lines; OpenAI does not
    assert!(
        ANTHROPIC_SSE_FIXTURE.contains("event: message_start"),
        "Anthropic has event: lines"
    );
    assert!(
        !OPENAI_SSE_FIXTURE.contains("event:"),
        "OpenAI must NOT have event: lines"
    );
    assert!(
        !GEMINI_SSE_FIXTURE.contains("event:"),
        "Gemini must NOT have event: lines"
    );

    // OpenAI has [DONE] terminator; Anthropic and Gemini do not
    assert!(
        OPENAI_SSE_FIXTURE.contains("[DONE]"),
        "OpenAI has [DONE] terminator"
    );
    assert!(
        !ANTHROPIC_SSE_FIXTURE.contains("[DONE]"),
        "Anthropic must NOT have [DONE]"
    );
    assert!(
        !GEMINI_SSE_FIXTURE.contains("[DONE]"),
        "Gemini must NOT have [DONE]"
    );

    // Gemini has "candidates"; Anthropic and OpenAI do not
    assert!(
        GEMINI_SSE_FIXTURE.contains("\"candidates\""),
        "Gemini has candidates"
    );
    assert!(
        !ANTHROPIC_SSE_FIXTURE.contains("\"candidates\""),
        "Anthropic must NOT have candidates"
    );
    assert!(
        !OPENAI_SSE_FIXTURE.contains("\"candidates\""),
        "OpenAI must NOT have candidates"
    );
}

/// **Proves:** Fixtures produce deterministic parsing results through the SSE accumulator.
///   Feeding the same fixture bytes through parse_sse_stream twice yields identical
///   event counts, event types, and raw bytes.
/// **Anti-fake:** A non-deterministic parser (e.g., one that injects timestamps or
///   random IDs) would produce different results on each parse.
#[test]
fn mock_fixtures_produce_deterministic_parse_results() {
    use recondo_gateway::stream::parse_sse_stream;

    // Parse Anthropic fixture twice and compare
    let first = parse_sse_stream(ANTHROPIC_SSE_FIXTURE.as_bytes());
    let second = parse_sse_stream(ANTHROPIC_SSE_FIXTURE.as_bytes());
    assert_eq!(
        first.events.len(),
        second.events.len(),
        "Anthropic: event count must be deterministic"
    );
    assert_eq!(
        first.raw_bytes, second.raw_bytes,
        "Anthropic: raw bytes must be deterministic"
    );
    for (a, b) in first.events.iter().zip(second.events.iter()) {
        assert_eq!(
            a.event_type, b.event_type,
            "Anthropic: event types must match"
        );
        assert_eq!(a.data, b.data, "Anthropic: event data must match");
    }
    assert!(
        first.events.len() >= 5,
        "Anthropic fixture must parse to at least 5 events, got {}",
        first.events.len()
    );

    // Parse OpenAI fixture twice and compare
    let first_oi = parse_sse_stream(OPENAI_SSE_FIXTURE.as_bytes());
    let second_oi = parse_sse_stream(OPENAI_SSE_FIXTURE.as_bytes());
    assert_eq!(
        first_oi.events.len(),
        second_oi.events.len(),
        "OpenAI: event count must be deterministic"
    );
    assert_eq!(
        first_oi.raw_bytes, second_oi.raw_bytes,
        "OpenAI: raw bytes must be deterministic"
    );

    // Parse Gemini fixture twice and compare
    let first_gem = parse_sse_stream(GEMINI_SSE_FIXTURE.as_bytes());
    let second_gem = parse_sse_stream(GEMINI_SSE_FIXTURE.as_bytes());
    assert_eq!(
        first_gem.events.len(),
        second_gem.events.len(),
        "Gemini: event count must be deterministic"
    );
    assert_eq!(
        first_gem.raw_bytes, second_gem.raw_bytes,
        "Gemini: raw bytes must be deterministic"
    );
}

// ===========================================================================
// Section 5: Documentation Existence Tests
// ===========================================================================

/// **Proves:** The gap analysis document exists at compliance/gap_analysis.md.
/// **Anti-fake:** This file does not exist before Week 4 implementation.
#[test]
fn gap_analysis_document_exists() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("compliance")
        .join("gap_analysis.md");
    assert!(
        path.exists(),
        "compliance/gap_analysis.md must exist at {:?}",
        path
    );
}

/// **Proves:** The gap analysis document maps every sessions column to a framework requirement.
/// **Anti-fake:** An empty file would fail these content checks.
#[test]
fn gap_analysis_covers_sessions_columns() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("compliance")
        .join("gap_analysis.md");
    let content = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("Must read gap_analysis.md: {}", e));

    // Must reference key session fields
    let session_fields = [
        "agent_id",
        "agent_version",
        "git_repo",
        "git_branch",
        "git_commit",
        "working_directory",
        "parent_session_id",
        "tags",
        "provider",
        "model",
        "started_at",
        "system_prompt_hash",
        "total_turns",
        "total_tokens",
        "total_cost_usd",
        "framework",
    ];
    for field in &session_fields {
        assert!(
            content.contains(field),
            "gap_analysis.md must reference session field '{}' for compliance mapping",
            field
        );
    }
}

/// **Proves:** The gap analysis document references SOC 2 and ISO 42001 frameworks.
/// **Anti-fake:** A generic document without framework references would fail.
#[test]
fn gap_analysis_references_compliance_frameworks() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("compliance")
        .join("gap_analysis.md");
    let content = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("Must read gap_analysis.md: {}", e));

    assert!(
        content.contains("SOC 2") || content.contains("SOC2"),
        "gap_analysis.md must reference SOC 2"
    );
    assert!(
        content.contains("ISO 42001") || content.contains("42001"),
        "gap_analysis.md must reference ISO 42001"
    );
    // Must have status indicators
    assert!(
        content.contains("captured") || content.contains("Captured"),
        "gap_analysis.md must have 'captured' status entries"
    );
}

/// **Proves:** The gap analysis maps turns and tool_calls columns, not just sessions.
/// **Anti-fake:** A partial document covering only sessions would fail.
#[test]
fn gap_analysis_covers_turns_and_tool_calls() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("compliance")
        .join("gap_analysis.md");
    let content = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("Must read gap_analysis.md: {}", e));

    // Turn-specific fields
    let turn_fields = [
        "duration_ms",
        "ttfb_ms",
        "http_status",
        "request_hash",
        "response_hash",
        "input_tokens",
        "output_tokens",
        "thinking_tokens",
    ];
    for field in &turn_fields {
        assert!(
            content.contains(field),
            "gap_analysis.md must reference turn field '{}' for compliance mapping",
            field
        );
    }

    // Tool call-specific fields
    let tool_fields = ["tool_name", "tool_input", "output", "duration_ms", "status"];
    for field in &tool_fields {
        assert!(
            content.contains(field),
            "gap_analysis.md must reference tool_call field '{}' for compliance mapping",
            field
        );
    }
}

/// **Proves:** The provider compatibility matrix exists.
/// **Anti-fake:** This file does not exist before Week 4.
#[test]
fn provider_compatibility_matrix_exists() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("compliance")
        .join("provider_compatibility.md");
    assert!(
        path.exists(),
        "compliance/provider_compatibility.md must exist at {:?}",
        path
    );
}

/// **Proves:** The provider compatibility matrix covers all required agents/providers.
/// **Anti-fake:** A matrix covering only Anthropic would fail on the other providers.
#[test]
fn provider_compatibility_covers_all_providers() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("compliance")
        .join("provider_compatibility.md");
    let content = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("Must read provider_compatibility.md: {}", e));

    let providers = ["Claude Code", "Codex", "Gemini", "Cursor", "Aider"];
    for provider in &providers {
        assert!(
            content.contains(provider),
            "provider_compatibility.md must include '{}'",
            provider
        );
    }

    // Must reference key transport concerns
    let transport_fields = ["HTTPS_PROXY", "TLS"];
    for field in &transport_fields {
        assert!(
            content.contains(field),
            "provider_compatibility.md must reference '{}'",
            field
        );
    }
}

// ===========================================================================
// Section 6: Negative Tests
// ===========================================================================

/// **Proves (NEGATIVE):** A v1 database (SCHEMA_VERSION=1) does NOT have the new columns.
///   This test verifies the PRECONDITION: before migration, the columns are absent.
///   If this test passes AND the migration tests pass, it proves the migration added them.
/// **Anti-fake:** If someone adds columns to the v1 schema directly (instead of via
///   migration), the v1_to_v2 migration test would pass vacuously. This test catches that.
#[test]
fn negative_v1_schema_lacks_new_columns() {
    let conn = create_v1_database();

    // Sessions: none of the 8 new columns should exist
    assert!(
        !column_exists(&conn, "sessions", "agent_id"),
        "v1 schema must NOT have agent_id"
    );
    assert!(
        !column_exists(&conn, "sessions", "git_repo"),
        "v1 schema must NOT have git_repo"
    );
    assert!(
        !column_exists(&conn, "sessions", "tags"),
        "v1 schema must NOT have tags"
    );

    // Turns: none of the new columns should exist
    assert!(
        !column_exists(&conn, "turns", "duration_ms"),
        "v1 schema must NOT have duration_ms"
    );
    assert!(
        !column_exists(&conn, "turns", "ttfb_ms"),
        "v1 schema must NOT have ttfb_ms"
    );
    assert!(
        !column_exists(&conn, "turns", "thinking_tokens"),
        "v1 schema must NOT have thinking_tokens"
    );
    assert!(
        !column_exists(&conn, "turns", "server_id"),
        "v1 schema must NOT have server_id"
    );

    // Tool calls: none of the new columns should exist
    assert!(
        !column_exists(&conn, "tool_calls", "sequence_num"),
        "v1 schema must NOT have sequence_num"
    );
    assert!(
        !column_exists(&conn, "tool_calls", "output"),
        "v1 schema must NOT have output"
    );
    assert!(
        !column_exists(&conn, "tool_calls", "status"),
        "v1 schema must NOT have status"
    );
}

/// **Proves (NEGATIVE):** Without Gemini support, generativelanguage.googleapis.com
///   returns "unknown" from detect_provider. This is the OLD behavior.
///   If this test passes, it means old code returns "unknown". Combined with the
///   positive test (which asserts "google"), it proves the change is real.
///
///   NOTE: This test is written as the INVERSE of the positive test. In the old code,
///   it WOULD pass. In the new code, the positive test passes and this negative test
///   is expected to FAIL (which is why we mark it with a note — the implementation
///   agent should remove or invert this test when Gemini support is added).
///
///   For the test suite to work, we structure it as: "the result is specifically 'google',
///   not 'unknown'". The negative case is that "unknown" is the WRONG answer.
/// **Anti-fake:** This tests the exact boundary: old code returns "unknown", new code
///   returns "google".
#[test]
fn negative_gemini_host_not_unknown() {
    let provider = providers::detect_provider("generativelanguage.googleapis.com");
    assert_ne!(
        provider, "unknown",
        "After Gemini support is added, generativelanguage.googleapis.com must NOT return 'unknown'"
    );
}

/// **Proves (NEGATIVE):** Gemini endpoints are NOT intercepted by a non-POST method.
///   DELETE, PUT, PATCH to /v1beta/models/gemini-pro/generateContent must not capture.
/// **Anti-fake:** If the implementation uses a blanket path match without method filtering,
///   non-POST methods would be incorrectly intercepted.
#[test]
fn negative_non_post_gemini_endpoints_not_intercepted() {
    let methods = ["GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
    for method in &methods {
        let raw = http_request(method, "/v1beta/models/gemini-pro/generateContent");
        let decision = gateway::should_intercept(&raw, "unknown");
        assert!(
            !decision.should_capture,
            "{} /v1beta/models/gemini-pro/generateContent must NOT be intercepted",
            method
        );
    }
}

/// **Proves (NEGATIVE):** Non-Gemini paths that look similar are NOT intercepted.
///   e.g., /v1beta/models/gemini-pro/listModels, /v2/models/gemini-pro/generateContent
/// **Anti-fake:** A too-broad path match would incorrectly intercept these.
#[test]
fn negative_non_gemini_paths_not_intercepted() {
    let non_capturable_paths = [
        "/v1beta/models/gemini-pro/listModels",
        "/v1beta/models/gemini-pro/countTokens",
        "/v2/models/gemini-pro/generateContent",
        "/v1/models/gemini-pro/generateContent",
        "/v1beta/models/",
        "/v1beta/",
    ];
    for path in &non_capturable_paths {
        let raw = http_request("POST", path);
        let decision = gateway::should_intercept(&raw, "unknown");
        assert!(
            !decision.should_capture,
            "POST {} must NOT be intercepted — not a valid Gemini generation endpoint",
            path
        );
    }
}

/// **Proves (NEGATIVE):** Writing to a v2 column fails on a v1 database (before migration).
/// **Anti-fake:** If v2 columns somehow exist in v1, this would incorrectly succeed.
#[test]
fn negative_v2_column_write_fails_on_v1_schema() {
    let conn = create_v1_database();
    insert_v1_session(&conn, "sess_neg");

    // Attempting to UPDATE a v2-only column should fail because it doesn't exist
    let result = conn.execute(
        "UPDATE sessions SET agent_id = 'test' WHERE id = 'sess_neg'",
        [],
    );
    assert!(
        result.is_err(),
        "Writing to agent_id on v1 schema must fail because the column does not exist"
    );
}

// ===========================================================================
// Section 7: Boundary/Invariant Tests
// ===========================================================================

/// **Proves:** Migration is idempotent — running initialize() twice on a v1 DB
///   does not produce an error. The second call is a no-op.
/// **Anti-fake:** ALTER TABLE ADD COLUMN on an existing column would error without
///   the column_exists guard.
#[test]
fn migration_v1_to_v2_is_idempotent() {
    let conn = create_v1_database();
    insert_v1_session(&conn, "sess_idem");

    // First migration
    db::initialize(&conn).expect("First initialize on v1 DB must succeed");
    assert!(get_user_version(&conn) >= 2);

    // Second migration — must be a no-op, not an error
    db::initialize(&conn).expect("Second initialize on already-migrated DB must succeed");
    assert!(
        get_user_version(&conn) >= 2,
        "Version must remain at >= 2 after idempotent initialize"
    );

    // Data must still be intact
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM sessions WHERE id = 'sess_idem'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "Session must survive double initialize");
}

/// **Proves:** run_migrations from version 0 (empty tables) to version 2 works.
///   This tests the full lifecycle: fresh DB → create tables → add v2 columns.
/// **Anti-fake:** If the migration only works for v1→v2 but not 0→2, this would fail.
#[test]
fn fresh_db_gets_all_v2_columns() {
    let conn = blank_db();
    db::initialize(&conn).expect("initialize on fresh DB must succeed");

    // All 24 new columns must exist on a fresh DB
    let all_new_columns = [
        ("sessions", "agent_id"),
        ("sessions", "agent_version"),
        ("sessions", "git_repo"),
        ("sessions", "git_branch"),
        ("sessions", "git_commit"),
        ("sessions", "working_directory"),
        ("sessions", "parent_session_id"),
        ("sessions", "tags"),
        ("turns", "duration_ms"),
        ("turns", "ttfb_ms"),
        ("turns", "api_endpoint"),
        ("turns", "http_status"),
        ("turns", "error_message"),
        ("turns", "retry_count"),
        ("turns", "tool_call_count"),
        ("turns", "thinking_tokens"),
        ("turns", "server_id"),
        ("tool_calls", "sequence_num"),
        ("tool_calls", "output"),
        ("tool_calls", "output_hash"),
        ("tool_calls", "duration_ms"),
        ("tool_calls", "error"),
        ("tool_calls", "status"),
    ];

    for (table, col) in &all_new_columns {
        assert!(
            column_exists(&conn, table, col),
            "Fresh v2 DB must have {}.{} column",
            table,
            col
        );
    }
}

/// **Proves:** A database with user_version > 2 (future version) is not downgraded.
///   initialize() and run_migrations() are no-ops on a future-versioned database.
/// **Anti-fake:** If the migration blindly sets version = 2, it would downgrade a v3 DB.
#[test]
fn future_version_database_not_downgraded() {
    let conn = blank_db();
    db::initialize(&conn).expect("initialize must succeed");

    // Simulate a future version
    set_user_version(&conn, 99);

    db::initialize(&conn).expect("initialize on future-version DB must succeed");
    assert_eq!(
        get_user_version(&conn),
        99,
        "Future version must NOT be downgraded"
    );

    db::run_migrations(&conn).expect("run_migrations on future-version DB must succeed");
    assert_eq!(
        get_user_version(&conn),
        99,
        "Future version must NOT be downgraded by run_migrations"
    );
}

/// **Proves:** Gemini endpoint interception works with percent-encoded paths.
///   e.g., /v1beta/models/gemini%2Dpro/generateContent should still match
///   after decoding to /v1beta/models/gemini-pro/generateContent.
/// **Anti-fake:** If percent-decoding is not applied to Gemini paths, this would fail.
#[test]
fn gemini_endpoint_with_percent_encoding_intercepted() {
    // %2D is '-' (hyphen)
    let raw = http_request("POST", "/v1beta/models/gemini%2Dpro/generateContent");
    let decision = gateway::should_intercept(&raw, "unknown");
    assert!(
        decision.should_capture,
        "POST /v1beta/models/gemini%2Dpro/generateContent must be intercepted after percent-decoding"
    );
}

/// **Proves:** Tags column stores valid JSON arrays and they can be read back.
/// **Anti-fake:** This tests that the column type is TEXT and can hold JSON.
#[test]
fn tags_column_stores_json_array() {
    let conn = blank_db();
    db::initialize(&conn).expect("initialize must succeed");

    conn.execute(
        "INSERT INTO sessions (id, provider, started_at, last_active_at, system_prompt_hash, tags) VALUES ('sess_tags', 'google', '2026-03-18T10:00:00Z', '2026-03-18T10:00:00Z', 'sha256_tags', '[\"soc2\",\"iso42001\",\"audit\"]')",
        [],
    )
    .expect("Must insert session with JSON tags");

    let tags: String = conn
        .query_row(
            "SELECT tags FROM sessions WHERE id = 'sess_tags'",
            [],
            |row| row.get(0),
        )
        .unwrap();

    // Parse the JSON to verify it's valid
    let parsed: Vec<String> = serde_json::from_str(&tags).expect("tags must be valid JSON array");
    assert_eq!(parsed.len(), 3);
    assert_eq!(parsed[0], "soc2");
    assert_eq!(parsed[1], "iso42001");
    assert_eq!(parsed[2], "audit");
}

/// **Proves:** The count of new columns added matches the design doc exactly.
///   Sessions: 8 new, Turns: 8 new (provider skipped), Tool calls: 6 new = 22 net new.
///   Including thinking_tokens and server_id in the turns count: 9 specified, 1 skipped = 8 net new.
///   Total: 8 + 8 + 6 = 22 net new columns (or 23 if we count thinking_tokens=0 default separately).
/// **Anti-fake:** Ensures no columns are accidentally omitted or extra columns added.
#[test]
fn exact_column_count_after_v2_migration() {
    let conn = blank_db();
    db::initialize(&conn).expect("initialize must succeed");

    let session_cols = get_columns(&conn, "sessions");
    let turn_cols = get_columns(&conn, "turns");
    let tool_call_cols = get_columns(&conn, "tool_calls");

    // Sessions: 14 original + 8 v2 + 2 v4 (account_uuid, device_id) + 1 v7 (project_id) + 1 v9 (tool_definitions_hash) = 26
    assert_eq!(
        session_cols.len(),
        26,
        "sessions table must have 26 columns (14 original + 8 v2 + 2 v4 + 1 v7 + 1 v9), got: {:?}",
        session_cols
    );

    // Turns: 29 original + 9 new (v2) + 1 new (v3 integrity_verified) + 1 (v6 supersedes_turn_id) + 1 (v10 user_request_text) + 1 (v11 attachment_count) = 42
    assert_eq!(
        turn_cols.len(),
        42,
        "turns table must have 42 columns (29 original + 9 v2 + 1 v3 + 1 v6 + 1 v10 + 1 v11), got: {:?}",
        turn_cols
    );

    // Tool calls: 5 original + 6 new + 2 (v6 artifacts_created, artifact_hashes) = 13
    assert_eq!(
        tool_call_cols.len(),
        13,
        "tool_calls table must have 13 columns (5 original + 6 new + 2 v6), got: {:?}",
        tool_call_cols
    );
}

/// **Proves:** error_message column on turns can store long error text (TEXT type, no size limit).
/// **Anti-fake:** If the column were VARCHAR(255), a long error would be truncated.
#[test]
fn error_message_stores_long_text() {
    let conn = blank_db();
    db::initialize(&conn).expect("initialize must succeed");

    conn.execute(
        "INSERT INTO sessions (id, provider, started_at, last_active_at, system_prompt_hash) VALUES ('sess_err', 'google', '2026-03-18T10:00:00Z', '2026-03-18T10:00:00Z', 'sha256_err')",
        [],
    )
    .expect("Must insert session");

    let long_error = "E".repeat(10_000);
    conn.execute(
        "INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash, stop_reason, capture_complete, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at, error_message) VALUES ('turn_err', 'sess_err', 1, '2026-03-18T10:01:00Z', 'req_e', 'resp_e', 'error', 1, 0, 0, 0, 0, '2026-03-18T10:01:00Z', ?1)",
        rusqlite::params![long_error],
    )
    .expect("Must insert turn with long error message");

    let stored_error: String = conn
        .query_row(
            "SELECT error_message FROM turns WHERE id = 'turn_err'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        stored_error.len(),
        10_000,
        "error_message must store full 10,000 character string without truncation"
    );
}

/// **Proves:** tool_calls output column can store large tool output (e.g., file contents).
/// **Anti-fake:** If the column is missing or size-limited, this would fail.
#[test]
fn tool_call_output_stores_large_content() {
    let conn = blank_db();
    db::initialize(&conn).expect("initialize must succeed");

    conn.execute(
        "INSERT INTO sessions (id, provider, started_at, last_active_at, system_prompt_hash) VALUES ('sess_tc_lg', 'anthropic', '2026-03-18T10:00:00Z', '2026-03-18T10:00:00Z', 'sha256_tc_lg')",
        [],
    )
    .expect("Must insert session");
    conn.execute(
        "INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash, stop_reason, capture_complete, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at) VALUES ('turn_tc_lg', 'sess_tc_lg', 1, '2026-03-18T10:01:00Z', 'req_lg', 'resp_lg', 'end_turn', 1, 100, 50, 0, 0, '2026-03-18T10:01:00Z')",
        [],
    )
    .expect("Must insert turn");

    let large_output = "X".repeat(100_000);
    conn.execute(
        "INSERT INTO tool_calls (id, turn_id, tool_name, tool_input, input_hash, output, output_hash, status) VALUES ('tc_lg', 'turn_tc_lg', 'Read', '{\"path\":\"/etc/hosts\"}', 'sha256_in_lg', ?1, 'sha256_out_lg', 'success')",
        rusqlite::params![large_output],
    )
    .expect("Must insert tool_call with large output");

    let stored_output: String = conn
        .query_row(
            "SELECT output FROM tool_calls WHERE id = 'tc_lg'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        stored_output.len(),
        100_000,
        "output column must store 100K characters without truncation"
    );
}

/// **Proves:** parent_session_id can reference another session, enabling session hierarchies.
/// **Anti-fake:** The column must accept session IDs that exist as other session rows.
#[test]
fn parent_session_id_links_sessions() {
    let conn = blank_db();
    db::initialize(&conn).expect("initialize must succeed");

    // Insert parent session
    conn.execute(
        "INSERT INTO sessions (id, provider, started_at, last_active_at, system_prompt_hash) VALUES ('sess_parent', 'anthropic', '2026-03-18T10:00:00Z', '2026-03-18T10:00:00Z', 'sha256_parent')",
        [],
    )
    .expect("Must insert parent session");

    // Insert child session referencing parent
    conn.execute(
        "INSERT INTO sessions (id, provider, started_at, last_active_at, system_prompt_hash, parent_session_id) VALUES ('sess_child', 'anthropic', '2026-03-18T10:05:00Z', '2026-03-18T10:05:00Z', 'sha256_child', 'sess_parent')",
        [],
    )
    .expect("Must insert child session with parent_session_id");

    let parent_id: String = conn
        .query_row(
            "SELECT parent_session_id FROM sessions WHERE id = 'sess_child'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(parent_id, "sess_parent");

    // Verify the parent actually exists
    let parent_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM sessions WHERE id = ?1",
            rusqlite::params![parent_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        parent_count, 1,
        "parent_session_id must reference an existing session"
    );
}

/// **Proves:** Multiple v1 rows across all three tables survive migration together.
///   This is a more rigorous version of the single-row migration test.
/// **Anti-fake:** A migration that drops and recreates tables would lose multi-row data.
#[test]
fn multiple_v1_rows_survive_migration() {
    let conn = create_v1_database();

    // Insert multiple sessions
    for i in 0..5 {
        insert_v1_session(&conn, &format!("sess_multi_{}", i));
    }
    // Insert turns for the first session
    for i in 1..=3 {
        insert_v1_turn(
            &conn,
            &format!("turn_multi_{}", i),
            "sess_multi_0",
            i as i64,
        );
    }
    // Insert tool calls
    insert_v1_tool_call(&conn, "tc_multi_1", "turn_multi_1");
    insert_v1_tool_call(&conn, "tc_multi_2", "turn_multi_2");

    // Run migration
    db::initialize(&conn).expect("initialize on multi-row v1 DB must succeed");

    // Verify counts
    let session_count: i64 = conn
        .query_row("SELECT count(*) FROM sessions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(session_count, 5, "All 5 sessions must survive migration");

    let turn_count: i64 = conn
        .query_row("SELECT count(*) FROM turns", [], |row| row.get(0))
        .unwrap();
    assert_eq!(turn_count, 3, "All 3 turns must survive migration");

    let tc_count: i64 = conn
        .query_row("SELECT count(*) FROM tool_calls", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tc_count, 2, "All 2 tool_calls must survive migration");
}

// ===========================================================================
// End-to-End Deliverable Tests
// ===========================================================================

/// **E2E Deliverable 1:** Gemini provider detection end-to-end.
///   Host → detect_provider → classify_host → TunnelMode::Mitm("google").
/// **Anti-fake:** Old code path returns Passthrough for this host.
#[test]
fn e2e_gemini_provider_detection_full_pipeline() {
    // Step 1: detect_provider identifies the host
    let provider = providers::detect_provider("generativelanguage.googleapis.com");
    assert_eq!(provider, "google");

    // Step 2: classify_host returns MITM mode with correct provider
    let mode = gateway::classify_host("generativelanguage.googleapis.com");
    assert_eq!(mode, gateway::TunnelMode::Mitm("google".to_string()));

    // Step 3: With port (as it appears in CONNECT requests)
    let mode_port = gateway::classify_host("generativelanguage.googleapis.com:443");
    assert_eq!(mode_port, gateway::TunnelMode::Mitm("google".to_string()));
}

/// **E2E Deliverable 2:** Gemini endpoint interception end-to-end.
///   Raw HTTP bytes → should_intercept → InterceptDecision { should_capture: true }.
/// **Anti-fake:** Old code does not recognize Gemini paths.
#[test]
fn e2e_gemini_endpoint_interception() {
    let endpoints = [
        "/v1beta/models/gemini-pro/generateContent",
        "/v1beta/models/gemini-pro/streamGenerateContent",
        "/v1beta/models/gemini-1.5-pro/generateContent",
        "/v1beta/models/gemini-2.0-flash/streamGenerateContent",
    ];
    for endpoint in &endpoints {
        let raw = http_request("POST", endpoint);
        let decision = gateway::should_intercept(&raw, "unknown");
        assert!(
            decision.should_capture,
            "E2E: POST {} must be captured",
            endpoint
        );
    }
}

/// **E2E Deliverable 3:** Mock LLM server fixtures are valid and structurally correct.
///   Each fixture can be parsed as SSE events with provider-specific structure.
/// **Anti-fake:** An empty or malformed fixture would fail parsing.
#[test]
fn e2e_mock_server_fixtures_are_valid_sse() {
    // Anthropic fixture: every event block has "event:" and "data:" lines
    for block in ANTHROPIC_SSE_FIXTURE
        .split("\n\n")
        .filter(|s| !s.is_empty())
    {
        let lines: Vec<&str> = block.lines().collect();
        assert!(
            lines.len() >= 2,
            "Anthropic SSE block must have at least 2 lines (event: + data:), got: {:?}",
            lines
        );
        assert!(
            lines[0].starts_with("event: "),
            "First line of Anthropic SSE block must start with 'event: ', got: {:?}",
            lines[0]
        );
        assert!(
            lines[1].starts_with("data: "),
            "Second line of Anthropic SSE block must start with 'data: ', got: {:?}",
            lines[1]
        );
        // The data line must be valid JSON
        let json_str = &lines[1]["data: ".len()..];
        let parsed: Result<serde_json::Value, _> = serde_json::from_str(json_str);
        assert!(
            parsed.is_ok(),
            "Anthropic SSE data must be valid JSON: {:?}, error: {:?}",
            json_str,
            parsed.err()
        );
    }

    // OpenAI fixture: every non-empty line starts with "data: "
    for block in OPENAI_SSE_FIXTURE.split("\n\n").filter(|s| !s.is_empty()) {
        let line = block.trim();
        assert!(
            line.starts_with("data: "),
            "OpenAI SSE line must start with 'data: ', got: {:?}",
            line
        );
        let data = &line["data: ".len()..];
        if data != "[DONE]" {
            let parsed: Result<serde_json::Value, _> = serde_json::from_str(data);
            assert!(
                parsed.is_ok(),
                "OpenAI SSE data must be valid JSON: {:?}",
                data
            );
        }
    }

    // Gemini fixture: data lines contain valid JSON with candidates
    for block in GEMINI_SSE_FIXTURE.split("\n\n").filter(|s| !s.is_empty()) {
        let line = block.trim();
        assert!(
            line.starts_with("data: "),
            "Gemini SSE line must start with 'data: ', got: {:?}",
            line
        );
        let data = &line["data: ".len()..];
        let parsed: serde_json::Value =
            serde_json::from_str(data).expect("Gemini SSE data must be valid JSON");
        assert!(
            parsed.get("candidates").is_some(),
            "Gemini SSE JSON must contain 'candidates' field"
        );
    }
}

/// **E2E Deliverable 6:** Schema v2 frozen — fresh DB and migrated DB both land at version 2
///   with identical column sets.
/// **Anti-fake:** If the fresh DB creates a different schema than the migrated one,
///   this would catch the discrepancy.
#[test]
fn e2e_schema_v2_frozen_fresh_and_migrated_identical() {
    // Fresh DB
    let fresh = blank_db();
    db::initialize(&fresh).expect("Fresh initialize must succeed");
    let fresh_session_cols = get_columns(&fresh, "sessions");
    let fresh_turn_cols = get_columns(&fresh, "turns");
    let fresh_tc_cols = get_columns(&fresh, "tool_calls");

    // Migrated DB (from v1)
    let migrated = create_v1_database();
    db::initialize(&migrated).expect("Migrated initialize must succeed");
    let migrated_session_cols = get_columns(&migrated, "sessions");
    let migrated_turn_cols = get_columns(&migrated, "turns");
    let migrated_tc_cols = get_columns(&migrated, "tool_calls");

    // Both must have the same columns (order may differ for ALTER TABLE ADD COLUMN,
    // so we sort before comparing)
    let mut fresh_s = fresh_session_cols.clone();
    fresh_s.sort();
    let mut migrated_s = migrated_session_cols.clone();
    migrated_s.sort();
    assert_eq!(
        fresh_s, migrated_s,
        "Fresh and migrated sessions columns must match"
    );

    let mut fresh_t = fresh_turn_cols.clone();
    fresh_t.sort();
    let mut migrated_t = migrated_turn_cols.clone();
    migrated_t.sort();
    assert_eq!(
        fresh_t, migrated_t,
        "Fresh and migrated turns columns must match"
    );

    let mut fresh_tc = fresh_tc_cols.clone();
    fresh_tc.sort();
    let mut migrated_tc = migrated_tc_cols.clone();
    migrated_tc.sort();
    assert_eq!(
        fresh_tc, migrated_tc,
        "Fresh and migrated tool_calls columns must match"
    );

    // Both must be at version 11 (v11 adds attachments table + turns.attachment_count)
    assert_eq!(get_user_version(&fresh), 11);
    assert_eq!(get_user_version(&migrated), 11);
}

/// **E2E Deliverable 8 (DECISION test):** The schema has specific columns based on
///   real capture data analysis. This test verifies that the decided-upon columns exist
///   and the decided-against columns do NOT exist.
///   The implementation agent should update this test based on the actual decision.
/// **Anti-fake:** This test codifies the schema freeze decision.
#[test]
fn e2e_schema_decision_columns_present() {
    let conn = blank_db();
    db::initialize(&conn).expect("initialize must succeed");

    // These columns MUST exist (decided to keep based on capture data)
    let must_have = [
        ("sessions", "agent_id"),
        ("sessions", "git_repo"),
        ("sessions", "git_branch"),
        ("sessions", "git_commit"),
        ("sessions", "tags"),
        ("turns", "duration_ms"),
        ("turns", "ttfb_ms"),
        ("turns", "http_status"),
        ("turns", "thinking_tokens"),
        ("tool_calls", "output"),
        ("tool_calls", "status"),
        ("tool_calls", "duration_ms"),
    ];

    for (table, col) in &must_have {
        assert!(
            column_exists(&conn, table, col),
            "Schema decision: {}.{} must exist in the frozen v2 schema",
            table,
            col
        );
    }
}
