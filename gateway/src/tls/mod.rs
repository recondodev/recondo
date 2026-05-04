pub mod trust_store;

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use ::time::{Duration, OffsetDateTime};
use anyhow::{bail, Context, Result};
use lru::LruCache;
use rcgen::{
    BasicConstraints, Certificate, CertificateParams, DistinguishedName, DnType,
    ExtendedKeyUsagePurpose, IsCa, KeyPair, KeyUsagePurpose, SanType,
};
use sha2::{Digest, Sha256};

/// A leaf certificate and its private key, both PEM-encoded.
///
/// Uses `Arc<str>` instead of `String` so that cloning a `LeafCert` shares
/// the underlying byte buffers rather than duplicating key material in memory.
#[derive(Clone)]
pub struct LeafCert {
    cert_pem: Arc<str>,
    key_pem: Arc<str>,
}

impl LeafCert {
    /// Returns the PEM-encoded certificate.
    pub fn cert_pem(&self) -> &str {
        &self.cert_pem
    }

    /// Returns the PEM-encoded private key.
    pub fn key_pem(&self) -> &str {
        &self.key_pem
    }
}

/// Ensure a CA certificate and key exist at `{data_dir}/ca/ca.crt` and `ca.key`.
///
/// Idempotent: if both files already exist, this is a no-op.
/// Errors if only one file exists (inconsistent state).
pub fn ensure_ca(data_dir: &Path) -> Result<()> {
    let ca_dir = data_dir.join("ca");
    let cert_path = ca_dir.join("ca.crt");
    let key_path = ca_dir.join("ca.key");

    // Idempotent: reuse existing CA files
    if cert_path.exists() && key_path.exists() {
        return Ok(());
    }

    fs::create_dir_all(&ca_dir).context("Failed to create ca/ directory")?;

    // Restrict CA directory before writing any key material.
    //
    // NOTE (Windows): Permission enforcement is only implemented for Unix.
    // On Windows, the ca/ directory and ca.key file are created with default
    // ACLs, which may be world-readable. For production Windows deployments,
    // consider using the `windows-acl` crate to restrict access to the CA
    // private key material, or store it in a Windows certificate store.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&ca_dir, fs::Permissions::from_mode(0o700))
            .context("Failed to set ca/ directory permissions")?;
    }

    // Use a separate lock file for the race guard so a crash never leaves
    // ca.key in a broken (empty) state.
    //
    // NOTE: This lock uses `create_new` (O_EXCL) which is not released on
    // SIGKILL — a hard kill leaves the lock file on disk, blocking future
    // CA generation. Recovery: delete `{data_dir}/ca/.ca.lock` manually.
    // The error message below already instructs users to do so. A more
    // robust approach (flock/advisory locks) is a future improvement.
    let lock_path = ca_dir.join(".ca.lock");
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
    {
        Ok(_lock_file) => {
            let tmp_key = ca_dir.join(".ca.key.tmp");
            let tmp_cert = ca_dir.join(".ca.crt.tmp");

            // Generate CA inside a closure; clean up lock + temp files on error.
            let result = (|| -> Result<()> {
                let mut params = CertificateParams::default();
                let mut dn = DistinguishedName::new();
                dn.push(DnType::CommonName, "Recondo Proxy CA");
                dn.push(DnType::OrganizationName, "Recondo");
                params.distinguished_name = dn;
                params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
                params.key_usages.push(KeyUsagePurpose::KeyCertSign);
                params.key_usages.push(KeyUsagePurpose::CrlSign);
                let now = OffsetDateTime::now_utc();
                params.not_before = now;
                params.not_after = now + Duration::days(3650);

                let key_pair = KeyPair::generate().context("Failed to generate CA key pair")?;
                let cert = params
                    .self_signed(&key_pair)
                    .context("Failed to self-sign CA certificate")?;

                // Write to temp files, then rename atomically.
                fs::write(&tmp_key, key_pair.serialize_pem()).context("Failed to write ca.key")?;
                fs::write(&tmp_cert, cert.pem()).context("Failed to write ca.crt")?;

                // See NOTE (Windows) above regarding missing Windows ACL enforcement.
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&tmp_key, fs::Permissions::from_mode(0o600))
                        .context("Failed to set ca.key permissions")?;
                }

                fs::rename(&tmp_key, &key_path).context("Failed to finalize ca.key")?;
                fs::rename(&tmp_cert, &cert_path).context("Failed to finalize ca.crt")?;
                Ok(())
            })();

            // Always clean up lock + temp files, even on error.
            let _ = fs::remove_file(&lock_path);
            let _ = fs::remove_file(&tmp_key);
            let _ = fs::remove_file(&tmp_cert);

            result?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // Another process is generating the CA. Wait briefly for it to finish.
            for _ in 0..10 {
                if cert_path.exists() && key_path.exists() {
                    return Ok(());
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            bail!(
                "CA generation by another process did not complete within 5 seconds. \
                 If stuck, delete {} and retry.",
                lock_path.display()
            );
        }
        Err(e) => return Err(anyhow::Error::from(e).context("Failed to create CA lock file")),
    }

    Ok(())
}

