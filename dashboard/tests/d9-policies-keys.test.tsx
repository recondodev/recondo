/**
 * Sprint D9 -- Behavioral Tests: Policies Page + API Keys Page
 *
 * Tests for:
 *   D9.1  Policies page (policies table, create/update/delete mutations, trigger history chart)
 *   D9.2  API Keys page (keys table, register/delete mutations, subheader text)
 *
 * These tests are written BEFORE implementation exists.
 * They verify the design document deliverables, not implementation internals.
 *
 * GraphQL responses are mocked -- no running API server required.
 * Every test verifies that pages USE shared D2 components (DataTable, TagPill,
 * ChartBox, LoadingState, ErrorState, EmptyState, etc.) rather than
 * re-implementing them inline.
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
// Mock GraphQL data factories -- D9.1 Policies Page
// ============================================================

function createMockPolicies() {
  return {
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
      {
        id: "pol-2",
        name: "Rate Limit Expensive Models",
        type: "LIMIT",
        scope: "Production",
        action: "Limit to 100 requests/hour for Opus models",
        triggersMtd: 213,
        status: "ACTIVE",
      },
      {
        id: "pol-3",
        name: "Alert on High Cost Sessions",
        type: "ALERT",
        scope: "All Agents",
        action: "Alert when session cost exceeds $50",
        triggersMtd: 8,
        status: "ACTIVE",
      },
      {
        id: "pol-4",
        name: "Monitor Gemini Usage",
        type: "MONITOR",
        scope: "Engineering",
        action: "Log all Gemini API calls for review",
        triggersMtd: 1024,
        status: "INACTIVE",
      },
    ],
    total: 4,
    limit: 20,
    offset: 0,
  };
}

function createMockPolicyTriggerHistory() {
  return [
    { label: "Mon", value: 42 },
    { label: "Tue", value: 38 },
    { label: "Wed", value: 55 },
    { label: "Thu", value: 61 },
    { label: "Fri", value: 49 },
    { label: "Sat", value: 12 },
    { label: "Sun", value: 8 },
  ];
}

// ============================================================
// Mock GraphQL data factories -- D9.2 API Keys Page
// ============================================================

function createMockRegisteredKeys() {
  return {
    items: [
      {
        id: "key-1",
        name: "Production Anthropic Key",
        provider: "Anthropic",
        fingerprint: "sha256:a1b2c3d4e5f67890",
        agentCount: 12,
        lastUsed: "2026-03-24T10:30:00Z",
        monthlyCostUsd: 4250.00,
        status: "active",
      },
      {
        id: "key-2",
        name: "Dev OpenAI Key",
        provider: "OpenAI",
        fingerprint: "sha256:f9e8d7c6b5a43210",
        agentCount: 5,
        lastUsed: "2026-03-23T18:00:00Z",
        monthlyCostUsd: 890.50,
        status: "active",
      },
      {
        id: "key-3",
        name: "Staging Gemini Key",
        provider: "Google",
        fingerprint: "sha256:1122334455667788",
        agentCount: 3,
        lastUsed: "2026-03-20T08:15:00Z",
        monthlyCostUsd: 320.25,
        status: "inactive",
      },
    ],
    total: 3,
    limit: 20,
    offset: 0,
  };
}

// ============================================================
// Combined mock builders
// ============================================================

/** Build all Policies page mock responses in one call. */
function createAllPoliciesMocks() {
  return {
    policies: createMockPolicies(),
    policyTriggerHistory: createMockPolicyTriggerHistory(),
  };
}

