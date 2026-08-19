//! hcfs-client progress callbacks for the sync lifecycle.
//!
//! Holds the per-drive `SyncProgress` callback set and its helpers, wired up by
//! `setup_progress_handlers`.

use hcfs_client::engine::manager::DriveManager;
use hcfs_client::engine::runner::SyncRunner;
use hcfs_client::engine::types::{SyncActivityAction, SyncActivityItem, SyncedFileInfo};
use hcfs_client::sync::SyncProgress;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tracing::{debug, info, warn};

/// Smallest wall-clock gap between two scan-progress log lines.
const SCAN_LOG_INTERVAL: Duration = Duration::from_secs(2);

/// Rate-limits a repeating log line to at most one emission per `interval`.
///
/// The scan callback fires once per file walked, and the `info!` behind it was
/// unthrottled. On a drive holding a build tree (~80k files) that wrote ~340
/// lines/second, which is enough to defeat the support bundle: `utils::logs`
/// ships a 5 MB tail per file, so a 22k-line bundle covered 65 SECONDS of the
/// day it was collected. A real bundle from 2026-08-14 carried zero WARN and
/// zero ERROR lines while the full on-disk log for the same day held both —
/// the incident had been truncated away by scan noise before support saw it.
///
/// Thinning rather than demoting to `debug!` is deliberate: a slow scan is the
/// phase users report as "stuck", so the line has to stay in a default-level
/// bundle. At this interval a 15-minute scan leaves ~450 lines instead of
/// ~80,000, which still shows the rate and the current path.
///
/// The lock is real: these callbacks run on the rayon scan workers, so several
/// threads reach `decide` concurrently.
struct LogThrottle {
    interval: Duration,
    state: Mutex<ThrottleState>,
}

#[derive(Default)]
struct ThrottleState {
    last_logged: Option<Instant>,
    /// Highest count seen in the scan currently in progress. Carried so the
    /// FINAL count of a scan can be emitted, which periodic sampling alone
    /// never captures.
    highest_seen: u64,
}

/// What the caller should log for one scan tick.
#[derive(Debug, PartialEq, Eq)]
enum ScanLog {
    /// Nothing — this tick fell inside the current interval.
    Nothing,
    /// This tick's own count, as periodic progress.
    Progress,
    /// A new scan started; emit the PREVIOUS scan's final count first, then
    /// treat this tick as that scan's opening progress line.
    FinishedPrevious(u64),
}

impl LogThrottle {
    fn new(interval: Duration) -> Self {
        Self {
            interval,
            state: Mutex::new(ThrottleState::default()),
        }
    }

    /// Decide what to log for a tick reporting `scanned` files at `now`.
    ///
    /// Leading-edge sampling loses the one number the line exists for. A scan
    /// of a small drive completes well inside one interval — 46 files in 0.9ms
    /// was measured — so the only tick that ever wins is the first, and every
    /// cycle logs `1 files scanned` forever while the real total is never
    /// recorded. Counts rise monotonically within a scan and restart at the
    /// next one, so a DROP is the scan boundary, and it is the only signal
    /// this callback gets: there is no scan-complete callback to hook.
    /// Reporting the previous high-water mark there gives support the final
    /// count without adding a line per tick.
    ///
    /// That boundary check doubles as the cross-cycle reset. Without it the
    /// interval spans cycle boundaries, so back-to-back cycles — a
    /// file-watcher burst, or a retry loop, exactly the "why is it spinning?"
    /// pattern support reads the log for — could emit nothing at all.
    ///
    /// A poisoned lock reads as "log it": a duplicated line costs far less
    /// than silently dropping the only signal a stuck scan emits.
    fn decide(&self, now: Instant, scanned: u64) -> ScanLog {
        let mut state = match self.state.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };

        if scanned < state.highest_seen {
            let finished = state.highest_seen;
            state.highest_seen = scanned;
            state.last_logged = Some(now);
            return ScanLog::FinishedPrevious(finished);
        }
        state.highest_seen = scanned;

        match state.last_logged {
            Some(previous) if now.duration_since(previous) < self.interval => ScanLog::Nothing,
            _ => {
                state.last_logged = Some(now);
                ScanLog::Progress
            }
        }
    }
}

/// Direction of a file transfer for progress callbacks.
pub(crate) enum TransferDirection {
    Upload,
    Download,
}

/// Which sync-cycle phase an engine progress tick belongs to, for the
/// idle-based UI watchdogs. An enum (not a bool) so the intent reads at
/// the call site.
enum ActivityPhase {
    /// Scan / remote-state-fetch ticks: carry the live indexing detail
    /// ("N files scanned" / "f of t entries") and may also PROMOTE an
    /// armed preparing label once the cycle has been indexing past the
    /// surfacing grace (see `sync::preparing`, "Armed vs Marked").
    PrePlan(crate::sync::preparing::PreparingActivity),
    /// Encrypt / decrypt / per-chunk transfer ticks: pure liveness —
    /// refresh idle windows only, never surface anything new.
    PostPlan,
}

