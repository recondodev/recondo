/**
 * Chunk 7, T11: end-to-end sweep — D-E2E.
 *
 * Seeds a real session in dev-infra Postgres + writes a real gzipped raw
 * body to a tmpdir-rooted local object store, then runs ALL SEVEN C1..C6
 * operations against the seeded fixture and asserts the headline behaviors:
 *
 *   D-E2E-1  getTurnRawMetadata(T0).bytes_total === 50_000
 *   D-E2E-2  getTurnRawChunk(T0, 0, 32_768) returns 32_768 bytes;
 *            second chunk getTurnRawChunk(T0, 32_768, 32_768) returns the
 *            remaining 17_232 bytes; second chunk's next_offset === null.
 *   D-E2E-3  compareTurns([T0..T4]) yields 6 rows (default aspects); the
 *            "cost" delta is non-zero (seeded with distinct cost_usd values).
 *   D-E2E-4  findSimilarPrompts(T0) (collected via `for await`) includes
 *            T2 (shared "duplicate-prompt") and EXCLUDES T0 itself.
 *   D-E2E-5  relatedTurns(T0, "same_session") yields the other 4 turns
 *            (T1..T4) and excludes T0 itself.
 *   D-E2E-6  sessionEfficiency(session.id):
 *              prompt_token_reuse_ratio ≈ 0.4   (2 of 5 turns share a prompt)
 *              redundant_tool_call_count === 2  (3 calls of same
 *                                                (tool_name, input_hash) →
 *                                                 count - 1 = 2 redundant)
 *   D-E2E-7  toolCallStats({ period: "24h", group_by: "tool_name" }) yields
 *            at least one row whose group_key matches a seeded tool_name.
 *
 * All 7 ops run against the SAME seeded session — so a regression in any
 * one op surfaces as a single, clearly-attributable failure.
 *
 * Schema-reality column names ONLY (right-column names — see CLAUDE.md):
 *   turns.user_request_text, turns.cost_usd, turns.input_tokens,
 *   turns.output_tokens, turns.cache_read_tokens, turns.timestamp,
 *   turns.req_bytes_size, turns.req_bytes_ref, turns.request_hash,
 *   tool_calls.tool_name, tool_calls.input_hash, tool_calls.duration_ms.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import {
  closePool,
  compareTurns,
  findSimilarPrompts,
  getPool,
  getTurnRawChunk,
  getTurnRawMetadata,
  relatedTurns,
  sessionEfficiency,
  toolCallStats,
} from "../../src/index.js";

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

const seededIds: {
  sessionIds: string[];
  turnIds: string[];
  toolCallIds: string[];
} = {
  sessionIds: [],
  turnIds: [],
  toolCallIds: [],
};

let dataDir: string;

interface SeedTurnOpts {
  sessionId: string;
  sequenceNum: number;
  timestamp?: string;
  userRequestText?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  ttfbMs?: number | null;
  responseText?: string | null;
  costUsd?: number | null;
  model?: string;
  /** When set, seed the request body as a gzipped object under
   * `<dataDir>/objects/req/<hash>.json.gz`, hash the plaintext, and write
   * the right values into turns.request_hash / req_bytes_size / req_bytes_ref. */
  rawBody?: Buffer;
}

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
             'systhash-c7e2e', 0, 0, 0, 0, 0, '')`,
    [id, now],
  );
  seededIds.sessionIds.push(id);
  return id;
}

async function seedTurn(opts: SeedTurnOpts): Promise<string> {
  const pool = getPool();
  const turnId = randomUUID();
  const ts = opts.timestamp ?? new Date().toISOString();

  // Default request/response hashes are SHA-256 of synthetic strings so
  // tests don't fight the hash format. When opts.rawBody is set we use
  // SHA-256(plaintext) — the content-addressable scheme used by the
  // gateway and consumed by getTurnRawMetadata / getTurnRawChunk.
  let requestHash: string;
  let reqBytesSize = 0;
  let reqBytesRef: string | null = null;
  if (opts.rawBody) {
    requestHash = sha256Hex(opts.rawBody);
    reqBytesSize = opts.rawBody.length;
    reqBytesRef = `req/${requestHash}.json.gz`;
    const dir = join(dataDir, "objects", "req");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${requestHash}.json.gz`), gzipSync(opts.rawBody));
  } else {
    requestHash = sha256Hex(Buffer.from(`req:${turnId}`, "utf8"));
  }
  const responseHash = sha256Hex(Buffer.from(`resp:${turnId}`, "utf8"));

  await pool.query(
    `INSERT INTO turns (id, session_id, sequence_num, timestamp,
                        request_hash, response_hash,
                        req_bytes_size, req_bytes_ref,
                        model, provider,
                        input_tokens, output_tokens, cache_read_tokens,
                        cache_creation_tokens, stop_reason, created_at,
                        retry_count, tool_call_count, thinking_tokens,
                        user_request_text, response_text, cost_usd, ttfb_ms)
     VALUES ($1, $2, $3, $4, $5, $6,
             $7, $8,
             $9, 'anthropic',
             $10, $11, $12,
             0, 'end_turn', $4,
             0, 0, 0,
             $13, $14, $15, $16)`,
    [
      turnId,
      opts.sessionId,
      opts.sequenceNum,
      ts,
      requestHash,
      responseHash,
      reqBytesSize,
      reqBytesRef,
      opts.model ?? "claude-sonnet-4-20250514",
      opts.inputTokens ?? 0,
      opts.outputTokens ?? 0,
      opts.cacheReadTokens ?? 0,
      opts.userRequestText === undefined ? null : opts.userRequestText,
      opts.responseText ?? null,
      opts.costUsd ?? null,
      opts.ttfbMs === undefined ? null : opts.ttfbMs,
    ],
  );
  seededIds.turnIds.push(turnId);
  return turnId;
}

