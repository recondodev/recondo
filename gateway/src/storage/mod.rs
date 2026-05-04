//! Storage backend abstraction layer.
//!
//! Provides trait-based abstractions for graph storage (sessions, turns, tool calls)
//! and object storage (raw request/response bytes), with concrete implementations
//! for SQLite + local filesystem (dev) and S3 (future prod).

pub mod graph;
pub mod object;
pub mod pipeline;
pub mod pool;
#[cfg(feature = "postgres")]
pub mod postgres;

use anyhow::{bail, Result};

use crate::storage::graph::GraphStore;
#[cfg(feature = "s3")]
use crate::storage::object::S3ObjectStore;
use crate::storage::object::{LocalObjectStore, ObjectStore};
use crate::storage::pool::ConnectionPool;

/// Resolved storage configuration. Built either from environment
/// variables (`StorageConfig::from_env()`) or constructed directly by
/// callers that don't want to mutate the process env (the canonical
/// example is the `pg_create_from_env_with_db_url` test — see
/// FIND-15-3: `std::env::set_var` is not thread-safe in the Rust
/// stdlib and racing peer tests in the same binary observed garbage
/// values for `RECONDO_DB_URL` mid-write).
#[derive(Clone, Debug)]
pub struct StorageConfig {
    pub store_type: String,
    pub objects_type: String,
    pub explicit_data_dir: Option<String>,
    pub db_url: Option<String>,
    pub s3_bucket: Option<String>,
}

impl StorageConfig {
    /// Build the configuration by reading the standard environment
    /// variables. This is what `create_from_env` does internally; it's
    /// exposed so callers (e.g. tests) can capture the env snapshot
    /// once and then mutate fields without touching `std::env`.
    pub fn from_env() -> Self {
        Self {
            store_type: std::env::var("RECONDO_STORE").unwrap_or_else(|_| "sqlite".to_string()),
            objects_type: std::env::var("RECONDO_OBJECTS").unwrap_or_else(|_| "local".to_string()),
            explicit_data_dir: std::env::var("RECONDO_DATA_DIR").ok(),
            db_url: std::env::var("RECONDO_DB_URL").ok(),
            s3_bucket: std::env::var("RECONDO_S3_BUCKET").ok(),
        }
    }
}

/// Create storage backends from environment variables.
///
/// - `RECONDO_STORE`: "sqlite" (default) or "postgres"
/// - `RECONDO_OBJECTS`: "local" (default) or "s3" (requires `s3` feature + `RECONDO_S3_BUCKET`)
/// - `RECONDO_DATA_DIR`: data directory (default: `~/.recondo`)
/// - `RECONDO_DB_URL`: PostgreSQL connection string (required when `RECONDO_STORE=postgres`)
///
/// When `RECONDO_DATA_DIR` is not explicitly set, each invocation creates a
/// unique temporary directory. This ensures test isolation: parallel tests
/// calling `create_from_env()` do not share a database file.
pub fn create_from_env() -> Result<(Box<dyn GraphStore>, Box<dyn ObjectStore>)> {
    create_with_config(StorageConfig::from_env())
}

