import { GraphQLResolveInfo, GraphQLScalarType, GraphQLScalarTypeConfig } from 'graphql';
import { MappedSession, MappedTurn, MappedToolCall, MappedAnomaly, MappedUserTurn, MappedAttachment } from '../resolvers/mappers.js';
import { GqlContext } from '../context.js';
export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;
export type RequireFields<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  DateTime: { input: any; output: any; }
};

/** D5.1: Agent analytics summary. */
export type AgentSummary = {
  __typename?: 'AgentSummary';
  activeAgents: Scalars['Int']['output'];
  averageTurnsPerSession: Scalars['Float']['output'];
  frameworkCount: Scalars['Int']['output'];
  medianTurnsPerSession: Scalars['Float']['output'];
  sessionsDelta: Scalars['Float']['output'];
  totalSessions: Scalars['Int']['output'];
  uniqueDevelopers: Scalars['Int']['output'];
};

export type AnomalyEvent = {
  __typename?: 'AnomalyEvent';
  anomalyType: Scalars['String']['output'];
  description?: Maybe<Scalars['String']['output']>;
  detectedAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  metadata?: Maybe<Scalars['String']['output']>;
  session?: Maybe<Session>;
  sessionId?: Maybe<Scalars['ID']['output']>;
  severity: Scalars['String']['output'];
  turn?: Maybe<Turn>;
  turnId?: Maybe<Scalars['ID']['output']>;
};

export type AnomalyFilter = {
  anomalyType?: InputMaybe<Scalars['String']['input']>;
  sessionId?: InputMaybe<Scalars['ID']['input']>;
  severity?: InputMaybe<Scalars['String']['input']>;
  since?: InputMaybe<Scalars['DateTime']['input']>;
};

/** Sprint P1B: a single inline attachment (image / PDF / document) extracted from a turn's request. Content-addressed by sha256 so duplicate uploads share a single object in the store. */
export type Attachment = {
  __typename?: 'Attachment';
  filename?: Maybe<Scalars['String']['output']>;
  height?: Maybe<Scalars['Int']['output']>;
  id: Scalars['ID']['output'];
  /** Coarse kind the dashboard dispatches on. 'image' | 'pdf' | 'document' | 'external_image_url' | 'other'. */
  kind: Scalars['String']['output'];
  mimeType: Scalars['String']['output'];
  /** 'user' when the user sent the attachment; 'assistant' when it flowed back via a tool_result (image outputs from tools). */
  role: Scalars['String']['output'];
  /** 1-based ordinal within the turn's request. Matches the '[Image #N]' placeholder in user_request_text. */
  sequenceNum: Scalars['Int']['output'];
  sessionId: Scalars['ID']['output'];
  sha256: Scalars['String']['output'];
  sizeBytes: Scalars['Int']['output'];
  turnId: Scalars['ID']['output'];
  /** URL the dashboard uses to fetch the binary. Points at an API-internal proxy route when the attachment is inline; for external_image_url kind it points at the original URL. */
  url: Scalars['String']['output'];
  width?: Maybe<Scalars['Int']['output']>;
};

/** D4.1: Paginated audit trail connection. */
export type AuditConnection = {
  __typename?: 'AuditConnection';
  items: Array<AuditEntry>;
  limit: Scalars['Int']['output'];
  offset: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
};

/** D4.1: Single audit trail entry derived from a turn. */
export type AuditEntry = {
  __typename?: 'AuditEntry';
  captureComplete: Scalars['Boolean']['output'];
  httpStatus?: Maybe<Scalars['Int']['output']>;
  /** Derived integrity status based on http_status, hash presence, and capture completeness. */
  integrityStatus: IntegrityStatus;
  model?: Maybe<Scalars['String']['output']>;
  provider: Scalars['String']['output'];
  requestHash?: Maybe<Scalars['String']['output']>;
  responseHash?: Maybe<Scalars['String']['output']>;
  sequenceNum: Scalars['Int']['output'];
  sessionId: Scalars['ID']['output'];
  timestamp: Scalars['DateTime']['output'];
  /** W9: Int is safe for individual turn token counts (max ~1M per turn, well within Int32 range). */
  totalTokens: Scalars['Int']['output'];
};

/** D4.5: Audit type filter enum for auditTrail query. */
export enum AuditTypeFilter {
  All = 'ALL',
  Anomalies = 'ANOMALIES',
  Requests = 'REQUESTS',
  Responses = 'RESPONSES'
}

/** D5.2: Paginated compliance audit log connection. */
export type ComplianceAuditConnection = {
  __typename?: 'ComplianceAuditConnection';
  items: Array<ComplianceAuditEntry>;
  limit: Scalars['Int']['output'];
  offset: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
};

/** D5.2: Compliance audit log entry. */
export type ComplianceAuditEntry = {
  __typename?: 'ComplianceAuditEntry';
  changedAt: Scalars['DateTime']['output'];
  changedBy?: Maybe<Scalars['String']['output']>;
  controlId: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  newStatus: Scalars['String']['output'];
  oldStatus?: Maybe<Scalars['String']['output']>;
  reason?: Maybe<Scalars['String']['output']>;
};

/** D5.2: Individual compliance control. */
export type ComplianceControl = {
  __typename?: 'ComplianceControl';
  controlId: Scalars['String']['output'];
  description: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  status: ControlStatus;
};

/** D5.2: Compliance framework with nested controls. */
export type ComplianceFramework = {
  __typename?: 'ComplianceFramework';
  compliancePercentage: Scalars['Int']['output'];
  controls: Array<ComplianceControl>;
  controlsMet: Scalars['Int']['output'];
  controlsTotal: Scalars['Int']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  subtitle?: Maybe<Scalars['String']['output']>;
};

/** D5.2: Compliance posture summary. */
export type ComplianceSummary = {
  __typename?: 'ComplianceSummary';
  captureIntegrity: Scalars['Float']['output'];
  droppedEvents: Scalars['Int']['output'];
  findingsBySeverity: FindingCounts;
  hashMismatches: Scalars['Int']['output'];
  lastAssessment?: Maybe<Scalars['DateTime']['output']>;
  openFindings: Scalars['Int']['output'];
  overallScore: Scalars['Int']['output'];
};

/** D5.2: Compliance control status enum. */
export enum ControlStatus {
  InProgress = 'IN_PROGRESS',
  Met = 'MET',
  NotMet = 'NOT_MET',
  Planned = 'PLANNED'
}

/** D4.3: Monthly cost projection. */
export type CostProjection = {
  __typename?: 'CostProjection';
  assumptions: Scalars['String']['output'];
  deltaVsCurrent: Scalars['Float']['output'];
  month: Scalars['String']['output'];
  projectedCostUsd: Scalars['Float']['output'];
  projectedSessions: Scalars['Int']['output'];
  projectedTokens: Scalars['Float']['output'];
};

/** D6.2: Input for creating a policy. */
export type CreatePolicyInput = {
  action: Scalars['String']['input'];
  name: Scalars['String']['input'];
  scope: Scalars['String']['input'];
  type: PolicyType;
};

/** D6.2/D6.3: Payload returned from delete mutations. */
export type DeletePayload = {
  __typename?: 'DeletePayload';
  errors: Array<MutationError>;
  success: Scalars['Boolean']['output'];
};

/** D5.1: Paginated developer connection. */
export type DeveloperConnection = {
  __typename?: 'DeveloperConnection';
  items: Array<DeveloperUsage>;
  limit: Scalars['Int']['output'];
  offset: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
};

/** D5.1: Developer usage metrics. */
export type DeveloperUsage = {
  __typename?: 'DeveloperUsage';
  accountUuid: Scalars['String']['output'];
  favoriteModel?: Maybe<Scalars['String']['output']>;
  lastActive?: Maybe<Scalars['DateTime']['output']>;
  sessionCount: Scalars['Int']['output'];
  totalCostUsd: Scalars['Float']['output'];
  totalTokens: Scalars['Float']['output'];
};

