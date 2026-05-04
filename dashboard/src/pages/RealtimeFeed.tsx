import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { MetricCard } from "../components/MetricCard";
import { FilterBar } from "../components/FilterBar";
import { TagPill } from "../components/TagPill";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { EmptyState } from "../components/EmptyState";
import { graphqlRequest, extractField } from "../graphql/client";
import { formatTokens, formatCost, formatLatency } from "../utils/formatters";
import type { RealtimeStats, FeedItemData, GatewayStatusData } from "../types/graphql";

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const REALTIME_STATS_QUERY = `
  query RealtimeStats {
    realtimeStats {
      requestsPerMinute
      userTurnsPerMinute
      activeSessions
      activeProviderCount
      tokensLastHour
      cacheReadTokensLastHour
      costLastHour
      costProjectedToday
      latencyP50Ms
      latencyP99Ms
      latencySampleCount
      latencySource
    }
  }
`;

const REALTIME_FEED_QUERY = `
  query RealtimeFeed($provider: String, $limit: Int) {
    realtimeFeed(provider: $provider, limit: $limit) {
      timestamp
      provider
      model
      framework
      intent
      totalTokens
      costUsd
      httpStatus
      captureComplete
      sessionId
      subCallCount
      toolCallCount
      durationMs
      attachmentCount
      userTurnId
    }
  }
`;

const GATEWAY_STATUS_QUERY = `
  query GatewayStatus {
    gatewayStatus {
      status
      uptimeSeconds
      lastHeartbeat
    }
  }
`;

// ---------------------------------------------------------------------------
// Provider filter options
// ---------------------------------------------------------------------------

const PROVIDER_FILTERS = ["All", "Anthropic", "OpenAI", "Gemini"];

const FRAMEWORK_LABELS: Record<string, string> = {
  "claude-code": "claude-code",
  claude_code: "claude-code",
  cursor: "cursor",
  codex: "codex",
  codex_cli_rs: "codex",
  aider: "aider",
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  google: "Gemini",
};

function formatFrameworkLabel(framework: string | null | undefined): string {
  if (!framework) return "";
  return FRAMEWORK_LABELS[framework.toLowerCase()] ?? framework;
}

function formatProviderLabel(provider: string): string {
  return PROVIDER_LABELS[provider.toLowerCase()] ?? provider;
}

