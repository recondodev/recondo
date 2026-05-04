//! Tests for TLS certificate generation.
//!
//! These tests verify that the TLS module can generate a CA certificate on first run
//! and generate per-host leaf certificates signed by that CA.

use std::fs;
use tempfile::TempDir;

// W7 fix: serial_test ensures env-var-mutating tests run one at a time.
use serial_test::serial;

use recondo_gateway::gateway;
use recondo_gateway::tls;

/// **Proves:** Generating a CA produces a certificate file and a key file in the ca/ directory.
/// **Anti-fake property:** Checks that specific files exist on disk — not just that
/// the function returns Ok.
#[test]
fn generate_ca_creates_cert_and_key_files() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    tls::ensure_ca(&data_dir).expect("CA generation must succeed");

    let ca_dir = data_dir.join("ca");
    assert!(ca_dir.exists(), "ca/ directory must exist");

    let cert_path = ca_dir.join("ca.crt");
    let key_path = ca_dir.join("ca.key");

    assert!(cert_path.exists(), "CA certificate must exist at ca/ca.crt");
    assert!(key_path.exists(), "CA private key must exist at ca/ca.key");

    // Files must not be empty
    let cert_bytes = fs::read(&cert_path).unwrap();
    let key_bytes = fs::read(&key_path).unwrap();
    assert!(
        !cert_bytes.is_empty(),
        "CA certificate file must not be empty"
    );
    assert!(!key_bytes.is_empty(), "CA key file must not be empty");
}

/// **Proves:** Calling ensure_ca twice is idempotent — it reuses existing CA files
/// rather than overwriting them.
/// **Anti-fake property:** The cert bytes after the second call must be identical
/// to the first — regenerating would produce different keys.
#[test]
fn ensure_ca_is_idempotent() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    tls::ensure_ca(&data_dir).unwrap();

    let cert_bytes_1 = fs::read(data_dir.join("ca").join("ca.crt")).unwrap();
    let key_bytes_1 = fs::read(data_dir.join("ca").join("ca.key")).unwrap();

    tls::ensure_ca(&data_dir).unwrap();

    let cert_bytes_2 = fs::read(data_dir.join("ca").join("ca.crt")).unwrap();
    let key_bytes_2 = fs::read(data_dir.join("ca").join("ca.key")).unwrap();

    assert_eq!(
        cert_bytes_1, cert_bytes_2,
        "CA certificate must not change on second call"
    );
    assert_eq!(
        key_bytes_1, key_bytes_2,
        "CA key must not change on second call"
    );
}

/// **Proves:** The CA certificate file is PEM-encoded (starts with -----BEGIN CERTIFICATE-----).
/// **Anti-fake property:** DER-encoded or random bytes would fail this check.
#[test]
fn ca_certificate_is_pem_encoded() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    tls::ensure_ca(&data_dir).unwrap();

    let cert_pem = fs::read_to_string(data_dir.join("ca").join("ca.crt")).unwrap();
    assert!(
        cert_pem.contains("-----BEGIN CERTIFICATE-----"),
        "CA cert must be PEM-encoded and contain BEGIN CERTIFICATE marker"
    );
    assert!(
        cert_pem.contains("-----END CERTIFICATE-----"),
        "CA cert must be PEM-encoded and contain END CERTIFICATE marker"
    );
}

/// **Proves:** The CA key file is PEM-encoded.
/// **Anti-fake property:** Must contain a PEM private key marker.
#[test]
fn ca_key_is_pem_encoded() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    tls::ensure_ca(&data_dir).unwrap();

    let key_pem = fs::read_to_string(data_dir.join("ca").join("ca.key")).unwrap();
    // Could be PRIVATE KEY or RSA PRIVATE KEY or EC PRIVATE KEY
    assert!(
        key_pem.contains("-----BEGIN") && key_pem.contains("PRIVATE KEY-----"),
        "CA key must be PEM-encoded and contain PRIVATE KEY marker"
    );
}

/// **Proves:** A per-host leaf certificate can be generated for api.anthropic.com.
/// **Anti-fake property:** The returned certificate must be valid PEM and different
/// from the CA certificate.
#[test]
fn generate_leaf_cert_for_host() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    tls::ensure_ca(&data_dir).unwrap();

    let leaf = tls::generate_leaf_cert(&data_dir, "api.anthropic.com")
        .expect("Leaf cert generation must succeed");

    // The leaf must contain certificate and key material
    // We check that the returned struct has both cert and key
    let cert_pem = leaf.cert_pem();
    let key_pem = leaf.key_pem();

    assert!(
        cert_pem.contains("-----BEGIN CERTIFICATE-----"),
        "Leaf cert must be PEM-encoded"
    );
    assert!(
        key_pem.contains("-----BEGIN") && key_pem.contains("PRIVATE KEY-----"),
        "Leaf key must be PEM-encoded"
    );

    // Leaf cert must be different from CA cert
    let ca_cert = fs::read_to_string(data_dir.join("ca").join("ca.crt")).unwrap();
    assert_ne!(
        cert_pem, ca_cert,
        "Leaf certificate must be different from CA certificate"
    );
}

