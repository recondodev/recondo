-- Migration 005: D6 tables — reports, policies, registered keys.
--
-- Creates:
--   reports            - Compliance report records
--   report_coverage    - Coverage trend data points (FK to reports)
--   policies           - Governance policy definitions
--   policy_triggers    - Policy trigger history (FK CASCADE to policies)
--   registered_keys    - Registered LLM API keys (UNIQUE fingerprint)
--
-- All tables include project_id for multi-tenant scoping.

-- Reports table
CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    framework TEXT NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    capture_count INT NOT NULL DEFAULT 0,
    findings_critical INT NOT NULL DEFAULT 0,
    findings_high INT NOT NULL DEFAULT 0,
    findings_medium INT NOT NULL DEFAULT 0,
    findings_low INT NOT NULL DEFAULT 0,
    hash TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reports_generated_at ON reports(generated_at);
CREATE INDEX IF NOT EXISTS idx_reports_project_id ON reports(project_id);

-- Report coverage trend data points
CREATE TABLE IF NOT EXISTS report_coverage (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    report_id TEXT REFERENCES reports(id),
    label TEXT NOT NULL,
    value DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Policies table
CREATE TABLE IF NOT EXISTS policies (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    scope TEXT NOT NULL,
    action TEXT NOT NULL,
    triggers_mtd INT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_policies_created_at ON policies(created_at);
CREATE INDEX IF NOT EXISTS idx_policies_project_id ON policies(project_id);

-- Policy triggers history (CASCADE delete when policy is deleted)
CREATE TABLE IF NOT EXISTS policy_triggers (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    details TEXT
);

CREATE INDEX IF NOT EXISTS idx_policy_triggers_triggered_at ON policy_triggers(triggered_at);

-- Registered LLM API keys (UNIQUE fingerprint)
CREATE TABLE IF NOT EXISTS registered_keys (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT 'default',
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    agent_count INT NOT NULL DEFAULT 0,
    last_used TIMESTAMPTZ,
    monthly_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_registered_keys_fingerprint ON registered_keys(fingerprint);
CREATE INDEX IF NOT EXISTS idx_registered_keys_project_id ON registered_keys(project_id);
