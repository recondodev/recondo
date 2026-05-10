/**
 * Operator insights assembled from existing analytics tables.
 */

import { getPool } from "./pool.js";
import type { ApiKeyInfo, QueryOptions } from "./types.js";

export type InsightKind =
  | "high_cost_session"
  | "redundant_tool_calls"
  | "anomaly_spike"
  | "hash_drift_failure"
  | "policy_trigger_burst";

export type InsightSeverity = "info" | "warning" | "critical";

export interface Insight {
  kind: InsightKind;
  severity: InsightSeverity;
  message: string;
  suggested_next_call: { tool: string; args: Record<string, unknown> };
  evidence: Record<string, unknown>;
}

export interface InsightsArgs {
  projectId?: string;
  since?: string;
}

function addParam(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

function effectiveProjectId(
  apiKey: ApiKeyInfo,
  args: InsightsArgs,
): string | null | false {
  if (apiKey.projectId && args.projectId && args.projectId !== apiKey.projectId) {
    return false;
  }
  return args.projectId ?? apiKey.projectId ?? null;
}

function severityRank(severity: InsightSeverity): number {
  switch (severity) {
    case "critical":
      return 3;
    case "warning":
      return 2;
    case "info":
      return 1;
  }
}

function magnitude(insight: Insight): number {
  const values = Object.values(insight.evidence);
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

export async function getInsights(
  apiKey: ApiKeyInfo,
  args: InsightsArgs = {},
  options: QueryOptions = {},
): Promise<{ insights: Insight[] }> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }

  const projectId = effectiveProjectId(apiKey, args);
  if (projectId === false) {
    return { insights: [] };
  }

  const pool = getPool();
  const insights: Insight[] = [];

  {
    const params: unknown[] = [];
    const conditions = ["total_cost_usd > 0"];
    if (projectId) conditions.push(`project_id = ${addParam(params, projectId)}`);
    if (args.since) {
      conditions.push(`started_at::timestamptz >= ${addParam(params, args.since)}::timestamptz`);
    }
    const result = await pool.query(
      `SELECT id, total_cost_usd
       FROM sessions
       WHERE ${conditions.join(" AND ")}
       ORDER BY total_cost_usd DESC
       LIMIT 100`,
      params,
    );
    const rows = result.rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      totalCostUsd: Number(row.total_cost_usd ?? 0),
    }));
    if (rows.length > 0) {
      const sorted = [...rows].sort((a, b) => a.totalCostUsd - b.totalCostUsd);
      const median = sorted[Math.floor((sorted.length - 1) / 2)]?.totalCostUsd ?? 0;
      const top = rows[0]!;
      if (top.totalCostUsd > 0 && (median === 0 || top.totalCostUsd >= median * 5)) {
        insights.push({
          kind: "high_cost_session",
          severity: "warning",
          message: `Session ${top.id} is a cost outlier.`,
          suggested_next_call: {
            tool: "recondo_get_session",
            args: { session_id: top.id },
          },
          evidence: {
            session_id: top.id,
            total_cost_usd: top.totalCostUsd,
            median_cost_usd: median,
          },
        });
      }
    }
  }

  {
    const params: unknown[] = [];
    const conditions = [
      "tc.input_hash IS NOT NULL",
      "t.timestamp::timestamptz >= NOW() - INTERVAL '1 hour'",
    ];
    if (projectId) conditions.push(`s.project_id = ${addParam(params, projectId)}`);
    if (args.since) {
      conditions.push(`t.timestamp::timestamptz >= ${addParam(params, args.since)}::timestamptz`);
    }
    const result = await pool.query(
      `SELECT tc.tool_name,
              tc.input_hash,
              COUNT(*)::int AS count
       FROM tool_calls tc
       JOIN turns t ON t.id = tc.turn_id
       JOIN sessions s ON s.id = t.session_id
       WHERE ${conditions.join(" AND ")}
       GROUP BY tc.tool_name, tc.input_hash
       HAVING COUNT(*) >= 10
       ORDER BY count DESC
       LIMIT 1`,
      params,
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row) {
      insights.push({
        kind: "redundant_tool_calls",
        severity: "warning",
        message: `Tool ${String(row.tool_name)} repeated the same input hash ${Number(row.count)} times in the last hour.`,
        suggested_next_call: {
          tool: "recondo_tool_call_stats",
          args: { group_by: "tool_name", period: "day" },
        },
        evidence: {
          tool_name: row.tool_name as string,
          input_hash: row.input_hash as string,
          count: Number(row.count ?? 0),
        },
      });
    }
  }

  {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (projectId) {
      conditions.push(`COALESCE(a.project_id, s.project_id) = ${addParam(params, projectId)}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE a.detected_at::timestamptz >= NOW() - INTERVAL '7 days'
         )::int AS recent,
         COUNT(*) FILTER (
           WHERE a.detected_at::timestamptz < NOW() - INTERVAL '7 days'
             AND a.detected_at::timestamptz >= NOW() - INTERVAL '14 days'
         )::int AS previous
       FROM anomaly_events a
       LEFT JOIN sessions s ON s.id = a.session_id
       ${where}`,
      params,
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    const recent = Number(row?.recent ?? 0);
    const previous = Number(row?.previous ?? 0);
    if (recent > 0 && recent > previous * 2) {
      insights.push({
        kind: "anomaly_spike",
        severity: previous === 0 && recent >= 5 ? "critical" : "warning",
        message: `Anomalies increased from ${previous} to ${recent} over the trailing week.`,
        suggested_next_call: {
          tool: "recondo_anomalies",
          args: { limit: 20 },
        },
        evidence: { recent, previous },
      });
    }
  }

  {
    const params: unknown[] = [];
    const conditions = [
      "((t.request_hash IS NOT NULL AND t.req_bytes_ref IS NULL) OR (t.response_hash IS NOT NULL AND t.resp_bytes_ref IS NULL))",
    ];
    if (projectId) conditions.push(`s.project_id = ${addParam(params, projectId)}`);
    if (args.since) {
      conditions.push(`t.timestamp::timestamptz >= ${addParam(params, args.since)}::timestamptz`);
    }
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count,
              MIN(t.id) AS turn_id,
              MIN(t.session_id) AS session_id
       FROM turns t
       JOIN sessions s ON s.id = t.session_id
       WHERE ${conditions.join(" AND ")}`,
      params,
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    const count = Number(row?.count ?? 0);
    if (count > 0) {
      insights.push({
        kind: "hash_drift_failure",
        severity: "critical",
        message: `${count} turn(s) have hashes without matching stored raw-byte references.`,
        suggested_next_call: {
          tool: "recondo_verify_integrity",
          args: { session_id: row?.session_id as string },
        },
        evidence: {
          count,
          turn_id: row?.turn_id as string,
          session_id: row?.session_id as string,
        },
      });
    }
  }

  {
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (projectId) conditions.push(`p.project_id = ${addParam(params, projectId)}`);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT p.id,
              p.name,
              COUNT(pt.id) FILTER (
                WHERE pt.triggered_at >= NOW() - INTERVAL '7 days'
              )::int AS recent,
              COUNT(pt.id) FILTER (
                WHERE pt.triggered_at < NOW() - INTERVAL '7 days'
                  AND pt.triggered_at >= NOW() - INTERVAL '14 days'
              )::int AS previous
       FROM policies p
       LEFT JOIN policy_triggers pt ON pt.policy_id = p.id
       ${where}
       GROUP BY p.id, p.name
       ORDER BY recent DESC
       LIMIT 1`,
      params,
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    const recent = Number(row?.recent ?? 0);
    const previous = Number(row?.previous ?? 0);
    if (row && recent >= 5 && recent > previous * 2) {
      insights.push({
        kind: "policy_trigger_burst",
        severity: "warning",
        message: `Policy ${String(row.name)} triggered ${recent} times in the trailing week.`,
        suggested_next_call: {
          tool: "recondo_policies",
          args: { include: ["trigger_history"], policy_id: row.id as string },
        },
        evidence: {
          policy_id: row.id as string,
          policy_name: row.name as string,
          recent,
          previous,
        },
      });
    }
  }

  insights.sort((a, b) => {
    const severityDelta = severityRank(b.severity) - severityRank(a.severity);
    if (severityDelta !== 0) return severityDelta;
    return magnitude(b) - magnitude(a);
  });

  return { insights: insights.slice(0, 5) };
}
