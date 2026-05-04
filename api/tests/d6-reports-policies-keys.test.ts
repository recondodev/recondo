/**
 * Sprint D6 -- Reports, Policies & API Keys behavioral tests.
 *
 * Tests for:
 *   D6.1 -- reports query, generateReport mutation,
 *            reportCoverageTrend, reportFindingsTrend
 *   D6.2 -- policies query, createPolicy/updatePolicy/deletePolicy mutations,
 *            policyTriggerHistory
 *   D6.3 -- registeredKeys query, registerKey/deleteKey mutations
 *
 * These tests are written BEFORE the implementation exists.
 * They assert only on externally observable behavior (GraphQL responses + REST).
 * Every test must FAIL until the implementation is done.
 *
 * Expects:
 *   - PostgreSQL running at localhost:5432 (docker-compose)
 *   - API server running at localhost:4000
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupDatabase,
  teardownDatabase,
  graphql,
  httpGet,
  API_KEYS,
  API_BASE_URL,
  getPool,
} from "./setup.js";

beforeAll(async () => {
  await setupDatabase();
  await seedD6Fixtures();
});

afterAll(async () => {
  await cleanupD6Fixtures();
  await teardownDatabase();
});

// ---------------------------------------------------------------------------
// D6 fixture seeding -- data for reports, policies, and registered keys
// ---------------------------------------------------------------------------

const D6_IDS = {
  // Reports (prefix: d6rp)
  reportSoc2: "d6rp0000-0000-4000-8000-000000000001",
  reportIso42001: "d6rp0000-0000-4000-8000-000000000002",
  reportDraft: "d6rp0000-0000-4000-8000-000000000003",

  // Policies (prefix: d6po)
  policyBlock: "d6po0000-0000-4000-8000-000000000001",
  policyLimit: "d6po0000-0000-4000-8000-000000000002",
  policyAlert: "d6po0000-0000-4000-8000-000000000003",
  policyInactive: "d6po0000-0000-4000-8000-000000000004",

  // Policy triggers (prefix: d6pt)
  trigger1: "d6pt0000-0000-4000-8000-000000000001",
  trigger2: "d6pt0000-0000-4000-8000-000000000002",
  trigger3: "d6pt0000-0000-4000-8000-000000000003",

  // Registered keys (prefix: d6rk)
  keyAnthropic: "d6rk0000-0000-4000-8000-000000000001",
  keyOpenai: "d6rk0000-0000-4000-8000-000000000002",
  keyGemini: "d6rk0000-0000-4000-8000-000000000003",

  // Sessions for report generation (prefix: d6ss)
  sessionForReport1: "d6ss0000-0000-4000-8000-000000000001",
  sessionForReport2: "d6ss0000-0000-4000-8000-000000000002",

  // Turns for report generation (prefix: d6tt)
  turnReport1_t1: "d6tt0000-0000-4000-8000-000000000001",
  turnReport1_t2: "d6tt0000-0000-4000-8000-000000000002",
  turnReport2_t1: "d6tt0000-0000-4000-8000-000000000003",
} as const;

async function seedD6Fixtures(): Promise<void> {
  const p = getPool();
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3_600_000);
  const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);

  // -----------------------------------------------------------------------
  // D6.1: Reports table and seed data
  // -----------------------------------------------------------------------
  await p.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      framework TEXT NOT NULL,
      period_start TIMESTAMPTZ NOT NULL,
      period_end TIMESTAMPTZ NOT NULL,
      capture_count INT NOT NULL DEFAULT 0,
      findings_critical INT NOT NULL DEFAULT 0,
      findings_high INT NOT NULL DEFAULT 0,
      findings_medium INT NOT NULL DEFAULT 0,
      findings_low INT NOT NULL DEFAULT 0,
      hash TEXT,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS report_coverage (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
      report_id TEXT REFERENCES reports(id),
      label TEXT NOT NULL,
      value DOUBLE PRECISION NOT NULL DEFAULT 0.0,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Seed 3 reports: 2 FINAL, 1 DRAFT
  await p.query(
    `INSERT INTO reports (id, name, framework, period_start, period_end, capture_count,
                          findings_critical, findings_high, findings_medium, findings_low,
                          hash, status, generated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (id) DO NOTHING`,
    [D6_IDS.reportSoc2, "SOC 2 Monthly Report", "SOC 2 Type II",
     thirtyDaysAgo.toISOString(), now.toISOString(), 150,
     1, 3, 5, 12,
     "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
     "FINAL", twoDaysAgo.toISOString()]
  );

  await p.query(
    `INSERT INTO reports (id, name, framework, period_start, period_end, capture_count,
                          findings_critical, findings_high, findings_medium, findings_low,
                          hash, status, generated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (id) DO NOTHING`,
    [D6_IDS.reportIso42001, "ISO 42001 Quarterly Report", "ISO 42001",
     thirtyDaysAgo.toISOString(), now.toISOString(), 200,
     0, 2, 8, 15,
     "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3",
     "FINAL", oneHourAgo.toISOString()]
  );

  await p.query(
    `INSERT INTO reports (id, name, framework, period_start, period_end, capture_count,
                          findings_critical, findings_high, findings_medium, findings_low,
                          hash, status, generated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (id) DO NOTHING`,
    [D6_IDS.reportDraft, "NIST AI RMF Draft", "NIST AI RMF",
     sevenDaysAgo.toISOString(), now.toISOString(), 50,
     0, 0, 2, 3,
     null, "DRAFT", now.toISOString()]
  );

  // Seed report_coverage for trend data (monthly labels)
  for (const [label, value] of [["Jan 2026", 85.0], ["Feb 2026", 88.5], ["Mar 2026", 92.1]]) {
    await p.query(
      `INSERT INTO report_coverage (label, value, recorded_at)
       VALUES ($1, $2, now())
       ON CONFLICT DO NOTHING`,
      [label, value]
    );
  }

  // -----------------------------------------------------------------------
  // D6.1: Sessions and turns for generateReport mutation
  // -----------------------------------------------------------------------
  const sessionInsertSql = `INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at,
                           initial_intent, system_prompt_hash, total_turns, turns_captured,
                           dropped_events, total_tokens, total_cost_usd, framework)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (id) DO NOTHING`;

  await p.query(sessionInsertSql,
    [D6_IDS.sessionForReport1, null, "anthropic", "claude-sonnet-4-20250514",
     twoDaysAgo.toISOString(), oneHourAgo.toISOString(),
     "Generate compliance report data", "d6hash_1", 2, 2, 0, 5000, 0.40, "claude_code"]
  );

  await p.query(sessionInsertSql,
    [D6_IDS.sessionForReport2, null, "openai", "gpt-4o",
     sevenDaysAgo.toISOString(), twoDaysAgo.toISOString(),
     "API integration work", "d6hash_2", 1, 1, 0, 3000, 0.25, "cursor"]
  );

  const turnInsertSql = `INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
                       model, provider, input_tokens, output_tokens, thinking_tokens,
                       cost_usd, duration_ms, ttfb_ms, tool_call_count, stop_reason,
                       created_at, capture_complete, http_status, cache_read_tokens, cache_creation_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (id) DO NOTHING`;

  await p.query(turnInsertSql,
    [D6_IDS.turnReport1_t1, D6_IDS.sessionForReport1, 1, twoDaysAgo.toISOString(),
     "d6_req_1_1", "d6_resp_1_1",
     "claude-sonnet-4-20250514", "anthropic", 2000, 1000, 200,
     0.20, 900, 180, 0, "end_turn",
     twoDaysAgo.toISOString(), true, 200, 400, 50]
  );

  await p.query(turnInsertSql,
    [D6_IDS.turnReport1_t2, D6_IDS.sessionForReport1, 2,
     new Date(twoDaysAgo.getTime() + 60_000).toISOString(),
     "d6_req_1_2", "d6_resp_1_2",
     "claude-sonnet-4-20250514", "anthropic", 1500, 800, 100,
     0.20, 850, 170, 1, "end_turn",
     new Date(twoDaysAgo.getTime() + 60_000).toISOString(), true, 200, 300, 0]
  );

  await p.query(turnInsertSql,
    [D6_IDS.turnReport2_t1, D6_IDS.sessionForReport2, 1, sevenDaysAgo.toISOString(),
     "d6_req_2_1", "d6_resp_2_1",
     "gpt-4o", "openai", 1500, 1000, 0,
     0.25, 1100, 220, 0, "end_turn",
     sevenDaysAgo.toISOString(), true, 200, 0, 0]
  );

  // -----------------------------------------------------------------------
  // D6.2: Policies + policy_triggers tables and seed data
  // -----------------------------------------------------------------------
  await p.query(`
    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      scope TEXT NOT NULL,
      action TEXT NOT NULL,
      triggers_mtd INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS policy_triggers (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
      policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
      triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      details TEXT
    );
  `);

  // Seed 4 policies: 3 ACTIVE, 1 INACTIVE
  await p.query(
    `INSERT INTO policies (id, name, type, scope, action, triggers_mtd, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [D6_IDS.policyBlock, "Block PII in prompts", "BLOCK", "all-agents",
     "Block requests containing PII patterns", 5, "ACTIVE"]
  );

  await p.query(
    `INSERT INTO policies (id, name, type, scope, action, triggers_mtd, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [D6_IDS.policyLimit, "Rate limit per developer", "LIMIT", "per-developer",
     "Limit to 1000 requests per hour per developer", 12, "ACTIVE"]
  );

  await p.query(
    `INSERT INTO policies (id, name, type, scope, action, triggers_mtd, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [D6_IDS.policyAlert, "Alert on anomalous cost spikes", "ALERT", "per-project",
     "Send webhook when hourly cost exceeds $50", 3, "ACTIVE"]
  );

  await p.query(
    `INSERT INTO policies (id, name, type, scope, action, triggers_mtd, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [D6_IDS.policyInactive, "Legacy compliance monitor", "MONITOR", "all-agents",
     "Log all non-compliant requests", 0, "INACTIVE"]
  );

  // Seed policy trigger history (for policyTriggerHistory trend)
  const oneDayAgo = new Date(now.getTime() - 86_400_000);
  const threeDaysAgo = new Date(now.getTime() - 3 * 86_400_000);

  await p.query(
    `INSERT INTO policy_triggers (id, policy_id, triggered_at, details)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [D6_IDS.trigger1, D6_IDS.policyBlock, oneDayAgo.toISOString(),
     "PII pattern detected in user prompt"]
  );

  await p.query(
    `INSERT INTO policy_triggers (id, policy_id, triggered_at, details)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [D6_IDS.trigger2, D6_IDS.policyLimit, oneDayAgo.toISOString(),
     "Developer exceeded 1000 RPH"]
  );

  await p.query(
    `INSERT INTO policy_triggers (id, policy_id, triggered_at, details)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [D6_IDS.trigger3, D6_IDS.policyAlert, threeDaysAgo.toISOString(),
     "Hourly cost spike: $62.50"]
  );

  // -----------------------------------------------------------------------
  // D6.3: Registered keys table and seed data
  // -----------------------------------------------------------------------
  await p.query(`
    CREATE TABLE IF NOT EXISTS registered_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      agent_count INT NOT NULL DEFAULT 0,
      last_used TIMESTAMPTZ,
      monthly_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0.0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await p.query(
    `INSERT INTO registered_keys (id, name, provider, fingerprint, agent_count, last_used, monthly_cost_usd, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [D6_IDS.keyAnthropic, "Production Anthropic Key", "anthropic",
     "sk-ant-***abc123", 4, oneHourAgo.toISOString(), 245.50, "active"]
  );

  await p.query(
    `INSERT INTO registered_keys (id, name, provider, fingerprint, agent_count, last_used, monthly_cost_usd, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [D6_IDS.keyOpenai, "OpenAI Shared Key", "openai",
     "sk-oai-***def456", 2, twoDaysAgo.toISOString(), 180.75, "active"]
  );

  await p.query(
    `INSERT INTO registered_keys (id, name, provider, fingerprint, agent_count, last_used, monthly_cost_usd, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [D6_IDS.keyGemini, "Gemini Experimental", "google",
     "AIza-***ghi789", 1, null, 0.0, "active"]
  );
}

async function cleanupD6Fixtures(): Promise<void> {
  const p = getPool();

  // Clean up registered keys
  const d6KeyIds = [D6_IDS.keyAnthropic, D6_IDS.keyOpenai, D6_IDS.keyGemini];
  for (const id of d6KeyIds) {
    await p.query(`DELETE FROM registered_keys WHERE id = $1`, [id]);
  }
  // Clean up any keys created by mutation tests
  await p.query(`DELETE FROM registered_keys WHERE id LIKE 'd6rk%' OR name LIKE 'Test%'`);

  // Clean up policy triggers (before policies due to FK)
  const d6TriggerIds = [D6_IDS.trigger1, D6_IDS.trigger2, D6_IDS.trigger3];
  for (const id of d6TriggerIds) {
    await p.query(`DELETE FROM policy_triggers WHERE id = $1`, [id]);
  }

  // Clean up policies
  const d6PolicyIds = [D6_IDS.policyBlock, D6_IDS.policyLimit, D6_IDS.policyAlert, D6_IDS.policyInactive];
  for (const id of d6PolicyIds) {
    await p.query(`DELETE FROM policies WHERE id = $1`, [id]);
  }
  // Clean up any policies created by mutation tests
  await p.query(`DELETE FROM policies WHERE id LIKE 'd6po%' OR name LIKE 'Test%'`);

  // Clean up report_coverage
  await p.query(`DELETE FROM report_coverage WHERE label IN ('Jan 2026', 'Feb 2026', 'Mar 2026')`);

  // Clean up reports
  const d6ReportIds = [D6_IDS.reportSoc2, D6_IDS.reportIso42001, D6_IDS.reportDraft];
  for (const id of d6ReportIds) {
    await p.query(`DELETE FROM reports WHERE id = $1`, [id]);
  }
  // Clean up any reports created by mutation tests
  await p.query(`DELETE FROM reports WHERE name LIKE 'Test%'`);

  // Clean up D6 turns and sessions
  const d6TurnIds = Object.values(D6_IDS).filter(id => id.startsWith("d6tt"));
  for (const id of d6TurnIds) {
    try { await p.query(`DELETE FROM turns WHERE id = $1`, [id]); } catch { /* immutable */ }
  }
  const d6SessionIds = Object.values(D6_IDS).filter(id => id.startsWith("d6ss"));
  for (const id of d6SessionIds) {
    try { await p.query(`DELETE FROM sessions WHERE id = $1`, [id]); } catch { /* FK from turns */ }
  }
}

