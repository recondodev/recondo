# `recondo-data`: New Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add seven new operations to the `recondo-data` package — `getTurnRawMetadata`, `getTurnRawChunk`, `compareTurns`, `findSimilarPrompts` (hash-only), `relatedTurns`, `sessionEfficiency`, `toolCallStats`. These unblock specific MCP read tools and the `find_waste` prompt template.

**Architecture:** Each new operation follows the streaming-prep contracts established in Plan B (returns `AsyncIterable<Item>` where list-shaped; accepts optional `AbortSignal`; emits the uniform list envelope for list operations). No new credential-redaction work — v1 keeps the existing path-masking behavior from `placeholder-mask.ts` and defers credential redaction to a future global pass.

**Tech Stack:** TypeScript, the `recondo-data` workspace package (extracted in Plan B), existing PG and object-store drivers.

**Depends on:** Plan B (`recondo-data` extraction) must be complete before this plan runs.

---

## Why this plan exists

Plan B lifts the existing data-access functions out of `api/src/query/builder.ts` and the eight resolver files into `packages/recondo-data/`, applying the streaming-prep contracts (`AsyncIterable`, `AbortSignal`, uniform list envelope, opaque `since` cursors). Plan B does **not** add new behavior — it preserves call sites and adds the workspace boundary.

This plan (C) is the behavior-add phase. The seven new operations enumerated below either back new MCP tools that no existing API resolver covers (raw-byte chunked transport, comparative analytics, hash-based duplicate detection, session-level efficiency rollups, tool-call cost intelligence) or surface relations that already exist in the captured stream but have no read path today.

The MCP tool surface (Plan D) consumes these directly. The GraphQL resolvers in `api/` register thin adapters for any operation that needs a dashboard surface. Both transports share the call site by importing from `recondo-data`.

**Out of v1 scope (deferred to a later global redaction pass):** credential redaction (Anthropic, OpenAI, AWS, GCP, GitHub, Stripe, Slack, Discord, Bearer, JWT, PEM, DB strings, `.env` fragments), the `--hide-pii` flag, depth-of-redaction tests for `tool_use.input` / `tool_result.content`, byte-framing-preservation tests under redaction, audit-log argument redaction, and any test fixtures containing credential-shaped strings. The pre-existing path-masking behavior in `placeholder-mask.ts` (which Plan B already moves into `packages/recondo-data/src/redaction/`) continues to apply on every read path as it does today — that is not new work.

---

## File Structure

All paths are relative to `/Users/andmer/Projects/recondo/`.

### New files (created by this plan)

```
packages/recondo-data/src/
├── operations/
│   ├── getTurnRawMetadata.ts          # raw-byte metadata + 4 KB head sample
│   ├── getTurnRawChunk.ts             # byte-range read, capped at 32 KB
│   ├── compareTurns.ts                # structured diff across N turns
│   ├── findSimilarPrompts.ts          # v1 hash-only duplicate detection
│   ├── relatedTurns.ts                # 5 relation types
│   ├── sessionEfficiency.ts           # cache hit, reuse ratio, TTFT, etc.
│   └── toolCallStats.ts               # per-tool freq/failure/cost
│
└── object-store/
    └── range.ts                       # readRange(hash, offset, length, signal)
                                       #   added if Plan B did not already.
```

### Test files (created by this plan)

```
packages/recondo-data/tests/
├── operations/
│   ├── getTurnRawMetadata.test.ts
│   ├── getTurnRawChunk.test.ts
│   ├── compareTurns.test.ts
│   ├── findSimilarPrompts.test.ts
│   ├── relatedTurns.test.ts
│   ├── sessionEfficiency.test.ts
│   └── toolCallStats.test.ts
│
├── helpers/
│   └── seed.ts                        # seedTurn, seedTurnWithRawBody,
│                                      #   seedSessionWithKnownStats, etc.
│
└── integration/
    ├── exports-coverage.test.ts       # asserts the seven operations are exported
    └── new-ops-end-to-end.test.ts     # seed → call each op → assert shapes
```

### Modified files (already exist; this plan extends them)

```
packages/recondo-data/src/
├── index.ts                           # re-export the seven new operations
└── object-store/index.ts              # ensure readRange is on the public interface
```

No file under `api/` or `mcp/` is modified by this plan. Resolvers and MCP tool handlers that consume the new operations are wired in Plan D.

---

## Conventions

- **TDD throughout.** Each task lists its tests first, runs them red, then implements, then runs green, then commits. A task is not complete until its tests pass.
- **Streaming-prep contracts (from Plan B) apply to every new function.** Restating: returns `AsyncIterable<Item>` where list-shaped; accepts a final `signal?: AbortSignal` arg; list-shape outputs use `{ items, next_offset, truncated, stream_id: null, is_final: true }` when materialized into an envelope by the transport adapter.
- **No credential test fixtures.** Test seeds use benign values — timestamps, integer counts, opaque session IDs (`ses_test_001`), opaque turn IDs, lorem-ipsum prompt text. The tests verify operation correctness, not redaction behavior.
- **Tests use the existing PG dev infra** (`just dev-infra` + `just api-migrate`). The test runner is whatever Plan B chose for the package (assume `vitest`).
- **No tasks may import from `api/` or `mcp/`.** This package is consumed by them; the dependency direction is one-way.
- **Commit cadence.** Each task ends with a commit whose message follows the pattern `recondo-data: add <operation>` or `recondo-data: <test/fix description>`.

---

# Tasks

## Task 1 — Object-store byte-range read (foundation)

The two raw-byte operations (`getTurnRawMetadata`, `getTurnRawChunk`) require a `readRange(hash, offset, length, signal)` primitive on the object-store interface. Plan B may or may not have surfaced this — verify and add if missing.

- [ ] **1.1** Inspect `packages/recondo-data/src/object-store/index.ts`. If `readRange` is already on the `ObjectStore` interface and implemented for the local-filesystem driver, skip to Task 2. Otherwise continue.
- [ ] **1.2** Write a failing test `packages/recondo-data/tests/object-store/range.test.ts`:

  ```typescript
  import { describe, test, expect } from "vitest";
  import { createHash } from "node:crypto";
  import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
  import { join } from "node:path";
  import { tmpdir } from "node:os";
  import { LocalObjectStore } from "../../src/object-store/local";

  describe("ObjectStore.readRange", () => {
    test("returns a Buffer of length min(length, bytes_total - offset)", async () => {
      const root = mkdtempSync(join(tmpdir(), "recondo-rng-"));
      mkdirSync(join(root, "req"), { recursive: true });
      const body = Buffer.alloc(10_000, 0x41);
      const hash = createHash("sha256").update(body).digest("hex");
      writeFileSync(join(root, "req", `${hash}.gz.placeholder`), body); // see note in 1.3

      const store = new LocalObjectStore(root);
      const slice = await store.readRange(hash, 1000, 4096);
      expect(slice.length).toBe(4096);
      expect(slice[0]).toBe(0x41);
    });

    test("clamps length when offset + length > bytes_total", async () => {
      const root = mkdtempSync(join(tmpdir(), "recondo-rng-"));
      const body = Buffer.alloc(2000, 0x42);
      const store = new LocalObjectStore(root);
      const hash = await store.put(body); // existing API
      const slice = await store.readRange(hash, 1500, 4096);
      expect(slice.length).toBe(500);
    });

    test("respects AbortSignal", async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const store = new LocalObjectStore(mkdtempSync(join(tmpdir(), "recondo-rng-")));
      await expect(store.readRange("a".repeat(64), 0, 100, ctrl.signal)).rejects.toThrow(/abort/i);
    });
  });
  ```

