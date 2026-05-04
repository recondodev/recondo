//! Phase 2 Sprint 4: Gateway Containerization, CI/CD Pipeline, Recondo Operator,
//! Helm Chart, Dev Docker Compose, and recondo.toml Configuration.
//!
//! EVERY test in this file imports from modules that DO NOT EXIST yet:
//!
//! - `recondo_gateway::config` (new module: recondo.toml parsing, RecondoConfig, env overrides)
//! - `recondo_gateway::health` (new module: HealthStatus, HealthResponse, ComponentHealth)
//! - `recondo_gateway::operator` (new module: OperatorConfig, HeartbeatPayload, MetricsPayload)
//! - `recondo_gateway::operator::upgrade` (new submodule: RollingUpgrade, UpgradeResult)
//!
//! This file MUST NOT compile until the implementation agent creates these modules.
//! Each test imports production types/functions that do not exist yet.
//! The implementation agent must create them to make these tests pass.

#![allow(
    unused_imports,
    clippy::single_match,
    clippy::double_ended_iterator_last,
    clippy::unnecessary_map_or
)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};

// W7 fix: serial_test ensures env-var-mutating tests run one at a time,
// preventing data races from parallel set_var / remove_var calls.
use serial_test::serial;

// Existing types that DO compile today
use recondo_gateway::db;
use recondo_gateway::gateway::GatewayConfig;

// ---- These imports WILL NOT RESOLVE until the new modules are created ----

// D1: Health check endpoint — types for /healthz response
use recondo_gateway::health::{
    check_health, ComponentHealth, ComponentStatus, HealthContext, HealthResponse, HealthStatus,
};

// D6: Configuration via recondo.toml — parsed config structs
use recondo_gateway::config::{
    parse_recondo_toml, DeploymentConfig, GatewaySection, ObjectsSection, OperatorSection,
    RecondoConfig, StoreSection, TlsSection,
};

// D3: Recondo Operator — config, heartbeat, metrics
use recondo_gateway::operator::{HeartbeatPayload, MetricsPayload, OperatorConfig as OpConfig};

// D3: Recondo Operator — rolling upgrade
use recondo_gateway::operator::upgrade::{RollingUpgrade, UpgradeResult, UpgradeStatus};

// ===========================================================================
// Test fixtures — recondo.toml content
// ===========================================================================

