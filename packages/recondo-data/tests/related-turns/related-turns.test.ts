/**
 * Chunk 4, T6: relatedTurns — D-RT1..7.
 *
 * Drives the public exported function:
 *
 *   export type Relation =
 *     | "same_session"
 *     | "same_prompt_hash"
 *     | "retry_of";
 *
 *   export interface RelatedTurnsRow {
 *     turn_id: string;
 *     session_id: string;
 *     timestamp: string;        // raw TEXT from turns.timestamp
 *     user_request_text: string | null;
 *   }
 *
 *   export function relatedTurns(
 *     turnId: string,
 *     relation: Relation,
 *     options?: { limit?: number; signal?: AbortSignal },
 *   ): AsyncIterable<RelatedTurnsRow>;
 *
 * Decisions baked into these tests (must match the implementation):
 *
 *   - The `Relation` type has EXACTLY THREE members. The legacy relations
 *     "caused_by" and "same_tool_chain" have been DROPPED because their
 *     backing columns (`caused_by_turn_id`, `tool_chain_id`) do not exist
 *     on the `turns` table. Implementations MUST NOT add a placeholder arm
 *     for those relations; D-RT5 enforces the cardinality at the type
 *     level.
 *
 *   - "same_session" — turns sharing the input turn's `session_id`,
 *     EXCLUDING the input turn itself, ordered ASC by timestamp. The SQL
 *     MUST cast the column for ordering: `ORDER BY timestamp::timestamptz
 *     ASC` (because `turns.timestamp` is TEXT, not timestamptz).
 *
 *   - "same_prompt_hash" — turns whose `md5(user_request_text)` matches
 *     the input turn's `md5(user_request_text)`, EXCLUDING the input.
 *     Cross-session matches ARE valid because md5 is global. The hash
 *     is computed on-the-fly via SQL md5(); there is NO `prompt_hash`
 *     column on `turns`.
 *
 *   - "retry_of" — chains in BOTH directions via `supersedes_turn_id`:
 *       (a) turns where `supersedes_turn_id = $turnId`  (turns that
 *           supersede the INPUT turn), AND
 *       (b) the turn whose id equals the INPUT turn's own
 *           `supersedes_turn_id` (the turn the input supersedes), if any.
 *     The input turn itself is excluded. Function header MUST document
 *     this mapping ("retry_of (supersedes)").
 *     Note: `retry_of_turn_id` and `caused_by_turn_id` columns do NOT
 *     exist; this relation is built on top of `supersedes_turn_id`.
 *
 *   - Unknown relation (e.g. cast `"caused_by" as Relation`) throws
 *     SYNCHRONOUSLY with the EXACT message `unknown relation: <name>`.
 *     The check must run BEFORE the iterator is awaited, using the
 *     C1/C2/C3 outer-non-async + inner-async pattern.
 *
 *   - Returns `AsyncIterable<RelatedTurnsRow>` (per orchestration C7
 *     decision D-CT-LIST). Tests iterate via `for await`, NOT Array.from.
 *
 *   - Pre-aborted signal → AbortError on the first iteration step.
 *     Mid-iteration abort throws AbortError on the next yield.
 *
 * Implementer file expectation: source lives at
 *   packages/recondo-data/src/related-turns.ts
 * The D-RT7 docstring assertion globs src/**\/*.ts and asserts whichever
 * file declares `export function relatedTurns`.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  closePool,
  getPool,
  // The implementer must export relatedTurns + Relation from the package's
  // root barrel. They do NOT exist yet — these imports are expected to
  // fail at runtime until the implementer creates
  // packages/recondo-data/src/related-turns.ts and re-exports them.
  relatedTurns,
} from "../../src/index.js";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
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
             'systhash-rt', 0, 0, 0, 0, 0, '')`,
    [id, now],
  );
  seededIds.sessionIds.push(id);
  return id;
}

interface SeedTurnOpts {
  sessionId: string;
  sequenceNum: number;
  timestamp?: string;          // ISO text — column is TEXT, not timestamptz
  userRequestText?: string | null;
  responseText?: string | null;
  // For D-RT3: explicitly link a "supersedes" parent. Column is nullable TEXT.
  supersedesTurnId?: string | null;
  model?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Seed a single turn. Schema-reality columns ONLY (right-column names):
 *   id, session_id, sequence_num, timestamp, request_hash, response_hash,
 *   model, provider, input_tokens, output_tokens, cache_read_tokens,
 *   cache_creation_tokens, stop_reason, created_at, retry_count,
 *   tool_call_count, thinking_tokens, user_request_text, response_text,
 *   cost_usd, supersedes_turn_id (nullable TEXT — for D-RT3).
 *
 * NOTE: we intentionally omit `prompt_hash`, `caused_by_turn_id`,
 * `tool_chain_id`, `retry_of_turn_id` — those columns do not exist. The
 * `retry_of` relation tested by D-RT3 is implemented on top of
 * `supersedes_turn_id`.
 */
