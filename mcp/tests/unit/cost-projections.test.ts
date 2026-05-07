/**
 * D-C6-5 (unit) — `recondo_cost_projections` tool: schema + handler.
 *
 * Contract pinned by C0 audit + Plan D §C6:
 *   - Tool name: `recondo_cost_projections`.
 *   - Description >= 50 chars.
 *   - Input shape:
 *       period?:    z.enum([...])  (matches usage-summary's enum)
 *       project_id?: string
 *   - Handler is a thin pass-through to `getCostProjections(apiKey, period,
 *     options)` from `@recondo/data` (cost.ts:345). NOTE: `period` is the
 *     SECOND POSITIONAL ARG to the data layer (NOT inside an args bag).
 *     A common mistake is `getCostProjections(apiKey, {period}, options)` —
 *     that is wrong; the data-layer signature is
 *     `getCostProjections(apiKey, _period?: string | null, options)`.
 *   - Output: the data layer returns `CostProjection[]` (a plain array).
 *     The handler MUST return either:
 *       (a) the array verbatim (since it's a fixed 3-element list), or
 *       (b) a single record `{ projections: CostProjection[] }`.
 *     Either is acceptable as long as the structured projections survive.
 *   - `ctx.abortSignal` MUST be threaded into the data-layer options.
 *
 * Phantom-wiring guard: production source MUST NOT import the LEFT-column
 * name `costProjections` (the canonical name is `getCostProjections`).
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
  costProjectionsTool,
  costProjectionsInputSchema,
} from "../../src/tools/cost-projections.js";
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

const sampleProjections = [
  {
    month: "2026-06",
    projectedSessions: 100,
    projectedTokens: 1_000_000,
    projectedCostUsd: 10.5,
    deltaVsCurrent: 5,
    assumptions: "Assumed 5% monthly growth.",
  },
  {
    month: "2026-07",
    projectedSessions: 110,
    projectedTokens: 1_100_000,
    projectedCostUsd: 11.025,
    deltaVsCurrent: 10.25,
    assumptions: "Assumed 10% monthly growth.",
  },
  {
    month: "2026-08",
    projectedSessions: 121,
    projectedTokens: 1_210_000,
    projectedCostUsd: 11.576,
    deltaVsCurrent: 15.76,
    assumptions: "Assumed 15% monthly growth.",
  },
];

describe("D-C6-5 costProjectionsInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof costProjectionsTool.description).toBe("string");
    expect(costProjectionsTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("tool name is exactly recondo_cost_projections", () => {
    expect(costProjectionsTool.name).toBe("recondo_cost_projections");
  });

  it("schema accepts {} (no required fields)", () => {
    expect(() => costProjectionsInputSchema.parse({})).not.toThrow();
  });

  it("schema accepts optional period from the canonical enum", () => {
    expect(() =>
      costProjectionsInputSchema.parse({ period: "week" }),
    ).not.toThrow();
    expect(() =>
      costProjectionsInputSchema.parse({ period: "month" }),
    ).not.toThrow();
  });

  it("schema rejects bogus period values", () => {
    expect(() =>
      costProjectionsInputSchema.parse({ period: "BOGUS" }),
    ).toThrow();
  });

  it("schema accepts optional project_id string", () => {
    const parsed = costProjectionsInputSchema.parse({
      project_id: "proj-1",
    }) as { project_id?: string };
    expect(parsed.project_id).toBe("proj-1");
  });

  it("schema rejects non-string project_id", () => {
    expect(() =>
      costProjectionsInputSchema.parse({ project_id: 7 }),
    ).toThrow();
  });
});

describe("D-C6-5 costProjectionsTool — phantom-wiring guard", () => {
  it("source imports `getCostProjections` (NOT the LEFT-column `costProjections`)", () => {
    const sourcePath = resolve(
      __dirname,
      "../../src/tools/cost-projections.ts",
    );
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("getCostProjections");

    const importLines = source
      .split("\n")
      .filter((l) => l.includes("@recondo/data"));
    for (const line of importLines) {
      // Bare `costProjections` (not preceded by `get`) is forbidden.
      const bareMatch = /(?<!get)\bcostProjections\b/.exec(line);
      expect(bareMatch, `forbidden bare \`costProjections\` in: ${line}`).toBeNull();
    }
  });
});

describe("D-C6-5 costProjectionsTool handler — call-shape + signal threading", () => {
  beforeEach(() => {
    getCostProjections.mockReset();
  });

  it("calls getCostProjections(apiKey, period, options) — period is positional #2", async () => {
    getCostProjections.mockResolvedValueOnce(sampleProjections);
    const ctx = makeCtx();

    await costProjectionsTool.handler({ period: "month" } as never, ctx);

    expect(getCostProjections).toHaveBeenCalledTimes(1);
    const callArgs = getCostProjections.mock.calls[0];
    expect(callArgs.length).toBe(3);

    const apiKey = callArgs[0] as { id: string; projectId: string | null };
    expect(apiKey).toBeDefined();
    expect(typeof apiKey.id).toBe("string");

    // Positional #2 must NOT be an object (would be a phantom-wiring slip
    // mirroring the args-bag style used by other cost.ts functions).
    const second = callArgs[1];
    expect(typeof second === "string" || second === null || second === undefined).toBe(true);
  });

  it("threads ctx.abortSignal into the options bag", async () => {
    getCostProjections.mockResolvedValueOnce(sampleProjections);
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await costProjectionsTool.handler({} as never, ctx);

    const callArgs = getCostProjections.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("propagates AbortError when getCostProjections rejects", async () => {
    getCostProjections.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await expect(
      costProjectionsTool.handler({} as never, ctx),
    ).rejects.toThrow();
  });
});

describe("D-C6-5 costProjectionsTool handler — output shape", () => {
  beforeEach(() => {
    getCostProjections.mockReset();
  });

  it("preserves the projection rows on the wire", async () => {
    getCostProjections.mockResolvedValueOnce(sampleProjections);
    const ctx = makeCtx();

    const result = (await costProjectionsTool.handler(
      { period: "month" } as never,
      ctx,
    )) as unknown;

    const wholeJson = JSON.stringify(result);
    expect(wholeJson).toContain("2026-06");
    expect(wholeJson).toContain("2026-07");
    expect(wholeJson).toContain("2026-08");
    // Both array-verbatim and {projections: [...]} shapes carry the same
    // values; we assert the values, not the wrapping.
    expect(wholeJson).toContain("monthly growth");
  });
});

describe("D-C6-5 costProjectionsTool — pre-aborted signal", () => {
  beforeEach(() => {
    getCostProjections.mockReset();
  });

  it("rejects with AbortError when ctx.abortSignal is pre-aborted", async () => {
    getCostProjections.mockImplementation((..._args: unknown[]) => {
      const opts = _args[_args.length - 1] as { signal?: AbortSignal };
      if (opts?.signal?.aborted) {
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }
      return Promise.resolve(sampleProjections);
    });
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await expect(
      costProjectionsTool.handler({} as never, ctx),
    ).rejects.toThrow();
  });
});
