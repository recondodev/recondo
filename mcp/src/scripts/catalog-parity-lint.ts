/**
 * Catalog parity lint — Phase 1 (D-C11).
 *
 * Asserts that every export in the `@recondo/data` public surface is
 * accounted for in exactly one of:
 *   - READ_TOOL_TO_DATA_FN  — read-tool name → data fn(s)
 *   - ACTION_TOOL_TO_DATA_FN — action-tool name → data fn
 *   - READ_OPT_OUTS         — internal/driver/legacy exports we deliberately
 *                              do NOT surface as MCP tools (rationale required)
 *
 * Phase 1 covers NAME PARITY only. The action-immutability invariant
 * (action tools must not write tables that capture-side code owns) is
 * deliberately deferred to Phase 2 — see TODO marker at the bottom of
 * this file.
 *
 * The compiled script (`mcp/dist/scripts/catalog-parity-lint.js`) is
 * invoked by `just mcp-lint-parity` as a child process; it exits 0 when
 * parity holds and 1 with a per-violation message on stderr otherwise.
 */
import * as data from "@recondo/data";

// ---------------------------------------------------------------------
// Canonical maps (pinned by the C11 Test Writer per the C0 §1 audit).
// ---------------------------------------------------------------------

/**
 * Read-only MCP tools → `@recondo/data` export name(s). Tools that
 * dispatch to multiple data-layer functions list them as an array
 * (e.g. `recondo_spend` fans out across four spend-bucket fns).
 */
export const READ_TOOL_TO_DATA_FN: Record<string, string | string[]> = {
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
  recondo_report_trends: ["listReportCoverageTrend", "listReportFindingsTrend"],
  recondo_policies: ["listPolicies", "listPolicyTriggerHistory"],
  recondo_registered_keys: "listApiKeys",
};

/**
 * Mutating MCP tools → `@recondo/data` export name. Each entry maps to
 * exactly one data fn; fan-out is not allowed for action tools because
 * the C13-8 row-count hashing test asserts a single mutation surface
 * per tool.
 */
export const ACTION_TOOL_TO_DATA_FN: Record<string, string> = {
  recondo_generate_report: "generateReport",
  recondo_update_control_status: "updateControlStatus",
  recondo_create_policy: "createPolicy",
  recondo_update_policy: "updatePolicy",
  recondo_delete_policy: "deletePolicy",
  recondo_register_key: "createApiKey",
  recondo_delete_key: "revokeApiKey",
};

/**
 * `@recondo/data` exports the MCP server intentionally does NOT expose
 * as a tool. Each value is a one-line rationale; new entries should be
 * added with care, since the lint catches accidental drops in tool
 * coverage by demanding parity with the data layer.
 */