function formatCompactCount(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatLatencySubtitle(stats: RealtimeStats | undefined): string {
  if (!stats || stats.latencyP50Ms == null) {
    return "Awaiting live latency samples";
  }

  if (stats.latencySource === "turn_duration_ms") {
    if (stats.latencyP99Ms != null) {
      return `P99: ${formatLatency(stats.latencyP99Ms)} from ${stats.latencySampleCount} turn${stats.latencySampleCount === 1 ? "" : "s"}`;
    }
    return `${stats.latencySampleCount} turn sample${stats.latencySampleCount === 1 ? "" : "s"}`;
  }

  if (stats.latencySource === "gateway_capture_histogram") {
    const sampleLabel = `${stats.latencySampleCount} gateway capture${stats.latencySampleCount === 1 ? "" : "s"}`;
    if (stats.latencyP99Ms != null) {
      return `${sampleLabel} • P99: ${formatLatency(stats.latencyP99Ms)}`;
    }
    return sampleLabel;
  }

  return "Awaiting live latency samples";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// FeedItemRow -- wraps shared FeedItem data into a table row with Provider column.
// The shared FeedItem component supplies the canonical field mapping; we spread
// its props into table cells so providers are explicitly shown in each row.
// ---------------------------------------------------------------------------

function FeedItemRow({ item }: { item: FeedItemData }) {
  const timestamp = new Date(item.timestamp).toLocaleTimeString();
  const status = item.httpStatus != null
    ? String(item.httpStatus)
    : !item.captureComplete && item.totalTokens === 0
      ? "preflight"
      : item.captureComplete
        ? "complete"
        : "incomplete";
  const framework = formatFrameworkLabel(item.framework);
  const providerLabel = formatProviderLabel(item.provider);
  // Each row represents a logical user turn; the intent is the user's prompt
  // text. Rendered plain — the quote-wrapping that used to bracket this was
  // a vestige from when rows were per-HTTP-call.
  const intentLabel = item.intent ?? null;
  const subCallCount = item.subCallCount ?? 1;
  // toolCallCount reads more user-meaningfully than raw sub-call count in
  // most cases (the extra sub-calls are usually tool-use iterations). Prefer
  // the tool count when non-zero; fall back to sub-call count when the
  // loop consisted of title-gen / classifier preflight rather than tools.
  const loopBadge = (() => {
    if ((item.toolCallCount ?? 0) > 0) {
      return `${item.toolCallCount} tool ${item.toolCallCount === 1 ? "call" : "calls"}`;
    }
    if (subCallCount > 1) {
      return `${subCallCount} calls`;
    }
    return null;
  })();

  return (
    <Link
      to={`/sessions/${item.sessionId}?turn=${encodeURIComponent(item.userTurnId)}`}
      className="feed-item feed-item-link"
      data-provider={item.provider}
      aria-label={`Open ${item.intent ?? "user turn"} in session ${item.sessionId.slice(0, 6)}`}
    >
      <span className="feed-time feed-mono">{timestamp}</span>
      <span><TagPill variant="provider" label={providerLabel} /></span>
      <span className="feed-model feed-mono">{item.model ?? "--"}</span>
      <span className="feed-intent">
        {framework ? (
          <TagPill
            variant="framework"
            label={framework}
            className="feed-framework-pill"
          />
        ) : null}
        {intentLabel ? (
          <span className="feed-intent-text">{intentLabel}</span>
        ) : !framework ? (
          <span className="feed-intent-empty">--</span>
        ) : null}
        {(item.attachmentCount ?? 0) > 0 ? (
          <span
            className="feed-attach-badge"
            title={`${item.attachmentCount} attachment${item.attachmentCount === 1 ? "" : "s"} (image / PDF)`}
            aria-label={`${item.attachmentCount} attachments`}
          >
            📎 {item.attachmentCount}
          </span>
        ) : null}
        {loopBadge ? (
          <span className="feed-subcall-badge" title="Grouped sub-calls (title-gen / classifier / tool-loop)">
            {loopBadge}
          </span>
        ) : null}
      </span>
      <span className="feed-token feed-mono">{formatTokens(item.totalTokens)}</span>
      <span className="feed-cost feed-mono">{formatCost(item.costUsd)}</span>
      <span className="feed-status-cell"><TagPill variant="status" label={status} /></span>
    </Link>
  );
}

export default function RealtimeFeed() {
  const [providerFilter, setProviderFilter] = useState("All");

  // N3: stagger intervals -- stats 5s, feed 5s, status 15s
  // N6: staleTime 0 for realtime queries specifically
  const statsQuery = useQuery({
    queryKey: ["realtimeStats"],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        REALTIME_STATS_QUERY,
        undefined,
        "RealtimeStats",
        signal,
      );
      return extractField<RealtimeStats>(raw, "realtimeStats");
    },
    refetchInterval: 5000,
    staleTime: 0,
  });

  // Fetch feed items with provider filter and auto-refresh
  const feedQuery = useQuery({
    queryKey: ["realtimeFeed", providerFilter],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        REALTIME_FEED_QUERY,
        {
          provider: providerFilter === "All" ? undefined : providerFilter,
          limit: 50,
        },
        "RealtimeFeed",
        signal,
      );
      return extractField<FeedItemData[]>(raw, "realtimeFeed");
    },
    refetchInterval: 5000,
    staleTime: 0,
  });

  // N3: status changes rarely, use 15s interval
  const statusQuery = useQuery({
    queryKey: ["gatewayStatus"],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        GATEWAY_STATUS_QUERY,
        undefined,
        "GatewayStatus",
        signal,
      );
      return extractField<GatewayStatusData>(raw, "gatewayStatus");
    },
    refetchInterval: 15000,
    staleTime: 0,
  });

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const isLoading =
    statsQuery.isLoading || feedQuery.isLoading || statusQuery.isLoading;
  const isError =
    statsQuery.isError || feedQuery.isError || statusQuery.isError;
  const errorMessage =
    statsQuery.error?.message ||
    feedQuery.error?.message ||
    statusQuery.error?.message ||
    "Failed to load data";

  if (isLoading) {
    return <LoadingState message="Loading realtime data..." />;
  }

  if (isError) {
    return <ErrorState message={errorMessage} />;
  }

  const stats = statsQuery.data;
  const feedItems = feedQuery.data ?? [];
  const gatewayStatus = statusQuery.data;
  const latencySubtitle = formatLatencySubtitle(stats);
  const latencyLabel = stats?.latencySource === "gateway_capture_histogram"
    ? "P50 Capture"
    : "P50 Latency";

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="page-shell">
      <div className="header">
        <h2>Realtime Monitor</h2>
        <div className="header-meta">
          {gatewayStatus && (
            <TagPill
              variant="status"
              label={
                gatewayStatus.status === "live"
                  ? "Gateway Live"
                  : gatewayStatus.status === "offline"
                    ? "Offline"
                    : gatewayStatus.status
              }
            />
          )}
          {stats && (
            <span className="text-dim">
              :8443 | {stats.activeProviderCount} provider{stats.activeProviderCount !== 1 ? "s" : ""} | {stats.activeSessions} agent{stats.activeSessions !== 1 ? "s" : ""} connected
            </span>
          )}
        </div>
      </div>

      {stats && (
        <div className="cards">
          <MetricCard
            label="User Turns / Min"
            value={String(stats.userTurnsPerMinute ?? 0)}
            subtitle={
              stats.requestsPerMinute !== stats.userTurnsPerMinute
                ? `${stats.requestsPerMinute} wire calls`
                : undefined
            }
          />
          <MetricCard
            label="Active Sessions"
            value={String(stats.activeSessions)}
            subtitle={`across ${stats.activeProviderCount} providers`}
          />
          <MetricCard
            label="Tokens (Last Hour)"
            value={formatCompactCount(stats.tokensLastHour)}
            delta={{
              value: `${formatCompactCount(stats.cacheReadTokensLastHour)} cache-read`,
              direction: "down",
              showArrow: false,
            }}
          />
          <MetricCard
            label="Cost (Last Hour)"
            value={formatCost(stats.costLastHour)}
            delta={{
              value: `${formatCost(stats.costProjectedToday)} projected today`,
              direction: "up",
              showArrow: false,
            }}
          />
          <MetricCard
            label={latencyLabel}
            value={formatLatency(stats.latencyP50Ms)}
            subtitle={latencySubtitle}
          />
        </div>
      )}

      {feedItems.length === 0 ? (
        <EmptyState message="No traffic data available" />
      ) : (
        <div className="feed" aria-label="Live traffic feed">
          <div className="feed-header">
            <h3>Live Traffic</h3>
            <FilterBar
              filters={PROVIDER_FILTERS}
              active={providerFilter}
              onFilterChange={setProviderFilter}
              compact
            />
          </div>
          <div className="feed-cols">
            <span>Time</span>
            <span>Provider</span>
            <span>Model</span>
            <span>Agent / Intent</span>
            <span className="feed-col-right">Tokens</span>
            <span className="feed-col-right">Cost</span>
            <span className="feed-col-right">Status</span>
          </div>
          <div>
            {feedItems.map((item, index) => (
              <FeedItemRow
                key={`${item.sessionId}-${index}`}
                item={item}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
