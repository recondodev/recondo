-- Migration 003: Immutability triggers and indexes.
--
-- Immutability triggers on turns + tool_calls (with GDPR bypass) from gateway DDL.
-- access_audit_log immutability trigger is in 002_api-tables.sql (not duplicated here).
-- All indexes from gateway DDL + API-layer indexes.

-- -------------------------------------------------------------------------
-- Immutability triggers (OD-024, SOC 2 PI1): turns and tool_calls
-- Sessions are intentionally excluded — they need UPDATE for counter fields.
-- -------------------------------------------------------------------------

-- W1 fix: GDPR bypass support. When SET LOCAL recondo.gdpr_bypass = 'true'
-- is called within a transaction, the immutability triggers allow UPDATE/DELETE.
CREATE OR REPLACE FUNCTION prevent_turn_mutation() RETURNS TRIGGER AS $$
BEGIN
    IF current_setting('recondo.gdpr_bypass', true) = 'true' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Turn mutation blocked: turns table is append-only (immutable, SOC 2 PI1)';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_tool_call_mutation() RETURNS TRIGGER AS $$
BEGIN
    IF current_setting('recondo.gdpr_bypass', true) = 'true' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Tool call mutation blocked: tool_calls table is append-only (immutable, SOC 2 PI1)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS turns_immutable ON turns;
CREATE TRIGGER turns_immutable
    BEFORE UPDATE OR DELETE ON turns
    FOR EACH ROW EXECUTE FUNCTION prevent_turn_mutation();

DROP TRIGGER IF EXISTS tool_calls_immutable ON tool_calls;
CREATE TRIGGER tool_calls_immutable
    BEFORE UPDATE OR DELETE ON tool_calls
    FOR EACH ROW EXECUTE FUNCTION prevent_tool_call_mutation();

-- -------------------------------------------------------------------------
-- Gateway DDL indexes
-- -------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_pg_turns_session ON turns(session_id, sequence_num);
CREATE INDEX IF NOT EXISTS idx_pg_tool_calls_turn ON tool_calls(turn_id);
CREATE INDEX IF NOT EXISTS idx_pg_sessions_account ON sessions(account_uuid);
CREATE INDEX IF NOT EXISTS idx_pg_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_pg_heartbeats_timestamp ON heartbeats(timestamp);
CREATE INDEX IF NOT EXISTS idx_pg_alert_configs_project ON alert_configs(project_id);
CREATE INDEX IF NOT EXISTS idx_pg_anomaly_events_session ON anomaly_events(session_id);

-- -------------------------------------------------------------------------
-- API-layer indexes
-- -------------------------------------------------------------------------

-- Sessions
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider);
CREATE INDEX IF NOT EXISTS idx_sessions_ended_at ON sessions(ended_at);
CREATE INDEX IF NOT EXISTS idx_sessions_framework ON sessions(framework);

-- Turns (idx_turns_session_id omitted: composite idx_pg_turns_session on (session_id, sequence_num) already covers session_id lookups)
CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON turns(timestamp);

-- GIN index on search_vector (conditional: only if column exists)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'turns' AND column_name = 'search_vector'
    ) THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_turns_search_vector ON turns USING GIN (search_vector)';
    END IF;
END;
$$;

-- Tool calls (idx_tool_calls_turn_id omitted: identical to idx_pg_tool_calls_turn above)

-- Usage aggregates
CREATE INDEX IF NOT EXISTS idx_usage_aggregates_project_period
    ON usage_aggregates(project_id, period, period_start);
