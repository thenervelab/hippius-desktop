//! Per-drive-label lifecycle guards: pause epochs + commit locks.
//!
//! Pause/resume/init for one drive label run as independent tasks — the
//! `pause_drive`/`resume_drive` IPC commands and the `auto_init_sync`
//! fan-out can all be in flight for the same label at once. A pause
//! landing anywhere inside an in-flight init must win: without a guard,
//! the init's final "commit" (writing `is_paused=false` + inserting the
//! drive into the in-memory map) silently overwrites the user's pause —
//! the pause-overwrite race analyzed in PR #17.
//!
//! Two primitives, both keyed by drive label:
//!
//! - **Pause epoch** — a monotonic counter bumped by every superseding
//!   action (pause, removal). An init takes a [`DriveLifecycle::snapshot`]
//!   when it starts; at commit time, [`DriveLifecycle::is_current`]
//!   answers "did a pause/removal supersede this init?" — if not current,
//!   the init must abandon its commit instead of resurrecting the drive.
//! - **Commit lock** — a per-label async mutex making the epoch check and
//!   the `is_paused` DB write one atomic step. Without it, a pause could
//!   land between an init's epoch check and its write, recreating the
//!   race one level down.
//!
//! # Lock hierarchy
//!
//! `commit_lock(label)` → `SyncRunner::drives` → progress std mutexes,
//! never the reverse. The outer std mutexes in this module guard only
//! map access and are NEVER held across an await (axiom
//! `rust_quality_74`); the returned tokio lock is the one callers hold
//! across their short DB write.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

/// Per-drive-label pause epochs and commit locks. See the module docs
/// for the race this guards against and the lock hierarchy.
///
/// All methods take `&self` (interior mutability), matching the other
/// `AppState` sub-states so a shared reference suffices everywhere.
#[derive(Default)]
pub struct DriveLifecycle {
    /// Monotonic supersession counter per label. A missing entry is
    /// epoch 0, so labels never seen by `bump` are always current.
    epochs: Mutex<HashMap<String, u64>>,
    /// Per-label async lock serializing the commit step (epoch check +
    /// `is_paused` write). `Arc` so callers can hold the tokio guard
    /// across awaits after the outer std lock is dropped — mirrors
    /// `AppState::refresh_locks`.
    commit_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl DriveLifecycle {
    /// Returns the label's current epoch, to be checked later via
    /// [`Self::is_current`]. A label with no recorded bumps is epoch 0.
    pub fn snapshot(&self, label: &str) -> u64 {
        let epochs = self.epochs.lock().unwrap_or_else(PoisonError::into_inner);
        epochs.get(label).copied().unwrap_or(0)
    }

    /// Records a superseding action (pause, removal) for the label,
    /// invalidating every snapshot taken before this call.
    ///
    /// `bump` must happen while holding the label's commit lock (or
    /// otherwise strictly before the superseding `is_paused` write it
    /// announces); bumping after releasing the lock reopens the race
    /// this module exists to close.
    pub fn bump(&self, label: &str) {
        let mut epochs = self.epochs.lock().unwrap_or_else(PoisonError::into_inner);
        *epochs.entry(label.to_string()).or_insert(0) += 1;
    }

    /// True iff no [`Self::bump`] for this label happened since the
    /// snapshot was taken — i.e. the in-flight operation that took the
    /// snapshot has not been superseded and may commit.
    pub fn is_current(&self, label: &str, snapshot: u64) -> bool {
        self.snapshot(label) == snapshot
    }

    /// Returns the label's commit lock, creating it on first use. The
    /// same label always yields the same lock (callers contend on it);
    /// the outer std lock guards only the map insert and is dropped
    /// before this returns, so holding the returned tokio lock across
    /// an await never holds a std mutex (axiom `rust_quality_74`).
    ///
    /// Every write to `sync_paths.is_paused` for a label MUST happen
    /// while holding that label's commit lock.
    pub fn commit_lock(&self, label: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.commit_locks.lock().unwrap_or_else(PoisonError::into_inner);
        locks
            .entry(label.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }
}

/// Outcome of the init commit step.
#[derive(Debug, PartialEq, Eq)]
pub enum CommitOutcome {
    /// No pause/removal superseded the init: `is_paused` cleared.
    Committed,
    /// A pause/removal bumped the epoch mid-init: nothing written;
    /// the caller must tear down its registration.
    Superseded,
}

/// Atomically (under the label's commit lock) re-check the epoch and,
/// if still current, clear `is_paused`. This is the init side of the
/// single-writer protocol documented on [`DriveLifecycle::commit_lock`]:
/// the epoch check and the flag write happen as one step, so a pause
/// that bumped the epoch can never have its `is_paused=1` overwritten
/// by a stale in-flight init.
///
/// `account_id` is the RAW account id — `set_sync_path_paused` hashes
/// it into the `sync_paths.owner` key internally via `account_key`.
///
/// # Errors
///
/// Returns `Err` only when the `is_paused` DB write fails. Being
/// superseded is a normal protocol outcome ([`CommitOutcome::Superseded`]),
/// not an error.
pub async fn apply_init_commit(
    lifecycle: &DriveLifecycle,
    pool: &sqlx::SqlitePool,
    account_id: &str,
    label: &str,
    snapshot: u64,
) -> crate::error::Result<CommitOutcome> {
    let lock = lifecycle.commit_lock(label);
    let _guard = lock.lock().await;
    if !lifecycle.is_current(label, snapshot) {
        return Ok(CommitOutcome::Superseded);
    }
    crate::sync::paths::set_sync_path_paused(pool, account_id, label, false).await?;
    Ok(CommitOutcome::Committed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn snapshot_is_current_until_bump() {
        let g = DriveLifecycle::default();
        let snap = g.snapshot("photos");
        assert!(g.is_current("photos", snap));
        g.bump("photos");
        assert!(!g.is_current("photos", snap));
        assert!(g.is_current("photos", g.snapshot("photos")));
    }

    #[test]
    fn labels_are_independent() {
        let g = DriveLifecycle::default();
        let snap_a = g.snapshot("a");
        g.bump("b");
        assert!(g.is_current("a", snap_a), "bumping b must not invalidate a");
    }

    #[test]
    fn commit_lock_is_per_label_and_stable() {
        let g = DriveLifecycle::default();
        let l1 = g.commit_lock("a");
        let l2 = g.commit_lock("a");
        let l3 = g.commit_lock("b");
        assert!(Arc::ptr_eq(&l1, &l2), "same label => same lock");
        assert!(!Arc::ptr_eq(&l1, &l3), "different label => different lock");
    }

    proptest! {
        /// Monotonicity: a snapshot is current iff zero bumps happened since.
        #[test]
        fn snapshot_current_iff_no_bumps(bumps in 0usize..8) {
            let g = DriveLifecycle::default();
            let snap = g.snapshot("x");
            for _ in 0..bumps { g.bump("x"); }
            prop_assert_eq!(g.is_current("x", snap), bumps == 0);
        }
    }
}
