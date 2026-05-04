/**
 * Test setup for the Recondo Dashboard.
 *
 * - Installs @testing-library/jest-dom matchers globally.
 * - Provides a mock fetch infrastructure for all tests.
 * - Exports typed mock data factories matching the real API shapes.
 */

import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Polyfill ResizeObserver for jsdom (required by recharts ResponsiveContainer).
// The callback must fire with a non-zero contentRect so ResponsiveContainer
// renders its children with real width/height values.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(target: Element) {
      // Fire asynchronously to mimic real browser behavior
      setTimeout(() => {
        this.cb(
          [
            {
              target,
              contentRect: { width: 500, height: 300, top: 0, left: 0, bottom: 300, right: 500, x: 0, y: 0, toJSON: () => ({}) },
              borderBoxSize: [{ blockSize: 300, inlineSize: 500 }],
              contentBoxSize: [{ blockSize: 300, inlineSize: 500 }],
              devicePixelContentBoxSize: [{ blockSize: 300, inlineSize: 500 }],
            } as unknown as ResizeObserverEntry,
          ],
          this,
        );
      }, 0);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
}
import type {
  MonitoringDashboard,
  ManagementReview,
  RiskProfile,
  CostByTeamResponse,
  ModelAnalysisResponse,
  ToolAnalyticsResponse,
  DeveloperProductivityResponse,
  TokenSpendResponse,
  ModelDistributionResponse,
  ActiveAgentsResponse,
  CostTrendResponse,
  Soc2Export,
  Iso42001Export,
  ImpactAssessment,
  SessionSummary,
  SessionDetail,
  TurnDetail,
  ToolCall,
  FrameworkChecklistItem,
} from "../src/api/types";

// Suppress act() false positives that fire outside act() boundaries.
//
// Two sources:
// 1. ResizeObserver polyfill uses setTimeout to mimic browser behavior; the
//    callback fires after act() closes, triggering "suspended resource" warnings.
// 2. Recharts <Animate> updates state in response to the ResizeObserver, producing
//    "An update to Animate inside a test was not wrapped in act(...)."
//
// Both are cosmetic — all assertions pass. Suppress them so test output stays clean.
const _origConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const msg = typeof args[0] === "string" ? args[0] : "";
  if (msg.includes("suspended resource finished loading")) return;
  if (msg.includes("was not wrapped in act")) return;
  _origConsoleError(...args);
};

// Cleanup DOM after each test
afterEach(() => {
  cleanup();
});

// ============================================================
// Global fetch mock
// ============================================================

/**
 * Install a mock fetch that resolves with the given response body and status.
 * Call this at the top of tests or in beforeEach.
 */
