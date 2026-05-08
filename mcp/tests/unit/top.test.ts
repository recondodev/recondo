/**
 * D-C7-3 (unit) — `recondo_top` tool: schema + handler dispatch.
 *
 * Contract pinned by C0 audit + Plan D §C7:
 *   - Tool name: `recondo_top`.
 *   - Description >= 50 chars.
 *   - Input shape:
 *       dimension: z.enum(["developer", "repository"])  (REQUIRED).
 *       period?: enum (human-readable; translated to DAY_<n> at boundary).
 *       project_id?: string  (overrides auth.projectId).
 *       limit?:  integer (1..200; data-layer clamps).
 *       offset?: integer (>=0; data-layer clamps).
 *   - Handler dispatches on `dimension`:
 *       "developer"  -> listTopDevelopers(apiKey, args, options)
 *       "repository" -> listTopRepositories(apiKey, args, options)
 *     A WRONG dispatch is the classic phantom-wiring red flag — the
 *     dispatch tests below use `toHaveBeenCalledTimes(1)` for the
 *     intended branch and `toHaveBeenCalledTimes(0)` for the other.
 *   - Each underlying call returns the data-layer paginated envelope
 *     `ListEnvelope<…> & { total, limit, offset }`. The handler returns
 *     the canonical 5-key list envelope shape (extra keys MAY pass
 *     through; the shape test asserts the 5 canonical ones are present).
 *   - `ctx.abortSignal` MUST be threaded into the dispatched call.
 *
 * Phantom-wiring guard (C0 contract):
 *   - The production source MUST import the RIGHT-column names
 *     `listTopDevelopers` + `listTopRepositories` and MUST NOT contain
 *     the bare LEFT-column names `topDevelopers` or `topRepositories`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const {
  getAgentSummary,
  listAgentFrameworkDistribution,
  listTopDevelopers,
  listTopRepositories,
  toolCallStats,
  getPool,
  closePool,
  insertAuditLog,
} = vi.hoisted(() => ({
  getAgentSummary: vi.fn(),
  listAgentFrameworkDistribution: vi.fn(),
  listTopDevelopers: vi.fn(),
  listTopRepositories: vi.fn(),
  toolCallStats: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("@recondo/data", () => ({
  getAgentSummary,
  listAgentFrameworkDistribution,
  listTopDevelopers,
  listTopRepositories,
  toolCallStats,
  getPool,
  closePool,
  insertAuditLog,
}));

import { topTool, topInputSchema } from "../../src/tools/top.js";
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

const sampleDeveloper = {
  accountUuid: "uuid-1",
  sessionCount: 4,
  totalTokens: 12000,
  totalCostUsd: 1.23,
  favoriteModel: "claude-sonnet-4-20250514",
  lastActive: "2026-05-01T00:00:00.000Z",
};

const sampleRepository = {
  repository: "github.com/example/repo",
  sessionCount: 3,
  branchCount: 2,
  totalCostUsd: 4.56,
  primaryFramework: "claude-code",
};

function envelopeWith(items: unknown[]): Record<string, unknown> {
  return {
    items: items as never,
    next_offset: null,
    truncated: false,
    stream_id: null,
    is_final: true,
    total: items.length,
    limit: 20,
    offset: 0,
  };
}

describe("D-C7-3 topInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof topTool.description).toBe("string");
    expect(topTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("tool name is exactly recondo_top", () => {
    expect(topTool.name).toBe("recondo_top");
  });

  it("dimension enum has exactly 2 members: developer / repository", () => {
    expect(() =>
      topInputSchema.parse({ dimension: "developer" }),
    ).not.toThrow();
    expect(() =>
      topInputSchema.parse({ dimension: "repository" }),
    ).not.toThrow();
  });

  it("dimension rejects values outside the 2-member enum", () => {
    expect(() => topInputSchema.parse({ dimension: "framework" })).toThrow();
    expect(() => topInputSchema.parse({ dimension: "DEVELOPER" })).toThrow();
    expect(() => topInputSchema.parse({ dimension: "" })).toThrow();
  });

  it("dimension is required (no default)", () => {
    expect(() => topInputSchema.parse({})).toThrow();
  });

  it("optional period accepts at minimum 'day' / 'week' / 'month'", () => {
    expect(() =>
      topInputSchema.parse({ dimension: "developer", period: "day" }),
    ).not.toThrow();
    expect(() =>
      topInputSchema.parse({ dimension: "developer", period: "week" }),
    ).not.toThrow();
    expect(() =>
      topInputSchema.parse({ dimension: "developer", period: "month" }),
    ).not.toThrow();
  });

  it("schema accepts optional project_id / limit / offset", () => {
    const parsed = topInputSchema.parse({
      dimension: "developer",
      project_id: "proj-1",
      limit: 10,
      offset: 5,
    }) as { project_id?: string; limit?: number; offset?: number };
    expect(parsed.project_id).toBe("proj-1");
    expect(parsed.limit).toBe(10);
    expect(parsed.offset).toBe(5);
  });

  it("schema rejects negative offset / non-positive limit", () => {
    expect(() =>
      topInputSchema.parse({ dimension: "developer", offset: -1 }),
    ).toThrow();
    expect(() =>
      topInputSchema.parse({ dimension: "developer", limit: 0 }),
    ).toThrow();
  });
});

describe("D-C7-3 topTool — phantom-wiring guard (C0 right-column contract)", () => {
  it("source imports `listTopDevelopers` + `listTopRepositories` (NOT bare LEFT-column names)", () => {
    const sourcePath = resolve(__dirname, "../../src/tools/top.ts");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("listTopDevelopers");
    expect(source).toContain("listTopRepositories");

    const bareDev = /(?<!list)\btopDevelopers\b/.exec(source);
    expect(bareDev, `forbidden bare \`topDevelopers\` in source`).toBeNull();
    const bareRepo = /(?<!list)\btopRepositories\b/.exec(source);
    expect(bareRepo, `forbidden bare \`topRepositories\` in source`).toBeNull();
  });
});

describe("D-C7-3 topTool handler — dispatch (2 dimension values)", () => {
  beforeEach(() => {
    listTopDevelopers.mockReset();
    listTopRepositories.mockReset();
  });

  it("dimension=developer -> listTopDevelopers (and NOT listTopRepositories)", async () => {
    listTopDevelopers.mockResolvedValueOnce(envelopeWith([sampleDeveloper]));
    const ctx = makeCtx();

    await topTool.handler({ dimension: "developer" } as never, ctx);

    expect(listTopDevelopers).toHaveBeenCalledTimes(1);
    expect(listTopRepositories).toHaveBeenCalledTimes(0);
  });

  it("dimension=repository -> listTopRepositories (and NOT listTopDevelopers)", async () => {
    listTopRepositories.mockResolvedValueOnce(envelopeWith([sampleRepository]));
    const ctx = makeCtx();

    await topTool.handler({ dimension: "repository" } as never, ctx);

    expect(listTopDevelopers).toHaveBeenCalledTimes(0);
    expect(listTopRepositories).toHaveBeenCalledTimes(1);
  });
});

describe("D-C7-3 topTool handler — signal threading + project_id override", () => {
  beforeEach(() => {
    listTopDevelopers.mockReset();
    listTopRepositories.mockReset();
  });

  it("threads ctx.abortSignal into options.signal of the dispatched call (developer)", async () => {
    listTopDevelopers.mockResolvedValueOnce(envelopeWith([]));
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await topTool.handler({ dimension: "developer" } as never, ctx);

    const callArgs = listTopDevelopers.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("threads ctx.abortSignal into options.signal of the dispatched call (repository)", async () => {
    listTopRepositories.mockResolvedValueOnce(envelopeWith([]));
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await topTool.handler({ dimension: "repository" } as never, ctx);

    const callArgs = listTopRepositories.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("project_id overrides auth.projectId on the apiKey bag", async () => {
    listTopDevelopers.mockResolvedValueOnce(envelopeWith([]));
    const ctx = makeCtx({
      auth: {
        kind: "dev-bypass",
        isAdmin: true,
        projectId: "auth-project",
        keyId: "dev-bypass",
      },
    });

    await topTool.handler(
      { dimension: "developer", project_id: "override-project" } as never,
      ctx,
    );

    const callArgs = listTopDevelopers.mock.calls[0];
    const apiKey = callArgs[0] as { projectId: string | null };
    expect(apiKey.projectId).toBe("override-project");
  });

  it("propagates AbortError when the dispatched call rejects", async () => {
    listTopRepositories.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await expect(
      topTool.handler({ dimension: "repository" } as never, ctx),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});

describe("D-C7-3 topTool handler — output envelope", () => {
  beforeEach(() => {
    listTopDevelopers.mockReset();
    listTopRepositories.mockReset();
  });

  it("returns the canonical 5-key list envelope shape (developer)", async () => {
    listTopDevelopers.mockResolvedValueOnce(envelopeWith([sampleDeveloper]));
    const ctx = makeCtx();

    const result = (await topTool.handler(
      { dimension: "developer" } as never,
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
    expect(JSON.stringify(result)).toContain("uuid-1");
  });

  it("returns the canonical 5-key list envelope shape (repository)", async () => {
    listTopRepositories.mockResolvedValueOnce(envelopeWith([sampleRepository]));
    const ctx = makeCtx();

    const result = (await topTool.handler(
      { dimension: "repository" } as never,
      ctx,
    )) as Record<string, unknown>;

    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("next_offset");
    expect(result).toHaveProperty("truncated");
    expect(result).toHaveProperty("stream_id");
    expect(result).toHaveProperty("is_final");
    expect(JSON.stringify(result)).toContain("github.com/example/repo");
  });
});
