/**
 * Sprint 6 Deliverable 6: Anomalous Spend Detection
 *
 * GET  /v1/usage/spend-anomalies          — detect daily cost > 3x 30-day rolling average
 * POST /v1/usage/spend-anomalies/evaluate — trigger webhook dispatch + anomaly_events record
 */

import { getPool } from "@recondo/data";
import type { ApiKeyInfo } from "../context.js";

const ANOMALY_THRESHOLD_MULTIPLIER = 3;
const ROLLING_WINDOW_DAYS = 30;

interface DailyCost {
  date: string;
  costUsd: number;
}

/**
 * Get daily cost data for the given project scope.
 */
async function getDailyCosts(
  projectId: string | null
): Promise<DailyCost[]> {
  const pool = getPool();

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (projectId) {
    conditions.push(`s.project_id = $${idx++}`);
    params.push(projectId);
  }

  // W2 fix: Filter to last 365 days for anomaly detection relevance and bounded result sets.
  conditions.push(`t.timestamp::TIMESTAMPTZ >= NOW() - INTERVAL '365 days'`);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await pool.query(`
    SELECT
      DATE_TRUNC('day', t.timestamp::TIMESTAMPTZ)::DATE AS day,
      SUM(t.cost_usd) AS daily_cost
    FROM turns t
    JOIN sessions s ON t.session_id = s.id
    ${where}
    GROUP BY DATE_TRUNC('day', t.timestamp::TIMESTAMPTZ)::DATE
    ORDER BY day ASC
    LIMIT 1000
  `, params);

  return result.rows.map((row: Record<string, unknown>) => ({
    date: row.day instanceof Date
      ? row.day.toISOString().split("T")[0]
      : String(row.day),
    costUsd: Number(row.daily_cost || 0),
  }));
}

/**
 * Compute anomalies: days where cost > 3x the 30-day rolling average.
 *
 * N4: Anomaly detection uses UTC day boundaries (DATE_TRUNC('day', ... ::TIMESTAMPTZ))
 * for all daily cost aggregations. This means "today" is defined as the current UTC date,
 * and historical days align to UTC midnight boundaries. Organizations spanning multiple
 * timezones should be aware that daily cost buckets follow UTC, not local time.
 */
function detectAnomalies(dailyCosts: DailyCost[]): {
  anomalies: Array<{
    date: string;
    dailyCostUsd: number;
    rollingAverageUsd: number;
    ratio: number;
    thresholdUsd: number;
  }>;
  rollingAverageUsd: number;
  thresholdUsd: number;
} {
  if (dailyCosts.length === 0) {
    return { anomalies: [], rollingAverageUsd: 0, thresholdUsd: 0 };
  }

  // Compute overall rolling average from the last 30 days of data (excluding today)
  const today = new Date().toISOString().split("T")[0];
  const historicalCosts = dailyCosts.filter(d => d.date < today);

  // Use the most recent 30 days of historical data for the rolling average
  const recentHistory = historicalCosts.slice(-ROLLING_WINDOW_DAYS);

  let rollingAvg = 0;
  if (recentHistory.length > 0) {
    const totalHistorical = recentHistory.reduce((sum, d) => sum + d.costUsd, 0);
    rollingAvg = totalHistorical / recentHistory.length;
  }

  const threshold = rollingAvg * ANOMALY_THRESHOLD_MULTIPLIER;

  // Find anomalous days
  const anomalies: Array<{
    date: string;
    dailyCostUsd: number;
    rollingAverageUsd: number;
    ratio: number;
    thresholdUsd: number;
  }> = [];

  for (const day of dailyCosts) {
    // Only flag days where cost exceeds the threshold
    if (rollingAvg > 0 && day.costUsd > threshold) {
      anomalies.push({
        date: day.date,
        dailyCostUsd: Number(day.costUsd.toFixed(6)),
        rollingAverageUsd: Number(rollingAvg.toFixed(6)),
        ratio: Number((day.costUsd / rollingAvg).toFixed(4)),
        thresholdUsd: Number(threshold.toFixed(6)),
      });
    }
  }

  return {
    anomalies,
    rollingAverageUsd: Number(rollingAvg.toFixed(6)),
    thresholdUsd: Number(threshold.toFixed(6)),
  };
}

