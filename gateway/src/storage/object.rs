//! Object store trait and implementations.
//!
//! Objects are raw request/response bytes stored content-addressably by their
//! SHA-256 hash. The `ObjectStore` trait abstracts over the storage backend.

use std::fs;
use std::io::Read as IoRead;
use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use flate2::read::GzDecoder;

use crate::hash;

/// Validate that a path component contains only safe characters:
/// alphanumeric, hyphens, and underscores. Rejects `/`, `\`, `..`,
/// and any other path separator to prevent path traversal attacks.
fn validate_path_component(value: &str, label: &str) -> Result<()> {
    if value.is_empty() {
        bail!("{} must not be empty", label);
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        bail!(
            "{} contains invalid characters (must be alphanumeric, hyphens, or underscores): {:?}",
            label,
            value
        );
    }
    Ok(())
}

/// Trait for content-addressable object storage.
pub trait ObjectStore: Send + Sync {
    /// Store data under the given kind (e.g., "req", "resp") and hash.
    /// Returns a reference key string (typically `{kind}/{hash}.json.gz`).
    fn put(&self, kind: &str, hash: &str, data: &[u8]) -> Result<String>;

    /// Retrieve data by kind and hash. Returns the decompressed bytes.
    fn get(&self, kind: &str, hash: &str) -> Result<Vec<u8>>;

    /// Check if an object exists.
    fn exists(&self, kind: &str, hash: &str) -> Result<bool>;

    /// Verify integrity: read, decompress, re-hash, compare.
    /// Returns false (not Err) for corrupted data.
    fn verify(&self, kind: &str, hash: &str) -> Result<bool>;

    /// FIND-3-RUST-3: Delete an object by kind and hash. Used for
    /// best-effort orphan cleanup when an attachment bundle's row-write
    /// AND DLQ-write both fail — the object would otherwise be stranded
    /// in the store with no reference (GDPR concern). Returns Ok(()) if
    /// the object did not exist (idempotent).
    fn delete(&self, kind: &str, hash: &str) -> Result<()>;
}

/// Local filesystem object store.
pub struct LocalObjectStore {
    data_dir: PathBuf,
}

impl LocalObjectStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            data_dir: data_dir.to_path_buf(),
        }
    }

    fn object_path(&self, kind: &str, hash: &str) -> Result<PathBuf> {
        validate_path_component(kind, "kind")?;
        validate_path_component(hash, "hash")?;
        Ok(self
            .data_dir
            .join("objects")
            .join(kind)
            .join(format!("{}.json.gz", hash)))
    }
}

impl ObjectStore for LocalObjectStore {
    fn put(&self, kind: &str, hash: &str, data: &[u8]) -> Result<String> {
        // Validate path components before delegating to prevent path traversal.
        validate_path_component(kind, "kind")?;
        validate_path_component(hash, "hash")?;

        // Delegate to the canonical store::store_object implementation to ensure
        // a single atomic write pattern (temp file + rename with create_new).
        // store_object computes the hash internally, but the caller already
        // provides the hash. We verify they match after the write.
        let computed_hash = crate::store::store_object(&self.data_dir, kind, data)?;
        if computed_hash != hash {
            bail!(
                "Caller-provided hash does not match computed hash: expected {}, got {}",
                hash,
                computed_hash
            );
        }

        let ref_key = format!("{}/{}.json.gz", kind, computed_hash);
        Ok(ref_key)
    }

