/**
 * Reports resolvers -- Sprint D6.1.
 *
 * Contains:
 *   Query.reports              -- paginated reports list
 *   Query.reportCoverageTrend  -- coverage trend data points
 *   Query.reportFindingsTrend  -- findings trend data points
 *   Mutation.generateReport    -- generate a compliance report
 *
 * Tables used:
 *   reports, report_coverage, turns, anomaly_events
 */

import { getPool } from "../db.js";
import { ReportStatus } from "../generated/graphql.js";
import type { QueryResolvers, MutationResolvers } from "../generated/graphql.js";
import type { GqlContext } from "../context.js";
import { formatTimestamp } from "./mappers.js";
import crypto from "crypto";

/**
 * Map a database status string to the ReportStatus enum.
 * N4: Throws on unknown status rather than silently returning a default.
 */
function mapToReportStatus(status: string): ReportStatus {
  switch (status) {
    case "FINAL": return ReportStatus.Final;
    case "DRAFT": return ReportStatus.Draft;
    default: throw new Error(`Unknown report status: '${status}'`);
  }
}

/**
 * B2: Build project scoping conditions for reports queries.
 * Only adds the condition when ctx.apiKey.projectId is set (non-admin).
 */
function addProjectScope(
  ctx: GqlContext,
  conditions: string[],
  params: unknown[],
  startIdx: number,
): number {
  if (ctx.apiKey.projectId) {
    conditions.push(`project_id = $${startIdx}`);
    params.push(ctx.apiKey.projectId);
    return startIdx + 1;
  }
  return startIdx;
}

/**
 * D6.1: reports query resolver.
 * Returns paginated reports ordered by generated_at DESC.
 * B2: Project-scoped when ctx.apiKey.projectId is set.
 */
const reportsResolver: NonNullable<QueryResolvers["reports"]> = async (
  _parent,
  args,
  ctx
) => {
  const pool = getPool();

  let limit = args.limit ?? 50;
  let offset = args.offset ?? 0;
  if (limit < 1) limit = 1;
  if (limit > 500) limit = 500;
  if (offset < 0) offset = 0;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = addProjectScope(ctx, conditions, params, 1);

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  params.push(limit, offset);

  const [result, countResult] = await Promise.all([
    pool.query(
      `SELECT id, name, framework, period_start, period_end, capture_count,
              findings_critical, findings_high, findings_medium, findings_low,
              hash, status, generated_at
       FROM reports
       ${whereClause}
       ORDER BY generated_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      params
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM reports ${whereClause}`,
      params.slice(0, paramIdx - 1)
    ),
  ]);

  const total = (countResult.rows[0]?.total as number) ?? 0;

  const items = result.rows.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    name: row.name as string,
    framework: row.framework as string,
    periodStart: formatTimestamp(row.period_start) ?? new Date().toISOString(),
    periodEnd: formatTimestamp(row.period_end) ?? new Date().toISOString(),
    captureCount: (row.capture_count as number) ?? 0,
    findings: {
      critical: (row.findings_critical as number) ?? 0,
      high: (row.findings_high as number) ?? 0,
      medium: (row.findings_medium as number) ?? 0,
      low: (row.findings_low as number) ?? 0,
    },
    hash: (row.hash as string) ?? null,
    status: mapToReportStatus(row.status as string),
    generatedAt: formatTimestamp(row.generated_at) ?? new Date().toISOString(),
  }));

  return { items, total, limit, offset };
};

/**
 * D6.1: reportCoverageTrend query resolver.
 * Returns coverage trend data points from the report_coverage table.
 * B5: Uses Number(x) || 0 instead of Number(x) ?? 0 to handle NaN.
 */
const reportCoverageTrendResolver: NonNullable<QueryResolvers["reportCoverageTrend"]> = async (
  _parent,
  _args,
  _ctx
) => {
  const pool = getPool();

  const result = await pool.query(
    `SELECT label, value
     FROM report_coverage
     ORDER BY recorded_at ASC`
  );

  return result.rows.map((row: Record<string, unknown>) => ({
    label: row.label as string,
    value: Number(row.value) || 0,
  }));
};

/**
 * D6.1: reportFindingsTrend query resolver.
 * Returns findings trend data points aggregated from reports, grouped by name/framework.
 * B5: Uses Number(x) || 0 instead of Number(x) ?? 0 to handle NaN.
 */
const reportFindingsTrendResolver: NonNullable<QueryResolvers["reportFindingsTrend"]> = async (
  _parent,
  _args,
  _ctx
) => {
  const pool = getPool();

  const result = await pool.query(
    `SELECT name AS label,
            (findings_critical + findings_high + findings_medium + findings_low) AS value
     FROM reports
     ORDER BY generated_at ASC`
  );

  return result.rows.map((row: Record<string, unknown>) => ({
    label: row.label as string,
    value: Number(row.value) || 0,
  }));
};