interface SeedToolCallOpts {
  turnId: string;
  toolName: string;
  inputHash: string;
  sequenceNum?: number;
  status?: string;
  durationMs?: number;
}

async function seedToolCall(opts: SeedToolCallOpts): Promise<string> {
  const pool = getPool();
  const id = randomUUID();
  await pool.query(
    `INSERT INTO tool_calls (id, turn_id, tool_name, tool_input, input_hash,
                             sequence_num, output, output_hash, duration_ms,
                             status)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, $7, $8)`,
    [
      id,
      opts.turnId,
      opts.toolName,
      "{}",
      opts.inputHash,
      opts.sequenceNum ?? 0,
      opts.durationMs ?? 50,
      opts.status ?? "success",
    ],
  );
  seededIds.toolCallIds.push(id);
  return id;
}

// ---------------------------------------------------------------------------
// Seeded ids — populated in beforeAll, read by every it().
// ---------------------------------------------------------------------------
let sessionId: string;
let turnIds: { t0: string; t1: string; t2: string; t3: string; t4: string };
const RAW_BODY_BYTES = 50_000;
let rawBody: Buffer;

beforeAll(async () => {
  // Tmpdir-rooted local object store. getTurnRawMetadata / getTurnRawChunk
  // read process.env.RECONDO_DATA_DIR lazily — setting it here (before any
  // ops are called) is sufficient.
  dataDir = mkdtempSync(join(tmpdir(), "recondo-data-c7-e2e-"));
  process.env.RECONDO_DATA_DIR = dataDir;

  // 50_000 bytes of arbitrary content — repeating ASCII so we can verify
  // chunk slicing returns the right region (unlike a single-byte fill, a
  // pattern lets a future regression in offset arithmetic surface).
  rawBody = Buffer.alloc(RAW_BODY_BYTES);
  for (let i = 0; i < RAW_BODY_BYTES; i++) {
    // Cycle through printable ASCII 0x20..0x7E (95 distinct values).
    rawBody[i] = 0x20 + (i % 95);
  }
  expect(rawBody.length).toBe(RAW_BODY_BYTES);

  sessionId = await seedSession();

  // Use timestamps within the past hour so toolCallStats period: "24h"
  // sees the seeded calls.
  const now = Date.now();
  const isoMinusMin = (mins: number) =>
    new Date(now - mins * 60_000).toISOString();

  // T0: duplicate-prompt; carries the 50_000-byte request body.
  const t0 = await seedTurn({
    sessionId,
    sequenceNum: 1,
    timestamp: isoMinusMin(50),
    userRequestText: "duplicate-prompt",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 30,
    costUsd: 0.001, // distinct cost — drives compareTurns "cost" delta > 0.
    rawBody,
  });
  // T1: unique prompt.
  const t1 = await seedTurn({
    sessionId,
    sequenceNum: 2,
    timestamp: isoMinusMin(40),
    userRequestText: "unique-prompt-1",
    inputTokens: 200,
    outputTokens: 100,
    cacheReadTokens: 50,
    costUsd: 0.002,
  });
  // T2: duplicate-prompt — matches T0.
  const t2 = await seedTurn({
    sessionId,
    sequenceNum: 3,
    timestamp: isoMinusMin(30),
    userRequestText: "duplicate-prompt",
    inputTokens: 150,
    outputTokens: 75,
    cacheReadTokens: 40,
    costUsd: 0.003,
  });
  // T3: unique prompt.
  const t3 = await seedTurn({
    sessionId,
    sequenceNum: 4,
    timestamp: isoMinusMin(20),
    userRequestText: "unique-prompt-3",
    inputTokens: 50,
    outputTokens: 25,
    cacheReadTokens: 10,
    costUsd: 0.004,
  });
  // T4: unique prompt.
  const t4 = await seedTurn({
    sessionId,
    sequenceNum: 5,
    timestamp: isoMinusMin(10),
    userRequestText: "unique-prompt-4",
    inputTokens: 80,
    outputTokens: 40,
    cacheReadTokens: 20,
    costUsd: 0.005,
  });

  turnIds = { t0, t1, t2, t3, t4 };

  // 3 redundant tool calls on T0: same (tool_name, input_hash) repeated 3x
  // → count - 1 = 2 redundant calls (the orchestration's expectation).
  // Plus 1 distinct (tool_name, input_hash) so the group set isn't trivial
  // — its count is 1 → 0 redundant from that group.
  await seedToolCall({
    turnId: t0,
    toolName: "Bash",
    inputHash: "redundant-hash",
    sequenceNum: 0,
  });
  await seedToolCall({
    turnId: t0,
    toolName: "Bash",
    inputHash: "redundant-hash",
    sequenceNum: 1,
  });
  await seedToolCall({
    turnId: t0,
    toolName: "Bash",
    inputHash: "redundant-hash",
    sequenceNum: 2,
  });
  await seedToolCall({
    turnId: t1,
    toolName: "Read",
    inputHash: "distinct-hash",
    sequenceNum: 0,
  });
});

