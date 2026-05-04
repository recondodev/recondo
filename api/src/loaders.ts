/**
 * DataLoader factory functions for batching N+1 queries.
 *
 * Each loader batches multiple `.load(id)` calls into a single SQL query
 * using `ANY($1)` array matching. Results are grouped by the parent key
 * and returned in the same order as the input keys.
 *
 * W1 fix: All queries use explicit column lists instead of SELECT *.
 * Only columns consumed by the mapper functions are selected.
 */

import DataLoader from "dataloader";
import type pg from "pg";
import { mapTurn, mapToolCall, mapAnomaly, mapSession } from "./resolvers/mappers.js";
import type { MappedAttachment } from "./resolvers/mappers.js";

// W1: Explicit column lists matching what each mapper actually uses.
// This avoids pulling unnecessary data and documents the contract between
// the SQL layer and the mapper functions.

/** Columns consumed by mapTurn() -- only columns that exist in the gateway schema.
 * Note: total_tokens is NOT in the DB; it's computed from input_tokens + output_tokens + thinking_tokens.
 * Note: role is NOT in the gateway turns table; turnType maps from role which may not exist.
 * D1.3: Added user_request_text, response_text, thinking_text, cache_read_tokens,
 *   cache_creation_tokens, http_status, transport, ttfb_ms for enhanced Turn type. */
const TURN_COLUMNS = [
  "id", "session_id", "sequence_num", "timestamp", "model", "provider",
  "input_tokens", "output_tokens", "thinking_tokens",
  "cost_usd", "duration_ms", "capture_complete", "req_bytes_ref",
  "resp_bytes_ref", "stop_reason", "tool_call_count",
  "request_hash", "response_hash",
  "user_request_text", "response_text", "thinking_text",
  "cache_read_tokens", "cache_creation_tokens",
  "http_status", "transport", "ttfb_ms",
].join(", ");

/** Columns consumed by mapToolCall() -- only columns that exist in the gateway schema.
 * Note: tool_input_hash does NOT exist in the DB; the mapper falls back from input_hash. */
const TOOL_CALL_COLUMNS = [
  "id", "turn_id", "tool_name", "tool_input", "input_hash",
  "output", "output_hash", "duration_ms",
  "status", "sequence_num",
].join(", ");

/** Columns consumed by mapAnomaly() */
const ANOMALY_COLUMNS = [
  "id", "session_id", "turn_id", "anomaly_type", "severity",
  "description", "detected_at", "metadata",
].join(", ");

/** Columns consumed by mapSession()
 * D1.2: Added framework, device_id, git_repo, git_branch for enhanced Session type.
 * Note: account_uuid was already included (used for projectId fallback and accountUuid). */
const SESSION_COLUMNS = [
  "id", "project_id", "account_uuid", "agent_id", "model", "provider",
  "started_at", "ended_at", "last_active_at", "initial_intent", "system_prompt_hash",
  "total_turns", "turns_captured", "dropped_events", "total_tokens",
  "total_cost_usd", "framework", "device_id", "git_repo", "git_branch",
].join(", ");

/**
 * Creates a DataLoader that batches turns by session_id.
 * Used by Session.turns resolver.
 */
export function createTurnsBySessionIdLoader(pool: pg.Pool) {
  return new DataLoader<string, Array<ReturnType<typeof mapTurn>>>(
    async (sessionIds) => {
      const result = await pool.query(
        `SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ANY($1) ORDER BY sequence_num ASC`,
        [sessionIds as string[]]
      );

      // Group rows by session_id
      const grouped = new Map<string, Array<ReturnType<typeof mapTurn>>>();
      for (const row of result.rows) {
        const sid = row.session_id as string;
        if (!grouped.has(sid)) grouped.set(sid, []);
        grouped.get(sid)!.push(mapTurn(row));
      }

      // Return in the same order as input keys
      return sessionIds.map((sid) => grouped.get(sid) ?? []);
    }
  );
}

/**
 * Creates a DataLoader that batches tool_calls by turn_id.
 * Used by Turn.toolCalls resolver.
 */
export function createToolCallsByTurnIdLoader(pool: pg.Pool) {
  return new DataLoader<string, Array<ReturnType<typeof mapToolCall>>>(
    async (turnIds) => {
      const result = await pool.query(
        `SELECT ${TOOL_CALL_COLUMNS} FROM tool_calls WHERE turn_id = ANY($1) ORDER BY sequence_num ASC`,
        [turnIds as string[]]
      );

      const grouped = new Map<string, Array<ReturnType<typeof mapToolCall>>>();
      for (const row of result.rows) {
        const tid = row.turn_id as string;
        if (!grouped.has(tid)) grouped.set(tid, []);
        grouped.get(tid)!.push(mapToolCall(row));
      }

      return turnIds.map((tid) => grouped.get(tid) ?? []);
    }
  );
}

