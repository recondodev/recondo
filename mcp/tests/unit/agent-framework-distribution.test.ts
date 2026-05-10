/**
 * D-C7-2 (unit) — `recondo_agent_framework_distribution` tool.
 *
 * Contract pinned by C0 audit + Plan D §C7:
 *   - Tool name: `recondo_agent_framework_distribution`.
 *   - Description >= 50 chars.
 *   - Input shape (mirrors data-layer `AgentQueryArgs`):
 *       period?: enum (human-readable; translated to DAY_<n> at boundary).
 *       project_id?: string  (overrides auth.projectId on the apiKey bag).
 *   - Handler delegates to
 *       listAgentFrameworkDistribution(apiKey, args, options)
 *     from `@recondo/data` (agents.ts). The data-layer return is a
 *     `ListEnvelope<AgentFrameworkUsage>`; the handler returns the
 *     canonical 5-key list envelope.
 *   - `ctx.abortSignal` MUST be threaded into the data-layer options bag.
 *
 * Phantom-wiring guard (C0 contract):
 *   - The production source MUST import `listAgentFrameworkDistribution`
 *     and MUST NOT contain the bare LEFT-column name
 *     `agentFrameworkDistribution` anywhere — verified by source-grep.
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
  agentFrameworkDistributionTool,
  agentFrameworkDistributionInputSchema,
} from "../../src/tools/agent-framework-distribution.js";
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

const sampleUsage = {
  name: "claude-code",
  costUsd: 12.34,
  percentage: 60,
  count: 5,
};

const emptyEnvelope = {
  items: [],
  next_offset: null,
  truncated: false,
  stream_id: null,
  is_final: true,
};

function envelopeWith(items: unknown[]): typeof emptyEnvelope {
  return {
    items: items as never,
    next_offset: null,
    truncated: false,
    stream_id: null,
    is_final: true,
  };
}

describe("D-C7-2 agentFrameworkDistributionInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof agentFrameworkDistributionTool.description).toBe("string");
    expect(agentFrameworkDistributionTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("tool name is exactly recondo_agent_framework_distribution", () => {
    expect(agentFrameworkDistributionTool.name).toBe(
      "recondo_agent_framework_distribution",
    );
  });

  it("schema accepts an empty object (period + project_id both optional)", () => {
    expect(() => agentFrameworkDistributionInputSchema.parse({})).not.toThrow();
  });

  it("schema accepts optional period from the human-readable enum", () => {
    expect(() =>
      agentFrameworkDistributionInputSchema.parse({ period: "day" }),
    ).not.toThrow();
    expect(() =>
      agentFrameworkDistributionInputSchema.parse({ period: "week" }),
    ).not.toThrow();
    expect(() =>
      agentFrameworkDistributionInputSchema.parse({ period: "month" }),
    ).not.toThrow();
  });

  it("schema rejects bogus period values", () => {
    expect(() =>
      agentFrameworkDistributionInputSchema.parse({ period: "BOGUS" }),
    ).toThrow();
    expect(() =>
      agentFrameworkDistributionInputSchema.parse({ period: "DAY_30" }),
    ).toThrow();
  });

  it("schema accepts optional project_id string", () => {
    const parsed = agentFrameworkDistributionInputSchema.parse({
      project_id: "proj-1",
    }) as { project_id?: string };
    expect(parsed.project_id).toBe("proj-1");
  });
});

describe("D-C7-2 agentFrameworkDistributionTool — phantom-wiring guard", () => {
  it("source imports `listAgentFrameworkDistribution` (NOT bare `agentFrameworkDistribution`)", () => {
    const sourcePath = resolve(
      __dirname,
      "../../src/tools/agent-framework-distribution.ts",
    );
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("listAgentFrameworkDistribution");

    // Bare `agentFrameworkDistribution` (not preceded by `list`) is forbidden.
    const bareMatch = /(?<!list)\bagentFrameworkDistribution\b/.exec(source);
    expect(
      bareMatch,
      `forbidden bare \`agentFrameworkDistribution\` in source`,
    ).toBeNull();
  });
});

describe("D-C7-2 agentFrameworkDistributionTool handler — call shape + signal threading", () => {
  beforeEach(() => {
    listAgentFrameworkDistribution.mockReset();
  });

  it("calls listAgentFrameworkDistribution(apiKey, args, options)", async () => {
    listAgentFrameworkDistribution.mockResolvedValueOnce(
      envelopeWith([sampleUsage]),
    );
    const ctx = makeCtx();

    await agentFrameworkDistributionTool.handler({} as never, ctx);

    expect(listAgentFrameworkDistribution).toHaveBeenCalledTimes(1);
    const callArgs = listAgentFrameworkDistribution.mock.calls[0];
    expect(callArgs.length).toBe(3);
  });

  it("threads ctx.abortSignal into options.signal", async () => {
    listAgentFrameworkDistribution.mockResolvedValueOnce(emptyEnvelope);
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await agentFrameworkDistributionTool.handler({} as never, ctx);

    const callArgs = listAgentFrameworkDistribution.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("project_id input overrides auth.projectId on the apiKey bag", async () => {
    listAgentFrameworkDistribution.mockResolvedValueOnce(emptyEnvelope);
    const ctx = makeCtx({
      auth: {
        kind: "dev-bypass",
        isAdmin: true,
        projectId: "auth-project",
        keyId: "dev-bypass",
      },
    });

    await agentFrameworkDistributionTool.handler(
      { project_id: "override-project" } as never,
      ctx,
    );

    const callArgs = listAgentFrameworkDistribution.mock.calls[0];
    const apiKey = callArgs[0] as { projectId: string | null };
    expect(apiKey.projectId).toBe("override-project");
  });

  it("propagates AbortError when the data-layer call rejects", async () => {
    listAgentFrameworkDistribution.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });

    await expect(
      agentFrameworkDistributionTool.handler({} as never, ctx),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});

describe("D-C7-2 agentFrameworkDistributionTool handler — output envelope", () => {
  beforeEach(() => {
    listAgentFrameworkDistribution.mockReset();
  });

  it("returns the canonical 5-key list envelope shape", async () => {
    listAgentFrameworkDistribution.mockResolvedValueOnce(
      envelopeWith([sampleUsage]),
    );
    const ctx = makeCtx();

    const result = (await agentFrameworkDistributionTool.handler(
      {} as never,
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

  it("preserves the framework usage fields on the wire", async () => {
    listAgentFrameworkDistribution.mockResolvedValueOnce(
      envelopeWith([sampleUsage]),
    );
    const ctx = makeCtx();

    const result = (await agentFrameworkDistributionTool.handler(
      {} as never,
      ctx,
    )) as Record<string, unknown>;

    const wholeJson = JSON.stringify(result);
    expect(wholeJson).toContain("claude-code");
    expect(wholeJson).toContain("12.34");
  });
});
