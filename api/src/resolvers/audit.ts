/**
 * Audit trail resolver -- Sprint D4.1.
 *
 * Contains Query.auditTrail: returns AuditConnection with derived integrityStatus.
 *
 * integrityStatus derivation logic:
 *   - http_status = 429            -> "retry"
 *   - http_status >= 500           -> "failed"
 *   - request_hash AND response_hash present AND capture_complete = true -> "verified"
 *   - else                         -> "partial"
 *
 * Supports search (across request_hash, response_hash, session_id, model, provider)
 * and type filter (ALL, REQUESTS, RESPONSES, ANOMALIES).
 *
 * D4.5: Project scoping -- reads ctx.apiKey.projectId and filters by s.project_id
 * when the API key is scoped to a specific project.
 * D4.5: integrityStatus is now an IntegrityStatus enum.
 * D4.5: type filter is now an AuditTypeFilter enum.
 * D4.5: model field added to AuditEntry.
 */

import { getPool } from "../db.js";
import { IntegrityStatus } from "../generated/graphql.js";
import type { QueryResolvers } from "../generated/graphql.js";
import { formatTimestamp, escapeIlike } from "./mappers.js";
import { resolveDateRange } from "./cost.js";

/**
 * Derive integrityStatus from turn row data.
 * Returns one of the IntegrityStatus enum values: "verified" | "partial" | "retry" | "failed".
 */
function deriveIntegrityStatus(row: Record<string, unknown>): IntegrityStatus {
  // PostgreSQL BIGINT columns are returned as strings by the pg driver.
  // Convert to number for comparison.
  const httpStatusRaw = row.http_status;
  const httpStatus = (httpStatusRaw !== null && httpStatusRaw !== undefined)
    ? Number(httpStatusRaw)
    : null;

  // Priority 1: 429 -> retry
  if (httpStatus === 429) return IntegrityStatus.Retry;

  // Priority 2: >= 500 -> failed
  if (httpStatus !== null && httpStatus >= 500) return IntegrityStatus.Failed;

  // Priority 3: both hashes present AND capture_complete -> verified
  const requestHash = row.request_hash as string | null;
  const responseHash = row.response_hash as string | null;
  const captureComplete = row.capture_complete as boolean;

  const hasRequestHash = requestHash !== null && requestHash !== undefined && requestHash !== "";
  const hasResponseHash = responseHash !== null && responseHash !== undefined && responseHash !== "";

  if (hasRequestHash && hasResponseHash && captureComplete) return IntegrityStatus.Verified;

  // Default: partial
  return IntegrityStatus.Partial;
}

/**
 * Build audit trail entries from raw turn rows joined with sessions.
 * D4.5: Now includes model field.
 */
function mapAuditEntry(row: Record<string, unknown>) {
  const inputTokens = Number(row.input_tokens) || 0;
  const outputTokens = Number(row.output_tokens) || 0;
  const thinkingTokens = Number(row.thinking_tokens) || 0;
  // W2: Compute totalTokens directly from component fields instead of referencing
  // a nonexistent total_tokens column in the SELECT. The turns table has no total_tokens
  // column -- it is always derived from input + output + thinking tokens.
  // PostgreSQL BIGINT values arrive as strings via pg, so coerce before arithmetic.
  // The largest stored turn total in the local recondo DB is 329,484, which is well
  // within GraphQL Int range once we avoid accidental string concatenation.
  const totalTokens = inputTokens + outputTokens + thinkingTokens;

  const requestHash = row.request_hash as string | null;
  const responseHash = row.response_hash as string | null;

  return {
    timestamp: formatTimestamp(row.timestamp) ?? new Date().toISOString(),
    sessionId: row.session_id as string,
    sequenceNum: Number(row.sequence_num) || 0,
    provider: (row.provider as string) ?? "unknown",
    model: (row.model as string) ?? null,
    requestHash: (requestHash && requestHash !== "") ? requestHash : null,
    responseHash: (responseHash && responseHash !== "") ? responseHash : null,
    totalTokens,
    integrityStatus: deriveIntegrityStatus(row),
    httpStatus: row.http_status != null ? Number(row.http_status) : null,
    captureComplete: row.capture_complete !== undefined
      ? (row.capture_complete as boolean)
      : false,
  };
}

