pub mod anthropic;
pub mod codex;
pub mod generic;
pub mod google;
#[cfg(any(test, feature = "test-support"))]
pub mod mock;
pub mod openai;
mod parse_drift;

use anyhow::Result;
use tracing::{info, warn};

use std::sync::OnceLock;

/// Lazily loaded generic YAML adapter configurations.
///
/// On first access, reads the file path from the `RECONDO_GENERIC_ADAPTER_CONFIG`
/// environment variable. If set and the file is valid YAML, the configs are
/// parsed and stored. If the env var is unset or the file is missing/invalid,
/// an empty list is returned.
///
/// ## Configuration file format
///
/// The YAML file should contain a top-level `adapters` array:
///
/// ```yaml
/// adapters:
///   - provider_name: "custom-llm"
///     detect_hosts: ["llm.internal.corp.com"]
///     request_mapping:
///       model_path: "model"
///       messages_path: "messages"
///     response_mapping:
///       response_text_path: "output.text"
///       model_path: "model"
///       stop_reason_path: "stop_reason"
///       input_tokens_path: "usage.input_tokens"
///       output_tokens_path: "usage.output_tokens"
/// ```
static GENERIC_CONFIGS: OnceLock<Vec<generic::YamlAdapterConfig>> = OnceLock::new();

/// Container for YAML-based generic adapter config file.
#[derive(serde::Deserialize)]
struct GenericConfigFile {
    #[serde(default)]
    adapters: Vec<generic::YamlAdapterConfig>,
}

/// Load generic adapter configurations from `RECONDO_GENERIC_ADAPTER_CONFIG`.
///
/// Returns the loaded configs (cached after first call). Returns an empty
/// slice if the env var is unset or the file cannot be read/parsed.
pub fn generic_adapter_configs() -> &'static [generic::YamlAdapterConfig] {
    GENERIC_CONFIGS.get_or_init(|| {
        let path = match std::env::var("RECONDO_GENERIC_ADAPTER_CONFIG") {
            Ok(p) if !p.is_empty() => p,
            _ => return Vec::new(),
        };
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                warn!(
                    path = %path,
                    error = %e,
                    "RECONDO_GENERIC_ADAPTER_CONFIG: failed to read config file"
                );
                return Vec::new();
            }
        };
        match serde_yaml::from_str::<GenericConfigFile>(&content) {
            Ok(file) => {
                info!(
                    count = file.adapters.len(),
                    path = %path,
                    "Loaded generic adapter config(s)"
                );
                file.adapters
            }
            Err(e) => {
                warn!(
                    path = %path,
                    error = %e,
                    "RECONDO_GENERIC_ADAPTER_CONFIG: failed to parse config file"
                );
                Vec::new()
            }
        }
    })
}

/// Check if a hostname matches any loaded generic adapter configuration.
///
/// Returns `Some(provider_name)` if a match is found, `None` otherwise.
pub fn detect_generic_provider(host: &str) -> Option<&'static str> {
    let hostname = match host.rsplit_once(':') {
        Some((h, port)) if port.chars().all(|c| c.is_ascii_digit()) => h,
        _ => host,
    };
    let lower = hostname.to_ascii_lowercase();

    for config in generic_adapter_configs() {
        if config
            .detect_hosts
            .iter()
            .any(|h| h.to_ascii_lowercase() == lower)
        {
            // SAFETY: The config lives in a OnceLock (static lifetime), so
            // returning &str from it is valid for 'static.
            return Some(leak_str(&config.provider_name));
        }
    }
    None
}

/// Intern a string to get a `&'static str`. Caches results so repeated calls
/// with the same string return the same pointer without leaking duplicates.
/// Used for provider names loaded from config at startup (typically 0-5 unique names).
fn leak_str(s: &str) -> &'static str {
    use std::collections::HashMap;
    use std::sync::Mutex;

    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, &'static str>>> =
        std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(&s) = map.get(s) {
        return s;
    }
    let leaked: &'static str = Box::leak(s.to_string().into_boxed_str());
    map.insert(s.to_string(), leaked);
    leaked
}

