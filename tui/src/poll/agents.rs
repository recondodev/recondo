//! Agents polling iterations — testable with fake fetchers.
//!
//! Four queries feed the Agents lens:
//!   - `poll_agent_summary_once` — top-row metric cards.
//!   - `poll_agent_framework_distribution_once` — bar-chart slices.
//!   - `poll_top_developers_once` — bottom-left table.
//!   - `poll_top_repositories_once` — bottom-right table.
//!
//! Each fn takes an `AgentsQueryVars` and a fetcher closure returning the
//! corresponding codegen `ResponseData`. The functions are intentionally
//! tiny so unit tests can pass a hand-crafted response and verify the
//! marshal -> LensUpdate path without a runtime or HTTP client.

use crate::app::lens_update::LensUpdate;
use crate::app::state::AgentsQueryVars;
use crate::error::AppError;
use crate::gql::marshal::{
    marshal_agent_framework_distribution, marshal_agent_summary, marshal_top_developers,
    marshal_top_repositories,
};
use crate::gql::queries::{
    agent_framework_distribution, agent_summary, top_developers, top_repositories,
};

pub async fn poll_agent_summary_once<F, Fut>(
    vars: AgentsQueryVars,
    fetcher: F,
) -> Option<LensUpdate>
where
    F: FnOnce(AgentsQueryVars) -> Fut,
    Fut: std::future::Future<Output = Result<agent_summary::ResponseData, AppError>>,
{
    match fetcher(vars).await {
        Ok(resp) => Some(LensUpdate::AgentsSummary(marshal_agent_summary(resp))),
        Err(_) => None,
    }
}

pub async fn poll_agent_framework_distribution_once<F, Fut>(
    vars: AgentsQueryVars,
    fetcher: F,
) -> Option<LensUpdate>
where
    F: FnOnce(AgentsQueryVars) -> Fut,
    Fut: std::future::Future<Output = Result<agent_framework_distribution::ResponseData, AppError>>,
{
    match fetcher(vars).await {
        Ok(resp) => Some(LensUpdate::AgentsFrameworkDist(
            marshal_agent_framework_distribution(resp),
        )),
        Err(_) => None,
    }
}

pub async fn poll_top_developers_once<F, Fut>(
    vars: AgentsQueryVars,
    fetcher: F,
) -> Option<LensUpdate>
where
    F: FnOnce(AgentsQueryVars) -> Fut,
    Fut: std::future::Future<Output = Result<top_developers::ResponseData, AppError>>,
{
    match fetcher(vars).await {
        Ok(resp) => Some(LensUpdate::AgentsTopDevs(marshal_top_developers(resp))),
        Err(_) => None,
    }
}

pub async fn poll_top_repositories_once<F, Fut>(
    vars: AgentsQueryVars,
    fetcher: F,
) -> Option<LensUpdate>
where
    F: FnOnce(AgentsQueryVars) -> Fut,
    Fut: std::future::Future<Output = Result<top_repositories::ResponseData, AppError>>,
{
    match fetcher(vars).await {
        Ok(resp) => Some(LensUpdate::AgentsTopRepos(marshal_top_repositories(resp))),
        Err(_) => None,
    }
}
