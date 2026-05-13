//! Per-label tracking of the "processing" window between a
//! user-initiated upload IPC call and the first byte of upload progress
//! for a sync cycle that began AFTER the upload was registered.
//!
//! The frontend renders a top-of-page banner per drive while
//! `is_active_for(label)` returns `true` for that label.
//!
//! ## Why per-label
//!
//! An earlier design held a single process-wide
//! `UploadProcessingInner`. That conflated "this drive has an IPC
//! banner" with "any drive has an IPC banner" — so if the user clicked
//! Upload on drive A and then a file-watcher cycle fired on drive B,
//! the `SyncStarted` arm of [`crate::sync::tauri_bridge::TauriSyncBridge`]
//! would consult the global `snapshot()` and incorrectly suppress
//! drive B's `mark_preparing` call. The user saw nothing on drive B
//! during scan + remote-state-fetch even though that drive had no
//! IPC banner of its own. Per-label state isolates the two drives.
//!
//! Mirrors the [`crate::sync::preparing::PreparingState`] and
//! [`crate::sync::credits_exhausted::CreditsExhaustedState`]
//! composition pattern exactly.
//!
//! ## Lifecycle (per label)
//!
//! - `begin(label, count, current_epoch)` — called from `add_file` /
//!   `add_files` / `add_folder` after the eligibility check, before
//!   the disk copy. Increments the label's pending count and, on the
//!   activating call (when the label has no entry), stamps
//!   `started_at` and `stamped_epoch`. The epoch comes from
//!   `AppState::sync_session_epoch`, which increments on every
//!   `SyncStarted` event.
//! - `clear_if_session_advanced(label, event_epoch)` — called from
//!   `handle_transfer_progress` (per upload chunk), `SyncCompleted`,
//!   and `SyncError` for THAT label. Clears the label's entry only
//!   when `event_epoch > stamped_epoch`, i.e. when the event is from
//!   a sync cycle that began AFTER the activating `begin`. Events
//!   from a cycle that was already running when the user clicked
//!   Upload do not satisfy the guard, so they cannot prematurely
//!   clear the banner.
//! - `reset(label)` — unconditional clear for a single label.
//!   Used by IPC error paths in `files.rs` (begin-then-fail), and by
//!   the `add_files` "all-failed" guard.
//! - `reset_all()` — unconditional clear of every label.
//!   Used by logout / `stop_sync` (the process-wide path that resets
//!   every drive at once).
//! - `is_active_for(label) -> bool` — read used by the bridge's
//!   `SyncStarted` arm to decide whether the file-watcher "preparing"
//!   override is needed for THIS label. Returns `true` iff the label
//!   has an entry with `started_at = Some(_)`.
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
//!
//! ## Concurrency
//!
//! The inner `std::sync::Mutex` is locked only for the duration of a
//! single map operation. The bridge handlers that invoke these methods
//! are synchronous (`SyncEventHandler::on_event` has no `.await`), so
//! the sync-mutex-across-await axiom holds by construction. Each
//! public method drops its `MutexGuard` at the function boundary —
//! the load-bearing re-entrancy invariant from the bridge handler
//! that calls a write method and then re-enters this module via
//! `emit_snapshot` → `ProgressSnapshot` → reads.
//!
//! ## Watchdog (Task 4.2)
//!
//! [`spawn_watchdog`] starts a background tokio task that periodically
//! scans the map and clears entries whose `last_set_at` is older than
//! [`BANNER_WATCHDOG_TIMEOUT`]. This is the time-based safety net for
//! the case where a sync cycle never starts (e.g., the drive is
//! queued behind another drive's per-drive mutex) — without it, the
//! banner sat forever until app restart (original Bug 1 symptom: the
//! "2-minute stuck toast" report). The watchdog complements, never
//! replaces, the epoch-gated `clear_if_session_advanced` and the
//! explicit `reset` / `reset_all` paths.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

