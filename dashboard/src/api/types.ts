/**
 * TypeScript interfaces matching the Sprint 9A API response shapes.
 * These are the API contract — the source of truth for what the backend returns.
 */

// ============================================================
// GET /v1/dashboards/monitoring
// ============================================================

export interface ToolDistributionEntry {
  tool: string;
  count: number;
  percentage: number;
}

export interface TokenTrendEntry {
  period: string;
  inputTokens: number;
  outputTokens: number;
}

export interface MonitoringDashboard {
  activeSessions: number;
  turnsCaptured: {
    total: number;
    last24h: number;
    last7d: number;
  };
  driftEvents: {
    systemPrompt: number;
    toolDefinition: number;
  };
  toolDistribution: ToolDistributionEntry[];
  tokenTrends: TokenTrendEntry[];
  anomalyRate: {
    last30d: number;
    resolved: number;
    unresolved: number;
  };
}

// ============================================================
// GET /v1/dashboards/management-review
// ============================================================

export interface FrameworkChecklistItem {
  clause: string;
  status: string; // "met" | "not_met" | "partial"
  evidence: string;
}

export interface ManagementReview {
  governanceCoverage: {
    totalSessions: number;
    totalDecisions: number;
    totalArtifacts: number;
  };
  compliancePosture: {
    soc2Completeness: number;
    iso42001EvidenceFreshness: number;
  };
  anomalySummary: {
    total: number;
    bySeverity: {
      warning: number;
      critical: number;
    };
    resolutionRate: number;
  };
  riskProfile: {
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
  frameworkChecklist: FrameworkChecklistItem[];
}

// ============================================================
// POST /v1/risk/classify
// ============================================================

export interface RiskClassification {
  riskLevel: string; // "low" | "medium" | "high" | "critical"
  intent: string;
  sessionId: string | null;
}

// ============================================================
// GET /v1/risk/profile
// ============================================================

export interface RiskProfile {
  low: number;
  medium: number;
  high: number;
  critical: number;
}

// ============================================================
// POST /v1/reports/impact-assessment
// ============================================================

export interface AnomalyHistoryEntry {
  type: string;
  severity: string;
  count: number;
  resolved: number;
  unresolved: number;
}

export interface ImpactAssessment {
  agentId: string;
  decisionVolume: {
    totalSessions: number;
    totalTurns: number;
    totalTokens: number;
    dateRange: {
      from: string | null;
      to: string | null;
    };
  };
  artifactsProduced: {
    totalFiles: number;
    uniqueFiles: number;
  };
  anomalyHistory: AnomalyHistoryEntry[];
  riskDistribution: {
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
}

// ============================================================
// GET /v1/usage/cost-by-team
// ============================================================

export interface CostByTeamEntry {
  agentId: string;
  sessionCount: number;
  turnCount: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface CostByTeamResponse {
  breakdown: CostByTeamEntry[];
}

// ============================================================
// GET /v1/usage/developer-productivity
// ============================================================

export interface DeveloperProductivityEntry {
  agentId: string;
  sessionCount: number;
  turnCount: number;
  totalTokens: number;
  totalCostUsd: number;
  avgDurationMs: number;
}

export interface DeveloperProductivityResponse {
  developers: DeveloperProductivityEntry[];
}

// ============================================================
// GET /v1/usage/model-analysis
// ============================================================

export interface ModelAnalysisEntry {
  model: string;
  provider: string;
  turnCount: number;
  totalTokens: number;
  totalCostUsd: number;
  avgLatencyMs: number;
}

export interface ModelAnalysisResponse {
  models: ModelAnalysisEntry[];
}

// ============================================================
// GET /v1/usage/tool-analytics
// ============================================================

export interface ToolAnalyticsEntry {
  toolName: string;
  count: number;
  successRate: number;
  avgDurationMs: number;
}

export interface ToolAnalyticsResponse {
  tools: ToolAnalyticsEntry[];
}

// ============================================================
// GET /v1/usage/token-spend
// ============================================================

export interface TokenSpendDatapoint {
  periodStart: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface TokenSpendResponse {
  datapoints: TokenSpendDatapoint[];
  truncated: boolean;
}

// ============================================================
// GET /v1/usage/model-distribution
// ============================================================

export interface ModelDistributionEntry {
  model: string;
  provider: string;
  totalCostUsd: number;
  totalTokens: number;
  turnCount: number;
  percentage: number;
}

export interface ModelDistributionResponse {
  models: ModelDistributionEntry[];
  truncated: boolean;
}

// ============================================================
// GET /v1/usage/active-agents
// ============================================================

export interface ActiveAgentEntry {
  agentId: string;
  sessionCount: number;
  totalCostUsd: number;
}

export interface ActiveAgentsResponse {
  agents: ActiveAgentEntry[];
  totalAgents: number;
  totalSessions: number;
  truncated: boolean;
}

// ============================================================
// GET /v1/usage/cost-trend
// ============================================================

export interface CostTrendModel {
  model: string;
  costUsd: number;
}

export interface CostTrendDatapoint {
  periodStart: string;
  totalCostUsd: number;
  models: CostTrendModel[];
}

export interface CostTrendResponse {
  datapoints: CostTrendDatapoint[];
  truncated: boolean;
}

// ============================================================
// POST /v1/exports/soc2
// ============================================================

export interface Soc2SessionCompleteness {
  sessionId: string;
  turnsCaptured: number;
  totalTurns: number;
  droppedEvents: number;
  completenessPercentage: number;
}

export interface Soc2Export {
  completeness: {
    sessions: Soc2SessionCompleteness[];
    truncated: boolean;
  };
  integrity: {
    verifiedCount: number;
    failedCount: number;
  };
  accessLog: {
    totalQueries: number;
    uniqueUsers: number;
    queryTypeBreakdown: Record<string, number>;
  };
  availability: {
    heartbeatCount: number;
    gapCount: number;
    availabilityPercentage: number;
  };
  processingIntegrity: {
    statement: string;
    verifiedCount: number;
    failedCount: number;
  };
  metadata: {
    generatedAt: string;
    startDate: string;
    endDate: string;
    projectId: string;
    generatorVersion: string;
  };
}

// ============================================================
// POST /v1/exports/iso42001
// ============================================================

export interface Iso42001ModelEntry {
  model: string;
  provider: string;
}

export interface Iso42001Export {
  standard: string;
  aiManagementSystem: {
    totalSessions: number;
    totalTurns: number;
    totalTokens: number;
    totalCostUsd: number;
    anomalyCount: number;
    modelInventory: Iso42001ModelEntry[];
  };
  metadata: {
    generatedAt: string;
    projectId: string;
    startDate: string | null;
    endDate: string | null;
  };
}

// ============================================================
// API error shape
// ============================================================

export interface ApiError {
  error: string;
}

// ============================================================
// Engineer trace types (GraphQL session/turn queries)
// ============================================================

export interface SessionSummary {
  id: string;
  agentId: string;
  model: string;
  provider: string;
  startedAt: string;
  lastActiveAt: string;
  totalTurns: number;
  totalTokens: number;
  totalCostUsd: number;
  initialIntent: string;
}

export interface ToolCall {
  id: string;
  toolName: string;
  input: string;
  output: string;
  status: string;
  durationMs: number;
}

export interface TurnDetail {
  id: string;
  sequenceNumber: number;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  timestamp: string;
  userRequest: string;
  assistantResponse: string;
  toolCalls: ToolCall[];
}

export interface SessionDetail {
  id: string;
  agentId: string;
  model: string;
  provider: string;
  startedAt: string;
  lastActiveAt: string;
  totalTurns: number;
  totalTokens: number;
  totalCostUsd: number;
  initialIntent: string;
  turns: TurnDetail[];
}
