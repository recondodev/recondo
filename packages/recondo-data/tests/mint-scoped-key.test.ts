import { createHash } from "node:crypto";
import { describe, it, expect, afterAll } from "vitest";

import {
  authenticateApiKey,
  mintScopedKey,
} from "../src/index.js";
import { getPool, closePool } from "../src/pool.js";

afterAll(async () => {
  await closePool();
});

describe("@recondo/data: mintScopedKey", () => {
  it("mints a unique scoped auth key, stores only the hash, audits the mint, and authenticates", async () => {
    const first = await mintScopedKey({
      projectId: "alpha",
      name: "test-key-alpha",
    });
    const second = await mintScopedKey({
      projectId: "alpha",
      name: "test-key-alpha-2",
    });

    expect(first.keyId).not.toBe(second.keyId);
    expect(first.rawSecret).toMatch(/^wrt_/);
    expect(second.rawSecret).toMatch(/^wrt_/);
    expect(first.rawSecret).not.toBe(second.rawSecret);
    expect(first.scopedProjectId).toBe("alpha");
    expect(first.createdAt).toBeInstanceOf(Date);

    const pool = getPool();
    const keyHash = createHash("sha256").update(first.rawSecret).digest("hex");
    const keyRow = await pool.query(
      `SELECT id, key_hash, project_id, name, scope
       FROM api_keys
       WHERE id = $1`,
      [first.keyId],
    );
    expect(keyRow.rows[0]).toMatchObject({
      id: first.keyId,
      key_hash: keyHash,
      project_id: "alpha",
      name: "test-key-alpha",
      scope: "scoped",
    });

    const auditRow = await pool.query(
      `SELECT tool_name, key_id, outcome
       FROM audit_log
       WHERE key_id = $1
       ORDER BY requested_at DESC
       LIMIT 1`,
      [first.keyId],
    );
    expect(auditRow.rows[0]).toMatchObject({
      tool_name: "mintScopedKey",
      key_id: first.keyId,
      outcome: "success",
    });

    const auth = await authenticateApiKey(first.rawSecret);
    expect(auth).toMatchObject({
      id: first.keyId,
      projectId: "alpha",
      rateLimitRpm: 60,
    });

    await pool.query(`UPDATE api_keys SET revoked_at = NOW() WHERE id IN ($1, $2)`, [
      first.keyId,
      second.keyId,
    ]);
  });
});
