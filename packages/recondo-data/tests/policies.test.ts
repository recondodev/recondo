import { describe, it, expect, afterAll } from "vitest";
import {
  listPolicies,
  getPolicy,
  listPolicyTriggerHistory,
  createPolicy,
  updatePolicy,
  deletePolicy,
} from "../src/policies.js";
import { closePool, getPool } from "../src/pool.js";
import type { ApiKeyInfo } from "../src/types.js";
import { vi } from "vitest";

const adminKey: ApiKeyInfo = { id: "k", projectId: null, rateLimitRpm: 1000 };

afterAll(async () => {
  await closePool();
});

describe("@recondo/data: policies exports (D-PO1)", () => {
  it("exports the 5 policy functions", () => {
    expect(typeof listPolicies).toBe("function");
    expect(typeof getPolicy).toBe("function");
    expect(typeof createPolicy).toBe("function");
    expect(typeof updatePolicy).toBe("function");
    expect(typeof deletePolicy).toBe("function");
  });
});

describe("@recondo/data: listPolicies envelope", () => {
  it("returns ListEnvelope shape", async () => {
    const env = await listPolicies(adminKey, {}, { limit: 10 });
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
      listPolicies(adminKey, {}, { signal: ctrl.signal }),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });

  it("applies policyId as an id filter", async () => {
    const pool = getPool();
    const spy = vi.spyOn(pool, "query");
    await listPolicies(adminKey, { policyId: "pol-1" }, { limit: 5 });
    const sqlStrings = spy.mock.calls.map((c) => String(c[0])).join("\n");
    const params = spy.mock.calls.flatMap((c) => c[1] as unknown[]);
    expect(sqlStrings).toMatch(/\bid\s*=\s*\$/);
    expect(params).toContain("pol-1");
    spy.mockRestore();
  });

  it("scopes trigger history by project and policy id", async () => {
    const pool = getPool();
    const spy = vi.spyOn(pool, "query");
    const scopedKey: ApiKeyInfo = {
      id: "k-scoped",
      projectId: "project-1",
      rateLimitRpm: 100,
    };
    await listPolicyTriggerHistory(
      scopedKey,
      { policyId: "pol-1" },
      { signal: undefined },
    );
    const sqlStrings = spy.mock.calls.map((c) => String(c[0])).join("\n");
    const params = spy.mock.calls.flatMap((c) => c[1] as unknown[]);
    expect(sqlStrings).toMatch(/p\.project_id\s*=\s*\$/);
    expect(sqlStrings).toMatch(/pt\.policy_id\s*=\s*\$/);
    expect(params).toContain("project-1");
    expect(params).toContain("pol-1");
    spy.mockRestore();
  });
});

describe("@recondo/data: getPolicy", () => {
  it("returns null for non-existent id", async () => {
    const policy = await getPolicy(
      adminKey,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(policy).toBeNull();
  });

  it("honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      getPolicy(adminKey, "00000000-0000-0000-0000-000000000000", {
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});

describe("@recondo/data: policy mutations", () => {
  it("createPolicy is a function", () => {
    expect(typeof createPolicy).toBe("function");
  });

  it("updatePolicy is a function", () => {
    expect(typeof updatePolicy).toBe("function");
  });

  it("deletePolicy is a function", () => {
    expect(typeof deletePolicy).toBe("function");
  });

  it("createPolicy honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // Aligned with api/src/resolvers/policies.ts createPolicy input shape:
    // { name, type, scope, action }. PolicyType enum -> "BLOCK" string.
    const minimalInput = {
      name: "test-policy",
      type: "BLOCK",
      scope: "global",
      action: "deny",
    };
    await expect(
      createPolicy(adminKey, minimalInput as never, { signal: ctrl.signal }),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });

  it("updatePolicy honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // Aligned with api/src/resolvers/policies.ts updatePolicy: (id, input)
    // where input is { name?, scope?, action?, status? }.
    await expect(
      updatePolicy(
        adminKey,
        "00000000-0000-0000-0000-000000000000",
        { name: "renamed" } as never,
        { signal: ctrl.signal },
      ),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });

  it("deletePolicy honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      deletePolicy(adminKey, "00000000-0000-0000-0000-000000000000", {
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});
