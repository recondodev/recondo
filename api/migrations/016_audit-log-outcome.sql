-- Migration 016: MCP audit-log outcome metadata.
--
-- Group A hardening requires audit rows for both successful and failed
-- tool calls. The original MCP audit table recorded only the attempted
-- tool call and response size, so failures were indistinguishable from
-- missing audit rows. Add explicit outcome fields while preserving the
-- append-only trigger created in migration 013.

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'success'
    CHECK (outcome IN ('success', 'error', 'aborted')),
  ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_log_outcome ON audit_log(outcome);
