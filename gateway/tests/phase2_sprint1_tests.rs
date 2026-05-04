//! Phase 2 Sprint 1: TLS CA Automation — Behavioral Tests
//!
//! These tests are written BEFORE the implementation exists. They MUST NOT
//! compile until the implementation agent creates the required modules:
//!
//! - `recondo_gateway::tls::trust_store` (new module)
//! - `recondo_gateway::tls::CertCache` (new struct)
//! - `recondo_gateway::tls::{ca_fingerprint, ca_subject, ca_validity}` (new functions)
//! - `recondo_gateway::db::TurnRecord.integrity_verified` (new field)
//!
//! Each test imports production types/functions that do not exist yet.
//! The implementation agent must create them to make these tests pass.

use std::path::Path;

use rustls::client::danger::ServerCertVerifier;
use tempfile::TempDir;

use recondo_gateway::db::{self, SessionRecord, TurnRecord};
use recondo_gateway::tls;
use recondo_gateway::tls::trust_store::{
    build_install_commands, build_remove_commands, build_verify_command, Platform,
};
use recondo_gateway::tls::{ca_fingerprint, ca_subject, ca_validity, CertCache};

// ===========================================================================
// Helpers
// ===========================================================================

fn setup_db() -> rusqlite::Connection {
    let conn = db::open_in_memory().expect("Must open in-memory SQLite");
    db::initialize(&conn).expect("Must initialize database schema");
    conn
}

fn sample_session(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.to_string(),
        provider: "anthropic".to_string(),
        model: None,
        started_at: "2026-03-19T10:00:00Z".to_string(),
        last_active_at: "2026-03-19T10:05:00Z".to_string(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash: "abc123".to_string(),
        total_turns: 0,
        turns_captured: 0,
        dropped_events: 0,
        total_tokens: 0,
        total_cost_usd: 0.0,
        framework: None,
        agent_id: None,
        agent_version: None,
        git_repo: None,
        git_branch: None,
        git_commit: None,
        working_directory: None,
        parent_session_id: None,
        tags: None,
        account_uuid: None,
        device_id: None,
        tool_definitions_hash: String::new(),
    }
}

fn sample_turn(id: &str, session_id: &str, seq: i64) -> TurnRecord {
    TurnRecord {
        id: id.to_string(),
        session_id: session_id.to_string(),
        sequence_num: seq,
        timestamp: format!("2026-03-19T10:{:02}:00Z", seq),
        request_hash: format!("req_hash_{}", seq),
        response_hash: format!("resp_hash_{}", seq),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some("claude-sonnet-4-20250514".to_string()),
        response_text: None,
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 100 * seq,
        output_tokens: 50 * seq,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: format!("2026-03-19T10:{:02}:00Z", seq),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: None,
        parser_version: None,
        parse_errors: None,
        provider: None,
        transport: None,
        ws_direction: None,
        duration_ms: None,
        ttfb_ms: None,
        api_endpoint: None,
        http_status: None,
        error_message: None,
        retry_count: 0,
        tool_call_count: 0,
        thinking_tokens: 0,
        server_id: None,
        integrity_verified: None,
        supersedes_turn_id: None,
        user_request_text: None,
        attachment_count: 0,
    }
}

/// Create a temp dir with a valid CA for tests that need one.
fn setup_ca() -> (TempDir, std::path::PathBuf) {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();
    tls::ensure_ca(&data_dir).expect("CA generation must succeed");
    (tmp, data_dir)
}

// ===========================================================================
// Section 1: Trust Store Command Construction (5 tests)
// ===========================================================================

/// **Proves:** On macOS, build_install_commands returns commands containing
/// "security add-trusted-cert" — the macOS Keychain CLI for CA trust.
/// **Anti-fake:** An empty vec or Linux commands would fail this assertion.
#[test]
fn macos_install_commands_contain_security_add_trusted_cert() {
    let cert_path = Path::new("/tmp/test-ca.crt");
    let commands = build_install_commands(cert_path, Platform::MacOS);

    assert!(
        !commands.is_empty(),
        "macOS install commands must not be empty"
    );

    let joined = commands.join(" ");
    assert!(
        joined.contains("security add-trusted-cert"),
        "macOS install commands must include 'security add-trusted-cert', got: {:?}",
        commands
    );
}

