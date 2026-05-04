//! Write pipeline: stores objects first, then writes graph records.
//! On graph failure after retries, captures go to a dead-letter queue.

use std::fs;
use std::path::PathBuf;

use anyhow::Result;

use crate::db::{AttachmentRecord, SessionRecord, ToolCallRecord, TurnRecord};
use crate::hash;
use crate::storage::graph::{GraphStore, GraphStoreError};
use crate::storage::object::ObjectStore;

/// FIND-3-RUST-2 + FIND-4-G: Sleep helper safe to call from sync, async
/// multi_thread, and async current_thread contexts.
///
/// `tokio::task::block_in_place` PANICS on a current_thread runtime —
/// `Handle::try_current().is_ok()` does NOT distinguish flavour, so a
/// naive flag check would crash any `#[tokio::test]` (which defaults
/// to current_thread) that drives the retry+sleep path. The dispatch
/// must inspect `runtime_flavor()`:
///
/// - Inside a multi_thread runtime: `block_in_place` hands the worker
///   off to a blocking thread; `std::thread::sleep` then blocks that
///   blocking thread (safe).
/// - Inside a current_thread runtime: `block_in_place` would panic; we
///   fall back to a plain `std::thread::sleep` that blocks the
///   single-threaded reactor for `duration`. This is correct for
///   tests and for any application code that opts into a
///   current_thread runtime (the trade-off is documented).
/// - Outside any runtime (sync unit tests, CLI tools): plain
///   `std::thread::sleep`.
///
/// The retry delay is bounded (10ms / 100ms / 1000ms total < 1.2s) so
/// blocking a current_thread reactor for that duration is acceptable
/// for the controlled failure paths this helper serves.
fn block_on_sleep(duration: std::time::Duration) {
    use tokio::runtime::{Handle, RuntimeFlavor};
    match Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(|| std::thread::sleep(duration));
        }
        // current_thread runtime OR no runtime: plain blocking sleep.
        // current_thread cannot use block_in_place; outside a runtime
        // there is no worker to hand off.
        _ => std::thread::sleep(duration),
    }
}

/// Maximum number of retries for graph writes before dead-lettering.
const DEFAULT_MAX_RETRIES: usize = 3;

/// A write pipeline that stores objects first, then writes graph records.
/// Failed graph writes go to a dead-letter queue after retries are exhausted.
pub struct WritePipeline {
    graph: Box<dyn GraphStore>,
    objects: Box<dyn ObjectStore>,
    dead_letter_dir: PathBuf,
    max_retries: usize,
}

impl WritePipeline {
    /// Create a new write pipeline.
    pub fn new(
        graph: Box<dyn GraphStore>,
        objects: Box<dyn ObjectStore>,
        dead_letter_dir: PathBuf,
    ) -> Self {
        Self {
            graph,
            objects,
            dead_letter_dir,
            max_retries: DEFAULT_MAX_RETRIES,
        }
    }

    /// Access the underlying graph store (for reads, e.g., previous turn messages).
    pub fn graph(&self) -> &dyn GraphStore {
        self.graph.as_ref()
    }

    /// Access the underlying object store (for reads, e.g., integrity verification).
    pub fn objects(&self) -> &dyn ObjectStore {
        self.objects.as_ref()
    }

