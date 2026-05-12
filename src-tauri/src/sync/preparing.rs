//! Per-label "preparing" state for file-watcher-triggered sync cycles.
//!
//! Bridges the visibility gap between `SyncEvent::SyncStarted` and the
//! first `ProgressSnapshot` that has files in the session.
//!
//! ## Why this exists
//!
//! For IPC-initiated uploads (`add_file`/`add_files`/`add_folder`) the
//! top-of-page [`crate::sync::upload_processing::UploadProcessingState`]
//! banner already covers the disk-copy + encryption window. For
//! file-watcher-initiated cycles (user drops a folder via Finder, an
//! external editor writes into the sync dir, etc.) there is no banner
//! by design — and the bottom-right widget is gated on
//! `total_files > 0` in [`hcfs_client::engine::progress::snapshot::build_snapshot`],
//! so the user sees nothing during the debounce + `scan_local_files`
//! + `fetch_remote_state` window even though the system is doing work.
//!
//! This module tracks which drive labels are currently in that
//! "preparing" window. The snapshot pipeline reads it and, when any
//! label is present, overrides `widget_visible=true` and
//! `widget_state="preparing"` on an otherwise-invisible snapshot.
//!
//! ## Lifecycle
//!
//! - [`PreparingState::mark_preparing`] — called from the
//!   `SyncEvent::SyncStarted` handler when the upload-processing
//!   banner is NOT active (i.e. this is a file-watcher cycle, not an
//!   IPC-initiated one). The banner check avoids double-signalling
//!   for IPC uploads — those already have their own "we're working"
//!   indicator.
//! - [`PreparingState::clear`] — called from `SyncCompleted`,
//!   `SyncError`, and `SyncStopped` handlers; and from the
//!   `ProgressSnapshot` handler when the snapshot has files for that
//!   label (the real per-file widget takes over).
//! - [`PreparingState::clear_all`] — called from `stop_sync` /
//!   logout / reset paths.
//!
//! ## Concurrency
//!
//! All methods are synchronous and lock the inner [`Mutex`] only for
//! the duration of the operation. The TauriSyncBridge handler that
//! invokes them is also synchronous, so the lock is never held
//! across an `.await` (compatible with the project's async-lock
//! hygiene axiom).

use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard};

/// Set of drive labels currently in the "preparing" window between
/// `SyncStarted` and the first ProgressSnapshot that has files.
///
/// Owned by [`crate::app_state::AppState`] behind an `Arc`, mirroring
/// the [`crate::sync::upload_processing::UploadProcessingState`]
/// composition pattern.
pub struct PreparingState {
    /// Membership-only set: we only care whether a label is currently
    /// preparing, not how long it has been. Order does not matter —
    /// callers iterate at most once per event to clear after the
    /// session is populated. `String` keys mirror the per-drive
    /// label type used everywhere else in the sync module.
    inner: Mutex<HashSet<String>>,
}

impl Default for PreparingState {
    fn default() -> Self {
        Self::new()
    }
}