/// FIND-15-3: like `create_from_env`, but takes an explicit
/// `StorageConfig` instead of reading process env vars. This breaks
/// the env-mutation race that previously caused intermittent
/// `pg_verify_integrity_missing_hash` failures: peer tests in the
/// same binary that read `RECONDO_DB_URL` could observe the
/// transiently-set/removed value during the racy `set_var/remove_var`
/// window in the original test.
///
/// Production callers can keep using `create_from_env()`; the
/// production startup path runs once per process before any concurrent
/// reads, so env-var thread-safety is not an issue there.
pub fn create_with_config(
    config: StorageConfig,
) -> Result<(Box<dyn GraphStore>, Box<dyn ObjectStore>)> {
    let StorageConfig {
        store_type,
        objects_type,
        explicit_data_dir,
        db_url,
        s3_bucket,
    } = config;

    let data_path = match &explicit_data_dir {
        Some(dir) => std::path::PathBuf::from(dir),
        None => {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
            std::path::PathBuf::from(format!("{}/.recondo", home))
        }
    };

    let graph: Box<dyn GraphStore> = match store_type.as_str() {
        "sqlite" => {
            // When no explicit data dir is configured, use an in-memory database
            // for isolation. In production, RECONDO_DATA_DIR should be set.
            if explicit_data_dir.is_none() {
                let pool = ConnectionPool::sqlite_in_memory()?;
                pool.graph_store()
            } else {
                let db_path = data_path.join("recondo.db");
                if let Some(parent) = db_path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let pool = ConnectionPool::sqlite(&db_path)?;
                pool.graph_store()
            }
        }
        "postgres" => {
            #[cfg(feature = "postgres")]
            {
                let db_url = db_url.ok_or_else(|| {
                    anyhow::anyhow!(
                        "RECONDO_DB_URL must be set when RECONDO_STORE=postgres \
                         (e.g., postgresql://user:pass@localhost:5432/recondo)"
                    )
                })?;
                let pool = ConnectionPool::postgres(&db_url)?;
                pool.graph_store()
            }
            #[cfg(not(feature = "postgres"))]
            {
                let _ = db_url; // suppress "unused" when feature off
                bail!(
                    "PostgreSQL backend requires the 'postgres' feature. \
                     Build with: cargo build --features postgres"
                )
            }
        }
        other => bail!(
            "Unknown RECONDO_STORE value: {:?}. Supported: sqlite, postgres",
            other
        ),
    };

    let objects: Box<dyn ObjectStore> = match objects_type.as_str() {
        "local" => Box::new(LocalObjectStore::new(&data_path)),
        "s3" => {
            #[cfg(feature = "s3")]
            {
                let bucket = s3_bucket.ok_or_else(|| {
                    anyhow::anyhow!(
                        "RECONDO_S3_BUCKET must be set when RECONDO_OBJECTS=s3 \
                         (e.g., recondo-objects)"
                    )
                })?;

                // Build AWS SDK config from environment. This supports:
                // - Standard AWS credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
                // - IAM roles, instance profiles, ECS task roles
                // - Local AWS emulator (e.g. MiniStack) via AWS_ENDPOINT_URL
                let rt = tokio::runtime::Handle::try_current()
                    .map_err(|_| anyhow::anyhow!("S3 object store requires a tokio runtime"))?;
                let config = tokio::task::block_in_place(|| {
                    rt.block_on(aws_config::load_defaults(
                        aws_config::BehaviorVersion::latest(),
                    ))
                });
                // Build the SDK client with the hickory-dns HTTP client
                // (avoids the EBUSY getaddrinfo bug in container glibc;
                // see `build_s3_http_client_with_hickory_dns` for
                // details). `force_path_style(true)` is required for
                // S3-compatible services (MiniStack, LocalStack, MinIO)
                // and is gated on the presence of AWS_ENDPOINT_URL —
                // real AWS S3 (no env var) uses virtual-hosted-style by
                // default.
                let mut s3_builder = aws_sdk_s3::config::Builder::from(&config)
                    .http_client(crate::storage::object::build_s3_http_client_with_hickory_dns());
                if let Ok(endpoint) = std::env::var("AWS_ENDPOINT_URL") {
                    s3_builder = s3_builder.endpoint_url(&endpoint).force_path_style(true);
                }
                let client = aws_sdk_s3::Client::from_conf(s3_builder.build());

                Box::new(S3ObjectStore::new(client, bucket))
            }
            #[cfg(not(feature = "s3"))]
            {
                let _ = s3_bucket; // suppress "unused" when feature off
                bail!(
                    "S3 object store requires the 's3' feature. \
                     Build with: cargo build --features s3"
                )
            }
        }
        other => bail!(
            "Unknown RECONDO_OBJECTS value: {:?}. Supported: local, s3",
            other
        ),
    };

    Ok((graph, objects))
}
