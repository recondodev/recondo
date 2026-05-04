//! PostgreSQL-backed graph store using `deadpool-postgres`.
//!
//! Implements `GraphStore` for PostgreSQL. Since the trait methods are
//! synchronous but `deadpool-postgres` is async, we bridge using
//! `tokio::task::block_in_place(|| Handle::current().block_on(future))`.
//! `block_in_place` moves the blocking call off the async worker thread,
//! preventing panics when called from within a tokio async context.
//!
//! ## Schema mapping
//!
//! The Rust structs (`SessionRecord`, `TurnRecord`, `ToolCallRecord`) are the
//! canonical schema. This module creates PostgreSQL tables that are
//! functionally equivalent to the SQLite schema (using TEXT for IDs,
//! TEXT for timestamps, etc.) so that all fields round-trip without loss.
//!
//! ## TLS / connection security
//!
//! **Production deployments MUST use `sslmode=require` (or stricter) in the
//! connection URL.** The current implementation uses `NoTls` as the connector
//! because adding native-tls or rustls integration is a larger change tracked
//! separately.  `ConnectionPool::postgres()` logs a warning when the URL does
//! not contain `sslmode=require`.  See W1 in the review tracker.
//!
//! ## Schema versioning
//!
//! There is currently no migration / version tracking for the PG schema.
//! For production use, an additive migration framework (e.g., a
//! `schema_version` table with monotonic version numbers) is required.
//! This is tracked as a Phase 2 deliverable (N6 in the review tracker).

use anyhow::Result;
use deadpool_postgres::{Config, Pool, Runtime};
use tokio_postgres::error::SqlState;
use tokio_postgres::NoTls;

use crate::db::{AttachmentRecord, SessionRecord, ToolCallRecord, TurnRecord};
use crate::storage::graph::{GraphStore, GraphStoreError, GraphStoreResult, IntegrityResult};

/// Check whether a `tokio_postgres::Error` is a unique-violation (SQLSTATE 23505).
fn is_unique_violation(err: &tokio_postgres::Error) -> bool {
    err.code() == Some(&SqlState::UNIQUE_VIOLATION)
}

/// Parse a JSON-formatted String into `serde_json::Value` for use as a
/// JSONB bind parameter.
///
/// `AnomalyEventRecord.metadata` is a `String` in the Rust struct but the
/// PG column is `JSONB`. tokio-postgres serializes Rust `String` as TEXT,
/// not JSONB — and a `$N::jsonb` SQL cast does not help because the
/// prepared statement reports parameter type as JSONB, and tokio-postgres
/// fails to serialize a String into JSONB before the query is sent
/// ("error serializing parameter N"). The fix is to parse to
/// `serde_json::Value` and bind that — tokio-postgres' `with-serde_json-1`
/// feature serializes Value as JSONB natively.
///
/// On parse failure (malformed input), fall back to an empty JSON object
/// `{}` so the audit row still lands. The PG schema default is also
/// `'{}'::jsonb`, so the fallback preserves invariants.
fn parse_jsonb_metadata(s: &str) -> serde_json::Value {
    serde_json::from_str(s).unwrap_or_else(|e| {
        tracing::warn!(
            error = %e,
            len = s.len(),
            "parse_jsonb_metadata: malformed JSON; falling back to empty object"
        );
        serde_json::Value::Object(serde_json::Map::new())
    })
}

/// Batch 11 fix: classify a PG unique-violation as either a `DuplicateKey`
/// (the PK collided — idempotent retry success) or a `UniqueViolation`
/// (a SECONDARY UNIQUE constraint collided — must propagate).
///
/// PG exposes the violated constraint name via
/// `err.as_db_error().constraint()`. The PK constraint follows the
/// `<table>_pkey` convention; anything else is a secondary UNIQUE.
fn classify_pg_unique_violation(
    err: tokio_postgres::Error,
    entity: &str,
    id: String,
    pk_constraint: &str,
) -> GraphStoreError {
    let constraint_name = err.as_db_error().and_then(|d| d.constraint()).unwrap_or("");
    if constraint_name == pk_constraint {
        GraphStoreError::DuplicateKey {
            entity: entity.into(),
            id,
        }
    } else {
        GraphStoreError::UniqueViolation {
            entity: entity.into(),
            constraint: constraint_name.to_string(),
            message: format!("{}", err),
        }
    }
}

/// PostgreSQL-backed graph store.
pub struct PostgresGraphStore {
    pool: Pool,
}

