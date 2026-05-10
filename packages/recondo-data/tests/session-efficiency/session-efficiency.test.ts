/**
 * Chunk 5, T7: sessionEfficiency — D-SE1..9.
 *
 * Drives the public exported function:
 *
 *   export interface PercentileSummary {
 *     p50: number;
 *     p99: number;
 *     mean: number;
 *   }
 *
 *   export interface SessionEfficiency {
 *     session_id: string;
 *     cache_hit_rate: number;            // 0..1
 *     prompt_token_reuse_ratio: number;  // 0..1
 *     tokens_per_turn: PercentileSummary;
 *     redundant_tool_call_count: number;
 *     ttft_ms: PercentileSummary;
 *   }
 *
 *   export function sessionEfficiency(
 *     sessionId: string,
 *     options?: { signal?: AbortSignal },
 *   ): Promise<SessionEfficiency>;
 *
 * Decisions baked into these tests (must match the implementation):
 *
 *   - SCALAR return (Promise<SessionEfficiency>), NOT AsyncIterable
 *     (per orchestration C7 D-CT-SCALAR — single-row aggregate).
 *
 *   - ALL metrics computed in ONE SQL round-trip (a single pool.query
 *     call). D-SE6 verifies via `vi.spyOn(pool, "query")`. The query may
 *     use CTEs / sub-selects / LATERAL joins, but exactly ONE round-trip.
 *
 *   - cache_hit_rate = SUM(cache_read_tokens) / NULLIF(SUM(input_tokens), 0)
 *     coerced to 0 when denominator is zero (empty session) — never NaN.
 *     Right-column names: `cache_read_tokens` and `input_tokens` (NOT
 *     `cache_read_input_tokens`, which does NOT exist).
 *
 *   - prompt_token_reuse_ratio = (turns whose md5(user_request_text)
 *     appears in MORE than one turn within the session) / total turns.
 *     md5 is computed on-the-fly via SQL md5(); there is NO `prompt_hash`
 *     column. D-SE2 seeds 10 turns total — 3 share a prompt, 7 distinct;
 *     ratio = 3/10 = 0.3.
 *
 *   - tokens_per_turn = { p50, p99, mean } over (input_tokens +
 *     output_tokens), via percentile_disc(0.50/0.99) WITHIN GROUP and
 *     AVG(...). percentile_disc on tiny samples returns p99 = max value
 *     — D-SE9 enforces this disclosure in the docstring so callers are
 *     not surprised.
 *
 *   - redundant_tool_call_count = SUM over (tool_name, input_hash) groups
 *     with count > 1 of (count - 1). Right-column names: `tool_name`,
 *     `input_hash` (NOT `args_hash`, which does NOT exist).
 *
 *   - ttft_ms = { p50, p99, mean } over `ttfb_ms` (NOT NULL filter —
 *     ignore NULL values for percentile/mean). Right-column name:
 *     `ttfb_ms` (NOT `time_to_first_token_ms`, which does NOT exist).
 *
 *   - Empty session (no turns) returns ALL ZEROS — no NaN, no
 *     division-by-zero, no throw. D-SE7.
 *
 *   - Pre-aborted signal → AbortError BEFORE the single pool.query.
 *     D-SE8.
 *
 * Implementer file expectation: source lives at
 *   packages/recondo-data/src/session-efficiency.ts
 * The D-SE9 docstring assertion globs src/**\/*.ts and asserts whichever
 * file declares `export function sessionEfficiency`.
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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  closePool,
  getPool,
  // The implementer must export sessionEfficiency from the package's root
  // barrel. It does NOT exist yet — these imports are expected to fail at
  // runtime until the implementer creates
  // packages/recondo-data/src/session-efficiency.ts and re-exports it.
  sessionEfficiency,
} from "../../src/index.js";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
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
             'systhash-se', 0, 0, 0, 0, 0, '')`,
    [id, now],
  );
  seededIds.sessionIds.push(id);
  return id;
}

interface SeedTurnOpts {
  sessionId: string;
  sequenceNum: number;
  timestamp?: string;
  userRequestText?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  ttfbMs?: number | null;
}

/**
 * Seed a single turn. Schema-reality columns ONLY:
 *   id, session_id, sequence_num, timestamp, request_hash, response_hash,
 *   model, provider, input_tokens, output_tokens, cache_read_tokens,
 *   cache_creation_tokens, stop_reason, created_at, retry_count,
 *   tool_call_count, thinking_tokens, user_request_text, ttfb_ms.
 *
 * NOTE: `cache_read_tokens` (NOT `cache_read_input_tokens`) and
 * `ttfb_ms` (NOT `time_to_first_token_ms`) — these are the right column
 * names. Using a typo here would surface as an INSERT error and catch
 * the implementer wiring an incorrect SQL identifier.
 */
