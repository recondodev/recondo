/**
 * Turn resolvers -- extracted from resolvers.ts as part of D0.5.
 *
 * Contains Query.turn, Query.search, Query.verifyIntegrity,
 * and Turn.toolCalls nested resolver.
 *
 * B1 fix: Uses generated QueryResolvers and TurnResolvers types from codegen.
 */

import { GraphQLError } from "graphql";
import { getPool } from "../db.js";
import type { QueryResolvers, TurnResolvers } from "../generated/graphql.js";
import { mapTurn, escapeIlike } from "./mappers.js";
import {
  // FIND-7-L: dropped unused `looksLikePathProbe` import. The
  // turns search resolver uses the candidate-set + post-filter
  // approach (FIND-4-H) instead of probe-rejection; the e2e parity
  // test imports its own copy from placeholder-mask.js directly.
  maskPlaceholderPaths,
  MASKED_PLACEHOLDER_REPLACEMENT,
  placeholderLikePatterns,
} from "../placeholder-mask.js";

const turnResolver: NonNullable<QueryResolvers["turn"]> = async (
  _parent,
  args,
  ctx
) => {
  const pool = getPool();

  // Join with sessions to enforce project scoping
  const conditions = [`t.id = $1`];
  const params: unknown[] = [args.id];

  if (ctx.apiKey.projectId) {
    conditions.push(`s.project_id = $2`);
    params.push(ctx.apiKey.projectId);
  }

  const result = await pool.query(
    `SELECT t.* FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE ${conditions.join(" AND ")}`,
    params
  );

  if (result.rows.length === 0) return null;
  return mapTurn(result.rows[0]);
};

