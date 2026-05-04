use std::net::SocketAddr;

use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// Start a mock HTTP server that returns the given fixture as an SSE response body.
///
/// - Binds to `127.0.0.1:0` (random port).
/// - Accepts any HTTP request method (though tests use POST).
/// - Returns the fixture bytes with `Content-Type: text/event-stream` and HTTP 200.
/// - Returns `(url, shutdown_tx)`: url is `http://127.0.0.1:{port}`, shutdown_tx stops the server.
/// - Deterministic: same fixture produces identical response bytes every time.
pub async fn start_mock_server(fixture: &str, _provider: &str) -> (String, oneshot::Sender<()>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("Must bind to random port");
    let addr: SocketAddr = listener.local_addr().expect("Must get local addr");
    let url = format!("http://127.0.0.1:{}", addr.port());

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let fixture_bytes = fixture.as_bytes().to_vec();

    tokio::spawn(async move {
        let fixture = fixture_bytes;
        // Use a select to listen for shutdown or new connections
        tokio::pin!(shutdown_rx);

        loop {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    // Shutdown requested — drop the listener and exit
                    break;
                }
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((stream, _peer)) => {
                            let fixture_clone = fixture.clone();
                            tokio::spawn(async move {
                                handle_connection(stream, &fixture_clone).await;
                            });
                        }
                        Err(_) => {
                            // Accept error — just continue
                            continue;
                        }
                    }
                }
            }
        }
    });

    (url, shutdown_tx)
}

/// Handle a single HTTP connection: read the request, send the fixture as response.
///
/// Reads until the end-of-headers marker (`\r\n\r\n`) is found, handling the
/// case where a single read() may not return the complete request headers.
/// This is test-only code with small payloads, so we cap at 8KB total.
async fn handle_connection(stream: tokio::net::TcpStream, fixture: &[u8]) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut stream = stream;

    // Read until we find the end-of-headers marker (\r\n\r\n) or fill the buffer.
    // For test payloads this is always well under 8KB.
    let mut buf = vec![0u8; 8192];
    let mut total_read = 0;
    loop {
        match stream.read(&mut buf[total_read..]).await {
            Ok(0) => break, // Connection closed
            Ok(n) => {
                total_read += n;
                // Check if we've received the full headers
                if buf[..total_read].windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                if total_read >= buf.len() {
                    break; // Buffer full, proceed anyway
                }
            }
            Err(_) => break,
        }
    }

    // Build HTTP response
    let status_line = "HTTP/1.1 200 OK\r\n";
    let headers = format!(
        "Content-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        fixture.len()
    );

    let mut response = Vec::new();
    response.extend_from_slice(status_line.as_bytes());
    response.extend_from_slice(headers.as_bytes());
    response.extend_from_slice(fixture);

    let _ = stream.write_all(&response).await;
    let _ = stream.flush().await;
}
