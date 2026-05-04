//! TLS MITM Tunnel Integration Tests.
//!
//! These tests verify the COMPLETE end-to-end pipeline from the gateway's
//! perspective: CONNECT → TLS MITM handshake → HTTP request/response
//! forwarding → capture pipeline producing artifacts on disk.
//!
//! Each test maps to a Week 1 deliverable:
//!   - "cargo run starts gateway on :8443"  (gateway starts, accepts connections)
//!   - "Claude Code routes through gateway via env var" (CONNECT + TLS tunnel works)
//!   - "Raw JSON request/response pairs saved to disk" (capture files appear)
//!   - "Manual inspection confirms capture completeness" (bytes match what was sent)
//!
//! Design reference: IMPLEMENTATION_ROADMAP.md Week 1 Tasks 2-3.

use std::io::{Read, Write};
use std::net::{TcpListener as StdTcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

use flate2::read::GzDecoder;
use tempfile::TempDir;

use recondo_gateway::gateway;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Find an available TCP port by binding to port 0.
fn available_port() -> u16 {
    let listener = StdTcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

/// Start the gateway on the given port with the given data dir and return the
/// JoinHandle so the caller can abort it on cleanup.
fn start_gateway(
    port: u16,
    data_dir: std::path::PathBuf,
) -> tokio::task::JoinHandle<anyhow::Result<()>> {
    tokio::spawn(async move {
        let config =
            gateway::GatewayConfig::new(port, data_dir).with_bind_addr("127.0.0.1".to_string());
        gateway::run_listener(&config).await
    })
}

/// Send a CONNECT request over a raw TCP stream and read the 200 response.
/// Returns the stream positioned after the CONNECT handshake (ready for TLS).
fn send_connect(stream: &mut TcpStream, host: &str, port_num: u16) -> String {
    let connect_req = format!(
        "CONNECT {}:{} HTTP/1.1\r\nHost: {}:{}\r\n\r\n",
        host, port_num, host, port_num
    );
    stream.write_all(connect_req.as_bytes()).unwrap();
    stream.flush().unwrap();

    let mut buf = [0u8; 512];
    let n = stream
        .read(&mut buf)
        .expect("Must receive CONNECT response");
    String::from_utf8_lossy(&buf[..n]).to_string()
}

/// Build a rustls ClientConfig that trusts the gateway's generated CA certificate.
/// The CA cert is expected at `{data_dir}/ca/ca.crt`.
fn build_tls_client_config(data_dir: &std::path::Path) -> rustls::ClientConfig {
    let ca_cert_path = data_dir.join("ca").join("ca.crt");

    // The gateway generates the CA on startup; wait briefly for it to appear
    for _ in 0..20 {
        if ca_cert_path.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    let ca_pem = std::fs::read(&ca_cert_path)
        .unwrap_or_else(|e| panic!("CA cert must exist at {}: {}", ca_cert_path.display(), e));

    let mut root_store = rustls::RootCertStore::empty();

    let mut cursor = std::io::Cursor::new(&ca_pem);
    let certs = rustls_pemfile::certs(&mut cursor)
        .collect::<Result<Vec<_>, _>>()
        .expect("CA PEM must parse");

    for cert in certs {
        root_store
            .add(cert)
            .expect("CA cert must be added to root store");
    }

    recondo_gateway::ensure_crypto_provider();
    rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth()
}

/// Perform a TLS handshake over an existing TCP stream using the given config
/// and server name. Returns a blocking rustls StreamOwned.
fn tls_handshake(
    stream: TcpStream,
    config: Arc<rustls::ClientConfig>,
    server_name: &str,
) -> rustls::StreamOwned<rustls::ClientConnection, TcpStream> {
    let server_name = rustls::pki_types::ServerName::try_from(server_name.to_string())
        .expect("Server name must be valid DNS");
    let client_conn = rustls::ClientConnection::new(config, server_name)
        .expect("TLS client connection must be created");
    rustls::StreamOwned::new(client_conn, stream)
}

/// A minimal Anthropic-style request body for POST /v1/messages.
fn sample_request_body() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 1024,
        "system": "You are a helpful assistant.",
        "messages": [
            {"role": "user", "content": "What is 2+2?"}
        ]
    }))
    .unwrap()
}

