/**
 * Compliance report primitives.
 *
 * Hoisted from `api/src/resolvers/reports.ts` as part of C7. SQL bodies
 * preserved byte-for-byte; transport-shape concerns (GraphQL ReportStatus
 * enum binding, GraphQLError shaping) stay in api/.
 *
 * Public surface:
 *   - listReports(apiKey, filter, options)              -> ListEnvelope<ReportRow>
 *   - getReport(apiKey, id, options)                    -> ReportRow | null
 *   - listReportCoverageTrend(apiKey, args, options)    -> ListEnvelope<TrendPoint>
 *   - listReportFindingsTrend(apiKey, args, options)    -> ListEnvelope<TrendPoint>
 *   - generateReport(apiKey, input, options)            -> GenerateReportPayload
 *
 * Design notes:
 *   - `getReport(apiKey, id)` is a NEW function (no resolver originally
 *     surfaced a single-report read). SQL: SELECT all report columns
 *     FROM reports WHERE id = $1, project-scoped when apiKey.projectId
 *     is set. Returns null when the row does not exist or is not in
 *     scope.
 *   - `status` is returned as a raw string ("FINAL" | "DRAFT"); the
 *     api/ resolver binds it to the GraphQL ReportStatus enum.
 */

import crypto from "node:crypto";
import { getPool } from "./pool.js";
import { uniformListEnvelope } from "./envelope.js";
import { formatTimestamp } from "./mappers.js";
import type { ApiKeyInfo, ListEnvelope, ListOptions, QueryOptions } from "./types.js";

export interface ReportFindings {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface ReportRow {
  id: string;
  name: string;
  framework: string;
  periodStart: string;
  periodEnd: string;
  captureCount: number;
  findings: ReportFindings;
  hash: string | null;
  /** Raw status string ("FINAL" | "DRAFT"). */
  status: string;
  generatedAt: string;
}

export interface ReportFilter {
  // (placeholder for future filters; reports list does not yet take any.)
}

export interface TrendPoint {
  label: string;
  value: number;
}

export interface GenerateReportInput {
  framework: string;
  periodStart: string;
  periodEnd: string;
}

export interface GenerateReportError {
  field: string;
  code: string;
  message: string;
}

export interface GenerateReportPayload {
  report: ReportRow | null;
  errors: GenerateReportError[];
}

function mapReportRow(row: Record<string, unknown>): ReportRow {
  return {
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
    hash: (row.hash as string | null) ?? null,
    status: row.status as string,
    generatedAt: formatTimestamp(row.generated_at) ?? new Date().toISOString(),
  };
}

export async function listReports(
  apiKey: ApiKeyInfo,
  _filter: ReportFilter = {},
  options: ListOptions = {},
): Promise<ListEnvelope<ReportRow> & { total: number; limit: number; offset: number }> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();

  let limit = options.limit ?? 50;
  let offset = options.offset ?? 0;
  if (limit < 1) limit = 1;
  if (limit > 500) limit = 500;
  if (offset < 0) offset = 0;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (apiKey.projectId) {
    conditions.push(`project_id = $${idx++}`);
    params.push(apiKey.projectId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const countParams = [...params];

  params.push(limit);
  const limitIdx = idx++;
  params.push(offset);
  const offsetIdx = idx++;

  const [result, countResult] = await Promise.all([
    pool.query(
      `SELECT id, name, framework, period_start, period_end, capture_count,
              findings_critical, findings_high, findings_medium, findings_low,
              hash, status, generated_at
       FROM reports
       ${where}
       ORDER BY generated_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM reports ${where}`, countParams),
  ]);

  const total = (countResult.rows[0]?.total as number) ?? 0;
  const items = result.rows.map((row: Record<string, unknown>) => mapReportRow(row));
  const truncated = offset + items.length < total;
  const nextOffset = truncated ? offset + items.length : null;

  return {
    ...uniformListEnvelope(items, { nextOffset, truncated }),
    total,
    limit,
    offset,
  };
}

export async function getReport(
  apiKey: ApiKeyInfo,
  id: string,
  options: QueryOptions = {},
): Promise<ReportRow | null> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();

  const conditions = [`id = $1`];
  const params: unknown[] = [id];
  if (apiKey.projectId) {
    conditions.push(`project_id = $2`);
    params.push(apiKey.projectId);
  }

  const result = await pool.query(
    `SELECT id, name, framework, period_start, period_end, capture_count,
            findings_critical, findings_high, findings_medium, findings_low,
            hash, status, generated_at
     FROM reports
     WHERE ${conditions.join(" AND ")}
     LIMIT 1`,
    params,
  );

  if (result.rows.length === 0) return null;
  return mapReportRow(result.rows[0]);
}

export async function listReportCoverageTrend(
  _apiKey: ApiKeyInfo,
  _args: Record<string, never> = {},
  options: QueryOptions = {},
): Promise<ListEnvelope<TrendPoint>> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const result = await pool.query(
    `SELECT label, value
     FROM report_coverage
     ORDER BY recorded_at ASC`,
  );
  const items: TrendPoint[] = result.rows.map((row: Record<string, unknown>) => ({
    label: row.label as string,
    value: Number(row.value) || 0,
  }));
  return uniformListEnvelope(items, { nextOffset: null, truncated: false });
}

