//! Tauri adapter for hcfs-client sync runner.
//!
//! Implements `SyncEventHandler` and `SyncCallbacks` to bridge the library's
//! generic sync engine to Tauri's IPC event system and desktop-specific
//! operations (auth tokens, database queries).

use hcfs_client::engine::events::{SyncCallbacks, SyncEvent, SyncEventHandler};
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};

use crate::sync::events;
use crate::sync::intent::IntentRepo;
use crate::sync::progress::{SyncSnapshot, cap_file_list, prepare_snapshot_for_emit};

/// Process-wide cursor holding the last-emitted snapshot fingerprint.
///
/// Pre-emit short-circuit: if the new snapshot hashes to the same value as
/// the last emitted one, skip `app.emit` entirely. The throttle in
/// `progress::update_file_progress` already gates by time (250 ms); this
/// gate adds a content check so a state-transition emit (`emit_snapshot(true)`,
/// not throttled) immediately followed by a chunk-tick emit with identical
/// headline data only goes over the IPC once. `0` is reserved for "never
/// emitted, always allow first emit through."
static LAST_EMITTED_FINGERPRINT: AtomicU64 = AtomicU64::new(0);

/// Monotonic ticket source: each `ProgressSnapshot` is stamped with the next
/// value at `on_event` time, BEFORE it is handed to a spawned emit task. The
/// stamp records the order the bridge observed snapshots, which the spawned
/// tasks then can't reorder.
static SNAPSHOT_SEQ: AtomicU64 = AtomicU64::new(0);

/// Highest snapshot ticket emitted so far. A spawned emit task only emits when
/// its ticket strictly exceeds this (see [`try_claim_snapshot_seq`]).
///
/// Why this exists: each snapshot is emitted from its OWN spawned task that
/// first awaits a variable-latency SQLite read (`build_intent_overlay`). An
/// earlier snapshot's read can finish AFTER a later one's, so without an
/// ordering gate the older frame would reach the FE last; the fingerprint
/// cursor then freezes that stale frame until the next distinct snapshot — and
/// at end-of-cycle there is no next snapshot, so the widget stuck below 100%.
/// `0` means nothing has been emitted yet.
static LAST_EMITTED_SEQ: AtomicU64 = AtomicU64::new(0);

/// Bridge between the hcfs-client sync engine and Tauri's event system.
///
/// The `app` handle is set exactly once during app setup via [`set_app_handle`]
/// and read on every sync event. [`OnceLock`] provides lock-free reads after
/// initialization, eliminating contention on the hot event path.
pub struct TauriSyncBridge {
    app: std::sync::OnceLock<AppHandle>,
}

impl Default for TauriSyncBridge {
    fn default() -> Self {
        Self {
            app: std::sync::OnceLock::new(),
        }
    }
}

impl TauriSyncBridge {
    /// Create a new bridge with no `AppHandle` set yet.
    ///
    /// Call [`set_app_handle`] once during app setup to wire in the handle
    /// before the sync engine fires its first event.
    pub fn new() -> Self {
        Self {
            app: std::sync::OnceLock::new(),
        }
    }

    /// Sets the Tauri app handle. Must be called exactly once during setup.
    ///
    /// Subsequent calls are silently ignored (the first handle wins).
    pub fn set_app_handle(&self, handle: AppHandle) {
        let _ = self.app.set(handle);
    }

    /// Clone the stored `AppHandle`, if one has been set via [`set_app_handle`].
    ///
    /// Returns `None` before `set_app_handle` is called (i.e., during the brief
    /// window between `AppState::new()` and the first `setup()` call). Event
    /// handlers silently no-op when `None` is returned.
    fn app(&self) -> Option<AppHandle> {
        self.app.get().cloned()
    }

    /// Emit the `hippius_auth_ready` signal. Called from login and
    /// session-restore once `AuthInfo` has been fully written. The FE
    /// uses this as a retry trigger for `auto_init_sync` on slow
    /// systems where the first invocation lost the race against
    /// `rehydrate_full_session`.
    ///
    /// No-op if the `AppHandle` has not been wired in yet — at that
    /// point there's no FE to receive the event anyway.
    pub fn emit_auth_ready(&self) {
        if let Some(app) = self.app() {
            let _ = app.emit(events::AUTH_READY, ());
        }
    }
}

/// Resolve `(pool, owner)` for durably persisting file failures, or `None` when
/// no account / DB pool is available (logged out, pool not yet ready) — in which
/// case persistence is simply skipped. `owner` is the hashed account key, the
/// same scoping `sync_paths` uses, so failure rows stay private to the account.
fn failure_persist_ctx(app_state: &crate::app_state::AppState) -> Option<(sqlx::SqlitePool, String)> {
    let account_id = app_state.current_account_id().ok()?;
    let owner = crate::auth::account_key::account_key(&account_id);
    let pool = app_state.pool().ok()?.clone();
    Some((pool, owner))
}

/// Inspect the progress tracker after a sync cycle completes to update
/// per-file failure counters. If any file reaches the threshold, emit
/// the `FILES_FAILED_REPEATEDLY` event to trigger the frontend modal.
fn update_failure_counts(app: &AppHandle, label: &str) {
    use hcfs_client::engine::progress::state::FileStatus;
    use tauri::Manager;

    let app_state = app.state::<crate::app_state::AppState>();
    let failure_state = &app_state.file_failures;

    // Single lock acquisition AND single pass over the file map: split
    // entries into the two outcome buckets in one scan instead of two
    // back-to-back sweeps. For a drive that just completed thousands of
    // files this halves the work done under the progress lock.
    let (failed_files, succeeded_paths): (Vec<(String, Option<String>)>, Vec<String>) = {
        let state = app_state.sync.progress.lock_state();
        let Some(session) = &state.current_session else {
            return;
        };
        let mut failed: Vec<(String, Option<String>)> = Vec::new();
        let mut succeeded: Vec<String> = Vec::new();
        for f in session.files.values() {
            if f.label.as_ref() != label {
                continue;
            }
            match f.status {
                FileStatus::Error => failed.push((f.path.to_string(), f.error.as_deref().map(str::to_owned))),
                FileStatus::Completed => succeeded.push(f.path.to_string()),
                _ => {}
            }
        }
        (failed, succeeded)
    };

    if failed_files.is_empty() {
        // All files succeeded for this label -- clear counters.
        failure_state.clear_all_for_label(label);
        // Mirror the clear into the durable store (best-effort, off the
        // sync thread since this fn is sync and DB writes are async).
        if let Some((pool, owner)) = failure_persist_ctx(&app_state) {
            let label = label.to_string();
            tauri::async_runtime::spawn(async move {
                let _ = crate::sync::failure_repo::clear_failures_for_label(&pool, &owner, &label).await;
            });
        }
        return;
    }

    // Clear counters for files that succeeded this cycle.
    for path in &succeeded_paths {
        failure_state.clear_failure(label, path);
    }
    // Mirror the per-file success clears into the durable store.
    if !succeeded_paths.is_empty()
        && let Some((pool, owner)) = failure_persist_ctx(&app_state)
    {
        let label = label.to_string();
        let paths = succeeded_paths.clone();
        tauri::async_runtime::spawn(async move {
            for p in &paths {
                let _ = crate::sync::failure_repo::clear_failure(&pool, &owner, &label, p).await;
            }
        });
    }

    // Bump the counters and let the tracker decide whether to prompt: a file
    // the user dismissed stays quiet, a file they have not seen reopens the
    // dialog with the whole set.
    if failure_state.record_cycle_failures(label, &failed_files) {
        let at_threshold = failure_state.files_at_threshold();
        if !at_threshold.is_empty() {
            let _ = app.emit(
                crate::sync::events::FILES_FAILED_REPEATEDLY,
                crate::sync::events::FilesFailedRepeatedlyPayload { files: at_threshold },
            );
        }
    }
}

/// Run the canonical post-cycle cleanup for a successfully completed sync
/// cycle, then emit `SYNC_COMPLETED`.
///
/// This is the single source of truth for the "a sync cycle finished
/// successfully" transition. Both the auto-sync engine (`on_event`'s
/// `SyncCompleted` arm) and the reviewed-conflict command
/// (`crate::sync::control::sync_with_conflict_resolutions`) route through here,
/// so the per-label cleanup cannot drift between the two completion paths.
/// Routing both through here keeps the reviewed path from skipping the cleanup
/// below — otherwise it would leave a stuck "Preparing sync…" widget, a stale
/// pending-upload banner, stale repeated-failure counters, and a detail-less
/// completion notification after a reviewed sync.
///
/// `payload.files` is ignored on input and replaced with the cycle's completed
/// files collected from session state — callers pass `Vec::new()`. `files_failed`
/// is logged only (per-file detail already flowed through `SyncEvent::FileFailed`);
/// the reviewed path, which has no cycle-level failure count, passes `0`.
pub(crate) fn handle_sync_completed(app: &AppHandle, mut payload: events::SyncCompletedPayload, files_failed: usize) {
    use tauri::Manager;

    if files_failed > 0 {
        tracing::warn!(label = %payload.label, files_failed = files_failed, "sync cycle completed with per-file failures");
    }

    let app_state = app.state::<crate::app_state::AppState>();
    // Clear the preparing override for this label BEFORE the snapshot emit so a
    // cycle that completes with an empty plan (no merge_into_session) doesn't
    // leak a stuck "Preparing sync…" widget after the cycle ends.
    app_state.preparing.clear(&payload.label);
    app_state.sync.emit_snapshot(true);

    // Defensive banner clear, scoped to THIS label and epoch-gated so an
    // overlapping in-flight cycle's completion cannot prematurely clear a NEW
    // upload's banner. Idempotent — the common case (a real upload already
    // cleared it) is a no-op.
    {
        let epoch = app_state.sync_session_epoch.load(std::sync::atomic::Ordering::SeqCst);
        app_state.upload_processing.clear_if_session_advanced(app, &payload.label, epoch);
    }

    // Recovery edge: a successful cycle re-arms the "Sync Failed" latch so a
    // drive that goes down again later notifies anew. Mirrors hcfs-client
    // resetting `consecutive_failures` to 0 on success.
    app_state.error_notify.clear(&payload.label);
    // Same edge for the revocation latch: a completing drive is provably not
    // revoked (a revoked one never reaches SyncCompleted — the marker cycle
    // tears it down), so re-arm it for a genuine later revocation (e.g. the
    // member was re-invited, re-synced, then revoked again).
    app_state.revoked_notify.clear(&payload.label);

    // Update per-file failure counters from the finalized session.
    update_failure_counts(app, &payload.label);

    // Snapshot the cycle's completed files from session state before the next
    // cycle starts. Capped by MAX_NOTIFICATION_FILES and again by the reported
    // completion counts so a multi-cycle residue of stale Completed files can't
    // over-report.
    let reported_count = payload.files_uploaded + payload.files_downloaded + payload.files_deleted_locally + payload.files_deleted_remotely;
    let max_files = reported_count.min(crate::sync::progress::MAX_NOTIFICATION_FILES);
    payload.files = crate::sync::progress::collect_cycle_files_for_label(&app_state.sync, &payload.label, max_files);

    // Side-channel: keep the server's folder entities and the on-disk directory
    // tree in step. ONE combined fire-and-forget task reconciles local→server
    // FIRST (register newly-created empty/file-less dirs, unregister removed
    // ones), THEN materializes server→local over the now-consistent server set
    // (create empty folders other devices made, remove ones deleted elsewhere).
    // Sequencing both halves in one task under one throttle is what prevents a
    // concurrent reconcile + materialize from resurrecting a locally-deleted
    // empty folder. It does NOT touch the file sync plan, and is throttled +
    // gated on the backfill flag, so a throttled or pre-backfill cycle is cheap.
    if let Ok(account_id) = app_state.current_account_id() {
        crate::sync::folder_entries_materialize::spawn_folder_entity_sync(
            app.clone(),
            account_id,
            payload.label.clone(),
            crate::sync::folder_entries_materialize::FolderEntitySyncTrigger::PerCycle,
        );
    }

    // A cycle that materialized or removed local files invalidates cached
    // folder totals the same way a local delete does — the directories above
    // the ones it touched keep their pre-cycle mtime, so nothing else would
    // retire their rows and a folder receiving a file from another device
    // would show its old size for the rest of the session.
    crate::sync::files::invalidate_dir_stats_after_cycle(payload.files_downloaded, payload.files_deleted_locally);

    let _ = app.emit(events::SYNC_COMPLETED, payload);
}

