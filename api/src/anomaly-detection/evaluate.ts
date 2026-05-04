/**
 * Sprint 8 Deliverable 2 & 3: Anomaly Detection — Evaluation and Async Pipeline
 *
 * POST /v1/anomaly-detection/evaluate    — evaluate recent turns against baselines
 * GET  /v1/anomaly-detection/anomalies   — list detected anomalies with filters
 *
 * Detects 4 anomaly types:
 * - cost_spike: session cost > mean + 3*stddev
 * - latency_spike: turn latency_ms > mean + 3*stddev
 * - decision_outlier: tool name not in baseline distribution or < 1% frequency
 * - rejection_pattern: consecutive failed tool calls in a session
 *
 * N3: Score normalization strategy:
 * - cost_spike & latency_spike: score = sigma_distance / 9, capped at 1.0
 *   (a 9-sigma deviation yields score 1.0; 3-sigma threshold yields 0.333)
 * - decision_outlier: score = 1.0 if tool absent from baseline; otherwise 1.0 - frequency
 * - rejection_pattern: score = consecutive_failures / 10, capped at 1.0
 *   (10+ consecutive failures yields score 1.0)
 * All scores are in [0, 1]. Severity: "critical" if score >= 0.7, otherwise "warning".
 */

import { getPool } from "../db.js";
import type { ApiKeyInfo } from "../context.js";
import {
  maskPlaceholderPaths,
  sanitizeAnomalyRow,
} from "../placeholder-mask.js";

// ---------------------------------------------------------------------------
// Anomaly type definitions
// ---------------------------------------------------------------------------

interface DetectedAnomaly {
  type: string;
  severity: string;
  score: number;
  sessionId: string;
  turnId?: string;
  projectId: string;
  description: string;
  metadata: Record<string, unknown>;
  toolName?: string;
}

// ---------------------------------------------------------------------------
// POST /v1/anomaly-detection/evaluate
// ---------------------------------------------------------------------------