    fn get(&self, kind: &str, hash: &str) -> Result<Vec<u8>> {
        let file_path = self.object_path(kind, hash)?;
        if !file_path.exists() {
            bail!("Object not found: {}/{}", kind, hash);
        }

        let compressed = fs::read(&file_path)?;
        let mut decoder = GzDecoder::new(&compressed[..]);
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed)?;
        Ok(decompressed)
    }

    fn exists(&self, kind: &str, hash: &str) -> Result<bool> {
        let file_path = self.object_path(kind, hash)?;
        Ok(file_path.exists())
    }

    fn verify(&self, kind: &str, hash: &str) -> Result<bool> {
        let file_path = self.object_path(kind, hash)?;
        if !file_path.exists() {
            return Ok(false);
        }

        let compressed = fs::read(&file_path)?;
        let mut decoder = GzDecoder::new(&compressed[..]);
        let mut decompressed = Vec::new();
        match decoder.read_to_end(&mut decompressed) {
            Ok(_) => {}
            Err(_) => return Ok(false), // Corrupted gzip data
        }

        let actual_hash = hash::sha256_hex(&decompressed);
        Ok(actual_hash == hash)
    }

    fn delete(&self, kind: &str, hash: &str) -> Result<()> {
        let file_path = self.object_path(kind, hash)?;
        match fs::remove_file(&file_path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // FIND-3-RUST-3: idempotent — absence is success.
                Ok(())
            }
            Err(e) => Err(anyhow::anyhow!(
                "Failed to delete local object {}/{}: {}",
                kind,
                hash,
                e
            )),
        }
    }
}

/// Build an `aws-sdk-s3` client whose HTTP layer uses **hickory-dns**
/// for name resolution instead of the SDK's default hyper-util
/// `GaiResolver`.
///
/// **Why**: glibc 2.34+ on Amazon Linux 2023 + the default
/// `HttpConnector` (which calls `getaddrinfo` on a tokio blocking
/// thread pool) tripsa netlink contention race in containers,
/// returning `EAI_SYSTEM` mapped to `ConnectError("dns error",
/// Os{code:16, kind:ResourceBusy, ...})`. The same hostname resolves
/// instantly via curl, getent, and `std::net::ToSocketAddrs` — only
/// the SDK's async resolver hits the bug. tokio-postgres dodges it
/// because deadpool resolves once at pool-init and caches; the SDK
/// re-resolves on every operation and the burst trips the race.
///
/// **The fix**: replace the SDK's HTTP client with a hyper-0.14
/// stack that uses a pure-Rust hickory-dns resolver. This bypasses
/// glibc and netlink entirely. The same code path works against real
/// AWS S3 (and is in fact strictly better — hickory honors `search`
/// suffixes, EDNS, and IPv6 preference more reliably than glibc).
///
/// References:
/// - aws-sdk-rust#1242: "DNS error: Device or resource busy in container"
/// - rust-lang/rust#114914: glibc getaddrinfo netlink EBUSY
/// - hyper-rs/hyper-util#109: GaiResolver + tokio blocking pool EBUSY
#[cfg(feature = "s3")]
pub fn build_s3_http_client_with_hickory_dns(
) -> aws_smithy_runtime_api::client::http::SharedHttpClient {
    use hickory_resolver::config::{ResolverConfig, ResolverOpts};
    use hickory_resolver::TokioAsyncResolver;
    use hyper_014::client::connect::dns::Name as HyperName;
    use hyper_014::client::HttpConnector;
    use std::future::Future;
    use std::net::SocketAddr;
    use std::pin::Pin;
    use std::sync::Arc;
    use std::task::{Context, Poll};

    #[derive(Clone)]
    struct HickoryService(Arc<TokioAsyncResolver>);

    impl tower::Service<HyperName> for HickoryService {
        type Response = std::vec::IntoIter<SocketAddr>;
        type Error = Box<dyn std::error::Error + Send + Sync>;
        type Future =
            Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send + 'static>>;

        fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn call(&mut self, name: HyperName) -> Self::Future {
            let resolver = self.0.clone();
            Box::pin(async move {
                let lookup = resolver.lookup_ip(name.as_str()).await?;
                let addrs: Vec<SocketAddr> =
                    lookup.iter().map(|ip| SocketAddr::new(ip, 0)).collect();
                Ok(addrs.into_iter())
            })
        }
    }

    // Hickory resolver: prefer the system resolv.conf (Docker
    // populates this with the embedded DNS server). On
    // failure-to-load (rare), fall back to ResolverConfig::default()
    // which uses Google + Cloudflare DNS.
    let resolver = match TokioAsyncResolver::tokio_from_system_conf() {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "hickory-dns: system resolv.conf load failed; using public-DNS fallback");
            TokioAsyncResolver::tokio(ResolverConfig::default(), ResolverOpts::default())
        }
    };

    let mut http = HttpConnector::new_with_resolver(HickoryService(Arc::new(resolver)));
    // Allow plain HTTP — the local-emulator endpoint
    // (MiniStack/LocalStack) is http://, not https://.
    http.enforce_http(false);

    let https = hyper_rustls_014::HttpsConnectorBuilder::new()
        .with_webpki_roots()
        .https_or_http()
        .enable_http1()
        .enable_http2()
        .wrap_connector(http);

    aws_smithy_runtime::client::http::hyper_014::HyperClientBuilder::new().build(https)
}

