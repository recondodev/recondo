/**
 * Sprint 9 Deliverable 2: Management Review Dashboard API (ISO 42001 Cl.9.3)
 *
 * Tests for:
 * - GET /v1/dashboards/management-review — executive-facing summary
 *   - governanceCoverage, compliancePosture, anomalySummary,
 *     riskProfile, frameworkChecklist
 *   - Auth, project scoped, audit logged
 *
 * These tests WILL FAIL until the implementation agent builds the endpoints.
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
  foundation: "wrt_test_dashmgmt_foundation_01",
  compliance: "wrt_test_dashmgmt_compliance_02",
} as const;

const TEST_KEY_IDS = {
  foundation: "bb410000-0000-4000-8000-000000000001",
  compliance: "bb410000-0000-4000-8000-000000000002",
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

async function getJSON(
  path: string,
  apiKey?: string
): Promise<{ body: Record<string, unknown>; response: Response }> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "GET",
    headers,
  });

  const body = (await response.json()) as Record<string, unknown>;
  return { body, response };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedManagementDashboardFixtures(): Promise<void> {
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

  // Ensure anomaly_events has Sprint 8 columns for severity-based queries
  await p.query(`
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS resolution_note TEXT;
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS score DOUBLE PRECISION;
  `);

  // Update existing anomaly events with project_id
  await p.query(`
    UPDATE anomaly_events SET project_id = (
      SELECT s.project_id FROM sessions s WHERE s.id = anomaly_events.session_id
    ) WHERE project_id IS NULL AND session_id IS NOT NULL
  `);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedManagementDashboardFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// GET /v1/dashboards/management-review — Response structure
// =========================================================================

describe("GET /v1/dashboards/management-review — structure", () => {
  it("returns all required top-level sections", async () => {
    const { body, response } = await getJSON(
      `/v1/dashboards/management-review?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body.governanceCoverage).toBeDefined();
    expect(body.compliancePosture).toBeDefined();
    expect(body.anomalySummary).toBeDefined();
    expect(body.riskProfile).toBeDefined();
    expect(body.frameworkChecklist).toBeDefined();
  });

  it("governanceCoverage contains totalSessions, totalDecisions, totalArtifacts", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/management-review?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const gc = body.governanceCoverage as Record<string, unknown>;
    expect(gc).toHaveProperty("totalSessions");
    expect(gc).toHaveProperty("totalDecisions");
    expect(gc).toHaveProperty("totalArtifacts");
    expect(typeof gc.totalSessions).toBe("number");
    expect(typeof gc.totalDecisions).toBe("number");
    expect(typeof gc.totalArtifacts).toBe("number");
  });

  it("governanceCoverage.totalSessions matches actual session count for project", async () => {
    const p = getPool();
    const result = await p.query(
      "SELECT COUNT(*)::int AS cnt FROM sessions WHERE project_id = $1",
      [IDS.projectAlpha]
    );
    const dbCount = result.rows[0].cnt;

    const { body } = await getJSON(
      `/v1/dashboards/management-review?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const gc = body.governanceCoverage as Record<string, number>;
    expect(gc.totalSessions).toBe(dbCount);
  });

  it("compliancePosture includes soc2Completeness and iso42001EvidenceFreshness", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/management-review?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const cp = body.compliancePosture as Record<string, unknown>;
    expect(cp).toHaveProperty("soc2Completeness");
    expect(cp).toHaveProperty("iso42001EvidenceFreshness");
    expect(typeof cp.soc2Completeness).toBe("number");
    // soc2Completeness should be a percentage (0-100)
    expect(cp.soc2Completeness as number).toBeGreaterThanOrEqual(0);
    expect(cp.soc2Completeness as number).toBeLessThanOrEqual(100);
  });
});

// =========================================================================
// Anomaly summary
// =========================================================================

describe("GET /v1/dashboards/management-review — anomalySummary", () => {
  it("anomalySummary includes total, bySeverity, and resolutionRate", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/management-review?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const as = body.anomalySummary as Record<string, unknown>;
    expect(as).toHaveProperty("total");
    expect(as).toHaveProperty("bySeverity");
    expect(as).toHaveProperty("resolutionRate");
    expect(typeof as.total).toBe("number");
    expect(typeof as.resolutionRate).toBe("number");
  });

  it("anomalySummary.bySeverity has warning and critical keys", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/management-review?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const as = body.anomalySummary as Record<string, unknown>;
    const bySeverity = as.bySeverity as Record<string, unknown>;
    expect(bySeverity).toHaveProperty("warning");
    expect(bySeverity).toHaveProperty("critical");
    expect(typeof bySeverity.warning).toBe("number");
    expect(typeof bySeverity.critical).toBe("number");
  });

  it("anomalySummary.resolutionRate is a percentage between 0 and 100", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/management-review?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const as = body.anomalySummary as Record<string, unknown>;
    const rate = as.resolutionRate as number;
    expect(rate).toBeGreaterThanOrEqual(0);
    expect(rate).toBeLessThanOrEqual(100);
  });
});

// =========================================================================
// Risk profile
// =========================================================================

describe("GET /v1/dashboards/management-review — riskProfile", () => {
  it("riskProfile has all 4 risk levels", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/management-review?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const rp = body.riskProfile as Record<string, unknown>;
    expect(rp).toHaveProperty("low");
    expect(rp).toHaveProperty("medium");
    expect(rp).toHaveProperty("high");
    expect(rp).toHaveProperty("critical");
    expect(typeof rp.low).toBe("number");
    expect(typeof rp.medium).toBe("number");
    expect(typeof rp.high).toBe("number");
    expect(typeof rp.critical).toBe("number");
  });

  it("riskProfile values are all non-negative integers", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/management-review?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const rp = body.riskProfile as Record<string, number>;
    for (const level of ["low", "medium", "high", "critical"]) {
      expect(rp[level]).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(rp[level])).toBe(true);
    }
  });
});

// =========================================================================
// Framework checklist
// =========================================================================

describe("GET /v1/dashboards/management-review — frameworkChecklist", () => {
  it("frameworkChecklist is a non-empty array of clause objects", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/management-review?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const fc = body.frameworkChecklist as Array<Record<string, unknown>>;
    expect(Array.isArray(fc)).toBe(true);
    expect(fc.length).toBeGreaterThan(0);
  });

  it("each checklist item has clause, status, and evidence fields", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/management-review?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const fc = body.frameworkChecklist as Array<Record<string, unknown>>;
    for (const item of fc) {
      expect(item).toHaveProperty("clause");
      expect(item).toHaveProperty("status");
      expect(item).toHaveProperty("evidence");
      expect(typeof item.clause).toBe("string");
      expect(typeof item.status).toBe("string");
      expect(typeof item.evidence).toBe("string");
    }
  });

  it("frameworkChecklist includes ISO 42001 clauses", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/management-review?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const fc = body.frameworkChecklist as Array<{ clause: string }>;
    const clauses = fc.map((item) => item.clause);
    // Should include at least the key ISO 42001 clauses
    const hasIso42001Clause = clauses.some(
      (c) => c.includes("Cl.") || c.includes("42001") || c.toLowerCase().includes("clause")
    );
    expect(hasIso42001Clause).toBe(true);
  });
});

// =========================================================================
// Auth + project scoping + audit logging
// =========================================================================

describe("GET /v1/dashboards/management-review — access control", () => {
  it("returns 401 without authentication", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/dashboards/management-review?projectId=${IDS.projectAlpha}`,
      { method: "GET" }
    );

    expect(response.status).toBe(401);
  });

  it("authenticated key can access management review", async () => {
    const { response } = await getJSON(
      `/v1/dashboards/management-review?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
  });

  it("admin key can access management review", async () => {
    const { response } = await getJSON(
      `/v1/dashboards/management-review?projectId=${IDS.projectAlpha}`,
      API_KEYS.admin
    );

    expect(response.status).toBe(200);
  });

  it("audit logs the management review access", async () => {
    const before = await countAuditLogs();

    await getJSON(
      `/v1/dashboards/management-review?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const after = await countAuditLogs();
    expect(after).toBeGreaterThan(before);
  });
});
