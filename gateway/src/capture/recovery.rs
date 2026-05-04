//! Orphan capture recovery.
//!
//! When the gateway captures a request/response pair the durable artifacts
//! are written in this order:
//!
//!   1. Gzipped object bytes via `crate::store::store_request` and
//!      `crate::store::store_response` → `<data_dir>/objects/{req,resp}/<sha256>.json.gz`.
//!   2. JSON capture metadata via `crate::capture::record_capture` →
//!      `<data_dir>/captures/<safe_ts>_<uuid>.json` (atomic temp+rename).
//!   3. WAL append.
//!   4. Provider parse + DB insert via `WritePipeline` / `GraphStore`.
//!
//! If the gateway dies between (2) and (4) the bytes survive on disk but no
//! `turns` row exists. This module sweeps `<data_dir>/captures/` at startup
//! (and on demand via the `recondo-gateway reprocess` CLI) and replays each
//! orphan through the same parse-and-insert path the live pipeline uses,
//! preserving the original capture timestamp.
//!
//! The recovery is **provider-agnostic** — it dispatches through the
//! existing `parse_capture_data` (single source of truth for SSE / JSON /
//! request body parsing across Anthropic, Google, OpenAI). Idempotency is
//! enforced via three independent layers (round-2 reinforcement):
//!
//!   * **Per-orphan probe** (FIND-1-1) — `find_turn_by_request_hash`
//!     consults the `idx_turns_request_hash` index for each orphan,
//!     bypassing the silent 1000-row cap on `list_sessions`.
//!   * **Deterministic turn id** — the recovered turn re-uses
//!     `CaptureRecord.uuid` as its `turns.id`. Two concurrent recovery
//!     invocations operating on the same capture file generate the same
//!     `id`; the second insert hits the `turns` PRIMARY KEY UNIQUE
//!     constraint and the recovery treats `DuplicateKey` as success.
//!   * **Cross-process advisory file lock** (FIND-1-7) —
//!     `<data_dir>/.recovery.lock` is acquired exclusively while a
//!     recovery run is in progress so an ops-mistake `recondo
//!     reprocess` against a running daemon (or two parallel `reprocess`
//!     invocations) cannot race the live capture path's insert.
//!
//! Wired into:
//!   * gateway startup (`gateway::run_listener`) — runs after the
//!     `WritePipeline` is built, before the TCP listener accepts traffic;
//!   * the `recondo-gateway reprocess` CLI subcommand (with `--dry-run`).

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use fs2::FileExt;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tracing::{debug, info, warn};

use crate::db::{SessionRecord, ToolCallRecord, TurnRecord};
use crate::schema::CaptureRecord;
use crate::storage::graph::{GraphStore, GraphStoreError};
use crate::storage::object::ObjectStore;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Configuration for an orphan recovery run.
///
/// The default config is appropriate for both startup recovery and the
/// `reprocess` CLI subcommand. `dry_run = false` performs real inserts;
/// `dry_run = true` counts orphans but inserts nothing (used by
/// `reprocess --dry-run`).
#[derive(Debug, Clone, Default)]
pub struct RecoveryConfig {
    /// When true, classify orphans but do not write to the graph store.
    pub dry_run: bool,
}

impl RecoveryConfig {
    /// Build a dry-run configuration (no DB writes).
    pub fn dry_run() -> Self {
        Self { dry_run: true }
    }
}

/// Outcome of a recovery run.
#[derive(Debug, Clone, Default)]
pub struct RecoveryReport {
    /// Number of capture metadata files visited.
    pub scanned: usize,
    /// Number of orphans found (capture file with no matching `turns` row).
    pub orphans_found: usize,
    /// Number of orphans successfully replayed into the graph store. Always
    /// `0` in dry-run mode.
    pub recovered: usize,
    /// FIND-1-4 (round 2): number of attachment rows persisted as a
    /// side-effect of orphan recovery. The live capture path also
    /// fetches/rehosts external image URLs, but the recovery path
    /// only persists the inline base64 attachments embedded directly
    /// in the request body — external URLs would require async
    /// network I/O and an SSRF-guarded reqwest client. Operators
    /// who need external-URL hydration should re-issue the original
    /// request through the live capture path.
    pub attachments_recovered: usize,
    /// Files that could not be parsed, whose bytes were missing, or whose
    /// replay failed for a non-duplicate reason. The string is a
    /// human-readable description of the failure with secrets and
    /// partial JSON bodies stripped (see FIND-1-12).
    pub failed: Vec<(PathBuf, String)>,
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Walk `<data_dir>/captures/`, classify each capture metadata file, and
/// replay any orphan through the live parse + insert path.
///
/// See the module-level docs for the contract. Safe to call concurrently
/// in two senses:
///   * **Same-process:** the deterministic turn id (`= CaptureRecord.uuid`)
///     plus the `turns` PRIMARY KEY UNIQUE constraint guarantee
///     at-most-one row per capture even if two threads invoke this
///     function simultaneously.
///   * **Cross-process:** an exclusive advisory lock on
///     `<data_dir>/.recovery.lock` prevents a CLI `reprocess` from
///     racing a running gateway's startup hook (FIND-1-7). Failure
///     to acquire the lock is reported as
///     `Err("another recovery in progress")` rather than silent
///     dropthrough.
///
/// # Runtime requirements
///
/// (FIND-1-11.) This function is **synchronous** and uses pure-sync
/// `GraphStore` calls. The PostgreSQL backend bridges async drivers
/// via `block_on`, which requires a tokio multi-threaded runtime to
/// be reachable when called from inside a tokio context. Concretely:
///
///   * **OK** — call from a non-tokio thread (e.g. the gateway's
///     startup-recovery hook wraps the call in
///     `tokio::task::spawn_blocking` from a multi-threaded runtime),
///     or from a CLI binary's main function before any tokio runtime
///     is started, or from a `#[tokio::main(flavor =
///     "multi_thread")]` test using `spawn_blocking`.
///   * **PANIC** — call directly from inside a tokio async fn body
///     on a single-threaded runtime, or from inside an async fn
///     without `tokio::task::block_in_place`. The PG backend's
///     internal `block_on` will then panic with "can call blocking
///     only when running on the multi-threaded runtime".
///
/// The CLI subcommand (`cmd_reprocess`) acquires the lock, calls
/// this function on the main thread, and is correct because the
/// `#[tokio::main]` runtime is multi-threaded by default.
///
/// # Failure semantics (FIND-1-8)
///
/// Recovery is **fail-and-retry-on-next-boot** — failed orphans
/// are surfaced via `RecoveryReport.failed` and remain on disk so
/// the next gateway boot (or the next manual `recondo reprocess`)
/// can retry them. Recovery does NOT route through the
/// `WritePipeline`'s retry+DLQ machinery: a transient PG outage
/// during startup recovery will leave orphans classified as
/// `failed` rather than persisting them through DLQ. Operators
/// observing sustained `recovery_failures_total{reason="transient"}`
/// counters should re-run `recondo reprocess` once the underlying
/// outage clears; the on-disk metadata is the durable retry queue.
pub fn recover_orphan_captures(
    data_dir: &Path,
    graph_store: &dyn GraphStore,
    object_store: &dyn ObjectStore,
    config: &RecoveryConfig,
) -> Result<RecoveryReport> {
    let metrics = crate::metrics::MetricsRegistry::global();
    metrics.incr_recovery_run();

    // FIND-1-7 (round 2): cross-process advisory lock. Acquired
    // BEFORE any graph-store probe so a concurrent CLI/daemon pair
    // cannot race. Lock file is created if missing; we hold the
    // exclusive lock for the duration of this function (Drop on
    // `_lock_guard` releases it).
    let _lock_guard = acquire_recovery_lock(data_dir)?;

    let captures_dir = data_dir.join("captures");
    let mut report = RecoveryReport::default();

    // Missing captures dir is not an error — fresh install or test env.
    let read = match fs::read_dir(&captures_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(report);
        }
        Err(e) => {
            return Err(anyhow::Error::new(e).context(format!(
                "failed to read captures dir {}",
                captures_dir.display()
            )));
        }
    };

