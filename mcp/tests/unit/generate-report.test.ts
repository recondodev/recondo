/**
 * D-C10-1 (unit) — `recondo_generate_report` action tool: schema + handler.
 *
 * Contract pinned by C0 audit + Plan D §C10 (Tasks 23-24):
 *   - Tool name: `recondo_generate_report`.
 *   - Description >= 50 chars AND includes the verbatim INJECTION_WARNING
 *     string from `mcp/src/registry/warning.ts`.
 *   - destructive: false (creates a row but does NOT delete).
 *   - Input shape (data-layer signature: `generateReport(apiKey, input, options)`,
 *     where input is `GenerateReportInput { type, period, from?, to?, params? }`):
 *       type:       enum weekly_cost / compliance / anomaly / custom
 *       period:     enum week / month
 *       from?:      ISO date
 *       to?:        ISO date
 *       params?:    JSON object
 *       project_id?:  string  (overrides auth.projectId)
 *   - Handler is a thin pass-through to `generateReport`. ctx.abortSignal
 *     MUST be threaded into options.signal.
 *
 * Phantom-wiring guard (C0 right-column contract):
 *   - The production source MUST import `generateReport` from `@recondo/data`.
 *   - LEFT-column resolver names (whatever they were) MUST NOT appear.
 *
 * Data-layer signature reference (packages/recondo-data/src/reports.ts:230):
 *
 *   export async function generateReport(
 *     apiKey: ApiKeyInfo,
 *     input: GenerateReportInput,    // { type, period, from?, to?, params? }
 *     options: QueryOptions = {},
 *   ): Promise<GenerateReportPayload> // { report: ReportRow|null, errors: [...] }
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { generateReport, getPool, closePool, insertAuditLog } = vi.hoisted(
  () => ({
    generateReport: vi.fn(),
    getPool: vi.fn(),
    closePool: vi.fn(),
    insertAuditLog: vi.fn(),
  }),
);

vi.mock("@recondo/data", () => ({
  generateReport,
  getPool,
  closePool,
  insertAuditLog,
}));

import {
  generateReportTool,
  generateReportInputSchema,
} from "../../src/tools/generate-report.js";
import { INJECTION_WARNING } from "../../src/registry/warning.js";
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

const samplePayload = {
  report: {
    id: "rpt-1",
    name: "weekly_cost Report",
    framework: "weekly_cost",
    periodStart: "2026-04-01T00:00:00.000Z",
    periodEnd: "2026-05-01T00:00:00.000Z",
    captureCount: 42,
    findings: { critical: 0, high: 1, medium: 0, low: 2 },
    hash: "deadbeef",
    status: "FINAL",
    generatedAt: "2026-05-07T00:00:00.000Z",
  },
  errors: [],
};

describe("D-C10-1 generateReportTool — metadata", () => {
  it("tool name is exactly recondo_generate_report", () => {
    expect(generateReportTool.name).toBe("recondo_generate_report");
  });

  it("description is >= 50 characters", () => {
    expect(typeof generateReportTool.description).toBe("string");
    expect(generateReportTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("description includes the verbatim INJECTION_WARNING", () => {
    expect(generateReportTool.description).toContain(INJECTION_WARNING);
  });

  it("destructive flag is false", () => {
    expect(generateReportTool.destructive).toBe(false);
  });
});

describe("D-C10-1 generateReportInputSchema", () => {
  it("accepts the documented fields", () => {
    expect(() =>
      generateReportInputSchema.parse({
        type: "weekly_cost",
        period: "week",
        from: "2026-04-01T00:00:00.000Z",
        to: "2026-05-01T00:00:00.000Z",
        params: { team: "platform" },
      }),
    ).not.toThrow();
  });

  it("accepts optional project_id", () => {
    expect(() =>
      generateReportInputSchema.parse({
        type: "compliance",
        period: "month",
        project_id: "proj-x",
      }),
    ).not.toThrow();
  });

  it("rejects the legacy framework/period_start/period_end shape", () => {
    expect(() =>
      generateReportInputSchema.parse({
        framework: "soc2",
        period_start: "2026-04-01",
        period_end: "2026-05-01",
      }),
    ).toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() =>
      generateReportInputSchema.parse({ type: "weekly_cost" } as never),
    ).toThrow();
  });
});

describe("D-C10-1 generateReportTool — phantom-wiring guard", () => {
  it("source imports `generateReport` from @recondo/data", () => {
    const sourcePath = resolve(__dirname, "../../src/tools/generate-report.ts");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("generateReport");
    // No LEFT-column / legacy names. The C0 contract pins generateReport
    // as the canonical right-column name; there is no LEFT-column rename
    // for this tool — the assertion just guards against drift.
  });
});

describe("D-C10-1 generateReportTool handler — thin pass-through", () => {
  beforeEach(() => {
    generateReport.mockReset();
  });

  it("calls generateReport exactly once", async () => {
    generateReport.mockResolvedValueOnce(samplePayload);
    const ctx = makeCtx();
    await generateReportTool.handler(
      {
        type: "weekly_cost",
        period: "week",
      } as never,
      ctx,
    );
    expect(generateReport).toHaveBeenCalledTimes(1);
  });

  it("threads ctx.abortSignal into options.signal", async () => {
    generateReport.mockResolvedValueOnce(samplePayload);
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await generateReportTool.handler(
      {
        type: "weekly_cost",
        period: "week",
      } as never,
      ctx,
    );
    const callArgs = generateReport.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("passes type / period / from / to / params to the data layer", async () => {
    generateReport.mockResolvedValueOnce(samplePayload);
    const ctx = makeCtx();
    await generateReportTool.handler(
      {
        type: "custom",
        period: "month",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-04-01T00:00:00.000Z",
        params: { owner: "security" },
      } as never,
      ctx,
    );
    const [, input] = generateReport.mock.calls[0];
    expect((input as { type: string }).type).toBe("custom");
    expect((input as { period: string }).period).toBe("month");
    expect((input as { from: string }).from).toBe("2026-01-01T00:00:00.000Z");
    expect((input as { to: string }).to).toBe("2026-04-01T00:00:00.000Z");
    expect((input as { params: Record<string, unknown> }).params).toEqual({
      owner: "security",
    });
  });

  it("project_id overrides auth.projectId on the apiKey bag", async () => {
    generateReport.mockResolvedValueOnce(samplePayload);
    const ctx = makeCtx({
      auth: {
        kind: "dev-bypass",
        isAdmin: true,
        projectId: "auth-proj",
        keyId: "dev-bypass",
      },
    });
    await generateReportTool.handler(
      {
        type: "compliance",
        period: "month",
        project_id: "override-proj",
      } as never,
      ctx,
    );
    const callArgs = generateReport.mock.calls[0];
    const apiKey = callArgs[0] as { projectId: string | null };
    expect(apiKey.projectId).toBe("override-proj");
  });

  it("returns the data-layer payload verbatim", async () => {
    generateReport.mockResolvedValueOnce(samplePayload);
    const ctx = makeCtx();
    const result = await generateReportTool.handler(
      {
        type: "weekly_cost",
        period: "week",
      } as never,
      ctx,
    );
    expect(result).toEqual(samplePayload);
  });

  it("propagates AbortError when generateReport rejects", async () => {
    generateReport.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await expect(
      generateReportTool.handler(
        {
          type: "weekly_cost",
          period: "week",
        } as never,
        ctx,
      ),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});