// N5: search resolver falls back to LIKE-based search when search_vector is not available
// D1.6: projectId is now optional
const searchResolver: NonNullable<QueryResolvers["search"]> = async (
  _parent,
  args,
  ctx
) => {
  // R2-N1: Validate search input length
  if (args.query.length > 500) {
    throw new GraphQLError("Search query too long", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }

  const pool = getPool();

  // D1.6: Determine the effective project ID. Use args.projectId if provided,
  // otherwise fall back to the API key's project scope.
  const effectiveProjectId = args.projectId ?? ctx.apiKey.projectId ?? null;

  // Enforce project scoping: if the API key is scoped to a project,
  // only allow search within that project
  if (ctx.apiKey.projectId && args.projectId && ctx.apiKey.projectId !== args.projectId) {
    return [];
  }

  // R2-B3: Escape ILIKE wildcards before passing to fallback queries
  const escapedQuery = escapeIlike(args.query);

  // Build project filter condition and params
  const projectCondition = effectiveProjectId ? `s.project_id = $1 AND ` : "";
  const baseParams: unknown[] = effectiveProjectId ? [effectiveProjectId] : [];
  const queryParamIdx = effectiveProjectId ? 2 : 1;

  // Try full-text search first, fall back to ILIKE if search_vector is
  // not populated.
  //
  // FIND-4-M warning to future contributors: as of this commit, the
  // `turns.search_vector` column exists (migration 001) and has a GIN
  // index (migration 003) but NO trigger populates it on INSERT/UPDATE.
  // It is always NULL, so the tsquery predicate below matches nothing
  // and the ILIKE fallback path runs every time. If a future migration
  // adds a populating trigger, that trigger MUST feed
  //   regexp_replace(user_request_text, '\\[(Image|PDF|Document|File|Attachment): source: [^\\]]*\\]', '[attachment]', 'g')
  // (or equivalent — see `placeholder-mask.ts` for the canonical
  // shared list) so the path-probe defence (FIND-3-TS-5) is preserved.
  // Without that wrap, an attacker could probe the tsvector index with
  // a path-shape query and read existence signals.
  //
  // The path-probe defence is currently provided ONLY by the
  // post-filter at the ILIKE branch (which masks each candidate row in
  // TS and re-checks the query). If you populate the vector, also add
  // a post-filter pass to the tsquery branch.
  try {
    // FIND-7-F: stable tie-breaker on `t.id` so paginated fetches
    // never skip or duplicate same-timestamp rows. `t.timestamp` is
    // not unique (multiple turns can share a millisecond), so a
    // LIMIT/OFFSET pair without a deterministic secondary sort
    // returns rows in PG's physical-storage order, which is not
    // stable across queries.
    const result = await pool.query(
      `SELECT t.* FROM turns t
       JOIN sessions s ON t.session_id = s.id
       WHERE ${projectCondition}t.search_vector @@ plainto_tsquery('english', $${queryParamIdx})
       ORDER BY t.timestamp DESC, t.id ASC
       LIMIT 100`,
      [...baseParams, args.query]
    );

    // FIND-4-M: even if some rows came back via the tsvector branch,
    // run the same post-filter we use on the ILIKE branch so any
    // future tsvector population that doesn't pre-mask the source
    // text is still defended at the response boundary. Today this
    // branch never returns rows (vector is NULL), so the post-filter
    // is a no-op; tomorrow it's the difference between a leak and a
    // no-leak.
    if (result.rows.length > 0) {
      return postFilterByMaskedQuery(result.rows, args.query, 100).map(
        mapTurn,
      );
    }

    // Fall back to ILIKE search on response_text, user_request_text, model, provider.
    // R2-B3: Use escaped query to prevent wildcard injection.
    //
    // FIND-3-TS-5 + FIND-4-H + FIND-4-I path-probe defence + masked-search:
    //
    // Two-track candidate fetch:
    //   1. The "ordinary" track: rows whose RAW text columns contain the
    //      user's query substring. Captures legitimate searches like
    //      `debug flaky tests` against unmasked content.
    //   2. The "masked-search" track: when the user types a substring of
    //      the masked replacement (e.g. `[attachment]`), they want to
    //      find rows whose TEXT, AFTER MASKING, contains that
    //      substring. Raw text never contains `[attachment]` because
    //      the gateway stores raw `[Image: source: /path]`. So if the
    //      query overlaps with the masked replacement, also pull rows
    //      whose raw text carries any placeholder shape.
    //
    // The TS post-filter (`postFilterByMaskedQuery`) then runs each
    // candidate row's text fields through `maskPlaceholderPaths` and
    // checks whether the query substring appears in the MASKED form
    // — which guarantees path-probe queries find nothing (the masked
    // form is `[attachment]`, no `/Users/`) while the masked-form
    // query matches.
    const queryMatchesMaskedForm = MASKED_PLACEHOLDER_REPLACEMENT.toLowerCase().includes(
      args.query.toLowerCase(),
    ) && args.query.length > 0;
    const placeholderPatterns = placeholderLikePatterns;
    const placeholderClauses: string[] = [];
    const placeholderParams: string[] = [];
    if (queryMatchesMaskedForm) {
      const cols = ["t.response_text", "t.user_request_text"];
      for (const col of cols) {
        for (const pat of placeholderPatterns) {
          placeholderClauses.push(
            // FIND-6-I: ESCAPE '\\' so a future prefix containing `\`
            // (rejected at load time today, but defensive here too)
            // doesn't flip LIKE escape semantics. `%` / `_` are
            // already rejected at load time.
            `${col} ILIKE $${queryParamIdx + 1 + placeholderParams.length} ESCAPE '\\'`,
          );
          placeholderParams.push(pat);
        }
      }
    }
    const placeholderOrFragment =
      placeholderClauses.length > 0
        ? ` OR ${placeholderClauses.join(" OR ")}`
        : "";

    // FIND-6-G: accumulating batches until post-filter satisfies the
    // 100-row limit, with a hard upper bound on candidate scans so a
    // pathological query can't trigger an unbounded sequential scan.
    const rows = await fetchAndPostFilterTurns(
      pool,
      async (offset, batchLimit) =>
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
      args.query,
      100,
    );
    return rows.map(mapTurn);
  } catch {
    // If search_vector column doesn't exist, use ILIKE fallback (with
    // the same masked-search expansion).
    const queryMatchesMaskedForm = MASKED_PLACEHOLDER_REPLACEMENT.toLowerCase().includes(
      args.query.toLowerCase(),
    ) && args.query.length > 0;
    const placeholderPatterns = placeholderLikePatterns;
    const placeholderClauses: string[] = [];
    const placeholderParams: string[] = [];
    if (queryMatchesMaskedForm) {
      for (const pat of placeholderPatterns) {
        placeholderClauses.push(
          // FIND-6-I: ESCAPE '\\' for defence-in-depth.
          `t.response_text ILIKE $${queryParamIdx + 1 + placeholderParams.length} ESCAPE '\\'`,
        );
        placeholderParams.push(pat);
      }
    }
    const placeholderOrFragment =
      placeholderClauses.length > 0
        ? ` OR ${placeholderClauses.join(" OR ")}`
        : "";
    // FIND-6-G: same batched-accumulation approach on the no-
    // search_vector fallback branch.
    const rows = await fetchAndPostFilterTurns(
      pool,
      async (offset, batchLimit) =>
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
      args.query,
      100,
    );
    return rows.map(mapTurn);
  }
};

/**
 * FIND-6-G + FIND-7-G: Batched candidate-fetch + post-filter loop
 * for the search resolver. Previously the resolver fetched a single
 * 200-row batch and post-filtered to 100, silently truncating when
 * path-probe queries dominated the candidate set (empty results even
 * though later candidates would match).
 *
 * # Search contract
 *
 * The resolver scans up to `MAX_CANDIDATE_SCAN` (2000) candidate
 * rows looking for `desired` (100) matches under the masked-query
 * filter. Behaviour:
 *   - If `desired` matches are found before the 2000 cap, returns
 *     them (saturated case — typical).
 *   - If the source is exhausted before either limit, returns
 *     whatever matched (small-corpus case).
 *   - If the 2000-row cap is hit before `desired` matches accumulate,
 *     returns the partial set AND emits a warn-level log line so
 *     ops can detect "search saturated under cap" — typical when the
 *     query is path-probe-shaped against a corpus with many
 *     placeholder rows. The log line is the operational signal
 *     FIND-7-G required.
 *
 * Two distinct warn signals:
 *   - High-drop-rate: `>50%` of candidates filtered out (FIND-6-G).
 *   - Cap-exhaustion: 2000 candidates scanned without satisfying
 *     `desired` (FIND-7-G).
 */
async function fetchAndPostFilterTurns(
  _pool: import("pg").Pool,
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
  while (
    accumulated.length < desired &&
    totalCandidates < MAX_CANDIDATE_SCAN
  ) {
    const result = await fetchBatch(offset, BATCH);
    const batchRows = result.rows;
    if (batchRows.length === 0) {
      sourceExhausted = true;
      break;
    }
    totalCandidates += batchRows.length;
    const matched = postFilterByMaskedQuery(
      batchRows,
      query,
      desired - accumulated.length,
    );
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
  // FIND-6-G: operational signal when >50% of candidates were
  // dropped — either the query is path-probe-shaped (benign) or
  // there's a mask-mismatch bug (investigate).
  if (
    totalCandidates > 0 &&
    totalDropped > 0 &&
    totalDropped * 2 > totalCandidates
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      `[search] post-filter dropped ${totalDropped}/${totalCandidates} candidates for query; `
        + `accumulated=${accumulated.length}, desired=${desired}`,
    );
  }
  // FIND-7-G: distinct signal for cap-exhaustion. The user's query
  // matched fewer than `desired` rows within the 2000-candidate
  // budget. Either the source is genuinely smaller (sourceExhausted
  // would be true in that case — we don't warn) or the cap kicked
  // in mid-search and we're returning a truncated result. The warn
  // tells operators "search returned partial results because the
  // cap fired" — a strictly stronger signal than the >50%-drop
  // log above.
  if (
    !sourceExhausted &&
    accumulated.length < desired &&
    totalCandidates >= MAX_CANDIDATE_SCAN
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      `[search] candidate-scan cap exhausted: scanned ${totalCandidates} rows, `
        + `accumulated=${accumulated.length}/${desired}. Search results truncated. `
        + `Consider tightening the query, or raise MAX_CANDIDATE_SCAN if this is consistently expected.`,
    );
  }
  return accumulated;
}