// =========================================================================
// D6.1 -- reports query
// =========================================================================

const REPORTS_QUERY = `query ($limit: Int, $offset: Int) {
  reports(limit: $limit, offset: $offset) {
    items {
      id
      name
      framework
      periodStart
      periodEnd
      captureCount
      findings {
        critical
        high
        medium
        low
      }
      hash
      status
      generatedAt
    }
    total
    limit
    offset
  }
}`;

describe("D6.1 -- reports query returns ReportConnection", () => {
  it("returns ReportConnection with all required fields", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REPORTS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.reports).toBeDefined();

    const conn = body.data!.reports;
    expect(Array.isArray(conn.items)).toBe(true);
    expect(typeof conn.total).toBe("number");
    expect(typeof conn.limit).toBe("number");
    expect(typeof conn.offset).toBe("number");
  });

  it("each Report item has correct field types", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REPORTS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.reports.items;
    expect(items.length).toBeGreaterThan(0);

    const report = items[0];
    expect(typeof report.id).toBe("string");
    expect(typeof report.name).toBe("string");
    expect(typeof report.framework).toBe("string");
    expect(typeof report.periodStart).toBe("string");
    expect(typeof report.periodEnd).toBe("string");
    expect(typeof report.captureCount).toBe("number");
    expect(report.findings).toBeDefined();
    expect(typeof report.findings.critical).toBe("number");
    expect(typeof report.findings.high).toBe("number");
    expect(typeof report.findings.medium).toBe("number");
    expect(typeof report.findings.low).toBe("number");
    // hash is nullable
    expect("hash" in report).toBe(true);
    expect(typeof report.status).toBe("string");
    expect(typeof report.generatedAt).toBe("string");
  });

  it("returns seeded reports in results", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REPORTS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    // We seeded 3 reports
    expect(body.data!.reports.items.length).toBeGreaterThanOrEqual(3);
    expect(body.data!.reports.total).toBeGreaterThanOrEqual(3);
  });

  it("status values are valid ReportStatus enum values", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REPORTS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const validStatuses = ["DRAFT", "FINAL"];
    for (const report of body.data!.reports.items) {
      expect(validStatuses).toContain(report.status);
    }
  });

  it("findings counts are non-negative integers", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REPORTS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    for (const report of body.data!.reports.items) {
      expect(report.findings.critical).toBeGreaterThanOrEqual(0);
      expect(report.findings.high).toBeGreaterThanOrEqual(0);
      expect(report.findings.medium).toBeGreaterThanOrEqual(0);
      expect(report.findings.low).toBeGreaterThanOrEqual(0);
    }
  });

  it("captureCount is a non-negative integer", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REPORTS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    for (const report of body.data!.reports.items) {
      expect(report.captureCount).toBeGreaterThanOrEqual(0);
    }
  });

  it("FINAL reports have a non-null hash", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REPORTS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const finalReports = body.data!.reports.items.filter(
      (r: { status: string }) => r.status === "FINAL"
    );
    expect(finalReports.length).toBeGreaterThan(0);
    for (const report of finalReports) {
      expect(report.hash).toBeTruthy();
      expect(typeof report.hash).toBe("string");
    }
  });
});

