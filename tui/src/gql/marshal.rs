//! Pure marshalling functions: graphql_client response → lens row types,
//! and TUI-shaped query vars → graphql_client `Variables` input.
//!
//! These functions are intentionally lossy and forgiving: missing optional
//! fields fall back to empty strings (`unwrap_or_default`), oversized integer
//! counts saturate to `i32::MAX`. The TUI is a display surface; capture-side
//! data integrity belongs in the gateway, not here.

use crate::app::state::SessionsQueryVars;
use crate::app::time_window::{days_for_window, TimeWindow};
use crate::gql::queries::{session_detail, sessions, turn};
use crate::lenses::session_detail::{SessionDetailLens, TurnRow};
use crate::lenses::sessions::SessionRow;
use crate::lenses::turn_detail::TurnDetailLens;

pub fn marshal_sessions(resp: sessions::ResponseData) -> Vec<SessionRow> {
    resp.sessions
        .items
        .into_iter()
        .map(|item| SessionRow {
            id: item.id,
            started_at: format_started_at(&item.started_at),
            model: item.model.unwrap_or_default(),
            framework: item.framework.unwrap_or_default(),
            turns: i32::try_from(item.total_turns).unwrap_or(i32::MAX),
            cost: item.total_cost_usd,
        })
        .collect()
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