- [ ] **1.3** Run the test. It fails because `readRange` is not implemented. The placeholder file path in the first test should be replaced with whatever the actual on-disk format is — inspect the existing `LocalObjectStore.get(hash)` to see how the gzipped object is stored, then read+decompress and slice.
- [ ] **1.4** Add `readRange` to the `ObjectStore` interface and implement on `LocalObjectStore`:

  ```typescript
  // packages/recondo-data/src/object-store/index.ts
  export interface ObjectStore {
    get(hash: string, signal?: AbortSignal): Promise<Buffer>;
    put(bytes: Buffer, signal?: AbortSignal): Promise<string>;
    readRange(hash: string, offset: number, length: number, signal?: AbortSignal): Promise<Buffer>;
  }

  // packages/recondo-data/src/object-store/local.ts
  export class LocalObjectStore implements ObjectStore {
    // ... existing get/put ...
    async readRange(hash: string, offset: number, length: number, signal?: AbortSignal): Promise<Buffer> {
      signal?.throwIfAborted();
      // The current store gzips on put; readRange decompresses fully and slices.
      // A future S3 driver can issue a Range: bytes= request and avoid decompression of the tail.
      const full = await this.get(hash, signal);
      const end = Math.min(offset + length, full.length);
      if (offset >= full.length) return Buffer.alloc(0);
      return full.subarray(offset, end);
    }
  }
  ```

  Document at the top of `range.ts` that the local driver decompresses the full object and slices in-memory; the S3 driver in a later plan can use HTTP `Range:` to avoid the full read.

- [ ] **1.5** Run tests until green. Commit: `recondo-data: add ObjectStore.readRange for byte-range reads`.

## Task 2 — Operation: `getTurnRawMetadata`

Returns the content hash, total byte size, content type, and a small UTF-8 head sample (first 4 KB) so an agent can decide whether to fetch chunks.

- [ ] **2.1** Write a failing test `packages/recondo-data/tests/operations/getTurnRawMetadata.test.ts`:

  ```typescript
  import { describe, test, expect } from "vitest";
  import { getTurnRawMetadata } from "../../src/operations/getTurnRawMetadata";
  import { seedTurnWithRawBody, withTestPool } from "../helpers/seed";

  describe("getTurnRawMetadata", () => {
    test("returns content_hash, bytes_total, content_type, head_sample (<=4096 bytes)", async () => {
      await withTestPool(async (pool) => {
        const body = Buffer.alloc(10_000, 0x41);
        const { turnId, hash } = await seedTurnWithRawBody(pool, body, {
          contentType: "application/json",
        });

        const meta = await getTurnRawMetadata(turnId, {});

        expect(meta.content_hash).toBe(hash);
        expect(meta.bytes_total).toBe(10_000);
        expect(meta.content_type).toBe("application/json");
        expect(Buffer.byteLength(meta.head_sample_utf8, "utf8")).toBeLessThanOrEqual(4096);
        expect(meta.head_sample_utf8.startsWith("AAAA")).toBe(true);
      });
    });

    test("head_sample is the actual first bytes (not arbitrary)", async () => {
      await withTestPool(async (pool) => {
        const body = Buffer.from('{"hello":"world","counter":42}');
        const { turnId } = await seedTurnWithRawBody(pool, body, { contentType: "application/json" });
        const meta = await getTurnRawMetadata(turnId, {});
        expect(meta.head_sample_utf8).toContain('"hello":"world"');
      });
    });

    test("respects AbortSignal", async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(getTurnRawMetadata("trn_does_not_matter", { signal: ctrl.signal })).rejects.toThrow(/abort/i);
    });
  });
  ```

- [ ] **2.2** Run the test. It fails because `getTurnRawMetadata.ts` does not exist.
- [ ] **2.3** Implement `packages/recondo-data/src/operations/getTurnRawMetadata.ts`:

  ```typescript
  import { getObjectStore } from "../object-store";
  import { getPool } from "../db/pool";

  export interface RawMetadata {
    content_hash: string;
    bytes_total: number;
    content_type: string;
    head_sample_utf8: string;
  }

  /**
   * Returns hash + size + 4 KB head sample for the request body of a turn.
   *
   * Pairs with `getTurnRawChunk` for agent-controlled streaming of bodies that
   * exceed a 32 KB MCP response budget. The agent inspects metadata first, then
   * decides whether to fetch chunks.
   *
   * Path-masking from `placeholder-mask.ts` continues to apply via the existing
   * read pipeline. Credential redaction is deferred to a later global pass — the
   * head sample is returned exactly as stored (modulo path-masking).
   */
  export async function getTurnRawMetadata(
    turnId: string,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<RawMetadata> {
    signal?.throwIfAborted();

    const pool = getPool();
    const r = await pool.query(
      `SELECT request_content_hash, request_bytes_total, request_content_type
         FROM turns
        WHERE id = $1`,
      [turnId],
    );
    if (r.rowCount === 0) throw new Error(`turn ${turnId} not found`);
    const row = r.rows[0];

    const store = getObjectStore();
    const head = await store.readRange(row.request_content_hash, 0, 4096, signal);

    return {
      content_hash: row.request_content_hash,
      bytes_total: row.request_bytes_total,
      content_type: row.request_content_type,
      head_sample_utf8: head.toString("utf8"),
    };
  }
  ```

- [ ] **2.4** Add helpers in `packages/recondo-data/tests/helpers/seed.ts`:
  - `withTestPool(fn)` — creates a transaction-scoped PG pool against the dev infra and rolls back at the end.
  - `seedTurnWithRawBody(pool, body, { contentType })` — inserts a `turns` row with `request_content_hash`, `request_bytes_total`, `request_content_type` populated, and writes the body to the local object store under that hash. Returns `{ turnId, hash }`.

  No credential-shaped data appears anywhere in seed helpers.

- [ ] **2.5** Run tests until green. Add `export { getTurnRawMetadata } from "./operations/getTurnRawMetadata";` to `packages/recondo-data/src/index.ts`. Commit: `recondo-data: add getTurnRawMetadata for raw-body metadata + 4 KB head sample`.

## Task 3 — Operation: `getTurnRawChunk`

Byte-range read of a turn's request body, capped at 32 KB per call.

- [ ] **3.1** Write a failing test `packages/recondo-data/tests/operations/getTurnRawChunk.test.ts`:

  ```typescript
  import { describe, test, expect } from "vitest";
  import { getTurnRawChunk } from "../../src/operations/getTurnRawChunk";
  import { seedTurnWithRawBody, withTestPool } from "../helpers/seed";

  describe("getTurnRawChunk", () => {
    test("returns up to 32 KB from the requested offset", async () => {
      await withTestPool(async (pool) => {
        const body = Buffer.alloc(100_000, 0x42);
        const { turnId } = await seedTurnWithRawBody(pool, body, { contentType: "application/octet-stream" });

        const chunk = await getTurnRawChunk(turnId, 1000, 32_768, {});

        expect(chunk.offset).toBe(1000);
        expect(chunk.bytes.length).toBe(32_768);
        expect(chunk.next_offset).toBe(1000 + 32_768);
      });
    });

    test("caps requested length at 32 KB", async () => {
      await withTestPool(async (pool) => {
        const body = Buffer.alloc(100_000, 0x43);
        const { turnId } = await seedTurnWithRawBody(pool, body, { contentType: "x" });
        const chunk = await getTurnRawChunk(turnId, 0, 999_999, {});
        expect(chunk.bytes.length).toBe(32_768);
      });
    });

    test("returns next_offset=null at end of body", async () => {
      await withTestPool(async (pool) => {
        const body = Buffer.alloc(1000, 0x44);
        const { turnId } = await seedTurnWithRawBody(pool, body, { contentType: "x" });
        const chunk = await getTurnRawChunk(turnId, 0, 32_768, {});
        expect(chunk.bytes.length).toBe(1000);
        expect(chunk.next_offset).toBeNull();
      });
    });

    test("respects AbortSignal", async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(getTurnRawChunk("trn_x", 0, 100, { signal: ctrl.signal })).rejects.toThrow(/abort/i);
    });
  });
  ```

