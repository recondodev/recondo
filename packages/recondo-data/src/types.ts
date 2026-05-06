/**
 * Canonical type vocabulary for @recondo/data. Consumers (api, mcp,
 * tools) import these instead of redeclaring locally so the wire
 * shape and validation semantics stay aligned.
 */

/**
 * Information about an authenticated API key.
 *
 * `projectId === null` means an admin (cross-project) key.
 */
export interface ApiKeyInfo {
  id: string;
  projectId: string | null;
  rateLimitRpm: number;
}

/**
 * Branded `since`-cursor string. Returned by `encodeSinceCursor` and
 * accepted by `decodeSinceCursor`. Branding prevents arbitrary strings
 * (e.g. user-supplied path probes) from sneaking into a cursor
 * parameter without going through the codec.
 */
export type SinceCursor = string & { readonly __brand: "SinceCursor" };

/**
 * Decoded payload of a `SinceCursor`. Both fields MUST be non-empty
 * strings; the codec rejects empty / non-string values both ways.
 */
export interface SinceCursorPayload {
  ts: string;
  id: string;
}

/**
 * Common query options — every list / read function in @recondo/data
 * accepts an `AbortSignal` so callers can cancel long-running queries.
 */
export interface QueryOptions {
  signal?: AbortSignal;
}

/**
 * Options for paginated list queries. All fields are optional; defaults
 * are owned by the call site.
 */
export interface ListOptions extends QueryOptions {
  limit?: number;
  offset?: number;
  since?: SinceCursor;
}

/**
 * Uniform list-response envelope (v1).
 *
 * - `items`: page of rows.
 * - `next_offset`: offset to pass to the next call, or null when the
 *   page is the last one.
 * - `truncated`: true when the result was capped by `limit` and more
 *   rows exist.
 * - `stream_id`: reserved for streaming variants (always `null` in v1).
 * - `is_final`: literal `true` in v1 (every response is final).
 * - `total`: optional total row count when the call site knows it
 *   from a `COUNT(*)`.
 */
export interface ListEnvelope<T> {
  items: T[];
  next_offset: number | null;
  truncated: boolean;
  stream_id: null;
  is_final: true;
  total?: number;
}

/**
 * Errors thrown for caller-supplied input violations (bad cursor, bad
 * limit, malformed filter, etc.). Carries a stable machine-readable
 * `code` so transports can map it to HTTP 400 / GraphQL
 * BAD_USER_INPUT.
 *
 * Default code is `"BAD_USER_INPUT"`; pass a more specific code when
 * the call site distinguishes (e.g. `"LIMIT_EXCEEDED"`).
 */
export class DataValidationError extends Error {
  public readonly code: string;
  constructor(message: string, code: string = "BAD_USER_INPUT") {
    super(message);
    this.name = "DataValidationError";
    this.code = code;
    // Restore prototype chain so `instanceof` works across compile
    // targets that down-level `extends Error`.
    Object.setPrototypeOf(this, DataValidationError.prototype);
  }
}
