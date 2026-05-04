use serde::{Deserialize, Serialize};

/// Metadata record for a single captured request/response pair.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureRecord {
    pub timestamp: String,
    pub uuid: String,
    pub provider: String,
    pub request_hash: String,
    pub response_hash: String,
    pub req_bytes_ref: String,
    pub resp_bytes_ref: String,
    pub request_size: u64,
    pub response_size: u64,
}
