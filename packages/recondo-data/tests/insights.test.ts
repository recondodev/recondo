import { describe, it, expect, afterAll, vi } from "vitest";

import { getInsights } from "../src/insights.js";
import { getPool, closePool } from "../src/pool.js";
import type { ApiKeyInfo } from "../src/types.js";

afterAll(async () => {
  await closePool();
});

const adminKey: ApiKeyInfo = { id: "k", projectId: null, rateLimitRpm: 1000 };

describe("@recondo/data: getInsights", () => {
  it("returns ranked insight objects with suggested next calls", async () => {
    const pool = getPool();
    const spy = vi.spyOn(pool, "query")
      .mockResolvedValueOnce({
        rows: [
          { id: "expensive", total_cost_usd: 100 },
          { id: "normal", total_cost_usd: 10 },
        ],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ tool_name: "read_file", input_hash: "hash-1", count: 12 }],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ recent: 6, previous: 0 }],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ count: 2, turn_id: "turn-1", session_id: "sess-1" }],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ id: "policy-1", name: "Block risky", recent: 8, previous: 1 }],
      } as never);

    const result = await getInsights(adminKey, {
      projectId: "alpha",
      since: "2026-05-07T00:00:00.000Z",
    });

    expect(result.insights.length).toBeGreaterThanOrEqual(5);
    expect(result.insights[0]).toMatchObject({
      kind: "anomaly_spike",
      severity: "critical",
    });
    for (const insight of result.insights) {
      expect(typeof insight.kind).toBe("string");
      expect(["info", "warning", "critical"]).toContain(insight.severity);
      expect(insight.suggested_next_call).toHaveProperty("tool");
      expect(insight.suggested_next_call).toHaveProperty("args");
      expect(insight.evidence).toBeDefined();
    }

    spy.mockRestore();
  });

  it("returns no insights when a scoped key asks for another project", async () => {
    const scoped: ApiKeyInfo = { id: "k", projectId: "alpha", rateLimitRpm: 1000 };
    const pool = getPool();
    const spy = vi.spyOn(pool, "query");
    const result = await getInsights(scoped, { projectId: "beta" });
    expect(result).toEqual({ insights: [] });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