/// Feed one engine progress tick into the idle-based UI watchdogs.
///
/// Every tick refreshes the upload-processing banner's idle window
/// (`touch` — a no-op when the label has no banner) and the preparing
/// override's idle window. This is what lets both states survive the
/// multi-minute scan/hash + encryption phase of a large add instead of
/// being force-cleared at 60s of wall clock, while a stuck engine —
/// which emits no ticks — still idles out.
///
/// For [`ActivityPhase::PrePlan`] ticks, an armed preparing label may be
/// promoted to the visible override; promotion is suppressed while the
/// label's IPC banner is active (double-signalling rule, mirroring the
/// `PlanReady` mark gate in `tauri_bridge::handle_plan_ready`). A
/// promotion pushes one immediate snapshot so the widget appears — safe
/// from any thread, including the rayon scan workers these callbacks run
/// on: `emit_snapshot` re-enters the bridge synchronously, which spawns
/// the actual emit onto Tauri's owned runtime.
///
/// `try_state` (not `state`): callbacks are wired after `AppState` is
/// managed, but a tick racing app teardown must degrade to a no-op, not
/// a panic across the hcfs callback boundary.
fn note_engine_activity(app: &AppHandle, sync: &Arc<SyncRunner>, label: &str, phase: ActivityPhase) {
    use tauri::Manager;
    let Some(app_state) = app.try_state::<crate::app_state::AppState>() else {
        return;
    };
    app_state.upload_processing.touch(label);
    match phase {
        ActivityPhase::PrePlan(activity) => {
            use crate::sync::preparing::PrePlanTick;
            let allow_promote = !app_state.upload_processing.is_active_for(label);
            match app_state.preparing.note_pre_plan_activity(label, allow_promote, activity) {
                // Newly surfaced: bypass the throttle so the widget
                // appears (with the counter populated) within one tick.
                PrePlanTick::Promoted => sync.emit_snapshot(true),
                // Counter moved on an already-visible override: ride
                // the engine's 250ms snapshot throttle so per-file scan
                // ticks don't flood the webview.
                PrePlanTick::Refreshed => sync.emit_snapshot(false),
                PrePlanTick::Invisible => {}
            }
        }
        ActivityPhase::PostPlan => app_state.preparing.note_activity(label),
    }
}

/// Shared state for a transfer progress callback.
struct TransferContext {
    sync: Arc<SyncRunner>,
    app: AppHandle,
    label: Arc<str>,
    direction: TransferDirection,
}

/// Handle per-chunk transfer progress: log first event, track in UI via the
/// throttled snapshot path, and record completion activity. Shared between
/// upload and download callbacks to avoid code duplication.
///
/// Per-chunk byte progress is surfaced to the frontend exclusively through
/// the throttled `sync_progress_snapshot` event emitted by
/// [`crate::sync::progress::update_file_progress`]. There are no separate
/// per-chunk `hcfs_upload_progress` / `hcfs_download_progress` Tauri events:
/// no frontend code listens to them, so firing on every chunk would just flood
/// the webview for no consumer.
fn handle_transfer_progress(ctx: &TransferContext, bytes: u64, total: u64, path: Option<&str>) {
    ctx.sync.touch_progress_time();
    note_engine_activity(&ctx.app, &ctx.sync, &ctx.label, ActivityPhase::PostPlan);
    let (dir_name, file_action) = match ctx.direction {
        TransferDirection::Upload => ("Upload", crate::sync::progress::FileAction::Upload),
        TransferDirection::Download => ("Download", crate::sync::progress::FileAction::Download),
    };

    if let Some(path_str) = path {
        let file_name = Path::new(path_str).file_name().and_then(|n| n.to_str()).unwrap_or(path_str);
        // Log the first chunk of each transfer. Keying on bytes == 0 avoids a
        // started-set Mutex that would be contended on every chunk.
        // Trade-off: resumed transfers (first chunk has bytes > 0) won't
        // get a "started" log — acceptable since the completion log still
        // fires and resume is rare.
        if bytes == 0 {
            info!("{} started [{}]: {} ({} bytes)", dir_name, ctx.label, file_name, total);
        }
        let _ = crate::sync::progress::update_file_progress(&ctx.sync, path_str, bytes, total, file_action, Some(&*ctx.label));

        // First non-zero upload chunk for any file ends the
        // "processing" window — the bottom-right widget now has real
        // per-file progress and the top banner can vanish. Gated on
        // `sync_session_epoch` so chunks from an in-flight cycle
        // that started BEFORE the activating `begin` do NOT clear the
        // banner. Idempotent (single mutex tick + early return when
        // state is already cleared) so calling on every chunk is
        // fine.
        if matches!(ctx.direction, TransferDirection::Upload) && bytes > 0 {
            use tauri::Manager;
            let app_state = ctx.app.state::<crate::app_state::AppState>();
            let epoch = app_state.sync_session_epoch.load(std::sync::atomic::Ordering::SeqCst);
            app_state.upload_processing.clear_if_session_advanced(&ctx.app, &ctx.label, epoch);
        }

        if crate::sync::logic::is_file_completion_tick(bytes, total) {
            // Byte-progress completion is "the request body finished
            // leaving our socket" — the HTTP response status (200 / 402
            // / 5xx) has not been parsed yet. We log + emit the
            // transfer-complete UI event here because both are
            // best-effort progress signals, but we deliberately do NOT
            // enqueue a `SyncActivityItem` from this point: that would
            // record a server-rejected upload as a successful one.
            // The enqueue lives in `build_file_synced_callback`, which
            // hcfs-client fires only on per-file `Ok` (server-confirmed
            // 2xx), so a 402 / 5xx-rejected upload is never logged as success.
            info!("{} complete [{}]: {} ({} bytes)", dir_name, ctx.label, file_name, total);
            let _ = ctx.app.emit(
                crate::sync::events::FILE_TRANSFER_COMPLETE,
                crate::sync::events::LabelPayload {
                    label: ctx.label.to_string(),
                },
            );
        }
    }
    debug!("{} [{}]: {}/{} bytes, path: {:?}", dir_name, ctx.label, bytes, total, path);
}