/** Live Traffic feed row. Represents one logical user turn (grouped across preflight, title-gen, and tool-use loop iterations). For wire-level audit, drill into the session. */
export type FeedItem = {
  __typename?: 'FeedItem';
  /** Sprint P1B: number of inline attachments across this logical turn's wire sub-calls. Drives the paperclip badge in the feed. */
  attachmentCount: Scalars['Int']['output'];
  captureComplete: Scalars['Boolean']['output'];
  costUsd: Scalars['Float']['output'];
  /** End-to-end duration of the logical turn in milliseconds: max(timestamp) - min(timestamp) across its wire turns. */
  durationMs?: Maybe<Scalars['Int']['output']>;
  framework?: Maybe<Scalars['String']['output']>;
  httpStatus?: Maybe<Scalars['Int']['output']>;
  intent?: Maybe<Scalars['String']['output']>;
  /** Primary model for the logical turn. When the group mixes haiku (title-gen/classifier) and a larger model, the larger model wins. */
  model?: Maybe<Scalars['String']['output']>;
  provider: Scalars['String']['output'];
  sessionId: Scalars['ID']['output'];
  /** Number of wire-level API calls that collapsed into this logical turn. 1 for a simple turn; >1 when the agent looped (tool use) or ran side-channel calls (title-gen, classifier). */
  subCallCount: Scalars['Int']['output'];
  timestamp: Scalars['DateTime']['output'];
  /** Sum of tool_call_count across the wire turns in this group. */
  toolCallCount: Scalars['Int']['output'];
  totalTokens: Scalars['Int']['output'];
  /** Synthetic id matching Session.userTurns[].id (`sessionId:groupIdx`). Lets the feed deep-link a row to its expanded user turn in Session Detail. */
  userTurnId: Scalars['ID']['output'];
};

/** D5.2: Finding counts by severity level. */
export type FindingCounts = {
  __typename?: 'FindingCounts';
  critical: Scalars['Int']['output'];
  high: Scalars['Int']['output'];
  low: Scalars['Int']['output'];
  medium: Scalars['Int']['output'];
};

export type GatewayStatus = {
  __typename?: 'GatewayStatus';
  lastHeartbeat?: Maybe<Scalars['DateTime']['output']>;
  status: Scalars['String']['output'];
  /** W6: Seconds since first heartbeat recorded, not continuous uptime. Gateway restarts do not reset this counter. */
  uptimeSeconds?: Maybe<Scalars['Int']['output']>;
};

/** D6.1: Input for generating a report. */
export type GenerateReportInput = {
  framework: Scalars['String']['input'];
  periodEnd: Scalars['DateTime']['input'];
  periodStart: Scalars['DateTime']['input'];
};

/** D6.1: Payload returned from generateReport mutation. */
export type GenerateReportPayload = {
  __typename?: 'GenerateReportPayload';
  errors: Array<MutationError>;
  report?: Maybe<Report>;
};

export type IntegrityReport = {
  __typename?: 'IntegrityReport';
  failedTurns: Scalars['Int']['output'];
  results: Array<TurnIntegrityResult>;
  sessionId: Scalars['ID']['output'];
  totalTurns: Scalars['Int']['output'];
  /**
   * B1: false indicates the API verified field presence but did NOT re-hash
   * the actual bytes from the object store. Full re-hashing requires object
   * store access which is a future capability.
   */
  verified: Scalars['Boolean']['output'];
  verifiedTurns: Scalars['Int']['output'];
};

/** D4.5: Integrity status enum for audit entries. */
export enum IntegrityStatus {
  Failed = 'failed',
  Partial = 'partial',
  Retry = 'retry',
  Verified = 'verified'
}

/** D6.3: Paginated key connection. */
export type KeyConnection = {
  __typename?: 'KeyConnection';
  items: Array<RegisteredKey>;
  limit: Scalars['Int']['output'];
  offset: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
};

/** D6.3: Key status enum. */
export enum KeyStatus {
  Active = 'active',
  Inactive = 'inactive'
}

export type Mutation = {
  __typename?: 'Mutation';
  /** D6.2: Create a new governance policy. */
  createPolicy: PolicyPayload;
  /** D6.3: Delete a registered key. */
  deleteKey: DeletePayload;
  /** D6.2: Delete a governance policy. */
  deletePolicy: DeletePayload;
  /** D6.1: Generate a compliance report for a framework and period. */
  generateReport: GenerateReportPayload;
  /** D6.3: Register an LLM API key. */
  registerKey: RegisterKeyPayload;
  /** D5.2: Update a compliance control status. */
  updateControlStatus: UpdateControlPayload;
  /** D6.2: Update an existing governance policy. */
  updatePolicy: PolicyPayload;
};


export type MutationCreatePolicyArgs = {
  input: CreatePolicyInput;
};


export type MutationDeleteKeyArgs = {
  id: Scalars['ID']['input'];
};


export type MutationDeletePolicyArgs = {
  id: Scalars['ID']['input'];
};


export type MutationGenerateReportArgs = {
  input: GenerateReportInput;
};


export type MutationRegisterKeyArgs = {
  input: RegisterKeyInput;
};


export type MutationUpdateControlStatusArgs = {
  controlId: Scalars['ID']['input'];
  input: UpdateControlStatusInput;
};


export type MutationUpdatePolicyArgs = {
  id: Scalars['ID']['input'];
  input: UpdatePolicyInput;
};

/** D5.2: Structured mutation error. */
export type MutationError = {
  __typename?: 'MutationError';
  code: Scalars['String']['output'];
  field: Scalars['String']['output'];
  message: Scalars['String']['output'];
};

/** D4 Finding 3: Period enum constrains valid period values for cost and audit queries. */
export enum Period {
  Day_1 = 'DAY_1',
  Day_7 = 'DAY_7',
  Day_30 = 'DAY_30',
  Day_90 = 'DAY_90'
}

/** D6.2: Governance policy. */
export type Policy = {
  __typename?: 'Policy';
  action: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  scope: Scalars['String']['output'];
  status: PolicyStatus;
  triggersMtd: Scalars['Int']['output'];
  type: PolicyType;
};

/** D6.2: Paginated policy connection. */
export type PolicyConnection = {
  __typename?: 'PolicyConnection';
  items: Array<Policy>;
  limit: Scalars['Int']['output'];
  offset: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
};

/** D6.2: Payload returned from createPolicy/updatePolicy mutations. */
export type PolicyPayload = {
  __typename?: 'PolicyPayload';
  errors: Array<MutationError>;
  policy?: Maybe<Policy>;
};

/** D6.2: Policy status enum. */
export enum PolicyStatus {
  Active = 'ACTIVE',
  Inactive = 'INACTIVE'
}

/** D6.2: Policy type enum. */
export enum PolicyType {
  Alert = 'ALERT',
  Block = 'BLOCK',
  Limit = 'LIMIT',
  Monitor = 'MONITOR'
}

export type Query = {
  __typename?: 'Query';
  /** D5.1: Framework distribution for agent sessions in a given period. */
  agentFrameworkDistribution: Array<SpendByCategory>;
  /** D5.1: Agent analytics summary for a given period. */
  agentSummary: AgentSummary;
  anomalies: Array<AnomalyEvent>;
  /** D4.1: Audit trail query with search, type filter, date range, and pagination. */
  auditTrail: AuditConnection;
  /** D5.2: Paginated compliance audit log. */
  complianceAuditLog: ComplianceAuditConnection;
  /** D5.2: All compliance frameworks with nested controls. */
  complianceFrameworks: Array<ComplianceFramework>;
  /** D5.2: Compliance posture summary. */
  complianceSummary: ComplianceSummary;
  /** D4.3: 3-month cost projection based on linear extrapolation. */
  costProjections: Array<CostProjection>;
  /** D4.3: Daily spend totals for the last N days. Uses 'days' parameter for simplicity. For custom date ranges, use spendByProvider/Model/Framework with from/to. */
  dailySpend: Array<SpendByCategory>;
  gatewayStatus: GatewayStatus;
  /** D6.2: Paginated policies list. */
  policies: PolicyConnection;
  /** D6.2: Policy trigger history as daily counts. */
  policyTriggerHistory: Array<TrendPoint>;
  realtimeFeed: Array<FeedItem>;
  realtimeStats: RealtimeStats;
  /** D6.3: Paginated registered keys list. */
  registeredKeys: KeyConnection;
  /** D6.1: Coverage trend data points. */
  reportCoverageTrend: Array<TrendPoint>;
  /** D6.1: Findings trend data points. */
  reportFindingsTrend: Array<TrendPoint>;
  /** D6.1: Paginated reports list. */
  reports: ReportConnection;
  search: Array<Turn>;
  session?: Maybe<Session>;
  sessions: SessionConnection;
  /** D4.3: Spend breakdown by agent framework. */
  spendByFramework: Array<SpendByCategory>;
  /** D4.3: Spend breakdown by model. */
  spendByModel: Array<SpendByCategory>;
  /** D4.3: Spend breakdown by LLM provider. */
  spendByProvider: Array<SpendByCategory>;
  /** D5.1: Top developers by cost, paginated. Accepts period only. For custom date ranges, use agentSummary which supports from/to. */
  topDevelopers: DeveloperConnection;
  /** D5.1: Top repositories by session count, paginated. Accepts period only. For custom date ranges, use agentSummary which supports from/to. */
  topRepositories: RepositoryConnection;
  turn?: Maybe<Turn>;
  /** D4.3: Usage summary for a given period or date range. */
  usageSummary: UsageSummary;
  verifyIntegrity: IntegrityReport;
};