    /// Write a complete capture: objects first, then graph records.
    ///
    /// If the object store fails, the error propagates immediately (objects are
    /// the source of truth). If the graph store fails after retries, the capture
    /// is written to the dead-letter queue and an error is returned.
    pub fn write_capture(
        &self,
        session: &SessionRecord,
        turn: &TurnRecord,
        tool_calls: &[ToolCallRecord],
        req_bytes: &[u8],
        resp_bytes: &[u8],
    ) -> Result<()> {
        // Step 1: Store objects first (these are the immutable source of truth).
        // Compute hashes from raw bytes and overwrite turn.request_hash and
        // turn.response_hash before writing to the graph. This ensures the
        // graph references match the actual object store keys.
        let req_hash = hash::sha256_hex(req_bytes);
        let resp_hash = hash::sha256_hex(resp_bytes);

        if let Err(e) = self.objects.put("req", &req_hash, req_bytes) {
            let original_msg = format!("Object store req put failed: {}", e);
            if let Err(dlq_err) = self.dead_letter(session, turn, tool_calls, &original_msg) {
                tracing::error!(
                    error = %dlq_err,
                    original_error = %original_msg,
                    "Dead-letter queue write failed; propagating original object store error"
                );
            }
            anyhow::bail!("{}", original_msg);
        }

        if let Err(e) = self.objects.put("resp", &resp_hash, resp_bytes) {
            let original_msg = format!("Object store resp put failed: {}", e);
            if let Err(dlq_err) = self.dead_letter(session, turn, tool_calls, &original_msg) {
                tracing::error!(
                    error = %dlq_err,
                    original_error = %original_msg,
                    "Dead-letter queue write failed; propagating original object store error"
                );
            }
            anyhow::bail!("{}", original_msg);
        }

        // Step 1b: Overwrite the turn's hashes with the computed values so the
        // graph references match the actual object store keys.
        let mut turn_with_hashes = turn.clone();
        turn_with_hashes.request_hash = req_hash;
        turn_with_hashes.response_hash = resp_hash;

        // Step 2: Write graph records with retry.
        //
        // Bug-2 fix (2026-05-03, multi-instance-correct): the turn
        // insert now uses `write_turn_atomic_seq`, which allocates the
        // next `sequence_num` UNDER A PER-SESSION DB-LEVEL LOCK
        // (PG: `pg_advisory_xact_lock`; SQLite: `BEGIN IMMEDIATE`).
        // Concurrent gateway processes / threads writing into the same
        // session serialize at the lock, so `(session_id, sequence_num)`
        // UNIQUE collisions are STRUCTURALLY IMPOSSIBLE. The pipeline
        // retry loop is therefore back to its pre-Bug-2 simplicity:
        // exponential backoff on transient errors only, no collision
        // bumping needed. The assigned seq is propagated back into
        // `turn_with_hashes.sequence_num` so downstream attachment
        // writes link to the right turn.
        let mut last_error: Option<anyhow::Error> = None;
        for attempt in 0..self.max_retries {
            match self.write_graph(session, &turn_with_hashes, tool_calls) {
                Ok(assigned_seq) => {
                    turn_with_hashes.sequence_num = assigned_seq;
                    return Ok(());
                }
                Err(e) => {
                    last_error = Some(e);
                    if attempt + 1 < self.max_retries {
                        // Exponential backoff: 10ms, 100ms, 1000ms.
                        let delay_ms = 10u64 * 10u64.pow(attempt as u32);
                        block_on_sleep(std::time::Duration::from_millis(delay_ms));
                    }
                }
            }
        }

        // All retries exhausted: dead-letter the capture.
        let error_msg = last_error
            .as_ref()
            .map(|e| format!("{}", e))
            .unwrap_or_else(|| "unknown error".to_string());

        // Log but do not propagate DLQ failures — the original graph write
        // error is more important for the caller to diagnose.
        if let Err(dlq_err) = self.dead_letter(session, turn, tool_calls, &error_msg) {
            tracing::error!(
                error = %dlq_err,
                original_error = %error_msg,
                "Dead-letter queue write failed; propagating original graph error"
            );
        }
        anyhow::bail!(
            "Graph write failed after {} retries: {}",
            self.max_retries,
            error_msg
        )
    }

