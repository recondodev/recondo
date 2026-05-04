import { apiClient } from "./client";
import type {
  TokenSpendResponse,
  CostByTeamResponse,
  DeveloperProductivityResponse,
  ModelAnalysisResponse,
  ToolAnalyticsResponse,
  CostTrendResponse,
} from "./types";

export async function fetchTokenSpend(signal?: AbortSignal): Promise<TokenSpendResponse> {
  return apiClient<TokenSpendResponse>("/v1/usage/token-spend", { signal });
}

export async function fetchCostAllocation(signal?: AbortSignal): Promise<CostByTeamResponse> {
  return apiClient<CostByTeamResponse>("/v1/usage/cost-by-team", { signal });
}

export async function fetchCostByTeam(
  params?: Record<string, string>,
  signal?: AbortSignal
): Promise<CostByTeamResponse> {
  return apiClient<CostByTeamResponse>("/v1/usage/cost-by-team", { params, signal });
}

export async function fetchDeveloperProductivity(signal?: AbortSignal): Promise<DeveloperProductivityResponse> {
  return apiClient<DeveloperProductivityResponse>("/v1/usage/developer-productivity", { signal });
}

export async function fetchModelAnalysis(
  params?: Record<string, string>,
  signal?: AbortSignal
): Promise<ModelAnalysisResponse> {
  return apiClient<ModelAnalysisResponse>("/v1/usage/model-analysis", { params, signal });
}

export async function fetchToolAnalytics(signal?: AbortSignal): Promise<ToolAnalyticsResponse> {
  return apiClient<ToolAnalyticsResponse>("/v1/usage/tool-analytics", { signal });
}

export async function fetchCostTrend(
  params?: Record<string, string>,
  signal?: AbortSignal
): Promise<CostTrendResponse> {
  return apiClient<CostTrendResponse>("/v1/usage/cost-trend", { params, signal });
}