afterAll(async () => {
  const pool = getPool();
  if (
    seededIds.toolCallIds.length > 0 ||
    seededIds.turnIds.length > 0 ||
    seededIds.sessionIds.length > 0
  ) {
    // The `prevent_turn_mutation` trigger blocks DELETE on `turns` unless
    // `recondo.gdpr_bypass` is set inside the current transaction. Use a
    // checked-out client so SET LOCAL stays scoped to BEGIN..COMMIT.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL recondo.gdpr_bypass = 'true'");
      if (seededIds.toolCallIds.length > 0) {
        await client.query(`DELETE FROM tool_calls WHERE id = ANY($1)`, [
          seededIds.toolCallIds,
        ]);
      }
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

// ---------------------------------------------------------------------------
// D-E2E-1: getTurnRawMetadata.bytes_total === 50_000
// ---------------------------------------------------------------------------
describe("C7 D-E2E-1 — getTurnRawMetadata reports the seeded body size", () => {
  it("returns bytes_total === 50000 for T0 and matches request_hash", async () => {
    const meta = await getTurnRawMetadata(turnIds.t0);
    expect(meta.bytes_total).toBe(RAW_BODY_BYTES);
    // content_hash echoes the `request_hash` column (SHA-256 of the body).
    expect(meta.content_hash).toBe(sha256Hex(rawBody));
    expect(meta.content_hash).toMatch(/^[0-9a-f]{64}$/);
    // Body starts with ' ' (0x20) — first non-whitespace lookahead skips
    // leading whitespace, so content_type is octet-stream (no `{` or `[`
    // ever appears in the leading position of our printable-ascii fill).
    expect(meta.content_type).toBe("application/octet-stream");
    // head_sample_utf8 is at most 4096 bytes by the documented contract.
    expect(meta.head_sample_utf8.length).toBeLessThanOrEqual(4096);
  });
});

// ---------------------------------------------------------------------------
// D-E2E-2: chunked reads cover the whole body, second chunk's next_offset
// === null. 32_768 + 17_232 = 50_000.
// ---------------------------------------------------------------------------
describe("C7 D-E2E-2 — getTurnRawChunk slices the body across two chunks", () => {
  it("first chunk returns 32_768 bytes; second returns the 17_232-byte tail; next_offset is null", async () => {
    const first = await getTurnRawChunk(turnIds.t0, 0, 32_768);
    expect(first.offset).toBe(0);
    expect(first.bytes.length).toBe(32_768);
    expect(first.next_offset).toBe(32_768);

    const second = await getTurnRawChunk(turnIds.t0, 32_768, 32_768);
    expect(second.offset).toBe(32_768);
    // 50_000 - 32_768 = 17_232 — the function returns the tail when the
    // request goes past EOF. Length cap is 32_768, so 17_232 is what we
    // get back.
    expect(second.bytes.length).toBe(17_232);
    expect(second.next_offset).toBeNull();

    // Sanity check: concatenating both chunks reproduces the seeded body.
    const reassembled = Buffer.concat([first.bytes, second.bytes]);
    expect(reassembled.length).toBe(RAW_BODY_BYTES);
    expect(reassembled.equals(rawBody)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D-E2E-3: compareTurns([T0..T4]) → 6 default-aspect rows; cost delta != 0.
// ---------------------------------------------------------------------------
describe("C7 D-E2E-3 — compareTurns returns 6 default-aspect rows with non-zero cost delta", () => {
  it("default aspects produce exactly 6 rows; cost delta = max(cost) - min(cost) > 0", async () => {
    const ids = [turnIds.t0, turnIds.t1, turnIds.t2, turnIds.t3, turnIds.t4];
    const result = await compareTurns(ids);

    expect(result.turn_ids).toEqual(ids);
    expect(result.rows).toHaveLength(6);
    const aspectsSeen = result.rows.map((r) => r.aspect);
    expect(aspectsSeen).toEqual([
      "prompt",
      "response",
      "tools",
      "cost",
      "tokens",
      "model",
    ]);

    const costRow = result.rows.find((r) => r.aspect === "cost");
    expect(costRow).toBeDefined();
    // 0.005 - 0.001 = 0.004 — float-tolerant comparison.
    expect(costRow!.delta).not.toBeNull();
    expect(Math.abs((costRow!.delta as number) - 0.004)).toBeLessThan(1e-9);

    // Sanity check: each turn id appears as a key in `values`.
    for (const id of ids) {
      expect(Object.prototype.hasOwnProperty.call(costRow!.values, id)).toBe(
        true,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// D-E2E-4: findSimilarPrompts(T0) includes T2 (shared prompt), excludes T0.
// ---------------------------------------------------------------------------
describe("C7 D-E2E-4 — findSimilarPrompts surfaces the duplicate-prompt peer", () => {
  it("yields T2 (shared 'duplicate-prompt') and excludes T0 itself", async () => {
    const matches: { turn_id: string; user_request_text: string }[] = [];
    for await (const m of findSimilarPrompts(turnIds.t0)) {
      matches.push(m);
    }
    const matchIds = new Set(matches.map((m) => m.turn_id));
    expect(matchIds.has(turnIds.t2)).toBe(true);
    expect(matchIds.has(turnIds.t0)).toBe(false);
    // None of the unique-prompt turns should appear (their hashes do not
    // match T0's md5).
    expect(matchIds.has(turnIds.t1)).toBe(false);
    expect(matchIds.has(turnIds.t3)).toBe(false);
    expect(matchIds.has(turnIds.t4)).toBe(false);
    // Every yielded match has the same user_request_text as T0.
    for (const m of matches) {
      expect(m.user_request_text).toBe("duplicate-prompt");
    }
  });
});

// ---------------------------------------------------------------------------
// D-E2E-5: relatedTurns(T0, "same_session") yields the other 4 turns.
// ---------------------------------------------------------------------------
describe("C7 D-E2E-5 — relatedTurns same_session yields T1..T4", () => {
  it("returns the four other turns of the seeded session, excluding T0", async () => {
    const ids: string[] = [];
    for await (const r of relatedTurns(turnIds.t0, "same_session")) {
      ids.push(r.turn_id);
    }
    const set = new Set(ids);
    expect(set.size).toBe(4);
    expect(set.has(turnIds.t1)).toBe(true);
    expect(set.has(turnIds.t2)).toBe(true);
    expect(set.has(turnIds.t3)).toBe(true);
    expect(set.has(turnIds.t4)).toBe(true);
    expect(set.has(turnIds.t0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D-E2E-6: sessionEfficiency:
//   prompt_token_reuse_ratio ≈ 0.4    (2 of 5 turns share a prompt)
//   redundant_tool_call_count === 2   (3 calls of (Bash, redundant-hash) → 2)
// ---------------------------------------------------------------------------
describe("C7 D-E2E-6 — sessionEfficiency reflects the seeded reuse + redundancy", () => {
  it("prompt_token_reuse_ratio ≈ 0.4 and redundant_tool_call_count === 2", async () => {
    const eff = await sessionEfficiency(sessionId);
    expect(eff.session_id).toBe(sessionId);
    // 2 turns (T0, T2) share md5("duplicate-prompt"); 3 turns are unique.
    // Numerator = 2 (turns whose hash appears in >1 turn). Denominator = 5.
    // Ratio = 0.4.
    expect(Math.abs(eff.prompt_token_reuse_ratio - 0.4)).toBeLessThan(1e-9);
    // 3 calls of (Bash, "redundant-hash") → count - 1 = 2 redundant.
    // 1 call of (Read, "distinct-hash")  → count - 1 = 0.
    // Total = 2.
    expect(eff.redundant_tool_call_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// D-E2E-7: toolCallStats({ period: "24h", group_by: "tool_name" }) yields
// at least one row whose group_key matches a seeded tool_name.
//
// Note: this query is GLOBAL (all tool_calls across all sessions in the
// 24h window), not session-scoped. We assert the seeded groups APPEAR —
// other rows from concurrent dev-infra data are tolerated.
// ---------------------------------------------------------------------------
describe("C7 D-E2E-7 — toolCallStats includes seeded groups under period 24h", () => {
  it("yields rows that include the seeded tool_names", async () => {
    const rows: Array<{ group_key: string; total_calls: number }> = [];
    for await (const r of toolCallStats({
      group_by: "tool_name",
      period: "24h",
    })) {
      rows.push({ group_key: r.group_key, total_calls: r.total_calls });
    }
    // The full result spans every session's tool_calls in dev-infra in the
    // 24h window. Our seeded turns are all within the past hour, so the
    // 'Bash' and 'Read' groups MUST appear with at least our seeded counts.
    expect(rows.length).toBeGreaterThan(0);
    const byTool = new Map(rows.map((r) => [r.group_key, r.total_calls]));
    // 3 Bash calls + 1 Read call were seeded (other dev-infra fixtures may
    // contribute more, so we assert >= our seeded count).
    expect(byTool.has("Bash")).toBe(true);
    expect(byTool.get("Bash")!).toBeGreaterThanOrEqual(3);
    expect(byTool.has("Read")).toBe(true);
    expect(byTool.get("Read")!).toBeGreaterThanOrEqual(1);
  });
});
