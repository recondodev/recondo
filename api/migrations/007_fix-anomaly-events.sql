-- Migration 007: Fix anomaly_events table for API usage.
--
-- Root cause: migration 001 copied anomaly_events DDL from the gateway schema
-- (anomaly_type, detected_at, TEXT metadata, no project_id/score/resolution_note,
-- TEXT PK with no default, NOT NULL session_id/turn_id). The API code was written
-- against the old ensureAnomalyDetectionTables() schema which had different columns.
-- When M3 removed ensure*() functions, this reconciliation migration was missing.
--
-- Also fixes alert_configs.id missing DEFAULT (monitoring.ts INSERT omits id).

-- 1. Allow id to be auto-generated (API inserts do not provide id)
ALTER TABLE anomaly_events ALTER COLUMN id SET DEFAULT gen_random_uuid()::TEXT;

-- 2. Make session_id nullable (budget-level / project-level anomalies have no session)
ALTER TABLE anomaly_events ALTER COLUMN session_id DROP NOT NULL;

-- 3. Make turn_id nullable (session-level and budget anomalies have no specific turn)
ALTER TABLE anomaly_events ALTER COLUMN turn_id DROP NOT NULL;

-- 4. Change metadata from TEXT NOT NULL to JSONB
--    API stores JSON objects and reads them back as objects (not strings)
ALTER TABLE anomaly_events ALTER COLUMN metadata DROP NOT NULL;
ALTER TABLE anomaly_events ALTER COLUMN metadata TYPE JSONB USING
    CASE WHEN metadata IS NULL OR metadata = ''
         THEN '{}'::JSONB
         ELSE metadata::JSONB
    END;
ALTER TABLE anomaly_events ALTER COLUMN metadata SET DEFAULT '{}'::JSONB;

-- 5. Add DEFAULT to detected_at so API inserts can omit it
ALTER TABLE anomaly_events ALTER COLUMN detected_at
    SET DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

-- 6. Add API-only columns that evaluate.ts, resolution.ts, and handleGetAnomalies reference
ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS score DOUBLE PRECISION;
ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS resolution_note TEXT;

CREATE INDEX IF NOT EXISTS idx_anomaly_events_project ON anomaly_events(project_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_events_created ON anomaly_events(detected_at);

-- 7. Fix alert_configs.id: monitoring.ts INSERT omits id, causing NOT NULL violation
ALTER TABLE alert_configs ALTER COLUMN id SET DEFAULT gen_random_uuid()::TEXT;