/// Generate a leaf certificate for the given host, signed by the CA.
///
/// The CA must already exist (call `ensure_ca` first).
///
/// **Prefer `CertCache::get_or_generate`** for the production hot path.
/// This standalone function reads the CA from disk on every call and is
/// kept for backward compatibility (tests, CLI, `build_server_config`
/// without a cache). The production gateway uses `CertCache` (see B1 fix).
pub fn generate_leaf_cert(data_dir: &Path, host: &str) -> Result<LeafCert> {
    let ca_dir = data_dir.join("ca");
    let ca_cert_pem = fs::read_to_string(ca_dir.join("ca.crt"))
        .context("Failed to read CA certificate. Did you call ensure_ca first?")?;
    let ca_key_pem = fs::read_to_string(ca_dir.join("ca.key")).context("Failed to read CA key")?;

    // Reconstruct CA from stored PEM to sign the leaf cert.
    // from_ca_cert_pem extracts the original params (DN, extensions, serial);
    // self_signed re-creates a cert object with the same key — needed by rcgen's
    // signed_by API. The leaf chain verifies because the same key pair signs both.
    let ca_key_pair = KeyPair::from_pem(&ca_key_pem).context("Failed to parse CA key pair")?;
    let ca_params = CertificateParams::from_ca_cert_pem(&ca_cert_pem)
        .context("Failed to parse CA certificate params")?;
    let ca_cert = ca_params
        .self_signed(&ca_key_pair)
        .context("Failed to reconstruct CA certificate")?;

    let mut leaf_params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, host);
    leaf_params.distinguished_name = dn;
    leaf_params.subject_alt_names = vec![SanType::DnsName(host.try_into()?)];
    leaf_params.is_ca = IsCa::NoCa;
    leaf_params
        .extended_key_usages
        .push(ExtendedKeyUsagePurpose::ServerAuth);
    leaf_params
        .key_usages
        .push(KeyUsagePurpose::DigitalSignature);
    // Leaf certs short-lived: 24 hours
    let now = OffsetDateTime::now_utc();
    leaf_params.not_before = now;
    leaf_params.not_after = now + Duration::hours(24);

    let leaf_key = KeyPair::generate().context("Failed to generate leaf key pair")?;
    let leaf_cert = leaf_params
        .signed_by(&leaf_key, &ca_cert, &ca_key_pair)
        .context("Failed to sign leaf certificate")?;

    Ok(LeafCert {
        cert_pem: Arc::from(leaf_cert.pem().as_str()),
        key_pem: Arc::from(leaf_key.serialize_pem().as_str()),
    })
}

// ===========================================================================
// CA Info Functions
// ===========================================================================

