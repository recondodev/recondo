/**
 * Chunk 3, T5: findSimilarPrompts — D-FSP1..6.
 *
 * Drives the public exported function:
 *
 *   export interface SimilarPromptMatch {
 *     turn_id: string;
 *     session_id: string;
 *     user_request_text: string;
 *   }
 *
 *   export type FindSimilarPromptsInput = string | { text: string };
 *
 *   export function findSimilarPrompts(
 *     input: FindSimilarPromptsInput,
 *     options?: { limit?: number; signal?: AbortSignal },
 *   ): AsyncIterable<SimilarPromptMatch>;
 *
 * Decisions baked into these tests (must match the implementation):
 *   - v1 hash-only matching: two prompts match iff their byte-for-byte
 *     `user_request_text` hashes (md5 over the column) are identical.
 *     Whitespace differences, casing, or other normalizations are NOT a match.
 *   - The hash is computed on-the-fly via SQL `md5(user_request_text)`. There
 *     is NO `prompt_hash` column on `turns`. The function header MUST document
 *     both the v1 byte-identical-only limitation AND the seq-scan perf
 *     tradeoff (a future v1.5 may add a `prompt_hash` column + index).
 *   - findSimilarPrompts has TWO call shapes:
 *       findSimilarPrompts(turnId)              — looks up the input turn's
 *                                                  user_request_text.
 *       findSimilarPrompts({ text: "..." })     — uses the literal text.
 *   - Returns an `AsyncIterable<SimilarPromptMatch>` (per orchestration C7
 *     decision D-CT-LIST). Tests iterate via `for await`, NOT Array.from.
 *   - Options accept `{ limit?: number; signal?: AbortSignal }`. Default
 *     limit is implementation-defined; tests assert `limit: 3` caps to 3.
 *   - Pre-aborted signal → AbortError on the first iteration step.
 *     Mid-iteration abort throws on the next yield.
 *   - The input turn (when `input` is a turnId) is EXCLUDED from results.
 *
 * Implementer file expectation: source lives at
 *   packages/recondo-data/src/find-similar-prompts.ts
 * The D-FSP6 docstring assertion globs src/**\/*.ts and asserts whichever
 * file declares `export function findSimilarPrompts` — so the test stays
 * green if the implementer relocates the file.
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
  // The implementer must export findSimilarPrompts from the package's root
  // barrel. It does NOT exist yet — this import is expected to fail at
  // runtime until the implementer creates
  // packages/recondo-data/src/find-similar-prompts.ts and re-exports it.
  findSimilarPrompts,
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
             'systhash-fsp', 0, 0, 0, 0, 0, '')`,
    [id, now],
  );
  seededIds.sessionIds.push(id);
  return id;
}

interface SeedTurnOpts {
  sessionId: string;
  sequenceNum: number;
  timestamp?: string;
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

beforeAll(async () => {
  // Ensure the pool is initialized; further setup is per-test.
  getPool();
});

afterAll(async () => {
  const pool = getPool();
  if (seededIds.turnIds.length > 0 || seededIds.sessionIds.length > 0) {
    // The `prevent_turn_mutation` trigger (api/migrations/003) blocks DELETE
    // on `turns` unless `recondo.gdpr_bypass` is set inside the current
    // transaction. Use a checked-out client so SET LOCAL stays scoped to
    // the BEGIN..COMMIT block.
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
// D-FSP1 — Byte-identical user_request_text → match (and the input turn is
// excluded from results, and unrelated prompts do NOT appear).
// ---------------------------------------------------------------------------
describe("findSimilarPrompts — D-FSP1 byte-identical match by turnId", () => {
  it("yields turns with the same user_request_text and excludes the input", async () => {
    const sessionId = await seedSession();
    const exact = "fsp1: how do I reverse a linked list in rust";
    const tA = await seedTurn({
      sessionId,
      sequenceNum: 1,
      userRequestText: exact,
    });
    const tB = await seedTurn({
      sessionId,
      sequenceNum: 2,
      userRequestText: exact,
    });
    // Different prompt — must NOT appear.
    const tC = await seedTurn({
      sessionId,
      sequenceNum: 3,
      userRequestText: "fsp1: a totally unrelated prompt about quaternions",
    });

    const matches = await drain(findSimilarPrompts(tA));
    const ids = matches.map((m) => m.turn_id);

    // tB is similar; tA (input) is excluded; tC is unrelated.
    expect(ids).toContain(tB);
    expect(ids).not.toContain(tA);
    expect(ids).not.toContain(tC);

    // Each match's payload echoes the matching prompt and its session.
    const matchB = matches.find((m) => m.turn_id === tB);
    expect(matchB).toBeDefined();
    expect(matchB!.user_request_text).toBe(exact);
    expect(matchB!.session_id).toBe(sessionId);
  });
});

// ---------------------------------------------------------------------------
// D-FSP2 — Trailing-whitespace difference → NOT a match (v1 byte-identical).
// ---------------------------------------------------------------------------
describe("findSimilarPrompts — D-FSP2 v1 byte-identical only", () => {
  it("does NOT yield a turn whose prompt differs only in trailing whitespace", async () => {
    const sessionId = await seedSession();
    const base = "fsp2: hello world";
    const trailing = "fsp2: hello world "; // one extra trailing space
    const tA = await seedTurn({
      sessionId,
      sequenceNum: 1,
      userRequestText: base,
    });
    const tB = await seedTurn({
      sessionId,
      sequenceNum: 2,
      userRequestText: trailing,
    });

    const matches = await drain(findSimilarPrompts(tA));
    const ids = matches.map((m) => m.turn_id);

    // tB differs in whitespace → must NOT match under v1 hash-only semantics.
    expect(ids).not.toContain(tB);
    // And tA (input) is always excluded.
    expect(ids).not.toContain(tA);
  });
});

// ---------------------------------------------------------------------------
// D-FSP3 — `{ text: "..." }` literal-text input form.
// ---------------------------------------------------------------------------
describe("findSimilarPrompts — D-FSP3 literal-text input shape", () => {
  it("accepts { text } and yields turns whose prompt matches byte-for-byte", async () => {
    const sessionId = await seedSession();
    const literal = "fsp3: exact prompt text here";
    const tX = await seedTurn({
      sessionId,
      sequenceNum: 1,
      userRequestText: literal,
    });
    // A near-miss with an extra char must NOT be returned.
    const tY = await seedTurn({
      sessionId,
      sequenceNum: 2,
      userRequestText: literal + "!",
    });

    const matches = await drain(findSimilarPrompts({ text: literal }));
    const ids = matches.map((m) => m.turn_id);

    expect(ids).toContain(tX);
    expect(ids).not.toContain(tY);

    const matchX = matches.find((m) => m.turn_id === tX);
    expect(matchX).toBeDefined();
    expect(matchX!.user_request_text).toBe(literal);
    expect(matchX!.session_id).toBe(sessionId);
  });
});

// ---------------------------------------------------------------------------
// D-FSP4 — `limit: 3` caps the iterator at 3 yields.
// ---------------------------------------------------------------------------
describe("findSimilarPrompts — D-FSP4 limit option caps yields", () => {
  it("yields exactly 3 results when 5+ matches exist", async () => {
    const sessionId = await seedSession();
    const prompt = "fsp4: shared prompt for the limit test";
    const seed1 = await seedTurn({
      sessionId,
      sequenceNum: 1,
      userRequestText: prompt,
    });
    // Seed 5 more matches (so 6 total share the prompt; minus the input
    // turn, 5 are eligible — `limit: 3` must cap to 3).
    for (let i = 2; i <= 6; i += 1) {
      await seedTurn({
        sessionId,
        sequenceNum: i,
        userRequestText: prompt,
      });
    }

    const matches = await drain(
      findSimilarPrompts(seed1, { limit: 3 }),
    );
    expect(matches.length).toBe(3);
    // None of the yielded matches should be the input turn.
    for (const m of matches) {
      expect(m.turn_id).not.toBe(seed1);
      expect(m.user_request_text).toBe(prompt);
    }
  });
});

// ---------------------------------------------------------------------------
// D-FSP5 — AbortSignal: pre-aborted + mid-iteration abort.
// ---------------------------------------------------------------------------
describe("findSimilarPrompts — D-FSP5 AbortSignal", () => {
  it("(a) pre-aborted signal throws AbortError on the first iteration step", async () => {
    const sessionId = await seedSession();
    const prompt = "fsp5a: never read";
    const seed = await seedTurn({
      sessionId,
      sequenceNum: 1,
      userRequestText: prompt,
    });
    // Add a peer match so the iterator has content to (try to) yield.
    await seedTurn({
      sessionId,
      sequenceNum: 2,
      userRequestText: prompt,
    });

    const ctrl = new AbortController();
    ctrl.abort();

    let caught: unknown = null;
    try {
      // The throw may happen on the very first `for await` step OR before
      // iteration starts (synchronous abort check during iterator setup).
      // Either is acceptable per the deliverable contract.
      for await (const _m of findSimilarPrompts(seed, {
        signal: ctrl.signal,
      })) {
        // If we get here, abort was not honored — fail loudly.
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
    const prompt = "fsp5b: shared mid-iter prompt";
    const seed = await seedTurn({
      sessionId,
      sequenceNum: 1,
      userRequestText: prompt,
    });
    // Seed 5 more peers so there is plenty to yield after the first.
    for (let i = 2; i <= 6; i += 1) {
      await seedTurn({
        sessionId,
        sequenceNum: i,
        userRequestText: prompt,
      });
    }

    const ctrl = new AbortController();
    let firstYielded = false;
    let caught: unknown = null;

    try {
      for await (const _m of findSimilarPrompts(seed, {
        signal: ctrl.signal,
      })) {
        if (!firstYielded) {
          firstYielded = true;
          ctrl.abort();
          continue;
        }
        // If we ever reach a SECOND yield after abort, the implementation
        // failed to honor the signal mid-iteration.
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
// D-FSP6 — Function header documents the v1 limitation + seq-scan perf note.
// Static assertion against the source file containing
// `export function findSimilarPrompts`.
// ---------------------------------------------------------------------------
describe("findSimilarPrompts — D-FSP6 docstring documents v1 caveats", () => {
  // Walk packages/recondo-data/src/**/*.ts and find the file declaring the
  // export. Stays robust if the implementer relocates the file.
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
        if (/export\s+function\s+findSimilarPrompts\b/.test(text)) {
          return full;
        }
      }
    }
    return null;
  }

  it("the source file's leading docstring notes byte-identical-only AND the seq-scan perf concern", () => {
    const srcRoot = join(
      __dirname,
      "..",
      "..",
      "src",
    );
    const file = findSourceFile(srcRoot);
    expect(
      file,
      "expected a src/**/*.ts file declaring `export function findSimilarPrompts`",
    ).not.toBeNull();

    const text = readFileSync(file as string, "utf8");

    // Extract the JSDoc/banner block immediately preceding the export. We
    // accept the test if EITHER (a) any /** ... */ block above the export
    // contains the required phrases, OR (b) the file's top-level comment
    // banner contains them. We grab everything before the `export function
    // findSimilarPrompts` declaration to be robust to comment style.
    const idx = text.search(/export\s+function\s+findSimilarPrompts\b/);
    expect(idx).toBeGreaterThan(0);
    const header = text.slice(0, idx);

    // (a) v1 limitation language.
    const v1LimitationRe =
      /(byte[-\s]?identical|exact[-\s]?match|no\s+whitespace\s+normalization|no\s+normalization|hash[-\s]?only)/i;
    expect(
      v1LimitationRe.test(header),
      "function header must document the v1 byte-identical-only limitation " +
        '(e.g. "byte-identical", "exact match", "no whitespace normalization", or "hash-only")',
    ).toBe(true);

    // (b) seq-scan perf concern.
    const perfRe =
      /(seq[-\s]?scan|sequential\s+scan|no\s+index|prompt_hash\s+column|prompt_hash\b|v1\.5)/i;
    expect(
      perfRe.test(header),
      "function header must document the seq-scan perf tradeoff " +
        '(e.g. "seq scan", "no index", "prompt_hash column", or "v1.5")',
    ).toBe(true);
  });
});