export function mockFetch(
  responses: Array<{
    url?: string | RegExp;
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
    networkError?: boolean;
  }>
) {
  let callIndex = 0;
  const mockFn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    // Find matching response by URL pattern, or use sequential fallback
    const match = responses.find((r) => {
      if (!r.url) return false;
      if (typeof r.url === "string") return url.includes(r.url);
      return r.url.test(url);
    }) ?? responses[callIndex];

    callIndex++;

    if (!match) {
      return new Response(JSON.stringify({ error: "No mock configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (match.networkError) {
      throw new TypeError("Failed to fetch");
    }

    const responseHeaders = new Headers({
      "Content-Type": "application/json",
      ...match.headers,
    });

    return new Response(JSON.stringify(match.body ?? {}), {
      status: match.status ?? 200,
      headers: responseHeaders,
    });
  });

  vi.stubGlobal("fetch", mockFn);
  return mockFn;
}

/**
 * Convenience: mock a single successful JSON response.
 */
export function mockFetchOnce(body: unknown, status = 200) {
  return mockFetch([{ body, status }]);
}

/**
 * Convenience: mock a network error.
 */
export function mockFetchNetworkError() {
  return mockFetch([{ networkError: true }]);
}

// ============================================================
// Mock data factories
// ============================================================

export function createMockMonitoringDashboard(
  overrides?: Partial<MonitoringDashboard>
): MonitoringDashboard {
  return {
    activeSessions: 12,
    turnsCaptured: {
      total: 1542,
      last24h: 87,
      last7d: 423,
    },
    driftEvents: {
      systemPrompt: 2,
      toolDefinition: 1,
    },
    toolDistribution: [
      { tool: "Read", count: 450, percentage: 0.3 },
      { tool: "Write", count: 300, percentage: 0.2 },
      { tool: "Bash", count: 250, percentage: 0.167 },
      { tool: "Grep", count: 200, percentage: 0.133 },
      { tool: "Edit", count: 150, percentage: 0.1 },
    ],
    tokenTrends: [
      { period: "2026-03-20", inputTokens: 50000, outputTokens: 25000 },
      { period: "2026-03-21", inputTokens: 55000, outputTokens: 28000 },
      { period: "2026-03-22", inputTokens: 48000, outputTokens: 22000 },
    ],
    anomalyRate: {
      last30d: 5,
      resolved: 3,
      unresolved: 2,
    },
    ...overrides,
  };
}

export function createMockManagementReview(
  overrides?: Partial<ManagementReview>
): ManagementReview {
  return {
    governanceCoverage: {
      totalSessions: 156,
      totalDecisions: 2340,
      totalArtifacts: 89,
    },
    compliancePosture: {
      soc2Completeness: 97.5,
      iso42001EvidenceFreshness: 92,
    },
    anomalySummary: {
      total: 14,
      bySeverity: {
        warning: 10,
        critical: 4,
      },
      resolutionRate: 71.43,
    },
    riskProfile: {
      low: 45,
      medium: 78,
      high: 25,
      critical: 8,
    },
    frameworkChecklist: createMockFrameworkChecklist(),
    ...overrides,
  };
}

export function createMockFrameworkChecklist(): FrameworkChecklistItem[] {
  return [
    {
      clause: "ISO 42001 Cl.4 - Context of the Organization",
      status: "met",
      evidence: "156 AI sessions tracked across the organization",
    },
    {
      clause: "ISO 42001 Cl.5 - Leadership",
      status: "met",
      evidence: "Management review dashboard available for governance oversight",
    },
    {
      clause: "ISO 42001 Cl.6 - Planning",
      status: "met",
      evidence: "2340 AI decisions captured with full provenance",
    },
    {
      clause: "ISO 42001 Cl.7 - Support",
      status: "met",
      evidence: "SOC 2 completeness at 97.5%",
    },
    {
      clause: "ISO 42001 Cl.8 - Operation",
      status: "met",
      evidence: "89 artifacts produced with traceability",
    },
    {
      clause: "ISO 42001 Cl.9 - Performance Evaluation",
      status: "met",
      evidence: "Evidence freshness score: 92/100",
    },
    {
      clause: "ISO 42001 Cl.10 - Improvement",
      status: "met",
      evidence: "14 anomalies detected, 71.43% resolution rate",
    },
  ];
}

export function createMockRiskProfile(
  overrides?: Partial<RiskProfile>
): RiskProfile {
  return {
    low: 45,
    medium: 78,
    high: 25,
    critical: 8,
    ...overrides,
  };
}

export function createMockCostByTeam(
  overrides?: Partial<CostByTeamResponse>
): CostByTeamResponse {
  return {
    breakdown: [
      {
        agentId: "claude-code-team-alpha",
        sessionCount: 42,
        turnCount: 630,
        totalTokens: 1250000,
        totalCostUsd: 18.75,
      },
      {
        agentId: "claude-code-team-beta",
        sessionCount: 28,
        turnCount: 420,
        totalTokens: 840000,
        totalCostUsd: 12.6,
      },
    ],
    ...overrides,
  };
}

export function createMockModelAnalysis(
  overrides?: Partial<ModelAnalysisResponse>
): ModelAnalysisResponse {
  return {
    models: [
      {
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
        turnCount: 500,
        totalTokens: 1000000,
        totalCostUsd: 15.0,
        avgLatencyMs: 2500,
      },
      {
        model: "gpt-4o",
        provider: "openai",
        turnCount: 200,
        totalTokens: 400000,
        totalCostUsd: 8.0,
        avgLatencyMs: 3200,
      },
    ],
    ...overrides,
  };
}

export function createMockToolAnalytics(
  overrides?: Partial<ToolAnalyticsResponse>
): ToolAnalyticsResponse {
  return {
    tools: [
      { toolName: "Read", count: 450, successRate: 0.98, avgDurationMs: 120 },
      { toolName: "Write", count: 300, successRate: 0.95, avgDurationMs: 250 },
      { toolName: "Bash", count: 250, successRate: 0.88, avgDurationMs: 3500 },
    ],
    ...overrides,
  };
}

export function createMockDeveloperProductivity(
  overrides?: Partial<DeveloperProductivityResponse>
): DeveloperProductivityResponse {
  return {
    developers: [
      {
        agentId: "dev-alice",
        sessionCount: 25,
        turnCount: 375,
        totalTokens: 750000,
        totalCostUsd: 11.25,
        avgDurationMs: 2800,
      },
      {
        agentId: "dev-bob",
        sessionCount: 18,
        turnCount: 270,
        totalTokens: 540000,
        totalCostUsd: 8.1,
        avgDurationMs: 3100,
      },
    ],
    ...overrides,
  };
}

export function createMockTokenSpend(
  overrides?: Partial<TokenSpendResponse>
): TokenSpendResponse {
  return {
    datapoints: [
      {
        periodStart: "2026-03-20T00:00:00.000Z",
        totalInputTokens: 50000,
        totalOutputTokens: 25000,
        totalTokens: 75000,
        totalCostUsd: 1.125,
      },
      {
        periodStart: "2026-03-21T00:00:00.000Z",
        totalInputTokens: 55000,
        totalOutputTokens: 28000,
        totalTokens: 83000,
        totalCostUsd: 1.245,
      },
    ],
    truncated: false,
    ...overrides,
  };
}

export function createMockModelDistribution(
  overrides?: Partial<ModelDistributionResponse>
): ModelDistributionResponse {
  return {
    models: [
      {
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
        totalCostUsd: 15.0,
        totalTokens: 1000000,
        turnCount: 500,
        percentage: 65.22,
      },
      {
        model: "gpt-4o",
        provider: "openai",
        totalCostUsd: 8.0,
        totalTokens: 400000,
        turnCount: 200,
        percentage: 34.78,
      },
    ],
    truncated: false,
    ...overrides,
  };
}

export function createMockActiveAgents(
  overrides?: Partial<ActiveAgentsResponse>
): ActiveAgentsResponse {
  return {
    agents: [
      { agentId: "claude-code-alpha", sessionCount: 42, totalCostUsd: 18.75 },
      { agentId: "claude-code-beta", sessionCount: 28, totalCostUsd: 12.6 },
    ],
    totalAgents: 2,
    totalSessions: 70,
    truncated: false,
    ...overrides,
  };
}

export function createMockCostTrend(
  overrides?: Partial<CostTrendResponse>
): CostTrendResponse {
  return {
    datapoints: [
      {
        periodStart: "2026-03-20T00:00:00.000Z",
        totalCostUsd: 1.5,
        models: [
          { model: "claude-sonnet-4-20250514", costUsd: 1.0 },
          { model: "gpt-4o", costUsd: 0.5 },
        ],
      },
      {
        periodStart: "2026-03-21T00:00:00.000Z",
        totalCostUsd: 1.8,
        models: [
          { model: "claude-sonnet-4-20250514", costUsd: 1.2 },
          { model: "gpt-4o", costUsd: 0.6 },
        ],
      },
    ],
    truncated: false,
    ...overrides,
  };
}

export function createMockSoc2Export(
  overrides?: Partial<Soc2Export>
): Soc2Export {
  return {
    completeness: {
      sessions: [
        {
          sessionId: "sess-001",
          turnsCaptured: 15,
          totalTurns: 15,
          droppedEvents: 0,
          completenessPercentage: 100,
        },
        {
          sessionId: "sess-002",
          turnsCaptured: 12,
          totalTurns: 14,
          droppedEvents: 2,
          completenessPercentage: 85.71,
        },
      ],
      truncated: false,
    },
    integrity: {
      verifiedCount: 27,
      failedCount: 0,
    },
    accessLog: {
      totalQueries: 145,
      uniqueUsers: 8,
      queryTypeBreakdown: { sessions: 80, turns: 40, exports: 25 },
    },
    availability: {
      heartbeatCount: 2880,
      gapCount: 1,
      availabilityPercentage: 99.97,
    },
    processingIntegrity: {
      statement:
        "All captured API calls have SHA-256 content hashes computed at capture time. 27 turns verified with complete hash chain, 0 with incomplete references.",
      verifiedCount: 27,
      failedCount: 0,
    },
    metadata: {
      generatedAt: "2026-03-22T12:00:00.000Z",
      startDate: "2026-03-01",
      endDate: "2026-03-22",
      projectId: "proj-123",
      generatorVersion: "0.1.0",
    },
    ...overrides,
  };
}

export function createMockIso42001Export(
  overrides?: Partial<Iso42001Export>
): Iso42001Export {
  return {
    standard: "ISO/IEC 42001:2023",
    aiManagementSystem: {
      totalSessions: 156,
      totalTurns: 2340,
      totalTokens: 4680000,
      totalCostUsd: 70.2,
      anomalyCount: 14,
      modelInventory: [
        { model: "claude-sonnet-4-20250514", provider: "anthropic" },
        { model: "gpt-4o", provider: "openai" },
      ],
    },
    metadata: {
      generatedAt: "2026-03-22T12:00:00.000Z",
      projectId: "proj-123",
      startDate: "2026-03-01",
      endDate: "2026-03-22",
    },
    ...overrides,
  };
}

export function createMockImpactAssessment(
  overrides?: Partial<ImpactAssessment>
): ImpactAssessment {
  return {
    agentId: "claude-code-alpha",
    decisionVolume: {
      totalSessions: 42,
      totalTurns: 630,
      totalTokens: 1250000,
      dateRange: { from: "2026-03-01T00:00:00.000Z", to: "2026-03-22T12:00:00.000Z" },
    },
    artifactsProduced: {
      totalFiles: 156,
      uniqueFiles: 89,
    },
    anomalyHistory: [
      { type: "token_spike", severity: "warning", count: 3, resolved: 2, unresolved: 1 },
      { type: "tool_definition_drift", severity: "critical", count: 1, resolved: 1, unresolved: 0 },
    ],
    riskDistribution: {
      low: 12,
      medium: 20,
      high: 8,
      critical: 2,
    },
    ...overrides,
  };
}

export function createMockSessionList(): SessionSummary[] {
  return [
    {
      id: "sess-001",
      agentId: "claude-code-alpha",
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
      startedAt: "2026-03-22T10:00:00.000Z",
      lastActiveAt: "2026-03-22T11:30:00.000Z",
      totalTurns: 15,
      totalTokens: 30000,
      totalCostUsd: 0.45,
      initialIntent: "Implement user authentication module",
    },
    {
      id: "sess-002",
      agentId: "claude-code-beta",
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
      startedAt: "2026-03-22T09:00:00.000Z",
      lastActiveAt: "2026-03-22T09:45:00.000Z",
      totalTurns: 8,
      totalTokens: 16000,
      totalCostUsd: 0.24,
      initialIntent: "Write unit tests for payment service",
    },
  ];
}

export function createMockToolCall(overrides?: Partial<ToolCall>): ToolCall {
  return {
    id: "tc-001",
    toolName: "Read",
    input: "/src/auth/handler.ts",
    output: "file contents...",
    status: "success",
    durationMs: 45,
    ...overrides,
  };
}

export function createMockTurnDetail(overrides?: Partial<TurnDetail>): TurnDetail {
  return {
    id: "turn-001",
    sequenceNumber: 1,
    model: "claude-sonnet-4-20250514",
    provider: "anthropic",
    inputTokens: 2000,
    outputTokens: 1000,
    costUsd: 0.03,
    durationMs: 2500,
    timestamp: "2026-03-22T10:00:30.000Z",
    userRequest: "Add error handling to the login endpoint",
    assistantResponse: "I'll add try-catch blocks and proper error responses...",
    toolCalls: [createMockToolCall()],
    ...overrides,
  };
}

export function createMockSessionDetail(
  overrides?: Partial<SessionDetail>
): SessionDetail {
  return {
    id: "sess-001",
    agentId: "claude-code-alpha",
    model: "claude-sonnet-4-20250514",
    provider: "anthropic",
    startedAt: "2026-03-22T10:00:00.000Z",
    lastActiveAt: "2026-03-22T11:30:00.000Z",
    totalTurns: 3,
    totalTokens: 9000,
    totalCostUsd: 0.135,
    initialIntent: "Implement user authentication module",
    turns: [
      createMockTurnDetail({ id: "turn-001", sequenceNumber: 1 }),
      createMockTurnDetail({
        id: "turn-002",
        sequenceNumber: 2,
        userRequest: "Now add JWT token validation",
        assistantResponse: "I'll implement JWT validation middleware...",
        toolCalls: [],
      }),
      createMockTurnDetail({
        id: "turn-003",
        sequenceNumber: 3,
        userRequest: "Write tests for the auth module",
        assistantResponse: "I'll create comprehensive tests...",
        toolCalls: [
          createMockToolCall({ id: "tc-002", toolName: "Write", input: "/tests/auth.test.ts" }),
        ],
      }),
    ],
    ...overrides,
  };
}
