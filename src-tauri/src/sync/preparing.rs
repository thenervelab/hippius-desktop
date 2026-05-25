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
//! - [`PreparingState::drain_expired`] — the watchdog backstop. The
//!   normal-path clears above assume every `SyncStarted` is eventually
//!   followed by a terminal event (or a files-populated snapshot) for
//!   that label. hcfs-client violates that on at least one path: if a
//!   drive leaves the registry between `run_sync_cycle` (which emitted
//!   `SyncStarted`) and `dispatch_sync_result`, `trigger_sync_for_drive`
//!   early-returns (`hcfs-client engine/runner.rs`, "Drive removed
//!   during sync") emitting NO terminal event, and a no-op cycle never
//!   produces a files-populated snapshot either. Without a backstop the
//!   label is stranded in the set forever and the widget/tray show
//!   "Preparing sync…" until an unrelated later action. The watchdog
//!   self-expires any label that has been preparing longer than
//!   [`PREPARING_WATCHDOG_TIMEOUT`]. This mirrors the proven
//!   [`crate::sync::upload_processing`] banner watchdog — see that
//!   module's note on why a pure elapsed-timeout (not an
//!   `Instant`-ordering / liveness guard) is the correct shape.
//!
//! ## Concurrency
//!
//! All methods are synchronous and lock the inner [`Mutex`] only for
//! the duration of the operation; the guard is always dropped before
//! returning (the watchdog `.await`s on the returned `Vec`, never
//! across the guard — compatible with the project's async-lock
//! hygiene axiom). The TauriSyncBridge handlers that invoke
//! `mark_preparing`/`clear` are synchronous.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::{Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use hcfs_client::engine::runner::SyncRunner;

/// Hard cap on how long a single label may stay in the preparing set
/// before the watchdog force-clears it. The legitimate preparing window
/// (watcher debounce + `scan_local_files` + `fetch_remote_state`) is
/// seconds; a cycle still preparing after a full minute has either hung
/// or lost its terminal event (the hcfs-client "drive removed during
/// sync" path). 60s matches the sibling
/// [`crate::sync::upload_processing`] banner timeout so the two
/// "stuck UI state" backstops behave identically (it uses
/// `Duration::from_mins(1)` — same value, same idiom).
pub const PREPARING_WATCHDOG_TIMEOUT: Duration = Duration::from_mins(1);

/// How often the watchdog scans for expired labels. 10s caps observable
/// lateness (a stuck override clears within `TIMEOUT + SCAN_INTERVAL` of
/// the missing terminal event) while keeping the idle wakeup rate
/// negligible. Mirrors the upload-processing scan cadence.
pub const PREPARING_WATCHDOG_SCAN_INTERVAL: Duration = Duration::from_secs(10);

/// Per-label state held inside the map.
///
/// `marked_at` is stamped once, on the first `SyncStarted` of a
/// preparing window, and is deliberately NOT refreshed by subsequent
/// duplicate `SyncStarted`s within the same window (see
/// [`PreparingState::mark_preparing`]). This bounds the *total*
/// preparing lifetime even under a file-watcher retrigger storm — a
/// re-stamp-on-duplicate design would let such a storm reset the timer
/// forever and defeat the watchdog.
struct PreparingInner {
    marked_at: Instant,
}

/// Map of drive labels currently in the "preparing" window between
/// `SyncStarted` and the first ProgressSnapshot that has files.
///
/// Owned by [`crate::app_state::AppState`] behind an `Arc`, mirroring
/// the [`crate::sync::upload_processing::UploadProcessingState`]
/// composition pattern. The value carries the timestamp the watchdog
/// needs; membership semantics are otherwise unchanged from the
/// original set — a label is "preparing" iff it is a key here.
pub struct PreparingState {
    inner: Mutex<HashMap<String, PreparingInner>>,
}

impl Default for PreparingState {
    fn default() -> Self {
        Self::new()
    }
}

