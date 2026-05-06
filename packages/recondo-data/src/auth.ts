/**
 * API key authentication.
 *
 * Two entry points:
 *
 *   - `authenticateApiKey(token, options)` — accepts the raw token bytes
 *     (no `Bearer ` prefix), validates the prefix + database lookup, and
 *     returns an `ApiKeyInfo` (or null on any failure mode). Honors an
 *     optional `AbortSignal` so callers can cancel long-running queries.
 *
 *   - `authenticateRequest(authHeader, options)` — thin wrapper that
 *     extracts the token from a full `Authorization` header value
 *     (`Bearer <token>`, case-insensitive) and delegates to
 *     `authenticateApiKey`. Backward-compatible entry point for code that
 *     already had a header in hand.
 *
 * Security notes:
 *   - Tokens are SHA-256 hashed before the lookup; the raw token never
 *     leaves this function.
 *   - Revoked keys (revoked_at IS NOT NULL) return null even if the
 *     hash matches.
 *   - `projectId === null` is allowed and means an admin (cross-project)
 *     key — preserve this from the original implementation.
 */

import { createHash } from "node:crypto";
import { getPool } from "./pool.js";
import type { ApiKeyInfo, QueryOptions } from "./types.js";

/**
 * Validate a raw API key token (no Bearer prefix).
 *
 * Returns `null` for any failure mode (missing / malformed / unknown /
 * revoked). Throws `AbortError` (DOMException) when the supplied
 * `AbortSignal` is already aborted OR aborts mid-flight.
 *
 * D-A3 contract: the signal MUST be checked BEFORE any database query
 * is issued. The auth-contract test asserts that an already-aborted
 * signal causes rejection regardless of token validity.
 */
export async function authenticateApiKey(
  token: string | null | undefined,
  options: QueryOptions = {},
): Promise<ApiKeyInfo | null> {
  // CRITICAL: check signal BEFORE any other work, including null checks.
  // The auth-contract test (D-A3) asserts that an already-aborted signal
  // causes rejection regardless of token validity.
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }

  if (!token) return null;
  const trimmed = token.trim();
  if (!trimmed) return null; // whitespace-only

  // Token must start with the wrt_ prefix (mirrors original behavior).
  if (!trimmed.startsWith("wrt_")) return null;

  // Hash the token to look up in the database.
  const keyHash = createHash("sha256").update(trimmed).digest("hex");

  const pool = getPool();
  const queryPromise = pool.query(
    `SELECT id, project_id, rate_limit_rpm, revoked_at
     FROM api_keys
     WHERE key_hash = $1`,
    [keyHash],
  );

  // If the caller passed an AbortSignal, race the query against abort.
  // Note: pg.Pool.query() doesn't natively cancel on signal abort, so
  // the worst case is a wasted query — but the caller's promise rejects
  // immediately and the consumer can move on.
  const result = options.signal
    ? await (async () => {
        const signal = options.signal!;
        let onAbort!: () => void;
        const abortP = new Promise<never>((_, reject) => {
          onAbort = () => reject(new DOMException("aborted", "AbortError"));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          return await Promise.race([queryPromise, abortP]);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      })()
    : await queryPromise;

  if (result.rows.length === 0) return null;
  const row = result.rows[0];

  // Revoked keys return null (preserves original behavior).
  if (row.revoked_at !== null) return null;

  return {
    id: row.id,
    projectId: row.project_id, // null for admin keys (cross-project)
    rateLimitRpm: row.rate_limit_rpm,
  };
}

/**
 * Extract and validate the API key from an Authorization header value.
 *
 * Expected format: `Authorization: Bearer wrt_...`. The `Bearer` scheme
 * check is case-insensitive (W8 fix from original implementation), and
 * surrounding whitespace around the token is trimmed.
 *
 * Returns the same shape as `authenticateApiKey`: `ApiKeyInfo` on
 * success, `null` on any failure mode.
 */
export async function authenticateRequest(
  authHeader: string | undefined | null,
  options: QueryOptions = {},
): Promise<ApiKeyInfo | null> {
  if (!authHeader) return null;
  if (!authHeader.toLowerCase().startsWith("bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return authenticateApiKey(token, options);
}