/// Create a `deadpool_postgres::Pool` from a database URL.
///
/// Shared logic used by both `PostgresGraphStore::new()` and `ConnectionPool::postgres()`.
/// Handles TLS warning, pool sizing via `RECONDO_PG_POOL_SIZE`, and NoTls connector.
///
/// **Production deployments MUST include `sslmode=require` (or stricter) in the URL.**
pub fn create_pg_pool(database_url: &str) -> Result<Pool> {
    // Warn when the connection URL does not enforce TLS.
    if !database_url.contains("sslmode=require")
        && !database_url.contains("sslmode=verify-ca")
        && !database_url.contains("sslmode=verify-full")
    {
        tracing::warn!(
            "PostgreSQL connection URL does not contain sslmode=require. \
             TLS is required for production compliance (SOC 2, ISO 42001). \
             Add ?sslmode=require to the connection URL."
        );
    }

    let mut cfg = Config::new();
    cfg.url = Some(database_url.to_string());

    // Explicit pool size with env var override (default 16).
    let pool_size: usize = std::env::var("RECONDO_PG_POOL_SIZE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(16);
    cfg.pool = Some(deadpool_postgres::PoolConfig::new(pool_size));

    // NOTE: NoTls is used as the connector. Adding native-tls or rustls
    // integration is a larger change. With NoTls, the client CANNOT negotiate
    // TLS at all. If the PG server requires SSL (hostssl in pg_hba.conf),
    // the connection will be REJECTED — it will not silently fall back to
    // unencrypted.
    cfg.create_pool(Some(Runtime::Tokio1), NoTls)
        .map_err(|e| anyhow::anyhow!("Failed to create PostgreSQL connection pool: {}", e))
}

impl PostgresGraphStore {
    /// Create a new `PostgresGraphStore` from a database URL.
    ///
    /// After Sprint M2, this no longer executes DDL. It verifies that required
    /// tables exist (created by external migrations via `just api-migrate`).
    pub fn new(database_url: &str) -> Result<Self> {
        let pool = create_pg_pool(database_url)?;
        let store = Self { pool };

        // Verify tables exist (migrations must have been run externally).
        store.block_on(store.verify_tables())?;

        Ok(store)
    }

    /// Create a `PostgresGraphStore` from an existing `deadpool_postgres::Pool`.
    /// Useful for testing or when the pool is managed externally.
    ///
    /// After Sprint M2, this verifies that required tables exist rather than
    /// creating them. Run `just api-migrate` before starting the gateway.
    pub fn from_pool(pool: Pool) -> Result<Self> {
        let store = Self { pool };
        store.block_on(store.verify_tables())?;
        Ok(store)
    }

    /// Create a `PostgresGraphStore` from an existing pool without running schema init.
    /// Used by `ConnectionPool::graph_store()` when the pool has already been initialized.
    pub fn from_pool_no_init(pool: Pool) -> Self {
        Self { pool }
    }

    /// Access the underlying connection pool. Guarded behind the
    /// `test-support` feature because the pool is an internal detail —
    /// callers should not take dependency on the pool shape. Integration
    /// tests use it for low-level TRUNCATE cleanup between runs.
    #[cfg(feature = "test-support")]
    pub fn pool(&self) -> &Pool {
        &self.pool
    }

    /// Check that required tables exist in the PostgreSQL database.
    ///
    /// After Sprint M2, the gateway no longer creates tables on startup.
    /// Tables must be created by running migrations externally (`just api-migrate`).
    ///
    /// FIND-1-O: This method now probes FOUR critical write-path tables
    /// (`sessions`, `turns`, `tool_calls`, `attachments`) AND the
    /// `turns.attachment_count` column (added by migration 011). The
    /// column check guards against a partial-migration state where the
    /// attachments table exists but the denormalised count column on
    /// turns is missing — the gateway would fail on every capture with
    /// an unhelpful error. Fail-fast with an actionable message here is
    /// preferable.
    pub async fn check_tables_exist(client: &deadpool_postgres::Client) -> Result<()> {
        let required_tables: &[&str] = &["sessions", "turns", "tool_calls", "attachments"];

        let row = client
            .query_one(
                "SELECT COUNT(*)::BIGINT FROM information_schema.tables \
                 WHERE table_schema = 'public' \
                 AND table_name IN ('sessions', 'turns', 'tool_calls', 'attachments')",
                &[],
            )
            .await
            .map_err(|e| anyhow::anyhow!("Failed to verify PostgreSQL tables: {}", e))?;

        let count: i64 = row.get(0);
        if count != required_tables.len() as i64 {
            // Determine which specific tables are missing for a useful
            // error message.
            let rows = client
                .query(
                    "SELECT table_name FROM information_schema.tables \
                     WHERE table_schema = 'public' \
                     AND table_name IN ('sessions', 'turns', 'tool_calls', 'attachments')",
                    &[],
                )
                .await
                .map_err(|e| anyhow::anyhow!("Failed to verify PostgreSQL tables: {}", e))?;

            let found: Vec<String> = rows.iter().map(|r| r.get::<_, String>(0)).collect();
            let missing: Vec<&&str> = required_tables
                .iter()
                .filter(|t| !found.iter().any(|f| f == **t))
                .collect();

            let missing_list = missing
                .iter()
                .map(|t| format!("'{}'", t))
                .collect::<Vec<_>>()
                .join(", ");
            tracing::error!(
                "Required table(s) missing: {}. \
                 Run 'just api-migrate' before starting the gateway. \
                 PostgreSQL tables are managed by external migrations, \
                 not created by the gateway on startup. \
                 See docs/MIGRATIONS.md for the migration workflow.",
                missing_list
            );
            anyhow::bail!(
                "Required table(s) missing: {}. \
                 Run 'just api-migrate' to apply migrations before starting the gateway.",
                missing_list
            );
        }

        // FIND-1-O: Verify the `turns.attachment_count` column (added by
        // migration 011). Without this column, every attachment capture
        // will fail on insert. Check via information_schema so the probe
        // does not run a `SELECT attachment_count FROM turns LIMIT 0`
        // that would leave a transaction open on error.
        let col_row = client
            .query_one(
                "SELECT COUNT(*)::BIGINT FROM information_schema.columns \
                 WHERE table_schema = 'public' \
                 AND table_name = 'turns' \
                 AND column_name = 'attachment_count'",
                &[],
            )
            .await
            .map_err(|e| {
                anyhow::anyhow!("Failed to verify turns.attachment_count column: {}", e)
            })?;
        let col_count: i64 = col_row.get(0);
        if col_count == 0 {
            tracing::error!(
                "Required column 'turns.attachment_count' not found — \
                 migration 011_attachments has not been applied. \
                 Run 'just api-migrate' before starting the gateway. \
                 See docs/MIGRATIONS.md for the migration workflow."
            );
            anyhow::bail!(
                "turns.attachment_count column not found — \
                 did you run 'just api-migrate'? See docs/MIGRATIONS.md."
            );
        }

        Ok(())
    }

    /// Bridge an async future to sync by using the current tokio runtime.
    ///
    /// Uses `block_in_place` to move off the async worker thread, preventing
    /// panics when `GraphStore` trait methods are called from within an async
    /// context (e.g., a tokio task or an async test harness).
    fn block_on<F: std::future::Future>(&self, future: F) -> F::Output {
        tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(future))
    }

    /// Verify that required PostgreSQL tables exist (created by external migrations).
    ///
    /// After Sprint M2, the gateway does not execute DDL. This method acquires a
    /// connection and delegates to `check_tables_exist` to probe all critical tables.
    async fn verify_tables(&self) -> Result<()> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to get PG connection: {}", e))?;

        Self::check_tables_exist(&client).await
    }

    /// Write a session to PostgreSQL.
    ///
    /// N3: project_id is intentionally not included in this INSERT. The gateway
    /// does not know the project context — project_id is set by the API layer
    /// or via direct SQL after the session is created.
    async fn write_session_async(&self, session: &SessionRecord) -> GraphStoreResult<()> {
        let client = self.pool.get().await.map_err(|e| {
            GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
        })?;

        client
            .execute(
                "INSERT INTO sessions (
                    id, provider, model, started_at, last_active_at, ended_at,
                    initial_intent, system_prompt_hash, total_turns, turns_captured,
                    dropped_events, total_tokens, total_cost_usd, framework,
                    agent_id, agent_version, git_repo, git_branch, git_commit,
                    working_directory, parent_session_id, tags,
                    account_uuid, device_id
                ) VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10,
                    $11, $12, $13, $14,
                    $15, $16, $17, $18, $19,
                    $20, $21, $22,
                    $23, $24
                )",
                &[
                    &session.id,
                    &session.provider,
                    &session.model,
                    &session.started_at,
                    &session.last_active_at,
                    &session.ended_at,
                    &session.initial_intent,
                    &session.system_prompt_hash,
                    &session.total_turns,
                    &session.turns_captured,
                    &session.dropped_events,
                    &session.total_tokens,
                    &session.total_cost_usd,
                    &session.framework,
                    &session.agent_id,
                    &session.agent_version,
                    &session.git_repo,
                    &session.git_branch,
                    &session.git_commit,
                    &session.working_directory,
                    &session.parent_session_id,
                    &session.tags,
                    &session.account_uuid,
                    &session.device_id,
                ],
            )
            .await
            .map_err(|e| {
                if is_unique_violation(&e) {
                    classify_pg_unique_violation(e, "session", session.id.clone(), "sessions_pkey")
                } else {
                    GraphStoreError::Other(anyhow::anyhow!("Failed to insert session: {}", e))
                }
            })?;

        Ok(())
    }

    /// Write a turn to PostgreSQL.
    async fn write_turn_async(&self, turn: &TurnRecord) -> GraphStoreResult<()> {
        let client = self.pool.get().await.map_err(|e| {
            GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
        })?;

        client
            .execute(
                "INSERT INTO turns (
                    id, session_id, sequence_num, timestamp,
                    request_hash, response_hash, req_bytes_ref, resp_bytes_ref,
                    req_bytes_size, resp_bytes_size, model, response_text,
                    thinking_text, stop_reason, capture_complete,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                    cost_usd, created_at, messages_delta, messages_delta_count,
                    raw_extra, parser_version, parse_errors,
                    provider, transport, ws_direction,
                    duration_ms, ttfb_ms, api_endpoint, http_status,
                    error_message, retry_count, tool_call_count, thinking_tokens,
                    server_id, integrity_verified, supersedes_turn_id,
                    user_request_text, attachment_count
                ) VALUES (
                    $1,  $2,  $3,  $4,
                    $5,  $6,  $7,  $8,
                    $9,  $10, $11, $12,
                    $13, $14, $15,
                    $16, $17, $18, $19,
                    $20, $21, $22, $23,
                    $24, $25, $26,
                    $27, $28, $29,
                    $30, $31, $32, $33,
                    $34, $35, $36, $37,
                    $38, $39, $40,
                    $41, $42
                )
                ON CONFLICT (id) DO NOTHING",
                &[
                    &turn.id,
                    &turn.session_id,
                    &turn.sequence_num,
                    &turn.timestamp,
                    &turn.request_hash,
                    &turn.response_hash,
                    &turn.req_bytes_ref,
                    &turn.resp_bytes_ref,
                    &turn.req_bytes_size,
                    &turn.resp_bytes_size,
                    &turn.model,
                    &turn.response_text,
                    &turn.thinking_text,
                    &turn.stop_reason,
                    &turn.capture_complete,
                    &turn.input_tokens,
                    &turn.output_tokens,
                    &turn.cache_read_tokens,
                    &turn.cache_creation_tokens,
                    &turn.cost_usd,
                    &turn.created_at,
                    &turn.messages_delta,
                    &turn.messages_delta_count,
                    &turn.raw_extra,
                    &turn.parser_version,
                    &turn.parse_errors,
                    &turn.provider,
                    &turn.transport,
                    &turn.ws_direction,
                    &turn.duration_ms,
                    &turn.ttfb_ms,
                    &turn.api_endpoint,
                    &turn.http_status,
                    &turn.error_message,
                    &turn.retry_count,
                    &turn.tool_call_count,
                    &turn.thinking_tokens,
                    &turn.server_id,
                    &turn.integrity_verified,
                    &turn.supersedes_turn_id,
                    &turn.user_request_text,
                    &(turn.attachment_count as i32),
                ],
            )
            .await
            .map_err(|e| {
                if is_unique_violation(&e) {
                    classify_pg_unique_violation(e, "turn", turn.id.clone(), "turns_pkey")
                } else {
                    GraphStoreError::Other(anyhow::anyhow!("Failed to insert turn: {}", e))
                }
            })?;

        Ok(())
    }

    /// Atomically allocate the next `sequence_num` for `turn.session_id`
    /// and insert the turn — under a per-session PG advisory lock that
    /// serializes concurrent writers across MULTIPLE GATEWAY INSTANCES.
    ///
    /// Returns the assigned `sequence_num`. The caller's
    /// `turn.sequence_num` is ignored.
    ///
    /// Production-correct fix for the 2026-05-03 race condition. Two
    /// gateway processes (behind a load balancer) writing turns into
    /// the same session both block on the advisory lock; the second
    /// only sees the first's `MAX(sequence_num)` AFTER the first's
    /// transaction commits. No collisions are possible.
    ///
    /// `pg_advisory_xact_lock` is automatically released at COMMIT,
    /// so a panic / dropped connection / deadlock cannot leak the
    /// lock indefinitely (PG releases on backend disconnect anyway).
    async fn write_turn_atomic_seq_async(&self, turn: &TurnRecord) -> GraphStoreResult<i64> {
        let mut client = self.pool.get().await.map_err(|e| {
            GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
        })?;
        let tx = client.build_transaction().start().await.map_err(|e| {
            GraphStoreError::Other(anyhow::anyhow!(
                "BEGIN for atomic-seq turn insert failed: {}",
                e
            ))
        })?;

        // Per-session advisory lock. `hashtext($1)` returns int4; cast
        // to int8 to satisfy pg_advisory_xact_lock(bigint). Auto-
        // released at txn end.
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
            &[&turn.session_id],
        )
        .await
        .map_err(|e| {
            GraphStoreError::Other(anyhow::anyhow!(
                "pg_advisory_xact_lock for atomic-seq turn insert failed: {}",
                e
            ))
        })?;

        let next_seq: i64 = tx
            .query_one(
                "SELECT COALESCE(MAX(sequence_num), 0) + 1 FROM turns WHERE session_id = $1",
                &[&turn.session_id],
            )
            .await
            .map(|row| row.get(0))
            .map_err(|e| {
                GraphStoreError::Other(anyhow::anyhow!(
                    "SELECT MAX(sequence_num) inside advisory-locked txn failed: {}",
                    e
                ))
            })?;

        // Insert with the freshly-allocated seq. We bind `next_seq`
        // directly rather than using a subquery so the row layout
        // matches the regular `write_turn_async` insert exactly.
        tx.execute(
            "INSERT INTO turns (
                id, session_id, sequence_num, timestamp,
                request_hash, response_hash, req_bytes_ref, resp_bytes_ref,
                req_bytes_size, resp_bytes_size, model, response_text,
                thinking_text, stop_reason, capture_complete,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                cost_usd, created_at, messages_delta, messages_delta_count,
                raw_extra, parser_version, parse_errors,
                provider, transport, ws_direction,
                duration_ms, ttfb_ms, api_endpoint, http_status,
                error_message, retry_count, tool_call_count, thinking_tokens,
                server_id, integrity_verified, supersedes_turn_id,
                user_request_text, attachment_count
            ) VALUES (
                $1,  $2,  $3,  $4,
                $5,  $6,  $7,  $8,
                $9,  $10, $11, $12,
                $13, $14, $15,
                $16, $17, $18, $19,
                $20, $21, $22, $23,
                $24, $25, $26,
                $27, $28, $29,
                $30, $31, $32, $33,
                $34, $35, $36, $37,
                $38, $39, $40,
                $41, $42
            )
            ON CONFLICT (id) DO NOTHING",
            &[
                &turn.id,
                &turn.session_id,
                &next_seq,
                &turn.timestamp,
                &turn.request_hash,
                &turn.response_hash,
                &turn.req_bytes_ref,
                &turn.resp_bytes_ref,
                &turn.req_bytes_size,
                &turn.resp_bytes_size,
                &turn.model,
                &turn.response_text,
                &turn.thinking_text,
                &turn.stop_reason,
                &turn.capture_complete,
                &turn.input_tokens,
                &turn.output_tokens,
                &turn.cache_read_tokens,
                &turn.cache_creation_tokens,
                &turn.cost_usd,
                &turn.created_at,
                &turn.messages_delta,
                &turn.messages_delta_count,
                &turn.raw_extra,
                &turn.parser_version,
                &turn.parse_errors,
                &turn.provider,
                &turn.transport,
                &turn.ws_direction,
                &turn.duration_ms,
                &turn.ttfb_ms,
                &turn.api_endpoint,
                &turn.http_status,
                &turn.error_message,
                &turn.retry_count,
                &turn.tool_call_count,
                &turn.thinking_tokens,
                &turn.server_id,
                &turn.integrity_verified,
                &turn.supersedes_turn_id,
                &turn.user_request_text,
                &(turn.attachment_count as i32),
            ],
        )
        .await
        .map_err(|e| {
            if is_unique_violation(&e) {
                classify_pg_unique_violation(e, "turn", turn.id.clone(), "turns_pkey")
            } else {
                GraphStoreError::Other(anyhow::anyhow!(
                    "INSERT inside advisory-locked txn failed: {}",
                    e
                ))
            }
        })?;

        tx.commit().await.map_err(|e| {
            GraphStoreError::Other(anyhow::anyhow!(
                "COMMIT for atomic-seq turn insert failed: {}",
                e
            ))
        })?;
        Ok(next_seq)
    }

    /// Write a tool call to PostgreSQL.
    async fn write_tool_call_async(&self, tool_call: &ToolCallRecord) -> GraphStoreResult<()> {
        let client = self.pool.get().await.map_err(|e| {
            GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
        })?;

        client
            .execute(
                "INSERT INTO tool_calls (
                    id, turn_id, tool_name, tool_input, input_hash,
                    sequence_num, output, output_hash, duration_ms, error, status,
                    artifacts_created, artifact_hashes
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
                &[
                    &tool_call.id,
                    &tool_call.turn_id,
                    &tool_call.tool_name,
                    &tool_call.tool_input,
                    &tool_call.input_hash,
                    &tool_call.sequence_num,
                    &tool_call.output,
                    &tool_call.output_hash,
                    &tool_call.duration_ms,
                    &tool_call.error,
                    &tool_call.status,
                    &tool_call.artifacts_created,
                    &tool_call.artifact_hashes,
                ],
            )
            .await
            .map_err(|e| {
                if is_unique_violation(&e) {
                    classify_pg_unique_violation(
                        e,
                        "tool_call",
                        tool_call.id.clone(),
                        "tool_calls_pkey",
                    )
                } else {
                    GraphStoreError::Other(anyhow::anyhow!("Failed to insert tool call: {}", e))
                }
            })?;

        Ok(())
    }

    /// List sessions from PostgreSQL.
    async fn list_sessions_async(
        &self,
        limit: Option<i64>,
    ) -> GraphStoreResult<Vec<SessionRecord>> {
        let client = self.pool.get().await.map_err(|e| {
            GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
        })?;

        let effective_limit = limit.unwrap_or(1000);

        let rows = client
            .query(
                "SELECT id, provider, model, started_at, last_active_at, ended_at,
                        initial_intent, system_prompt_hash, total_turns, turns_captured,
                        dropped_events, total_tokens, total_cost_usd, framework,
                        agent_id, agent_version, git_repo, git_branch, git_commit,
                        working_directory, parent_session_id, tags,
                        account_uuid, device_id
                 FROM sessions ORDER BY started_at DESC LIMIT $1",
                &[&effective_limit],
            )
            .await
            .map_err(|e| {
                GraphStoreError::Other(anyhow::anyhow!("Failed to list sessions: {}", e))
            })?;

        let mut sessions = Vec::new();
        for row in &rows {
            sessions.push(session_from_pg_row(row).map_err(GraphStoreError::Other)?);
        }
        Ok(sessions)
    }

    /// Get all turns for a session, ordered by sequence_num.
    async fn get_turns_for_session_async(
        &self,
        session_id: &str,
    ) -> GraphStoreResult<Vec<TurnRecord>> {
        let client = self.pool.get().await.map_err(|e| {
            GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
        })?;

        let rows = client
            .query(
                &format!(
                    "SELECT {} FROM turns WHERE session_id = $1 ORDER BY sequence_num",
                    PG_TURN_COLUMNS
                ),
                &[&session_id],
            )
            .await
            .map_err(|e| GraphStoreError::Other(anyhow::anyhow!("Failed to get turns: {}", e)))?;

        let mut turns = Vec::new();
        for row in &rows {
            turns.push(turn_from_pg_row(row).map_err(GraphStoreError::Other)?);
        }
        Ok(turns)
    }

    /// Get a single turn by ID.
    async fn get_turn_async(&self, turn_id: &str) -> GraphStoreResult<Option<TurnRecord>> {
        let client = self.pool.get().await.map_err(|e| {
            GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
        })?;

        let rows = client
            .query(
                &format!("SELECT {} FROM turns WHERE id = $1", PG_TURN_COLUMNS),
                &[&turn_id],
            )
            .await
            .map_err(|e| GraphStoreError::Other(anyhow::anyhow!("Failed to get turn: {}", e)))?;

        match rows.first() {
            Some(row) => Ok(Some(turn_from_pg_row(row).map_err(GraphStoreError::Other)?)),
            None => Ok(None),
        }
    }

    /// FIND-1-1 (round 2): find the first row in `turns` whose
    /// `request_hash` equals the given content hash. Backed by
    /// `idx_turns_request_hash` (declared in
    /// `api/migrations/012_turns-request-hash-index.sql`). The
    /// `LIMIT 1` short-circuits when the index match is found, so
    /// the operation is O(log N) on the index height plus one
    /// heap fetch — no heap scan even when many turns share the
    /// same hash (which is unusual but possible in test data).
    async fn find_turn_by_request_hash_async(
        &self,
        request_hash: &str,
    ) -> GraphStoreResult<Option<TurnRecord>> {
        let client = self.pool.get().await.map_err(|e| {
            GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
        })?;
        let rows = client
            .query(
                &format!(
                    "SELECT {} FROM turns WHERE request_hash = $1 LIMIT 1",
                    PG_TURN_COLUMNS
                ),
                &[&request_hash],
            )
            .await
            .map_err(|e| {
                GraphStoreError::Other(anyhow::anyhow!(
                    "Failed to query turn by request_hash: {}",
                    e
                ))
            })?;
        match rows.first() {
            Some(row) => Ok(Some(turn_from_pg_row(row).map_err(GraphStoreError::Other)?)),
            None => Ok(None),
        }
    }

    /// Get all tool calls for a turn.
    async fn get_tool_calls_for_turn_async(
        &self,
        turn_id: &str,
    ) -> GraphStoreResult<Vec<ToolCallRecord>> {
        let client = self.pool.get().await.map_err(|e| {
            GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
        })?;

        let rows = client
            .query(
                "SELECT id, turn_id, tool_name, tool_input, input_hash,
                        sequence_num, output, output_hash, duration_ms, error, status,
                        artifacts_created, artifact_hashes
                 FROM tool_calls WHERE turn_id = $1 ORDER BY sequence_num",
                &[&turn_id],
            )
            .await
            .map_err(|e| {
                GraphStoreError::Other(anyhow::anyhow!("Failed to get tool calls: {}", e))
            })?;

        let mut tool_calls = Vec::new();
        for row in &rows {
            tool_calls.push(tool_call_from_pg_row(row).map_err(GraphStoreError::Other)?);
        }
        Ok(tool_calls)
    }

    /// List sessions by account_uuid.
    async fn list_sessions_by_account_async(
        &self,
        account_uuid: &str,
    ) -> GraphStoreResult<Vec<SessionRecord>> {
        let client = self.pool.get().await.map_err(|e| {
            GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
        })?;

        let rows = client
            .query(
                "SELECT id, provider, model, started_at, last_active_at, ended_at,
                        initial_intent, system_prompt_hash, total_turns, turns_captured,
                        dropped_events, total_tokens, total_cost_usd, framework,
                        agent_id, agent_version, git_repo, git_branch, git_commit,
                        working_directory, parent_session_id, tags,
                        account_uuid, device_id
                 FROM sessions WHERE account_uuid = $1 ORDER BY started_at DESC",
                &[&account_uuid],
            )
            .await
            .map_err(|e| {
                GraphStoreError::Other(anyhow::anyhow!("Failed to list sessions by account: {}", e))
            })?;

        let mut sessions = Vec::new();
        for row in &rows {
            sessions.push(session_from_pg_row(row).map_err(GraphStoreError::Other)?);
        }
        Ok(sessions)
    }

    /// PostgreSQL implementation of
    /// [`crate::storage::graph::GraphStore::get_previous_messages_prefix_marker`].
    ///
    /// # Contract
    ///
    /// **The canonical contract lives on the trait method's docstring; this
    /// impl adheres to it byte-for-byte and must not drift.** In summary,
    /// the return value is a JSON-serialized array of `null` values whose
    /// only observable property is `.len()`; callers must treat the shape
    /// as opaque beyond its length.
    ///
    /// # Dual-mode query
    ///
    /// `prev_len = SUM(messages_delta_count) FOR seq <= sequence_num`, with
    /// a `-1` adjustment when `MAX(seq) == sequence_num` (i.e. when the
    /// caller is querying post-write about a turn that is already
    /// committed, subtract the new user message that turn contributed so
    /// the caller's `compute_true_delta` still yields the pre-turn-N
    /// conversation state).
    ///
    /// # Backward-compat
    ///
    /// Pre-fix sessions may have stored overshot `messages_delta_count`
    /// values. `compute_true_delta` owns a runtime safety clamp
    /// (`previous.len() > current.len()` => fall back to
    /// "last-message-only" delta) that prevents ambiguous data from
    /// silently dropping forward attachment captures. See
    /// `compute_true_delta` in `src/providers/anthropic.rs` for detail.
    ///
    /// Bug #1 fix: the prior implementation returned the previous turn's
    /// stored `messages_delta` (a partial prefix — only the messages
    /// appended by that single turn), which caused
    /// `compute_true_delta(current, prev)` to under-count and drag
    /// historical messages into the new turn's delta.
    async fn get_previous_messages_prefix_marker_async(
        &self,
        session_id: &str,
        sequence_num: i64,
    ) -> GraphStoreResult<Option<String>> {
        if sequence_num <= 1 {
            return Ok(None);
        }

        let client = self.pool.get().await.map_err(|e| {
            GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
        })?;

        let rows = client
            .query(
                "SELECT COALESCE(SUM(messages_delta_count), 0)::BIGINT AS total, \
                 COALESCE(MAX(sequence_num), 0)::BIGINT AS max_seq \
                 FROM turns WHERE session_id = $1 AND sequence_num <= $2",
                &[&session_id, &sequence_num],
            )
            .await
            .map_err(|e| {
                GraphStoreError::Other(anyhow::anyhow!(
                    "Failed to get previous turn cumulative count: {}",
                    e
                ))
            })?;

        let row = match rows.first() {
            Some(r) => r,
            None => return Ok(None),
        };
        let total: i64 = row.get(0);
        let max_seq: i64 = row.get(1);
        if max_seq == 0 {
            return Ok(None);
        }
        let prev_len = if max_seq == sequence_num {
            (total - 1).max(0)
        } else {
            total.max(0)
        };
        let synth = vec![serde_json::Value::Null; prev_len as usize];
        let s = serde_json::to_string(&synth).map_err(|e| {
            GraphStoreError::Other(anyhow::anyhow!(
                "Failed to serialize synthesized prefix: {}",
                e
            ))
        })?;
        Ok(Some(s))
    }
}

