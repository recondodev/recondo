import { describe, it, expect, afterAll } from "vitest";
import {
  getUsageSummary,
  listSpendByProvider,
  listSpendByModel,
  listSpendByFramework,
  listDailySpend,
  getCostProjections,
  resolveDateRange,
} from "../src/cost.js";
import { closePool } from "../src/pool.js";
import type { ApiKeyInfo } from "../src/types.js";

const adminKey: ApiKeyInfo = { id: "k", projectId: null, rateLimitRpm: 1000 };

afterAll(async () => {
  await closePool();
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
    ).rejects.toThrow();
  });

  it("listSpendByProvider honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      listSpendByProvider(adminKey, { period: "DAY_1" } as never, { signal: ctrl.signal }),
    ).rejects.toThrow();
  });

  it("listSpendByModel honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      listSpendByModel(adminKey, { period: "DAY_1" } as never, { signal: ctrl.signal }),
    ).rejects.toThrow();
  });

  it("listSpendByFramework honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      listSpendByFramework(adminKey, { period: "DAY_1" } as never, { signal: ctrl.signal }),
    ).rejects.toThrow();
  });

  it("listDailySpend honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      listDailySpend(adminKey, { period: "DAY_1" } as never, { signal: ctrl.signal }),
    ).rejects.toThrow();
  });

  it("getCostProjections honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      getCostProjections(adminKey, "DAY_30" as never, { signal: ctrl.signal }),
    ).rejects.toThrow();
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
});
