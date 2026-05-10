import { describe, it, expect, afterAll } from "vitest";
import {
  listStructuredSessions,
  listStructuredTurns,
  listStructuredAnomalies,
  listStructuredCost,
  listStructuredTools,
  listStructuredRisk,
  listStructuredCompliance,
  listStructuredProvenance,
  runStructuredQuery,
} from "../src/structured-query.js";
import { closePool } from "../src/pool.js";

afterAll(async () => {
  await closePool();
});

describe("@recondo/data: structured-query per-operation exports", () => {
  it("listStructuredSessions returns AsyncIterable", async () => {
    const it = listStructuredSessions("test-project", {}, { limit: 10 });
    expect(typeof (it as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function");
    const rows = await Array.fromAsync(it);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("listStructuredTurns returns AsyncIterable", async () => {
    const it = listStructuredTurns("test-project", {}, { limit: 10 });
    const rows = await Array.fromAsync(it);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("listStructuredAnomalies returns AsyncIterable", async () => {
    const it = listStructuredAnomalies("test-project", {}, { limit: 10 });
    const rows = await Array.fromAsync(it);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("listStructuredCost returns AsyncIterable", async () => {
    const it = listStructuredCost("test-project", {}, undefined, { limit: 10 });
    const rows = await Array.fromAsync(it);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("listStructuredTools returns AsyncIterable", async () => {
    const it = listStructuredTools("test-project", {}, { limit: 10 });
    const rows = await Array.fromAsync(it);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("listStructuredRisk returns AsyncIterable", async () => {
    const it = listStructuredRisk("test-project", {}, { limit: 10 });
    const rows = await Array.fromAsync(it);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("listStructuredCompliance returns AsyncIterable", async () => {
    const it = listStructuredCompliance("test-project", {}, { limit: 10 });
    const rows = await Array.fromAsync(it);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("listStructuredProvenance returns AsyncIterable", async () => {
    const it = listStructuredProvenance("test-project", {}, { limit: 10 });
    const rows = await Array.fromAsync(it);
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe("@recondo/data: structured-query AbortSignal contract", () => {
  it("listStructuredSessions rejects when signal is aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      Array.fromAsync(listStructuredSessions("test-project", {}, { signal: ctrl.signal })),
    ).rejects.toThrow(/abort/i);
  });

  it("listStructuredTurns rejects when signal is aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      Array.fromAsync(listStructuredTurns("test-project", {}, { signal: ctrl.signal })),
    ).rejects.toThrow(/abort/i);
  });

  it("listStructuredAnomalies rejects when signal is aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      Array.fromAsync(listStructuredAnomalies("test-project", {}, { signal: ctrl.signal })),
    ).rejects.toThrow(/abort/i);
  });

  it("listStructuredCost rejects when signal is aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      Array.fromAsync(listStructuredCost("test-project", {}, undefined, { signal: ctrl.signal })),
    ).rejects.toThrow(/abort/i);
  });

  it("listStructuredTools rejects when signal is aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      Array.fromAsync(listStructuredTools("test-project", {}, { signal: ctrl.signal })),
    ).rejects.toThrow(/abort/i);
  });

  it("listStructuredRisk rejects when signal is aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      Array.fromAsync(listStructuredRisk("test-project", {}, { signal: ctrl.signal })),
    ).rejects.toThrow(/abort/i);
  });

  it("listStructuredCompliance rejects when signal is aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      Array.fromAsync(listStructuredCompliance("test-project", {}, { signal: ctrl.signal })),
    ).rejects.toThrow(/abort/i);
  });

  it("listStructuredProvenance rejects when signal is aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      Array.fromAsync(listStructuredProvenance("test-project", {}, { signal: ctrl.signal })),
    ).rejects.toThrow(/abort/i);
  });
});

describe("@recondo/data: runStructuredQuery dispatcher", () => {
  it("dispatches sessions queryType", async () => {
    const out = await runStructuredQuery("sessions", "test-project", {}, undefined, 10);
    expect(out.rows).toBeDefined();
    expect(Array.isArray(out.rows)).toBe(true);
    expect(typeof out.totalCount).toBe("number");
  });

  it("dispatches turns queryType", async () => {
    const out = await runStructuredQuery("turns", "test-project", {}, undefined, 10);
    expect(out.rows).toBeDefined();
    expect(typeof out.totalCount).toBe("number");
  });

  it("dispatches anomalies queryType", async () => {
    const out = await runStructuredQuery("anomalies", "test-project", {}, undefined, 10);
    expect(out.rows).toBeDefined();
    expect(typeof out.totalCount).toBe("number");
  });

  it("dispatches cost queryType with groupBy", async () => {
    const out = await runStructuredQuery("cost", "test-project", {}, "model", 10);
    expect(out.rows).toBeDefined();
    expect(typeof out.totalCount).toBe("number");
  });

  it("dispatches tools queryType", async () => {
    const out = await runStructuredQuery("tools", "test-project", {}, undefined, 10);
    expect(out.rows).toBeDefined();
  });

  it("dispatches risk queryType", async () => {
    const out = await runStructuredQuery("risk", "test-project", {}, undefined, 10);
    expect(out.rows).toBeDefined();
  });

  it("dispatches compliance queryType", async () => {
    const out = await runStructuredQuery("compliance", "test-project", {}, undefined, 10);
    expect(out.rows).toBeDefined();
  });

  it("dispatches provenance queryType", async () => {
    const out = await runStructuredQuery("provenance", "test-project", {}, undefined, 10);
    expect(out.rows).toBeDefined();
  });

  it("throws for unknown queryType", async () => {
    await expect(
      runStructuredQuery("not-a-real-type", "test-project", {}, undefined, 10),
    ).rejects.toThrow(/Unknown queryType: not-a-real-type/);
  });

  it("propagates AbortSignal through runStructuredQuery", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      runStructuredQuery("sessions", "test-project", {}, undefined, 10, { signal: ctrl.signal }),
    ).rejects.toThrow(/abort/i);
  });
});