/// Fire-and-forget: persist the planner's view of pending uploads to the
/// `sync_intent` table.
///
/// Called from `build_plan_ready_callback` once per sync cycle. The intent
/// manifest is a pure UX overlay used by the sync widget to render
/// "5 GB of 10 GB" across app restarts — it is NOT load-bearing for sync
/// correctness. Failures (no logged-in user, missing pool, SQLite error)
/// are logged and dropped; the next plan-ready call will replay the same
/// uploads.
///
/// Ownership: all captures are owned (`AppHandle` is `Clone` and cheap;
/// `label` and `plan_uploads` are moved in). The spawned future is
/// `'static + Send`, satisfying `tauri::async_runtime::spawn`'s bound.
///
/// Uses `tauri::async_runtime::spawn`, NOT bare `tokio::spawn`: this runs
/// from the hcfs `on_sync_plan_ready` callback, whose calling thread is
/// not contractually guaranteed to be inside a Tokio runtime. Bare
/// `tokio::spawn` panics ("there is no reactor running") off-runtime —
/// the same crash class fixed in `tauri_bridge::spawn_snapshot_emit`.
/// Tauri's runtime handle is global and thread-context-independent.
fn spawn_record_intent_plan<R: tauri::Runtime>(app: AppHandle<R>, label: String, plan_uploads: Vec<(String, u64)>) {
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        let state: tauri::State<'_, crate::app_state::AppState> = app.state();
        let account_id = match state.current_account_id() {
            Ok(id) => id,
            Err(e) => {
                // Not logged in (or auth mutex poisoned). The widget overlay
                // is a UX nicety, not load-bearing — drop rather than emit a
                // noisy error. Next plan-ready after login replays uploads.
                debug!(label = %label, error = %e, "skipping intent record_plan: no active account");
                return;
            }
        };
        let pool = match state.pool() {
            Ok(p) => p.clone(),
            Err(e) => {
                warn!(label = %label, error = %e, "skipping intent record_plan: pool unavailable");
                return;
            }
        };
        let repo = crate::sync::intent::IntentRepo::new(pool);
        if let Err(e) = repo.record_plan(&account_id, &label, &plan_uploads).await {
            warn!(label = %label, error = %e, "intent record_plan failed");
        }
        // Age out long-settled rows for this drive so the durable manifest stays
        // bounded for users who rarely log out. Best-effort: a prune failure must
        // not disrupt the cycle (the overlay is a UX nicety, and logout's
        // clear_account is the other reclaim).
        let cutoff_ms = chrono::Utc::now().timestamp_millis() - crate::sync::intent::SETTLED_RETENTION_MS;
        match repo.prune_settled(&account_id, &label, cutoff_ms).await {
            Ok(n) if n > 0 => debug!(label = %label, pruned = n, "pruned settled intent rows past retention"),
            Ok(_) => {}
            Err(e) => warn!(label = %label, error = %e, "intent prune_settled failed"),
        }
    });
}

/// Fire-and-forget: mark a single file as completed in the desktop-side
/// `sync_intent` manifest.
///
/// Called from inside `build_file_synced_callback` only when hcfs-client's
/// per-file callback reports `action == "uploaded"`. Downloads, deletes,
/// and conflict events do NOT touch the intent manifest — the manifest
/// counts user-initiated uploads, which is the only category the
/// "X of Y uploaded across restarts" widget overlay needs.
///
/// Spawned because `FileSyncedFn` is a sync `Fn(...)` and
/// [`crate::sync::intent::IntentRepo::mark_completed`] is async. The
/// manifest is a pure UX overlay, NOT load-bearing for sync correctness,
/// so on auth / pool / SQL failure we log and drop. Idempotence is
/// enforced at the SQL layer (`AND completed_at_ms IS NULL`), so a
/// duplicate fire — e.g. hcfs-client retrying a callback after a
/// transient widget event drop — preserves the first completion
/// timestamp.
///
/// Ownership: every capture is owned. `AppHandle<R>` is `Clone` and cheap
/// (internally `Arc`); `label` and `rel_path` are moved in. The spawned
/// future is `'static + Send`, satisfying `tauri::async_runtime::spawn`'s
/// bound.
///
/// Uses `tauri::async_runtime::spawn`, NOT bare `tokio::spawn`: this runs
/// from the hcfs `on_file_synced` callback, whose calling thread is not
/// contractually guaranteed to be inside a Tokio runtime. Bare
/// `tokio::spawn` panics ("there is no reactor running") off-runtime —
/// the same crash class fixed in `tauri_bridge::spawn_snapshot_emit`.
fn spawn_mark_intent_completed<R: tauri::Runtime>(app: AppHandle<R>, label: String, rel_path: String) {
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        let state: tauri::State<'_, crate::app_state::AppState> = app.state();
        let account_id = match state.current_account_id() {
            Ok(id) => id,
            Err(e) => {
                // Not logged in (or auth mutex poisoned). Treat like the
                // plan-ready path: drop quietly, the next plan-ready will
                // replay this row as pending until it gets uploaded again.
                debug!(label = %label, path = %rel_path, error = %e, "skipping intent mark_completed: no active account");
                return;
            }
        };
        let pool = match state.pool() {
            Ok(p) => p.clone(),
            Err(e) => {
                warn!(label = %label, path = %rel_path, error = %e, "skipping intent mark_completed: pool unavailable");
                return;
            }
        };
        let repo = crate::sync::intent::IntentRepo::new(pool);
        let now_ms = chrono::Utc::now().timestamp_millis();
        if let Err(e) = repo.mark_completed(&account_id, &label, &rel_path, now_ms).await {
            warn!(label = %label, path = %rel_path, error = %e, "intent mark_completed failed");
        }
    });
}

