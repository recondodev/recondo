/**
 * D-C6-4 (unit) — `recondo_spend` tool: schema + handler dispatch.
 *
 * Contract pinned by C0 audit + Plan D §C6:
 *   - Tool name: `recondo_spend`.
 *   - Description >= 50 chars.
 *   - Input shape:
 *       group_by: z.enum(["provider", "model", "framework", "daily"])  (4 values)
 *       period?:  z.enum([...])  (matches usage-summary's enum: at minimum
 *                                  day/week/month)
 *       project_id?: string
 *   - Handler dispatches on `group_by`:
 *       "provider"  -> listSpendByProvider(apiKey, args, options)
 *       "model"     -> listSpendByModel(apiKey, args, options)
 *       "framework" -> listSpendByFramework(apiKey, args, options)
 *       "daily"     -> listDailySpend(apiKey, args, options)
 *     A WRONG dispatch (e.g. "model" -> listSpendByProvider) is the
 *     classic phantom-wiring red flag. We test all 4 mappings.
 *   - Each underlying call already returns a `ListEnvelope<SpendBucket>`.
 *     The handler returns it verbatim (or after `enforceListBudget`).
 *   - `ctx.abortSignal` MUST be threaded into the dispatched call.
 *
 * Phantom-wiring guard: production source MUST NOT import the LEFT-column
 * names `spendByProvider` / `spendByModel` / `spendByFramework` /
 * `dailySpend`. Source-grep test below.
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

import { spendTool, spendInputSchema } from "../../src/tools/spend.js";
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

const emptyEnvelope = {
  items: [],
  next_offset: null,
  truncated: false,
  stream_id: null,
  is_final: true,
};

const sampleBucket = {
  name: "anthropic",
  costUsd: 1.23,
  percentage: 50,
  count: 10,
};

function envelopeWith(items: unknown[]): typeof emptyEnvelope {
  return {
    items: items as never,
    next_offset: null,
    truncated: false,
    stream_id: null,
    is_final: true,
  };
}

describe("D-C6-4 spendInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof spendTool.description).toBe("string");
    expect(spendTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("tool name is exactly recondo_spend", () => {
    expect(spendTool.name).toBe("recondo_spend");
  });

  it("group_by enum has exactly 4 members: provider/model/framework/daily", () => {
    expect(() => spendInputSchema.parse({ group_by: "provider" })).not.toThrow();
    expect(() => spendInputSchema.parse({ group_by: "model" })).not.toThrow();
    expect(() => spendInputSchema.parse({ group_by: "framework" })).not.toThrow();
    expect(() => spendInputSchema.parse({ group_by: "daily" })).not.toThrow();
  });

  it("group_by rejects values outside the 4-member enum", () => {
    expect(() => spendInputSchema.parse({ group_by: "session" })).toThrow();
    expect(() => spendInputSchema.parse({ group_by: "PROVIDER" })).toThrow();
    expect(() => spendInputSchema.parse({ group_by: "" })).toThrow();
  });

  it("group_by is required (no default)", () => {
    expect(() => spendInputSchema.parse({})).toThrow();
  });

  it("optional period accepts at minimum 'day' / 'week' / 'month'", () => {
    expect(() =>
      spendInputSchema.parse({ group_by: "provider", period: "day" }),
    ).not.toThrow();
    expect(() =>
      spendInputSchema.parse({ group_by: "provider", period: "week" }),
    ).not.toThrow();
    expect(() =>
      spendInputSchema.parse({ group_by: "provider", period: "month" }),
    ).not.toThrow();
  });

  it("optional project_id accepts a string", () => {
    const parsed = spendInputSchema.parse({
      group_by: "provider",
      project_id: "proj-1",
    }) as { project_id?: string };
    expect(parsed.project_id).toBe("proj-1");
  });
});

describe("D-C6-4 spendTool — phantom-wiring guard", () => {
  it("source imports the canonical `list*` names (NOT the LEFT-column names)", () => {
    const sourcePath = resolve(__dirname, "../../src/tools/spend.ts");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("listSpendByProvider");
    expect(source).toContain("listSpendByModel");
    expect(source).toContain("listSpendByFramework");
    expect(source).toContain("listDailySpend");

    const importLines = source
      .split("\n")
      .filter((l) => l.includes("@recondo/data"));
    for (const line of importLines) {
      // Bare `spendByProvider`/`spendByModel`/`spendByFramework`/`dailySpend`
      // (not preceded by `list`) are forbidden.
      const forbidden = [
        /(?<!list)\bspendByProvider\b/,
        /(?<!list)\bspendByModel\b/,
        /(?<!list)\bspendByFramework\b/,
        /(?<!list)\bdailySpend\b/,
      ];
      for (const re of forbidden) {
        const m = re.exec(line);
        expect(m, `forbidden bare name in: ${line}`).toBeNull();
      }
    }
  });
});

describe("D-C6-4 spendTool handler — dispatch (4 group_by values)", () => {
  beforeEach(() => {
    listSpendByProvider.mockReset();
    listSpendByModel.mockReset();
    listSpendByFramework.mockReset();
    listDailySpend.mockReset();
  });

  it("group_by=provider -> listSpendByProvider", async () => {
    listSpendByProvider.mockResolvedValueOnce(envelopeWith([sampleBucket]));
    const ctx = makeCtx();

    await spendTool.handler({ group_by: "provider" } as never, ctx);

    expect(listSpendByProvider).toHaveBeenCalledTimes(1);
    expect(listSpendByModel).toHaveBeenCalledTimes(0);
    expect(listSpendByFramework).toHaveBeenCalledTimes(0);
    expect(listDailySpend).toHaveBeenCalledTimes(0);
  });

  it("group_by=model -> listSpendByModel", async () => {
    listSpendByModel.mockResolvedValueOnce(envelopeWith([sampleBucket]));
    const ctx = makeCtx();

    await spendTool.handler({ group_by: "model" } as never, ctx);

    expect(listSpendByProvider).toHaveBeenCalledTimes(0);
    expect(listSpendByModel).toHaveBeenCalledTimes(1);
    expect(listSpendByFramework).toHaveBeenCalledTimes(0);
    expect(listDailySpend).toHaveBeenCalledTimes(0);
  });

  it("group_by=framework -> listSpendByFramework", async () => {
    listSpendByFramework.mockResolvedValueOnce(envelopeWith([sampleBucket]));
    const ctx = makeCtx();

    await spendTool.handler({ group_by: "framework" } as never, ctx);

    expect(listSpendByProvider).toHaveBeenCalledTimes(0);
    expect(listSpendByModel).toHaveBeenCalledTimes(0);
    expect(listSpendByFramework).toHaveBeenCalledTimes(1);
    expect(listDailySpend).toHaveBeenCalledTimes(0);
  });

  it("group_by=daily -> listDailySpend", async () => {
    listDailySpend.mockResolvedValueOnce(envelopeWith([sampleBucket]));
    const ctx = makeCtx();

    await spendTool.handler({ group_by: "daily" } as never, ctx);

    expect(listSpendByProvider).toHaveBeenCalledTimes(0);
    expect(listSpendByModel).toHaveBeenCalledTimes(0);
    expect(listSpendByFramework).toHaveBeenCalledTimes(0);
    expect(listDailySpend).toHaveBeenCalledTimes(1);
  });
});

describe("D-C6-4 spendTool handler — signal threading", () => {
  beforeEach(() => {
    listSpendByProvider.mockReset();
    listSpendByModel.mockReset();
    listSpendByFramework.mockReset();
    listDailySpend.mockReset();
  });

  it("threads ctx.abortSignal into options.signal of the dispatched call", async () => {
    listSpendByProvider.mockResolvedValueOnce(emptyEnvelope);
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await spendTool.handler({ group_by: "provider" } as never, ctx);

    const callArgs = listSpendByProvider.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("propagates AbortError when the dispatched call rejects", async () => {
    listSpendByModel.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await expect(
      spendTool.handler({ group_by: "model" } as never, ctx),
    ).rejects.toThrow();
  });
});

describe("D-C6-4 spendTool handler — output envelope", () => {
  beforeEach(() => {
    listSpendByProvider.mockReset();
    listSpendByModel.mockReset();
    listSpendByFramework.mockReset();
    listDailySpend.mockReset();
  });

  it("returns the canonical 5-key list envelope shape", async () => {
    listSpendByProvider.mockResolvedValueOnce(envelopeWith([sampleBucket]));
    const ctx = makeCtx();

    const result = (await spendTool.handler(
      { group_by: "provider" } as never,
      ctx,
    )) as Record<string, unknown>;

    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("next_offset");
    expect(result).toHaveProperty("truncated");
    expect(result).toHaveProperty("stream_id");
    expect(result).toHaveProperty("is_final");
    expect(result.is_final).toBe(true);
    expect(result.stream_id).toBeNull();
    expect(Array.isArray(result.items)).toBe(true);
  });

  it("preserves the bucket fields on the wire", async () => {
    listSpendByProvider.mockResolvedValueOnce(envelopeWith([sampleBucket]));
    const ctx = makeCtx();

    const result = (await spendTool.handler(
      { group_by: "provider" } as never,
      ctx,
    )) as Record<string, unknown>;

    const wholeJson = JSON.stringify(result);
    expect(wholeJson).toContain("anthropic");
    expect(wholeJson).toContain("1.23");
  });
});
