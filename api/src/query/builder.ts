/**
 * Sprint 12: Structured Query Builder — POST /v1/query handler.
 *
 * Owns HTTP-shape concerns: request validation, shortcut resolution,
 * output formatting, attribution lookup, and the 30-second timeout.
 * The 8 per-operation query helpers live in `@recondo/data`.
 */

import { runStructuredQuery } from "@recondo/data";
import type { ApiKeyInfo } from "../context.js";

interface QueryRequest {
  queryType?: string;
  shortcut?: string;
  params?: Record<string, unknown>;
  filters?: Record<string, unknown>;
  groupBy?: string;
  format?: string;
  limit?: number;
}

interface QueryResult {
  status: number;
  body: Record<string, unknown>;
}

const ATTRIBUTION: Record<string, string> = {
  sessions: "SOC 2 PI1 -- Processing Integrity",
  turns: "SOC 2 PI1 -- Processing Integrity",
  anomalies: "ISO 42001 Cl.9.1 -- Monitoring",
  cost: "Usage Intelligence",
  risk: "ISO 42001 Cl.6.1 -- Risk Assessment",
  compliance: "ISO 42001 / SOC 2",
  provenance: "SOC 2 PI1 -- Supply Chain Integrity",
  tools: "ISO 42001 Cl.8.5 -- AI System Lifecycle",
};

// ---------------------------------------------------------------------------
// Valid query types and formats
// ---------------------------------------------------------------------------

const VALID_QUERY_TYPES = new Set([
  "sessions",
  "turns",
  "anomalies",
  "cost",
  "tools",
  "risk",
  "compliance",
  "provenance",
]);

const VALID_FORMATS = new Set(["json", "table", "narrative"]);

// ---------------------------------------------------------------------------
// Limit enforcement
// ---------------------------------------------------------------------------

