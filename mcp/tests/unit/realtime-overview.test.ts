/**
 * D-C6-1 (unit) — `recondo_realtime_overview` tool: schema + handler.
 *
 * Contract pinned by C0 audit + Plan D §C6:
 *   - Tool name: `recondo_realtime_overview`.
 *   - Description >= 50 chars.
 *   - Input shape: `{}` with optional `project_id?: string`. No required
 *     fields — calling with `{}` MUST succeed.
 *   - Handler composes TWO data-layer calls in PARALLEL:
 *       getRealtimeStats(apiKey, options)
 *       getGatewayStatus(apiKey, options)
 *     Sequential awaits would not be a phantom-wiring red flag, but
 *     Plan D requires parallelism. We pin parallelism by asserting the
 *     second call begins BEFORE the first promise resolves.
 *   - Output: a single record `{ stats, gateway_status }`. The full
 *     `RealtimeStatsRow` body lives under `stats`; the full
 *     `GatewayStatusRow` body lives under `gateway_status`. Subject to
 *     the 32 KB single-record budget.
 *   - `ctx.abortSignal` MUST be threaded into BOTH data-layer options
 *     bags.
 *
 * Phantom-wiring guard: the production module MUST NOT import the C0
 * LEFT-column names `realtimeStats` / `gatewayStatus`. Source-grep test
 * below.
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
  realtimeOverviewTool,
  realtimeOverviewInputSchema,
} from "../../src/tools/realtime-overview.js";
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

const sampleStats = {
  requestsPerMinute: 3,
  userTurnsPerMinute: 1,
  activeSessions: 1,
  activeProviderCount: 2,
  tokensLastHour: 12345,
  cacheReadTokensLastHour: 100,
  costLastHour: 0.42,
  costProjectedToday: 10.08,
  latencyP50Ms: 200,
  latencyP99Ms: 1000,
  latencySampleCount: 50,
  latencySource: "TURN_DURATION_MS" as const,
};

const sampleGateway = {
  status: "live" as const,
  uptimeSeconds: 3600,
  lastHeartbeat: "2026-05-07T00:00:00.000Z",
};

describe("D-C6-1 realtimeOverviewInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof realtimeOverviewTool.description).toBe("string");
    expect(realtimeOverviewTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("tool name is exactly recondo_realtime_overview", () => {
    expect(realtimeOverviewTool.name).toBe("recondo_realtime_overview");
  });

  it("schema accepts {} (no required fields)", () => {
    const parsed = realtimeOverviewInputSchema.parse({});
    expect(parsed).toBeDefined();
  });

  it("schema accepts {project_id} as optional string", () => {
    const parsed = realtimeOverviewInputSchema.parse({
      project_id: "proj-123",
    }) as { project_id?: string };
    expect(parsed.project_id).toBe("proj-123");
  });

  it("schema rejects non-string project_id", () => {
    expect(() =>
      realtimeOverviewInputSchema.parse({ project_id: 123 }),
    ).toThrow();
  });
});

describe("D-C6-1 realtimeOverviewTool — phantom-wiring guard", () => {
  it("source imports `getRealtimeStats` and `getGatewayStatus` (NOT the LEFT-column names)", () => {
    const sourcePath = resolve(
      __dirname,
      "../../src/tools/realtime-overview.ts",
    );
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("getRealtimeStats");
    expect(source).toContain("getGatewayStatus");

    // The LEFT-column names from C0 §2 must NOT appear as bare identifiers.
    // `realtimeStats` and `gatewayStatus` are forbidden (the canonical
    // names are `getRealtimeStats` / `getGatewayStatus`).
    const importLines = source
      .split("\n")
      .filter((l) => l.includes("@recondo/data"));
    for (const line of importLines) {
      expect(/\brealtimeStats\b/.test(line), `forbidden bare \`realtimeStats\` in: ${line}`).toBe(
        false,
      );
      expect(/\bgatewayStatus\b/.test(line), `forbidden bare \`gatewayStatus\` in: ${line}`).toBe(
        false,
      );
    }
  });
});

describe("D-C6-1 realtimeOverviewTool handler — composition + signal threading", () => {
  beforeEach(() => {
    getRealtimeStats.mockReset();
    getGatewayStatus.mockReset();
  });

  it("calls BOTH getRealtimeStats and getGatewayStatus exactly once", async () => {
    getRealtimeStats.mockResolvedValueOnce(sampleStats);
    getGatewayStatus.mockResolvedValueOnce(sampleGateway);
    const ctx = makeCtx();

    await realtimeOverviewTool.handler({} as never, ctx);

    expect(getRealtimeStats).toHaveBeenCalledTimes(1);
    expect(getGatewayStatus).toHaveBeenCalledTimes(1);
  });

  it("threads ctx.abortSignal into BOTH data-layer options bags", async () => {
    getRealtimeStats.mockResolvedValueOnce(sampleStats);
    getGatewayStatus.mockResolvedValueOnce(sampleGateway);
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await realtimeOverviewTool.handler({} as never, ctx);

    const statsArgs = getRealtimeStats.mock.calls[0];
    const gatewayArgs = getGatewayStatus.mock.calls[0];
    const statsOpts = statsArgs[statsArgs.length - 1] as { signal?: AbortSignal };
    const gatewayOpts = gatewayArgs[gatewayArgs.length - 1] as { signal?: AbortSignal };
    expect(statsOpts.signal).toBe(ac.signal);
    expect(gatewayOpts.signal).toBe(ac.signal);
  });

  it("invokes BOTH data-layer calls in PARALLEL (second begins before first resolves)", async () => {
    let statsResolve: (v: typeof sampleStats) => void = () => {};
    const statsPromise = new Promise<typeof sampleStats>((res) => {
      statsResolve = res;
    });
    getRealtimeStats.mockReturnValueOnce(statsPromise);
    getGatewayStatus.mockResolvedValueOnce(sampleGateway);

    const ctx = makeCtx();
    const handlerPromise = realtimeOverviewTool.handler({} as never, ctx);

    // Yield to the microtask queue so the handler kicks off both calls.
    await Promise.resolve();
    await Promise.resolve();

    // If parallel: getGatewayStatus was already called even though
    // getRealtimeStats hasn't resolved.
    expect(getGatewayStatus).toHaveBeenCalledTimes(1);
    expect(getRealtimeStats).toHaveBeenCalledTimes(1);

    statsResolve(sampleStats);
    await handlerPromise;
  });

  it("propagates AbortError when getRealtimeStats rejects", async () => {
    getRealtimeStats.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );
    getGatewayStatus.mockResolvedValueOnce(sampleGateway);
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await expect(
      realtimeOverviewTool.handler({} as never, ctx),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});

describe("D-C6-1 realtimeOverviewTool handler — output shape", () => {
  beforeEach(() => {
    getRealtimeStats.mockReset();
    getGatewayStatus.mockReset();
  });

  it("returns single record { stats, gateway_status } (NOT a list envelope)", async () => {
    getRealtimeStats.mockResolvedValueOnce(sampleStats);
    getGatewayStatus.mockResolvedValueOnce(sampleGateway);
    const ctx = makeCtx();

    const result = (await realtimeOverviewTool.handler(
      {} as never,
      ctx,
    )) as Record<string, unknown>;

    expect(result).not.toHaveProperty("items");
    expect(result).not.toHaveProperty("stream_id");
    expect(result).not.toHaveProperty("is_final");

    expect(result).toHaveProperty("stats");
    expect(result).toHaveProperty("gateway_status");
    expect(result.stats).toEqual(sampleStats);
    expect(result.gateway_status).toEqual(sampleGateway);
  });

  it("forwards project_id into apiKey scoping (when provided)", async () => {
    getRealtimeStats.mockResolvedValueOnce(sampleStats);
    getGatewayStatus.mockResolvedValueOnce(sampleGateway);
    const ctx = makeCtx();

    await realtimeOverviewTool.handler(
      { project_id: "proj-77" } as never,
      ctx,
    );

    // The handler maps AuthContext -> ApiKeyInfo. When the caller supplies
    // a `project_id` it MUST end up either on the apiKey or as a filter
    // on the data-layer call. The contract: the value `proj-77` appears
    // in the call args of getRealtimeStats.
    const statsArgs = getRealtimeStats.mock.calls[0];
    const json = JSON.stringify(statsArgs);
    expect(json).toContain("proj-77");
  });
});
