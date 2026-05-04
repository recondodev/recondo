//! Sprint M2: PostgreSQL DDL removal tests.
//!
//! The gateway must NOT create PostgreSQL tables on startup. Migrations are now
//! managed externally (by `just api-migrate`). The gateway should:
//!
//! 1. **Not execute any DDL on PostgreSQL connect** -- the historical
//!    `PG_SCHEMA_DDL` constant has been removed (audit finding H1, round 1)
//!    and `api/migrations/*.sql` is now the single source of truth.
//! 2. **Check** that required tables exist (e.g., `SELECT 1 FROM sessions LIMIT 0`).
//! 3. **Log an actionable error** when tables are missing.
//! 4. **Leave SQLite mode completely unchanged** -- it still self-manages its schema.
//!
//! ## Test strategy
//!
//! Most tests operate at the source-code/string level because:
//! - The `postgres` feature pulls in `deadpool-postgres` + `tokio-postgres` and
//!   requires a running PostgreSQL instance for integration tests.
//! - M2's core behavioral contract ("DDL is not executed") can be verified by
//!   inspecting source code patterns and ensuring no `batch_execute` call paths
//!   issue CREATE TABLE/INDEX/TRIGGER statements at runtime.
//!
//! Integration tests against a real PostgreSQL instance are gated behind
//! `#[cfg(feature = "postgres-tests")]` and require `RECONDO_DB_URL`.

// FIND-15-Rust-1: shared cross-process advisory-lock helper (see
// gateway/tests/common/pg_lock.rs for full rationale). Replaces the
// per-test-runtime `Box::leak` pattern that released the advisory lock
// when the per-test runtime dropped.
mod common;

// ---------------------------------------------------------------------------
// Helper: read a source file as a string at test time
// ---------------------------------------------------------------------------

fn read_source(relative_path: &str) -> String {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let path = std::path::Path::new(manifest_dir).join(relative_path);
    std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "Failed to read source file {}: {}. \
             Tests inspect source code to verify behavioral contracts.",
            path.display(),
            e
        )
    })
}

// ===========================================================================
// M2.2 — No DDL string is executed during PostgreSQL initialization
// (the historical PG_SCHEMA_DDL constant has been removed)
// ===========================================================================

/// **Proves:** `init_schema_with_client` no longer calls
/// `batch_execute(PG_SCHEMA_DDL)` (the historical DDL execution path).
///
/// After M2, the `init_schema_with_client` method should either:
/// - Be removed entirely, or
/// - Be replaced with a table-existence check (not DDL execution).
///
/// This test inspects the source of `postgres.rs` to verify that no code path
/// calls `batch_execute(PG_SCHEMA_DDL)`. The constant itself was removed in H1,
/// so this is a belt-and-braces check against any reintroduction.
#[test]
fn postgres_rs_does_not_execute_ddl_via_batch_execute() {
    let source = read_source("src/storage/postgres.rs");

    // Pre-M2 code had: client.batch_execute(PG_SCHEMA_DDL).
    // After M2 (and the H1 round-1 deletion of the constant), this
    // pattern must not exist.
    assert!(
        !source.contains("batch_execute(PG_SCHEMA_DDL)"),
        "postgres.rs must NOT contain batch_execute(PG_SCHEMA_DDL). \
         M2 removes DDL execution -- the gateway no longer creates tables on startup. \
         (The PG_SCHEMA_DDL constant was deleted in H1; this guards against reintroduction.)"
    );
}

/// **Proves:** `postgres.rs` does not call `batch_execute` with any DDL-like
/// content (not just the constant name). Guards against inlining the DDL string.
#[test]
fn postgres_rs_does_not_inline_create_table_in_batch_execute() {
    let source = read_source("src/storage/postgres.rs");

    // Check that no batch_execute call contains CREATE TABLE
    // (guards against someone inlining the DDL instead of using the constant)
    let lines: Vec<&str> = source.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if line.contains("batch_execute") && !line.trim_start().starts_with("//") {
            // Look at surrounding context (next 5 lines) for CREATE TABLE
            let context_end = (i + 5).min(lines.len());
            let context: String = lines[i..context_end].join("\n");
            assert!(
                !context.to_uppercase().contains("CREATE TABLE"),
                "Found batch_execute near CREATE TABLE at line {}. \
                 M2 forbids DDL execution on startup. Context:\n{}",
                i + 1,
                context
            );
        }
    }
}

/// **Proves:** The `pool.rs` ConnectionPool::postgres() no longer calls
/// `init_schema_with_client`. The pool initialization path must not execute DDL.
#[test]
fn pool_rs_does_not_call_init_schema_with_client() {
    let source = read_source("src/storage/pool.rs");

    assert!(
        !source.contains("init_schema_with_client"),
        "pool.rs must NOT call init_schema_with_client after M2. \
         The gateway no longer creates PG tables on startup."
    );
}