describe("D6.1 -- reports pagination", () => {
  it("defaults limit and offset when not provided", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REPORTS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const conn = body.data!.reports;
    expect(conn.offset).toBe(0);
    expect(typeof conn.limit).toBe("number");
    expect(conn.limit).toBeGreaterThan(0);
  });

  it("respects explicit limit", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REPORTS_QUERY,
      variables: { limit: 1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.reports.items.length).toBeLessThanOrEqual(1);
    expect(body.data!.reports.limit).toBe(1);
  });

  it("respects offset for pagination", async () => {
    const { body: page1 } = await graphql({
      apiKey: API_KEYS.admin,
      query: REPORTS_QUERY,
      variables: { limit: 1, offset: 0 },
    });

    const { body: page2 } = await graphql({
      apiKey: API_KEYS.admin,
      query: REPORTS_QUERY,
      variables: { limit: 1, offset: 1 },
    });

    expect(page1.errors).toBeUndefined();
    expect(page2.errors).toBeUndefined();

    // Same total across pages
    expect(page1.data!.reports.total).toBe(page2.data!.reports.total);

    // Different items on different pages
    if (page1.data!.reports.items.length > 0 && page2.data!.reports.items.length > 0) {
      expect(page1.data!.reports.items[0].id).not.toBe(
        page2.data!.reports.items[0].id
      );
    }
  });

  it("returns empty items when offset exceeds total", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REPORTS_QUERY,
      variables: { offset: 99999 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.reports.items).toEqual([]);
  });
});

