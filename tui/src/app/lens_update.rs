//! Update messages from polling tasks to the main loop.

use crate::lenses::agents::{AgentSummaryStats, FrameworkSlice, TopRow};
use crate::lenses::audit::AuditRow;
use crate::lenses::cost::BreakdownRow;
use crate::lenses::realtime::FeedRow;
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
    AgentsSummary(AgentSummaryStats),
    AgentsFrameworkDist(Vec<FrameworkSlice>),
    AgentsTopDevs(Vec<TopRow>),
    AgentsTopRepos(Vec<TopRow>),
    AuditTrail {
        rows: Vec<AuditRow>,
        total: i32,
    },
    /// Realtime stats partial-update. The three realtime updates are split
    /// (stats / feed / status) so each polling task only writes the slice of
    /// the snapshot it owns — a feed refresh never clobbers cards, and a
    /// stats refresh never clobbers feed rows.
    RealtimeStats {
        active_providers: i32,
        active_sessions: i32,
        user_turns_per_min: i64,
        tokens_last_hour: f64,
        cost_last_hour: f64,
        p50_ms: Option<i32>,
        p99_ms: Option<i32>,
        sample_count: i32,
    },
    RealtimeFeed(Vec<FeedRow>),
    GatewayStatus {
        healthy: bool,
    },
}
