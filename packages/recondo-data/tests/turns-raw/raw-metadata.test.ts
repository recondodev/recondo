/**
 * Chunk 1, T2: getTurnRawMetadata — D-RM1..4.
 *
 * Drives the public exported function `getTurnRawMetadata(turnId, options?)`
 * end-to-end:
 *   1. Looks up the row from `turns` (column-name authoritative: request_hash,
 *      req_bytes_size, req_bytes_ref).
 *   2. Resolves the body bytes via `LocalObjectStore` against a tmpdir-rooted
 *      content-addressable layout.
 *   3. Sniffs content_type from the first non-whitespace byte.
 *
 * Decisions baked into these tests (must match the implementation):
 *   - content_type sniff: leading `{` or `[` (after whitespace) →
 *     "application/json"; everything else → "application/octet-stream".
 *     There is NO "default to application/json" path.
 *   - head_sample_utf8 contains the first <=4096 bytes of the body, decoded
 *     as UTF-8 (lossy is acceptable for binary heads).
 *   - Pre-aborted AbortSignal → rejects with AbortError BEFORE any DB or
 *     ObjectStore I/O.
 *
 * Public signature under test:
 *
 *   getTurnRawMetadata(
 *     turnId: string,
 *     options?: { signal?: AbortSignal },
 *   ): Promise<{
 *     content_hash: string;
 *     bytes_total: number;
 *     content_type: "application/json" | "application/octet-stream";
 *     head_sample_utf8: string;
 *   }>;
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
  // The implementer must export getTurnRawMetadata + LocalObjectStore
  // from the package's root barrel. The implementer is also responsible
  // for wiring getTurnRawMetadata to use a default LocalObjectStore
  // rooted at process.env.RECONDO_DATA_DIR (or equivalent).
  getTurnRawMetadata,
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
             'systhash-rm', 0, 0, 0, 0, 0, '')`,
    [id, now],
  );
  seededIds.sessionIds.push(id);
  return id;
}

async function seedTurn(opts: {
  sessionId: string;
  body: Buffer;
  kind?: "req";
}): Promise<{ turnId: string; hash: string; bytesTotal: number }> {
  const pool = getPool();
  const turnId = randomUUID();
  const now = new Date().toISOString();
  const { hash, ref } = seedObject(opts.kind ?? "req", opts.body);
  // Response side is irrelevant to getTurnRawMetadata for the request
  // path, but the column is NOT NULL — set a stable sentinel value.
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
  dataDir = mkdtempSync(join(tmpdir(), "recondo-data-rm-"));
  // Tell the implementation where the local object store lives. The
  // implementer may read this env var (or accept an injection); either
  // way, this is the contract we test against.
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

describe("getTurnRawMetadata — D-RM1 end-to-end happy path", () => {
  it("returns content_hash, bytes_total, content_type, head_sample_utf8 from the real row + body", async () => {
    const sessionId = await seedSession();
    const body = Buffer.from('{"hello":"world"}', "utf8");
    const { turnId, hash, bytesTotal } = await seedTurn({ sessionId, body });

    const meta = await getTurnRawMetadata(turnId);
    expect(meta.content_hash).toBe(hash);
    expect(meta.bytes_total).toBe(bytesTotal);
    // 64-char lowercase hex
    expect(meta.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.content_type).toBe("application/json");
    expect(typeof meta.head_sample_utf8).toBe("string");
  });
});

describe("getTurnRawMetadata — D-RM2 head_sample_utf8 is the actual body head", () => {
  it("contains the first bytes of the seeded body", async () => {
    const sessionId = await seedSession();
    const body = Buffer.from('{"hello":"world"}', "utf8");
    const { turnId } = await seedTurn({ sessionId, body });

    const meta = await getTurnRawMetadata(turnId);
    expect(meta.head_sample_utf8).toContain('"hello":"world"');
  });

  it("caps head_sample_utf8 at <= 4096 bytes for large bodies", async () => {
    const sessionId = await seedSession();
    const big = Buffer.from(
      "{" + '"x":"' + "a".repeat(8000) + '"}' /* > 4096 bytes */,
      "utf8",
    );
    const { turnId } = await seedTurn({ sessionId, body: big });

    const meta = await getTurnRawMetadata(turnId);
    // UTF-8 byte budget; allow a small variance for multi-byte boundaries
    // but enforce the spec bound.
    expect(Buffer.byteLength(meta.head_sample_utf8, "utf8")).toBeLessThanOrEqual(4096);
    // And the head must START with the body's leading bytes.
    expect(meta.head_sample_utf8.startsWith('{"x":"aaaaaaaaaa')).toBe(true);
  });
});

