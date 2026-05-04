/**
 * Sprint 6 Deliverable 5: Cost Allocation by Model and Provider
 *
 * Tests for:
 * - GET /v1/usage/cost-allocation — token spend broken down by model and provider
 * - Daily/weekly/monthly cost trends per model/provider
 * - Powered by mv_usage_daily materialized view
 * - Authentication and project scoping
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
// Extended fixtures: multiple models, providers, days for cost allocation
// ---------------------------------------------------------------------------

const CA_IDS = {
  sessionCA1: "ca000000-0000-4000-8000-000000000001",
  sessionCA2: "ca000000-0000-4000-8000-000000000002",
  sessionCA3: "ca000000-0000-4000-8000-000000000003",
  sessionCA4: "ca000000-0000-4000-8000-000000000004",
  sessionCA5: "ca000000-0000-4000-8000-000000000005",

  turnCA1_1: "cat00000-0000-4000-8000-000000000001",
  turnCA1_2: "cat00000-0000-4000-8000-000000000002",
  turnCA2_1: "cat00000-0000-4000-8000-000000000003",
  turnCA3_1: "cat00000-0000-4000-8000-000000000004",
  turnCA3_2: "cat00000-0000-4000-8000-000000000005",
  turnCA4_1: "cat00000-0000-4000-8000-000000000006",
  turnCA5_1: "cat00000-0000-4000-8000-000000000007",
  turnCA5_2: "cat00000-0000-4000-8000-000000000008",
} as const;

async function seedCostAllocationFixtures(): Promise<void> {
  const p = getPool();
  const now = new Date();
  const day1 = new Date(now.getTime() - 1 * 86400_000);
  const day2 = new Date(now.getTime() - 2 * 86400_000);
  const day3 = new Date(now.getTime() - 3 * 86400_000);
  const day7 = new Date(now.getTime() - 7 * 86400_000);

  // Sessions across multiple providers, models, and days for alpha project
  await p.query(`
    INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at, ended_at,
                          initial_intent, system_prompt_hash, total_turns, turns_captured,
                          dropped_events, total_tokens, total_cost_usd, agent_id) VALUES
      ('${CA_IDS.sessionCA1}', '${IDS.projectAlpha}', 'anthropic', 'claude-sonnet-4-20250514',
       '${day1.toISOString()}', '${day1.toISOString()}', '${day1.toISOString()}',
       'CA test 1', 'cahash1', 2, 2, 0, 20000, 1.20, 'claude-code'),
      ('${CA_IDS.sessionCA2}', '${IDS.projectAlpha}', 'openai', 'gpt-4o',
       '${day1.toISOString()}', '${day1.toISOString()}', '${day1.toISOString()}',
       'CA test 2', 'cahash2', 1, 1, 0, 8000, 0.40, 'cursor'),
      ('${CA_IDS.sessionCA3}', '${IDS.projectAlpha}', 'anthropic', 'claude-sonnet-4-20250514',
       '${day2.toISOString()}', '${day2.toISOString()}', '${day2.toISOString()}',
       'CA test 3', 'cahash3', 2, 2, 0, 15000, 0.90, 'claude-code'),
      ('${CA_IDS.sessionCA4}', '${IDS.projectAlpha}', 'google', 'gemini-2.0-flash',
       '${day3.toISOString()}', '${day3.toISOString()}', '${day3.toISOString()}',
       'CA test 4', 'cahash4', 1, 1, 0, 12000, 0.30, 'aider'),
      ('${CA_IDS.sessionCA5}', '${IDS.projectAlpha}', 'openai', 'gpt-4o',
       '${day7.toISOString()}', '${day7.toISOString()}', '${day7.toISOString()}',
       'CA test 5', 'cahash5', 2, 2, 0, 18000, 0.80, 'cursor')
    ON CONFLICT (id) DO NOTHING;
  `);

  await p.query(`
    INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
                       req_bytes_ref, resp_bytes_ref, model, provider,
                       input_tokens, output_tokens, thinking_tokens, cost_usd,
                       duration_ms, tool_call_count, stop_reason, created_at) VALUES
      ('${CA_IDS.turnCA1_1}', '${CA_IDS.sessionCA1}', 1,
       '${day1.toISOString()}', 'hash_ca1_1r', 'hash_ca1_1s',
       'ref_ca1_1r', 'ref_ca1_1s', 'claude-sonnet-4-20250514', 'anthropic',
       6000, 4000, 0, 0.60, 2500, 0, 'end_turn', '${day1.toISOString()}'),
      ('${CA_IDS.turnCA1_2}', '${CA_IDS.sessionCA1}', 2,
       '${new Date(day1.getTime() + 60000).toISOString()}', 'hash_ca1_2r', 'hash_ca1_2s',
       'ref_ca1_2r', 'ref_ca1_2s', 'claude-sonnet-4-20250514', 'anthropic',
       6000, 4000, 0, 0.60, 3000, 0, 'end_turn', '${new Date(day1.getTime() + 60000).toISOString()}'),
      ('${CA_IDS.turnCA2_1}', '${CA_IDS.sessionCA2}', 1,
       '${day1.toISOString()}', 'hash_ca2_1r', 'hash_ca2_1s',
       'ref_ca2_1r', 'ref_ca2_1s', 'gpt-4o', 'openai',
       4000, 4000, 0, 0.40, 1800, 0, 'end_turn', '${day1.toISOString()}'),
      ('${CA_IDS.turnCA3_1}', '${CA_IDS.sessionCA3}', 1,
       '${day2.toISOString()}', 'hash_ca3_1r', 'hash_ca3_1s',
       'ref_ca3_1r', 'ref_ca3_1s', 'claude-sonnet-4-20250514', 'anthropic',
       5000, 3000, 0, 0.45, 2200, 0, 'end_turn', '${day2.toISOString()}'),
      ('${CA_IDS.turnCA3_2}', '${CA_IDS.sessionCA3}', 2,
       '${new Date(day2.getTime() + 60000).toISOString()}', 'hash_ca3_2r', 'hash_ca3_2s',
       'ref_ca3_2r', 'ref_ca3_2s', 'claude-sonnet-4-20250514', 'anthropic',
       4000, 3000, 0, 0.45, 2000, 0, 'end_turn', '${new Date(day2.getTime() + 60000).toISOString()}'),
      ('${CA_IDS.turnCA4_1}', '${CA_IDS.sessionCA4}', 1,
       '${day3.toISOString()}', 'hash_ca4_1r', 'hash_ca4_1s',
       'ref_ca4_1r', 'ref_ca4_1s', 'gemini-2.0-flash', 'google',
       6000, 6000, 0, 0.30, 900, 0, 'end_turn', '${day3.toISOString()}'),
      ('${CA_IDS.turnCA5_1}', '${CA_IDS.sessionCA5}', 1,
       '${day7.toISOString()}', 'hash_ca5_1r', 'hash_ca5_1s',
       'ref_ca5_1r', 'ref_ca5_1s', 'gpt-4o', 'openai',
       5000, 4000, 0, 0.40, 1600, 0, 'end_turn', '${day7.toISOString()}'),
      ('${CA_IDS.turnCA5_2}', '${CA_IDS.sessionCA5}', 2,
       '${new Date(day7.getTime() + 60000).toISOString()}', 'hash_ca5_2r', 'hash_ca5_2s',
       'ref_ca5_2r', 'ref_ca5_2s', 'gpt-4o', 'openai',
       5000, 4000, 0, 0.40, 1500, 0, 'end_turn', '${new Date(day7.getTime() + 60000).toISOString()}')
    ON CONFLICT (id) DO NOTHING;
  `);
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
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedCostAllocationFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// GET /v1/usage/cost-allocation
// =========================================================================

describe("GET /v1/usage/cost-allocation", () => {
  it("returns cost breakdown by model and provider", async () => {
    const { body, response } = await getJSON(
      "/v1/usage/cost-allocation",
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body.allocations).toBeDefined();

    const allocations = body.allocations as Array<Record<string, unknown>>;
    expect(Array.isArray(allocations)).toBe(true);
    expect(allocations.length).toBeGreaterThanOrEqual(1);

    for (const alloc of allocations) {
      expect(alloc.model).toBeDefined();
      expect(alloc.provider).toBeDefined();
      expect(typeof alloc.totalCostUsd).toBe("number");
      expect(typeof alloc.totalTokens).toBe("number");
      expect(typeof alloc.sessionCount).toBe("number");
    }
  });

  it("breaks down cost by provider correctly", async () => {
    const { body } = await getJSON(
      "/v1/usage/cost-allocation",
      API_KEYS.alpha
    );

    const allocations = body.allocations as Array<Record<string, unknown>>;
    const providers = Array.from(new Set(allocations.map((a) => a.provider)));

    // Alpha project has anthropic, openai, and google providers
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
    expect(providers).toContain("google");
  });

  it("anthropic cost is highest for alpha project", async () => {
    const { body } = await getJSON(
      "/v1/usage/cost-allocation",
      API_KEYS.alpha
    );

    const allocations = body.allocations as Array<Record<string, unknown>>;

    // Sum cost by provider
    const costByProvider: Record<string, number> = {};
    for (const alloc of allocations) {
      const provider = String(alloc.provider);
      costByProvider[provider] = (costByProvider[provider] || 0) + Number(alloc.totalCostUsd);
    }

    // Anthropic should have the highest cost based on our fixtures
    expect(costByProvider["anthropic"]).toBeGreaterThan(costByProvider["openai"] || 0);
    expect(costByProvider["anthropic"]).toBeGreaterThan(costByProvider["google"] || 0);
  });

  it("returns 401 without API key", async () => {
    const { response } = await getJSON("/v1/usage/cost-allocation");
    expect(response.status).toBe(401);
  });

  it("audit logs the request", async () => {
    const countBefore = await countAuditLogs();
    await getJSON("/v1/usage/cost-allocation", API_KEYS.alpha);
    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});

// =========================================================================
// Time period filtering
// =========================================================================

describe("GET /v1/usage/cost-allocation time period filtering", () => {
  it("filters by daily period", async () => {
    const { body, response } = await getJSON(
      "/v1/usage/cost-allocation?period=daily",
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body.allocations).toBeDefined();

    const allocations = body.allocations as Array<Record<string, unknown>>;
    // Should have data grouped by day
    expect(allocations.length).toBeGreaterThanOrEqual(1);

    for (const alloc of allocations) {
      expect(alloc.periodStart).toBeDefined();
    }
  });

  it("filters by weekly period", async () => {
    const { body, response } = await getJSON(
      "/v1/usage/cost-allocation?period=weekly",
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    const allocations = body.allocations as Array<Record<string, unknown>>;
    expect(allocations.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by monthly period", async () => {
    const { body, response } = await getJSON(
      "/v1/usage/cost-allocation?period=monthly",
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    const allocations = body.allocations as Array<Record<string, unknown>>;
    expect(allocations.length).toBeGreaterThanOrEqual(1);
  });

  it("returns 400 for invalid period", async () => {
    const { response } = await getJSON(
      "/v1/usage/cost-allocation?period=biweekly",
      API_KEYS.alpha
    );
    expect(response.status).toBe(400);
  });

  it("daily allocations for a specific date range", async () => {
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 86400_000);
    const from = threeDaysAgo.toISOString().split("T")[0];
    const to = now.toISOString().split("T")[0];

    const { body, response } = await getJSON(
      `/v1/usage/cost-allocation?period=daily&from=${from}&to=${to}`,
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    const allocations = body.allocations as Array<Record<string, unknown>>;
    expect(allocations.length).toBeGreaterThanOrEqual(1);
  });
});

// =========================================================================
// Project scoping
// =========================================================================

describe("cost allocation project scoping", () => {
  it("alpha key sees only alpha project cost data", async () => {
    const { body } = await getJSON(
      "/v1/usage/cost-allocation",
      API_KEYS.alpha
    );

    const allocations = body.allocations as Array<Record<string, unknown>>;
    const totalCost = allocations.reduce(
      (sum, a) => sum + Number(a.totalCostUsd || 0), 0
    );

    // Should have cost > 0 (alpha has sessions)
    expect(totalCost).toBeGreaterThan(0);
  });

  it("beta key sees only beta project cost data", async () => {
    const { body } = await getJSON(
      "/v1/usage/cost-allocation",
      API_KEYS.beta
    );

    const allocations = body.allocations as Array<Record<string, unknown>>;

    // Beta only has anthropic/claude-sonnet sessions
    const providers = Array.from(new Set(allocations.map((a) => a.provider)));
    expect(providers).toContain("anthropic");
    expect(providers).not.toContain("openai");
    expect(providers).not.toContain("google");
  });

  it("admin key sees cost data across all projects", async () => {
    const { body: adminBody } = await getJSON(
      "/v1/usage/cost-allocation",
      API_KEYS.admin
    );
    const { body: alphaBody } = await getJSON(
      "/v1/usage/cost-allocation",
      API_KEYS.alpha
    );

    const adminTotal = (adminBody.allocations as Array<Record<string, unknown>>).reduce(
      (sum, a) => sum + Number(a.totalCostUsd || 0), 0
    );
    const alphaTotal = (alphaBody.allocations as Array<Record<string, unknown>>).reduce(
      (sum, a) => sum + Number(a.totalCostUsd || 0), 0
    );

    // Admin should see >= alpha (admin includes beta project too)
    expect(adminTotal).toBeGreaterThanOrEqual(alphaTotal);
  });
});

// =========================================================================
// End-to-end: cost allocation matches raw data
// =========================================================================

describe("cost allocation end-to-end", () => {
  it("total cost across all allocations matches raw turn costs", async () => {
    const p = getPool();

    // Raw cost from turns for alpha project
    const rawResult = await p.query(`
      SELECT SUM(t.cost_usd) AS raw_cost
      FROM turns t
      JOIN sessions s ON t.session_id = s.id
      WHERE s.project_id = $1
    `, [IDS.projectAlpha]);

    const { body } = await getJSON(
      "/v1/usage/cost-allocation",
      API_KEYS.alpha
    );

    const allocations = body.allocations as Array<Record<string, unknown>>;
    const apiTotal = allocations.reduce(
      (sum, a) => sum + Number(a.totalCostUsd || 0), 0
    );

    expect(apiTotal).toBeCloseTo(Number(rawResult.rows[0].raw_cost), 2);
  });

  it("token counts by model match raw data", async () => {
    const p = getPool();

    // Raw tokens by model for alpha project
    const rawResult = await p.query(`
      SELECT t.model, SUM(t.input_tokens + t.output_tokens) AS raw_tokens
      FROM turns t
      JOIN sessions s ON t.session_id = s.id
      WHERE s.project_id = $1
      GROUP BY t.model
      ORDER BY t.model
    `, [IDS.projectAlpha]);

    const { body } = await getJSON(
      "/v1/usage/cost-allocation",
      API_KEYS.alpha
    );

    const allocations = body.allocations as Array<Record<string, unknown>>;

    // Aggregate API tokens by model
    const apiTokensByModel: Record<string, number> = {};
    for (const alloc of allocations) {
      const model = String(alloc.model);
      apiTokensByModel[model] = (apiTokensByModel[model] || 0) + Number(alloc.totalTokens);
    }

    // Compare with raw data
    for (const raw of rawResult.rows) {
      const model = String(raw.model);
      expect(apiTokensByModel[model]).toBe(Number(raw.raw_tokens));
    }
  });
});

// =========================================================================
// Negative tests
// =========================================================================

describe("cost allocation negative tests", () => {
  it("returns empty allocations for project with no sessions", async () => {
    // Use a valid key but assume no matching data.
    // This tests that the endpoint returns an empty array, not an error.
    // The beta key has limited data — we check for non-error response.
    const { body, response } = await getJSON(
      "/v1/usage/cost-allocation?period=daily&from=2020-01-01&to=2020-01-02",
      API_KEYS.beta
    );

    expect(response.status).toBe(200);
    const allocations = body.allocations as Array<Record<string, unknown>>;
    // No sessions in the 2020 date range
    expect(allocations.length).toBe(0);
  });

  it("returns 401 with revoked API key", async () => {
    const { response } = await getJSON(
      "/v1/usage/cost-allocation",
      API_KEYS.revoked
    );
    expect(response.status).toBe(401);
  });
});
