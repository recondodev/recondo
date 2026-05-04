import { apiClient } from "./client";
import type { SessionSummary, SessionDetail, TurnDetail } from "./types";

export async function fetchSessions(signal?: AbortSignal): Promise<SessionSummary[]> {
  return apiClient<SessionSummary[]>("/v1/sessions", { signal });
}

export async function fetchSession(id: string, signal?: AbortSignal): Promise<SessionDetail> {
  return apiClient<SessionDetail>(`/v1/sessions/${id}`, { signal });
}

export async function fetchTurn(id: string, signal?: AbortSignal): Promise<TurnDetail> {
  return apiClient<TurnDetail>(`/v1/turns/${id}`, { signal });
}
