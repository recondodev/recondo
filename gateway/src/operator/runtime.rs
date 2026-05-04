//! Operator runtime — async heartbeat and metrics loops.
//!
//! The `OperatorRuntime` spawns two independent tokio tasks: one for sending
//! heartbeat payloads at the configured interval, and one for sending metrics
//! payloads. Both loops are resilient to control plane failures: errors are
//! logged and the loop continues on the next interval.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::config::OperatorSection;
use crate::metrics::MetricsRegistry;
use crate::operator::{HeartbeatPayload, MetricsPayload};

// ---------------------------------------------------------------------------
// ControlPlaneClient trait
// ---------------------------------------------------------------------------

/// Trait for sending payloads to the Recondo control plane.
///
/// Implemented by a real HTTP client in production and by a mock in tests.
/// Uses `Send + Sync` bounds so it can be shared across tokio tasks.
pub trait ControlPlaneClient: Send + Sync + 'static {
    /// Send a heartbeat payload to the control plane.
    fn send_heartbeat(&self, payload: HeartbeatPayload) -> Result<(), Box<dyn std::error::Error>>;
    /// Send a metrics payload to the control plane.
    fn send_metrics(&self, payload: MetricsPayload) -> Result<(), Box<dyn std::error::Error>>;
}

// ---------------------------------------------------------------------------
// LoggingControlPlaneClient
// ---------------------------------------------------------------------------

/// A control plane client that logs payloads instead of sending them over HTTP.
///
/// Used when no real control plane endpoint is available (e.g., local dev,
/// initial operator wiring before HTTP client is implemented).
pub struct LoggingControlPlaneClient {
    control_plane_url: String,
}

impl LoggingControlPlaneClient {
    /// Create a new logging client that will log payloads destined for the
    /// given control plane URL.
    pub fn new(control_plane_url: String) -> Self {
        LoggingControlPlaneClient { control_plane_url }
    }
}

impl ControlPlaneClient for LoggingControlPlaneClient {
    fn send_heartbeat(&self, payload: HeartbeatPayload) -> Result<(), Box<dyn std::error::Error>> {
        tracing::info!(
            url = %self.control_plane_url,
            version = %payload.gateway_version,
            uptime = payload.uptime_seconds,
            "Heartbeat (logging client)"
        );
        Ok(())
    }

