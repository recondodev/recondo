//! TCP listener loop, MITM/passthrough tunnel handlers, WebSocket relay,
//! Codex turn capture, body/header parsing helpers, and orphan-capture
//! startup recovery. Split out of `gateway/mod.rs` per the Batch 6 H2 audit
//! follow-up.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

use tracing::{debug, info, warn};

use crate::tls::{self, CertCache};

use super::capture_pipeline::{elapsed_millis, process_capture_with_pipeline, MAX_CAPTURE_BYTES};
use super::connect::{
    build_server_config_with_cache, classify_host, detect_connection_mode, extract_sni_hostname,
    parse_connect_request, ConnectionMode, TunnelMode,
};
use super::intercept::should_intercept;
use super::trace::{
    decode_chunked_bytes, decompress_gzip_partial, trace_request, trace_response, trace_sse_chunk,
    trace_sse_line,
};
use super::{trace_enabled, GatewayConfig, ShutdownController, TRACE_ENABLED};

// ---------------------------------------------------------------------------
// Parameter-bundle structs (Batch 6 M3) — shrink the wide-arg helpers below
// clippy's `too_many_arguments` threshold without changing behaviour.
// ---------------------------------------------------------------------------

/// Common per-tunnel context shared by `handle_mitm_tunnel` and
/// `handle_mitm_tunnel_with_replay`. Bundles the configuration/handles that
/// stay constant for the lifetime of a single MITM-tunnel handler call.
pub(crate) struct CaptureContext<'a> {
    pub host: &'a str,
    pub port: u16,
    pub data_dir: &'a Path,
    pub peer_addr: std::net::SocketAddr,
    pub provider: &'a str,
    pub cert_cache: &'a CertCache,
    pub write_pipeline: &'a crate::storage::pipeline::WritePipeline,
    pub wal_fail_mode: crate::wal::FailMode,
    pub metrics_registry: &'a std::sync::Arc<crate::metrics::MetricsRegistry>,
}

/// Argument-bundle for `websocket_relay`. Encapsulates the parameters
/// previously passed individually before the M3 audit fix removed the
/// clippy `too_many_arguments` allow attribute. Single-caller by design —
/// exists to satisfy the lint, not to share context across multiple
/// consumers.
pub(crate) struct WebSocketRelayContext<'a> {
    pub peer_addr: std::net::SocketAddr,
    pub host: &'a str,
    pub data_dir: &'a Path,
    pub provider: &'a str,
    pub write_pipeline: &'a crate::storage::pipeline::WritePipeline,
}

/// Common context for the Codex turn capture helpers
/// (`capture_codex_accumulated_turn` / `capture_codex_partial_turn`). Bundles
/// the per-WebSocket-session state plus the per-turn metadata.
///
/// Visibility note (Batch 12): bumped to `pub` under
/// `feature = "test-support"` so the integration test
/// `gateway/tests/batch12_codex_attachment_tests.rs` can drive the
/// capture function end-to-end and assert that attachments persist
/// in the graph store.
#[cfg_attr(not(feature = "test-support"), allow(dead_code))]
pub struct CodexCaptureContext<'a> {
    pub pipeline: &'a crate::storage::pipeline::WritePipeline,
    pub ws_session_id: &'a str,
    pub sequence_num: i64,
    pub provider: &'a str,
    pub peer_addr: std::net::SocketAddr,
    pub host: &'a str,
    pub openai_metadata: Option<&'a crate::providers::openai::OpenAiMetadata>,
    pub session_model: &'a Option<String>,
    pub session_created: &'a mut bool,
}

/// Argument-bundle for `capture_websocket_frame_via_pipeline`. Same axis as
/// `CodexCaptureContext` minus the per-WS-session state, which the generic
/// path doesn't track. Single-caller by design — exists to satisfy the
/// clippy `too_many_arguments` lint after the M3 audit fix removed the
/// corresponding allow attribute.
pub(crate) struct WebSocketFrameContext<'a> {
    pub pipeline: &'a crate::storage::pipeline::WritePipeline,
    pub ws_session_id: &'a str,
    pub sequence_num: i64,
    pub provider: &'a str,
    pub peer_addr: std::net::SocketAddr,
    pub host: &'a str,
    pub openai_metadata: Option<&'a crate::providers::openai::OpenAiMetadata>,
}

// ---------------------------------------------------------------------------
// Constants used by the listener-side handlers (TLS handshake, upstream IO).
// ---------------------------------------------------------------------------

/// Maximum accumulated response size (100 MB, matching stream::MAX_STREAM_BYTES).
/// Response accumulation stops at this limit to prevent unbounded memory growth.
const MAX_RESPONSE_SIZE: usize = 100 * 1024 * 1024; // 100 MB

/// Timeout for TLS handshake with client (gateway acting as server).
const TLS_HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Timeout for reading a complete HTTP request from the tunnel.
const READ_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Timeout for total upstream forwarding (TCP connect + TLS + request + response).
const UPSTREAM_TOTAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300); // 5 min

/// Timeout for individual read operations from upstream.
/// Set to 5 minutes to match UPSTREAM_TOTAL_TIMEOUT — LLM "thinking" pauses
/// can last 60+ seconds between SSE chunks (extended thinking, complex reasoning).
/// A 30-second timeout kills streams mid-flight during these pauses.
const UPSTREAM_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

// ---------------------------------------------------------------------------
// HTTP body extraction and CONNECT response helpers
// ---------------------------------------------------------------------------

/// The HTTP response for a successful CONNECT handshake.
///
/// Contains `HTTP/1.1 200 Connection Established\r\n\r\n`.
/// This is sent to the client after receiving a CONNECT request, before
/// the TLS handshake begins inside the tunnel.
pub const CONNECT_RESPONSE: &[u8] = b"HTTP/1.1 200 Connection Established\r\n\r\n";

/// Build the HTTP response for a successful CONNECT handshake.
///
/// Returns [`CONNECT_RESPONSE`]. Kept as a function for backward compatibility
/// with existing callers and tests.
pub fn connect_response() -> &'static [u8] {
    CONNECT_RESPONSE
}

/// Maximum allowed Content-Length value (50 MB), matching `MAX_CAPTURE_BYTES`.
/// If a `Content-Length` header exceeds this limit, `parse_content_length`
/// returns `None` to prevent memory exhaustion from oversized allocations.
const MAX_BODY_SIZE: usize = 50 * 1024 * 1024; // 50 MB

/// Extract Content-Length value from HTTP headers, optionally including the request line.
///
/// Performs a case-insensitive search for the `Content-Length` header.
/// Returns `None` if the header is missing, the value is not a valid
/// non-negative integer, the value exceeds `MAX_BODY_SIZE` (50 MB), or
/// duplicate `Content-Length` headers are found with different values.
///
/// # Arguments
/// * `headers` - The HTTP headers as a string (lines separated by `\r\n`).
///   May also include the HTTP request line (e.g., `POST /path HTTP/1.1`).
pub fn parse_content_length(headers: &str) -> Option<usize> {
    let mut found: Option<usize> = None;
    for line in headers.lines() {
        let line = line.trim();
        if let Some((key, value)) = line.split_once(':') {
            if key.trim().eq_ignore_ascii_case("content-length") {
                // NOTE: Leading zeros (e.g., "007") are accepted by parse::<usize>()
                // and are valid per RFC 7230 Section 3.3.2. While some HTTP
                // intermediaries may interpret leading zeros differently (potential
                // request smuggling vector), rejecting them would break compatibility
                // with legitimate clients. This is accepted behavior.
                let parsed = value.trim().parse::<usize>().ok()?;
                if parsed > MAX_BODY_SIZE {
                    return None;
                }
                match found {
                    None => found = Some(parsed),
                    Some(prev) if prev != parsed => return None,
                    Some(_) => {} // duplicate with same value, ok
                }
            }
        }
    }
    found
}

/// Strip `Sec-WebSocket-Extensions` header from an HTTP request.
///
/// R1-10 fix: MITM proxies should not forward extension negotiation headers
/// because they don't implement the extensions (e.g., permessage-deflate).
/// If the server negotiates an extension, it will set RSV bits on frames,
/// and parse_frame will reject them. Stripping the header prevents negotiation.
///
/// Operates on raw bytes to avoid UTF-8 issues with binary request bodies.
/// Only removes the header line from the HTTP headers section (before \r\n\r\n).
fn strip_websocket_extensions_header(request: &[u8]) -> Vec<u8> {
    // Find the header boundary
    let boundary = request.windows(4).position(|w| w == b"\r\n\r\n");

    let Some(boundary_pos) = boundary else {
        return request.to_vec();
    };

    let header_bytes = &request[..boundary_pos];
    let rest = &request[boundary_pos..]; // includes \r\n\r\n and any body

    // Parse headers as UTF-8 (headers must be ASCII per HTTP spec)
    let Ok(headers_str) = std::str::from_utf8(header_bytes) else {
        return request.to_vec();
    };

    let mut filtered_lines = Vec::new();
    for line in headers_str.split("\r\n") {
        if let Some((key, _)) = line.split_once(':') {
            if key.trim().eq_ignore_ascii_case("sec-websocket-extensions") {
                continue; // Strip this header
            }
        }
        filtered_lines.push(line);
    }

    let mut result = filtered_lines.join("\r\n").into_bytes();
    result.extend_from_slice(rest);
    result
}

/// Check whether the headers contain `Transfer-Encoding: chunked`.
///
/// Performs a case-insensitive search for both the header name and the
/// "chunked" token. Handles multi-value Transfer-Encoding headers where
/// "chunked" may appear alongside other encodings (e.g., `gzip, chunked`).
/// Returns `true` if the "chunked" token is present in any TE header value.
fn has_chunked_transfer_encoding(headers: &str) -> bool {
    for line in headers.lines() {
        let line = line.trim();
        if let Some((key, value)) = line.split_once(':') {
            if key.trim().eq_ignore_ascii_case("transfer-encoding")
                && value
                    .split(',')
                    .any(|t| t.trim().eq_ignore_ascii_case("chunked"))
            {
                return true;
            }
        }
    }
    false
}

/// Check whether the headers contain a `Content-Length` header (regardless of
/// whether its value is valid). Used by `extract_http_body` to distinguish
/// "no CL header" from "CL header present but invalid/oversized".
fn has_content_length_header(headers: &str) -> bool {
    for line in headers.lines() {
        let line = line.trim();
        if let Some((key, _)) = line.split_once(':') {
            if key.trim().eq_ignore_ascii_case("content-length") {
                return true;
            }
        }
    }
    false
}

/// Extract HTTP request body from raw decrypted bytes.
///
/// Splits the raw bytes at the `\r\n\r\n` header/body boundary and returns
/// `(headers_str, body_bytes)`.
///
/// Body length is determined by the `Content-Length` header if present.
/// If `Content-Length` is absent, the body is everything after the header
/// boundary (read-until-end semantics).
///
/// **Note:** This function is currently unused in the production gateway path
/// (the gateway captures raw bytes directly). It is a utility available for
/// future use by capture-pipeline integration when structured body extraction
/// is needed (e.g., for provider-specific request parsing in the DB pipeline).
///
/// **Note:** When `Content-Length` is present and the raw buffer contains more
/// bytes after the body than `Content-Length` indicates, trailing bytes (e.g.,
/// from HTTP pipelining) are silently discarded. Only the first
/// `Content-Length` bytes of the body are returned.
///
/// **Note:** `Transfer-Encoding: chunked` is detected and rejected with an
/// error. Chunked framing must not be silently treated as body data.
///
/// # Errors
/// Load extra CA certificates into a root store for upstream TLS connections.
///
/// Needed when the gateway runs behind a corporate TLS inspection firewall
/// (e.g., Zscaler, Blue Coat, Palo Alto) that re-signs upstream certificates
/// with its own CA. Without the corporate CA in the root store, the gateway's
/// upstream TLS handshake will fail with "certificate verify failed."
///
/// Loads PEM certificates from:
/// 1. `RECONDO_EXTRA_CA_CERTS` env var (path to a single PEM file)
/// 2. Every `.pem` file in `{data_dir}/ca/` (except `ca.crt` and `ca.key`)
///
/// If no extra certs are found, this is a no-op (standard webpki roots are sufficient).
pub fn load_extra_ca_certs(root_store: &mut rustls::RootCertStore, data_dir: &Path) {
    let mut total_loaded = 0;

    // Source 1: RECONDO_EXTRA_CA_CERTS env var (single file)
    if let Ok(env_path) = std::env::var("RECONDO_EXTRA_CA_CERTS") {
        let path = PathBuf::from(&env_path);
        if path.exists() {
            total_loaded += load_pem_file(root_store, &path);
        } else {
            warn!(path = %path.display(), "RECONDO_EXTRA_CA_CERTS file not found");
        }
    }

    // Source 2: every .pem file in {data_dir}/ca/ (skip our own ca.crt/ca.key)
    let ca_dir = data_dir.join("ca");
    if ca_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&ca_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let name = entry.file_name();
                let name_str = name.to_string_lossy();

                // Skip our own CA files and non-PEM files
                if name_str == "ca.crt" || name_str == "ca.key" || name_str == "ca.lock" {
                    continue;
                }
                if !name_str.ends_with(".pem") && !name_str.ends_with(".crt") {
                    continue;
                }

                total_loaded += load_pem_file(root_store, &path);
            }
        }
    }

    if total_loaded > 0 {
        info!(
            count = total_loaded,
            "Loaded extra CA certificates for upstream TLS"
        );
    }
}

/// Load PEM certificates from a single file into the root store.
/// Returns the number of certs successfully loaded.
fn load_pem_file(root_store: &mut rustls::RootCertStore, path: &Path) -> usize {
    use std::io::BufReader;

    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            warn!(path = %path.display(), error = %e, "Failed to open CA cert file");
            return 0;
        }
    };

    let mut reader = BufReader::new(file);
    let certs = match rustls_pemfile::certs(&mut reader).collect::<Result<Vec<_>, _>>() {
        Ok(certs) => certs,
        Err(e) => {
            warn!(path = %path.display(), error = %e, "Failed to parse PEM file");
            return 0;
        }
    };

    let mut loaded = 0;
    for cert in &certs {
        if let Err(e) = root_store.add(cert.clone()) {
            warn!(path = %path.display(), error = %e, "Failed to add CA cert to root store");
        } else {
            loaded += 1;
        }
    }

    if loaded > 0 {
        info!(path = %path.display(), count = loaded, "Loaded CA certs from file");
    }

    loaded
}

