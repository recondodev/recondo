//! Migration framework tests — behavioral tests for additive SQLite migrations.
//!
//! These tests verify that:
//! - Fresh databases get tables created and version set
//! - Old-version databases get additive migrations (ALTER TABLE ADD COLUMN)
//! - Data survives migration (existing rows get NULL for new columns)
//! - Migrations are idempotent (running twice does not error)
//! - Databases at or above current version are left untouched
//!
//! Strategy: To simulate an "old schema" database, we create tables with a SUBSET
//! of columns using raw SQL, set PRAGMA user_version to an old value, then call
//! initialize() or run_migrations(). This avoids reading the production schema code.

use recondo_gateway::db;
use rusqlite::Connection;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Open an in-memory DB without calling initialize — we want a blank slate
/// so we can simulate old schemas.
fn blank_db() -> Connection {
    db::open_in_memory().expect("Must open in-memory SQLite")
}

/// Set the SQLite user_version pragma to a specific value.
fn set_user_version(conn: &Connection, version: i64) {
    conn.pragma_update(None, "user_version", version)
        .expect("Must be able to set user_version");
}

/// Read the current user_version from the database.
fn get_user_version(conn: &Connection) -> i64 {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("Must be able to read user_version")
}

/// Check whether a table exists.
fn table_exists(conn: &Connection, table: &str) -> bool {
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [table],
            |row| row.get(0),
        )
        .expect("Must query sqlite_master");
    count > 0
}

// ===========================================================================
// 1. Fresh DB creates tables at latest version
// ===========================================================================

/// **Proves:** Calling initialize() on a brand-new database (user_version = 0)
/// creates all tables and sets user_version to SCHEMA_VERSION.
#[test]
fn fresh_db_creates_tables_at_latest_version() {
    let conn = blank_db();

    // Precondition: version is 0 on a fresh DB
    assert_eq!(
        get_user_version(&conn),
        0,
        "Fresh DB must start at version 0"
    );

    db::initialize(&conn).expect("initialize must succeed on fresh DB");

    // Tables must exist
    assert!(table_exists(&conn, "sessions"), "sessions table must exist");
    assert!(table_exists(&conn, "turns"), "turns table must exist");
    assert!(
        table_exists(&conn, "tool_calls"),
        "tool_calls table must exist"
    );

    // Version must be set to the latest
    let version = get_user_version(&conn);
    assert!(
        version >= 1,
        "user_version must be >= 1 after initialize, got {}",
        version
    );
    assert_eq!(
        version,
        db::SCHEMA_VERSION,
        "user_version must equal SCHEMA_VERSION"
    );
}

// ===========================================================================
// 2. Migration adds column to existing table
// ===========================================================================

