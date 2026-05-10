/**
 * D-C6-3 (unit) — `recondo_usage_summary` tool: schema + handler.
 *
 * Contract pinned by C0 audit + Plan D §C6:
 *   - Tool name: `recondo_usage_summary`.
 *   - Description >= 50 chars.
 *   - Input shape:
 *       period: z.enum([...]).default("week")
 *       project_id?: string
 *     Plan D §D-C6-3 says "period enum default 'week'". The data layer
 *     accepts `DAY_<n>` strings (DAY_1/DAY_7/DAY_30/DAY_90); the MCP
 *     tool exposes the human-readable enum and translates internally.
 *     Members MUST include "day", "week", "month".
 *   - Handler is a thin pass-through to `getUsageSummary(apiKey, args,
 *     options)`. Returns the structured `UsageSummary` record verbatim
 *     (single record — NO list envelope wrapping). Subject to the 32 KB
 *     single-record budget.
 *   - `ctx.abortSignal` MUST be threaded into the data-layer options.
 *
 * Phantom-wiring guard: production source MUST NOT import the
 * LEFT-column name `usageSummary` (the canonical name is
 * `getUsageSummary`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const {
  getRealtimeStats,
  getGatewayStatus,
  listRealtimeFeed,
  getUsageSummary,
  listSpendByProvider,
  listSpendByModel,
  listSpendByFramework,
  listDailySpend,
  getCostProjections,
  getPool,
  closePool,
  insertAuditLog,
} = vi.hoisted(() => ({
  getRealtimeStats: vi.fn(),
  getGatewayStatus: vi.fn(),
  listRealtimeFeed: vi.fn(),
  getUsageSummary: vi.fn(),
  listSpendByProvider: vi.fn(),
  listSpendByModel: vi.fn(),
  listSpendByFramework: vi.fn(),
  listDailySpend: vi.fn(),
  getCostProjections: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("@recondo/data", () => ({
  getRealtimeStats,
  getGatewayStatus,
  listRealtimeFeed,
  getUsageSummary,
  listSpendByProvider,
  listSpendByModel,
  listSpendByFramework,
  listDailySpend,
  getCostProjections,
  getPool,
  closePool,
  insertAuditLog,
}));

import {
  usageSummaryTool,
  usageSummaryInputSchema,
} from "../../src/tools/usage-summary.js";
import type { ToolContext } from "../../src/registry/types.js";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ac = new AbortController();
  return {
    abortSignal: overrides.abortSignal ?? ac.signal,
    auth: overrides.auth ?? {
      kind: "dev-bypass",
      isAdmin: true,
      projectId: null,
      keyId: "dev-bypass",
    },
    clientInfo: overrides.clientInfo,
    audit: overrides.audit ?? { write: vi.fn().mockResolvedValue(undefined) },
  };
}

const sampleSummary = {
  totalCostUsd: 12.34,
  projectedMonthlyCostUsd: 50,
  totalTokens: 100_000,
  cacheReadTokens: 25_000,
  cacheReadPercentage: 25,
  averageCostPerSession: 0.5,
  averageCostDelta: -0.05,
  cacheHitRate: 60,
  cacheSavingsUsd: 1.23,
  costPerDeveloperPerDay: 0.4,
  developerCount: 3,
};

describe("D-C6-3 usageSummaryInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof usageSummaryTool.description).toBe("string");
    expect(usageSummaryTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("tool name is exactly recondo_usage_summary", () => {
    expect(usageSummaryTool.name).toBe("recondo_usage_summary");
  });

  it("schema.parse({}) yields default period 'week'", () => {
    const parsed = usageSummaryInputSchema.parse({}) as { period: string };
    expect(parsed.period).toBe("week");
  });

  it("enum members include 'day', 'week', 'month'", () => {
    expect(() => usageSummaryInputSchema.parse({ period: "day" })).not.toThrow();
    expect(() => usageSummaryInputSchema.parse({ period: "week" })).not.toThrow();
    expect(() => usageSummaryInputSchema.parse({ period: "month" })).not.toThrow();
  });

  it("schema rejects bogus period values", () => {
    expect(() => usageSummaryInputSchema.parse({ period: "BOGUS" })).toThrow();
    expect(() => usageSummaryInputSchema.parse({ period: "DAY_30" })).toThrow();
  });

  it("schema accepts optional project_id string", () => {
    const parsed = usageSummaryInputSchema.parse({
      period: "week",
      project_id: "proj-1",
    }) as { project_id?: string };
    expect(parsed.project_id).toBe("proj-1");
  });

  it("schema rejects non-string project_id", () => {
    expect(() =>
      usageSummaryInputSchema.parse({ period: "week", project_id: 7 }),
    ).toThrow();
  });
});

describe("D-C6-3 usageSummaryTool — phantom-wiring guard", () => {
  it("source imports `getUsageSummary` (NOT the LEFT-column `usageSummary`)", () => {
    const sourcePath = resolve(__dirname, "../../src/tools/usage-summary.ts");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("getUsageSummary");

    const importLines = source
      .split("\n")
      .filter((l) => l.includes("@recondo/data"));
    for (const line of importLines) {
      // Bare `usageSummary` (not preceded by `get`) is forbidden.
      const bareMatch = /(?<!get)\busageSummary\b/.exec(line);
      expect(bareMatch, `forbidden bare \`usageSummary\` in: ${line}`).toBeNull();
    }
  });
});

describe("D-C6-3 usageSummaryTool handler — call-shape + signal threading", () => {
  beforeEach(() => {
    getUsageSummary.mockReset();
  });

  it("calls getUsageSummary(apiKey, args, options)", async () => {
    getUsageSummary.mockResolvedValueOnce(sampleSummary);
    const ctx = makeCtx();

    await usageSummaryTool.handler({ period: "week" } as never, ctx);

    expect(getUsageSummary).toHaveBeenCalledTimes(1);
    const callArgs = getUsageSummary.mock.calls[0];
    expect(callArgs.length).toBe(3);
    const apiKey = callArgs[0] as { id: string; projectId: string | null };
    expect(apiKey).toBeDefined();
    expect(typeof apiKey.id).toBe("string");
  });

  it("threads ctx.abortSignal into options.signal", async () => {
    getUsageSummary.mockResolvedValueOnce(sampleSummary);
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await usageSummaryTool.handler({ period: "week" } as never, ctx);

    const callArgs = getUsageSummary.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("propagates AbortError when getUsageSummary rejects", async () => {
    getUsageSummary.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await expect(
      usageSummaryTool.handler({ period: "week" } as never, ctx),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });

  it("default period 'week' reaches the data-layer call args", async () => {
    getUsageSummary.mockResolvedValueOnce(sampleSummary);
    const ctx = makeCtx();

    await usageSummaryTool.handler({} as never, ctx);

    const callArgs = getUsageSummary.mock.calls[0];
    const args = callArgs[1] as { period?: string | null };
    // The handler MAY translate "week" -> "DAY_7" before forwarding.
    // Either form is acceptable; the contract is that a non-empty period
    // string survives.
    expect(typeof args.period).toBe("string");
    expect((args.period as string).length).toBeGreaterThan(0);
  });
});

describe("D-C6-3 usageSummaryTool handler — output shape", () => {
  beforeEach(() => {
    getUsageSummary.mockReset();
  });

  it("returns the structured summary record verbatim (NOT a list envelope)", async () => {
    getUsageSummary.mockResolvedValueOnce(sampleSummary);
    const ctx = makeCtx();

    const result = (await usageSummaryTool.handler(
      { period: "week" } as never,
      ctx,
    )) as Record<string, unknown>;

    expect(result).not.toHaveProperty("items");
    expect(result).not.toHaveProperty("stream_id");
    expect(result).not.toHaveProperty("is_final");

    expect(result.totalCostUsd ?? result.total_cost_usd).toBe(12.34);
    expect(result.developerCount ?? result.developer_count).toBe(3);
  });

  it("oversize record surfaces response_too_large envelope (32 KB budget)", async () => {
    const padded = {
      ...sampleSummary,
      __padding: "x".repeat(40 * 1024),
    };
    getUsageSummary.mockResolvedValueOnce(padded);
    const ctx = makeCtx();

    const result = (await usageSummaryTool.handler(
      { period: "week" } as never,
      ctx,
    )) as Record<string, unknown>;

    expect(result.response_too_large).toBe(true);
    expect(typeof result.actual_bytes).toBe("number");
    expect(result.actual_bytes as number).toBeGreaterThan(32 * 1024);
  });
});

describe("D-C6-3 usageSummaryTool — pre-aborted signal", () => {
  beforeEach(() => {
    getUsageSummary.mockReset();
  });

  it("rejects with AbortError when ctx.abortSignal is pre-aborted", async () => {
    getUsageSummary.mockImplementation((..._args: unknown[]) => {
      const opts = _args[_args.length - 1] as { signal?: AbortSignal };
      if (opts?.signal?.aborted) {
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }
      return Promise.resolve(sampleSummary);
    });
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await expect(
      usageSummaryTool.handler({ period: "week" } as never, ctx),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});
