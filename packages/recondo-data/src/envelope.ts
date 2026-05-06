import {
  DataValidationError,
  type ListEnvelope,
  type SinceCursor,
  type SinceCursorPayload,
} from "./types.js";

/**
 * Metadata for `uniformListEnvelope`. Callers carry pagination state
 * up from the SQL layer and hand it in here so the wire shape lives
 * in one place.
 */
export interface EnvelopeMeta {
  nextOffset: number | null;
  truncated: boolean;
}

/**
 * Wrap a page of rows in the v1 list envelope. `stream_id` is always
 * `null` and `is_final` is always `true` in v1 — these fields exist
 * so streaming variants can land additively in v2 without breaking
 * existing clients.
 */
export function uniformListEnvelope<T>(
  items: T[],
  meta: EnvelopeMeta,
): ListEnvelope<T> {
  return {
    items,
    next_offset: meta.nextOffset,
    truncated: meta.truncated,
    stream_id: null,
    is_final: true,
  };
}

/**
 * Encode a `(ts, id)` payload as a base64url-encoded JSON string and
 * return it as a branded `SinceCursor`.
 *
 * Rejects empty / non-string `ts` / `id` — the cursor's whole job is
 * to identify a deterministic resume point, and an empty value cannot
 * do that.
 */
export function encodeSinceCursor(payload: SinceCursorPayload): SinceCursor {
  if (typeof payload?.ts !== "string" || payload.ts.length === 0) {
    throw new DataValidationError("since cursor: ts is required");
  }
  if (typeof payload?.id !== "string" || payload.id.length === 0) {
    throw new DataValidationError("since cursor: id is required");
  }
  const json = JSON.stringify({ ts: payload.ts, id: payload.id });
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  return encoded as SinceCursor;
}

/**
 * Decode a `SinceCursor` back to its `{ ts, id }` payload.
 *
 * Rejects with `DataValidationError` (message matches
 * `/invalid since cursor/i`) on:
 *   - non-base64url input that decodes to non-JSON bytes
 *   - JSON that is not an object
 *   - missing `ts` or `id`
 *   - non-string `ts` or `id`
 */
export function decodeSinceCursor(cursor: SinceCursor): SinceCursorPayload {
  let json: string;
  try {
    // Buffer.from(..., "base64url") is permissive — it decodes whatever
    // it can from the input. We rely on the JSON.parse step below to
    // reject inputs that don't decode to a valid JSON document, which
    // is how we detect "non-base64url" in practice.
    json = Buffer.from(String(cursor), "base64url").toString("utf8");
  } catch {
    throw new DataValidationError("invalid since cursor: not base64url");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new DataValidationError(
      "invalid since cursor: payload is not valid JSON",
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new DataValidationError("invalid since cursor: payload is not an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.ts !== "string" || obj.ts.length === 0) {
    throw new DataValidationError("invalid since cursor: missing ts");
  }
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    throw new DataValidationError("invalid since cursor: missing id");
  }
  return { ts: obj.ts, id: obj.id };
}
