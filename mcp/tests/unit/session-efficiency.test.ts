/**
 * D-C5-4 (unit) — `recondo_session_efficiency` tool: schema + handler.
 *
 * Contract pinned by C0 audit + Plan D §C5:
 *   - Tool name: `recondo_session_efficiency`.
 *   - Description >= 50 chars.
 *   - Input shape:
 *       session_id: string (non-empty).
 *   - Handler delegates to `sessionEfficiency(sessionId, options)` from
 *     `@recondo/data` (session-efficiency.ts). The data-layer signature
 *     does NOT take an `apiKey` first arg — confirmed against
 *     `packages/recondo-data/src/session-efficiency.ts:224`.
 *   - The data-layer return is a single structured `SessionEfficiency`
 *     object. The handler MUST return that shape verbatim (no list
 *     envelope wrapping). Subject to the 32 KB single-record budget.
 *   - The result shape is metadata about the session (rates, percentiles,
 *     counts) — NOT captured user/assistant content. NO `<captured_*>`
 *     wrapping is applied.
 *   - `ctx.abortSignal` MUST be threaded into the data-layer options.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  compareTurns,
  findSimilarPrompts,
  relatedTurns,
  sessionEfficiency,
  getSession,
  getTurn,
  searchTurns,
  verifyIntegrity,
  getTurnRawMetadata,
  getTurnRawChunk,
  listSessions,
  getPool,
  closePool,
  insertAuditLog,
} = vi.hoisted(() => ({
  compareTurns: vi.fn(),
  findSimilarPrompts: vi.fn(),
  relatedTurns: vi.fn(),
  sessionEfficiency: vi.fn(),
  getSession: vi.fn(),
  getTurn: vi.fn(),
  searchTurns: vi.fn(),
  verifyIntegrity: vi.fn(),
  getTurnRawMetadata: vi.fn(),
  getTurnRawChunk: vi.fn(),
  listSessions: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("@recondo/data", () => ({
  compareTurns,
  findSimilarPrompts,
  relatedTurns,
  sessionEfficiency,
  getSession,
  getTurn,
  searchTurns,
  verifyIntegrity,
  getTurnRawMetadata,
  getTurnRawChunk,
  listSessions,
  getPool,
  closePool,
  insertAuditLog,
}));

import {
  sessionEfficiencyTool,
  sessionEfficiencyInputSchema,
} from "../../src/tools/session-efficiency.js";
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

const sampleEfficiency = {
  session_id: "session-1",
  cache_hit_rate: 0.5,
  prompt_token_reuse_ratio: 0.25,
  tokens_per_turn: { p50: 100, p99: 500, mean: 200 },
  redundant_tool_call_count: 0,
  ttft_ms: { p50: 200, p99: 1000, mean: 350 },
};

describe("D-C5-4 sessionEfficiencyInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof sessionEfficiencyTool.description).toBe("string");
    expect(sessionEfficiencyTool.description.length).toBeGreaterThanOrEqual(
      50,
    );
  });

  it("tool name is exactly recondo_session_efficiency", () => {
    expect(sessionEfficiencyTool.name).toBe("recondo_session_efficiency");
  });

  it("schema rejects missing session_id", () => {
    expect(() => sessionEfficiencyInputSchema.parse({})).toThrow();
  });

  it("schema rejects empty session_id", () => {
    expect(() =>
      sessionEfficiencyInputSchema.parse({ session_id: "" }),
    ).toThrow();
  });

  it("schema accepts non-empty session_id", () => {
    const parsed = sessionEfficiencyInputSchema.parse({
      session_id: "session-1",
    });
    expect(parsed.session_id).toBe("session-1");
  });
});

describe("D-C5-4 sessionEfficiencyTool handler — signature + signal threading", () => {
  beforeEach(() => {
    sessionEfficiency.mockReset();
  });

  it("calls sessionEfficiency(sessionId, options) — no apiKey first arg", async () => {
    sessionEfficiency.mockResolvedValueOnce(sampleEfficiency);
    const ctx = makeCtx();

    await sessionEfficiencyTool.handler(
      { session_id: "session-1" } as never,
      ctx,
    );

    expect(sessionEfficiency).toHaveBeenCalledTimes(1);
    const callArgs = sessionEfficiency.mock.calls[0];
    expect(callArgs[0]).toBe("session-1");
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts).toBeDefined();
  });

  it("threads ctx.abortSignal into sessionEfficiency options.signal", async () => {
    sessionEfficiency.mockResolvedValueOnce(sampleEfficiency);
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await sessionEfficiencyTool.handler(
      { session_id: "session-1" } as never,
      ctx,
    );

    const callArgs = sessionEfficiency.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("propagates AbortError when sessionEfficiency rejects with AbortError", async () => {
    sessionEfficiency.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await expect(
      sessionEfficiencyTool.handler(
        { session_id: "session-1" } as never,
        ctx,
      ),
    ).rejects.toThrow();
  });
});

describe("D-C5-4 sessionEfficiencyTool handler — output shape", () => {
  beforeEach(() => {
    sessionEfficiency.mockReset();
  });

  it("returns the structured efficiency record verbatim (NOT a list envelope)", async () => {
    sessionEfficiency.mockResolvedValueOnce(sampleEfficiency);
    const ctx = makeCtx();

    const result = (await sessionEfficiencyTool.handler(
      { session_id: "session-1" } as never,
      ctx,
    )) as Record<string, unknown>;

    expect(result).not.toHaveProperty("items");
    expect(result).not.toHaveProperty("stream_id");
    expect(result).not.toHaveProperty("is_final");

    expect(result.session_id).toBe("session-1");
    expect(result.cache_hit_rate).toBe(0.5);
    expect(result.prompt_token_reuse_ratio).toBe(0.25);
    expect(result.redundant_tool_call_count).toBe(0);
    expect(result.tokens_per_turn).toEqual({ p50: 100, p99: 500, mean: 200 });
    expect(result.ttft_ms).toEqual({ p50: 200, p99: 1000, mean: 350 });
  });

  it("does NOT wrap the metadata fields in <captured_*> envelopes", async () => {
    sessionEfficiency.mockResolvedValueOnce(sampleEfficiency);
    const ctx = makeCtx();

    const result = (await sessionEfficiencyTool.handler(
      { session_id: "session-1" } as never,
      ctx,
    )) as Record<string, unknown>;

    const wholeJson = JSON.stringify(result);
    expect(wholeJson).not.toContain("<captured_user_message>");
    expect(wholeJson).not.toContain("<captured_assistant_message>");
    expect(wholeJson).not.toContain("<captured_tool_use>");
  });

  it("oversize record surfaces response_too_large envelope (32 KB budget)", async () => {
    // Pad the record with a large field to blow past 32 KB. The
    // single-record budget surfaces a `response_too_large` envelope.
    const padded = {
      ...sampleEfficiency,
      // Synthetic large field — the tool's budget check operates on the
      // serialised record so any oversized payload triggers truncation.
      __padding: "x".repeat(40 * 1024),
    };
    sessionEfficiency.mockResolvedValueOnce(padded);
    const ctx = makeCtx();

    const result = (await sessionEfficiencyTool.handler(
      { session_id: "session-1" } as never,
      ctx,
    )) as Record<string, unknown>;

    expect(result.response_too_large).toBe(true);
    expect(typeof result.actual_bytes).toBe("number");
    expect(result.actual_bytes as number).toBeGreaterThan(32 * 1024);
  });
});

describe("D-C5-4 sessionEfficiencyTool — pre-aborted signal", () => {
  beforeEach(() => {
    sessionEfficiency.mockReset();
  });

  it("rejects with AbortError when ctx.abortSignal is pre-aborted", async () => {
    sessionEfficiency.mockImplementation(
      (_sessionId: unknown, opts?: { signal?: AbortSignal }) => {
        if (opts?.signal?.aborted) {
          return Promise.reject(new DOMException("aborted", "AbortError"));
        }
        return Promise.resolve(sampleEfficiency);
      },
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await expect(
      sessionEfficiencyTool.handler(
        { session_id: "session-1" } as never,
        ctx,
      ),
    ).rejects.toThrow();
  });
});
