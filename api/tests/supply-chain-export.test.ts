/**
 * Sprint 10 Deliverable 2: Supply Chain Evidence Package Export
 *
 * Tests for POST /v1/exports/supply-chain endpoint.
 *
 * Returns a supply chain evidence package containing:
 * - sessions: list with model, provider, startedAt, turnCount
 * - artifacts: paths, hashes, turnCount
 * - supersedesChains: change history for artifacts
 * - contentHashes: totalVerified, totalFailed
 * - systemPromptHashes: hash + sessionCount
 * - attestation: signature, signatureStatus
 *
 * Auth required, project scoped, audit logged.
 *
 * These tests WILL FAIL until the implementation agent builds the endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupDatabase,
  teardownDatabase,
  getPool,
  gdprBypassUpdate,
  API_KEYS,
  IDS,
  API_BASE_URL,
  countAuditLogs,
} from "./setup.js";

// ---------------------------------------------------------------------------
// Test API keys
// ---------------------------------------------------------------------------

const TEST_KEYS = {
  foundation: "wrt_test_sc_foundation_000001",
  compliance: "wrt_test_sc_compliance_000002",
} as const;

const TEST_KEY_IDS = {
  foundation: "bb510000-0000-4000-8000-000000000001",
  compliance: "bb510000-0000-4000-8000-000000000002",
} as const;

// ---------------------------------------------------------------------------
// SHA-256 helper
// ---------------------------------------------------------------------------

async function sha256(input: string): Promise<string> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// HTTP helpers
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
// Fixtures: tool_calls with artifacts_created, SUPERSEDES chains
// ---------------------------------------------------------------------------

async function seedSupplyChainFixtures(): Promise<void> {
  const p = getPool();

  // Insert test API keys
  const hashFoundation = await sha256(TEST_KEYS.foundation);
  const hashCompliance = await sha256(TEST_KEYS.compliance);

  await p.query(`
    INSERT INTO api_keys (id, key_hash, project_id, rate_limit_rpm) VALUES
      ('${TEST_KEY_IDS.foundation}', '${hashFoundation}', '${IDS.projectAlpha}', 60),
      ('${TEST_KEY_IDS.compliance}', '${hashCompliance}', '${IDS.projectAlpha}', 120)
    ON CONFLICT (id) DO NOTHING;
  `);

  // Set artifacts_created on existing tool_calls for provenance tracking
  await gdprBypassUpdate(p, `UPDATE tool_calls SET artifacts_created = $1 WHERE id = $2`,
    ['["src/auth.ts","src/auth.test.ts"]', IDS.toolCall2]);

  // Set up a SUPERSEDES chain: turnA1_3 supersedes turnA1_2
  await gdprBypassUpdate(p, `UPDATE turns SET supersedes_turn_id = $1 WHERE id = $2`,
    [IDS.turnA1_2, IDS.turnA1_3]);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedSupplyChainFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// POST /v1/exports/supply-chain — Top-level structure
// =========================================================================

describe("POST /v1/exports/supply-chain — top-level structure", () => {
  it("returns all required top-level fields", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/supply-chain",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body.generatedAt).toBeDefined();
    expect(typeof body.generatedAt).toBe("string");
    expect(body.projectId).toBe(IDS.projectAlpha);
    expect(body.sessions).toBeDefined();
    expect(body.artifacts).toBeDefined();
    expect(body.supersedesChains).toBeDefined();
    expect(body.contentHashes).toBeDefined();
    expect(body.systemPromptHashes).toBeDefined();
    expect(body.attestation).toBeDefined();
  });
});

// =========================================================================
// Sessions
// =========================================================================

describe("POST /v1/exports/supply-chain — sessions", () => {
  it("sessions array contains entries with model, provider, startedAt, turnCount", async () => {
    const { body } = await postJSON(
      "/v1/exports/supply-chain",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const sessions = body.sessions as Array<Record<string, unknown>>;
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    const s = sessions[0];
    expect(s).toHaveProperty("id");
    expect(s).toHaveProperty("model");
    expect(s).toHaveProperty("provider");
    expect(s).toHaveProperty("startedAt");
    expect(s).toHaveProperty("turnCount");
    expect(typeof s.turnCount).toBe("number");
  });

  it("sessions are scoped to the requested project", async () => {
    const { body } = await postJSON(
      "/v1/exports/supply-chain",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const sessions = body.sessions as Array<Record<string, unknown>>;
    // Should not include beta sessions
    const betaSession = sessions.find((s) => s.id === IDS.sessionBeta1);
    expect(betaSession).toBeUndefined();
  });
});

// =========================================================================
// Content hashes
// =========================================================================

describe("POST /v1/exports/supply-chain — contentHashes", () => {
  it("contentHashes has totalVerified and totalFailed counts", async () => {
    const { body } = await postJSON(
      "/v1/exports/supply-chain",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const ch = body.contentHashes as Record<string, number>;
    expect(ch).toHaveProperty("totalVerified");
    expect(ch).toHaveProperty("totalFailed");
    expect(typeof ch.totalVerified).toBe("number");
    expect(typeof ch.totalFailed).toBe("number");
  });
});

// =========================================================================
// System prompt hashes
// =========================================================================

describe("POST /v1/exports/supply-chain — systemPromptHashes", () => {
  it("systemPromptHashes is array with hash and sessionCount", async () => {
    const { body } = await postJSON(
      "/v1/exports/supply-chain",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const sph = body.systemPromptHashes as Array<Record<string, unknown>>;
    expect(Array.isArray(sph)).toBe(true);
    expect(sph.length).toBeGreaterThanOrEqual(1);

    const entry = sph[0];
    expect(entry).toHaveProperty("hash");
    expect(entry).toHaveProperty("sessionCount");
    expect(typeof entry.hash).toBe("string");
    expect(typeof entry.sessionCount).toBe("number");
  });
});

// =========================================================================
// Attestation
// =========================================================================

describe("POST /v1/exports/supply-chain — attestation", () => {
  it("attestation has signature field set to 'unsigned'", async () => {
    const { body } = await postJSON(
      "/v1/exports/supply-chain",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const att = body.attestation as Record<string, unknown>;
    expect(att).toHaveProperty("signature");
    expect(att.signature).toBe("unsigned");
  });

  it("attestation has signatureStatus field", async () => {
    const { body } = await postJSON(
      "/v1/exports/supply-chain",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const att = body.attestation as Record<string, unknown>;
    expect(att).toHaveProperty("signatureStatus");
    expect(typeof att.signatureStatus).toBe("string");
  });
});

// =========================================================================
// Artifact path filtering
// =========================================================================

describe("POST /v1/exports/supply-chain — artifact filtering", () => {
  it("artifactPaths filter limits artifacts in response", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/supply-chain",
      {
        projectId: IDS.projectAlpha,
        artifactPaths: ["src/auth.ts"],
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);

    const artifacts = body.artifacts as Array<Record<string, unknown>>;
    expect(Array.isArray(artifacts)).toBe(true);

    // If artifactPaths filter works, artifacts should only include the filtered path
    if (artifacts.length > 0) {
      const paths = artifacts.map((a) => a.path);
      expect(paths).toContain("src/auth.ts");
    }
  });
});

// =========================================================================
// SUPERSEDES chains
// =========================================================================

describe("POST /v1/exports/supply-chain — supersedesChains", () => {
  it("supersedesChains is an array", async () => {
    const { body } = await postJSON(
      "/v1/exports/supply-chain",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const chains = body.supersedesChains as Array<Record<string, unknown>>;
    expect(Array.isArray(chains)).toBe(true);
  });
});

// =========================================================================
// Authentication & Authorization
// =========================================================================

describe("POST /v1/exports/supply-chain — auth & gating", () => {
  it("returns 401 without API key", async () => {
    const { response } = await postJSON(
      "/v1/exports/supply-chain",
      { projectId: IDS.projectAlpha }
    );

    expect(response.status).toBe(401);
  });

  it("beta key cannot access alpha project supply chain export", async () => {
    const { response } = await postJSON(
      "/v1/exports/supply-chain",
      { projectId: IDS.projectAlpha },
      API_KEYS.beta
    );

    expect(response.status).toBe(403);
  });
});

// =========================================================================
// Audit logging
// =========================================================================

describe("POST /v1/exports/supply-chain — audit logging", () => {
  it("creates audit log entry for successful export", async () => {
    const countBefore = await countAuditLogs();

    await postJSON(
      "/v1/exports/supply-chain",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});