    // Allowed providers — recovery's allowlist (FIND-1-3 / FIND-1-13).
    // Must mirror the `parse_capture_data` dispatch arms (anthropic /
    // google / openai) plus the live-path generic-adapter providers
    // discovered at recovery time.
    let allowed_providers = build_allowed_provider_set();

    for entry in read {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                let msg = format!("dir entry error: {}", e);
                metrics.incr_recovery_failure("other", 1);
                report.failed.push((captures_dir.clone(), msg));
                continue;
            }
        };
        let path = entry.path();
        // Only consider files ending in .json. Ignore tmp files
        // (.tmp_<uuid>) that record_capture writes mid-rename.
        let is_json = path.extension().map(|e| e == "json").unwrap_or(false);
        if !is_json || !path.is_file() {
            continue;
        }
        report.scanned += 1;

        let record = match read_capture_record(&path) {
            Ok(r) => r,
            Err(e) => {
                metrics.incr_recovery_failure("parse", 1);
                report
                    .failed
                    .push((path.clone(), sanitize_error(&path, &e)));
                continue;
            }
        };

        // FIND-1-3 (round 2): validate untrusted on-disk fields BEFORE
        // any other use. Reject (do not insert) on:
        //   * unparseable RFC3339 timestamp
        //   * timestamp >5min in the future (clock-skew tolerance)
        //   * unparseable uuid
        //   * provider not in the allowlist (also covers FIND-1-13).
        if let Err(reason) = validate_capture_record(&record, &allowed_providers) {
            metrics.incr_recovery_failure("validation", 1);
            report
                .failed
                .push((path.clone(), format!("rejected on validation: {}", reason)));
            continue;
        }

        // FIND-1-1 (round 2): per-orphan probe via `find_turn_by_request_hash`,
        // backed by `idx_turns_request_hash`. Bypasses the 1000-row
        // `list_sessions` cap that the round-1 implementation hit.
        let existing = graph_store
            .find_turn_by_request_hash(&record.request_hash)
            .map_err(|e| {
                anyhow::anyhow!("find_turn_by_request_hash failed during recovery: {}", e)
            })?;
        if existing.is_some() {
            // Already recovered (or originally captured cleanly).
            debug!(
                path = %path.display(),
                request_hash = %record.request_hash,
                "Capture already has a turns row; skipping"
            );
            continue;
        }

        report.orphans_found += 1;
        metrics.incr_recovery_orphans_found(1);

        if config.dry_run {
            // Dry-run: classified as orphan, do not insert.
            continue;
        }

        match replay_orphan(graph_store, object_store, &record) {
            Ok(ReplayOutcome::Inserted {
                attachments_persisted,
            }) => {
                report.recovered += 1;
                report.attachments_recovered += attachments_persisted;
                metrics.incr_recovery_recovered(1);
            }
            Ok(ReplayOutcome::AlreadyPresent) => {
                // Concurrent recovery already inserted, or the
                // pre-insert probe missed because the row was
                // committed between probe and insert. Either way,
                // not an error.
            }
            Err(ReplayError::VerifyFailed(msg)) => {
                metrics.incr_recovery_failure("verify", 1);
                report.failed.push((path.clone(), msg));
            }
            Err(ReplayError::Insert(msg)) => {
                metrics.incr_recovery_failure("insert", 1);
                report.failed.push((path.clone(), msg));
            }
            Err(ReplayError::Transient(msg)) => {
                metrics.incr_recovery_failure("transient", 1);
                report.failed.push((path.clone(), msg));
            }
            Err(ReplayError::Other(msg)) => {
                metrics.incr_recovery_failure("other", 1);
                report.failed.push((path.clone(), msg));
            }
        }
    }

    info!(
        scanned = report.scanned,
        orphans_found = report.orphans_found,
        recovered = report.recovered,
        attachments_recovered = report.attachments_recovered,
        failed = report.failed.len(),
        dry_run = config.dry_run,
        data_dir = %data_dir.display(),
        "Orphan capture recovery summary"
    );

    Ok(report)
}

// ---------------------------------------------------------------------------
// Internal: lock acquisition (FIND-1-7)
// ---------------------------------------------------------------------------

/// RAII guard for the recovery advisory lock. Releases the OS-level
/// exclusive lock on Drop.
struct RecoveryLockGuard {
    file: fs::File,
}

impl Drop for RecoveryLockGuard {
    fn drop(&mut self) {
        // Best-effort unlock; the file's close on Drop also releases
        // the lock on POSIX, but we explicitly call unlock for clarity
        // and so Windows behaves the same way.
        let _ = FileExt::unlock(&self.file);
    }
}

