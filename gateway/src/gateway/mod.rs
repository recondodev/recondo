//! HTTPS CONNECT gateway module.
//!
//! Provides the core gateway functionality: listening for CONNECT requests,
//! performing TLS MITM for known LLM provider hosts, and forwarding traffic
//! with optional request/response interception.
//!
//! ## Capture scope
//!
//! Headers and body are captured **including API keys** in the request headers.
//! This is intentional for compliance audit trail (SOC 2, ISO 42001). The
//! object store at `~/.recondo/objects/` should have restricted filesystem
//! permissions (owner-only), which is already the case via the CA directory
//! permission pattern.

use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Sub-modules — Batch 6 H2 split.
// ---------------------------------------------------------------------------

pub mod capture_pipeline;
pub mod connect;
pub mod crypto;
pub mod intercept;
pub mod run_listener;
pub mod trace;

// Re-exports preserving the pre-split `recondo_gateway::gateway::*` API.
pub use capture_pipeline::CaptureError;
pub use capture_pipeline::{parse_capture_data, process_capture_with_pipeline, ParsedFields};
pub use connect::{
    build_server_config, build_server_config_with_cache, classify_host, detect_connection_mode,
    extract_sni_hostname, parse_connect_request, ConnectRequest, ConnectionMode, TunnelMode,
};
pub use intercept::{should_intercept, InterceptDecision};
pub use run_listener::{
    connect_response, extract_http_body, load_extra_ca_certs, parse_content_length, run_listener,
    run_startup_recovery, start_gateway, CONNECT_RESPONSE,
};

// `pub(crate)` helpers used by `capture/recovery.rs` (cross-module via
// `crate::gateway::*`). Their public path is preserved by this re-export.
pub(crate) use capture_pipeline::{estimate_thinking_tokens, extract_org_id};

#[cfg(any(test, feature = "test-support"))]
pub use run_listener::STARTUP_RECOVERY_INVOCATIONS;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Gateway configuration.
#[derive(Debug, Clone)]
pub struct GatewayConfig {
    /// TCP port to listen on (default: 8443).
    port: u16,
    /// Bind address for the TCP listener (default: "0.0.0.0").
    /// Set via `recondo.toml` `[gateway] listen` field or defaults.
    bind_addr: String,
    /// Path to the Recondo data directory (~/.recondo).
    data_dir: PathBuf,
    /// Path to the WAL directory. Defaults to `{data_dir}/wal`.
    wal_dir: PathBuf,
    /// Enable live trace output to stderr (--trace flag).
    trace: bool,
    /// Failure mode for the WAL / capture pipeline.
    /// B1 fix: Propagated from config::FailMode through to wal::FailMode.
    fail_mode: crate::wal::FailMode,
}

/// Global trace flag, set once at startup.
pub(super) static TRACE_ENABLED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Check if live trace output is enabled.
pub fn trace_enabled() -> bool {
    TRACE_ENABLED.load(std::sync::atomic::Ordering::Relaxed)
}

impl GatewayConfig {
    /// Create a new GatewayConfig with the given port and data directory.
    /// The WAL directory defaults to `{data_dir}/wal`.
    /// The bind address defaults to `0.0.0.0` (reachable in containers).
    pub fn new(port: u16, data_dir: PathBuf) -> Self {
        let wal_dir = data_dir.join("wal");
        GatewayConfig {
            port,
            bind_addr: "0.0.0.0".to_string(),
            data_dir,
            wal_dir,
            trace: false,
            fail_mode: crate::wal::FailMode::Open,
        }
    }

    /// Enable live trace output.
    pub fn with_trace(mut self, trace: bool) -> Self {
        self.trace = trace;
        self
    }

    /// Set the bind address (e.g., "127.0.0.1" or "0.0.0.0").
    pub fn with_bind_addr(mut self, addr: String) -> Self {
        self.bind_addr = addr;
        self
    }

    /// Returns the configured port.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Returns the configured bind address.
    pub fn bind_addr(&self) -> &str {
        &self.bind_addr
    }

    /// Returns the configured data directory.
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Returns the configured WAL directory.
    pub fn wal_dir(&self) -> &Path {
        &self.wal_dir
    }

    /// Set the WAL / capture pipeline failure mode.
    /// B1 fix: Allows config::FailMode to propagate to wal::FailMode.
    pub fn with_fail_mode(mut self, mode: crate::wal::FailMode) -> Self {
        self.fail_mode = mode;
        self
    }

