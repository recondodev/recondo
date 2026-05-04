//! Phase 2 Sprint 5 Batch 1: Prometheus /metrics, Graceful Shutdown,
//! `recondo status` CLI, Operator Runtime (heartbeat/metrics loop).
//!
//! EVERY test in this file imports from modules that DO NOT EXIST yet:
//!
//! - `recondo_gateway::metrics` (new module: MetricsRegistry, Prometheus text rendering)
//! - `recondo_gateway::gateway::ShutdownController` (new: graceful drain on SIGTERM)
//! - `recondo_gateway::status` (new module: StatusInfo, collect_status)
//! - `recondo_gateway::operator::runtime` (new submodule: OperatorRuntime, ControlPlaneClient)
//!
//! This file MUST NOT compile until the implementation agent creates these modules.
//! Each test imports production types/functions that do not exist yet.
//! The implementation agent must create them to make these tests pass.

#![allow(
    dead_code,
    unused_imports,
    clippy::single_match,
    clippy::double_ended_iterator_last,
    clippy::unnecessary_map_or
)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// Existing types that DO compile today
use recondo_gateway::config::{parse_recondo_toml, OperatorSection};
use recondo_gateway::db;
use recondo_gateway::operator::{HeartbeatPayload, MetricsPayload, OperatorConfig};

// ---- These imports WILL NOT RESOLVE until the new modules are created ----

// D1: Prometheus /metrics endpoint — registry and rendering
use recondo_gateway::metrics::{
    record_capture, record_error, render_metrics, set_active_tunnels, set_db_pool_active,
    MetricsRegistry,
};

// D2: Graceful shutdown — controller for draining in-flight connections
use recondo_gateway::gateway::ShutdownController;

// D3: recondo status CLI — status collection and display
use recondo_gateway::status::{collect_status, StatusInfo};

// D4: Operator runtime — async loop with heartbeat/metrics dispatch
use recondo_gateway::operator::runtime::{ControlPlaneClient, OperatorRuntime};

// ===========================================================================
// D1: Prometheus /metrics endpoint
// ===========================================================================
//
// Per OD-026 Gap 1: serve Prometheus text exposition format on port 8443.
// Required metrics:
//   - recondo_active_tunnels (gauge)
//   - recondo_captures_total (counter)
//   - recondo_capture_latency_seconds (histogram)
//   - recondo_capture_errors_total (counter)
//   - recondo_bytes_processed_total (counter)
//   - recondo_db_pool_active (gauge)
// Response Content-Type: text/plain; version=0.0.4; charset=utf-8

/// MetricsRegistry::new() creates a fresh registry with zero-valued metrics.
#[test]
fn d1_metrics_registry_starts_at_zero() {
    let registry = MetricsRegistry::new();
    let output = registry.render();
    // All counters and gauges must be present and zero
    assert!(
        output.contains("recondo_active_tunnels 0"),
        "active_tunnels must start at 0"
    );
    assert!(
        output.contains("recondo_captures_total 0"),
        "captures_total must start at 0"
    );
    assert!(
        output.contains("recondo_capture_errors_total 0"),
        "capture_errors_total must start at 0"
    );
    assert!(
        output.contains("recondo_bytes_processed_total 0"),
        "bytes_processed_total must start at 0"
    );
    assert!(
        output.contains("recondo_db_pool_active 0"),
        "db_pool_active must start at 0"
    );
}

/// render_metrics returns valid Prometheus text exposition format with TYPE
/// and HELP lines for every metric.
#[test]
fn d1_render_metrics_includes_type_and_help_lines() {
    let registry = MetricsRegistry::new();
    let output = registry.render();

    // Every metric must have a TYPE line
    assert!(output.contains("# TYPE recondo_active_tunnels gauge"));
    assert!(output.contains("# TYPE recondo_captures_total counter"));
    assert!(output.contains("# TYPE recondo_capture_latency_seconds histogram"));
    assert!(output.contains("# TYPE recondo_capture_errors_total counter"));
    assert!(output.contains("# TYPE recondo_bytes_processed_total counter"));
    assert!(output.contains("# TYPE recondo_db_pool_active gauge"));

    // Every metric must have a HELP line
    assert!(output.contains("# HELP recondo_active_tunnels"));
    assert!(output.contains("# HELP recondo_captures_total"));
    assert!(output.contains("# HELP recondo_capture_latency_seconds"));
    assert!(output.contains("# HELP recondo_capture_errors_total"));
    assert!(output.contains("# HELP recondo_bytes_processed_total"));
    assert!(output.contains("# HELP recondo_db_pool_active"));
}