/// Detect the LLM provider from a hostname (as seen in an HTTP CONNECT request).
///
/// Handles port numbers (e.g. "api.anthropic.com:443") and is case-insensitive.
/// Returns "unknown" for unrecognized hosts. Also checks any loaded generic
/// YAML adapter configurations.
pub fn detect_provider(host: &str) -> &'static str {
    // Strip port if present
    let hostname = match host.rsplit_once(':') {
        Some((h, port)) if port.chars().all(|c| c.is_ascii_digit()) => h,
        _ => host,
    };

    let hostname_lower = hostname.to_ascii_lowercase();

    // Exact match only -- no partial/substring matching
    match hostname_lower.as_str() {
        "api.anthropic.com" => "anthropic",
        "api.openai.com" => "openai",
        "chatgpt.com" | "ab.chatgpt.com" => "openai",
        "generativelanguage.googleapis.com" => "google",
        _ => {
            // Gemini CLI uses regional cloudcode endpoints: cloudcode-{region}.googleapis.com
            // (e.g., cloudcode-pa, cloudcode-us-central1, cloudcode-europe-west1)
            if hostname_lower.starts_with("cloudcode-")
                && hostname_lower.ends_with(".googleapis.com")
            {
                return "google";
            }
            // R2-05: Check generic YAML adapter configs for custom providers.
            detect_generic_provider(host).unwrap_or("unknown")
        }
    }
}

/// A generic parsed request that any provider adapter can produce.
/// Used as the common return type for `ProviderAdapter::parse_request`.
#[derive(Debug, Clone)]
pub struct GenericParsedRequest {
    pub model: String,
    pub messages: Vec<serde_json::Value>,
    pub system: Option<String>,
    pub tools: Option<Vec<serde_json::Value>>,
    pub max_tokens: u64,
    /// Parse-drift errors recorded when the body's schema does not match
    /// the configured field paths (e.g. configured `messages_path` resolves
    /// but the value is not an array). `None` for well-formed inputs.
    /// Audit M1 (`docs/GATEWAY_AUDIT_2026_05_02.md`).
    pub parse_errors: Option<Vec<String>>,
}

/// A generic parsed response that any provider adapter can produce.
/// Used as the common return type for `ProviderAdapter::parse_response`
/// and `ProviderAdapter::parse_sse_events`.
///
/// R1-06 fix: Added `cache_read_tokens` and `cache_creation_tokens` fields
/// so that cache token data is not lost when routed through `ProviderAdapter`.
#[derive(Debug, Clone)]
pub struct GenericParsedResponse {
    pub response_text: String,
    pub model: String,
    pub stop_reason: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    /// Parse-drift errors recorded when the body's schema does not match
    /// the configured field paths. `None` for well-formed inputs.
    /// Audit M1 (`docs/GATEWAY_AUDIT_2026_05_02.md`).
    pub parse_errors: Option<Vec<String>>,
}

/// Trait defining a provider adapter that can detect hosts, parse requests,
/// and parse responses for a specific LLM provider.
///
/// Implementations exist for:
/// - `openai::OpenAiAdapter` — OpenAI Chat Completions API
/// - `generic::GenericAdapter` — YAML-configured custom providers
///
/// The Anthropic and Google adapters predate this trait and use their own
/// module-level functions (`anthropic::parse_request`, `google::parse_response`).
/// They can be wrapped in adapters if unified dispatch is needed later.
pub trait ProviderAdapter {
    /// Returns `true` if this adapter handles traffic to the given host/path.
    fn detect(&self, host: &str, path: &str) -> bool;

    /// Parse a JSON request body into a generic parsed request.
    fn parse_request(&self, body: &[u8]) -> Result<GenericParsedRequest>;

    /// Parse a JSON response body (non-streaming) into a generic parsed response.
    fn parse_response(&self, body: &[u8]) -> Result<GenericParsedResponse>;

    /// Parse SSE streaming events into a generic parsed response.
    fn parse_sse_events(&self, events: &str) -> Result<GenericParsedResponse>;
}
