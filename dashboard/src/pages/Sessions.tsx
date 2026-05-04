import { useState, useCallback, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
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
import { formatTokens, formatCost, formatDuration, truncateId } from "../utils/formatters";
import type { SessionItem, SessionConnection } from "../types/graphql";
import {
  ALL_SESSION_FILTERS,
  SESSION_FRAMEWORK_MAP,
  buildSessionSearchParams,
  normalizeSessionFilter,
} from "./sessionsShared";

// ---------------------------------------------------------------------------
// GraphQL query
// ---------------------------------------------------------------------------

const SESSIONS_QUERY = `
  query Sessions($filter: SessionFilter, $limit: Int, $offset: Int) {
    sessions(filter: $filter, limit: $limit, offset: $offset) {
      items {
        id
        framework
        model
        totalTurns
        totalTokens
        totalCostUsd
        duration
        status
        startedAt
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

// B3: PAGE_SIZE changed from 1 to 20 for server-side pagination.
const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Table columns
// ---------------------------------------------------------------------------

// Framework display name mapping for TagPill labels
const FRAMEWORK_DISPLAY: Record<string, string> = {
  "claude-code": "claude-code",
  "claude_code": "claude-code",
  "cursor": "cursor",
  "codex": "codex",
  "codex_cli_rs": "codex",
  "aider": "aider",
};

function frameworkLabel(fw: string | null | undefined): string {
  if (!fw) return "";
  return FRAMEWORK_DISPLAY[fw.toLowerCase()] ?? fw;
}

function isPreflightOnly(row: SessionItem): boolean {
  return row.totalTurns <= 1 && row.totalTokens === 0;
}

const columns = [
  {
    key: "id",
    header: "Session ID",
    render: (row: SessionItem) => (
      <span className="mono">{truncateId(row.id)}</span>
    ),
    sortable: true,
    getSortValue: (row: SessionItem) => row.id,
  },
  {
    key: "framework",
    header: "Framework",
    render: (row: SessionItem) => {
      const label = frameworkLabel(row.framework);
      return label ? <TagPill variant="framework" label={label} /> : <span>--</span>;
    },
    sortable: true,
    getSortValue: (row: SessionItem) => frameworkLabel(row.framework) || null,
  },
  {
    key: "model",
    header: "Model",
    render: (row: SessionItem) => row.model ?? "--",
    sortable: true,
    getSortValue: (row: SessionItem) => row.model ?? null,
  },
  {
    key: "turns",
    header: "Turns",
    render: (row: SessionItem) => String(row.totalTurns),
    sortable: true,
    getSortValue: (row: SessionItem) => row.totalTurns,
  },
  {
    key: "tokens",
    header: "Tokens",
    render: (row: SessionItem) => formatTokens(row.totalTokens),
    sortable: true,
    getSortValue: (row: SessionItem) => row.totalTokens,
  },
  {
    key: "cost",
    header: "Cost",
    render: (row: SessionItem) => formatCost(row.totalCostUsd),
    sortable: true,
    getSortValue: (row: SessionItem) => row.totalCostUsd,
  },
  {
    key: "duration",
    header: "Duration",
    render: (row: SessionItem) => formatDuration(row.duration),
    sortable: true,
    getSortValue: (row: SessionItem) => row.duration,
  },
  {
    key: "status",
    header: "Status",
    render: (row: SessionItem) => (
      <TagPill variant="status" label={row.status} />
    ),
    sortable: true,
    getSortValue: (row: SessionItem) => row.status,
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Sessions() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlSearch = searchParams.get("search") ?? "";
  const urlFilter = normalizeSessionFilter(searchParams.get("filter"));
  const urlShowNonLlm = searchParams.get("showNonLlm") === "1";
  const [search, setSearch] = useState(() => urlSearch);
  const [activeFilter, setActiveFilter] = useState(() => urlFilter);
  const [showNonLlm, setShowNonLlm] = useState(() => urlShowNonLlm);
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    setSearch(urlSearch);
    setActiveFilter(urlFilter);
    setShowNonLlm(urlShowNonLlm);
    setCurrentPage(1);
  }, [urlSearch, urlFilter, urlShowNonLlm]);

  // Build filter variables for query
  const buildVariables = useCallback(() => {
    const filter: Record<string, string | boolean | undefined> = {};

    if (search) filter.search = search;

    // Status filters
    if (activeFilter === "Active") filter.status = "active";
    else if (activeFilter === "Completed") filter.status = "completed";
    // Framework filters
    else if (activeFilter in SESSION_FRAMEWORK_MAP) {
      filter.framework = SESSION_FRAMEWORK_MAP[activeFilter];
    }

    // The resolver hides non-LLM traffic (telemetry, OAuth, update checks)
    // by default. Only override when the user opts in to seeing them.
    if (showNonLlm) filter.hideNonLlm = false;

    const variables: Record<string, unknown> = {
      limit: PAGE_SIZE,
      offset: (currentPage - 1) * PAGE_SIZE,
    };

    if (Object.keys(filter).length > 0) {
      variables.filter = filter;
    }

    return variables;
  }, [search, activeFilter, showNonLlm, currentPage]);

  // B4: pass signal from TanStack Query context to graphqlRequest
  const sessionsQuery = useQuery({
    queryKey: ["sessions", search, activeFilter, showNonLlm, currentPage],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        SESSIONS_QUERY,
        buildVariables(),
        "Sessions",
        signal,
      );
      return extractField<SessionConnection>(raw, "sessions");
    },
    // Refresh the list every 5s so new sessions appear and existing ones
    // update their token/cost/turn counts without a manual reload.
    refetchInterval: 5000,
  });

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleRowClick = useCallback(
    (row: SessionItem) => {
      const qs = searchParams.toString();
      navigate({
        pathname: `/sessions/${row.id}`,
        search: qs ? `?${qs}` : "",
      });
    },
    [navigate, searchParams],
  );

  const syncSearchParams = useCallback(
    (nextSearch: string, nextFilter: string, nextShowNonLlm: boolean) => {
      setSearchParams(buildSessionSearchParams({
        search: nextSearch,
        filter: nextFilter,
        showNonLlm: nextShowNonLlm,
      }), { replace: true });
    },
    [setSearchParams],
  );

  const handleFilterChange = (filter: string) => {
    setActiveFilter(filter);
    setCurrentPage(1);
    syncSearchParams(search, filter, showNonLlm);
  };

  const handleSearch = useCallback((value: string) => {
    setSearch(value);
    setCurrentPage(1);
    syncSearchParams(value, activeFilter, showNonLlm);
  }, [activeFilter, showNonLlm, syncSearchParams]);

  const handleShowNonLlmChange = (next: boolean) => {
    setShowNonLlm(next);
    setCurrentPage(1);
    syncSearchParams(search, activeFilter, next);
  };

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
  };

  // ---------------------------------------------------------------------------
  // Derived state (hooks must be before any early returns)
  // ---------------------------------------------------------------------------

  const connection = sessionsQuery.data;
  const sessions = connection?.items ?? [];
  const total = connection?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="page-shell">
      <div className="header">
        <h2>Sessions</h2>
        <div className="header-meta">
          <label
            className="non-llm-toggle"
            title="Show non-LLM traffic captured by the gateway (telemetry pings, OAuth refreshes, update checks). Hidden by default."
          >
            <input
              type="checkbox"
              checked={showNonLlm}
              onChange={(e) => handleShowNonLlmChange(e.target.checked)}
            />
            <span>Show non-LLM traffic</span>
          </label>
          <SearchInput
            key={`sessions-search-${search}`}
            value={search}
            onChange={handleSearch}
            placeholder="Search sessions by intent, model, or agent..."
          />
        </div>
      </div>

      {sessionsQuery.isLoading ? (
        <LoadingState message="Loading sessions..." />
      ) : sessionsQuery.isError ? (
        <ErrorState
          message={sessionsQuery.error?.message ?? "Failed to load sessions"}
        />
      ) : (
        <>
          <FilterBar
            filters={ALL_SESSION_FILTERS}
            active={activeFilter}
            onFilterChange={handleFilterChange}
          />

          {sessions.length === 0 ? (
            <EmptyState message="No sessions found" />
          ) : (
            <>
              <DataTable
                columns={columns}
                data={sessions}
                rowKey={(row) => row.id}
                onRowClick={handleRowClick}
                rowClassName={(row) => isPreflightOnly(row) ? "row-preflight" : undefined}
                ariaLabel="Sessions table"
              />

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
