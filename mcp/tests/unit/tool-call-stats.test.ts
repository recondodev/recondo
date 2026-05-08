/**
 * D-C7-4 (unit) — `recondo_tool_call_stats` tool: schema + handler.
 *
 * Contract pinned by C0 audit + Plan D §C7 (with explicit Plan D drift
 * guards):
 *
 *   - Tool name: `recondo_tool_call_stats`.
 *   - Description >= 50 chars.
 *   - Input shape:
 *       group_by: z.enum(["tool_name", "session", "framework"])  REQUIRED.
 *       period?:  enum (the data-layer enum is "24h"|"7d"|"30d"|"all";
 *                       the MCP surface MAY expose the human-readable
 *                       "day"/"week"/"month" enum and translate. Either
 *                       form is acceptable as long as the schema rejects
 *                       garbage and accepts at minimum a 4-member set
 *                       covering 24h/day, 7d/week, 30d/month, all/quarter).
 *       project_id?: string  (overrides auth.projectId).
 *       limit?:  integer (>= 1).
 *       offset?: integer (>= 0).
 *
 *   - Underlying call: `toolCallStats(options)` from `@recondo/data`
 *     (tool-call-stats.ts). The data-layer signature is
 *     `toolCallStats({group_by, period, signal}) -> AsyncIterable<row>`.
 *     The handler iterates with `for await` and projects rows into the
 *     canonical 5-key list envelope.
 *
 *   - CRITICAL Plan D drift (orchestration §line 169):
 *     The data-layer `ToolCallStatsRow` type does NOT contain
 *     `token_cost_total` (the legacy field). It DOES contain
 *     `total_duration_ms`. The MCP tool's output MUST preserve
 *     `total_duration_ms` and MUST NOT introduce `token_cost_total`.
 *     Tests below pin this via:
 *       1. A mock that yields `{tool_name, call_count, total_duration_ms}`
 *          and asserts the response includes `total_duration_ms: 1000`.
 *       2. A SHAM_FIX guard: the serialised envelope MUST NOT contain
 *          the literal string "token_cost_total".
 *       3. A source-grep test: `mcp/src/tools/tool-call-stats.ts` MUST
 *          NOT contain the literal "token_cost_total".
 *
 *   - `ctx.abortSignal` MUST be threaded into `toolCallStats({signal: …})`.
 *
 * Phantom-wiring guard:
 *   - `toolCallStats` is the canonical name (NO RENAME per C0). The
 *     source must import it verbatim.
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

import {
  toolCallStatsTool,
  toolCallStatsInputSchema,
} from "../../src/tools/tool-call-stats.js";
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

/** Wrap an array as an AsyncIterable (matches the data-layer contract). */
function asyncIter<T>(rows: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<T>> {
          if (i < rows.length) {
            return { value: rows[i++], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

const sampleRow = {
  group_key: "Read",
  total_calls: 5,
  failure_rate: 0.2,
  avg_latency_ms: 150,
  total_duration_ms: 1000,
};

describe("D-C7-4 toolCallStatsInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof toolCallStatsTool.description).toBe("string");
    expect(toolCallStatsTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("tool name is exactly recondo_tool_call_stats", () => {
    expect(toolCallStatsTool.name).toBe("recondo_tool_call_stats");
  });

  it("group_by enum has exactly 3 members: tool_name / session / framework", () => {
    expect(() =>
      toolCallStatsInputSchema.parse({ group_by: "tool_name" }),
    ).not.toThrow();
    expect(() =>
      toolCallStatsInputSchema.parse({ group_by: "session" }),
    ).not.toThrow();
    expect(() =>
      toolCallStatsInputSchema.parse({ group_by: "framework" }),
    ).not.toThrow();
  });

  it("group_by rejects values outside the 3-member enum", () => {
    expect(() =>
      toolCallStatsInputSchema.parse({ group_by: "developer" }),
    ).toThrow();
    expect(() =>
      toolCallStatsInputSchema.parse({ group_by: "TOOL_NAME" }),
    ).toThrow();
    expect(() => toolCallStatsInputSchema.parse({ group_by: "" })).toThrow();
  });

  it("group_by is required (no default)", () => {
    expect(() => toolCallStatsInputSchema.parse({})).toThrow();
  });

  it("schema accepts optional period (rejects garbage)", () => {
    // The MCP surface may translate the human-readable enum or expose
    // the data-layer enum verbatim. Either way, garbage rejects.
    expect(() =>
      toolCallStatsInputSchema.parse({
        group_by: "tool_name",
        period: "GARBAGE",
      }),
    ).toThrow();
  });

  it("schema rejects period='quarter' (no 90-day bucket in the data layer)", () => {
    // C7 review fix (FIND-C7-2): the data layer has no honest 90-day
    // bucket; mapping `quarter -> all` silently broadens the window.
    // The tool-call-stats schema deliberately drops `quarter` so the
    // contract violation surfaces at the schema layer.
    expect(() =>
      toolCallStatsInputSchema.parse({
        group_by: "tool_name",
        period: "quarter",
      }),
    ).toThrow();
  });

  it("schema accepts period in {day, week, month}", () => {
    for (const period of ["day", "week", "month"] as const) {
      expect(() =>
        toolCallStatsInputSchema.parse({
          group_by: "tool_name",
          period,
        }),
      ).not.toThrow();
    }
  });

  it("schema accepts optional project_id / limit / offset", () => {
    const parsed = toolCallStatsInputSchema.parse({
      group_by: "tool_name",
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
      toolCallStatsInputSchema.parse({
        group_by: "tool_name",
        offset: -1,
      }),
    ).toThrow();
    expect(() =>
      toolCallStatsInputSchema.parse({
        group_by: "tool_name",
        limit: 0,
      }),
    ).toThrow();
  });
});

describe("D-C7-4 toolCallStatsTool — phantom-wiring + Plan D drift guard", () => {
  it("source imports `toolCallStats` (no rename)", () => {
    const sourcePath = resolve(__dirname, "../../src/tools/tool-call-stats.ts");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("toolCallStats");
  });

  it("source MUST NOT contain the literal `token_cost_total` (Plan D drift)", () => {
    const sourcePath = resolve(__dirname, "../../src/tools/tool-call-stats.ts");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).not.toContain("token_cost_total");
  });
});

describe("D-C7-4 toolCallStatsTool handler — call shape + signal threading", () => {
  beforeEach(() => {
    toolCallStats.mockReset();
  });

  it("calls toolCallStats({group_by, period?, signal}) with the AsyncIterable contract", async () => {
    toolCallStats.mockReturnValueOnce(asyncIter([sampleRow]));
    const ctx = makeCtx();

    await toolCallStatsTool.handler(
      { group_by: "tool_name" } as never,
      ctx,
    );

    expect(toolCallStats).toHaveBeenCalledTimes(1);
    const callArgs = toolCallStats.mock.calls[0];
    // toolCallStats takes a single options object, not (apiKey, args, opts).
    expect(callArgs.length).toBe(1);
    const opts = callArgs[0] as { group_by: string; signal?: AbortSignal };
    expect(opts.group_by).toBe("tool_name");
  });

  it("threads ctx.abortSignal into the options bag", async () => {
    toolCallStats.mockReturnValueOnce(asyncIter([]));
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await toolCallStatsTool.handler(
      { group_by: "tool_name" } as never,
      ctx,
    );

    const callArgs = toolCallStats.mock.calls[0];
    const opts = callArgs[0] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("forwards project_id into the data-layer options bag", async () => {
    toolCallStats.mockReturnValueOnce(asyncIter([]));
    const ctx = makeCtx();

    await toolCallStatsTool.handler(
      { group_by: "tool_name", project_id: "proj-1" } as never,
      ctx,
    );

    const callArgs = toolCallStats.mock.calls[0];
    const opts = callArgs[0] as { projectId?: string };
    expect(opts.projectId).toBe("proj-1");
  });

  it("propagates AbortError when toolCallStats throws synchronously (pre-aborted)", async () => {
    toolCallStats.mockImplementationOnce(() => {
      throw new DOMException("aborted", "AbortError");
    });
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await expect(
      toolCallStatsTool.handler(
        { group_by: "tool_name" } as never,
        ctx,
      ),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});

describe("D-C7-4 toolCallStatsTool handler — output envelope (Plan D drift pin)", () => {
  beforeEach(() => {
    toolCallStats.mockReset();
  });

  it("returns the canonical 5-key list envelope shape", async () => {
    toolCallStats.mockReturnValueOnce(asyncIter([sampleRow]));
    const ctx = makeCtx();

    const result = (await toolCallStatsTool.handler(
      { group_by: "tool_name" } as never,
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
  });

  it("preserves `total_duration_ms` from the underlying row", async () => {
    toolCallStats.mockReturnValueOnce(
      asyncIter([
        {
          group_key: "x",
          total_calls: 5,
          failure_rate: 0,
          avg_latency_ms: 200,
          total_duration_ms: 1000,
        },
      ]),
    );
    const ctx = makeCtx();

    const result = (await toolCallStatsTool.handler(
      { group_by: "tool_name" } as never,
      ctx,
    )) as { items: Array<Record<string, unknown>> };

    expect(result.items.length).toBe(1);
    const row = result.items[0];
    // The handler may camel-case the field — accept either form.
    const dur = row.total_duration_ms ?? row.totalDurationMs;
    expect(dur).toBe(1000);
  });

  it("SHAM_FIX guard: serialised envelope MUST NOT contain `token_cost_total`", async () => {
    toolCallStats.mockReturnValueOnce(asyncIter([sampleRow]));
    const ctx = makeCtx();

    const result = await toolCallStatsTool.handler(
      { group_by: "tool_name" } as never,
      ctx,
    );

    const wholeJson = JSON.stringify(result);
    expect(wholeJson).not.toContain("token_cost_total");
  });

  it("yields per-group rows for group_by=session", async () => {
    toolCallStats.mockReturnValueOnce(
      asyncIter([
        {
          group_key: "session-1",
          total_calls: 3,
          failure_rate: 0,
          avg_latency_ms: 50,
          total_duration_ms: 150,
        },
      ]),
    );
    const ctx = makeCtx();

    const result = (await toolCallStatsTool.handler(
      { group_by: "session" } as never,
      ctx,
    )) as { items: Array<Record<string, unknown>> };

    expect(result.items.length).toBe(1);
    expect(JSON.stringify(result)).toContain("session-1");

    const callArgs = toolCallStats.mock.calls[0];
    const opts = callArgs[0] as { group_by: string };
    expect(opts.group_by).toBe("session");
  });

  it("paginates correctly when both limit and offset are provided (C7 fix)", async () => {
    // FIND-C7-1 regression pin: collecting `limit` rows and THEN
    // slicing by offset returned an empty page when `offset >= limit`.
    // Seed 15 rows; ask for {limit:5, offset:5} and expect rows 5..9
    // (the 6th through 10th elements).
    const fifteen = Array.from({ length: 15 }, (_, i) => ({
      group_key: `tool-${i.toString().padStart(2, "0")}`,
      total_calls: i + 1,
      failure_rate: 0,
      avg_latency_ms: 100 + i,
      total_duration_ms: (i + 1) * 100,
    }));
    toolCallStats.mockReturnValueOnce(asyncIter(fifteen));
    const ctx = makeCtx();

    const result = (await toolCallStatsTool.handler(
      { group_by: "tool_name", limit: 5, offset: 5 } as never,
      ctx,
    )) as { items: Array<Record<string, unknown>> };

    expect(result.items.length).toBe(5);
    const keys = result.items.map((r) => r.group_key);
    expect(keys).toEqual([
      "tool-05",
      "tool-06",
      "tool-07",
      "tool-08",
      "tool-09",
    ]);
  });

  it("yields per-group rows for group_by=framework", async () => {
    toolCallStats.mockReturnValueOnce(
      asyncIter([
        {
          group_key: "claude-code",
          total_calls: 7,
          failure_rate: 0.1,
          avg_latency_ms: 200,
          total_duration_ms: 1400,
        },
      ]),
    );
    const ctx = makeCtx();

    const result = (await toolCallStatsTool.handler(
      { group_by: "framework" } as never,
      ctx,
    )) as { items: Array<Record<string, unknown>> };

    expect(result.items.length).toBe(1);
    expect(JSON.stringify(result)).toContain("claude-code");

    const callArgs = toolCallStats.mock.calls[0];
    const opts = callArgs[0] as { group_by: string };
    expect(opts.group_by).toBe("framework");
  });
});
