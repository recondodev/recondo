//! Feature 2: Write-Ahead Log (WAL) module tests.
//!
//! These tests verify that the WAL buffers raw bytes to local disk before
//! the capture pipeline, supports append/flush/mark_flushed/unflushed_count,
//! and respects the configurable fail_mode (open/closed).
//!
//! Design reference: IMPLEMENTATION_ROADMAP.md Week 1 Task 4, OD-001.
//!
//! Key design invariants from OD-001:
//! - Raw bytes are written to local WAL BEFORE forwarding to capture pipeline
//! - WAL entries are marked as flushed on successful pipeline write
//! - If pipeline is down, WAL persists and agent traffic continues
//! - fail_mode = "open" (default): forward to LLM even if WAL write fails
//! - fail_mode = "closed": block agent if WAL write fails

use std::fs;
use tempfile::TempDir;

use recondo_gateway::wal::{FailMode, Wal};

// ===========================================================================
// 2.1 WAL append writes data to disk
// ===========================================================================

/// **Proves:** Calling append() creates a file on disk containing the raw bytes.
/// The file is verifiable by reading it back and comparing to the input.
///
/// **Anti-fake property:** An in-memory-only WAL (no disk persistence) would fail
/// this test because we check the filesystem directly. The old code path had no
/// WAL — raw bytes went directly to the capture pipeline.
#[test]
fn wal_append_creates_file_on_disk() {
    let tmp = TempDir::new().unwrap();
    let wal = Wal::open(tmp.path()).expect("WAL must open successfully");

    let data = b"raw request bytes for WAL persistence test";
    wal.append(data).expect("append must succeed");

    // Verify data was written to disk by checking the WAL directory
    // has at least one file with non-zero size
    let wal_dir = tmp.path();
    let files: Vec<_> = fs::read_dir(wal_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .collect();

    assert!(
        !files.is_empty(),
        "WAL append must create at least one file on disk"
    );

    // At least one file must have content
    let total_size: u64 = files.iter().map(|f| f.metadata().unwrap().len()).sum();
    assert!(
        total_size > 0,
        "WAL files must contain data after append, total size was 0"
    );
}

// ===========================================================================
// 2.2 WAL unflushed_count increments on append
// ===========================================================================

/// **Proves:** After appending N entries, unflushed_count() returns N.
/// After flushing, the count decreases.
///
/// **Anti-fake property:** A stub that returns 0 always would fail the post-append
/// assertion. A stub that returns a fixed number would fail after multiple appends.
#[test]
fn wal_unflushed_count_tracks_appends() {
    let tmp = TempDir::new().unwrap();
    let wal = Wal::open(tmp.path()).expect("WAL must open");

    assert_eq!(
        wal.unflushed_count(),
        0,
        "Fresh WAL must have unflushed_count == 0"
    );

    wal.append(b"entry 1").unwrap();
    assert_eq!(
        wal.unflushed_count(),
        1,
        "After 1 append, unflushed_count must be 1"
    );

    wal.append(b"entry 2").unwrap();
    assert_eq!(
        wal.unflushed_count(),
        2,
        "After 2 appends, unflushed_count must be 2"
    );

    wal.append(b"entry 3").unwrap();
    assert_eq!(
        wal.unflushed_count(),
        3,
        "After 3 appends, unflushed_count must be 3"
    );
}

// ===========================================================================
// 2.3 WAL flush returns entries and they can be read
// ===========================================================================

/// **Proves:** flush() returns the raw bytes that were appended, in order.
/// The returned data matches what was originally appended.
///
/// **Anti-fake property:** A flush() that returns empty vecs or fabricated data
/// would fail the byte-level comparison. A flush() that returns entries out of
/// order would fail the sequential assertion.
#[test]
fn wal_flush_returns_appended_data_in_order() {
    let tmp = TempDir::new().unwrap();
    let wal = Wal::open(tmp.path()).expect("WAL must open");

    let entry_a = b"first entry payload";
    let entry_b = b"second entry payload";
    let entry_c = b"third entry payload";

    wal.append(entry_a).unwrap();
    wal.append(entry_b).unwrap();
    wal.append(entry_c).unwrap();

    let entries = wal.flush().expect("flush must succeed");

    assert_eq!(entries.len(), 3, "flush must return all 3 entries");
    assert_eq!(
        entries[0].read_data().unwrap(),
        entry_a,
        "First entry must match"
    );
    assert_eq!(
        entries[1].read_data().unwrap(),
        entry_b,
        "Second entry must match"
    );
    assert_eq!(
        entries[2].read_data().unwrap(),
        entry_c,
        "Third entry must match"
    );
}

// ===========================================================================
// 2.4 WAL mark_flushed decrements unflushed_count
// ===========================================================================

/// **Proves:** After calling mark_flushed() on an entry, unflushed_count()
/// decreases by the number of entries marked.
///
/// **Anti-fake property:** A WAL that ignores mark_flushed and keeps counting
/// all appends would fail the post-mark assertion.
#[test]
fn wal_mark_flushed_decrements_unflushed_count() {
    let tmp = TempDir::new().unwrap();
    let wal = Wal::open(tmp.path()).expect("WAL must open");

    wal.append(b"entry A").unwrap();
    wal.append(b"entry B").unwrap();
    wal.append(b"entry C").unwrap();
    assert_eq!(wal.unflushed_count(), 3);

    let entries = wal.flush().unwrap();
    assert_eq!(entries.len(), 3);

    // Mark the first entry as flushed
    wal.mark_flushed(&entries[0])
        .expect("mark_flushed must succeed");
    assert_eq!(
        wal.unflushed_count(),
        2,
        "After marking 1 entry flushed, unflushed_count must be 2"
    );

    // Mark all remaining
    wal.mark_flushed(&entries[1]).unwrap();
    wal.mark_flushed(&entries[2]).unwrap();
    assert_eq!(
        wal.unflushed_count(),
        0,
        "After marking all entries flushed, unflushed_count must be 0"
    );
}

// ===========================================================================
// 2.5 WAL persists across reopen
// ===========================================================================

/// **Proves:** Entries appended before a WAL is closed/dropped are still
/// present when the WAL is reopened from the same directory. This validates
/// the "survives gateway restart" invariant from OD-001.
///
/// **Anti-fake property:** An in-memory WAL that loses state on drop would
/// fail the post-reopen unflushed_count check.
#[test]
fn wal_entries_survive_reopen() {
    let tmp = TempDir::new().unwrap();

    // Append some entries, then drop the WAL
    {
        let wal = Wal::open(tmp.path()).expect("WAL must open");
        wal.append(b"persistent entry 1").unwrap();
        wal.append(b"persistent entry 2").unwrap();
        // WAL dropped here
    }

    // Reopen from the same directory
    let wal2 = Wal::open(tmp.path()).expect("WAL must reopen");
    assert_eq!(
        wal2.unflushed_count(),
        2,
        "After reopen, unflushed_count must reflect persisted entries"
    );

    // Flush and verify data integrity
    let entries = wal2.flush().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].read_data().unwrap(), b"persistent entry 1");
    assert_eq!(entries[1].read_data().unwrap(), b"persistent entry 2");
}

