/**
 * D-C2-3 (unit) — Zod schema contract for `recondo_list_sessions`.
 *
 * The tool MUST export the input schema as a named export so this
 * unit test can hit it directly (without booting the SDK or the DB):
 *
 *   import { listSessionsInputSchema, listSessionsTool } from "../../src/tools/list-sessions.js";
 *
 * Contract pinned by the orchestration:
 *   - `limit` defaults to 20, max 100, integer >= 1.
 *   - `offset` optional integer >= 0.
 *   - `since` optional opaque string.
 *   - filter pass-throughs to `listSessions`: at minimum `framework`,
 *     `projectId`, `provider`, `model`, `status` (the values
 *     `listSessions(filter)` already understands).
 *   - description length >= 50 chars (Task 22 lint).
 *
 * AbortSignal threading test verifies the handler forwards
 * `ctx.abortSignal` into `listSessions(..., { signal })`. We mock
 * `@recondo/data` via `vi.hoisted` (per the C1 lesson — the SDK
 * import path resolves at module-load).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { listSessions, getPool, closePool, insertAuditLog } = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("@recondo/data", () => ({
  listSessions,
  getPool,
  closePool,
  insertAuditLog,
}));

import {
  listSessionsTool,
  listSessionsInputSchema,
} from "../../src/tools/list-sessions.js";
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

describe("D-C2-3 listSessionsInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof listSessionsTool.description).toBe("string");
    expect(listSessionsTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("tool name is exactly recondo_list_sessions", () => {
    expect(listSessionsTool.name).toBe("recondo_list_sessions");
  });

  it("schema.parse({}) yields the default limit 20", () => {
    const parsed = listSessionsInputSchema.parse({});
    expect(parsed.limit).toBe(20);
  });

  it("schema.parse({limit: 100}) succeeds (cap is inclusive)", () => {
    const parsed = listSessionsInputSchema.parse({ limit: 100 });
    expect(parsed.limit).toBe(100);
  });

  it("schema.parse({limit: 101}) throws ZodError", () => {
    expect(() => listSessionsInputSchema.parse({ limit: 101 })).toThrow();
  });

  it("schema.parse({limit: 0}) throws ZodError", () => {
    expect(() => listSessionsInputSchema.parse({ limit: 0 })).toThrow();
  });

  it("schema.parse({offset: -1}) throws ZodError", () => {
    expect(() => listSessionsInputSchema.parse({ offset: -1 })).toThrow();
  });

  it("schema.parse({since: 'abc'}) succeeds (opaque string)", () => {
    const parsed = listSessionsInputSchema.parse({ since: "abc" });
    expect(parsed.since).toBe("abc");
  });

  it("schema.parse({since: 123}) throws ZodError (must be string)", () => {
    expect(() => listSessionsInputSchema.parse({ since: 123 })).toThrow();
  });

  it("surfaces filter pass-throughs the data layer accepts", () => {
    // Should not throw — these mirror SessionFilter from packages/recondo-data/sessions.ts.
    const parsed = listSessionsInputSchema.parse({
      framework: "claude-code",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      status: "ACTIVE",
      project_id: "00000000-0000-0000-0000-000000000000",
    });
    // The exact camelCase vs snake_case key shape is the implementer's
    // choice (zod can transform); but the parsed object MUST carry the
    // values forward in *some* form so the handler can hand them to
    // listSessions. Assert at least `framework` survives.
    expect(JSON.stringify(parsed)).toContain("claude-code");
  });

  it("rejects status values outside the listSessions enum", () => {
    expect(() => listSessionsInputSchema.parse({ status: "BOGUS" })).toThrow();
  });
});

describe("D-C2-3 listSessionsTool handler — AbortSignal threading", () => {
  beforeEach(() => {
    listSessions.mockReset();
  });

  it("threads ctx.abortSignal into listSessions(..., { signal })", async () => {
    listSessions.mockResolvedValueOnce({
      items: [],
      next_offset: null,
      truncated: false,
      stream_id: null,
      is_final: true,
      total: 0,
    });
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await listSessionsTool.handler({ limit: 5 } as never, ctx);

    expect(listSessions).toHaveBeenCalledTimes(1);
    const callArgs = listSessions.mock.calls[0];
    // Last positional argument is `options` — must include the signal.
    const options = callArgs[callArgs.length - 1];
    expect(options).toBeDefined();
    expect(options.signal).toBe(ac.signal);
  });

  it("propagates AbortError when listSessions throws AbortError", async () => {
    listSessions.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await expect(
      listSessionsTool.handler({ limit: 5 } as never, ctx),
    ).rejects.toThrow();
  });

  it("forwards `since` to listSessions as filter.startedAfter", async () => {
    listSessions.mockResolvedValueOnce({
      items: [],
      next_offset: null,
      truncated: false,
      stream_id: null,
      is_final: true,
      total: 0,
    });
    const ctx = makeCtx();
    await listSessionsTool.handler(
      { limit: 5, since: "2026-01-01T00:00:00Z" } as never,
      ctx,
    );

    expect(listSessions).toHaveBeenCalledTimes(1);
    const callArgs = listSessions.mock.calls[0];
    // listSessions(apiKey, filter, options) — filter is positional[1].
    const filter = callArgs[1];
    expect(filter).toBeDefined();
    expect(filter.startedAfter).toBe("2026-01-01T00:00:00Z");
  });

  it("omits filter.startedAfter when `since` is not supplied", async () => {
    listSessions.mockResolvedValueOnce({
      items: [],
      next_offset: null,
      truncated: false,
      stream_id: null,
      is_final: true,
      total: 0,
    });
    const ctx = makeCtx();
    await listSessionsTool.handler({ limit: 5 } as never, ctx);

    const filter = listSessions.mock.calls[0][1];
    expect(filter.startedAfter).toBeUndefined();
  });

  it("returns the canonical 5-key envelope shape", async () => {
    listSessions.mockResolvedValueOnce({
      items: [{ id: "session-1" }],
      next_offset: null,
      truncated: false,
      stream_id: null,
      is_final: true,
      total: 1,
    });
    const ctx = makeCtx();
    const result = (await listSessionsTool.handler(
      { limit: 5 } as never,
      ctx,
    )) as Record<string, unknown>;
    // The tool returns the envelope (the SDK wrapping into
    // structuredContent / content happens in server.ts's registerTool
    // shim, not in the handler itself).
    const keys = Object.keys(result).sort();
    expect(keys).toContain("items");
    expect(keys).toContain("next_offset");
    expect(keys).toContain("truncated");
    expect(keys).toContain("stream_id");
    expect(keys).toContain("is_final");
    expect(result.is_final).toBe(true);
    expect(result.stream_id).toBeNull();
  });
});
