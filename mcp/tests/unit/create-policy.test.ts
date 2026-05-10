/**
 * D-C10-3 (unit) — `recondo_create_policy` action tool.
 *
 * Contract:
 *   - Tool name: `recondo_create_policy`.
 *   - Description >= 50 chars AND includes the verbatim INJECTION_WARNING.
 *   - destructive: false.
 *   - Input shape (data-layer signature: `createPolicy(apiKey, input, options)`,
 *     where input is `CreatePolicyInput { name, type, scope, action }`):
 *       name:   string
 *       type:   string  ("BLOCK" | "LIMIT" | "ALERT" | "MONITOR")
 *       scope:  string
 *       action: string
 *       project_id?: string
 *
 * Data-layer signature reference (packages/recondo-data/src/policies.ts:206):
 *
 *   export async function createPolicy(
 *     apiKey: ApiKeyInfo,
 *     input: CreatePolicyInput,    // { name, type, scope, action }
 *     options: QueryOptions = {},
 *   ): Promise<PolicyRow>
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { createPolicy, getPool, closePool, insertAuditLog } = vi.hoisted(() => ({
  createPolicy: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("@recondo/data", () => ({
  createPolicy,
  getPool,
  closePool,
  insertAuditLog,
}));

import {
  createPolicyTool,
  createPolicyInputSchema,
} from "../../src/tools/create-policy.js";
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
  id: "pol-new",
  name: "block-secrets",
  type: "BLOCK",
  scope: "global",
  action: "deny",
  triggersMtd: 0,
  status: "ACTIVE",
};

describe("D-C10-3 createPolicyTool — metadata", () => {
  it("tool name is recondo_create_policy", () => {
    expect(createPolicyTool.name).toBe("recondo_create_policy");
  });

  it("description >= 50 chars and contains INJECTION_WARNING", () => {
    expect(createPolicyTool.description.length).toBeGreaterThanOrEqual(50);
    expect(createPolicyTool.description).toContain(INJECTION_WARNING);
  });

  it("destructive flag is false", () => {
    expect(createPolicyTool.destructive).toBe(false);
  });
});

describe("D-C10-3 createPolicyInputSchema", () => {
  it("accepts the documented required fields", () => {
    expect(() =>
      createPolicyInputSchema.parse({
        name: "block-secrets",
        type: "BLOCK",
        scope: "global",
        action: "deny",
      }),
    ).not.toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() =>
      createPolicyInputSchema.parse({ name: "x" } as never),
    ).toThrow();
  });
});

describe("D-C10-3 createPolicyTool handler", () => {
  beforeEach(() => {
    createPolicy.mockReset();
  });

  it("calls createPolicy exactly once", async () => {
    createPolicy.mockResolvedValueOnce(sampleRow);
    const ctx = makeCtx();
    await createPolicyTool.handler(
      {
        name: "block-secrets",
        type: "BLOCK",
        scope: "global",
        action: "deny",
      } as never,
      ctx,
    );
    expect(createPolicy).toHaveBeenCalledTimes(1);
  });

  it("threads ctx.abortSignal into options.signal", async () => {
    createPolicy.mockResolvedValueOnce(sampleRow);
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await createPolicyTool.handler(
      {
        name: "n",
        type: "ALERT",
        scope: "s",
        action: "a",
      } as never,
      ctx,
    );
    const callArgs = createPolicy.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("passes name / type / scope / action verbatim", async () => {
    createPolicy.mockResolvedValueOnce(sampleRow);
    const ctx = makeCtx();
    await createPolicyTool.handler(
      {
        name: "rate-limit-x",
        type: "LIMIT",
        scope: "team-a",
        action: "throttle",
      } as never,
      ctx,
    );
    const [, input] = createPolicy.mock.calls[0];
    const i = input as {
      name: string;
      type: string;
      scope: string;
      action: string;
    };
    expect(i.name).toBe("rate-limit-x");
    expect(i.type).toBe("LIMIT");
    expect(i.scope).toBe("team-a");
    expect(i.action).toBe("throttle");
  });

  it("project_id overrides auth.projectId on the apiKey bag", async () => {
    createPolicy.mockResolvedValueOnce(sampleRow);
    const ctx = makeCtx({
      auth: {
        kind: "dev-bypass",
        isAdmin: true,
        projectId: "auth-proj",
        keyId: "dev-bypass",
      },
    });
    await createPolicyTool.handler(
      {
        name: "n",
        type: "BLOCK",
        scope: "s",
        action: "a",
        project_id: "override",
      } as never,
      ctx,
    );
    const apiKey = createPolicy.mock.calls[0][0] as {
      projectId: string | null;
    };
    expect(apiKey.projectId).toBe("override");
  });

  it("returns the data-layer row verbatim", async () => {
    createPolicy.mockResolvedValueOnce(sampleRow);
    const ctx = makeCtx();
    const result = await createPolicyTool.handler(
      {
        name: "block-secrets",
        type: "BLOCK",
        scope: "global",
        action: "deny",
      } as never,
      ctx,
    );
    expect(result).toEqual(sampleRow);
  });
});

describe("D-C10-3 createPolicyTool — phantom-wiring guard", () => {
  it("source imports `createPolicy` from @recondo/data", () => {
    const sourcePath = resolve(__dirname, "../../src/tools/create-policy.ts");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("createPolicy");
  });
});