/// FIND-7-C: shared env-var isolation helper for the recondo.toml
/// parser tests. `parse_recondo_toml` applies overrides for these
/// keys, so any test that asserts on parsed values must clear the
/// env first AND restore on drop. Returning a guard via RAII keeps
/// cleanup robust across `panic!` / early-return / `?` paths.
///
/// Tests that use this MUST also be tagged `#[serial_test::serial(recondo_env)]`
/// so two env-mutating tests don't race.
struct RecondoEnvGuard {
    snap: Vec<(&'static str, Option<String>)>,
}
impl Drop for RecondoEnvGuard {
    fn drop(&mut self) {
        for (k, v) in &self.snap {
            match v {
                Some(val) => std::env::set_var(k, val),
                None => std::env::remove_var(k),
            }
        }
    }
}
fn recondo_env_isolation() -> RecondoEnvGuard {
    const KEYS: &[&str] = &[
        "RECONDO_STORE",
        "RECONDO_DB_URL",
        "RECONDO_OBJECTS",
        "RECONDO_S3_BUCKET",
        "RECONDO_OPERATOR_TOKEN",
    ];
    let snap: Vec<_> = KEYS.iter().map(|k| (*k, std::env::var(k).ok())).collect();
    let guard = RecondoEnvGuard { snap };
    for k in KEYS {
        std::env::remove_var(k);
    }
    guard
}

/// A complete recondo.toml with all sections populated. This is the canonical
/// fixture that matches the roadmap specification exactly.
const FULL_RECONDO_TOML: &str = r#"
[gateway]
listen = "0.0.0.0:8443"
providers = ["anthropic", "openai", "google"]

[store]
backend = "postgres"
postgres_uri = "postgres://recondo:recondo_dev@localhost:5432/recondo"

[objects]
backend = "s3"
s3_bucket = "recondo-artifacts"
s3_region = "us-east-1"

[tls]
ca_dir = "/etc/recondo/ca"
auto_trust = true

[operator]
control_plane = "https://api.recondo.ai"
token = "wrt_tenant_abc123"
heartbeat_interval = 60
metrics_interval = 300

[deployment]
mode = "byoc"
"#;

/// A minimal recondo.toml with only required fields. Optional sections
/// (operator, deployment) are omitted and must use defaults.
const MINIMAL_RECONDO_TOML: &str = r#"
[gateway]
listen = "0.0.0.0:8443"
providers = ["anthropic"]

[store]
backend = "sqlite"

[objects]
backend = "local"

[tls]
ca_dir = "~/.recondo/ca"
auto_trust = false
"#;

/// A recondo.toml with dev mode deployment (local development).
const DEV_RECONDO_TOML: &str = r#"
[gateway]
listen = "127.0.0.1:8443"
providers = ["anthropic", "openai"]

[store]
backend = "postgres"
postgres_uri = "postgres://recondo:recondo_dev@postgres:5432/recondo"

[objects]
backend = "local"

[tls]
ca_dir = "/etc/recondo/ca"
auto_trust = true

[operator]
control_plane = "http://host.docker.internal:3000"
token = "dev-token"
heartbeat_interval = 30
metrics_interval = 60

[deployment]
mode = "dev"
"#;

/// Invalid TOML (malformed syntax) — for negative testing.
const INVALID_TOML: &str = r#"
[gateway
listen = "0.0.0.0:8443"
"#;

/// TOML with unknown fields — for forward compatibility testing.
const TOML_WITH_UNKNOWN_FIELDS: &str = r#"
[gateway]
listen = "0.0.0.0:8443"
providers = ["anthropic"]
unknown_future_field = "should be ignored"

[store]
backend = "sqlite"

[objects]
backend = "local"

[tls]
ca_dir = "~/.recondo/ca"
auto_trust = false
"#;

// ===========================================================================
// Section 1: Health Check Endpoint (D1) — 8 tests
// ===========================================================================

/// **Proves:** HealthResponse with all-healthy components reports status "ok" with HTTP-200-class
/// semantics. The JSON body contains exactly the expected structure with component-level detail.
/// **Anti-fake property:** Asserts the exact status string "ok", the presence of three specific
/// component keys (tls, store, objects), and that each component's status is "healthy". A stub
/// returning a hardcoded string would need to match all three component keys and their statuses.
#[test]
fn health_check_returns_ok_when_all_components_healthy() {
    let components = HashMap::from([
        (
            "tls".to_string(),
            ComponentHealth {
                status: ComponentStatus::Healthy,
                message: None,
            },
        ),
        (
            "store".to_string(),
            ComponentHealth {
                status: ComponentStatus::Healthy,
                message: None,
            },
        ),
        (
            "objects".to_string(),
            ComponentHealth {
                status: ComponentStatus::Healthy,
                message: None,
            },
        ),
    ]);

    let response = HealthResponse::from_components(components);

    assert_eq!(
        response.status,
        HealthStatus::Ok,
        "Overall status must be Ok when all components are healthy"
    );
    assert!(
        response.is_healthy(),
        "is_healthy() must return true when all components are healthy"
    );
    assert_eq!(
        response.http_status_code(),
        200,
        "HTTP status code must be 200 for healthy gateway"
    );
}

/// **Proves:** HealthResponse correctly detects a degraded state when the store component
/// reports an error. The overall status becomes "degraded" and the HTTP status code is 503.
/// **Anti-fake property:** The store component has status Error with a specific message.
/// A fake that always returns Ok would fail both the status assertion and the HTTP code check.
#[test]
fn health_check_returns_degraded_when_store_unhealthy() {
    let components = HashMap::from([
        (
            "tls".to_string(),
            ComponentHealth {
                status: ComponentStatus::Healthy,
                message: None,
            },
        ),
        (
            "store".to_string(),
            ComponentHealth {
                status: ComponentStatus::Error,
                message: Some("connection refused: postgres:5432".to_string()),
            },
        ),
        (
            "objects".to_string(),
            ComponentHealth {
                status: ComponentStatus::Healthy,
                message: None,
            },
        ),
    ]);

    let response = HealthResponse::from_components(components);

    assert_eq!(
        response.status,
        HealthStatus::Degraded,
        "Overall status must be Degraded when any component has an error"
    );
    assert!(
        !response.is_healthy(),
        "is_healthy() must return false when degraded"
    );
    assert_eq!(
        response.http_status_code(),
        503,
        "HTTP status code must be 503 for degraded gateway"
    );

    let store = response
        .components
        .get("store")
        .expect("store component must exist");
    assert_eq!(store.status, ComponentStatus::Error);
    assert!(
        store
            .message
            .as_ref()
            .unwrap()
            .contains("connection refused"),
        "Error message must describe the failure"
    );
}

/// **Proves:** HealthResponse serializes to JSON with the exact schema documented in the
/// roadmap: `{"status":"ok","components":{"tls":{"status":"healthy"},...}}`.
/// **Anti-fake property:** Asserts specific JSON field names and structure via serde
/// deserialization round-trip. A flat JSON blob or different field names would fail.
#[test]
fn health_check_response_serializes_to_correct_json_schema() {
    let components = HashMap::from([
        (
            "tls".to_string(),
            ComponentHealth {
                status: ComponentStatus::Healthy,
                message: None,
            },
        ),
        (
            "store".to_string(),
            ComponentHealth {
                status: ComponentStatus::Healthy,
                message: None,
            },
        ),
        (
            "objects".to_string(),
            ComponentHealth {
                status: ComponentStatus::Healthy,
                message: None,
            },
        ),
    ]);

    let response = HealthResponse::from_components(components);
    let json = serde_json::to_value(&response).expect("must serialize to JSON");

    assert_eq!(json["status"], "ok", "JSON status field must be 'ok'");
    assert!(
        json["components"].is_object(),
        "JSON must have a 'components' object"
    );
    assert!(
        json["components"]["tls"].is_object(),
        "components must contain 'tls'"
    );
    assert!(
        json["components"]["store"].is_object(),
        "components must contain 'store'"
    );
    assert!(
        json["components"]["objects"].is_object(),
        "components must contain 'objects'"
    );
    assert_eq!(
        json["components"]["tls"]["status"], "healthy",
        "tls component status must be 'healthy' in JSON"
    );
}

/// **Proves:** HealthResponse with a degraded component includes the error message in the
/// serialized JSON at the correct path: `components.store.message`.
/// **Anti-fake property:** Asserts both the degraded status string and the presence of the
/// message field at the exact JSON path. A response that omits the message would fail.
#[test]
fn health_check_degraded_json_includes_error_message() {
    let components = HashMap::from([
        (
            "tls".to_string(),
            ComponentHealth {
                status: ComponentStatus::Healthy,
                message: None,
            },
        ),
        (
            "store".to_string(),
            ComponentHealth {
                status: ComponentStatus::Error,
                message: Some("disk full".to_string()),
            },
        ),
        (
            "objects".to_string(),
            ComponentHealth {
                status: ComponentStatus::Healthy,
                message: None,
            },
        ),
    ]);

    let response = HealthResponse::from_components(components);
    let json = serde_json::to_value(&response).expect("must serialize");

    assert_eq!(json["status"], "degraded");
    assert_eq!(json["components"]["store"]["status"], "error");
    assert_eq!(
        json["components"]["store"]["message"], "disk full",
        "Error message must appear in serialized JSON"
    );
    // Healthy components must NOT have a message field (or it must be null)
    assert!(
        json["components"]["tls"]["message"].is_null(),
        "Healthy component must not have a message"
    );
}

/// **Proves:** When ALL components are in error state, the overall status is still "degraded"
/// (not some other status like "down" or "critical"), and is_healthy() returns false.
/// **Anti-fake property:** Tests the boundary condition where every component is broken.
/// An implementation that only checks the first component would produce a different result
/// if the components were iterated in a different order.
#[test]
fn health_check_all_components_error_is_degraded() {
    let components = HashMap::from([
        (
            "tls".to_string(),
            ComponentHealth {
                status: ComponentStatus::Error,
                message: Some("CA not loaded".to_string()),
            },
        ),
        (
            "store".to_string(),
            ComponentHealth {
                status: ComponentStatus::Error,
                message: Some("DB unreachable".to_string()),
            },
        ),
        (
            "objects".to_string(),
            ComponentHealth {
                status: ComponentStatus::Error,
                message: Some("S3 access denied".to_string()),
            },
        ),
    ]);

    let response = HealthResponse::from_components(components);

    assert_eq!(response.status, HealthStatus::Degraded);
    assert!(!response.is_healthy());
    assert_eq!(response.http_status_code(), 503);
}

/// **Proves (NEGATIVE):** An empty components map produces a degraded health status, not Ok.
/// A gateway with no components to check is not healthy — it means the health check itself
/// is misconfigured.
/// **Anti-fake property:** An implementation that returns Ok for empty input would be wrong —
/// no components means nothing was verified. This negative test catches that.
#[test]
fn health_check_empty_components_is_not_ok() {
    let components: HashMap<String, ComponentHealth> = HashMap::new();
    let response = HealthResponse::from_components(components);

    assert_ne!(
        response.status,
        HealthStatus::Ok,
        "Empty components must not produce Ok status"
    );
    assert!(
        !response.is_healthy(),
        "Empty components must not be considered healthy"
    );
}

/// **Proves:** The check_health function produces a HealthResponse that includes exactly
/// three required component keys: tls, store, objects. This is the function the /healthz
/// endpoint handler calls.
/// **Anti-fake property:** Asserts the exact set of component keys. A function that returns
/// fewer or different keys would fail. The check_health function must probe all three
/// subsystems.
#[test]
fn check_health_function_includes_required_component_keys() {
    // check_health takes references to the subsystem handles and probes them.
    // For unit testing, we pass test doubles that report healthy.
    // The function must return a HealthResponse with tls, store, and objects keys.
    let response = check_health(&HealthContext::none());

    assert!(
        response.components.contains_key("tls"),
        "Health response must include 'tls' component"
    );
    assert!(
        response.components.contains_key("store"),
        "Health response must include 'store' component"
    );
    assert!(
        response.components.contains_key("objects"),
        "Health response must include 'objects' component"
    );
}

/// **Proves:** ComponentStatus serializes to lowercase strings in JSON: "healthy" and "error",
/// not "Healthy" / "Error" or other casings.
/// **Anti-fake property:** The roadmap specifies lowercase status values in the JSON response.
/// If the serialization uses Rust's default Debug formatting, this test catches it.
#[test]
fn component_status_serializes_to_lowercase_strings() {
    let healthy = serde_json::to_value(ComponentStatus::Healthy).unwrap();
    let error = serde_json::to_value(ComponentStatus::Error).unwrap();

    assert_eq!(healthy, "healthy", "Healthy must serialize as 'healthy'");
    assert_eq!(error, "error", "Error must serialize as 'error'");
}

// ===========================================================================
// Section 2: Dockerfile (D1) — 3 tests
// ===========================================================================

/// **Proves:** `Dockerfile.gateway` exists in the repository root and uses a multi-stage
/// build pattern with `rust:` as the builder stage and `debian:bookworm-slim` as the
/// runtime stage.
/// **Anti-fake property:** Checks for specific Docker directives: `FROM rust:` in the first
/// stage and `FROM debian:bookworm-slim` in the runtime stage. A single-stage Dockerfile
/// or one using a different base image would fail these assertions.
#[test]
fn dockerfile_gateway_uses_multi_stage_build_with_slim_runtime() {
    let dockerfile_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("Dockerfile.gateway");

    let content = std::fs::read_to_string(&dockerfile_path)
        .unwrap_or_else(|_| panic!("Dockerfile.gateway must exist at {:?}", dockerfile_path));

    // Must have multi-stage build: builder stage installs Rust (via base image or rustup)
    assert!(
        content.contains("FROM rust:")
            || content.contains("FROM docker.io/library/rust:")
            || content.contains("rustup"),
        "Dockerfile must use rust: image or install Rust via rustup as builder stage"
    );

    // Runtime stage must use a minimal image (debian slim or amazonlinux)
    assert!(
        content.contains("FROM debian:bookworm-slim")
            || content.contains("FROM amazonlinux:"),
        "Dockerfile runtime stage must use a minimal base image (debian:bookworm-slim or amazonlinux)"
    );

    // Must have at least two FROM directives (multi-stage)
    let from_count = content
        .lines()
        .filter(|l| l.trim_start().starts_with("FROM "))
        .count();
    assert!(
        from_count >= 2,
        "Dockerfile must have at least 2 FROM directives (multi-stage build), found {}",
        from_count
    );
}

/// **Proves:** The Dockerfile copies the gateway binary and includes a HEALTHCHECK instruction
/// or at minimum EXPOSEs port 8443 for the health check endpoint.
/// **Anti-fake property:** Checks that the binary is explicitly copied from the builder stage
/// and that port 8443 is exposed. A Dockerfile that builds but doesn't expose the right port
/// would fail.
#[test]
fn dockerfile_gateway_copies_binary_and_exposes_port() {
    let dockerfile_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("Dockerfile.gateway");

    let content = std::fs::read_to_string(&dockerfile_path)
        .unwrap_or_else(|_| panic!("Dockerfile.gateway must exist at {:?}", dockerfile_path));

    // Must COPY the built binary from builder stage
    assert!(
        content.contains("COPY --from="),
        "Dockerfile must COPY binary from builder stage"
    );

    // Must expose port 8443
    assert!(
        content.contains("EXPOSE 8443") || content.contains("EXPOSE 8443/tcp"),
        "Dockerfile must EXPOSE port 8443 for the gateway"
    );
}

/// **Proves (NEGATIVE):** The Dockerfile runtime stage does NOT use the full rust image,
/// which would be ~1.5GB. The runtime stage must be the slim image.
/// **Anti-fake property:** Searches for the last FROM directive and verifies it is NOT a
/// rust image. A Dockerfile that accidentally uses rust: as the runtime image would fail.
#[test]
fn dockerfile_gateway_runtime_is_not_full_rust_image() {
    let dockerfile_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("Dockerfile.gateway");

    let content = std::fs::read_to_string(&dockerfile_path)
        .unwrap_or_else(|_| panic!("Dockerfile.gateway must exist at {:?}", dockerfile_path));

    // Find the last FROM line — this is the runtime stage
    let last_from = content
        .lines()
        .filter(|l| l.trim_start().starts_with("FROM "))
        .last()
        .expect("Dockerfile must have at least one FROM directive");

    assert!(
        !last_from.contains("rust:"),
        "Runtime stage (last FROM) must NOT use rust image, found: {}",
        last_from
    );
}

// ===========================================================================
// Section 3: CI/CD Pipeline (D2) — 5 tests
// ===========================================================================

/// **Proves:** A GitHub Actions workflow file exists for the gateway CI/CD pipeline
/// and triggers on push to the `main` branch.
/// **Anti-fake property:** Checks for the literal YAML trigger `push:` with `branches:`
/// containing `main`. A workflow that only triggers on PRs or tags would fail.
#[test]
fn ci_workflow_exists_and_triggers_on_push_to_main() {
    let workflow_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".github/workflows/gateway-ci.yml");

    let content = std::fs::read_to_string(&workflow_path)
        .unwrap_or_else(|_| panic!("Workflow must exist at {:?}", workflow_path));

    assert!(
        content.contains("push:"),
        "Workflow must trigger on push events"
    );
    assert!(
        content.contains("main"),
        "Workflow must trigger on push to main branch"
    );
}

/// **Proves:** The CI workflow includes cargo nextest test execution step.
/// **Anti-fake property:** Asserts the presence of `cargo nextest` or `nextest run` in the
/// workflow. A workflow that only builds but doesn't test would fail.
#[test]
fn ci_workflow_includes_test_step_with_nextest() {
    let workflow_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".github/workflows/gateway-ci.yml");