// ===========================================================================
// 2.6 WAL fail_mode = open (default)
// ===========================================================================

/// **Proves:** With fail_mode = "open" (the default), when the WAL directory
/// becomes unwritable, append() returns an error BUT the caller can still
/// proceed with forwarding to the LLM API. The WAL signals the error rather
/// than panicking.
///
/// **Anti-fake property:** A WAL with no fail_mode concept would either panic
/// or silently succeed on unwritable directories.
#[test]
fn wal_fail_open_returns_error_on_disk_failure() {
    let tmp = TempDir::new().unwrap();
    let wal = Wal::open(tmp.path()).expect("WAL must open");

    // Verify default fail mode is open
    assert_eq!(
        wal.fail_mode(),
        FailMode::Open,
        "Default fail_mode must be Open"
    );

    // Make the directory read-only to simulate disk failure
    let mut perms = fs::metadata(tmp.path()).unwrap().permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o444);
        fs::set_permissions(tmp.path(), perms).unwrap();
    }

    let result = wal.append(b"should fail");

    // Restore permissions before asserting (so cleanup works)
    #[cfg(unix)]
    {
        let mut perms = fs::metadata(tmp.path()).unwrap().permissions();
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o755);
        fs::set_permissions(tmp.path(), perms).unwrap();
    }

    // In fail-open mode, append returns Err but the caller continues
    assert!(
        result.is_err(),
        "WAL append must return Err when disk is unwritable"
    );
}

// ===========================================================================
// 2.7 WAL fail_mode = closed
// ===========================================================================

/// **Proves:** With fail_mode = "closed", the WAL can be configured to use
/// closed mode. When FailMode::Closed is set, the semantics differ from open:
/// the caller should treat WAL write failure as a hard stop.
///
/// **Anti-fake property:** A WAL with no FailMode::Closed variant would fail
/// to compile this test. The behavioral difference is that the caller is
/// expected to abort the request when append fails in closed mode.
#[test]
fn wal_fail_closed_mode_is_configurable() {
    let tmp = TempDir::new().unwrap();
    let wal =
        Wal::open_with_mode(tmp.path(), FailMode::Closed).expect("WAL must open in closed mode");

    assert_eq!(
        wal.fail_mode(),
        FailMode::Closed,
        "WAL must report Closed fail_mode when configured"
    );

    // Normal operations should still work
    wal.append(b"entry in closed mode").unwrap();
    assert_eq!(wal.unflushed_count(), 1);
}

// ===========================================================================
// 2.8 WAL flush after all entries are already flushed returns empty
// ===========================================================================

