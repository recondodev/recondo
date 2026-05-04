//! Prometheus metrics registry and exposition.
//!
//! Provides a thread-safe `MetricsRegistry` that tracks gateway operational
//! metrics and renders them in Prometheus text exposition format (v0.0.4).
//!
//! Metrics exposed:
//! - `recondo_captures_total` (counter): total successful captures
//! - `recondo_capture_errors_total` (counter): total capture errors
//! - `recondo_bytes_processed_total` (counter): total bytes processed
//! - `recondo_active_tunnels` (gauge): currently active tunnels
//! - `recondo_db_pool_active` (gauge): active DB pool connections
//! - `recondo_capture_latency_seconds` (histogram): capture latency distribution

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

// ---------------------------------------------------------------------------
// Histogram buckets
// ---------------------------------------------------------------------------

/// Standard histogram bucket boundaries (in seconds).
const HISTOGRAM_BUCKETS: &[f64] = &[0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0];

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

/// A simple histogram that tracks observations in predefined buckets.
///
/// Each bucket count is stored as an `AtomicU64`. The sum is stored as an
/// `AtomicU64` representing the value in nanoseconds (for precision), and
/// rendered as seconds in the output.
struct Histogram {
    /// Per-bucket (non-cumulative) counts for each bucket boundary (same length as HISTOGRAM_BUCKETS).
    /// render() accumulates these into cumulative counts for Prometheus exposition.
    bucket_counts: Vec<AtomicU64>,
    /// Total count of observations.
    count: AtomicU64,
    /// Sum of all observed values in nanoseconds.
    sum_nanos: AtomicU64,
}

impl Histogram {
    fn new() -> Self {
        let bucket_counts = HISTOGRAM_BUCKETS
            .iter()
            .map(|_| AtomicU64::new(0))
            .collect();
        Histogram {
            bucket_counts,
            count: AtomicU64::new(0),
            sum_nanos: AtomicU64::new(0),
        }
    }

    fn observe(&self, value_secs: f64) {
        self.count.fetch_add(1, Ordering::Relaxed);
        let nanos = (value_secs * 1_000_000_000.0) as u64;
        self.sum_nanos.fetch_add(nanos, Ordering::Relaxed);

        // M3 fix: Only increment the FIRST matching bucket. render() already
        // does cumulative accumulation, so observe() must store per-bucket
        // non-cumulative counts to avoid double-counting.
        for (i, boundary) in HISTOGRAM_BUCKETS.iter().enumerate() {
            if value_secs <= *boundary {
                self.bucket_counts[i].fetch_add(1, Ordering::Relaxed);
                break;
            }
        }
    }

    fn render(&self, name: &str, help: &str, out: &mut String) {
        out.push_str(&format!("# HELP {} {}\n", name, help));
        out.push_str(&format!("# TYPE {} histogram\n", name));

        // Render cumulative bucket counts
        let mut cumulative = 0u64;
        for (i, boundary) in HISTOGRAM_BUCKETS.iter().enumerate() {
            cumulative += self.bucket_counts[i].load(Ordering::Relaxed);
            out.push_str(&format!(
                "{}_bucket{{le=\"{}\"}} {}\n",
                name, boundary, cumulative
            ));
        }
        // +Inf bucket
        let total_count = self.count.load(Ordering::Relaxed);
        out.push_str(&format!("{}_bucket{{le=\"+Inf\"}} {}\n", name, total_count));

        let sum_nanos = self.sum_nanos.load(Ordering::Relaxed);
        let sum_secs = sum_nanos as f64 / 1_000_000_000.0;
        // Render sum as integer when it's exactly zero, otherwise as float
        if sum_nanos == 0 {
            out.push_str(&format!("{}_sum 0\n", name));
        } else {
            // Use a compact representation
            let formatted = format!("{}", sum_secs);
            out.push_str(&format!("{}_sum {}\n", name, formatted));
        }
        out.push_str(&format!("{}_count {}\n", name, total_count));
    }
}

// ---------------------------------------------------------------------------
// MetricsRegistry
// ---------------------------------------------------------------------------

