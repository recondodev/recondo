// Public surface of @recondo/data.

// Pool / health (driver-shaped but kept here as the canonical home;
// transport-import lint excludes pg).
export { getPool, closePool, checkDatabaseHealth } from "./pool.js";

// Type vocabulary.
export type {
  ApiKeyInfo,
  ListEnvelope,
  SinceCursor,
  SinceCursorPayload,
  QueryOptions,
  ListOptions,
} from "./types.js";
export { DataValidationError } from "./types.js";

// Envelope + cursor codec.
export type { EnvelopeMeta } from "./envelope.js";
export {
  encodeSinceCursor,
  decodeSinceCursor,
  uniformListEnvelope,
} from "./envelope.js";

// Async iterator adapters.
export { rowsToAsyncIterable, abortableIterable } from "./async-iter.js";

// Redaction subsystem — namespaced barrel for new consumers, plus
// flat re-exports for backward compatibility with the api/ shim.
export * as redaction from "./redaction/index.js";
export {
  PLACEHOLDER_PREFIXES,
  MASKED_PLACEHOLDER_REPLACEMENT,
  isAttachmentPlaceholder,
  maskPlaceholderPaths,
  sanitizeRowTextFields,
  TURN_TEXT_FIELDS,
  SESSION_TEXT_FIELDS,
  TOOL_CALL_TEXT_FIELDS,
  ANOMALY_TEXT_FIELDS,
  sanitizeAnomalyRow,
  SQL_PREFIX_NAMES,
  SQL_PREFIX_ALTERNATION,
  placeholderLikePatterns,
  looksLikePathProbe,
} from "./redaction/index.js";

// Auth — header parsing + token validation.
export { authenticateApiKey, authenticateRequest } from "./auth.js";

// Row mappers (PostgreSQL snake_case -> GraphQL camelCase) + helpers.
export {
  mapSession,
  mapTurn,
  mapToolCall,
  mapAnomaly,
  escapeIlike,
  formatTimestamp,
} from "./mappers.js";
export type {
  MappedSession,
  MappedUserTurn,
  MappedAttachment,
  MappedTurn,
  MappedToolCall,
  MappedAnomaly,
} from "./mappers.js";

// Structured query primitives — per-operation iterables + the legacy
// /v1/query dispatcher.
export {
  listStructuredSessions,
  listStructuredTurns,
  listStructuredAnomalies,
  listStructuredCost,
  listStructuredTools,
  listStructuredRisk,
  listStructuredCompliance,
  listStructuredProvenance,
  runStructuredQuery,
} from "./structured-query.js";

// Sessions: list / detail / userTurns. The GraphQL Connection
// re-shaping (items/total/limit/offset) stays in api/.
export { listSessions, getSession, listUserTurns } from "./sessions.js";
export type { SessionFilter, SessionListItem } from "./sessions.js";

// Turns: detail + search + verify. The api/ resolver materialises the
// AsyncIterable via Array.fromAsync.
export { getTurn, searchTurns, verifyIntegrity } from "./turns.js";
export type { VerifyIntegrityResult } from "./turns.js";

// Turn raw-body access (C1): metadata + chunked reads against the
// content-addressable object store.
export { getTurnRawMetadata, getTurnRawChunk } from "./turns-raw.js";
export type { TurnRawMetadata, TurnRawChunk } from "./turns-raw.js";

// Cross-turn comparison (C2): side-by-side aspect rows for a set of turns.
export { compareTurns } from "./compare-turns.js";
export type {
  CompareAspect,
  CompareTurnsRow,
  CompareTurnsResult,
} from "./compare-turns.js";

// Find similar prompts (C3): byte-identical match by turn id or literal text.
export { findSimilarPrompts } from "./find-similar-prompts.js";
export type {
  SimilarPromptMatch,
  FindSimilarPromptsInput,
} from "./find-similar-prompts.js";

// Related turns (C4, T6): yield turns related to a given turn by one of
// three relations — same_session, same_prompt_hash, retry_of (mapped to
// supersedes_turn_id).
export { relatedTurns } from "./related-turns.js";
export type { Relation, RelatedTurnsRow } from "./related-turns.js";