/// render_metrics output content type must be Prometheus text exposition format.
#[test]
fn d1_render_metrics_content_type() {
    // The content type for Prometheus text exposition format is well-defined.
    // The implementation must use this exact string when serving /metrics.
    let expected_content_type = "text/plain; version=0.0.4; charset=utf-8";
    let registry = MetricsRegistry::new();
    assert_eq!(registry.content_type(), expected_content_type);
}

/// record_capture increments the captures_total counter and records latency.
#[test]
fn d1_record_capture_increments_counter_and_records_latency() {
    let registry = MetricsRegistry::new();
    record_capture(&registry, Duration::from_millis(150), 4096);
    record_capture(&registry, Duration::from_millis(200), 8192);

    let output = registry.render();
    // captures_total should be 2 after two recordings
    assert!(
        output.contains("recondo_captures_total 2"),
        "captures_total should be 2 after two record_capture calls, got:\n{}",
        output
    );
    // bytes_processed_total should be 4096 + 8192 = 12288
    assert!(
        output.contains("recondo_bytes_processed_total 12288"),
        "bytes_processed_total should be 12288, got:\n{}",
        output
    );
}

/// record_error increments the capture_errors_total counter.
#[test]
fn d1_record_error_increments_error_counter() {
    let registry = MetricsRegistry::new();
    record_error(&registry);
    record_error(&registry);
    record_error(&registry);

    let output = registry.render();
    assert!(
        output.contains("recondo_capture_errors_total 3"),
        "capture_errors_total should be 3 after three record_error calls, got:\n{}",
        output
    );
}

/// set_active_tunnels sets the gauge value (not additive — replaces).
#[test]
fn d1_set_active_tunnels_sets_gauge() {
    let registry = MetricsRegistry::new();
    set_active_tunnels(&registry, 42);

    let output = registry.render();
    assert!(
        output.contains("recondo_active_tunnels 42"),
        "active_tunnels should be 42, got:\n{}",
        output
    );

    // Setting again replaces — not additive
    set_active_tunnels(&registry, 10);
    let output = registry.render();
    assert!(
        output.contains("recondo_active_tunnels 10"),
        "active_tunnels should be 10 after re-set, got:\n{}",
        output
    );
}

/// set_db_pool_active sets the gauge value.
#[test]
fn d1_set_db_pool_active_sets_gauge() {
    let registry = MetricsRegistry::new();
    set_db_pool_active(&registry, 5);

    let output = registry.render();
    assert!(
        output.contains("recondo_db_pool_active 5"),
        "db_pool_active should be 5, got:\n{}",
        output
    );
}

/// Histogram must include _bucket, _sum, and _count lines.
#[test]
fn d1_capture_latency_histogram_has_bucket_sum_count() {
    let registry = MetricsRegistry::new();
    record_capture(&registry, Duration::from_millis(50), 1024);
    record_capture(&registry, Duration::from_secs(2), 2048);

    let output = registry.render();
    // Prometheus histograms require _bucket, _sum, and _count
    assert!(
        output.contains("recondo_capture_latency_seconds_bucket{"),
        "histogram must have _bucket lines, got:\n{}",
        output
    );
    assert!(
        output.contains("recondo_capture_latency_seconds_sum"),
        "histogram must have _sum line, got:\n{}",
        output
    );
    assert!(
        output.contains("recondo_capture_latency_seconds_count 2"),
        "histogram _count should be 2 after two observations, got:\n{}",
        output
    );
}

