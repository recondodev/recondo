/**
 * D-C9-1 (unit) — `recondo_policies` tool: schema + handler.
 *
 * Contract pinned by C0 audit + Plan D §C9 (Task 21):
 *   - Tool name: `recondo_policies`.
 *   - Description >= 50 chars.
 *   - Input shape (data-layer signature: `listPolicies(apiKey, filter, options)`,
 *     filter is `PolicyFilter` (currently empty placeholder), options is
 *     `ListOptions`):
 *       include?:    array of "trigger_history" | "effective_scope"
 *       policy_id?:  string  (only honoured when include contains "trigger_history")
 *       project_id?: string
 *       limit?:      integer (>=1)
 *       offset?:     integer (>=0)
 *   - Handler:
 *       1. Calls `listPolicies(apiKey, filter, options)` exactly once.
 *       2. If `include` contains "trigger_history", calls
 *          `listPolicyTriggerHistory` ONCE PER returned policy and merges
 *          the trend points onto the policy row under a new key
 *          (e.g. `triggerHistory`).
 *       3. If `include` contains "effective_scope", derives an
 *          `effectiveScope` field per policy. The data-layer signature
 *          gives no canonical helper, so for v1 we accept the policy's
 *          existing `scope` string surfaced under `effectiveScope` (the
 *          implementer may also fold project_id into the derivation;
 *          tests below only assert the field is present and is a string).
 *       4. Returns the canonical 5-key list envelope.
 *   - `ctx.abortSignal` MUST be threaded into options.signal of EVERY
 *     data-layer call.
 *
 * Phantom-wiring guard (C0 right-column contract):
 *   - The production source MUST import the RIGHT-column name
 *     `listPolicies` from `@recondo/data`. The bare LEFT-column name
 *     `policies` MUST NOT appear in the import line. Substrings inside
 *     `listPolicies` / `listPolicyTriggerHistory` are fine — the regex
 *     only fires on a bare `policies` token.
 *
 * Data-layer signature reference (packages/recondo-data/src/policies.ts):
 *
 *   export async function listPolicies(
 *     apiKey: ApiKeyInfo,
 *     _filter: PolicyFilter = {},
 *     options: ListOptions = {},
 *   ): Promise<ListEnvelope<PolicyRow> & { total: number; limit: number; offset: number }>
 *
 *   export async function listPolicyTriggerHistory(
 *     _apiKey: ApiKeyInfo,
 *     args: { days?: number } = {},
 *     options: QueryOptions = {},
 *   ): Promise<ListEnvelope<PolicyTrendPoint>>
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const {
  listPolicies,
  listPolicyTriggerHistory,
  getPool,
  closePool,
  insertAuditLog,
} = vi.hoisted(() => ({
  listPolicies: vi.fn(),
  listPolicyTriggerHistory: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("@recondo/data", () => ({
  listPolicies,
  listPolicyTriggerHistory,
  getPool,
  closePool,
  insertAuditLog,
}));

import {
  policiesTool,
  policiesInputSchema,
} from "../../src/tools/policies.js";
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

const samplePolicy = {
  id: "pol-1",
  name: "block-secrets",
  type: "BLOCK",
  scope: "global",
  action: "deny",
  triggersMtd: 0,
  status: "ACTIVE",
};

function listEnvelope(items: unknown[]): Record<string, unknown> {
  return {
    items: items as never,
    next_offset: null,
    truncated: false,
    stream_id: null,
    is_final: true,
    total: items.length,
    limit: 50,
    offset: 0,
  };
}

function trendEnvelope(items: unknown[]): Record<string, unknown> {
  return {
    items: items as never,
    next_offset: null,
    truncated: false,
    stream_id: null,
    is_final: true,
  };
}

describe("D-C9-1 policiesInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof policiesTool.description).toBe("string");
    expect(policiesTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("tool name is exactly recondo_policies", () => {
    expect(policiesTool.name).toBe("recondo_policies");
  });

  it("schema accepts an empty object (all fields optional)", () => {
    expect(() => policiesInputSchema.parse({})).not.toThrow();
  });

  it("schema accepts the documented optional fields", () => {
    expect(() =>
      policiesInputSchema.parse({
        include: ["trigger_history", "effective_scope"],
        policy_id: "pol-1",
        project_id: "proj-1",
        limit: 10,
        offset: 0,
      }),
    ).not.toThrow();
  });

  it("schema accepts include with only trigger_history", () => {
    expect(() =>
      policiesInputSchema.parse({ include: ["trigger_history"] }),
    ).not.toThrow();
  });

  it("schema accepts include with only effective_scope", () => {
    expect(() =>
      policiesInputSchema.parse({ include: ["effective_scope"] }),
    ).not.toThrow();
  });

  it("schema rejects unknown include values", () => {
    expect(() =>
      policiesInputSchema.parse({ include: ["bogus"] as never }),
    ).toThrow();
  });

  it("schema rejects negative offset / non-positive limit", () => {
    expect(() => policiesInputSchema.parse({ offset: -1 })).toThrow();
    expect(() => policiesInputSchema.parse({ limit: 0 })).toThrow();
  });
});

describe("D-C9-1 policiesTool — phantom-wiring guard (C0 right-column contract)", () => {
  it("source imports `listPolicies` (NOT bare `policies`)", () => {
    const sourcePath = resolve(__dirname, "../../src/tools/policies.ts");
    const source = readFileSync(sourcePath, "utf8");
    // Right-column names MUST appear.
    expect(source).toContain("listPolicies");

    const importLines = source
      .split("\n")
      .filter((l) => l.includes("@recondo/data"));
    for (const line of importLines) {
      // Bare `policies` (LEFT-column resolver name) on the
      // `@recondo/data` import line is forbidden. `listPolicies`,
      // `listPolicyTriggerHistory`, `PolicyRow`, `PolicyFilter`,
      // `policiesTool` (variable name) are fine — the regex only fires
      // on a standalone `policies` token NOT preceded by `list` (which
      // would be a substring of `listPolicies`).
      const m = /(?<!list)\bpolicies\b/.exec(line);
      expect(
        m,
        `forbidden bare \`policies\` in import line: ${line}`,
      ).toBeNull();
    }
  });
});

describe("D-C9-1 policiesTool handler — call wiring (no include)", () => {
  beforeEach(() => {
    listPolicies.mockReset();
    listPolicyTriggerHistory.mockReset();
  });

  it("calls listPolicies exactly once", async () => {
    listPolicies.mockResolvedValueOnce(listEnvelope([samplePolicy]));
    const ctx = makeCtx();
    await policiesTool.handler({} as never, ctx);
    expect(listPolicies).toHaveBeenCalledTimes(1);
  });

  it("does NOT call listPolicyTriggerHistory when include is omitted", async () => {
    listPolicies.mockResolvedValueOnce(listEnvelope([samplePolicy]));
    const ctx = makeCtx();
    await policiesTool.handler({} as never, ctx);
    expect(listPolicyTriggerHistory).toHaveBeenCalledTimes(0);
  });

  it("threads ctx.abortSignal into options.signal of listPolicies", async () => {
    listPolicies.mockResolvedValueOnce(listEnvelope([]));
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await policiesTool.handler({} as never, ctx);
    const callArgs = listPolicies.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("project_id overrides auth.projectId on the apiKey bag", async () => {
    listPolicies.mockResolvedValueOnce(listEnvelope([]));
    const ctx = makeCtx({
      auth: {
        kind: "dev-bypass",
        isAdmin: true,
        projectId: "auth-project",
        keyId: "dev-bypass",
      },
    });
    await policiesTool.handler(
      { project_id: "override-project" } as never,
      ctx,
    );
    const callArgs = listPolicies.mock.calls[0];
    const apiKey = callArgs[0] as { projectId: string | null };
    expect(apiKey.projectId).toBe("override-project");
  });

  it("propagates AbortError when listPolicies rejects", async () => {
    listPolicies.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await expect(policiesTool.handler({} as never, ctx)).rejects.toThrow();
  });
});

describe("D-C9-1 policiesTool handler — include flag merging", () => {
  beforeEach(() => {
    listPolicies.mockReset();
    listPolicyTriggerHistory.mockReset();
  });

  it("calls listPolicyTriggerHistory once per policy when include contains trigger_history", async () => {
    const policyA = { ...samplePolicy, id: "pol-a" };
    const policyB = { ...samplePolicy, id: "pol-b" };
    listPolicies.mockResolvedValueOnce(listEnvelope([policyA, policyB]));
    listPolicyTriggerHistory.mockResolvedValue(
      trendEnvelope([{ label: "2026-05-01", value: 3 }]),
    );

    const ctx = makeCtx();
    await policiesTool.handler(
      { include: ["trigger_history"] } as never,
      ctx,
    );
    expect(listPolicyTriggerHistory).toHaveBeenCalledTimes(2);
  });

  it("merges trigger_history into each policy row under a documented key", async () => {
    listPolicies.mockResolvedValueOnce(listEnvelope([samplePolicy]));
    const trend = [{ label: "2026-05-01", value: 7 }];
    listPolicyTriggerHistory.mockResolvedValueOnce(trendEnvelope(trend));

    const ctx = makeCtx();
    const result = (await policiesTool.handler(
      { include: ["trigger_history"] } as never,
      ctx,
    )) as Record<string, unknown>;

    expect(Array.isArray(result.items)).toBe(true);
    const merged = (result.items as Array<Record<string, unknown>>)[0];
    // The implementer may pick `triggerHistory` (camelCase) OR
    // `trigger_history` (snake_case) for the merge key. Accept either —
    // the test asserts presence + value, not the exact key spelling.
    const merged_value = merged.triggerHistory ?? merged.trigger_history;
    expect(merged_value).toBeDefined();
    // The merge target must carry the trend shape (array OR an envelope).
    const trend_items = Array.isArray(merged_value)
      ? merged_value
      : (merged_value as Record<string, unknown> | undefined)?.items;
    expect(trend_items).toEqual(trend);
  });

  it("does NOT call listPolicyTriggerHistory when include is empty array", async () => {
    listPolicies.mockResolvedValueOnce(listEnvelope([samplePolicy]));
    const ctx = makeCtx();
    await policiesTool.handler({ include: [] } as never, ctx);
    expect(listPolicyTriggerHistory).toHaveBeenCalledTimes(0);
  });

  it("merges effective_scope onto each policy row when include contains effective_scope", async () => {
    listPolicies.mockResolvedValueOnce(listEnvelope([samplePolicy]));
    const ctx = makeCtx();
    const result = (await policiesTool.handler(
      { include: ["effective_scope"] } as never,
      ctx,
    )) as Record<string, unknown>;
    const merged = (result.items as Array<Record<string, unknown>>)[0];
    const eff = merged.effectiveScope ?? merged.effective_scope;
    expect(eff).toBeDefined();
  });

  it("supports both include flags simultaneously", async () => {
    listPolicies.mockResolvedValueOnce(listEnvelope([samplePolicy]));
    listPolicyTriggerHistory.mockResolvedValueOnce(
      trendEnvelope([{ label: "2026-05-01", value: 1 }]),
    );
    const ctx = makeCtx();
    const result = (await policiesTool.handler(
      { include: ["trigger_history", "effective_scope"] } as never,
      ctx,
    )) as Record<string, unknown>;
    const merged = (result.items as Array<Record<string, unknown>>)[0];
    expect(merged.triggerHistory ?? merged.trigger_history).toBeDefined();
    expect(merged.effectiveScope ?? merged.effective_scope).toBeDefined();
  });

  it("threads ctx.abortSignal into options.signal of listPolicyTriggerHistory", async () => {
    listPolicies.mockResolvedValueOnce(listEnvelope([samplePolicy]));
    listPolicyTriggerHistory.mockResolvedValueOnce(trendEnvelope([]));
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await policiesTool.handler(
      { include: ["trigger_history"] } as never,
      ctx,
    );
    const callArgs = listPolicyTriggerHistory.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });
});

describe("D-C9-1 policiesTool handler — output envelope", () => {
  beforeEach(() => {
    listPolicies.mockReset();
    listPolicyTriggerHistory.mockReset();
  });

  it("returns the canonical 5-key list envelope shape", async () => {
    listPolicies.mockResolvedValueOnce(listEnvelope([samplePolicy]));
    const ctx = makeCtx();
    const result = (await policiesTool.handler(
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
    expect(JSON.stringify(result)).toContain("pol-1");
  });
});
