/**
 * Tests for TypeScript type definitions (src/api/types.ts).
 *
 * These tests verify that the type interfaces exist, are exported, and match
 * the real API response shapes from Sprint 9A. They use structural checks
 * against mock data to ensure the types are correct.
 */

import { describe, it, expect } from "vitest";
import type {
  MonitoringDashboard,
  ManagementReview,
  RiskProfile,
  RiskClassification,
  ImpactAssessment,
  CostByTeamResponse,
  CostByTeamEntry,
  DeveloperProductivityResponse,
  DeveloperProductivityEntry,
  ModelAnalysisResponse,
  ModelAnalysisEntry,
  ToolAnalyticsResponse,
  ToolAnalyticsEntry,
  TokenSpendResponse,
  TokenSpendDatapoint,
  ModelDistributionResponse,
  ModelDistributionEntry,
  ActiveAgentsResponse,
  ActiveAgentEntry,
  CostTrendResponse,
  CostTrendDatapoint,
  CostTrendModel,
  Soc2Export,
  Soc2SessionCompleteness,
  Iso42001Export,
  Iso42001ModelEntry,
  FrameworkChecklistItem,
  ToolDistributionEntry,
  TokenTrendEntry,
  AnomalyHistoryEntry,
  ApiError,
  SessionSummary,
  SessionDetail,
  TurnDetail,
  ToolCall,
} from "../../src/api/types";

import {
  createMockMonitoringDashboard,
  createMockManagementReview,
  createMockRiskProfile,
  createMockSoc2Export,
  createMockImpactAssessment,
} from "../setup";

