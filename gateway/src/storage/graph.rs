//! Graph store trait and SQLite implementation.
//!
//! The `GraphStore` trait abstracts over the relational store for sessions,
//! turns, and tool calls. `SqliteGraphStore` implements it using an r2d2
//! connection pool over rusqlite.

use anyhow::Result;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use serde::{Deserialize, Serialize};

use crate::db::{self, AttachmentRecord, SessionRecord, ToolCallRecord, TurnRecord};

// ---------------------------------------------------------------------------
// GraphStoreError — typed error enum for graph store operations
// ---------------------------------------------------------------------------

/// Typed error enum for graph store operations.
///
/// Replaces string matching on error messages for duplicate-key detection.
/// Callers can pattern-match on variants instead of inspecting error strings.
///
/// `Clone` and `PartialEq` are intentionally not derived: the `Other` variant
/// wraps `anyhow::Error`, which implements neither trait. Callers should use
/// pattern matching (e.g., `matches!(err, GraphStoreError::DuplicateKey { .. })`)
/// rather than equality checks.
#[derive(Debug)]
#[non_exhaustive]
pub enum GraphStoreError {
    /// PRIMARY KEY collision — the row's id already exists. Callers
    /// (`WritePipeline::write_graph`, recovery replay) treat this as
    /// idempotent retry success: the same row was already persisted on
    /// a previous attempt.
    DuplicateKey { entity: String, id: String },
    /// Batch 11 fix: SECONDARY UNIQUE constraint violation — a DIFFERENT
    /// row collided on a non-PK UNIQUE constraint (e.g.,
    /// `turns(session_id, sequence_num)`). This is NOT idempotent: the
    /// row we tried to insert was NOT persisted, and a different row
    /// occupies the slot. Pipelines MUST propagate, not swallow.
    ///
    /// Production surfaced this on 2026-05-03 when concurrent connection
    /// handlers each computed the same `sequence_num` from a stale
    /// `current_max_seq` read; the loser's insert was misclassified as
    /// `DuplicateKey` and silently dropped.
    UniqueViolation {
        entity: String,
        constraint: String,
        message: String,
    },
    /// Failed to acquire a connection from the pool.
    ConnectionFailed(String),
    /// FIND-3-RUST-2: Permanent / non-retryable failure (schema mismatch,
    /// missing table or column, permission denied, constraint violation
    /// that is not a duplicate key). Callers MUST NOT retry — they
    /// should go straight to the dead-letter queue.
    PermanentFailure(anyhow::Error),
    /// Any other error (wraps the original `anyhow::Error`). Treated as
    /// transient by `is_transient()` — callers retry with exponential
    /// backoff.
    ///
    /// **Security note:** The wrapped error may contain internal details such as
    /// table names, column names, or connection strings from the underlying
    /// database driver. Callers MUST sanitize the error message before exposing
    /// it to API clients or end users. Use `Display` for logs; return a generic
    /// "internal error" message to external consumers.
    Other(anyhow::Error),
}

impl GraphStoreError {
    /// FIND-3-RUST-2: Classify whether this error is transient (retry
    /// worthwhile — connection blip, deadlock, serialization failure, IO
    /// timeout) or permanent (retrying will always fail — schema
    /// mismatch, insufficient privilege, authentication failure).
    ///
    /// Callers (`WritePipeline::write_attachment`, the attachment-count
    /// reconciliation loop) use this to avoid burning three retry
    /// attempts × exponential backoff on an error that cannot succeed.
    ///
    /// - `DuplicateKey` is NOT transient: duplicate inserts settle on
    ///   the first attempt via idempotent `INSERT OR IGNORE` / `ON
    ///   CONFLICT DO NOTHING`; callers treat it as success upstream.
    /// - `ConnectionFailed` is transient: a pool exhaustion or a brief
    ///   network hiccup can recover.
    /// - `PermanentFailure` is not transient by definition.
    /// - `Other` is transient by default (conservative: we don't know).
    pub fn is_transient(&self) -> bool {
        match self {
            GraphStoreError::DuplicateKey { .. } => false,
            GraphStoreError::UniqueViolation { .. } => false,
            GraphStoreError::ConnectionFailed(_) => true,
            GraphStoreError::PermanentFailure(_) => false,
            GraphStoreError::Other(_) => true,
        }
    }
}

impl std::fmt::Display for GraphStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GraphStoreError::DuplicateKey { entity, id } => {
                write!(
                    f,
                    "{} with id {:?} already exists (duplicate key)",
                    entity, id
                )
            }
            GraphStoreError::UniqueViolation {
                entity,
                constraint,
                message,
            } => {
                write!(
                    f,
                    "{} unique constraint {:?} violated by a different row: {}",
                    entity, constraint, message
                )
            }
            GraphStoreError::ConnectionFailed(msg) => {
                write!(f, "connection failed: {}", msg)
            }
            GraphStoreError::PermanentFailure(e) => write!(f, "permanent failure: {}", e),
            GraphStoreError::Other(e) => write!(f, "{}", e),
        }
    }
}

impl std::error::Error for GraphStoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            GraphStoreError::Other(e) => Some(e.as_ref()),
            GraphStoreError::PermanentFailure(e) => Some(e.as_ref()),
            _ => None,
        }
    }
}

impl From<anyhow::Error> for GraphStoreError {
    fn from(e: anyhow::Error) -> Self {
        GraphStoreError::Other(e)
    }
}

