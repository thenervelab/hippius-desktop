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
use std::sync::Mutex;

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

    /// Insert `label` into the preparing set.
    ///
    /// Returns `true` if the label was newly added; `false` if it was
    /// already present. Callers gate an immediate `emit_snapshot` on
    /// the `true` return so the widget appears within one tick of
    /// `SyncStarted`, without re-emitting on every duplicate
    /// `SyncStarted` from rapid file-watcher re-triggers within the
    /// same preparing window.
    pub fn mark_preparing(&self, label: &str) -> bool {
        let mut g = self.inner.lock().expect("preparing mutex poisoned");
        g.insert(label.to_string())
    }

    /// Remove `label` from the preparing set.
    ///
    /// Returns `true` if the label was present (caller can use this
    /// to skip a redundant `emit_snapshot` when nothing changed).
    pub fn clear(&self, label: &str) -> bool {
        let mut g = self.inner.lock().expect("preparing mutex poisoned");
        g.remove(label)
    }

    /// Remove every label from the preparing set.
    ///
    /// Returns `true` if the set was non-empty before the clear.
    /// Called on `SyncReset` and from `stop_sync` (logout / drive
    /// teardown), which must guarantee no preparing override leaks
    /// across an account switch.
    pub fn clear_all(&self) -> bool {
        let mut g = self.inner.lock().expect("preparing mutex poisoned");
        let had_entries = !g.is_empty();
        g.clear();
        had_entries
    }

    /// Returns `true` when at least one label is in the preparing
    /// set. Read by the snapshot pipeline to decide whether to apply
    /// the preparing override.
    pub fn is_any_preparing(&self) -> bool {
        !self.inner.lock().expect("preparing mutex poisoned").is_empty()
    }

    /// Sorted snapshot of the current set, for tests and diagnostics.
    /// Not on the hot path — produces a fresh `Vec` per call.
    #[doc(hidden)]
    pub fn snapshot_labels(&self) -> Vec<String> {
        let g = self.inner.lock().expect("preparing mutex poisoned");
        let mut labels: Vec<String> = g.iter().cloned().collect();
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
}