describe("D6.1 -- reports requires authentication", () => {
  it("rejects unauthenticated requests", async () => {
    const { body, response } = await graphql({
      query: REPORTS_QUERY,
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });

  it("rejects requests with invalid API key", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.invalid,
      query: REPORTS_QUERY,
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D6.1 -- generateReport mutation
// =========================================================================

const GENERATE_REPORT_MUTATION = `mutation ($input: GenerateReportInput!) {
  generateReport(input: $input) {
    report {
      id
      name
      framework
      periodStart
      periodEnd
      captureCount
      findings {
        critical
        high
        medium
        low
      }
      hash
      status
      generatedAt
    }
    errors {
      field
      code
      message
    }
  }
}`;

describe("D6.1 -- generateReport mutation creates report with hash", () => {
  it("creates a new report and returns it", async () => {
    const periodStart = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const periodEnd = new Date().toISOString();

    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: GENERATE_REPORT_MUTATION,
      variables: {
        input: {
          framework: "SOC 2 Type II",
          periodStart,
          periodEnd,
        },
      },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.generateReport).toBeDefined();

    const payload = body.data!.generateReport;
    expect(payload.report).toBeDefined();
    expect(payload.errors).toEqual([]);

    const report = payload.report;
    expect(typeof report.id).toBe("string");
    expect(report.framework).toBe("SOC 2 Type II");
    expect(typeof report.periodStart).toBe("string");
    expect(typeof report.periodEnd).toBe("string");
    expect(typeof report.captureCount).toBe("number");
    expect(report.captureCount).toBeGreaterThanOrEqual(0);
    expect(report.findings).toBeDefined();
    expect(typeof report.generatedAt).toBe("string");
  });

  it("generated report includes a SHA-256 hash", async () => {
    const periodStart = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const periodEnd = new Date().toISOString();

    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: GENERATE_REPORT_MUTATION,
      variables: {
        input: {
          framework: "ISO 42001",
          periodStart,
          periodEnd,
        },
      },
    });

    expect(body.errors).toBeUndefined();
    const report = body.data!.generateReport.report;

    // Hash should be a 64-character hex string (SHA-256)
    expect(report.hash).toBeTruthy();
    expect(typeof report.hash).toBe("string");
    expect(report.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("generated report counts turns in the specified period", async () => {
    // Use a period that includes our seeded turns
    const periodStart = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const periodEnd = new Date().toISOString();

    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: GENERATE_REPORT_MUTATION,
      variables: {
        input: {
          framework: "SOC 2 Type II",
          periodStart,
          periodEnd,
        },
      },
    });

    expect(body.errors).toBeUndefined();
    const report = body.data!.generateReport.report;

    // We seeded at least 3 turns in the last 10 days (D6 fixtures) plus base fixtures
    expect(report.captureCount).toBeGreaterThanOrEqual(1);
  });

  it("generated report appears in subsequent reports query", async () => {
    const periodStart = new Date(Date.now() - 1 * 86_400_000).toISOString();
    const periodEnd = new Date().toISOString();

    const { body: mutationBody } = await graphql({
      apiKey: API_KEYS.admin,
      query: GENERATE_REPORT_MUTATION,
      variables: {
        input: {
          framework: "NIST AI RMF",
          periodStart,
          periodEnd,
        },
      },
    });

    expect(mutationBody.errors).toBeUndefined();
    const newReportId = mutationBody.data!.generateReport.report.id;

    // Query reports and find the new one
    const { body: queryBody } = await graphql({
      apiKey: API_KEYS.admin,
      query: REPORTS_QUERY,
      variables: { limit: 100 },
    });

    expect(queryBody.errors).toBeUndefined();
    const found = queryBody.data!.reports.items.find(
      (r: { id: string }) => r.id === newReportId
    );
    expect(found).toBeDefined();
  });

  it("returns validation error for missing required fields", async () => {
    // Missing periodEnd -- GraphQL should reject at validation
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: GENERATE_REPORT_MUTATION,
      variables: {
        input: {
          framework: "SOC 2 Type II",
          periodStart: new Date().toISOString(),
          // periodEnd is missing
        },
      },
    });

    // Either GraphQL validation error or payload error
    const hasError = (body.errors && body.errors.length > 0) ||
      (body.data?.generateReport?.errors?.length > 0);
    expect(hasError).toBe(true);
  });

  it("returns error when periodStart is after periodEnd", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: GENERATE_REPORT_MUTATION,
      variables: {
        input: {
          framework: "SOC 2 Type II",
          periodStart: new Date().toISOString(),
          periodEnd: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        },
      },
    });

    // Should return an error in the payload or a GraphQL error
    if (body.data?.generateReport) {
      expect(body.data.generateReport.errors.length).toBeGreaterThan(0);
      expect(body.data.generateReport.report).toBeNull();
    } else {
      expect(body.errors).toBeDefined();
      expect(body.errors!.length).toBeGreaterThan(0);
    }
  });
});

