/**
 * Sprint D7 -- Behavioral Tests: Audit Trail + Cost & Usage Pages
 *
 * Tests for:
 *   D7.1  Audit Trail page (table, search, type filter, pagination, export CSV, integrity pills)
 *   D7.2  Cost & Usage page (metric cards, spend bars, daily chart, projections, time range)
 *
 * These tests are written BEFORE implementation exists.
 * They verify the design document deliverables, not implementation internals.
 *
 * GraphQL responses are mocked -- no running API server required.
 * Every test verifies that pages USE shared D2 components (MetricCard, DataTable,
 * CostBar, TagPill, FilterBar, SearchInput, Pagination, TwoColumnLayout, ChartBox, etc.)
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
// Mock GraphQL data factories
// ============================================================

function createMockAuditEntry(overrides?: Record<string, unknown>) {
  return {
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
    ...overrides,
  };
}

function createMockAuditConnection(
  items?: unknown[],
  total?: number,
) {
  const entries = items ?? [
    createMockAuditEntry(),
    createMockAuditEntry({
      timestamp: "2026-03-20T18:41:58Z",
      sessionId: "c1d4e8a290",
      sequenceNum: 22,
      provider: "OpenAI",
      model: "o3",
      requestHash: "sha256:a1b2c3d4e5f6",
      responseHash: "sha256:9e8f7a6b5c4d",
      totalTokens: 8204,
      integrityStatus: "verified",
    }),
    createMockAuditEntry({
      timestamp: "2026-03-20T18:41:51Z",
      sessionId: "d9f3b27c61",
      sequenceNum: 8,
      provider: "Anthropic",
      model: "sonnet-4",
      requestHash: "sha256:f5e6d7c8b9a0",
      responseHash: "sha256:1a2b3c4d5e6f",
      totalTokens: 4512,
      integrityStatus: "verified",
    }),
    createMockAuditEntry({
      timestamp: "2026-03-20T18:41:44Z",
      sessionId: "e2a7c53b48",
      sequenceNum: 15,
      provider: "Gemini",
      model: "gemini-2.5",
      requestHash: "sha256:b4c5d6e7f8a9",
      responseHash: "sha256:2d3e4f5a6b7c",
      totalTokens: 6339,
      integrityStatus: "verified",
    }),
    createMockAuditEntry({
      timestamp: "2026-03-20T18:41:15Z",
      sessionId: "a3f8c1d42e",
      sequenceNum: 33,
      provider: "Anthropic",
      model: "opus-4",
      requestHash: "sha256:d2e3f4a5b6c7",
      responseHash: null,
      totalTokens: 2891,
      integrityStatus: "retry",
      httpStatus: 429,
      captureComplete: false,
    }),
    createMockAuditEntry({
      timestamp: "2026-03-20T18:40:50Z",
      sessionId: "f4b8d19e27",
      sequenceNum: 5,
      provider: "OpenAI",
      model: "gpt-4.1",
      requestHash: "sha256:c8d9e0f1a2b3",
      responseHash: "sha256:3f4a5b6c7d8e",
      totalTokens: 15102,
      integrityStatus: "failed",
      httpStatus: 500,
      captureComplete: false,
    }),
  ];
  return {
    items: entries,
    total: total ?? entries.length,
    limit: 20,
    offset: 0,
  };
}

function createMockUsageSummary(overrides?: Record<string, unknown>) {
  return {
    totalCostUsd: 4218.0,
    projectedMonthlyCostUsd: 6800.0,
    totalTokens: 48200000,
    cacheReadTokens: 18100000,
    cacheReadPercentage: 37.0,
    averageCostPerSession: 2.84,
    averageCostDelta: -0.25,
    cacheHitRate: 37.0,
    cacheSavingsUsd: 1560.0,
    costPerDeveloperPerDay: 28.12,
    developerCount: 8,
    ...overrides,
  };
}

function createMockSpendByProvider() {
  return [
    { name: "Anthropic", costUsd: 2868.0, percentage: 68.0, count: 1240 },
    { name: "OpenAI", costUsd: 928.0, percentage: 22.0, count: 410 },
    { name: "Gemini", costUsd: 422.0, percentage: 10.0, count: 180 },
  ];
}

function createMockSpendByModel() {
  return [
    { name: "opus-4", costUsd: 2193.0, percentage: 52.0, count: 680 },
    { name: "sonnet-4", costUsd: 759.0, percentage: 18.0, count: 340 },
    { name: "o3", costUsd: 590.0, percentage: 14.0, count: 260 },
    { name: "gpt-4.1", costUsd: 338.0, percentage: 8.0, count: 120 },
    { name: "gemini-2.5", costUsd: 338.0, percentage: 8.0, count: 180 },
  ];
}

function createMockSpendByFramework() {
  return [
    { name: "Claude Code", costUsd: 2446.0, percentage: 58.0, count: 820 },
    { name: "Cursor", costUsd: 1012.0, percentage: 24.0, count: 350 },
    { name: "Codex", costUsd: 506.0, percentage: 12.0, count: 200 },
    { name: "Aider", costUsd: 254.0, percentage: 6.0, count: 160 },
  ];
}

function createMockDailySpend() {
  return [
    { name: "Mar 7", costUsd: 180.0, percentage: 60.0, count: 42 },
    { name: "Mar 8", costUsd: 210.0, percentage: 70.0, count: 48 },
    { name: "Mar 9", costUsd: 45.0, percentage: 15.0, count: 12 },
    { name: "Mar 10", costUsd: 30.0, percentage: 10.0, count: 8 },
    { name: "Mar 11", costUsd: 245.0, percentage: 82.0, count: 56 },
    { name: "Mar 12", costUsd: 198.0, percentage: 66.0, count: 45 },
    { name: "Mar 13", costUsd: 220.0, percentage: 73.0, count: 50 },
  ];
}

function createMockCostProjections() {
  return [
    {
      month: "April 2026",
      projectedSessions: 1820,
      projectedTokens: 74000000,
      projectedCostUsd: 7400.0,
      deltaVsCurrent: 9.0,
      assumptions: "+2 developers, current model mix",
    },
    {
      month: "May 2026",
      projectedSessions: 2100,
      projectedTokens: 88000000,
      projectedCostUsd: 8200.0,
      deltaVsCurrent: 21.0,
      assumptions: "+2 developers, 10% shift to Opus",
    },
    {
      month: "June 2026",
      projectedSessions: 2100,
      projectedTokens: 80000000,
      projectedCostUsd: 7100.0,
      deltaVsCurrent: 5.0,
      assumptions: "Cache optimization, stable team",
    },
  ];
}

/** Build all Cost & Usage mock responses in one call. */
function createAllCostMocks(overrides?: Record<string, unknown>) {
  return {
    usageSummary: createMockUsageSummary(overrides),
    spendByProvider: createMockSpendByProvider(),
    spendByModel: createMockSpendByModel(),
    spendByFramework: createMockSpendByFramework(),
    dailySpend: createMockDailySpend(),
    costProjections: createMockCostProjections(),
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

// ============================================================
// Cleanup
// ============================================================

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ============================================================
// D7.1 -- Audit Trail Page
// ============================================================

describe("D7.1 -- Audit Trail Page", () => {
  describe("Page rendering and header", () => {
    it("renders the 'Audit Trail' heading", async () => {
      mockGraphQL({
        auditTrail: createMockAuditConnection(),
      });
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        expect(screen.getByText(/Audit Trail/i)).toBeInTheDocument();
      });
    });

    it("renders the chain-of-custody subheader text", async () => {
      mockGraphQL({
        auditTrail: createMockAuditConnection(),
      });
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        const subheader =
          screen.queryByText(/chain of custody/i) ||
          screen.queryByText(/SHA-256 verified/i);
        expect(subheader).toBeInTheDocument();
      });
    });

    it("renders an 'Export CSV' button", async () => {
      mockGraphQL({
        auditTrail: createMockAuditConnection(),
      });
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        const exportBtn =
          screen.queryByRole("button", { name: /export csv/i }) ||
          screen.queryByRole("link", { name: /export csv/i }) ||
          screen.queryByText(/Export CSV/i);
        expect(exportBtn).toBeInTheDocument();
      });
    });

    it("renders an 'Export for Auditor' button", async () => {
      mockGraphQL({
        auditTrail: createMockAuditConnection(),
      });
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        const auditorBtn =
          screen.queryByRole("button", { name: /export.*auditor/i }) ||
          screen.queryByText(/Export for Auditor/i);
        expect(auditorBtn).toBeInTheDocument();
      });
    });
  });

  describe("Audit trail table from auditTrail query (Deliverable 1)", () => {
    beforeEach(() => {
      mockGraphQL({
        auditTrail: createMockAuditConnection(),
      });
    });

    it("renders audit data in a table element", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        expect(document.querySelector("table")).not.toBeNull();
      });
    });

    it("renders table column headers matching design", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        // Required columns from the design doc
        const requiredColumns = [
          /timestamp/i,
          /session/i,
          /turn|seq/i,
          /provider/i,
          /request.*hash/i,
          /response.*hash/i,
          /tokens/i,
          /integrity/i,
        ];
        for (const pattern of requiredColumns) {
          const header = screen.queryByText(pattern);
          expect(header).toBeInTheDocument();
        }
      });
    });

    it("renders session IDs (truncated) from audit entries", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        // Session ID "a3f8c1d42e" should be truncated to something like "a3f8c1...d42e"
        const truncated =
          screen.queryByText(/a3f8c1/) ||
          screen.queryByText(/d42e/);
        expect(truncated).toBeInTheDocument();
      });
    });

    it("renders turn/sequence numbers from audit entries", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        // sequenceNum: 34 from mock data
        expect(screen.getByText("34")).toBeInTheDocument();
      });
    });

    it("renders provider names from audit entries", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeInTheDocument();
        expect(screen.getByText("OpenAI")).toBeInTheDocument();
        expect(screen.getByText("Gemini")).toBeInTheDocument();
      });
    });

    it("renders request hashes from audit entries", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        // requestHash: "sha256:e8f4a2b1c3d5" - may be truncated
        const hash =
          screen.queryByText(/e8f4a2b1/) ||
          screen.queryByText(/sha256:e8f4a2/);
        expect(hash).toBeInTheDocument();
      });
    });

    it("renders response hashes from audit entries", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        // responseHash: "sha256:7c3d9f01a2b4" - may be truncated
        const hash =
          screen.queryByText(/7c3d9f01/) ||
          screen.queryByText(/sha256:7c3d9f/);
        expect(hash).toBeInTheDocument();
      });
    });

    it("renders token counts from audit entries", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        // totalTokens: 12841 may be formatted with commas: "12,841"
        const tokens =
          screen.queryByText("12,841") || screen.queryByText("12841");
        expect(tokens).toBeInTheDocument();
      });
    });
  });

  describe("Integrity status pills (Deliverable 6)", () => {
    beforeEach(() => {
      mockGraphQL({
        auditTrail: createMockAuditConnection(),
      });
    });

    it("renders 'verified' integrity pill for verified entries", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        const verifiedPill = screen.queryAllByText(/verified/i);
        expect(verifiedPill.length).toBeGreaterThan(0);
      });
    });

    it("renders 'retry' integrity pill for 429 retry entries", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        // Mock has one entry with integrityStatus: "retry"
        const retryPill =
          screen.queryByText(/retry/i) ||
          screen.queryByText(/429/i);
        expect(retryPill).toBeInTheDocument();
      });
    });

    it("renders 'failed' integrity pill for failed entries", async () => {
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        // Mock has one entry with integrityStatus: "failed"
        const failedPill = screen.queryByText(/failed/i);
        expect(failedPill).toBeInTheDocument();
      });
    });
  });

  describe("Search functionality (Deliverable 2)", () => {
    it("renders a search input", async () => {
      mockGraphQL({
        auditTrail: createMockAuditConnection(),
      });
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        const searchInput =
          screen.queryByRole("searchbox") ||
          screen.queryByPlaceholderText(/search/i);
        expect(searchInput).toBeInTheDocument();
      });
    });

    it("search input sends debounced search query to auditTrail", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const fetchMock = mockGraphQL({
        auditTrail: createMockAuditConnection(),
      });
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      await waitFor(() => {
        const searchInput =
          screen.queryByRole("searchbox") ||
          screen.queryByPlaceholderText(/search/i);
        expect(searchInput).toBeInTheDocument();
      });

      const searchInput = (
        screen.queryByRole("searchbox") ||
        screen.queryByPlaceholderText(/search/i)
      ) as HTMLInputElement;

      // Type a search term
      await user.type(searchInput, "sha256:e8f4");

      // Advance past debounce delay
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      // Verify that fetch was called with the search term in the body
      await waitFor(() => {
        const calls = fetchMock.mock.calls;
        const hasSearch = calls.some((call: unknown[]) => {
          const init = call[1] as RequestInit | undefined;
          if (!init?.body) return false;
          const bodyStr =
            typeof init.body === "string" ? init.body : "";
          return bodyStr.includes("sha256:e8f4") || bodyStr.includes("search");
        });
        expect(hasSearch).toBe(true);
      });
      vi.useRealTimers();
    });
  });

  describe("Type filter buttons (Deliverable 3)", () => {
    it("renders filter buttons: All Events, Requests, Responses, Anomalies", async () => {
      mockGraphQL({
        auditTrail: createMockAuditConnection(),
      });
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        // At minimum "All" or "All Events" must be present
        const allBtn =
          screen.queryByText(/All Events/i) ||
          screen.queryByText(/^All$/i);
        expect(allBtn).toBeInTheDocument();
      });
      // Other filters
      const requestsBtn = screen.queryByText(/Requests/i);
      const responsesBtn = screen.queryByText(/Responses/i);
      const anomaliesBtn = screen.queryByText(/Anomalies/i);
      expect(requestsBtn).toBeInTheDocument();
      expect(responsesBtn).toBeInTheDocument();
      expect(anomaliesBtn).toBeInTheDocument();
    });

    it("'All Events' (or 'All') filter is active by default", async () => {
      mockGraphQL({
        auditTrail: createMockAuditConnection(),
      });
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        const allBtn =
          screen.queryByText(/All Events/i) ||
          screen.queryByText(/^All$/i);
        expect(allBtn).toBeInTheDocument();
        const isActive =
          allBtn!.getAttribute("aria-pressed") === "true" ||
          allBtn!.className.includes("active") ||
          allBtn!.getAttribute("aria-current") === "true";
        expect(isActive).toBe(true);
      });
    });

    it("clicking a type filter button updates the active filter", async () => {
      mockGraphQL({
        auditTrail: createMockAuditConnection(),
      });
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      const user = userEvent.setup();

      await waitFor(() => {
        expect(
          screen.queryByText(/Requests/i),
        ).toBeInTheDocument();
      });

      await user.click(screen.getByText(/Requests/i));

      await waitFor(() => {
        const requestsBtn = screen.getByText(/Requests/i);
        const isActive =
          requestsBtn.getAttribute("aria-pressed") === "true" ||
          requestsBtn.className.includes("active") ||
          requestsBtn.getAttribute("aria-current") === "true";
        expect(isActive).toBe(true);
      });
    });

    it("clicking a type filter sends the filter to the auditTrail query", async () => {
      const fetchMock = mockGraphQL({
        auditTrail: createMockAuditConnection(),
      });
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      const user = userEvent.setup();

      await waitFor(() => {
        expect(screen.queryByText(/Anomalies/i)).toBeInTheDocument();
      });

      await user.click(screen.getByText(/Anomalies/i));

      // Verify fetch was called with type filter in variables
      await waitFor(() => {
        const calls = fetchMock.mock.calls;
        const hasTypeFilter = calls.some((call: unknown[]) => {
          const init = call[1] as RequestInit | undefined;
          if (!init?.body) return false;
          const bodyStr =
            typeof init.body === "string" ? init.body : "";
          return (
            bodyStr.includes("ANOMALIES") ||
            bodyStr.includes("anomalies") ||
            bodyStr.includes("type")
          );
        });
        expect(hasTypeFilter).toBe(true);
      });
    });
  });

  describe("Pagination with total count (Deliverable 4)", () => {
    it("renders total count of audit entries", async () => {
      mockGraphQL({
        auditTrail: createMockAuditConnection(undefined, 142),
      });
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        const totalText =
          screen.queryByText("142") ||
          screen.queryByText(/142 total/i) ||
          screen.queryByText(/142 entries/i) ||
          screen.queryByText(/142 events/i);
        expect(totalText).toBeInTheDocument();
      });
    });

    it("renders pagination controls when there are multiple pages", async () => {
      // 142 total with 20 per page = 8 pages
      mockGraphQL({
        auditTrail: createMockAuditConnection(undefined, 142),
      });
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        // Should have Prev/Next or page number buttons
        const pagination =
          screen.queryByLabelText(/pagination/i) ||
          screen.queryByText(/prev/i) ||
          screen.queryByText(/next/i) ||
          document.querySelector("nav[aria-label]");
        expect(pagination).not.toBeNull();
      });
    });

    it("clicking next page sends updated offset to query", async () => {
      const fetchMock = mockGraphQL({
        auditTrail: createMockAuditConnection(undefined, 142),
      });
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      const user = userEvent.setup();

      await waitFor(() => {
        const nextBtn =
          screen.queryByLabelText(/next page/i) ||
          screen.queryByText(/next/i);
        expect(nextBtn).toBeInTheDocument();
      });

      const nextBtn = (
        screen.queryByLabelText(/next page/i) ||
        screen.queryByText(/next/i)
      ) as HTMLElement;
      await user.click(nextBtn);

      // Verify fetch was called with offset > 0
      await waitFor(() => {
        const calls = fetchMock.mock.calls;
        const hasOffset = calls.some((call: unknown[]) => {
          const init = call[1] as RequestInit | undefined;
          if (!init?.body) return false;
          const bodyStr =
            typeof init.body === "string" ? init.body : "";
          // Should contain offset in variables
          return bodyStr.includes("offset") && !bodyStr.includes('"offset":0');
        });
        expect(hasOffset).toBe(true);
      });
    });
  });

  describe("Export CSV button (Deliverable 5)", () => {
    it("Export CSV button is clickable and triggers download action", async () => {
      mockGraphQL({
        auditTrail: createMockAuditConnection(),
      });

      // Mock window.open for CSV download
      const windowOpenMock = vi.fn();
      vi.stubGlobal("open", windowOpenMock);

      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      const user = userEvent.setup();

      await waitFor(() => {
        const exportBtn =
          screen.queryByRole("button", { name: /export csv/i }) ||
          screen.queryByText(/Export CSV/i);
        expect(exportBtn).toBeInTheDocument();
      });

      const exportBtn = (
        screen.queryByRole("button", { name: /export csv/i }) ||
        screen.queryByText(/Export CSV/i)
      ) as HTMLElement;
      await user.click(exportBtn);

      // Should trigger window.open with CSV URL or similar download mechanism
      // The design specifies: window.open('/v1/audit/export.csv?...')
      await waitFor(() => {
        // Either window.open was called or an <a> tag with download was created
        const downloadTriggered =
          windowOpenMock.mock.calls.length > 0 ||
          document.querySelector("a[download]") !== null;
        expect(downloadTriggered).toBe(true);
      });
    });
  });

  describe("Loading state (Deliverable 13)", () => {
    it("shows loading indicator while data is being fetched", async () => {
      // Mock fetch that never resolves
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise(() => {})),
      );
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
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
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        const error =
          screen.queryByRole("alert") ||
          screen.queryByText(/error/i) ||
          screen.queryByText(/failed/i);
        expect(error).toBeInTheDocument();
      });
    });

    it("shows error message when GraphQL returns errors", async () => {
      mockGraphQLError("Internal server error");
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        const error =
          screen.queryByRole("alert") ||
          screen.queryByText(/error/i) ||
          screen.queryByText(/failed/i);
        expect(error).toBeInTheDocument();
      });
    });
  });

  describe("Empty state (Deliverable 13)", () => {
    it("shows empty state when audit trail has zero entries", async () => {
      mockGraphQL({
        auditTrail: { items: [], total: 0, limit: 20, offset: 0 },
      });
      // @ts-expect-error -- module may not exist yet
      const AuditTrail = (await import("@/pages/AuditTrail")).default;
      renderWithProviders(<AuditTrail />);
      await waitFor(() => {
        const empty =
          screen.queryByText(/no.*audit/i) ||
          screen.queryByText(/no.*entries/i) ||
          screen.queryByText(/no.*events/i) ||
          screen.queryByText(/no.*data/i) ||
          screen.queryByText(/empty/i);
        expect(empty).toBeInTheDocument();
      });
    });
  });

  describe("Uses shared D2 components (Deliverable 12)", () => {
    it("page source imports DataTable from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AuditTrail.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*DataTable.*from/);
    });

    it("page source imports SearchInput from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AuditTrail.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*SearchInput.*from/);
    });

    it("page source imports FilterBar from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AuditTrail.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*FilterBar.*from/);
    });

    it("page source imports Pagination from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AuditTrail.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*Pagination.*from/);
    });

    it("page source imports TagPill from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AuditTrail.tsx"),
        "utf-8",
      );
      // TagPill is used for provider pills and integrity status pills
      expect(src).toMatch(/import.*TagPill.*from/);
    });

    it("page source imports LoadingState from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AuditTrail.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*LoadingState.*from/);
    });

    it("page source imports ErrorState from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AuditTrail.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*ErrorState.*from/);
    });

    it("page source imports EmptyState from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AuditTrail.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*EmptyState.*from/);
    });

    it("page source imports graphqlRequest from graphql/client", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/AuditTrail.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*graphqlRequest.*from/);
    });
  });
});

