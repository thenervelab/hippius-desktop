//! Keep-awake during active sync transfers.
//!
//! Testers on macOS reported the machine going to idle-sleep in the middle
//! of a multi-hour upload (a 275 GB folder), killing the transfer. While any
//! sync session still has non-terminal files, the desktop now holds an OS
//! "prevent idle **system** sleep" assertion — exactly what Finder does for
//! the duration of a copy. Display sleep is deliberately never blocked: the
//! screen may turn off, the machine keeps syncing.
//!
//! ## Pieces
//!
//! - [`should_hold_keep_awake`] — the pure resolver. Decides hold-vs-release
//!   from a [`SyncSnapshot`]'s aggregate counters alone (no I/O), so it is
//!   trivially unit-testable and immune to the snapshot file-list cap.
//! - [`SleepBlocker`] / [`SleepGuard`] — the OS seam. The guard is RAII
//!   (drop releases the assertion); tests inject a fake, production uses
//!   [`SyncKeepAwake::new_native`].
//! - [`SyncKeepAwake`] — the edge-triggered orchestrator stored on
//!   `AppState.keep_awake`. `apply` is idempotent per edge: a held assertion
//!   is never re-acquired on the 4 Hz snapshot stream, and release happens on
//!   the FIRST frame whose resolver verdict is "idle" — which is also the
//!   safety net against a missed terminal event (any later snapshot corrects
//!   the state; see `sync::projection::tauri_bridge` for the wiring).
//!
//! ## Platform mapping (via the `keepawake` crate, `idle(true)` only)
//!
//! - macOS: `IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep)`.
//! - Windows: `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` —
//!   no `ES_DISPLAY_REQUIRED`.
//! - Linux: **no-op for v1.** `keepawake`'s Linux backend is the zbus D-Bus
//!   stack (logind / `org.freedesktop.PowerManagement` inhibitors) — a heavy
//!   dependency subtree for a platform where idle-sleep policy varies per
//!   desktop environment and the tester fleet is macOS/Windows. The crate is
//!   therefore a macOS/Windows-only target dependency in `Cargo.toml`;
//!   revisit if Linux users report sleep-interrupted syncs.
//!
//! Process exit needs no special handling: the macOS assertion is
//! process-scoped and the Windows execution state is thread-scoped, so the OS
//! reclaims both when the app dies.

use std::sync::{Mutex, PoisonError};

use tracing::{info, warn};

use crate::sync::progress::SyncSnapshot;

/// Decide whether the system-sleep assertion should be held for `snapshot`.
///
/// Hold exactly when the session is active AND at least one file is not yet
/// terminal (`completed_files + failed_files < total_files`) — i.e. bytes are
/// moving or queued to move. Everything else releases:
///
/// - **Inactive session** (finalized, or no session at all) — idle.
/// - **Empty heartbeat cycle** (`total_files == 0` while active) — the
///   periodic no-op scan transfers nothing; keeping the machine awake for it
///   would hold the assertion ~forever.
/// - **Stalled completion** (all files terminal but `is_active` stuck `true`
///   because the watcher saw the engine's own writes — the same state
///   `sync::progress::fixup_stalled_completion` corrects for the widget) —
///   nothing is transferring, so release rather than pin the machine awake
///   on a session that will never finalize.
///
/// Failed files count as terminal: a cycle whose remaining files all errored
/// is done moving bytes (hcfs-client's retry starts a NEW cycle, whose
/// snapshot re-acquires). The session is account-global (one session, files
/// tagged per drive label), so "one drive finished, another still uploading"
/// is simply a non-terminal remainder here — no per-drive bookkeeping needed.
#[must_use]
pub fn should_hold_keep_awake(snapshot: &SyncSnapshot) -> bool {
    if !snapshot.is_active || snapshot.total_files == 0 {
        return false;
    }
    snapshot.completed_files + snapshot.failed_files < snapshot.total_files
}

/// Failure to acquire the OS sleep assertion.
///
/// Deliberately NOT an [`crate::error::AppError`] variant: acquisition is a
/// best-effort power hint invoked from the sync event stream, never from an
/// IPC command, so it has no frontend to surface to. The orchestrator logs it
/// (`warn!`) and retries on the next snapshot edge.
#[derive(Debug, thiserror::Error)]
#[error("failed to acquire keep-awake assertion: {reason}")]
pub struct AcquireError {
    reason: String,
}

