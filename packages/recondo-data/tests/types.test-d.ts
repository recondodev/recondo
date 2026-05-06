/**
 * Type-level test (D-TY1): every exported async function MUST accept
 * `{ signal?: AbortSignal }` as its options parameter.
 *
 * This file is type-checked as part of `tsc --noEmit -p tsconfig.test.json`
 * — if any function loses its signal parameter, this file fails to compile.
 *
 * Pool helpers (`getPool`, `closePool`, `checkDatabaseHealth`) intentionally
 * do not take options — they are excluded from the contract.
 */

import { expectTypeOf } from "expect-type";
import {
  // Auth
  authenticateApiKey,
  authenticateRequest,
  // Sessions
  listSessions,
  getSession,
  listUserTurns,
  // Turns
  getTurn,
  searchTurns,
  // Anomalies
  listAnomalies,
  // Cost
  getUsageSummary,
  listSpendByProvider,
  listSpendByModel,
  listSpendByFramework,
  listDailySpend,
  getCostProjections,
  // Audit
  listAuditEvents,
  // Compliance
  listComplianceFindings,
  // Realtime
  getRealtimeStats,
  listRealtimeFeed,
  getGatewayStatus,
  // Agents
  listAgentActivity,
  // Reports
  listReports,
  getReport,
  generateReport,
  // Policies
  listPolicies,
  getPolicy,
  createPolicy,
  updatePolicy,
  deletePolicy,
  // Keys
  listApiKeys,
  createApiKey,
  revokeApiKey,
  // Structured query
  runStructuredQuery,
  listStructuredSessions,
  listStructuredTurns,
  listStructuredAnomalies,
  listStructuredCost,
  listStructuredTools,
  listStructuredRisk,
  listStructuredCompliance,
  listStructuredProvenance,
  // Related turns (Chunk 4, T6 — D-RT5)
  relatedTurns,
  type Relation,
  // Tool call stats (Chunk 6, T8 — D-TS10)
  toolCallStats,
  type ToolCallStatsRow,
  type ToolCallGroupBy,
  type ToolCallPeriod,
} from "../src/index.js";

// auth
expectTypeOf(authenticateApiKey).parameter(1).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(authenticateRequest).parameter(1).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();

// sessions
expectTypeOf(listSessions).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(getSession).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(listUserTurns).parameter(1).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();

// turns
expectTypeOf(getTurn).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(searchTurns).parameter(3).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();

// anomalies, audit, compliance
expectTypeOf(listAnomalies).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(listAuditEvents).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(listComplianceFindings).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();

// cost
expectTypeOf(getUsageSummary).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(listSpendByProvider).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(listSpendByModel).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(listSpendByFramework).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(listDailySpend).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(getCostProjections).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();

// realtime
expectTypeOf(getRealtimeStats).parameter(1).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(listRealtimeFeed).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(getGatewayStatus).parameter(1).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();

// agents
expectTypeOf(listAgentActivity).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();

// reports
expectTypeOf(listReports).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(getReport).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(generateReport).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();

// policies
expectTypeOf(listPolicies).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(getPolicy).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(createPolicy).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(updatePolicy).parameter(3).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(deletePolicy).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();

// keys
expectTypeOf(listApiKeys).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(createApiKey).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(revokeApiKey).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();

// structured query
expectTypeOf(runStructuredQuery).parameter(5).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(listStructuredSessions).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(listStructuredTurns).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(listStructuredAnomalies).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(listStructuredCost).parameter(3).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(listStructuredTools).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(listStructuredRisk).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(listStructuredCompliance).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
expectTypeOf(listStructuredProvenance).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();

// related turns
// D-RT5: Relation type has EXACTLY 3 members. The legacy "caused_by" and
// "same_tool_chain" relations are DROPPED because their backing columns
// (`caused_by_turn_id`, `tool_chain_id`) do not exist on `turns`.
// `toEqualTypeOf` is bidirectional — adding OR removing a member from
// `Relation` makes this assertion fail to compile.
expectTypeOf<Relation>().toEqualTypeOf<
  "same_session" | "same_prompt_hash" | "retry_of"
>();
expectTypeOf(relatedTurns).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();

// tool call stats (C6 / T8)
//
// D-TS10: ToolCallStatsRow MUST NOT include a `token_cost_total` field.
// The `tool_calls` table has NO `token_cost` column, so any output type
// or SQL referencing `token_cost*` is incorrect by construction. The
// `total_duration_ms = SUM(duration_ms)` field replaces the legacy
// token-cost aggregate.
//
// The cleanest static guard: assert the closed key-set of the row type.
// `toEqualTypeOf` is bidirectional — adding `token_cost_total` (or any
// other field) makes this fail to compile, AND removing any of the
// documented fields makes it fail to compile. This catches:
//   - implementer reintroducing the legacy `token_cost_total` field, AND
//   - implementer dropping a required field by typo.
expectTypeOf<ToolCallStatsRow>().toEqualTypeOf<{
  group_key: string;
  total_calls: number;
  failure_rate: number;
  avg_latency_ms: number;
  total_duration_ms: number;
}>();

// Belt-and-suspenders: explicit assertion that the legacy field is NOT
// part of the row type (a `key in T` test forced into the type system).
type _NoTokenCostTotal = "token_cost_total" extends keyof ToolCallStatsRow
  ? never
  : true;
const _ttGuard: _NoTokenCostTotal = true;
void _ttGuard;

// Group-by / period vocabularies are the closed sets we documented.
expectTypeOf<ToolCallGroupBy>().toEqualTypeOf<
  "tool_name" | "session" | "framework"
>();
expectTypeOf<ToolCallPeriod>().toEqualTypeOf<"24h" | "7d" | "30d" | "all">();

// toolCallStats accepts a single options object containing `signal`.
expectTypeOf(toolCallStats).parameter(0).toMatchTypeOf<{
  group_by: ToolCallGroupBy;
  period: ToolCallPeriod;
  signal?: AbortSignal;
}>();

// Return type is AsyncIterable<ToolCallStatsRow> (NOT Promise<Row[]>).
expectTypeOf(toolCallStats).returns.toMatchTypeOf<AsyncIterable<ToolCallStatsRow>>();