/// **Proves:** On Linux, build_install_commands returns commands containing
/// "update-ca-certificates" — the Debian/Ubuntu CA trust update command.
/// **Anti-fake:** macOS commands or empty vec would fail.
#[test]
fn linux_install_commands_contain_update_ca_certificates() {
    let cert_path = Path::new("/tmp/test-ca.crt");
    let commands = build_install_commands(cert_path, Platform::Linux);

    assert!(
        !commands.is_empty(),
        "Linux install commands must not be empty"
    );

    let joined = commands.join(" ");
    assert!(
        joined.contains("update-ca-certificates"),
        "Linux install commands must include 'update-ca-certificates', got: {:?}",
        commands
    );
}

/// **Proves:** On macOS, build_remove_commands returns commands containing
/// "security remove-trusted-cert" — the macOS removal command.
/// **Anti-fake:** Would fail if remove just returns install commands or empties.
#[test]
fn macos_remove_commands_contain_security_remove_trusted_cert() {
    let cert_path = Path::new("/tmp/test-ca.crt");
    let commands = build_remove_commands(cert_path, Platform::MacOS);

    assert!(
        !commands.is_empty(),
        "macOS remove commands must not be empty"
    );

    let joined = commands.join(" ");
    assert!(
        joined.contains("security remove-trusted-cert")
            || joined.contains("security delete-certificate"),
        "macOS remove commands must include a security removal command, got: {:?}",
        commands
    );
}

/// **Proves:** On macOS, build_verify_command returns a command string containing
/// "security verify-cert" — the macOS cert verification command.
/// **Anti-fake:** None or a Linux-style command would fail.
#[test]
fn verify_command_macos_uses_security_verify_cert() {
    let cert_path = Path::new("/tmp/test-ca.crt");
    let cmd = build_verify_command(cert_path, Platform::MacOS);

    assert!(cmd.is_some(), "macOS verify command must not be None");

    let cmd_str = cmd.unwrap();
    assert!(
        cmd_str.contains("security verify-cert") || cmd_str.contains("security find-certificate"),
        "macOS verify command must use security CLI, got: {:?}",
        cmd_str
    );
}

/// **Proves:** For Platform::Unknown, build_install_commands returns an empty vec
/// because we don't know how to install CAs on an unknown platform.
/// **Anti-fake:** Any non-empty vec would fail.
#[test]
fn unknown_platform_returns_empty_commands() {
    let cert_path = Path::new("/tmp/test-ca.crt");
    let commands = build_install_commands(cert_path, Platform::Unknown);

    assert!(
        commands.is_empty(),
        "Unknown platform must return empty install commands, got: {:?}",
        commands
    );
}

// ===========================================================================
// Section 2: CA Info Functions (4 tests)
// ===========================================================================

/// **Proves:** ca_fingerprint returns a 64-character lowercase hex string,
/// which is the expected format for SHA-256.
/// **Anti-fake:** A function returning "ok" or a short string would fail.
#[test]
fn ca_fingerprint_is_64_hex_chars() {
    let (_tmp, data_dir) = setup_ca();

    let fingerprint = ca_fingerprint(&data_dir).expect("ca_fingerprint must succeed");

    assert_eq!(
        fingerprint.len(),
        64,
        "SHA-256 fingerprint must be 64 hex chars, got {} chars: {:?}",
        fingerprint.len(),
        fingerprint
    );

    assert!(
        fingerprint.chars().all(|c: char| c.is_ascii_hexdigit()),
        "Fingerprint must be all hex digits, got: {:?}",
        fingerprint
    );

    // SHA-256 hex is lowercase by convention
    assert_eq!(
        fingerprint,
        fingerprint.to_ascii_lowercase(),
        "Fingerprint must be lowercase hex"
    );
}

/// **Proves:** ca_fingerprint is deterministic — calling it twice on the same CA
/// returns the same value.
/// **Anti-fake:** A function computing from random data or timestamps would fail.
#[test]
fn ca_fingerprint_is_deterministic() {
    let (_tmp, data_dir) = setup_ca();

    let fp1 = ca_fingerprint(&data_dir).unwrap();
    let fp2 = ca_fingerprint(&data_dir).unwrap();

    assert_eq!(
        fp1, fp2,
        "ca_fingerprint must be deterministic across calls"
    );
}