/// Column list for PG turn queries — must match the order in `turn_from_pg_row`.
const PG_TURN_COLUMNS: &str = "id, session_id, sequence_num, timestamp, request_hash, response_hash, req_bytes_ref, resp_bytes_ref, req_bytes_size, resp_bytes_size, model, response_text, thinking_text, stop_reason, capture_complete, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, created_at, messages_delta, messages_delta_count, raw_extra, parser_version, parse_errors, provider, transport, ws_direction, duration_ms, ttfb_ms, api_endpoint, http_status, error_message, retry_count, tool_call_count, thinking_tokens, server_id, integrity_verified, supersedes_turn_id, user_request_text, attachment_count";

/// Map a PG row to a SessionRecord.
fn session_from_pg_row(row: &tokio_postgres::Row) -> Result<SessionRecord> {
    Ok(SessionRecord {
        id: row.get(0),
        provider: row.get(1),
        model: row.get(2),
        started_at: row.get(3),
        last_active_at: row.get(4),
        ended_at: row.get(5),
        initial_intent: row.get(6),
        system_prompt_hash: row.get(7),
        total_turns: row.get(8),
        turns_captured: row.get(9),
        dropped_events: row.get(10),
        total_tokens: row.get(11),
        total_cost_usd: row.get(12),
        framework: row.get(13),
        agent_id: row.get(14),
        agent_version: row.get(15),
        git_repo: row.get(16),
        git_branch: row.get(17),
        git_commit: row.get(18),
        working_directory: row.get(19),
        parent_session_id: row.get(20),
        tags: row.get(21),
        account_uuid: row.get(22),
        device_id: row.get(23),
        ..Default::default()
    })
}