    fn send_metrics(&self, payload: MetricsPayload) -> Result<(), Box<dyn std::error::Error>> {
        tracing::info!(
            url = %self.control_plane_url,
            decision_count = payload.decision_count,
            total_tokens = payload.total_tokens,
            error_count = payload.error_count,
            "Metrics (logging client)"
        );
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// OperatorRuntime
// ---------------------------------------------------------------------------

/// Operator runtime that manages the heartbeat and metrics reporting loops.
///
/// Created with `OperatorRuntime::new(config, client)`, then started with
/// `.start()` which returns an `OperatorHandle` for lifecycle management.
pub struct OperatorRuntime<C: ControlPlaneClient> {
    config: OperatorSection,
    client: Arc<C>,
    started: Instant,
    /// M1 fix: Optional metrics registry for reading real gateway metrics.
    /// When None (operator not co-located with gateway), zeros are sent with a log.
    metrics_registry: Option<Arc<MetricsRegistry>>,
}

impl<C: ControlPlaneClient> OperatorRuntime<C> {
    /// Create a new operator runtime.
    ///
    /// # Panics
    ///
    /// Panics if `heartbeat_interval` or `metrics_interval` is zero.
    pub fn new(config: OperatorSection, client: C) -> Self {
        assert!(
            config.heartbeat_interval > 0,
            "heartbeat_interval must be > 0"
        );
        assert!(config.metrics_interval > 0, "metrics_interval must be > 0");
        OperatorRuntime {
            config,
            client: Arc::new(client),
            started: Instant::now(),
            metrics_registry: None,
        }
    }

    /// M1 fix: Attach a MetricsRegistry so the metrics loop reads real values.
    pub fn with_metrics_registry(mut self, registry: Arc<MetricsRegistry>) -> Self {
        self.metrics_registry = Some(registry);
        self
    }

    /// Returns `false` before `.start()` is called.
    pub fn is_running(&self) -> bool {
        false
    }

    /// Start the heartbeat and metrics loops. Returns an `OperatorHandle`
    /// that can be used to stop the runtime.
    pub fn start(self) -> OperatorHandle {
        let running = Arc::new(AtomicBool::new(true));
        let client = self.client;
        let heartbeat_interval = Duration::from_secs(self.config.heartbeat_interval);
        let metrics_interval = Duration::from_secs(self.config.metrics_interval);
        let started = self.started;

        let running_hb = Arc::clone(&running);
        let client_hb = Arc::clone(&client);
        let hb_handle = tokio::spawn(async move {
            while running_hb.load(Ordering::SeqCst) {
                tokio::time::sleep(heartbeat_interval).await;
                if !running_hb.load(Ordering::SeqCst) {
                    break;
                }
                let uptime = started.elapsed().as_secs();
                let payload = HeartbeatPayload {
                    gateway_version: env!("CARGO_PKG_VERSION").to_string(),
                    uptime_seconds: uptime,
                    component_health: HashMap::new(),
                };
                if let Err(e) = client_hb.send_heartbeat(payload) {
                    tracing::warn!("Failed to send heartbeat: {}", e);
                }
            }
        });

        let running_m = Arc::clone(&running);
        let client_m = Arc::clone(&client);
        // M1 fix: Clone the optional metrics registry into the metrics task.
        let registry_m = self.metrics_registry.clone();
        let m_handle = tokio::spawn(async move {
            while running_m.load(Ordering::SeqCst) {
                tokio::time::sleep(metrics_interval).await;
                if !running_m.load(Ordering::SeqCst) {
                    break;
                }
                // M1 fix: Read real values from MetricsRegistry when available.
                let payload = if let Some(ref reg) = registry_m {
                    let rendered = reg.render();
                    // Parse captures_total and capture_errors_total from rendered output.
                    let decision_count =
                        parse_prometheus_counter(&rendered, "recondo_captures_total");
                    let error_count =
                        parse_prometheus_counter(&rendered, "recondo_capture_errors_total");
                    let total_tokens =
                        parse_prometheus_counter(&rendered, "recondo_bytes_processed_total");
                    MetricsPayload {
                        decision_count,
                        total_tokens,
                        latency_p50_ms: 0.0,
                        latency_p95_ms: 0.0,
                        latency_p99_ms: 0.0,
                        error_count,
                    }
                } else {
                    tracing::debug!("No MetricsRegistry attached — sending zero metrics");
                    MetricsPayload {
                        decision_count: 0,
                        total_tokens: 0,
                        latency_p50_ms: 0.0,
                        latency_p95_ms: 0.0,
                        latency_p99_ms: 0.0,
                        error_count: 0,
                    }
                };
                if let Err(e) = client_m.send_metrics(payload) {
                    tracing::warn!("Failed to send metrics: {}", e);
                }
            }
        });

        OperatorHandle {
            running,
            hb_handle: Arc::new(tokio::sync::Mutex::new(Some(hb_handle))),
            m_handle: Arc::new(tokio::sync::Mutex::new(Some(m_handle))),
        }
    }
}

// ---------------------------------------------------------------------------
// OperatorHandle
// ---------------------------------------------------------------------------

/// Handle for a running operator runtime. Used to check status and stop
/// the runtime gracefully.
#[derive(Clone)]
pub struct OperatorHandle {
    running: Arc<AtomicBool>,
    hb_handle: Arc<tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>>,
    m_handle: Arc<tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl OperatorHandle {
    /// Returns `true` if the runtime is still running.
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Stop the runtime gracefully. Idempotent — calling multiple times is safe.
    pub async fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);

        // Abort and join the heartbeat task
        let mut hb_guard = self.hb_handle.lock().await;
        if let Some(handle) = hb_guard.take() {
            handle.abort();
            let _ = handle.await;
        }

        // Abort and join the metrics task
        let mut m_guard = self.m_handle.lock().await;
        if let Some(handle) = m_guard.take() {
            handle.abort();
            let _ = handle.await;
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Parse a counter value from Prometheus text exposition format.
/// Looks for a line like `metric_name 12345` (ignoring # lines).
fn parse_prometheus_counter(rendered: &str, metric_name: &str) -> u64 {
    for line in rendered.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            continue;
        }
        // Match exact metric name (no labels like _bucket{le=...})
        if let Some(rest) = trimmed.strip_prefix(metric_name) {
            // Ensure the next char is whitespace (not "_bucket" etc.)
            if let Some(value_str) = rest.strip_prefix(' ') {
                if let Ok(v) = value_str.trim().parse::<u64>() {
                    return v;
                }
            }
        }
    }
    0
}
