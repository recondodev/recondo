#!/usr/bin/env bash
#
# Launch OpenAI Codex with traffic routed through the local Recondo gateway.
#
# Prerequisites:
#   1. Gateway running on localhost:8443  (`just run`)
#   2. Recondo CA generated               (`just recondo init`)
#
# Note: Codex connects to chatgpt.com via WebSocket (not api.openai.com via HTTP SSE).
# The gateway captures both protocols.

set -euo pipefail

CA_PATH="${RECONDO_CA:-$HOME/.recondo/ca/ca.crt}"
PROXY="${RECONDO_PROXY:-http://localhost:8443}"

if [[ ! -f "$CA_PATH" ]]; then
  echo "Error: CA certificate not found at $CA_PATH" >&2
  echo "Run \`just recondo init\` first to generate it." >&2
  exit 1
fi

# Codex (a Rust binary) uses CODEX_CA_CERTIFICATE — the rustls equivalent of
# Node's NODE_EXTRA_CA_CERTS — to trust the gateway's CA.
CODEX_CA_CERTIFICATE="$CA_PATH" \
  HTTPS_PROXY="$PROXY" \
  codex "$@"