export type QueryAgentFrameworkDistributionArgs = {
  from?: InputMaybe<Scalars['DateTime']['input']>;
  period?: InputMaybe<Period>;
  to?: InputMaybe<Scalars['DateTime']['input']>;
};


export type QueryAgentSummaryArgs = {
  from?: InputMaybe<Scalars['DateTime']['input']>;
  period?: InputMaybe<Period>;
  to?: InputMaybe<Scalars['DateTime']['input']>;
};


export type QueryAnomaliesArgs = {
  filter?: InputMaybe<AnomalyFilter>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryAuditTrailArgs = {
  from?: InputMaybe<Scalars['DateTime']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  period?: InputMaybe<Period>;
  search?: InputMaybe<Scalars['String']['input']>;
  to?: InputMaybe<Scalars['DateTime']['input']>;
  type?: InputMaybe<AuditTypeFilter>;
};


export type QueryComplianceAuditLogArgs = {
  controlId?: InputMaybe<Scalars['ID']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryDailySpendArgs = {
  days?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryPoliciesArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryPolicyTriggerHistoryArgs = {
  days?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryRealtimeFeedArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  provider?: InputMaybe<Scalars['String']['input']>;
  since?: InputMaybe<Scalars['DateTime']['input']>;
};


export type QueryRegisteredKeysArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryReportsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
};


export type QuerySearchArgs = {
  projectId?: InputMaybe<Scalars['ID']['input']>;
  query: Scalars['String']['input'];
};


export type QuerySessionArgs = {
  id: Scalars['ID']['input'];
};


export type QuerySessionsArgs = {
  filter?: InputMaybe<SessionFilter>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
};


export type QuerySpendByFrameworkArgs = {
  from?: InputMaybe<Scalars['DateTime']['input']>;
  period?: InputMaybe<Period>;
  to?: InputMaybe<Scalars['DateTime']['input']>;
};


export type QuerySpendByModelArgs = {
  from?: InputMaybe<Scalars['DateTime']['input']>;
  period?: InputMaybe<Period>;
  to?: InputMaybe<Scalars['DateTime']['input']>;
};


export type QuerySpendByProviderArgs = {
  from?: InputMaybe<Scalars['DateTime']['input']>;
  period?: InputMaybe<Period>;
  to?: InputMaybe<Scalars['DateTime']['input']>;
};


export type QueryTopDevelopersArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  period?: InputMaybe<Period>;
};


export type QueryTopRepositoriesArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  period?: InputMaybe<Period>;
};


export type QueryTurnArgs = {
  id: Scalars['ID']['input'];
};


export type QueryUsageSummaryArgs = {
  from?: InputMaybe<Scalars['DateTime']['input']>;
  period?: InputMaybe<Period>;
  to?: InputMaybe<Scalars['DateTime']['input']>;
};


export type QueryVerifyIntegrityArgs = {
  sessionId: Scalars['ID']['input'];
};

export enum RealtimeLatencySource {
  GatewayCaptureHistogram = 'gateway_capture_histogram',
  None = 'none',
  TurnDurationMs = 'turn_duration_ms'
}

export type RealtimeStats = {
  __typename?: 'RealtimeStats';
  activeProviderCount: Scalars['Int']['output'];
  activeSessions: Scalars['Int']['output'];
  /** W3: Float is intentional -- hourly token aggregates across many agents can exceed 2^31 (Int max). Float avoids overflow. */
  cacheReadTokensLastHour: Scalars['Float']['output'];
  costLastHour: Scalars['Float']['output'];
  /** W2: Linear extrapolation (costLastHour * 24). Not a forecast -- assumes the current hour's spend rate continues unchanged. */
  costProjectedToday: Scalars['Float']['output'];
  latencyP50Ms?: Maybe<Scalars['Int']['output']>;
  latencyP99Ms?: Maybe<Scalars['Int']['output']>;
  latencySampleCount: Scalars['Int']['output'];
  latencySource: RealtimeLatencySource;
  /** Wire-level ops metric: count of captured API calls in the last minute. Counts every sub-call (preflight, title-gen, tool-loop iterations) and is intended for gateway load monitoring. */
  requestsPerMinute: Scalars['Int']['output'];
  /** W3: Float is intentional -- hourly token aggregates across many agents can exceed 2^31 (Int max). Float avoids overflow. */
  tokensLastHour: Scalars['Float']['output'];
  /** Logical-turn metric: count of user turns in the last minute after grouping preflight/title-gen/tool-loops into one row per prompt. Intended for dashboard user-facing activity. */
  userTurnsPerMinute: Scalars['Int']['output'];
};

/** D6.3: Input for registering a key. */
export type RegisterKeyInput = {
  fingerprint: Scalars['String']['input'];
  name: Scalars['String']['input'];
  provider: Scalars['String']['input'];
};

/** D6.3: Payload returned from registerKey mutation. */
export type RegisterKeyPayload = {
  __typename?: 'RegisterKeyPayload';
  errors: Array<MutationError>;
  key?: Maybe<RegisteredKey>;
};

/** D6.3: Registered LLM API key. */
export type RegisteredKey = {
  __typename?: 'RegisteredKey';
  agentCount: Scalars['Int']['output'];
  fingerprint: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  lastUsed?: Maybe<Scalars['DateTime']['output']>;
  monthlyCostUsd: Scalars['Float']['output'];
  name: Scalars['String']['output'];
  provider: Scalars['String']['output'];
  status: KeyStatus;
};

/** D6.1: Compliance report. */
export type Report = {
  __typename?: 'Report';
  captureCount: Scalars['Int']['output'];
  findings: ReportFindings;
  framework: Scalars['String']['output'];
  generatedAt: Scalars['DateTime']['output'];
  hash?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  periodEnd: Scalars['DateTime']['output'];
  periodStart: Scalars['DateTime']['output'];
  status: ReportStatus;
};

/** D6.1: Paginated report connection. */
export type ReportConnection = {
  __typename?: 'ReportConnection';
  items: Array<Report>;
  limit: Scalars['Int']['output'];
  offset: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
};

/** D6.1: Report finding counts by severity. */
export type ReportFindings = {
  __typename?: 'ReportFindings';
  critical: Scalars['Int']['output'];
  high: Scalars['Int']['output'];
  low: Scalars['Int']['output'];
  medium: Scalars['Int']['output'];
};

/** D6.1: Report status enum. */
export enum ReportStatus {
  Draft = 'DRAFT',
  Final = 'FINAL'
}

/** D5.1: Paginated repository connection. */
export type RepositoryConnection = {
  __typename?: 'RepositoryConnection';
  items: Array<RepositoryUsage>;
  limit: Scalars['Int']['output'];
  offset: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
};

/** D5.1: Repository usage metrics. */
export type RepositoryUsage = {
  __typename?: 'RepositoryUsage';
  branchCount: Scalars['Int']['output'];
  primaryFramework?: Maybe<Scalars['String']['output']>;
  repository: Scalars['String']['output'];
  sessionCount: Scalars['Int']['output'];
  totalCostUsd: Scalars['Float']['output'];
};

