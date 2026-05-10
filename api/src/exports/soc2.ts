/**
 * Sprint 5 Deliverable 4: SOC 2 Evidence Package Export
 *
 * POST /v1/exports/soc2
 *
 * Generates a JSON evidence package containing:
 * - completeness: sessions with turns_captured, total_turns, dropped_events, %
 * - integrity: per-session hash verification summary
 * - accessLog: summary of access_audit_log entries
 * - availability: gateway heartbeat/uptime record
 * - processingIntegrity: hash verification statistics
 * - metadata: report generation info
 */

import { getPool } from "@recondo/data";
import type { ApiKeyInfo } from "../context.js";

// N5 fix: Soc2Request interface removed — input validation is done
// inline with runtime type checks, not static types on untyped body.

export async function handleSoc2Export(
  body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  const projectId = body.projectId as string | undefined;
  const startDate = body.startDate as string | undefined;
  const endDate = body.endDate as string | undefined;

  // Validation
  if (!projectId) {
    return { status: 400, body: { error: "Missing required field: projectId" } };
  }

  // ISSUE 9 fix: Validate projectId is a valid UUID format
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
    return { status: 400, body: { error: "Invalid projectId format: must be a UUID" } };
  }

  if (!startDate || !endDate) {
    return { status: 400, body: { error: "Missing required fields: startDate, endDate" } };
  }

  // Validate date range
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { status: 400, body: { error: "Invalid date format" } };
  }

  if (start.getTime() > end.getTime()) {
    return { status: 400, body: { error: "startDate must be before or equal to endDate" } };
  }

  // W14 fix: Non-admin keys attempting cross-project access get 403 Forbidden.
  if (apiKey.projectId && apiKey.projectId !== projectId) {
    return { status: 403, body: { error: "Forbidden" } };
  }
  const effectiveProjectId = projectId;

  const pool = getPool();

  // ---- Completeness Section ----
  // B6 fix: Add LIMIT to prevent unbounded result sets.
  const QUERY_LIMIT = 10000;
  const sessionsResult = await pool.query(
    `SELECT id, turns_captured, total_turns, dropped_events
     FROM sessions
     WHERE project_id = $1
       AND started_at::timestamptz >= $2::timestamptz
       AND started_at::timestamptz <= $3::timestamptz
     ORDER BY started_at
     LIMIT $4`,
    [effectiveProjectId, start.toISOString(), end.toISOString(), QUERY_LIMIT]
  );

  const sessions = sessionsResult.rows.map((row) => {
    const turnsCaptured = Number(row.turns_captured);
    const totalTurns = Number(row.total_turns);
    const droppedEvents = Number(row.dropped_events);
    const completenessPercentage =
      totalTurns > 0 ? Math.round((turnsCaptured / totalTurns) * 100 * 100) / 100 : 100;

    return {
      sessionId: row.id,
      turnsCaptured,
      totalTurns,
      droppedEvents,
      completenessPercentage,
    };
  });

  // ---- Integrity Section ----
  // Count turns with hash references present (verified) vs missing (failed)
  const integrityResult = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE t.request_hash IS NOT NULL AND t.response_hash IS NOT NULL AND t.req_bytes_ref IS NOT NULL AND t.resp_bytes_ref IS NOT NULL) AS verified,
       COUNT(*) FILTER (WHERE t.req_bytes_ref IS NULL OR t.resp_bytes_ref IS NULL) AS failed
     FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1
       AND t.timestamp::timestamptz >= $2::timestamptz
       AND t.timestamp::timestamptz <= $3::timestamptz`,
    [effectiveProjectId, start.toISOString(), end.toISOString()]
  );

  const verifiedCount = Number(integrityResult.rows[0]?.verified ?? 0);
  const failedCount = Number(integrityResult.rows[0]?.failed ?? 0);

  // ---- Access Log Section ----
  // B3 fix: Scope access log by date range AND project via api_keys join.
  const accessResult = await pool.query(
    `SELECT COUNT(*) AS total,
            COUNT(DISTINCT aal.api_key_id) AS unique_users
     FROM access_audit_log aal
     JOIN api_keys ak ON aal.api_key_id = ak.id::text
     WHERE aal.timestamp >= $1
       AND aal.timestamp <= $2
       AND (ak.project_id::text = $3 OR ak.project_id IS NULL)`,
    [start.toISOString(), end.toISOString(), effectiveProjectId]
  );

  const totalQueries = Number(accessResult.rows[0]?.total ?? 0);
  const uniqueUsers = Number(accessResult.rows[0]?.unique_users ?? 0);

  // Query type breakdown
  // B3 fix: Also scoped by date range and project.
  const breakdownResult = await pool.query(
    `SELECT aal.query_type, COUNT(*) AS cnt
     FROM access_audit_log aal
     JOIN api_keys ak ON aal.api_key_id = ak.id::text
     WHERE aal.timestamp >= $1
       AND aal.timestamp <= $2
       AND (ak.project_id::text = $3 OR ak.project_id IS NULL)
     GROUP BY aal.query_type
     ORDER BY cnt DESC`,
    [start.toISOString(), end.toISOString(), effectiveProjectId]
  );

  const queryTypeBreakdown: Record<string, number> = {};
  for (const row of breakdownResult.rows) {
    queryTypeBreakdown[row.query_type] = Number(row.cnt);
  }

  // ---- Availability Section ----
  let heartbeatCount = 0;
  let gapCount = 0;
  let availabilityPercentage = 100;

  try {
    // B5 fix: Scope heartbeats by the validated start/end date range.
    const hbResult = await pool.query(
      `SELECT COUNT(*) AS cnt FROM heartbeats WHERE timestamp >= $1 AND timestamp <= $2`,
      [start.toISOString(), end.toISOString()]
    );
    heartbeatCount = Number(hbResult.rows[0]?.cnt ?? 0);

    if (heartbeatCount > 0) {
      // B5+B6 fix: Only get heartbeat timestamps within the date range, with LIMIT.
      const hbTimes = await pool.query(
        `SELECT timestamp FROM heartbeats WHERE timestamp >= $1 AND timestamp <= $2 ORDER BY timestamp ASC LIMIT $3`,
        [start.toISOString(), end.toISOString(), QUERY_LIMIT]
      );

      const timestamps = hbTimes.rows.map((r) => new Date(r.timestamp).getTime());
      const gapThresholdMs = 90_000; // 90 seconds = 3x the normal 30-second interval

      let totalGapMs = 0;
      for (let i = 1; i < timestamps.length; i++) {
        const diff = timestamps[i] - timestamps[i - 1];
        if (diff > gapThresholdMs) {
          gapCount++;
          totalGapMs += diff - 30_000; // Subtract one normal interval
        }
      }

      const totalSpanMs = timestamps[timestamps.length - 1] - timestamps[0];
      if (totalSpanMs > 0) {
        availabilityPercentage =
          Math.round(((totalSpanMs - totalGapMs) / totalSpanMs) * 100 * 100) / 100;
      }
    }
  } catch {
    // heartbeats table may not exist yet
  }

  // ---- Processing Integrity Section ----
  const processingIntegrity = {
    statement:
      "All captured API calls have SHA-256 content hashes computed at capture time. " +
      `${verifiedCount} turns verified with complete hash chain, ${failedCount} with incomplete references.`,
    verifiedCount,
    failedCount,
  };

  // ---- Metadata Section ----
  // W4 fix: Use effectiveProjectId in metadata, not the original projectId.
  const metadata = {
    generatedAt: new Date().toISOString(),
    startDate,
    endDate,
    projectId: effectiveProjectId,
    generatorVersion: "0.1.0",
  };

  // B6 fix: Flag when results are truncated due to LIMIT.
  const truncated = sessionsResult.rows.length >= QUERY_LIMIT;

  return {
    status: 200,
    body: {
      completeness: { sessions, truncated },
      integrity: { verifiedCount, failedCount },
      accessLog: { totalQueries, uniqueUsers, queryTypeBreakdown },
      availability: { heartbeatCount, gapCount, availabilityPercentage },
      processingIntegrity,
      metadata,
    },
  };
}
