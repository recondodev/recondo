/**
 * D-C12-4, D-C12-5, D-C12-6 (unit) — prompt catalog.
 *
 * Asserts:
 *   - the four prompt names exist in the catalog: `summarize_my_week`,
 *     `find_waste`, `weekly_cost_report`, `monitor_anomalies`.
 *   - `find_waste` body contains "exact-match only" OR "byte-identical"
 *     (D-C12-5 — captures Risk #4 from spec).
 *   - `monitor_anomalies` body contains "30" AND a cadence-rationale
 *     fragment (D-C12-6).
 *   - `weekly_cost_report` is gated on `--allow-actions` (either
 *     omitted from the unconditional list, or annotated with a
 *     `requiresAction === true` flag — Plan D §Task 27 says either is
 *     acceptable; this test accepts both).
 *
 * The implementer MUST export `PROMPTS` from `mcp/src/server.ts` (or a
 * dedicated `mcp/src/prompts/index.ts` re-exported through `server.ts`)
 * — the parallel of `READ_TOOLS` / `ACTION_TOOLS`. This is the single
 * source of truth for the v1 prompt catalog.
 *
 * Each prompt entry is expected to have:
 *   - `name: string`
 *   - `description: string`
 *   - `arguments?: Array<{name: string; description?: string; required?: boolean}>`
 *   - `render(args?): Promise<{messages: Array<{role; content: {type; text}}>}>`
 *   - `requiresAction?: boolean`  (for the gating contract)
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
  getRealtimeFeed: vi.fn(),
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

import { PROMPTS } from "../../src/server.js";

interface PromptMessageContent {
  type: string;
  text: string;
}

interface PromptMessage {
  role: string;
  content: PromptMessageContent;
}

interface RenderResult {
  messages: PromptMessage[];
}

interface PromptDefinition {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  requiresAction?: boolean;
  render(args?: Record<string, unknown>): Promise<RenderResult>;
}

const EXPECTED_NAMES = new Set([
  "summarize_my_week",
  "find_waste",
  "weekly_cost_report",
  "monitor_anomalies",
]);

describe("D-C12-4 PROMPTS catalog — four prompts present", () => {
  it("PROMPTS is an array exported from server.ts", () => {
    expect(Array.isArray(PROMPTS)).toBe(true);
  });

  it("contains exactly the four expected prompts (no more, no less)", () => {
    const names = (PROMPTS as PromptDefinition[]).map((p) => p.name).sort();
    expect(names).toEqual(
      ["find_waste", "monitor_anomalies", "summarize_my_week", "weekly_cost_report"],
    );
  });

  it("every prompt has a non-empty name + description + render() function", () => {
    for (const p of PROMPTS as PromptDefinition[]) {
      expect(EXPECTED_NAMES.has(p.name), `unexpected prompt: ${p.name}`).toBe(true);
      expect(typeof p.name).toBe("string");
      expect(p.name.length).toBeGreaterThan(0);
      expect(typeof p.description).toBe("string");
      expect((p.description ?? "").length).toBeGreaterThan(0);
      expect(typeof p.render).toBe("function");
    }
  });
});

describe("D-C12-4 weekly_cost_report — gated on --allow-actions", () => {
  it("`weekly_cost_report` is annotated with requiresAction === true", () => {
    // Plan D §Task 27 permits two implementation strategies:
    //   (a) omit the prompt unconditionally and re-add when
    //       --allow-actions is set, OR
    //   (b) annotate with requiresAction so server bootstrap can decide.
    //
    // The catalog is the unconditional list (4 entries); gating logic
    // lives in `createMcpServer`. So strategy (b) — annotate — is the
    // catalog-level contract. The integration test exercises strategy
    // (a) at the runtime `prompts/list` boundary.
    const prompts = PROMPTS as PromptDefinition[];
    const wcr = prompts.find((p) => p.name === "weekly_cost_report");
    expect(wcr).toBeDefined();
    expect(wcr!.requiresAction).toBe(true);
  });

  it("the other three prompts are NOT marked requiresAction", () => {
    const prompts = PROMPTS as PromptDefinition[];
    for (const p of prompts) {
      if (p.name === "weekly_cost_report") continue;
      expect(
        p.requiresAction === true,
        `prompt ${p.name} should not require --allow-actions`,
      ).toBe(false);
    }
  });
});

describe("D-C12-5 find_waste body — exact-match-only OR byte-identical", () => {
  it("render() body mentions the v1 detection limitation", async () => {
    const prompts = PROMPTS as PromptDefinition[];
    const findWaste = prompts.find((p) => p.name === "find_waste");
    expect(findWaste).toBeDefined();
    const result = await findWaste!.render();
    expect(result).toHaveProperty("messages");
    expect(result.messages.length).toBeGreaterThan(0);
    const first = result.messages[0];
    expect(first.content.type).toBe("text");
    const body = first.content.text;
    expect(body.length).toBeGreaterThan(0);

    const hasExactMatch = body.includes("exact-match only");
    const hasByteIdentical = body.includes("byte-identical");
    expect(
      hasExactMatch || hasByteIdentical,
      `find_waste body must contain "exact-match only" OR "byte-identical"; got: ${body.slice(0, 200)}`,
    ).toBe(true);
  });
});

describe("D-C12-6 monitor_anomalies body — 30s cadence + rationale", () => {
  it("render() body contains the literal '30' AND cadence-rationale text", async () => {
    const prompts = PROMPTS as PromptDefinition[];
    const monitor = prompts.find((p) => p.name === "monitor_anomalies");
    expect(monitor).toBeDefined();
    const result = await monitor!.render();
    const body = result.messages[0].content.text;

    // D-C12-6 part 1: literal '30' must appear (the polling cadence).
    expect(body.includes("30"), `monitor_anomalies body missing literal "30"`).toBe(true);

    // D-C12-6 part 2: the rationale fragment. Plan D's canonical text
    // mentions "context-window budget" and "non-urgent monitoring" /
    // "minimum cadence" / "polling interval"-style wording. We accept
    // any of the canonical rationale phrases so the implementer has
    // some prose latitude.
    const rationaleFragments = [
      "context-window",
      "non-urgent",
      "polling interval",
      "minimum cadence",
      "polling cadence",
      "cadence",
    ];
    const matchedRationale = rationaleFragments.some((frag) => body.includes(frag));
    expect(
      matchedRationale,
      `monitor_anomalies body missing cadence rationale; expected one of [${rationaleFragments.join(
        ", ",
      )}]; got: ${body.slice(0, 300)}`,
    ).toBe(true);
  });
});