/// FIND-3-RUST-2: classify a rusqlite error as permanent vs transient.
/// Permanent: schema / auth / data-shape problems — retrying will always
/// fail. Transient: connection / busy / lock — retrying may succeed.
pub fn classify_sqlite_error(err: &anyhow::Error) -> GraphStoreError {
    if let Some(rusqlite::Error::SqliteFailure(ffi_err, _)) = err.downcast_ref::<rusqlite::Error>()
    {
        {
            use rusqlite::ffi;
            // PERMANENT: schema / data-shape / auth problems.
            //   SQLITE_ERROR     (generic — usually "no such table/column")
            //   SQLITE_AUTH      (authorization failure)
            //   SQLITE_MISMATCH  (data type mismatch)
            //   SQLITE_RANGE     (bind index out of range)
            //   SQLITE_SCHEMA    (schema changed mid-statement)
            //   SQLITE_CONSTRAINT variants other than PRIMARY KEY / UNIQUE
            //                    (already classified as DuplicateKey).
            let code = ffi_err.code as i32;
            let extended = ffi_err.extended_code;
            let permanent_primary = matches!(
                code,
                ffi::SQLITE_ERROR
                    | ffi::SQLITE_AUTH
                    | ffi::SQLITE_MISMATCH
                    | ffi::SQLITE_RANGE
                    | ffi::SQLITE_SCHEMA
                    | ffi::SQLITE_READONLY
                    | ffi::SQLITE_NOTADB
                    | ffi::SQLITE_PERM
            );
            let permanent_constraint = code == ffi::SQLITE_CONSTRAINT
                && extended != ffi::SQLITE_CONSTRAINT_PRIMARYKEY
                && extended != ffi::SQLITE_CONSTRAINT_UNIQUE;
            if permanent_primary || permanent_constraint {
                return GraphStoreError::PermanentFailure(anyhow::anyhow!("{}", err));
            }
        }
    }
    GraphStoreError::Other(anyhow::anyhow!("{}", err))
}

// FIND-4-N: deleted `pub fn classify_postgres_error(err: &anyhow::Error)`.
// It was an unused public helper that walked the `anyhow::Error` source
// chain to find a `tokio_postgres::Error`. The actually-used variant is
// `classify_postgres_error_preserving` in `gateway/src/storage/postgres.rs`,
// which takes the raw pg error directly (no source-chain walk needed).
// The deleted helper had zero callers and was carrying a feature-gate +
// error-walking implementation for nothing.

/// Convenience alias for `Result<T, GraphStoreError>`.
pub type GraphStoreResult<T> = std::result::Result<T, GraphStoreError>;

// ---------------------------------------------------------------------------
// IntegrityResult
// ---------------------------------------------------------------------------

/// Result of an integrity check on a single turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntegrityResult {
    pub turn_id: String,
    pub passed: bool,
    pub expected_hash: String,
    pub details: Option<String>,
}

/// Trait for graph storage (sessions, turns, tool calls).
pub trait GraphStore: Send + Sync {
    fn write_session(&self, session: &SessionRecord) -> GraphStoreResult<()>;
    fn write_turn(&self, turn: &TurnRecord) -> GraphStoreResult<()>;

    /// Atomically allocate the next `sequence_num` for `turn.session_id`
    /// and insert the turn — under a per-session DB-level lock that
    /// serializes concurrent writers across MULTIPLE GATEWAY INSTANCES.
    ///
    /// `turn.sequence_num` from the input is **ignored**; the returned
    /// value is the actually-assigned slot. Callers should update their
    /// in-memory `TurnRecord` to match.
    ///
    /// The lock guarantees that two concurrent gateway processes (e.g.,
    /// behind a load balancer, with the same Anthropic
    /// `metadata.user_id.session_id`) will not collide on the
    /// `(session_id, sequence_num)` UNIQUE constraint. This is the
    /// production-correct fix for the 2026-05-03 race condition where
    /// concurrent connection handlers dropped the loser of the race
    /// after retry-budget exhaustion.
    ///
    /// Implementation contract:
    ///
    /// * **PostgreSQL**: `BEGIN; pg_advisory_xact_lock(hashtext(session_id)::bigint);
    ///   SELECT COALESCE(MAX(sequence_num),0)+1 ...; INSERT ...; COMMIT;`
    ///   The advisory lock is namespaced and held until COMMIT, so any
    ///   concurrent gateway process must wait. Auto-releases on
    ///   transaction end.
    ///
    /// * **SQLite**: `BEGIN IMMEDIATE; SELECT MAX; INSERT; COMMIT;` —
    ///   IMMEDIATE acquires a write lock at the database level (SQLite
    ///   is single-process so cross-instance locking isn't a concern).
    fn write_turn_atomic_seq(&self, turn: &TurnRecord) -> GraphStoreResult<i64>;
    fn write_tool_call(&self, tool_call: &ToolCallRecord) -> GraphStoreResult<()>;
    fn list_sessions(&self, limit: Option<i64>) -> GraphStoreResult<Vec<SessionRecord>>;
    fn get_turns_for_session(&self, session_id: &str) -> GraphStoreResult<Vec<TurnRecord>>;
    fn get_turn(&self, turn_id: &str) -> GraphStoreResult<Option<TurnRecord>>;
    fn get_tool_calls_for_turn(&self, turn_id: &str) -> GraphStoreResult<Vec<ToolCallRecord>>;