/// Consecutive failed sync cycles before a drive is treated as *genuinely
/// down* and a single "Sync Failed" notification is surfaced.
///
/// Counted PER-LABEL by `crate::sync::error_notify::ErrorNotifyState` — NOT
/// read from the `SyncError` payload's `consecutive_failures`, which is a
/// runner-global counter any healthy drive resets every cycle (see that
/// module's header). `3` matches the project's existing per-file
/// repeated-failure threshold (`sync::failure_tracking::FAILURE_THRESHOLD`)
/// and sits above hcfs-client's own `HEALTH_FAILURE_THRESHOLD = 2`
/// connectivity flip, so a notification means "still failing after the engine
/// already considers the endpoint offline", not a one-cycle blip.
const ERROR_NOTIFY_THRESHOLD: u32 = 3;

/// Notification policy for a sync failure routed through [`handle_sync_error`].
///
/// The auto-retry loop fires a `SyncError` every failed cycle, so its
/// notifications must be rate-limited; a reviewed-conflict sync is a
/// user-initiated one-shot whose single failure is always worth one
/// notification. Modeled as an enum rather than a `bool` so the two intents
/// read at the call site (axiom `illu_design_02`).
#[derive(Clone, Copy)]
pub(crate) enum FailureNotify {
    /// Auto-retry loop: notify only once `ERROR_NOTIFY_THRESHOLD` consecutive
    /// cycles have failed for this label.
    Gated,
    /// User-initiated one-shot (reviewed-conflict sync): always notify on a
    /// real (non-cancel) failure.
    Always,
}

/// Threshold handed to the `revoked_notify` latch. `1` deliberately turns
/// [`crate::sync::error_notify::ErrorNotifyState`] into a once-per-label edge
/// latch: the FIRST marker-carrying cycle notifies + tears the drive down,
/// and every later one (the engine retries with backoff until the teardown
/// removes the drive from the runner) is suppressed. No 3-strike gate like
/// [`ERROR_NOTIFY_THRESHOLD`]: the engine attaches the marker only when a
/// SUCCESSFULLY fetched remote listing is missing the folder — a transient
/// outage keeps its original error — so a single marker is already
/// definitive, not flaky.
const REVOKED_NOTIFY_THRESHOLD: u32 = 1;

/// How [`handle_sync_error`] must route a `SyncError` payload, decided from
/// the error string alone. Extracted as a pure function so the routing —
/// exact-equality marker matching, cancel first — is unit-testable without a
/// Tauri runtime (the bridge handlers themselves are `AppHandle<Wry>`-bound).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SyncErrorDisposition {
    /// User-initiated cancel / stall-watchdog self-cancel: silence entirely.
    SilencedCancel,
    /// Member drive's access revoked (or owner deleted the drive): terminal
    /// teardown + one notification, never the flaky-endpoint counter.
    SharedDriveRevoked,
    /// Everything else: the generic gated error path.
    RealError,
}

/// Classify a `SyncError`'s error string. Both markers are matched by exact
/// equality (never substring): the upstream stringifications are constants
/// pinned in `sync::events`, and a suffix-carrying variant must fall through
/// to [`SyncErrorDisposition::RealError`] so a reworded upstream error is
/// surfaced rather than silently swallowed or mis-torn-down.
pub(crate) fn classify_sync_error(error: &str) -> SyncErrorDisposition {
    if error == events::CANCELLED_MARKER {
        SyncErrorDisposition::SilencedCancel
    } else if error == events::SHARED_DRIVE_REVOKED_MARKER {
        SyncErrorDisposition::SharedDriveRevoked
    } else {
        SyncErrorDisposition::RealError
    }
}

/// Single source of truth for the sync-ERROR transition, shared by the auto-sync
/// bridge ([`SyncEventHandler::on_event`]'s `SyncError` arm) and the
/// reviewed-conflict command ([`crate::sync::control::sync_with_conflict_resolutions`]).
///
/// Like [`handle_sync_completed`], this exists so the two paths can't drift. It:
/// 1. DROPS cancels — any error equal to [`events::CANCELLED_MARKER`] (every
///    user-initiated pause/remove/logout teardown and the stall-watchdog
///    self-cancel stringifies to it) is silenced so it never becomes a persisted
///    "Sync Failed" notification; the preparing widget is still cleared.
/// 2. For a REAL error, runs the epoch-gated, per-label defensive clears
///    (upload-processing banner, preparing override, 402 credits counter) so an
///    abort mid-cycle can't leak a stuck banner, then emits `SYNC_ERROR` and,
///    per `notify`, the gated `SYNC_FAILED_NOTIFY`.
///
/// `notify` selects the notification policy: [`FailureNotify::Gated`] for the
/// auto-retry loop (notify once a label has failed `ERROR_NOTIFY_THRESHOLD`
/// consecutive cycles) and [`FailureNotify::Always`] for a user-initiated
/// reviewed-conflict sync (always notify a real failure).
///
/// Sharing this with the reviewed-conflict path keeps a cancel during a
/// reviewed sync from surfacing a spurious "Sync Failed" and from skipping the
/// defensive clears.
pub(crate) fn handle_sync_error(app: &AppHandle, payload: events::SyncErrorPayload, notify: FailureNotify) {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();

    match classify_sync_error(&payload.error) {
        // 1. Cancels are never user-actionable — silence them, but still clear
        //    the preparing widget (a paused/removed drive would otherwise leak
        //    a stuck "Preparing sync…" badge). Banner clear is skipped for
        //    cancels (handled by stop_sync).
        SyncErrorDisposition::SilencedCancel => {
            if app_state.preparing.clear(&payload.label) {
                app_state.sync.emit_snapshot(true);
            }
            tracing::debug!(label = %payload.label, "Silenced sync cancel (not emitted as error)");
            return;
        }
        // 1b. Shared-drive revocation is TERMINAL, not flaky: route it into
        //     its dedicated teardown + one-shot notification BEFORE the
        //     `error_notify` counting below, so a revocation never increments
        //     the flaky-endpoint counter and never waits out the 3-strike
        //     gate. Early return mirrors the cancel arm — the generic path
        //     must not also fire for the same event.
        SyncErrorDisposition::SharedDriveRevoked => {
            handle_shared_drive_revoked(app, payload);
            return;
        }
        SyncErrorDisposition::RealError => {}
    }

    // 2. Real error: epoch-gated, label-scoped defensive clears so an abort
    //    mid-encryption (before the first-chunk path raised the banner) can't
    //    leave a stuck banner / preparing override / 402 counter.
    {
        let epoch = app_state.sync_session_epoch.load(std::sync::atomic::Ordering::SeqCst);
        app_state.upload_processing.clear_if_session_advanced(app, &payload.label, epoch);
        app_state.preparing.clear(&payload.label);
        app_state.credits_exhausted.clear(&payload.label);
    }

    // Keep-awake: a failed cycle marks its remaining files terminal, so the
    // fresh snapshot normally releases the sleep assertion here (hcfs-client's
    // retry starts a NEW cycle whose snapshots re-acquire). Re-evaluating
    // (not unconditionally releasing) keeps the hold when another drive's
    // transfers are still in flight.
    reevaluate_keep_awake(&app_state, "sync error");

    // Decide BEFORE emitting whether this failure should surface a persisted
    // "Sync Failed" notification. For the auto-retry loop, `record_failure`
    // counts THIS label's consecutive failed cycles (not the payload's
    // runner-global `consecutive_failures`, which any healthy drive resets —
    // see `error_notify`) and fires once when the count first reaches the
    // threshold, suppressing every later cycle until `handle_sync_completed`
    // clears it on recovery. A reviewed one-shot always notifies.
    let should_notify = match notify {
        FailureNotify::Always => true,
        FailureNotify::Gated => app_state.error_notify.record_failure(&payload.label, ERROR_NOTIFY_THRESHOLD),
    };

    // `SYNC_ERROR` still fires on EVERY real failed cycle — unchanged — so
    // live consumers keep working (e.g. `ConflictEventListener` drops the
    // drive's pending conflicts on an aborted cycle). Only the gated
    // notification channel is rate-limited. The notify emit clones the small
    // payload only on the rare down-edge; `SYNC_ERROR` takes the original by
    // move.
    if should_notify {
        let _ = app.emit(events::SYNC_FAILED_NOTIFY, payload.clone());
    }
    let _ = app.emit(events::SYNC_ERROR, payload);
}

/// Handle `SyncEvent::FolderRecovered` — the engine found an own drive's
/// folder missing from the server listing, re-registered it, and deleted the
/// local baseline, so the whole drive is about to re-upload.
///
/// [`events::FOLDER_RECOVERED`] still fires unconditionally so any live
/// consumer sees every recovery. The user-facing notification takes the gated
/// [`events::FOLDER_RESTORED_NOTIFY`] instead, for the two reasons
/// `sync::folder_restore_notify` documents: the engine re-emits the raw event
/// every cycle whose listing still lacks the folder, and a brand-new folder
/// reports `Recovered` merely because its detached registration has not
/// landed yet. Same split as `SYNC_ERROR` / `SYNC_FAILED_NOTIFY` above.
fn handle_folder_recovered(app: &AppHandle, label: String) {
    use tauri::Manager;
    let should_notify = app.state::<crate::app_state::AppState>().folder_restore_notify.take(&label);

    if should_notify {
        let _ = app.emit(events::FOLDER_RESTORED_NOTIFY, events::LabelPayload { label: label.clone() });
    }
    let _ = app.emit(events::FOLDER_RECOVERED, events::LabelPayload { label });
}

