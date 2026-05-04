import { apiClient } from "./client";
import type { MonitoringDashboard } from "./types";

export async function fetchMonitoringDashboard(
  params?: Record<string, string>,
  signal?: AbortSignal
): Promise<MonitoringDashboard> {
  return apiClient<MonitoringDashboard>("/v1/dashboards/monitoring", { params, signal });
}
