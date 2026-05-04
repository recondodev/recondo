/**
 * Sprint 5 Deliverable 6: SR 11-7 Export Template
 *
 * Tests for POST /v1/exports/sr11-7 endpoint.
 *
 * This endpoint generates a JSON document mapping to Federal Reserve SR 11-7
 * (model risk management) sections:
 * - modelIdentification: model name, provider, version, usage date range
 * - developmentEvidence: sessions using the model, total decisions, total tokens
 * - validationEvidence: integrity verification results, anomaly counts
 * - ongoingMonitoring: completeness metrics, availability metrics, cost trends
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
// Fixture data for SR 11-7
// ---------------------------------------------------------------------------

async function seedSR117Fixtures(): Promise<void> {
  const p = getPool();

  // Create heartbeats table if not exists (may already exist from other test files)
  await p.query(`
    CREATE TABLE IF NOT EXISTS heartbeats (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      gateway_id      TEXT NOT NULL,
      timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
      metadata        JSONB DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS idx_heartbeats_gateway ON heartbeats (gateway_id, timestamp);
  `);

  // Seed some heartbeats for availability metrics
  const now = new Date();
  const values: string[] = [];
  for (let i = 0; i < 20; i++) {
    const ts = new Date(now.getTime() - i * 30_000);
    values.push(`('gw-001', '${ts.toISOString()}', '{"version":"0.1.0"}')`);
  }

  await p.query(`
    INSERT INTO heartbeats (gateway_id, timestamp, metadata) VALUES
    ${values.join(",\n")}
    ON CONFLICT DO NOTHING;
  `);
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
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedSR117Fixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// POST /v1/exports/sr11-7
// =========================================================================

describe("POST /v1/exports/sr11-7", () => {
  it("generates SR 11-7 report with all required sections", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/sr11-7",
      {
        projectId: IDS.projectAlpha,
        modelId: "claude-sonnet-4-20250514",
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);

    // ---- modelIdentification section ----
    expect(body.modelIdentification).toBeDefined();
    const mi = body.modelIdentification as Record<string, unknown>;
    expect(mi.modelName).toBe("claude-sonnet-4-20250514");
    expect(mi.provider).toBeDefined();
    expect(typeof mi.provider).toBe("string");
    expect(mi.version).toBeDefined();
    expect(mi.usageStartDate).toBeDefined();
    expect(mi.usageEndDate).toBeDefined();
    // Start date should be before or equal to end date
    expect(
      new Date(mi.usageStartDate as string).getTime()
    ).toBeLessThanOrEqual(new Date(mi.usageEndDate as string).getTime());

    // ---- developmentEvidence section ----
    expect(body.developmentEvidence).toBeDefined();
    const de = body.developmentEvidence as Record<string, unknown>;
    expect(de.totalSessions).toBeDefined();
    expect(typeof de.totalSessions).toBe("number");
    expect(de.totalSessions as number).toBeGreaterThanOrEqual(1);
    expect(de.totalDecisions).toBeDefined();
    expect(typeof de.totalDecisions).toBe("number");
    expect(de.totalTokens).toBeDefined();
    expect(typeof de.totalTokens).toBe("number");

    // ---- validationEvidence section ----
    expect(body.validationEvidence).toBeDefined();
    const ve = body.validationEvidence as Record<string, unknown>;
    expect(ve.integrityVerificationResults).toBeDefined();
    expect(ve.anomalyCount).toBeDefined();
    expect(typeof ve.anomalyCount).toBe("number");

    // ---- ongoingMonitoring section ----
    expect(body.ongoingMonitoring).toBeDefined();
    const om = body.ongoingMonitoring as Record<string, unknown>;
    expect(om.completenessMetrics).toBeDefined();
    expect(om.availabilityMetrics).toBeDefined();
    expect(om.costTrends).toBeDefined();
  });

  it("modelIdentification reflects the requested model", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/sr11-7",
      {
        projectId: IDS.projectAlpha,
        modelId: "gpt-4o",
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);

    const mi = body.modelIdentification as Record<string, unknown>;
    expect(mi.modelName).toBe("gpt-4o");
    expect(mi.provider).toBe("openai");
  });

  it("developmentEvidence counts sessions using the specified model", async () => {
    const { body } = await postJSON(
      "/v1/exports/sr11-7",
      {
        projectId: IDS.projectAlpha,
        modelId: "claude-sonnet-4-20250514",
      },
      API_KEYS.alpha
    );

    const de = body.developmentEvidence as Record<string, unknown>;
    // sessionAlpha1 uses claude-sonnet-4-20250514
    expect(de.totalSessions as number).toBeGreaterThanOrEqual(1);
    // The sessions should have turns (decisions)
    expect(de.totalDecisions as number).toBeGreaterThanOrEqual(1);
  });

  it("developmentEvidence returns zero for unused model", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/sr11-7",
      {
        projectId: IDS.projectAlpha,
        modelId: "model-that-was-never-used",
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);

    const de = body.developmentEvidence as Record<string, unknown>;
    expect(de.totalSessions).toBe(0);
    expect(de.totalDecisions).toBe(0);
    expect(de.totalTokens).toBe(0);
  });

  it("validationEvidence includes anomaly count", async () => {
    const { body } = await postJSON(
      "/v1/exports/sr11-7",
      {
        projectId: IDS.projectAlpha,
        modelId: "claude-sonnet-4-20250514",
      },
      API_KEYS.alpha
    );

    const ve = body.validationEvidence as Record<string, unknown>;
    // We have anomaly events seeded for sessionAlpha1
    expect(typeof ve.anomalyCount).toBe("number");
  });

  it("ongoingMonitoring includes completeness metrics", async () => {
    const { body } = await postJSON(
      "/v1/exports/sr11-7",
      {
        projectId: IDS.projectAlpha,
        modelId: "claude-sonnet-4-20250514",
      },
      API_KEYS.alpha
    );

    const om = body.ongoingMonitoring as Record<string, unknown>;
    const completeness = om.completenessMetrics as Record<string, unknown>;
    expect(completeness).toBeDefined();
    // Should indicate % of sessions with complete capture
    expect(completeness.completenessPercentage).toBeDefined();
    expect(typeof completeness.completenessPercentage).toBe("number");
  });

  it("ongoingMonitoring includes cost trends", async () => {
    const { body } = await postJSON(
      "/v1/exports/sr11-7",
      {
        projectId: IDS.projectAlpha,
        modelId: "claude-sonnet-4-20250514",
      },
      API_KEYS.alpha
    );

    const om = body.ongoingMonitoring as Record<string, unknown>;
    const costs = om.costTrends as Record<string, unknown>;
    expect(costs).toBeDefined();
    expect(costs.totalCostUsd).toBeDefined();
    expect(typeof costs.totalCostUsd).toBe("number");
  });

  // -----------------------------------------------------------------------
  // Authentication
  // -----------------------------------------------------------------------

  it("returns 401 without API key", async () => {
    const { response } = await postJSON("/v1/exports/sr11-7", {
      projectId: IDS.projectAlpha,
      modelId: "claude-sonnet-4-20250514",
    });

    expect(response.status).toBe(401);
  });

  it("returns 401 with invalid API key", async () => {
    const { response } = await postJSON(
      "/v1/exports/sr11-7",
      {
        projectId: IDS.projectAlpha,
        modelId: "claude-sonnet-4-20250514",
      },
      API_KEYS.invalid
    );

    expect(response.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // Project scoping
  // -----------------------------------------------------------------------

  it("beta key cannot see alpha project SR 11-7 report data", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/sr11-7",
      {
        projectId: IDS.projectAlpha,
        modelId: "claude-sonnet-4-20250514",
      },
      API_KEYS.beta
    );

    // Either 403, or 200 with empty data (scoped to beta's project)
    if (response.status === 200) {
      const de = body.developmentEvidence as Record<string, unknown>;
      // Beta key should see zero sessions for alpha's model usage
      expect(de.totalSessions).toBe(0);
    } else {
      expect(response.status).toBe(403);
    }
  });

  it("admin key can see cross-project data", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/sr11-7",
      {
        projectId: IDS.projectAlpha,
        modelId: "claude-sonnet-4-20250514",
      },
      API_KEYS.admin
    );

    expect(response.status).toBe(200);

    const de = body.developmentEvidence as Record<string, unknown>;
    expect(de.totalSessions as number).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // Audit logging
  // -----------------------------------------------------------------------

  it("logs SR 11-7 export request in audit log", async () => {
    const countBefore = await countAuditLogs();

    await postJSON(
      "/v1/exports/sr11-7",
      {
        projectId: IDS.projectAlpha,
        modelId: "claude-sonnet-4-20250514",
      },
      API_KEYS.alpha
    );

    const countAfter = await countAuditLogs();
    // SR 11-7 export must produce an audit log entry
    expect(countAfter).toBeGreaterThan(countBefore);
  });

  // -----------------------------------------------------------------------
  // Negative cases
  // -----------------------------------------------------------------------

  it("rejects missing projectId", async () => {
    const { response } = await postJSON(
      "/v1/exports/sr11-7",
      {
        modelId: "claude-sonnet-4-20250514",
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(400);
  });

  it("rejects missing modelId", async () => {
    const { response } = await postJSON(
      "/v1/exports/sr11-7",
      {
        projectId: IDS.projectAlpha,
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(400);
  });

  it("returns valid report even for nonexistent model (with zero counts)", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/sr11-7",
      {
        projectId: IDS.projectAlpha,
        modelId: "nonexistent-model-v99",
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);

    const mi = body.modelIdentification as Record<string, unknown>;
    expect(mi.modelName).toBe("nonexistent-model-v99");

    const de = body.developmentEvidence as Record<string, unknown>;
    expect(de.totalSessions).toBe(0);
    expect(de.totalDecisions).toBe(0);
    expect(de.totalTokens).toBe(0);
  });
});
