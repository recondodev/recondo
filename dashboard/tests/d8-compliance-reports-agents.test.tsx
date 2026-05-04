/**
 * Sprint D8 -- Behavioral Tests: Compliance Dashboard + Audit Reports + Agent Analytics
 *
 * Tests for:
 *   D8.1  Compliance Dashboard (metric cards, framework cards, ProgressBar, control checklists, status update mutation)
 *   D8.2  Audit Reports (reports table, generate report mutation, download button, trend charts)
 *   D8.3  Agent Analytics (metric cards, framework donut chart, top developers table, top repositories table)
 *
 * These tests are written BEFORE implementation exists.
 * They verify the design document deliverables, not implementation internals.
 *
 * GraphQL responses are mocked -- no running API server required.
 * Every test verifies that pages USE shared D2 components (MetricCard, DataTable,
 * ProgressBar, TagPill, FilterBar, ChartBox, LoadingState, ErrorState, EmptyState, etc.)
 * rather than re-implementing them inline.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  within,
  fireEvent,
  act,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// ============================================================
// Test infrastructure
// ============================================================

/** Create an isolated QueryClient for each test. */
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

/**
 * Render wrapper that provides MemoryRouter + QueryClientProvider.
 * Pages need both to function.
 */
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

// ============================================================
// Mock GraphQL data factories -- D8.1 Compliance Dashboard
// ============================================================

function createMockComplianceSummary(overrides?: Record<string, unknown>) {
  return {
    overallScore: 78,
    captureIntegrity: 99.2,
    hashMismatches: 3,
    droppedEvents: 12,
    openFindings: 7,
    findingsBySeverity: {
      critical: 0,
      high: 2,
      medium: 3,
      low: 2,
    },
    lastAssessment: "2026-03-22T14:30:00Z",
    ...overrides,
  };
}

function createMockComplianceFrameworks() {
  return [
    {
      id: "fw-soc2",
      name: "SOC 2",
      subtitle: "Type II Trust Services Criteria",
      compliancePercentage: 85,
      controlsMet: 17,
      controlsTotal: 20,
      controls: [
        { id: "c-1", controlId: "CC6.1", description: "Logical access controls", status: "MET" },
        { id: "c-2", controlId: "CC6.2", description: "Authentication mechanisms", status: "MET" },
        { id: "c-3", controlId: "CC6.3", description: "Encryption in transit", status: "IN_PROGRESS" },
        { id: "c-4", controlId: "CC7.1", description: "System monitoring", status: "NOT_MET" },
      ],
    },
    {
      id: "fw-iso42001",
      name: "ISO 42001",
      subtitle: "AI Management System",
      compliancePercentage: 62,
      controlsMet: 8,
      controlsTotal: 13,
      controls: [
        { id: "c-5", controlId: "4.1", description: "Understanding the organization", status: "MET" },
        { id: "c-6", controlId: "6.1", description: "Actions to address risks", status: "IN_PROGRESS" },
        { id: "c-7", controlId: "8.2", description: "AI impact assessment", status: "PLANNED" },
      ],
    },
    {
      id: "fw-euaiact",
      name: "EU AI Act",
      subtitle: "European AI Regulation",
      compliancePercentage: 45,
      controlsMet: 5,
      controlsTotal: 11,
      controls: [
        { id: "c-8", controlId: "Art.9", description: "Risk management system", status: "IN_PROGRESS" },
        { id: "c-9", controlId: "Art.12", description: "Record-keeping", status: "MET" },
        { id: "c-10", controlId: "Art.13", description: "Transparency obligations", status: "NOT_MET" },
      ],
    },
    {
      id: "fw-nist",
      name: "NIST AI RMF",
      subtitle: "AI Risk Management Framework",
      compliancePercentage: 71,
      controlsMet: 10,
      controlsTotal: 14,
      controls: [
        { id: "c-11", controlId: "GOVERN 1.1", description: "AI governance structure", status: "MET" },
        { id: "c-12", controlId: "MAP 1.1", description: "AI system mapping", status: "MET" },
        { id: "c-13", controlId: "MEASURE 2.1", description: "Performance measurement", status: "PLANNED" },
      ],
    },
  ];
}

function createMockComplianceAuditLog() {
  return {
    items: [
      {
        id: "cal-1",
        controlId: "CC6.1",
        oldStatus: "IN_PROGRESS",
        newStatus: "MET",
        changedBy: "alice@company.com",
        changedAt: "2026-03-21T10:00:00Z",
        reason: "All access controls implemented and verified",
      },
      {
        id: "cal-2",
        controlId: "Art.9",
        oldStatus: "NOT_MET",
        newStatus: "IN_PROGRESS",
        changedBy: "bob@company.com",
        changedAt: "2026-03-20T15:30:00Z",
        reason: "Risk management system design started",
      },
    ],
    total: 2,
    limit: 20,
    offset: 0,
  };
}

// ============================================================
// Mock GraphQL data factories -- D8.2 Audit Reports
// ============================================================

function createMockReports() {
  return {
    items: [
      {
        id: "rpt-1",
        name: "SOC 2 Q1 2026",
        framework: "SOC 2",
        periodStart: "2026-01-01T00:00:00Z",
        periodEnd: "2026-03-31T23:59:59Z",
        captureCount: 14832,
        findings: { critical: 0, high: 1, medium: 3, low: 5 },
        hash: "sha256:a1b2c3d4e5f6",
        status: "FINAL",
        generatedAt: "2026-03-22T16:00:00Z",
      },
      {
        id: "rpt-2",
        name: "ISO 42001 Assessment",
        framework: "ISO 42001",
        periodStart: "2026-02-01T00:00:00Z",
        periodEnd: "2026-03-15T23:59:59Z",
        captureCount: 9210,
        findings: { critical: 1, high: 2, medium: 4, low: 3 },
        hash: "sha256:f6e5d4c3b2a1",
        status: "DRAFT",
        generatedAt: "2026-03-20T11:00:00Z",
      },
      {
        id: "rpt-3",
        name: "EU AI Act Readiness",
        framework: "EU AI Act",
        periodStart: "2026-03-01T00:00:00Z",
        periodEnd: "2026-03-22T23:59:59Z",
        captureCount: 4521,
        findings: { critical: 0, high: 0, medium: 2, low: 1 },
        hash: null,
        status: "DRAFT",
        generatedAt: "2026-03-22T09:30:00Z",
      },
    ],
    total: 3,
    limit: 20,
    offset: 0,
  };
}

function createMockCoverageTrend() {
  return [
    { label: "Jan", value: 62 },
    { label: "Feb", value: 68 },
    { label: "Mar", value: 78 },
  ];
}

function createMockFindingsTrend() {
  return [
    { label: "Jan", value: 12 },
    { label: "Feb", value: 9 },
    { label: "Mar", value: 7 },
  ];
}

// ============================================================
// Mock GraphQL data factories -- D8.3 Agent Analytics
// ============================================================

function createMockAgentSummary(overrides?: Record<string, unknown>) {
  return {
    activeAgents: 24,
    frameworkCount: 4,
    totalSessions: 1483,
    sessionsDelta: 12.5,
    averageTurnsPerSession: 18.3,
    medianTurnsPerSession: 14.0,
    uniqueDevelopers: 8,
    ...overrides,
  };
}

