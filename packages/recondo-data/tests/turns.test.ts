import { describe, it, expect, afterAll } from "vitest";
import { getTurn, searchTurns } from "../src/turns.js";
import { closePool } from "../src/pool.js";
import { DataValidationError } from "../src/types.js";
import type { ApiKeyInfo } from "../src/types.js";

const adminKey: ApiKeyInfo = { id: "k", projectId: null, rateLimitRpm: 1000 };

afterAll(async () => {
  await closePool();
});

describe("@recondo/data: getTurn (D-S11)", () => {
  it("returns null for non-existent id", async () => {
    const turn = await getTurn(adminKey, "00000000-0000-0000-0000-000000000000");
    expect(turn).toBeNull();
  });

  it("honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      getTurn(adminKey, "00000000-0000-0000-0000-000000000000", { signal: ctrl.signal }),
    ).rejects.toThrow();
  });
});

describe("@recondo/data: searchTurns synchronous validation (D-S8)", () => {
  it("throws DataValidationError SYNCHRONOUSLY when query > 500 chars", () => {
    // Sync throw — no iteration needed.
    const long = "x".repeat(501);
    expect(() => searchTurns(adminKey, long, null, { limit: 100 })).toThrow(DataValidationError);
  });

  it("accepts query exactly at 500 chars", () => {
    const query = "x".repeat(500);
    // Should not throw at call time. (Iterating may still resolve to empty.)
    expect(() => searchTurns(adminKey, query, null, { limit: 10 })).not.toThrow();
  });
});

describe("@recondo/data: searchTurns AsyncIterable shape (D-S9)", () => {
  it("returns an AsyncIterable", async () => {
    const it = searchTurns(adminKey, "anything", null, { limit: 10 });
    expect(typeof (it as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function");
  });

  it("Array.fromAsync materializes results to an array", async () => {
    const rows = await Array.fromAsync(searchTurns(adminKey, "anything", null, { limit: 10 }));
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe("@recondo/data: searchTurns AbortSignal (D-S10)", () => {
  it("rejects with AbortError when signal is pre-aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      Array.fromAsync(searchTurns(adminKey, "anything", null, { signal: ctrl.signal })),
    ).rejects.toThrow(/abort/i);
  });
});