/// FIND-1-7 / E6 (audit `docs/GATEWAY_AUDIT_2026_05_02.md:204-210`):
/// acquire `<data_dir>/.recovery.lock` as a cross-process advisory
/// exclusive file lock. Tries non-blocking first; on `WouldBlock` we
/// retry briefly so two SAME-process threads (gateway startup hook
/// firing while the CLI's `reprocess` happens to land in the same
/// process — the unit-test concurrency model) serialize rather than
/// error. After the bounded retry window we surface a clear error so
/// cross-PROCESS races (the daemon-vs-CLI scenario FIND-1-7 cares
/// about) fail fast and visibly with a nonzero exit.
///
/// **TOCTOU scope (E6, audit `docs/GATEWAY_AUDIT_2026_05_02.md:204-210`).**
/// Both `flock(2)` and `fcntl(F_SETLK)` lock the **inode**, not the
/// path. The audit calls out a specific window: between our `open`
/// of the lock path and our `flock` of the resulting fd, a peer can
/// `unlink` the path and `create` a new file at the same path on a
/// different inode. The naive `OpenOptions::create(true)` + `flock`
/// pair would then succeed on the fresh inode while a stale holder
/// still owns the unlinked one — both believing they hold the lock.
///
/// **What this code closes.** The literal "open-flock window" race.
/// Two defensive measures, both unconditional:
///
///   1. **Open-existing-vs-bootstrap split.** We first try `File::open`
///      (no create). On `NotFound` we promote to `create_new`
///      (`O_EXCL|O_CREAT`) atomically. If a concurrent peer wins
///      that create race we observe `AlreadyExists` and loop back to
///      the open-existing path so the underlying flock contention
///      serializes us. A blanket `create(true)` would have masked
///      the race by silently producing a fresh inode every call.
///
///   2. **Post-acquisition inode-stability check.** After every
///      successful `try_lock_exclusive` we `fstat` the held fd and
///      `stat` the path. If they diverge — or the path no longer
///      exists — a concurrent unlink/recreate happened between our
///      open and our flock; we drop the fd and retry. On the next
///      iteration we re-open the live inode at the path and contend
///      against whichever peer owns it.
///
/// The 30s deadline bounds the total acquire window across all
/// retries. `RecoveryLockGuard::Drop` releases the flock on every
/// success path.
///
/// **What this code does NOT close.** The "operator-rm-while-holder-
/// alive" scenario: an operator running `rm <data_dir>/.recovery.lock`
/// against a running gateway. After the unlink the live holder still
/// owns its inode (now unlinked); our acquirer's fresh inode at the
/// path passes the inode-stability check because nothing else has
/// raced us between open and lock. We have no in-process channel to
/// detect that a peer process owns a different, unlinked inode under
/// the same path — that requires either a content-level generation
/// token (every acquirer would have to write+fsync under the flock
/// and re-read post-flock to verify their own generation, with all
/// the failure modes that implies) or operator discipline.
///
/// The audit's primary recommendation was "Don't `rm` the lock file
/// as recovery action" — a runbook directive, not a code change.
/// CLAUDE.md (lines 285-302) gates the `rm` step behind `lsof`
/// reporting no holder; the in-code fix above complements that by
/// closing the open-flock window race so the runbook only has to
/// guard the operator-rm dimension. If the operator follows the
/// runbook (kill the live PID first; only `rm` when `lsof` confirms
/// the holder is dead), no race occurs. If the operator misuses
/// `rm` against a live holder, the violation is on the runbook
/// boundary, not a defect this function can detect.
fn acquire_recovery_lock(data_dir: &Path) -> Result<RecoveryLockGuard> {
    use std::os::unix::fs::MetadataExt;

    fs::create_dir_all(data_dir).with_context(|| {
        format!(
            "failed to ensure data_dir exists for recovery lock: {}",
            data_dir.display()
        )
    })?;
    let lock_path = data_dir.join(".recovery.lock");

    // Bounded retry window. 30s is well above what a healthy
    // recovery run takes (sub-second on the test fixtures, a few
    // seconds on production with a few hundred orphans). A
    // legitimate daemon-vs-CLI race blocks the CLI just long enough
    // for the daemon's startup hook to drain; an actually wedged
    // peer surfaces a clear error so the operator can investigate.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let backoff = std::time::Duration::from_millis(50);

    loop {
        // Phase 1: try to open an existing file. This is the steady-
        // state path — once `.recovery.lock` exists in `data_dir` it
        // persists across restarts (we only release the flock on
        // Drop, never unlink) so subsequent acquirers land here.
        let file = match fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
        {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Phase 2: bootstrap. Either this is a true fresh
                // install (no lock file ever existed) or the path
                // was unlinked under us (the audit's scenario). Use
                // `create_new` so two concurrent acquirers cannot
                // both believe they bootstrapped — only one will see
                // `Ok`, the other observes `AlreadyExists` and falls
                // back through the loop into the open-existing path.
                match fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .open(&lock_path)
                {
                    Ok(f) => f,
                    Err(e2) if e2.kind() == std::io::ErrorKind::AlreadyExists => {
                        // Lost the bootstrap race — loop back and
                        // open the existing file.
                        if std::time::Instant::now() >= deadline {
                            return Err(anyhow::anyhow!(
                                "could not acquire recovery lock at {} within 30s: bootstrap race exhausted deadline",
                                lock_path.display(),
                            ));
                        }
                        std::thread::sleep(backoff);
                        continue;
                    }
                    Err(e2) => {
                        return Err(anyhow::Error::new(e2).context(format!(
                            "failed to bootstrap recovery lock file {}",
                            lock_path.display()
                        )));
                    }
                }
            }
            Err(e) => {
                return Err(anyhow::Error::new(e).context(format!(
                    "failed to open recovery lock file {}",
                    lock_path.display()
                )));
            }
        };

        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => {
                // Post-acquisition inode-stability check (E6). We
                // hold a flock on `file`'s inode; verify the inode
                // we locked is still the inode the path resolves to.
                // If they differ — or if the path no longer exists —
                // a concurrent unlink/recreate happened between our
                // open and our flock. Drop and retry; on the next
                // iteration we re-open the path (the live inode) and
                // contend properly with whichever holder owns it.
                let fd_ino = match file.metadata() {
                    Ok(m) => m.ino(),
                    Err(e) => {
                        // fstat on an open fd should not fail under
                        // normal circumstances; treat as transient.
                        let _ = FileExt::unlock(&file);
                        drop(file);
                        if std::time::Instant::now() >= deadline {
                            return Err(anyhow::anyhow!(
                                "could not acquire recovery lock at {} within 30s: fstat on locked fd failed: {}",
                                lock_path.display(),
                                e
                            ));
                        }
                        std::thread::sleep(backoff);
                        continue;
                    }
                };
                let path_ino = match fs::metadata(&lock_path) {
                    Ok(m) => Some(m.ino()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                    Err(e) => {
                        let _ = FileExt::unlock(&file);
                        drop(file);
                        if std::time::Instant::now() >= deadline {
                            return Err(anyhow::anyhow!(
                                "could not acquire recovery lock at {} within 30s: stat(path) failed: {}",
                                lock_path.display(),
                                e
                            ));
                        }
                        std::thread::sleep(backoff);
                        continue;
                    }
                };

                if path_ino != Some(fd_ino) {
                    // Inode mismatch (or path unlinked) — another
                    // actor is racing the lock file. Drop our stale
                    // flock and retry. Releasing the fd here is
                    // critical: it lets a peer that beat us to the
                    // live inode finish serializing through the
                    // proper inode.
                    let _ = FileExt::unlock(&file);
                    drop(file);
                    if std::time::Instant::now() >= deadline {
                        return Err(anyhow::anyhow!(
                            "could not acquire recovery lock at {} within 30s: stale-inode race (lock file was unlinked-and-recreated under us; another recovery in progress)",
                            lock_path.display(),
                        ));
                    }
                    std::thread::sleep(backoff);
                    continue;
                }

                // We locked the live inode at the path. Safe to hand
                // out the guard.
                return Ok(RecoveryLockGuard { file });
            }
            Err(e) => {
                drop(file);
                if std::time::Instant::now() >= deadline {
                    return Err(anyhow::anyhow!(
                        "could not acquire recovery lock at {} within 30s: another recovery in progress (live daemon or peer reprocess): {}",
                        lock_path.display(),
                        e
                    ));
                }
                std::thread::sleep(backoff);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Internal: provider allowlist + record validation (FIND-1-3)
// ---------------------------------------------------------------------------

fn build_allowed_provider_set() -> std::collections::HashSet<String> {
    let mut s = std::collections::HashSet::new();
    // First-class providers `parse_capture_data` dispatches on directly.
    s.insert("anthropic".to_string());
    s.insert("google".to_string());
    s.insert("openai".to_string());
    // FIND-2-4 (round 3): "unknown" is intentionally NOT in the
    // allowlist. The live capture pipeline labels truly-unmatched
    // traffic `provider="unknown"`, but `parse_capture_data` has no
    // "unknown" arm; falling through to the empty-fields branch
    // would let recovery write a `turns` row asserting
    // `capture_complete=true` with no parsed content. That is
    // weaker than the live path's behaviour AND offers an attacker
    // (or a corrupt capture) a path to inject empty-content rows
    // by writing `provider="unknown"` files into <data_dir>/captures/.
    // Live captures already in the DB are NOT affected — the
    // probe at find_turn_by_request_hash returns Some, so they
    // skip the allowlist check entirely. New "unknown" orphan
    // files are rejected with a clear validation failure.
    //
    // Generic adapters loaded at gateway startup; recovery's
    // allowlist must agree with the live capture path so an orphan
    // captured under a generic adapter can be recovered. Adapter
    // names are operator-supplied YAML, but they ARE explicitly
    // declared at startup; using them as the allowlist means an
    // attacker who can write to `<data_dir>/captures/` cannot inject
    // a `provider="<arbitrary>"` value that bypasses parsing — the
    // operator's adapter list still bounds the universe.
    for cfg in crate::providers::generic_adapter_configs().iter() {
        s.insert(cfg.provider_name.clone());
    }
    s
}

/// Validate fields parsed from on-disk JSON metadata. Recovery treats
/// the captures dir as untrusted (anyone with write access to
/// `<data_dir>/captures/` could write a malicious record). This
/// function rejects records that would otherwise propagate untrusted
/// or impossible values into the audit log.
fn validate_capture_record(
    record: &CaptureRecord,
    allowed_providers: &std::collections::HashSet<String>,
) -> std::result::Result<(), String> {
    // Provider allowlist (FIND-1-3 + FIND-1-13 + FIND-2-4).
    if !allowed_providers.contains(&record.provider) {
        return Err(format!(
            "provider {:?} not in allowlist {{anthropic,google,openai,<generic-adapters>}}",
            record.provider
        ));
    }

    // RFC3339 parse. The capture pipeline always writes RFC3339 via
    // `time::OffsetDateTime::format(&Rfc3339)`; a non-RFC3339 value
    // means either disk corruption or an attacker-injected file.
    let ts = OffsetDateTime::parse(&record.timestamp, &Rfc3339)
        .map_err(|e| format!("timestamp {:?} is not RFC3339: {}", record.timestamp, e))?;

    // Reject timestamps further than 5 minutes in the future. We do
    // NOT reject very-old timestamps because legitimate orphans can
    // be from a long-stopped gateway (the metadata file persists
    // until a successful recovery removes it… which today is never).
    let now = OffsetDateTime::now_utc();
    if ts > now + time::Duration::seconds(300) {
        return Err(format!(
            "timestamp {} is more than 5 minutes in the future (now={})",
            record.timestamp, now
        ));
    }

    // UUID parse — the recovery uses `record.uuid` as the
    // deterministic `turns.id`; an unparseable value would still
    // accept as a TEXT primary key but breaks `Uuid` consumers
    // downstream and risks adversarial inputs (`'; DROP …`-style
    // strings — rejected here because we never trust the raw value
    // in SQL anyway, but better fail-fast than fail-late).
    if uuid::Uuid::parse_str(&record.uuid).is_err() {
        return Err(format!("uuid {:?} is not a valid UUID", record.uuid));
    }

    // Format-check the bytes_ref values (FIND-1-14): we trust the
    // metadata's claim, so insist it matches the canonical layout
    // and points at the same hash as `request_hash`/`response_hash`.
    let req_expected = format!("objects/req/{}.json.gz", record.request_hash);
    if record.req_bytes_ref != req_expected {
        return Err(format!(
            "req_bytes_ref {:?} does not match expected {:?}",
            record.req_bytes_ref, req_expected
        ));
    }
    let resp_expected = format!("objects/resp/{}.json.gz", record.response_hash);
    if record.resp_bytes_ref != resp_expected {
        return Err(format!(
            "resp_bytes_ref {:?} does not match expected {:?}",
            record.resp_bytes_ref, resp_expected
        ));
    }

    // Hashes must be 64-char lowercase hex (sha256). Quick check; the
    // object store's verify() will catch content mismatches.
    if !is_hex64(&record.request_hash) {
        return Err(format!(
            "request_hash {:?} is not a 64-char hex sha256",
            record.request_hash
        ));
    }
    if !is_hex64(&record.response_hash) {
        return Err(format!(
            "response_hash {:?} is not a 64-char hex sha256",
            record.response_hash
        ));
    }

    Ok(())
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

// ---------------------------------------------------------------------------
// Internal: probe + replay
// ---------------------------------------------------------------------------

enum ReplayOutcome {
    Inserted { attachments_persisted: usize },
    AlreadyPresent,
}

#[derive(Debug)]
enum ReplayError {
    VerifyFailed(String),
    Insert(String),
    Transient(String),
    Other(String),
}

impl std::fmt::Display for ReplayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReplayError::VerifyFailed(s) => write!(f, "verify failed: {}", s),
            ReplayError::Insert(s) => write!(f, "insert failed: {}", s),
            ReplayError::Transient(s) => write!(f, "transient error: {}", s),
            ReplayError::Other(s) => write!(f, "{}", s),
        }
    }
}

/// FIND-1-12 (round 2): sanitize an error before stuffing it into
/// `RecoveryReport.failed`. The previous `format!("{:#}", e)` walked
/// the entire anyhow chain, which on a JSON parse error includes the
/// excerpt of the failing input — and a partially malformed
/// credentialed payload would then leak to logs (`tracing::warn!`)
/// AND to the operator's terminal (`cmd_reprocess` stdout).
///
/// We emit only the path + a short error class label + the
/// root-cause message. The root cause for `serde_json::Error` is its
/// own `Display`, which includes line/column but not the input
/// excerpt; for `std::io::Error` it's the system message; for our
/// custom messages it's whatever the caller passed.
fn sanitize_error(path: &Path, e: &anyhow::Error) -> String {
    let class = classify_error(e);
    let root = e.root_cause().to_string();
    // Hard cap on root-cause length to ensure no single error string
    // can carry an unbounded JSON excerpt.
    const MAX_ROOT: usize = 256;
    let root_truncated = if root.len() > MAX_ROOT {
        format!("{}…", &root[..MAX_ROOT])
    } else {
        root
    };
    format!("{}: {}: {}", path.display(), class, root_truncated)
}

fn classify_error(e: &anyhow::Error) -> &'static str {
    let msg = e.to_string();
    if msg.contains("deserialize") || msg.contains("expected") || msg.contains("EOF") {
        "parse"
    } else if msg.contains("read") || msg.contains("not found") || msg.contains("permission") {
        "io"
    } else {
        "error"
    }
}

