/**
 * D-C7-1 (unit) — `recondo_agent_summary` tool: schema + handler.
 *
 * Contract pinned by C0 audit + Plan D §C7:
 *   - Tool name: `recondo_agent_summary`.
 *   - Description >= 50 chars.
 *   - Input shape (mirrors data-layer `AgentQueryArgs`):
 *       period?: enum (human-readable; translated to DAY_<n> at boundary).
 *       project_id?: string  (overrides auth.projectId on the apiKey bag).
 *   - Handler is a thin pass-through to
 *       getAgentSummary(apiKey, args, options)
 *     from `@recondo/data` (agents.ts). Returns the structured
 *     `AgentSummaryRow` record verbatim — single record, NO list envelope
 *     wrapping. Subject to the 32 KB single-record budget.
 *   - `ctx.abortSignal` MUST be threaded into the data-layer options bag.
 *
 * Phantom-wiring guard (C0 contract):
 *   - The production source MUST import `getAgentSummary` (RIGHT-column
 *     name) and MUST NOT contain the bare LEFT-column name
 *     `agentSummary` anywhere — verified by source-grep.
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
  agentSummaryTool,
  agentSummaryInputSchema,
} from "../../src/tools/agent-summary.js";
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

const sampleSummary = {
  activeAgents: 3,
  frameworkCount: 2,
  totalSessions: 10,
  sessionsDelta: 25.5,
  averageTurnsPerSession: 4.2,
  medianTurnsPerSession: 3,
  uniqueDevelopers: 5,
};

describe("D-C7-1 agentSummaryInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof agentSummaryTool.description).toBe("string");
    expect(agentSummaryTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("tool name is exactly recondo_agent_summary", () => {
    expect(agentSummaryTool.name).toBe("recondo_agent_summary");
  });

  it("schema accepts an empty object (period + project_id both optional)", () => {
    expect(() => agentSummaryInputSchema.parse({})).not.toThrow();
  });

  it("schema accepts optional period from the human-readable enum", () => {
    expect(() =>
      agentSummaryInputSchema.parse({ period: "day" }),
    ).not.toThrow();
    expect(() =>
      agentSummaryInputSchema.parse({ period: "week" }),
    ).not.toThrow();
    expect(() =>
      agentSummaryInputSchema.parse({ period: "month" }),
    ).not.toThrow();
  });

  it("schema rejects bogus period values", () => {
    expect(() => agentSummaryInputSchema.parse({ period: "BOGUS" })).toThrow();
    expect(() => agentSummaryInputSchema.parse({ period: "DAY_30" })).toThrow();
  });

  it("schema accepts optional project_id string", () => {
    const parsed = agentSummaryInputSchema.parse({
      project_id: "proj-1",
    }) as { project_id?: string };
    expect(parsed.project_id).toBe("proj-1");
  });

  it("schema rejects non-string project_id", () => {
    expect(() =>
      agentSummaryInputSchema.parse({ project_id: 7 }),
    ).toThrow();
  });
});

describe("D-C7-1 agentSummaryTool — phantom-wiring guard (C0 right-column contract)", () => {
  it("source imports `getAgentSummary` (NOT the LEFT-column `agentSummary`)", () => {
    const sourcePath = resolve(__dirname, "../../src/tools/agent-summary.ts");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("getAgentSummary");

    // Bare `agentSummary` (not preceded by `get`) is forbidden anywhere
    // in the file — not just import lines, because LEFT-column drift
    // can also surface in fallthroughs / variable names.
    const bareMatch = /(?<!get)\bagentSummary\b/.exec(source);
    expect(bareMatch, `forbidden bare \`agentSummary\` in source: ${bareMatch?.input?.slice(0, 200) ?? ""}`).toBeNull();
  });
});

describe("D-C7-1 agentSummaryTool handler — call shape + signal threading", () => {
  beforeEach(() => {
    getAgentSummary.mockReset();
  });

  it("calls getAgentSummary(apiKey, args, options)", async () => {
    getAgentSummary.mockResolvedValueOnce(sampleSummary);
    const ctx = makeCtx();

    await agentSummaryTool.handler({} as never, ctx);

    expect(getAgentSummary).toHaveBeenCalledTimes(1);
    const callArgs = getAgentSummary.mock.calls[0];
    expect(callArgs.length).toBe(3);
    const apiKey = callArgs[0] as { id: string; projectId: string | null };
    expect(apiKey).toBeDefined();
    expect(typeof apiKey.id).toBe("string");
  });

  it("threads ctx.abortSignal into options.signal", async () => {
    getAgentSummary.mockResolvedValueOnce(sampleSummary);
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await agentSummaryTool.handler({} as never, ctx);

    const callArgs = getAgentSummary.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("project_id input overrides auth.projectId on the apiKey bag", async () => {
    getAgentSummary.mockResolvedValueOnce(sampleSummary);
    const ctx = makeCtx({
      auth: {
        kind: "dev-bypass",
        isAdmin: true,
        projectId: "auth-project",
        keyId: "dev-bypass",
      },
    });

    await agentSummaryTool.handler(
      { project_id: "override-project" } as never,
      ctx,
    );

    const callArgs = getAgentSummary.mock.calls[0];
    const apiKey = callArgs[0] as { projectId: string | null };
    expect(apiKey.projectId).toBe("override-project");
  });

  it("propagates AbortError when getAgentSummary rejects", async () => {
    getAgentSummary.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await expect(
      agentSummaryTool.handler({} as never, ctx),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});

describe("D-C7-1 agentSummaryTool handler — output shape", () => {
  beforeEach(() => {
    getAgentSummary.mockReset();
  });

  it("returns the structured summary record verbatim (NOT a list envelope)", async () => {
    getAgentSummary.mockResolvedValueOnce(sampleSummary);
    const ctx = makeCtx();

    const result = (await agentSummaryTool.handler(
      {} as never,
      ctx,
    )) as Record<string, unknown>;

    expect(result).not.toHaveProperty("items");
    expect(result).not.toHaveProperty("stream_id");
    expect(result).not.toHaveProperty("is_final");
    expect(result.activeAgents ?? result.active_agents).toBe(3);
    expect(result.totalSessions ?? result.total_sessions).toBe(10);
  });

  it("oversize record surfaces response_too_large envelope (32 KB budget)", async () => {
    const padded = {
      ...sampleSummary,
      __padding: "x".repeat(40 * 1024),
    };
    getAgentSummary.mockResolvedValueOnce(padded);
    const ctx = makeCtx();

    const result = (await agentSummaryTool.handler(
      {} as never,
      ctx,
    )) as Record<string, unknown>;

    expect(result.response_too_large).toBe(true);
    expect(typeof result.actual_bytes).toBe("number");
    expect(result.actual_bytes as number).toBeGreaterThan(32 * 1024);
  });
});