/// Build the `on_sync_plan_ready` callback that merges the sync plan into the
/// progress session and emits the `SYNC_PLAN_READY` event.
fn build_plan_ready_callback<R: tauri::Runtime>(app: &AppHandle<R>, label: Arc<str>, sync: &Arc<SyncRunner>) -> hcfs_client::sync::SyncPlanReadyFn {
    let app = app.clone();
    let sync = sync.clone();
    Arc::new(move |uploads, downloads, local_deletes, remote_deletes, renames| {
        sync.touch_progress_time();
        // Persist the planner's view to the desktop-side intent manifest.
        // Runs UNCONDITIONALLY — above the `total == 0` early-return —
        // because an empty plan must still flush stale pending rows (see
        // `IntentRepo::record_plan`'s "Empty input semantics" docstring).
        // Logic is delegated to `spawn_record_intent_plan` so this closure
        // stays under the project's 100-line per-function ceiling.
        let plan_uploads: Vec<(String, u64)> = uploads.iter().map(|f| (f.path.clone(), f.size_bytes)).collect();
        spawn_record_intent_plan(app.clone(), label.to_string(), plan_uploads);

        let total = uploads.len() + downloads.len() + local_deletes.len() + remote_deletes.len() + renames.len();
        if total == 0 {
            return;
        }
        info!(
            "Sync plan ready [{}]: {} uploads, {} downloads, {} local_deletes, {} remote_deletes, {} renames",
            label,
            uploads.len(),
            downloads.len(),
            local_deletes.len(),
            remote_deletes.len(),
            renames.len()
        );

        // Build path vecs once and move them into SessionFileList (no .clone()).
        // The Tauri event payload is built separately by re-iterating the plan
        // slices (which are still alive), so we never hold two full copies of
        // the path strings simultaneously.
        let upload_paths: Vec<String> = uploads.iter().map(|f| f.path.clone()).collect();
        let download_paths: Vec<String> = downloads.iter().map(|f| f.path.clone()).collect();
        let local_delete_paths: Vec<String> = local_deletes.iter().map(|f| f.path.clone()).collect();
        let remote_delete_paths: Vec<String> = remote_deletes.iter().map(|f| f.path.clone()).collect();

        // Move path vecs into the file list — no redundant clone.
        let file_list = crate::sync::progress::SessionFileList {
            upload_files: Some(upload_paths),
            download_files: Some(download_paths),
            local_delete_files: Some(local_delete_paths),
            remote_delete_files: Some(remote_delete_paths),
        };
        let _ = crate::sync::progress::merge_into_session(
            &sync,
            uploads.len() as u32,
            downloads.len() as u32,
            local_deletes.len() as u32,
            remote_deletes.len() as u32,
            Some(file_list),
            Some(label.to_string()),
        );

        // Patch file sizes directly from plan items — avoids an intermediate
        // HashMap that would clone every path string.
        let mut progress_state = sync.progress.lock();
        if let Some(session) = progress_state.current_session.as_mut() {
            let mut patched = 0u32;
            for f in uploads
                .iter()
                .chain(downloads.iter())
                .chain(local_deletes.iter())
                .chain(remote_deletes.iter())
            {
                if f.size_bytes > 0
                    && let Some(file) = session.files.get_mut(&f.path)
                    && file.total_bytes == 0
                {
                    file.total_bytes = f.size_bytes;
                    patched += 1;
                }
            }
            if patched > 0 {
                debug!("Patched sizes for {patched} files from sync plan");
            }
        }
        let needs_snapshot = progress_state.current_session.is_some();
        drop(progress_state);
        if needs_snapshot {
            sync.emit_snapshot(true);
        }

        // Build the event payload directly from plan slices. File-path vectors
        // are capped to avoid oversized JSON payloads that freeze the webview
        // when a migration produces thousands of files. The counts are always
        // the true totals; only the path arrays are truncated.
        let cap = crate::sync::progress::MAX_EVENT_FILES;
        let _ = app.emit(
            crate::sync::events::SYNC_PLAN_READY,
            crate::sync::events::SyncPlanReadyPayload {
                label: label.to_string(),
                uploads: uploads.len(),
                downloads: downloads.len(),
                local_deletes: local_deletes.len(),
                remote_deletes: remote_deletes.len(),
                upload_files: uploads.iter().take(cap).map(|f| f.path.clone()).collect(),
                download_files: downloads.iter().take(cap).map(|f| f.path.clone()).collect(),
                local_delete_files: local_deletes.iter().take(cap).map(|f| f.path.clone()).collect(),
                remote_delete_files: remote_deletes.iter().take(cap).map(|f| f.path.clone()).collect(),
            },
        );
    })
}

