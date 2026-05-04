/**
 * Session resolvers -- extracted from resolvers.ts as part of D0.5.
 *
 * Contains Query.sessions, Query.session, and Session.turns nested resolver.
 *
 * B1 fix: Uses generated QueryResolvers and SessionResolvers types from codegen.
 * D1.2: Enhanced with new session fields (framework, status, duration, identity, git, cache tokens).
 * D1.4: Enhanced SessionFilter with status, framework, and search filters.
 * D1.5: sessions query returns SessionConnection instead of [Session!]!
 */

import { GraphQLError } from "graphql";
import { getPool } from "../db.js";
import type { QueryResolvers, SessionResolvers, UserTurnResolvers } from "../generated/graphql.js";
import { mapSession, escapeIlike } from "./mappers.js";
import {
  looksLikePathProbe,
  maskPlaceholderPaths,
  MASKED_PLACEHOLDER_REPLACEMENT,
  placeholderLikePatterns,
} from "../placeholder-mask.js";

const sessionsResolver: NonNullable<QueryResolvers["sessions"]> = async (
  _parent,
  args,
  ctx
) => {
  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  // Project scoping
  if (ctx.apiKey.projectId) {
    conditions.push(`s.project_id = $${idx++}`);
    params.push(ctx.apiKey.projectId);
  }

  // Filters
  if (args.filter?.provider) {
    conditions.push(`s.provider = $${idx++}`);
    params.push(args.filter.provider);
  }
  if (args.filter?.model) {
    conditions.push(`s.model = $${idx++}`);
    params.push(args.filter.model);
  }
  if (args.filter?.projectId) {
    conditions.push(`s.project_id = $${idx++}`);
    params.push(args.filter.projectId);
  }
  if (args.filter?.startedAfter) {
    conditions.push(`s.started_at::timestamptz >= $${idx++}::timestamptz`);
    params.push(args.filter.startedAfter);
  }
  if (args.filter?.startedBefore) {
    conditions.push(`s.started_at::timestamptz <= $${idx++}::timestamptz`);
    params.push(args.filter.startedBefore);
  }

  // D1.4: status filter — derives from ended_at column
  if (args.filter?.status) {
    if (args.filter.status === "ACTIVE") {
      conditions.push(`s.ended_at IS NULL`);
    } else if (args.filter.status === "COMPLETED") {
      conditions.push(`s.ended_at IS NOT NULL`);
    } else {
      // Invalid status: return empty results (no match possible)
      conditions.push(`FALSE`);
    }
  }

  // D1.4: framework filter
  if (args.filter?.framework) {
    conditions.push(`s.framework = $${idx++}`);
    params.push(args.filter.framework);
  }

  // Hide non-LLM traffic captured by the TLS MITM (telemetry pings, OAuth
  // refreshes, update checks). A session is non-LLM when no LLM API call
  // was successfully observed: framework unset, model unset, AND zero
  // tokens recorded. Defaults to true; pass `hideNonLlm: false` for
  // governance/discovery views that want to see ALL captured traffic.
  if (args.filter?.hideNonLlm !== false) {
    conditions.push(
      `NOT (
         (s.framework IS NULL OR s.framework = '')
         AND (s.model IS NULL OR s.model = '')
         AND COALESCE(s.total_tokens, 0) = 0
       )`
    );
  }

  // D1.4: search filter — searches across initial_intent, model, framework
  // W2 fix: Validate search length to prevent excessively long ILIKE patterns
  if (args.filter?.search && args.filter.search.length > 500) {
    throw new GraphQLError("Search query too long", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  if (args.filter?.search) {
    const rawSearch = args.filter.search;
    const escapedSearch = escapeIlike(rawSearch);
    // FIND-3-TS-5 + FIND-4-H + FIND-4-I path-probe defence on the
    // sessions list. The prior fix used
    // `regexp_replace(s.initial_intent, '\\[(Image|...)...[^\\]]*\\]', ...)`
    // which:
    //   - breaks on `]`-in-path (FIND-4-H), and
    //   - hard-codes the prefix list (FIND-4-I).
    //
    // For sessions list (paginated with total count) we use the
    // path-probe REJECTION approach the finding lists as option (b):
    //   1. Detect when the search query looks like a filesystem path
    //      probe via `looksLikePathProbe` (defined in
    //      `placeholder-mask.ts` and parametrised on the shared JSON
    //      indirectly via the prefix consumption).
    //   2. When it is, exclude sessions whose `initial_intent` carries
    //      ANY placeholder shape (the LIKE patterns come from the
    //      shared JSON via `placeholderLikePatterns()` so adding a
    //      prefix updates the SQL automatically).
    //   3. Otherwise, run the user's query against the raw column —
    //      the response-boundary masking (`mapSession`) sanitises the
    //      view so paths never render even on legitimate matches.
    //
    // This kills the path-probe side-channel without a fragile SQL
    // regex.
    const probe = looksLikePathProbe(rawSearch);
    // FIND-6-H: when the search query is a substring of the masked
    // replacement (`[attachment]`), the user is searching for the
    // rendered form. Sessions whose `initial_intent` carried a
    // placeholder will NEVER match raw-ILIKE (raw text never
    // contains `[attachment]`). Expand the candidate set: OR-in a
    // clause that matches when `initial_intent` contains any
    // placeholder shape. Ordinary non-masked queries are
    // unaffected (queryMatchesMaskedForm is false → no extra
    // clauses). Path-probe and masked-form are mutually exclusive
    // (`[attachment]` contains no `/` segments), so the probe
    // rejection and masked expansion don't fight each other.
    const queryMatchesMaskedForm =
      MASKED_PLACEHOLDER_REPLACEMENT.toLowerCase().includes(
        rawSearch.toLowerCase(),
      ) && rawSearch.length > 0;

    let exclusion = "";
    if (probe) {
      const patterns = placeholderLikePatterns();
      const clauses: string[] = [];
      for (const pat of patterns) {
        // FIND-6-I: ESCAPE '\\' for defence-in-depth — `%`/`_`/`\`
        // in prefixes are rejected at shared-JSON load time, but
        // explicit ESCAPE is cheap insurance.
        clauses.push(
          `s.initial_intent NOT ILIKE $${idx + 1 + clauses.length} ESCAPE '\\'`,
        );
        void pat;
      }
      exclusion = ` AND (${clauses.join(" AND ")})`;
    }

    let expansion = "";
    if (queryMatchesMaskedForm) {
      const probeParamCount = probe ? placeholderLikePatterns().length : 0;
      const patterns = placeholderLikePatterns();
      const clauses: string[] = [];
      for (const pat of patterns) {
        clauses.push(
          // FIND-6-I: ESCAPE '\\' for defence-in-depth.
          `s.initial_intent ILIKE $${idx + 1 + probeParamCount + clauses.length} ESCAPE '\\'`,
        );
        void pat;
      }
      expansion = ` OR (${clauses.join(" OR ")})`;
    }

    conditions.push(
      `((s.initial_intent ILIKE '%' || $${idx} || '%' ESCAPE '\\' ` +
      `OR s.model ILIKE '%' || $${idx} || '%' ESCAPE '\\' ` +
      `OR s.framework ILIKE '%' || $${idx} || '%' ESCAPE '\\')${exclusion}${expansion})`
    );
    params.push(escapedSearch);
    idx++;
    if (probe) {
      for (const pat of placeholderLikePatterns()) {
        params.push(pat);
        idx++;
      }
    }
    if (queryMatchesMaskedForm) {
      for (const pat of placeholderLikePatterns()) {
        params.push(pat);
        idx++;
      }
    }
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // W5: Cap limit to max 1000, offset to max 100000, validate non-negative
  let limit = args.limit ?? 100;
  let offset = args.offset ?? 0;
  if (limit < 0) limit = 0;
  if (limit > 1000) limit = 1000;
  if (offset < 0) offset = 0;
  if (offset > 100000) offset = 100000;

  // D1.5: Run both the data query and the count query
  // Clone params for the count query (before adding limit/offset)
  const countParams = [...params];

  params.push(limit);
  const limitIdx = idx++;
  params.push(offset);
  const offsetIdx = idx++;

  const [result, countResult] = await Promise.all([
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
       ${where}
       ORDER BY s.started_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    ),
    pool.query(
      // W3 fix: Use bigint instead of int to avoid overflow at 2.1B rows.
      // Number() is safe up to 2^53 (~9 quadrillion).
      `SELECT COUNT(*)::bigint AS total FROM sessions s ${where}`,
      countParams
    ),
  ]);

  const sessions = result.rows.map((row) => mapSession({
    ...row,
    model: row.resolved_model ?? row.model,
    initial_intent: row.resolved_initial_intent ?? row.initial_intent,
  }));
  const total = Number(countResult.rows[0]?.total ?? 0);

  // D1.2: Aggregate cache tokens for each session from turns
  if (sessions.length > 0) {
    const sessionIds = sessions.map(s => s.id);
    const cacheResult = await pool.query(
      `SELECT session_id,
              COALESCE(SUM(cache_read_tokens), 0)::int AS cache_read_tokens,
              COALESCE(SUM(cache_creation_tokens), 0)::int AS cache_creation_tokens
       FROM turns
       WHERE session_id = ANY($1)
       GROUP BY session_id`,
      [sessionIds]
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

  // D1.5: Return SessionConnection shape
  return {
    items: sessions,
    total,
    limit,
    offset,
  };
};

const sessionResolver: NonNullable<QueryResolvers["session"]> = async (
  _parent,
  args,
  ctx
) => {
  const pool = getPool();
  const conditions = [`s.id = $1`];
  const params: unknown[] = [args.id];

  if (ctx.apiKey.projectId) {
    conditions.push(`s.project_id = $2`);
    params.push(ctx.apiKey.projectId);
  }

  const result = await pool.query(
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
    params
  );

  if (result.rows.length === 0) return null;

  const session = mapSession({
    ...result.rows[0],
    model: result.rows[0].resolved_model ?? result.rows[0].model,
    initial_intent: result.rows[0].resolved_initial_intent ?? result.rows[0].initial_intent,
  });

  // W6: Separate aggregation query for single-session path. For list queries,
  // batch aggregation via ANY($1) is used instead. This is acceptable because
  // the single-session resolver only fires once per request.
  const cacheResult = await pool.query(
    `SELECT COALESCE(SUM(cache_read_tokens), 0)::int AS cache_read_tokens,
            COALESCE(SUM(cache_creation_tokens), 0)::int AS cache_creation_tokens
     FROM turns
     WHERE session_id = $1`,
    [session.id]
  );

  if (cacheResult.rows.length > 0) {
    session.cacheReadTokens = (cacheResult.rows[0].cache_read_tokens as number) ?? 0;
    session.cacheCreationTokens = (cacheResult.rows[0].cache_creation_tokens as number) ?? 0;
  }

  return session;
};

// W7: Add _args and ctx parameters to nested resolvers for defense-in-depth
// D0.4: DataLoader replaces N+1 queries
const turnsResolver: NonNullable<SessionResolvers["turns"]> = async (
  parent,
  _args,
  ctx
) => {
  return ctx.loaders.turnsBySessionId.load(parent.id);
};

// Session.title: derived from the first haiku title-generation turn per
// session. Batched via the titleBySessionId loader so a sessions list with
// N rows costs a single extra query.
const titleResolver: NonNullable<SessionResolvers["title"]> = async (
  parent,
  _args,
  ctx
) => {
  return ctx.loaders.titleBySessionId.load(parent.id);
};

// Session.userTurns: collapses contiguous same-user_request_text wire turns
// into one row per logical user prompt. Keeps per-turn children available
// via UserTurn.turns (see userTurnResolvers below) for drill-down.
//
// One query per session; the inner CTE is scoped to this session and does
// not require batching across sessions. The sessions list UI typically does
// not ask for userTurns, so the per-request cost is paid only on detail views.
const userTurnsResolver: NonNullable<SessionResolvers["userTurns"]> = async (
  parent,
  _args,
  _ctx
) => {
  const pool = getPool();
  const result = await pool.query(
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
    [parent.id]
  );

  return result.rows.map((row) => {
    const httpStatus = row.worst_http_status != null ? Number(row.worst_http_status) : null;
    const allComplete = Boolean(row.all_complete);
    let status: string;
    if (httpStatus !== null && httpStatus >= 400) status = "error";
    else if (allComplete) status = "complete";
    else status = "incomplete";

    const startTs = row.start_ts as Date;
    const endTs = row.end_ts as Date;
    const durationMsRaw = row.duration_ms;
    const durationMs = durationMsRaw != null
      ? Math.max(0, Math.round(Number(durationMsRaw)))
      : 0;

    return {
      id: `${row.session_id}:${row.group_idx}`,
      sessionId: row.session_id as string,
      groupIdx: Number(row.group_idx),
      startTimestamp: startTs.toISOString(),
      endTimestamp: endTs.toISOString(),
      durationMs,
      // FIND-1-M: mask attachment-sibling placeholders before render.
      userRequestText: maskPlaceholderPaths(row.user_request_text as string | null),
      primaryModel:
        (row.primary_model as string | null) ??
        (row.session_model as string | null) ??
        null,
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
      // Carried to the UserTurn.turns child resolver. Not part of the public
      // GraphQL schema; the codegen resolver parent type reads this off the
      // value via the { turns: ... } override.
      turnIds: (row.turn_ids as string[]) ?? [],
    };
  });
};

// UserTurn.turns: hydrate the wire-level sub-calls. Reuses the session-turns
// DataLoader so a session detail request loads every turn once and filters
// per-group, rather than issuing N queries.
const userTurnChildrenResolver: NonNullable<UserTurnResolvers["turns"]> = async (
  parent,
  _args,
  ctx
) => {
  const allTurns = await ctx.loaders.turnsBySessionId.load(parent.sessionId);
  const wanted = new Set(parent.turnIds);
  return allTurns.filter((t) => wanted.has(t.id));
};

export const sessionResolvers = {
  Query: {
    sessions: sessionsResolver,
    session: sessionResolver,
  },
  Session: {
    turns: turnsResolver,
    title: titleResolver,
    userTurns: userTurnsResolver,
  },
  UserTurn: {
    turns: userTurnChildrenResolver,
  },
};
