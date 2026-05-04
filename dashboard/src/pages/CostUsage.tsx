import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MetricCard } from "../components/MetricCard";
import { CostBar } from "../components/CostBar";
import { FilterBar } from "../components/FilterBar";
import { ChartBox } from "../components/ChartBox";
import { TwoColumnLayout } from "../components/TwoColumnLayout";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { graphqlRequest, extractField } from "../graphql/client";
import { formatCost } from "../utils/formatters";
import type {
  UsageSummary,
  SpendByCategory,
  CostProjection,
} from "../types/graphql";
import styles from "./CostUsage.module.css";

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const USAGE_SUMMARY_QUERY = `
  query UsageSummary($period: Period) {
    usageSummary(period: $period) {
      totalCostUsd
      projectedMonthlyCostUsd
      totalTokens
      cacheReadTokens
      cacheReadPercentage
      averageCostPerSession
      averageCostDelta
      cacheHitRate
      cacheSavingsUsd
      costPerDeveloperPerDay
      developerCount
    }
  }
`;

const SPEND_BY_PROVIDER_QUERY = `
  query SpendByProvider($period: Period) {
    spendByProvider(period: $period) {
      name
      costUsd
      percentage
      count
    }
  }
`;

const SPEND_BY_MODEL_QUERY = `
  query SpendByModel($period: Period) {
    spendByModel(period: $period) {
      name
      costUsd
      percentage
      count
    }
  }
`;

const SPEND_BY_FRAMEWORK_QUERY = `
  query SpendByFramework($period: Period) {
    spendByFramework(period: $period) {
      name
      costUsd
      percentage
      count
    }
  }
`;

const DAILY_SPEND_QUERY = `
  query DailySpend($days: Int) {
    dailySpend(days: $days) {
      name
      costUsd
      percentage
      count
    }
  }
`;

const COST_PROJECTIONS_QUERY = `
  query CostProjections {
    costProjections {
      month
      projectedSessions
      projectedTokens
      projectedCostUsd
      deltaVsCurrent
      assumptions
    }
  }
`;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIME_RANGES = ["Today", "7 days", "30 days", "Quarter"];

const TIME_RANGE_MAP: Record<string, string> = {
  Today: "DAY_1",
  "7 days": "DAY_7",
  "30 days": "DAY_30",
  Quarter: "DAY_90",
};

const DAYS_MAP: Record<string, number> = {
  Today: 1,
  "7 days": 7,
  "30 days": 30,
  Quarter: 90,
};

const PROVIDER_COLORS: Record<string, string> = {
  Anthropic: "linear-gradient(90deg, #7c3aed, #a855f7)",
  OpenAI: "linear-gradient(90deg, #059669, #34d399)",
  Gemini: "linear-gradient(90deg, #d97706, #fbbf24)",
};

const MODEL_COLORS: Record<string, string> = {
  "opus-4": "linear-gradient(90deg, #7c3aed, #a855f7)",
  "sonnet-4": "linear-gradient(90deg, #6366f1, #818cf8)",
  "o3": "linear-gradient(90deg, #059669, #34d399)",
  "gpt-4.1": "linear-gradient(90deg, #0d9488, #2dd4bf)",
  "gemini-2.5": "linear-gradient(90deg, #d97706, #fbbf24)",
};

const FRAMEWORK_COLORS: Record<string, string> = {
  "Claude Code": "linear-gradient(90deg, #7c3aed, #a855f7)",
  Cursor: "linear-gradient(90deg, #0891b2, #22d3ee)",
  Codex: "linear-gradient(90deg, #059669, #34d399)",
  Aider: "linear-gradient(90deg, #d97706, #fbbf24)",
};

const FALLBACK_GRADIENTS = [
  "linear-gradient(90deg, #7c3aed, #a855f7)",
  "linear-gradient(90deg, #6366f1, #818cf8)",
  "linear-gradient(90deg, #059669, #34d399)",
  "linear-gradient(90deg, #0d9488, #2dd4bf)",
  "linear-gradient(90deg, #d97706, #fbbf24)",
];