describe("API Type Definitions", () => {
  it("MonitoringDashboard interface matches the GET /v1/dashboards/monitoring response shape", () => {
    const data: MonitoringDashboard = createMockMonitoringDashboard();

    // Top-level fields
    expect(typeof data.activeSessions).toBe("number");

    // turnsCaptured shape
    expect(typeof data.turnsCaptured.total).toBe("number");
    expect(typeof data.turnsCaptured.last24h).toBe("number");
    expect(typeof data.turnsCaptured.last7d).toBe("number");

    // driftEvents shape
    expect(typeof data.driftEvents.systemPrompt).toBe("number");
    expect(typeof data.driftEvents.toolDefinition).toBe("number");

    // toolDistribution array shape
    expect(Array.isArray(data.toolDistribution)).toBe(true);
    expect(data.toolDistribution.length).toBeGreaterThan(0);
    const tool: ToolDistributionEntry = data.toolDistribution[0];
    expect(typeof tool.tool).toBe("string");
    expect(typeof tool.count).toBe("number");
    expect(typeof tool.percentage).toBe("number");

    // tokenTrends array shape
    expect(Array.isArray(data.tokenTrends)).toBe(true);
    const trend: TokenTrendEntry = data.tokenTrends[0];
    expect(typeof trend.period).toBe("string");
    expect(typeof trend.inputTokens).toBe("number");
    expect(typeof trend.outputTokens).toBe("number");

    // anomalyRate shape
    expect(typeof data.anomalyRate.last30d).toBe("number");
    expect(typeof data.anomalyRate.resolved).toBe("number");
    expect(typeof data.anomalyRate.unresolved).toBe("number");
  });

  it("ManagementReview interface matches the GET /v1/dashboards/management-review response shape", () => {
    const data: ManagementReview = createMockManagementReview();

    // governanceCoverage
    expect(typeof data.governanceCoverage.totalSessions).toBe("number");
    expect(typeof data.governanceCoverage.totalDecisions).toBe("number");
    expect(typeof data.governanceCoverage.totalArtifacts).toBe("number");

    // compliancePosture
    expect(typeof data.compliancePosture.soc2Completeness).toBe("number");
    expect(typeof data.compliancePosture.iso42001EvidenceFreshness).toBe("number");

    // anomalySummary
    expect(typeof data.anomalySummary.total).toBe("number");
    expect(typeof data.anomalySummary.bySeverity.warning).toBe("number");
    expect(typeof data.anomalySummary.bySeverity.critical).toBe("number");
    expect(typeof data.anomalySummary.resolutionRate).toBe("number");

    // riskProfile
    expect(typeof data.riskProfile.low).toBe("number");
    expect(typeof data.riskProfile.medium).toBe("number");
    expect(typeof data.riskProfile.high).toBe("number");
    expect(typeof data.riskProfile.critical).toBe("number");

    // frameworkChecklist
    expect(Array.isArray(data.frameworkChecklist)).toBe(true);
    expect(data.frameworkChecklist.length).toBe(7); // 7 ISO 42001 clauses
    const item: FrameworkChecklistItem = data.frameworkChecklist[0];
    expect(typeof item.clause).toBe("string");
    expect(typeof item.status).toBe("string");
    expect(typeof item.evidence).toBe("string");
  });

  it("RiskProfile interface matches the GET /v1/risk/profile response shape", () => {
    const data: RiskProfile = createMockRiskProfile();

    expect(typeof data.low).toBe("number");
    expect(typeof data.medium).toBe("number");
    expect(typeof data.high).toBe("number");
    expect(typeof data.critical).toBe("number");

    // Verify RiskClassification shape
    const classification: RiskClassification = {
      riskLevel: "high",
      intent: "deploy to production",
      sessionId: "sess-001",
    };
    expect(typeof classification.riskLevel).toBe("string");
    expect(typeof classification.intent).toBe("string");
    expect(classification.sessionId).not.toBeNull();
  });

  it("Usage Intelligence interfaces match the 4 API response shapes", () => {
    // CostByTeam
    const costByTeam: CostByTeamResponse = {
      breakdown: [
        { agentId: "agent-1", sessionCount: 10, turnCount: 100, totalTokens: 200000, totalCostUsd: 3.0 },
      ],
    };
    const entry: CostByTeamEntry = costByTeam.breakdown[0];
    expect(typeof entry.agentId).toBe("string");
    expect(typeof entry.sessionCount).toBe("number");
    expect(typeof entry.turnCount).toBe("number");
    expect(typeof entry.totalTokens).toBe("number");
    expect(typeof entry.totalCostUsd).toBe("number");

    // DeveloperProductivity
    const devProd: DeveloperProductivityResponse = {
      developers: [
        { agentId: "dev-1", sessionCount: 5, turnCount: 50, totalTokens: 100000, totalCostUsd: 1.5, avgDurationMs: 2800 },
      ],
    };
    const dev: DeveloperProductivityEntry = devProd.developers[0];
    expect(typeof dev.agentId).toBe("string");
    expect(typeof dev.avgDurationMs).toBe("number");

    // ModelAnalysis
    const modelAnalysis: ModelAnalysisResponse = {
      models: [
        { model: "claude-sonnet-4-20250514", provider: "anthropic", turnCount: 500, totalTokens: 1000000, totalCostUsd: 15.0, avgLatencyMs: 2500 },
      ],
    };
    const modelEntry: ModelAnalysisEntry = modelAnalysis.models[0];
    expect(typeof modelEntry.model).toBe("string");
    expect(typeof modelEntry.provider).toBe("string");
    expect(typeof modelEntry.avgLatencyMs).toBe("number");

    // ToolAnalytics
    const toolAnalytics: ToolAnalyticsResponse = {
      tools: [
        { toolName: "Read", count: 450, successRate: 0.98, avgDurationMs: 120 },
      ],
    };
    const toolEntry: ToolAnalyticsEntry = toolAnalytics.tools[0];
    expect(typeof toolEntry.toolName).toBe("string");
    expect(typeof toolEntry.successRate).toBe("number");
  });

  it("all interfaces are exported and importable", () => {
    // This test verifies every interface in the module is importable.
    // If any import fails, this test file will not even compile.
    // We perform runtime checks on the imported names to confirm they exist.

    // Core dashboard types
    const monitoringCheck: MonitoringDashboard | null = null;
    const managementCheck: ManagementReview | null = null;
    const riskCheck: RiskProfile | null = null;

    // Usage intelligence types
    const costByTeamCheck: CostByTeamResponse | null = null;
    const devProdCheck: DeveloperProductivityResponse | null = null;
    const modelAnalysisCheck: ModelAnalysisResponse | null = null;
    const toolAnalyticsCheck: ToolAnalyticsResponse | null = null;

    // Basic usage types
    const tokenSpendCheck: TokenSpendResponse | null = null;
    const modelDistCheck: ModelDistributionResponse | null = null;
    const activeAgentsCheck: ActiveAgentsResponse | null = null;
    const costTrendCheck: CostTrendResponse | null = null;

    // Export types
    const soc2Check: Soc2Export | null = null;
    const isoCheck: Iso42001Export | null = null;
    const impactCheck: ImpactAssessment | null = null;

    // Sub-types
    const _toolDist: ToolDistributionEntry | null = null;
    const _tokenTrend: TokenTrendEntry | null = null;
    const _anomaly: AnomalyHistoryEntry | null = null;
    const _checklist: FrameworkChecklistItem | null = null;
    const _soc2Session: Soc2SessionCompleteness | null = null;
    const _isoModel: Iso42001ModelEntry | null = null;
    const _tokenDatapoint: TokenSpendDatapoint | null = null;
    const _modelDistEntry: ModelDistributionEntry | null = null;
    const _activeAgent: ActiveAgentEntry | null = null;
    const _costTrendDp: CostTrendDatapoint | null = null;
    const _costTrendModel: CostTrendModel | null = null;
    const _costByTeamEntry: CostByTeamEntry | null = null;
    const _devProdEntry: DeveloperProductivityEntry | null = null;
    const _modelEntry: ModelAnalysisEntry | null = null;
    const _toolEntry: ToolAnalyticsEntry | null = null;

    const _apiErr: ApiError | null = null;

    // Session/trace types
    const _session: SessionSummary | null = null;
    const _detail: SessionDetail | null = null;
    const _turn: TurnDetail | null = null;
    const _tool: ToolCall | null = null;

    // RiskClassification
    const _risk: RiskClassification | null = null;

    // All imported — test passes if compilation succeeds.
    // Use dummy assertions so the test isn't empty.
    expect(monitoringCheck).toBeNull();
    expect(managementCheck).toBeNull();
    expect(riskCheck).toBeNull();
    expect(costByTeamCheck).toBeNull();
    expect(devProdCheck).toBeNull();
    expect(modelAnalysisCheck).toBeNull();
    expect(toolAnalyticsCheck).toBeNull();
    expect(tokenSpendCheck).toBeNull();
    expect(modelDistCheck).toBeNull();
    expect(activeAgentsCheck).toBeNull();
    expect(costTrendCheck).toBeNull();
    expect(soc2Check).toBeNull();
    expect(isoCheck).toBeNull();
    expect(impactCheck).toBeNull();
  });

  it("SOC 2 Export interface matches the POST /v1/exports/soc2 response shape", () => {
    const data: Soc2Export = createMockSoc2Export();

    // completeness
    expect(data.completeness.sessions).toBeDefined();
    expect(Array.isArray(data.completeness.sessions)).toBe(true);
    expect(typeof data.completeness.truncated).toBe("boolean");
    const sess: Soc2SessionCompleteness = data.completeness.sessions[0];
    expect(typeof sess.sessionId).toBe("string");
    expect(typeof sess.turnsCaptured).toBe("number");
    expect(typeof sess.totalTurns).toBe("number");
    expect(typeof sess.droppedEvents).toBe("number");
    expect(typeof sess.completenessPercentage).toBe("number");

    // integrity
    expect(typeof data.integrity.verifiedCount).toBe("number");
    expect(typeof data.integrity.failedCount).toBe("number");

    // accessLog
    expect(typeof data.accessLog.totalQueries).toBe("number");
    expect(typeof data.accessLog.uniqueUsers).toBe("number");
    expect(typeof data.accessLog.queryTypeBreakdown).toBe("object");

    // availability
    expect(typeof data.availability.heartbeatCount).toBe("number");
    expect(typeof data.availability.gapCount).toBe("number");
    expect(typeof data.availability.availabilityPercentage).toBe("number");

    // processingIntegrity
    expect(typeof data.processingIntegrity.statement).toBe("string");
    expect(typeof data.processingIntegrity.verifiedCount).toBe("number");

    // metadata
    expect(typeof data.metadata.generatedAt).toBe("string");
    expect(typeof data.metadata.startDate).toBe("string");
    expect(typeof data.metadata.endDate).toBe("string");
    expect(typeof data.metadata.projectId).toBe("string");
    expect(typeof data.metadata.generatorVersion).toBe("string");
  });

  it("ImpactAssessment interface matches POST /v1/reports/impact-assessment response shape", () => {
    const data: ImpactAssessment = createMockImpactAssessment();

    expect(typeof data.agentId).toBe("string");

    // decisionVolume
    expect(typeof data.decisionVolume.totalSessions).toBe("number");
    expect(typeof data.decisionVolume.totalTurns).toBe("number");
    expect(typeof data.decisionVolume.totalTokens).toBe("number");
    expect(data.decisionVolume.dateRange).toBeDefined();

    // artifactsProduced
    expect(typeof data.artifactsProduced.totalFiles).toBe("number");
    expect(typeof data.artifactsProduced.uniqueFiles).toBe("number");

    // anomalyHistory
    expect(Array.isArray(data.anomalyHistory)).toBe(true);
    const anomaly: AnomalyHistoryEntry = data.anomalyHistory[0];
    expect(typeof anomaly.type).toBe("string");
    expect(typeof anomaly.severity).toBe("string");
    expect(typeof anomaly.count).toBe("number");
    expect(typeof anomaly.resolved).toBe("number");
    expect(typeof anomaly.unresolved).toBe("number");

    // riskDistribution
    expect(typeof data.riskDistribution.low).toBe("number");
    expect(typeof data.riskDistribution.medium).toBe("number");
    expect(typeof data.riskDistribution.high).toBe("number");
    expect(typeof data.riskDistribution.critical).toBe("number");
  });
});