/// E2E: Full lifecycle — record various events, render, parse output.
#[test]
fn d1_e2e_full_metrics_lifecycle() {
    let registry = MetricsRegistry::new();

    // Simulate gateway activity
    set_active_tunnels(&registry, 3);
    set_db_pool_active(&registry, 2);
    record_capture(&registry, Duration::from_millis(100), 5000);
    record_capture(&registry, Duration::from_millis(250), 10000);
    record_capture(&registry, Duration::from_millis(500), 20000);
    record_error(&registry);

    let output = registry.render();

    // Verify the output is non-empty and well-formed
    assert!(!output.is_empty());

    // Each line must be either empty, a comment (# ...), or a metric line (name value)
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let valid = trimmed.starts_with('#')
            || trimmed.contains(' ')  // metric lines have "name value" or "name{labels} value"
            ;
        assert!(
            valid,
            "Line is not valid Prometheus text format: '{}'",
            trimmed
        );
    }

    // Check aggregate values
    assert!(output.contains("recondo_active_tunnels 3"));
    assert!(output.contains("recondo_db_pool_active 2"));
    assert!(output.contains("recondo_captures_total 3"));
    assert!(output.contains("recondo_bytes_processed_total 35000"));
    assert!(output.contains("recondo_capture_errors_total 1"));
    assert!(output.contains("recondo_capture_latency_seconds_count 3"));
}

/// Negative: /metrics with no recorded events returns valid format with zeros.
/// This is the "cold start" scenario — gateway just started, nothing happened yet.
#[test]
fn d1_negative_no_events_returns_valid_zero_metrics() {
    let registry = MetricsRegistry::new();
    let output = registry.render();

    // Output must not be empty — zero-valued metrics are still rendered
    assert!(
        !output.is_empty(),
        "render_metrics must return non-empty output even with no events"
    );

    // Must contain TYPE lines (structural validity)
    assert!(
        output.contains("# TYPE"),
        "output must contain TYPE annotations even at zero"
    );

    // All counters and gauges at zero
    assert!(output.contains("recondo_captures_total 0"));
    assert!(output.contains("recondo_capture_errors_total 0"));
    assert!(output.contains("recondo_bytes_processed_total 0"));
    assert!(output.contains("recondo_active_tunnels 0"));
    assert!(output.contains("recondo_db_pool_active 0"));

    // Histogram with zero observations
    assert!(output.contains("recondo_capture_latency_seconds_count 0"));
    assert!(output.contains("recondo_capture_latency_seconds_sum 0"));
}

/// Negative: MetricsRegistry is thread-safe — concurrent writes don't panic.
#[test]
fn d1_negative_concurrent_writes_do_not_panic() {
    let registry = Arc::new(MetricsRegistry::new());
    let mut handles = vec![];

    for _ in 0..10 {
        let r = Arc::clone(&registry);
        handles.push(std::thread::spawn(move || {
            for _ in 0..100 {
                record_capture(&r, Duration::from_millis(10), 512);
                record_error(&r);
                set_active_tunnels(&r, 5);
                set_db_pool_active(&r, 2);
            }
        }));
    }

    for h in handles {
        h.join().expect("thread must not panic");
    }

    let output = registry.render();
    // 10 threads x 100 iterations = 1000 captures
    assert!(
        output.contains("recondo_captures_total 1000"),
        "expected 1000 captures from concurrent writes, got:\n{}",
        output
    );
    // 10 threads x 100 iterations = 1000 errors
    assert!(
        output.contains("recondo_capture_errors_total 1000"),
        "expected 1000 errors from concurrent writes, got:\n{}",
        output
    );
}

// ===========================================================================
// D2: Graceful shutdown
// ===========================================================================
//
// Per OD-023 Gap 3: On SIGTERM, stop accepting new connections, drain in-flight
// SSE streams with configurable timeout (default 120s), write capture_complete:
// false for any still-in-progress captures on timeout.

/// ShutdownController starts in not-shutting-down state.
#[test]
fn d2_shutdown_controller_starts_not_shutting_down() {
    let controller = ShutdownController::new();
    assert!(
        !controller.is_shutting_down(),
        "new ShutdownController must not be in shutting-down state"
    );
}

/// After signal(), is_shutting_down() returns true.
#[test]
fn d2_signal_sets_shutting_down() {
    let controller = ShutdownController::new();
    controller.signal();
    assert!(
        controller.is_shutting_down(),
        "after signal(), is_shutting_down() must return true"
    );
}

/// wait_for_drain with zero active connections returns immediately.
#[tokio::test]
async fn d2_wait_for_drain_with_zero_active_returns_immediately() {
    let controller = ShutdownController::new();
    controller.signal();

    // With no active connections, drain should complete instantly
    let start = std::time::Instant::now();
    let result = controller.wait_for_drain(Duration::from_secs(120)).await;
    let elapsed = start.elapsed();

    assert!(
        result.is_ok(),
        "wait_for_drain must succeed with zero active connections"
    );
    assert!(
        elapsed < Duration::from_secs(1),
        "wait_for_drain with zero active should return immediately, took {:?}",
        elapsed
    );
}