function resolveLimit(requested?: number): number {
  const DEFAULT_LIMIT = 100;
  const MAX_LIMIT = 1000;

  if (requested === undefined || requested === null) return DEFAULT_LIMIT;
  const n = Number(requested);
  if (isNaN(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// ---------------------------------------------------------------------------
// Shortcut resolution
// ---------------------------------------------------------------------------

interface ResolvedShortcut {
  queryType: string;
  filters: Record<string, unknown>;
  groupBy?: string;
  limit?: number;
}

function resolveShortcut(
  shortcut: string,
  params: Record<string, unknown>
): ResolvedShortcut {
  switch (shortcut) {
    case "session_complete": {
      const sessionId = params.sessionId as string | undefined;
      if (!sessionId) {
        throw new Error("session_complete shortcut requires sessionId param");
      }
      return {
        queryType: "sessions",
        filters: { sessionId },
      };
    }
    case "provenance_chain": {
      const artifactPath = params.artifactPath as string | undefined;
      if (!artifactPath) {
        throw new Error(
          "provenance_chain shortcut requires artifactPath param"
        );
      }
      return {
        queryType: "provenance",
        filters: { artifactPath },
      };
    }
    case "recent_anomalies": {
      const now = new Date();
      const ninetyDaysAgo = new Date(
        now.getTime() - 90 * 24 * 3600_000
      );
      return {
        queryType: "anomalies",
        filters: {
          dateRange: {
            from: ninetyDaysAgo.toISOString(),
            to: now.toISOString(),
          },
        },
      };
    }
    case "management_review":
      return {
        queryType: "compliance",
        filters: { framework: "iso42001", clause: "9.3" },
      };
    case "top_spend_team":
      return {
        queryType: "cost",
        filters: {},
        groupBy: "team",
        limit: 1,
      };
    case "model_comparison":
      return {
        queryType: "cost",
        filters: {},
        groupBy: "model",
      };
    default:
      throw new Error("Unknown shortcut. Valid shortcuts: session_complete, provenance_chain, recent_anomalies, management_review, top_spend_team, model_comparison.");
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatJson(
  rows: Record<string, unknown>[],
  totalCount: number,
  attribution: string,
  queryType: string
): Record<string, unknown> {
  return { data: rows, totalCount, attribution, queryType };
}

function formatTable(
  rows: Record<string, unknown>[],
  totalCount: number,
  attribution: string,
  queryType: string
): Record<string, unknown> {
  // Derive columns from first row (or empty)
  const columns =
    rows.length > 0 ? Object.keys(rows[0]) : [];
  const tableRows = rows.map((row) => columns.map((col) => row[col]));
  return { columns, rows: tableRows, totalCount, attribution, queryType };
}

function formatNarrative(
  rows: Record<string, unknown>[],
  totalCount: number,
  attribution: string,
  queryType: string
): Record<string, unknown> {
  let text: string;

  switch (queryType) {
    case "sessions":
      text = `Found ${totalCount} session${totalCount !== 1 ? "s" : ""}.`;
      if (rows.length > 0) {
        const providers = [...new Set(rows.map((r) => r.provider))].filter(Boolean);
        if (providers.length > 0) {
          text += ` Providers: ${providers.join(", ")}.`;
        }
      }
      break;
    case "turns":
      text = `Found ${totalCount} turn${totalCount !== 1 ? "s" : ""}.`;
      break;
    case "anomalies": {
      text = `Found ${totalCount} anomal${totalCount !== 1 ? "ies" : "y"}.`;
      const critical = rows.filter((r) => r.severity === "critical").length;
      const warnings = rows.filter((r) => r.severity === "warning").length;
      const parts: string[] = [];
      if (critical > 0) parts.push(`${critical} are critical`);
      if (warnings > 0) parts.push(`${warnings} are warnings`);
      if (parts.length > 0) text += ` ${parts.join(", ")}.`;
      break;
    }
    case "cost": {
      const totalCost = rows.reduce(
        (sum, r) => sum + Number(r.total_cost_usd ?? 0),
        0
      );
      text = `Total cost: $${totalCost.toFixed(2)} across ${totalCount} group${totalCount !== 1 ? "s" : ""}.`;
      break;
    }
    case "tools":
      text = `Found ${totalCount} tool call${totalCount !== 1 ? "s" : ""}.`;
      break;
    case "risk":
      text = `Found ${totalCount} session${totalCount !== 1 ? "s" : ""} with risk data.`;
      break;
    case "compliance":
      text = `${totalCount} compliance check${totalCount !== 1 ? "s" : ""} evaluated.`;
      break;
    case "provenance":
      text = `Found ${totalCount} provenance record${totalCount !== 1 ? "s" : ""} for the artifact.`;
      break;
    default:
      text = `Query returned ${totalCount} result${totalCount !== 1 ? "s" : ""}.`;
  }

  return { text, attribution, queryType };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleQuery(
  body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<QueryResult> {
  const req = body as QueryRequest;

  // Validate: exactly one of queryType or shortcut
  const hasQueryType = req.queryType !== undefined && req.queryType !== null;
  const hasShortcut = req.shortcut !== undefined && req.shortcut !== null;

  if (hasQueryType && hasShortcut) {
    return {
      status: 400,
      body: {
        error: "Provide either queryType or shortcut, not both.",
      },
    };
  }

  if (!hasQueryType && !hasShortcut) {
    return {
      status: 400,
      body: { error: "Request must include queryType or shortcut." },
    };
  }

  // Validate format
  const format = (req.format as string) ?? "json";
  if (!VALID_FORMATS.has(format)) {
    return {
      status: 400,
      body: {
        error: "Invalid format. Must be one of: json, table, narrative.",
      },
    };
  }

  // Resolve shortcut to queryType + filters + groupBy
  let queryType: string;
  let filters: Record<string, unknown>;
  let groupBy: string | undefined = req.groupBy;
  let effectiveLimit = resolveLimit(req.limit);

  if (hasShortcut) {
    try {
      const resolved = resolveShortcut(
        req.shortcut as string,
        (req.params ?? {}) as Record<string, unknown>
      );
      queryType = resolved.queryType;
      filters = resolved.filters;
      if (resolved.groupBy) groupBy = resolved.groupBy;
      if (resolved.limit) effectiveLimit = resolved.limit;
    } catch (err) {
      return {
        status: 400,
        body: {
          error:
            err instanceof Error ? err.message : "Invalid shortcut parameters.",
        },
      };
    }
  } else {
    queryType = req.queryType as string;
    filters = (req.filters ?? {}) as Record<string, unknown>;
  }

  // Validate queryType
  if (!VALID_QUERY_TYPES.has(queryType)) {
    return {
      status: 400,
      body: {
        error: `Unknown queryType. Valid types: ${[...VALID_QUERY_TYPES].join(", ")}.`,
      },
    };
  }

  // Provenance requires `artifactPath` — validate at the HTTP layer so
  // that callers see a clean 400 instead of a 500. The data-layer
  // dispatcher tolerates the missing-filter case (returns empty) for
  // direct (non-HTTP) consumers.
  if (
    queryType === "provenance" &&
    (typeof filters.artifactPath !== "string" || filters.artifactPath.length === 0)
  ) {
    return {
      status: 400,
      body: { error: "provenance query requires artifactPath filter" },
    };
  }

  // Project scoping
  const projectId = (filters.projectId as string | undefined) ?? apiKey.projectId;
  if (!projectId) {
    return {
      status: 400,
      body: {
        error:
          "projectId is required. Admin keys must specify projectId in the request body.",
      },
    };
  }

  // 30s client-side timeout via Promise.race. Server-side
  // statement_timeout was removed (N1/N2 fix — wrong pool connection).
  // TODO(plan-task-16): wire a per-request AbortController into
  // runStructuredQuery's options.signal once chunk-9 lands.
  let rows: Record<string, unknown>[];
  let totalCount: number;

  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      runStructuredQuery(queryType, projectId, filters, groupBy, effectiveLimit)
        .finally(() => { if (timer) clearTimeout(timer); }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Query timeout (30s)")), 30_000);
      }),
    ]);
    rows = result.rows;
    totalCount = result.totalCount;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Query execution failed";

    // provenance without artifactPath -> 400
    if (message.includes("requires artifactPath")) {
      return { status: 400, body: { error: message } };
    }
    if (message.includes("requires sessionId")) {
      return { status: 400, body: { error: message } };
    }

    console.error("Query builder error:", message);
    return {
      status: 500,
      body: { error: "Query execution failed" },
    };
  }

  // Format output
  const attribution = ATTRIBUTION[queryType] ?? "";

  switch (format) {
    case "table":
      return {
        status: 200,
        body: formatTable(rows, totalCount, attribution, queryType),
      };
    case "narrative":
      return {
        status: 200,
        body: formatNarrative(rows, totalCount, attribution, queryType),
      };
    case "json":
    default:
      return {
        status: 200,
        body: formatJson(rows, totalCount, attribution, queryType),
      };
  }
}
