/**
 * Audit trail primitives.
 *
 * Hoisted from `api/src/resolvers/audit.ts` as part of C6. SQL bodies
 * preserved byte-for-byte; transport-shape concerns (GraphQLError
 * mapping, IntegrityStatus enum binding) stay in api/.
 *
 * Public surface:
 *   - listAuditEvents(apiKey, filter, options) -> ListEnvelope<AuditEntry>
 *   - getAuditEntries(apiKey, opts, options)   -> AuditEntry[]
 *
 * Contracts:
 *   - options.signal aborted BEFORE the SQL is issued throws AbortError.
 *   - filter.since accepts EITHER an opaque base64url-encoded SinceCursor
 *     OR a raw ISO 8601 date string for backward-compat.
 *   - integrityStatus is returned as a string ("verified" | "partial" |
 *     "retry" | "failed"); the api layer binds it to its enum type.
 */

import { getPool } from "./pool.js";
import { uniformListEnvelope, decodeSinceCursor } from "./envelope.js";
import { escapeIlike, formatTimestamp } from "./mappers.js";
import { resolveDateRange } from "./cost.js";
import type { ApiKeyInfo, ListEnvelope, ListOptions, SinceCursor } from "./types.js";

export type IntegrityStatusString = "verified" | "partial" | "retry" | "failed";

export interface AuditEntry {
  timestamp: string;
  sessionId: string;
  sequenceNum: number;
  provider: string;
  model: string | null;
  requestHash: string | null;
  responseHash: string | null;
  totalTokens: number;
  integrityStatus: IntegrityStatusString;
  httpStatus: number | null;
  captureComplete: boolean;
}

export interface AuditEventsFilter {
  search?: string;
  type?: string;
  period?: string;
  from?: string;
  to?: string;
  /**
   * Opaque base64url-encoded since cursor OR raw ISO 8601 date string.
   */
  since?: string;
}

export interface AuditEntriesOpts {
  search?: string;
  type?: string;
  from?: string;
  to?: string;
  projectId?: string | null;
}

function deriveIntegrityStatus(row: Record<string, unknown>): IntegrityStatusString {
  const httpStatusRaw = row.http_status;
  const httpStatus =
    httpStatusRaw !== null && httpStatusRaw !== undefined ? Number(httpStatusRaw) : null;

  if (httpStatus === 429) return "retry";
  if (httpStatus !== null && httpStatus >= 500) return "failed";

  const requestHash = row.request_hash as string | null;
  const responseHash = row.response_hash as string | null;
  const captureComplete = row.capture_complete as boolean;

  const hasRequestHash =
    requestHash !== null && requestHash !== undefined && requestHash !== "";
  const hasResponseHash =
    responseHash !== null && responseHash !== undefined && responseHash !== "";

  if (hasRequestHash && hasResponseHash && captureComplete) return "verified";
  return "partial";
}

function mapAuditEntry(row: Record<string, unknown>): AuditEntry {
  const inputTokens = Number(row.input_tokens) || 0;
  const outputTokens = Number(row.output_tokens) || 0;
  const thinkingTokens = Number(row.thinking_tokens) || 0;
  const totalTokens = inputTokens + outputTokens + thinkingTokens;

  const requestHash = row.request_hash as string | null;
  const responseHash = row.response_hash as string | null;

  return {
    timestamp: formatTimestamp(row.timestamp) ?? new Date().toISOString(),
    sessionId: row.session_id as string,
    sequenceNum: Number(row.sequence_num) || 0,
    provider: (row.provider as string) ?? "unknown",
    model: (row.model as string) ?? null,
    requestHash: requestHash && requestHash !== "" ? requestHash : null,
    responseHash: responseHash && responseHash !== "" ? responseHash : null,
    totalTokens,
    integrityStatus: deriveIntegrityStatus(row),
    httpStatus: row.http_status != null ? Number(row.http_status) : null,
    captureComplete:
      row.capture_complete !== undefined ? (row.capture_complete as boolean) : false,
  };
}

