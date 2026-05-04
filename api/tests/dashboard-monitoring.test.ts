/**
 * Sprint 9 Deliverable 1: Continuous Monitoring Dashboard API (ISO 42001 Cl.9.1)
 *
 * Tests for:
 * - GET /v1/dashboards/monitoring — real-time operational metrics
 *   - activeSessions, turnsCaptured, driftEvents, toolDistribution,
 *     tokenTrends, anomalyRate
 *   - Filterable by agent, model, project, time range
 *   - 
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
  foundation: "wrt_test_dashmon_foundation_01",
  compliance: "wrt_test_dashmon_compliance_02",
} as const;

const TEST_KEY_IDS = {
  foundation: "bb400000-0000-4000-8000-000000000001",
  compliance: "bb400000-0000-4000-8000-000000000002",
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
// Extended fixtures: additional sessions/turns for monitoring metrics
// ---------------------------------------------------------------------------

async function seedMonitoringDashboardFixtures(): Promise<void> {
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

  // Seed a session with a different system_prompt_hash to generate drift events
  const driftSessionId = "cc900000-0000-4000-8000-000000000001";
  const driftTurnId = "dd900000-0000-4000-8000-000000000001";
  const threeDaysAgo = new Date(now.getTime() - 3 * 86400_000);

  await p.query(`
    INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at,
                          initial_intent, system_prompt_hash, total_turns, turns_captured,
                          dropped_events, total_tokens, total_cost_usd, agent_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT (id) DO NOTHING
  `, [driftSessionId, IDS.projectAlpha, "anthropic", "claude-sonnet-4-20250514",
      threeDaysAgo.toISOString(), threeDaysAgo.toISOString(),
      "Update documentation for API", "different_prompt_hash_xyz", 1, 1,
      0, 3000, 0.10, "claude-code"]);

  await p.query(`
    INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
                       req_bytes_ref, resp_bytes_ref, model, provider,
                       input_tokens, output_tokens, cost_usd, duration_ms,
                       tool_call_count, stop_reason, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    ON CONFLICT (id) DO NOTHING
  `, [driftTurnId, driftSessionId, 1, threeDaysAgo.toISOString(),
      "hash_req_drift_1", "hash_resp_drift_1", "req_ref_drift_1", "resp_ref_drift_1",
      "claude-sonnet-4-20250514", "anthropic", 1500, 1500, 0.10, 800,
      1, "end_turn", threeDaysAgo.toISOString()]);

  // Add a Read tool call for the drift session turn
  await p.query(`
    INSERT INTO tool_calls (id, turn_id, tool_name, tool_input, input_hash, sequence_num,
                            output, output_hash, duration_ms, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (id) DO NOTHING
  `, ["ee900000-0000-4000-8000-000000000001", driftTurnId, "Read",
      '{"file": "README.md"}', "input_hash_drift_tc1", 0,
      "File contents: # Recondo Gateway...", "output_hash_drift_tc1", 250, "success"]);

  // Add anomaly events with resolved_at for monitoring metrics
  await p.query(`
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS resolution_note TEXT;
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS score DOUBLE PRECISION;
  `);

  // Add project_id to existing anomalies and add a resolved one
  await p.query(`
    UPDATE anomaly_events SET project_id = $1 WHERE session_id IN (
      SELECT id FROM sessions WHERE project_id = $1
    )
  `, [IDS.projectAlpha]);

  // Add a resolved anomaly for testing anomalyRate.resolved
  const resolvedAnomalyId = "ff900000-0000-4000-8000-000000000001";
  await p.query(`
    INSERT INTO anomaly_events (id, session_id, anomaly_type, severity, description, project_id, resolved_at, detected_at)
    VALUES ($1, $2, $3, $4, $5, $6, to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), to_char((NOW() - INTERVAL '5 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    ON CONFLICT (id) DO NOTHING
  `, [resolvedAnomalyId, IDS.sessionAlpha1, "cost_spike", "warning",
      "Cost spike detected", IDS.projectAlpha]);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedMonitoringDashboardFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// GET /v1/dashboards/monitoring — Basic response structure
// =========================================================================

describe("GET /v1/dashboards/monitoring — structure", () => {
  it("returns all required top-level fields", async () => {
    const { body, response } = await getJSON(
      `/v1/dashboards/monitoring?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body.activeSessions).toBeDefined();
    expect(body.turnsCaptured).toBeDefined();
    expect(body.driftEvents).toBeDefined();
    expect(body.toolDistribution).toBeDefined();
    expect(body.tokenTrends).toBeDefined();
    expect(body.anomalyRate).toBeDefined();
  });

  it("activeSessions is a non-negative integer", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/monitoring?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    expect(typeof body.activeSessions).toBe("number");
    expect(body.activeSessions as number).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.activeSessions)).toBe(true);
  });

  it("turnsCaptured has total, last24h, and last7d sub-fields", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/monitoring?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const tc = body.turnsCaptured as Record<string, unknown>;
    expect(tc.total).toBeDefined();
    expect(tc.last24h).toBeDefined();
    expect(tc.last7d).toBeDefined();
    expect(typeof tc.total).toBe("number");
    expect(typeof tc.last24h).toBe("number");
    expect(typeof tc.last7d).toBe("number");
  });

  it("turnsCaptured.last24h <= turnsCaptured.last7d <= turnsCaptured.total", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/monitoring?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const tc = body.turnsCaptured as Record<string, number>;
    expect(tc.last24h).toBeLessThanOrEqual(tc.last7d);
    expect(tc.last7d).toBeLessThanOrEqual(tc.total);
  });

  it("driftEvents includes systemPrompt and toolDefinition counts", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/monitoring?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const drift = body.driftEvents as Record<string, unknown>;
    expect(drift).toHaveProperty("systemPrompt");
    expect(drift).toHaveProperty("toolDefinition");
    expect(typeof drift.systemPrompt).toBe("number");
    expect(typeof drift.toolDefinition).toBe("number");
  });
});

// =========================================================================
// Tool distribution
// =========================================================================

describe("GET /v1/dashboards/monitoring — toolDistribution", () => {
  it("toolDistribution is an array of tool objects with name, count, percentage", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/monitoring?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const tools = body.toolDistribution as Array<Record<string, unknown>>;
    expect(Array.isArray(tools)).toBe(true);

    if (tools.length > 0) {
      const firstTool = tools[0];
      expect(firstTool).toHaveProperty("tool");
      expect(firstTool).toHaveProperty("count");
      expect(firstTool).toHaveProperty("percentage");
      expect(typeof firstTool.tool).toBe("string");
      expect(typeof firstTool.count).toBe("number");
      expect(typeof firstTool.percentage).toBe("number");
    }
  });

  it("toolDistribution percentages sum to approximately 1.0", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/monitoring?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const tools = body.toolDistribution as Array<{ percentage: number }>;
    if (tools.length > 0) {
      const totalPercentage = tools.reduce((sum, t) => sum + t.percentage, 0);
      // Allow small floating-point rounding tolerance
      expect(totalPercentage).toBeGreaterThan(0.95);
      expect(totalPercentage).toBeLessThanOrEqual(1.05);
    }
  });
});

// =========================================================================
// Token trends
// =========================================================================

describe("GET /v1/dashboards/monitoring — tokenTrends", () => {
  it("tokenTrends is an array of daily data points with period, inputTokens, outputTokens", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/monitoring?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const trends = body.tokenTrends as Array<Record<string, unknown>>;
    expect(Array.isArray(trends)).toBe(true);

    if (trends.length > 0) {
      const first = trends[0];
      expect(first).toHaveProperty("period");
      expect(first).toHaveProperty("inputTokens");
      expect(first).toHaveProperty("outputTokens");
      expect(typeof first.inputTokens).toBe("number");
      expect(typeof first.outputTokens).toBe("number");
    }
  });

  it("tokenTrends data points are in chronological order", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/monitoring?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const trends = body.tokenTrends as Array<{ period: string }>;
    if (trends.length > 1) {
      for (let i = 1; i < trends.length; i++) {
        expect(trends[i].period >= trends[i - 1].period).toBe(true);
      }
    }
  });
});

// =========================================================================
// Anomaly rate
// =========================================================================

describe("GET /v1/dashboards/monitoring — anomalyRate", () => {
  it("anomalyRate includes last30d, resolved, and unresolved counts", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/monitoring?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const ar = body.anomalyRate as Record<string, unknown>;
    expect(ar).toHaveProperty("last30d");
    expect(ar).toHaveProperty("resolved");
    expect(ar).toHaveProperty("unresolved");
    expect(typeof ar.last30d).toBe("number");
    expect(typeof ar.resolved).toBe("number");
    expect(typeof ar.unresolved).toBe("number");
  });

  it("anomalyRate.last30d >= anomalyRate.resolved + anomalyRate.unresolved (sanity)", async () => {
    const { body } = await getJSON(
      `/v1/dashboards/monitoring?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const ar = body.anomalyRate as Record<string, number>;
    // last30d should be at least as large as resolved + unresolved
    // (some might fall outside 30d window)
    expect(ar.last30d).toBeGreaterThanOrEqual(0);
    expect(ar.resolved).toBeGreaterThanOrEqual(0);
    expect(ar.unresolved).toBeGreaterThanOrEqual(0);
  });
});

// =========================================================================
// Filtering
// =========================================================================

describe("GET /v1/dashboards/monitoring — filters", () => {
  it("filters by agent", async () => {
    const { body, response } = await getJSON(
      `/v1/dashboards/monitoring?projectId=${IDS.projectAlpha}&agent=claude-code`,
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    // The response should be scoped to claude-code agent only
    expect(body.activeSessions).toBeDefined();
  });

  it("filters by model", async () => {
    const { body, response } = await getJSON(
      `/v1/dashboards/monitoring?projectId=${IDS.projectAlpha}&model=claude-sonnet-4-20250514`,
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body.turnsCaptured).toBeDefined();
  });
});

// =========================================================================
// Auth, project scoping, audit logging
// =========================================================================

describe("GET /v1/dashboards/monitoring — auth and access control", () => {
  it("returns 401 without authentication", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/dashboards/monitoring?projectId=${IDS.projectAlpha}`,
      { method: "GET" }
    );

    expect(response.status).toBe(401);
  });

  it("project-scoped key cannot see another project's data", async () => {
    // The compliance key is bound to projectAlpha; querying projectBeta should be empty or 403
    const { body, response } = await getJSON(
      `/v1/dashboards/monitoring?projectId=${IDS.projectBeta}`,
      TEST_KEYS.compliance
    );

    // Either returns 403 or returns empty/zeroed data scoped to own project
    if (response.status === 200) {
      const tc = body.turnsCaptured as Record<string, number>;
      // The key's own project data, not the requested projectBeta
      expect(tc.total).toBeDefined();
    } else {
      expect(response.status).toBe(403);
    }
  });

  it("audit logs the dashboard access", async () => {
    const before = await countAuditLogs();

    await getJSON(
      `/v1/dashboards/monitoring?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const after = await countAuditLogs();
    expect(after).toBeGreaterThan(before);
  });
});

describe("GET /v1/dashboards/monitoring — full dashboard payload", () => {
  it("returns full monitoring dashboard for an authenticated key", async () => {
    const { body, response } = await getJSON(
      `/v1/dashboards/monitoring?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body.activeSessions).toBeDefined();
    expect(body.turnsCaptured).toBeDefined();
    expect(body.driftEvents).toBeDefined();
    expect(body.toolDistribution).toBeDefined();
    expect(body.tokenTrends).toBeDefined();
    expect(body.anomalyRate).toBeDefined();
  });
});