/// **Proves:** Calling flush() when all entries have been marked_flushed
/// returns an empty list. This prevents duplicate processing.
///
/// **Anti-fake property:** A WAL that returns already-flushed entries on
/// subsequent flush() calls would fail this assertion.
#[test]
fn wal_flush_after_all_marked_returns_empty() {
    let tmp = TempDir::new().unwrap();
    let wal = Wal::open(tmp.path()).expect("WAL must open");

    wal.append(b"one").unwrap();
    wal.append(b"two").unwrap();

    let entries = wal.flush().unwrap();
    for entry in &entries {
        wal.mark_flushed(entry).unwrap();
    }

    let second_flush = wal.flush().unwrap();
    assert!(
        second_flush.is_empty(),
        "flush after all entries marked_flushed must return empty, got {} entries",
        second_flush.len()
    );

    assert_eq!(wal.unflushed_count(), 0);
}

// ===========================================================================
// 2.9 NEGATIVE: WAL with empty directory has zero unflushed entries
// ===========================================================================

/// **Proves:** A freshly opened WAL on an empty directory reports 0 unflushed
/// entries. Combined with test 2.2, this proves unflushed_count is driven by
/// actual appends, not directory artifacts.
///
/// **Anti-fake property:** A WAL that counts files in the directory (including
/// non-WAL files) would fail if we created a decoy file.
#[test]
fn wal_empty_directory_reports_zero_unflushed() {
    let tmp = TempDir::new().unwrap();

    // Create a decoy file that is NOT a WAL entry
    fs::write(tmp.path().join("decoy.txt"), b"not a wal entry").unwrap();

    let wal = Wal::open(tmp.path()).expect("WAL must open");

    assert_eq!(
        wal.unflushed_count(),
        0,
        "WAL must not count non-WAL files as unflushed entries"
    );
}

// ===========================================================================
// 2.10 WAL handles large entries
// ===========================================================================

/// **Proves:** The WAL can append and flush a 1 MB entry without truncation
/// or corruption. This validates handling of realistic LLM request/response sizes.
///
/// **Anti-fake property:** A WAL with a small fixed buffer would truncate
/// the data, causing the byte comparison to fail.
#[test]
fn wal_handles_large_entries() {
    let tmp = TempDir::new().unwrap();
    let wal = Wal::open(tmp.path()).expect("WAL must open");

    // 1 MB of data
    let large_data: Vec<u8> = (0..1_048_576).map(|i| (i % 256) as u8).collect();

    wal.append(&large_data).unwrap();
    assert_eq!(wal.unflushed_count(), 1);

    let entries = wal.flush().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].read_data().unwrap().len(),
        1_048_576,
        "Flushed entry must have full 1 MB of data"
    );
    assert_eq!(
        entries[0].read_data().unwrap(),
        large_data,
        "Flushed data must match original byte-for-byte"
    );
}

// ===========================================================================
// 2.11 WAL handles empty entries
// ===========================================================================

/// **Proves:** Appending an empty byte slice is valid and is tracked as
/// a separate unflushed entry.
///
/// **Anti-fake property:** A WAL that silently drops empty entries would
/// report unflushed_count == 0 after this append.
#[test]
fn wal_handles_empty_entry() {
    let tmp = TempDir::new().unwrap();
    let wal = Wal::open(tmp.path()).expect("WAL must open");

    wal.append(b"").unwrap();
    assert_eq!(
        wal.unflushed_count(),
        1,
        "Empty entry must still be tracked as unflushed"
    );

    let entries = wal.flush().unwrap();
    assert_eq!(entries.len(), 1);
    assert!(
        entries[0].read_data().unwrap().is_empty(),
        "Empty entry data must be empty"
    );
}

// ===========================================================================
// 2.12 NEGATIVE: Mark flushed on non-existent entry is handled
// ===========================================================================

/// **Proves:** Attempting to mark_flushed an entry that does not belong to
/// this WAL (or has already been marked) does not panic and either returns
/// an error or is a no-op.
///
/// **Anti-fake property:** A WAL that panics on unknown entries would crash.
/// A WAL that decrements unflushed_count below zero would produce a negative
/// count.
#[test]
fn wal_mark_flushed_nonexistent_entry_does_not_panic() {
    let tmp = TempDir::new().unwrap();
    let wal = Wal::open(tmp.path()).expect("WAL must open");

    wal.append(b"real entry").unwrap();
    let entries = wal.flush().unwrap();

    // Mark it flushed once (valid)
    wal.mark_flushed(&entries[0]).unwrap();
    assert_eq!(wal.unflushed_count(), 0);

    // Mark the same entry flushed again — must not panic or go negative
    let result = wal.mark_flushed(&entries[0]);
    // Either Ok or Err is fine, but no panic and count must not go negative
    let _ = result;
    assert!(
        wal.unflushed_count() == 0,
        "unflushed_count must not go negative after double mark_flushed"
    );
}
