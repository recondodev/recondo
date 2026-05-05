//! Cost polling iterations — testable with fake fetchers.
//!
//! Three queries feed the Cost lens:
//!   - `poll_cost_breakdown_once` — provider-keyed breakdown rows.
//!     Sibling fns (`*_model_once`, `*_framework_once`) cover the other
//!     GroupBy variants. The runtime branches on `vars.group` and calls the
//!     appropriate sibling because each query module produces a distinct
//!     `ResponseData` Rust type, so a single generic-over-response function
//!     would not compile across all three branches.
//!   - `poll_cost_total_once` — `usageSummary` total + average-cost delta.
//!   - `poll_cost_daily_once` — `dailySpend` series for the sparkline.

use crate::app::lens_update::LensUpdate;
use crate::app::state::{CostBreakdownQueryVars, CostDailyQueryVars, CostTotalQueryVars};
use crate::error::AppError;
use crate::gql::marshal::{
    marshal_daily_spend, marshal_spend_by_framework, marshal_spend_by_model,
    marshal_spend_by_provider, marshal_usage_summary,
};
use crate::gql::queries::{
    daily_spend, spend_by_framework, spend_by_model, spend_by_provider, usage_summary,
};

pub async fn poll_cost_breakdown_once<F, Fut>(
    vars: CostBreakdownQueryVars,
    fetcher: F,
) -> Option<LensUpdate>
where
    F: FnOnce(CostBreakdownQueryVars) -> Fut,
    Fut: std::future::Future<Output = Result<spend_by_provider::ResponseData, AppError>>,
{
    match fetcher(vars).await {
        Ok(resp) => Some(LensUpdate::CostBreakdown(marshal_spend_by_provider(resp))),
        Err(_) => None,
    }
}

pub async fn poll_cost_breakdown_model_once<F, Fut>(
    vars: CostBreakdownQueryVars,
    fetcher: F,
) -> Option<LensUpdate>
where
    F: FnOnce(CostBreakdownQueryVars) -> Fut,
    Fut: std::future::Future<Output = Result<spend_by_model::ResponseData, AppError>>,
{
    match fetcher(vars).await {
        Ok(resp) => Some(LensUpdate::CostBreakdown(marshal_spend_by_model(resp))),
        Err(_) => None,
    }
}

pub async fn poll_cost_breakdown_framework_once<F, Fut>(
    vars: CostBreakdownQueryVars,
    fetcher: F,
) -> Option<LensUpdate>
where
    F: FnOnce(CostBreakdownQueryVars) -> Fut,
    Fut: std::future::Future<Output = Result<spend_by_framework::ResponseData, AppError>>,
{
    match fetcher(vars).await {
        Ok(resp) => Some(LensUpdate::CostBreakdown(marshal_spend_by_framework(resp))),
        Err(_) => None,
    }
}

pub async fn poll_cost_total_once<F, Fut>(
    vars: CostTotalQueryVars,
    fetcher: F,
) -> Option<LensUpdate>
where
    F: FnOnce(CostTotalQueryVars) -> Fut,
    Fut: std::future::Future<Output = Result<usage_summary::ResponseData, AppError>>,
{
    match fetcher(vars).await {
        Ok(resp) => {
            let (total, delta) = marshal_usage_summary(resp);
            Some(LensUpdate::CostTotal(total, delta))
        }
        Err(_) => None,
    }
}

pub async fn poll_cost_daily_once<F, Fut>(
    vars: CostDailyQueryVars,
    fetcher: F,
) -> Option<LensUpdate>
where
    F: FnOnce(CostDailyQueryVars) -> Fut,
    Fut: std::future::Future<Output = Result<daily_spend::ResponseData, AppError>>,
{
    match fetcher(vars).await {
        Ok(resp) => Some(LensUpdate::CostDaily(marshal_daily_spend(resp))),
        Err(_) => None,
    }
}
