//! CONNECT request parsing, TLS connection-mode detection, host classification,
//! and rustls server-config construction. Split out of `gateway/mod.rs` per the
//! Batch 6 H2 audit follow-up.

use std::path::Path;

use anyhow::{bail, Context, Result};

use crate::providers;
use crate::tls;
use crate::tls::CertCache;

// ---------------------------------------------------------------------------
// CONNECT request parsing
// ---------------------------------------------------------------------------

/// Maximum size of a CONNECT request buffer (8 KB). Requests larger than
/// this are rejected to prevent resource exhaustion.
const MAX_CONNECT_REQUEST_SIZE: usize = 8192;

/// Maximum hostname length per RFC 1035 (253 characters).
const MAX_HOSTNAME_LENGTH: usize = 253;

/// A parsed HTTP CONNECT request.
///
/// Prefer using the getter methods (`host()`, `port()`) in production code.
/// Fields remain `pub` because existing integration tests construct and compare
/// `ConnectRequest` values directly (e.g., `assert_eq!(result, ConnectRequest { host: ..., port: ... })`).
/// Making them private would break those test assertions, which we must not modify.
#[derive(Debug, Clone, PartialEq)]
pub struct ConnectRequest {
    /// The target hostname (e.g., "api.anthropic.com").
    pub host: String,
    /// The target port (e.g., 443).
    pub port: u16,
}

impl ConnectRequest {
    /// Returns the target hostname.
    pub fn host(&self) -> &str {
        &self.host
    }

    /// Returns the target port.
    pub fn port(&self) -> u16 {
        self.port
    }
}

/// Parse an HTTP CONNECT request line from raw bytes.
///
/// Expects the format: `CONNECT host:port HTTP/1.1\r\n...`
/// Returns the parsed host and port.
///
/// # Errors
/// - Empty input
/// - Input exceeds MAX_CONNECT_REQUEST_SIZE
/// - Non-UTF8 bytes (CONNECT requests must be ASCII)
/// - Missing CONNECT method
/// - Missing or malformed host:port
/// - Invalid hostname characters (must be ASCII alphanumeric, dots, hyphens)
/// - Non-numeric port
pub fn parse_connect_request(raw: &[u8]) -> Result<ConnectRequest> {
    if raw.is_empty() {
        bail!("Empty input");
    }

    if raw.len() > MAX_CONNECT_REQUEST_SIZE {
        bail!(
            "CONNECT request too large ({} bytes, max {})",
            raw.len(),
            MAX_CONNECT_REQUEST_SIZE
        );
    }

    // CONNECT requests must be ASCII — reject non-UTF8 bytes
    let text = std::str::from_utf8(raw)
        .map_err(|e| anyhow::anyhow!("CONNECT request contains non-UTF8 bytes: {}", e))?;

    // Extract the first line
    let first_line = text
        .lines()
        .next()
        .ok_or_else(|| anyhow::anyhow!("No lines in input"))?
        .trim();

    // Split into parts: CONNECT host:port HTTP/1.x
    let parts: Vec<&str> = first_line.split_whitespace().collect();

    if parts.len() < 2 {
        bail!("Malformed request line: not enough parts");
    }

    // Validate method is CONNECT
    if parts[0] != "CONNECT" {
        bail!("Expected CONNECT method, got '{}'", parts[0]);
    }

    let host_port = parts[1];

    // Split host:port on the last colon (to handle IPv6 in the future)
    let colon_pos = host_port
        .rfind(':')
        .ok_or_else(|| anyhow::anyhow!("Missing port in host:port '{}'", host_port))?;

    let host = &host_port[..colon_pos];
    let port_str = &host_port[colon_pos + 1..];

    if host.is_empty() {
        bail!("Empty host in host:port");
    }

    if host.len() > MAX_HOSTNAME_LENGTH {
        bail!(
            "Hostname too long ({} chars, max {} per RFC 1035)",
            host.len(),
            MAX_HOSTNAME_LENGTH
        );
    }

    // Validate hostname characters: ASCII alphanumeric, dots, hyphens only.
    // Reject null bytes, non-ASCII, and other unexpected characters.
    //
    // NOTE: Underscores are intentionally rejected. While RFC 952 forbids them
    // in hostnames (and no known LLM provider uses them), some internal DNS
    // environments do use underscores. If underscore support is needed in the
    // future, add `|| c == '_'` here and update the corresponding test.
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        bail!(
            "Invalid hostname '{}': must contain only ASCII alphanumeric, dots, and hyphens",
            host
        );
    }

    let port: u16 = port_str
        .parse()
        .with_context(|| format!("Invalid port '{}': must be a number 0-65535", port_str))?;

    Ok(ConnectRequest {
        host: host.to_string(),
        port,
    })
}