export type Session = {
  __typename?: 'Session';
  accountUuid?: Maybe<Scalars['String']['output']>;
  agentId?: Maybe<Scalars['String']['output']>;
  cacheCreationTokens: Scalars['Int']['output'];
  cacheReadTokens: Scalars['Int']['output'];
  complete: Scalars['Boolean']['output'];
  deviceId?: Maybe<Scalars['String']['output']>;
  droppedEvents: Scalars['Int']['output'];
  duration?: Maybe<Scalars['Int']['output']>;
  endedAt?: Maybe<Scalars['DateTime']['output']>;
  framework?: Maybe<Scalars['String']['output']>;
  gitBranch?: Maybe<Scalars['String']['output']>;
  gitRepo?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  initialIntent?: Maybe<Scalars['String']['output']>;
  lastActiveAt?: Maybe<Scalars['DateTime']['output']>;
  /** W14: model and provider should always be populated by the gateway */
  model?: Maybe<Scalars['String']['output']>;
  projectId?: Maybe<Scalars['ID']['output']>;
  provider: Scalars['String']['output'];
  startedAt: Scalars['DateTime']['output'];
  status: Scalars['String']['output'];
  systemPromptHash: Scalars['String']['output'];
  /** Derived title from the first haiku title-generation turn's JSON response ({"title": "..."}) when present. Null when Claude Code / framework did not generate a title. */
  title?: Maybe<Scalars['String']['output']>;
  totalCostUsd: Scalars['Float']['output'];
  totalTokens: Scalars['Int']['output'];
  totalTurns: Scalars['Int']['output'];
  turns: Array<Turn>;
  turnsCaptured: Scalars['Int']['output'];
  /** Grouped logical turns. Each UserTurn collapses contiguous same-user_request_text wire turns (preflight + title-gen + tool-loop iterations) into a single row. Use for primary UI; use turns for wire-level audit. */
  userTurns: Array<UserTurn>;
};

export type SessionConnection = {
  __typename?: 'SessionConnection';
  items: Array<Session>;
  limit: Scalars['Int']['output'];
  offset: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
};

export type SessionFilter = {
  framework?: InputMaybe<Scalars['String']['input']>;
  /**
   * Exclude sessions that look like non-LLM traffic captured by the TLS MITM
   * (telemetry pings, OAuth refreshes, update checks). Default true. Pass
   * false explicitly to include them (e.g., for governance/discovery views).
   * A session is considered non-LLM when its framework, model, and total
   * token count all indicate no LLM API call was successfully observed.
   */
  hideNonLlm?: InputMaybe<Scalars['Boolean']['input']>;
  model?: InputMaybe<Scalars['String']['input']>;
  projectId?: InputMaybe<Scalars['ID']['input']>;
  provider?: InputMaybe<Scalars['String']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  startedAfter?: InputMaybe<Scalars['DateTime']['input']>;
  startedBefore?: InputMaybe<Scalars['DateTime']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
};

/** D4.3: Spend breakdown category (used by spendByProvider, spendByModel, spendByFramework, dailySpend). */
export type SpendByCategory = {
  __typename?: 'SpendByCategory';
  costUsd: Scalars['Float']['output'];
  count: Scalars['Int']['output'];
  name: Scalars['String']['output'];
  percentage: Scalars['Float']['output'];
};

export type ToolCall = {
  __typename?: 'ToolCall';
  durationMs?: Maybe<Scalars['Int']['output']>;
  id: Scalars['ID']['output'];
  input?: Maybe<Scalars['String']['output']>;
  inputHash?: Maybe<Scalars['String']['output']>;
  name: Scalars['String']['output'];
  result?: Maybe<Scalars['String']['output']>;
  resultHash?: Maybe<Scalars['String']['output']>;
  sequenceNum?: Maybe<Scalars['Int']['output']>;
  status?: Maybe<Scalars['String']['output']>;
};

/** D6.1: Trend data point (used by coverage and findings trends). */
export type TrendPoint = {
  __typename?: 'TrendPoint';
  label: Scalars['String']['output'];
  value: Scalars['Float']['output'];
};

export type Turn = {
  __typename?: 'Turn';
  anomalies: Array<AnomalyEvent>;
  /** Sprint P1B: count of attachments on this turn. Denormalized on the turn row; use to show a badge without fetching the full attachment list. */
  attachmentCount: Scalars['Int']['output'];
  /** Sprint P1B: inline attachments (images / PDFs / documents) the user or agent sent with this turn. Resolved via the attachments DB table; the URL points at a signed-or-proxied fetch endpoint — not a stable identifier for long-term sharing. */
  attachments: Array<Attachment>;
  cacheCreationTokens: Scalars['Int']['output'];
  cacheReadTokens: Scalars['Int']['output'];
  captureComplete: Scalars['Boolean']['output'];
  contentHashReq?: Maybe<Scalars['String']['output']>;
  contentHashResp?: Maybe<Scalars['String']['output']>;
  costUsd: Scalars['Float']['output'];
  durationMs?: Maybe<Scalars['Int']['output']>;
  httpStatus?: Maybe<Scalars['Int']['output']>;
  id: Scalars['ID']['output'];
  inputTokens: Scalars['Int']['output'];
  latencyMs?: Maybe<Scalars['Int']['output']>;
  model?: Maybe<Scalars['String']['output']>;
  outputTokens: Scalars['Int']['output'];
  provider?: Maybe<Scalars['String']['output']>;
  requestHash?: Maybe<Scalars['String']['output']>;
  responseHash?: Maybe<Scalars['String']['output']>;
  responseText?: Maybe<Scalars['String']['output']>;
  sequenceNum: Scalars['Int']['output'];
  sessionId: Scalars['ID']['output'];
  stopReason?: Maybe<Scalars['String']['output']>;
  thinkingText?: Maybe<Scalars['String']['output']>;
  thinkingTokens: Scalars['Int']['output'];
  timestamp: Scalars['DateTime']['output'];
  toolCallCount: Scalars['Int']['output'];
  toolCalls: Array<ToolCall>;
  totalTokens: Scalars['Int']['output'];
  transport?: Maybe<Scalars['String']['output']>;
  ttfbMs?: Maybe<Scalars['Int']['output']>;
  turnType?: Maybe<Scalars['String']['output']>;
  userRequestText?: Maybe<Scalars['String']['output']>;
};

export type TurnIntegrityResult = {
  __typename?: 'TurnIntegrityResult';
  reqBytesPresent: Scalars['Boolean']['output'];
  reqHashMatch: Scalars['Boolean']['output'];
  respBytesPresent: Scalars['Boolean']['output'];
  respHashMatch: Scalars['Boolean']['output'];
  sequenceNum: Scalars['Int']['output'];
  turnId: Scalars['ID']['output'];
};

/** D5.2: Payload returned from updateControlStatus mutation. */
export type UpdateControlPayload = {
  __typename?: 'UpdateControlPayload';
  control?: Maybe<ComplianceControl>;
  errors: Array<MutationError>;
};

/** D5.2: Input for updating a compliance control status. */
export type UpdateControlStatusInput = {
  reason: Scalars['String']['input'];
  status: ControlStatus;
};

/** D6.2: Input for updating a policy. Type is immutable after creation -- use deletePolicy + createPolicy to change type. */
export type UpdatePolicyInput = {
  action?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  scope?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<PolicyStatus>;
};

/** D4.3: Usage summary metrics for a period. */
export type UsageSummary = {
  __typename?: 'UsageSummary';
  /** N8: Absolute USD delta between current and prior period average cost per session. */
  averageCostDelta: Scalars['Float']['output'];
  averageCostPerSession: Scalars['Float']['output'];
  cacheHitRate: Scalars['Float']['output'];
  cacheReadPercentage: Scalars['Float']['output'];
  cacheReadTokens: Scalars['Float']['output'];
  cacheSavingsUsd: Scalars['Float']['output'];
  costPerDeveloperPerDay: Scalars['Float']['output'];
  developerCount: Scalars['Int']['output'];
  projectedMonthlyCostUsd: Scalars['Float']['output'];
  totalCostUsd: Scalars['Float']['output'];
  totalTokens: Scalars['Float']['output'];
};

