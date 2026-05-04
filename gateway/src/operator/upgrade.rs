//! Rolling upgrade orchestration types.
//!
//! The Recondo Operator receives upgrade directives from the control plane,
//! pulls a new gateway container image, performs a Kubernetes rolling update,
//! validates health checks, and rolls back on failure.
//!
//! This module defines the state machine and result types for that workflow.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Upgrade status state machine
// ---------------------------------------------------------------------------

/// Current phase of a rolling upgrade.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum UpgradeStatus {
    /// Upgrade directive received; not yet started.
    Pending,
    /// Pulling the new container image.
    Pulling,
    /// New pods are running; waiting for health checks to pass.
    HealthChecking,
    /// Upgrade completed successfully — all pods running new image.
    Complete,
    /// Upgrade failed and has been rolled back to the previous image.
    RolledBack,
}

// ---------------------------------------------------------------------------
// Upgrade result
// ---------------------------------------------------------------------------

/// Terminal outcome of a rolling upgrade attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum UpgradeResult {
    /// Upgrade succeeded — all pods healthy on the new image.
    Success,
    /// Upgrade failed and was rolled back. Contains the reason.
    RolledBack {
        /// Human-readable description of why the upgrade was rolled back.
        reason: String,
    },
}

// ---------------------------------------------------------------------------
// Rolling upgrade tracker
// ---------------------------------------------------------------------------

/// Tracks the state of a single rolling upgrade operation.
#[derive(Debug, Clone)]
pub struct RollingUpgrade {
    /// Container image tag to upgrade to.
    target_image: String,
    /// Container image tag currently running.
    current_image: String,
    /// Current status in the upgrade lifecycle.
    status: UpgradeStatus,
}

impl RollingUpgrade {
    /// Create a new rolling upgrade from the target image to upgrade to and the
    /// currently-running image. The initial status is [`UpgradeStatus::Pending`].
    pub fn new(target_image: String, current_image: String) -> Self {
        RollingUpgrade {
            target_image,
            current_image,
            status: UpgradeStatus::Pending,
        }
    }

    /// Returns the current upgrade status.
    pub fn status(&self) -> UpgradeStatus {
        self.status.clone()
    }

    /// Returns the target image tag.
    pub fn target_image(&self) -> &str {
        &self.target_image
    }

    /// Returns the currently-running image tag.
    pub fn current_image(&self) -> &str {
        &self.current_image
    }

    /// Advance the upgrade to the next status phase.
    ///
    /// W6 fix: Only valid transitions are allowed:
    /// - Pending -> Pulling
    /// - Pulling -> HealthChecking
    /// - HealthChecking -> Complete
    /// - Any -> RolledBack (rollback is always valid)
    ///
    /// Returns `Err` with a description if the transition is invalid.
    pub fn advance(&mut self, next: UpgradeStatus) -> Result<(), String> {
        let valid = match (&self.status, &next) {
            // Forward transitions
            (UpgradeStatus::Pending, UpgradeStatus::Pulling) => true,
            (UpgradeStatus::Pulling, UpgradeStatus::HealthChecking) => true,
            (UpgradeStatus::HealthChecking, UpgradeStatus::Complete) => true,
            // Rollback is valid from any state
            (_, UpgradeStatus::RolledBack) => true,
            // Everything else is invalid
            _ => false,
        };

        if valid {
            self.status = next;
            Ok(())
        } else {
            Err(format!(
                "Invalid upgrade transition: {:?} -> {:?}",
                self.status, next
            ))
        }
    }
}