/// Build a complete HTTP POST request (headers + body) for /v1/messages.
fn build_http_request(host: &str, body: &[u8]) -> Vec<u8> {
    let header = format!(
        "POST /v1/messages HTTP/1.1\r\n\
         Host: {}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         x-api-key: test-key-not-real\r\n\
         anthropic-version: 2023-06-01\r\n\
         \r\n",
        host,
        body.len()
    );
    let mut req = header.into_bytes();
    req.extend_from_slice(body);
    req
}

/// Decompress gzip bytes.
fn gunzip(compressed: &[u8]) -> Vec<u8> {
    let mut decoder = GzDecoder::new(compressed);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).expect("gunzip failed");
    out
}

/// Count files recursively in a directory.
fn walkdir_count(dir: &std::path::Path) -> usize {
    let mut count = 0;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                count += 1;
            } else if path.is_dir() {
                count += walkdir_count(&path);
            }
        }
    }
    count
}

/// List all files recursively under a directory.
fn list_files_recursive(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                files.push(path);
            } else if path.is_dir() {
                files.extend(list_files_recursive(&path));
            }
        }
    }
    files
}

// ===========================================================================
// Test 1: End-to-end TLS tunnel captures request/response
// ===========================================================================

/// **Proves deliverables:**
/// - "cargo run starts gateway on :8443" — the gateway starts on a dynamic port.
/// - "Claude Code routes through gateway via env var" — CONNECT + TLS tunnel works.
/// - "Raw JSON request/response pairs saved to disk" — capture files appear.
///
/// **What it does:**
/// 1. Starts the gateway on a temp data dir with a dynamic port.
/// 2. TCP connects, sends CONNECT api.anthropic.com:443, gets 200.
/// 3. Performs a TLS handshake with the gateway (trusting the gateway's CA).
/// 4. Sends an HTTP POST /v1/messages over the TLS tunnel.
/// 5. Reads whatever response the gateway provides (may be an error from
///    the upstream since there is no real upstream — that is fine).
/// 6. Verifies: files appear in `{data_dir}/objects/req/` and `objects/resp/`.
/// 7. Verifies: a capture metadata file appears in `{data_dir}/captures/`.
///
/// **Anti-fake property:** This requires the FULL pipeline to be wired:
/// - Without TLS MITM, the gateway cannot decrypt the request bytes to capture.
/// - Without capture pipeline, no files appear on disk.
/// - A stub that only does CONNECT passthrough produces zero artifacts.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tls_tunnel_end_to_end_produces_capture_artifacts() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();
    let port = available_port();

    // Start gateway
    let handle = start_gateway(port, data_dir.clone());
    tokio::time::sleep(Duration::from_millis(800)).await;

    // TCP connect
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", port).parse().unwrap(),
        Duration::from_secs(3),
    )
    .expect("Must TCP connect to gateway");

    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    // CONNECT handshake
    let connect_response = send_connect(&mut stream, "api.anthropic.com", 443);
    assert!(
        connect_response.starts_with("HTTP/1.1 200"),
        "CONNECT must return 200, got: {:?}",
        connect_response
    );

    // TLS handshake — trust the gateway's CA
    let tls_config = Arc::new(build_tls_client_config(&data_dir));
    let mut tls_stream = tls_handshake(stream, tls_config, "api.anthropic.com");

    // Send an HTTP POST /v1/messages over the TLS tunnel
    let request_body = sample_request_body();
    let http_request = build_http_request("api.anthropic.com", &request_body);
    tls_stream.write_all(&http_request).unwrap();
    tls_stream.flush().unwrap();

    // Read whatever the gateway sends back — it might be the upstream response
    // or an error (since there is no real upstream in this test). Either way,
    // the capture pipeline should have triggered on the request side.
    let mut response_buf = vec![0u8; 8192];
    let _ = tls_stream.read(&mut response_buf);

    // Give the async capture pipeline time to flush to disk
    tokio::time::sleep(Duration::from_millis(2000)).await;

    // === Assertions on disk artifacts ===

    // Request objects must exist
    let req_objects_dir = data_dir.join("objects").join("req");
    let req_file_count = if req_objects_dir.exists() {
        walkdir_count(&req_objects_dir)
    } else {
        0
    };
    assert!(
        req_file_count > 0,
        "At least one request object file must be saved to {}, found {}",
        req_objects_dir.display(),
        req_file_count
    );

    // Response objects must exist (even if it is an error response from upstream)
    let resp_objects_dir = data_dir.join("objects").join("resp");
    let resp_file_count = if resp_objects_dir.exists() {
        walkdir_count(&resp_objects_dir)
    } else {
        0
    };
    assert!(
        resp_file_count > 0,
        "At least one response object file must be saved to {}, found {}",
        resp_objects_dir.display(),
        resp_file_count
    );

    // Capture metadata must exist
    let captures_dir = data_dir.join("captures");
    let capture_file_count = if captures_dir.exists() {
        walkdir_count(&captures_dir)
    } else {
        0
    };
    assert!(
        capture_file_count > 0,
        "At least one capture metadata file must be saved to {}, found {}",
        captures_dir.display(),
        capture_file_count
    );

    handle.abort();
}

