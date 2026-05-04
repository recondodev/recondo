/**
 * Base API client for the Recondo Dashboard.
 *
 * Wraps fetch with:
 * - Configurable base URL (via VITE_API_URL env var or setBaseUrl)
 * - Authorization header with Bearer token
 * - JSON Content-Type
 * - Error handling: 401 (AuthError), 403 (ForbiddenError), 429 (RateLimitError)
 * - Query params support
 */

let _authToken = "";
let _baseUrl: string =
  (typeof import.meta !== "undefined" &&
    (import.meta as unknown as { env?: Record<string, string> }).env
      ?.VITE_API_URL) ||
  "http://localhost:4000";

export function setAuthToken(token: string): void {
  _authToken = token;
}

export function getApiToken(): string {
  return _authToken;
}

export function setBaseUrl(url: string): void {
  _baseUrl = url;
}

/** Expose the configured API base URL so non-fetch consumers (e.g. <img>
 *  tags for attachment URLs) can resolve relative /v1/* paths against the
 *  API origin rather than the dashboard's own origin. */
export function getBaseUrl(): string {
  return _baseUrl;
}

export class AuthError extends Error {
  status = 401;
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class ForbiddenError extends Error {
  status = 403;
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class RateLimitError extends Error {
  status = 429;
  retryAfter?: string;
  constructor(message: string, retryAfter?: string) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

export class ApiHttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiHttpError";
    this.status = status;
  }
}

interface ApiClientOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function apiClient<T = unknown>(
  path: string,
  options?: ApiClientOptions
): Promise<T> {
  let url = `${_baseUrl}${path}`;

  if (options?.params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(options.params)) {
      searchParams.set(key, value);
    }
    url += `?${searchParams.toString()}`;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers ?? {}),
  };

  if (_authToken) {
    headers["Authorization"] = `Bearer ${_authToken}`;
  }

  const response = await fetch(url, {
    method: options?.method ?? "GET",
    headers,
    body: options?.body ? JSON.stringify(options.body) : undefined,
    signal: options?.signal,
  });

  if (response.status === 401) {
    throw new AuthError("401 Unauthorized: authentication required");
  }

  if (response.status === 403) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ForbiddenError(body.error ?? "403 Forbidden");
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After") ?? undefined;
    throw new RateLimitError("429 Rate limit exceeded", retryAfter);
  }

  if (!response.ok) {
    throw new ApiHttpError(
      `HTTP ${response.status}: ${response.statusText}`,
      response.status
    );
  }

  const data = (await response.json()) as T;
  return data;
}
