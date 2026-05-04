-- Migration 009: Fix heartbeats table for API usage.
--
-- Root cause: migration 001 copied heartbeats DDL from the gateway schema:
--   - id TEXT PRIMARY KEY with no DEFAULT (gateway always provides id)
--   - no metadata column (gateway does not send metadata; API tests need it)
--
-- 1. Allow id to be auto-generated (API test fixtures do not provide id)
-- 2. Add metadata JSONB column (API tests insert availability metadata JSON)
--
-- Same pattern as migration 007 which fixed anomaly_events.id and alert_configs.id.

ALTER TABLE heartbeats ALTER COLUMN id SET DEFAULT gen_random_uuid()::TEXT;

ALTER TABLE heartbeats ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::JSONB;