/// - Input is empty
/// - No `\r\n\r\n` boundary found (malformed HTTP)
/// - `Content-Length` header is present but its value is invalid or exceeds `MAX_BODY_SIZE`
/// - `Content-Length` is present but the actual body is shorter than declared
/// - `Transfer-Encoding: chunked` is present (not yet supported)
/// - No `Content-Length` and body exceeds `MAX_BODY_SIZE` (50 MB)
pub fn extract_http_body(raw: &[u8]) -> Result<(String, Vec<u8>)> {
    if raw.is_empty() {
        bail!("Empty input");
    }

    // Find the \r\n\r\n boundary separating headers from body
    let boundary = b"\r\n\r\n";
    let boundary_pos = raw
        .windows(boundary.len())
        .position(|w| w == boundary)
        .ok_or_else(|| anyhow::anyhow!("No \\r\\n\\r\\n header boundary found"))?;

    let header_bytes = &raw[..boundary_pos];
    let body_start = boundary_pos + boundary.len();
    let remaining = &raw[body_start..];

    let headers = std::str::from_utf8(header_bytes)
        .context("Headers contain non-UTF8 bytes")?
        .to_string();

    // Detect Transfer-Encoding: chunked before attempting body extraction.
    // Chunked framing must not be silently treated as raw body data.
    if has_chunked_transfer_encoding(&headers) {
        bail!("Chunked transfer encoding is unsupported in extract_http_body; use prepare_response_body for streaming responses");
    }

    let content_length = parse_content_length(&headers);

    // Check for the case where a Content-Length header is present in the raw
    // headers but parse_content_length returned None. This means the CL value
    // was invalid (non-numeric, negative) or exceeded MAX_BODY_SIZE. We must
    // error here rather than silently falling through to read-until-end
    // semantics, which would treat the body as unbounded.
    if content_length.is_none() && has_content_length_header(&headers) {
        bail!(
            "Content-Length header present but invalid or exceeds maximum body size ({} bytes)",
            MAX_BODY_SIZE
        );
    }

    let body = match content_length {
        Some(len) => {
            if remaining.len() < len {
                bail!(
                    "Content-Length ({}) exceeds available body data ({} bytes)",
                    len,
                    remaining.len()
                );
            }
            remaining[..len].to_vec()
        }
        None => {
            // No Content-Length and no Transfer-Encoding: read-until-end.
            // Apply a size guard to prevent memory exhaustion from unbounded reads.
            if remaining.len() > MAX_BODY_SIZE {
                bail!(
                    "Body without Content-Length exceeds maximum body size ({} bytes, max {} bytes)",
                    remaining.len(),
                    MAX_BODY_SIZE
                );
            }
            remaining.to_vec()
        }
    };

    Ok((headers, body))
}

// ---------------------------------------------------------------------------
// Gateway entrypoint (async)
// ---------------------------------------------------------------------------

/// Start the gateway server. Binds to the configured port and handles
/// incoming CONNECT requests.
///
/// This is the main entry point -- called from main.rs.
/// Binds to the address configured in GatewayConfig (default: 0.0.0.0).
/// A host allowlist should be added before production deployment.
pub async fn start_gateway(config: GatewayConfig) -> Result<()> {
    // Set global trace flag
    TRACE_ENABLED.store(config.trace, std::sync::atomic::Ordering::Relaxed);
    if config.trace {
        eprintln!("\x1b[36m[recondo]\x1b[0m Live trace enabled — showing request/response content");
    }
    run_listener(&config).await
}

/// FIND-1-10 (round 3): test-visible atomic counter that the
/// `run_startup_recovery` helper bumps when invoked.
#[cfg(any(test, feature = "test-support"))]
pub static STARTUP_RECOVERY_INVOCATIONS: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(0);

/// FIND-1-10 (round 3): the in-listener orphan-recovery entry point.
pub fn run_startup_recovery(
    data_dir: &Path,
    graph_store: &dyn crate::storage::graph::GraphStore,
    object_store: &dyn crate::storage::object::ObjectStore,
) -> Result<crate::capture::recovery::RecoveryReport> {
    #[cfg(any(test, feature = "test-support"))]
    {
        STARTUP_RECOVERY_INVOCATIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    crate::capture::recovery::recover_orphan_captures(
        data_dir,
        graph_store,
        object_store,
        &crate::capture::recovery::RecoveryConfig::default(),
    )
}

/// Run the TCP listener loop. Accepts TCP connections and dispatches them
/// based on detected connection mode (CONNECT, DirectTLS, or healthz).
///
/// For known LLM provider hosts, the gateway will perform TLS MITM; for
/// unknown hosts, it establishes a transparent passthrough tunnel.
///
/// B1/B3 fix: Takes `&GatewayConfig` instead of individual parameters so
/// `fail_mode` is available when opening the WAL, and connection mode
/// detection can be used for dual-mode dispatch.
///
/// This function runs indefinitely (until the task is cancelled).
pub async fn run_listener(config: &GatewayConfig) -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let bind_addr = config.bind_addr();
    let port = config.port();
    let data_dir = config.data_dir();
    let wal_fail_mode = config.fail_mode();

    // Ensure CA exists so we can generate leaf certs for MITM hosts.
    tls::ensure_ca(data_dir)?;

    // Create a shared CertCache that loads the CA once and reuses it for all
    // leaf cert generations, avoiding repeated filesystem I/O per connection.
    let cert_cache =
        std::sync::Arc::new(CertCache::new(data_dir, 1000).context("Failed to create CertCache")?);

    let db_path = data_dir.join("recondo.db");

    // Create storage backends. Reads RECONDO_STORE (sqlite|postgres) and
    // RECONDO_OBJECTS (local|s3) env vars. Uses the gateway's data_dir for
    // SQLite/local paths (not RECONDO_DATA_DIR) so tests with temp dirs work.
    let dead_letter_dir = data_dir.join("dead_letters");
    let write_pipeline: std::sync::Arc<crate::storage::pipeline::WritePipeline> = {
        let store_type = std::env::var("RECONDO_STORE").unwrap_or_else(|_| "sqlite".into());
        let obj_type = std::env::var("RECONDO_OBJECTS").unwrap_or_else(|_| "local".into());

        let graph_store: Box<dyn crate::storage::graph::GraphStore> = match store_type.as_str() {
            #[cfg(feature = "postgres")]
            "postgres" => {
                let db_url = std::env::var("RECONDO_DB_URL").map_err(|_| {
                    anyhow::anyhow!("RECONDO_DB_URL required when RECONDO_STORE=postgres")
                })?;
                let pool = crate::storage::pool::ConnectionPool::postgres(&db_url)?;
                pool.graph_store()
            }
            other => {
                #[cfg(not(feature = "postgres"))]
                if other == "postgres" {
                    anyhow::bail!(
                        "RECONDO_STORE=postgres but the binary was compiled without the 'postgres' feature. \
                         Rebuild with: cargo run --features postgres -- serve"
                    );
                }
                let _ = other;
                let pool = crate::storage::pool::ConnectionPool::sqlite(&db_path)?;
                pool.graph_store()
            }
        };

        let object_store: Box<dyn crate::storage::object::ObjectStore> = match obj_type.as_str() {
            #[cfg(feature = "s3")]
            "s3" => {
                let bucket = std::env::var("RECONDO_S3_BUCKET").map_err(|_| {
                    anyhow::anyhow!("RECONDO_S3_BUCKET required when RECONDO_OBJECTS=s3")
                })?;
                // We're already in `async fn run_listener` — load_defaults
                // can be awaited directly. The previous
                // `block_in_place(block_on(...))` was an anti-pattern that
                // could deadlock under burst (and obscured logs from this
                // setup path during recent debugging).
                let aws_config_loaded =
                    aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
                // Build the SDK client with:
                //   * a hickory-dns HTTP client (avoids the EBUSY
                //     getaddrinfo bug in containerized AL2023; works
                //     identically against real AWS S3 — see
                //     `build_s3_http_client_with_hickory_dns` for details);
                //   * `force_path_style(true)` for S3-compatible
                //     emulators (MiniStack, LocalStack) and
                //     `endpoint_url(...)` from `AWS_ENDPOINT_URL` when
                //     present. Both are no-ops against real S3 (the env
                //     var isn't set in production).
                let mut s3_builder = aws_sdk_s3::config::Builder::from(&aws_config_loaded)
                    .http_client(crate::storage::object::build_s3_http_client_with_hickory_dns());
                if let Ok(endpoint) = std::env::var("AWS_ENDPOINT_URL") {
                    s3_builder = s3_builder.endpoint_url(&endpoint).force_path_style(true);
                }
                let client = aws_sdk_s3::Client::from_conf(s3_builder.build());
                Box::new(crate::storage::object::S3ObjectStore::new(client, bucket))
            }
            _ => Box::new(crate::storage::object::LocalObjectStore::new(data_dir)),
        };

        info!(store = %store_type, objects = %obj_type, "Storage backends initialized");
        std::sync::Arc::new(crate::storage::pipeline::WritePipeline::new(
            graph_store,
            object_store,
            dead_letter_dir,
        ))
    };
    info!("WritePipeline active (retry + dead-letter queue)");

    // H1 fix: Create shared MetricsRegistry for /metrics endpoint and capture recording.
    let metrics_registry = std::sync::Arc::new(crate::metrics::MetricsRegistry::new());
    // FIND-3-RUST-7: also publish the same Arc as the process-global so
    // deeply nested increments (attachment DLQ counters in
    // WritePipeline) hit the same instance as /metrics.
    crate::metrics::MetricsRegistry::init_global(metrics_registry.clone());
    info!("MetricsRegistry initialized");

    // Orphan capture recovery: replay any capture metadata files whose
    // matching `turns` row is missing.
    {
        let recovery_data_dir = data_dir.to_path_buf();
        let pipeline_for_recovery = write_pipeline.clone();
        let recovery_result = tokio::task::spawn_blocking(move || {
            run_startup_recovery(
                &recovery_data_dir,
                pipeline_for_recovery.graph(),
                pipeline_for_recovery.objects(),
            )
        })
        .await
        .map_err(|e| anyhow::anyhow!("orphan recovery task join failed: {}", e))?;
        match recovery_result {
            Ok(report) => {
                info!(
                    scanned = report.scanned,
                    orphans_found = report.orphans_found,
                    recovered = report.recovered,
                    attachments_recovered = report.attachments_recovered,
                    failed = report.failed.len(),
                    "Orphan capture recovery complete (startup)"
                );
                for (path, err) in &report.failed {
                    warn!(path = %path.display(), error = %err, "Recovery failure");
                }
            }
            Err(e) => {
                let lock_file = data_dir.join(".recovery.lock");
                warn!(
                    error = %e,
                    lock_file = %lock_file.display(),
                    "Orphan capture recovery failed at startup. To diagnose: \
                     run 'lsof {}' to identify the holder, then 'kill <PID>' \
                     to signal it, or 'rm {}' if the holder is dead. \
                     Continuing startup without recovery — orphans remain on \
                     disk and will be retried on next boot or via 'recondo \
                     reprocess'.",
                    lock_file.display(),
                    lock_file.display(),
                );
            }
        }
    }

    // H2 fix: Create ShutdownController and spawn Ctrl+C signal handler.
    let shutdown = ShutdownController::new();
    {
        let shutdown_signal = shutdown.clone();
        tokio::spawn(async move {
            if let Ok(()) = tokio::signal::ctrl_c().await {
                info!("Received Ctrl+C, initiating graceful shutdown");
                shutdown_signal.signal();
            }
        });
    }

    // Spawn a heartbeat writer that inserts a row into the heartbeats table
    // every 30 seconds so the dashboard can detect gateway liveness.
    {
        let pipeline_hb = write_pipeline.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                interval.tick().await;
                let id = uuid::Uuid::new_v4().to_string();
                let hb = crate::db::HeartbeatRecord {
                    id,
                    gateway_id: None,
                    status: "ok".to_string(),
                };
                if let Err(e) = pipeline_hb.graph().write_heartbeat(&hb) {
                    tracing::warn!(error = %e, "Failed to write heartbeat (non-fatal)");
                }
            }
        });
    }

    let addr = format!("{}:{}", bind_addr, port);
    let listener = TcpListener::bind(&addr).await?;
    info!(
        %addr,
        "TCP listener active with TLS MITM"
    );

    loop {
        // H2 fix: Check shutdown state before accepting new connections.
        if shutdown.is_shutting_down() {
            info!("Shutdown signalled, stopping accept loop");
            break;
        }

        // Use tokio::select! so we can check shutdown between accepts.
        let accept_result = tokio::select! {
            result = listener.accept() => result,
            _ = async {
                // Poll shutdown state every 100ms
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    if shutdown.is_shutting_down() {
                        break;
                    }
                }
            } => {
                info!("Shutdown signalled during accept, stopping");
                break;
            }
        };

        let (mut stream, peer_addr) = match accept_result {
            Ok(conn) => conn,
            Err(e) => {
                warn!(error = %e, "Failed to accept connection, continuing");
                continue;
            }
        };

        let data_dir = data_dir.to_path_buf();
        let cert_cache = cert_cache.clone();
        let write_pipeline = write_pipeline.clone();
        let metrics_registry = metrics_registry.clone();
        let shutdown = shutdown.clone();

        // H2 fix: Register active connection.
        shutdown.register_active();
        // H5 fix: Increment active tunnels metric.
        crate::metrics::increment_active_tunnels(&metrics_registry);

        tokio::spawn(async move {
            // Read the first bytes from the client to detect connection mode.
            // TCP may deliver a partial request in the first read, so we
            // accumulate until \r\n\r\n is found or 8KB limit is reached.
            let mut buf = vec![0u8; 8192];
            let mut total = 0usize;
            loop {
                if total >= buf.len() {
                    warn!(%peer_addr, "CONNECT request exceeds 8KB, dropping");
                    return;
                }
                let n = match stream.read(&mut buf[total..]).await {
                    Ok(0) => {
                        if total == 0 {
                            return;
                        }
                        break;
                    }
                    Ok(n) => n,
                    Err(e) => {
                        warn!(%peer_addr, error = %e, "Failed to read from client");
                        return;
                    }
                };
                total += n;
                // Check if we have the full header (ends with \r\n\r\n)
                if buf[..total].windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }

            let raw = &buf[..total];

            // B3 fix: Use detect_connection_mode to dispatch based on first bytes.
            let conn_mode = detect_connection_mode(raw);
            debug!(%peer_addr, ?conn_mode, "Connection mode detected");

            match conn_mode {
                ConnectionMode::DirectTls => {
                    // B3 fix: Client connected with TLS directly (no CONNECT tunnel).
                    // Extract the SNI hostname from the ClientHello to use as the
                    // CONNECT host. Skip the 200 CONNECT response (no tunnel).
                    let sni_host = match extract_sni_hostname(raw) {
                        Some(h) => h,
                        None => {
                            warn!(%peer_addr, "DirectTLS: no SNI hostname in ClientHello, dropping");
                            return;
                        }
                    };

                    let tunnel_mode = classify_host(&sni_host);
                    info!(
                        %peer_addr,
                        host = %sni_host,
                        ?tunnel_mode,
                        "DirectTLS connection (SNI)"
                    );

                    match tunnel_mode {
                        TunnelMode::Mitm(ref provider) => {
                            // For DirectTLS, the client already sent the ClientHello.
                            // We need to replay the raw bytes into the TLS acceptor.
                            // Create a chained reader: raw bytes first, then the stream.
                            let ctx = CaptureContext {
                                host: &sni_host,
                                port: 443,
                                data_dir: &data_dir,
                                peer_addr,
                                provider,
                                cert_cache: &cert_cache,
                                write_pipeline: &write_pipeline,
                                wal_fail_mode,
                                metrics_registry: &metrics_registry,
                            };
                            handle_mitm_tunnel_with_replay(stream, raw, total, &ctx).await;
                        }
                        TunnelMode::Passthrough => {
                            // DirectTLS passthrough — forward raw bytes + stream to upstream.
                            handle_passthrough_tunnel_with_replay(
                                stream, raw, total, &sni_host, 443, peer_addr,
                            )
                            .await;
                        }
                    }
                }
                ConnectionMode::Connect => {
                    // B3/B1 fix: Check for GET /healthz or GET /metrics before parsing as CONNECT.
                    if let Ok(text) = std::str::from_utf8(raw) {
                        let first_line = text.lines().next().unwrap_or("");
                        if first_line.starts_with("GET /healthz") {
                            let health_ctx = crate::health::HealthContext::from_data_dir(&data_dir);
                            let health = crate::health::check_health(&health_ctx);
                            let status_code = health.http_status_code();
                            let body = serde_json::to_string(&health).unwrap_or_else(|_| {
                                r#"{"status":"degraded","components":{}}"#.to_string()
                            });
                            let response = format!(
                                "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                status_code,
                                if status_code == 200 { "OK" } else { "Service Unavailable" },
                                body.len(),
                                body
                            );
                            let _ = stream.write_all(response.as_bytes()).await;
                            return;
                        }
                        // H1 fix: Serve GET /metrics with Prometheus text exposition format.
                        if first_line.starts_with("GET /metrics") {
                            let body = metrics_registry.render();
                            let ct = metrics_registry.content_type();
                            let response = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                ct,
                                body.len(),
                                body
                            );
                            let _ = stream.write_all(response.as_bytes()).await;
                            return;
                        }
                    }

                    // Parse the CONNECT request.
                    let connect = match parse_connect_request(raw) {
                        Ok(c) => c,
                        Err(e) => {
                            warn!(%peer_addr, error = %e, "Invalid CONNECT request");
                            let response = b"HTTP/1.1 400 Bad Request\r\n\r\n";
                            let _ = stream.write_all(response).await;
                            return;
                        }
                    };

                    // Send 200 Connection Established
                    if let Err(e) = stream.write_all(CONNECT_RESPONSE).await {
                        warn!(%peer_addr, host = %connect.host, error = %e, "Failed to send CONNECT response");
                        return;
                    }

                    let tunnel_mode = classify_host(&connect.host);
                    info!(
                        %peer_addr,
                        host = %connect.host,
                        port = connect.port,
                        ?tunnel_mode,
                        "CONNECT tunnel established"
                    );

                    match tunnel_mode {
                        TunnelMode::Mitm(ref provider) => {
                            let ctx = CaptureContext {
                                host: &connect.host,
                                port: connect.port,
                                data_dir: &data_dir,
                                peer_addr,
                                provider,
                                cert_cache: &cert_cache,
                                write_pipeline: &write_pipeline,
                                wal_fail_mode,
                                metrics_registry: &metrics_registry,
                            };
                            handle_mitm_tunnel(stream, &ctx).await;
                        }
                        TunnelMode::Passthrough => {
                            // Finding 7: Restrict passthrough to port 443 only.
                            if connect.port != 443 {
                                warn!(
                                    %peer_addr,
                                    host = %connect.host,
                                    port = connect.port,
                                    "Passthrough rejected: only port 443 is allowed"
                                );
                                return;
                            }
                            handle_passthrough_tunnel(
                                stream,
                                &connect.host,
                                connect.port,
                                peer_addr,
                            )
                            .await;
                        }
                    }
                }
                ConnectionMode::Unknown => {
                    // B3 fix: Check for GET /healthz or GET /metrics first for Unknown mode too.
                    if let Ok(text) = std::str::from_utf8(raw) {
                        let first_line = text.lines().next().unwrap_or("");
                        if first_line.starts_with("GET /healthz") {
                            let health_ctx = crate::health::HealthContext::from_data_dir(&data_dir);
                            let health = crate::health::check_health(&health_ctx);
                            let status_code = health.http_status_code();
                            let body = serde_json::to_string(&health).unwrap_or_else(|_| {
                                r#"{"status":"degraded","components":{}}"#.to_string()
                            });
                            let response = format!(
                                "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                status_code,
                                if status_code == 200 { "OK" } else { "Service Unavailable" },
                                body.len(),
                                body
                            );
                            let _ = stream.write_all(response.as_bytes()).await;
                            return;
                        }
                        // H1 fix: Serve GET /metrics in Unknown mode too.
                        if first_line.starts_with("GET /metrics") {
                            let body = metrics_registry.render();
                            let ct = metrics_registry.content_type();
                            let response = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                ct,
                                body.len(),
                                body
                            );
                            let _ = stream.write_all(response.as_bytes()).await;
                            return;
                        }
                    }
                    warn!(%peer_addr, "Unknown connection mode, returning 400");
                    let response = b"HTTP/1.1 400 Bad Request\r\n\r\n";
                    let _ = stream.write_all(response).await;
                }
            } // match conn_mode

            // H2 fix: Deregister active connection on exit.
            shutdown.deregister_active();
            // H5 fix: Decrement active tunnels metric on connection exit.
            crate::metrics::decrement_active_tunnels(&metrics_registry);
        });
    }

    // H2 fix: After breaking from accept loop, wait for active connections to drain.
    info!(
        active = shutdown.active_count(),
        "Accept loop stopped, waiting for active connections to drain"
    );
    if let Err(msg) = shutdown.wait_for_drain(shutdown.default_timeout()).await {
        warn!(%msg, "Drain timeout expired with connections still active");
    } else {
        info!("All active connections drained successfully");
    }

    Ok(())
}

