import { apiClient } from "./client";
import type { ManagementReview } from "./types";

export async function fetchManagementReview(
  params?: Record<string, string>,
  signal?: AbortSignal
): Promise<ManagementReview> {
  return apiClient<ManagementReview>("/v1/dashboards/management-review", { params, signal });
}
