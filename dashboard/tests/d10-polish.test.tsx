/**
 * Sprint D10 -- Behavioral Tests: Polish & QA
 *
 * Cross-cutting quality tests for all 10 dashboard pages.
 * These tests verify:
 *
 *   D10.1  Visual QA: every page renders without crashing, shows its heading, no placeholder text
 *   D10.2  States: Loading, Empty, Error states on every data-driven page; confirm dialogs; toast feedback
 *   D10.3  Accessibility: aria-live, keyboard access, form labels, progressbar, expandable rows, skip link, nav
 *   D10.4  Responsive: overflow-x wrappers, two-column collapse, sidebar links
 *   D10.5  Cross-page consistency: graphqlRequest usage, shared D2 components, no TODO/FIXME/stub, TypeScript clean
 *
 * These tests are written BEFORE implementation of the D10 sprint deliverables.
 * They verify cross-cutting quality -- not page-specific features (those are covered in D3-D9).
 *
 * GraphQL responses are mocked -- no running API server required.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  within,
  act,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import * as fs from "fs";
import * as path from "path";

// ============================================================
// File system helpers for source-level checks
// ============================================================

const DASHBOARD_ROOT = path.resolve(__dirname, "..");
const SRC_ROOT = path.join(DASHBOARD_ROOT, "src");
const PAGES_DIR = path.join(SRC_ROOT, "pages");

function readFile(relativePath: string): string | null {
  const full = path.join(DASHBOARD_ROOT, relativePath);
  try {
    return fs.readFileSync(full, "utf-8");
  } catch {
    return null;
  }
}

function fileExists(relativePath: string): boolean {
  return fs.existsSync(path.join(DASHBOARD_ROOT, relativePath));
}

function listPageFiles(): string[] {
  try {
    return fs
      .readdirSync(PAGES_DIR)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => f);
  } catch {
    return [];
  }
}

// ============================================================
// Test infrastructure
// ============================================================

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        staleTime: 0,
      },
    },
  });
}

function renderWithProviders(
  ui: ReactNode,
  {
    route = "/",
    queryClient,
  }: { route?: string; queryClient?: QueryClient } = {},
) {
  const qc = queryClient ?? createTestQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Render the full App component at a given route.
 * Imports App.tsx which includes Sidebar, skip link, and all routes.
 */