/// Read and parse a single capture metadata file.
fn read_capture_record(path: &Path) -> Result<CaptureRecord> {
    let bytes = fs::read(path)
        .with_context(|| format!("failed to read capture metadata {}", path.display()))?;
    let record: CaptureRecord = serde_json::from_slice(&bytes)
        .with_context(|| format!("failed to deserialize capture metadata {}", path.display()))?;
    Ok(record)
}

/// Replay a single orphan: load bytes from the object store, verify
/// integrity, run the live parser, insert session + turn + tool calls
/// preserving the original capture timestamp.
fn replay_orphan(
    graph_store: &dyn GraphStore,
    object_store: &dyn ObjectStore,
    record: &CaptureRecord,
) -> std::result::Result<ReplayOutcome, ReplayError> {
    // FIND-1-2 (round 2): verify integrity BEFORE parsing/inserting.
    // The bytes on disk are untrusted; the captures dir is filesystem-
    // trusted but the object store gz files could be tampered. We
    // re-hash the decompressed bytes via `ObjectStore::verify` and
    // reject if the hash doesn't match what the metadata claims.
    let req_ok = object_store
        .verify("req", &record.request_hash)
        .map_err(|e| ReplayError::VerifyFailed(format!("verify req: {}", e.root_cause())))?;
    if !req_ok {
        return Err(ReplayError::VerifyFailed(format!(
            "request bytes for hash {} failed re-hash verification",
            record.request_hash
        )));
    }
    let resp_ok = object_store
        .verify("resp", &record.response_hash)
        .map_err(|e| ReplayError::VerifyFailed(format!("verify resp: {}", e.root_cause())))?;
    if !resp_ok {
        return Err(ReplayError::VerifyFailed(format!(
            "response bytes for hash {} failed re-hash verification",
            record.response_hash
        )));
    }

    // Now load the verified bytes for parsing. Verify already read
    // them once; we re-read via `get` to get a single `Vec<u8>`
    // (the `verify` API is bool-only). The reads are content-
    // addressed and the bytes already passed verification, so this
    // double-read does not introduce a TOCTOU between verify and
    // parse — any subsequent tampering would just mean the parsed
    // row is based on whatever the decompressed bytes were at parse
    // time, which by definition still matches the verified hash for
    // honest reads.
    let request_bytes = object_store
        .get("req", &record.request_hash)
        .map_err(|e| ReplayError::Other(format!("load req bytes: {}", e.root_cause())))?;
    let response_bytes = object_store
        .get("resp", &record.response_hash)
        .map_err(|e| ReplayError::Other(format!("load resp bytes: {}", e.root_cause())))?;

    // Provider-agnostic parse — single source of truth.
    let parsed =
        crate::gateway::parse_capture_data(&record.provider, &request_bytes, &response_bytes);

    // Session resolution. We do NOT mutate any live SessionManager — each
    // recovery uses its own ephemeral one so we don't disturb the live
    // gateway's in-flight session state. The session id is derived
    // either from metadata (deterministic) or, for content-only
    // sessions whose first user message is preamble-only, from the
    // capture record's persistent uuid (FIND-1-6 — replaces the
    // round-1 `Uuid::new_v4()` fallback that minted a fresh id on
    // every recovery run).
    let metadata = crate::session::extract_client_metadata(&request_bytes);
    let identity_headers = crate::session::extract_identity_headers(&request_bytes);
    let org_id = crate::gateway::extract_org_id(&response_bytes);

    let effective_metadata = if identity_headers.session_id.is_some() {
        crate::session::ClientMetadata {
            session_id: identity_headers.session_id.clone(),
            account_uuid: metadata.account_uuid.clone(),
            device_id: metadata.device_id.clone(),
        }
    } else if parsed.client_session_id.is_some() && metadata.session_id.is_none() {
        crate::session::ClientMetadata {
            session_id: parsed.client_session_id.clone(),
            account_uuid: metadata.account_uuid.clone(),
            device_id: metadata.device_id.clone(),
        }
    } else {
        metadata.clone()
    };
    let session_id = recovery_session_id(
        &effective_metadata,
        &parsed.messages,
        org_id.as_deref(),
        record,
    );

    // Sequence number: continue from the existing max for the resolved
    // session. New sessions get sequence 1.
    let existing_turns = graph_store
        .get_turns_for_session(&session_id)
        .map_err(|e| ReplayError::Transient(format!("get_turns_for_session: {}", e)))?;
    let max_seq = existing_turns
        .iter()
        .map(|t| t.sequence_num)
        .max()
        .unwrap_or(0);
    let sequence_num = max_seq + 1;
    let is_new_session = existing_turns.is_empty();

    // Compute cost, framework, etc. mirroring process_capture_with_pipeline.
    // Historical replay correctness: parse the original capture timestamp so
    // resolution picks the rates that were in effect at the original moment.
    //
    // FIND-1-2 (round 1): on parse failure, log a warning AND increment
    // `recondo_recovery_failures_total{reason="parse"}` before falling back
    // to `now_utc()`. Today every pricing entry has effective_from =
    // 2024-01-01 so the fallback can't change a result, but as soon as a
    // second pricing version lands the fallback would silently mis-price
    // any orphan with a corrupt timestamp. The warn + metric make the
    // fallback observable. Reason key reuses the existing "parse" bucket
    // (see metrics::MetricsRegistry::incr_recovery_failure) — adding a new
    // category would expand the Prometheus label set without operator value.
    let replay_at = match time::OffsetDateTime::parse(
        &record.timestamp,
        &time::format_description::well_known::Rfc3339,
    ) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(
                capture_uuid = %record.uuid,
                timestamp = %record.timestamp,
                error = %e,
                "orphan replay: timestamp parse failed; falling back to now_utc \
                 — historical pricing may be inaccurate"
            );
            crate::metrics::MetricsRegistry::global().incr_recovery_failure("parse", 1);
            time::OffsetDateTime::now_utc()
        }
    };
    let cost_usd = parsed.model.as_deref().map(|m| {
        crate::db::compute_cost_usd(
            crate::db::model_pricing::canonical(),
            m,
            parsed.input_tokens,
            parsed.output_tokens,
            parsed.cache_creation_tokens,
            parsed.cache_read_tokens,
            &replay_at,
        )
    });

    // Use the record.timestamp verbatim — preserving the original capture
    // moment is load-bearing for audit / compliance.
    let timestamp = record.timestamp.clone();

    let total_tokens = parsed
        .input_tokens
        .saturating_add(parsed.output_tokens)
        .saturating_add(parsed.cache_read_tokens)
        .saturating_add(parsed.cache_creation_tokens);

    // Build the session row (only inserted if new — otherwise the
    // GraphStore's INSERT OR IGNORE / DuplicateKey logic skips).
    let system_prompt_hash =
        crate::session::compute_system_prompt_hash(parsed.system_prompt.as_deref());
    let tools_value = parsed
        .tools
        .as_ref()
        .map(|t| serde_json::Value::Array(t.clone()));
    let tool_definitions_hash = crate::session::compute_tool_definitions_hash(tools_value.as_ref());
    let initial_intent = if parsed.is_preflight {
        None
    } else {
        crate::session::extract_initial_intent(&parsed.messages)
    };
    let framework = parsed
        .system_prompt
        .as_deref()
        .and_then(crate::session::detect_agent_framework);

    let session_record = SessionRecord {
        id: session_id.clone(),
        provider: record.provider.clone(),
        model: parsed.model.clone(),
        started_at: timestamp.clone(),
        last_active_at: timestamp.clone(),
        ended_at: None,
        initial_intent,
        system_prompt_hash,
        total_turns: 1,
        turns_captured: 1,
        dropped_events: 0,
        total_tokens,
        total_cost_usd: cost_usd.unwrap_or(0.0),
        framework,
        agent_id: identity_headers.agent_id.clone(),
        agent_version: None,
        git_repo: None,
        git_branch: None,
        git_commit: None,
        working_directory: None,
        parent_session_id: None,
        tags: None,
        account_uuid: identity_headers
            .user_id
            .clone()
            .or_else(|| metadata.account_uuid.clone()),
        device_id: metadata.device_id.clone(),
        tool_definitions_hash,
    };

    // Compute messages_delta the same way the live path does (for
    // anthropic/google providers with non-empty messages).
    let (messages_delta, messages_delta_count) = if (record.provider == "anthropic"
        || record.provider == "google")
        && !parsed.messages.is_empty()
    {
        let current_json =
            serde_json::to_string(&parsed.messages).unwrap_or_else(|_| "[]".to_string());
        let previous = if sequence_num > 1 {
            graph_store
                .get_previous_messages_prefix_marker(&session_id, sequence_num)
                .ok()
                .flatten()
        } else {
            None
        };
        match crate::providers::anthropic::compute_true_delta(&current_json, previous.as_deref()) {
            Ok(delta_str) => {
                let cnt = serde_json::from_str::<Vec<serde_json::Value>>(&delta_str)
                    .map(|a| a.len() as i64)
                    .unwrap_or(0);
                (Some(delta_str), Some(cnt))
            }
            Err(_) => {
                let result =
                    crate::providers::anthropic::compute_messages_delta(&parsed.messages, None);
                (
                    Some(
                        serde_json::to_string(&result.messages_delta)
                            .unwrap_or_else(|_| "[]".to_string()),
                    ),
                    Some(result.messages_delta_count),
                )
            }
        }
    } else {
        (None, None)
    };

    // FIND-1-4 (round 2): extract inline attachments from the
    // (verified) request body. We replicate the live path's
    // `last_user_message_slice` / `messages_delta` selection so the
    // attachment ordinals match what the live pipeline would have
    // produced. External-URL rehosting is intentionally skipped —
    // see RecoveryReport.attachments_recovered docs.
    let messages_for_attachments: Vec<serde_json::Value> = match messages_delta.as_deref() {
        Some(delta_str) => serde_json::from_str(delta_str).unwrap_or_else(|_| {
            // Fallback to the full messages array (which is always a superset
            // of the delta) — this is the same behaviour the live path uses
            // when delta JSON parsing fails.
            parsed.messages.clone()
        }),
        None => parsed.messages.clone(),
    };
    let extracted_attachments = crate::capture::attachments::extract_from_messages(
        &record.provider,
        &messages_for_attachments,
    )
    .unwrap_or_else(|_| Vec::new());

    // Deterministic turn id: re-use record.uuid. Concurrent recovery on
    // the same capture file produces the same id, so the second insert
    // hits the PK UNIQUE constraint and we treat that as
    // "already present".
    let turn_id = record.uuid.clone();

    // FIND-1-14 (round 2): trust the metadata's bytes_ref (already
    // validated to match the canonical format in
    // `validate_capture_record`).
    let req_bytes_ref = record.req_bytes_ref.clone();
    let resp_bytes_ref = record.resp_bytes_ref.clone();

    // Build attachment records. We persist only inline attachments
    // (those that successfully decoded to bytes). External URLs are
    // recorded with kind=ExternalImageUrl but `bytes` is empty; we
    // still write the attachment row so the dashboard can surface
    // "there was a remote image here" — matching the live path.
    let mut attachment_records: Vec<crate::db::AttachmentRecord> =
        Vec::with_capacity(extracted_attachments.len());
    for extracted in &extracted_attachments {
        let (sha256, object_ref, size_bytes, bytes_for_put): (String, String, i64, Vec<u8>) =
            if extracted.bytes.is_empty() {
                (
                    String::new(),
                    extracted.source_url.clone().unwrap_or_default(),
                    0,
                    Vec::new(),
                )
            } else {
                let sha256 = crate::hash::sha256_hex(&extracted.bytes);
                let object_ref = format!("attachments/{}.json.gz", sha256);
                (
                    sha256,
                    object_ref,
                    extracted.bytes.len() as i64,
                    extracted.bytes.clone(),
                )
            };
        // For inline attachments with bytes, ensure the blob is in the
        // object store. The live path writes via the WritePipeline; for
        // recovery we use the ObjectStore directly. `put` is content-
        // addressable so this is idempotent.
        if !bytes_for_put.is_empty() {
            if let Err(e) = object_store.put("attachments", &sha256, &bytes_for_put) {
                warn!(
                    error = %e.root_cause(),
                    "Recovery: attachment object_store.put failed (non-fatal — row will reference missing object)"
                );
            }
        }
        attachment_records.push(crate::db::AttachmentRecord {
            id: format!("{}-att-{}", turn_id, extracted.sequence_num),
            turn_id: turn_id.clone(),
            session_id: session_id.clone(),
            sequence_num: extracted.sequence_num,
            role: extracted.role.clone(),
            kind: extracted.kind.as_str().to_string(),
            mime_type: extracted.mime_type.clone(),
            size_bytes,
            sha256,
            object_ref,
            filename: extracted.filename.clone(),
            width: None,
            height: None,
        });
    }

    let attachment_count_i64 = attachment_records.len() as i64;

    let turn_record = TurnRecord {
        id: turn_id.clone(),
        session_id: session_id.clone(),
        sequence_num,
        timestamp: timestamp.clone(),
        request_hash: record.request_hash.clone(),
        response_hash: record.response_hash.clone(),
        req_bytes_ref: Some(req_bytes_ref),
        resp_bytes_ref: Some(resp_bytes_ref),
        req_bytes_size: Some(record.request_size as i64),
        resp_bytes_size: Some(record.response_size as i64),
        model: parsed.model.clone(),
        response_text: parsed.response_text.clone(),
        thinking_text: parsed.thinking_text.clone(),
        stop_reason: parsed.stop_reason.clone(),
        capture_complete: parsed.capture_complete,
        input_tokens: parsed.input_tokens,
        output_tokens: parsed.output_tokens,
        cache_read_tokens: parsed.cache_read_tokens,
        cache_creation_tokens: parsed.cache_creation_tokens,
        cost_usd,
        created_at: timestamp.clone(),
        messages_delta,
        messages_delta_count,
        raw_extra: parsed.raw_extra.clone(),
        parser_version: parsed.parser_version.clone(),
        parse_errors: parsed
            .parse_errors
            .as_ref()
            .map(|errors| serde_json::to_string(errors).unwrap_or_else(|_| "[]".to_string())),
        provider: Some(record.provider.clone()),
        transport: Some("http".to_string()),
        ws_direction: None,
        duration_ms: None,
        ttfb_ms: None,
        api_endpoint: None,
        http_status: None,
        error_message: None,
        retry_count: 0,
        tool_call_count: parsed.tool_calls.len() as i64,
        thinking_tokens: parsed.thinking_tokens.unwrap_or_else(|| {
            crate::gateway::estimate_thinking_tokens(parsed.thinking_text.as_deref())
        }),
        server_id: None,
        // FIND-1-2 (round 2): we re-hashed the bytes via
        // ObjectStore::verify above and rejected on mismatch. The
        // recovered row is observably as trustworthy as a live-
        // captured one whose pipeline ran integrity_verify post-
        // write — set the column accordingly.
        integrity_verified: Some(true),
        supersedes_turn_id: None,
        user_request_text: crate::session::extract_last_user_request_text(&parsed.messages).map(
            |t| {
                if t.chars().count() > 2000 {
                    t.chars().take(2000).collect()
                } else {
                    t
                }
            },
        ),
        attachment_count: attachment_count_i64,
    };

    // Build tool call records.
    let tool_records: Vec<ToolCallRecord> = parsed
        .tool_calls
        .iter()
        .map(|tc| {
            let artifacts = crate::artifacts::extract_artifacts(&tc.name, &tc.input);
            let artifacts_created = Some(
                serde_json::to_string(&artifacts.iter().map(|a| &a.path).collect::<Vec<_>>())
                    .unwrap_or_else(|_| "[]".to_string()),
            );
            let artifact_hashes = Some(
                serde_json::to_string(&artifacts.iter().map(|a| &a.hash).collect::<Vec<_>>())
                    .unwrap_or_else(|_| "[]".to_string()),
            );
            ToolCallRecord {
                id: format!("{}-tc-{}", turn_id, tc.name),
                turn_id: turn_id.clone(),
                tool_name: tc.name.clone(),
                tool_input: tc.input.clone(),
                input_hash: Some(crate::hash::sha256_hex(tc.input.as_bytes())),
                sequence_num: None,
                output: None,
                output_hash: None,
                duration_ms: None,
                error: None,
                status: None,
                artifacts_created,
                artifact_hashes,
            }
        })
        .collect();

    // Insert: session first (FK), then turn, then tool calls. Use the
    // GraphStore directly — no WritePipeline (recovery is a one-shot,
    // not the steady-state hot path; failures are surfaced to the
    // RecoveryReport, not the dead-letter queue).
    if is_new_session {
        match graph_store.write_session(&session_record) {
            Ok(()) => {}
            Err(GraphStoreError::DuplicateKey { .. }) => {
                // Session already exists — fine.
            }
            Err(e) => {
                return Err(classify_graph_error("write_session", e));
            }
        }
    } else {
        // Existing session: best-effort INSERT (graph store treats
        // duplicates as Ok or DuplicateKey).
        if let Err(e) = graph_store.write_session(&session_record) {
            if !matches!(e, GraphStoreError::DuplicateKey { .. }) {
                warn!(error = %e, "Recovery: write_session for existing session failed (non-fatal)");
            }
        }
    }

    match graph_store.write_turn(&turn_record) {
        Ok(()) => {}
        Err(GraphStoreError::DuplicateKey { .. }) => {
            // Concurrent recovery beat us to it — not an error.
            return Ok(ReplayOutcome::AlreadyPresent);
        }
        Err(e) => {
            return Err(classify_graph_error("write_turn", e));
        }
    }

    // FIND-1-5 (round 2): when an existing session got the orphan
    // appended, increment its aggregate totals. The live pipeline
    // does this via `update_session_totals` for every turn; recovery
    // had been silently skipping it for `is_new_session=false`,
    // under-reporting cost/usage on recovered traffic.
    if !is_new_session {
        if let Err(e) = graph_store.update_session_totals(
            &session_id,
            1,                       // delta_turns
            1,                       // delta_captured
            total_tokens,            // delta_tokens
            cost_usd.unwrap_or(0.0), // delta_cost_usd
        ) {
            warn!(
                session = %session_id,
                error = %e,
                "Recovery: update_session_totals for existing session failed (non-fatal — turn already inserted)"
            );
        }
    }

    for tc in &tool_records {
        if let Err(e) = graph_store.write_tool_call(tc) {
            if matches!(e, GraphStoreError::DuplicateKey { .. }) {
                continue;
            }
            warn!(
                tool = %tc.tool_name,
                error = %e,
                "Recovery: write_tool_call failed (non-fatal — turn already inserted)"
            );
        }
    }

    // Persist attachment rows (FIND-1-4). Each row is scoped to the
    // committed turn's id; non-fatal failures are logged. Inserts
    // are idempotent (UNIQUE on the synthesized id ensures a second
    // recovery run skips already-written rows).
    let mut attachments_persisted = 0usize;
    for attachment in &attachment_records {
        match graph_store.write_attachment(attachment) {
            Ok(()) => {
                attachments_persisted += 1;
            }
            Err(GraphStoreError::DuplicateKey { .. }) => {
                attachments_persisted += 1;
            }
            Err(e) => {
                warn!(
                    attachment = %attachment.id,
                    error = %e,
                    "Recovery: write_attachment failed (non-fatal — turn already inserted)"
                );
            }
        }
    }
    // Reconcile: if any attachments were dropped we already persisted
    // the turn with the speculative count; correct it.
    if (attachments_persisted as i64) != attachment_count_i64 {
        if let Err(e) =
            graph_store.update_turn_attachment_count(&turn_id, attachments_persisted as i64)
        {
            warn!(
                turn = %turn_id,
                error = %e,
                "Recovery: update_turn_attachment_count reconciliation failed (non-fatal)"
            );
        }
    }

    Ok(ReplayOutcome::Inserted {
        attachments_persisted,
    })
}

