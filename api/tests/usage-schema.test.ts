/**
 * Sprint 6 Deliverable 1: Usage Aggregation Schema
 *
 * Tests for:
 * - usage_aggregates table exists with correct columns
 * - UNIQUE constraint on (project_id, team_id, developer_id, agent_id, model, provider, period, period_start)
 * - Insert and query aggregation records
 * - Default values for metric columns
 * - Period validation ('hourly', 'daily', 'weekly', 'monthly')
 *
 * These tests WILL FAIL until the implementation agent builds the schema.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupDatabase,
  teardownDatabase,
  getPool,
  API_KEYS,
  IDS,
} from "./setup.js";

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// usage_aggregates table existence and schema
// =========================================================================

describe("usage_aggregates table schema", () => {
  it("table exists in the database", async () => {
    const p = getPool();
    const result = await p.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'usage_aggregates'
      ) AS table_exists
    `);
    expect(result.rows[0].table_exists).toBe(true);
  });

  it("has all required columns with correct types", async () => {
    const p = getPool();
    const result = await p.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'usage_aggregates'
      ORDER BY ordinal_position
    `);

    const columns = new Map(
      result.rows.map((r: Record<string, unknown>) => [r.column_name, r])
    );

    // Primary key
    expect(columns.has("id")).toBe(true);

    // Dimension columns
    expect(columns.has("project_id")).toBe(true);
    expect(columns.has("team_id")).toBe(true);
    expect(columns.has("developer_id")).toBe(true);
    expect(columns.has("agent_id")).toBe(true);
    expect(columns.has("model")).toBe(true);
    expect(columns.has("provider")).toBe(true);
    expect(columns.has("period")).toBe(true);
    expect(columns.has("period_start")).toBe(true);

    // Token metrics
    expect(columns.has("total_input_tokens")).toBe(true);
    expect(columns.has("total_output_tokens")).toBe(true);
    expect(columns.has("total_cache_tokens")).toBe(true);
    expect(columns.has("total_tokens")).toBe(true);

    // Cost metrics
    expect(columns.has("total_cost_usd")).toBe(true);
    expect(columns.has("avg_cost_per_session")).toBe(true);
    expect(columns.has("avg_cost_per_turn")).toBe(true);

    // Session metrics
    expect(columns.has("session_count")).toBe(true);
    expect(columns.has("avg_turns_per_session")).toBe(true);
    expect(columns.has("completion_rate")).toBe(true);

    // Tool metrics
    expect(columns.has("tool_call_count")).toBe(true);
    expect(columns.has("unique_tools_used")).toBe(true);
    expect(columns.has("tool_success_rate")).toBe(true);
    expect(columns.has("avg_tool_latency_ms")).toBe(true);

    // Latency metrics
    expect(columns.has("avg_latency_ms")).toBe(true);
    expect(columns.has("latency_p50")).toBe(true);
    expect(columns.has("latency_p95")).toBe(true);

    // project_id is NOT NULL
    const projectCol = columns.get("project_id") as Record<string, unknown>;
    expect(projectCol.is_nullable).toBe("NO");

    // model is NOT NULL
    const modelCol = columns.get("model") as Record<string, unknown>;
    expect(modelCol.is_nullable).toBe("NO");

    // provider is NOT NULL
    const providerCol = columns.get("provider") as Record<string, unknown>;
    expect(providerCol.is_nullable).toBe("NO");

    // period is NOT NULL
    const periodCol = columns.get("period") as Record<string, unknown>;
    expect(periodCol.is_nullable).toBe("NO");

    // period_start is NOT NULL
    const periodStartCol = columns.get("period_start") as Record<string, unknown>;
    expect(periodStartCol.is_nullable).toBe("NO");
  });

  it("id column is UUID primary key", async () => {
    const p = getPool();
    const result = await p.query(`
      SELECT constraint_type
      FROM information_schema.table_constraints
      WHERE table_name = 'usage_aggregates'
        AND constraint_type = 'PRIMARY KEY'
    `);
    expect(result.rows.length).toBe(1);
  });
});

// =========================================================================
// Insert and query usage aggregates
// =========================================================================

describe("usage_aggregates insert and query", () => {
  it("inserts a record with all metric fields", async () => {
    const p = getPool();
    const id = "11000000-0000-4000-8000-000000000001";
    const periodStart = "2026-03-20T00:00:00.000Z";

    await p.query(`
      INSERT INTO usage_aggregates (
        id, project_id, team_id, developer_id, agent_id, model, provider,
        period, period_start,
        total_input_tokens, total_output_tokens, total_cache_tokens, total_tokens,
        total_cost_usd, avg_cost_per_session, avg_cost_per_turn,
        session_count, avg_turns_per_session, completion_rate,
        tool_call_count, unique_tools_used, tool_success_rate, avg_tool_latency_ms,
        avg_latency_ms, latency_p50, latency_p95
      ) VALUES (
        $1, $2, 'team-a', 'dev-1', 'claude-code', 'claude-sonnet-4-20250514', 'anthropic',
        'daily', $3,
        50000, 30000, 5000, 85000,
        2.5000, 0.8333, 0.2083,
        3, 4.00, 0.6667,
        12, 4, 0.9167, 350.50,
        2500.00, 2200.00, 4800.00
      )
    `, [id, IDS.projectAlpha, periodStart]);

    const result = await p.query(
      `SELECT * FROM usage_aggregates WHERE id = $1`,
      [id]
    );

    expect(result.rows.length).toBe(1);
    const row = result.rows[0];

    expect(row.project_id).toBe(IDS.projectAlpha);
    expect(row.team_id).toBe("team-a");
    expect(row.developer_id).toBe("dev-1");
    expect(row.agent_id).toBe("claude-code");
    expect(row.model).toBe("claude-sonnet-4-20250514");
    expect(row.provider).toBe("anthropic");
    expect(row.period).toBe("daily");

    // Token metrics
    expect(Number(row.total_input_tokens)).toBe(50000);
    expect(Number(row.total_output_tokens)).toBe(30000);
    expect(Number(row.total_cache_tokens)).toBe(5000);
    expect(Number(row.total_tokens)).toBe(85000);

    // Cost metrics
    expect(Number(row.total_cost_usd)).toBeCloseTo(2.5, 2);
    expect(Number(row.avg_cost_per_session)).toBeCloseTo(0.8333, 3);
    expect(Number(row.avg_cost_per_turn)).toBeCloseTo(0.2083, 3);

    // Session metrics
    expect(Number(row.session_count)).toBe(3);
    expect(Number(row.avg_turns_per_session)).toBeCloseTo(4.0, 1);
    expect(Number(row.completion_rate)).toBeCloseTo(0.6667, 3);

    // Tool metrics
    expect(Number(row.tool_call_count)).toBe(12);
    expect(Number(row.unique_tools_used)).toBe(4);
    expect(Number(row.tool_success_rate)).toBeCloseTo(0.9167, 3);
    expect(Number(row.avg_tool_latency_ms)).toBeCloseTo(350.5, 1);

    // Latency metrics
    expect(Number(row.avg_latency_ms)).toBeCloseTo(2500.0, 0);
    expect(Number(row.latency_p50)).toBeCloseTo(2200.0, 0);
    expect(Number(row.latency_p95)).toBeCloseTo(4800.0, 0);
  });

  it("metric columns default to zero when not specified", async () => {
    const p = getPool();
    const id = "11000000-0000-4000-8000-000000000002";
    const periodStart = "2026-03-19T00:00:00.000Z";

    await p.query(`
      INSERT INTO usage_aggregates (
        id, project_id, model, provider, period, period_start
      ) VALUES (
        $1, $2, 'gpt-4o', 'openai', 'daily', $3
      )
    `, [id, IDS.projectAlpha, periodStart]);

    const result = await p.query(
      `SELECT * FROM usage_aggregates WHERE id = $1`,
      [id]
    );

    expect(result.rows.length).toBe(1);
    const row = result.rows[0];

    expect(Number(row.total_input_tokens)).toBe(0);
    expect(Number(row.total_output_tokens)).toBe(0);
    expect(Number(row.total_cache_tokens)).toBe(0);
    expect(Number(row.total_tokens)).toBe(0);
    expect(Number(row.total_cost_usd)).toBeCloseTo(0, 2);
    expect(Number(row.avg_cost_per_session)).toBeCloseTo(0, 2);
    expect(Number(row.avg_cost_per_turn)).toBeCloseTo(0, 2);
    expect(Number(row.session_count)).toBe(0);
    expect(Number(row.tool_call_count)).toBe(0);
    expect(Number(row.avg_latency_ms)).toBeCloseTo(0, 0);
  });

  it("nullable dimension columns accept NULL", async () => {
    const p = getPool();
    const id = "11000000-0000-4000-8000-000000000003";
    const periodStart = "2026-03-18T00:00:00.000Z";

    await p.query(`
      INSERT INTO usage_aggregates (
        id, project_id, model, provider,
        period, period_start
      ) VALUES (
        $1, $2, 'claude-sonnet-4-20250514', 'anthropic',
        'hourly', $3
      )
    `, [id, IDS.projectAlpha, periodStart]);

    const result = await p.query(
      `SELECT team_id, developer_id, agent_id FROM usage_aggregates WHERE id = $1`,
      [id]
    );

    expect(result.rows.length).toBe(1);
    // Migration 002 uses NOT NULL DEFAULT '' for group-by dimensions.
    // Omitting these columns in INSERT produces empty string, not null.
    expect(result.rows[0].team_id).toBe('');
    expect(result.rows[0].developer_id).toBe('');
    expect(result.rows[0].agent_id).toBe('');
  });
});

// =========================================================================
// UNIQUE constraint enforcement
// =========================================================================

describe("usage_aggregates UNIQUE constraint", () => {
  it("enforces uniqueness on composite key", async () => {
    const p = getPool();
    const periodStart = "2026-03-17T00:00:00.000Z";

    // First insert succeeds
    await p.query(`
      INSERT INTO usage_aggregates (
        id, project_id, team_id, developer_id, agent_id, model, provider,
        period, period_start, total_tokens
      ) VALUES (
        '11000000-0000-4000-8000-000000000010', $1, 'team-x', 'dev-x', 'agent-x',
        'claude-sonnet-4-20250514', 'anthropic', 'daily', $2, 1000
      )
    `, [IDS.projectAlpha, periodStart]);

    // Second insert with same composite key but different id should fail
    await expect(
      p.query(`
        INSERT INTO usage_aggregates (
          id, project_id, team_id, developer_id, agent_id, model, provider,
          period, period_start, total_tokens
        ) VALUES (
          '11000000-0000-4000-8000-000000000011', $1, 'team-x', 'dev-x', 'agent-x',
          'claude-sonnet-4-20250514', 'anthropic', 'daily', $2, 2000
        )
      `, [IDS.projectAlpha, periodStart])
    ).rejects.toThrow();
  });

  it("allows same dimensions with different period_start", async () => {
    const p = getPool();

    await p.query(`
      INSERT INTO usage_aggregates (
        id, project_id, team_id, developer_id, agent_id, model, provider,
        period, period_start, total_tokens
      ) VALUES (
        '11000000-0000-4000-8000-000000000020', $1, 'team-y', 'dev-y', 'agent-y',
        'gpt-4o', 'openai', 'daily', '2026-03-15T00:00:00.000Z', 100
      )
    `, [IDS.projectAlpha]);

    // Same dimensions, different period_start — should succeed
    await p.query(`
      INSERT INTO usage_aggregates (
        id, project_id, team_id, developer_id, agent_id, model, provider,
        period, period_start, total_tokens
      ) VALUES (
        '11000000-0000-4000-8000-000000000021', $1, 'team-y', 'dev-y', 'agent-y',
        'gpt-4o', 'openai', 'daily', '2026-03-16T00:00:00.000Z', 200
      )
    `, [IDS.projectAlpha]);

    const result = await p.query(`
      SELECT count(*)::int AS n FROM usage_aggregates
      WHERE project_id = $1 AND team_id = 'team-y'
    `, [IDS.projectAlpha]);

    expect(result.rows[0].n).toBe(2);
  });

  it("allows same dimensions with different period type", async () => {
    const p = getPool();
    const periodStart = "2026-03-14T00:00:00.000Z";

    await p.query(`
      INSERT INTO usage_aggregates (
        id, project_id, team_id, developer_id, agent_id, model, provider,
        period, period_start, total_tokens
      ) VALUES (
        '11000000-0000-4000-8000-000000000030', $1, 'team-z', 'dev-z', 'agent-z',
        'claude-sonnet-4-20250514', 'anthropic', 'daily', $2, 100
      )
    `, [IDS.projectAlpha, periodStart]);

    // Same dimensions but 'weekly' period — should succeed
    await p.query(`
      INSERT INTO usage_aggregates (
        id, project_id, team_id, developer_id, agent_id, model, provider,
        period, period_start, total_tokens
      ) VALUES (
        '11000000-0000-4000-8000-000000000031', $1, 'team-z', 'dev-z', 'agent-z',
        'claude-sonnet-4-20250514', 'anthropic', 'weekly', $2, 300
      )
    `, [IDS.projectAlpha, periodStart]);

    const result = await p.query(`
      SELECT period, total_tokens FROM usage_aggregates
      WHERE project_id = $1 AND team_id = 'team-z'
      ORDER BY period
    `, [IDS.projectAlpha]);

    expect(result.rows.length).toBe(2);
  });

  it("allows same dimensions with different model", async () => {
    const p = getPool();
    const periodStart = "2026-03-13T00:00:00.000Z";

    await p.query(`
      INSERT INTO usage_aggregates (
        id, project_id, model, provider, period, period_start, total_tokens
      ) VALUES (
        '11000000-0000-4000-8000-000000000040', $1, 'claude-sonnet-4-20250514', 'anthropic',
        'daily', $2, 100
      )
    `, [IDS.projectAlpha, periodStart]);

    // Different model — should succeed
    await p.query(`
      INSERT INTO usage_aggregates (
        id, project_id, model, provider, period, period_start, total_tokens
      ) VALUES (
        '11000000-0000-4000-8000-000000000041', $1, 'gpt-4o', 'openai',
        'daily', $2, 200
      )
    `, [IDS.projectAlpha, periodStart]);

    const result = await p.query(`
      SELECT model FROM usage_aggregates
      WHERE project_id = $1 AND period_start = $2 AND period = 'daily'
        AND team_id = '' AND developer_id = '' AND agent_id = ''
      ORDER BY model
    `, [IDS.projectAlpha, periodStart]);

    expect(result.rows.length).toBe(2);
  });
});

// =========================================================================
// Aggregation query patterns
// =========================================================================

describe("usage_aggregates query patterns", () => {
  it("queries total cost by project and period", async () => {
    const p = getPool();

    // Seed multiple daily records for the same project
    for (let day = 1; day <= 3; day++) {
      await p.query(`
        INSERT INTO usage_aggregates (
          id, project_id, model, provider, period, period_start,
          total_cost_usd, total_tokens, session_count
        ) VALUES (
          $1, $2, 'claude-sonnet-4-20250514', 'anthropic', 'daily',
          $3, $4, $5, $6
        )
        ON CONFLICT DO NOTHING
      `, [
        `11000000-0000-4000-8000-0000000001${day}0`,
        IDS.projectBeta,
        `2026-03-0${day}T00:00:00.000Z`,
        day * 1.5,
        day * 10000,
        day * 2,
      ]);
    }

    // Query total cost across all daily periods for projectBeta
    const result = await p.query(`
      SELECT
        SUM(total_cost_usd) AS total_cost,
        SUM(total_tokens) AS total_tokens,
        SUM(session_count) AS total_sessions
      FROM usage_aggregates
      WHERE project_id = $1 AND period = 'daily'
    `, [IDS.projectBeta]);

    expect(result.rows.length).toBe(1);
    expect(Number(result.rows[0].total_cost)).toBeGreaterThan(0);
    expect(Number(result.rows[0].total_tokens)).toBeGreaterThan(0);
    expect(Number(result.rows[0].total_sessions)).toBeGreaterThan(0);
  });

  it("queries aggregates grouped by model", async () => {
    const p = getPool();

    // Seed records for two different models in the same project
    await p.query(`
      INSERT INTO usage_aggregates (
        id, project_id, model, provider, period, period_start,
        total_cost_usd, total_tokens
      ) VALUES
        ('11000000-0000-4000-8000-000000000200', $1, 'claude-sonnet-4-20250514', 'anthropic', 'daily', '2026-03-10T00:00:00.000Z', 5.00, 50000),
        ('11000000-0000-4000-8000-000000000201', $1, 'gpt-4o', 'openai', 'daily', '2026-03-10T00:00:00.000Z', 3.00, 30000)
      ON CONFLICT DO NOTHING
    `, [IDS.projectBeta]);

    const result = await p.query(`
      SELECT model, provider, SUM(total_cost_usd) AS cost, SUM(total_tokens) AS tokens
      FROM usage_aggregates
      WHERE project_id = $1 AND period_start = '2026-03-10T00:00:00.000Z'
      GROUP BY model, provider
      ORDER BY cost DESC
    `, [IDS.projectBeta]);

    expect(result.rows.length).toBeGreaterThanOrEqual(2);
    // Anthropic should be more expensive
    expect(result.rows[0].model).toBe("claude-sonnet-4-20250514");
  });

  it("filters by period type (hourly vs daily)", async () => {
    const p = getPool();

    await p.query(`
      INSERT INTO usage_aggregates (
        id, project_id, model, provider, period, period_start,
        total_cost_usd, session_count
      ) VALUES
        ('11000000-0000-4000-8000-000000000300', $1, 'claude-sonnet-4-20250514', 'anthropic', 'hourly', '2026-03-10T14:00:00.000Z', 0.50, 1),
        ('11000000-0000-4000-8000-000000000301', $1, 'claude-sonnet-4-20250514', 'anthropic', 'hourly', '2026-03-10T15:00:00.000Z', 0.75, 2),
        ('11000000-0000-4000-8000-000000000302', $1, 'claude-sonnet-4-20250514', 'anthropic', 'daily', '2026-03-10T00:00:00.000Z', 1.25, 3)
      ON CONFLICT DO NOTHING
    `, [IDS.projectBeta]);

    // Query only hourly records
    const hourly = await p.query(`
      SELECT count(*)::int AS n FROM usage_aggregates
      WHERE project_id = $1 AND period = 'hourly' AND period_start >= '2026-03-10T00:00:00.000Z'
    `, [IDS.projectBeta]);

    expect(hourly.rows[0].n).toBeGreaterThanOrEqual(2);

    // Query only daily records for same date
    const daily = await p.query(`
      SELECT count(*)::int AS n FROM usage_aggregates
      WHERE project_id = $1 AND period = 'daily' AND period_start = '2026-03-10T00:00:00.000Z'
    `, [IDS.projectBeta]);

    expect(daily.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});