/// Read the CA certificate PEM from disk and decode the first certificate's DER bytes.
fn read_ca_der(data_dir: &Path) -> Result<Vec<u8>> {
    let ca_cert_path = data_dir.join("ca").join("ca.crt");
    let pem_data =
        fs::read_to_string(&ca_cert_path).context("Failed to read CA certificate PEM")?;

    let pem_obj = ::pem::parse(&pem_data).context("Failed to parse CA PEM")?;
    Ok(pem_obj.contents().to_vec())
}

/// Compute the SHA-256 fingerprint of the CA certificate (DER-encoded).
///
/// Returns a 64-character lowercase hex string.
pub fn ca_fingerprint(data_dir: &Path) -> Result<String> {
    let der = read_ca_der(data_dir)?;
    let hash = Sha256::digest(&der);
    Ok(hex::encode(hash))
}

/// Extract the subject DN string from the CA certificate.
pub fn ca_subject(data_dir: &Path) -> Result<String> {
    let der = read_ca_der(data_dir)?;
    let (_, cert) =
        x509_parser::parse_x509_certificate(&der).map_err(|e| anyhow::anyhow!("{}", e))?;
    Ok(cert.subject().to_string())
}

/// Extract the validity period (not_before, not_after) from the CA certificate.
///
/// Returns ISO-8601 formatted date strings (e.g., "2026-03-19T10:00:00Z").
pub fn ca_validity(data_dir: &Path) -> Result<(String, String)> {
    let der = read_ca_der(data_dir)?;
    let (_, cert) =
        x509_parser::parse_x509_certificate(&der).map_err(|e| anyhow::anyhow!("{}", e))?;

    let nb = cert.validity().not_before.to_datetime();
    let na = cert.validity().not_after.to_datetime();

    let fmt = &time::format_description::well_known::Rfc3339;
    let nb_str = nb
        .format(fmt)
        .map_err(|e| anyhow::anyhow!("Failed to format not_before: {}", e))?;
    let na_str = na
        .format(fmt)
        .map_err(|e| anyhow::anyhow!("Failed to format not_after: {}", e))?;

    Ok((nb_str, na_str))
}

// ===========================================================================
// Cert Cache
// ===========================================================================

/// Cached entry holding a leaf cert and the time it was generated.
struct CachedEntry {
    leaf: LeafCert,
    created_at: Instant,
}

/// Thread-safe LRU cache for leaf certificates, keyed by hostname.
///
/// Loads the CA cert + key once on construction and reuses them for all
/// subsequent leaf cert generations, avoiding repeated filesystem I/O.
pub struct CertCache {
    // SECURITY NOTE: CA key held in memory without zeroization. For production,
    // use the `zeroize` crate to clear key material from memory when CertCache
    // is dropped. This is a known Phase 2 trade-off — acceptable for dev/staging
    // environments where the process memory is not shared with untrusted code.
    ca_key_pair: KeyPair,
    ca_cert: Certificate,
    /// CA cert PEM cached in memory to avoid re-reading from disk on every connection.
    ca_cert_pem: Arc<str>,
    cache: Mutex<LruCache<String, CachedEntry>>,
    /// Maximum age before a cached cert is considered expired (12 hours).
    max_age: std::time::Duration,
    // NOTE: Under high concurrency for the same uncached host, multiple threads
    // may each generate a cert in Phase 2 (only one is kept). This is an acceptable
    // trade-off — per-host locking would add complexity for minimal benefit since
    // cert generation is ~ms and this only happens on the first request per host.
}