/// **Proves:** ca_subject returns a string containing "Recondo", matching the
/// CN or O set in ensure_ca (which uses "Recondo Proxy CA" / "Recondo").
/// **Anti-fake:** A function returning empty or arbitrary strings would fail.
#[test]
fn ca_subject_contains_recondo() {
    let (_tmp, data_dir) = setup_ca();

    let subject = ca_subject(&data_dir).expect("ca_subject must succeed");

    assert!(
        subject.contains("Recondo"),
        "CA subject must contain 'Recondo', got: {:?}",
        subject
    );
}

/// **Proves:** ca_validity returns a (not_before, not_after) pair where the dates
/// are approximately 10 years apart (3650 days), matching the CA generation params.
/// **Anti-fake:** A function returning same-day dates or 1-year span would fail.
#[test]
fn ca_validity_spans_ten_years() {
    let (_tmp, data_dir) = setup_ca();

    let result: (String, String) = ca_validity(&data_dir).expect("ca_validity must succeed");
    let not_before: &str = &result.0;
    let not_after: &str = &result.1;

    // Parse dates. The format should be parseable — either RFC3339 or a common date format.
    // We just verify the year span is approximately 10 years.
    assert!(!not_before.is_empty(), "not_before must not be empty");
    assert!(!not_after.is_empty(), "not_after must not be empty");

    // Extract years from the date strings. The CA is generated "now" with +3650 days,
    // so not_after's year should be not_before's year + 9 or + 10.
    let before_year: i32 = not_before[..4]
        .parse()
        .expect("not_before must start with a 4-digit year");
    let after_year: i32 = not_after[..4]
        .parse()
        .expect("not_after must start with a 4-digit year");

    let year_diff = after_year - before_year;
    assert!(
        (9..=10).contains(&year_diff),
        "CA validity must span ~10 years, got {} years (from {} to {})",
        year_diff,
        not_before,
        not_after
    );
}

// ===========================================================================
// Section 3: Leaf Cert Cache (8 tests)
// ===========================================================================

/// **Proves:** CertCache::new succeeds when a CA already exists on disk.
/// **Anti-fake:** A constructor that always fails would not pass.
#[test]
fn cert_cache_new_loads_ca_from_disk() {
    let (_tmp, data_dir) = setup_ca();

    let cache = CertCache::new(&data_dir, 100);
    assert!(
        cache.is_ok(),
        "CertCache::new must succeed when CA exists, got: {:?}",
        cache.err()
    );
}

/// **Proves:** get_or_generate for a new host returns a valid cert and increases
/// the cache length to 1.
/// **Anti-fake:** A cache that doesn't store anything would fail the len() check.
#[test]
fn cert_cache_get_generates_on_miss() {
    let (_tmp, data_dir) = setup_ca();
    let cache = CertCache::new(&data_dir, 100).unwrap();

    assert_eq!(cache.len(), 0, "New cache must be empty");

    let leaf = cache
        .get_or_generate("api.anthropic.com")
        .expect("get_or_generate must succeed");

    assert!(
        leaf.cert_pem().contains("-----BEGIN CERTIFICATE-----"),
        "Generated cert must be PEM-encoded"
    );
    assert!(
        leaf.key_pem().contains("PRIVATE KEY"),
        "Generated key must be PEM-encoded"
    );
    assert_eq!(
        cache.len(),
        1,
        "Cache must have 1 entry after first generate"
    );
}

/// **Proves:** Two calls to get_or_generate for the same host return identical
/// PEM bytes — the second call returns the cached cert, not a new one.
/// **Anti-fake:** Generating fresh certs each time would produce different keys.
#[test]
fn cert_cache_get_returns_cached_on_hit() {
    let (_tmp, data_dir) = setup_ca();
    let cache = CertCache::new(&data_dir, 100).unwrap();

    let leaf1 = cache.get_or_generate("api.anthropic.com").unwrap();
    let leaf2 = cache.get_or_generate("api.anthropic.com").unwrap();

    assert_eq!(
        leaf1.cert_pem(),
        leaf2.cert_pem(),
        "Same host must return identical cert PEM from cache"
    );
    assert_eq!(
        leaf1.key_pem(),
        leaf2.key_pem(),
        "Same host must return identical key PEM from cache"
    );
    assert_eq!(cache.len(), 1, "Cache must still have 1 entry, not 2");
}

