/**
 * Tests for the base API client (src/api/client.ts).
 *
 * The client is a typed fetch wrapper that:
 * - Adds Authorization header with Bearer token
 * - Uses a configurable API base URL
 * - Parses JSON responses
 * - Handles HTTP errors (401, 403, 429, 5xx)
 * - Handles network errors
 * - Passes query parameters
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockFetch } from "../setup";

// The implementation does not exist yet — these imports will fail until Sprint 9B implementation.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — module does not exist yet
import { apiClient, setAuthToken, setBaseUrl } from "@/api/client";

describe("API Client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds Authorization header with Bearer token to every request", async () => {
    const fetchMock = mockFetch([{ body: { ok: true }, status: 200 }]);

    setAuthToken("test-api-key-123");
    await apiClient("/v1/dashboards/monitoring");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toBeDefined();

    // Should contain Bearer token in Authorization header
    const headers = new Headers(init?.headers as HeadersInit);
    expect(headers.get("Authorization")).toBe("Bearer test-api-key-123");
  });

  it("uses the configured API base URL", async () => {
    const fetchMock = mockFetch([{ body: {}, status: 200 }]);

    setBaseUrl("https://api.recondo.dev");
    await apiClient("/v1/dashboards/monitoring");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.recondo.dev/v1/dashboards/monitoring");
  });

  it("throws an authentication error on 401 response", async () => {
    mockFetch([{ body: { error: "Unauthorized" }, status: 401 }]);

    await expect(apiClient("/v1/dashboards/monitoring")).rejects.toThrow(/401|unauthorized|authentication/i);
  });

  it("throws a forbidden error on 403 response", async () => {
    mockFetch([{
      body: { error: "Forbidden" },
      status: 403,
    }]);

    try {
      await apiClient("/v1/dashboards/management-review");
      expect.fail("Should have thrown");
    } catch (err: unknown) {
      const error = err as { status?: number; message?: string };
      expect(
        error.status === 403 ||
        error.message?.includes("403") ||
        error.message?.includes("Forbidden")
      ).toBe(true);
    }
  });

  it("throws a rate limit error on 429 response", async () => {
    mockFetch([{
      body: { error: "Rate limit exceeded" },
      status: 429,
      headers: { "Retry-After": "30" },
    }]);

    try {
      await apiClient("/v1/usage/token-spend");
      expect.fail("Should have thrown");
    } catch (err: unknown) {
      const error = err as { status?: number; message?: string };
      expect(
        error.status === 429 ||
        error.message?.includes("429") ||
        error.message?.includes("rate limit") ||
        error.message?.includes("Rate limit")
      ).toBe(true);
    }
  });

  it("handles network errors gracefully", async () => {
    mockFetch([{ networkError: true }]);

    await expect(apiClient("/v1/dashboards/monitoring")).rejects.toThrow();
  });

  it("parses JSON response body correctly", async () => {
    const responseBody = { activeSessions: 12, turnsCaptured: { total: 100 } };
    mockFetch([{ body: responseBody, status: 200 }]);

    const result = await apiClient("/v1/dashboards/monitoring");
    expect(result).toEqual(responseBody);
  });

  it("passes query parameters correctly", async () => {
    const fetchMock = mockFetch([{ body: {}, status: 200 }]);

    await apiClient("/v1/dashboards/monitoring", {
      params: { projectId: "proj-123", agent: "claude-code", model: "claude-sonnet-4-20250514" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    const parsedUrl = new URL(url as string);

    expect(parsedUrl.searchParams.get("projectId")).toBe("proj-123");
    expect(parsedUrl.searchParams.get("agent")).toBe("claude-code");
    expect(parsedUrl.searchParams.get("model")).toBe("claude-sonnet-4-20250514");
  });
});