// ---------------------------------------------------------------------------
// Dual-mode gateway — connection mode detection (OD-006)
// ---------------------------------------------------------------------------

/// How the client connected to the gateway.
///
/// The gateway supports two connection modes:
/// - **Connect:** Classic HTTPS_PROXY mode. Client sends `CONNECT host:port HTTP/1.1`,
///   gateway establishes a tunnel, then performs TLS MITM inside the tunnel.
/// - **DirectTls:** Client connects directly with TLS (no CONNECT tunnel).
///   The gateway detects the TLS ClientHello, extracts the SNI hostname,
///   and performs MITM using that hostname for cert generation.
/// - **Unknown:** Neither a recognized HTTP method nor a TLS record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionMode {
    /// Client sent an HTTP request (CONNECT, GET, POST, etc.)
    Connect,
    /// Client initiated a TLS handshake directly (first byte 0x16).
    DirectTls,
    /// Unrecognized protocol.
    Unknown,
}

/// HTTP method prefixes (as bytes, including trailing space) used to detect
/// whether the first bytes on a TCP connection look like an HTTP request.
/// Used by `detect_connection_mode` to distinguish HTTP from TLS.
const HTTP_METHOD_PREFIXES: &[&[u8]] = &[
    b"CONNECT ",
    b"GET ",
    b"POST ",
    b"PUT ",
    b"DELETE ",
    b"HEAD ",
    b"OPTIONS ",
    b"PATCH ",
    b"TRACE ",
];

/// Detect the connection mode from the first bytes received on a TCP connection.
///
/// Decision logic:
/// 1. If the first byte is `0x16` (TLS ContentType: Handshake) **and** there are
///    at least 5 bytes (minimum TLS record header), returns `DirectTls`.
/// 2. If the bytes start with a known HTTP method (`CONNECT `, `GET `, `POST `, etc.),
///    returns `Connect`.
/// 3. Otherwise returns `Unknown`.
///
/// A truncated TLS record (first byte 0x16 but fewer than 5 bytes) returns `Unknown`
/// because the record is incomplete and cannot be parsed.
pub fn detect_connection_mode(first_bytes: &[u8]) -> ConnectionMode {
    if first_bytes.is_empty() {
        return ConnectionMode::Unknown;
    }

    // TLS record: first byte 0x16, need at least 5 bytes for the record header
    // (type[1] + version[2] + length[2])
    if first_bytes[0] == 0x16 && first_bytes.len() >= 5 {
        return ConnectionMode::DirectTls;
    }

    // HTTP method detection
    for method in HTTP_METHOD_PREFIXES {
        if first_bytes.len() >= method.len() && first_bytes[..method.len()] == **method {
            return ConnectionMode::Connect;
        }
    }

    ConnectionMode::Unknown
}

