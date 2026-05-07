/**
 * D-C10 (unit) — Action-tool catalog assertions.
 *
 * The implementer MUST export `ACTION_TOOLS` from `mcp/src/server.ts` —
 * the single source of truth for the v1 action-tool catalog (parallel
 * to the existing `READ_TOOLS` export).
 *
 * Asserts:
 *   - `ACTION_TOOLS.length === 7`
 *   - the seven names sort to the expected list
 *   - 5 tools have `destructive === false`, 2 have `destructive === true`
 *   - every description contains the verbatim INJECTION_WARNING
 *   - the two destructive tools' descriptions also contain the literal
 *     "DESTRUCTIVE" (uppercase)
 *
 * NOTE: this test does NOT spawn the binary; it imports from the
 * compiled (or ts-node) source directly. We mock `@recondo/data` so the
 * tool factories don't trip over a missing pool when their source is
 * imported.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@recondo/data", () => ({
  // Read-tool data layer (already covered by C2..C9 tests).
  listSessions: vi.fn(),
  getSession: vi.fn(),
  getTurn: vi.fn(),
  search: vi.fn(),
  verifyTurnIntegrity: vi.fn(),
  compareTurns: vi.fn(),
  findSimilarPrompts: vi.fn(),
  getRelatedTurns: vi.fn(),
  getSessionEfficiency: vi.fn(),
  getRealtimeOverview: vi.fn(),
  getRealtimeFeed: vi.fn(),
  getUsageSummary: vi.fn(),
  getSpend: vi.fn(),
  getCostProjections: vi.fn(),
  getAgentSummary: vi.fn(),
  getAgentFrameworkDistribution: vi.fn(),
  getTop: vi.fn(),
  getToolCallStats: vi.fn(),
  getAuditTrail: vi.fn(),
  getAnomalies: vi.fn(),
  getCompliance: vi.fn(),
  listReports: vi.fn(),
  getReport: vi.fn(),
  listReportCoverageTrend: vi.fn(),
  listReportFindingsTrend: vi.fn(),
  listPolicies: vi.fn(),
  listPolicyTriggerHistory: vi.fn(),
  listApiKeys: vi.fn(),
  // Action-tool data layer (C10).
  generateReport: vi.fn(),
  updateControlStatus: vi.fn(),
  createPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  deletePolicy: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  // Plumbing.
  getPool: vi.fn(),
  closePool: vi.fn(),
  insertAuditLog: vi.fn(),
  authenticateApiKey: vi.fn(),
}));

import { ACTION_TOOLS } from "../../src/server.js";
import { INJECTION_WARNING } from "../../src/registry/warning.js";

const EXPECTED_NAMES = [
  "recondo_create_policy",
  "recondo_delete_key",
  "recondo_delete_policy",
  "recondo_generate_report",
  "recondo_register_key",
  "recondo_update_control_status",
  "recondo_update_policy",
];

const EXPECTED_DESTRUCTIVE = new Set([
  "recondo_delete_policy",
  "recondo_delete_key",
]);

describe("D-C10 ACTION_TOOLS catalog", () => {
  it("exports an array of length 7", () => {
    expect(Array.isArray(ACTION_TOOLS)).toBe(true);
    expect(ACTION_TOOLS.length).toBe(7);
  });

  it("contains exactly the seven expected names", () => {
    const names = ACTION_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(EXPECTED_NAMES);
  });

  it("every tool name matches /^recondo_[a-z_]+$/", () => {
    const pattern = /^recondo_[a-z_]+$/;
    for (const tool of ACTION_TOOLS) {
      expect(
        pattern.test(tool.name),
        `name violates convention: ${tool.name}`,
      ).toBe(true);
    }
  });

  it("destructive flags: exactly 2 destructive (delete_policy, delete_key)", () => {
    const destructive = ACTION_TOOLS.filter((t) => t.destructive === true);
    const nonDestructive = ACTION_TOOLS.filter((t) => t.destructive === false);
    expect(destructive.length).toBe(2);
    expect(nonDestructive.length).toBe(5);
    const destNames = destructive.map((t) => t.name).sort();
    expect(destNames).toEqual(["recondo_delete_key", "recondo_delete_policy"]);
  });

  it("each tool's destructive flag matches the C10 contract", () => {
    for (const tool of ACTION_TOOLS) {
      const expected = EXPECTED_DESTRUCTIVE.has(tool.name);
      expect(
        tool.destructive,
        `tool ${tool.name} destructive=${tool.destructive}, expected=${expected}`,
      ).toBe(expected);
    }
  });

  it("every description is >= 50 chars", () => {
    for (const tool of ACTION_TOOLS) {
      expect(
        tool.description.length,
        `tool ${tool.name} description length=${tool.description.length}`,
      ).toBeGreaterThanOrEqual(50);
    }
  });

  it("every description contains the verbatim INJECTION_WARNING", () => {
    for (const tool of ACTION_TOOLS) {
      expect(
        tool.description.includes(INJECTION_WARNING),
        `tool ${tool.name} missing INJECTION_WARNING`,
      ).toBe(true);
    }
  });

  it("destructive tool descriptions contain literal DESTRUCTIVE", () => {
    for (const tool of ACTION_TOOLS) {
      if (!tool.destructive) continue;
      expect(
        tool.description.includes("DESTRUCTIVE"),
        `destructive tool ${tool.name} missing literal "DESTRUCTIVE"`,
      ).toBe(true);
    }
  });
});