/// FIND-1-6 (round 2): deterministic session id for content-only
/// captures whose first user message is preamble-only. The round-1
/// implementation called `tentative_session_id`, which calls
/// `content_based_session_id`, which falls back to
/// `Uuid::new_v4()` for empty/preamble-only content — non-
/// deterministic across recovery runs. Recovery substitutes a
/// deterministic content-derived hash keyed on `record.uuid` so
/// two recovery passes produce the same session id.
fn recovery_session_id(
    metadata: &crate::session::ClientMetadata,
    messages: &[serde_json::Value],
    org_id: Option<&str>,
    record: &CaptureRecord,
) -> String {
    // Fast path: live `tentative_session_id` is deterministic when
    // metadata.session_id OR a non-empty user message is present.
    if metadata.session_id.is_some() {
        return crate::session::tentative_session_id(metadata, messages, org_id);
    }
    // Without metadata, peek at the messages: `content_based_session_id`'s
    // logic is internal, but we can predict its non-determinism by
    // checking whether any user message has non-empty extracted text.
    // If yes, the live function will hash it deterministically; if no,
    // it will mint a fresh uuid — which we want to avoid.
    let any_user_text = messages
        .iter()
        .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        .any(|m| {
            crate::session::extract_content_text(m)
                .map(|s| !s.is_empty())
                .unwrap_or(false)
        });
    if any_user_text {
        return crate::session::tentative_session_id(metadata, messages, org_id);
    }
    // Preamble-only / empty path: derive deterministic session id
    // from `record.uuid`. Same orphan capture file → same session
    // id across any number of recovery runs.
    let input = format!("orphan:{}", record.uuid);
    crate::hash::sha256_hex(input.as_bytes())
}

fn classify_graph_error(op: &'static str, e: GraphStoreError) -> ReplayError {
    let msg = format!("{} failed during recovery: {}", op, e);
    match e {
        GraphStoreError::ConnectionFailed(_) => ReplayError::Transient(msg),
        GraphStoreError::DuplicateKey { .. } => ReplayError::Insert(msg),
        _ => ReplayError::Insert(msg),
    }
}