async function seedTurn(opts: SeedTurnOpts): Promise<string> {
  const pool = getPool();
  const turnId = randomUUID();
  const ts = opts.timestamp ?? new Date().toISOString();
  const requestHash = sha256Hex(`req:${turnId}`);
  const responseHash = sha256Hex(`resp:${turnId}`);
  await pool.query(
    `INSERT INTO turns (id, session_id, sequence_num, timestamp,
                        request_hash, response_hash,
                        model, provider,
                        input_tokens, output_tokens, cache_read_tokens,
                        cache_creation_tokens, stop_reason, created_at,
                        retry_count, tool_call_count, thinking_tokens,
                        user_request_text, ttfb_ms)
     VALUES ($1, $2, $3, $4, $5, $6,
             'claude-sonnet-4-20250514', 'anthropic',
             $7, $8, $9,
             0, 'end_turn', $4,
             0, 0, 0,
             $10, $11)`,
    [
      turnId,
      opts.sessionId,
      opts.sequenceNum,
      ts,
      requestHash,
      responseHash,
      opts.inputTokens ?? 0,
      opts.outputTokens ?? 0,
      opts.cacheReadTokens ?? 0,
      opts.userRequestText === undefined ? null : opts.userRequestText,
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
  toolInput?: string;
}

/**
 * Seed a tool_calls row using right-column names: `tool_name` (NOT
 * `name`), `input_hash` (NOT `args_hash`), `turn_id` (FK to turns,
 * NOT NULL). Required NOT-NULL columns from 001_core-tables.sql:
 *   id, turn_id, tool_name, tool_input. We supply duration_ms + status
 * for completeness even though they are nullable.
 */
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
      opts.toolInput ?? "{}",
      opts.inputHash,
      opts.sequenceNum ?? 0,
      opts.durationMs ?? 50,
      opts.status ?? "success",
    ],
  );
  seededIds.toolCallIds.push(id);
  return id;
}