/// Thread-safe metrics registry for the Recondo gateway.
///
/// All counters use `AtomicU64` for lock-free concurrent access.
/// Gauges also use `AtomicU64` with store (not fetch_add) semantics.
pub struct MetricsRegistry {
    captures_total: AtomicU64,
    capture_errors_total: AtomicU64,
    bytes_processed_total: AtomicU64,
    active_tunnels: AtomicU64,
    db_pool_active: AtomicU64,
    capture_latency: Histogram,
    /// FIND-3-RUST-7: Per-reason counter for attachment bundles that
    /// wound up in the dead-letter queue. Labelled by reason so
    /// operators can alert on sustained DLQ activity without scraping
    /// logs.
    attachment_dlq_attachment_bundle: AtomicU64,
    attachment_dlq_count_drift: AtomicU64,
    /// FIND-1-9 / FIND-1-10 (round 2): orphan-recovery observability.
    /// Operators alert on `recovery_failures_total{reason=...}` to
    /// catch silent regressions of the startup-recovery hook
    /// (transient PG outages, parse errors, integrity failures).
    /// `recovery_runs_total` increments on each invocation of
    /// `recover_orphan_captures` so we can tell whether the hook
    /// fired at all on a given boot — the round-1 reviewer's
    /// concern that the test exercising the hook called the
    /// function directly, not via `start_gateway`, is now caught
    /// by asserting this counter from a binary integration test.
    recovery_runs_total: AtomicU64,
    recovery_orphans_found_total: AtomicU64,
    recovery_recovered_total: AtomicU64,
    recovery_failures_parse: AtomicU64,
    recovery_failures_verify: AtomicU64,
    recovery_failures_insert: AtomicU64,
    recovery_failures_transient: AtomicU64,
    recovery_failures_validation: AtomicU64,
    recovery_failures_other: AtomicU64,
    /// Audit fix (2026-05-03): the capture pipeline contains many
    /// `warn!(...non-fatal...)` swallows where a sub-step (drift
    /// detection, session-totals backfill, WAL flush, etc.) fails but
    /// the main turn write succeeds. Pre-fix these were log-only —
    /// the `error serializing parameter 8` jsonb-bind bug fired on
    /// every drift detection for a long time without anyone noticing
    /// because nothing surfaced in metrics. Each non-fatal swallow now
    /// increments this counter with a `component=...` label so
    /// operators can alert on sustained sub-pipeline failures even
    /// when the headline `capture_pipeline_succeeded` log fires.
    subpipeline_failures_drift_detection: AtomicU64,
    subpipeline_failures_tool_drift_detection: AtomicU64,
    subpipeline_failures_session_totals: AtomicU64,
    subpipeline_failures_session_backfill_framework: AtomicU64,
    subpipeline_failures_session_backfill_initial_intent: AtomicU64,
    subpipeline_failures_session_backfill_model: AtomicU64,
    subpipeline_failures_supersedes_resolution: AtomicU64,
    subpipeline_failures_wal_flush_mark: AtomicU64,
    subpipeline_failures_wal_append: AtomicU64,
    subpipeline_failures_messages_delta: AtomicU64,
    subpipeline_failures_attachment_extract: AtomicU64,
    subpipeline_failures_attachment_rehost: AtomicU64,
    subpipeline_failures_other: AtomicU64,
}

/// FIND-3-RUST-7: Global `MetricsRegistry` so counters that fire from
/// deeply nested call sites (e.g. `WritePipeline::write_attachment` via
/// `process_capture_with_pipeline`) can record without plumbing the
/// registry through five function arguments. The runtime registry is
/// created once at gateway startup; before that, counters land on a
/// noop local registry that `global()` allocates on first access. The
/// operator-visible registry is set via `init_global()` before the
/// listener opens, so all production traffic hits the same instance.
static GLOBAL_METRICS: std::sync::OnceLock<std::sync::Arc<MetricsRegistry>> =
    std::sync::OnceLock::new();