/** A logical user turn: one user prompt + everything the agent did in response (preflight, title-gen, tool-loop iterations). Derived at query time from contiguous wire turns in a session that share the same user_request_text. */
export type UserTurn = {
  __typename?: 'UserTurn';
  cacheCreationTokens: Scalars['Int']['output'];
  cacheReadTokens: Scalars['Int']['output'];
  costUsd: Scalars['Float']['output'];
  /** endTimestamp - startTimestamp, in milliseconds. */
  durationMs: Scalars['Int']['output'];
  endTimestamp: Scalars['DateTime']['output'];
  framework?: Maybe<Scalars['String']['output']>;
  /** Ordinal of this user turn within the session (1-based, matches grouping order). */
  groupIdx: Scalars['Int']['output'];
  /** Synthetic id: sessionId:groupIdx. Stable across queries for the same turn group but not persisted. */
  id: Scalars['ID']['output'];
  inputTokens: Scalars['Int']['output'];
  outputTokens: Scalars['Int']['output'];
  /** Primary model for the group. When the group mixes haiku and a larger model, the larger model wins. */
  primaryModel?: Maybe<Scalars['String']['output']>;
  provider: Scalars['String']['output'];
  sessionId: Scalars['ID']['output'];
  startTimestamp: Scalars['DateTime']['output'];
  /** Aggregated status: 'error' if any sub-call has http_status >= 400, 'complete' if all captured, else 'incomplete'. */
  status: Scalars['String']['output'];
  /** Number of wire-level API calls collapsed into this logical turn. */
  subCallCount: Scalars['Int']['output'];
  /** Sum of tool_call_count across the wire turns in this group. */
  toolCallCount: Scalars['Int']['output'];
  totalTokens: Scalars['Int']['output'];
  /** Wire-level sub-calls, ordered by sequence_num. Use for audit drill-down. */
  turns: Array<Turn>;
  userRequestText?: Maybe<Scalars['String']['output']>;
};

export type WithIndex<TObject> = TObject & Record<string, any>;
export type ResolversObject<TObject> = WithIndex<TObject>;

export type ResolverTypeWrapper<T> = Promise<T> | T;


export type ResolverWithResolve<TResult, TParent, TContext, TArgs> = {
  resolve: ResolverFn<TResult, TParent, TContext, TArgs>;
};
export type Resolver<TResult, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> = ResolverFn<TResult, TParent, TContext, TArgs> | ResolverWithResolve<TResult, TParent, TContext, TArgs>;

export type ResolverFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => Promise<TResult> | TResult;

export type SubscriptionSubscribeFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => AsyncIterable<TResult> | Promise<AsyncIterable<TResult>>;

export type SubscriptionResolveFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;

export interface SubscriptionSubscriberObject<TResult, TKey extends string, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<{ [key in TKey]: TResult }, TParent, TContext, TArgs>;
  resolve?: SubscriptionResolveFn<TResult, { [key in TKey]: TResult }, TContext, TArgs>;
}

export interface SubscriptionResolverObject<TResult, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<any, TParent, TContext, TArgs>;
  resolve: SubscriptionResolveFn<TResult, any, TContext, TArgs>;
}

export type SubscriptionObject<TResult, TKey extends string, TParent, TContext, TArgs> =
  | SubscriptionSubscriberObject<TResult, TKey, TParent, TContext, TArgs>
  | SubscriptionResolverObject<TResult, TParent, TContext, TArgs>;

export type SubscriptionResolver<TResult, TKey extends string, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> =
  | ((...args: any[]) => SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>)
  | SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>;

export type TypeResolveFn<TTypes, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>> = (
  parent: TParent,
  context: TContext,
  info: GraphQLResolveInfo
) => Maybe<TTypes> | Promise<Maybe<TTypes>>;

export type IsTypeOfResolverFn<T = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>> = (obj: T, context: TContext, info: GraphQLResolveInfo) => boolean | Promise<boolean>;

export type NextResolverFn<T> = () => Promise<T>;

export type DirectiveResolverFn<TResult = Record<PropertyKey, never>, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> = (
  next: NextResolverFn<TResult>,
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;





/** Mapping between all available schema types and the resolvers types */
export type ResolversTypes = ResolversObject<{
  AgentSummary: ResolverTypeWrapper<AgentSummary>;
  AnomalyEvent: ResolverTypeWrapper<MappedAnomaly>;
  AnomalyFilter: AnomalyFilter;
  Attachment: ResolverTypeWrapper<MappedAttachment>;
  AuditConnection: ResolverTypeWrapper<AuditConnection>;
  AuditEntry: ResolverTypeWrapper<AuditEntry>;
  AuditTypeFilter: AuditTypeFilter;
  Boolean: ResolverTypeWrapper<Scalars['Boolean']['output']>;
  ComplianceAuditConnection: ResolverTypeWrapper<ComplianceAuditConnection>;
  ComplianceAuditEntry: ResolverTypeWrapper<ComplianceAuditEntry>;
  ComplianceControl: ResolverTypeWrapper<ComplianceControl>;
  ComplianceFramework: ResolverTypeWrapper<ComplianceFramework>;
  ComplianceSummary: ResolverTypeWrapper<ComplianceSummary>;
  ControlStatus: ControlStatus;
  CostProjection: ResolverTypeWrapper<CostProjection>;
  CreatePolicyInput: CreatePolicyInput;
  DateTime: ResolverTypeWrapper<Scalars['DateTime']['output']>;
  DeletePayload: ResolverTypeWrapper<DeletePayload>;
  DeveloperConnection: ResolverTypeWrapper<DeveloperConnection>;
  DeveloperUsage: ResolverTypeWrapper<DeveloperUsage>;
  FeedItem: ResolverTypeWrapper<FeedItem>;
  FindingCounts: ResolverTypeWrapper<FindingCounts>;
  Float: ResolverTypeWrapper<Scalars['Float']['output']>;
  GatewayStatus: ResolverTypeWrapper<GatewayStatus>;
  GenerateReportInput: GenerateReportInput;
  GenerateReportPayload: ResolverTypeWrapper<GenerateReportPayload>;
  ID: ResolverTypeWrapper<Scalars['ID']['output']>;
  Int: ResolverTypeWrapper<Scalars['Int']['output']>;
  IntegrityReport: ResolverTypeWrapper<IntegrityReport>;
  IntegrityStatus: IntegrityStatus;
  KeyConnection: ResolverTypeWrapper<KeyConnection>;
  KeyStatus: KeyStatus;
  Mutation: ResolverTypeWrapper<Record<PropertyKey, never>>;
  MutationError: ResolverTypeWrapper<MutationError>;
  Period: Period;
  Policy: ResolverTypeWrapper<Policy>;
  PolicyConnection: ResolverTypeWrapper<PolicyConnection>;
  PolicyPayload: ResolverTypeWrapper<PolicyPayload>;
  PolicyStatus: PolicyStatus;
  PolicyType: PolicyType;
  Query: ResolverTypeWrapper<Record<PropertyKey, never>>;
  RealtimeLatencySource: RealtimeLatencySource;
  RealtimeStats: ResolverTypeWrapper<RealtimeStats>;
  RegisterKeyInput: RegisterKeyInput;
  RegisterKeyPayload: ResolverTypeWrapper<RegisterKeyPayload>;
  RegisteredKey: ResolverTypeWrapper<RegisteredKey>;
  Report: ResolverTypeWrapper<Report>;
  ReportConnection: ResolverTypeWrapper<ReportConnection>;
  ReportFindings: ResolverTypeWrapper<ReportFindings>;
  ReportStatus: ReportStatus;
  RepositoryConnection: ResolverTypeWrapper<RepositoryConnection>;
  RepositoryUsage: ResolverTypeWrapper<RepositoryUsage>;
  Session: ResolverTypeWrapper<MappedSession>;
  SessionConnection: ResolverTypeWrapper<Omit<SessionConnection, 'items'> & { items: Array<ResolversTypes['Session']> }>;
  SessionFilter: SessionFilter;
  SpendByCategory: ResolverTypeWrapper<SpendByCategory>;
  String: ResolverTypeWrapper<Scalars['String']['output']>;
  ToolCall: ResolverTypeWrapper<MappedToolCall>;
  TrendPoint: ResolverTypeWrapper<TrendPoint>;
  Turn: ResolverTypeWrapper<MappedTurn>;
  TurnIntegrityResult: ResolverTypeWrapper<TurnIntegrityResult>;
  UpdateControlPayload: ResolverTypeWrapper<UpdateControlPayload>;
  UpdateControlStatusInput: UpdateControlStatusInput;
  UpdatePolicyInput: UpdatePolicyInput;
  UsageSummary: ResolverTypeWrapper<UsageSummary>;
  UserTurn: ResolverTypeWrapper<MappedUserTurn>;
}>;

/** Mapping between all available schema types and the resolvers parents */
export type ResolversParentTypes = ResolversObject<{
  AgentSummary: AgentSummary;
  AnomalyEvent: MappedAnomaly;
  AnomalyFilter: AnomalyFilter;
  Attachment: MappedAttachment;
  AuditConnection: AuditConnection;
  AuditEntry: AuditEntry;
  Boolean: Scalars['Boolean']['output'];
  ComplianceAuditConnection: ComplianceAuditConnection;
  ComplianceAuditEntry: ComplianceAuditEntry;
  ComplianceControl: ComplianceControl;
  ComplianceFramework: ComplianceFramework;
  ComplianceSummary: ComplianceSummary;
  CostProjection: CostProjection;
  CreatePolicyInput: CreatePolicyInput;
  DateTime: Scalars['DateTime']['output'];
  DeletePayload: DeletePayload;
  DeveloperConnection: DeveloperConnection;
  DeveloperUsage: DeveloperUsage;
  FeedItem: FeedItem;
  FindingCounts: FindingCounts;
  Float: Scalars['Float']['output'];
  GatewayStatus: GatewayStatus;
  GenerateReportInput: GenerateReportInput;
  GenerateReportPayload: GenerateReportPayload;
  ID: Scalars['ID']['output'];
  Int: Scalars['Int']['output'];
  IntegrityReport: IntegrityReport;
  KeyConnection: KeyConnection;
  Mutation: Record<PropertyKey, never>;
  MutationError: MutationError;
  Policy: Policy;
  PolicyConnection: PolicyConnection;
  PolicyPayload: PolicyPayload;
  Query: Record<PropertyKey, never>;
  RealtimeStats: RealtimeStats;
  RegisterKeyInput: RegisterKeyInput;
  RegisterKeyPayload: RegisterKeyPayload;
  RegisteredKey: RegisteredKey;
  Report: Report;
  ReportConnection: ReportConnection;
  ReportFindings: ReportFindings;
  RepositoryConnection: RepositoryConnection;
  RepositoryUsage: RepositoryUsage;
  Session: MappedSession;
  SessionConnection: Omit<SessionConnection, 'items'> & { items: Array<ResolversParentTypes['Session']> };
  SessionFilter: SessionFilter;
  SpendByCategory: SpendByCategory;
  String: Scalars['String']['output'];
  ToolCall: MappedToolCall;
  TrendPoint: TrendPoint;
  Turn: MappedTurn;
  TurnIntegrityResult: TurnIntegrityResult;
  UpdateControlPayload: UpdateControlPayload;
  UpdateControlStatusInput: UpdateControlStatusInput;
  UpdatePolicyInput: UpdatePolicyInput;
  UsageSummary: UsageSummary;
  UserTurn: MappedUserTurn;
}>;

export type AgentSummaryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AgentSummary'] = ResolversParentTypes['AgentSummary']> = ResolversObject<{
  activeAgents?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  averageTurnsPerSession?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  frameworkCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  medianTurnsPerSession?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  sessionsDelta?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  totalSessions?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  uniqueDevelopers?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type AnomalyEventResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AnomalyEvent'] = ResolversParentTypes['AnomalyEvent']> = ResolversObject<{
  anomalyType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  detectedAt?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  metadata?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  session?: Resolver<Maybe<ResolversTypes['Session']>, ParentType, ContextType>;
  sessionId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  severity?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  turn?: Resolver<Maybe<ResolversTypes['Turn']>, ParentType, ContextType>;
  turnId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
}>;