    /// FIND-1-L: Write a single attachment bundle (object bytes + DB row)
    /// through the same retry + dead-letter-queue semantics used for
    /// request/response bytes in `write_capture`.
    ///
    /// # Flow
    ///
    /// 1. Upload `bytes` to the object store under kind="attachments",
    ///    keyed by the record's `sha256`. If the sha256/bytes are empty
    ///    (URL-only attachment record), the upload step is skipped.
    /// 2. Insert the `AttachmentRecord` row via the graph store. Retries
    ///    with exponential backoff (10ms, 100ms, 1000ms) only on
    ///    **transient** errors (FIND-3-RUST-2). Permanent errors
    ///    (`UNDEFINED_TABLE`, `INSUFFICIENT_PRIVILEGE`, schema mismatch,
    ///    etc.) skip straight to the DLQ — three retries of a schema
    ///    mismatch waste 1.1s × N_attachments pinning a Tokio worker.
    /// 3. If all retries are exhausted OR a permanent error is seen,
    ///    write the bundle to the dead-letter queue as
    ///    `<ts>_attachment_<id>.json` with `dead_letter_reason` and
    ///    `retry_count` fields so the operator can reconcile manually.
    ///
    /// # Worker-thread safety (FIND-3-RUST-2 sub-issue)
    ///
    /// Retry backoffs use `block_on_sleep()` which delegates to
    /// `tokio::task::block_in_place` when invoked inside a Tokio
    /// runtime (the normal capture path). `block_in_place` hands the
    /// current worker off to a blocking thread before sleeping, so
    /// `std::thread::sleep` never pins a regular worker. When invoked
    /// outside any runtime (sync tests), we fall back to a bare
    /// `std::thread::sleep`.
    ///
    /// # Return value
    ///
    /// `Ok(true)` when the row was persisted successfully (counts toward
    /// `turn.attachment_count`). `Ok(false)` when retries were exhausted
    /// (or a permanent error fired) and the bundle was dead-lettered
    /// (still a "successful" call in that no error propagates to the
    /// capture path, but the row is NOT counted in
    /// `turn.attachment_count`). `Err(e)` when both the graph-store
    /// insert AND the DLQ write failed — that's a true operational
    /// failure the caller must surface.
    ///
    /// # Duplicate-key handling
    ///
    /// `DuplicateKey` errors are treated as success (the row was already
    /// persisted on a previous attempt). Idempotent by design so the
    /// extractor can be re-run without duplicating rows.
    pub fn write_attachment(&self, attachment: &AttachmentRecord, bytes: &[u8]) -> Result<bool> {
        // Step 1: Upload object bytes (unless this is a URL-only record).
        // FIND-1-L: retry object-store puts the same way `write_capture`
        // retries req/resp uploads. Object-store failures DLQ the bundle
        // just like graph-store failures below.
        //
        // FIND-3-RUST-3: Track whether an object put has succeeded so a
        // later DLQ-write-failure can best-effort delete the orphaned
        // object and avoid a GDPR-eligible dangling blob.
        let mut object_put_succeeded = false;
        if !bytes.is_empty() && !attachment.sha256.is_empty() {
            let mut object_err: Option<anyhow::Error> = None;
            for attempt in 0..self.max_retries {
                match self.objects.put("attachments", &attachment.sha256, bytes) {
                    Ok(_) => {
                        object_err = None;
                        object_put_succeeded = true;
                        break;
                    }
                    Err(e) => {
                        object_err = Some(anyhow::anyhow!("{}", e));
                        if attempt + 1 < self.max_retries {
                            let delay_ms = 10u64 * 10u64.pow(attempt as u32);
                            block_on_sleep(std::time::Duration::from_millis(delay_ms));
                        }
                    }
                }
            }
            if let Some(e) = object_err {
                let error_msg = format!("Attachment object-store put failed after retries: {}", e);
                if let Err(dlq_err) =
                    self.dead_letter_attachment(attachment, bytes, &error_msg, self.max_retries)
                {
                    tracing::error!(
                        error = %dlq_err,
                        original_error = %error_msg,
                        attachment_id = %attachment.id,
                        "Attachment DLQ write failed; attachment bytes and row will not be captured"
                    );
                    // When DLQ itself fails, propagate the original error
                    // so the capture path knows this bundle is lost.
                    anyhow::bail!("{}", error_msg);
                }
                // Object DLQ'd — row is NOT inserted, do not count.
                return Ok(false);
            }
        }

        // Step 2: Insert the row with retry. FIND-3-RUST-2: only retry
        // transient errors. Permanent errors (schema / auth / data
        // shape) go straight to the DLQ — three retries × exp-backoff
        // of a permanent error burns ~1.1s per attachment for no gain.
        //
        // Race-safety: route through `write_attachment_with_blob_check`
        // so the INSERT runs under the same advisory lock as
        // `with_sha256_orphan_delete_lock`. The closure verifies the
        // blob (which we just put above) is still present; if a
        // concurrent orphan-delete deleted it between Step 1 and
        // Step 2, the writer refuses the insert rather than create a
        // dangling row.
        let objects_ref: &dyn ObjectStore = &*self.objects;
        let sha_ref: &str = &attachment.sha256;
        let mut last_error: Option<GraphStoreError> = None;
        let mut permanent = false;
        for attempt in 0..self.max_retries {
            let mut blob_exists = || {
                objects_ref
                    .exists("attachments", sha_ref)
                    .map_err(|e| anyhow::anyhow!("{}", e))
            };
            match self
                .graph
                .write_attachment_with_blob_check(attachment, &mut blob_exists)
            {
                Ok(()) => return Ok(true),
                Err(GraphStoreError::DuplicateKey { .. }) => {
                    // Row already persisted — idempotent success.
                    return Ok(true);
                }
                Err(e) => {
                    let is_transient = e.is_transient();
                    last_error = Some(e);
                    if !is_transient {
                        // Permanent — no backoff, fall through to DLQ.
                        permanent = true;
                        break;
                    }
                    if attempt + 1 < self.max_retries {
                        let delay_ms = 10u64 * 10u64.pow(attempt as u32);
                        block_on_sleep(std::time::Duration::from_millis(delay_ms));
                    }
                }
            }
        }

        // Step 3: All retries exhausted (or permanent error) — DLQ the bundle.
        let error_msg = last_error
            .as_ref()
            .map(|e| {
                if permanent {
                    format!("[permanent, no retry] {}", e)
                } else {
                    format!("{}", e)
                }
            })
            .unwrap_or_else(|| "unknown error".to_string());

        let retry_count = if permanent { 0 } else { self.max_retries };
        if let Err(dlq_err) =
            self.dead_letter_attachment(attachment, bytes, &error_msg, retry_count)
        {
            tracing::error!(
                error = %dlq_err,
                original_error = %error_msg,
                attachment_id = %attachment.id,
                "Attachment DLQ write failed; row will not be captured"
            );
            // FIND-3-RUST-3 + FIND-4-C: Best-effort orphan cleanup. If
            // we uploaded the object bytes above but can neither write
            // the row nor write a DLQ record, the object is stranded
            // with no reference for THIS turn. But content-addressable
            // storage deduplicates: another turn may already have a
            // committed `attachments` row pointing at the same sha256.
            // Deleting the blob would break that other turn's data.
            //
            // FIND-4-C fix: query
            // `attachment_sha256_reference_count(sha256)` first; only
            // delete when the count is zero (no other turn references
            // this blob). When the count is > 0, log a structured
            // `attachment_orphan_skipped_due_to_dedup` warn and proceed
            // without deleting — the orphan is not actually orphaned,
            // it's a shared blob.
            //
            // FIND-6-F (supersedes FIND-4-C non-atomic version):
            // orphan cleanup now uses `with_sha256_orphan_delete_lock`
            // so the ref-count check and the object-store delete run
            // under DB mutual exclusion. A concurrent `write_attachment`
            // for the same sha256 can't commit between our observation
            // of "no references" and our delete.
            if object_put_succeeded && !attachment.sha256.is_empty() {
                let sha = attachment.sha256.clone();
                let objects = self.objects.as_ref();
                let attachment_id = attachment.id.clone();
                let mut delete_result: Option<anyhow::Result<()>> = None;
                let lock_result = self.graph.with_sha256_orphan_delete_lock(&sha, &mut || {
                    let r = objects.delete("attachments", &sha);
                    let captured = r.as_ref().map(|_| ()).map_err(|e| anyhow::anyhow!("{}", e));
                    delete_result = Some(captured);
                    r.map(|_| ())
                });
                match lock_result {
                    Ok(true) => {
                        // Closure ran (count was 0 under the lock).
                        if let Some(Ok(())) = delete_result {
                            tracing::warn!(
                                sha256 = %attachment.sha256,
                                attachment_id = %attachment_id,
                                "Attachment object orphaned after row+DLQ failure; atomic orphan-delete succeeded under DB lock"
                            );
                        } else if let Some(Err(del_err)) = delete_result {
                            tracing::error!(
                                kind = "object_orphan_after_dlq_failure",
                                sha256 = %attachment.sha256,
                                attachment_id = %attachment_id,
                                object_bucket = "attachments",
                                error = %del_err,
                                "Attachment object orphan — best-effort delete under lock failed; operator reconciliation required"
                            );
                        }
                    }
                    Ok(false) => {
                        // Atomic ref-count said >0 under the lock —
                        // dedup-shared with a committed row. Do NOT
                        // delete. This is the FIND-4-C scenario,
                        // now race-free.
                        tracing::warn!(
                            kind = "attachment_orphan_skipped_due_to_dedup",
                            sha256 = %attachment.sha256,
                            attachment_id = %attachment_id,
                            "Attachment object orphan-cleanup skipped atomically: blob is shared with committed attachment row(s)"
                        );
                    }
                    Err(e) => {
                        // Lock or count probe itself failed — fall
                        // back to NOT deleting, preserving the dedup
                        // invariant. Operator must reconcile.
                        tracing::error!(
                            kind = "attachment_orphan_refcount_failed",
                            sha256 = %attachment.sha256,
                            attachment_id = %attachment_id,
                            error = %e,
                            "Attachment orphan-cleanup lock/refcount failed; defaulting to NO delete to preserve dedup invariant; operator must reconcile"
                        );
                    }
                }
            }
            anyhow::bail!(
                "Attachment row write failed after {} retries and DLQ write \
                 also failed: {}",
                self.max_retries,
                error_msg
            );
        }
        // DLQ'd — not counted toward turn.attachment_count. The caller
        // gets Ok(false) so it does not increment the count, preserving
        // the `turns.attachment_count == COUNT(attachments)` invariant.
        Ok(false)
    }

