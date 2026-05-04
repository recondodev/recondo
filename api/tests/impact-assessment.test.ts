/**
 * Sprint 9 Deliverable 4: AI Impact Assessment Reports (ISO 42001 Cl.8.4)
 *
 * Tests for:
 * - POST /v1/reports/impact-assessment — per-agent auto-generated report
 *   - agentId, agentDescription
 *   - decisionVolume: { totalSessions, totalTurns, totalTokens, dateRange }
 *   - artifactsProduced: { totalFiles, uniqueFiles }
 *   - anomalyHistory: [{ type, severity, count, resolved, unresolved }]
 *   - riskDistribution: { low, medium, high, critical }
 *   - Auth, project scoped
 *
 * These tests WILL FAIL until the implementation agent builds the endpoints.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupDatabase,
  teardownDatabase,
  getPool,
  gdprBypassUpdate,
  API_KEYS,
  IDS,
  API_BASE_URL,
  countAuditLogs,
} from "./setup.js";

// ---------------------------------------------------------------------------
// Test API keys
// ---------------------------------------------------------------------------

const TEST_KEYS = {
  foundation: "wrt_test_impact_foundation_001",
  compliance: "wrt_test_impact_compliance_002",
} as const;

const TEST_KEY_IDS = {
  foundation: "bb430000-0000-4000-8000-000000000001",
  compliance: "bb430000-0000-4000-8000-000000000002",
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
// Fixtures: sessions with tool_calls that have artifacts_created
// ---------------------------------------------------------------------------

async function seedImpactAssessmentFixtures(): Promise<void> {
  const p = getPool();
  const now = new Date();

  // Insert test API keys
  const hashFoundation = await sha256(TEST_KEYS.foundation);
  const hashCompliance = await sha256(TEST_KEYS.compliance);

  await p.query(`
    INSERT INTO api_keys (id, key_hash, project_id, rate_limit_rpm) VALUES
      ('${TEST_KEY_IDS.foundation}', '${hashFoundation}', '${IDS.projectAlpha}', 60),
      ('${TEST_KEY_IDS.compliance}', '${hashCompliance}', '${IDS.projectAlpha}', 120)
    ON CONFLICT (id) DO NOTHING;
  `);

  // Add tool_calls with artifacts_created for impact assessment
  const impactTurnId = IDS.turnA1_2; // already exists with tool_calls
  await gdprBypassUpdate(p,
    `UPDATE tool_calls SET artifacts_created = $1 WHERE turn_id = $2 AND tool_name = 'Edit'`,
    ["auth.ts,auth.test.ts", impactTurnId]);

  // Ensure anomaly events have project_id
  await p.query(`
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS resolution_note TEXT;
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS score DOUBLE PRECISION;
  `);

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
  await seedImpactAssessmentFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// POST /v1/reports/impact-assessment — Response structure
// =========================================================================

describe("POST /v1/reports/impact-assessment — structure", () => {
  it("returns all required top-level fields for an agent", async () => {
    const { body, response } = await postJSON(
      "/v1/reports/impact-assessment",
      {
        projectId: IDS.projectAlpha,
        agentId: "claude-code",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body.agentId).toBeDefined();
    expect(body.decisionVolume).toBeDefined();
    expect(body.artifactsProduced).toBeDefined();
    expect(body.anomalyHistory).toBeDefined();
    expect(body.riskDistribution).toBeDefined();
  });

  it("agentId matches the requested agent", async () => {
    const { body } = await postJSON(
      "/v1/reports/impact-assessment",
      {
        projectId: IDS.projectAlpha,
        agentId: "claude-code",
      },
      TEST_KEYS.compliance
    );

    expect(body.agentId).toBe("claude-code");
  });

  it("decisionVolume contains totalSessions, totalTurns, totalTokens, dateRange", async () => {
    const { body } = await postJSON(
      "/v1/reports/impact-assessment",
      {
        projectId: IDS.projectAlpha,
        agentId: "claude-code",
      },
      TEST_KEYS.compliance
    );

    const dv = body.decisionVolume as Record<string, unknown>;
    expect(dv).toHaveProperty("totalSessions");
    expect(dv).toHaveProperty("totalTurns");
    expect(dv).toHaveProperty("totalTokens");
    expect(dv).toHaveProperty("dateRange");
    expect(typeof dv.totalSessions).toBe("number");
    expect(typeof dv.totalTurns).toBe("number");
    expect(typeof dv.totalTokens).toBe("number");
  });

  it("decisionVolume matches raw session/turn counts for agent", async () => {
    const p = getPool();

    // Count sessions for claude-code in projectAlpha
    const sessResult = await p.query(
      `SELECT COUNT(*)::int AS cnt FROM sessions WHERE project_id = $1 AND agent_id = $2`,
      [IDS.projectAlpha, "claude-code"]
    );
    const expectedSessions = sessResult.rows[0].cnt;

    const turnResult = await p.query(
      `SELECT COUNT(*)::int AS cnt FROM turns t
       JOIN sessions s ON t.session_id = s.id
       WHERE s.project_id = $1 AND s.agent_id = $2`,
      [IDS.projectAlpha, "claude-code"]
    );
    const expectedTurns = turnResult.rows[0].cnt;

    const { body } = await postJSON(
      "/v1/reports/impact-assessment",
      {
        projectId: IDS.projectAlpha,
        agentId: "claude-code",
      },
      TEST_KEYS.compliance
    );

    const dv = body.decisionVolume as Record<string, number>;
    expect(dv.totalSessions).toBe(expectedSessions);
    expect(dv.totalTurns).toBe(expectedTurns);
  });
});

// =========================================================================
// Artifacts produced
// =========================================================================

describe("POST /v1/reports/impact-assessment — artifactsProduced", () => {
  it("artifactsProduced has totalFiles and uniqueFiles", async () => {
    const { body } = await postJSON(
      "/v1/reports/impact-assessment",
      {
        projectId: IDS.projectAlpha,
        agentId: "claude-code",
      },
      TEST_KEYS.compliance
    );

    const ap = body.artifactsProduced as Record<string, unknown>;
    expect(ap).toHaveProperty("totalFiles");
    expect(ap).toHaveProperty("uniqueFiles");
    expect(typeof ap.totalFiles).toBe("number");
    expect(typeof ap.uniqueFiles).toBe("number");
  });

  it("uniqueFiles <= totalFiles", async () => {
    const { body } = await postJSON(
      "/v1/reports/impact-assessment",
      {
        projectId: IDS.projectAlpha,
        agentId: "claude-code",
      },
      TEST_KEYS.compliance
    );

    const ap = body.artifactsProduced as Record<string, number>;
    expect(ap.uniqueFiles).toBeLessThanOrEqual(ap.totalFiles);
  });
});

// =========================================================================
// Anomaly history
// =========================================================================

describe("POST /v1/reports/impact-assessment — anomalyHistory", () => {
  it("anomalyHistory is an array with type, severity, count, resolved, unresolved", async () => {
    const { body } = await postJSON(
      "/v1/reports/impact-assessment",
      {
        projectId: IDS.projectAlpha,
        agentId: "claude-code",
      },
      TEST_KEYS.compliance
    );

    const ah = body.anomalyHistory as Array<Record<string, unknown>>;
    expect(Array.isArray(ah)).toBe(true);

    if (ah.length > 0) {
      const first = ah[0];
      expect(first).toHaveProperty("type");
      expect(first).toHaveProperty("severity");
      expect(first).toHaveProperty("count");
      expect(first).toHaveProperty("resolved");
      expect(first).toHaveProperty("unresolved");
    }
  });
});

// =========================================================================
// Risk distribution
// =========================================================================

describe("POST /v1/reports/impact-assessment — riskDistribution", () => {
  it("riskDistribution has all 4 risk levels", async () => {
    const { body } = await postJSON(
      "/v1/reports/impact-assessment",
      {
        projectId: IDS.projectAlpha,
        agentId: "claude-code",
      },
      TEST_KEYS.compliance
    );

    const rd = body.riskDistribution as Record<string, unknown>;
    expect(rd).toHaveProperty("low");
    expect(rd).toHaveProperty("medium");
    expect(rd).toHaveProperty("high");
    expect(rd).toHaveProperty("critical");
  });
});

// =========================================================================
// Auth + project scoping
// =========================================================================

describe("POST /v1/reports/impact-assessment — access control", () => {
  it("returns 401 without authentication", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/reports/impact-assessment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: IDS.projectAlpha,
        agentId: "claude-code",
      }),
    });

    expect(response.status).toBe(401);
  });

  it("authenticated key can access impact assessment", async () => {
    const { response } = await postJSON(
      "/v1/reports/impact-assessment",
      {
        projectId: IDS.projectAlpha,
        agentId: "claude-code",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
  });

  it("audit logs the impact assessment access", async () => {
    const before = await countAuditLogs();

    await postJSON(
      "/v1/reports/impact-assessment",
      {
        projectId: IDS.projectAlpha,
        agentId: "claude-code",
      },
      TEST_KEYS.compliance
    );

    const after = await countAuditLogs();
    expect(after).toBeGreaterThan(before);
  });
});
