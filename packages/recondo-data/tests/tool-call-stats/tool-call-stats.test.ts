/**
 * Chunk 6, T8: toolCallStats — D-TS1..9.
 *
 * Drives the public exported function:
 *
 *   export type ToolCallGroupBy = "tool_name" | "session" | "framework";
 *   export type ToolCallPeriod  = "24h" | "7d" | "30d" | "all";
 *
 *   export interface ToolCallStatsRow {
 *     group_key: string;          // tool_name / session_id / framework
 *     total_calls: number;
 *     failure_rate: number;       // 0..1
 *     avg_latency_ms: number;
 *     total_duration_ms: number;
 *     // NO token_cost_total field — explicitly absent (D-TS10).
 *   }
 *
 *   export function toolCallStats(
 *     options: {
 *       group_by: ToolCallGroupBy;
 *       period: ToolCallPeriod;
 *       signal?: AbortSignal;
 *     },
 *   ): AsyncIterable<ToolCallStatsRow>;
 *
 * Decisions baked into these tests (must match the implementation):
 *
 *   - AsyncIterable<ToolCallStatsRow> return shape (per orchestration C7
 *     decision D-CT-LIST). Tests iterate via `for await`, NOT Array.from.
 *
 *   - NO `token_cost_total` field on the output type or in SQL. The
 *     `tool_calls` table has NO `token_cost` column — this is enforced at
 *     the type level by D-TS10 in tests/types.test-d.ts.
 *
 *   - `total_duration_ms = SUM(duration_ms)` IS in the output (D-TS4).
 *
 *   - `failure_rate = (count where status != 'success') / total_calls`.
 *     NULL status counts as FAILURE (only the explicit 'success' marker
 *     counts as success). D-TS2.
 *
 *   - `avg_latency_ms = AVG(duration_ms)`. NULL durations are excluded by
 *     AVG itself (Postgres semantics). D-TS3.
 *
 *   - group_by: "tool_name" | "session" | "framework". Unknown group_by
 *     throws SYNCHRONOUSLY. D-TS1, D-TS5, D-TS6.
 *
 *   - period: "24h" | "7d" | "30d" | "all". Unknown period throws
 *     SYNCHRONOUSLY with a message containing the bad period string.
 *     D-TS7, D-TS8.
 *
 *   - period filter: JOIN turns and filter
 *       `t.timestamp::timestamptz >= now() - '<N> <unit>'::interval`
 *     with `<N> <unit>` ∈ {`24 hours`, `7 days`, `30 days`}; "all" = no
 *     filter. The cast is needed because `turns.timestamp` is TEXT.
 *
 *   - Pre-aborted signal → AbortError on the first iteration step.
 *     Mid-iteration abort → AbortError on the next yield. D-TS9.
 *
 * Schema-reality column names used in seeders (right-column names ONLY):
 *   tool_calls: id, turn_id, tool_name, tool_input, input_hash,
 *               sequence_num, output, output_hash, duration_ms, status.
 *               (NO `latency_ms`, NO boolean `success`, NO `args_hash`,
 *               NO `token_cost`, NO `tool_calls.captured_at`.)
 *   turns:     timestamp (TEXT, cast to timestamptz at query time).
 *   sessions:  framework (NOT `agent_framework`).
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
  // The implementer must export toolCallStats from the package's root
  // barrel. It does NOT exist yet — these imports are expected to fail at
  // runtime until the implementer creates
  // packages/recondo-data/src/tool-call-stats.ts and re-exports it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- imported for runtime resolution
  toolCallStats,
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

interface SeedSessionOpts {
  framework?: string | null;
}

async function seedSession(opts: SeedSessionOpts = {}): Promise<string> {
  const pool = getPool();
  const id = randomUUID();
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO sessions (id, provider, model, started_at, last_active_at,
                           system_prompt_hash, total_turns, turns_captured,
                           dropped_events, total_tokens, total_cost_usd,
                           tool_definitions_hash, framework)
     VALUES ($1, 'anthropic', 'claude-sonnet-4-20250514', $2, $2,
             'systhash-ts', 0, 0, 0, 0, 0, '', $3)`,
    [id, now, opts.framework ?? null],
  );
  seededIds.sessionIds.push(id);
  return id;
}

interface SeedTurnOpts {
  sessionId: string;
  sequenceNum: number;
  timestamp?: string;
}

/**
 * Seed a turn. Right-column names ONLY:
 *   id, session_id, sequence_num, timestamp (TEXT), request_hash,
 *   response_hash, model, provider, input_tokens, output_tokens,
 *   cache_read_tokens, cache_creation_tokens, stop_reason, created_at,
 *   retry_count, tool_call_count, thinking_tokens.
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
                        retry_count, tool_call_count, thinking_tokens)
     VALUES ($1, $2, $3, $4, $5, $6,
             'claude-sonnet-4-20250514', 'anthropic',
             0, 0, 0,
             0, 'end_turn', $4,
             0, 0, 0)`,
    [turnId, opts.sessionId, opts.sequenceNum, ts, requestHash, responseHash],
  );
  seededIds.turnIds.push(turnId);
  return turnId;
}

interface SeedToolCallOpts {
  turnId: string;
  toolName: string;
  status?: string | null;
  durationMs?: number | null;
  inputHash?: string;
  sequenceNum?: number;
}

/**
 * Seed a tool_calls row. Right-column names ONLY:
 *   id, turn_id, tool_name, tool_input, input_hash, sequence_num, output,
 *   output_hash, duration_ms, status. (NO `latency_ms`, NO boolean
 *   `success`, NO `args_hash`, NO `token_cost`, NO `captured_at`.)
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
      "{}",
      opts.inputHash ?? sha256Hex(`tc:${id}`),
      opts.sequenceNum ?? 0,
      opts.durationMs ?? null,
      opts.status ?? null,
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

// Helper: drain an AsyncIterable into an array via `for await`.
async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// D-TS1 — group_by: "tool_name" returns one row per tool name.
//
// Seed (single session, single turn for simplicity):
//   - 1 Bash call (status="success", duration_ms=100)
//   - 1 Bash call (status="error",   duration_ms=50)
//   - 1 Read call (status="success", duration_ms=200)
//
// Expect 2 rows: Bash (total_calls=2), Read (total_calls=1).
// ---------------------------------------------------------------------------
describe("toolCallStats — D-TS1 group_by tool_name", () => {
  it("yields one row per distinct tool_name with correct total_calls", async () => {
    const sessionId = await seedSession();
    const turnId = await seedTurn({ sessionId, sequenceNum: 1 });

    await seedToolCall({
      turnId,
      toolName: "Bash",
      status: "success",
      durationMs: 100,
      sequenceNum: 0,
    });
    await seedToolCall({
      turnId,
      toolName: "Bash",
      status: "error",
      durationMs: 50,
      sequenceNum: 1,
    });
    await seedToolCall({
      turnId,
      toolName: "Read",
      status: "success",
      durationMs: 200,
      sequenceNum: 2,
    });

    const rows = await drain(
      toolCallStats({ group_by: "tool_name", period: "all" }),
    );

    // Filter to the rows we seeded — the dev-infra DB may carry rows from
    // prior test runs; we constrain assertions to what we control by name.
    const bash = rows.find((r) => r.group_key === "Bash");
    const read = rows.find((r) => r.group_key === "Read");

    expect(bash, "expected a row keyed by 'Bash'").toBeTruthy();
    expect(read, "expected a row keyed by 'Read'").toBeTruthy();

    expect(bash!.total_calls).toBe(2);
    expect(read!.total_calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// D-TS2 — failure_rate = (count where status != 'success') / total.
//
// Reuses the D-TS1 seed shape:
//   Bash: 2 calls, 1 'success', 1 'error' → failure_rate = 0.5
//   Read: 1 call,  1 'success'            → failure_rate = 0
// ---------------------------------------------------------------------------
describe("toolCallStats — D-TS2 failure_rate", () => {
  it("counts non-'success' status as failures and divides by total_calls", async () => {
    const sessionId = await seedSession();
    const turnId = await seedTurn({ sessionId, sequenceNum: 1 });

    const bashSuccessId = await seedToolCall({
      turnId,
      toolName: "Bash-TS2",
      status: "success",
      durationMs: 100,
      inputHash: "ts2-bash-success",
      sequenceNum: 0,
    });
    const bashErrorId = await seedToolCall({
      turnId,
      toolName: "Bash-TS2",
      status: "error",
      durationMs: 50,
      inputHash: "ts2-bash-error",
      sequenceNum: 1,
    });
    const readSuccessId = await seedToolCall({
      turnId,
      toolName: "Read-TS2",
      status: "success",
      durationMs: 200,
      inputHash: "ts2-read-success",
      sequenceNum: 2,
    });
    // Anchor the variables so the lint/compiler doesn't drop them — the
    // seed IDs feed the afterAll cleanup.
    expect(bashSuccessId.length).toBeGreaterThan(0);
    expect(bashErrorId.length).toBeGreaterThan(0);
    expect(readSuccessId.length).toBeGreaterThan(0);

    const rows = await drain(
      toolCallStats({ group_by: "tool_name", period: "all" }),
    );

    const bash = rows.find((r) => r.group_key === "Bash-TS2");
    const read = rows.find((r) => r.group_key === "Read-TS2");
    expect(bash).toBeTruthy();
    expect(read).toBeTruthy();

    expect(Math.abs(bash!.failure_rate - 0.5)).toBeLessThan(1e-9);
    expect(Math.abs(read!.failure_rate - 0)).toBeLessThan(1e-9);
  });
});

// ---------------------------------------------------------------------------
// D-TS3 — avg_latency_ms = AVG(duration_ms).
//
// From a Bash group with durations [100, 50] → avg = 75.
// From a Read group with [200]                → avg = 200.
// ---------------------------------------------------------------------------
describe("toolCallStats — D-TS3 avg_latency_ms", () => {
  it("computes AVG(duration_ms) per group", async () => {
    const sessionId = await seedSession();
    const turnId = await seedTurn({ sessionId, sequenceNum: 1 });

    await seedToolCall({
      turnId,
      toolName: "Bash-TS3",
      status: "success",
      durationMs: 100,
      inputHash: "ts3-a",
    });
    await seedToolCall({
      turnId,
      toolName: "Bash-TS3",
      status: "error",
      durationMs: 50,
      inputHash: "ts3-b",
    });
    await seedToolCall({
      turnId,
      toolName: "Read-TS3",
      status: "success",
      durationMs: 200,
      inputHash: "ts3-c",
    });

    const rows = await drain(
      toolCallStats({ group_by: "tool_name", period: "all" }),
    );
    const bash = rows.find((r) => r.group_key === "Bash-TS3");
    const read = rows.find((r) => r.group_key === "Read-TS3");
    expect(bash).toBeTruthy();
    expect(read).toBeTruthy();

    // (100 + 50) / 2 = 75
    expect(Math.abs(bash!.avg_latency_ms - 75)).toBeLessThan(1e-6);
    // 200 / 1 = 200
    expect(Math.abs(read!.avg_latency_ms - 200)).toBeLessThan(1e-6);
  });
});

// ---------------------------------------------------------------------------
// D-TS4 — total_duration_ms = SUM(duration_ms). Replaces token_cost_total.
//
// Bash group durations [100, 50] → 150. Read group [200] → 200.
// ---------------------------------------------------------------------------
describe("toolCallStats — D-TS4 total_duration_ms", () => {
  it("computes SUM(duration_ms) per group (replaces removed token_cost_total)", async () => {
    const sessionId = await seedSession();
    const turnId = await seedTurn({ sessionId, sequenceNum: 1 });

    await seedToolCall({
      turnId,
      toolName: "Bash-TS4",
      status: "success",
      durationMs: 100,
      inputHash: "ts4-a",
    });
    await seedToolCall({
      turnId,
      toolName: "Bash-TS4",
      status: "error",
      durationMs: 50,
      inputHash: "ts4-b",
    });
    await seedToolCall({
      turnId,
      toolName: "Read-TS4",
      status: "success",
      durationMs: 200,
      inputHash: "ts4-c",
    });

    const rows = await drain(
      toolCallStats({ group_by: "tool_name", period: "all" }),
    );
    const bash = rows.find((r) => r.group_key === "Bash-TS4");
    const read = rows.find((r) => r.group_key === "Read-TS4");
    expect(bash).toBeTruthy();
    expect(read).toBeTruthy();

    expect(bash!.total_duration_ms).toBe(150);
    expect(read!.total_duration_ms).toBe(200);

    // Defense-in-depth: the row MUST NOT carry a `token_cost_total` field.
    // (The type test in types.test-d.ts is the canonical static guard;
    // this runtime check catches an implementation that smuggles the
    // legacy field into the row at runtime via `as any` widening.)
    expect((bash as unknown as Record<string, unknown>).token_cost_total).toBe(
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// D-TS5 — group_by: "session". Rows keyed by session_id.
// ---------------------------------------------------------------------------
describe("toolCallStats — D-TS5 group_by session", () => {
  it("yields one row per distinct session_id", async () => {
    const sessionA = await seedSession();
    const sessionB = await seedSession();
    const turnA = await seedTurn({ sessionId: sessionA, sequenceNum: 1 });
    const turnB = await seedTurn({ sessionId: sessionB, sequenceNum: 1 });

    await seedToolCall({
      turnId: turnA,
      toolName: "Bash",
      status: "success",
      durationMs: 100,
      inputHash: "ts5-a-1",
    });
    await seedToolCall({
      turnId: turnA,
      toolName: "Bash",
      status: "error",
      durationMs: 200,
      inputHash: "ts5-a-2",
    });
    await seedToolCall({
      turnId: turnB,
      toolName: "Read",
      status: "success",
      durationMs: 150,
      inputHash: "ts5-b-1",
    });

    const rows = await drain(
      toolCallStats({ group_by: "session", period: "all" }),
    );
    const rowA = rows.find((r) => r.group_key === sessionA);
    const rowB = rows.find((r) => r.group_key === sessionB);

    expect(
      rowA,
      `expected a row keyed by session ${sessionA}`,
    ).toBeTruthy();
    expect(
      rowB,
      `expected a row keyed by session ${sessionB}`,
    ).toBeTruthy();

    expect(rowA!.total_calls).toBe(2);
    expect(rowB!.total_calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// D-TS6 — group_by: "framework". Rows keyed by sessions.framework.
// (Right-column name: `framework`, NOT `agent_framework`.)
// ---------------------------------------------------------------------------
describe("toolCallStats — D-TS6 group_by framework", () => {
  it("yields one row per distinct sessions.framework value", async () => {
    const sessionCC = await seedSession({ framework: "claude-code" });
    const sessionCx = await seedSession({ framework: "codex" });

    const turnCC = await seedTurn({ sessionId: sessionCC, sequenceNum: 1 });
    const turnCx = await seedTurn({ sessionId: sessionCx, sequenceNum: 1 });

    await seedToolCall({
      turnId: turnCC,
      toolName: "Bash",
      status: "success",
      durationMs: 100,
      inputHash: "ts6-cc-1",
    });
    await seedToolCall({
      turnId: turnCC,
      toolName: "Read",
      status: "error",
      durationMs: 50,
      inputHash: "ts6-cc-2",
    });
    await seedToolCall({
      turnId: turnCx,
      toolName: "Bash",
      status: "success",
      durationMs: 250,
      inputHash: "ts6-cx-1",
    });

    const rows = await drain(
      toolCallStats({ group_by: "framework", period: "all" }),
    );
    const cc = rows.find((r) => r.group_key === "claude-code");
    const cx = rows.find((r) => r.group_key === "codex");

    expect(cc, "expected a row keyed 'claude-code'").toBeTruthy();
    expect(cx, "expected a row keyed 'codex'").toBeTruthy();

    expect(cc!.total_calls).toBe(2);
    expect(cx!.total_calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// D-TS7 — period: "24h" filters via JOIN turns ON timestamp.
//
// Seed 1 tool_call attached to a turn with timestamp = now() and another
// attached to a turn with timestamp = now() - 7 days. Calling with
// period:"24h" must yield ONLY the recent call.
//
// Verify the SQL contains `'24 hours'::interval` (or an equivalent
// parameterized form: $N::interval where the bound value is a 24-hour
// interval). The test prefers the literal-interval form.
// ---------------------------------------------------------------------------
describe("toolCallStats — D-TS7 period 24h filters by turns.timestamp", () => {
  it("excludes tool_calls whose turn is older than the 24h window", async () => {
    const sessionId = await seedSession();
    const recentTs = new Date().toISOString();
    const oldTs = new Date(Date.now() - 7 * 86_400_000).toISOString();

    const recentTurn = await seedTurn({
      sessionId,
      sequenceNum: 1,
      timestamp: recentTs,
    });
    const oldTurn = await seedTurn({
      sessionId,
      sequenceNum: 2,
      timestamp: oldTs,
    });

    await seedToolCall({
      turnId: recentTurn,
      toolName: "TS7-Recent",
      status: "success",
      durationMs: 10,
      inputHash: "ts7-recent",
    });
    await seedToolCall({
      turnId: oldTurn,
      toolName: "TS7-Old",
      status: "success",
      durationMs: 10,
      inputHash: "ts7-old",
    });

    const pool = getPool();
    const querySpy = vi.spyOn(pool, "query");

    const rows = await drain(
      toolCallStats({ group_by: "tool_name", period: "24h" }),
    );

    // Only the recent call should appear; the 7-day-old call must be
    // filtered out by the period predicate.
    const recent = rows.find((r) => r.group_key === "TS7-Recent");
    const old = rows.find((r) => r.group_key === "TS7-Old");

    expect(
      recent,
      "expected the recent (now-stamped) tool_call to appear under period 24h",
    ).toBeTruthy();
    expect(
      old,
      "expected the 7-day-old tool_call to be excluded under period 24h",
    ).toBeFalsy();

    // SQL spy: pull every captured query text and assert at least one
    // mentions a 24-hour interval. We accept a literal interval string
    // OR a parameterized $N::interval form, but require the magnitude
    // 24-hours (or its day equivalent) to appear in the SQL or its
    // parameters. The literal form is preferred for readability.
    const captured = querySpy.mock.calls
      .map((call) => {
        const arg0 = call[0] as unknown;
        if (typeof arg0 === "string") return { sql: arg0, params: call[1] };
        if (
          arg0 &&
          typeof arg0 === "object" &&
          "text" in arg0 &&
          typeof (arg0 as { text: unknown }).text === "string"
        ) {
          return {
            sql: (arg0 as { text: string }).text,
            params: (arg0 as { values?: unknown }).values,
          };
        }
        return { sql: "", params: undefined };
      })
      .filter((c) => c.sql.length > 0);

    expect(
      captured.length,
      "expected at least one SQL query to have been issued",
    ).toBeGreaterThan(0);

    const intervalLiteral = captured.some((c) =>
      /'\s*24\s*hours?\s*'\s*::\s*interval/i.test(c.sql),
    );
    const intervalCastParam = captured.some((c) => {
      if (!/\$\d+\s*::\s*interval/i.test(c.sql)) return false;
      const params = c.params;
      if (!Array.isArray(params)) return false;
      return params.some(
        (p) =>
          typeof p === "string" &&
          /(24\s*hours?|1\s*day)/i.test(p),
      );
    });

    expect(
      intervalLiteral || intervalCastParam,
      "expected the SQL to filter by a 24-hour interval — either a literal " +
        "'24 hours'::interval, or a $N::interval bound to a string like " +
        "'24 hours'/'1 day'",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D-TS8 — Unknown period throws SYNCHRONOUSLY (no Promise returned).
//
// Cast bypasses TS so we can drive the runtime guard.
// ---------------------------------------------------------------------------
describe("toolCallStats — D-TS8 unknown period throws synchronously", () => {
  it("throws synchronously with /unknown period/i and includes the bad value", () => {
    type ToolCallPeriodLiteral = "24h" | "7d" | "30d" | "all";
    const badPeriod = "1y" as unknown as ToolCallPeriodLiteral;

    expect(() =>
      toolCallStats({ group_by: "tool_name", period: badPeriod }),
    ).toThrow(/unknown period/i);

    // Also confirm the function did NOT return a thenable masquerading
    // as the iterable. A Promise rejection would not be caught by
    // `toThrow()` above; this assertion documents the synchronous-throw
    // contract explicitly.
    let returned: unknown;
    let threw = false;
    try {
      returned = toolCallStats({ group_by: "tool_name", period: badPeriod });
    } catch (err) {
      threw = true;
      // Double-check the error message mentions the bad period string.
      expect(String((err as Error).message)).toMatch(/1y/);
    }
    expect(threw).toBe(true);
    expect(typeof (returned as { then?: unknown } | undefined)?.then).not.toBe(
      "function",
    );
  });

  it("also throws synchronously when group_by is unknown", () => {
    type ToolCallGroupByLiteral = "tool_name" | "session" | "framework";
    const badGroup = "device_id" as unknown as ToolCallGroupByLiteral;
    expect(() =>
      toolCallStats({ group_by: badGroup, period: "all" }),
    ).toThrow(/unknown group_by/i);
  });
});

// ---------------------------------------------------------------------------
// D-TS9 — AbortSignal: pre-aborted + mid-iteration abort.
// ---------------------------------------------------------------------------
describe("toolCallStats — D-TS9 AbortSignal", () => {
  it("(a) pre-aborted signal throws AbortError on the first iteration step", async () => {
    const sessionId = await seedSession();
    const turnId = await seedTurn({ sessionId, sequenceNum: 1 });
    // Add at least one tool_call so the iterator would otherwise have
    // content to yield — catches an implementer that ignores the signal.
    await seedToolCall({
      turnId,
      toolName: "TS9-A",
      status: "success",
      durationMs: 5,
      inputHash: "ts9-a",
    });

    const ctrl = new AbortController();
    ctrl.abort();

    let caught: unknown = null;
    try {
      for await (const _row of toolCallStats({
        group_by: "tool_name",
        period: "all",
        signal: ctrl.signal,
      })) {
        throw new Error(
          "expected AbortError before any yield, but got a yield",
        );
      }
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect((caught as Error).name).toBe("AbortError");
  });

  it("(b) mid-iteration abort throws AbortError on the next yield", async () => {
    const sessionId = await seedSession();
    const turnId = await seedTurn({ sessionId, sequenceNum: 1 });
    // Seed several distinct tool_name groups so multiple rows are yielded.
    for (let i = 0; i < 6; i += 1) {
      await seedToolCall({
        turnId,
        toolName: `TS9-B-${i}`,
        status: "success",
        durationMs: 5,
        inputHash: `ts9-b-${i}`,
        sequenceNum: i,
      });
    }

    const ctrl = new AbortController();
    let firstYielded = false;
    let caught: unknown = null;

    try {
      for await (const _row of toolCallStats({
        group_by: "tool_name",
        period: "all",
        signal: ctrl.signal,
      })) {
        if (!firstYielded) {
          firstYielded = true;
          ctrl.abort();
          continue;
        }
        // A SECOND yield after abort = signal was not honored.
        throw new Error(
          "expected AbortError on the next yield after abort, got another item",
        );
      }
    } catch (err) {
      caught = err;
    }

    expect(firstYielded).toBe(true);
    expect(caught).not.toBeNull();
    expect((caught as Error).name).toBe("AbortError");
  });
});