/// wait_for_drain respects the configurable timeout.
#[tokio::test]
async fn d2_wait_for_drain_respects_timeout() {
    let controller = ShutdownController::new();
    // Register an active connection that will never complete
    controller.register_active();
    controller.signal();

    let start = std::time::Instant::now();
    let timeout = Duration::from_millis(200);
    let result = controller.wait_for_drain(timeout).await;
    let elapsed = start.elapsed();

    // Must timeout, not hang forever
    assert!(
        result.is_err(),
        "wait_for_drain must return error on timeout"
    );
    assert!(
        elapsed >= Duration::from_millis(180),
        "wait_for_drain must wait close to the timeout, took {:?}",
        elapsed
    );
    assert!(
        elapsed < Duration::from_secs(2),
        "wait_for_drain must not hang beyond timeout, took {:?}",
        elapsed
    );
}

/// Draining completes when all active connections finish before timeout.
#[tokio::test]
async fn d2_drain_completes_when_connections_finish() {
    let controller = ShutdownController::new();
    controller.register_active();
    controller.register_active();

    // Spawn a task that finishes the connections after 100ms
    let c = controller.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        c.deregister_active();
        c.deregister_active();
    });

    controller.signal();
    let result = controller.wait_for_drain(Duration::from_secs(5)).await;
    assert!(
        result.is_ok(),
        "drain should succeed when connections finish before timeout"
    );
}

/// E2E: Shutdown sequence — signal, drain, check state.
#[tokio::test]
async fn d2_e2e_shutdown_sequence() {
    let controller = ShutdownController::new();

    // Phase 1: Gateway is running, not shutting down
    assert!(!controller.is_shutting_down());
    assert_eq!(controller.active_count(), 0);

    // Phase 2: Some connections are active
    controller.register_active();
    controller.register_active();
    assert_eq!(controller.active_count(), 2);

    // Phase 3: SIGTERM arrives
    controller.signal();
    assert!(controller.is_shutting_down());

    // Phase 4: Connections drain
    controller.deregister_active();
    controller.deregister_active();
    assert_eq!(controller.active_count(), 0);

    // Phase 5: wait_for_drain returns immediately
    let result = controller.wait_for_drain(Duration::from_secs(120)).await;
    assert!(result.is_ok());
}

/// Negative: signal() called twice does not panic.
#[test]
fn d2_negative_double_signal_does_not_panic() {
    let controller = ShutdownController::new();
    controller.signal();
    controller.signal(); // must not panic
    assert!(controller.is_shutting_down());
}

/// Negative: deregister_active when count is zero does not underflow or panic.
#[test]
fn d2_negative_deregister_below_zero_does_not_panic() {
    let controller = ShutdownController::new();
    // Deregister without any prior register — must not panic or underflow
    controller.deregister_active();
    assert_eq!(controller.active_count(), 0);
}

/// ShutdownController is Clone + Send + Sync (shared across async tasks).
#[test]
fn d2_shutdown_controller_is_clone_send_sync() {
    fn assert_clone_send_sync<T: Clone + Send + Sync>() {}
    assert_clone_send_sync::<ShutdownController>();
}

/// Default shutdown timeout is 120 seconds per OD-023.
#[test]
fn d2_default_drain_timeout_is_120_seconds() {
    let controller = ShutdownController::new();
    assert_eq!(
        controller.default_timeout(),
        Duration::from_secs(120),
        "default drain timeout must be 120s per OD-023"
    );
}

// ===========================================================================
// D3: recondo status CLI command
// ===========================================================================
//
// Per OD-011: `recondo status` shows "Gateway active on :8443, N sessions
// captured today." Shows: gateway address, active/total sessions, total
// captures, uptime, database backend, fail_mode. Reads from SQLite/PG for
// session/capture counts.

