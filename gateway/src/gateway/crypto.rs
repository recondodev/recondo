//! Process-level rustls `CryptoProvider` initialization.
//!
//! Adding `testcontainers` as a dev-dep transitively pulls in
//! `bollard`, whose `ssl` feature enables `rustls/ring`. The gateway
//! itself depends on rustls with its default features (which include
//! `aws_lc_rs`). Cargo unifies both, so rustls 0.23 sees BOTH crypto
//! providers compiled in — and refuses to auto-pick one
//! (`Could not automatically determine the process-level CryptoProvider`).
//!
//! `ensure_provider` resolves this by installing aws-lc-rs explicitly
//! and exactly once, with a `Once` guard so concurrent callers race
//! safely. Subsequent installs by other libraries silently fail
//! (their `install_default()` returns `Err`); the first writer wins,
//! which is the documented contract.

use std::sync::Once;

/// Install the aws-lc-rs `CryptoProvider` as the process default.
/// Idempotent: safe to call from multiple TLS entry points
/// concurrently. Subsequent calls after the first are no-ops.
pub fn ensure_provider() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    });
}
