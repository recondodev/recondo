import { describe, it, expect, afterAll, vi } from "vitest";
import { listAnomalies } from "../src/anomalies.js";
import { closePool, getPool } from "../src/pool.js";
import { encodeSinceCursor } from "../src/envelope.js";
import type { ApiKeyInfo } from "../src/types.js";

const adminKey: ApiKeyInfo = { id: "k", projectId: null, rateLimitRpm: 1000 };

afterAll(async () => {
  await closePool();
});

describe("@recondo/data: listAnomalies envelope (D-AN1)", () => {
  it("returns ListEnvelope shape", async () => {
    const env = await listAnomalies(adminKey, {}, { limit: 10 });
    expect(env).toHaveProperty("items");
    expect(env).toHaveProperty("next_offset");
    expect(env).toHaveProperty("truncated");
    expect(env.stream_id).toBeNull();
    expect(env.is_final).toBe(true);
  });

  it("project scoping is applied when apiKey.projectId is non-null", async () => {
    const scopedKey: ApiKeyInfo = { id: "k2", projectId: "p_x", rateLimitRpm: 100 };
    const pool = getPool();
    const spy = vi.spyOn(pool, "query");
    await listAnomalies(scopedKey, {}, { limit: 5 });
    // The first arg of at least one call should include `s.project_id = $`
    const sqlStrings = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(sqlStrings).toMatch(/s\.project_id\s*=\s*\$/);
    spy.mockRestore();
  });

  it("honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(listAnomalies(adminKey, {}, { signal: ctrl.signal })).rejects.toThrow();
  });
});

describe("@recondo/data: listAnomalies since cursor (D-AN2, D-AN3)", () => {
  it("accepts encoded base64url cursor and emits tie-break SQL", async () => {
    const cursor = encodeSinceCursor({ ts: "2026-05-04T12:00:00.000Z", id: "a-1" });
    const pool = getPool();
    const spy = vi.spyOn(pool, "query");
    await listAnomalies(adminKey, { since: cursor as unknown as string }, { limit: 5 });
    const sqlStrings = spy.mock.calls.map((c) => String(c[0])).join("\n");
    // Time clause + id tie-break
    expect(sqlStrings).toMatch(/detected_at\s*[>:]/);
    // Either id-based tie-break is present OR a composite (ts > x OR (ts = x AND id > y))
    // Accept any SQL that references both timestamp and id beyond the projectId scoping.
    expect(sqlStrings).toMatch(/a\.id|\.id\s*>/);
    spy.mockRestore();
  });

  it("accepts raw ISO date string for backward-compat (D-AN3)", async () => {
    const pool = getPool();
    const spy = vi.spyOn(pool, "query");
    await listAnomalies(adminKey, { since: "2026-05-04T12:00:00.000Z" }, { limit: 5 });
    const sqlStrings = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(sqlStrings).toMatch(/detected_at\s*[>:]/);
    spy.mockRestore();
  });
});