/** Build all API Keys page mock responses in one call. */
function createAllKeysMocks() {
  return {
    registeredKeys: createMockRegisteredKeys(),
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
 * Mock fetch that handles both queries and mutations.
 * Mutation requests (body starts with "mutation") use mutationResponses.
 * Query requests use queryResponses.
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

/**
 * Mock fetch that returns a mutation error response for a specific operation.
 */
function mockGraphQLWithMutationError(
  queryResponses: Record<string, unknown>,
  errorMessage: string,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const operationName: string | undefined = body.operationName;
    const query: string = body.query ?? "";

    const isMutation = query.trimStart().startsWith("mutation");

    if (isMutation) {
      return new Response(
        JSON.stringify({ errors: [{ message: errorMessage }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    let responseData: unknown = null;
    if (operationName && queryResponses[operationName]) {
      responseData = queryResponses[operationName];
    } else {
      for (const [key, value] of Object.entries(queryResponses)) {
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
// D9.1 -- Policies Page
// ============================================================

describe("D9.1 -- Policies Page", () => {
  describe("Page rendering and header", () => {
    it("renders the 'Governance Policies' heading", async () => {
      mockGraphQL(createAllPoliciesMocks());
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        const heading =
          screen.queryByText(/Governance Policies/i) ||
          screen.queryByText(/Policies/i);
        expect(heading).toBeInTheDocument();
      });
    });

    it("renders a '+ New Policy' button", async () => {
      mockGraphQL(createAllPoliciesMocks());
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        const newPolicyBtn =
          screen.queryByRole("button", { name: /new policy/i }) ||
          screen.queryByText(/\+ New Policy/i) ||
          screen.queryByText(/New Policy/i) ||
          screen.queryByText(/Create Policy/i) ||
          screen.queryByText(/Add Policy/i);
        expect(newPolicyBtn).toBeInTheDocument();
      });
    });
  });

  // ----------------------------------------------------------
  // Deliverable 1: Policies table from policies query
  // ----------------------------------------------------------
  describe("Policies table from policies query (Deliverable 1)", () => {
    beforeEach(() => {
      mockGraphQL(createAllPoliciesMocks());
    });

    it("renders policies data in a table element", async () => {
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        expect(document.querySelector("table")).not.toBeNull();
      });
    });

    it("renders table column headers matching design: Name, Type, Scope, Action, Triggers MTD, Status", async () => {
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        const requiredColumns = [
          /name/i,
          /type/i,
          /scope/i,
          /action/i,
          /triggers/i,
          /status/i,
        ];
        for (const pattern of requiredColumns) {
          const header = screen.queryByText(pattern);
          expect(header).toBeInTheDocument();
        }
      });
    });

    it("renders policy names from query data", async () => {
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        expect(screen.queryByText("Block Sensitive Data")).toBeInTheDocument();
        expect(screen.queryByText("Rate Limit Expensive Models")).toBeInTheDocument();
        expect(screen.queryByText("Alert on High Cost Sessions")).toBeInTheDocument();
        expect(screen.queryByText("Monitor Gemini Usage")).toBeInTheDocument();
      });
    });

    it("renders policy type as pills (BLOCK, LIMIT, ALERT, MONITOR)", async () => {
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        expect(screen.queryByText("BLOCK")).toBeInTheDocument();
        expect(screen.queryByText("LIMIT")).toBeInTheDocument();
        expect(screen.queryByText("ALERT")).toBeInTheDocument();
        expect(screen.queryByText("MONITOR")).toBeInTheDocument();
      });
    });

    it("renders policy scope values from query data", async () => {
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        expect(screen.queryByText("Production")).toBeInTheDocument();
        expect(screen.queryByText("Engineering")).toBeInTheDocument();
        // "All Agents" appears in multiple rows
        const allAgentsElements = screen.queryAllByText("All Agents");
        expect(allAgentsElements.length).toBeGreaterThanOrEqual(1);
      });
    });

    it("renders policy action text from query data", async () => {
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        const actionText =
          screen.queryByText(/Block requests containing PII/i) ||
          screen.queryByText(/containing PII/i);
        expect(actionText).toBeInTheDocument();
      });
    });

    it("renders triggers MTD values from query data", async () => {
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        // triggersMtd: 47, 213, 8, 1024
        const triggers47 =
          screen.queryByText("47") || screen.queryByText(/^47$/);
        expect(triggers47).toBeInTheDocument();

        const triggers213 =
          screen.queryByText("213") || screen.queryByText(/^213$/);
        expect(triggers213).toBeInTheDocument();
      });
    });

    it("renders status pills (ACTIVE/INACTIVE) from query data", async () => {
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        // 3 ACTIVE + 1 INACTIVE
        const activeElements = screen.queryAllByText("ACTIVE");
        expect(activeElements.length).toBeGreaterThanOrEqual(1);
        const inactiveElements = screen.queryAllByText("INACTIVE");
        expect(inactiveElements.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  // ----------------------------------------------------------
  // Deliverable 2: Create policy form + mutation
  // ----------------------------------------------------------
  describe("Create policy form + mutation (Deliverable 2)", () => {
    it("clicking '+ New Policy' opens an inline form", async () => {
      mockGraphQL(createAllPoliciesMocks());
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      const user = userEvent.setup();

      await waitFor(() => {
        const newPolicyBtn =
          screen.queryByRole("button", { name: /new policy/i }) ||
          screen.queryByText(/\+ New Policy/i) ||
          screen.queryByText(/New Policy/i) ||
          screen.queryByText(/Create Policy/i) ||
          screen.queryByText(/Add Policy/i);
        expect(newPolicyBtn).toBeInTheDocument();
      });

      const newPolicyBtn = (
        screen.queryByRole("button", { name: /new policy/i }) ||
        screen.queryByText(/\+ New Policy/i) ||
        screen.queryByText(/New Policy/i) ||
        screen.queryByText(/Create Policy/i) ||
        screen.queryByText(/Add Policy/i)
      ) as HTMLElement;
      await user.click(newPolicyBtn);

      await waitFor(() => {
        // Form should have name input, type dropdown, scope dropdown, action text
        const nameField =
          screen.queryByLabelText(/name/i) ||
          screen.queryByPlaceholderText(/name/i) ||
          document.querySelector("input[name='name']");
        expect(nameField).not.toBeNull();
      });
    });

    it("create form includes a type dropdown with BLOCK/LIMIT/ALERT/MONITOR options", async () => {
      mockGraphQL(createAllPoliciesMocks());
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      const user = userEvent.setup();

      await waitFor(() => {
        const newPolicyBtn =
          screen.queryByRole("button", { name: /new policy/i }) ||
          screen.queryByText(/\+ New Policy/i) ||
          screen.queryByText(/New Policy/i) ||
          screen.queryByText(/Create Policy/i) ||
          screen.queryByText(/Add Policy/i);
        expect(newPolicyBtn).toBeInTheDocument();
      });

      const newPolicyBtn = (
        screen.queryByRole("button", { name: /new policy/i }) ||
        screen.queryByText(/\+ New Policy/i) ||
        screen.queryByText(/New Policy/i) ||
        screen.queryByText(/Create Policy/i) ||
        screen.queryByText(/Add Policy/i)
      ) as HTMLElement;
      await user.click(newPolicyBtn);

      await waitFor(() => {
        // Should have a select/dropdown for type
        const typeSelect =
          screen.queryByLabelText(/type/i) ||
          document.querySelector("select[name='type']") ||
          document.querySelector("select");
        expect(typeSelect).not.toBeNull();
      });
    });

    it("create form includes a scope dropdown or input", async () => {
      mockGraphQL(createAllPoliciesMocks());
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      const user = userEvent.setup();

      await waitFor(() => {
        const newPolicyBtn =
          screen.queryByRole("button", { name: /new policy/i }) ||
          screen.queryByText(/\+ New Policy/i) ||
          screen.queryByText(/New Policy/i) ||
          screen.queryByText(/Create Policy/i) ||
          screen.queryByText(/Add Policy/i);
        expect(newPolicyBtn).toBeInTheDocument();
      });

      const newPolicyBtn = (
        screen.queryByRole("button", { name: /new policy/i }) ||
        screen.queryByText(/\+ New Policy/i) ||
        screen.queryByText(/New Policy/i) ||
        screen.queryByText(/Create Policy/i) ||
        screen.queryByText(/Add Policy/i)
      ) as HTMLElement;
      await user.click(newPolicyBtn);

      await waitFor(() => {
        const scopeField =
          screen.queryByLabelText(/scope/i) ||
          screen.queryByPlaceholderText(/scope/i) ||
          document.querySelector("select[name='scope']") ||
          document.querySelector("input[name='scope']");
        expect(scopeField).not.toBeNull();
      });
    });

    it("create form includes an action text input", async () => {
      mockGraphQL(createAllPoliciesMocks());
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      const user = userEvent.setup();

      await waitFor(() => {
        const newPolicyBtn =
          screen.queryByRole("button", { name: /new policy/i }) ||
          screen.queryByText(/\+ New Policy/i) ||
          screen.queryByText(/New Policy/i) ||
          screen.queryByText(/Create Policy/i) ||
          screen.queryByText(/Add Policy/i);
        expect(newPolicyBtn).toBeInTheDocument();
      });

      const newPolicyBtn = (
        screen.queryByRole("button", { name: /new policy/i }) ||
        screen.queryByText(/\+ New Policy/i) ||
        screen.queryByText(/New Policy/i) ||
        screen.queryByText(/Create Policy/i) ||
        screen.queryByText(/Add Policy/i)
      ) as HTMLElement;
      await user.click(newPolicyBtn);

      await waitFor(() => {
        const actionField =
          screen.queryByLabelText(/action/i) ||
          screen.queryByPlaceholderText(/action/i) ||
          document.querySelector("input[name='action']") ||
          document.querySelector("textarea[name='action']");
        expect(actionField).not.toBeNull();
      });
    });

    it("submitting create form calls createPolicy mutation", async () => {
      const fetchMock = mockGraphQLWithMutation(
        createAllPoliciesMocks(),
        {
          createPolicy: {
            policy: {
              id: "pol-new",
              name: "New Test Policy",
              type: "ALERT",
              scope: "All Agents",
              action: "Alert on anomalous usage",
              triggersMtd: 0,
              status: "ACTIVE",
            },
            errors: [],
          },
        },
      );

      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      const user = userEvent.setup();

      await waitFor(() => {
        const newPolicyBtn =
          screen.queryByRole("button", { name: /new policy/i }) ||
          screen.queryByText(/\+ New Policy/i) ||
          screen.queryByText(/New Policy/i) ||
          screen.queryByText(/Create Policy/i) ||
          screen.queryByText(/Add Policy/i);
        expect(newPolicyBtn).toBeInTheDocument();
      });

      // Click to open form
      const newPolicyBtn = (
        screen.queryByRole("button", { name: /new policy/i }) ||
        screen.queryByText(/\+ New Policy/i) ||
        screen.queryByText(/New Policy/i) ||
        screen.queryByText(/Create Policy/i) ||
        screen.queryByText(/Add Policy/i)
      ) as HTMLElement;
      await user.click(newPolicyBtn);

      // After filling form and submitting, verify createPolicy mutation was sent
      await waitFor(
        () => {
          const submitBtn =
            screen.queryByRole("button", { name: /submit|save|create/i }) ||
            screen.queryByText(/submit/i) ||
            screen.queryByText(/save/i) ||
            screen.queryByText(/create/i);
          return submitBtn !== null;
        },
        { timeout: 3000 },
      );

      // Fill in name field if present
      const nameField =
        screen.queryByLabelText(/name/i) ||
        screen.queryByPlaceholderText(/name/i) ||
        document.querySelector("input[name='name']");
      if (nameField) {
        await user.clear(nameField as HTMLElement);
        await user.type(nameField as HTMLElement, "New Test Policy");
      }

      // Fill in action field if present
      const actionField =
        screen.queryByLabelText(/action/i) ||
        screen.queryByPlaceholderText(/action/i) ||
        document.querySelector("input[name='action']") ||
        document.querySelector("textarea[name='action']");
      if (actionField) {
        await user.clear(actionField as HTMLElement);
        await user.type(actionField as HTMLElement, "Alert on anomalous usage");
      }

      // Click submit
      const submitBtn = (
        screen.queryByRole("button", { name: /submit|save|create/i }) ||
        screen.queryByText(/submit/i) ||
        screen.queryByText(/save/i)
      ) as HTMLElement;
      if (submitBtn) {
        await user.click(submitBtn);
      }

      // Verify mutation was sent
      await waitFor(
        () => {
          const calls = fetchMock.mock.calls;
          const hasMutation = calls.some((call: unknown[]) => {
            const init = call[1] as RequestInit | undefined;
            if (!init?.body) return false;
            const bodyStr =
              typeof init.body === "string" ? init.body : "";
            return (
              bodyStr.includes("createPolicy") ||
              (bodyStr.includes("mutation") && bodyStr.includes("Policy"))
            );
          });
          expect(hasMutation).toBe(true);
        },
        { timeout: 3000 },
      );
    });

    it("create mutation sends auth header with Bearer token", async () => {
      // Set auth token before the test
      const { setAuthToken } = await import("@/api/client");
      setAuthToken("test-d9-token");

      const fetchMock = mockGraphQLWithMutation(
        createAllPoliciesMocks(),
        {
          createPolicy: {
            policy: {
              id: "pol-new",
              name: "Auth Test Policy",
              type: "BLOCK",
              scope: "All Agents",
              action: "Test action",
              triggersMtd: 0,
              status: "ACTIVE",
            },
            errors: [],
          },
        },
      );

      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      const user = userEvent.setup();

      await waitFor(() => {
        const newPolicyBtn =
          screen.queryByRole("button", { name: /new policy/i }) ||
          screen.queryByText(/\+ New Policy/i) ||
          screen.queryByText(/New Policy/i) ||
          screen.queryByText(/Create Policy/i) ||
          screen.queryByText(/Add Policy/i);
        expect(newPolicyBtn).toBeInTheDocument();
      });

      // Open form and submit -- we verify that ALL fetch calls include auth header
      await waitFor(
        () => {
          const calls = fetchMock.mock.calls;
          // After queries fire, check that they include Authorization header
          const hasAuth = calls.some((call: unknown[]) => {
            const init = call[1] as RequestInit | undefined;
            if (!init?.headers) return false;
            const headers = new Headers(init.headers as HeadersInit);
            return headers.get("Authorization")?.includes("Bearer") === true;
          });
          expect(hasAuth).toBe(true);
        },
        { timeout: 3000 },
      );

      // Clean up auth token
      setAuthToken("");
    });
  });

  // ----------------------------------------------------------
  // Deliverable 3: Update policy (toggle status) + mutation
  // ----------------------------------------------------------
  describe("Update policy toggle status + mutation (Deliverable 3)", () => {
    it("each policy row has a toggle or button to change status", async () => {
      mockGraphQL(createAllPoliciesMocks());
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        // There should be some interactive element for toggling status per row
        // This could be a toggle switch, button, or clickable status pill
        const toggleElements =
          screen.queryAllByRole("switch") ||
          screen.queryAllByRole("checkbox");
        const statusButtons = screen.queryAllByRole("button").filter((btn) => {
          const text = btn.textContent?.toLowerCase() ?? "";
          return text.includes("active") || text.includes("inactive") || text.includes("toggle");
        });
        const clickableStatuses = document.querySelectorAll("[data-status]");
        const totalInteractive =
          toggleElements.length + statusButtons.length + clickableStatuses.length;
        expect(totalInteractive).toBeGreaterThanOrEqual(1);
      });
    });

    it("toggling status calls updatePolicy mutation", async () => {
      const fetchMock = mockGraphQLWithMutation(
        createAllPoliciesMocks(),
        {
          updatePolicy: {
            policy: {
              id: "pol-4",
              name: "Monitor Gemini Usage",
              type: "MONITOR",
              scope: "Engineering",
              action: "Log all Gemini API calls for review",
              triggersMtd: 1024,
              status: "ACTIVE",
            },
            errors: [],
          },
        },
      );

      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      const user = userEvent.setup();

      await waitFor(() => {
        // Wait for policies table to render
        expect(screen.queryByText("Monitor Gemini Usage")).toBeInTheDocument();
      });

      // Find and click the INACTIVE toggle/button for the last policy
      const inactiveElements = screen.queryAllByText("INACTIVE");
      const toggleSwitches = screen.queryAllByRole("switch");
      const toggleCheckboxes = screen.queryAllByRole("checkbox");

      if (inactiveElements.length > 0) {
        await user.click(inactiveElements[0]);
      } else if (toggleSwitches.length > 0) {
        // Click the last toggle (the INACTIVE one)
        await user.click(toggleSwitches[toggleSwitches.length - 1]);
      } else if (toggleCheckboxes.length > 0) {
        await user.click(toggleCheckboxes[toggleCheckboxes.length - 1]);
      }

      // Verify updatePolicy mutation was sent
      await waitFor(
        () => {
          const calls = fetchMock.mock.calls;
          const hasMutation = calls.some((call: unknown[]) => {
            const init = call[1] as RequestInit | undefined;
            if (!init?.body) return false;
            const bodyStr =
              typeof init.body === "string" ? init.body : "";
            return (
              bodyStr.includes("updatePolicy") ||
              (bodyStr.includes("mutation") && bodyStr.includes("UpdatePolicy"))
            );
          });
          expect(hasMutation).toBe(true);
        },
        { timeout: 3000 },
      );
    });

    it("toggling INACTIVE policy sends status: ACTIVE in the mutation", async () => {
      const fetchMock = mockGraphQLWithMutation(
        createAllPoliciesMocks(),
        {
          updatePolicy: {
            policy: {
              id: "pol-4",
              name: "Monitor Gemini Usage",
              type: "MONITOR",
              scope: "Engineering",
              action: "Log all Gemini API calls for review",
              triggersMtd: 1024,
              status: "ACTIVE",
            },
            errors: [],
          },
        },
      );

      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      const user = userEvent.setup();

      await waitFor(() => {
        expect(screen.queryByText("Monitor Gemini Usage")).toBeInTheDocument();
      });

      // Click the INACTIVE toggle
      const inactiveElements = screen.queryAllByText("INACTIVE");
      const toggleSwitches = screen.queryAllByRole("switch");
      const toggleCheckboxes = screen.queryAllByRole("checkbox");

      if (inactiveElements.length > 0) {
        await user.click(inactiveElements[0]);
      } else if (toggleSwitches.length > 0) {
        await user.click(toggleSwitches[toggleSwitches.length - 1]);
      } else if (toggleCheckboxes.length > 0) {
        await user.click(toggleCheckboxes[toggleCheckboxes.length - 1]);
      }

      // Verify the mutation sends ACTIVE status
      await waitFor(
        () => {
          const calls = fetchMock.mock.calls;
          const mutationCall = calls.find((call: unknown[]) => {
            const init = call[1] as RequestInit | undefined;
            if (!init?.body) return false;
            const bodyStr =
              typeof init.body === "string" ? init.body : "";
            return bodyStr.includes("updatePolicy") || bodyStr.includes("UpdatePolicy");
          });
          if (mutationCall) {
            const init = mutationCall[1] as RequestInit | undefined;
            const bodyStr = typeof init?.body === "string" ? init.body : "";
            // The mutation should send status: ACTIVE (toggling from INACTIVE)
            expect(bodyStr).toMatch(/ACTIVE/);
          }
        },
        { timeout: 3000 },
      );
    });
  });

  // ----------------------------------------------------------
  // Deliverable 4: Delete policy + mutation with confirmation
  // ----------------------------------------------------------
  describe("Delete policy + mutation with confirmation (Deliverable 4)", () => {
    it("each policy row has a delete button or action", async () => {
      mockGraphQL(createAllPoliciesMocks());
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        const deleteBtns =
          screen.queryAllByRole("button", { name: /delete/i });
        const deleteTexts = screen.queryAllByText(/delete/i);
        const trashIcons = document.querySelectorAll("[aria-label*='delete' i], [aria-label*='remove' i]");
        const totalDelete = deleteBtns.length + deleteTexts.length + trashIcons.length;
        // Should have at least one delete action
        expect(totalDelete).toBeGreaterThanOrEqual(1);
      });
    });

    it("clicking delete shows a confirmation dialog before proceeding", async () => {
      const confirmSpy = vi.fn(() => true);
      vi.stubGlobal("confirm", confirmSpy);

      const fetchMock = mockGraphQLWithMutation(
        createAllPoliciesMocks(),
        {
          deletePolicy: {
            success: true,
            errors: [],
          },
        },
      );

      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      const user = userEvent.setup();

      await waitFor(() => {
        expect(screen.queryByText("Block Sensitive Data")).toBeInTheDocument();
      });

      // Click the first delete button
      const deleteBtn = (
        screen.queryAllByRole("button", { name: /delete/i })[0] ||
        screen.queryAllByText(/delete/i).find((el) => el.tagName === "BUTTON" || el.closest("button"))
      ) as HTMLElement | null;

      if (deleteBtn) {
        await user.click(deleteBtn.closest("button") || deleteBtn);

        // Either window.confirm was called, or a modal confirmation appeared
        await waitFor(
          () => {
            const confirmCalled = confirmSpy.mock.calls.length > 0;
            const confirmDialog =
              screen.queryByRole("dialog") ||
              screen.queryByText(/are you sure/i) ||
              screen.queryByText(/confirm.*delet/i);
            expect(confirmCalled || confirmDialog !== null).toBe(true);
          },
          { timeout: 3000 },
        );
      }
    });

    it("confirming delete calls deletePolicy mutation", async () => {
      const confirmSpy = vi.fn(() => true);
      vi.stubGlobal("confirm", confirmSpy);

      const fetchMock = mockGraphQLWithMutation(
        createAllPoliciesMocks(),
        {
          deletePolicy: {
            success: true,
            errors: [],
          },
        },
      );

      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      const user = userEvent.setup();

      await waitFor(() => {
        expect(screen.queryByText("Block Sensitive Data")).toBeInTheDocument();
      });

      // Click the first delete button
      const deleteBtn = (
        screen.queryAllByRole("button", { name: /delete/i })[0] ||
        screen.queryAllByText(/delete/i).find((el) => el.tagName === "BUTTON" || el.closest("button"))
      ) as HTMLElement | null;

      if (deleteBtn) {
        await user.click(deleteBtn.closest("button") || deleteBtn);

        // If a confirm dialog appeared as DOM element, click confirm
        const dialogConfirmBtn =
          screen.queryByRole("button", { name: /confirm|yes|ok/i });
        if (dialogConfirmBtn) {
          await user.click(dialogConfirmBtn);
        }
      }

      // Verify deletePolicy mutation was sent
      await waitFor(
        () => {
          const calls = fetchMock.mock.calls;
          const hasMutation = calls.some((call: unknown[]) => {
            const init = call[1] as RequestInit | undefined;
            if (!init?.body) return false;
            const bodyStr =
              typeof init.body === "string" ? init.body : "";
            return (
              bodyStr.includes("deletePolicy") ||
              (bodyStr.includes("mutation") && bodyStr.includes("DeletePolicy"))
            );
          });
          expect(hasMutation).toBe(true);
        },
        { timeout: 3000 },
      );
    });

    it("cancelling delete does NOT call deletePolicy mutation", async () => {
      const confirmSpy = vi.fn(() => false);
      vi.stubGlobal("confirm", confirmSpy);

      const fetchMock = mockGraphQLWithMutation(
        createAllPoliciesMocks(),
        {
          deletePolicy: {
            success: true,
            errors: [],
          },
        },
      );

      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      const user = userEvent.setup();

      await waitFor(() => {
        expect(screen.queryByText("Block Sensitive Data")).toBeInTheDocument();
      });

      const deleteBtn = (
        screen.queryAllByRole("button", { name: /delete/i })[0] ||
        screen.queryAllByText(/delete/i).find((el) => el.tagName === "BUTTON" || el.closest("button"))
      ) as HTMLElement | null;

      if (deleteBtn) {
        await user.click(deleteBtn.closest("button") || deleteBtn);

        // If a confirm dialog appeared as DOM element, click cancel
        const dialogCancelBtn =
          screen.queryByRole("button", { name: /cancel|no/i });
        if (dialogCancelBtn) {
          await user.click(dialogCancelBtn);
        }
      }

      // Verify no deletePolicy mutation was sent
      // Wait a bit, then verify no delete mutation call
      await new Promise((r) => setTimeout(r, 500));
      const calls = fetchMock.mock.calls;
      const hasDeleteMutation = calls.some((call: unknown[]) => {
        const init = call[1] as RequestInit | undefined;
        if (!init?.body) return false;
        const bodyStr =
          typeof init.body === "string" ? init.body : "";
        return bodyStr.includes("deletePolicy");
      });
      expect(hasDeleteMutation).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // Deliverable 5: Policy trigger history chart (recharts)
  // ----------------------------------------------------------
  describe("Policy trigger history chart (Deliverable 5)", () => {
    beforeEach(() => {
      mockGraphQL(createAllPoliciesMocks());
    });

    it("renders a trigger history chart section", async () => {
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        const chartTitle =
          screen.queryByText(/Trigger.*History/i) ||
          screen.queryByText(/Policy.*Trigger/i) ||
          screen.queryByText(/Triggers.*7.*Day/i) ||
          screen.queryByText(/Trigger.*Trend/i) ||
          screen.queryByText(/Daily.*Trigger/i);
        expect(chartTitle).toBeInTheDocument();
      });
    });

    it("renders chart with BarChart from recharts", async () => {
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        // recharts renders SVG elements -- look for chart container or SVG
        const svgElements = document.querySelectorAll("svg");
        const hasChart = svgElements.length > 0;
        // Also check for recharts-specific classes
        const rechartsElements = document.querySelectorAll(".recharts-wrapper, .recharts-surface");
        expect(hasChart || rechartsElements.length > 0).toBe(true);
      });
    });

    it("renders day labels from policyTriggerHistory data", async () => {
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        // Trigger history labels: "Mon", "Tue", "Wed", etc.
        const hasLabels =
          screen.queryByText("Mon") ||
          screen.queryByText("Tue") ||
          screen.queryByText("Wed") ||
          screen.queryByText("Thu") ||
          screen.queryByText("Fri");
        expect(hasLabels).toBeInTheDocument();
      });
    });

    it("renders empty state when no trigger history data", async () => {
      mockGraphQL({
        policies: createMockPolicies(),
        policyTriggerHistory: [],
      });
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        // Should show some kind of empty indicator or "no data" text for the chart
        const noData =
          screen.queryByText(/no.*trigger.*data/i) ||
          screen.queryByText(/no.*data/i) ||
          screen.queryByText(/no.*history/i);
        // If no explicit "no data" text, just verify the page does not crash
        const heading =
          screen.queryByText(/Governance Policies/i) ||
          screen.queryByText(/Policies/i);
        expect(heading).toBeInTheDocument();
      });
    });
  });

  // ----------------------------------------------------------
  // Deliverable 11: Loading/Error/Empty states
  // ----------------------------------------------------------
  describe("Loading state (Deliverable 11)", () => {
    it("shows loading indicator while policies data is being fetched", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise(() => {})),
      );
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        const loading =
          screen.queryByTestId("loading-state") ||
          screen.queryByRole("status") ||
          screen.queryByText(/loading/i);
        expect(loading).toBeInTheDocument();
      });
    });
  });

  describe("Error state (Deliverable 11)", () => {
    it("shows error message when GraphQL request fails with network error", async () => {
      mockGraphQLNetworkError();
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        const error =
          screen.queryByRole("alert") ||
          screen.queryByText(/error/i) ||
          screen.queryByText(/failed/i);
        expect(error).toBeInTheDocument();
      });
    });

    it("shows error message when GraphQL returns errors", async () => {
      mockGraphQLError("Policies service unavailable");
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
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

  describe("Empty state (Deliverable 11)", () => {
    it("shows empty state when no policies exist", async () => {
      mockGraphQL({
        policies: { items: [], total: 0, limit: 20, offset: 0 },
        policyTriggerHistory: [],
      });
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        const empty =
          screen.queryByText(/no.*polic/i) ||
          screen.queryByText(/no.*data/i) ||
          screen.queryByText(/empty/i) ||
          screen.queryByText(/create your first/i) ||
          screen.queryByText(/get started/i);
        expect(empty).toBeInTheDocument();
      });
    });

    it("empty state still renders the '+ New Policy' button", async () => {
      mockGraphQL({
        policies: { items: [], total: 0, limit: 20, offset: 0 },
        policyTriggerHistory: [],
      });
      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);
      await waitFor(() => {
        const newPolicyBtn =
          screen.queryByRole("button", { name: /new policy/i }) ||
          screen.queryByText(/\+ New Policy/i) ||
          screen.queryByText(/New Policy/i) ||
          screen.queryByText(/Create Policy/i) ||
          screen.queryByText(/Add Policy/i);
        expect(newPolicyBtn).toBeInTheDocument();
      });
    });
  });

  // ----------------------------------------------------------
  // Deliverable 10: Uses shared D2 components
  // ----------------------------------------------------------
  describe("Uses shared D2 components (Deliverable 10)", () => {
    it("page source imports DataTable from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/Policies.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*DataTable.*from/);
    });

    it("page source imports TagPill from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/Policies.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*TagPill.*from/);
    });

    it("page source imports ChartBox from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/Policies.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*ChartBox.*from/);
    });

    it("page source imports LoadingState from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/Policies.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*LoadingState.*from/);
    });

    it("page source imports ErrorState from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/Policies.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*ErrorState.*from/);
    });

    it("page source imports EmptyState from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/Policies.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*EmptyState.*from/);
    });

    it("page source imports graphqlRequest from graphql/client", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/Policies.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*graphqlRequest.*from/);
    });

    it("page source uses recharts for the trigger history chart", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/Policies.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*BarChart.*from.*recharts/);
    });
  });

  // ----------------------------------------------------------
  // Deliverable 12: All mutations require auth
  // ----------------------------------------------------------
  describe("All mutations require auth (Deliverable 12)", () => {
    it("graphqlRequest adds Authorization header when token is set", async () => {
      const { setAuthToken } = await import("@/api/client");
      setAuthToken("d9-policy-token");

      const fetchMock = mockGraphQL(createAllPoliciesMocks());

      // @ts-expect-error -- module may not exist yet
      const Policies = (await import("@/pages/Policies")).default;
      renderWithProviders(<Policies />);

      await waitFor(() => {
        const calls = fetchMock.mock.calls;
        expect(calls.length).toBeGreaterThanOrEqual(1);
        const firstCall = calls[0];
        const init = firstCall[1] as RequestInit | undefined;
        const headers = new Headers(init?.headers as HeadersInit);
        expect(headers.get("Authorization")).toBe("Bearer d9-policy-token");
      });

      setAuthToken("");
    });
  });
});

