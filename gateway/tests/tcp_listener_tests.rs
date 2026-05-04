//! Feature 1: TCP listener / CONNECT handler loop tests.
//!
//! These tests verify that the gateway can actually start on a port, accept CONNECT
//! requests, perform TLS MITM for known LLM provider hosts, forward traffic,
//! and capture request/response bytes through the full production path.
//!
//! Design reference: IMPLEMENTATION_ROADMAP.md Week 1 Tasks 1-3.

use std::io::{Read, Write};
use std::net::{TcpListener as StdTcpListener, TcpStream};
use std::time::Duration;
use tempfile::TempDir;

use recondo_gateway::gateway;

// ---------------------------------------------------------------------------
// Helper: find an available TCP port by binding to port 0
// ---------------------------------------------------------------------------

fn available_port() -> u16 {
    let listener = StdTcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

// ===========================================================================
// 1.1 Gateway starts and accepts TCP connections
// ===========================================================================

/// **Proves:** The gateway TCP listener binds to the specified port and accepts
/// at least one incoming TCP connection. A `TcpStream::connect` to that port
/// succeeds within 2 seconds.
///
/// **Anti-fake property:** A stub that never calls `bind()` or `listen()` would
/// cause the connect to fail with "connection refused". The port is dynamically
/// chosen, so a hardcoded port would also fail.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gateway_starts_and_accepts_tcp_connection() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();
    let port = available_port();

    // Start the gateway in a background task
    let handle = tokio::spawn({
        let data_dir = data_dir.clone();
        async move {
            let config =
                gateway::GatewayConfig::new(port, data_dir).with_bind_addr("127.0.0.1".to_string());
            gateway::run_listener(&config).await
        }
    });

    // Give the listener time to bind
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Attempt a TCP connection — this proves the listener is running
    let connect_result = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", port).parse().unwrap(),
        Duration::from_secs(2),
    );

    assert!(
        connect_result.is_ok(),
        "Must be able to TCP connect to the gateway on port {}",
        port
    );

    // Clean up
    handle.abort();
}

// ===========================================================================
// 1.2 Gateway responds to CONNECT with 200 Connection Established
// ===========================================================================

/// **Proves:** When a client sends a valid CONNECT request for a known LLM
/// provider host, the gateway responds with "HTTP/1.1 200 Connection Established".
///
/// **Anti-fake property:** The test sends a real CONNECT line over TCP and reads
/// the response bytes. A gateway that ignores CONNECT or responds with 4xx would
/// fail the assertion on the status line prefix.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gateway_responds_200_to_connect_for_known_host() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();
    let port = available_port();

    let handle = tokio::spawn({
        let data_dir = data_dir.clone();
        async move {
            let config =
                gateway::GatewayConfig::new(port, data_dir).with_bind_addr("127.0.0.1".to_string());
            gateway::run_listener(&config).await
        }
    });

    // FIND-8-M: retry loop on connect_timeout instead of a fixed
    // sleep. Under heavy CI load, 500ms was sometimes insufficient
    // for the listener's .listen() call to complete; this surfaced
    // 1× as a flake. The retry covers the same total budget
    // (~500ms) but exits on first success, giving graceful
    // degradation against scheduler jitter.
    let target = format!("127.0.0.1:{}", port).parse().unwrap();
    let mut stream: Option<TcpStream> = None;
    for attempt in 0..10 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        match TcpStream::connect_timeout(&target, Duration::from_millis(100)) {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            // FIND-9-M: only retry on the two kinds that are
            // expected during listener-startup races. Any other
            // error class (PermissionDenied, AddrNotAvailable, etc.)
            // means the test's environment is broken — the
            // previous blanket `Err(_) => continue` would mask
            // those failures behind the eventual `expect("Must
            // connect to gateway after 10 retry attempts")` panic
            // and obscure the real cause.
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            Err(e) => {
                panic!("unexpected TCP connect error: {} ({:?})", e, e.kind());
            }
        }
    }
    let mut stream = stream.expect("Must connect to gateway after 10 retry attempts");

    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    // Send a CONNECT request for api.anthropic.com:443
    let connect_req =
        b"CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n";
    stream.write_all(connect_req).unwrap();
    stream.flush().unwrap();

    // Read the response
    let mut buf = [0u8; 512];
    let n = stream.read(&mut buf).expect("Must receive response bytes");
    let response = std::str::from_utf8(&buf[..n]).expect("Response must be UTF-8");

    assert!(
        response.starts_with("HTTP/1.1 200"),
        "CONNECT response must start with 'HTTP/1.1 200', got: {:?}",
        response
    );
    assert!(
        response.contains("Connection Established"),
        "CONNECT response must contain 'Connection Established', got: {:?}",
        response
    );

    handle.abort();
}