/// StatusInfo struct contains all required fields per OD-011.
#[test]
fn d3_status_info_has_required_fields() {
    let info = StatusInfo {
        gateway_address: "0.0.0.0:8443".to_string(),
        active_sessions: 2,
        total_sessions: 15,
        total_captures: 142,
        uptime_seconds: 3600,
        database_backend: "sqlite".to_string(),
        fail_mode: "open".to_string(),
    };

    assert_eq!(info.gateway_address, "0.0.0.0:8443");
    assert_eq!(info.active_sessions, 2);
    assert_eq!(info.total_sessions, 15);
    assert_eq!(info.total_captures, 142);
    assert_eq!(info.uptime_seconds, 3600);
    assert_eq!(info.database_backend, "sqlite");
    assert_eq!(info.fail_mode, "open");
}

/// StatusInfo serializes to JSON with all expected fields.
#[test]
fn d3_status_info_serializes_to_json() {
    let info = StatusInfo {
        gateway_address: "0.0.0.0:8443".to_string(),
        active_sessions: 5,
        total_sessions: 20,
        total_captures: 100,
        uptime_seconds: 7200,
        database_backend: "postgres".to_string(),
        fail_mode: "closed".to_string(),
    };

    let json = serde_json::to_string(&info).expect("StatusInfo must serialize to JSON");
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed["gateway_address"], "0.0.0.0:8443");
    assert_eq!(parsed["active_sessions"], 5);
    assert_eq!(parsed["total_sessions"], 20);
    assert_eq!(parsed["total_captures"], 100);
    assert_eq!(parsed["uptime_seconds"], 7200);
    assert_eq!(parsed["database_backend"], "postgres");
    assert_eq!(parsed["fail_mode"], "closed");
}

/// StatusInfo display format includes the gateway address and session count.
#[test]
fn d3_status_info_display_format() {
    let info = StatusInfo {
        gateway_address: "0.0.0.0:8443".to_string(),
        active_sessions: 3,
        total_sessions: 50,
        total_captures: 200,
        uptime_seconds: 86400,
        database_backend: "sqlite".to_string(),
        fail_mode: "open".to_string(),
    };

    let display = format!("{}", info);
    assert!(
        display.contains("8443"),
        "display must include gateway port"
    );
    assert!(
        display.contains("50"),
        "display must include total session count"
    );
    assert!(
        display.contains("200"),
        "display must include total capture count"
    );
    assert!(
        display.contains("sqlite"),
        "display must include database backend"
    );
}

/// collect_status from an empty SQLite DB returns zero counts.
#[test]
fn d3_collect_status_empty_db_returns_zero_counts() {
    let conn = db::open_in_memory().expect("Must open in-memory SQLite");
    db::initialize(&conn).expect("Must initialize schema");

    let info = collect_status(&conn, "0.0.0.0:8443", "sqlite", "open", 0)
        .expect("collect_status must succeed on empty DB");

    assert_eq!(
        info.active_sessions, 0,
        "empty DB must have zero active sessions"
    );
    assert_eq!(
        info.total_sessions, 0,
        "empty DB must have zero total sessions"
    );
    assert_eq!(
        info.total_captures, 0,
        "empty DB must have zero total captures"
    );
    assert_eq!(info.gateway_address, "0.0.0.0:8443");
    assert_eq!(info.database_backend, "sqlite");
    assert_eq!(info.fail_mode, "open");
}

/// E2E: collect_status after inserting sessions and turns returns correct counts.
#[test]
fn d3_e2e_collect_status_with_data() {
    let conn = db::open_in_memory().expect("Must open in-memory SQLite");
    db::initialize(&conn).expect("Must initialize schema");

    // Insert a session
    // M2 fix: v4 phantom fields (total_input_tokens, total_output_tokens,
    // agent_framework, model_requested, metadata_json) removed from SessionRecord
    // because they had no backing schema migration.
    let session = db::SessionRecord {
        id: "sess-001".to_string(),
        started_at: "2026-03-21T10:00:00Z".to_string(),
        ended_at: Some("2026-03-21T10:30:00Z".to_string()),
        initial_intent: Some("Test session".to_string()),
        total_turns: 5,
        system_prompt_hash: "abc123".to_string(),
        ..Default::default()
    };
    db::insert_session(&conn, &session).expect("insert session must succeed");

    let info = collect_status(&conn, "0.0.0.0:8443", "sqlite", "open", 3600)
        .expect("collect_status must succeed with data");

    assert_eq!(info.total_sessions, 1, "must count 1 session");
    assert_eq!(info.uptime_seconds, 3600);
}