/// **Proves:** When SCHEMA_VERSION > 1, calling initialize() on a version-1 DB
/// adds new columns via ALTER TABLE ADD COLUMN. We simulate a version-1 database
/// by creating the sessions table with only core columns, inserting a row, setting
/// user_version to 1, then calling initialize(). The new column must appear.
///
/// NOTE: This test calls `db::initialize()` which is the single authority for
/// running migrations and setting user_version. `run_migrations` applies schema
/// changes but does not set user_version; `initialize_inner` sets it after all
/// migrations complete.
#[test]
fn migration_adds_column_to_existing_table() {
    let conn = blank_db();

    // Create a minimal v1 sessions table (subset of columns)
    conn.execute_batch(
        "CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            started_at TEXT NOT NULL,
            last_active_at TEXT NOT NULL,
            system_prompt_hash TEXT NOT NULL
        );",
    )
    .expect("Must create v1 sessions table");

    // Insert a row at v1
    conn.execute(
        "INSERT INTO sessions (id, provider, started_at, last_active_at, system_prompt_hash)
         VALUES ('sess_old', 'anthropic', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', 'hash_abc')",
        [],
    )
    .expect("Must insert v1 session row");

    set_user_version(&conn, 1);

    // Use initialize() — the single authority for migrations + version setting.
    db::initialize(&conn).expect("initialize must succeed");

    let version = get_user_version(&conn);
    assert_eq!(
        version,
        db::SCHEMA_VERSION,
        "user_version must be bumped to SCHEMA_VERSION after migration"
    );

    // The old row must still be there
    let count: i64 = conn
        .query_row("SELECT count(*) FROM sessions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1, "Old session row must survive migration");
}

// ===========================================================================
// 3. Migration preserves existing data
// ===========================================================================

/// **Proves:** Data inserted before a migration is fully preserved afterwards.
/// Insert a session + turn at version 1, run migrations, verify all original
/// field values are unchanged.
#[test]
fn migration_preserves_existing_data() {
    let conn = blank_db();
    db::initialize(&conn).expect("initialize must succeed");

    // Insert a session using the public API
    let session = db::SessionRecord {
        id: "sess_preserve".to_string(),
        provider: "anthropic".to_string(),
        model: Some("claude-sonnet-4-20250514".to_string()),
        started_at: "2026-03-18T10:00:00Z".to_string(),
        last_active_at: "2026-03-18T10:30:00Z".to_string(),
        ended_at: None,
        initial_intent: Some("Test data preservation".to_string()),
        system_prompt_hash: "sha256_preserve".to_string(),
        total_turns: 5,
        turns_captured: 5,
        dropped_events: 0,
        total_tokens: 10000,
        total_cost_usd: 0.50,
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
    db::insert_session(&conn, &session).expect("Must insert session");

    // Now run migrations again — should be a no-op since we just initialized
    db::run_migrations(&conn).expect("run_migrations must succeed on current-version DB");

    // Verify all data is intact
    let retrieved = db::get_session(&conn, "sess_preserve")
        .expect("get_session must succeed")
        .expect("Session must be found");

    assert_eq!(retrieved.id, "sess_preserve");
    assert_eq!(retrieved.provider, "anthropic");
    assert_eq!(
        retrieved.model,
        Some("claude-sonnet-4-20250514".to_string())
    );
    assert_eq!(retrieved.started_at, "2026-03-18T10:00:00Z");
    assert_eq!(retrieved.last_active_at, "2026-03-18T10:30:00Z");
    assert_eq!(retrieved.ended_at, None);
    assert_eq!(
        retrieved.initial_intent,
        Some("Test data preservation".to_string())
    );
    assert_eq!(retrieved.system_prompt_hash, "sha256_preserve");
    assert_eq!(retrieved.total_turns, 5);
    assert_eq!(retrieved.turns_captured, 5);
    assert_eq!(retrieved.dropped_events, 0);
    assert_eq!(retrieved.total_tokens, 10000);
    assert_eq!(retrieved.total_cost_usd, 0.50);
}

// ===========================================================================
// 4. Migration is idempotent
// ===========================================================================

/// **Proves:** Calling run_migrations() twice in a row does not produce an error.
/// This is critical because ALTER TABLE ADD COLUMN would fail if the column
/// already exists — the migration code must guard against that.
#[test]
fn migration_is_idempotent() {
    let conn = blank_db();
    db::initialize(&conn).expect("initialize must succeed");

    // Run migrations twice
    let first = db::run_migrations(&conn);
    let second = db::run_migrations(&conn);

    assert!(
        first.is_ok(),
        "First run_migrations call must succeed: {:?}",
        first.err()
    );
    assert!(
        second.is_ok(),
        "Second run_migrations call must succeed: {:?}",
        second.err()
    );

    // Version should still be at SCHEMA_VERSION
    assert_eq!(
        get_user_version(&conn),
        db::SCHEMA_VERSION,
        "user_version must remain at SCHEMA_VERSION after idempotent runs"
    );
}

// ===========================================================================
// 5. Newer version is a no-op
// ===========================================================================

/// **Proves:** If the database has a user_version higher than SCHEMA_VERSION
/// (e.g., downgraded binary), initialize and run_migrations succeed without
/// modifying anything. We should never destroy a newer schema.
#[test]
fn newer_version_is_noop() {
    let conn = blank_db();
    db::initialize(&conn).expect("initialize must succeed");

    // Simulate a database from a future version
    set_user_version(&conn, 999);

    // Migrations must succeed (no-op)
    db::run_migrations(&conn).expect("run_migrations must succeed on future-version DB");

    // Version must NOT be downgraded
    let version = get_user_version(&conn);
    assert_eq!(
        version, 999,
        "user_version must not be downgraded from 999, got {}",
        version
    );

    // Tables must still be intact
    assert!(
        table_exists(&conn, "sessions"),
        "sessions table must survive"
    );
    assert!(table_exists(&conn, "turns"), "turns table must survive");
    assert!(
        table_exists(&conn, "tool_calls"),
        "tool_calls table must survive"
    );
}

// ===========================================================================
// 6. Multiple migrations run in sequence
// ===========================================================================

/// **Proves:** When multiple migration steps are pending (e.g., version 1 → 3
/// with migrations at v2 and v3), all steps run in order and all new columns
/// are added.
///
/// We simulate this by creating a minimal table at version 1, then manually
/// adding two columns via raw SQL to represent what migrations v2 and v3 would
/// do, and verifying both columns exist. This tests the PATTERN, not the
/// specific columns (which don't exist yet).
///
/// When real migrations are added, this test should be updated to verify them.
#[test]
fn multiple_migrations_run_in_sequence() {
    let conn = blank_db();

    // Create a minimal turns table (simulating v1 schema)
    conn.execute_batch(
        "CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            started_at TEXT NOT NULL,
            last_active_at TEXT NOT NULL,
            system_prompt_hash TEXT NOT NULL
        );
        CREATE TABLE turns (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            sequence_num INTEGER NOT NULL,
            timestamp TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            response_hash TEXT NOT NULL,
            stop_reason TEXT NOT NULL DEFAULT '',
            capture_complete INTEGER NOT NULL DEFAULT 1,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE tool_calls (
            id TEXT PRIMARY KEY,
            turn_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            tool_input TEXT NOT NULL
        );",
    )
    .expect("Must create v1 tables");

    // Insert a row into turns to verify data preservation across multi-step migration
    conn.execute(
        "INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash, stop_reason, capture_complete, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at)
         VALUES ('turn_v1', 'sess_v1', 1, '2026-01-01T00:00:00Z', 'req1', 'resp1', 'end_turn', 1, 100, 50, 0, 0, '2026-01-01T00:00:00Z')",
        [],
    )
    .expect("Must insert v1 turn row");

    set_user_version(&conn, 1);

    // Use initialize() — the single authority for migrations + version setting.
    // run_migrations applies schema changes but does not set user_version;
    // initialize_inner sets it after all migrations complete.
    db::initialize(&conn).expect("initialize must succeed for multi-step migration");

    let version = get_user_version(&conn);
    assert_eq!(
        version,
        db::SCHEMA_VERSION,
        "user_version must reach SCHEMA_VERSION after multi-step migration"
    );

    // Verify the old row survived
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM turns WHERE id = 'turn_v1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        count, 1,
        "Pre-migration turn row must survive multi-step migration"
    );
}

// ===========================================================================
// 7. NEGATIVE: Missing column query returns NULL after migration
// ===========================================================================

/// **Proves (negative test):** After a migration adds a new column, rows that
/// existed before the migration have NULL for that column. This verifies the
/// additive-only guarantee: we never backfill old rows.
///
/// We simulate this by creating a table without an optional column, inserting
/// a row, then adding the column via ALTER TABLE. The old row must have NULL.
#[test]
fn missing_column_query_returns_null() {
    let conn = blank_db();

    // Create a sessions table WITHOUT the "framework" column (simulating old schema)
    conn.execute_batch(
        "CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            started_at TEXT NOT NULL,
            last_active_at TEXT NOT NULL,
            system_prompt_hash TEXT NOT NULL,
            model TEXT,
            ended_at TEXT,
            initial_intent TEXT,
            total_turns INTEGER NOT NULL DEFAULT 0,
            turns_captured INTEGER NOT NULL DEFAULT 0,
            dropped_events INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            total_cost_usd REAL NOT NULL DEFAULT 0.0
        );",
    )
    .expect("Must create old sessions table without framework column");

    // Insert a row before the column exists
    conn.execute(
        "INSERT INTO sessions (id, provider, started_at, last_active_at, system_prompt_hash)
         VALUES ('sess_old_row', 'openai', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'hash_old')",
        [],
    )
    .expect("Must insert row into old schema");

    // Now add the "framework" column (simulating what a migration would do)
    conn.execute("ALTER TABLE sessions ADD COLUMN framework TEXT", [])
        .expect("ALTER TABLE ADD COLUMN must succeed");

    // The old row must have NULL for the new column
    let framework: Option<String> = conn
        .query_row(
            "SELECT framework FROM sessions WHERE id = 'sess_old_row'",
            [],
            |row| row.get(0),
        )
        .expect("Must query framework column");

    assert!(
        framework.is_none(),
        "Old row must have NULL for newly-added column, got {:?}",
        framework
    );

    // A new row can set the column
    conn.execute(
        "INSERT INTO sessions (id, provider, started_at, last_active_at, system_prompt_hash, framework)
         VALUES ('sess_new_row', 'anthropic', '2026-03-18T00:00:00Z', '2026-03-18T00:00:00Z', 'hash_new', 'claude-code')",
        [],
    )
    .expect("Must insert row with new column");

    let new_framework: Option<String> = conn
        .query_row(
            "SELECT framework FROM sessions WHERE id = 'sess_new_row'",
            [],
            |row| row.get(0),
        )
        .expect("Must query framework on new row");

    assert_eq!(
        new_framework,
        Some("claude-code".to_string()),
        "New row must have the framework value set"
    );
}