- [ ] **3.2** Run the test. It fails because the file does not exist.
- [ ] **3.3** Implement `packages/recondo-data/src/operations/getTurnRawChunk.ts`:

  ```typescript
  import { getObjectStore } from "../object-store";
  import { getPool } from "../db/pool";

  const MAX_CHUNK = 32_768;

  export interface RawChunk {
    offset: number;
    bytes: Buffer;
    next_offset: number | null;
  }

  /**
   * Read a byte range from a turn's request body. Length is capped at 32 KB per
   * call. Pair with `getTurnRawMetadata` to discover total size first.
   *
   * `next_offset` is `offset + bytes.length` if more bytes remain, or `null` at EOF.
   */
  export async function getTurnRawChunk(
    turnId: string,
    offset: number,
    length: number,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<RawChunk> {
    signal?.throwIfAborted();
    if (offset < 0) throw new Error("offset must be >= 0");
    if (length < 0) throw new Error("length must be >= 0");

    const cap = Math.min(length, MAX_CHUNK);

    const pool = getPool();
    const r = await pool.query(
      `SELECT request_content_hash, request_bytes_total
         FROM turns
        WHERE id = $1`,
      [turnId],
    );
    if (r.rowCount === 0) throw new Error(`turn ${turnId} not found`);
    const { request_content_hash: hash, request_bytes_total: total } = r.rows[0];

    const store = getObjectStore();
    const slice = await store.readRange(hash, offset, cap, signal);

    const consumed = offset + slice.length;
    const nextOffset = consumed < total ? consumed : null;

    return { offset, bytes: slice, next_offset: nextOffset };
  }
  ```

- [ ] **3.4** Run tests until green. Add the export to `index.ts`. Commit: `recondo-data: add getTurnRawChunk for byte-range body reads (32 KB cap)`.

## Task 4 — Operation: `compareTurns`

Structured side-by-side diff over a list of turns. Default aspects cover prompt, response, tools, cost, tokens, and model.

- [ ] **4.1** Write a failing test `packages/recondo-data/tests/operations/compareTurns.test.ts`:

  ```typescript
  import { describe, test, expect } from "vitest";
  import { compareTurns } from "../../src/operations/compareTurns";
  import { seedTurn, withTestPool } from "../helpers/seed";

  describe("compareTurns", () => {
    test("default aspects: prompt, response, tools, cost, tokens, model", async () => {
      await withTestPool(async (pool) => {
        const t1 = await seedTurn(pool, {
          model: "claude-3-5-sonnet",
          prompt: "explain postgres indexes",
          input_tokens: 100, output_tokens: 50, cost_usd: 0.01,
        });
        const t2 = await seedTurn(pool, {
          model: "claude-3-5-sonnet",
          prompt: "explain postgres indexes carefully",
          input_tokens: 300, output_tokens: 50, cost_usd: 0.03,
        });

        const diff = await compareTurns([t1, t2], undefined, {});

        expect(diff.turn_ids).toEqual([t1, t2]);
        expect(diff.aspects.sort()).toEqual(["cost", "model", "prompt", "response", "tokens", "tools"]);
        const cost = diff.rows.find((r) => r.aspect === "cost")!;
        expect(cost.values).toEqual([0.01, 0.03]);
        expect(cost.delta).toBeCloseTo(0.02, 6);

        const model = diff.rows.find((r) => r.aspect === "model")!;
        expect(model.values).toEqual(["claude-3-5-sonnet", "claude-3-5-sonnet"]);
        expect(model.delta).toBeNull();
      });
    });

    test("subset aspects via aspects argument", async () => {
      await withTestPool(async (pool) => {
        const t1 = await seedTurn(pool, { cost_usd: 0.01 });
        const t2 = await seedTurn(pool, { cost_usd: 0.05 });
        const diff = await compareTurns([t1, t2], ["cost"], {});
        expect(diff.aspects).toEqual(["cost"]);
        expect(diff.rows).toHaveLength(1);
        expect(diff.rows[0].aspect).toBe("cost");
      });
    });

    test("respects AbortSignal", async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(compareTurns(["a", "b"], undefined, { signal: ctrl.signal })).rejects.toThrow(/abort/i);
    });
  });
  ```

- [ ] **4.2** Run the test. It fails. Implement `packages/recondo-data/src/operations/compareTurns.ts`:

  ```typescript
  import { getPool } from "../db/pool";

  export type CompareAspect = "prompt" | "response" | "tools" | "cost" | "tokens" | "model";

  const ALL_ASPECTS: CompareAspect[] = ["prompt", "response", "tools", "cost", "tokens", "model"];

  export interface DiffRow {
    aspect: CompareAspect;
    values: unknown[];
    delta: number | null; // numeric delta where applicable; null otherwise
  }

  export interface CompareResult {
    turn_ids: string[];
    aspects: CompareAspect[];
    rows: DiffRow[];
  }

  /**
   * Side-by-side diff of N turns. One row per aspect; row.values is parallel to turn_ids.
   *
   * `delta` is populated for numeric aspects (cost, tokens) as max - min; null for text/model.
   *
   * Replaces N `getTurn` calls + agent-side diff math (which the agent reliably gets wrong on
   * long bodies). Backs the `recondo_compare_turns` MCP tool.
   */
  export async function compareTurns(
    turnIds: string[],
    aspects: CompareAspect[] | undefined,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<CompareResult> {
    signal?.throwIfAborted();
    if (turnIds.length === 0) throw new Error("compareTurns requires at least one turn_id");

    const want = aspects ?? ALL_ASPECTS;
    const pool = getPool();
    const r = await pool.query(
      `SELECT id, model, prompt_text, response_text, tool_call_names,
              input_tokens, output_tokens, cost_usd
         FROM turns
        WHERE id = ANY($1::text[])`,
      [turnIds],
    );
    // Preserve caller-specified order
    const byId = new Map(r.rows.map((row) => [row.id, row]));
    const ordered = turnIds.map((id) => {
      const row = byId.get(id);
      if (!row) throw new Error(`turn ${id} not found`);
      return row;
    });

    const rows: DiffRow[] = [];
    for (const aspect of want) {
      switch (aspect) {
        case "prompt":
          rows.push({ aspect, values: ordered.map((o) => o.prompt_text), delta: null });
          break;
        case "response":
          rows.push({ aspect, values: ordered.map((o) => o.response_text), delta: null });
          break;
        case "tools":
          rows.push({ aspect, values: ordered.map((o) => o.tool_call_names ?? []), delta: null });
          break;
        case "cost": {
          const vals = ordered.map((o) => Number(o.cost_usd ?? 0));
          rows.push({ aspect, values: vals, delta: numericDelta(vals) });
          break;
        }
        case "tokens": {
          const vals = ordered.map((o) => Number(o.input_tokens ?? 0) + Number(o.output_tokens ?? 0));
          rows.push({ aspect, values: vals, delta: numericDelta(vals) });
          break;
        }
        case "model":
          rows.push({ aspect, values: ordered.map((o) => o.model), delta: null });
          break;
      }
    }

    return { turn_ids: turnIds, aspects: want, rows };
  }

  function numericDelta(vals: number[]): number {
    if (vals.length < 2) return 0;
    return Math.max(...vals) - Math.min(...vals);
  }
  ```