/// StatusInfo deserializes from JSON (round-trip).
#[test]
fn d3_status_info_json_round_trip() {
    let original = StatusInfo {
        gateway_address: "127.0.0.1:8443".to_string(),
        active_sessions: 1,
        total_sessions: 10,
        total_captures: 50,
        uptime_seconds: 1800,
        database_backend: "postgres".to_string(),
        fail_mode: "closed".to_string(),
    };

    let json = serde_json::to_string(&original).unwrap();
    let deserialized: StatusInfo = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.gateway_address, original.gateway_address);
    assert_eq!(deserialized.active_sessions, original.active_sessions);
    assert_eq!(deserialized.total_sessions, original.total_sessions);
    assert_eq!(deserialized.total_captures, original.total_captures);
    assert_eq!(deserialized.uptime_seconds, original.uptime_seconds);
    assert_eq!(deserialized.database_backend, original.database_backend);
    assert_eq!(deserialized.fail_mode, original.fail_mode);
}

/// Negative: collect_status with invalid connection returns error (not panic).
#[test]
fn d3_negative_collect_status_uninitialized_db() {
    // Open in-memory DB but do NOT call initialize — schema is missing
    let conn = db::open_in_memory().expect("Must open in-memory SQLite");
    // collect_status should return Err, not panic
    let result = collect_status(&conn, "0.0.0.0:8443", "sqlite", "open", 0);
    assert!(
        result.is_err(),
        "collect_status on uninitialized DB must return error, not panic"
    );
}

// ===========================================================================
// D4: Operator runtime (heartbeat/metrics loop)
// ===========================================================================
//
// Per OD-026 + existing OperatorSection: The `recondo-gateway operator`
// command runs a loop. Sends HeartbeatPayload every heartbeat_interval
// seconds. Sends MetricsPayload every metrics_interval seconds. Uses
// OperatorConfig (= OperatorSection) from recondo.toml. On control plane
// unreachable: log warning, retry next interval (never crash).

/// Mock ControlPlaneClient that records all payloads sent to it.
struct MockControlPlaneClient {
    heartbeats: Arc<Mutex<Vec<HeartbeatPayload>>>,
    metrics: Arc<Mutex<Vec<MetricsPayload>>>,
    should_fail: bool,
}

impl MockControlPlaneClient {
    fn new() -> Self {
        MockControlPlaneClient {
            heartbeats: Arc::new(Mutex::new(Vec::new())),
            metrics: Arc::new(Mutex::new(Vec::new())),
            should_fail: false,
        }
    }

    fn failing() -> Self {
        MockControlPlaneClient {
            heartbeats: Arc::new(Mutex::new(Vec::new())),
            metrics: Arc::new(Mutex::new(Vec::new())),
            should_fail: true,
        }
    }

    fn heartbeat_count(&self) -> usize {
        self.heartbeats.lock().unwrap().len()
    }

    fn metrics_count(&self) -> usize {
        self.metrics.lock().unwrap().len()
    }
}

impl ControlPlaneClient for MockControlPlaneClient {
    fn send_heartbeat(&self, payload: HeartbeatPayload) -> Result<(), Box<dyn std::error::Error>> {
        if self.should_fail {
            return Err("control plane unreachable".into());
        }
        self.heartbeats.lock().unwrap().push(payload);
        Ok(())
    }

    fn send_metrics(&self, payload: MetricsPayload) -> Result<(), Box<dyn std::error::Error>> {
        if self.should_fail {
            return Err("control plane unreachable".into());
        }
        self.metrics.lock().unwrap().push(payload);
        Ok(())
    }
}

/// Helper: create an OperatorConfig for testing with short intervals.
fn test_operator_config(heartbeat_secs: u64, metrics_secs: u64) -> OperatorSection {
    OperatorSection {
        control_plane: "http://localhost:3000".to_string(),
        token: "test-token".to_string(),
        heartbeat_interval: heartbeat_secs,
        metrics_interval: metrics_secs,
    }
}

/// OperatorRuntime can be constructed from OperatorConfig and a client.
#[test]
fn d4_operator_runtime_construction() {
    let config = test_operator_config(60, 300);
    let client = MockControlPlaneClient::new();
    let runtime = OperatorRuntime::new(config, client);
    // Construction must succeed — no-op assertion, the test is that it compiles + runs
    assert!(!runtime.is_running());
}

