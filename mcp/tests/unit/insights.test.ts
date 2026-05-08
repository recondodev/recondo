import { describe, it, expect, vi, beforeEach } from "vitest";

const { getInsights } = vi.hoisted(() => ({
  getInsights: vi.fn(),
}));

vi.mock("@recondo/data", () => ({
  getInsights,
}));

import { insightsInputSchema, insightsTool } from "../../src/tools/insights.js";
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

describe("D-HARD recondo_insights tool", () => {
  beforeEach(() => {
    getInsights.mockReset();
  });

  it("has the expected name and a useful description", () => {
    expect(insightsTool.name).toBe("recondo_insights");
    expect(insightsTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("schema accepts project_id and ISO since", () => {
    expect(() =>
      insightsInputSchema.parse({
        project_id: "alpha",
        since: "2026-05-07T00:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it("schema rejects malformed since", () => {
    expect(() => insightsInputSchema.parse({ since: "yesterday" })).toThrow(
      /Invalid/,
    );
  });

  it("threads auth, args, and AbortSignal to getInsights", async () => {
    const ctrl = new AbortController();
    const ctx = makeCtx({ abortSignal: ctrl.signal });
    getInsights.mockResolvedValueOnce({ insights: [] });

    const result = await insightsTool.handler(
      { project_id: "alpha", since: "2026-05-07T00:00:00.000Z" } as never,
      ctx,
    );

    expect(result).toEqual({ insights: [] });
    expect(getInsights).toHaveBeenCalledTimes(1);
    expect(getInsights.mock.calls[0][0]).toMatchObject({
      id: "dev-bypass",
      projectId: null,
    });
    expect(getInsights.mock.calls[0][1]).toEqual({
      projectId: "alpha",
      since: "2026-05-07T00:00:00.000Z",
    });
    expect(getInsights.mock.calls[0][2]).toEqual({ signal: ctrl.signal });
  });
});