/**
 * D6.1: generateReport mutation resolver.
 * Creates a new compliance report by counting turns in the given period
 * and computing a SHA-256 hash of the report content.
 *
 * W2: Hash excludes non-deterministic values (reportId, generatedAt).
 *     Only hashes: framework, periodStart, periodEnd, captureCount.
 * W4: Uses BEGIN/COMMIT/ROLLBACK for transactional integrity.
 * N1: Actually counts anomaly findings by severity in the period.
 * B2: Inserts project_id from ctx.apiKey.projectId when scoped.
 */
const generateReportMutation: NonNullable<MutationResolvers["generateReport"]> = async (
  _parent,
  args,
  ctx
) => {
  const pool = getPool();
  const { framework, periodStart, periodEnd } = args.input;

  // Validate periodStart < periodEnd
  const startDate = new Date(periodStart as string);
  const endDate = new Date(periodEnd as string);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return {
      report: null,
      errors: [{
        field: "periodStart",
        code: "INVALID",
        message: "Invalid date format for periodStart or periodEnd",
      }],
    };
  }

  if (startDate >= endDate) {
    return {
      report: null,
      errors: [{
        field: "periodStart",
        code: "INVALID_RANGE",
        message: "periodStart must be before periodEnd",
      }],
    };
  }

  // W4: Use a client from the pool for transactional integrity
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Count turns in the period
    const turnCountResult = await client.query(
      `SELECT COUNT(*)::int AS capture_count
       FROM turns
       WHERE timestamp::timestamptz >= $1::timestamptz
         AND timestamp::timestamptz <= $2::timestamptz`,
      [startDate.toISOString(), endDate.toISOString()]
    );

    const captureCount = (turnCountResult.rows[0]?.capture_count as number) ?? 0;

    // N1: Count anomaly findings by severity in the period
    const findingsResult = await client.query(
      `SELECT severity, COUNT(*)::int AS cnt
       FROM anomaly_events
       WHERE detected_at::TIMESTAMPTZ >= $1::timestamptz
         AND detected_at::TIMESTAMPTZ <= $2::timestamptz
       GROUP BY severity`,
      [startDate.toISOString(), endDate.toISOString()]
    );

    let findingsCritical = 0;
    let findingsHigh = 0;
    let findingsMedium = 0;
    let findingsLow = 0;

    for (const row of findingsResult.rows) {
      const severity = (row.severity as string).toLowerCase();
      const cnt = row.cnt as number;
      switch (severity) {
        case "critical": findingsCritical = cnt; break;
        case "high": findingsHigh = cnt; break;
        case "medium": findingsMedium = cnt; break;
        case "low": findingsLow = cnt; break;
        // info and other severities are not counted as findings
      }
    }

    // Generate report ID and name
    const reportId = crypto.randomUUID();
    const reportName = `${framework} Report`;
    const now = new Date();

    // W2: Compute SHA-256 hash excluding non-deterministic values (reportId, generatedAt).
    // Only hash: framework, periodStart, periodEnd, captureCount for reproducibility.
    const reportContent = JSON.stringify({
      framework,
      periodStart: startDate.toISOString(),
      periodEnd: endDate.toISOString(),
      captureCount,
    });
    const hash = crypto.createHash("sha256").update(reportContent).digest("hex");

    // B2: Include project_id in INSERT when scoped, omit for admin
    if (ctx.apiKey.projectId) {
      await client.query(
        `INSERT INTO reports (id, project_id, name, framework, period_start, period_end, capture_count,
                              findings_critical, findings_high, findings_medium, findings_low,
                              hash, status, generated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [reportId, ctx.apiKey.projectId, reportName, framework,
         startDate.toISOString(), endDate.toISOString(), captureCount,
         findingsCritical, findingsHigh, findingsMedium, findingsLow,
         hash, "FINAL", now.toISOString()]
      );
    } else {
      await client.query(
        `INSERT INTO reports (id, name, framework, period_start, period_end, capture_count,
                              findings_critical, findings_high, findings_medium, findings_low,
                              hash, status, generated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [reportId, reportName, framework,
         startDate.toISOString(), endDate.toISOString(), captureCount,
         findingsCritical, findingsHigh, findingsMedium, findingsLow,
         hash, "FINAL", now.toISOString()]
      );
    }

    await client.query("COMMIT");

    return {
      report: {
        id: reportId,
        name: reportName,
        framework: framework as string,
        periodStart: startDate.toISOString(),
        periodEnd: endDate.toISOString(),
        captureCount,
        findings: {
          critical: findingsCritical,
          high: findingsHigh,
          medium: findingsMedium,
          low: findingsLow,
        },
        hash,
        status: ReportStatus.Final,
        generatedAt: now.toISOString(),
      },
      errors: [],
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
};

export const reportResolvers = {
  Query: {
    reports: reportsResolver,
    reportCoverageTrend: reportCoverageTrendResolver,
    reportFindingsTrend: reportFindingsTrendResolver,
  },
  Mutation: {
    generateReport: generateReportMutation,
  },
};