/// S3-backed object store. Gated behind the `s3` feature flag to avoid
/// pulling in the AWS SDK unconditionally.
#[cfg(feature = "s3")]
pub struct S3ObjectStore {
    client: aws_sdk_s3::Client,
    bucket: String,
}

#[cfg(feature = "s3")]
impl S3ObjectStore {
    /// Create a new S3 object store.
    pub fn new(client: aws_sdk_s3::Client, bucket: String) -> Self {
        Self { client, bucket }
    }

    /// Build the S3 object key for a given kind and hash.
    fn s3_key(kind: &str, hash: &str) -> String {
        format!("objects/{}/{}.json.gz", kind, hash)
    }

    /// Bridge an async future to a sync context using `block_in_place`.
    ///
    /// `block_in_place` informs the runtime that the current thread will block,
    /// so the runtime can spawn a replacement worker. The current worker
    /// effectively joins the blocking thread pool for the duration of the
    /// call. This avoids panic when invoking `Handle::current().block_on(...)`
    /// on a worker thread but does NOT free the worker — under burst this
    /// can halve the worker pool on small containers (e.g., 2-vCPU AWS Fargate
    /// tasks). See audit finding E4 in `docs/GATEWAY_AUDIT_2026_05_02.md`.
    ///
    /// AUDIT-E4: the long-term fix is making `ObjectStore` an async trait
    /// (via AFIT / `async_trait`) so the capture path stays async end-to-end
    /// and never bridges sync→async per-op. That is a separate batch.
    fn block_on<F: std::future::Future>(&self, future: F) -> F::Output {
        tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(future))
    }
}

#[cfg(feature = "s3")]
impl ObjectStore for S3ObjectStore {
    fn put(&self, kind: &str, hash: &str, data: &[u8]) -> Result<String> {
        validate_path_component(kind, "kind")?;
        validate_path_component(hash, "hash")?;

        let key = Self::s3_key(kind, hash);
        // Return the same ref_key format as LocalObjectStore: "kind/hash.json.gz"
        // The S3 key includes an "objects/" prefix for bucket organization, but
        // the ref_key stored in TurnRecord should be backend-agnostic.
        let ref_key = format!("{}/{}.json.gz", kind, hash);

        // TOCTOU note: There is a race between HeadObject and PutObject — another
        // writer could upload between the two calls. This is safe because storage
        // is content-addressable: the same hash always maps to the same bytes, so
        // a concurrent upload produces an identical object. The worst case is a
        // redundant PutObject, not data corruption.
        //
        // Check if object already exists (dedup — skip re-upload).
        // Only treat 404/NotFound as "not present"; propagate all other errors
        // (403 Forbidden, 500 Internal, network errors, etc.).
        let head_result = self.block_on(
            self.client
                .head_object()
                .bucket(&self.bucket)
                .key(&key)
                .send(),
        );
        match head_result {
            Ok(_) => return Ok(ref_key),
            Err(ref sdk_err) => {
                if let aws_sdk_s3::error::SdkError::ServiceError(ref service_err) = sdk_err {
                    if service_err.err().is_not_found() {
                        // Object does not exist — proceed to upload below.
                    } else {
                        return Err(anyhow::anyhow!(
                            "S3 HeadObject failed for {} (non-404 service error): {}",
                            key,
                            sdk_err
                        ));
                    }
                } else {
                    return Err(anyhow::anyhow!(
                        "S3 HeadObject failed for {}: {}",
                        key,
                        sdk_err
                    ));
                }
            }
        }

        // Gzip compress the data.
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data)?;
        let compressed = encoder.finish()?;

