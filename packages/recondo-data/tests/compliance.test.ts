import { describe, it, expect, afterAll } from "vitest";
import { listComplianceFindings } from "../src/compliance.js";
import { closePool } from "../src/pool.js";
import type { ApiKeyInfo } from "../src/types.js";

const adminKey: ApiKeyInfo = { id: "k", projectId: null, rateLimitRpm: 1000 };

afterAll(async () => {
  await closePool();
});

describe("@recondo/data: listComplianceFindings (D-CP1)", () => {
  it("returns ListEnvelope shape", async () => {
    const env = await listComplianceFindings(adminKey, {}, { limit: 10 });
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
      listComplianceFindings(adminKey, {}, { signal: ctrl.signal }),
    ).rejects.toThrow();
  });
});
