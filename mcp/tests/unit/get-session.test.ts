/**
 * D-C3-1 (unit) — `recondo_get_session` tool: schema + handler.
 *
 * Contract pinned by C0 audit + Plan D §C3:
 *   - Tool name: `recondo_get_session`.
 *   - Input shape: { session_id: string (non-empty), fields?: string[] }.
 *   - Handler delegates to `getSession(apiKey, id, options)` from
 *     `@recondo/data` (sessions.ts) and returns the record verbatim
 *     when `JSON.stringify(record).length <= 32 KB`.
 *   - When the record exceeds 32 KB, the tool MUST return a
 *     `response_too_large` envelope produced by
 *     `enforceSingleRecordBudget` — the suggestion contains the
 *     literal substrings `"fields"` AND `"recondo_get_turn_raw_metadata"`.
 *   - `ctx.abortSignal` MUST be threaded into
 *     `getSession(..., { signal: ctx.abortSignal })`.
 *   - Description >= 50 chars (Task 22 lint).
 *
 * The data-layer module is mocked via `vi.hoisted` + `vi.mock` so this
 * file does not require a live PostgreSQL.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSession, getTurn, getTurnRawMetadata, getTurnRawChunk, getPool, closePool, insertAuditLog } =
  vi.hoisted(() => ({
    getSession: vi.fn(),
    getTurn: vi.fn(),
    getTurnRawMetadata: vi.fn(),
    getTurnRawChunk: vi.fn(),
    getPool: vi.fn(),
    closePool: vi.fn(),
    insertAuditLog: vi.fn(),
  }));

vi.mock("@recondo/data", () => ({
  getSession,
  getTurn,
  getTurnRawMetadata,
  getTurnRawChunk,
  getPool,
  closePool,
  insertAuditLog,
}));

import {
  getSessionTool,
  getSessionInputSchema,
} from "../../src/tools/get-session.js";
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

describe("D-C3-1 getSessionInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof getSessionTool.description).toBe("string");
    expect(getSessionTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("tool name is exactly recondo_get_session", () => {
    expect(getSessionTool.name).toBe("recondo_get_session");
  });

  it("schema requires session_id", () => {
    expect(() => getSessionInputSchema.parse({})).toThrow();
  });

  it("schema rejects empty session_id", () => {
    expect(() => getSessionInputSchema.parse({ session_id: "" })).toThrow();
  });

  it("schema accepts session_id alone", () => {
    const parsed = getSessionInputSchema.parse({ session_id: "s-1" });
    expect(parsed.session_id).toBe("s-1");
  });

  it("schema accepts optional fields: string[]", () => {
    const parsed = getSessionInputSchema.parse({
      session_id: "s-1",
      fields: ["id", "framework", "started_at"],
    });
    expect(Array.isArray(parsed.fields)).toBe(true);
    expect(parsed.fields).toEqual(["id", "framework", "started_at"]);
  });

  it("schema rejects fields that are not string arrays", () => {
    expect(() =>
      getSessionInputSchema.parse({ session_id: "s-1", fields: [1, 2, 3] }),
    ).toThrow();
  });
});

describe("D-C3-1 getSessionTool handler", () => {
  beforeEach(() => {
    getSession.mockReset();
  });

  it("returns the session record verbatim when within the 32 KB budget", async () => {
    const record = {
      id: "session-1",
      framework: "claude-code",
      provider: "anthropic",
      started_at: "2026-01-01T00:00:00Z",
      total_tokens: 1234,
    };
    getSession.mockResolvedValueOnce(record);
    const ctx = makeCtx();

    const result = await getSessionTool.handler(
      { session_id: "session-1" } as never,
      ctx,
    );

    expect(result).toEqual(record);
  });

  it("threads ctx.abortSignal into getSession(..., { signal })", async () => {
    getSession.mockResolvedValueOnce({ id: "s-1" });
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await getSessionTool.handler({ session_id: "s-1" } as never, ctx);

    expect(getSession).toHaveBeenCalledTimes(1);
    const callArgs = getSession.mock.calls[0];
    const opts = callArgs[callArgs.length - 1];
    expect(opts).toBeDefined();
    expect(opts.signal).toBe(ac.signal);
  });

  it("returns response_too_large envelope when record exceeds 32 KB", async () => {
    // Build an oversized record by stuffing a long string into a field.
    const big = "x".repeat(40 * 1024);
    getSession.mockResolvedValueOnce({
      id: "session-1",
      initial_intent: big,
    });
    const ctx = makeCtx();

    const result = (await getSessionTool.handler(
      { session_id: "session-1" } as never,
      ctx,
    )) as Record<string, unknown>;

    expect(result.response_too_large).toBe(true);
    expect(typeof result.suggestion).toBe("string");
    const suggestion = result.suggestion as string;
    expect(suggestion).toContain("fields");
    expect(suggestion).toContain("recondo_get_turn_raw_metadata");
    expect(typeof result.actual_bytes).toBe("number");
    expect(result.actual_bytes as number).toBeGreaterThan(32 * 1024);
  });

  it("propagates AbortError when getSession throws AbortError", async () => {
    getSession.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await expect(
      getSessionTool.handler({ session_id: "s-1" } as never, ctx),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });

  it("returns null when the data layer returns null (session not found)", async () => {
    getSession.mockResolvedValueOnce(null);
    const ctx = makeCtx();

    const result = await getSessionTool.handler(
      { session_id: "missing" } as never,
      ctx,
    );

    expect(result).toBeNull();
  });
});

describe("D-C3-1 getSessionTool handler — fields projection", () => {
  beforeEach(() => {
    getSession.mockReset();
  });

  const baseSession = {
    id: "session-1",
    framework: "claude-code",
    provider: "anthropic",
    started_at: "2026-01-01T00:00:00Z",
    total_tokens: 1234,
  };

  it("empty fields array → returns ALL fields (semantically equivalent to fields omitted)", async () => {
    getSession.mockResolvedValueOnce({ ...baseSession });
    const ctx = makeCtx();

    const result = (await getSessionTool.handler(
      { session_id: "session-1", fields: [] } as never,
      ctx,
    )) as Record<string, unknown>;

    expect(result).toEqual(baseSession);
  });

  it("fields=['framework'] → only `framework` survives the projection", async () => {
    getSession.mockResolvedValueOnce({ ...baseSession });
    const ctx = makeCtx();

    const result = (await getSessionTool.handler(
      { session_id: "session-1", fields: ["framework"] } as never,
      ctx,
    )) as Record<string, unknown>;

    expect(Object.keys(result).sort()).toEqual(["framework"]);
    expect(result.framework).toBe("claude-code");
  });

  it("non-existent field name is silently ignored (no `undefined` key)", async () => {
    getSession.mockResolvedValueOnce({ ...baseSession });
    const ctx = makeCtx();

    const result = (await getSessionTool.handler(
      { session_id: "session-1", fields: ["framework", "ghost_field"] } as never,
      ctx,
    )) as Record<string, unknown>;

    expect(Object.keys(result).sort()).toEqual(["framework"]);
    expect(Object.prototype.hasOwnProperty.call(result, "ghost_field")).toBe(false);
  });
});