/// Handle TLS MITM for a known LLM provider host.
///
/// Performs a TLS handshake with the client using a generated leaf cert,
/// then reads HTTP requests, forwards them upstream with incremental
/// streaming (each chunk is forwarded to the client immediately and
/// accumulated for capture), and captures the request/response bytes.
///
/// ## Capture scope
///
/// Only POST `/v1/messages` and POST `/v1/chat/completions` requests are
/// captured (via `should_intercept`). All other requests are forwarded
/// without capture. Headers and body (including API keys) are captured
/// intentionally for compliance audit trail.
async fn handle_mitm_tunnel(stream: tokio::net::TcpStream, ctx: &CaptureContext<'_>) {
    use tokio::io::AsyncWriteExt;
    let host = ctx.host;
    let port = ctx.port;
    let data_dir = ctx.data_dir;
    let peer_addr = ctx.peer_addr;
    let provider = ctx.provider;
    let cert_cache = ctx.cert_cache;
    let write_pipeline = ctx.write_pipeline;
    let wal_fail_mode = ctx.wal_fail_mode;
    let metrics_registry = ctx.metrics_registry;

    // Step 1: Build server TLS config for MITM (using CertCache)
    let server_config = match build_server_config_with_cache(data_dir, host, Some(cert_cache)) {
        Ok(cfg) => cfg,
        Err(e) => {
            warn!(%peer_addr, host, error = %e, "Failed to build server TLS config");
            return;
        }
    };

    // Step 2: TLS handshake with the client (gateway acts as server)
    // Finding 6: Wrap TLS handshake with timeout.
    let acceptor = tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(server_config));
    let mut client_tls = match tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(stream))
        .await
    {
        Ok(Ok(tls)) => tls,
        Ok(Err(e)) => {
            // TLS handshake failed (e.g., client sent garbage instead of Client Hello).
            // No capture should be produced for failed handshakes.
            warn!(%peer_addr, host, error = %e, "TLS handshake with client failed");
            return;
        }
        Err(_) => {
            warn!(%peer_addr, host, "TLS handshake with client timed out ({:?})", TLS_HANDSHAKE_TIMEOUT);
            return;
        }
    };

    // SessionManager for session resolution in process_capture_with_pipeline.
    let mut session_mgr = crate::session::SessionManager::new();

    // B1 fix: Open WAL with the configured fail mode from GatewayConfig.
    let wal_dir = data_dir.join("wal");
    let wal = match crate::wal::Wal::open_with_mode(&wal_dir, wal_fail_mode) {
        Ok(w) => Some(w),
        Err(e) => {
            warn!(%peer_addr, host, error = %e, "Failed to open WAL (continuing without WAL)");
            None
        }
    };

    // Loop to handle multiple HTTP requests through the same TLS tunnel
    loop {
        // Step 3: Read decrypted HTTP request from the client
        let request_bytes = match tokio::time::timeout(
            READ_REQUEST_TIMEOUT,
            read_http_request(&mut client_tls),
        )
        .await
        {
            Ok(Ok(bytes)) if bytes.is_empty() => {
                // Client closed the connection
                break;
            }
            Ok(Ok(bytes)) => bytes,
            Ok(Err(e)) => {
                // Node.js (Claude Code) drops connections without TLS close_notify.
                // This is normal -- it just means the client is done with the tunnel.
                debug!(%peer_addr, host, error = %e, "Tunnel closed by client");
                break;
            }
            Err(_) => {
                warn!(%peer_addr, host, "HTTP request read timed out ({:?})", READ_REQUEST_TIMEOUT);
                break;
            }
        };

        // Only capture if should_intercept says so.
        let decision = should_intercept(&request_bytes, provider);
        info!(
            %peer_addr, host,
            method = ?decision.method,
            path = ?decision.path,
            should_capture = decision.should_capture,
            request_len = request_bytes.len(),
            "Intercept decision"
        );

        // Live trace: show request content
        if decision.should_capture {
            trace_request(&request_bytes, provider);
        }

        // Step 4: Forward to upstream with incremental streaming.
        let upstream_result = tokio::time::timeout(
            UPSTREAM_TOTAL_TIMEOUT,
            stream_to_client_and_accumulate(host, port, &request_bytes, &mut client_tls, data_dir),
        )
        .await;

        match upstream_result {
            Ok(Ok(crate::websocket::StreamResult::WebSocketUpgrade(
                upstream_tls,
                response_headers,
            ))) => {
                // BLOCKER 1: WebSocket upgrade detected. The 101 headers have
                // been forwarded to the client. Now enter bidirectional relay.
                info!(%peer_addr, host, "WebSocket upgrade detected, entering relay mode");

                // BLOCKER 3: Capture the upgrade handshake metadata only — do
                // NOT pass the 101 response to the capture pipeline, which
                // expects a normal HTTP response with a body. The 101 has no
                // body and would produce junk metadata.
                if decision.should_capture {
                    if let Err(e) = crate::capture::record_capture(
                        data_dir,
                        &request_bytes,
                        &response_headers,
                        provider,
                    ) {
                        warn!(%peer_addr, host, error = %e, "Disk capture of WebSocket upgrade failed");
                    }
                    // Skip the capture pipeline for 101 — it would produce
                    // incorrect DB records (no model, no tokens, etc.). The
                    // handshake is captured to disk for audit trail purposes.
                    info!(%peer_addr, host, "WebSocket upgrade handshake captured to disk (skipping DB)");
                }

                // Enter bidirectional WebSocket relay with frame-level capture.
                // Pass write_pipeline for storage (retry + DLQ).
                // R1-03 fix: pass upgrade request bytes so websocket_relay
                // can call extract_openai_metadata for session identity.
                let ws_ctx = WebSocketRelayContext {
                    peer_addr,
                    host,
                    data_dir,
                    provider,
                    write_pipeline,
                };
                websocket_relay(
                    &mut client_tls,
                    upstream_tls,
                    &ws_ctx,
                    &mut session_mgr,
                    &request_bytes,
                )
                .await;
                break;
            }
            Ok(Ok(crate::websocket::StreamResult::Complete(resp, partial))) => {
                info!(
                    %peer_addr, host,
                    response_len = resp.len(),
                    partial,
                    "Upstream response complete"
                );

                // Step 5: Capture the request/response pair (only for capturable endpoints)
                if decision.should_capture {
                    if partial {
                        warn!(
                            %peer_addr, host,
                            "Capturing partial response (upstream error or size limit reached mid-stream)"
                        );
                    }
                    // Use process_capture_with_pipeline for full DB + session integration.
                    // Also write disk artifacts via record_capture for backward compatibility.
                    if let Err(e) =
                        crate::capture::record_capture(data_dir, &request_bytes, &resp, provider)
                    {
                        warn!(%peer_addr, host, error = %e, "Disk capture pipeline failed");
                    }
                    match process_capture_with_pipeline(
                        write_pipeline,
                        &mut session_mgr,
                        provider,
                        &request_bytes,
                        &resp,
                        wal.as_ref(),
                        Some(metrics_registry),
                    ) {
                        Ok(_turn_record) => {
                            info!(%peer_addr, host, "capture pipeline succeeded (DB + session via WritePipeline)");
                        }
                        Err(e) => {
                            // H5 fix: Record capture error in metrics.
                            crate::metrics::record_error(metrics_registry);
                            warn!(%peer_addr, host, error = %e, "capture pipeline failed (DB capture)");
                        }
                    }
                }

                trace_response(&resp);
            }
            Ok(Err(e)) => {
                // Upstream unreachable -- generate an error response.
                warn!(%peer_addr, host, error = %e, "Upstream connection failed, generating error response");
                let error_body = format!(
                    "{{\"error\":{{\"type\":\"gateway_error\",\"message\":\"Upstream connection failed: {}\"}}}}",
                    e.to_string().replace('"', "\\\"")
                );
                let error_response = format!(
                    "HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    error_body.len(),
                    error_body
                ).into_bytes();
                if let Err(e) = client_tls.write_all(&error_response).await {
                    warn!(%peer_addr, host, error = %e, "Failed to write error response to client");
                    break;
                }
                let _ = client_tls.flush().await;

                // Capture the request/error-response pair even when upstream fails.
                // The 502 response is still valuable for compliance audit trails
                // (proves what was attempted and that it failed).
                if decision.should_capture {
                    if let Err(e) = crate::capture::record_capture(
                        data_dir,
                        &request_bytes,
                        &error_response,
                        provider,
                    ) {
                        warn!(%peer_addr, host, error = %e, "Disk capture of error response failed");
                    }
                    match process_capture_with_pipeline(
                        write_pipeline,
                        &mut session_mgr,
                        provider,
                        &request_bytes,
                        &error_response,
                        wal.as_ref(),
                        Some(metrics_registry),
                    ) {
                        Ok(_turn_record) => {
                            info!(%peer_addr, host, "capture pipeline succeeded for error response (DB + session via WritePipeline)");
                        }
                        Err(e) => {
                            crate::metrics::record_error(metrics_registry);
                            warn!(%peer_addr, host, error = %e, "capture pipeline failed for error response (DB capture)");
                        }
                    }
                }

                trace_response(&error_response);
            }
            Err(_) => {
                warn!(%peer_addr, host, "Upstream forwarding timed out ({:?})", UPSTREAM_TOTAL_TIMEOUT);
                break;
            }
        };

        // Flush to make sure everything is sent.
        if client_tls.flush().await.is_err() {
            break;
        }
    }
}

