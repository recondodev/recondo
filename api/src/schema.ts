/**
 * GraphQL schema type definitions.
 *
 * B3 fix: The schema is defined as a template literal string for runtime use,
 * rather than using readFileSync on schema.graphql. This avoids the problem
 * where schema.graphql would not be present in `dist/src/` after tsc compilation.
 *
 * The canonical schema source is `schema.graphql` (used by codegen to generate
 * TypeScript types). This file mirrors it exactly for runtime consumption by
 * Apollo Server. If you change the schema, update BOTH files.
 *
 * Codegen reads from: src/schema.graphql  (via codegen.ts config)
 * Runtime reads from: this file            (via typeDefs export)
 */

export const typeDefs = /* GraphQL */ `
scalar DateTime

type Query {
  sessions(filter: SessionFilter, limit: Int, offset: Int): SessionConnection!
  session(id: ID!): Session
  turn(id: ID!): Turn
  search(query: String!, projectId: ID): [Turn!]!
  verifyIntegrity(sessionId: ID!): IntegrityReport!
  anomalies(filter: AnomalyFilter, limit: Int, offset: Int): [AnomalyEvent!]!
  realtimeStats: RealtimeStats!
  realtimeFeed(provider: String, limit: Int, since: DateTime): [FeedItem!]!
  gatewayStatus: GatewayStatus!
  """D4.1: Audit trail query with search, type filter, date range, and pagination."""
  auditTrail(search: String, type: AuditTypeFilter, period: Period, from: DateTime, to: DateTime, limit: Int, offset: Int): AuditConnection!
  """D4.3: Usage summary for a given period or date range."""
  usageSummary(period: Period, from: DateTime, to: DateTime): UsageSummary!
  """D4.3: Spend breakdown by LLM provider."""
  spendByProvider(period: Period, from: DateTime, to: DateTime): [SpendByCategory!]!
  """D4.3: Spend breakdown by model."""
  spendByModel(period: Period, from: DateTime, to: DateTime): [SpendByCategory!]!
  """D4.3: Spend breakdown by agent framework."""
  spendByFramework(period: Period, from: DateTime, to: DateTime): [SpendByCategory!]!
  """D4.3: Daily spend totals for the last N days. Uses 'days' parameter for simplicity. For custom date ranges, use spendByProvider/Model/Framework with from/to."""
  dailySpend(days: Int): [SpendByCategory!]!
  """D4.3: 3-month cost projection based on linear extrapolation."""
  costProjections: [CostProjection!]!
  """D5.1: Agent analytics summary for a given period."""
  agentSummary(period: Period, from: DateTime, to: DateTime): AgentSummary!
  """D5.1: Framework distribution for agent sessions in a given period."""
  agentFrameworkDistribution(period: Period, from: DateTime, to: DateTime): [SpendByCategory!]!
  """D5.1: Top developers by cost, paginated. Accepts period only. For custom date ranges, use agentSummary which supports from/to."""
  topDevelopers(limit: Int, offset: Int, period: Period): DeveloperConnection!
  """D5.1: Top repositories by session count, paginated. Accepts period only. For custom date ranges, use agentSummary which supports from/to."""
  topRepositories(limit: Int, offset: Int, period: Period): RepositoryConnection!
  """D5.2: Compliance posture summary."""
  complianceSummary: ComplianceSummary!
  """D5.2: All compliance frameworks with nested controls."""
  complianceFrameworks: [ComplianceFramework!]!
  """D5.2: Paginated compliance audit log."""
  complianceAuditLog(controlId: ID, limit: Int, offset: Int): ComplianceAuditConnection!
  """D6.1: Paginated reports list."""
  reports(limit: Int, offset: Int): ReportConnection!
  """D6.1: Coverage trend data points."""
  reportCoverageTrend: [TrendPoint!]!
  """D6.1: Findings trend data points."""
  reportFindingsTrend: [TrendPoint!]!
  """D6.2: Paginated policies list."""
  policies(limit: Int, offset: Int): PolicyConnection!
  """D6.2: Policy trigger history as daily counts."""
  policyTriggerHistory(days: Int): [TrendPoint!]!
  """D6.3: Paginated registered keys list."""
  registeredKeys(limit: Int, offset: Int): KeyConnection!
}

type Mutation {
  """D5.2: Update a compliance control status."""
  updateControlStatus(controlId: ID!, input: UpdateControlStatusInput!): UpdateControlPayload!
  """D6.1: Generate a compliance report for a framework and period."""
  generateReport(input: GenerateReportInput!): GenerateReportPayload!
  """D6.2: Create a new governance policy."""
  createPolicy(input: CreatePolicyInput!): PolicyPayload!
  """D6.2: Update an existing governance policy."""
  updatePolicy(id: ID!, input: UpdatePolicyInput!): PolicyPayload!
  """D6.2: Delete a governance policy."""
  deletePolicy(id: ID!): DeletePayload!
  """D6.3: Register an LLM API key."""
  registerKey(input: RegisterKeyInput!): RegisterKeyPayload!
  """D6.3: Delete a registered key."""
  deleteKey(id: ID!): DeletePayload!
}

input SessionFilter {
  provider: String
  model: String
  projectId: ID
  startedAfter: DateTime
  startedBefore: DateTime
  status: String
  framework: String
  search: String
  hideNonLlm: Boolean
}

input AnomalyFilter {
  severity: String
  sessionId: ID
  anomalyType: String
  since: DateTime
}

type SessionConnection {
  items: [Session!]!
  total: Int!
  limit: Int!
  offset: Int!
}

type Session {
  id: ID!
  projectId: ID
  agentId: String
  """W14: model and provider should always be populated by the gateway"""
  model: String
  provider: String!
  startedAt: DateTime!
  endedAt: DateTime
  lastActiveAt: DateTime
  initialIntent: String
  systemPromptHash: String!
  totalTurns: Int!
  turnsCaptured: Int!
  droppedEvents: Int!
  totalTokens: Int!
  totalCostUsd: Float!
  turns: [Turn!]!
  """Grouped logical turns. Each UserTurn collapses contiguous same-user_request_text wire turns (preflight + title-gen + tool-loop iterations) into a single row. Use for primary UI; use turns for wire-level audit."""
  userTurns: [UserTurn!]!
  """Derived title from the first haiku title-generation turn's JSON response ({"title": "..."}) when present. Null when Claude Code / framework did not generate a title."""
  title: String
  complete: Boolean!
  framework: String
  status: String!
  duration: Int
  accountUuid: String
  deviceId: String
  gitRepo: String
  gitBranch: String
  cacheReadTokens: Int!
  cacheCreationTokens: Int!
}

type Turn {
  id: ID!
  sessionId: ID!
  sequenceNum: Int!
  timestamp: DateTime!
  turnType: String
  inputTokens: Int!
  outputTokens: Int!
  thinkingTokens: Int!
  totalTokens: Int!
  costUsd: Float!
  latencyMs: Int
  captureComplete: Boolean!
  contentHashReq: String
  contentHashResp: String
  stopReason: String
  model: String
  provider: String
  toolCallCount: Int!
  toolCalls: [ToolCall!]!
  anomalies: [AnomalyEvent!]!
  userRequestText: String
  responseText: String
  thinkingText: String
  cacheReadTokens: Int!
  cacheCreationTokens: Int!
  httpStatus: Int
  transport: String
  ttfbMs: Int
  durationMs: Int
  requestHash: String
  responseHash: String
  """Sprint P1B: inline attachments (images / PDFs / documents) the user or agent sent with this turn."""
  attachments: [Attachment!]!
  """Sprint P1B: count of attachments on this turn."""
  attachmentCount: Int!
}

"""Sprint P1B: a single inline attachment extracted from a turn's request."""
type Attachment {
  id: ID!
  turnId: ID!
  sessionId: ID!
  sequenceNum: Int!
  role: String!
  kind: String!
  mimeType: String!
  sizeBytes: Int!
  sha256: String!
  filename: String
  width: Int
  height: Int
  url: String!
}

"""A logical user turn: one user prompt + everything the agent did in response (preflight, title-gen, tool-loop iterations). Derived at query time from contiguous wire turns in a session that share the same user_request_text."""
type UserTurn {
  """Synthetic id: sessionId:groupIdx. Stable across queries for the same turn group but not persisted."""
  id: ID!
  sessionId: ID!
  """Ordinal of this user turn within the session (1-based, matches grouping order)."""
  groupIdx: Int!
  startTimestamp: DateTime!
  endTimestamp: DateTime!
  """endTimestamp - startTimestamp, in milliseconds."""
  durationMs: Int!
  userRequestText: String
  """Primary model for the group. When the group mixes haiku and a larger model, the larger model wins."""
  primaryModel: String
  provider: String!
  framework: String
  totalTokens: Int!
  inputTokens: Int!
  outputTokens: Int!
  cacheReadTokens: Int!
  cacheCreationTokens: Int!
  costUsd: Float!
  """Number of wire-level API calls collapsed into this logical turn."""
  subCallCount: Int!
  """Sum of tool_call_count across the wire turns in this group."""
  toolCallCount: Int!
  """Aggregated status: 'error' if any sub-call has http_status >= 400, 'complete' if all captured, else 'incomplete'."""
  status: String!
  """Wire-level sub-calls, ordered by sequence_num. Use for audit drill-down."""
  turns: [Turn!]!
}

type ToolCall {
  id: ID!
  name: String!
  input: String
  inputHash: String
  result: String
  resultHash: String
  durationMs: Int
  status: String
  sequenceNum: Int
}

type AnomalyEvent {
  id: ID!
  sessionId: ID
  turnId: ID
  anomalyType: String!
  severity: String!
  description: String
  detectedAt: DateTime!
  metadata: String
  turn: Turn
  session: Session
}

type IntegrityReport {
  sessionId: ID!
  totalTurns: Int!
  verifiedTurns: Int!
  failedTurns: Int!
  """
  B1: false indicates the API verified field presence but did NOT re-hash
  the actual bytes from the object store. Full re-hashing requires object
  store access which is a future capability.
  """
  verified: Boolean!
  results: [TurnIntegrityResult!]!
}

type TurnIntegrityResult {
  turnId: ID!
  sequenceNum: Int!
  reqHashMatch: Boolean!
  respHashMatch: Boolean!
  reqBytesPresent: Boolean!
  respBytesPresent: Boolean!
}

enum RealtimeLatencySource {
  turn_duration_ms
  gateway_capture_histogram
  none
}

type RealtimeStats {
  """Wire-level ops metric: count of captured API calls in the last minute. Counts every sub-call (preflight, title-gen, tool-loop iterations) and is intended for gateway load monitoring."""
  requestsPerMinute: Int!
  """Logical-turn metric: count of user turns in the last minute after grouping preflight/title-gen/tool-loops into one row per prompt. Intended for dashboard user-facing activity."""
  userTurnsPerMinute: Int!
  activeSessions: Int!
  activeProviderCount: Int!
  """W3: Float is intentional -- hourly token aggregates across many agents can exceed 2^31 (Int max). Float avoids overflow."""
  tokensLastHour: Float!
  """W3: Float is intentional -- hourly token aggregates across many agents can exceed 2^31 (Int max). Float avoids overflow."""
  cacheReadTokensLastHour: Float!
  costLastHour: Float!
  """W2: Linear extrapolation (costLastHour * 24). Not a forecast -- assumes the current hour's spend rate continues unchanged."""
  costProjectedToday: Float!
  latencyP50Ms: Int
  latencyP99Ms: Int
  latencySampleCount: Int!
  latencySource: RealtimeLatencySource!
}

"""Live Traffic feed row. Represents one logical user turn (grouped across preflight, title-gen, and tool-use loop iterations). For wire-level audit, drill into the session."""
type FeedItem {
  timestamp: DateTime!
  provider: String!
  """Primary model for the logical turn. When the group mixes haiku (title-gen/classifier) and a larger model, the larger model wins."""
  model: String
  framework: String
  intent: String
  totalTokens: Int!
  costUsd: Float!
  httpStatus: Int
  captureComplete: Boolean!
  sessionId: ID!
  """Number of wire-level API calls that collapsed into this logical turn. 1 for a simple turn; >1 when the agent looped (tool use) or ran side-channel calls (title-gen, classifier)."""
  subCallCount: Int!
  """Sum of tool_call_count across the wire turns in this group."""
  toolCallCount: Int!
  """End-to-end duration of the logical turn in milliseconds: max(timestamp) - min(timestamp) across its wire turns."""
  durationMs: Int
  """Sprint P1B: number of inline attachments across this logical turn's wire sub-calls."""
  attachmentCount: Int!
  """Synthetic id matching Session.userTurns[].id (sessionId:groupIdx). Lets the feed deep-link a row to its expanded user turn in Session Detail."""
  userTurnId: ID!
}

type GatewayStatus {
  status: String!
  """W6: Seconds since first heartbeat recorded, not continuous uptime. Gateway restarts do not reset this counter."""
  uptimeSeconds: Int
  lastHeartbeat: DateTime
}

"""D4 Finding 3: Period enum constrains valid period values for cost and audit queries."""
enum Period {
  DAY_1
  DAY_7
  DAY_30
  DAY_90
}

"""D4.5: Integrity status enum for audit entries."""
enum IntegrityStatus {
  verified
  partial
  retry
  failed
}

"""D4.5: Audit type filter enum for auditTrail query."""
enum AuditTypeFilter {
  ALL
  REQUESTS
  RESPONSES
  ANOMALIES
}

"""D4.1: Single audit trail entry derived from a turn."""
type AuditEntry {
  timestamp: DateTime!
  sessionId: ID!
  sequenceNum: Int!
  provider: String!
  model: String
  requestHash: String
  responseHash: String
  """W9: Int is safe for individual turn token counts (max ~1M per turn, well within Int32 range)."""
  totalTokens: Int!
  """Derived integrity status based on http_status, hash presence, and capture completeness."""
  integrityStatus: IntegrityStatus!
  httpStatus: Int
  captureComplete: Boolean!
}

"""D4.1: Paginated audit trail connection."""
type AuditConnection {
  items: [AuditEntry!]!
  total: Int!
  limit: Int!
  offset: Int!
}

"""D4.3: Usage summary metrics for a period."""
type UsageSummary {
  totalCostUsd: Float!
  projectedMonthlyCostUsd: Float!
  totalTokens: Float!
  cacheReadTokens: Float!
  cacheReadPercentage: Float!
  averageCostPerSession: Float!
  """N8: Absolute USD delta between current and prior period average cost per session."""
  averageCostDelta: Float!
  cacheHitRate: Float!
  cacheSavingsUsd: Float!
  costPerDeveloperPerDay: Float!
  developerCount: Int!
}

"""D4.3: Spend breakdown category (used by spendByProvider, spendByModel, spendByFramework, dailySpend)."""
type SpendByCategory {
  name: String!
  costUsd: Float!
  percentage: Float!
  count: Int!
}

"""D4.3: Monthly cost projection."""
type CostProjection {
  month: String!
  projectedSessions: Int!
  projectedTokens: Float!
  projectedCostUsd: Float!
  deltaVsCurrent: Float!
  assumptions: String!
}

"""D5.1: Agent analytics summary."""
type AgentSummary {
  activeAgents: Int!
  frameworkCount: Int!
  totalSessions: Int!
  sessionsDelta: Float!
  averageTurnsPerSession: Float!
  medianTurnsPerSession: Float!
  uniqueDevelopers: Int!
}

"""D5.1: Developer usage metrics."""
type DeveloperUsage {
  accountUuid: String!
  sessionCount: Int!
  totalTokens: Float!
  totalCostUsd: Float!
  favoriteModel: String
  lastActive: DateTime
}

"""D5.1: Paginated developer connection."""
type DeveloperConnection {
  items: [DeveloperUsage!]!
  total: Int!
  limit: Int!
  offset: Int!
}

"""D5.1: Repository usage metrics."""
type RepositoryUsage {
  repository: String!
  sessionCount: Int!
  branchCount: Int!
  totalCostUsd: Float!
  primaryFramework: String
}

"""D5.1: Paginated repository connection."""
type RepositoryConnection {
  items: [RepositoryUsage!]!
  total: Int!
  limit: Int!
  offset: Int!
}

"""D5.2: Compliance posture summary."""
type ComplianceSummary {
  overallScore: Int!
  captureIntegrity: Float!
  hashMismatches: Int!
  droppedEvents: Int!
  openFindings: Int!
  findingsBySeverity: FindingCounts!
  lastAssessment: DateTime
}

"""D5.2: Finding counts by severity level."""
type FindingCounts {
  critical: Int!
  high: Int!
  medium: Int!
  low: Int!
}

"""D5.2: Compliance framework with nested controls."""
type ComplianceFramework {
  id: ID!
  name: String!
  subtitle: String
  compliancePercentage: Int!
  controlsMet: Int!
  controlsTotal: Int!
  controls: [ComplianceControl!]!
}

"""D5.2: Individual compliance control."""
type ComplianceControl {
  id: ID!
  controlId: String!
  description: String!
  status: ControlStatus!
}

"""D5.2: Compliance control status enum."""
enum ControlStatus {
  MET
  IN_PROGRESS
  PLANNED
  NOT_MET
}

"""D5.2: Compliance audit log entry."""
type ComplianceAuditEntry {
  id: ID!
  controlId: String!
  oldStatus: String
  newStatus: String!
  changedBy: String
  changedAt: DateTime!
  reason: String
}

"""D5.2: Paginated compliance audit log connection."""
type ComplianceAuditConnection {
  items: [ComplianceAuditEntry!]!
  total: Int!
  limit: Int!
  offset: Int!
}

"""D5.2: Input for updating a compliance control status."""
input UpdateControlStatusInput {
  status: ControlStatus!
  reason: String!
}

"""D5.2: Payload returned from updateControlStatus mutation."""
type UpdateControlPayload {
  control: ComplianceControl
  errors: [MutationError!]!
}

"""D5.2: Structured mutation error."""
type MutationError {
  field: String!
  code: String!
  message: String!
}

"""D6.1: Report status enum."""
enum ReportStatus {
  DRAFT
  FINAL
}

"""D6.1: Compliance report."""
type Report {
  id: ID!
  name: String!
  framework: String!
  periodStart: DateTime!
  periodEnd: DateTime!
  captureCount: Int!
  findings: ReportFindings!
  hash: String
  status: ReportStatus!
  generatedAt: DateTime!
}

"""D6.1: Report finding counts by severity."""
type ReportFindings {
  critical: Int!
  high: Int!
  medium: Int!
  low: Int!
}

"""D6.1: Paginated report connection."""
type ReportConnection {
  items: [Report!]!
  total: Int!
  limit: Int!
  offset: Int!
}

"""D6.1: Trend data point (used by coverage and findings trends)."""
type TrendPoint {
  label: String!
  value: Float!
}

"""D6.1: Input for generating a report."""
input GenerateReportInput {
  framework: String!
  periodStart: DateTime!
  periodEnd: DateTime!
}

"""D6.1: Payload returned from generateReport mutation."""
type GenerateReportPayload {
  report: Report
  errors: [MutationError!]!
}

"""D6.2: Policy type enum."""
enum PolicyType {
  BLOCK
  LIMIT
  ALERT
  MONITOR
}

"""D6.2: Policy status enum."""
enum PolicyStatus {
  ACTIVE
  INACTIVE
}

"""D6.2: Governance policy."""
type Policy {
  id: ID!
  name: String!
  type: PolicyType!
  scope: String!
  action: String!
  triggersMtd: Int!
  status: PolicyStatus!
}

"""D6.2: Paginated policy connection."""
type PolicyConnection {
  items: [Policy!]!
  total: Int!
  limit: Int!
  offset: Int!
}

"""D6.2: Input for creating a policy."""
input CreatePolicyInput {
  name: String!
  type: PolicyType!
  scope: String!
  action: String!
}

"""D6.2: Input for updating a policy. Type is immutable after creation -- use deletePolicy + createPolicy to change type."""
input UpdatePolicyInput {
  name: String
  scope: String
  action: String
  status: PolicyStatus
}

"""D6.2: Payload returned from createPolicy/updatePolicy mutations."""
type PolicyPayload {
  policy: Policy
  errors: [MutationError!]!
}

"""D6.2/D6.3: Payload returned from delete mutations."""
type DeletePayload {
  success: Boolean!
  errors: [MutationError!]!
}

"""D6.3: Key status enum."""
enum KeyStatus {
  active
  inactive
}

"""D6.3: Registered LLM API key."""
type RegisteredKey {
  id: ID!
  name: String!
  provider: String!
  fingerprint: String!
  agentCount: Int!
  lastUsed: DateTime
  monthlyCostUsd: Float!
  status: KeyStatus!
}

"""D6.3: Paginated key connection."""
type KeyConnection {
  items: [RegisteredKey!]!
  total: Int!
  limit: Int!
  offset: Int!
}

"""D6.3: Input for registering a key."""
input RegisterKeyInput {
  name: String!
  provider: String!
  fingerprint: String!
}

"""D6.3: Payload returned from registerKey mutation."""
type RegisterKeyPayload {
  key: RegisteredKey
  errors: [MutationError!]!
}
`;
