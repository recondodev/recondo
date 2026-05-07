/**
 * D-C11 (unit) — Catalog parity lint logic.
 *
 * Phase 1 (name parity only) — action-immutability is DEFERRED to
 * Phase 2 / D-C13-8 (row-count hashing integration test).
 *
 * The implementer MUST replace `mcp/src/scripts/catalog-parity-lint.ts`
 * (currently a no-op stub from C1) with a real implementation that
 * exposes the following surface:
 *
 *   export interface LintResult {
 *     violations: Array<{
 *       kind: "uncovered_export" | "phantom_mapping" | "phantom_opt_out";
 *       export: string;
 *       message: string;
 *     }>;
 *   }
 *
 *   // Tool name → @recondo/data fn name (or array of names when a tool
 *   // dispatches to multiple data-layer fns, e.g. recondo_spend → 4 fns).
 *   export const READ_TOOL_TO_DATA_FN: Record<string, string | string[]>;
 *   export const ACTION_TOOL_TO_DATA_FN: Record<string, string>;
 *
 *   // Internal @recondo/data exports the parity lint deliberately does
 *   // NOT surface as MCP tools. Each entry's value is a one-line
 *   // human-readable rationale.
 *   export const READ_OPT_OUTS: Record<string, string>;
 *
 *   // The lint logic. Returns {violations: []} when parity holds.
 *   export function runLint(opts?: {
 *     dataExports?: ReadonlyArray<string>;
 *     readMap?: Record<string, string | string[]>;
 *     actionMap?: Record<string, string>;
 *     optOuts?: Record<string, string>;
 *   }): LintResult;
 *
 * The lint runs three checks against the union of `READ_TOOL_TO_DATA_FN`
 * values, `ACTION_TOOL_TO_DATA_FN` values, and `READ_OPT_OUTS` keys:
 *
 *   1. uncovered_export — an @recondo/data export not in any of the three.
 *   2. phantom_mapping  — a tool's mapping points to a non-existent export.
 *   3. phantom_opt_out  — an opt-out entry that IS already covered by a
 *                          tool mapping (redundant; should be removed).
 */
import { describe, it, expect } from "vitest";
import * as data from "@recondo/data";

import {
  READ_TOOL_TO_DATA_FN,
  ACTION_TOOL_TO_DATA_FN,
  READ_OPT_OUTS,
  runLint,
  type LintResult,
} from "../../src/scripts/catalog-parity-lint.js";

const DATA_EXPORTS = new Set(Object.keys(data));

function flatReadValues(): string[] {
  const out: string[] = [];
  for (const v of Object.values(READ_TOOL_TO_DATA_FN)) {
    if (Array.isArray(v)) out.push(...v);
    else out.push(v);
  }
  return out;
}

describe("D-C11 READ_TOOL_TO_DATA_FN map", () => {
  it("has exactly 27 entries (one per read tool)", () => {
    expect(Object.keys(READ_TOOL_TO_DATA_FN).length).toBe(27);
  });

  it("uses RIGHT-column @recondo/data export names verbatim", () => {
    // Every value (or array element) must resolve to a real export.
    for (const [tool, fn] of Object.entries(READ_TOOL_TO_DATA_FN)) {
      const fns = Array.isArray(fn) ? fn : [fn];
      for (const name of fns) {
        expect(
          DATA_EXPORTS.has(name),
          `read tool ${tool} maps to non-existent @recondo/data export: ${name}`,
        ).toBe(true);
      }
    }
  });

  it("contains each expected tool → fn mapping", () => {
    // Pinned per C0 §1 API-reality table.
    const expected: Record<string, string | string[]> = {
      recondo_list_sessions: "listSessions",
      recondo_get_session: "getSession",
      recondo_get_turn: "getTurn",
      recondo_get_turn_raw_metadata: "getTurnRawMetadata",
      recondo_get_turn_raw_chunk: "getTurnRawChunk",
      recondo_search: "searchTurns",
      recondo_verify_integrity: "verifyIntegrity",
      recondo_compare_turns: "compareTurns",
      recondo_find_similar_prompts: "findSimilarPrompts",
      recondo_related_turns: "relatedTurns",
      recondo_session_efficiency: "sessionEfficiency",
      recondo_realtime_overview: ["getRealtimeStats", "getGatewayStatus"],
      recondo_realtime_feed: "listRealtimeFeed",
      recondo_usage_summary: "getUsageSummary",
      recondo_spend: [
        "listSpendByProvider",
        "listSpendByModel",
        "listSpendByFramework",
        "listDailySpend",
      ],
      recondo_cost_projections: "getCostProjections",
      recondo_agent_summary: "getAgentSummary",
      recondo_agent_framework_distribution: "listAgentFrameworkDistribution",
      recondo_top: ["listTopDevelopers", "listTopRepositories"],
      recondo_tool_call_stats: "toolCallStats",
      recondo_audit_trail: "listAuditEvents",
      recondo_anomalies: "listAnomalies",
      recondo_compliance: [
        "getComplianceSummary",
        "listComplianceFrameworks",
        "listComplianceAuditLog",
      ],
      recondo_reports: "listReports",
      recondo_report_trends: [
        "listReportCoverageTrend",
        "listReportFindingsTrend",
      ],
      recondo_policies: ["listPolicies", "listPolicyTriggerHistory"],
      recondo_registered_keys: "listApiKeys",
    };
    for (const [tool, fn] of Object.entries(expected)) {
      const actual = READ_TOOL_TO_DATA_FN[tool];
      expect(actual, `missing mapping for ${tool}`).toBeDefined();
      if (Array.isArray(fn)) {
        expect(
          Array.isArray(actual) ? [...actual].sort() : actual,
          `mapping for ${tool} should be an array`,
        ).toEqual([...fn].sort());
      } else {
        expect(actual).toBe(fn);
      }
    }
  });

  it("does NOT include the dropped insights entry", () => {
    expect(READ_TOOL_TO_DATA_FN).not.toHaveProperty("recondo_insights");
  });
});

