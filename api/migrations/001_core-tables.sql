-- Migration 001: Core gateway tables.
--
-- Column definitions match gateway pg_schema_ddl.rs, with API-only additions: search_vector tsvector on turns.
-- This migration is the single source of truth for PostgreSQL schema.
-- All CREATE TABLE use IF NOT EXISTS for idempotency.
-- Gateway tables use TEXT for timestamps (cross-database compatibility with SQLite).
-- API-only tables use TIMESTAMPTZ. Converting gateway timestamps to TIMESTAMPTZ
-- requires coordinated Rust gateway changes.
-- ALTER TABLE ADD COLUMN IF NOT EXISTS ensures columns exist even if the
-- gateway created the table first without these API-needed columns.

-- Sessions table — matches gateway pg_schema_ddl.rs exactly
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT,
    started_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    ended_at TEXT,
    initial_intent TEXT,
    system_prompt_hash TEXT NOT NULL,
    total_turns BIGINT NOT NULL DEFAULT 0,
    turns_captured BIGINT NOT NULL DEFAULT 0,
    dropped_events BIGINT NOT NULL DEFAULT 0,
    total_tokens BIGINT NOT NULL DEFAULT 0,
    total_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    framework TEXT,
    agent_id TEXT,
    agent_version TEXT,
    git_repo TEXT,
    git_branch TEXT,
    git_commit TEXT,
    working_directory TEXT,
    parent_session_id TEXT,
    tags TEXT,
    account_uuid TEXT,
    device_id TEXT,
    project_id TEXT,
    tool_definitions_hash TEXT NOT NULL DEFAULT ''
);

-- Add columns that the gateway might not create
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tool_definitions_hash TEXT NOT NULL DEFAULT '';

-- Turns table — matches gateway pg_schema_ddl.rs exactly (37+ columns)
CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
    sequence_num BIGINT NOT NULL,
    timestamp TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_hash TEXT NOT NULL,
    req_bytes_ref TEXT,
    resp_bytes_ref TEXT,
    req_bytes_size BIGINT,
    resp_bytes_size BIGINT,
    model TEXT,
    response_text TEXT,
    thinking_text TEXT,
    stop_reason TEXT NOT NULL,
    capture_complete BOOLEAN NOT NULL DEFAULT TRUE,
    input_tokens BIGINT NOT NULL,
    output_tokens BIGINT NOT NULL,
    cache_read_tokens BIGINT NOT NULL,
    cache_creation_tokens BIGINT NOT NULL,
    cost_usd DOUBLE PRECISION,
    created_at TEXT NOT NULL,
    messages_delta TEXT,
    messages_delta_count BIGINT,
    raw_extra TEXT,
    parser_version TEXT,
    parse_errors TEXT,
    provider TEXT,
    transport TEXT,
    ws_direction TEXT,
    duration_ms BIGINT,
    ttfb_ms BIGINT,
    api_endpoint TEXT,
    http_status BIGINT,
    error_message TEXT,
    retry_count BIGINT NOT NULL DEFAULT 0,
    tool_call_count BIGINT NOT NULL DEFAULT 0,
    thinking_tokens BIGINT NOT NULL DEFAULT 0,
    server_id TEXT,
    integrity_verified BOOLEAN,
    supersedes_turn_id TEXT,
    user_request_text TEXT,
    search_vector tsvector,
    UNIQUE(session_id, sequence_num)
);

-- Add columns that the gateway might not create
ALTER TABLE turns ADD COLUMN IF NOT EXISTS user_request_text TEXT;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS search_vector tsvector;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS integrity_verified BOOLEAN;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS supersedes_turn_id TEXT;

-- Tool calls table — matches gateway pg_schema_ddl.rs exactly (13 columns)
CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE RESTRICT,
    tool_name TEXT NOT NULL,
    tool_input TEXT NOT NULL,
    input_hash TEXT,
    sequence_num BIGINT,
    output TEXT,
    output_hash TEXT,
    duration_ms BIGINT,
    error TEXT,
    status TEXT,
    artifacts_created TEXT,
    artifact_hashes TEXT
);

-- GDPR deletions table — matches gateway pg_schema_ddl.rs exactly (5 columns)
CREATE TABLE IF NOT EXISTS gdpr_deletions (
    id TEXT PRIMARY KEY,
    object_hash TEXT NOT NULL,
    deleted_at TEXT NOT NULL,
    deleted_by TEXT NOT NULL,
    gdpr_request_id TEXT NOT NULL
);

-- Heartbeats table — matches gateway pg_schema_ddl.rs (TIMESTAMPTZ)
CREATE TABLE IF NOT EXISTS heartbeats (
    id TEXT PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    gateway_id TEXT,
    status TEXT NOT NULL DEFAULT 'ok'
);

-- Alert configs table — matches gateway pg_schema_ddl.rs (TIMESTAMPTZ)
CREATE TABLE IF NOT EXISTS alert_configs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    webhook_url TEXT NOT NULL,
    completeness_threshold DOUBLE PRECISION NOT NULL DEFAULT 100.0,
    availability_threshold DOUBLE PRECISION NOT NULL DEFAULT 99.9,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Anomaly events table — matches gateway pg_schema_ddl.rs exactly
CREATE TABLE IF NOT EXISTS anomaly_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    turn_id TEXT NOT NULL,
    anomaly_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    description TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    resolved_at TEXT,
    metadata TEXT NOT NULL
);
