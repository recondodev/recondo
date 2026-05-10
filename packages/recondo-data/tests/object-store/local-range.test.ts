/**
 * Chunk 1, T1: ObjectStore.readRange (LOCAL driver) — D-OS1, D-OS2, D-OS3.
 *
 * Drives the production `LocalObjectStore` exported from `@recondo/data`
 * against a real on-disk content-addressable layout that mirrors the Rust
 * gateway's `gateway/src/storage/object.rs`:
 *
 *     <data_dir>/objects/<kind>/<hash>.json.gz
 *
 * The local driver MAY decompress the entire object and slice the
 * requested range — gzip random access is not required for v1.
 *
 * API shape under test (must be exported from `@recondo/data`):
 *
 *   class LocalObjectStore {
 *     constructor(opts: { objectsRoot: string });
 *     readRange(
 *       kind: string,
 *       hash: string,
 *       offset: number,
 *       length: number,
 *       signal?: AbortSignal,
 *     ): Promise<Buffer>;
 *   }
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// IMPORTANT: drives the public export. The implementer must add
// `LocalObjectStore` to `@recondo/data`'s root barrel.
import { LocalObjectStore } from "../../src/index.js";

let dataDir: string;

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function seedObject(kind: string, plaintext: Buffer): string {
  const hash = sha256Hex(plaintext);
  const dir = join(dataDir, "objects", kind);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${hash}.json.gz`), gzipSync(plaintext));
  return hash;
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "recondo-data-os-range-"));
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("LocalObjectStore.readRange — D-OS1 happy-path slicing", () => {
  it("returns exact bytes for a known offset/length against a real seeded object", async () => {
    const plaintext = Buffer.from(
      '{"hello":"world","greeting":"howdy partner"}',
      "utf8",
    );
    const hash = seedObject("req", plaintext);
    const store = new LocalObjectStore({ objectsRoot: join(dataDir, "objects") });

    // Read 12 bytes starting at offset 1: '"hello":"wor'
    // (plaintext[0]='{', plaintext[1]='"', so subarray(1, 13) === '"hello":"wor'.)
    const slice = await store.readRange("req", hash, 1, 12);
    expect(Buffer.isBuffer(slice)).toBe(true);
    expect(slice.length).toBe(12);
    expect(slice.equals(plaintext.subarray(1, 13))).toBe(true);
    expect(slice.toString("utf8")).toBe('"hello":"wor');
  });

  it("returns the full object when offset=0, length=bytes_total", async () => {
    const plaintext = Buffer.from("the quick brown fox jumps over the lazy dog", "utf8");
    const hash = seedObject("req", plaintext);
    const store = new LocalObjectStore({ objectsRoot: join(dataDir, "objects") });

    const slice = await store.readRange("req", hash, 0, plaintext.length);
    expect(slice.equals(plaintext)).toBe(true);
  });

  it("works for kind='resp' too (kind is a real path component, not hardcoded)", async () => {
    const plaintext = Buffer.from('{"choices":[{"index":0}]}', "utf8");
    const hash = seedObject("resp", plaintext);
    const store = new LocalObjectStore({ objectsRoot: join(dataDir, "objects") });

    const slice = await store.readRange("resp", hash, 0, 5);
    expect(slice.length).toBe(5);
    expect(slice.toString("utf8")).toBe('{"cho');
  });
});

describe("LocalObjectStore.readRange — D-OS2 clamps past EOF", () => {
  it("returns the tail when offset + length > bytes_total", async () => {
    const plaintext = Buffer.from("0123456789", "utf8");
    const hash = seedObject("req", plaintext);
    const store = new LocalObjectStore({ objectsRoot: join(dataDir, "objects") });

    // Ask for 100 bytes starting at offset 7. Object is 10 bytes total.
    const slice = await store.readRange("req", hash, 7, 100);
    expect(slice.length).toBe(3);
    expect(slice.toString("utf8")).toBe("789");
  });

  it("returns an empty Buffer when offset === bytes_total", async () => {
    const plaintext = Buffer.from("0123456789", "utf8");
    const hash = seedObject("req", plaintext);
    const store = new LocalObjectStore({ objectsRoot: join(dataDir, "objects") });

    const slice = await store.readRange("req", hash, 10, 50);
    expect(Buffer.isBuffer(slice)).toBe(true);
    expect(slice.length).toBe(0);
  });
});

describe("LocalObjectStore.readRange — D-OS3 pre-aborted signal", () => {
  it("rejects with AbortError BEFORE issuing any fs read", async () => {
    // Use a hash that does NOT exist on disk. If the abort check fires
    // first (the contract), readRange rejects with AbortError. If the
    // implementation forgets to short-circuit on abort and proceeds to
    // touch the filesystem, fs.readFile/fs.open will reject with an
    // ENOENT error — a different error.name and a clear failure.
    const store = new LocalObjectStore({ objectsRoot: join(dataDir, "objects") });
    const bogusHash = "0".repeat(64); // valid hex, but no file written

    const ctrl = new AbortController();
    ctrl.abort();

    let caught: unknown = null;
    try {
      await store.readRange("req", bogusHash, 0, 10, ctrl.signal);
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    // AbortError, NOT ENOENT/anything-else — proves no fs work happened.
    expect((caught as Error).name).toBe("AbortError");
  });

  it("does not even resolve the on-disk path when signal is pre-aborted", async () => {
    // A second variant: even when the file DOES exist, we should still
    // observe AbortError. This rules out the implementation reading the
    // file first and only then checking the signal.
    const plaintext = Buffer.from("never-read", "utf8");
    const hash = seedObject("req", plaintext);
    const store = new LocalObjectStore({ objectsRoot: join(dataDir, "objects") });

    const ctrl = new AbortController();
    ctrl.abort();

    let caught: unknown = null;
    try {
      await store.readRange("req", hash, 0, 10, ctrl.signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect((caught as Error).name).toBe("AbortError");
  });
});