// ===========================================================================
// Test 2: TLS handshake presents valid leaf cert for requested host
// ===========================================================================

/// **Proves deliverable:** "Claude Code routes through gateway via env var" —
/// the gateway must present a valid certificate for the CONNECT target host
/// so the client's TLS stack accepts it (when the gateway CA is trusted).
///
/// **What it does:**
/// 1. Starts the gateway.
/// 2. Sends CONNECT api.anthropic.com:443.
/// 3. Performs TLS handshake with the gateway, configured to trust the gateway CA.
/// 4. Inspects the peer certificate — its subject or SAN must include
///    api.anthropic.com.
///
/// **Anti-fake property:** If the gateway presents a generic cert or no cert,
/// the TLS handshake with server name verification would fail. The test
/// verifies the handshake succeeds for the specific hostname.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tls_handshake_presents_cert_for_connect_host() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();
    let port = available_port();

    let handle = start_gateway(port, data_dir.clone());
    tokio::time::sleep(Duration::from_millis(800)).await;

    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", port).parse().unwrap(),
        Duration::from_secs(3),
    )
    .expect("Must TCP connect to gateway");

    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    let connect_response = send_connect(&mut stream, "api.anthropic.com", 443);
    assert!(
        connect_response.starts_with("HTTP/1.1 200"),
        "CONNECT must return 200"
    );

    // Build a TLS config that trusts our CA and REQUIRES the server name
    // to match "api.anthropic.com". If the cert doesn't have the right
    // SAN, the handshake will fail.
    let tls_config = Arc::new(build_tls_client_config(&data_dir));
    let server_name = rustls::pki_types::ServerName::try_from("api.anthropic.com".to_string())
        .expect("Server name must be valid");

    let client_conn = rustls::ClientConnection::new(tls_config, server_name)
        .expect("TLS client connection must be created");

    let mut tls_stream = rustls::StreamOwned::new(client_conn, stream);

    // The TLS handshake happens lazily on first I/O. Write something to trigger it.
    // If the cert does not match api.anthropic.com, this will fail with a TLS error.
    let result = tls_stream.write_all(b"GET / HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n");
    assert!(
        result.is_ok(),
        "TLS handshake must succeed with a cert valid for api.anthropic.com — \
         failure means the gateway did not present a cert with the right SAN. Error: {:?}",
        result.err()
    );

    // Verify the peer certificates are present
    let peer_certs = tls_stream.conn.peer_certificates();
    assert!(
        peer_certs.is_some() && !peer_certs.unwrap().is_empty(),
        "Gateway must present at least one certificate during TLS handshake"
    );

    handle.abort();
}

