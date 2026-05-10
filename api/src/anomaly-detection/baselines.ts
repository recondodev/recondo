/**
 * Sprint 8 Deliverable 1: Behavioral Baselines Per Agent
 *
 * POST /v1/anomaly-detection/baselines/compute — trigger baseline computation
 * GET  /v1/anomaly-detection/baselines          — retrieve computed baselines
 *
 * Computes per-agent, per-model baselines from 30-day rolling window of
 * turn/session/tool_call data. Stores results in agent_baselines table.
 */

import { getPool } from "@recondo/data";
import type { ApiKeyInfo } from "../context.js";

// ---------------------------------------------------------------------------
// POST /v1/anomaly-detection/baselines/compute
// ---------------------------------------------------------------------------

export async function handleComputeBaselines(
  body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Table created by migration 006_runtime-tables.sql
  // N1: Removed unused pool variable
  const projectId = apiKey.projectId;

  if (!projectId) {
    // Admin key: use projectId from body if provided
    const bodyProjectId = body.projectId as string | undefined;
    if (bodyProjectId) {
      return computeBaselinesForProject(bodyProjectId);
    }
    return { status: 400, body: { error: "projectId is required" } };
  }

  return computeBaselinesForProject(projectId);
}

async function computeBaselinesForProject(
  projectId: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const pool = getPool();
  const today = new Date().toISOString().split("T")[0];

  // Query last 30 days of turns+sessions grouped by agent_id, model
  // W1: Use subquery for cost stats to avoid join-amplified AVG/STDDEV
  const baselineQuery = await pool.query(`
    SELECT
      sub.agent_id,
      sub.model,
      sub.session_count,
      sub.turn_count,
      sub.avg_tokens_per_turn,
      sub.stddev_tokens_per_turn,
      sub.avg_turns_per_session,
      sub.avg_latency_ms,
      sub.stddev_latency_ms,
      cost_sub.avg_cost_per_session,
      cost_sub.stddev_cost_per_session
    FROM (
      SELECT
        s.agent_id,
        t.model,
        COUNT(DISTINCT s.id)::int AS session_count,
        COUNT(t.id)::int AS turn_count,
        AVG(t.input_tokens + t.output_tokens) AS avg_tokens_per_turn,
        STDDEV(t.input_tokens + t.output_tokens) AS stddev_tokens_per_turn,
        AVG(s.total_turns) AS avg_turns_per_session,
        AVG(t.duration_ms) AS avg_latency_ms,
        STDDEV(t.duration_ms) AS stddev_latency_ms
      FROM turns t
      JOIN sessions s ON t.session_id = s.id
      WHERE s.project_id = $1
        AND t.timestamp::TIMESTAMPTZ >= NOW() - INTERVAL '30 days'
      GROUP BY s.agent_id, t.model
    ) sub
    LEFT JOIN LATERAL (
      SELECT
        AVG(ds.total_cost_usd) AS avg_cost_per_session,
        STDDEV(ds.total_cost_usd) AS stddev_cost_per_session
      FROM (
        SELECT DISTINCT s.id, s.total_cost_usd
        FROM sessions s
        JOIN turns t ON t.session_id = s.id
        WHERE s.project_id = $1
          AND t.timestamp::TIMESTAMPTZ >= NOW() - INTERVAL '30 days'
          AND s.agent_id IS NOT DISTINCT FROM sub.agent_id
          AND t.model IS NOT DISTINCT FROM sub.model
      ) ds
    ) cost_sub ON true
  `, [projectId]);

  const baselines: Array<Record<string, unknown>> = [];

  for (const row of baselineQuery.rows) {
    const agentId = row.agent_id;
    const model = row.model;

    // Compute tool usage distribution for this agent
    const toolResult = await pool.query(`
      SELECT tc.tool_name, COUNT(*)::int AS cnt
      FROM tool_calls tc
      JOIN turns t ON tc.turn_id = t.id
      JOIN sessions s ON t.session_id = s.id
      WHERE s.project_id = $1
        AND ($2::TEXT IS NULL OR s.agent_id = $2)
        AND t.timestamp::TIMESTAMPTZ >= NOW() - INTERVAL '30 days'
      GROUP BY tc.tool_name
    `, [projectId, agentId]);

    const toolDist: Record<string, number> = {};
    for (const toolRow of toolResult.rows) {
      toolDist[toolRow.tool_name] = toolRow.cnt;
    }

    // Compute avg_session_duration_ms from sessions with started_at and last_active_at
    const durationResult = await pool.query(`
      SELECT AVG(
        EXTRACT(EPOCH FROM (s.last_active_at::TIMESTAMPTZ - s.started_at::TIMESTAMPTZ)) * 1000
      ) AS avg_duration_ms
      FROM sessions s
      WHERE s.project_id = $1
        AND ($2::TEXT IS NULL OR s.agent_id = $2)
        AND s.started_at::TIMESTAMPTZ >= NOW() - INTERVAL '30 days'
    `, [projectId, agentId]);

    const avgSessionDurationMs = Number(durationResult.rows[0]?.avg_duration_ms ?? 0);

    // BLOCKER-2: Store avg_latency_ms from computed turn-level duration_ms
    const avgLatencyMs = Number(row.avg_latency_ms ?? 0);

    // Upsert into agent_baselines
    await pool.query(`
      INSERT INTO agent_baselines (
        project_id, agent_id, model, baseline_date,
        avg_tokens_per_turn, avg_cost_per_session, avg_turns_per_session,
        avg_session_duration_ms, tool_usage_distribution,
        session_count, turn_count, computed_at,
        stddev_cost_per_session, stddev_tokens_per_turn, stddev_latency_ms,
        avg_latency_ms
      ) VALUES (
        $1, $2, $3, $4::DATE,
        $5, $6, $7,
        $8, $9::jsonb,
        $10, $11, NOW(),
        $12, $13, $14,
        $15
      )
    `, [
      projectId,
      agentId,
      model,
      today,
      Number(row.avg_tokens_per_turn ?? 0),
      Number(row.avg_cost_per_session ?? 0),
      Number(row.avg_turns_per_session ?? 0),
      avgSessionDurationMs,
      JSON.stringify(toolDist),
      Number(row.session_count ?? 0),
      Number(row.turn_count ?? 0),
      Number(row.stddev_cost_per_session ?? 0),
      Number(row.stddev_tokens_per_turn ?? 0),
      Number(row.stddev_latency_ms ?? 0),
      avgLatencyMs,
    ]);

    baselines.push({
      projectId,
      agentId,
      model,
      baselineDate: today,
      avgTokensPerTurn: Number(row.avg_tokens_per_turn ?? 0),
      avgCostPerSession: Number(row.avg_cost_per_session ?? 0),
      avgTurnsPerSession: Number(row.avg_turns_per_session ?? 0),
      avgSessionDurationMs: avgSessionDurationMs,
      avgLatencyMs: avgLatencyMs,
      toolUsageDistribution: toolDist,
      sessionCount: Number(row.session_count ?? 0),
      turnCount: Number(row.turn_count ?? 0),
    });
  }

  return {
    status: 200,
    body: { baselines },
  };
}

