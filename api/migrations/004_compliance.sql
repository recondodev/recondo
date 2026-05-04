-- Migration 004: Compliance tables + seed data.
--
-- Creates:
--   compliance_frameworks  - Compliance framework definitions
--   compliance_controls    - Individual controls within frameworks
--   compliance_audit_log   - Append-only audit log for control status changes
--
-- Seeds 4 frameworks with 7 controls each (ON CONFLICT DO NOTHING for idempotency):
--   SOC 2 Type II, ISO 42001, EU AI Act, NIST AI RMF

-- Compliance frameworks table
CREATE TABLE IF NOT EXISTS compliance_frameworks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    subtitle TEXT,
    compliance_percentage INT NOT NULL DEFAULT 0,
    controls_met INT NOT NULL DEFAULT 0,
    controls_total INT NOT NULL DEFAULT 0,
    last_assessed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Compliance controls table
CREATE TABLE IF NOT EXISTS compliance_controls (
    id TEXT PRIMARY KEY,
    framework_id TEXT NOT NULL REFERENCES compliance_frameworks(id),
    control_id TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PLANNED',
    evidence TEXT,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Compliance audit log table
-- control_id intentionally has no FK to compliance_controls. Audit log entries
-- must survive control deletion for compliance trail preservation.
CREATE TABLE IF NOT EXISTS compliance_audit_log (
    id TEXT PRIMARY KEY,
    control_id TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT NOT NULL,
    changed_by TEXT,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_compliance_controls_framework ON compliance_controls(framework_id);
CREATE INDEX IF NOT EXISTS idx_compliance_audit_log_control ON compliance_audit_log(control_id);
CREATE INDEX IF NOT EXISTS idx_compliance_audit_log_changed_at ON compliance_audit_log(changed_at);

-- Seed data: 4 frameworks with 7 controls each
-- SOC 2 Type II
INSERT INTO compliance_frameworks (id, name, subtitle, compliance_percentage, controls_met, controls_total)
VALUES ('seed-fw-soc2', 'SOC 2 Type II', 'Service Organization Control', 0, 0, 7)
ON CONFLICT (id) DO NOTHING;

INSERT INTO compliance_controls (id, framework_id, control_id, description, status) VALUES
    ('seed-ctrl-soc2-1', 'seed-fw-soc2', 'CC6.1', 'Logical and physical access controls', 'PLANNED'),
    ('seed-ctrl-soc2-2', 'seed-fw-soc2', 'CC6.2', 'System operations monitoring', 'PLANNED'),
    ('seed-ctrl-soc2-3', 'seed-fw-soc2', 'CC6.3', 'Change management procedures', 'PLANNED'),
    ('seed-ctrl-soc2-4', 'seed-fw-soc2', 'CC7.1', 'System availability monitoring', 'PLANNED'),
    ('seed-ctrl-soc2-5', 'seed-fw-soc2', 'CC7.2', 'Incident response procedures', 'PLANNED'),
    ('seed-ctrl-soc2-6', 'seed-fw-soc2', 'CC8.1', 'Processing integrity controls', 'PLANNED'),
    ('seed-ctrl-soc2-7', 'seed-fw-soc2', 'CC9.1', 'Confidentiality controls', 'PLANNED')
ON CONFLICT (id) DO NOTHING;

-- ISO 42001
INSERT INTO compliance_frameworks (id, name, subtitle, compliance_percentage, controls_met, controls_total)
VALUES ('seed-fw-iso42001', 'ISO 42001', 'AI Management System', 0, 0, 7)
ON CONFLICT (id) DO NOTHING;

INSERT INTO compliance_controls (id, framework_id, control_id, description, status) VALUES
    ('seed-ctrl-iso-1', 'seed-fw-iso42001', '6.1.1', 'AI risk assessment', 'PLANNED'),
    ('seed-ctrl-iso-2', 'seed-fw-iso42001', '6.1.2', 'AI impact assessment', 'PLANNED'),
    ('seed-ctrl-iso-3', 'seed-fw-iso42001', '6.2.1', 'AI system lifecycle management', 'PLANNED'),
    ('seed-ctrl-iso-4', 'seed-fw-iso42001', '7.1.1', 'Competence and awareness', 'PLANNED'),
    ('seed-ctrl-iso-5', 'seed-fw-iso42001', '7.2.1', 'Documented information', 'PLANNED'),
    ('seed-ctrl-iso-6', 'seed-fw-iso42001', '8.1.1', 'Operational planning and control', 'PLANNED'),
    ('seed-ctrl-iso-7', 'seed-fw-iso42001', '9.1.1', 'Performance evaluation', 'PLANNED')
ON CONFLICT (id) DO NOTHING;

-- EU AI Act
INSERT INTO compliance_frameworks (id, name, subtitle, compliance_percentage, controls_met, controls_total)
VALUES ('seed-fw-euai', 'EU AI Act', 'European Union AI Regulation', 0, 0, 7)
ON CONFLICT (id) DO NOTHING;

INSERT INTO compliance_controls (id, framework_id, control_id, description, status) VALUES
    ('seed-ctrl-euai-1', 'seed-fw-euai', 'Art.9', 'Risk management system', 'PLANNED'),
    ('seed-ctrl-euai-2', 'seed-fw-euai', 'Art.10', 'Data governance', 'PLANNED'),
    ('seed-ctrl-euai-3', 'seed-fw-euai', 'Art.11', 'Technical documentation', 'PLANNED'),
    ('seed-ctrl-euai-4', 'seed-fw-euai', 'Art.12', 'Record-keeping', 'PLANNED'),
    ('seed-ctrl-euai-5', 'seed-fw-euai', 'Art.13', 'Transparency and information', 'PLANNED'),
    ('seed-ctrl-euai-6', 'seed-fw-euai', 'Art.14', 'Human oversight', 'PLANNED'),
    ('seed-ctrl-euai-7', 'seed-fw-euai', 'Art.15', 'Accuracy, robustness, cybersecurity', 'PLANNED')
ON CONFLICT (id) DO NOTHING;

-- NIST AI RMF
INSERT INTO compliance_frameworks (id, name, subtitle, compliance_percentage, controls_met, controls_total)
VALUES ('seed-fw-nist', 'NIST AI RMF', 'AI Risk Management Framework', 0, 0, 7)
ON CONFLICT (id) DO NOTHING;

INSERT INTO compliance_controls (id, framework_id, control_id, description, status) VALUES
    ('seed-ctrl-nist-1', 'seed-fw-nist', 'GOVERN-1', 'AI governance policies', 'PLANNED'),
    ('seed-ctrl-nist-2', 'seed-fw-nist', 'GOVERN-2', 'Accountability structures', 'PLANNED'),
    ('seed-ctrl-nist-3', 'seed-fw-nist', 'MAP-1', 'AI system context mapping', 'PLANNED'),
    ('seed-ctrl-nist-4', 'seed-fw-nist', 'MAP-2', 'Stakeholder identification', 'PLANNED'),
    ('seed-ctrl-nist-5', 'seed-fw-nist', 'MEASURE-1', 'Risk measurement', 'PLANNED'),
    ('seed-ctrl-nist-6', 'seed-fw-nist', 'MEASURE-2', 'Testing and evaluation', 'PLANNED'),
    ('seed-ctrl-nist-7', 'seed-fw-nist', 'MANAGE-1', 'Risk response and mitigation', 'PLANNED')
ON CONFLICT (id) DO NOTHING;
