-- Migration 010: Materialized views for usage analytics + session_risk.project_id.
--
-- Adds:
--   1. session_risk.project_id  — ISO 42001 evidence export needs project-scoped queries
--   2. mv_usage_hourly          — token/cost aggregates by project+model per hour
--   3. mv_usage_daily           — token/cost/cache aggregates by project+agent+model+provider per day
--   4. mv_usage_weekly          — cost/token aggregates by project per week
--   5. mv_usage_monthly         — cost/token aggregates by project per month
--   6. mv_tool_usage            — tool call stats by project+tool+agent per day
--
-- Note: turns.timestamp is stored as TEXT (ISO 8601 + Z suffix); ::timestamptz
-- casts are required for date_trunc() and temporal operations (B1 contract).

-- -------------------------------------------------------------------------
-- 1. session_risk.project_id
-- -------------------------------------------------------------------------
ALTER TABLE session_risk ADD COLUMN IF NOT EXISTS project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_session_risk_project ON session_risk(project_id);

-- -------------------------------------------------------------------------
-- 2. mv_usage_hourly
-- -------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_usage_hourly AS
SELECT
    s.project_id,
    t.model,
    date_trunc('hour', t.timestamp::timestamptz) AS period_start,
    COUNT(DISTINCT t.session_id)                 AS session_count,
    COUNT(t.id)                                  AS turn_count,
    SUM(t.input_tokens)                          AS total_input_tokens,
    SUM(t.output_tokens)                         AS total_output_tokens,
    SUM(t.cost_usd)                              AS total_cost_usd,
    AVG(t.duration_ms)                           AS avg_latency_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY t.duration_ms) AS latency_p95
FROM turns t
JOIN sessions s ON t.session_id = s.id
WHERE t.timestamp::timestamptz >= NOW() - INTERVAL '7 days'
GROUP BY s.project_id, t.model, date_trunc('hour', t.timestamp::timestamptz)
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_usage_hourly_pk
    ON mv_usage_hourly (project_id, model, period_start);

-- -------------------------------------------------------------------------
-- 3. mv_usage_daily
-- -------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_usage_daily AS
SELECT
    s.project_id,
    COALESCE(s.agent_id, '')                     AS agent_id,
    t.model,
    t.provider,
    date_trunc('day', t.timestamp::timestamptz)  AS period_start,
    COUNT(DISTINCT t.session_id)                 AS session_count,
    COUNT(t.id)                                  AS turn_count,
    SUM(t.input_tokens)                          AS total_input_tokens,
    SUM(t.output_tokens)                         AS total_output_tokens,
    SUM(COALESCE(t.cache_read_tokens, 0) + COALESCE(t.cache_creation_tokens, 0)) AS total_cache_tokens,
    SUM(t.cost_usd)                              AS total_cost_usd,
    AVG(t.duration_ms)                           AS avg_latency_ms
FROM turns t
JOIN sessions s ON t.session_id = s.id
GROUP BY s.project_id, COALESCE(s.agent_id, ''), t.model, t.provider,
         date_trunc('day', t.timestamp::timestamptz)
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_usage_daily_pk
    ON mv_usage_daily (project_id, agent_id, model, provider, period_start);

-- -------------------------------------------------------------------------
-- 4. mv_usage_weekly
-- -------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_usage_weekly AS
SELECT
    s.project_id,
    date_trunc('week', t.timestamp::timestamptz) AS period_start,
    SUM(t.cost_usd)                              AS total_cost_usd,
    SUM(t.input_tokens + t.output_tokens)        AS total_tokens,
    COUNT(DISTINCT t.session_id)                 AS session_count
FROM turns t
JOIN sessions s ON t.session_id = s.id
GROUP BY s.project_id, date_trunc('week', t.timestamp::timestamptz)
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_usage_weekly_pk
    ON mv_usage_weekly (project_id, period_start);

-- -------------------------------------------------------------------------
-- 5. mv_usage_monthly
-- -------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_usage_monthly AS
SELECT
    s.project_id,
    date_trunc('month', t.timestamp::timestamptz) AS period_start,
    SUM(t.cost_usd)                               AS total_cost_usd,
    SUM(t.input_tokens + t.output_tokens)         AS total_tokens,
    COUNT(DISTINCT t.session_id)                  AS session_count
FROM turns t
JOIN sessions s ON t.session_id = s.id
GROUP BY s.project_id, date_trunc('month', t.timestamp::timestamptz)
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_usage_monthly_pk
    ON mv_usage_monthly (project_id, period_start);

-- -------------------------------------------------------------------------
-- 6. mv_tool_usage
-- -------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_tool_usage AS
SELECT
    s.project_id,
    tc.tool_name,
    COALESCE(s.agent_id, '')                     AS agent_id,
    date_trunc('day', t.timestamp::timestamptz)  AS period_start,
    COUNT(tc.id)                                 AS call_count,
    COUNT(DISTINCT t.session_id)                 AS session_count,
    AVG(tc.duration_ms)                          AS avg_duration_ms,
    AVG(CASE WHEN tc.status = 'success' THEN 1.0 ELSE 0.0 END) AS success_rate
FROM tool_calls tc
JOIN turns t ON tc.turn_id = t.id
JOIN sessions s ON t.session_id = s.id
GROUP BY s.project_id, tc.tool_name, COALESCE(s.agent_id, ''),
         date_trunc('day', t.timestamp::timestamptz)
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_tool_usage_pk
    ON mv_tool_usage (project_id, tool_name, agent_id, period_start);
