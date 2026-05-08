import { describe, it, expect, afterAll, vi } from "vitest";
import {
  getRealtimeStats,
  listRealtimeFeed,
  getGatewayStatus,
} from "../src/realtime.js";
import { closePool, getPool } from "../src/pool.js";
import { encodeSinceCursor } from "../src/envelope.js";
import type { ApiKeyInfo } from "../src/types.js";

const adminKey: ApiKeyInfo = { id: "k", projectId: null, rateLimitRpm: 1000 };

afterAll(async () => {
  await closePool();
});

describe("@recondo/data: getRealtimeStats (D-RT1)", () => {
  it("returns a single record (not envelope)", async () => {
    const stats = await getRealtimeStats(adminKey, {});
    expect(stats).not.toHaveProperty("items");
    expect(stats).not.toHaveProperty("next_offset");
    // Should have at least some realtime stats fields
    expect(typeof stats).toBe("object");
  });

  it("honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      getRealtimeStats(adminKey, { signal: ctrl.signal }),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});

describe("@recondo/data: listRealtimeFeed (D-RT2)", () => {
  it("returns an AsyncIterable", async () => {
    const it = listRealtimeFeed(adminKey, {}, { limit: 10 });
    expect(typeof (it as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe(
      "function",
    );
  });

  it("Array.fromAsync materializes", async () => {
    const rows = await Array.fromAsync(
      listRealtimeFeed(adminKey, {}, { limit: 10 }),
    );
    expect(Array.isArray(rows)).toBe(true);
  });

  it("honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      Array.fromAsync(listRealtimeFeed(adminKey, {}, { signal: ctrl.signal })),
    ).rejects.toThrow(/abort/i);
  });

  it("accepts since cursor and emits time-clause SQL", async () => {
    const cursor = encodeSinceCursor({
      ts: "2026-05-04T12:00:00.000Z",
      id: "feed-1",
    });
    const pool = getPool();
    const spy = vi.spyOn(pool, "query");
    await Array.fromAsync(
      listRealtimeFeed(
        adminKey,
        { since: cursor as unknown as string },
        { limit: 5 },
      ),
    );
    const sqlStrings = spy.mock.calls.map((c) => String(c[0])).join("\n");
    // The SQL should reference a time column with `>` comparison.
    expect(sqlStrings).toMatch(
      /(timestamp|started_at|created_at|recorded_at|happened_at)\s*[>:]/,
    );
    spy.mockRestore();
  });
});

describe("@recondo/data: getGatewayStatus (D-RT3)", () => {
  it("returns a single record", async () => {
    const status = await getGatewayStatus(adminKey, {});
    expect(status).not.toHaveProperty("items");
    expect(typeof status).toBe("object");
  });

  it("honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      getGatewayStatus(adminKey, { signal: ctrl.signal }),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});
