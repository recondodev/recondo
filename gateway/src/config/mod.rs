//! Configuration parsing for `recondo.toml`.
//!
//! The gateway's configuration comes from two sources with a clear precedence:
//!
//! 1. **`recondo.toml`** — baseline configuration checked into the repo or
//!    mounted into the container.
//! 2. **Environment variables** — override individual fields at deploy time
//!    (e.g., `RECONDO_STORE`, `RECONDO_DB_URL`, `RECONDO_OBJECTS`,
//!    `RECONDO_S3_BUCKET`).
//!
//! Environment variables always win over TOML values.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// FailMode enum (OD-001)
// ---------------------------------------------------------------------------

/// Configurable failure mode for the gateway pipeline.
///
/// - `Open` (default): When the capture pipeline fails, traffic is still
///   forwarded to the LLM API. Audit data may be lost but agents are not blocked.
/// - `Closed`: When the capture pipeline fails, the gateway refuses to forward
///   the request. Ensures no un-audited traffic passes through.
///
/// Serializes/deserializes as lowercase strings: `"open"`, `"closed"`.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FailMode {
    /// Forward to LLM even if capture pipeline fails.
    #[default]
    Open,
    /// Block agent if capture pipeline fails.
    Closed,
}

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------

/// Parsed representation of the entire `recondo.toml` file.
///
/// NOTE: `deny_unknown_fields` must never be added to this struct (or any
/// config struct in this module). Future versions of `recondo.toml` may
/// contain fields that older gateway binaries do not recognise, and
/// rejecting them would break forward compatibility during rolling upgrades.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecondoConfig {
    /// Required: `[gateway]` section.
    pub gateway: GatewaySection,
    /// Required: `[store]` section.
    #[serde(default)]
    pub store: StoreSection,
    /// Required: `[objects]` section.
    #[serde(default)]
    pub objects: ObjectsSection,
    /// Required: `[tls]` section.
    #[serde(default)]
    pub tls: TlsSection,
    /// Optional: `[operator]` section — absent in minimal / dev configs.
    pub operator: Option<OperatorSection>,
    /// Optional: `[deployment]` section — absent when running locally.
    pub deployment: Option<DeploymentConfig>,
}

impl RecondoConfig {
    /// Apply environment-variable overrides on top of the parsed TOML values.
    ///
    /// The following env vars are recognised:
    /// - `RECONDO_STORE` -> `store.backend`
    /// - `RECONDO_DB_URL` -> `store.postgres_uri`
    /// - `RECONDO_OBJECTS` -> `objects.backend`
    /// - `RECONDO_S3_BUCKET` -> `objects.s3_bucket`
    pub fn with_env_overrides(mut self) -> Self {
        if let Ok(val) = std::env::var("RECONDO_STORE") {
            self.store.backend = val;
        }
        if let Ok(val) = std::env::var("RECONDO_DB_URL") {
            self.store.postgres_uri = Some(val);
        }
        if let Ok(val) = std::env::var("RECONDO_OBJECTS") {
            self.objects.backend = val;
        }
        if let Ok(val) = std::env::var("RECONDO_S3_BUCKET") {
            self.objects.s3_bucket = Some(val);
        }
        // W2 fix: Allow operator token to be overridden via environment variable.
        if let Ok(val) = std::env::var("RECONDO_OPERATOR_TOKEN") {
            if let Some(ref mut op) = self.operator {
                op.token = val;
            }
        }
        self
    }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/// `[gateway]` — core gateway settings.
///
/// NOTE: `deny_unknown_fields` must never be added — see [`RecondoConfig`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewaySection {
    /// TCP address and port to listen on (e.g., `"0.0.0.0:8443"`).
    pub listen: String,
    /// List of enabled LLM provider names (e.g., `["anthropic", "openai", "google"]`).
    pub providers: Vec<String>,
    /// Failure mode: `"open"` (default) or `"closed"`.
    /// Controls gateway behavior when the capture pipeline is unhealthy.
    #[serde(default)]
    pub fail_mode: FailMode,
}

/// `[store]` — capture metadata storage backend.
///
/// NOTE: `deny_unknown_fields` must never be added — see [`RecondoConfig`].
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct StoreSection {
    /// Storage backend: `"sqlite"` or `"postgres"`.
    #[serde(default)]
    pub backend: String,
    /// PostgreSQL connection URI (required when `backend = "postgres"`).
    /// Redacted in Debug output and serialization to prevent credential leakage.
    #[serde(default, skip_serializing)]
    pub postgres_uri: Option<String>,
}