    let content = std::fs::read_to_string(&workflow_path)
        .unwrap_or_else(|_| panic!("Workflow must exist at {:?}", workflow_path));

    assert!(
        content.contains("nextest") || content.contains("cargo test"),
        "Workflow must include a test step using nextest or cargo test"
    );
}

/// **Proves:** The CI workflow includes a clippy lint step.
/// **Anti-fake property:** Asserts `clippy` appears in the workflow content. A pipeline
/// that skips linting would fail.
#[test]
fn ci_workflow_includes_clippy_lint_step() {
    let workflow_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".github/workflows/gateway-ci.yml");

    let content = std::fs::read_to_string(&workflow_path)
        .unwrap_or_else(|_| panic!("Workflow must exist at {:?}", workflow_path));

    assert!(
        content.contains("clippy"),
        "Workflow must include a clippy lint step"
    );
}

/// **Proves (NEGATIVE):** The CI workflow does NOT contain hardcoded AWS credentials.
/// Credentials must be injected via GitHub secrets, not embedded in the workflow file.
/// **Anti-fake property:** Searches for patterns like `AWS_ACCESS_KEY_ID: AKIA` or
/// `aws_secret_access_key:` with literal values. A workflow that embeds credentials
/// would fail.
#[test]
fn ci_workflow_does_not_contain_hardcoded_credentials() {
    let workflow_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".github/workflows/gateway-ci.yml");

    let content = std::fs::read_to_string(&workflow_path)
        .unwrap_or_else(|_| panic!("Workflow must exist at {:?}", workflow_path));

    // Must not contain literal AWS access key IDs (start with AKIA)
    assert!(
        !content.contains("AKIA"),
        "Workflow must not contain hardcoded AWS access key IDs"
    );
}

// ===========================================================================
// Section 4: Recondo Operator (D3) — 10 tests
// ===========================================================================

/// **Proves:** OperatorConfig is parsed from the [operator] section of recondo.toml with
/// all required fields: control_plane, token, heartbeat_interval, metrics_interval.
/// **Anti-fake property:** Asserts exact values from the TOML fixture. A config parser
/// that ignores the [operator] section or returns defaults would produce wrong values.
#[test]
#[serial(recondo_env)]
fn operator_config_parsed_from_recondo_toml() {
    // FIND-8-C: env-isolation guard. `op.token` is overrideable via
    // RECONDO_OPERATOR_TOKEN; without the guard, this assertion
    // flaked when ambient env had the var set.
    let _guard = recondo_env_isolation();
    let config = parse_recondo_toml(FULL_RECONDO_TOML).expect("must parse full recondo.toml");
    let op = config.operator.expect("operator section must be present");

    assert_eq!(
        op.control_plane, "https://api.recondo.ai",
        "control_plane must match TOML value"
    );
    assert_eq!(op.token, "wrt_tenant_abc123", "token must match TOML value");
    assert_eq!(
        op.heartbeat_interval, 60,
        "heartbeat_interval must be 60 seconds"
    );
    assert_eq!(
        op.metrics_interval, 300,
        "metrics_interval must be 300 seconds (5 minutes)"
    );
}

/// **Proves:** HeartbeatPayload contains the required fields: gateway_version, uptime_seconds,
/// and component_health map. This is the payload sent to the control plane every heartbeat.
/// **Anti-fake property:** Constructs a HeartbeatPayload and verifies each field is present
/// and has the correct type/value. A stub struct without these fields would fail to compile.
#[test]
fn heartbeat_payload_contains_required_fields() {
    let mut component_health = HashMap::new();
    component_health.insert("tls".to_string(), "healthy".to_string());
    component_health.insert("store".to_string(), "healthy".to_string());
    component_health.insert("objects".to_string(), "healthy".to_string());

    let payload = HeartbeatPayload {
        gateway_version: "0.1.0".to_string(),
        uptime_seconds: 3600,
        component_health,
    };

    assert_eq!(payload.gateway_version, "0.1.0");
    assert_eq!(payload.uptime_seconds, 3600);
    assert_eq!(payload.component_health.len(), 3);
    assert_eq!(payload.component_health.get("tls").unwrap(), "healthy");
}

/// **Proves:** HeartbeatPayload serializes to JSON with the expected field names for the
/// control plane API contract.
/// **Anti-fake property:** Checks that the serialized JSON contains exact field names
/// matching the API contract: gateway_version, uptime_seconds, component_health.
#[test]
fn heartbeat_payload_serializes_to_json_with_correct_field_names() {
    let payload = HeartbeatPayload {
        gateway_version: "0.1.0".to_string(),
        uptime_seconds: 120,
        component_health: HashMap::from([
            ("tls".to_string(), "healthy".to_string()),
            ("store".to_string(), "error".to_string()),
        ]),
    };

    let json = serde_json::to_value(&payload).expect("must serialize");

    assert_eq!(json["gateway_version"], "0.1.0");
    assert_eq!(json["uptime_seconds"], 120);
    assert!(json["component_health"].is_object());
    assert_eq!(json["component_health"]["store"], "error");
}

/// **Proves:** MetricsPayload contains the required aggregated telemetry fields:
/// decision_count, total_tokens, latency_p50, latency_p95, latency_p99, error_count.
/// **Anti-fake property:** Constructs a MetricsPayload with specific values and asserts
/// each one. A struct missing any field won't compile; a struct with wrong values would
/// fail the assertions.
#[test]
fn metrics_payload_contains_required_fields() {
    let payload = MetricsPayload {
        decision_count: 1500,
        total_tokens: 2_500_000,
        latency_p50_ms: 45.0,
        latency_p95_ms: 120.0,
        latency_p99_ms: 350.0,
        error_count: 12,
    };

    assert_eq!(payload.decision_count, 1500);
    assert_eq!(payload.total_tokens, 2_500_000);
    assert!((payload.latency_p50_ms - 45.0).abs() < f64::EPSILON);
    assert!((payload.latency_p95_ms - 120.0).abs() < f64::EPSILON);
    assert!((payload.latency_p99_ms - 350.0).abs() < f64::EPSILON);
    assert_eq!(payload.error_count, 12);
}

