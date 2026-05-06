/**
 * Chunk 1, T3: getTurnRawChunk — D-RC1..5.
 *
 * Drives the public exported function:
 *
 *   getTurnRawChunk(
 *     turnId: string,
 *     offset: number,
 *     length: number,
 *     options?: { signal?: AbortSignal },
 *   ): Promise<{
 *     offset: number;
 *     bytes: Buffer;
 *     next_offset: number | null;
 *   }>;
 *
 * Decisions baked into these tests (must match the implementation):
 *   - length is silently capped at 32_768 (does NOT throw on length > cap).
 *   - When the request would go past EOF, returns
 *     `bytes_total - offset` bytes (or zero bytes if offset === bytes_total).
 *   - When offset + bytes.length === bytes_total, next_offset === null.
 *     Otherwise next_offset === offset + bytes.length.
 *   - Negative offset OR negative length throws SYNCHRONOUSLY (not via
 *     promise rejection): `expect(() => getTurnRawChunk(...)).toThrow(...)`.
 *   - Pre-aborted signal → rejects with AbortError BEFORE any DB or
 *     ObjectStore I/O.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closePool,
  getPool,
  // The implementer must export getTurnRawChunk from the package's
  // root barrel.
  getTurnRawChunk,
} from "../../src/index.js";

let dataDir: string;

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function seedObject(kind: string, plaintext: Buffer): { hash: string; ref: string } {
  const hash = sha256Hex(plaintext);
  const dir = join(dataDir, "objects", kind);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${hash}.json.gz`), gzipSync(plaintext));
  return { hash, ref: `${kind}/${hash}.json.gz` };
}

const seededIds: { sessionIds: string[]; turnIds: string[] } = {
  sessionIds: [],
  turnIds: [],
};

async function seedSession(): Promise<string> {
  const pool = getPool();
  const id = randomUUID();
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO sessions (id, provider, model, started_at, last_active_at,
                           system_prompt_hash, total_turns, turns_captured,
                           dropped_events, total_tokens, total_cost_usd,
                           tool_definitions_hash)
     VALUES ($1, 'anthropic', 'claude-sonnet-4-20250514', $2, $2,
             'systhash-rc', 0, 0, 0, 0, 0, '')`,
    [id, now],
  );
  seededIds.sessionIds.push(id);
  return id;
}

async function seedTurn(opts: {
  sessionId: string;
  body: Buffer;
}): Promise<{ turnId: string; hash: string; bytesTotal: number }> {
  const pool = getPool();
  const turnId = randomUUID();
  const now = new Date().toISOString();
  const { hash, ref } = seedObject("req", opts.body);
  const respHash = sha256Hex(Buffer.from("resp-sentinel:" + turnId, "utf8"));
  await pool.query(
    `INSERT INTO turns (id, session_id, sequence_num, timestamp,
                        request_hash, response_hash, req_bytes_ref,
                        req_bytes_size, model, provider,
                        input_tokens, output_tokens, cache_read_tokens,
                        cache_creation_tokens, stop_reason, created_at,
                        retry_count, tool_call_count, thinking_tokens)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7,
             'claude-sonnet-4-20250514', 'anthropic',
             0, 0, 0, 0, 'end_turn', $3, 0, 0, 0)`,
    [turnId, opts.sessionId, now, hash, respHash, ref, opts.body.length],
  );
  seededIds.turnIds.push(turnId);
  return { turnId, hash, bytesTotal: opts.body.length };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "recondo-data-rc-"));
  process.env.RECONDO_DATA_DIR = dataDir;
});

afterAll(async () => {
  const pool = getPool();
  if (seededIds.turnIds.length > 0 || seededIds.sessionIds.length > 0) {
    // The `prevent_turn_mutation` trigger (api/migrations/003) blocks
    // DELETE on turns unless `recondo.gdpr_bypass` is set inside the
    // current transaction. Use a checked-out client so SET LOCAL stays
    // scoped to the BEGIN..COMMIT block.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL recondo.gdpr_bypass = 'true'");
      if (seededIds.turnIds.length > 0) {
        await client.query(`DELETE FROM turns WHERE id = ANY($1)`, [
          seededIds.turnIds,
        ]);
      }
      if (seededIds.sessionIds.length > 0) {
        await client.query(`DELETE FROM sessions WHERE id = ANY($1)`, [
          seededIds.sessionIds,
        ]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  await closePool();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.RECONDO_DATA_DIR;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getTurnRawChunk — D-RC1 happy-path slice shape", () => {
  it("returns { offset, bytes, next_offset } with the requested slice", async () => {
    const sessionId = await seedSession();
    const body = Buffer.from("0123456789abcdefghij", "utf8"); // 20 bytes
    const { turnId } = await seedTurn({ sessionId, body });

    const out = await getTurnRawChunk(turnId, 4, 6);
    expect(out.offset).toBe(4);
    expect(Buffer.isBuffer(out.bytes)).toBe(true);
    expect(out.bytes.length).toBe(6);
    expect(out.bytes.toString("utf8")).toBe("456789");
    expect(out.next_offset).toBe(10); // 4 + 6 < 20
  });

  it("returns bytes.length === bytes_total - offset when slice runs to EOF", async () => {
    const sessionId = await seedSession();
    const body = Buffer.from("0123456789", "utf8"); // 10 bytes
    const { turnId } = await seedTurn({ sessionId, body });

    const out = await getTurnRawChunk(turnId, 7, 100);
    expect(out.offset).toBe(7);
    expect(out.bytes.length).toBe(3);
    expect(out.bytes.toString("utf8")).toBe("789");
  });

  it("returns zero-length bytes when offset === bytes_total", async () => {
    const sessionId = await seedSession();
    const body = Buffer.from("0123456789", "utf8"); // 10 bytes
    const { turnId } = await seedTurn({ sessionId, body });

    const out = await getTurnRawChunk(turnId, 10, 50);
    expect(out.offset).toBe(10);
    expect(out.bytes.length).toBe(0);
    expect(out.next_offset).toBeNull();
  });
});

describe("getTurnRawChunk — D-RC2 length cap at 32_768", () => {
  it("silently caps length at 32_768 (does NOT throw)", async () => {
    const sessionId = await seedSession();
    // 40_000-byte body so the cap is observable.
    const body = Buffer.alloc(40_000, 0x41); // 'A' repeated
    const { turnId } = await seedTurn({ sessionId, body });

    const out = await getTurnRawChunk(turnId, 0, 100_000);
    expect(out.offset).toBe(0);
    expect(out.bytes.length).toBe(32_768);
    // The cap-induced slice must be the FIRST 32_768 bytes of the body.
    expect(out.bytes.equals(body.subarray(0, 32_768))).toBe(true);
    // And we are NOT at EOF, so next_offset advances by the capped slice size.
    expect(out.next_offset).toBe(32_768);
  });
});

describe("getTurnRawChunk — D-RC3 next_offset semantics", () => {
  it("returns next_offset === null when offset + bytes.length === bytes_total", async () => {
    const sessionId = await seedSession();
    const body = Buffer.from("0123456789", "utf8"); // 10 bytes
    const { turnId } = await seedTurn({ sessionId, body });

    // Slice exactly to EOF: offset=4, length=6 -> bytes.length=6, sum=10.
    const out = await getTurnRawChunk(turnId, 4, 6);
    expect(out.bytes.length).toBe(6);
    expect(out.offset + out.bytes.length).toBe(10);
    expect(out.next_offset).toBeNull();
  });

  it("returns next_offset === offset + bytes.length when there is more to read", async () => {
    const sessionId = await seedSession();
    const body = Buffer.from("0123456789abcdefghij", "utf8"); // 20 bytes
    const { turnId } = await seedTurn({ sessionId, body });

    const out = await getTurnRawChunk(turnId, 0, 5);
    expect(out.bytes.length).toBe(5);
    expect(out.next_offset).toBe(5);
  });
});

describe("getTurnRawChunk — D-RC4 pre-aborted signal", () => {
  it("rejects with AbortError BEFORE any DB query is issued", async () => {
    const sessionId = await seedSession();
    const { turnId } = await seedTurn({
      sessionId,
      body: Buffer.from("never-read", "utf8"),
    });

    // Spy on the pool's query method (configurable: class instance
    // method). If the abort guard fires first, query MUST NOT be
    // called.
    const pool = getPool();
    const querySpy = vi.spyOn(pool, "query");

    const ctrl = new AbortController();
    ctrl.abort();

    let caught: unknown = null;
    try {
      await getTurnRawChunk(turnId, 0, 10, { signal: ctrl.signal });
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect((caught as Error).name).toBe("AbortError");
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("rejects with AbortError even when turnId is bogus (no I/O leaks)", async () => {
    // Establishes that the abort check fires before the DB lookup AND
    // before any ObjectStore read attempt — otherwise we would observe
    // a row-not-found error or an ENOENT instead of AbortError.
    const ctrl = new AbortController();
    ctrl.abort();

    let caught: unknown = null;
    try {
      await getTurnRawChunk("00000000-0000-0000-0000-000000000000", 0, 10, {
        signal: ctrl.signal,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect((caught as Error).name).toBe("AbortError");
  });
});

describe("getTurnRawChunk — D-RC5 negative offset/length throw SYNCHRONOUSLY", () => {
  it("throws synchronously (not via promise rejection) for negative offset", () => {
    // No await: getTurnRawChunk must throw before constructing the
    // returned Promise. If the implementation only validates inside an
    // async function, this test fails because the call returns a
    // Promise rather than throwing.
    expect(() => getTurnRawChunk("any-id", -1, 100)).toThrow();
  });

  it("throws synchronously for negative length", () => {
    expect(() => getTurnRawChunk("any-id", 0, -5)).toThrow();
  });

  it("synchronous throw is observable WITHOUT producing a Promise (no UnhandledRejection)", () => {
    // We expect the call expression itself to raise, NOT for the
    // returned promise to reject. If this assertion ever passes by
    // virtue of an unhandled rejection it would surface in the test
    // output as an UnhandledRejection warning — which we want to
    // avoid by making the validation truly synchronous.
    let threw = false;
    let result: unknown = null;
    try {
      result = getTurnRawChunk("any-id", -1, 100);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(result).toBeNull();
  });
});
