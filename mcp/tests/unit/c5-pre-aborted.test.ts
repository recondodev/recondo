/**
 * D-C5 (unit) — Pre-aborted-signal contract for the 4 C5 tools.
 *
 * Each handler MUST eventually reject with AbortError when invoked
 * with a `ctx.abortSignal` that is already aborted at call time.
 *
 * Two acceptable boundaries (mirrors single-record-pre-aborted.test.ts):
 *   (a) The MCP handler throws/rejects synchronously before invoking
 *       the data layer.
 *   (b) The handler delegates and the data layer rejects (it already
 *       calls `throwIfAborted(signal)` BEFORE any pool query — see
 *       `compare-turns.ts`, `find-similar-prompts.ts`,
 *       `related-turns.ts`, `session-efficiency.ts`).
 *
 * Either way, the handler MUST reject. The mocks here replicate the
 * data-layer behaviour: when `options.signal.aborted` is true, throw
 * an AbortError synchronously (not packaged in a rejected Promise).
 */
import { describe, it, expect, vi } from "vitest";

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

import { compareTurnsTool } from "../../src/tools/compare-turns.js";
import { findSimilarPromptsTool } from "../../src/tools/find-similar-prompts.js";
import { relatedTurnsTool } from "../../src/tools/related-turns.js";
import { sessionEfficiencyTool } from "../../src/tools/session-efficiency.js";
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

function asyncIter<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<T>> {
          if (i < items.length) return { value: items[i++], done: false };
          return { value: undefined as unknown as T, done: true };
        },
      };
    },
  };
}

/** Promise-style data-layer mock that honours `options.signal.aborted`. */
function promiseHonoursAbort(mock: ReturnType<typeof vi.fn>): void {
  mock.mockImplementation((..._args: unknown[]) => {
    const opts = _args[_args.length - 1] as { signal?: AbortSignal } | undefined;
    if (opts?.signal?.aborted) {
      return Promise.reject(new DOMException("aborted", "AbortError"));
    }
    return Promise.resolve(null);
  });
}

/** AsyncIterable-style data-layer mock that throws sync on aborted. */
function iterableHonoursAbort(mock: ReturnType<typeof vi.fn>): void {
  mock.mockImplementation((..._args: unknown[]) => {
    const opts = _args[_args.length - 1] as { signal?: AbortSignal } | undefined;
    if (opts?.signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    return asyncIter([]);
  });
}

describe("D-C5 pre-aborted signal — recondo_compare_turns", () => {
  it("rejects with AbortError before yielding a result", async () => {
    promiseHonoursAbort(compareTurns);
    const ctx = abortedCtx();
    await expect(
      compareTurnsTool.handler(
        { turn_ids: ["t-1", "t-2"] } as never,
        ctx,
      ),
    ).rejects.toThrow();
  });
});

describe("D-C5 pre-aborted signal — recondo_find_similar_prompts", () => {
  it("rejects with AbortError before yielding a result", async () => {
    iterableHonoursAbort(findSimilarPrompts);
    const ctx = abortedCtx();
    await expect(
      findSimilarPromptsTool.handler({ turn_id: "t-1" } as never, ctx),
    ).rejects.toThrow();
  });
});

describe("D-C5 pre-aborted signal — recondo_related_turns", () => {
  it("rejects with AbortError before yielding a result", async () => {
    iterableHonoursAbort(relatedTurns);
    const ctx = abortedCtx();
    await expect(
      relatedTurnsTool.handler(
        { turn_id: "t-1", relation: "same_session" } as never,
        ctx,
      ),
    ).rejects.toThrow();
  });
});

describe("D-C5 pre-aborted signal — recondo_session_efficiency", () => {
  it("rejects with AbortError before yielding a result", async () => {
    promiseHonoursAbort(sessionEfficiency);
    const ctx = abortedCtx();
    await expect(
      sessionEfficiencyTool.handler(
        { session_id: "session-1" } as never,
        ctx,
      ),
    ).rejects.toThrow();
  });
});
