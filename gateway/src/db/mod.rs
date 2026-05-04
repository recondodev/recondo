// =============================================================================
// Schema v2 columns — present in the DB schema, not yet populated by the
// capture pipeline. The columns exist with DEFAULT values so inserts without
// specifying them succeed. Population will happen when Phase 2 capture
// pipeline integration is built.
//
// sessions (8 schema-ready):
//   agent_id, agent_version, git_repo, git_branch, git_commit,
//   working_directory, parent_session_id, tags
//
// turns (9 schema-ready, provider already existed in v1):
//   duration_ms, ttfb_ms, api_endpoint, http_status,
//   error_message, retry_count, tool_call_count, thinking_tokens, server_id
//
// tool_calls (6 schema-ready):
//   sequence_num, output, output_hash, duration_ms, error, status
//
// These columns ARE in the schema (added in v2 migration) but are NOT yet
// populated by the capture pipeline. Old rows have NULL or DEFAULT 0.
//
// NOTE: system_prompt_hash is NOT NULL, which is stricter than the roadmap.
// This is intentional — the session module always computes a hash (using a
// sentinel value for absent system prompts), so NULL never occurs in practice.
//
// NOTE: Counter columns (total_turns, turns_captured, dropped_events,
// total_tokens, total_cost_usd) are NOT NULL DEFAULT 0. This is stricter
// than the roadmap but better — counters should never be NULL.
//
// NOTE: TurnRecord will be populated from the capture pipeline when the
// gateway → DB integration is built. Currently CaptureRecord and TurnRecord
// are not connected — this is expected for incremental development.
// =============================================================================

use anyhow::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

pub mod model_pricing;

pub use model_pricing::{PricingEntry, PricingTable, TierEntry};

/// A session record in the database.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionRecord {
    pub id: String,
    pub provider: String,
    pub model: Option<String>,
    pub started_at: String,
    pub last_active_at: String,
    pub ended_at: Option<String>,
    pub initial_intent: Option<String>,
    pub system_prompt_hash: String,
    pub total_turns: i64,
    pub turns_captured: i64,
    pub dropped_events: i64,
    pub total_tokens: i64,
    pub total_cost_usd: f64,
    pub framework: Option<String>,
    // v2 fields
    pub agent_id: Option<String>,
    pub agent_version: Option<String>,
    pub git_repo: Option<String>,
    pub git_branch: Option<String>,
    pub git_commit: Option<String>,
    pub working_directory: Option<String>,
    pub parent_session_id: Option<String>,
    pub tags: Option<String>,
    // v3 fields: identity tracking
    pub account_uuid: Option<String>,
    pub device_id: Option<String>,
    // Sprint 7 Phase 2: tool definition drift detection
    pub tool_definitions_hash: String,
}

/// A turn record in the database.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnRecord {
    pub id: String,
    pub session_id: String,
    pub sequence_num: i64,
    pub timestamp: String,
    // Chain of custody
    pub request_hash: String,
    pub response_hash: String,
    pub req_bytes_ref: Option<String>,
    pub resp_bytes_ref: Option<String>,
    pub req_bytes_size: Option<i64>,
    pub resp_bytes_size: Option<i64>,
    // Parsed fields (model is nullable for resilience; the capture pipeline
    // should use "unknown" as a fallback, but the DB allows NULL)
    pub model: Option<String>,
    pub response_text: Option<String>,
    pub thinking_text: Option<String>,
    pub stop_reason: String,
    // Processing integrity
    pub capture_complete: bool,
    // Metrics
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cost_usd: Option<f64>,
    pub created_at: String,
    // messages_delta compression (Week 2 Task 5)
    pub messages_delta: Option<String>,
    pub messages_delta_count: Option<i64>,
    // Forward compatibility fields (OD-007)
    pub raw_extra: Option<String>,
    pub parser_version: Option<String>,
    pub parse_errors: Option<String>,
    // Provider name (e.g., "anthropic", "openai") — added in schema v5
    pub provider: Option<String>,
    // Transport type: "http" or "websocket" — added in schema v6
    pub transport: Option<String>,
    // WebSocket direction: "client_to_server" or "server_to_client" — added in schema v6
    pub ws_direction: Option<String>,
    // v2 fields
    pub duration_ms: Option<i64>,
    pub ttfb_ms: Option<i64>,
    pub api_endpoint: Option<String>,
    pub http_status: Option<i64>,
    pub error_message: Option<String>,
    pub retry_count: i64,
    pub tool_call_count: i64,
    pub thinking_tokens: i64,
    pub server_id: Option<String>,
    // Phase 2: content integrity verification
    pub integrity_verified: Option<bool>,
    // Sprint 5: SUPERSEDES chain — links to the previous turn that modified the same artifact
    pub supersedes_turn_id: Option<String>,
    // D1.1: The user's request text (last user message), truncated to 2000 chars max
    pub user_request_text: Option<String>,
    // Sprint P1B: count of inline attachments extracted for this turn's
    // request (images, PDFs, documents). Zero when the request had none.
    pub attachment_count: i64,
}

/// A tool call record in the database.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRecord {
    pub id: String,
    pub turn_id: String,
    pub tool_name: String,
    pub tool_input: String,
    pub input_hash: Option<String>,
    // v2 fields
    pub sequence_num: Option<i64>,
    pub output: Option<String>,
    pub output_hash: Option<String>,
    pub duration_ms: Option<i64>,
    pub error: Option<String>,
    pub status: Option<String>,
    // Sprint 5: artifact tracking
    pub artifacts_created: Option<String>,
    pub artifact_hashes: Option<String>,
}

/// Metadata for a single extracted inline attachment (image / PDF / document).
/// One row per attachment; the raw bytes live in the object store referenced
/// by `object_ref`. Content is addressed by `sha256` so re-uploads of the
/// same image share a single object even if they appear in multiple turns.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentRecord {
    pub id: String,
    pub turn_id: String,
    pub session_id: String,
    /// 1-based ordinal within the turn's request. Matches `[Image #N]`
    /// placeholders the gateway writes into user_request_text so the UI
    /// can swap the marker for the actual rendering.
    pub sequence_num: i64,
    /// "user" for attachments the user sent; "assistant" for attachments
    /// that arrived via tool_result content blocks (e.g. a tool returned
    /// an image).
    pub role: String,
    /// Coarse kind used for dashboard rendering dispatch: "image" | "pdf"
    /// | "document" | "external_image_url" | "other".
    pub kind: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub object_ref: String,
    pub filename: Option<String>,
    /// Only populated for images (when decoded successfully).
    pub width: Option<i64>,
    pub height: Option<i64>,
}

