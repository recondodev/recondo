//! TurnDetail polling iteration — testable with a fake fetcher.
//!
//! Mirrors `poll_session_detail_once`: the fetcher closure is parametrised so
//! unit tests can supply a hand-crafted `ResponseData` (or an error) and
//! verify the marshal → LensUpdate path without any network or runtime glue.

use crate::app::lens_update::LensUpdate;
use crate::error::AppError;
use crate::gql::marshal::marshal_turn_detail;
use crate::gql::queries::turn;

pub async fn poll_turn_detail_once<F, Fut>(id: String, fetcher: F) -> Option<LensUpdate>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<turn::ResponseData, AppError>>,
{
    match fetcher(id).await {
        Ok(resp) => marshal_turn_detail(resp).map(LensUpdate::TurnDetail),
        Err(_) => None,
    }
}