/// Bidirectional WebSocket relay between the client TLS stream and the
/// upstream TLS stream. Copies data in both directions using `tokio::select!`,
/// capturing text frames (opcode 0x1) for governance recording.
///
/// Text frames are persisted to disk via `record_capture` **and** inserted
/// into the SQLite DB as `TurnRecord`s with `transport = "websocket"` and the
/// appropriate `ws_direction` (`"client_to_server"` or `"server_to_client"`).
/// This ensures WebSocket captures are visible in recondo sessions/turns,
/// not just on disk.
///
/// ## WebSocket capture model (NEW-2)
///
/// Unlike HTTP request/response pairs, WebSocket frames are independent
/// unidirectional messages. Each captured frame produces a `TurnRecord` with
/// only one slot populated:
///
/// - **Client-to-server frames:** `request_hash` contains the frame payload
///   hash; `response_hash` is the hash of an empty byte slice. The response
///   slot is intentionally empty because WebSocket frames are not paired.
///
/// - **Server-to-client frames:** `response_hash` contains the frame payload
///   hash; `request_hash` is the hash of an empty byte slice. The request
///   slot is intentionally empty for the same reason.
///
/// This differs from HTTP captures where both slots are always populated.
/// The `transport` and `ws_direction` fields distinguish WebSocket turns
/// from HTTP turns when querying the DB.
///
/// ## WebSocket continuation frame reassembly (R1-02 fix)
///
/// A `MessageAssembler` is instantiated per direction (client and upstream).
/// Each parsed frame is fed through the assembler. Only when `push()` returns
/// `Some(...)` (indicating a complete reassembled message) is the payload
/// captured to disk and DB.
///
/// ## OpenAI metadata extraction (R1-03 fix)
///
/// The `upgrade_request_bytes` parameter carries the HTTP upgrade request
/// that initiated this WebSocket connection. For OpenAI/Codex traffic, the
/// headers contain identity metadata (account_uuid, session_id, framework,
/// agent_version) which is extracted via `extract_openai_metadata` and
/// logged for session enrichment.
///
/// Runs until either side closes the connection or an error occurs.
async fn websocket_relay<C>(
    client: &mut C,
    mut upstream: tokio_rustls::client::TlsStream<tokio::net::TcpStream>,
    ctx: &WebSocketRelayContext<'_>,
    _session_mgr: &mut crate::session::SessionManager,
    upgrade_request_bytes: &[u8],
) where
    C: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let peer_addr = ctx.peer_addr;
    let host = ctx.host;
    let data_dir = ctx.data_dir;
    let provider = ctx.provider;
    let write_pipeline = ctx.write_pipeline;

    // R1-03 / R2-02 fix: Extract OpenAI identity metadata from the WebSocket
    // upgrade request headers and persist it through capture calls. Previously
    // the metadata was extracted and logged but never passed to the capture
    // function, so SessionRecord fields were all None for OpenAI WebSocket
    // sessions. Now the metadata is stored in `ws_openai_metadata` and passed
    // to every `capture_websocket_frame_via_pipeline` call.
    let ws_openai_metadata: Option<crate::providers::openai::OpenAiMetadata> =
        if provider == "openai" {
            if let Ok(headers_str) = std::str::from_utf8(upgrade_request_bytes) {
                let metadata = crate::providers::openai::extract_openai_metadata(headers_str);
                info!(
                    %peer_addr, host,
                    account_uuid = ?metadata.account_uuid,
                    session_id = ?metadata.session_id,
                    framework = ?metadata.framework,
                    agent_version = ?metadata.agent_version,
                    "Extracted OpenAI identity metadata from WebSocket upgrade request"
                );
                Some(metadata)
            } else {
                None
            }
        } else {
            None
        };

    // B2 fix: Generate a per-connection UUID as the WebSocket session ID.
    // WebSocket connections are long-lived and 1:1 with conversations, so using
    // content-based session resolution (which requires messages arrays) is
    // inappropriate. Each WS connection gets its own unique session ID.
    let ws_session_id = uuid::Uuid::new_v4().to_string();
    let mut ws_sequence_num: i64 = 0;

    // R1-02 fix: Use MessageAssembler to handle continuation frames.
    // One assembler per direction, so interleaved fragments on each direction
    // are reassembled independently.
    let mut client_assembler = crate::websocket::MessageAssembler::new();
    let mut upstream_assembler = crate::websocket::MessageAssembler::new();

    // R1-14 note: 8KB read buffers are a pre-existing design choice. WebSocket
    // frames larger than 8KB will be split across multiple read() calls. With
    // the MessageAssembler (R1-02 fix), this only affects parsing: if a single
    // frame's wire encoding spans multiple reads, parse_frame will fail on the
    // Buffer size must be large enough to hold complete WebSocket frames.
    // Codex client messages include full conversation context and can exceed
    // 8KB. Using 256KB buffers to handle large prompts and system prompts.
    // Frames larger than the buffer are forwarded correctly but not parsed
    // (raw bytes pass through, capture is best-effort).
    let mut client_buf = vec![0u8; 262_144];
    let mut upstream_buf = vec![0u8; 262_144];

    // Codex/OpenAI frame accumulator: accumulates server-to-client WebSocket
    // frames into logical turns instead of writing one DB row per frame.
    // When a complete turn is detected (second rate_limits after content),
    // a single TurnRecord is written with model, response_text, and
    // estimated token counts.
    let mut codex_accumulator: Option<crate::providers::codex::CodexFrameAccumulator> =
        if provider == "openai" {
            Some(crate::providers::codex::CodexFrameAccumulator::new())
        } else {
            None
        };
    // Track estimated input tokens from client->server frames for Codex.
    let mut codex_estimated_input_tokens: i64 = 0;
    // Track the session model name extracted from the first rate_limits frame.
    let mut codex_session_model: Option<String> = None;
    // Track whether we have written the initial session record yet.
    let mut codex_session_created = false;
    // Track per-turn latency for accumulated Codex websocket turns.
    let mut codex_turn_started_at: Option<std::time::Instant> = None;
    let mut codex_ttfb_ms: Option<i64> = None;
    // Track request data from response.create client frames.
    // `codex_initial_request` stores the FIRST parse (for session-level fields:
    // initial_intent, system_prompt_hash).
    // `codex_latest_request` updates on EVERY parse (for turn-level fields:
    // messages_delta, model). This ensures turns 2+ get their own messages/model.
    let mut codex_initial_request: Option<crate::providers::codex::CodexRequestData> = None;
    let mut codex_latest_request: Option<crate::providers::codex::CodexRequestData> = None;

    // Persistent accumulation buffer for client→upstream WebSocket frames.
    // WebSocket frames from Codex can be 30-80KB (system prompt + conversation),
    // but TLS delivers data in ~16KB records. We must accumulate across reads
    // before parsing frames.
    let mut client_accum: Vec<u8> = Vec::with_capacity(262_144);
    // N2 fix: persistent accumulation buffer for upstream (server→client) frames.
    // Server frames are typically small but could theoretically span TLS records.
    let mut upstream_accum: Vec<u8> = Vec::with_capacity(65_536);

    loop {
        tokio::select! {
            // Client -> Upstream
            result = client.read(&mut client_buf) => {
                match result {
                    Ok(0) | Err(_) => {
                        debug!(%peer_addr, host, "WebSocket relay: client closed");
                        break;
                    }
                    Ok(n) => {
                        // Forward raw bytes to upstream immediately (zero latency).
                        if upstream.write_all(&client_buf[..n]).await.is_err() {
                            break;
                        }

                        // Accumulate for frame parsing (capture is async/best-effort).
                        client_accum.extend_from_slice(&client_buf[..n]);

                        // Try to parse complete frames from the accumulation buffer.
                        let mut offset = 0;
                        while offset < client_accum.len() {
                            match crate::websocket::parse_frame(&client_accum[offset..]) {
                                Ok((frame, consumed)) => {
                                    offset += consumed;
                                    if let Some((opcode, payload)) = client_assembler.push(frame) {
                                        if opcode == 0x1 || opcode == 0x2 {
                                            info!(
                                                %peer_addr, host,
                                                direction = "client->upstream",
                                                payload_len = payload.len(),
                                                opcode,
                                                "WebSocket client message captured"
                                            );
                                            if let Err(e) = crate::capture::record_capture(
                                                data_dir,
                                                &payload,
                                                &[],
                                                provider,
                                            ) {
                                                warn!(%peer_addr, host, error = %e, "Failed to capture client->upstream WebSocket frame");
                                            }

                                            // For Codex: estimate input tokens and extract
                                            // intent from client request content.
                                            if codex_accumulator.is_some() {
                                                if let Ok(text) = std::str::from_utf8(&payload) {
                                                    codex_estimated_input_tokens += crate::providers::codex::estimate_tokens(text);
                                                    // Parse response.create to extract model, prompt, system prompt.
                                                    // W1 fix: update latest_request every time (for per-turn messages_delta/model),
                                                    // but only set initial_request once it has a user_prompt (for session-level
                                                    // initial_intent). Codex sends an empty-input init frame first, then the
                                                    // real prompt frame — we need the one with the actual user message.
                                                    if let Ok(req_data) = crate::providers::codex::parse_codex_request(text) {
                                                        if codex_turn_started_at.is_none() {
                                                            codex_turn_started_at = Some(std::time::Instant::now());
                                                            codex_ttfb_ms = None;
                                                        }
                                                        if codex_initial_request.is_none() || (codex_initial_request.as_ref().and_then(|r| r.user_prompt.as_ref()).is_none() && req_data.user_prompt.is_some()) {
                                                            codex_initial_request = Some(req_data.clone());
                                                        }
                                                        codex_latest_request = Some(req_data);
                                                    }
                                                }
                                            } else {
                                                ws_sequence_num += 1;
                                                let frame_ctx = WebSocketFrameContext {
                                                    pipeline: write_pipeline,
                                                    ws_session_id: &ws_session_id,
                                                    sequence_num: ws_sequence_num,
                                                    provider,
                                                    peer_addr,
                                                    host,
                                                    openai_metadata: ws_openai_metadata.as_ref(),
                                                };
                                                capture_websocket_frame_via_pipeline(
                                                    &frame_ctx,
                                                    &payload,
                                                    &[],
                                                    "client_to_server",
                                                );
                                            }
                                        }
                                    }
                                }
                                Err(_) => break, // incomplete frame — wait for more data
                            }
                        }
                        // Remove consumed bytes from accumulation buffer.
                        if offset > 0 {
                            client_accum.drain(..offset);
                        }
                        // N3 fix: cap the buffer to prevent unbounded growth. If the
                        // residual (unparsed bytes after draining consumed) exceeds 1MB,
                        // it means a single WebSocket frame header declared a payload
                        // >1MB that hasn't fully arrived. Discard the residual and log
                        // the dropped byte count for observability.
                        if client_accum.len() > 1_048_576 {
                            warn!(
                                %peer_addr, host,
                                accum_len = client_accum.len(),
                                dropped_bytes = client_accum.len(),
                                "Client WS accumulation buffer exceeded 1MB — dropping residual (likely oversized frame)"
                            );
                            client_accum.clear();
                        }
                    }
                }
            }
            // Upstream -> Client
            result = upstream.read(&mut upstream_buf) => {
                match result {
                    Ok(0) | Err(_) => {
                        debug!(%peer_addr, host, "WebSocket relay: upstream closed");
                        break;
                    }
                    Ok(n) => {
                        // Forward raw bytes to client immediately (zero latency).
                        if client.write_all(&upstream_buf[..n]).await.is_err() {
                            break;
                        }

                        // N2 fix: accumulate upstream bytes for frame parsing,
                        // mirroring the client-side accumulation buffer. Server
                        // frames are typically small but could span TLS records.
                        upstream_accum.extend_from_slice(&upstream_buf[..n]);

                        // Parse frames from the accumulated buffer.
                        let mut offset = 0;
                        while offset < upstream_accum.len() {
                            match crate::websocket::parse_frame(&upstream_accum[offset..]) {
                                Ok((frame, consumed)) => {
                                    offset += consumed;
                                    if let Some((opcode, payload)) = upstream_assembler.push(frame) {
                                        if opcode == 0x1 || opcode == 0x2 {
                                            debug!(
                                                %peer_addr, host,
                                                direction = "upstream->client",
                                                payload_len = payload.len(),
                                                opcode,
                                                "WebSocket message relayed (reassembled)"
                                            );
                                            if let Err(e) = crate::capture::record_capture(
                                                data_dir,
                                                &[],
                                                &payload,
                                                provider,
                                            ) {
                                                warn!(%peer_addr, host, error = %e, "Failed to capture upstream->client WebSocket frame");
                                            }

                                            // For Codex: parse and accumulate server frames
                                            // into logical turns instead of one DB row per frame.
                                            if let Some(ref mut acc) = codex_accumulator {
                                                if let Ok(text) = std::str::from_utf8(&payload) {
                                                    match crate::providers::codex::parse_codex_frame(text) {
                                                        Ok(codex_frame) => {
                                                            if let Some(turn_started_at) = codex_turn_started_at {
                                                                if codex_ttfb_ms.is_none() {
                                                                    codex_ttfb_ms = Some(elapsed_millis(turn_started_at));
                                                                }
                                                            } else {
                                                                codex_turn_started_at = Some(std::time::Instant::now());
                                                                codex_ttfb_ms = Some(0);
                                                            }
                                                            // Track session model from first rate_limits
                                                            if let crate::providers::codex::CodexFrameType::RateLimits { ref model } = codex_frame {
                                                                if codex_session_model.is_none() {
                                                                    codex_session_model = model.clone();
                                                                }
                                                            }
                                                            acc.feed(codex_frame);

                                                            // When a complete turn is detected, write ONE TurnRecord.
                                                            // NOTE: std::mem::take(acc) resets the accumulator to
                                                            // Default (empty) state in-place, which is correct —
                                                            // `acc` is ready for the next turn immediately after
                                                            // this call without re-creation.
                                                            if acc.is_complete() {
                                                                let turn_data = std::mem::take(acc).finish();
                                                                ws_sequence_num += 1;

                                                                // Write accumulated turn via pipeline
                                                                let mut codex_ctx = CodexCaptureContext {
                                                                    pipeline: write_pipeline,
                                                                    ws_session_id: &ws_session_id,
                                                                    sequence_num: ws_sequence_num,
                                                                    provider,
                                                                    peer_addr,
                                                                    host,
                                                                    openai_metadata: ws_openai_metadata.as_ref(),
                                                                    session_model: &codex_session_model,
                                                                    session_created: &mut codex_session_created,
                                                                };
                                                                capture_codex_accumulated_turn(
                                                                    &mut codex_ctx,
                                                                    &turn_data,
                                                                    codex_estimated_input_tokens,
                                                                    codex_initial_request.as_ref(),
                                                                    codex_latest_request.as_ref(),
                                                                    codex_turn_started_at.map(elapsed_millis),
                                                                    codex_ttfb_ms,
                                                                );

                                                                // Reset input token counter and latest request for next turn
                                                                codex_estimated_input_tokens = 0;
                                                                codex_latest_request = None;
                                                                codex_turn_started_at = None;
                                                                codex_ttfb_ms = None;
                                                            }
                                                        }
                                                        Err(e) => {
                                                            debug!(%peer_addr, host, error = %e, "Failed to parse Codex WebSocket frame (non-fatal)");
                                                        }
                                                    }
                                                }
                                            } else {
                                                ws_sequence_num += 1;
                                                let frame_ctx = WebSocketFrameContext {
                                                    pipeline: write_pipeline,
                                                    ws_session_id: &ws_session_id,
                                                    sequence_num: ws_sequence_num,
                                                    provider,
                                                    peer_addr,
                                                    host,
                                                    openai_metadata: ws_openai_metadata.as_ref(),
                                                };
                                                capture_websocket_frame_via_pipeline(
                                                    &frame_ctx,
                                                    &[],
                                                    &payload,
                                                    "server_to_client",
                                                );
                                            }
                                        }
                                    }
                                }
                                Err(_) => break, // incomplete frame — wait for more data
                            }
                        }
                        // Remove consumed bytes from upstream accumulation buffer.
                        if offset > 0 {
                            upstream_accum.drain(..offset);
                        }
                        // N2 fix: cap upstream buffer to prevent unbounded growth
                        if upstream_accum.len() > 1_048_576 {
                            warn!(%peer_addr, host, accum_len = upstream_accum.len(), "Upstream WS accumulation buffer exceeded 1MB, clearing");
                            upstream_accum.clear();
                        }
                    }
                }
            }
        }
    }

    // Best-effort flush on both sides
    let _ = client.flush().await;
    let _ = upstream.flush().await;

    // W2 fix: Flush partial Codex turn data on connection drop.
    // Without this, an in-progress turn (delta_text accumulated but no closing
    // rate_limits received) would be silently discarded.
    if let Some(acc) = codex_accumulator.take() {
        if acc.has_content() {
            let turn_data = acc.finish();
            ws_sequence_num += 1;
            // Write partial turn with capture_complete: false
            let mut codex_ctx = CodexCaptureContext {
                pipeline: write_pipeline,
                ws_session_id: &ws_session_id,
                sequence_num: ws_sequence_num,
                provider,
                peer_addr,
                host,
                openai_metadata: ws_openai_metadata.as_ref(),
                session_model: &codex_session_model,
                session_created: &mut codex_session_created,
            };
            capture_codex_partial_turn(
                &mut codex_ctx,
                &turn_data,
                codex_estimated_input_tokens,
                codex_initial_request.as_ref(),
                codex_latest_request.as_ref(),
                codex_turn_started_at.map(elapsed_millis),
                codex_ttfb_ms,
            );
        }
    }

    info!(%peer_addr, host, "WebSocket relay ended");
}