/// An anomaly event record in the database (Sprint 7: drift detection, ISO 42001 Cl.9.1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnomalyEventRecord {
    pub id: String,
    pub session_id: String,
    pub turn_id: String,
    pub anomaly_type: String,
    pub severity: String,
    pub description: String,
    pub detected_at: String,
    pub resolved_at: Option<String>,
    pub metadata: String,
}

/// Aggregate statistics across all sessions and turns.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stats {
    pub total_sessions: i64,
    pub total_turns: i64,
    pub total_tokens: i64,
    pub models_used: Vec<String>,
}

/// Open a database connection with foreign keys, WAL mode, and busy timeout enabled.
/// All connections should go through this function to ensure consistent PRAGMA settings.
///
/// Note: Each call returns a new, independent connection with all PRAGMAs set.
/// For concurrent access (e.g., from multiple threads), callers should create
/// separate connections — one per thread — rather than sharing a single connection,
/// since `rusqlite::Connection` is not `Sync`.
///
/// NOTE (Phase 1): The gateway currently opens one DB connection per TCP connection
/// (in `handle_mitm_tunnel`). This is acceptable for Phase 1 development where
/// concurrency is low. For production, consider a connection pool (e.g., r2d2 or
/// deadpool) to bound the number of open connections and amortize open/close cost.
pub fn open(path: &std::path::Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA busy_timeout = 5000;",
    )?;
    Ok(conn)
}

/// Open an in-memory database with foreign keys and busy timeout enabled (for tests).
/// Note: WAL mode is set but has no effect on in-memory databases.
pub fn open_in_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA busy_timeout = 5000;",
    )?;
    Ok(conn)
}

/// Schema version. Incremented when new columns or tables are added.
/// Migrations are additive-only — never drop data, never fail on old schemas.
/// Old data with missing columns gets NULL for new fields.
pub const SCHEMA_VERSION: i64 = 11;

/// Initialize the database: create tables if they don't exist, then run
/// additive migrations to bring the schema up to date.
///
/// **Design principle:** Data is sacred. This function NEVER drops tables,
/// NEVER deletes data, and NEVER fails on an older schema. It only adds
/// new tables and columns. Queries must tolerate NULL in any column that
/// was added after the row was written.
///
/// Foreign keys are enabled per-connection — use `db::open()` or
/// `db::open_in_memory()` to ensure all connections have FK enforcement.
pub fn initialize(conn: &Connection) -> Result<()> {
    let current_version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    // Already at current version — nothing to do.
    if current_version >= SCHEMA_VERSION {
        return Ok(());
    }

    // Use IMMEDIATE transaction to prevent concurrent initialization races.
    // Two connections opening the same DB simultaneously will serialize here.
    // On any error, ROLLBACK explicitly to leave the connection in a clean state.
    conn.execute_batch("BEGIN IMMEDIATE;")?;

    let result = initialize_inner(conn);
    if result.is_err() {
        let _ = conn.execute_batch("ROLLBACK;");
        return result;
    }

    conn.execute_batch("COMMIT;")?;
    Ok(())
}

/// Inner initialization logic, called within a transaction.
/// Separated so that errors trigger ROLLBACK in the outer function.
fn initialize_inner(conn: &Connection) -> Result<()> {
    // Re-check version inside the transaction (another connection may have
    // initialized between our check above and acquiring the lock).
    let version_in_txn: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version_in_txn >= SCHEMA_VERSION {
        return Ok(());
    }

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sessions (
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
            framework TEXT,
            agent_id TEXT,
            agent_version TEXT,
            git_repo TEXT,
            git_branch TEXT,
            git_commit TEXT,
            working_directory TEXT,
            parent_session_id TEXT,
            tags TEXT,
            account_uuid TEXT,
            device_id TEXT,
            tool_definitions_hash TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS turns (
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
            duration_ms INTEGER,
            ttfb_ms INTEGER,
            api_endpoint TEXT,
            http_status INTEGER,
            error_message TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            tool_call_count INTEGER NOT NULL DEFAULT 0,
            thinking_tokens INTEGER NOT NULL DEFAULT 0,
            server_id TEXT,
            integrity_verified INTEGER,
            supersedes_turn_id TEXT,
            user_request_text TEXT,
            UNIQUE(session_id, sequence_num)
        );

        CREATE TABLE IF NOT EXISTS tool_calls (
            id TEXT PRIMARY KEY,
            turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE RESTRICT,
            tool_name TEXT NOT NULL,
            tool_input TEXT NOT NULL,
            input_hash TEXT,
            sequence_num INTEGER,
            output TEXT,
            output_hash TEXT,
            duration_ms INTEGER,
            error TEXT,
            status TEXT,
            artifacts_created TEXT,
            artifact_hashes TEXT
        );

        CREATE TABLE IF NOT EXISTS gdpr_deletions (
            id TEXT PRIMARY KEY,
            object_hash TEXT NOT NULL,
            deleted_at TEXT NOT NULL,
            deleted_by TEXT NOT NULL,
            gdpr_request_id TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS anomaly_events (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id),
            turn_id TEXT NOT NULL,
            anomaly_type TEXT NOT NULL,
            severity TEXT NOT NULL,
            description TEXT NOT NULL,
            detected_at TEXT NOT NULL,
            resolved_at TEXT,
            metadata TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, sequence_num);
        CREATE INDEX IF NOT EXISTS idx_tool_calls_turn ON tool_calls(turn_id);
        CREATE INDEX IF NOT EXISTS idx_anomaly_events_session ON anomaly_events(session_id);
        -- FIND-1-1 (round 2): index on turns.request_hash to back the
        -- orphan-recovery dedup probe (`find_turn_by_request_hash`).
        -- Without it the probe degrades to a full table scan and the
        -- startup hook blocks traffic admission for O(N) on large
        -- production databases.
        CREATE INDEX IF NOT EXISTS idx_turns_request_hash ON turns(request_hash);",
    )?;

    // Run additive migrations to bring old schemas up to date.
    // This must happen BEFORE creating indexes that depend on columns added
    // by migrations (e.g., idx_sessions_account depends on account_uuid
    // which is added by the v4 migration).
    run_migrations(conn)?;

    // Create indexes that depend on migration-added columns.
    // Safe to run unconditionally: IF NOT EXISTS handles fresh DBs where
    // the column was already in the CREATE TABLE, and migrations ensure
    // the column exists on upgraded DBs.
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_uuid);",
    )?;

    // NOTE: SQLite PRAGMAs do not support parameter binding (?1 syntax), so we use
    // format!() here. This is safe because SCHEMA_VERSION is a compile-time const i64,
    // not user input — there is no SQL injection risk.
    conn.execute_batch(&format!("PRAGMA user_version = {};", SCHEMA_VERSION))?;

    Ok(())
}

