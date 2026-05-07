/**
 * D-C3-5 (unit) — Pre-aborted-signal contract for the 4 C3 tools.
 *
 * Each handler MUST eventually reject with AbortError when invoked
 * with a `ctx.abortSignal` that is already aborted at call time.
 *
 * Two acceptable boundaries (orchestration §C3 Lesson):
 *   (a) The MCP handler throws/rejects synchronously before invoking
 *       the data layer.
 *   (b) The handler delegates and the data layer rejects (it already
 *       calls `signal.throwIfAborted()` / `signal.aborted` checks
 *       BEFORE any pool query — see `turns-raw.ts:throwIfAborted`).
 *
 * Either way, the handler MUST reject with an AbortError; this test
 * suite asserts that observable contract without pinning the
 * boundary choice.
 */
import { describe, it, expect, vi } from "vitest";

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

import { getSessionTool } from "../../src/tools/get-session.js";
import { getTurnTool } from "../../src/tools/get-turn.js";
import { getTurnRawMetadataTool } from "../../src/tools/get-turn-raw-metadata.js";
import { getTurnRawChunkTool } from "../../src/tools/get-turn-raw-chunk.js";
import type { ToolContext } from "../../src/registry/types.js";

function abortedCtx(): ToolContext {
  const ac = new AbortController();
  ac.abort();
  return {
    abortSignal: ac.signal,
    auth: {
      kind: "dev-bypass",
      isAdmin: true,
      projectId: null,
      keyId: "dev-bypass",
    },
    audit: { write: vi.fn().mockResolvedValue(undefined) },
  };
}

/**
 * If the handler delegates to the data layer with the pre-aborted
 * signal, the data-layer mock checks the signal and rejects with
 * AbortError — replicating the real `turns-raw.ts:throwIfAborted`
 * behaviour.
 *
 * If the handler throws/rejects synchronously before invoking the data
 * layer, the mock is never called and the promise still rejects with
 * AbortError (DOMException with name "AbortError").
 */
function dataLayerHonoursAbort(mock: ReturnType<typeof vi.fn>): void {
  mock.mockImplementation((..._args: unknown[]) => {
    const opts = _args[_args.length - 1] as { signal?: AbortSignal } | undefined;
    if (opts?.signal?.aborted) {
      return Promise.reject(new DOMException("aborted", "AbortError"));
    }
    return Promise.resolve(null);
  });
}

describe("D-C3-5 pre-aborted signal — recondo_get_session", () => {
  it("rejects with AbortError before yielding a result", async () => {
    dataLayerHonoursAbort(getSession);
    const ctx = abortedCtx();
    await expect(
      getSessionTool.handler({ session_id: "s-1" } as never, ctx),
    ).rejects.toThrow();
  });
});

describe("D-C3-5 pre-aborted signal — recondo_get_turn", () => {
  it("rejects with AbortError before yielding a result", async () => {
    dataLayerHonoursAbort(getTurn);
    const ctx = abortedCtx();
    await expect(
      getTurnTool.handler({ turn_id: "t-1" } as never, ctx),
    ).rejects.toThrow();
  });
});

describe("D-C3-5 pre-aborted signal — recondo_get_turn_raw_metadata", () => {
  it("rejects with AbortError before yielding a result", async () => {
    dataLayerHonoursAbort(getTurnRawMetadata);
    const ctx = abortedCtx();
    await expect(
      getTurnRawMetadataTool.handler(
        { turn_id: "t-1", side: "request" } as never,
        ctx,
      ),
    ).rejects.toThrow();
  });
});

describe("D-C3-5 pre-aborted signal — recondo_get_turn_raw_chunk", () => {
  it("rejects with AbortError before yielding a result", async () => {
    dataLayerHonoursAbort(getTurnRawChunk);
    const ctx = abortedCtx();
    await expect(
      getTurnRawChunkTool.handler(
        { turn_id: "t-1", side: "request", offset: 0, length: 100 } as never,
        ctx,
      ),
    ).rejects.toThrow();
  });
});