impl CertCache {
    /// Create a new CertCache, loading the CA cert and key from `{data_dir}/ca/`.
    ///
    /// Returns an error if the CA files do not exist on disk.
    pub fn new(data_dir: &Path, max_entries: usize) -> Result<Self> {
        let ca_dir = data_dir.join("ca");
        let ca_cert_pem = fs::read_to_string(ca_dir.join("ca.crt"))
            .context("Failed to read CA certificate. Does the CA exist?")?;
        let ca_key_pem =
            fs::read_to_string(ca_dir.join("ca.key")).context("Failed to read CA key")?;

        let ca_key_pair = KeyPair::from_pem(&ca_key_pem).context("Failed to parse CA key pair")?;
        let ca_params = CertificateParams::from_ca_cert_pem(&ca_cert_pem)
            .context("Failed to parse CA certificate params")?;
        let ca_cert = ca_params
            .self_signed(&ca_key_pair)
            .context("Failed to reconstruct CA certificate")?;

        if max_entries == 0 {
            bail!("CertCache max_entries must be > 0");
        }
        let cap =
            std::num::NonZeroUsize::new(max_entries).expect("max_entries already validated > 0");

        Ok(Self {
            ca_key_pair,
            ca_cert,
            ca_cert_pem: Arc::from(ca_cert_pem.as_str()),
            cache: Mutex::new(LruCache::new(cap)),
            max_age: std::time::Duration::from_secs(12 * 3600),
        })
    }

    /// Get a cached leaf cert for the host, or generate a new one if not cached or expired.
    ///
    /// Uses a two-phase approach to avoid holding the mutex during key generation:
    /// 1. Acquire lock, check cache -- return on hit, release on miss.
    /// 2. Generate cert WITHOUT the lock held.
    /// 3. Re-acquire lock, insert (with double-check for concurrent generation).
    ///
    /// Returns an error if the hostname is empty.
    pub fn get_or_generate(&self, host: &str) -> Result<LeafCert> {
        if host.is_empty() {
            bail!("Hostname must not be empty");
        }

        // Phase 1: Check cache with lock held briefly.
        {
            let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = cache.get(host) {
                if entry.created_at.elapsed() < self.max_age {
                    return Ok(entry.leaf.clone());
                }
            }
        } // Lock released here before key generation.

        // Phase 2: Generate cert WITHOUT the lock held.
        let leaf = self.generate_leaf(host)?;

        // Phase 3: Re-acquire lock and insert. Double-check in case another
        // thread generated a cert for the same host while we were generating.
        {
            let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = cache.get(host) {
                if entry.created_at.elapsed() < self.max_age {
                    // Another thread already inserted a fresh cert -- use theirs.
                    return Ok(entry.leaf.clone());
                }
            }
            cache.put(
                host.to_string(),
                CachedEntry {
                    leaf: leaf.clone(),
                    created_at: Instant::now(),
                },
            );
        }

        Ok(leaf)
    }

    /// Number of entries currently in the cache.
    pub fn len(&self) -> usize {
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// Returns true if the cache is empty.
    pub fn is_empty(&self) -> bool {
        self.cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    }

    /// Returns the cached CA certificate PEM (avoids re-reading from disk).
    pub fn ca_cert_pem(&self) -> &str {
        &self.ca_cert_pem
    }

    /// Check if a host is currently in the cache.
    pub fn contains(&self, host: &str) -> bool {
        self.cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(host)
    }

    /// Generate a leaf cert signed by the cached CA.
    fn generate_leaf(&self, host: &str) -> Result<LeafCert> {
        let mut leaf_params = CertificateParams::default();
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, host);
        leaf_params.distinguished_name = dn;
        leaf_params.subject_alt_names = vec![SanType::DnsName(host.try_into()?)];
        leaf_params.is_ca = IsCa::NoCa;
        leaf_params
            .extended_key_usages
            .push(ExtendedKeyUsagePurpose::ServerAuth);
        leaf_params
            .key_usages
            .push(KeyUsagePurpose::DigitalSignature);
        let now = OffsetDateTime::now_utc();
        leaf_params.not_before = now;
        leaf_params.not_after = now + Duration::hours(24);

        let leaf_key = KeyPair::generate().context("Failed to generate leaf key pair")?;
        let leaf_cert = leaf_params
            .signed_by(&leaf_key, &self.ca_cert, &self.ca_key_pair)
            .context("Failed to sign leaf certificate")?;

        Ok(LeafCert {
            cert_pem: Arc::from(leaf_cert.pem().as_str()),
            key_pem: Arc::from(leaf_key.serialize_pem().as_str()),
        })
    }
}
