/**
 * D-C2-2 — Self-test for the `seedTestDb` helper.
 *
 * Asserts:
 *   1. After seeding 2 sessions, those rows are queryable.
 *   2. Re-seeding wipes prior captured rows (proves the GDPR-bypass
 *      DELETE actually fired — without bypass the immutability
 *      triggers would reject the DELETE on turns/tool_calls and
 *      the DB would still hold the prior state).
 *   3. A raw DELETE on `turns` WITHOUT GDPR bypass raises (proves the
 *      SOC 2 PI1 trigger is in place — the helper relies on it).
 *   4. cleanup() is idempotent.
 *
 * Preconditions: `just dev-infra` running, `just api-migrate` applied.
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

import { seedTestDb, truncateCapturedTables } from "../helpers/seed.js";

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const describeIfDb = HAVE_DB ? describe : describe.skip;

describeIfDb("D-C2-2 seedTestDb helper", () => {
  let lastResult: Awaited<ReturnType<typeof seedTestDb>> | null = null;

  afterAll(async () => {
    if (lastResult) await lastResult.cleanup();
    // Final cleanup pass so we don't leak rows into other tests.
    try {
      await truncateCapturedTables();
    } catch {
      // pool may already be closed — ignore.
    }
  });

  it("seeds the requested sessions and they are SELECT-able", async () => {
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    const result = await seedTestDb({
      sessions: [
        { id: sessionA, framework: "claude-code" },
        { id: sessionB, framework: "claude-code" },
      ],
    });
    lastResult = result;

    const data = await import("@recondo/data");
    const pool = data.getPool();
    const r = await pool.query(
      `SELECT id FROM sessions WHERE id = ANY($1) ORDER BY id`,
      [[sessionA, sessionB]],
    );
    expect(r.rows.length).toBe(2);
    const ids = r.rows.map((row: { id: string }) => row.id).sort();
    expect(ids).toEqual([sessionA, sessionB].sort());
    expect(result.sessionIds).toContain(sessionA);
    expect(result.sessionIds).toContain(sessionB);
  });

  it("re-seeding wipes prior captured rows (GDPR bypass works)", async () => {
    const first = randomUUID();
    const second = randomUUID();
    await seedTestDb({ sessions: [{ id: first, framework: "claude-code" }] });
    await seedTestDb({ sessions: [{ id: second, framework: "claude-code" }] });

    const data = await import("@recondo/data");
    const pool = data.getPool();
    const r = await pool.query(`SELECT id FROM sessions`);
    const ids = r.rows.map((row: { id: string }) => row.id);
    expect(ids).not.toContain(first);
    expect(ids).toContain(second);
  });

  it("raw DELETE on turns WITHOUT GDPR bypass is rejected by the PI1 trigger", async () => {
    // Seed a turn to delete.
    const sessionId = randomUUID();
    const turnId = randomUUID();
    await seedTestDb({
      sessions: [{ id: sessionId, framework: "claude-code" }],
      turns: [{ id: turnId, sessionId }],
    });

    const data = await import("@recondo/data");
    const pool = data.getPool();
    await expect(
      pool.query(`DELETE FROM turns WHERE id = $1`, [turnId]),
    ).rejects.toThrow(/append-only|immutable|blocked/i);
  });

  it("cleanup() is idempotent", async () => {
    const result = await seedTestDb({});
    await result.cleanup();
    // Second call must not throw.
    await expect(result.cleanup()).resolves.toBeUndefined();
  });
});