/**
 * FIND-4-H: post-filter a candidate row set by re-checking the user's
 * query against the MASKED form of each text field. Used by the search
 * resolver after the broad SQL ILIKE fetch.
 *
 * `query` is the user's RAW search string (case-insensitive, substring
 * match). For each row we:
 *   - mask `response_text`, `user_request_text` via the JS scanner
 *     (`maskPlaceholderPaths` — handles `]`-in-path correctly per
 *     FIND-3-TS-2 / FIND-4-D).
 *   - check whether `query` appears (case-insensitive) in any of:
 *     masked `response_text`, masked `user_request_text`, raw `model`,
 *     raw `provider`. (model/provider are bounded-cardinality and
 *     never carry path placeholders.)
 *   - keep the row if so; drop if the original SQL match was only on
 *     a path-shaped substring of the raw text.
 *
 * Result is capped at `limit` rows.
 */
function postFilterByMaskedQuery(
  rows: Array<Record<string, unknown>>,
  query: string,
  limit: number,
): Array<Record<string, unknown>> {
  const needle = query.toLowerCase();
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    const maskedReq =
      maskPlaceholderPaths(row.user_request_text as string | null) ?? "";
    const maskedResp =
      maskPlaceholderPaths(row.response_text as string | null) ?? "";
    const model = ((row.model as string | null) ?? "").toLowerCase();
    const provider = ((row.provider as string | null) ?? "").toLowerCase();
    const matched =
      maskedReq.toLowerCase().includes(needle) ||
      maskedResp.toLowerCase().includes(needle) ||
      model.includes(needle) ||
      provider.includes(needle);
    if (matched) {
      out.push(row);
    }
  }
  return out;
}

// FIND-7-L: removed `void looksLikePathProbe;` + `void placeholderLikePatterns;`
// silencers. `looksLikePathProbe` is no longer imported (sessions.ts uses
// it; e2e tests import directly from placeholder-mask.js).
// `placeholderLikePatterns` is genuinely used in this file (lines ~156
// and ~207) so no silencer needed.

