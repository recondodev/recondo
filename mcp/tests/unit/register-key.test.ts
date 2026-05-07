/**
 * D-C10-5 (unit) — `recondo_register_key` action tool → `createApiKey`.
 *
 * Contract:
 *   - Tool name: `recondo_register_key`. (LEFT-column historical name kept
 *     for the MCP tool surface; data-layer rename to `createApiKey` is the
 *     RIGHT-column binding.)
 *   - Description >= 50 chars, includes verbatim INJECTION_WARNING, AND
 *     mentions "managed LLM keys" (or equivalent disambiguator) so callers
 *     do not confuse it with the gateway auth `api_keys` table. Operates
 *     on the `registered_keys` table (LLM provider keys, not auth tokens).
 *   - destructive: false (insert; soft-fails to null on UNIQUE conflict).
 *   - Input shape (data-layer signature: `createApiKey(apiKey, input, options)`,
 *     where input is `CreateApiKeyInput { name, provider, fingerprint }`):
 *       name:        string
 *       provider:    string
 *       fingerprint: string
 *       project_id?: string
 *
 * Phantom-wiring guard (C0 right-column contract):
 *   - The production source MUST import the RIGHT-column name
 *     `createApiKey` from `@recondo/data`. The bare LEFT-column name
 *     `registerKey` MUST NOT appear in the import line.
 *
 * Data-layer signature reference (packages/recondo-data/src/keys.ts:139):
 *
 *   export async function createApiKey(
 *     apiKey: ApiKeyInfo,
 *     input: CreateApiKeyInput,    // { name, provider, fingerprint }
 *     options: QueryOptions = {},
 *   ): Promise<ApiKeyRecord | null>
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { createApiKey, getPool, closePool, insertAuditLog } = vi.hoisted(() => ({
  createApiKey: vi.fn(),
  getPool: vi.fn(),
  closePool: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("@recondo/data", () => ({
  createApiKey,
  getPool,
  closePool,
  insertAuditLog,
}));

import {
  registerKeyTool,
  registerKeyInputSchema,
} from "../../src/tools/register-key.js";
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

const sampleKey = {
  id: "key-new",
  name: "anthropic-prod",
  provider: "anthropic",
  fingerprint: "sk-ant-...abc",
  agentCount: 0,
  lastUsed: null,
  monthlyCostUsd: 0,
  status: "active",
};

describe("D-C10-5 registerKeyTool — metadata", () => {
  it("tool name is recondo_register_key", () => {
    expect(registerKeyTool.name).toBe("recondo_register_key");
  });

  it("description >= 50 chars and contains INJECTION_WARNING", () => {
    expect(registerKeyTool.description.length).toBeGreaterThanOrEqual(50);
    expect(registerKeyTool.description).toContain(INJECTION_WARNING);
  });

  it("description disambiguates managed LLM keys from gateway auth tokens", () => {
    // Same C0 disambiguator as recondo_registered_keys: must mention
    // "managed LLM" so callers know this is the registered_keys table
    // (LLM provider keys), NOT the api_keys table (auth tokens).
    const desc = registerKeyTool.description.toLowerCase();
    const hasDisambiguator =
      desc.includes("managed llm") ||
      desc.includes("registered_keys") ||
      desc.includes("llm provider key");
    expect(
      hasDisambiguator,
      `description must disambiguate registered_keys (LLM provider keys) from api_keys (auth tokens). Got: ${registerKeyTool.description}`,
    ).toBe(true);
  });

  it("destructive flag is false", () => {
    expect(registerKeyTool.destructive).toBe(false);
  });
});

describe("D-C10-5 registerKeyInputSchema", () => {
  it("accepts the documented required fields", () => {
    expect(() =>
      registerKeyInputSchema.parse({
        name: "anthropic-prod",
        provider: "anthropic",
        fingerprint: "sk-ant-...abc",
      }),
    ).not.toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() =>
      registerKeyInputSchema.parse({ name: "x" } as never),
    ).toThrow();
  });
});

describe("D-C10-5 registerKeyTool handler", () => {
  beforeEach(() => {
    createApiKey.mockReset();
  });

  it("calls createApiKey exactly once (RIGHT-column binding)", async () => {
    createApiKey.mockResolvedValueOnce(sampleKey);
    const ctx = makeCtx();
    await registerKeyTool.handler(
      {
        name: "anthropic-prod",
        provider: "anthropic",
        fingerprint: "sk-ant-...abc",
      } as never,
      ctx,
    );
    expect(createApiKey).toHaveBeenCalledTimes(1);
  });

  it("threads ctx.abortSignal into options.signal", async () => {
    createApiKey.mockResolvedValueOnce(sampleKey);
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await registerKeyTool.handler(
      {
        name: "n",
        provider: "openai",
        fingerprint: "fp",
      } as never,
      ctx,
    );
    const callArgs = createApiKey.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("passes name / provider / fingerprint verbatim", async () => {
    createApiKey.mockResolvedValueOnce(sampleKey);
    const ctx = makeCtx();
    await registerKeyTool.handler(
      {
        name: "openai-staging",
        provider: "openai",
        fingerprint: "sk-oai-xyz",
      } as never,
      ctx,
    );
    const [, input] = createApiKey.mock.calls[0];
    const i = input as { name: string; provider: string; fingerprint: string };
    expect(i.name).toBe("openai-staging");
    expect(i.provider).toBe("openai");
    expect(i.fingerprint).toBe("sk-oai-xyz");
  });

  it("returns null when fingerprint already exists (data-layer null pass-through)", async () => {
    createApiKey.mockResolvedValueOnce(null);
    const ctx = makeCtx();
    const result = await registerKeyTool.handler(
      {
        name: "n",
        provider: "anthropic",
        fingerprint: "dup",
      } as never,
      ctx,
    );
    expect(result).toBeNull();
  });
});

describe("D-C10-5 registerKeyTool — phantom-wiring guard (C0 right-column contract)", () => {
  it("source imports `createApiKey` (NOT bare `registerKey`)", () => {
    const sourcePath = resolve(__dirname, "../../src/tools/register-key.ts");
    const source = readFileSync(sourcePath, "utf8");
    // Right-column name MUST appear.
    expect(source).toContain("createApiKey");

    // LEFT-column legacy name (`registerKey` as a function) MUST NOT
    // appear on the @recondo/data import line. The variable name
    // `registerKeyTool` is fine — the regex only fires on a bare
    // `registerKey` token NOT followed by `Tool`.
    const importLines = source
      .split("\n")
      .filter((l) => l.includes("@recondo/data"));
    for (const line of importLines) {
      const m = /\bregisterKey\b(?!Tool)/.exec(line);
      expect(
        m,
        `forbidden bare \`registerKey\` in import line: ${line}`,
      ).toBeNull();
    }
  });
});
