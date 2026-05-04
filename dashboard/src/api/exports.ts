import { apiClient } from "./client";
import type { Soc2Export, Iso42001Export } from "./types";

export async function exportSoc2(body?: {
  startDate?: string;
  endDate?: string;
  projectId?: string;
}, signal?: AbortSignal): Promise<Soc2Export> {
  return apiClient<Soc2Export>("/v1/exports/soc2", {
    method: "POST",
    body: body ?? {},
    signal,
  });
}

export async function exportSoc2Package(body?: {
  startDate?: string;
  endDate?: string;
  projectId?: string;
}, signal?: AbortSignal): Promise<Soc2Export> {
  return apiClient<Soc2Export>("/v1/exports/soc2/package", {
    method: "POST",
    body: body ?? {},
    signal,
  });
}

export async function exportIso42001(body?: {
  startDate?: string;
  endDate?: string;
  projectId?: string;
}, signal?: AbortSignal): Promise<Iso42001Export> {
  return apiClient<Iso42001Export>("/v1/exports/iso42001", {
    method: "POST",
    body: body ?? {},
    signal,
  });
}