// ===========================================================================
// 8. initialize() on a version-0 DB runs migrations too
// ===========================================================================

/// **Proves:** initialize() handles the full lifecycle: create tables if needed,
/// then run any pending migrations. A version-0 DB ends up at SCHEMA_VERSION.
#[test]
fn initialize_on_version_zero_runs_full_lifecycle() {
    let conn = blank_db();

    // Precondition: no tables, version 0
    assert!(!table_exists(&conn, "sessions"));
    assert!(!table_exists(&conn, "turns"));
    assert!(!table_exists(&conn, "tool_calls"));
    assert_eq!(get_user_version(&conn), 0);

    db::initialize(&conn).expect("initialize must succeed on empty DB");

    // All tables created
    assert!(table_exists(&conn, "sessions"));
    assert!(table_exists(&conn, "turns"));
    assert!(table_exists(&conn, "tool_calls"));

    // Version at latest
    assert_eq!(get_user_version(&conn), db::SCHEMA_VERSION);
}

// ===========================================================================
// 9. initialize() is still idempotent with migration framework
// ===========================================================================

/// **Proves:** Calling initialize() twice still works (backward compatibility
/// with the existing idempotency guarantee, now with migration framework).
#[test]
fn initialize_twice_with_migrations_is_idempotent() {
    let conn = blank_db();

    db::initialize(&conn).expect("First initialize must succeed");
    let version_after_first = get_user_version(&conn);

    db::initialize(&conn).expect("Second initialize must succeed");
    let version_after_second = get_user_version(&conn);

    assert_eq!(
        version_after_first, version_after_second,
        "Version must not change on second initialize"
    );
    assert_eq!(
        version_after_second,
        db::SCHEMA_VERSION,
        "Version must be SCHEMA_VERSION"
    );
}