/// Map a PG row to a TurnRecord. Row must contain PG_TURN_COLUMNS in order.
fn turn_from_pg_row(row: &tokio_postgres::Row) -> Result<TurnRecord> {
    Ok(TurnRecord {
        id: row.get(0),
        session_id: row.get(1),
        sequence_num: row.get(2),
        timestamp: row.get(3),
        request_hash: row.get(4),
        response_hash: row.get(5),
        req_bytes_ref: row.get(6),
        resp_bytes_ref: row.get(7),
        req_bytes_size: row.get(8),
        resp_bytes_size: row.get(9),
        model: row.get(10),
        response_text: row.get(11),
        thinking_text: row.get(12),
        stop_reason: row.get(13),
        capture_complete: row.get(14),
        input_tokens: row.get(15),
        output_tokens: row.get(16),
        cache_read_tokens: row.get(17),
        cache_creation_tokens: row.get(18),
        cost_usd: row.get(19),
        created_at: row.get(20),
        messages_delta: row.get(21),
        messages_delta_count: row.get(22),
        raw_extra: row.get(23),
        parser_version: row.get(24),
        parse_errors: row.get(25),
        provider: row.get(26),
        transport: row.get(27),
        ws_direction: row.get(28),
        duration_ms: row.get(29),
        ttfb_ms: row.get(30),
        api_endpoint: row.get(31),
        http_status: row.get(32),
        error_message: row.get(33),
        // W4: Defensive nullable reads for NOT NULL columns with DEFAULT.
        // These columns are NOT NULL in the schema, but reading as Option<i64>
        // with unwrap_or(0) is intentionally defensive: it handles rows that
        // were inserted before the column was added (via ALTER TABLE ADD COLUMN
        // with DEFAULT) or if a migration accidentally drops the NOT NULL
        // constraint. Safer than panicking on a type mismatch.
        retry_count: row.get::<_, Option<i64>>(34).unwrap_or(0),
        tool_call_count: row.get::<_, Option<i64>>(35).unwrap_or(0),
        thinking_tokens: row.get::<_, Option<i64>>(36).unwrap_or(0),
        server_id: row.get(37),
        integrity_verified: row.get(38),
        supersedes_turn_id: row.get(39),
        user_request_text: row.get(40),
        attachment_count: row.get::<_, Option<i32>>(41).map(|v| v as i64).unwrap_or(0),
    })
}