impl MetricsRegistry {
    /// Create a new registry with all metrics initialized to zero.
    pub fn new() -> Self {
        MetricsRegistry {
            captures_total: AtomicU64::new(0),
            capture_errors_total: AtomicU64::new(0),
            bytes_processed_total: AtomicU64::new(0),
            active_tunnels: AtomicU64::new(0),
            db_pool_active: AtomicU64::new(0),
            capture_latency: Histogram::new(),
            attachment_dlq_attachment_bundle: AtomicU64::new(0),
            attachment_dlq_count_drift: AtomicU64::new(0),
            recovery_runs_total: AtomicU64::new(0),
            recovery_orphans_found_total: AtomicU64::new(0),
            recovery_recovered_total: AtomicU64::new(0),
            recovery_failures_parse: AtomicU64::new(0),
            recovery_failures_verify: AtomicU64::new(0),
            recovery_failures_insert: AtomicU64::new(0),
            recovery_failures_transient: AtomicU64::new(0),
            recovery_failures_validation: AtomicU64::new(0),
            recovery_failures_other: AtomicU64::new(0),
            subpipeline_failures_drift_detection: AtomicU64::new(0),
            subpipeline_failures_tool_drift_detection: AtomicU64::new(0),
            subpipeline_failures_session_totals: AtomicU64::new(0),
            subpipeline_failures_session_backfill_framework: AtomicU64::new(0),
            subpipeline_failures_session_backfill_initial_intent: AtomicU64::new(0),
            subpipeline_failures_session_backfill_model: AtomicU64::new(0),
            subpipeline_failures_supersedes_resolution: AtomicU64::new(0),
            subpipeline_failures_wal_flush_mark: AtomicU64::new(0),
            subpipeline_failures_wal_append: AtomicU64::new(0),
            subpipeline_failures_messages_delta: AtomicU64::new(0),
            subpipeline_failures_attachment_extract: AtomicU64::new(0),
            subpipeline_failures_attachment_rehost: AtomicU64::new(0),
            subpipeline_failures_other: AtomicU64::new(0),
        }
    }

    /// Access (or lazily create) the process-global registry. Call
    /// `init_global(arc)` once at startup to install the shared
    /// registry; subsequent calls return the same instance.
    pub fn global() -> std::sync::Arc<MetricsRegistry> {
        GLOBAL_METRICS
            .get_or_init(|| std::sync::Arc::new(MetricsRegistry::new()))
            .clone()
    }

    /// Install a shared registry as the process-global. Idempotent —
    /// second and subsequent calls are noops (the first caller wins).
    /// Call from `run_listener` right after the listener registry is
    /// constructed so internal increments (attachment DLQ counters)
    /// hit the same instance as `/metrics`.
    pub fn init_global(registry: std::sync::Arc<MetricsRegistry>) {
        let _ = GLOBAL_METRICS.set(registry);
    }

    /// FIND-1-9 / FIND-1-10 (round 2): increment the recovery-run
    /// counter. Called once per `recover_orphan_captures` invocation,
    /// regardless of whether any orphans were found.
    pub fn incr_recovery_run(&self) {
        self.recovery_runs_total.fetch_add(1, Ordering::Relaxed);
    }

    /// FIND-1-9 (round 2): increment the orphan-found counter by `n`.
    pub fn incr_recovery_orphans_found(&self, n: u64) {
        self.recovery_orphans_found_total
            .fetch_add(n, Ordering::Relaxed);
    }

    /// FIND-1-9 (round 2): increment the recovered-orphan counter by `n`.
    pub fn incr_recovery_recovered(&self, n: u64) {
        self.recovery_recovered_total
            .fetch_add(n, Ordering::Relaxed);
    }