/// **Proves:** `PostgresGraphStore::new()` and `from_pool()` no longer call
/// `initialize_schema()` which was the DDL execution path.
///
/// After M2, construction should either:
/// - Call a table-existence check instead, or
/// - Skip schema init entirely (deferring to the first query).
#[test]
fn postgres_store_constructors_do_not_call_initialize_schema() {
    let source = read_source("src/storage/postgres.rs");

    // Count occurrences of initialize_schema() calls (not the fn definition itself).
    // The function definition line contains "async fn initialize_schema"
    // The call sites contain "store.block_on(store.initialize_schema())"
    // or similar. After M2, there should be zero call sites.
    let call_count = source
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            trimmed.contains("initialize_schema()")
                && !trimmed.starts_with("//")
                && !trimmed.starts_with("///")
                && !trimmed.contains("async fn initialize_schema")
                && !trimmed.contains("fn initialize_schema")
        })
        .count();

    assert_eq!(
        call_count, 0,
        "postgres.rs must have zero call sites for initialize_schema(). \
         Found {} call(s). M2 removes DDL execution from all constructor paths.",
        call_count
    );
}

// ===========================================================================
// M2.3 — Startup table-existence check
// ===========================================================================

/// **Proves:** `postgres.rs` contains a table-existence check query.
///
/// M2 replaces DDL execution with a probe: `SELECT 1 FROM sessions LIMIT 0`
/// (or equivalent). If the query fails, the gateway logs an actionable error.
#[test]
fn postgres_rs_contains_table_existence_check() {
    let source = read_source("src/storage/postgres.rs");

    // The check should query the sessions table to verify it exists.
    // Accept various forms: "SELECT 1 FROM sessions", "SELECT 1 FROM sessions LIMIT 0",
    // or an information_schema query.
    let has_sessions_probe = source.contains("FROM sessions")
        || source.contains("from sessions")
        || source.contains("information_schema")
        || source.contains("pg_tables");

    assert!(
        has_sessions_probe,
        "postgres.rs must contain a table-existence check that probes the sessions table. \
         Expected a query like 'SELECT 1 FROM sessions LIMIT 0' or an information_schema lookup."
    );
}

/// **Proves:** The source contains the actionable error message telling operators
/// to run migrations before starting the gateway.
#[test]
fn postgres_rs_contains_actionable_migration_error_message() {
    let source = read_source("src/storage/postgres.rs");

    // The error message must tell the operator what to do.
    // Check for key phrases from the design doc.
    let has_table_not_found = source.contains("not found")
        || source.contains("does not exist")
        || source.contains("missing");

    let has_migration_instruction = source.contains("api-migrate")
        || source.contains("migrate")
        || source.contains("migration");

    assert!(
        has_table_not_found,
        "postgres.rs must contain an error message indicating tables are not found/missing \
         when the sessions table does not exist."
    );

    assert!(
        has_migration_instruction,
        "postgres.rs must contain an error message referencing migrations \
         (e.g., 'Run just api-migrate before starting the gateway')."
    );
}

// ===========================================================================
// M2.4 — SQLite mode is completely unchanged
// ===========================================================================

/// **Proves:** SQLite's `db::initialize()` still creates tables (self-managed).
/// M2 does NOT change SQLite behavior.
#[test]
fn sqlite_initialize_still_creates_tables() {
    let conn = recondo_gateway::db::open_in_memory().expect("Must open in-memory SQLite");
    recondo_gateway::db::initialize(&conn)
        .expect("SQLite initialize must still succeed -- M2 does not change SQLite");

    // Verify all core tables exist.
    for table_name in &["sessions", "turns", "tool_calls"] {
        let count: i64 = conn
            .query_row(
                &format!(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='{}'",
                    table_name
                ),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            count, 1,
            "SQLite table '{}' must exist after initialize -- M2 does not change SQLite",
            table_name
        );
    }
}

/// **Proves:** SQLite initialization is still idempotent after M2.
#[test]
fn sqlite_initialize_still_idempotent() {
    let conn = recondo_gateway::db::open_in_memory().unwrap();
    recondo_gateway::db::initialize(&conn).unwrap();
    let result = recondo_gateway::db::initialize(&conn);
    assert!(
        result.is_ok(),
        "SQLite initialize must remain idempotent -- M2 does not change SQLite"
    );
}