/// Handle a `SyncError` carrying [`events::SHARED_DRIVE_REVOKED_MARKER`]:
/// the server-side listing no longer contains this member drive's folder
/// (the owner revoked this member or deleted the drive), which is a
/// TERMINAL state — retrying cannot fix it, and the auto-retry loop would
/// otherwise keep hammering a folder that is gone.
///
/// What this does, and deliberately nothing more:
/// 1. The SAME epoch-gated, label-scoped defensive clears + keep-awake
///    re-evaluation as the generic error arm — an abort mid-cycle must not
///    leak a stuck banner/preparing badge/402 counter here either.
/// 2. Once per label (the `revoked_notify` latch — the engine re-emits the
///    marker each backoff retry until the teardown lands, and a re-init
///    race could re-surface it): spawn the pause-shaped terminal teardown
///    (`teardown_revoked_drive` — in-memory removal + epoch bump under the
///    label's commit lock, NO `is_paused` write, settles the drive on
///    `DriveStatus::Error`) and emit ONE `SYNC_FAILED_NOTIFY` so exactly one
///    "Sync Failed" notification row lands (`useFilesNotification.ts`
///    persists one row per event on this channel). The teardown is spawned
///    because `on_event` is synchronous and the funnel awaits the commit
///    lock.
/// 3. Emit `SYNC_ERROR` unchanged — its live consumers (e.g.
///    `ConflictEventListener` dropping the drive's pending conflicts) must
///    see this failed cycle exactly like any other real error; no state
///    beyond what the generic arm touches is cleared here.
///
/// It never touches `error_notify`: a revocation is definitive, not a
/// flaky-endpoint episode, so it must neither increment that counter nor
/// consume its notification edge.
fn handle_shared_drive_revoked(app: &AppHandle, payload: events::SyncErrorPayload) {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();

    // Same label-scoped defensive clears as the generic arm (see
    // `handle_sync_error` step 2 for the rationale).
    {
        let epoch = app_state.sync_session_epoch.load(std::sync::atomic::Ordering::SeqCst);
        app_state.upload_processing.clear_if_session_advanced(app, &payload.label, epoch);
        app_state.preparing.clear(&payload.label);
        app_state.credits_exhausted.clear(&payload.label);
    }
    reevaluate_keep_awake(&app_state, "shared drive revoked");

    // Edge latch: only the FIRST marker for this label since the last clear
    // spawns the teardown and the notification. Suppressed repeats still ran
    // the clears above (idempotent) and still emit `SYNC_ERROR` below.
    if app_state.revoked_notify.record_failure(&payload.label, REVOKED_NOTIFY_THRESHOLD) {
        tracing::warn!(label = %payload.label, "Shared drive access revoked — tearing down and notifying once");
        tauri::async_runtime::spawn(crate::sync::lifecycle::teardown_revoked_drive(app.clone(), payload.label.clone()));

        // The persisted notification carries the SAME user copy the drive row
        // settles on (`SHARED_DRIVE_REVOKED_MESSAGE`), not the engine's
        // internal marker string — `useFilesNotification` renders
        // `payload.error` verbatim, and showing two different sentences for
        // one event reads as two problems. The rewrite is local to this emit:
        // the classifier already ran on the raw marker above, and the
        // `SYNC_ERROR` emit below keeps it for the live consumers' contract.
        let mut notify_payload = payload.clone();
        notify_payload.error = crate::sync::drive_status::SHARED_DRIVE_REVOKED_MESSAGE.to_string();
        let _ = app.emit(events::SYNC_FAILED_NOTIFY, notify_payload);
    }

    let _ = app.emit(events::SYNC_ERROR, payload);
}

/// Handle `SyncEvent::SyncStarted`: bump the session epoch, reset the per-label
/// 402 counter, ARM the preparing override's scan-window grace, cap the file
/// lists, and forward `SYNC_STARTED`.
///
/// Extracted from [`SyncEventHandler::on_event`] so the dispatcher stays a thin
/// match. The "preparing" override is only ARMED here (invisible); it is
/// surfaced by [`handle_plan_ready`] or by a past-grace scan/fetch tick — see
/// the inline rationale.
fn handle_sync_started(app: &AppHandle, mut payload: events::SyncStartedPayload) {
    // Increment the sync session epoch so the
    // UploadProcessingState clear gate knows a new cycle
    // has started. See `crate::sync::upload_processing`
    // for the full rationale.
    {
        use tauri::Manager;
        let app_state = app.state::<crate::app_state::AppState>();
        app_state.sync_session_epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        // Fresh cycle for this label — reset the running
        // 402 counter so the next `InsufficientBalance`
        // failure starts at `file_count = 1` and the FE
        // banner reflects only the new cycle's failures.
        // Clearing here (not on SyncCompleted) is correct
        // because the user-visible state is "this cycle's
        // failures, banner sticks until next cycle";
        // clearing on completion would erase the banner
        // before the user sees it.
        app_state.credits_exhausted.clear(&payload.label);

        // ARM (don't mark) the preparing override. Marking here would
        // paint the red "Preparing sync…" widget/tray state across the
        // scan + remote-fetch window of every cycle — including
        // periodic no-op cycles — flashing the tray on a loop (the
        // regression that originally moved marking to
        // `handle_plan_ready`). Arming is invisible: it only anchors
        // the grace clock so a scan/fetch progress tick can surface
        // the override once the cycle has provably been indexing for
        // a while (large watcher-dropped adds scan for minutes before
        // `PlanReady`). See `sync::preparing`, "Armed vs Marked".
        app_state.preparing.note_cycle_started(&payload.label);
    }
    cap_file_list(&mut payload.upload_files);
    cap_file_list(&mut payload.download_files);
    cap_file_list(&mut payload.local_delete_files);
    cap_file_list(&mut payload.remote_delete_files);
    let _ = app.emit(events::SYNC_STARTED, payload);
}

/// Handle `SyncEvent::SyncStopped`: clear the per-label preparing/credits/error
/// state for a drive whose cycle ended (pause / remove / logout teardown) and
/// forward `SYNC_STOPPED`.
fn handle_sync_stopped(app: &AppHandle, label: String) {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    if app_state.preparing.clear(&label) {
        app_state.sync.emit_snapshot(true);
    }
    // The drive's cycle ended (pause / remove / logout
    // teardown). The 402 banner's running count is a
    // per-cycle aggregate; clear it so a future resume /
    // re-add starts at zero. Idempotent.
    app_state.credits_exhausted.clear(&label);
    // Re-arm the "Sync Failed" latch: a paused/removed drive that
    // is later resumed and goes down should notify again.
    app_state.error_notify.clear(&label);
    // Re-arm the revocation latch on the same edge. SyncStopped is the tail
    // of the revocation teardown itself, and after removal the engine can't
    // emit the marker again for this label — the next marker requires a
    // re-init (resume / next launch), which is a fresh episode that must
    // notify again rather than being suppressed by a spent latch.
    app_state.revoked_notify.clear(&label);
    // Drop this drive's folder-entity-sync throttle stamp so a resume / re-add
    // syncs immediately instead of being gated by the prior episode's last-run
    // time.
    app_state.folder_entity_sync.clear(&label);
    // Keep-awake: the teardown paths that fire SyncStopped (pause / remove /
    // logout) usually also emit a snapshot via `remove_files_for_label`, but
    // re-evaluate here explicitly so the assertion drops even on a teardown
    // path that skips the progress emit. If ANOTHER drive is still
    // transferring, the fresh snapshot keeps the hold.
    reevaluate_keep_awake(&app_state, "sync stopped");
    let _ = app.emit(events::SYNC_STOPPED, events::LabelPayload { label });
}

/// Recompute the keep-awake hold from a FRESH progress snapshot and apply it.
///
/// Belt-and-braces for the terminal/reset arms: the `ProgressSnapshot` funnel
/// is the primary driver (it sees every live frame), but `SyncStopped` /
/// `SyncReset` / a real `SyncError` can, on some teardown orderings, be the
/// LAST thing the bridge observes — re-evaluating here guarantees the sleep
/// assertion can never outlive the transfers it was held for.
fn reevaluate_keep_awake(app_state: &crate::app_state::AppState, context: &'static str) {
    let snapshot = app_state.sync.progress.build_snapshot();
    app_state.keep_awake.apply(crate::power::should_hold_keep_awake(&snapshot), context);
}

/// Handle `SyncEvent::SyncReset`: wipe every per-drive preparing/credits/error
/// counter on account switch / logout / reset and forward `SYNC_RESET`.
fn handle_sync_reset(app: &AppHandle, account_id: String, message: String) {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    if app_state.preparing.clear_all() {
        app_state.sync.emit_snapshot(true);
    }
    // Account switch / logout / reset. Every per-drive
    // 402 counter must be wiped before different account
    // data could touch it — a stale `file_count` would
    // pollute the banner for an unrelated user.
    app_state.credits_exhausted.clear_all();
    // Same reasoning for the "Sync Failed" latch: a previous
    // account's down-episode must not suppress the first
    // notification for a different account.
    app_state.error_notify.clear_all();
    // And for the revocation latch — a previous account's revoked drive
    // must not swallow a different account's first revocation edge.
    app_state.revoked_notify.clear_all();
    // And for the folder-restore gate — its armed flags describe the previous
    // account's drives, and a label reused by the new account must be re-armed
    // from that account's own baseline at init, never inherited.
    app_state.folder_restore_notify.clear_all();
    // Wipe every folder-entity-sync throttle stamp: a previous account's
    // last-run times must not gate the new account's first sync after a switch.
    app_state.folder_entity_sync.clear_all();
    reset_snapshot_emit_gates();
    // Keep-awake: logout / account switch tears down every drive — release the
    // sleep assertion unless a fresh snapshot still shows transfers (it won't
    // once `clear_all_data` has run; this covers orderings where the reset
    // event lands first).
    reevaluate_keep_awake(&app_state, "sync reset");
    let _ = app.emit(events::SYNC_RESET, events::SyncResetPayload { account_id, message });
}

/// Handle `SyncEvent::PlanReady`: mark the "preparing" override now that the
/// plan confirms real work, cap the file lists, and forward `SYNC_PLAN_READY`.
fn handle_plan_ready(app: &AppHandle, mut payload: events::SyncPlanReadyPayload) {
    // Resolve the scan-window Armed entry now that the plan is known.
    // Real work → surface the "preparing" override (unless the label's
    // scan ran long enough that a past-grace scan/fetch tick already
    // promoted it — then `mark_preparing` just refreshes it); it
    // bridges the gap from here until the first files-populated
    // snapshot (after `merge_into_session`), at which point the
    // `ProgressSnapshot` arm clears it. Empty plan → disarm, so
    // periodic no-op cycles never flash the red "Preparing sync…"
    // state. See `sync::preparing`, "Armed vs Marked".
    {
        use tauri::Manager;
        let app_state = app.state::<crate::app_state::AppState>();
        let has_work = payload.uploads + payload.downloads + payload.local_deletes + payload.remote_deletes > 0;
        // An IPC-initiated upload already shows its own top-of-page
        // banner for this drive, so suppress the override to avoid
        // double-signalling. Per-label (not global) so a banner on
        // drive A can't suppress drive B's preparing widget.
        let banner_active_for_label = app_state.upload_processing.is_active_for(&payload.label);
        if has_work && !banner_active_for_label {
            if app_state.preparing.mark_preparing(&payload.label) {
                // Newly surfaced — push one snapshot so the widget
                // reflects preparing immediately. `emit_snapshot`
                // synchronously re-enters this same `on_event` with
                // `ProgressSnapshot`, which reacquires the preparing
                // mutex; safe because `mark_preparing` returns a `bool`
                // (its `MutexGuard` is dropped at the fn boundary), so
                // the lock is already released here. Keep that boundary
                // — extending the guard across this emit would deadlock
                // the non-reentrant `std::sync::Mutex`.
                app_state.sync.emit_snapshot(true);
            }
        } else {
            // Empty plan, or the IPC banner already covers this label:
            // indexing is over with nothing for the override to bridge,
            // so drop the scan-window Armed entry stamped at
            // `SyncStarted`. Without this, a still-armed label could be
            // promoted by a stray later tick. A visible Marked override
            // (startup seed / scan promotion) is left alone — its clear
            // paths are the files-populated snapshot and the terminal
            // events, which follow promptly.
            app_state.preparing.disarm(&payload.label);
        }
    }
    cap_file_list(&mut payload.upload_files);
    cap_file_list(&mut payload.download_files);
    cap_file_list(&mut payload.local_delete_files);
    cap_file_list(&mut payload.remote_delete_files);
    let _ = app.emit(events::SYNC_PLAN_READY, payload);
}

/// Raw per-file failure straight off `SyncEvent::FileFailed`, before the
/// non-`Serialize` `kind` is translated to [`events::FileFailureKindPayload`]
/// for the wire.
///
/// Bundled into a struct so [`handle_file_failed`] stays at two parameters and
/// the raw `kind` — read for the `InsufficientBalance` branch *before*
/// conversion — crosses the call in a single move. No existing payload type
/// holds the raw upstream `kind`.
struct FileFailedEvent {
    label: String,
    path: String,
    file_id: String,
    kind: hcfs_client::engine::events::FileFailureKind,
    http_status: Option<u16>,
}

