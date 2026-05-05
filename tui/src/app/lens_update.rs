//! Update messages from polling tasks to the main loop.

use crate::lenses::session_detail::SessionDetailLens;
use crate::lenses::sessions::SessionRow;
use crate::lenses::turn_detail::TurnDetailLens;

#[derive(Debug)]
pub enum LensUpdate {
    Sessions(Vec<SessionRow>),
    SessionDetail(SessionDetailLens),
    TurnDetail(TurnDetailLens),
    // (Future chunks add: Cost, Agents, Realtime, GatewayStatus)
}