/// **Proves:** SQLite read/write still works after M2 changes.
/// Insert a session and retrieve it to verify the full round-trip.
#[test]
fn sqlite_session_roundtrip_unaffected_by_m2() {
    use recondo_gateway::db::{self, SessionRecord};

    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();

    let session = SessionRecord {
        id: "m2_test_session".to_string(),
        provider: "anthropic".to_string(),
        model: Some("claude-sonnet-4-20250514".to_string()),
        started_at: "2026-03-24T10:00:00Z".to_string(),
        last_active_at: "2026-03-24T10:05:00Z".to_string(),
        ended_at: None,
        initial_intent: Some("M2 test".to_string()),
        system_prompt_hash: "m2hash".to_string(),
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
    };

    db::insert_session(&conn, &session).unwrap();
    let retrieved = db::get_session(&conn, "m2_test_session")
        .unwrap()
        .expect("Session must be retrievable after M2");

    assert_eq!(retrieved.id, "m2_test_session");
    assert_eq!(retrieved.provider, "anthropic");
    assert_eq!(retrieved.initial_intent, Some("M2 test".to_string()));
}

/// **Proves:** The SQLite `db/mod.rs` module was NOT modified by M2.
/// We verify that `db::initialize` still calls `CREATE TABLE IF NOT EXISTS`
/// for the core tables -- the SQLite self-management pattern is preserved.
#[test]
fn sqlite_db_mod_still_contains_create_table_statements() {
    let source = read_source("src/db/mod.rs");

    assert!(
        source.contains("CREATE TABLE IF NOT EXISTS sessions"),
        "db/mod.rs must still contain CREATE TABLE for sessions (SQLite self-manages)"
    );
    assert!(
        source.contains("CREATE TABLE IF NOT EXISTS turns"),
        "db/mod.rs must still contain CREATE TABLE for turns (SQLite self-manages)"
    );
    assert!(
        source.contains("CREATE TABLE IF NOT EXISTS tool_calls"),
        "db/mod.rs must still contain CREATE TABLE for tool_calls (SQLite self-manages)"
    );
}

// ===========================================================================
// M2.5 — create_from_env still works for SQLite (default path)
// ===========================================================================

/// **Proves:** The default `create_from_env()` path (SQLite) is unaffected by M2.
/// When `RECONDO_STORE` is not set (or set to "sqlite"), storage creation succeeds.
#[test]
fn create_from_env_sqlite_default_unaffected() {
    // Ensure we are in SQLite mode (the default).
    // Note: nextest runs each test in its own process, so env mutation is safe.
    std::env::remove_var("RECONDO_STORE");
    std::env::remove_var("RECONDO_DATA_DIR");

    let result = recondo_gateway::storage::create_from_env();
    assert!(
        result.is_ok(),
        "create_from_env with default SQLite must still succeed after M2: {:?}",
        result.err()
    );
}

// ===========================================================================
// M2.6 — The `initialize_schema` / `init_schema_with_client` methods are
//         either removed or no longer execute DDL
// ===========================================================================

/// **Proves:** If `init_schema_with_client` still exists in postgres.rs, it
/// must NOT contain `batch_execute(PG_SCHEMA_DDL)` (the historical DDL
/// execution call — the PG_SCHEMA_DDL constant has been removed). It should
/// either be removed or replaced with a table-existence check.
#[test]
fn init_schema_with_client_does_not_execute_ddl_if_present() {
    let source = read_source("src/storage/postgres.rs");

    if source.contains("init_schema_with_client") {
        // The function exists -- verify it does not execute DDL.
        // Find all lines between the function signature and the next `}` at the same level.
        let mut in_function = false;
        let mut function_body = String::new();

        for line in source.lines() {
            if line.contains("fn init_schema_with_client") {
                in_function = true;
            }
            if in_function {
                function_body.push_str(line);
                function_body.push('\n');
                // Simple heuristic: function ends at a `}` that starts at column 4
                // (end of the `impl` method). This is not perfect but catches the
                // obvious case.
                if line.trim() == "}" && function_body.matches('\n').count() > 2 {
                    break;
                }
            }
        }

        assert!(
            !function_body.contains("batch_execute(PG_SCHEMA_DDL)"),
            "init_schema_with_client must NOT call batch_execute(PG_SCHEMA_DDL) \
             (the historical PG_SCHEMA_DDL constant has been removed). \
             M2 replaces DDL execution with a table-existence check."
        );
    }
    // If the function was removed entirely, the test passes -- that is also valid.
}

