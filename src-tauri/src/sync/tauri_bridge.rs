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

use super::events;
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
fn failure_persist_ctx(
    app_state: &crate::app_state::AppState,
) -> Option<(sqlx::SqlitePool, String)> {
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
                let _ = super::failure_repo::clear_failures_for_label(&pool, &owner, &label).await;
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
                let _ = super::failure_repo::clear_failure(&pool, &owner, &label, p).await;
            }
        });
    }

    // Increment counters for failed files.
    let mut any_newly_at_threshold = false;
    for (path, error) in &failed_files {
        failure_state.record_failure(label, path, error.clone());
        if failure_state.just_reached_threshold(label, path) {
            any_newly_at_threshold = true;
        }
    }

    // Emit the event if any file just reached the threshold.
    if any_newly_at_threshold {
        let at_threshold = failure_state.files_at_threshold();
        if !at_threshold.is_empty() {
            let _ = app.emit(
                super::events::FILES_FAILED_REPEATEDLY,
                super::events::FilesFailedRepeatedlyPayload { files: at_threshold },
            );
        }
    }
}

impl SyncEventHandler for TauriSyncBridge {
    #[expect(
        clippy::too_many_lines,
        reason = "One match arm per SyncEvent variant, each with a distinct payload shape. Splitting per-variant requires either trait objects or N helper functions with different signatures; the giant match keeps the mapping between Rust event and Tauri event name auditable in one place."
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
                mut upload_files,
                mut download_files,
                mut local_delete_files,
                mut remote_delete_files,
            } => {
                // Increment the sync session epoch so the
                // UploadProcessingState clear gate knows a new cycle
                // has started. See `crate::sync::upload_processing`
                // for the full rationale.
                //
                // Then decide whether this is a file-watcher-triggered
                // cycle that needs the "preparing" widget override —
                // skip when the upload-processing banner is already
                // raised (IPC-initiated uploads cover the gap with
                // the banner instead, and showing both would be
                // double-signalling).
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
                    app_state.credits_exhausted.clear(&label);

                    // The "preparing" override is deliberately NOT marked here
                    // anymore. `SyncStarted` fires before the plan is known, so
                    // marking preparing at this point painted the red
                    // "Preparing sync…" widget/tray state for the entire
                    // scan + remote-fetch (indexing) window of EVERY cycle —
                    // including periodic no-op cycles that turn out to have
                    // zero work. Users saw the tray icon flash red on a loop
                    // even though nothing was ever transferred. The override is
                    // now marked in the `PlanReady` arm, gated on a non-empty
                    // plan, so it only appears once there is real work to do.
                    // See the `PlanReady` arm below and `sync::preparing`.
                }
                cap_file_list(&mut upload_files);
                cap_file_list(&mut download_files);
                cap_file_list(&mut local_delete_files);
                cap_file_list(&mut remote_delete_files);
                let _ = app.emit(
                    events::SYNC_STARTED,
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
                );
            }
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
                // Cycle-level failure counter is observable here only for
                // logging — the per-file detail already flowed through
                // `SyncEvent::FileFailed` (one event per failing file) and
                // the snapshot's `failed_files` aggregate. Surfacing it
                // again as a Tauri event would duplicate signals the FE
                // already consumes; a warn-level log preserves the
                // operability signal for backend operators.
                if files_failed > 0 {
                    tracing::warn!(
                        label = %label,
                        files_failed = files_failed,
                        "sync cycle completed with per-file failures"
                    );
                }
                use tauri::Manager;

                // Belt-and-suspenders snapshot emit. As of hcfs >= a26f4296,
                // `finalize_session_for_label` already emits a snapshot at
                // its exit, so the success and conflicts-skipped code paths
                // are covered upstream. This emit additionally covers the
                // `ConflictsPending` branch in `dispatch_sync_result` which
                // fires `SyncCompleted` without calling
                // `finalize_session_for_label` — without it the UI would
                // miss the conflict-pending transition. Idempotent if the
                // upstream emit already fired this cycle.
                let app_state = app.state::<crate::app_state::AppState>();
                // Clear the preparing override for this label BEFORE
                // the snapshot emit so a cycle that completes with an
                // empty plan (no merge_into_session) doesn't leak a
                // stuck "Preparing sync…" widget after the cycle ends.
                app_state.preparing.clear(&label);
                app_state.sync.emit_snapshot(true);

                // Defensive clear: if the cycle finished without ever
                // emitting a non-zero upload tick (empty plan,
                // already-synced batch, downloads/deletes only), the
                // first-chunk path in `handle_transfer_progress` never
                // ran and the banner would otherwise stay raised for
                // this label. `clear_if_session_advanced` is idempotent
                // and gated on the per-cycle epoch, so the common case
                // (real upload already cleared it) is a no-op and an
                // overlapping in-flight cycle's completion cannot
                // prematurely clear a NEW upload's banner. Scoped to
                // THIS label (Task 4.1) — completion on drive A must
                // not touch drive B's banner state.
                {
                    let epoch = app_state.sync_session_epoch.load(std::sync::atomic::Ordering::SeqCst);
                    app_state.upload_processing.clear_if_session_advanced(&app, &label, epoch);
                }

                // Update per-file failure counters from the finalized session.
                update_failure_counts(&app, &label);

                // Snapshot the cycle's completed files from the session
                // state BEFORE the next cycle starts. `MAX_NOTIFICATION_FILES`
                // caps the payload so a 10k-file migration doesn't blow up
                // the webview. The second cap — the reported completion
                // counts — prevents a multi-cycle residue of stale
                // Completed files in the session map from over-reporting.
                let reported_count = files_uploaded + files_downloaded + files_deleted_locally + files_deleted_remotely;
                let max_files = reported_count.min(crate::sync::progress::MAX_NOTIFICATION_FILES);
                let files = crate::sync::progress::collect_cycle_files_for_label(&app_state.sync, &label, max_files);

                let _ = app.emit(
                    events::SYNC_COMPLETED,
                    events::SyncCompletedPayload {
                        label,
                        files_uploaded,
                        files_downloaded,
                        files_deleted_locally,
                        files_deleted_remotely,
                        conflicts_resolved,
                        conflicts_skipped,
                        files,
                    },
                );
            }
            SyncEvent::SyncError {
                label,
                error,
                retry_in_secs,
                consecutive_failures,
            } => {
                // Cancels (pause, remove, logout teardown, stall watchdog
                // self-cancel) are never user-actionable and must not produce
                // persisted "Sync Failed" notifications. The upstream library
                // routes every cancellation through `SyncError::Cancelled`,
                // which stringifies to `events::CANCELLED_MARKER` — silence
                // at the bridge so the `hcfs_sync_error` channel only
                // carries real failures (network, auth, rate limit, etc.).
                if error == events::CANCELLED_MARKER {
                    // Cancels still need to clear the preparing widget
                    // for this label — otherwise a paused/removed drive
                    // would leak a stuck "Preparing sync…" badge until
                    // the next sync cycle (which may never come for a
                    // paused drive). Banner clear is intentionally
                    // skipped for cancels (handled by `stop_sync`).
                    use tauri::Manager;
                    let app_state = app.state::<crate::app_state::AppState>();
                    if app_state.preparing.clear(&label) {
                        app_state.sync.emit_snapshot(true);
                    }
                    tracing::debug!(label = %label, "Silenced sync cancel (not emitted as error)");
                    return;
                }
                // Defensive clear on real (non-cancel) errors: if the
                // session aborted mid-encryption the first-chunk path
                // never ran and the banner would stay raised. Cancels
                // are intentionally skipped above — those go through
                // `stop_sync`'s reset path. Epoch-gated so an error
                // emitted by an in-flight cycle that started BEFORE
                // a fresh `begin` cannot clear that begin's banner.
                //
                // Preparing override also cleared here: an error
                // before plan_ready leaves nothing in the session, so
                // the override would stay raised otherwise.
                {
                    use tauri::Manager;
                    let app_state = app.state::<crate::app_state::AppState>();
                    let epoch = app_state.sync_session_epoch.load(std::sync::atomic::Ordering::SeqCst);
                    // Scoped to THIS label (Task 4.1) — an error on
                    // drive A must not silently clear drive B's
                    // pending upload banner.
                    app_state.upload_processing.clear_if_session_advanced(&app, &label, epoch);
                    app_state.preparing.clear(&label);
                    // The cycle ended in a real error; the next
                    // cycle should reset the 402 counter so its
                    // banner shows only the new cycle's failures.
                    // Cancels do NOT clear here — they early-return
                    // above. A pause/resume/remove flow goes through
                    // `SyncStopped`, which has its own clear.
                    app_state.credits_exhausted.clear(&label);
                }
                let _ = app.emit(
                    events::SYNC_ERROR,
                    events::SyncErrorPayload {
                        label,
                        error,
                        retry_in_secs,
                        consecutive_failures,
                    },
                );
            }
            SyncEvent::SyncStopped { label } => {
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
                let _ = app.emit(events::SYNC_STOPPED, events::LabelPayload { label });
            }
            SyncEvent::SyncReset { account_id, message } => {
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
                let _ = app.emit(events::SYNC_RESET, events::SyncResetPayload { account_id, message });
            }
            SyncEvent::PlanReady {
                label,
                uploads,
                downloads,
                local_deletes,
                remote_deletes,
                mut upload_files,
                mut download_files,
                mut local_delete_files,
                mut remote_delete_files,
            } => {
                // Mark the "preparing" override now that the plan is known and
                // confirms real work. Moved here from `SyncStarted` (which
                // fires before the plan exists) so periodic no-op cycles —
                // whose plan is empty — never flash the red "Preparing sync…"
                // state during their indexing window. A genuine Finder-drop
                // still surfaces the indicator: its plan is non-empty, and the
                // override bridges the small gap from here until the first
                // files-populated snapshot (after `merge_into_session`), at
                // which point the `ProgressSnapshot` arm clears it.
                {
                    use tauri::Manager;
                    let app_state = app.state::<crate::app_state::AppState>();
                    let has_work = uploads + downloads + local_deletes + remote_deletes > 0;
                    // An IPC-initiated upload already shows its own top-of-page
                    // banner for this drive, so suppress the override to avoid
                    // double-signalling. Per-label (not global) so a banner on
                    // drive A can't suppress drive B's preparing widget.
                    let banner_active_for_label = app_state.upload_processing.is_active_for(&label);
                    if has_work && !banner_active_for_label && app_state.preparing.mark_preparing(&label) {
                        // Newly inserted — push one snapshot so the widget
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
                }
                cap_file_list(&mut upload_files);
                cap_file_list(&mut download_files);
                cap_file_list(&mut local_delete_files);
                cap_file_list(&mut remote_delete_files);
                let _ = app.emit(
                    events::SYNC_PLAN_READY,
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
                );
            }
            SyncEvent::ConflictsPending { label, staged } => {
                let _ = app.emit(events::CONFLICTS_PENDING, events::ConflictsPendingPayload { label, staged });
            }
            // Per-chunk transfer progress is served via the throttled
            // `sync_progress_snapshot` event emitted from
            // `crate::sync::progress::update_file_progress`. Forwarding these
            // variants to Tauri would flood the webview. See lifecycle.rs
            // `handle_transfer_progress` for the live path.
            SyncEvent::UploadProgress { .. } | SyncEvent::DownloadProgress { .. } => {}
            SyncEvent::ScanProgress { label, scanned, path } => {
                let _ = app.emit(events::SCAN_PROGRESS, events::ScanProgressPayload { label, scanned, path });
            }
            SyncEvent::FetchProgress { label, fetched, total } => {
                let _ = app.emit(events::FETCH_PROGRESS, events::FetchProgressPayload { label, fetched, total });
            }
            SyncEvent::FileTransferComplete { label } => {
                let _ = app.emit(events::FILE_TRANSFER_COMPLETE, events::LabelPayload { label });
            }
            SyncEvent::FileFailed {
                label,
                path,
                file_id,
                kind,
                http_status,
            } => {
                // Per-file failure handling has two responsibilities:
                //   (1) Surface the typed failure to the FE via a dedicated
                //       Tauri event so the FE can drive category-specific UX
                //       (e.g. "out of credits" banner for InsufficientBalance).
                //       The translation to `FileFailureKindPayload` is needed
                //       because the upstream `FileFailureKind` is NOT
                //       `Serialize`-able (verified at
                //       `hcfs-client/src/engine/events.rs:33`).
                //   (2) Emit a Tauri event AND do nothing else here. The
                //       in-memory progress mutation (file row → Error) was
                //       already performed by `build_file_failed_callback`
                //       (lifecycle.rs) which fired synchronously from the
                //       same hcfs-client error site BEFORE this event arrived
                //       at the bridge. Splitting the responsibilities — Tauri
                //       emit here, progress mutation in the lifecycle callback
                //       — matches the symmetric `on_file_synced` design and
                //       keeps the bridge a pure forwarder.
                //
                // Deliberately NOT performed:
                //   - `hcfs_sync_error` emit: per-file failure ≠ cycle
                //     failure; the cycle-level channel is reserved for
                //     auth/cancel/transport-level errors. This is also why
                //     no generic "Sync Failed" notification row is created
                //     for an InsufficientBalance failure: the FE notification
                //     handler (`useFilesNotification.ts`) only creates
                //     "Sync Failed" rows on `hcfs_sync_error`, which per-file
                //     failures never trigger. Suppression is architectural,
                //     not gated on a flag.
                //   - Activity-item enqueue: Phase 1 Task 1.1 established
                //     that activity rows only land on server-confirmed
                //     success. Failures are visible via the snapshot's
                //     Error status and the FILES_FAILED_REPEATEDLY event.

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
                        let file_name =
                            path.rsplit('/').next().unwrap_or(path.as_str()).to_string();
                        let kind_for_db = kind_payload.clone();
                        let now_ms = chrono::Utc::now().timestamp_millis();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = super::failure_repo::upsert_failure(
                                &pool, &owner, &label, &path, &file_name, &kind_for_db, now_ms,
                            )
                            .await
                            {
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
            SyncEvent::HealthChanged { health } => {
                let _ = app.emit(events::CONNECTIVITY_CHANGED, &health);
            }
            SyncEvent::FolderRecovered { label } => {
                let _ = app.emit(events::FOLDER_RECOVERED, events::LabelPayload { label });
            }
            SyncEvent::ReviewModeTimeout { label } => {
                let _ = app.emit(events::REVIEW_MODE_TIMEOUT, events::LabelPayload { label });
            }
            // hcfs 41954d7 made ActivityUpdated carry the originating drive
            // label (upstream F35). Forward it so the FE clears only that
            // drive's stale-metadata banner instead of every drive's.
            SyncEvent::ActivityUpdated { label } => {
                let _ = app.emit(events::ACTIVITY_UPDATED, events::LabelPayload { label });
            }
            SyncEvent::AuthRequired { error } => {
                let _ = app.emit(events::AUTH_RELOGIN_REQUIRED, events::AuthRequiredPayload { error });
            }
            SyncEvent::ProgressSnapshot { mut snapshot } => {
                use tauri::Manager;
                let app_state = app.state::<crate::app_state::AppState>();

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
                spawn_snapshot_emit(app.clone(), snapshot);
            }
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
/// # Ordering / dedup contract (unchanged by the runtime-handle swap)
///
/// Two close-spaced snapshots can complete their DB read in either order.
/// `try_claim_snapshot_fingerprint` uses `swap` (not CAS): differing
/// fingerprints both emit (safe — the FE renders the most recent message;
/// a reordered fingerprint-identical pair is a harmless duplicate IPC).
/// The spawn collapses each snapshot's own duplicate but not a
/// cross-snapshot race — acceptable because the FE re-renders either way.
///
/// Ownership: `app` is `Clone` (cheap `Arc`); `snapshot` is moved into the
/// future and the `&snapshot` borrow inside is owned-by-future, so the
/// future is `'static + Send`, satisfying `tauri::async_runtime::spawn`'s
/// bound (identical to `tokio::spawn`'s).
fn spawn_snapshot_emit<R: tauri::Runtime>(app: tauri::AppHandle<R>, snapshot: SyncSnapshot) {
    tauri::async_runtime::spawn(async move {
        let overlay = build_intent_overlay(&app).await;
        let fp = snapshot_fingerprint(&snapshot, overlay);
        if try_claim_snapshot_fingerprint(&LAST_EMITTED_FINGERPRINT, fp) {
            let wire = SyncSnapshotWire {
                inner: &snapshot,
                intent_total_files: overlay.total_files,
                intent_total_bytes: overlay.total_bytes,
                intent_completed_files: overlay.completed_files,
                intent_completed_bytes: overlay.completed_bytes,
                intent_active: overlay.active,
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
/// intent-overlay tail.
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
/// `swap` (not `compare_exchange`). The emit path now runs from a
/// `tokio::spawn` (so multiple emits can race), but `swap` returns the
/// previous value to each racer — two racers with different fingerprints
/// both see `prev != fp` and both emit. Two racers with identical
/// fingerprints might both emit (one duplicate IPC, harmless) or might
/// dedupe to one (the winning racer's `swap` matches the loser's later
/// `prev`); both outcomes are acceptable.
fn snapshot_fingerprint(s: &SyncSnapshot, overlay: SyncIntentOverlay) -> u64 {
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
        // payload-free, so `mem::discriminant` is sufficient and avoids
        // the per-file `format!("{:?}", …)` allocation pair the original
        // implementation paid (10k files × 2 strings × every emit).
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

#[cfg(test)]
mod tests {
    use super::*;

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

    /// Build a fixture `SyncSnapshot` with no files. Used as the baseline
    /// for differential fingerprint tests below.
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
    /// changes. Catches the "we forgot to hash field X" class of bug
    /// the audit's #4 review was specifically about.
    #[test]
    fn fingerprint_changes_when_progress_bytes_changes() {
        let mut a = fixture_snapshot();
        let mut b = fixture_snapshot();
        b.progress_bytes = 1500;
        let empty = SyncIntentOverlay::default();
        assert_ne!(snapshot_fingerprint(&a, empty), snapshot_fingerprint(&b, empty));
        // And while we're here, verify identical snapshots produce
        // identical fingerprints (the gate's whole reason for existing).
        a.progress_bytes = 1500;
        assert_eq!(snapshot_fingerprint(&a, empty), snapshot_fingerprint(&b, empty));
    }

    /// Regression for the review-flagged `started_at` gap: a session
    /// that ends and immediately restarts with the same expected counts
    /// must produce a different fingerprint.
    #[test]
    fn fingerprint_changes_when_started_at_changes() {
        let mut a = fixture_snapshot();
        let mut b = fixture_snapshot();
        b.started_at = Some(1_700_000_001_000);
        let empty = SyncIntentOverlay::default();
        assert_ne!(snapshot_fingerprint(&a, empty), snapshot_fingerprint(&b, empty));
        a.started_at = b.started_at;
        assert_eq!(snapshot_fingerprint(&a, empty), snapshot_fingerprint(&b, empty));
    }

    /// Regression for Task 7: an overlay-only change MUST flip the
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
            snapshot_fingerprint(&a, empty),
            snapshot_fingerprint(&a, with_totals),
        );
        // Sanity: identical overlays produce identical fingerprints.
        assert_eq!(
            snapshot_fingerprint(&a, with_totals),
            snapshot_fingerprint(&a, with_totals),
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
        };
        let json = serde_json::to_value(&wire).expect("serialize wire");

        // Overlay fields (camelCase).
        assert_eq!(json["intentTotalFiles"], 10);
        assert_eq!(json["intentTotalBytes"], 1_000);
        assert_eq!(json["intentCompletedFiles"], 5);
        assert_eq!(json["intentCompletedBytes"], 500);
        assert_eq!(json["intentActive"], true);

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
        };
        let json = serde_json::to_value(&wire).expect("serialize wire");
        assert!(json["intentTotalFiles"].is_null());
        assert!(json["intentTotalBytes"].is_null());
        assert!(json["intentCompletedFiles"].is_null());
        assert!(json["intentCompletedBytes"].is_null());
        assert!(json["intentActive"].is_null());
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
            spawn_snapshot_emit(app, snapshot);
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
}