/// How long an entry may sit without a progress signal before the
/// background watchdog clears it.
///
/// **Why 60s:** Long enough to absorb normal queueing (a drive can sit
/// behind another drive's per-drive sync mutex for tens of seconds on
/// a slow upload), short enough that a truly stuck banner does not
/// burn minutes of user attention. The pre-watchdog behavior was
/// "wait for app restart" — any finite timeout is a strict
/// improvement, and 60s is the plan's recommended value.
pub const BANNER_WATCHDOG_TIMEOUT: Duration = Duration::from_mins(1);

/// How often the watchdog scans the map.
///
/// **Why 10s:** Lower would burn CPU walking an almost-always-empty
/// `HashMap`; higher would let a stuck banner linger past the 60s
/// timeout by up to the scan interval. 10s caps observable lateness
/// at ~70s (timeout + one scan period), which is well within the
/// "noticeable but not painful" range.
pub const BANNER_WATCHDOG_SCAN_INTERVAL: Duration = Duration::from_secs(10);

/// Per-label state held inside the `HashMap`.
struct UploadProcessingInner {
    pending_files: u64,
    started_at: Option<Instant>,
    /// Sync-cycle epoch at the time of the activating `begin` call.
    /// Used by `clear_if_session_advanced` to gate clearing on
    /// "an event from a NEWER cycle" rather than the broken
    /// wall-clock timestamp comparison. `None` exactly when
    /// `started_at` is `None`; the two fields move together.
    stamped_epoch: Option<u64>,
    /// Refreshed on `begin` and on every `clear_if_session_advanced`
    /// call (whether or not it cleared — every event counts as a
    /// progress signal). Read by [`UploadProcessingState::drain_expired`]
    /// to gate the watchdog's auto-clear against the
    /// [`BANNER_WATCHDOG_TIMEOUT`] window.
    ///
    /// Stored unconditionally (no `Option`) because every code path
    /// that creates an entry initializes this field — the type encodes
    /// that invariant rather than relying on documentation.
    last_set_at: Instant,
}

impl UploadProcessingInner {
    /// Construct a fresh entry with `last_set_at` stamped to `now`.
    ///
    /// Centralises the construction so a future field addition
    /// can't introduce a half-initialised entry through
    /// `HashMap::entry().or_default()` (which is exactly why this
    /// struct intentionally does NOT derive `Default`).
    fn new(now: Instant) -> Self {
        Self {
            pending_files: 0,
            started_at: None,
            stamped_epoch: None,
            last_set_at: now,
        }
    }
}

/// Map of drive label → "processing window" state.
///
/// Owned by [`crate::app_state::AppState`] behind an `Arc`, matching
/// the [`crate::sync::preparing::PreparingState`] /
/// [`crate::sync::credits_exhausted::CreditsExhaustedState`] pattern.
pub struct UploadProcessingState {
    /// `HashMap<String, _>` keyed by drive label. Membership in the
    /// map ⇔ "banner active for that label". A label is removed on
    /// `clear_if_session_advanced` (gate fires), `reset(label)`, and
    /// `reset_all()`. The map's iteration order is unspecified, but
    /// the bridge never iterates — every read goes through
    /// `is_active_for(label)`, so no order-sensitivity is exposed.
    inner: Mutex<HashMap<String, UploadProcessingInner>>,
}

impl Default for UploadProcessingState {
    fn default() -> Self {
        Self::new()
    }
}

