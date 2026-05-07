-- Migration 013: MCP per-call audit log.
--
-- Adds a new `audit_log` table for the recondo-mcp v1 server. Every MCP
-- tool call appends a row here so SOC 2 / ISO 42001 compliance evidence
-- captures who invoked which tool, with what arguments, and how large
-- the response was. The table is APPEND-ONLY: an immutability trigger
-- forbids UPDATE and DELETE (mirroring the `access_audit_log` pattern
-- from migration 002). The trigger reuses `prevent_audit_mutation()`
-- defined in migration 002.
--
-- This is structurally distinct from:
--   - `access_audit_log` (002) — REST/HTTP API request audit (CC6).
--   - `compliance_audit_log` (004) — control-status mutation history.
--
-- Plan D contract: see docs/superpowers/audits/2026-05-06-mcp-pre-flight.md
-- §3 (D-C0-2).

CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    tool_name TEXT NOT NULL,
    arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
    response_bytes INTEGER NOT NULL DEFAULT 0,
    client_name TEXT,
    key_id TEXT
);

DROP TRIGGER IF EXISTS audit_log_mcp_immutability ON audit_log;
CREATE TRIGGER audit_log_mcp_immutability
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW
    EXECUTE FUNCTION prevent_audit_mutation();

CREATE INDEX IF NOT EXISTS idx_audit_log_requested_at ON audit_log(requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_tool_name ON audit_log(tool_name);
CREATE INDEX IF NOT EXISTS idx_audit_log_key_id ON audit_log(key_id);