/// Validate that a SQL identifier contains only safe characters [a-zA-Z0-9_].
/// Prevents SQL injection in format! strings used for PRAGMA and ALTER TABLE.
fn validate_identifier(name: &str) -> Result<()> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        anyhow::bail!("Invalid SQL identifier: {:?}", name);
    }
    Ok(())
}

/// Validate a SQL column type expression (e.g., "TEXT", "INTEGER NOT NULL DEFAULT 0").
/// Allows alphanumeric, underscores, spaces, parentheses, and digits — but not
/// semicolons, quotes, or comment markers that could enable injection.
fn validate_col_type(col_type: &str) -> Result<()> {
    if col_type.is_empty() {
        anyhow::bail!("Empty column type");
    }
    // Allow: alphanumeric, spaces, underscores, parens, dots, commas, +/-,
    // and single quotes (for DEFAULT values like DEFAULT '').
    // Reject: semicolons, double-dash comments, double quotes.
    if col_type.contains(';') || col_type.contains("--") || col_type.contains('"') {
        anyhow::bail!("Invalid SQL column type: {:?}", col_type);
    }
    if col_type
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || " _().,+-'".contains(c))
    {
        Ok(())
    } else {
        anyhow::bail!("Invalid SQL column type: {:?}", col_type);
    }
}

/// Check whether a table exists in the database.
fn table_exists(conn: &Connection, table: &str) -> Result<bool> {
    validate_identifier(table)?;
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
        rusqlite::params![table],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Check whether a column exists in a table using PRAGMA table_info.
/// Returns true if the column is found, false otherwise.
/// Returns false if the table does not exist.
fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    validate_identifier(table)?;
    validate_identifier(column)?;
    if !table_exists(conn, table)? {
        return Ok(false);
    }
    let columns: Vec<String> = conn
        .prepare(&format!("PRAGMA table_info({})", table))?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok(columns.contains(&column.to_string()))
}

/// Add a column to a table only if it does not already exist.
/// SQLite does not support `ADD COLUMN IF NOT EXISTS`, so we check first
/// using `PRAGMA table_info`.
///
/// If the table does not exist, this is a no-op. This allows migrations to
/// run safely even when only a subset of tables have been created (e.g.,
/// when `run_migrations` is called directly without `initialize`).
pub fn add_column_if_not_exists(
    conn: &Connection,
    table: &str,
    column: &str,
    col_type: &str,
) -> Result<()> {
    validate_identifier(table)?;
    validate_identifier(column)?;
    validate_col_type(col_type)?;
    if !table_exists(conn, table)? {
        // Table doesn't exist yet — skip. CREATE TABLE will create it
        // with the new column when initialize() runs.
        return Ok(());
    }
    if !column_exists(conn, table, column)? {
        conn.execute_batch(&format!(
            "ALTER TABLE {} ADD COLUMN {} {}",
            table, column, col_type
        ))?;
    }
    Ok(())
}

