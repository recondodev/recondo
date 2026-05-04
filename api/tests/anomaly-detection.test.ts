/**
 * Sprint 8 Deliverable 2 & 3: Anomaly Detection — Evaluation and Async Pipeline
 *
 * Tests for:
 * - POST /v1/anomaly-detection/evaluate — evaluate recent turns against baselines
 * - GET  /v1/anomaly-detection/anomalies — list detected anomalies with filters
 * - 4 anomaly types: cost_spike, latency_spike, decision_outlier, rejection_pattern
 * - Anomaly scoring between 0.0 and 1.0
 * - Async evaluation (runs in API layer, not gateway)
 * - 
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
  foundation: "wrt_test_anomdet_foundation_01",
  compliance: "wrt_test_anomdet_compliance_02",
} as const;

const TEST_KEY_IDS = {
  foundation: "bb300000-0000-4000-8000-000000000001",
  compliance: "bb300000-0000-4000-8000-000000000002",
} as const;

// ---------------------------------------------------------------------------
// SHA-256 helper
// ---------------------------------------------------------------------------

async function sha256(input: string): Promise<string> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Extended fixtures for anomaly detection
// ---------------------------------------------------------------------------

/**
 * Seeds:
 * 1. Pre-computed baseline record (so evaluateAnomalies has something to compare against)
 * 2. Normal turns (within baseline range)
 * 3. Anomalous turns:
 *    - One with extreme cost ($50 session vs $1 baseline avg)
 *    - One with extreme latency (5000ms vs 100ms baseline avg)
 *    - One with a never-before-seen tool ("DeployNuke")
 *    - Three consecutive failing tool calls (same tool, rejection_pattern)
 */
async function seedAnomalyDetectionFixtures(): Promise<void> {
  // FIND-11-C: prior version called `getPool().query()` directly
  // outside any transaction. Each statement ran on a different pool
  // connection, so there was no isolation between this seed and the
  // in-process API server's pool — a concurrent dashboard or
  // anomaly-evaluator request could observe half-inserted FK rows
  // and fail with "violates foreign key constraint". Reviewers
  // reproduced cascade failures from that pattern.
  //
  // Fix: wrap the entire seed in BEGIN + pg_advisory_xact_lock +
  // COMMIT on a single PoolClient, using the SAME lock key
  // (`hashtext('reset_schema_state')`) as `setupDatabase` so the
  // two operations serialise against each other.
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('reset_schema_state'))",
    );
    await seedAnomalyDetectionFixturesInner(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Connection may be in unknown state; release it either way.
    });
    throw err;
  } finally {
    client.release();
  }
}