        // Upload to S3.
        // Content-Encoding is intentionally NOT set on the S3 object. Setting
        // Content-Encoding: gzip would cause S3 (and some HTTP clients) to
        // transparently decompress on download, which would break our own
        // decompression logic in get(). We use Content-Type: application/gzip
        // to signal that the bytes are gzip-compressed, and handle
        // decompression ourselves.
        self.block_on(
            self.client
                .put_object()
                .bucket(&self.bucket)
                .key(&key)
                .body(aws_sdk_s3::primitives::ByteStream::from(compressed))
                .content_type("application/gzip")
                .send(),
        )
        .map_err(|e| anyhow::anyhow!("S3 PutObject failed for {}: {}", key, e))?;

        Ok(ref_key)
    }

    fn get(&self, kind: &str, hash: &str) -> Result<Vec<u8>> {
        validate_path_component(kind, "kind")?;
        validate_path_component(hash, "hash")?;

        let key = Self::s3_key(kind, hash);

        let resp = self
            .block_on(
                self.client
                    .get_object()
                    .bucket(&self.bucket)
                    .key(&key)
                    .send(),
            )
            .map_err(|e| anyhow::anyhow!("S3 GetObject failed for {}: {}", key, e))?;

        let body_bytes = self
            .block_on(resp.body.collect())
            .map_err(|e| anyhow::anyhow!("S3 GetObject body read failed for {}: {}", key, e))?
            .into_bytes();

        // Gunzip decompress.
        let mut decoder = GzDecoder::new(&body_bytes[..]);
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed)?;
        Ok(decompressed)
    }

    fn exists(&self, kind: &str, hash: &str) -> Result<bool> {
        validate_path_component(kind, "kind")?;
        validate_path_component(hash, "hash")?;

        let key = Self::s3_key(kind, hash);

        let result = self.block_on(
            self.client
                .head_object()
                .bucket(&self.bucket)
                .key(&key)
                .send(),
        );

        match result {
            Ok(_) => Ok(true),
            Err(sdk_err) => {
                // Check if this is a "not found" error (404 / NoSuchKey).
                if let aws_sdk_s3::error::SdkError::ServiceError(ref service_err) = sdk_err {
                    if service_err.err().is_not_found() {
                        return Ok(false);
                    }
                }
                // Any other error propagates.
                Err(anyhow::anyhow!(
                    "S3 HeadObject failed for {}: {}",
                    key,
                    sdk_err
                ))
            }
        }
    }

    fn verify(&self, kind: &str, hash: &str) -> Result<bool> {
        // Check existence first. If exists() returns Err, propagate it
        // (unlike swallowing all errors). If the object is missing,
        // return Ok(false) per the trait contract.
        match self.exists(kind, hash) {
            Ok(false) => return Ok(false),
            Err(e) => return Err(e),
            Ok(true) => { /* object exists — proceed to download + verify */ }
        }

        // Download, decompress, re-hash, compare.
        let decompressed = self.get(kind, hash)?;
        let actual_hash = hash::sha256_hex(&decompressed);
        Ok(actual_hash == hash)
    }

    fn delete(&self, kind: &str, hash: &str) -> Result<()> {
        validate_path_component(kind, "kind")?;
        validate_path_component(hash, "hash")?;
        let key = Self::s3_key(kind, hash);
        let result = self.block_on(
            self.client
                .delete_object()
                .bucket(&self.bucket)
                .key(&key)
                .send(),
        );
        match result {
            Ok(_) => Ok(()),
            Err(sdk_err) => {
                // FIND-3-RUST-3: S3 DeleteObject is idempotent by design
                // — it returns success even when the key did not exist.
                // Any error here is a genuine S3-layer problem (auth,
                // network, bucket policy).
                Err(anyhow::anyhow!(
                    "Failed to delete S3 object {}/{}: {}",
                    kind,
                    hash,
                    sdk_err
                ))
            }
        }
    }
}