// ============================================================
// D7.2 -- Cost & Usage Page
// ============================================================

describe("D7.2 -- Cost & Usage Page", () => {
  describe("Page rendering and header", () => {
    it("renders the 'Cost & Usage' heading", async () => {
      mockGraphQL(createAllCostMocks());
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        const heading =
          screen.queryByText(/Cost & Usage Intelligence/i) ||
          screen.queryByText(/Cost & Usage/i) ||
          screen.queryByText(/Cost.*Usage/i);
        expect(heading).toBeInTheDocument();
      });
    });

    it("renders time range filter buttons (1d/7d/30d/90d or Today/7 days/30 days/Quarter)", async () => {
      mockGraphQL(createAllCostMocks());
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        // Design shows: Today, 7 days, 30 days, Quarter
        // Implementation may use: 1d, 7d, 30d, 90d
        const hasFilters =
          (screen.queryByText(/Today/i) || screen.queryByText(/1d/i)) &&
          (screen.queryByText(/7 days/i) || screen.queryByText(/7d/i)) &&
          (screen.queryByText(/30 days/i) || screen.queryByText(/30d/i)) &&
          (screen.queryByText(/Quarter/i) || screen.queryByText(/90d/i));
        expect(hasFilters).toBeTruthy();
      });
    });
  });

  describe("Metric cards from usageSummary (Deliverable 7)", () => {
    beforeEach(() => {
      mockGraphQL(createAllCostMocks());
    });

    it("renders 5 metric cards", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        // Verify the 5 card labels from the design doc
        expect(
          screen.queryByText(/Total Spend/i) || screen.queryByText(/Total Cost/i),
        ).toBeInTheDocument();
        expect(
          screen.queryByText(/Total Tokens/i),
        ).toBeInTheDocument();
        expect(
          screen.queryByText(/Avg Cost.*Session/i) || screen.queryByText(/Average Cost/i),
        ).toBeInTheDocument();
        expect(
          screen.queryByText(/Cache Hit Rate/i),
        ).toBeInTheDocument();
        expect(
          screen.queryByText(/Cost.*Developer.*Day/i),
        ).toBeInTheDocument();
      });
    });

    it("renders Total Spend MTD value from usageSummary", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        // totalCostUsd: 4218.0 -> "$4,218" or "$4,218.00"
        const costText =
          screen.queryByText("$4,218") ||
          screen.queryByText("$4,218.00") ||
          screen.queryByText(/4,218/) ||
          screen.queryByText(/4218/);
        expect(costText).toBeInTheDocument();
      });
    });

    it("renders Avg Cost/Session value from usageSummary", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        // averageCostPerSession: 2.84 -> "$2.84"
        const costText =
          screen.queryByText("$2.84") || screen.queryByText(/2\.84/);
        expect(costText).toBeInTheDocument();
      });
    });

    it("renders Cache Hit Rate value from usageSummary", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        // cacheHitRate: 37.0 -> "37%" or "37.0%"
        const cacheText =
          screen.queryByText("37%") || screen.queryByText(/37\.0?%/);
        expect(cacheText).toBeInTheDocument();
      });
    });

    it("renders Cost/Developer/Day value from usageSummary", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        // costPerDeveloperPerDay: 28.12 -> "$28.12"
        const costText =
          screen.queryByText("$28.12") || screen.queryByText(/28\.12/);
        expect(costText).toBeInTheDocument();
      });
    });

    it("renders projected monthly cost as subtitle or delta on Total Spend card", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        // projectedMonthlyCostUsd: 6800.0 -> "$6,800" projected
        const projectedText =
          screen.queryByText(/6,800/) ||
          screen.queryByText(/6800/) ||
          screen.queryByText(/projected/i);
        expect(projectedText).toBeInTheDocument();
      });
    });

    it("renders developer count subtitle on Cost/Developer/Day card", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        // developerCount: 8 -> "across 8 developers" or "8 developers"
        const devText =
          screen.queryByText(/8 developer/i) ||
          screen.queryByText(/across 8/i);
        expect(devText).toBeInTheDocument();
      });
    });
  });

  describe("Spend-by bars from spendByProvider/Model/Framework (Deliverable 8)", () => {
    beforeEach(() => {
      mockGraphQL(createAllCostMocks());
    });

    it("renders 'Spend by Provider' section heading", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        expect(screen.getByText(/Spend by Provider/i)).toBeInTheDocument();
      });
    });

    it("renders provider names in spend-by-provider bars", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeInTheDocument();
        expect(screen.getByText("OpenAI")).toBeInTheDocument();
        expect(screen.getByText("Gemini")).toBeInTheDocument();
      });
    });

    it("renders cost amounts in spend-by-provider bars", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        // Anthropic: $2,868 or $2868.00
        const anthropicCost =
          screen.queryByText("$2,868") ||
          screen.queryByText("$2,868.00") ||
          screen.queryByText(/2,868/) ||
          screen.queryByText(/2868/);
        expect(anthropicCost).toBeInTheDocument();
      });
    });

    it("renders 'Spend by Model' section heading", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        expect(screen.getByText(/Spend by Model/i)).toBeInTheDocument();
      });
    });

    it("renders model names in spend-by-model bars", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        expect(screen.getByText("opus-4")).toBeInTheDocument();
        expect(screen.getByText("sonnet-4")).toBeInTheDocument();
        expect(screen.getByText("o3")).toBeInTheDocument();
      });
    });

    it("renders 'Spend by Framework' or 'Spend by Agent Framework' section heading", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        const heading =
          screen.queryByText(/Spend by.*Framework/i) ||
          screen.queryByText(/Spend by Agent Framework/i);
        expect(heading).toBeInTheDocument();
      });
    });

    it("renders framework names in spend-by-framework bars", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        expect(screen.getByText("Claude Code")).toBeInTheDocument();
        expect(screen.getByText("Cursor")).toBeInTheDocument();
        expect(screen.getByText("Codex")).toBeInTheDocument();
        expect(screen.getByText("Aider")).toBeInTheDocument();
      });
    });

    it("renders meter/progressbar elements for cost bars", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        // CostBar component uses role="meter"
        const meters = screen.queryAllByRole("meter");
        // Should have at least 3 providers + 5 models + 4 frameworks = 12
        expect(meters.length).toBeGreaterThanOrEqual(3);
      });
    });
  });

  describe("Daily spend chart (Deliverable 9)", () => {
    beforeEach(() => {
      mockGraphQL(createAllCostMocks());
    });

    it("renders 'Daily Spend' section heading", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        const heading =
          screen.queryByText(/Daily Spend/i) ||
          screen.queryByText(/Daily Cost/i);
        expect(heading).toBeInTheDocument();
      });
    });

    it("page source uses recharts or chart rendering for daily spend", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/CostUsage.tsx"),
        "utf-8",
      );
      // Should use recharts BarChart or a ChartBox wrapper or custom bar chart
      const usesChart =
        /recharts/.test(src) ||
        /BarChart/.test(src) ||
        /ChartBox/.test(src) ||
        /bar-chart/.test(src) ||
        /dailySpend/.test(src);
      expect(usesChart).toBe(true);
    });
  });

  describe("Projections table (Deliverable 10)", () => {
    beforeEach(() => {
      mockGraphQL(createAllCostMocks());
    });

    it("renders 'Projected Monthly Costs' section heading", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        const heading =
          screen.queryByText(/Projected Monthly/i) ||
          screen.queryByText(/Cost Projection/i) ||
          screen.queryByText(/Monthly.*Projection/i);
        expect(heading).toBeInTheDocument();
      });
    });

    it("renders projection month names", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        expect(screen.getByText(/April 2026/i)).toBeInTheDocument();
        expect(screen.getByText(/May 2026/i)).toBeInTheDocument();
        expect(screen.getByText(/June 2026/i)).toBeInTheDocument();
      });
    });

    it("renders projected cost values", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        // April: $7,400
        const aprilCost =
          screen.queryByText("$7,400") ||
          screen.queryByText("$7,400.00") ||
          screen.queryByText(/7,400/) ||
          screen.queryByText(/7400/);
        expect(aprilCost).toBeInTheDocument();
      });
    });

    it("renders projected session counts", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        // April: 1,820 sessions
        const sessions =
          screen.queryByText("1,820") || screen.queryByText("1820");
        expect(sessions).toBeInTheDocument();
      });
    });

    it("renders projection assumptions text", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        const assumptions =
          screen.queryByText(/current model mix/i) ||
          screen.queryByText(/\+2 developers/i) ||
          screen.queryByText(/Cache optimization/i);
        expect(assumptions).toBeInTheDocument();
      });
    });

    it("renders delta vs current percentages", async () => {
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        // April: +9%, May: +21%, June: +5%
        const delta =
          screen.queryByText(/\+9%/) ||
          screen.queryByText(/9%/) ||
          screen.queryByText(/\+21%/) ||
          screen.queryByText(/21%/);
        expect(delta).toBeInTheDocument();
      });
    });
  });

  describe("Time range filter re-fetches all cost queries (Deliverable 11)", () => {
    it("clicking a different time range re-fetches data", async () => {
      const fetchMock = mockGraphQL(createAllCostMocks());
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      const user = userEvent.setup();

      await waitFor(() => {
        const sevenDayBtn =
          screen.queryByText(/7 days/i) || screen.queryByText(/7d/i);
        expect(sevenDayBtn).toBeInTheDocument();
      });

      // Record fetch call count before clicking
      const callCountBefore = fetchMock.mock.calls.length;

      const sevenDayBtn = (
        screen.queryByText(/7 days/i) || screen.queryByText(/7d/i)
      ) as HTMLElement;
      await user.click(sevenDayBtn);

      // Verify additional fetches were made after clicking the time range
      await waitFor(() => {
        expect(fetchMock.mock.calls.length).toBeGreaterThan(callCountBefore);
      });
    });

    it("clicking time range sends period variable in GraphQL queries", async () => {
      const fetchMock = mockGraphQL(createAllCostMocks());
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      const user = userEvent.setup();

      await waitFor(() => {
        const thirtyDayBtn =
          screen.queryByText(/30 days/i) || screen.queryByText(/30d/i);
        expect(thirtyDayBtn).toBeInTheDocument();
      });

      const thirtyDayBtn = (
        screen.queryByText(/30 days/i) || screen.queryByText(/30d/i)
      ) as HTMLElement;
      await user.click(thirtyDayBtn);

      // Verify fetch was called with period variable
      await waitFor(() => {
        const calls = fetchMock.mock.calls;
        const hasPeriod = calls.some((call: unknown[]) => {
          const init = call[1] as RequestInit | undefined;
          if (!init?.body) return false;
          const bodyStr =
            typeof init.body === "string" ? init.body : "";
          return (
            bodyStr.includes("DAY_30") ||
            bodyStr.includes("period") ||
            bodyStr.includes("day_30")
          );
        });
        expect(hasPeriod).toBe(true);
      });
    });

    it("selected time range button becomes active", async () => {
      mockGraphQL(createAllCostMocks());
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      const user = userEvent.setup();

      await waitFor(() => {
        const quarterBtn =
          screen.queryByText(/Quarter/i) || screen.queryByText(/90d/i);
        expect(quarterBtn).toBeInTheDocument();
      });

      const quarterBtn = (
        screen.queryByText(/Quarter/i) || screen.queryByText(/90d/i)
      ) as HTMLElement;
      await user.click(quarterBtn);

      await waitFor(() => {
        const isActive =
          quarterBtn.getAttribute("aria-pressed") === "true" ||
          quarterBtn.className.includes("active") ||
          quarterBtn.getAttribute("aria-current") === "true";
        expect(isActive).toBe(true);
      });
    });
  });

  describe("Loading state (Deliverable 13)", () => {
    it("shows loading indicator while data is being fetched", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise(() => {})),
      );
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
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
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        const error =
          screen.queryByRole("alert") ||
          screen.queryByText(/error/i) ||
          screen.queryByText(/failed/i);
        expect(error).toBeInTheDocument();
      });
    });

    it("shows error message when GraphQL returns errors", async () => {
      mockGraphQLError("Internal server error");
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        const error =
          screen.queryByRole("alert") ||
          screen.queryByText(/error/i) ||
          screen.queryByText(/failed/i);
        expect(error).toBeInTheDocument();
      });
    });
  });

  describe("Empty state (Deliverable 13)", () => {
    it("shows meaningful content when usage summary has zero values", async () => {
      mockGraphQL({
        usageSummary: createMockUsageSummary({
          totalCostUsd: 0,
          totalTokens: 0,
          averageCostPerSession: 0,
          cacheHitRate: 0,
          costPerDeveloperPerDay: 0,
          developerCount: 0,
        }),
        spendByProvider: [],
        spendByModel: [],
        spendByFramework: [],
        dailySpend: [],
        costProjections: [],
      });
      // @ts-expect-error -- module may not exist yet
      const CostUsage = (await import("@/pages/CostUsage")).default;
      renderWithProviders(<CostUsage />);
      await waitFor(() => {
        // Page should still render with zero values shown, not crash
        const heading =
          screen.queryByText(/Cost & Usage/i) ||
          screen.queryByText(/Cost.*Usage/i);
        expect(heading).toBeInTheDocument();
      });
      // Zero values should appear as "$0.00" or "$0" or "0"
      const zeroCosts = screen.queryAllByText(/\$0(?:\.00)?/);
      expect(zeroCosts.length).toBeGreaterThan(0);
    });
  });

  describe("Uses shared D2 components (Deliverable 12)", () => {
    it("page source imports MetricCard from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/CostUsage.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*MetricCard.*from/);
    });

    it("page source imports CostBar from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/CostUsage.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*CostBar.*from/);
    });

    it("page source imports FilterBar from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/CostUsage.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*FilterBar.*from/);
    });

    it("page source imports TwoColumnLayout from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/CostUsage.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*TwoColumnLayout.*from/);
    });

    it("page source imports ChartBox from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/CostUsage.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*ChartBox.*from/);
    });

    it("page source imports LoadingState from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/CostUsage.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*LoadingState.*from/);
    });

    it("page source imports ErrorState from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/CostUsage.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*ErrorState.*from/);
    });

    it("page source imports graphqlRequest from graphql/client", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/CostUsage.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*graphqlRequest.*from/);
    });

    it("page source uses useQuery from @tanstack/react-query", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/CostUsage.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/useQuery/);
    });
  });
});
