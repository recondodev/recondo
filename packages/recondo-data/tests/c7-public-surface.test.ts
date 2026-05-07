/**
 * Chunk 7, T9 + T10: public-surface smoke + AsyncIterable runtime contracts.
 *
 * Covers:
 *   - D-EX1 — every C1..C6 new operation is on the public barrel.
 *     Imports the names from `@recondo/data` and asserts each is callable
 *     (`typeof X === "function"`). JS class constructors satisfy `typeof
 *     X === "function"`, so `LocalObjectStore` is checked the same way.
 *
 *   - D-EX2 — `LocalObjectStore` is on the public interface AND the
 *     `readRange` instance method exists. We construct an instance against
 *     a tmpdir (avoids mutating the user's real ~/.recondo) and assert
 *     `typeof instance.readRange === "function"`.
 *
 *   - D-CT-LIST — three operations return AsyncIterables (not Promises of
 *     arrays). Asserts `Symbol.asyncIterator in result` AND `typeof
 *     result[Symbol.asyncIterator] === "function"` for:
 *       * findSimilarPrompts(...)
 *       * relatedTurns(...)
 *       * toolCallStats(...)
 *     Each is called with minimal-but-real args. We do NOT iterate (so we
 *     don't need real seeded rows here — the iterable is constructed lazily
 *     and DB I/O does not start until `next()` is called).
 *
 * NOTE: this file does NOT exercise the four scalar operations
 * (`getTurnRawMetadata`, `getTurnRawChunk`, `compareTurns`,
 * `sessionEfficiency`) — calling them would require seeded rows. Their
 * runtime behavior is covered by the per-op test suites in
 * tests/turns-raw, tests/compare-turns, tests/session-efficiency, plus
 * the C7 e2e sweep in tests/c7-e2e/. Their type contract
 * (`{ signal?: AbortSignal }` options arg) lives in tests/types.test-d.ts.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as data from "../src/index.js";

afterAll(async () => {
  await data.closePool();
});

describe("C7 D-EX1 — every new operation is on the public barrel", () => {
  it("exports the seven new operations as functions/classes", () => {
    // Class constructor — JS classes satisfy `typeof X === "function"`.
    expect(typeof data.LocalObjectStore).toBe("function");

    // Scalar (Promise-returning) ops.
    expect(typeof data.getTurnRawMetadata).toBe("function");
    expect(typeof data.getTurnRawChunk).toBe("function");
    expect(typeof data.compareTurns).toBe("function");
    expect(typeof data.sessionEfficiency).toBe("function");

    // AsyncIterable-returning ops (sync-callable, lazy iteration).
    expect(typeof data.findSimilarPrompts).toBe("function");
    expect(typeof data.relatedTurns).toBe("function");
    expect(typeof data.toolCallStats).toBe("function");
  });
});

describe("C7 D-EX2 — LocalObjectStore class instantiable + readRange method", () => {
  it("constructs an instance with a tmpdir and exposes `readRange` as a function", () => {
    const dir = mkdtempSync(join(tmpdir(), "recondo-data-c7-ex2-"));
    try {
      const store = new data.LocalObjectStore({ objectsRoot: join(dir, "objects") });
      expect(store).toBeInstanceOf(data.LocalObjectStore);
      expect(typeof store.readRange).toBe("function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("C7 D-CT-LIST — list ops return AsyncIterables", () => {
  it("findSimilarPrompts returns an AsyncIterable", () => {
    // Sync-callable: returns an iterable immediately. No DB I/O happens
    // here because we never call .next(). The bogus turn id is fine —
    // the iterable is constructed lazily.
    const result = data.findSimilarPrompts(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(Symbol.asyncIterator in result).toBe(true);
    expect(
      typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator],
    ).toBe("function");
  });

  it("relatedTurns returns an AsyncIterable", () => {
    const result = data.relatedTurns(
      "00000000-0000-0000-0000-000000000000",
      "same_session",
    );
    expect(Symbol.asyncIterator in result).toBe(true);
    expect(
      typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator],
    ).toBe("function");
  });

  it("toolCallStats returns an AsyncIterable", () => {
    const result = data.toolCallStats({
      group_by: "tool_name",
      period: "all",
    });
    expect(Symbol.asyncIterator in result).toBe(true);
    expect(
      typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator],
    ).toBe("function");
  });
});
