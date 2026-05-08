/**
 * Anomaly list primitive.
 *
 * Hoisted from `api/src/resolvers/anomalies.ts` as part of C6. SQL body
 * preserved byte-for-byte; transport-shape concerns (GraphQL nested
 * resolvers, DataLoader) stay in api/.
 *
 * Public surface:
 *   - listAnomalies(apiKey, filter, options) -> ListEnvelope<MappedAnomaly>
 *
 * Contracts:
 *   - options.signal aborted BEFORE the SQL is issued throws AbortError.
 *   - filter.since accepts EITHER an opaque base64url-encoded SinceCursor
 *     OR a raw ISO 8601 date string for backward-compat with v0 callers.
 *     Heuristic: try cursor decode first; on failure, treat as ISO.
 *   - When `since` decodes to a cursor with both ts and id, the WHERE
 *     clause emits a tie-break form so paginated cursors are stable
 *     across rows that share `detected_at`.
 */
import { getPool } from "./pool.js";
import { uniformListEnvelope, decodeSinceCursor } from "./envelope.js";
import { mapAnomaly, type MappedAnomaly } from "./mappers.js";
import type { ApiKeyInfo, ListEnvelope, ListOptions, SinceCursor } from "./types.js";

export interface AnomaliesFilter {
  severity?: string;
  sessionId?: string;
  anomalyType?: string;
  /**
   * Either an opaque since cursor (base64url(JSON({ts,id}))) OR a raw ISO
   * 8601 date string for backward-compat with v0 callers. Heuristic: try
   * cursor decode first; on failure, treat as ISO.
   */
  since?: string;
}

export async function listAnomalies(
  apiKey: ApiKeyInfo,
  filter: AnomaliesFilter = {},
  options: ListOptions = {},
): Promise<ListEnvelope<MappedAnomaly>> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  // Project scoping: join with sessions to filter by project
  if (apiKey.projectId) {
    conditions.push(`s.project_id = $${idx++}`);
    params.push(apiKey.projectId);
  }

  if (filter.severity) {
    conditions.push(`a.severity = $${idx++}`);
    params.push(filter.severity);
  }
  if (filter.sessionId) {
    conditions.push(`a.session_id = $${idx++}`);
    params.push(filter.sessionId);
  }
  if (filter.anomalyType) {
    conditions.push(`a.anomaly_type = $${idx++}`);
    params.push(filter.anomalyType);
  }

  // D-AN2 + D-AN3: try opaque cursor decode, fall back to raw ISO.
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
      // Tie-break form: detected_at > $N OR (detected_at = $N AND a.id > $M)
      const tsIdx = idx++;
      const idIdx = idx++;
      conditions.push(
        `(a.detected_at::TIMESTAMPTZ > $${tsIdx}::timestamptz ` +
          `OR (a.detected_at::TIMESTAMPTZ = $${tsIdx}::timestamptz AND a.id > $${idIdx}))`,
      );
      params.push(ts);
      params.push(id);
    } else {
      conditions.push(`a.detected_at::TIMESTAMPTZ >= $${idx++}::timestamptz`);
      params.push(ts);
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // R2-N4: Cap limit to max 1000, offset to max 100000, validate non-negative
  let limit = options.limit ?? 100;
  let offset = options.offset ?? 0;
  if (limit < 0) limit = 0;
  if (limit > 1000) limit = 1000;
  if (offset < 0) offset = 0;
  if (offset > 100000) offset = 100000;
  const requestedLimit = limit;
  const queryLimit = requestedLimit < 1000 ? requestedLimit + 1 : requestedLimit;

  params.push(queryLimit);
  const limitIdx = idx++;
  params.push(offset);
  const offsetIdx = idx++;

  const result = await pool.query(
    `SELECT a.* FROM anomaly_events a
     LEFT JOIN sessions s ON a.session_id = s.id
     ${where}
     ORDER BY a.detected_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );

  const hasMore = requestedLimit < 1000 && result.rows.length > requestedLimit;
  const rows = hasMore ? result.rows.slice(0, requestedLimit) : result.rows;
  const items = rows.map(mapAnomaly);
  const truncated = hasMore;
  const nextOffset = truncated ? offset + items.length : null;
  return uniformListEnvelope(items, { nextOffset, truncated });
}
