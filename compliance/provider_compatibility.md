# Recondo Provider Compatibility Matrix

Documents transport compatibility for each AI coding agent routing through the Recondo gateway.

## Agent Compatibility

| Agent | HTTPS_PROXY Support | CA Trust Mechanism | Transport Protocol | TLS Pinning | Known Issues |
|-------|--------------------|--------------------|-------------------|-------------|-------------|
| Claude Code | Yes (native Node.js) | `NODE_TLS_REJECT_UNAUTHORIZED=0` or install CA in system trust store | HTTPS (SSE over HTTP/1.1) | No | None. Fully tested end-to-end. |
| Codex | Yes (native Rust) | `CODEX_CA_CERTIFICATE=$HOME/.recondo/ca/ca.crt` | WebSocket over HTTPS (`wss://chatgpt.com`) | No | Connects to chatgpt.com, not api.openai.com. WebSocket frames require special capture handling. |
| Gemini | Yes (standard HTTP client) | System trust store or `GOOGLE_APPLICATION_CREDENTIALS` + custom CA | HTTPS (SSE over HTTP/1.1) | No | API key passed as query parameter (`?key=...`). Gateway must not log query strings in plaintext. |
| Cursor | Yes (Electron/Node.js based) | `NODE_TLS_REJECT_UNAUTHORIZED=0` or system CA install | HTTPS (SSE over HTTP/1.1) | Possible (varies by version) | Some versions may pin TLS certificates, preventing MITM. Requires testing per release. Custom API endpoints may differ from standard provider URLs. |
| Aider | Yes (Python requests library) | `REQUESTS_CA_BUNDLE` or `SSL_CERT_FILE` env var, or system trust store | HTTPS (SSE over HTTP/1.1) | No | Python-based; uses standard `requests` library which respects `HTTPS_PROXY`. Multiple provider backends supported (Anthropic, OpenAI, etc.). |

## Transport Details

### HTTPS_PROXY Protocol
All agents connect to the Recondo gateway via HTTP CONNECT tunnel:
1. Agent sends `CONNECT api.anthropic.com:443 HTTP/1.1` to gateway
2. Gateway responds `HTTP/1.1 200 Connection Established`
3. Agent initiates TLS handshake inside tunnel
4. Gateway performs TLS MITM (terminate + re-encrypt) for known providers
5. Decrypted traffic is inspected, captured, then forwarded to upstream

### TLS Trust Chain
The gateway generates a self-signed CA certificate at `~/.recondo/ca/ca.crt`. Each agent must trust this CA to accept the gateway's MITM certificates. Trust mechanisms vary by agent runtime:

- **Node.js** (Claude Code, Cursor): `NODE_TLS_REJECT_UNAUTHORIZED=0` disables all certificate validation. For production, install the CA in the system trust store instead.
- **Rust** (Codex): `CODEX_CA_CERTIFICATE` points to the CA PEM file. Codex uses native-tls or rustls which respects this env var.
- **Python** (Aider): `REQUESTS_CA_BUNDLE` or `SSL_CERT_FILE` points to the CA PEM file. Alternatively, append the CA to the system certificate bundle.
- **Google API clients** (Gemini): Standard HTTP clients respect system trust store. For service account auth, the CA must be in the system store.

### Corporate TLS Inspection
When behind a corporate TLS inspection firewall (Zscaler, Blue Coat, Palo Alto), the gateway needs the corporate CA to trust re-signed upstream certificates:
```
cp /path/to/corporate/CA.pem ~/.recondo/ca/extra_roots.pem
```
Or per-session:
```
RECONDO_EXTRA_CA_CERTS=/path/to/corporate/CA.pem cargo run
```

## Provider API Endpoints

| Provider | API Host | Capture Endpoints | Protocol |
|----------|----------|-------------------|----------|
| Anthropic | api.anthropic.com | POST /v1/messages | HTTPS + SSE |
| OpenAI | api.openai.com | POST /v1/chat/completions | HTTPS + SSE |
| OpenAI (Codex) | chatgpt.com | GET /backend-api/codex/* (WebSocket upgrade) | WSS |
| Google (Gemini) | generativelanguage.googleapis.com | POST /v1beta/models/*/generateContent, POST /v1beta/models/*/streamGenerateContent | HTTPS + SSE |
