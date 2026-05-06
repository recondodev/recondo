/**
 * Sprint 5 Deliverable 6: SR 11-7 Export Template
 *
 * POST /v1/exports/sr11-7
 *
 * Generates a JSON document mapping to Federal Reserve SR 11-7
 * (model risk management) sections:
 * - modelIdentification: model name, provider, version, usage date range
 * - developmentEvidence: sessions using the model, total decisions, total tokens
 * - validationEvidence: integrity verification results, anomaly counts
 * - ongoingMonitoring: completeness metrics, availability metrics, cost trends
 */

import { getPool } from "@recondo/data";
import type { ApiKeyInfo } from "../context.js";

function inferProvider(modelId: string): string {
  if (modelId.startsWith("claude") || modelId.startsWith("anthropic")) return "anthropic";
  if (modelId.startsWith("gpt") || modelId.startsWith("o1") || modelId.startsWith("o3") || modelId.startsWith("o4")) return "openai";
  if (modelId.startsWith("gemini")) return "google";
  return "unknown";
}

export async function handleSr117Export(
  body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  const projectId = body.projectId as string | undefined;
  const modelId = body.modelId as string | undefined;

  // Validation
  if (!projectId) {
    return { status: 400, body: { error: "Missing required field: projectId" } };
  }

  // ISSUE 9 fix: Validate projectId is a valid UUID format
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
    return { status: 400, body: { error: "Invalid projectId format: must be a UUID" } };
  }

  if (!modelId) {
    return { status: 400, body: { error: "Missing required field: modelId" } };
  }

  // W14 fix: Non-admin keys attempting cross-project access get 403 Forbidden.
  if (apiKey.projectId && apiKey.projectId !== projectId) {
    return { status: 403, body: { error: "Forbidden" } };
  }

  const effectiveProjectId = projectId;

  const pool = getPool();

  // ---- Model Identification ----
  const provider = inferProvider(modelId);

  // Find usage date range for this model
  const usageResult = await pool.query(
    `SELECT MIN(t.timestamp) AS first_used, MAX(t.timestamp) AS last_used
     FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1
       AND t.model = $2`,
    [effectiveProjectId, modelId]
  );

  const usageStartDate = usageResult.rows[0]?.first_used ?? new Date().toISOString();
  const usageEndDate = usageResult.rows[0]?.last_used ?? new Date().toISOString();

  const modelIdentification = {
    modelName: modelId,
    provider,
    version: modelId, // Use model name as version identifier
    usageStartDate,
    usageEndDate,
  };

  // ---- Development Evidence ----
  // Count sessions that used this model
  const sessionsResult = await pool.query(
    `SELECT COUNT(DISTINCT s.id) AS session_count
     FROM sessions s
     JOIN turns t ON t.session_id = s.id
     WHERE s.project_id = $1
       AND t.model = $2`,
    [effectiveProjectId, modelId]
  );

  const totalSessions = Number(sessionsResult.rows[0]?.session_count ?? 0);

  // Count total turns (decisions) using this model
  const decisionsResult = await pool.query(
    `SELECT COUNT(*) AS turn_count,
            COALESCE(SUM(t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_creation_tokens), 0) AS total_tokens
     FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1
       AND t.model = $2`,
    [effectiveProjectId, modelId]
  );

  const totalDecisions = Number(decisionsResult.rows[0]?.turn_count ?? 0);
  const totalTokens = Number(decisionsResult.rows[0]?.total_tokens ?? 0);

  const developmentEvidence = {
    totalSessions,
    totalDecisions,
    totalTokens,
  };

  // ---- Validation Evidence ----
  // Count anomaly events for sessions using this model
  let anomalyCount = 0;
  try {
    const anomalyResult = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM anomaly_events ae
       JOIN sessions s ON ae.session_id = s.id
       WHERE s.project_id = $1`,
      [effectiveProjectId]
    );
    anomalyCount = Number(anomalyResult.rows[0]?.cnt ?? 0);
  } catch {
    // anomaly_events table may not exist
  }

  // Integrity verification: turns with complete hash chain
  const integrityResult = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE t.req_bytes_ref IS NOT NULL AND t.resp_bytes_ref IS NOT NULL) AS verified,
       COUNT(*) FILTER (WHERE t.req_bytes_ref IS NULL OR t.resp_bytes_ref IS NULL) AS failed
     FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1
       AND t.model = $2`,
    [effectiveProjectId, modelId]
  );

  const verifiedCount = Number(integrityResult.rows[0]?.verified ?? 0);
  const failedCount = Number(integrityResult.rows[0]?.failed ?? 0);

  const validationEvidence = {
    integrityVerificationResults: {
      verifiedCount,
      failedCount,
      verificationPercentage:
        verifiedCount + failedCount > 0
          ? Math.round((verifiedCount / (verifiedCount + failedCount)) * 100 * 100) / 100
          : 100,
    },
    anomalyCount,
  };

  // ---- Ongoing Monitoring ----
  // Completeness metrics for sessions using this model
  // W1 fix: Use COUNT(DISTINCT s.id) to avoid double-counting sessions
  // when multiple turns per session match the model filter.
  const completenessResult = await pool.query(
    `SELECT
       COUNT(DISTINCT s.id) AS total_sessions,
       COUNT(DISTINCT s.id) FILTER (WHERE s.dropped_events = 0 AND s.turns_captured = s.total_turns) AS complete_sessions
     FROM sessions s
     JOIN turns t ON t.session_id = s.id
     WHERE s.project_id = $1
       AND t.model = $2`,
    [effectiveProjectId, modelId]
  );

  const totalMonitoredSessions = Number(completenessResult.rows[0]?.total_sessions ?? 0);
  const completeSessions = Number(completenessResult.rows[0]?.complete_sessions ?? 0);
  const completenessPercentage =
    totalMonitoredSessions > 0
      ? Math.round((completeSessions / totalMonitoredSessions) * 100 * 100) / 100
      : 100;

  // Availability metrics from heartbeats — scoped to model usage date range (NEW-N2 fix)
  let availabilityMetrics: Record<string, unknown> = { heartbeatCount: 0 };
  try {
    const hbResult = await pool.query(
      `SELECT COUNT(*) AS cnt FROM heartbeats WHERE timestamp >= $1 AND timestamp <= $2`,
      [usageStartDate, usageEndDate]
    );
    availabilityMetrics = { heartbeatCount: Number(hbResult.rows[0]?.cnt ?? 0) };
  } catch {
    // heartbeats table may not exist
  }

  // Cost trends
  const costResult = await pool.query(
    `SELECT COALESCE(SUM(t.cost_usd), 0) AS total_cost
     FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1
       AND t.model = $2`,
    [effectiveProjectId, modelId]
  );

  const totalCostUsd = Number(costResult.rows[0]?.total_cost ?? 0);

  const ongoingMonitoring = {
    completenessMetrics: {
      completenessPercentage,
      totalSessions: totalMonitoredSessions,
      completeSessions,
    },
    availabilityMetrics,
    costTrends: {
      totalCostUsd,
      averageCostPerDecision: totalDecisions > 0 ? totalCostUsd / totalDecisions : 0,
    },
  };

  return {
    status: 200,
    body: {
      modelIdentification,
      developmentEvidence,
      validationEvidence,
      ongoingMonitoring,
    },
  };
}