impl UploadProcessingState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Acquire the inner mutex with a single poison-message helper.
    ///
    /// Centralises the `expect` panic message so a future addition to
    /// the API can't introduce a new wording variant. Poison is fatal
    /// because the bridge is the single writer — if it panicked while
    /// holding the guard, the per-label invariant the state encodes
    /// is already corrupt.
    fn lock(&self) -> MutexGuard<'_, HashMap<String, UploadProcessingInner>> {
        self.inner.lock().expect("upload_processing mutex poisoned")
    }

    /// Returns `true` when `label` currently has an active banner.
    ///
    /// Used by `TauriSyncBridge::on_event` `SyncStarted` arm to decide
    /// whether the file-watcher "preparing" widget override should be
    /// applied for THIS label. The previous global `snapshot()` check
    /// is what caused Bug 4 (cross-drive suppression).
    pub fn is_active_for(&self, label: &str) -> bool {
        self.lock().get(label).is_some_and(|i| i.started_at.is_some())
    }

    /// Test/diagnostic snapshot for a single label: `(active, pending_files)`.
    #[doc(hidden)]
    pub fn snapshot_for(&self, label: &str) -> (bool, u64) {
        match self.lock().get(label) {
            Some(i) => (i.started_at.is_some(), i.pending_files),
            None => (false, 0),
        }
    }

    /// Increment `pending_files` for `label` by `count`. On the
    /// activating call (when the label has no entry), insert a fresh
    /// entry with `started_at = Some(Instant::now())` and
    /// `stamped_epoch = Some(current_epoch)`. Emits
    /// `hcfs_upload_processing` with `{ label, active: true, pending_files }`.
    ///
    /// `current_epoch` is the value of
    /// `AppState::sync_session_epoch.load(Ordering::SeqCst)` at the
    /// time of the call. Subsequent begins for the same label while
    /// active accumulate the count but do NOT restamp epoch — the
    /// original epoch must survive so `clear_if_session_advanced` can
    /// correctly gate on "did a new cycle start since the FIRST begin
    /// in this window."
    pub fn begin(&self, app: &tauri::AppHandle, label: &str, count: u64, current_epoch: u64) {
        let pending = {
            let now = Instant::now();
            let mut g = self.lock();
            let entry = g.entry(label.to_string()).or_insert_with(|| UploadProcessingInner::new(now));
            entry.pending_files = entry.pending_files.saturating_add(count);
            // First begin in a window stamps started_at + epoch.
            // Subsequent begins inside an already-active window must
            // not restamp those (epoch-gating depends on the first
            // begin's epoch surviving). last_set_at IS refreshed on
            // every begin so the watchdog's "no progress for 60s"
            // timer resets when the user clicks Upload again.
            if entry.started_at.is_none() {
                entry.started_at = Some(now);
                entry.stamped_epoch = Some(current_epoch);
            }
            entry.last_set_at = now;
            entry.pending_files
        };
        emit(app, label, true, pending);
    }

    /// Clear `label`'s entry if `event_epoch > stamped_epoch`. No-op
    /// when the label has no entry or when the event is from a cycle
    /// that was already running at `begin` time. Idempotent.
    ///
    /// Side-effect: every call refreshes `last_set_at` on the
    /// surviving entry. This is what makes the call site (per upload
    /// chunk, `SyncCompleted`, `SyncError`) act as a "progress signal"
    /// from the watchdog's perspective — events from the same cycle
    /// extend the window even though the epoch gate keeps the banner
    /// up. Without this, an in-flight cycle whose chunks keep firing
    /// at the original epoch would have its banner cleared by the
    /// watchdog despite progress being visible.
    pub fn clear_if_session_advanced(&self, app: &tauri::AppHandle, label: &str, event_epoch: u64) {
        let did_clear = {
            let now = Instant::now();
            let mut g = self.lock();
            let should_remove = matches!(g.get(label).and_then(|i| i.stamped_epoch), Some(stamped) if event_epoch > stamped);
            if should_remove {
                g.remove(label);
                true
            } else {
                if let Some(entry) = g.get_mut(label) {
                    entry.last_set_at = now;
                }
                false
            }
        };
        if did_clear {
            emit(app, label, false, 0);
        }
    }

    /// Unconditional clear for a single label. Used by IPC error
    /// paths in `files.rs` and the `add_files` "all-failed" guard.
    pub fn reset(&self, app: &tauri::AppHandle, label: &str) {
        let did_clear = self.lock().remove(label).is_some();
        if did_clear {
            emit(app, label, false, 0);
        }
    }

    /// Remove every entry whose `last_set_at` is more than
    /// [`BANNER_WATCHDOG_TIMEOUT`] before `now`. Returns the sorted
    /// list of cleared labels so the caller can emit one
    /// `{ active: false, pending_files: 0 }` event per cleared banner
    /// outside the lock.
    ///
    /// Pure with respect to `now` — the caller injects the timestamp
    /// rather than reading the wall clock here. That keeps the
    /// watchdog tests timestamp-precise without requiring
    /// `tokio::time::pause` to also affect [`std::time::Instant::now`]
    /// (which it does not on stable tokio).
    ///
    /// The `std::sync::MutexGuard` is dropped before this function
    /// returns; callers may freely `.await` on the returned `Vec`
    /// without holding the lock across the await point (axiom
    /// `Async Lock Hygiene`).
    fn drain_expired(&self, now: Instant) -> Vec<String> {
        let mut g = self.lock();
        let stale: Vec<String> = g
            .iter()
            .filter_map(|(label, entry)| {
                now.checked_duration_since(entry.last_set_at)
                    .filter(|elapsed| *elapsed >= BANNER_WATCHDOG_TIMEOUT)
                    .map(|_| label.clone())
            })
            .collect();
        for label in &stale {
            g.remove(label);
        }
        drop(g);
        let mut stale = stale;
        stale.sort();
        stale
    }

    /// Unconditional clear of every label. Used by logout /
    /// `stop_sync` where every drive is torn down at once.
    ///
    /// Emits one `{ label, active: false, pending_files: 0 }` event
    /// per previously-active label so per-drive FE banners all clear.
    /// Sorting the drained labels keeps the emit order deterministic
    /// for tests; the FE does not depend on order, but the inline
    /// `reset_all_emits_per_label` test does.
    pub fn reset_all(&self, app: &tauri::AppHandle) {
        let mut labels: Vec<String> = {
            let mut g = self.lock();
            g.drain().map(|(k, _)| k).collect()
        };
        labels.sort();
        for label in labels {
            emit(app, &label, false, 0);
        }
    }

    /// Test-only accessor exposing the internal `started_at` so tests
    /// can assert that subsequent `begin` calls during an active
    /// window do not re-stamp the original start time.
    #[cfg(test)]
    fn started_at_for_test(&self, label: &str) -> Option<std::time::Instant> {
        self.lock().get(label).and_then(|i| i.started_at)
    }

    /// Test-only accessor exposing the internal `stamped_epoch`.
    #[cfg(test)]
    fn stamped_epoch_for_test(&self, label: &str) -> Option<u64> {
        self.lock().get(label).and_then(|i| i.stamped_epoch)
    }

    /// Test-only entry point that mirrors [`Self::begin`] without
    /// emitting a Tauri event.
    #[cfg(test)]
    fn begin_for_test(&self, label: &str, count: u64, current_epoch: u64) {
        self.begin_for_test_at(Instant::now(), label, count, current_epoch);
    }

    /// Test-only entry point that mirrors [`Self::begin`] but with an
    /// injectable `Instant` for the `last_set_at` field. Exposes the
    /// timestamp axis to watchdog tests that must construct
    /// known-old entries.
    ///
    /// Exposed as `pub` + `#[doc(hidden)]` (mirroring `snapshot_for`)
    /// so the integration test crate in `tests/` can drive it without
    /// needing `pub(crate)` visibility leaks. The `#[doc(hidden)]`
    /// keeps it out of rustdoc; the name + path keep it discoverable
    /// only to tests that already know the watchdog internals.
    #[doc(hidden)]
    pub fn begin_for_test_at(&self, now: Instant, label: &str, count: u64, current_epoch: u64) {
        let mut g = self.lock();
        let entry = g.entry(label.to_string()).or_insert_with(|| UploadProcessingInner::new(now));
        entry.pending_files = entry.pending_files.saturating_add(count);
        if entry.started_at.is_none() {
            entry.started_at = Some(now);
            entry.stamped_epoch = Some(current_epoch);
        }
        entry.last_set_at = now;
    }

    /// Test-only entry point that mirrors [`Self::clear_if_session_advanced`]
    /// without emitting a Tauri event. Allows the watchdog tests to
    /// drive the "progress signal refreshes last_set_at" path with a
    /// known `Instant`.
    #[doc(hidden)]
    pub fn clear_if_session_advanced_for_test_at(&self, now: Instant, label: &str, event_epoch: u64) {
        let mut g = self.lock();
        let should_remove = matches!(g.get(label).and_then(|i| i.stamped_epoch), Some(stamped) if event_epoch > stamped);
        if should_remove {
            g.remove(label);
        } else if let Some(entry) = g.get_mut(label) {
            entry.last_set_at = now;
        }
    }

    /// Test-only entry point that mirrors [`Self::clear_if_session_advanced`]
    /// without emitting a Tauri event.
    #[cfg(test)]
    fn clear_if_session_advanced_for_test(&self, label: &str, event_epoch: u64) {
        self.clear_if_session_advanced_for_test_at(Instant::now(), label, event_epoch);
    }

    /// Test-only entry point that exposes [`Self::drain_expired`] to
    /// the integration test crate. Same `pub` + `#[doc(hidden)]` shape
    /// as the other watchdog helpers.
    #[doc(hidden)]
    pub fn drain_expired_for_test(&self, now: Instant) -> Vec<String> {
        self.drain_expired(now)
    }

    /// Test-only entry point that mirrors [`Self::reset`] without
    /// emitting a Tauri event.
    #[cfg(test)]
    fn reset_for_test(&self, label: &str) {
        self.lock().remove(label);
    }

    /// Test-only sorted view of active labels, for asserting
    /// cross-label isolation invariants.
    #[cfg(test)]
    fn active_labels_for_test(&self) -> Vec<String> {
        let mut labels: Vec<String> = self.lock().keys().cloned().collect();
        labels.sort();
        labels
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UploadProcessingPayload {
    /// The drive label this banner state belongs to. Frontend uses
    /// this to route the payload to the matching drive's banner; an
    /// older single-banner-per-process FE listener would ignore it.
    label: String,
    active: bool,
    pending_files: u64,
}

fn emit(app: &tauri::AppHandle, label: &str, active: bool, pending_files: u64) {
    use tauri::Emitter;
    let _ = app.emit(
        crate::sync::events::UPLOAD_PROCESSING,
        UploadProcessingPayload {
            label: label.to_string(),
            active,
            pending_files,
        },
    );
}

/// Spawn the per-process upload-processing watchdog.
///
/// Called once at app setup (after `AppState` is constructed). The
/// task wakes every [`BANNER_WATCHDOG_SCAN_INTERVAL`] and clears any
/// entry whose `last_set_at` is older than [`BANNER_WATCHDOG_TIMEOUT`].
///
/// **Ownership:** the task holds a `Weak<UploadProcessingState>` so it
/// does NOT keep the state alive past app shutdown. If the upgrade
/// fails (the `Arc` was dropped), the loop exits cleanly. The
/// `AppHandle` is `Clone` and cheap; one clone per spawn is fine.
///
/// **Concurrency:** the loop awaits a `tokio::time::sleep` between
/// scans. The `std::sync::Mutex` inside `UploadProcessingState` is
/// locked only by [`UploadProcessingState::drain_expired`], which
/// drops its guard before returning a `Vec<String>`. The emit loop
/// runs on the owned `Vec`, so no `MutexGuard` exists during the
/// `.await` (axiom `Async Lock Hygiene`).
pub fn spawn_watchdog(state: Weak<UploadProcessingState>, app: tauri::AppHandle) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(BANNER_WATCHDOG_SCAN_INTERVAL).await;
            let Some(state) = state.upgrade() else {
                // AppState has been dropped; nothing left to watch.
                tracing::debug!("upload_processing watchdog: state dropped, exiting");
                break;
            };
            let cleared = state.drain_expired(Instant::now());
            for label in cleared {
                tracing::warn!(
                    target: "hippius_desktop::sync::upload_processing",
                    label = %label,
                    timeout_secs = BANNER_WATCHDOG_TIMEOUT.as_secs(),
                    "auto-clearing stale upload-processing banner",
                );
                emit(&app, &label, false, 0);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn begin_then_clear_with_advanced_epoch_zeros_state() {
        let s = UploadProcessingState::new();
        s.begin_for_test("drive-a", 3, 1);
        let (active_before, count_before) = s.snapshot_for("drive-a");
        assert!(active_before);
        assert_eq!(count_before, 3);
        assert_eq!(s.stamped_epoch_for_test("drive-a"), Some(1));

        s.clear_if_session_advanced_for_test("drive-a", 2);
        let (active_after, count_after) = s.snapshot_for("drive-a");
        assert!(!active_after);
        assert_eq!(count_after, 0);
        assert_eq!(s.stamped_epoch_for_test("drive-a"), None);
    }

    #[test]
    fn clear_with_same_or_earlier_epoch_is_noop() {
        let s = UploadProcessingState::new();
        s.begin_for_test("drive-a", 2, 5);
        // event_epoch == stamped_epoch — must not clear (the cycle
        // was already running when begin was called).
        s.clear_if_session_advanced_for_test("drive-a", 5);
        let (active, count) = s.snapshot_for("drive-a");
        assert!(active, "same-epoch event must not clear");
        assert_eq!(count, 2);

        // event_epoch < stamped_epoch — must also not clear.
        s.clear_if_session_advanced_for_test("drive-a", 4);
        let (active, count) = s.snapshot_for("drive-a");
        assert!(active, "earlier-epoch event must not clear");
        assert_eq!(count, 2);
    }

    #[test]
    fn sequential_begins_accumulate() {
        let s = UploadProcessingState::new();
        s.begin_for_test("drive-a", 4, 1);
        s.begin_for_test("drive-a", 3, 1);
        let (active, count) = s.snapshot_for("drive-a");
        assert!(active);
        assert_eq!(count, 7);
    }

    #[test]
    fn clear_when_inactive_is_noop() {
        let s = UploadProcessingState::new();
        s.clear_if_session_advanced_for_test("drive-a", 99);
        let (active, count) = s.snapshot_for("drive-a");
        assert!(!active);
        assert_eq!(count, 0);
    }

    #[test]
    fn reset_unconditionally_clears() {
        let s = UploadProcessingState::new();
        s.begin_for_test("drive-a", 5, 7);
        s.reset_for_test("drive-a");
        let (active, count) = s.snapshot_for("drive-a");
        assert!(!active);
        assert_eq!(count, 0);
        assert_eq!(s.stamped_epoch_for_test("drive-a"), None);
    }

    #[test]
    fn second_begin_does_not_restamp_started_at_or_epoch() {
        let s = UploadProcessingState::new();
        s.begin_for_test("drive-a", 1, 3);
        let first_stamp = s.started_at_for_test("drive-a");
        let first_epoch = s.stamped_epoch_for_test("drive-a");
        assert_eq!(first_epoch, Some(3));
        assert!(first_stamp.is_some());
        std::thread::sleep(Duration::from_millis(2));
        // Second begin uses a different epoch — must not restamp
        // either field while banner is still active.
        s.begin_for_test("drive-a", 1, 9);
        let second_stamp = s.started_at_for_test("drive-a");
        let second_epoch = s.stamped_epoch_for_test("drive-a");
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
        s.begin_for_test("drive-a", 1, 1);
        // File 1's chunks fire (still epoch 1) — must not clear.
        s.clear_if_session_advanced_for_test("drive-a", 1);
        let (active, _) = s.snapshot_for("drive-a");
        assert!(active, "in-flight cycle's chunks must not clear");
        // File 1's cycle completes (still epoch 1) — must not clear.
        s.clear_if_session_advanced_for_test("drive-a", 1);
        let (active, _) = s.snapshot_for("drive-a");
        assert!(active, "in-flight cycle's completion must not clear");
        // File 2's cycle starts (epoch increments to 2) and fires
        // its first chunk — NOW the banner clears.
        s.clear_if_session_advanced_for_test("drive-a", 2);
        let (active, _) = s.snapshot_for("drive-a");
        assert!(!active, "newer cycle's chunk should clear");
    }

    // -----------------------------------------------------------------
    // Per-label invariants (Task 4.1).
    // -----------------------------------------------------------------

    /// Bug 4: an active banner on label-A must NOT make
    /// `is_active_for(label-B)` return `true`. Pre-per-label, the
    /// global `snapshot()` would have leaked across drives and the
    /// `SyncStarted` handler would have suppressed the preparing
    /// widget for drive B.
    #[test]
    fn is_active_for_is_per_label() {
        let s = UploadProcessingState::new();
        s.begin_for_test("drive-a", 1, 1);
        assert!(s.is_active_for("drive-a"));
        assert!(!s.is_active_for("drive-b"), "drive-a's banner must not appear active on drive-b");
        assert!(!s.is_active_for("unknown"), "unknown label must report inactive");
    }

    /// Clearing one label's banner must leave the other label's
    /// entry intact — the original Bug 4 fix has no value if a
    /// drive-A clear could ripple to drive B.
    #[test]
    fn clear_one_label_leaves_others_intact() {
        let s = UploadProcessingState::new();
        s.begin_for_test("drive-a", 2, 1);
        s.begin_for_test("drive-b", 3, 1);
        s.reset_for_test("drive-a");
        assert!(!s.is_active_for("drive-a"));
        assert!(s.is_active_for("drive-b"));
        assert_eq!(s.snapshot_for("drive-b").1, 3);
        assert_eq!(s.active_labels_for_test(), vec!["drive-b".to_string()]);
    }

    /// Epoch gating is per-label: drive-B's epoch advance must not
    /// clear drive-A's banner, and vice versa.
    #[test]
    fn epoch_advance_only_clears_matching_label() {
        let s = UploadProcessingState::new();
        s.begin_for_test("drive-a", 1, 5);
        s.begin_for_test("drive-b", 1, 5);
        // drive-B's cycle advances — must not touch drive-A.
        s.clear_if_session_advanced_for_test("drive-b", 6);
        assert!(s.is_active_for("drive-a"), "drive-a survives drive-b's epoch advance");
        assert!(!s.is_active_for("drive-b"));
        // drive-A's cycle advances — must clear drive-A.
        s.clear_if_session_advanced_for_test("drive-a", 6);
        assert!(!s.is_active_for("drive-a"));
    }

    /// Two labels can hold independent stamped epochs: drive-A at
    /// epoch 3, drive-B at epoch 7, after a sequence of begins
    /// across an epoch boundary. Validates that the second `begin`
    /// for an already-active label still does not restamp.
    #[test]
    fn independent_stamped_epochs_per_label() {
        let s = UploadProcessingState::new();
        s.begin_for_test("drive-a", 1, 3);
        s.begin_for_test("drive-b", 1, 7);
        assert_eq!(s.stamped_epoch_for_test("drive-a"), Some(3));
        assert_eq!(s.stamped_epoch_for_test("drive-b"), Some(7));
        // Second begin on drive-a at a later epoch must not advance
        // the epoch — the running window still belongs to the first
        // begin's cycle.
        s.begin_for_test("drive-a", 1, 9);
        assert_eq!(s.stamped_epoch_for_test("drive-a"), Some(3));
    }

    /// `reset_for_test` on an absent label is a no-op (not a panic).
    /// Idempotency matters for the IPC error paths in `files.rs`
    /// that may call `reset` for a label whose `begin` was skipped
    /// (e.g. zero-file folder upload).
    #[test]
    fn reset_for_unknown_label_is_noop() {
        let s = UploadProcessingState::new();
        s.reset_for_test("never-began");
        assert!(s.active_labels_for_test().is_empty());
        // Still valid to begin afterward.
        s.begin_for_test("never-began", 1, 1);
        assert!(s.is_active_for("never-began"));
    }

    /// Re-entrancy guardrail (parallels `PreparingState`).
    ///
    /// Every public method MUST release the inner mutex before
    /// returning so the bridge can call them in tight sequence on
    /// the same thread. `std::sync::Mutex` is non-reentrant — a
    /// refactor that extended the guard's lifetime (e.g. returning
    /// the guard alongside the value) would deadlock at runtime.
    #[test]
    fn write_then_read_does_not_deadlock_in_sequence() {
        let s = UploadProcessingState::new();
        s.begin_for_test("drive-a", 1, 1);
        // Each of the following reacquires the inner mutex. A
        // regression that broke the lock release would surface as
        // the second call blocking indefinitely.
        assert!(s.is_active_for("drive-a"));
        assert_eq!(s.snapshot_for("drive-a"), (true, 1));
        s.reset_for_test("drive-a");
        assert!(!s.is_active_for("drive-a"));
    }
}