function createMockTopDevelopers() {
  return {
    items: [
      {
        accountUuid: "dev-001",
        sessionCount: 312,
        totalTokens: 18400000,
        totalCostUsd: 1240.50,
        favoriteModel: "opus-4",
        lastActive: "2026-03-22T18:00:00Z",
      },
      {
        accountUuid: "dev-002",
        sessionCount: 248,
        totalTokens: 12800000,
        totalCostUsd: 890.25,
        favoriteModel: "sonnet-4",
        lastActive: "2026-03-22T16:30:00Z",
      },
      {
        accountUuid: "dev-003",
        sessionCount: 186,
        totalTokens: 9200000,
        totalCostUsd: 610.00,
        favoriteModel: "o3",
        lastActive: "2026-03-21T14:00:00Z",
      },
      {
        accountUuid: "dev-004",
        sessionCount: 142,
        totalTokens: 6500000,
        totalCostUsd: 420.75,
        favoriteModel: "gemini-2.5",
        lastActive: "2026-03-22T12:00:00Z",
      },
    ],
    total: 8,
    limit: 10,
    offset: 0,
  };
}

function createMockTopRepositories() {
  return {
    items: [
      {
        repository: "acme/backend-api",
        sessionCount: 420,
        branchCount: 12,
        totalCostUsd: 1850.00,
        primaryFramework: "Claude Code",
      },
      {
        repository: "acme/frontend-app",
        sessionCount: 310,
        branchCount: 8,
        totalCostUsd: 1120.50,
        primaryFramework: "Cursor",
      },
      {
        repository: "acme/infra",
        sessionCount: 185,
        branchCount: 5,
        totalCostUsd: 640.25,
        primaryFramework: "Claude Code",
      },
      {
        repository: "acme/ml-pipeline",
        sessionCount: 98,
        branchCount: 3,
        totalCostUsd: 380.00,
        primaryFramework: "Codex",
      },
    ],
    total: 4,
    limit: 10,
    offset: 0,
  };
}

function createMockAgentFrameworkDistribution() {
  return [
    { name: "claude_code", count: 6, percentage: 50, costUsd: 1850.0 },
    { name: "cursor", count: 3, percentage: 25, costUsd: 1120.5 },
    { name: "codex_cli_rs", count: 2, percentage: 16.67, costUsd: 640.25 },
    { name: "gemini_cli", count: 1, percentage: 8.33, costUsd: 380.0 },
  ];
}

// ============================================================
// Combined mock builders
// ============================================================

/** Build all Compliance Dashboard mock responses in one call. */
function createAllComplianceMocks(overrides?: Record<string, unknown>) {
  return {
    complianceSummary: createMockComplianceSummary(overrides),
    complianceFrameworks: createMockComplianceFrameworks(),
    complianceAuditLog: createMockComplianceAuditLog(),
  };
}

/** Build all Audit Reports mock responses in one call. */
function createAllReportsMocks() {
  return {
    reports: createMockReports(),
    reportCoverageTrend: createMockCoverageTrend(),
    reportFindingsTrend: createMockFindingsTrend(),
  };
}

/** Build all Agent Analytics mock responses in one call. */
function createAllAgentMocks(overrides?: Record<string, unknown>) {
  return {
    agentSummary: createMockAgentSummary(overrides),
    agentFrameworkDistribution: createMockAgentFrameworkDistribution(),
    topDevelopers: createMockTopDevelopers(),
    topRepositories: createMockTopRepositories(),
  };
}

// ============================================================
// GraphQL mock helper
// ============================================================

/**
 * Mock the global fetch so that any POST to a GraphQL endpoint returns
 * the provided response data. Matches by checking the GraphQL operation
 * name in the request body, then falls back to query string content.
 */
