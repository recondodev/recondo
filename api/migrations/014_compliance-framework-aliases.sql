-- Migration: 014_compliance-framework-aliases.sql
--
-- Adds short-id aliases for the seeded compliance frameworks. The
-- canonical seeds in 004_compliance.sql use the `seed-fw-<name>`
-- prefix to avoid colliding with user-supplied ids; some downstream
-- callers (and the D-C10 MCP integration suite) reference frameworks
-- by their short name (`soc2`, `iso42001`, `euai`, `nist`). Insert
-- those aliases idempotently so a control can FK to a short-id row.

INSERT INTO compliance_frameworks (id, name, subtitle, compliance_percentage, controls_met, controls_total)
VALUES
    ('soc2',     'SOC 2 Type II', 'Service Organization Control', 0, 0, 0),
    ('iso42001', 'ISO 42001',     'AI Management System',         0, 0, 0),
    ('euai',     'EU AI Act',     'European Union AI Regulation', 0, 0, 0),
    ('nist',     'NIST AI RMF',   'AI Risk Management Framework', 0, 0, 0)
ON CONFLICT (id) DO NOTHING;