export type AttachmentResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Attachment'] = ResolversParentTypes['Attachment']> = ResolversObject<{
  filename?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  height?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  kind?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  mimeType?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  role?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  sequenceNum?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sessionId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  sha256?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  sizeBytes?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  turnId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  url?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  width?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type AuditConnectionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AuditConnection'] = ResolversParentTypes['AuditConnection']> = ResolversObject<{
  items?: Resolver<Array<ResolversTypes['AuditEntry']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  offset?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type AuditEntryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['AuditEntry'] = ResolversParentTypes['AuditEntry']> = ResolversObject<{
  captureComplete?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  httpStatus?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  integrityStatus?: Resolver<ResolversTypes['IntegrityStatus'], ParentType, ContextType>;
  model?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  provider?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  requestHash?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  responseHash?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sequenceNum?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sessionId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  timestamp?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  totalTokens?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ComplianceAuditConnectionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ComplianceAuditConnection'] = ResolversParentTypes['ComplianceAuditConnection']> = ResolversObject<{
  items?: Resolver<Array<ResolversTypes['ComplianceAuditEntry']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  offset?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ComplianceAuditEntryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ComplianceAuditEntry'] = ResolversParentTypes['ComplianceAuditEntry']> = ResolversObject<{
  changedAt?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  changedBy?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  controlId?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  newStatus?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  oldStatus?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  reason?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ComplianceControlResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ComplianceControl'] = ResolversParentTypes['ComplianceControl']> = ResolversObject<{
  controlId?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  description?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  status?: Resolver<ResolversTypes['ControlStatus'], ParentType, ContextType>;
}>;

