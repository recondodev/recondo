import { describe, it, expect, afterAll } from "vitest";
import { getPool, closePool, checkDatabaseHealth } from "../src/pool.js";

afterAll(async () => {
  await closePool();
});

describe("@recondo/data: pool", () => {
  it("getPool returns a singleton across calls", () => {
    const a = getPool();
    const b = getPool();
    expect(a).toBe(b);
  });

  it("checkDatabaseHealth returns true against a live db", async () => {
    const ok = await checkDatabaseHealth();
    expect(ok).toBe(true);
  });

  it("closePool is idempotent and the next getPool returns a working pool", async () => {
    const first = getPool();
    await closePool();
    // Calling closePool again must not throw.
    await closePool();
    // After close, a fresh pool must work for a real query.
    const second = getPool();
    // Singleton-after-close should be a NEW reference.
    expect(second).not.toBe(first);
    const result = await second.query("SELECT 1 AS x");
    expect(result.rows[0].x).toBe(1);
  });
});