// ---------------------------------------------------------------------------
// GET /v1/anomaly-detection/baselines
// ---------------------------------------------------------------------------

export async function handleGetBaselines(
  apiKey: ApiKeyInfo,
  queryProjectId?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Table created by migration 006_runtime-tables.sql
  const pool = getPool();

  // Project scoping: non-admin keys can only see their own project's baselines
  let effectiveProjectId: string | null;

  if (apiKey.projectId) {
    // Non-admin: always use the key's own project, ignore query param
    effectiveProjectId = apiKey.projectId;
  } else {
    // Admin: can view any project's baselines
    effectiveProjectId = queryProjectId ?? null;
  }

  let result;
  if (effectiveProjectId) {
    result = await pool.query(`
      SELECT * FROM agent_baselines
      WHERE project_id = $1
      ORDER BY computed_at DESC
      LIMIT 1000
    `, [effectiveProjectId]);
  } else {
    result = await pool.query(`
      SELECT * FROM agent_baselines
      ORDER BY computed_at DESC
      LIMIT 1000
    `);
  }

  const baselines = result.rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    model: row.model,
    baselineDate: row.baseline_date,
    avgTokensPerTurn: Number(row.avg_tokens_per_turn),
    avgCostPerSession: Number(row.avg_cost_per_session),
    avgTurnsPerSession: Number(row.avg_turns_per_session),
    avgSessionDurationMs: Number(row.avg_session_duration_ms),
    avgLatencyMs: Number(row.avg_latency_ms ?? 0),
    toolUsageDistribution: row.tool_usage_distribution,
    sessionCount: Number(row.session_count),
    turnCount: Number(row.turn_count),
    computedAt: row.computed_at,
  }));

  return {
    status: 200,
    body: { baselines },
  };
}