async function seedAnomalyDetectionFixturesInner(
  p: pg.PoolClient,
): Promise<void> {
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

  // Create the agent_baselines table (Sprint 8 schema)
  await p.query(`
    CREATE TABLE IF NOT EXISTS agent_baselines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id TEXT NOT NULL,
      agent_id TEXT,
      model TEXT,
      baseline_date DATE NOT NULL,
      avg_tokens_per_turn DOUBLE PRECISION DEFAULT 0,
      avg_cost_per_session DOUBLE PRECISION DEFAULT 0,
      avg_turns_per_session DOUBLE PRECISION DEFAULT 0,
      avg_session_duration_ms DOUBLE PRECISION DEFAULT 0,
      tool_usage_distribution JSONB,
      session_count INT DEFAULT 0,
      turn_count INT DEFAULT 0,
      computed_at TIMESTAMPTZ DEFAULT now(),
      stddev_cost_per_session DOUBLE PRECISION DEFAULT 0,
      stddev_tokens_per_turn DOUBLE PRECISION DEFAULT 0,
      stddev_latency_ms DOUBLE PRECISION DEFAULT 0,
      avg_latency_ms DOUBLE PRECISION DEFAULT 0
    );
  `);

  // Insert a pre-computed baseline for alpha project, agent "claude-code"
  // Baseline: avg_cost_per_session=$1.00, stddev=$0.20
  //           avg_tokens_per_turn=1500, stddev=200
  //           avg latency ~100ms, stddev=20
  //           Tool distribution: Read:40, Edit:30, Bash:20, Write:10
  await p.query(`
    INSERT INTO agent_baselines (
      project_id, agent_id, model, baseline_date,
      avg_tokens_per_turn, avg_cost_per_session, avg_turns_per_session,
      avg_session_duration_ms, avg_latency_ms, tool_usage_distribution,
      session_count, turn_count,
      stddev_cost_per_session, stddev_tokens_per_turn, stddev_latency_ms
    ) VALUES (
      $1, 'claude-code', 'claude-sonnet-4-20250514', CURRENT_DATE,
      1500, 1.00, 3,
      300, 100, '{"Read": 40, "Edit": 30, "Bash": 20, "Write": 10}'::jsonb,
      30, 90,
      0.20, 200, 20
    )
  `, [IDS.projectAlpha]);

  // -----------------------------------------------------------------------
  // Normal session (within baseline ranges)
  // -----------------------------------------------------------------------
  const normalSessionId = "ad000000-0000-4000-8000-000000000001";
  const normalTs = new Date(now.getTime() - 3600_000).toISOString();

  await p.query(`
    INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at,
                          initial_intent, system_prompt_hash, total_turns, turns_captured,
                          dropped_events, total_tokens, total_cost_usd, agent_id)
    VALUES ($1, $2, 'anthropic', 'claude-sonnet-4-20250514', $3, $3,
            'Normal session', 'normalhash', 3, 3, 0, 4500, 0.90, 'claude-code')
    ON CONFLICT (id) DO NOTHING
  `, [normalSessionId, IDS.projectAlpha, normalTs]);

  for (let i = 1; i <= 3; i++) {
    const turnId = `adt00000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`;
    const turnTs = new Date(now.getTime() - 3600_000 + i * 60000).toISOString();
    await p.query(`
      INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
                         req_bytes_ref, resp_bytes_ref, model, provider,
                         input_tokens, output_tokens, thinking_tokens, cost_usd,
                         duration_ms, tool_call_count, stop_reason, created_at)
      VALUES ($1, $2, $3::BIGINT, $4, 'hash_norm_r_' || $3, 'hash_norm_s_' || $3,
              'ref_norm_r', 'ref_norm_s',
              'claude-sonnet-4-20250514', 'anthropic', 1000, 500, 0, 0.30, 100, 1, 'end_turn', $4)
      ON CONFLICT (id) DO NOTHING
    `, [turnId, normalSessionId, String(i), turnTs]);

    // Normal tool calls (Read, Edit)
    const toolName = i <= 2 ? "Read" : "Edit";
    const tcId = `adtc0000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`;
    await p.query(`
      INSERT INTO tool_calls (id, turn_id, tool_name, tool_input, input_hash, sequence_num,
                              output, output_hash, duration_ms, status)
      VALUES ($1, $2, $3, '{"file": "test.ts"}', 'ih_norm', 0,
              'output', 'oh_norm', 50, 'success')
      ON CONFLICT (id) DO NOTHING
    `, [tcId, turnId, toolName]);
  }

  // -----------------------------------------------------------------------
  // Anomalous session: COST SPIKE ($50 vs $1 baseline avg — way beyond 3sigma)
  // -----------------------------------------------------------------------
  const costSpikeSessionId = "ad000000-0000-4000-8000-000000000010";
  const costSpikeTs = new Date(now.getTime() - 1800_000).toISOString();

  await p.query(`
    INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at,
                          initial_intent, system_prompt_hash, total_turns, turns_captured,
                          dropped_events, total_tokens, total_cost_usd, agent_id)
    VALUES ($1, $2, 'anthropic', 'claude-sonnet-4-20250514', $3, $3,
            'Cost spike session', 'costspikehash', 3, 3, 0, 300000, 50.00, 'claude-code')
    ON CONFLICT (id) DO NOTHING
  `, [costSpikeSessionId, IDS.projectAlpha, costSpikeTs]);

  for (let i = 1; i <= 3; i++) {
    const turnId = `adt00000-0000-4000-8000-0000000010${String(i).padStart(2, "0")}`;
    const turnTs = new Date(now.getTime() - 1800_000 + i * 60000).toISOString();
    await p.query(`
      INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
                         req_bytes_ref, resp_bytes_ref, model, provider,
                         input_tokens, output_tokens, thinking_tokens, cost_usd,
                         duration_ms, tool_call_count, stop_reason, created_at)
      VALUES ($1, $2, $3::BIGINT, $4, 'hash_cost_r_' || $3, 'hash_cost_s_' || $3,
              'ref_cost_r', 'ref_cost_s',
              'claude-sonnet-4-20250514', 'anthropic', 50000, 50000, 0, 16.67, 100, 1, 'end_turn', $4)
      ON CONFLICT (id) DO NOTHING
    `, [turnId, costSpikeSessionId, String(i), turnTs]);
  }

  // -----------------------------------------------------------------------
  // Anomalous session: LATENCY SPIKE (5000ms per turn vs 100ms baseline)
  // -----------------------------------------------------------------------
  const latencySpikeSessionId = "ad000000-0000-4000-8000-000000000020";
  const latencySpikeTs = new Date(now.getTime() - 1200_000).toISOString();

  await p.query(`
    INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at,
                          initial_intent, system_prompt_hash, total_turns, turns_captured,
                          dropped_events, total_tokens, total_cost_usd, agent_id)
    VALUES ($1, $2, 'anthropic', 'claude-sonnet-4-20250514', $3, $3,
            'Latency spike session', 'latspikehash', 2, 2, 0, 3000, 0.90, 'claude-code')
    ON CONFLICT (id) DO NOTHING
  `, [latencySpikeSessionId, IDS.projectAlpha, latencySpikeTs]);

  for (let i = 1; i <= 2; i++) {
    const turnId = `adt00000-0000-4000-8000-0000000020${String(i).padStart(2, "0")}`;
    const turnTs = new Date(now.getTime() - 1200_000 + i * 60000).toISOString();
    await p.query(`
      INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
                         req_bytes_ref, resp_bytes_ref, model, provider,
                         input_tokens, output_tokens, thinking_tokens, cost_usd,
                         duration_ms, tool_call_count, stop_reason, created_at)
      VALUES ($1, $2, $3::BIGINT, $4, 'hash_lat_r_' || $3, 'hash_lat_s_' || $3,
              'ref_lat_r', 'ref_lat_s',
              'claude-sonnet-4-20250514', 'anthropic', 1000, 500, 0, 0.45, 5000, 1, 'end_turn', $4)
      ON CONFLICT (id) DO NOTHING
    `, [turnId, latencySpikeSessionId, String(i), turnTs]);
  }

  // -----------------------------------------------------------------------
  // Anomalous turn: DECISION OUTLIER (uses "DeployNuke" tool — 0% in baseline)
  // -----------------------------------------------------------------------
  const outlierSessionId = "ad000000-0000-4000-8000-000000000030";
  const outlierTs = new Date(now.getTime() - 900_000).toISOString();

  await p.query(`
    INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at,
                          initial_intent, system_prompt_hash, total_turns, turns_captured,
                          dropped_events, total_tokens, total_cost_usd, agent_id)
    VALUES ($1, $2, 'anthropic', 'claude-sonnet-4-20250514', $3, $3,
            'Decision outlier session', 'outlierhash', 1, 1, 0, 1500, 0.30, 'claude-code')
    ON CONFLICT (id) DO NOTHING
  `, [outlierSessionId, IDS.projectAlpha, outlierTs]);

  const outlierTurnId = "adt00000-0000-4000-8000-000000003001";
  await p.query(`
    INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
                       req_bytes_ref, resp_bytes_ref, model, provider,
                       input_tokens, output_tokens, thinking_tokens, cost_usd,
                       duration_ms, tool_call_count, stop_reason, created_at)
    VALUES ($1, $2, 1, $3, 'hash_outlier_r', 'hash_outlier_s',
            'ref_outlier_r', 'ref_outlier_s',
            'claude-sonnet-4-20250514', 'anthropic', 1000, 500, 0, 0.30, 100, 1, 'end_turn', $3)
    ON CONFLICT (id) DO NOTHING
  `, [outlierTurnId, outlierSessionId, outlierTs]);

  // Tool call with a never-before-seen tool name
  await p.query(`
    INSERT INTO tool_calls (id, turn_id, tool_name, tool_input, input_hash, sequence_num,
                            output, output_hash, duration_ms, status)
    VALUES ('adtc0000-0000-4000-8000-000000003001', $1, 'DeployNuke', '{"target": "prod"}',
            'ih_outlier', 0, 'Deployed', 'oh_outlier', 100, 'success')
    ON CONFLICT (id) DO NOTHING
  `, [outlierTurnId]);

  // -----------------------------------------------------------------------
  // Anomalous pattern: REJECTION PATTERN (4 consecutive failed tool calls)
  // -----------------------------------------------------------------------
  const rejectSessionId = "ad000000-0000-4000-8000-000000000040";
  const rejectTs = new Date(now.getTime() - 600_000).toISOString();

  await p.query(`
    INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at,
                          initial_intent, system_prompt_hash, total_turns, turns_captured,
                          dropped_events, total_tokens, total_cost_usd, agent_id)
    VALUES ($1, $2, 'anthropic', 'claude-sonnet-4-20250514', $3, $3,
            'Rejection pattern session', 'rejecthash', 4, 4, 0, 6000, 1.20, 'claude-code')
    ON CONFLICT (id) DO NOTHING
  `, [rejectSessionId, IDS.projectAlpha, rejectTs]);

  for (let i = 1; i <= 4; i++) {
    const turnId = `adt00000-0000-4000-8000-0000000040${String(i).padStart(2, "0")}`;
    const turnTs = new Date(now.getTime() - 600_000 + i * 60000).toISOString();
    await p.query(`
      INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
                         req_bytes_ref, resp_bytes_ref, model, provider,
                         input_tokens, output_tokens, thinking_tokens, cost_usd,
                         duration_ms, tool_call_count, stop_reason, created_at)
      VALUES ($1, $2, $3::BIGINT, $4, 'hash_rej_r_' || $3, 'hash_rej_s_' || $3,
              'ref_rej_r', 'ref_rej_s',
              'claude-sonnet-4-20250514', 'anthropic', 1000, 500, 0, 0.30, 100, 1, 'end_turn', $4)
      ON CONFLICT (id) DO NOTHING
    `, [turnId, rejectSessionId, String(i), turnTs]);

    // Each turn has a failing Bash tool call (same tool, consecutive failures)
    const tcId = `adtc0000-0000-4000-8000-0000000040${String(i).padStart(2, "0")}`;
    await p.query(`
      INSERT INTO tool_calls (id, turn_id, tool_name, tool_input, input_hash, sequence_num,
                              output, output_hash, duration_ms, error, status)
      VALUES ($1, $2, 'Bash', '{"command": "npm deploy"}', 'ih_rej', 0,
              NULL, NULL, 100, 'Command failed: permission denied', 'error')
      ON CONFLICT (id) DO NOTHING
    `, [tcId, turnId]);
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
  await seedAnomalyDetectionFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// POST /v1/anomaly-detection/evaluate
// =========================================================================

describe("POST /v1/anomaly-detection/evaluate", () => {
  it("returns list of detected anomalies", async () => {
    const { body, response } = await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body.anomalies).toBeDefined();

    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    expect(Array.isArray(anomalies)).toBe(true);
    // We seeded multiple anomalous conditions -- should detect at least one
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
  });

  it("detects cost_spike when session cost > 3 sigma from baseline", async () => {
    const { body } = await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    const costSpikes = anomalies.filter(
      (a) => a.type === "cost_spike" || a.anomalyType === "cost_spike"
    );

    // The $50 session should trigger a cost_spike (baseline avg=$1, stddev=$0.20, 3sigma=$1.60)
    expect(costSpikes.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT detect cost_spike for normal cost sessions", async () => {
    const { body } = await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    const costSpikes = anomalies.filter(
      (a) => a.type === "cost_spike" || a.anomalyType === "cost_spike"
    );

    // Check that the normal session ($0.90) is NOT flagged as a cost spike
    for (const spike of costSpikes) {
      const sessionId = String(spike.sessionId || spike.session_id || "");
      // The normal session should not appear
      expect(sessionId).not.toBe("ad000000-0000-4000-8000-000000000001");
    }
  });

  it("detects latency_spike when turn latency > 3 sigma from baseline", async () => {
    const { body } = await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    const latencySpikes = anomalies.filter(
      (a) => a.type === "latency_spike" || a.anomalyType === "latency_spike"
    );

    // The 5000ms session should trigger a latency spike (baseline avg=100ms, stddev=20, 3sigma=160ms)
    expect(latencySpikes.length).toBeGreaterThanOrEqual(1);
  });

  it("detects decision_outlier for never-before-seen tool", async () => {
    const { body } = await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    const outliers = anomalies.filter(
      (a) => a.type === "decision_outlier" || a.anomalyType === "decision_outlier"
    );

    // The "DeployNuke" tool (0% in baseline distribution) should trigger decision_outlier
    expect(outliers.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT detect decision_outlier for commonly used tool", async () => {
    const { body } = await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    const outliers = anomalies.filter(
      (a) => a.type === "decision_outlier" || a.anomalyType === "decision_outlier"
    );

    // "Read" (40% in baseline) and "Edit" (30%) should NOT be flagged
    for (const outlier of outliers) {
      const toolName = String(
        outlier.toolName || outlier.tool_name || (outlier.metadata as Record<string, unknown>)?.toolName || ""
      );
      if (toolName) {
        expect(toolName).not.toBe("Read");
        expect(toolName).not.toBe("Edit");
      }
    }
  });

  it("detects rejection_pattern for consecutive failing tool calls", async () => {
    const { body } = await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    const rejections = anomalies.filter(
      (a) => a.type === "rejection_pattern" || a.anomalyType === "rejection_pattern"
    );

    // 4 consecutive Bash failures should trigger rejection_pattern (> 3 threshold)
    expect(rejections.length).toBeGreaterThanOrEqual(1);
  });

  it("anomaly score is between 0.0 and 1.0", async () => {
    const { body } = await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    expect(anomalies.length).toBeGreaterThanOrEqual(1);

    for (const anomaly of anomalies) {
      const score = Number(anomaly.score ?? anomaly.anomalyScore ?? 0);
      expect(score).toBeGreaterThanOrEqual(0.0);
      expect(score).toBeLessThanOrEqual(1.0);
    }
  });

  it("anomaly creates AnomalyEvent record in DB", async () => {
    const p = getPool();

    // Clear existing anomalies of these types to reset dedup state before counting
    await p.query(`
      DELETE FROM anomaly_events
      WHERE anomaly_type IN ('cost_spike', 'latency_spike', 'decision_outlier', 'rejection_pattern')
    `);

    // Trigger evaluation — should insert fresh anomaly records now that dedup state is cleared
    await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    // Count anomaly events after — must be > 0
    const afterResult = await p.query(`
      SELECT count(*)::int AS n FROM anomaly_events
      WHERE anomaly_type IN ('cost_spike', 'latency_spike', 'decision_outlier', 'rejection_pattern')
    `);
    const countAfter = afterResult.rows[0].n;

    expect(countAfter).toBeGreaterThan(0);
  });

  it("multiple anomaly types can fire on same evaluation", async () => {
    const { body } = await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    const types = new Set(anomalies.map((a) => String(a.type || a.anomalyType)));

    // We seeded cost_spike, latency_spike, decision_outlier, and rejection_pattern triggers
    // At least 2 different types should fire
    expect(types.size).toBeGreaterThanOrEqual(2);
  });

  it("returns 401 without API key", async () => {
    const { response } = await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectAlpha }
    );
    expect(response.status).toBe(401);
  });

  it("is project-scoped (alpha sees only alpha anomalies)", async () => {
    // Evaluate for alpha
    const { body: alphaBody } = await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const alphaAnomalies = alphaBody.anomalies as Array<Record<string, unknown>>;
    // All detected anomalies should be from alpha project sessions
    for (const anomaly of alphaAnomalies) {
      const pid = String(anomaly.projectId || anomaly.project_id || "");
      if (pid) {
        expect(pid).toBe(IDS.projectAlpha);
      }
    }
  });

  it("authenticated key can access evaluation", async () => {
    const { response } = await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    expect(response.status).not.toBe(403);
  });

  it("is audit logged", async () => {
    const countBefore = await countAuditLogs();
    await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );
    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });

  it("no baselines leads to no anomalies detected (graceful handling)", async () => {
    // Beta has no baselines computed
    const { body, response } = await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectBeta },
      API_KEYS.beta
    );

    expect(response.status).toBe(200);
    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    expect(Array.isArray(anomalies)).toBe(true);
    // Should be empty because there are no baselines for beta
    expect(anomalies.length).toBe(0);
  });
});