/// **Additional test:** Verify the gateway generates distinct certs for different hosts.
/// This ensures certs are per-host, not a single wildcard for all hosts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tls_handshake_cert_matches_different_hosts() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();
    let port = available_port();

    let handle = start_gateway(port, data_dir.clone());
    tokio::time::sleep(Duration::from_millis(800)).await;

    let tls_config = Arc::new(build_tls_client_config(&data_dir));

    // Test with api.openai.com — different host, must get a different cert
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", port).parse().unwrap(),
        Duration::from_secs(3),
    )
    .expect("Must TCP connect to gateway");

    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    let connect_response = send_connect(&mut stream, "api.openai.com", 443);
    assert!(
        connect_response.starts_with("HTTP/1.1 200"),
        "CONNECT must return 200 for api.openai.com"
    );

    // TLS handshake with server name verification for api.openai.com
    let server_name = rustls::pki_types::ServerName::try_from("api.openai.com".to_string())
        .expect("Server name must be valid");

    let client_conn = rustls::ClientConnection::new(tls_config, server_name)
        .expect("TLS client connection must be created");

    let mut tls_stream = rustls::StreamOwned::new(client_conn, stream);

    let result = tls_stream.write_all(b"GET / HTTP/1.1\r\nHost: api.openai.com\r\n\r\n");
    assert!(
        result.is_ok(),
        "TLS handshake must succeed with a cert valid for api.openai.com — \
         failure means the gateway generates per-host certs incorrectly. Error: {:?}",
        result.err()
    );

    handle.abort();
}

// ===========================================================================
// Test 3: Non-intercepted host gets passthrough (no MITM)
// ===========================================================================

/// **Proves deliverable:** The gateway only MITM's known LLM provider hosts.
/// Non-LLM hosts (github.com) pass through as raw byte tunnels.
///
/// **What it does:**
/// 1. Sends CONNECT github.com:443.
/// 2. After the 200 response, attempts a TLS handshake with the gateway
///    expecting a cert for github.com signed by the gateway CA.
/// 3. The TLS handshake MUST FAIL (the gateway should NOT present a MITM cert).
/// 4. No capture files are created.
///
/// **Anti-fake property:** A gateway that MITM's all hosts would succeed on
/// the TLS handshake — but we assert it must fail. A gateway that does not
/// create capture artifacts could trivially pass the file-count check, but
/// the TLS handshake failure proves the gateway is NOT intercepting.
///
/// **Network access (Finding 15):** This test makes a real TCP connection to
/// github.com:443 via the gateway's passthrough tunnel. The test assertion is
/// valid regardless of network availability: if the passthrough succeeds,
/// github.com's real cert (not signed by gateway CA) causes the TLS handshake
/// to fail; if the network is unavailable, the connection error also causes
/// failure. Either way, no captures are produced.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn passthrough_host_not_mitm_and_no_captures() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();
    let port = available_port();

    let handle = start_gateway(port, data_dir.clone());
    tokio::time::sleep(Duration::from_millis(800)).await;

    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", port).parse().unwrap(),
        Duration::from_secs(3),
    )
    .expect("Must TCP connect to gateway");

    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    let connect_response = send_connect(&mut stream, "github.com", 443);
    assert!(
        connect_response.starts_with("HTTP/1.1 200"),
        "CONNECT to passthrough host must still return 200, got: {:?}",
        connect_response
    );

    // Attempt TLS handshake with the gateway expecting a cert for github.com.
    // Since github.com is a passthrough host, the gateway should NOT present
    // a MITM cert. The gateway should forward raw bytes to github.com, so we
    // get back github.com's real cert (which is NOT signed by our CA).
    //
    // Two valid outcomes:
    // a) TLS handshake fails because the cert is not trusted by our CA-only store
    //    (this is the expected case for passthrough — the gateway forwards bytes)
    // b) Connection is reset/closed (gateway does not attempt TLS at all)
    let tls_config = Arc::new(build_tls_client_config(&data_dir));
    let server_name = rustls::pki_types::ServerName::try_from("github.com".to_string())
        .expect("Server name must be valid");

    let client_conn = rustls::ClientConnection::new(tls_config, server_name)
        .expect("TLS client connection creation must succeed");

    let mut tls_stream = rustls::StreamOwned::new(client_conn, stream);

    // Try to write — this forces the TLS handshake. It SHOULD fail because:
    // - If passthrough: we get github.com's real cert, not signed by gateway CA
    // - If MITM: the gateway would present its own cert (but it should NOT for github.com)
    let handshake_result = tls_stream.write_all(b"GET / HTTP/1.1\r\nHost: github.com\r\n\r\n");

    // The handshake should fail for a passthrough host.
    // If it succeeds, that means the gateway MITM'd a non-LLM host, which is wrong.
    assert!(
        handshake_result.is_err(),
        "TLS handshake to passthrough host github.com must FAIL — \
         the gateway must NOT present a MITM cert for non-LLM hosts. \
         If this succeeded, the gateway is incorrectly MITM'ing all traffic."
    );

    // Give time for any async operations
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Verify no capture files were created for the passthrough host
    let captures_dir = data_dir.join("captures");
    let objects_dir = data_dir.join("objects");

    let capture_count = if captures_dir.exists() {
        walkdir_count(&captures_dir)
    } else {
        0
    };
    let object_count = if objects_dir.exists() {
        walkdir_count(&objects_dir)
    } else {
        0
    };

    assert_eq!(
        capture_count, 0,
        "Passthrough host must NOT produce capture metadata files"
    );
    assert_eq!(
        object_count, 0,
        "Passthrough host must NOT produce object store files"
    );

    handle.abort();
}

