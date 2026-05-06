/**
 * Chunk 2, T4: compareTurns — D-CT1..8.
 *
 * Drives the public exported function:
 *
 *   compareTurns(
 *     turn_ids: string[],
 *     options?: { aspects?: CompareAspect[]; signal?: AbortSignal },
 *   ): Promise<CompareTurnsResult>;
 *
 * Where:
 *
 *   type CompareAspect =
 *     "prompt" | "response" | "tools" | "cost" | "tokens" | "model";
 *
 *   interface CompareTurnsRow {
 *     aspect: CompareAspect;
 *     values: Record<string, unknown>; // keyed by turn_id
 *     delta: number | null;
 *   }
 *
 *   interface CompareTurnsResult {
 *     turn_ids: string[]; // echoed in caller-specified order
 *     rows: CompareTurnsRow[];
 *   }
 *
 * Decisions baked into these tests (must match the implementation):
 *   - Default `aspects` is ["prompt", "response", "tools", "cost", "tokens", "model"]
 *     (in that exact order). 6 rows.
 *   - The "tools" aspect's per-turn value is an array of tool names derived via
 *     LEFT JOIN tool_calls + array_agg. Turns with zero tool calls produce [].
 *   - Numeric aspects (cost, tokens) compute delta = max(values) - min(values).
 *     Text aspects (prompt, response, model) and the list aspect (tools) have
 *     delta === null.
 *   - The result preserves caller-specified turn_ids order (Object.keys of each
 *     `values` matches the caller's input array order).
 *   - Empty `turn_ids` array throws SYNCHRONOUSLY (no Promise returned).
 *   - Non-existent turn id throws (with the missing id in the message).
 *   - Pre-aborted signal → AbortError BEFORE any pool.query call.
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

import {
  closePool,
  getPool,
  // The implementer must export compareTurns from the package's root barrel.
  // It does NOT exist yet — this import is expected to fail at runtime until
  // the implementer creates packages/recondo-data/src/compare-turns.ts.
  compareTurns,
} from "../../src/index.js";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const seededIds: { sessionIds: string[]; turnIds: string[]; toolCallIds: string[] } = {
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
             'systhash-ct', 0, 0, 0, 0, 0, '')`,
    [id, now],
  );
  seededIds.sessionIds.push(id);
  return id;
}

interface SeedTurnOpts {
  sessionId: string;
  sequenceNum: number;
  timestamp?: string; // ISO 8601; default = now()
  userRequestText?: string;
  responseText?: string;
  model?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

async function seedTurn(opts: SeedTurnOpts): Promise<string> {
  const pool = getPool();
  const turnId = randomUUID();
  const ts = opts.timestamp ?? new Date().toISOString();
  // Real SHA-256 hex (not a fake placeholder) — schema-reality discipline.
  const requestHash = sha256Hex(`req:${turnId}`);
  const responseHash = sha256Hex(`resp:${turnId}`);
  await pool.query(
    `INSERT INTO turns (id, session_id, sequence_num, timestamp,
                        request_hash, response_hash,
                        model, provider,
                        input_tokens, output_tokens, cache_read_tokens,
                        cache_creation_tokens, stop_reason, created_at,
                        retry_count, tool_call_count, thinking_tokens,
                        user_request_text, response_text, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6,
             $7, 'anthropic',
             $8, $9, 0,
             0, 'end_turn', $4,
             0, 0, 0,
             $10, $11, $12)`,
    [
      turnId,
      opts.sessionId,
      opts.sequenceNum,
      ts,
      requestHash,
      responseHash,
      opts.model ?? "claude-sonnet-4-20250514",
      opts.inputTokens ?? 0,
      opts.outputTokens ?? 0,
      opts.userRequestText ?? null,
      opts.responseText ?? null,
      opts.costUsd ?? null,
    ],
  );
  seededIds.turnIds.push(turnId);
  return turnId;
}

interface SeedToolCallOpts {
  turnId: string;
  toolName: string;
  sequenceNum?: number;
  status?: string; // 'success' | 'error'
  durationMs?: number;
  toolInput?: string;
}

async function seedToolCall(opts: SeedToolCallOpts): Promise<string> {
  const pool = getPool();
  const id = randomUUID();
  const toolInput = opts.toolInput ?? '{"k":"v"}';
  const inputHash = sha256Hex(toolInput);
  await pool.query(
    `INSERT INTO tool_calls (id, turn_id, tool_name, tool_input, input_hash,
                             sequence_num, output, output_hash, duration_ms,
                             status)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, $7, $8)`,
    [
      id,
      opts.turnId,
      opts.toolName,
      toolInput,
      inputHash,
      opts.sequenceNum ?? 0,
      opts.durationMs ?? 50,
      opts.status ?? "success",
    ],
  );
  seededIds.toolCallIds.push(id);
  return id;
}

beforeAll(async () => {
  // Ensure pool is initialized; further setup is per-test.
  getPool();
});

afterAll(async () => {
  const pool = getPool();
  if (
    seededIds.toolCallIds.length > 0 ||
    seededIds.turnIds.length > 0 ||
    seededIds.sessionIds.length > 0
  ) {
    // The `prevent_turn_mutation` trigger (api/migrations/003) blocks DELETE
    // on turns unless `recondo.gdpr_bypass` is set inside the current
    // transaction. Use a checked-out client so SET LOCAL stays scoped to
    // the BEGIN..COMMIT block.
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
// D-CT1 — Default aspects covers all 6 in canonical order.
// ---------------------------------------------------------------------------
describe("compareTurns — D-CT1 default aspects", () => {
  it("returns 6 rows in order [prompt, response, tools, cost, tokens, model]", async () => {
    const sessionId = await seedSession();
    const t1 = await seedTurn({
      sessionId,
      sequenceNum: 1,
      userRequestText: "ask alpha",
      responseText: "answer alpha",
      model: "claude-sonnet-4-20250514",
      costUsd: 0.1,
      inputTokens: 100,
      outputTokens: 200,
    });
    const t2 = await seedTurn({
      sessionId,
      sequenceNum: 2,
      userRequestText: "ask beta",
      responseText: "answer beta",
      model: "claude-sonnet-4-20250514",
      costUsd: 0.2,
      inputTokens: 150,
      outputTokens: 250,
    });

    const result = await compareTurns([t1, t2]);
    expect(result.turn_ids).toEqual([t1, t2]);
    expect(result.rows).toHaveLength(6);
    expect(result.rows.map((r) => r.aspect)).toEqual([
      "prompt",
      "response",
      "tools",
      "cost",
      "tokens",
      "model",
    ]);
  });
});

// ---------------------------------------------------------------------------
// D-CT2 — Subset selection.
// ---------------------------------------------------------------------------
describe("compareTurns — D-CT2 aspect subset", () => {
  it("returns only the requested aspects when `aspects: ['cost']`", async () => {
    const sessionId = await seedSession();
    const t1 = await seedTurn({
      sessionId,
      sequenceNum: 1,
      costUsd: 0.5,
      inputTokens: 1,
      outputTokens: 1,
    });
    const t2 = await seedTurn({
      sessionId,
      sequenceNum: 2,
      costUsd: 1.0,
      inputTokens: 1,
      outputTokens: 1,
    });

    const result = await compareTurns([t1, t2], { aspects: ["cost"] });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].aspect).toBe("cost");
    // values keyed by turn_id, in input order.
    expect(Object.keys(result.rows[0].values)).toEqual([t1, t2]);
  });
});

// ---------------------------------------------------------------------------
// D-CT3 — Delta semantics.
// ---------------------------------------------------------------------------
describe("compareTurns — D-CT3 delta semantics", () => {
  it("numeric aspects compute delta = max - min; text/tools aspects → null", async () => {
    const sessionId = await seedSession();
    // turn A: cost $0.50, input=100, output=50
    // turn B: cost $0.25, input=200, output=100
    // → cost delta = 0.50 - 0.25 = 0.25
    // → tokens delta = (200+100) - (100+50) = 300 - 150 = 150
    //   (Implementer may choose total tokens OR a specific component; we
    //   accept delta === max - min over whatever scalar is chosen, but the
    //   helper KNOWS the aggregation: total = input + output. This test
    //   asserts the published behavior.)
    const tA = await seedTurn({
      sessionId,
      sequenceNum: 1,
      userRequestText: "alpha-prompt",
      responseText: "alpha-response",
      model: "model-A",
      costUsd: 0.5,
      inputTokens: 100,
      outputTokens: 50,
    });
    const tB = await seedTurn({
      sessionId,
      sequenceNum: 2,
      userRequestText: "beta-prompt",
      responseText: "beta-response",
      model: "model-B",
      costUsd: 0.25,
      inputTokens: 200,
      outputTokens: 100,
    });

    const result = await compareTurns([tA, tB]);
    const byAspect = new Map(result.rows.map((r) => [r.aspect, r]));

    const cost = byAspect.get("cost");
    expect(cost).toBeDefined();
    // 0.5 - 0.25 = 0.25 — float-tolerant comparison.
    expect(cost!.delta).not.toBeNull();
    expect(Math.abs((cost!.delta as number) - 0.25)).toBeLessThan(1e-9);

    const tokens = byAspect.get("tokens");
    expect(tokens).toBeDefined();
    expect(tokens!.delta).not.toBeNull();
    // delta must equal max - min over the per-turn scalar values the
    // implementer publishes via `values`. Pull both and recompute.
    const tokenScalars = Object.values(tokens!.values).map((v) => Number(v));
    const expectedTokensDelta =
      Math.max(...tokenScalars) - Math.min(...tokenScalars);
    expect(tokens!.delta).toBe(expectedTokensDelta);

    expect(byAspect.get("prompt")!.delta).toBeNull();
    expect(byAspect.get("response")!.delta).toBeNull();
    expect(byAspect.get("model")!.delta).toBeNull();
    expect(byAspect.get("tools")!.delta).toBeNull();
  });

  it("does NOT just hardcode delta=0 for cost (catches phantom-wiring)", async () => {
    const sessionId = await seedSession();
    const t1 = await seedTurn({
      sessionId,
      sequenceNum: 1,
      costUsd: 1.5,
      inputTokens: 1,
      outputTokens: 1,
    });
    const t2 = await seedTurn({
      sessionId,
      sequenceNum: 2,
      costUsd: 4.5,
      inputTokens: 1,
      outputTokens: 1,
    });
    const result = await compareTurns([t1, t2], { aspects: ["cost"] });
    // 4.5 - 1.5 = 3 — a non-zero delta proves the implementation actually
    // reads cost_usd from each row instead of hardcoding zero.
    expect(Math.abs((result.rows[0].delta as number) - 3.0)).toBeLessThan(1e-9);
  });
});

// ---------------------------------------------------------------------------
// D-CT4 — `tools` aspect derives names via JOIN tool_calls + array_agg.
// ---------------------------------------------------------------------------
describe("compareTurns — D-CT4 tools aspect via JOIN tool_calls", () => {
  it("returns array of tool names per turn; [] for turns with zero tool calls", async () => {
    const sessionId = await seedSession();
    const tWithTools = await seedTurn({
      sessionId,
      sequenceNum: 1,
      userRequestText: "with tools",
      inputTokens: 0,
      outputTokens: 0,
    });
    // Two tool calls on this turn — Bash (sequence 0) and Read (sequence 1).
    // The implementation may order array_agg by tool_calls.id, sequence_num,
    // or tool_name. We assert via SET equality (sorted) so any deterministic
    // ordering passes; the test fails only if the membership is wrong.
    await seedToolCall({
      turnId: tWithTools,
      toolName: "Bash",
      sequenceNum: 0,
    });
    await seedToolCall({
      turnId: tWithTools,
      toolName: "Read",
      sequenceNum: 1,
    });

    const tBare = await seedTurn({
      sessionId,
      sequenceNum: 2,
      userRequestText: "no tools",
      inputTokens: 0,
      outputTokens: 0,
    });

    const result = await compareTurns([tWithTools, tBare], {
      aspects: ["tools"],
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].aspect).toBe("tools");

    const valWith = result.rows[0].values[tWithTools];
    const valBare = result.rows[0].values[tBare];

    expect(Array.isArray(valWith)).toBe(true);
    expect(Array.isArray(valBare)).toBe(true);
    // Membership check — implementer chooses the in-array ordering.
    expect([...(valWith as string[])].sort()).toEqual(["Bash", "Read"]);
    expect(valBare).toEqual([]);

    // Tools aspect is non-numeric → delta must be null.
    expect(result.rows[0].delta).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D-CT5 — Caller-specified turn_ids order is preserved.
// ---------------------------------------------------------------------------
describe("compareTurns — D-CT5 preserves caller turn_ids order", () => {
  it("Object.keys(values) matches caller order even when SQL would re-order", async () => {
    const sessionId = await seedSession();
    // Seed three turns whose timestamps would naturally produce SQL ordering
    // [tC, tB, tA] (reverse of input). Caller supplies [tA, tB, tC]; the
    // result MUST come back in [tA, tB, tC] order.
    //
    // sequence_num and timestamp are seeded in REVERSE w.r.t. how we'll
    // call. tA was sequence_num=3 and latest timestamp; tC was
    // sequence_num=1 and earliest.
    const now = Date.now();
    const tsOldest = new Date(now - 30_000).toISOString();
    const tsMid = new Date(now - 20_000).toISOString();
    const tsLatest = new Date(now - 10_000).toISOString();

    // Insert C first (oldest sequence_num), then B, then A — so a naive
    // ORDER BY sequence_num query would return [C, B, A].
    const tC = await seedTurn({
      sessionId,
      sequenceNum: 1,
      timestamp: tsOldest,
      userRequestText: "C",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.01,
    });
    const tB = await seedTurn({
      sessionId,
      sequenceNum: 2,
      timestamp: tsMid,
      userRequestText: "B",
      inputTokens: 2,
      outputTokens: 2,
      costUsd: 0.02,
    });
    const tA = await seedTurn({
      sessionId,
      sequenceNum: 3,
      timestamp: tsLatest,
      userRequestText: "A",
      inputTokens: 3,
      outputTokens: 3,
      costUsd: 0.03,
    });

    const result = await compareTurns([tA, tB, tC]);
    expect(result.turn_ids).toEqual([tA, tB, tC]);
    for (const row of result.rows) {
      expect(Object.keys(row.values)).toEqual([tA, tB, tC]);
    }
  });
});

// ---------------------------------------------------------------------------
// D-CT6 — Empty turn_ids throws SYNCHRONOUSLY.
// ---------------------------------------------------------------------------
describe("compareTurns — D-CT6 empty turn_ids throws synchronously", () => {
  it("throws synchronously for [] (no Promise returned)", () => {
    // No `await` — the call itself must throw, not return a rejected Promise.
    expect(() => compareTurns([])).toThrow(/empty/i);
  });

  it("synchronous throw is observable WITHOUT producing a Promise", () => {
    let threw = false;
    let result: unknown = null;
    try {
      result = compareTurns([]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D-CT7 — Non-existent turn id throws with the missing id in the message.
// ---------------------------------------------------------------------------
describe("compareTurns — D-CT7 non-existent turn id", () => {
  it("rejects with an error whose message contains the missing id", async () => {
    const sessionId = await seedSession();
    const tA = await seedTurn({
      sessionId,
      sequenceNum: 1,
      userRequestText: "real",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.01,
    });
    const missing = "00000000-0000-0000-0000-000000000000";

    let caught: unknown = null;
    try {
      await compareTurns([tA, missing]);
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect((caught as Error).message).toContain(missing);
  });
});

// ---------------------------------------------------------------------------
// D-CT8 — Pre-aborted signal → AbortError BEFORE any pool.query.
// ---------------------------------------------------------------------------
describe("compareTurns — D-CT8 pre-aborted signal", () => {
  it("rejects with AbortError BEFORE any pool.query call", async () => {
    const sessionId = await seedSession();
    const tA = await seedTurn({
      sessionId,
      sequenceNum: 1,
      userRequestText: "never-read",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.01,
    });

    const pool = getPool();
    const querySpy = vi.spyOn(pool, "query");

    const ctrl = new AbortController();
    ctrl.abort();

    let caught: unknown = null;
    try {
      await compareTurns([tA], { signal: ctrl.signal });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect((caught as Error).name).toBe("AbortError");
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("rejects with AbortError even when turn ids are bogus (no I/O leaks)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    let caught: unknown = null;
    try {
      await compareTurns(["00000000-0000-0000-0000-000000000000"], {
        signal: ctrl.signal,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect((caught as Error).name).toBe("AbortError");
  });
});