/// **Proves:** Two different hosts get different certificates.
/// **Anti-fake:** A cache that returns the same cert for all hosts would fail.
#[test]
fn cert_cache_different_hosts_get_different_certs() {
    let (_tmp, data_dir) = setup_ca();
    let cache = CertCache::new(&data_dir, 100).unwrap();

    let leaf_anthropic = cache.get_or_generate("api.anthropic.com").unwrap();
    let leaf_openai = cache.get_or_generate("api.openai.com").unwrap();

    assert_ne!(
        leaf_anthropic.cert_pem(),
        leaf_openai.cert_pem(),
        "Different hosts must get different certificates"
    );
    assert_eq!(cache.len(), 2, "Cache must have 2 entries");
}

/// **Proves:** When max_entries=2, inserting a third host evicts the oldest entry.
/// **Anti-fake:** A cache without eviction would have len() == 3.
#[test]
fn cert_cache_evicts_oldest_when_full() {
    let (_tmp, data_dir) = setup_ca();
    let cache = CertCache::new(&data_dir, 2).unwrap();

    cache.get_or_generate("host-a.com").unwrap();
    cache.get_or_generate("host-b.com").unwrap();
    assert_eq!(cache.len(), 2, "Cache must have 2 entries at capacity");

    // Third host should trigger eviction of host-a.com (oldest)
    cache.get_or_generate("host-c.com").unwrap();
    assert_eq!(
        cache.len(),
        2,
        "Cache must still have 2 entries after eviction"
    );

    assert!(
        !cache.contains("host-a.com"),
        "Oldest entry (host-a.com) must have been evicted"
    );
    assert!(
        cache.contains("host-b.com"),
        "host-b.com must still be cached"
    );
    assert!(cache.contains("host-c.com"), "host-c.com must be in cache");
}

/// **Proves:** 8 threads requesting 8 different hosts concurrently all get valid,
/// unique certificates. No panics, no data races.
/// **Anti-fake:** A non-thread-safe cache would panic or produce corrupt certs.
#[test]
fn cert_cache_concurrent_different_hosts() {
    let (_tmp, data_dir) = setup_ca();
    let cache = std::sync::Arc::new(CertCache::new(&data_dir, 100).unwrap());

    let hosts: Vec<String> = (0..8).map(|i| format!("host-{}.example.com", i)).collect();

    let handles: Vec<_> = hosts
        .iter()
        .map(|host| {
            let cache = cache.clone();
            let host = host.clone();
            std::thread::spawn(move || {
                let leaf = cache
                    .get_or_generate(&host)
                    .expect("Concurrent get_or_generate must succeed");
                (host, leaf.cert_pem().to_string())
            })
        })
        .collect();

    let mut results: Vec<(String, String)> = Vec::new();
    for h in handles {
        let val: (String, String) = h.join().expect("Thread must not panic");
        results.push(val);
    }

    // All 8 hosts should have produced valid, unique PEM certs
    assert_eq!(results.len(), 8);
    let certs: std::collections::HashSet<&str> =
        results.iter().map(|(_, pem)| pem.as_str()).collect();
    assert_eq!(
        certs.len(),
        8,
        "8 different hosts must produce 8 different certificates"
    );

    for (_, pem) in &results {
        assert!(
            pem.contains("-----BEGIN CERTIFICATE-----"),
            "Each cert must be valid PEM"
        );
    }
}