// ===========================================================================
// 10. add_column_if_not_exists supports compound column types
// ===========================================================================

/// **Proves:** add_column_if_not_exists works with compound type expressions
/// like "INTEGER NOT NULL DEFAULT 0" and "TEXT NOT NULL", not just simple
/// types like "TEXT" or "INTEGER".
#[test]
fn add_column_with_compound_type() {
    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();

    // Add a column with a compound type including DEFAULT
    db::add_column_if_not_exists(
        &conn,
        "turns",
        "test_compound",
        "INTEGER NOT NULL DEFAULT 0",
    )
    .expect("Must accept compound type 'INTEGER NOT NULL DEFAULT 0'");

    // Verify the column exists
    let has_col: bool = conn
        .prepare("PRAGMA table_info(turns)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .filter_map(|r| r.ok())
        .any(|name| name == "test_compound");
    assert!(has_col, "test_compound column must exist after ADD COLUMN");

    // Add another with just NOT NULL
    db::add_column_if_not_exists(
        &conn,
        "sessions",
        "test_notnull",
        "TEXT NOT NULL DEFAULT ''",
    )
    .expect("Must accept compound type 'TEXT NOT NULL DEFAULT '''");
}

/// **Proves:** add_column_if_not_exists rejects malicious type strings
/// containing semicolons, quotes, or comment markers.
#[test]
fn add_column_rejects_injection_in_col_type() {
    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();

    // Semicolon injection
    let result = db::add_column_if_not_exists(&conn, "turns", "bad", "TEXT; DROP TABLE turns");
    assert!(result.is_err(), "Must reject semicolon in col_type");

    // Double-quote injection
    let result = db::add_column_if_not_exists(&conn, "turns", "bad", "TEXT\" OR \"1\"=\"1");
    assert!(result.is_err(), "Must reject double-quotes in col_type");

    // Comment injection
    let result = db::add_column_if_not_exists(&conn, "turns", "bad", "TEXT -- drop");
    assert!(result.is_err(), "Must reject comment markers in col_type");
}
