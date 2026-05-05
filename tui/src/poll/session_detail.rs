//! SessionDetail polling iteration — testable with a fake fetcher.
//!
//! The function takes a fetcher closure rather than a hard-coded HttpClient
//! call so unit tests can supply a hand-crafted `ResponseData` (or an error)
//! and verify the marshal → LensUpdate path without any network or runtime
//! glue.

use crate::app::lens_update::LensUpdate;
use crate::error::AppError;
use crate::gql::marshal::marshal_session_detail;
use crate::gql::queries::session_detail;

pub async fn poll_session_detail_once<F, Fut>(id: String, fetcher: F) -> Option<LensUpdate>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<session_detail::ResponseData, AppError>>,
{
    match fetcher(id).await {
        Ok(resp) => marshal_session_detail(resp).map(LensUpdate::SessionDetail),
        // Caller decides retry policy. Returning None lets the polling loop
        // hold the previous lens contents on screen rather than blanking it.
        Err(_) => None,
    }
}
