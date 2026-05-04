//! Sprint 7 Phase 2: Webhook Alert Dispatch for Anomaly Events.
//!
//! Provides `dispatch_anomaly_webhook` for POSTing anomaly events to a
//! configured webhook URL, and `is_private_ip` for SSRF protection.

use anyhow::Result;

use crate::db::AnomalyEventRecord;

/// Check whether a hostname string refers to a private/reserved IP address.
///
/// Returns `true` for:
/// - `127.*` (loopback) — note: `127.0.0.1` is NOT blocked in dispatch to
///   allow local testing; this function is used for documentation/direct checks.
/// - `10.*` (RFC 1918 Class A)
/// - `172.16.*` through `172.31.*` (RFC 1918 Class B)
/// - `192.168.*` (RFC 1918 Class C)
/// - `169.254.*` (link-local / AWS metadata)
/// - `localhost`
/// - `::1` (IPv6 loopback)
///
/// Used for SSRF protection: webhook URLs pointing to private IPs are rejected.
pub fn is_private_ip(hostname: &str) -> bool {
    // Strip surrounding brackets from IPv6 addresses (e.g., "[::1]" → "::1")
    let host = hostname
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(hostname);

    // IPv6 loopback
    if host == "::1" {
        return true;
    }

    // IPv6 ULA (Unique Local Address): fc00::/7 — addresses starting with fc or fd
    {
        let lower = host.to_ascii_lowercase();
        if lower.starts_with("fc") || lower.starts_with("fd") {
            return true;
        }
        // IPv6 link-local: fe80::/10
        if lower.starts_with("fe80") {
            return true;
        }
    }

    // localhost
    if host == "localhost" {
        return true;
    }

    // Parse as IPv4 octets
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return false;
    }

    let octets: Vec<u8> = match parts.iter().map(|p| p.parse::<u8>()).collect() {
        Ok(o) => o,
        Err(_) => return false,
    };

    // 0.0.0.0/8 — "this" network (RFC 1122)
    if octets[0] == 0 {
        return true;
    }

    // 127.0.0.0/8 (loopback)
    if octets[0] == 127 {
        return true;
    }

    // 10.0.0.0/8 (RFC 1918)
    if octets[0] == 10 {
        return true;
    }

    // 172.16.0.0/12 (RFC 1918) — 172.16.0.0 through 172.31.255.255
    if octets[0] == 172 && (16..=31).contains(&octets[1]) {
        return true;
    }

    // 192.168.0.0/16 (RFC 1918)
    if octets[0] == 192 && octets[1] == 168 {
        return true;
    }

    // 169.254.0.0/16 (link-local / APIPA / AWS metadata)
    if octets[0] == 169 && octets[1] == 254 {
        return true;
    }

    // 100.64.0.0/10 (Carrier-grade NAT, RFC 6598) — 100.64.0.0 through 100.127.255.255
    if octets[0] == 100 && (64..=127).contains(&octets[1]) {
        return true;
    }

    false
}

