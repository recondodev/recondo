//! Update messages from polling tasks to the main loop.

use crate::lenses::sessions::SessionRow;

#[derive(Debug, Clone)]
pub enum LensUpdate {
    Sessions(Vec<SessionRow>),
    // (Future chunks add: SessionDetail, TurnDetail, Cost, Agents, Realtime, GatewayStatus)
}