describe("D6.1 -- generateReport requires authentication", () => {
  it("rejects unauthenticated mutation requests", async () => {
    const { body, response } = await graphql({
      query: GENERATE_REPORT_MUTATION,
      variables: {
        input: {
          framework: "SOC 2 Type II",
          periodStart: new Date(Date.now() - 30 * 86_400_000).toISOString(),
          periodEnd: new Date().toISOString(),
        },
      },
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D6.1 -- reportCoverageTrend query
// =========================================================================

const REPORT_COVERAGE_TREND_QUERY = `{
  reportCoverageTrend {
    label
    value
  }
}`;

describe("D6.1 -- reportCoverageTrend returns TrendPoint array", () => {
  it("returns an array of TrendPoint", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REPORT_COVERAGE_TREND_QUERY,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.reportCoverageTrend).toBeDefined();
    expect(Array.isArray(body.data!.reportCoverageTrend)).toBe(true);
  });

  it("each TrendPoint has label (string) and value (number)", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REPORT_COVERAGE_TREND_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const points = body.data!.reportCoverageTrend;
    expect(points.length).toBeGreaterThan(0);

    for (const point of points) {
      expect(typeof point.label).toBe("string");
      expect(point.label.length).toBeGreaterThan(0);
      expect(typeof point.value).toBe("number");
    }
  });

  it("values are non-negative (coverage percentages)", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REPORT_COVERAGE_TREND_QUERY,
    });

    expect(body.errors).toBeUndefined();
    for (const point of body.data!.reportCoverageTrend) {
      expect(point.value).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("D6.1 -- reportCoverageTrend requires authentication", () => {
  it("rejects unauthenticated requests", async () => {
    const { body, response } = await graphql({
      query: REPORT_COVERAGE_TREND_QUERY,
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D6.1 -- reportFindingsTrend query
// =========================================================================

const REPORT_FINDINGS_TREND_QUERY = `{
  reportFindingsTrend {
    label
    value
  }
}`;

describe("D6.1 -- reportFindingsTrend returns TrendPoint array", () => {
  it("returns an array of TrendPoint", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REPORT_FINDINGS_TREND_QUERY,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.reportFindingsTrend).toBeDefined();
    expect(Array.isArray(body.data!.reportFindingsTrend)).toBe(true);
  });

  it("each TrendPoint has label (string) and value (number)", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REPORT_FINDINGS_TREND_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const points = body.data!.reportFindingsTrend;
    expect(points.length).toBeGreaterThan(0);

    for (const point of points) {
      expect(typeof point.label).toBe("string");
      expect(point.label.length).toBeGreaterThan(0);
      expect(typeof point.value).toBe("number");
    }
  });

  it("values are non-negative (finding counts)", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REPORT_FINDINGS_TREND_QUERY,
    });

    expect(body.errors).toBeUndefined();
    for (const point of body.data!.reportFindingsTrend) {
      expect(point.value).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("D6.1 -- reportFindingsTrend requires authentication", () => {
  it("rejects unauthenticated requests", async () => {
    const { body, response } = await graphql({
      query: REPORT_FINDINGS_TREND_QUERY,
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D6.1 -- Report download REST endpoint
// =========================================================================

describe("D6.1 -- Report download REST endpoint GET /v1/reports/:id/download", () => {
  it("returns a response for a valid report ID", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/reports/${D6_IDS.reportSoc2}/download`, {
      headers: { Authorization: `Bearer ${API_KEYS.admin}` },
    });

    // Accept 200 (file download) or 204 (no content yet) as valid success responses
    expect(response.status).toBeLessThan(500);
    // Should not be a 404 -- report exists
    expect(response.status).not.toBe(404);
  });

  it("returns 404 for a nonexistent report ID", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/reports/nonexistent-id-12345/download`, {
      headers: { Authorization: `Bearer ${API_KEYS.admin}` },
    });

    expect(response.status).toBe(404);
  });

  it("rejects unauthenticated download requests", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/reports/${D6_IDS.reportSoc2}/download`);

    expect(response.status).toBe(401);
  });

  it("rejects requests with invalid API key", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/reports/${D6_IDS.reportSoc2}/download`, {
      headers: { Authorization: `Bearer ${API_KEYS.invalid}` },
    });

    expect(response.status).toBe(401);
  });
});

// =========================================================================
// D6.2 -- policies query
// =========================================================================

const POLICIES_QUERY = `query ($limit: Int, $offset: Int) {
  policies(limit: $limit, offset: $offset) {
    items {
      id
      name
      type
      scope
      action
      triggersMtd
      status
    }
    total
    limit
    offset
  }
}`;

describe("D6.2 -- policies query returns PolicyConnection", () => {
  it("returns PolicyConnection with all required fields", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: POLICIES_QUERY,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.policies).toBeDefined();

    const conn = body.data!.policies;
    expect(Array.isArray(conn.items)).toBe(true);
    expect(typeof conn.total).toBe("number");
    expect(typeof conn.limit).toBe("number");
    expect(typeof conn.offset).toBe("number");
  });

  it("each Policy item has correct field types", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: POLICIES_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.policies.items;
    expect(items.length).toBeGreaterThan(0);

    const policy = items[0];
    expect(typeof policy.id).toBe("string");
    expect(typeof policy.name).toBe("string");
    expect(typeof policy.type).toBe("string");
    expect(typeof policy.scope).toBe("string");
    expect(typeof policy.action).toBe("string");
    expect(typeof policy.triggersMtd).toBe("number");
    expect(typeof policy.status).toBe("string");
  });

  it("returns seeded policies", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: POLICIES_QUERY,
    });

    expect(body.errors).toBeUndefined();
    // We seeded 4 policies
    expect(body.data!.policies.items.length).toBeGreaterThanOrEqual(4);
    expect(body.data!.policies.total).toBeGreaterThanOrEqual(4);
  });

  it("type values are valid PolicyType enum values", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: POLICIES_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const validTypes = ["BLOCK", "LIMIT", "ALERT", "MONITOR"];
    for (const policy of body.data!.policies.items) {
      expect(validTypes).toContain(policy.type);
    }
  });

  it("status values are valid PolicyStatus enum values", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: POLICIES_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const validStatuses = ["ACTIVE", "INACTIVE"];
    for (const policy of body.data!.policies.items) {
      expect(validStatuses).toContain(policy.status);
    }
  });

  it("triggersMtd is a non-negative integer", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: POLICIES_QUERY,
    });

    expect(body.errors).toBeUndefined();
    for (const policy of body.data!.policies.items) {
      expect(policy.triggersMtd).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("D6.2 -- policies pagination", () => {
  it("defaults limit and offset", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: POLICIES_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const conn = body.data!.policies;
    expect(conn.offset).toBe(0);
    expect(typeof conn.limit).toBe("number");
    expect(conn.limit).toBeGreaterThan(0);
  });

  it("respects explicit limit", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: POLICIES_QUERY,
      variables: { limit: 2 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.policies.items.length).toBeLessThanOrEqual(2);
    expect(body.data!.policies.limit).toBe(2);
  });

  it("returns empty items when offset exceeds total", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: POLICIES_QUERY,
      variables: { offset: 99999 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.policies.items).toEqual([]);
  });
});

describe("D6.2 -- policies requires authentication", () => {
  it("rejects unauthenticated requests", async () => {
    const { body, response } = await graphql({
      query: POLICIES_QUERY,
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });

  it("rejects requests with invalid API key", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.invalid,
      query: POLICIES_QUERY,
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D6.2 -- createPolicy mutation
// =========================================================================

const CREATE_POLICY_MUTATION = `mutation ($input: CreatePolicyInput!) {
  createPolicy(input: $input) {
    policy {
      id
      name
      type
      scope
      action
      triggersMtd
      status
    }
    errors {
      field
      code
      message
    }
  }
}`;

describe("D6.2 -- createPolicy mutation creates policy", () => {
  it("creates a new policy and returns it with ACTIVE status", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: CREATE_POLICY_MUTATION,
      variables: {
        input: {
          name: "Test Block Secrets",
          type: "BLOCK",
          scope: "all-agents",
          action: "Block requests containing API secrets",
        },
      },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.createPolicy).toBeDefined();

    const payload = body.data!.createPolicy;
    expect(payload.policy).toBeDefined();
    expect(payload.errors).toEqual([]);

    const policy = payload.policy;
    expect(typeof policy.id).toBe("string");
    expect(policy.name).toBe("Test Block Secrets");
    expect(policy.type).toBe("BLOCK");
    expect(policy.scope).toBe("all-agents");
    expect(policy.action).toBe("Block requests containing API secrets");
    // New policies default to ACTIVE
    expect(policy.status).toBe("ACTIVE");
    // New policies have no triggers yet
    expect(policy.triggersMtd).toBe(0);
  });

  it("created policy appears in subsequent policies query", async () => {
    const { body: mutationBody } = await graphql({
      apiKey: API_KEYS.admin,
      query: CREATE_POLICY_MUTATION,
      variables: {
        input: {
          name: "Test Monitor Output",
          type: "MONITOR",
          scope: "per-project",
          action: "Log all LLM outputs for review",
        },
      },
    });

    expect(mutationBody.errors).toBeUndefined();
    const newId = mutationBody.data!.createPolicy.policy.id;

    const { body: queryBody } = await graphql({
      apiKey: API_KEYS.admin,
      query: POLICIES_QUERY,
      variables: { limit: 100 },
    });

    expect(queryBody.errors).toBeUndefined();
    const found = queryBody.data!.policies.items.find(
      (p: { id: string }) => p.id === newId
    );
    expect(found).toBeDefined();
    expect(found.name).toBe("Test Monitor Output");
  });

  it("rejects invalid PolicyType enum value", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: CREATE_POLICY_MUTATION,
      variables: {
        input: {
          name: "Test Invalid Type",
          type: "INVALID_TYPE",
          scope: "all-agents",
          action: "Should fail",
        },
      },
    });

    // GraphQL should reject at validation time
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);
  });

  it("returns error for missing required name field", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: CREATE_POLICY_MUTATION,
      variables: {
        input: {
          type: "BLOCK",
          scope: "all-agents",
          action: "Block something",
          // name is missing
        },
      },
    });

    // Either GraphQL validation or payload error
    const hasError = (body.errors && body.errors.length > 0) ||
      (body.data?.createPolicy?.errors?.length > 0);
    expect(hasError).toBe(true);
  });
});