/// Map a PG row to a ToolCallRecord.
fn tool_call_from_pg_row(row: &tokio_postgres::Row) -> Result<ToolCallRecord> {
    Ok(ToolCallRecord {
        id: row.get(0),
        turn_id: row.get(1),
        tool_name: row.get(2),
        tool_input: row.get(3),
        input_hash: row.get(4),
        sequence_num: row.get(5),
        output: row.get(6),
        output_hash: row.get(7),
        duration_ms: row.get(8),
        error: row.get(9),
        status: row.get(10),
        artifacts_created: row.get(11),
        artifact_hashes: row.get(12),
    })
}

impl GraphStore for PostgresGraphStore {
    fn write_session(&self, session: &SessionRecord) -> GraphStoreResult<()> {
        self.block_on(self.write_session_async(session))
    }

    fn write_turn(&self, turn: &TurnRecord) -> GraphStoreResult<()> {
        self.block_on(self.write_turn_async(turn))
    }

    fn write_turn_atomic_seq(&self, turn: &TurnRecord) -> GraphStoreResult<i64> {
        self.block_on(self.write_turn_atomic_seq_async(turn))
    }

    fn write_tool_call(&self, tool_call: &ToolCallRecord) -> GraphStoreResult<()> {
        self.block_on(self.write_tool_call_async(tool_call))
    }

    fn list_sessions(&self, limit: Option<i64>) -> GraphStoreResult<Vec<SessionRecord>> {
        self.block_on(self.list_sessions_async(limit))
    }

    fn get_turns_for_session(&self, session_id: &str) -> GraphStoreResult<Vec<TurnRecord>> {
        self.block_on(self.get_turns_for_session_async(session_id))
    }

    fn get_turn(&self, turn_id: &str) -> GraphStoreResult<Option<TurnRecord>> {
        self.block_on(self.get_turn_async(turn_id))
    }

    fn find_turn_by_request_hash(
        &self,
        request_hash: &str,
    ) -> GraphStoreResult<Option<TurnRecord>> {
        self.block_on(self.find_turn_by_request_hash_async(request_hash))
    }

    fn get_tool_calls_for_turn(&self, turn_id: &str) -> GraphStoreResult<Vec<ToolCallRecord>> {
        self.block_on(self.get_tool_calls_for_turn_async(turn_id))
    }

    fn get_previous_messages_prefix_marker(
        &self,
        session_id: &str,
        sequence_num: i64,
    ) -> GraphStoreResult<Option<String>> {
        self.block_on(self.get_previous_messages_prefix_marker_async(session_id, sequence_num))
    }

    fn list_sessions_by_account(&self, account_uuid: &str) -> GraphStoreResult<Vec<SessionRecord>> {
        self.block_on(self.list_sessions_by_account_async(account_uuid))
    }

    fn verify_integrity(
        &self,
        session_id: &str,
        object_store: Option<&dyn super::object::ObjectStore>,
    ) -> GraphStoreResult<Vec<IntegrityResult>> {
        let turns = self.get_turns_for_session(session_id)?;
        let mut results = Vec::new();

        for turn in &turns {
            let has_req_hash = !turn.request_hash.is_empty();
            let has_resp_hash = !turn.response_hash.is_empty();

            if !has_req_hash || !has_resp_hash {
                results.push(IntegrityResult {
                    turn_id: turn.id.clone(),
                    passed: false,
                    expected_hash: turn.request_hash.clone(),
                    details: Some("Missing request or response hash".to_string()),
                });
                continue;
            }

            if let Some(store) = object_store {
                let req_ok = store.verify("req", &turn.request_hash).unwrap_or(false);
                let resp_ok = store.verify("resp", &turn.response_hash).unwrap_or(false);
                let passed = req_ok && resp_ok;
                let details = if passed {
                    None
                } else {
                    let mut parts = Vec::new();
                    if !req_ok {
                        parts.push(format!(
                            "request hash {} failed re-hash verification",
                            turn.request_hash
                        ));
                    }
                    if !resp_ok {
                        parts.push(format!(
                            "response hash {} failed re-hash verification",
                            turn.response_hash
                        ));
                    }
                    Some(parts.join("; "))
                };
                results.push(IntegrityResult {
                    turn_id: turn.id.clone(),
                    passed,
                    expected_hash: turn.request_hash.clone(),
                    details,
                });
            } else {
                // Shallow check: hashes are present (already verified above).
                results.push(IntegrityResult {
                    turn_id: turn.id.clone(),
                    passed: true,
                    expected_hash: turn.request_hash.clone(),
                    details: None,
                });
            }
        }

        Ok(results)
    }

    fn update_session_totals(
        &self,
        session_id: &str,
        delta_turns: i64,
        delta_captured: i64,
        delta_tokens: i64,
        delta_cost_usd: f64,
    ) -> GraphStoreResult<()> {
        self.block_on(async {
            let client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            let rows_affected = client
                .execute(
                    "UPDATE sessions SET total_turns = total_turns + $2, turns_captured = turns_captured + $3, total_tokens = total_tokens + $4, total_cost_usd = total_cost_usd + $5, last_active_at = NOW() WHERE id = $1",
                    &[&session_id, &delta_turns, &delta_captured, &delta_tokens, &delta_cost_usd],
                )
                .await
                .map_err(|e| {
                    GraphStoreError::Other(anyhow::anyhow!(
                        "Failed to update session totals: {}",
                        e
                    ))
                })?;
            if rows_affected == 0 {
                return Err(GraphStoreError::Other(anyhow::anyhow!(
                    "session not found: {}",
                    session_id
                )));
            }
            Ok(())
        })
    }

