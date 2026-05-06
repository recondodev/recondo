import { describe, it, expect, afterAll } from "vitest";
import {
  listApiKeys,
  createApiKey,
  revokeApiKey,
} from "../src/keys.js";
import { closePool } from "../src/pool.js";
import type { ApiKeyInfo } from "../src/types.js";

const adminKey: ApiKeyInfo = { id: "k", projectId: null, rateLimitRpm: 1000 };

afterAll(async () => {
  await closePool();
});

describe("@recondo/data: keys exports (D-KE1)", () => {
  it("exports the 3 key functions", () => {
    expect(typeof listApiKeys).toBe("function");
    expect(typeof createApiKey).toBe("function");
    expect(typeof revokeApiKey).toBe("function");
  });
});

describe("@recondo/data: listApiKeys", () => {
  it("returns ListEnvelope shape", async () => {
    const env = await listApiKeys(adminKey, {}, { limit: 10 });
    expect(env).toHaveProperty("items");
    expect(env).toHaveProperty("next_offset");
    expect(env).toHaveProperty("truncated");
    expect(env.stream_id).toBeNull();
    expect(env.is_final).toBe(true);
  });

  it("honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      listApiKeys(adminKey, {}, { signal: ctrl.signal }),
    ).rejects.toThrow();
  });
});

describe("@recondo/data: key mutations", () => {
  it("createApiKey is a function", () => {
    expect(typeof createApiKey).toBe("function");
  });

  it("revokeApiKey is a function", () => {
    expect(typeof revokeApiKey).toBe("function");
  });

  it("createApiKey honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // Aligned with api/src/resolvers/keys.ts registerKey input shape:
    // { name, provider, fingerprint }. C8 renames registerKey -> createApiKey.
    const minimalInput = {
      name: "test-key",
      provider: "anthropic",
      fingerprint: "fp-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    await expect(
      createApiKey(adminKey, minimalInput as never, { signal: ctrl.signal }),
    ).rejects.toThrow();
  });

  it("revokeApiKey honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      revokeApiKey(adminKey, "00000000-0000-0000-0000-000000000000", {
        signal: ctrl.signal,
      }),
    ).rejects.toThrow();
  });
});