describe("D-C11 ACTION_TOOL_TO_DATA_FN map", () => {
  it("has exactly 7 entries", () => {
    expect(Object.keys(ACTION_TOOL_TO_DATA_FN).length).toBe(7);
  });

  it("uses RIGHT-column @recondo/data export names verbatim", () => {
    for (const [tool, fn] of Object.entries(ACTION_TOOL_TO_DATA_FN)) {
      expect(
        DATA_EXPORTS.has(fn),
        `action tool ${tool} maps to non-existent @recondo/data export: ${fn}`,
      ).toBe(true);
    }
  });

  it("contains each expected action tool → fn mapping", () => {
    const expected: Record<string, string> = {
      recondo_generate_report: "generateReport",
      recondo_update_control_status: "updateControlStatus",
      recondo_create_policy: "createPolicy",
      recondo_update_policy: "updatePolicy",
      recondo_delete_policy: "deletePolicy",
      recondo_register_key: "createApiKey",
      recondo_delete_key: "revokeApiKey",
    };
    for (const [tool, fn] of Object.entries(expected)) {
      expect(ACTION_TOOL_TO_DATA_FN[tool], `mapping for ${tool}`).toBe(fn);
    }
  });
});

describe("D-C11 READ_OPT_OUTS", () => {
  it("is a Record<string, string> with non-empty rationales", () => {
    expect(READ_OPT_OUTS).toBeDefined();
    expect(typeof READ_OPT_OUTS).toBe("object");
    for (const [name, rationale] of Object.entries(READ_OPT_OUTS)) {
      expect(typeof name).toBe("string");
      expect(typeof rationale).toBe("string");
      expect(
        rationale.trim().length,
        `opt-out ${name} has empty rationale`,
      ).toBeGreaterThan(0);
    }
  });

  it("every opt-out key is a real @recondo/data export", () => {
    for (const name of Object.keys(READ_OPT_OUTS)) {
      expect(
        DATA_EXPORTS.has(name),
        `opt-out ${name} is not a real @recondo/data export`,
      ).toBe(true);
    }
  });

  it("no opt-out key is also covered by a tool mapping (no overlaps)", () => {
    const covered = new Set<string>([
      ...flatReadValues(),
      ...Object.values(ACTION_TOOL_TO_DATA_FN),
    ]);
    for (const name of Object.keys(READ_OPT_OUTS)) {
      expect(
        covered.has(name),
        `opt-out ${name} is ALSO covered by a tool mapping (redundant)`,
      ).toBe(false);
    }
  });

  it("includes the canonical pool/health opt-outs", () => {
    // Per C0 §7 — these driver-shaped exports MUST be opt-outs.
    for (const name of ["getPool", "closePool", "checkDatabaseHealth"]) {
      expect(
        READ_OPT_OUTS,
        `expected ${name} in READ_OPT_OUTS`,
      ).toHaveProperty(name);
    }
  });

  it("includes insertAuditLog (audit writer, not a tool surface)", () => {
    // C0 §7 explicitly calls out insertAuditLog as an opt-out.
    expect(READ_OPT_OUTS).toHaveProperty("insertAuditLog");
  });

  it("includes the listStructured* dispatch surface", () => {
    for (const name of [
      "listStructuredSessions",
      "listStructuredTurns",
      "listStructuredAnomalies",
      "listStructuredCost",
      "listStructuredTools",
      "listStructuredRisk",
      "listStructuredCompliance",
      "listStructuredProvenance",
      "runStructuredQuery",
    ]) {
      expect(
        READ_OPT_OUTS,
        `expected ${name} in READ_OPT_OUTS`,
      ).toHaveProperty(name);
    }
  });
});