function formatWholeCost(cost: number): string {
  return `$${Math.round(cost).toLocaleString("en-US")}`;
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    const digits = Number.isInteger(millions) ? 0 : 1;
    return `${millions.toFixed(digits)}M`;
  }
  if (tokens >= 1_000) {
    const thousands = tokens / 1_000;
    const digits = Number.isInteger(thousands) ? 0 : 1;
    return `${thousands.toFixed(digits)}K`;
  }
  return tokens.toLocaleString("en-US");
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}%` : `${rounded.toFixed(1)}%`;
}

function formatAverageCostDelta(current: number, delta: number): string {
  const previous = current - delta;
  if (previous <= 0) {
    return `${delta >= 0 ? "+" : "-"}${Math.abs(Math.round(delta))}% vs last month`;
  }
  const percent = Math.round((delta / previous) * 100);
  return `${percent >= 0 ? "+" : "-"}${Math.abs(percent)}% vs last month`;
}

function formatDayLabel(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] ?? name;
}

function getBarColor(
  palette: Record<string, string>,
  name: string,
  index: number,
): string {
  return palette[name] ?? FALLBACK_GRADIENTS[index % FALLBACK_GRADIENTS.length];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CostUsage() {
  const [timeRange, setTimeRange] = useState("30 days");

  const period = TIME_RANGE_MAP[timeRange];
  const days = DAYS_MAP[timeRange];

  // Usage summary
  const summaryQuery = useQuery({
    queryKey: ["usageSummary", period],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        USAGE_SUMMARY_QUERY,
        { period },
        "UsageSummary",
        signal,
      );
      return extractField<UsageSummary>(raw, "usageSummary");
    },
  });

  // Spend by provider
  // W4: refetchOnWindowFocus: false on heavier queries
  const providerQuery = useQuery({
    queryKey: ["spendByProvider", period],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        SPEND_BY_PROVIDER_QUERY,
        { period },
        "SpendByProvider",
        signal,
      );
      return extractField<SpendByCategory[]>(raw, "spendByProvider");
    },
    refetchOnWindowFocus: false,
  });

  // Spend by model
  // W4: refetchOnWindowFocus: false
  const modelQuery = useQuery({
    queryKey: ["spendByModel", period],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        SPEND_BY_MODEL_QUERY,
        { period },
        "SpendByModel",
        signal,
      );
      return extractField<SpendByCategory[]>(raw, "spendByModel");
    },
    refetchOnWindowFocus: false,
  });

  // Spend by framework
  // W4: refetchOnWindowFocus: false
  const frameworkQuery = useQuery({
    queryKey: ["spendByFramework", period],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        SPEND_BY_FRAMEWORK_QUERY,
        { period },
        "SpendByFramework",
        signal,
      );
      return extractField<SpendByCategory[]>(raw, "spendByFramework");
    },
    refetchOnWindowFocus: false,
  });

  // Daily spend
  const dailyQuery = useQuery({
    queryKey: ["dailySpend", days],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        DAILY_SPEND_QUERY,
        { days },
        "DailySpend",
        signal,
      );
      return extractField<SpendByCategory[]>(raw, "dailySpend");
    },
  });

  // W7: costProjections takes no arguments per schema -- always returns
  // 3-month forecast from 30-day baseline regardless of selected period.
  // W4: refetchOnWindowFocus: false
  const projectionsQuery = useQuery({
    queryKey: ["costProjections"],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        COST_PROJECTIONS_QUERY,
        undefined,
        "CostProjections",
        signal,
      );
      return extractField<CostProjection[]>(raw, "costProjections");
    },
    refetchOnWindowFocus: false,
  });

  // ---------------------------------------------------------------------------
  // W2: Determine loading / error independently per section
  // We still show an overall loading state if ALL queries are loading,
  // but render each section as soon as its own query resolves.
  // ---------------------------------------------------------------------------

  const allLoading =
    summaryQuery.isLoading &&
    providerQuery.isLoading &&
    modelQuery.isLoading &&
    frameworkQuery.isLoading &&
    dailyQuery.isLoading &&
    projectionsQuery.isLoading;

  const anyError =
    summaryQuery.isError ||
    providerQuery.isError ||
    modelQuery.isError ||
    frameworkQuery.isError ||
    dailyQuery.isError ||
    projectionsQuery.isError;

  const errorMessage =
    summaryQuery.error?.message ||
    providerQuery.error?.message ||
    modelQuery.error?.message ||
    frameworkQuery.error?.message ||
    dailyQuery.error?.message ||
    projectionsQuery.error?.message ||
    "Failed to load cost data";

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    // N4: aria-live for loading/error transitions
    <div aria-live="polite">
      <div className="header">
        <h2>Cost & Usage Intelligence</h2>
        <div className="header-meta">
          <FilterBar
            filters={TIME_RANGES}
            active={timeRange}
            onFilterChange={setTimeRange}
            compact
          />
        </div>
      </div>

      {allLoading ? (
        <LoadingState message="Loading cost & usage data..." />
      ) : anyError ? (
        <ErrorState message={errorMessage} />
      ) : (
        <CostUsageContent
          dailyWindowDays={days}
          summary={summaryQuery.data}
          summaryLoading={summaryQuery.isLoading}
          providers={providerQuery.data ?? []}
          providersLoading={providerQuery.isLoading}
          models={modelQuery.data ?? []}
          modelsLoading={modelQuery.isLoading}
          frameworks={frameworkQuery.data ?? []}
          frameworksLoading={frameworkQuery.isLoading}
          dailySpend={dailyQuery.data ?? []}
          dailyLoading={dailyQuery.isLoading}
          projections={projectionsQuery.data ?? []}
          projectionsLoading={projectionsQuery.isLoading}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Content sub-component (avoids re-declaring hooks on early return)
// N5: Wrapped with React.memo
// ---------------------------------------------------------------------------

interface CostUsageContentProps {
  dailyWindowDays: number;
  summary: UsageSummary | undefined;
  summaryLoading: boolean;
  providers: SpendByCategory[];
  providersLoading: boolean;
  models: SpendByCategory[];
  modelsLoading: boolean;
  frameworks: SpendByCategory[];
  frameworksLoading: boolean;
  dailySpend: SpendByCategory[];
  dailyLoading: boolean;
  projections: CostProjection[];
  projectionsLoading: boolean;
}

const CostUsageContent = React.memo(function CostUsageContent({
  dailyWindowDays,
  summary,
  summaryLoading,
  providers,
  providersLoading,
  models,
  modelsLoading,
  frameworks,
  frameworksLoading,
  dailySpend,
  dailyLoading,
  projections,
  projectionsLoading,
}: CostUsageContentProps) {
  const dailyChartMax = Math.max(...dailySpend.map((item) => item.costUsd), 0);
  const dailyTitleDays = dailySpend.length > 0 ? dailySpend.length : dailyWindowDays;

  return (
    <>
      {/* W2: Metric cards render as soon as summaryQuery loads */}
      {summaryLoading ? (
        <LoadingState message="Loading summary..." />
      ) : summary ? (
        <div className="cards">
          <MetricCard
            label="Total Spend (MTD)"
            value={formatWholeCost(summary.totalCostUsd)}
            delta={{
              value: `${formatWholeCost(summary.projectedMonthlyCostUsd)} projected EOM`,
              direction: "up",
              showArrow: false,
            }}
          />
          <MetricCard
            label="Total Tokens (MTD)"
            value={formatCompactTokens(summary.totalTokens)}
            subtitle={`${formatCompactTokens(summary.cacheReadTokens)} cache-read (${formatPercent(summary.cacheReadPercentage)})`}
          />
          <MetricCard
            label="Avg Cost / Session"
            value={formatCost(summary.averageCostPerSession)}
            delta={
              summary.averageCostDelta !== 0
                ? {
                    value: formatAverageCostDelta(
                      summary.averageCostPerSession,
                      summary.averageCostDelta,
                    ),
                    direction: summary.averageCostDelta > 0 ? "up" : "down",
                    showArrow: false,
                  }
                : undefined
            }
          />
          <MetricCard
            label="Cache Hit Rate"
            value={formatPercent(summary.cacheHitRate)}
            subtitle={`saving ~${formatWholeCost(summary.cacheSavingsUsd)}/month`}
          />
          <MetricCard
            label="Cost / Developer / Day"
            value={formatCost(summary.costPerDeveloperPerDay)}
            subtitle={`across ${summary.developerCount} developers`}
          />
        </div>
      ) : null}

      <TwoColumnLayout
        left={
          <ChartBox title="Spend by Provider">
            {providersLoading ? (
              <LoadingState message="Loading provider spend..." />
            ) : providers.length > 0 ? (
              <div className={styles.barSection}>
                {providers.map((provider, index) => (
                  <CostBar
                    key={provider.name}
                    label={provider.name}
                    value={provider.percentage}
                    valueLabel={formatPercent(provider.percentage)}
                    amount={formatWholeCost(provider.costUsd)}
                    color={getBarColor(PROVIDER_COLORS, provider.name, index)}
                  />
                ))}
              </div>
            ) : (
              <p className="text-dim">No provider spend data available</p>
            )}
          </ChartBox>
        }
        right={
          <ChartBox title="Spend by Model">
            {modelsLoading ? (
              <LoadingState message="Loading model spend..." />
            ) : models.length > 0 ? (
              <div className={styles.barSection}>
                {models.map((model, index) => (
                  <CostBar
                    key={model.name}
                    label={model.name}
                    value={model.percentage}
                    valueLabel={formatPercent(model.percentage)}
                    amount={formatWholeCost(model.costUsd)}
                    color={getBarColor(MODEL_COLORS, model.name, index)}
                  />
                ))}
              </div>
            ) : (
              <p className="text-dim">No model spend data available</p>
            )}
          </ChartBox>
        }
      />

      <TwoColumnLayout
        left={
          <ChartBox title={`Daily Spend (last ${dailyTitleDays} days)`}>
            {dailyLoading ? (
              <LoadingState message="Loading daily spend..." />
            ) : dailySpend.length > 0 ? (
              <div className={`bar-chart ${styles.dailyChart}`}>
                {dailySpend.map((day, index) => {
                  const height =
                    dailyChartMax > 0
                      ? Math.max((day.costUsd / dailyChartMax) * 100, 10)
                      : 2;
                  const barClass =
                    index >= dailySpend.length - 2
                      ? styles.dailyBarCurrent
                      : styles.dailyBarAccent;

                  return (
                    <div key={`${day.name}-${index}`} className="bar-group">
                      <div className="bar-val">{formatWholeCost(day.costUsd)}</div>
                      <div
                        className={`bar ${barClass}`}
                        style={{ height: `${height}%` }}
                      />
                      <div className="bar-label">{formatDayLabel(day.name)}</div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-dim">No daily spend data available</p>
            )}
          </ChartBox>
        }
        right={
          <ChartBox title="Spend by Agent Framework">
            {frameworksLoading ? (
              <LoadingState message="Loading framework spend..." />
            ) : frameworks.length > 0 ? (
              <div className={styles.barSection}>
                {frameworks.map((framework, index) => (
                  <CostBar
                    key={framework.name}
                    label={framework.name}
                    value={framework.percentage}
                    valueLabel={formatPercent(framework.percentage)}
                    amount={formatWholeCost(framework.costUsd)}
                    color={getBarColor(FRAMEWORK_COLORS, framework.name, index)}
                  />
                ))}
              </div>
            ) : (
              <p className="text-dim">No framework spend data available</p>
            )}
          </ChartBox>
        }
      />

      <ChartBox title="Projected Monthly Costs (next 3 months)">
        {projectionsLoading ? (
          <LoadingState message="Loading projections..." />
        ) : projections.length > 0 ? (
          <table aria-label="Cost projections" className={styles.projectionsTable}>
            <thead>
              <tr>
                <th>Month</th>
                <th>Sessions</th>
                <th>Tokens</th>
                <th>Projected Cost</th>
                <th>vs Current</th>
                <th>Assumptions</th>
              </tr>
            </thead>
            <tbody>
              {projections.map((proj) => (
                <tr key={proj.month}>
                  <td className={styles.projectionMonth}>{proj.month}</td>
                  <td className="mono">{proj.projectedSessions.toLocaleString("en-US")}</td>
                  <td className="mono">{formatCompactTokens(proj.projectedTokens)}</td>
                  <td className={styles.projectionCost}>{formatWholeCost(proj.projectedCostUsd)}</td>
                  <td
                    className={
                      proj.deltaVsCurrent >= 0
                        ? styles.projectionDeltaUp
                        : styles.projectionDeltaDown
                    }
                  >
                    {proj.deltaVsCurrent > 0 ? "+" : ""}
                    {Math.round(proj.deltaVsCurrent)}%
                  </td>
                  <td className={styles.assumptionsCell}>{proj.assumptions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-dim">No projection data available</p>
        )}
      </ChartBox>
    </>
  );
});