async function seedTurn(opts: SeedTurnOpts): Promise<string> {
  const pool = getPool();
  const turnId = randomUUID();
  const ts = opts.timestamp ?? new Date().toISOString();
  // Real SHA-256 hex (not a placeholder) — schema-reality discipline.
  const requestHash = sha256Hex(`req:${turnId}`);
  const responseHash = sha256Hex(`resp:${turnId}`);
  await pool.query(
    `INSERT INTO turns (id, session_id, sequence_num, timestamp,
                        request_hash, response_hash,
                        model, provider,
                        input_tokens, output_tokens, cache_read_tokens,
                        cache_creation_tokens, stop_reason, created_at,
                        retry_count, tool_call_count, thinking_tokens,
                        user_request_text, response_text, cost_usd,
                        supersedes_turn_id)
     VALUES ($1, $2, $3, $4, $5, $6,
             $7, 'anthropic',
             $8, $9, 0,
             0, 'end_turn', $4,
             0, 0, 0,
             $10, $11, $12,
             $13)`,
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
      opts.userRequestText === undefined ? null : opts.userRequestText,
      opts.responseText ?? null,
      opts.costUsd ?? null,
      opts.supersedesTurnId ?? null,
    ],
  );
  seededIds.turnIds.push(turnId);
  return turnId;
}

beforeAll(async () => {
  // Ensure the pool is initialized; per-test setup happens inside each `it`.
  getPool();
});