export type ComplianceFrameworkResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ComplianceFramework'] = ResolversParentTypes['ComplianceFramework']> = ResolversObject<{
  compliancePercentage?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  controls?: Resolver<Array<ResolversTypes['ComplianceControl']>, ParentType, ContextType>;
  controlsMet?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  controlsTotal?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  subtitle?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type ComplianceSummaryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ComplianceSummary'] = ResolversParentTypes['ComplianceSummary']> = ResolversObject<{
  captureIntegrity?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  droppedEvents?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  findingsBySeverity?: Resolver<ResolversTypes['FindingCounts'], ParentType, ContextType>;
  hashMismatches?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  lastAssessment?: Resolver<Maybe<ResolversTypes['DateTime']>, ParentType, ContextType>;
  openFindings?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  overallScore?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type CostProjectionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['CostProjection'] = ResolversParentTypes['CostProjection']> = ResolversObject<{
  assumptions?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  deltaVsCurrent?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  month?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  projectedCostUsd?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  projectedSessions?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  projectedTokens?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export interface DateTimeScalarConfig extends GraphQLScalarTypeConfig<ResolversTypes['DateTime'], any> {
  name: 'DateTime';
}

export type DeletePayloadResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['DeletePayload'] = ResolversParentTypes['DeletePayload']> = ResolversObject<{
  errors?: Resolver<Array<ResolversTypes['MutationError']>, ParentType, ContextType>;
  success?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
}>;

export type DeveloperConnectionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['DeveloperConnection'] = ResolversParentTypes['DeveloperConnection']> = ResolversObject<{
  items?: Resolver<Array<ResolversTypes['DeveloperUsage']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  offset?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type DeveloperUsageResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['DeveloperUsage'] = ResolversParentTypes['DeveloperUsage']> = ResolversObject<{
  accountUuid?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  favoriteModel?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  lastActive?: Resolver<Maybe<ResolversTypes['DateTime']>, ParentType, ContextType>;
  sessionCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  totalCostUsd?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  totalTokens?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type FeedItemResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['FeedItem'] = ResolversParentTypes['FeedItem']> = ResolversObject<{
  attachmentCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  captureComplete?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  costUsd?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  durationMs?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  framework?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  httpStatus?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  intent?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  model?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  provider?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  sessionId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  subCallCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  timestamp?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  toolCallCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  totalTokens?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  userTurnId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
}>;

export type FindingCountsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['FindingCounts'] = ResolversParentTypes['FindingCounts']> = ResolversObject<{
  critical?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  high?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  low?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  medium?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type GatewayStatusResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['GatewayStatus'] = ResolversParentTypes['GatewayStatus']> = ResolversObject<{
  lastHeartbeat?: Resolver<Maybe<ResolversTypes['DateTime']>, ParentType, ContextType>;
  status?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  uptimeSeconds?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
}>;

export type GenerateReportPayloadResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['GenerateReportPayload'] = ResolversParentTypes['GenerateReportPayload']> = ResolversObject<{
  errors?: Resolver<Array<ResolversTypes['MutationError']>, ParentType, ContextType>;
  report?: Resolver<Maybe<ResolversTypes['Report']>, ParentType, ContextType>;
}>;

export type IntegrityReportResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['IntegrityReport'] = ResolversParentTypes['IntegrityReport']> = ResolversObject<{
  failedTurns?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  results?: Resolver<Array<ResolversTypes['TurnIntegrityResult']>, ParentType, ContextType>;
  sessionId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  totalTurns?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  verified?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  verifiedTurns?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type KeyConnectionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['KeyConnection'] = ResolversParentTypes['KeyConnection']> = ResolversObject<{
  items?: Resolver<Array<ResolversTypes['RegisteredKey']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  offset?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type MutationResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Mutation'] = ResolversParentTypes['Mutation']> = ResolversObject<{
  createPolicy?: Resolver<ResolversTypes['PolicyPayload'], ParentType, ContextType, RequireFields<MutationCreatePolicyArgs, 'input'>>;
  deleteKey?: Resolver<ResolversTypes['DeletePayload'], ParentType, ContextType, RequireFields<MutationDeleteKeyArgs, 'id'>>;
  deletePolicy?: Resolver<ResolversTypes['DeletePayload'], ParentType, ContextType, RequireFields<MutationDeletePolicyArgs, 'id'>>;
  generateReport?: Resolver<ResolversTypes['GenerateReportPayload'], ParentType, ContextType, RequireFields<MutationGenerateReportArgs, 'input'>>;
  registerKey?: Resolver<ResolversTypes['RegisterKeyPayload'], ParentType, ContextType, RequireFields<MutationRegisterKeyArgs, 'input'>>;
  updateControlStatus?: Resolver<ResolversTypes['UpdateControlPayload'], ParentType, ContextType, RequireFields<MutationUpdateControlStatusArgs, 'controlId' | 'input'>>;
  updatePolicy?: Resolver<ResolversTypes['PolicyPayload'], ParentType, ContextType, RequireFields<MutationUpdatePolicyArgs, 'id' | 'input'>>;
}>;

export type MutationErrorResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['MutationError'] = ResolversParentTypes['MutationError']> = ResolversObject<{
  code?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  field?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  message?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
}>;

export type PolicyResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Policy'] = ResolversParentTypes['Policy']> = ResolversObject<{
  action?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  scope?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  status?: Resolver<ResolversTypes['PolicyStatus'], ParentType, ContextType>;
  triggersMtd?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  type?: Resolver<ResolversTypes['PolicyType'], ParentType, ContextType>;
}>;

export type PolicyConnectionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['PolicyConnection'] = ResolversParentTypes['PolicyConnection']> = ResolversObject<{
  items?: Resolver<Array<ResolversTypes['Policy']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  offset?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type PolicyPayloadResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['PolicyPayload'] = ResolversParentTypes['PolicyPayload']> = ResolversObject<{
  errors?: Resolver<Array<ResolversTypes['MutationError']>, ParentType, ContextType>;
  policy?: Resolver<Maybe<ResolversTypes['Policy']>, ParentType, ContextType>;
}>;

export type QueryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Query'] = ResolversParentTypes['Query']> = ResolversObject<{
  agentFrameworkDistribution?: Resolver<Array<ResolversTypes['SpendByCategory']>, ParentType, ContextType, Partial<QueryAgentFrameworkDistributionArgs>>;
  agentSummary?: Resolver<ResolversTypes['AgentSummary'], ParentType, ContextType, Partial<QueryAgentSummaryArgs>>;
  anomalies?: Resolver<Array<ResolversTypes['AnomalyEvent']>, ParentType, ContextType, Partial<QueryAnomaliesArgs>>;
  auditTrail?: Resolver<ResolversTypes['AuditConnection'], ParentType, ContextType, Partial<QueryAuditTrailArgs>>;
  complianceAuditLog?: Resolver<ResolversTypes['ComplianceAuditConnection'], ParentType, ContextType, Partial<QueryComplianceAuditLogArgs>>;
  complianceFrameworks?: Resolver<Array<ResolversTypes['ComplianceFramework']>, ParentType, ContextType>;
  complianceSummary?: Resolver<ResolversTypes['ComplianceSummary'], ParentType, ContextType>;
  costProjections?: Resolver<Array<ResolversTypes['CostProjection']>, ParentType, ContextType>;
  dailySpend?: Resolver<Array<ResolversTypes['SpendByCategory']>, ParentType, ContextType, Partial<QueryDailySpendArgs>>;
  gatewayStatus?: Resolver<ResolversTypes['GatewayStatus'], ParentType, ContextType>;
  policies?: Resolver<ResolversTypes['PolicyConnection'], ParentType, ContextType, Partial<QueryPoliciesArgs>>;
  policyTriggerHistory?: Resolver<Array<ResolversTypes['TrendPoint']>, ParentType, ContextType, Partial<QueryPolicyTriggerHistoryArgs>>;
  realtimeFeed?: Resolver<Array<ResolversTypes['FeedItem']>, ParentType, ContextType, Partial<QueryRealtimeFeedArgs>>;
  realtimeStats?: Resolver<ResolversTypes['RealtimeStats'], ParentType, ContextType>;
  registeredKeys?: Resolver<ResolversTypes['KeyConnection'], ParentType, ContextType, Partial<QueryRegisteredKeysArgs>>;
  reportCoverageTrend?: Resolver<Array<ResolversTypes['TrendPoint']>, ParentType, ContextType>;
  reportFindingsTrend?: Resolver<Array<ResolversTypes['TrendPoint']>, ParentType, ContextType>;
  reports?: Resolver<ResolversTypes['ReportConnection'], ParentType, ContextType, Partial<QueryReportsArgs>>;
  search?: Resolver<Array<ResolversTypes['Turn']>, ParentType, ContextType, RequireFields<QuerySearchArgs, 'query'>>;
  session?: Resolver<Maybe<ResolversTypes['Session']>, ParentType, ContextType, RequireFields<QuerySessionArgs, 'id'>>;
  sessions?: Resolver<ResolversTypes['SessionConnection'], ParentType, ContextType, Partial<QuerySessionsArgs>>;
  spendByFramework?: Resolver<Array<ResolversTypes['SpendByCategory']>, ParentType, ContextType, Partial<QuerySpendByFrameworkArgs>>;
  spendByModel?: Resolver<Array<ResolversTypes['SpendByCategory']>, ParentType, ContextType, Partial<QuerySpendByModelArgs>>;
  spendByProvider?: Resolver<Array<ResolversTypes['SpendByCategory']>, ParentType, ContextType, Partial<QuerySpendByProviderArgs>>;
  topDevelopers?: Resolver<ResolversTypes['DeveloperConnection'], ParentType, ContextType, Partial<QueryTopDevelopersArgs>>;
  topRepositories?: Resolver<ResolversTypes['RepositoryConnection'], ParentType, ContextType, Partial<QueryTopRepositoriesArgs>>;
  turn?: Resolver<Maybe<ResolversTypes['Turn']>, ParentType, ContextType, RequireFields<QueryTurnArgs, 'id'>>;
  usageSummary?: Resolver<ResolversTypes['UsageSummary'], ParentType, ContextType, Partial<QueryUsageSummaryArgs>>;
  verifyIntegrity?: Resolver<ResolversTypes['IntegrityReport'], ParentType, ContextType, RequireFields<QueryVerifyIntegrityArgs, 'sessionId'>>;
}>;

export type RealtimeStatsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['RealtimeStats'] = ResolversParentTypes['RealtimeStats']> = ResolversObject<{
  activeProviderCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  activeSessions?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  cacheReadTokensLastHour?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  costLastHour?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  costProjectedToday?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  latencyP50Ms?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  latencyP99Ms?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  latencySampleCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  latencySource?: Resolver<ResolversTypes['RealtimeLatencySource'], ParentType, ContextType>;
  requestsPerMinute?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  tokensLastHour?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  userTurnsPerMinute?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type RegisterKeyPayloadResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['RegisterKeyPayload'] = ResolversParentTypes['RegisterKeyPayload']> = ResolversObject<{
  errors?: Resolver<Array<ResolversTypes['MutationError']>, ParentType, ContextType>;
  key?: Resolver<Maybe<ResolversTypes['RegisteredKey']>, ParentType, ContextType>;
}>;

export type RegisteredKeyResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['RegisteredKey'] = ResolversParentTypes['RegisteredKey']> = ResolversObject<{
  agentCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  fingerprint?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  lastUsed?: Resolver<Maybe<ResolversTypes['DateTime']>, ParentType, ContextType>;
  monthlyCostUsd?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  provider?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  status?: Resolver<ResolversTypes['KeyStatus'], ParentType, ContextType>;
}>;

export type ReportResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Report'] = ResolversParentTypes['Report']> = ResolversObject<{
  captureCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  findings?: Resolver<ResolversTypes['ReportFindings'], ParentType, ContextType>;
  framework?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  generatedAt?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  hash?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  periodEnd?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  periodStart?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  status?: Resolver<ResolversTypes['ReportStatus'], ParentType, ContextType>;
}>;

export type ReportConnectionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ReportConnection'] = ResolversParentTypes['ReportConnection']> = ResolversObject<{
  items?: Resolver<Array<ResolversTypes['Report']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  offset?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type ReportFindingsResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ReportFindings'] = ResolversParentTypes['ReportFindings']> = ResolversObject<{
  critical?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  high?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  low?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  medium?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type RepositoryConnectionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['RepositoryConnection'] = ResolversParentTypes['RepositoryConnection']> = ResolversObject<{
  items?: Resolver<Array<ResolversTypes['RepositoryUsage']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  offset?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type RepositoryUsageResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['RepositoryUsage'] = ResolversParentTypes['RepositoryUsage']> = ResolversObject<{
  branchCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  primaryFramework?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  repository?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  sessionCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  totalCostUsd?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type SessionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Session'] = ResolversParentTypes['Session']> = ResolversObject<{
  accountUuid?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  agentId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  cacheCreationTokens?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  cacheReadTokens?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  complete?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  deviceId?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  droppedEvents?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  duration?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  endedAt?: Resolver<Maybe<ResolversTypes['DateTime']>, ParentType, ContextType>;
  framework?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  gitBranch?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  gitRepo?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  initialIntent?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  lastActiveAt?: Resolver<Maybe<ResolversTypes['DateTime']>, ParentType, ContextType>;
  model?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  projectId?: Resolver<Maybe<ResolversTypes['ID']>, ParentType, ContextType>;
  provider?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  startedAt?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  status?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  systemPromptHash?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  title?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  totalCostUsd?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  totalTokens?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  totalTurns?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  turns?: Resolver<Array<ResolversTypes['Turn']>, ParentType, ContextType>;
  turnsCaptured?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  userTurns?: Resolver<Array<ResolversTypes['UserTurn']>, ParentType, ContextType>;
}>;

export type SessionConnectionResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SessionConnection'] = ResolversParentTypes['SessionConnection']> = ResolversObject<{
  items?: Resolver<Array<ResolversTypes['Session']>, ParentType, ContextType>;
  limit?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  offset?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
}>;

export type SpendByCategoryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['SpendByCategory'] = ResolversParentTypes['SpendByCategory']> = ResolversObject<{
  costUsd?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  count?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  percentage?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type ToolCallResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['ToolCall'] = ResolversParentTypes['ToolCall']> = ResolversObject<{
  durationMs?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  input?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  inputHash?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  result?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  resultHash?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sequenceNum?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  status?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type TrendPointResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['TrendPoint'] = ResolversParentTypes['TrendPoint']> = ResolversObject<{
  label?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  value?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type TurnResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['Turn'] = ResolversParentTypes['Turn']> = ResolversObject<{
  anomalies?: Resolver<Array<ResolversTypes['AnomalyEvent']>, ParentType, ContextType>;
  attachmentCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  attachments?: Resolver<Array<ResolversTypes['Attachment']>, ParentType, ContextType>;
  cacheCreationTokens?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  cacheReadTokens?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  captureComplete?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  contentHashReq?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  contentHashResp?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  costUsd?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  durationMs?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  httpStatus?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  inputTokens?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  latencyMs?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  model?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  outputTokens?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  provider?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  requestHash?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  responseHash?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  responseText?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  sequenceNum?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  sessionId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  stopReason?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  thinkingText?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  thinkingTokens?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  timestamp?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  toolCallCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  toolCalls?: Resolver<Array<ResolversTypes['ToolCall']>, ParentType, ContextType>;
  totalTokens?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  transport?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  ttfbMs?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  turnType?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  userRequestText?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type TurnIntegrityResultResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['TurnIntegrityResult'] = ResolversParentTypes['TurnIntegrityResult']> = ResolversObject<{
  reqBytesPresent?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  reqHashMatch?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  respBytesPresent?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  respHashMatch?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  sequenceNum?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  turnId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
}>;

export type UpdateControlPayloadResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['UpdateControlPayload'] = ResolversParentTypes['UpdateControlPayload']> = ResolversObject<{
  control?: Resolver<Maybe<ResolversTypes['ComplianceControl']>, ParentType, ContextType>;
  errors?: Resolver<Array<ResolversTypes['MutationError']>, ParentType, ContextType>;
}>;

export type UsageSummaryResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['UsageSummary'] = ResolversParentTypes['UsageSummary']> = ResolversObject<{
  averageCostDelta?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  averageCostPerSession?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  cacheHitRate?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  cacheReadPercentage?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  cacheReadTokens?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  cacheSavingsUsd?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  costPerDeveloperPerDay?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  developerCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  projectedMonthlyCostUsd?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  totalCostUsd?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  totalTokens?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
}>;

export type UserTurnResolvers<ContextType = GqlContext, ParentType extends ResolversParentTypes['UserTurn'] = ResolversParentTypes['UserTurn']> = ResolversObject<{
  cacheCreationTokens?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  cacheReadTokens?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  costUsd?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  durationMs?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  endTimestamp?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  framework?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  groupIdx?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  inputTokens?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  outputTokens?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  primaryModel?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  provider?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  sessionId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  startTimestamp?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  status?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  subCallCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  toolCallCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  totalTokens?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  turns?: Resolver<Array<ResolversTypes['Turn']>, ParentType, ContextType>;
  userRequestText?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
}>;

export type Resolvers<ContextType = GqlContext> = ResolversObject<{
  AgentSummary?: AgentSummaryResolvers<ContextType>;
  AnomalyEvent?: AnomalyEventResolvers<ContextType>;
  Attachment?: AttachmentResolvers<ContextType>;
  AuditConnection?: AuditConnectionResolvers<ContextType>;
  AuditEntry?: AuditEntryResolvers<ContextType>;
  ComplianceAuditConnection?: ComplianceAuditConnectionResolvers<ContextType>;
  ComplianceAuditEntry?: ComplianceAuditEntryResolvers<ContextType>;
  ComplianceControl?: ComplianceControlResolvers<ContextType>;
  ComplianceFramework?: ComplianceFrameworkResolvers<ContextType>;
  ComplianceSummary?: ComplianceSummaryResolvers<ContextType>;
  CostProjection?: CostProjectionResolvers<ContextType>;
  DateTime?: GraphQLScalarType;
  DeletePayload?: DeletePayloadResolvers<ContextType>;
  DeveloperConnection?: DeveloperConnectionResolvers<ContextType>;
  DeveloperUsage?: DeveloperUsageResolvers<ContextType>;
  FeedItem?: FeedItemResolvers<ContextType>;
  FindingCounts?: FindingCountsResolvers<ContextType>;
  GatewayStatus?: GatewayStatusResolvers<ContextType>;
  GenerateReportPayload?: GenerateReportPayloadResolvers<ContextType>;
  IntegrityReport?: IntegrityReportResolvers<ContextType>;
  KeyConnection?: KeyConnectionResolvers<ContextType>;
  Mutation?: MutationResolvers<ContextType>;
  MutationError?: MutationErrorResolvers<ContextType>;
  Policy?: PolicyResolvers<ContextType>;
  PolicyConnection?: PolicyConnectionResolvers<ContextType>;
  PolicyPayload?: PolicyPayloadResolvers<ContextType>;
  Query?: QueryResolvers<ContextType>;
  RealtimeStats?: RealtimeStatsResolvers<ContextType>;
  RegisterKeyPayload?: RegisterKeyPayloadResolvers<ContextType>;
  RegisteredKey?: RegisteredKeyResolvers<ContextType>;
  Report?: ReportResolvers<ContextType>;
  ReportConnection?: ReportConnectionResolvers<ContextType>;
  ReportFindings?: ReportFindingsResolvers<ContextType>;
  RepositoryConnection?: RepositoryConnectionResolvers<ContextType>;
  RepositoryUsage?: RepositoryUsageResolvers<ContextType>;
  Session?: SessionResolvers<ContextType>;
  SessionConnection?: SessionConnectionResolvers<ContextType>;
  SpendByCategory?: SpendByCategoryResolvers<ContextType>;
  ToolCall?: ToolCallResolvers<ContextType>;
  TrendPoint?: TrendPointResolvers<ContextType>;
  Turn?: TurnResolvers<ContextType>;
  TurnIntegrityResult?: TurnIntegrityResultResolvers<ContextType>;
  UpdateControlPayload?: UpdateControlPayloadResolvers<ContextType>;
  UsageSummary?: UsageSummaryResolvers<ContextType>;
  UserTurn?: UserTurnResolvers<ContextType>;
}>;

