import { apiClient } from "./client";
import type { RiskClassification, RiskProfile } from "./types";

export async function classifyRisk(
  body: { intent: string; sessionId?: string },
  signal?: AbortSignal
): Promise<RiskClassification> {
  return apiClient<RiskClassification>("/v1/risk/classify", {
    method: "POST",
    body,
    signal,
  });
}

export async function fetchRiskProfile(
  params?: Record<string, string>,
  signal?: AbortSignal
): Promise<RiskProfile> {
  return apiClient<RiskProfile>("/v1/risk/profile", { params, signal });
}
