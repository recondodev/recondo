/**
 * Local filesystem ObjectStore — TypeScript port of the Rust gateway's
 * `gateway/src/storage/object.rs::LocalObjectStore`.
 *
 * Layout: `<dataDir>/objects/<kind>/<hash>.json.gz` — gzipped,
 * content-addressable. The on-disk format mirrors the gateway's
 * canonical store so the same data dir is interchangeable.
 *
 * Path validator accepts only `[A-Za-z0-9_-]` for both `kind` and `hash`
 * (mirrors Rust's `validate_path_component`) — rejects `/`, `\`, `..`,
 * and any other path separator to prevent path traversal.
 *
 * v1 perf tradeoff (documented for the reviewer): `readRange`
 * decompresses the entire object and slices the requested range. gzip
 * does not support efficient random access without a precomputed index;
 * v1 ships the simple correct implementation. A future v2 may add a
 * sidecar index OR switch to a chunkable codec (zstd seekable, xz
 * blocks) — out of scope for C1.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const PATH_COMPONENT_RE = /^[A-Za-z0-9_-]+$/;

function validatePathComponent(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (!PATH_COMPONENT_RE.test(value)) {
    throw new Error(
      `${label} contains invalid characters (must be alphanumeric, hyphens, or underscores): ${JSON.stringify(value)}`,
    );
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
}

export interface LocalObjectStoreOpts {
  dataDir: string;
}

export class LocalObjectStore {
  private readonly dataDir: string;

  constructor(opts: LocalObjectStoreOpts) {
    if (!opts || typeof opts.dataDir !== "string" || opts.dataDir.length === 0) {
      throw new Error("LocalObjectStore: dataDir is required");
    }
    this.dataDir = opts.dataDir;
  }

  private objectPath(kind: string, hash: string): string {
    validatePathComponent(kind, "kind");
    validatePathComponent(hash, "hash");
    return join(this.dataDir, "objects", kind, `${hash}.json.gz`);
  }

  /**
   * Read a byte range from the content-addressable object store.
   *
   * Behavior:
   *   - Pre-aborted `signal` → rejects with `AbortError` BEFORE any fs read.
   *   - Decompresses the full object (gzip random access not supported in v1)
   *     then returns `plaintext.slice(offset, offset + length)`.
   *   - When `offset + length > bytes_total`, returns the tail
   *     (`bytes_total - offset` bytes).
   *   - When `offset === bytes_total`, returns an empty Buffer.
   */
  async readRange(
    kind: string,
    hash: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    // Abort check FIRST — before any fs I/O. The pre-aborted-signal
    // tests (D-OS3) verify we never touch the disk.
    throwIfAborted(signal);

    const path = this.objectPath(kind, hash);
    const compressed = await readFile(path);
    // Re-check after I/O in case the signal aborted during the read.
    throwIfAborted(signal);

    const plaintext = gunzipSync(compressed);

    if (offset >= plaintext.length) {
      return Buffer.alloc(0);
    }
    const end = Math.min(plaintext.length, offset + length);
    // Buffer.subarray returns a view; copy to ensure callers get an
    // independent Buffer they cannot accidentally mutate the cache via.
    return Buffer.from(plaintext.subarray(offset, end));
  }
}
