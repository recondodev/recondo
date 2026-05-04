/**
 * Sprint 5 Deliverable 3: Attestation Document Generator
 *
 * Tests for POST /v1/attestation/generate endpoint.
 *
 * This endpoint generates a supply chain attestation document containing:
 * - Artifact list with SHA-256 hashes
 * - Provenance: every session and turn that touched each artifact
 * - Originating intents from each session
 * - Model versions used
 * - System prompt hashes
 * - Time range
 * - Signature (placeholder "unsigned" until OD-004)
 * - Generation timestamp
 *
 * These tests WILL FAIL until the implementation agent builds the endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupDatabase,
  teardownDatabase,
  getPool,
  API_KEYS,
  IDS,
  API_BASE_URL,
  countAuditLogs,
} from "./setup.js";

// ---------------------------------------------------------------------------
// Sprint 5 fixture data: tool calls with artifacts + supersedes chain
// ---------------------------------------------------------------------------

const SPRINT5_IDS = {
  // Turns with artifact tracking (prefix: s5dd)
  turnArt1: "s5dd0000-0000-4000-8000-000000000001",
  turnArt2: "s5dd0000-0000-4000-8000-000000000002",
  turnArt3: "s5dd0000-0000-4000-8000-000000000003",

  // Tool calls with artifacts (prefix: s5ee)
  tcArt1: "s5ee0000-0000-4000-8000-000000000001",
  tcArt2: "s5ee0000-0000-4000-8000-000000000002",
  tcArt3: "s5ee0000-0000-4000-8000-000000000003",
} as const;

async function seedSprint5Fixtures(): Promise<void> {
  const p = getPool();
  const { createHash } = await import("crypto");
  const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

  const now = new Date();
  const hourAgo = new Date(now.getTime() - 3600_000);
  const twoHoursAgo = new Date(now.getTime() - 7200_000);

  // Turns with artifact tracking in sessionAlpha1 (already seeded in setup.ts)
  // Turn 1: Write /src/auth.ts (new, seq 4 to avoid conflict with setup turns)
  await p.query(`
    INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
                       req_bytes_ref, resp_bytes_ref, model, provider,
                       input_tokens, output_tokens, thinking_tokens, cost_usd,
                       duration_ms, tool_call_count, stop_reason, created_at,
                       supersedes_turn_id)
    VALUES
      ('${SPRINT5_IDS.turnArt1}', '${IDS.sessionAlpha1}', 4,
       '${twoHoursAgo.toISOString()}', 'hash_req_art1', 'hash_resp_art1',
       'req_ref_art1', 'resp_ref_art1', 'claude-sonnet-4-20250514', 'anthropic',
       500, 200, 0, 0.03, 800, 1, 'end_turn', '${twoHoursAgo.toISOString()}',
       NULL),
      ('${SPRINT5_IDS.turnArt2}', '${IDS.sessionAlpha1}', 5,
       '${new Date(twoHoursAgo.getTime() + 60000).toISOString()}', 'hash_req_art2', 'hash_resp_art2',
       'req_ref_art2', 'resp_ref_art2', 'claude-sonnet-4-20250514', 'anthropic',
       600, 300, 0, 0.04, 900, 1, 'end_turn', '${new Date(twoHoursAgo.getTime() + 60000).toISOString()}',
       '${SPRINT5_IDS.turnArt1}'),
      ('${SPRINT5_IDS.turnArt3}', '${IDS.sessionAlpha1}', 6,
       '${hourAgo.toISOString()}', 'hash_req_art3', 'hash_resp_art3',
       'req_ref_art3', 'resp_ref_art3', 'claude-sonnet-4-20250514', 'anthropic',
       700, 400, 0, 0.05, 1000, 1, 'end_turn', '${hourAgo.toISOString()}',
       '${SPRINT5_IDS.turnArt2}')
    ON CONFLICT (id) DO NOTHING;
  `);

  const authHash = sha256("/src/auth.ts");
  const dbHash = sha256("/src/db.ts");

  // Tool calls with artifacts_created and artifact_hashes
  await p.query(`
    INSERT INTO tool_calls (id, turn_id, tool_name, tool_input, input_hash, sequence_num,
                            output, output_hash, duration_ms, status,
                            artifacts_created, artifact_hashes)
    VALUES
      ('${SPRINT5_IDS.tcArt1}', '${SPRINT5_IDS.turnArt1}', 'Write',
       '{"file_path":"/src/auth.ts","content":"v1"}', 'ih_art1', 0,
       'File written', 'oh_art1', 200, 'success',
       '["/src/auth.ts"]', '["${authHash}"]'),
      ('${SPRINT5_IDS.tcArt2}', '${SPRINT5_IDS.turnArt2}', 'Edit',
       '{"file_path":"/src/auth.ts","old_string":"v1","new_string":"v2"}', 'ih_art2', 0,
       'File edited', 'oh_art2', 150, 'success',
       '["/src/auth.ts"]', '["${authHash}"]'),
      ('${SPRINT5_IDS.tcArt3}', '${SPRINT5_IDS.turnArt3}', 'Write',
       '{"file_path":"/src/db.ts","content":"pool"}', 'ih_art3', 0,
       'File written', 'oh_art3', 180, 'success',
       '["/src/db.ts"]', '["${dbHash}"]')
    ON CONFLICT (id) DO NOTHING;
  `);
}

// ---------------------------------------------------------------------------
// Helper: POST to REST endpoints
// ---------------------------------------------------------------------------

async function postJSON(
  path: string,
  body: Record<string, unknown>,
  apiKey?: string
): Promise<{ body: Record<string, unknown>; response: Response }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const responseBody = (await response.json()) as Record<string, unknown>;
  return { body: responseBody, response };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedSprint5Fixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// POST /v1/attestation/generate
// =========================================================================

describe("POST /v1/attestation/generate", () => {
  it("generates attestation document for tracked artifacts", async () => {
    const { body, response } = await postJSON(
      "/v1/attestation/generate",
      {
        artifactPaths: ["/src/auth.ts"],
        projectId: IDS.projectAlpha,
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);

    // Top-level structure
    expect(body.attestation).toBeDefined();
    const att = body.attestation as Record<string, unknown>;

    // artifacts array
    const artifacts = att.artifacts as Array<Record<string, unknown>>;
    expect(artifacts).toBeDefined();
    expect(artifacts.length).toBeGreaterThanOrEqual(1);
    const authArtifact = artifacts.find((a) => a.path === "/src/auth.ts");
    expect(authArtifact).toBeDefined();
    expect(authArtifact!.hash).toBeDefined();
    expect(typeof authArtifact!.hash).toBe("string");
    expect((authArtifact!.hash as string).length).toBe(64); // SHA-256 hex = 64 chars

    // provenance array
    const provenance = att.provenance as Array<Record<string, unknown>>;
    expect(provenance).toBeDefined();
    expect(provenance.length).toBeGreaterThanOrEqual(1);
    // At least one provenance entry should reference a session
    const hasSession = provenance.some(
      (p) => p.sessionId !== null && p.sessionId !== undefined
    );
    expect(hasSession).toBe(true);
    // At least one provenance entry should reference a turn
    const hasTurn = provenance.some(
      (p) => p.turnId !== null && p.turnId !== undefined
    );
    expect(hasTurn).toBe(true);

    // intents array
    const intents = att.intents as string[];
    expect(intents).toBeDefined();
    expect(intents.length).toBeGreaterThanOrEqual(1);
    // Our fixture session has initial_intent = "Refactor authentication module"
    expect(intents).toContain("Refactor authentication module");

    // models array
    const models = att.models as string[];
    expect(models).toBeDefined();
    expect(models.length).toBeGreaterThanOrEqual(1);
    expect(models).toContain("claude-sonnet-4-20250514");

    // systemPromptHashes array
    const sysHashes = att.systemPromptHashes as string[];
    expect(sysHashes).toBeDefined();
    expect(sysHashes.length).toBeGreaterThanOrEqual(1);

    // timeRange
    const timeRange = att.timeRange as Record<string, string>;
    expect(timeRange).toBeDefined();
    expect(timeRange.start).toBeDefined();
    expect(timeRange.end).toBeDefined();
    // start must be before or equal to end
    expect(new Date(timeRange.start).getTime()).toBeLessThanOrEqual(
      new Date(timeRange.end).getTime()
    );

    // signature — placeholder "unsigned" until OD-004
    expect(att.signature).toBeDefined();
    expect(typeof att.signature).toBe("string");

    // generatedAt — ISO timestamp
    expect(att.generatedAt).toBeDefined();
    expect(typeof att.generatedAt).toBe("string");
    // Must be a valid date
    expect(isNaN(new Date(att.generatedAt as string).getTime())).toBe(false);
  });

  it("includes provenance from SUPERSEDES chain", async () => {
    const { body, response } = await postJSON(
      "/v1/attestation/generate",
      {
        artifactPaths: ["/src/auth.ts"],
        projectId: IDS.projectAlpha,
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);

    const att = body.attestation as Record<string, unknown>;
    const provenance = att.provenance as Array<Record<string, unknown>>;

    // /src/auth.ts was created in turnArt1 and edited in turnArt2
    // The supersedes chain: turnArt2 -> turnArt1
    // Provenance must include both turns
    const turnIds = provenance.map((p) => p.turnId);
    expect(turnIds).toContain(SPRINT5_IDS.turnArt1);
    expect(turnIds).toContain(SPRINT5_IDS.turnArt2);
  });

  it("handles multiple artifact paths", async () => {
    const { body, response } = await postJSON(
      "/v1/attestation/generate",
      {
        artifactPaths: ["/src/auth.ts", "/src/db.ts"],
        projectId: IDS.projectAlpha,
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);

    const att = body.attestation as Record<string, unknown>;
    const artifacts = att.artifacts as Array<Record<string, unknown>>;

    expect(artifacts.length).toBe(2);
    const paths = artifacts.map((a) => a.path);
    expect(paths).toContain("/src/auth.ts");
    expect(paths).toContain("/src/db.ts");
  });

  // -----------------------------------------------------------------------
  // Authentication
  // -----------------------------------------------------------------------

  it("returns 401 without API key", async () => {
    const { response } = await postJSON("/v1/attestation/generate", {
      artifactPaths: ["/src/auth.ts"],
      projectId: IDS.projectAlpha,
    });

    expect(response.status).toBe(401);
  });

  it("returns 401 with invalid API key", async () => {
    const { response } = await postJSON(
      "/v1/attestation/generate",
      {
        artifactPaths: ["/src/auth.ts"],
        projectId: IDS.projectAlpha,
      },
      API_KEYS.invalid
    );

    expect(response.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // Project scoping
  // -----------------------------------------------------------------------

  it("enforces project scoping: beta key cannot see alpha data", async () => {
    const { body, response } = await postJSON(
      "/v1/attestation/generate",
      {
        artifactPaths: ["/src/auth.ts"],
        projectId: IDS.projectAlpha,
      },
      API_KEYS.beta
    );

    // Either 403 (forbidden) or 200 with empty provenance
    if (response.status === 200) {
      const att = body.attestation as Record<string, unknown>;
      const provenance = att.provenance as Array<Record<string, unknown>>;
      expect(provenance.length).toBe(0);
    } else {
      expect(response.status).toBe(403);
    }
  });

  // -----------------------------------------------------------------------
  // Audit logging
  // -----------------------------------------------------------------------

  it("logs attestation request in audit log", async () => {
    const countBefore = await countAuditLogs();

    await postJSON(
      "/v1/attestation/generate",
      {
        artifactPaths: ["/src/auth.ts"],
        projectId: IDS.projectAlpha,
      },
      API_KEYS.alpha
    );

    const countAfter = await countAuditLogs();
    // Attestation generation must produce an audit log entry
    expect(countAfter).toBeGreaterThan(countBefore);
  });

  // -----------------------------------------------------------------------
  // Negative cases
  // -----------------------------------------------------------------------

  it("returns empty artifacts for nonexistent file paths", async () => {
    const { body, response } = await postJSON(
      "/v1/attestation/generate",
      {
        artifactPaths: ["/does/not/exist.ts"],
        projectId: IDS.projectAlpha,
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    const att = body.attestation as Record<string, unknown>;
    const provenance = att.provenance as Array<Record<string, unknown>>;
    expect(provenance.length).toBe(0);
  });

  it("rejects empty artifactPaths array", async () => {
    const { response } = await postJSON(
      "/v1/attestation/generate",
      {
        artifactPaths: [],
        projectId: IDS.projectAlpha,
      },
      API_KEYS.alpha
    );

    // Should reject with 400 (bad request)
    expect(response.status).toBe(400);
  });

  it("rejects missing projectId", async () => {
    const { response } = await postJSON(
      "/v1/attestation/generate",
      {
        artifactPaths: ["/src/auth.ts"],
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(400);
  });
});
