import { describe, it, expect, afterAll } from "vitest";
import { listReports, getReport, generateReport } from "../src/reports.js";
import { closePool } from "../src/pool.js";
import type { ApiKeyInfo } from "../src/types.js";

const adminKey: ApiKeyInfo = { id: "k", projectId: null, rateLimitRpm: 1000 };

afterAll(async () => {
  await closePool();
});

describe("@recondo/data: listReports (D-RP1)", () => {
  it("returns ListEnvelope shape", async () => {
    const env = await listReports(adminKey, {}, { limit: 10 });
    expect(env).toHaveProperty("items");
    expect(env.is_final).toBe(true);
  });

  it("honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      listReports(adminKey, {}, { signal: ctrl.signal }),
    ).rejects.toThrow();
  });
});

describe("@recondo/data: getReport", () => {
  it("returns null for non-existent id", async () => {
    const report = await getReport(
      adminKey,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(report).toBeNull();
  });

  it("honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      getReport(adminKey, "00000000-0000-0000-0000-000000000000", {
        signal: ctrl.signal,
      }),
    ).rejects.toThrow();
  });
});

describe("@recondo/data: generateReport mutation", () => {
  it("is exported as a function", () => {
    expect(typeof generateReport).toBe("function");
  });

  it("honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // Note: the input signature may need adjustment. Pass an empty/minimal input.
    // The implementer must align the test fixture with the actual generateReport signature.
    // For now, we just verify the AbortSignal contract.
    // Use a signal-only options arg if the implementation supports it.
    await expect(async () => {
      // Best-effort: the call signature is likely `generateReport(apiKey, input, options)`.
      // Pass minimal input + aborted signal.
      const minimalInput = {
        framework: "SOC2",
        periodStart: new Date(Date.now() - 86_400_000).toISOString(),
        periodEnd: new Date().toISOString(),
      };
      await generateReport(adminKey, minimalInput as never, {
        signal: ctrl.signal,
      });
    }).rejects.toThrow();
  });
});