/// Extract the SNI (Server Name Indication) hostname from a TLS ClientHello message.
///
/// Parses the TLS record header, handshake header, and ClientHello extensions
/// to find the SNI extension (type 0x0000) and extract the DNS hostname.
///
/// Returns `None` if:
/// - The input is not a valid TLS record (first byte not 0x16)
/// - The input is too short to contain a complete ClientHello
/// - No SNI extension is present
/// - The SNI extension does not contain a DNS hostname
///
/// **Does not validate the hostname** — returns whatever bytes are in the SNI
/// extension as a UTF-8 string.
pub fn extract_sni_hostname(client_hello: &[u8]) -> Option<String> {
    // Minimum: 5 (record header) + 4 (handshake header) + 2 (version) + 32 (random) = 43
    if client_hello.len() < 43 {
        return None;
    }

    // Check TLS record header
    if client_hello[0] != 0x16 {
        return None; // Not a handshake record
    }

    let record_length = u16::from_be_bytes([client_hello[3], client_hello[4]]) as usize;
    let record_data = client_hello.get(5..5 + record_length)?;

    // Handshake header: type (1 byte) + length (3 bytes)
    if record_data.is_empty() || record_data[0] != 0x01 {
        return None; // Not a ClientHello
    }

    let handshake_length =
        (record_data[1] as usize) << 16 | (record_data[2] as usize) << 8 | record_data[3] as usize;
    let hello_data = record_data.get(4..4 + handshake_length)?;

    // ClientHello body:
    // - version: 2 bytes
    // - random: 32 bytes
    // - session_id: 1 byte length + variable
    let mut offset = 2 + 32; // skip version + random

    if offset >= hello_data.len() {
        return None;
    }

    // Session ID
    let session_id_len = hello_data[offset] as usize;
    offset += 1 + session_id_len;

    if offset + 2 > hello_data.len() {
        return None;
    }

    // Cipher suites
    let cipher_suites_len =
        u16::from_be_bytes([hello_data[offset], hello_data[offset + 1]]) as usize;
    offset += 2 + cipher_suites_len;

    if offset + 1 > hello_data.len() {
        return None;
    }

    // Compression methods
    let compression_len = hello_data[offset] as usize;
    offset += 1 + compression_len;

    if offset + 2 > hello_data.len() {
        return None;
    }

    // Extensions length
    let extensions_len = u16::from_be_bytes([hello_data[offset], hello_data[offset + 1]]) as usize;
    offset += 2;

    let extensions_end = offset + extensions_len;
    if extensions_end > hello_data.len() {
        return None;
    }

    // Parse extensions to find SNI (type 0x0000)
    while offset + 4 <= extensions_end {
        let ext_type = u16::from_be_bytes([hello_data[offset], hello_data[offset + 1]]);
        let ext_len = u16::from_be_bytes([hello_data[offset + 2], hello_data[offset + 3]]) as usize;
        offset += 4;

        if ext_type == 0x0000 {
            // SNI extension found
            // SNI list length (2 bytes)
            if offset + 2 > extensions_end || offset + ext_len > extensions_end {
                return None;
            }

            let sni_data = hello_data.get(offset..offset + ext_len)?;
            if sni_data.len() < 5 {
                return None;
            }

            // Skip SNI list length (2 bytes)
            let mut sni_offset = 2;

            // SNI entry: type (1 byte) + length (2 bytes) + name
            let name_type = sni_data[sni_offset];
            sni_offset += 1;

            let name_len =
                u16::from_be_bytes([sni_data[sni_offset], sni_data[sni_offset + 1]]) as usize;
            sni_offset += 2;

            if name_type == 0x00 {
                // DNS hostname
                let name_bytes = sni_data.get(sni_offset..sni_offset + name_len)?;
                return std::str::from_utf8(name_bytes).ok().map(|s| s.to_string());
            }
        }

        offset += ext_len;
    }

    None
}

// ---------------------------------------------------------------------------
// Host classification
// ---------------------------------------------------------------------------

/// How the gateway should handle a connection to a given host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelMode {
    /// Perform TLS MITM: terminate TLS, intercept HTTP, capture traffic.
    /// Contains the detected provider name (e.g., "anthropic", "openai").
    Mitm(String),
    /// Transparent pass-through: relay encrypted bytes without inspection.
    Passthrough,
}