    /// FIND-1-9 (round 2): increment the per-reason recovery-failure
    /// counter. Unknown reasons fall into the `other` label so
    /// Prometheus scrapes always expose the known label set.
    pub fn incr_recovery_failure(&self, reason: &str, n: u64) {
        match reason {
            "parse" => {
                self.recovery_failures_parse.fetch_add(n, Ordering::Relaxed);
            }
            "verify" => {
                self.recovery_failures_verify
                    .fetch_add(n, Ordering::Relaxed);
            }
            "insert" => {
                self.recovery_failures_insert
                    .fetch_add(n, Ordering::Relaxed);
            }
            "transient" => {
                self.recovery_failures_transient
                    .fetch_add(n, Ordering::Relaxed);
            }
            "validation" => {
                self.recovery_failures_validation
                    .fetch_add(n, Ordering::Relaxed);
            }
            _ => {
                self.recovery_failures_other.fetch_add(n, Ordering::Relaxed);
            }
        }
    }

    /// Snapshot of `recovery_runs_total`. Used by tests to assert
    /// the startup hook fired without parsing Prometheus text.
    pub fn recovery_runs_total(&self) -> u64 {
        self.recovery_runs_total.load(Ordering::Relaxed)
    }

    /// FIND-3-RUST-7: Increment the attachment-DLQ counter for the
    /// given reason label. Unknown reasons fall into
    /// `attachment_bundle` so Prometheus scrapes always expose the
    /// known label set.
    pub fn incr_attachment_dlq_total(&self, reason: &str, n: u64) {
        match reason {
            "count_drift" => {
                self.attachment_dlq_count_drift
                    .fetch_add(n, Ordering::Relaxed);
            }
            _ => {
                self.attachment_dlq_attachment_bundle
                    .fetch_add(n, Ordering::Relaxed);
            }
        }
    }

    /// Audit fix: increment a per-component counter for non-fatal
    /// sub-pipeline failures inside `process_capture_with_pipeline`
    /// (and friends). Call this from every `warn!(...non-fatal...)`
    /// site so alerting can catch sustained failures even when the
    /// main capture continues. Unknown components fall into `other`.
    pub fn incr_subpipeline_failure(&self, component: &str, n: u64) {
        match component {
            "drift_detection" => &self.subpipeline_failures_drift_detection,
            "tool_drift_detection" => &self.subpipeline_failures_tool_drift_detection,
            "session_totals" => &self.subpipeline_failures_session_totals,
            "session_backfill_framework" => &self.subpipeline_failures_session_backfill_framework,
            "session_backfill_initial_intent" => {
                &self.subpipeline_failures_session_backfill_initial_intent
            }
            "session_backfill_model" => &self.subpipeline_failures_session_backfill_model,
            "supersedes_resolution" => &self.subpipeline_failures_supersedes_resolution,
            "wal_flush_mark" => &self.subpipeline_failures_wal_flush_mark,
            "wal_append" => &self.subpipeline_failures_wal_append,
            "messages_delta" => &self.subpipeline_failures_messages_delta,
            "attachment_extract" => &self.subpipeline_failures_attachment_extract,
            "attachment_rehost" => &self.subpipeline_failures_attachment_rehost,
            _ => &self.subpipeline_failures_other,
        }
        .fetch_add(n, Ordering::Relaxed);
    }

