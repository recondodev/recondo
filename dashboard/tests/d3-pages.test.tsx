/**
 * Sprint D3 -- Behavioral Tests: Dashboard Pages Wired to GraphQL
 *
 * Tests for:
 *   D3.1  Realtime Feed page (metric cards, gateway status, live feed, provider filter)
 *   D3.2  Sessions list page (session table, search, filter, pagination, row navigation)
 *   D3.3  Session detail page (metadata grid, expandable turns, hashes, pagination)
 *
 * These tests are written BEFORE implementation exists.
 * They verify the design document deliverables, not implementation internals.
 *
 * GraphQL responses are mocked -- no running API server required.
 * Every test verifies that pages USE shared D2 components (MetricCard, DataTable,
 * TagPill, FilterBar, SearchInput, Pagination, ExpandableRow, FeedItem, etc.)
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
import { MemoryRouter, Routes, Route } from "react-router-dom";
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

function createMockRealtimeStats(overrides?: Record<string, unknown>) {
  return {
    requestsPerMinute: 34,
    // FIND-10-A: dashboard's primary metric is now User Turns/Min,
    // computed from logical-turn rollup rather than raw wire calls.
    // The page's MetricCard binds value to `userTurnsPerMinute`; the
    // mock must populate it explicitly so test assertions match the
    // rendered DOM. requestsPerMinute is retained because the
    // subtitle still reports "<n> wire calls" when the two diverge.
    userTurnsPerMinute: 34,
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
    ...overrides,
  };
}

function createMockGatewayStatus(overrides?: Record<string, unknown>) {
  return {
    status: "live",
    uptimeSeconds: 86400,
    lastHeartbeat: "2026-03-23T18:42:00Z",
    ...overrides,
  };
}

function createMockFeedItem(overrides?: Record<string, unknown>) {
  return {
    timestamp: "2026-03-23T18:42:03Z",
    provider: "Anthropic",
    model: "opus-4",
    framework: "claude-code",
    intent: "refactor session module to use metadata-ba...",
    totalTokens: 12841,
    costUsd: 0.38,
    httpStatus: 200,
    sessionId: "a3f8c1d42e",
    ...overrides,
  };
}

function createMockFeedItems() {
  return [
    createMockFeedItem(),
    createMockFeedItem({
      timestamp: "2026-03-23T18:41:58Z",
      provider: "OpenAI",
      model: "o3",
      framework: "codex",
      intent: "fix the websocket frame masking...",
      totalTokens: 8204,
      costUsd: 0.12,
      sessionId: "c1d4e8a290",
    }),
    createMockFeedItem({
      timestamp: "2026-03-23T18:41:51Z",
      provider: "Anthropic",
      model: "sonnet-4",
      framework: "cursor",
      intent: "add error handling to the capture...",
      totalTokens: 4512,
      costUsd: 0.04,
      sessionId: "d9f3b27c61",
    }),
    createMockFeedItem({
      timestamp: "2026-03-23T18:41:44Z",
      provider: "Gemini",
      model: "gemini-2.5",
      framework: "aider",
      intent: "migrate database schema to v3...",
      totalTokens: 6339,
      costUsd: 0.05,
      sessionId: "e2a7c53b48",
    }),
  ];
}

function createMockSession(overrides?: Record<string, unknown>) {
  return {
    id: "a3f8c1d42e",
    projectId: null,
    agentId: "agent-alpha",
    model: "opus-4",
    provider: "Anthropic",
    startedAt: "2026-03-23T17:55:00Z",
    endedAt: null,
    lastActiveAt: "2026-03-23T18:42:03Z",
    initialIntent: "refactor session module to use metadata-based identity",
    systemPromptHash: "sha256:abc123def456",
    totalTurns: 34,
    turnsCaptured: 34,
    droppedEvents: 0,
    totalTokens: 142830,
    totalCostUsd: 4.28,
    turns: [],
    complete: false,
    framework: "claude-code",
    status: "active",
    duration: 2820,
    accountUuid: "acct-uuid-001",
    deviceId: "device-001",
    gitRepo: "recondo",
    gitBranch: "main",
    cacheReadTokens: 12000,
    cacheCreationTokens: 3000,
    ...overrides,
  };
}

function createMockSessionConnection(
  items?: unknown[],
  total?: number,
) {
  const sessions = items ?? [
    createMockSession(),
    createMockSession({
      id: "b7e2a91f83",
      model: "sonnet-4",
      framework: "claude-code",
      status: "completed",
      totalTurns: 18,
      totalTokens: 52441,
      totalCostUsd: 0.47,
      duration: 1380,
      initialIntent: "fix token counting include cache tokens",
    }),
    createMockSession({
      id: "c1d4e8a290",
      provider: "OpenAI",
      model: "o3",
      framework: "codex",
      status: "active",
      totalTurns: 22,
      totalTokens: 78120,
      totalCostUsd: 1.17,
      duration: 1860,
      initialIntent: "implement websocket frame capture for chatgpt",
    }),
    createMockSession({
      id: "d9f3b27c61",
      model: "sonnet-4",
      framework: "cursor",
      status: "active",
      totalTurns: 8,
      totalTokens: 18904,
      totalCostUsd: 0.17,
      duration: 720,
      initialIntent: "add error handling to capture pipeline",
    }),
    createMockSession({
      id: "e2a7c53b48",
      provider: "Gemini",
      model: "gemini-2.5",
      framework: "aider",
      status: "completed",
      totalTurns: 15,
      totalTokens: 44210,
      totalCostUsd: 0.35,
      duration: 1140,
      initialIntent: "migrate database schema to v3",
    }),
  ];
  return {
    items: sessions,
    total: total ?? sessions.length,
    limit: 20,
    offset: 0,
  };
}

function createMockTurn(overrides?: Record<string, unknown>) {
  return {
    id: "turn-001",
    sessionId: "a3f8c1d42e",
    sequenceNum: 1,
    timestamp: "2026-03-23T17:55:30Z",
    turnType: "request",
    inputTokens: 2000,
    outputTokens: 1000,
    thinkingTokens: 500,
    totalTokens: 3500,
    costUsd: 0.10,
    latencyMs: 2500,
    captureComplete: true,
    contentHashReq: "sha256:e8f4a2b1c3d5",
    contentHashResp: "sha256:7c3d9f01a2b4",
    stopReason: "end_turn",
    model: "opus-4",
    provider: "Anthropic",
    toolCallCount: 1,
    toolCalls: [],
    anomalies: [],
    userRequestText: "Refactor the session module to use metadata-based identity",
    responseText:
      "I will refactor the session module to derive session identity from metadata fields...",
    thinkingText: "Analyzing the current session identity logic...",
    cacheReadTokens: 200,
    cacheCreationTokens: 100,
    httpStatus: 200,
    transport: "https",
    ttfbMs: 800,
    durationMs: 2500,
    requestHash: "sha256:e8f4a2b1c3d5",
    responseHash: "sha256:7c3d9f01a2b4",
    ...overrides,
  };
}

function createMockSessionWithTurns() {
  const session = createMockSession({ totalTurns: 3 });
  const turns = [
    createMockTurn({ id: "turn-001", sequenceNum: 1 }),
    createMockTurn({
      id: "turn-002",
      sequenceNum: 2,
      userRequestText: "Now add JWT token validation",
      responseText: "I will implement JWT validation middleware...",
      thinkingText: "JWT validation requires checking expiry...",
      requestHash: "sha256:a1b2c3d4e5f6",
      responseHash: "sha256:f6e5d4c3b2a1",
    }),
    createMockTurn({
      id: "turn-003",
      sequenceNum: 3,
      userRequestText: "Write tests for the auth module",
      responseText: "I will create comprehensive tests for the auth module...",
      thinkingText: "Testing requires mocking the JWT library...",
      requestHash: "sha256:112233445566",
      responseHash: "sha256:665544332211",
    }),
  ];
  return { ...session, turns };
}

// ============================================================
// GraphQL mock helper
// ============================================================

/**
 * Mock the global fetch so that any POST to a GraphQL endpoint returns
 * the provided response data. Matches by checking the GraphQL operation
 * name in the request body.
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
// D3.1 -- Realtime Feed Page
// ============================================================

describe("D3.1 -- Realtime Feed Page", () => {
  describe("Page rendering and header", () => {
    it("renders the 'Realtime Monitor' heading", async () => {
      mockGraphQL({
        realtimeStats: createMockRealtimeStats(),
        realtimeFeed: createMockFeedItems(),
        gatewayStatus: createMockGatewayStatus(),
      });
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      await waitFor(() => {
        expect(screen.getByText(/Realtime Monitor/i)).toBeInTheDocument();
      });
    });

    it("renders gateway status pill showing 'live' status", async () => {
      mockGraphQL({
        realtimeStats: createMockRealtimeStats(),
        realtimeFeed: createMockFeedItems(),
        gatewayStatus: createMockGatewayStatus({ status: "live" }),
      });
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      await waitFor(() => {
        // Should show "live" or "Gateway Live" in a status pill
        const liveText =
          screen.queryByText(/gateway live/i) ||
          screen.queryByText(/^live$/i);
        expect(liveText).toBeInTheDocument();
      });
    });

    it("renders gateway status pill showing 'offline' when gateway is down", async () => {
      mockGraphQL({
        realtimeStats: createMockRealtimeStats(),
        realtimeFeed: createMockFeedItems(),
        gatewayStatus: createMockGatewayStatus({ status: "offline" }),
      });
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      await waitFor(() => {
        const offlineText =
          screen.queryByText(/offline/i) ||
          screen.queryByText(/gateway offline/i);
        expect(offlineText).toBeInTheDocument();
      });
    });
  });

  describe("Metric cards from realtimeStats", () => {
    beforeEach(() => {
      mockGraphQL({
        realtimeStats: createMockRealtimeStats(),
        realtimeFeed: createMockFeedItems(),
        gatewayStatus: createMockGatewayStatus(),
      });
    });

    it("renders 5 metric cards", async () => {
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      await waitFor(() => {
        // FIND-10-A: card label is now "User Turns / Min" (logical
        // turns, not raw wire calls). The 5-card invariant still
        // holds; the leading metric just changed semantics.
        expect(screen.getByText(/user turns.*min/i)).toBeInTheDocument();
        expect(screen.getByText(/active sessions/i)).toBeInTheDocument();
        expect(screen.getByText(/tokens.*last hour/i)).toBeInTheDocument();
        expect(screen.getByText(/cost.*last hour/i)).toBeInTheDocument();
        expect(screen.getByText(/p50 latency/i)).toBeInTheDocument();
      });
    });

    it("renders User Turns/min with value from realtimeStats", async () => {
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      await waitFor(() => {
        // FIND-10-A: value is sourced from `userTurnsPerMinute`, not
        // `requestsPerMinute`. Mock factory now populates both with
        // 34 so the assertion stays a single-number check.
        expect(screen.getByText("34")).toBeInTheDocument();
      });
    });

    it("renders Active Sessions with value from realtimeStats", async () => {
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      await waitFor(() => {
        expect(screen.getByText("12")).toBeInTheDocument();
      });
    });

    it("renders Cost (last hour) with value from realtimeStats", async () => {
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      await waitFor(() => {
        // Cost should be formatted as currency
        const costText =
          screen.queryByText("$18.42") || screen.queryByText(/18\.42/);
        expect(costText).toBeInTheDocument();
      });
    });

    it("renders P50 Latency with value from realtimeStats", async () => {
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      await waitFor(() => {
        // latencyP50Ms: 1200 -> should show as "1.2s" or "1200ms" or similar
        const latencyText =
          screen.queryByText(/1\.2s/) ||
          screen.queryByText(/1200/) ||
          screen.queryByText(/1,200/);
        expect(latencyText).toBeInTheDocument();
      });
    });

    it("uses MetricCard components (not inline card markup)", async () => {
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeedSource = (
        await import("@/pages/RealtimeFeed?raw")
      ).default;
      // The page source should import MetricCard
      // If ?raw import fails, fall back to file existence check
      if (typeof RealtimeFeedSource === "string") {
        expect(RealtimeFeedSource).toMatch(/MetricCard/);
      } else {
        // Cannot do raw import in test env -- verify via file read
        const fs = await import("fs");
        const filePath = await import("path");
        const src = fs.readFileSync(
          filePath.resolve(__dirname, "../src/pages/RealtimeFeed.tsx"),
          "utf-8",
        );
        expect(src).toMatch(/MetricCard/);
      }
    });
  });

  describe("Live traffic feed table from realtimeFeed", () => {
    beforeEach(() => {
      mockGraphQL({
        realtimeStats: createMockRealtimeStats(),
        realtimeFeed: createMockFeedItems(),
        gatewayStatus: createMockGatewayStatus(),
      });
    });

    it("renders the 'Live Traffic' section heading", async () => {
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      await waitFor(() => {
        expect(screen.getByText(/Live Traffic/i)).toBeInTheDocument();
      });
    });

    it("renders feed items with provider names", async () => {
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      await waitFor(() => {
        expect(screen.getAllByText("Anthropic").length).toBeGreaterThan(0);
        expect(screen.getAllByText("OpenAI").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Gemini").length).toBeGreaterThan(0);
      });
    });

    it("renders feed items with model names", async () => {
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      await waitFor(() => {
        expect(screen.getByText("opus-4")).toBeInTheDocument();
        expect(screen.getByText("o3")).toBeInTheDocument();
        expect(screen.getByText("gemini-2.5")).toBeInTheDocument();
      });
    });

    it("renders feed items with token counts", async () => {
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      await waitFor(() => {
        // Token count 12841 may be formatted with commas: "12,841"
        const tokenText =
          screen.queryByText("12,841") || screen.queryByText("12841");
        expect(tokenText).toBeInTheDocument();
      });
    });

    it("renders feed items with cost values", async () => {
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      await waitFor(() => {
        const costText =
          screen.queryByText("$0.38") || screen.queryByText(/0\.38/);
        expect(costText).toBeInTheDocument();
      });
    });

    it("renders feed items with HTTP status", async () => {
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      await waitFor(() => {
        expect(screen.getAllByText("200").length).toBeGreaterThan(0);
      });
    });

    it("renders feed items with framework/intent text", async () => {
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      await waitFor(() => {
        // Should show framework and intent, possibly joined
        const intentText =
          screen.queryByText(/refactor session module/i) ||
          screen.queryByText(/claude-code/i);
        expect(intentText).toBeInTheDocument();
      });
    });
  });

  describe("Provider filter buttons", () => {
    it("renders filter buttons for All, Anthropic, OpenAI, Gemini", async () => {
      mockGraphQL({
        realtimeStats: createMockRealtimeStats(),
        realtimeFeed: createMockFeedItems(),
        gatewayStatus: createMockGatewayStatus(),
      });
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: "Anthropic" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "OpenAI" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Gemini" })).toBeInTheDocument();
    });

    it("'All' filter is active by default", async () => {
      mockGraphQL({
        realtimeStats: createMockRealtimeStats(),
        realtimeFeed: createMockFeedItems(),
        gatewayStatus: createMockGatewayStatus(),
      });
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      await waitFor(() => {
        const allBtn = screen.getByRole("button", { name: "All" });
        const isActive =
          allBtn.getAttribute("aria-pressed") === "true" ||
          allBtn.className.includes("active") ||
          allBtn.getAttribute("aria-current") === "true";
        expect(isActive).toBe(true);
      });
    });

    it("clicking a provider filter button updates the active filter", async () => {
      mockGraphQL({
        realtimeStats: createMockRealtimeStats(),
        realtimeFeed: createMockFeedItems(),
        gatewayStatus: createMockGatewayStatus(),
      });
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      const user = userEvent.setup();

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
      });

      // Click "OpenAI" filter
      await user.click(screen.getByRole("button", { name: "OpenAI" }));

      // "OpenAI" should now be the active filter
      await waitFor(() => {
        const openAiBtn = screen.getByRole("button", { name: "OpenAI" });
        const isActive =
          openAiBtn.getAttribute("aria-pressed") === "true" ||
          openAiBtn.className.includes("active") ||
          openAiBtn.getAttribute("aria-current") === "true";
        expect(isActive).toBe(true);
      });
    });

    it("clicking a provider filter sends the provider to the query", async () => {
      const fetchMock = mockGraphQL({
        realtimeStats: createMockRealtimeStats(),
        realtimeFeed: createMockFeedItems(),
        gatewayStatus: createMockGatewayStatus(),
      });
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      const user = userEvent.setup();

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
      });

      // Click "Anthropic" filter
      await user.click(screen.getByRole("button", { name: "Anthropic" }));

      // Verify that a subsequent fetch was called with provider in the query variables
      await waitFor(() => {
        const calls = fetchMock.mock.calls;
        const hasProviderFilter = calls.some((call: unknown[]) => {
          const init = call[1] as RequestInit | undefined;
          if (!init?.body) return false;
          const bodyStr =
            typeof init.body === "string" ? init.body : "";
          return (
            bodyStr.includes("Anthropic") || bodyStr.includes("anthropic")
          );
        });
        expect(hasProviderFilter).toBe(true);
      });
    });
  });

  describe("Auto-refresh behavior", () => {
    it("page source configures refetchInterval for auto-refresh", async () => {
      // The Realtime Feed must use TanStack Query refetchInterval for 5s polling
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/RealtimeFeed.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/refetchInterval/);
    });
  });

  describe("Loading state", () => {
    it("shows loading indicator while data is being fetched", async () => {
      // Mock fetch that never resolves
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise(() => {})),
      );
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      // Should show a loading state (uses LoadingState component)
      await waitFor(() => {
        const loading =
          screen.queryByTestId("loading-state") ||
          screen.queryByRole("status") ||
          screen.queryByText(/loading/i);
        expect(loading).toBeInTheDocument();
      });
    });
  });

  describe("Error state", () => {
    it("shows error message when GraphQL request fails", async () => {
      mockGraphQLNetworkError();
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
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
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      await waitFor(() => {
        const error =
          screen.queryByRole("alert") ||
          screen.queryByText(/error/i) ||
          screen.queryByText(/failed/i);
        expect(error).toBeInTheDocument();
      });
    });
  });

  describe("Empty feed state", () => {
    it("shows empty state when feed has zero items", async () => {
      mockGraphQL({
        realtimeStats: createMockRealtimeStats({ requestsPerMinute: 0, activeSessions: 0 }),
        realtimeFeed: [],
        gatewayStatus: createMockGatewayStatus(),
      });
      // @ts-expect-error -- module may not exist yet
      const RealtimeFeed = (await import("@/pages/RealtimeFeed")).default;
      renderWithProviders(<RealtimeFeed />);
      await waitFor(() => {
        // Should show some empty or "no data" message
        const empty =
          screen.queryByText(/no.*traffic/i) ||
          screen.queryByText(/no.*data/i) ||
          screen.queryByText(/no.*items/i) ||
          screen.queryByText(/empty/i);
        expect(empty).toBeInTheDocument();
      });
    });
  });

  describe("Uses shared components", () => {
    it("page source imports MetricCard from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/RealtimeFeed.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*MetricCard.*from/);
    });

    it("page source imports FilterBar or filter component from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/RealtimeFeed.tsx"),
        "utf-8",
      );
      // Must use FilterBar for provider filter buttons
      expect(src).toMatch(/import.*FilterBar.*from/);
    });

    it("page source imports FeedItem or uses feed item rendering", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/RealtimeFeed.tsx"),
        "utf-8",
      );
      // Should use FeedItem component or TagPill for provider pills
      const usesFeedItem = /import.*FeedItem.*from/.test(src);
      const usesTagPill = /import.*TagPill.*from/.test(src);
      expect(usesFeedItem || usesTagPill).toBe(true);
    });
  });
});

// ============================================================
// D3.2 -- Sessions List Page
// ============================================================

describe("D3.2 -- Sessions List Page", () => {
  describe("Page rendering and header", () => {
    it("renders the 'Sessions' heading", async () => {
      mockGraphQL({
        sessions: createMockSessionConnection(),
      });
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      await waitFor(() => {
        expect(screen.getByText("Sessions")).toBeInTheDocument();
      });
    });

    it("renders a search input for sessions", async () => {
      mockGraphQL({
        sessions: createMockSessionConnection(),
      });
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      await waitFor(() => {
        const searchInput =
          screen.queryByRole("searchbox") ||
          screen.queryByPlaceholderText(/search/i);
        expect(searchInput).toBeInTheDocument();
      });
    });
  });

  describe("Session table from sessions query", () => {
    beforeEach(() => {
      mockGraphQL({
        sessions: createMockSessionConnection(),
      });
    });

    it("renders session data in a table", async () => {
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      await waitFor(() => {
        // Should render a <table> element (via DataTable component)
        expect(document.querySelector("table")).not.toBeNull();
      });
    });

    it("renders table column headers matching design", async () => {
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      await waitFor(() => {
        // The design requires these columns
        const requiredColumns = [
          /session.*id/i,
          /framework/i,
          /model/i,
          /turns/i,
          /tokens/i,
          /cost/i,
          /duration/i,
          /status/i,
        ];
        for (const pattern of requiredColumns) {
          const headers = screen.getAllByRole("columnheader");
          const found = headers.some((h) => pattern.test(h.textContent ?? ""));
          expect(found).toBe(true);
        }
      });
    });

    it("renders session IDs (truncated)", async () => {
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      await waitFor(() => {
        // Session ID "a3f8c1d42e" should be truncated to something like "a3f8c1...d42e"
        const truncated =
          screen.queryByText(/a3f8c1/) || screen.queryByText(/a3f8c1.*d42e/);
        expect(truncated).toBeInTheDocument();
      });
    });

    it("renders framework as colored pill", async () => {
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      await waitFor(() => {
        expect(screen.getAllByText("claude-code")[0]).toBeInTheDocument();
      });
    });

    it("renders model names", async () => {
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      await waitFor(() => {
        expect(screen.getByText("opus-4")).toBeInTheDocument();
      });
    });

    it("renders turn counts", async () => {
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      await waitFor(() => {
        expect(screen.getByText("34")).toBeInTheDocument();
      });
    });

    it("renders token counts", async () => {
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      await waitFor(() => {
        const tokenText =
          screen.queryByText("142,830") || screen.queryByText("142830");
        expect(tokenText).toBeInTheDocument();
      });
    });

    it("renders cost values", async () => {
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      await waitFor(() => {
        const costText =
          screen.queryByText("$4.28") || screen.queryByText(/4\.28/);
        expect(costText).toBeInTheDocument();
      });
    });

    it("renders status pills (active/completed)", async () => {
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      await waitFor(() => {
        expect(screen.getAllByText("active")[0]).toBeInTheDocument();
        expect(screen.getAllByText("completed")[0]).toBeInTheDocument();
      });
    });

    it("renders total count from SessionConnection", async () => {
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      await waitFor(() => {
        // All 5 sessions from the mock should be rendered in the table
        const rows = screen.getAllByRole("row");
        // 5 data rows + 1 header row
        expect(rows.length).toBeGreaterThanOrEqual(6);
      });
    });
  });

  describe("Filter buttons", () => {
    beforeEach(() => {
      mockGraphQL({
        sessions: createMockSessionConnection(),
      });
    });

    it("renders status filter buttons: All, Active, Completed", async () => {
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      await waitFor(() => {
        // Design calls for: All Sessions (or All), Active, Completed
        const allBtn =
          screen.queryByText("All Sessions") || screen.queryByText("All");
        expect(allBtn).toBeInTheDocument();
        expect(screen.getByText("Active")).toBeInTheDocument();
        expect(screen.getByText("Completed")).toBeInTheDocument();
      });
    });

    it("renders framework filter buttons: Claude Code, Cursor, Codex, Aider", async () => {
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      await waitFor(() => {
        expect(screen.getByText("Claude Code")).toBeInTheDocument();
        expect(screen.getByText("Cursor")).toBeInTheDocument();
        expect(screen.getByText("Codex")).toBeInTheDocument();
        expect(screen.getByText("Aider")).toBeInTheDocument();
      });
    });

    it("clicking a status filter re-fetches with status filter", async () => {
      const fetchMock = mockGraphQL({
        sessions: createMockSessionConnection(),
      });
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      const user = userEvent.setup();

      await waitFor(() => {
        expect(screen.getByText("Active")).toBeInTheDocument();
      });

      await user.click(screen.getByText("Active"));

      await waitFor(() => {
        const calls = fetchMock.mock.calls;
        const hasStatusFilter = calls.some((call: unknown[]) => {
          const init = call[1] as RequestInit | undefined;
          if (!init?.body) return false;
          const bodyStr =
            typeof init.body === "string" ? init.body : "";
          return (
            bodyStr.includes("active") ||
            bodyStr.includes("Active") ||
            bodyStr.includes("status")
          );
        });
        expect(hasStatusFilter).toBe(true);
      });
    });

    it("clicking a framework filter re-fetches with framework filter", async () => {
      const fetchMock = mockGraphQL({
        sessions: createMockSessionConnection(),
      });
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      const user = userEvent.setup();

      await waitFor(() => {
        expect(screen.getByText("Claude Code")).toBeInTheDocument();
      });

      await user.click(screen.getByText("Claude Code"));

      await waitFor(() => {
        const calls = fetchMock.mock.calls;
        const hasFrameworkFilter = calls.some((call: unknown[]) => {
          const init = call[1] as RequestInit | undefined;
          if (!init?.body) return false;
          const bodyStr =
            typeof init.body === "string" ? init.body : "";
          return (
            bodyStr.includes("claude-code") ||
            bodyStr.includes("Claude Code") ||
            bodyStr.includes("framework")
          );
        });
        expect(hasFrameworkFilter).toBe(true);
      });
    });
  });

  describe("Search functionality", () => {
    it("typing in search input triggers a re-fetch with search filter", async () => {
      const fetchMock = mockGraphQL({
        sessions: createMockSessionConnection(),
      });
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      const user = userEvent.setup();

      await waitFor(() => {
        const searchInput =
          screen.queryByRole("searchbox") ||
          screen.queryByPlaceholderText(/search/i);
        expect(searchInput).toBeInTheDocument();
      });

      const searchInput = (
        screen.queryByRole("searchbox") ||
        screen.queryByPlaceholderText(/search/i)
      )!;

      await user.type(searchInput, "websocket");

      // Search is debounced, so wait for the fetch to fire
      await waitFor(
        () => {
          const calls = fetchMock.mock.calls;
          const hasSearchFilter = calls.some((call: unknown[]) => {
            const init = call[1] as RequestInit | undefined;
            if (!init?.body) return false;
            const bodyStr =
              typeof init.body === "string" ? init.body : "";
            return bodyStr.includes("websocket");
          });
          expect(hasSearchFilter).toBe(true);
        },
        { timeout: 2000 },
      );
    });
  });

  describe("Row navigation to session detail", () => {
    it("clicking a session row navigates to /sessions/:id", async () => {
      mockGraphQL({
        sessions: createMockSessionConnection(),
        session: createMockSessionWithTurns(),
      });
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;

      // We need to render with Routes to test navigation
      // Either the session detail is a separate route or inline
      const { container } = renderWithProviders(
        <Routes>
          <Route path="/sessions" element={<Sessions />} />
          <Route
            path="/sessions/:id"
            element={<div data-testid="session-detail-page">Detail</div>}
          />
        </Routes>,
        { route: "/sessions" },
      );

      await waitFor(() => {
        const truncated =
          screen.queryByText(/a3f8c1/) || screen.queryByText(/a3f8c1.*d42e/);
        expect(truncated).toBeInTheDocument();
      });

      // Click the first session row
      const firstRow = screen.getAllByRole("row")[1]; // [0] is header
      if (firstRow) {
        await userEvent.setup().click(firstRow);
      }

      // Should navigate to the detail page OR show inline detail
      await waitFor(() => {
        const detailPage =
          screen.queryByTestId("session-detail-page") ||
          screen.queryByText(/back to sessions/i) ||
          screen.queryByText(/session a3f8c1/i);
        expect(detailPage).toBeInTheDocument();
      });
    });

    it("session rows are keyboard-accessible (Enter key navigates)", async () => {
      mockGraphQL({
        sessions: createMockSessionConnection(),
        session: createMockSessionWithTurns(),
      });
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;

      renderWithProviders(
        <Routes>
          <Route path="/sessions" element={<Sessions />} />
          <Route
            path="/sessions/:id"
            element={<div data-testid="session-detail-page">Detail</div>}
          />
        </Routes>,
        { route: "/sessions" },
      );

      await waitFor(() => {
        const rows = screen.getAllByRole("row");
        expect(rows.length).toBeGreaterThan(1); // header + data rows
      });

      // Data rows should be focusable (tabIndex or link)
      const dataRows = screen.getAllByRole("row").slice(1);
      if (dataRows.length > 0) {
        const row = dataRows[0];
        const isFocusable =
          row.hasAttribute("tabindex") ||
          row.querySelector("a") !== null ||
          row.style.cursor === "pointer";
        expect(isFocusable).toBe(true);
      }
    });
  });

  describe("Pagination", () => {
    it("renders pagination controls when total exceeds page size", async () => {
      // Create enough sessions to require pagination
      const manySessions = Array.from({ length: 25 }, (_, i) =>
        createMockSession({
          id: `session-${i}`,
          initialIntent: `Task ${i}`,
        }),
      );
      mockGraphQL({
        sessions: createMockSessionConnection(manySessions, 25),
      });
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      await waitFor(() => {
        const pagination =
          screen.queryByLabelText(/pagination/i) ||
          screen.queryByText(/next/i) ||
          screen.queryByText(/prev/i) ||
          screen.queryByText("2");
        expect(pagination).toBeInTheDocument();
      });
    });

    it("clicking next page requests the next offset", async () => {
      const manySessions = Array.from({ length: 25 }, (_, i) =>
        createMockSession({
          id: `session-${i}`,
          initialIntent: `Task ${i}`,
        }),
      );
      const fetchMock = mockGraphQL({
        sessions: createMockSessionConnection(manySessions, 25),
      });
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      const user = userEvent.setup();

      await waitFor(() => {
        const nextBtn =
          screen.queryByText(/next/i) ||
          screen.queryByLabelText(/next/i) ||
          screen.queryByText("2");
        expect(nextBtn).toBeInTheDocument();
      });

      const nextBtn =
        screen.queryByText(/next/i) ||
        screen.queryByLabelText(/next/i) ||
        screen.queryByText("2");
      if (nextBtn) {
        await user.click(nextBtn);
        await waitFor(() => {
          const calls = fetchMock.mock.calls;
          const hasOffset = calls.some((call: unknown[]) => {
            const init = call[1] as RequestInit | undefined;
            if (!init?.body) return false;
            const bodyStr =
              typeof init.body === "string" ? init.body : "";
            return bodyStr.includes("offset");
          });
          expect(hasOffset).toBe(true);
        });
      }
    });
  });

  describe("Loading state", () => {
    it("shows loading indicator while sessions are being fetched", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise(() => {})),
      );
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      await waitFor(() => {
        const loading =
          screen.queryByTestId("loading-state") ||
          screen.queryByRole("status") ||
          screen.queryByText(/loading/i);
        expect(loading).toBeInTheDocument();
      });
    });
  });

  describe("Error state", () => {
    it("shows error when sessions query fails", async () => {
      mockGraphQLNetworkError();
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      await waitFor(() => {
        const error =
          screen.queryByRole("alert") ||
          screen.queryByText(/error/i) ||
          screen.queryByText(/failed/i);
        expect(error).toBeInTheDocument();
      });
    });
  });

  describe("Empty state", () => {
    it("shows empty state when no sessions exist", async () => {
      mockGraphQL({
        sessions: createMockSessionConnection([], 0),
      });
      // @ts-expect-error -- module may not exist yet
      const Sessions = (await import("@/pages/Sessions")).default;
      renderWithProviders(<Sessions />);
      await waitFor(() => {
        const empty =
          screen.queryByText(/no.*sessions/i) ||
          screen.queryByText(/no.*data/i) ||
          screen.queryByText(/empty/i);
        expect(empty).toBeInTheDocument();
      });
    });
  });

  describe("Uses shared components", () => {
    it("page source imports DataTable from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/Sessions.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*DataTable.*from/);
    });

    it("page source imports SearchInput from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/Sessions.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*SearchInput.*from/);
    });

    it("page source imports FilterBar from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/Sessions.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*FilterBar.*from/);
    });

    it("page source imports Pagination from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/Sessions.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*Pagination.*from/);
    });

    it("page source imports TagPill from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/Sessions.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*TagPill.*from/);
    });
  });
});

// ============================================================
// D3.3 -- Session Detail Page
// ============================================================

describe("D3.3 -- Session Detail Page", () => {
  /**
   * The session detail might be:
   * (a) A separate page at /sessions/:id (SessionDetail.tsx)
   * (b) An inline view within Sessions.tsx
   * Tests accommodate both patterns.
   */

  async function importSessionDetailPage() {
    // Try SessionDetail.tsx first, then fall back to Sessions.tsx
    try {
      // @ts-expect-error -- module may not exist yet
      return (await import("@/pages/SessionDetail")).default;
    } catch {
      // @ts-expect-error -- module may not exist yet
      return (await import("@/pages/Sessions")).default;
    }
  }

  /**
   * Render session detail -- handles both separate page and inline patterns.
   */
  function renderSessionDetail(sessionData: ReturnType<typeof createMockSessionWithTurns>) {
    const fetchMock = mockGraphQL({
      session: sessionData,
      sessions: createMockSessionConnection(),
    });
    return { fetchMock };
  }

  function getSessionMetaGrid() {
    const metaGrid = document.querySelector(".session-meta-grid");
    expect(metaGrid).not.toBeNull();
    return metaGrid as HTMLElement;
  }

  function getFirstTurnTrigger() {
    const trigger =
      screen.queryByRole("button", { expanded: false }) ??
      document.querySelector("[aria-expanded='false']");
    expect(trigger).not.toBeNull();
    return trigger as HTMLElement;
  }

  describe("Back link and header", () => {
    it("renders a back link to sessions list", async () => {
      mockGraphQL({
        session: createMockSessionWithTurns(),
        sessions: createMockSessionConnection(),
      });
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
          <Route path="/sessions" element={<div>Sessions List</div>} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      await waitFor(() => {
        const backLink =
          screen.queryByText(/back to sessions/i) ||
          screen.queryByText(/\u2190.*sessions/i) ||
          screen.queryByLabelText(/back/i);
        expect(backLink).toBeInTheDocument();
      });
    });

    it("renders session ID in the heading", async () => {
      mockGraphQL({
        session: createMockSessionWithTurns(),
        sessions: createMockSessionConnection(),
      });
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      await waitFor(() => {
        // Should show truncated session ID: "Session a3f8c1...d42e" or similar
        const heading =
          screen.queryByText(/session.*a3f8c1/i) ||
          screen.queryByText(/a3f8c1.*d42e/i);
        expect(heading).toBeInTheDocument();
      });
    });

    it("renders status pill in the header", async () => {
      mockGraphQL({
        session: createMockSessionWithTurns(),
        sessions: createMockSessionConnection(),
      });
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      await waitFor(() => {
        expect(screen.getByText("active")).toBeInTheDocument();
      });
    });

    it("renders an 'Export Session' button", async () => {
      mockGraphQL({
        session: createMockSessionWithTurns(),
        sessions: createMockSessionConnection(),
      });
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      await waitFor(() => {
        const exportBtn =
          screen.queryByText(/export session/i) ||
          screen.queryByRole("button", { name: /export/i });
        expect(exportBtn).toBeInTheDocument();
      });
    });
  });

  describe("Metadata grid", () => {
    beforeEach(() => {
      mockGraphQL({
        session: createMockSessionWithTurns(),
        sessions: createMockSessionConnection(),
      });
    });

    it("renders the metadata grid with all required fields", async () => {
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );

      // The design doc specifies 14 metadata fields in the grid
      const metadataLabels = [
        /session.*id/i,
        /framework/i,
        /provider/i,
        /model/i,
        /started/i,
        /last.*active/i,
        /total.*turns/i,
        /total.*tokens/i,
        /total.*cost/i,
        /cache.*read/i,
        /account.*uuid/i,
        /device.*id/i,
        /system.*prompt.*hash/i,
        /transport/i,
      ];

      await waitFor(() => {
        const metaGrid = within(getSessionMetaGrid());
        for (const pattern of metadataLabels) {
          const el = metaGrid.queryByText(pattern);
          expect(el).toBeInTheDocument();
        }
      });
    });

    it("renders Session ID value", async () => {
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      await waitFor(() => {
        expect(within(getSessionMetaGrid()).getByText(/a3f8c1d42e/)).toBeInTheDocument();
      });
    });

    it("renders Framework value", async () => {
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      await waitFor(() => {
        expect(within(getSessionMetaGrid()).getByText("claude-code")).toBeInTheDocument();
      });
    });

    it("renders Provider value", async () => {
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      await waitFor(() => {
        expect(within(getSessionMetaGrid()).getByText("Anthropic")).toBeInTheDocument();
      });
    });

    it("renders Model value", async () => {
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      await waitFor(() => {
        expect(within(getSessionMetaGrid()).getByText("opus-4")).toBeInTheDocument();
      });
    });

    it("renders token count", async () => {
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      await waitFor(() => {
        const tokenText =
          within(getSessionMetaGrid()).queryByText("142,830") ||
          within(getSessionMetaGrid()).queryByText("142830");
        expect(tokenText).toBeInTheDocument();
      });
    });

    it("renders cost value", async () => {
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      await waitFor(() => {
        const costText =
          within(getSessionMetaGrid()).queryByText("$4.28") ||
          within(getSessionMetaGrid()).queryByText(/4\.28/);
        expect(costText).toBeInTheDocument();
      });
    });

    it("renders Account UUID value", async () => {
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      await waitFor(() => {
        expect(within(getSessionMetaGrid()).getByText("acct-uuid-001")).toBeInTheDocument();
      });
    });

    it("renders Device ID value", async () => {
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      await waitFor(() => {
        expect(within(getSessionMetaGrid()).getByText("device-001")).toBeInTheDocument();
      });
    });

    it("renders System Prompt Hash value", async () => {
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      await waitFor(() => {
        expect(
          within(getSessionMetaGrid()).getByText(/sha256:abc123def456/),
        ).toBeInTheDocument();
      });
    });

    it("renders Cache Read tokens value", async () => {
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      await waitFor(() => {
        const cacheText =
          within(getSessionMetaGrid()).queryByText("12,000") ||
          within(getSessionMetaGrid()).queryByText("12000");
        expect(cacheText).toBeInTheDocument();
      });
    });
  });

  describe("Turn list with expandable rows", () => {
    beforeEach(() => {
      mockGraphQL({
        session: createMockSessionWithTurns(),
        sessions: createMockSessionConnection(),
      });
    });

    it("renders turn rows showing collapsed summary", async () => {
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      await waitFor(() => {
        // Should show sequence numbers for turns
        expect(screen.getByText("1")).toBeInTheDocument();
        // Should show user request text (truncated)
        const requestText =
          screen.queryByText(/refactor.*session/i) ||
          screen.queryByText(/Refactor/i);
        expect(requestText).toBeInTheDocument();
      });
    });

    it("collapsed turn shows timestamp, model, tokens, cost, latency, status", async () => {
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      await waitFor(() => {
        const turnRow = within(getFirstTurnTrigger());
        // Model should appear
        expect(turnRow.getByText("opus-4")).toBeInTheDocument();
        // Token count for this turn (3500)
        const tokenText =
          turnRow.queryByText("3,500") || turnRow.queryByText("3500");
        expect(tokenText).toBeInTheDocument();
        // Cost for this turn ($0.10)
        const costText =
          turnRow.queryByText("$0.10") || turnRow.queryByText(/0\.10/);
        expect(costText).toBeInTheDocument();
      });
    });

    it("clicking a turn row expands it to show details", async () => {
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      const user = userEvent.setup();

      await waitFor(() => {
        const requestText =
          screen.queryByText(/refactor.*session/i) ||
          screen.queryByText(/Refactor/i);
        expect(requestText).toBeInTheDocument();
      });

      // Find the expandable trigger (button with aria-expanded)
      const expandTrigger =
        getFirstTurnTrigger() ??
        document.querySelector(".turn-row, [class*='turn'], [class*='row']");

      if (expandTrigger) {
        await user.click(expandTrigger as HTMLElement);
      }

      // After expansion, the full user request should be visible
      await waitFor(() => {
        expect(
          screen.getAllByText(
            /Refactor the session module to use metadata-based identity/,
          ).length,
        ).toBeGreaterThan(0);
      });
    });

    it("expanded turn shows full user request text", async () => {
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      const user = userEvent.setup();

      await waitFor(() => {
        expect(screen.getByText("1")).toBeInTheDocument();
      });

      // Expand first turn
      const expandTrigger = getFirstTurnTrigger();
      if (expandTrigger) {
        await user.click(expandTrigger);
      }

      await waitFor(() => {
        expect(
          screen.getAllByText(
            /Refactor the session module to use metadata-based identity/,
          ).length,
        ).toBeGreaterThan(0);
      });
    });

    it("expanded turn shows response text", async () => {
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      const user = userEvent.setup();

      await waitFor(() => {
        expect(screen.getByText("1")).toBeInTheDocument();
      });

      // Expand first turn
      const expandTrigger = getFirstTurnTrigger();
      if (expandTrigger) {
        await user.click(expandTrigger);
      }

      await waitFor(() => {
        expect(
          screen.getByText(
            /I will refactor the session module to derive session identity from metadata/,
          ),
        ).toBeInTheDocument();
      });
    });

    it("expanded turn shows thinking text", async () => {
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      const user = userEvent.setup();

      await waitFor(() => {
        expect(screen.getByText("1")).toBeInTheDocument();
      });

      const expandTrigger = getFirstTurnTrigger();
      if (expandTrigger) {
        await user.click(expandTrigger);
      }

      await waitFor(() => {
        expect(
          screen.getByText(/Analyzing the current session identity logic/),
        ).toBeInTheDocument();
      });
    });

    it("expanded turn shows chain of custody hashes (request + response)", async () => {
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      const user = userEvent.setup();

      await waitFor(() => {
        expect(screen.getByText("1")).toBeInTheDocument();
      });

      const expandTrigger = getFirstTurnTrigger();
      if (expandTrigger) {
        await user.click(expandTrigger);
      }

      await waitFor(() => {
        // Should show request hash and response hash
        expect(
          screen.getByText(/sha256:e8f4a2b1c3d5/),
        ).toBeInTheDocument();
        expect(
          screen.getByText(/sha256:7c3d9f01a2b4/),
        ).toBeInTheDocument();
      });
    });

    it("expanded turn shows token breakdown (input/output/thinking)", async () => {
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      const user = userEvent.setup();

      await waitFor(() => {
        expect(screen.getByText("1")).toBeInTheDocument();
      });

      const expandTrigger = getFirstTurnTrigger();
      if (expandTrigger) {
        await user.click(expandTrigger);
      }

      await waitFor(() => {
        // Should show input, output, and thinking token counts
        // inputTokens: 2000, outputTokens: 1000, thinkingTokens: 500
        const inputText =
          screen.queryByText("2,000") || screen.queryByText("2000");
        const outputText =
          screen.queryByText("1,000") || screen.queryByText("1000");
        // At least input and output token counts should be visible
        expect(inputText).toBeInTheDocument();
        expect(outputText).toBeInTheDocument();
      });
    });
  });

  describe("Turn list pagination", () => {
    it("paginates turns (10 per page) when session has many turns", async () => {
      const manyTurns = Array.from({ length: 15 }, (_, i) =>
        createMockTurn({
          id: `turn-${i + 1}`,
          sequenceNum: i + 1,
          userRequestText: `User request number ${i + 1}`,
        }),
      );
      const session = createMockSession({ totalTurns: 15 });

      mockGraphQL({
        session: { ...session, turns: manyTurns },
        sessions: createMockSessionConnection(),
      });
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );

      await waitFor(() => {
        // Should show pagination when >10 turns
        const pagination =
          screen.queryByLabelText(/pagination/i) ||
          screen.queryByText(/next/i) ||
          screen.queryByText("2");
        expect(pagination).toBeInTheDocument();
      });
    });
  });

  describe("Expand All / Collapse All toggle", () => {
    it("renders an 'Expand All' or 'Collapse All' toggle button", async () => {
      mockGraphQL({
        session: createMockSessionWithTurns(),
        sessions: createMockSessionConnection(),
      });
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      await waitFor(() => {
        const toggleBtn =
          screen.queryByText(/expand all/i) ||
          screen.queryByText(/collapse all/i) ||
          screen.queryByRole("button", { name: /expand/i }) ||
          screen.queryByRole("button", { name: /collapse/i });
        expect(toggleBtn).toBeInTheDocument();
      });
    });

    it("clicking 'Expand All' reveals details for all turns", async () => {
      mockGraphQL({
        session: createMockSessionWithTurns(),
        sessions: createMockSessionConnection(),
      });
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      const user = userEvent.setup();

      await waitFor(() => {
        const expandAll =
          screen.queryByText(/expand all/i) ||
          screen.queryByRole("button", { name: /expand/i });
        expect(expandAll).toBeInTheDocument();
      });

      const expandAll = (
        screen.queryByText(/expand all/i) ||
        screen.queryByRole("button", { name: /expand/i })
      )!;
      await user.click(expandAll);

      await waitFor(() => {
        // All turn details should be visible -- verify multiple user request texts
        expect(
          screen.getAllByText(
            /Refactor the session module to use metadata-based identity/,
          ).length,
        ).toBeGreaterThan(0);
        expect(
          screen.getAllByText(/Now add JWT token validation/).length,
        ).toBeGreaterThan(0);
        expect(
          screen.getAllByText(/Write tests for the auth module/).length,
        ).toBeGreaterThan(0);
      });
    });
  });

  describe("Loading state", () => {
    it("shows loading while session data is fetched", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise(() => {})),
      );
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      await waitFor(() => {
        const loading =
          screen.queryByTestId("loading-state") ||
          screen.queryByRole("status") ||
          screen.queryByText(/loading/i);
        expect(loading).toBeInTheDocument();
      });
    });
  });

  describe("Error state", () => {
    it("shows error when session query fails", async () => {
      mockGraphQLNetworkError();
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/a3f8c1d42e" },
      );
      await waitFor(() => {
        const error =
          screen.queryByRole("alert") ||
          screen.queryByText(/error/i) ||
          screen.queryByText(/failed/i);
        expect(error).toBeInTheDocument();
      });
    });

    it("shows appropriate message when session is not found (null response)", async () => {
      mockGraphQL({
        session: null,
        sessions: createMockSessionConnection(),
      });
      const SessionDetail = await importSessionDetailPage();
      renderWithProviders(
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>,
        { route: "/sessions/nonexistent-id" },
      );
      await waitFor(() => {
        const notFound =
          screen.queryByText(/not found/i) ||
          screen.queryByText(/no session/i) ||
          screen.queryByText(/does not exist/i) ||
          screen.queryByRole("alert");
        expect(notFound).toBeInTheDocument();
      });
    });
  });

  describe("Uses shared components", () => {
    it("page source imports ExpandableRow from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      // Check both possible locations
      let src: string;
      try {
        src = fs.readFileSync(
          path.resolve(__dirname, "../src/pages/SessionDetail.tsx"),
          "utf-8",
        );
      } catch {
        src = fs.readFileSync(
          path.resolve(__dirname, "../src/pages/Sessions.tsx"),
          "utf-8",
        );
      }
      expect(src).toMatch(/import.*ExpandableRow.*from/);
    });

    it("page source imports TagPill from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      let src: string;
      try {
        src = fs.readFileSync(
          path.resolve(__dirname, "../src/pages/SessionDetail.tsx"),
          "utf-8",
        );
      } catch {
        src = fs.readFileSync(
          path.resolve(__dirname, "../src/pages/Sessions.tsx"),
          "utf-8",
        );
      }
      expect(src).toMatch(/import.*TagPill.*from/);
    });

    it("page source imports Pagination from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      let src: string;
      try {
        src = fs.readFileSync(
          path.resolve(__dirname, "../src/pages/SessionDetail.tsx"),
          "utf-8",
        );
      } catch {
        src = fs.readFileSync(
          path.resolve(__dirname, "../src/pages/Sessions.tsx"),
          "utf-8",
        );
      }
      expect(src).toMatch(/import.*Pagination.*from/);
    });

    it("page source imports LoadingState or ErrorState from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      let src: string;
      try {
        src = fs.readFileSync(
          path.resolve(__dirname, "../src/pages/SessionDetail.tsx"),
          "utf-8",
        );
      } catch {
        src = fs.readFileSync(
          path.resolve(__dirname, "../src/pages/Sessions.tsx"),
          "utf-8",
        );
      }
      const hasLoading = /import.*LoadingState.*from/.test(src);
      const hasError = /import.*ErrorState.*from/.test(src);
      expect(hasLoading || hasError).toBe(true);
    });
  });
});