    /// FIND-1-K sub-fix: Attempt to UPDATE `turns.attachment_count`
    /// with retry + DLQ, mirroring `write_attachment`. Called by the
    /// capture pipeline when the speculative count written with the
    /// turn row overcounts (because some attachment bundles DLQ'd).
    ///
    /// # Flow
    ///
    /// 1. Try `update_turn_attachment_count` up to `max_retries` times.
    ///    Transient errors back off exponentially; permanent errors
    ///    (missing column, insufficient privilege, etc.) skip backoff
    ///    and go straight to DLQ.
    /// 2. On persistent failure, write a reconciliation-intent DLQ
    ///    record `attachment_count_drift_<turn_id>.json` so operators
    ///    can reconcile manually. Record contains turn_id, speculative
    ///    count, persisted count, dlq count, timestamp, and reason.
    ///
    /// # Return value
    ///
    /// `Ok(true)` when the UPDATE succeeded (invariant restored).
    /// `Ok(false)` when retries exhausted and DLQ record was written
    /// (row on disk still overcounts; DLQ entry alerts operator).
    /// `Err(e)` when both the UPDATE and DLQ write fail.
    pub fn reconcile_turn_attachment_count(
        &self,
        turn_id: &str,
        persisted_count: i64,
        speculative_count: i64,
        dlq_count: i64,
    ) -> Result<bool> {
        let mut last_error: Option<GraphStoreError> = None;
        let mut permanent = false;
        for attempt in 0..self.max_retries {
            match self
                .graph
                .update_turn_attachment_count(turn_id, persisted_count)
            {
                Ok(()) => return Ok(true),
                Err(e) => {
                    let is_transient = e.is_transient();
                    last_error = Some(e);
                    if !is_transient {
                        permanent = true;
                        break;
                    }
                    if attempt + 1 < self.max_retries {
                        let delay_ms = 10u64 * 10u64.pow(attempt as u32);
                        block_on_sleep(std::time::Duration::from_millis(delay_ms));
                    }
                }
            }
        }

        // Drop to DLQ: reconciliation failed.
        let error_msg = last_error
            .as_ref()
            .map(|e| {
                if permanent {
                    format!("[permanent, no retry] {}", e)
                } else {
                    format!("{}", e)
                }
            })
            .unwrap_or_else(|| "unknown error".to_string());
        let retry_count = if permanent { 0 } else { self.max_retries };

        if let Err(dlq_err) = self.dead_letter_attachment_count_drift(
            turn_id,
            persisted_count,
            speculative_count,
            dlq_count,
            &error_msg,
            retry_count,
        ) {
            tracing::error!(
                turn_id = %turn_id,
                error = %dlq_err,
                original_error = %error_msg,
                "Attachment-count-drift DLQ write failed; turn row will permanently overcount"
            );
            anyhow::bail!(
                "Attachment-count reconciliation failed after {} retries \
                 AND DLQ write also failed: {}",
                self.max_retries,
                error_msg
            );
        }
        Ok(false)
    }