/// **Proves:** 8 threads requesting the same host concurrently all get the
/// identical certificate — the cache deduplicates concurrent generation.
/// **Anti-fake:** Generating separate certs per thread would produce different PEMs.
#[test]
fn cert_cache_concurrent_same_host() {
    let (_tmp, data_dir) = setup_ca();
    let cache = std::sync::Arc::new(CertCache::new(&data_dir, 100).unwrap());

    let handles: Vec<_> = (0..8)
        .map(|_| {
            let cache = cache.clone();
            std::thread::spawn(move || {
                let leaf = cache
                    .get_or_generate("shared.example.com")
                    .expect("Concurrent same-host get_or_generate must succeed");
                leaf.cert_pem().to_string()
            })
        })
        .collect();

    let mut pems: Vec<String> = Vec::new();
    for h in handles {
        let val: String = h.join().expect("Thread must not panic");
        pems.push(val);
    }

    // All threads must get the same PEM
    let first = &pems[0];
    for (i, pem) in pems.iter().enumerate().skip(1) {
        assert_eq!(
            pem, first,
            "Thread {} got a different PEM than thread 0 for the same host",
            i
        );
    }

    assert_eq!(
        cache.len(),
        1,
        "Only one entry should exist in cache for the shared host"
    );
}

/// **Proves:** contains() returns true after a cert is generated and false before.
/// **Anti-fake:** A function that always returns true or always false would fail.
#[test]
fn cert_cache_contains_reports_correctly() {
    let (_tmp, data_dir) = setup_ca();
    let cache = CertCache::new(&data_dir, 100).unwrap();

    assert!(
        !cache.contains("fresh.example.com"),
        "contains() must return false for a host not yet cached"
    );

    cache.get_or_generate("fresh.example.com").unwrap();

    assert!(
        cache.contains("fresh.example.com"),
        "contains() must return true after generating a cert for the host"
    );
}

// ===========================================================================
// Section 4: Content Integrity Verification (4 tests)
// ===========================================================================