export const READ_OPT_OUTS: Record<string, string> = {
  // Pool / health — driver-shaped exports kept in @recondo/data as their
  // canonical home; not exposed as tools (operators use process metrics).
  getPool: "driver-shaped pool accessor; not a tool surface",
  closePool: "driver-shaped pool teardown; not a tool surface",
  checkDatabaseHealth: "driver-shaped health probe; not a tool surface",

  // Audit writer — used by the MCP server itself for per-call audit, not
  // a tool that callers can invoke.
  insertAuditLog: "internal audit writer used by MCP server, not a tool",

  // listStructured* — legacy /v1/query dispatcher surface still used by
  // the api/ shim; tool-side queries go through the per-domain tools.
  listStructuredSessions:
    "legacy /v1/query dispatcher; superseded by recondo_list_sessions",
  listStructuredTurns:
    "legacy /v1/query dispatcher; superseded by recondo_search / recondo_get_turn",
  listStructuredAnomalies:
    "legacy /v1/query dispatcher; superseded by recondo_anomalies",
  listStructuredCost:
    "legacy /v1/query dispatcher; superseded by recondo_spend / recondo_usage_summary",
  listStructuredTools:
    "legacy /v1/query dispatcher; superseded by recondo_tool_call_stats",
  listStructuredRisk:
    "legacy /v1/query dispatcher; risk surface not a tool yet",
  listStructuredCompliance:
    "legacy /v1/query dispatcher; superseded by recondo_compliance",
  listStructuredProvenance:
    "legacy /v1/query dispatcher; provenance surface not a tool yet",
  runStructuredQuery:
    "legacy /v1/query top-level dispatcher; superseded by per-domain tools",

  // Auth — header parsing + token validation; used by the MCP server
  // transport to authenticate callers before tool dispatch.
  authenticateApiKey: "transport-side auth helper, not a tool",
  authenticateRequest: "transport-side auth helper, not a tool",

  // Envelope + cursor codec — used by tools internally to encode/decode
  // pagination; not callable as tools themselves.
  encodeSinceCursor: "internal pagination codec, not a tool",
  decodeSinceCursor: "internal pagination codec, not a tool",
  uniformListEnvelope: "internal envelope helper, not a tool",

  // Async iterator adapters — internal helpers consumed by data fns.
  rowsToAsyncIterable: "internal async-iter adapter, not a tool",
  abortableIterable: "internal async-iter adapter, not a tool",

  // Redaction subsystem — internal helpers (and a namespaced barrel) used
  // when serialising tool output; not a tool surface.
  redaction: "redaction namespace barrel, not a tool",
  PLACEHOLDER_PREFIXES: "redaction constants, not a tool",
  MASKED_PLACEHOLDER_REPLACEMENT: "redaction constants, not a tool",
  isAttachmentPlaceholder: "redaction predicate, not a tool",
  maskPlaceholderPaths: "redaction helper, not a tool",
  sanitizeRowTextFields: "redaction helper, not a tool",
  TURN_TEXT_FIELDS: "redaction field whitelist, not a tool",
  SESSION_TEXT_FIELDS: "redaction field whitelist, not a tool",
  TOOL_CALL_TEXT_FIELDS: "redaction field whitelist, not a tool",
  ANOMALY_TEXT_FIELDS: "redaction field whitelist, not a tool",
  sanitizeAnomalyRow: "redaction helper for anomaly rows, not a tool",
  SQL_PREFIX_NAMES: "redaction SQL-prefix list, not a tool",
  SQL_PREFIX_ALTERNATION: "redaction SQL regex alternation, not a tool",
  placeholderLikePatterns: "redaction pattern helper, not a tool",
  looksLikePathProbe: "redaction predicate, not a tool",

  // Row mappers — snake_case → camelCase converters consumed inside the
  // data layer; tool callers see the mapped output via the actual fns.
  mapSession: "internal row mapper, not a tool",
  mapTurn: "internal row mapper, not a tool",
  mapToolCall: "internal row mapper, not a tool",
  mapAnomaly: "internal row mapper, not a tool",
  escapeIlike: "internal SQL ILIKE escape helper, not a tool",
  formatTimestamp: "internal timestamp formatter, not a tool",

  // Validation error class — exported so callers can `instanceof` against
  // it; not a tool.
  DataValidationError: "validation error class, not a tool",

  // Object store driver — capture-side dependency, surfaced to the data
  // layer but not exposed as a tool (object access goes through
  // recondo_get_turn_raw_metadata / _chunk).
  LocalObjectStore: "capture-side object store driver, not a tool",

  // Object root resolver — used by getTurnRawMetadata / getTurnRawChunk
  // internally; the chunk/metadata tools are the public surface.
  resolveObjectsRoot: "internal object-store root resolver, not a tool",

  // Realtime SQL helpers — composed into realtime fns that ARE tools.
  buildGroupingCTEs: "internal realtime SQL helper, not a tool",
  EXCLUDE_PURE_PREFLIGHT_SQL: "internal realtime SQL constant, not a tool",

  // Cost SQL helper — date-range resolver consumed by the cost fns that
  // ARE tools.
  resolveDateRange: "internal cost-window date resolver, not a tool",

  // Sessions detail-only fn — userTurns is rolled into recondo_get_session
  // (which returns the session + its user turns); not a tool on its own.
  listUserTurns: "rolled into recondo_get_session response, not a tool",

  // Audit bulk fetch — used by REST exports in the api/ layer; the
  // recondo_audit_trail tool surfaces the streaming `listAuditEvents`.
  getAuditEntries: "REST-export bulk audit fetch, not a tool",

  // Reports detail — single-row fetch; the recondo_reports tool returns
  // a list, and detail rendering is dashboard-side.
  getReport: "single-report detail fetch; tool surface lists reports",

  // Policies detail — same pattern as reports: list is a tool, single-row
  // detail is dashboard-only.
  getPolicy: "single-policy detail fetch; tool surface lists policies",

  // Compliance findings — used by the dashboard for drilldown; the
  // recondo_compliance tool surfaces summary/frameworks/audit-log.
  listComplianceFindings:
    "dashboard drilldown; recondo_compliance covers summary surface",

  // Agent activity — granular per-event stream; recondo_agent_summary
  // and recondo_top cover the aggregate tool surface.
  listAgentActivity:
    "granular agent-event stream; recondo_agent_summary covers aggregate",
};

// ---------------------------------------------------------------------
// Lint runtime.
// ---------------------------------------------------------------------