impl std::fmt::Debug for StoreSection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoreSection")
            .field("backend", &self.backend)
            .field(
                "postgres_uri",
                &self.postgres_uri.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

/// `[objects]` — binary object storage backend (request/response bodies).
///
/// NOTE: `deny_unknown_fields` must never be added — see [`RecondoConfig`].
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ObjectsSection {
    /// Object storage backend: `"local"` or `"s3"`.
    #[serde(default)]
    pub backend: String,
    /// S3 bucket name (required when `backend = "s3"`).
    #[serde(default)]
    pub s3_bucket: Option<String>,
    /// S3 region (optional, defaults to AWS SDK default).
    #[serde(default)]
    pub s3_region: Option<String>,
}

/// `[tls]` — TLS / CA certificate configuration.
///
/// NOTE: `deny_unknown_fields` must never be added — see [`RecondoConfig`].
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TlsSection {
    /// Directory containing the gateway CA certificate and key.
    #[serde(default)]
    pub ca_dir: String,
    /// Whether to automatically trust the generated CA on the local system.
    #[serde(default)]
    pub auto_trust: bool,
}

/// `[operator]` — Recondo Operator connection settings.
///
/// NOTE: `deny_unknown_fields` must never be added to this struct (or any
/// config struct in this module). Future versions of `recondo.toml` may
/// contain fields that older gateway binaries do not recognise, and
/// rejecting them would break forward compatibility during rolling upgrades.
#[derive(Clone, Serialize, Deserialize)]
pub struct OperatorSection {
    /// Control plane URL (e.g., `"https://api.recondo.ai"`).
    pub control_plane: String,
    /// Authentication token for the control plane.
    /// Redacted in Debug output. Skipped during serialization to prevent leakage.
    #[serde(skip_serializing)]
    pub token: String,
    /// Heartbeat interval in seconds (default: 60).
    #[serde(default = "default_heartbeat_interval")]
    pub heartbeat_interval: u64,
    /// Metrics reporting interval in seconds (default: 300).
    #[serde(default = "default_metrics_interval")]
    pub metrics_interval: u64,
}

fn default_heartbeat_interval() -> u64 {
    60
}

fn default_metrics_interval() -> u64 {
    300
}

/// W1 fix: Custom Debug implementation that redacts the operator token to
/// prevent it from being leaked in log output or Debug-format strings.
impl std::fmt::Debug for OperatorSection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OperatorSection")
            .field("control_plane", &self.control_plane)
            .field("token", &"[REDACTED]")
            .field("heartbeat_interval", &self.heartbeat_interval)
            .field("metrics_interval", &self.metrics_interval)
            .finish()
    }
}

/// `[deployment]` — deployment mode metadata.
///
/// NOTE: `deny_unknown_fields` must never be added — see [`RecondoConfig`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentConfig {
    /// Deployment mode: `"byoc"`, `"dev"`, etc.
    pub mode: String,
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// An intermediate struct used to detect whether the required `[gateway]`
/// section is present. We deserialize into this first, then validate.
#[derive(Deserialize)]
struct RawRecondoConfig {
    gateway: Option<GatewaySectionRaw>,
    #[serde(default)]
    store: Option<StoreSection>,
    #[serde(default)]
    objects: Option<ObjectsSection>,
    #[serde(default)]
    tls: Option<TlsSection>,
    operator: Option<OperatorSection>,
    deployment: Option<DeploymentConfig>,
}

#[derive(Deserialize)]
struct GatewaySectionRaw {
    listen: String,
    providers: Vec<String>,
    #[serde(default)]
    fail_mode: FailMode,
}

/// Parse a `recondo.toml` string into a [`RecondoConfig`], applying
/// environment-variable overrides automatically.
///
/// # Errors
///
/// Returns an error when:
/// - The input is not valid TOML.
/// - The required `[gateway]` section is missing.
pub fn parse_recondo_toml(toml_str: &str) -> Result<RecondoConfig> {
    let raw: RawRecondoConfig = toml::from_str(toml_str)
        .map_err(|e| anyhow::anyhow!("failed to parse recondo.toml: {}", e))?;

    let gateway_raw = raw
        .gateway
        .context("missing required [gateway] section in recondo.toml")?;

    let config = RecondoConfig {
        gateway: GatewaySection {
            listen: gateway_raw.listen,
            providers: gateway_raw.providers,
            fail_mode: gateway_raw.fail_mode,
        },
        store: raw.store.unwrap_or_default(),
        objects: raw.objects.unwrap_or_default(),
        tls: raw.tls.unwrap_or_default(),
        operator: raw.operator,
        deployment: raw.deployment,
    };

    Ok(config.with_env_overrides())
}