/// A held "prevent idle system sleep" assertion. Dropping releases it.
pub trait SleepGuard: Send {}

/// OS seam for acquiring sleep assertions. Injected into [`SyncKeepAwake`]
/// so orchestration is testable with a fake; production uses the
/// platform-native blocker.
pub trait SleepBlocker: Send + Sync {
    /// Acquire a system-sleep-prevention assertion (never display sleep).
    ///
    /// # Errors
    /// [`AcquireError`] when the OS refuses the assertion (or, on
    /// macOS/Windows, the holder thread cannot be spawned).
    fn acquire(&self) -> Result<Box<dyn SleepGuard>, AcquireError>;
}

#[cfg(any(target_os = "macos", windows))]
mod native {
    use std::sync::mpsc;

    use super::{AcquireError, SleepBlocker, SleepGuard};

    /// Real blocker: parks a `keepawake::KeepAwake` handle on a dedicated
    /// thread for the lifetime of the guard.
    ///
    /// Why a thread instead of holding the handle directly: on Windows the
    /// assertion is `SetThreadExecutionState(ES_CONTINUOUS | ...)`, which is
    /// bound to the CALLING thread — `keepawake`'s create and `Drop` both
    /// call it on whatever thread runs them. Acquired on one tokio worker
    /// and dropped on another, the release would clear the WRONG thread's
    /// state and leave the sleep block held until process exit. Owning the
    /// handle on one dedicated thread makes create and drop happen on the
    /// same thread by construction. On macOS the IOPMAssertion is
    /// process-scoped, so the thread is merely harmless there. It spends its
    /// whole life blocked on a channel `recv` — zero CPU.
    pub(super) struct NativeSleepBlocker;

    struct NativeSleepGuard {
        /// Dropping this sender disconnects the holder thread's `recv`,
        /// which drops the `keepawake` handle (releasing the OS assertion)
        /// and lets the thread exit.
        release_tx: Option<mpsc::Sender<()>>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl SleepGuard for NativeSleepGuard {}

    impl Drop for NativeSleepGuard {
        fn drop(&mut self) {
            drop(self.release_tx.take());
            if let Some(handle) = self.thread.take() {
                // Join so release is synchronous: when `apply` returns, the
                // assertion is truly gone. Bounded — the thread only has a
                // handle drop left to run.
                let _ = handle.join();
            }
        }
    }

