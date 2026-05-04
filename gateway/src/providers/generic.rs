use anyhow::{anyhow, Result};
use serde::Deserialize;

use super::parse_drift::{
    extract_array_or_record_drift_dotted, extract_string_or_record_drift_dotted,
};
use super::ProviderAdapter;

/// Configuration for a generic YAML-based provider adapter.
///
/// Defines host detection patterns and JSON field path mappings for
/// extracting request and response data from custom/self-hosted LLM providers.
#[derive(Debug, Clone, Deserialize)]
pub struct YamlAdapterConfig {
    /// Human-readable provider name (e.g., "custom-llm").
    pub provider_name: String,
    /// Hostnames this adapter should detect (e.g., ["llm.internal.corp.com"]).
    pub detect_hosts: Vec<String>,
    /// Mapping configuration for request fields.
    pub request_mapping: RequestMapping,
    /// Mapping configuration for response fields.
    pub response_mapping: ResponseMapping,
}

/// JSON field path mappings for extracting request data.
#[derive(Debug, Clone, Deserialize)]
pub struct RequestMapping {
    /// Dot-separated path to the model field (e.g., "model_name").
    pub model_path: String,
    /// Dot-separated path to the messages array (e.g., "conversation").
    #[serde(default)]
    pub messages_path: Option<String>,
    /// Dot-separated path to max_tokens (e.g., "max_length").
    #[serde(default)]
    pub max_tokens_path: Option<String>,
}

/// JSON field path mappings for extracting response data.
#[derive(Debug, Clone, Deserialize)]
pub struct ResponseMapping {
    /// Dot-separated path to the response text (e.g., "output.text").
    pub response_text_path: String,
    /// Dot-separated path to the model field in the response.
    #[serde(default)]
    pub model_path: Option<String>,
    /// Dot-separated path to the stop reason field.
    #[serde(default)]
    pub stop_reason_path: Option<String>,
    /// Dot-separated path to the input token count.
    #[serde(default)]
    pub input_tokens_path: Option<String>,
    /// Dot-separated path to the output token count.
    #[serde(default)]
    pub output_tokens_path: Option<String>,
}

impl YamlAdapterConfig {
    /// Parse a YAML configuration string into a `YamlAdapterConfig`.
    pub fn from_yaml_str(yaml: &str) -> Result<Self> {
        serde_yaml::from_str(yaml)
            .map_err(|e| anyhow!("Failed to parse YAML adapter config: {}", e))
    }
}

/// A generic provider adapter configured via YAML.
///
/// Uses dot-separated JSON paths to extract request and response fields
/// from custom LLM provider formats.
pub struct GenericAdapter {
    config: YamlAdapterConfig,
}

impl GenericAdapter {
    /// Create a new GenericAdapter from a parsed YAML configuration.
    pub fn new(config: YamlAdapterConfig) -> Self {
        GenericAdapter { config }
    }

    /// Returns the configured provider name.
    pub fn provider_name(&self) -> &str {
        &self.config.provider_name
    }

    /// Parse a response body using configured field paths, returning a
    /// `super::GenericParsedResponse` with extracted fields.
    ///
    /// R1-05 fix: Returns the parent module's `GenericParsedResponse` directly,
    /// eliminating the shadowed module-local struct and unnecessary conversion layer.
    pub fn parse_response(&self, body: &[u8]) -> Result<super::GenericParsedResponse> {
        let v: serde_json::Value = serde_json::from_slice(body)?;
        let mut errors: Vec<String> = Vec::new();

        // M1: REQUIRED scalar — `response_text_path` is always configured.
        // Log drift when the configured path does not resolve to a string.
        let response_text = extract_string_or_record_drift_dotted(
            &v,
            &self.config.response_mapping.response_text_path,
            &mut errors,
        );

        // M1: OPTIONAL scalar — distinguish "config has no path" (no drift)
        // from "config has a path but the body doesn't supply it" (drift).
        let model = match self.config.response_mapping.model_path.as_deref() {
            Some(path) => extract_string_or_record_drift_dotted(&v, path, &mut errors),
            None => String::new(),
        };

        // M1: OPTIONAL scalar — same shape as `model_path` above.
        let stop_reason = match self.config.response_mapping.stop_reason_path.as_deref() {
            Some(path) => extract_string_or_record_drift_dotted(&v, path, &mut errors),
            None => String::new(),
        };

        let input_tokens = self
            .config
            .response_mapping
            .input_tokens_path
            .as_deref()
            .and_then(|p| resolve_path_u64(&v, p))
            .unwrap_or(0);

        let output_tokens = self
            .config
            .response_mapping
            .output_tokens_path
            .as_deref()
            .and_then(|p| resolve_path_u64(&v, p))
            .unwrap_or(0);

        let parse_errors = if errors.is_empty() {
            None
        } else {
            Some(errors)
        };

        Ok(super::GenericParsedResponse {
            response_text,
            model,
            stop_reason,
            input_tokens,
            output_tokens,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            parse_errors,
        })
    }