- [ ] **4.3** Run tests until green. Add the export to `index.ts`. Commit: `recondo-data: add compareTurns for structured turn diffs`.

## Task 5 — Operation: `findSimilarPrompts` (v1 hash-only)

Hash-only byte-identical detection over `turns.prompt_hash`. Embedding-based fuzzy match is deferred to v1.5.

- [ ] **5.1** Write a failing test `packages/recondo-data/tests/operations/findSimilarPrompts.test.ts`:

  ```typescript
  import { describe, test, expect } from "vitest";
  import { findSimilarPrompts } from "../../src/operations/findSimilarPrompts";
  import { seedTurn, withTestPool } from "../helpers/seed";

  describe("findSimilarPrompts (v1 hash-only)", () => {
    test("matches byte-identical prompts via prompt_hash", async () => {
      await withTestPool(async (pool) => {
        const prompt = "tell me about postgres indexes";
        const t1 = await seedTurn(pool, { prompt });
        const t2 = await seedTurn(pool, { prompt });
        const t3 = await seedTurn(pool, { prompt: "tell me about postgres indexes " }); // trailing space

        const out: any[] = [];
        for await (const m of findSimilarPrompts(t1, { limit: 10 })) out.push(m);

        const ids = out.map((m) => m.turn_id);
        expect(ids).toContain(t2);
        expect(ids).not.toContain(t3); // v1 is hash-only; whitespace differs
      });
    });

    test("accepts raw text input", async () => {
      await withTestPool(async (pool) => {
        const prompt = "raw text input search";
        const t1 = await seedTurn(pool, { prompt });
        const out: any[] = [];
        for await (const m of findSimilarPrompts({ text: prompt }, { limit: 10 })) out.push(m);
        expect(out.map((m) => m.turn_id)).toContain(t1);
      });
    });

    test("limit caps the iterator", async () => {
      await withTestPool(async (pool) => {
        const prompt = "limit test";
        for (let i = 0; i < 5; i++) await seedTurn(pool, { prompt });
        const out: any[] = [];
        for await (const m of findSimilarPrompts({ text: prompt }, { limit: 3 })) out.push(m);
        expect(out.length).toBe(3);
      });
    });

    test("respects AbortSignal mid-iteration", async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const it = findSimilarPrompts({ text: "x" }, { limit: 10, signal: ctrl.signal });
      await expect((async () => { for await (const _ of it); })()).rejects.toThrow(/abort/i);
    });
  });
  ```

- [ ] **5.2** Run the test. It fails. Implement `packages/recondo-data/src/operations/findSimilarPrompts.ts`:

  ```typescript
  import { createHash } from "node:crypto";
  import { getPool } from "../db/pool";

  export interface SimilarPromptMatch {
    turn_id: string;
    session_id: string;
    prompt_hash: string;
    captured_at: string;
  }

  /**
   * v1: hash-only (byte-identical) similarity. Captures are content-addressable
   * via `turns.prompt_hash` already, so this is a free index lookup.
   *
   * v1.5: embedding-based fuzzy match (planned). Requires a vector store +
   * background indexing job — substantial new infrastructure deferred.
   *
   * Real-world prompts often differ by whitespace, system-prompt date stamps,
   * model-name strings, or trace IDs. v1 will return zero matches for prompts a
   * user thinks are duplicates. The MCP tool description and the find_waste
   * prompt template both call this out explicitly.
   */
  export async function* findSimilarPrompts(
    input: string | { text: string },
    {
      limit = 20,
      scope = "prompt",
      signal,
    }: { limit?: number; scope?: "prompt" | "response"; signal?: AbortSignal } = {},
  ): AsyncIterable<SimilarPromptMatch> {
    signal?.throwIfAborted();
    const pool = getPool();
    const hash = await resolveHash(pool, input, scope, signal);

    const r = await pool.query(
      `SELECT id AS turn_id, session_id, prompt_hash, captured_at
         FROM turns
        WHERE prompt_hash = $1
        ORDER BY captured_at DESC
        LIMIT $2`,
      [hash, limit],
    );

    for (const row of r.rows) {
      signal?.throwIfAborted();
      yield {
        turn_id: row.turn_id,
        session_id: row.session_id,
        prompt_hash: row.prompt_hash,
        captured_at: row.captured_at instanceof Date ? row.captured_at.toISOString() : String(row.captured_at),
      };
    }
  }

  async function resolveHash(
    pool: ReturnType<typeof getPool>,
    input: string | { text: string },
    scope: "prompt" | "response",
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    if (typeof input === "object" && "text" in input) {
      return createHash("sha256").update(input.text, "utf8").digest("hex");
    }
    const col = scope === "prompt" ? "prompt_hash" : "response_hash";
    const r = await pool.query(`SELECT ${col} AS h FROM turns WHERE id = $1`, [input]);
    if (r.rowCount === 0) throw new Error(`turn ${input} not found`);
    return r.rows[0].h;
  }
  ```

- [ ] **5.3** Run tests until green. Confirm the trailing-space case correctly returns NO match (v1 limitation working as designed). Add the export to `index.ts`. Commit: `recondo-data: add findSimilarPrompts (v1 hash-only)`.

## Task 6 — Operation: `relatedTurns`

Surfaces turns related to a given one via one of five relation types. The data already exists in the captured stream; this operation packages it.

- [ ] **6.1** Inspect the live `turns` schema (`just dev-infra` running, then `\d turns` in `psql`) to confirm which columns back each relation:
  - `same_prompt_hash` — uses `prompt_hash`
  - `same_session` — uses `session_id`
  - `same_tool_chain` — needs a `tool_chain_id` or equivalent; if absent, derive from the `tool_calls` table joined on a chain key
  - `caused_by` — column expected on `turns` (`caused_by_turn_id` or similar)
  - `retry_of` — column expected on `turns` (`retry_of_turn_id` or similar)

  If `caused_by` / `retry_of` / `tool_chain_id` columns do not exist, document the gap in this task and either (a) coordinate with Plan B to add them, or (b) reduce the relation set for v1 and update the MCP tool description in Plan D. Do not invent columns silently.