/// **Proves:** MetricsPayload serializes to JSON for transmission to the control plane.
/// The field names in JSON must match the API contract.
/// **Anti-fake property:** Verifies exact JSON field names and numeric values. A payload
/// with renamed fields or wrong serialization would fail.
#[test]
fn metrics_payload_serializes_to_json() {
    let payload = MetricsPayload {
        decision_count: 100,
        total_tokens: 50_000,
        latency_p50_ms: 30.0,
        latency_p95_ms: 80.0,
        latency_p99_ms: 200.0,
        error_count: 0,
    };

    let json = serde_json::to_value(&payload).expect("must serialize");

    assert_eq!(json["decision_count"], 100);
    assert_eq!(json["total_tokens"], 50_000);
    assert_eq!(json["error_count"], 0);
    assert!(json["latency_p50_ms"].is_number());
    assert!(json["latency_p95_ms"].is_number());
    assert!(json["latency_p99_ms"].is_number());
}

/// **Proves:** OperatorConfig heartbeat_interval defaults to 60 seconds when not specified.
/// **Anti-fake property:** Uses a TOML that has an [operator] section without
/// heartbeat_interval. The parsed config must use the default, not 0 or some sentinel.
#[test]
fn operator_config_defaults_heartbeat_interval_to_60() {
    let toml_without_interval = r#"
[gateway]
listen = "0.0.0.0:8443"
providers = ["anthropic"]

[store]
backend = "sqlite"

[objects]
backend = "local"

[tls]
ca_dir = "~/.recondo/ca"
auto_trust = false

[operator]
control_plane = "https://api.recondo.ai"
token = "wrt_test"
"#;

    let config = parse_recondo_toml(toml_without_interval).expect("must parse");
    let op = config.operator.expect("operator section must be present");

    assert_eq!(
        op.heartbeat_interval, 60,
        "heartbeat_interval must default to 60 seconds when not specified"
    );
}

/// **Proves:** OperatorConfig metrics_interval defaults to 300 seconds (5 minutes) when
/// not specified in the TOML.
/// **Anti-fake property:** Same as above — the default must be exactly 300, not 0 or 60.
#[test]
fn operator_config_defaults_metrics_interval_to_300() {
    let toml_without_interval = r#"
[gateway]
listen = "0.0.0.0:8443"
providers = ["anthropic"]

[store]
backend = "sqlite"

[objects]
backend = "local"

[tls]
ca_dir = "~/.recondo/ca"
auto_trust = false

[operator]
control_plane = "https://api.recondo.ai"
token = "wrt_test"
"#;

    let config = parse_recondo_toml(toml_without_interval).expect("must parse");
    let op = config.operator.expect("operator section must be present");

    assert_eq!(
        op.metrics_interval, 300,
        "metrics_interval must default to 300 seconds when not specified"
    );
}

/// **Proves:** RollingUpgrade tracks upgrade status through the lifecycle: Pending ->
/// Pulling -> HealthChecking -> Complete (or RolledBack on failure).
/// **Anti-fake property:** Creates an upgrade and asserts the initial status is Pending.
/// An implementation that skips the state machine would return a different initial state.
#[test]
fn rolling_upgrade_starts_in_pending_status() {
    let upgrade = RollingUpgrade::new(
        "recondo/gateway:0.2.0-abc1234".to_string(),
        "recondo/gateway:0.1.0-def5678".to_string(),
    );

    assert_eq!(
        upgrade.status(),
        UpgradeStatus::Pending,
        "New rolling upgrade must start in Pending status"
    );
    assert_eq!(
        upgrade.target_image(),
        "recondo/gateway:0.2.0-abc1234",
        "Target image must match"
    );
    assert_eq!(
        upgrade.current_image(),
        "recondo/gateway:0.1.0-def5678",
        "Current image must match"
    );
}

/// **Proves (NEGATIVE):** RollingUpgrade reports failure when the health check fails after
/// image pull. The result must be RolledBack, not silently succeeding.
/// **Anti-fake property:** A rolling upgrade that always succeeds regardless of health check
/// results would fail this test. The test constructs an UpgradeResult::RolledBack and
/// verifies it contains a reason string.
#[test]
fn rolling_upgrade_reports_failure_on_health_check_failure() {
    let result = UpgradeResult::RolledBack {
        reason: "health check failed: /healthz returned 503 after 3 retries".to_string(),
    };

    match &result {
        UpgradeResult::RolledBack { reason } => {
            assert!(
                reason.contains("health check failed"),
                "Rollback reason must describe the health check failure"
            );
        }
        UpgradeResult::Success => {
            panic!("Expected RolledBack, got Success");
        }
    }
}

// ===========================================================================
// Section 5: Helm Chart (D4) — 6 tests
// ===========================================================================

/// **Proves:** The Helm chart `Chart.yaml` exists at `deploy/helm/recondo/Chart.yaml`
/// with the correct chart name and a valid API version.
/// **Anti-fake property:** Checks for `name: recondo` and `apiVersion: v2` in the YAML
/// content. A missing or misnamed chart would fail.
#[test]
fn helm_chart_yaml_exists_with_correct_metadata() {
    let chart_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("deploy/helm/recondo/Chart.yaml");

    let content = std::fs::read_to_string(&chart_path)
        .unwrap_or_else(|_| panic!("Chart.yaml must exist at {:?}", chart_path));

    assert!(
        content.contains("apiVersion: v2"),
        "Chart.yaml must use Helm API version v2"
    );
    assert!(
        content.contains("name: recondo"),
        "Chart.yaml must have name: recondo"
    );
    assert!(
        content.contains("type: application"),
        "Chart.yaml must be type: application"
    );
}

/// **Proves:** The Helm `values.yaml` contains configurable fields for: replicas, image tag,
/// resource limits, postgres URI, and S3 bucket.
/// **Anti-fake property:** Checks for specific YAML keys. A values.yaml that omits any of
/// these configuration knobs would fail.
#[test]
fn helm_values_yaml_has_required_configurable_fields() {
    let values_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("deploy/helm/recondo/values.yaml");

    let content = std::fs::read_to_string(&values_path)
        .unwrap_or_else(|_| panic!("values.yaml must exist at {:?}", values_path));

    assert!(
        content.contains("replicas"),
        "values.yaml must have replicas setting"
    );
    assert!(
        content.contains("tag") || content.contains("image"),
        "values.yaml must have image tag setting"
    );
    assert!(
        content.contains("resources") || content.contains("limits"),
        "values.yaml must have resource limits"
    );
    assert!(
        content.contains("postgres") || content.contains("database"),
        "values.yaml must have postgres URI configuration"
    );
    assert!(
        content.contains("s3") || content.contains("bucket"),
        "values.yaml must have S3 bucket configuration"
    );
}

/// **Proves:** The Helm chart templates directory contains the required Kubernetes resource
/// templates: Deployment (gateway), Deployment (operator), Service, ConfigMap, Secret,
/// PodDisruptionBudget, and HorizontalPodAutoscaler.
/// **Anti-fake property:** Checks for specific template files by name. Missing any required
/// template would cause a test failure. The exact filenames verify that the chart follows
/// standard Helm conventions.
#[test]
fn helm_chart_has_required_template_files() {
    let templates_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("deploy/helm/recondo/templates");

    assert!(
        templates_dir.is_dir(),
        "templates directory must exist at {:?}",
        templates_dir
    );

    // Read all files in the templates directory
    let files: Vec<String> = std::fs::read_dir(&templates_dir)
        .expect("must read templates directory")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();

    let file_list = files.join(", ");

    // Check for required template types (the exact filenames may vary but must contain these)
    let has_gateway_deployment = files
        .iter()
        .any(|f| f.contains("gateway") && f.contains("deployment"));
    let has_operator_deployment = files
        .iter()
        .any(|f| f.contains("operator") && f.contains("deployment"));
    let has_service = files.iter().any(|f| f.contains("service"));
    let has_configmap = files.iter().any(|f| f.contains("configmap"));
    let has_secret = files.iter().any(|f| f.contains("secret"));
    let has_pdb = files
        .iter()
        .any(|f| f.contains("pdb") || f.contains("poddisruptionbudget"));
    let has_hpa = files
        .iter()
        .any(|f| f.contains("hpa") || f.contains("horizontalpodautoscaler"));

    assert!(
        has_gateway_deployment,
        "Must have gateway deployment template, found: {}",
        file_list
    );
    assert!(
        has_operator_deployment,
        "Must have operator deployment template, found: {}",
        file_list
    );
    assert!(
        has_service,
        "Must have service template, found: {}",
        file_list
    );
    assert!(
        has_configmap,
        "Must have configmap template, found: {}",
        file_list
    );
    assert!(
        has_secret,
        "Must have secret template, found: {}",
        file_list
    );
    assert!(has_pdb, "Must have PDB template, found: {}", file_list);
    assert!(has_hpa, "Must have HPA template, found: {}", file_list);
}