/// Handle `SyncEvent::FileFailed`: surface the typed per-file failure to the FE,
/// persist it durably for cross-restart retry UX, and (for `InsufficientBalance`)
/// raise the "Out of credits" banner. The bridge is a pure forwarder here — the
/// progress-row mutation already happened in `build_file_failed_callback`.
fn handle_file_failed(app: &AppHandle, ev: FileFailedEvent) {
    let FileFailedEvent {
        label,
        path,
        file_id,
        kind,
        http_status,
    } = ev;

    // InsufficientBalance failures additionally raise the
    // "Out of credits" banner. The branch reads the typed
    // variant BEFORE the `kind` value is moved into the
    // FileFailed payload below — copying `balance_cents` /
    // `required_cents` here avoids a clone of the whole
    // upstream enum. The counter mutation happens here
    // (not in the lifecycle callback) because (a) the
    // counter is a UI-level aggregate, not a progress-row
    // mutation, and (b) the bridge is the single emit
    // site for the banner event — keeping the counter
    // adjacent to its only reader avoids a split-brain
    // risk where the count and the event disagree.
    let credits_payload = if let hcfs_client::engine::events::FileFailureKind::InsufficientBalance {
        balance_cents,
        required_cents,
    } = &kind
    {
        use tauri::Manager;
        let app_state = app.state::<crate::app_state::AppState>();
        let file_count = app_state.credits_exhausted.record_failure(&label);
        Some(events::CreditsExhaustedPayload {
            label: label.clone(),
            balance_cents: *balance_cents,
            required_cents: *required_cents,
            file_count,
        })
    } else {
        None
    };

    // Persist the failure durably so the FE can show *why* it failed
    // (and offer retry) in any listing view — Recent Files, the Drive
    // table, the tray — even across restarts. The structured `kind` is
    // only available here at the failure site. `on_event` is sync, so
    // the DB write is spawned off-thread; skipped when logged out.
    let kind_payload = events::FileFailureKindPayload::from(&kind);
    {
        use tauri::Manager;
        let app_state = app.state::<crate::app_state::AppState>();
        if let Some((pool, owner)) = failure_persist_ctx(&app_state) {
            let label = label.clone();
            let path = path.clone();
            let file_name = path.rsplit('/').next().unwrap_or(path.as_str()).to_string();
            let kind_for_db = kind_payload.clone();
            let now_ms = chrono::Utc::now().timestamp_millis();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::sync::failure_repo::upsert_failure(&pool, &owner, &label, &path, &file_name, &kind_for_db, now_ms).await {
                    tracing::warn!("[failure_repo] persist failed for {label}/{path}: {e}");
                }
            });
        }
    }

    let _ = app.emit(
        events::FILE_FAILED,
        events::FileFailedPayload {
            label,
            path,
            file_id,
            kind: kind_payload,
            http_status,
        },
    );

    // Emit the banner event after the per-file detail so
    // listeners that subscribe to BOTH (e.g. a future
    // diagnostics overlay) see them in causal order:
    // file-row updates first, then the aggregate banner.
    if let Some(payload) = credits_payload {
        let _ = app.emit(events::CREDITS_EXHAUSTED, payload);
    }
}

/// Handle `SyncEvent::ProgressSnapshot`: clear served preparing overrides, apply
/// the snapshot fixups, stamp the observation-order ticket, and fire-and-forget
/// the emit.
///
/// Stays synchronous (called directly from the sync `on_event`) so the `seq`
/// stamp records the order the bridge *observed* snapshots — before the spawned
/// task's variable-latency intent-overlay DB read — which is what
/// [`try_claim_snapshot_seq`] relies on to converge the FE on the newest frame.
fn handle_progress_snapshot(app: &AppHandle, mut snapshot: SyncSnapshot) {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();

    // Keep-awake: every snapshot re-evaluates the "prevent idle system
    // sleep" assertion from the RAW aggregate counters (before the display
    // fixups below, which don't touch the counters). This funnel observes
    // every progress frame AND the forced emit of every terminal/cleanup
    // transition (`finalize_session_for_label`, `remove_files_for_label`,
    // `clear_all_data`, …), so it doubles as the safety net: a missed
    // terminal event is corrected by the next frame that says idle. `apply`
    // is edge-triggered — the 4 Hz steady state is a no-op.
    app_state
        .keep_awake
        .apply(crate::power::should_hold_keep_awake(&snapshot), "progress snapshot");

    // Once a label has real files in the session, its
    // "preparing" override has served its purpose — the
    // regular per-file widget takes over. Clearing here
    // (before the fingerprint check below) keeps the
    // preparing set tight and prevents a stuck override
    // surviving past the first plan_ready of a cycle.
    //
    // Gated on `is_any_preparing` so the common case (no
    // drive in preparing — every snapshot after the first
    // few seconds of a sync cycle) avoids both the
    // `HashSet` allocation and the per-label `clear` calls.
    // This path fires at up to 4 Hz during transfers, so
    // skipping the alloc when there's nothing to clear is
    // worth a one-line short-circuit.
    if app_state.preparing.is_any_preparing() {
        let labels_with_files: std::collections::HashSet<&str> = snapshot.files.iter().map(|f| f.label.as_ref()).collect();
        for label in &labels_with_files {
            app_state.preparing.clear(label);
        }
    }

    // `prepare_snapshot_for_emit` applies the stalled-completion
    // fixup, the preparing override (when no real session is yet
    // visible and any label is preparing), and the file-cap.
    // Without the stall fixup, hcfs-client's own file-watcher-
    // driven `changes_pending=true` leaves `is_active` stuck at
    // `true` indefinitely after all files are synced, so
    // `widget_state`, `effective_in_progress`, `effective_completed`,
    // and `status_variant` all still say "syncing" despite 100%
    // progress. Without the preparing override, file-watcher-
    // initiated cycles leave the widget hidden through the
    // scan + remote-state-fetch window even though the system
    // is actively working. See
    // `progress::fixup_stalled_completion` and
    // `progress::apply_preparing_override`.
    prepare_snapshot_for_emit(&mut snapshot, &app_state.preparing);

    // The intent overlay needs an async SQLite SUM/COUNT query,
    // but `on_event` is the SYNCHRONOUS half of
    // `SyncEventHandler` and hcfs-client's
    // `SyncRunner::emit_snapshot` invokes it on whatever thread
    // calls it — including the main GUI thread, which is NOT a
    // Tokio runtime worker (e.g. the console-upload dedup path
    // routes an emit through a synchronous context). A bare
    // `tokio::spawn` here panics "there is no reactor running"
    // on such a thread and the panic double-faults across the
    // hcfs callback boundary into a process abort. The fire-
    // and-forget work is therefore delegated to a helper that
    // schedules onto Tauri's OWNED global runtime regardless of
    // the calling thread's context — see `spawn_snapshot_emit`
    // and the in-repo precedent at
    // `sync::upload_processing::spawn_watchdog`.
    // Stamp the snapshot with its observation-order ticket HERE, in
    // the synchronous handler, BEFORE the spawn — so the ticket
    // reflects the order the bridge saw snapshots, not the order
    // their async DB reads happen to finish in. `fetch_add` returns
    // the prior value; `+1` keeps the first ticket at 1 (0 means
    // "nothing emitted yet"). Relaxed: this is a unique-ticket
    // counter, the ordering guarantee is enforced by the AcqRel
    // claim in `try_claim_snapshot_seq`.
    let seq = SNAPSHOT_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    spawn_snapshot_emit(app.clone(), snapshot, seq);
}

impl SyncEventHandler for TauriSyncBridge {
    #[expect(
        clippy::too_many_lines,
        reason = "Every non-trivial arm now delegates to a handle_* helper, so what remains is per-variant field-mapping boilerplate: destructure the upstream SyncEvent variant and rebuild its distinct typed Tauri payload before delegating. Keeping that 1:1 Rust-event-to-Tauri-event mapping inline in one match is what makes the correspondence auditable in a single place; a generic conversion layer would only hide it behind macros."
    )]
    fn on_event(&self, event: SyncEvent) {
        let Some(app) = self.app() else { return };

        match event {
            SyncEvent::SyncStarted {
                label,
                uploads,
                downloads,
                local_deletes,
                remote_deletes,
                upload_files,
                download_files,
                local_delete_files,
                remote_delete_files,
            } => handle_sync_started(
                &app,
                events::SyncStartedPayload {
                    label,
                    uploads,
                    downloads,
                    local_deletes,
                    remote_deletes,
                    upload_files,
                    download_files,
                    local_delete_files,
                    remote_delete_files,
                },
            ),
            SyncEvent::SyncCompleted {
                label,
                files_uploaded,
                files_downloaded,
                files_deleted_locally,
                files_deleted_remotely,
                conflicts_resolved,
                conflicts_skipped,
                files_failed,
            } => {
                // Single source of truth for the completion transition: the
                // cleanup (preparing-clear, banner-clear, failure-counter
                // recompute) and the per-file detail collection live in
                // `handle_sync_completed`, shared with the reviewed-conflict
                // command so the two paths can't drift. `files: Vec::new()` is
                // a placeholder the helper overwrites from session state.
                handle_sync_completed(
                    &app,
                    events::SyncCompletedPayload {
                        label,
                        files_uploaded,
                        files_downloaded,
                        files_deleted_locally,
                        files_deleted_remotely,
                        conflicts_resolved,
                        conflicts_skipped,
                        files: Vec::new(),
                    },
                    files_failed,
                );
            }
            SyncEvent::SyncError {
                label,
                error,
                retry_in_secs,
                consecutive_failures,
            } => {
                // Cancel-drop + epoch-gated defensive clears + emit all live in
                // `handle_sync_error`, shared with the reviewed-conflict command
                // so the two paths can't drift.
                handle_sync_error(
                    &app,
                    events::SyncErrorPayload {
                        label,
                        error,
                        retry_in_secs,
                        consecutive_failures,
                    },
                    // Auto-retry loop: rate-limit notifications per label.
                    FailureNotify::Gated,
                );
            }
            SyncEvent::SyncStopped { label } => handle_sync_stopped(&app, label),
            SyncEvent::SyncReset { account_id, message } => handle_sync_reset(&app, account_id, message),
            SyncEvent::PlanReady {
                label,
                uploads,
                downloads,
                local_deletes,
                remote_deletes,
                upload_files,
                download_files,
                local_delete_files,
                remote_delete_files,
            } => handle_plan_ready(
                &app,
                events::SyncPlanReadyPayload {
                    label,
                    uploads,
                    downloads,
                    local_deletes,
                    remote_deletes,
                    upload_files,
                    download_files,
                    local_delete_files,
                    remote_delete_files,
                },
            ),
            SyncEvent::ConflictsPending { label, staged } => {
                let _ = app.emit(events::CONFLICTS_PENDING, events::ConflictsPendingPayload { label, staged });
            }
            // Pre-plan and per-chunk progress is served via the throttled
            // `sync_progress_snapshot` event emitted from
            // `crate::sync::progress::update_file_progress`, which carries the
            // scan and fetch counters as `preparingScannedFiles` /
            // `preparingFetched` (see `sync::preparing`). Forwarding these
            // variants to Tauri would flood the webview for no consumer: no
            // frontend code listens to `hcfs_scan_progress` or
            // `hcfs_fetch_progress`, and `ScanProgress` alone fires once per
            // file walked — ~80k times per cycle on a large drive. See
            // lifecycle.rs `handle_transfer_progress` for the live path.
            SyncEvent::UploadProgress { .. }
            | SyncEvent::DownloadProgress { .. }
            | SyncEvent::ScanProgress { .. }
            | SyncEvent::FetchProgress { .. } => {}
            SyncEvent::FileTransferComplete { label } => {
                let _ = app.emit(events::FILE_TRANSFER_COMPLETE, events::LabelPayload { label });
            }
            SyncEvent::FileFailed {
                label,
                path,
                file_id,
                kind,
                http_status,
            } => handle_file_failed(
                &app,
                FileFailedEvent {
                    label,
                    path,
                    file_id,
                    kind,
                    http_status,
                },
            ),
            SyncEvent::HealthChanged { health } => {
                let _ = app.emit(events::CONNECTIVITY_CHANGED, &health);
            }
            SyncEvent::FolderRecovered { label } => handle_folder_recovered(&app, label),
            SyncEvent::ReviewModeTimeout { label } => {
                let _ = app.emit(events::REVIEW_MODE_TIMEOUT, events::LabelPayload { label });
            }
            // ActivityUpdated carries the originating drive label, so forward
            // it and the FE clears only that drive's stale-metadata banner
            // instead of every drive's.
            SyncEvent::ActivityUpdated { label } => {
                let _ = app.emit(events::ACTIVITY_UPDATED, events::LabelPayload { label });
            }
            SyncEvent::AuthRequired { error } => {
                let _ = app.emit(events::AUTH_RELOGIN_REQUIRED, events::AuthRequiredPayload { error });
            }
            SyncEvent::ProgressSnapshot { snapshot } => handle_progress_snapshot(&app, snapshot),
        }
    }
}

