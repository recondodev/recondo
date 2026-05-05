//! Sessions polling iteration — testable with a fake fetcher.
//!
//! The function takes a fetcher closure rather than a hard-coded HttpClient
//! call so unit tests can supply a hand-crafted `ResponseData` (or an error)
//! and verify the marshal → LensUpdate path without any network or runtime
//! glue.

use crate::app::lens_update::LensUpdate;
use crate::app::state::SessionsQueryVars;
use crate::error::AppError;
use crate::gql::marshal::marshal_sessions;
use crate::gql::queries::sessions;

pub async fn poll_sessions_once<F, Fut>(vars: SessionsQueryVars, fetcher: F) -> Option<LensUpdate>
where
    F: FnOnce(SessionsQueryVars) -> Fut,
    Fut: std::future::Future<Output = Result<sessions::ResponseData, AppError>>,
{
    match fetcher(vars).await {
        Ok(resp) => Some(LensUpdate::Sessions(marshal_sessions(resp))),
        // Caller decides retry policy. Returning None lets the polling loop
        // hold the previous lens contents on screen rather than blanking it.
        Err(_) => None,
    }
}
