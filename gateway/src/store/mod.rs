use std::fs;
use std::io::Write;
use std::path::Path;

use anyhow::Result;
use flate2::write::GzEncoder;
use flate2::Compression;

use crate::hash;

/// Store request bytes as a gzip-compressed, content-addressable object.
///
/// Writes to `{data_dir}/objects/req/{sha256_hex}.json.gz`.
/// Returns the SHA-256 hex hash of the content.
pub fn store_request(data_dir: &Path, content: &[u8]) -> Result<String> {
    store_object(data_dir, "req", content)
}

/// Store response bytes as a gzip-compressed, content-addressable object.
///
/// Writes to `{data_dir}/objects/resp/{sha256_hex}.json.gz`.
/// Returns the SHA-256 hex hash of the content.
pub fn store_response(data_dir: &Path, content: &[u8]) -> Result<String> {
    store_object(data_dir, "resp", content)
}

/// Compress content with gzip and store at the content-addressable path.
/// Uses atomic temp-file-then-rename to prevent corrupt files on crash.
///
/// This is the canonical object storage implementation. Both the legacy
/// `store_request`/`store_response` functions and `LocalObjectStore::put`
/// should delegate to this function to ensure a single atomic write pattern.
pub fn store_object(data_dir: &Path, kind: &str, content: &[u8]) -> Result<String> {
    let hex_hash = hash::sha256_hex(content);
    let dir = data_dir.join("objects").join(kind);
    fs::create_dir_all(&dir)?;

    let file_path = dir.join(format!("{}.json.gz", hex_hash));

    // Skip if already stored (content-addressable dedup).
    if file_path.exists() {
        return Ok(hex_hash);
    }

    // Write to temp file, then atomic rename. A crash mid-write leaves only
    // the temp file, never a corrupt object at the final path.
    let tmp_path = dir.join(format!(".{}.json.gz.tmp", hex_hash));
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)
    {
        Ok(file) => {
            // Wrap the write+rename in a closure so we can clean up the temp
            // file on any error (encoder failure, write failure, rename failure).
            let result = (|| -> Result<()> {
                let mut encoder = GzEncoder::new(file, Compression::default());
                encoder.write_all(content)?;
                encoder.finish()?;
                fs::rename(&tmp_path, &file_path)?;
                Ok(())
            })();

            if result.is_err() {
                // Best-effort cleanup of the temp file on failure.
                let _ = fs::remove_file(&tmp_path);
            }
            result?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // Another writer is writing the same content — skip.
        }
        Err(e) => return Err(e.into()),
    }

    Ok(hex_hash)
}