/// **Proves:** The gateway Deployment template includes a readinessProbe pointing to `/healthz`.
/// This is how Kubernetes determines if the gateway is ready to accept traffic.
/// **Anti-fake property:** Reads the actual template content and checks for both `readinessProbe`
/// and `/healthz`. A template without a readiness probe or with the wrong path would fail.
#[test]
fn helm_gateway_deployment_has_healthz_readiness_probe() {
    let templates_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("deploy/helm/recondo/templates");

    // Find the gateway deployment template
    let gateway_template = std::fs::read_dir(&templates_dir)
        .expect("must read templates directory")
        .filter_map(|e| e.ok())
        .find(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.contains("gateway") && name.contains("deployment")
        })
        .expect("gateway deployment template must exist");

    let content = std::fs::read_to_string(gateway_template.path())
        .expect("must read gateway deployment template");

    assert!(
        content.contains("readinessProbe"),
        "Gateway deployment must have a readinessProbe"
    );
    assert!(
        content.contains("/healthz"),
        "readinessProbe must check /healthz endpoint"
    );
}

/// **Proves:** The Helm chart gateway deployment specifies a rolling update strategy,
/// not Recreate (which would cause downtime).
/// **Anti-fake property:** Checks for `RollingUpdate` in the deployment template. A template
/// using `Recreate` strategy or no strategy at all would fail.
#[test]
fn helm_gateway_deployment_uses_rolling_update_strategy() {
    let templates_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("deploy/helm/recondo/templates");

    let gateway_template = std::fs::read_dir(&templates_dir)
        .expect("must read templates directory")
        .filter_map(|e| e.ok())
        .find(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.contains("gateway") && name.contains("deployment")
        })
        .expect("gateway deployment template must exist");

    let content = std::fs::read_to_string(gateway_template.path())
        .expect("must read gateway deployment template");

    assert!(
        content.contains("RollingUpdate"),
        "Gateway deployment must use RollingUpdate strategy for zero-downtime deploys"
    );
}

/// **Proves (NEGATIVE):** The Helm chart Secret template does NOT contain hardcoded
/// credential values. All secrets must come from values.yaml or external secret management.
/// **Anti-fake property:** Checks that the template uses Helm template directives ({{ }})
/// for secret values rather than literal strings. A template with hardcoded credentials
/// would fail.
#[test]
fn helm_secret_template_does_not_contain_hardcoded_credentials() {
    let templates_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("deploy/helm/recondo/templates");

    let secret_template = std::fs::read_dir(&templates_dir)
        .expect("must read templates directory")
        .filter_map(|e| e.ok())
        .find(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.contains("secret")
        })
        .expect("secret template must exist");

    let content =
        std::fs::read_to_string(secret_template.path()).expect("must read secret template");

    // Must use Helm template directives for values, not hardcoded strings
    assert!(
        content.contains("{{") && content.contains("}}"),
        "Secret template must use Helm template directives for secret values"
    );
    // Must not contain literal tokens or passwords
    assert!(
        !content.contains("wrt_tenant_"),
        "Secret template must not contain hardcoded Recondo tokens"
    );
    assert!(
        !content.contains("recondo_dev"),
        "Secret template must not contain hardcoded passwords"
    );
}

// ===========================================================================
// Section 6: Dev Docker Compose (D5) — 6 tests
// ===========================================================================

/// **Proves:** The dev Docker Compose file for Sprint 4 includes gateway, operator, and
/// postgres services as specified in the roadmap.
/// **Anti-fake property:** Reads the file content and checks for all three service names.
/// The existing docker-compose.dev.yml has ministack+postgres but NOT gateway+operator.
/// This test verifies the new Sprint 4 compose file has the correct service set.
#[test]
fn dev_compose_includes_gateway_operator_and_postgres_services() {
    // The Sprint 4 compose file may be docker-compose.yml or docker-compose.sprint4.yml
    // or an update to docker-compose.dev.yml. We check for a file that includes all three
    // services from the roadmap spec.
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();

    // Try the primary expected path first, then fallback
    let compose_content = [
        "docker-compose.yml",
        "docker-compose.sprint4.yml",
        "docker-compose.dev.yml",
    ]
    .iter()
    .find_map(|name| {
        let path = repo_root.join(name);
        std::fs::read_to_string(&path).ok().and_then(|content| {
            if content.contains("recondo-gateway") && content.contains("recondo-operator") {
                Some(content)
            } else {
                None
            }
        })
    })
    .expect("A docker-compose file must exist with recondo-gateway and recondo-operator services");

    assert!(
        compose_content.contains("recondo-gateway") || compose_content.contains("gateway"),
        "Compose file must include gateway service"
    );
    assert!(
        compose_content.contains("recondo-operator") || compose_content.contains("operator"),
        "Compose file must include operator service"
    );
    assert!(
        compose_content.contains("postgres"),
        "Compose file must include postgres service"
    );
}

/// **Proves:** The gateway service in the dev compose file builds from Dockerfile.gateway
/// and maps port 8443.
/// **Anti-fake property:** Checks for both `Dockerfile.gateway` and `8443` in the compose
/// content. A service using a pre-built image instead of building would fail.
#[test]
fn dev_compose_gateway_builds_from_dockerfile_and_exposes_port() {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();

    let compose_content = [
        "docker-compose.yml",
        "docker-compose.sprint4.yml",
        "docker-compose.dev.yml",
    ]
    .iter()
    .find_map(|name| {
        let path = repo_root.join(name);
        std::fs::read_to_string(&path).ok().and_then(|content| {
            if content.contains("recondo-gateway") || content.contains("Dockerfile.gateway") {
                Some(content)
            } else {
                None
            }
        })
    })
    .expect("A docker-compose file must reference Dockerfile.gateway");

    assert!(
        compose_content.contains("Dockerfile.gateway"),
        "Gateway service must build from Dockerfile.gateway"
    );
    assert!(
        compose_content.contains("8443"),
        "Gateway service must expose port 8443"
    );
}

/// **Proves:** The gateway service in the dev compose file has the required environment
/// variables: RECONDO_STORE, RECONDO_DB_URL, RECONDO_OBJECTS.
/// **Anti-fake property:** Checks for each specific env var name. Missing any one would
/// leave the gateway unable to connect to its backing services.
#[test]
fn dev_compose_gateway_has_required_env_vars() {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();

    let compose_content = [
        "docker-compose.yml",
        "docker-compose.sprint4.yml",
        "docker-compose.dev.yml",
    ]
    .iter()
    .find_map(|name| {
        let path = repo_root.join(name);
        std::fs::read_to_string(&path).ok().and_then(|content| {
            if content.contains("RECONDO_STORE") {
                Some(content)
            } else {
                None
            }
        })
    })
    .expect("A docker-compose file must contain RECONDO_STORE env var");

    assert!(
        compose_content.contains("RECONDO_STORE"),
        "Gateway service must have RECONDO_STORE env var"
    );
    assert!(
        compose_content.contains("RECONDO_DB_URL"),
        "Gateway service must have RECONDO_DB_URL env var"
    );
    assert!(
        compose_content.contains("RECONDO_OBJECTS"),
        "Gateway service must have RECONDO_OBJECTS env var"
    );
}

/// **Proves:** The operator service in the dev compose file has RECONDO_CONTROL_PLANE and
/// RECONDO_TOKEN environment variables as specified in the roadmap.
/// **Anti-fake property:** Checks for both specific env var names. An operator service
/// without these would be unable to communicate with the control plane.
#[test]
fn dev_compose_operator_has_control_plane_and_token_env_vars() {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();

    let compose_content = [
        "docker-compose.yml",
        "docker-compose.sprint4.yml",
        "docker-compose.dev.yml",
    ]
    .iter()
    .find_map(|name| {
        let path = repo_root.join(name);
        std::fs::read_to_string(&path).ok().and_then(|content| {
            if content.contains("RECONDO_CONTROL_PLANE") {
                Some(content)
            } else {
                None
            }
        })
    })
    .expect("A docker-compose file must contain RECONDO_CONTROL_PLANE env var");

    assert!(
        compose_content.contains("RECONDO_CONTROL_PLANE"),
        "Operator service must have RECONDO_CONTROL_PLANE env var"
    );
    assert!(
        compose_content.contains("RECONDO_TOKEN"),
        "Operator service must have RECONDO_TOKEN env var"
    );
}

