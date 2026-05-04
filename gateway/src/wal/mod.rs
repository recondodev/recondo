//! Write-Ahead Log (WAL) buffer for fail-open gateway operation.
//!
//! When the capture pipeline (SQLite graph store, object store) is unhealthy,
//! the gateway continues forwarding agent traffic while buffering captured data
//! locally in a WAL directory for later flush.
//!
//! # Data flow
//!
//! ```text
//! Agent traffic -> WAL append (raw bytes) -> forward to LLM immediately
//!                     |  (async)
//!              WAL -> Object Store + Graph Store (with retry)
//!                     |  (on success)
//!              mark_flushed -> entry removed from unflushed set
//! ```
//!
//! # Persistence
//!
//! Each WAL entry is stored as a separate file in the WAL directory with a
//! monotonic sequence number prefix. Entries survive process restarts because
//! they are persisted to disk immediately on append. The `flushed` state is
//! tracked by renaming entry files with a `.flushed` suffix.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result};

/// Configurable failure mode for the WAL.
///
/// - `Open` (default): When WAL write fails, return an error but allow the
///   caller to continue forwarding traffic to the LLM API.
/// - `Closed`: When WAL write fails, the caller should treat it as a hard
///   stop and refuse to forward the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailMode {
    /// Forward to LLM even if WAL write fails.
    Open,
    /// Block agent if WAL write fails.
    Closed,
}

/// N1 fix: Explicit conversion from `config::FailMode` to `wal::FailMode`
/// so the mapping between the two enums is unambiguous and compile-checked.
impl From<crate::config::FailMode> for FailMode {
    fn from(mode: crate::config::FailMode) -> Self {
        match mode {
            crate::config::FailMode::Open => FailMode::Open,
            crate::config::FailMode::Closed => FailMode::Closed,
        }
    }
}

/// A WAL entry returned by `flush()` or `append_entry()`, identifying the
/// on-disk file backing the entry. Bytes are read on demand via
/// [`WalEntry::read_data`] so the WAL never holds a redundant in-memory copy
/// of the payload.
#[derive(Debug, Clone)]
pub struct WalEntry {
    /// The file path of this entry on disk.
    path: PathBuf,
}

impl WalEntry {
    /// Read the entry's bytes from disk on demand.
    ///
    /// Tries `self.path` first (unflushed entry), then falls back to the
    /// `.flushed`-suffixed path (in case `mark_flushed` renamed the file
    /// after this WalEntry handle was created).
    ///
    /// Uses match-on-error-kind rather than a separate `exists()` pre-check,
    /// which (a) eliminates the TOCTOU window between `exists()` and `read()`
    /// (theoretical under the WAL's documented single-process assumption,
    /// but cheap to close idiomatically) and (b) lets us construct
    /// `flushed_path` exactly once and reuse it in the final error message
    /// instead of formatting `self.path` twice.
    ///
    /// Returns an error if neither path exists or the read fails.
    pub fn read_data(&self) -> anyhow::Result<Vec<u8>> {
        let mut flushed = self.path.as_os_str().to_os_string();
        flushed.push(".flushed");
        let flushed_path = std::path::PathBuf::from(flushed);

        // Try the primary (unflushed) path; fall through on NotFound so we
        // can check the .flushed sibling. Surface any other I/O error.
        match std::fs::read(&self.path) {
            Ok(bytes) => return Ok(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(e)
                    .with_context(|| format!("Failed to read WAL entry: {}", self.path.display()));
            }
        }

        // Fallback: file may have been renamed to .flushed by mark_flushed.
        match std::fs::read(&flushed_path) {
            Ok(bytes) => return Ok(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(e).with_context(|| {
                    format!(
                        "Failed to read flushed WAL entry: {}",
                        flushed_path.display()
                    )
                });
            }
        }

        anyhow::bail!(
            "WAL entry not found at {} or {}",
            self.path.display(),
            flushed_path.display(),
        );
    }
}