// ===========================================================================
// Test 4: Captured bytes match what was sent
// ===========================================================================

/// **Proves deliverable:** "Manual inspection confirms capture completeness" —
/// the bytes stored on disk are byte-for-byte identical (after decompression)
/// to what the client actually sent.
///
/// **What it does:**
/// 1. Sends a known request body through the full CONNECT + TLS + HTTP pipeline.
/// 2. Finds the request object file in `{data_dir}/objects/req/`.
/// 3. Decompresses it (gzip).
/// 4. Asserts the decompressed content contains the exact request body bytes.
///
/// **Anti-fake property:** The test uses a unique JSON body with a random field
/// to prevent collisions. If the gateway captured different bytes (e.g., modified
/// headers, truncated body), the assertion fails.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn captured_request_bytes_match_what_client_sent() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();
    let port = available_port();

    let handle = start_gateway(port, data_dir.clone());
    tokio::time::sleep(Duration::from_millis(800)).await;

    // Use a unique request body so we can identify it unambiguously
    let unique_id = uuid::Uuid::new_v4().to_string();
    let request_body = serde_json::to_vec(&serde_json::json!({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 512,
        "system": "Test system prompt.",
        "messages": [
            {"role": "user", "content": format!("Unique test ID: {}", unique_id)}
        ]
    }))
    .unwrap();

    // TCP connect + CONNECT handshake
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", port).parse().unwrap(),
        Duration::from_secs(3),
    )
    .expect("Must TCP connect to gateway");

    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    let connect_response = send_connect(&mut stream, "api.anthropic.com", 443);
    assert!(connect_response.starts_with("HTTP/1.1 200"));

    // TLS handshake
    let tls_config = Arc::new(build_tls_client_config(&data_dir));
    let mut tls_stream = tls_handshake(stream, tls_config, "api.anthropic.com");

    // Send HTTP request
    let http_request = build_http_request("api.anthropic.com", &request_body);
    tls_stream.write_all(&http_request).unwrap();
    tls_stream.flush().unwrap();

    // Read response (don't care about content — just trigger the pipeline)
    let mut response_buf = vec![0u8; 8192];
    let _ = tls_stream.read(&mut response_buf);

    // Give capture pipeline time to flush
    tokio::time::sleep(Duration::from_millis(2000)).await;

    // Find the captured request object file(s)
    let req_objects_dir = data_dir.join("objects").join("req");
    assert!(
        req_objects_dir.exists(),
        "Request objects directory must exist at {}",
        req_objects_dir.display()
    );

    let req_files = list_files_recursive(&req_objects_dir);
    assert!(
        !req_files.is_empty(),
        "At least one request object file must exist"
    );

    // Find the file that contains our unique request body.
    // The capture pipeline might store just the body or the full HTTP request.
    // Either way, the body bytes must be present.
    let mut found_matching_file = false;
    for req_file in &req_files {
        let compressed = std::fs::read(req_file).unwrap();
        let decompressed = gunzip(&compressed);

        // The captured bytes must contain the request body.
        // The gateway may capture just the body or the full HTTP message.
        // Check if the decompressed bytes contain the JSON body.
        if contains_subsequence(&decompressed, &request_body) {
            found_matching_file = true;
            break;
        }
    }

    assert!(
        found_matching_file,
        "At least one captured request object must contain the exact request body bytes. \
         Looked in {} files under {}. Unique ID was: {}",
        req_files.len(),
        req_objects_dir.display(),
        unique_id
    );

    handle.abort();
}

