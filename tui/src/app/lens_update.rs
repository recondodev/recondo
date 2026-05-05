//! Update messages from polling tasks to the main loop.

use crate::lenses::cost::BreakdownRow;
use crate::lenses::session_detail::SessionDetailLens;
use crate::lenses::sessions::SessionRow;
use crate::lenses::turn_detail::TurnDetailLens;

#[derive(Debug)]
pub enum LensUpdate {
    Sessions(Vec<SessionRow>),
    SessionDetail(SessionDetailLens),
    TurnDetail(TurnDetailLens),
    CostBreakdown(Vec<BreakdownRow>),
    /// (total_cost_usd, average_cost_delta) — schema declares both as
    /// non-nullable `Float!`, but the lens still models delta as Option to
    /// preserve the existing draw path that hides the chip when no delta
    /// signal is available. The polling task always passes Some(delta).
    CostTotal(f64, Option<f64>),
    CostDaily(Vec<f64>),
    // (Future chunks add: Agents, Realtime, GatewayStatus)
}
