/**
 * Session list / detail / nested userTurn primitives.
 *
 * Hoisted from `api/src/resolvers/sessions.ts` as part of the
 * resolver -> @recondo/data move. The SQL bodies are preserved
 * byte-for-byte; the only transport-shaped concern (GraphQL Connection
 * shape) stays in the api/ resolver.
 *
 * Public surface:
 *   - listSessions(apiKey, filter, options) -> ListEnvelope<MappedSession>
 *   - getSession(apiKey, id, options)       -> MappedSession | null
 *   - listUserTurns(sessionId, options)     -> MappedUserTurn[]
 *
 * Contracts:
 *   - filter.search > 500 chars throws DataValidationError (NOT GraphQLError).
 *   - options.signal aborted BEFORE the SQL is issued throws AbortError.
 *   - options.signal abort mid-flight wins via Promise.race.
 *   - listUserTurns returns a plain array (NOT a list envelope) — this
 *     is a child-collection accessor, not a paginated list.
 */

import { getPool } from "./pool.js";
import { mapSession, escapeIlike, type MappedSession, type MappedUserTurn } from "./mappers.js";
import {
  looksLikePathProbe,
  maskPlaceholderPaths,
  MASKED_PLACEHOLDER_REPLACEMENT,
  placeholderLikePatterns,
} from "./redaction/index.js";
import { uniformListEnvelope } from "./envelope.js";
import { DataValidationError } from "./types.js";
import type { ApiKeyInfo, ListEnvelope, ListOptions, QueryOptions } from "./types.js";

export interface SessionFilter {
  provider?: string;
  model?: string;
  projectId?: string;
  startedAfter?: string;
  startedBefore?: string;
  status?: "ACTIVE" | "COMPLETED";
  framework?: string;
  hideNonLlm?: boolean;
  search?: string;
}

export type SessionListItem = MappedSession;

/**
 * Race a promise against an AbortSignal. If the signal is already aborted,
 * throws synchronously via the early check at call sites. If it fires
 * mid-flight, the returned promise rejects with AbortError. Mirrors the
 * pattern in auth.ts (try/finally + removeEventListener).
 */
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