/// Capture an accumulated Codex turn (multiple frames -> one TurnRecord).
///
/// Called when the `CodexFrameAccumulator` detects a complete turn boundary
/// (a second `rate_limits` frame after content). Writes a single TurnRecord
/// with the model name, response text, and estimated token counts extracted
/// from the accumulated WebSocket frames.
///
/// This replaces the old per-frame capture path for OpenAI/Codex WebSocket
/// traffic, reducing the turn count from N frames to 1 per logical turn.
/// Visibility note (Batch 12): `pub(super)` so the test-support wrapper
/// in `gateway/mod.rs` (gated behind `feature = "test-support"`) can
/// drive this function end-to-end against a real `WritePipeline`.
pub(super) fn capture_codex_accumulated_turn(
    ctx: &mut CodexCaptureContext<'_>,
    turn_data: &crate::providers::codex::CodexTurnData,
    estimated_input_tokens: i64,
    initial_request: Option<&crate::providers::codex::CodexRequestData>,
    latest_request: Option<&crate::providers::codex::CodexRequestData>,
    duration_ms: Option<i64>,
    ttfb_ms: Option<i64>,
) {
    use crate::{db, session};
    let pipeline = ctx.pipeline;
    let ws_session_id = ctx.ws_session_id;
    let sequence_num = ctx.sequence_num;
    let provider = ctx.provider;
    let peer_addr = ctx.peer_addr;
    let host = ctx.host;
    let openai_metadata = ctx.openai_metadata;
    let session_model = ctx.session_model;
    let session_created = &mut *ctx.session_created;
    // W1 fix: latest_request for turn-level fields, initial_request for session-level.
    let turn_request = latest_request.or(initial_request);
    let session_request = initial_request.or(latest_request);

    let now = match time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
    {
        Ok(ts) => ts,
        Err(e) => {
            warn!(%peer_addr, host, error = %e, "Codex accumulated turn: failed to format timestamp");
            return;
        }
    };

    // Resolve model: turn_request.model > turn_data.model (rate_limits) > "unknown"
    let effective_model = turn_request
        .and_then(|rd| rd.model.clone())
        .or_else(|| turn_data.model.clone());

    // Compute cost from estimated tokens.
    // NOTE: thinking/reasoning tokens not yet included in cost — system-wide
    // limitation, not Codex-specific. The compute_cost_usd signature accepts
    // (model, input, output, cache_read, cache_creation) but not thinking
    // tokens. Tracked for future enhancement across all providers.
    let model_name = effective_model.as_deref().unwrap_or("unknown");
    let cost = db::compute_cost_usd(
        db::model_pricing::canonical(),
        model_name,
        estimated_input_tokens,
        turn_data.estimated_output_tokens,
        0,
        0,
        &time::OffsetDateTime::now_utc(),
    );

    let turn_id = uuid::Uuid::new_v4().to_string();

    // Build a content summary for hashing (actual frame bytes are in object store)
    let resp_summary = turn_data.response_text.as_deref().unwrap_or("").as_bytes();
    let req_hash = crate::hash::sha256_hex(&[]);
    let resp_hash = crate::hash::sha256_hex(resp_summary);

    let total_tokens = estimated_input_tokens
        + turn_data.estimated_output_tokens
        + turn_data.estimated_thinking_tokens;

    // Extract messages_delta from request data
    let messages_delta = turn_request.and_then(|rd| rd.messages_json.clone());
    let messages_delta_count = messages_delta.as_ref().and_then(|json| {
        serde_json::from_str::<serde_json::Value>(json)
            .ok()
            .and_then(|v| v.as_array().map(|arr| arr.len() as i64))
    });

    let turn_record = db::TurnRecord {
        id: turn_id,
        session_id: ws_session_id.to_string(),
        sequence_num,
        timestamp: now.clone(),
        request_hash: req_hash.clone(),
        response_hash: resp_hash.clone(),
        req_bytes_ref: Some(format!("objects/req/{}.json.gz", req_hash)),
        resp_bytes_ref: Some(format!("objects/resp/{}.json.gz", resp_hash)),
        req_bytes_size: turn_request
            .and_then(|rd| rd.messages_json.as_ref().map(|m| m.len() as i64)),
        resp_bytes_size: Some(resp_summary.len() as i64),
        model: effective_model.clone(),
        response_text: turn_data.response_text.clone(),
        thinking_text: None,
        stop_reason: String::new(),
        capture_complete: true,
        input_tokens: estimated_input_tokens,
        output_tokens: turn_data.estimated_output_tokens,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: Some(cost),
        created_at: now.clone(),
        messages_delta,
        messages_delta_count,
        raw_extra: None,
        parser_version: Some("codex-0.1.0".to_string()),
        parse_errors: if turn_data.truncated {
            Some("response_text_truncated".to_string())
        } else {
            None
        },
        provider: Some(provider.to_string()),
        transport: Some("websocket".to_string()),
        ws_direction: Some("server_to_client".to_string()),
        duration_ms,
        ttfb_ms,
        api_endpoint: None,
        http_status: None,
        error_message: None,
        retry_count: 0,
        tool_call_count: 0,
        thinking_tokens: turn_data.estimated_thinking_tokens,
        server_id: None,
        integrity_verified: None,
        supersedes_turn_id: None,
        user_request_text: turn_request.and_then(|rd| rd.user_prompt.clone()).map(|t| {
            if t.chars().count() > 2000 {
                t.chars().take(2000).collect()
            } else {
                t
            }
        }),
        // Batch 12: Codex frame parser now surfaces inline-image blocks
        // (`input_image` parts). Speculative count from the parsed turn
        // request; reconciliation below adjusts on dead-letter / partial
        // failure (mirrors `process_capture_with_pipeline`).
        attachment_count: turn_request
            .map(|rd| rd.attachments.len() as i64)
            .unwrap_or(0),
    };

    // Resolve session metadata from OpenAI upgrade headers
    let resolved_account_uuid = openai_metadata.and_then(|m| m.account_uuid.clone());
    let resolved_device_id = openai_metadata.and_then(|m| m.device_id.clone());
    let resolved_framework = openai_metadata.and_then(|m| m.framework.clone());
    let resolved_agent_version = openai_metadata.and_then(|m| m.agent_version.clone());

    // Resolve session-level fields from request data
    let effective_session_model = session_request
        .and_then(|rd| rd.model.clone())
        .or_else(|| session_model.clone());
    let session_initial_intent = session_request.and_then(|rd| rd.user_prompt.clone());
    let system_prompt_hash_from_request =
        session_request.and_then(|rd| rd.system_prompt_hash.clone());

    let is_first = !*session_created;
    let session_record = if is_first {
        *session_created = true;
        let system_prompt_hash = system_prompt_hash_from_request
            .unwrap_or_else(|| session::compute_system_prompt_hash(None));
        db::SessionRecord {
            id: ws_session_id.to_string(),
            provider: provider.to_string(),
            model: effective_session_model.clone(),
            started_at: now.clone(),
            last_active_at: now.clone(),
            ended_at: None,
            initial_intent: session_initial_intent.clone(),
            system_prompt_hash,
            total_turns: 1,
            turns_captured: 1,
            dropped_events: 0,
            total_tokens,
            total_cost_usd: cost,
            framework: resolved_framework,
            agent_id: None,
            agent_version: resolved_agent_version,
            git_repo: None,
            git_branch: None,
            git_commit: None,
            working_directory: None,
            parent_session_id: None,
            tags: None,
            account_uuid: resolved_account_uuid,
            device_id: resolved_device_id,
            tool_definitions_hash: String::new(),
        }
    } else {
        db::SessionRecord {
            id: ws_session_id.to_string(),
            provider: provider.to_string(),
            model: effective_session_model.clone(),
            started_at: now.clone(),
            last_active_at: now.clone(),
            ended_at: None,
            initial_intent: None,
            system_prompt_hash: String::new(),
            total_turns: 0,
            turns_captured: 0,
            dropped_events: 0,
            total_tokens: 0,
            total_cost_usd: 0.0,
            framework: resolved_framework,
            agent_id: None,
            agent_version: resolved_agent_version,
            git_repo: None,
            git_branch: None,
            git_commit: None,
            working_directory: None,
            parent_session_id: None,
            tags: None,
            account_uuid: resolved_account_uuid,
            device_id: resolved_device_id,
            tool_definitions_hash: String::new(),
        }
    };

    match pipeline.write_capture(&session_record, &turn_record, &[], &[], resp_summary) {
        Ok(()) => {
            if !is_first {
                if let Err(e) =
                    pipeline
                        .graph()
                        .update_session_totals(ws_session_id, 1, 1, total_tokens, cost)
                {
                    warn!(%peer_addr, host, error = %e, "Failed to update Codex session totals (non-fatal)");
                }
                if let Some(ref model) = effective_session_model {
                    if !model.is_empty() {
                        if let Err(e) = pipeline.graph().update_session_model(ws_session_id, model)
                        {
                            warn!(%peer_addr, host, error = %e, "Failed to backfill Codex session model (non-fatal)");
                        }
                    }
                }
                if let Some(ref initial_intent) = session_initial_intent {
                    if !initial_intent.is_empty() {
                        if let Err(e) = pipeline
                            .graph()
                            .update_session_initial_intent(ws_session_id, initial_intent)
                        {
                            warn!(%peer_addr, host, error = %e, "Failed to backfill Codex session initial intent (non-fatal)");
                        }
                    }
                }
            }
            // Batch 12: persist any inline attachments (images) extracted
            // from the response.create's user content.
            if let Some(rd) = turn_request {
                let speculative_count = rd.attachments.len() as i64;
                write_codex_attachments(
                    pipeline,
                    &rd.attachments,
                    ws_session_id,
                    &turn_record.id,
                    speculative_count,
                    peer_addr,
                    host,
                );
            }
            info!(
                %peer_addr, host,
                model = model_name,
                output_tokens = turn_data.estimated_output_tokens,
                thinking_tokens = turn_data.estimated_thinking_tokens,
                "Codex accumulated turn captured via WritePipeline"
            );
        }
        Err(e) => {
            warn!(%peer_addr, host, error = %e, "Codex accumulated turn: write_capture failed (may be dead-lettered)");
        }
    }
}