    impl SleepBlocker for NativeSleepBlocker {
        fn acquire(&self) -> Result<Box<dyn SleepGuard>, AcquireError> {
            let (ready_tx, ready_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel::<()>();
            let thread = std::thread::Builder::new()
                .name("keep-awake-holder".into())
                .spawn(move || {
                    // `idle(true)` = prevent idle SYSTEM sleep only.
                    // `display` stays false (the screen must be allowed to
                    // sleep — hard requirement) and `sleep` stays false
                    // (lid-close / explicit sleep must always win over a
                    // background sync).
                    let awake = keepawake::Builder::default()
                        .display(false)
                        .idle(true)
                        .sleep(false)
                        .reason("Syncing files")
                        .app_name("Hippius")
                        .app_reverse_domain("hippius.com")
                        .create();
                    match awake {
                        Ok(handle) => {
                            let _ = ready_tx.send(Ok(()));
                            // Park until the guard drops its sender.
                            let _ = release_rx.recv();
                            drop(handle);
                        }
                        Err(e) => {
                            let _ = ready_tx.send(Err(AcquireError { reason: e.to_string() }));
                        }
                    }
                })
                .map_err(|e| AcquireError {
                    reason: format!("could not spawn keep-awake holder thread: {e}"),
                })?;
            match ready_rx.recv() {
                Ok(Ok(())) => Ok(Box::new(NativeSleepGuard {
                    release_tx: Some(release_tx),
                    thread: Some(thread),
                })),
                Ok(Err(e)) => {
                    let _ = thread.join();
                    Err(e)
                }
                Err(_) => {
                    // Holder thread died before reporting (should be
                    // unreachable — both branches send exactly once).
                    let _ = thread.join();
                    Err(AcquireError {
                        reason: "keep-awake holder thread exited before reporting readiness".into(),
                    })
                }
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod native {
    use super::{AcquireError, SleepBlocker, SleepGuard};

    /// Linux v1: a documented no-op (see the module header for why the zbus
    /// inhibitor backend is not worth its dependency weight yet). Succeeding
    /// with an inert guard — rather than erroring — keeps the orchestrator's
    /// edge-triggered logic identical across platforms and avoids a `warn!`
    /// on every snapshot.
    pub(super) struct NativeSleepBlocker;

    struct NoopSleepGuard;

    impl SleepGuard for NoopSleepGuard {}

    impl SleepBlocker for NativeSleepBlocker {
        fn acquire(&self) -> Result<Box<dyn SleepGuard>, AcquireError> {
            tracing::debug!("keep-awake is a no-op on Linux (v1) — no sleep assertion taken");
            Ok(Box::new(NoopSleepGuard))
        }
    }
}

/// Edge-triggered owner of the (at most one) sleep assertion.
///
/// Stored on `AppState.keep_awake`. All decisions flow through
/// [`SyncKeepAwake::apply`], driven by the snapshot funnel in
/// `sync::projection::tauri_bridge` — the single place that observes every
/// progress frame and every terminal sync event.
pub struct SyncKeepAwake {
    blocker: Box<dyn SleepBlocker>,
    /// `Some` while the assertion is held. The mutex is held only for the
    /// acquire/release transition — microseconds, never across `.await`.
    held: Mutex<Option<Box<dyn SleepGuard>>>,
}

impl SyncKeepAwake {
    #[must_use]
    pub fn new(blocker: Box<dyn SleepBlocker>) -> Self {
        Self {
            blocker,
            held: Mutex::new(None),
        }
    }

    /// The production orchestrator, backed by the platform-native blocker.
    #[must_use]
    pub fn new_native() -> Self {
        Self::new(Box::new(native::NativeSleepBlocker))
    }

    /// Drive the assertion toward `hold`. Edge-triggered and idempotent:
    /// repeated `true`s never re-acquire, repeated `false`s never
    /// double-release. `context` names the trigger (for the acquire/release
    /// log lines); it is `&'static str` so the 4 Hz steady-state path pays
    /// zero formatting cost.
    ///
    /// An acquisition failure is logged and NOT latched — the next
    /// `hold = true` frame retries, so a transient OS refusal can't disable
    /// keep-awake for the rest of the session.
    pub fn apply(&self, hold: bool, context: &'static str) {
        let mut held = self.held.lock().unwrap_or_else(PoisonError::into_inner);
        match (hold, held.is_some()) {
            (true, false) => match self.blocker.acquire() {
                Ok(guard) => {
                    *held = Some(guard);
                    info!(context, "keep-awake: acquired idle-system-sleep block (sync transfers active)");
                }
                Err(err) => {
                    warn!(context, error = %err, "keep-awake: could not block idle system sleep; the machine may sleep mid-sync");
                }
            },
            (false, true) => {
                // Dropping the guard releases the OS assertion (RAII).
                *held = None;
                info!(context, "keep-awake: released idle-system-sleep block (no active transfers)");
            }
            // Steady states: already held / already released.
            (true, true) | (false, false) => {}
        }
    }

    /// Whether the assertion is currently held.
    #[must_use]
    pub fn is_held(&self) -> bool {
        self.held.lock().unwrap_or_else(PoisonError::into_inner).is_some()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;

    /// Minimal snapshot with every field at its idle default. Mirrors the
    /// helper in `sync::projection::progress::tests`.
    fn base_snapshot() -> SyncSnapshot {
        SyncSnapshot {
            is_active: false,
            overall_percent: 0,
            progress_bytes: 0,
            bytes_expected: 0,
            total_files: 0,
            completed_files: 0,
            failed_files: 0,
            retry_in_secs: 0,
            last_error: None,
            expected_uploads: 0,
            expected_downloads: 0,
            expected_local_deletes: 0,
            expected_remote_deletes: 0,
            started_at: None,
            completed_at: None,
            files: vec![],
            widget_state: "idle".to_string(),
            widget_visible: false,
            combined_progress_bytes: 0,
            combined_bytes_expected: 0,
            deleted_count: 0,
            synced_count: 0,
            actual_total: 0,
            status_variant: "progress".to_string(),
            sync_direction: "upload".to_string(),
            effective_in_progress: false,
            effective_completed: false,
        }
    }

    fn active_snapshot(total: usize, completed: usize, failed: usize) -> SyncSnapshot {
        let mut snap = base_snapshot();
        snap.is_active = true;
        snap.total_files = total;
        snap.completed_files = completed;
        snap.failed_files = failed;
        snap
    }

    // ── Resolver ───────────────────────────────────────────────────────

    #[test]
    fn resolver_holds_while_files_outstanding() {
        assert!(should_hold_keep_awake(&active_snapshot(5, 2, 0)));
    }

    #[test]
    fn resolver_holds_with_zero_progress_yet() {
        // Plan merged, nothing transferred yet (all pending) — bytes are
        // about to move, hold from the first files-populated frame.
        assert!(should_hold_keep_awake(&active_snapshot(3, 0, 0)));
    }

    #[test]
    fn resolver_releases_when_session_inactive() {
        let mut snap = active_snapshot(5, 5, 0);
        snap.is_active = false;
        assert!(!should_hold_keep_awake(&snap));
    }

    #[test]
    fn resolver_releases_on_empty_heartbeat_cycle() {
        // Periodic no-op cycle: session active but no files ever join it.
        assert!(!should_hold_keep_awake(&active_snapshot(0, 0, 0)));
    }

    #[test]
    fn resolver_releases_on_stalled_completion() {
        // The `fixup_stalled_completion` shape: all files done, but the
        // watcher's self-write detection left `is_active = true` forever.
        // Nothing is transferring — the assertion must not pin the machine
        // awake indefinitely.
        assert!(!should_hold_keep_awake(&active_snapshot(3, 3, 0)));
    }

    #[test]
    fn resolver_counts_failed_files_as_terminal() {
        // 2 completed + 1 failed of 3: no bytes moving any more.
        assert!(!should_hold_keep_awake(&active_snapshot(3, 2, 1)));
        // …but a failure alongside files still in flight keeps the hold.
        assert!(should_hold_keep_awake(&active_snapshot(3, 1, 1)));
    }

    // ── Orchestration (fake blocker) ───────────────────────────────────

    struct FakeBlocker {
        acquires: Arc<AtomicUsize>,
        releases: Arc<AtomicUsize>,
        fail_next: Arc<AtomicBool>,
    }

    struct FakeGuard {
        releases: Arc<AtomicUsize>,
    }

    impl SleepGuard for FakeGuard {}

    impl Drop for FakeGuard {
        fn drop(&mut self) {
            self.releases.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl SleepBlocker for FakeBlocker {
        fn acquire(&self) -> Result<Box<dyn SleepGuard>, AcquireError> {
            if self.fail_next.swap(false, Ordering::SeqCst) {
                return Err(AcquireError {
                    reason: "test-induced acquire failure".into(),
                });
            }
            self.acquires.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(FakeGuard {
                releases: Arc::clone(&self.releases),
            }))
        }
    }

    struct Harness {
        keep_awake: SyncKeepAwake,
        acquires: Arc<AtomicUsize>,
        releases: Arc<AtomicUsize>,
        fail_next: Arc<AtomicBool>,
    }

    fn harness() -> Harness {
        let acquires = Arc::new(AtomicUsize::new(0));
        let releases = Arc::new(AtomicUsize::new(0));
        let fail_next = Arc::new(AtomicBool::new(false));
        let keep_awake = SyncKeepAwake::new(Box::new(FakeBlocker {
            acquires: Arc::clone(&acquires),
            releases: Arc::clone(&releases),
            fail_next: Arc::clone(&fail_next),
        }));
        Harness {
            keep_awake,
            acquires,
            releases,
            fail_next,
        }
    }

    /// Feed a snapshot frame through the resolver into `apply` — the exact
    /// composition the bridge's `handle_progress_snapshot` performs.
    fn feed(h: &Harness, snap: &SyncSnapshot) {
        h.keep_awake.apply(should_hold_keep_awake(snap), "test frame");
    }

    #[test]
    fn apply_is_edge_triggered_and_idempotent() {
        let h = harness();
        h.keep_awake.apply(true, "t");
        h.keep_awake.apply(true, "t");
        h.keep_awake.apply(true, "t");
        assert_eq!(h.acquires.load(Ordering::SeqCst), 1, "repeated holds must not re-acquire");
        assert!(h.keep_awake.is_held());
        h.keep_awake.apply(false, "t");
        h.keep_awake.apply(false, "t");
        assert_eq!(h.releases.load(Ordering::SeqCst), 1, "repeated releases must not double-release");
        assert!(!h.keep_awake.is_held());
    }

    #[test]
    fn release_when_never_held_is_a_noop() {
        let h = harness();
        h.keep_awake.apply(false, "t");
        assert_eq!(h.acquires.load(Ordering::SeqCst), 0);
        assert_eq!(h.releases.load(Ordering::SeqCst), 0);
        assert!(!h.keep_awake.is_held());
    }

    /// Realistic single-drive lifecycle, ending in the STALLED shape (all
    /// files terminal, session never finalized — the missed-terminal-event
    /// case). The assertion must be acquired exactly once at the first
    /// transferring frame and released by the resolver's own verdict on a
    /// later frame, without any terminal event ever arriving.
    #[test]
    fn transfer_lifecycle_acquires_once_and_releases_on_stall() {
        let h = harness();

        feed(&h, &base_snapshot()); // idle boot frame
        assert!(!h.keep_awake.is_held());

        feed(&h, &active_snapshot(0, 0, 0)); // empty heartbeat — no hold
        assert!(!h.keep_awake.is_held());

        feed(&h, &active_snapshot(3, 0, 0)); // plan merged, transfers begin
        assert!(h.keep_awake.is_held());

        feed(&h, &active_snapshot(3, 1, 0)); // mid-transfer frames
        feed(&h, &active_snapshot(3, 2, 0));
        assert!(h.keep_awake.is_held());
        assert_eq!(h.acquires.load(Ordering::SeqCst), 1, "steady-state frames must not re-acquire");

        // All files done but `is_active` stuck true (watcher self-write
        // stall) — the safety net: released with NO terminal event.
        feed(&h, &active_snapshot(3, 3, 0));
        assert!(!h.keep_awake.is_held(), "stalled completion must release");
        assert_eq!(h.releases.load(Ordering::SeqCst), 1);
    }

    /// Two drives overlapping in the one account-global session: drive B's
    /// files merge in mid-transfer (total grows), drive A finishes first,
    /// and the assertion is held — without re-acquisition — until the LAST
    /// drive's files are terminal and the session finalizes.
    #[test]
    fn overlapping_drives_hold_until_both_finish() {
        let h = harness();

        feed(&h, &active_snapshot(5, 1, 0)); // drive A transferring
        assert!(h.keep_awake.is_held());

        feed(&h, &active_snapshot(9, 2, 0)); // drive B's 4 files merge in
        feed(&h, &active_snapshot(9, 5, 0)); // drive A fully done, B mid-flight
        assert!(h.keep_awake.is_held(), "one drive finishing must not release while another transfers");
        assert_eq!(h.acquires.load(Ordering::SeqCst), 1);

        let mut done = active_snapshot(9, 9, 0); // session finalized
        done.is_active = false;
        feed(&h, &done);
        assert!(!h.keep_awake.is_held());
        assert_eq!(h.releases.load(Ordering::SeqCst), 1);
    }

    /// A failed acquire is logged, not latched: the next holding frame
    /// retries, so a transient OS refusal can't disable keep-awake for the
    /// rest of the session.
    #[test]
    fn acquire_failure_retries_on_next_frame() {
        let h = harness();
        h.fail_next.store(true, Ordering::SeqCst);

        feed(&h, &active_snapshot(2, 0, 0));
        assert!(!h.keep_awake.is_held(), "failed acquire must not report held");
        assert_eq!(h.acquires.load(Ordering::SeqCst), 0);

        feed(&h, &active_snapshot(2, 1, 0)); // next frame retries and succeeds
        assert!(h.keep_awake.is_held());
        assert_eq!(h.acquires.load(Ordering::SeqCst), 1);
    }

    /// Smoke test for the real macOS/Windows blocker: the dedicated-thread
    /// handshake must complete (no deadlock) and the guard drop must join the
    /// holder thread. Briefly takes and releases a REAL (idle-system-sleep
    /// only) assertion — harmless, and exactly what a sync would do.
    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn native_blocker_acquire_release_smoke() {
        let keep_awake = SyncKeepAwake::new_native();
        keep_awake.apply(true, "smoke test");
        assert!(keep_awake.is_held(), "native acquire should succeed on macOS/Windows");
        keep_awake.apply(false, "smoke test");
        assert!(!keep_awake.is_held());
    }
}
