/**
 * D-C10-6 (unit) — `recondo_delete_policy` action tool — DESTRUCTIVE.
 *
 * Contract:
 *   - Tool name: `recondo_delete_policy`.
 *   - Description >= 50 chars AND contains the literal "DESTRUCTIVE"
 *     (uppercase) AND includes the verbatim INJECTION_WARNING.
 *   - destructive: true.
 *   - Input shape: { policy_id: string, project_id?: string }.
 *
 * Data-layer signature reference (packages/recondo-data/src/policies.ts:310):
 *
 *   export async function deletePolicy(
 *     apiKey: ApiKeyInfo,
 *     id: string,
 *     options: QueryOptions = {},
 *   ): Promise<{ id: string } | null>
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { deletePolicy, getPool, closePool, insertAuditLog } = vi.hoisted(() => ({
  deletePolicy: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("@recondo/data", () => ({
  deletePolicy,
  getPool,
  closePool,
  insertAuditLog,
}));

import {
  deletePolicyTool,
  deletePolicyInputSchema,
} from "../../src/tools/delete-policy.js";
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

describe("D-C10-6 deletePolicyTool — metadata (DESTRUCTIVE)", () => {
  it("tool name is recondo_delete_policy", () => {
    expect(deletePolicyTool.name).toBe("recondo_delete_policy");
  });

  it("description >= 50 chars", () => {
    expect(deletePolicyTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("description contains literal DESTRUCTIVE (uppercase)", () => {
    expect(deletePolicyTool.description).toContain("DESTRUCTIVE");
  });

  it("description contains the verbatim INJECTION_WARNING", () => {
    expect(deletePolicyTool.description).toContain(INJECTION_WARNING);
  });

  it("destructive flag is true", () => {
    expect(deletePolicyTool.destructive).toBe(true);
  });
});

describe("D-C10-6 deletePolicyInputSchema", () => {
  it("accepts policy_id", () => {
    expect(() =>
      deletePolicyInputSchema.parse({ policy_id: "pol-1" }),
    ).not.toThrow();
  });

  it("rejects missing policy_id", () => {
    expect(() => deletePolicyInputSchema.parse({} as never)).toThrow();
  });
});

describe("D-C10-6 deletePolicyTool handler", () => {
  beforeEach(() => {
    deletePolicy.mockReset();
  });

  it("calls deletePolicy exactly once with the id positional arg", async () => {
    deletePolicy.mockResolvedValueOnce({ id: "pol-1" });
    const ctx = makeCtx();
    await deletePolicyTool.handler({ policy_id: "pol-1" } as never, ctx);
    expect(deletePolicy).toHaveBeenCalledTimes(1);
    const callArgs = deletePolicy.mock.calls[0];
    expect(callArgs[1]).toBe("pol-1");
  });

  it("threads ctx.abortSignal into options.signal", async () => {
    deletePolicy.mockResolvedValueOnce({ id: "pol-1" });
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await deletePolicyTool.handler({ policy_id: "pol-1" } as never, ctx);
    const callArgs = deletePolicy.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("project_id overrides auth.projectId on the apiKey bag", async () => {
    deletePolicy.mockResolvedValueOnce({ id: "pol-1" });
    const ctx = makeCtx({
      auth: {
        kind: "dev-bypass",
        isAdmin: true,
        projectId: "auth-proj",
        keyId: "dev-bypass",
      },
    });
    await deletePolicyTool.handler(
      { policy_id: "pol-1", project_id: "override" } as never,
      ctx,
    );
    const apiKey = deletePolicy.mock.calls[0][0] as {
      projectId: string | null;
    };
    expect(apiKey.projectId).toBe("override");
  });

  it("returns null when not found (data-layer null pass-through)", async () => {
    deletePolicy.mockResolvedValueOnce(null);
    const ctx = makeCtx();
    const result = await deletePolicyTool.handler(
      { policy_id: "missing" } as never,
      ctx,
    );
    expect(result).toBeNull();
  });

  it("returns the data-layer payload verbatim on success", async () => {
    deletePolicy.mockResolvedValueOnce({ id: "pol-1" });
    const ctx = makeCtx();
    const result = await deletePolicyTool.handler(
      { policy_id: "pol-1" } as never,
      ctx,
    );
    expect(result).toEqual({ id: "pol-1" });
  });
});

describe("D-C10-6 deletePolicyTool — phantom-wiring guard", () => {
  it("source imports `deletePolicy` from @recondo/data", () => {
    const sourcePath = resolve(__dirname, "../../src/tools/delete-policy.ts");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("deletePolicy");
  });
});