// N5: Apollo Server catches resolver errors and returns them as GraphQL errors.
// Structured error logging deferred to Sprint D10 polish.
// D4.5: Now reads ctx.apiKey.projectId for project scoping.
const auditTrailResolver: NonNullable<QueryResolvers["auditTrail"]> = async (
  _parent,
  args,
  ctx
) => {
  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  // D4.5: Project scoping -- restrict to the API key's project when set
  if (ctx.apiKey.projectId) {
    conditions.push(`s.project_id = $${idx++}`);
    params.push(ctx.apiKey.projectId);
  }

  // Search filter: search across request_hash, response_hash, session_id, model, provider
  if (args.search) {
    const escapedSearch = escapeIlike(args.search);
    conditions.push(
      `(t.request_hash ILIKE '%' || $${idx} || '%' ESCAPE '\\' ` +
      `OR t.response_hash ILIKE '%' || $${idx} || '%' ESCAPE '\\' ` +
      `OR t.session_id ILIKE '%' || $${idx} || '%' ESCAPE '\\' ` +
      `OR t.model ILIKE '%' || $${idx} || '%' ESCAPE '\\' ` +
      `OR t.provider ILIKE '%' || $${idx} || '%' ESCAPE '\\')`
    );
    params.push(escapedSearch);
    idx++;
  }

  // D4.5: Type filter is now an AuditTypeFilter enum. GraphQL rejects invalid values.
  const typeFilter = (args.type ?? "ALL");
  if (typeFilter === "REQUESTS") {
    conditions.push(`t.request_hash IS NOT NULL AND t.request_hash != ''`);
  } else if (typeFilter === "RESPONSES") {
    conditions.push(`t.response_hash IS NOT NULL AND t.response_hash != ''`);
  }
  // ANOMALIES: handled in SQL for accuracy
  if (typeFilter === "ANOMALIES") {
    // ANOMALIES = not verified. That means either:
    // - http_status = 429 (retry)
    // - http_status >= 500 (failed)
    // - missing hashes or capture_complete = false (partial)
    // W1: request_hash/response_hash are NOT NULL in DDL; empty string indicates missing hash.
    // Removed IS NULL checks -- only empty-string checks are needed.
    conditions.push(
      `(t.http_status = 429 ` +
      `OR t.http_status >= 500 ` +
      `OR t.request_hash = '' ` +
      `OR t.response_hash = '' ` +
      `OR t.capture_complete = FALSE)`
    );
  }

  // D4 Finding 5: period shorthand for auditTrail. If both period and from/to
  // are provided, from/to takes precedence (handled by resolveDateRange).
  // Only apply period-derived dates when at least one of period/from/to is set.
  if (args.period || args.from || args.to) {
    const range = resolveDateRange(
      args.period as string | undefined,
      args.from as string | undefined,
      args.to as string | undefined
    );
    conditions.push(`t.timestamp::timestamptz >= $${idx}::timestamptz`);
    params.push(range.from);
    idx++;
    conditions.push(`t.timestamp::timestamptz <= $${idx}::timestamptz`);
    params.push(range.to);
    idx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Pagination: default limit 50, max 500
  let limit = args.limit ?? 50;
  let offset = args.offset ?? 0;
  if (limit < 0) limit = 0;
  if (limit > 500) limit = 500;
  if (offset < 0) offset = 0;
  if (offset > 100000) offset = 100000;

  const countParams = [...params];

  params.push(limit);
  const limitIdx = idx++;
  params.push(offset);
  const offsetIdx = idx++;

  const [result, countResult] = await Promise.all([
    // D4.5: Added t.model to SELECT for AuditEntry.model field.
    // N4: JOIN sessions acts as existence filter -- excludes orphan turns without a parent session.
    pool.query(
      `SELECT t.timestamp, t.session_id, t.sequence_num, t.provider, t.model,
              t.request_hash, t.response_hash, t.input_tokens, t.output_tokens,
              t.thinking_tokens, t.http_status, t.capture_complete
       FROM turns t
       JOIN sessions s ON t.session_id = s.id
       ${where}
       ORDER BY t.timestamp DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    ),
    pool.query(
      `SELECT COUNT(*)::bigint AS total
       FROM turns t
       JOIN sessions s ON t.session_id = s.id
       ${where}`,
      countParams
    ),
  ]);

  const items = result.rows.map((row: Record<string, unknown>) => mapAuditEntry(row));
  const total = Number(countResult.rows[0]?.total ?? 0);

  return {
    items,
    total,
    limit,
    offset,
  };
};

export const auditResolvers = {
  Query: {
    auditTrail: auditTrailResolver,
  },
};

/**
 * Shared function for REST export endpoints.
 * Returns audit entries with the same integrityStatus derivation logic.
 *
 * D4.5: Now accepts projectId for project scoping from route handlers.
 */
export async function getAuditEntries(opts: {
  search?: string;
  type?: string;
  from?: string;
  to?: string;
  projectId?: string | null;
}): Promise<Array<ReturnType<typeof mapAuditEntry>>> {
  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  // D4.5: Project scoping -- restrict to the given project when set
  if (opts.projectId) {
    conditions.push(`s.project_id = $${idx++}`);
    params.push(opts.projectId);
  }

  if (opts.search) {
    const escapedSearch = escapeIlike(opts.search);
    conditions.push(
      `(t.request_hash ILIKE '%' || $${idx} || '%' ESCAPE '\\' ` +
      `OR t.response_hash ILIKE '%' || $${idx} || '%' ESCAPE '\\' ` +
      `OR t.session_id ILIKE '%' || $${idx} || '%' ESCAPE '\\' ` +
      `OR t.model ILIKE '%' || $${idx} || '%' ESCAPE '\\' ` +
      `OR t.provider ILIKE '%' || $${idx} || '%' ESCAPE '\\')`
    );
    params.push(escapedSearch);
    idx++;
  }

  if (opts.from) {
    conditions.push(`t.timestamp::timestamptz >= $${idx++}::timestamptz`);
    params.push(opts.from);
  }

  if (opts.to) {
    conditions.push(`t.timestamp::timestamptz <= $${idx++}::timestamptz`);
    params.push(opts.to);
  }

  const typeFilter = (opts.type ?? "ALL").toUpperCase();
  if (typeFilter === "REQUESTS") {
    conditions.push(`t.request_hash IS NOT NULL AND t.request_hash != ''`);
  } else if (typeFilter === "RESPONSES") {
    conditions.push(`t.response_hash IS NOT NULL AND t.response_hash != ''`);
  } else if (typeFilter === "ANOMALIES") {
    // W1: request_hash/response_hash are NOT NULL in DDL; empty string indicates missing hash.
    conditions.push(
      `(t.http_status = 429 ` +
      `OR t.http_status >= 500 ` +
      `OR t.request_hash = '' ` +
      `OR t.response_hash = '' ` +
      `OR t.capture_complete = FALSE)`
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // D4.5: Added t.model to SELECT for AuditEntry.model field.
  // N4: JOIN sessions acts as existence filter -- excludes orphan turns without a parent session.
  const result = await pool.query(
    `SELECT t.timestamp, t.session_id, t.sequence_num, t.provider, t.model,
            t.request_hash, t.response_hash, t.input_tokens, t.output_tokens,
            t.thinking_tokens, t.http_status, t.capture_complete
     FROM turns t
     JOIN sessions s ON t.session_id = s.id
     ${where}
     ORDER BY t.timestamp DESC
     LIMIT 10000`,
    params
  );

  return result.rows.map((row: Record<string, unknown>) => mapAuditEntry(row));
}
