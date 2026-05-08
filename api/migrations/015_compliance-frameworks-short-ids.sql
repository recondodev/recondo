-- Migration: 015_compliance-frameworks-short-ids.sql
--
-- Canonicalize seeded compliance framework IDs from `seed-fw-<name>` to
-- the public short IDs (`soc2`, `iso42001`, `euai`, `nist`) without
-- leaving duplicate alias rows behind.

INSERT INTO compliance_frameworks (
  id,
  name,
  subtitle,
  compliance_percentage,
  controls_met,
  controls_total,
  last_assessed_at,
  created_at
)
SELECT
  SUBSTRING(id FROM 9),
  name,
  subtitle,
  compliance_percentage,
  controls_met,
  controls_total,
  last_assessed_at,
  created_at
FROM compliance_frameworks
WHERE id LIKE 'seed-fw-%'
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  subtitle = EXCLUDED.subtitle,
  compliance_percentage = EXCLUDED.compliance_percentage,
  controls_met = EXCLUDED.controls_met,
  controls_total = EXCLUDED.controls_total,
  last_assessed_at = EXCLUDED.last_assessed_at;

UPDATE compliance_controls
SET framework_id = SUBSTRING(framework_id FROM 9)
WHERE framework_id LIKE 'seed-fw-%';

DELETE FROM compliance_frameworks
WHERE id LIKE 'seed-fw-%';
