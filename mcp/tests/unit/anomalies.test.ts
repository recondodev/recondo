/**
 * D-C8-2 (unit) — `recondo_anomalies` tool: schema + handler.
 *
 * Contract pinned by C0 audit + Plan D §C8:
 *   - Tool name: `recondo_anomalies`.
 *   - Description >= 50 chars.
 *   - Input shape (data-layer signature: `listAnomalies(apiKey, filter, options)`,
 *     where `filter` is `AnomaliesFilter` and `options` is `ListOptions`):
 *       severity?:     string
 *       session_id?:   string
 *       anomaly_type?: string
 *       since?:        string  (opaque cursor OR raw ISO 8601)
 *       project_id?:   string
 *       limit?:        integer (>=1, data-layer clamps to 1000)
 *       offset?:       integer (>=0)
 *   - Handler: calls `listAnomalies` exactly once and returns the
 *     canonical 5-key list envelope shape.
 *   - `ctx.abortSignal` MUST be threaded into options.signal.
 *
 * Phantom-wiring guard (C0 contract):
 *   - The production source MUST import the RIGHT-column name
 *     `listAnomalies` from `@recondo/data`. The bare LEFT-column name
 *     `anomalies` MUST NOT appear in `@recondo/data` import lines.
 *     Substrings like `recondo_anomalies` (tool name) or `anomaliesTool`
 *     (variable name) are fine — only the bare data-layer import name
 *     in import contexts is forbidden.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { listAnomalies, getPool, closePool, insertAuditLog } = vi.hoisted(
  () => ({
    listAnomalies: vi.fn(),
    getPool: vi.fn(),
    closePool: vi.fn(),
    insertAuditLog: vi.fn(),
  }),
);

vi.mock("@recondo/data", () => ({
  listAnomalies,
  getPool,
  closePool,
  insertAuditLog,
}));

import { anomaliesTool, anomaliesInputSchema } from "../../src/tools/anomalies.js";
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

const sampleAnomaly = {
  id: "anom-1",
  sessionId: "sess-1",
  turnId: "turn-1",
  anomalyType: "rate_limit",
  severity: "high",
  description: "rate limit exceeded",
  detectedAt: "2026-05-01T00:00:00.000Z",
  metadata: null,
};

function envelopeWith(items: unknown[]): Record<string, unknown> {
  return {
    items: items as never,
    next_offset: null,
    truncated: false,
    stream_id: null,
    is_final: true,
  };
}

describe("D-C8-2 anomaliesInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof anomaliesTool.description).toBe("string");
    expect(anomaliesTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("tool name is exactly recondo_anomalies", () => {
    expect(anomaliesTool.name).toBe("recondo_anomalies");
  });

  it("schema accepts an empty object (all fields optional)", () => {
    expect(() => anomaliesInputSchema.parse({})).not.toThrow();
  });

  it("schema accepts the documented optional fields", () => {
    expect(() =>
      anomaliesInputSchema.parse({
        severity: "high",
        session_id: "sess-1",
        anomaly_type: "rate_limit",
        since: "2026-05-01T00:00:00.000Z",
        project_id: "proj-1",
        limit: 10,
        offset: 0,
      }),
    ).not.toThrow();
  });

  it("schema rejects negative offset / non-positive limit", () => {
    expect(() => anomaliesInputSchema.parse({ offset: -1 })).toThrow();
    expect(() => anomaliesInputSchema.parse({ limit: 0 })).toThrow();
  });
});

describe("D-C8-2 anomaliesTool — phantom-wiring guard (C0 right-column contract)", () => {
  it("source imports `listAnomalies` (NOT bare `anomalies`)", () => {
    const sourcePath = resolve(__dirname, "../../src/tools/anomalies.ts");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("listAnomalies");

    const importLines = source
      .split("\n")
      .filter((l) => l.includes("@recondo/data"));
    for (const line of importLines) {
      // Bare `anomalies` (the LEFT-column resolver name) on the
      // `@recondo/data` import line is forbidden. Substrings inside
      // longer identifiers (e.g. `listAnomalies`) are fine — the
      // word-boundary regex skips those.
      const m = /(?<!list)\banomalies\b/.exec(line);
      expect(
        m,
        `forbidden bare \`anomalies\` in import line: ${line}`,
      ).toBeNull();
    }
  });
});

describe("D-C8-2 anomaliesTool handler — call wiring", () => {
  beforeEach(() => {
    listAnomalies.mockReset();
  });

  it("calls listAnomalies exactly once", async () => {
    listAnomalies.mockResolvedValueOnce(envelopeWith([sampleAnomaly]));
    const ctx = makeCtx();
    await anomaliesTool.handler({} as never, ctx);
    expect(listAnomalies).toHaveBeenCalledTimes(1);
  });

  it("threads ctx.abortSignal into options.signal of the call", async () => {
    listAnomalies.mockResolvedValueOnce(envelopeWith([]));
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await anomaliesTool.handler({} as never, ctx);
    const callArgs = listAnomalies.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("project_id overrides auth.projectId on the apiKey bag", async () => {
    listAnomalies.mockResolvedValueOnce(envelopeWith([]));
    const ctx = makeCtx({
      auth: {
        kind: "dev-bypass",
        isAdmin: true,
        projectId: "auth-project",
        keyId: "dev-bypass",
      },
    });
    await anomaliesTool.handler(
      { project_id: "override-project" } as never,
      ctx,
    );
    const callArgs = listAnomalies.mock.calls[0];
    const apiKey = callArgs[0] as { projectId: string | null };
    expect(apiKey.projectId).toBe("override-project");
  });

  it("propagates AbortError when the call rejects", async () => {
    listAnomalies.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await expect(anomaliesTool.handler({} as never, ctx)).rejects.toThrow();
  });
});

describe("D-C8-2 anomaliesTool handler — output envelope", () => {
  beforeEach(() => {
    listAnomalies.mockReset();
  });

  it("returns the canonical 5-key list envelope shape", async () => {
    listAnomalies.mockResolvedValueOnce(envelopeWith([sampleAnomaly]));
    const ctx = makeCtx();
    const result = (await anomaliesTool.handler(
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
    expect(JSON.stringify(result)).toContain("anom-1");
  });
});