// =========================================================================
// GET /v1/anomaly-detection/anomalies
// =========================================================================

describe("GET /v1/anomaly-detection/anomalies", () => {
  it("returns detected anomalies for a project", async () => {
    // First, trigger evaluation to populate anomaly records
    await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const { body, response } = await getJSON(
      `/v1/anomaly-detection/anomalies?projectId=${IDS.projectAlpha}`,
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body.anomalies).toBeDefined();

    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    expect(Array.isArray(anomalies)).toBe(true);
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
  });

  it("filters anomalies by type", async () => {
    // Ensure anomalies exist
    await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const { body, response } = await getJSON(
      `/v1/anomaly-detection/anomalies?projectId=${IDS.projectAlpha}&type=cost_spike`,
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    expect(Array.isArray(anomalies)).toBe(true);

    // All returned anomalies should be of type cost_spike
    for (const anomaly of anomalies) {
      const anomalyType = String(anomaly.type || anomaly.anomalyType || anomaly.event_type);
      expect(anomalyType).toBe("cost_spike");
    }
  });

  it("filters anomalies by severity", async () => {
    await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    const { body, response } = await getJSON(
      `/v1/anomaly-detection/anomalies?projectId=${IDS.projectAlpha}&severity=critical`,
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    expect(Array.isArray(anomalies)).toBe(true);

    // All returned anomalies should have the requested severity
    for (const anomaly of anomalies) {
      expect(String(anomaly.severity)).toBe("critical");
    }
  });

  it("returns 401 without API key", async () => {
    const { response } = await getJSON(
      `/v1/anomaly-detection/anomalies?projectId=${IDS.projectAlpha}`
    );
    expect(response.status).toBe(401);
  });

  it("is project-scoped (beta cannot see alpha anomalies)", async () => {
    const { body, response } = await getJSON(
      `/v1/anomaly-detection/anomalies?projectId=${IDS.projectAlpha}`,
      API_KEYS.beta
    );

    expect(response.status).toBe(200);
    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    // Beta should get empty results for alpha's project
    expect(anomalies.length).toBe(0);
  });

  it("is audit logged", async () => {
    const countBefore = await countAuditLogs();
    await getJSON(
      `/v1/anomaly-detection/anomalies?projectId=${IDS.projectAlpha}`,
      API_KEYS.alpha
    );
    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });

  it("admin key can see anomalies across all projects", async () => {
    const { body, response } = await getJSON(
      "/v1/anomaly-detection/anomalies",
      API_KEYS.admin
    );

    expect(response.status).toBe(200);
    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    expect(Array.isArray(anomalies)).toBe(true);
    // Admin sees everything
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
  });
});

// =========================================================================
// Async pipeline — no capture latency impact (Deliverable 3)
// =========================================================================

describe("async pipeline — anomaly detection in API layer", () => {
  it("anomaly evaluation reads from DB (does not block gateway writes)", async () => {
    // The anomaly detection evaluate endpoint reads turns/sessions from DB
    // that were already written by the gateway. This test confirms the evaluate
    // endpoint succeeds using DB data (not intercepting live traffic).
    const { body, response } = await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body.anomalies).toBeDefined();

    // The endpoint should return results based on DB reads, not live capture
    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    expect(Array.isArray(anomalies)).toBe(true);
  });

  it("evaluation creates anomaly_events records that persist in DB", async () => {
    const p = getPool();

    await postJSON(
      "/v1/anomaly-detection/evaluate",
      { projectId: IDS.projectAlpha },
      API_KEYS.alpha
    );

    // Anomaly events should be in the DB for later retrieval by GET endpoint
    const result = await p.query(`
      SELECT * FROM anomaly_events
      WHERE anomaly_type IN ('cost_spike', 'latency_spike', 'decision_outlier', 'rejection_pattern')
      ORDER BY detected_at DESC
      LIMIT 10
    `);

    expect(result.rows.length).toBeGreaterThanOrEqual(1);

    // Each event should have required fields
    for (const event of result.rows) {
      expect(event.anomaly_type).toBeDefined();
      expect(event.severity).toBeDefined();
      expect(event.detected_at).toBeDefined();
    }
  });
});