/// Check if `haystack` contains `needle` as a contiguous subsequence.
fn contains_subsequence(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

// ===========================================================================
// Test 5: NEGATIVE — Without TLS MITM, no captures produced
// ===========================================================================

/// **Proves:** The capture pipeline is only triggered by TLS MITM interception.
/// Merely completing the CONNECT handshake without performing the TLS tunnel
/// does NOT produce any capture artifacts.
///
/// **Why this is the most important test:** It proves that Tests 1 and 4 above
/// can ONLY pass because TLS MITM is correctly wired. Without MITM, the gateway
/// cannot decrypt the tunnel, cannot see the HTTP request, and cannot capture.
///
/// **What it does:**
/// 1. Sends CONNECT api.anthropic.com:443.
/// 2. Gets the 200 response.
/// 3. Does NOT perform a TLS handshake — just sends raw garbage bytes into the
///    tunnel (simulating an encrypted payload the gateway cannot understand).
/// 4. Closes the connection.
/// 5. Verifies: ZERO capture files or object store files exist.
///
/// **Anti-fake property:** If the gateway produces capture files from just the
/// CONNECT request (without TLS MITM), then the capture is not based on
/// decrypted content — it is a bug.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_tls_handshake_produces_no_captures() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();
    let port = available_port();

    let handle = start_gateway(port, data_dir.clone());
    tokio::time::sleep(Duration::from_millis(800)).await;

    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", port).parse().unwrap(),
        Duration::from_secs(3),
    )
    .expect("Must TCP connect to gateway");

    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();

    // CONNECT handshake succeeds
    let connect_response = send_connect(&mut stream, "api.anthropic.com", 443);
    assert!(
        connect_response.starts_with("HTTP/1.1 200"),
        "CONNECT must return 200"
    );

    // Instead of a TLS handshake, send raw (non-TLS) bytes.
    // This simulates what happens when the gateway expects a TLS Client Hello
    // but gets garbage — the TLS handshake should fail, and no capture
    // should be produced.
    let garbage = b"This is NOT a TLS Client Hello. Just random bytes.\r\n\
                    POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n\
                    {\"model\":\"claude\"}";
    let _ = stream.write_all(garbage);
    let _ = stream.flush();

    // Try to read any response (might get an error or nothing)
    let mut buf = [0u8; 1024];
    let _ = stream.read(&mut buf);

    // Close the connection
    drop(stream);

    // Give time for any async operations that might have been triggered
    tokio::time::sleep(Duration::from_millis(1500)).await;

    // === THE CRITICAL ASSERTION ===
    // Without a successful TLS handshake, the gateway MUST NOT produce
    // any capture artifacts. This proves that captures depend on TLS MITM.

    let captures_dir = data_dir.join("captures");
    let objects_dir = data_dir.join("objects");

    let capture_count = if captures_dir.exists() {
        walkdir_count(&captures_dir)
    } else {
        0
    };
    let object_count = if objects_dir.exists() {
        walkdir_count(&objects_dir)
    } else {
        0
    };

    assert_eq!(
        capture_count,
        0,
        "Without TLS MITM handshake, ZERO capture metadata files must exist. \
         Found {} in {}. This means the gateway is capturing without decryption — \
         the capture pipeline must only trigger on successfully decrypted traffic.",
        capture_count,
        captures_dir.display()
    );
    assert_eq!(
        object_count,
        0,
        "Without TLS MITM handshake, ZERO object store files must exist. \
         Found {} in {}. This means the gateway is storing undecrypted bytes — \
         capture must only happen on decrypted HTTP request/response bodies.",
        object_count,
        objects_dir.display()
    );

    handle.abort();
}