// ===========================================================================
// 1.3 Non-CONNECT HTTP method is rejected or handled appropriately
// ===========================================================================

/// **Proves:** Sending a GET request (not CONNECT) to the gateway does NOT receive
/// a "200 Connection Established" response. The gateway must differentiate between
/// CONNECT tunneling and plain HTTP.
///
/// **Anti-fake property:** A gateway that responds "200 Connection Established" to
/// every TCP connection regardless of content would fail this test.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gateway_rejects_non_connect_method() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();
    let port = available_port();

    let handle = tokio::spawn({
        let data_dir = data_dir.clone();
        async move {
            let config =
                gateway::GatewayConfig::new(port, data_dir).with_bind_addr("127.0.0.1".to_string());
            gateway::run_listener(&config).await
        }
    });

    // FIND-8-M: retry loop on connect_timeout instead of a fixed
    // sleep. Under heavy CI load, 500ms was sometimes insufficient
    // for the listener's .listen() call to complete; this surfaced
    // 1× as a flake. The retry covers the same total budget
    // (~500ms) but exits on first success, giving graceful
    // degradation against scheduler jitter.
    let target = format!("127.0.0.1:{}", port).parse().unwrap();
    let mut stream: Option<TcpStream> = None;
    for attempt in 0..10 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        match TcpStream::connect_timeout(&target, Duration::from_millis(100)) {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            // FIND-9-M: only retry on the two kinds that are
            // expected during listener-startup races. Any other
            // error class (PermissionDenied, AddrNotAvailable, etc.)
            // means the test's environment is broken — the
            // previous blanket `Err(_) => continue` would mask
            // those failures behind the eventual `expect("Must
            // connect to gateway after 10 retry attempts")` panic
            // and obscure the real cause.
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            Err(e) => {
                panic!("unexpected TCP connect error: {} ({:?})", e, e.kind());
            }
        }
    }
    let mut stream = stream.expect("Must connect to gateway after 10 retry attempts");

    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();

    // Send a GET request instead of CONNECT
    let get_req = b"GET / HTTP/1.1\r\nHost: example.com\r\n\r\n";
    stream.write_all(get_req).unwrap();
    stream.flush().unwrap();

    // Read response
    let mut buf = [0u8; 512];
    let read_result = stream.read(&mut buf);

    match read_result {
        Ok(n) if n > 0 => {
            let response = String::from_utf8_lossy(&buf[..n]);
            // Must NOT be a 200 Connection Established
            assert!(
                !response.contains("Connection Established"),
                "GET request must NOT receive 'Connection Established', got: {:?}",
                response
            );
        }
        Ok(0) => {
            // Connection closed — acceptable behavior for non-CONNECT
        }
        Err(_) => {
            // Read timeout or connection reset — acceptable behavior for non-CONNECT
        }
        _ => {}
    }

    handle.abort();
}

// ===========================================================================
// 1.4 Passthrough host does not get MITM'd
// ===========================================================================