afterAll(async () => {
  const pool = getPool();
  if (seededIds.turnIds.length > 0 || seededIds.sessionIds.length > 0) {
    // The `prevent_turn_mutation` trigger blocks DELETE on `turns` unless
    // `recondo.gdpr_bypass` is set inside the current transaction. Use a
    // checked-out client so SET LOCAL stays scoped to the BEGIN..COMMIT.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL recondo.gdpr_bypass = 'true'");
      if (seededIds.turnIds.length > 0) {
        // Null out supersedes references first so DELETE order is irrelevant
        // (defensive — even though the column has no FK constraint at the
        // schema level, this keeps cleanup honest in case one is added).
        await client.query(
          `UPDATE turns SET supersedes_turn_id = NULL WHERE id = ANY($1)`,
          [seededIds.turnIds],
        );
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

// Helper: drain an AsyncIterable into an array via `for await`.
async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// D-RT1 — relation: "same_session"
// Seed 4 turns in one session (T1<T2<T3<T4 by timestamp); query peers of T2.
// Assert the iterator yields [T1, T3, T4] in ASC timestamp order, and that
// a turn from a DIFFERENT session does NOT appear.
// ---------------------------------------------------------------------------
describe("relatedTurns — D-RT1 same_session", () => {
  it("yields session peers in ASC timestamp order, excluding the input and other sessions", async () => {
    const sessionA = await seedSession();
    const sessionB = await seedSession();

    // Use deterministic, well-separated timestamps so timestamp::timestamptz
    // ordering is unambiguous. Out-of-order seeding (T3, T1, T4, T2) ensures
    // we'd catch an implementation that ordered by created_at or sequence_num
    // instead of timestamp.
    const t1Ts = "2026-01-01T10:00:00.000Z";
    const t2Ts = "2026-01-01T10:01:00.000Z";
    const t3Ts = "2026-01-01T10:02:00.000Z";
    const t4Ts = "2026-01-01T10:03:00.000Z";

    const t3 = await seedTurn({ sessionId: sessionA, sequenceNum: 3, timestamp: t3Ts });
    const t1 = await seedTurn({ sessionId: sessionA, sequenceNum: 1, timestamp: t1Ts });
    const t4 = await seedTurn({ sessionId: sessionA, sequenceNum: 4, timestamp: t4Ts });
    const t2 = await seedTurn({ sessionId: sessionA, sequenceNum: 2, timestamp: t2Ts });

    // Other-session turn — must NOT appear in same_session results for t2.
    const tOther = await seedTurn({
      sessionId: sessionB,
      sequenceNum: 1,
      timestamp: "2026-01-01T10:01:30.000Z",
    });

    const matches = await drain(relatedTurns(t2, "same_session"));
    const ids = matches.map((m) => m.turn_id);

    // Must yield exactly the three peers, in ASC timestamp order.
    expect(ids).toEqual([t1, t3, t4]);
    // Input excluded.
    expect(ids).not.toContain(t2);
    // Other session excluded.
    expect(ids).not.toContain(tOther);

    // Each row carries session_id and timestamp (raw TEXT). Validate t1's row.
    const m1 = matches.find((m) => m.turn_id === t1)!;
    expect(m1.session_id).toBe(sessionA);
    expect(m1.timestamp).toBe(t1Ts);
  });
});

// ---------------------------------------------------------------------------
// D-RT2 — relation: "same_prompt_hash"
// md5(user_request_text) is global (cross-session). Seed:
//   A — sessionA, prompt P
//   B — sessionA, prompt P  (same)
//   C — sessionA, prompt Q  (different)
//   D — sessionB, prompt P  (cross-session, same prompt)
// Query peers of A; assert {B, D} appear and {A, C} do not.
// ---------------------------------------------------------------------------
describe("relatedTurns — D-RT2 same_prompt_hash", () => {
  it("matches by md5(user_request_text) globally, excluding the input and unrelated prompts", async () => {
    const sessionA = await seedSession();
    const sessionB = await seedSession();
    const promptP = "rt2: identical prompt across sessions";
    const promptQ = "rt2: a totally different prompt";

    const tA = await seedTurn({
      sessionId: sessionA,
      sequenceNum: 1,
      userRequestText: promptP,
    });
    const tB = await seedTurn({
      sessionId: sessionA,
      sequenceNum: 2,
      userRequestText: promptP,
    });
    const tC = await seedTurn({
      sessionId: sessionA,
      sequenceNum: 3,
      userRequestText: promptQ,
    });
    const tD = await seedTurn({
      sessionId: sessionB,
      sequenceNum: 1,
      userRequestText: promptP,
    });

    const matches = await drain(relatedTurns(tA, "same_prompt_hash"));
    const ids = matches.map((m) => m.turn_id);

    // B and D share the prompt with A. Cross-session is OK (md5 is global).
    expect(ids).toContain(tB);
    expect(ids).toContain(tD);
    // A is the input — excluded.
    expect(ids).not.toContain(tA);
    // C has a different prompt — excluded.
    expect(ids).not.toContain(tC);

    // Confirm the row payload for B and D carries the matching prompt text.
    const matchB = matches.find((m) => m.turn_id === tB)!;
    expect(matchB.user_request_text).toBe(promptP);
    expect(matchB.session_id).toBe(sessionA);
    const matchD = matches.find((m) => m.turn_id === tD)!;
    expect(matchD.user_request_text).toBe(promptP);
    expect(matchD.session_id).toBe(sessionB);
  });
});

// ---------------------------------------------------------------------------
// D-RT3 — relation: "retry_of" (mapped to supersedes_turn_id)
// Two-way semantic:
//   X has supersedes_turn_id = NULL (oldest)
//   Y has supersedes_turn_id = X.id (Y supersedes X)
//   Z has supersedes_turn_id = X.id (Z also supersedes X)
//
// Querying X must yield {Y, Z}: turns whose supersedes_turn_id = X.id.
// Querying Y must yield {X, Z}: X is the turn Y supersedes; Z also
// supersedes X (so X and Z are both in Y's chain). Y is excluded from
// its own result set.
// ---------------------------------------------------------------------------
describe("relatedTurns — D-RT3 retry_of (supersedes chain, both directions)", () => {
  it("yields supersede-children of the input AND the supersede-parent of the input", async () => {
    const sessionA = await seedSession();
    // X first, with NULL supersedes_turn_id.
    const tX = await seedTurn({
      sessionId: sessionA,
      sequenceNum: 1,
      timestamp: "2026-02-01T10:00:00.000Z",
      supersedesTurnId: null,
    });
    // Y supersedes X.
    const tY = await seedTurn({
      sessionId: sessionA,
      sequenceNum: 2,
      timestamp: "2026-02-01T10:01:00.000Z",
      supersedesTurnId: tX,
    });
    // Z also supersedes X.
    const tZ = await seedTurn({
      sessionId: sessionA,
      sequenceNum: 3,
      timestamp: "2026-02-01T10:02:00.000Z",
      supersedesTurnId: tX,
    });

    // Direction 1: input = X. Yields turns whose supersedes_turn_id = X
    // (i.e. Y and Z). X itself is excluded.
    const fromX = await drain(relatedTurns(tX, "retry_of"));
    const fromXIds = fromX.map((m) => m.turn_id).sort();
    expect(fromXIds).toEqual([tY, tZ].sort());
    expect(fromXIds).not.toContain(tX);

    // Direction 2: input = Y. The chain in BOTH directions:
    //   - X is the turn Y supersedes (Y.supersedes_turn_id = X)
    //   - Z also supersedes X, so Z is in the same chain
    // Y itself is excluded.
    const fromY = await drain(relatedTurns(tY, "retry_of"));
    const fromYIds = fromY.map((m) => m.turn_id).sort();
    expect(fromYIds).toEqual([tX, tZ].sort());
    expect(fromYIds).not.toContain(tY);
  });
});

// ---------------------------------------------------------------------------
// D-RT4 — Unknown relation throws SYNCHRONOUSLY.
// Test with the legacy (DROPPED) relation "caused_by". Cast bypasses TS
// so we can exercise the runtime guard.
//
// The implementation must throw synchronously (NOT return a Promise that
// rejects), so `expect(() => relatedTurns(id, "caused_by"))` catches the
// throw without any `await`. This is the C1/C2/C3 outer-non-async +
// inner-async pattern.
// ---------------------------------------------------------------------------
describe("relatedTurns — D-RT4 unknown relation throws synchronously", () => {
  it("throws synchronously with `unknown relation: <name>` (no Promise returned)", () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    // Cast through `unknown` so TS lets us pass an invalid Relation literal.
    const badRelation = "caused_by" as unknown as Parameters<
      typeof relatedTurns
    >[1];

    expect(() => relatedTurns(fakeId, badRelation)).toThrow(
      /unknown relation: caused_by/,
    );

    // Also confirm the function did NOT return a Promise (no `await` form):
    // a Promise rejection would not be caught by `toThrow()` above; this
    // assertion documents the synchronous-throw contract explicitly.
    let returned: unknown;
    let threw = false;
    try {
      returned = relatedTurns(fakeId, badRelation);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // If it threw, `returned` stays `undefined` — confirm we never got a
    // thenable masquerading as the iterable.
    expect(typeof (returned as { then?: unknown } | undefined)?.then).not.toBe(
      "function",
    );
  });

  it("also throws for other unknown relation literals (e.g. same_tool_chain)", () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const badRelation = "same_tool_chain" as unknown as Parameters<
      typeof relatedTurns
    >[1];
    expect(() => relatedTurns(fakeId, badRelation)).toThrow(
      /unknown relation: same_tool_chain/,
    );
  });
});

// ---------------------------------------------------------------------------
// D-RT6 — AbortSignal: pre-aborted + mid-iteration abort.
// Mirrors C3's D-FSP5.
// ---------------------------------------------------------------------------
describe("relatedTurns — D-RT6 AbortSignal", () => {
  it("(a) pre-aborted signal throws AbortError on the first iteration step", async () => {
    const sessionA = await seedSession();
    const seed = await seedTurn({ sessionId: sessionA, sequenceNum: 1 });
    // Add a peer so the iterator has content to (try to) yield.
    await seedTurn({ sessionId: sessionA, sequenceNum: 2 });

    const ctrl = new AbortController();
    ctrl.abort();

    let caught: unknown = null;
    try {
      // The throw may happen on the very first `for await` step OR before
      // iteration starts (synchronous abort check during iterator setup).
      // Either is acceptable per the deliverable contract.
      for await (const _m of relatedTurns(seed, "same_session", {
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
    const sessionA = await seedSession();
    // Seed 6 turns so the iterator has plenty to yield after the first.
    const seed = await seedTurn({ sessionId: sessionA, sequenceNum: 1 });
    for (let i = 2; i <= 6; i += 1) {
      await seedTurn({ sessionId: sessionA, sequenceNum: i });
    }

    const ctrl = new AbortController();
    let firstYielded = false;
    let caught: unknown = null;

    try {
      for await (const _m of relatedTurns(seed, "same_session", {
        signal: ctrl.signal,
      })) {
        if (!firstYielded) {
          firstYielded = true;
          ctrl.abort();
          continue;
        }
        // Reaching a SECOND yield after abort = signal was not honored.
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

// ---------------------------------------------------------------------------
// D-RT7 — Function header documents the retry_of → supersedes_turn_id
// mapping. Static assertion against the source file containing the
// `export function relatedTurns` declaration.
// ---------------------------------------------------------------------------
describe("relatedTurns — D-RT7 docstring documents retry_of → supersedes_turn_id mapping", () => {
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
        if (/export\s+function\s+relatedTurns\b/.test(text)) {
          return full;
        }
      }
    }
    return null;
  }

  it("the source file's header mentions BOTH 'retry_of' AND 'supersedes_turn_id'", () => {
    const srcRoot = join(__dirname, "..", "..", "src");
    const file = findSourceFile(srcRoot);
    expect(
      file,
      "expected a src/**/*.ts file declaring `export function relatedTurns`",
    ).not.toBeNull();

    const text = readFileSync(file as string, "utf8");
    const idx = text.search(/export\s+function\s+relatedTurns\b/);
    expect(idx).toBeGreaterThan(0);
    const header = text.slice(0, idx);

    // The mapping disclosure: docstring must mention BOTH `retry_of` AND
    // `supersedes_turn_id` so a reader understands the relation is built
    // on top of the supersedes chain (not on a `retry_of_turn_id` column,
    // which does NOT exist).
    expect(
      /retry_of/i.test(header),
      "header must mention `retry_of` to disclose the relation",
    ).toBe(true);
    expect(
      /supersedes_turn_id/i.test(header),
      "header must mention `supersedes_turn_id` to disclose the column the " +
        "relation is built on (there is no retry_of_turn_id column)",
    ).toBe(true);
  });
});