/// **Proves:** After db::initialize(), the turns table has an integrity_verified column.
/// **Anti-fake:** Without the schema migration, PRAGMA table_info would not include it.
#[test]
fn integrity_verified_column_exists_in_turns() {
    let conn = setup_db();

    let columns: Vec<String> = conn
        .prepare("PRAGMA table_info(turns)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

    assert!(
        columns.contains(&"integrity_verified".to_string()),
        "turns table must have integrity_verified column, found columns: {:?}",
        columns
    );
}

/// **Proves:** A turn with integrity_verified=Some(true) roundtrips through the DB.
/// **Anti-fake:** If the field doesn't exist on TurnRecord or the DB ignores it, this fails.
#[test]
fn integrity_verified_true_roundtrips_through_db() {
    let conn = setup_db();
    db::insert_session(&conn, &sample_session("sess_iv_true")).unwrap();

    let mut turn = sample_turn("turn_iv_true", "sess_iv_true", 1);
    turn.integrity_verified = Some(true);

    db::insert_turn(&conn, &turn).unwrap();

    let turns = db::get_turns_for_session(&conn, "sess_iv_true").unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(
        turns[0].integrity_verified,
        Some(true),
        "integrity_verified=Some(true) must roundtrip through DB"
    );
}

/// **Proves:** A turn with integrity_verified=Some(false) roundtrips through the DB.
/// **Anti-fake:** If the field is always coerced to true or None, this fails.
#[test]
fn integrity_verified_false_roundtrips_through_db() {
    let conn = setup_db();
    db::insert_session(&conn, &sample_session("sess_iv_false")).unwrap();

    let mut turn = sample_turn("turn_iv_false", "sess_iv_false", 1);
    turn.integrity_verified = Some(false);

    db::insert_turn(&conn, &turn).unwrap();

    let turns = db::get_turns_for_session(&conn, "sess_iv_false").unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(
        turns[0].integrity_verified,
        Some(false),
        "integrity_verified=Some(false) must roundtrip through DB"
    );
}

/// **Proves:** A turn inserted without setting integrity_verified reads back as None.
/// This ensures backward compatibility — old turns that predate integrity checking
/// have NULL in the DB, which maps to None.
/// **Anti-fake:** If the DB default is 0 or 1 instead of NULL, this fails.
#[test]
fn integrity_verified_null_for_old_turns() {
    let conn = setup_db();
    db::insert_session(&conn, &sample_session("sess_iv_null")).unwrap();

    let turn = sample_turn("turn_iv_null", "sess_iv_null", 1);
    // integrity_verified is already None from sample_turn

    db::insert_turn(&conn, &turn).unwrap();

    let turns = db::get_turns_for_session(&conn, "sess_iv_null").unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(
        turns[0].integrity_verified, None,
        "integrity_verified must be None when not explicitly set"
    );
}

// ===========================================================================
// Section 5: Negative Tests (4 tests)
// ===========================================================================

/// **Proves:** CertCache::new fails when no CA exists on disk.
/// **Anti-fake:** A constructor that silently generates a CA or returns Ok would fail.
#[test]
fn cert_cache_new_fails_without_ca() {
    let tmp = TempDir::new().unwrap();
    let empty_dir = tmp.path().to_path_buf();

    let result = CertCache::new(&empty_dir, 100);
    assert!(
        result.is_err(),
        "CertCache::new must fail when no CA exists on disk"
    );
}

/// **Proves:** build_install_commands for a nonexistent cert path still returns
/// commands that reference the path — path validation is the caller's job.
/// **Anti-fake:** A function that checks file existence and returns empty would fail.
#[test]
fn build_install_commands_nonexistent_cert_path() {
    let bogus_path = Path::new("/nonexistent/path/to/ca.crt");
    let commands = build_install_commands(bogus_path, Platform::MacOS);

    // The function should return commands regardless of whether the file exists.
    // It constructs command strings; execution and validation happen elsewhere.
    assert!(
        !commands.is_empty(),
        "build_install_commands must return commands even for nonexistent paths"
    );

    let joined = commands.join(" ");
    assert!(
        joined.contains("/nonexistent/path/to/ca.crt"),
        "Commands must reference the provided cert path, got: {:?}",
        commands
    );
}

/// **Proves:** get_or_generate with an empty hostname returns an error.
/// **Anti-fake:** Generating a cert for "" would produce an invalid certificate.
#[test]
fn cert_cache_empty_hostname_returns_error() {
    let (_tmp, data_dir) = setup_ca();
    let cache = CertCache::new(&data_dir, 100).unwrap();

    let result = cache.get_or_generate("");
    assert!(
        result.is_err(),
        "get_or_generate('') must return an error for empty hostname"
    );
}

/// **Proves:** ca_fingerprint fails when no CA exists on disk.
/// **Anti-fake:** A function that returns a dummy fingerprint would not fail.
#[test]
fn ca_fingerprint_fails_without_ca() {
    let tmp = TempDir::new().unwrap();
    let empty_dir = tmp.path().to_path_buf();

    let result = ca_fingerprint(&empty_dir);
    assert!(
        result.is_err(),
        "ca_fingerprint must fail when no CA certificate exists"
    );
}

// ===========================================================================
// Section 6: E2E Deliverable Tests (4 tests)
// ===========================================================================

/// **Proves:** The full "recondo init" flow: ensure_ca generates a CA, then
/// build_install_commands returns non-empty OS-specific trust store commands.
/// This validates deliverables 1 + 4 together.
/// **Anti-fake:** Each step depends on the previous one's real output.
#[test]
fn e2e_init_generates_ca_and_builds_trust_store_commands() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    // Step 1: Generate CA (deliverable 1)
    tls::ensure_ca(&data_dir).expect("ensure_ca must succeed");

    let ca_cert_path = data_dir.join("ca").join("ca.crt");
    assert!(ca_cert_path.exists(), "CA cert must exist after ensure_ca");

    // Step 2: Build trust store commands (deliverable 4)
    let commands = build_install_commands(&ca_cert_path, Platform::MacOS);
    assert!(
        !commands.is_empty(),
        "Trust store commands must not be empty after CA generation"
    );

    // Verify the commands reference the actual CA cert path
    let joined = commands.join(" ");
    assert!(
        joined.contains(ca_cert_path.to_str().unwrap()),
        "Commands must reference the generated CA cert path"
    );
}

