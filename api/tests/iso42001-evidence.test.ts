/**
 * Sprint 10 Deliverable 1: ISO 42001 Clause-by-Clause Evidence Export
 *
 * Tests for POST /v1/exports/iso42001/evidence endpoint.
 *
 * Enhanced ISO 42001 export with per-clause evidence:
 * - Cl.6.1: Risk Assessment — riskClassifications, classificationHistory
 * - Cl.8.4: AI Impact Assessment — agentCount, assessments per agent
 * - Cl.8.5: AI System Lifecycle — totalSessions, sessionsByModel, dateRange
 * - Cl.9.1: Monitoring — anomalyCount, anomalyByType, driftEventCount
 * - Cl.9.3: Management Review — governanceCoverage, compliancePosture
 * - Cl.10: Continual Improvement — anomaly resolution chain
 *
 * Auth required, project scoped, audit logged.
 *
 * These tests WILL FAIL until the implementation agent builds the endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupDatabase,
  teardownDatabase,
  getPool,
  API_KEYS,
  IDS,
  API_BASE_URL,
  countAuditLogs,
} from "./setup.js";

// ---------------------------------------------------------------------------
// Test API keys
// ---------------------------------------------------------------------------

const TEST_KEYS = {
  foundation: "wrt_test_iso_ev_foundation_01",
  compliance: "wrt_test_iso_ev_compliance_02",
} as const;

const TEST_KEY_IDS = {
  foundation: "bb500000-0000-4000-8000-000000000001",
  compliance: "bb500000-0000-4000-8000-000000000002",
} as const;

// ---------------------------------------------------------------------------
// SHA-256 helper
// ---------------------------------------------------------------------------

async function sha256(input: string): Promise<string> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function postJSON(
  path: string,
  body: Record<string, unknown>,
  apiKey?: string
): Promise<{ body: Record<string, unknown>; response: Response }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const responseBody = (await response.json()) as Record<string, unknown>;
  return { body: responseBody, response };
}

// ---------------------------------------------------------------------------
// Fixtures: session_risk entries, anomalies with resolution, SUPERSEDES chains
// ---------------------------------------------------------------------------

async function seedIso42001EvidenceFixtures(): Promise<void> {
  const p = getPool();

  // Insert test API keys
  const hashFoundation = await sha256(TEST_KEYS.foundation);
  const hashCompliance = await sha256(TEST_KEYS.compliance);

  await p.query(`
    INSERT INTO api_keys (id, key_hash, project_id, rate_limit_rpm) VALUES
      ('${TEST_KEY_IDS.foundation}', '${hashFoundation}', '${IDS.projectAlpha}', 60),
      ('${TEST_KEY_IDS.compliance}', '${hashCompliance}', '${IDS.projectAlpha}', 120)
    ON CONFLICT (id) DO NOTHING;
  `);

  // Ensure session_risk table exists (Sprint 9 addition)
  await p.query(`
    CREATE TABLE IF NOT EXISTS session_risk (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id      TEXT NOT NULL REFERENCES sessions(id),
      risk_level      TEXT NOT NULL,
      classified_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      project_id      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_session_risk_project ON session_risk (project_id);
    CREATE INDEX IF NOT EXISTS idx_session_risk_session ON session_risk (session_id);
  `);

  // Seed risk classifications for alpha project sessions
  await p.query(`
    INSERT INTO session_risk (session_id, risk_level, project_id) VALUES
      ('${IDS.sessionAlpha1}', 'high', '${IDS.projectAlpha}'),
      ('${IDS.sessionAlpha2}', 'low', '${IDS.projectAlpha}')
    ON CONFLICT DO NOTHING;
  `);

  // Ensure anomaly_events has resolution columns
  await p.query(`
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS resolution_note TEXT;
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS score DOUBLE PRECISION;
  `);

  // Update anomaly_events with project_id
  await p.query(`
    UPDATE anomaly_events SET project_id = (
      SELECT s.project_id FROM sessions s WHERE s.id = anomaly_events.session_id
    ) WHERE project_id IS NULL AND session_id IS NOT NULL
  `);

  // Seed additional anomaly events with different types for clause 9.1
  const now = new Date();
  await p.query(`
    INSERT INTO anomaly_events (id, session_id, anomaly_type, severity, description, project_id, detected_at) VALUES
      ('ff500000-0000-4000-8000-000000000001', '${IDS.sessionAlpha1}', 'system_prompt_drift', 'warning', 'System prompt changed unexpectedly', '${IDS.projectAlpha}', $1),
      ('ff500000-0000-4000-8000-000000000002', '${IDS.sessionAlpha1}', 'tool_definition_drift', 'info', 'Tool definition changed', '${IDS.projectAlpha}', $1),
      ('ff500000-0000-4000-8000-000000000003', '${IDS.sessionAlpha2}', 'cost_spike', 'warning', 'Unusual cost spike detected', '${IDS.projectAlpha}', $1)
    ON CONFLICT DO NOTHING;
  `, [now.toISOString()]);

  // Resolve one anomaly to test resolution chain (cl.10)
  await p.query(`
    UPDATE anomaly_events SET resolved_at = $1, resolution_note = 'Investigated and confirmed safe'
    WHERE id = 'ff500000-0000-4000-8000-000000000001'
  `, [now.toISOString()]);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedIso42001EvidenceFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// POST /v1/exports/iso42001/evidence — Top-level structure
// =========================================================================

describe("POST /v1/exports/iso42001/evidence — top-level structure", () => {
  it("returns standard, generatedAt, projectId, and clauses object", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/iso42001/evidence",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body.standard).toBe("ISO/IEC 42001:2023");
    expect(body.generatedAt).toBeDefined();
    expect(typeof body.generatedAt).toBe("string");
    expect(body.projectId).toBe(IDS.projectAlpha);
    expect(body.clauses).toBeDefined();
    expect(typeof body.clauses).toBe("object");
  });

  it("returns all 6 clause keys", async () => {
    const { body } = await postJSON(
      "/v1/exports/iso42001/evidence",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const clauses = body.clauses as Record<string, unknown>;
    expect(clauses).toHaveProperty("cl_6_1");
    expect(clauses).toHaveProperty("cl_8_4");
    expect(clauses).toHaveProperty("cl_8_5");
    expect(clauses).toHaveProperty("cl_9_1");
    expect(clauses).toHaveProperty("cl_9_3");
    expect(clauses).toHaveProperty("cl_10");
  });

  it("each clause has title, status, and evidence fields", async () => {
    const { body } = await postJSON(
      "/v1/exports/iso42001/evidence",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const clauses = body.clauses as Record<string, Record<string, unknown>>;
    for (const clauseKey of ["cl_6_1", "cl_8_4", "cl_8_5", "cl_9_1", "cl_9_3", "cl_10"]) {
      const clause = clauses[clauseKey];
      expect(clause.title).toBeDefined();
      expect(typeof clause.title).toBe("string");
      expect(clause.status).toBeDefined();
      expect(clause.evidence).toBeDefined();
      expect(typeof clause.evidence).toBe("object");
    }
  });
});

// =========================================================================
// Cl.6.1: Risk Assessment
// =========================================================================

describe("POST /v1/exports/iso42001/evidence — Cl.6.1 Risk Assessment", () => {
  it("cl_6_1 title is 'Risk Assessment'", async () => {
    const { body } = await postJSON(
      "/v1/exports/iso42001/evidence",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const clauses = body.clauses as Record<string, Record<string, unknown>>;
    expect(clauses.cl_6_1.title).toBe("Risk Assessment");
  });

  it("cl_6_1 evidence has riskClassifications with all 4 levels", async () => {
    const { body } = await postJSON(
      "/v1/exports/iso42001/evidence",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const clauses = body.clauses as Record<string, Record<string, unknown>>;
    const evidence = clauses.cl_6_1.evidence as Record<string, unknown>;
    expect(evidence.riskClassifications).toBeDefined();

    const rc = evidence.riskClassifications as Record<string, number>;
    expect(rc).toHaveProperty("low");
    expect(rc).toHaveProperty("medium");
    expect(rc).toHaveProperty("high");
    expect(rc).toHaveProperty("critical");
    expect(typeof rc.low).toBe("number");
    expect(typeof rc.medium).toBe("number");
    expect(typeof rc.high).toBe("number");
    expect(typeof rc.critical).toBe("number");
  });

  it("cl_6_1 evidence has classificationHistory array", async () => {
    const { body } = await postJSON(
      "/v1/exports/iso42001/evidence",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const clauses = body.clauses as Record<string, Record<string, unknown>>;
    const evidence = clauses.cl_6_1.evidence as Record<string, unknown>;
    const history = evidence.classificationHistory as Array<Record<string, unknown>>;
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBeGreaterThanOrEqual(1);

    // Each entry has sessionId, intent, riskLevel, classifiedAt
    const entry = history[0];
    expect(entry).toHaveProperty("sessionId");
    expect(entry).toHaveProperty("riskLevel");
    expect(entry).toHaveProperty("classifiedAt");
  });
});

// =========================================================================
// Cl.8.4: AI Impact Assessment
// =========================================================================

describe("POST /v1/exports/iso42001/evidence — Cl.8.4 AI Impact Assessment", () => {
  it("cl_8_4 title is 'AI Impact Assessment'", async () => {
    const { body } = await postJSON(
      "/v1/exports/iso42001/evidence",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const clauses = body.clauses as Record<string, Record<string, unknown>>;
    expect(clauses.cl_8_4.title).toBe("AI Impact Assessment");
  });

  it("cl_8_4 evidence has agentCount and assessments array", async () => {
    const { body } = await postJSON(
      "/v1/exports/iso42001/evidence",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const clauses = body.clauses as Record<string, Record<string, unknown>>;
    const evidence = clauses.cl_8_4.evidence as Record<string, unknown>;
    expect(typeof evidence.agentCount).toBe("number");
    expect(evidence.agentCount).toBeGreaterThanOrEqual(1);

    const assessments = evidence.assessments as Array<Record<string, unknown>>;
    expect(Array.isArray(assessments)).toBe(true);
    expect(assessments.length).toBeGreaterThanOrEqual(1);

    // Each assessment has agentId, sessionCount, turnCount, anomalyCount
    const a = assessments[0];
    expect(a).toHaveProperty("agentId");
    expect(a).toHaveProperty("sessionCount");
    expect(a).toHaveProperty("turnCount");
    expect(a).toHaveProperty("anomalyCount");
    expect(typeof a.sessionCount).toBe("number");
    expect(typeof a.turnCount).toBe("number");
  });
});

// =========================================================================
// Cl.8.5: AI System Lifecycle
// =========================================================================

describe("POST /v1/exports/iso42001/evidence — Cl.8.5 AI System Lifecycle", () => {
  it("cl_8_5 evidence has totalSessions, sessionsByModel, dateRange", async () => {
    const { body } = await postJSON(
      "/v1/exports/iso42001/evidence",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const clauses = body.clauses as Record<string, Record<string, unknown>>;
    expect(clauses.cl_8_5.title).toBe("AI System Lifecycle");

    const evidence = clauses.cl_8_5.evidence as Record<string, unknown>;
    expect(typeof evidence.totalSessions).toBe("number");
    expect(evidence.totalSessions).toBeGreaterThanOrEqual(1);

    const sbm = evidence.sessionsByModel as Array<Record<string, unknown>>;
    expect(Array.isArray(sbm)).toBe(true);
    expect(sbm.length).toBeGreaterThanOrEqual(1);

    // Each entry has model and count
    const entry = sbm[0];
    expect(entry).toHaveProperty("model");
    expect(entry).toHaveProperty("count");
    expect(typeof entry.count).toBe("number");

    const dr = evidence.dateRange as Record<string, string>;
    expect(dr).toHaveProperty("earliest");
    expect(dr).toHaveProperty("latest");
    expect(typeof dr.earliest).toBe("string");
    expect(typeof dr.latest).toBe("string");
  });
});

// =========================================================================
// Cl.9.1: Monitoring
// =========================================================================

describe("POST /v1/exports/iso42001/evidence — Cl.9.1 Monitoring", () => {
  it("cl_9_1 evidence has anomalyCount, anomalyByType, driftEventCount, monitoringActive", async () => {
    const { body } = await postJSON(
      "/v1/exports/iso42001/evidence",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const clauses = body.clauses as Record<string, Record<string, unknown>>;
    expect(clauses.cl_9_1.title).toBe("Monitoring");

    const evidence = clauses.cl_9_1.evidence as Record<string, unknown>;
    expect(typeof evidence.anomalyCount).toBe("number");
    expect(typeof evidence.driftEventCount).toBe("number");
    expect(evidence.monitoringActive).toBe(true);

    const abt = evidence.anomalyByType as Record<string, number>;
    expect(typeof abt).toBe("object");
    // Should have at least the types we seeded
    const allKeys = Object.keys(abt);
    expect(allKeys.length).toBeGreaterThanOrEqual(1);
  });

  it("cl_9_1 anomalyByType includes known anomaly types from seeded data", async () => {
    const { body } = await postJSON(
      "/v1/exports/iso42001/evidence",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const clauses = body.clauses as Record<string, Record<string, unknown>>;
    const evidence = clauses.cl_9_1.evidence as Record<string, unknown>;
    const abt = evidence.anomalyByType as Record<string, number>;

    // We seeded system_prompt_drift, tool_definition_drift, cost_spike
    // At least some of these should appear
    const knownTypes = ["system_prompt_drift", "tool_definition_drift", "cost_spike", "hash_mismatch"];
    const foundTypes = knownTypes.filter((t) => t in abt);
    expect(foundTypes.length).toBeGreaterThanOrEqual(1);
  });
});

// =========================================================================
// Cl.9.3: Management Review
// =========================================================================

describe("POST /v1/exports/iso42001/evidence — Cl.9.3 Management Review", () => {
  it("cl_9_3 evidence has governanceCoverage and compliancePosture", async () => {
    const { body } = await postJSON(
      "/v1/exports/iso42001/evidence",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const clauses = body.clauses as Record<string, Record<string, unknown>>;
    expect(clauses.cl_9_3.title).toBe("Management Review");

    const evidence = clauses.cl_9_3.evidence as Record<string, unknown>;
    const gc = evidence.governanceCoverage as Record<string, number>;
    expect(gc).toHaveProperty("sessions");
    expect(gc).toHaveProperty("decisions");
    expect(gc).toHaveProperty("artifacts");
    expect(typeof gc.sessions).toBe("number");

    const cp = evidence.compliancePosture as Record<string, unknown>;
    expect(cp).toHaveProperty("soc2Completeness");
    expect(cp).toHaveProperty("evidenceFreshness");
    expect(typeof cp.soc2Completeness).toBe("number");
  });
});

// =========================================================================
// Cl.10: Continual Improvement
// =========================================================================

describe("POST /v1/exports/iso42001/evidence — Cl.10 Continual Improvement", () => {
  it("cl_10 evidence has totalAnomalies, resolvedAnomalies, resolutionRate, resolutionChain", async () => {
    const { body } = await postJSON(
      "/v1/exports/iso42001/evidence",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const clauses = body.clauses as Record<string, Record<string, unknown>>;
    expect(clauses.cl_10.title).toBe("Continual Improvement");

    const evidence = clauses.cl_10.evidence as Record<string, unknown>;
    expect(typeof evidence.totalAnomalies).toBe("number");
    expect(typeof evidence.resolvedAnomalies).toBe("number");
    expect(typeof evidence.resolutionRate).toBe("number");

    const chain = evidence.resolutionChain as Array<Record<string, unknown>>;
    expect(Array.isArray(chain)).toBe(true);
  });

  it("cl_10 resolutionChain entries have expected fields", async () => {
    const { body } = await postJSON(
      "/v1/exports/iso42001/evidence",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const clauses = body.clauses as Record<string, Record<string, unknown>>;
    const evidence = clauses.cl_10.evidence as Record<string, unknown>;
    const chain = evidence.resolutionChain as Array<Record<string, unknown>>;

    // We resolved one anomaly in fixtures, so chain should have at least 1 entry
    expect(chain.length).toBeGreaterThanOrEqual(1);
    const entry = chain[0];
    expect(entry).toHaveProperty("anomalyId");
    expect(entry).toHaveProperty("type");
    expect(entry).toHaveProperty("detectedAt");
    expect(entry).toHaveProperty("resolvedAt");
  });

  it("cl_10 resolutionRate is between 0 and 100", async () => {
    const { body } = await postJSON(
      "/v1/exports/iso42001/evidence",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const clauses = body.clauses as Record<string, Record<string, unknown>>;
    const evidence = clauses.cl_10.evidence as Record<string, unknown>;
    const rate = evidence.resolutionRate as number;
    expect(rate).toBeGreaterThanOrEqual(0);
    expect(rate).toBeLessThanOrEqual(100);
  });
});

// =========================================================================
// Date range filtering
// =========================================================================

describe("POST /v1/exports/iso42001/evidence — date filtering", () => {
  it("filters evidence by startDate and endDate", async () => {
    // Use a far-future range that should match nothing
    const { body, response } = await postJSON(
      "/v1/exports/iso42001/evidence",
      {
        projectId: IDS.projectAlpha,
        startDate: "2099-01-01",
        endDate: "2099-12-31",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);

    const clauses = body.clauses as Record<string, Record<string, unknown>>;
    const evidence85 = clauses.cl_8_5.evidence as Record<string, unknown>;
    // With a far-future range, totalSessions should be 0
    expect(evidence85.totalSessions).toBe(0);
  });
});

// =========================================================================
// Authentication & Authorization
// =========================================================================

describe("POST /v1/exports/iso42001/evidence — auth & gating", () => {
  it("returns 401 without API key", async () => {
    const { response } = await postJSON(
      "/v1/exports/iso42001/evidence",
      { projectId: IDS.projectAlpha }
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 with invalid API key", async () => {
    const { response } = await postJSON(
      "/v1/exports/iso42001/evidence",
      { projectId: IDS.projectAlpha },
      API_KEYS.invalid
    );

    expect(response.status).toBe(401);
  });

  it("returns 400 when projectId is missing", async () => {
    const { response } = await postJSON(
      "/v1/exports/iso42001/evidence",
      {},
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(400);
  });

  it("beta key cannot access alpha project evidence", async () => {
    const { response } = await postJSON(
      "/v1/exports/iso42001/evidence",
      { projectId: IDS.projectAlpha },
      API_KEYS.beta
    );

    // Beta key is scoped to projectBeta; accessing projectAlpha should be 403
    expect(response.status).toBe(403);
  });
});

// =========================================================================
// Audit logging
// =========================================================================

describe("POST /v1/exports/iso42001/evidence — audit logging", () => {
  it("creates audit log entry for successful export", async () => {
    const countBefore = await countAuditLogs();

    await postJSON(
      "/v1/exports/iso42001/evidence",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});