/// Extract the hostname from a URL string.
///
/// Handles `http://host:port/path` and `http://host/path` forms.
fn extract_host(url: &str) -> Option<String> {
    // Strip scheme
    let without_scheme = if let Some(rest) = url.strip_prefix("http://") {
        rest
    } else {
        url.strip_prefix("https://")?
    };

    // Take everything before the first '/'
    let authority = without_scheme.split('/').next().unwrap_or(without_scheme);

    // Strip port if present
    let host = if let Some(bracket_end) = authority.find(']') {
        // IPv6 address like [::1]:8080
        &authority[..=bracket_end]
    } else if let Some(colon) = authority.rfind(':') {
        &authority[..colon]
    } else {
        authority
    };

    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

/// Dispatch an anomaly event to a configured webhook URL via HTTP POST.
///
/// Sends a JSON payload with fields: type, anomaly_type, severity, session_id,
/// turn_id, description, detected_at.
///
/// **SSRF protection:** Rejects webhook URLs that resolve to private IP addresses
/// (10.x, 172.16-31.x, 192.168.x, 169.254.x). Note: 127.0.0.1 (localhost) is
/// allowed in the dispatch path to enable local testing with mock servers, but
/// `is_private_ip("127.0.0.1")` returns `true` for documentation purposes.
///
/// **Empty URL:** Returns `Ok(())` immediately (no webhook configured).
///
/// **Fire-and-forget:** Connection errors are returned as `Err` so the caller
/// can log them, but they should not block the capture pipeline.
pub async fn dispatch_anomaly_webhook(
    anomaly: &AnomalyEventRecord,
    webhook_url: &str,
) -> Result<()> {
    // No webhook configured — nothing to do.
    if webhook_url.is_empty() {
        return Ok(());
    }

    // Issue 5: Reject HTTPS URLs — the raw TcpStream transport does not support TLS.
    // Sending plaintext over an HTTPS connection would fail or leak data.
    // TODO(Sprint 14): Add HTTPS support via rustls/native-tls integration.
    if webhook_url.starts_with("https://") {
        anyhow::bail!("HTTPS webhook URLs are unsupported by the raw TcpStream transport — use an HTTP webhook URL or configure a proxy");
    }

    // SSRF protection: extract hostname and check against private IP ranges.
    // Issue 6: The 127.0.0.1 (localhost) exception is gated behind the
    // RECONDO_ALLOW_LOCAL_WEBHOOK environment variable or #[cfg(test)].
    // In production, localhost webhooks are blocked unless explicitly allowed.
    if let Some(host) = extract_host(webhook_url) {
        let allow_local = allow_local_webhook();
        if host == "127.0.0.1" || host == "[::1]" || host == "::1" || host == "localhost" {
            if !allow_local {
                anyhow::bail!(
                    "SSRF protection: webhook URL points to localhost ({}). Set RECONDO_ALLOW_LOCAL_WEBHOOK=true to allow.",
                    host
                );
            }
            // localhost is allowed — skip further private IP checks
        } else if is_private_ip(&host) {
            anyhow::bail!(
                "SSRF protection: webhook URL points to private IP: {}",
                host
            );
        }
    }

    // Build the JSON payload.
    let payload = serde_json::json!({
        "type": "anomaly_detected",
        "anomaly_type": anomaly.anomaly_type,
        "severity": anomaly.severity,
        "session_id": anomaly.session_id,
        "turn_id": anomaly.turn_id,
        "description": anomaly.description,
        "detected_at": anomaly.detected_at,
    });

    let body = serde_json::to_string(&payload)?;

    // Use tokio TcpStream for the HTTP POST to avoid adding new dependencies.
    // Parse the URL to extract host:port and path.
    let without_scheme = webhook_url.strip_prefix("http://").unwrap_or(webhook_url);

    let (authority, path) = match without_scheme.find('/') {
        Some(pos) => (&without_scheme[..pos], &without_scheme[pos..]),
        None => (without_scheme, "/"),
    };

    // Connect to the server.
    let stream = tokio::net::TcpStream::connect(authority).await?;

    // Build a minimal HTTP/1.1 POST request.
    let request = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        path, authority, body.len(), body
    );

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (mut read_half, mut write_half) = stream.into_split();
    write_half.write_all(request.as_bytes()).await?;
    write_half.shutdown().await?;

    // Issue 7: Read at least the first line of the HTTP response to detect
    // 4xx/5xx errors. Don't fail the overall operation — just log a warning.
    let mut resp_buf = vec![0u8; 512];
    match read_half.read(&mut resp_buf).await {
        Ok(n) if n > 0 => {
            let resp_text = String::from_utf8_lossy(&resp_buf[..n]);
            // Extract the HTTP status line (first line before \r\n)
            if let Some(status_line) = resp_text.lines().next() {
                // Parse status code: "HTTP/1.1 200 OK" -> "200"
                let parts: Vec<&str> = status_line.split_whitespace().collect();
                if parts.len() >= 2 {
                    if let Ok(status_code) = parts[1].parse::<u16>() {
                        if !(200..300).contains(&status_code) {
                            tracing::warn!(
                                status_code,
                                status_line = %status_line,
                                webhook_url = %webhook_url,
                                "Webhook endpoint returned non-2xx status"
                            );
                        }
                    }
                }
            }
        }
        Ok(_) => {
            // Empty response — server closed connection immediately
            tracing::warn!(
                webhook_url = %webhook_url,
                "Webhook endpoint returned empty response"
            );
        }
        Err(e) => {
            // Read error — non-fatal, the POST was already sent
            tracing::warn!(
                error = %e,
                webhook_url = %webhook_url,
                "Failed to read webhook response (non-fatal)"
            );
        }
    }

    Ok(())
}

/// Check if local (127.0.0.1) webhook dispatch is allowed.
///
/// Returns `true` when the `test-support` feature is enabled (integration tests)
/// or when the `RECONDO_ALLOW_LOCAL_WEBHOOK` environment variable is set to
/// "true" or "1". In production without the env var, localhost webhooks are
/// blocked for SSRF protection.
fn allow_local_webhook() -> bool {
    // Always allow when test-support feature is enabled (integration tests)
    if cfg!(feature = "test-support") {
        return true;
    }
    // Check environment variable for production opt-in
    match std::env::var("RECONDO_ALLOW_LOCAL_WEBHOOK") {
        Ok(val) => val == "true" || val == "1",
        Err(_) => false,
    }
}