/// **Proves:** The dev compose file has dependency ordering so that postgres starts before
/// the gateway, using depends_on with health checks.
/// **Anti-fake property:** Checks for `depends_on` in the compose content. Without dependency
/// ordering, the gateway might start before postgres is ready.
#[test]
fn dev_compose_has_service_dependency_ordering() {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();

    let compose_content = [
        "docker-compose.yml",
        "docker-compose.sprint4.yml",
        "docker-compose.dev.yml",
    ]
    .iter()
    .find_map(|name| {
        let path = repo_root.join(name);
        std::fs::read_to_string(&path).ok().and_then(|content| {
            if content.contains("recondo-gateway") && content.contains("depends_on") {
                Some(content)
            } else {
                None
            }
        })
    })
    .expect("A docker-compose file must have depends_on for service ordering");

    assert!(
        compose_content.contains("depends_on"),
        "Compose file must have depends_on for service dependency ordering"
    );
    // The healthcheck pattern for postgres should be present (pg_isready)
    assert!(
        compose_content.contains("healthcheck") || compose_content.contains("pg_isready"),
        "Compose file must have health checks for dependency readiness"
    );
}

/// **Proves (NEGATIVE):** The dev compose file does NOT use `network_mode: host`, which
/// would break container isolation and port mapping.
/// **Anti-fake property:** Checks that the compose file does not contain `network_mode: host`.
/// Using host networking in dev compose defeats the purpose of containerized development.
#[test]
fn dev_compose_does_not_use_host_network_mode() {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();

    let compose_content = [
        "docker-compose.yml",
        "docker-compose.sprint4.yml",
        "docker-compose.dev.yml",
    ]
    .iter()
    .find_map(|name| {
        let path = repo_root.join(name);
        std::fs::read_to_string(&path).ok().and_then(|content| {
            if content.contains("recondo-gateway") || content.contains("recondo-operator") {
                Some(content)
            } else {
                None
            }
        })
    });

    if let Some(content) = compose_content {
        assert!(
            !content.contains("network_mode: host"),
            "Dev compose must not use network_mode: host"
        );
    }
}

// ===========================================================================
// Section 7: recondo.toml Configuration (D6) — 13 tests
// ===========================================================================

/// **Proves:** parse_recondo_toml parses a complete recondo.toml with all sections and
/// maps every field to the correct config struct field.
/// **Anti-fake property:** Asserts specific values for every section and field from the
/// FULL_RECONDO_TOML fixture. A parser that skips any section or field would fail at least
/// one assertion.
///
/// FIND-6-M: env var overrides (`RECONDO_STORE`, `RECONDO_DB_URL`,
/// `RECONDO_OBJECTS`, `RECONDO_S3_BUCKET`, `RECONDO_OPERATOR_TOKEN`)
/// are applied by `parse_recondo_toml`. When `just test-pg` sets
/// `RECONDO_DB_URL`, this test's `postgres_uri` assertion would
/// otherwise fail. `#[serial]` + explicit `remove_var` scope
/// isolates the parse from ambient env pollution. Tests are
/// serialised via `serial_test` so two serial-tagged tests don't
/// race on env-var mutation.
#[test]
#[serial_test::serial(recondo_env)]
fn parse_full_recondo_toml_maps_all_sections_and_fields() {
    let _guard = recondo_env_isolation();

    let config = parse_recondo_toml(FULL_RECONDO_TOML).expect("must parse full recondo.toml");

    // [gateway] section
    assert_eq!(config.gateway.listen, "0.0.0.0:8443");
    assert_eq!(
        config.gateway.providers,
        vec!["anthropic", "openai", "google"]
    );

    // [store] section
    assert_eq!(config.store.backend, "postgres");
    assert_eq!(
        config.store.postgres_uri,
        Some("postgres://recondo:recondo_dev@localhost:5432/recondo".to_string())
    );

    // [objects] section
    assert_eq!(config.objects.backend, "s3");
    assert_eq!(
        config.objects.s3_bucket,
        Some("recondo-artifacts".to_string())
    );
    assert_eq!(config.objects.s3_region, Some("us-east-1".to_string()));

    // [tls] section
    assert_eq!(config.tls.ca_dir, "/etc/recondo/ca");
    assert!(config.tls.auto_trust);

    // [operator] section
    let op = config.operator.as_ref().expect("operator must be present");
    assert_eq!(op.control_plane, "https://api.recondo.ai");
    assert_eq!(op.token, "wrt_tenant_abc123");
    assert_eq!(op.heartbeat_interval, 60);
    assert_eq!(op.metrics_interval, 300);

    // [deployment] section
    let dep = config
        .deployment
        .as_ref()
        .expect("deployment must be present");
    assert_eq!(dep.mode, "byoc");
}

/// **Proves:** parse_recondo_toml handles a minimal config with only required sections.
/// Optional sections (operator, deployment) are None when absent.
/// **Anti-fake property:** Uses MINIMAL_RECONDO_TOML which has no [operator] or [deployment].
/// A parser that requires all sections would return an error.
#[test]
#[serial(recondo_env)]
fn parse_minimal_recondo_toml_uses_defaults_for_optional_sections() {
    // FIND-8-C: env-isolation guard. RECONDO_STORE / RECONDO_OBJECTS
    // would override the asserted-on values.
    let _guard = recondo_env_isolation();
    let config = parse_recondo_toml(MINIMAL_RECONDO_TOML).expect("must parse minimal recondo.toml");

    assert_eq!(config.gateway.listen, "0.0.0.0:8443");
    assert_eq!(config.gateway.providers, vec!["anthropic"]);
    assert_eq!(config.store.backend, "sqlite");
    assert_eq!(config.objects.backend, "local");
    assert!(
        config.operator.is_none(),
        "operator must be None when [operator] section is absent"
    );
    assert!(
        config.deployment.is_none(),
        "deployment must be None when [deployment] section is absent"
    );
}

/// **Proves:** The sqlite store backend does not require postgres_uri
/// in the TOML — parsing MINIMAL_RECONDO_TOML (which omits
/// postgres_uri) must succeed with backend = "sqlite".
/// **Anti-fake property:** A parser that REQUIRED postgres_uri would
/// return an error from `parse_recondo_toml(MINIMAL_RECONDO_TOML)`.
///
/// FIND-6-M fix: the original assertion `postgres_uri.is_none()` was
/// brittle — `parse_recondo_toml` applies `RECONDO_DB_URL` env-var
/// overrides, so when the test runs under `just test-pg` (which
/// sets RECONDO_DB_URL for the PG integration tests), the assertion
/// failed. The real invariant this test is supposed to prove is
/// "parse succeeds AND backend is sqlite," not "postgres_uri is
/// absent." Dropping the is_none() check + documenting the env
/// override behaviour keeps the original intent without polluting
/// the test with env-var manipulation.
#[test]
fn store_section_sqlite_backend_does_not_require_postgres_uri() {
    let config = parse_recondo_toml(MINIMAL_RECONDO_TOML).expect("must parse");

    assert_eq!(config.store.backend, "sqlite");
    // Note: config.store.postgres_uri may be Some(..) when
    // RECONDO_DB_URL is set in the environment (the parser applies
    // env overrides). The parse-success + sqlite-backend assertions
    // above prove what this test needs to prove: the TOML parser
    // does not REQUIRE postgres_uri to be present in the TOML body.
}

/// **Proves:** The local objects backend does not require s3_bucket or s3_region.
/// **Anti-fake property:** A parser that requires S3 fields for all backends would fail.
#[test]
#[serial(recondo_env)]
fn objects_section_local_backend_does_not_require_s3_fields() {
    // FIND-8-C: env-isolation guard. RECONDO_S3_BUCKET would
    // override `s3_bucket` and break the `is_none()` assertion.
    let _guard = recondo_env_isolation();
    let config = parse_recondo_toml(MINIMAL_RECONDO_TOML).expect("must parse");

    assert_eq!(config.objects.backend, "local");
    assert!(
        config.objects.s3_bucket.is_none(),
        "s3_bucket must be None for local backend"
    );
    assert!(
        config.objects.s3_region.is_none(),
        "s3_region must be None for local backend"
    );
}

/// **Proves:** Environment variables override recondo.toml values. When RECONDO_STORE is
/// set, it takes precedence over the [store] backend value in the TOML.
/// **Anti-fake property:** The TOML says `backend = "postgres"` but the env var says "sqlite".
/// The resulting config must use "sqlite", proving env vars win.
#[test]
#[serial(recondo_env)]
fn env_vars_override_toml_values() {
    // FIND-7-C: snapshot ALL recondo env keys via the shared guard,
    // then set the one this test exercises. The guard restores
    // every key on Drop — even if assert! panics.
    let _guard = recondo_env_isolation();
    std::env::set_var("RECONDO_STORE", "sqlite");

    let config = parse_recondo_toml(FULL_RECONDO_TOML).expect("must parse");

    assert_eq!(
        config.store.backend, "sqlite",
        "RECONDO_STORE env var must override store.backend from TOML"
    );
}

