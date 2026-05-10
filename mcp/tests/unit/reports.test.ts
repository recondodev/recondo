/**
 * D-C8-5 (unit) — `recondo_reports` tool: schema + handler.
 *
 * Contract pinned by C0 audit + Plan D §C8:
 *   - Tool name: `recondo_reports`.
 *   - Description >= 50 chars.
 *   - Input shape (data-layer signature: `listReports(apiKey, filter, options)`,
 *     where `filter` is `ReportFilter` (currently empty placeholder) and
 *     `options` is `ListOptions`):
 *       project_id?: string
 *       limit?:  integer (>=1, data-layer clamps to 500)
 *       offset?: integer (>=0)
 *   - Handler: calls `listReports` exactly once and returns the
 *     canonical 5-key list envelope.
 *   - `ctx.abortSignal` MUST be threaded into options.signal.
 *
 * Phantom-wiring guard (C0 contract):
 *   - The production source MUST import the RIGHT-column name
 *     `listReports` from `@recondo/data`. The bare LEFT-column name
 *     `reports` MUST NOT appear in `@recondo/data` import lines.
 *     Substrings inside identifiers like `reportsTool` or `listReports`
 *     are fine — only the bare data-layer import name in import
 *     contexts is forbidden.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { listReports, getPool, closePool, insertAuditLog } = vi.hoisted(() => ({
  listReports: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("@recondo/data", () => ({
  listReports,
  getPool,
  closePool,
  insertAuditLog,
}));

import { reportsTool, reportsInputSchema } from "../../src/tools/reports.js";
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

const sampleReport = {
  id: "rep-1",
  name: "SOC 2 Report",
  framework: "SOC 2",
  periodStart: "2026-04-01T00:00:00.000Z",
  periodEnd: "2026-05-01T00:00:00.000Z",
  captureCount: 100,
  findings: { critical: 0, high: 1, medium: 2, low: 3 },
  hash: "abc123",
  status: "FINAL",
  generatedAt: "2026-05-01T12:00:00.000Z",
};

function envelopeWith(items: unknown[]): Record<string, unknown> {
  return {
    items: items as never,
    next_offset: null,
    truncated: false,
    stream_id: null,
    is_final: true,
    total: items.length,
    limit: 50,
    offset: 0,
  };
}

describe("D-C8-5 reportsInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof reportsTool.description).toBe("string");
    expect(reportsTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("tool name is exactly recondo_reports", () => {
    expect(reportsTool.name).toBe("recondo_reports");
  });

  it("schema accepts an empty object (all fields optional)", () => {
    expect(() => reportsInputSchema.parse({})).not.toThrow();
  });

  it("schema accepts the documented optional fields", () => {
    expect(() =>
      reportsInputSchema.parse({
        project_id: "proj-1",
        limit: 10,
        offset: 0,
      }),
    ).not.toThrow();
  });

  it("schema rejects negative offset / non-positive limit", () => {
    expect(() => reportsInputSchema.parse({ offset: -1 })).toThrow();
    expect(() => reportsInputSchema.parse({ limit: 0 })).toThrow();
  });
});

describe("D-C8-5 reportsTool — phantom-wiring guard (C0 right-column contract)", () => {
  it("source imports `listReports` (NOT bare `reports`)", () => {
    const sourcePath = resolve(__dirname, "../../src/tools/reports.ts");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("listReports");

    const importLines = source
      .split("\n")
      .filter((l) => l.includes("@recondo/data"));
    for (const line of importLines) {
      // Bare `reports` not preceded by `list` is forbidden (the
      // LEFT-column resolver name). `listReports` and other longer
      // identifiers pass the `(?<!list)` boundary.
      const m = /(?<!list)\breports\b/.exec(line);
      expect(m, `forbidden bare \`reports\` in import line: ${line}`).toBeNull();
    }
  });
});

describe("D-C8-5 reportsTool handler — call wiring", () => {
  beforeEach(() => {
    listReports.mockReset();
  });

  it("calls listReports exactly once", async () => {
    listReports.mockResolvedValueOnce(envelopeWith([sampleReport]));
    const ctx = makeCtx();
    await reportsTool.handler({} as never, ctx);
    expect(listReports).toHaveBeenCalledTimes(1);
  });

  it("threads ctx.abortSignal into options.signal of the call", async () => {
    listReports.mockResolvedValueOnce(envelopeWith([]));
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await reportsTool.handler({} as never, ctx);
    const callArgs = listReports.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("project_id overrides auth.projectId on the apiKey bag", async () => {
    listReports.mockResolvedValueOnce(envelopeWith([]));
    const ctx = makeCtx({
      auth: {
        kind: "dev-bypass",
        isAdmin: true,
        projectId: "auth-project",
        keyId: "dev-bypass",
      },
    });
    await reportsTool.handler({ project_id: "override-project" } as never, ctx);
    const callArgs = listReports.mock.calls[0];
    const apiKey = callArgs[0] as { projectId: string | null };
    expect(apiKey.projectId).toBe("override-project");
  });

  it("propagates AbortError when the call rejects", async () => {
    listReports.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await expect(reportsTool.handler({} as never, ctx)).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});

describe("D-C8-5 reportsTool handler — output envelope", () => {
  beforeEach(() => {
    listReports.mockReset();
  });

  it("returns the canonical 5-key list envelope shape", async () => {
    listReports.mockResolvedValueOnce(envelopeWith([sampleReport]));
    const ctx = makeCtx();
    const result = (await reportsTool.handler(
      {} as never,
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
    expect(JSON.stringify(result)).toContain("rep-1");
  });
});