/// Build an encrypt or decrypt progress callback.
///
/// The two callbacks are structurally identical — only the log prefix
/// and `FileAction` variant differ — so this helper is parameterized
/// over both.
fn build_crypto_callback(
    app: AppHandle,
    sync: Arc<SyncRunner>,
    label: Arc<str>,
    action: crate::sync::progress::FileAction,
    direction_name: &'static str,
) -> hcfs_client::sync::SyncProgressFn {
    Arc::new(move |b, t, p| {
        sync.touch_progress_time();
        note_engine_activity(&app, &sync, &label, ActivityPhase::PostPlan);
        if b == 0 {
            info!("{direction_name} starting [{label}]: {p:?} ({t} bytes)");
        } else if b == t && t > 0 {
            info!("{direction_name} complete [{label}]: {p:?} ({t} bytes)");
        }
        if let Some(path_str) = p {
            let _ = crate::sync::progress::update_file_progress(&sync, path_str, b, t, action.clone(), Some(&*label));
        }
    })
}

/// Build the `on_scan_progress` callback that feeds the preparing-state
/// watchdogs and logs scan progress at a bounded rate.
///
/// The scanned counter reaches the UI through the throttled
/// `sync_progress_snapshot` (`snapshot.preparingScannedFiles`), which
/// `note_engine_activity` drives — not through a per-file Tauri event.
fn build_scan_callback(sync: Arc<SyncRunner>, app: AppHandle, label: Arc<str>) -> hcfs_client::sync::ScanProgressFn {
    let log_throttle = LogThrottle::new(SCAN_LOG_INTERVAL);

    Arc::new(move |n, p| {
        sync.touch_progress_time();
        note_engine_activity(
            &app,
            &sync,
            &label,
            ActivityPhase::PrePlan(crate::sync::preparing::PreparingActivity::Scanning { scanned_files: n }),
        );

        match log_throttle.decide(Instant::now(), n) {
            ScanLog::Nothing => {}
            ScanLog::Progress => info!("Scan [{label}]: {n} files scanned, current: {p:?}"),
            ScanLog::FinishedPrevious(total) => {
                info!("Scan [{label}]: complete, {total} files scanned");
                info!("Scan [{label}]: {n} files scanned, current: {p:?}");
            }
        }
    })
}

/// Build the `on_fetch_state_progress` callback that feeds the
/// preparing-state watchdogs and logs remote-state fetch progress.
///
/// Like the scan counter, the fetched/total pair reaches the UI through the
/// throttled `sync_progress_snapshot` rather than a per-page Tauri event.
///
/// Unthrottled `info!` is fine here: this fires once per fetched PAGE (17
/// times for an 80k-file account), not once per entry.
fn build_fetch_callback(sync: Arc<SyncRunner>, app: AppHandle, label: Arc<str>) -> hcfs_client::sync::FetchProgressFn {
    Arc::new(move |f, t| {
        sync.touch_progress_time();
        note_engine_activity(
            &app,
            &sync,
            &label,
            ActivityPhase::PrePlan(crate::sync::preparing::PreparingActivity::Fetching {
                fetched_entries: f,
                total_entries: t,
            }),
        );
        info!("Fetch state [{label}]: {f}/{t} entries");
    })
}