/**
 * Creates a DataLoader that batches anomaly_events by turn_id.
 * Used by Turn.anomalies resolver.
 */
export function createAnomaliesByTurnIdLoader(pool: pg.Pool) {
  return new DataLoader<string, Array<ReturnType<typeof mapAnomaly>>>(
    async (turnIds) => {
      const result = await pool.query(
        `SELECT ${ANOMALY_COLUMNS} FROM anomaly_events WHERE turn_id = ANY($1) ORDER BY detected_at ASC`,
        [turnIds as string[]]
      );

      const grouped = new Map<string, Array<ReturnType<typeof mapAnomaly>>>();
      for (const row of result.rows) {
        const tid = row.turn_id as string;
        if (!grouped.has(tid)) grouped.set(tid, []);
        grouped.get(tid)!.push(mapAnomaly(row));
      }

      return turnIds.map((tid) => grouped.get(tid) ?? []);
    }
  );
}

/**
 * Creates a DataLoader that batches sessions by id.
 * Used by AnomalyEvent.session resolver.
 */
export function createSessionByIdLoader(pool: pg.Pool) {
  return new DataLoader<string, ReturnType<typeof mapSession> | null>(
    async (sessionIds) => {
      const [result, cacheResult] = await Promise.all([
        pool.query(
          `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ANY($1)`,
          [sessionIds as string[]]
        ),
        // B1 fix: Aggregate cache tokens from turns for each session.
        // The sessions table doesn't have cache token columns; they live on turns.
        pool.query(
          `SELECT session_id,
                  COALESCE(SUM(cache_read_tokens), 0)::int AS cache_read_tokens,
                  COALESCE(SUM(cache_creation_tokens), 0)::int AS cache_creation_tokens
           FROM turns
           WHERE session_id = ANY($1)
           GROUP BY session_id`,
          [sessionIds as string[]]
        ),
      ]);

      // Build cache token lookup
      const cacheMap = new Map<string, { cacheReadTokens: number; cacheCreationTokens: number }>();
      for (const row of cacheResult.rows) {
        cacheMap.set(row.session_id as string, {
          cacheReadTokens: (row.cache_read_tokens as number) ?? 0,
          cacheCreationTokens: (row.cache_creation_tokens as number) ?? 0,
        });
      }

      const mapped = new Map<string, ReturnType<typeof mapSession>>();
      for (const row of result.rows) {
        const session = mapSession(row);
        // Merge aggregated cache tokens into the session
        const cache = cacheMap.get(session.id);
        if (cache) {
          session.cacheReadTokens = cache.cacheReadTokens;
          session.cacheCreationTokens = cache.cacheCreationTokens;
        }
        mapped.set(row.id as string, session);
      }

      return sessionIds.map((sid) => mapped.get(sid) ?? null);
    }
  );
}

/**
 * Creates a DataLoader that batches attachments by turn_id. Used by
 * Turn.attachments and Turn.attachmentCount resolvers.
 *
 * Attachment.url points at the /v1/attachments/:id REST route (same pattern
 * as the rest of our /v1/* endpoints — /v1/audit/export.csv, /v1/sessions/*,
 * etc.). Binary bytes stream through REST, metadata travels via GraphQL —
 * the standard split for this API.
 *
 * For external_image_url kind, object_ref holds the original URL (not an
 * object-store key), so we surface it directly and the browser fetches it
 * cross-origin rather than going through the proxy.
 */
export function createAttachmentsByTurnIdLoader(pool: pg.Pool) {
  return new DataLoader<string, MappedAttachment[]>(async (turnIds) => {
    const result = await pool.query(
      `SELECT id, turn_id, session_id, sequence_num, role, kind, mime_type,
              size_bytes, sha256, object_ref, filename, width, height
       FROM attachments
       WHERE turn_id = ANY($1)
       ORDER BY sequence_num ASC`,
      [turnIds as string[]]
    );

    const grouped = new Map<string, MappedAttachment[]>();
    for (const row of result.rows) {
      const tid = row.turn_id as string;
      const kind = row.kind as string;
      const url =
        kind === "external_image_url"
          ? (row.object_ref as string)
          : `/v1/attachments/${row.id as string}`;
      const attachment: MappedAttachment = {
        id: row.id as string,
        turnId: tid,
        sessionId: row.session_id as string,
        sequenceNum: Number(row.sequence_num ?? 0),
        role: (row.role as string) ?? "user",
        kind,
        mimeType: (row.mime_type as string) ?? "application/octet-stream",
        sizeBytes: Number(row.size_bytes ?? 0),
        sha256: (row.sha256 as string) ?? "",
        filename: (row.filename as string | null) ?? null,
        width: (row.width as number | null) ?? null,
        height: (row.height as number | null) ?? null,
        url,
      };
      if (!grouped.has(tid)) grouped.set(tid, []);
      grouped.get(tid)!.push(attachment);
    }
    return turnIds.map((tid) => grouped.get(tid) ?? []);
  });
}