    fn record_gdpr_deletion(
        &self,
        object_hash: &str,
        deleted_by: &str,
        gdpr_request_id: &str,
    ) -> GraphStoreResult<()> {
        self.block_on(async {
            let client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            let id = uuid::Uuid::new_v4().to_string();
            let deleted_at = time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_else(|_| "unknown".to_string());
            client
                .execute(
                    "INSERT INTO gdpr_deletions (id, object_hash, deleted_at, deleted_by, gdpr_request_id) VALUES ($1, $2, $3, $4, $5)",
                    &[&id, &object_hash, &deleted_at, &deleted_by, &gdpr_request_id],
                )
                .await
                .map_err(|e| {
                    GraphStoreError::Other(anyhow::anyhow!(
                        "Failed to record GDPR deletion: {}",
                        e
                    ))
                })?;
            Ok(())
        })
    }

    fn list_gdpr_deletions(&self) -> GraphStoreResult<Vec<crate::db::GdprDeletionRecord>> {
        self.block_on(async {
            let client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            let rows = client
                .query(
                    "SELECT id, object_hash, deleted_at, deleted_by, gdpr_request_id FROM gdpr_deletions ORDER BY deleted_at",
                    &[],
                )
                .await
                .map_err(|e| {
                    GraphStoreError::Other(anyhow::anyhow!(
                        "Failed to list GDPR deletions: {}",
                        e
                    ))
                })?;
            let records = rows
                .iter()
                .map(|row| crate::db::GdprDeletionRecord {
                    id: row.get(0),
                    object_hash: row.get(1),
                    deleted_at: row.get(2),
                    deleted_by: row.get(3),
                    gdpr_request_id: row.get(4),
                })
                .collect();
            Ok(records)
        })
    }

    fn nullify_turn_parsed_fields(&self, turn_id: &str) -> GraphStoreResult<()> {
        self.block_on(async {
            let mut client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            // W1/W3 fix: Use a transaction with GDPR bypass to bypass immutability triggers.
            let txn = client.transaction().await.map_err(|e| {
                GraphStoreError::Other(anyhow::anyhow!("Failed to begin transaction: {}", e))
            })?;
            txn.execute("SET LOCAL recondo.gdpr_bypass = 'true'", &[])
                .await
                .map_err(|e| {
                    GraphStoreError::Other(anyhow::anyhow!(
                        "Failed to set GDPR bypass: {}",
                        e
                    ))
                })?;
            let rows_affected = txn
                .execute(
                    "UPDATE turns SET response_text = NULL, thinking_text = NULL, messages_delta = NULL, raw_extra = NULL WHERE id = $1",
                    &[&turn_id],
                )
                .await
                .map_err(|e| {
                    GraphStoreError::Other(anyhow::anyhow!(
                        "Failed to nullify turn parsed fields: {}",
                        e
                    ))
                })?;
            if rows_affected == 0 {
                return Err(GraphStoreError::Other(anyhow::anyhow!(
                    "turn not found: {}",
                    turn_id
                )));
            }
            // N2 fix: Also clear tool_call PII (tool_input, output) for the turn.
            txn.execute(
                "UPDATE tool_calls SET tool_input = NULL, output = NULL WHERE turn_id = $1",
                &[&turn_id],
            )
            .await
            .map_err(|e| {
                GraphStoreError::Other(anyhow::anyhow!(
                    "Failed to nullify tool call PII: {}",
                    e
                ))
            })?;
            txn.commit().await.map_err(|e| {
                GraphStoreError::Other(anyhow::anyhow!("Failed to commit GDPR transaction: {}", e))
            })?;
            Ok(())
        })
    }

    fn find_supersedes_for_session(
        &self,
        session_id: &str,
        artifact_paths: &[String],
    ) -> GraphStoreResult<Option<String>> {
        if artifact_paths.is_empty() {
            return Ok(None);
        }
        self.block_on(async {
            let client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            // Query all tool calls in this session that have artifacts_created, ordered by turn sequence descending
            let rows = client
                .query(
                    "SELECT tc.turn_id, tc.artifacts_created
                     FROM tool_calls tc
                     JOIN turns t ON tc.turn_id = t.id
                     WHERE t.session_id = $1
                       AND tc.artifacts_created IS NOT NULL
                       AND tc.artifacts_created != '[]'
                     ORDER BY t.sequence_num DESC",
                    &[&session_id],
                )
                .await
                .map_err(|e| {
                    GraphStoreError::Other(anyhow::anyhow!(
                        "Failed to query tool_calls for supersedes: {}",
                        e
                    ))
                })?;

            for row in &rows {
                let turn_id: String = row.get(0);
                let artifacts_json: String = row.get(1);
                if let Ok(paths) = serde_json::from_str::<Vec<String>>(&artifacts_json) {
                    for ap in artifact_paths {
                        if paths.iter().any(|p| p == ap) {
                            return Ok(Some(turn_id));
                        }
                    }
                }
            }

            Ok(None)
        })
    }

    fn get_session(&self, session_id: &str) -> GraphStoreResult<Option<SessionRecord>> {
        self.block_on(async {
            let client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            let rows = client
                .query(
                    "SELECT id, provider, model, started_at, last_active_at, ended_at,
                            initial_intent, system_prompt_hash, total_turns, turns_captured,
                            dropped_events, total_tokens, total_cost_usd, framework,
                            agent_id, agent_version, git_repo, git_branch, git_commit,
                            working_directory, parent_session_id, tags,
                            account_uuid, device_id
                     FROM sessions WHERE id = $1",
                    &[&session_id],
                )
                .await
                .map_err(|e| {
                    GraphStoreError::Other(anyhow::anyhow!("Failed to get session: {}", e))
                })?;
            if rows.is_empty() {
                return Ok(None);
            }
            let session = session_from_pg_row(&rows[0]).map_err(GraphStoreError::Other)?;
            Ok(Some(session))
        })
    }