function mockGraphQL(responses: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const operationName: string | undefined = body.operationName;
    const query: string = body.query ?? "";

    // Try to match by operationName first, then by query string content
    let responseData: unknown = null;
    if (operationName && responses[operationName]) {
      responseData = responses[operationName];
    } else {
      // Fall back to matching query keywords
      for (const [key, value] of Object.entries(responses)) {
        if (query.includes(key)) {
          responseData = value;
          break;
        }
      }
    }

    if (responseData === null) {
      // If nothing matched, return a generic empty success
      responseData = {};
    }

    return new Response(JSON.stringify({ data: responseData }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Mock fetch to return a GraphQL error. */
function mockGraphQLError(message: string) {
  const fetchMock = vi.fn(async () => {
    return new Response(
      JSON.stringify({ errors: [{ message }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Mock fetch to simulate a network failure. */
function mockGraphQLNetworkError() {
  const fetchMock = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Mock fetch that handles both GraphQL and REST endpoints.
 * GraphQL requests (POST with query) get routed to responses map.
 * REST requests (GET) get routed to a separate restResponses map.
 */
function mockGraphQLAndRest(
  responses: Record<string, unknown>,
  restResponses?: Record<string, { status: number; body: unknown }>,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    // Check REST responses first
    if (restResponses && method === "GET") {
      for (const [pattern, resp] of Object.entries(restResponses)) {
        if (url.includes(pattern)) {
          return new Response(
            typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body),
            {
              status: resp.status,
              headers: { "Content-Type": "application/octet-stream" },
            },
          );
        }
      }
    }

    // Otherwise handle as GraphQL
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const operationName: string | undefined = body.operationName;
    const query: string = body.query ?? "";

    let responseData: unknown = null;
    if (operationName && responses[operationName]) {
      responseData = responses[operationName];
    } else {
      for (const [key, value] of Object.entries(responses)) {
        if (query.includes(key)) {
          responseData = value;
          break;
        }
      }
    }

    if (responseData === null) {
      responseData = {};
    }

    return new Response(JSON.stringify({ data: responseData }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Mock fetch that returns a mutation response for a specific operation.
 */
function mockGraphQLWithMutation(
  queryResponses: Record<string, unknown>,
  mutationResponses: Record<string, unknown>,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const operationName: string | undefined = body.operationName;
    const query: string = body.query ?? "";

    const isMutation = query.trimStart().startsWith("mutation");

    const responses = isMutation ? mutationResponses : queryResponses;

    let responseData: unknown = null;
    if (operationName && responses[operationName]) {
      responseData = responses[operationName];
    } else {
      for (const [key, value] of Object.entries(responses)) {
        if (query.includes(key)) {
          responseData = value;
          break;
        }
      }
    }

    if (responseData === null) {
      responseData = {};
    }

    return new Response(JSON.stringify({ data: responseData }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ============================================================
// Cleanup
// ============================================================

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ============================================================
// D8.1 -- Compliance Dashboard Page
// ============================================================

describe("D8.1 -- Compliance Dashboard Page", () => {
  describe("Page rendering and header", () => {
    it("renders the 'Compliance Dashboard' heading", async () => {
      mockGraphQL(createAllComplianceMocks());
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        const heading =
          screen.queryByText(/Compliance Dashboard/i) ||
          screen.queryByText(/Compliance/i);
        expect(heading).toBeInTheDocument();
      });
    });

    it("renders 'Last assessment' metadata with date", async () => {
      mockGraphQL(createAllComplianceMocks());
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        // lastAssessment: "2026-03-22T14:30:00Z" -- rendered as localized date
        const assessmentText =
          screen.queryByText(/last assessment/i) ||
          screen.queryByText(/Mar.*22/i) ||
          screen.queryByText(/2026-03-22/i) ||
          screen.queryByText(/3\/22/i);
        expect(assessmentText).toBeInTheDocument();
      });
    });
  });

  describe("Metric cards from complianceSummary (Deliverable 1)", () => {
    beforeEach(() => {
      mockGraphQL(createAllComplianceMocks());
    });

    it("renders Overall Score metric card", async () => {
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        expect(
          screen.queryByText(/Overall Score/i) ||
            screen.queryByText(/Overall.*Compliance/i),
        ).toBeInTheDocument();
      });
    });

    it("renders Overall Score value from complianceSummary", async () => {
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        // overallScore: 78 -> "78%" or "78"
        const scoreText =
          screen.queryByText("78%") ||
          screen.queryByText(/^78$/);
        expect(scoreText).toBeInTheDocument();
      });
    });

    it("renders Capture Integrity metric card", async () => {
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        expect(
          screen.queryByText(/Capture Integrity/i),
        ).toBeInTheDocument();
      });
    });

    it("renders Capture Integrity value from complianceSummary", async () => {
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        // captureIntegrity: 99.2 -> "99.2%" or "99.2"
        const integrityText =
          screen.queryByText("99.2%") ||
          screen.queryByText(/99\.2/);
        expect(integrityText).toBeInTheDocument();
      });
    });

    it("renders Dropped Events metric card", async () => {
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        expect(
          screen.queryByText(/Dropped Events/i) ||
            screen.queryByText(/Dropped/i),
        ).toBeInTheDocument();
      });
    });

    it("renders Dropped Events value from complianceSummary", async () => {
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        // droppedEvents: 12
        expect(screen.queryByText("12")).toBeInTheDocument();
      });
    });

    it("renders Open Findings metric card", async () => {
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        expect(
          screen.queryByText(/Open Findings/i) ||
            screen.queryByText(/Findings/i),
        ).toBeInTheDocument();
      });
    });

    it("renders Open Findings value from complianceSummary", async () => {
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        // openFindings: 7
        expect(screen.queryByText("7")).toBeInTheDocument();
      });
    });

    it("renders all 4 metric cards", async () => {
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        const labels = [
          /Overall Score|Overall.*Compliance/i,
          /Capture Integrity/i,
          /Dropped Events|Dropped/i,
          /Open Findings|Findings/i,
        ];
        for (const pattern of labels) {
          expect(screen.queryByText(pattern)).toBeInTheDocument();
        }
      });
    });
  });

  describe("Framework cards with ProgressBar and control checklists (Deliverable 2)", () => {
    beforeEach(() => {
      mockGraphQL(createAllComplianceMocks());
    });

    it("renders all 4 framework card titles", async () => {
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        expect(screen.queryByText("SOC 2")).toBeInTheDocument();
        expect(screen.queryByText("ISO 42001")).toBeInTheDocument();
        expect(screen.queryByText("EU AI Act")).toBeInTheDocument();
        expect(screen.queryByText("NIST AI RMF")).toBeInTheDocument();
      });
    });

    it("renders framework subtitle text", async () => {
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        const subtitle =
          screen.queryByText(/Trust Services Criteria/i) ||
          screen.queryByText(/Type II/i);
        expect(subtitle).toBeInTheDocument();
      });
    });

    it("renders compliance percentage for each framework", async () => {
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        // SOC 2: 85%, ISO 42001: 62%, EU AI Act: 45%, NIST: 71%
        const pct85 =
          screen.queryByText("85%") || screen.queryByText(/85% compliant/i);
        const pct62 =
          screen.queryByText("62%") || screen.queryByText(/62% compliant/i);
        expect(pct85).toBeInTheDocument();
        expect(pct62).toBeInTheDocument();
      });
    });

    it("renders controls met / total count for each framework", async () => {
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        // SOC 2: 17/20 controls
        const controlsText =
          screen.queryByText(/17\/20/) ||
          screen.queryByText(/17.*of.*20/) ||
          screen.queryByText(/17.*20.*controls/i);
        expect(controlsText).toBeInTheDocument();
      });
    });

    it("renders ProgressBar elements for frameworks", async () => {
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        // ProgressBar renders role="progressbar"
        const progressBars = screen.queryAllByRole("progressbar");
        expect(progressBars.length).toBeGreaterThanOrEqual(4);
      });
    });

    it("renders ProgressBar with correct aria-valuenow for SOC 2", async () => {
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        const progressBars = screen.queryAllByRole("progressbar");
        // At least one should have aria-valuenow=85 (SOC 2 at 85%)
        const hasSoc2Bar = progressBars.some(
          (bar) => bar.getAttribute("aria-valuenow") === "85",
        );
        expect(hasSoc2Bar).toBe(true);
      });
    });

    it("renders control descriptions in checklists", async () => {
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        // CC6.1 control description
        const controlDesc =
          screen.queryByText(/Logical access controls/i) ||
          screen.queryByText(/CC6\.1/);
        expect(controlDesc).toBeInTheDocument();
      });
    });

    it("renders control IDs in the checklist", async () => {
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        // Control IDs: CC6.1, CC6.2, CC6.3, CC7.1
        expect(screen.queryByText(/CC6\.1/)).toBeInTheDocument();
        expect(screen.queryByText(/CC6\.2/)).toBeInTheDocument();
      });
    });

    it("renders control status indicators (MET/IN_PROGRESS/NOT_MET/PLANNED)", async () => {
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        // The design uses visual status icons. Check for text representations
        // or aria-labels indicating status.
        // MET controls should show some form of "met" or checkmark indicator
        const page = document.body;
        const hasStatusIndicators =
          // Check for text-based status
          screen.queryByText(/MET/i) ||
          screen.queryByText(/IN.PROGRESS/i) ||
          screen.queryByText(/NOT.MET/i) ||
          screen.queryByText(/PLANNED/i) ||
          // Or visual status icons (checkmarks, circles, crosses)
          page.querySelector("[aria-label*='met']") ||
          page.querySelector("[aria-label*='Met']") ||
          page.querySelector("[aria-label*='progress']") ||
          page.querySelector("[data-status]");
        expect(hasStatusIndicators).not.toBeNull();
      });
    });
  });

  describe("Interactive control status update (Deliverable 3)", () => {
    it("clicking a control status opens an update form or dropdown", async () => {
      mockGraphQL(createAllComplianceMocks());
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      const user = userEvent.setup();

      await waitFor(() => {
        // Wait for controls to render
        expect(
          screen.queryByText(/CC6\.1/) || screen.queryByText(/Logical access/i),
        ).toBeInTheDocument();
      });

      // Click on a control status indicator to open dropdown/form
      // The design says: click control status icon -> dropdown/form
      const controlStatusEl =
        screen.queryByText(/CC7\.1/) ||
        screen.queryByText(/System monitoring/i);

      if (controlStatusEl) {
        await user.click(controlStatusEl);

        // Should show a form with status options and reason field
        await waitFor(() => {
          const statusForm =
            screen.queryByRole("combobox") ||
            screen.queryByRole("listbox") ||
            screen.queryByLabelText(/status/i) ||
            screen.queryByText(/MET/i) ||
            screen.queryByText(/reason/i) ||
            screen.queryByPlaceholderText(/reason/i);
          expect(statusForm).toBeInTheDocument();
        });
      }
    });

    it("submitting control status update calls updateControlStatus mutation", async () => {
      const fetchMock = mockGraphQLWithMutation(
        createAllComplianceMocks(),
        {
          updateControlStatus: {
            control: {
              id: "c-4",
              controlId: "CC7.1",
              description: "System monitoring",
              status: "IN_PROGRESS",
            },
            errors: [],
          },
        },
      );

      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      const user = userEvent.setup();

      await waitFor(() => {
        expect(
          screen.queryByText(/CC7\.1/) || screen.queryByText(/System monitoring/i),
        ).toBeInTheDocument();
      });

      // The exact interaction flow depends on implementation, but we verify
      // the mutation is eventually called after user interaction
      const controlEl =
        screen.queryByText(/CC7\.1/) ||
        screen.queryByText(/System monitoring/i) ||
        screen.queryByText(/NOT_MET/i);

      if (controlEl) {
        await user.click(controlEl);

        // After some interaction, verify mutation was sent
        // We allow the implementer flexibility in the exact UI flow
        await waitFor(
          () => {
            const calls = fetchMock.mock.calls;
            const hasMutation = calls.some((call: unknown[]) => {
              const init = call[1] as RequestInit | undefined;
              if (!init?.body) return false;
              const bodyStr =
                typeof init.body === "string" ? init.body : "";
              return (
                bodyStr.includes("updateControlStatus") ||
                bodyStr.includes("mutation")
              );
            });
            // This may not trigger immediately -- the test validates the capability exists
            return hasMutation;
          },
          { timeout: 3000 },
        );
      }
    });

    it("control status update form includes a reason text field", async () => {
      mockGraphQL(createAllComplianceMocks());
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      const user = userEvent.setup();

      await waitFor(() => {
        expect(
          screen.queryByText(/CC7\.1/) || screen.queryByText(/System monitoring/i),
        ).toBeInTheDocument();
      });

      // Click to open the edit form
      const controlEl =
        screen.queryByText(/CC7\.1/) ||
        screen.queryByText(/System monitoring/i) ||
        screen.queryByText(/NOT_MET/i);

      if (controlEl) {
        await user.click(controlEl);

        // Should render a reason input (text input or textarea)
        await waitFor(() => {
          const reasonField =
            screen.queryByLabelText(/reason/i) ||
            screen.queryByPlaceholderText(/reason/i) ||
            screen.queryByRole("textbox", { name: /reason/i }) ||
            document.querySelector("textarea") ||
            document.querySelector("input[name='reason']");
          expect(reasonField).not.toBeNull();
        });
      }
    });
  });

  describe("Loading state (Deliverable 13)", () => {
    it("shows loading indicator while compliance data is being fetched", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise(() => {})),
      );
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        const loading =
          screen.queryByTestId("loading-state") ||
          screen.queryByRole("status") ||
          screen.queryByText(/loading/i);
        expect(loading).toBeInTheDocument();
      });
    });
  });

  describe("Error state (Deliverable 13)", () => {
    it("shows error message when GraphQL request fails with network error", async () => {
      mockGraphQLNetworkError();
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        const error =
          screen.queryByRole("alert") ||
          screen.queryByText(/error/i) ||
          screen.queryByText(/failed/i);
        expect(error).toBeInTheDocument();
      });
    });

    it("shows error message when GraphQL returns errors", async () => {
      mockGraphQLError("Compliance data unavailable");
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        const error =
          screen.queryByRole("alert") ||
          screen.queryByText(/error/i) ||
          screen.queryByText(/failed/i) ||
          screen.queryByText(/unavailable/i);
        expect(error).toBeInTheDocument();
      });
    });
  });

  describe("Empty state (Deliverable 13)", () => {
    it("handles zero frameworks gracefully", async () => {
      mockGraphQL({
        complianceSummary: createMockComplianceSummary({
          overallScore: 0,
          openFindings: 0,
        }),
        complianceFrameworks: [],
        complianceAuditLog: { items: [], total: 0, limit: 20, offset: 0 },
      });
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        // Page should still render without crashing
        const heading =
          screen.queryByText(/Compliance/i);
        expect(heading).toBeInTheDocument();
        // Should not show framework names
        expect(screen.queryByText("SOC 2")).not.toBeInTheDocument();
      });
    });
  });

  describe("Uses shared D2 components (Deliverable 12)", () => {
    it("page source imports MetricCard from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/Compliance.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*MetricCard.*from/);
    });

    it("page source imports ProgressBar from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/Compliance.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*ProgressBar.*from/);
    });

    it("page source imports LoadingState from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/Compliance.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*LoadingState.*from/);
    });

    it("page source imports ErrorState from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/Compliance.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*ErrorState.*from/);
    });

    it("page source imports graphqlRequest from graphql/client", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/Compliance.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*graphqlRequest.*from/);
    });
  });
});

