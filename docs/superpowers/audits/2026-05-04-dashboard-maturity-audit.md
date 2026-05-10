# Dashboard Maturity Audit (2026-05-04)

Scope: each route is audited against `dashboard/src/pages/*.tsx`. For each, the
GraphQL operations, state-managed UI controls, and explicit loading/error/empty
state coverage are recorded so TUI v1 can scope each lens to ship, ship-with-
caveats, or downgrade to a v1.5 stub.

## /realtime — baseline (assumed verified)

Source: `dashboard/src/pages/RealtimeFeed.tsx`.

GraphQL operations:
- `RealtimeStats` — `realtimeStats { requestsPerMinute, userTurnsPerMinute, activeSessions, activeProviderCount, tokensLastHour, cacheReadTokensLastHour, costLastHour, costProjectedToday, latencyP50Ms, latencyP99Ms, latencySampleCount, latencySource }` (lines 18-35), polled at 5s with `staleTime: 0` (lines 220-233).
- `RealtimeFeed($provider, $limit)` — feed items keyed by `userTurnId`, returns provider/model/framework/intent/tokens/cost/httpStatus/captureComplete/sessionId/subCallCount/toolCallCount/durationMs/attachmentCount (lines 37-57). Polled at 5s with `limit: 50` (lines 236-252).
- `GatewayStatus` — `status, uptimeSeconds, lastHeartbeat` (lines 59-67), polled at 15s (lines 255-268).

State-managed UI controls:
- `providerFilter` (`useState`, line 216) — single-select among `["All", "Anthropic", "OpenAI", "Gemini"]` (line 73), wired through `FilterBar` (lines 377-382). Drives the feed query variable on line 242.
- Feed row click navigates to `/sessions/:id?turn=<userTurnId>` (deep-link, line 172).
- No sort, no pagination, no group-by, no modal — feed renders the most-recent 50 items in fetch order.

Loading / error / empty states:
- Loading: yes — combined `isLoading` across the three queries renders `<LoadingState>` (lines 274-286).
- Error: yes — combined `isError`, surfaces the first non-empty `error.message`, renders `<ErrorState>` (lines 276-290).
- Empty: yes — `feedItems.length === 0` renders `<EmptyState message="No traffic data available" />` (lines 371-372).

## /sessions

Sources: `dashboard/src/pages/Sessions.tsx` (list) and `SessionDetail.tsx` (detail).

GraphQL operations (list):
- `Sessions($filter: SessionFilter, $limit, $offset)` — returns `items { id, framework, model, totalTurns, totalTokens, totalCostUsd, duration, status, startedAt }` plus `total/limit/offset` (lines 26-45). Polled at 5s (line 209). Server-side pagination (`PAGE_SIZE = 20`, line 52) and server-side filtering (`filter.search`, `filter.status`, `filter.framework`, `filter.hideNonLlm`, lines 167-181).

GraphQL operations (detail):
- `SessionDetail($id: ID!)` — large query pulling session metadata plus `userTurns { ... turns { ... attachments { ... } } }` and a flat `turns { ... attachments { ... } }` fallback (lines 26-171). Conditional polling: `refetchInterval` returns `2000` while `data.complete === false` and `false` once complete (lines 280-282).

State-managed UI controls (list):
- `search` (`useState` + URL `?search=`) — text input wired through `<SearchInput>` (lines 153, 289-294). Drives query filter.
- `activeFilter` (`useState` + URL `?filter=`) — single-select via `<FilterBar>` over `ALL_SESSION_FILTERS` (lines 154, 306-310). Maps to status (`Active`, `Completed`) or framework filter through `SESSION_FRAMEWORK_MAP` (lines 172-177).
- `showNonLlm` (`useState` + URL `?showNonLlm=1`) — checkbox toggle (lines 155, 282-288); inverts the resolver default which hides non-LLM traffic.
- `currentPage` (`useState`) — server-paginated via `<Pagination>` (lines 156, 325-330). `totalPages = Math.ceil(total / PAGE_SIZE)`.
- Column sort: every column declares `sortable: true` and `getSortValue` (lines 77-141) — sorting is client-side over the current page only (no `orderBy` variable on the query).
- Row click navigates to `/sessions/:id` preserving search params (lines 216-225).