// ============================================================
// D3 Cross-cutting: Route wiring in App.tsx
// ============================================================

describe("D3 -- Route wiring", () => {
  it("App.tsx has a route for /sessions/:id (session detail)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/App.tsx"),
      "utf-8",
    );
    // Should have a route with :id parameter for session detail
    const hasDetailRoute =
      src.includes("/sessions/:id") || src.includes("sessions/:id");
    expect(hasDetailRoute).toBe(true);
  });

  it("App.tsx wraps routes in QueryClientProvider", async () => {
    const fs = await import("fs");
    const path = await import("path");
    // Check App.tsx or main.tsx for QueryClientProvider
    const appSrc = fs.readFileSync(
      path.resolve(__dirname, "../src/App.tsx"),
      "utf-8",
    );
    let mainSrc = "";
    try {
      mainSrc = fs.readFileSync(
        path.resolve(__dirname, "../src/main.tsx"),
        "utf-8",
      );
    } catch {
      // main.tsx might not exist yet
    }
    const hasQueryProvider =
      appSrc.includes("QueryClientProvider") ||
      mainSrc.includes("QueryClientProvider");
    expect(hasQueryProvider).toBe(true);
  });
});

// ============================================================
// D3 Cross-cutting: GraphQL queries used by pages
// ============================================================