/// **Proves:** Leaf certs for different hosts are different.
/// **Anti-fake property:** A function that always returns the same cert would fail.
#[test]
fn different_hosts_get_different_leaf_certs() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    tls::ensure_ca(&data_dir).unwrap();

    let leaf1 = tls::generate_leaf_cert(&data_dir, "api.anthropic.com").unwrap();
    let leaf2 = tls::generate_leaf_cert(&data_dir, "api.openai.com").unwrap();

    assert_ne!(
        leaf1.cert_pem(),
        leaf2.cert_pem(),
        "Different hosts must get different leaf certificates"
    );
}

// ===========================================================================
// Extra CA certificate loading (corporate TLS inspection support)
// ===========================================================================

/// **Proves:** When extra_roots.pem exists in {data_dir}/ca/, the gateway loads those
/// certificates into its upstream TLS root store. This is required for environments
/// behind corporate TLS inspection firewalls that re-sign upstream certificates.
///
/// **Anti-fake property:** Without loading the extra CAs, a rustls client configured
/// with only webpki_roots would reject certificates signed by the corporate CA.
/// This test creates a self-signed CA, writes it to extra_roots.pem, and verifies
/// that the root store count increases after loading.
#[test]
fn extra_ca_certs_loaded_from_data_dir() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    // Create the ca/ directory and write a PEM cert as extra_roots.pem
    let ca_dir = data_dir.join("ca");
    fs::create_dir_all(&ca_dir).unwrap();

    // Generate a self-signed cert to use as the "corporate CA"
    let corporate_ca =
        rcgen::generate_simple_self_signed(vec!["Corporate CA".to_string()]).unwrap();
    let corporate_pem = corporate_ca.cert.pem();
    fs::write(ca_dir.join("extra_roots.pem"), &corporate_pem).unwrap();

    // Build a root store with only webpki roots
    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let count_before = root_store.len();

    // Load extra certs
    recondo_gateway::gateway::load_extra_ca_certs(&mut root_store, &data_dir);

    let count_after = root_store.len();
    assert!(
        count_after > count_before,
        "Root store must have more certs after loading extra_roots.pem (before={}, after={})",
        count_before,
        count_after
    );
}

/// **Proves:** When no extra_roots.pem exists, load_extra_ca_certs is a no-op.
/// The root store is unchanged.
#[test]
fn no_extra_ca_certs_file_is_noop() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let count_before = root_store.len();

    recondo_gateway::gateway::load_extra_ca_certs(&mut root_store, &data_dir);

    assert_eq!(
        root_store.len(),
        count_before,
        "Root store must be unchanged when no extra CA file exists"
    );
}

/// **Proves:** Extra CA certs can also be loaded via RECONDO_EXTRA_CA_CERTS env var.
#[test]
#[serial]
fn extra_ca_certs_loaded_from_env_var() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    // Write the PEM cert to a custom location (not in data_dir/ca/)
    let custom_path = tmp.path().join("corporate_ca.pem");
    let corporate_ca = rcgen::generate_simple_self_signed(vec!["Corp CA".to_string()]).unwrap();
    fs::write(&custom_path, corporate_ca.cert.pem()).unwrap();

    // Set the env var
    std::env::set_var("RECONDO_EXTRA_CA_CERTS", custom_path.to_str().unwrap());

    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let count_before = root_store.len();

    recondo_gateway::gateway::load_extra_ca_certs(&mut root_store, &data_dir);

    let count_after = root_store.len();
    assert!(
        count_after > count_before,
        "Root store must grow when RECONDO_EXTRA_CA_CERTS points to a valid PEM"
    );

    // Clean up env var
    std::env::remove_var("RECONDO_EXTRA_CA_CERTS");
}

/// **Proves:** Any .pem or .crt file in {data_dir}/ca/ is auto-loaded,
/// not just extra_roots.pem. Drop a corporate CA as "corporate.pem" and it works.
/// Also verifies that ca.crt and ca.key are skipped (they're the proxy's own CA).
#[test]
fn any_pem_file_in_ca_dir_is_loaded() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let ca_dir = data_dir.join("ca");
    fs::create_dir_all(&ca_dir).unwrap();

    // Write the proxy's own CA files (should be skipped)
    fs::write(
        ca_dir.join("ca.crt"),
        "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n",
    )
    .unwrap();
    fs::write(ca_dir.join("ca.key"), "fake key").unwrap();

    // Write two corporate CAs with different names
    let corp1 = rcgen::generate_simple_self_signed(vec!["Corp One".to_string()]).unwrap();
    let corp2 = rcgen::generate_simple_self_signed(vec!["Corp Two".to_string()]).unwrap();
    fs::write(ca_dir.join("corporate.pem"), corp1.cert.pem()).unwrap();
    fs::write(ca_dir.join("another-ca.crt"), corp2.cert.pem()).unwrap();

    // Write a non-PEM file that should be ignored
    fs::write(ca_dir.join("readme.txt"), "not a cert").unwrap();

    let mut root_store = rustls::RootCertStore::empty();
    let count_before = root_store.len();

    gateway::load_extra_ca_certs(&mut root_store, &data_dir);

    // Should have loaded exactly 2 certs (corporate.pem + another-ca.crt)
    // ca.crt is skipped, ca.key is skipped, readme.txt is skipped
    assert_eq!(
        root_store.len(),
        count_before + 2,
        "Must load exactly 2 extra certs (corporate.pem + another-ca.crt), skipping ca.crt/ca.key/readme.txt"
    );
}
