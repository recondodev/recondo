/**
 * Shared GraphQL type definitions for the dashboard.
 *
 * Full codegen integration deferred to when dashboard codegen config is set up.
 */

export interface SessionItem {
  id: string;
  projectId: string | null;
  agentId: string | null;
  model: string | null;
  provider: string;
  startedAt: string;
  endedAt: string | null;
  lastActiveAt: string | null;
  initialIntent: string | null;
  systemPromptHash: string;
  totalTurns: number;
  turnsCaptured: number;
  droppedEvents: number;
  totalTokens: number;
  totalCostUsd: number;
  complete: boolean;
  framework: string | null;
  status: string;
  duration: number | null;
  accountUuid: string | null;
  deviceId: string | null;
  gitRepo: string | null;
  gitBranch: string | null;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface SessionConnection {
  items: SessionItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface AttachmentData {
  id: string;
  turnId: string;
  sessionId: string;
  sequenceNum: number;
  role: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  filename: string | null;
  width: number | null;
  height: number | null;
  /** Relative path to the REST proxy that streams bytes, or the original
   *  cross-origin URL for external_image_url kind. */
  url: string;
}

export interface TurnData {
  id: string;
  sessionId: string;
  sequenceNum: number;
  timestamp: string;
  turnType: string | null;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number | null;
  captureComplete: boolean;
  contentHashReq: string | null;
  contentHashResp: string | null;
  stopReason: string | null;
  model: string | null;
  provider: string | null;
  toolCallCount: number;
  userRequestText: string | null;
  responseText: string | null;
  thinkingText: string | null;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  httpStatus: number | null;
  transport: string | null;
  ttfbMs: number | null;
  durationMs: number | null;
  requestHash: string | null;
  responseHash: string | null;
  attachments?: AttachmentData[];
  attachmentCount?: number;
}

/**
 * Logical user turn — the dashboard's primary unit for the turn list.
 * Collapses contiguous wire turns that share a user_request_text
 * (title-gen + classifier preflight + tool-loop iterations) into one row.
 * `turns` holds the wire-level sub-calls for drill-down/audit.
 */
export interface UserTurnData {
  id: string;
  sessionId: string;
  groupIdx: number;
  startTimestamp: string;
  endTimestamp: string;
  durationMs: number;
  userRequestText: string | null;
  primaryModel: string | null;
  provider: string;
  framework: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  subCallCount: number;
  toolCallCount: number;
  status: string;
  turns: TurnData[];
}

export interface SessionData extends SessionItem {
  turns: TurnData[];
  /** Derived title from the haiku title-gen turn, if any. */
  title: string | null;
  /** Grouped logical turns for the primary session detail view. */
  userTurns: UserTurnData[];
}

export interface RealtimeStats {
  /** Wire-level API calls per minute — ops load metric. */
  requestsPerMinute: number;
  /** Logical user turns per minute — dashboard user-facing activity metric. */
  userTurnsPerMinute: number;
  activeSessions: number;
  activeProviderCount: number;
  tokensLastHour: number;
  cacheReadTokensLastHour: number;
  costLastHour: number;
  costProjectedToday: number;
  latencyP50Ms: number | null;
  latencyP99Ms: number | null;
  latencySampleCount: number;
  latencySource: "turn_duration_ms" | "gateway_capture_histogram" | "none";
}

export interface FeedItemData {
  timestamp: string;
  provider: string;
  model: string | null;
  framework: string | null;
  intent: string | null;
  totalTokens: number;
  costUsd: number;
  httpStatus: number | null;
  captureComplete: boolean;
  sessionId: string;
  // Phase 1 grouping: the live feed now surfaces logical user turns rather
  // than raw wire requests. subCallCount > 1 means the row collapses
  // title-gen + classifier preflight + tool-loop iterations that shared the
  // same user prompt. durationMs spans the full loop; toolCallCount is the
  // sum across sub-calls.
  subCallCount: number;
  toolCallCount: number;
  durationMs: number | null;
  attachmentCount: number;
  userTurnId: string;
}

export interface GatewayStatusData {
  status: string;
  uptimeSeconds: number | null;
  lastHeartbeat: string | null;
}

// ---------------------------------------------------------------------------
// D7.1 -- Audit Trail types
// ---------------------------------------------------------------------------

export interface AuditEntry {
  timestamp: string;
  sessionId: string;
  sequenceNum: number;
  provider: string;
  model: string | null;
  requestHash: string | null;
  responseHash: string | null;
  totalTokens: number;
  integrityStatus: "verified" | "partial" | "retry" | "failed";
  httpStatus: number | null;
  captureComplete: boolean;
}

export interface AuditConnection {
  items: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// D7.2 -- Cost & Usage types
// ---------------------------------------------------------------------------

export interface UsageSummary {
  totalCostUsd: number;
  projectedMonthlyCostUsd: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheReadPercentage: number;
  averageCostPerSession: number;
  averageCostDelta: number;
  cacheHitRate: number;
  cacheSavingsUsd: number;
  costPerDeveloperPerDay: number;
  developerCount: number;
}

export interface SpendByCategory {
  name: string;
  costUsd: number;
  percentage: number;
  count: number;
}

export interface CostProjection {
  month: string;
  projectedSessions: number;
  projectedTokens: number;
  projectedCostUsd: number;
  deltaVsCurrent: number;
  assumptions: string;
}

// ---------------------------------------------------------------------------
// D8.1 -- Compliance Dashboard types
// ---------------------------------------------------------------------------

export interface FindingsBySeverity {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface ComplianceSummary {
  overallScore: number;
  captureIntegrity: number;
  hashMismatches: number;
  droppedEvents: number;
  openFindings: number;
  findingsBySeverity: FindingsBySeverity;
  lastAssessment: string | null;
}

export interface ComplianceControl {
  id: string;
  controlId: string;
  description: string;
  status: string;
}

export interface ComplianceFramework {
  id: string;
  name: string;
  subtitle: string;
  compliancePercentage: number;
  controlsMet: number;
  controlsTotal: number;
  controls: ComplianceControl[];
}

export interface ComplianceAuditLogEntry {
  id: string;
  controlId: string;
  oldStatus: string;
  newStatus: string;
  changedBy: string;
  changedAt: string;
  reason: string;
}

export interface ComplianceAuditLogConnection {
  items: ComplianceAuditLogEntry[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// D8.2 -- Audit Reports types
// ---------------------------------------------------------------------------

export interface ReportItem {
  id: string;
  name: string;
  framework: string;
  periodStart: string;
  periodEnd: string;
  captureCount: number;
  findings: FindingsBySeverity;
  hash: string | null;
  status: string;
  generatedAt: string;
}

export interface ReportConnection {
  items: ReportItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface TrendDataPoint {
  label: string;
  value: number;
}

// ---------------------------------------------------------------------------
// D8.3 -- Agent Analytics types
// ---------------------------------------------------------------------------

export interface AgentSummary {
  activeAgents: number;
  frameworkCount: number;
  totalSessions: number;
  sessionsDelta: number;
  averageTurnsPerSession: number;
  medianTurnsPerSession: number;
  uniqueDevelopers: number;
}

export interface TopDeveloper {
  accountUuid: string;
  sessionCount: number;
  totalTokens: number;
  totalCostUsd: number;
  favoriteModel: string | null;
  lastActive: string | null;
}

export interface TopDevelopersConnection {
  items: TopDeveloper[];
  total: number;
  limit: number;
  offset: number;
}

export interface TopRepository {
  repository: string;
  sessionCount: number;
  branchCount: number;
  totalCostUsd: number;
  primaryFramework: string | null;
}

export interface TopRepositoriesConnection {
  items: TopRepository[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// D9.1 -- Policies types
// ---------------------------------------------------------------------------

export interface PolicyItem {
  id: string;
  name: string;
  type: string;
  scope: string;
  action: string;
  triggersMtd: number;
  status: "ACTIVE" | "INACTIVE";
}

export interface PolicyConnection {
  items: PolicyItem[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// D9.2 -- API Keys types
// ---------------------------------------------------------------------------

export interface RegisteredKeyItem {
  id: string;
  name: string;
  provider: string;
  fingerprint: string;
  agentCount: number;
  lastUsed: string | null;
  monthlyCostUsd: number;
  status: "active" | "inactive";
}

export interface KeyConnection {
  items: RegisteredKeyItem[];
  total: number;
  limit: number;
  offset: number;
}