    /// Render all metrics in Prometheus text exposition format.
    pub fn render(&self) -> String {
        let mut out = String::new();

        // Gauges
        out.push_str("# HELP recondo_active_tunnels Number of currently active proxy tunnels\n");
        out.push_str("# TYPE recondo_active_tunnels gauge\n");
        out.push_str(&format!(
            "recondo_active_tunnels {}\n",
            self.active_tunnels.load(Ordering::Relaxed)
        ));
        out.push('\n');

        out.push_str("# HELP recondo_db_pool_active Number of active database pool connections\n");
        out.push_str("# TYPE recondo_db_pool_active gauge\n");
        out.push_str(&format!(
            "recondo_db_pool_active {}\n",
            self.db_pool_active.load(Ordering::Relaxed)
        ));
        out.push('\n');

        // Counters
        out.push_str("# HELP recondo_captures_total Total number of successful captures\n");
        out.push_str("# TYPE recondo_captures_total counter\n");
        out.push_str(&format!(
            "recondo_captures_total {}\n",
            self.captures_total.load(Ordering::Relaxed)
        ));
        out.push('\n');

        out.push_str("# HELP recondo_capture_errors_total Total number of capture errors\n");
        out.push_str("# TYPE recondo_capture_errors_total counter\n");
        out.push_str(&format!(
            "recondo_capture_errors_total {}\n",
            self.capture_errors_total.load(Ordering::Relaxed)
        ));
        out.push('\n');

        out.push_str(
            "# HELP recondo_bytes_processed_total Total bytes processed through the gateway\n",
        );
        out.push_str("# TYPE recondo_bytes_processed_total counter\n");
        out.push_str(&format!(
            "recondo_bytes_processed_total {}\n",
            self.bytes_processed_total.load(Ordering::Relaxed)
        ));
        out.push('\n');

        // FIND-1-9 (round 2): orphan-recovery counters.
        out.push_str("# HELP recondo_recovery_runs_total Number of orphan-recovery invocations\n");
        out.push_str("# TYPE recondo_recovery_runs_total counter\n");
        out.push_str(&format!(
            "recondo_recovery_runs_total {}\n",
            self.recovery_runs_total.load(Ordering::Relaxed)
        ));
        out.push('\n');

        out.push_str(
            "# HELP recondo_recovery_orphans_found_total Total orphans classified across recovery runs\n",
        );
        out.push_str("# TYPE recondo_recovery_orphans_found_total counter\n");
        out.push_str(&format!(
            "recondo_recovery_orphans_found_total {}\n",
            self.recovery_orphans_found_total.load(Ordering::Relaxed)
        ));
        out.push('\n');

        out.push_str(
            "# HELP recondo_recovery_recovered_total Total orphans successfully replayed across recovery runs\n",
        );
        out.push_str("# TYPE recondo_recovery_recovered_total counter\n");
        out.push_str(&format!(
            "recondo_recovery_recovered_total {}\n",
            self.recovery_recovered_total.load(Ordering::Relaxed)
        ));
        out.push('\n');

        out.push_str(
            "# HELP recondo_recovery_failures_total Per-reason orphan-recovery failures\n",
        );
        out.push_str("# TYPE recondo_recovery_failures_total counter\n");
        out.push_str(&format!(
            "recondo_recovery_failures_total{{reason=\"parse\"}} {}\n",
            self.recovery_failures_parse.load(Ordering::Relaxed)
        ));
        out.push_str(&format!(
            "recondo_recovery_failures_total{{reason=\"verify\"}} {}\n",
            self.recovery_failures_verify.load(Ordering::Relaxed)
        ));
        out.push_str(&format!(
            "recondo_recovery_failures_total{{reason=\"insert\"}} {}\n",
            self.recovery_failures_insert.load(Ordering::Relaxed)
        ));
        out.push_str(&format!(
            "recondo_recovery_failures_total{{reason=\"transient\"}} {}\n",
            self.recovery_failures_transient.load(Ordering::Relaxed)
        ));
        out.push_str(&format!(
            "recondo_recovery_failures_total{{reason=\"validation\"}} {}\n",
            self.recovery_failures_validation.load(Ordering::Relaxed)
        ));
        out.push_str(&format!(
            "recondo_recovery_failures_total{{reason=\"other\"}} {}\n",
            self.recovery_failures_other.load(Ordering::Relaxed)
        ));
        out.push('\n');

        // FIND-3-RUST-7: Attachment DLQ counter, labelled by reason.
        out.push_str(
            "# HELP recondo_attachment_dlq_total Attachment bundles dead-lettered, by reason\n",
        );
        out.push_str("# TYPE recondo_attachment_dlq_total counter\n");
        out.push_str(&format!(
            "recondo_attachment_dlq_total{{reason=\"attachment_bundle\"}} {}\n",
            self.attachment_dlq_attachment_bundle
                .load(Ordering::Relaxed)
        ));
        out.push_str(&format!(
            "recondo_attachment_dlq_total{{reason=\"count_drift\"}} {}\n",
            self.attachment_dlq_count_drift.load(Ordering::Relaxed)
        ));
        out.push('\n');

        // Audit fix: per-component non-fatal sub-pipeline failure
        // counter. Each `warn!(... non-fatal ...)` site in
        // `process_capture_with_pipeline` (and friends) increments
        // one of these labels so operators can alert on sustained
        // sub-step failures (the kind that caused the
        // jsonb-bind-on-anomaly_events bug to fire silently for
        // ages).
        out.push_str(
            "# HELP recondo_subpipeline_failures_total Non-fatal sub-pipeline failures by component\n",
        );
        out.push_str("# TYPE recondo_subpipeline_failures_total counter\n");
        for (label, atomic) in [
            (
                "drift_detection",
                &self.subpipeline_failures_drift_detection,
            ),
            (
                "tool_drift_detection",
                &self.subpipeline_failures_tool_drift_detection,
            ),
            ("session_totals", &self.subpipeline_failures_session_totals),
            (
                "session_backfill_framework",
                &self.subpipeline_failures_session_backfill_framework,
            ),
            (
                "session_backfill_initial_intent",
                &self.subpipeline_failures_session_backfill_initial_intent,
            ),
            (
                "session_backfill_model",
                &self.subpipeline_failures_session_backfill_model,
            ),
            (
                "supersedes_resolution",
                &self.subpipeline_failures_supersedes_resolution,
            ),
            ("wal_flush_mark", &self.subpipeline_failures_wal_flush_mark),
            ("wal_append", &self.subpipeline_failures_wal_append),
            ("messages_delta", &self.subpipeline_failures_messages_delta),
            (
                "attachment_extract",
                &self.subpipeline_failures_attachment_extract,
            ),
            (
                "attachment_rehost",
                &self.subpipeline_failures_attachment_rehost,
            ),
            ("other", &self.subpipeline_failures_other),
        ] {
            out.push_str(&format!(
                "recondo_subpipeline_failures_total{{component=\"{}\"}} {}\n",
                label,
                atomic.load(Ordering::Relaxed)
            ));
        }
        out.push('\n');

        // Histogram
        self.capture_latency.render(
            "recondo_capture_latency_seconds",
            "Capture latency in seconds",
            &mut out,
        );

        out
    }