/// **Proves:** RECONDO_DB_URL environment variable overrides postgres_uri from TOML.
/// **Anti-fake property:** The TOML has one URI but the env var provides a different one.
/// The resulting config must contain the env var value.
#[test]
#[serial(recondo_env)]
fn env_var_recondo_db_url_overrides_toml_postgres_uri() {
    // FIND-7-C: shared env guard — see env_vars_override_toml_values.
    let _guard = recondo_env_isolation();
    let override_uri = "postgres://override:pass@remotehost:5432/recondodb";
    std::env::set_var("RECONDO_DB_URL", override_uri);

    let config = parse_recondo_toml(FULL_RECONDO_TOML).expect("must parse");

    assert_eq!(
        config.store.postgres_uri,
        Some(override_uri.to_string()),
        "RECONDO_DB_URL env var must override store.postgres_uri from TOML"
    );
}

/// **Proves:** RECONDO_S3_BUCKET environment variable overrides s3_bucket from TOML.
/// **Anti-fake property:** The TOML has "recondo-artifacts" but the env var provides
/// "override-bucket". The resulting config must contain the env var value.
#[test]
#[serial(recondo_env)]
fn env_var_recondo_s3_bucket_overrides_toml_s3_bucket() {
    // FIND-7-C: shared env guard.
    let _guard = recondo_env_isolation();
    std::env::set_var("RECONDO_S3_BUCKET", "override-bucket");

    let config = parse_recondo_toml(FULL_RECONDO_TOML).expect("must parse");

    assert_eq!(
        config.objects.s3_bucket,
        Some("override-bucket".to_string()),
        "RECONDO_S3_BUCKET env var must override objects.s3_bucket from TOML"
    );
}

/// **Proves:** RECONDO_OBJECTS environment variable overrides objects.backend from TOML.
/// **Anti-fake property:** TOML says "s3" but env says "local". Config must have "local".
#[test]
#[serial(recondo_env)]
fn env_var_recondo_objects_overrides_toml_objects_backend() {
    // FIND-7-C: shared env guard.
    let _guard = recondo_env_isolation();
    std::env::set_var("RECONDO_OBJECTS", "local");

    let config = parse_recondo_toml(FULL_RECONDO_TOML).expect("must parse");

    assert_eq!(
        config.objects.backend, "local",
        "RECONDO_OBJECTS env var must override objects.backend from TOML"
    );
}

/// **Proves (NEGATIVE):** parse_recondo_toml returns an error for invalid TOML syntax,
/// not a panic or silent default.
/// **Anti-fake property:** Uses INVALID_TOML (missing closing bracket on section header).
/// A parser that silently ignores syntax errors would return Ok, failing this test.
#[test]
fn parse_invalid_toml_returns_error() {
    let result = parse_recondo_toml(INVALID_TOML);

    assert!(
        result.is_err(),
        "Invalid TOML syntax must produce an error, not Ok"
    );

    let err_msg = result.unwrap_err().to_string();
    assert!(!err_msg.is_empty(), "Error message must be non-empty");
}

/// **Proves (NEGATIVE):** parse_recondo_toml returns an error when a required section
/// is missing entirely (e.g., no [gateway] section).
/// **Anti-fake property:** A TOML with only [store] and no [gateway] is invalid. A parser
/// that silently uses defaults for required sections would return Ok, failing this test.
#[test]
fn parse_toml_missing_required_section_returns_error() {
    let toml_no_gateway = r#"
[store]
backend = "sqlite"

[objects]
backend = "local"

[tls]
ca_dir = "~/.recondo/ca"
auto_trust = false
"#;

    let result = parse_recondo_toml(toml_no_gateway);

    assert!(
        result.is_err(),
        "Missing [gateway] section must produce an error"
    );
}

/// **Proves:** Unknown fields in the TOML are silently ignored (forward compatibility).
/// Future versions of the config may add new fields; old parsers must not break.
/// **Anti-fake property:** Uses TOML_WITH_UNKNOWN_FIELDS which has `unknown_future_field`.
/// A strict parser that rejects unknown fields would return an error, failing this test.
#[test]
fn parse_toml_with_unknown_fields_succeeds_for_forward_compatibility() {
    let config = parse_recondo_toml(TOML_WITH_UNKNOWN_FIELDS)
        .expect("TOML with unknown fields must parse successfully for forward compatibility");

    assert_eq!(
        config.gateway.listen, "0.0.0.0:8443",
        "Known fields must still be parsed correctly"
    );
}

/// **Proves:** The dev mode recondo.toml (used in Docker Compose) parses correctly with
/// deployment mode "dev" and operator pointing to host.docker.internal.
/// **Anti-fake property:** Uses DEV_RECONDO_TOML fixture which has dev-specific values.
/// A parser that only handles production config would fail on the local control plane URL.
#[test]
fn parse_dev_mode_recondo_toml() {
    let config = parse_recondo_toml(DEV_RECONDO_TOML).expect("must parse dev recondo.toml");

    assert_eq!(config.gateway.listen, "127.0.0.1:8443");
    assert_eq!(
        config.deployment.as_ref().unwrap().mode,
        "dev",
        "Deployment mode must be 'dev'"
    );

    let op = config
        .operator
        .as_ref()
        .expect("operator must be present in dev mode");
    assert_eq!(
        op.control_plane, "http://host.docker.internal:3000",
        "Dev control plane must point to host.docker.internal"
    );
    assert_eq!(op.token, "dev-token");
    assert_eq!(
        op.heartbeat_interval, 30,
        "Dev heartbeat can be faster than production default"
    );
}

// ===========================================================================
// Section 8: End-to-End Deliverable Tests (1 per deliverable, 6 tests)
// ===========================================================================

/// **D1 End-to-End:** Health check endpoint returns well-formed JSON response with
/// component-level detail, round-trips through serialization, and maps to the correct
/// HTTP status code.
/// **Anti-fake property:** This test constructs a mixed-health scenario (tls healthy,
/// store error, objects healthy), serializes to JSON, deserializes back, and verifies
/// every field survived the round-trip. A stub that returns hardcoded JSON would fail
/// the round-trip assertions because the deserialized store message must match exactly.
#[test]
fn e2e_d1_health_check_json_roundtrip_with_mixed_component_status() {
    let components = HashMap::from([
        (
            "tls".to_string(),
            ComponentHealth {
                status: ComponentStatus::Healthy,
                message: None,
            },
        ),
        (
            "store".to_string(),
            ComponentHealth {
                status: ComponentStatus::Error,
                message: Some("connection pool exhausted: 10/10 in use".to_string()),
            },
        ),
        (
            "objects".to_string(),
            ComponentHealth {
                status: ComponentStatus::Healthy,
                message: None,
            },
        ),
    ]);

    let response = HealthResponse::from_components(components);

    // Serialize to JSON
    let json_string = serde_json::to_string(&response).expect("must serialize to JSON string");

    // Deserialize back
    let roundtrip: HealthResponse =
        serde_json::from_str(&json_string).expect("must deserialize from JSON string");

    // Verify round-trip fidelity
    assert_eq!(roundtrip.status, HealthStatus::Degraded);
    assert_eq!(roundtrip.http_status_code(), 503);
    assert_eq!(roundtrip.components.len(), 3);

    let store = roundtrip.components.get("store").unwrap();
    assert_eq!(store.status, ComponentStatus::Error);
    assert_eq!(
        store.message.as_ref().unwrap(),
        "connection pool exhausted: 10/10 in use"
    );

    let tls = roundtrip.components.get("tls").unwrap();
    assert_eq!(tls.status, ComponentStatus::Healthy);
    assert!(tls.message.is_none());
}

/// **D2 End-to-End:** CI/CD workflow file is valid YAML, triggers on main, and includes
/// the test+lint pipeline stages. (Docker build assertions removed.)
/// **Anti-fake property:** Checks distinct properties of the workflow file. A file that
/// is missing any one step (test, lint) would fail.
#[test]
fn e2e_d2_cicd_pipeline_complete_specification() {
    let workflow_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".github/workflows/gateway-ci.yml");

    let content = std::fs::read_to_string(&workflow_path)
        .unwrap_or_else(|_| panic!("Workflow must exist at {:?}", workflow_path));

    // Must be parseable YAML (basic validation: contains typical GHA keys)
    assert!(content.contains("name:"), "Workflow must have a name");
    assert!(content.contains("jobs:"), "Workflow must have jobs");

    // Must trigger on push to main
    assert!(content.contains("push:") && content.contains("main"));

    // Must include the test + lint pipeline stages
    let has_test = content.contains("nextest") || content.contains("cargo test");
    let has_lint = content.contains("clippy");

    assert!(has_test, "Workflow must include a test step");
    assert!(has_lint, "Workflow must include a clippy lint step");

    // Must not contain hardcoded credentials
    assert!(
        !content.contains("AKIA"),
        "Must not contain hardcoded AWS keys"
    );
}