impl PreparingState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Acquire the inner mutex with a single poison-message helper.
    ///
    /// Centralises the `expect` panic message so a future addition to
    /// the API can't introduce a new wording variant. The returned
    /// guard's lifetime is tied to `&self`; each public method holds it
    /// for the smallest possible scope (no `.await` under the guard;
    /// the project axiom forbidding sync-mutex-across-await applies if a
    /// future caller adds async code here).
    fn lock(&self) -> MutexGuard<'_, HashMap<String, PreparingInner>> {
        self.inner.lock().expect("preparing mutex poisoned")
    }

    /// Insert `label` into the preparing set, stamping `now` as its
    /// mark time on first insert only.
    ///
    /// Split out from [`Self::mark_preparing`] so tests can inject a
    /// deterministic `now` without sleeping (mirrors
    /// `UploadProcessingState`'s `*_at` test seam). Returns `true` if
    /// the label was newly added; `false` if it was already present —
    /// and on the `false` path the existing `marked_at` is preserved,
    /// NOT refreshed, so the watchdog measures from the first
    /// `SyncStarted` of the window.
    fn mark_at(&self, now: Instant, label: &str) -> bool {
        match self.lock().entry(label.to_string()) {
            Entry::Occupied(_) => false,
            Entry::Vacant(slot) => {
                slot.insert(PreparingInner { marked_at: now });
                true
            }
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
        self.mark_at(Instant::now(), label)
    }

    /// Remove `label` from the preparing set.
    ///
    /// Returns `true` if the label was present (caller can use this
    /// to skip a redundant `emit_snapshot` when nothing changed).
    pub fn clear(&self, label: &str) -> bool {
        self.lock().remove(label).is_some()
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

    /// Remove and return every label that has been preparing for at
    /// least [`PREPARING_WATCHDOG_TIMEOUT`] as measured from `now`.
    ///
    /// `now` is injected (not read internally) so tests are
    /// deterministic without sleeping — and so a single scan compares
    /// every entry against one consistent clock reading. Labels are
    /// returned sorted for deterministic emit/log order; the FE does
    /// not depend on order but the inline tests do.
    ///
    /// `now.checked_duration_since(marked_at)` is `None` when the
    /// monotonic clock appears to have gone backwards (`now <
    /// marked_at`); such an entry is treated as "not yet expired"
    /// rather than panicking or clearing a still-active preparing
    /// state. Mirrors `UploadProcessingState::drain_expired`.
    ///
    /// The guard is dropped before returning, so the watchdog may
    /// freely `.await` on the returned `Vec` (axiom Async Lock
    /// Hygiene).
    fn drain_expired(&self, now: Instant) -> Vec<String> {
        let mut g = self.lock();
        let mut stale: Vec<String> = g
            .iter()
            .filter_map(|(label, entry)| {
                now.checked_duration_since(entry.marked_at)
                    .filter(|elapsed| *elapsed >= PREPARING_WATCHDOG_TIMEOUT)
                    .map(|_| label.clone())
            })
            .collect();
        for label in &stale {
            g.remove(label);
        }
        drop(g);
        stale.sort();
        stale
    }

    /// Sorted snapshot of the current set, for tests and diagnostics.
    /// Not on the hot path — produces a fresh `Vec` per call.
    #[doc(hidden)]
    pub fn snapshot_labels(&self) -> Vec<String> {
        let mut labels: Vec<String> = self.lock().keys().cloned().collect();
        labels.sort();
        labels
    }
}

/// Spawn the background watchdog that force-clears stuck preparing
/// labels.
///
/// The normal-path clears (`SyncCompleted`/`SyncError`/`SyncStopped`,
/// files-populated `ProgressSnapshot`) assume hcfs-client always emits
/// a terminal event after `SyncStarted`. It does not on the
/// "drive removed during sync" early-return, and a no-op cycle never
/// produces a files-populated snapshot — so without this backstop a
/// file-watcher-triggered cycle can strand a label in the set and pin
/// the widget/tray on "Preparing sync…" indefinitely (the user-
/// reported bug). Every [`PREPARING_WATCHDOG_SCAN_INTERVAL`] this
/// drains any label older than [`PREPARING_WATCHDOG_TIMEOUT`] and, when
/// something was drained, forces one snapshot emit so the FE re-derives
/// with `is_any_preparing() == false` and drops the override.
///
/// Holds `Weak` handles (mirroring
/// [`crate::sync::upload_processing::spawn_watchdog`]) so the task does
/// not keep `AppState`/`SyncRunner` alive past app shutdown — it exits
/// when either is dropped. One emit clears the override for all drained
/// labels at once (the override is global on `is_any_preparing`), so
/// there is no per-label emit.
pub fn spawn_watchdog(state: Weak<PreparingState>, sync: Weak<SyncRunner>) {
    // `tauri::async_runtime::spawn`, not `tokio::spawn`: our caller is
    // Tauri's `setup` closure, which is not running inside a tokio
    // runtime context, so `tokio::spawn`/`tokio::time::sleep` would
    // panic at boot. Tauri's `async_runtime` is tokio underneath, so
    // the inner `sleep` is fine. Same rationale as
    // `upload_processing::spawn_watchdog`.
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(PREPARING_WATCHDOG_SCAN_INTERVAL).await;
            let Some(state) = state.upgrade() else {
                tracing::debug!("preparing watchdog: state dropped, exiting");
                break;
            };
            let cleared = state.drain_expired(Instant::now());
            // Drop the strong ref before any further work so we never
            // extend AppState's lifetime across the (cheap) emit.
            drop(state);
            if cleared.is_empty() {
                continue;
            }
            for label in &cleared {
                tracing::warn!(
                    label = %label,
                    timeout_secs = PREPARING_WATCHDOG_TIMEOUT.as_secs(),
                    "auto-clearing stuck preparing override (no terminal sync \
                     event arrived — likely the hcfs-client drive-removed-mid-\
                     cycle path)",
                );
            }
            // One forced emit re-runs `apply_preparing_override` with an
            // empty set, so the widget/tray leave "Preparing sync…".
            // `immediate=true` bypasses the snapshot throttle. If the
            // runner is already gone the override is moot anyway.
            if let Some(sync) = sync.upgrade() {
                sync.emit_snapshot(true);
            }
        }
    });
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
    /// refactor that extended the guard's lifetime would deadlock at
    /// runtime.
    #[test]
    fn mark_then_read_does_not_deadlock_in_sequence() {
        let state = PreparingState::new();
        assert!(state.mark_preparing("drive-a"));
        assert!(state.is_any_preparing());
        assert_eq!(state.snapshot_labels(), vec!["drive-a".to_string()]);
        assert!(state.clear("drive-a"));
        assert!(!state.is_any_preparing());
    }

    // ── Watchdog backstop ────────────────────────────────────────────

    /// A label that has been preparing longer than the timeout is
    /// drained and returned; the set no longer contains it. This is
    /// the core stuck-"Preparing sync…" fix: the missing-terminal-event
    /// path can't strand a label forever.
    #[test]
    fn drain_expired_removes_label_older_than_timeout() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        assert!(state.mark_at(t0, "drive-a"));
        let later = t0 + PREPARING_WATCHDOG_TIMEOUT + Duration::from_secs(1);
        assert_eq!(state.drain_expired(later), vec!["drive-a".to_string()]);
        assert!(!state.is_any_preparing());
    }

    /// A label still within its window is left untouched — the
    /// watchdog must not cut short a legitimately-preparing cycle.
    #[test]
    fn drain_expired_keeps_fresh_label() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        state.mark_at(t0, "drive-a");
        let soon = t0 + Duration::from_secs(5);
        assert!(state.drain_expired(soon).is_empty());
        assert_eq!(state.snapshot_labels(), vec!["drive-a".to_string()]);
    }

    /// Duplicate `SyncStarted`s within a window must NOT refresh
    /// `marked_at`. A file-watcher retrigger storm re-marking the same
    /// label every few seconds would otherwise reset the timer forever
    /// and defeat the watchdog. The label must still expire measured
    /// from the FIRST mark.
    #[test]
    fn duplicate_mark_does_not_extend_timeout() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        state.mark_at(t0, "drive-a");
        // Re-marked well into the window (simulating a watcher storm).
        let restamp_attempt = t0 + PREPARING_WATCHDOG_TIMEOUT - Duration::from_secs(1);
        assert!(!state.mark_at(restamp_attempt, "drive-a"));
        // Past the timeout relative to the FIRST mark only.
        let later = t0 + PREPARING_WATCHDOG_TIMEOUT + Duration::from_secs(1);
        assert_eq!(state.drain_expired(later), vec!["drive-a".to_string()]);
    }

    /// Clock-skew guard: if the supplied `now` precedes `marked_at`
    /// (`checked_duration_since` → `None`), the entry is treated as
    /// not-yet-expired, never drained, never panics.
    #[test]
    fn drain_expired_ignores_entry_marked_in_the_future() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        state.mark_at(t0 + Duration::from_secs(120), "drive-a");
        assert!(state.drain_expired(t0).is_empty());
        assert_eq!(state.snapshot_labels(), vec!["drive-a".to_string()]);
    }

    #[test]
    fn drain_expired_on_empty_returns_empty() {
        let state = PreparingState::new();
        assert!(state.drain_expired(Instant::now()).is_empty());
    }
}