// B1: verifyIntegrity -- checks field presence honestly, does NOT claim hash match
const verifyIntegrityResolver: NonNullable<QueryResolvers["verifyIntegrity"]> = async (
  _parent,
  args,
  ctx
) => {
  const pool = getPool();

  // Check session access
  const sessionConditions = [`s.id = $1`];
  const sessionParams: unknown[] = [args.sessionId];

  if (ctx.apiKey.projectId) {
    sessionConditions.push(`s.project_id = $2`);
    sessionParams.push(ctx.apiKey.projectId);
  }

  const sessionResult = await pool.query(
    `SELECT s.id FROM sessions s WHERE ${sessionConditions.join(" AND ")}`,
    sessionParams
  );

  if (sessionResult.rows.length === 0) {
    // Return empty report for inaccessible sessions
    return {
      sessionId: args.sessionId,
      totalTurns: 0,
      verifiedTurns: 0,
      failedTurns: 0,
      verified: false,
      results: [],
    };
  }

  // B3: Use correct column names from gateway schema: request_hash, response_hash
  const turnsResult = await pool.query(
    `SELECT id, sequence_num, request_hash, response_hash, req_bytes_ref, resp_bytes_ref
     FROM turns
     WHERE session_id = $1
     ORDER BY sequence_num ASC`,
    [args.sessionId]
  );

  const results = turnsResult.rows.map((row: Record<string, unknown>) => {
    const reqHashPresent = row.request_hash !== null && row.request_hash !== "";
    const respHashPresent = row.response_hash !== null && row.response_hash !== "";
    const reqBytesPresent = row.req_bytes_ref !== null && row.req_bytes_ref !== "";
    const respBytesPresent = row.resp_bytes_ref !== null && row.resp_bytes_ref !== "";

    // B1: Hash match is only true if BOTH the hash AND the bytes ref exist.
    const reqHashMatch = reqHashPresent && reqBytesPresent;
    const respHashMatch = respHashPresent && respBytesPresent;

    return {
      turnId: row.id as string,
      sequenceNum: row.sequence_num as number,
      reqHashMatch,
      respHashMatch,
      reqBytesPresent,
      respBytesPresent,
    };
  });

  const verifiedTurns = results.filter(
    (r) => r.reqHashMatch && r.respHashMatch
  ).length;
  const failedTurns = results.length - verifiedTurns;

  return {
    sessionId: args.sessionId,
    totalTurns: results.length,
    verifiedTurns,
    failedTurns,
    // N3: `verified` is always false by design. This B1 implementation only checks
    // field presence (do the hash and bytes ref columns exist and are non-empty?).
    // It does NOT re-hash the stored bytes and compare against the stored hash,
    // which would be required for true cryptographic integrity verification.
    // That is a future enhancement (B2: re-hashing). Until then, `verified: false`
    // honestly communicates that full integrity verification has not been performed.
    verified: false,
    results,
  };
};

// D0.4: DataLoader replaces N+1 queries for toolCalls and anomalies
const toolCallsResolver: NonNullable<TurnResolvers["toolCalls"]> = async (
  parent,
  _args,
  ctx
) => {
  return ctx.loaders.toolCallsByTurnId.load(parent.id);
};

const anomaliesResolver: NonNullable<TurnResolvers["anomalies"]> = async (
  parent,
  _args,
  ctx
) => {
  return ctx.loaders.anomaliesByTurnId.load(parent.id);
};

// Sprint P1B: Turn.attachments — batched per-turn attachment lookup.
// The Attachment.url field is computed here by pointing at the API's
// internal proxy route; the API server resolves the object store read
// at fetch time (dev: local filesystem, prod: signed S3 URL).
const attachmentsResolver: NonNullable<TurnResolvers["attachments"]> = async (
  parent,
  _args,
  ctx
) => {
  return ctx.loaders.attachmentsByTurnId.load(parent.id);
};

// Sprint P1B: Turn.attachmentCount — resolved via the same dataloader that
// feeds Turn.attachments so both calls in one query hit one SQL round-trip.
const attachmentCountResolver: NonNullable<TurnResolvers["attachmentCount"]> = async (
  parent,
  _args,
  ctx
) => {
  const attachments = await ctx.loaders.attachmentsByTurnId.load(parent.id);
  return attachments.length;
};

export const turnResolvers = {
  Query: {
    turn: turnResolver,
    search: searchResolver,
    verifyIntegrity: verifyIntegrityResolver,
  },
  Turn: {
    toolCalls: toolCallsResolver,
    anomalies: anomaliesResolver,
    attachments: attachmentsResolver,
    attachmentCount: attachmentCountResolver,
  },
};