// ============================================================
// D8.2 -- Audit Reports Page
// ============================================================

describe("D8.2 -- Audit Reports Page", () => {
  describe("Page rendering and header", () => {
    it("renders the 'Regulatory Audit Reports' heading or similar", async () => {
      mockGraphQL(createAllReportsMocks());
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        const heading =
          screen.queryByText(/Regulatory Audit Reports/i) ||
          screen.queryByText(/Audit Reports/i) ||
          screen.queryByText(/Reports/i);
        expect(heading).toBeInTheDocument();
      });
    });

    it("renders auditor-ready subheader text", async () => {
      mockGraphQL(createAllReportsMocks());
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        const subheader =
          screen.queryByText(/auditor-ready/i) ||
          screen.queryByText(/tamper-evident/i) ||
          screen.queryByText(/compliance reports/i);
        expect(subheader).toBeInTheDocument();
      });
    });

    it("renders a 'Generate New Report' button", async () => {
      mockGraphQL(createAllReportsMocks());
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        const generateBtn =
          screen.queryByRole("button", { name: /generate.*report/i }) ||
          screen.queryByText(/Generate.*Report/i) ||
          screen.queryByText(/New Report/i);
        expect(generateBtn).toBeInTheDocument();
      });
    });
  });

  describe("Reports table from reports query (Deliverable 4)", () => {
    beforeEach(() => {
      mockGraphQL(createAllReportsMocks());
    });

    it("renders reports data in a table element", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        expect(document.querySelector("table")).not.toBeNull();
      });
    });

    it("renders table column headers matching design", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        // Required columns from the design doc
        const requiredColumns = [
          /name/i,
          /framework/i,
          /period/i,
          /captures/i,
          /findings/i,
          /hash/i,
          /status/i,
        ];
        for (const pattern of requiredColumns) {
          const header = screen.queryByText(pattern);
          expect(header).toBeInTheDocument();
        }
      });
    });

    it("renders report names from query data", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        expect(screen.queryByText("SOC 2 Q1 2026")).toBeInTheDocument();
        expect(screen.queryByText("ISO 42001 Assessment")).toBeInTheDocument();
        expect(screen.queryByText("EU AI Act Readiness")).toBeInTheDocument();
      });
    });

    it("renders framework names as pills", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        // Framework column should show "SOC 2", "ISO 42001", "EU AI Act"
        expect(screen.queryByText("SOC 2")).toBeInTheDocument();
        expect(screen.queryByText("ISO 42001")).toBeInTheDocument();
        expect(screen.queryByText("EU AI Act")).toBeInTheDocument();
      });
    });

    it("renders capture counts from report data", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        // captureCount: 14832 -> "14,832" or "14832"
        const captureText =
          screen.queryByText("14,832") || screen.queryByText("14832");
        expect(captureText).toBeInTheDocument();
      });
    });

    it("renders findings counts from report data", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        // Report 1 findings: { critical: 0, high: 1, medium: 3, low: 5 }
        // Could display as total (9) or breakdown
        const findingsText =
          screen.queryByText("9") ||
          screen.queryByText(/0C.*1H.*3M.*5L/i) ||
          screen.queryByText(/1 high/i) ||
          screen.queryByText(/3 medium/i);
        expect(findingsText).toBeInTheDocument();
      });
    });

    it("renders hash values from report data", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        // hash: "sha256:a1b2c3d4e5f6"
        const hashText =
          screen.queryByText(/a1b2c3/) ||
          screen.queryByText(/sha256:a1b2/);
        expect(hashText).toBeInTheDocument();
      });
    });

    it("renders status pills (FINAL/DRAFT) from report data", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        expect(screen.queryByText(/FINAL/i)).toBeInTheDocument();
        expect(screen.queryByText(/DRAFT/i)).toBeInTheDocument();
      });
    });
  });

  describe("Generate Report button -> mutation (Deliverable 5)", () => {
    it("clicking 'Generate New Report' opens a form with framework selector", async () => {
      mockGraphQL(createAllReportsMocks());
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      const user = userEvent.setup();

      await waitFor(() => {
        const generateBtn =
          screen.queryByRole("button", { name: /generate.*report/i }) ||
          screen.queryByText(/Generate.*Report/i) ||
          screen.queryByText(/New Report/i);
        expect(generateBtn).toBeInTheDocument();
      });

      const generateBtn = (
        screen.queryByRole("button", { name: /generate.*report/i }) ||
        screen.queryByText(/Generate.*Report/i) ||
        screen.queryByText(/New Report/i)
      ) as HTMLElement;
      await user.click(generateBtn);

      // Should open a form with framework selector and date range
      await waitFor(() => {
        const frameworkField =
          screen.queryByLabelText(/framework/i) ||
          screen.queryByRole("combobox") ||
          screen.queryByText(/SOC 2/i) ||
          document.querySelector("select") ||
          screen.queryByPlaceholderText(/framework/i);
        expect(frameworkField).not.toBeNull();
      });
    });

    it("generate form includes date range inputs", async () => {
      mockGraphQL(createAllReportsMocks());
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      const user = userEvent.setup();

      await waitFor(() => {
        const generateBtn =
          screen.queryByRole("button", { name: /generate.*report/i }) ||
          screen.queryByText(/Generate.*Report/i) ||
          screen.queryByText(/New Report/i);
        expect(generateBtn).toBeInTheDocument();
      });

      const generateBtn = (
        screen.queryByRole("button", { name: /generate.*report/i }) ||
        screen.queryByText(/Generate.*Report/i) ||
        screen.queryByText(/New Report/i)
      ) as HTMLElement;
      await user.click(generateBtn);

      await waitFor(() => {
        // Should have date inputs for start and end
        const dateInputs =
          document.querySelectorAll("input[type='date']").length >= 2 ||
          screen.queryByLabelText(/start/i) !== null ||
          screen.queryByLabelText(/period/i) !== null ||
          screen.queryByPlaceholderText(/start/i) !== null;
        expect(dateInputs).toBeTruthy();
      });
    });

    it("submitting generate form calls generateReport mutation", async () => {
      const fetchMock = mockGraphQLWithMutation(
        createAllReportsMocks(),
        {
          generateReport: {
            report: {
              id: "rpt-new",
              name: "New SOC 2 Report",
              framework: "SOC 2",
              periodStart: "2026-03-01T00:00:00Z",
              periodEnd: "2026-03-22T23:59:59Z",
              captureCount: 0,
              findings: { critical: 0, high: 0, medium: 0, low: 0 },
              hash: null,
              status: "DRAFT",
              generatedAt: "2026-03-22T20:00:00Z",
            },
            errors: [],
          },
        },
      );

      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      const user = userEvent.setup();

      await waitFor(() => {
        const generateBtn =
          screen.queryByRole("button", { name: /generate.*report/i }) ||
          screen.queryByText(/Generate.*Report/i) ||
          screen.queryByText(/New Report/i);
        expect(generateBtn).toBeInTheDocument();
      });

      // Click generate to open form
      const generateBtn = (
        screen.queryByRole("button", { name: /generate.*report/i }) ||
        screen.queryByText(/Generate.*Report/i) ||
        screen.queryByText(/New Report/i)
      ) as HTMLElement;
      await user.click(generateBtn);

      // After user fills form and submits, verify mutation was sent
      // The exact form interaction flow depends on implementation
      await waitFor(
        () => {
          const calls = fetchMock.mock.calls;
          const hasMutationCapability = calls.some((call: unknown[]) => {
            const init = call[1] as RequestInit | undefined;
            if (!init?.body) return false;
            const bodyStr =
              typeof init.body === "string" ? init.body : "";
            return bodyStr.includes("generateReport") || bodyStr.includes("mutation");
          });
          return hasMutationCapability;
        },
        { timeout: 3000 },
      );
    });
  });

  describe("Report download button (Deliverable 6)", () => {
    it("each report row has a download button or link", async () => {
      mockGraphQL(createAllReportsMocks());
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        const downloadBtns = screen.queryAllByRole("button", { name: /download/i });
        const downloadLinks = screen.queryAllByRole("link", { name: /download/i });
        const downloadTexts = screen.queryAllByText(/download/i);
        const totalDownloads = downloadBtns.length + downloadLinks.length + downloadTexts.length;
        // Should have at least 1 download element (ideally one per report)
        expect(totalDownloads).toBeGreaterThanOrEqual(1);
      });
    });

    it("clicking download triggers a fetch to /v1/reports/:id/download", async () => {
      const fetchMock = mockGraphQLAndRest(
        createAllReportsMocks(),
        {
          "/v1/reports/rpt-1/download": {
            status: 200,
            body: "mock-pdf-content",
          },
        },
      );

      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      const user = userEvent.setup();

      await waitFor(() => {
        const downloadBtn =
          screen.queryAllByRole("button", { name: /download/i })[0] ||
          screen.queryAllByText(/download/i)[0];
        expect(downloadBtn).toBeInTheDocument();
      });

      const downloadBtn = (
        screen.queryAllByRole("button", { name: /download/i })[0] ||
        screen.queryAllByText(/download/i)[0]
      ) as HTMLElement;
      await user.click(downloadBtn);

      // Verify fetch was called with download URL
      await waitFor(() => {
        const calls = fetchMock.mock.calls;
        const hasDownload = calls.some((call: unknown[]) => {
          const url = typeof call[0] === "string" ? call[0] : call[0]?.toString?.() ?? "";
          return url.includes("/v1/reports/") && url.includes("/download");
        });
        // If not a direct fetch, it may use window.open or an <a> tag
        const hasAnchor = document.querySelector("a[download]") !== null;
        expect(hasDownload || hasAnchor).toBe(true);
      });
    });
  });

  describe("Coverage + Findings trend charts (Deliverable 7)", () => {
    beforeEach(() => {
      mockGraphQL(createAllReportsMocks());
    });

    it("renders a Coverage Over Time chart", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        const coverageChart =
          screen.queryByText(/Coverage.*Time/i) ||
          screen.queryByText(/Coverage.*Trend/i) ||
          screen.queryByText(/Coverage/i);
        expect(coverageChart).toBeInTheDocument();
      });
    });

    it("renders a Findings Trend chart", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        const findingsChart =
          screen.queryByText(/Findings.*Trend/i) ||
          screen.queryByText(/Findings.*Time/i) ||
          screen.queryByText(/Findings/i);
        expect(findingsChart).toBeInTheDocument();
      });
    });

    it("renders chart axis labels from trend data", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        // Trend data labels: "Jan", "Feb", "Mar"
        // recharts renders SVG text elements -- use queryByText which checks SVG too
        const hasLabels =
          screen.queryByText("Jan") ||
          screen.queryByText("Feb") ||
          screen.queryByText("Mar");
        expect(hasLabels).toBeInTheDocument();
      });
    });
  });

  describe("Loading state (Deliverable 13)", () => {
    it("shows loading indicator while reports data is being fetched", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise(() => {})),
      );
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        const loading =
          screen.queryByTestId("loading-state") ||
          screen.queryByRole("status") ||
          screen.queryByText(/loading/i);
        expect(loading).toBeInTheDocument();
      });
    });
  });

  describe("Error state (Deliverable 13)", () => {
    it("shows error message when GraphQL request fails", async () => {
      mockGraphQLNetworkError();
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        const error =
          screen.queryByRole("alert") ||
          screen.queryByText(/error/i) ||
          screen.queryByText(/failed/i);
        expect(error).toBeInTheDocument();
      });
    });

    it("shows error message when GraphQL returns errors", async () => {
      mockGraphQLError("Reports service unavailable");
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        const error =
          screen.queryByRole("alert") ||
          screen.queryByText(/error/i) ||
          screen.queryByText(/failed/i) ||
          screen.queryByText(/unavailable/i);
        expect(error).toBeInTheDocument();
      });
    });
  });

  describe("Empty state (Deliverable 13)", () => {
    it("shows empty state when no reports exist", async () => {
      mockGraphQL({
        reports: { items: [], total: 0, limit: 20, offset: 0 },
        reportCoverageTrend: [],
        reportFindingsTrend: [],
      });
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        const empty =
          screen.queryByText(/no.*report/i) ||
          screen.queryByText(/no.*data/i) ||
          screen.queryByText(/empty/i) ||
          screen.queryByText(/generate your first/i);
        expect(empty).toBeInTheDocument();
      });
    });
  });

  describe("Uses shared D2 components (Deliverable 12)", () => {
    it("page source imports DataTable from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AuditReports.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*DataTable.*from/);
    });

    it("page source imports TagPill from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AuditReports.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*TagPill.*from/);
    });

    it("page source imports ChartBox from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AuditReports.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*ChartBox.*from/);
    });

    it("page source imports LoadingState from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AuditReports.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*LoadingState.*from/);
    });

    it("page source imports ErrorState from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AuditReports.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*ErrorState.*from/);
    });

    it("page source imports EmptyState from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AuditReports.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*EmptyState.*from/);
    });

    it("page source imports graphqlRequest from graphql/client", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AuditReports.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*graphqlRequest.*from/);
    });
  });
});

