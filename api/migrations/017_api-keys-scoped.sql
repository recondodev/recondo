-- Migration 017: First-class scoped MCP keys.
--
-- `api_keys` originally carried UUID project IDs for the API-only
-- `projects` table. Gateway/MCP project IDs are text, so scoped config
-- keys need this auth table to accept text project ids and record the
-- key scope/name.

ALTER TABLE api_keys
  DROP CONSTRAINT IF EXISTS api_keys_project_id_fkey;

ALTER TABLE api_keys
  ALTER COLUMN project_id TYPE TEXT USING project_id::TEXT,
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'admin';

ALTER TABLE api_keys
  DROP CONSTRAINT IF EXISTS api_keys_scope_check;

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_scope_check
  CHECK (scope IN ('admin', 'scoped'));