/// **Proves:** A leaf cert generated via CertCache can be verified against the CA.
/// This tests deliverable 3 (cert cache) with actual cryptographic verification.
/// **Anti-fake:** A cert signed by a different key or self-signed would not parse
/// as issued by the CA.
#[test]
fn e2e_leaf_cert_from_cache_verifies_against_ca() {
    let (_tmp, data_dir) = setup_ca();
    let cache = CertCache::new(&data_dir, 100).unwrap();

    let leaf = cache.get_or_generate("api.anthropic.com").unwrap();

    // Read the CA cert PEM
    let ca_pem = std::fs::read_to_string(data_dir.join("ca").join("ca.crt")).unwrap();

    // Both must be valid PEM
    assert!(
        ca_pem.contains("-----BEGIN CERTIFICATE-----"),
        "CA must be valid PEM"
    );
    assert!(
        leaf.cert_pem().contains("-----BEGIN CERTIFICATE-----"),
        "Leaf must be valid PEM"
    );

    // Parse both with rcgen's x509-parser feature to verify the chain.
    // The leaf's issuer DN should match the CA's subject DN.
    let ca_der = rustls_pemfile::certs(&mut ca_pem.as_bytes())
        .next()
        .expect("CA PEM must contain at least one cert")
        .expect("CA cert must parse");

    let leaf_pem = leaf.cert_pem();
    let leaf_der = rustls_pemfile::certs(&mut leaf_pem.as_bytes())
        .next()
        .expect("Leaf PEM must contain at least one cert")
        .expect("Leaf cert must parse");

    // Verify they are different certs (leaf != CA)
    assert_ne!(
        ca_der.as_ref(),
        leaf_der.as_ref(),
        "Leaf cert must be different from CA cert"
    );

    // Use webpki to verify the leaf is signed by the CA
    recondo_gateway::ensure_crypto_provider();
    let ca_cert_der = rustls::pki_types::CertificateDer::from(ca_der.to_vec());
    let mut root_store = rustls::RootCertStore::empty();
    root_store
        .add(ca_cert_der)
        .expect("Must add CA to root store");

    // Build a server cert verifier using the CA as the trust anchor
    let verifier = rustls::client::WebPkiServerVerifier::builder(std::sync::Arc::new(root_store))
        .build()
        .expect("Must build verifier");

    // The leaf cert should verify against our CA
    let leaf_cert_der = rustls::pki_types::CertificateDer::from(leaf_der.to_vec());
    let server_name = rustls::pki_types::ServerName::try_from("api.anthropic.com")
        .expect("Must parse server name");

    let verify_result = verifier.verify_server_cert(
        &leaf_cert_der,
        &[],
        &server_name,
        &[],
        rustls::pki_types::UnixTime::now(),
    );

    assert!(
        verify_result.is_ok(),
        "Leaf cert from cache must verify against the CA: {:?}",
        verify_result.err()
    );
}

/// **Proves:** The cert cache can generate valid certs for all known LLM providers.
/// This validates deliverable 3 breadth — the cache handles real-world hostnames.
/// **Anti-fake:** A cache that only handles one host pattern would fail on others.
#[test]
fn e2e_cert_cache_serves_all_known_providers() {
    let (_tmp, data_dir) = setup_ca();
    let cache = CertCache::new(&data_dir, 100).unwrap();

    let providers = [
        "api.anthropic.com",
        "api.openai.com",
        "generativelanguage.googleapis.com",
        "chatgpt.com",
    ];

    for host in &providers {
        let leaf = cache
            .get_or_generate(host)
            .unwrap_or_else(|e| panic!("Must generate cert for {}: {:?}", host, e));

        assert!(
            leaf.cert_pem().contains("-----BEGIN CERTIFICATE-----"),
            "Cert for {} must be valid PEM",
            host
        );
        assert!(
            leaf.key_pem().contains("PRIVATE KEY"),
            "Key for {} must be valid PEM",
            host
        );
    }

    assert_eq!(
        cache.len(),
        4,
        "Cache must have 4 entries — one per provider"
    );
}