export async function listSessions(
  apiKey: ApiKeyInfo,
  filter: SessionFilter = {},
  options: ListOptions = {},
): Promise<ListEnvelope<SessionListItem> & { total?: number }> {
  // Validate before any SQL.
  if (filter.search && filter.search.length > 500) {
    throw new DataValidationError("Search query too long");
  }
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
  if (filter.provider) {
    conditions.push(`s.provider = $${idx++}`);
    params.push(filter.provider);
  }
  if (filter.model) {
    conditions.push(`s.model = $${idx++}`);
    params.push(filter.model);
  }
  if (filter.projectId) {
    conditions.push(`s.project_id = $${idx++}`);
    params.push(filter.projectId);
  }
  if (filter.startedAfter) {
    conditions.push(`s.started_at::timestamptz >= $${idx++}::timestamptz`);
    params.push(filter.startedAfter);
  }
  if (filter.startedBefore) {
    conditions.push(`s.started_at::timestamptz <= $${idx++}::timestamptz`);
    params.push(filter.startedBefore);
  }
  if (filter.status) {
    if (filter.status === "ACTIVE") conditions.push(`s.ended_at IS NULL`);
    else if (filter.status === "COMPLETED") conditions.push(`s.ended_at IS NOT NULL`);
    else conditions.push(`FALSE`);
  }
  if (filter.framework) {
    conditions.push(`s.framework = $${idx++}`);
    params.push(filter.framework);
  }
  if (filter.hideNonLlm !== false) {
    conditions.push(
      `NOT (
         (s.framework IS NULL OR s.framework = '')
         AND (s.model IS NULL OR s.model = '')
         AND COALESCE(s.total_tokens, 0) = 0
       )`,
    );
  }
  if (filter.search) {
    const rawSearch = filter.search;
    const escapedSearch = escapeIlike(rawSearch);
    const probe = looksLikePathProbe(rawSearch);
    const queryMatchesMaskedForm =
      MASKED_PLACEHOLDER_REPLACEMENT.toLowerCase().includes(rawSearch.toLowerCase()) &&
      rawSearch.length > 0;

    let exclusion = "";
    if (probe) {
      const clauses: string[] = [];
      for (const pat of placeholderLikePatterns) {
        clauses.push(`s.initial_intent NOT ILIKE $${idx + 1 + clauses.length} ESCAPE '\\'`);
        void pat;
      }
      exclusion = ` AND (${clauses.join(" AND ")})`;
    }
    let expansion = "";
    if (queryMatchesMaskedForm) {
      const probeParamCount = probe ? placeholderLikePatterns.length : 0;
      const clauses: string[] = [];
      for (const pat of placeholderLikePatterns) {
        clauses.push(
          `s.initial_intent ILIKE $${idx + 1 + probeParamCount + clauses.length} ESCAPE '\\'`,
        );
        void pat;
      }
      expansion = ` OR (${clauses.join(" OR ")})`;
    }
    conditions.push(
      `((s.initial_intent ILIKE '%' || $${idx} || '%' ESCAPE '\\' ` +
        `OR s.model ILIKE '%' || $${idx} || '%' ESCAPE '\\' ` +
        `OR s.framework ILIKE '%' || $${idx} || '%' ESCAPE '\\')${exclusion}${expansion})`,
    );
    params.push(escapedSearch);
    idx++;
    if (probe) {
      for (const pat of placeholderLikePatterns) {
        params.push(pat);
        idx++;
      }
    }
    if (queryMatchesMaskedForm) {
      for (const pat of placeholderLikePatterns) {
        params.push(pat);
        idx++;
      }
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  let limit = options.limit ?? 100;
  let offset = options.offset ?? 0;
  if (limit < 0) limit = 0;
  if (limit > 1000) limit = 1000;
  if (offset < 0) offset = 0;
  if (offset > 100000) offset = 100000;

  const countParams = [...params];
  params.push(limit);
  const limitIdx = idx++;
  params.push(offset);
  const offsetIdx = idx++;

  const dataPromise = pool.query(
    `SELECT
       s.*,
       COALESCE(NULLIF(s.model, ''), latest_turn.latest_model) AS resolved_model,
       COALESCE(
         NULLIF(s.initial_intent, ''),
         first_real_turn.first_user_request_text,
         latest_turn.latest_user_request_text,
         CASE WHEN parse_info.has_parse_errors THEN '[unparsed request]' ELSE NULL END
       ) AS resolved_initial_intent
     FROM sessions s
     LEFT JOIN LATERAL (
       SELECT
         NULLIF(t.model, '') AS latest_model,
         NULLIF(t.user_request_text, '') AS latest_user_request_text
       FROM turns t
       WHERE t.session_id = s.id
         AND (
           (t.model IS NOT NULL AND t.model <> '')
           OR (t.user_request_text IS NOT NULL AND t.user_request_text <> '')
         )
       ORDER BY t.sequence_num DESC, t.timestamp DESC
       LIMIT 1
     ) latest_turn ON TRUE
     LEFT JOIN LATERAL (
       SELECT NULLIF(t.user_request_text, '') AS first_user_request_text
       FROM turns t
       WHERE t.session_id = s.id
         AND COALESCE(t.input_tokens, 0) + COALESCE(t.output_tokens, 0) > 0
         AND t.user_request_text IS NOT NULL AND t.user_request_text <> ''
       ORDER BY t.sequence_num ASC, t.timestamp ASC
       LIMIT 1
     ) first_real_turn ON TRUE
     LEFT JOIN LATERAL (
       SELECT BOOL_OR(t.parse_errors IS NOT NULL AND t.parse_errors <> '') AS has_parse_errors
       FROM turns t
       WHERE t.session_id = s.id
     ) parse_info ON TRUE
     ${where}
     ORDER BY s.started_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  const countPromise = pool.query(
    `SELECT COUNT(*)::bigint AS total FROM sessions s ${where}`,
    countParams,
  );

  const [result, countResult] = await raceAbort(
    Promise.all([dataPromise, countPromise]),
    options.signal,
  );

  const sessions = result.rows.map((row: Record<string, unknown>) =>
    mapSession({
      ...row,
      model: row.resolved_model ?? row.model,
      initial_intent: row.resolved_initial_intent ?? row.initial_intent,
    }),
  );
  const total = Number(countResult.rows[0]?.total ?? 0);

  if (sessions.length > 0) {
    const sessionIds = sessions.map((s) => s.id);
    const cacheResult = await raceAbort(
      pool.query(
        `SELECT session_id,
                COALESCE(SUM(cache_read_tokens), 0)::int AS cache_read_tokens,
                COALESCE(SUM(cache_creation_tokens), 0)::int AS cache_creation_tokens
         FROM turns
         WHERE session_id = ANY($1)
         GROUP BY session_id`,
        [sessionIds],
      ),
      options.signal,
    );
    const cacheMap = new Map<string, { cacheReadTokens: number; cacheCreationTokens: number }>();
    for (const row of cacheResult.rows) {
      cacheMap.set(row.session_id as string, {
        cacheReadTokens: (row.cache_read_tokens as number) ?? 0,
        cacheCreationTokens: (row.cache_creation_tokens as number) ?? 0,
      });
    }
    for (const session of sessions) {
      const cache = cacheMap.get(session.id);
      if (cache) {
        session.cacheReadTokens = cache.cacheReadTokens;
        session.cacheCreationTokens = cache.cacheCreationTokens;
      }
    }
  }

  const truncated = offset + sessions.length < total;
  const nextOffset = truncated ? offset + sessions.length : null;
  return {
    ...uniformListEnvelope(sessions, { nextOffset, truncated }),
    total,
  };
}

export async function getSession(
  apiKey: ApiKeyInfo,
  id: string,
  options: QueryOptions = {},
): Promise<SessionListItem | null> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const conditions = [`s.id = $1`];
  const params: unknown[] = [id];
  if (apiKey.projectId) {
    conditions.push(`s.project_id = $2`);
    params.push(apiKey.projectId);
  }
  const result = await raceAbort(
    pool.query(
      `SELECT
         s.*,
         COALESCE(NULLIF(s.model, ''), latest_turn.latest_model) AS resolved_model,
         COALESCE(
           NULLIF(s.initial_intent, ''),
           first_real_turn.first_user_request_text,
           latest_turn.latest_user_request_text,
           CASE WHEN parse_info.has_parse_errors THEN '[unparsed request]' ELSE NULL END
         ) AS resolved_initial_intent
       FROM sessions s
       LEFT JOIN LATERAL (
         SELECT
           NULLIF(t.model, '') AS latest_model,
           NULLIF(t.user_request_text, '') AS latest_user_request_text
         FROM turns t
         WHERE t.session_id = s.id
           AND (
             (t.model IS NOT NULL AND t.model <> '')
             OR (t.user_request_text IS NOT NULL AND t.user_request_text <> '')
           )
         ORDER BY t.sequence_num DESC, t.timestamp DESC
         LIMIT 1
       ) latest_turn ON TRUE
       LEFT JOIN LATERAL (
         SELECT NULLIF(t.user_request_text, '') AS first_user_request_text
         FROM turns t
         WHERE t.session_id = s.id
           AND COALESCE(t.input_tokens, 0) + COALESCE(t.output_tokens, 0) > 0
           AND t.user_request_text IS NOT NULL AND t.user_request_text <> ''
         ORDER BY t.sequence_num ASC, t.timestamp ASC
         LIMIT 1
       ) first_real_turn ON TRUE
       LEFT JOIN LATERAL (
         SELECT BOOL_OR(t.parse_errors IS NOT NULL AND t.parse_errors <> '') AS has_parse_errors
         FROM turns t
         WHERE t.session_id = s.id
       ) parse_info ON TRUE
       WHERE ${conditions.join(" AND ")}`,
      params,
    ),
    options.signal,
  );
  if (result.rows.length === 0) return null;
  const session = mapSession({
    ...result.rows[0],
    model: result.rows[0].resolved_model ?? result.rows[0].model,
    initial_intent: result.rows[0].resolved_initial_intent ?? result.rows[0].initial_intent,
  });
  const cacheResult = await raceAbort(
    pool.query(
      `SELECT COALESCE(SUM(cache_read_tokens), 0)::int AS cache_read_tokens,
              COALESCE(SUM(cache_creation_tokens), 0)::int AS cache_creation_tokens
       FROM turns
       WHERE session_id = $1`,
      [session.id],
    ),
    options.signal,
  );
  if (cacheResult.rows.length > 0) {
    session.cacheReadTokens = (cacheResult.rows[0].cache_read_tokens as number) ?? 0;
    session.cacheCreationTokens = (cacheResult.rows[0].cache_creation_tokens as number) ?? 0;
  }
  return session;
}

export async function listUserTurns(
  sessionId: string,
  options: QueryOptions = {},
): Promise<MappedUserTurn[]> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const result = await raceAbort(
    pool.query(
      `WITH candidate AS (
         SELECT t.id, t.session_id, t.sequence_num, t.timestamp, t.provider,
                t.model, t.user_request_text, t.input_tokens, t.output_tokens,
                t.cost_usd, t.cache_read_tokens, t.cache_creation_tokens,
                t.http_status, t.capture_complete, t.tool_call_count,
                s.framework, s.model AS session_model
         FROM turns t
         JOIN sessions s ON t.session_id = s.id
         WHERE t.session_id = $1
       ),
       lagged AS (
         SELECT c.*,
           LAG(user_request_text) OVER (PARTITION BY session_id ORDER BY sequence_num, timestamp) AS prev_user_request_text
         FROM candidate c
       ),
       labeled AS (
         SELECT l.*,
           SUM(CASE
             WHEN prev_user_request_text IS DISTINCT FROM user_request_text
             THEN 1 ELSE 0
           END) OVER (PARTITION BY session_id ORDER BY sequence_num, timestamp) AS group_idx
         FROM lagged l
       )
       SELECT
         session_id,
         group_idx,
         MIN(timestamp::timestamptz) AS start_ts,
         MAX(timestamp::timestamptz) AS end_ts,
         EXTRACT(EPOCH FROM (MAX(timestamp::timestamptz) - MIN(timestamp::timestamptz))) * 1000 AS duration_ms,
         MIN(user_request_text) AS user_request_text,
         MIN(provider) AS provider,
         MIN(framework) AS framework,
         MIN(session_model) AS session_model,
         COALESCE(
           MAX(model) FILTER (WHERE model IS NOT NULL AND model <> '' AND LOWER(model) NOT LIKE '%haiku%'),
           MAX(model) FILTER (WHERE model IS NOT NULL AND model <> '')
         ) AS primary_model,
         SUM(COALESCE(input_tokens, 0))::bigint AS input_tokens,
         SUM(COALESCE(output_tokens, 0))::bigint AS output_tokens,
         SUM(COALESCE(cache_read_tokens, 0))::bigint AS cache_read_tokens,
         SUM(COALESCE(cache_creation_tokens, 0))::bigint AS cache_creation_tokens,
         SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0))::bigint AS total_tokens,
         SUM(COALESCE(cost_usd, 0))::float AS cost_usd,
         SUM(COALESCE(tool_call_count, 0))::int AS tool_call_count,
         COUNT(*)::int AS sub_call_count,
         MAX(http_status) AS worst_http_status,
         BOOL_AND(capture_complete) AS all_complete,
         BOOL_AND(http_status IS NULL AND capture_complete = false
                  AND (input_tokens + output_tokens) = 0) AS all_preflight,
         ARRAY_AGG(id ORDER BY sequence_num, timestamp) AS turn_ids
       FROM labeled
       GROUP BY session_id, group_idx
       HAVING NOT BOOL_AND(http_status IS NULL AND capture_complete = false
                          AND (input_tokens + output_tokens) = 0)
       ORDER BY group_idx ASC`,
      [sessionId],
    ),
    options.signal,
  );
  return result.rows.map((row: Record<string, unknown>): MappedUserTurn => {
    const httpStatus = row.worst_http_status != null ? Number(row.worst_http_status) : null;
    const allComplete = Boolean(row.all_complete);
    let status: string;
    if (httpStatus !== null && httpStatus >= 400) status = "error";
    else if (allComplete) status = "complete";
    else status = "incomplete";
    const startTs = row.start_ts as Date;
    const endTs = row.end_ts as Date;
    const durationMsRaw = row.duration_ms;
    const durationMs =
      durationMsRaw != null ? Math.max(0, Math.round(Number(durationMsRaw))) : 0;
    return {
      id: `${row.session_id}:${row.group_idx}`,
      sessionId: row.session_id as string,
      groupIdx: Number(row.group_idx),
      startTimestamp: startTs.toISOString(),
      endTimestamp: endTs.toISOString(),
      durationMs,
      userRequestText: maskPlaceholderPaths(row.user_request_text as string | null),
      primaryModel:
        (row.primary_model as string | null) ?? (row.session_model as string | null) ?? null,
      provider: (row.provider as string) ?? "unknown",
      framework: (row.framework as string | null) ?? null,
      totalTokens: Number(row.total_tokens ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      cacheReadTokens: Number(row.cache_read_tokens ?? 0),
      cacheCreationTokens: Number(row.cache_creation_tokens ?? 0),
      costUsd: Number(row.cost_usd ?? 0),
      subCallCount: Number(row.sub_call_count ?? 1),
      toolCallCount: Number(row.tool_call_count ?? 0),
      status,
      turnIds: (row.turn_ids as string[]) ?? [],
    };
  });
}