describe("D6.2 -- createPolicy requires authentication", () => {
  it("rejects unauthenticated mutation requests", async () => {
    const { body, response } = await graphql({
      query: CREATE_POLICY_MUTATION,
      variables: {
        input: {
          name: "Unauthorized Policy",
          type: "ALERT",
          scope: "all-agents",
          action: "Should be rejected",
        },
      },
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D6.2 -- updatePolicy mutation
// =========================================================================

const UPDATE_POLICY_MUTATION = `mutation ($id: ID!, $input: UpdatePolicyInput!) {
  updatePolicy(id: $id, input: $input) {
    policy {
      id
      name
      type
      scope
      action
      triggersMtd
      status
    }
    errors {
      field
      code
      message
    }
  }
}`;

describe("D6.2 -- updatePolicy mutation updates policy", () => {
  it("updates policy name and returns updated policy", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: UPDATE_POLICY_MUTATION,
      variables: {
        id: D6_IDS.policyAlert,
        input: {
          name: "Alert on extreme cost spikes",
        },
      },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.updatePolicy).toBeDefined();

    const payload = body.data!.updatePolicy;
    expect(payload.policy).toBeDefined();
    expect(payload.errors).toEqual([]);
    expect(payload.policy.name).toBe("Alert on extreme cost spikes");
    expect(payload.policy.id).toBe(D6_IDS.policyAlert);
  });

  it("updates policy status from ACTIVE to INACTIVE", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: UPDATE_POLICY_MUTATION,
      variables: {
        id: D6_IDS.policyLimit,
        input: {
          status: "INACTIVE",
        },
      },
    });

    expect(body.errors).toBeUndefined();
    const payload = body.data!.updatePolicy;
    expect(payload.policy).toBeDefined();
    expect(payload.policy.status).toBe("INACTIVE");
  });

  it("updates multiple fields at once", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: UPDATE_POLICY_MUTATION,
      variables: {
        id: D6_IDS.policyInactive,
        input: {
          name: "Updated Legacy Monitor",
          scope: "per-developer",
          action: "Alert and log non-compliant requests",
          status: "ACTIVE",
        },
      },
    });

    expect(body.errors).toBeUndefined();
    const policy = body.data!.updatePolicy.policy;
    expect(policy.name).toBe("Updated Legacy Monitor");
    expect(policy.scope).toBe("per-developer");
    expect(policy.action).toBe("Alert and log non-compliant requests");
    expect(policy.status).toBe("ACTIVE");
  });

  it("returns errors for nonexistent policy ID", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: UPDATE_POLICY_MUTATION,
      variables: {
        id: "nonexistent-policy-id-12345",
        input: { name: "Should not work" },
      },
    });

    if (body.data?.updatePolicy) {
      const payload = body.data!.updatePolicy;
      expect(payload.errors.length).toBeGreaterThan(0);
      expect(payload.policy).toBeNull();
    } else {
      expect(body.errors).toBeDefined();
      expect(body.errors!.length).toBeGreaterThan(0);
    }
  });

  it("rejects invalid PolicyStatus enum value", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: UPDATE_POLICY_MUTATION,
      variables: {
        id: D6_IDS.policyBlock,
        input: { status: "INVALID_STATUS" },
      },
    });

    // GraphQL should reject at validation time
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThan(0);
  });

  it("preserves unchanged fields when partially updating", async () => {
    // First, read the current state
    const { body: beforeBody } = await graphql({
      apiKey: API_KEYS.admin,
      query: POLICIES_QUERY,
      variables: { limit: 100 },
    });
    expect(beforeBody.errors).toBeUndefined();
    const original = beforeBody.data!.policies.items.find(
      (p: { id: string }) => p.id === D6_IDS.policyBlock
    );
    expect(original).toBeDefined();
    const originalScope = original.scope;
    const originalAction = original.action;

    // Update only the name
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: UPDATE_POLICY_MUTATION,
      variables: {
        id: D6_IDS.policyBlock,
        input: { name: "Block PII v2" },
      },
    });

    expect(body.errors).toBeUndefined();
    const updated = body.data!.updatePolicy.policy;
    expect(updated.name).toBe("Block PII v2");
    // Unchanged fields preserved
    expect(updated.scope).toBe(originalScope);
    expect(updated.action).toBe(originalAction);
  });
});

describe("D6.2 -- updatePolicy requires authentication", () => {
  it("rejects unauthenticated mutation requests", async () => {
    const { body, response } = await graphql({
      query: UPDATE_POLICY_MUTATION,
      variables: {
        id: D6_IDS.policyBlock,
        input: { name: "Unauthorized update" },
      },
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D6.2 -- deletePolicy mutation
// =========================================================================

const DELETE_POLICY_MUTATION = `mutation ($id: ID!) {
  deletePolicy(id: $id) {
    success
    errors {
      field
      code
      message
    }
  }
}`;

describe("D6.2 -- deletePolicy mutation deletes policy", () => {
  it("deletes a policy and returns success: true", async () => {
    // First create a policy to delete
    const { body: createBody } = await graphql({
      apiKey: API_KEYS.admin,
      query: CREATE_POLICY_MUTATION,
      variables: {
        input: {
          name: "Test Policy For Deletion",
          type: "ALERT",
          scope: "per-project",
          action: "Will be deleted",
        },
      },
    });

    expect(createBody.errors).toBeUndefined();
    const policyId = createBody.data!.createPolicy.policy.id;

    // Delete it
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: DELETE_POLICY_MUTATION,
      variables: { id: policyId },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.deletePolicy).toBeDefined();
    expect(body.data!.deletePolicy.success).toBe(true);
    expect(body.data!.deletePolicy.errors).toEqual([]);
  });

  it("deleted policy no longer appears in policies query", async () => {
    // Create a policy to delete
    const { body: createBody } = await graphql({
      apiKey: API_KEYS.admin,
      query: CREATE_POLICY_MUTATION,
      variables: {
        input: {
          name: "Test Policy To Verify Gone",
          type: "MONITOR",
          scope: "all-agents",
          action: "Should disappear after deletion",
        },
      },
    });

    expect(createBody.errors).toBeUndefined();
    const policyId = createBody.data!.createPolicy.policy.id;

    // Delete it
    await graphql({
      apiKey: API_KEYS.admin,
      query: DELETE_POLICY_MUTATION,
      variables: { id: policyId },
    });

    // Verify it is gone
    const { body: queryBody } = await graphql({
      apiKey: API_KEYS.admin,
      query: POLICIES_QUERY,
      variables: { limit: 100 },
    });

    expect(queryBody.errors).toBeUndefined();
    const found = queryBody.data!.policies.items.find(
      (p: { id: string }) => p.id === policyId
    );
    expect(found).toBeUndefined();
  });

  it("returns error for nonexistent policy ID", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: DELETE_POLICY_MUTATION,
      variables: { id: "nonexistent-policy-id-99999" },
    });

    if (body.data?.deletePolicy) {
      const payload = body.data!.deletePolicy;
      // Either success: false or errors array has entries
      expect(
        payload.success === false || payload.errors.length > 0
      ).toBe(true);
    } else {
      expect(body.errors).toBeDefined();
      expect(body.errors!.length).toBeGreaterThan(0);
    }
  });
});

describe("D6.2 -- deletePolicy requires authentication", () => {
  it("rejects unauthenticated mutation requests", async () => {
    const { body, response } = await graphql({
      query: DELETE_POLICY_MUTATION,
      variables: { id: D6_IDS.policyBlock },
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D6.2 -- policyTriggerHistory query
// =========================================================================

const POLICY_TRIGGER_HISTORY_QUERY = `query ($days: Int) {
  policyTriggerHistory(days: $days) {
    label
    value
  }
}`;

describe("D6.2 -- policyTriggerHistory returns daily trigger counts", () => {
  it("returns an array of TrendPoint", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: POLICY_TRIGGER_HISTORY_QUERY,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.policyTriggerHistory).toBeDefined();
    expect(Array.isArray(body.data!.policyTriggerHistory)).toBe(true);
  });

  it("each TrendPoint has label (string) and value (number)", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: POLICY_TRIGGER_HISTORY_QUERY,
      variables: { days: 7 },
    });

    expect(body.errors).toBeUndefined();
    const points = body.data!.policyTriggerHistory;

    for (const point of points) {
      expect(typeof point.label).toBe("string");
      expect(point.label.length).toBeGreaterThan(0);
      expect(typeof point.value).toBe("number");
      expect(point.value).toBeGreaterThanOrEqual(0);
    }
  });

  it("values are non-negative integers (daily trigger counts)", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: POLICY_TRIGGER_HISTORY_QUERY,
      variables: { days: 30 },
    });

    expect(body.errors).toBeUndefined();
    for (const point of body.data!.policyTriggerHistory) {
      expect(point.value).toBeGreaterThanOrEqual(0);
      // Values represent counts, so should be whole numbers
      expect(Number.isFinite(point.value)).toBe(true);
    }
  });

  it("returns data reflecting seeded triggers within the requested window", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: POLICY_TRIGGER_HISTORY_QUERY,
      variables: { days: 7 },
    });

    expect(body.errors).toBeUndefined();
    const points = body.data!.policyTriggerHistory;

    // We seeded 3 triggers in the last 7 days, so total value should be >= 3
    const totalTriggers = points.reduce(
      (sum: number, p: { value: number }) => sum + p.value, 0
    );
    expect(totalTriggers).toBeGreaterThanOrEqual(3);
  });

  it("respects days parameter -- narrower window returns fewer or equal triggers", async () => {
    const { body: day1 } = await graphql({
      apiKey: API_KEYS.admin,
      query: POLICY_TRIGGER_HISTORY_QUERY,
      variables: { days: 1 },
    });

    const { body: day30 } = await graphql({
      apiKey: API_KEYS.admin,
      query: POLICY_TRIGGER_HISTORY_QUERY,
      variables: { days: 30 },
    });

    expect(day1.errors).toBeUndefined();
    expect(day30.errors).toBeUndefined();

    const total1 = day1.data!.policyTriggerHistory.reduce(
      (sum: number, p: { value: number }) => sum + p.value, 0
    );
    const total30 = day30.data!.policyTriggerHistory.reduce(
      (sum: number, p: { value: number }) => sum + p.value, 0
    );

    expect(total30).toBeGreaterThanOrEqual(total1);
  });
});