export interface LintViolation {
  kind: "uncovered_export" | "phantom_mapping" | "phantom_opt_out";
  export: string;
  message: string;
}

export interface LintResult {
  violations: LintViolation[];
}

/**
 * Run the parity lint. Optional `opts` are for unit-test injection;
 * production callers (the CLI entry point) pass nothing and the lint
 * runs against the live `@recondo/data` exports + canonical maps.
 */
export function runLint(opts?: {
  dataExports?: ReadonlyArray<string>;
  readMap?: Record<string, string | string[]>;
  actionMap?: Record<string, string>;
  optOuts?: Record<string, string>;
}): LintResult {
  const dataExports = new Set(
    opts?.dataExports ?? Object.keys(data as Record<string, unknown>),
  );
  const readMap = opts?.readMap ?? READ_TOOL_TO_DATA_FN;
  const actionMap = opts?.actionMap ?? ACTION_TOOL_TO_DATA_FN;
  const optOuts = opts?.optOuts ?? READ_OPT_OUTS;

  const violations: LintViolation[] = [];

  // Flatten read-map values into a single list of (tool, fnName) pairs
  // so we can validate array elements individually.
  const readPairs: Array<[string, string]> = [];
  for (const [tool, v] of Object.entries(readMap)) {
    if (Array.isArray(v)) {
      for (const fn of v) readPairs.push([tool, fn]);
    } else {
      readPairs.push([tool, v]);
    }
  }

  const coveredByTools = new Set<string>([
    ...readPairs.map(([, fn]) => fn),
    ...Object.values(actionMap),
  ]);

  // Check 1 — uncovered_export: any data export not in the union of
  // (read-map values, action-map values, opt-out keys).
  const optOutKeys = new Set(Object.keys(optOuts));
  for (const name of dataExports) {
    if (!coveredByTools.has(name) && !optOutKeys.has(name)) {
      violations.push({
        kind: "uncovered_export",
        export: name,
        message: `@recondo/data export '${name}' is not surfaced by any tool and not declared as an opt-out (rationale required in READ_OPT_OUTS)`,
      });
    }
  }

  // Check 2 — phantom_mapping: a tool maps to a non-existent export.
  for (const [tool, fn] of readPairs) {
    if (!dataExports.has(fn)) {
      violations.push({
        kind: "phantom_mapping",
        export: fn,
        message: `read tool '${tool}' maps to non-existent @recondo/data export '${fn}'`,
      });
    }
  }
  for (const [tool, fn] of Object.entries(actionMap)) {
    if (!dataExports.has(fn)) {
      violations.push({
        kind: "phantom_mapping",
        export: fn,
        message: `action tool '${tool}' maps to non-existent @recondo/data export '${fn}'`,
      });
    }
  }

  // Check 3 — phantom_opt_out: an opt-out entry duplicates a tool
  // mapping (already covered → opt-out is redundant and should be
  // removed so coverage stays unambiguous).
  for (const name of optOutKeys) {
    if (coveredByTools.has(name)) {
      violations.push({
        kind: "phantom_opt_out",
        export: name,
        message: `opt-out '${name}' is already covered by a tool mapping (redundant; remove it from READ_OPT_OUTS)`,
      });
    }
  }

  return { violations };
}

// ---------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runLint();
  if (result.violations.length === 0) {
    console.error(
      "[mcp-lint-parity] OK — catalog parity holds; every @recondo/data export is covered by a tool mapping or an opt-out.",
    );
    process.exit(0);
  } else {
    for (const v of result.violations) {
      console.error(`[mcp-lint-parity] ${v.kind}: ${v.export} — ${v.message}`);
    }
    console.error(
      `[mcp-lint-parity] FAIL — ${result.violations.length} violation(s); see above.`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------
// Phase 2 TODO — action-immutability lint (deferred).
// ---------------------------------------------------------------------
// TODO(plan-e, Phase 2): Add an action-immutability lint that walks
// ACTION_TOOL_TO_DATA_FN against a `__tableTargets` metadata field
// attached to every @recondo/data export, asserting that no action tool
// writes a table owned by capture-side code (turns, sessions, tool_calls,
// anomalies, captures, ...). The mechanism requires `__tableTargets` on
// every export and is out of scope for Phase 1.
//
// Until Phase 2 lands, the load-bearing replacement is the D-C13-8
// integration test (`mcp/tests/integration/action_immutability.test.ts`)
// which row-count-hashes the captured tables before and after every
// action-tool invocation and fails on any drift. Operators reading this
// lint should know the immutability invariant IS enforced — just by a
// runtime test instead of a static check.
