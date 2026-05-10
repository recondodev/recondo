import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  withActionAuditLog,
  withAuditLog,
} from "../../src/registry/audit-wrap.js";
import type {
  ActionTool,
  ReadTool,
  ToolContext,
} from "../../src/registry/types.js";

function makeCtx(signal?: AbortSignal) {
  return {
    abortSignal: signal ?? new AbortController().signal,
    auth: { keyId: "key-1", projectId: "project-1", isAdmin: false },
    clientInfo: { name: "unit-client" },
    audit: { write: vi.fn().mockResolvedValue(undefined) },
  } satisfies ToolContext;
}

const inputShape = { id: z.string() };
const inputSchema = z.object(inputShape);

describe("Group A audit wrappers", () => {
  it("writes success outcome after a read tool resolves", async () => {
    const tool: ReadTool<{ id: string }, unknown> = {
      name: "recondo_unit_read",
      description: "unit read tool",
      inputShape,
      inputSchema,
      handler: vi.fn().mockResolvedValue({ ok: true }),
    };
    const ctx = makeCtx();

    await expect(withAuditLog(tool)({ id: "abc" }, ctx)).resolves.toEqual({
      ok: true,
    });

    expect(ctx.audit.write).toHaveBeenCalledTimes(1);
    expect(ctx.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "recondo_unit_read",
        arguments: { id: "abc" },
        responseBytes: JSON.stringify({ ok: true }).length,
        clientName: "unit-client",
        keyId: "key-1",
        outcome: "success",
        errorMessage: null,
      }),
      { signal: ctx.abortSignal },
    );
  });

  it("writes error outcome in a finally path and then propagates the read-tool error", async () => {
    const err = new Error("synthetic read failure");
    const tool: ReadTool<{ id: string }, unknown> = {
      name: "recondo_unit_read",
      description: "unit read tool",
      inputShape,
      inputSchema,
      handler: vi.fn().mockRejectedValue(err),
    };
    const ctx = makeCtx();

    await expect(withAuditLog(tool)({ id: "abc" }, ctx)).rejects.toThrow(
      /synthetic read failure/,
    );

    expect(ctx.audit.write).toHaveBeenCalledTimes(1);
    expect(ctx.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "recondo_unit_read",
        arguments: { id: "abc" },
        responseBytes: 0,
        outcome: "error",
        errorMessage: "synthetic read failure",
      }),
      { signal: ctx.abortSignal },
    );
  });

  it("records aborted outcome for AbortError before propagating", async () => {
    const ac = new AbortController();
    ac.abort();
    const tool: ReadTool<{ id: string }, unknown> = {
      name: "recondo_unit_read",
      description: "unit read tool",
      inputShape,
      inputSchema,
      handler: vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")),
    };
    const ctx = makeCtx(ac.signal);

    await expect(withAuditLog(tool)({ id: "abc" }, ctx)).rejects.toThrow(
      /aborted/,
    );

    expect(ctx.audit.write).toHaveBeenCalledTimes(1);
    expect(ctx.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        responseBytes: 0,
        outcome: "aborted",
        errorMessage: "AbortError",
      }),
      undefined,
    );
  });

  it("applies the same finally semantics to action tools", async () => {
    const tool: ActionTool<{ id: string }, unknown> = {
      name: "recondo_unit_action",
      description: "unit action tool",
      inputShape,
      inputSchema,
      destructive: false,
      handler: vi.fn().mockRejectedValue(new Error("action failed")),
    };
    const ctx = makeCtx();

    await expect(withActionAuditLog(tool)({ id: "abc" }, ctx)).rejects.toThrow(
      /action failed/,
    );

    expect(ctx.audit.write).toHaveBeenCalledTimes(1);
    expect(ctx.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "recondo_unit_action",
        responseBytes: 0,
        outcome: "error",
        errorMessage: "action failed",
      }),
      { signal: ctx.abortSignal },
    );
  });
});
