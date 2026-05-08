/**
 * D-C12-7 (unit) — resources catalog.
 *
 * Asserts the three v1 resource templates are registered:
 *   - `recondo://session/{id}` (or `{session_id}`)
 *   - `recondo://turn/{id}` (or `{turn_id}`)
 *   - `recondo://reports/{id}` (or `{report_id}`)
 *
 * The implementer MUST export `RESOURCES` from `mcp/src/server.ts` (or
 * a dedicated `mcp/src/resources/index.ts` re-exported through
 * `server.ts`) — the parallel of `READ_TOOLS` / `ACTION_TOOLS` /
 * `PROMPTS`. Single source of truth for the v1 resource catalog.
 *
 * Each resource entry is expected to have:
 *   - `uriTemplate: string` (RFC 6570 form, MCP SDK uses `{id}` syntax)
 *   - `name: string`
 *   - `description: string`
 *   - `read(uri: string, ctx): Promise<{contents: ...}>`
 *
 * `recondo_get_session` integration coverage of the
 * active-vs-closed gating lives in `tests/integration/prompts-resources.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@recondo/data", () => ({
  getPool: vi.fn(),
  closePool: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  getTurn: vi.fn(),
  getTurnRawMetadata: vi.fn(),
  getTurnRawChunk: vi.fn(),
  searchTurns: vi.fn(),
  verifyIntegrity: vi.fn(),
  compareTurns: vi.fn(),
  findSimilarPrompts: vi.fn(),
  relatedTurns: vi.fn(),
  sessionEfficiency: vi.fn(),
  getRealtimeStats: vi.fn(),
  getGatewayStatus: vi.fn(),
  listRealtimeFeed: vi.fn(),
  getUsageSummary: vi.fn(),
  listSpendByProvider: vi.fn(),
  listSpendByModel: vi.fn(),
  listSpendByFramework: vi.fn(),
  listDailySpend: vi.fn(),
  getCostProjections: vi.fn(),
  getAgentSummary: vi.fn(),
  listAgentFrameworkDistribution: vi.fn(),
  listTopDevelopers: vi.fn(),
  listTopRepositories: vi.fn(),
  toolCallStats: vi.fn(),
  listAuditEvents: vi.fn(),
  listAnomalies: vi.fn(),
  getComplianceSummary: vi.fn(),
  listComplianceFrameworks: vi.fn(),
  listComplianceAuditLog: vi.fn(),
  listReports: vi.fn(),
  // The integration test names the read function `getReport`; mock here
  // so the resource module can import it without a live pool.
  getReport: vi.fn(),
  listReportCoverageTrend: vi.fn(),
  listReportFindingsTrend: vi.fn(),
  getInsights: vi.fn(),
  listPolicies: vi.fn(),
  listPolicyTriggerHistory: vi.fn(),
  listApiKeys: vi.fn(),
  generateReport: vi.fn(),
  updateControlStatus: vi.fn(),
  createPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  deletePolicy: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  insertAuditLog: vi.fn(),
  authenticateApiKey: vi.fn(),
}));

import { RESOURCES } from "../../src/server.js";

interface ResourceDefinition {
  uriTemplate: string;
  name: string;
  description?: string;
  read(uri: string, ctx: unknown): Promise<unknown>;
}

// We accept either `{id}` or `{<entity>_id}` as the placeholder name —
// Plan D §Task 28 used `{session_id}` / `{turn_id}` / `{report_id}`,
// while the C0 deliverable list (D-C12-7) abbreviates to `{id}`. Either
// is RFC-6570-valid and the SDK accepts both — assert we have ONE of
// the two for each resource.
const EXPECTED = [
  { entity: "session", template: "recondo://session/" },
  { entity: "turn", template: "recondo://turn/" },
  { entity: "reports", template: "recondo://reports/" },
];

describe("D-C12-7 RESOURCES catalog — three resources present", () => {
  it("RESOURCES is an array exported from server.ts", () => {
    expect(Array.isArray(RESOURCES)).toBe(true);
  });

  it("contains exactly three resource templates", () => {
    expect((RESOURCES as ResourceDefinition[]).length).toBe(3);
  });

  it("each expected entity has a uriTemplate registered", () => {
    const resources = RESOURCES as ResourceDefinition[];
    for (const { entity, template } of EXPECTED) {
      const matched = resources.find((r) => r.uriTemplate.startsWith(template));
      expect(
        matched,
        `no resource registered for entity '${entity}' (expected uriTemplate to start with '${template}')`,
      ).toBeDefined();
      // RFC 6570 placeholder check — `{` somewhere after the entity prefix.
      expect(matched!.uriTemplate.includes("{")).toBe(true);
      expect(matched!.uriTemplate.includes("}")).toBe(true);
    }
  });

  it("session uriTemplate uses {id} or {session_id}", () => {
    const r = (RESOURCES as ResourceDefinition[]).find((x) =>
      x.uriTemplate.startsWith("recondo://session/"),
    );
    expect(r).toBeDefined();
    const ok =
      r!.uriTemplate === "recondo://session/{id}" ||
      r!.uriTemplate === "recondo://session/{session_id}";
    expect(
      ok,
      `session uriTemplate must be '{id}' or '{session_id}', got: ${r!.uriTemplate}`,
    ).toBe(true);
  });

  it("turn uriTemplate uses {id} or {turn_id}", () => {
    const r = (RESOURCES as ResourceDefinition[]).find((x) =>
      x.uriTemplate.startsWith("recondo://turn/"),
    );
    expect(r).toBeDefined();
    const ok =
      r!.uriTemplate === "recondo://turn/{id}" ||
      r!.uriTemplate === "recondo://turn/{turn_id}";
    expect(
      ok,
      `turn uriTemplate must be '{id}' or '{turn_id}', got: ${r!.uriTemplate}`,
    ).toBe(true);
  });

  it("reports uriTemplate uses {id} or {report_id}", () => {
    const r = (RESOURCES as ResourceDefinition[]).find((x) =>
      x.uriTemplate.startsWith("recondo://reports/"),
    );
    expect(r).toBeDefined();
    const ok =
      r!.uriTemplate === "recondo://reports/{id}" ||
      r!.uriTemplate === "recondo://reports/{report_id}";
    expect(
      ok,
      `reports uriTemplate must be '{id}' or '{report_id}', got: ${r!.uriTemplate}`,
    ).toBe(true);
  });

  it("each resource has name, description, and read() function", () => {
    for (const r of RESOURCES as ResourceDefinition[]) {
      expect(typeof r.name).toBe("string");
      expect(r.name.length).toBeGreaterThan(0);
      expect(typeof r.description).toBe("string");
      expect((r.description ?? "").length).toBeGreaterThan(0);
      expect(typeof r.read).toBe("function");
    }
  });
});