/// Build the `on_file_synced` callback that logs per-file completion,
/// updates the synced-paths cache, AND transitions the file's progress
/// status to `Completed` so the sync widget reflects the file as done as
/// soon as its individual AEAD verification has succeeded — instead of
/// waiting for the entire sync cycle to finish. See
/// [`crate::sync::progress::mark_file_synced`] for the full reasoning.
pub fn build_file_synced_callback<R: tauri::Runtime>(app: &AppHandle<R>, sync: Arc<SyncRunner>, label: Arc<str>) -> hcfs_client::sync::FileSyncedFn {
    // Clone once at construction time; the closure (`Arc<dyn Fn(...)>`)
    // captures the owned `AppHandle<R>`. Per-fire we `.clone()` again to
    // hand an owned handle to the `'static`-bound spawn future. Both
    // clones are cheap (`AppHandle` is internally `Arc`).
    let app = app.clone();
    Arc::new(move |rel_path, path_hash_hex, arion_cid, action, timestamps| {
        debug!("File synced [{label}]: {rel_path} ({action}) cid={arion_cid}");
        if rel_path.is_empty() {
            return;
        }

        // Transition this file from Decrypting/Downloading/Encrypting to
        // Completed in the progress tracker. The hcfs-client side fires
        // this callback only after the per-file upload or download task
        // returns Ok — for downloads that means chunked download AND
        // AEAD-tag-verifying decryption have both succeeded — so it is
        // safe to mark Completed here without waiting for end-of-cycle
        // `complete_pending_files`. Without this, a small decrypted file
        // gets stuck on "Decrypting" until the largest in-flight file
        // also finishes.
        //
        // `mark_file_synced` also returns the file's `total_bytes` from
        // the in-memory progress tracker — that's the byte count we
        // thread into the activity row below. `FileSyncedFn`'s upstream
        // signature still doesn't carry the size, but the progress
        // tracker holds it from per-chunk telemetry and the transition
        // here reads it BEFORE flipping the row to `Completed`. The
        // fallback (no session / no file entry / already-Completed) is
        // `0`, matching the prior hardcoded value for those edge cases.
        let size_bytes = match crate::sync::progress::mark_file_synced(&sync, rel_path) {
            Ok(n) => n,
            Err(e) => {
                warn!(label = %label, path = %rel_path, error = %e, "Failed to mark file synced in progress tracker");
                0
            }
        };

        // Activity items must reflect SERVER-CONFIRMED success, not just
        // "the request body finished sending". hcfs-client's per-file
        // upload/download tasks invoke this callback only after the
        // task returns `Ok` (2xx response parsed for uploads, full
        // chunked download + AEAD verification for downloads), so this
        // is the earliest point a "Uploaded" / "Downloaded" row is true.
        // Enqueuing from the byte-progress completion-tick instead would fire
        // when the local TCP socket has drained, so a 402 / 5xx-rejected upload
        // would wrongly appear as "Uploaded" in the activity log.
        //
        // Action mapping: hcfs-client passes `action` as one of
        // `"uploaded"` / `"downloaded"` / `"deleted"` / `"conflict"`
        // (mirroring `SyncActivityAction::as_str()`). Unknown values
        // produce `None`, which skips the activity enqueue entirely —
        // recording nothing is the truthful choice when we don't know
        // how to categorize the event. Fabricating an `Uploaded` row
        // for a future hcfs-client variant (e.g. a `"failed"` action)
        // would be exactly the kind of activity-log lie this guards against.
        //
        // `size_bytes` comes from `mark_file_synced`'s return value —
        // the in-memory progress tracker's `file.total_bytes` read
        // before the row transitions to Completed. The Recent-Files
        // view (`get_recent_files` in `sync/fileops/files/recent.rs`) reads
        // `item.size_bytes` directly, so without this thread-through
        // every newly-synced file would render with size 0 / "unknown".
        // The byte-progress callback is not trusted for activity rows (it
        // fires before the server confirms the upload), so the progress
        // tracker is the authoritative source. The 0 fallback covers the
        // documented edge cases of `mark_file_synced` —
        // no session, no file entry, or the file was already Completed
        // — where the size isn't observable from this call.
        //
        // `ActivityDedupKey = (file_name, action, label, size_bytes)`
        // (`hcfs_client::engine::runner::ActivityDedupKey`) regains
        // full entropy now that `size_bytes` is non-zero on the common
        // path.
        let activity_action: Option<SyncActivityAction> = match action {
            "uploaded" => Some(SyncActivityAction::Uploaded),
            "downloaded" => Some(SyncActivityAction::Downloaded),
            "deleted" => Some(SyncActivityAction::Deleted),
            "conflict" => Some(SyncActivityAction::Conflict),
            other => {
                warn!(
                    label = %label,
                    path = %rel_path,
                    action = other,
                    "unknown FileSyncedFn action; skipping activity-item enqueue to preserve activity-log truth"
                );
                None
            }
        };
        // Skip ONLY the activity enqueue on unknown actions —
        // `upsert_synced_path` below still runs because the file did
        // sync successfully (hcfs-client only fires this callback on
        // per-file `Ok`); we just decline to categorize the event for
        // the activity log.
        if let Some(activity_action) = activity_action {
            sync.add_pending_activity(SyncActivityItem {
                file_name: Arc::from(rel_path),
                action: activity_action,
                timestamp: chrono::Utc::now().timestamp(),
                size_bytes,
                label: Arc::clone(&label),
            });
        }

        // Mark the file complete in the desktop-side intent manifest so
        // the sync widget can show "X of Y" totals across app restarts.
        // We mark intent complete ONLY on "uploaded":
        //   - "downloaded": pulling someone else's file, not user upload intent.
        //   - "deleted":    deletion is out of scope for the upload manifest.
        //   - "conflict":   when a conflict resolves via upload, hcfs-client
        //                   already arrives here with action="uploaded" (see
        //                   `Drive::resolve_upload_conflict`), so the
        //                   resolution is counted; the bare "conflict" event
        //                   reports a non-upload outcome (kept-remote /
        //                   manual-deferred) and must not advance totals.
        //
        // Spawned for the same async-Fn reason as `spawn_record_intent_plan`
        // — `FileSyncedFn` is sync; `IntentRepo::mark_completed` is async.
        // The manifest is a pure UX overlay, NOT load-bearing for sync
        // correctness, so failures inside the spawn log and drop.
        if action == "uploaded" {
            spawn_mark_intent_completed(app.clone(), label.to_string(), rel_path.to_string());
        }

        // hcfs's `FileSyncedFn` callback passes `path_hash_hex` as a hex
        // string. `SyncedFileInfo::with_timestamps` wants the raw 32-byte
        // hash, so we decode here. A future hcfs PR could pass `&[u8; 32]`
        // directly to skip this round-trip.
        let decoded = match hex::decode(path_hash_hex) {
            Ok(bytes) => bytes,
            Err(e) => {
                warn!(
                    error = %e,
                    path_hash_hex = path_hash_hex,
                    "failed to decode path_hash_hex, skipping synced-paths upsert"
                );
                return;
            }
        };
        let Ok(path_hash_bytes) = <[u8; 32]>::try_from(decoded) else {
            warn!(
                path_hash_hex = path_hash_hex,
                "path_hash_hex has wrong byte length, skipping synced-paths upsert"
            );
            return;
        };
        // When the server response carried authoritative timestamps we
        // stamp them into the cache immediately so the Files page's
        // "DATE UPLOADED" column renders right away — no waiting for a
        // subsequent `fetch_remote_state` to populate them. When the
        // server was legacy (no timestamps in response), hcfs-client
        // passes `None` and `SyncedFileInfo::new` preserves the
        // pre-existing cache timestamps via the zero-guard in
        // `upsert_synced_path` — never clobber a good value with zeros.
        let info = match timestamps {
            Some(ts) => SyncedFileInfo::with_timestamps(path_hash_bytes, Arc::from(arion_cid), ts),
            None => SyncedFileInfo::new(path_hash_bytes, Arc::from(arion_cid)),
        };
        sync.upsert_synced_path(&label, rel_path.to_string(), info);
    })
}

