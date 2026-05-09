//! Pure marshalling functions: graphql_client response → lens row types,
//! and TUI-shaped query vars → graphql_client `Variables` input.
//!
//! These functions are intentionally lossy and forgiving: missing optional
//! fields fall back to empty strings (`unwrap_or_default`), oversized integer
//! counts saturate to `i32::MAX`. The TUI is a display surface; capture-side
//! data integrity belongs in the gateway, not here.

use crate::app::lens_update::LensUpdate;
use crate::app::state::SessionsQueryVars;
use crate::app::time_window::{days_for_window, TimeWindow};
use crate::gql::queries::{
    agent_framework_distribution, agent_summary, audit_trail, daily_spend, gateway_status,
    realtime_feed, realtime_stats, session_detail, sessions, spend_by_framework, spend_by_model,
    spend_by_provider, top_developers, top_repositories, turn, usage_summary,
};
use crate::lenses::agents::{AgentSummaryStats, FrameworkSlice, TopRow};
use crate::lenses::audit::AuditRow;
use crate::lenses::cost::BreakdownRow;
use crate::lenses::realtime::FeedRow;
use crate::lenses::session_detail::{SessionDetailLens, TurnRow};
use crate::lenses::sessions::SessionRow;
use crate::lenses::turn_detail::TurnDetailLens;

pub fn marshal_sessions(resp: sessions::ResponseData) -> Vec<SessionRow> {
    resp.sessions
        .items
        .into_iter()
        .map(|item| SessionRow {
            id: item.id,
            provider: item.provider,
            project: item.project_id,
            started_at: format_started_at(&item.started_at),
            model: item.model.unwrap_or_default(),
            framework: item.framework.unwrap_or_default(),
            turns: i32::try_from(item.total_turns).unwrap_or(i32::MAX),
            cost: item.total_cost_usd,
        })
        .collect()
}

pub fn marshal_audit_trail(resp: audit_trail::ResponseData) -> (Vec<AuditRow>, i32) {
    let total = i32::try_from(resp.audit_trail.total).unwrap_or(i32::MAX);
    let rows = resp
        .audit_trail
        .items
        .into_iter()
        .map(|item| AuditRow {
            time: format_feed_time(&item.timestamp),
            session_id: item.session_id,
            sequence_num: i32::try_from(item.sequence_num).unwrap_or(i32::MAX),
            provider: item.provider,
            model: item.model,
            request_hash: item.request_hash,
            response_hash: item.response_hash,
            tokens: i32::try_from(item.total_tokens).unwrap_or(i32::MAX),
            integrity: format!("{:?}", item.integrity_status).to_lowercase(),
            http_status: item.http_status.map(|v| i32::try_from(v).unwrap_or(0)),
            capture_complete: item.capture_complete,
        })
        .collect();
    (rows, total)
}

fn format_started_at(t: &chrono::DateTime<chrono::Utc>) -> String {
    t.format("%H:%M").to_string()
}

/// Translate a `TimeWindow` into a `started_after` lower-bound timestamp for
/// the `SessionFilter` GraphQL input. `TimeWindow::All` returns `None`
/// (no lower bound) so the API returns the full history. All other windows
/// derive their offset from `days_for_window`.
pub fn window_to_started_after(w: TimeWindow) -> Option<chrono::DateTime<chrono::Utc>> {
    match w {
        TimeWindow::All => None,
        _ => Some(chrono::Utc::now() - chrono::Duration::days(days_for_window(w) as i64)),
    }
}

/// Marshal a `SessionDetail` GraphQL response into a `SessionDetailLens`.
/// Returns `None` when the API reports no session for the requested id.
pub fn marshal_session_detail(resp: session_detail::ResponseData) -> Option<SessionDetailLens> {
    let session = resp.session?;
    let turns: Vec<TurnRow> = session
        .turns
        .into_iter()
        .map(|t| TurnRow {
            id: t.id,
            sequence: t.sequence_num,
            model: t.model.unwrap_or_default(),
            prompt_tokens: t.input_tokens,
            completion_tokens: t.output_tokens,
            cost: t.cost_usd,
            tool_calls: i32::try_from(t.tool_call_count).unwrap_or(i32::MAX),
        })
        .collect();
    Some(SessionDetailLens::new(session.id, turns, None))
}