    /// FIND-1-K sub-fix: Write a reconciliation-intent DLQ record so
    /// operators can fix the `turns.attachment_count == COUNT(*)`
    /// invariant manually when the UPDATE permanently fails.
    fn dead_letter_attachment_count_drift(
        &self,
        turn_id: &str,
        persisted_count: i64,
        speculative_count: i64,
        dlq_count: i64,
        error: &str,
        retry_count: usize,
    ) -> Result<()> {
        fs::create_dir_all(&self.dead_letter_dir)?;

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        let filename = format!("{}_attachment_count_drift_{}.json", timestamp, turn_id);
        let filepath = self.dead_letter_dir.join(&filename);

        let dlq_entry = serde_json::json!({
            "dead_letter_reason": error,
            "retry_count": retry_count,
            "timestamp": timestamp,
            "kind": "attachment_count_drift",
            "turn_id": turn_id,
            "speculative_count": speculative_count,
            "persisted_count": persisted_count,
            "dlq_count": dlq_count,
        });

        let tmp_filename = format!(".tmp_{}_attachment_count_drift_{}.json", timestamp, turn_id);
        let tmp_filepath = self.dead_letter_dir.join(&tmp_filename);
        let result = (|| -> Result<()> {
            fs::write(&tmp_filepath, serde_json::to_string_pretty(&dlq_entry)?)?;
            fs::rename(&tmp_filepath, &filepath)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp_filepath);
        }
        result
    }