/// Run additive migrations based on the current user_version.
///
/// Each migration block checks `if current < N` and applies the schema changes
/// needed to reach version N. Migrations are idempotent: they check for column
/// existence before running ALTER TABLE ADD COLUMN, so running them multiple
/// times is safe.
///
/// **Design principle:** Migrations only ADD tables/columns — they never drop
/// or modify existing data. Old rows get NULL for newly-added columns.
pub fn run_migrations(conn: &Connection) -> Result<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    // Already at or above current version — nothing to do.
    if current >= SCHEMA_VERSION {
        return Ok(());
    }

    // Migration to version 2: add 23 new columns across sessions, turns, tool_calls.
    // Sessions: 8 new columns (agent context, git metadata, session hierarchy, tags).
    // Turns: 9 new columns (duration, latency, endpoint, status, errors, counters).
    //   Note: "provider" already exists from v1, so it is skipped (10 specified - 1 = 9 net new).
    // Tool calls: 6 new columns (sequencing, output capture, status tracking).
    if current < 2 {
        // Sessions: 8 new columns (all TEXT, nullable)
        add_column_if_not_exists(conn, "sessions", "agent_id", "TEXT")?;
        add_column_if_not_exists(conn, "sessions", "agent_version", "TEXT")?;
        add_column_if_not_exists(conn, "sessions", "git_repo", "TEXT")?;
        add_column_if_not_exists(conn, "sessions", "git_branch", "TEXT")?;
        add_column_if_not_exists(conn, "sessions", "git_commit", "TEXT")?;
        add_column_if_not_exists(conn, "sessions", "working_directory", "TEXT")?;
        add_column_if_not_exists(conn, "sessions", "parent_session_id", "TEXT")?;
        add_column_if_not_exists(conn, "sessions", "tags", "TEXT")?;

        // Turns: 9 specified columns, but "provider" already exists from v1.
        // Net 8 new columns added here.
        add_column_if_not_exists(conn, "turns", "duration_ms", "INTEGER")?;
        add_column_if_not_exists(conn, "turns", "ttfb_ms", "INTEGER")?;
        add_column_if_not_exists(conn, "turns", "api_endpoint", "TEXT")?;
        add_column_if_not_exists(conn, "turns", "http_status", "INTEGER")?;
        add_column_if_not_exists(conn, "turns", "error_message", "TEXT")?;
        add_column_if_not_exists(conn, "turns", "retry_count", "INTEGER NOT NULL DEFAULT 0")?;
        add_column_if_not_exists(
            conn,
            "turns",
            "tool_call_count",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_not_exists(
            conn,
            "turns",
            "thinking_tokens",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_not_exists(conn, "turns", "server_id", "TEXT")?;

        // Tool calls: 6 new columns
        add_column_if_not_exists(conn, "tool_calls", "sequence_num", "INTEGER")?;
        add_column_if_not_exists(conn, "tool_calls", "output", "TEXT")?;
        add_column_if_not_exists(conn, "tool_calls", "output_hash", "TEXT")?;
        add_column_if_not_exists(conn, "tool_calls", "duration_ms", "INTEGER")?;
        add_column_if_not_exists(conn, "tool_calls", "error", "TEXT")?;
        add_column_if_not_exists(conn, "tool_calls", "status", "TEXT")?;

        // NOTE: Do NOT set PRAGMA user_version here. The caller (initialize_inner)
        // sets it once after all migrations complete. This prevents a future bug
        // where a v3 migration sets version=3 here but initialize_inner overwrites
        // it with SCHEMA_VERSION=2.
    }

    // Migration to version 3: add integrity_verified column to turns.
    if current < 3 {
        add_column_if_not_exists(conn, "turns", "integrity_verified", "INTEGER")?;
    }

    // Migration to version 4: add identity tracking columns to sessions + index.
    if current < 4 {
        add_column_if_not_exists(conn, "sessions", "account_uuid", "TEXT")?;
        add_column_if_not_exists(conn, "sessions", "device_id", "TEXT")?;
        // M1 fix: Add index on account_uuid for efficient per-account queries.
        if table_exists(conn, "sessions")? {
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_uuid);",
            )?;
        }
    }

    // Migration to version 5: add GDPR tombstone table.
    if current < 5 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS gdpr_deletions (
                id TEXT PRIMARY KEY,
                object_hash TEXT NOT NULL,
                deleted_at TEXT NOT NULL,
                deleted_by TEXT NOT NULL,
                gdpr_request_id TEXT NOT NULL
            );",
        )?;
    }

    // Migration to version 6: Sprint 5 artifact tracking + SUPERSEDES chain.
    if current < 6 {
        add_column_if_not_exists(conn, "turns", "supersedes_turn_id", "TEXT")?;
        add_column_if_not_exists(conn, "tool_calls", "artifacts_created", "TEXT")?;
        add_column_if_not_exists(conn, "tool_calls", "artifact_hashes", "TEXT")?;
    }

    // Migration to version 7: W12 + W13 fixes — project_id on sessions,
    // heartbeats and alert_configs tables for monitoring.
    if current < 7 {
        // W12: Add project_id column to sessions table.
        add_column_if_not_exists(conn, "sessions", "project_id", "TEXT")?;

        // W13: Create heartbeats table for availability monitoring.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS heartbeats (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                gateway_id TEXT,
                status TEXT NOT NULL DEFAULT 'ok'
            );
            CREATE INDEX IF NOT EXISTS idx_heartbeats_timestamp ON heartbeats(timestamp);",
        )?;

        // W13: Create alert_configs table for webhook alert configuration.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS alert_configs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                webhook_url TEXT NOT NULL,
                completeness_threshold REAL NOT NULL DEFAULT 100.0,
                availability_threshold REAL NOT NULL DEFAULT 99.9,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_alert_configs_project ON alert_configs(project_id);",
        )?;
    }

    // Migration to version 8: Sprint 7 — anomaly_events table for drift detection.
    // W3 fix: REFERENCES constraint on session_id prevents orphaned events.
    // turn_id intentionally omits REFERENCES turns(id) because anomaly detection
    // runs before the turn record is committed in some code paths.
    if current < 8 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS anomaly_events (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id),
                turn_id TEXT NOT NULL,
                anomaly_type TEXT NOT NULL,
                severity TEXT NOT NULL,
                description TEXT NOT NULL,
                detected_at TEXT NOT NULL,
                resolved_at TEXT,
                metadata TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_anomaly_events_session ON anomaly_events(session_id);",
        )?;
    }

    // Migration to version 9: Sprint 7 Phase 2 — tool_definitions_hash on sessions.
    // Tracks the SHA-256 hash of tool definitions for tool definition drift detection.
    if current < 9 {
        add_column_if_not_exists(
            conn,
            "sessions",
            "tool_definitions_hash",
            "TEXT NOT NULL DEFAULT ''",
        )?;
    }

    // Migration to version 10: D1.1 — user_request_text on turns.
    // Stores the last user message text (truncated to 2000 chars) for search/display.
    if current < 10 {
        add_column_if_not_exists(conn, "turns", "user_request_text", "TEXT")?;
    }

    // Migration to version 11: Sprint P1B — attachments table + turns.attachment_count.
    // Captures inline image / PDF / document uploads so the dashboard can
    // render them. The `attachments` table holds metadata; the raw bytes
    // live in the object store under attachments/<sha256[0:2]>/<sha256>.<ext>.
    if current < 11 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS attachments (
                id TEXT PRIMARY KEY,
                turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                sequence_num INTEGER NOT NULL,
                role TEXT NOT NULL,
                kind TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                sha256 TEXT NOT NULL,
                object_ref TEXT NOT NULL,
                filename TEXT,
                width INTEGER,
                height INTEGER,
                extracted_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_attachments_turn ON attachments(turn_id);
            CREATE INDEX IF NOT EXISTS idx_attachments_sha ON attachments(sha256);",
        )?;
        add_column_if_not_exists(
            conn,
            "turns",
            "attachment_count",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
    }

    Ok(())
}

/// Insert a session record.
///
/// NOTE: Timestamp fields (started_at, last_active_at, ended_at) are stored as-is without
/// validation. Before production use, the capture pipeline (which produces these values)
/// should ensure they are valid RFC 3339 timestamps. Runtime validation is not added here
/// yet to avoid breaking existing tests that use simplified timestamp strings.
pub fn insert_session(conn: &Connection, session: &SessionRecord) -> Result<()> {
    conn.execute(
        "INSERT INTO sessions (id, provider, model, started_at, last_active_at, ended_at, initial_intent, system_prompt_hash, total_turns, turns_captured, dropped_events, total_tokens, total_cost_usd, framework, agent_id, agent_version, git_repo, git_branch, git_commit, working_directory, parent_session_id, tags, account_uuid, device_id, tool_definitions_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)",
        rusqlite::params![
            session.id,
            session.provider,
            session.model,
            session.started_at,
            session.last_active_at,
            session.ended_at,
            session.initial_intent,
            session.system_prompt_hash,
            session.total_turns,
            session.turns_captured,
            session.dropped_events,
            session.total_tokens,
            session.total_cost_usd,
            session.framework,
            session.agent_id,
            session.agent_version,
            session.git_repo,
            session.git_branch,
            session.git_commit,
            session.working_directory,
            session.parent_session_id,
            session.tags,
            session.account_uuid,
            session.device_id,
            session.tool_definitions_hash,
        ],
    )?;
    Ok(())
}

