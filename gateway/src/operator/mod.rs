//! Recondo Operator types — config, heartbeat payloads, metrics payloads.
//!
//! The Recondo Operator is a lightweight sidecar that runs alongside the
//! gateway. It communicates with the Recondo control plane to:
//!
//! - Send periodic heartbeats with component health
//! - Report aggregated telemetry metrics
//! - Receive configuration updates and upgrade directives
//!
//! This module defines the data types shared between the gateway and operator.

pub mod runtime;
pub mod upgrade;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::config::OperatorSection;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/// Operator configuration — re-exported from the config module for convenience.
pub type OperatorConfig = OperatorSection;

// ---------------------------------------------------------------------------
// Heartbeat payload
// ---------------------------------------------------------------------------

/// Payload sent to the control plane on each heartbeat interval.
///
/// Contains gateway identity, uptime, and a per-component health summary.
/// No decision data (request/response content) is included.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatPayload {
    /// Semantic version of the running gateway binary.
    pub gateway_version: String,
    /// Seconds since gateway process started.
    pub uptime_seconds: u64,
    /// Per-component health status keyed by component name.
    /// Values are simple strings like `"healthy"` or `"error"`.
    pub component_health: HashMap<String, String>,
}

// ---------------------------------------------------------------------------
// Metrics payload
// ---------------------------------------------------------------------------

/// Aggregated telemetry payload sent to the control plane on each metrics
/// interval. Contains counts and latency percentiles — no decision data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricsPayload {
    /// Number of proxy decisions made during the reporting period.
    pub decision_count: u64,
    /// Total tokens observed across all captured LLM responses.
    pub total_tokens: u64,
    /// 50th-percentile request latency in milliseconds.
    pub latency_p50_ms: f64,
    /// 95th-percentile request latency in milliseconds.
    pub latency_p95_ms: f64,
    /// 99th-percentile request latency in milliseconds.
    pub latency_p99_ms: f64,
    /// Number of proxy errors (connection failures, TLS errors, etc.).
    pub error_count: u64,
}