/// **Proves:** If `initialize_schema` (the private async method) still exists,
/// it must not call `init_schema_with_client` which was the DDL execution path.
#[test]
fn private_initialize_schema_does_not_delegate_to_ddl_execution() {
    let source = read_source("src/storage/postgres.rs");

    // If initialize_schema still exists as a function definition...
    if source.contains("async fn initialize_schema") {
        // Extract the function body
        let mut in_function = false;
        let mut function_body = String::new();
        let mut brace_depth = 0;

        for line in source.lines() {
            if line.contains("async fn initialize_schema") {
                in_function = true;
            }
            if in_function {
                brace_depth += line.matches('{').count();
                brace_depth -= line.matches('}').count();
                function_body.push_str(line);
                function_body.push('\n');
                if brace_depth == 0 && function_body.len() > 10 {
                    break;
                }
            }
        }

        assert!(
            !function_body.contains("init_schema_with_client"),
            "initialize_schema must NOT delegate to init_schema_with_client \
             (the DDL execution path). It should perform a table-existence check instead."
        );
    }
    // If removed, that is fine -- the test passes.
}

// ===========================================================================
// M2.9 — The `from_pool_no_init` constructor is preserved
// ===========================================================================

/// **Proves:** `from_pool_no_init` still exists in postgres.rs. This constructor
/// was already skip-init by design (used by ConnectionPool::graph_store).
/// After M2, all constructors effectively behave like from_pool_no_init
/// (plus a table-existence check), but the method itself should remain for
/// backward compatibility.
#[test]
fn from_pool_no_init_constructor_still_exists() {
    let source = read_source("src/storage/postgres.rs");

    assert!(
        source.contains("from_pool_no_init"),
        "postgres.rs must still have from_pool_no_init (used by ConnectionPool::graph_store)"
    );
}

// ===========================================================================
// M2.10 — Integration tests (require running PostgreSQL)
// ===========================================================================

/// **Proves:** When connecting to a PostgreSQL database where tables DO exist
/// (migrations have been run), the gateway starts successfully and can read.
///
/// Requires: `cargo nextest run --features postgres-tests` with
/// `RECONDO_DB_URL` pointing to a database where migrations have been applied.
// FIND-10-C / FIND-10-I / FIND-15-Rust-1: cross-process advisory
// lock key. The canonical source is `common::pg_lock::SHARED_SCHEMA_LOCK_KEY`;
// historical sites in this file used a local `const` with the same
// numeric value. The local constant is removed in favor of the shared
// helper, which acquires the lock from a process-scoped runtime so the
// connection (and therefore the lock) survives every per-test runtime
// drop. Round 14 used a per-test-runtime + Box::leak pattern that
// released the lock at function exit.

#[test]
#[cfg(feature = "postgres-tests")]
fn pg_with_migrated_tables_starts_successfully() {
    // FIND-6-N: the unused `use serial_test::serial;` was a dead
    // import left over from when this test tried to serialise via
    // in-process mutex. Cross-process serialisation is now handled
    // by the `pg-mutex` test-group in `gateway/.config/nextest.toml`.

    let db_url = common::pg_container::url();

    // The gateway should be able to create a PostgresGraphStore without error
    // when the tables already exist.
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let pool = recondo_gateway::storage::postgres::create_pg_pool(db_url)
            .expect("Pool creation must succeed");

        // After M2, PostgresGraphStore::new or from_pool should succeed
        // because the table-existence check passes (tables were migrated).
        let store = recondo_gateway::storage::postgres::PostgresGraphStore::from_pool(pool);
        assert!(
            store.is_ok(),
            "PostgresGraphStore::from_pool must succeed when tables exist: {:?}",
            store.err()
        );
    });
}

/// **Proves:** When connecting to a PostgreSQL database where tables do NOT exist,
/// the gateway returns an error (not a panic) with an actionable message.
///
/// Requires: `cargo nextest run --features postgres-tests` with
/// `RECONDO_DB_URL` pointing to an EMPTY database (no recondo tables).
/// You can create one with: `createdb recondo_test_empty`
#[test]
#[cfg(feature = "postgres-tests")]
fn pg_without_tables_returns_actionable_error() {
    let db_url = common::pg_container::url_empty();

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let pool = recondo_gateway::storage::postgres::create_pg_pool(db_url)
            .expect("connect to empty pg container");

        let store = recondo_gateway::storage::postgres::PostgresGraphStore::from_pool(pool);

        // Must fail with an actionable error, not succeed silently.
        assert!(
            store.is_err(),
            "PostgresGraphStore must fail when required tables do not exist"
        );

        let err_msg = format!("{}", store.err().unwrap());
        assert!(
            err_msg.contains("sessions") || err_msg.contains("table"),
            "Error must mention the missing table. Got: {}",
            err_msg
        );
        assert!(
            err_msg.contains("migrate") || err_msg.contains("api-migrate"),
            "Error must mention migration instructions. Got: {}",
            err_msg
        );
    });
}