    /// FIND-1-L: Dead-letter a failed attachment bundle. Includes the
    /// base64-encoded bytes so the operator can replay the object-store
    /// put manually after the underlying failure is resolved.
    fn dead_letter_attachment(
        &self,
        attachment: &AttachmentRecord,
        bytes: &[u8],
        error: &str,
        retry_count: usize,
    ) -> Result<()> {
        use base64::{engine::general_purpose::STANDARD, Engine as _};

        fs::create_dir_all(&self.dead_letter_dir)?;

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        let filename = format!("{}_attachment_{}.json", timestamp, &attachment.id);
        let filepath = self.dead_letter_dir.join(&filename);

        // Cap the embedded bytes so a 20 MiB attachment doesn't blow up
        // the DLQ directory. For larger payloads, only the first 1 MiB is
        // retained alongside the metadata; the operator can replay the
        // extraction from the stored request body (req_hash) if needed.
        const MAX_EMBED_BYTES: usize = 1024 * 1024;
        let embed_len = bytes.len().min(MAX_EMBED_BYTES);
        let truncated = bytes.len() > embed_len;

        let dlq_entry = serde_json::json!({
            "dead_letter_reason": error,
            "retry_count": retry_count,
            "timestamp": timestamp,
            "kind": "attachment",
            "attachment": attachment,
            "bytes_truncated": truncated,
            "bytes_len": bytes.len(),
            "bytes_b64": STANDARD.encode(&bytes[..embed_len]),
        });

        let tmp_filename = format!(".tmp_{}_attachment_{}.json", timestamp, &attachment.id);
        let tmp_filepath = self.dead_letter_dir.join(&tmp_filename);
        let result = (|| -> Result<()> {
            fs::write(&tmp_filepath, serde_json::to_string_pretty(&dlq_entry)?)?;
            fs::rename(&tmp_filepath, &filepath)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp_filepath);
        }
        result
    }

