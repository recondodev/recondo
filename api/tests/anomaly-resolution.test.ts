/**
 * Sprint 8 Deliverable 4: Resolution Tracking API
 *
 * Tests for:
 * - PATCH /v1/anomalies/:id/resolve — marks an anomaly as resolved
 * - Sets resolved_at, resolution_note on the anomaly_events record
 * - Project-scoped, authenticated, audit-logged
 * - 
 *
 * These tests WILL FAIL until the implementation agent builds the endpoints.
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
// Test API keys
// ---------------------------------------------------------------------------

const TEST_KEYS = {
  foundation: "wrt_test_resolve_foundation_01",
  compliance: "wrt_test_resolve_compliance_02",
} as const;

const TEST_KEY_IDS = {
  foundation: "bb400000-0000-4000-8000-000000000001",
  compliance: "bb400000-0000-4000-8000-000000000002",
} as const;

// ---------------------------------------------------------------------------
// Fixed anomaly IDs for resolution tests
// ---------------------------------------------------------------------------

const RESOLVE_IDS = {
  // Anomaly events that belong to alpha project
  anomalyAlpha1: "ff100000-0000-4000-8000-000000000001",
  anomalyAlpha2: "ff100000-0000-4000-8000-000000000002",
  anomalyAlpha3: "ff100000-0000-4000-8000-000000000003",
  // Anomaly event that belongs to beta project
  anomalyBeta1: "ff100000-0000-4000-8000-000000000004",
  // Non-existent anomaly for 404 test
  anomalyNonExistent: "ff100000-0000-4000-8000-999999999999",
} as const;

// ---------------------------------------------------------------------------
// SHA-256 helper
// ---------------------------------------------------------------------------

async function sha256(input: string): Promise<string> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Fixtures: anomaly_events with resolved_at and resolution_note columns
// ---------------------------------------------------------------------------

async function seedResolutionFixtures(): Promise<void> {
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

  // Ensure anomaly_events table has resolved_at and resolution_note columns
  // (Sprint 8 adds these columns; they may not exist in the base setup schema)
  await p.query(`
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
  `);
  await p.query(`
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS resolution_note TEXT;
  `);
  await p.query(`
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS project_id TEXT;
  `);
  await p.query(`
    ALTER TABLE anomaly_events ADD COLUMN IF NOT EXISTS score DOUBLE PRECISION;
  `);

  // Insert anomaly events for alpha project
  await p.query(`
    INSERT INTO anomaly_events (id, session_id, turn_id, anomaly_type, severity, description,
                                 metadata, project_id, score)
    VALUES ($1, $2, NULL, 'cost_spike', 'critical',
            'Session cost $50.00 exceeds 3-sigma threshold of $1.60',
            '{"sessionCost": 50.00, "baselineAvg": 1.00, "stddev": 0.20}'::jsonb,
            $3, 0.95)
    ON CONFLICT (id) DO NOTHING
  `, [RESOLVE_IDS.anomalyAlpha1, IDS.sessionAlpha1, IDS.projectAlpha]);

  await p.query(`
    INSERT INTO anomaly_events (id, session_id, turn_id, anomaly_type, severity, description,
                                 metadata, project_id, score)
    VALUES ($1, $2, NULL, 'latency_spike', 'warning',
            'Turn latency 5000ms exceeds 3-sigma threshold of 160ms',
            '{"latencyMs": 5000, "baselineAvg": 100, "stddev": 20}'::jsonb,
            $3, 0.80)
    ON CONFLICT (id) DO NOTHING
  `, [RESOLVE_IDS.anomalyAlpha2, IDS.sessionAlpha1, IDS.projectAlpha]);

  // A third alpha anomaly for re-resolve testing
  await p.query(`
    INSERT INTO anomaly_events (id, session_id, turn_id, anomaly_type, severity, description,
                                 metadata, project_id, score)
    VALUES ($1, $2, NULL, 'decision_outlier', 'warning',
            'Tool DeployNuke has 0% frequency in baseline',
            '{"toolName": "DeployNuke"}'::jsonb,
            $3, 1.00)
    ON CONFLICT (id) DO NOTHING
  `, [RESOLVE_IDS.anomalyAlpha3, IDS.sessionAlpha1, IDS.projectAlpha]);

  // Insert anomaly event for beta project
  await p.query(`
    INSERT INTO anomaly_events (id, session_id, turn_id, anomaly_type, severity, description,
                                 metadata, project_id, score)
    VALUES ($1, $2, NULL, 'rejection_pattern', 'warning',
            '4 consecutive Bash failures',
            '{"consecutiveFailures": 4}'::jsonb,
            $3, 0.40)
    ON CONFLICT (id) DO NOTHING
  `, [RESOLVE_IDS.anomalyBeta1, IDS.sessionBeta1, IDS.projectBeta]);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function patchJSON(
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
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });

  const responseBody = (await response.json()) as Record<string, unknown>;
  return { body: responseBody, response };
}

async function getJSON(
  path: string,
  apiKey?: string
): Promise<{ body: Record<string, unknown>; response: Response }> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "GET",
    headers,
  });

  const body = (await response.json()) as Record<string, unknown>;
  return { body, response };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedResolutionFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// PATCH /v1/anomalies/:id/resolve
// =========================================================================

describe("PATCH /v1/anomalies/:id/resolve", () => {
  it("sets resolved_at and resolution_note on the anomaly", async () => {
    const { body, response } = await patchJSON(
      `/v1/anomalies/${RESOLVE_IDS.anomalyAlpha1}/resolve`,
      { resolutionNote: "Investigated - authorized model change" },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);

    // Response should contain the updated anomaly
    const anomaly = (body.anomaly || body) as Record<string, unknown>;
    expect(anomaly).toBeDefined();

    // resolved_at should be set
    const resolvedAt = anomaly.resolvedAt || anomaly.resolved_at;
    expect(resolvedAt).toBeDefined();
    expect(resolvedAt).not.toBeNull();

    // resolution_note should be set
    const note = anomaly.resolutionNote || anomaly.resolution_note;
    expect(note).toBe("Investigated - authorized model change");
  });

  it("resolved anomaly shows resolved_at in subsequent GET", async () => {
    // Resolve the anomaly
    await patchJSON(
      `/v1/anomalies/${RESOLVE_IDS.anomalyAlpha2}/resolve`,
      { resolutionNote: "False positive - expected latency during deployment" },
      API_KEYS.alpha
    );

    // Fetch anomalies and verify the resolved one has resolved_at
    const { body } = await getJSON(
      `/v1/anomaly-detection/anomalies?projectId=${IDS.projectAlpha}`,
      API_KEYS.alpha
    );

    const anomalies = body.anomalies as Array<Record<string, unknown>>;
    const resolved = anomalies.find((a) => {
      const id = String(a.id || "");
      return id === RESOLVE_IDS.anomalyAlpha2;
    });

    if (resolved) {
      const resolvedAt = resolved.resolvedAt || resolved.resolved_at;
      expect(resolvedAt).toBeDefined();
      expect(resolvedAt).not.toBeNull();
    }
  });

  it("resolution note is stored correctly in DB", async () => {
    const resolutionNote = "Verified: this was an authorized spike for batch processing";

    await patchJSON(
      `/v1/anomalies/${RESOLVE_IDS.anomalyAlpha3}/resolve`,
      { resolutionNote },
      API_KEYS.alpha
    );

    // Verify in the database directly
    const p = getPool();
    const result = await p.query(`
      SELECT resolved_at, resolution_note FROM anomaly_events WHERE id = $1
    `, [RESOLVE_IDS.anomalyAlpha3]);

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].resolved_at).not.toBeNull();
    expect(result.rows[0].resolution_note).toBe(resolutionNote);
  });

  it("cannot resolve anomaly from another project (403)", async () => {
    // Alpha key tries to resolve beta's anomaly
    const { response } = await patchJSON(
      `/v1/anomalies/${RESOLVE_IDS.anomalyBeta1}/resolve`,
      { resolutionNote: "Should not be allowed" },
      API_KEYS.alpha
    );

    // Should be forbidden — alpha cannot resolve beta's anomalies
    expect(response.status).toBe(403);
  });

  it("returns 404 for nonexistent anomaly", async () => {
    const { response } = await patchJSON(
      `/v1/anomalies/${RESOLVE_IDS.anomalyNonExistent}/resolve`,
      { resolutionNote: "This anomaly does not exist" },
      API_KEYS.alpha
    );

    expect(response.status).toBe(404);
  });

  it("returns 401 without API key", async () => {
    const { response } = await patchJSON(
      `/v1/anomalies/${RESOLVE_IDS.anomalyAlpha1}/resolve`,
      { resolutionNote: "No auth" }
    );

    expect(response.status).toBe(401);
  });

  it("is audit logged", async () => {
    const countBefore = await countAuditLogs();

    await patchJSON(
      `/v1/anomalies/${RESOLVE_IDS.anomalyAlpha1}/resolve`,
      { resolutionNote: "Audit log test" },
      API_KEYS.alpha
    );

    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });

  it("authenticated key can resolve anomalies", async () => {
    const { response } = await patchJSON(
      `/v1/anomalies/${RESOLVE_IDS.anomalyAlpha1}/resolve`,
      { resolutionNote: "Resolution note" },
      TEST_KEYS.compliance
    );

    // Authenticated key has access
    expect(response.status).not.toBe(403);
  });

  it("admin key can resolve any project's anomaly", async () => {
    // Admin resolves beta's anomaly (cross-project access)
    const { body, response } = await patchJSON(
      `/v1/anomalies/${RESOLVE_IDS.anomalyBeta1}/resolve`,
      { resolutionNote: "Admin cross-project resolution" },
      API_KEYS.admin
    );

    expect(response.status).toBe(200);

    const anomaly = (body.anomaly || body) as Record<string, unknown>;
    const resolvedAt = anomaly.resolvedAt || anomaly.resolved_at;
    expect(resolvedAt).toBeDefined();
    expect(resolvedAt).not.toBeNull();
  });

  it("already resolved anomaly can be re-resolved (updates note)", async () => {
    // First resolution
    await patchJSON(
      `/v1/anomalies/${RESOLVE_IDS.anomalyAlpha1}/resolve`,
      { resolutionNote: "First resolution" },
      API_KEYS.alpha
    );

    // Re-resolve with updated note
    const { body, response } = await patchJSON(
      `/v1/anomalies/${RESOLVE_IDS.anomalyAlpha1}/resolve`,
      { resolutionNote: "Updated resolution after further investigation" },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);

    const anomaly = (body.anomaly || body) as Record<string, unknown>;
    const note = anomaly.resolutionNote || anomaly.resolution_note;
    expect(note).toBe("Updated resolution after further investigation");

    // Verify in DB
    const p = getPool();
    const result = await p.query(`
      SELECT resolution_note FROM anomaly_events WHERE id = $1
    `, [RESOLVE_IDS.anomalyAlpha1]);
    expect(result.rows[0].resolution_note).toBe("Updated resolution after further investigation");
  });
});

// =========================================================================
// Resolution tracking — ISO 42001 compliance evidence
// =========================================================================

describe("resolution tracking for ISO 42001 compliance", () => {
  it("resolved_at timestamp is set to current time", async () => {
    const before = new Date();

    const { body } = await patchJSON(
      `/v1/anomalies/${RESOLVE_IDS.anomalyAlpha2}/resolve`,
      { resolutionNote: "Timestamp check" },
      API_KEYS.alpha
    );

    const after = new Date();

    const anomaly = (body.anomaly || body) as Record<string, unknown>;
    const resolvedAt = new Date(String(anomaly.resolvedAt || anomaly.resolved_at));

    // resolved_at should be between before and after the request
    expect(resolvedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5000);
    expect(resolvedAt.getTime()).toBeLessThanOrEqual(after.getTime() + 5000);
  });

  it("resolution creates an evidence chain (anomaly + resolution in DB)", async () => {
    const p = getPool();

    // Resolve an anomaly
    await patchJSON(
      `/v1/anomalies/${RESOLVE_IDS.anomalyAlpha3}/resolve`,
      { resolutionNote: "Evidence chain test - continual improvement" },
      API_KEYS.alpha
    );

    // Verify the full record exists with both detection and resolution data
    const result = await p.query(`
      SELECT id, anomaly_type, severity, description, detected_at,
             resolved_at, resolution_note
      FROM anomaly_events
      WHERE id = $1
    `, [RESOLVE_IDS.anomalyAlpha3]);

    expect(result.rows.length).toBe(1);
    const row = result.rows[0];

    // Detection data
    expect(row.anomaly_type).toBe("decision_outlier");
    expect(row.severity).toBeDefined();
    expect(row.detected_at).toBeDefined();

    // Resolution data (ISO 42001 Cl.10 evidence)
    expect(row.resolved_at).not.toBeNull();
    expect(row.resolution_note).toBe("Evidence chain test - continual improvement");
  });
});
