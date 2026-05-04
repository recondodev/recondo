import { useState, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { DataTable } from "../components/DataTable";
import { SearchInput } from "../components/SearchInput";
import { FilterBar } from "../components/FilterBar";
import { Pagination } from "../components/Pagination";
import { TagPill } from "../components/TagPill";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { EmptyState } from "../components/EmptyState";
import { graphqlRequest, extractField } from "../graphql/client";
import { getApiToken } from "../api/client";
import { formatTokens, truncateId } from "../utils/formatters";
import type { AuditEntry, AuditConnection } from "../types/graphql";

// ---------------------------------------------------------------------------
// GraphQL query
// ---------------------------------------------------------------------------

const AUDIT_TRAIL_QUERY = `
  query AuditTrail($search: String, $type: AuditTypeFilter, $period: Period, $limit: Int, $offset: Int) {
    auditTrail(search: $search, type: $type, period: $period, limit: $limit, offset: $offset) {
      items {
        timestamp
        sessionId
        sequenceNum
        provider
        model
        requestHash
        responseHash
        totalTokens
        integrityStatus
        httpStatus
        captureComplete
      }
      total
      limit
      offset
    }
  }
`;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

const TYPE_FILTERS = ["All Events", "Requests", "Responses", "Anomalies"];

const TYPE_FILTER_MAP: Record<string, string | undefined> = {
  "All Events": undefined,
  Requests: "REQUESTS",
  Responses: "RESPONSES",
  Anomalies: "ANOMALIES",
};

// B2: Time range filters (same pattern as CostUsage)
const TIME_RANGES = ["Today", "7 days", "30 days", "Quarter"];

const TIME_RANGE_MAP: Record<string, string> = {
  Today: "DAY_1",
  "7 days": "DAY_7",
  "30 days": "DAY_30",
  Quarter: "DAY_90",
};

// W6: Module-level constant to avoid creating new reference on every render
const EMPTY_ENTRIES: AuditEntry[] = [];

// B1: Map integrity status to CSS class for status-specific coloring
const INTEGRITY_CLASS_MAP: Record<string, string> = {
  verified: "tag-ok",
  partial: "tag-warn",
  retry: "tag-warn",
  failed: "tag-fail",
};

// ---------------------------------------------------------------------------
// Table columns
// ---------------------------------------------------------------------------

const columns = [
  {
    key: "timestamp",
    header: "Timestamp",
    render: (row: AuditEntry) => new Date(row.timestamp).toLocaleString(),
    sortable: true,
    // Sort by raw ISO timestamp so chronological order is preserved across
    // locales (the rendered string is locale-formatted).
    getSortValue: (row: AuditEntry) => row.timestamp,
  },
  {
    key: "sessionId",
    header: "Session",
    // W1: Show sessionId (not just sequenceNum) with full value on hover via title
    render: (row: AuditEntry) => (
      <span className="mono" title={row.sessionId} aria-label={`Session ${row.sessionId}`}>
        {row.sessionId.slice(0, 5)}..#{row.sequenceNum}
      </span>
    ),
    sortable: true,
    getSortValue: (row: AuditEntry) => row.sessionId,
  },
  {
    key: "sequenceNum",
    header: "Turn #",
    render: (row: AuditEntry) => String(row.sequenceNum),
    sortable: true,
    getSortValue: (row: AuditEntry) => row.sequenceNum,
  },
  {
    key: "provider",
    header: "Provider",
    render: (row: AuditEntry) => (
      <span aria-label={row.provider} title={row.provider}>
        {row.model ?? row.provider}
      </span>
    ),
    sortable: true,
    // Sort by what's rendered (model when present, else provider) so the
    // visible text matches the sort order.
    getSortValue: (row: AuditEntry) => row.model ?? row.provider,
  },
  {
    key: "requestHash",
    header: "Request Hash",
    render: (row: AuditEntry) => (
      <span className="mono">{row.requestHash ?? "--"}</span>
    ),
    sortable: true,
    getSortValue: (row: AuditEntry) => row.requestHash ?? null,
  },
  {
    key: "responseHash",
    header: "Response Hash",
    render: (row: AuditEntry) => (
      <span className="mono">{row.responseHash ?? "--"}</span>
    ),
    sortable: true,
    getSortValue: (row: AuditEntry) => row.responseHash ?? null,
  },
  {
    key: "tokens",
    header: "Tokens",
    render: (row: AuditEntry) => formatTokens(row.totalTokens),
    sortable: true,
    getSortValue: (row: AuditEntry) => row.totalTokens,
  },
  {
    key: "integrity",
    header: "Integrity",
    // B1: Status-specific coloring via className mapping
    render: (row: AuditEntry) => (
      <TagPill
        variant="status"
        label={row.integrityStatus}
        className={INTEGRITY_CLASS_MAP[row.integrityStatus] ?? ""}
      />
    ),
    sortable: true,
    getSortValue: (row: AuditEntry) => row.integrityStatus,
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AuditTrail() {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("All Events");
  const [currentPage, setCurrentPage] = useState(1);
  // B2: Time range state
  const [timeRange, setTimeRange] = useState("30 days");

  const period = TIME_RANGE_MAP[timeRange];

  const auditQuery = useQuery({
    // B2: Include period in queryKey for re-fetch
    queryKey: ["auditTrail", search, typeFilter, currentPage, period],
    queryFn: async ({ signal }) => {
      // N1: Compute variables inline in queryFn instead of useCallback wrapper
      const variables: Record<string, unknown> = {
        limit: PAGE_SIZE,
        offset: (currentPage - 1) * PAGE_SIZE,
        period,
      };
      if (search) variables.search = search;
      const typeValue = TYPE_FILTER_MAP[typeFilter];
      if (typeValue) variables.type = typeValue;

      const raw = await graphqlRequest<Record<string, unknown>>(
        AUDIT_TRAIL_QUERY,
        variables,
        "AuditTrail",
        signal,
      );
      return extractField<AuditConnection>(raw, "auditTrail");
    },
  });

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleSearch = useCallback((value: string) => {
    setSearch(value);
    setCurrentPage(1);
  }, []);

  // W5: Wrap handleTypeFilter in useCallback
  const handleTypeFilter = useCallback((filter: string) => {
    setTypeFilter(filter);
    setCurrentPage(1);
  }, []);

  // W5: Wrap handlePageChange in useCallback
  const handlePageChange = useCallback((page: number) => {
    setCurrentPage(page);
  }, []);

  // W8: Export CSV via fetch with auth header + blob download
  const handleExportCsv = useCallback(async () => {
    try {
      const token = getApiToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
      const response = await fetch("/v1/audit/export.csv", { headers });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "audit-trail.csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      window.open("/v1/audit/export.csv");
    }
  }, []);

  const handleExportAuditor = useCallback(async () => {
    try {
      const token = getApiToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
      const response = await fetch("/v1/audit/export-auditor.json", { headers });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "audit-trail-auditor.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      window.open("/v1/audit/export-auditor.json");
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const connection = auditQuery.data;
  // W6: Use module-level EMPTY_ENTRIES to avoid creating new reference
  const entries = connection?.items ?? EMPTY_ENTRIES;
  const total = connection?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Compute unique providers for summary pills
  const uniqueProviders = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      if (e.provider) set.add(e.provider);
    }
    return Array.from(set);
  }, [entries]);

  // Compute unique session IDs for summary display
  const uniqueSessions = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      set.add(e.sessionId);
    }
    return Array.from(set);
  }, [entries]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    // N4: aria-live for loading/error transitions
    <div aria-live="polite">
      <div className="header">
        <h2>Audit Trail</h2>
        <span className="text-dim">
          Chain of custody: every field is SHA-256 verified
        </span>
        <span className="text-dim">{total} total</span>
      </div>

      <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
        <button onClick={handleExportCsv}>Export CSV</button>
        <button onClick={handleExportAuditor}>Export for Auditor</button>
      </div>

      {/* B2: Time range filter */}
      <div className="filters">
        <FilterBar
          filters={TIME_RANGES}
          active={timeRange}
          onFilterChange={setTimeRange}
        />
      </div>

      {auditQuery.isLoading ? (
        <LoadingState message="Loading audit trail..." />
      ) : auditQuery.isError ? (
        <ErrorState
          message={auditQuery.error?.message ?? "Failed to load audit trail"}
        />
      ) : (
        <>
          {/* Search */}
          <div className="filters">
            <SearchInput
              value={search}
              onChange={handleSearch}
              placeholder="Search audit trail..."
            />
          </div>

          {/* Type filter */}
          <div className="filters">
            <FilterBar
              filters={TYPE_FILTERS}
              active={typeFilter}
              onFilterChange={handleTypeFilter}
            />
          </div>

          {/* Summary: unique providers and sessions */}
          {entries.length > 0 && (
            <div className="summary" style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px" }}>
              {uniqueProviders.map((prov) => (
                <TagPill key={prov} variant="provider" label={prov} />
              ))}
              {uniqueSessions.map((sid) => (
                <span key={sid} className="mono text-dim" style={{ fontSize: "0.85em" }}>
                  {truncateId(sid)}
                </span>
              ))}
            </div>
          )}

          {/* Audit table */}
          {entries.length === 0 ? (
            <EmptyState message="No audit entries found" />
          ) : (
            <>
              <DataTable
                columns={columns}
                data={entries}
                rowKey={(row) => `${row.sessionId}-${row.sequenceNum}`}
                ariaLabel="Audit trail table"
              />

              {/* Pagination */}
              {totalPages > 1 && (
                <Pagination
                  currentPage={currentPage}
                  totalPages={totalPages}
                  onPageChange={handlePageChange}
                />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
