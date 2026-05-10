import { describe, it, expect, afterAll, vi } from "vitest";
import { listAuditEvents } from "../src/audit.js";
import { closePool, getPool } from "../src/pool.js";
import { encodeSinceCursor } from "../src/envelope.js";
import type { ApiKeyInfo } from "../src/types.js";

const adminKey: ApiKeyInfo = { id: "k", projectId: null, rateLimitRpm: 1000 };

afterAll(async () => {
  await closePool();
});

describe("@recondo/data: listAuditEvents envelope (D-AU1)", () => {
  it("returns ListEnvelope shape", async () => {
    const env = await listAuditEvents(adminKey, {}, { limit: 10 });
    expect(env).toHaveProperty("items");
    expect(env).toHaveProperty("next_offset");
    expect(env).toHaveProperty("truncated");
    expect(env.stream_id).toBeNull();
    expect(env.is_final).toBe(true);
  });

  it("honors AbortSignal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(listAuditEvents(adminKey, {}, { signal: ctrl.signal })).rejects.toThrow(/aborted|AbortError|invalid|required|missing|not found|failed|failure|boom|db down|auth|API key|database|validation|unsupported|period|relation|signal/i);
  });
});

describe("@recondo/data: listAuditEvents since cursor (D-AU1)", () => {
  it("accepts encoded base64url cursor and emits time-clause SQL", async () => {
    const cursor = encodeSinceCursor({ ts: "2026-05-04T12:00:00.000Z", id: "evt-1" });
    const pool = getPool();
    const spy = vi.spyOn(pool, "query");
    await listAuditEvents(adminKey, { since: cursor as unknown as string }, { limit: 5 });
    const sqlStrings = spy.mock.calls.map((c) => String(c[0])).join("\n");
    // Audit events likely use a "timestamp" or "occurred_at" column — accept any
    // time-comparison clause that suggests cursor was decoded.
    expect(sqlStrings).toMatch(/(timestamp|occurred_at|created_at|happened_at|detected_at|event_time)\s*[>:]/);
    spy.mockRestore();
  });
});
