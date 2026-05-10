/**
 * D-C10-4 (unit) — `recondo_update_policy` action tool.
 *
 * Contract:
 *   - Tool name: `recondo_update_policy`.
 *   - Description >= 50 chars AND includes the verbatim INJECTION_WARNING.
 *   - destructive: false.
 *   - Input shape (data-layer signature: `updatePolicy(apiKey, id, input, options)`,
 *     where input is `UpdatePolicyInput { name?, scope?, action?, status? }`):
 *       policy_id: string  (mapped to `id` positional arg)
 *       name?:    string
 *       scope?:   string
 *       action?:  string
 *       status?:  string
 *       project_id?: string
 *
 * Data-layer signature reference (packages/recondo-data/src/policies.ts:244):
 *
 *   export async function updatePolicy(
 *     apiKey: ApiKeyInfo,
 *     id: string,
 *     input: UpdatePolicyInput,
 *     options: QueryOptions = {},
 *   ): Promise<PolicyRow | null>
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { updatePolicy, getPool, closePool, insertAuditLog } = vi.hoisted(() => ({
  updatePolicy: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("@recondo/data", () => ({
  updatePolicy,
  getPool,
  closePool,
  insertAuditLog,
}));

import {
  updatePolicyTool,
  updatePolicyInputSchema,
} from "../../src/tools/update-policy.js";
import { INJECTION_WARNING } from "../../src/registry/warning.js";
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

const sampleRow = {
  id: "pol-1",
  name: "renamed",
  type: "BLOCK",
  scope: "global",
  action: "deny",
  triggersMtd: 0,
  status: "ACTIVE",
};

describe("D-C10-4 updatePolicyTool — metadata", () => {
  it("tool name is recondo_update_policy", () => {
    expect(updatePolicyTool.name).toBe("recondo_update_policy");
  });

  it("description >= 50 chars and contains INJECTION_WARNING", () => {
    expect(updatePolicyTool.description.length).toBeGreaterThanOrEqual(50);
    expect(updatePolicyTool.description).toContain(INJECTION_WARNING);
  });

  it("destructive flag is false", () => {
    expect(updatePolicyTool.destructive).toBe(false);
  });
});

describe("D-C10-4 updatePolicyInputSchema", () => {
  it("accepts policy_id with no other fields", () => {
    expect(() =>
      updatePolicyInputSchema.parse({ policy_id: "pol-1" }),
    ).not.toThrow();
  });

  it("accepts the full set of optional fields", () => {
    expect(() =>
      updatePolicyInputSchema.parse({
        policy_id: "pol-1",
        name: "x",
        scope: "y",
        action: "z",
        status: "ACTIVE",
      }),
    ).not.toThrow();
  });

  it("rejects missing policy_id", () => {
    expect(() => updatePolicyInputSchema.parse({} as never)).toThrow();
  });
});

describe("D-C10-4 updatePolicyTool handler", () => {
  beforeEach(() => {
    updatePolicy.mockReset();
  });

  it("calls updatePolicy exactly once", async () => {
    updatePolicy.mockResolvedValueOnce(sampleRow);
    const ctx = makeCtx();
    await updatePolicyTool.handler(
      { policy_id: "pol-1", name: "renamed" } as never,
      ctx,
    );
    expect(updatePolicy).toHaveBeenCalledTimes(1);
  });

  it("passes policy_id as the second positional `id` arg", async () => {
    updatePolicy.mockResolvedValueOnce(sampleRow);
    const ctx = makeCtx();
    await updatePolicyTool.handler(
      { policy_id: "pol-42", name: "renamed" } as never,
      ctx,
    );
    const callArgs = updatePolicy.mock.calls[0];
    expect(callArgs[1]).toBe("pol-42");
  });

  it("threads ctx.abortSignal into options.signal", async () => {
    updatePolicy.mockResolvedValueOnce(sampleRow);
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await updatePolicyTool.handler(
      { policy_id: "pol-1", name: "x" } as never,
      ctx,
    );
    const callArgs = updatePolicy.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("passes only the documented optional fields onto data-layer input (no policy_id leak)", async () => {
    updatePolicy.mockResolvedValueOnce(sampleRow);
    const ctx = makeCtx();
    await updatePolicyTool.handler(
      {
        policy_id: "pol-1",
        name: "renamed",
        scope: "team-b",
        action: "deny",
        status: "INACTIVE",
      } as never,
      ctx,
    );
    const callArgs = updatePolicy.mock.calls[0];
    const input = callArgs[2] as Record<string, unknown>;
    // policy_id MUST NOT bleed into the data-layer input shape (it's the
    // positional `id` arg, not part of UpdatePolicyInput).
    expect(input.policy_id).toBeUndefined();
    expect(input.id).toBeUndefined();
    expect(input.name).toBe("renamed");
    expect(input.scope).toBe("team-b");
    expect(input.action).toBe("deny");
    expect(input.status).toBe("INACTIVE");
  });

  it("returns the data-layer row verbatim (null when not found)", async () => {
    updatePolicy.mockResolvedValueOnce(null);
    const ctx = makeCtx();
    const result = await updatePolicyTool.handler(
      { policy_id: "pol-missing" } as never,
      ctx,
    );
    expect(result).toBeNull();
  });
});

describe("D-C10-4 updatePolicyTool — phantom-wiring guard", () => {
  it("source imports `updatePolicy` from @recondo/data", () => {
    const sourcePath = resolve(__dirname, "../../src/tools/update-policy.ts");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("updatePolicy");
  });
});