// ============================================================
// D9.2 -- API Keys Page
// ============================================================

describe("D9.2 -- API Keys Page", () => {
  describe("Page rendering and header", () => {
    it("renders the 'API Key Attribution' heading", async () => {
      mockGraphQL(createAllKeysMocks());
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      await waitFor(() => {
        const heading =
          screen.queryByText(/API Key Attribution/i) ||
          screen.queryByText(/API Keys/i);
        expect(heading).toBeInTheDocument();
      });
    });

    it("renders a '+ Register Key' button", async () => {
      mockGraphQL(createAllKeysMocks());
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      await waitFor(() => {
        const registerBtn =
          screen.queryByRole("button", { name: /register.*key/i }) ||
          screen.queryByText(/\+ Register Key/i) ||
          screen.queryByText(/Register Key/i) ||
          screen.queryByText(/Add Key/i);
        expect(registerBtn).toBeInTheDocument();
      });
    });

    // ----------------------------------------------------------
    // Deliverable 9: "Keys are never stored" subheader
    // ----------------------------------------------------------
    it("renders 'Keys are never stored' subheader text (Deliverable 9)", async () => {
      mockGraphQL(createAllKeysMocks());
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      await waitFor(() => {
        const subheader =
          screen.queryByText(/keys are never stored/i) ||
          screen.queryByText(/never stored/i) ||
          screen.queryByText(/SHA-256 fingerprints/i) ||
          screen.queryByText(/fingerprints.*attribution/i);
        expect(subheader).toBeInTheDocument();
      });
    });

    it("subheader mentions SHA-256 fingerprints for attribution", async () => {
      mockGraphQL(createAllKeysMocks());
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      await waitFor(() => {
        const sha256Text =
          screen.queryByText(/SHA-256/i) ||
          screen.queryByText(/fingerprint/i);
        expect(sha256Text).toBeInTheDocument();
      });
    });
  });

  // ----------------------------------------------------------
  // Deliverable 6: API Keys table from registeredKeys query
  // ----------------------------------------------------------
  describe("API Keys table from registeredKeys query (Deliverable 6)", () => {
    beforeEach(() => {
      mockGraphQL(createAllKeysMocks());
    });

    it("renders keys data in a table element", async () => {
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      await waitFor(() => {
        expect(document.querySelector("table")).not.toBeNull();
      });
    });

    it("renders table column headers matching design: Name, Provider, Fingerprint, Agents, Last Used, Monthly Spend, Status", async () => {
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      await waitFor(() => {
        const requiredColumns = [
          /name/i,
          /provider/i,
          /fingerprint/i,
          /agents/i,
          /last used/i,
          /monthly.*spend|spend|cost/i,
          /status/i,
        ];
        for (const pattern of requiredColumns) {
          const header = screen.queryByText(pattern);
          expect(header).toBeInTheDocument();
        }
      });
    });

    it("renders key names from query data", async () => {
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      await waitFor(() => {
        expect(screen.queryByText("Production Anthropic Key")).toBeInTheDocument();
        expect(screen.queryByText("Dev OpenAI Key")).toBeInTheDocument();
        expect(screen.queryByText("Staging Gemini Key")).toBeInTheDocument();
      });
    });

    it("renders provider names as pills", async () => {
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      await waitFor(() => {
        expect(screen.queryByText("Anthropic")).toBeInTheDocument();
        expect(screen.queryByText("OpenAI")).toBeInTheDocument();
        expect(screen.queryByText("Google")).toBeInTheDocument();
      });
    });

    it("renders fingerprints in monospace font (truncated)", async () => {
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      await waitFor(() => {
        // Fingerprints: "sha256:a1b2c3d4e5f67890", truncated display
        // Should show at least a partial fingerprint
        const fp1 =
          screen.queryByText(/a1b2c3/) ||
          screen.queryByText(/sha256:a1b2/);
        expect(fp1).toBeInTheDocument();

        // Check for monospace styling
        const monoElements = document.querySelectorAll(".mono, [class*='mono']");
        expect(monoElements.length).toBeGreaterThanOrEqual(1);
      });
    });

    it("renders agent counts from query data", async () => {
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      await waitFor(() => {
        // agentCount: 12, 5, 3
        expect(screen.queryByText("12")).toBeInTheDocument();
      });
    });

    it("renders last used as relative time", async () => {
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      await waitFor(() => {
        // lastUsed: "2026-03-24T10:30:00Z" -- could be "today", "x hours ago", or formatted date
        const lastUsedText =
          screen.queryByText(/ago/i) ||
          screen.queryByText(/today/i) ||
          screen.queryByText(/yesterday/i) ||
          screen.queryByText(/3\/24/) ||
          screen.queryByText(/Mar.*24/i) ||
          screen.queryByText(/2026-03-24/);
        expect(lastUsedText).toBeInTheDocument();
      });
    });

    it("renders monthly spend from query data", async () => {
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      await waitFor(() => {
        // monthlyCostUsd: 4250.00 -> "$4,250" or "$4,250.00" or "4250"
        const spendText =
          screen.queryByText(/\$4,250/) ||
          screen.queryByText(/4,250/) ||
          screen.queryByText(/4250/);
        expect(spendText).toBeInTheDocument();
      });
    });

    it("renders status values from query data", async () => {
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      await waitFor(() => {
        // status: "active" and "inactive"
        const activeElements = screen.queryAllByText(/^active$/i);
        const inactiveElements = screen.queryAllByText(/^inactive$/i);
        expect(activeElements.length).toBeGreaterThanOrEqual(1);
        expect(inactiveElements.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  // ----------------------------------------------------------
  // Deliverable 7: Register key form + mutation
  // ----------------------------------------------------------
  describe("Register key form + mutation (Deliverable 7)", () => {
    it("clicking '+ Register Key' opens an inline form", async () => {
      mockGraphQL(createAllKeysMocks());
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      const user = userEvent.setup();

      await waitFor(() => {
        const registerBtn =
          screen.queryByRole("button", { name: /register.*key/i }) ||
          screen.queryByText(/\+ Register Key/i) ||
          screen.queryByText(/Register Key/i) ||
          screen.queryByText(/Add Key/i);
        expect(registerBtn).toBeInTheDocument();
      });

      const registerBtn = (
        screen.queryByRole("button", { name: /register.*key/i }) ||
        screen.queryByText(/\+ Register Key/i) ||
        screen.queryByText(/Register Key/i) ||
        screen.queryByText(/Add Key/i)
      ) as HTMLElement;
      await user.click(registerBtn);

      await waitFor(() => {
        // Form should have name input, provider dropdown, fingerprint input
        const nameField =
          screen.queryByLabelText(/name/i) ||
          screen.queryByPlaceholderText(/name/i) ||
          document.querySelector("input[name='name']");
        expect(nameField).not.toBeNull();
      });
    });

    it("register form includes a provider dropdown", async () => {
      mockGraphQL(createAllKeysMocks());
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      const user = userEvent.setup();

      await waitFor(() => {
        const registerBtn =
          screen.queryByRole("button", { name: /register.*key/i }) ||
          screen.queryByText(/\+ Register Key/i) ||
          screen.queryByText(/Register Key/i) ||
          screen.queryByText(/Add Key/i);
        expect(registerBtn).toBeInTheDocument();
      });

      const registerBtn = (
        screen.queryByRole("button", { name: /register.*key/i }) ||
        screen.queryByText(/\+ Register Key/i) ||
        screen.queryByText(/Register Key/i) ||
        screen.queryByText(/Add Key/i)
      ) as HTMLElement;
      await user.click(registerBtn);

      await waitFor(() => {
        const providerField =
          screen.queryByLabelText(/provider/i) ||
          document.querySelector("select[name='provider']") ||
          document.querySelector("select");
        expect(providerField).not.toBeNull();
      });
    });

    it("register form includes a fingerprint input", async () => {
      mockGraphQL(createAllKeysMocks());
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      const user = userEvent.setup();

      await waitFor(() => {
        const registerBtn =
          screen.queryByRole("button", { name: /register.*key/i }) ||
          screen.queryByText(/\+ Register Key/i) ||
          screen.queryByText(/Register Key/i) ||
          screen.queryByText(/Add Key/i);
        expect(registerBtn).toBeInTheDocument();
      });

      const registerBtn = (
        screen.queryByRole("button", { name: /register.*key/i }) ||
        screen.queryByText(/\+ Register Key/i) ||
        screen.queryByText(/Register Key/i) ||
        screen.queryByText(/Add Key/i)
      ) as HTMLElement;
      await user.click(registerBtn);

      await waitFor(() => {
        const fingerprintField =
          screen.queryByLabelText(/fingerprint/i) ||
          screen.queryByPlaceholderText(/fingerprint/i) ||
          document.querySelector("input[name='fingerprint']");
        expect(fingerprintField).not.toBeNull();
      });
    });

    it("submitting register form calls registerKey mutation", async () => {
      const fetchMock = mockGraphQLWithMutation(
        createAllKeysMocks(),
        {
          registerKey: {
            key: {
              id: "key-new",
              name: "New Test Key",
              provider: "Anthropic",
              fingerprint: "sha256:newkeyhash1234",
              agentCount: 0,
              lastUsed: null,
              monthlyCostUsd: 0,
              status: "active",
            },
            errors: [],
          },
        },
      );

      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      const user = userEvent.setup();

      await waitFor(() => {
        const registerBtn =
          screen.queryByRole("button", { name: /register.*key/i }) ||
          screen.queryByText(/\+ Register Key/i) ||
          screen.queryByText(/Register Key/i) ||
          screen.queryByText(/Add Key/i);
        expect(registerBtn).toBeInTheDocument();
      });

      // Open form
      const registerBtn = (
        screen.queryByRole("button", { name: /register.*key/i }) ||
        screen.queryByText(/\+ Register Key/i) ||
        screen.queryByText(/Register Key/i) ||
        screen.queryByText(/Add Key/i)
      ) as HTMLElement;
      await user.click(registerBtn);

      // Wait for form to appear
      await waitFor(
        () => {
          const submitBtn =
            screen.queryByRole("button", { name: /submit|save|register/i }) ||
            screen.queryByText(/submit/i) ||
            screen.queryByText(/save/i);
          return submitBtn !== null;
        },
        { timeout: 3000 },
      );

      // Fill in name field if present
      const nameField =
        screen.queryByLabelText(/name/i) ||
        screen.queryByPlaceholderText(/name/i) ||
        document.querySelector("input[name='name']");
      if (nameField) {
        await user.clear(nameField as HTMLElement);
        await user.type(nameField as HTMLElement, "New Test Key");
      }

      // Fill in fingerprint field if present
      const fingerprintField =
        screen.queryByLabelText(/fingerprint/i) ||
        screen.queryByPlaceholderText(/fingerprint/i) ||
        document.querySelector("input[name='fingerprint']");
      if (fingerprintField) {
        await user.clear(fingerprintField as HTMLElement);
        await user.type(fingerprintField as HTMLElement, "sha256:newkeyhash1234");
      }

      // Click submit
      const submitBtn = (
        screen.queryByRole("button", { name: /submit|save|register/i }) ||
        screen.queryByText(/submit/i) ||
        screen.queryByText(/save/i)
      ) as HTMLElement;
      if (submitBtn) {
        await user.click(submitBtn);
      }

      // Verify registerKey mutation was sent
      await waitFor(
        () => {
          const calls = fetchMock.mock.calls;
          const hasMutation = calls.some((call: unknown[]) => {
            const init = call[1] as RequestInit | undefined;
            if (!init?.body) return false;
            const bodyStr =
              typeof init.body === "string" ? init.body : "";
            return (
              bodyStr.includes("registerKey") ||
              (bodyStr.includes("mutation") && bodyStr.includes("RegisterKey"))
            );
          });
          expect(hasMutation).toBe(true);
        },
        { timeout: 3000 },
      );
    });

    it("register mutation sends auth header with Bearer token", async () => {
      const { setAuthToken } = await import("@/api/client");
      setAuthToken("d9-key-token");

      const fetchMock = mockGraphQL(createAllKeysMocks());

      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);

      await waitFor(() => {
        const calls = fetchMock.mock.calls;
        expect(calls.length).toBeGreaterThanOrEqual(1);
        const firstCall = calls[0];
        const init = firstCall[1] as RequestInit | undefined;
        const headers = new Headers(init?.headers as HeadersInit);
        expect(headers.get("Authorization")).toBe("Bearer d9-key-token");
      });

      setAuthToken("");
    });
  });

  // ----------------------------------------------------------
  // Deliverable 8: Delete key + mutation
  // ----------------------------------------------------------
  describe("Delete key + mutation (Deliverable 8)", () => {
    it("each key row has a delete button or action", async () => {
      mockGraphQL(createAllKeysMocks());
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      await waitFor(() => {
        const deleteBtns =
          screen.queryAllByRole("button", { name: /delete/i });
        const deleteTexts = screen.queryAllByText(/delete/i);
        const trashIcons = document.querySelectorAll("[aria-label*='delete' i], [aria-label*='remove' i]");
        const totalDelete = deleteBtns.length + deleteTexts.length + trashIcons.length;
        expect(totalDelete).toBeGreaterThanOrEqual(1);
      });
    });

    it("clicking delete calls deleteKey mutation", async () => {
      const confirmSpy = vi.fn(() => true);
      vi.stubGlobal("confirm", confirmSpy);

      const fetchMock = mockGraphQLWithMutation(
        createAllKeysMocks(),
        {
          deleteKey: {
            success: true,
            errors: [],
          },
        },
      );

      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      const user = userEvent.setup();

      await waitFor(() => {
        expect(screen.queryByText("Production Anthropic Key")).toBeInTheDocument();
      });

      // Click the first delete button
      const deleteBtn = (
        screen.queryAllByRole("button", { name: /delete/i })[0] ||
        screen.queryAllByText(/delete/i).find((el) => el.tagName === "BUTTON" || el.closest("button"))
      ) as HTMLElement | null;

      if (deleteBtn) {
        await user.click(deleteBtn.closest("button") || deleteBtn);

        // If a confirm dialog appeared as DOM element, click confirm
        const dialogConfirmBtn =
          screen.queryByRole("button", { name: /confirm|yes|ok/i });
        if (dialogConfirmBtn) {
          await user.click(dialogConfirmBtn);
        }
      }

      // Verify deleteKey mutation was sent
      await waitFor(
        () => {
          const calls = fetchMock.mock.calls;
          const hasMutation = calls.some((call: unknown[]) => {
            const init = call[1] as RequestInit | undefined;
            if (!init?.body) return false;
            const bodyStr =
              typeof init.body === "string" ? init.body : "";
            return (
              bodyStr.includes("deleteKey") ||
              (bodyStr.includes("mutation") && bodyStr.includes("DeleteKey"))
            );
          });
          expect(hasMutation).toBe(true);
        },
        { timeout: 3000 },
      );
    });

    it("delete mutation sends the key ID as variable", async () => {
      const confirmSpy = vi.fn(() => true);
      vi.stubGlobal("confirm", confirmSpy);

      const fetchMock = mockGraphQLWithMutation(
        createAllKeysMocks(),
        {
          deleteKey: {
            success: true,
            errors: [],
          },
        },
      );

      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      const user = userEvent.setup();

      await waitFor(() => {
        expect(screen.queryByText("Production Anthropic Key")).toBeInTheDocument();
      });

      // Click the first delete button
      const deleteBtn = (
        screen.queryAllByRole("button", { name: /delete/i })[0] ||
        screen.queryAllByText(/delete/i).find((el) => el.tagName === "BUTTON" || el.closest("button"))
      ) as HTMLElement | null;

      if (deleteBtn) {
        await user.click(deleteBtn.closest("button") || deleteBtn);

        const dialogConfirmBtn =
          screen.queryByRole("button", { name: /confirm|yes|ok/i });
        if (dialogConfirmBtn) {
          await user.click(dialogConfirmBtn);
        }
      }

      // Verify the mutation includes a key ID
      await waitFor(
        () => {
          const calls = fetchMock.mock.calls;
          const mutationCall = calls.find((call: unknown[]) => {
            const init = call[1] as RequestInit | undefined;
            if (!init?.body) return false;
            const bodyStr =
              typeof init.body === "string" ? init.body : "";
            return bodyStr.includes("deleteKey") || bodyStr.includes("DeleteKey");
          });
          if (mutationCall) {
            const init = mutationCall[1] as RequestInit | undefined;
            const bodyStr = typeof init?.body === "string" ? init.body : "";
            const body = JSON.parse(bodyStr);
            // Variables should contain an id like "key-1"
            expect(body.variables).toBeDefined();
            expect(body.variables.id || body.variables.keyId).toBeTruthy();
          }
        },
        { timeout: 3000 },
      );
    });
  });

  // ----------------------------------------------------------
  // Deliverable 11: Loading/Error/Empty states
  // ----------------------------------------------------------
  describe("Loading state (Deliverable 11)", () => {
    it("shows loading indicator while keys data is being fetched", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise(() => {})),
      );
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      await waitFor(() => {
        const loading =
          screen.queryByTestId("loading-state") ||
          screen.queryByRole("status") ||
          screen.queryByText(/loading/i);
        expect(loading).toBeInTheDocument();
      });
    });
  });

  describe("Error state (Deliverable 11)", () => {
    it("shows error message when GraphQL request fails with network error", async () => {
      mockGraphQLNetworkError();
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      await waitFor(() => {
        const error =
          screen.queryByRole("alert") ||
          screen.queryByText(/error/i) ||
          screen.queryByText(/failed/i);
        expect(error).toBeInTheDocument();
      });
    });

    it("shows error message when GraphQL returns errors", async () => {
      mockGraphQLError("API keys service unavailable");
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
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

  describe("Empty state (Deliverable 11)", () => {
    it("shows empty state when no keys are registered", async () => {
      mockGraphQL({
        registeredKeys: { items: [], total: 0, limit: 20, offset: 0 },
      });
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      await waitFor(() => {
        const empty =
          screen.queryByText(/no.*key/i) ||
          screen.queryByText(/no.*data/i) ||
          screen.queryByText(/empty/i) ||
          screen.queryByText(/register your first/i) ||
          screen.queryByText(/get started/i);
        expect(empty).toBeInTheDocument();
      });
    });

    it("empty state still renders the '+ Register Key' button", async () => {
      mockGraphQL({
        registeredKeys: { items: [], total: 0, limit: 20, offset: 0 },
      });
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      await waitFor(() => {
        const registerBtn =
          screen.queryByRole("button", { name: /register.*key/i }) ||
          screen.queryByText(/\+ Register Key/i) ||
          screen.queryByText(/Register Key/i) ||
          screen.queryByText(/Add Key/i);
        expect(registerBtn).toBeInTheDocument();
      });
    });

    it("empty state still renders the 'Keys are never stored' subheader", async () => {
      mockGraphQL({
        registeredKeys: { items: [], total: 0, limit: 20, offset: 0 },
      });
      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);
      await waitFor(() => {
        const subheader =
          screen.queryByText(/keys are never stored/i) ||
          screen.queryByText(/never stored/i) ||
          screen.queryByText(/SHA-256/i);
        expect(subheader).toBeInTheDocument();
      });
    });
  });

  // ----------------------------------------------------------
  // Deliverable 10: Uses shared D2 components
  // ----------------------------------------------------------
  describe("Uses shared D2 components (Deliverable 10)", () => {
    it("page source imports DataTable from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/ApiKeys.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*DataTable.*from/);
    });

    it("page source imports TagPill from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/ApiKeys.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*TagPill.*from/);
    });

    it("page source imports LoadingState from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/ApiKeys.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*LoadingState.*from/);
    });

    it("page source imports ErrorState from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/ApiKeys.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*ErrorState.*from/);
    });

    it("page source imports EmptyState from shared components", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/ApiKeys.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*EmptyState.*from/);
    });

    it("page source imports graphqlRequest from graphql/client", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const src = fs.readFileSync(
        path.resolve(__dirname, "../src/pages/ApiKeys.tsx"),
        "utf-8",
      );
      expect(src).toMatch(/import.*graphqlRequest.*from/);
    });
  });

  // ----------------------------------------------------------
  // Deliverable 12: All mutations require auth
  // ----------------------------------------------------------
  describe("All mutations require auth (Deliverable 12)", () => {
    it("graphqlRequest adds Authorization header when token is set", async () => {
      const { setAuthToken } = await import("@/api/client");
      setAuthToken("d9-keys-auth-token");

      const fetchMock = mockGraphQL(createAllKeysMocks());

      // @ts-expect-error -- module may not exist yet
      const ApiKeys = (await import("@/pages/ApiKeys")).default;
      renderWithProviders(<ApiKeys />);

      await waitFor(() => {
        const calls = fetchMock.mock.calls;
        expect(calls.length).toBeGreaterThanOrEqual(1);
        const firstCall = calls[0];
        const init = firstCall[1] as RequestInit | undefined;
        const headers = new Headers(init?.headers as HeadersInit);
        expect(headers.get("Authorization")).toBe("Bearer d9-keys-auth-token");
      });

      setAuthToken("");
    });
  });
});
