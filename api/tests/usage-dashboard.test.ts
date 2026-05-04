/**
 * Sprint 6 Deliverable 4: Basic Usage Dashboard API
 *
 * Tests for:
 * - GET /v1/usage/token-spend — org-wide token spend over time
 * - GET /v1/usage/model-distribution — which models, relative cost
 * - GET /v1/usage/active-agents — distinct agents and session counts
 * - GET /v1/usage/cost-trend — cost over time with model breakdown
 * - Authentication required on all endpoints
 * - Period filtering (daily/weekly/monthly)
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
// Extended fixtures for meaningful aggregation
// ---------------------------------------------------------------------------

const DASH_IDS = {
  sessionDash1: "da000000-0000-4000-8000-000000000001",
  sessionDash2: "da000000-0000-4000-8000-000000000002",
  sessionDash3: "da000000-0000-4000-8000-000000000003",
  sessionDash4: "da000000-0000-4000-8000-000000000004",

  turnDash1_1: "dat00000-0000-4000-8000-000000000001",
  turnDash1_2: "dat00000-0000-4000-8000-000000000002",
  turnDash2_1: "dat00000-0000-4000-8000-000000000003",
  turnDash2_2: "dat00000-0000-4000-8000-000000000004",
  turnDash3_1: "dat00000-0000-4000-8000-000000000005",
  turnDash4_1: "dat00000-0000-4000-8000-000000000006",
  turnDash4_2: "dat00000-0000-4000-8000-000000000007",
  turnDash4_3: "dat00000-0000-4000-8000-000000000008",
} as const;

async function seedDashboardFixtures(): Promise<void> {
  const p = getPool();
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400_000);
  const twoDaysAgo = new Date(now.getTime() - 2 * 86400_000);
  const threeDaysAgo = new Date(now.getTime() - 3 * 86400_000);

  // 4 sessions across project alpha: different models, agents, days
  await p.query(`
    INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at, ended_at,
                          initial_intent, system_prompt_hash, total_turns, turns_captured,
                          dropped_events, total_tokens, total_cost_usd, agent_id) VALUES
      ('${DASH_IDS.sessionDash1}', '${IDS.projectAlpha}', 'anthropic', 'claude-sonnet-4-20250514',
       '${yesterday.toISOString()}', '${yesterday.toISOString()}', '${yesterday.toISOString()}',
       'Dashboard test 1', 'dashhash1', 2, 2, 0, 20000, 0.60, 'claude-code'),
      ('${DASH_IDS.sessionDash2}', '${IDS.projectAlpha}', 'openai', 'gpt-4o',
       '${yesterday.toISOString()}', '${yesterday.toISOString()}', '${yesterday.toISOString()}',
       'Dashboard test 2', 'dashhash2', 2, 2, 0, 12000, 0.35, 'cursor'),
      ('${DASH_IDS.sessionDash3}', '${IDS.projectAlpha}', 'anthropic', 'claude-sonnet-4-20250514',
       '${twoDaysAgo.toISOString()}', '${twoDaysAgo.toISOString()}', '${twoDaysAgo.toISOString()}',
       'Dashboard test 3', 'dashhash3', 1, 1, 0, 8000, 0.25, 'claude-code'),
      ('${DASH_IDS.sessionDash4}', '${IDS.projectAlpha}', 'google', 'gemini-2.0-flash',
       '${threeDaysAgo.toISOString()}', '${threeDaysAgo.toISOString()}', '${threeDaysAgo.toISOString()}',
       'Dashboard test 4', 'dashhash4', 3, 3, 0, 30000, 0.50, 'aider')
    ON CONFLICT (id) DO NOTHING;
  `);

  await p.query(`
    INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
                       req_bytes_ref, resp_bytes_ref, model, provider,
                       input_tokens, output_tokens, thinking_tokens, cost_usd,
                       duration_ms, tool_call_count, stop_reason, created_at) VALUES
      ('${DASH_IDS.turnDash1_1}', '${DASH_IDS.sessionDash1}', 1,
       '${yesterday.toISOString()}', 'hash_d1_1r', 'hash_d1_1s',
       'ref_d1_1r', 'ref_d1_1s', 'claude-sonnet-4-20250514', 'anthropic',
       5000, 5000, 0, 0.30, 2500, 0, 'end_turn', '${yesterday.toISOString()}'),
      ('${DASH_IDS.turnDash1_2}', '${DASH_IDS.sessionDash1}', 2,
       '${new Date(yesterday.getTime() + 60000).toISOString()}', 'hash_d1_2r', 'hash_d1_2s',
       'ref_d1_2r', 'ref_d1_2s', 'claude-sonnet-4-20250514', 'anthropic',
       5000, 5000, 0, 0.30, 3000, 0, 'end_turn', '${new Date(yesterday.getTime() + 60000).toISOString()}'),
      ('${DASH_IDS.turnDash2_1}', '${DASH_IDS.sessionDash2}', 1,
       '${yesterday.toISOString()}', 'hash_d2_1r', 'hash_d2_1s',
       'ref_d2_1r', 'ref_d2_1s', 'gpt-4o', 'openai',
       3000, 3000, 0, 0.18, 1500, 0, 'end_turn', '${yesterday.toISOString()}'),
      ('${DASH_IDS.turnDash2_2}', '${DASH_IDS.sessionDash2}', 2,
       '${new Date(yesterday.getTime() + 60000).toISOString()}', 'hash_d2_2r', 'hash_d2_2s',
       'ref_d2_2r', 'ref_d2_2s', 'gpt-4o', 'openai',
       3000, 3000, 0, 0.17, 1800, 0, 'end_turn', '${new Date(yesterday.getTime() + 60000).toISOString()}'),
      ('${DASH_IDS.turnDash3_1}', '${DASH_IDS.sessionDash3}', 1,
       '${twoDaysAgo.toISOString()}', 'hash_d3_1r', 'hash_d3_1s',
       'ref_d3_1r', 'ref_d3_1s', 'claude-sonnet-4-20250514', 'anthropic',
       4000, 4000, 0, 0.25, 2200, 0, 'end_turn', '${twoDaysAgo.toISOString()}'),
      ('${DASH_IDS.turnDash4_1}', '${DASH_IDS.sessionDash4}', 1,
       '${threeDaysAgo.toISOString()}', 'hash_d4_1r', 'hash_d4_1s',
       'ref_d4_1r', 'ref_d4_1s', 'gemini-2.0-flash', 'google',
       5000, 5000, 0, 0.15, 800, 0, 'end_turn', '${threeDaysAgo.toISOString()}'),
      ('${DASH_IDS.turnDash4_2}', '${DASH_IDS.sessionDash4}', 2,
       '${new Date(threeDaysAgo.getTime() + 60000).toISOString()}', 'hash_d4_2r', 'hash_d4_2s',
       'ref_d4_2r', 'ref_d4_2s', 'gemini-2.0-flash', 'google',
       5000, 5000, 0, 0.15, 900, 0, 'end_turn', '${new Date(threeDaysAgo.getTime() + 60000).toISOString()}'),
      ('${DASH_IDS.turnDash4_3}', '${DASH_IDS.sessionDash4}', 3,
       '${new Date(threeDaysAgo.getTime() + 120000).toISOString()}', 'hash_d4_3r', 'hash_d4_3s',
       'ref_d4_3r', 'ref_d4_3s', 'gemini-2.0-flash', 'google',
       5000, 5000, 0, 0.20, 1000, 0, 'end_turn', '${new Date(threeDaysAgo.getTime() + 120000).toISOString()}')
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
  await seedDashboardFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// GET /v1/usage/token-spend
// =========================================================================

describe("GET /v1/usage/token-spend", () => {
  it("returns org-wide token spend over time", async () => {
    const { body, response } = await getJSON(
      "/v1/usage/token-spend",
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);

    // Response should include datapoints with time-series structure
    expect(body.datapoints).toBeDefined();
    const datapoints = body.datapoints as Array<Record<string, unknown>>;
    expect(Array.isArray(datapoints)).toBe(true);
    expect(datapoints.length).toBeGreaterThanOrEqual(1);

    // Each datapoint should have a date and token metrics
    for (const dp of datapoints) {
      expect(dp.periodStart).toBeDefined();
      expect(typeof dp.totalInputTokens).toBe("number");
      expect(typeof dp.totalOutputTokens).toBe("number");
      expect(typeof dp.totalTokens).toBe("number");
      expect(typeof dp.totalCostUsd).toBe("number");
    }
  });

  it("filters by period (daily)", async () => {
    const { body, response } = await getJSON(
      "/v1/usage/token-spend?period=daily",
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    const datapoints = body.datapoints as Array<Record<string, unknown>>;
    expect(datapoints.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by period (weekly)", async () => {
    const { body, response } = await getJSON(
      "/v1/usage/token-spend?period=weekly",
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    const datapoints = body.datapoints as Array<Record<string, unknown>>;
    expect(datapoints.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by period (monthly)", async () => {
    const { body, response } = await getJSON(
      "/v1/usage/token-spend?period=monthly",
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    const datapoints = body.datapoints as Array<Record<string, unknown>>;
    expect(datapoints.length).toBeGreaterThanOrEqual(1);
  });

  it("returns 401 without API key", async () => {
    const { response } = await getJSON("/v1/usage/token-spend");
    expect(response.status).toBe(401);
  });

  it("returns 400 for invalid period", async () => {
    const { response } = await getJSON(
      "/v1/usage/token-spend?period=invalid",
      API_KEYS.alpha
    );
    expect(response.status).toBe(400);
  });

  it("project-scoped: alpha sees only alpha project data", async () => {
    const { body } = await getJSON(
      "/v1/usage/token-spend",
      API_KEYS.alpha
    );

    const datapoints = body.datapoints as Array<Record<string, unknown>>;
    // Should have data because alpha project has sessions
    expect(datapoints.length).toBeGreaterThanOrEqual(1);

    // Total tokens should reflect only alpha's sessions, not beta's
    const totalTokens = datapoints.reduce(
      (sum, dp) => sum + Number(dp.totalTokens || 0), 0
    );
    expect(totalTokens).toBeGreaterThan(0);
  });

  it("admin sees org-wide data across all projects", async () => {
    const { body: adminBody } = await getJSON(
      "/v1/usage/token-spend",
      API_KEYS.admin
    );
    const { body: alphaBody } = await getJSON(
      "/v1/usage/token-spend",
      API_KEYS.alpha
    );

    const adminTokens = (adminBody.datapoints as Array<Record<string, unknown>>).reduce(
      (sum, dp) => sum + Number(dp.totalTokens || 0), 0
    );
    const alphaTokens = (alphaBody.datapoints as Array<Record<string, unknown>>).reduce(
      (sum, dp) => sum + Number(dp.totalTokens || 0), 0
    );

    // Admin should see >= alpha's data (admin sees all projects)
    expect(adminTokens).toBeGreaterThanOrEqual(alphaTokens);
  });

  it("audit logs the request", async () => {
    const countBefore = await countAuditLogs();
    await getJSON("/v1/usage/token-spend", API_KEYS.alpha);
    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});

// =========================================================================
// GET /v1/usage/model-distribution
// =========================================================================

describe("GET /v1/usage/model-distribution", () => {
  it("returns model distribution with relative cost", async () => {
    const { body, response } = await getJSON(
      "/v1/usage/model-distribution",
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body.models).toBeDefined();

    const models = body.models as Array<Record<string, unknown>>;
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThanOrEqual(1);

    // Each model entry should have name, provider, cost, percentage
    for (const model of models) {
      expect(model.model).toBeDefined();
      expect(typeof model.model).toBe("string");
      expect(typeof model.totalCostUsd).toBe("number");
      expect(typeof model.percentage).toBe("number");
      expect(Number(model.percentage)).toBeGreaterThanOrEqual(0);
      expect(Number(model.percentage)).toBeLessThanOrEqual(100);
    }
  });

  it("percentages sum to approximately 100", async () => {
    const { body } = await getJSON(
      "/v1/usage/model-distribution",
      API_KEYS.alpha
    );

    const models = body.models as Array<Record<string, unknown>>;
    const totalPercentage = models.reduce(
      (sum, m) => sum + Number(m.percentage || 0), 0
    );

    expect(totalPercentage).toBeCloseTo(100, 0);
  });

  it("includes all models used across sessions", async () => {
    const { body } = await getJSON(
      "/v1/usage/model-distribution",
      API_KEYS.alpha
    );

    const models = body.models as Array<Record<string, unknown>>;
    const modelNames = models.map((m) => m.model);

    // Alpha project has anthropic, openai, and google (gemini) sessions
    expect(modelNames).toContain("claude-sonnet-4-20250514");
    expect(modelNames).toContain("gpt-4o");
    expect(modelNames).toContain("gemini-2.0-flash");
  });

  it("returns 401 without API key", async () => {
    const { response } = await getJSON("/v1/usage/model-distribution");
    expect(response.status).toBe(401);
  });

  it("project-scoped: beta only sees its own models", async () => {
    const { body } = await getJSON(
      "/v1/usage/model-distribution",
      API_KEYS.beta
    );

    const models = body.models as Array<Record<string, unknown>>;
    const modelNames = models.map((m) => m.model);

    // Beta project only has anthropic sessions
    expect(modelNames).toContain("claude-sonnet-4-20250514");
    // Should NOT contain gpt-4o or gemini
    expect(modelNames).not.toContain("gpt-4o");
    expect(modelNames).not.toContain("gemini-2.0-flash");
  });
});

// =========================================================================
// GET /v1/usage/active-agents
// =========================================================================

describe("GET /v1/usage/active-agents", () => {
  it("returns distinct agents and session counts", async () => {
    const { body, response } = await getJSON(
      "/v1/usage/active-agents",
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body.agents).toBeDefined();

    const agents = body.agents as Array<Record<string, unknown>>;
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThanOrEqual(1);

    for (const agent of agents) {
      expect(agent.agentId).toBeDefined();
      expect(typeof agent.agentId).toBe("string");
      expect(typeof agent.sessionCount).toBe("number");
      expect(Number(agent.sessionCount)).toBeGreaterThanOrEqual(1);
    }
  });

  it("includes total active agent count", async () => {
    const { body } = await getJSON(
      "/v1/usage/active-agents",
      API_KEYS.alpha
    );

    expect(typeof body.totalAgents).toBe("number");
    expect(Number(body.totalAgents)).toBeGreaterThanOrEqual(1);

    expect(typeof body.totalSessions).toBe("number");
    expect(Number(body.totalSessions)).toBeGreaterThanOrEqual(1);
  });

  it("lists known agents by session count", async () => {
    const { body } = await getJSON(
      "/v1/usage/active-agents",
      API_KEYS.alpha
    );

    const agents = body.agents as Array<Record<string, unknown>>;
    const agentIds = agents.map((a) => a.agentId);

    // Alpha project has claude-code, cursor, and aider agents
    expect(agentIds).toContain("claude-code");
    expect(agentIds).toContain("cursor");
    expect(agentIds).toContain("aider");
  });

  it("returns 401 without API key", async () => {
    const { response } = await getJSON("/v1/usage/active-agents");
    expect(response.status).toBe(401);
  });

  it("project-scoped: beta sees only its agents", async () => {
    const { body } = await getJSON(
      "/v1/usage/active-agents",
      API_KEYS.beta
    );

    const agents = body.agents as Array<Record<string, unknown>>;
    const agentIds = agents.map((a) => a.agentId);

    // Beta only has claude-code
    expect(agentIds).toContain("claude-code");
    // Should NOT see cursor or aider
    expect(agentIds).not.toContain("cursor");
    expect(agentIds).not.toContain("aider");
  });
});

// =========================================================================
// GET /v1/usage/cost-trend
// =========================================================================

describe("GET /v1/usage/cost-trend", () => {
  it("returns cost over time with model breakdown", async () => {
    const { body, response } = await getJSON(
      "/v1/usage/cost-trend",
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body.datapoints).toBeDefined();

    const datapoints = body.datapoints as Array<Record<string, unknown>>;
    expect(Array.isArray(datapoints)).toBe(true);
    expect(datapoints.length).toBeGreaterThanOrEqual(1);

    // Each datapoint should have a date and cost breakdown by model
    for (const dp of datapoints) {
      expect(dp.periodStart).toBeDefined();
      expect(typeof dp.totalCostUsd).toBe("number");

      // Model breakdown
      expect(dp.models).toBeDefined();
      const models = dp.models as Array<Record<string, unknown>>;
      expect(Array.isArray(models)).toBe(true);

      for (const model of models) {
        expect(model.model).toBeDefined();
        expect(typeof model.costUsd).toBe("number");
      }
    }
  });

  it("shows multiple days of cost data", async () => {
    const { body } = await getJSON(
      "/v1/usage/cost-trend",
      API_KEYS.alpha
    );

    const datapoints = body.datapoints as Array<Record<string, unknown>>;
    // We seeded data across yesterday, 2 days ago, and 3 days ago
    expect(datapoints.length).toBeGreaterThanOrEqual(2);
  });

  it("cost trend is consistent with model distribution totals", async () => {
    const { body: trendBody } = await getJSON(
      "/v1/usage/cost-trend",
      API_KEYS.alpha
    );
    const { body: distBody } = await getJSON(
      "/v1/usage/model-distribution",
      API_KEYS.alpha
    );

    const trendTotal = (trendBody.datapoints as Array<Record<string, unknown>>).reduce(
      (sum, dp) => sum + Number(dp.totalCostUsd || 0), 0
    );
    const distTotal = (distBody.models as Array<Record<string, unknown>>).reduce(
      (sum, m) => sum + Number(m.totalCostUsd || 0), 0
    );

    // Both endpoints should report approximately the same total cost
    expect(trendTotal).toBeCloseTo(distTotal, 1);
  });

  it("returns 401 without API key", async () => {
    const { response } = await getJSON("/v1/usage/cost-trend");
    expect(response.status).toBe(401);
  });

  it("supports period filtering (daily)", async () => {
    const { body, response } = await getJSON(
      "/v1/usage/cost-trend?period=daily",
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    const datapoints = body.datapoints as Array<Record<string, unknown>>;
    expect(datapoints.length).toBeGreaterThanOrEqual(1);
  });

  it("supports period filtering (weekly)", async () => {
    const { body, response } = await getJSON(
      "/v1/usage/cost-trend?period=weekly",
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    const datapoints = body.datapoints as Array<Record<string, unknown>>;
    expect(datapoints.length).toBeGreaterThanOrEqual(1);
  });

  it("returns 400 for invalid period", async () => {
    const { response } = await getJSON(
      "/v1/usage/cost-trend?period=invalid",
      API_KEYS.alpha
    );
    expect(response.status).toBe(400);
  });

  it("audit logs the request", async () => {
    const countBefore = await countAuditLogs();
    await getJSON("/v1/usage/cost-trend", API_KEYS.alpha);
    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});

// =========================================================================
// End-to-end: dashboard correctness
// =========================================================================

describe("dashboard end-to-end", () => {
  it("token spend totals match raw turn data for project alpha", async () => {
    const p = getPool();

    // Get raw totals
    const rawResult = await p.query(`
      SELECT
        SUM(t.input_tokens) AS raw_input,
        SUM(t.output_tokens) AS raw_output,
        SUM(t.cost_usd) AS raw_cost
      FROM turns t
      JOIN sessions s ON t.session_id = s.id
      WHERE s.project_id = $1
    `, [IDS.projectAlpha]);

    const { body } = await getJSON(
      "/v1/usage/token-spend",
      API_KEYS.alpha
    );

    const datapoints = body.datapoints as Array<Record<string, unknown>>;
    const apiTotalInput = datapoints.reduce(
      (sum, dp) => sum + Number(dp.totalInputTokens || 0), 0
    );
    const apiTotalOutput = datapoints.reduce(
      (sum, dp) => sum + Number(dp.totalOutputTokens || 0), 0
    );
    const apiTotalCost = datapoints.reduce(
      (sum, dp) => sum + Number(dp.totalCostUsd || 0), 0
    );

    expect(apiTotalInput).toBe(Number(rawResult.rows[0].raw_input));
    expect(apiTotalOutput).toBe(Number(rawResult.rows[0].raw_output));
    expect(apiTotalCost).toBeCloseTo(Number(rawResult.rows[0].raw_cost), 2);
  });

  it("active agent count matches distinct agents in raw data", async () => {
    const p = getPool();

    const rawResult = await p.query(`
      SELECT COUNT(DISTINCT agent_id) AS agent_count
      FROM sessions
      WHERE project_id = $1 AND agent_id IS NOT NULL
    `, [IDS.projectAlpha]);

    const { body } = await getJSON(
      "/v1/usage/active-agents",
      API_KEYS.alpha
    );

    expect(Number(body.totalAgents)).toBe(
      Number(rawResult.rows[0].agent_count)
    );
  });
});
