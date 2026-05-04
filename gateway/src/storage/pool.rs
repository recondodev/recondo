//! Connection pool abstraction.
//!
//! Supports SQLite via r2d2 and PostgreSQL via deadpool-postgres.

use std::path::Path;

use anyhow::Result;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;

use crate::db;
use crate::storage::graph::{GraphStore, SqliteGraphStore};

/// A connection pool that can produce `GraphStore` instances.
pub enum ConnectionPool {
    Sqlite(Pool<SqliteConnectionManager>),
    #[cfg(feature = "postgres")]
    Postgres(deadpool_postgres::Pool),
}

impl ConnectionPool {
    /// Create a SQLite pool backed by a file on disk.
    pub fn sqlite(path: &Path) -> Result<Self> {
        let manager = SqliteConnectionManager::file(path).with_init(|conn| {
            conn.execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = WAL;
                 PRAGMA busy_timeout = 5000;",
            )
        });
        let pool = Pool::builder().max_size(8).build(manager)?;

        // Initialize schema.
        let conn = pool.get()?;
        db::initialize(&conn)?;

        Ok(ConnectionPool::Sqlite(pool))
    }

    /// Create an in-memory SQLite pool for testing.
    pub fn sqlite_in_memory() -> Result<Self> {
        let manager = SqliteConnectionManager::memory().with_init(|conn| {
            conn.execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = WAL;
                 PRAGMA busy_timeout = 5000;",
            )
        });
        // Use max_size=1 for in-memory so all threads share the same DB state.
        let pool = Pool::builder().max_size(1).build(manager)?;

        // Initialize schema.
        let conn = pool.get()?;
        db::initialize(&conn)?;

        Ok(ConnectionPool::Sqlite(pool))
    }

    /// Create a PostgreSQL pool from a connection string.
    ///
    /// The connection URL should be a PostgreSQL connection string, e.g.:
    /// `postgresql://user:pass@localhost:5432/recondo?sslmode=require`
    ///
    /// **Production deployments MUST include `sslmode=require` (or stricter).**
    /// A warning is logged if the URL does not contain it.
    ///
    /// After Sprint M2, the gateway no longer creates PostgreSQL tables on startup.
    /// Tables must be created by running migrations externally (`just api-migrate`).
    /// This method verifies that required tables exist after connecting.
    #[cfg(feature = "postgres")]
    pub fn postgres(database_url: &str) -> Result<Self> {
        let pool = crate::storage::postgres::create_pg_pool(database_url)?;

        // M2: Verify tables exist (migrations must have been run externally).
        // B2: use block_in_place to avoid panics in async context.
        let pool_clone = pool.clone();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                let client = pool_clone.get().await.map_err(|e| {
                    anyhow::anyhow!("Failed to get PG connection for table check: {}", e)
                })?;
                crate::storage::postgres::PostgresGraphStore::check_tables_exist(&client).await
            })
        })?;

        Ok(ConnectionPool::Postgres(pool))
    }

    /// Get a `GraphStore` from this pool.
    ///
    /// NOTE: `pool.clone()` is cheap — `r2d2::Pool` is an `Arc<SharedPool>`,
    /// so cloning only increments a reference count. It does not copy
    /// connections or other heavyweight resources. This is acceptable for
    /// per-call usage; caching the `GraphStore` is an optional optimization.
    pub fn graph_store(&self) -> Box<dyn GraphStore> {
        match self {
            ConnectionPool::Sqlite(pool) => Box::new(SqliteGraphStore::new(pool.clone())),
            #[cfg(feature = "postgres")]
            ConnectionPool::Postgres(pool) => {
                // PostgresGraphStore::from_pool_no_init skips schema init since
                // ConnectionPool::postgres already did it.
                Box::new(
                    crate::storage::postgres::PostgresGraphStore::from_pool_no_init(pool.clone()),
                )
            }
        }
    }
}