impl SyncCallbacks for TauriSyncBridge {
    fn refresh_auth_token(&self) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + '_>> {
        Box::pin(async {
            let app = self.app().ok_or_else(|| "AppHandle not available".to_string())?;
            use tauri::Manager;
            let app_state = app.state::<crate::app_state::AppState>();
            let pool = app_state.pool().map_err(|e| e.to_string())?;
            let acct = app_state.current_account_id().map_err(|e| e.to_string())?;

            crate::auth::service::refresh_auth_token_internal(pool, &app, &acct).await?;

            // Return the fresh token for the runner to update live drives
            crate::auth::tokens::get_api_token(pool, &acct)
                .await
                .map_err(|e| format!("Failed to read refreshed token: {e}"))?
                .ok_or_else(|| "No token found after refresh".to_string())
        })
    }

    fn is_token_expiring(&self) -> Pin<Box<dyn Future<Output = bool> + Send + '_>> {
        Box::pin(async {
            let Some(app) = self.app() else { return false };
            use tauri::Manager;
            let app_state = app.state::<crate::app_state::AppState>();
            if let (Ok(pool), Ok(acct)) = (app_state.pool(), app_state.current_account_id()) {
                crate::auth::tokens::is_token_expiring(pool, &acct, crate::auth::tokens::TOKEN_REFRESH_MARGIN_SECS).await
            } else {
                false
            }
        })
    }

    fn device_name(&self) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
        Box::pin(async {
            let app = self.app()?;
            use tauri::Manager;
            let app_state = app.state::<crate::app_state::AppState>();
            let pool = app_state.pool().ok()?;
            sqlx::query_scalar::<_, String>("SELECT device_name FROM device_settings WHERE id = 1")
                .fetch_optional(pool)
                .await
                .ok()
                .flatten()
        })
    }

    fn current_account_id(&self) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + '_>> {
        Box::pin(async {
            let app = self.app().ok_or_else(|| "AppHandle not available".to_string())?;
            use tauri::Manager;
            app.state::<crate::app_state::AppState>().current_account_id().map_err(|e| e.to_string())
        })
    }
}

/// Desktop-side intent-manifest overlay piggybacked onto the snapshot wire.
///
/// All fields are `Option` so the wire wrapper can render `null` for an
/// emit that happens before a user is logged in (or before the DB pool is
/// installed) — the FE treats absent fields as "no overlay", which is the
/// correct render for "we don't know yet". An all-`None` overlay is the
/// `Default` and never participates in `intent_active`'s "X of Y" gate.
///
/// `Copy` so the fingerprint helper can take it by value without forcing
/// the spawn body to manage a reference's lifetime alongside the
/// `&snapshot` borrow it already owns. The struct is six pointer-sized
/// `Option`s plus one `Option<bool>` — passing by value is ~40 bytes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct SyncIntentOverlay {
    total_files: Option<u64>,
    total_bytes: Option<u64>,
    completed_files: Option<u64>,
    completed_bytes: Option<u64>,
    /// `Some(true)` iff `total_files > completed_files`. The FE gates the
    /// "Syncing X GB of Y" line on this — `None` AND `Some(false)` both
    /// hide the line, matching the "no work pending" UX.
    active: Option<bool>,
}

/// Snapshot payload sent on the `sync_progress_snapshot` Tauri channel.
///
/// Wraps `hcfs_client::sync::SyncSnapshot` via `#[serde(flatten)]` and
/// appends five desktop-side overlay fields representing the intent
/// manifest's "X of Y" totals — what the user dragged in vs what's
/// uploaded so far, which is the only progress signal that survives an
/// app restart.
///
/// The borrowed `inner: &'a SyncSnapshot` keeps the wire shape allocation-
/// free; the wrapper is consumed synchronously by `serde_json` inside
/// `app.emit`, so the borrow never escapes the emit call.
///
/// All five overlay fields are `Option`: a snapshot emit that races
/// AppState wiring (or fires before the user logs in) carries `None` for
/// every overlay field. The FE contract is "treat None as no overlay";
/// never coerce to zero (which would falsely render a "0 of 0" widget).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncSnapshotWire<'a> {
    #[serde(flatten)]
    inner: &'a SyncSnapshot,
    intent_total_files: Option<u64>,
    intent_total_bytes: Option<u64>,
    intent_completed_files: Option<u64>,
    intent_completed_bytes: Option<u64>,
    intent_active: Option<bool>,
    /// Local-pending summary for the startup "preparing" window: on-disk files
    /// not yet in the synced baseline, summed across drives. `None` outside that
    /// window (no startup-seeded drive). The FE shows "N files · X · Preparing"
    /// when present and `widgetState == "preparing"`, then the live session
    /// supersedes it. See `crate::sync::preparing::PreparingState::pending_summary`.
    preparing_pending_files: Option<u64>,
    preparing_pending_bytes: Option<u64>,
    /// Live indexing detail for the preparing window ("Preparing — 1,234
    /// files scanned"): the engine's cumulative scan counter, and the
    /// fetched/total remote-state entries, summed across visibly-preparing
    /// drives. Each is `None` when no preparing drive is in that phase.
    /// Rendered by the FE only while `widgetState == "preparing"`. See
    /// `crate::sync::preparing::PreparingState::activity_totals`.
    preparing_scanned_files: Option<u64>,
    preparing_fetched_entries: Option<u64>,
    preparing_fetch_total_entries: Option<u64>,
    /// Paths of errored rows whose failure resolves itself on the next cycle
    /// (see `crate::sync::events::FileFailureKindPayload::is_transient`).
    /// `None` when there are none — the FE treats absent as "nothing retrying".
    ///
    /// Needed because the per-file rows come from the FOREIGN `SyncSnapshot`,
    /// which carries only a status and a reason string; there is nowhere on
    /// `FileProgress` to hang a desktop classification, so it rides alongside
    /// and the FE joins by path.
    transient_error_paths: Option<Vec<String>>,
}

/// Collect the paths of errored rows that will retry themselves.
///
/// Derived from the snapshot being emitted, so the flags cannot disagree with
/// the rows they describe (the file list is capped and re-sorted before emit —
/// a separately-accumulated set would drift out of step with it).
///
/// `None` rather than an empty vec when nothing is retrying: the FE reads
/// absent as "nothing retrying" like every other overlay field here.
fn transient_error_paths(snapshot: &SyncSnapshot) -> Option<Vec<String>> {
    use hcfs_client::engine::progress::state::FileProgressStatus;

    let paths: Vec<String> = snapshot
        .files
        .iter()
        .filter(|f| f.status == FileProgressStatus::Error)
        .filter(|f| f.error.as_deref().is_some_and(crate::sync::events::is_transient_reason))
        .map(|f| f.path.to_string())
        .collect();

    if paths.is_empty() { None } else { Some(paths) }
}

/// The desktop-side preparing tail of the snapshot wire, read from
/// [`crate::sync::preparing::PreparingState`] at emit time.
///
/// Bundled into one `Copy` + `Hash` struct so the SAME values feed both
/// [`snapshot_fingerprint`] and the emitted [`SyncSnapshotWire`]. The
/// fingerprint inclusion is load-bearing: during a long scan the
/// underlying `SyncSnapshot` is frame-to-frame identical (empty session,
/// preparing override applied), so without these fields in the hash the
/// duplicate-emit gate would freeze the live counter on its first value.
#[derive(Clone, Copy, Default, Eq, Hash, PartialEq)]
struct PreparingWireTail {
    pending_files: Option<u64>,
    pending_bytes: Option<u64>,
    scanned_files: Option<u64>,
    fetched_entries: Option<u64>,
    fetch_total_entries: Option<u64>,
}

/// Read the live preparing tail (startup pending summary + indexing
/// activity totals) for the snapshot wire. All-`None` when `AppState` is
/// not managed yet (an emit racing app setup) — the FE treats absent
/// fields as "no detail".
fn read_preparing_wire_tail<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PreparingWireTail {
    use tauri::Manager;
    let Some(state) = app.try_state::<crate::app_state::AppState>() else {
        return PreparingWireTail::default();
    };
    let (pending_files, pending_bytes) = state.preparing.pending_summary().map_or((None, None), |(f, b)| (Some(f), Some(b)));
    let totals = state.preparing.activity_totals();
    PreparingWireTail {
        pending_files,
        pending_bytes,
        scanned_files: totals.scanned_files,
        fetched_entries: totals.fetched_entries,
        fetch_total_entries: totals.fetch_total_entries,
    }
}

/// Build the intent-overlay numbers for the current account, summed
/// across every drive the user has.
///
/// Returns `SyncIntentOverlay::default()` (all-`None`) when there's no
/// active account or the DB read fails — the wire wrapper renders that as
/// missing JSON fields and the FE treats absent fields as "no overlay".
/// We deliberately do NOT propagate `IntentError::Db` to the IPC channel:
/// a transient DB hiccup must not drop the snapshot emit itself, because
/// the FE depends on the hcfs progress fields for the per-file widget
/// regardless of whether the overlay is known.
///
/// Why a single `totals_for_account` query (not N `totals_for_drive`):
/// the emit fires at up to 4 Hz during transfers and the user may have
/// multiple drives configured. One aggregate-summing query keeps the
/// per-emit cost to a single indexed SQLite scan. Source: see
/// `IntentRepo::totals_for_account`'s `# Why account-scoped` block.
/// Fire-and-forget the intent-overlay build + fingerprint-claim + snapshot
/// emit onto Tauri's owned global async runtime.
///
/// # Why this exists / why `tauri::async_runtime::spawn`
///
/// `on_event` is the synchronous half of `SyncEventHandler`. hcfs-client's
/// `SyncRunner::emit_snapshot` calls it on whatever thread invokes it —
/// `finalize_session_for_label`, `handle_sync_error`, and (the crash we are
/// fixing) a main-thread console-upload path that is NOT inside a Tokio
/// runtime. Bare `tokio::spawn` / `Handle::current()` panic
/// ("there is no reactor running, must be called from the context of a
/// Tokio 1.x runtime") on such a thread, and that panic double-faults
/// across the hcfs callback boundary into `failed to initiate panic …
/// aborting`. `tauri::async_runtime::spawn` schedules onto Tauri's own
/// global runtime handle and is therefore safe from ANY thread regardless
/// of ambient runtime context — the same reasoning documented at
/// `sync::upload_processing::spawn_watchdog` and used by
/// `lifecycle::spawn_record_intent_plan` / `spawn_mark_intent_completed`.
///
/// # Ordering / dedup contract
///
/// Each snapshot runs in its own task that first awaits a variable-latency
/// `build_intent_overlay` SQLite read, so two close-spaced snapshots can finish
/// that read in EITHER order. `seq` (stamped at `on_event` time, before the
/// spawn) records the order the bridge actually observed them, and
/// `try_claim_snapshot_seq` drops any task whose ticket is not strictly newer
/// than the last emitted — so the FE always converges on the newest frame even
/// when reads complete out of order. This fixes the stuck-below-100%/stale
/// frame the old "reorder is acceptable, the FE re-renders either way" contract
/// allowed: at end-of-cycle there is no later snapshot to correct a reordered
/// older frame. The seq gate is checked FIRST; the fingerprint gate
/// (`try_claim_snapshot_fingerprint`) then collapses content-identical emits.
///
/// Ownership: `app` is `Clone` (cheap `Arc`); `snapshot` is moved into the
/// future and the `&snapshot` borrow inside is owned-by-future, so the
/// future is `'static + Send`, satisfying `tauri::async_runtime::spawn`'s
/// bound (identical to `tokio::spawn`'s). `seq` is `Copy`.
fn overlay_seq_is_stale(last_emitted: u64, seq: u64) -> bool {
    seq <= last_emitted
}