    fn write_anomaly_event(&self, event: &crate::db::AnomalyEventRecord) -> GraphStoreResult<()> {
        self.block_on(async {
            let client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            client
                .execute(
                    "INSERT INTO anomaly_events (id, session_id, turn_id, anomaly_type, severity, description, detected_at, resolved_at, metadata)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                    &[
                        &event.id,
                        &event.session_id,
                        &event.turn_id,
                        &event.anomaly_type,
                        &event.severity,
                        &event.description,
                        &event.detected_at,
                        &event.resolved_at as &(dyn tokio_postgres::types::ToSql + Sync),
                        // metadata column is JSONB. The Rust struct
                        // carries it as a JSON-formatted String; parse to
                        // serde_json::Value so tokio-postgres binds it as
                        // JSONB (`with-serde_json-1` feature). Falling
                        // back to an empty object on parse failure
                        // matches the schema default `'{}'::jsonb` and
                        // ensures the audit row still lands.
                        &parse_jsonb_metadata(&event.metadata),
                    ],
                )
                .await
                .map_err(|e| {
                    GraphStoreError::Other(anyhow::anyhow!(
                        "Failed to insert anomaly event: {}",
                        e
                    ))
                })?;
            Ok(())
        })
    }

    fn update_session_system_prompt_hash(
        &self,
        session_id: &str,
        new_hash: &str,
    ) -> GraphStoreResult<()> {
        self.block_on(async {
            let client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            client
                .execute(
                    "UPDATE sessions SET system_prompt_hash = $2 WHERE id = $1",
                    &[&session_id, &new_hash],
                )
                .await
                .map_err(|e| {
                    GraphStoreError::Other(anyhow::anyhow!(
                        "Failed to update session system_prompt_hash: {}",
                        e
                    ))
                })?;
            Ok(())
        })
    }

    fn record_drift_event(
        &self,
        event: &crate::db::AnomalyEventRecord,
        session_id: &str,
        new_hash: &str,
    ) -> GraphStoreResult<()> {
        // Not transactional — INSERT + UPDATE can partially commit. Safe failure
        // mode: drift will be re-detected on next turn. Transaction support
        // deferred to future sprint.
        self.block_on(async {
            let client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            client
                .execute(
                    "INSERT INTO anomaly_events (id, session_id, turn_id, anomaly_type, severity, description, detected_at, resolved_at, metadata)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                    &[
                        &event.id,
                        &event.session_id,
                        &event.turn_id,
                        &event.anomaly_type,
                        &event.severity,
                        &event.description,
                        &event.detected_at,
                        &event.resolved_at as &(dyn tokio_postgres::types::ToSql + Sync),
                        // metadata column is JSONB. The Rust struct
                        // carries it as a JSON-formatted String; parse to
                        // serde_json::Value so tokio-postgres binds it as
                        // JSONB (`with-serde_json-1` feature). Falling
                        // back to an empty object on parse failure
                        // matches the schema default `'{}'::jsonb` and
                        // ensures the audit row still lands.
                        &parse_jsonb_metadata(&event.metadata),
                    ],
                )
                .await
                .map_err(|e| {
                    GraphStoreError::Other(anyhow::anyhow!(
                        "Failed to insert anomaly event: {}",
                        e
                    ))
                })?;
            client
                .execute(
                    "UPDATE sessions SET system_prompt_hash = $2 WHERE id = $1",
                    &[&session_id, &new_hash],
                )
                .await
                .map_err(|e| {
                    GraphStoreError::Other(anyhow::anyhow!(
                        "Failed to update session system_prompt_hash: {}",
                        e
                    ))
                })?;
            Ok(())
        })
    }

    fn update_session_framework(&self, session_id: &str, framework: &str) -> GraphStoreResult<()> {
        self.block_on(async {
            let client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            client
                .execute(
                    "UPDATE sessions SET framework = $2 WHERE id = $1 AND (framework IS NULL OR framework = '')",
                    &[&session_id, &framework],
                )
                .await
                .map_err(|e| {
                    GraphStoreError::Other(anyhow::anyhow!(
                        "Failed to update session framework: {}",
                        e
                    ))
                })?;
            Ok(())
        })
    }

    fn update_session_model(&self, session_id: &str, model: &str) -> GraphStoreResult<()> {
        self.block_on(async {
            let client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            client
                .execute(
                    "UPDATE sessions SET model = $2 WHERE id = $1 AND (model IS NULL OR model = '')",
                    &[&session_id, &model],
                )
                .await
                .map_err(|e| {
                    GraphStoreError::Other(anyhow::anyhow!(
                        "Failed to update session model: {}",
                        e
                    ))
                })?;
            Ok(())
        })
    }

    fn update_session_initial_intent(
        &self,
        session_id: &str,
        initial_intent: &str,
    ) -> GraphStoreResult<()> {
        self.block_on(async {
            let client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            client
                .execute(
                    "UPDATE sessions SET initial_intent = $2 WHERE id = $1 AND (initial_intent IS NULL OR initial_intent = '')",
                    &[&session_id, &initial_intent],
                )
                .await
                .map_err(|e| {
                    GraphStoreError::Other(anyhow::anyhow!(
                        "Failed to update session initial_intent: {}",
                        e
                    ))
                })?;
            Ok(())
        })
    }

    fn write_heartbeat(&self, hb: &crate::db::HeartbeatRecord) -> GraphStoreResult<()> {
        self.block_on(async {
            let client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            client
                .execute(
                    "INSERT INTO heartbeats (id, gateway_id, status) VALUES ($1, $2, $3)",
                    &[&hb.id, &hb.gateway_id, &hb.status],
                )
                .await
                .map_err(|e| {
                    GraphStoreError::Other(anyhow::anyhow!("Failed to write heartbeat: {}", e))
                })?;
            Ok(())
        })
    }

    fn update_session_tool_definitions_hash(
        &self,
        session_id: &str,
        new_hash: &str,
    ) -> GraphStoreResult<()> {
        self.block_on(async {
            let client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            client
                .execute(
                    "UPDATE sessions SET tool_definitions_hash = $2 WHERE id = $1",
                    &[&session_id, &new_hash],
                )
                .await
                .map_err(|e| {
                    GraphStoreError::Other(anyhow::anyhow!(
                        "Failed to update session tool_definitions_hash: {}",
                        e
                    ))
                })?;
            Ok(())
        })
    }

    fn record_tool_drift_event(
        &self,
        event: &crate::db::AnomalyEventRecord,
        session_id: &str,
        new_tool_hash: &str,
    ) -> GraphStoreResult<()> {
        // Not transactional — INSERT + UPDATE can partially commit. Safe failure
        // mode: drift will be re-detected on next turn. Transaction support
        // deferred to future sprint.
        self.block_on(async {
            let client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            client
                .execute(
                    "INSERT INTO anomaly_events (id, session_id, turn_id, anomaly_type, severity, description, detected_at, resolved_at, metadata)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                    &[
                        &event.id,
                        &event.session_id,
                        &event.turn_id,
                        &event.anomaly_type,
                        &event.severity,
                        &event.description,
                        &event.detected_at,
                        &event.resolved_at as &(dyn tokio_postgres::types::ToSql + Sync),
                        // metadata column is JSONB. The Rust struct
                        // carries it as a JSON-formatted String; parse to
                        // serde_json::Value so tokio-postgres binds it as
                        // JSONB (`with-serde_json-1` feature). Falling
                        // back to an empty object on parse failure
                        // matches the schema default `'{}'::jsonb` and
                        // ensures the audit row still lands.
                        &parse_jsonb_metadata(&event.metadata),
                    ],
                )
                .await
                .map_err(|e| {
                    GraphStoreError::Other(anyhow::anyhow!(
                        "Failed to insert anomaly event: {}",
                        e
                    ))
                })?;
            client
                .execute(
                    "UPDATE sessions SET tool_definitions_hash = $2 WHERE id = $1",
                    &[&session_id, &new_tool_hash],
                )
                .await
                .map_err(|e| {
                    GraphStoreError::Other(anyhow::anyhow!(
                        "Failed to update session tool_definitions_hash: {}",
                        e
                    ))
                })?;
            Ok(())
        })
    }

    fn write_attachment(&self, a: &AttachmentRecord) -> GraphStoreResult<()> {
        self.block_on(async {
            let client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            // ON CONFLICT DO NOTHING is idempotent: a retrying pipeline won't
            // duplicate rows, and concurrent inserts for the same id (rare,
            // but possible) settle deterministically.
            client
                .execute(
                    "INSERT INTO attachments (
                        id, turn_id, session_id, sequence_num, role, kind,
                        mime_type, size_bytes, sha256, object_ref,
                        filename, width, height
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6,
                        $7, $8, $9, $10,
                        $11, $12, $13
                    )
                    ON CONFLICT (id) DO NOTHING",
                    &[
                        &a.id,
                        &a.turn_id,
                        &a.session_id,
                        &(a.sequence_num as i32),
                        &a.role,
                        &a.kind,
                        &a.mime_type,
                        &a.size_bytes,
                        &a.sha256,
                        &a.object_ref,
                        &a.filename,
                        &a.width.map(|v| v as i32),
                        &a.height.map(|v| v as i32),
                    ],
                )
                .await
                .map_err(|e| {
                    // FIND-3-RUST-2: classify permanent vs transient so
                    // WritePipeline retry loop skips backoff on permanent
                    // failures (missing tables, insufficient privilege,
                    // schema mismatch). Retaining `anyhow::Error` so the
                    // original PG message (with SqlState) is preserved
                    // for DLQ diagnosis.
                    let wrapped = anyhow::anyhow!("Failed to insert attachment: {}", e);
                    classify_postgres_error_preserving(wrapped, e)
                })?;
            Ok(())
        })
    }

    /// Race-safe attachment write — closes the dangling-row gap that
    /// the default `write_attachment` left open. See the trait
    /// docstring (graph.rs) for the failure mode this fixes.
    ///
    /// The implementation:
    ///   1. Begins a tx
    ///   2. Takes `pg_advisory_xact_lock(hashtext(sha256)::bigint)` —
    ///      same key as `with_sha256_orphan_delete_lock`
    ///   3. Calls `blob_exists()` while the lock is held; if the blob
    ///      is missing, refuses the insert (returns Other(...))
    ///   4. INSERTs the row
    ///   5. Commits (releases lock)
    ///
    /// A concurrent orphan-delete for the same sha is forced to wait
    /// on the lock; once it acquires, our INSERT has either committed
    /// (deleter sees count=1, no delete) or hasn't started (deleter
    /// proceeds, then our blob_exists check fails, refuse insert).
    fn write_attachment_with_blob_check(
        &self,
        a: &AttachmentRecord,
        blob_exists: &mut dyn FnMut() -> anyhow::Result<bool>,
    ) -> GraphStoreResult<()> {
        // The blob check is meaningful only when the row carries a
        // sha. URL-only attachments (empty sha) skip the lock.
        if a.sha256.is_empty() {
            return self.write_attachment(a);
        }
        // Probe the closure outside the runtime — `blob_exists`
        // typically calls into ObjectStore which may itself drive a
        // tokio runtime. Capture the result before we enter our
        // async block.
        let blob_present = blob_exists().map_err(GraphStoreError::Other)?;
        self.block_on(async move {
            let mut client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            let tx = client.build_transaction().start().await.map_err(|e| {
                let wrapped = anyhow::anyhow!("Failed to start tx: {}", e);
                classify_postgres_error_preserving(wrapped, e)
            })?;
            tx.execute(
                "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
                &[&a.sha256],
            )
            .await
            .map_err(|e| {
                let wrapped = anyhow::anyhow!("Failed to acquire orphan-delete lock: {}", e);
                classify_postgres_error_preserving(wrapped, e)
            })?;
            // While the lock is held, no concurrent
            // `with_sha256_orphan_delete_lock` for the same sha can
            // run. If our pre-tx check showed the blob was missing,
            // refuse the insert; an orphan-delete that ran before us
            // already removed the blob and the row would dangle.
            if !blob_present {
                return Err(GraphStoreError::Other(anyhow::anyhow!(
                    "blob for sha256 {} no longer exists; refusing to insert dangling attachment row",
                    a.sha256
                )));
            }
            tx.execute(
                "INSERT INTO attachments (
                    id, turn_id, session_id, sequence_num, role, kind,
                    mime_type, size_bytes, sha256, object_ref,
                    filename, width, height
                ) VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10,
                    $11, $12, $13
                )
                ON CONFLICT (id) DO NOTHING",
                &[
                    &a.id,
                    &a.turn_id,
                    &a.session_id,
                    &(a.sequence_num as i32),
                    &a.role,
                    &a.kind,
                    &a.mime_type,
                    &a.size_bytes,
                    &a.sha256,
                    &a.object_ref,
                    &a.filename,
                    &a.width.map(|v| v as i32),
                    &a.height.map(|v| v as i32),
                ],
            )
            .await
            .map_err(|e| {
                let wrapped = anyhow::anyhow!("Failed to insert attachment under orphan lock: {}", e);
                classify_postgres_error_preserving(wrapped, e)
            })?;
            tx.commit().await.map_err(|e| {
                let wrapped = anyhow::anyhow!("Failed to commit attachment-with-blob-check tx: {}", e);
                classify_postgres_error_preserving(wrapped, e)
            })?;
            Ok(())
        })
    }

    fn update_turn_attachment_count(&self, turn_id: &str, count: i64) -> GraphStoreResult<()> {
        self.block_on(async {
            let client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            client
                .execute(
                    "UPDATE turns SET attachment_count = $2 WHERE id = $1",
                    &[&turn_id, &count],
                )
                .await
                .map_err(|e| {
                    let wrapped = anyhow::anyhow!("Failed to update turn.attachment_count: {}", e);
                    classify_postgres_error_preserving(wrapped, e)
                })?;
            Ok(())
        })
    }

    fn attachment_sha256_reference_count(&self, sha256: &str) -> GraphStoreResult<i64> {
        self.block_on(async {
            let client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            let row = client
                .query_one(
                    "SELECT COUNT(*)::BIGINT FROM attachments WHERE sha256 = $1",
                    &[&sha256],
                )
                .await
                .map_err(|e| {
                    let wrapped =
                        anyhow::anyhow!("Failed to count attachment references for sha256: {}", e);
                    classify_postgres_error_preserving(wrapped, e)
                })?;
            Ok(row.get::<_, i64>(0))
        })
    }

    fn with_sha256_orphan_delete_lock(
        &self,
        sha256: &str,
        delete_blob: &mut dyn FnMut() -> anyhow::Result<()>,
    ) -> GraphStoreResult<bool> {
        // FIND-6-F: the closure runs outside the async block so we
        // can hold it across the awaits. Capture the sha256 into the
        // closure via the outer call's `sha256` parameter.
        self.block_on(async move {
            let mut client = self.pool.get().await.map_err(|e| {
                GraphStoreError::ConnectionFailed(format!("Failed to get PG connection: {}", e))
            })?;
            let tx = client.build_transaction().start().await.map_err(|e| {
                let wrapped = anyhow::anyhow!("Failed to start transaction: {}", e);
                classify_postgres_error_preserving(wrapped, e)
            })?;
            // FIND-6-F atomicity: pg_advisory_xact_lock serialises
            // with any other session that takes the same lock key.
            // `hashtext(sha256)` yields a stable int4; we extend to
            // int8 via a cast so PG's `pg_advisory_xact_lock(bigint)`
            // signature matches. Two concurrent orphan-cleanup
            // pipelines for the same sha256 serialise here; a
            // concurrent `write_attachment` for the same sha256
            // does NOT take this advisory lock (that path isn't
            // aware of orphan cleanup), so the guarantee we rely on
            // is the ensuing count re-check: if a concurrent writer
            // committed BEFORE we took the lock, we see it via the
            // count; if it commits AFTER our transaction ends, its
            // row survives. The window where count=0 under the lock
            // AND the blob is deleted AND a new writer commits is
            // closed because the writer's row references a blob
            // that no longer exists — and our delete happens
            // *under* the lock, so no interleaving is possible.
            tx.execute(
                "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
                &[&sha256],
            )
            .await
            .map_err(|e| {
                let wrapped = anyhow::anyhow!("Failed to acquire advisory lock: {}", e);
                classify_postgres_error_preserving(wrapped, e)
            })?;
            let row = tx
                .query_one(
                    "SELECT COUNT(*)::BIGINT FROM attachments WHERE sha256 = $1",
                    &[&sha256],
                )
                .await
                .map_err(|e| {
                    let wrapped =
                        anyhow::anyhow!("Failed to count attachment references under lock: {}", e);
                    classify_postgres_error_preserving(wrapped, e)
                })?;
            let count: i64 = row.get(0);
            if count > 0 {
                tx.commit().await.map_err(|e| {
                    let wrapped = anyhow::anyhow!("Failed to commit orphan-check tx: {}", e);
                    classify_postgres_error_preserving(wrapped, e)
                })?;
                return Ok(false);
            }
            // count == 0 under the advisory lock: safe to delete.
            // Invoke the blocking closure synchronously (the closure
            // is a plain `FnMut() -> Result` — no async state to
            // await). The transaction is still open, so the lock is
            // held while the closure runs.
            let closure_result = delete_blob();
            tx.commit().await.map_err(|e| {
                let wrapped = anyhow::anyhow!("Failed to commit orphan-delete tx: {}", e);
                classify_postgres_error_preserving(wrapped, e)
            })?;
            closure_result.map_err(GraphStoreError::Other)?;
            Ok(true)
        })
    }
}

