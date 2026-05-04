/**
 * Lightweight GraphQL client that uses native fetch.
 *
 * The tests mock global fetch, so we must NOT use graphql-request's
 * internal fetch -- we call window.fetch (or global.fetch) directly.
 */

import { getApiToken } from "../api/client";

const GRAPHQL_ENDPOINT =
  (typeof import.meta !== "undefined" &&
    (import.meta as unknown as { env?: Record<string, string> }).env
      ?.VITE_GRAPHQL_URL) ||
  "http://localhost:4000/graphql";

interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/**
 * Extract the nested query result from a GraphQL response.
 * A real server returns { sessions: { items: [...], total: ... } },
 * but test mocks may return the payload directly.
 */
export function extractField<T>(data: unknown, field: string): T {
  if (data && typeof data === "object" && field in (data as Record<string, unknown>)) {
    return (data as Record<string, unknown>)[field] as T;
  }
  return data as T;
}

export async function graphqlRequest<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
  operationName?: string,
  signal?: AbortSignal,
): Promise<T> {
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;
  if (operationName) body.operationName = operationName;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const token = getApiToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed: HTTP ${response.status}`);
  }

  const json: GraphQLResponse<T> = await response.json();

  if (json.errors && json.errors.length > 0) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }

  if (json.data === undefined && (!json.errors || json.errors.length === 0)) {
    throw new Error("No data returned from GraphQL");
  }

  return json.data as T;
}