fn reset_snapshot_emit_gates() {
    // Logout / account switch must not restart `SNAPSHOT_SEQ` or
    // `LAST_EMITTED_SEQ` at 0. `handle_sync_reset` can `emit_snapshot`
    // (and any in-flight ProgressSnapshot still holds a high ticket)
    // before this runs; zeroing lets that task claim the old mark, then
    // `overlay_seq_is_stale` drops every post-login frame until the
    // counter catches up. The fingerprint is the inherit risk — a
    // coincidentally identical first frame of the new account.
    LAST_EMITTED_FINGERPRINT.store(0, Ordering::Relaxed);
}

fn spawn_snapshot_emit<R: tauri::Runtime>(app: tauri::AppHandle<R>, snapshot: SyncSnapshot, seq: u64) {
    tauri::async_runtime::spawn(async move {
        // Peek before the SQLite overlay read so a task that already lost
        // the race does not SUM `sync_intent` for a frame we will drop.
        if overlay_seq_is_stale(LAST_EMITTED_SEQ.load(Ordering::Acquire), seq) {
            return;
        }
        let overlay = build_intent_overlay(&app).await;
        // Ordering gate first: a snapshot that lost the DB-read race to a newer
        // one must NOT emit (and must NOT touch the fingerprint cursor).
        if !try_claim_snapshot_seq(&LAST_EMITTED_SEQ, seq) {
            return;
        }
        // Preparing tail (startup pending summary + live indexing counters).
        // Read here — not threaded through the snapshot — so it tracks the
        // live PreparingState, and BEFORE the fingerprint so counter motion
        // alone (identical underlying snapshot during a scan) still defeats
        // the duplicate-emit gate.
        let preparing = read_preparing_wire_tail(&app);
        let fp = snapshot_fingerprint(&snapshot, overlay, preparing);
        if try_claim_snapshot_fingerprint(&LAST_EMITTED_FINGERPRINT, fp) {
            let wire = SyncSnapshotWire {
                inner: &snapshot,
                intent_total_files: overlay.total_files,
                intent_total_bytes: overlay.total_bytes,
                intent_completed_files: overlay.completed_files,
                intent_completed_bytes: overlay.completed_bytes,
                intent_active: overlay.active,
                preparing_pending_files: preparing.pending_files,
                preparing_pending_bytes: preparing.pending_bytes,
                preparing_scanned_files: preparing.scanned_files,
                preparing_fetched_entries: preparing.fetched_entries,
                preparing_fetch_total_entries: preparing.fetch_total_entries,
                transient_error_paths: transient_error_paths(&snapshot),
            };
            let _ = app.emit(events::PROGRESS_SNAPSHOT, &wire);
        }
    });
}

async fn build_intent_overlay<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> SyncIntentOverlay {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();

    // Not-logged-in is a load-bearing case — the auto_init flow emits
    // snapshots before AuthInfo is populated. Treat as "no overlay".
    let Ok(account_id) = app_state.current_account_id() else {
        return SyncIntentOverlay::default();
    };
    let pool = match app_state.pool() {
        Ok(p) => p.clone(),
        Err(e) => {
            tracing::debug!(error = %e, "intent overlay: pool unavailable, emitting without overlay");
            return SyncIntentOverlay::default();
        }
    };

    let repo = IntentRepo::new(pool);
    match repo.totals_for_account(&account_id).await {
        Ok(totals) => SyncIntentOverlay {
            total_files: Some(totals.total_files),
            total_bytes: Some(totals.total_bytes),
            completed_files: Some(totals.completed_files),
            completed_bytes: Some(totals.completed_bytes),
            // `active` flips false when the manifest is fully drained
            // OR genuinely empty (no rows). The "fully drained" branch
            // lets the FE hide the line as soon as totals == completed,
            // without a separate widget-state field. An empty manifest
            // (total = 0) maps to `false` rather than `None` because
            // we DO know there's no overlay work — `None` is reserved
            // for "we couldn't read the DB".
            active: Some(totals.total_files > totals.completed_files),
        },
        Err(e) => {
            tracing::warn!(error = %e, "intent overlay: totals_for_account failed");
            SyncIntentOverlay::default()
        }
    }
}

/// Compute a small content fingerprint for a `SyncSnapshot` + its
/// intent-overlay and preparing tails.
///
/// Hashes every scalar field the FE renders plus a per-file
/// (path, action, status, bytes_transferred, bytes_encrypted, total_bytes,
/// error) tuple so any user-visible change in per-file progress flips the
/// fingerprint. The overlay's five `Option<u64>` / `Option<bool>` fields
/// are folded in after the per-file loop so an overlay-only change (rare
/// but possible — e.g. a `mark_completed` write while no transfer is in
/// flight) still triggers an emit. Pure ordering changes in the `files`
/// vec also flip the fingerprint by design — the FE renders rows in the
/// order Rust sent them. `0` is reserved for the never-emitted sentinel
/// and is remapped to `1` to keep it distinct from the gate's baseline.
///
/// **Collision contract**: the gate uses `DefaultHasher` (SipHash-1-3,
/// 64-bit). Two distinct snapshots colliding to the same `u64` is on the
/// order of 1 in 2^64 per pair — practically impossible — and the failure
/// mode is "FE keeps showing the previous snapshot until the next emit."
/// The throttled-but-correct `progress::update_file_progress` path will
/// re-emit within ~250 ms anyway, so even a freak collision corrects
/// itself within one frame.
///
/// **Concurrent-claim contract**: pairs with `try_claim_snapshot_fingerprint`'s
/// `swap` (not `compare_exchange`). The emit path runs from a
/// `tokio::spawn` (so multiple emits can race), but `swap` returns the
/// previous value to each racer — two racers with different fingerprints
/// both see `prev != fp` and both emit. Two racers with identical
/// fingerprints might both emit (one duplicate IPC, harmless) or might
/// dedupe to one (the winning racer's `swap` matches the loser's later
/// `prev`); both outcomes are acceptable.
fn snapshot_fingerprint(s: &SyncSnapshot, overlay: SyncIntentOverlay, preparing: PreparingWireTail) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.is_active.hash(&mut h);
    s.progress_bytes.hash(&mut h);
    s.bytes_expected.hash(&mut h);
    s.total_files.hash(&mut h);
    s.completed_files.hash(&mut h);
    s.failed_files.hash(&mut h);
    s.retry_in_secs.hash(&mut h);
    s.last_error.hash(&mut h);
    s.expected_uploads.hash(&mut h);
    s.expected_downloads.hash(&mut h);
    s.expected_local_deletes.hash(&mut h);
    s.expected_remote_deletes.hash(&mut h);
    // `started_at` distinguishes a new session from the previous one when
    // their headline counters happen to align. Without this, a session
    // that ends and immediately restarts with the same expected counts
    // would have its first snapshot silently dropped.
    s.started_at.hash(&mut h);
    s.completed_at.hash(&mut h);
    s.widget_state.hash(&mut h);
    s.widget_visible.hash(&mut h);
    s.combined_progress_bytes.hash(&mut h);
    s.combined_bytes_expected.hash(&mut h);
    s.deleted_count.hash(&mut h);
    s.synced_count.hash(&mut h);
    s.actual_total.hash(&mut h);
    s.status_variant.hash(&mut h);
    s.sync_direction.hash(&mut h);
    s.effective_in_progress.hash(&mut h);
    s.effective_completed.hash(&mut h);
    for f in &s.files {
        f.path.as_ref().hash(&mut h);
        // FileAction and FileProgressStatus do NOT derive Hash in
        // hcfs-client (only Debug + Clone + PartialEq + serde). They are
        // payload-free, so `mem::discriminant` is sufficient and avoids a
        // per-file `format!("{:?}", …)` allocation pair (10k files × 2 strings
        // × every emit).
        std::mem::discriminant(&f.action).hash(&mut h);
        std::mem::discriminant(&f.status).hash(&mut h);
        f.bytes_transferred.hash(&mut h);
        f.bytes_encrypted.hash(&mut h);
        f.total_bytes.hash(&mut h);
        f.error.as_ref().map(AsRef::as_ref).hash(&mut h);
    }
    // Overlay tail. `Option<T>: Hash` when `T: Hash` (verified at
    // doc.rust-lang.org/std/option/enum.Option.html#impl-Hash-for-Option<T>),
    // so each field hashes its presence + payload in one call.
    overlay.total_files.hash(&mut h);
    overlay.total_bytes.hash(&mut h);
    overlay.completed_files.hash(&mut h);
    overlay.completed_bytes.hash(&mut h);
    overlay.active.hash(&mut h);
    // Preparing tail: the live "N files scanned" / "f of t entries"
    // counters must flip the fingerprint on their own — during a scan the
    // rest of the snapshot is frame-to-frame identical, and a frozen
    // fingerprint would freeze the counter on the FE.
    preparing.hash(&mut h);
    let h = h.finish();
    if h == 0 { 1 } else { h }
}

/// Atomically claim the right to emit a snapshot whose fingerprint is `fp`.
///
/// Returns `true` if `fp` differs from the previously stored fingerprint
/// (caller should emit). Returns `false` if `fp` matches what was last
/// emitted (caller should skip the IPC). Initial state of `0` always
/// allows the first emit through.
///
/// Uses `swap`, not `compare_exchange`, because the bridge has a single
/// dispatch path (`TauriSyncBridge::on_event`) — see the single-emitter
/// contract on `snapshot_fingerprint`. Concurrent callers would need CAS.
fn try_claim_snapshot_fingerprint(last: &AtomicU64, fp: u64) -> bool {
    let prev = last.swap(fp, Ordering::AcqRel);
    prev != fp
}

