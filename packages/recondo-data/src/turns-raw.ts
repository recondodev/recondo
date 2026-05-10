/**
 * Turn raw-body access — metadata + chunked reads against the
 * content-addressable object store.
 *
 * Public surface:
 *   - getTurnRawMetadata(turnId, options?) -> { content_hash, bytes_total,
 *       content_type, head_sample_utf8 }
 *   - getTurnRawChunk(turnId, offset, length, options?) -> { offset, bytes,
 *       next_offset }
 *
 * Schema column reality (right-column names ONLY — see CLAUDE.md):
 *   - turns.request_hash         (NOT request_content_hash)
 *   - turns.req_bytes_size       (NOT request_bytes_total)
 *   - turns.req_bytes_ref        ("objects/<kind>/<hash>.json.gz" or
 *                                 "<kind>/<hash>.json.gz")
 *
 * Decisions baked into these contracts:
 *
 *  1. content_type sniff: first non-whitespace byte of the body (after
 *     trimming ASCII whitespace 0x09/0x0A/0x0D/0x20 from the head):
 *       - 0x7B `{` or 0x5B `[` → "application/json"
 *       - everything else      → "application/octet-stream"
 *     There is NO "default to application/json" path.
 *
 *  2. head_sample_utf8: at most 4096 BYTES of the body, decoded via
 *     `Buffer.toString("utf8")` (which replaces invalid sequences with
 *     U+FFFD — correct for binary heads). Cap is byte-based, not
 *     codepoint-based.
 *
 *  3. getTurnRawChunk silently caps `length` at 32_768 (never throws on
 *     overage). When the request goes past EOF, returns
 *     `bytes_total - offset` bytes (or zero bytes if offset === bytes_total).
 *     When `offset + bytes.length === bytes_total`, `next_offset === null`.
 *     Otherwise `next_offset === offset + bytes.length`.
 *
 *  4. getTurnRawChunk: negative `offset` OR negative `length` throws
 *     SYNCHRONOUSLY. The exported function is a regular `function` (not
 *     `async`) that validates synchronously, then delegates to an inner
 *     `async` helper.
 *
 *  5. Object-store resolution: both functions construct an object-store
 *     range reader from process env. `RECONDO_OBJECTS=s3` reads from the
 *     configured `RECONDO_S3_BUCKET`; unset or `local` reads from the
 *     local objects root. Local root priority:
 *       (a) `process.env.RECONDO_OBJECT_STORE_PATH` — points DIRECTLY at
 *           the objects root that contains `<kind>/<hash>.json.gz`
 *           subdirs (this is the env var the MCP layer surfaces).
 *       (b) `process.env.RECONDO_DATA_DIR` — gateway-style data dir;
 *           the helper appends `/objects` to match the on-disk layout.
 *       (c) `<home>/.recondo/objects` as the last-resort fallback.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { getPool } from "./pool.js";
import { LocalObjectStore, S3ObjectStore } from "./object-store/index.js";

const HEAD_SAMPLE_BYTE_CAP = 4096;
const CHUNK_LENGTH_CAP = 32_768;

const ASCII_WS = new Set<number>([0x09, 0x0a, 0x0d, 0x20]);

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
}

/**
 * Resolve the directory that contains the content-addressable object
 * store's `<kind>/<hash>.json.gz` tree. Higher-priority overrides win.
 *
 *   1. RECONDO_OBJECT_STORE_PATH — points at the objects root directly.
 *   2. RECONDO_DATA_DIR          — gateway data dir; append `/objects`.
 *   3. <home>/.recondo/objects   — last-resort fallback.
 */
export function resolveObjectsRoot(): string {
  if (process.env.RECONDO_OBJECT_STORE_PATH) {
    return process.env.RECONDO_OBJECT_STORE_PATH;
  }
  const dataDir = process.env.RECONDO_DATA_DIR ?? join(homedir(), ".recondo");
  return join(dataDir, "objects");
}

