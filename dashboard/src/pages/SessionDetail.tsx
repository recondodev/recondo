import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useParams, Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ExpandableRow } from "../components/ExpandableRow";
import { TagPill } from "../components/TagPill";
import { Pagination } from "../components/Pagination";
import { SearchInput } from "../components/SearchInput";
import { FilterBar } from "../components/FilterBar";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { graphqlRequest, extractField } from "../graphql/client";
import { formatTokens, formatCost, formatLatency, truncateId } from "../utils/formatters";
import { AttachmentStrip } from "../components/AttachmentStrip";
import type { SessionData, TurnData, UserTurnData } from "../types/graphql";
import styles from "./SessionDetail.module.css";
import {
  ALL_SESSION_FILTERS,
  buildSessionSearchParams,
  normalizeSessionFilter,
} from "./sessionsShared";

// ---------------------------------------------------------------------------
// GraphQL query
// ---------------------------------------------------------------------------

const SESSION_DETAIL_QUERY = `
  query SessionDetail($id: ID!) {
    session(id: $id) {
      id
      projectId
      agentId
      model
      provider
      startedAt
      endedAt
      lastActiveAt
      initialIntent
      systemPromptHash
      totalTurns
      turnsCaptured
      droppedEvents
      totalTokens
      totalCostUsd
      complete
      framework
      status
      duration
      accountUuid
      deviceId
      gitRepo
      gitBranch
      cacheReadTokens
      cacheCreationTokens
      title
      userTurns {
        id
        groupIdx
        startTimestamp
        endTimestamp
        durationMs
        userRequestText
        primaryModel
        provider
        framework
        totalTokens
        inputTokens
        outputTokens
        cacheReadTokens
        cacheCreationTokens
        costUsd
        subCallCount
        toolCallCount
        status
        turns {
          id
          sessionId
          sequenceNum
          timestamp
          turnType
          inputTokens
          outputTokens
          thinkingTokens
          totalTokens
          costUsd
          latencyMs
          captureComplete
          contentHashReq
          contentHashResp
          stopReason
          model
          provider
          toolCallCount
          userRequestText
          responseText
          thinkingText
          cacheReadTokens
          cacheCreationTokens
          httpStatus
          transport
          ttfbMs
          durationMs
          requestHash
          responseHash
          attachmentCount
          attachments {
            id
            turnId
            sessionId
            sequenceNum
            role
            kind
            mimeType
            sizeBytes
            sha256
            filename
            width
            height
            url
          }
        }
      }
      turns {
        id
        sessionId
        sequenceNum
        timestamp
        turnType
        inputTokens
        outputTokens
        thinkingTokens
        totalTokens
        costUsd
        latencyMs
        captureComplete
        contentHashReq
        contentHashResp
        stopReason
        model
        provider
        toolCallCount
        userRequestText
        responseText
        thinkingText
        cacheReadTokens
        cacheCreationTokens
        httpStatus
        transport
        ttfbMs
        durationMs
        requestHash
        responseHash
        attachmentCount
        attachments {
          id
          turnId
          sessionId
          sequenceNum
          role
          kind
          mimeType
          sizeBytes
          sha256
          filename
          width
          height
          url
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TURNS_PER_PAGE = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMetaTimestamp(ts: string | null): string {
  if (!ts) return "--";
  return ts;
}

function formatTurnTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return ts;
  }
}

function getTurnStatusLabel(turn: TurnData): string {
  if (turn.httpStatus !== null) {
    return String(turn.httpStatus);
  }
  // Post-parser-fix shape: Claude Code's quota probe at session start.
  // max_tokens=1 → server returns 1 output token, stop_reason=max_tokens.
  // The call captures cleanly now, so we identify it by content shape rather
  // than by the parser-failure side-effects we used to look for.
  if (turn.stopReason === "max_tokens" && (turn.outputTokens ?? 0) <= 1) {
    return "preflight";
  }
  // Legacy: pre-parser-fix preflights from old sessions never produced parsed
  // metadata — keep the old heuristic so historical rows still render correctly.
  if (!turn.captureComplete && turn.totalTokens === 0) {
    return "preflight";
  }
  return turn.captureComplete ? "complete" : "incomplete";
}

/// Detect whether an entire user-turn is a preflight (i.e. an agent-internal
/// probe with no real user message behind it). Heuristic: a single wire call
/// that produced ≤1 output token and stopped on max_tokens. Specific enough
/// that real user messages won't trip it unless someone deliberately sends
/// `max_tokens: 1`, which never happens in practice.
function isUserTurnPreflight(userTurn: UserTurnData): boolean {
  if (userTurn.subCallCount !== 1) return false;
  if ((userTurn.outputTokens ?? 0) > 1) return false;
  return userTurn.turns[0]?.stopReason === "max_tokens";
}

function truncateTurnPreview(text: string | null, maxLength = 28): string {
  if (!text) return "--";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function getTurnRequestText(turn: TurnData, session: SessionData): string {
  const directRequest = turn.userRequestText?.trim();
  if (directRequest) return directRequest;

  const sessionFallback = turn.sequenceNum === 1 ? session.initialIntent?.trim() : "";
  if (sessionFallback) return sessionFallback;

  if (turn.transport === "websocket") {
    return "[request not captured]";
  }

  return "--";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [turnPage, setTurnPage] = useState(1);
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(new Set());
  const listSearch = searchParams.get("search") ?? "";
  const activeFilter = normalizeSessionFilter(searchParams.get("filter"));
  const sessionsSearch = searchParams.toString();

  // B4: pass signal from TanStack Query context to graphqlRequest
  const sessionQuery = useQuery({
    queryKey: ["session", id],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        SESSION_DETAIL_QUERY,
        { id },
        "SessionDetail",
        signal,
      );
      return extractField<SessionData | null>(raw, "session");
    },
    enabled: !!id,
    // Poll every 2s while the session is still being captured so new turns
    // appear without a manual refresh. Stop once the gateway marks it complete.
    refetchInterval: (query) =>
      query.state.data?.complete ? false : 2000,
  });

  // ---------------------------------------------------------------------------
  // Turn expansion handlers
  // ---------------------------------------------------------------------------

  const toggleTurn = useCallback(
    (turnId: string) => {
      setExpandedTurns((prev) => {
        const next = new Set(prev);
        if (next.has(turnId)) {
          next.delete(turnId);
        } else {
          next.add(turnId);
        }
        return next;
      });
    },
    [],
  );

  const turns = sessionQuery.data?.turns ?? [];
  // Primary list is grouped: one row per user prompt, with wire turns nested.
  // When the API is an older version that doesn't return userTurns yet, fall
  // back to synthesizing one UserTurn per wire turn so the page still renders.
  const userTurns: UserTurnData[] = useMemo(() => {
    const raw = sessionQuery.data?.userTurns;
    if (raw && raw.length > 0) return raw;
    return turns.map((t) => ({
      id: `fallback:${t.id}`,
      sessionId: t.sessionId,
      groupIdx: t.sequenceNum,
      startTimestamp: t.timestamp,
      endTimestamp: t.timestamp,
      durationMs: t.durationMs ?? 0,
      userRequestText: t.userRequestText ?? null,
      primaryModel: t.model ?? null,
      provider: t.provider ?? "unknown",
      framework: sessionQuery.data?.framework ?? null,
      totalTokens: t.totalTokens,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheCreationTokens: t.cacheCreationTokens,
      costUsd: t.costUsd,
      subCallCount: 1,
      toolCallCount: t.toolCallCount,
      status: getTurnStatusLabel(t),
      turns: [t],
    }));
  }, [sessionQuery.data, turns]);

  // Deep-link from Realtime feed: /sessions/:id?turn=<userTurnId> auto-expands
  // and scrolls to the target user turn on load. Refs keyed by userTurn.id.
  // Note: this only matches synthetic ids of the form `${sessionId}:${groupIdx}`
  // emitted by the userTurns resolver. The fallback path on older API versions
  // synthesizes ids prefixed with `fallback:` (see useMemo below); deep-linking
  // a session served by such an API silently no-ops, which is acceptable
  // because the feed's userTurnId only points at the modern shape.
  const turnRowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const deepLinkPrepared = useRef<string | null>(null);
  const deepLinkScrolled = useRef<string | null>(null);
  const targetTurnId = searchParams.get("turn");
  const targetTurnPage = useMemo(() => {
    if (!targetTurnId) return null;
    const idx = userTurns.findIndex((u) => u.id === targetTurnId);
    return idx >= 0 ? Math.floor(idx / TURNS_PER_PAGE) + 1 : null;
  }, [targetTurnId, userTurns]);

  // Phase 1: stage the expansion + page jump as soon as the userTurns load
  // includes the target. Done in a single effect so React batches the state
  // updates into one render.
  useEffect(() => {
    if (!targetTurnId || targetTurnPage === null) return;
    if (deepLinkPrepared.current === targetTurnId) return;
    setExpandedTurns((prev) => {
      if (prev.has(targetTurnId)) return prev;
      const next = new Set(prev);
      next.add(targetTurnId);
      return next;
    });
    setTurnPage(targetTurnPage);
    deepLinkPrepared.current = targetTurnId;
  }, [targetTurnId, targetTurnPage]);

  // Phase 2: scroll only after the right page has rendered and the row's ref
  // is attached. Splitting this from Phase 1 fixes a race where
  // requestAnimationFrame ran before React applied the setTurnPage update,
  // leaving the target row outside the page slice (so scrollIntoView no-op'd
  // for any turn not on page 1).
  useEffect(() => {
    if (!targetTurnId || targetTurnPage === null) return;
    if (turnPage !== targetTurnPage) return;
    if (deepLinkScrolled.current === targetTurnId) return;
    const el = turnRowRefs.current.get(targetTurnId);
    if (!el) return;
    deepLinkScrolled.current = targetTurnId;
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [targetTurnId, targetTurnPage, turnPage, userTurns]);

  // W7: allExpanded derived from state instead of separate useState.
  // Now tracks expansion of logical user turns.
  const allExpanded = useMemo(
    () => userTurns.length > 0 && userTurns.every((u) => expandedTurns.has(u.id)),
    [userTurns, expandedTurns],
  );

  const toggleAll = useCallback(() => {
    if (allExpanded) {
      setExpandedTurns(new Set());
    } else {
      setExpandedTurns(new Set(userTurns.map((u) => u.id)));
    }
  }, [allExpanded, userTurns]);

  const handleSessionsFilterChange = useCallback(
    (filter: string) => {
      const nextParams = buildSessionSearchParams({
        filter,
        search: listSearch,
      });
      const nextSearch = nextParams.toString();
      navigate({
        pathname: "/sessions",
        search: nextSearch ? `?${nextSearch}` : "",
      });
    },
    [listSearch, navigate],
  );

  const handleSessionsSearchChange = useCallback(
    (value: string) => {
      const nextParams = buildSessionSearchParams({
        filter: activeFilter,
        search: value,
      });
      const nextSearch = nextParams.toString();
      navigate({
        pathname: "/sessions",
        search: nextSearch ? `?${nextSearch}` : "",
      });
    },
    [activeFilter, navigate],
  );

  // ---------------------------------------------------------------------------
  // Loading / Error states
  // ---------------------------------------------------------------------------

  // N10: handle missing id param
  if (!id) {
    return <ErrorState message="No session ID provided" />;
  }

  if (sessionQuery.isLoading) {
    return <LoadingState message="Loading session details..." />;
  }

  if (sessionQuery.isError) {
    return (
      <ErrorState
        message={
          sessionQuery.error?.message ?? "Failed to load session details"
        }
      />
    );
  }

  const session = sessionQuery.data;

  if (!session || !session.id) {
    return (
      <ErrorState message="Session not found" />
    );
  }

  // ---------------------------------------------------------------------------
  // Turn pagination
  // ---------------------------------------------------------------------------

  const totalTurnPages = Math.ceil(userTurns.length / TURNS_PER_PAGE);
  const paginatedUserTurns = userTurns.slice(
    (turnPage - 1) * TURNS_PER_PAGE,
    turnPage * TURNS_PER_PAGE,
  );

  const sessionsListTarget = {
    pathname: "/sessions",
    search: sessionsSearch ? `?${sessionsSearch}` : "",
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className={styles.page}>
      <div className="header">
        <h2>Sessions</h2>
        <div className="header-meta">
          <SearchInput
            key={`session-detail-search-${listSearch}`}
            value={listSearch}
            onChange={handleSessionsSearchChange}
            placeholder="Search sessions by intent, model, or agent..."
          />
        </div>
      </div>

      <FilterBar
        filters={ALL_SESSION_FILTERS}
        active={activeFilter}
        onFilterChange={handleSessionsFilterChange}
      />

      <Link
        to={sessionsListTarget}
        aria-label="Back to Sessions"
        className="back-link"
      >
        &larr; Back to Sessions
      </Link>

      <div className={`header ${styles.pageHeader}`}>
        <h2 className={styles.sessionTitle}>
          {session.title ?? `Session ${truncateId(session.id)}`}
        </h2>
        <div className={`header-meta ${styles.headerActions}`}>
          <TagPill variant="status" label={session.status} />
          <button
            className={`btn ${styles.exportButton}`}
            disabled
            title="Export will be available in a future release"
          >
            Export Session
          </button>
        </div>
      </div>

      <div className="session-meta-grid">
        <div className="meta-item">
          <div className="label">Session ID</div>
          <div className="value sm mono">{session.id}</div>
        </div>
        <div className="meta-item">
          <div className="label">Framework</div>
          <div className="value">
            {session.framework ? (
              <TagPill variant="framework" label={session.framework} />
            ) : (
              "--"
            )}
          </div>
        </div>
        <div className="meta-item">
          <div className="label">Provider</div>
          <div className="value">
            <TagPill variant="provider" label={session.provider} />
          </div>
        </div>
        <div className="meta-item">
          <div className="label">Model</div>
          <div className="value">{session.model ?? "--"}</div>
        </div>
        <div className="meta-item">
          <div className="label">Started</div>
          <div className="value sm">{formatMetaTimestamp(session.startedAt)}</div>
        </div>
        <div className="meta-item">
          <div className="label">Last Active</div>
          <div className="value sm">{formatMetaTimestamp(session.lastActiveAt)}</div>
        </div>
        <div className="meta-item">
          <div className="label">Total Turns</div>
          <div className="value">{session.totalTurns}</div>
        </div>
        <div className="meta-item">
          <div className="label">Total Tokens</div>
          <div className="value">{formatTokens(session.totalTokens)}</div>
        </div>
        <div className="meta-item">
          <div className="label">Total Cost</div>
          <div className="value">{formatCost(session.totalCostUsd)}</div>
        </div>
        <div className="meta-item">
          <div className="label">Cache Read</div>
          <div className="value">
            {formatTokens(session.cacheReadTokens)}{" "}
            <span className={styles.valueMuted}>tokens</span>
          </div>
        </div>
        <div className="meta-item">
          <div className="label">Account UUID</div>
          <div className="value sm mono">{session.accountUuid ?? "--"}</div>
        </div>
        <div className="meta-item">
          <div className="label">Device ID</div>
          <div className="value sm mono">{session.deviceId ?? "--"}</div>
        </div>
        <div className="meta-item">
          <div className="label">System Prompt Hash</div>
          <div className="value sm mono">{session.systemPromptHash}</div>
        </div>
        <div className="meta-item">
          <div className="label">Transport</div>
          <div className="value sm">{turns[0]?.transport ?? "--"}</div>
        </div>
      </div>

      <div className={styles.turnToolbar}>
        <button className={styles.turnToggle} onClick={toggleAll}>
          {allExpanded ? "Collapse All" : "Expand All"}
        </button>
      </div>

      <div className={styles.turnColumns}>
        <span>#</span>
        <span>Timestamp</span>
        <span>Model</span>
        <span>User Request</span>
        <span>Tokens</span>
        <span>Cost</span>
        <span>Latency</span>
        <span>Status</span>
      </div>

      {paginatedUserTurns.map((userTurn, index) => {
        const isExpanded = expandedTurns.has(userTurn.id);
        const preflight = isUserTurnPreflight(userTurn);
        // Fall back to wire-turn text if the group's aggregated field is empty
        // (e.g. backends that haven't populated user_request_text on a haiku
        // title-gen yet).
        const requestText =
          userTurn.userRequestText?.trim() ||
          getTurnRequestText(userTurn.turns[0] ?? turns[0], session);
        const perTurnLatency = userTurn.turns.length > 0
          ? userTurn.turns.reduce((sum, t) => sum + (t.latencyMs ?? 0), 0) / userTurn.turns.length
          : null;
        const subCalls = userTurn.turns;
        const loopBadge = (() => {
          if (userTurn.toolCallCount > 0) {
            return `${userTurn.toolCallCount} tool call${userTurn.toolCallCount === 1 ? "" : "s"}`;
          }
          if (userTurn.subCallCount > 1) {
            return `${userTurn.subCallCount} calls`;
          }
          return null;
        })();

        const userTurnHeader = (
          <>
            <span className={`${styles.turnCell} ${styles.sequenceCell}`}>
              <span className={styles.sequenceMarker}>#</span>
              <span className={`mono ${styles.monoCell}`}>{userTurn.groupIdx}</span>
            </span>
            <span className={`${styles.turnCell} ${styles.timeCell} mono ${styles.monoCell}`}>
              {formatTurnTimestamp(userTurn.startTimestamp)}
            </span>
            <span className={`${styles.turnCell} ${styles.modelCell}`}>
              {userTurn.primaryModel ?? session.model ?? "--"}
            </span>
            <span className={`${styles.turnCell} ${styles.requestCell}`}>
              {preflight ? (
                <span
                  className={styles.preflightLabel}
                  title="Agent-internal probe (max_tokens=1). Not a user message."
                >
                  preflight probe
                </span>
              ) : (
                truncateTurnPreview(requestText)
              )}
              {loopBadge ? (
                <span className="feed-subcall-badge" title="Sub-calls collapsed into this user turn (title-gen / classifier / tool-loop)">
                  {loopBadge}
                </span>
              ) : null}
            </span>
            <span className={`${styles.turnCell} ${styles.tokensCell} mono ${styles.monoCell}`}>
              {formatTokens(userTurn.totalTokens)}
            </span>
            <span className={`${styles.turnCell} ${styles.costCell}`}>
              {formatCost(userTurn.costUsd)}
            </span>
            <span className={`${styles.turnCell} ${styles.latencyCell} mono ${styles.monoCell}`}>
              {formatLatency(perTurnLatency)}
            </span>
            <span className={`${styles.turnCell} ${styles.statusCell}`}>
              <TagPill variant="status" label={preflight ? "preflight" : userTurn.status} />
            </span>
          </>
        );

        const renderSubCallDetail = (turn: TurnData) => (
          <>
            <div className={styles.turnSection}>
              <div className={styles.turnSectionTitle}>Response (truncated)</div>
              <div className={styles.turnText}>{turn.responseText ?? "--"}</div>
            </div>
            {turn.thinkingText && (
              <div className={styles.turnSection}>
                <div className={styles.turnSectionTitle}>Thinking</div>
                <div className={styles.turnText}>{turn.thinkingText}</div>
              </div>
            )}
            <div className={styles.detailGrid}>
              <div className={styles.detailMetric}>
                <div className={styles.detailLabel}>Input</div>
                <div className={styles.detailValue}>{formatTokens(turn.inputTokens)}</div>
              </div>
              <div className={styles.detailMetric}>
                <div className={styles.detailLabel}>Output</div>
                <div className={styles.detailValue}>{formatTokens(turn.outputTokens)}</div>
              </div>
              <div className={styles.detailMetric}>
                <div className={styles.detailLabel}>Cache Read</div>
                <div className={styles.detailValue}>{formatTokens(turn.cacheReadTokens)}</div>
              </div>
              <div className={styles.detailMetric}>
                <div className={styles.detailLabel}>Cache Create</div>
                <div className={styles.detailValue}>{formatTokens(turn.cacheCreationTokens)}</div>
              </div>
            </div>
            <div className={styles.hashGrid}>
              <div className={styles.detailMetric}>
                <div className={styles.detailLabel}>Request Hash</div>
                <div className={`${styles.detailValue} mono`}>
                  {turn.requestHash ?? turn.contentHashReq ?? "--"}
                </div>
              </div>
              <div className={styles.detailMetric}>
                <div className={styles.detailLabel}>Response Hash</div>
                <div className={`${styles.detailValue} mono`}>
                  {turn.responseHash ?? turn.contentHashResp ?? "--"}
                </div>
              </div>
            </div>
            <div className={styles.detailGrid}>
              <div className={styles.detailMetric}>
                <div className={styles.detailLabel}>TTFB</div>
                <div className={styles.detailValue}>
                  {turn.ttfbMs !== null ? `${turn.ttfbMs}ms` : "--"}
                </div>
              </div>
              <div className={styles.detailMetric}>
                <div className={styles.detailLabel}>Stop Reason</div>
                <div className={styles.detailValue}>{turn.stopReason ?? "--"}</div>
              </div>
              <div className={styles.detailMetric}>
                <div className={styles.detailLabel}>Transport</div>
                <div className={styles.detailValue}>{turn.transport ?? "--"}</div>
              </div>
              <div className={styles.detailMetric}>
                <div className={styles.detailLabel}>Capture</div>
                <div
                  className={`${styles.detailValue} ${
                    turn.captureComplete
                      ? styles.captureComplete
                      : !turn.captureComplete && turn.totalTokens === 0
                        ? styles.capturePreflight
                        : styles.captureIncomplete
                  }`}
                >
                  {getTurnStatusLabel(turn)}
                </div>
              </div>
            </div>
          </>
        );

        const singleSubCall = subCalls.length === 1;

        const requestAttachments = (() => {
          const seen = new Set<string>();
          const out: NonNullable<TurnData["attachments"]> = [];
          for (const sc of subCalls) {
            for (const att of sc.attachments ?? []) {
              if (seen.has(att.id)) continue;
              seen.add(att.id);
              out.push(att);
            }
          }
          return out;
        })();

        const userTurnContent = (
          <>
            <div className={styles.turnSection}>
              <div className={styles.turnSectionTitle}>User Request</div>
              <div className={styles.turnText}>{requestText}</div>
              {requestAttachments.length > 0 && (
                <div className={styles.turnSectionAttachments}>
                  <div className={styles.turnSectionSubtitle}>
                    Attachments ({requestAttachments.length})
                  </div>
                  <AttachmentStrip attachments={requestAttachments} />
                </div>
              )}
            </div>
            <div className={styles.turnSection}>
              <div className={styles.turnSectionTitle}>
                {singleSubCall
                  ? "Wire turn"
                  : `Wire sub-calls (${subCalls.length}) — click a row to expand`}
              </div>
              {/* Single-turn groups render inline (no pointless extra click).
                  Multi-call groups collapse each wire call into a one-line
                  summary; the full card opens on demand so a 32-iteration
                  tool loop doesn't render as a wall of repeated cards. */}
              {singleSubCall ? (
                <div className={styles.turnSection}>{renderSubCallDetail(subCalls[0])}</div>
              ) : (
                subCalls.map((turn, subIdx) => {
                  const timeLabel = formatTurnTimestamp(turn.timestamp);
                  const summary =
                    turn.stopReason ?? turn.responseText?.trim().slice(0, 80) ?? "--";
                  return (
                    <ExpandableRow
                      key={turn.id}
                      className={styles.subCallRow}
                      triggerClassName={styles.subCallTrigger}
                      contentClassName={styles.subCallContent}
                      triggerAs="div"
                      header={
                        <>
                          <span className={styles.subCallIndex}>
                            #{subIdx + 1} · {timeLabel}
                          </span>
                          <span className={styles.subCallModel}>
                            {turn.model ?? "--"}
                          </span>
                          <span className={styles.subCallSummary}>{summary}</span>
                          <span className={styles.subCallMetric}>
                            {formatTokens(turn.totalTokens)} tok
                          </span>
                          <span className={styles.subCallCost}>
                            {formatCost(turn.costUsd)}
                          </span>
                          <span className={styles.subCallMetric}>
                            {turn.ttfbMs !== null ? `${turn.ttfbMs}ms` : "--"}
                          </span>
                          <span>
                            <TagPill variant="status" label={getTurnStatusLabel(turn)} />
                          </span>
                        </>
                      }
                    >
                      {renderSubCallDetail(turn)}
                    </ExpandableRow>
                  );
                })
              )}
            </div>
          </>
        );

        return (
          <div
            key={userTurn.id}
            id={`user-turn-${encodeURIComponent(userTurn.id)}`}
            ref={(el) => {
              turnRowRefs.current.set(userTurn.id, el);
            }}
          >
            <ExpandableRow
              expanded={isExpanded}
              onToggle={() => toggleTurn(userTurn.id)}
              header={userTurnHeader}
              className={styles.turnRow}
              triggerClassName={styles.turnTrigger}
              contentClassName={styles.turnContent}
              triggerAs={index === 0 ? "button" : "div"}
            >
              {userTurnContent}
            </ExpandableRow>
          </div>
        );
      })}

      {totalTurnPages > 1 && (
        <div className={styles.paginationWrap}>
          <Pagination
            currentPage={turnPage}
            totalPages={totalTurnPages}
            onPageChange={setTurnPage}
          />
        </div>
      )}
    </div>
  );
}