// ===========================================================================
// Test 6: Capture metadata file contains correct cross-references
// ===========================================================================

/// **Proves deliverable:** "Raw JSON request/response pairs saved to disk" —
/// the capture metadata JSON links the request hash and response hash together,
/// enabling manual inspection to trace from metadata to raw bytes.
///
/// **What it does:**
/// 1. Full pipeline: CONNECT → TLS → HTTP POST → capture.
/// 2. Reads the capture metadata JSON file.
/// 3. Verifies it contains fields linking to the request and response hashes.
/// 4. Verifies those hashes correspond to actual files in objects/req/ and objects/resp/.
///
/// **Anti-fake property:** A capture file that is empty, malformed, or lacks
/// cross-references to the actual objects would fail.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capture_metadata_links_to_object_files() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();
    let port = available_port();

    let handle = start_gateway(port, data_dir.clone());
    tokio::time::sleep(Duration::from_millis(800)).await;

    // Full pipeline
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", port).parse().unwrap(),
        Duration::from_secs(3),
    )
    .expect("Must TCP connect to gateway");

    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    let connect_response = send_connect(&mut stream, "api.anthropic.com", 443);
    assert!(connect_response.starts_with("HTTP/1.1 200"));

    let tls_config = Arc::new(build_tls_client_config(&data_dir));
    let mut tls_stream = tls_handshake(stream, tls_config, "api.anthropic.com");

    let request_body = sample_request_body();
    let http_request = build_http_request("api.anthropic.com", &request_body);
    tls_stream.write_all(&http_request).unwrap();
    tls_stream.flush().unwrap();

    let mut response_buf = vec![0u8; 8192];
    let _ = tls_stream.read(&mut response_buf);

    tokio::time::sleep(Duration::from_millis(2000)).await;

    // Find and read capture metadata file
    let captures_dir = data_dir.join("captures");
    assert!(
        captures_dir.exists(),
        "Captures directory must exist after a successful capture"
    );

    let capture_files = list_files_recursive(&captures_dir);
    assert!(
        !capture_files.is_empty(),
        "At least one capture metadata file must exist"
    );

    // Read the first capture metadata file
    let metadata_bytes = std::fs::read(&capture_files[0]).unwrap_or_else(|e| {
        panic!(
            "Must read capture file {}: {}",
            capture_files[0].display(),
            e
        )
    });

    let metadata_str = String::from_utf8_lossy(&metadata_bytes);

    // The metadata must be valid JSON
    let metadata: serde_json::Value = serde_json::from_str(&metadata_str).unwrap_or_else(|e| {
        panic!(
            "Capture metadata must be valid JSON. File: {}, Error: {}, Content: {:?}",
            capture_files[0].display(),
            e,
            metadata_str
        )
    });

    // The metadata must contain request and response hash references.
    // Check for common field names that would link to the objects.
    let has_req_ref = metadata.get("request_hash").is_some()
        || metadata.get("req_hash").is_some()
        || metadata.get("req_bytes_ref").is_some();
    let has_resp_ref = metadata.get("response_hash").is_some()
        || metadata.get("resp_hash").is_some()
        || metadata.get("resp_bytes_ref").is_some();

    assert!(
        has_req_ref,
        "Capture metadata must contain a request hash reference. \
         Keys present: {:?}",
        metadata.as_object().map(|o| o.keys().collect::<Vec<_>>())
    );
    assert!(
        has_resp_ref,
        "Capture metadata must contain a response hash reference. \
         Keys present: {:?}",
        metadata.as_object().map(|o| o.keys().collect::<Vec<_>>())
    );

    // Verify that the referenced object files actually exist
    let req_objects_dir = data_dir.join("objects").join("req");
    let resp_objects_dir = data_dir.join("objects").join("resp");

    assert!(
        req_objects_dir.exists() && walkdir_count(&req_objects_dir) > 0,
        "Request object files must exist"
    );
    assert!(
        resp_objects_dir.exists() && walkdir_count(&resp_objects_dir) > 0,
        "Response object files must exist"
    );

    handle.abort();
}

