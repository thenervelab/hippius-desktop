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
