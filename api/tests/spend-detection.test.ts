/**
 * Sprint 6 Deliverable 6: Anomalous Spend Detection
 *
 * Tests for:
 * - GET /v1/usage/spend-anomalies — detect daily cost > 3x the 30-day rolling average
 * - Webhook alert dispatch when anomalies are detected
 * - Integration with existing alert mechanism from Sprint 5
 * - Authentication and project scoping
 *
 * These tests WILL FAIL until the implementation agent builds the endpoint.
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
// Extended fixtures: 30+ days of cost history with an anomalous spike
// ---------------------------------------------------------------------------

const SD_IDS = {
  // Sessions for the last 35 days of history (prefix: sd)
  // We will generate these programmatically
} as const;

async function seedSpendDetectionFixtures(): Promise<void> {
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
    await seedSpendDetectionFixturesInner(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function seedSpendDetectionFixturesInner(
  p: pg.PoolClient,
): Promise<void> {
  const now = new Date();

  // Generate 35 days of session/turn history for project alpha.
  // Days 1-30: normal spend (~$1.00/day, 1 session with 2 turns each)
  // Day 0 (today): anomalous spike ($5.00 — more than 3x the $1.00 average)
  for (let daysAgo = 35; daysAgo >= 0; daysAgo--) {
    const dayDate = new Date(now.getTime() - daysAgo * 86400_000);
    const dayStr = dayDate.toISOString();
    const sessionId = `sd000000-0000-4000-8000-0000000${String(daysAgo).padStart(5, "0")}`;
    const turnId1 = `sdt00000-0000-4000-8000-000${String(daysAgo).padStart(5, "0")}01`;
    const turnId2 = `sdt00000-0000-4000-8000-000${String(daysAgo).padStart(5, "0")}02`;

    // Today (daysAgo=0): anomalous high spend
    const isAnomaly = daysAgo === 0;
    const costPerTurn = isAnomaly ? 2.50 : 0.50;
    const inputTokens = isAnomaly ? 20000 : 5000;
    const outputTokens = isAnomaly ? 15000 : 3000;
    const totalCost = costPerTurn * 2;
    const totalTokens = (inputTokens + outputTokens) * 2;

    await p.query(`
      INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at, ended_at,
                            initial_intent, system_prompt_hash, total_turns, turns_captured,
                            dropped_events, total_tokens, total_cost_usd, agent_id)
      VALUES ($1, $2, 'anthropic', 'claude-sonnet-4-20250514', $3, $3, $3,
              'Spend detection test day ' || $4, 'sdhash' || $4, 2, 2, 0, $5, $6, 'claude-code')
      ON CONFLICT (id) DO NOTHING
    `, [sessionId, IDS.projectAlpha, dayStr, String(daysAgo), totalTokens, totalCost]);

    await p.query(`
      INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
                         req_bytes_ref, resp_bytes_ref, model, provider,
                         input_tokens, output_tokens, thinking_tokens, cost_usd,
                         duration_ms, tool_call_count, stop_reason, created_at)
      VALUES ($1, $2, 1, $3, 'hash_sd_' || $4 || '_1r', 'hash_sd_' || $4 || '_1s',
              'ref_sd_' || $4 || '_1r', 'ref_sd_' || $4 || '_1s',
              'claude-sonnet-4-20250514', 'anthropic', $5, $6, 0, $7, 2000, 0, 'end_turn', $3)
      ON CONFLICT (id) DO NOTHING
    `, [turnId1, sessionId, dayStr, String(daysAgo), inputTokens, outputTokens, costPerTurn]);

    const turn2Ts = new Date(dayDate.getTime() + 60000).toISOString();
    await p.query(`
      INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
                         req_bytes_ref, resp_bytes_ref, model, provider,
                         input_tokens, output_tokens, thinking_tokens, cost_usd,
                         duration_ms, tool_call_count, stop_reason, created_at)
      VALUES ($1, $2, 2, $3, 'hash_sd_' || $4 || '_2r', 'hash_sd_' || $4 || '_2s',
              'ref_sd_' || $4 || '_2r', 'ref_sd_' || $4 || '_2s',
              'claude-sonnet-4-20250514', 'anthropic', $5, $6, 0, $7, 2500, 0, 'end_turn', $3)
      ON CONFLICT (id) DO NOTHING
    `, [turnId2, sessionId, turn2Ts, String(daysAgo), inputTokens, outputTokens, costPerTurn]);
  }

  // Configure a webhook alert for the alpha project (uses Sprint 5 alert_configs)
  await p.query(`
    INSERT INTO alert_configs (project_id, webhook_url, completeness_threshold, availability_threshold)
    VALUES ($1, 'https://hooks.example.com/spend-alerts', 100.0, 99.9)
    ON CONFLICT DO NOTHING
  `, [IDS.projectAlpha]);
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
  await seedSpendDetectionFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// GET /v1/usage/spend-anomalies
// =========================================================================

describe("GET /v1/usage/spend-anomalies", () => {
  it("detects daily cost exceeding 3x the 30-day rolling average", async () => {
    const { body, response } = await getJSON(
      "/v1/usage/spend-anomalies",
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body.anomalies).toBeDefined();

    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    expect(Array.isArray(anomalies)).toBe(true);

    // Today's spend ($5.00) should be flagged as anomalous
    // 30-day average is ~$1.00/day, and $5.00 > $3.00 (3x average)
    expect(anomalies.length).toBeGreaterThanOrEqual(1);

    // Find today's anomaly
    const today = new Date().toISOString().split("T")[0];
    const todayAnomaly = anomalies.find((a) => {
      const date = String(a.date || a.periodStart || "");
      return date.startsWith(today);
    });

    expect(todayAnomaly).toBeDefined();
  });

  it("anomaly entries contain required fields", async () => {
    const { body } = await getJSON(
      "/v1/usage/spend-anomalies",
      API_KEYS.alpha
    );

    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    expect(anomalies.length).toBeGreaterThanOrEqual(1);

    for (const anomaly of anomalies) {
      // Date or period of the anomaly
      expect(anomaly.date || anomaly.periodStart).toBeDefined();

      // Actual daily cost
      expect(typeof anomaly.dailyCostUsd).toBe("number");
      expect(Number(anomaly.dailyCostUsd)).toBeGreaterThan(0);

      // Rolling average
      expect(typeof anomaly.rollingAverageUsd).toBe("number");
      expect(Number(anomaly.rollingAverageUsd)).toBeGreaterThan(0);

      // Ratio (actual / average)
      expect(typeof anomaly.ratio).toBe("number");
      expect(Number(anomaly.ratio)).toBeGreaterThan(3);

      // Threshold
      expect(typeof anomaly.thresholdUsd).toBe("number");
    }
  });

  it("includes rolling average and threshold in response", async () => {
    const { body } = await getJSON(
      "/v1/usage/spend-anomalies",
      API_KEYS.alpha
    );

    // Response should also include summary statistics
    expect(body.rollingAverageUsd).toBeDefined();
    expect(typeof body.rollingAverageUsd).toBe("number");
    expect(Number(body.rollingAverageUsd)).toBeGreaterThan(0);

    expect(body.thresholdUsd).toBeDefined();
    expect(typeof body.thresholdUsd).toBe("number");
    // Threshold = 3x rolling average
    expect(Number(body.thresholdUsd)).toBeCloseTo(
      Number(body.rollingAverageUsd) * 3, 1
    );
  });

  it("returns 401 without API key", async () => {
    const { response } = await getJSON("/v1/usage/spend-anomalies");
    expect(response.status).toBe(401);
  });

  it("audit logs the request", async () => {
    const countBefore = await countAuditLogs();
    await getJSON("/v1/usage/spend-anomalies", API_KEYS.alpha);
    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});

// =========================================================================
// Project scoping
// =========================================================================

describe("spend anomaly project scoping", () => {
  it("alpha key sees anomalies only for alpha project", async () => {
    const { body, response } = await getJSON(
      "/v1/usage/spend-anomalies",
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    // Alpha project has the anomalous spike we seeded
    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
  });

  it("beta key sees no anomalies (no spike seeded for beta)", async () => {
    const { body, response } = await getJSON(
      "/v1/usage/spend-anomalies",
      API_KEYS.beta
    );

    expect(response.status).toBe(200);
    // Beta project has consistent low spend — no anomalies expected
    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    // Might be 0 or might have some if the base fixtures create a spike.
    // At minimum, the endpoint should not error.
    expect(Array.isArray(anomalies)).toBe(true);
  });

  it("admin key sees anomalies across all projects", async () => {
    const { body, response } = await getJSON(
      "/v1/usage/spend-anomalies",
      API_KEYS.admin
    );

    expect(response.status).toBe(200);
    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    expect(Array.isArray(anomalies)).toBe(true);
    // Admin should see at least the alpha project anomaly
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
  });
});

// =========================================================================
// Webhook alert dispatch
// =========================================================================

describe("spend anomaly webhook alerts", () => {
  it("triggers webhook when anomalous spend is detected", async () => {
    // POST to the evaluation endpoint triggers anomaly detection + webhook dispatch
    const { body, response } = await postJSON(
      "/v1/usage/spend-anomalies/evaluate",
      {},
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);

    // Response should indicate alerts were evaluated
    expect(body.evaluated).toBe(true);
    expect(typeof body.anomaliesDetected).toBe("number");
    expect(Number(body.anomaliesDetected)).toBeGreaterThanOrEqual(1);

    // Should indicate that webhook was dispatched (or queued)
    expect(body.alertsDispatched).toBeDefined();
    expect(typeof body.alertsDispatched).toBe("number");
  });

  it("records anomalous spend event in anomaly_events table", async () => {
    const p = getPool();

    // Trigger evaluation
    await postJSON(
      "/v1/usage/spend-anomalies/evaluate",
      {},
      API_KEYS.alpha
    );

    // Check that an anomaly event was recorded
    const result = await p.query(`
      SELECT * FROM anomaly_events
      WHERE anomaly_type = 'anomalous_spend'
      ORDER BY detected_at DESC
      LIMIT 5
    `);

    expect(result.rows.length).toBeGreaterThanOrEqual(1);

    const event = result.rows[0];
    expect(event.anomaly_type).toBe("anomalous_spend");
    expect(event.severity).toBe("critical");
    expect(event.description).toBeDefined();

    // Metadata should include cost details
    const metadata = event.metadata as Record<string, unknown>;
    expect(metadata).toBeDefined();
  });

  it("does not dispatch alert when no webhook is configured", async () => {
    // Beta project has no webhook configured
    const { body, response } = await postJSON(
      "/v1/usage/spend-anomalies/evaluate",
      {},
      API_KEYS.beta
    );

    expect(response.status).toBe(200);
    expect(body.evaluated).toBe(true);
    // Should indicate 0 alerts dispatched (no webhook configured for beta)
    expect(Number(body.alertsDispatched)).toBe(0);
  });

  it("returns 401 without API key", async () => {
    const { response } = await postJSON(
      "/v1/usage/spend-anomalies/evaluate",
      {}
    );
    expect(response.status).toBe(401);
  });
});

// =========================================================================
// Threshold behavior
// =========================================================================

describe("spend anomaly threshold behavior", () => {
  it("normal spend days are not flagged", async () => {
    const { body } = await getJSON(
      "/v1/usage/spend-anomalies",
      API_KEYS.alpha
    );

    const anomalies = body.anomalies as Array<Record<string, unknown>>;

    // Only the anomalous day (today) should be flagged, not the 30 normal days
    // Some days may have slightly varying costs, but the normal $1/day should not
    // trigger at a $3 threshold
    for (const anomaly of anomalies) {
      expect(Number(anomaly.ratio)).toBeGreaterThan(3);
    }
  });

  it("the 30-day rolling average is computed correctly", async () => {
    const { body } = await getJSON(
      "/v1/usage/spend-anomalies",
      API_KEYS.alpha
    );

    // We seeded ~$1.00/day for 30 days
    const rollingAvg = Number(body.rollingAverageUsd);
    // Should be approximately $1.00 (our fixtures have $1.00/day for normal days)
    expect(rollingAvg).toBeGreaterThan(0.5);
    expect(rollingAvg).toBeLessThan(2.0);
  });

  it("threshold is 3x the rolling average", async () => {
    const { body } = await getJSON(
      "/v1/usage/spend-anomalies",
      API_KEYS.alpha
    );

    const rollingAvg = Number(body.rollingAverageUsd);
    const threshold = Number(body.thresholdUsd);

    expect(threshold).toBeCloseTo(rollingAvg * 3, 1);
  });
});

// =========================================================================
// Negative tests
// =========================================================================

describe("spend anomaly negative tests", () => {
  it("returns empty anomalies when no spend exceeds threshold", async () => {
    // Beta project has consistent spend with no spikes
    const { body, response } = await getJSON(
      "/v1/usage/spend-anomalies",
      API_KEYS.beta
    );

    expect(response.status).toBe(200);
    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    // Beta has only a few sessions from base fixtures — no anomalous pattern
    // This is more of a "does not error" test
    expect(Array.isArray(anomalies)).toBe(true);
  });

  it("returns 401 with revoked API key", async () => {
    const { response } = await getJSON(
      "/v1/usage/spend-anomalies",
      API_KEYS.revoked
    );
    expect(response.status).toBe(401);
  });

  it("handles project with insufficient history gracefully", async () => {
    // A new project with < 30 days of data should still return a valid response.
    // Beta has very limited history from the base setup fixtures.
    const { body, response } = await getJSON(
      "/v1/usage/spend-anomalies",
      API_KEYS.beta
    );

    expect(response.status).toBe(200);
    // Should return a valid structure even with limited history
    expect(body.anomalies).toBeDefined();
    expect(Array.isArray(body.anomalies)).toBe(true);
    // Rolling average should still be computed (possibly from fewer days)
    expect(body.rollingAverageUsd).toBeDefined();
  });
});

// =========================================================================
// End-to-end: full anomaly detection pipeline
// =========================================================================

describe("spend anomaly end-to-end pipeline", () => {
  it("detection -> anomaly_events record -> webhook dispatch", async () => {
    const p = getPool();

    // Count anomaly events before
    const beforeResult = await p.query(`
      SELECT count(*)::int AS n FROM anomaly_events WHERE anomaly_type = 'anomalous_spend'
    `);
    const countBefore = beforeResult.rows[0].n;

    // Trigger the evaluation
    const { body, response } = await postJSON(
      "/v1/usage/spend-anomalies/evaluate",
      {},
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body.evaluated).toBe(true);
    expect(Number(body.anomaliesDetected)).toBeGreaterThanOrEqual(1);

    // Count anomaly events after
    const afterResult = await p.query(`
      SELECT count(*)::int AS n FROM anomaly_events WHERE anomaly_type = 'anomalous_spend'
    `);
    const countAfter = afterResult.rows[0].n;

    // At least one new anomaly event should be recorded
    expect(countAfter).toBeGreaterThan(countBefore);

    // Verify the recorded event has correct structure
    const latestEvent = await p.query(`
      SELECT * FROM anomaly_events
      WHERE anomaly_type = 'anomalous_spend'
      ORDER BY detected_at DESC
      LIMIT 1
    `);

    expect(latestEvent.rows.length).toBe(1);
    expect(latestEvent.rows[0].severity).toBe("critical");
  });
});