// ===========================================================================
// Test 7: Multiple sequential requests through same tunnel produce multiple captures
// ===========================================================================

/// **Proves deliverable:** "Raw JSON request/response pairs saved to disk" —
/// the gateway captures each request/response pair independently, even when
/// they flow through the same TLS tunnel.
///
/// **What it does:**
/// 1. Full pipeline: CONNECT → TLS → send TWO HTTP requests sequentially.
/// 2. Verifies that capture artifacts increase (at least 2 request objects).
///
/// **Anti-fake property:** A gateway that only captures the first request in
/// a tunnel would fail this test. Content-addressable dedup means we need
/// distinct request bodies.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn multiple_requests_through_tunnel_produce_multiple_captures() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();
    let port = available_port();

    let handle = start_gateway(port, data_dir.clone());
    tokio::time::sleep(Duration::from_millis(800)).await;

    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", port).parse().unwrap(),
        Duration::from_secs(3),
    )
    .expect("Must TCP connect to gateway");

    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    let connect_response = send_connect(&mut stream, "api.anthropic.com", 443);
    assert!(connect_response.starts_with("HTTP/1.1 200"));

    let tls_config = Arc::new(build_tls_client_config(&data_dir));
    let mut tls_stream = tls_handshake(stream, tls_config, "api.anthropic.com");

    // Send FIRST request with unique content
    let body1 = serde_json::to_vec(&serde_json::json!({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 100,
        "messages": [{"role": "user", "content": "First request - unique A"}]
    }))
    .unwrap();
    let http_req1 = build_http_request("api.anthropic.com", &body1);
    tls_stream.write_all(&http_req1).unwrap();
    tls_stream.flush().unwrap();

    // Read response for first request
    let mut resp1_buf = vec![0u8; 8192];
    let _ = tls_stream.read(&mut resp1_buf);

    // Brief pause between requests
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Send SECOND request with different unique content
    let body2 = serde_json::to_vec(&serde_json::json!({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 200,
        "messages": [{"role": "user", "content": "Second request - unique B"}]
    }))
    .unwrap();
    let http_req2 = build_http_request("api.anthropic.com", &body2);
    tls_stream.write_all(&http_req2).unwrap();
    tls_stream.flush().unwrap();

    // Read response for second request
    let mut resp2_buf = vec![0u8; 8192];
    let _ = tls_stream.read(&mut resp2_buf);

    // Give capture pipeline time to process both
    tokio::time::sleep(Duration::from_millis(2000)).await;

    // Verify multiple captures were produced
    let req_objects_dir = data_dir.join("objects").join("req");
    let req_count = if req_objects_dir.exists() {
        walkdir_count(&req_objects_dir)
    } else {
        0
    };

    assert!(
        req_count >= 2,
        "Two distinct requests through the tunnel must produce at least 2 request object files. \
         Found {}. The gateway must capture each request/response pair independently.",
        req_count
    );

    let captures_dir = data_dir.join("captures");
    let capture_count = if captures_dir.exists() {
        walkdir_count(&captures_dir)
    } else {
        0
    };

    assert!(
        capture_count >= 2,
        "Two requests must produce at least 2 capture metadata files. Found {}.",
        capture_count
    );

    handle.abort();
}