/// FIND-3-RUST-2: classify a `tokio_postgres::Error` as permanent or
/// transient, wrapping the supplied `anyhow::Error` message so the
/// caller's context is preserved. Single source of classification
/// truth — FIND-4-N removed the unused trait-level
/// `classify_postgres_error` helper that walked the `anyhow` source
/// chain; this function takes the raw pg error directly so the SqlState
/// is always reachable.
fn classify_postgres_error_preserving(
    wrapped: anyhow::Error,
    pg_err: tokio_postgres::Error,
) -> GraphStoreError {
    if let Some(code) = pg_err.code() {
        use tokio_postgres::error::SqlState;
        if *code == SqlState::UNDEFINED_TABLE
            || *code == SqlState::UNDEFINED_COLUMN
            || *code == SqlState::INSUFFICIENT_PRIVILEGE
            || *code == SqlState::INVALID_PASSWORD
            || *code == SqlState::INVALID_AUTHORIZATION_SPECIFICATION
            || *code == SqlState::SYNTAX_ERROR
            || *code == SqlState::DATATYPE_MISMATCH
            || *code == SqlState::NOT_NULL_VIOLATION
            || *code == SqlState::CHECK_VIOLATION
            || *code == SqlState::FOREIGN_KEY_VIOLATION
        {
            return GraphStoreError::PermanentFailure(wrapped);
        }
    }
    GraphStoreError::Other(wrapped)
}
