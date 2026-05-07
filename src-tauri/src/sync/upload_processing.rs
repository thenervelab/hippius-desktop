//! Tracks the "processing" window between a user-initiated upload IPC
//! call and the first byte of upload progress for a sync cycle that
//! began AFTER the upload was registered. The frontend renders a
//! top-of-page banner during this window so the user sees that the
//! system has acknowledged their click while disk copy + encryption
//! run.
//!
//! Lifecycle:
//! - `begin(count, current_epoch)` — called from `add_file` /
//!   `add_files` / `add_folder` after the eligibility check, before
//!   the disk copy. Increments the pending count and, on the
//!   activating call (when no banner is currently active), stamps
//!   `started_at` and `stamped_epoch`. The epoch comes from
//!   `AppState::sync_session_epoch`, which increments on every
//!   `SyncStarted` event.
//! - `clear_if_session_advanced(event_epoch)` — called from
//!   `handle_transfer_progress` (per upload chunk), `SyncCompleted`,
//!   and `SyncError`. Clears state only when `event_epoch >
//!   stamped_epoch`, i.e. when the event is from a sync cycle that
//!   began AFTER the activating `begin`. This is what makes the
//!   guard correct: events from a cycle that was already running
//!   when the user clicked Upload do not satisfy the guard, so they
//!   cannot prematurely clear the banner.
//! - `reset()` — unconditional clear. Used by logout / `stop_sync`.
//!
//! ## Why epoch and not timestamp
//!
//! An earlier version of this guard used `Instant`-based comparison:
//! "clear if `event_at >= started_at`". That guard is useless because
//! `Instant::now()` at any future event is always >= a past
//! `started_at`. The pathological case is overlapping uploads:
//!  1. File 1 cycle is mid-upload.
//!  2. User adds file 2 → `begin` stamps `started_at = T2`.
//!  3. File 1's next chunk fires at T3 > T2 → wall-clock guard
//!     succeeds → file 2's banner is cleared even though file 2's
//!     cycle hasn't started.
//!
//! The epoch counter increments only on `SyncStarted`, so the guard
//! correctly distinguishes "event from a cycle that started AFTER
//! begin" from "event from a cycle that was already running."

use std::sync::Mutex;
use std::time::Instant;

#[derive(Default)]
struct UploadProcessingInner {
    pending_files: u64,
    started_at: Option<Instant>,
    /// Sync-cycle epoch at the time of the activating `begin` call.
    /// Used by `clear_if_session_advanced` to gate clearing on
    /// "an event from a NEWER cycle" rather than the broken
    /// wall-clock timestamp comparison. `None` exactly when
    /// `started_at` is None.
    stamped_epoch: Option<u64>,
}

pub struct UploadProcessingState {
    inner: Mutex<UploadProcessingInner>,
}

impl Default for UploadProcessingState {
    fn default() -> Self {
        Self::new()
    }
}