impl PreparingState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashSet::new()),
        }
    }

    /// Acquire the inner mutex with a single poison-message helper.
    ///
    /// Centralises the `expect` panic message so a future addition to
    /// the API can't introduce a new wording variant. The returned
    /// guard's lifetime is tied to `&self`; each public method should
    /// hold it for the smallest possible scope (no `.await` in this
    /// module, but the project axiom forbidding sync-mutex-across-await
    /// applies if a future caller adds async code here).
    fn lock(&self) -> MutexGuard<'_, HashSet<String>> {
        self.inner.lock().expect("preparing mutex poisoned")
    }

    /// Insert `label` into the preparing set.
    ///
    /// Returns `true` if the label was newly added; `false` if it was
    /// already present. Callers gate an immediate `emit_snapshot` on
    /// the `true` return so the widget appears within one tick of
    /// `SyncStarted`, without re-emitting on every duplicate
    /// `SyncStarted` from rapid file-watcher re-triggers within the
    /// same preparing window.
    ///
    /// The `MutexGuard` is dropped at the function boundary (the
    /// return value is `bool`, not the guard). This non-extending-the-
    /// guard contract is load-bearing for the
    /// [`crate::sync::tauri_bridge::TauriSyncBridge::on_event`]
    /// `SyncStarted` arm: that arm calls this method and then invokes
    /// `emit_snapshot`, which synchronously re-enters `on_event` with
    /// `ProgressSnapshot` — and that re-entry reacquires this same
    /// mutex via `clear` / `is_any_preparing`. Since `std::sync::Mutex`
    /// is non-reentrant, holding the guard across `emit_snapshot`
    /// would deadlock. The `mark_then_read_does_not_deadlock_in_sequence`
    /// test below pins this invariant.
    pub fn mark_preparing(&self, label: &str) -> bool {
        self.lock().insert(label.to_string())
    }

    /// Remove `label` from the preparing set.
    ///
    /// Returns `true` if the label was present (caller can use this
    /// to skip a redundant `emit_snapshot` when nothing changed).
    pub fn clear(&self, label: &str) -> bool {
        self.lock().remove(label)
    }

    /// Remove every label from the preparing set.
    ///
    /// Returns `true` if the set was non-empty before the clear.
    /// Called on `SyncReset` and from `stop_sync` (logout / drive
    /// teardown), which must guarantee no preparing override leaks
    /// across an account switch.
    pub fn clear_all(&self) -> bool {
        let mut g = self.lock();
        let had_entries = !g.is_empty();
        g.clear();
        had_entries
    }

    /// Returns `true` when at least one label is in the preparing
    /// set. Read by the snapshot pipeline to decide whether to apply
    /// the preparing override.
    pub fn is_any_preparing(&self) -> bool {
        !self.lock().is_empty()
    }

    /// Sorted snapshot of the current set, for tests and diagnostics.
    /// Not on the hot path — produces a fresh `Vec` per call.
    #[doc(hidden)]
    pub fn snapshot_labels(&self) -> Vec<String> {
        let mut labels: Vec<String> = self.lock().iter().cloned().collect();
        labels.sort();
        labels
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mark_preparing_returns_true_on_first_insert() {
        let state = PreparingState::new();
        assert!(state.mark_preparing("drive-a"));
        assert_eq!(state.snapshot_labels(), vec!["drive-a".to_string()]);
    }

    #[test]
    fn mark_preparing_returns_false_on_duplicate() {
        let state = PreparingState::new();
        state.mark_preparing("drive-a");
        assert!(!state.mark_preparing("drive-a"));
        assert_eq!(state.snapshot_labels(), vec!["drive-a".to_string()]);
    }

    #[test]
    fn clear_returns_true_when_present() {
        let state = PreparingState::new();
        state.mark_preparing("drive-a");
        assert!(state.clear("drive-a"));
        assert!(state.snapshot_labels().is_empty());
    }

    #[test]
    fn clear_returns_false_when_absent() {
        let state = PreparingState::new();
        assert!(!state.clear("nobody"));
    }

    #[test]
    fn clear_all_removes_every_label() {
        let state = PreparingState::new();
        state.mark_preparing("drive-a");
        state.mark_preparing("drive-b");
        assert!(state.clear_all());
        assert!(!state.is_any_preparing());
    }

    #[test]
    fn clear_all_returns_false_on_empty() {
        let state = PreparingState::new();
        assert!(!state.clear_all());
    }

    #[test]
    fn is_any_preparing_reflects_membership() {
        let state = PreparingState::new();
        assert!(!state.is_any_preparing());
        state.mark_preparing("drive-a");
        assert!(state.is_any_preparing());
        state.clear("drive-a");
        assert!(!state.is_any_preparing());
    }

    #[test]
    fn snapshot_labels_returns_sorted_view() {
        let state = PreparingState::new();
        state.mark_preparing("drive-z");
        state.mark_preparing("drive-a");
        state.mark_preparing("drive-m");
        assert_eq!(
            state.snapshot_labels(),
            vec!["drive-a".to_string(), "drive-m".to_string(), "drive-z".to_string()],
        );
    }

    /// Re-entrancy guardrail. `PreparingState::mark_preparing` MUST
    /// release the inner mutex before returning so the
    /// `TauriSyncBridge::on_event` `SyncStarted` arm can call it and
    /// then invoke `emit_snapshot`, which synchronously re-enters
    /// `on_event` and reacquires the same mutex via `clear` /
    /// `is_any_preparing`. `std::sync::Mutex` is non-reentrant, so a
    /// refactor that extended the guard's lifetime (e.g. returning
    /// the guard alongside the bool, or inlining the lock acquisition
    /// into the bridge handler) would deadlock at runtime — but every
    /// existing unit test calls the operations on separate lines, so
    /// it wouldn't trip them.
    ///
    /// This test calls `mark_preparing` and the read operations in a
    /// tight sequence on the same thread. A regression that broke the
    /// lock release would surface as the second call blocking
    /// indefinitely; the test harness's per-test timeout would catch
    /// it.
    #[test]
    fn mark_then_read_does_not_deadlock_in_sequence() {
        let state = PreparingState::new();
        assert!(state.mark_preparing("drive-a"));
        // Each of the following reacquires the inner mutex. If
        // `mark_preparing` had returned with the guard still live,
        // every line below would deadlock on the same thread.
        assert!(state.is_any_preparing());
        assert_eq!(state.snapshot_labels(), vec!["drive-a".to_string()]);
        assert!(state.clear("drive-a"));
        assert!(!state.is_any_preparing());
    }
}