/// Batch 12: persist any inline attachments (images) extracted from a
/// codex `response.create`'s user content. Shared between
/// `capture_codex_accumulated_turn` (normal turn-end) and
/// `capture_codex_partial_turn` (connection drop) so partial captures
/// don't leave `turn.attachment_count > 0` with no rows in the
/// `attachments` table.
///
/// Mirrors the attachment loop in `process_capture_with_pipeline`:
/// each bundle is written via `pipeline.write_attachment` (retry +
/// DLQ); on partial failure we reconcile `turn.attachment_count` down
/// to the real persisted count so the dashboard never overcounts.
fn write_codex_attachments(
    pipeline: &crate::storage::pipeline::WritePipeline,
    attachments: &[crate::capture::attachments::ExtractedAttachment],
    ws_session_id: &str,
    turn_id: &str,
    speculative_count: i64,
    peer_addr: std::net::SocketAddr,
    host: &str,
) {
    if attachments.is_empty() {
        return;
    }
    let mut persisted_count: i64 = 0;
    for (idx, extracted) in attachments.iter().enumerate() {
        let (sha256, object_ref, size_bytes, bytes_for_put) = if extracted.bytes.is_empty() {
            (
                String::new(),
                extracted.source_url.clone().unwrap_or_default(),
                0i64,
                Vec::new(),
            )
        } else {
            let sha = crate::hash::sha256_hex(&extracted.bytes);
            (
                sha.clone(),
                format!("attachments/{}.json.gz", sha),
                extracted.bytes.len() as i64,
                extracted.bytes.clone(),
            )
        };
        let record = crate::db::AttachmentRecord {
            id: format!("{}-att-{}", turn_id, idx + 1),
            turn_id: turn_id.to_string(),
            session_id: ws_session_id.to_string(),
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
        };
        match pipeline.write_attachment(&record, &bytes_for_put) {
            Ok(true) => persisted_count += 1,
            Ok(false) => warn!(
                %peer_addr, host,
                turn_id = %turn_id,
                attachment_id = %record.id,
                "Codex attachment dead-lettered after retries"
            ),
            Err(e) => warn!(
                %peer_addr, host,
                turn_id = %turn_id,
                attachment_id = %record.id,
                error = %e,
                "Codex attachment write fully failed (DLQ also failed)"
            ),
        }
    }
    if persisted_count != speculative_count {
        if let Err(e) = pipeline
            .graph()
            .update_turn_attachment_count(turn_id, persisted_count)
        {
            warn!(
                %peer_addr, host,
                turn_id = %turn_id,
                speculative = speculative_count,
                persisted = persisted_count,
                error = %e,
                "Failed to reconcile codex turn.attachment_count"
            );
        }
    }
}

/// Capture a partial Codex turn on connection drop (W2 fix).
///
/// Called when the WebSocket relay loop exits with in-progress content in the
/// accumulator. Writes a TurnRecord with `capture_complete: false` to preserve
/// partial data rather than silently discarding it.
fn capture_codex_partial_turn(
    ctx: &mut CodexCaptureContext<'_>,
    turn_data: &crate::providers::codex::CodexTurnData,
    estimated_input_tokens: i64,
    initial_request: Option<&crate::providers::codex::CodexRequestData>,
    latest_request: Option<&crate::providers::codex::CodexRequestData>,
    duration_ms: Option<i64>,
    ttfb_ms: Option<i64>,
) {
    use crate::{db, session};
    let pipeline = ctx.pipeline;
    let ws_session_id = ctx.ws_session_id;
    let sequence_num = ctx.sequence_num;
    let provider = ctx.provider;
    let peer_addr = ctx.peer_addr;
    let host = ctx.host;
    let openai_metadata = ctx.openai_metadata;
    let session_model = ctx.session_model;
    let session_created = &mut *ctx.session_created;
    let turn_request = latest_request.or(initial_request);
    let session_request = initial_request.or(latest_request);

    let now = match time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
    {
        Ok(ts) => ts,
        Err(e) => {
            warn!(%peer_addr, host, error = %e, "Codex partial turn: failed to format timestamp");
            return;
        }
    };

    // Resolve model: turn_request.model > turn_data.model (rate_limits) > "unknown"
    let effective_model = turn_request
        .and_then(|rd| rd.model.clone())
        .or_else(|| turn_data.model.clone());

    // NOTE: thinking/reasoning tokens not yet included in cost — system-wide
    // limitation, not Codex-specific. Tracked for future enhancement.
    let model_name = effective_model.as_deref().unwrap_or("unknown");
    let cost = db::compute_cost_usd(
        db::model_pricing::canonical(),
        model_name,
        estimated_input_tokens,
        turn_data.estimated_output_tokens,
        0,
        0,
        &time::OffsetDateTime::now_utc(),
    );

    let turn_id = uuid::Uuid::new_v4().to_string();

    let resp_summary = turn_data.response_text.as_deref().unwrap_or("").as_bytes();
    let req_hash = crate::hash::sha256_hex(&[]);
    let resp_hash = crate::hash::sha256_hex(resp_summary);

    let total_tokens = estimated_input_tokens
        + turn_data.estimated_output_tokens
        + turn_data.estimated_thinking_tokens;

    // Extract messages_delta from request data
    let messages_delta = turn_request.and_then(|rd| rd.messages_json.clone());
    let messages_delta_count = messages_delta.as_ref().and_then(|json| {
        serde_json::from_str::<serde_json::Value>(json)
            .ok()
            .and_then(|v| v.as_array().map(|arr| arr.len() as i64))
    });

    let turn_record = db::TurnRecord {
        id: turn_id,
        session_id: ws_session_id.to_string(),
        sequence_num,
        timestamp: now.clone(),
        request_hash: req_hash.clone(),
        response_hash: resp_hash.clone(),
        req_bytes_ref: Some(format!("objects/req/{}.json.gz", req_hash)),
        resp_bytes_ref: Some(format!("objects/resp/{}.json.gz", resp_hash)),
        req_bytes_size: turn_request
            .and_then(|rd| rd.messages_json.as_ref().map(|m| m.len() as i64)),
        resp_bytes_size: Some(resp_summary.len() as i64),
        model: effective_model.clone(),
        response_text: turn_data.response_text.clone(),
        thinking_text: None,
        stop_reason: String::new(),
        capture_complete: false, // Partial turn — connection dropped before completion
        input_tokens: estimated_input_tokens,
        output_tokens: turn_data.estimated_output_tokens,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: Some(cost),
        created_at: now.clone(),
        messages_delta,
        messages_delta_count,
        raw_extra: None,
        parser_version: Some("codex-0.1.0".to_string()),
        parse_errors: Some(if turn_data.truncated {
            "connection_dropped_partial_turn,response_text_truncated".to_string()
        } else {
            "connection_dropped_partial_turn".to_string()
        }),
        provider: Some(provider.to_string()),
        transport: Some("websocket".to_string()),
        ws_direction: Some("server_to_client".to_string()),
        duration_ms,
        ttfb_ms,
        api_endpoint: None,
        http_status: None,
        error_message: None,
        retry_count: 0,
        tool_call_count: 0,
        thinking_tokens: turn_data.estimated_thinking_tokens,
        server_id: None,
        integrity_verified: None,
        supersedes_turn_id: None,
        user_request_text: turn_request.and_then(|rd| rd.user_prompt.clone()).map(|t| {
            if t.chars().count() > 2000 {
                t.chars().take(2000).collect()
            } else {
                t
            }
        }),
        // Batch 12: Codex frame parser now surfaces inline-image blocks
        // (`input_image` parts). Speculative count from the parsed turn
        // request; reconciliation below adjusts on dead-letter / partial
        // failure (mirrors `process_capture_with_pipeline`).
        attachment_count: turn_request
            .map(|rd| rd.attachments.len() as i64)
            .unwrap_or(0),
    };

    // Resolve session metadata from OpenAI upgrade headers
    let resolved_account_uuid = openai_metadata.and_then(|m| m.account_uuid.clone());
    let resolved_device_id = openai_metadata.and_then(|m| m.device_id.clone());
    let resolved_framework = openai_metadata.and_then(|m| m.framework.clone());
    let resolved_agent_version = openai_metadata.and_then(|m| m.agent_version.clone());

    // Resolve session-level fields from request data
    let effective_session_model = session_request
        .and_then(|rd| rd.model.clone())
        .or_else(|| session_model.clone());
    let session_initial_intent = session_request.and_then(|rd| rd.user_prompt.clone());
    let system_prompt_hash_from_request =
        session_request.and_then(|rd| rd.system_prompt_hash.clone());

    let is_first = !*session_created;
    let session_record = if is_first {
        *session_created = true;
        let system_prompt_hash = system_prompt_hash_from_request
            .unwrap_or_else(|| session::compute_system_prompt_hash(None));
        db::SessionRecord {
            id: ws_session_id.to_string(),
            provider: provider.to_string(),
            model: effective_session_model.clone(),
            started_at: now.clone(),
            last_active_at: now.clone(),
            ended_at: None,
            initial_intent: session_initial_intent.clone(),
            system_prompt_hash,
            total_turns: 1,
            turns_captured: 1,
            dropped_events: 0,
            total_tokens,
            total_cost_usd: cost,
            framework: resolved_framework,
            agent_id: None,
            agent_version: resolved_agent_version,
            git_repo: None,
            git_branch: None,
            git_commit: None,
            working_directory: None,
            parent_session_id: None,
            tags: None,
            account_uuid: resolved_account_uuid,
            device_id: resolved_device_id,
            tool_definitions_hash: String::new(),
        }
    } else {
        db::SessionRecord {
            id: ws_session_id.to_string(),
            provider: provider.to_string(),
            model: effective_session_model.clone(),
            started_at: now.clone(),
            last_active_at: now.clone(),
            ended_at: None,
            initial_intent: None,
            system_prompt_hash: String::new(),
            total_turns: 0,
            turns_captured: 0,
            dropped_events: 0,
            total_tokens: 0,
            total_cost_usd: 0.0,
            framework: resolved_framework,
            agent_id: None,
            agent_version: resolved_agent_version,
            git_repo: None,
            git_branch: None,
            git_commit: None,
            working_directory: None,
            parent_session_id: None,
            tags: None,
            account_uuid: resolved_account_uuid,
            device_id: resolved_device_id,
            tool_definitions_hash: String::new(),
        }
    };

    match pipeline.write_capture(&session_record, &turn_record, &[], &[], resp_summary) {
        Ok(()) => {
            if !is_first {
                if let Err(e) =
                    pipeline
                        .graph()
                        .update_session_totals(ws_session_id, 1, 1, total_tokens, cost)
                {
                    warn!(%peer_addr, host, error = %e, "Failed to update Codex session totals for partial turn (non-fatal)");
                }
                if let Some(ref model) = effective_session_model {
                    if !model.is_empty() {
                        if let Err(e) = pipeline.graph().update_session_model(ws_session_id, model)
                        {
                            warn!(%peer_addr, host, error = %e, "Failed to backfill Codex session model for partial turn (non-fatal)");
                        }
                    }
                }
                if let Some(ref initial_intent) = session_initial_intent {
                    if !initial_intent.is_empty() {
                        if let Err(e) = pipeline
                            .graph()
                            .update_session_initial_intent(ws_session_id, initial_intent)
                        {
                            warn!(%peer_addr, host, error = %e, "Failed to backfill Codex session initial intent for partial turn (non-fatal)");
                        }
                    }
                }
            }
            // Batch 12: persist any inline attachments even on partial
            // turns so a connection drop after the user uploaded an
            // image doesn't lose the image from the audit trail.
            if let Some(rd) = turn_request {
                let speculative_count = rd.attachments.len() as i64;
                write_codex_attachments(
                    pipeline,
                    &rd.attachments,
                    ws_session_id,
                    &turn_record.id,
                    speculative_count,
                    peer_addr,
                    host,
                );
            }
            info!(
                %peer_addr, host,
                model = model_name,
                output_tokens = turn_data.estimated_output_tokens,
                "Codex partial turn captured on connection drop (capture_complete=false)"
            );
        }
        Err(e) => {
            warn!(%peer_addr, host, error = %e, "Codex partial turn: write_capture failed (may be dead-lettered)");
        }
    }
}