- [ ] **6.2** Write a failing test `packages/recondo-data/tests/operations/relatedTurns.test.ts`:

  ```typescript
  import { describe, test, expect } from "vitest";
  import { relatedTurns } from "../../src/operations/relatedTurns";
  import { seedTurn, seedRelations, withTestPool } from "../helpers/seed";

  describe("relatedTurns", () => {
    test.each(["same_prompt_hash", "same_session", "same_tool_chain", "caused_by", "retry_of"] as const)(
      "relation: %s",
      async (relation) => {
        await withTestPool(async (pool) => {
          const seed = await seedRelations(pool, relation);
          const out: any[] = [];
          for await (const t of relatedTurns(seed.targetTurn, relation, {})) out.push(t);
          expect(out.map((x) => x.turn_id).sort()).toEqual(seed.expectedRelated.sort());
        });
      },
    );

    test("rejects unknown relation", async () => {
      await expect(
        (async () => { for await (const _ of relatedTurns("trn_x", "bogus" as any, {})); })(),
      ).rejects.toThrow(/unknown relation/i);
    });

    test("respects AbortSignal", async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(
        (async () => { for await (const _ of relatedTurns("trn_x", "same_session", { signal: ctrl.signal })); })(),
      ).rejects.toThrow(/abort/i);
    });
  });
  ```

  In `seed.ts`, `seedRelations(pool, relation)` creates the minimum row set for the relation (e.g., for `same_session`: insert two turns sharing one session, return the first as `targetTurn` and the second's id in `expectedRelated`).

- [ ] **6.3** Run the test. It fails. Implement `packages/recondo-data/src/operations/relatedTurns.ts`:

  ```typescript
  import { getPool } from "../db/pool";

  export type Relation = "same_prompt_hash" | "same_session" | "same_tool_chain" | "caused_by" | "retry_of";

  export interface RelatedTurn {
    turn_id: string;
    session_id: string;
    captured_at: string;
    relation: Relation;
  }

  /**
   * Surfaces turns related to a given one via one of five relation types.
   * All relations come from columns already present in the captured stream —
   * this is a packaging convenience, not new analysis.
   */
  export async function* relatedTurns(
    turnId: string,
    relation: Relation,
    { signal }: { signal?: AbortSignal } = {},
  ): AsyncIterable<RelatedTurn> {
    signal?.throwIfAborted();
    const pool = getPool();
    const sql = SQL_FOR_RELATION[relation];
    if (!sql) throw new Error(`unknown relation: ${relation}`);

    const r = await pool.query(sql, [turnId]);
    for (const row of r.rows) {
      signal?.throwIfAborted();
      yield {
        turn_id: row.id,
        session_id: row.session_id,
        captured_at: row.captured_at instanceof Date ? row.captured_at.toISOString() : String(row.captured_at),
        relation,
      };
    }
  }

  const SQL_FOR_RELATION: Record<Relation, string> = {
    same_prompt_hash: `
      SELECT id, session_id, captured_at FROM turns
       WHERE prompt_hash = (SELECT prompt_hash FROM turns WHERE id = $1)
         AND id <> $1
       ORDER BY captured_at DESC`,
    same_session: `
      SELECT id, session_id, captured_at FROM turns
       WHERE session_id = (SELECT session_id FROM turns WHERE id = $1)
         AND id <> $1
       ORDER BY captured_at ASC`,
    same_tool_chain: `
      SELECT id, session_id, captured_at FROM turns
       WHERE tool_chain_id = (SELECT tool_chain_id FROM turns WHERE id = $1)
         AND tool_chain_id IS NOT NULL
         AND id <> $1
       ORDER BY captured_at ASC`,
    caused_by: `
      SELECT id, session_id, captured_at FROM turns
       WHERE id = (SELECT caused_by_turn_id FROM turns WHERE id = $1)`,
    retry_of: `
      SELECT id, session_id, captured_at FROM turns
       WHERE retry_of_turn_id = $1
          OR id = (SELECT retry_of_turn_id FROM turns WHERE id = $1)`,
  };
  ```

  Adjust column names to match what step 6.1 confirmed.

- [ ] **6.4** Run tests until green. Add the export to `index.ts`. Commit: `recondo-data: add relatedTurns covering five relation types`.

## Task 7 — Operation: `sessionEfficiency`

Per-session rollup: cache hit rate, prompt-token reuse ratio, tokens-per-turn distribution, redundant tool-call count, time-to-first-token p50/p99.

- [ ] **7.1** Write a failing test `packages/recondo-data/tests/operations/sessionEfficiency.test.ts`:

  ```typescript
  import { describe, test, expect } from "vitest";
  import { sessionEfficiency } from "../../src/operations/sessionEfficiency";
  import { seedSessionWithKnownStats, seedEmptySession, withTestPool } from "../helpers/seed";

  describe("sessionEfficiency", () => {
    test("computes cache hit rate, prompt-token reuse, ttft p50/p99, redundant tool calls", async () => {
      await withTestPool(async (pool) => {
        // Seed a session with controlled stats. seedSessionWithKnownStats inserts:
        //   - 10 turns
        //   - sum(input_tokens) = 1000, sum(cache_read_input_tokens) = 700  -> cache_hit_rate 0.7
        //   - 3 of 10 prompts share a hash with another turn  -> prompt_token_reuse_ratio 0.3
        //   - tokensPerTurn input + output values for percentile assertions
        //   - ttft_ms values [50,60,55,70,80,90,65,55,60,1200]  -> p99 ~= 1200
        //   - 2 tool_call rows duplicated by (tool_name, args_hash) within the session
        const sessionId = await seedSessionWithKnownStats(pool, {
          turns: 10,
          inputTokensTotal: 1000,
          cacheReadTotal: 700,
          duplicatePromptHashes: 3,
          tokensPerTurn: [100, 200, 100, 150, 200, 250, 300, 100, 100, 100],
          ttftMs: [50, 60, 55, 70, 80, 90, 65, 55, 60, 1200],
          duplicateToolCalls: 2,
        });

        const eff = await sessionEfficiency(sessionId, {});

        expect(eff.session_id).toBe(sessionId);
        expect(eff.cache_hit_rate).toBeCloseTo(0.7, 2);
        expect(eff.prompt_token_reuse_ratio).toBeCloseTo(0.3, 2);
        expect(eff.tokens_per_turn.p50).toBeGreaterThan(0);
        expect(eff.tokens_per_turn.p99).toBeGreaterThanOrEqual(eff.tokens_per_turn.p50);
        expect(eff.redundant_tool_call_count).toBe(2);
        expect(eff.ttft_ms.p50).toBeLessThan(eff.ttft_ms.p99);
        expect(eff.ttft_ms.p99).toBeGreaterThanOrEqual(1000);
      });
    });

    test("returns zeros for empty session", async () => {
      await withTestPool(async (pool) => {
        const sessionId = await seedEmptySession(pool);
        const eff = await sessionEfficiency(sessionId, {});
        expect(eff.cache_hit_rate).toBe(0);
        expect(eff.prompt_token_reuse_ratio).toBe(0);
        expect(eff.tokens_per_turn.p50).toBe(0);
        expect(eff.redundant_tool_call_count).toBe(0);
        expect(eff.ttft_ms.p50).toBe(0);
      });
    });

    test("respects AbortSignal", async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(sessionEfficiency("ses_x", { signal: ctrl.signal })).rejects.toThrow(/abort/i);
    });
  });
  ```

- [ ] **7.2** Run the test. It fails. Implement `packages/recondo-data/src/operations/sessionEfficiency.ts`:

  ```typescript
  import { getPool } from "../db/pool";

  export interface Distribution {
    p50: number;
    p99: number;
    mean: number;
  }

  export interface SessionEfficiency {
    session_id: string;
    cache_hit_rate: number;          // sum(cache_read_input_tokens) / sum(input_tokens)
    prompt_token_reuse_ratio: number; // turns whose prompt_hash is seen elsewhere in session / total turns
    tokens_per_turn: Distribution;    // over input_tokens + output_tokens
    redundant_tool_call_count: number; // tool_calls with duplicate (tool_name, args_hash) within session
    ttft_ms: Distribution;            // over time_to_first_token_ms
  }

  /**
   * Per-session efficiency rollup. Computed in one PG round-trip with window functions
   * and percentile_disc so the agent does not need to fetch every turn and aggregate
   * in-context (which usually exceeds the context window for long sessions).
   */
  export async function sessionEfficiency(
    sessionId: string,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<SessionEfficiency> {
    signal?.throwIfAborted();
    const pool = getPool();

    // Single multi-CTE query computes all metrics in one round-trip.
    const r = await pool.query(
      `
      WITH turn_stats AS (
        SELECT
          input_tokens,
          output_tokens,
          cache_read_input_tokens,
          time_to_first_token_ms,
          prompt_hash
        FROM turns
        WHERE session_id = $1
      ),
      cache AS (
        SELECT
          COALESCE(SUM(input_tokens), 0)            AS sum_input,
          COALESCE(SUM(cache_read_input_tokens), 0) AS sum_cache_read
        FROM turn_stats
      ),
      reuse AS (
        SELECT
          COUNT(*)                                                                         AS total_turns,
          COUNT(*) FILTER (WHERE prompt_hash IN (
            SELECT prompt_hash FROM turn_stats GROUP BY prompt_hash HAVING COUNT(*) > 1
          )) AS duplicated_turns
        FROM turn_stats
      ),
      tokens_per_turn AS (
        SELECT
          COALESCE(percentile_disc(0.5)  WITHIN GROUP (ORDER BY input_tokens + output_tokens), 0) AS p50,
          COALESCE(percentile_disc(0.99) WITHIN GROUP (ORDER BY input_tokens + output_tokens), 0) AS p99,
          COALESCE(AVG(input_tokens + output_tokens), 0) AS mean
        FROM turn_stats
      ),
      ttft AS (
        SELECT
          COALESCE(percentile_disc(0.5)  WITHIN GROUP (ORDER BY time_to_first_token_ms), 0) AS p50,
          COALESCE(percentile_disc(0.99) WITHIN GROUP (ORDER BY time_to_first_token_ms), 0) AS p99,
          COALESCE(AVG(time_to_first_token_ms), 0) AS mean
        FROM turn_stats
      ),
      redundant_tools AS (
        SELECT COALESCE(SUM(dup_count), 0) AS redundant_count
        FROM (
          SELECT GREATEST(COUNT(*) - 1, 0) AS dup_count
          FROM tool_calls tc
          JOIN turns t ON t.id = tc.turn_id
          WHERE t.session_id = $1
          GROUP BY tc.tool_name, tc.args_hash
        ) dups
      )
      SELECT
        cache.sum_cache_read::float       AS cache_read,
        cache.sum_input::float            AS sum_input,
        reuse.total_turns::int            AS total_turns,
        reuse.duplicated_turns::int       AS duplicated_turns,
        tokens_per_turn.p50::float        AS tokens_p50,
        tokens_per_turn.p99::float        AS tokens_p99,
        tokens_per_turn.mean::float       AS tokens_mean,
        ttft.p50::float                   AS ttft_p50,
        ttft.p99::float                   AS ttft_p99,
        ttft.mean::float                  AS ttft_mean,
        redundant_tools.redundant_count::int AS redundant_count
      FROM cache, reuse, tokens_per_turn, ttft, redundant_tools
      `,
      [sessionId],
    );

    signal?.throwIfAborted();
    const row = r.rows[0];
    const cacheHit = row.sum_input > 0 ? row.cache_read / row.sum_input : 0;
    const reuseRatio = row.total_turns > 0 ? row.duplicated_turns / row.total_turns : 0;

    return {
      session_id: sessionId,
      cache_hit_rate: cacheHit,
      prompt_token_reuse_ratio: reuseRatio,
      tokens_per_turn: { p50: row.tokens_p50, p99: row.tokens_p99, mean: row.tokens_mean },
      redundant_tool_call_count: row.redundant_count,
      ttft_ms: { p50: row.ttft_p50, p99: row.ttft_p99, mean: row.ttft_mean },
    };
  }
  ```

  If the actual `tool_calls` table does not have an `args_hash` column, fall back to hashing `(tool_name || args_json)` inside the query via `md5(tc.tool_name || tc.args_json::text)`. Confirm the schema in step 6.1's inspection pass.

- [ ] **7.3** Run tests until green. Add the export to `index.ts`. Commit: `recondo-data: add sessionEfficiency rollup with percentile distributions`.

## Task 8 — Operation: `toolCallStats`

Per-tool frequency, failure rate, average latency, total token cost. Grouped by tool name, session, or framework.

- [ ] **8.1** Write a failing test `packages/recondo-data/tests/operations/toolCallStats.test.ts`:

  ```typescript
  import { describe, test, expect } from "vitest";
  import { toolCallStats } from "../../src/operations/toolCallStats";
  import { seedToolCalls, withTestPool } from "../helpers/seed";

  describe("toolCallStats", () => {
    test("group_by tool_name returns per-tool frequency, failure_rate, avg_latency, token_cost", async () => {
      await withTestPool(async (pool) => {
        await seedToolCalls(pool, [
          { tool_name: "Bash", success: true,  latency_ms: 100, token_cost: 50 },
          { tool_name: "Bash", success: false, latency_ms: 200, token_cost: 100 },
          { tool_name: "Read", success: true,  latency_ms: 50,  token_cost: 30 },
        ]);

        const out: any[] = [];
        for await (const row of toolCallStats({ period: "24h", group_by: "tool_name" })) out.push(row);

        const bash = out.find((r) => r.key === "Bash")!;
        expect(bash.calls).toBe(2);
        expect(bash.failure_rate).toBeCloseTo(0.5, 2);
        expect(bash.avg_latency_ms).toBe(150);
        expect(bash.token_cost_total).toBe(150);

        const read = out.find((r) => r.key === "Read")!;
        expect(read.calls).toBe(1);
        expect(read.failure_rate).toBe(0);
      });
    });

    test.each(["tool_name", "session", "framework"] as const)(
      "group_by %s returns rows keyed by that dimension",
      async (dim) => {
        await withTestPool(async (pool) => {
          await seedToolCalls(pool, [{ tool_name: "X", success: true, latency_ms: 1, token_cost: 1 }]);
          const out: any[] = [];
          for await (const row of toolCallStats({ period: "7d", group_by: dim })) out.push(row);
          for (const row of out) {
            expect(typeof row.key).toBe("string");
            expect(typeof row.calls).toBe("number");
          }
        });
      },
    );

    test("respects AbortSignal", async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(
        (async () => { for await (const _ of toolCallStats({ period: "24h", signal: ctrl.signal })); })(),
      ).rejects.toThrow(/abort/i);
    });
  });
  ```

- [ ] **8.2** Run the test. It fails. Implement `packages/recondo-data/src/operations/toolCallStats.ts`:

  ```typescript
  import { getPool } from "../db/pool";

  export type Period = "1h" | "24h" | "7d" | "30d";
  export type GroupBy = "tool_name" | "session" | "framework";

  export interface ToolCallStatRow {
    key: string;          // tool name, session id, or framework id depending on group_by
    calls: number;
    failure_rate: number;
    avg_latency_ms: number;
    token_cost_total: number;
  }

  /**
   * Aggregates tool_calls over a time window, grouped by one of three dimensions.
   * Backs the `recondo_tool_call_stats` MCP tool ("which MCP tools are wasting my budget").
   */
  export async function* toolCallStats(
    {
      period,
      group_by = "tool_name",
      signal,
    }: { period: Period; group_by?: GroupBy; signal?: AbortSignal },
  ): AsyncIterable<ToolCallStatRow> {
    signal?.throwIfAborted();
    const interval = PERIOD_INTERVAL[period];
    if (!interval) throw new Error(`unknown period: ${period}`);

    const groupCol = GROUP_COLUMN[group_by];
    if (!groupCol) throw new Error(`unknown group_by: ${group_by}`);

    const pool = getPool();
    const r = await pool.query(
      `
      SELECT
        ${groupCol} AS key,
        COUNT(*)::int                                                       AS calls,
        AVG(CASE WHEN tc.success THEN 0.0 ELSE 1.0 END)::float              AS failure_rate,
        AVG(tc.latency_ms)::float                                           AS avg_latency_ms,
        COALESCE(SUM(tc.token_cost), 0)::float                              AS token_cost_total
      FROM tool_calls tc
      JOIN turns t ON t.id = tc.turn_id
      JOIN sessions s ON s.id = t.session_id
      WHERE tc.captured_at >= now() - $1::interval
      GROUP BY ${groupCol}
      ORDER BY calls DESC
      `,
      [interval],
    );

    for (const row of r.rows) {
      signal?.throwIfAborted();
      yield {
        key: String(row.key),
        calls: row.calls,
        failure_rate: Number(row.failure_rate ?? 0),
        avg_latency_ms: Number(row.avg_latency_ms ?? 0),
        token_cost_total: Number(row.token_cost_total ?? 0),
      };
    }
  }

  const PERIOD_INTERVAL: Record<Period, string> = {
    "1h":  "1 hour",
    "24h": "24 hours",
    "7d":  "7 days",
    "30d": "30 days",
  };

  const GROUP_COLUMN: Record<GroupBy, string> = {
    tool_name: "tc.tool_name",
    session:   "t.session_id",
    framework: "s.agent_framework",
  };
  ```

  If the live `sessions` table uses a different column for framework (e.g., `framework_id`), update the `GROUP_COLUMN` mapping after step 6.1's schema inspection.

- [ ] **8.3** Run tests until green. Add the export to `index.ts`. Commit: `recondo-data: add toolCallStats with group_by tool_name|session|framework`.

## Task 9 — Exports and parity guard

Confirm all seven new operations are exported from the package root so Plan D's catalog-parity lint can find them.

- [ ] **9.1** Verify `packages/recondo-data/src/index.ts` re-exports each operation:

  ```typescript
  export { getTurnRawMetadata } from "./operations/getTurnRawMetadata";
  export { getTurnRawChunk }    from "./operations/getTurnRawChunk";
  export { compareTurns }        from "./operations/compareTurns";
  export { findSimilarPrompts }  from "./operations/findSimilarPrompts";
  export { relatedTurns }        from "./operations/relatedTurns";
  export { sessionEfficiency }   from "./operations/sessionEfficiency";
  export { toolCallStats }       from "./operations/toolCallStats";
  ```

- [ ] **9.2** Write `packages/recondo-data/tests/integration/exports-coverage.test.ts`:

  ```typescript
  import { describe, test, expect } from "vitest";
  import * as data from "../../src";

  describe("recondo-data new-operation exports", () => {
    test("seven new operations are exported as functions", () => {
      const expected = [
        "getTurnRawMetadata",
        "getTurnRawChunk",
        "compareTurns",
        "findSimilarPrompts",
        "relatedTurns",
        "sessionEfficiency",
        "toolCallStats",
      ];
      for (const name of expected) {
        expect(typeof (data as any)[name]).toBe("function");
      }
    });
  });
  ```

- [ ] **9.3** Run the test. Should pass after Tasks 2–8 land their respective exports. Commit: `recondo-data: lock seven-operation export contract`.

## Task 10 — Streaming-prep contract verification

Plan B established the streaming-prep contracts for all read functions. Verify the seven new operations comply.

- [ ] **10.1** Write `packages/recondo-data/tests/integration/streaming-contracts.test.ts`:

  ```typescript
  import { describe, test, expect } from "vitest";
  import * as data from "../../src";

  describe("streaming-prep contracts on new operations", () => {
    // List-shape ops must return an AsyncIterable.
    const listOps = ["findSimilarPrompts", "relatedTurns", "toolCallStats"] as const;
    test.each(listOps)("%s returns an AsyncIterable", (name) => {
      // Smoke-call with mock-friendly args; we only check the return type.
      const fn = (data as any)[name];
      // Each list op accepts (input, options) where options may include signal.
      // Use AbortController().abort() so the iterator never executes a query.
      const ctrl = new AbortController();
      ctrl.abort();
      let result;
      try {
        if (name === "findSimilarPrompts") result = fn({ text: "x" }, { signal: ctrl.signal });
        if (name === "relatedTurns") result = fn("trn_x", "same_session", { signal: ctrl.signal });
        if (name === "toolCallStats") result = fn({ period: "24h", signal: ctrl.signal });
      } catch { /* expected — abort signal trips early */ }
      // The function must at least return an object with [Symbol.asyncIterator] or a thenable
      // that rejects. Either is acceptable; what matters is it isn't a plain array.
      if (result) expect(typeof result[Symbol.asyncIterator]).toBe("function");
    });

    // Scalar-shape ops accept an options object with optional signal.
    test.each([
      ["getTurnRawMetadata", ["trn_x"]],
      ["getTurnRawChunk", ["trn_x", 0, 100]],
      ["compareTurns", [["a"], undefined]],
      ["sessionEfficiency", ["ses_x"]],
    ] as const)("%s accepts a final options arg with optional signal", async (name, args) => {
      const fn = (data as any)[name];
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(fn(...args, { signal: ctrl.signal })).rejects.toThrow(/abort/i);
    });
  });
  ```

- [ ] **10.2** Run the test. Must pass — every op was written against the streaming-prep contracts in Tasks 2–8. If any op was implemented as an array-returning function or skipped the `signal` parameter, fix it before merge. Commit: `recondo-data: verify streaming-prep contracts on new operations`.

## Task 11 — End-to-end integration sweep

A single scenario that exercises every operation against a seeded session, asserting the output shapes are well-formed and that the operations cooperate (e.g., `getTurnRawMetadata` and `getTurnRawChunk` agree on byte counts).

- [ ] **11.1** Write `packages/recondo-data/tests/integration/new-ops-end-to-end.test.ts`:

  ```typescript
  import { describe, test, expect } from "vitest";
  import * as data from "../../src";
  import {
    seedSessionWithTurns,
    seedTurnWithRawBody,
    withTestPool,
  } from "../helpers/seed";

  describe("new operations — end-to-end sweep", () => {
    test("seven operations cooperate on a seeded session", async () => {
      await withTestPool(async (pool) => {
        // 1. Seed a session with 5 turns. Two share a prompt.
        const sharedPrompt = "what does this function do?";
        const { sessionId, turnIds } = await seedSessionWithTurns(pool, {
          turns: [
            { prompt: sharedPrompt, model: "claude-3-5-sonnet", input_tokens: 100, output_tokens: 50, cost_usd: 0.01 },
            { prompt: "different",  model: "claude-3-5-sonnet", input_tokens: 200, output_tokens: 60, cost_usd: 0.02 },
            { prompt: sharedPrompt, model: "claude-3-5-sonnet", input_tokens: 110, output_tokens: 55, cost_usd: 0.011 },
            { prompt: "another",    model: "claude-3-5-sonnet", input_tokens: 300, output_tokens: 80, cost_usd: 0.04 },
            { prompt: "final",      model: "claude-3-5-sonnet", input_tokens: 150, output_tokens: 40, cost_usd: 0.015 },
          ],
        });

        // 2. Attach a 50 KB raw body to the first turn.
        const body = Buffer.alloc(50_000, 0x5A);
        await seedTurnWithRawBody(pool, body, { turnId: turnIds[0], contentType: "application/json" });

        // 3. getTurnRawMetadata.
        const meta = await data.getTurnRawMetadata(turnIds[0], {});
        expect(meta.bytes_total).toBe(50_000);
        expect(meta.head_sample_utf8.length).toBeGreaterThan(0);

        // 4. getTurnRawChunk — first 32 KB.
        const chunk = await data.getTurnRawChunk(turnIds[0], 0, 32_768, {});
        expect(chunk.bytes.length).toBe(32_768);
        expect(chunk.next_offset).toBe(32_768);

        // 5. getTurnRawChunk — second chunk continues where the first stopped.
        const chunk2 = await data.getTurnRawChunk(turnIds[0], 32_768, 32_768, {});
        expect(chunk2.bytes.length).toBe(50_000 - 32_768);
        expect(chunk2.next_offset).toBeNull();

        // 6. compareTurns across all five.
        const cmp = await data.compareTurns(turnIds, undefined, {});
        expect(cmp.turn_ids).toEqual(turnIds);
        const costRow = cmp.rows.find((r) => r.aspect === "cost")!;
        expect(costRow.values).toHaveLength(5);
        expect(costRow.delta).toBeGreaterThan(0);

        // 7. findSimilarPrompts — turns[0] and turns[2] share a prompt.
        const sim: any[] = [];
        for await (const m of data.findSimilarPrompts(turnIds[0], { limit: 10 })) sim.push(m);
        expect(sim.map((s) => s.turn_id)).toContain(turnIds[2]);

        // 8. relatedTurns — same_session pulls the other four.
        const rel: any[] = [];
        for await (const r of data.relatedTurns(turnIds[0], "same_session", {})) rel.push(r);
        expect(rel.map((r) => r.turn_id).sort()).toEqual(turnIds.slice(1).sort());

        // 9. sessionEfficiency.
        const eff = await data.sessionEfficiency(sessionId, {});
        expect(eff.session_id).toBe(sessionId);
        expect(eff.tokens_per_turn.p50).toBeGreaterThan(0);
        // turns[0] and turns[2] share a prompt -> 2 of 5 turns flagged duplicated -> 0.4
        expect(eff.prompt_token_reuse_ratio).toBeCloseTo(0.4, 2);

        // 10. toolCallStats — smoke (no tool_calls seeded -> empty result is acceptable).
        const stats: any[] = [];
        for await (const row of data.toolCallStats({ period: "24h", group_by: "tool_name" })) stats.push(row);
        expect(Array.isArray(stats)).toBe(true);
      });
    });
  });
  ```

- [ ] **11.2** Run the full suite (`pnpm -F recondo-data test`). All tests across Tasks 1–10 plus this sweep must pass.
- [ ] **11.3** Run the consumer test suites (`cd api && pnpm test`; `cd dashboard && pnpm build`). Acceptance: zero regression — this plan only adds new operations, none of the existing call sites change. Commit: `recondo-data: end-to-end integration sweep across seven new operations`.

---

## Acceptance Criteria for this Plan

- [ ] All seven new operations exported from `packages/recondo-data/src/index.ts` (Task 9).
- [ ] Each new operation accepts an optional `AbortSignal` and aborts cleanly mid-execution (verified per-task plus Task 10).
- [ ] List-shape operations (`findSimilarPrompts`, `relatedTurns`, `toolCallStats`) return `AsyncIterable<Item>` (Task 10).
- [ ] `getTurnRawMetadata` returns content_hash, bytes_total, content_type, and a UTF-8 head sample of at most 4 KB (Task 2).
- [ ] `getTurnRawChunk` caps length at 32 KB and reports `next_offset = null` at EOF (Task 3).
- [ ] `compareTurns` produces one row per requested aspect with `values[]` parallel to `turn_ids` and a numeric `delta` for cost/tokens (Task 4).
- [ ] `findSimilarPrompts` is hash-only in v1 — byte-identical prompts only; trailing-whitespace differences correctly produce no match (Task 5).
- [ ] `relatedTurns` covers all five relations; unknown relations throw (Task 6).
- [ ] `sessionEfficiency` computes cache hit rate, prompt-token reuse ratio, tokens-per-turn p50/p99/mean, redundant tool-call count, and TTFT p50/p99/mean in a single PG round-trip (Task 7).
- [ ] `toolCallStats` supports `group_by: tool_name|session|framework` over periods `1h|24h|7d|30d` (Task 8).
- [ ] Existing `api/` and `dashboard/` test suites pass without modification — this plan adds operations but does not change Plan B's call sites (Task 11.3).
- [ ] No file under `api/` or `mcp/` is modified by this plan.
- [ ] No test fixture in this plan contains a credential-shaped string. Test seeds are limited to timestamps, integer counts, opaque IDs, and lorem-ipsum prompts.

---

## Risks specific to this plan

1. **Schema gaps for `relatedTurns`.** If the live `turns` schema lacks `caused_by_turn_id`, `retry_of_turn_id`, or a tool-chain column, Task 6 must coordinate with Plan B to add them or trim the relation enum. Do not invent columns silently — fail loudly and update the MCP tool description in Plan D to match what's actually supported.
2. **`tool_calls.args_hash` may not exist.** Task 7's `redundant_tool_call_count` query uses it. If the column is absent, fall back to `md5(tool_name || args_json::text)` inline. Document the column name in `sessionEfficiency.ts`'s header so a future schema change is easy to track.
3. **`getTurnRawChunk` returns less than `length` even mid-body.** If the local object-store driver decompresses the full object, `readRange(offset, length)` returns up to `length` from `offset` — but the existing `LocalObjectStore.get` may have edge cases at exactly `bytes_total`. Task 1's tests cover the `offset + length > bytes_total` case; ensure the off-by-one does not bite (`end = Math.min(offset + length, full.length)`).
4. **`findSimilarPrompts` v1 will surprise users.** Real-world prompts differ by whitespace, system-prompt date stamps, model-name strings, and trace IDs. Hash-only matching will produce zero results for prompts a user thinks are duplicates. Task 5.2 documents this in the function header; the corresponding MCP tool description (Plan D) repeats it; the `find_waste` prompt template (Plan D) calls it out in its rendered output. Triple coverage because it's the most likely "this looks broken" report.
5. **Distribution percentiles on small samples.** `sessionEfficiency` uses `percentile_disc` on per-session samples. A 3-turn session reports a p99 equal to its max — that's the correct semantics for a discrete percentile, but document it in the function header so consumers do not over-interpret p99 on tiny sessions.
6. **`getTurnRawMetadata.head_sample_utf8` may have invalid UTF-8 boundaries.** A 4 KB slice can split a multi-byte codepoint. `Buffer.toString("utf8")` replaces partial codepoints with U+FFFD — acceptable for a head sample, but document it in the function header.
7. **No credential redaction is in scope.** The seven operations return body text and prompt/response text exactly as stored (modulo the pre-existing path-masking from `placeholder-mask.ts`). A separate global redaction pass — covering Anthropic, OpenAI, AWS, GCP, GitHub, Stripe, Slack, Discord, Bearer, JWT, PEM, DB strings, and `.env` fragments — is deferred to a future plan and applies to every read path uniformly when it lands. MCP tool descriptions (Plan D) must not claim credential redaction is in effect for v1.