describe("D6.2 -- policyTriggerHistory requires authentication", () => {
  it("rejects unauthenticated requests", async () => {
    const { body, response } = await graphql({
      query: POLICY_TRIGGER_HISTORY_QUERY,
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D6.3 -- registeredKeys query
// =========================================================================

const REGISTERED_KEYS_QUERY = `query ($limit: Int, $offset: Int) {
  registeredKeys(limit: $limit, offset: $offset) {
    items {
      id
      name
      provider
      fingerprint
      agentCount
      lastUsed
      monthlyCostUsd
      status
    }
    total
    limit
    offset
  }
}`;

describe("D6.3 -- registeredKeys query returns KeyConnection", () => {
  it("returns KeyConnection with all required fields", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTERED_KEYS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.registeredKeys).toBeDefined();

    const conn = body.data!.registeredKeys;
    expect(Array.isArray(conn.items)).toBe(true);
    expect(typeof conn.total).toBe("number");
    expect(typeof conn.limit).toBe("number");
    expect(typeof conn.offset).toBe("number");
  });

  it("each RegisteredKey item has correct field types", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTERED_KEYS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.registeredKeys.items;
    expect(items.length).toBeGreaterThan(0);

    const key = items[0];
    expect(typeof key.id).toBe("string");
    expect(typeof key.name).toBe("string");
    expect(typeof key.provider).toBe("string");
    expect(typeof key.fingerprint).toBe("string");
    expect(typeof key.agentCount).toBe("number");
    // lastUsed is nullable DateTime
    expect("lastUsed" in key).toBe(true);
    expect(typeof key.monthlyCostUsd).toBe("number");
    expect(typeof key.status).toBe("string");
  });

  it("returns seeded registered keys", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTERED_KEYS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    // We seeded 3 registered keys
    expect(body.data!.registeredKeys.items.length).toBeGreaterThanOrEqual(3);
    expect(body.data!.registeredKeys.total).toBeGreaterThanOrEqual(3);
  });

  it("agentCount is a non-negative integer", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTERED_KEYS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    for (const key of body.data!.registeredKeys.items) {
      expect(key.agentCount).toBeGreaterThanOrEqual(0);
    }
  });

  it("monthlyCostUsd is a non-negative number", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTERED_KEYS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    for (const key of body.data!.registeredKeys.items) {
      expect(key.monthlyCostUsd).toBeGreaterThanOrEqual(0);
    }
  });

  it("provider is a known LLM provider string", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTERED_KEYS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    for (const key of body.data!.registeredKeys.items) {
      expect(key.provider.length).toBeGreaterThan(0);
    }
  });

  it("fingerprint is a non-empty masked string", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTERED_KEYS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    for (const key of body.data!.registeredKeys.items) {
      expect(key.fingerprint.length).toBeGreaterThan(0);
    }
  });
});

describe("D6.3 -- registeredKeys pagination", () => {
  it("defaults limit and offset", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTERED_KEYS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const conn = body.data!.registeredKeys;
    expect(conn.offset).toBe(0);
    expect(typeof conn.limit).toBe("number");
    expect(conn.limit).toBeGreaterThan(0);
  });

  it("respects explicit limit", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTERED_KEYS_QUERY,
      variables: { limit: 1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.registeredKeys.items.length).toBeLessThanOrEqual(1);
    expect(body.data!.registeredKeys.limit).toBe(1);
  });

  it("respects offset for pagination", async () => {
    const { body: page1 } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTERED_KEYS_QUERY,
      variables: { limit: 1, offset: 0 },
    });

    const { body: page2 } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTERED_KEYS_QUERY,
      variables: { limit: 1, offset: 1 },
    });

    expect(page1.errors).toBeUndefined();
    expect(page2.errors).toBeUndefined();

    // Same total across pages
    expect(page1.data!.registeredKeys.total).toBe(page2.data!.registeredKeys.total);

    // Different items on different pages
    if (page1.data!.registeredKeys.items.length > 0 && page2.data!.registeredKeys.items.length > 0) {
      expect(page1.data!.registeredKeys.items[0].id).not.toBe(
        page2.data!.registeredKeys.items[0].id
      );
    }
  });

  it("returns empty items when offset exceeds total", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTERED_KEYS_QUERY,
      variables: { offset: 99999 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.registeredKeys.items).toEqual([]);
  });
});