/// Insert a turn record.
///
/// NOTE: Timestamp fields (timestamp, created_at) are stored as-is without validation.
/// Before production use, the capture pipeline (which produces these values) should
/// ensure they are valid RFC 3339 timestamps. Runtime validation is not added here yet
/// to avoid breaking existing tests that use simplified timestamp strings.
pub fn insert_turn(conn: &Connection, turn: &TurnRecord) -> Result<()> {
    conn.execute(
        // Batch 11 fix: ON CONFLICT (id) DO NOTHING absorbs PK collisions at
        // the SQL layer so a legitimate idempotent retry of the SAME row
        // does not raise the (session_id, sequence_num) secondary UNIQUE
        // violation that SQLite reports first when both constraints fail.
        // Any error reaching the caller after this is guaranteed to be a
        // secondary UNIQUE collision (a DIFFERENT row landing on the slot)
        // — which is the silent-data-loss bug surfaced on 2026-05-03.
        "INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash, req_bytes_ref, resp_bytes_ref, req_bytes_size, resp_bytes_size, model, response_text, thinking_text, stop_reason, capture_complete, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, created_at, messages_delta, messages_delta_count, raw_extra, parser_version, parse_errors, provider, transport, ws_direction, duration_ms, ttfb_ms, api_endpoint, http_status, error_message, retry_count, tool_call_count, thinking_tokens, server_id, integrity_verified, supersedes_turn_id, user_request_text, attachment_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40, ?41, ?42) ON CONFLICT (id) DO NOTHING",
        rusqlite::params![
            turn.id,
            turn.session_id,
            turn.sequence_num,
            turn.timestamp,
            turn.request_hash,
            turn.response_hash,
            turn.req_bytes_ref,
            turn.resp_bytes_ref,
            turn.req_bytes_size,
            turn.resp_bytes_size,
            turn.model,
            turn.response_text,
            turn.thinking_text,
            turn.stop_reason,
            turn.capture_complete,
            turn.input_tokens,
            turn.output_tokens,
            turn.cache_read_tokens,
            turn.cache_creation_tokens,
            turn.cost_usd,
            turn.created_at,
            turn.messages_delta,
            turn.messages_delta_count,
            turn.raw_extra,
            turn.parser_version,
            turn.parse_errors,
            turn.provider,
            turn.transport,
            turn.ws_direction,
            turn.duration_ms,
            turn.ttfb_ms,
            turn.api_endpoint,
            turn.http_status,
            turn.error_message,
            turn.retry_count,
            turn.tool_call_count,
            turn.thinking_tokens,
            turn.server_id,
            turn.integrity_verified,
            turn.supersedes_turn_id,
            turn.user_request_text,
            turn.attachment_count,
        ],
    )?;
    Ok(())
}

/// Insert an attachment metadata record. Idempotent: if a row with this id
/// already exists the insert is ignored (the pipeline may retry on transient
/// failures and we must not duplicate attachment rows).
pub fn insert_attachment(conn: &Connection, a: &AttachmentRecord) -> Result<()> {
    let extracted_at = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    conn.execute(
        "INSERT OR IGNORE INTO attachments (id, turn_id, session_id, sequence_num, role, kind, mime_type, size_bytes, sha256, object_ref, filename, width, height, extracted_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        rusqlite::params![
            a.id,
            a.turn_id,
            a.session_id,
            a.sequence_num,
            a.role,
            a.kind,
            a.mime_type,
            a.size_bytes,
            a.sha256,
            a.object_ref,
            a.filename,
            a.width,
            a.height,
            extracted_at,
        ],
    )?;
    Ok(())
}

/// Insert a tool call record.
pub fn insert_tool_call(conn: &Connection, tool_call: &ToolCallRecord) -> Result<()> {
    conn.execute(
        "INSERT INTO tool_calls (id, turn_id, tool_name, tool_input, input_hash, sequence_num, output, output_hash, duration_ms, error, status, artifacts_created, artifact_hashes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        rusqlite::params![
            tool_call.id,
            tool_call.turn_id,
            tool_call.tool_name,
            tool_call.tool_input,
            tool_call.input_hash,
            tool_call.sequence_num,
            tool_call.output,
            tool_call.output_hash,
            tool_call.duration_ms,
            tool_call.error,
            tool_call.status,
            tool_call.artifacts_created,
            tool_call.artifact_hashes,
        ],
    )?;
    Ok(())
}

/// Insert an anomaly event record (Sprint 7: drift detection).
///
/// Uses `INSERT OR IGNORE` for idempotency — if an event with the same ID
/// already exists (e.g., because `detect_system_prompt_drift` already inserted
/// it internally per the W1 fix), the duplicate is silently ignored.
pub fn insert_anomaly_event(conn: &Connection, event: &AnomalyEventRecord) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO anomaly_events (id, session_id, turn_id, anomaly_type, severity, description, detected_at, resolved_at, metadata) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            event.id,
            event.session_id,
            event.turn_id,
            event.anomaly_type,
            event.severity,
            event.description,
            event.detected_at,
            event.resolved_at,
            event.metadata,
        ],
    )?;
    Ok(())
}

/// Query all anomaly events for a given session, ordered by detected_at.
pub fn get_anomaly_events_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<AnomalyEventRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, turn_id, anomaly_type, severity, description, detected_at, resolved_at, metadata FROM anomaly_events WHERE session_id = ?1 ORDER BY detected_at",
    )?;
    let rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(AnomalyEventRecord {
            id: row.get(0)?,
            session_id: row.get(1)?,
            turn_id: row.get(2)?,
            anomaly_type: row.get(3)?,
            severity: row.get(4)?,
            description: row.get(5)?,
            detected_at: row.get(6)?,
            resolved_at: row.get(7)?,
            metadata: row.get(8)?,
        })
    })?;
    let mut events = Vec::new();
    for row in rows {
        events.push(row?);
    }
    Ok(events)
}

/// Set `initial_intent` on a session if it isn't already populated.
///
/// Idempotent: only writes when the column is currently NULL or empty. Used
/// after a session was first created by a preflight (no real intent yet) to
/// backfill from the next non-preflight turn's user message.
pub fn update_session_initial_intent_if_empty(
    conn: &Connection,
    session_id: &str,
    initial_intent: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE sessions SET initial_intent = ?2 \
         WHERE id = ?1 AND (initial_intent IS NULL OR initial_intent = '')",
        rusqlite::params![session_id, initial_intent],
    )?;
    Ok(())
}

/// Update the system_prompt_hash for a session (Sprint 7: drift detection).
///
/// Called when drift is detected so that subsequent turns compare against the
/// new baseline. Without this update, a two-drift scenario (A->B->C) would
/// not detect the B->C transition because the session would still hold hash A.
pub fn update_session_system_prompt_hash(
    conn: &Connection,
    session_id: &str,
    new_hash: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE sessions SET system_prompt_hash = ?2 WHERE id = ?1",
        rusqlite::params![session_id, new_hash],
    )?;
    Ok(())
}

/// Update the tool_definitions_hash for a session (Sprint 7 Phase 2: tool drift detection).
///
/// Called when tool definition drift is detected so that subsequent turns compare
/// against the new baseline. Without this update, a two-drift scenario (A->B->C)
/// would not detect the B->C transition because the session would still hold hash A.
pub fn update_session_tool_definitions_hash(
    conn: &Connection,
    session_id: &str,
    new_hash: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE sessions SET tool_definitions_hash = ?2 WHERE id = ?1",
        rusqlite::params![session_id, new_hash],
    )?;
    Ok(())
}

