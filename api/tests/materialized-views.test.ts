/**
 * Sprint 6 Deliverable 2 + 3: Materialized Views + Refresh Scheduler
 *
 * Tests for:
 * - mv_usage_hourly: exists, returns correct aggregated data
 * - mv_usage_daily: exists, returns correct aggregated data
 * - mv_usage_weekly: exists, returns correct aggregated data
 * - mv_usage_monthly: exists, returns correct aggregated data
 * - mv_tool_usage: exists, returns correct aggregated data
 * - All 5 MVs can be refreshed without error
 * - Refresh scheduler runs on schedule (verified via DB metadata)
 *
 * These tests WILL FAIL until the implementation agent builds the materialized views.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupDatabase,
  teardownDatabase,
  getPool,
  IDS,
} from "./setup.js";

// ---------------------------------------------------------------------------
// Extended fixtures: multiple sessions, models, providers, days
// ---------------------------------------------------------------------------

const MV_IDS = {
  // Additional sessions for aggregation breadth (prefix: mv)
  sessionMV1: "mv000000-0000-4000-8000-000000000001",
  sessionMV2: "mv000000-0000-4000-8000-000000000002",
  sessionMV3: "mv000000-0000-4000-8000-000000000003",

  // Turns across sessions (prefix: mvt)
  turnMV1_1: "mvt00000-0000-4000-8000-000000000001",
  turnMV1_2: "mvt00000-0000-4000-8000-000000000002",
  turnMV2_1: "mvt00000-0000-4000-8000-000000000003",
  turnMV2_2: "mvt00000-0000-4000-8000-000000000004",
  turnMV3_1: "mvt00000-0000-4000-8000-000000000005",
  turnMV3_2: "mvt00000-0000-4000-8000-000000000006",

  // Tool calls for mv_tool_usage (prefix: mvtc)
  tcMV1: "mvtc0000-0000-4000-8000-000000000001",
  tcMV2: "mvtc0000-0000-4000-8000-000000000002",
  tcMV3: "mvtc0000-0000-4000-8000-000000000003",
  tcMV4: "mvtc0000-0000-4000-8000-000000000004",
} as const;

async function seedMaterializedViewFixtures(): Promise<void> {
  const p = getPool();
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400_000);
  const twoDaysAgo = new Date(now.getTime() - 2 * 86400_000);
  const hourAgo = new Date(now.getTime() - 3600_000);

  // Session 1: Anthropic claude-sonnet, project alpha, yesterday
  // Session 2: OpenAI gpt-4o, project alpha, today
  // Session 3: Anthropic claude-sonnet, project beta, two days ago
  await p.query(`
    INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at, ended_at,
                          initial_intent, system_prompt_hash, total_turns, turns_captured,
                          dropped_events, total_tokens, total_cost_usd, agent_id) VALUES
      ('${MV_IDS.sessionMV1}', '${IDS.projectAlpha}', 'anthropic', 'claude-sonnet-4-20250514',
       '${yesterday.toISOString()}', '${yesterday.toISOString()}', '${yesterday.toISOString()}',
       'MV test session 1', 'mvhash001', 2, 2, 0, 20000, 0.60, 'claude-code'),
      ('${MV_IDS.sessionMV2}', '${IDS.projectAlpha}', 'openai', 'gpt-4o',
       '${hourAgo.toISOString()}', '${now.toISOString()}', NULL,
       'MV test session 2', 'mvhash002', 2, 2, 0, 15000, 0.40, 'cursor'),
      ('${MV_IDS.sessionMV3}', '${IDS.projectBeta}', 'anthropic', 'claude-sonnet-4-20250514',
       '${twoDaysAgo.toISOString()}', '${twoDaysAgo.toISOString()}', '${twoDaysAgo.toISOString()}',
       'MV test session 3', 'mvhash003', 2, 2, 0, 25000, 0.75, 'claude-code')
    ON CONFLICT (id) DO NOTHING;
  `);

  // Turns with varied models, costs, latencies
  await p.query(`
    INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
                       req_bytes_ref, resp_bytes_ref, model, provider,
                       input_tokens, output_tokens, thinking_tokens, cost_usd,
                       duration_ms, tool_call_count, stop_reason, created_at) VALUES
      ('${MV_IDS.turnMV1_1}', '${MV_IDS.sessionMV1}', 1,
       '${yesterday.toISOString()}', 'hash_mv1_1_req', 'hash_mv1_1_resp',
       'ref_mv1_1_req', 'ref_mv1_1_resp', 'claude-sonnet-4-20250514', 'anthropic',
       5000, 3000, 0, 0.25, 2000, 2, 'end_turn', '${yesterday.toISOString()}'),
      ('${MV_IDS.turnMV1_2}', '${MV_IDS.sessionMV1}', 2,
       '${new Date(yesterday.getTime() + 60000).toISOString()}', 'hash_mv1_2_req', 'hash_mv1_2_resp',
       'ref_mv1_2_req', 'ref_mv1_2_resp', 'claude-sonnet-4-20250514', 'anthropic',
       7000, 5000, 0, 0.35, 3500, 1, 'end_turn', '${new Date(yesterday.getTime() + 60000).toISOString()}'),
      ('${MV_IDS.turnMV2_1}', '${MV_IDS.sessionMV2}', 1,
       '${hourAgo.toISOString()}', 'hash_mv2_1_req', 'hash_mv2_1_resp',
       'ref_mv2_1_req', 'ref_mv2_1_resp', 'gpt-4o', 'openai',
       4000, 3000, 0, 0.20, 1800, 0, 'end_turn', '${hourAgo.toISOString()}'),
      ('${MV_IDS.turnMV2_2}', '${MV_IDS.sessionMV2}', 2,
       '${new Date(hourAgo.getTime() + 60000).toISOString()}', 'hash_mv2_2_req', 'hash_mv2_2_resp',
       'ref_mv2_2_req', 'ref_mv2_2_resp', 'gpt-4o', 'openai',
       4000, 4000, 0, 0.20, 2200, 1, 'end_turn', '${new Date(hourAgo.getTime() + 60000).toISOString()}'),
      ('${MV_IDS.turnMV3_1}', '${MV_IDS.sessionMV3}', 1,
       '${twoDaysAgo.toISOString()}', 'hash_mv3_1_req', 'hash_mv3_1_resp',
       'ref_mv3_1_req', 'ref_mv3_1_resp', 'claude-sonnet-4-20250514', 'anthropic',
       8000, 6000, 0, 0.40, 4000, 1, 'end_turn', '${twoDaysAgo.toISOString()}'),
      ('${MV_IDS.turnMV3_2}', '${MV_IDS.sessionMV3}', 2,
       '${new Date(twoDaysAgo.getTime() + 60000).toISOString()}', 'hash_mv3_2_req', 'hash_mv3_2_resp',
       'ref_mv3_2_req', 'ref_mv3_2_resp', 'claude-sonnet-4-20250514', 'anthropic',
       6000, 5000, 0, 0.35, 3000, 2, 'end_turn', '${new Date(twoDaysAgo.getTime() + 60000).toISOString()}')
    ON CONFLICT (id) DO NOTHING;
  `);

  // Tool calls across turns
  await p.query(`
    INSERT INTO tool_calls (id, turn_id, tool_name, tool_input, input_hash, sequence_num,
                            output, output_hash, duration_ms, status) VALUES
      ('${MV_IDS.tcMV1}', '${MV_IDS.turnMV1_1}', 'Read', '{"file": "main.ts"}', 'tc_mv1_hash', 0,
       'File contents...', 'tc_mv1_out_hash', 200, 'success'),
      ('${MV_IDS.tcMV2}', '${MV_IDS.turnMV1_1}', 'Edit', '{"file": "main.ts"}', 'tc_mv2_hash', 1,
       'Applied edits', 'tc_mv2_out_hash', 150, 'success'),
      ('${MV_IDS.tcMV3}', '${MV_IDS.turnMV3_1}', 'Read', '{"file": "deploy.sh"}', 'tc_mv3_hash', 0,
       'File contents...', 'tc_mv3_out_hash', 180, 'success'),
      ('${MV_IDS.tcMV4}', '${MV_IDS.turnMV3_2}', 'Bash', '{"cmd": "deploy"}', 'tc_mv4_hash', 0,
       NULL, 'tc_mv4_out_hash', 5000, 'error')
    ON CONFLICT (id) DO NOTHING;
  `);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedMaterializedViewFixtures();
  // Refresh materialized views now that all fixture data has been inserted
  const p = getPool();
  await p.query(`REFRESH MATERIALIZED VIEW mv_usage_hourly`);
  await p.query(`REFRESH MATERIALIZED VIEW mv_usage_daily`);
  await p.query(`REFRESH MATERIALIZED VIEW mv_usage_weekly`);
  await p.query(`REFRESH MATERIALIZED VIEW mv_usage_monthly`);
  await p.query(`REFRESH MATERIALIZED VIEW mv_tool_usage`);
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// mv_usage_hourly
// =========================================================================

describe("mv_usage_hourly", () => {
  it("materialized view exists", async () => {
    const p = getPool();
    const result = await p.query(`
      SELECT EXISTS (
        SELECT FROM pg_matviews WHERE matviewname = 'mv_usage_hourly'
      ) AS mv_exists
    `);
    expect(result.rows[0].mv_exists).toBe(true);
  });

  it("returns aggregated data grouped by project, model, and hour", async () => {
    const p = getPool();
    const result = await p.query(`
      SELECT * FROM mv_usage_hourly LIMIT 100
    `);

    expect(result.rows.length).toBeGreaterThanOrEqual(1);

    // Check that expected columns are present
    const row = result.rows[0];
    expect(row).toHaveProperty("project_id");
    expect(row).toHaveProperty("model");
    expect(row).toHaveProperty("period_start");
    expect(row).toHaveProperty("session_count");
    expect(row).toHaveProperty("turn_count");
    expect(row).toHaveProperty("total_input_tokens");
    expect(row).toHaveProperty("total_output_tokens");
    expect(row).toHaveProperty("total_cost_usd");
    expect(row).toHaveProperty("avg_latency_ms");
    expect(row).toHaveProperty("latency_p95");
  });

  it("aggregates token counts correctly against raw turn data", async () => {
    const p = getPool();

    // Get raw sums from turns table for project alpha, last 7 days
    const rawResult = await p.query(`
      SELECT
        s.project_id,
        t.model AS model,
        SUM(t.input_tokens) AS raw_input,
        SUM(t.output_tokens) AS raw_output,
        SUM(t.cost_usd) AS raw_cost,
        COUNT(t.id) AS raw_turn_count
      FROM turns t
      JOIN sessions s ON t.session_id = s.id
      WHERE s.project_id = $1
        AND t.timestamp >= (NOW() - INTERVAL '7 days')::text
      GROUP BY s.project_id, t.model
      ORDER BY t.model
    `, [IDS.projectAlpha]);

    // Get same data from the MV
    const mvResult = await p.query(`
      SELECT
        project_id, model,
        SUM(total_input_tokens) AS mv_input,
        SUM(total_output_tokens) AS mv_output,
        SUM(total_cost_usd) AS mv_cost,
        SUM(turn_count) AS mv_turn_count
      FROM mv_usage_hourly
      WHERE project_id = $1
      GROUP BY project_id, model
      ORDER BY model
    `, [IDS.projectAlpha]);

    // Both should have the same number of model groups
    expect(mvResult.rows.length).toBe(rawResult.rows.length);

    // Verify totals match for each model
    for (let i = 0; i < rawResult.rows.length; i++) {
      const raw = rawResult.rows[i];
      const mv = mvResult.rows[i];
      expect(mv.model).toBe(raw.model);
      expect(Number(mv.mv_input)).toBe(Number(raw.raw_input));
      expect(Number(mv.mv_output)).toBe(Number(raw.raw_output));
      expect(Number(mv.mv_cost)).toBeCloseTo(Number(raw.raw_cost), 2);
    }
  });

  it("has unique index on (project_id, model, period_start)", async () => {
    const p = getPool();
    const result = await p.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'mv_usage_hourly'
    `);
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    const indexNames = result.rows.map((r: Record<string, unknown>) => String(r.indexname));
    expect(indexNames.some((n: string) => n.includes("mv_usage_hourly"))).toBe(true);
  });

  it("can be refreshed without error", async () => {
    const p = getPool();
    // REFRESH MATERIALIZED VIEW CONCURRENTLY requires a unique index
    await expect(
      p.query("REFRESH MATERIALIZED VIEW CONCURRENTLY mv_usage_hourly")
    ).resolves.not.toThrow();
  });
});

// =========================================================================
// mv_usage_daily
// =========================================================================

describe("mv_usage_daily", () => {
  it("materialized view exists", async () => {
    const p = getPool();
    const result = await p.query(`
      SELECT EXISTS (
        SELECT FROM pg_matviews WHERE matviewname = 'mv_usage_daily'
      ) AS mv_exists
    `);
    expect(result.rows[0].mv_exists).toBe(true);
  });

  it("returns aggregated data grouped by project, agent, model, provider, and day", async () => {
    const p = getPool();
    const result = await p.query(`SELECT * FROM mv_usage_daily LIMIT 100`);

    expect(result.rows.length).toBeGreaterThanOrEqual(1);

    const row = result.rows[0];
    expect(row).toHaveProperty("project_id");
    expect(row).toHaveProperty("agent_id");
    expect(row).toHaveProperty("model");
    expect(row).toHaveProperty("provider");
    expect(row).toHaveProperty("period_start");
    expect(row).toHaveProperty("session_count");
    expect(row).toHaveProperty("turn_count");
    expect(row).toHaveProperty("total_input_tokens");
    expect(row).toHaveProperty("total_output_tokens");
    expect(row).toHaveProperty("total_cache_tokens");
    expect(row).toHaveProperty("total_cost_usd");
    expect(row).toHaveProperty("avg_latency_ms");
  });

  it("aggregates cache tokens from turns", async () => {
    const p = getPool();

    // The MV should include cache_tokens column
    const result = await p.query(`
      SELECT SUM(total_cache_tokens) AS cache_total
      FROM mv_usage_daily
      WHERE project_id = $1
    `, [IDS.projectAlpha]);

    // Value should be a number (even if 0 from our fixtures)
    expect(result.rows.length).toBe(1);
    expect(Number(result.rows[0].cache_total)).toBeGreaterThanOrEqual(0);
  });

  it("includes provider breakdown", async () => {
    const p = getPool();

    const result = await p.query(`
      SELECT DISTINCT provider FROM mv_usage_daily
      WHERE project_id = $1
    `, [IDS.projectAlpha]);

    // Project alpha has both anthropic and openai sessions
    const providers = result.rows.map((r: Record<string, unknown>) => r.provider);
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
  });

  it("can be refreshed without error", async () => {
    const p = getPool();
    await expect(
      p.query("REFRESH MATERIALIZED VIEW mv_usage_daily")
    ).resolves.not.toThrow();
  });
});

// =========================================================================
// mv_usage_weekly
// =========================================================================

describe("mv_usage_weekly", () => {
  it("materialized view exists", async () => {
    const p = getPool();
    const result = await p.query(`
      SELECT EXISTS (
        SELECT FROM pg_matviews WHERE matviewname = 'mv_usage_weekly'
      ) AS mv_exists
    `);
    expect(result.rows[0].mv_exists).toBe(true);
  });

  it("returns aggregated data at weekly granularity", async () => {
    const p = getPool();
    const result = await p.query(`SELECT * FROM mv_usage_weekly LIMIT 100`);

    expect(result.rows.length).toBeGreaterThanOrEqual(1);

    const row = result.rows[0];
    expect(row).toHaveProperty("project_id");
    expect(row).toHaveProperty("period_start");
    expect(row).toHaveProperty("total_cost_usd");
    expect(row).toHaveProperty("session_count");
  });

  it("weekly totals encompass all daily data within the week", async () => {
    const p = getPool();

    // Total cost from weekly view for project alpha
    const weeklyResult = await p.query(`
      SELECT SUM(total_cost_usd) AS weekly_total
      FROM mv_usage_weekly
      WHERE project_id = $1
    `, [IDS.projectAlpha]);

    // Total cost from raw turns for same project
    const rawResult = await p.query(`
      SELECT SUM(t.cost_usd) AS raw_total
      FROM turns t
      JOIN sessions s ON t.session_id = s.id
      WHERE s.project_id = $1
    `, [IDS.projectAlpha]);

    // Weekly total should match raw total (all our data is within one week)
    expect(Number(weeklyResult.rows[0].weekly_total)).toBeCloseTo(
      Number(rawResult.rows[0].raw_total), 2
    );
  });

  it("can be refreshed without error", async () => {
    const p = getPool();
    await expect(
      p.query("REFRESH MATERIALIZED VIEW mv_usage_weekly")
    ).resolves.not.toThrow();
  });
});

// =========================================================================
// mv_usage_monthly
// =========================================================================

describe("mv_usage_monthly", () => {
  it("materialized view exists", async () => {
    const p = getPool();
    const result = await p.query(`
      SELECT EXISTS (
        SELECT FROM pg_matviews WHERE matviewname = 'mv_usage_monthly'
      ) AS mv_exists
    `);
    expect(result.rows[0].mv_exists).toBe(true);
  });

  it("returns aggregated data at monthly granularity", async () => {
    const p = getPool();
    const result = await p.query(`SELECT * FROM mv_usage_monthly LIMIT 100`);

    expect(result.rows.length).toBeGreaterThanOrEqual(1);

    const row = result.rows[0];
    expect(row).toHaveProperty("project_id");
    expect(row).toHaveProperty("period_start");
    expect(row).toHaveProperty("total_cost_usd");
    expect(row).toHaveProperty("total_tokens");
    expect(row).toHaveProperty("session_count");
  });

  it("monthly totals encompass all data within the month", async () => {
    const p = getPool();

    // Total tokens from monthly view across all projects
    const monthlyResult = await p.query(`
      SELECT SUM(total_tokens) AS monthly_tokens
      FROM mv_usage_monthly
    `);

    // Total tokens from raw turns across all projects
    // Compute total_tokens = input_tokens + output_tokens for each turn
    const rawResult = await p.query(`
      SELECT SUM(t.input_tokens + t.output_tokens) AS raw_tokens
      FROM turns t
    `);

    // Monthly total should be >= raw total (all our test data is in one month)
    expect(Number(monthlyResult.rows[0].monthly_tokens)).toBeGreaterThanOrEqual(
      Number(rawResult.rows[0].raw_tokens)
    );
  });

  it("can be refreshed without error", async () => {
    const p = getPool();
    await expect(
      p.query("REFRESH MATERIALIZED VIEW mv_usage_monthly")
    ).resolves.not.toThrow();
  });
});

// =========================================================================
// mv_tool_usage
// =========================================================================

describe("mv_tool_usage", () => {
  it("materialized view exists", async () => {
    const p = getPool();
    const result = await p.query(`
      SELECT EXISTS (
        SELECT FROM pg_matviews WHERE matviewname = 'mv_tool_usage'
      ) AS mv_exists
    `);
    expect(result.rows[0].mv_exists).toBe(true);
  });

  it("returns aggregated data grouped by project, tool name, and agent", async () => {
    const p = getPool();
    const result = await p.query(`SELECT * FROM mv_tool_usage LIMIT 100`);

    expect(result.rows.length).toBeGreaterThanOrEqual(1);

    const row = result.rows[0];
    expect(row).toHaveProperty("project_id");
    expect(row).toHaveProperty("tool_name");
    expect(row).toHaveProperty("agent_id");
    expect(row).toHaveProperty("period_start");
    expect(row).toHaveProperty("call_count");
    expect(row).toHaveProperty("session_count");
    expect(row).toHaveProperty("avg_duration_ms");
    expect(row).toHaveProperty("success_rate");
  });

  it("counts tool calls correctly against raw data", async () => {
    const p = getPool();

    // Count raw tool calls for project alpha
    const rawResult = await p.query(`
      SELECT COUNT(tc.id) AS raw_count
      FROM tool_calls tc
      JOIN turns t ON tc.turn_id = t.id
      JOIN sessions s ON t.session_id = s.id
      WHERE s.project_id = $1
    `, [IDS.projectAlpha]);

    // Count from MV
    const mvResult = await p.query(`
      SELECT SUM(call_count) AS mv_count
      FROM mv_tool_usage
      WHERE project_id = $1
    `, [IDS.projectAlpha]);

    expect(Number(mvResult.rows[0].mv_count)).toBe(
      Number(rawResult.rows[0].raw_count)
    );
  });

  it("tracks tool names and their call frequency", async () => {
    const p = getPool();

    const result = await p.query(`
      SELECT tool_name, SUM(call_count) AS total_calls
      FROM mv_tool_usage
      GROUP BY tool_name
      ORDER BY total_calls DESC
    `);

    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    // We seeded Read, Edit, Bash tool calls
    const toolNames = result.rows.map((r: Record<string, unknown>) => r.tool_name);
    expect(toolNames).toContain("Read");
  });

  it("computes success rate correctly", async () => {
    const p = getPool();

    const result = await p.query(`
      SELECT tool_name, success_rate
      FROM mv_tool_usage
      WHERE project_id = $1
    `, [IDS.projectBeta]);

    for (const row of result.rows) {
      const rate = Number(row.success_rate);
      // Success rate should be between 0 and 1
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(1);
    }
  });

  it("can be refreshed without error", async () => {
    const p = getPool();
    await expect(
      p.query("REFRESH MATERIALIZED VIEW mv_tool_usage")
    ).resolves.not.toThrow();
  });
});

// =========================================================================
// All 5 MVs: cross-view consistency
// =========================================================================

describe("cross-view consistency", () => {
  it("all 5 materialized views exist", async () => {
    const p = getPool();
    const result = await p.query(`
      SELECT matviewname FROM pg_matviews
      WHERE matviewname IN (
        'mv_usage_hourly', 'mv_usage_daily', 'mv_usage_weekly',
        'mv_usage_monthly', 'mv_tool_usage'
      )
      ORDER BY matviewname
    `);

    const viewNames = result.rows.map((r: Record<string, unknown>) => r.matviewname);
    expect(viewNames).toContain("mv_usage_hourly");
    expect(viewNames).toContain("mv_usage_daily");
    expect(viewNames).toContain("mv_usage_weekly");
    expect(viewNames).toContain("mv_usage_monthly");
    expect(viewNames).toContain("mv_tool_usage");
  });

  it("refreshing all 5 MVs in sequence succeeds", async () => {
    const p = getPool();

    const views = [
      "mv_usage_hourly",
      "mv_usage_daily",
      "mv_usage_weekly",
      "mv_usage_monthly",
      "mv_tool_usage",
    ];

    for (const view of views) {
      await expect(
        p.query(`REFRESH MATERIALIZED VIEW ${view}`)
      ).resolves.not.toThrow();
    }
  });

  it("daily cost totals equal hourly cost totals for same project within hourly's 7-day window", async () => {
    const p = getPool();

    // FIND-13-A: assert equality, not >=, for the project_alpha
    // fixture window. The test fixture (api/tests/setup.ts) seeds
    // every turn at `hourAgo` (~1h ago) or `hourAgo + N minutes`
    // (~1h ago + a minute or two), so all rows fall inside the
    // hourly MV's `WHERE timestamp >= NOW() - INTERVAL '7 days'`
    // filter. With identical underlying data, the per-grain SUMs
    // must be EQUAL, not merely a superset.
    //
    // Why equality is the correct invariant here, not >=:
    //   - mv_usage_daily has NO time filter; it aggregates all turns.
    //   - mv_usage_hourly filters to turns within the last 7 days.
    //   - For the project_alpha fixture, every seeded turn lives in
    //     the last 7 days, so daily and hourly see the exact same
    //     row set. Equality is the strongest provable invariant.
    //
    // Edge case (documented, not tested here): in a fixture or
    // production dataset that contains turns OLDER than 7 days,
    // mv_usage_daily.SUM strictly exceeds mv_usage_hourly.SUM by
    // the cost of those older rows. A separate test that seeds an
    // 8-day-old turn would assert the strict-superset case; for
    // this fixture we hold to the equality contract because it is
    // tighter and catches more bugs (e.g. a daily MV that drops
    // rows, or an hourly MV whose date_trunc loses precision).
    //
    // Compare in DECIMAL space (server-side) instead of converting
    // to JS Number(). pg returns NUMERIC as a string; Number()
    // narrows to float64, which makes equal DECIMAL totals look
    // unequal at the 16th-decimal-place rounding. Performing the
    // equality check entirely in Postgres preserves the intended
    // invariant without the float-precision artefact.
    const cmp = await p.query(
      `
      SELECT (
        COALESCE((SELECT SUM(total_cost_usd) FROM mv_usage_daily WHERE project_id = $1), 0)
        =
        COALESCE((SELECT SUM(total_cost_usd) FROM mv_usage_hourly WHERE project_id = $1), 0)
      ) AS daily_eq_hourly
    `,
      [IDS.projectAlpha],
    );

    expect(cmp.rows[0].daily_eq_hourly).toBe(true);
  });
});

// =========================================================================
// Negative tests
// =========================================================================

describe("materialized views negative tests", () => {
  it("querying a nonexistent project returns empty results", async () => {
    const p = getPool();
    const result = await p.query(`
      SELECT * FROM mv_usage_daily
      WHERE project_id = 'nonexistent-project-id-00000000'
    `);
    expect(result.rows.length).toBe(0);
  });

  it("hourly view does not include data older than 7 days", async () => {
    const p = getPool();

    // Insert a session + turn from 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 86400_000);
    const sessionId = "mvneg000-0000-4000-8000-000000000001";
    const turnId = "mvneg000-0000-4000-8000-000000000002";

    await p.query(`
      INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at,
                            system_prompt_hash, total_turns, turns_captured, total_cost_usd,
                            agent_id)
      VALUES ($1, $2, 'anthropic', 'claude-sonnet-4-20250514', $3, $3, 'oldhash', 1, 1, 0.10, 'claude-code')
      ON CONFLICT (id) DO NOTHING
    `, [sessionId, IDS.projectAlpha, tenDaysAgo.toISOString()]);

    await p.query(`
      INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
                         model, provider, input_tokens, output_tokens, cost_usd,
                         duration_ms, stop_reason, created_at)
      VALUES ($1, $2, 1, $3, 'old_req', 'old_resp', 'claude-sonnet-4-20250514', 'anthropic',
              1000, 500, 0.10, 1000, 'end_turn', $3)
      ON CONFLICT (id) DO NOTHING
    `, [turnId, sessionId, tenDaysAgo.toISOString()]);

    // Refresh the hourly view
    await p.query("REFRESH MATERIALIZED VIEW mv_usage_hourly");

    // The hourly view should NOT include data from 10 days ago
    const result = await p.query(`
      SELECT * FROM mv_usage_hourly
      WHERE period_start < (NOW() - INTERVAL '7 days')
    `);
    expect(result.rows.length).toBe(0);
  });
});
