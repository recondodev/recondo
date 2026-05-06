/**
 * Public-surface smoke (D-SM1, D-SM2).
 *
 * Imports EVERY documented export from `@recondo/data` and asserts
 * shape. Catches regressions where a refactor accidentally drops or
 * renames an export. The test must be exhaustive — if a future
 * refactor drops an export, this test catches it.
 *
 * D-SM2 also runs `listSessions` against the live DB and asserts the
 * v1 envelope shape, so the smoke covers both wiring and the
 * end-to-end happy path.
 */
import { describe, it, expect, afterAll } from "vitest";
import * as data from "../src/index.js";
import type { ApiKeyInfo } from "../src/types.js";

const adminKey: ApiKeyInfo = { id: "test", projectId: null, rateLimitRpm: 1000 };

afterAll(async () => {
  await data.closePool();
});

describe("@recondo/data: public surface smoke (D-SM1)", () => {
  it("exports all documented public API", () => {
    // Pool / health
    expect(typeof data.getPool).toBe("function");
    expect(typeof data.closePool).toBe("function");
    expect(typeof data.checkDatabaseHealth).toBe("function");

    // Auth
    expect(typeof data.authenticateApiKey).toBe("function");
    expect(typeof data.authenticateRequest).toBe("function");

    // Envelope + cursor
    expect(typeof data.encodeSinceCursor).toBe("function");
    expect(typeof data.decodeSinceCursor).toBe("function");
    expect(typeof data.uniformListEnvelope).toBe("function");

    // Async-iter
    expect(typeof data.rowsToAsyncIterable).toBe("function");
    expect(typeof data.abortableIterable).toBe("function");

    // Mappers
    expect(typeof data.mapSession).toBe("function");
    expect(typeof data.mapTurn).toBe("function");
    expect(typeof data.mapToolCall).toBe("function");
    expect(typeof data.mapAnomaly).toBe("function");
    expect(typeof data.escapeIlike).toBe("function");
    expect(typeof data.formatTimestamp).toBe("function");

    // Sessions
    expect(typeof data.listSessions).toBe("function");
    expect(typeof data.getSession).toBe("function");
    expect(typeof data.listUserTurns).toBe("function");

    // Turns
    expect(typeof data.getTurn).toBe("function");
    expect(typeof data.searchTurns).toBe("function");
    expect(typeof data.verifyIntegrity).toBe("function");

    // Anomalies
    expect(typeof data.listAnomalies).toBe("function");

    // Cost
    expect(typeof data.getUsageSummary).toBe("function");
    expect(typeof data.listSpendByProvider).toBe("function");
    expect(typeof data.listSpendByModel).toBe("function");
    expect(typeof data.listSpendByFramework).toBe("function");
    expect(typeof data.listDailySpend).toBe("function");
    expect(typeof data.getCostProjections).toBe("function");
    expect(typeof data.resolveDateRange).toBe("function");

    // Audit
    expect(typeof data.listAuditEvents).toBe("function");
    expect(typeof data.getAuditEntries).toBe("function");

    // Compliance
    expect(typeof data.getComplianceSummary).toBe("function");
    expect(typeof data.listComplianceFrameworks).toBe("function");
    expect(typeof data.listComplianceAuditLog).toBe("function");
    expect(typeof data.listComplianceFindings).toBe("function");
    expect(typeof data.updateControlStatus).toBe("function");

    // Realtime (3 main + helpers consumed by sessions.ts)
    expect(typeof data.getRealtimeStats).toBe("function");
    expect(typeof data.listRealtimeFeed).toBe("function");
    expect(typeof data.getGatewayStatus).toBe("function");
    expect(typeof data.buildGroupingCTEs).toBe("function");
    expect(typeof data.EXCLUDE_PURE_PREFLIGHT_SQL).toBe("string");

    // Agents
    expect(typeof data.getAgentSummary).toBe("function");
    expect(typeof data.listAgentFrameworkDistribution).toBe("function");
    expect(typeof data.listTopDevelopers).toBe("function");
    expect(typeof data.listTopRepositories).toBe("function");
    expect(typeof data.listAgentActivity).toBe("function");

    // Reports
    expect(typeof data.listReports).toBe("function");
    expect(typeof data.getReport).toBe("function");
    expect(typeof data.listReportCoverageTrend).toBe("function");
    expect(typeof data.listReportFindingsTrend).toBe("function");
    expect(typeof data.generateReport).toBe("function");

    // Policies
    expect(typeof data.listPolicies).toBe("function");
    expect(typeof data.getPolicy).toBe("function");
    expect(typeof data.listPolicyTriggerHistory).toBe("function");
    expect(typeof data.createPolicy).toBe("function");
    expect(typeof data.updatePolicy).toBe("function");
    expect(typeof data.deletePolicy).toBe("function");

    // Keys
    expect(typeof data.listApiKeys).toBe("function");
    expect(typeof data.createApiKey).toBe("function");
    expect(typeof data.revokeApiKey).toBe("function");

    // Structured query
    expect(typeof data.runStructuredQuery).toBe("function");
    expect(typeof data.listStructuredSessions).toBe("function");
    expect(typeof data.listStructuredTurns).toBe("function");
    expect(typeof data.listStructuredAnomalies).toBe("function");
    expect(typeof data.listStructuredCost).toBe("function");
    expect(typeof data.listStructuredTools).toBe("function");
    expect(typeof data.listStructuredRisk).toBe("function");
    expect(typeof data.listStructuredCompliance).toBe("function");
    expect(typeof data.listStructuredProvenance).toBe("function");

    // Redaction (root-level + namespace)
    expect(typeof data.maskPlaceholderPaths).toBe("function");
    expect(typeof data.isAttachmentPlaceholder).toBe("function");
    expect(typeof data.sanitizeRowTextFields).toBe("function");
    expect(typeof data.sanitizeAnomalyRow).toBe("function");
    expect(Array.isArray(data.placeholderLikePatterns)).toBe(true);
    expect(typeof data.looksLikePathProbe).toBe("function");
    expect(Array.isArray(data.PLACEHOLDER_PREFIXES)).toBe(true);
    expect(typeof data.MASKED_PLACEHOLDER_REPLACEMENT).toBe("string");
    expect(Array.isArray(data.TURN_TEXT_FIELDS)).toBe(true);
    expect(Array.isArray(data.SESSION_TEXT_FIELDS)).toBe(true);
    expect(Array.isArray(data.TOOL_CALL_TEXT_FIELDS)).toBe(true);
    expect(Array.isArray(data.ANOMALY_TEXT_FIELDS)).toBe(true);
    expect(Array.isArray(data.SQL_PREFIX_NAMES)).toBe(true);
    expect(typeof data.SQL_PREFIX_ALTERNATION).toBe("string");

    // Namespaced redaction barrel
    expect(typeof data.redaction).toBe("object");
    expect(typeof data.redaction.maskPlaceholderPaths).toBe("function");
    expect(typeof data.redaction.isAttachmentPlaceholder).toBe("function");

    // DataValidationError class
    expect(typeof data.DataValidationError).toBe("function");
  });
});

describe("@recondo/data: end-to-end smoke (D-SM2)", () => {
  it("listSessions runs against a live DB and returns the v1 envelope", async () => {
    const env = await data.listSessions(adminKey, {}, { limit: 1 });
    expect(env.is_final).toBe(true);
    expect(env.stream_id).toBeNull();
    expect(typeof env.total).toBe("number");
    if (env.items.length > 0) {
      const id = (env.items[0] as { id: string }).id;
      const s = await data.getSession(adminKey, id);
      expect(s).not.toBeNull();
    }
  });
});
