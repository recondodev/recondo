/**
 * D-C3-3 (unit) — `recondo_get_turn_raw_metadata` tool: schema + handler.
 *
 *   - Tool name: `recondo_get_turn_raw_metadata`.
 *   - Input shape: { turn_id: string (non-empty) }. Request-side only —
 *     no `side` parameter; response-side raw access is a future tool.
 *   - Handler delegates to `getTurnRawMetadata(turnId, options)` from
 *     `@recondo/data` (turns-raw.ts) and SURFACES the data-layer's
 *     return shape verbatim — `{ content_hash, bytes_total,
 *     content_type, head_sample_utf8 }`. Field name MUST be
 *     `head_sample_utf8`, NOT `head_sample_bytes` (Plan D drift).
 *   - The metadata is NOT wrapped — it's not captured content, it's
 *     metadata about captured content.
 *   - `ctx.abortSignal` MUST be threaded into
 *     `getTurnRawMetadata(turnId, { signal: ctx.abortSignal })`.
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
  getTurnRawMetadataTool,
  getTurnRawMetadataInputSchema,
} from "../../src/tools/get-turn-raw-metadata.js";
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

describe("D-C3-3 getTurnRawMetadataInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof getTurnRawMetadataTool.description).toBe("string");
    expect(getTurnRawMetadataTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("tool name is exactly recondo_get_turn_raw_metadata", () => {
    expect(getTurnRawMetadataTool.name).toBe("recondo_get_turn_raw_metadata");
  });

  it("schema requires turn_id", () => {
    expect(() => getTurnRawMetadataInputSchema.parse({})).toThrow();
  });

  it("schema rejects empty turn_id", () => {
    expect(() =>
      getTurnRawMetadataInputSchema.parse({ turn_id: "" }),
    ).toThrow();
  });

  it("schema accepts turn_id alone (no `side` parameter in v1)", () => {
    const parsed = getTurnRawMetadataInputSchema.parse({ turn_id: "t-1" });
    expect(parsed.turn_id).toBe("t-1");
  });

  it("description mentions request-side scope (response is a future tool)", () => {
    expect(getTurnRawMetadataTool.description.toLowerCase()).toContain(
      "request",
    );
  });
});

describe("D-C3-3 getTurnRawMetadataTool handler", () => {
  beforeEach(() => {
    getTurnRawMetadata.mockReset();
  });

  it("returns the data-layer record verbatim with head_sample_utf8 (NOT head_sample_bytes)", async () => {
    // The mock returns the EXACT shape from turns-raw.ts:
    //   { content_hash, bytes_total, content_type, head_sample_utf8 }
    const dataLayerRecord = {
      content_hash: "abc123",
      bytes_total: 4096,
      content_type: "application/json",
      head_sample_utf8: '{"hello":"world"}',
    };
    getTurnRawMetadata.mockResolvedValueOnce(dataLayerRecord);
    const ctx = makeCtx();

    const result = (await getTurnRawMetadataTool.handler(
      { turn_id: "turn-1" } as never,
      ctx,
    )) as Record<string, unknown>;

    // Strict pass-through: the tool MUST surface the data layer's
    // exact field names. `head_sample_utf8` survives; `head_sample_bytes`
    // (Plan D drift) MUST NOT appear.
    expect(result).toHaveProperty("head_sample_utf8");
    expect(result.head_sample_utf8).toBe('{"hello":"world"}');
    expect(result).not.toHaveProperty("head_sample_bytes");
    expect(result.content_hash).toBe("abc123");
    expect(result.bytes_total).toBe(4096);
    expect(result.content_type).toBe("application/json");
  });

  it("does NOT rename or rewrite — adversarial 'head_sample_bytes' in the mock is ignored / surfaced as-is", async () => {
    // If the data layer ever drifts (Plan D wrote `head_sample_bytes`),
    // the tool MUST NOT silently rename it. It surfaces whatever the
    // data layer returns. Our spec says the data layer returns
    // `head_sample_utf8` — so we test that mocking the correct field
    // produces the correct field in the output, with no fallback or
    // alias logic.
    const dataLayerRecord = {
      content_hash: "h",
      bytes_total: 10,
      content_type: "application/octet-stream",
      head_sample_utf8: "binarystuff",
    };
    getTurnRawMetadata.mockResolvedValueOnce(dataLayerRecord);
    const ctx = makeCtx();

    const result = (await getTurnRawMetadataTool.handler(
      { turn_id: "turn-1" } as never,
      ctx,
    )) as Record<string, unknown>;

    // Output keys must include `head_sample_utf8` and EXCLUDE
    // `head_sample_bytes`.
    const keys = Object.keys(result);
    expect(keys).toContain("head_sample_utf8");
    expect(keys).not.toContain("head_sample_bytes");
  });

  it("threads ctx.abortSignal into getTurnRawMetadata(turnId, { signal })", async () => {
    getTurnRawMetadata.mockResolvedValueOnce({
      content_hash: "h",
      bytes_total: 0,
      content_type: "application/octet-stream",
      head_sample_utf8: "",
    });
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await getTurnRawMetadataTool.handler(
      { turn_id: "t-1" } as never,
      ctx,
    );

    expect(getTurnRawMetadata).toHaveBeenCalledTimes(1);
    const callArgs = getTurnRawMetadata.mock.calls[0];
    // getTurnRawMetadata(turnId, options) — options is positional[1].
    const opts = callArgs[1];
    expect(opts).toBeDefined();
    expect(opts.signal).toBe(ac.signal);
  });

  it("forwards turn_id positionally to the data layer", async () => {
    getTurnRawMetadata.mockResolvedValueOnce({
      content_hash: "h",
      bytes_total: 0,
      content_type: "application/octet-stream",
      head_sample_utf8: "",
    });
    const ctx = makeCtx();

    await getTurnRawMetadataTool.handler(
      { turn_id: "abc-123" } as never,
      ctx,
    );

    const callArgs = getTurnRawMetadata.mock.calls[0];
    expect(callArgs[0]).toBe("abc-123");
  });

  it("propagates AbortError when getTurnRawMetadata throws AbortError", async () => {
    getTurnRawMetadata.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await expect(
      getTurnRawMetadataTool.handler(
        { turn_id: "t-1" } as never,
        ctx,
      ),
    ).rejects.toThrow();
  });
});