/// Capture a single WebSocket text frame via the `WritePipeline`.
///
/// Uses the same `WritePipeline` as the HTTP capture path, gaining
/// retry with exponential backoff and dead-letter queue on failure.
///
/// B2 fix: Uses a pre-generated `ws_session_id` (one UUID per WebSocket
/// connection) and a caller-provided `sequence_num` instead of resolving
/// sessions from empty messages via SessionManager.
///
/// ## Known limitation: token counts are 0 (B3)
///
/// WebSocket frames (e.g., Codex/OpenAI via `chatgpt.com`) do not carry
/// per-turn token usage in the same way as Anthropic HTTP SSE responses.
/// Token counts would need to be parsed from WebSocket message payloads,
/// which is provider-specific and not yet implemented. As a result,
/// `input_tokens`, `output_tokens`, `cache_read_tokens`, and
/// `cache_creation_tokens` are hardcoded to 0. This is tracked as future
/// work for Phase 2 WebSocket provider parsing.
///
/// Errors are logged and swallowed (best-effort) to avoid disrupting the relay.
fn capture_websocket_frame_via_pipeline(
    ctx: &WebSocketFrameContext<'_>,
    request_bytes: &[u8],
    response_bytes: &[u8],
    ws_direction: &str,
) {
    use crate::{db, session};
    let pipeline = ctx.pipeline;
    let ws_session_id = ctx.ws_session_id;
    let sequence_num = ctx.sequence_num;
    let provider = ctx.provider;
    let peer_addr = ctx.peer_addr;
    let host = ctx.host;
    let openai_metadata = ctx.openai_metadata;

    // R2-02 fix: Use OpenAI metadata from the upgrade request headers when
    // available. Previously this called `extract_client_metadata(request_bytes)`
    // which parses Anthropic-style `metadata.user_id` from JSON — but WebSocket
    // frame payloads don't contain HTTP headers, so the result was always None
    // for all fields. Now we use the pre-extracted OpenAI metadata from the
    // upgrade request, falling back to frame-level extraction for non-OpenAI.
    let ws_metadata = session::extract_client_metadata(request_bytes);

    let now = match time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
    {
        Ok(ts) => ts,
        Err(e) => {
            warn!(%peer_addr, host, error = %e, "WS pipeline capture: failed to format timestamp");
            return;
        }
    };

    let req_hash = crate::hash::sha256_hex(request_bytes);
    let resp_hash = crate::hash::sha256_hex(response_bytes);

    let turn_id = uuid::Uuid::new_v4().to_string();
    let is_first_frame = sequence_num == 1;

    let turn_record = db::TurnRecord {
        id: turn_id,
        session_id: ws_session_id.to_string(),
        sequence_num,
        timestamp: now.clone(),
        request_hash: req_hash.clone(),
        response_hash: resp_hash.clone(),
        req_bytes_ref: Some(format!("objects/req/{}.json.gz", req_hash)),
        resp_bytes_ref: Some(format!("objects/resp/{}.json.gz", resp_hash)),
        req_bytes_size: Some(request_bytes.len() as i64),
        resp_bytes_size: Some(response_bytes.len() as i64),
        model: None,
        response_text: None,
        thinking_text: None,
        stop_reason: String::new(),
        capture_complete: true,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: now.clone(),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: None,
        parser_version: None,
        parse_errors: None,
        provider: Some(provider.to_string()),
        transport: Some("websocket".to_string()),
        ws_direction: Some(ws_direction.to_string()),
        duration_ms: None,
        ttfb_ms: None,
        api_endpoint: None,
        http_status: None,
        error_message: None,
        retry_count: 0,
        tool_call_count: 0,
        thinking_tokens: 0,
        server_id: None,
        integrity_verified: None,
        // B1 fix: WebSocket frames don't carry tool calls, so there are no
        // artifacts to resolve a SUPERSEDES chain from. Intentionally None.
        supersedes_turn_id: None,
        // Generic WS path — no structured request data available.
        user_request_text: None,
        // FIND-1-E: generic WebSocket frame path (non-Codex). No
        // structured `messages[]` is available — just raw frames. There
        // is nothing to feed to `extract_from_messages`, so
        // `attachment_count` is structurally 0 on this path.
        // TODO(attachment-generic-ws): if provider-specific WS frame
        // parsers grow image-block surfacing, wire per-provider
        // extraction here.
        attachment_count: 0,
    };

    // R2-02 fix: Resolve account_uuid, framework, and agent_version from
    // OpenAI upgrade-request metadata when available. This ensures SessionRecord
    // fields are populated for OpenAI WebSocket sessions (Codex), where
    // frame-level `extract_client_metadata` always returns None because WS
    // payloads don't carry Anthropic-style `metadata.user_id` headers.
    let resolved_account_uuid = openai_metadata
        .and_then(|m| m.account_uuid.clone())
        .or_else(|| ws_metadata.account_uuid.clone());
    let resolved_device_id = openai_metadata
        .and_then(|m| m.device_id.clone())
        .or_else(|| ws_metadata.device_id.clone());
    let resolved_framework = openai_metadata.and_then(|m| m.framework.clone());
    let resolved_agent_version = openai_metadata.and_then(|m| m.agent_version.clone());

    let session_record = if is_first_frame {
        let system_prompt_hash = crate::session::compute_system_prompt_hash(None);
        db::SessionRecord {
            id: ws_session_id.to_string(),
            provider: provider.to_string(),
            model: None,
            started_at: now.clone(),
            last_active_at: now.clone(),
            ended_at: None,
            initial_intent: None,
            system_prompt_hash,
            total_turns: 1,
            turns_captured: 1,
            dropped_events: 0,
            total_tokens: 0,
            total_cost_usd: 0.0,
            framework: resolved_framework.clone(),
            agent_id: None,
            agent_version: resolved_agent_version.clone(),
            git_repo: None,
            git_branch: None,
            git_commit: None,
            working_directory: None,
            parent_session_id: None,
            tags: None,
            account_uuid: resolved_account_uuid.clone(),
            device_id: resolved_device_id.clone(),
            tool_definitions_hash: String::new(),
        }
    } else {
        db::SessionRecord {
            id: ws_session_id.to_string(),
            provider: provider.to_string(),
            model: None,
            started_at: now.clone(),
            last_active_at: now.clone(),
            ended_at: None,
            initial_intent: None,
            system_prompt_hash: String::new(),
            total_turns: 0,
            turns_captured: 0,
            dropped_events: 0,
            total_tokens: 0,
            total_cost_usd: 0.0,
            framework: resolved_framework,
            agent_id: None,
            agent_version: resolved_agent_version,
            git_repo: None,
            git_branch: None,
            git_commit: None,
            working_directory: None,
            parent_session_id: None,
            tags: None,
            account_uuid: resolved_account_uuid,
            device_id: resolved_device_id,
            tool_definitions_hash: String::new(),
        }
    };

    // Delegate to WritePipeline for retry + DLQ.
    match pipeline.write_capture(
        &session_record,
        &turn_record,
        &[],
        request_bytes,
        response_bytes,
    ) {
        Ok(()) => {
            // Update session aggregates for subsequent frames (first frame's
            // totals are set during insert).
            if !is_first_frame {
                if let Err(e) = pipeline.graph().update_session_totals(
                    ws_session_id,
                    1,   // delta_turns
                    1,   // delta_captured
                    0,   // delta_tokens (WS frames don't carry token counts)
                    0.0, // delta_cost_usd
                ) {
                    warn!(%peer_addr, host, error = %e, "Failed to update WS session totals (non-fatal)");
                }
            }
            info!(%peer_addr, host, ws_direction, "WebSocket frame captured via WritePipeline");
        }
        Err(e) => {
            warn!(%peer_addr, host, ws_direction, error = %e, "WS pipeline capture: write_capture failed (may be dead-lettered)");
        }
    }
}

/// Forward a request to upstream, stream response chunks to the client
/// immediately, and accumulate a copy for capture.
///
/// This implements the "chunk-forward accumulation" pattern:
/// 1. Read chunk from upstream
/// 2. Write chunk to client immediately (zero added latency)
/// 3. Append chunk to capture buffer
/// 4. When upstream closes, return the accumulated buffer
///
/// Returns a `StreamResult`:
/// - `StreamResult::Complete(response_bytes, is_partial)` for normal HTTP responses.
/// - `StreamResult::WebSocketUpgrade(upstream_tls, response_headers)` when a 101
///   Switching Protocols response is detected. The 101 headers are forwarded to
///   the client, and the upstream TLS stream is returned for bidirectional relay.
async fn stream_to_client_and_accumulate<W>(
    host: &str,
    port: u16,
    request_bytes: &[u8],
    client_writer: &mut W,
    data_dir: &Path,
) -> Result<crate::websocket::StreamResult<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Connect to upstream via TCP
    let upstream_addr = format!("{}:{}", host, port);
    let tcp_stream = tokio::net::TcpStream::connect(&upstream_addr)
        .await
        .context("Failed to connect to upstream")?;

    // Build TLS client config with webpki root certificates + any extra CA certs.
    // Extra CAs are needed when the gateway runs behind a corporate TLS inspection
    // firewall that re-signs upstream certificates with its own CA.
    // Load from: RECONDO_EXTRA_CA_CERTS env var (path to PEM file) or {data_dir}/ca/extra_roots.pem.
    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    load_extra_ca_certs(&mut root_store, data_dir);

    crate::gateway::crypto::ensure_provider();
    let client_config = rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();

    let connector = tokio_rustls::TlsConnector::from(std::sync::Arc::new(client_config));
    let server_name = rustls::pki_types::ServerName::try_from(host.to_string())
        .context("Invalid server name for upstream TLS")?;

    let mut upstream_tls = connector
        .connect(server_name, tcp_stream)
        .await
        .context("TLS handshake with upstream failed")?;

    // R1-10 fix: Strip Sec-WebSocket-Extensions header from upgrade requests
    // before forwarding to upstream. This prevents the server from negotiating
    // permessage-deflate, which would set RSV1=1 on compressed frames.
    // The MITM proxy does not implement extension decompression, so compressed
    // frames would be rejected by parse_frame's RSV bit validation. Stripping
    // the extension header is the standard MITM proxy technique: the client
    // thinks no extensions were negotiated (server won't include
    // Sec-WebSocket-Extensions in its 101 response) and sends uncompressed frames.
    let request_to_send = strip_websocket_extensions_header(request_bytes);
    upstream_tls
        .write_all(&request_to_send)
        .await
        .context("Failed to write request to upstream")?;
    upstream_tls.flush().await?;

    // Stream response chunks: read from upstream, write to client, accumulate.
    // We need to detect when the response is complete based on HTTP framing
    // (Content-Length or chunked TE), not just waiting for connection close,
    // because HTTP/1.1 keep-alive connections stay open after the response.
    let mut response = Vec::with_capacity(8192);
    let mut tmp = [0u8; 8192];
    let mut partial = false;
    let mut headers_parsed = false;
    let mut expected_body_len: Option<usize> = None;
    let mut header_end_pos: Option<usize> = None;
    let mut is_chunked = false;
    let mut is_compressed = false;
    // For live trace of compressed SSE: track how many decompressed bytes
    // we have already traced, so we only print new SSE lines after each read.
    let mut last_trace_len: usize = 0;

    loop {
        // Finding 6: Timeout on individual read operations from upstream.
        let read_result =
            tokio::time::timeout(UPSTREAM_READ_TIMEOUT, upstream_tls.read(&mut tmp)).await;

        let n = match read_result {
            Ok(Ok(0)) => {
                // Upstream closed connection — response complete
                break;
            }
            Ok(Ok(n)) => n,
            Ok(Err(e)) => {
                // Finding 9: If we have partial data, mark as partial and break
                if !response.is_empty() {
                    warn!(
                        error = %e,
                        accumulated_bytes = response.len(),
                        "Error reading from upstream after partial response; capturing partial data"
                    );
                    partial = true;
                    break;
                }
                return Err(e.into());
            }
            Err(_) => {
                // Individual read timed out
                if !response.is_empty() {
                    warn!(
                        accumulated_bytes = response.len(),
                        "Upstream read timed out ({:?}) after partial response",
                        UPSTREAM_READ_TIMEOUT
                    );
                    partial = true;
                    break;
                }
                bail!(
                    "Upstream read timed out ({:?}) with no data received",
                    UPSTREAM_READ_TIMEOUT
                );
            }
        };

        // Finding 5: Check size limit before accumulating
        if response.len() + n > MAX_RESPONSE_SIZE {
            warn!(
                accumulated_bytes = response.len(),
                chunk_size = n,
                max_size = MAX_RESPONSE_SIZE,
                "Response exceeds MAX_RESPONSE_SIZE, truncating capture accumulation"
            );
            // Still forward this chunk to client, but stop accumulating
            if let Err(e) = client_writer.write_all(&tmp[..n]).await {
                warn!(error = %e, "Failed to write chunk to client");
                partial = true;
                break;
            }
            partial = true;
            break;
        }

        // Step 2: Write chunk to client immediately (zero added latency)
        if let Err(e) = client_writer.write_all(&tmp[..n]).await {
            warn!(error = %e, "Failed to write chunk to client");
            partial = true;
            break;
        }

        // Step 3: Append chunk to capture buffer
        response.extend_from_slice(&tmp[..n]);

        // Live trace: print SSE events as they stream through.
        // This runs AFTER appending to `response` so that we can decode
        // chunked TE from the complete accumulated body (not individual
        // TCP read boundaries, which don't align with HTTP chunk boundaries).
        if trace_enabled() && is_chunked && headers_parsed {
            if is_compressed {
                if let Some(hdr_end) = header_end_pos {
                    // Decode chunked TE from the full accumulated body,
                    // then decompress the concatenated gzip payload.
                    let raw_body = &response[hdr_end..];
                    let unchunked = decode_chunked_bytes(raw_body);
                    let decompressed = decompress_gzip_partial(&unchunked);
                    if decompressed.len() > last_trace_len {
                        let new_bytes = &decompressed[last_trace_len..];
                        if let Ok(new_text) = std::str::from_utf8(new_bytes) {
                            for line in new_text.lines() {
                                let line = line.trim();
                                if line.starts_with("data: ") {
                                    trace_sse_line(line);
                                }
                            }
                        }
                        last_trace_len = decompressed.len();
                    }
                }
            } else {
                trace_sse_chunk(&tmp[..n]);
            }
        }

        // Parse headers once to determine response framing
        if !headers_parsed {
            if let Some(pos) = response.windows(4).position(|w| w == b"\r\n\r\n") {
                headers_parsed = true;
                header_end_pos = Some(pos + 4);
                if let Ok(headers_str) = std::str::from_utf8(&response[..pos + 4]) {
                    if let Some(cl) = parse_content_length(headers_str) {
                        expected_body_len = Some(cl);
                    }
                    if has_chunked_transfer_encoding(headers_str) {
                        is_chunked = true;
                    }
                    // Detect gzip/br/deflate content encoding
                    for line in headers_str.lines() {
                        let lower = line.to_ascii_lowercase();
                        if lower.starts_with("content-encoding:") {
                            let val = lower.trim_start_matches("content-encoding:").trim();
                            if val.contains("gzip") || val.contains("br") || val.contains("deflate")
                            {
                                is_compressed = true;
                            }
                        }
                    }
                    info!(
                        host,
                        content_length = ?expected_body_len,
                        is_chunked,
                        is_compressed,
                        header_bytes = pos + 4,
                        "Response headers parsed"
                    );

                    // Live trace: print response header
                    if trace_enabled() {
                        let status_line = headers_str.lines().next().unwrap_or("");
                        let now = time::OffsetDateTime::now_utc();
                        let ts =
                            format!("{:02}:{:02}:{:02}", now.hour(), now.minute(), now.second());
                        if is_chunked {
                            eprintln!(
                                "\x1b[36m[{ts}]\x1b[0m \x1b[1;32m← {status_line}\x1b[0m (streaming)"
                            );
                        } else {
                            eprintln!("\x1b[36m[{ts}]\x1b[0m \x1b[1;32m← {status_line}\x1b[0m");
                        }
                    }

                    // BLOCKER 1+2: Detect HTTP/1.1 101 Switching Protocols
                    // immediately. A 101 response has no Content-Length and is
                    // not chunked — the accumulator would hang waiting for EOF.
                    // Instead, forward the 101 headers to the client and return
                    // the upstream TLS stream for bidirectional WebSocket relay.
                    if crate::websocket::is_websocket_upgrade(&response) {
                        info!(host, "WebSocket 101 detected in upstream response");
                        // The 101 headers were already forwarded to the client
                        // (each chunk is written to client_writer immediately).
                        // Return the upstream stream for relay.
                        return Ok(crate::websocket::StreamResult::WebSocketUpgrade(
                            upstream_tls,
                            response,
                        ));
                    }
                }
            }
        }

        // Check if we have a complete response based on framing
        if let Some(hdr_end) = header_end_pos {
            if let Some(cl) = expected_body_len {
                // Content-Length framing: done when we have headers + cl bytes
                let total_needed = hdr_end + cl;
                if response.len() >= total_needed {
                    response.truncate(total_needed);
                    break;
                }
            } else if is_chunked {
                // Chunked framing: done when the body ends with the terminal
                // chunk sequence. The terminal chunk is "0\r\n\r\n" (possibly
                // with trailers between the two CRLFs, but typically not).
                // It's preceded by "\r\n" from the previous chunk's data.
                let body = &response[hdr_end..];
                if body.ends_with(b"0\r\n\r\n") {
                    break;
                }
            }
            // else: no Content-Length and not chunked — read until EOF (connection close)
        }
    }

    Ok(crate::websocket::StreamResult::Complete(response, partial))
}