/// **Proves:** A TurnRecord with integrity_verified=Some(true) can be inserted
/// and queried back with the field intact. This is the end-to-end DB deliverable test.
/// **Anti-fake:** If TurnRecord doesn't have the field, this won't compile.
/// If the DB doesn't store/retrieve it, the assertion fails.
#[test]
fn e2e_integrity_field_in_turn_record() {
    let conn = setup_db();
    db::insert_session(&conn, &sample_session("sess_e2e_iv")).unwrap();

    let mut turn = sample_turn("turn_e2e_iv", "sess_e2e_iv", 1);
    turn.integrity_verified = Some(true);

    db::insert_turn(&conn, &turn).unwrap();

    // Query back using get_turn (single turn lookup)
    let retrieved = db::get_turn(&conn, "turn_e2e_iv")
        .unwrap()
        .expect("Turn must be retrievable by ID");

    assert_eq!(retrieved.id, "turn_e2e_iv");
    assert_eq!(
        retrieved.integrity_verified,
        Some(true),
        "integrity_verified must survive full DB roundtrip"
    );

    // Also verify via get_turns_for_session
    let turns = db::get_turns_for_session(&conn, "sess_e2e_iv").unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(
        turns[0].integrity_verified,
        Some(true),
        "integrity_verified must survive session-based query too"
    );
}

// ===========================================================================
// Section 7: Migration Tests (1 test)
// ===========================================================================

/// **Proves:** A v2 schema (user_version=2) gains the integrity_verified
/// column after db::initialize() upgrades it to v3.
/// **Anti-fake:** If the migration doesn't run or doesn't add the column, the
/// PRAGMA table_info check will fail.
#[test]
fn v2_to_v3_migration_adds_integrity_verified() {
    // Step 1: Create a v2-era database manually.
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA busy_timeout = 5000;",
    )
    .unwrap();

    // Create tables WITHOUT integrity_verified (v2 schema).
    conn.execute_batch(
        "CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            model TEXT,
            started_at TEXT NOT NULL,
            last_active_at TEXT NOT NULL,
            ended_at TEXT,
            initial_intent TEXT,
            system_prompt_hash TEXT NOT NULL,
            total_turns INTEGER NOT NULL DEFAULT 0,
            turns_captured INTEGER NOT NULL DEFAULT 0,
            dropped_events INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            total_cost_usd REAL NOT NULL DEFAULT 0.0,
            framework TEXT
        );

        CREATE TABLE turns (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id),
            sequence_num INTEGER NOT NULL,
            timestamp TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            response_hash TEXT NOT NULL,
            req_bytes_ref TEXT,
            resp_bytes_ref TEXT,
            req_bytes_size INTEGER,
            resp_bytes_size INTEGER,
            model TEXT,
            response_text TEXT,
            thinking_text TEXT,
            stop_reason TEXT NOT NULL,
            capture_complete INTEGER NOT NULL DEFAULT 1,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            cache_read_tokens INTEGER NOT NULL,
            cache_creation_tokens INTEGER NOT NULL,
            cost_usd REAL,
            created_at TEXT NOT NULL,
            messages_delta TEXT,
            messages_delta_count INTEGER,
            raw_extra TEXT,
            parser_version TEXT,
            parse_errors TEXT,
            provider TEXT,
            transport TEXT,
            ws_direction TEXT,
            UNIQUE(session_id, sequence_num)
        );

        CREATE TABLE tool_calls (
            id TEXT PRIMARY KEY,
            turn_id TEXT NOT NULL REFERENCES turns(id),
            tool_name TEXT NOT NULL,
            tool_input TEXT NOT NULL,
            input_hash TEXT
        );

        PRAGMA user_version = 2;",
    )
    .unwrap();

    // Verify integrity_verified does NOT exist yet.
    let cols_before: Vec<String> = conn
        .prepare("PRAGMA table_info(turns)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(
        !cols_before.contains(&"integrity_verified".to_string()),
        "v2 schema must not have integrity_verified column"
    );

    // Step 2: Run initialize (which runs the v2->v3 migration).
    db::initialize(&conn).expect("initialize must succeed on v2 schema");

    // Step 3: Verify integrity_verified column now exists.
    let cols_after: Vec<String> = conn
        .prepare("PRAGMA table_info(turns)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(
        cols_after.contains(&"integrity_verified".to_string()),
        "After v2->v3 migration, turns must have integrity_verified column, found: {:?}",
        cols_after
    );

    // Step 4: Verify user_version is now 3.
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert!(
        version >= 3,
        "user_version must be >= 3 after migration, got {}",
        version
    );
}
