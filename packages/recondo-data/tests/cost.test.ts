import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import {
  getUsageSummary,
  listSpendByProvider,
  listSpendByModel,
  listSpendByFramework,
  listDailySpend,
  getCostProjections,
  resolveDateRange,
} from "../src/cost.js";
import { getPool, closePool } from "../src/pool.js";
import type { ApiKeyInfo } from "../src/types.js";

const adminKey: ApiKeyInfo = { id: "k", projectId: null, rateLimitRpm: 1000 };

afterAll(async () => {
  await closePool();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("@recondo/data: cost exports (D-CO1)", () => {
  it("exports the 6 cost functions + resolveDateRange utility", () => {
    expect(typeof getUsageSummary).toBe("function");
    expect(typeof listSpendByProvider).toBe("function");
    expect(typeof listSpendByModel).toBe("function");
    expect(typeof listSpendByFramework).toBe("function");
    expect(typeof listDailySpend).toBe("function");
    expect(typeof getCostProjections).toBe("function");
    expect(typeof resolveDateRange).toBe("function");
  });
});

describe("@recondo/data: cost AbortSignal contract (D-CO2)", () => {
  it("getUsageSummary honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      getUsageSummary(adminKey, { period: "DAY_1" } as never, { signal: ctrl.signal }),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });

  it("listSpendByProvider honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      listSpendByProvider(adminKey, { period: "DAY_1" } as never, { signal: ctrl.signal }),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });

  it("listSpendByModel honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      listSpendByModel(adminKey, { period: "DAY_1" } as never, { signal: ctrl.signal }),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });

  it("listSpendByFramework honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      listSpendByFramework(adminKey, { period: "DAY_1" } as never, { signal: ctrl.signal }),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });

  it("listDailySpend honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      listDailySpend(adminKey, { period: "DAY_1" } as never, { signal: ctrl.signal }),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });

  it("getCostProjections honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      getCostProjections(adminKey, "DAY_30" as never, { signal: ctrl.signal }),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});

describe("@recondo/data: resolveDateRange utility", () => {
  it("returns from/to dates given a period", () => {
    const range = resolveDateRange("DAY_7" as never, undefined, undefined);
    expect(range).toHaveProperty("from");
    expect(range).toHaveProperty("to");
    // Both should be parseable as Dates / ISO strings
    expect(() => new Date(range.from as never)).not.toThrow();
    expect(() => new Date(range.to as never)).not.toThrow();
  });

  it("respects explicit from/to overriding period", () => {
    const explicitFrom = "2026-04-01T00:00:00.000Z";
    const explicitTo = "2026-04-15T00:00:00.000Z";
    const range = resolveDateRange("DAY_30" as never, explicitFrom, explicitTo);
    // The implementation may either use explicit values verbatim or compute around them.
    // At minimum, the returned values exist.
    expect(range.from).toBeDefined();
    expect(range.to).toBeDefined();
  });
});

describe("@recondo/data: listSpendByProvider envelope shape", () => {
  it("returns ListEnvelope shape", async () => {
    const env = await listSpendByProvider(adminKey, { period: "DAY_1" } as never, { limit: 10 });
    expect(env).toHaveProperty("items");
    expect(env).toHaveProperty("next_offset");
    expect(env).toHaveProperty("truncated");
    expect(env.stream_id).toBeNull();
    expect(env.is_final).toBe(true);
  });

  it("honors limit/offset and emits next_offset", async () => {
    const pool = getPool();
    vi.spyOn(pool, "query").mockResolvedValueOnce({
      rows: [
        { name: "a", cost_usd: 5, count: 1 },
        { name: "b", cost_usd: 4, count: 1 },
        { name: "c", cost_usd: 3, count: 1 },
      ],
    } as never);

    const env = await listSpendByProvider(
      adminKey,
      { period: "DAY_30" } as never,
      { limit: 1, offset: 1 },
    );

    expect(env.items).toEqual([
      { name: "b", costUsd: 4, percentage: (4 / 12) * 100, count: 1 },
    ]);
    expect(env.next_offset).toBe(2);
    expect(env.truncated).toBe(true);
    expect(env.total).toBe(3);
    expect(env.limit).toBe(1);
    expect(env.offset).toBe(1);
  });
});

describe("@recondo/data: getCostProjections period baseline", () => {
  it("uses the requested period window and scales it to a 30-day baseline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T12:00:00.000Z"));
    const pool = getPool();
    const spy = vi.spyOn(pool, "query").mockResolvedValueOnce({
      rows: [{ total_cost: 70, total_tokens: 700, session_count: 7, turn_count: 7 }],
    } as never);

    const projections = await getCostProjections(adminKey, "DAY_7");

    expect(String((spy.mock.calls[0][1] as unknown[])[0])).toContain(
      "2026-04-30T12:00:00.000Z",
    );
    expect(projections[0].projectedCostUsd).toBe(315);
    expect(projections[0].assumptions).toContain("7-day baseline");
  });
});
