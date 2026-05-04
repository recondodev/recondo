import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { MetricCard } from "../components/MetricCard";
import { DataTable } from "../components/DataTable";
import { FilterBar } from "../components/FilterBar";
import { ChartBox } from "../components/ChartBox";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { EmptyState } from "../components/EmptyState";
import { graphqlRequest, extractField } from "../graphql/client";
import { formatTokens, formatCost } from "../utils/formatters";
import type {
  AgentSummary,
  SpendByCategory,
  TopDeveloper,
  TopDevelopersConnection,
  TopRepository,
  TopRepositoriesConnection,
} from "../types/graphql";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// ---------------------------------------------------------------------------
// GraphQL queries -- unused fields (frameworkCount, medianTurns, lastActive)
// removed per N1 review finding
// ---------------------------------------------------------------------------

const AGENT_SUMMARY_QUERY = `
  query AgentSummary {
    agentSummary {
      activeAgents
      totalSessions
      sessionsDelta
      averageTurnsPerSession
      uniqueDevelopers
    }
  }
`;

const AGENT_FRAMEWORK_DISTRIBUTION_QUERY = `
  query AgentFrameworkDistribution {
    agentFrameworkDistribution {
      name
      count
      percentage
      costUsd
    }
  }
`;

const TOP_DEVELOPERS_QUERY = `
  query TopDevelopers($limit: Int, $offset: Int) {
    topDevelopers(limit: $limit, offset: $offset) {
      items {
        accountUuid
        sessionCount
        totalTokens
        totalCostUsd
        favoriteModel
      }
      total
      limit
      offset
    }
  }
`;

