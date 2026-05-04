//! Status reporting for the `recondo status` CLI command.
//!
//! Collects gateway operational status from the database and runtime state,
//! including session counts, capture counts, uptime, and configuration.

use anyhow::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// StatusInfo
// ---------------------------------------------------------------------------

/// Operational status of the Recondo gateway.
///
/// Returned by `collect_status` and displayed by the `recondo status` command.
/// Contains session counts, capture counts, uptime, database backend, and
/// fail mode configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusInfo {
    /// Gateway listen address (e.g., "0.0.0.0:8443").
    pub gateway_address: String,
    /// Number of currently active sessions (sessions without an ended_at timestamp).
    pub active_sessions: i64,
    /// Total number of sessions in the database.
    pub total_sessions: i64,
    /// Total number of captured turns in the database.
    pub total_captures: i64,
    /// Gateway uptime in seconds since process start.
    pub uptime_seconds: u64,
    /// Database backend in use (e.g., "sqlite", "postgres").
    pub database_backend: String,
    /// Configured fail mode (e.g., "open", "closed").
    pub fail_mode: String,
}

impl std::fmt::Display for StatusInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "Gateway active on {}", self.gateway_address)?;
        writeln!(
            f,
            "Sessions: {} active, {} total",
            self.active_sessions, self.total_sessions
        )?;
        writeln!(f, "Total captures: {}", self.total_captures)?;
        writeln!(f, "Uptime: {}s", self.uptime_seconds)?;
        writeln!(f, "Database backend: {}", self.database_backend)?;
        write!(f, "Fail mode: {}", self.fail_mode)
    }
}

// ---------------------------------------------------------------------------
// collect_status
// ---------------------------------------------------------------------------

/// Collect gateway status by querying the database for session and turn counts.
///
/// # Arguments
///
/// * `conn` - Database connection (SQLite)
/// * `addr` - Gateway listen address (e.g., "0.0.0.0:8443")
/// * `backend` - Database backend name (e.g., "sqlite", "postgres")
/// * `fail_mode` - Configured fail mode (e.g., "open", "closed")
/// * `uptime` - Gateway uptime in seconds
///
/// # Errors
///
/// Returns an error if the database queries fail (e.g., schema not initialized).
pub fn collect_status(
    conn: &Connection,
    addr: &str,
    backend: &str,
    fail_mode: &str,
    uptime: u64,
) -> Result<StatusInfo> {
    let total_sessions: i64 =
        conn.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))?;

    let active_sessions: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sessions WHERE ended_at IS NULL",
        [],
        |row| row.get(0),
    )?;

    let total_captures: i64 = conn.query_row("SELECT COUNT(*) FROM turns", [], |row| row.get(0))?;

    Ok(StatusInfo {
        gateway_address: addr.to_string(),
        active_sessions,
        total_sessions,
        total_captures,
        uptime_seconds: uptime,
        database_backend: backend.to_string(),
        fail_mode: fail_mode.to_string(),
    })
}
