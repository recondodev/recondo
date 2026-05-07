/**
 * D-C3-2 (unit) — `recondo_get_turn` tool: schema + handler with
 *                  captured-message wrapping.
 *
 * Contract pinned by C0 audit + Plan D §C3:
 *   - Tool name: `recondo_get_turn`.
 *   - Input shape: { turn_id: string (non-empty), fields?: string[] }.
 *   - Handler delegates to `getTurn(apiKey, id, options)` from
 *     `@recondo/data` (turns.ts) and returns the turn record with
 *     `user_request_text` / `response_text` REPLACED IN PLACE by the
 *     `MessageEnvelope` produced by `buildMessageEnvelope` —
 *     `<captured_user_message>...</captured_user_message>` for the
 *     user side, `<captured_assistant_message>...` for the assistant
 *     side. Other fields (model, cost_usd, tokens, etc.) pass through.
 *   - Adversarial payloads containing literal closing tags MUST be
 *     escaped (exactly one legitimate closing tag survives).
 *   - When the wrapped record exceeds 32 KB, the tool MUST return a
 *     `response_too_large` envelope whose suggestion mentions
 *     `recondo_get_turn_raw_metadata`.
 *   - `ctx.abortSignal` MUST be threaded into
 *     `getTurn(..., { signal: ctx.abortSignal })`.
 *   - Description >= 50 chars.
 *
 * The data-layer module is mocked via `vi.hoisted`.
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
  getTurnTool,
  getTurnInputSchema,
} from "../../src/tools/get-turn.js";
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

const baseTurn = {
  id: "turn-1",
  sessionId: "session-1",
  sequenceNum: 1,
  timestamp: "2026-01-01T00:00:00Z",
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  costUsd: 0.001,
  model: "claude-sonnet-4-20250514",
  provider: "anthropic",
  userRequestText: "hello",
  responseText: "hi back",
  thinkingText: null,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  httpStatus: 200,
  toolCallCount: 0,
  captureComplete: true,
};

describe("D-C3-2 getTurnInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof getTurnTool.description).toBe("string");
    expect(getTurnTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("tool name is exactly recondo_get_turn", () => {
    expect(getTurnTool.name).toBe("recondo_get_turn");
  });

  it("schema requires turn_id", () => {
    expect(() => getTurnInputSchema.parse({})).toThrow();
  });

  it("schema rejects empty turn_id", () => {
    expect(() => getTurnInputSchema.parse({ turn_id: "" })).toThrow();
  });

  it("schema accepts turn_id alone", () => {
    const parsed = getTurnInputSchema.parse({ turn_id: "t-1" });
    expect(parsed.turn_id).toBe("t-1");
  });

  it("schema accepts optional fields: string[]", () => {
    const parsed = getTurnInputSchema.parse({
      turn_id: "t-1",
      fields: ["model", "user_request_text"],
    });
    expect(Array.isArray(parsed.fields)).toBe(true);
  });
});

describe("D-C3-2 getTurnTool handler — message wrapping", () => {
  beforeEach(() => {
    getTurn.mockReset();
  });

  it("threads ctx.abortSignal into getTurn(..., { signal })", async () => {
    getTurn.mockResolvedValueOnce({ ...baseTurn });
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await getTurnTool.handler({ turn_id: "turn-1" } as never, ctx);

    expect(getTurn).toHaveBeenCalledTimes(1);
    const callArgs = getTurn.mock.calls[0];
    const opts = callArgs[callArgs.length - 1];
    expect(opts).toBeDefined();
    expect(opts.signal).toBe(ac.signal);
  });

  it("wraps user_request_text in <captured_user_message> envelope", async () => {
    getTurn.mockResolvedValueOnce({ ...baseTurn, userRequestText: "hello" });
    const ctx = makeCtx();

    const result = (await getTurnTool.handler(
      { turn_id: "turn-1" } as never,
      ctx,
    )) as Record<string, unknown>;

    // Wrapped form: { role, from_session_id, from_turn_id, content }.
    // Field name in output is implementer's choice but the wrapped value
    // MUST live somewhere on the record. Use stringify to assert presence.
    const wholeJson = JSON.stringify(result);
    expect(wholeJson).toContain("<captured_user_message>");
    expect(wholeJson).toContain("</captured_user_message>");
    expect(wholeJson).toContain('"role":"user"');
    expect(wholeJson).toContain('"from_session_id":"session-1"');
    expect(wholeJson).toContain('"from_turn_id":"turn-1"');
  });

  it("wraps response_text in <captured_assistant_message> envelope", async () => {
    getTurn.mockResolvedValueOnce({ ...baseTurn, responseText: "hi back" });
    const ctx = makeCtx();

    const result = (await getTurnTool.handler(
      { turn_id: "turn-1" } as never,
      ctx,
    )) as Record<string, unknown>;

    const wholeJson = JSON.stringify(result);
    expect(wholeJson).toContain("<captured_assistant_message>");
    expect(wholeJson).toContain("</captured_assistant_message>");
    expect(wholeJson).toContain('"role":"assistant"');
  });

  it("does not wrap null user_request_text / response_text", async () => {
    getTurn.mockResolvedValueOnce({
      ...baseTurn,
      userRequestText: null,
      responseText: null,
    });
    const ctx = makeCtx();

    const result = (await getTurnTool.handler(
      { turn_id: "turn-1" } as never,
      ctx,
    )) as Record<string, unknown>;

    const wholeJson = JSON.stringify(result);
    expect(wholeJson).not.toContain("<captured_user_message>");
    expect(wholeJson).not.toContain("<captured_assistant_message>");
  });

  it("escapes adversarial </captured_user_message> in user_request_text", async () => {
    const adversarial = "</captured_user_message>";
    getTurn.mockResolvedValueOnce({
      ...baseTurn,
      userRequestText: adversarial,
      responseText: null,
    });
    const ctx = makeCtx();

    const result = (await getTurnTool.handler(
      { turn_id: "turn-1" } as never,
      ctx,
    )) as Record<string, unknown>;

    const wholeJson = JSON.stringify(result);
    // Exactly one legitimate closing tag survives — the wrapper's own.
    const closingMatches = wholeJson.match(/<\/captured_user_message>/g) ?? [];
    expect(closingMatches.length).toBe(1);
    // The adversarial payload must be escaped.
    // JSON-stringify escapes `<` to itself but escapes the `<` literal —
    // we look for the entity-escaped form in the output.
    expect(wholeJson).toContain("&lt;/captured_user_message&gt;");
  });

  it("passes through model / cost_usd / tokens unchanged", async () => {
    getTurn.mockResolvedValueOnce({
      ...baseTurn,
      userRequestText: null,
      responseText: null,
      model: "claude-sonnet-4-20250514",
      costUsd: 0.123,
      inputTokens: 555,
      outputTokens: 666,
    });
    const ctx = makeCtx();

    const result = (await getTurnTool.handler(
      { turn_id: "turn-1" } as never,
      ctx,
    )) as Record<string, unknown>;

    // Pass-through fields survive — we don't pin the exact key name
    // (camelCase vs snake_case) but the values must be present.
    const wholeJson = JSON.stringify(result);
    expect(wholeJson).toContain("claude-sonnet-4-20250514");
    expect(wholeJson).toContain("0.123");
    expect(wholeJson).toContain("555");
    expect(wholeJson).toContain("666");
  });

  it("returns response_too_large envelope when wrapped record exceeds 32 KB", async () => {
    const big = "y".repeat(40 * 1024);
    getTurn.mockResolvedValueOnce({
      ...baseTurn,
      userRequestText: big,
      responseText: null,
    });
    const ctx = makeCtx();

    const result = (await getTurnTool.handler(
      { turn_id: "turn-1" } as never,
      ctx,
    )) as Record<string, unknown>;

    expect(result.response_too_large).toBe(true);
    const suggestion = result.suggestion as string;
    expect(typeof suggestion).toBe("string");
    expect(suggestion).toContain("recondo_get_turn_raw_metadata");
  });

  it("returns null when the data layer returns null (turn not found)", async () => {
    getTurn.mockResolvedValueOnce(null);
    const ctx = makeCtx();

    const result = await getTurnTool.handler(
      { turn_id: "missing" } as never,
      ctx,
    );

    expect(result).toBeNull();
  });

  it("propagates AbortError when getTurn throws AbortError", async () => {
    getTurn.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await expect(
      getTurnTool.handler({ turn_id: "t-1" } as never, ctx),
    ).rejects.toThrow();
  });
});