    /// Returns the Prometheus text exposition content type.
    pub fn content_type(&self) -> &'static str {
        "text/plain; version=0.0.4; charset=utf-8"
    }
}

impl Default for MetricsRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Free functions for recording metrics
// ---------------------------------------------------------------------------

/// Record a successful capture with its latency and byte count.
pub fn record_capture(registry: &MetricsRegistry, latency: Duration, bytes: u64) {
    registry.captures_total.fetch_add(1, Ordering::Relaxed);
    registry
        .bytes_processed_total
        .fetch_add(bytes, Ordering::Relaxed);
    registry.capture_latency.observe(latency.as_secs_f64());
}

/// Record a capture error.
pub fn record_error(registry: &MetricsRegistry) {
    registry
        .capture_errors_total
        .fetch_add(1, Ordering::Relaxed);
}

/// Set the active tunnels gauge (replaces the current value).
pub fn set_active_tunnels(registry: &MetricsRegistry, n: u64) {
    registry.active_tunnels.store(n, Ordering::Relaxed);
}

/// Increment the active tunnels gauge by 1 (connection started).
pub fn increment_active_tunnels(registry: &MetricsRegistry) {
    registry.active_tunnels.fetch_add(1, Ordering::Relaxed);
}

/// Decrement the active tunnels gauge by 1 (connection ended).
/// Saturates at zero to avoid underflow.
pub fn decrement_active_tunnels(registry: &MetricsRegistry) {
    let _ = registry
        .active_tunnels
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            if current == 0 {
                Some(0)
            } else {
                Some(current - 1)
            }
        });
}

/// Set the active DB pool connections gauge (replaces the current value).
pub fn set_db_pool_active(registry: &MetricsRegistry, n: u64) {
    registry.db_pool_active.store(n, Ordering::Relaxed);
}

/// Render metrics from the registry (convenience wrapper).
pub fn render_metrics(registry: &MetricsRegistry) -> String {
    registry.render()
}