describe("D3 -- GraphQL query usage", () => {
  it("RealtimeFeed uses realtimeStats query", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/pages/RealtimeFeed.tsx"),
      "utf-8",
    );
    expect(src).toMatch(/realtimeStats/);
  });

  it("RealtimeFeed uses realtimeFeed query", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/pages/RealtimeFeed.tsx"),
      "utf-8",
    );
    expect(src).toMatch(/realtimeFeed/);
  });

  it("RealtimeFeed uses gatewayStatus query", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/pages/RealtimeFeed.tsx"),
      "utf-8",
    );
    expect(src).toMatch(/gatewayStatus/);
  });

  it("Sessions uses sessions query with SessionFilter", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/pages/Sessions.tsx"),
      "utf-8",
    );
    expect(src).toMatch(/sessions/);
    // Should pass filter variables
    const hasFilter =
      src.includes("SessionFilter") ||
      src.includes("filter") ||
      src.includes("variables");
    expect(hasFilter).toBe(true);
  });

  it("Session detail uses session(id) query", async () => {
    const fs = await import("fs");
    const path = await import("path");
    let src: string;
    try {
      src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/SessionDetail.tsx"),
        "utf-8",
      );
    } catch {
      src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/Sessions.tsx"),
        "utf-8",
      );
    }
    // Should query session by ID
    const hasSessionQuery =
      src.includes("session(") ||
      src.includes("session(id") ||
      src.includes("useQuery") ||
      src.includes("graphql");
    expect(hasSessionQuery).toBe(true);
  });

  it("Pages use TanStack Query (useQuery) for data fetching", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const realtimeSrc = fs.readFileSync(
      path.resolve(__dirname, "../src/pages/RealtimeFeed.tsx"),
      "utf-8",
    );
    const sessionsSrc = fs.readFileSync(
      path.resolve(__dirname, "../src/pages/Sessions.tsx"),
      "utf-8",
    );
    // Both pages should import useQuery from TanStack Query
    expect(realtimeSrc).toMatch(/useQuery/);
    expect(sessionsSrc).toMatch(/useQuery/);
  });
});