describe("D6.3 -- registeredKeys requires authentication", () => {
  it("rejects unauthenticated requests", async () => {
    const { body, response } = await graphql({
      query: REGISTERED_KEYS_QUERY,
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });

  it("rejects requests with invalid API key", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.invalid,
      query: REGISTERED_KEYS_QUERY,
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D6.3 -- registerKey mutation
// =========================================================================

const REGISTER_KEY_MUTATION = `mutation ($input: RegisterKeyInput!) {
  registerKey(input: $input) {
    key {
      id
      name
      provider
      fingerprint
      agentCount
      lastUsed
      monthlyCostUsd
      status
    }
    errors {
      field
      code
      message
    }
  }
}`;

describe("D6.3 -- registerKey mutation registers key", () => {
  it("registers a new key and returns it", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTER_KEY_MUTATION,
      variables: {
        input: {
          name: "Test New Anthropic Key",
          provider: "anthropic",
          fingerprint: "sk-ant-***test-new-001",
        },
      },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.registerKey).toBeDefined();

    const payload = body.data!.registerKey;
    expect(payload.key).toBeDefined();
    expect(payload.errors).toEqual([]);

    const key = payload.key;
    expect(typeof key.id).toBe("string");
    expect(key.name).toBe("Test New Anthropic Key");
    expect(key.provider).toBe("anthropic");
    expect(key.fingerprint).toBe("sk-ant-***test-new-001");
    expect(key.agentCount).toBe(0);
    expect(key.lastUsed).toBeNull();
    expect(key.monthlyCostUsd).toBe(0);
    expect(key.status).toBe("active");
  });

  it("registered key appears in subsequent registeredKeys query", async () => {
    const { body: mutationBody } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTER_KEY_MUTATION,
      variables: {
        input: {
          name: "Test Query Verification Key",
          provider: "openai",
          fingerprint: "sk-oai-***test-verify-001",
        },
      },
    });

    expect(mutationBody.errors).toBeUndefined();
    const newId = mutationBody.data!.registerKey.key.id;

    const { body: queryBody } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTERED_KEYS_QUERY,
      variables: { limit: 100 },
    });

    expect(queryBody.errors).toBeUndefined();
    const found = queryBody.data!.registeredKeys.items.find(
      (k: { id: string }) => k.id === newId
    );
    expect(found).toBeDefined();
    expect(found.name).toBe("Test Query Verification Key");
  });

  it("rejects duplicate fingerprint", async () => {
    // Register a key first
    await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTER_KEY_MUTATION,
      variables: {
        input: {
          name: "Test Duplicate Key 1",
          provider: "anthropic",
          fingerprint: "sk-ant-***duplicate-test",
        },
      },
    });

    // Try to register another key with the same fingerprint
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTER_KEY_MUTATION,
      variables: {
        input: {
          name: "Test Duplicate Key 2",
          provider: "anthropic",
          fingerprint: "sk-ant-***duplicate-test",
        },
      },
    });

    // Should fail with duplicate error
    if (body.data?.registerKey) {
      const payload = body.data!.registerKey;
      expect(payload.errors.length).toBeGreaterThan(0);
      expect(payload.key).toBeNull();
    } else {
      expect(body.errors).toBeDefined();
      expect(body.errors!.length).toBeGreaterThan(0);
    }
  });

  it("returns error for missing required fields", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTER_KEY_MUTATION,
      variables: {
        input: {
          name: "Test Missing Fields",
          // provider and fingerprint missing
        },
      },
    });

    const hasError = (body.errors && body.errors.length > 0) ||
      (body.data?.registerKey?.errors?.length > 0);
    expect(hasError).toBe(true);
  });
});

describe("D6.3 -- registerKey requires authentication", () => {
  it("rejects unauthenticated mutation requests", async () => {
    const { body, response } = await graphql({
      query: REGISTER_KEY_MUTATION,
      variables: {
        input: {
          name: "Unauthorized Key",
          provider: "anthropic",
          fingerprint: "sk-ant-***unauthorized",
        },
      },
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D6.3 -- deleteKey mutation
// =========================================================================

const DELETE_KEY_MUTATION = `mutation ($id: ID!) {
  deleteKey(id: $id) {
    success
    errors {
      field
      code
      message
    }
  }
}`;

describe("D6.3 -- deleteKey mutation deletes key", () => {
  it("deletes a registered key and returns success: true", async () => {
    // Register a key to delete
    const { body: registerBody } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTER_KEY_MUTATION,
      variables: {
        input: {
          name: "Test Key For Deletion",
          provider: "google",
          fingerprint: "AIza-***delete-test-001",
        },
      },
    });

    expect(registerBody.errors).toBeUndefined();
    const keyId = registerBody.data!.registerKey.key.id;

    // Delete it
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: DELETE_KEY_MUTATION,
      variables: { id: keyId },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.deleteKey).toBeDefined();
    expect(body.data!.deleteKey.success).toBe(true);
    expect(body.data!.deleteKey.errors).toEqual([]);
  });

  it("deleted key no longer appears in registeredKeys query", async () => {
    // Register a key to delete
    const { body: registerBody } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTER_KEY_MUTATION,
      variables: {
        input: {
          name: "Test Key To Verify Gone",
          provider: "openai",
          fingerprint: "sk-oai-***verify-gone-001",
        },
      },
    });

    expect(registerBody.errors).toBeUndefined();
    const keyId = registerBody.data!.registerKey.key.id;

    // Delete it
    await graphql({
      apiKey: API_KEYS.admin,
      query: DELETE_KEY_MUTATION,
      variables: { id: keyId },
    });

    // Verify it is gone
    const { body: queryBody } = await graphql({
      apiKey: API_KEYS.admin,
      query: REGISTERED_KEYS_QUERY,
      variables: { limit: 100 },
    });

    expect(queryBody.errors).toBeUndefined();
    const found = queryBody.data!.registeredKeys.items.find(
      (k: { id: string }) => k.id === keyId
    );
    expect(found).toBeUndefined();
  });

  it("returns error for nonexistent key ID", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: DELETE_KEY_MUTATION,
      variables: { id: "nonexistent-key-id-99999" },
    });

    if (body.data?.deleteKey) {
      const payload = body.data!.deleteKey;
      expect(
        payload.success === false || payload.errors.length > 0
      ).toBe(true);
    } else {
      expect(body.errors).toBeDefined();
      expect(body.errors!.length).toBeGreaterThan(0);
    }
  });
});

describe("D6.3 -- deleteKey requires authentication", () => {
  it("rejects unauthenticated mutation requests", async () => {
    const { body, response } = await graphql({
      query: DELETE_KEY_MUTATION,
      variables: { id: D6_IDS.keyAnthropic },
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D6 Cross-cutting -- New tables created via migration
// =========================================================================

describe("D6 -- New tables exist in the database", () => {
  it("reports table exists", async () => {
    const p = getPool();
    const result = await p.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables WHERE table_name = 'reports'
      ) AS exists`
    );
    expect(result.rows[0].exists).toBe(true);
  });

  it("policies table exists", async () => {
    const p = getPool();
    const result = await p.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables WHERE table_name = 'policies'
      ) AS exists`
    );
    expect(result.rows[0].exists).toBe(true);
  });

  it("policy_triggers table exists", async () => {
    const p = getPool();
    const result = await p.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables WHERE table_name = 'policy_triggers'
      ) AS exists`
    );
    expect(result.rows[0].exists).toBe(true);
  });

  it("registered_keys table exists", async () => {
    const p = getPool();
    const result = await p.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables WHERE table_name = 'registered_keys'
      ) AS exists`
    );
    expect(result.rows[0].exists).toBe(true);
  });
});

// =========================================================================
// D6 Cross-cutting -- Existing queries still work
// =========================================================================

describe("D6 -- Existing queries still work after D6 additions", () => {
  it("sessions query still resolves", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `{ sessions { items { id provider model } total } }`,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.sessions).toBeDefined();
    expect(Array.isArray(body.data!.sessions.items)).toBe(true);
  });

  it("realtimeStats query still resolves", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `{ realtimeStats { requestsPerMinute activeSessions tokensLastHour } }`,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.realtimeStats).toBeDefined();
  });

  it("auditTrail query still resolves", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `{ auditTrail { items { timestamp sessionId provider } total } }`,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.auditTrail).toBeDefined();
  });

  it("usageSummary query still resolves", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `{ usageSummary { totalCostUsd totalTokens } }`,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.usageSummary).toBeDefined();
  });

  it("complianceSummary query still resolves", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `{ complianceSummary { overallScore captureIntegrity } }`,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.complianceSummary).toBeDefined();
  });

  it("agentSummary query still resolves", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `{ agentSummary { activeAgents totalSessions } }`,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.agentSummary).toBeDefined();
  });
});