/// Marshal a `Turn` GraphQL response into a `TurnDetailLens`.
/// Returns `None` when the API reports no turn for the requested id.
pub fn marshal_turn_detail(resp: turn::ResponseData) -> Option<TurnDetailLens> {
    let t = resp.turn?;
    Some(TurnDetailLens {
        id: t.id,
        model: t.model.unwrap_or_default(),
        prompt: t.user_request_text.unwrap_or_default(),
        response: t.response_text.unwrap_or_default(),
        tool_calls: t
            .tool_calls
            .into_iter()
            .map(|tc| format!("- {}: {}", tc.name, tc.input.unwrap_or_default()))
            .collect(),
    })
}

/// Marshal a `SpendByProvider` GraphQL response into breakdown rows. Schema
/// field types: `name: String!`, `costUsd: Float!`, `count: Int!`. The Int
/// codegen type is `i64`; we saturate to `i32::MAX` to fit `BreakdownRow`'s
/// display-side `i32` session count without panicking on absurd values.
pub fn marshal_spend_by_provider(resp: spend_by_provider::ResponseData) -> Vec<BreakdownRow> {
    resp.spend_by_provider
        .into_iter()
        .map(|c| BreakdownRow {
            key: c.name.clone(),
            label: c.name,
            cost: c.cost_usd,
            sessions: i32::try_from(c.count).unwrap_or(i32::MAX),
        })
        .collect()
}

/// Marshal a `SpendByModel` GraphQL response into breakdown rows.
pub fn marshal_spend_by_model(resp: spend_by_model::ResponseData) -> Vec<BreakdownRow> {
    resp.spend_by_model
        .into_iter()
        .map(|c| BreakdownRow {
            key: c.name.clone(),
            label: c.name,
            cost: c.cost_usd,
            sessions: i32::try_from(c.count).unwrap_or(i32::MAX),
        })
        .collect()
}

/// Marshal a `SpendByFramework` GraphQL response into breakdown rows.
pub fn marshal_spend_by_framework(resp: spend_by_framework::ResponseData) -> Vec<BreakdownRow> {
    resp.spend_by_framework
        .into_iter()
        .map(|c| BreakdownRow {
            key: c.name.clone(),
            label: c.name,
            cost: c.cost_usd,
            sessions: i32::try_from(c.count).unwrap_or(i32::MAX),
        })
        .collect()
}

/// Marshal a `DailySpend` GraphQL response into the float-per-day vector
/// the sparkline expects. The schema reuses `SpendByCategory`; we project
/// to `cost_usd` only — the `name` (day label) is unused by the v1 widget.
pub fn marshal_daily_spend(resp: daily_spend::ResponseData) -> Vec<f64> {
    resp.daily_spend.into_iter().map(|c| c.cost_usd).collect()
}

/// Marshal a `UsageSummary` GraphQL response into `(total, delta)`. Schema
/// declares `averageCostDelta: Float!` (non-nullable), so we always wrap in
/// `Some` — the lens still models delta as Option to support the existing
/// "no chip" rendering path when polling has not run yet.
pub fn marshal_usage_summary(resp: usage_summary::ResponseData) -> (f64, Option<f64>) {
    let s = resp.usage_summary;
    (s.total_cost_usd, Some(s.average_cost_delta))
}

/// Marshal an `AgentSummary` GraphQL response into the lens stats shape. This
/// mirrors the dashboard Agent Analytics cards: active agents, sessions,
/// average turns per session, and unique developers.
pub fn marshal_agent_summary(resp: agent_summary::ResponseData) -> AgentSummaryStats {
    let s = resp.agent_summary;
    AgentSummaryStats {
        total_agents: i32::try_from(s.active_agents).unwrap_or(i32::MAX),
        total_sessions: i32::try_from(s.total_sessions).unwrap_or(i32::MAX),
        average_turns_per_session: s.average_turns_per_session,
        unique_developers: i32::try_from(s.unique_developers).unwrap_or(i32::MAX),
    }
}

/// Marshal an `AgentFrameworkDistribution` response into per-framework
/// cost slices. The schema reuses `SpendByCategory` (same shape as cost
/// breakdown), so we project `name` -> `label` and `costUsd` -> `cost`.
pub fn marshal_agent_framework_distribution(
    resp: agent_framework_distribution::ResponseData,
) -> Vec<FrameworkSlice> {
    resp.agent_framework_distribution
        .into_iter()
        .map(|c| FrameworkSlice {
            label: c.name,
            cost: c.cost_usd,
        })
        .collect()
}