/// Atomically claim the right to emit the snapshot stamped with ticket `seq`.
///
/// Returns `true` only if `seq` is strictly newer than every ticket emitted so
/// far, advancing the high-water mark to `seq`; returns `false` for a stale
/// (reordered) snapshot, leaving the mark untouched. This is the monotonic-max
/// guard that makes the FE converge on the newest frame regardless of the order
/// the spawned emit tasks finish their DB reads.
///
/// Unlike [`try_claim_snapshot_fingerprint`]'s `swap`, this MUST be a CAS loop:
/// the emit tasks run concurrently, and a plain `swap(seq)` could let an older
/// ticket overwrite a newer mark. `AcqRel`/`Acquire` mirrors the fingerprint
/// claim for consistency (axiom `rust_quality_92`); `compare_exchange_weak` is
/// used over the 1.99-deprecated `fetch_update`. The `seq` value carries no
/// shared data (the snapshot is moved into the task), so the ordering is
/// conservative, not load-bearing.
fn try_claim_snapshot_seq(last: &AtomicU64, seq: u64) -> bool {
    let mut prev = last.load(Ordering::Acquire);
    loop {
        if seq <= prev {
            return false;
        }
        match last.compare_exchange_weak(prev, seq, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return true,
            Err(observed) => prev = observed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_seq_is_stale_when_ticket_is_not_newer() {
        assert!(overlay_seq_is_stale(5, 5));
        assert!(overlay_seq_is_stale(5, 4));
        assert!(!overlay_seq_is_stale(5, 6));
        assert!(!overlay_seq_is_stale(0, 1));
    }

    #[test]
    fn reset_snapshot_emit_gates_clears_fingerprint_only() {
        LAST_EMITTED_FINGERPRINT.store(99, Ordering::Relaxed);
        LAST_EMITTED_SEQ.store(9000, Ordering::Relaxed);
        SNAPSHOT_SEQ.store(9000, Ordering::Relaxed);
        reset_snapshot_emit_gates();
        assert_eq!(LAST_EMITTED_FINGERPRINT.load(Ordering::Relaxed), 0);
        assert_eq!(LAST_EMITTED_SEQ.load(Ordering::Relaxed), 9000);
        assert_eq!(SNAPSHOT_SEQ.load(Ordering::Relaxed), 9000);
        assert!(
            try_claim_snapshot_seq(&LAST_EMITTED_SEQ, 9001),
            "next ticket after a high session must still be claimable",
        );
        assert!(
            overlay_seq_is_stale(LAST_EMITTED_SEQ.load(Ordering::Relaxed), 1),
            "restarting tickets at 1 after a high session is the frozen-widget bug",
        );
    }

    #[test]
    fn first_fingerprint_always_emits() {
        let last = AtomicU64::new(0);
        assert!(try_claim_snapshot_fingerprint(&last, 42));
        assert_eq!(last.load(Ordering::Acquire), 42);
    }

    #[test]
    fn duplicate_fingerprint_skips_emit() {
        let last = AtomicU64::new(0);
        assert!(try_claim_snapshot_fingerprint(&last, 42));
        // Same fingerprint again — caller should skip the IPC.
        assert!(!try_claim_snapshot_fingerprint(&last, 42));
        assert_eq!(last.load(Ordering::Acquire), 42);
    }

    #[test]
    fn changed_fingerprint_emits() {
        let last = AtomicU64::new(0);
        assert!(try_claim_snapshot_fingerprint(&last, 42));
        assert!(try_claim_snapshot_fingerprint(&last, 99));
        assert_eq!(last.load(Ordering::Acquire), 99);
    }

    #[test]
    fn snapshot_seq_only_newest_wins() {
        let last = AtomicU64::new(0);
        // First ticket always passes.
        assert!(try_claim_snapshot_seq(&last, 1));
        // A newer ticket passes and advances the mark.
        assert!(try_claim_snapshot_seq(&last, 2));
        assert_eq!(last.load(Ordering::Acquire), 2);
        // A reordered older ticket (lost the DB-read race) is dropped and does
        // NOT move the mark back — this is the stale-frame fix.
        assert!(!try_claim_snapshot_seq(&last, 1));
        assert_eq!(last.load(Ordering::Acquire), 2);
        // An equal ticket is also rejected (strictly-newer only).
        assert!(!try_claim_snapshot_seq(&last, 2));
    }

    /// Build a fixture `SyncSnapshot` with no files. Used as the baseline
    /// for differential fingerprint tests below.
    /// Wrap a snapshot with all-`None` overlays, isolating whatever the wire
    /// derives from the snapshot itself.
    fn wire_for_test(inner: &SyncSnapshot) -> SyncSnapshotWire<'_> {
        SyncSnapshotWire {
            inner,
            intent_total_files: None,
            intent_total_bytes: None,
            intent_completed_files: None,
            intent_completed_bytes: None,
            intent_active: None,
            preparing_pending_files: None,
            preparing_pending_bytes: None,
            preparing_scanned_files: None,
            preparing_fetched_entries: None,
            preparing_fetch_total_entries: None,
            transient_error_paths: transient_error_paths(inner),
        }
    }

    fn fixture_snapshot() -> SyncSnapshot {
        SyncSnapshot {
            is_active: true,
            overall_percent: 50,
            progress_bytes: 1000,
            bytes_expected: 2000,
            total_files: 1,
            completed_files: 0,
            failed_files: 0,
            retry_in_secs: 0,
            last_error: None,
            expected_uploads: 1,
            expected_downloads: 0,
            expected_local_deletes: 0,
            expected_remote_deletes: 0,
            started_at: Some(1_700_000_000_000),
            completed_at: None,
            files: Vec::new(),
            widget_state: "active".to_string(),
            widget_visible: true,
            combined_progress_bytes: 1000,
            combined_bytes_expected: 4000,
            deleted_count: 0,
            synced_count: 0,
            actual_total: 1,
            status_variant: "progress".to_string(),
            sync_direction: "upload".to_string(),
            effective_in_progress: true,
            effective_completed: false,
        }
    }

    /// Regression: the fingerprint MUST change when `progress_bytes`
    /// changes. Catches the "we forgot to hash field X" class of bug.
    #[test]
    fn fingerprint_changes_when_progress_bytes_changes() {
        let mut a = fixture_snapshot();
        let mut b = fixture_snapshot();
        b.progress_bytes = 1500;
        let empty = SyncIntentOverlay::default();
        assert_ne!(
            snapshot_fingerprint(&a, empty, PreparingWireTail::default()),
            snapshot_fingerprint(&b, empty, PreparingWireTail::default())
        );
        // And while we're here, verify identical snapshots produce
        // identical fingerprints (the gate's whole reason for existing).
        a.progress_bytes = 1500;
        assert_eq!(
            snapshot_fingerprint(&a, empty, PreparingWireTail::default()),
            snapshot_fingerprint(&b, empty, PreparingWireTail::default())
        );
    }

    /// Regression for the `started_at` gap: a session that ends and
    /// immediately restarts with the same expected counts must produce a
    /// different fingerprint.
    #[test]
    fn fingerprint_changes_when_started_at_changes() {
        let mut a = fixture_snapshot();
        let mut b = fixture_snapshot();
        b.started_at = Some(1_700_000_001_000);
        let empty = SyncIntentOverlay::default();
        assert_ne!(
            snapshot_fingerprint(&a, empty, PreparingWireTail::default()),
            snapshot_fingerprint(&b, empty, PreparingWireTail::default())
        );
        a.started_at = b.started_at;
        assert_eq!(
            snapshot_fingerprint(&a, empty, PreparingWireTail::default()),
            snapshot_fingerprint(&b, empty, PreparingWireTail::default())
        );
    }

    /// Regression: an overlay-only change MUST flip the
    /// fingerprint so an emit fires even if every hcfs-side field is
    /// byte-identical. Without this, `mark_completed` advancing the
    /// intent totals while no transfer is in flight (e.g. the closing
    /// per-file callback fires right after the FE-visible snapshot
    /// already settled) would not re-emit, and the FE's "X of Y" line
    /// would stay frozen until the next unrelated snapshot tick.
    #[test]
    fn fingerprint_changes_when_overlay_changes() {
        let a = fixture_snapshot();
        let empty = SyncIntentOverlay::default();
        let with_totals = SyncIntentOverlay {
            total_files: Some(10),
            total_bytes: Some(1_000),
            completed_files: Some(5),
            completed_bytes: Some(500),
            active: Some(true),
        };
        assert_ne!(
            snapshot_fingerprint(&a, empty, PreparingWireTail::default()),
            snapshot_fingerprint(&a, with_totals, PreparingWireTail::default()),
        );
        // Sanity: identical overlays produce identical fingerprints.
        assert_eq!(
            snapshot_fingerprint(&a, with_totals, PreparingWireTail::default()),
            snapshot_fingerprint(&a, with_totals, PreparingWireTail::default()),
        );
    }

    /// Regression: preparing-tail motion alone MUST flip the fingerprint.
    /// During a long scan the underlying `SyncSnapshot` is frame-to-frame
    /// identical (empty session + preparing override), so if the live
    /// "N files scanned" counter were outside the hash, the duplicate-emit
    /// gate would freeze the widget on the first emitted value.
    #[test]
    fn fingerprint_changes_when_preparing_counter_moves() {
        let a = fixture_snapshot();
        let empty = SyncIntentOverlay::default();
        let scanned_100 = PreparingWireTail {
            scanned_files: Some(100),
            ..PreparingWireTail::default()
        };
        let scanned_200 = PreparingWireTail {
            scanned_files: Some(200),
            ..PreparingWireTail::default()
        };
        assert_ne!(snapshot_fingerprint(&a, empty, scanned_100), snapshot_fingerprint(&a, empty, scanned_200),);
        // Phase flip (scan → fetch) also re-emits.
        let fetching = PreparingWireTail {
            fetched_entries: Some(10),
            fetch_total_entries: Some(90),
            ..PreparingWireTail::default()
        };
        assert_ne!(snapshot_fingerprint(&a, empty, scanned_200), snapshot_fingerprint(&a, empty, fetching),);
        // Sanity: identical tails produce identical fingerprints.
        assert_eq!(snapshot_fingerprint(&a, empty, scanned_100), snapshot_fingerprint(&a, empty, scanned_100),);
    }

    /// Build a snapshot file row in the `Error` state carrying `reason`.
    fn errored_file(path: &str, reason: &str) -> hcfs_client::engine::progress::state::FileProgress {
        use hcfs_client::engine::progress::state::{FileProgress, FileProgressStatus};
        FileProgress {
            path: path.into(),
            file_name: path.rsplit('/').next().unwrap_or(path).into(),
            label: "drive".into(),
            action: hcfs_client::engine::progress::state::FileAction::Upload,
            status: FileProgressStatus::Error,
            progress_percent: 0,
            bytes_encrypted: 0,
            bytes_transferred: 0,
            total_bytes: 10,
            resumed_from_bytes: None,
            error: Some(reason.into()),
            completed_at: Some(1_700_000_000_000),
        }
    }

    /// The widget needs to tell "this retries itself" from "this needs you",
    /// and the snapshot's per-file rows come from the foreign `SyncSnapshot`,
    /// so the decision rides along as a desktop overlay listing the paths.
    /// Without it a mid-upload change renders identically to a hard failure.
    #[test]
    fn transiently_failed_paths_are_flagged_on_the_wire() {
        let transient = crate::sync::events::FileFailureKindPayload::ChangedWhileUploading.display_reason();
        let hard = crate::sync::events::FileFailureKindPayload::ServerError { status: 500 }.display_reason();

        let mut inner = fixture_snapshot();
        inner.files = vec![
            errored_file("project/node_modules/a.js", &transient),
            errored_file("docs/report.pdf", &hard),
        ];

        let json = serde_json::to_value(wire_for_test(&inner)).expect("serialize wire");
        let flagged = json["transientErrorPaths"].as_array().expect("transientErrorPaths present");

        assert_eq!(flagged.len(), 1, "only the self-resolving row may be flagged: {flagged:?}");
        assert_eq!(flagged[0], "project/node_modules/a.js");
    }

    /// A cycle with no transient failures must not ship an empty array the FE
    /// has to special-case — absent means "nothing retrying".
    #[test]
    fn no_transient_failures_means_no_overlay_field_value() {
        let inner = fixture_snapshot();
        let json = serde_json::to_value(wire_for_test(&inner)).expect("serialize wire");
        assert!(
            json["transientErrorPaths"].is_null(),
            "expected null, got {}",
            json["transientErrorPaths"]
        );
    }

    /// Wire-format contract: serializing `SyncSnapshotWire` must
    /// (a) inline the inner snapshot's camelCase fields at the top
    ///     level (verifies `#[serde(flatten)]` did its job),
    /// (b) include the five overlay fields in camelCase, and
    /// (c) round-trip `Some` overlay values as the underlying scalar.
    /// The FE depends on the exact field names — break this test and
    /// the widget renders nothing.
    #[test]
    fn snapshot_wire_serializes_inner_flat_with_intent_camelcase() {
        let inner = fixture_snapshot();
        let wire = SyncSnapshotWire {
            inner: &inner,
            intent_total_files: Some(10),
            intent_total_bytes: Some(1_000),
            intent_completed_files: Some(5),
            intent_completed_bytes: Some(500),
            intent_active: Some(true),
            preparing_pending_files: Some(7),
            preparing_pending_bytes: Some(700),
            preparing_scanned_files: Some(1234),
            preparing_fetched_entries: Some(40),
            preparing_fetch_total_entries: Some(90),
            transient_error_paths: None,
        };
        let json = serde_json::to_value(&wire).expect("serialize wire");

        // Overlay fields (camelCase).
        assert_eq!(json["intentTotalFiles"], 10);
        assert_eq!(json["intentTotalBytes"], 1_000);
        assert_eq!(json["intentCompletedFiles"], 5);
        assert_eq!(json["intentCompletedBytes"], 500);
        assert_eq!(json["intentActive"], true);
        assert_eq!(json["preparingPendingFiles"], 7);
        assert_eq!(json["preparingPendingBytes"], 700);

        // No `inner` nesting — flatten promoted the inner fields up.
        assert!(json.get("inner").is_none(), "flatten must inline `inner`");

        // Spot-check one inner snapshot field at the top level. The
        // fixture sets `widget_state = "active"`, which serializes as
        // camelCase `widgetState`.
        assert_eq!(json["widgetState"], "active");
        assert_eq!(json["isActive"], true);
    }

    /// `None` overlay fields render as JSON `null` (default serde
    /// behavior). The FE checks for absent / `null` to mean "no
    /// overlay" — treating `null` as zero would falsely render a
    /// "0 of 0" widget for users who haven't been logged in yet.
    #[test]
    fn snapshot_wire_serializes_none_overlay_as_null() {
        let inner = fixture_snapshot();
        let wire = SyncSnapshotWire {
            inner: &inner,
            intent_total_files: None,
            intent_total_bytes: None,
            intent_completed_files: None,
            intent_completed_bytes: None,
            intent_active: None,
            preparing_pending_files: None,
            preparing_pending_bytes: None,
            preparing_scanned_files: None,
            preparing_fetched_entries: None,
            preparing_fetch_total_entries: None,
            transient_error_paths: None,
        };
        let json = serde_json::to_value(&wire).expect("serialize wire");
        assert!(json["intentTotalFiles"].is_null());
        assert!(json["intentTotalBytes"].is_null());
        assert!(json["intentCompletedFiles"].is_null());
        assert!(json["intentCompletedBytes"].is_null());
        assert!(json["intentActive"].is_null());
        assert!(json["preparingPendingFiles"].is_null());
        assert!(json["preparingPendingBytes"].is_null());
    }

    /// IPC wire-contract guard (Layer 0): pin the COMPLETE set of JSON keys
    /// the `sync_progress_snapshot` event carries.
    ///
    /// `fixture_snapshot()` already pins the inner `SyncSnapshot` *field set*
    /// at compile time — it names every field, so an hcfs-client field add or
    /// rename fails to build. This test adds the dimension the compiler can't
    /// see: the exact serialized key *strings*. A foreign serde-attribute drift
    /// — hcfs flipping `rename_all = "camelCase"` to `snake_case`, or adding a
    /// per-field `#[serde(rename)]` — leaves the Rust field names (and thus the
    /// fixture) untouched but silently changes the JSON the frontend reads.
    /// Asserting the full key set turns that silent break into a failing
    /// `cargo test`. If you change the wire shape ON PURPOSE, update this list
    /// AND `app/lib/types/syncSnapshot.ts` in the same change.
    #[test]
    fn snapshot_wire_pins_full_json_key_set() {
        let inner = fixture_snapshot();
        let wire = SyncSnapshotWire {
            inner: &inner,
            intent_total_files: Some(1),
            intent_total_bytes: Some(1),
            intent_completed_files: Some(1),
            intent_completed_bytes: Some(1),
            intent_active: Some(true),
            preparing_pending_files: Some(1),
            preparing_pending_bytes: Some(1),
            preparing_scanned_files: Some(1),
            preparing_fetched_entries: Some(1),
            preparing_fetch_total_entries: Some(1),
            transient_error_paths: None,
        };
        let json = serde_json::to_value(&wire).expect("serialize wire");
        let obj = json.as_object().expect("wire serializes to a JSON object");

        let mut actual: Vec<&str> = obj.keys().map(String::as_str).collect();
        actual.sort_unstable();

        // The 27 flattened `SyncSnapshot` fields (camelCase) plus the 11 desktop
        // overlay fields `SyncSnapshotWire` appends (5 intent + 5 preparing +
        // transientErrorPaths).
        // Source for the field set:
        // `fixture_snapshot()` above + `hcfs-client/src/engine/progress/snapshot.rs`
        // (`#[serde(rename_all = "camelCase")]`, no per-field rename/skip).
        let mut expected = [
            "actualTotal",
            "bytesExpected",
            "combinedBytesExpected",
            "combinedProgressBytes",
            "completedAt",
            "completedFiles",
            "deletedCount",
            "effectiveCompleted",
            "effectiveInProgress",
            "expectedDownloads",
            "expectedLocalDeletes",
            "expectedRemoteDeletes",
            "expectedUploads",
            "failedFiles",
            "files",
            "isActive",
            "lastError",
            "overallPercent",
            "progressBytes",
            "retryInSecs",
            "startedAt",
            "statusVariant",
            "syncDirection",
            "syncedCount",
            "totalFiles",
            "widgetState",
            "widgetVisible",
            "intentActive",
            "intentCompletedBytes",
            "intentCompletedFiles",
            "intentTotalBytes",
            "intentTotalFiles",
            "preparingPendingFiles",
            "preparingPendingBytes",
            "preparingScannedFiles",
            "preparingFetchedEntries",
            "preparingFetchTotalEntries",
            "transientErrorPaths",
        ];
        expected.sort_unstable();

        assert_eq!(
            actual, expected,
            "sync_progress_snapshot wire key set drifted — update \
             app/lib/types/syncSnapshot.ts and this list together, or revert the \
             hcfs-client change that moved it"
        );
    }

    /// Regression for the production crash:
    /// `thread 'main' panicked at tauri_bridge.rs: there is no reactor
    /// running, must be called from the context of a Tokio 1.x runtime`
    /// → `failed to initiate panic … aborting`.
    ///
    /// hcfs-client's `SyncRunner::emit_snapshot` invokes the synchronous
    /// `SyncEventHandler::on_event` on whatever thread calls it, including
    /// the main GUI thread (no ambient Tokio runtime). The fire-and-forget
    /// snapshot spawn MUST therefore schedule onto Tauri's owned runtime,
    /// not require `Handle::current()` on the caller.
    ///
    /// We drive `spawn_snapshot_emit` from a plain `std::thread` —
    /// guaranteed NOT inside a Tokio runtime — and assert the CALLING
    /// thread survives. Bare `tokio::spawn` panics synchronously on that
    /// thread (`join()` → `Err`); `tauri::async_runtime::spawn` returns
    /// normally (`join()` → `Ok`). The spawned future's own fate (it will
    /// hit unmanaged `AppState` in this mock and panic on Tauri's runtime
    /// worker) is irrelevant — that panic is captured by the dropped
    /// `JoinHandle` and never reaches this assertion, which is exactly the
    /// production/​test distinction: the crash is the SPAWN CALL, not the
    /// task body.
    #[test]
    fn spawn_snapshot_emit_does_not_panic_off_runtime() {
        let app = tauri::test::mock_app().handle().clone();
        let snapshot = fixture_snapshot();
        let outcome = std::thread::spawn(move || {
            spawn_snapshot_emit(app, snapshot, 1);
        })
        .join();
        assert!(
            outcome.is_ok(),
            "spawn_snapshot_emit panicked when called from a non-Tokio \
             thread — this is the production abort. The fire-and-forget \
             spawn must use tauri::async_runtime::spawn (Tauri-owned \
             runtime), not bare tokio::spawn (requires Handle::current())."
        );
    }

    // ── SyncError routing (cancel / revoked / real) ────────────────────

    /// The revoked marker routes to its terminal path; the cancel marker
    /// stays silenced; anything else is a real error. These are the three
    /// arms `handle_sync_error` dispatches on, extracted pure precisely so
    /// this decision is testable without a Wry `AppHandle`.
    #[test]
    fn classify_sync_error_routes_each_marker() {
        assert_eq!(classify_sync_error(events::CANCELLED_MARKER), SyncErrorDisposition::SilencedCancel);
        assert_eq!(
            classify_sync_error(events::SHARED_DRIVE_REVOKED_MARKER),
            SyncErrorDisposition::SharedDriveRevoked
        );
        assert_eq!(classify_sync_error("Rate limited, retry after 30s"), SyncErrorDisposition::RealError);
    }

    /// Marker matching is exact equality, never substring: a wrapped or
    /// suffixed variant must fall through to the generic error path (be
    /// surfaced), not be mis-torn-down as a revocation or silenced as a
    /// cancel. This is what makes an upstream reword fail LOUDLY (via the
    /// pinned-marker tests in `sync::events`) instead of changing behavior.
    #[test]
    fn classify_sync_error_never_matches_by_substring() {
        let wrapped_revoked = format!("Sync failed: {}", events::SHARED_DRIVE_REVOKED_MARKER);
        let suffixed_cancel = format!("{} (stall watchdog)", events::CANCELLED_MARKER);
        assert_eq!(classify_sync_error(&wrapped_revoked), SyncErrorDisposition::RealError);
        assert_eq!(classify_sync_error(&suffixed_cancel), SyncErrorDisposition::RealError);
    }

    /// `REVOKED_NOTIFY_THRESHOLD = 1` turns the shared `ErrorNotifyState`
    /// into a once-per-label edge latch: the first marker fires the
    /// teardown + notification, every backoff re-emit is suppressed, and a
    /// `clear` (SyncStopped — the teardown's own tail) re-arms it for a
    /// genuinely fresh episode (re-invite → revoke again).
    #[test]
    fn revoked_latch_fires_once_per_episode() {
        let latch = crate::sync::error_notify::ErrorNotifyState::new();
        assert!(latch.record_failure("team-drive", REVOKED_NOTIFY_THRESHOLD));
        assert!(!latch.record_failure("team-drive", REVOKED_NOTIFY_THRESHOLD));
        assert!(!latch.record_failure("team-drive", REVOKED_NOTIFY_THRESHOLD));
        // A different label is an independent edge.
        assert!(latch.record_failure("other-drive", REVOKED_NOTIFY_THRESHOLD));
        // Teardown tail (SyncStopped) re-arms the label.
        assert!(latch.clear("team-drive"));
        assert!(latch.record_failure("team-drive", REVOKED_NOTIFY_THRESHOLD));
    }
}