    /// FIND-1-1 (round 2): find the first `turns` row whose
    /// `request_hash` equals the given content hash, irrespective of
    /// session. Returns `Ok(None)` if no such row exists.
    ///
    /// # Why this is on the trait
    ///
    /// `recover_orphan_captures` must determine whether an on-disk
    /// capture metadata file already has a corresponding row in the
    /// graph store, so it can skip orphan-replay for non-orphans. The
    /// previous implementation walked `list_sessions(None)` and then
    /// every session's turns; both `list_sessions` (SQLite + PG) cap
    /// at 1000 rows by default, so on a >1000-session production
    /// gateway the dedup probe would silently miss older sessions'
    /// turns and re-insert duplicate audit rows on every restart. A
    /// per-orphan probe via this method bypasses the cap entirely.
    ///
    /// # Index contract
    ///
    /// Implementations MUST scan an index on `turns.request_hash`,
    /// not the table heap, so the operation is `O(log N)` regardless
    /// of total turn count. The SQLite path creates
    /// `idx_turns_request_hash` in `db::initialize` (additive,
    /// IF NOT EXISTS); the PostgreSQL path relies on the index
    /// declared in `api/migrations/012_turns-request-hash-index.sql`.
    /// Run `EXPLAIN` against your DB if you suspect a sequential
    /// scan; the recovery boot path is on the latency-critical
    /// startup hot path and a heap scan would block traffic
    /// admission for the full O(N) sweep.
    ///
    /// # Idempotency note
    ///
    /// Live capture writes use a random Uuid as `turn.id`, so if
    /// recovery is racing live capture for the same `request_hash`
    /// the live row may not yet be visible to recovery's read.
    /// Callers MUST defend against the read-after-commit race with
    /// the lock acquired by `recover_orphan_captures`
    /// (`<data_dir>/.recovery.lock`) AND with the `turn.id =
    /// CaptureRecord.uuid` deterministic-key pattern that converts a
    /// concurrent insert race into a `DuplicateKey` error rather
    /// than a duplicate audit row.
    fn find_turn_by_request_hash(&self, request_hash: &str)
        -> GraphStoreResult<Option<TurnRecord>>;

    /// Get a **length-only synthesized marker** for the cumulative conversation
    /// prefix that precedes the `sequence_num`-th turn.
    ///
    /// # Contract (stable — cross-backend implementations MUST agree)
    ///
    /// The returned `String` — when present — is a JSON-serialized array whose
    /// **only observable property is `.len()`**. The array contents are
    /// synthesized `null` values: callers MUST NOT inspect any element. This
    /// is a behavioural guarantee of the trait, not an implementation detail;
    /// any future consumer that dereferences `previous[i]` is a **breaking
    /// contract change** and must be negotiated via a new method.
    ///
    /// The length equals the wire-format cumulative `messages[]` array length
    /// of the request that *would produce* turn `sequence_num` — i.e. the
    /// correct slice point for
    /// [`crate::providers::anthropic::compute_true_delta`] to yield the true
    /// per-turn delta (new assistant reply + new user message) for turn
    /// `sequence_num`.
    ///
    /// # Semantics
    ///
    /// Concretely: `prev_len = SUM(messages_delta_count) FOR seq <= sequence_num`,
    /// with a **dual-mode** adjustment based on whether turn `sequence_num`
    /// is itself committed:
    ///
    /// - `MAX(seq) < sequence_num` (pipeline path — turn N is being
    ///   processed, not yet written): adjustment = 0. `prev_len` equals the
    ///   wire-format cumulative length of turn (N-1)'s request.
    /// - `MAX(seq) == sequence_num` (external post-write query): adjustment
    ///   = -1, subtracting the one new user message turn N contributed so
    ///   the caller's `compute_true_delta` still yields the pre-turn-N
    ///   state.
    ///
    /// Returns `Ok(None)` when `sequence_num <= 1` or no committed turns
    /// have been written for the session yet (first-turn boundary).
    ///
    /// # Backward-compatibility safety
    ///
    /// Pre-fix data may have stored overshot `messages_delta_count` values
    /// (see `docs/Recondo_Business_Plan_v0.4.md` migration notes). The
    /// synthesized marker length MUST be clamped by implementations so that
    /// downstream `compute_true_delta` callers never receive a `prev_len >
    /// current.len()` — see `compute_true_delta`'s own clamp as a second
    /// line of defence.
    ///
    /// # Cumulative-agreement invariant
    ///
    /// Both SQLite and PostgreSQL backends MUST produce equal `.len()` values
    /// for semantically equivalent session histories. The PG
    /// implementation's `See the SQLite implementation` pointer references
    /// this trait-level documentation as the canonical spec; the trait
    /// defines the contract, backends implement it.
    #[allow(clippy::doc_markdown)]
    fn get_previous_messages_prefix_marker(
        &self,
        session_id: &str,
        sequence_num: i64,
    ) -> GraphStoreResult<Option<String>>;

