-- Initial migration: Create all API-managed tables.
--
-- This migration creates the core schema used by the Recondo API server.
-- Tables use CREATE TABLE IF NOT EXISTS for idempotency with the existing
-- ensure*() functions that also create tables at startup.
--
-- Tables:
--   projects          - Multi-tenant project registry
--   sessions          - Gateway capture sessions (matches gateway pg_schema_ddl.rs)
--   turns             - Individual API turns within sessions
--   tool_calls        - Tool invocations within turns
--   anomaly_events    - Anomaly detection events (API-layer addition)
--   api_keys          - API key storage with SHA-256 hashes
--   access_audit_log  - Append-only audit log (SOC 2 CC6)
--   heartbeats        - Gateway availability monitoring
--   alert_configs     - Webhook alert configuration
--   usage_aggregates  - Pre-aggregated usage metrics

-- Projects table (API-layer addition for multi-tenant access)
-- W2: projects.id is UUID (API-generated), while sessions.project_id is TEXT
-- (gateway-generated). This is intentional: sessions use the gateway's schema
-- (TEXT primary keys), projects use the API's schema (UUID). JOINs between
-- projects.id and sessions.project_id require a cast:
--   JOIN projects p ON p.id::text = s.project_id
CREATE TABLE IF NOT EXISTS projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sessions — matches gateway pg_schema_ddl.rs + project_id for API scoping
-- W4: started_at is TEXT (not TIMESTAMPTZ) to match the gateway schema for
-- cross-database compatibility (SQLite + PostgreSQL). Values are stored in
-- ISO 8601 format (e.g., "2026-03-22T12:00:00.000Z") which sorts correctly
-- in lexicographic ORDER BY. The gateway writes TEXT timestamps consistently,
-- so changing to TIMESTAMPTZ would require a migration of all existing data.
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT,
  provider            TEXT NOT NULL,
  model               TEXT,
  started_at          TEXT NOT NULL,
  last_active_at      TEXT NOT NULL,
  ended_at            TEXT,
  initial_intent      TEXT,
  system_prompt_hash  TEXT NOT NULL,
  total_turns         BIGINT NOT NULL DEFAULT 0,
  turns_captured      BIGINT NOT NULL DEFAULT 0,
  dropped_events      BIGINT NOT NULL DEFAULT 0,
  total_tokens        BIGINT NOT NULL DEFAULT 0,
  total_cost_usd      DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  framework           TEXT,
  agent_id            TEXT,
  agent_version       TEXT,
  git_repo            TEXT,
  git_branch          TEXT,
  git_commit          TEXT,
  working_directory   TEXT,
  parent_session_id   TEXT,
  tags                TEXT,
  account_uuid        TEXT,
  device_id           TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions (started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions (provider);
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions (project_id);
-- W4 fix: Indexes for new D1.4 filters (status derives from ended_at, framework filter)
CREATE INDEX IF NOT EXISTS idx_sessions_ended_at ON sessions (ended_at);
CREATE INDEX IF NOT EXISTS idx_sessions_framework ON sessions (framework);

-- Turns — matches gateway pg_schema_ddl.rs
CREATE TABLE IF NOT EXISTS turns (
  id                      TEXT PRIMARY KEY,
  session_id              TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  sequence_num            BIGINT NOT NULL,
  timestamp               TEXT NOT NULL,
  request_hash            TEXT NOT NULL,
  response_hash           TEXT NOT NULL,
  req_bytes_ref           TEXT,
  resp_bytes_ref          TEXT,
  req_bytes_size          BIGINT,
  resp_bytes_size         BIGINT,
  model                   TEXT,
  response_text           TEXT,
  thinking_text           TEXT,
  stop_reason             TEXT NOT NULL,
  capture_complete        BOOLEAN NOT NULL DEFAULT TRUE,
  input_tokens            BIGINT NOT NULL,
  output_tokens           BIGINT NOT NULL,
  cache_read_tokens       BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens   BIGINT NOT NULL DEFAULT 0,
  cost_usd                DOUBLE PRECISION,
  created_at              TEXT NOT NULL,
  messages_delta          TEXT,
  messages_delta_count    BIGINT,
  raw_extra               TEXT,
  parser_version          TEXT,
  parse_errors            TEXT,
  provider                TEXT,
  transport               TEXT,
  ws_direction            TEXT,
  duration_ms             BIGINT,
  ttfb_ms                 BIGINT,
  api_endpoint            TEXT,
  http_status             BIGINT,
  error_message           TEXT,
  retry_count             BIGINT NOT NULL DEFAULT 0,
  tool_call_count         BIGINT NOT NULL DEFAULT 0,
  thinking_tokens         BIGINT NOT NULL DEFAULT 0,
  server_id               TEXT,
  integrity_verified      BOOLEAN,
  supersedes_turn_id      TEXT,
  user_request_text       TEXT,
  search_vector           tsvector,
  UNIQUE(session_id, sequence_num)
);

-- Add columns that may be missing if the gateway created the table first
ALTER TABLE turns ADD COLUMN IF NOT EXISTS user_request_text TEXT;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_turns_session_id ON turns (session_id);
CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON turns (timestamp);
CREATE INDEX IF NOT EXISTS idx_turns_search_vector ON turns USING GIN (search_vector);

-- Tool calls — matches gateway pg_schema_ddl.rs
CREATE TABLE IF NOT EXISTS tool_calls (
  id              TEXT PRIMARY KEY,
  turn_id         TEXT NOT NULL REFERENCES turns(id) ON DELETE RESTRICT,
  tool_name       TEXT NOT NULL,
  tool_input      TEXT NOT NULL,
  input_hash      TEXT,
  sequence_num    BIGINT,
  output          TEXT,
  output_hash     TEXT,
  duration_ms     BIGINT,
  error           TEXT,
  status          TEXT,
  artifacts_created TEXT,
  artifact_hashes TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_turn_id ON tool_calls (turn_id);

-- Anomaly events (API-layer addition)
CREATE TABLE IF NOT EXISTS anomaly_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT REFERENCES sessions(id),
  turn_id         TEXT REFERENCES turns(id),
  anomaly_type      TEXT NOT NULL,
  severity        TEXT NOT NULL DEFAULT 'info',
  description     TEXT,
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_anomaly_events_session ON anomaly_events (session_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_events_turn ON anomaly_events (turn_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_events_type ON anomaly_events (anomaly_type);

-- API keys (API-layer addition)
CREATE TABLE IF NOT EXISTS api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash        TEXT NOT NULL UNIQUE,
  project_id      UUID REFERENCES projects(id),
  tier            TEXT NOT NULL DEFAULT 'standard',
  rate_limit_rpm  INTEGER NOT NULL DEFAULT 60,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ
);

-- Access audit log (SOC 2 CC6)
CREATE TABLE IF NOT EXISTS access_audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
  api_key_id      TEXT NOT NULL,
  user_id         TEXT,
  query_type      TEXT NOT NULL,
  resource_ids    TEXT[],
  source_ip       TEXT,
  user_agent      TEXT,
  response_status INT
);

-- Append-only enforcement: prevent UPDATE and DELETE on access_audit_log
CREATE OR REPLACE FUNCTION prevent_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'access_audit_log is append-only: % not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_immutability ON access_audit_log;
CREATE TRIGGER audit_log_immutability
  BEFORE UPDATE OR DELETE ON access_audit_log
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_mutation();

-- Heartbeats table for availability monitoring
CREATE TABLE IF NOT EXISTS heartbeats (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
  gateway_id      TEXT,
  status          TEXT NOT NULL DEFAULT 'ok',
  metadata        JSONB
);

CREATE INDEX IF NOT EXISTS idx_heartbeats_timestamp ON heartbeats (timestamp);

-- Alert configs table for webhook alert configuration
CREATE TABLE IF NOT EXISTS alert_configs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      TEXT NOT NULL,
  webhook_url     TEXT NOT NULL,
  completeness_threshold  DOUBLE PRECISION NOT NULL DEFAULT 100.0,
  availability_threshold  DOUBLE PRECISION NOT NULL DEFAULT 99.9,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_configs_project ON alert_configs (project_id);

-- Usage aggregation schema
-- B4 fix: team_id, developer_id, agent_id changed from nullable TEXT to
-- TEXT NOT NULL DEFAULT ''. PostgreSQL treats each NULL as distinct in UNIQUE
-- constraints, so UNIQUE(project_id, NULL, NULL, ...) would allow duplicate
-- rows. Using '' instead of NULL makes the UNIQUE constraint work correctly.
CREATE TABLE IF NOT EXISTS usage_aggregates (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          TEXT NOT NULL,
  team_id             TEXT NOT NULL DEFAULT '',
  developer_id        TEXT NOT NULL DEFAULT '',
  agent_id            TEXT NOT NULL DEFAULT '',
  model               TEXT NOT NULL,
  provider            TEXT NOT NULL,
  period              TEXT NOT NULL,
  period_start        TIMESTAMPTZ NOT NULL,

  -- Token metrics
  total_input_tokens  BIGINT NOT NULL DEFAULT 0,
  total_output_tokens BIGINT NOT NULL DEFAULT 0,
  total_cache_tokens  BIGINT NOT NULL DEFAULT 0,
  total_tokens        BIGINT NOT NULL DEFAULT 0,

  -- Cost metrics
  total_cost_usd      NUMERIC(12,4) NOT NULL DEFAULT 0,
  avg_cost_per_session NUMERIC(12,4) NOT NULL DEFAULT 0,
  avg_cost_per_turn   NUMERIC(12,4) NOT NULL DEFAULT 0,

  -- Session metrics
  session_count       INTEGER NOT NULL DEFAULT 0,
  avg_turns_per_session NUMERIC(8,2) NOT NULL DEFAULT 0,
  completion_rate     NUMERIC(5,4) NOT NULL DEFAULT 0,

  -- Tool metrics
  tool_call_count     INTEGER NOT NULL DEFAULT 0,
  unique_tools_used   INTEGER NOT NULL DEFAULT 0,
  tool_success_rate   NUMERIC(5,4) NOT NULL DEFAULT 0,
  avg_tool_latency_ms NUMERIC(10,2) NOT NULL DEFAULT 0,

  -- Latency metrics
  avg_latency_ms      NUMERIC(10,2) NOT NULL DEFAULT 0,
  latency_p50         NUMERIC(10,2) NOT NULL DEFAULT 0,
  latency_p95         NUMERIC(10,2) NOT NULL DEFAULT 0,

  UNIQUE(project_id, team_id, developer_id, agent_id, model, provider, period, period_start)
);

CREATE INDEX IF NOT EXISTS idx_usage_aggregates_project_period
  ON usage_aggregates (project_id, period, period_start);
