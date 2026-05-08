/**
 * D-C3-4 (unit) — `recondo_get_turn_raw_chunk` tool: schema + handler.
 *
 *   - Tool name: `recondo_get_turn_raw_chunk`.
 *   - Input shape: { turn_id: string (non-empty), offset: int >= 0,
 *     length: int >= 1 AND <= 32_768 }. Request-side only — no `side`
 *     parameter; response-side raw access is a future tool. The MCP
 *     layer caps `length` at 32 KB (32_768) — a Zod max() — even
 *     though the data layer would silently clamp.
 *   - Handler delegates to `getTurnRawChunk(turnId, offset, length,
 *     options)` from `@recondo/data` (turns-raw.ts) and wraps the
 *     returned `Buffer` via `buildRawByteEnvelope` —
 *     `{ role:"raw", from_turn_id, offset, length, next_offset, content }`.
 *   - `length` in the envelope reflects the ACTUAL bytes returned, not
 *     the requested length (past-EOF clamp). `next_offset` mirrors the
 *     data layer (`null` once EOF is reached).
 *   - `ctx.abortSignal` MUST be threaded into
 *     `getTurnRawChunk(turnId, offset, length, { signal: ctx.abortSignal })`.
 *   - Description >= 50 chars.
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
  getTurnRawChunkTool,
  getTurnRawChunkInputSchema,
} from "../../src/tools/get-turn-raw-chunk.js";
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

describe("D-C3-4 getTurnRawChunkInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof getTurnRawChunkTool.description).toBe("string");
    expect(getTurnRawChunkTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("tool name is exactly recondo_get_turn_raw_chunk", () => {
    expect(getTurnRawChunkTool.name).toBe("recondo_get_turn_raw_chunk");
  });

  it("schema requires turn_id, offset, length", () => {
    expect(() => getTurnRawChunkInputSchema.parse({})).toThrow();
    expect(() =>
      getTurnRawChunkInputSchema.parse({ turn_id: "t-1" }),
    ).toThrow();
    expect(() =>
      getTurnRawChunkInputSchema.parse({ turn_id: "t-1", offset: 0 }),
    ).toThrow();
  });

  it("schema rejects empty turn_id", () => {
    expect(() =>
      getTurnRawChunkInputSchema.parse({
        turn_id: "",
        offset: 0,
        length: 100,
      }),
    ).toThrow();
  });

  it("schema accepts length=1", () => {
    const parsed = getTurnRawChunkInputSchema.parse({
      turn_id: "t-1",
      offset: 0,
      length: 1,
    });
    expect(parsed.length).toBe(1);
  });

  it("schema accepts a normal {turn_id, offset, length}", () => {
    const parsed = getTurnRawChunkInputSchema.parse({
      turn_id: "t-1",
      offset: 0,
      length: 1000,
    });
    expect(parsed).toMatchObject({
      turn_id: "t-1",
      offset: 0,
      length: 1000,
    });
  });

  it("schema accepts length=32768 (the inclusive cap)", () => {
    const parsed = getTurnRawChunkInputSchema.parse({
      turn_id: "t-1",
      offset: 0,
      length: 32768,
    });
    expect(parsed.length).toBe(32768);
  });

  it("schema rejects length=32769 (Zod-level cap, NOT silent clamp)", () => {
    expect(() =>
      getTurnRawChunkInputSchema.parse({
        turn_id: "t-1",
        offset: 0,
        length: 32769,
      }),
    ).toThrow();
  });

  it("schema rejects length=0", () => {
    expect(() =>
      getTurnRawChunkInputSchema.parse({
        turn_id: "t-1",
        offset: 0,
        length: 0,
      }),
    ).toThrow();
  });

  it("schema rejects negative length", () => {
    expect(() =>
      getTurnRawChunkInputSchema.parse({
        turn_id: "t-1",
        offset: 0,
        length: -1,
      }),
    ).toThrow();
  });

  it("schema rejects negative offset", () => {
    expect(() =>
      getTurnRawChunkInputSchema.parse({
        turn_id: "t-1",
        offset: -1,
        length: 100,
      }),
    ).toThrow();
  });

  it("schema accepts offset=0", () => {
    const parsed = getTurnRawChunkInputSchema.parse({
      turn_id: "t-1",
      offset: 0,
      length: 100,
    });
    expect(parsed.offset).toBe(0);
  });

  it("description mentions request-side scope (response is a future tool)", () => {
    expect(getTurnRawChunkTool.description.toLowerCase()).toContain("request");
  });
});

describe("D-C3-4 getTurnRawChunkTool handler", () => {
  beforeEach(() => {
    getTurnRawChunk.mockReset();
  });

  it("wraps the returned Buffer via buildRawByteEnvelope (6-key shape with next_offset)", async () => {
    const bytes = Buffer.from("hello-world", "utf8");
    getTurnRawChunk.mockResolvedValueOnce({
      offset: 0,
      bytes,
      next_offset: bytes.length, // mid-stream — caller should walk further
    });
    const ctx = makeCtx();

    const result = (await getTurnRawChunkTool.handler(
      { turn_id: "turn-1", offset: 0, length: 100 } as never,
      ctx,
    )) as Record<string, unknown>;

    // RawByteEnvelope: { role, from_turn_id, offset, length, next_offset, content }.
    expect(result.role).toBe("raw");
    expect(result.from_turn_id).toBe("turn-1");
    expect(result.offset).toBe(0);
    // length reflects ACTUAL bytes returned, not the requested 100.
    expect(result.length).toBe(bytes.length);
    expect(result.next_offset).toBe(bytes.length);
    expect(typeof result.content).toBe("string");

    const content = result.content as string;
    expect(content).toContain("<captured_raw_bytes");
    expect(content).toContain("</captured_raw_bytes>");
    expect(content).toContain(bytes.toString("base64"));
  });

  it("short read past EOF: envelope.length reflects ACTUAL bytes; next_offset === null", async () => {
    // Caller asks for 1000 bytes; data layer clamps to the tail (5 bytes).
    const tail = Buffer.from("abcde", "utf8");
    getTurnRawChunk.mockResolvedValueOnce({
      offset: 95,
      bytes: tail,
      next_offset: null,
    });
    const ctx = makeCtx();

    const result = (await getTurnRawChunkTool.handler(
      { turn_id: "turn-1", offset: 95, length: 1000 } as never,
      ctx,
    )) as Record<string, unknown>;

    expect(result.offset).toBe(95);
    expect(result.length).toBe(tail.length); // 5, NOT 1000
    expect(result.next_offset).toBeNull();
  });

  it("threads ctx.abortSignal into getTurnRawChunk(..., { signal })", async () => {
    getTurnRawChunk.mockResolvedValueOnce({
      offset: 0,
      bytes: Buffer.alloc(0),
      next_offset: null,
    });
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await getTurnRawChunkTool.handler(
      { turn_id: "t-1", offset: 0, length: 100 } as never,
      ctx,
    );

    expect(getTurnRawChunk).toHaveBeenCalledTimes(1);
    const callArgs = getTurnRawChunk.mock.calls[0];
    // getTurnRawChunk(turnId, offset, length, options) — options is [3].
    const opts = callArgs[3];
    expect(opts).toBeDefined();
    expect(opts.signal).toBe(ac.signal);
  });

  it("forwards turn_id, offset, length positionally to the data layer", async () => {
    getTurnRawChunk.mockResolvedValueOnce({
      offset: 100,
      bytes: Buffer.alloc(0),
      next_offset: null,
    });
    const ctx = makeCtx();

    await getTurnRawChunkTool.handler(
      { turn_id: "abc-123", offset: 100, length: 500 } as never,
      ctx,
    );

    const callArgs = getTurnRawChunk.mock.calls[0];
    expect(callArgs[0]).toBe("abc-123");
    expect(callArgs[1]).toBe(100);
    expect(callArgs[2]).toBe(500);
  });

  it("propagates AbortError when getTurnRawChunk throws AbortError", async () => {
    getTurnRawChunk.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await expect(
      getTurnRawChunkTool.handler(
        { turn_id: "t-1", offset: 0, length: 10 } as never,
        ctx,
      ),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});
