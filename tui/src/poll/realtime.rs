//! Realtime polling iterations — testable with fake fetchers.
//!
//! Three independent polling tasks feed the Realtime lens. Each one writes a
//! distinct slice of the snapshot via a partial-update LensUpdate variant so
//! a refresh on one cadence (5s stats, 5s feed, 15s status) never clobbers
//! data owned by the other two:
//!   - `poll_realtime_stats_once` → `LensUpdate::RealtimeStats { .. }`
//!   - `poll_realtime_feed_once`  → `LensUpdate::RealtimeFeed(rows)`
//!   - `poll_gateway_status_once` → `LensUpdate::GatewayStatus { healthy }`

use crate::app::lens_update::LensUpdate;
use crate::error::AppError;
use crate::gql::marshal::{marshal_gateway_status, marshal_realtime_feed, marshal_realtime_stats};
use crate::gql::queries::{gateway_status, realtime_feed, realtime_stats};

pub async fn poll_realtime_stats_once<F, Fut>(fetcher: F) -> Option<LensUpdate>
where
    F: FnOnce(()) -> Fut,
    Fut: std::future::Future<Output = Result<realtime_stats::ResponseData, AppError>>,
{
    match fetcher(()).await {
        Ok(resp) => Some(marshal_realtime_stats(resp)),
        Err(_) => None,
    }
}

pub async fn poll_realtime_feed_once<F, Fut>(fetcher: F) -> Option<LensUpdate>
where
    F: FnOnce(()) -> Fut,
    Fut: std::future::Future<Output = Result<realtime_feed::ResponseData, AppError>>,
{
    match fetcher(()).await {
        Ok(resp) => Some(LensUpdate::RealtimeFeed(marshal_realtime_feed(resp))),
        Err(_) => None,
    }
}

pub async fn poll_gateway_status_once<F, Fut>(fetcher: F) -> Option<LensUpdate>
where
    F: FnOnce(()) -> Fut,
    Fut: std::future::Future<Output = Result<gateway_status::ResponseData, AppError>>,
{
    match fetcher(()).await {
        Ok(resp) => {
            let healthy = marshal_gateway_status(resp);
            Some(LensUpdate::GatewayStatus { healthy })
        }
        Err(_) => None,
    }
}
