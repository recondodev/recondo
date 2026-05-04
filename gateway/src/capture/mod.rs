use std::fs;
use std::path::Path;

use anyhow::Result;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::schema::CaptureRecord;
use crate::store;

pub mod attachments;
pub mod recovery;

/// Record a full capture: store request and response objects, then write metadata.
///
/// This is the main entry point for the capture pipeline.
pub fn record_capture(
    data_dir: &Path,
    request_bytes: &[u8],
    response_bytes: &[u8],
    provider: &str,
) -> Result<()> {
    // Store request and response objects (gzipped, content-addressable)
    let request_hash = store::store_request(data_dir, request_bytes)?;
    let response_hash = store::store_response(data_dir, response_bytes)?;

    // Build metadata record
    let id = Uuid::new_v4();
    let now = OffsetDateTime::now_utc();
    let timestamp = now.format(&Rfc3339)?;

    let req_bytes_ref = format!("objects/req/{}.json.gz", request_hash);
    let resp_bytes_ref = format!("objects/resp/{}.json.gz", response_hash);

    let record = CaptureRecord {
        timestamp,
        uuid: id.to_string(),
        provider: provider.to_string(),
        request_hash,
        response_hash,
        req_bytes_ref,
        resp_bytes_ref,
        request_size: request_bytes.len() as u64,
        response_size: response_bytes.len() as u64,
    };

    // Write metadata file
    let captures_dir = data_dir.join("captures");
    fs::create_dir_all(&captures_dir)?;

    // Filesystem-safe timestamp for filename (no colons or '+')
    // Metadata JSON uses standard RFC 3339; filename uses compact format.
    let (year, month, day) = now.to_calendar_date();
    let safe_ts = format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}.{:06}Z",
        year,
        month as u8,
        day,
        now.hour(),
        now.minute(),
        now.second(),
        now.microsecond()
    );
    let filename = format!("{}_{}.json", safe_ts, id);
    let metadata_path = captures_dir.join(filename);

    // Atomic write: write to temp file then rename, so a crash mid-write
    // never leaves a partial metadata file in captures/.
    let json = serde_json::to_string_pretty(&record)?;
    let tmp_path = captures_dir.join(format!(".tmp_{}", id));
    fs::write(&tmp_path, &json)?;
    fs::rename(&tmp_path, &metadata_path)?;

    Ok(())
}
