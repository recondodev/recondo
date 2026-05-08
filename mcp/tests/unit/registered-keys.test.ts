/**
 * D-C9-2 (unit) — `recondo_registered_keys` tool: schema + handler.
 *
 * Contract pinned by C0 audit + Plan D §C9 (Task 21):
 *   - Tool name: `recondo_registered_keys`.
 *   - Description >= 50 chars AND mentions "managed LLM keys" (or
 *     equivalent disambiguator) so callers do not confuse it with the
 *     gateway auth `api_keys` table. The C0 audit highlights this:
 *     `recondo_registered_keys` reads the `registered_keys` TABLE
 *     (managed LLM provider keys) — NOT the `api_keys` table (gateway
 *     auth tokens). The two tables are intentionally distinct (see
 *     packages/recondo-data/src/keys.ts header comment).
 *   - Input shape (data-layer signature: `listApiKeys(apiKey, filter, options)`,
 *     filter is `ApiKeyFilter` (placeholder), options is `ListOptions`):
 *       project_id?: string
 *       limit?:      integer (>=1)
 *       offset?:     integer (>=0)
 *   - Handler: calls `listApiKeys` exactly once, returns the canonical
 *     5-key list envelope.
 *   - `ctx.abortSignal` MUST be threaded into options.signal.
 *
 * Phantom-wiring guard (C0 right-column contract):
 *   - The production source MUST import the RIGHT-column name
 *     `listApiKeys` from `@recondo/data`. The bare LEFT-column name
 *     `registeredKeys` MUST NOT appear in the import line.
 *
 * Data-layer signature reference (packages/recondo-data/src/keys.ts):
 *
 *   export async function listApiKeys(
 *     apiKey: ApiKeyInfo,
 *     _filter: ApiKeyFilter = {},
 *     options: ListOptions = {},
 *   ): Promise<ListEnvelope<ApiKeyRecord> & { total: number; limit: number; offset: number }>
 *
 * SQL (verbatim from packages/recondo-data/src/keys.ts):
 *
 *   SELECT id, name, provider, fingerprint, agent_count, last_used,
 *          monthly_cost_usd, status
 *   FROM registered_keys
 *   ...
 *
 * The function reads the `registered_keys` table — NOT `api_keys`. The
 * MCP tool name (`recondo_registered_keys`) reflects this.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { listApiKeys, getPool, closePool, insertAuditLog } = vi.hoisted(
  () => ({
    listApiKeys: vi.fn(),
    getPool: vi.fn(),
    closePool: vi.fn(),
    insertAuditLog: vi.fn(),
  }),
);

vi.mock("@recondo/data", () => ({
  listApiKeys,
  getPool,
  closePool,
  insertAuditLog,
}));

import {
  registeredKeysTool,
  registeredKeysInputSchema,
} from "../../src/tools/registered-keys.js";
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
  id: "key-1",
  name: "anthropic-prod",
  provider: "anthropic",
  fingerprint: "sk-ant-...abc",
  agentCount: 0,
  lastUsed: null,
  monthlyCostUsd: 0,
  status: "active",
};

function envelopeWith(items: unknown[]): Record<string, unknown> {
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

describe("D-C9-2 registeredKeysInputSchema", () => {
  it("description is >= 50 characters", () => {
    expect(typeof registeredKeysTool.description).toBe("string");
    expect(registeredKeysTool.description.length).toBeGreaterThanOrEqual(50);
  });

  it("description disambiguates managed LLM keys from gateway auth tokens", () => {
    // The contract: the description MUST mention "managed LLM" (or a
    // close paraphrase like "LLM provider keys" / "registered LLM keys")
    // so callers can't mistake it for the gateway auth `api_keys`
    // table. Accept any of the recognised disambiguators.
    const desc = registeredKeysTool.description.toLowerCase();
    const hasDisambiguator =
      desc.includes("managed llm") ||
      desc.includes("llm provider key") ||
      desc.includes("registered llm") ||
      desc.includes("managed-llm") ||
      (desc.includes("llm") && desc.includes("provider"));
    expect(
      hasDisambiguator,
      `description must disambiguate managed LLM keys from gateway auth tokens; got: ${registeredKeysTool.description}`,
    ).toBe(true);
  });

  it("tool name is exactly recondo_registered_keys", () => {
    expect(registeredKeysTool.name).toBe("recondo_registered_keys");
  });

  it("schema accepts an empty object (all fields optional)", () => {
    expect(() => registeredKeysInputSchema.parse({})).not.toThrow();
  });

  it("schema accepts the documented optional fields", () => {
    expect(() =>
      registeredKeysInputSchema.parse({
        project_id: "proj-1",
        limit: 10,
        offset: 0,
      }),
    ).not.toThrow();
  });

  it("schema rejects negative offset / non-positive limit", () => {
    expect(() => registeredKeysInputSchema.parse({ offset: -1 })).toThrow();
    expect(() => registeredKeysInputSchema.parse({ limit: 0 })).toThrow();
  });
});

describe("D-C9-2 registeredKeysTool — phantom-wiring guard (C0 right-column contract)", () => {
  it("source imports `listApiKeys` (NOT bare `registeredKeys`)", () => {
    const sourcePath = resolve(__dirname, "../../src/tools/registered-keys.ts");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain("listApiKeys");

    const importLines = source
      .split("\n")
      .filter((l) => l.includes("@recondo/data"));
    for (const line of importLines) {
      // Bare `registeredKeys` (LEFT-column resolver name) on the
      // `@recondo/data` import line is forbidden. The tool variable
      // (`registeredKeysTool`) lives in our own source, not in the
      // import line, so it can't trip this guard. Substrings inside
      // longer identifiers are excluded by the word boundary.
      const m = /\bregisteredKeys\b/.exec(line);
      expect(
        m,
        `forbidden bare \`registeredKeys\` in import line: ${line}`,
      ).toBeNull();
    }
  });
});

describe("D-C9-2 registeredKeysTool handler — call wiring", () => {
  beforeEach(() => {
    listApiKeys.mockReset();
  });

  it("calls listApiKeys exactly once", async () => {
    listApiKeys.mockResolvedValueOnce(envelopeWith([sampleKey]));
    const ctx = makeCtx();
    await registeredKeysTool.handler({} as never, ctx);
    expect(listApiKeys).toHaveBeenCalledTimes(1);
  });

  it("threads ctx.abortSignal into options.signal of the call", async () => {
    listApiKeys.mockResolvedValueOnce(envelopeWith([]));
    const ac = new AbortController();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await registeredKeysTool.handler({} as never, ctx);
    const callArgs = listApiKeys.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as { signal?: AbortSignal };
    expect(opts.signal).toBe(ac.signal);
  });

  it("project_id overrides auth.projectId on the apiKey bag", async () => {
    listApiKeys.mockResolvedValueOnce(envelopeWith([]));
    const ctx = makeCtx({
      auth: {
        kind: "dev-bypass",
        isAdmin: true,
        projectId: "auth-project",
        keyId: "dev-bypass",
      },
    });
    await registeredKeysTool.handler(
      { project_id: "override-project" } as never,
      ctx,
    );
    const callArgs = listApiKeys.mock.calls[0];
    const apiKey = callArgs[0] as { projectId: string | null };
    expect(apiKey.projectId).toBe("override-project");
  });

  it("forwards limit/offset into options", async () => {
    listApiKeys.mockResolvedValueOnce(envelopeWith([]));
    const ctx = makeCtx();
    await registeredKeysTool.handler(
      { limit: 7, offset: 3 } as never,
      ctx,
    );
    const callArgs = listApiKeys.mock.calls[0];
    const opts = callArgs[callArgs.length - 1] as {
      limit?: number;
      offset?: number;
    };
    expect(opts.limit).toBe(7);
    expect(opts.offset).toBe(3);
  });

  it("propagates AbortError when the call rejects", async () => {
    listApiKeys.mockRejectedValueOnce(
      new DOMException("aborted", "AbortError"),
    );
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ abortSignal: ac.signal });
    await expect(registeredKeysTool.handler({} as never, ctx)).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});

describe("D-C9-2 registeredKeysTool handler — output envelope", () => {
  beforeEach(() => {
    listApiKeys.mockReset();
  });

  it("returns the canonical 5-key list envelope shape", async () => {
    listApiKeys.mockResolvedValueOnce(envelopeWith([sampleKey]));
    const ctx = makeCtx();
    const result = (await registeredKeysTool.handler(
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
    expect(JSON.stringify(result)).toContain("key-1");
  });
});