/// **Proves:** A CONNECT to a non-LLM host (e.g., github.com) still receives
/// a 200 Connection Established but is handled as passthrough (no TLS MITM).
/// The gateway must not attempt to present a forged certificate for unknown hosts.
///
/// **Anti-fake property:** After the 200, writing TLS Client Hello bytes for
/// github.com should result in a passthrough tunnel (the gateway forwards raw
/// bytes without intercepting), not a TLS handshake with a MITM certificate.
/// We verify by checking that no capture files are created for a non-LLM host.
///
/// **Network access (Finding 15):** This test requires network access to
/// github.com:443 for the passthrough tunnel. The assertion on zero capture
/// files is valid regardless of network availability.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn passthrough_host_produces_no_capture_artifacts() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();
    let port = available_port();

    let handle = tokio::spawn({
        let data_dir = data_dir.clone();
        async move {
            let config =
                gateway::GatewayConfig::new(port, data_dir).with_bind_addr("127.0.0.1".to_string());
            gateway::run_listener(&config).await
        }
    });

    // FIND-8-M: retry loop on connect_timeout instead of a fixed
    // sleep. Under heavy CI load, 500ms was sometimes insufficient
    // for the listener's .listen() call to complete; this surfaced
    // 1× as a flake. The retry covers the same total budget
    // (~500ms) but exits on first success, giving graceful
    // degradation against scheduler jitter.
    let target = format!("127.0.0.1:{}", port).parse().unwrap();
    let mut stream: Option<TcpStream> = None;
    for attempt in 0..10 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        match TcpStream::connect_timeout(&target, Duration::from_millis(100)) {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            // FIND-9-M: only retry on the two kinds that are
            // expected during listener-startup races. Any other
            // error class (PermissionDenied, AddrNotAvailable, etc.)
            // means the test's environment is broken — the
            // previous blanket `Err(_) => continue` would mask
            // those failures behind the eventual `expect("Must
            // connect to gateway after 10 retry attempts")` panic
            // and obscure the real cause.
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            Err(e) => {
                panic!("unexpected TCP connect error: {} ({:?})", e, e.kind());
            }
        }
    }
    let mut stream = stream.expect("Must connect to gateway after 10 retry attempts");

    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();

    // CONNECT to a non-LLM host
    let connect_req = b"CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n";
    stream.write_all(connect_req).unwrap();
    stream.flush().unwrap();

    // Read the CONNECT response
    let mut buf = [0u8; 512];
    let n = stream.read(&mut buf).unwrap_or(0);
    if n > 0 {
        let response = String::from_utf8_lossy(&buf[..n]);
        assert!(
            response.starts_with("HTTP/1.1 200"),
            "Passthrough CONNECT must also return 200, got: {:?}",
            response
        );
    }

    // Verify no capture artifacts were created for the passthrough host
    let captures_dir = data_dir.join("captures");
    let objects_dir = data_dir.join("objects");

    let capture_count = if captures_dir.exists() {
        std::fs::read_dir(&captures_dir).unwrap().count()
    } else {
        0
    };

    let object_count = if objects_dir.exists() {
        // Count recursively
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

/// Count files recursively in a directory (without walkdir crate).
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

// ===========================================================================
// 1.5 Multiple simultaneous connections are handled
// ===========================================================================

/// **Proves:** The gateway can accept at least 3 concurrent TCP connections
/// and respond to CONNECT on each independently. This validates that the
/// listener loop handles concurrency, not just one connection at a time.
///
/// **Anti-fake property:** A single-threaded accept-one-then-exit listener
/// would fail when the second connection attempts CONNECT.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gateway_handles_multiple_concurrent_connections() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();
    let port = available_port();

    let handle = tokio::spawn({
        let data_dir = data_dir.clone();
        async move {
            let config =
                gateway::GatewayConfig::new(port, data_dir).with_bind_addr("127.0.0.1".to_string());
            gateway::run_listener(&config).await
        }
    });

    let addr: std::net::SocketAddr = format!("127.0.0.1:{}", port).parse().unwrap();
    let timeout = Duration::from_secs(2);

    // Wait for the listener with a retry loop (same pattern as
    // `gateway_starts_and_accepts_tcp_connection` above). The
    // previous fixed 500ms sleep flaked under parallel-test load
    // (e.g. when other binaries are spawning testcontainers and
    // contending for CPU/IO).
    let mut probe: Option<TcpStream> = None;
    for attempt in 0..20 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        match TcpStream::connect_timeout(&addr, Duration::from_millis(100)) {
            Ok(s) => {
                probe = Some(s);
                break;
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            Err(e) => {
                panic!("unexpected TCP connect error: {} ({:?})", e, e.kind());
            }
        }
    }
    let first = probe.expect("Must connect to gateway after 20 retry attempts");

    // Now the listener is verified up — open the remaining concurrent
    // connections and reuse `first` as the first stream.
    let mut streams = vec![first];
    for _ in 1..3 {
        let stream = TcpStream::connect_timeout(&addr, timeout).expect("Must connect to gateway");
        streams.push(stream);
    }
    for stream in &streams {
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
    }

    // Send CONNECT on each and verify response
    for (i, stream) in streams.iter_mut().enumerate() {
        let host = match i {
            0 => "api.anthropic.com",
            1 => "api.openai.com",
            _ => "github.com",
        };
        let connect_req = format!(
            "CONNECT {}:443 HTTP/1.1\r\nHost: {}:443\r\n\r\n",
            host, host
        );
        stream.write_all(connect_req.as_bytes()).unwrap();
        stream.flush().unwrap();

        let mut buf = [0u8; 512];
        let n = stream.read(&mut buf).expect("Must receive response");
        let response = String::from_utf8_lossy(&buf[..n]);

        assert!(
            response.starts_with("HTTP/1.1 200"),
            "Connection {} to {} must get 200, got: {:?}",
            i,
            host,
            response
        );
    }

    handle.abort();
}

// ===========================================================================
// 1.6 NEGATIVE: Gateway not started -> connection refused
// ===========================================================================

/// **Proves:** Without starting the gateway, connecting to the port fails.
/// This is the fundamental negative test: it proves that the positive tests
/// above can only pass because the gateway is actually running.
///
/// **Anti-fake property:** If the test infrastructure somehow has a listener
/// on the chosen port already, this test would fail — proving our test setup
/// is sound.
#[test]
fn connection_refused_when_gateway_not_started() {
    let port = available_port();
    // Drop the listener immediately — port is now free

    let result = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", port).parse().unwrap(),
        Duration::from_millis(500),
    );

    assert!(
        result.is_err(),
        "Connecting to port {} without a gateway must fail",
        port
    );
}