    /// Legacy name for
    /// [`GraphStore::get_previous_messages_prefix_marker`]. Kept as a
    /// back-compat shim for external callers and existing tests; internal
    /// callers should use the new name directly. The method no longer
    /// returns "the previous turn's messages" — it returns a length-only
    /// synthesized marker. See the new method's docstring for full
    /// semantics.
    #[deprecated(
        note = "renamed to `get_previous_messages_prefix_marker` to reflect the length-only synthesized-marker contract; call that instead"
    )]
    fn get_previous_turn_messages(
        &self,
        session_id: &str,
        sequence_num: i64,
    ) -> GraphStoreResult<Option<String>> {
        self.get_previous_messages_prefix_marker(session_id, sequence_num)
    }
    /// Verify integrity of all turns in a session. When no `ObjectStore` is
    /// provided, performs a shallow check (non-empty hashes). When an
    /// `ObjectStore` is provided, performs deep verification by re-reading,
    /// decompressing, and re-hashing each object via `ObjectStore::verify`.
    fn verify_integrity(
        &self,
        session_id: &str,
        object_store: Option<&dyn super::object::ObjectStore>,
    ) -> GraphStoreResult<Vec<IntegrityResult>>;

    /// List all sessions with the given account_uuid.
    /// Returns sessions ordered by started_at (most recent first).
    fn list_sessions_by_account(&self, account_uuid: &str) -> GraphStoreResult<Vec<SessionRecord>>;

    /// Atomically increment the aggregate totals for an existing session.
    ///
    /// All parameters are *deltas* (amounts to add), not absolute values.
    /// Uses SQL `SET col = col + ?` to avoid TOCTOU races.
    /// Returns an error if the session does not exist.
    fn update_session_totals(
        &self,
        session_id: &str,
        delta_turns: i64,
        delta_captured: i64,
        delta_tokens: i64,
        delta_cost_usd: f64,
    ) -> GraphStoreResult<()>;

    /// W3 fix: Record a GDPR deletion tombstone.
    ///
    /// Creates a record in `gdpr_deletions` to maintain the audit trail after
    /// an object has been purged. The PG implementation must `SET LOCAL
    /// recondo.gdpr_bypass = 'true'` if the gdpr_deletions table is behind a
    /// trigger (it currently is not, but this is future-safe).
    fn record_gdpr_deletion(
        &self,
        object_hash: &str,
        deleted_by: &str,
        gdpr_request_id: &str,
    ) -> GraphStoreResult<()>;

    /// W3 fix: List all GDPR deletion tombstone records.
    fn list_gdpr_deletions(&self) -> GraphStoreResult<Vec<crate::db::GdprDeletionRecord>>;

    /// W3 fix: Nullify parsed fields on a turn for GDPR erasure.
    ///
    /// Sets `response_text`, `thinking_text`, `messages_delta`, `raw_extra`
    /// to NULL, and also clears tool_call PII (`tool_input`, `output`) for
    /// all tool calls belonging to the turn (N2 fix).
    ///
    /// The PG implementation must `SET LOCAL recondo.gdpr_bypass = 'true'`
    /// within a transaction before the UPDATE to bypass immutability triggers.
    fn nullify_turn_parsed_fields(&self, turn_id: &str) -> GraphStoreResult<()>;

    /// B1 fix: Find the most recent turn in the given session that touched any
    /// of the specified artifact paths. Returns the turn_id if found.
    ///
    /// Queries tool_calls with non-empty `artifacts_created` that overlap with
    /// the provided paths, ordered by the turn's sequence_num descending.
    fn find_supersedes_for_session(
        &self,
        session_id: &str,
        artifact_paths: &[String],
    ) -> GraphStoreResult<Option<String>>;

    /// Sprint 7: Get a session by ID.
    fn get_session(&self, session_id: &str) -> GraphStoreResult<Option<SessionRecord>>;

    /// Sprint 7: Insert an anomaly event record (drift detection).
    fn write_anomaly_event(&self, event: &crate::db::AnomalyEventRecord) -> GraphStoreResult<()>;

    /// Sprint 7: Update the system_prompt_hash for a session (drift detection).
    fn update_session_system_prompt_hash(
        &self,
        session_id: &str,
        new_hash: &str,
    ) -> GraphStoreResult<()>;

    /// W2 fix: Atomically insert an anomaly event AND update the session's
    /// system_prompt_hash in a single call. For SQLite, both operations share
    /// the same connection (serialized writes). For PostgreSQL, both statements
    /// execute on a single connection checkout. This prevents inconsistent state
    /// where one write succeeds and the other fails.
    fn record_drift_event(
        &self,
        event: &crate::db::AnomalyEventRecord,
        session_id: &str,
        new_hash: &str,
    ) -> GraphStoreResult<()>;

    /// Update the framework for a session (backfill when first turn lacked a system prompt).
    fn update_session_framework(&self, session_id: &str, framework: &str) -> GraphStoreResult<()>;

    /// Update the model for a session (backfill when first turn lacked a model).
    fn update_session_model(&self, session_id: &str, model: &str) -> GraphStoreResult<()>;

    /// Update the initial intent for a session (backfill when first turn lacked a prompt).
    fn update_session_initial_intent(
        &self,
        session_id: &str,
        initial_intent: &str,
    ) -> GraphStoreResult<()>;

    /// Write a heartbeat record for gateway liveness detection.
    fn write_heartbeat(&self, heartbeat: &crate::db::HeartbeatRecord) -> GraphStoreResult<()>;

    /// Sprint 7 Phase 2: Update the tool_definitions_hash for a session.
    fn update_session_tool_definitions_hash(
        &self,
        session_id: &str,
        new_hash: &str,
    ) -> GraphStoreResult<()>;

    /// Sprint 7 Phase 2: Atomically insert an anomaly event AND update the
    /// session's tool_definitions_hash in a single call.
    fn record_tool_drift_event(
        &self,
        event: &crate::db::AnomalyEventRecord,
        session_id: &str,
        new_tool_hash: &str,
    ) -> GraphStoreResult<()>;

    /// Sprint P1B: Insert an attachment metadata row. Idempotent via
    /// INSERT OR IGNORE semantics so pipeline retries don't duplicate rows.
    /// The raw attachment bytes must already be in the object store at
    /// `attachment.object_ref`.
    fn write_attachment(&self, attachment: &AttachmentRecord) -> GraphStoreResult<()>;

    /// Race-safe variant of `write_attachment`: inserts the row inside
    /// the same advisory-lock domain that `with_sha256_orphan_delete_lock`
    /// uses, and refuses the insert if `blob_exists` returns `Ok(false)`
    /// while the lock is held.
    ///
    /// # Why this exists
    ///
    /// `with_sha256_orphan_delete_lock` deletes the object-store blob
    /// when no `attachments` row references it. Without writer-side
    /// cooperation, this interleaving is possible and creates a
    /// dangling row:
    ///
    /// ```text
    ///   T1: writer puts blob (object store)
    ///   T2: deleter takes lock; count=0 (writer hasn't INSERTed); deletes blob; commits
    ///   T3: writer INSERTs attachment row → row references a blob that no longer exists
    /// ```
    ///
    /// The original FIND-6-F docstring claimed the lock prevented this
    /// ("a concurrent `write_attachment` of the same sha256 from
    /// committing between the count check and the closure") but
    /// `write_attachment` did not actually take the lock, so the
    /// contract was unenforced.
    ///
    /// # Contract
    ///
    /// Implementations that own a serializable orphan-delete lock
    /// (PostgreSQL via `pg_advisory_xact_lock`) MUST:
    ///   1. Begin a transaction
    ///   2. Take the same advisory-lock key the orphan-delete path takes
    ///   3. Invoke `blob_exists()` while the lock is held
    ///   4. If it returns `Ok(false)`, return a non-`DuplicateKey` error
    ///      and roll back — refuse to commit a dangling row
    ///   5. Otherwise INSERT the row and commit (releases lock)
    ///
    /// SQLite's serial-writer model already serializes writes against
    /// the orphan-delete path, so the default impl (which just calls
    /// `write_attachment`) is sufficient there.
    fn write_attachment_with_blob_check(
        &self,
        attachment: &AttachmentRecord,
        blob_exists: &mut dyn FnMut() -> anyhow::Result<bool>,
    ) -> GraphStoreResult<()> {
        let _ = blob_exists; // unused in the default impl
        self.write_attachment(attachment)
    }

    /// FIND-1-K: Reconcile the `turns.attachment_count` column to match
    /// the actual number of attachment rows persisted for that turn.
    ///
    /// Used by the capture pipeline when one or more attachment bundles
    /// were dead-lettered and the speculative count written with the turn
    /// now overcounts. The invariant callers enforce is
    /// `turns.attachment_count == COUNT(attachments WHERE turn_id = turn.id)`
    /// for every committed turn.
    ///
    /// Implementations MUST do a direct `UPDATE turns SET attachment_count
    /// = $count WHERE id = $turn_id`. No-op if the turn does not exist
    /// (returns Ok) — the caller already logged the turn-write failure.
    fn update_turn_attachment_count(&self, turn_id: &str, count: i64) -> GraphStoreResult<()>;

    /// FIND-4-C: Count attachment rows that reference a given content
    /// hash. Used by `WritePipeline::write_attachment`'s orphan-cleanup
    /// path to avoid deleting an object that other (already-committed)
    /// attachment rows still depend on. Content-addressable storage
    /// deduplicates: turns A and B sending the same image share ONE
    /// blob keyed by sha256. If turn A's row-insert + DLQ both fail
    /// after turn B already committed, deleting the blob would break
    /// turn B's reference. The orphan-cleanup branch consults this
    /// method first and only deletes when count == 0.
    ///
    /// Implementations MUST do `SELECT COUNT(*) FROM attachments WHERE
    /// sha256 = $1`. The empty-string sentinel sha256 (URL-only
    /// attachments) is not a valid query target — callers guard before
    /// invoking.
    fn attachment_sha256_reference_count(&self, sha256: &str) -> GraphStoreResult<i64>;

    /// FIND-6-F: Atomically check that no committed `attachments` row
    /// references `sha256`, invoke the caller's `delete_blob` closure
    /// while mutual exclusion is held, and return whether the closure
    /// ran. Resolves the TOCTOU race between
    /// `attachment_sha256_reference_count` and
    /// `ObjectStore::delete`: a concurrent `write_attachment` of the
    /// same sha256 could commit between pipeline A's count query and
    /// pipeline A's delete, destroying B's reference.
    ///
    /// # Atomicity contract
    ///
    /// Implementations MUST establish mutual exclusion that prevents
    /// a concurrent `write_attachment` of the same sha256 from
    /// committing between the count check and the closure.
    ///   - PG: `pg_advisory_xact_lock(hashtext($1))` taken in the
    ///     same transaction as the count query. Holding the lock
    ///     while the closure runs serialises with any other
    ///     orphan-cleanup attempt on the same sha256; concurrent
    ///     `INSERT` rollbacks are detected by re-checking the count
    ///     under the lock.
    ///   - SQLite: `BEGIN IMMEDIATE` + the single-writer WAL invariant
    ///     serialise writes; other pipelines waiting on the write
    ///     lock can't commit mid-check.
    ///
    /// # Return value
    ///
    /// `Ok(true)` — count was 0 under the lock, closure was invoked,
    /// lock released. `Ok(false)` — another committed row referenced
    /// the sha256; closure was NOT invoked. `Err(e)` — lock
    /// acquisition or the count probe itself failed.
    ///
    /// # Closure error policy
    ///
    /// If the closure returns `Err(_)`, the error is propagated but
    /// the atomicity observation (count=0 under lock) has already
    /// happened. The caller can log the delete failure; the DB state
    /// is consistent.
    fn with_sha256_orphan_delete_lock(
        &self,
        sha256: &str,
        delete_blob: &mut dyn FnMut() -> anyhow::Result<()>,
    ) -> GraphStoreResult<bool>;
}

