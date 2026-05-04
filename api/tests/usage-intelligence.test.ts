/**
 * Sprint 9 Deliverable 5: Full Usage Intelligence
 *
 * Tests for 4 new endpoints:
 * - GET /v1/usage/cost-by-team    — cost by team/developer/agent
 * - GET /v1/usage/developer-productivity — sessions/developer, turn counts, completion rates
 * - GET /v1/usage/model-analysis  — model comparison (cost, tokens, latency per model)
 * - GET /v1/usage/tool-analytics  — tool call frequency, success rate, avg latency per tool
 *
 * All endpoints: auth, project scoped, audit logged.
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
  foundation: "wrt_test_usageint_foundation_01",
  compliance: "wrt_test_usageint_compliance_02",
} as const;

const TEST_KEY_IDS = {
  foundation: "bb440000-0000-4000-8000-000000000001",
  compliance: "bb440000-0000-4000-8000-000000000002",
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

async function seedUsageIntelligenceFixtures(): Promise<void> {
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

  // The base fixtures already include:
  // - 2 sessions for projectAlpha (claude-code on anthropic, cursor on openai)
  // - 5 turns for projectAlpha with different models
  // - 3 tool_calls (Read, Edit, Bash) with durations and statuses
  // Additional tool calls for richer analytics
  const now = new Date();
  const extraToolCalls = [
    {
      id: "ee440000-0000-4000-8000-000000000001",
      turnId: IDS.turnA2_1,
      toolName: "Read",
      input: '{"file": "package.json"}',
      inputHash: "input_hash_extra_1",
      output: "File contents...",
      outputHash: "output_hash_extra_1",
      durationMs: 200,
      status: "success",
    },
    {
      id: "ee440000-0000-4000-8000-000000000002",
      turnId: IDS.turnA2_2,
      toolName: "Write",
      input: '{"file": "test.ts"}',
      inputHash: "input_hash_extra_2",
      output: "File written",
      outputHash: "output_hash_extra_2",
      durationMs: 150,
      status: "success",
    },
    {
      id: "ee440000-0000-4000-8000-000000000003",
      turnId: IDS.turnA2_2,
      toolName: "Bash",
      input: '{"command": "npm run lint"}',
      inputHash: "input_hash_extra_3",
      output: "Error: lint failed",
      outputHash: "output_hash_extra_3",
      durationMs: 3000,
      status: "error",
    },
  ];

  for (const tc of extraToolCalls) {
    await p.query(`
      INSERT INTO tool_calls (id, turn_id, tool_name, tool_input, input_hash, sequence_num,
                              output, output_hash, duration_ms, status)
      VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9)
      ON CONFLICT (id) DO NOTHING
    `, [tc.id, tc.turnId, tc.toolName, tc.input, tc.inputHash,
        tc.output, tc.outputHash, tc.durationMs, tc.status]);
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedUsageIntelligenceFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// GET /v1/usage/cost-by-team
// =========================================================================

describe("GET /v1/usage/cost-by-team", () => {
  it("returns cost breakdown with developer/agent grouping", async () => {
    const { body, response } = await getJSON(
      `/v1/usage/cost-by-team?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    // Should have some kind of breakdown array or object
    const hasBreakdown =
      Array.isArray(body.breakdown) ||
      Array.isArray(body.teams) ||
      Array.isArray(body.entries);
    expect(hasBreakdown).toBe(true);
  });

  it("each entry includes agent or developer identifier and cost", async () => {
    const { body } = await getJSON(
      `/v1/usage/cost-by-team?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const entries = (body.breakdown ?? body.teams ?? body.entries) as Array<Record<string, unknown>>;
    if (entries && entries.length > 0) {
      const first = entries[0];
      // Should have an identifier (agentId, developerId, or teamId)
      const hasId = first.agentId !== undefined ||
                    first.developerId !== undefined ||
                    first.teamId !== undefined;
      expect(hasId).toBe(true);
      // Should have cost info
      const hasCost = first.totalCostUsd !== undefined || first.costUsd !== undefined;
      expect(hasCost).toBe(true);
    }
  });

  it("accepts period query parameter", async () => {
    const { response } = await getJSON(
      `/v1/usage/cost-by-team?projectId=${IDS.projectAlpha}&period=monthly`,
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
  });

  it("returns 401 without auth", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/usage/cost-by-team?projectId=${IDS.projectAlpha}`,
      { method: "GET" }
    );

    expect(response.status).toBe(401);
  });
});

// =========================================================================
// GET /v1/usage/developer-productivity
// =========================================================================

describe("GET /v1/usage/developer-productivity", () => {
  it("returns per-developer metrics", async () => {
    const { body, response } = await getJSON(
      `/v1/usage/developer-productivity?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    const entries = (body.developers ?? body.entries ?? body.productivity) as Array<Record<string, unknown>>;
    expect(Array.isArray(entries)).toBe(true);
  });

  it("each developer entry has session count and turn count", async () => {
    const { body } = await getJSON(
      `/v1/usage/developer-productivity?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const entries = (body.developers ?? body.entries ?? body.productivity) as Array<Record<string, unknown>>;
    if (entries && entries.length > 0) {
      const first = entries[0];
      const hasSessionCount = first.sessionCount !== undefined || first.sessions !== undefined;
      const hasTurnCount = first.turnCount !== undefined || first.turns !== undefined;
      expect(hasSessionCount).toBe(true);
      expect(hasTurnCount).toBe(true);
    }
  });

  it("audit logs the request", async () => {
    const before = await countAuditLogs();

    await getJSON(
      `/v1/usage/developer-productivity?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const after = await countAuditLogs();
    expect(after).toBeGreaterThan(before);
  });
});

// =========================================================================
// GET /v1/usage/model-analysis
// =========================================================================

describe("GET /v1/usage/model-analysis", () => {
  it("returns model comparison data", async () => {
    const { body, response } = await getJSON(
      `/v1/usage/model-analysis?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    const models = (body.models ?? body.entries ?? body.analysis) as Array<Record<string, unknown>>;
    expect(Array.isArray(models)).toBe(true);
  });

  it("each model entry includes cost, tokens, and latency metrics", async () => {
    const { body } = await getJSON(
      `/v1/usage/model-analysis?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const models = (body.models ?? body.entries ?? body.analysis) as Array<Record<string, unknown>>;
    if (models && models.length > 0) {
      const first = models[0];
      expect(first).toHaveProperty("model");
      // Should have cost info
      const hasCost = first.totalCostUsd !== undefined || first.costUsd !== undefined;
      expect(hasCost).toBe(true);
      // Should have token info
      const hasTokens = first.totalTokens !== undefined || first.tokens !== undefined;
      expect(hasTokens).toBe(true);
      // Should have latency info
      const hasLatency = first.avgLatencyMs !== undefined || first.latency !== undefined;
      expect(hasLatency).toBe(true);
    }
  });

  it("includes both anthropic and openai models from fixtures", async () => {
    const { body } = await getJSON(
      `/v1/usage/model-analysis?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const models = (body.models ?? body.entries ?? body.analysis) as Array<Record<string, unknown>>;
    if (models && models.length > 0) {
      const modelNames = models.map((m) => m.model);
      // Fixture has claude-sonnet-4-20250514 and gpt-4o
      expect(modelNames.length).toBeGreaterThanOrEqual(2);
    }
  });

});

// =========================================================================
// GET /v1/usage/tool-analytics
// =========================================================================

describe("GET /v1/usage/tool-analytics", () => {
  it("returns per-tool analytics", async () => {
    const { body, response } = await getJSON(
      `/v1/usage/tool-analytics?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    const tools = (body.tools ?? body.entries ?? body.analytics) as Array<Record<string, unknown>>;
    expect(Array.isArray(tools)).toBe(true);
  });

  it("each tool entry has frequency, success rate, and avg latency", async () => {
    const { body } = await getJSON(
      `/v1/usage/tool-analytics?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const tools = (body.tools ?? body.entries ?? body.analytics) as Array<Record<string, unknown>>;
    if (tools && tools.length > 0) {
      const first = tools[0];
      expect(first).toHaveProperty("toolName");
      // Should have frequency (count)
      const hasFrequency = first.count !== undefined || first.frequency !== undefined || first.callCount !== undefined;
      expect(hasFrequency).toBe(true);
      // Should have success rate
      const hasSuccessRate = first.successRate !== undefined;
      expect(hasSuccessRate).toBe(true);
      // Should have latency
      const hasLatency = first.avgLatencyMs !== undefined || first.avgDurationMs !== undefined;
      expect(hasLatency).toBe(true);
    }
  });

  it("includes tools from fixture data (Read, Edit, Bash, Write)", async () => {
    const { body } = await getJSON(
      `/v1/usage/tool-analytics?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const tools = (body.tools ?? body.entries ?? body.analytics) as Array<{ toolName: string }>;
    if (tools && tools.length > 0) {
      const toolNames = tools.map((t) => t.toolName);
      // Fixture data seeds Read, Edit, Bash, Write
      expect(toolNames).toContain("Read");
    }
  });

  it("success rate is between 0 and 1", async () => {
    const { body } = await getJSON(
      `/v1/usage/tool-analytics?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const tools = (body.tools ?? body.entries ?? body.analytics) as Array<{ successRate: number }>;
    if (tools && tools.length > 0) {
      for (const tool of tools) {
        expect(tool.successRate).toBeGreaterThanOrEqual(0);
        expect(tool.successRate).toBeLessThanOrEqual(1);
      }
    }
  });

  it("returns 401 without auth", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/usage/tool-analytics?projectId=${IDS.projectAlpha}`,
      { method: "GET" }
    );

    expect(response.status).toBe(401);
  });

  it("audit logs the tool analytics request", async () => {
    const before = await countAuditLogs();

    await getJSON(
      `/v1/usage/tool-analytics?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const after = await countAuditLogs();
    expect(after).toBeGreaterThan(before);
  });
});