async function renderApp(route: string) {
  const App = (await import("../src/App")).default;
  const qc = createTestQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ============================================================
// GraphQL mock helpers
// ============================================================

function mockGraphQLSuccess(data: unknown) {
  const mockFn = vi.fn(async () =>
    new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", mockFn);
  return mockFn;
}

function mockGraphQLError(message = "Internal Server Error") {
  const mockFn = vi.fn(async () =>
    new Response(
      JSON.stringify({ errors: [{ message }] }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    ),
  );
  vi.stubGlobal("fetch", mockFn);
  return mockFn;
}

function mockGraphQLNetworkError() {
  const mockFn = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
  vi.stubGlobal("fetch", mockFn);
  return mockFn;
}

function mockGraphQLLoading() {
  // Returns a never-resolving promise to keep queries in loading state
  const mockFn = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", mockFn);
  return mockFn;
}

// ============================================================
// Mock data for each page (minimal data to pass rendering)
// ============================================================

function realtimeData() {
  return {
    realtimeStats: {
      requestsPerMinute: 34,
      activeSessions: 12,
      activeProviderCount: 3,
      tokensLastHour: 2400000,
      cacheReadTokensLastHour: 840000,
      costLastHour: 18.42,
      costProjectedToday: 312.0,
      latencyP50Ms: 1200,
      latencyP99Ms: 4800,
      latencySampleCount: 24,
      latencySource: "turn_duration_ms",
    },
    realtimeFeed: [
      {
        timestamp: "2026-03-23T18:42:03Z",
        provider: "Anthropic",
        model: "opus-4",
        framework: "claude-code",
        intent: "Implement feature",
        totalTokens: 12841,
        costUsd: 0.42,
        httpStatus: 200,
        sessionId: "sess-001",
      },
    ],
    gatewayStatus: {
      status: "live",
      uptimeSeconds: 86400,
      lastHeartbeat: "2026-03-23T18:42:00Z",
    },
  };
}

function sessionsData() {
  return {
    sessions: {
      items: [
        {
          id: "sess-abc123def456",
          framework: "claude-code",
          model: "opus-4",
          initialIntent: "Build auth module",
          totalTurns: 15,
          totalTokens: 30000,
          totalCostUsd: 0.45,
          duration: 5400,
          status: "completed",
          startedAt: "2026-03-22T10:00:00Z",
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    },
  };
}

function sessionDetailData() {
  return {
    session: {
      id: "sess-abc123def456",
      projectId: "proj-1",
      agentId: "agent-1",
      model: "opus-4",
      provider: "Anthropic",
      startedAt: "2026-03-22T10:00:00Z",
      endedAt: "2026-03-22T11:30:00Z",
      lastActiveAt: "2026-03-22T11:30:00Z",
      initialIntent: "Build auth module",
      systemPromptHash: "sha256:abc123",
      totalTurns: 2,
      turnsCaptured: 2,
      droppedEvents: 0,
      totalTokens: 30000,
      totalCostUsd: 0.45,
      complete: true,
      framework: "claude-code",
      status: "completed",
      duration: 5400,
      accountUuid: "uuid-001",
      deviceId: "device-001",
      gitRepo: "recondo",
      gitBranch: "main",
      cacheReadTokens: 5000,
      cacheCreationTokens: 1000,
      turns: [
        {
          id: "turn-1",
          sessionId: "sess-abc123def456",
          sequenceNum: 1,
          timestamp: "2026-03-22T10:00:30Z",
          inputTokens: 2000,
          outputTokens: 1000,
          thinkingTokens: 500,
          totalTokens: 3500,
          costUsd: 0.05,
          latencyMs: 2500,
          contentHashReq: "sha256:req1",
          contentHashResp: "sha256:resp1",
          userRequestText: "Add error handling",
          responseText: "I will add try-catch...",
          thinkingText: "Considering approaches...",
          transport: "http",
          requestHash: "sha256:req1",
          responseHash: "sha256:resp1",
          cacheReadTokens: 500,
          cacheCreationTokens: 200,
        },
      ],
    },
  };
}

function auditData() {
  return {
    auditTrail: {
      items: [
        {
          timestamp: "2026-03-20T18:42:03Z",
          sessionId: "a3f8c1d42e",
          sequenceNum: 34,
          provider: "Anthropic",
          model: "opus-4",
          requestHash: "sha256:e8f4a2b1c3d5",
          responseHash: "sha256:7c3d9f01a2b4",
          totalTokens: 12841,
          integrityStatus: "verified",
          httpStatus: 200,
          captureComplete: true,
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    },
  };
}

function complianceData() {
  return {
    complianceSummary: {
      overallScore: 78,
      captureIntegrity: 99.2,
      droppedEvents: 12,
      openFindings: 7,
      findingsBySeverity: {
        critical: 0,
        high: 2,
        medium: 3,
        low: 2,
      },
      lastAssessment: "2026-03-20T12:00:00Z",
    },
    complianceFrameworks: [
      {
        id: "fw-1",
        name: "SOC 2",
        subtitle: "Trust Services Criteria",
        compliancePercentage: 85,
        controlsMet: 17,
        controlsTotal: 20,
        controls: [
          {
            id: "ctrl-1",
            controlId: "CC6.1",
            description: "Logical and physical access controls",
            status: "MET",
          },
          {
            id: "ctrl-2",
            controlId: "CC6.2",
            description: "System-level access controls",
            status: "IN_PROGRESS",
          },
        ],
      },
    ],
  };
}

function reportsData() {
  return {
    reports: {
      items: [
        {
          id: "report-1",
          name: "Q1 SOC 2 Report",
          framework: "SOC 2",
          periodStart: "2026-01-01T00:00:00Z",
          periodEnd: "2026-03-31T00:00:00Z",
          captureCount: 15234,
          findings: { critical: 0, high: 1, medium: 3, low: 5 },
          hash: "sha256:rpt1hash",
          status: "FINAL",
          generatedAt: "2026-03-20T12:00:00Z",
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    },
    reportCoverageTrend: [
      { label: "Jan", value: 90 },
      { label: "Feb", value: 92 },
    ],
    reportFindingsTrend: [
      { label: "Jan", value: 5 },
      { label: "Feb", value: 3 },
    ],
  };
}

function costData() {
  return {
    usageSummary: {
      totalCostUsd: 1423.50,
      projectedMonthlyCostUsd: 2100.0,
      totalTokens: 45000000,
      cacheReadTokens: 12000000,
      cacheReadPercentage: 26.7,
      averageCostPerSession: 4.12,
      averageCostDelta: -0.35,
      cacheHitRate: 42,
      cacheSavingsUsd: 312.0,
      costPerDeveloperPerDay: 8.50,
      developerCount: 12,
    },
    spendByProvider: [
      { name: "Anthropic", costUsd: 950, percentage: 67, count: 230 },
    ],
    spendByModel: [
      { name: "opus-4", costUsd: 800, percentage: 56, count: 180 },
    ],
    spendByFramework: [
      { name: "Claude Code", costUsd: 1100, percentage: 77, count: 280 },
    ],
    dailySpend: [
      { name: "Mar 20", costUsd: 48, percentage: 100, count: 42 },
    ],
    costProjections: [
      {
        month: "Apr 2026",
        projectedSessions: 420,
        projectedTokens: 52000000,
        projectedCostUsd: 2200,
        deltaVsCurrent: 5,
        assumptions: "Linear growth based on 30-day baseline",
      },
    ],
  };
}

function agentData() {
  return {
    agentSummary: {
      activeAgents: 5,
      totalSessions: 142,
      sessionsDelta: 12,
      averageTurnsPerSession: 18,
      uniqueDevelopers: 8,
    },
    topDevelopers: {
      items: [
        {
          accountUuid: "dev-alice-uuid",
          sessionCount: 42,
          totalTokens: 1250000,
          totalCostUsd: 18.75,
          favoriteModel: "opus-4",
        },
      ],
      total: 1,
      limit: 10,
      offset: 0,
    },
    topRepositories: {
      items: [
        {
          repository: "recondo",
          sessionCount: 35,
          branchCount: 4,
          totalCostUsd: 15.20,
          primaryFramework: "Claude Code",
        },
      ],
      total: 1,
      limit: 10,
      offset: 0,
    },
  };
}

function policiesData() {
  return {
    policies: {
      items: [
        {
          id: "pol-1",
          name: "Block Sensitive Data",
          type: "BLOCK",
          scope: "All Agents",
          action: "Block requests containing PII",
          triggersMtd: 47,
          status: "ACTIVE",
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    },
    policyTriggerHistory: [
      { label: "Mon", value: 8 },
      { label: "Tue", value: 12 },
    ],
  };
}

function apiKeysData() {
  return {
    registeredKeys: {
      items: [
        {
          id: "key-1",
          name: "Production Anthropic",
          provider: "Anthropic",
          fingerprint: "sha256:abc123...",
          agentCount: 3,
          lastUsed: "2026-03-23T10:00:00Z",
          monthlyCostUsd: 520.0,
          status: "ACTIVE",
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    },
  };
}

// ============================================================
// Page imports (lazy -- matching the real app)
// ============================================================

async function importPage(name: string) {
  return (await import(`../src/pages/${name}`)).default;
}

// ============================================================
// Cleanup
// ============================================================

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// D10.1 -- Visual QA
// ============================================================

describe("D10.1 -- Visual QA: every page renders", () => {
  /** All 11 page files exist (10 pages + NotFound). */
  const EXPECTED_PAGES = [
    "RealtimeFeed",
    "Sessions",
    "SessionDetail",
    "AuditTrail",
    "Compliance",
    "AuditReports",
    "CostUsage",
    "AgentAnalytics",
    "Policies",
    "ApiKeys",
    "NotFound",
  ];

  for (const pageName of EXPECTED_PAGES) {
    it(`${pageName}.tsx file exists`, () => {
      expect(fileExists(`src/pages/${pageName}.tsx`)).toBe(true);
    });
  }

  /** Rendering tests: each page renders without throwing. */
  const PAGES_WITH_DATA: Array<{
    name: string;
    route: string;
    data: () => Record<string, unknown>;
    heading: RegExp;
  }> = [
    {
      name: "RealtimeFeed",
      route: "/realtime",
      data: realtimeData,
      heading: /realtime/i,
    },
    {
      name: "Sessions",
      route: "/sessions",
      data: sessionsData,
      heading: /sessions/i,
    },
    {
      name: "SessionDetail",
      route: "/sessions/sess-abc123def456",
      data: sessionDetailData,
      heading: /session/i,
    },
    {
      name: "AuditTrail",
      route: "/audit",
      data: auditData,
      heading: /audit trail/i,
    },
    {
      name: "Compliance",
      route: "/compliance",
      data: complianceData,
      heading: /compliance/i,
    },
    {
      name: "AuditReports",
      route: "/reports",
      data: reportsData,
      heading: /audit reports/i,
    },
    {
      name: "CostUsage",
      route: "/cost",
      data: costData,
      heading: /cost/i,
    },
    {
      name: "AgentAnalytics",
      route: "/agents",
      data: agentData,
      heading: /agent/i,
    },
    {
      name: "Policies",
      route: "/policies",
      data: policiesData,
      heading: /polic/i,
    },
    {
      name: "ApiKeys",
      route: "/keys",
      data: apiKeysData,
      heading: /api key/i,
    },
  ];

  for (const { name, route, data, heading } of PAGES_WITH_DATA) {
    it(`${name} renders without crashing and shows a heading`, async () => {
      mockGraphQLSuccess(data());
      const Page = await importPage(name);

      if (name === "SessionDetail") {
        renderWithProviders(
          <Routes>
            <Route path="/sessions/:id" element={<Page />} />
          </Routes>,
          { route },
        );
      } else {
        renderWithProviders(<Page />, { route });
      }

      // Wait for data to load, then verify the heading appears
      await waitFor(
        () => {
          const h2s = screen.getAllByRole("heading", { level: 2 });
          const match = h2s.some((h) => heading.test(h.textContent ?? ""));
          expect(match).toBe(true);
        },
        { timeout: 5000 },
      );
    });
  }

  it("NotFound renders its heading", async () => {
    const Page = await importPage("NotFound");
    renderWithProviders(<Page />);
    expect(screen.getByText(/404/)).toBeInTheDocument();
    expect(screen.getByText(/not found/i)).toBeInTheDocument();
  });

  it("no page source contains 'Available after Sprint'", () => {
    const pageFiles = listPageFiles();
    expect(pageFiles.length).toBeGreaterThanOrEqual(10);

    for (const file of pageFiles) {
      const content = readFile(`src/pages/${file}`);
      expect(content).not.toBeNull();
      expect(content).not.toContain("Available after Sprint");
    }
  });
});

// ============================================================
// D10.2 -- States: Loading, Empty, Error
// ============================================================

describe("D10.2 -- States: Loading, Error, Empty on every data-driven page", () => {
  // Pages that fetch data and should show LoadingState
  const DATA_PAGES: Array<{
    name: string;
    route: string;
    emptyData: () => Record<string, unknown>;
    emptyCheck: RegExp;
  }> = [
    {
      name: "RealtimeFeed",
      route: "/realtime",
      emptyData: () => ({
        realtimeStats: {
          requestsPerMinute: 0,
          activeSessions: 0,
          activeProviderCount: 0,
          tokensLastHour: 0,
          cacheReadTokensLastHour: 0,
          costLastHour: 0,
          costProjectedToday: 0,
          latencyP50Ms: 0,
          latencyP99Ms: 0,
          latencySampleCount: 0,
          latencySource: "none",
        },
        realtimeFeed: [],
        gatewayStatus: { status: "live", uptimeSeconds: 0, lastHeartbeat: "2026-03-23T18:42:00Z" },
      }),
      emptyCheck: /no traffic/i,
    },
    {
      name: "Sessions",
      route: "/sessions",
      emptyData: () => ({ sessions: { items: [], total: 0, limit: 20, offset: 0 } }),
      emptyCheck: /no sessions/i,
    },
    {
      name: "AuditTrail",
      route: "/audit",
      emptyData: () => ({ auditTrail: { items: [], total: 0, limit: 20, offset: 0 } }),
      emptyCheck: /no audit/i,
    },
    {
      name: "Compliance",
      route: "/compliance",
      emptyData: () => ({
        complianceSummary: {
          overallScore: 0,
          captureIntegrity: 0,
          droppedEvents: 0,
          openFindings: 0,
          findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
          lastAssessment: null,
        },
        complianceFrameworks: [],
      }),
      emptyCheck: /no frameworks/i,
    },
    {
      name: "AuditReports",
      route: "/reports",
      emptyData: () => ({
        reports: { items: [], total: 0, limit: 20, offset: 0 },
        reportCoverageTrend: [],
        reportFindingsTrend: [],
      }),
      emptyCheck: /no reports/i,
    },
    {
      name: "AgentAnalytics",
      route: "/agents",
      emptyData: () => ({
        agentSummary: {
          activeAgents: 0,
          totalSessions: 0,
          sessionsDelta: 0,
          averageTurnsPerSession: 0,
          uniqueDevelopers: 0,
        },
        topDevelopers: { items: [], total: 0, limit: 10, offset: 0 },
        topRepositories: { items: [], total: 0, limit: 10, offset: 0 },
      }),
      emptyCheck: /no agent data/i,
    },
    {
      name: "Policies",
      route: "/policies",
      emptyData: () => ({
        policies: { items: [], total: 0, limit: 20, offset: 0 },
        policyTriggerHistory: [],
      }),
      emptyCheck: /no policies/i,
    },
    {
      name: "ApiKeys",
      route: "/keys",
      emptyData: () => ({
        registeredKeys: { items: [], total: 0, limit: 20, offset: 0 },
      }),
      emptyCheck: /no keys/i,
    },
  ];

  describe("Loading states", () => {
    for (const { name, route } of DATA_PAGES) {
      it(`${name} shows LoadingState while data loads`, async () => {
        mockGraphQLLoading();
        const Page = await importPage(name);
        renderWithProviders(<Page />, { route });

        // LoadingState has data-testid="loading-state" and role="status"
        await waitFor(() => {
          const loadingEl = screen.getByTestId("loading-state");
          expect(loadingEl).toBeInTheDocument();
          expect(loadingEl).toHaveAttribute("role", "status");
        });
      });
    }
  });

  describe("Error states", () => {
    for (const { name, route } of DATA_PAGES) {
      it(`${name} shows ErrorState on GraphQL error`, async () => {
        mockGraphQLError("Something went wrong");
        const Page = await importPage(name);
        renderWithProviders(<Page />, { route });

        await waitFor(
          () => {
            const alertEl = screen.getByRole("alert");
            expect(alertEl).toBeInTheDocument();
          },
          { timeout: 5000 },
        );
      });
    }
  });

  describe("Empty states", () => {
    for (const { name, route, emptyData, emptyCheck } of DATA_PAGES) {
      it(`${name} shows EmptyState when no data`, async () => {
        mockGraphQLSuccess(emptyData());
        const Page = await importPage(name);
        renderWithProviders(<Page />, { route });

        await waitFor(
          () => {
            expect(screen.getByText(emptyCheck)).toBeInTheDocument();
          },
          { timeout: 5000 },
        );
      });
    }
  });

  describe("Confirm dialogs", () => {
    it("Policies delete uses window.confirm", async () => {
      mockGraphQLSuccess(policiesData());
      const Page = await importPage("Policies");
      renderWithProviders(<Page />, { route: "/policies" });

      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

      await waitFor(
        () => {
          const deleteBtn = screen.getByLabelText(/delete policy/i);
          expect(deleteBtn).toBeInTheDocument();
        },
        { timeout: 5000 },
      );

      const deleteBtn = screen.getByLabelText(/delete policy/i);
      await act(async () => {
        deleteBtn.click();
      });

      expect(confirmSpy).toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it("ApiKeys delete uses window.confirm", async () => {
      mockGraphQLSuccess(apiKeysData());
      const Page = await importPage("ApiKeys");
      renderWithProviders(<Page />, { route: "/keys" });

      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

      await waitFor(
        () => {
          const deleteBtn = screen.getByLabelText(/delete key/i);
          expect(deleteBtn).toBeInTheDocument();
        },
        { timeout: 5000 },
      );

      const deleteBtn = screen.getByLabelText(/delete key/i);
      await act(async () => {
        deleteBtn.click();
      });

      expect(confirmSpy).toHaveBeenCalled();
      confirmSpy.mockRestore();
    });
  });
});

// ============================================================
// D10.3 -- Accessibility
// ============================================================

describe("D10.3 -- Accessibility", () => {
  describe("aria-live regions", () => {
    // Pages that wrap their content in aria-live="polite"
    const ARIA_LIVE_PAGES: Array<{ name: string; route: string; data: () => Record<string, unknown> }> = [
      { name: "AuditTrail", route: "/audit", data: auditData },
      { name: "Compliance", route: "/compliance", data: complianceData },
      { name: "AuditReports", route: "/reports", data: reportsData },
      { name: "CostUsage", route: "/cost", data: costData },
      { name: "AgentAnalytics", route: "/agents", data: agentData },
      { name: "Policies", route: "/policies", data: policiesData },
      { name: "ApiKeys", route: "/keys", data: apiKeysData },
    ];

    for (const { name, route, data } of ARIA_LIVE_PAGES) {
      it(`${name} has aria-live region`, async () => {
        mockGraphQLSuccess(data());
        const Page = await importPage(name);
        const { container } = renderWithProviders(<Page />, { route });

        // The outermost div should have aria-live="polite"
        await waitFor(() => {
          const liveRegions = container.querySelectorAll("[aria-live]");
          expect(liveRegions.length).toBeGreaterThanOrEqual(1);
        });
      });
    }
  });

  describe("Keyboard access on interactive elements", () => {
    it("DataTable rows with onRowClick have tabIndex for keyboard access", () => {
      // Source-level check: DataTable.tsx adds tabIndex={0} when onRowClick is provided
      const content = readFile("src/components/DataTable.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain("tabIndex");
      expect(content).toContain("onKeyDown");
    });

    it("ExpandableRow (div trigger) has tabIndex and Enter/Space handler", () => {
      const content = readFile("src/components/ExpandableRow.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain("tabIndex={0}");
      expect(content).toContain('e.key === "Enter"');
      expect(content).toContain('e.key === " "');
    });

    it("FilterBar buttons have aria-pressed", () => {
      const content = readFile("src/components/FilterBar.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain("aria-pressed");
    });

    it("Pagination has aria-label and aria-current for active page", () => {
      const content = readFile("src/components/Pagination.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain('aria-label="Pagination"');
      expect(content).toContain('aria-current');
    });

    it("Compliance controls have role=button, tabIndex, Enter/Space handler", () => {
      const content = readFile("src/pages/Compliance.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain('role="button"');
      expect(content).toContain("tabIndex={0}");
      expect(content).toContain('e.key === "Enter"');
      expect(content).toContain('e.key === " "');
    });
  });

  describe("Form input labels", () => {
    it("Compliance modal form has htmlFor labels on all inputs", () => {
      const content = readFile("src/pages/Compliance.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain('htmlFor="status-select"');
      expect(content).toContain('htmlFor="reason-input"');
      expect(content).toContain('id="status-select"');
      expect(content).toContain('id="reason-input"');
    });

    it("AuditReports generate form has htmlFor labels on all inputs", () => {
      const content = readFile("src/pages/AuditReports.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain('htmlFor="gen-framework"');
      expect(content).toContain('htmlFor="gen-start"');
      expect(content).toContain('htmlFor="gen-end"');
      expect(content).toContain('id="gen-framework"');
      expect(content).toContain('id="gen-start"');
      expect(content).toContain('id="gen-end"');
    });

    it("Policies create form has htmlFor labels on all inputs", () => {
      const content = readFile("src/pages/Policies.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain('htmlFor="policy-name"');
      expect(content).toContain('htmlFor="policy-type"');
      expect(content).toContain('htmlFor="policy-scope"');
      expect(content).toContain('htmlFor="policy-action"');
      expect(content).toContain('id="policy-name"');
      expect(content).toContain('id="policy-type"');
      expect(content).toContain('id="policy-scope"');
      expect(content).toContain('id="policy-action"');
    });

    it("ApiKeys register form has htmlFor labels on all inputs", () => {
      const content = readFile("src/pages/ApiKeys.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain('htmlFor="key-name"');
      expect(content).toContain('htmlFor="key-provider"');
      expect(content).toContain('htmlFor="key-fingerprint"');
      expect(content).toContain('id="key-name"');
      expect(content).toContain('id="key-provider"');
      expect(content).toContain('id="key-fingerprint"');
    });

    it("SearchInput has aria-label", () => {
      const content = readFile("src/components/SearchInput.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain("aria-label");
    });
  });

  describe("ProgressBar accessibility", () => {
    it("ProgressBar component has role=progressbar with aria-valuenow", () => {
      const content = readFile("src/components/ProgressBar.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain('role="progressbar"');
      expect(content).toContain("aria-valuenow");
      expect(content).toContain("aria-valuemin");
      expect(content).toContain("aria-valuemax");
    });

    it("Compliance page uses ProgressBar for framework progress", () => {
      const content = readFile("src/pages/Compliance.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain("ProgressBar");
      expect(content).toMatch(/import.*ProgressBar.*from.*components\/ProgressBar/);
    });
  });

  describe("ExpandableRow accessibility", () => {
    it("ExpandableRow has aria-expanded attribute", () => {
      const content = readFile("src/components/ExpandableRow.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain("aria-expanded");
      expect(content).toContain("aria-controls");
    });

    it("SessionDetail uses ExpandableRow for turns", () => {
      const content = readFile("src/pages/SessionDetail.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain("ExpandableRow");
      expect(content).toMatch(/import.*ExpandableRow.*from.*components\/ExpandableRow/);
    });
  });

  describe("Skip to main content link", () => {
    it("App.tsx contains a skip link targeting #main-content", () => {
      const content = readFile("src/App.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain("skip-link");
      expect(content).toContain('#main-content');
      expect(content).toContain('id="main-content"');
      expect(content).toContain("Skip to main content");
    });

    it("Skip link renders in the DOM", async () => {
      mockGraphQLLoading();
      await renderApp("/realtime");

      const skipLink = screen.getByText("Skip to main content");
      expect(skipLink).toBeInTheDocument();
      expect(skipLink.tagName).toBe("A");
      expect(skipLink).toHaveAttribute("href", "#main-content");
    });
  });

  describe("Nav has aria-label", () => {
    it("Sidebar nav element has aria-label='Main navigation'", () => {
      const content = readFile("src/components/Sidebar.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain('aria-label="Main navigation"');
    });

    it("Sidebar renders with aria-label in the DOM", async () => {
      mockGraphQLLoading();
      await renderApp("/realtime");

      const nav = screen.getByRole("navigation", { name: /main navigation/i });
      expect(nav).toBeInTheDocument();
    });
  });

  describe("ErrorState uses role=alert", () => {
    it("ErrorState component has role=alert", () => {
      const content = readFile("src/components/ErrorState.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain('role="alert"');
    });
  });

  describe("LoadingState uses role=status", () => {
    it("LoadingState component has role=status", () => {
      const content = readFile("src/components/LoadingState.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain('role="status"');
    });
  });
});

// ============================================================
// D10.4 -- Responsive
// ============================================================

describe("D10.4 -- Responsive", () => {
  describe("Tables have overflow wrapper", () => {
    it("DataTable wraps table in a container div (overflow wrapper)", () => {
      const content = readFile("src/components/DataTable.tsx");
      expect(content).not.toBeNull();
      // DataTable.tsx wraps in <div className={styles.wrap}><table>...</table></div>
      // The CSS module .wrap provides the overflow behavior
      expect(content).toContain("styles.wrap");
    });

    it("DataTable.module.css exists for overflow styling", () => {
      const content = readFile("src/components/DataTable.module.css");
      expect(content).not.toBeNull();
      expect(content).toContain(".wrap");
    });
  });

  describe("Two-column layout collapses at narrow widths", () => {
    it("TwoColumnLayout.module.css has media query for narrow widths", () => {
      const content = readFile("src/components/TwoColumnLayout.module.css");
      expect(content).not.toBeNull();
      // Should have a media query that collapses to single column
      expect(content).toMatch(/@media.*max-width/);
      expect(content).toContain("grid-template-columns: 1fr");
    });

    it("CostUsage page uses TwoColumnLayout for spend breakdowns", () => {
      const content = readFile("src/pages/CostUsage.tsx");
      expect(content).not.toBeNull();
      expect(content).toMatch(/import.*TwoColumnLayout.*from.*components\/TwoColumnLayout/);
    });
  });

  describe("Sidebar navigation", () => {
    it("Sidebar has navigation links for all page sections", () => {
      const content = readFile("src/components/Sidebar.tsx");
      expect(content).not.toBeNull();

      // All navigation paths should be present
      const expectedPaths = [
        "/realtime",
        "/sessions",
        "/audit",
        "/compliance",
        "/reports",
        "/cost",
        "/agents",
        "/policies",
        "/keys",
      ];

      for (const pathStr of expectedPaths) {
        expect(content).toContain(`"${pathStr}"`);
      }
    });

    it("Sidebar renders all navigation links in the DOM", async () => {
      mockGraphQLLoading();
      await renderApp("/realtime");

      const nav = screen.getByRole("navigation", { name: /main navigation/i });
      const links = within(nav).getAllByRole("link");

      // At least 9 navigation links (one per page, excluding NotFound)
      expect(links.length).toBeGreaterThanOrEqual(9);

      // Verify key navigation labels are present
      const linkTexts = links.map((l) => l.textContent);
      expect(linkTexts.some((t) => /realtime/i.test(t ?? ""))).toBe(true);
      expect(linkTexts.some((t) => /sessions/i.test(t ?? ""))).toBe(true);
      expect(linkTexts.some((t) => /audit trail/i.test(t ?? ""))).toBe(true);
      expect(linkTexts.some((t) => /compliance/i.test(t ?? ""))).toBe(true);
      expect(linkTexts.some((t) => /reports/i.test(t ?? ""))).toBe(true);
      expect(linkTexts.some((t) => /cost/i.test(t ?? ""))).toBe(true);
      expect(linkTexts.some((t) => /agent/i.test(t ?? ""))).toBe(true);
      expect(linkTexts.some((t) => /polic/i.test(t ?? ""))).toBe(true);
      expect(linkTexts.some((t) => /key/i.test(t ?? ""))).toBe(true);
    });
  });
});

// ============================================================
// D10.5 -- Cross-page consistency
// ============================================================

describe("D10.5 -- Cross-page consistency", () => {
  describe("All pages use graphqlRequest from ../graphql/client", () => {
    // Pages that make GraphQL requests
    const GRAPHQL_PAGES = [
      "RealtimeFeed",
      "Sessions",
      "SessionDetail",
      "AuditTrail",
      "Compliance",
      "AuditReports",
      "CostUsage",
      "AgentAnalytics",
      "Policies",
      "ApiKeys",
    ];

    for (const pageName of GRAPHQL_PAGES) {
      it(`${pageName} imports graphqlRequest from ../graphql/client`, () => {
        const content = readFile(`src/pages/${pageName}.tsx`);
        expect(content).not.toBeNull();
        expect(content).toMatch(/import.*graphqlRequest.*from.*["']\.\.\/graphql\/client["']/);
      });

      it(`${pageName} does NOT use raw fetch for GraphQL`, () => {
        const content = readFile(`src/pages/${pageName}.tsx`);
        expect(content).not.toBeNull();
        // Should not call fetch("/graphql") or fetch("...graphql...") directly
        // Only graphqlRequest should be used for GraphQL calls.
        // Pages may use fetch for non-GraphQL operations (CSV export, download) which is OK.
        // We check there is no fetch call containing "graphql" in the URL.
        const lines = content!.split("\n");
        for (const line of lines) {
          // Skip import lines and comments
          if (line.trim().startsWith("import ") || line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
          // If line calls fetch() with graphql in URL, that's wrong
          if (/fetch\s*\(.*graphql/i.test(line)) {
            expect(line).toBe("__should_not_contain_raw_graphql_fetch__");
          }
        }
      });
    }
  });

  describe("All pages use shared D2 components", () => {
    it("every page with loading state imports LoadingState from ../components/LoadingState", () => {
      const pagesWithLoading = [
        "RealtimeFeed",
        "Sessions",
        "SessionDetail",
        "AuditTrail",
        "Compliance",
        "AuditReports",
        "CostUsage",
        "AgentAnalytics",
        "Policies",
        "ApiKeys",
      ];

      for (const pageName of pagesWithLoading) {
        const content = readFile(`src/pages/${pageName}.tsx`);
        expect(content).not.toBeNull();
        expect(content).toMatch(/import.*LoadingState.*from.*["']\.\.\/components\/LoadingState["']/);
      }
    });

    it("every page with error state imports ErrorState from ../components/ErrorState", () => {
      const pagesWithError = [
        "RealtimeFeed",
        "Sessions",
        "SessionDetail",
        "AuditTrail",
        "Compliance",
        "AuditReports",
        "CostUsage",
        "AgentAnalytics",
        "Policies",
        "ApiKeys",
      ];

      for (const pageName of pagesWithError) {
        const content = readFile(`src/pages/${pageName}.tsx`);
        expect(content).not.toBeNull();
        expect(content).toMatch(/import.*ErrorState.*from.*["']\.\.\/components\/ErrorState["']/);
      }
    });

    it("pages with data tables import DataTable from ../components/DataTable", () => {
      const pagesWithTable = [
        "Sessions",
        "AuditTrail",
        "AuditReports",
        "AgentAnalytics",
        "Policies",
        "ApiKeys",
      ];

      for (const pageName of pagesWithTable) {
        const content = readFile(`src/pages/${pageName}.tsx`);
        expect(content).not.toBeNull();
        expect(content).toMatch(/import.*DataTable.*from.*["']\.\.\/components\/DataTable["']/);
      }
    });

    it("pages with tag pills import TagPill from ../components/TagPill", () => {
      const pagesWithPills = [
        "RealtimeFeed",
        "Sessions",
        "SessionDetail",
        "AuditTrail",
        "AuditReports",
        "Policies",
        "ApiKeys",
      ];

      for (const pageName of pagesWithPills) {
        const content = readFile(`src/pages/${pageName}.tsx`);
        expect(content).not.toBeNull();
        expect(content).toMatch(/import.*TagPill.*from.*["']\.\.\/components\/TagPill["']/);
      }
    });
  });

  describe("No TODO/FIXME/stub in any page", () => {
    it("no page source file contains TODO, FIXME, or stub markers", () => {
      const pageFiles = listPageFiles();
      expect(pageFiles.length).toBeGreaterThanOrEqual(10);

      for (const file of pageFiles) {
        const content = readFile(`src/pages/${file}`);
        expect(content).not.toBeNull();

        // Check line by line, ignoring comment references that describe past fixes
        const lines = content!.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Skip lines that reference past ticket codes like "// N1:" or "// B3:" or "// W5:"
          // These are audit trail comments, not actual TODOs
          if (/^\s*\/\/\s*[NBW]\d+:/i.test(line)) continue;

          // Real TODO/FIXME markers that indicate unfinished work
          if (/\bTODO\b/i.test(line)) {
            expect(`${file}:${i + 1}: ${line.trim()}`).toBe("__no_TODO_allowed__");
          }
          if (/\bFIXME\b/i.test(line)) {
            expect(`${file}:${i + 1}: ${line.trim()}`).toBe("__no_FIXME_allowed__");
          }
        }
      }
    });

    it("no page returns a stub component (bail/todo/unimplemented)", () => {
      const pageFiles = listPageFiles();

      for (const file of pageFiles) {
        const content = readFile(`src/pages/${file}`);
        expect(content).not.toBeNull();

        // Should not contain bail!, todo!, unimplemented!, or "throw new Error('Not implemented')"
        expect(content).not.toMatch(/\bbail!\b/);
        expect(content).not.toMatch(/\btodo!\b/);
        expect(content).not.toMatch(/\bunimplemented\b/i);
        expect(content).not.toMatch(/throw new Error\(['"]Not implemented['"]\)/);
      }
    });
  });

  describe("graphql/client.ts exists and exports graphqlRequest", () => {
    it("graphql/client.ts file exists", () => {
      expect(fileExists("src/graphql/client.ts")).toBe(true);
    });

    it("graphql/client.ts exports graphqlRequest function", () => {
      const content = readFile("src/graphql/client.ts");
      expect(content).not.toBeNull();
      expect(content).toMatch(/export\s+(async\s+)?function\s+graphqlRequest/);
    });

    it("graphql/client.ts exports extractField function", () => {
      const content = readFile("src/graphql/client.ts");
      expect(content).not.toBeNull();
      expect(content).toMatch(/export\s+function\s+extractField/);
    });
  });

  describe("App.tsx uses React.lazy for code splitting", () => {
    it("App.tsx lazy-loads all page components", () => {
      const content = readFile("src/App.tsx");
      expect(content).not.toBeNull();

      const expectedLazyImports = [
        "RealtimeFeed",
        "Sessions",
        "SessionDetail",
        "AuditTrail",
        "Compliance",
        "AuditReports",
        "CostUsage",
        "AgentAnalytics",
        "Policies",
        "ApiKeys",
        "NotFound",
      ];

      for (const pageName of expectedLazyImports) {
        expect(content).toContain(`React.lazy(() => import("./pages/${pageName}")`);
      }
    });

    it("App.tsx wraps routes in Suspense", () => {
      const content = readFile("src/App.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain("Suspense");
    });

    it("App.tsx wraps routes in ErrorBoundary", () => {
      const content = readFile("src/App.tsx");
      expect(content).not.toBeNull();
      expect(content).toContain("ErrorBoundary");
    });
  });

  describe("Shared components exist", () => {
    const REQUIRED_COMPONENTS = [
      "Sidebar",
      "LoadingState",
      "ErrorState",
      "EmptyState",
      "DataTable",
      "MetricCard",
      "TagPill",
      "FilterBar",
      "SearchInput",
      "Pagination",
      "ExpandableRow",
      "ProgressBar",
      "ChartBox",
      "TwoColumnLayout",
      "CostBar",
      "FeedItem",
      "Timestamp",
      "ErrorBoundary",
      "Toast",
    ];

    for (const name of REQUIRED_COMPONENTS) {
      it(`${name}.tsx component exists`, () => {
        expect(fileExists(`src/components/${name}.tsx`)).toBe(true);
      });
    }
  });
});

// ============================================================
// D10.6 -- Integration: Full App renders at each route
// ============================================================

describe("D10.6 -- Full App shell renders at each route", () => {
  const ROUTES = [
    { path: "/realtime", label: "Realtime Feed" },
    { path: "/sessions", label: "Sessions" },
    { path: "/audit", label: "Audit Trail" },
    { path: "/compliance", label: "Compliance" },
    { path: "/reports", label: "Audit Reports" },
    { path: "/cost", label: "Cost & Usage" },
    { path: "/agents", label: "Agent Analytics" },
    { path: "/policies", label: "Policies" },
    { path: "/keys", label: "API Keys" },
  ];

  for (const { path: routePath, label } of ROUTES) {
    it(`App renders at ${routePath} with sidebar and skip link`, async () => {
      mockGraphQLLoading();
      await renderApp(routePath);

      // Skip link exists
      expect(screen.getByText("Skip to main content")).toBeInTheDocument();

      // Sidebar nav exists
      const nav = screen.getByRole("navigation", { name: /main navigation/i });
      expect(nav).toBeInTheDocument();

      // RECONDO logo visible
      expect(screen.getByText("RECONDO")).toBeInTheDocument();

      // Main content area exists
      const main = document.getElementById("main-content");
      expect(main).not.toBeNull();
      expect(main?.tagName).toBe("MAIN");
    });
  }

  it("App renders NotFound for unknown routes", async () => {
    mockGraphQLLoading();
    await renderApp("/this-does-not-exist");

    await waitFor(() => {
      expect(screen.getByText(/404/)).toBeInTheDocument();
    });
  });

  it("App redirects / to /realtime", () => {
    const content = readFile("src/App.tsx");
    expect(content).not.toBeNull();
    expect(content).toContain('path="/"');
    expect(content).toContain('Navigate to="/realtime"');
  });
});