/// SQLite-backed graph store using an r2d2 connection pool.
pub struct SqliteGraphStore {
    pool: Pool<SqliteConnectionManager>,
}

impl SqliteGraphStore {
    /// Create a new `SqliteGraphStore` wrapping an existing r2d2 pool.
    pub fn new(pool: Pool<SqliteConnectionManager>) -> Self {
        Self { pool }
    }

    /// Create an in-memory `SqliteGraphStore` for testing.
    pub fn new_in_memory() -> Result<Self> {
        let manager = SqliteConnectionManager::memory().with_init(|conn| {
            conn.execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = WAL;
                 PRAGMA busy_timeout = 5000;",
            )
        });
        let pool = Pool::builder()
            // Use a single connection for in-memory DBs so all threads share
            // the same database state (each in-memory connection is independent).
            .max_size(1)
            .build(manager)?;

        // Initialize schema using a pooled connection.
        let conn = pool.get()?;
        db::initialize(&conn)?;

        Ok(Self { pool })
    }
}

/// Batch 11 fix: classify a SQLite UNIQUE/PK constraint violation as
/// either a `DuplicateKey` (the PK collided — row was already persisted,
/// idempotent retry success) or a `UniqueViolation` (a different row
/// collided on a SECONDARY UNIQUE — must propagate, NOT idempotent).
///
/// SQLite's `SQLITE_CONSTRAINT_PRIMARYKEY` is fired only for INTEGER PK
/// (rowid) collisions. PK on TEXT columns (Recondo's pattern) fires
/// `SQLITE_CONSTRAINT_UNIQUE` — same code as secondary UNIQUE
/// violations. The error MESSAGE distinguishes them: it lists the
/// columns, formatted as `"<table>.<col>"` joined by `", "`. We treat
/// the violation as a PK collision iff the column list is exactly
/// `<table>.<pk_column>`. Anything else is a `UniqueViolation`.
fn classify_sqlite_unique_violation(
    err: anyhow::Error,
    entity: &str,
    id: &str,
    table: &str,
    pk_column: &str,
) -> GraphStoreError {
    let (extended_code, msg_text) = if let Some(rusqlite::Error::SqliteFailure(ffi_err, msg)) =
        err.downcast_ref::<rusqlite::Error>()
    {
        (ffi_err.extended_code, msg.clone().unwrap_or_default())
    } else {
        return GraphStoreError::Other(err);
    };

    let is_unique = extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_PRIMARYKEY
        || extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE;
    if !is_unique {
        return GraphStoreError::Other(err);
    }

    // SQLite formats the message as "UNIQUE constraint failed: <cols>"
    // where <cols> is one or more "<table>.<col>" entries joined by ", ".
    let cols_part = msg_text
        .strip_prefix("UNIQUE constraint failed: ")
        .unwrap_or(&msg_text)
        .trim();
    let pk_marker = format!("{}.{}", table, pk_column);
    if cols_part == pk_marker {
        GraphStoreError::DuplicateKey {
            entity: entity.into(),
            id: id.into(),
        }
    } else {
        GraphStoreError::UniqueViolation {
            entity: entity.into(),
            constraint: cols_part.to_string(),
            message: msg_text,
        }
    }
}