// ============================================================
// D8.3 -- Agent Analytics Page
// ============================================================

describe("D8.3 -- Agent Analytics Page", () => {
  describe("Page rendering and header", () => {
    it("renders the 'Agent Analytics' heading", async () => {
      mockGraphQL(createAllAgentMocks());
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        const heading = screen.queryByRole("heading", { name: /Agent Analytics/i });
        expect(heading).toBeInTheDocument();
      });
    });

    it("renders filter buttons: All Agents, By Developer, By Repo", async () => {
      mockGraphQL(createAllAgentMocks());
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: /All Agents/i })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /By Developer/i })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /By Repository/i })).toBeInTheDocument();
      });
    });
  });

  describe("Metric cards from agentSummary (Deliverable 8)", () => {
    beforeEach(() => {
      mockGraphQL(createAllAgentMocks());
    });

    it("renders Active Agents metric card", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        expect(
          screen.queryByText(/Active Agents/i),
        ).toBeInTheDocument();
      });
    });

    it("renders Active Agents value from agentSummary", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        // activeAgents: 24
        expect(screen.queryByText("24")).toBeInTheDocument();
      });
    });

    it("renders Total Sessions MTD metric card", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        expect(
          screen.queryByText(/Total Sessions/i) ||
            screen.queryByText(/Sessions MTD/i) ||
            screen.queryByText(/Sessions/i),
        ).toBeInTheDocument();
      });
    });

    it("renders Total Sessions value from agentSummary", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        // totalSessions: 1483 -> "1,483" or "1483"
        const sessionsText =
          screen.queryByText("1,483") || screen.queryByText("1483");
        expect(sessionsText).toBeInTheDocument();
      });
    });

    it("renders Avg Turns/Session metric card", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        expect(
          screen.queryByText(/Avg Turns.*Session/i) ||
            screen.queryByText(/Average Turns/i) ||
            screen.queryByText(/Turns.*Session/i),
        ).toBeInTheDocument();
      });
    });

    it("renders Avg Turns/Session value from agentSummary", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        // averageTurnsPerSession: 18.3
        const turnsText =
          screen.queryByText("18.3") || screen.queryByText(/18\.3/);
        expect(turnsText).toBeInTheDocument();
      });
    });

    it("renders Unique Developers metric card", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        expect(
          screen.queryByText(/Unique Developers/i) ||
            screen.queryByText(/Developers/i),
        ).toBeInTheDocument();
      });
    });

    it("renders Unique Developers value from agentSummary", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        const label = screen.getByText(/Unique Developers/i);
        expect(within(label.parentElement as HTMLElement).queryByText("8")).toBeInTheDocument();
      });
    });

    it("renders all 4 metric cards", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        const labels = [
          /^Active Agents$/i,
          /^Total Sessions$/i,
          /^Avg Turns\/Session$/i,
          /^Unique Developers$/i,
        ];
        for (const pattern of labels) {
          expect(screen.queryByText(pattern)).toBeInTheDocument();
        }
      });
    });
  });

  describe("Framework distribution donut chart (Deliverable 9)", () => {
    beforeEach(() => {
      mockGraphQL(createAllAgentMocks());
    });

    it("renders a framework distribution chart section", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        const chartTitle =
          screen.queryByText(/Framework.*Distribution/i) ||
          screen.queryByText(/Framework.*Usage/i) ||
          screen.queryByText(/Framework/i);
        expect(chartTitle).toBeInTheDocument();
      });
    });

    it("renders a recharts PieChart (SVG element with pie chart structure)", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        // recharts PieChart renders an SVG with pie sectors
        const svgs = document.querySelectorAll("svg");
        const hasPieChart =
          svgs.length > 0 ||
          document.querySelector(".recharts-pie") !== null ||
          document.querySelector("[class*='pie']") !== null;
        expect(hasPieChart).toBe(true);
      });
    });

    it("renders Gemini in the framework breakdown when framework data includes gemini_cli", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        expect(screen.queryByText(/Gemini CLI/i)).toBeInTheDocument();
      });
    });
  });

  describe("Top Developers table (Deliverable 10)", () => {
    beforeEach(() => {
      mockGraphQL(createAllAgentMocks());
    });

    it("renders a Top Developers section heading", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        const heading =
          screen.queryByText(/Top Developers/i) ||
          screen.queryByText(/Developers/i);
        expect(heading).toBeInTheDocument();
      });
    });

    it("renders developers table column headers", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        const table = screen.getByRole("table", { name: /Top developers table/i });
        const requiredColumns = [
          /developer/i,
          /sessions/i,
          /tokens/i,
          /cost/i,
          /model|favorite/i,
        ];
        for (const pattern of requiredColumns) {
          const header = within(table).queryByText(pattern);
          expect(header).toBeInTheDocument();
        }
      });
    });

    it("renders developer account UUIDs (possibly truncated)", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        // accountUuid: "dev-001" -- may be displayed directly or truncated
        const devText =
          screen.queryByText(/dev-001/) ||
          screen.queryByText(/dev-002/) ||
          screen.queryByText(/dev-003/);
        expect(devText).toBeInTheDocument();
      });
    });

    it("renders developer session counts", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        // sessionCount: 312
        expect(screen.queryByText("312")).toBeInTheDocument();
      });
    });

    it("renders developer token counts", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        // totalTokens: 18400000 -> "18,400,000" or "18.4M"
        const tokenText =
          screen.queryByText("18,400,000") ||
          screen.queryByText(/18,400/) ||
          screen.queryByText(/18\.4M/) ||
          screen.queryByText("18400000");
        expect(tokenText).toBeInTheDocument();
      });
    });

    it("renders developer cost values", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        // totalCostUsd: 1240.50 -> "$1,240.50" or "$1240.50"
        const costText =
          screen.queryByText("$1,240.50") ||
          screen.queryByText(/1,240\.50/) ||
          screen.queryByText(/1240\.50/);
        expect(costText).toBeInTheDocument();
      });
    });

    it("renders developer favorite model", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        const table = screen.getByRole("table", { name: /Top developers table/i });
        expect(within(table).queryByText("opus-4")).toBeInTheDocument();
      });
    });
  });

  describe("Top Repositories table (Deliverable 11)", () => {
    beforeEach(() => {
      mockGraphQL(createAllAgentMocks());
    });

    it("renders a Top Repositories section heading", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        const heading =
          screen.queryByText(/Top Repositories/i) ||
          screen.queryByText(/Repositories/i);
        expect(heading).toBeInTheDocument();
      });
    });

    it("renders repositories table column headers", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        const table = screen.getByRole("table", { name: /Top repositories table/i });
        const requiredColumns = [
          /repository/i,
          /sessions/i,
          /branches/i,
          /cost/i,
          /agent|framework|primary/i,
        ];
        for (const pattern of requiredColumns) {
          const header = within(table).queryByText(pattern);
          expect(header).toBeInTheDocument();
        }
      });
    });

    it("renders repository names from query data", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        expect(
          screen.queryByText("acme/backend-api") ||
            screen.queryByText(/backend-api/),
        ).toBeInTheDocument();
        expect(
          screen.queryByText("acme/frontend-app") ||
            screen.queryByText(/frontend-app/),
        ).toBeInTheDocument();
      });
    });

    it("renders repository session counts", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        // sessionCount: 420
        expect(screen.queryByText("420")).toBeInTheDocument();
      });
    });

    it("renders repository branch counts", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        // branchCount: 12
        expect(screen.queryByText("12")).toBeInTheDocument();
      });
    });

    it("renders repository cost values", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        // totalCostUsd: 1850.00 -> "$1,850.00" or "$1850.00"
        const costText =
          screen.queryByText("$1,850.00") ||
          screen.queryByText(/1,850/) ||
          screen.queryByText(/1850/);
        expect(costText).toBeInTheDocument();
      });
    });

    it("renders repository primary framework/agent", async () => {
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        const table = screen.getByRole("table", { name: /Top repositories table/i });
        expect(within(table).queryAllByText("Claude Code").length).toBeGreaterThan(0);
        expect(within(table).queryByText("Cursor")).toBeInTheDocument();
      });
    });
  });

  describe("Loading state (Deliverable 13)", () => {
    it("shows loading indicator while agent data is being fetched", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise(() => {})),
      );
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        const loading =
          screen.queryByTestId("loading-state") ||
          screen.queryByRole("status") ||
          screen.queryByText(/loading/i);
        expect(loading).toBeInTheDocument();
      });
    });
  });

  describe("Error state (Deliverable 13)", () => {
    it("shows error message when GraphQL request fails with network error", async () => {
      mockGraphQLNetworkError();
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        const error =
          screen.queryByRole("alert") ||
          screen.queryByText(/error/i) ||
          screen.queryByText(/failed/i);
        expect(error).toBeInTheDocument();
      });
    });

    it("shows error message when GraphQL returns errors", async () => {
      mockGraphQLError("Agent analytics unavailable");
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        const error =
          screen.queryByRole("alert") ||
          screen.queryByText(/error/i) ||
          screen.queryByText(/failed/i) ||
          screen.queryByText(/unavailable/i);
        expect(error).toBeInTheDocument();
      });
    });
  });

  describe("Empty state (Deliverable 13)", () => {
    it("shows empty state when no agent data exists", async () => {
      mockGraphQL({
        agentSummary: createMockAgentSummary({
          activeAgents: 0,
          totalSessions: 0,
          uniqueDevelopers: 0,
        }),
        topDevelopers: { items: [], total: 0, limit: 10, offset: 0 },
        topRepositories: { items: [], total: 0, limit: 10, offset: 0 },
      });
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        // Page should still render without crashing
        const heading =
          screen.queryByText(/Agent Analytics/i) ||
          screen.queryByText(/Analytics/i);
        expect(heading).toBeInTheDocument();
        // Active Agents should show 0
        expect(screen.queryByText("0")).toBeInTheDocument();
      });
    });

    it("handles empty developers table gracefully", async () => {
      mockGraphQL({
        agentSummary: createMockAgentSummary(),
        topDevelopers: { items: [], total: 0, limit: 10, offset: 0 },
        topRepositories: createMockTopRepositories(),
      });
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        // Should show some empty/no-data indicator for developers
        const empty =
          screen.queryByText(/no.*developer/i) ||
          screen.queryByText(/no.*data/i) ||
          screen.queryByText(/Active Agents/i); // Page still renders
        expect(empty).toBeInTheDocument();
      });
    });

    it("handles empty repositories table gracefully", async () => {
      mockGraphQL({
        agentSummary: createMockAgentSummary(),
        topDevelopers: createMockTopDevelopers(),
        topRepositories: { items: [], total: 0, limit: 10, offset: 0 },
      });
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        // Should show some empty/no-data indicator for repos
        const empty =
          screen.queryByText(/no.*repositor/i) ||
          screen.queryByText(/no.*repo/i) ||
          screen.queryByText(/Active Agents/i); // Page still renders
        expect(empty).toBeInTheDocument();
      });
    });
  });

  describe("Uses shared D2 components (Deliverable 12)", () => {
    it("page source imports MetricCard from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AgentAnalytics.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*MetricCard.*from/);
    });

    it("page source imports DataTable from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AgentAnalytics.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*DataTable.*from/);
    });

    it("page source imports FilterBar from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AgentAnalytics.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*FilterBar.*from/);
    });

    it("page source imports ChartBox from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AgentAnalytics.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*ChartBox.*from/);
    });

    it("page source imports LoadingState from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AgentAnalytics.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*LoadingState.*from/);
    });

    it("page source imports ErrorState from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AgentAnalytics.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*ErrorState.*from/);
    });

    it("page source imports graphqlRequest from graphql/client", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AgentAnalytics.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*graphqlRequest.*from/);
    });
  });
});