/// File-based Write-Ahead Log.
///
/// Each entry is stored as a file named `{sequence}_{pid}.wal` in the WAL directory.
/// Flushed entries are renamed to `{sequence}_{pid}.wal.flushed`.
///
/// # Concurrency assumption
///
/// This WAL assumes single-process access to the WAL directory. Sequence numbers
/// are generated from an in-process atomic counter initialized by scanning existing
/// files. If multiple processes share the same WAL directory, they may collide on
/// sequence numbers. The PID suffix in filenames provides collision resistance for
/// future multi-process support but does not guarantee ordering across processes.
pub struct Wal {
    /// Directory where WAL entry files are stored.
    dir: PathBuf,
    /// Monotonically increasing sequence number for new entries.
    next_seq: AtomicU64,
    /// Cached count of unflushed entries. Updated on append_entry success
    /// (++) and mark_flushed success (--). Resynced on `Wal::open` by
    /// scanning the directory once at startup.
    unflushed: AtomicU64,
    /// Configured failure mode.
    mode: FailMode,
}

impl Wal {
    /// Open (or create) a WAL in the given directory with default fail mode (Open).
    ///
    /// Scans the directory for existing unflushed `.wal` files to determine
    /// the next sequence number. Files that are not WAL entries (e.g., decoy
    /// files) are ignored.
    pub fn open(dir: &Path) -> Result<Self> {
        Self::open_with_mode(dir, FailMode::Open)
    }

