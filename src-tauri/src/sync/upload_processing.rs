//! Tracks the "processing" window between a user-initiated upload IPC
//! call and the first byte of upload progress. The frontend renders a
//! top-of-page banner during this window so the user sees that the
//! system has acknowledged their click while disk copy + encryption
//! run.
//!
//! Lifecycle:
//! - `begin(count)` — called from `add_file` / `add_files` / `add_folder`
//!   after the eligibility check, before the disk copy. Increments the
//!   pending count and stamps `started_at` if currently `None`.
//! - `clear_if_after(now)` — called from `handle_transfer_progress`
//!   when the first upload chunk lands. Idempotent. Guarded by the
//!   `started_at` timestamp so file-watcher activity that fires before
//!   any user upload cannot accidentally hide a banner.
//! - `reset()` — unconditional clear. Used by logout / `stop_sync`.
//!
//! ## Known limitation: file-watcher race
//!
//! `clear_if_after(now)` is called for every upload chunk in
//! `handle_transfer_progress`. The guard only filters chunks whose
//! `event_at` predates `started_at`, which means a chunk fired by an
//! IN-FLIGHT FILE-WATCHER cycle (started before any user upload) will
//! still satisfy `event_at >= started_at` after a fresh `begin`,
//! prematurely clearing the banner.
//!
//! Concrete scenario:
//!  1. File-watcher detects a save at T0; sync cycle begins; file A
//!     starts encrypting/uploading.
//!  2. User clicks Upload at T1 > T0; `begin` stamps `started_at = T1`.
//!  3. File A's first upload chunk fires at T2 > T1; `clear_if_after`
//!     sees `T2 >= T1` and clears the banner — even though that chunk
//!     was for the watcher's file, not the user's upload.
//!
//! The banner flickers off prematurely; the bottom-right widget will
//! still show progress for the user's upload once their files start
//! transferring. Properly fixing this would require a session-identity
//! model (track which sync session each chunk belongs to and require
//! a match against the session that began after `started_at`). That's
//! a larger refactor for a low-frequency edge case — accepted as a
//! v1 limitation.

use std::sync::Mutex;
use std::time::Instant;

#[derive(Default)]
struct UploadProcessingInner {
    pending_files: u64,
    started_at: Option<Instant>,
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

    /// Increment `pending_files` by `count` and stamp `started_at` if
    /// not already set. Emits `hcfs_upload_processing` with
    /// `{ active: true, pending_files }`.
    ///
    /// Called from `add_file` / `add_files` / `add_folder` AFTER the
    /// eligibility check (so an ineligible user never sees a flash) and
    /// BEFORE the disk copy (so the banner appears the moment real work
    /// starts).
    pub fn begin(&self, app: &tauri::AppHandle, count: u64) {
        let pending = {
            let mut g = self.inner.lock().expect("upload_processing mutex poisoned");
            g.pending_files = g.pending_files.saturating_add(count);
            if g.started_at.is_none() {
                g.started_at = Some(Instant::now());
            }
            g.pending_files
        };
        emit(app, true, pending);
    }

    /// Clear state if `event_at` is at or after `started_at`. No-op when
    /// inactive or when the event predates the current upload session
    /// (file-watcher activity from before any user upload). Idempotent.
    ///
    /// Called from `handle_transfer_progress` for the first upload-direction
    /// chunk of any file, and from `SyncCompleted` / non-cancel `SyncError`
    /// terminal paths.
    pub fn clear_if_after(&self, app: &tauri::AppHandle, event_at: Instant) {
        let did_clear = {
            let mut g = self.inner.lock().expect("upload_processing mutex poisoned");
            match g.started_at {
                Some(started_at) if event_at >= started_at => {
                    g.pending_files = 0;
                    g.started_at = None;
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

    /// Test-only entry point that mirrors [`Self::begin`] without
    /// emitting a Tauri event. Production code calls `begin`.
    #[cfg(test)]
    fn begin_for_test(&self, count: u64) {
        let mut g = self.inner.lock().expect("upload_processing mutex poisoned");
        g.pending_files = g.pending_files.saturating_add(count);
        if g.started_at.is_none() {
            g.started_at = Some(Instant::now());
        }
    }

    /// Test-only entry point that mirrors [`Self::clear_if_after`] without
    /// emitting a Tauri event.
    #[cfg(test)]
    fn clear_if_after_for_test(&self, event_at: Instant) {
        let mut g = self.inner.lock().expect("upload_processing mutex poisoned");
        if let Some(started_at) = g.started_at {
            if event_at >= started_at {
                g.pending_files = 0;
                g.started_at = None;
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
    fn begin_then_clear_after_start_zeros_state() {
        let s = UploadProcessingState::new();
        s.begin_for_test(3);
        let (active_before, count_before) = s.snapshot();
        assert!(active_before);
        assert_eq!(count_before, 3);

        s.clear_if_after_for_test(Instant::now() + Duration::from_millis(1));
        let (active_after, count_after) = s.snapshot();
        assert!(!active_after);
        assert_eq!(count_after, 0);
    }

    #[test]
    fn clear_with_earlier_instant_is_noop() {
        let s = UploadProcessingState::new();
        let earlier = Instant::now();
        // sleep a tick so the begin's started_at is strictly later
        std::thread::sleep(Duration::from_millis(2));
        s.begin_for_test(2);

        s.clear_if_after_for_test(earlier);
        let (active, count) = s.snapshot();
        assert!(active, "earlier-instant clear must not fire");
        assert_eq!(count, 2);
    }

    #[test]
    fn sequential_begins_accumulate() {
        let s = UploadProcessingState::new();
        s.begin_for_test(4);
        s.begin_for_test(3);
        let (active, count) = s.snapshot();
        assert!(active);
        assert_eq!(count, 7);
    }

    #[test]
    fn second_begin_does_not_restamp_started_at() {
        let s = UploadProcessingState::new();
        s.begin_for_test(1);
        let first_stamp = s.started_at_for_test();
        assert!(first_stamp.is_some());
        // Sleep so a faulty re-stamp implementation would produce a
        // strictly-later Instant on the second call.
        std::thread::sleep(Duration::from_millis(2));
        s.begin_for_test(1);
        let second_stamp = s.started_at_for_test();
        assert_eq!(first_stamp, second_stamp, "begin must not restamp started_at while active");
    }

    #[test]
    fn clear_when_inactive_is_noop() {
        let s = UploadProcessingState::new();
        s.clear_if_after_for_test(Instant::now());
        let (active, count) = s.snapshot();
        assert!(!active);
        assert_eq!(count, 0);
    }

    #[test]
    fn reset_unconditionally_clears() {
        let s = UploadProcessingState::new();
        s.begin_for_test(5);
        s.reset_for_test();
        let (active, count) = s.snapshot();
        assert!(!active);
        assert_eq!(count, 0);
    }
}
