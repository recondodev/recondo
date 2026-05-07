/**
 * Turn detail / search primitives.
 *
 * Hoisted from `api/src/resolvers/turns.ts`. SQL bodies preserved
 * byte-for-byte; transport-shape concerns (GraphQLError mapping,
 * Array.fromAsync materialisation) stay in api/.
 *
 * Public surface:
 *   - getTurn(apiKey, id, options)                       -> MappedTurn | null
 *   - searchTurns(apiKey, query, projectId, options)     -> AsyncIterable<MappedTurn>
 *
 * Contracts:
 *   - searchTurns validates `query.length > 500` SYNCHRONOUSLY (throws
 *     before constructing the inner generator). Tests assert
 *     `expect(() => searchTurns(...)).toThrow(DataValidationError)` with
 *     no await.
 *   - options.signal aborted BEFORE SQL throws AbortError. Mid-iteration
 *     aborts also throw via `abortableIterable`.
 */

import { getPool } from "./pool.js";
import { abortableIterable } from "./async-iter.js";
import { mapTurn, escapeIlike, type MappedTurn } from "./mappers.js";
import {
  maskPlaceholderPaths,
  MASKED_PLACEHOLDER_REPLACEMENT,
  placeholderLikePatterns,
} from "./redaction/index.js";
import { DataValidationError } from "./types.js";
import type { ApiKeyInfo, ListOptions, QueryOptions } from "./types.js";

async function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  let onAbort!: () => void;
  const abortP = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([p, abortP]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export interface VerifyIntegrityResult {
  sessionId: string;
  totalTurns: number;
  verifiedTurns: number;
  failedTurns: number;
  verified: boolean;
  results: Array<{
    turnId: string;
    sequenceNum: number;
    reqHashMatch: boolean;
    respHashMatch: boolean;
    reqBytesPresent: boolean;
    respBytesPresent: boolean;
  }>;
}

export async function verifyIntegrity(
  apiKey: ApiKeyInfo,
  sessionId: string,
  options: QueryOptions = {},
): Promise<VerifyIntegrityResult> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const sessionConditions = [`s.id = $1`];
  const sessionParams: unknown[] = [sessionId];
  if (apiKey.projectId) {
    sessionConditions.push(`s.project_id = $2`);
    sessionParams.push(apiKey.projectId);
  }
  const sessionResult = await raceAbort(
    pool.query(
      `SELECT s.id FROM sessions s WHERE ${sessionConditions.join(" AND ")}`,
      sessionParams,
    ),
    options.signal,
  );
  if (sessionResult.rows.length === 0) {
    return {
      sessionId,
      totalTurns: 0,
      verifiedTurns: 0,
      failedTurns: 0,
      verified: false,
      results: [],
    };
  }
  const turnsResult = await raceAbort(
    pool.query(
      `SELECT id, sequence_num, request_hash, response_hash, req_bytes_ref, resp_bytes_ref
       FROM turns WHERE session_id = $1 ORDER BY sequence_num ASC`,
      [sessionId],
    ),
    options.signal,
  );
  const results = turnsResult.rows.map((row: Record<string, unknown>) => {
    const reqHashPresent = row.request_hash !== null && row.request_hash !== "";
    const respHashPresent = row.response_hash !== null && row.response_hash !== "";
    const reqBytesPresent = row.req_bytes_ref !== null && row.req_bytes_ref !== "";
    const respBytesPresent = row.resp_bytes_ref !== null && row.resp_bytes_ref !== "";
    // `sequence_num` is BIGINT in Postgres; pg-node returns BIGINT as
    // a string by default, so coerce explicitly to honour the
    // `sequenceNum: number` declared shape on `VerifyIntegrityResult`.
    return {
      turnId: row.id as string,
      sequenceNum: Number(row.sequence_num),
      reqHashMatch: reqHashPresent && reqBytesPresent,
      respHashMatch: respHashPresent && respBytesPresent,
      reqBytesPresent,
      respBytesPresent,
    };
  });
  const verifiedTurns = results.filter((r) => r.reqHashMatch && r.respHashMatch).length;
  return {
    sessionId,
    totalTurns: results.length,
    verifiedTurns,
    failedTurns: results.length - verifiedTurns,
    verified: false,
    results,
  };
}

