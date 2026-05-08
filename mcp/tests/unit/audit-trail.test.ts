/**
 * D-C8-1 (unit) — `recondo_audit_trail` tool: schema + handler.
 *
 * Contract pinned by C0 audit + Plan D §C8:
 *   - Tool name: `recondo_audit_trail`.
 *   - Description >= 50 chars.
 *   - Input shape (data-layer signature: `listAuditEvents(apiKey, filter, options)`,
 *     where `filter` is `AuditEventsFilter` and `options` is `ListOptions & { offset? }`):
 *       since?:  string  (opaque cursor OR raw ISO 8601)
 *       search?: string
 *       type?:   string  ("ALL" | "REQUESTS" | "RESPONSES" | "ANOMALIES")
 *       period?: enum    (day / week / month / quarter — translated at boundary)
 *       from?:   string
 *       to?:     string
 *       project_id?: string
 *       limit?:  integer (>=1, data-layer clamps to 500)
 *       offset?: integer (>=0)
 *   - Handler: calls `listAuditEvents(apiKey, filter, options)` exactly once
 *     and returns the data-layer envelope (canonical 5-key list shape +
 *     possibly extra `total/limit/offset` keys).
 *   - `ctx.abortSignal` MUST be threaded into options.signal.
 *
 * Phantom-wiring guard (C0 contract):
 *   - The production source MUST import the RIGHT-column name
 *     `listAuditEvents` and MUST NOT contain the bare LEFT-column name
 *     `auditTrail` from `@recondo/data` import lines.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const {
  listAuditEvents,
  getPool,
  closePool,
  insertAuditLog,
} = vi.hoisted(() => ({
  listAuditEvents: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("@recondo/data", () => ({
  listAuditEvents,
  getPool,
  closePool,
  insertAuditLog,
}));

import { auditTrailTool, auditTrailInputSchema } from "../../src/tools/audit-trail.js";
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

const sampleEntry = {
  timestamp: "2026-05-01T00:00:00.000Z",
  sessionId: "sess-1",
  sequenceNum: 1,
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  requestHash: "req-hash-1",
  responseHash: "resp-hash-1",
  totalTokens: 150,
  integrityStatus: "verified",
  httpStatus: 200,
  captureComplete: true,
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

describe("D-C8-1 auditTrailInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof auditTrailTool.description).toBe("string");
    expect(auditTrailTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("tool name is exactly recondo_audit_trail", () => {
    expect(auditTrailTool.name).toBe("recondo_audit_trail");
  });

  it("schema accepts an empty object (all fields optional)", () => {
    expect(() => auditTrailInputSchema.parse({})).not.toThrow();
  });

  it("schema accepts the documented optional fields", () => {
    expect(() =>
      auditTrailInputSchema.parse({
        since: "2026-05-01T00:00:00.000Z",
        search: "claude",
        type: "ANOMALIES",
        period: "week",
        from: "2026-05-01T00:00:00.000Z",
        to: "2026-05-07T00:00:00.000Z",
        project_id: "proj-1",
        limit: 10,
        offset: 0,
      }),
    ).not.toThrow();
  });

  it("schema rejects negative offset / non-positive limit", () => {
    expect(() => auditTrailInputSchema.parse({ offset: -1 })).toThrow();
    expect(() => auditTrailInputSchema.parse({ limit: 0 })).toThrow();
  });
});

describe("D-C8-1 auditTrailTool — phantom-wiring guard (C0 right-column contract)", () => {
  it("source imports `listAuditEvents` (NOT bare `auditTrail`)", () => {
    const sourcePath = resolve(__dirname, "../../src/tools/audit-trail.ts");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("listAuditEvents");

    const importLines = source
      .split("\n")
      .filter((l) => l.includes("@recondo/data"));
    for (const line of importLines) {
      // Bare `auditTrail` (the LEFT-column resolver name) is forbidden in
      // import lines from `@recondo/data`.
      const m = /\bauditTrail\b/.exec(line);
      expect(m, `forbidden bare \`auditTrail\` in import line: ${line}`).toBeNull();
    }
  });
});

describe("D-C8-1 auditTrailTool handler — call wiring", () => {
  beforeEach(() => {
    listAuditEvents.mockReset();
  });

  it("calls listAuditEvents exactly once", async () => {
    listAuditEvents.mockResolvedValueOnce(envelopeWith([sampleEntry]));
    const ctx = makeCtx();
    await auditTrailTool.handler({} as never, ctx);
    expect(listAuditEvents).toHaveBeenCalledTimes(1);
  });

  it("threads ctx.abortSignal into options.signal of the call", async () => {
    listAuditEvents.mockResolvedValueOnce(envelopeWith([]));
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await auditTrailTool.handler({} as never, ctx);
    const callArgs = listAuditEvents.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("project_id overrides auth.projectId on the apiKey bag", async () => {
    listAuditEvents.mockResolvedValueOnce(envelopeWith([]));
    const ctx = makeCtx({
      auth: {
        kind: "dev-bypass",
        isAdmin: true,
        projectId: "auth-project",
        keyId: "dev-bypass",
      },
    });
    await auditTrailTool.handler(
      { project_id: "override-project" } as never,
      ctx,
    );
    const callArgs = listAuditEvents.mock.calls[0];
    const apiKey = callArgs[0] as { projectId: string | null };
    expect(apiKey.projectId).toBe("override-project");
  });

  it("translates human-readable period before forwarding to the data layer", async () => {
    listAuditEvents.mockResolvedValueOnce(envelopeWith([]));
    const ctx = makeCtx();
    await auditTrailTool.handler({ period: "week" } as never, ctx);
    const [, filter] = listAuditEvents.mock.calls[0];
    expect((filter as { period?: string }).period).toBe("DAY_7");
  });

  it("propagates AbortError when the call rejects", async () => {
    listAuditEvents.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await expect(auditTrailTool.handler({} as never, ctx)).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});

describe("D-C8-1 auditTrailTool handler — output envelope", () => {
  beforeEach(() => {
    listAuditEvents.mockReset();
  });

  it("returns the canonical 5-key list envelope shape", async () => {
    listAuditEvents.mockResolvedValueOnce(envelopeWith([sampleEntry]));
    const ctx = makeCtx();
    const result = (await auditTrailTool.handler(
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
    expect(JSON.stringify(result)).toContain("sess-1");
  });
});
