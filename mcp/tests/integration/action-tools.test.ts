/**
 * D-C10-1..7 (integration) — End-to-end action tool round-trips.
 *
 * For each of the seven action tools, spawn the binary with the
 * appropriate flags, seed the DB as needed, call `tools/call`, and
 * assert the response shape. Skips when DATABASE_URL is unset or the
 * binary isn't built.
 *
 * Tool spawn flag matrix:
 *   - non-destructive (5): spawnMcp({ devBypass: true, args: ["--allow-actions"] })
 *   - destructive (2):     spawnMcp({ devBypass: true, args: ["--allow-actions", "--allow-destructive"] })
 *
 * NB: every test uses unique random ids so concurrent runs don't
 * collide. Each `afterAll` cleans up its seeded rows.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import {
  spawnMcp,
  RECONDO_MCP_BINARY,
  type SpawnedMcp,
} from "../helpers/spawnMcp.js";

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const describeIfReady = HAVE_DB && HAVE_BINARY ? describe : describe.skip;

interface CallToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function extractPayload(result: CallToolResult): Record<string, unknown> {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent as Record<string, unknown>;
  }
  if (result.content && result.content.length > 0) {
    const first = result.content[0];
    if (first?.type === "text" && typeof first.text === "string") {
      return JSON.parse(first.text) as Record<string, unknown>;
    }
  }
  throw new Error(
    `tool result missing payload: ${JSON.stringify(result).slice(0, 400)}`,
  );
}

// ---------------------------------------------------------------------------
// D-C10-1 — recondo_generate_report
// ---------------------------------------------------------------------------
describeIfReady("D-C10-1 recondo_generate_report (integration)", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true, args: ["--allow-actions"] });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("generates a weekly cost report and returns { report, errors } payload", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_generate_report",
      arguments: {
        type: "weekly_cost",
        period: "week",
        from: "2026-01-01T00:00:00Z",
        to: "2026-04-01T00:00:00Z",
      },
    });
    expect(result.isError).not.toBe(true);
    const payload = extractPayload(result);
    expect(payload).toHaveProperty("report");
    expect(payload).toHaveProperty("errors");
    expect(Array.isArray(payload.errors)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D-C10-2 — recondo_update_control_status
// ---------------------------------------------------------------------------
describeIfReady("D-C10-2 recondo_update_control_status (integration)", () => {
  let mcp: SpawnedMcp;
  const controlId = `ctrl-${randomUUID()}`;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true, args: ["--allow-actions"] });
    const { getPool } = await import("@recondo/data");
    const pool = getPool();
    await pool.query(
      `INSERT INTO compliance_controls (id, framework_id, control_id, description, status)
       VALUES ($1, 'soc2', 'CC1.1', 'test control', 'PENDING')`,
      [controlId],
    );
  });

  afterAll(async () => {
    try {
      const { getPool } = await import("@recondo/data");
      const pool = getPool();
      await pool.query(
        `DELETE FROM compliance_audit_log WHERE control_id = $1`,
        [controlId],
      );
      await pool.query(`DELETE FROM compliance_controls WHERE id = $1`, [
        controlId,
      ]);
    } catch {
      // pool may already be closed
    }
    await mcp?.close();
  });

  it("transitions a control's status and returns the updated row", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_update_control_status",
      arguments: {
        control_id: controlId,
        new_status: "compliant",
        reason: "remediation complete",
      },
    });
    expect(result.isError).not.toBe(true);
    const payload = extractPayload(result);
    expect(payload).toHaveProperty("control");
    expect(payload).toHaveProperty("errors");
  });
});

// ---------------------------------------------------------------------------
// D-C10-3 — recondo_create_policy
// ---------------------------------------------------------------------------
describeIfReady("D-C10-3 recondo_create_policy (integration)", () => {
  let mcp: SpawnedMcp;
  const policyName = `tw-create-${randomUUID()}`;
  let createdId: string | null = null;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true, args: ["--allow-actions"] });
  });

  afterAll(async () => {
    try {
      const { getPool } = await import("@recondo/data");
      const pool = getPool();
      if (createdId) {
        await pool.query(`DELETE FROM policies WHERE id = $1`, [createdId]);
      } else {
        await pool.query(`DELETE FROM policies WHERE name = $1`, [policyName]);
      }
    } catch {
      // pool may already be closed
    }
    await mcp?.close();
  });

  it("creates a policy and returns the new row", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_create_policy",
      arguments: {
        name: policyName,
        type: "BLOCK",
        scope: "global",
        action: "deny",
      },
    });
    expect(result.isError).not.toBe(true);
    const payload = extractPayload(result);
    expect(payload.name).toBe(policyName);
    expect(payload.type).toBe("BLOCK");
    expect(payload.status).toBe("ACTIVE");
    createdId = payload.id as string;
    expect(typeof createdId).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// D-C10-4 — recondo_update_policy
// ---------------------------------------------------------------------------
describeIfReady("D-C10-4 recondo_update_policy (integration)", () => {
  let mcp: SpawnedMcp;
  const policyId = `pol-${randomUUID()}`;
  const initialName = `tw-update-${randomUUID()}`;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true, args: ["--allow-actions"] });
    const { getPool } = await import("@recondo/data");
    const pool = getPool();
    await pool.query(
      `INSERT INTO policies (id, project_id, name, type, scope, action, triggers_mtd, status)
       VALUES ($1, 'default', $2, 'BLOCK', 'global', 'deny', 0, 'ACTIVE')`,
      [policyId, initialName],
    );
  });

  afterAll(async () => {
    try {
      const { getPool } = await import("@recondo/data");
      const pool = getPool();
      await pool.query(`DELETE FROM policies WHERE id = $1`, [policyId]);
    } catch {
      // pool may already be closed
    }
    await mcp?.close();
  });

  it("updates a policy's mutable fields", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_update_policy",
      arguments: {
        policy_id: policyId,
        scope: "team-a",
        status: "INACTIVE",
      },
    });
    expect(result.isError).not.toBe(true);
    const payload = extractPayload(result);
    expect(payload.id).toBe(policyId);
    expect(payload.scope).toBe("team-a");
    expect(payload.status).toBe("INACTIVE");
  });
});

// ---------------------------------------------------------------------------
// D-C10-5 — recondo_register_key → createApiKey
// ---------------------------------------------------------------------------
describeIfReady("D-C10-5 recondo_register_key (integration)", () => {
  let mcp: SpawnedMcp;
  const fingerprint = `fp-${randomUUID()}`;
  let createdId: string | null = null;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true, args: ["--allow-actions"] });
  });

  afterAll(async () => {
    try {
      const { getPool } = await import("@recondo/data");
      const pool = getPool();
      await pool.query(`DELETE FROM registered_keys WHERE fingerprint = $1`, [
        fingerprint,
      ]);
    } catch {
      // pool may already be closed
    }
    await mcp?.close();
  });

  it("registers a managed LLM key and returns the new row", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_register_key",
      arguments: {
        name: "test-anthropic",
        provider: "anthropic",
        fingerprint,
      },
    });
    expect(result.isError).not.toBe(true);
    const payload = extractPayload(result);
    expect(payload.fingerprint).toBe(fingerprint);
    expect(payload.provider).toBe("anthropic");
    expect(payload.status).toBe("active");
    createdId = payload.id as string;
    expect(typeof createdId).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// D-C10-6 — recondo_delete_policy (DESTRUCTIVE)
// ---------------------------------------------------------------------------
describeIfReady("D-C10-6 recondo_delete_policy (integration, DESTRUCTIVE)", () => {
  let mcp: SpawnedMcp;
  const policyId = `pol-${randomUUID()}`;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true, args: ["--allow-actions", "--allow-destructive"] });
    const { getPool } = await import("@recondo/data");
    const pool = getPool();
    await pool.query(
      `INSERT INTO policies (id, project_id, name, type, scope, action, triggers_mtd, status)
       VALUES ($1, 'default', $2, 'BLOCK', 'global', 'deny', 0, 'ACTIVE')`,
      [policyId, `tw-delete-${policyId}`],
    );
  });

  afterAll(async () => {
    try {
      const { getPool } = await import("@recondo/data");
      const pool = getPool();
      // Safety net — DELETE may have already happened in the test.
      await pool.query(`DELETE FROM policies WHERE id = $1`, [policyId]);
    } catch {
      // pool may already be closed
    }
    await mcp?.close();
  });

  it("deletes a policy and returns { id }", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_delete_policy",
      arguments: { policy_id: policyId },
    });
    expect(result.isError).not.toBe(true);
    const payload = extractPayload(result);
    expect(payload.id).toBe(policyId);

    // Verify the row is actually gone.
    const { getPool } = await import("@recondo/data");
    const pool = getPool();
    const verify = await pool.query(`SELECT id FROM policies WHERE id = $1`, [
      policyId,
    ]);
    expect(verify.rowCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D-C10-7 — recondo_delete_key → revokeApiKey (DESTRUCTIVE)
// ---------------------------------------------------------------------------
describeIfReady("D-C10-7 recondo_delete_key (integration, DESTRUCTIVE)", () => {
  let mcp: SpawnedMcp;
  const keyId = `key-${randomUUID()}`;
  const fingerprint = `fp-rev-${randomUUID()}`;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true, args: ["--allow-actions", "--allow-destructive"] });
    const { getPool } = await import("@recondo/data");
    const pool = getPool();
    await pool.query(
      `INSERT INTO registered_keys (id, project_id, name, provider, fingerprint, agent_count, last_used, monthly_cost_usd, status)
       VALUES ($1, 'default', 'tw-delete-key', 'anthropic', $2, 0, NULL, 0.0, 'active')`,
      [keyId, fingerprint],
    );
  });

  afterAll(async () => {
    try {
      const { getPool } = await import("@recondo/data");
      const pool = getPool();
      await pool.query(`DELETE FROM registered_keys WHERE id = $1`, [keyId]);
    } catch {
      // pool may already be closed
    }
    await mcp?.close();
  });

  it("revokes (deletes) a managed LLM key and returns { id }", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_delete_key",
      arguments: { key_id: keyId },
    });
    expect(result.isError).not.toBe(true);
    const payload = extractPayload(result);
    expect(payload.id).toBe(keyId);

    const { getPool } = await import("@recondo/data");
    const pool = getPool();
    const verify = await pool.query(
      `SELECT id FROM registered_keys WHERE id = $1`,
      [keyId],
    );
    expect(verify.rowCount).toBe(0);
  });
});