// Session efficiency (C5, T7): single-round-trip aggregate summarizing
// cache hit rate, prompt reuse, tokens-per-turn percentile summary,
// redundant tool calls, and TTFT percentile summary for a session.
export { sessionEfficiency } from "./session-efficiency.js";
export type {
  SessionEfficiency,
  PercentileSummary,
} from "./session-efficiency.js";

// Object store (local driver). Future drivers (S3) will land alongside.
export { LocalObjectStore } from "./object-store/local.js";
export type { LocalObjectStoreOpts } from "./object-store/local.js";

// Anomalies: list with project scoping + since-cursor support.
export { listAnomalies } from "./anomalies.js";
export type { AnomaliesFilter } from "./anomalies.js";

// Cost intelligence: usage summary, spend buckets, daily spend, projections.
export {
  resolveDateRange,
  getUsageSummary,
  listSpendByProvider,
  listSpendByModel,
  listSpendByFramework,
  listDailySpend,
  getCostProjections,
} from "./cost.js";
export type {
  CostQueryArgs,
  SpendBucket,
  UsageSummary,
  CostProjection,
} from "./cost.js";

// Audit trail: list events for GraphQL + bulk fetch for REST exports.
export { listAuditEvents, getAuditEntries } from "./audit.js";
export type {
  AuditEntry,
  AuditEventsFilter,
  AuditEntriesOpts,
  IntegrityStatusString,
} from "./audit.js";

// Compliance posture: summary, frameworks, audit log + control mutation.
export {
  getComplianceSummary,
  listComplianceFrameworks,
  listComplianceAuditLog,
  listComplianceFindings,
  updateControlStatus,
} from "./compliance.js";
export type {
  ComplianceSummaryRow,
  ComplianceFrameworkRow,
  ComplianceControlRow,
  ComplianceAuditEntry,
  ComplianceAuditFilter,
  ComplianceFindingsBySeverity,
  UpdateControlInput,
  UpdateControlPayload,
  UpdateControlError,
} from "./compliance.js";

// Realtime: stats, feed (AsyncIterable), gateway status, shared SQL helpers.
export {
  getRealtimeStats,
  listRealtimeFeed,
  getGatewayStatus,
  buildGroupingCTEs,
  EXCLUDE_PURE_PREFLIGHT_SQL,
} from "./realtime.js";
export type {
  RealtimeStatsRow,
  RealtimeFeedArgs,
  RealtimeFeedItem,
  RealtimeLatencySourceString,
  GatewayStatusRow,
} from "./realtime.js";

// Agent analytics: summary, framework distribution, top devs/repos, activity.
export {
  getAgentSummary,
  listAgentFrameworkDistribution,
  listTopDevelopers,
  listTopRepositories,
  listAgentActivity,
} from "./agents.js";
export type {
  AgentQueryArgs,
  AgentSummaryRow,
  AgentFrameworkUsage,
  DeveloperRow,
  RepositoryRow,
  AgentActivityRow,
} from "./agents.js";

// Compliance reports: list + detail + trends + generate mutation.
export {
  listReports,
  getReport,
  listReportCoverageTrend,
  listReportFindingsTrend,
  generateReport,
} from "./reports.js";
export type {
  ReportRow,
  ReportFilter,
  ReportFindings,
  TrendPoint,
  GenerateReportInput,
  GenerateReportPayload,
  GenerateReportError,
} from "./reports.js";

// Policies: list + detail + trigger-history trend + create/update/delete.
export {
  listPolicies,
  getPolicy,
  listPolicyTriggerHistory,
  createPolicy,
  updatePolicy,
  deletePolicy,
} from "./policies.js";
export type {
  PolicyRow,
  PolicyFilter,
  PolicyTrendPoint,
  CreatePolicyInput,
  UpdatePolicyInput,
} from "./policies.js";

// Registered LLM API keys: list + create/revoke (operates on registered_keys
// table; the resolver layer keeps the GraphQL operation names registeredKeys
// / registerKey / deleteKey for dashboard compatibility).
export {
  listApiKeys,
  createApiKey,
  revokeApiKey,
} from "./keys.js";
export type {
  ApiKeyRecord,
  ApiKeyFilter,
  CreateApiKeyInput,
} from "./keys.js";