    /// Open (or create) a WAL in the given directory with the specified fail mode.
    pub fn open_with_mode(dir: &Path, mode: FailMode) -> Result<Self> {
        fs::create_dir_all(dir).context("Failed to create WAL directory")?;

        // Scan for existing WAL files to find the highest sequence number AND
        // the count of unflushed entries (for the O(1) `unflushed_count()`
        // cache).
        let mut max_seq: u64 = 0;
        let mut unflushed_count: u64 = 0;
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy().to_string();
                if let Some(seq) = Self::parse_wal_filename(&name_str) {
                    if seq > max_seq {
                        max_seq = seq;
                    }
                }
                // Count unflushed (.wal but not .wal.flushed) for the
                // O(1) `unflushed_count()` cache.
                if name_str.ends_with(".wal") && !name_str.ends_with(".wal.flushed") {
                    unflushed_count += 1;
                }
            }
        }

        Ok(Wal {
            dir: dir.to_path_buf(),
            next_seq: AtomicU64::new(max_seq + 1),
            unflushed: AtomicU64::new(unflushed_count),
            mode,
        })
    }

    /// Parse a WAL filename and return the sequence number, if valid.
    /// Recognizes both `{seq}_{pid}.wal` and `{seq}_{pid}.wal.flushed`,
    /// as well as legacy `{seq}.wal` format (without PID).
    fn parse_wal_filename(name: &str) -> Option<u64> {
        let base = name
            .strip_suffix(".wal.flushed")
            .or_else(|| name.strip_suffix(".wal"))?;
        // Handle both "{seq}_{pid}" and legacy "{seq}" formats
        let seq_str = base.split('_').next()?;
        seq_str.parse::<u64>().ok()
    }

    /// Append raw bytes as a new WAL entry.
    ///
    /// The entry is written to disk synchronously. Returns an error if the
    /// write fails (e.g., disk full, directory not writable).
    ///
    /// # Phase 1 limitation: no metadata
    ///
    /// Entries are stored as raw bytes without metadata (no indication of
    /// whether the data is a request or response, which provider it belongs
    /// to, timestamps, etc.). The WAL serves as a crash-safety buffer: the
    /// DB is the source of truth for structured data. If WAL recovery is
    /// needed (e.g., after a crash before DB commit), the raw bytes must be
    /// re-parsed through the full capture pipeline to reconstruct metadata.
    /// Adding an envelope with metadata fields is planned for Phase 2.
    pub fn append(&self, data: &[u8]) -> Result<()> {
        self.append_entry(data).map(|_| ())
    }

    /// Append raw bytes as a new WAL entry and return a handle to the
    /// just-written entry.
    ///
    /// Behaves identically to [`Wal::append`] on success and failure; the
    /// difference is that the caller receives a [`WalEntry`] handle that
    /// can later be passed to [`Wal::mark_flushed`] to mark THIS specific
    /// entry as flushed. This is the surface that `process_capture_with_pipeline`
    /// uses after a successful DB commit so it only marks the entries it
    /// just wrote — never the global unflushed set.
    ///
    /// Marking only the just-written entries (instead of every unflushed
    /// entry returned by `flush()`) prevents a successful capture from
    /// silently burying a prior crash's orphan WAL entries.
    pub fn append_entry(&self, data: &[u8]) -> Result<WalEntry> {
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        let filename = format!("{}_{}.wal", seq, pid);
        let path = self.dir.join(&filename);

        // Write to a temp file first, then rename for atomicity.
        let tmp_path = self.dir.join(format!(".{}_{}.wal.tmp", seq, pid));
        let mut file = fs::File::create(&tmp_path)
            .with_context(|| format!("Failed to create WAL temp file: {}", tmp_path.display()))?;
        file.write_all(data)
            .with_context(|| format!("Failed to write WAL entry {}", seq))?;
        file.sync_all()
            .with_context(|| format!("Failed to sync WAL entry {}", seq))?;
        fs::rename(&tmp_path, &path)
            .with_context(|| format!("Failed to finalize WAL entry {}", seq))?;
        // Increment the cached unflushed counter ONLY after the rename
        // succeeded — i.e. when the entry is durably on disk under its
        // final name.
        self.unflushed.fetch_add(1, Ordering::Relaxed);

        Ok(WalEntry { path })
    }

    /// Return all unflushed entries, ordered by sequence number.
    ///
    /// An entry is unflushed if its file ends with `.wal` (not `.wal.flushed`).
    pub fn flush(&self) -> Result<Vec<WalEntry>> {
        let mut entries = Vec::new();

        let dir_entries =
            fs::read_dir(&self.dir).context("Failed to read WAL directory for flush")?;

        for entry in dir_entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy().to_string();

            // Only unflushed entries (ending in .wal, not .wal.flushed)
            if name_str.ends_with(".wal") && !name_str.ends_with(".wal.flushed") {
                if let Some(seq) = Self::parse_wal_filename(&name_str) {
                    let path = entry.path();
                    entries.push((seq, WalEntry { path }));
                }
            }
        }

        // Sort by sequence number for deterministic ordering.
        entries.sort_by_key(|(seq, _)| *seq);

        Ok(entries.into_iter().map(|(_, e)| e).collect())
    }

    /// Mark a WAL entry as flushed by renaming its file.
    ///
    /// After marking, the entry will no longer be returned by `flush()`.
    /// Marking an already-flushed entry is a no-op (idempotent).
    pub fn mark_flushed(&self, entry: &WalEntry) -> Result<()> {
        let mut flushed_name = entry.path.as_os_str().to_os_string();
        flushed_name.push(".flushed");
        let flushed_path = PathBuf::from(flushed_name);

        // If the original file doesn't exist, it may already be flushed.
        // The unflushed counter must NOT be decremented here — the prior
        // successful rename already decremented it.
        if !entry.path.exists() {
            // Already flushed or missing — no-op.
            return Ok(());
        }

        fs::rename(&entry.path, &flushed_path).with_context(|| {
            format!(
                "Failed to mark WAL entry as flushed: {}",
                entry.path.display()
            )
        })?;
        // Decrement the cached unflushed counter ONLY after the rename
        // succeeded. The early-return path above (entry already flushed)
        // does NOT decrement, preserving idempotency.
        self.unflushed.fetch_sub(1, Ordering::Relaxed);

        Ok(())
    }

    /// Return the count of unflushed entries.
    ///
    /// O(1) atomic load of the cached counter. The counter is initialised
    /// on `Wal::open` by scanning the directory once at startup, then kept
    /// in sync via `append_entry` (++) and `mark_flushed` (--).
    pub fn unflushed_count(&self) -> usize {
        self.unflushed.load(Ordering::Relaxed) as usize
    }

    /// Returns the configured fail mode.
    pub fn fail_mode(&self) -> FailMode {
        self.mode
    }
}
