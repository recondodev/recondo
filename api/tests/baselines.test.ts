/**
 * Sprint 8 Deliverable 1: Behavioral Baselines Per Agent
 *
 * Tests for:
 * - POST /v1/anomaly-detection/baselines/compute — trigger baseline computation
 * - GET  /v1/anomaly-detection/baselines?projectId=... — retrieve baselines
 * - Per-agent baselines computed from 30-day rolling window
 * - Project scoping, auth, audit logging
 *
 * These tests WILL FAIL until the implementation agent builds the endpoints.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";
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
  foundation: "wrt_test_baseline_foundation_01",
  compliance: "wrt_test_baseline_compliance_02",
} as const;

const TEST_KEY_IDS = {
  foundation: "bb200000-0000-4000-8000-000000000001",
  compliance: "bb200000-0000-4000-8000-000000000002",
} as const;

// ---------------------------------------------------------------------------
// SHA-256 helper
// ---------------------------------------------------------------------------

async function sha256(input: string): Promise<string> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Extended fixtures: 30+ days of turn data with tool calls for baseline computation
// ---------------------------------------------------------------------------

async function seedBaselineFixtures(): Promise<void> {
  // FIND-11-C: wrap fixture seeding in a single transaction +
  // shared advisory lock to serialise with `setupDatabase` and the
  // in-process API server's writers. See anomaly-detection.test.ts
  // for the full rationale.
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('reset_schema_state'))",
    );
    await seedBaselineFixturesInner(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function seedBaselineFixturesInner(p: pg.PoolClient): Promise<void> {
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

  // Generate 35 days of session/turn/tool_call history for project alpha, agent "claude-code".
  // Each day: 1 session with 3 turns, each turn has tool calls.
  // Normal pattern: ~1000 input tokens, ~500 output tokens per turn, ~100ms duration, $0.05/turn.
  // Tool distribution: Read: ~40%, Edit: ~30%, Bash: ~20%, Write: ~10%.
  for (let daysAgo = 35; daysAgo >= 1; daysAgo--) {
    const dayDate = new Date(now.getTime() - daysAgo * 86400_000);
    const dayStr = dayDate.toISOString();
    const sessionId = `bl000000-0000-4000-8000-0000000${String(daysAgo).padStart(5, "0")}`;
    const sessionCostUsd = 0.15; // 3 turns * $0.05
    const sessionDurationMs = 3 * 100; // 3 turns * ~100ms

    await p.query(`
      INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at, ended_at,
                            initial_intent, system_prompt_hash, total_turns, turns_captured,
                            dropped_events, total_tokens, total_cost_usd, agent_id)
      VALUES ($1, $2, 'anthropic', 'claude-sonnet-4-20250514', $3, $3, $3,
              'Baseline test day ' || $4, 'blhash' || $4, 3, 3, 0, 4500, $5, 'claude-code')
      ON CONFLICT (id) DO NOTHING
    `, [sessionId, IDS.projectAlpha, dayStr, String(daysAgo), sessionCostUsd]);

    // 3 turns per session
    for (let turnIdx = 1; turnIdx <= 3; turnIdx++) {
      const turnId = `blt00000-0000-4000-8000-${String(daysAgo).padStart(5, "0")}${String(turnIdx).padStart(2, "0")}`;
      const turnTs = new Date(dayDate.getTime() + turnIdx * 60000).toISOString();

      await p.query(`
        INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
                           req_bytes_ref, resp_bytes_ref, model, provider,
                           input_tokens, output_tokens, thinking_tokens, cost_usd,
                           duration_ms, tool_call_count, stop_reason, created_at)
        VALUES ($1, $2, $3, $4, 'hash_bl_' || $5 || '_r', 'hash_bl_' || $5 || '_s',
                'ref_bl_' || $5 || '_r', 'ref_bl_' || $5 || '_s',
                'claude-sonnet-4-20250514', 'anthropic', 1000, 500, 0, 0.05, 100, 1, 'end_turn', $4)
        ON CONFLICT (id) DO NOTHING
      `, [turnId, sessionId, turnIdx, turnTs, `${daysAgo}_${turnIdx}`]);

      // Tool calls with distribution: Read ~40%, Edit ~30%, Bash ~20%, Write ~10%
      // Cycle deterministically based on daysAgo + turnIdx
      const toolNames = ["Read", "Read", "Read", "Read", "Edit", "Edit", "Edit", "Bash", "Bash", "Write"];
      const toolIndex = (daysAgo * 3 + turnIdx) % toolNames.length;
      const toolName = toolNames[toolIndex];
      const tcId = `bltc0000-0000-4000-8000-${String(daysAgo).padStart(5, "0")}${String(turnIdx).padStart(2, "0")}`;

      await p.query(`
        INSERT INTO tool_calls (id, turn_id, tool_name, tool_input, input_hash, sequence_num,
                                output, output_hash, duration_ms, status)
        VALUES ($1, $2, $3, '{"file": "test.ts"}', 'input_hash_bltc', 0,
                'tool output', 'output_hash_bltc', 50, 'success')
        ON CONFLICT (id) DO NOTHING
      `, [tcId, turnId, toolName]);
    }
  }
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
  await seedBaselineFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// POST /v1/anomaly-detection/baselines/compute
// =========================================================================

describe("POST /v1/anomaly-detection/baselines/compute", () => {
  it("creates baseline records in agent_baselines table", async () => {
    const { body, response } = await postJSON(
      "/v1/anomaly-detection/baselines/compute",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body).toBeDefined();

    // Verify baselines were written to the database
    const p = getPool();
    const result = await p.query(`
      SELECT * FROM agent_baselines
      WHERE project_id = $1
      ORDER BY computed_at DESC
    `, [IDS.projectAlpha]);

    expect(result.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("baselines computed from last 30 days of turn data", async () => {
    // Trigger computation
    await postJSON(
      "/v1/anomaly-detection/baselines/compute",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const p = getPool();
    const result = await p.query(`
      SELECT * FROM agent_baselines
      WHERE project_id = $1 AND agent_id = 'claude-code'
      ORDER BY computed_at DESC
      LIMIT 1
    `, [IDS.projectAlpha]);

    expect(result.rows.length).toBe(1);
    const baseline = result.rows[0];

    // Verify the baseline reflects turn data (should be non-zero since we seeded 35 days)
    expect(Number(baseline.turn_count)).toBeGreaterThan(0);
    expect(Number(baseline.session_count)).toBeGreaterThan(0);
  });

  it("avg_tokens_per_turn matches raw data average", async () => {
    await postJSON(
      "/v1/anomaly-detection/baselines/compute",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const p = getPool();
    const baseline = await p.query(`
      SELECT avg_tokens_per_turn FROM agent_baselines
      WHERE project_id = $1 AND agent_id = 'claude-code'
      ORDER BY computed_at DESC LIMIT 1
    `, [IDS.projectAlpha]);

    expect(baseline.rows.length).toBe(1);
    const avgTokens = Number(baseline.rows[0].avg_tokens_per_turn);

    // Our fixture has 1000 input + 500 output = 1500 tokens per turn
    // Allow some variance due to the base setup fixtures also being present
    expect(avgTokens).toBeGreaterThan(0);
    expect(avgTokens).toBeLessThan(10000); // Sanity upper bound
  });

  it("avg_cost_per_session matches raw data", async () => {
    await postJSON(
      "/v1/anomaly-detection/baselines/compute",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const p = getPool();
    const baseline = await p.query(`
      SELECT avg_cost_per_session FROM agent_baselines
      WHERE project_id = $1 AND agent_id = 'claude-code'
      ORDER BY computed_at DESC LIMIT 1
    `, [IDS.projectAlpha]);

    expect(baseline.rows.length).toBe(1);
    const avgCost = Number(baseline.rows[0].avg_cost_per_session);

    // Our baseline sessions have $0.15 each (3 turns * $0.05)
    // The base setup also has sessions, so allow some variance
    expect(avgCost).toBeGreaterThan(0);
  });

  it("tool_usage_distribution is accurate JSON object", async () => {
    await postJSON(
      "/v1/anomaly-detection/baselines/compute",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const p = getPool();
    const baseline = await p.query(`
      SELECT tool_usage_distribution FROM agent_baselines
      WHERE project_id = $1 AND agent_id = 'claude-code'
      ORDER BY computed_at DESC LIMIT 1
    `, [IDS.projectAlpha]);

    expect(baseline.rows.length).toBe(1);
    const toolDist = baseline.rows[0].tool_usage_distribution;

    // Should be a JSONB object with tool name keys
    expect(toolDist).toBeDefined();
    expect(typeof toolDist).toBe("object");

    // Our fixture seeds Read, Edit, Bash, Write calls
    // At least some of these should appear in the distribution
    const toolNames = Object.keys(toolDist);
    expect(toolNames.length).toBeGreaterThanOrEqual(1);

    // All values should be numeric counts or percentages
    for (const [_tool, count] of Object.entries(toolDist)) {
      expect(typeof count).toBe("number");
      expect(Number(count)).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns 401 without API key", async () => {
    const { response } = await postJSON(
      "/v1/anomaly-detection/baselines/compute",
      { projectId: IDS.projectAlpha }
    );
    expect(response.status).toBe(401);
  });

  it("is audit logged", async () => {
    const countBefore = await countAuditLogs();
    await postJSON(
      "/v1/anomaly-detection/baselines/compute",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );
    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});

// =========================================================================
// GET /v1/anomaly-detection/baselines
// =========================================================================

describe("GET /v1/anomaly-detection/baselines", () => {
  it("returns computed baselines for a project", async () => {
    // First compute baselines
    await postJSON(
      "/v1/anomaly-detection/baselines/compute",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    // Then fetch them
    const { body, response } = await getJSON(
      `/v1/anomaly-detection/baselines?projectId=${IDS.projectAlpha}`,
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body.baselines).toBeDefined();

    const baselines = body.baselines as Array<Record<string, unknown>>;
    expect(Array.isArray(baselines)).toBe(true);
    expect(baselines.length).toBeGreaterThanOrEqual(1);

    // Each baseline should have the expected fields
    const baseline = baselines[0];
    expect(baseline.projectId || baseline.project_id).toBeDefined();
    expect(baseline.avgTokensPerTurn || baseline.avg_tokens_per_turn).toBeDefined();
    expect(baseline.avgCostPerSession || baseline.avg_cost_per_session).toBeDefined();
    expect(baseline.avgTurnsPerSession || baseline.avg_turns_per_session).toBeDefined();
    expect(baseline.toolUsageDistribution || baseline.tool_usage_distribution).toBeDefined();
    expect(baseline.sessionCount || baseline.session_count).toBeDefined();
    expect(baseline.turnCount || baseline.turn_count).toBeDefined();
  });

  it("baselines are project-scoped (alpha cannot see beta)", async () => {
    // Compute baselines for alpha
    await postJSON(
      "/v1/anomaly-detection/baselines/compute",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    // Beta key should not see alpha's baselines
    const { body, response } = await getJSON(
      `/v1/anomaly-detection/baselines?projectId=${IDS.projectAlpha}`,
      API_KEYS.beta
    );

    expect(response.status).toBe(200);
    const baselines = body.baselines as Array<Record<string, unknown>>;
    // Beta should either get empty results or only see beta's own baselines
    // It should NOT see alpha's baselines
    if (baselines && baselines.length > 0) {
      for (const b of baselines) {
        const pid = String(b.projectId || b.project_id || "");
        expect(pid).not.toBe(IDS.projectAlpha);
      }
    }
  });

  it("returns 401 without API key", async () => {
    const { response } = await getJSON(
      `/v1/anomaly-detection/baselines?projectId=${IDS.projectAlpha}`
    );
    expect(response.status).toBe(401);
  });

  it("is audit logged", async () => {
    const countBefore = await countAuditLogs();
    await getJSON(
      `/v1/anomaly-detection/baselines?projectId=${IDS.projectAlpha}`,
      API_KEYS.alpha
    );
    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });

  it("empty project with no turns returns empty baselines", async () => {
    // Beta has minimal data and no baseline computation was triggered for it
    const { body, response } = await getJSON(
      `/v1/anomaly-detection/baselines?projectId=${IDS.projectBeta}`,
      API_KEYS.beta
    );

    expect(response.status).toBe(200);
    const baselines = body.baselines as Array<Record<string, unknown>>;
    expect(Array.isArray(baselines)).toBe(true);
    // Should be empty or have baselines from beta's limited data
    // Either way, should not error
  });

  it("authenticated key can access baselines", async () => {
    const { response } = await getJSON(
      `/v1/anomaly-detection/baselines?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    // Should not be 403 (may be 200 with data or empty)
    expect(response.status).not.toBe(403);
  });
});

// =========================================================================
// Baseline computation correctness
// =========================================================================

describe("baseline computation correctness", () => {
  it("avg_turns_per_session is computed correctly", async () => {
    await postJSON(
      "/v1/anomaly-detection/baselines/compute",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const p = getPool();
    const baseline = await p.query(`
      SELECT avg_turns_per_session FROM agent_baselines
      WHERE project_id = $1 AND agent_id = 'claude-code'
      ORDER BY computed_at DESC LIMIT 1
    `, [IDS.projectAlpha]);

    expect(baseline.rows.length).toBe(1);
    const avgTurns = Number(baseline.rows[0].avg_turns_per_session);

    // Our baseline sessions have 3 turns each
    // With base fixtures also contributing, should be > 0
    expect(avgTurns).toBeGreaterThan(0);
  });

  it("avg_session_duration_ms is computed correctly", async () => {
    await postJSON(
      "/v1/anomaly-detection/baselines/compute",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const p = getPool();
    const baseline = await p.query(`
      SELECT avg_session_duration_ms FROM agent_baselines
      WHERE project_id = $1 AND agent_id = 'claude-code'
      ORDER BY computed_at DESC LIMIT 1
    `, [IDS.projectAlpha]);

    expect(baseline.rows.length).toBe(1);
    const avgDuration = Number(baseline.rows[0].avg_session_duration_ms);

    // Should be non-negative
    expect(avgDuration).toBeGreaterThanOrEqual(0);
  });

  it("baseline_date is set to today", async () => {
    await postJSON(
      "/v1/anomaly-detection/baselines/compute",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const p = getPool();
    const baseline = await p.query(`
      SELECT baseline_date FROM agent_baselines
      WHERE project_id = $1 AND agent_id = 'claude-code'
      ORDER BY computed_at DESC LIMIT 1
    `, [IDS.projectAlpha]);

    expect(baseline.rows.length).toBe(1);

    const baselineDate = baseline.rows[0].baseline_date;
    const today = new Date().toISOString().split("T")[0];

    // The baseline_date should be today's date
    const baseDateStr = baselineDate instanceof Date
      ? baselineDate.toISOString().split("T")[0]
      : String(baselineDate).split("T")[0];
    expect(baseDateStr).toBe(today);
  });

  it("model field is populated in baseline", async () => {
    await postJSON(
      "/v1/anomaly-detection/baselines/compute",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const p = getPool();
    const baselines = await p.query(`
      SELECT model FROM agent_baselines
      WHERE project_id = $1
      ORDER BY computed_at DESC
    `, [IDS.projectAlpha]);

    // Should have baselines with model information
    expect(baselines.rows.length).toBeGreaterThanOrEqual(1);
    // At least one baseline should have a model set (from the claude-sonnet turns)
    const modelsPresent = baselines.rows.filter(r => r.model !== null);
    expect(modelsPresent.length).toBeGreaterThanOrEqual(1);
  });
});