    /// Returns the configured failure mode for the WAL.
    pub fn fail_mode(&self) -> crate::wal::FailMode {
        self.fail_mode
    }
}

// NOTE: Default impl was removed intentionally to avoid panicking when HOME is
// not set (e.g., in minimal container images or sandboxed environments).
// Use GatewayConfig::new() with an explicit data_dir instead.

// ---------------------------------------------------------------------------
// Graceful shutdown controller
// ---------------------------------------------------------------------------

/// Thread-safe controller for graceful gateway shutdown.
///
/// Tracks the shutdown signal state and the number of in-flight connections
/// so the gateway can drain active work before exiting.
///
/// Uses `Arc<Inner>` internally so clones share state (cheap to clone,
/// safe to send across async tasks).
#[derive(Clone)]
pub struct ShutdownController {
    inner: std::sync::Arc<ShutdownInner>,
}

struct ShutdownInner {
    /// Whether a shutdown signal has been received.
    shutting_down: std::sync::atomic::AtomicBool,
    /// Number of currently active (in-flight) connections.
    active_count: std::sync::atomic::AtomicUsize,
}

impl ShutdownController {
    /// Create a new controller in the not-shutting-down state with zero active
    /// connections.
    pub fn new() -> Self {
        ShutdownController {
            inner: std::sync::Arc::new(ShutdownInner {
                shutting_down: std::sync::atomic::AtomicBool::new(false),
                active_count: std::sync::atomic::AtomicUsize::new(0),
            }),
        }
    }