/**
 * Creates a DataLoader that batches session titles extracted from haiku
 * title-generation turns. Claude Code (and similar agents) fire a haiku call
 * whose response is `{"title": "short phrase"}`; we extract the phrase via a
 * POSIX regex SUBSTRING match rather than parsing JSON in the DB. The first
 * matching haiku turn per session wins. Returns null when no match.
 */
export function createTitleBySessionIdLoader(pool: pg.Pool) {
  return new DataLoader<string, string | null>(
    async (sessionIds) => {
      // UNNEST expands the input array into a virtual table `s(id)`. The
      // correlated SUBSTRING subquery scans the session's haiku turns for
      // the first JSON `{"title": "..."}` response and extracts the title
      // with a POSIX regex capture group. One query for the whole batch.
      const result = await pool.query(
        `SELECT
           s.id AS session_id,
           (SELECT SUBSTRING(t.response_text FROM '"title"[[:space:]]*:[[:space:]]*"([^"]*)"')
            FROM turns t
            WHERE t.session_id = s.id
              AND LOWER(COALESCE(t.model, '')) LIKE '%haiku%'
              AND t.response_text ~ '"title"[[:space:]]*:[[:space:]]*"[^"]*"'
            ORDER BY t.sequence_num ASC, t.timestamp ASC
            LIMIT 1) AS title
         FROM UNNEST($1::text[]) AS s(id)`,
        [sessionIds as string[]]
      );

      const byId = new Map<string, string | null>();
      for (const row of result.rows) {
        const raw = (row.title as string | null) ?? null;
        byId.set(row.session_id as string, raw && raw.length > 0 ? raw : null);
      }
      return sessionIds.map((sid) => byId.get(sid) ?? null);
    }
  );
}

/**
 * Creates a DataLoader that batches turns by id.
 * Used by AnomalyEvent.turn resolver.
 */
export function createTurnByIdLoader(pool: pg.Pool) {
  return new DataLoader<string, ReturnType<typeof mapTurn> | null>(
    async (turnIds) => {
      const result = await pool.query(
        `SELECT ${TURN_COLUMNS} FROM turns WHERE id = ANY($1)`,
        [turnIds as string[]]
      );

      const mapped = new Map<string, ReturnType<typeof mapTurn>>();
      for (const row of result.rows) {
        mapped.set(row.id as string, mapTurn(row));
      }

      return turnIds.map((tid) => mapped.get(tid) ?? null);
    }
  );
}

/**
 * Container for all DataLoader instances, created per-request.
 */
export interface Loaders {
  turnsBySessionId: ReturnType<typeof createTurnsBySessionIdLoader>;
  toolCallsByTurnId: ReturnType<typeof createToolCallsByTurnIdLoader>;
  anomaliesByTurnId: ReturnType<typeof createAnomaliesByTurnIdLoader>;
  sessionById: ReturnType<typeof createSessionByIdLoader>;
  turnById: ReturnType<typeof createTurnByIdLoader>;
  titleBySessionId: ReturnType<typeof createTitleBySessionIdLoader>;
  attachmentsByTurnId: ReturnType<typeof createAttachmentsByTurnIdLoader>;
}

/**
 * Creates a fresh set of DataLoader instances for a single request.
 * DataLoaders must be per-request to avoid caching stale data across requests.
 */
export function createLoaders(pool: pg.Pool): Loaders {
  return {
    turnsBySessionId: createTurnsBySessionIdLoader(pool),
    toolCallsByTurnId: createToolCallsByTurnIdLoader(pool),
    anomaliesByTurnId: createAnomaliesByTurnIdLoader(pool),
    sessionById: createSessionByIdLoader(pool),
    turnById: createTurnByIdLoader(pool),
    titleBySessionId: createTitleBySessionIdLoader(pool),
    attachmentsByTurnId: createAttachmentsByTurnIdLoader(pool),
  };
}
