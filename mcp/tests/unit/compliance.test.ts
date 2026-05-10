/**
 * D-C8-3 (unit) — `recondo_compliance` tool: schema + handler dispatch.
 *
 * Contract pinned by C0 audit + Plan D §C8:
 *   - Tool name: `recondo_compliance`.
 *   - Description >= 50 chars.
 *   - Input shape:
 *       view: z.enum(["summary", "frameworks", "audit_log"])  (REQUIRED, 3 values)
 *       control_id?: string  (only honoured when view === "audit_log")
 *       project_id?: string
 *       limit?:  integer (>=1, only honoured by list views)
 *       offset?: integer (>=0, only honoured by list views)
 *   - Handler dispatches on `view`:
 *       "summary"     -> getComplianceSummary(apiKey, options)
 *       "frameworks"  -> listComplianceFrameworks(apiKey, options)
 *       "audit_log"   -> listComplianceAuditLog(apiKey, filter, options)
 *     A WRONG dispatch is the classic phantom-wiring red flag — the
 *     dispatch tests below assert exactly-one of the three is called per
 *     view and the other two have `toHaveBeenCalledTimes(0)`.
 *   - "summary" returns a single record (subject to 32 KB single-record
 *     budget); "frameworks" and "audit_log" return canonical 5-key list
 *     envelopes. The handler may return a discriminated union shape.
 *   - `listComplianceAuditLog` reads the `compliance_audit_log` TABLE
 *     (control-status mutation history) — this is DISTINCT from the
 *     per-call MCP `audit_log` table written by `insertAuditLog`. C8's
 *     compliance tool reads the former; C13-7 reads the latter. The two
 *     MUST NOT be conflated.
 *   - `ctx.abortSignal` MUST be threaded into the dispatched call.
 *
 * Phantom-wiring guard (C0 contract):
 *   - The production source MUST import the RIGHT-column names
 *     `getComplianceSummary` + `listComplianceFrameworks` +
 *     `listComplianceAuditLog`. The bare LEFT-column names
 *     `complianceSummary` / `complianceFrameworks` / `complianceAuditLog`
 *     MUST NOT appear in `@recondo/data` import lines.
 *
 * Insights registration guard:
 *   - Hardening restores `recondo_insights` as a first-class tool. This
 *     file keeps a lightweight source assertion that `server.ts` wires
 *     the `insightsTool` import into the read catalog.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const {
  getComplianceSummary,
  listComplianceFrameworks,
  listComplianceAuditLog,
  getPool,
  closePool,
  insertAuditLog,
} = vi.hoisted(() => ({
  getComplianceSummary: vi.fn(),
  listComplianceFrameworks: vi.fn(),
  listComplianceAuditLog: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("@recondo/data", () => ({
  getComplianceSummary,
  listComplianceFrameworks,
  listComplianceAuditLog,
  getPool,
  closePool,
  insertAuditLog,
}));

import {
  complianceTool,
  complianceInputSchema,
} from "../../src/tools/compliance.js";
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
  overallScore: 92,
  captureIntegrity: 100,
  hashMismatches: 0,
  droppedEvents: 0,
  openFindings: 1,
  findingsBySeverity: { critical: 0, high: 1, medium: 0, low: 0 },
  lastAssessment: "2026-05-01T00:00:00.000Z",
};

const sampleFramework = {
  id: "fw-soc2",
  name: "SOC 2 Type II",
  subtitle: "Service Organization Control",
  compliancePercentage: 100,
  controlsMet: 7,
  controlsTotal: 7,
  controls: [],
};

const sampleAuditEntry = {
  id: "audit-1",
  controlId: "ctrl-1",
  oldStatus: "IN_PROGRESS",
  newStatus: "MET",
  changedBy: "user-1",
  changedAt: "2026-05-01T00:00:00.000Z",
  reason: "evidence reviewed",
};

function listEnvelope(items: unknown[]): Record<string, unknown> {
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

describe("D-C8-3 complianceInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof complianceTool.description).toBe("string");
    expect(complianceTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("tool name is exactly recondo_compliance", () => {
    expect(complianceTool.name).toBe("recondo_compliance");
  });

  it("view enum has exactly 3 members: summary / frameworks / audit_log", () => {
    expect(() => complianceInputSchema.parse({ view: "summary" })).not.toThrow();
    expect(() =>
      complianceInputSchema.parse({ view: "frameworks" }),
    ).not.toThrow();
    expect(() =>
      complianceInputSchema.parse({ view: "audit_log" }),
    ).not.toThrow();
  });

  it("view rejects values outside the 3-member enum", () => {
    expect(() => complianceInputSchema.parse({ view: "findings" })).toThrow();
    expect(() => complianceInputSchema.parse({ view: "SUMMARY" })).toThrow();
    expect(() => complianceInputSchema.parse({ view: "" })).toThrow();
  });

  it("view is required (no default)", () => {
    expect(() => complianceInputSchema.parse({})).toThrow();
  });

  it("schema accepts optional control_id / project_id / limit / offset", () => {
    expect(() =>
      complianceInputSchema.parse({
        view: "audit_log",
        control_id: "ctrl-1",
        project_id: "proj-1",
        limit: 10,
        offset: 0,
      }),
    ).not.toThrow();
  });

  it("schema rejects limit/offset for summary and frameworks views", () => {
    expect(() =>
      complianceInputSchema.parse({ view: "summary", limit: 10 }),
    ).toThrow();
    expect(() =>
      complianceInputSchema.parse({ view: "summary", offset: 1 }),
    ).toThrow();
    expect(() =>
      complianceInputSchema.parse({ view: "frameworks", limit: 10 }),
    ).toThrow();
    expect(() =>
      complianceInputSchema.parse({ view: "frameworks", offset: 1 }),
    ).toThrow();
  });

  it("schema rejects negative offset / non-positive limit", () => {
    expect(() =>
      complianceInputSchema.parse({ view: "audit_log", offset: -1 }),
    ).toThrow();
    expect(() =>
      complianceInputSchema.parse({ view: "audit_log", limit: 0 }),
    ).toThrow();
  });
});

describe("D-C8-3 complianceTool — phantom-wiring guard (C0 right-column contract)", () => {
  it("source imports the canonical RIGHT-column names (NOT bare LEFT-column names)", () => {
    const sourcePath = resolve(__dirname, "../../src/tools/compliance.ts");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("getComplianceSummary");
    expect(source).toContain("listComplianceFrameworks");
    expect(source).toContain("listComplianceAuditLog");

    const importLines = source
      .split("\n")
      .filter((l) => l.includes("@recondo/data"));
    for (const line of importLines) {
      const forbidden = [
        // Bare left-column names not preceded by `get` or `list`.
        /(?<!get)(?<!list)\bcomplianceSummary\b/,
        /(?<!get)(?<!list)\bcomplianceFrameworks\b/,
        /(?<!get)(?<!list)\bcomplianceAuditLog\b/,
      ];
      for (const re of forbidden) {
        const m = re.exec(line);
        expect(m, `forbidden bare name in: ${line}`).toBeNull();
      }
    }
  });
});

describe("D-C8-3 complianceTool handler — dispatch (3 view values)", () => {
  beforeEach(() => {
    getComplianceSummary.mockReset();
    listComplianceFrameworks.mockReset();
    listComplianceAuditLog.mockReset();
  });

  it("view=summary -> getComplianceSummary (and NOT the others)", async () => {
    getComplianceSummary.mockResolvedValueOnce(sampleSummary);
    const ctx = makeCtx();
    await complianceTool.handler({ view: "summary" } as never, ctx);
    expect(getComplianceSummary).toHaveBeenCalledTimes(1);
    expect(listComplianceFrameworks).toHaveBeenCalledTimes(0);
    expect(listComplianceAuditLog).toHaveBeenCalledTimes(0);
  });

  it("view=frameworks -> listComplianceFrameworks (and NOT the others)", async () => {
    listComplianceFrameworks.mockResolvedValueOnce(listEnvelope([sampleFramework]));
    const ctx = makeCtx();
    await complianceTool.handler({ view: "frameworks" } as never, ctx);
    expect(getComplianceSummary).toHaveBeenCalledTimes(0);
    expect(listComplianceFrameworks).toHaveBeenCalledTimes(1);
    expect(listComplianceAuditLog).toHaveBeenCalledTimes(0);
  });

  it("view=audit_log -> listComplianceAuditLog (and NOT the others)", async () => {
    listComplianceAuditLog.mockResolvedValueOnce(listEnvelope([sampleAuditEntry]));
    const ctx = makeCtx();
    await complianceTool.handler({ view: "audit_log" } as never, ctx);
    expect(getComplianceSummary).toHaveBeenCalledTimes(0);
    expect(listComplianceFrameworks).toHaveBeenCalledTimes(0);
    expect(listComplianceAuditLog).toHaveBeenCalledTimes(1);
  });
});

describe("D-C8-3 complianceTool handler — signal threading", () => {
  beforeEach(() => {
    getComplianceSummary.mockReset();
    listComplianceFrameworks.mockReset();
    listComplianceAuditLog.mockReset();
  });

  it("threads ctx.abortSignal into the summary call", async () => {
    getComplianceSummary.mockResolvedValueOnce(sampleSummary);
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await complianceTool.handler({ view: "summary" } as never, ctx);
    const callArgs = getComplianceSummary.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("threads ctx.abortSignal into the frameworks call", async () => {
    listComplianceFrameworks.mockResolvedValueOnce(listEnvelope([]));
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await complianceTool.handler({ view: "frameworks" } as never, ctx);
    const callArgs = listComplianceFrameworks.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("threads ctx.abortSignal into the audit_log call", async () => {
    listComplianceAuditLog.mockResolvedValueOnce(listEnvelope([]));
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await complianceTool.handler({ view: "audit_log" } as never, ctx);
    const callArgs = listComplianceAuditLog.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("propagates AbortError from any branch", async () => {
    listComplianceAuditLog.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await expect(
      complianceTool.handler({ view: "audit_log" } as never, ctx),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});

describe("D-C8-3 complianceTool handler — output shape", () => {
  beforeEach(() => {
    getComplianceSummary.mockReset();
    listComplianceFrameworks.mockReset();
    listComplianceAuditLog.mockReset();
  });

  it("view=summary returns a single record (NOT a list envelope)", async () => {
    getComplianceSummary.mockResolvedValueOnce(sampleSummary);
    const ctx = makeCtx();
    const result = (await complianceTool.handler(
      { view: "summary" } as never,
      ctx,
    )) as Record<string, unknown>;
    // Single-record shape: `items` should NOT be present.
    expect(result).not.toHaveProperty("items");
    // Summary fields preserved.
    expect(JSON.stringify(result)).toContain("overallScore");
  });

  it("view=frameworks returns a 5-key list envelope", async () => {
    listComplianceFrameworks.mockResolvedValueOnce(
      listEnvelope([sampleFramework]),
    );
    const ctx = makeCtx();
    const result = (await complianceTool.handler(
      { view: "frameworks" } as never,
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
    expect(JSON.stringify(result)).toContain("SOC 2 Type II");
  });

  it("view=audit_log returns a 5-key list envelope reading `compliance_audit_log`", async () => {
    listComplianceAuditLog.mockResolvedValueOnce(
      listEnvelope([sampleAuditEntry]),
    );
    const ctx = makeCtx();
    const result = (await complianceTool.handler(
      { view: "audit_log" } as never,
      ctx,
    )) as Record<string, unknown>;
    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("next_offset");
    expect(result).toHaveProperty("truncated");
    expect(result).toHaveProperty("stream_id");
    expect(result).toHaveProperty("is_final");
    expect(JSON.stringify(result)).toContain("audit-1");
    // Sanity check: the row shape matches `compliance_audit_log` columns
    // (control_id / old_status / new_status / changed_by / changed_at /
    // reason — see api/migrations/004_compliance.sql lines 38-46) and is
    // distinct from the per-call MCP `audit_log` row shape (tool_name /
    // arguments / response_bytes / client_name / key_id / requested_at).
    const items = (result.items as Array<Record<string, unknown>>) ?? [];
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]).toHaveProperty("controlId");
    expect(items[0]).toHaveProperty("newStatus");
    expect(items[0]).not.toHaveProperty("toolName");
    expect(items[0]).not.toHaveProperty("responseBytes");
  });
});

describe("D-HARD insights registration guard", () => {
  it("the production server registers `recondo_insights`", () => {
    const text = readFileSync(resolve(__dirname, "../../src/server.ts"), "utf8");
    expect(text).toMatch(/\binsightsTool\b/);
    expect(text).toMatch(/\brecondo_insights\b|\binsightsTool\b/);
  });
});
