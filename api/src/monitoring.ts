/**
 * Sprint 5 Deliverable 5: Completeness and Availability Monitoring
 *
 * GET  /v1/monitoring/completeness  — sessions with dropped events
 * GET  /v1/monitoring/availability  — gateway heartbeat status
 * POST /v1/monitoring/alerts/configure — webhook alert configuration
 */

import { getPool } from "./db.js";
import type { ApiKeyInfo } from "./context.js";

// MISSING fix: Fire-and-forget alert evaluation helper, used as side effect
// in completeness and availability handlers.
async function triggerAlertEvaluation(apiKey: ApiKeyInfo): Promise<void> {
  try {
    await handleAlertEvaluate(apiKey);
  } catch {
    // Non-fatal: alert evaluation failure should not affect the response.
  }
}


// ---------------------------------------------------------------------------
// GET /v1/monitoring/completeness
// ---------------------------------------------------------------------------

export async function handleCompleteness(
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  const pool = getPool();

  // Build query with project scoping
  const conditions: string[] = [
    "(s.dropped_events > 0 OR s.turns_captured < s.total_turns)",
  ];
  const params: unknown[] = [];
  let idx = 1;

  if (apiKey.projectId) {
    conditions.push(`s.project_id = $${idx++}`);
    params.push(apiKey.projectId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // B6 fix: Add LIMIT to prevent unbounded result sets.
  // N3 fix: Include project_id in each session's completeness entry.
  const QUERY_LIMIT = 10000;
  const result = await pool.query(
    `SELECT s.id, s.dropped_events, s.turns_captured, s.total_turns, s.project_id
     FROM sessions s
     ${where}
     ORDER BY s.started_at DESC
     LIMIT ${QUERY_LIMIT}`,
    params
  );

  const sessions = result.rows.map((row) => ({
    sessionId: row.id,
    projectId: row.project_id ?? null,
    droppedEvents: Number(row.dropped_events),
    turnsCaptured: Number(row.turns_captured),
    totalTurns: Number(row.total_turns),
  }));

  // B6 fix: Flag when results are truncated due to LIMIT.
  const truncated = result.rows.length >= QUERY_LIMIT;

  // MISSING fix: Trigger alert evaluation as a side effect of completeness check.
  // Fire-and-forget to avoid blocking the response.
  triggerAlertEvaluation(apiKey).catch(() => {/* non-fatal */});

  return { status: 200, body: { sessions, truncated } };
}

// ---------------------------------------------------------------------------
// GET /v1/monitoring/availability
// ---------------------------------------------------------------------------

export async function handleAvailability(
  _apiKey: ApiKeyInfo,
  projectId?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const pool = getPool();

  try {
    // W15 fix: Filter heartbeats by last 24h as default, with LIMIT.
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const hbResult = await pool.query(
      `SELECT timestamp FROM heartbeats WHERE timestamp >= $1 ORDER BY timestamp ASC LIMIT 10000`,
      [last24h]
    );

    if (hbResult.rows.length === 0) {
      return {
        status: 200,
        body: {
          lastHeartbeat: null,
          uptimePercentage: 0,
          gapWindows: [],
        },
      };
    }

    const timestamps = hbResult.rows.map((r) => ({
      date: new Date(r.timestamp),
      ms: new Date(r.timestamp).getTime(),
    }));

    const lastHeartbeat = timestamps[timestamps.length - 1].date.toISOString();

    // Detect gaps: any interval > 90 seconds (3x normal 30-second interval)
    const gapThresholdMs = 90_000;
    const gapWindows: Array<{ start: string; end: string; durationSeconds: number }> = [];
    let totalGapMs = 0;

    for (let i = 1; i < timestamps.length; i++) {
      const diff = timestamps[i].ms - timestamps[i - 1].ms;
      if (diff > gapThresholdMs) {
        gapWindows.push({
          start: timestamps[i - 1].date.toISOString(),
          end: timestamps[i].date.toISOString(),
          durationSeconds: Math.round(diff / 1000),
        });
        totalGapMs += diff - 30_000; // Subtract one normal interval
      }
    }

    const totalSpanMs = timestamps[timestamps.length - 1].ms - timestamps[0].ms;
    let uptimePercentage = 100;
    if (totalSpanMs > 0) {
      uptimePercentage =
        Math.round(((totalSpanMs - totalGapMs) / totalSpanMs) * 100 * 100) / 100;
    }

    // N2 fix: Return null uptimePercentage when heartbeat count < 2.
    const effectiveUptime = hbResult.rows.length < 2
      ? null
      : uptimePercentage;

    // MISSING fix: Trigger alert evaluation as a side effect of availability check.
    triggerAlertEvaluation(_apiKey).catch(() => {/* non-fatal */});

    return {
      status: 200,
      body: {
        lastHeartbeat,
        uptimePercentage: effectiveUptime,
        ...(effectiveUptime === null ? { note: "insufficient data" } : {}),
        gapWindows,
        // W3 fix: Return project context in availability response.
        ...(projectId ? { projectId } : {}),
      },
    };
  } catch {
    // heartbeats table may not exist yet
    return {
      status: 200,
      body: {
        lastHeartbeat: null,
        uptimePercentage: 0,
        gapWindows: [],
      },
    };
  }
}

// ---------------------------------------------------------------------------
// POST /v1/monitoring/alerts/configure
// ---------------------------------------------------------------------------

export async function handleAlertConfigure(
  body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  const webhookUrl = body.webhookUrl as string | undefined;
  const completenessThreshold = body.completenessThreshold ?? 100.0;
  const availabilityThreshold = body.availabilityThreshold ?? 99.9;

  // Validation
  if (!webhookUrl) {
    return { status: 400, body: { error: "Missing required field: webhookUrl" } };
  }

  // W11 fix: Validate threshold values are finite numbers.
  if (typeof completenessThreshold !== "number" || !Number.isFinite(completenessThreshold)) {
    return { status: 400, body: { error: "completenessThreshold must be a finite number" } };
  }
  if (typeof availabilityThreshold !== "number" || !Number.isFinite(availabilityThreshold)) {
    return { status: 400, body: { error: "availabilityThreshold must be a finite number" } };
  }

  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(webhookUrl);
    if (!parsedUrl.protocol.startsWith("http")) {
      return { status: 400, body: { error: "webhookUrl must be a valid HTTP(S) URL" } };
    }
  } catch {
    return { status: 400, body: { error: "webhookUrl must be a valid URL" } };
  }

  // W2 fix: SSRF protection — reject private/loopback IP addresses.
  const hostname = parsedUrl.hostname.toLowerCase();
  const privatePatterns = [
    /^localhost$/,
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
    /^::1$/,
    /^0\.0\.0\.0$/,
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
    /^192\.168\.\d{1,3}\.\d{1,3}$/,
    /^169\.254\.\d{1,3}\.\d{1,3}$/,
    /^\[::1\]$/,
  ];
  if (privatePatterns.some((p) => p.test(hostname))) {
    return { status: 400, body: { error: "webhookUrl must not point to a private or loopback address" } };
  }

  // Use the key's project_id (not client-provided) for security
  const projectId = apiKey.projectId ?? "global";

  const pool = getPool();

  // Upsert: check if config exists for this project
  const existing = await pool.query(
    `SELECT id FROM alert_configs WHERE project_id = $1 LIMIT 1`,
    [projectId]
  );

  if (existing.rows.length > 0) {
    // Update
    await pool.query(
      `UPDATE alert_configs
       SET webhook_url = $1,
           completeness_threshold = $2,
           availability_threshold = $3,
           updated_at = now()
       WHERE project_id = $4`,
      [webhookUrl, completenessThreshold, availabilityThreshold, projectId]
    );
  } else {
    // Insert
    await pool.query(
      `INSERT INTO alert_configs (project_id, webhook_url, completeness_threshold, availability_threshold)
       VALUES ($1, $2, $3, $4)`,
      [projectId, webhookUrl, completenessThreshold, availabilityThreshold]
    );
  }

  return {
    status: 200,
    body: {
      configured: true,
      webhookUrl,
      completenessThreshold,
      availabilityThreshold,
    },
  };
}

// ---------------------------------------------------------------------------
// MISSING fix: Alert evaluation and dispatch mechanism (Deliverable 5)
// GET /v1/monitoring/alerts/evaluate
// ---------------------------------------------------------------------------

interface AlertResult {
  projectId: string;
  webhookUrl: string;
  alerts: Array<{ type: string; value: number; threshold: number }>;
  dispatched: boolean;
}

export async function handleAlertEvaluate(
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  const pool = getPool();

  // 1. Query alert_configs — scoped by project for non-admin keys (NEW-W1 fix)
  let configs: Array<{ project_id: string; webhook_url: string; completeness_threshold: number; availability_threshold: number }>;
  try {
    const configQuery = apiKey.projectId
      ? `SELECT project_id, webhook_url, completeness_threshold, availability_threshold
         FROM alert_configs WHERE project_id = $1 LIMIT 1000`
      : `SELECT project_id, webhook_url, completeness_threshold, availability_threshold
         FROM alert_configs LIMIT 1000`;
    const configParams = apiKey.projectId ? [apiKey.projectId] : [];
    const configResult = await pool.query(configQuery, configParams);
    configs = configResult.rows;
  } catch {
    return { status: 200, body: { results: [], message: "No alert configurations found" } };
  }

  if (configs.length === 0) {
    return { status: 200, body: { results: [], message: "No alert configurations found" } };
  }

  const results: AlertResult[] = [];

  for (const config of configs) {
    const alerts: Array<{ type: string; value: number; threshold: number }> = [];

    // 2. Check completeness for this project
    try {
      const compResult = await pool.query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE s.dropped_events = 0 AND s.turns_captured = s.total_turns) AS complete
         FROM sessions s
         WHERE s.project_id = $1
           AND s.started_at::timestamptz >= $2::timestamptz`,
        [config.project_id, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()]
      );
      const total = Number(compResult.rows[0]?.total ?? 0);
      const complete = Number(compResult.rows[0]?.complete ?? 0);
      const completenessPercentage = total > 0 ? (complete / total) * 100 : 100;

      if (completenessPercentage < config.completeness_threshold) {
        alerts.push({
          type: "completeness_below_threshold",
          value: Math.round(completenessPercentage * 100) / 100,
          threshold: config.completeness_threshold,
        });
      }
    } catch {
      // Non-fatal: skip completeness check if query fails
    }

    // 3. Check availability
    try {
      const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const hbResult = await pool.query(
        `SELECT timestamp FROM heartbeats WHERE timestamp >= $1 ORDER BY timestamp ASC LIMIT 10000`,
        [last24h]
      );

      if (hbResult.rows.length >= 2) {
        const timestamps = hbResult.rows.map((r) => new Date(r.timestamp).getTime());
        const gapThresholdMs = 90_000;
        let totalGapMs = 0;

        for (let i = 1; i < timestamps.length; i++) {
          const diff = timestamps[i] - timestamps[i - 1];
          if (diff > gapThresholdMs) {
            totalGapMs += diff - 30_000;
          }
        }

        const totalSpanMs = timestamps[timestamps.length - 1] - timestamps[0];
        const availabilityPercentage = totalSpanMs > 0
          ? ((totalSpanMs - totalGapMs) / totalSpanMs) * 100
          : 100;

        if (availabilityPercentage < config.availability_threshold) {
          alerts.push({
            type: "availability_below_threshold",
            value: Math.round(availabilityPercentage * 100) / 100,
            threshold: config.availability_threshold,
          });
        }
      }
    } catch {
      // Non-fatal: skip availability check if query fails
    }

    // 4. Dispatch webhook if threshold breached
    let dispatched = false;
    if (alerts.length > 0) {
      try {
        // W2 SSRF check on the stored webhook URL
        const webhookParsed = new URL(config.webhook_url);
        const wh = webhookParsed.hostname.toLowerCase();
        const privatePatterns = [
          /^localhost$/, /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, /^::1$/,
          /^0\.0\.0\.0$/, /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
          /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
          /^192\.168\.\d{1,3}\.\d{1,3}$/, /^169\.254\.\d{1,3}\.\d{1,3}$/,
        ];
        if (!privatePatterns.some((p) => p.test(wh))) {
          const response = await fetch(config.webhook_url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectId: config.project_id,
              alerts,
              evaluatedAt: new Date().toISOString(),
            }),
            signal: AbortSignal.timeout(10_000),
          });
          dispatched = response.ok;
        }
      } catch {
        // Webhook dispatch failed — non-fatal
        dispatched = false;
      }
    }

    results.push({
      projectId: config.project_id,
      webhookUrl: config.webhook_url,
      alerts,
      dispatched,
    });
  }

  return { status: 200, body: { results } };
}
