//! Audit Trail polling iteration, matching the dashboard auditTrail query.

use crate::app::lens_update::LensUpdate;
use crate::app::state::AuditQueryVars;
use crate::error::AppError;
use crate::gql::marshal::marshal_audit_trail;
use crate::gql::queries::audit_trail;

pub async fn poll_audit_trail_once<F, Fut>(vars: AuditQueryVars, fetcher: F) -> Option<LensUpdate>
where
    F: FnOnce(AuditQueryVars) -> Fut,
    Fut: std::future::Future<Output = Result<audit_trail::ResponseData, AppError>>,
{
    match fetcher(vars).await {
        Ok(resp) => {
            let (rows, total) = marshal_audit_trail(resp);
            Some(LensUpdate::AuditTrail { rows, total })
        }
        Err(_) => None,
    }
}