/// OperatorRuntime sends heartbeat at configured interval.
#[tokio::test]
async fn d4_runtime_sends_heartbeat_at_interval() {
    let config = test_operator_config(1, 100); // 1-second heartbeat, 100s metrics (won't fire)
    let client = MockControlPlaneClient::new();
    let heartbeats = Arc::clone(&client.heartbeats);

    let runtime = OperatorRuntime::new(config, client);

    // Run the runtime for ~2.5 seconds then stop it
    let handle = runtime.start();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    handle.stop().await;

    let count = heartbeats.lock().unwrap().len();
    // With 1-second interval and 2.5s runtime, expect 2-3 heartbeats
    assert!(
        count >= 2,
        "expected at least 2 heartbeats in 2.5s, got {}",
        count
    );
    assert!(
        count <= 4,
        "expected at most 4 heartbeats in 2.5s, got {}",
        count
    );
}

/// OperatorRuntime sends metrics at configured interval.
#[tokio::test]
async fn d4_runtime_sends_metrics_at_interval() {
    let config = test_operator_config(100, 1); // 100s heartbeat (won't fire), 1s metrics
    let client = MockControlPlaneClient::new();
    let metrics_payloads = Arc::clone(&client.metrics);

    let runtime = OperatorRuntime::new(config, client);

    let handle = runtime.start();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    handle.stop().await;

    let count = metrics_payloads.lock().unwrap().len();
    assert!(
        count >= 2,
        "expected at least 2 metrics sends in 2.5s, got {}",
        count
    );
    assert!(
        count <= 4,
        "expected at most 4 metrics sends in 2.5s, got {}",
        count
    );
}

/// HeartbeatPayload contains expected fields.
#[test]
fn d4_heartbeat_payload_fields() {
    let payload = HeartbeatPayload {
        gateway_version: "0.1.0".to_string(),
        uptime_seconds: 300,
        component_health: {
            let mut m = HashMap::new();
            m.insert("tls".to_string(), "healthy".to_string());
            m.insert("store".to_string(), "healthy".to_string());
            m
        },
    };

    let json = serde_json::to_string(&payload).expect("HeartbeatPayload must serialize");
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed["gateway_version"], "0.1.0");
    assert_eq!(parsed["uptime_seconds"], 300);
    assert!(parsed["component_health"]["tls"].is_string());
}

/// MetricsPayload contains expected fields.
#[test]
fn d4_metrics_payload_fields() {
    let payload = MetricsPayload {
        decision_count: 100,
        total_tokens: 50000,
        latency_p50_ms: 120.5,
        latency_p95_ms: 350.0,
        latency_p99_ms: 800.0,
        error_count: 2,
    };

    let json = serde_json::to_string(&payload).expect("MetricsPayload must serialize");
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed["decision_count"], 100);
    assert_eq!(parsed["total_tokens"], 50000);
    assert_eq!(parsed["error_count"], 2);
    // Floating-point comparison for latency percentiles
    assert!((parsed["latency_p50_ms"].as_f64().unwrap() - 120.5).abs() < 0.01);
    assert!((parsed["latency_p95_ms"].as_f64().unwrap() - 350.0).abs() < 0.01);
    assert!((parsed["latency_p99_ms"].as_f64().unwrap() - 800.0).abs() < 0.01);
}

/// E2E: OperatorRuntime sends both heartbeats and metrics concurrently.
#[tokio::test]
async fn d4_e2e_runtime_sends_heartbeats_and_metrics() {
    let config = test_operator_config(1, 1); // both at 1-second intervals
    let client = MockControlPlaneClient::new();
    let heartbeats = Arc::clone(&client.heartbeats);
    let metrics_payloads = Arc::clone(&client.metrics);

    let runtime = OperatorRuntime::new(config, client);

    let handle = runtime.start();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    handle.stop().await;

    let hb_count = heartbeats.lock().unwrap().len();
    let m_count = metrics_payloads.lock().unwrap().len();

    assert!(
        hb_count >= 2,
        "expected at least 2 heartbeats, got {}",
        hb_count
    );
    assert!(
        m_count >= 2,
        "expected at least 2 metrics sends, got {}",
        m_count
    );
}