export async function getTurn(
  apiKey: ApiKeyInfo,
  id: string,
  options: QueryOptions = {},
): Promise<MappedTurn | null> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const conditions = [`t.id = $1`];
  const params: unknown[] = [id];
  if (apiKey.projectId) {
    conditions.push(`s.project_id = $2`);
    params.push(apiKey.projectId);
  }
  const result = await raceAbort(
    pool.query(
      `SELECT t.* FROM turns t
       JOIN sessions s ON t.session_id = s.id
       WHERE ${conditions.join(" AND ")}`,
      params,
    ),
    options.signal,
  );
  if (result.rows.length === 0) return null;
  return mapTurn(result.rows[0]);
}

export function searchTurns(
  apiKey: ApiKeyInfo,
  query: string,
  requestedProjectId: string | null,
  options: ListOptions = {},
): AsyncIterable<MappedTurn> {
  // Eager validation — sync throw before constructing the generator.
  if (query.length > 500) {
    throw new DataValidationError("Search query too long");
  }
  const inner = (async function* (): AsyncIterable<MappedTurn> {
    if (options.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const pool = getPool();
    const effectiveProjectId = requestedProjectId ?? apiKey.projectId ?? null;
    if (apiKey.projectId && requestedProjectId && apiKey.projectId !== requestedProjectId) {
      return;
    }
    const escapedQuery = escapeIlike(query);
    const projectCondition = effectiveProjectId ? `s.project_id = $1 AND ` : "";
    const baseParams: unknown[] = effectiveProjectId ? [effectiveProjectId] : [];
    const queryParamIdx = effectiveProjectId ? 2 : 1;

    try {
      const result = await raceAbort(
        pool.query(
          `SELECT t.* FROM turns t
           JOIN sessions s ON t.session_id = s.id
           WHERE ${projectCondition}t.search_vector @@ plainto_tsquery('english', $${queryParamIdx})
           ORDER BY t.timestamp DESC, t.id ASC
           LIMIT 100`,
          [...baseParams, query],
        ),
        options.signal,
      );
      if (result.rows.length > 0) {
        for (const row of postFilterByMaskedQuery(result.rows, query, 100)) {
          yield mapTurn(row);
        }
        return;
      }
      const queryMatchesMaskedForm =
        MASKED_PLACEHOLDER_REPLACEMENT.toLowerCase().includes(query.toLowerCase()) &&
        query.length > 0;
      const placeholderClauses: string[] = [];
      const placeholderParams: string[] = [];
      if (queryMatchesMaskedForm) {
        const cols = ["t.response_text", "t.user_request_text"];
        for (const col of cols) {
          for (const pat of placeholderLikePatterns) {
            placeholderClauses.push(
              `${col} ILIKE $${queryParamIdx + 1 + placeholderParams.length} ESCAPE '\\'`,
            );
            placeholderParams.push(pat);
          }
        }
      }
      const placeholderOrFragment =
        placeholderClauses.length > 0 ? ` OR ${placeholderClauses.join(" OR ")}` : "";
      const rows = await fetchAndPostFilterTurns(
        async (offset, batchLimit) =>
          raceAbort(
            pool.query(
              `SELECT t.* FROM turns t
               JOIN sessions s ON t.session_id = s.id
               WHERE ${projectCondition}(t.response_text ILIKE '%' || $${queryParamIdx} || '%' ESCAPE '\\'
                      OR t.user_request_text ILIKE '%' || $${queryParamIdx} || '%' ESCAPE '\\'
                      OR t.model ILIKE '%' || $${queryParamIdx} || '%' ESCAPE '\\'
                      OR t.provider ILIKE '%' || $${queryParamIdx} || '%' ESCAPE '\\'${placeholderOrFragment})
               ORDER BY t.timestamp DESC, t.id ASC
               LIMIT $${queryParamIdx + 1 + placeholderParams.length}
               OFFSET $${queryParamIdx + 2 + placeholderParams.length}`,
              [...baseParams, escapedQuery, ...placeholderParams, batchLimit, offset],
            ),
            options.signal,
          ),
        query,
        100,
      );
      for (const row of rows) yield mapTurn(row);
    } catch (err) {
      // Re-raise abort & validation errors; swallow only DB-shape errors
      // (matches the original try/catch around tsvector unavailability).
      if (err instanceof DataValidationError) throw err;
      if ((err as Error)?.name === "AbortError") throw err;
      const queryMatchesMaskedForm =
        MASKED_PLACEHOLDER_REPLACEMENT.toLowerCase().includes(query.toLowerCase()) &&
        query.length > 0;
      const placeholderClauses: string[] = [];
      const placeholderParams: string[] = [];
      if (queryMatchesMaskedForm) {
        for (const pat of placeholderLikePatterns) {
          placeholderClauses.push(
            `t.response_text ILIKE $${queryParamIdx + 1 + placeholderParams.length} ESCAPE '\\'`,
          );
          placeholderParams.push(pat);
        }
      }
      const placeholderOrFragment =
        placeholderClauses.length > 0 ? ` OR ${placeholderClauses.join(" OR ")}` : "";
      const rows = await fetchAndPostFilterTurns(
        async (offset, batchLimit) =>
          raceAbort(
            pool.query(
              `SELECT t.* FROM turns t
               JOIN sessions s ON t.session_id = s.id
               WHERE ${projectCondition}(t.response_text ILIKE '%' || $${queryParamIdx} || '%' ESCAPE '\\'
                      OR t.model ILIKE '%' || $${queryParamIdx} || '%' ESCAPE '\\'
                      OR t.provider ILIKE '%' || $${queryParamIdx} || '%' ESCAPE '\\'${placeholderOrFragment})
               ORDER BY t.timestamp DESC, t.id ASC
               LIMIT $${queryParamIdx + 1 + placeholderParams.length}
               OFFSET $${queryParamIdx + 2 + placeholderParams.length}`,
              [...baseParams, escapedQuery, ...placeholderParams, batchLimit, offset],
            ),
            options.signal,
          ),
        query,
        100,
      );
      for (const row of rows) yield mapTurn(row);
    }
  })();
  return abortableIterable(inner, options.signal);
}

async function fetchAndPostFilterTurns(
  fetchBatch: (
    offset: number,
    batchLimit: number,
  ) => Promise<{ rows: Array<Record<string, unknown>> }>,
  query: string,
  desired: number,
): Promise<Array<Record<string, unknown>>> {
  const BATCH = 200;
  const MAX_CANDIDATE_SCAN = 2000;
  const accumulated: Array<Record<string, unknown>> = [];
  let offset = 0;
  let totalCandidates = 0;
  let totalDropped = 0;
  let sourceExhausted = false;
  while (accumulated.length < desired && totalCandidates < MAX_CANDIDATE_SCAN) {
    const result = await fetchBatch(offset, BATCH);
    const batchRows = result.rows;
    if (batchRows.length === 0) {
      sourceExhausted = true;
      break;
    }
    totalCandidates += batchRows.length;
    const matched = postFilterByMaskedQuery(batchRows, query, desired - accumulated.length);
    totalDropped += batchRows.length - matched.length;
    for (const r of matched) {
      if (accumulated.length < desired) accumulated.push(r);
    }
    if (batchRows.length < BATCH) {
      sourceExhausted = true;
      break;
    }
    offset += BATCH;
  }
  if (totalCandidates > 0 && totalDropped > 0 && totalDropped * 2 > totalCandidates) {
    // eslint-disable-next-line no-console
    console.warn(
      `[search] post-filter dropped ${totalDropped}/${totalCandidates} candidates for query; ` +
        `accumulated=${accumulated.length}, desired=${desired}`,
    );
  }
  if (
    !sourceExhausted &&
    accumulated.length < desired &&
    totalCandidates >= MAX_CANDIDATE_SCAN
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      `[search] candidate-scan cap exhausted: scanned ${totalCandidates} rows, ` +
        `accumulated=${accumulated.length}/${desired}. Search results truncated. ` +
        `Consider tightening the query, or raise MAX_CANDIDATE_SCAN if this is consistently expected.`,
    );
  }
  return accumulated;
}

function postFilterByMaskedQuery(
  rows: Array<Record<string, unknown>>,
  query: string,
  limit: number,
): Array<Record<string, unknown>> {
  const needle = query.toLowerCase();
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    const maskedReq = maskPlaceholderPaths(row.user_request_text as string | null) ?? "";
    const maskedResp = maskPlaceholderPaths(row.response_text as string | null) ?? "";
    const model = ((row.model as string | null) ?? "").toLowerCase();
    const provider = ((row.provider as string | null) ?? "").toLowerCase();
    const matched =
      maskedReq.toLowerCase().includes(needle) ||
      maskedResp.toLowerCase().includes(needle) ||
      model.includes(needle) ||
      provider.includes(needle);
    if (matched) out.push(row);
  }
  return out;
}
