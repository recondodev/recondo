//! Pure marshalling functions: graphql_client response → lens row types.
//!
//! These functions are intentionally lossy and forgiving: missing optional
//! fields fall back to empty strings (`unwrap_or_default`), oversized integer
//! counts saturate to `i32::MAX`. The TUI is a display surface; capture-side
//! data integrity belongs in the gateway, not here.

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
