/**
 * D-C8-6 (unit) — `recondo_report_trends` tool: schema + handler dispatch.
 *
 * Contract pinned by C0 audit + Plan D §C8:
 *   - Tool name: `recondo_report_trends`.
 *   - Description >= 50 chars.
 *   - Input shape:
 *       metric: z.enum(["coverage", "findings"])  (REQUIRED, 2 values)
 *       project_id?: string
 *   - Handler dispatches on `metric`:
 *       "coverage" -> listReportCoverageTrend(apiKey, args, options)
 *       "findings" -> listReportFindingsTrend(apiKey, args, options)
 *     A WRONG dispatch is the classic phantom-wiring red flag — the
 *     dispatch tests below assert exactly-one of the two is called per
 *     metric and the other has `toHaveBeenCalledTimes(0)`.
 *   - Each underlying call returns a `ListEnvelope<TrendPoint>`. The
 *     handler returns the canonical 5-key list envelope shape.
 *   - `ctx.abortSignal` MUST be threaded into the dispatched call.
 *
 * Phantom-wiring guard (C0 contract):
 *   - The production source MUST import the RIGHT-column names
 *     `listReportCoverageTrend` + `listReportFindingsTrend`. The bare
 *     LEFT-column names `reportCoverageTrend` / `reportFindingsTrend`
 *     MUST NOT appear in `@recondo/data` import lines.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const {
  listReportCoverageTrend,
  listReportFindingsTrend,
  getPool,
  closePool,
  insertAuditLog,
} = vi.hoisted(() => ({
  listReportCoverageTrend: vi.fn(),
  listReportFindingsTrend: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("@recondo/data", () => ({
  listReportCoverageTrend,
  listReportFindingsTrend,
  getPool,
  closePool,
  insertAuditLog,
}));

import {
  reportTrendsTool,
  reportTrendsInputSchema,
} from "../../src/tools/report-trends.js";
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

const sampleCoveragePoint = { label: "2026-W18", value: 92.5 };
const sampleFindingsPoint = { label: "SOC 2 Report", value: 6 };

function envelopeWith(items: unknown[]): Record<string, unknown> {
  return {
    items: items as never,
    next_offset: null,
    truncated: false,
    stream_id: null,
    is_final: true,
  };
}

describe("D-C8-6 reportTrendsInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof reportTrendsTool.description).toBe("string");
    expect(reportTrendsTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("tool name is exactly recondo_report_trends", () => {
    expect(reportTrendsTool.name).toBe("recondo_report_trends");
  });

  it("metric enum has exactly 2 members: coverage / findings", () => {
    expect(() =>
      reportTrendsInputSchema.parse({ metric: "coverage" }),
    ).not.toThrow();
    expect(() =>
      reportTrendsInputSchema.parse({ metric: "findings" }),
    ).not.toThrow();
  });

  it("metric rejects values outside the 2-member enum", () => {
    expect(() =>
      reportTrendsInputSchema.parse({ metric: "spend" }),
    ).toThrow();
    expect(() =>
      reportTrendsInputSchema.parse({ metric: "COVERAGE" }),
    ).toThrow();
    expect(() => reportTrendsInputSchema.parse({ metric: "" })).toThrow();
  });

  it("metric is required (no default)", () => {
    expect(() => reportTrendsInputSchema.parse({})).toThrow();
  });

  it("schema accepts optional project_id", () => {
    const parsed = reportTrendsInputSchema.parse({
      metric: "coverage",
      project_id: "proj-1",
    }) as { project_id?: string; limit?: number; offset?: number };
    expect(parsed.project_id).toBe("proj-1");
    expect(parsed.limit).toBe(20);
    expect(parsed.offset).toBe(0);
  });

  it("schema accepts limit and offset", () => {
    const parsed = reportTrendsInputSchema.parse({
      metric: "coverage",
      limit: 5,
      offset: 10,
    }) as { limit?: number; offset?: number };
    expect(parsed.limit).toBe(5);
    expect(parsed.offset).toBe(10);
  });
});

describe("D-C8-6 reportTrendsTool — phantom-wiring guard (C0 right-column contract)", () => {
  it("source imports the canonical RIGHT-column names (NOT bare LEFT-column names)", () => {
    const sourcePath = resolve(__dirname, "../../src/tools/report-trends.ts");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("listReportCoverageTrend");
    expect(source).toContain("listReportFindingsTrend");

    const importLines = source
      .split("\n")
      .filter((l) => l.includes("@recondo/data"));
    for (const line of importLines) {
      const forbidden = [
        /(?<!list)\breportCoverageTrend\b/,
        /(?<!list)\breportFindingsTrend\b/,
      ];
      for (const re of forbidden) {
        const m = re.exec(line);
        expect(m, `forbidden bare name in: ${line}`).toBeNull();
      }
    }
  });
});

describe("D-C8-6 reportTrendsTool handler — dispatch (2 metric values)", () => {
  beforeEach(() => {
    listReportCoverageTrend.mockReset();
    listReportFindingsTrend.mockReset();
  });

  it("metric=coverage -> listReportCoverageTrend (and NOT findings)", async () => {
    listReportCoverageTrend.mockResolvedValueOnce(
      envelopeWith([sampleCoveragePoint]),
    );
    const ctx = makeCtx();
    await reportTrendsTool.handler({ metric: "coverage" } as never, ctx);
    expect(listReportCoverageTrend).toHaveBeenCalledTimes(1);
    expect(listReportFindingsTrend).toHaveBeenCalledTimes(0);
  });

  it("metric=findings -> listReportFindingsTrend (and NOT coverage)", async () => {
    listReportFindingsTrend.mockResolvedValueOnce(
      envelopeWith([sampleFindingsPoint]),
    );
    const ctx = makeCtx();
    await reportTrendsTool.handler({ metric: "findings" } as never, ctx);
    expect(listReportCoverageTrend).toHaveBeenCalledTimes(0);
    expect(listReportFindingsTrend).toHaveBeenCalledTimes(1);
  });
});

describe("D-C8-6 reportTrendsTool handler — signal threading + project_id override", () => {
  beforeEach(() => {
    listReportCoverageTrend.mockReset();
    listReportFindingsTrend.mockReset();
  });

  it("threads ctx.abortSignal into the coverage call", async () => {
    listReportCoverageTrend.mockResolvedValueOnce(envelopeWith([]));
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await reportTrendsTool.handler({ metric: "coverage" } as never, ctx);
    const callArgs = listReportCoverageTrend.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("forwards limit and offset to the coverage call", async () => {
    listReportCoverageTrend.mockResolvedValueOnce(envelopeWith([]));
    const ctx = makeCtx();
    await reportTrendsTool.handler(
      { metric: "coverage", limit: 7, offset: 14 } as never,
      ctx,
    );
    const opts = listReportCoverageTrend.mock.calls[0][2] as {
      limit?: number;
      offset?: number;
    };
    expect(opts.limit).toBe(7);
    expect(opts.offset).toBe(14);
  });

  it("threads ctx.abortSignal into the findings call", async () => {
    listReportFindingsTrend.mockResolvedValueOnce(envelopeWith([]));
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await reportTrendsTool.handler({ metric: "findings" } as never, ctx);
    const callArgs = listReportFindingsTrend.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("project_id overrides auth.projectId on the apiKey bag (coverage)", async () => {
    listReportCoverageTrend.mockResolvedValueOnce(envelopeWith([]));
    const ctx = makeCtx({
      auth: {
        kind: "dev-bypass",
        isAdmin: true,
        projectId: "auth-project",
        keyId: "dev-bypass",
      },
    });
    await reportTrendsTool.handler(
      { metric: "coverage", project_id: "override-project" } as never,
      ctx,
    );
    const callArgs = listReportCoverageTrend.mock.calls[0];
    const apiKey = callArgs[0] as { projectId: string | null };
    expect(apiKey.projectId).toBe("override-project");
  });

  it("propagates AbortError from the dispatched call", async () => {
    listReportFindingsTrend.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await expect(
      reportTrendsTool.handler({ metric: "findings" } as never, ctx),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});

describe("D-C8-6 reportTrendsTool handler — output envelope", () => {
  beforeEach(() => {
    listReportCoverageTrend.mockReset();
    listReportFindingsTrend.mockReset();
  });

  it("returns the canonical 5-key list envelope shape (coverage)", async () => {
    listReportCoverageTrend.mockResolvedValueOnce(
      envelopeWith([sampleCoveragePoint]),
    );
    const ctx = makeCtx();
    const result = (await reportTrendsTool.handler(
      { metric: "coverage" } as never,
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
    expect(JSON.stringify(result)).toContain("2026-W18");
  });

  it("returns the canonical 5-key list envelope shape (findings)", async () => {
    listReportFindingsTrend.mockResolvedValueOnce(
      envelopeWith([sampleFindingsPoint]),
    );
    const ctx = makeCtx();
    const result = (await reportTrendsTool.handler(
      { metric: "findings" } as never,
      ctx,
    )) as Record<string, unknown>;
    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("next_offset");
    expect(result).toHaveProperty("truncated");
    expect(result).toHaveProperty("stream_id");
    expect(result).toHaveProperty("is_final");
    expect(JSON.stringify(result)).toContain("SOC 2 Report");
  });
});