/// Classify a host to determine whether the gateway should MITM or pass through.
///
/// Uses `providers::detect_provider` — known providers get MITM mode
/// (with the provider name attached), unknown hosts get pass-through.
///
/// Note: case handling is delegated to `detect_provider`, which performs
/// case-insensitive matching via `to_ascii_lowercase()`.
pub fn classify_host(host: &str) -> TunnelMode {
    let provider = providers::detect_provider(host);
    if provider != "unknown" {
        TunnelMode::Mitm(provider.to_string())
    } else {
        TunnelMode::Passthrough
    }
}

// ---------------------------------------------------------------------------
// TLS server config construction
// ---------------------------------------------------------------------------

/// Build a `rustls::ServerConfig` for terminating a client TLS connection
/// to the given host.
///
/// If a `CertCache` is provided, uses it to obtain the leaf certificate
/// (cache hit avoids key generation). Falls back to the standalone
/// `tls::generate_leaf_cert` when no cache is available (tests, CLI).
///
/// The cert chain includes both the leaf certificate and the CA certificate
/// so that clients can verify the chain.
///
/// # Errors
/// - CA not found in data_dir
/// - Leaf cert generation fails
/// - PEM parsing fails
pub fn build_server_config(data_dir: &Path, host: &str) -> Result<rustls::ServerConfig> {
    build_server_config_with_cache(data_dir, host, None)
}

/// Build a `rustls::ServerConfig`, optionally using a `CertCache` for
/// leaf certificate retrieval.
pub fn build_server_config_with_cache(
    data_dir: &Path,
    host: &str,
    cert_cache: Option<&CertCache>,
) -> Result<rustls::ServerConfig> {
    if host.is_empty() {
        bail!("Empty host cannot produce a valid leaf certificate");
    }

    // Generate the leaf certificate signed by our CA
    let leaf = match cert_cache {
        Some(cache) => cache
            .get_or_generate(host)
            .context("Failed to get/generate leaf certificate from cache")?,
        None => tls::generate_leaf_cert(data_dir, host)
            .context("Failed to generate leaf certificate")?,
    };

    // Parse the leaf certificate PEM into rustls types
    let cert_pem = leaf.cert_pem();
    let key_pem = leaf.key_pem();

    let leaf_certs: Vec<rustls::pki_types::CertificateDer<'static>> = {
        let mut reader = std::io::BufReader::new(cert_pem.as_bytes());
        rustls_pemfile::certs(&mut reader)
            .collect::<std::result::Result<Vec<_>, _>>()
            .context("Failed to parse leaf certificate PEM")?
    };

    if leaf_certs.is_empty() {
        bail!("No certificates found in leaf PEM");
    }

    // Parse the CA certificate and include it in the chain so clients
    // can verify the full chain: leaf -> CA.
    // Use cached CA PEM from CertCache when available, otherwise read from disk.
    let ca_cert_pem: String = match cert_cache {
        Some(cache) => cache.ca_cert_pem().to_string(),
        None => {
            let ca_cert_path = data_dir.join("ca").join("ca.crt");
            std::fs::read_to_string(&ca_cert_path).context("Failed to read CA certificate PEM")?
        }
    };

    let ca_certs: Vec<rustls::pki_types::CertificateDer<'static>> = {
        let mut reader = std::io::BufReader::new(ca_cert_pem.as_bytes());
        rustls_pemfile::certs(&mut reader)
            .collect::<std::result::Result<Vec<_>, _>>()
            .context("Failed to parse CA certificate PEM")?
    };

    // Build the full cert chain: leaf first, then CA
    let mut certs = leaf_certs;
    certs.extend(ca_certs);

    let private_key = {
        let mut reader = std::io::BufReader::new(key_pem.as_bytes());
        rustls_pemfile::private_key(&mut reader)
            .context("Failed to parse private key PEM")?
            .ok_or_else(|| anyhow::anyhow!("No private key found in PEM"))?
    };

    crate::gateway::crypto::ensure_provider();
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, private_key)
        .context("Failed to build rustls ServerConfig")?;

    Ok(config)
}