State-managed UI controls (detail):
- `turnPage` (`useState`, line 259) — client-side pagination over user turns, 10 per page (`TURNS_PER_PAGE = 10`, line 177).
- `expandedTurns` (`useState<Set<string>>`, line 260) — per-row expansion plus an "Expand All / Collapse All" toggle (lines 391-397, 593-597).
- Deep-link handling: `?turn=<userTurnId>` auto-expands the target user turn, jumps to its page, and scrolls into view via two coordinated `useEffect`s (lines 354-382).
- "Export Session" button is rendered but `disabled` with title "Export will be available in a future release" (lines 513-520) — explicit not-implemented.

Loading / error / empty states (list): all three present.
- Loading: `<LoadingState message="Loading sessions..." />` (lines 298-299).
- Error: `<ErrorState>` with `error.message` fallback (lines 300-303).
- Empty: `<EmptyState message="No sessions found" />` (line 313).

Loading / error / empty states (detail): loading/error present, no dedicated empty state for an empty turns list (the list just renders nothing if empty), but `Session not found` is a dedicated branch (lines 454-458).
- Loading: yes (lines 438-440).
- Error: yes — `error.message` fallback (lines 442-450); plus missing-id and not-found branches (lines 434-436, 454-458).
- Empty: partial — handled at session level, not at the turns level.

## /cost

Source: `dashboard/src/pages/CostUsage.tsx`.

GraphQL operations (six queries, all variants of period-scoped aggregations):
- `UsageSummary($period: Period)` — `totalCostUsd, projectedMonthlyCostUsd, totalTokens, cacheReadTokens, cacheReadPercentage, averageCostPerSession, averageCostDelta, cacheHitRate, cacheSavingsUsd, costPerDeveloperPerDay, developerCount` (lines 23-39).
- `SpendByProvider($period)` — `name, costUsd, percentage, count` (lines 41-50).
- `SpendByModel($period)` — same shape (lines 52-61).
- `SpendByFramework($period)` — same shape (lines 63-72).
- `DailySpend($days)` — same shape, used as a time-series (lines 74-83).
- `CostProjections` — no args, returns `month, projectedSessions, projectedTokens, projectedCostUsd, deltaVsCurrent, assumptions` (lines 85-96). Schema explicitly fixed at 3-month forecast regardless of period (comment line 278-279).

State-managed UI controls:
- `timeRange` (`useState`, line 197) — single-select among `["Today", "7 days", "30 days", "Quarter"]` (line 102), translated via `TIME_RANGE_MAP` to `Period` enum and via `DAYS_MAP` to a day count (lines 104-116). Wired through `<FilterBar compact>` (lines 336-341).
- That is the only user-facing state on this page. No drilldown, no per-chart filters, no modal, no sort, no pagination.
- Five out of six queries set `refetchOnWindowFocus: false` (lines 229, 245, 261, 292) — `summaryQuery` and `dailyQuery` keep the default; this is an explicit policy choice in the comments.

Loading / error / empty states:
- Loading: yes — top-level renders `<LoadingState message="Loading cost & usage data..." />` only when ALL queries are loading (lines 301-307, 345-346); per-section `<LoadingState>` covers individual queries that are still loading after first paint (e.g. lines 412-413, 462-463, 484-485, 509-510, 542-543, 565-566).
- Error: yes — first-non-empty error message via combined `anyError` (lines 309-324, 347-348). Note: a single failed query collapses the entire page to the error state — no per-section error fallback.
- Empty: yes — every chart guards its array (`providers.length > 0`, `models.length > 0`, `dailySpend.length > 0`, `frameworks.length > 0`, `projections.length > 0`) and renders an inline `<p className="text-dim">No ... data available</p>` (lines 477-479, 499-501, 535-537, 557-559, 601-603). Summary cards render only when `summary` is truthy (lines 414, 457).

