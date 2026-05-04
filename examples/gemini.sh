#!/usr/bin/env bash
#
# Launch a Gemini-based agent with traffic routed through the local Recondo gateway.
#
# Prerequisites:
#   1. Gateway running on localhost:8443  (`just run`)
#   2. Recondo CA generated               (`just recondo init`)

set -euo pipefail

CA_PATH="${RECONDO_CA:-$HOME/.recondo/ca/ca.crt}"
PROXY="${RECONDO_PROXY:-http://localhost:8443}"

if [[ ! -f "$CA_PATH" ]]; then
  echo "Error: CA certificate not found at $CA_PATH" >&2
  echo "Run \`just recondo init\` first to generate it." >&2
  exit 1
fi

# Most Gemini-based agents are Node binaries and honor NODE_EXTRA_CA_CERTS.
# Adjust the executable name and CA env var if your agent uses a different runtime.
NODE_EXTRA_CA_CERTS="$CA_PATH" \
  HTTPS_PROXY="$PROXY" \
  gemini "$@"