    /// Count the number of dead-letter files in the DLQ directory.
    pub fn dead_letter_count(&self) -> Result<usize> {
        if !self.dead_letter_dir.exists() {
            return Ok(0);
        }
        let count = fs::read_dir(&self.dead_letter_dir)?
            .filter_map(|e| e.ok())
            .filter(|e| {
                let path = e.path();
                if !path.is_file() {
                    return false;
                }
                // Exclude in-progress temp files created by the atomic write
                // pattern (dead_letter writes to `.tmp_*` then renames).
                let name = e.file_name();
                let name_str = name.to_string_lossy();
                !name_str.starts_with(".tmp_")
            })
            .count();
        Ok(count)
    }

    /// Write graph records (session, turn, tool_calls).
    ///
    /// W5: There is no multi-write transaction wrapping session + turn + tool_calls.
    /// The WritePipeline provides retry + DLQ as a compensating control. A true
    /// multi-statement transaction is tracked as a future improvement.
    fn write_graph(
        &self,
        session: &SessionRecord,
        turn: &TurnRecord,
        tool_calls: &[ToolCallRecord],
    ) -> Result<i64> {
        // N4: Write session, ignoring duplicate-key errors (the session may
        // already exist from a previous turn in the same session). Any *other*
        // error is propagated.
        match self.graph.write_session(session) {
            Ok(()) => {}
            Err(GraphStoreError::DuplicateKey { .. }) => {
                // Duplicate key — session already persisted, this is expected.
            }
            Err(e) => return Err(e.into()),
        }
        // Bug-2 fix (multi-instance): allocate `sequence_num` atomically
        // under a per-session DB-level lock. PG: pg_advisory_xact_lock;
        // SQLite: BEGIN IMMEDIATE. The returned seq is used by the caller
        // to update the in-memory turn record (so downstream attachment
        // writes see the right `turn_id` linkage).
        //
        // PrimaryKey collisions (true idempotent retries of the same turn
        // from a prior failed attempt) still return DuplicateKey and are
        // swallowed. Other errors propagate.
        let assigned_seq = match self.graph.write_turn_atomic_seq(turn) {
            Ok(seq) => seq,
            Err(GraphStoreError::DuplicateKey { .. }) => {
                // Turn already persisted from a previous retry attempt
                // (PK collision on `turn.id`). The caller's in-memory
                // sequence_num is already correct from the prior
                // successful write that we're observing as a duplicate
                // here.
                turn.sequence_num
            }
            Err(e) => return Err(e.into()),
        };
        for tc in tool_calls {
            match self.graph.write_tool_call(tc) {
                Ok(()) => {}
                Err(GraphStoreError::DuplicateKey { .. }) => {
                    // Tool call already persisted from a previous retry attempt.
                }
                Err(e) => return Err(e.into()),
            }
        }
        Ok(assigned_seq)
    }

    /// Write a failed capture to the dead-letter queue.
    fn dead_letter(
        &self,
        session: &SessionRecord,
        turn: &TurnRecord,
        tool_calls: &[ToolCallRecord],
        error: &str,
    ) -> Result<()> {
        fs::create_dir_all(&self.dead_letter_dir)?;

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        let filename = format!("{}_{}.json", timestamp, &turn.id);
        let filepath = self.dead_letter_dir.join(filename);

        let dlq_entry = serde_json::json!({
            "error": error,
            "timestamp": timestamp,
            "session": session,
            "turn": turn,
            "tool_calls": tool_calls,
        });

        // Atomic write: write to temp file, then rename. Same pattern as the
        // object store to prevent partial DLQ files on crash.
        let tmp_filepath = self
            .dead_letter_dir
            .join(format!(".tmp_{}_{}.json", timestamp, &turn.id));
        let result = (|| -> Result<()> {
            fs::write(&tmp_filepath, serde_json::to_string_pretty(&dlq_entry)?)?;
            fs::rename(&tmp_filepath, &filepath)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp_filepath);
        }
        result
    }
}