/// Read a complete HTTP request from a TLS stream.
///
/// Reads until the header boundary (\r\n\r\n) is found, then reads
/// the body based on Content-Length or Transfer-Encoding. Returns the
/// complete request bytes (headers + body).
///
/// ## Transfer-Encoding: chunked (Finding 4)
///
/// If the request uses chunked transfer encoding, the chunked body is
/// read and decoded (chunk framing is stripped). The returned bytes
/// contain the original headers (with Transfer-Encoding removed and
/// Content-Length added) followed by the decoded body.
async fn read_http_request<S: tokio::io::AsyncRead + Unpin>(stream: &mut S) -> Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;

    let mut buf = Vec::with_capacity(8192);
    let mut tmp = [0u8; 4096];

    // Read until we find the header boundary \r\n\r\n
    let header_end;
    loop {
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            if buf.is_empty() {
                return Ok(Vec::new()); // Clean connection close
            }
            bail!("Connection closed before complete HTTP headers");
        }
        buf.extend_from_slice(&tmp[..n]);

        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = pos + 4;
            break;
        }

        if buf.len() > 64 * 1024 {
            bail!("HTTP headers exceed 64KB limit");
        }
    }

    // Parse headers to determine body length
    let headers_str =
        std::str::from_utf8(&buf[..header_end]).context("HTTP headers are not valid UTF-8")?;

    // Finding 4: Detect Transfer-Encoding: chunked
    if has_chunked_transfer_encoding(headers_str) {
        // Read and decode chunked body.
        // We need to read chunk-size\r\n, chunk-data\r\n, ..., 0\r\n\r\n
        warn!("Request uses chunked transfer encoding; reading and decoding chunked body");

        let mut decoded_body = Vec::new();
        // Any leftover bytes after the header boundary are the start of the chunked body
        let mut chunk_buf: Vec<u8> = buf[header_end..].to_vec();

        loop {
            // Ensure we have a complete chunk-size line (terminated by \r\n)
            while !chunk_buf.windows(2).any(|w| w == b"\r\n") {
                let n = stream.read(&mut tmp).await?;
                if n == 0 {
                    bail!("Connection closed in chunked body before chunk-size line");
                }
                chunk_buf.extend_from_slice(&tmp[..n]);
            }

            // Find the \r\n terminator for the chunk-size line
            let crlf_pos = chunk_buf
                .windows(2)
                .position(|w| w == b"\r\n")
                .expect("CRLF guaranteed by while loop condition above");
            let size_line = std::str::from_utf8(&chunk_buf[..crlf_pos])
                .context("Chunk size line is not valid UTF-8")?;

            // Parse chunk size (may have extensions after ';')
            let size_str = size_line.split(';').next().unwrap_or("").trim();
            let chunk_size = usize::from_str_radix(size_str, 16)
                .with_context(|| format!("Invalid chunk size: '{}'", size_str))?;

            // Consume the chunk-size line + \r\n
            chunk_buf = chunk_buf[crlf_pos + 2..].to_vec();

            if chunk_size == 0 {
                // Terminal chunk — we're done. Consume the trailing \r\n.
                break;
            }

            // Read chunk_size bytes + trailing \r\n
            let need = chunk_size + 2; // data + \r\n
            while chunk_buf.len() < need {
                let n = stream.read(&mut tmp).await?;
                if n == 0 {
                    bail!(
                        "Connection closed mid-chunk (got {} of {} bytes)",
                        chunk_buf.len(),
                        need
                    );
                }
                chunk_buf.extend_from_slice(&tmp[..n]);
            }

            decoded_body.extend_from_slice(&chunk_buf[..chunk_size]);
            chunk_buf = chunk_buf[need..].to_vec();

            // Size guard
            if decoded_body.len() > MAX_CAPTURE_BYTES {
                bail!(
                    "Chunked request body exceeds maximum size ({} bytes)",
                    MAX_CAPTURE_BYTES
                );
            }
        }

        // Reconstruct headers: remove Transfer-Encoding, add Content-Length
        let mut new_headers = String::new();
        for line in headers_str.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Some((key, _)) = trimmed.split_once(':') {
                if key.trim().eq_ignore_ascii_case("transfer-encoding") {
                    continue; // skip
                }
            }
            new_headers.push_str(line);
            new_headers.push_str("\r\n");
        }
        new_headers.push_str(&format!("Content-Length: {}\r\n", decoded_body.len()));
        new_headers.push_str("\r\n");

        let mut result = new_headers.into_bytes();
        result.extend_from_slice(&decoded_body);
        return Ok(result);
    }

    let content_length = parse_content_length(headers_str);

    if let Some(cl) = content_length {
        // Read exactly Content-Length bytes of body
        let total_needed = header_end + cl;
        while buf.len() < total_needed {
            let n = stream.read(&mut tmp).await?;
            if n == 0 {
                bail!(
                    "Connection closed before complete HTTP body (got {} of {} body bytes)",
                    buf.len() - header_end,
                    cl
                );
            }
            buf.extend_from_slice(&tmp[..n]);
        }
        // Truncate to exactly headers + Content-Length body
        buf.truncate(total_needed);
    }
    // If no Content-Length and no chunked encoding, we have what we have (headers only for GET, etc.)

    Ok(buf)
}

// NOTE: forward_to_upstream was replaced by stream_to_client_and_accumulate
// (see Finding 1) which implements incremental streaming: each chunk from
// upstream is forwarded to the client immediately AND accumulated for capture.

/// Handle passthrough tunnel for non-MITM hosts.
///
/// Performs a bidirectional byte relay between the client and the upstream
/// server without any TLS termination or inspection.
/// B3 fix: Handle TLS MITM for DirectTLS connections where the ClientHello
/// was already read from the stream. Replays the buffered bytes before the
/// remaining stream data by wrapping them in a chain reader.
async fn handle_mitm_tunnel_with_replay(
    stream: tokio::net::TcpStream,
    initial_bytes: &[u8],
    initial_len: usize,
    ctx: &CaptureContext<'_>,
) {
    use tokio::io::AsyncWriteExt;
    let host = ctx.host;
    let port = ctx.port;
    let data_dir = ctx.data_dir;
    let peer_addr = ctx.peer_addr;
    let provider = ctx.provider;
    let cert_cache = ctx.cert_cache;
    let write_pipeline = ctx.write_pipeline;
    let wal_fail_mode = ctx.wal_fail_mode;
    let metrics_registry = ctx.metrics_registry;

    // Build server TLS config for MITM
    let server_config = match build_server_config_with_cache(data_dir, host, Some(cert_cache)) {
        Ok(cfg) => cfg,
        Err(e) => {
            warn!(%peer_addr, host, error = %e, "Failed to build server TLS config (DirectTLS)");
            return;
        }
    };

    // Create a replay stream: the initial ClientHello bytes + remaining TCP stream.
    // This allows the TLS acceptor to process the full ClientHello.
    let replay = std::io::Cursor::new(initial_bytes[..initial_len].to_vec());
    let chain_stream = tokio::io::join(replay, stream);

    let acceptor = tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(server_config));
    let mut client_tls = match tokio::time::timeout(
        TLS_HANDSHAKE_TIMEOUT,
        acceptor.accept(chain_stream),
    )
    .await
    {
        Ok(Ok(tls)) => tls,
        Ok(Err(e)) => {
            warn!(%peer_addr, host, error = %e, "TLS handshake failed (DirectTLS)");
            return;
        }
        Err(_) => {
            warn!(%peer_addr, host, "TLS handshake timed out (DirectTLS, {:?})", TLS_HANDSHAKE_TIMEOUT);
            return;
        }
    };

    let mut session_mgr = crate::session::SessionManager::new();

    let wal_dir = data_dir.join("wal");
    let wal = match crate::wal::Wal::open_with_mode(&wal_dir, wal_fail_mode) {
        Ok(w) => Some(w),
        Err(e) => {
            warn!(%peer_addr, host, error = %e, "Failed to open WAL (DirectTLS, continuing without WAL)");
            None
        }
    };

    // Read decrypted HTTP requests in a loop (same logic as handle_mitm_tunnel)
    loop {
        let request_bytes =
            match tokio::time::timeout(READ_REQUEST_TIMEOUT, read_http_request(&mut client_tls))
                .await
            {
                Ok(Ok(bytes)) if bytes.is_empty() => break,
                Ok(Ok(bytes)) => bytes,
                Ok(Err(e)) => {
                    debug!(%peer_addr, host, error = %e, "DirectTLS tunnel closed by client");
                    break;
                }
                Err(_) => {
                    warn!(%peer_addr, host, "HTTP request read timed out (DirectTLS)");
                    break;
                }
            };

        let decision = should_intercept(&request_bytes, provider);
        info!(
            %peer_addr, host,
            method = ?decision.method,
            path = ?decision.path,
            should_capture = decision.should_capture,
            request_len = request_bytes.len(),
            "Intercept decision (DirectTLS)"
        );

        if decision.should_capture {
            trace_request(&request_bytes, provider);
        }

        let upstream_result = tokio::time::timeout(
            UPSTREAM_TOTAL_TIMEOUT,
            stream_to_client_and_accumulate(host, port, &request_bytes, &mut client_tls, data_dir),
        )
        .await;

        match upstream_result {
            Ok(Ok(crate::websocket::StreamResult::Complete(resp, _partial))) => {
                if decision.should_capture {
                    if let Err(e) =
                        crate::capture::record_capture(data_dir, &request_bytes, &resp, provider)
                    {
                        warn!(%peer_addr, host, error = %e, "Disk capture pipeline failed (DirectTLS)");
                    }
                    match process_capture_with_pipeline(
                        write_pipeline,
                        &mut session_mgr,
                        provider,
                        &request_bytes,
                        &resp,
                        wal.as_ref(),
                        Some(metrics_registry),
                    ) {
                        Ok(_) => info!(%peer_addr, host, "capture pipeline succeeded (DirectTLS)"),
                        Err(e) => {
                            crate::metrics::record_error(metrics_registry);
                            warn!(%peer_addr, host, error = %e, "capture pipeline failed (DirectTLS)")
                        }
                    }
                }
                trace_response(&resp);
            }
            Ok(Ok(crate::websocket::StreamResult::WebSocketUpgrade(..))) => {
                info!(%peer_addr, host, "WebSocket upgrade in DirectTLS mode — not yet supported");
                break;
            }
            Ok(Err(e)) => {
                warn!(%peer_addr, host, error = %e, "Upstream connection failed (DirectTLS)");
                break;
            }
            Err(_) => {
                warn!(%peer_addr, host, "Upstream forwarding timed out (DirectTLS)");
                break;
            }
        };

        if client_tls.flush().await.is_err() {
            break;
        }
    }

    let _ = client_tls.shutdown().await;
}

/// B3 fix: Handle passthrough for DirectTLS connections by replaying initial
/// bytes then relaying the rest bidirectionally.
async fn handle_passthrough_tunnel_with_replay(
    mut client_stream: tokio::net::TcpStream,
    initial_bytes: &[u8],
    initial_len: usize,
    host: &str,
    port: u16,
    peer_addr: std::net::SocketAddr,
) {
    use tokio::io::AsyncWriteExt;

    let upstream_addr = format!("{}:{}", host, port);
    let mut upstream_stream = match tokio::net::TcpStream::connect(&upstream_addr).await {
        Ok(s) => s,
        Err(e) => {
            warn!(%peer_addr, host, error = %e, "Failed to connect to upstream for DirectTLS passthrough");
            return;
        }
    };

    // Forward the initial bytes that were already read
    if let Err(e) = upstream_stream
        .write_all(&initial_bytes[..initial_len])
        .await
    {
        warn!(%peer_addr, host, error = %e, "Failed to replay initial bytes to upstream");
        return;
    }

    match tokio::io::copy_bidirectional(&mut client_stream, &mut upstream_stream).await {
        Ok((c2u, u2c)) => {
            info!(%peer_addr, host, c2u, u2c, "DirectTLS passthrough tunnel closed");
        }
        Err(e) => {
            warn!(%peer_addr, host, error = %e, "DirectTLS passthrough tunnel error");
        }
    }
}

async fn handle_passthrough_tunnel(
    mut client_stream: tokio::net::TcpStream,
    host: &str,
    port: u16,
    peer_addr: std::net::SocketAddr,
) {
    let upstream_addr = format!("{}:{}", host, port);

    // Connect to the upstream server
    let mut upstream_stream = match tokio::net::TcpStream::connect(&upstream_addr).await {
        Ok(s) => s,
        Err(e) => {
            warn!(%peer_addr, host, error = %e, "Failed to connect to upstream for passthrough");
            return;
        }
    };

    // Bidirectional relay — no inspection, no capture
    match tokio::io::copy_bidirectional(&mut client_stream, &mut upstream_stream).await {
        Ok((client_to_upstream, upstream_to_client)) => {
            info!(
                %peer_addr,
                host,
                client_to_upstream,
                upstream_to_client,
                "Passthrough tunnel closed"
            );
        }
        Err(e) => {
            // Connection errors during relay are normal (client/upstream disconnect)
            warn!(%peer_addr, host, error = %e, "Passthrough tunnel error");
        }
    }
}