export async function listAuditEvents(
  apiKey: ApiKeyInfo,
  filter: AuditEventsFilter = {},
  options: ListOptions & { offset?: number } = {},
): Promise<ListEnvelope<AuditEntry> & { total: number; limit: number; offset: number }> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }

  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (apiKey.projectId) {
    conditions.push(`s.project_id = $${idx++}`);
    params.push(apiKey.projectId);
  }

  if (filter.search) {
    const escapedSearch = escapeIlike(filter.search);
    conditions.push(
      `(t.request_hash ILIKE '%' || $${idx} || '%' ESCAPE '\\' ` +
        `OR t.response_hash ILIKE '%' || $${idx} || '%' ESCAPE '\\' ` +
        `OR t.session_id ILIKE '%' || $${idx} || '%' ESCAPE '\\' ` +
        `OR t.model ILIKE '%' || $${idx} || '%' ESCAPE '\\' ` +
        `OR t.provider ILIKE '%' || $${idx} || '%' ESCAPE '\\')`,
    );
    params.push(escapedSearch);
    idx++;
  }

  const typeFilter = filter.type ?? "ALL";
  if (typeFilter === "REQUESTS") {
    conditions.push(`t.request_hash IS NOT NULL AND t.request_hash != ''`);
  } else if (typeFilter === "RESPONSES") {
    conditions.push(`t.response_hash IS NOT NULL AND t.response_hash != ''`);
  } else if (typeFilter === "ANOMALIES") {
    conditions.push(
      `(t.http_status = 429 ` +
        `OR t.http_status >= 500 ` +
        `OR t.request_hash = '' ` +
        `OR t.response_hash = '' ` +
        `OR t.capture_complete = FALSE)`,
    );
  }

  // Period shorthand. If both period and from/to are provided, from/to wins.
  if (filter.period || filter.from || filter.to) {
    const range = resolveDateRange(filter.period, filter.from, filter.to);
    conditions.push(`t.timestamp::timestamptz >= $${idx}::timestamptz`);
    params.push(range.from);
    idx++;
    conditions.push(`t.timestamp::timestamptz <= $${idx}::timestamptz`);
    params.push(range.to);
    idx++;
  }

  // since cursor: try opaque decode, fall back to raw ISO.
  if (filter.since) {
    let ts: string;
    let id: string | null = null;
    try {
      const decoded = decodeSinceCursor(filter.since as SinceCursor);
      ts = decoded.ts;
      id = decoded.id;
    } catch {
      ts = filter.since;
    }
    if (id !== null) {
      const tsIdx = idx++;
      const idIdx = idx++;
      conditions.push(
        `(t.timestamp::timestamptz > $${tsIdx}::timestamptz ` +
          `OR (t.timestamp::timestamptz = $${tsIdx}::timestamptz AND t.session_id || ':' || t.sequence_num::text > $${idIdx}))`,
      );
      params.push(ts);
      params.push(id);
    } else {
      conditions.push(`t.timestamp::timestamptz > $${idx++}::timestamptz`);
      params.push(ts);
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  let limit = options.limit ?? 50;
  let offset = options.offset ?? 0;
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
    pool.query(
      `SELECT t.timestamp, t.session_id, t.sequence_num, t.provider, t.model,
              t.request_hash, t.response_hash, t.input_tokens, t.output_tokens,
              t.thinking_tokens, t.http_status, t.capture_complete
       FROM turns t
       JOIN sessions s ON t.session_id = s.id
       ${where}
       ORDER BY t.timestamp DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    ),
    pool.query(
      `SELECT COUNT(*)::bigint AS total
       FROM turns t
       JOIN sessions s ON t.session_id = s.id
       ${where}`,
      countParams,
    ),
  ]);

  const items = result.rows.map((row: Record<string, unknown>) => mapAuditEntry(row));
  const total = Number(countResult.rows[0]?.total ?? 0);
  const truncated = offset + items.length < total;
  const nextOffset = truncated ? offset + items.length : null;

  return {
    ...uniformListEnvelope(items, { nextOffset, truncated }),
    total,
    limit,
    offset,
  };
}

export async function getAuditEntries(
  opts: AuditEntriesOpts,
  options: ListOptions = {},
): Promise<AuditEntry[]> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

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
        `OR t.provider ILIKE '%' || $${idx} || '%' ESCAPE '\\')`,
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
    conditions.push(
      `(t.http_status = 429 ` +
        `OR t.http_status >= 500 ` +
        `OR t.request_hash = '' ` +
        `OR t.response_hash = '' ` +
        `OR t.capture_complete = FALSE)`,
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await pool.query(
    `SELECT t.timestamp, t.session_id, t.sequence_num, t.provider, t.model,
            t.request_hash, t.response_hash, t.input_tokens, t.output_tokens,
            t.thinking_tokens, t.http_status, t.capture_complete
     FROM turns t
     JOIN sessions s ON t.session_id = s.id
     ${where}
     ORDER BY t.timestamp DESC
     LIMIT 10000`,
    params,
  );

  return result.rows.map((row: Record<string, unknown>) => mapAuditEntry(row));
}