## /agents

Source: `dashboard/src/pages/AgentAnalytics.tsx`.

GraphQL operations:
- `AgentSummary` — `activeAgents, totalSessions, sessionsDelta, averageTurnsPerSession, uniqueDevelopers` (lines 33-43).
- `AgentFrameworkDistribution` — `name, count, percentage, costUsd` (lines 45-54). Pie chart input.
- `TopDevelopers($limit, $offset)` — `items { accountUuid, sessionCount, totalTokens, totalCostUsd, favoriteModel } total/limit/offset` (lines 56-71). Hardcoded `limit: 10, offset: 0` — pagination plumbing exists in the query but is not wired (line 307).
- `TopRepositories($limit, $offset)` — `items { repository, sessionCount, branchCount, totalCostUsd, primaryFramework } total/limit/offset` (lines 73-88). Same — hardcoded `limit: 10, offset: 0` (line 337).

State-managed UI controls:
- `viewFilter` (`useState`, line 285) — single-select among `["All Agents", "By Developer", "By Repository"]` (line 94). Toggles section visibility via `showDevelopers` / `showRepositories` derived booleans (lines 400-401, 556, 572).
- Developer table columns: every column `sortable: true` + `getSortValue` (lines 198-236) — client-side sort only.
- Repository table columns: every column `sortable: true` + `getSortValue` (lines 242-278) — client-side sort only.
- Pie tooltip is interactive (`recharts` `<Tooltip content={<FrameworkTooltip />} />`, lines 500-504), but it is not state-driven from the page perspective.
- No pagination wired even though the connection types support it.

Loading / error / empty states:
- Loading: yes — `allLoading` renders `<LoadingState>` (lines 350-354, 421-422). Caveat: `allLoading` uses `||` not `&&`, so any single still-loading query collapses the entire page to a spinner (different policy from `/cost`).
- Error: yes — `anyError` collapses to `<ErrorState>` with first `error.message` (lines 356-367, 423-424).
- Empty: yes — dedicated `isEmptyState` branch when summary metrics are all zero shows a single "Active Agents: 0" card plus `<EmptyState>` (lines 379-383, 425-435). Per-section empties: framework distribution renders `"No framework distribution data"` (lines 549-551), developers render `"No developer data available"` (lines 559-561), repositories render `"No repository data available"` (lines 574-576).

## TUI lens decisions

- [green] /realtime ships unchanged: three polled GraphQL ops (RealtimeStats/RealtimeFeed/GatewayStatus), one provider FilterBar, full loading/error/empty coverage at lines 274-290 and 371-372 — TUI maps cleanly to a 5s-tick stats panel + scrolling feed table with one provider filter.
- [yellow] /sessions ships with caveats: the list query, server pagination, search, status/framework/showNonLlm filters, and full loading/error/empty (Sessions.tsx lines 298-313) all transfer; flag two missing controls — column sort is client-side over the current page only (Sessions.tsx 77-141) and SessionDetail's "Export Session" button is hardcoded `disabled` (SessionDetail.tsx 513-520) — so the TUI ships without server-side sort and without export.
- [yellow] /cost ships with caveats: six queries and the timeRange FilterBar all map cleanly with full per-section loading/empty states, but flag two limitations — `costProjections` ignores the selected period (always 3-month forecast off the 30-day baseline, line 278-279), and a single failed query collapses the whole page to one ErrorState (lines 309-324) with no per-section fallback. Document both in the lens.
- [yellow] /agents ships with caveats: AgentSummary, AgentFrameworkDistribution, TopDevelopers, TopRepositories, the View FilterBar, and full loading/error/empty handling all transfer; flag that pagination is queryable but unwired (`limit: 10, offset: 0` hardcoded at lines 307 and 337) and that table sort is client-side over the visible 10 rows only (lines 198-278). Surface this as "top 10 only" in the TUI.