interface ObjectRangeReader {
  readRange(
    kind: string,
    hash: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Buffer>;
}

function createObjectStoreFromEnv(): ObjectRangeReader {
  const driver = process.env.RECONDO_OBJECTS ?? "local";
  if (driver === "local") {
    return new LocalObjectStore({ objectsRoot: resolveObjectsRoot() });
  }
  if (driver === "s3") {
    const bucket = process.env.RECONDO_S3_BUCKET;
    if (!bucket) {
      throw new Error("RECONDO_S3_BUCKET is required when RECONDO_OBJECTS=s3");
    }
    return new S3ObjectStore({ bucket });
  }
  throw new Error(
    `Object store driver ${JSON.stringify(driver)} is not supported by ` +
      `getTurnRawMetadata / getTurnRawChunk. Expected RECONDO_OBJECTS=local, ` +
      `RECONDO_OBJECTS=s3, or unset.`,
  );
}

/**
 * Sniff content_type from the body's leading non-whitespace byte.
 *
 *   `{` (0x7B) or `[` (0x5B) → "application/json"
 *   anything else            → "application/octet-stream"
 *
 * Whitespace skipped: 0x09 (tab), 0x0A (LF), 0x0D (CR), 0x20 (space).
 */
function sniffContentType(buf: Buffer): "application/json" | "application/octet-stream" {
  let i = 0;
  while (i < buf.length && ASCII_WS.has(buf[i])) {
    i++;
  }
  if (i >= buf.length) {
    return "application/octet-stream";
  }
  const b = buf[i];
  if (b === 0x7b /* { */ || b === 0x5b /* [ */) {
    return "application/json";
  }
  return "application/octet-stream";
}

interface TurnRawRow {
  request_hash: string;
  req_bytes_size: number;
  req_bytes_ref: string | null;
}

async function loadTurnRawRow(
  turnId: string,
  signal: AbortSignal | undefined,
): Promise<TurnRawRow> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT request_hash, req_bytes_size, req_bytes_ref
     FROM turns
     WHERE id = $1`,
    [turnId],
  );
  // Re-check abort post-IO so a mid-flight cancel still surfaces.
  throwIfAborted(signal);
  if (result.rows.length === 0) {
    throw new Error(`Turn not found: ${turnId}`);
  }
  const row = result.rows[0] as Record<string, unknown>;
  return {
    request_hash: row.request_hash as string,
    req_bytes_size: Number(row.req_bytes_size),
    req_bytes_ref: (row.req_bytes_ref as string | null) ?? null,
  };
}

/**
 * Parse a `req_bytes_ref` like `"objects/req/<hash>.json.gz"` or
 * `"req/<hash>.json.gz"` into `{ kind, hash }`.
 * Falls back to `kind="req"` plus `hash` when the ref is null/empty.
 */
function refToKindHash(ref: string | null, hash: string): { kind: string; hash: string } {
  if (ref && ref.length > 0) {
    // Gateway rows may store backend keys (`objects/<kind>/<hash>.json.gz`)
    // or backend-agnostic refs (`<kind>/<hash>.json.gz`).
    const normalized = ref.startsWith("objects/")
      ? ref.slice("objects/".length)
      : ref;
    const parts = normalized.split("/");
    if (parts.length === 2 && parts[0].length > 0 && parts[1].length > 0) {
      const [kind, filename] = parts;
      const refHash = filename.endsWith(".json.gz")
        ? filename.slice(0, -".json.gz".length)
        : filename.split(".")[0];
      return { kind, hash: refHash };
    }
  }
  return { kind: "req", hash };
}

export interface TurnRawMetadata {
  content_hash: string;
  bytes_total: number;
  content_type: "application/json" | "application/octet-stream";
  head_sample_utf8: string;
}

export async function getTurnRawMetadata(
  turnId: string,
  options?: { signal?: AbortSignal },
): Promise<TurnRawMetadata> {
  const signal = options?.signal;
  // FIRST statement after argument validation — before any DB / fs I/O.
  // D-RM4 spies on pool.query and asserts it is never called.
  throwIfAborted(signal);

  const row = await loadTurnRawRow(turnId, signal);
  const { kind, hash } = refToKindHash(row.req_bytes_ref, row.request_hash);

  const store = createObjectStoreFromEnv();
  const head = await store.readRange(kind, hash, 0, HEAD_SAMPLE_BYTE_CAP, signal);

  return {
    content_hash: row.request_hash,
    bytes_total: row.req_bytes_size,
    content_type: sniffContentType(head),
    head_sample_utf8: head.toString("utf8"),
  };
}

export interface TurnRawChunk {
  offset: number;
  bytes: Buffer;
  next_offset: number | null;
}

/**
 * Synchronous wrapper: validates `offset` / `length` synchronously
 * (negatives throw immediately, NOT via promise rejection), then
 * delegates to the async helper. The D-RC5 tests call this without
 * `await` and assert the throw is observable on the call expression
 * itself — making this `async` would convert the throw into a Promise
 * rejection and the test would fail.
 */
export function getTurnRawChunk(
  turnId: string,
  offset: number,
  length: number,
  options?: { signal?: AbortSignal },
): Promise<TurnRawChunk> {
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) {
    throw new Error(`getTurnRawChunk: offset must be a non-negative finite number (got ${offset})`);
  }
  if (typeof length !== "number" || !Number.isFinite(length) || length < 0) {
    throw new Error(`getTurnRawChunk: length must be a non-negative finite number (got ${length})`);
  }
  return getTurnRawChunkAsync(turnId, offset, length, options?.signal);
}

async function getTurnRawChunkAsync(
  turnId: string,
  offset: number,
  length: number,
  signal: AbortSignal | undefined,
): Promise<TurnRawChunk> {
  // FIRST statement of the async path — before any DB / fs I/O.
  // D-RC4 spies on pool.query and asserts it is never called.
  throwIfAborted(signal);

  const cappedLength = Math.min(length, CHUNK_LENGTH_CAP);

  const row = await loadTurnRawRow(turnId, signal);
  const { kind, hash } = refToKindHash(row.req_bytes_ref, row.request_hash);
  const bytesTotal = row.req_bytes_size;

  // Past-EOF clamp: if offset >= bytes_total return zero bytes.
  if (offset >= bytesTotal) {
    return { offset, bytes: Buffer.alloc(0), next_offset: null };
  }

  const store = createObjectStoreFromEnv();
  const bytes = await store.readRange(kind, hash, offset, cappedLength, signal);

  const endOffset = offset + bytes.length;
  const next_offset = endOffset >= bytesTotal ? null : endOffset;
  return { offset, bytes, next_offset };
}
