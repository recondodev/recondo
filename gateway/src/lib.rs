pub mod alerts;
pub mod artifacts;
pub mod capture;
pub mod config;
pub mod db;
pub mod drift;
pub mod gateway;
pub mod hash;
pub mod health;
pub mod metrics;
pub mod operator;
pub mod providers;
pub mod schema;
pub mod session;
pub mod status;
pub mod storage;
pub mod store;
pub mod stream;
pub mod tls;
pub mod wal;
pub mod websocket;

/// Install rustls' default `CryptoProvider` (aws-lc-rs) for the
/// process. See `gateway/crypto::ensure_provider` for the full
/// rationale; re-exported here so tests can call
/// `recondo_gateway::ensure_crypto_provider()` without depending on
/// the driver module path.
pub use crate::gateway::crypto::ensure_provider as ensure_crypto_provider;