export async function handleEvaluateAnomalies(
  body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Table created by migration 006_runtime-tables.sql
  const pool = getPool();
  const projectId = apiKey.projectId ?? (body.projectId as string | undefined);

  if (!projectId) {
    return { status: 400, body: { error: "projectId is required" } };
  }

  // Fetch baselines for this project
  const baselinesResult = await pool.query(`
    SELECT * FROM agent_baselines
    WHERE project_id = $1
    ORDER BY computed_at DESC
  `, [projectId]);

  if (baselinesResult.rows.length === 0) {
    // No baselines => cannot detect anomalies
    return { status: 200, body: { anomalies: [] } };
  }

  // Build a lookup map: agentId+model -> baseline
  const baselineMap = new Map<string, Record<string, unknown>>();
  for (const row of baselinesResult.rows) {
    const key = `${row.agent_id ?? ""}|${row.model ?? ""}`;
    // Use the most recent baseline (first encountered, since ordered by computed_at DESC)
    if (!baselineMap.has(key)) {
      baselineMap.set(key, row);
    }
  }

  const detectedAnomalies: DetectedAnomaly[] = [];

  // ---------------------------------------------------------------------------
  // 1. Cost spike detection: per session
  // ---------------------------------------------------------------------------
  const sessionsResult = await pool.query(`
    SELECT s.id, s.agent_id, s.model, s.total_cost_usd, s.project_id
    FROM sessions s
    WHERE s.project_id = $1
      AND s.started_at::TIMESTAMPTZ >= NOW() - INTERVAL '24 hours'
    LIMIT 10000
  `, [projectId]);

  for (const session of sessionsResult.rows) {
    const key = `${session.agent_id ?? ""}|${session.model ?? ""}`;
    const baseline = baselineMap.get(key);
    if (!baseline) continue;

    const avgCost = Number(baseline.avg_cost_per_session ?? 0);
    const stddevCost = Number(baseline.stddev_cost_per_session ?? 0);
    const sessionCost = Number(session.total_cost_usd ?? 0);

    if (stddevCost > 0 && sessionCost > avgCost + 3 * stddevCost) {
      const sigmas = (sessionCost - avgCost) / stddevCost;
      const score = Math.min(sigmas / (3 * 3), 1.0); // Normalize: score = sigma / 9, capped at 1.0
      const severity = score >= 0.7 ? "critical" : "warning";

      detectedAnomalies.push({
        type: "cost_spike",
        severity,
        score: Number(score.toFixed(4)),
        sessionId: session.id,
        projectId,
        description: `Session cost $${sessionCost.toFixed(2)} exceeds 3-sigma threshold of $${(avgCost + 3 * stddevCost).toFixed(2)}`,
        metadata: {
          sessionCost,
          baselineAvg: avgCost,
          stddev: stddevCost,
          sigmas: Number(sigmas.toFixed(2)),
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Latency spike detection: per turn
  // ---------------------------------------------------------------------------
  const turnsResult = await pool.query(`
    SELECT t.id AS turn_id, t.session_id, t.duration_ms, s.agent_id, t.model, s.project_id
    FROM turns t
    JOIN sessions s ON t.session_id = s.id
    WHERE s.project_id = $1
      AND t.timestamp::TIMESTAMPTZ >= NOW() - INTERVAL '24 hours'
      AND t.duration_ms IS NOT NULL
    LIMIT 10000
  `, [projectId]);

  for (const turn of turnsResult.rows) {
    const key = `${turn.agent_id ?? ""}|${turn.model ?? ""}`;
    const baseline = baselineMap.get(key);
    if (!baseline) continue;

    // BLOCKER-2: Use avg_latency_ms directly from stored baseline (computed from turn duration_ms)
    const avgLatency = Number(baseline.avg_latency_ms ?? 0);
    const stddevLatency = Number(baseline.stddev_latency_ms ?? 0);
    const turnLatency = Number(turn.duration_ms ?? 0);

    if (stddevLatency > 0 && turnLatency > avgLatency + 3 * stddevLatency) {
      const sigmas = (turnLatency - avgLatency) / stddevLatency;
      const score = Math.min(sigmas / (3 * 3), 1.0);
      const severity = score >= 0.7 ? "critical" : "warning";

      detectedAnomalies.push({
        type: "latency_spike",
        severity,
        score: Number(score.toFixed(4)),
        sessionId: turn.session_id,
        turnId: turn.turn_id,
        projectId,
        description: `Turn latency ${turnLatency}ms exceeds 3-sigma threshold of ${(avgLatency + 3 * stddevLatency).toFixed(0)}ms`,
        metadata: {
          latencyMs: turnLatency,
          baselineAvg: avgLatency,
          stddev: stddevLatency,
          sigmas: Number(sigmas.toFixed(2)),
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Decision outlier detection: per tool call
  // ---------------------------------------------------------------------------
  const toolCallsResult = await pool.query(`
    SELECT tc.id AS tc_id, tc.tool_name, tc.turn_id, t.session_id, s.agent_id, t.model, s.project_id
    FROM tool_calls tc
    JOIN turns t ON tc.turn_id = t.id
    JOIN sessions s ON t.session_id = s.id
    WHERE s.project_id = $1
      AND t.timestamp::TIMESTAMPTZ >= NOW() - INTERVAL '24 hours'
    LIMIT 10000
  `, [projectId]);

  // Track which tool names we've already flagged (deduplicate per tool name)
  const flaggedTools = new Set<string>();

  for (const tc of toolCallsResult.rows) {
    const key = `${tc.agent_id ?? ""}|${tc.model ?? ""}`;
    const baseline = baselineMap.get(key);
    if (!baseline) continue;

    const toolDist = baseline.tool_usage_distribution as Record<string, number> | null;
    if (!toolDist) continue;

    const toolName = tc.tool_name;
    const totalCalls = Object.values(toolDist).reduce((sum: number, v: number) => sum + v, 0);

    if (totalCalls === 0) continue;

    const frequency = (toolDist[toolName] ?? 0) / totalCalls;

    // FIND-9-A: mask the tool_name BEFORE it's embedded into the
    // description template / metadata JSONB / persisted into
    // anomaly_events. The raw `tc.tool_name` came from the gateway
    // and may carry a `[Image: source: /path]` placeholder; if we
    // build descriptions/metadata from raw, the placeholder
    // persists into the anomaly_events row and leaks anywhere
    // metadata is later rendered. Masking at construction time
    // means the persisted record itself is clean.
    const safeToolName = maskPlaceholderPaths(toolName) ?? toolName;
    if (!(toolName in toolDist)) {
      // Tool not in baseline distribution at all => score 1.0
      if (!flaggedTools.has(toolName)) {
        flaggedTools.add(toolName);
        detectedAnomalies.push({
          type: "decision_outlier",
          severity: "critical",
          score: 1.0,
          sessionId: tc.session_id,
          turnId: tc.turn_id,
          projectId,
          toolName: safeToolName,
          description: `Tool "${safeToolName}" has 0% frequency in baseline distribution`,
          metadata: {
            toolName: safeToolName,
            frequency: 0,
            baselineDistribution: toolDist,
          },
        });
      }
    } else if (frequency < 0.01) {
      // Tool exists but < 1% frequency
      if (!flaggedTools.has(toolName)) {
        flaggedTools.add(toolName);
        const score = 1.0 - frequency;
        detectedAnomalies.push({
          type: "decision_outlier",
          severity: score >= 0.7 ? "critical" : "warning",
          score: Number(score.toFixed(4)),
          sessionId: tc.session_id,
          turnId: tc.turn_id,
          projectId,
          toolName: safeToolName,
          description: `Tool "${safeToolName}" has ${(frequency * 100).toFixed(1)}% frequency in baseline (below 1% threshold)`,
          metadata: {
            toolName: safeToolName,
            frequency,
            baselineDistribution: toolDist,
          },
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Rejection pattern detection: consecutive failed tool calls per session
  // ---------------------------------------------------------------------------
  const failedToolCallsResult = await pool.query(`
    SELECT tc.id, tc.tool_name, tc.turn_id, tc.error, tc.status, tc.output,
           t.session_id, t.sequence_num, s.agent_id, t.model, s.project_id
    FROM tool_calls tc
    JOIN turns t ON tc.turn_id = t.id
    JOIN sessions s ON t.session_id = s.id
    WHERE s.project_id = $1
      AND t.timestamp::TIMESTAMPTZ >= NOW() - INTERVAL '24 hours'
    ORDER BY t.session_id, t.sequence_num, tc.sequence_num
    LIMIT 10000
  `, [projectId]);

  // Group by session, count consecutive failures
  const sessionFailures = new Map<string, { consecutive: number; sessionId: string; agentId: string; model: string }>();

  let currentSessionId = "";
  let consecutiveFailures = 0;
  let maxConsecutive = 0;

  for (const tc of failedToolCallsResult.rows) {
    if (tc.session_id !== currentSessionId) {
      // W6: Previous session finalization is handled by the map update below (lines 283-290)
      currentSessionId = tc.session_id;
      consecutiveFailures = 0;
      maxConsecutive = 0;
    }

    const isFailure = tc.status === "error" ||
      (tc.error && tc.error.length > 0) ||
      (tc.output && typeof tc.output === "string" && tc.output.toLowerCase().includes("error"));

    if (isFailure) {
      consecutiveFailures++;
      maxConsecutive = Math.max(maxConsecutive, consecutiveFailures);
    } else {
      consecutiveFailures = 0;
    }

    // Update the map for this session
    if (maxConsecutive >= 3) {
      sessionFailures.set(tc.session_id, {
        consecutive: maxConsecutive,
        sessionId: tc.session_id,
        agentId: tc.agent_id,
        model: tc.model,
      });
    }
  }

  // Handle the last session
  if (currentSessionId && maxConsecutive >= 3) {
    const lastTc = failedToolCallsResult.rows[failedToolCallsResult.rows.length - 1];
    sessionFailures.set(currentSessionId, {
      consecutive: maxConsecutive,
      sessionId: currentSessionId,
      agentId: lastTc?.agent_id,
      model: lastTc?.model,
    });
  }

  for (const [_sessionId, info] of sessionFailures) {
    const score = Math.min(info.consecutive / 10, 1.0);
    const severity = score >= 0.7 ? "critical" : "warning";

    detectedAnomalies.push({
      type: "rejection_pattern",
      severity,
      score: Number(score.toFixed(4)),
      sessionId: info.sessionId,
      projectId,
      description: `${info.consecutive} consecutive failed tool calls in session`,
      metadata: {
        consecutiveFailures: info.consecutive,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Persist anomalies to anomaly_events
  // BLOCKER-1: Deduplicate — skip insert if an unresolved anomaly of the same
  // type already exists for the same session within the last 24 hours.
  // ---------------------------------------------------------------------------
  for (const anomaly of detectedAnomalies) {
    const existing = await pool.query(`
      SELECT id FROM anomaly_events
      WHERE session_id = $1
        AND anomaly_type = $2
        AND project_id = $3
        AND resolved_at IS NULL
        AND detected_at::TIMESTAMPTZ > NOW() - INTERVAL '24 hours'
      LIMIT 1
    `, [anomaly.sessionId, anomaly.type, anomaly.projectId]);

    if (existing.rows.length > 0) {
      // Already have an unresolved anomaly of this type for this session — skip
      continue;
    }

    await pool.query(`
      INSERT INTO anomaly_events (
        session_id, turn_id, anomaly_type, severity, description, metadata,
        project_id, score
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
    `, [
      anomaly.sessionId,
      anomaly.turnId ?? null,
      anomaly.type,
      anomaly.severity,
      anomaly.description,
      JSON.stringify(anomaly.metadata),
      anomaly.projectId,
      anomaly.score,
    ]);
  }

  // FIND-9-A: sanitise description AND toolName before returning.
  // The `decision_outlier` anomaly type constructs description via
  // a template literal embedding `tc.tool_name` raw. A tool call
  // whose name carries a `[Image: source: /Users/.../*.png]`
  // placeholder leaks the path through the POST evaluate endpoint
  // — both via the inner description AND via the top-level
  // `toolName` field. Both are masked here.
  //
  // VERIFIED before/after:
  //   BEFORE: description: "Tool \"malicious[Image: source: /Users/x/secret.png]\" has 0% frequency..."
  //           toolName:    "malicious[Image: source: /Users/x/secret.png]"
  //   AFTER:  description: "Tool \"malicious[attachment]\" has 0% frequency..."
  //           toolName:    "malicious[attachment]"
  return {
    status: 200,
    body: {
      anomalies: detectedAnomalies.map((a) => ({
        type: a.type,
        severity: a.severity,
        score: a.score,
        sessionId: a.sessionId,
        turnId: a.turnId ?? null,
        projectId: a.projectId,
        description: maskPlaceholderPaths(a.description ?? null),
        metadata: a.metadata,
        toolName: maskPlaceholderPaths(a.toolName ?? null),
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// GET /v1/anomaly-detection/anomalies
// ---------------------------------------------------------------------------

export async function handleGetAnomalies(
  apiKey: ApiKeyInfo,
  query: { projectId?: string; type?: string; severity?: string }
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Table created by migration 006_runtime-tables.sql
  const pool = getPool();

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  // Project scoping
  if (apiKey.projectId) {
    // Non-admin: only see own project's anomalies
    conditions.push(`ae.project_id = $${idx++}`);
    params.push(apiKey.projectId);
  } else if (query.projectId) {
    // Admin with specific project filter
    conditions.push(`ae.project_id = $${idx++}`);
    params.push(query.projectId);
  }
  // Admin without projectId filter sees all

  // Type filter
  if (query.type) {
    conditions.push(`ae.anomaly_type = $${idx++}`);
    params.push(query.type);
  }

  // Severity filter
  if (query.severity) {
    conditions.push(`ae.severity = $${idx++}`);
    params.push(query.severity);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await pool.query(`
    SELECT ae.*
    FROM anomaly_events ae
    ${where}
    ORDER BY ae.detected_at DESC
    LIMIT 1000
  `, params);

  // FIND-8-A + FIND-9-J + FIND-10-E: sanitise via the
  // anomaly-aware helper so this REST handler tracks both
  // ANOMALY_TEXT_FIELDS (top-level text) AND `metadata` JSONB
  // string values as the single source of truth. Round 9's
  // version used `sanitizeRowTextFields(row, ANOMALY_TEXT_FIELDS)`,
  // which only masked top-level strings; rows persisted by a
  // pre-Round-9 gateway (or batch-imported from external sources)
  // still carried `metadata.toolName = "[Image: source: /path]"`,
  // leaking via this GET endpoint. `sanitizeAnomalyRow` walks
  // `metadata` one level deep and masks every string value.
  const anomalies = result.rows.map((row) => {
    const sanitized = sanitizeAnomalyRow(row as Record<string, unknown>);
    return {
      id: sanitized.id,
      sessionId: sanitized.session_id,
      turnId: sanitized.turn_id,
      type: sanitized.anomaly_type,
      severity: sanitized.severity,
      description: sanitized.description,
      metadata: sanitized.metadata,
      projectId: sanitized.project_id,
      score: sanitized.score != null ? Number(sanitized.score) : null,
      createdAt: sanitized.detected_at,
      resolvedAt: sanitized.resolved_at ?? null,
      resolutionNote: sanitized.resolution_note ?? null,
    };
  });

  return {
    status: 200,
    body: { anomalies },
  };
}