/// E2E: Heartbeat payloads contain increasing uptime_seconds.
#[tokio::test]
async fn d4_e2e_heartbeat_uptime_increases() {
    let config = test_operator_config(1, 100);
    let client = MockControlPlaneClient::new();
    let heartbeats = Arc::clone(&client.heartbeats);

    let runtime = OperatorRuntime::new(config, client);

    let handle = runtime.start();
    tokio::time::sleep(Duration::from_millis(3500)).await;
    handle.stop().await;

    let hbs = heartbeats.lock().unwrap();
    assert!(
        hbs.len() >= 2,
        "need at least 2 heartbeats to compare uptime"
    );

    // Each heartbeat's uptime_seconds must be >= the previous one's
    for i in 1..hbs.len() {
        assert!(
            hbs[i].uptime_seconds >= hbs[i - 1].uptime_seconds,
            "uptime must be monotonically non-decreasing: {} < {}",
            hbs[i].uptime_seconds,
            hbs[i - 1].uptime_seconds
        );
    }
}

/// OperatorRuntime with failing client logs error but does not crash.
#[tokio::test]
async fn d4_runtime_with_failing_client_does_not_crash() {
    let config = test_operator_config(1, 1);
    let client = MockControlPlaneClient::failing();

    let runtime = OperatorRuntime::new(config, client);

    let handle = runtime.start();
    // Let it run for 3 seconds — the failing client errors every call
    tokio::time::sleep(Duration::from_secs(3)).await;
    // The runtime must still be alive (not panicked or exited)
    assert!(
        handle.is_running(),
        "runtime must still be running after client failures"
    );
    handle.stop().await;
}

/// Negative: zero heartbeat_interval config is rejected.
#[test]
fn d4_negative_zero_heartbeat_interval_rejected() {
    let config = test_operator_config(0, 300);
    let client = MockControlPlaneClient::new();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        OperatorRuntime::new(config, client)
    }));
    // Either the constructor returns an error or panics — both are acceptable
    // as long as zero interval is not silently accepted.
    // If it returns a Result::Err, the test passes.
    // If it panics, catch_unwind catches it and the test passes.
    // The only failure is if it silently accepts zero interval.
    assert!(
        result.is_err(),
        "zero heartbeat_interval must be rejected (panic or error)"
    );
}

/// Negative: zero metrics_interval config is rejected.
#[test]
fn d4_negative_zero_metrics_interval_rejected() {
    let config = test_operator_config(60, 0);
    let client = MockControlPlaneClient::new();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        OperatorRuntime::new(config, client)
    }));
    assert!(
        result.is_err(),
        "zero metrics_interval must be rejected (panic or error)"
    );
}

/// Negative: OperatorRuntime stop is idempotent — stopping twice does not panic.
#[tokio::test]
async fn d4_negative_stop_twice_does_not_panic() {
    let config = test_operator_config(60, 300);
    let client = MockControlPlaneClient::new();
    let runtime = OperatorRuntime::new(config, client);

    let handle = runtime.start();
    handle.stop().await;
    handle.stop().await; // second stop must not panic
}

/// OperatorConfig (alias for OperatorSection) deserializes from recondo.toml.
#[test]
fn d4_operator_config_from_toml() {
    let toml_str = r#"
[gateway]
listen = "0.0.0.0:8443"
providers = ["anthropic"]

[operator]
control_plane = "https://api.recondo.ai"
token = "wrt_test_token"
heartbeat_interval = 30
metrics_interval = 120
"#;

    let config = parse_recondo_toml(toml_str).expect("valid TOML must parse");
    let op = config.operator.expect("operator section must be present");
    assert_eq!(op.control_plane, "https://api.recondo.ai");
    assert_eq!(op.token, "wrt_test_token");
    assert_eq!(op.heartbeat_interval, 30);
    assert_eq!(op.metrics_interval, 120);
}

/// OperatorConfig defaults: heartbeat_interval=60, metrics_interval=300.
#[test]
fn d4_operator_config_defaults() {
    let toml_str = r#"
[gateway]
listen = "0.0.0.0:8443"
providers = ["anthropic"]

[operator]
control_plane = "https://api.recondo.ai"
token = "wrt_test_token"
"#;

    let config = parse_recondo_toml(toml_str).expect("valid TOML must parse");
    let op = config.operator.expect("operator section must be present");
    assert_eq!(
        op.heartbeat_interval, 60,
        "default heartbeat_interval must be 60 seconds"
    );
    assert_eq!(
        op.metrics_interval, 300,
        "default metrics_interval must be 300 seconds"
    );
}