/// Column list for session queries. Used by all session-fetching functions to stay in sync.
const SESSION_COLUMNS: &str = "id, provider, model, started_at, last_active_at, ended_at, initial_intent, system_prompt_hash, total_turns, turns_captured, dropped_events, total_tokens, total_cost_usd, framework, agent_id, agent_version, git_repo, git_branch, git_commit, working_directory, parent_session_id, tags, account_uuid, device_id, tool_definitions_hash";

/// Map a SQLite row to a SessionRecord. The row must contain SESSION_COLUMNS in order.
fn session_from_row(row: &rusqlite::Row) -> rusqlite::Result<SessionRecord> {
    Ok(SessionRecord {
        id: row.get(0)?,
        provider: row.get(1)?,
        model: row.get(2)?,
        started_at: row.get(3)?,
        last_active_at: row.get(4)?,
        ended_at: row.get(5)?,
        initial_intent: row.get(6)?,
        system_prompt_hash: row.get(7)?,
        total_turns: row.get(8)?,
        turns_captured: row.get(9)?,
        dropped_events: row.get(10)?,
        total_tokens: row.get(11)?,
        total_cost_usd: row.get(12)?,
        framework: row.get(13)?,
        agent_id: row.get(14)?,
        agent_version: row.get(15)?,
        git_repo: row.get(16)?,
        git_branch: row.get(17)?,
        git_commit: row.get(18)?,
        working_directory: row.get(19)?,
        parent_session_id: row.get(20)?,
        tags: row.get(21)?,
        account_uuid: row.get(22)?,
        device_id: row.get(23)?,
        tool_definitions_hash: row.get::<_, Option<String>>(24)?.unwrap_or_default(),
    })
}

/// Column list for turn queries. Used by all turn-fetching functions to stay in sync.
const TURN_COLUMNS: &str = "id, session_id, sequence_num, timestamp, request_hash, response_hash, req_bytes_ref, resp_bytes_ref, req_bytes_size, resp_bytes_size, model, response_text, thinking_text, stop_reason, capture_complete, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, created_at, messages_delta, messages_delta_count, raw_extra, parser_version, parse_errors, provider, transport, ws_direction, duration_ms, ttfb_ms, api_endpoint, http_status, error_message, retry_count, tool_call_count, thinking_tokens, server_id, integrity_verified, supersedes_turn_id, user_request_text, attachment_count";

/// Map a SQLite row to a TurnRecord. The row must contain TURN_COLUMNS in order.
fn turn_from_row(row: &rusqlite::Row) -> rusqlite::Result<TurnRecord> {
    Ok(TurnRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        sequence_num: row.get(2)?,
        timestamp: row.get(3)?,
        request_hash: row.get(4)?,
        response_hash: row.get(5)?,
        req_bytes_ref: row.get(6)?,
        resp_bytes_ref: row.get(7)?,
        req_bytes_size: row.get(8)?,
        resp_bytes_size: row.get(9)?,
        model: row.get(10)?,
        response_text: row.get(11)?,
        thinking_text: row.get(12)?,
        stop_reason: row.get(13)?,
        capture_complete: row.get(14)?,
        input_tokens: row.get(15)?,
        output_tokens: row.get(16)?,
        cache_read_tokens: row.get(17)?,
        cache_creation_tokens: row.get(18)?,
        cost_usd: row.get(19)?,
        created_at: row.get(20)?,
        messages_delta: row.get(21)?,
        messages_delta_count: row.get(22)?,
        raw_extra: row.get(23)?,
        parser_version: row.get(24)?,
        parse_errors: row.get(25)?,
        provider: row.get(26)?,
        transport: row.get(27)?,
        ws_direction: row.get(28)?,
        duration_ms: row.get(29)?,
        ttfb_ms: row.get(30)?,
        api_endpoint: row.get(31)?,
        http_status: row.get(32)?,
        error_message: row.get(33)?,
        retry_count: row.get::<_, Option<i64>>(34)?.unwrap_or(0),
        tool_call_count: row.get::<_, Option<i64>>(35)?.unwrap_or(0),
        thinking_tokens: row.get::<_, Option<i64>>(36)?.unwrap_or(0),
        server_id: row.get(37)?,
        integrity_verified: row.get(38)?,
        supersedes_turn_id: row.get(39)?,
        user_request_text: row.get(40)?,
        attachment_count: row.get::<_, Option<i64>>(41)?.unwrap_or(0),
    })
}

/// List all sessions, with an optional limit on the number of rows returned.
/// Defaults to 1000 if no limit is specified.
pub fn list_sessions(conn: &Connection, limit: Option<i64>) -> Result<Vec<SessionRecord>> {
    let effective_limit = limit.unwrap_or(1000);
    let sql = format!("SELECT {} FROM sessions LIMIT ?1", SESSION_COLUMNS);
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params![effective_limit], session_from_row)?;
    let mut sessions = Vec::new();
    for row in rows {
        sessions.push(row?);
    }
    Ok(sessions)
}

/// Get a session by ID.
pub fn get_session(conn: &Connection, session_id: &str) -> Result<Option<SessionRecord>> {
    let sql = format!("SELECT {} FROM sessions WHERE id = ?1", SESSION_COLUMNS);
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map(rusqlite::params![session_id], session_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// List all sessions with the given account_uuid.
/// Returns sessions ordered by started_at (most recent first).
pub fn list_sessions_by_account(
    conn: &Connection,
    account_uuid: &str,
) -> Result<Vec<SessionRecord>> {
    let sql = format!(
        "SELECT {} FROM sessions WHERE account_uuid = ?1 ORDER BY started_at DESC",
        SESSION_COLUMNS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params![account_uuid], session_from_row)?;
    let mut sessions = Vec::new();
    for row in rows {
        sessions.push(row?);
    }
    Ok(sessions)
}

/// Get all turns for a session, ordered by sequence_num.
pub fn get_turns_for_session(conn: &Connection, session_id: &str) -> Result<Vec<TurnRecord>> {
    let sql = format!(
        "SELECT {} FROM turns WHERE session_id = ?1 ORDER BY sequence_num",
        TURN_COLUMNS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params![session_id], turn_from_row)?;
    let mut turns = Vec::new();
    for row in rows {
        turns.push(row?);
    }
    Ok(turns)
}

/// Update the last_active_at timestamp for a session.
/// Returns an error if the session does not exist.
pub fn update_session_last_active(
    conn: &Connection,
    session_id: &str,
    last_active_at: &str,
) -> Result<()> {
    let rows_affected = conn.execute(
        "UPDATE sessions SET last_active_at = ?2 WHERE id = ?1",
        rusqlite::params![session_id, last_active_at],
    )?;
    if rows_affected == 0 {
        anyhow::bail!("session not found: {}", session_id);
    }
    Ok(())
}

/// Get all tool calls for a turn.
pub fn get_tool_calls_for_turn(conn: &Connection, turn_id: &str) -> Result<Vec<ToolCallRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, turn_id, tool_name, tool_input, input_hash, sequence_num, output, output_hash, duration_ms, error, status, artifacts_created, artifact_hashes FROM tool_calls WHERE turn_id = ?1 ORDER BY sequence_num",
    )?;
    let rows = stmt.query_map(rusqlite::params![turn_id], |row| {
        Ok(ToolCallRecord {
            id: row.get(0)?,
            turn_id: row.get(1)?,
            tool_name: row.get(2)?,
            tool_input: row.get(3)?,
            input_hash: row.get(4)?,
            sequence_num: row.get(5)?,
            output: row.get(6)?,
            output_hash: row.get(7)?,
            duration_ms: row.get(8)?,
            error: row.get(9)?,
            status: row.get(10)?,
            artifacts_created: row.get(11)?,
            artifact_hashes: row.get(12)?,
        })
    })?;
    let mut tool_calls = Vec::new();
    for row in rows {
        tool_calls.push(row?);
    }
    Ok(tool_calls)
}