const TOP_REPOSITORIES_QUERY = `
  query TopRepositories($limit: Int, $offset: Int) {
    topRepositories(limit: $limit, offset: $offset) {
      items {
        repository
        sessionCount
        branchCount
        totalCostUsd
        primaryFramework
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

const VIEW_FILTERS = ["All Agents", "By Developer", "By Repository"];

const PIE_COLORS = [
  "#6366f1",
  "#22c55e",
  "#eab308",
  "#ef4444",
  "#06b6d4",
  "#f97316",
  "#a855f7",
  "#ec4899",
];

const FRAMEWORK_LABELS: Record<string, string> = {
  claude_code: "Claude Code",
  "claude-code": "Claude Code",
  codex_cli_rs: "Codex",
  codex: "Codex",
  cursor: "Cursor",
  aider: "Aider",
  gemini_cli: "Gemini CLI",
  unknown: "Unknown",
};

const FRAMEWORK_COLORS: Record<string, string> = {
  claude_code: "#8b5cf6",
  "claude-code": "#8b5cf6",
  codex_cli_rs: "#38bdf8",
  codex: "#38bdf8",
  cursor: "#22c55e",
  aider: "#f97316",
  gemini_cli: "#f59e0b",
  unknown: "#64748b",
};

type FrameworkChartDatum = {
  rawName: string;
  name: string;
  value: number;
  percentage: number;
  costUsd: number;
};

function formatFrameworkLabel(framework: string): string {
  const normalized = framework.trim().toLowerCase();
  if (!normalized) return "Unknown";
  if (FRAMEWORK_LABELS[normalized]) return FRAMEWORK_LABELS[normalized];
  return framework
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getFrameworkColor(framework: string, idx: number): string {
  return FRAMEWORK_COLORS[framework.toLowerCase()] ?? PIE_COLORS[idx % PIE_COLORS.length];
}

function formatPercentage(value: number): string {
  const digits = Number.isInteger(value) ? 0 : 1;
  return `${value.toFixed(digits)}%`;
}

function formatAverageTurns(value: number): string {
  return value.toFixed(1);
}

function FrameworkTooltip(
  { active, payload }: { active?: boolean; payload?: Array<{ payload: FrameworkChartDatum }> },
) {
  const datum = payload?.[0]?.payload;

  if (!active || !datum) return null;

  return (
    <div
      style={{
        background: "rgba(18, 23, 34, 0.98)",
        border: "1px solid var(--border)",
        borderRadius: "12px",
        boxShadow: "0 18px 32px rgba(0, 0, 0, 0.28)",
        color: "var(--text)",
        minWidth: "180px",
        padding: "12px 14px",
      }}
    >
      <div style={{ color: "var(--text)", fontWeight: 700, marginBottom: "6px" }}>
        {datum.name}
      </div>
      <div className="mono" style={{ color: "var(--text-dim)", fontSize: "12px" }}>
        {datum.value.toLocaleString()} sessions
      </div>
      <div className="mono" style={{ color: "var(--text)", fontSize: "12px", marginTop: "4px" }}>
        {formatPercentage(datum.percentage)}
        {datum.costUsd > 0 ? ` • ${formatCost(datum.costUsd)}` : ""}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Developer table columns
// ---------------------------------------------------------------------------

const developerColumns = [
  {
    key: "developer",
    header: "Developer",
    render: (row: TopDeveloper) => (
      <span className="mono">{row.accountUuid}</span>
    ),
    sortable: true,
    getSortValue: (row: TopDeveloper) => row.accountUuid,
  },
  {
    key: "sessions",
    header: "Sessions",
    render: (row: TopDeveloper) => String(row.sessionCount),
    sortable: true,
    getSortValue: (row: TopDeveloper) => row.sessionCount,
  },
  {
    key: "tokens",
    header: "Tokens",
    render: (row: TopDeveloper) => formatTokens(row.totalTokens),
    sortable: true,
    getSortValue: (row: TopDeveloper) => row.totalTokens,
  },
  {
    key: "cost",
    header: "Cost",
    render: (row: TopDeveloper) => formatCost(row.totalCostUsd),
    sortable: true,
    getSortValue: (row: TopDeveloper) => row.totalCostUsd,
  },
  {
    key: "favoriteModel",
    header: "Favorite Model",
    render: (row: TopDeveloper) => row.favoriteModel ?? "--",
    sortable: true,
    getSortValue: (row: TopDeveloper) => row.favoriteModel ?? null,
  },
];

// ---------------------------------------------------------------------------
// Repository table columns
// ---------------------------------------------------------------------------

const repositoryColumns = [
  {
    key: "repository",
    header: "Repository",
    render: (row: TopRepository) => row.repository,
    sortable: true,
    getSortValue: (row: TopRepository) => row.repository,
  },
  {
    key: "sessions",
    header: "Sessions",
    render: (row: TopRepository) => String(row.sessionCount),
    sortable: true,
    getSortValue: (row: TopRepository) => row.sessionCount,
  },
  {
    key: "branches",
    header: "Branches",
    render: (row: TopRepository) => String(row.branchCount),
    sortable: true,
    getSortValue: (row: TopRepository) => row.branchCount,
  },
  {
    key: "cost",
    header: "Cost",
    render: (row: TopRepository) => formatCost(row.totalCostUsd),
    sortable: true,
    getSortValue: (row: TopRepository) => row.totalCostUsd,
  },
  {
    key: "primaryAgent",
    header: "Primary Agent",
    render: (row: TopRepository) => row.primaryFramework ?? "--",
    sortable: true,
    getSortValue: (row: TopRepository) => row.primaryFramework ?? null,
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AgentAnalytics() {
  const [viewFilter, setViewFilter] = useState("All Agents");

  // Agent summary
  const summaryQuery = useQuery({
    queryKey: ["agentSummary"],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        AGENT_SUMMARY_QUERY,
        undefined,
        "AgentSummary",
        signal,
      );
      return extractField<AgentSummary>(raw, "agentSummary");
    },
  });

  // Top developers
  const developersQuery = useQuery({
    queryKey: ["topDevelopers"],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        TOP_DEVELOPERS_QUERY,
        { limit: 10, offset: 0 },
        "TopDevelopers",
        signal,
      );
      return extractField<TopDevelopersConnection>(raw, "topDevelopers");
    },
    refetchOnWindowFocus: false,
  });

  const frameworkDistributionQuery = useQuery({
    queryKey: ["agentFrameworkDistribution"],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        AGENT_FRAMEWORK_DISTRIBUTION_QUERY,
        undefined,
        "AgentFrameworkDistribution",
        signal,
      );
      const extracted = extractField<unknown>(raw, "agentFrameworkDistribution");
      return Array.isArray(extracted) ? extracted as SpendByCategory[] : [];
    },
    refetchOnWindowFocus: false,
  });

  // Top repositories
  const repositoriesQuery = useQuery({
    queryKey: ["topRepositories"],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        TOP_REPOSITORIES_QUERY,
        { limit: 10, offset: 0 },
        "TopRepositories",
        signal,
      );
      return extractField<TopRepositoriesConnection>(raw, "topRepositories");
    },
    refetchOnWindowFocus: false,
  });

  // ---------------------------------------------------------------------------
  // Loading / Error
  // ---------------------------------------------------------------------------

  const allLoading =
    summaryQuery.isLoading ||
    frameworkDistributionQuery.isLoading ||
    developersQuery.isLoading ||
    repositoriesQuery.isLoading;

  const anyError =
    summaryQuery.isError ||
    frameworkDistributionQuery.isError ||
    developersQuery.isError ||
    repositoriesQuery.isError;

  const errorMessage =
    summaryQuery.error?.message ||
    frameworkDistributionQuery.error?.message ||
    developersQuery.error?.message ||
    repositoriesQuery.error?.message ||
    "Failed to load agent analytics data";

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------

  const summary = summaryQuery.data;
  const frameworkRows = frameworkDistributionQuery.data ?? [];
  const developers = developersQuery.data?.items ?? [];
  const repositories = repositoriesQuery.data?.items ?? [];

  // Detect empty state (all key values zero)
  const isEmptyState =
    !!summary &&
    summary.activeAgents === 0 &&
    summary.totalSessions === 0 &&
    summary.uniqueDevelopers === 0;

  // Framework distribution comes from real session aggregation so frameworks
  // without account UUIDs still appear in the chart.
  const frameworkDistribution = useMemo(() => {
    return frameworkRows
      .filter((row) => row.count > 0)
      .map((row) => ({
        rawName: row.name,
        name: formatFrameworkLabel(row.name),
        value: row.count,
        percentage: row.percentage,
        costUsd: row.costUsd,
      }));
  }, [frameworkRows]);

  // Determine section visibility based on filter (W4)
  const showDevelopers = viewFilter === "All Agents" || viewFilter === "By Developer";
  const showRepositories = viewFilter === "All Agents" || viewFilter === "By Repository";

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div aria-live="polite">
      <div className="header">
        <h2>Agent Analytics</h2>
      </div>

      <div className="filters">
        <FilterBar
          filters={VIEW_FILTERS}
          active={viewFilter}
          onFilterChange={setViewFilter}
        />
      </div>

      {allLoading ? (
        <LoadingState message="Loading agent analytics data..." />
      ) : anyError ? (
        <ErrorState message={errorMessage} />
      ) : isEmptyState ? (
        /* Empty state: show single "Active Agents" card with "0" + empty message */
        <>
          <div className="cards">
            <MetricCard
              label="Active Agents"
              value={String(summary!.activeAgents)}
            />
          </div>
          <EmptyState message="No agent data yet -- route agent traffic through the gateway to get started." />
        </>
      ) : (
        <>
          {summary && (
            <>
              <div className="cards">
                <MetricCard
                  label="Active Agents"
                  value={String(summary.activeAgents)}
                />
                <MetricCard
                  label="Total Sessions"
                  value={summary.totalSessions.toLocaleString()}
                  delta={
                    summary.sessionsDelta !== 0
                      ? {
                          value: `${Math.abs(summary.sessionsDelta)}%`,
                          direction:
                            summary.sessionsDelta > 0 ? "up" : "down",
                        }
                      : undefined
                  }
                />
                <MetricCard
                  label="Avg Turns/Session"
                  value={formatAverageTurns(summary.averageTurnsPerSession)}
                />
                <MetricCard
                  label="Unique Developers"
                  value={String(summary.uniqueDevelopers)}
                />
              </div>

              <ChartBox title="Framework Distribution">
                {frameworkDistribution.length > 0 ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "24px",
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ flex: "1 1 320px", minWidth: "280px", height: "280px" }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={frameworkDistribution}
                            dataKey="value"
                            nameKey="name"
                            cx="50%"
                            cy="50%"
                            innerRadius={62}
                            outerRadius={92}
                            paddingAngle={2}
                            stroke="var(--bg)"
                            strokeWidth={3}
                          >
                            {frameworkDistribution.map((item, idx) => (
                              <Cell
                                key={`cell-${item.rawName}-${idx}`}
                                fill={getFrameworkColor(item.rawName, idx)}
                              />
                            ))}
                          </Pie>
                          <Tooltip
                            cursor={false}
                            content={<FrameworkTooltip />}
                            wrapperStyle={{ outline: "none" }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>

                    <div style={{ flex: "1 1 280px", minWidth: "240px" }}>
                      {frameworkDistribution.map((item, idx) => (
                        <div
                          key={item.rawName}
                          style={{
                            alignItems: "center",
                            borderBottom: idx === frameworkDistribution.length - 1
                              ? "none"
                              : "1px solid var(--border)",
                            display: "grid",
                            gap: "12px",
                            gridTemplateColumns: "12px minmax(0, 1fr) auto",
                            padding: "12px 0",
                          }}
                        >
                          <span
                            aria-hidden="true"
                            style={{
                              background: getFrameworkColor(item.rawName, idx),
                              borderRadius: "999px",
                              display: "block",
                              height: "12px",
                              width: "12px",
                            }}
                          />
                          <div>
                            <div style={{ color: "var(--text)", fontWeight: 600 }}>
                              {item.name}
                            </div>
                            <div className="text-dim mono" style={{ fontSize: "12px" }}>
                              {item.value.toLocaleString()} sessions
                            </div>
                          </div>
                          <div className="mono" style={{ color: "var(--text)" }}>
                            {formatPercentage(item.percentage)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-dim">No framework distribution data</p>
                )}
              </ChartBox>
            </>
          )}

          {showDevelopers && (
            <div data-testid="developers-section">
              <h3>Top Developers</h3>
              {developers.length === 0 ? (
                <p className="text-dim">No developer data available</p>
              ) : (
                <DataTable
                  columns={developerColumns}
                  data={developers}
                  rowKey={(row) => row.accountUuid}
                  ariaLabel="Top developers table"
                />
              )}
            </div>
          )}

          {showRepositories && (
            <div data-testid="repositories-section">
              <h3>Top Repositories</h3>
              {repositories.length === 0 ? (
                <p className="text-dim">No repository data available</p>
              ) : (
                <DataTable
                  columns={repositoryColumns}
                  data={repositories}
                  rowKey={(row) => row.repository}
                  ariaLabel="Top repositories table"
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