    /// Parse a request body using configured field paths, returning a
    /// `super::GenericParsedRequest` with extracted fields.
    ///
    /// R1-05 fix: Returns the parent module's `GenericParsedRequest` directly.
    pub fn parse_request(&self, body: &[u8]) -> Result<super::GenericParsedRequest> {
        let v: serde_json::Value = serde_json::from_slice(body)?;
        let mut errors: Vec<String> = Vec::new();

        // M1: REQUIRED scalar — `model_path` is always configured. Log drift
        // when it does not resolve to a string.
        let model = extract_string_or_record_drift_dotted(
            &v,
            &self.config.request_mapping.model_path,
            &mut errors,
        );

        // M1: OPTIONAL array — only log drift when the config DOES configure
        // a path AND the body fails to expose an array there. When the
        // config is `None`, no drift (the field simply isn't requested).
        let messages = match self.config.request_mapping.messages_path.as_deref() {
            Some(path) => extract_array_or_record_drift_dotted(&v, path, &mut errors),
            None => Vec::new(),
        };

        let max_tokens = self
            .config
            .request_mapping
            .max_tokens_path
            .as_deref()
            .and_then(|p| resolve_path_u64(&v, p))
            .unwrap_or(0);

        let parse_errors = if errors.is_empty() {
            None
        } else {
            Some(errors)
        };

        Ok(super::GenericParsedRequest {
            model,
            messages,
            system: None,
            tools: None,
            max_tokens,
            parse_errors,
        })
    }
}

impl ProviderAdapter for GenericAdapter {
    fn detect(&self, host: &str, _path: &str) -> bool {
        let hostname = match host.rsplit_once(':') {
            Some((h, port)) if port.chars().all(|c| c.is_ascii_digit()) => h,
            _ => host,
        };
        let lower = hostname.to_ascii_lowercase();
        self.config
            .detect_hosts
            .iter()
            .any(|h| h.to_ascii_lowercase() == lower)
    }

    fn parse_request(&self, body: &[u8]) -> Result<super::GenericParsedRequest> {
        // R1-05 fix: inherent method now returns parent type directly, no conversion needed.
        GenericAdapter::parse_request(self, body)
    }

    fn parse_response(&self, body: &[u8]) -> Result<super::GenericParsedResponse> {
        // R1-05 fix: inherent method now returns parent type directly, no conversion needed.
        GenericAdapter::parse_response(self, body)
    }

    fn parse_sse_events(&self, _events: &str) -> Result<super::GenericParsedResponse> {
        Err(anyhow!(
            "Generic YAML adapter does not support SSE streaming; use parse_response with the complete body"
        ))
    }
}

/// Resolve a dot-separated path through a JSON value tree.
///
/// For example, `resolve_path(v, "output.text")` navigates
/// `v["output"]["text"]`. Returns `None` if any segment is missing.
fn resolve_path<'a>(value: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let mut current = value;
    for segment in path.split('.') {
        current = current.get(segment)?;
    }
    Some(current)
}

/// Resolve a dot-separated path and extract the value as a u64.
fn resolve_path_u64(value: &serde_json::Value, path: &str) -> Option<u64> {
    resolve_path(value, path).and_then(|v| v.as_u64())
}