/**
 * GET /v1/usage/spend-anomalies
 * Detect daily cost exceeding 3x the 30-day rolling average.
 */
export async function handleSpendAnomalies(
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  const dailyCosts = await getDailyCosts(apiKey.projectId);
  const result = detectAnomalies(dailyCosts);

  return {
    status: 200,
    body: {
      anomalies: result.anomalies,
      rollingAverageUsd: result.rollingAverageUsd,
      thresholdUsd: result.thresholdUsd,
    },
  };
}

/**
 * POST /v1/usage/spend-anomalies/evaluate
 * Trigger anomaly detection, record anomaly_events, and dispatch webhook alerts.
 */
export async function handleSpendAnomaliesEvaluate(
  _body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  const pool = getPool();

  const dailyCosts = await getDailyCosts(apiKey.projectId);
  const result = detectAnomalies(dailyCosts);

  const anomaliesDetected = result.anomalies.length;
  let alertsDispatched = 0;

  // Record each anomaly in anomaly_events
  for (const anomaly of result.anomalies) {
    await pool.query(`
      INSERT INTO anomaly_events (anomaly_type, severity, description, metadata)
      VALUES ($1, $2, $3, $4)
    `, [
      "anomalous_spend",
      "critical",
      `Daily spend of $${anomaly.dailyCostUsd.toFixed(2)} on ${anomaly.date} exceeds threshold of $${anomaly.thresholdUsd.toFixed(2)} (${anomaly.ratio.toFixed(1)}x rolling average)`,
      JSON.stringify({
        date: anomaly.date,
        dailyCostUsd: anomaly.dailyCostUsd,
        rollingAverageUsd: anomaly.rollingAverageUsd,
        thresholdUsd: anomaly.thresholdUsd,
        ratio: anomaly.ratio,
        projectId: apiKey.projectId ?? "global",
      }),
    ]);
  }

  // Dispatch webhook if configured for this project
  if (anomaliesDetected > 0) {
    const projectId = apiKey.projectId ?? "global";
    try {
      const configResult = await pool.query(
        `SELECT webhook_url FROM alert_configs WHERE project_id = $1 LIMIT 1`,
        [projectId]
      );

      if (configResult.rows.length > 0) {
        const webhookUrl = configResult.rows[0].webhook_url;

        // SSRF protection
        // W5 fix: Added IPv6-mapped patterns (^\[::1\]$ and ^::ffff:) matching monitoring.ts
        const parsedUrl = new URL(webhookUrl);
        const hostname = parsedUrl.hostname.toLowerCase();
        const privatePatterns = [
          /^localhost$/, /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, /^::1$/,
          /^0\.0\.0\.0$/, /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
          /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
          /^192\.168\.\d{1,3}\.\d{1,3}$/, /^169\.254\.\d{1,3}\.\d{1,3}$/,
          /^\[::1\]$/, /^::ffff:/,
        ];

        if (!privatePatterns.some((p) => p.test(hostname))) {
          try {
            const response = await fetch(webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                projectId,
                anomalies: result.anomalies,
                evaluatedAt: new Date().toISOString(),
              }),
              signal: AbortSignal.timeout(10_000),
            });
            if (response.ok) {
              alertsDispatched = anomaliesDetected;
            }
          } catch {
            // Webhook dispatch failed — non-fatal
          }
        }
      }
    } catch {
      // No alert config or query failed — non-fatal
    }
  }

  return {
    status: 200,
    body: {
      evaluated: true,
      anomaliesDetected,
      alertsDispatched,
    },
  };
}
