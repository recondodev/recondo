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