beforeAll(async () => {
  getPool();
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// D-SE1 — cache_hit_rate = sum(cache_read_tokens) / sum(input_tokens).
// Seed 2 turns: turn1 input=600 cache=420, turn2 input=400 cache=280.
// Sum(cache)=700, Sum(input)=1000 → ratio = 0.7.
// ---------------------------------------------------------------------------
describe("sessionEfficiency — D-SE1 cache_hit_rate", () => {
  it("computes SUM(cache_read_tokens) / SUM(input_tokens) over the session", async () => {
    const sessionId = await seedSession();
    await seedTurn({
      sessionId,
      sequenceNum: 1,
      inputTokens: 600,
      cacheReadTokens: 420,
    });
    await seedTurn({
      sessionId,
      sequenceNum: 2,
      inputTokens: 400,
      cacheReadTokens: 280,
    });

    const result = await sessionEfficiency(sessionId);

    expect(result.session_id).toBe(sessionId);
    // 700 / 1000 = 0.7 — float-tolerant comparison.
    expect(Math.abs(result.cache_hit_rate - 0.7)).toBeLessThan(1e-9);
  });
});

// ---------------------------------------------------------------------------
// D-SE2 — prompt_token_reuse_ratio.
// Seed 10 turns: 3 share user_request_text="prompt-A"; 7 distinct prompts.
// 3 of 10 are in a "shared" group (count > 1). Ratio = 3/10 = 0.3.
// ---------------------------------------------------------------------------
describe("sessionEfficiency — D-SE2 prompt_token_reuse_ratio", () => {
  it("counts turns whose md5(user_request_text) appears in >1 turn / total turns", async () => {
    const sessionId = await seedSession();
    // 3 turns with the SAME prompt — these are the "shared" group.
    for (let i = 1; i <= 3; i += 1) {
      await seedTurn({
        sessionId,
        sequenceNum: i,
        userRequestText: "prompt-A",
        inputTokens: 1,
        outputTokens: 1,
      });
    }
    // 7 turns with 7 DISTINCT prompts — none of these are reused.
    for (let i = 4; i <= 10; i += 1) {
      await seedTurn({
        sessionId,
        sequenceNum: i,
        userRequestText: `unique-prompt-${i}`,
        inputTokens: 1,
        outputTokens: 1,
      });
    }

    const result = await sessionEfficiency(sessionId);

    // 3 turns in shared groups / 10 total turns = 0.3.
    expect(Math.abs(result.prompt_token_reuse_ratio - 0.3)).toBeLessThan(1e-9);
  });
});

// ---------------------------------------------------------------------------
// D-SE3 — tokens_per_turn returns {p50, p99, mean}.
// Seed 5 turns with input+output totals: [10, 20, 30, 40, 50].
// percentile_disc(0.50) = 30; percentile_disc(0.99) = 50; mean = 30.
// ---------------------------------------------------------------------------
describe("sessionEfficiency — D-SE3 tokens_per_turn percentile summary", () => {
  it("computes p50, p99, mean over (input_tokens + output_tokens) per turn", async () => {
    const sessionId = await seedSession();
    // Totals = [10, 20, 30, 40, 50]. Split between input + output is
    // arbitrary as long as the SUM matches what we're asserting on.
    const totals: Array<[number, number]> = [
      [4, 6],   // 10
      [8, 12],  // 20
      [15, 15], // 30
      [20, 20], // 40
      [25, 25], // 50
    ];
    for (let i = 0; i < totals.length; i += 1) {
      const [input, output] = totals[i];
      await seedTurn({
        sessionId,
        sequenceNum: i + 1,
        inputTokens: input,
        outputTokens: output,
      });
    }

    const result = await sessionEfficiency(sessionId);

    // percentile_disc(0.50) over [10,20,30,40,50] = 30.
    expect(result.tokens_per_turn.p50).toBe(30);
    // percentile_disc(0.99) over n=5 = max = 50 (tiny-sample semantic).
    expect(result.tokens_per_turn.p99).toBe(50);
    // AVG = 150 / 5 = 30.
    expect(Math.abs(result.tokens_per_turn.mean - 30)).toBeLessThan(1e-9);
  });
});

// ---------------------------------------------------------------------------
// D-SE4 — redundant_tool_call_count.
// Seed tool_calls in a session:
//   - 3 calls with (tool_name="Bash", input_hash="abc")
//   - 1 call  with (tool_name="Bash", input_hash="def")
//   - 2 calls with (tool_name="Read", input_hash="ghi")
//   - 1 call  with (tool_name="Write", input_hash="jkl")
// Group counts: ("Bash","abc")=3 → +2; ("Bash","def")=1 → +0;
//               ("Read","ghi")=2 → +1; ("Write","jkl")=1 → +0.
// Total = 3.
// ---------------------------------------------------------------------------
describe("sessionEfficiency — D-SE4 redundant_tool_call_count", () => {
  it("counts (count - 1) per (tool_name, input_hash) group with count > 1", async () => {
    const sessionId = await seedSession();
    const turnId = await seedTurn({
      sessionId,
      sequenceNum: 1,
      inputTokens: 1,
      outputTokens: 1,
    });
    // 3 x (Bash, abc) → +2
    for (let i = 0; i < 3; i += 1) {
      await seedToolCall({
        turnId,
        toolName: "Bash",
        inputHash: "abc",
        sequenceNum: i,
      });
    }
    // 1 x (Bash, def) → +0
    await seedToolCall({
      turnId,
      toolName: "Bash",
      inputHash: "def",
      sequenceNum: 3,
    });
    // 2 x (Read, ghi) → +1
    for (let i = 0; i < 2; i += 1) {
      await seedToolCall({
        turnId,
        toolName: "Read",
        inputHash: "ghi",
        sequenceNum: 4 + i,
      });
    }
    // 1 x (Write, jkl) → +0
    await seedToolCall({
      turnId,
      toolName: "Write",
      inputHash: "jkl",
      sequenceNum: 6,
    });

    const result = await sessionEfficiency(sessionId);
    // 2 (from Bash/abc) + 1 (from Read/ghi) = 3.
    expect(result.redundant_tool_call_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// D-SE5 — ttft_ms returns {p50, p99, mean} over ttfb_ms.
// Seed 5 turns with ttfb_ms = [100, 200, 300, 400, 500].
// p50 = 300, p99 = 500, mean = 300.
// ---------------------------------------------------------------------------
describe("sessionEfficiency — D-SE5 ttft_ms percentile summary", () => {
  it("computes p50, p99, mean over ttfb_ms (right column name)", async () => {
    const sessionId = await seedSession();
    const ttfbValues = [100, 200, 300, 400, 500];
    for (let i = 0; i < ttfbValues.length; i += 1) {
      await seedTurn({
        sessionId,
        sequenceNum: i + 1,
        inputTokens: 1,
        outputTokens: 1,
        ttfbMs: ttfbValues[i],
      });
    }

    const result = await sessionEfficiency(sessionId);

    expect(result.ttft_ms.p50).toBe(300);
    expect(result.ttft_ms.p99).toBe(500);
    expect(Math.abs(result.ttft_ms.mean - 300)).toBeLessThan(1e-9);
  });
});

// ---------------------------------------------------------------------------
// D-SE6 — ONE SQL round-trip.
// vi.spyOn(pool, "query") — after calling sessionEfficiency, assert spy
// was called exactly ONCE. The query may use CTEs / sub-selects / LATERAL
// joins, but exactly one round-trip.
// ---------------------------------------------------------------------------
describe("sessionEfficiency — D-SE6 single SQL round-trip", () => {
  it("invokes pool.query exactly ONCE for the full aggregate", async () => {
    const sessionId = await seedSession();
    // Seed a non-trivial session: 3 turns + 2 tool calls so the query has
    // real work to do across both the turns and tool_calls aggregations.
    const turn1 = await seedTurn({
      sessionId,
      sequenceNum: 1,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 30,
      userRequestText: "se6-prompt",
      ttfbMs: 200,
    });
    await seedTurn({
      sessionId,
      sequenceNum: 2,
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 70,
      userRequestText: "se6-prompt",
      ttfbMs: 300,
    });
    await seedTurn({
      sessionId,
      sequenceNum: 3,
      inputTokens: 50,
      outputTokens: 25,
      cacheReadTokens: 10,
      userRequestText: "se6-other",
      ttfbMs: 150,
    });
    await seedToolCall({
      turnId: turn1,
      toolName: "Bash",
      inputHash: "h1",
      sequenceNum: 0,
    });
    await seedToolCall({
      turnId: turn1,
      toolName: "Bash",
      inputHash: "h1",
      sequenceNum: 1,
    });

    const pool = getPool();
    const querySpy = vi.spyOn(pool, "query");

    const result = await sessionEfficiency(sessionId);
    // Sanity check: result is well-formed.
    expect(result.session_id).toBe(sessionId);

    // Exactly one round-trip — no chatty implementations.
    expect(querySpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// D-SE7 — Empty session (zero turns) returns ALL ZEROS.
// No NaN. No throw. No division-by-zero artifacts.
// ---------------------------------------------------------------------------
describe("sessionEfficiency — D-SE7 empty session returns all zeros", () => {
  it("returns zeros for every numeric field when the session has no turns", async () => {
    const sessionId = await seedSession();

    const result = await sessionEfficiency(sessionId);

    expect(result.session_id).toBe(sessionId);

    // No NaNs anywhere.
    expect(Number.isNaN(result.cache_hit_rate)).toBe(false);
    expect(Number.isNaN(result.prompt_token_reuse_ratio)).toBe(false);
    expect(Number.isNaN(result.tokens_per_turn.p50)).toBe(false);
    expect(Number.isNaN(result.tokens_per_turn.p99)).toBe(false);
    expect(Number.isNaN(result.tokens_per_turn.mean)).toBe(false);
    expect(Number.isNaN(result.ttft_ms.p50)).toBe(false);
    expect(Number.isNaN(result.ttft_ms.p99)).toBe(false);
    expect(Number.isNaN(result.ttft_ms.mean)).toBe(false);

    // All zeros.
    expect(result.cache_hit_rate).toBe(0);
    expect(result.prompt_token_reuse_ratio).toBe(0);
    expect(result.redundant_tool_call_count).toBe(0);
    expect(result.tokens_per_turn.p50).toBe(0);
    expect(result.tokens_per_turn.p99).toBe(0);
    expect(result.tokens_per_turn.mean).toBe(0);
    expect(result.ttft_ms.p50).toBe(0);
    expect(result.ttft_ms.p99).toBe(0);
    expect(result.ttft_ms.mean).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D-SE8 — Pre-aborted signal → AbortError BEFORE pool.query.
// Spy on pool.query, abort BEFORE calling sessionEfficiency, assert spy
// was called ZERO times AND the function rejected with AbortError.
// ---------------------------------------------------------------------------
describe("sessionEfficiency — D-SE8 pre-aborted signal", () => {
  it("rejects with AbortError BEFORE any pool.query call", async () => {
    const sessionId = await seedSession();
    // Seed a turn so there'd be something to query if the abort were
    // ignored — catches an implementer that runs the query anyway.
    await seedTurn({
      sessionId,
      sequenceNum: 1,
      inputTokens: 1,
      outputTokens: 1,
    });

    const pool = getPool();
    const querySpy = vi.spyOn(pool, "query");

    const ctrl = new AbortController();
    ctrl.abort();

    let caught: unknown = null;
    try {
      await sessionEfficiency(sessionId, { signal: ctrl.signal });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect((caught as Error).name).toBe("AbortError");
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("rejects with AbortError even when the session id is bogus (no I/O leaks)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    const pool = getPool();
    const querySpy = vi.spyOn(pool, "query");

    let caught: unknown = null;
    try {
      await sessionEfficiency("00000000-0000-0000-0000-000000000000", {
        signal: ctrl.signal,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect((caught as Error).name).toBe("AbortError");
    expect(querySpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// D-SE9 — Function header documents the percentile_disc tiny-sample
// semantic: callers should not be surprised by p99 = max for n=3 (or
// other small samples). Static assertion against the source file
// declaring `export function sessionEfficiency`.
// ---------------------------------------------------------------------------
describe("sessionEfficiency — D-SE9 docstring documents percentile_disc tiny-sample semantic", () => {
  function findSourceFile(root: string): string | null {
    const stack: string[] = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(dir, entry);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!full.endsWith(".ts")) continue;
        const text = readFileSync(full, "utf8");
        if (/export\s+function\s+sessionEfficiency\b/.test(text)) {
          return full;
        }
      }
    }
    return null;
  }

  it("the source file's header mentions percentile_disc AND the tiny-sample disclosure", () => {
    const srcRoot = join(__dirname, "..", "..", "src");
    const file = findSourceFile(srcRoot);
    expect(
      file,
      "expected a src/**/*.ts file declaring `export function sessionEfficiency`",
    ).not.toBeNull();

    const text = readFileSync(file as string, "utf8");
    const idx = text.search(/export\s+function\s+sessionEfficiency\b/);
    expect(idx).toBeGreaterThan(0);
    const header = text.slice(0, idx);

    // The header MUST mention `percentile_disc`.
    expect(
      /percentile_disc/i.test(header),
      "header must mention `percentile_disc` so callers understand the percentile " +
        "function in use",
    ).toBe(true);

    // AND must disclose the tiny-sample semantic — at least ONE of the
    // following phrases must appear so callers are not surprised when
    // p99 = max on small samples (e.g. n = 3).
    const disclosurePatterns: RegExp[] = [
      /tiny/i,
      /small\s+sample/i,
      /p99\s*=\s*max/i,
      /discrete\s+percentile/i,
    ];
    const hasDisclosure = disclosurePatterns.some((re) => re.test(header));
    expect(
      hasDisclosure,
      "header must disclose the percentile_disc tiny-sample semantic via at " +
        "least one of: 'tiny', 'small sample', 'p99 = max', 'discrete percentile'",
    ).toBe(true);
  });
});