describe("D-C11 runLint() — parity holds", () => {
  it("returns {violations: []} on the live catalog", () => {
    const result = runLint();
    expect(result.violations).toEqual([]);
  });

  it("union of (read map values, action map values, opt-out keys) covers every @recondo/data export", () => {
    const covered = new Set<string>([
      ...flatReadValues(),
      ...Object.values(ACTION_TOOL_TO_DATA_FN),
      ...Object.keys(READ_OPT_OUTS),
    ]);
    const missing = [...DATA_EXPORTS].filter((name) => !covered.has(name));
    expect(
      missing,
      `@recondo/data exports not in any tool map or opt-out: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});

describe("D-C11 runLint() — violation cases", () => {
  it("uncovered_export: an export not in any map or opt-out", () => {
    const result = runLint({
      dataExports: ["listSessions", "ghostExport"],
      readMap: { recondo_list_sessions: "listSessions" },
      actionMap: {},
      optOuts: {},
    });
    const kinds = result.violations.map((v) => v.kind);
    expect(kinds).toContain("uncovered_export");
    const v = result.violations.find((x) => x.kind === "uncovered_export");
    expect(v?.export).toBe("ghostExport");
    expect(v?.message.length).toBeGreaterThan(0);
  });

  it("phantom_mapping: read map points to a non-existent export", () => {
    const result = runLint({
      dataExports: ["listSessions"],
      readMap: { recondo_list_sessions: "doesNotExist" },
      actionMap: {},
      optOuts: { listSessions: "covered" },
    });
    const kinds = result.violations.map((v) => v.kind);
    expect(kinds).toContain("phantom_mapping");
    const v = result.violations.find((x) => x.kind === "phantom_mapping");
    expect(v?.export).toBe("doesNotExist");
  });

  it("phantom_mapping: action map points to a non-existent export", () => {
    const result = runLint({
      dataExports: ["createPolicy"],
      readMap: {},
      actionMap: { recondo_create_policy: "createPolicyButTypo" },
      optOuts: { createPolicy: "covered" },
    });
    const kinds = result.violations.map((v) => v.kind);
    expect(kinds).toContain("phantom_mapping");
    const v = result.violations.find((x) => x.kind === "phantom_mapping");
    expect(v?.export).toBe("createPolicyButTypo");
  });

  it("phantom_opt_out: opt-out entry duplicates a covered mapping", () => {
    const result = runLint({
      dataExports: ["listSessions"],
      readMap: { recondo_list_sessions: "listSessions" },
      actionMap: {},
      optOuts: { listSessions: "redundant — already covered by read map" },
    });
    const kinds = result.violations.map((v) => v.kind);
    expect(kinds).toContain("phantom_opt_out");
    const v = result.violations.find((x) => x.kind === "phantom_opt_out");
    expect(v?.export).toBe("listSessions");
  });

  it("returns the LintResult shape with a `violations` array", () => {
    const result: LintResult = runLint({
      dataExports: ["listSessions"],
      readMap: {},
      actionMap: {},
      optOuts: { listSessions: "out of scope" },
    });
    expect(result).toHaveProperty("violations");
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it("read map array values are validated element-wise (each must exist)", () => {
    const result = runLint({
      dataExports: ["listSpendByProvider", "listSpendByModel"],
      readMap: {
        recondo_spend: [
          "listSpendByProvider",
          "listSpendByModelTYPO",
          "listSpendByModel",
        ],
      },
      actionMap: {},
      optOuts: {},
    });
    const phantoms = result.violations
      .filter((v) => v.kind === "phantom_mapping")
      .map((v) => v.export);
    expect(phantoms).toContain("listSpendByModelTYPO");
  });
});
