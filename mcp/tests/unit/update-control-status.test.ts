/**
 * D-C10-2 (unit) — `recondo_update_control_status` action tool.
 *
 * Contract:
 *   - Tool name: `recondo_update_control_status`.
 *   - Description >= 50 chars AND includes the verbatim INJECTION_WARNING.
 *   - destructive: false.
 *   - Input shape (data-layer signature: `updateControlStatus(apiKey, input, options)`,
 *     where input is `UpdateControlInput { controlId, status, reason }`):
 *       control_id: string
 *       new_status: string  (mapped to `status` on the data-layer input)
 *       reason?:    string  (data-layer enforces required+non-empty; tool may default to "")
 *       project_id?: string
 *
 * Data-layer signature reference (packages/recondo-data/src/compliance.ts:331):
 *
 *   export async function updateControlStatus(
 *     apiKey: ApiKeyInfo,
 *     input: UpdateControlInput,    // { controlId, status, reason }
 *     options: QueryOptions = {},
 *   ): Promise<UpdateControlPayload>
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { updateControlStatus, getPool, closePool, insertAuditLog } = vi.hoisted(
  () => ({
    updateControlStatus: vi.fn(),
    getPool: vi.fn(),
    closePool: vi.fn(),
    insertAuditLog: vi.fn(),
  }),
);

vi.mock("@recondo/data", () => ({
  updateControlStatus,
  getPool,
  closePool,
  insertAuditLog,
}));

import {
  updateControlStatusTool,
  updateControlStatusInputSchema,
} from "../../src/tools/update-control-status.js";
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

const samplePayload = {
  control: {
    id: "ctrl-1",
    frameworkId: "soc2",
    controlId: "CC1.1",
    description: "control desc",
    status: "PASSING",
  },
  errors: [],
};

describe("D-C10-2 updateControlStatusTool — metadata", () => {
  it("tool name is recondo_update_control_status", () => {
    expect(updateControlStatusTool.name).toBe("recondo_update_control_status");
  });

  it("description is >= 50 chars and contains INJECTION_WARNING", () => {
    expect(updateControlStatusTool.description.length).toBeGreaterThanOrEqual(50);
    expect(updateControlStatusTool.description).toContain(INJECTION_WARNING);
  });

  it("destructive flag is false", () => {
    expect(updateControlStatusTool.destructive).toBe(false);
  });
});

describe("D-C10-2 updateControlStatusInputSchema", () => {
  it("accepts the documented required fields", () => {
    expect(() =>
      updateControlStatusInputSchema.parse({
        control_id: "ctrl-1",
        new_status: "PASSING",
        reason: "remediation complete",
      }),
    ).not.toThrow();
  });

  it("rejects missing control_id", () => {
    expect(() =>
      updateControlStatusInputSchema.parse({
        new_status: "PASSING",
      } as never),
    ).toThrow();
  });

  it("rejects missing new_status", () => {
    expect(() =>
      updateControlStatusInputSchema.parse({
        control_id: "ctrl-1",
      } as never),
    ).toThrow();
  });
});

describe("D-C10-2 updateControlStatusTool handler", () => {
  beforeEach(() => {
    updateControlStatus.mockReset();
  });

  it("calls updateControlStatus exactly once", async () => {
    updateControlStatus.mockResolvedValueOnce(samplePayload);
    const ctx = makeCtx();
    await updateControlStatusTool.handler(
      {
        control_id: "ctrl-1",
        new_status: "PASSING",
        reason: "fixed",
      } as never,
      ctx,
    );
    expect(updateControlStatus).toHaveBeenCalledTimes(1);
  });

  it("maps tool input → data-layer input (control_id → controlId, new_status → status)", async () => {
    updateControlStatus.mockResolvedValueOnce(samplePayload);
    const ctx = makeCtx();
    await updateControlStatusTool.handler(
      {
        control_id: "ctrl-42",
        new_status: "FAILING",
        reason: "evidence missing",
      } as never,
      ctx,
    );
    const [, input] = updateControlStatus.mock.calls[0];
    const i = input as { controlId: string; status: string; reason: string };
    expect(i.controlId).toBe("ctrl-42");
    expect(i.status).toBe("FAILING");
    expect(i.reason).toBe("evidence missing");
  });

  it("threads ctx.abortSignal into options.signal", async () => {
    updateControlStatus.mockResolvedValueOnce(samplePayload);
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await updateControlStatusTool.handler(
      {
        control_id: "ctrl-1",
        new_status: "PASSING",
        reason: "ok",
      } as never,
      ctx,
    );
    const callArgs = updateControlStatus.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("returns the data-layer payload verbatim", async () => {
    updateControlStatus.mockResolvedValueOnce(samplePayload);
    const ctx = makeCtx();
    const result = await updateControlStatusTool.handler(
      {
        control_id: "ctrl-1",
        new_status: "PASSING",
        reason: "ok",
      } as never,
      ctx,
    );
    expect(result).toEqual(samplePayload);
  });
});

describe("D-C10-2 updateControlStatusTool — phantom-wiring guard", () => {
  it("source imports `updateControlStatus` from @recondo/data", () => {
    const sourcePath = resolve(
      __dirname,
      "../../src/tools/update-control-status.ts",
    );
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("updateControlStatus");
  });
});
