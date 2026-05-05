//! Pure marshalling functions: graphql_client response → lens row types,
//! and TUI-shaped query vars → graphql_client `Variables` input.
//!
//! These functions are intentionally lossy and forgiving: missing optional
//! fields fall back to empty strings (`unwrap_or_default`), oversized integer
//! counts saturate to `i32::MAX`. The TUI is a display surface; capture-side
//! data integrity belongs in the gateway, not here.

use crate::app::state::SessionsQueryVars;
use crate::app::time_window::{days_for_window, TimeWindow};
use crate::gql::queries::sessions;
use crate::lenses::sessions::SessionRow;

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