impl UploadProcessingState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(UploadProcessingInner::default()),
        }
    }

    /// Snapshot for tests and event payload assembly.
    #[doc(hidden)]
    pub fn snapshot(&self) -> (bool, u64) {
        let g = self.inner.lock().expect("upload_processing mutex poisoned");
        (g.started_at.is_some(), g.pending_files)
    }

    /// Increment `pending_files` by `count`. On the activating call
    /// (when no banner is active), stamp `started_at = Some(Instant::now())`
    /// and `stamped_epoch = Some(current_epoch)`. Emits
    /// `hcfs_upload_processing` with `{ active: true, pending_files }`.
    ///
    /// `current_epoch` is the value of
    /// `AppState::sync_session_epoch.load(Ordering::SeqCst)` at the
    /// time of the call. Subsequent begins while active accumulate
    /// the count but do NOT restamp epoch — the original epoch must
    /// survive so `clear_if_session_advanced` can correctly gate on
    /// "did a new cycle start since the FIRST begin in this window."
    pub fn begin(&self, app: &tauri::AppHandle, count: u64, current_epoch: u64) {
        let pending = {
            let mut g = self.inner.lock().expect("upload_processing mutex poisoned");
            g.pending_files = g.pending_files.saturating_add(count);
            if g.started_at.is_none() {
                g.started_at = Some(Instant::now());
                g.stamped_epoch = Some(current_epoch);
            }
            g.pending_files
        };
        emit(app, true, pending);
    }

    /// Clear state if `event_epoch > stamped_epoch`. No-op when
    /// inactive or when the event is from a cycle that was already
    /// running at `begin` time. Idempotent.
    pub fn clear_if_session_advanced(&self, app: &tauri::AppHandle, event_epoch: u64) {
        let did_clear = {
            let mut g = self.inner.lock().expect("upload_processing mutex poisoned");
            match g.stamped_epoch {
                Some(stamped) if event_epoch > stamped => {
                    g.pending_files = 0;
                    g.started_at = None;
                    g.stamped_epoch = None;
                    true
                }
                _ => false,
            }
        };
        if did_clear {
            emit(app, false, 0);
        }
    }

    /// Unconditional clear used by logout / `stop_sync`.
    pub fn reset(&self, app: &tauri::AppHandle) {
        let did_clear = {
            let mut g = self.inner.lock().expect("upload_processing mutex poisoned");
            let was_active = g.started_at.is_some() || g.pending_files > 0;
            g.pending_files = 0;
            g.started_at = None;
            g.stamped_epoch = None;
            was_active
        };
        if did_clear {
            emit(app, false, 0);
        }
    }

    /// Test-only accessor exposing the internal `started_at` so tests
    /// can assert that subsequent `begin` calls during an active
    /// window do not re-stamp the original start time.
    #[cfg(test)]
    fn started_at_for_test(&self) -> Option<std::time::Instant> {
        self.inner.lock().expect("upload_processing mutex poisoned").started_at
    }

    /// Test-only accessor exposing the internal `stamped_epoch`.
    #[cfg(test)]
    fn stamped_epoch_for_test(&self) -> Option<u64> {
        self.inner.lock().expect("upload_processing mutex poisoned").stamped_epoch
    }

    /// Test-only entry point that mirrors [`Self::begin`] without
    /// emitting a Tauri event.
    #[cfg(test)]
    fn begin_for_test(&self, count: u64, current_epoch: u64) {
        let mut g = self.inner.lock().expect("upload_processing mutex poisoned");
        g.pending_files = g.pending_files.saturating_add(count);
        if g.started_at.is_none() {
            g.started_at = Some(Instant::now());
            g.stamped_epoch = Some(current_epoch);
        }
    }

    /// Test-only entry point that mirrors [`Self::clear_if_session_advanced`]
    /// without emitting a Tauri event.
    #[cfg(test)]
    fn clear_if_session_advanced_for_test(&self, event_epoch: u64) {
        let mut g = self.inner.lock().expect("upload_processing mutex poisoned");
        if let Some(stamped) = g.stamped_epoch {
            if event_epoch > stamped {
                g.pending_files = 0;
                g.started_at = None;
                g.stamped_epoch = None;
            }
        }
    }

    /// Test-only entry point that mirrors [`Self::reset`] without
    /// emitting a Tauri event.
    #[cfg(test)]
    fn reset_for_test(&self) {
        let mut g = self.inner.lock().expect("upload_processing mutex poisoned");
        g.pending_files = 0;
        g.started_at = None;
        g.stamped_epoch = None;
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UploadProcessingPayload {
    active: bool,
    pending_files: u64,
}

fn emit(app: &tauri::AppHandle, active: bool, pending_files: u64) {
    use tauri::Emitter;
    let _ = app.emit(crate::sync::events::UPLOAD_PROCESSING, UploadProcessingPayload { active, pending_files });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn begin_then_clear_with_advanced_epoch_zeros_state() {
        let s = UploadProcessingState::new();
        s.begin_for_test(3, 1);
        let (active_before, count_before) = s.snapshot();
        assert!(active_before);
        assert_eq!(count_before, 3);
        assert_eq!(s.stamped_epoch_for_test(), Some(1));

        s.clear_if_session_advanced_for_test(2);
        let (active_after, count_after) = s.snapshot();
        assert!(!active_after);
        assert_eq!(count_after, 0);
        assert_eq!(s.stamped_epoch_for_test(), None);
    }

    #[test]
    fn clear_with_same_or_earlier_epoch_is_noop() {
        let s = UploadProcessingState::new();
        s.begin_for_test(2, 5);
        // event_epoch == stamped_epoch — must not clear (the cycle
        // was already running when begin was called).
        s.clear_if_session_advanced_for_test(5);
        let (active, count) = s.snapshot();
        assert!(active, "same-epoch event must not clear");
        assert_eq!(count, 2);

        // event_epoch < stamped_epoch — must also not clear.
        s.clear_if_session_advanced_for_test(4);
        let (active, count) = s.snapshot();
        assert!(active, "earlier-epoch event must not clear");
        assert_eq!(count, 2);
    }

    #[test]
    fn sequential_begins_accumulate() {
        let s = UploadProcessingState::new();
        s.begin_for_test(4, 1);
        s.begin_for_test(3, 1);
        let (active, count) = s.snapshot();
        assert!(active);
        assert_eq!(count, 7);
    }

    #[test]
    fn clear_when_inactive_is_noop() {
        let s = UploadProcessingState::new();
        s.clear_if_session_advanced_for_test(99);
        let (active, count) = s.snapshot();
        assert!(!active);
        assert_eq!(count, 0);
    }

    #[test]
    fn reset_unconditionally_clears() {
        let s = UploadProcessingState::new();
        s.begin_for_test(5, 7);
        s.reset_for_test();
        let (active, count) = s.snapshot();
        assert!(!active);
        assert_eq!(count, 0);
        assert_eq!(s.stamped_epoch_for_test(), None);
    }

    #[test]
    fn second_begin_does_not_restamp_started_at_or_epoch() {
        let s = UploadProcessingState::new();
        s.begin_for_test(1, 3);
        let first_stamp = s.started_at_for_test();
        let first_epoch = s.stamped_epoch_for_test();
        assert_eq!(first_epoch, Some(3));
        assert!(first_stamp.is_some());
        std::thread::sleep(Duration::from_millis(2));
        // Second begin uses a different epoch — must not restamp
        // either field while banner is still active.
        s.begin_for_test(1, 9);
        let second_stamp = s.started_at_for_test();
        let second_epoch = s.stamped_epoch_for_test();
        assert_eq!(first_stamp, second_stamp, "must not restamp started_at while active");
        assert_eq!(first_epoch, second_epoch, "must not restamp epoch while active");
    }

    /// Regression test for the Scenario A bug. Models a file-1
    /// cycle in flight when file 2 is added; the file 1 chunks
    /// must NOT clear file 2's banner.
    #[test]
    fn overlapping_upload_does_not_prematurely_clear() {
        let s = UploadProcessingState::new();
        // File 1 cycle is running at epoch=1. User adds file.
        s.begin_for_test(1, 1);
        // File 1's chunks fire (still epoch 1) — must not clear.
        s.clear_if_session_advanced_for_test(1);
        let (active, _) = s.snapshot();
        assert!(active, "in-flight cycle's chunks must not clear");
        // File 1's cycle completes (still epoch 1) — must not clear.
        s.clear_if_session_advanced_for_test(1);
        let (active, _) = s.snapshot();
        assert!(active, "in-flight cycle's completion must not clear");
        // File 2's cycle starts (epoch increments to 2) and fires
        // its first chunk — NOW the banner clears.
        s.clear_if_session_advanced_for_test(2);
        let (active, _) = s.snapshot();
        assert!(!active, "newer cycle's chunk should clear");
    }
}