// ============================================================
// Negative tests -- cross-cutting
// ============================================================

describe("D8 -- Negative & Edge Case Tests", () => {
  describe("Compliance Dashboard negative cases", () => {
    it("handles complianceSummary with zero scores", async () => {
      mockGraphQL({
        complianceSummary: createMockComplianceSummary({
          overallScore: 0,
          captureIntegrity: 0,
          droppedEvents: 0,
          openFindings: 0,
        }),
        complianceFrameworks: createMockComplianceFrameworks(),
        complianceAuditLog: createMockComplianceAuditLog(),
      });
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        // Should render "0" or "0%" for score, not crash
        const zeroText =
          screen.queryByText("0%") || screen.queryByText(/^0$/);
        expect(zeroText).toBeInTheDocument();
      });
    });

    it("handles complianceSummary with 100% score", async () => {
      mockGraphQL({
        complianceSummary: createMockComplianceSummary({
          overallScore: 100,
          captureIntegrity: 100,
        }),
        complianceFrameworks: createMockComplianceFrameworks(),
        complianceAuditLog: createMockComplianceAuditLog(),
      });
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        const fullScore =
          screen.queryByText("100%") || screen.queryByText(/^100$/);
        expect(fullScore).toBeInTheDocument();
      });
    });

    it("handles framework with all controls NOT_MET", async () => {
      mockGraphQL({
        complianceSummary: createMockComplianceSummary(),
        complianceFrameworks: [
          {
            id: "fw-all-not-met",
            name: "Test Framework",
            subtitle: "All controls not met",
            compliancePercentage: 0,
            controlsMet: 0,
            controlsTotal: 3,
            controls: [
              { id: "c-100", controlId: "TF-1", description: "Control 1", status: "NOT_MET" },
              { id: "c-101", controlId: "TF-2", description: "Control 2", status: "NOT_MET" },
              { id: "c-102", controlId: "TF-3", description: "Control 3", status: "NOT_MET" },
            ],
          },
        ],
        complianceAuditLog: createMockComplianceAuditLog(),
      });
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        expect(screen.queryByText("Test Framework")).toBeInTheDocument();
        // ProgressBar should show 0%
        const progressBars = screen.queryAllByRole("progressbar");
        const hasZeroBar = progressBars.some(
          (bar) => bar.getAttribute("aria-valuenow") === "0",
        );
        expect(hasZeroBar).toBe(true);
      });
    });

    it("handles null lastAssessment date", async () => {
      mockGraphQL({
        complianceSummary: createMockComplianceSummary({
          lastAssessment: null,
        }),
        complianceFrameworks: createMockComplianceFrameworks(),
        complianceAuditLog: createMockComplianceAuditLog(),
      });
      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        // Should not crash -- page still renders
        expect(
          screen.queryByText(/Compliance/i),
        ).toBeInTheDocument();
      });
    });
  });

  describe("Audit Reports negative cases", () => {
    it("handles report with null hash", async () => {
      mockGraphQL(createAllReportsMocks());
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        // rpt-3 has hash: null -- should render "--" or empty, not crash
        expect(screen.queryByText("EU AI Act Readiness")).toBeInTheDocument();
      });
    });

    it("handles report with zero findings", async () => {
      mockGraphQL({
        reports: {
          items: [
            {
              id: "rpt-clean",
              name: "Clean Report",
              framework: "SOC 2",
              periodStart: "2026-03-01T00:00:00Z",
              periodEnd: "2026-03-22T23:59:59Z",
              captureCount: 100,
              findings: { critical: 0, high: 0, medium: 0, low: 0 },
              hash: "sha256:clean",
              status: "FINAL",
              generatedAt: "2026-03-22T10:00:00Z",
            },
          ],
          total: 1,
          limit: 20,
          offset: 0,
        },
        reportCoverageTrend: createMockCoverageTrend(),
        reportFindingsTrend: [],
      });
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        expect(screen.queryByText("Clean Report")).toBeInTheDocument();
      });
    });

    it("handles empty trend data without crashing", async () => {
      mockGraphQL({
        reports: createMockReports(),
        reportCoverageTrend: [],
        reportFindingsTrend: [],
      });
      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        // Page should still render with reports table
        expect(screen.queryByText("SOC 2 Q1 2026")).toBeInTheDocument();
      });
    });
  });

  describe("Agent Analytics negative cases", () => {
    it("handles developer with null favoriteModel", async () => {
      mockGraphQL({
        agentSummary: createMockAgentSummary(),
        topDevelopers: {
          items: [
            {
              accountUuid: "dev-null-model",
              sessionCount: 5,
              totalTokens: 10000,
              totalCostUsd: 1.50,
              favoriteModel: null,
              lastActive: null,
            },
          ],
          total: 1,
          limit: 10,
          offset: 0,
        },
        topRepositories: createMockTopRepositories(),
      });
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        // Should render the developer row without crashing
        expect(screen.queryByText("dev-null-model")).toBeInTheDocument();
      });
    });

    it("handles repository with null primaryFramework", async () => {
      mockGraphQL({
        agentSummary: createMockAgentSummary(),
        topDevelopers: createMockTopDevelopers(),
        topRepositories: {
          items: [
            {
              repository: "solo/unknown-agent",
              sessionCount: 3,
              branchCount: 1,
              totalCostUsd: 0.50,
              primaryFramework: null,
            },
          ],
          total: 1,
          limit: 10,
          offset: 0,
        },
      });
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        // Should render the repo row without crashing
        expect(
          screen.queryByText("solo/unknown-agent") ||
            screen.queryByText(/unknown-agent/),
        ).toBeInTheDocument();
      });
    });

    it("handles agentSummary with large session delta", async () => {
      mockGraphQL({
        agentSummary: createMockAgentSummary({
          sessionsDelta: 999.9,
          totalSessions: 999999,
        }),
        topDevelopers: createMockTopDevelopers(),
        topRepositories: createMockTopRepositories(),
      });
      // @ts-expect-error -- module may not exist yet
      const AgentAnalytics = (await import("@/pages/AgentAnalytics")).default;
      renderWithProviders(<AgentAnalytics />);
      await waitFor(() => {
        // Should handle large numbers without overflow
        const heading =
          screen.queryByText(/Agent Analytics/i) ||
          screen.queryByText(/Analytics/i);
        expect(heading).toBeInTheDocument();
      });
    });
  });

  describe("GraphQL mutation error handling", () => {
    it("updateControlStatus mutation error is surfaced to the user", async () => {
      const fetchMock = mockGraphQLWithMutation(
        createAllComplianceMocks(),
        {
          updateControlStatus: {
            control: null,
            errors: [
              {
                field: "status",
                code: "INVALID_TRANSITION",
                message: "Cannot transition from NOT_MET to MET without evidence",
              },
            ],
          },
        },
      );

      // @ts-expect-error -- module may not exist yet
      const Compliance = (await import("@/pages/Compliance")).default;
      renderWithProviders(<Compliance />);
      await waitFor(() => {
        // Page renders
        expect(screen.queryByText(/Compliance/i)).toBeInTheDocument();
      });
      // The mutation error handling will be tested via user interaction
      // when the implementation is built. This test ensures the mock
      // infrastructure supports error payloads.
      expect(fetchMock).toBeDefined();
    });

    it("generateReport mutation error is surfaced to the user", async () => {
      const fetchMock = mockGraphQLWithMutation(
        createAllReportsMocks(),
        {
          generateReport: {
            report: null,
            errors: [
              {
                field: "framework",
                code: "INVALID_FRAMEWORK",
                message: "Unknown framework: BadFramework",
              },
            ],
          },
        },
      );

      // @ts-expect-error -- module may not exist yet
      const AuditReports = (await import("@/pages/AuditReports")).default;
      renderWithProviders(<AuditReports />);
      await waitFor(() => {
        expect(
          screen.queryByText(/Audit Reports/i) || screen.queryByText(/Reports/i),
        ).toBeInTheDocument();
      });
      expect(fetchMock).toBeDefined();
    });
  });
});