/// Build the `on_file_failed` callback that flips the file's progress
/// status to terminal `FileStatus::Error` synchronously at the failure
/// site (does NOT emit any Tauri event — the bridge handles that via
/// [`hcfs_client::engine::events::SyncEvent::FileFailed`]).
///
/// Visibility is intentionally module-private (`pub(super)` would also
/// suffice, but neither is needed by integration tests because tests
/// reach the same outcome through `mark_file_failed` directly — the
/// callback is purely glue between hcfs-client's `FileFailedFn` shape and
/// our progress tracker).
///
/// The split-of-responsibilities mirrors `build_file_synced_callback` and
/// the existing bridge: bridge → Tauri event emit; this callback →
/// progress-tracker mutation. hcfs-client guarantees both fire for the
/// same per-file error, so we don't lose either signal.
fn build_file_failed_callback(sync: Arc<SyncRunner>, label: Arc<str>) -> hcfs_client::sync::FileFailedFn {
    Arc::new(move |rel_path, file_id_hex, kind, http_status| {
        // Mirror `on_file_synced` shape: empty rel_path means the planner
        // never recorded a path for this file (shouldn't happen, but the
        // upstream doc on `FileFailedFn` allows it). No-op rather than
        // mark a phantom entry.
        if rel_path.is_empty() {
            return;
        }
        debug!(
            label = %label,
            path = %rel_path,
            file_id = %file_id_hex,
            ?kind,
            http_status = ?http_status,
            "per-file sync failure reported by hcfs-client"
        );

        // User-facing reason for the snapshot row's `error` field. The sidebar
        // sync widget and the tray popover render this string directly, so it
        // must read as product copy — not the `Debug` form. The frontend still
        // discriminates failure CATEGORY (for the icon/banner) via the separate
        // `hcfs_file_failed` Tauri event's typed `FileFailureKindPayload`; this
        // string is only the human "why" shown in the file list and tray.
        let error_msg = crate::sync::events::FileFailureKindPayload::from(kind).display_reason();
        if let Err(e) = crate::sync::progress::mark_file_failed(&sync, rel_path, &error_msg) {
            warn!(
                label = %label,
                path = %rel_path,
                error = %e,
                "failed to mark file failed in progress tracker"
            );
        }
    })
}

/// Wire up the hcfs-client progress callbacks for a drive.
///
/// Connects the `SyncProgress` callback struct (upload/download/encrypt/decrypt
/// progress, scan/fetch state, file-synced notification, and the plan-ready
/// callback) to the `SyncRunner`'s progress tracking and Tauri event emission.
/// Called once per drive during [`initialize_sync_inner`].
pub(crate) fn setup_progress_handlers(app: &AppHandle, manager: &mut DriveManager, label: &str, sync: &Arc<SyncRunner>) {
    let label: Arc<str> = Arc::from(label);

    let upload_ctx = Arc::new(TransferContext {
        sync: sync.clone(),
        app: app.clone(),
        label: Arc::clone(&label),
        direction: TransferDirection::Upload,
    });
    let download_ctx = Arc::new(TransferContext {
        sync: sync.clone(),
        app: app.clone(),
        label: Arc::clone(&label),
        direction: TransferDirection::Download,
    });

    manager.set_progress(SyncProgress {
        on_sync_plan_ready: Some(build_plan_ready_callback(app, Arc::clone(&label), sync)),
        on_upload_progress: Some(Arc::new(move |b, t, p| {
            handle_transfer_progress(&upload_ctx, b, t, p);
        })),
        on_download_progress: Some(Arc::new(move |b, t, p| {
            handle_transfer_progress(&download_ctx, b, t, p);
        })),
        on_encrypt_progress: Some(build_crypto_callback(
            app.clone(),
            sync.clone(),
            Arc::clone(&label),
            crate::sync::progress::FileAction::Encrypt,
            "Encrypt",
        )),
        on_decrypt_progress: Some(build_crypto_callback(
            app.clone(),
            sync.clone(),
            Arc::clone(&label),
            crate::sync::progress::FileAction::Decrypt,
            "Decrypt",
        )),
        on_scan_progress: Some(build_scan_callback(sync.clone(), app.clone(), Arc::clone(&label))),
        on_fetch_state_progress: Some(build_fetch_callback(sync.clone(), app.clone(), Arc::clone(&label))),
        on_file_synced: Some(build_file_synced_callback(app, sync.clone(), Arc::clone(&label))),
        // Per-file failure callback fired synchronously by hcfs-client at the
        // error site. We mutate the in-memory progress tracker here; the
        // bridge's `SyncEvent::FileFailed` arm is the user-visible side (Tauri
        // event emit).
        on_file_failed: Some(build_file_failed_callback(sync.clone(), Arc::clone(&label))),
    });
}