impl GraphStore for SqliteGraphStore {
    fn write_session(&self, session: &SessionRecord) -> GraphStoreResult<()> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        db::insert_session(&conn, session).map_err(|e| {
            classify_sqlite_unique_violation(e, "session", &session.id, "sessions", "id")
        })
    }

    fn write_turn(&self, turn: &TurnRecord) -> GraphStoreResult<()> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        // Rely on the PRIMARY KEY constraint for immutability instead of a
        // SELECT-then-INSERT pattern (which has a TOCTOU race under concurrency).
        db::insert_turn(&conn, turn)
            .map_err(|e| classify_sqlite_unique_violation(e, "turn", &turn.id, "turns", "id"))
    }

    /// SQLite atomic seq+insert. `BEGIN IMMEDIATE` acquires a database-
    /// level write lock at the start of the transaction, serializing all
    /// concurrent writers across the (single) SQLite process. The
    /// `SELECT MAX` and `INSERT` thus run atomically — no two writers
    /// can observe the same `MAX(sequence_num)` and insert at the same
    /// slot.
    fn write_turn_atomic_seq(&self, turn: &TurnRecord) -> GraphStoreResult<i64> {
        let mut conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| {
                GraphStoreError::Other(anyhow::anyhow!("BEGIN IMMEDIATE failed: {}", e))
            })?;

        let next_seq: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(sequence_num), 0) + 1 FROM turns WHERE session_id = ?1",
                rusqlite::params![turn.session_id],
                |row| row.get(0),
            )
            .map_err(|e| {
                GraphStoreError::Other(anyhow::anyhow!(
                    "SELECT MAX(sequence_num) inside atomic-seq txn failed: {}",
                    e
                ))
            })?;

        // Insert the turn with the freshly-allocated seq, ignoring the
        // input record's sequence_num. We clone + override to avoid
        // mutating the caller's TurnRecord (the trait takes &TurnRecord).
        let mut turn_with_seq = turn.clone();
        turn_with_seq.sequence_num = next_seq;
        // rusqlite::Transaction derefs to Connection, so deref-coercion
        // gives us `&Connection` from `&tx` for free.
        db::insert_turn(&tx, &turn_with_seq)
            .map_err(|e| classify_sqlite_unique_violation(e, "turn", &turn.id, "turns", "id"))?;

        tx.commit()
            .map_err(|e| GraphStoreError::Other(anyhow::anyhow!("COMMIT failed: {}", e)))?;
        Ok(next_seq)
    }

    fn write_tool_call(&self, tool_call: &ToolCallRecord) -> GraphStoreResult<()> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        db::insert_tool_call(&conn, tool_call).map_err(|e| {
            classify_sqlite_unique_violation(e, "tool_call", &tool_call.id, "tool_calls", "id")
        })
    }

    fn list_sessions(&self, limit: Option<i64>) -> GraphStoreResult<Vec<SessionRecord>> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        db::list_sessions(&conn, limit).map_err(GraphStoreError::Other)
    }

    fn get_turns_for_session(&self, session_id: &str) -> GraphStoreResult<Vec<TurnRecord>> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        db::get_turns_for_session(&conn, session_id).map_err(GraphStoreError::Other)
    }

    fn get_turn(&self, turn_id: &str) -> GraphStoreResult<Option<TurnRecord>> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        db::get_turn(&conn, turn_id).map_err(GraphStoreError::Other)
    }

    fn find_turn_by_request_hash(
        &self,
        request_hash: &str,
    ) -> GraphStoreResult<Option<TurnRecord>> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        db::find_turn_by_request_hash(&conn, request_hash).map_err(GraphStoreError::Other)
    }

    fn get_tool_calls_for_turn(&self, turn_id: &str) -> GraphStoreResult<Vec<ToolCallRecord>> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        db::get_tool_calls_for_turn(&conn, turn_id).map_err(GraphStoreError::Other)
    }

    fn get_previous_messages_prefix_marker(
        &self,
        session_id: &str,
        sequence_num: i64,
    ) -> GraphStoreResult<Option<String>> {
        // Bug #1 fix — see the trait-level docstring on
        // `GraphStore::get_previous_messages_prefix_marker` for the full
        // contract. The return value is a JSON array of synthesized nulls
        // whose only observable property is `.len()`; callers must not
        // inspect elements.
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        if sequence_num <= 1 {
            return Ok(None);
        }
        let mut stmt = conn
            .prepare(
                "SELECT COALESCE(SUM(messages_delta_count), 0), COALESCE(MAX(sequence_num), 0) \
                 FROM turns WHERE session_id = ?1 AND sequence_num <= ?2",
            )
            .map_err(|e| GraphStoreError::Other(e.into()))?;
        let (total, max_seq): (i64, i64) = stmt
            .query_row(rusqlite::params![session_id, sequence_num], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|e| GraphStoreError::Other(e.into()))?;
        if max_seq == 0 {
            return Ok(None);
        }
        let prev_len = if max_seq == sequence_num {
            // Turn N is already committed: subtract the new user message turn N
            // contributed so the caller's compute_true_delta yields the
            // pre-turn-N conversation state.
            (total - 1).max(0)
        } else {
            total.max(0)
        };
        let synth = vec![serde_json::Value::Null; prev_len as usize];
        let s = serde_json::to_string(&synth)
            .map_err(|e| GraphStoreError::Other(anyhow::Error::from(e)))?;
        Ok(Some(s))
    }

    fn verify_integrity(
        &self,
        session_id: &str,
        object_store: Option<&dyn super::object::ObjectStore>,
    ) -> GraphStoreResult<Vec<IntegrityResult>> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        let turns = db::get_turns_for_session(&conn, session_id).map_err(GraphStoreError::Other)?;
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

            // When an ObjectStore is provided, perform deep verification by
            // re-reading, decompressing, and re-hashing each stored object.
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

    fn list_sessions_by_account(&self, account_uuid: &str) -> GraphStoreResult<Vec<SessionRecord>> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        db::list_sessions_by_account(&conn, account_uuid).map_err(GraphStoreError::Other)
    }

    fn update_session_totals(
        &self,
        session_id: &str,
        delta_turns: i64,
        delta_captured: i64,
        delta_tokens: i64,
        delta_cost_usd: f64,
    ) -> GraphStoreResult<()> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        db::update_session_totals(
            &conn,
            session_id,
            delta_turns,
            delta_captured,
            delta_tokens,
            delta_cost_usd,
        )
        .map_err(GraphStoreError::Other)
    }

    fn record_gdpr_deletion(
        &self,
        object_hash: &str,
        deleted_by: &str,
        gdpr_request_id: &str,
    ) -> GraphStoreResult<()> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        db::record_gdpr_deletion(&conn, object_hash, deleted_by, gdpr_request_id)
            .map_err(GraphStoreError::Other)
    }

    fn list_gdpr_deletions(&self) -> GraphStoreResult<Vec<db::GdprDeletionRecord>> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        db::list_gdpr_deletions(&conn).map_err(GraphStoreError::Other)
    }

    fn nullify_turn_parsed_fields(&self, turn_id: &str) -> GraphStoreResult<()> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        // N2 fix: Also clear tool_call PII (tool_input, output) for the turn.
        db::nullify_turn_parsed_fields(&conn, turn_id).map_err(GraphStoreError::Other)?;
        conn.execute(
            "UPDATE tool_calls SET tool_input = NULL, output = NULL WHERE turn_id = ?1",
            rusqlite::params![turn_id],
        )
        .map_err(|e| GraphStoreError::Other(e.into()))?;
        Ok(())
    }

    fn find_supersedes_for_session(
        &self,
        session_id: &str,
        artifact_paths: &[String],
    ) -> GraphStoreResult<Option<String>> {
        if artifact_paths.is_empty() {
            return Ok(None);
        }
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        let resolver = crate::artifacts::SupersedesResolver::new(&conn);
        let path_refs: Vec<&str> = artifact_paths.iter().map(|s| s.as_str()).collect();
        resolver
            .find_supersedes_for_session(session_id, &path_refs)
            .map_err(GraphStoreError::Other)
    }

    fn get_session(&self, session_id: &str) -> GraphStoreResult<Option<SessionRecord>> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        db::get_session(&conn, session_id).map_err(GraphStoreError::Other)
    }

    fn write_anomaly_event(&self, event: &crate::db::AnomalyEventRecord) -> GraphStoreResult<()> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        db::insert_anomaly_event(&conn, event).map_err(GraphStoreError::Other)
    }

    fn update_session_system_prompt_hash(
        &self,
        session_id: &str,
        new_hash: &str,
    ) -> GraphStoreResult<()> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        db::update_session_system_prompt_hash(&conn, session_id, new_hash)
            .map_err(GraphStoreError::Other)
    }

    fn record_drift_event(
        &self,
        event: &crate::db::AnomalyEventRecord,
        session_id: &str,
        new_hash: &str,
    ) -> GraphStoreResult<()> {
        // W2 fix: Use a single connection for both operations. SQLite serializes
        // writes, so both statements execute atomically on this connection.
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        db::insert_anomaly_event(&conn, event).map_err(GraphStoreError::Other)?;
        db::update_session_system_prompt_hash(&conn, session_id, new_hash)
            .map_err(GraphStoreError::Other)?;
        Ok(())
    }

    fn update_session_framework(&self, session_id: &str, framework: &str) -> GraphStoreResult<()> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        conn.execute(
            "UPDATE sessions SET framework = ?1 WHERE id = ?2 AND (framework IS NULL OR framework = '')",
            rusqlite::params![framework, session_id],
        )
        .map_err(|e| GraphStoreError::Other(anyhow::anyhow!("{}", e)))?;
        Ok(())
    }

    fn update_session_model(&self, session_id: &str, model: &str) -> GraphStoreResult<()> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        conn.execute(
            "UPDATE sessions SET model = ?1 WHERE id = ?2 AND (model IS NULL OR model = '')",
            rusqlite::params![model, session_id],
        )
        .map_err(|e| GraphStoreError::Other(anyhow::anyhow!("{}", e)))?;
        Ok(())
    }

    fn update_session_initial_intent(
        &self,
        session_id: &str,
        initial_intent: &str,
    ) -> GraphStoreResult<()> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        conn.execute(
            "UPDATE sessions SET initial_intent = ?1 WHERE id = ?2 AND (initial_intent IS NULL OR initial_intent = '')",
            rusqlite::params![initial_intent, session_id],
        )
        .map_err(|e| GraphStoreError::Other(anyhow::anyhow!("{}", e)))?;
        Ok(())
    }

    fn write_heartbeat(&self, hb: &crate::db::HeartbeatRecord) -> GraphStoreResult<()> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        conn.execute(
            "INSERT INTO heartbeats (id, gateway_id, status) VALUES (?1, ?2, ?3)",
            rusqlite::params![hb.id, hb.gateway_id, hb.status],
        )
        .map_err(|e| GraphStoreError::Other(anyhow::anyhow!("{}", e)))?;
        Ok(())
    }

    fn update_session_tool_definitions_hash(
        &self,
        session_id: &str,
        new_hash: &str,
    ) -> GraphStoreResult<()> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        db::update_session_tool_definitions_hash(&conn, session_id, new_hash)
            .map_err(GraphStoreError::Other)
    }

    fn record_tool_drift_event(
        &self,
        event: &crate::db::AnomalyEventRecord,
        session_id: &str,
        new_tool_hash: &str,
    ) -> GraphStoreResult<()> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        db::insert_anomaly_event(&conn, event).map_err(GraphStoreError::Other)?;
        db::update_session_tool_definitions_hash(&conn, session_id, new_tool_hash)
            .map_err(GraphStoreError::Other)?;
        Ok(())
    }

    fn write_attachment(&self, attachment: &AttachmentRecord) -> GraphStoreResult<()> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        // FIND-3-RUST-2: classify errors as transient vs permanent so
        // WritePipeline retry logic skips the backoff loop on permanent
        // failures (missing tables, schema mismatch, etc.).
        db::insert_attachment(&conn, attachment).map_err(|e| {
            // attachments has only PK on id; no secondary UNIQUE
            // constraints today. Defense-in-depth: route through the
            // classifier so any future secondary UNIQUE addition gets
            // surfaced rather than swallowed as DuplicateKey.
            let classified = classify_sqlite_unique_violation(
                anyhow::anyhow!("{}", e),
                "attachment",
                &attachment.id,
                "attachments",
                "id",
            );
            match classified {
                // Not a UNIQUE/PK violation — fall back to the original
                // transient/permanent classification (FIND-3-RUST-2).
                GraphStoreError::Other(_) => classify_sqlite_error(&e),
                other => other,
            }
        })
    }

    fn update_turn_attachment_count(&self, turn_id: &str, count: i64) -> GraphStoreResult<()> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        conn.execute(
            "UPDATE turns SET attachment_count = ?1 WHERE id = ?2",
            rusqlite::params![count, turn_id],
        )
        .map_err(|e| classify_sqlite_error(&anyhow::anyhow!("{}", e)))?;
        Ok(())
    }

    fn attachment_sha256_reference_count(&self, sha256: &str) -> GraphStoreResult<i64> {
        let conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM attachments WHERE sha256 = ?1",
                rusqlite::params![sha256],
                |row| row.get(0),
            )
            .map_err(|e| classify_sqlite_error(&anyhow::anyhow!("{}", e)))?;
        Ok(count)
    }

    fn with_sha256_orphan_delete_lock(
        &self,
        sha256: &str,
        delete_blob: &mut dyn FnMut() -> anyhow::Result<()>,
    ) -> GraphStoreResult<bool> {
        // SQLite: BEGIN IMMEDIATE acquires the write lock up-front.
        // While we hold it, no other connection can commit a new
        // attachments row (INSERT requires the write lock too). We
        // re-run the count UNDER the lock and only invoke the
        // closure when it reports 0. The closure runs while the
        // transaction is open so any concurrent writer waiting on
        // our write lock blocks until we COMMIT — at which point
        // our deletion observation is already complete.
        let mut conn = self
            .pool
            .get()
            .map_err(|e| GraphStoreError::ConnectionFailed(format!("{}", e)))?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| classify_sqlite_error(&anyhow::anyhow!("{}", e)))?;
        let count: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM attachments WHERE sha256 = ?1",
                rusqlite::params![sha256],
                |row| row.get(0),
            )
            .map_err(|e| classify_sqlite_error(&anyhow::anyhow!("{}", e)))?;
        if count > 0 {
            // Dedup-share detected — do NOT delete. Release lock.
            tx.commit()
                .map_err(|e| classify_sqlite_error(&anyhow::anyhow!("{}", e)))?;
            return Ok(false);
        }
        // count == 0 under the lock; the closure is safe to run.
        let closure_result = delete_blob();
        // Always commit so the lock is released, regardless of
        // closure success. Log + propagate closure error separately
        // — the atomicity observation is correct even if the
        // best-effort delete failed.
        tx.commit()
            .map_err(|e| classify_sqlite_error(&anyhow::anyhow!("{}", e)))?;
        closure_result.map_err(GraphStoreError::Other)?;
        Ok(true)
    }
}