/// Get a single turn by ID.
pub fn get_turn(conn: &Connection, turn_id: &str) -> Result<Option<TurnRecord>> {
    let sql = format!("SELECT {} FROM turns WHERE id = ?1", TURN_COLUMNS);
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map(rusqlite::params![turn_id], turn_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// FIND-1-1 (round 2): find the first turn in the database whose
/// `request_hash` equals `hash`. Used by the orphan-recovery probe
/// to avoid re-inserting capture metadata files that already have
/// a row, regardless of which session that row belongs to. Backed
/// by `idx_turns_request_hash`.
pub fn find_turn_by_request_hash(conn: &Connection, hash: &str) -> Result<Option<TurnRecord>> {
    let sql = format!(
        "SELECT {} FROM turns WHERE request_hash = ?1 LIMIT 1",
        TURN_COLUMNS
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map(rusqlite::params![hash], turn_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// Search turns by matching response_text, model, or stop_reason against a LIKE pattern.
/// LIKE wildcards (`%` and `_`) in the query are escaped so they match literally.
///
/// Accepts an optional `limit` on the number of rows returned (defaults to 1000).
///
/// NOTE: This performs a full table scan with LIKE. For production workloads with
/// large turn tables, consider adding an FTS5 virtual table for full-text search.
pub fn search_turns(conn: &Connection, query: &str, limit: Option<i64>) -> Result<Vec<TurnRecord>> {
    let effective_limit = limit.unwrap_or(1000);
    // Escape LIKE wildcards in user input: \ is the escape char, so escape it first,
    // then escape % and _.
    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{}%", escaped);
    let sql = format!(
        "SELECT {} FROM turns WHERE response_text LIKE ?1 ESCAPE '\\' OR model LIKE ?1 ESCAPE '\\' OR stop_reason LIKE ?1 ESCAPE '\\' LIMIT ?2",
        TURN_COLUMNS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params![pattern, effective_limit], turn_from_row)?;
    let mut turns = Vec::new();
    for row in rows {
        turns.push(row?);
    }
    Ok(turns)
}

/// Query all sessions. Alias for `list_sessions` with default limit.
pub fn query_sessions(conn: &Connection) -> Result<Vec<SessionRecord>> {
    list_sessions(conn, None)
}

/// Query all turns for a session, ordered by sequence_num.
/// Alias for `get_turns_for_session`.
pub fn query_turns(conn: &Connection, session_id: &str) -> Result<Vec<TurnRecord>> {
    get_turns_for_session(conn, session_id)
}

/// Query all tool calls for a turn.
/// Alias for `get_tool_calls_for_turn`.
pub fn query_tool_calls(conn: &Connection, turn_id: &str) -> Result<Vec<ToolCallRecord>> {
    get_tool_calls_for_turn(conn, turn_id)
}

/// Compute aggregate statistics across all sessions and turns.
///
/// - `total_sessions`: count of rows in the sessions table
/// - `total_turns`: count of rows in the turns table
/// - `total_tokens`: sum of `total_tokens` from the sessions table
/// - `models_used`: distinct non-NULL model values from the sessions table
pub fn get_stats(conn: &Connection) -> Result<Stats> {
    let total_sessions: i64 =
        conn.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))?;
    let total_turns: i64 = conn.query_row("SELECT COUNT(*) FROM turns", [], |row| row.get(0))?;
    let total_tokens: i64 = conn.query_row(
        "SELECT COALESCE(SUM(total_tokens), 0) FROM sessions",
        [],
        |row| row.get(0),
    )?;

    let mut stmt = conn.prepare("SELECT DISTINCT model FROM sessions WHERE model IS NOT NULL")?;
    let rows = stmt.query_map([], |row| {
        let model: String = row.get(0)?;
        Ok(model)
    })?;
    let mut models_used = Vec::new();
    for row in rows {
        models_used.push(row?);
    }

    Ok(Stats {
        total_sessions,
        total_turns,
        total_tokens,
        models_used,
    })
}

/// Compute the estimated cost in USD for a turn based on model and token counts.
///
/// Rates are resolved from the canonical [`PricingTable`]
/// (`compliance/model-pricing.toml`) by longest-prefix-match with
/// `effective_from` temporal resolution. Cache rates are absolute per-million
/// USD per entry (no multipliers). Tier breaks override input/output rates
/// above `threshold_input_tokens`; cache rates always use entry-level values
/// regardless of tier.
///
/// Pricing is per million tokens. Prefix matching handles versioned model
/// names (e.g., `claude-sonnet-4-20250514` matches the `claude-sonnet-4`
/// entry; `gpt-4o-mini-...` matches the `gpt-4o-mini` entry, NOT `gpt-4o`).
///
/// Returns `0.0` for unknown/unrecognized models (no entry matches).
///
/// ## Cache token pricing
///
/// `cache_creation_tokens` and `cache_read_tokens` are billed at the
/// per-entry absolute rates `cache_create_per_m` and `cache_read_per_m`
/// (USD per million tokens). Providers that do not report cache tokens
/// should pass `0` for both — their entries' cache rates may still be
/// non-zero per provider; see `compliance/model-pricing.toml` for current
/// values.
///
/// ## Disjointness assumption (W1+W3)
///
/// Per Anthropic's API the three token fields are disjoint:
/// - `input_tokens` = non-cached input tokens
/// - `cache_creation_tokens` = tokens written to the cache this request
/// - `cache_read_tokens` = tokens read from the cache this request
///
/// Summing them gives the true total input token count. There is no
/// double-counting risk as long as the upstream API maintains this invariant.
///
/// ## When `cost_usd` is `None`
///
/// When the model name is not parsed from the response (e.g., parse
/// failures, providers that omit the model field), `cost_usd` is set to
/// `None` in the `TurnRecord`. The raw bytes are still captured and can be
/// re-processed later.
pub fn compute_cost_usd(
    pricing: &PricingTable,
    model: &str,
    input_tokens: i64,
    output_tokens: i64,
    cache_creation_tokens: i64,
    cache_read_tokens: i64,
    at: &time::OffsetDateTime,
) -> f64 {
    // Lookup is case-insensitive on the model name. Prefixes in the canonical
    // TOML are lowercase.
    let lower = model.to_ascii_lowercase();
    let entry = match pricing.resolve(&lower, at) {
        Some(e) => e,
        None => return 0.0,
    };

    // Tier-break: above the highest crossed threshold, that tier's rates
    // override base input/output rates for the whole turn.
    let (input_rate, output_rate) = entry
        .tiers
        .iter()
        .filter(|t| input_tokens > t.threshold_input_tokens)
        .max_by_key(|t| t.threshold_input_tokens)
        .map(|t| (t.input_per_m, t.output_per_m))
        .unwrap_or((entry.input_per_m, entry.output_per_m));

    let input_cost = (input_tokens as f64) * input_rate / 1_000_000.0;
    let output_cost = (output_tokens as f64) * output_rate / 1_000_000.0;
    let cache_creation_cost =
        (cache_creation_tokens as f64) * entry.cache_create_per_m / 1_000_000.0;
    let cache_read_cost = (cache_read_tokens as f64) * entry.cache_read_per_m / 1_000_000.0;

    input_cost + cache_creation_cost + cache_read_cost + output_cost
}

// ---------------------------------------------------------------------------
// GDPR tombstone table + deletion workflow (OD-003)
// ---------------------------------------------------------------------------

/// A GDPR deletion tombstone record.
///
/// When an object is deleted to comply with GDPR, a tombstone is recorded
/// to maintain the audit trail: the object existed, was deleted, when, by
/// whom, and under which GDPR request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatRecord {
    pub id: String,
    pub gateway_id: Option<String>,
    pub status: String,
}

pub struct GdprDeletionRecord {
    /// Unique ID for this tombstone record.
    pub id: String,
    /// SHA-256 hash of the deleted object.
    pub object_hash: String,
    /// ISO 8601 timestamp when the deletion occurred.
    pub deleted_at: String,
    /// Identity of the person who performed the deletion (e.g., email).
    pub deleted_by: String,
    /// The GDPR request identifier that authorized this deletion.
    pub gdpr_request_id: String,
}

/// Record a GDPR deletion tombstone in the `gdpr_deletions` table.
///
/// Generates a unique ID and records the current timestamp automatically.
/// The tombstone preserves the audit trail after the actual object bytes
/// have been purged from the object store.
pub fn record_gdpr_deletion(
    conn: &Connection,
    object_hash: &str,
    deleted_by: &str,
    gdpr_request_id: &str,
) -> Result<()> {
    let id = uuid::Uuid::new_v4().to_string();
    let deleted_at = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "unknown".to_string());

    conn.execute(
        "INSERT INTO gdpr_deletions (id, object_hash, deleted_at, deleted_by, gdpr_request_id) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![id, object_hash, deleted_at, deleted_by, gdpr_request_id],
    )?;

    Ok(())
}

/// List all GDPR deletion tombstone records.
pub fn list_gdpr_deletions(conn: &Connection) -> Result<Vec<GdprDeletionRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, object_hash, deleted_at, deleted_by, gdpr_request_id FROM gdpr_deletions ORDER BY deleted_at",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(GdprDeletionRecord {
            id: row.get(0)?,
            object_hash: row.get(1)?,
            deleted_at: row.get(2)?,
            deleted_by: row.get(3)?,
            gdpr_request_id: row.get(4)?,
        })
    })?;
    let mut records = Vec::new();
    for row in rows {
        records.push(row?);
    }
    Ok(records)
}

