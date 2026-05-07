/**
 * D-C4-4 / D-C4-5 (unit) — `recondo_verify_integrity` tool: schema +
 * handler with mandatory governance description literals.
 *
 * Contract pinned by Plan D §Task 15 + the C0 audit:
 *   - Tool name: `recondo_verify_integrity`.
 *   - Description MUST contain the literal substrings:
 *       "Expensive"
 *       "only invoke when the user explicitly asks"
 *     Both verbatim. These are governance directives surfaced to the
 *     calling agent; missing either is a phantom-wiring red flag.
 *   - Description >= 50 chars (likely far longer once both literals are
 *     present, but assert independently).
 *   - Input shape: { session_id: string (non-empty) }. The data-layer
 *     `verifyIntegrity(apiKey, sessionId, options)` REQUIRES a session
 *     id; v1 has no whole-dataset sweep.
 *   - Handler delegates to `verifyIntegrity` from `@recondo/data`
 *     (turns.ts), threading `ctx.abortSignal` into `options.signal`.
 *   - Returns the data-layer's `VerifyIntegrityResult` verbatim — this
 *     is metadata about captured content, NOT captured content, so no
 *     `<captured_*>` wrapping is applied.
 *
 * The data-layer module is mocked via `vi.hoisted`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
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
  verifyIntegrityTool,
  verifyIntegrityInputSchema,
} from "../../src/tools/verify-integrity.js";
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

describe("D-C4-4 verifyIntegrityInputSchema + description", () => {
  it("tool name is exactly recondo_verify_integrity", () => {
    expect(verifyIntegrityTool.name).toBe("recondo_verify_integrity");
  });

  it("description is >= 50 characters", () => {
    expect(typeof verifyIntegrityTool.description).toBe("string");
    expect(verifyIntegrityTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it('description contains the literal substring "Expensive"', () => {
    expect(verifyIntegrityTool.description.includes("Expensive")).toBe(true);
  });

  it('description contains the literal substring "only invoke when the user explicitly asks"', () => {
    expect(
      verifyIntegrityTool.description.includes(
        "only invoke when the user explicitly asks",
      ),
    ).toBe(true);
  });

  it("schema requires session_id", () => {
    expect(() => verifyIntegrityInputSchema.parse({})).toThrow();
  });

  it("schema rejects empty session_id", () => {
    expect(() =>
      verifyIntegrityInputSchema.parse({ session_id: "" }),
    ).toThrow();
  });

  it("schema accepts session_id alone", () => {
    const parsed = verifyIntegrityInputSchema.parse({ session_id: "s-1" });
    expect(parsed.session_id).toBe("s-1");
  });
});

describe("D-C4-5 verifyIntegrityTool handler", () => {
  beforeEach(() => {
    verifyIntegrity.mockReset();
  });

  const sampleResult = {
    sessionId: "s-1",
    totalTurns: 3,
    verifiedTurns: 3,
    failedTurns: 0,
    verified: false,
    results: [
      {
        turnId: "t-1",
        sequenceNum: 1,
        reqHashMatch: true,
        respHashMatch: true,
        reqBytesPresent: true,
        respBytesPresent: true,
      },
    ],
  };

  it("threads ctx.abortSignal into verifyIntegrity(..., { signal })", async () => {
    verifyIntegrity.mockResolvedValueOnce(sampleResult);
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await verifyIntegrityTool.handler(
      { session_id: "s-1" } as never,
      ctx,
    );

    expect(verifyIntegrity).toHaveBeenCalledTimes(1);
    const callArgs = verifyIntegrity.mock.calls[0];
    const opts = callArgs[callArgs.length - 1];
    expect(opts).toBeDefined();
    expect(opts.signal).toBe(ac.signal);
  });

  it("forwards session_id positionally to verifyIntegrity(apiKey, sessionId, options)", async () => {
    verifyIntegrity.mockResolvedValueOnce(sampleResult);
    const ctx = makeCtx();

    await verifyIntegrityTool.handler(
      { session_id: "s-42" } as never,
      ctx,
    );

    const [apiKey, sessionId] = verifyIntegrity.mock.calls[0];
    expect(apiKey).toBeDefined();
    expect(typeof apiKey).toBe("object");
    expect(sessionId).toBe("s-42");
  });

  it("returns the data-layer VerifyIntegrityResult verbatim (no captured-* wrapping)", async () => {
    verifyIntegrity.mockResolvedValueOnce(sampleResult);
    const ctx = makeCtx();

    const result = (await verifyIntegrityTool.handler(
      { session_id: "s-1" } as never,
      ctx,
    )) as Record<string, unknown>;

    // Keys preserved verbatim from VerifyIntegrityResult.
    expect(result.sessionId).toBe("s-1");
    expect(result.totalTurns).toBe(3);
    expect(result.verifiedTurns).toBe(3);
    expect(result.failedTurns).toBe(0);
    expect(result.verified).toBe(false);
    expect(Array.isArray(result.results)).toBe(true);
    expect((result.results as unknown[]).length).toBe(1);

    // No captured-message wrapping — verification report is metadata,
    // not captured content.
    const wholeJson = JSON.stringify(result);
    expect(wholeJson).not.toContain("<captured_user_message>");
    expect(wholeJson).not.toContain("<captured_assistant_message>");
    expect(wholeJson).not.toContain("<captured_tool_use>");
  });

  it("propagates AbortError when verifyIntegrity throws AbortError", async () => {
    verifyIntegrity.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await expect(
      verifyIntegrityTool.handler({ session_id: "s-1" } as never, ctx),
    ).rejects.toThrow();
  });

  it("returns an empty-shape report when the data layer reports a missing session", async () => {
    const empty = {
      sessionId: "missing",
      totalTurns: 0,
      verifiedTurns: 0,
      failedTurns: 0,
      verified: false,
      results: [],
    };
    verifyIntegrity.mockResolvedValueOnce(empty);
    const ctx = makeCtx();

    const result = (await verifyIntegrityTool.handler(
      { session_id: "missing" } as never,
      ctx,
    )) as Record<string, unknown>;

    expect(result.sessionId).toBe("missing");
    expect(result.totalTurns).toBe(0);
    expect((result.results as unknown[]).length).toBe(0);
  });
});