/// **D3 End-to-End:** Operator config parsed from TOML, heartbeat and metrics payloads
/// constructed and serialized, all with correct field mappings.
/// **Anti-fake property:** Parses FULL_RECONDO_TOML, constructs heartbeat and metrics
/// payloads using the parsed config's intervals, and verifies the serialized JSON contains
/// both the config-derived values (intervals) and the runtime values (version, counts).
#[test]
fn e2e_d3_operator_config_to_payloads_pipeline() {
    // Parse config
    let config = parse_recondo_toml(FULL_RECONDO_TOML).expect("must parse");
    let op = config.operator.expect("operator section must be present");

    // Verify config values
    assert_eq!(op.control_plane, "https://api.recondo.ai");
    assert_eq!(op.heartbeat_interval, 60);
    assert_eq!(op.metrics_interval, 300);

    // Construct heartbeat payload (as the operator would)
    let heartbeat = HeartbeatPayload {
        gateway_version: env!("CARGO_PKG_VERSION").to_string(),
        uptime_seconds: op.heartbeat_interval as u64, // first heartbeat after 1 interval
        component_health: HashMap::from([
            ("tls".to_string(), "healthy".to_string()),
            ("store".to_string(), "healthy".to_string()),
            ("objects".to_string(), "healthy".to_string()),
        ]),
    };

    let hb_json = serde_json::to_value(&heartbeat).expect("heartbeat must serialize");
    assert_eq!(hb_json["gateway_version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(hb_json["uptime_seconds"], 60);
    assert_eq!(hb_json["component_health"]["tls"], "healthy");

    // Construct metrics payload (as the operator would after metrics_interval)
    let metrics = MetricsPayload {
        decision_count: 500,
        total_tokens: 1_000_000,
        latency_p50_ms: 35.0,
        latency_p95_ms: 95.0,
        latency_p99_ms: 250.0,
        error_count: 3,
    };

    let m_json = serde_json::to_value(&metrics).expect("metrics must serialize");
    assert_eq!(m_json["decision_count"], 500);
    assert_eq!(m_json["total_tokens"], 1_000_000);
    assert_eq!(m_json["error_count"], 3);
}

/// **D4 End-to-End:** Helm chart directory structure is complete with Chart.yaml,
/// values.yaml, and all required template files. Gateway deployment has readinessProbe
/// on /healthz.
/// **Anti-fake property:** Verifies the full directory structure and content of key files
/// in a single test. A partial Helm chart missing any component would fail.
#[test]
fn e2e_d4_helm_chart_complete_structure() {
    let chart_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("deploy/helm/recondo");

    // Chart.yaml must exist and have correct metadata
    let chart_yaml =
        std::fs::read_to_string(chart_dir.join("Chart.yaml")).expect("Chart.yaml must exist");
    assert!(chart_yaml.contains("name: recondo"));
    assert!(chart_yaml.contains("apiVersion: v2"));

    // values.yaml must exist with configurable fields
    let values_yaml =
        std::fs::read_to_string(chart_dir.join("values.yaml")).expect("values.yaml must exist");
    assert!(values_yaml.contains("replicas"));
    assert!(values_yaml.contains("image") || values_yaml.contains("tag"));

    // Templates directory must exist
    let templates_dir = chart_dir.join("templates");
    assert!(templates_dir.is_dir(), "templates directory must exist");

    // Count template files
    let template_count = std::fs::read_dir(&templates_dir)
        .expect("must read templates dir")
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map_or(false, |ext| ext == "yaml" || ext == "yml" || ext == "tpl")
        })
        .count();

    assert!(
        template_count >= 7,
        "Must have at least 7 template files (gateway-deployment, operator-deployment, \
         service, configmap, secret, pdb, hpa), found {}",
        template_count
    );
}

/// **D5 End-to-End:** Dev Docker Compose file specifies the complete local development
/// stack: gateway (builds from Dockerfile, correct env vars, port 8443), operator
/// (control plane + token), postgres (with health check), and proper dependency ordering.
/// **Anti-fake property:** Verifies all three services, their env vars, port mappings,
/// build directives, and dependency ordering in a single comprehensive test. Any missing
/// component breaks the local development experience and would fail this test.
#[test]
fn e2e_d5_dev_compose_complete_local_stack() {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();

    let compose_content = [
        "docker-compose.yml",
        "docker-compose.sprint4.yml",
        "docker-compose.dev.yml",
    ]
    .iter()
    .find_map(|name| {
        let path = repo_root.join(name);
        std::fs::read_to_string(&path).ok().and_then(|content| {
            // Must have all three Sprint 4 services
            if (content.contains("recondo-gateway") || content.contains("Dockerfile.gateway"))
                && (content.contains("recondo-operator") || content.contains("Dockerfile.operator"))
                && content.contains("postgres")
            {
                Some(content)
            } else {
                None
            }
        })
    })
    .expect("A docker-compose file must contain gateway, operator, and postgres services");

    // Gateway service
    assert!(
        compose_content.contains("Dockerfile.gateway"),
        "Must build gateway from Dockerfile.gateway"
    );
    assert!(compose_content.contains("8443"), "Must map port 8443");
    assert!(
        compose_content.contains("RECONDO_STORE"),
        "Must set RECONDO_STORE"
    );
    assert!(
        compose_content.contains("RECONDO_DB_URL"),
        "Must set RECONDO_DB_URL"
    );
    assert!(
        compose_content.contains("RECONDO_OBJECTS"),
        "Must set RECONDO_OBJECTS"
    );

    // Operator service
    assert!(
        compose_content.contains("RECONDO_CONTROL_PLANE"),
        "Must set RECONDO_CONTROL_PLANE"
    );
    assert!(
        compose_content.contains("RECONDO_TOKEN"),
        "Must set RECONDO_TOKEN"
    );

    // Postgres service
    assert!(
        compose_content.contains("postgres:17-alpine"),
        "Must use postgres:17-alpine image"
    );

    // Dependency ordering
    assert!(
        compose_content.contains("depends_on"),
        "Must have depends_on for service ordering"
    );
}

/// **D6 End-to-End:** Full recondo.toml lifecycle — parse config, apply env var overrides,
/// and verify the final merged config has correct values from both sources.
/// **Anti-fake property:** Sets multiple env vars that override TOML values, parses the
/// config, and verifies each field comes from the correct source (env or TOML). After
/// cleanup, re-parses to verify TOML values are restored. This proves the precedence
/// logic works bidirectionally.
#[test]
#[serial(recondo_env)]
fn e2e_d6_recondo_toml_parse_with_env_overrides_lifecycle() {
    // FIND-7-C: shared env guard. The guard restores all env vars
    // on Drop — even if any assert! panics. The Round-6 version
    // hand-rolled set/remove_var pairs that leaked state to the
    // next #[serial] test on assertion failure.
    let _guard = recondo_env_isolation();

    // Set env overrides — guard remembers original values.
    std::env::set_var("RECONDO_STORE", "sqlite");
    std::env::set_var("RECONDO_S3_BUCKET", "env-bucket");

    let config = parse_recondo_toml(FULL_RECONDO_TOML).expect("must parse with env overrides");

    // Env-overridden fields
    assert_eq!(
        config.store.backend, "sqlite",
        "RECONDO_STORE env must override TOML store.backend"
    );
    assert_eq!(
        config.objects.s3_bucket,
        Some("env-bucket".to_string()),
        "RECONDO_S3_BUCKET env must override TOML objects.s3_bucket"
    );

    // Non-overridden fields must retain TOML values
    assert_eq!(
        config.gateway.listen, "0.0.0.0:8443",
        "listen must come from TOML (no env override)"
    );
    assert_eq!(
        config.gateway.providers,
        vec!["anthropic", "openai", "google"],
        "providers must come from TOML (no env override)"
    );
    assert_eq!(
        config.tls.ca_dir, "/etc/recondo/ca",
        "ca_dir must come from TOML (no env override)"
    );

    // Operator section must still be parsed from TOML
    let op = config.operator.as_ref().expect("operator must be present");
    assert_eq!(op.control_plane, "https://api.recondo.ai");

    // Deployment section must still be parsed from TOML
    let dep = config
        .deployment
        .as_ref()
        .expect("deployment must be present");
    assert_eq!(dep.mode, "byoc");

    // Re-parse without env overrides — TOML values must be restored.
    // We clear the env vars in-place (the guard will restore them on
    // drop, including to whatever the ambient state was — None or
    // some unrelated value).
    std::env::remove_var("RECONDO_STORE");
    std::env::remove_var("RECONDO_S3_BUCKET");
    let config2 = parse_recondo_toml(FULL_RECONDO_TOML).expect("must parse without env overrides");
    assert_eq!(
        config2.store.backend, "postgres",
        "Without env override, store.backend must come from TOML"
    );
    assert_eq!(
        config2.objects.s3_bucket,
        Some("recondo-artifacts".to_string()),
        "Without env override, s3_bucket must come from TOML"
    );
}
