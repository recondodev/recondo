-- Migration 002: API-only tables.
--
-- Tables created here are used by the API layer only (not by the gateway).
-- All use CREATE TABLE IF NOT EXISTS for idempotency.

-- Projects table (UUID PK, multi-tenant registry)
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API keys table (UNIQUE key_hash, FK to projects)
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash TEXT NOT NULL UNIQUE,
    project_id UUID REFERENCES projects(id),
    rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);

-- Access audit log (SOC 2 CC6, append-only)
CREATE TABLE IF NOT EXISTS access_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    api_key_id TEXT NOT NULL,
    user_id TEXT,
    query_type TEXT NOT NULL,
    resource_ids TEXT[],
    source_ip TEXT,
    user_agent TEXT,
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

-- Usage aggregates table (composite UNIQUE, NOT NULL DEFAULT '' on group-by columns)
-- B4 fix: team_id, developer_id, agent_id use NOT NULL DEFAULT '' instead of nullable
-- because PostgreSQL treats each NULL as distinct in UNIQUE constraints.
-- Composite UNIQUE on usage_aggregates covers project_id-leading queries.
-- Separate indexes for model/provider/period deferred until query patterns recondo it.
CREATE TABLE IF NOT EXISTS usage_aggregates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id TEXT NOT NULL,
    team_id TEXT NOT NULL DEFAULT '',
    developer_id TEXT NOT NULL DEFAULT '',
    agent_id TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    period TEXT NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,

    -- Token metrics
    total_input_tokens BIGINT NOT NULL DEFAULT 0,
    total_output_tokens BIGINT NOT NULL DEFAULT 0,
    total_cache_tokens BIGINT NOT NULL DEFAULT 0,
    total_tokens BIGINT NOT NULL DEFAULT 0,

    -- Cost metrics
    total_cost_usd NUMERIC(12,4) NOT NULL DEFAULT 0,
    avg_cost_per_session NUMERIC(12,4) NOT NULL DEFAULT 0,
    avg_cost_per_turn NUMERIC(12,4) NOT NULL DEFAULT 0,

    -- Session metrics
    session_count INTEGER NOT NULL DEFAULT 0,
    avg_turns_per_session NUMERIC(8,2) NOT NULL DEFAULT 0,
    completion_rate NUMERIC(5,4) NOT NULL DEFAULT 0,

    -- Tool metrics
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    unique_tools_used INTEGER NOT NULL DEFAULT 0,
    tool_success_rate NUMERIC(5,4) NOT NULL DEFAULT 0,
    avg_tool_latency_ms NUMERIC(10,2) NOT NULL DEFAULT 0,

    -- Latency metrics
    avg_latency_ms NUMERIC(10,2) NOT NULL DEFAULT 0,
    latency_p50 NUMERIC(10,2) NOT NULL DEFAULT 0,
    latency_p95 NUMERIC(10,2) NOT NULL DEFAULT 0,

    UNIQUE(project_id, team_id, developer_id, agent_id, model, provider, period, period_start)
);