/// Nullify parsed fields on a turn record for GDPR erasure.
///
/// Sets `response_text`, `thinking_text`, `messages_delta`, and `raw_extra`
/// to NULL. Also clears tool_call PII (`tool_input`, `output`) for all tool
/// calls belonging to the turn (N2 fix).
///
/// The structural fields (hashes, session_id, sequence_num, etc.)
/// are preserved to maintain the integrity chain — the content hash remains
/// as a documented tombstone indicating that data existed but was erased.
///
/// Returns an error if the turn does not exist (prevents silent no-ops on
/// typos or stale IDs).
pub fn nullify_turn_parsed_fields(conn: &Connection, turn_id: &str) -> Result<()> {
    let rows_affected = conn.execute(
        "UPDATE turns SET response_text = NULL, thinking_text = NULL, messages_delta = NULL, raw_extra = NULL WHERE id = ?1",
        rusqlite::params![turn_id],
    )?;
    if rows_affected == 0 {
        anyhow::bail!("turn not found: {}", turn_id);
    }
    // N2 fix: Also clear tool_call PII (tool_input, output) for the turn.
    conn.execute(
        "UPDATE tool_calls SET tool_input = NULL, output = NULL WHERE turn_id = ?1",
        rusqlite::params![turn_id],
    )?;
    Ok(())
}

/// Create a database connection and initialize the schema.
///
/// Convenience function that combines `open` (or `open_in_memory` for ":memory:")
/// and `initialize` into a single call. Used by tests and simple startup paths.
pub fn create_connection(path: &str) -> Result<Connection> {
    let conn = if path == ":memory:" {
        open_in_memory()?
    } else {
        open(std::path::Path::new(path))?
    };
    initialize(&conn)?;
    Ok(conn)
}

/// Atomically increment the aggregate totals for a session.
///
/// Uses SQL `SET col = col + ?` to avoid TOCTOU races: no need to read the
/// current value first, so concurrent callers cannot clobber each other's
/// increments.
///
/// All parameters are *deltas* (amounts to add), not absolute values.
/// Returns an error if the session does not exist.
pub fn update_session_totals(
    conn: &Connection,
    session_id: &str,
    delta_turns: i64,
    delta_captured: i64,
    delta_tokens: i64,
    delta_cost_usd: f64,
) -> Result<()> {
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    let rows_affected = conn.execute(
        "UPDATE sessions SET total_turns = total_turns + ?2, turns_captured = turns_captured + ?3, total_tokens = total_tokens + ?4, total_cost_usd = total_cost_usd + ?5, last_active_at = ?6 WHERE id = ?1",
        rusqlite::params![session_id, delta_turns, delta_captured, delta_tokens, delta_cost_usd, now],
    )?;
    if rows_affected == 0 {
        anyhow::bail!("session not found: {}", session_id);
    }
    Ok(())
}