describe("getTurnRawMetadata — D-RM3 content_type sniff", () => {
  it("returns 'application/json' for bodies starting with '{'", async () => {
    const sessionId = await seedSession();
    const { turnId } = await seedTurn({
      sessionId,
      body: Buffer.from('{"k":1}', "utf8"),
    });
    const meta = await getTurnRawMetadata(turnId);
    expect(meta.content_type).toBe("application/json");
  });

  it("returns 'application/json' for bodies starting with '[' (array root)", async () => {
    const sessionId = await seedSession();
    const { turnId } = await seedTurn({
      sessionId,
      body: Buffer.from("[1,2,3]", "utf8"),
    });
    const meta = await getTurnRawMetadata(turnId);
    expect(meta.content_type).toBe("application/json");
  });

  it("returns 'application/json' when leading whitespace precedes '{'", async () => {
    const sessionId = await seedSession();
    const { turnId } = await seedTurn({
      sessionId,
      body: Buffer.from("  \n\t{}", "utf8"),
    });
    const meta = await getTurnRawMetadata(turnId);
    expect(meta.content_type).toBe("application/json");
  });

  it("returns 'application/octet-stream' for non-JSON binary bodies", async () => {
    const sessionId = await seedSession();
    const { turnId } = await seedTurn({
      sessionId,
      body: Buffer.from([0x62, 0x69, 0x6e, 0x00, 0x01, 0x02, 0xff]), // "bin\0\x01\x02\xff"
    });
    const meta = await getTurnRawMetadata(turnId);
    expect(meta.content_type).toBe("application/octet-stream");
  });

  it("returns 'application/octet-stream' for plain-text bodies (not '{' or '[')", async () => {
    const sessionId = await seedSession();
    const { turnId } = await seedTurn({
      sessionId,
      body: Buffer.from("hello world", "utf8"),
    });
    const meta = await getTurnRawMetadata(turnId);
    // No "default to application/json" — text is octet-stream unless it
    // looks structurally like JSON.
    expect(meta.content_type).toBe("application/octet-stream");
  });
});

describe("getTurnRawMetadata — D-RM4 pre-aborted signal", () => {
  it("rejects with AbortError BEFORE any DB query is issued", async () => {
    const sessionId = await seedSession();
    const { turnId } = await seedTurn({
      sessionId,
      body: Buffer.from('{"never":"read"}', "utf8"),
    });

    // Spy on the pool's query method (configurable: instance method on a
    // class). If the abort guard fires first, query MUST NOT be called.
    const pool = getPool();
    const querySpy = vi.spyOn(pool, "query");

    const ctrl = new AbortController();
    ctrl.abort();

    let caught: unknown = null;
    try {
      await getTurnRawMetadata(turnId, { signal: ctrl.signal });
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect((caught as Error).name).toBe("AbortError");
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("rejects with AbortError even when turnId points at a non-existent row (no I/O leaks)", async () => {
    // If the abort check is correctly the FIRST line, the function
    // never reaches the DB lookup nor the ObjectStore read — so it
    // returns AbortError, NOT a "turn not found" error and NOT an
    // ENOENT from the missing object file.
    const ctrl = new AbortController();
    ctrl.abort();

    let caught: unknown = null;
    try {
      await getTurnRawMetadata("00000000-0000-0000-0000-000000000000", {
        signal: ctrl.signal,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect((caught as Error).name).toBe("AbortError");
  });
});