    /// Signal that the gateway should begin shutting down.
    ///
    /// Calling this multiple times is safe and idempotent.
    pub fn signal(&self) {
        self.inner
            .shutting_down
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// Returns `true` if `signal()` has been called.
    pub fn is_shutting_down(&self) -> bool {
        self.inner
            .shutting_down
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Register an in-flight connection (increment active count).
    pub fn register_active(&self) {
        self.inner
            .active_count
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    /// Deregister an in-flight connection (decrement active count).
    ///
    /// Safe to call even if the count is already zero (saturates at zero).
    pub fn deregister_active(&self) {
        // Use fetch_update to avoid underflow
        let _ = self.inner.active_count.fetch_update(
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
            |current| {
                if current == 0 {
                    Some(0) // already zero, no change
                } else {
                    Some(current - 1)
                }
            },
        );
    }

    /// Returns the number of currently active in-flight connections.
    pub fn active_count(&self) -> usize {
        self.inner
            .active_count
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Wait for all active connections to drain, up to the given timeout.
    ///
    /// Returns `Ok(())` if all connections drained before the timeout, or
    /// `Err(...)` if the timeout elapsed with connections still active.
    pub async fn wait_for_drain(
        &self,
        timeout: std::time::Duration,
    ) -> std::result::Result<(), String> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if self.active_count() == 0 {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(format!(
                    "drain timeout: {} connections still active after {:?}",
                    self.active_count(),
                    timeout
                ));
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    /// Returns the default drain timeout (120 seconds per OD-023).
    pub fn default_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(120)
    }
}

impl Default for ShutdownController {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// FIND-6-E: External-URL budget env accessors (read once at startup)
// ---------------------------------------------------------------------------

/// FIND-6-E: Parse a positive integer from an environment variable,
/// returning `default` when the var is unset, empty, or malformed.
/// Extracted as a testable helper so the env-var semantics can be
/// exercised without spawning a new process.
///
/// Returned value is the CAPPED default when parsing fails — this
/// matches what operators have historically reported: a typo in the
/// env should not crash the gateway, nor silently use zero.
pub fn parse_url_budget_env<T>(key: &str, default: T) -> T
where
    T: std::str::FromStr,
{
    match std::env::var(key) {
        Ok(s) => s.parse::<T>().unwrap_or(default),
        Err(_) => default,
    }
}

/// FIND-6-E: Per-process-cached max URLs per turn. First access
/// reads `RECONDO_MAX_EXTERNAL_URLS_PER_TURN` via one syscall; all
/// subsequent accesses are a pointer read. A process restart is
/// required to change the value.
pub(super) fn external_url_max_per_turn() -> usize {
    static CACHE: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *CACHE.get_or_init(|| parse_url_budget_env("RECONDO_MAX_EXTERNAL_URLS_PER_TURN", 3usize))
}

/// FIND-6-E: Per-process-cached aggregate budget in milliseconds.
/// Operator contract: read once at startup; process restart required
/// to change.
pub(super) fn external_url_budget_ms() -> u64 {
    static CACHE: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *CACHE.get_or_init(|| parse_url_budget_env("RECONDO_EXTERNAL_URL_BUDGET_MS", 4000u64))
}

/// FIND-6-J + FIND-7-B: Drive a Future to completion from a sync
/// context. Returns `Some(value)` when the future ran; returns `None`
/// when the helper detected it cannot safely drive the future and
/// the caller must apply a skip-semantics fallback.
///
/// # Why Option, not T
///
/// Tokio explicitly forbids `Handle::block_on` from a thread already
/// running inside that runtime: "Cannot start a runtime from within a
/// runtime." The prior FIND-6-J fix tried to call `handle.block_on`
/// on current_thread anyway, and that's the panic FIND-7-B caught.
///
/// The work IS async (e.g. an HTTP fetch), so we can't fall back to
/// a sync alternative the way `block_on_sleep` falls back to
/// `std::thread::sleep`. The honest answer is to skip and let the
/// caller record a "fetch deferred" sentinel.
///
/// # Behaviour
///
/// - multi_thread runtime: `block_in_place` hands the current worker
///   off to a blocking thread before `block_on` drives the future.
///   Other async tasks continue to make progress. Returns
///   `Some(future.await)`.
/// - current_thread runtime: returns `None` (skip). Caller MUST
///   handle the skip path with a documented fallback (e.g. record
///   a sentinel attachment, return an empty result, etc.).
/// - outside any runtime: caller's responsibility; this helper
///   requires a `Handle` to block on. Pre-call check via
///   `Handle::try_current()` is the caller's job.
///
/// # Production safety
///
/// The gateway runs on a multi_thread runtime in production. The
/// current_thread skip path fires only in `#[tokio::test]` (which
/// defaults to current_thread) and in tests that explicitly opt
/// into the single-threaded runtime. Test code that needs to drive
/// the future should either use `#[tokio::test(flavor = "multi_thread")]`
/// or wrap the call in `tokio::task::spawn_blocking`.
pub(super) fn block_on_future<F, T>(handle: &tokio::runtime::Handle, future: F) -> Option<T>
where
    F: std::future::Future<Output = T>,
{
    if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread {
        Some(tokio::task::block_in_place(|| handle.block_on(future)))
    } else {
        // current_thread runtime: `Handle::block_on` from inside a
        // running runtime is forbidden. Skip — caller handles None.
        None
    }
}

// ---------------------------------------------------------------------------
// Batch 12: test-support exposure of the codex turn-capture helpers
// ---------------------------------------------------------------------------

/// **Test-only public wrapper around `capture_codex_accumulated_turn`.**
///
/// Visible only with `feature = "test-support"` — production builds keep
/// the function private. Lets `gateway/tests/batch12_codex_attachment_tests.rs`
/// drive the codex capture path end-to-end against a real `WritePipeline`
/// and assert that attachments persist in the graph + object store.
#[cfg(feature = "test-support")]
pub struct TestCodexCaptureArgs<'a> {
    pub pipeline: &'a crate::storage::pipeline::WritePipeline,
    pub ws_session_id: &'a str,
    pub sequence_num: i64,
    pub provider: &'a str,
    pub peer_addr: std::net::SocketAddr,
    pub host: &'a str,
    pub session_model: &'a Option<String>,
    pub session_created: &'a mut bool,
    pub turn_data: &'a crate::providers::codex::CodexTurnData,
    pub estimated_input_tokens: i64,
    pub initial_request: Option<&'a crate::providers::codex::CodexRequestData>,
    pub latest_request: Option<&'a crate::providers::codex::CodexRequestData>,
}

#[cfg(feature = "test-support")]
pub fn test_capture_codex_accumulated_turn(args: TestCodexCaptureArgs<'_>) {
    let TestCodexCaptureArgs {
        pipeline,
        ws_session_id,
        sequence_num,
        provider,
        peer_addr,
        host,
        session_model,
        session_created,
        turn_data,
        estimated_input_tokens,
        initial_request,
        latest_request,
    } = args;
    let mut ctx = run_listener::CodexCaptureContext {
        pipeline,
        ws_session_id,
        sequence_num,
        provider,
        peer_addr,
        host,
        openai_metadata: None,
        session_model,
        session_created,
    };
    run_listener::capture_codex_accumulated_turn(
        &mut ctx,
        turn_data,
        estimated_input_tokens,
        initial_request,
        latest_request,
        None,
        None,
    );
}