/// Marshal a `TopDevelopers` response into the lens table row shape. The
/// schema uses `accountUuid` as the stable identifier; we display it as
/// the row label. When the uuid is empty we fall back to the favorite
/// model so the row still renders something readable.
pub fn marshal_top_developers(resp: top_developers::ResponseData) -> Vec<TopRow> {
    resp.top_developers
        .items
        .into_iter()
        .map(|d| {
            let label = if d.account_uuid.is_empty() {
                d.favorite_model.unwrap_or_default()
            } else {
                d.account_uuid
            };
            TopRow {
                label,
                sessions: i32::try_from(d.session_count).unwrap_or(i32::MAX),
                cost: d.total_cost_usd,
            }
        })
        .collect()
}

/// Marshal a `TopRepositories` response into the lens table row shape.
pub fn marshal_top_repositories(resp: top_repositories::ResponseData) -> Vec<TopRow> {
    resp.top_repositories
        .items
        .into_iter()
        .map(|r| TopRow {
            label: r.repository,
            sessions: i32::try_from(r.session_count).unwrap_or(i32::MAX),
            cost: r.total_cost_usd,
        })
        .collect()
}

/// Marshal a `RealtimeStats` GraphQL response into the partial-update lens
/// variant. Splitting the realtime updates into stats / feed / status means
/// each polling task only writes its own slice of the snapshot — see the
/// realtime-pipeline tests for the no-clobber invariant this enables.
pub fn marshal_realtime_stats(resp: realtime_stats::ResponseData) -> LensUpdate {
    let s = resp.realtime_stats;
    LensUpdate::RealtimeStats {
        active_providers: i32::try_from(s.active_provider_count).unwrap_or(i32::MAX),
        active_sessions: i32::try_from(s.active_sessions).unwrap_or(i32::MAX),
        user_turns_per_min: s.user_turns_per_minute,
        tokens_last_hour: s.tokens_last_hour,
        cost_last_hour: s.cost_last_hour,
        p50_ms: s
            .latency_p50_ms
            .map(|v| i32::try_from(v).unwrap_or(i32::MAX)),
        p99_ms: s
            .latency_p99_ms
            .map(|v| i32::try_from(v).unwrap_or(i32::MAX)),
        sample_count: i32::try_from(s.latency_sample_count).unwrap_or(i32::MAX),
    }
}

/// Marshal a `RealtimeFeed` GraphQL response into the lens row vector. The
/// schema's FeedItem fields map directly onto FeedRow; we display
/// `framework` in the `agent` column.
pub fn marshal_realtime_feed(resp: realtime_feed::ResponseData) -> Vec<FeedRow> {
    resp.realtime_feed
        .into_iter()
        .map(|item| FeedRow {
            time: format_feed_time(&item.timestamp),
            provider: item.provider,
            model: item.model.unwrap_or_default(),
            agent: item.framework.unwrap_or_default(),
            tokens: item.total_tokens,
            cost: item.cost_usd,
            status: item
                .http_status
                .map(|v| i32::try_from(v).unwrap_or(0))
                .unwrap_or(0),
            session_id: item.session_id,
            user_turn_id: item.user_turn_id,
        })
        .collect()
}

/// Marshal a `GatewayStatus` GraphQL response into a health flag. The
/// canonical status vocabulary is defined by the data layer in
/// `packages/recondo-data/src/realtime.ts`:
/// `"live"` (heartbeat within grace window) → healthy; `"offline"` and
/// `"unknown"` (and anything else) → not healthy.
pub fn marshal_gateway_status(resp: gateway_status::ResponseData) -> bool {
    let s = resp.gateway_status;
    s.status.eq_ignore_ascii_case("live")
}

fn format_feed_time(t: &chrono::DateTime<chrono::Utc>) -> String {
    t.format("%H:%M:%S").to_string()
}

/// Build the codegen `sessions::Variables` from the TUI-shaped
/// `SessionsQueryVars`. This is a pure transform: it lets the polling glue in
/// `runtime.rs` stay tiny and lets us unit-test the period → started_after
/// translation without spinning up an HTTP client or a runtime.
pub fn build_sessions_variables(vars: SessionsQueryVars) -> sessions::Variables {
    let started_after = window_to_started_after(vars.period);
    sessions::Variables {
        filter: Some(sessions::SessionFilter {
            provider: vars.filter.provider,
            model: vars.filter.model,
            project_id: vars.filter.project,
            started_after,
            started_before: None,
            status: None,
            framework: vars.filter.framework,
            search: None,
            hide_non_llm: None,
        }),
        limit: Some(vars.limit),
        offset: Some(vars.offset),
    }
}
