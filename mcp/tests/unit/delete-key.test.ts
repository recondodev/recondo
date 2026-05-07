/**
 * D-C10-7 (unit) — `recondo_delete_key` action tool → `revokeApiKey`.
 *
 * DESTRUCTIVE.
 *
 * Contract:
 *   - Tool name: `recondo_delete_key`. (LEFT-column historical name kept
 *     for the MCP tool surface; data-layer rename to `revokeApiKey` is the
 *     RIGHT-column binding.)
 *   - Description >= 50 chars AND contains "DESTRUCTIVE" (uppercase) AND
 *     includes the verbatim INJECTION_WARNING.
 *   - destructive: true.
 *   - Input shape: { key_id: string, project_id?: string }.
 *
 * Phantom-wiring guard (C0 right-column contract):
 *   - The production source MUST import the RIGHT-column name
 *     `revokeApiKey` from `@recondo/data`. The bare LEFT-column name
 *     `deleteKey` MUST NOT appear in the import line.
 *
 * Data-layer signature reference (packages/recondo-data/src/keys.ts:186):
 *
 *   export async function revokeApiKey(
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

const { revokeApiKey, getPool, closePool, insertAuditLog } = vi.hoisted(() => ({
  revokeApiKey: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("@recondo/data", () => ({
  revokeApiKey,
  getPool,
  closePool,
  insertAuditLog,
}));

import {
  deleteKeyTool,
  deleteKeyInputSchema,
} from "../../src/tools/delete-key.js";
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

describe("D-C10-7 deleteKeyTool — metadata (DESTRUCTIVE)", () => {
  it("tool name is recondo_delete_key", () => {
    expect(deleteKeyTool.name).toBe("recondo_delete_key");
  });

  it("description >= 50 chars", () => {
    expect(deleteKeyTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("description contains literal DESTRUCTIVE (uppercase)", () => {
    expect(deleteKeyTool.description).toContain("DESTRUCTIVE");
  });

  it("description contains the verbatim INJECTION_WARNING", () => {
    expect(deleteKeyTool.description).toContain(INJECTION_WARNING);
  });

  it("destructive flag is true", () => {
    expect(deleteKeyTool.destructive).toBe(true);
  });
});

describe("D-C10-7 deleteKeyInputSchema", () => {
  it("accepts key_id", () => {
    expect(() =>
      deleteKeyInputSchema.parse({ key_id: "key-1" }),
    ).not.toThrow();
  });

  it("rejects missing key_id", () => {
    expect(() => deleteKeyInputSchema.parse({} as never)).toThrow();
  });
});

describe("D-C10-7 deleteKeyTool handler", () => {
  beforeEach(() => {
    revokeApiKey.mockReset();
  });

  it("calls revokeApiKey exactly once (RIGHT-column binding) with id positional", async () => {
    revokeApiKey.mockResolvedValueOnce({ id: "key-1" });
    const ctx = makeCtx();
    await deleteKeyTool.handler({ key_id: "key-1" } as never, ctx);
    expect(revokeApiKey).toHaveBeenCalledTimes(1);
    const callArgs = revokeApiKey.mock.calls[0];
    expect(callArgs[1]).toBe("key-1");
  });

  it("threads ctx.abortSignal into options.signal", async () => {
    revokeApiKey.mockResolvedValueOnce({ id: "key-1" });
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await deleteKeyTool.handler({ key_id: "key-1" } as never, ctx);
    const callArgs = revokeApiKey.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("project_id overrides auth.projectId on the apiKey bag", async () => {
    revokeApiKey.mockResolvedValueOnce({ id: "key-1" });
    const ctx = makeCtx({
      auth: {
        kind: "dev-bypass",
        isAdmin: true,
        projectId: "auth-proj",
        keyId: "dev-bypass",
      },
    });
    await deleteKeyTool.handler(
      { key_id: "key-1", project_id: "override" } as never,
      ctx,
    );
    const apiKey = revokeApiKey.mock.calls[0][0] as {
      projectId: string | null;
    };
    expect(apiKey.projectId).toBe("override");
  });

  it("returns null when not found", async () => {
    revokeApiKey.mockResolvedValueOnce(null);
    const ctx = makeCtx();
    const result = await deleteKeyTool.handler(
      { key_id: "missing" } as never,
      ctx,
    );
    expect(result).toBeNull();
  });
});

describe("D-C10-7 deleteKeyTool — phantom-wiring guard (C0 right-column contract)", () => {
  it("source imports `revokeApiKey` (NOT bare `deleteKey`)", () => {
    const sourcePath = resolve(__dirname, "../../src/tools/delete-key.ts");
    const source = readFileSync(sourcePath, "utf8");
    // Right-column name MUST appear.
    expect(source).toContain("revokeApiKey");

    // LEFT-column legacy name `deleteKey` (as a function) MUST NOT
    // appear on the @recondo/data import line. The variable name
    // `deleteKeyTool` is fine — the regex only fires on `deleteKey` NOT
    // followed by `Tool`.
    const importLines = source
      .split("\n")
      .filter((l) => l.includes("@recondo/data"));
    for (const line of importLines) {
      const m = /\bdeleteKey\b(?!Tool)/.exec(line);
      expect(
        m,
        `forbidden bare \`deleteKey\` in import line: ${line}`,
      ).toBeNull();
    }
  });
});