#[cfg(test)]
mod tests {
    use super::{LogThrottle, SCAN_LOG_INTERVAL, ScanLog};
    use std::time::{Duration, Instant};

    #[test]
    fn first_tick_always_logs() {
        let throttle = LogThrottle::new(SCAN_LOG_INTERVAL);

        assert_eq!(
            throttle.decide(Instant::now(), 1),
            ScanLog::Progress,
            "a scan shorter than one interval must still leave a trace",
        );
    }

    #[test]
    fn suppresses_within_the_interval_and_resumes_after_it() {
        let throttle = LogThrottle::new(Duration::from_secs(2));
        let start = Instant::now();

        assert_eq!(throttle.decide(start, 1), ScanLog::Progress);
        assert_eq!(throttle.decide(start + Duration::from_millis(1), 2), ScanLog::Nothing);
        assert_eq!(throttle.decide(start + Duration::from_millis(1999), 3), ScanLog::Nothing);
        assert_eq!(throttle.decide(start + Duration::from_secs(2), 4), ScanLog::Progress);
        assert_eq!(
            throttle.decide(start + Duration::from_millis(2001), 5),
            ScanLog::Nothing,
            "the window restarts from the emission, not from the first call",
        );
    }

    /// The property that makes this a fix rather than a reshuffle: a burst of
    /// per-file ticks inside one interval collapses to a single line. 80k
    /// unthrottled ticks are what truncated a support bundle down to 65
    /// seconds of its day.
    #[test]
    fn a_burst_of_ticks_collapses_to_one_line_per_interval() {
        let throttle = LogThrottle::new(Duration::from_secs(2));
        let start = Instant::now();
        let mut logged = 0_u32;

        // 80,000 ticks spread over 10 seconds - a large drive's scan rate.
        for tick in 0..80_000_u64 {
            let now = start + Duration::from_micros(tick * 125);
            if throttle.decide(now, tick + 1) != ScanLog::Nothing {
                logged += 1;
            }
        }

        // Lines land at t=0, 2s, 4s, 6s and 8s. The final tick is at
        // 9.999875s, so the 10s boundary is never reached.
        assert_eq!(logged, 5, "80,000 ticks over 10s must collapse to one line per 2s interval");
    }

    /// Leading-edge sampling alone loses the number the line exists for: a
    /// 46-file scan completes in under a millisecond, so only tick #1 ever
    /// wins and every cycle would log "1 files scanned" forever. The count
    /// dropping marks the next scan, and the previous total is emitted there.
    #[test]
    fn a_fast_scan_still_reports_its_final_count() {
        let throttle = LogThrottle::new(Duration::from_secs(2));
        let start = Instant::now();

        // Whole 46-file scan inside one interval: only the first tick logs.
        for n in 1..=46_u64 {
            let now = start + Duration::from_micros(n * 20);
            let expected = if n == 1 { ScanLog::Progress } else { ScanLog::Nothing };
            assert_eq!(throttle.decide(now, n), expected, "tick {n}");
        }

        // The next cycle's first tick reports the scan that just ended.
        assert_eq!(
            throttle.decide(start + Duration::from_millis(500), 1),
            ScanLog::FinishedPrevious(46),
            "the completed scan's total must survive, not be sampled away",
        );
    }

    /// The scan-boundary check doubles as the cross-interval reset, so
    /// back-to-back cycles cannot fall silent just because they started inside
    /// the previous cycle's window.
    #[test]
    fn a_cycle_starting_inside_the_previous_window_still_logs() {
        let throttle = LogThrottle::new(Duration::from_secs(2));
        let start = Instant::now();

        assert_eq!(throttle.decide(start, 1), ScanLog::Progress);
        assert_eq!(throttle.decide(start + Duration::from_millis(10), 2), ScanLog::Nothing);

        // A new scan 20ms later - far inside the 2s window.
        assert_eq!(
            throttle.decide(start + Duration::from_millis(20), 1),
            ScanLog::FinishedPrevious(2),
            "a new cycle must not be silenced by the previous cycle's window",
        );
    }
}
