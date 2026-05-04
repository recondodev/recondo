-- Migration 006: Runtime tables.
--
-- Tables previously created by ensure*() functions at startup.
-- Now defined here as the single source of truth.
--
-- Sources:
--   agent_baselines   - from api/src/anomaly-detection/baselines.ts ensureAnomalyDetectionTables()
--   session_risk      - from api/src/risk/classification.ts ensureSessionRiskTable()
--   export_schedules  - from api/src/exports/schedules.ts ensureExportSchedulesTables()

-- Agent baselines table (anomaly detection)
CREATE TABLE IF NOT EXISTS agent_baselines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id TEXT NOT NULL,
    agent_id TEXT,
    model TEXT,
    baseline_date DATE NOT NULL,
    avg_tokens_per_turn DOUBLE PRECISION DEFAULT 0,
    avg_cost_per_session DOUBLE PRECISION DEFAULT 0,
    avg_turns_per_session DOUBLE PRECISION DEFAULT 0,
    avg_session_duration_ms DOUBLE PRECISION DEFAULT 0,
    tool_usage_distribution JSONB,
    session_count INT DEFAULT 0,
    turn_count INT DEFAULT 0,
    computed_at TIMESTAMPTZ DEFAULT now(),
    stddev_cost_per_session DOUBLE PRECISION DEFAULT 0,
    stddev_tokens_per_turn DOUBLE PRECISION DEFAULT 0,
    stddev_latency_ms DOUBLE PRECISION DEFAULT 0,
    avg_latency_ms DOUBLE PRECISION DEFAULT 0
);

-- Ensure avg_latency_ms column exists for older tables
ALTER TABLE agent_baselines ADD COLUMN IF NOT EXISTS avg_latency_ms DOUBLE PRECISION DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_agent_baselines_project ON agent_baselines(project_id);

-- Session risk table
-- session_risk.session_id intentionally has no FK to sessions — risk classification
-- may run before or after the session record is committed.
CREATE TABLE IF NOT EXISTS session_risk (
    session_id TEXT PRIMARY KEY,
    risk_level TEXT NOT NULL,
    intent TEXT,
    classified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Export schedules table
CREATE TABLE IF NOT EXISTS export_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id TEXT NOT NULL,
    export_type TEXT NOT NULL,
    frequency TEXT NOT NULL,
    delivery_method TEXT NOT NULL DEFAULT 'api',
    last_run_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_export_schedules_project ON export_schedules(project_id);
CREATE INDEX IF NOT EXISTS idx_export_schedules_next_run ON export_schedules(next_run_at);