export async function listReportFindingsTrend(
  _apiKey: ApiKeyInfo,
  _args: Record<string, never> = {},
  options: QueryOptions = {},
): Promise<ListEnvelope<TrendPoint>> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const result = await pool.query(
    `SELECT name AS label,
            (findings_critical + findings_high + findings_medium + findings_low) AS value
     FROM reports
     ORDER BY generated_at ASC`,
  );
  const items: TrendPoint[] = result.rows.map((row: Record<string, unknown>) => ({
    label: row.label as string,
    value: Number(row.value) || 0,
  }));
  return uniformListEnvelope(items, { nextOffset: null, truncated: false });
}

export async function generateReport(
  apiKey: ApiKeyInfo,
  input: GenerateReportInput,
  options: QueryOptions = {},
): Promise<GenerateReportPayload> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const { framework, periodStart, periodEnd } = input;

  const startDate = new Date(periodStart);
  const endDate = new Date(periodEnd);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return {
      report: null,
      errors: [
        {
          field: "periodStart",
          code: "INVALID",
          message: "Invalid date format for periodStart or periodEnd",
        },
      ],
    };
  }

  if (startDate >= endDate) {
    return {
      report: null,
      errors: [
        {
          field: "periodStart",
          code: "INVALID_RANGE",
          message: "periodStart must be before periodEnd",
        },
      ],
    };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const turnCountResult = await client.query(
      `SELECT COUNT(*)::int AS capture_count
       FROM turns
       WHERE timestamp::timestamptz >= $1::timestamptz
         AND timestamp::timestamptz <= $2::timestamptz`,
      [startDate.toISOString(), endDate.toISOString()],
    );
    const captureCount = (turnCountResult.rows[0]?.capture_count as number) ?? 0;

    const findingsResult = await client.query(
      `SELECT severity, COUNT(*)::int AS cnt
       FROM anomaly_events
       WHERE detected_at::TIMESTAMPTZ >= $1::timestamptz
         AND detected_at::TIMESTAMPTZ <= $2::timestamptz
       GROUP BY severity`,
      [startDate.toISOString(), endDate.toISOString()],
    );

    let findingsCritical = 0;
    let findingsHigh = 0;
    let findingsMedium = 0;
    let findingsLow = 0;
    for (const row of findingsResult.rows) {
      const severity = (row.severity as string).toLowerCase();
      const cnt = row.cnt as number;
      if (severity === "critical") findingsCritical = cnt;
      else if (severity === "high") findingsHigh = cnt;
      else if (severity === "medium") findingsMedium = cnt;
      else if (severity === "low") findingsLow = cnt;
    }

    const reportId = crypto.randomUUID();
    const reportName = `${framework} Report`;
    const now = new Date();

    const reportContent = JSON.stringify({
      framework,
      periodStart: startDate.toISOString(),
      periodEnd: endDate.toISOString(),
      captureCount,
    });
    const hash = crypto.createHash("sha256").update(reportContent).digest("hex");

    if (apiKey.projectId) {
      await client.query(
        `INSERT INTO reports (id, project_id, name, framework, period_start, period_end, capture_count,
                              findings_critical, findings_high, findings_medium, findings_low,
                              hash, status, generated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          reportId,
          apiKey.projectId,
          reportName,
          framework,
          startDate.toISOString(),
          endDate.toISOString(),
          captureCount,
          findingsCritical,
          findingsHigh,
          findingsMedium,
          findingsLow,
          hash,
          "FINAL",
          now.toISOString(),
        ],
      );
    } else {
      await client.query(
        `INSERT INTO reports (id, name, framework, period_start, period_end, capture_count,
                              findings_critical, findings_high, findings_medium, findings_low,
                              hash, status, generated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          reportId,
          reportName,
          framework,
          startDate.toISOString(),
          endDate.toISOString(),
          captureCount,
          findingsCritical,
          findingsHigh,
          findingsMedium,
          findingsLow,
          hash,
          "FINAL",
          now.toISOString(),
        ],
      );
    }

    await client.query("COMMIT");

    return {
      report: {
        id: reportId,
        name: reportName,
        framework,
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
        status: "FINAL",
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
}
