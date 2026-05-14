//! Sync lifecycle: init, stop, pause, resume, auto-init, change folder,
//! progress handler setup, and all supporting private helpers.

use notify::Watcher;
use serde::Serialize;
use tracing::{debug, error, info, warn};

use crate::auth::account_key::account_key;
use crate::auth::tokens::get_api_token;
use crate::error::Result;
use crate::sync::config::{
    build_hcfs_config, get_drive_password, get_hcfs_config_internal, get_sync_path_for_label, load_sync_config, save_hcfs_config_internal,
};
use crate::sync::device::get_device_name_internal;
use crate::sync::folders::{get_all_sync_paths_internal, sanitize_label};
use crate::sync::mnemonic::{account_dir, config_dir_for_folder, derive_folder_mnemonic, ensure_derived_mnemonic, folder_hash, master_mnemonic_path};
use hcfs_client::engine::manager::DriveManager;
use hcfs_client::engine::runner::{DriveSlot, SyncRunner};
use hcfs_client::engine::types::{SyncActivityAction, SyncActivityItem, SyncedFileInfo, build_synced_paths_from_state};
use hcfs_client::sync::SyncProgress;
use sqlx::sqlite::SqlitePool;
use std::error::Error as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as TokioMutex;
use tokio_util::sync::CancellationToken;

/// Start or join the background sync loop.
///
/// Thin wrapper around `SyncRunner::start_sync_loop()` for call sites that
/// don't have direct access to the `Arc<SyncRunner>`.
pub(crate) async fn start_sync_loop(app: tauri::AppHandle) {
    use tauri::Manager;
    let sync = app.state::<crate::app_state::AppState>().sync.clone();
    sync.start_sync_loop().await;
}

/// Remove a directory tree without blocking the Tokio runtime.
///
/// `std::fs::remove_dir_all` walks the tree synchronously and can block
/// Create a directory (recursively) without blocking the Tokio runtime.
///
/// `std::fs::create_dir_all` can perform many synchronous syscalls on
/// deeply nested or slow filesystems. Offloading to `spawn_blocking`
/// keeps the runtime responsive during sync initialization.
async fn create_dir_all_async(path: PathBuf) -> Result<()> {
    tokio::task::spawn_blocking(move || std::fs::create_dir_all(path))
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Join error creating dir: {e}")))??;
    Ok(())
}

/// Result of `initialize_sync` — contains the derived user ID and
/// whether this is a fresh setup (no existing drive metadata found).
#[derive(serde::Serialize, Clone)]
pub struct InitSyncResult {
    pub user_id: String,
    pub mnemonic: Option<String>,
    pub is_new_setup: bool,
}

/// Result of `auto_init_sync`, returned to the frontend for atom updates.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoInitResult {
    pub any_initialized: bool,
    pub is_configured: bool,
    pub skipped_reason: Option<String>,
}

/// Save HCFS config and initialize sync in one step.
///
/// Combines: save_hcfs_config → initialize_sync (+ optional mnemonic persistence).
/// Replaces the 2-invoke `setupAndInitialize` pattern used in useHcfsSync,
/// FilesContainer, and UpdateSyncFolder.
#[tauri::command]
pub async fn setup_and_init_sync(
    app: tauri::AppHandle,
    account_id: String,
    label: String,
    server_url: String,
    password: String,
    mnemonic: Option<String>,
) -> Result<InitSyncResult> {
    use tauri::Manager;
    let state = app.state::<crate::app_state::AppState>();
    let pool = state.pool()?;

    // 1. Save HCFS config
    save_hcfs_config_internal(pool, &account_id, &server_url, &password, mnemonic.as_deref()).await?;

    // 2. Persist master mnemonic (if available and config has a password now)
    if let Some(ref m) = mnemonic
        && let Ok(pw) = get_drive_password(pool, &account_id, Some(m)).await
    {
        let master_path = master_mnemonic_path(&account_id)?;
        let acct_dir = account_dir(&account_id)?;
        create_dir_all_async(acct_dir.clone())
            .await
            .map_err(|e| crate::error::AppError::Other(format!("Failed to create account directory at {}: {e}", acct_dir.display())))?;
        hcfs_client::auth::save_encrypted_mnemonic(&master_path, m, &pw)
            .map_err(|e| crate::error::AppError::Other(format!("Failed to persist master mnemonic at {}: {e}", master_path.display())))?;
    }

    // 3. Initialize sync
    initialize_sync_inner(app, account_id, label, mnemonic, true, false).await
}

/// Add a local folder to sync in one step.
///
/// Combines: generate unique label → set sync path → initialize sync.
/// Replaces the 3-invoke chain in AddLocalFolderDialog.tsx.
#[tauri::command]
pub async fn add_local_sync_folder(
    app: tauri::AppHandle,
    account_id: String,
    path: String,
    folder_name: String,
    mnemonic: Option<String>,
) -> Result<String> {
    use tauri::Manager;
    let state = app.state::<crate::app_state::AppState>();
    let pool = state.pool()?;

    // Enforce credit eligibility at the IPC boundary, priced by the
    // recursive byte sum of the folder's CURRENT contents — those bytes
    // are about to be uploaded by the sync engine on first init.
    // A user setting up sync on a 100 GB folder with $0.10 of credits
    // would silently 402 every file otherwise. The byte-sum walk
    // ignores permission-denied subdirs so the gate under-charges
    // rather than rejecting a legitimate "I have access to most of
    // this" setup. See `crate::billing::eligibility::thresholds`.
    let bytes = crate::sync::files::sum_regular_file_bytes(std::path::Path::new(&path)).await;
    crate::billing::eligibility::require_eligible(
        &state,
        &account_id,
        crate::billing::eligibility::InsufficientCreditsAction::FolderSync,
        bytes,
    )
    .await?;

    // 1. Generate unique label — single source of truth in
    // `crate::sync::paths::generate_unique_label_internal`.
    let owner = account_key(&account_id);
    let rows = sqlx::query("SELECT label FROM sync_paths WHERE owner = ?")
        .bind(&owner)
        .fetch_all(pool)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("DB error: {e}")))?;
    use sqlx::Row;
    let existing: std::collections::HashSet<String> = rows.iter().map(|r| r.get::<String, _>("label")).collect();
    let label = crate::sync::paths::generate_unique_label_internal(&existing, &folder_name);

    // 2. Set sync path in DB
    crate::sync::paths::set_sync_path_internal(pool, &account_id, &path, false, Some(&label)).await?;

    // 3. Initialize sync for this drive (start_loop = true)
    initialize_sync_inner(app, account_id, label.clone(), mnemonic, true, false).await?;

    info!(label = %label, path = %path, "Local sync folder added");
    Ok(label)
}

/// a unique `user_id` on the server. This keeps folder namespaces isolated:
/// switching folders won't download files from the previous folder.
#[tauri::command]
pub async fn initialize_sync(app: tauri::AppHandle, account_id: String, label: String, existing_mnemonic: Option<String>) -> Result<InitSyncResult> {
    initialize_sync_inner(app, account_id, label, existing_mnemonic, true, false).await
}

/// Stop the existing drive with the given label, discard its pending activity
/// and progress session files, and emit a snapshot.
async fn teardown_previous_drive(sync: &SyncRunner, label: &str) {
    {
        let mut drives_guard = sync.drives.lock().await;
        if let Some(old_slot) = drives_guard.remove(label) {
            old_slot.cancel_token.cancel();
            debug!("Dropped previous drive instance for label '{}'", label);
        }
        sync.discard_pending_activity_for_label(label);
        sync.remove_state(label);
    }
    {
        let mut state = sync.progress.lock();
        if let Some(session) = state.current_session.as_mut() {
            let before = session.files.len();
            session.files.retain(|_path, file| file.label.as_ref() != label);
            let removed = before - session.files.len();
            if removed > 0 {
                info!(label = %label, removed, "Removed stale files for re-initializing label");
            }
        }
    }
    sync.emit_snapshot(true);
}

/// Maximum time to wait for the sync loop to exit after cancellation
/// before falling back to `abort`. Should be long enough for an
/// in-progress drive to observe the cancel token and persist state,
/// but short enough that logout doesn't feel sluggish.
const GRACEFUL_SHUTDOWN: std::time::Duration = std::time::Duration::from_millis(500);

/// Cancel every drive's `CancellationToken`. Does NOT remove drives
/// from the map — that happens later in the teardown sequence. Safe to
/// call from any context; takes a brief lock on the drives map.
///
/// The per-drive tokens are observed promptly by `hcfs_client`'s
/// `run_sync_cycle`, which passes them into
/// `sync_with_resolutions_cancellable`. Cancelling here causes any
/// in-flight sync to unwind at its next await point rather than being
/// torn down mid-operation by `JoinHandle::abort`.
async fn cancel_all_drive_tokens(sync: &SyncRunner) {
    let guard = sync.drives.lock().await;
    for (label, slot) in guard.iter() {
        slot.cancel_token.cancel();
        debug!("Cancelled sync token for drive '{}'", label);
    }
}

/// Await the sync loop task with a bounded grace window. Returns
/// `true` if the loop exited cleanly (including expected cancellation
/// or a panic — a panicked task is already terminated, so no abort is
/// needed), `false` if the grace window expired. On timeout the
/// `JoinHandle` is restored to `sync.loop_handle` so the caller's
/// fallback `abort_sync_loop` can consume and abort it.
async fn wait_for_sync_loop_exit(sync: &SyncRunner, grace: std::time::Duration) -> bool {
    let mut handle_guard = sync.loop_handle.lock().await;
    let Some(mut handle) = handle_guard.take() else {
        return true;
    };
    match tokio::time::timeout(grace, &mut handle).await {
        Ok(Ok(())) => true,
        Ok(Err(join_err)) if join_err.is_cancelled() => true,
        Ok(Err(join_err)) => {
            // Task already dead — no abort needed, but surface the panic.
            warn!("Sync loop task panicked on exit: {join_err}");
            true
        }
        Err(_) => {
            warn!("Sync loop did not exit within {grace:?} — will abort");
            // Put the handle back so `abort_sync_loop` can consume it.
            *handle_guard = Some(handle);
            false
        }
    }
}

/// Abort the sync loop task as a last resort. Called only after
/// `wait_for_sync_loop_exit` returns false — a clean cancel-and-wait
/// is always preferred.
async fn abort_sync_loop(sync: &SyncRunner) {
    let mut handle_guard = sync.loop_handle.lock().await;
    if let Some(prev) = handle_guard.take() {
        prev.abort();
    }
}

/// Teardown path when the last drive is being removed.
/// Mirrors `stop_sync`'s order: cancel → wait with grace → abort → clear watcher.
///
/// Note: each drive's per-drive `cancel_token` was already cancelled when the
/// drive was removed from the map. This helper handles the GLOBAL cancel and
/// sync-loop shutdown for when zero drives remain.
async fn teardown_last_drive(sync: &SyncRunner, app: &AppHandle) {
    sync.request_cancel();
    if !wait_for_sync_loop_exit(sync, GRACEFUL_SHUTDOWN).await {
        abort_sync_loop(sync).await;
    }
    {
        let mut watcher_guard = sync.watcher.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        *watcher_guard = None;
    }
    sync.clear_all_reviews();
    let _ = app.emit(crate::sync::events::SYNC_STOPPED, ());
}

/// Remove a drive from the in-memory registry: cancel its token, unwatch
/// its path, and discard associated state. Returns `(remaining_count, removed_path)`.
/// Does NOT touch the database — the caller decides whether to delete or
/// mark-paused the DB row.
async fn remove_drive_inmemory(sync: &SyncRunner, label: &str) -> (usize, Option<PathBuf>) {
    let (remaining, removed_path) = {
        let mut guard = sync.drives.lock().await;
        let path = guard
            .get(label)
            .and_then(|slot| slot.manager.try_lock().ok().map(|m| m.sync_path().to_path_buf()));
        if let Some(slot) = guard.remove(label) {
            slot.cancel_token.cancel();
        }
        (guard.len(), path)
    };
    sync.unregister_label_root(label);

    if let Some(path) = &removed_path {
        let mut watcher_guard = sync.watcher.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(w) = watcher_guard.as_mut() {
            let _ = w.unwatch(path);
        }
    }

    sync.remove_state(label);
    sync.discard_pending_activity_for_label(label);
    // Wipe the synced-paths timestamp cache for this label so a
    // future re-registration under the same label starts from a
    // clean slate (otherwise a stale entry survives across
    // remove/re-add cycles, briefly showing the previous drive's
    // upload dates in the UI until the first reconcile refreshes).
    if let Ok(mut cache) = sync.synced_paths_cache.lock() {
        cache.remove(label);
    }
    // Drop the producer-side first-reconcile gate so the next
    // `register_drive` for this label installs a fresh gate. Any
    // in-flight `wait_for_first_reconcile` from a still-running
    // spawned reconcile task is unaffected — that task holds its
    // own `Arc<ReconcileGate>` clone and will settle on its Arc
    // independently. See the upstream `SyncRunner::remove_drive`
    // comment for the full invariant.
    if let Ok(mut gates) = sync.first_reconcile.lock() {
        gates.remove(label);
    }
    let _ = crate::sync::progress::remove_files_for_label(sync, label.to_string());

    (remaining, removed_path)
}

/// Pre-populate the synced-paths cache and store the manager in the drive
/// registry so the first sync cycle sees correct state immediately.
///
/// Also fires a one-shot background `reconcile_remote_timestamps` via
/// hcfs-client so drives whose on-disk `sync_state.json` predates the
/// authoritative timestamp wire (or whose last sync was cut short before
/// `save_sync_state` ran) self-heal without waiting for the first sync
/// cycle. The task takes the drive's existing `Arc<TokioMutex<DriveManager>>`
/// so a concurrent sync cycle serializes against it naturally — no new lock.
async fn register_drive(app: &AppHandle, sync: &Arc<SyncRunner>, manager: DriveManager, label: &str, sync_path: &str, folder_dir: &Path) {
    // Consume rekey marker (no remote purge)
    let marker = folder_dir.join(".needs_rekey");
    if marker.exists() {
        info!("Rekey marker found for '{}' — consuming without remote purge", label);
        let _ = std::fs::remove_file(&marker);
    }

    // Pre-populate synced-paths cache
    if let Ok(state) = manager.load_sync_state().await {
        let paths = build_synced_paths_from_state(&state);
        if !paths.is_empty() {
            info!(
                label = %label,
                synced_count = paths.len(),
                "Pre-populated synced-paths cache at drive registration",
            );
        }
        sync.update_synced_paths_cache(label, paths);
    }

    sync.register_label_root(label.to_string(), PathBuf::from(sync_path));
    let manager_arc = std::sync::Arc::new(TokioMutex::new(manager));
    let reconcile_arc = std::sync::Arc::clone(&manager_arc);
    {
        let mut guard = sync.drives.lock().await;
        guard.insert(
            label.to_string(),
            DriveSlot {
                manager: manager_arc,
                cancel_token: CancellationToken::new(),
            },
        );
    }

    spawn_reconcile_timestamps(app, sync.clone(), reconcile_arc, label.to_string());
}

/// Background task: drive a bounded-retry reconcile of the server
/// manifest and settle the drive's first-reconcile readiness gate so
/// consumers reading `synced_paths_cache` (e.g. `get_user_files`) can
/// await it.
///
/// Compared to the prior fire-and-forget version, this:
///
/// - Retries transient failures (network / 5xx / timeout) up to the
///   policy's budget (default 3 attempts at 0s / 2s / 5s) inside
///   hcfs-client, so a brief server hiccup at cold start no longer
///   leaves the FE looking at zero-timestamp entries until the next
///   sync cycle.
/// - Settles a per-label `ReconcileGate` regardless of outcome so the
///   FE's `wait_for_first_reconcile` budget is correctly released.
///   Without this, `get_user_files` would wait the full 6s on every
///   cold start before reading a cache that's already fresh from
///   disk (when reconcile is skipped).
/// - On terminal failure (every attempt failed), emits
///   `hcfs_metadata_stale` so the FE can show a per-drive banner.
///   The banner self-clears when the next `ACTIVITY_UPDATED` fires
///   for the same label (e.g. on the first successful sync cycle).
fn spawn_reconcile_timestamps(app: &AppHandle, sync: Arc<SyncRunner>, manager_arc: Arc<TokioMutex<DriveManager>>, label: String) {
    // Acquire the gate handle BEFORE spawning the task. This way,
    // even if the spawn task is delayed (Tokio scheduler under
    // load), any FE call to `wait_for_first_reconcile` already
    // sees the gate as registered (returns Timeout, not
    // NotRegistered) — keeping the readiness contract consistent.
    let gate = sync.first_reconcile_gate(&label);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        use hcfs_client::drive::{FailureReason, ReconcileOutcome, RetryPolicy};

        // Hold the per-drive manager lock across the ENTIRE
        // `reconcile_with_retry` await.
        //
        // The reviewer flagged this lock window as wasteful (up to
        // ~7s with 0s / 2s / 5s backoffs and HTTP latency), and the
        // hcfs-client API was changed so the returned future is
        // `'static` precisely to allow a lock-free await. However,
        // releasing the lock around the network call opened a
        // concurrent file-write race: both `reconcile_with_retry`
        // (on success) and `run_sync_cycle` (end of every cycle)
        // persist `sync_state.json`. With the lock released, a sync
        // cycle triggered by a user `add_files` IPC right after
        // login could interleave its plan-and-save with the
        // reconcile's save, dropping the upload entry from the
        // baseline. Observed symptom: the "Adding ... to sync
        // folder…" toast sat on the 60s `upload_processing`
        // watchdog timeout because no first-chunk event ever fired.
        //
        // The cold-start reconcile is a one-shot per drive — once
        // the cache is populated the gate stays settled for the
        // rest of the session, so this lock window is paid at most
        // once per drive per login. Restoring concurrency safety
        // beats saving 7s on cold start.
        //
        // The hcfs-client `'static` future shape is preserved so
        // that a future revision can move the file-write
        // coordination into hcfs-client (e.g. an internal
        // per-drive write mutex) and reclaim the lock-window
        // optimization without another desktop change.
        //
        // Lock hygiene: `manager_arc` is a `tokio::sync::Mutex` so
        // its guard is `Send` and safely held across `.await`
        // points (Async Lock Hygiene axiom applies to
        // `std::sync::Mutex` guards, not Tokio's).
        let manager = manager_arc.lock().await;
        let outcome = manager.reconcile_with_retry(RetryPolicy::first_reconcile_default()).await;

        match &outcome {
            ReconcileOutcome::Reconciled { duration_ms } => match manager.load_sync_state().await {
                Ok(state) => {
                    let paths = build_synced_paths_from_state(&state);
                    sync.update_synced_paths_cache(&label, paths);
                    drop(manager);
                    let _ = app.emit(crate::sync::events::ACTIVITY_UPDATED, ());
                    info!(label = %label, duration_ms = duration_ms, "reconcile: cache refreshed");
                }
                Err(e) => {
                    warn!(label = %label, error = %e, "reconcile: post-fetch state reload failed");
                }
            },
            ReconcileOutcome::Fresh => {
                debug!(label = %label, "reconcile: skipped (fresh)");
            }
            ReconcileOutcome::Failed { reason, attempts } => {
                let reason_str = match reason {
                    FailureReason::Retryable { last_error } => {
                        // `last_error` is `Arc<SyncError>`; Display
                        // delegates through the Arc. Downstream
                        // consumers wanting typed dispatch (e.g.
                        // `SyncError::RateLimited`'s retry_after_secs)
                        // can match on `last_error.as_ref()` from the
                        // outcome variant.
                        format!("transient error after {attempts} attempts: {last_error}")
                    }
                    FailureReason::Terminal { error } => {
                        format!("non-retryable error: {error}")
                    }
                    // `FailureReason` is `#[non_exhaustive]` so an
                    // hcfs-client bump can add new variants without
                    // breaking the build. Render unknowns as a
                    // generic transient failure — better than
                    // hiding them entirely.
                    _ => format!("reconcile failed after {attempts} attempts"),
                };
                warn!(label = %label, attempts = attempts, reason = %reason_str, "reconcile: failed, emitting metadata-stale");
                let _ = app.emit(
                    crate::sync::events::METADATA_STALE,
                    crate::sync::events::MetadataStalePayload {
                        label: label.clone(),
                        reason: reason_str,
                    },
                );
            }
            // `ReconcileOutcome` is `#[non_exhaustive]`; tolerate
            // unknown future variants by logging and falling
            // through to the gate settle below (which guarantees
            // awaiters never hang forever).
            _ => {
                warn!(label = %label, "reconcile: unknown outcome variant from hcfs-client (likely needs FE wiring)");
            }
        }

        // Settle the gate AFTER all I/O so a consumer that wakes
        // on the settle sees a fully-coherent cache. The gate is
        // first-write-wins; settling here on every code path is
        // safe and required (the readiness signal must be set even
        // when the outcome is `Failed`, so awaiters don't hang
        // until the timeout).
        gate.settle(outcome);
    });
}

/// Run migration from legacy config layouts into the per-folder layout.
///
/// Handles three legacy configurations:
///
/// **Legacy A** — `<sync_folder>/.hippius/` (original pre-config-dir layout):
///   Copy all files into `folder_dir/`, save the mnemonic as master too.
///
/// **Legacy B** — `account_dir/enc_mnemonic.json` (per-account layout from recent changes):
///   Copy `enc_mnemonic.json` → `master_enc_mnemonic.json`, then move files into `folder_dir/`.
///
/// Both preserve the existing mnemonic as-is (no re-derivation) to maintain access
/// to existing server files for the migrated folder.
fn run_migration(sync_path: &str, account_dir: &Path, folder_dir: &Path, master_path: &Path) -> Result<()> {
    // If folder_dir already has an enc_mnemonic.json, migration is complete
    if folder_dir.join("enc_mnemonic.json").exists() {
        return Ok(());
    }

    let legacy_a_dir = PathBuf::from(sync_path).join(".hippius");
    let legacy_b_enc = account_dir.join("enc_mnemonic.json");

    // --- Legacy A: <sync_folder>/.hippius/ ---
    if legacy_a_dir.exists() && legacy_a_dir.join("enc_mnemonic.json").exists() {
        info!("Legacy A detected: {:?} → {:?}", legacy_a_dir, folder_dir);

        std::fs::create_dir_all(folder_dir)?;

        // Copy all files into folder_dir
        copy_dir_contents(&legacy_a_dir, folder_dir)?;

        // Verify critical file
        if !folder_dir.join("enc_mnemonic.json").exists() {
            return Err(crate::error::AppError::Other(
                "Migration A verification failed: enc_mnemonic.json not in folder dir".into(),
            ));
        }

        // This mnemonic is the master — save it at account level if not already there
        if !master_path.exists() {
            std::fs::create_dir_all(account_dir)?;
            std::fs::copy(folder_dir.join("enc_mnemonic.json"), master_path)?;
            info!("Saved master mnemonic from Legacy A");
        }

        // Remove legacy dir (non-fatal on failure)
        if let Err(e) = std::fs::remove_dir_all(&legacy_a_dir) {
            warn!("Could not remove legacy A dir: {e}");
        } else {
            info!("Removed legacy A directory");
        }

        return Ok(());
    }

    // --- Legacy B: account_dir/enc_mnemonic.json (per-account, not per-folder) ---
    if legacy_b_enc.exists() {
        info!("Legacy B detected: {:?} → {:?}", legacy_b_enc, folder_dir);

        // Save as master if not already present
        if !master_path.exists() {
            std::fs::copy(&legacy_b_enc, master_path)?;
            info!("Saved master mnemonic from Legacy B");
        }

        std::fs::create_dir_all(folder_dir)?;

        // Move enc_mnemonic.json, sync_state.json*, temp/ into folder_dir
        for name in &["enc_mnemonic.json", "sync_state.json", "sync_state.json.bak"] {
            let src = account_dir.join(name);
            if src.exists() {
                let dst = folder_dir.join(name);
                std::fs::copy(&src, &dst)?;
                debug!("Copied {} to folder dir", name);
            }
        }

        let temp_src = account_dir.join("temp");
        if temp_src.is_dir() {
            let temp_dst = folder_dir.join("temp");
            copy_dir_recursive(&temp_src, &temp_dst)?;
            debug!("Copied temp/ to folder dir");
        }

        // Verify critical file
        if !folder_dir.join("enc_mnemonic.json").exists() {
            return Err(crate::error::AppError::Other(
                "Migration B verification failed: enc_mnemonic.json not in folder dir".into(),
            ));
        }

        // Clean up originals from account_dir (not master_enc_mnemonic.json)
        for name in &["enc_mnemonic.json", "sync_state.json", "sync_state.json.bak"] {
            let src = account_dir.join(name);
            if src.exists() {
                let _ = std::fs::remove_file(&src);
            }
        }
        let temp_src = account_dir.join("temp");
        if temp_src.is_dir() {
            let _ = std::fs::remove_dir_all(&temp_src);
        }

        info!("Legacy B migration complete");
        return Ok(());
    }

    // No legacy layout found — fresh setup
    Ok(())
}

/// Copy all entries from `src` into `dst`, recursing into subdirectories.
fn copy_dir_contents(src: &Path, dst: &Path) -> Result<()> {
    let entries = std::fs::read_dir(src).map_err(|e| crate::error::AppError::Other(format!("Failed to read dir {}: {e}", src.display())))?;

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };

        if path.is_file() {
            std::fs::copy(&path, dst.join(&name))?;
        } else if path.is_dir() {
            copy_dir_recursive(&path, &dst.join(&name))?;
        }
    }
    Ok(())
}

/// Recursively copy a directory and its contents.
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)?.flatten() {
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

/// Check if the sync directory was deleted by the user and handle cleanup.
///
/// If the config dir has sync state (was previously syncing) but the sync
/// folder is completely gone, the user intentionally removed it. Removes
/// the stale DB row and returns an error so `initialize_sync_inner` aborts.
async fn check_deleted_sync_dir(pool: &SqlitePool, account_id: &str, label: &str, sync_path: &str) -> Result<()> {
    let sync_dir_existed = Path::new(sync_path).exists();
    let folder_dir = config_dir_for_folder(account_id, label)?;
    let had_sync_state = folder_dir.join("sync_state.json").exists();

    if !sync_dir_existed && had_sync_state {
        warn!(
            "Sync folder '{}' was deleted but config still exists for '{}'. \
             Removing stale sync path from DB to prevent remote file deletion.",
            sync_path, label
        );
        if let Err(e) = crate::sync::paths::remove_sync_path_internal(pool, account_id, label).await {
            warn!("Failed to remove stale sync path for '{}': {}", label, e);
        }
        let _ = std::fs::remove_file(folder_dir.join("sync_state.json"));
        let _ = std::fs::remove_file(folder_dir.join("sync_state.json.bak"));
        return Err(crate::error::AppError::Validation(format!(
            "Sync folder '{sync_path}' for '{label}' was removed. \
             It has been unregistered from sync. \
             Re-add it from Settings if this was unintentional."
        )));
    }
    Ok(())
}

/// Compute config directories, run legacy migration, and reconcile the
/// master mnemonic with the login mnemonic (if provided).
fn prepare_config_dir(
    account_id: &str,
    label: &str,
    sync_path: &str,
    drive_password: &str,
    existing_mnemonic: Option<&str>,
) -> Result<(PathBuf, PathBuf, PathBuf)> {
    let acct_dir = account_dir(account_id)?;
    let folder_dir = config_dir_for_folder(account_id, label)?;
    let master_path = master_mnemonic_path(account_id)?;
    run_migration(sync_path, &acct_dir, &folder_dir, &master_path)?;

    // If the login mnemonic is available, ensure the stored master matches
    // (or create it when missing — e.g. keychain-less session restore where
    // the drive was initialized in a prior session but the master file was
    // never written or was lost).
    if let Some(imported) = existing_mnemonic {
        if master_path.exists() {
            use zeroize::Zeroize;
            let stored = hcfs_client::auth::recover_mnemonic(&master_path, drive_password)?;
            let mut stored_str = stored.to_string();
            if stored_str != *imported {
                info!(
                    "Stored master differs from login mnemonic — \
                     updating master before derivation check"
                );
                hcfs_client::auth::save_encrypted_mnemonic(&master_path, imported, drive_password)?;
            }
            stored_str.zeroize();
        } else {
            std::fs::create_dir_all(&acct_dir)?;
            hcfs_client::auth::save_encrypted_mnemonic(&master_path, imported, drive_password)?;
            info!("Persisted master mnemonic (was missing on disk)");
        }
    }

    ensure_derived_mnemonic(&folder_dir, &master_path, drive_password, label)?;

    Ok((acct_dir, folder_dir, master_path))
}

/// Parameters for drive recovery that group connection and identity info.
struct RecoveryContext<'a> {
    sync_path: &'a str,
    folder_dir: &'a Path,
    master_path: &'a Path,
    server_url: &'a str,
    bearer_token: &'a str,
    account_id: &'a str,
    fhash: &'a str,
    label: &'a str,
    drive_password: &'a str,
    existing_mnemonic: Option<&'a str>,
}

/// Recover a drive after unlock failure: clean up corrupted config files,
/// create a fresh `DriveManager`, re-derive the mnemonic, and unlock.
///
/// Returns `(new_manager, user_id, optional_master_mnemonic)`.
///
/// # Security
/// `master_str` (the BIP-39 master mnemonic) and `derived` (the per-folder
/// mnemonic) are wrapped in [`zeroize::Zeroizing`] so their heap memory is
/// scrubbed when the values are dropped.
async fn recover_drive(manager: DriveManager, ctx: &RecoveryContext<'_>) -> Result<(DriveManager, String, Option<zeroize::Zeroizing<String>>)> {
    // Remove corrupted enc_mnemonic.json
    let enc_path = ctx.folder_dir.join("enc_mnemonic.json");
    if enc_path.exists() {
        if let Err(rm_err) = std::fs::remove_file(&enc_path) {
            warn!("Failed to remove enc_mnemonic.json: {}", rm_err);
        } else {
            debug!("Removed enc_mnemonic.json");
        }
    }

    // Remove sync state and rekey marker to start fresh
    let _ = std::fs::remove_file(ctx.folder_dir.join("sync_state.json"));
    let _ = std::fs::remove_file(ctx.folder_dir.join("sync_state.json.bak"));
    let _ = std::fs::remove_file(ctx.folder_dir.join(".needs_rekey"));
    info!("Recovery cleanup complete. Retrying initialization...");

    drop(manager);
    let mut new_manager = DriveManager::new(PathBuf::from(ctx.sync_path), ctx.folder_dir.to_path_buf());
    new_manager.set_config(build_hcfs_config(ctx.server_url, ctx.bearer_token, ctx.account_id, ctx.fhash))?;

    debug!("Creating fresh drive after recovery...");

    let master_str: zeroize::Zeroizing<String> = if let Some(imported) = ctx.existing_mnemonic {
        debug!("Using login mnemonic as master for recovery");
        zeroize::Zeroizing::new(imported.to_string())
    } else {
        let master = bip39::Mnemonic::generate(24).map_err(|e| crate::error::AppError::Crypto(e.to_string()))?;
        warn!("Generated new random master for recovery (no login mnemonic available)");
        zeroize::Zeroizing::new(master.to_string())
    };
    hcfs_client::auth::save_encrypted_mnemonic(ctx.master_path, &master_str, ctx.drive_password)?;
    let derived = zeroize::Zeroizing::new(derive_folder_mnemonic(&master_str, ctx.label)?);

    let mut init_mnemonic = new_manager.init(ctx.drive_password, Some(&*derived)).await?;
    zeroize::Zeroize::zeroize(&mut init_mnemonic);

    let uid = new_manager.unlock(ctx.drive_password)?;
    info!("Drive re-initialized and unlocked, derived user_id: {}", uid);

    Ok((new_manager, uid, Some(master_str)))
}

/// Attempt to unlock an existing drive, falling back to full recovery or fresh init.
///
/// Takes ownership of `manager` and returns it (possibly replaced after recovery).
/// The tuple contains `(manager, user_id, optional_master_mnemonic, is_new_setup)`.
async fn init_or_unlock_drive(
    mut manager: DriveManager,
    label: &str,
    master_path: &Path,
    drive_password: &str,
    existing_mnemonic: Option<&str>,
    recovery_ctx: &RecoveryContext<'_>,
) -> Result<(DriveManager, String, Option<zeroize::Zeroizing<String>>, bool)> {
    if manager.is_initialized() {
        debug!("Drive already initialized for '{}', unlocking...", label);
        match manager.unlock(drive_password) {
            Ok(uid) => {
                info!("Drive unlocked, user_id: {}", uid);
                Ok((manager, uid, None, false))
            }
            Err(e) => {
                error!("Unlock failed for '{}': {}", label, e);
                info!("Attempting recovery: cleaning up encrypted files...");
                let (new_mgr, uid, master) = recover_drive(manager, recovery_ctx).await?;
                Ok((new_mgr, uid, master, true))
            }
        }
    } else {
        let (uid, mnem, is_new) = init_new_drive(&mut manager, label, master_path, drive_password, existing_mnemonic).await?;
        Ok((manager, uid, mnem.map(zeroize::Zeroizing::new), is_new))
    }
}

/// Initialize a brand-new folder: resolve the mnemonic source (imported
/// login mnemonic, existing master on disk, or error), init the drive,
/// and unlock it.
///
/// Returns `(user_id, optional_master_for_backup, is_new_master)`.
async fn init_new_drive(
    manager: &mut DriveManager,
    label: &str,
    master_path: &Path,
    drive_password: &str,
    existing_mnemonic: Option<&str>,
) -> Result<(String, Option<String>, bool)> {
    info!(
        "Drive not initialized for '{}', creating... (existing_mnemonic={}, master_exists={})",
        label,
        existing_mnemonic.is_some(),
        master_path.exists(),
    );

    let (folder_mnemonic, master_for_backup, generated_new) = if let Some(imported) = existing_mnemonic {
        if master_path.exists() {
            let stored =
                hcfs_client::auth::recover_mnemonic(master_path, drive_password).map_err(|e| format!("Failed to recover master mnemonic: {e}"))?;
            let stored_str = zeroize::Zeroizing::new(stored.to_string());
            if *stored_str == *imported {
                debug!("Stored master matches login mnemonic");
            } else {
                info!("Stored master differs from login mnemonic — updating master");
                hcfs_client::auth::save_encrypted_mnemonic(master_path, imported, drive_password)?;
            }
            // stored_str is zeroized on drop here
        } else {
            hcfs_client::auth::save_encrypted_mnemonic(master_path, imported, drive_password)?;
            info!("Saved login mnemonic as master (new device)");
        }
        let derived = zeroize::Zeroizing::new(derive_folder_mnemonic(imported, label)?);
        (derived, None, false)
    } else if master_path.exists() {
        let master =
            hcfs_client::auth::recover_mnemonic(master_path, drive_password).map_err(|e| format!("Failed to recover master mnemonic: {e}"))?;
        let master_str = zeroize::Zeroizing::new(master.to_string());
        let derived = zeroize::Zeroizing::new(derive_folder_mnemonic(&master_str, label)?);
        debug!("Derived folder mnemonic from existing master");
        // master_str is zeroized on drop here
        (derived, None, false)
    } else {
        return Err(crate::error::AppError::NotReady(crate::error::NotReadyKind::NoEncryptionKey));
    };

    let mut init_mnemonic = manager.init(drive_password, Some(&*folder_mnemonic)).await?;
    zeroize::Zeroize::zeroize(&mut init_mnemonic);
    drop(init_mnemonic);
    // folder_mnemonic is zeroized on drop (Zeroizing wrapper)

    let uid = manager.unlock(drive_password)?;
    info!("Drive initialized and unlocked for '{}', derived user_id: {}", label, uid);

    Ok((uid, master_for_backup, generated_new))
}

/// Fire-and-log a health check against the HCFS server.
async fn check_init_server_health(client: &reqwest::Client, server_url: &str) {
    let test_url = format!("{server_url}/health");
    debug!("Testing connectivity to: {}", test_url);
    let resp = client.get(&test_url).header("X-API-Key", "Arion").send().await;
    match resp {
        Ok(r) => debug!("Health check OK: status={}", r.status()),
        Err(e) => {
            let mut msg = format!("{e}");
            let mut source: Option<&dyn std::error::Error> = e.source();
            while let Some(cause) = source {
                use std::fmt::Write;
                let _ = write!(msg, "\n  caused by: {cause}");
                source = cause.source();
            }
            warn!("Health check failed: {}", msg);
        }
    }
}

/// Spawn a background task to register the folder with the server for
/// cross-device discovery.
fn spawn_folder_registration(server_url: &str, bearer_token: &str, label: &str, account_id: &str, fhash: &str, pool: &SqlitePool, sync_path: &str) {
    let config = build_hcfs_config(server_url, bearer_token, account_id, fhash);
    // Use the folder's directory name as the display label for the server
    // registry instead of the internal label (e.g. "default").
    let reg_label = std::path::Path::new(sync_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(label)
        .to_string();
    let reg_ss58 = account_id.to_string();
    let reg_fhash = fhash.to_string();
    let reg_pool = pool.clone();
    tokio::spawn(async move {
        match hcfs_client::client::HcfsClient::new(config) {
            Ok(client) => {
                let dev_name = get_device_name_internal(&reg_pool).await.ok();
                if let Err(e) = client.register_folder(&reg_ss58, &reg_fhash, &reg_label, dev_name.as_deref()).await {
                    warn!("Folder registration failed: {}", e);
                } else {
                    info!("Folder '{}' registered with server", reg_label);
                }
            }
            Err(e) => {
                warn!("Could not create client for folder registration: {}", e);
            }
        }
    });
}

/// Core init logic. When `start_loop` is false the caller is responsible for
/// starting the sync loop after all drives have been registered (batch restore).
///
/// `skip_credits_check` suppresses the HTTP call to `/api/billing/credits/balance/`.
/// Pass `true` when the caller has already validated credits (e.g. `auto_init_sync`
/// checks once before its per-drive loop to avoid N redundant requests).
pub(crate) async fn initialize_sync_inner(
    app: tauri::AppHandle,
    account_id: String,
    label: String,
    existing_mnemonic: Option<String>,
    start_loop: bool,
    skip_credits_check: bool,
) -> Result<InitSyncResult> {
    use tauri::Manager;
    let label = sanitize_label(&label)?;
    let app_state = app.state::<crate::app_state::AppState>();

    // Block non-migration sync init while a migration is running
    if label != "migration" && app_state.migration.in_progress.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(crate::error::AppError::Other(
            "Migration in progress — sync blocked until migration completes".into(),
        ));
    }

    let sync = &app_state.sync;
    let pool_owned = app_state.pool()?.clone();
    let pool = &pool_owned;
    info!("initialize_sync called for account: {}, label: '{}'", account_id, label);

    // Validate user has credits/balance before allowing sync.
    // This is skipped when the caller has already performed the check (e.g.
    // `auto_init_sync` checks once before iterating all drives).
    if !skip_credits_check && let Ok(acct) = app_state.current_account_id() {
        let client = crate::api::client::ApiClient::new(app_state.api_client.clone(), pool_owned.clone());
        if let Ok(resp) = client
            .get::<crate::billing::credits::CreditBalanceResponse>("/api/billing/credits/balance/", &acct)
            .await
        {
            let balance: f64 = resp.balance.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            if balance <= 0.0 {
                return Err(crate::error::AppError::Validation(
                    "Insufficient credits. Please add credits to your account before syncing.".into(),
                ));
            }
        }
    }

    teardown_previous_drive(sync, &label).await;

    // Load config (needs mnemonic to decrypt drive password).
    //
    // When no caller-supplied mnemonic is available, we resolve it via the
    // full 5-stage `get_mnemonic_for_account` fallback chain (in-memory
    // cache → encrypted master on disk → live drive export → DB row).
    // The previous `auth.lock().mnemonic` fallback failed on slow systems
    // where the FE triggered `auto_init_sync` before post-login
    // `rehydrate_full_session` had finished writing `AuthInfo.mnemonic`,
    // even though `master_enc_mnemonic.json` was already on disk. Going
    // through the helper also converts the failure mode from an
    // unstructured `AppError::Other(String)` to the machine-readable
    // `NotReady(MasterMnemonicUnrecoverable)` that the FE can retry on.
    let mnemonic_for_config = if let Some(ref m) = existing_mnemonic {
        m.clone()
    } else {
        let resolved = crate::sync::mnemonic::get_mnemonic_for_account(app_state.inner(), &account_id).await?;
        resolved.as_str().to_owned()
    };
    let cfg = load_sync_config(pool, &account_id, &label, &mnemonic_for_config).await?;
    crate::sync::files::allow_asset_directory(&app, &cfg.sync_path);
    check_deleted_sync_dir(pool, &account_id, &label, &cfg.sync_path).await?;
    create_dir_all_async(PathBuf::from(&cfg.sync_path)).await?;

    let (_acct_dir, folder_dir, master_path) =
        prepare_config_dir(&account_id, &label, &cfg.sync_path, &cfg.drive_password, Some(&mnemonic_for_config))?;

    // Create drive and set HCFS config
    let mut manager = DriveManager::new(PathBuf::from(&cfg.sync_path), folder_dir.clone());

    // If the stored token is expired (or expires within 60s), refresh it
    // before handing it to the drive. This avoids an immediate 401 on the
    // first sync cycle after a long splash or resume-from-sleep.
    const TOKEN_REFRESH_MARGIN_SECS: i64 = 60;
    if crate::auth::tokens::is_token_expiring(pool, &account_id, TOKEN_REFRESH_MARGIN_SECS).await {
        debug!("Stored token near expiry; refreshing before sync init");
        if let Err(e) = crate::auth::service::refresh_auth_token_internal(pool, &app, &account_id).await {
            warn!("Pre-init token refresh failed: {e} — will rely on runtime 401 handler");
        }
    }

    let bearer_token = get_api_token(pool, &account_id)
        .await?
        .ok_or_else(|| crate::error::AppError::Other("No authentication token found. Please log in again.".into()))?;
    let fhash = folder_hash(&label);
    manager.set_config(build_hcfs_config(&cfg.server_url, &bearer_token, &account_id, &fhash))?;

    // Init or unlock
    let recovery_ctx = RecoveryContext {
        sync_path: &cfg.sync_path,
        folder_dir: &folder_dir,
        master_path: &master_path,
        server_url: &cfg.server_url,
        bearer_token: &bearer_token,
        account_id: &account_id,
        fhash: &fhash,
        label: &label,
        drive_password: &cfg.drive_password,
        existing_mnemonic: Some(&mnemonic_for_config),
    };
    let (manager, user_id, mnemonic, is_new_setup) = init_or_unlock_drive(
        manager,
        &label,
        &master_path,
        &cfg.drive_password,
        Some(&mnemonic_for_config),
        &recovery_ctx,
    )
    .await?;
    let mut manager = manager;

    // Validate user_id
    let expected_user_id = format!("{account_id}_{fhash}");
    if user_id != expected_user_id {
        return Err(crate::error::AppError::Validation(format!(
            "Drive user_id mismatch: got '{user_id}', expected '{expected_user_id}'. \
             This indicates a corrupted config directory. \
             Please remove the folder and re-add it."
        )));
    }

    check_init_server_health(&app_state.health_client, &cfg.server_url).await;
    setup_progress_handlers(&app, &mut manager, &label, sync);
    sync.clear_cancel();
    register_drive(&app, sync, manager, &label, &cfg.sync_path, &folder_dir).await;

    if start_loop {
        start_sync_loop(app.clone()).await;
    }
    info!(
        "Sync initialized successfully for '{}'. User ID: {}, New setup: {}",
        label, user_id, is_new_setup
    );
    spawn_folder_registration(&cfg.server_url, &bearer_token, &label, &account_id, &fhash, pool, &cfg.sync_path);

    // Emit a per-drive Active status so any FE listener (settings page,
    // tray submenu) updates this one drive without re-fetching the
    // whole list. Other drives are unaffected.
    crate::sync::status::emit_drive_status(&app, &label, &cfg.sync_path, crate::sync::drive_status::DriveStatus::Active);

    // One-shot `relative_path` backfill for this drive. The task itself
    // re-checks the `relative_paths_backfilled_at` flag as its first
    // step and returns `AlreadyDone` without any work if set — so the
    // call site stays dumb even under re-init storms.
    crate::sync::relative_path_backfill::spawn_backfill(app.clone(), account_id.clone(), label.clone());

    Ok(InitSyncResult {
        user_id,
        // Unwrap Zeroizing at the IPC serialization boundary; the Zeroizing
        // copy is dropped (and scrubbed) immediately after the clone.
        mnemonic: mnemonic.map(|z| (*z).clone()),
        is_new_setup,
    })
}

/// Stop ALL drives. **Internal lifecycle cleanup** — not user intent.
/// Call sites:
///
/// - `wallet-auth-context.tsx::initSync` runs this as defensive cleanup
///   right before `tryAutoInitSync` on every login, so any drives left
///   over from a previous session are cleared.
/// - `auth/logout.rs::logout` calls it to drop drives during sign-out.
/// - `lifecycle.rs::reset_sync_data` calls it before wiping local state.
///
/// In the per-drive status model this function does NOT touch any
/// persisted state — `sync_paths.is_paused` rows are left untouched
/// because they represent user intent that must survive logout/login.
/// It also does not emit any per-drive status events: drives are about
/// to be re-loaded by `auto_init_sync` (in the login/reset case) or
/// the user has been signed out (logout case), and either way the FE
/// will rebuild its per-drive map from `get_all_drive_statuses` after
/// the dust settles.
#[tauri::command]
pub async fn stop_sync(app: AppHandle) -> Result<()> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    // 0. Release the auto-init latch if a hung auto_init_sync was still
    //    holding it when the user hit logout. Without this, a subsequent
    //    login's auto-init would bail with "already in progress" forever
    //    until the app was restarted. The `AutoInitGuard` itself clears
    //    on normal Drop, but a hang inside `auto_init_sync_inner` (e.g.
    //    a stuck HCFS health check) can keep it held for minutes.
    AUTO_INIT_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);

    // 0b. Wipe the per-drive status cache so the next login starts fresh.
    //     The cache is the source of truth for `get_all_drive_statuses`
    //     now that it remembers Error states across FE re-mounts.
    if let Ok(mut cache) = app_state.drive_status_cache.lock() {
        cache.clear();
    }

    // 0c. Reset the upload-processing banner state for EVERY label so a
    //     logout / account switch doesn't leave a stale "Processing N files…"
    //     banner up for the next user. `reset_all` is unconditional (clears
    //     even if no upload was active) and emits one cleared payload per
    //     previously-active label so the FE per-drive banners all clear.
    app_state.upload_processing.reset_all(&app);

    // 1. Cancel every drive's cancellation token FIRST so the sync loop
    //    sees a clean shutdown signal and can persist state before exiting.
    cancel_all_drive_tokens(sync).await;

    // 2. Request the global cancel (belt + braces for loop-level checks
    //    and to prevent a fresh cycle from starting after the per-drive
    //    tokens above are observed — `trigger_sync_for_drive` overwrites
    //    `slot.cancel_token` with a fresh token at the start of each cycle).
    sync.request_cancel();

    // 3. Give the loop up to GRACEFUL_SHUTDOWN to observe the cancels and
    //    exit on its own. Fall back to abort only if it hangs.
    let clean_exit = wait_for_sync_loop_exit(sync, GRACEFUL_SHUTDOWN).await;
    if !clean_exit {
        abort_sync_loop(sync).await;
    }

    // 4. Now safe to clear the watcher — no task is racing on sync state.
    {
        let mut watcher_guard = sync.watcher.lock().unwrap_or_else(|p| {
            warn!("Poisoned watcher mutex recovered in stop_sync");
            p.into_inner()
        });
        *watcher_guard = None;
    }

    // 4b. Clean up session-skip exclude patterns before drives are removed.
    crate::sync::failure_commands::cleanup_session_skips(&app_state).await;

    // 5. Clear drives map and reset in-memory state.
    {
        let mut guard = sync.drives.lock().await;
        guard.clear();
    }
    sync.reset_sync_counter();
    sync.clear_all_reviews();
    sync.reset_all_states();
    sync.reset_health();
    sync.reset_sync_failures();
    sync.discard_all_pending_activity();
    sync.clear_label_roots();

    // Clear the per-label preparing overrides so a logout / account
    // switch cannot leak a "Preparing sync…" widget into the next
    // session. Mirrors the unconditional `upload_processing.reset`
    // pattern — both are transient UI-affordance state that must
    // not survive across accounts.
    app_state.preparing.clear_all();

    // Emit sync stopped event so frontend can reset UI state (tray icon, sync widget)
    let _ = app.emit(crate::sync::events::SYNC_STOPPED, ());

    Ok(())
}

/// Permanently remove a single drive by label. Tears down its in-memory
/// state, deletes the corresponding `sync_paths` DB row, and emits a
/// `DRIVE_REMOVED` event so the FE drops it from the per-drive status
/// map. **Files on disk are left untouched** — only the sync engine
/// stops tracking this folder.
///
/// This is the destructive sibling of `pause_drive` (which preserves
/// the row + `is_paused=true`). Renamed from `stop_drive` in the
/// per-drive status migration to make the destructive intent explicit.
///
/// Used for the 3-dot menu's "Remove from sync" action and for
/// `change_sync_folder`'s teardown step before re-initializing with a
/// new path.
#[tauri::command]
pub async fn remove_drive(app: AppHandle, label: String) -> Result<()> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    let (remaining, _removed_path) = remove_drive_inmemory(sync, &label).await;

    // Drop the preparing override for this label so a remove during
    // the SyncStarted → plan_ready window cannot leave a stuck
    // "Preparing sync…" badge tied to a drive that no longer exists.
    //
    // Belt-and-suspenders with the `SyncError::Cancelled` arm in
    // `tauri_bridge.rs` — that arm also clears preparing for the
    // cancelled label, but the cancel SyncEvent is dispatched
    // asynchronously relative to this synchronous IPC and may not
    // have landed yet. Calling `clear` here is idempotent (second
    // call returns `false` and skips the `emit_snapshot`), so the
    // dual-path is cheap and covers the race where the IPC returns
    // before the bridge has seen the cancel.
    if app_state.preparing.clear(&label) {
        sync.emit_snapshot(true);
    }

    // Wake any waiters in remove_drive_and_wait so they can re-check without
    // sleeping through the full polling interval.
    app_state.drive_removed_notify.notify_waiters();

    // Delete the DB row so the drive isn't resurrected on app restart.
    // Best-effort: if the account or pool isn't available, the in-memory
    // cleanup above still takes effect for this session.
    let acct = app_state.current_account_id().ok();
    if let (Ok(pool), Some(acct)) = (app_state.pool(), acct.as_deref())
        && let Err(e) = crate::sync::paths::remove_sync_path_internal(pool, acct, &label).await
    {
        warn!("Failed to remove sync path for '{}' from DB: {e}", label);
    }

    // Drop the on-disk sync baseline. Without this, a re-add (whether at the
    // same path or a new one) would resurrect the old `synced` tree and the
    // next sync cycle would compute deletes against it: when `delete_remote_folder`
    // wipes the server but leaves local files intact, the empty remote ∖ stale
    // synced becomes `local_deletes` and the user's files are nuked on the
    // next cycle. `recover_drive` already does the same cleanup at line 632
    // for unlock-failure recovery — same "destructive intent → start fresh"
    // semantics. `pause_drive` deliberately preserves this state because pause
    // is the reversible counterpart to remove.
    if let Some(acct) = acct.as_deref() {
        clear_persisted_sync_state(acct, &label);
    }

    if remaining == 0 {
        teardown_last_drive(sync, &app).await;
    }

    // Tell the FE to drop this drive's entry from its per-drive status
    // map. Other drives are unaffected and keep their existing status.
    crate::sync::status::emit_drive_removed(&app, &label);

    info!("Removed drive '{}', {} drives remaining", label, remaining);
    Ok(())
}

/// Best-effort delete of `sync_state.json` and `sync_state.json.bak` for the
/// given drive. Returns nothing — every failure mode here (account dir missing,
/// label never persisted, file already gone, permission issue) is benign:
/// the worst case is a stale baseline survives, which is exactly the state we
/// already had before this fix and which the next `remove_drive` call will
/// re-attempt to clean.
///
/// `NotFound` errors are treated as success and not logged: a drive that was
/// removed before its first sync, or a label that was paused-only, never
/// produced a baseline file. Any other error (typically permission issues or
/// a locked file on Windows) is surfaced via `warn!` because it leaves the
/// stale baseline intact — which is the exact bug the surrounding code is
/// supposed to prevent. Without the log we'd have no way to diagnose a re-add
/// data-loss recurrence in production.
fn clear_persisted_sync_state(account_id: &str, label: &str) {
    let Ok(folder_dir) = config_dir_for_folder(account_id, label) else {
        return;
    };
    for name in ["sync_state.json", "sync_state.json.bak"] {
        let path = folder_dir.join(name);
        if let Err(err) = std::fs::remove_file(&path)
            && err.kind() != std::io::ErrorKind::NotFound
        {
            warn!(
                path = %path.display(),
                error = %err,
                "Failed to clear sync baseline on remove_drive — stale state may survive",
            );
        }
    }
}

/// Pause a sync folder: stop the drive in-memory and mark it as paused in the DB.
/// Unlike `stop_drive`, the DB row is preserved so the folder reappears on restart
/// (but won't auto-sync until resumed).
#[tauri::command]
pub async fn pause_drive(app: AppHandle, label: String) -> Result<()> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    let (remaining, removed_path) = remove_drive_inmemory(sync, &label).await;

    // Wake any waiters in remove_drive_and_wait so they can re-check without
    // sleeping through the full polling interval.
    app_state.drive_removed_notify.notify_waiters();

    // Mark as paused in DB (keep the row, unlike stop_drive which deletes it).
    // Capture pool/account for both the persist call AND the path
    // lookup used by the per-drive status emit below.
    let pool_and_acct = match (app_state.pool(), app_state.current_account_id()) {
        (Ok(pool), Ok(acct)) => Some((pool, acct)),
        _ => None,
    };
    if let Some((pool, acct)) = &pool_and_acct
        && let Err(e) = crate::sync::paths::set_sync_path_paused(pool, acct, &label, true).await
    {
        warn!("Failed to mark '{}' as paused in DB: {e}", label);
    }

    if remaining == 0 {
        teardown_last_drive(sync, &app).await;
    }

    // Resolve the on-disk path so the per-drive status payload carries
    // it (the FE relies on that field to keep its drive entry hydrated
    // — see `useDriveStatuses`). Prefer the path captured by
    // `remove_drive_inmemory`; fall back to a DB lookup when the drive
    // wasn't in the in-memory map (e.g. pausing an already-removed
    // drive after a crash recovery).
    let drive_path = if let Some(path) = removed_path.as_ref() {
        path.to_string_lossy().into_owned()
    } else if let Some((pool, acct)) = &pool_and_acct {
        crate::sync::folders::get_all_sync_paths_internal(pool, acct)
            .await
            .ok()
            .and_then(|paths| paths.into_iter().find(|p| p.label == label).map(|p| p.path))
            .unwrap_or_default()
    } else {
        String::new()
    };

    // Emit a per-drive Paused status so the FE updates this single
    // drive without re-fetching the list. Other drives are unaffected.
    crate::sync::status::emit_drive_status(&app, &label, &drive_path, crate::sync::drive_status::DriveStatus::Paused);

    info!("Paused drive '{}', {} drives remaining", label, remaining);
    Ok(())
}

/// Resume a paused sync folder: clear `is_paused`, re-initialize the
/// drive, and emit a per-drive Active status. The persisted user-stopped
/// flag no longer exists (deleted in the per-drive status migration),
/// so this function only touches `sync_paths.is_paused` and the
/// in-memory drive registry.
#[tauri::command]
pub async fn resume_drive(app: AppHandle, label: String, mnemonic: Option<String>) -> Result<()> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();

    let account_id = app_state.current_account_id()?;
    let pool = app_state.pool()?;

    // Clear the paused flag in the DB before kicking off init. Doing it
    // first means even if init fails the row reflects user intent
    // (Active), so the next auto_init_sync attempt will pick it up.
    crate::sync::paths::set_sync_path_paused(pool, &account_id, &label, false).await?;

    // Re-initialize the drive. `initialize_sync_inner` emits the
    // per-drive Active status on success. On failure, we must emit an
    // `Error` status ourselves — otherwise the `drive_status_cache`
    // retains whatever it held before this click (typically `Paused`
    // or a stale `Error`) while the DB already says `is_paused=false`.
    // The FE would then read a stale entry from `get_all_drive_statuses`
    // on its next mount/bootstrap.
    match initialize_sync_inner(app.clone(), account_id.clone(), label.clone(), mnemonic, true, false).await {
        Ok(_) => {
            info!("Resumed drive '{}'", label);
            Ok(())
        }
        Err(e) => {
            warn!(label = %label, error = %e, "Resume failed");
            if matches!(e, crate::error::AppError::NotReady(_)) {
                // Recoverable precondition (mnemonic unavailable,
                // signing key missing, etc.) — don't emit `Error`,
                // but we MUST prune any lingering cache entry for
                // this label. Otherwise a user who paused this drive
                // earlier in the session would still see the stale
                // `Paused` value in the cache, and `get_all_drive_statuses`
                // would keep rendering the drive as "paused" via the
                // widened `kind !== "active"` check — stuck in a
                // Resume-click loop because the UI never reflects
                // the DB's new `is_paused=false` state. Dropping the
                // cache entry makes the FE fall through to
                // `status_from_is_paused` which returns `Active`,
                // matching the DB intent. The reauth banner at the
                // top of the layout already tells the user what to
                // do to actually finish the resume.
                if let Ok(mut cache) = app_state.drive_status_cache.lock() {
                    cache.remove(&label);
                }
            } else {
                // Non-recoverable: emit `Error` so the FE surfaces a
                // retry affordance and the drive visibly flags the
                // failure.
                let drive_path = crate::sync::folders::get_all_sync_paths_internal(pool, &account_id)
                    .await
                    .ok()
                    .and_then(|paths| paths.into_iter().find(|p| p.label == label).map(|p| p.path))
                    .unwrap_or_default();
                crate::sync::status::emit_drive_status(
                    &app,
                    &label,
                    &drive_path,
                    crate::sync::drive_status::DriveStatus::Error {
                        message: format!("Failed to resume: {e}"),
                    },
                );
            }
            Err(e)
        }
    }
}

/// Reset sync data for an account, clearing all local sync state.
/// This allows starting fresh without corrupted or stale sync data.
///
/// Stop the current drive for a label, set a new sync path, and initialize
/// the drive with the new path — all in one atomic command.
///
/// Replaces the `stop_sync()` → `tryInitializeSync()` chain that was in
/// `UpdateSyncFolder.tsx`.
#[tauri::command]
pub async fn change_sync_folder(
    app: AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    new_path: String,
    label: String,
    mnemonic: Option<String>,
) -> Result<InitSyncResult> {
    let pool = state.pool()?;

    // Tear down the existing drive (fire and forget if it doesn't
    // exist) so we can re-initialize it with the new path.
    let _ = remove_drive(app.clone(), label.clone()).await;

    // Set the new sync path in the DB
    crate::sync::paths::set_sync_path_internal(pool, &account_id, &new_path, false, Some(&label)).await?;

    info!(label = %label, path = %new_path, "Sync folder changed, initializing new drive");

    // Initialize the drive with the new path
    initialize_sync(app, account_id, label, mnemonic).await
}

/// Auto-initialize all configured sync paths on login.
///
/// Replaces the 9-step `tryAutoInitSync()` orchestration that was in
/// TypeScript. All business logic (migration lock, mnemonic persistence,
/// path filtering, HCFS config check, sequential init) lives in Rust.
///
/// In the per-drive status model this is a thin wrapper that delegates
/// to `auto_init_sync_inner`. There is no global engine status to
/// update — each successful per-drive init inside the loop emits its
/// own `DRIVE_STATUS_CHANGED` event with `Active`, and paused paths
/// emit `Paused` (so the FE sees them on cold start).
#[tauri::command]
pub async fn auto_init_sync(
    app: AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    mnemonic: Option<String>,
) -> Result<AutoInitResult> {
    auto_init_sync_inner(app.clone(), &state, account_id, mnemonic).await
}

// =========================================================================
// Auto-init concurrency guard
// =========================================================================

/// Module-level latch that prevents two `auto_init_sync_inner` runs from
/// overlapping. On slow systems the FE retries auto-init after the
/// `hippius_auth_ready` event (see `useHcfsSync.ts::tryAutoInitSync`),
/// so concurrent calls are now an expected condition — the guard makes
/// the race a no-op by having the second caller bail with a skipped
/// reason instead of re-entering the init loop on top of the first.
static AUTO_INIT_IN_PROGRESS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// RAII guard for [`AUTO_INIT_IN_PROGRESS`]. Clears the latch on drop,
/// including early-return and panic paths, so a failed run never leaves
/// the latch stuck.
struct AutoInitGuard;

impl AutoInitGuard {
    fn try_acquire() -> Option<Self> {
        AUTO_INIT_IN_PROGRESS
            .compare_exchange(false, true, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst)
            .ok()
            .map(|_| Self)
    }
}

impl Drop for AutoInitGuard {
    fn drop(&mut self) {
        AUTO_INIT_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Inner body of `auto_init_sync` — returns the same shape as the public
/// command but doesn't touch `sync_status`. The outer wrapper handles all
/// status transitions and the auto-init latch so we can't forget on a new
/// return path.
#[expect(
    clippy::too_many_lines,
    reason = "Linear auto-init pipeline — concurrency guard, migration check, mnemonic persistence, path fetch, scope expansion, HCFS config check, paused emit, mnemonic resolution, credits check, init loop. Splitting fragments the early-return error paths and obscures the ordering constraint between the paused-emit loop and the init loop (FE listener relies on that order)."
)]
async fn auto_init_sync_inner(
    app: AppHandle,
    state: &tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    mnemonic: Option<String>,
) -> Result<AutoInitResult> {
    use std::sync::atomic::Ordering;

    // 0. Concurrency guard. The FE now retries `auto_init_sync` on the
    //    `hippius_auth_ready` event, so overlapping calls are expected
    //    on slow cold starts. Bail early from the second caller instead
    //    of re-entering the init loop on top of the first — the in-
    //    flight run will emit per-drive Active/Error events on its own.
    let Some(_guard) = AutoInitGuard::try_acquire() else {
        debug!("auto_init_sync already in progress — skipping concurrent call");
        return Ok(AutoInitResult {
            any_initialized: false,
            is_configured: true,
            skipped_reason: Some("Auto-init already in progress".into()),
        });
    };

    // 0b. Cross-account leak guard. `tryAutoInitSync` captures the
    //     account_id in its closure and retries after the
    //     `hippius_auth_ready` event. If the user logs out of account A
    //     and logs back in as account B during the retry wait, the
    //     retry fires with A's account_id even though the active
    //     session is now B. Without this check, `auto_init_sync_inner`
    //     would initialize A's drives under B's session via the disk
    //     fallback in `get_mnemonic_for_account` — a cross-account
    //     leak. Compare the FE-supplied account_id against the
    //     currently active one and bail if they differ.
    if let Ok(current) = state.current_account_id()
        && current != account_id
    {
        warn!(
            requested = %account_id,
            current = %current,
            "auto_init_sync called with stale account_id (session changed mid-retry); aborting"
        );
        return Ok(AutoInitResult {
            any_initialized: false,
            is_configured: false,
            skipped_reason: Some("Stale account_id".into()),
        });
    }

    // 1. Block if migration in progress
    if state.migration.in_progress.load(Ordering::SeqCst) {
        return Ok(AutoInitResult {
            any_initialized: false,
            is_configured: false,
            skipped_reason: Some("Migration in progress".into()),
        });
    }

    let pool = state.pool()?;

    // 2. Persist master mnemonic early (no-op if already exists or no config)
    if let Some(ref m) = mnemonic
        && let Ok(password) = get_drive_password(pool, &account_id, Some(m)).await
    {
        let master_path = master_mnemonic_path(&account_id)?;
        let acct_dir = account_dir(&account_id)?;
        if let Err(e) = create_dir_all_async(acct_dir.clone()).await {
            debug!("Early acct dir create skipped in auto_init_sync: {e}");
        }
        if let Err(e) = hcfs_client::auth::save_encrypted_mnemonic(&master_path, m, &password) {
            debug!("Early mnemonic persist skipped: {e}");
        }
    }

    // 3. Get all configured sync paths (with legacy fallback)
    let mut sync_paths = get_all_sync_paths_internal(pool, &account_id).await.unwrap_or_default();
    if sync_paths.is_empty()
        && let Ok(legacy) = get_sync_path_for_label(pool, &account_id, "default").await
    {
        sync_paths.push(crate::sync::paths::SyncPathResult {
            path: legacy,
            is_public: false,
            label: "default".to_string(),
            is_paused: false,
        });
    }

    if sync_paths.is_empty() {
        return Ok(AutoInitResult {
            any_initialized: false,
            is_configured: false,
            skipped_reason: Some("No sync paths configured".into()),
        });
    }

    // 4. Expand asset protocol scope for all paths (non-critical)
    for sp in &sync_paths {
        crate::sync::files::allow_asset_directory(&app, &sp.path);
    }

    // 5. Check HCFS config
    let config = get_hcfs_config_internal(pool, &account_id).await?;
    if !config.has_password {
        return Ok(AutoInitResult {
            any_initialized: false,
            is_configured: false,
            skipped_reason: Some("HCFS config not set up".into()),
        });
    }

    // 6. Filter: exclude the internal "migration" pseudo-drive and any
    //    paths the user has paused. The legacy global `user_stopped`
    //    flag was deleted in the per-drive status migration — paused
    //    state is now per-drive in `sync_paths.is_paused`, which the
    //    Phase 0 migration ensured is correctly populated for any
    //    user upgrading from the old global model.
    let regular: Vec<_> = sync_paths.iter().filter(|sp| sp.label != "migration" && !sp.is_paused).collect();

    // Emit `Paused` for every paused path so the FE sees them on cold
    // start without having to call `get_all_drive_statuses` separately.
    // This pre-populates the per-drive status map before the init loop
    // below starts emitting `Active` for the regular paths.
    //
    // IMPORTANT: this loop must run BEFORE the init loop below. The
    // FE's `driveStatusesAtom` listener relies on Paused arriving
    // first so per-folder UI doesn't briefly flash "Active" for
    // paused drives while their entries are still missing from the
    // map. Reordering these two loops is a behavior change.
    for sp in sync_paths.iter().filter(|sp| sp.label != "migration" && sp.is_paused) {
        crate::sync::status::emit_drive_status(&app, &sp.label, &sp.path, crate::sync::drive_status::DriveStatus::Paused);
    }

    info!(total = sync_paths.len(), active = regular.len(), "Auto-initializing sync paths");

    // 7. Resolve the mnemonic exactly once — BEFORE the init loop — and
    //    pass it explicitly to every `initialize_sync_inner` call below.
    //
    //    This bypasses the `AppState.auth.lock()` fallback inside
    //    `initialize_sync_inner`, which on slow-system cold starts could
    //    read `AuthInfo.mnemonic == None` if `rehydrate_full_session`
    //    hadn't yet populated it. `get_mnemonic_for_account` has a
    //    5-stage fallback chain (in-memory cache → encrypted master on
    //    disk → live drive export → DB row) that is robust to that
    //    ordering.
    //
    //    On failure, emit `DriveStatus::Error` for every regular drive
    //    so the FE can render a retry affordance. The FE will retry
    //    `auto_init_sync` on the next `hippius_auth_ready` event, which
    //    fires after `rehydrate_full_session` finishes writing the
    //    mnemonic.
    let resolved_mnemonic: zeroize::Zeroizing<String> = match mnemonic.clone() {
        Some(m) => zeroize::Zeroizing::new(m),
        None => match crate::sync::mnemonic::get_mnemonic_for_account(state.inner(), &account_id).await {
            Ok(m) => m,
            Err(e) => {
                // `NotReady(MasterMnemonicUnrecoverable)` is a recoverable
                // precondition, not a drive failure. The FE's retry
                // ladder in `useHcfsSync.ts::tryAutoInitSync` listens on
                // `hippius_auth_ready` and re-invokes this command when
                // auth state lands. Emitting `DriveStatus::Error` here
                // would poison the per-drive cache and cause every drive
                // to render as "paused" via the widened FE check
                // (`kind !== "active"`) for the entire retry window —
                // and forever if the user's keychain doesn't have the
                // mnemonic (which is the common Restored-capability
                // session-restore path). Instead, leave the drives in
                // their bootstrap-Active state and let the retry handle
                // recovery.
                if matches!(e, crate::error::AppError::NotReady(_)) {
                    warn!(
                        error = %e,
                        "auto_init_sync: mnemonic not ready yet — FE will retry on hippius_auth_ready. No Error status emitted."
                    );
                } else {
                    warn!(
                        error = %e,
                        "auto_init_sync: mnemonic resolution failed with non-recoverable error; emitting Error for all regular drives."
                    );
                    let msg = format!("Failed to resolve mnemonic: {e}");
                    for sp in &regular {
                        crate::sync::status::emit_drive_status(
                            &app,
                            &sp.label,
                            &sp.path,
                            crate::sync::drive_status::DriveStatus::Error { message: msg.clone() },
                        );
                    }
                }
                return Err(e);
            }
        },
    };

    // 8. Check credits once before the drive loop — balance doesn't change
    // between drives, so a single HTTP round-trip is sufficient.  If the
    // check fails we return early; individual `initialize_sync_inner` calls
    // below will skip the check via `skip_credits_check = true`.
    if let Ok(acct) = state.current_account_id() {
        let pool_owned = state.pool()?.clone();
        let client = crate::api::client::ApiClient::new(state.api_client.clone(), pool_owned);
        if let Ok(resp) = client
            .get::<crate::billing::credits::CreditBalanceResponse>("/api/billing/credits/balance/", &acct)
            .await
        {
            let balance: f64 = resp.balance.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            if balance <= 0.0 {
                return Err(crate::error::AppError::Validation(
                    "Insufficient credits. Please add credits to your account before syncing.".into(),
                ));
            }
        }
    }

    // 9. Initialize each path with the pre-resolved mnemonic. Passing
    //    `Some(..)` guarantees every drive takes the `existing_mnemonic`
    //    branch of `initialize_sync_inner` and never touches the auth
    //    lock fallback — fan-out is fully deterministic even if the
    //    auth state churns underneath it.
    //
    //    Initialization is fanned out concurrently with `join_all`. Each
    //    `initialize_sync_inner` call does multiple DB hits + HCFS probe
    //    + drive unlock + folder registration — for N drives the
    //    sequential cost is sum(N), the concurrent cost is max(N). The
    //    per-drive locks owned by `SyncRunner.drives` already isolate
    //    the work; the shared resources (DB pool, reqwest client,
    //    HCFS server) all support concurrent callers.
    let init_futures = regular.iter().map(|sp| {
        let app = app.clone();
        let account_id = account_id.clone();
        let label = sp.label.clone();
        let mnemonic = resolved_mnemonic.as_str().to_owned();
        async move {
            let result = initialize_sync_inner(app, account_id, label.clone(), Some(mnemonic), true, true).await;
            (label, result)
        }
    });
    let init_results = futures_util::future::join_all(init_futures).await;

    // `join_all` preserves input order, so each `init_results[i]` aligns
    // with `regular[i]`. The zip below re-pairs every result with its
    // sync_path so the path-aware `DriveStatus::Error` emit on failure
    // can read the right `sp.path`.
    let mut any_initialized = false;
    for ((label, result), sp) in init_results.into_iter().zip(regular.iter()) {
        match result {
            Ok(r) => {
                info!(label = %label, user_id = %r.user_id, "Sync initialized");
                any_initialized = true;
            }
            Err(e) => {
                warn!(label = %label, error = %e, "Failed to init sync");
                // Only emit `Error` for non-recoverable failures.
                // `NotReady(*)` errors (mnemonic unavailable, signing
                // key missing, config missing, etc.) have their own
                // retry paths via the FE auth-ready listener or
                // user-initiated resume — leave the drive in its
                // bootstrap-Active state so the FE doesn't render it
                // as "paused" via the widened `kind !== "active"`
                // check while the retry is in flight.
                if !matches!(e, crate::error::AppError::NotReady(_)) {
                    crate::sync::status::emit_drive_status(
                        &app,
                        &sp.label,
                        &sp.path,
                        crate::sync::drive_status::DriveStatus::Error {
                            message: format!("Failed to initialize: {e}"),
                        },
                    );
                }
            }
        }
    }

    Ok(AutoInitResult {
        any_initialized,
        is_configured: true,
        skipped_reason: None,
    })
}

// =========================================================================
// Progress handler setup
// =========================================================================

/// Direction of a file transfer for progress callbacks.
enum TransferDirection {
    Upload,
    Download,
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
/// [`crate::sync::progress::update_file_progress`]. The previous separate
/// `hcfs_upload_progress` / `hcfs_download_progress` Tauri events were
/// removed after verifying (via grep of `app/`) that zero frontend code
/// listened to them — they were firing on every chunk for no consumer.
fn handle_transfer_progress(ctx: &TransferContext, bytes: u64, total: u64, path: Option<&str>) {
    ctx.sync.touch_progress_time();
    let (dir_name, file_action) = match ctx.direction {
        TransferDirection::Upload => ("Upload", crate::sync::progress::FileAction::Upload),
        TransferDirection::Download => ("Download", crate::sync::progress::FileAction::Download),
    };

    if let Some(path_str) = path {
        let file_name = Path::new(path_str).file_name().and_then(|n| n.to_str()).unwrap_or(path_str);
        // Log the first chunk of each transfer. Using bytes == 0 avoids
        // the old started_set Mutex that was contended on every chunk.
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
            // 2xx). See docs/plans/2026-05-13-sync-402-data-integrity.md.
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

/// Build the `on_sync_plan_ready` callback that merges the sync plan into the
/// progress session and emits the `SYNC_PLAN_READY` event.
fn build_plan_ready_callback(app: &AppHandle, label: Arc<str>, sync: &Arc<SyncRunner>) -> hcfs_client::sync::SyncPlanReadyFn {
    let app = app.clone();
    let sync = sync.clone();
    Arc::new(move |uploads, downloads, local_deletes, remote_deletes, renames| {
        sync.touch_progress_time();
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

        // Patch file sizes directly from plan items — eliminates the
        // intermediate HashMap that previously cloned every path string.
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
    sync: Arc<SyncRunner>,
    label: Arc<str>,
    action: crate::sync::progress::FileAction,
    direction_name: &'static str,
) -> hcfs_client::sync::SyncProgressFn {
    Arc::new(move |b, t, p| {
        sync.touch_progress_time();
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

/// Build the `on_scan_progress` callback that logs scan progress and
/// emits the `SCAN_PROGRESS` Tauri event.
fn build_scan_callback(sync: Arc<SyncRunner>, app: AppHandle, label: Arc<str>) -> hcfs_client::sync::ScanProgressFn {
    Arc::new(move |n, p| {
        sync.touch_progress_time();
        info!("Scan [{label}]: {n} files scanned, current: {p:?}");
        let _ = app.emit(
            crate::sync::events::SCAN_PROGRESS,
            crate::sync::events::ScanProgressPayload {
                label: label.to_string(),
                scanned: n,
                path: p.map(std::string::ToString::to_string),
            },
        );
    })
}

/// Build the `on_fetch_state_progress` callback that logs fetch state
/// progress and emits the `FETCH_PROGRESS` Tauri event.
fn build_fetch_callback(sync: Arc<SyncRunner>, app: AppHandle, label: Arc<str>) -> hcfs_client::sync::FetchProgressFn {
    Arc::new(move |f, t| {
        sync.touch_progress_time();
        info!("Fetch state [{label}]: {f}/{t} entries");
        let _ = app.emit(
            crate::sync::events::FETCH_PROGRESS,
            crate::sync::events::FetchProgressPayload {
                label: label.to_string(),
                fetched: f,
                total: t,
            },
        );
    })
}

/// Build the `on_file_synced` callback that logs per-file completion,
/// updates the synced-paths cache, AND transitions the file's progress
/// status to `Completed` so the sync widget reflects the file as done as
/// soon as its individual AEAD verification has succeeded — instead of
/// waiting for the entire sync cycle to finish. See
/// [`crate::sync::progress::mark_file_synced`] for the full reasoning.
pub fn build_file_synced_callback(sync: Arc<SyncRunner>, label: Arc<str>) -> hcfs_client::sync::FileSyncedFn {
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
        //
        // The enqueue ran inside the byte-progress completion-tick
        // before fix `2026-05-13-sync-402-data-integrity`. That site
        // fires when the local TCP socket has drained, so a 402 /
        // 5xx-rejected upload would still appear as "Uploaded" in the
        // activity log. See docs/plans/2026-05-13-sync-402-data-integrity.md.
        //
        // Action mapping: hcfs-client passes `action` as one of
        // `"uploaded"` / `"downloaded"` / `"deleted"` / `"conflict"`
        // (mirroring `SyncActivityAction::as_str()`). Unknown values
        // produce `None`, which skips the activity enqueue entirely —
        // recording nothing is the truthful choice when we don't know
        // how to categorize the event. Fabricating an `Uploaded` row
        // for a future hcfs-client variant (e.g. Phase 2's `"failed"`)
        // is the exact category of lie this task exists to eliminate.
        //
        // `size_bytes` comes from `mark_file_synced`'s return value —
        // the in-memory progress tracker's `file.total_bytes` read
        // before the row transitions to Completed. The Recent-Files
        // view (`get_recent_files` in `sync/files.rs`) reads
        // `item.size_bytes` directly, so without this thread-through
        // every newly-synced file would render with size 0 / "unknown".
        // The byte-progress callback used to supply the size; we no
        // longer trust it for activity rows (see the 402 plan), so the
        // progress tracker is the authoritative source. The 0 fallback
        // covers the documented edge cases of `mark_file_synced` —
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

        // Best-effort display string for the snapshot row's `error` field.
        // The frontend already discriminates failure CATEGORY via the
        // separate `hcfs_file_failed` Tauri event (typed
        // `FileFailureKindPayload`); this string is only used as a
        // tooltip/details fallback in the file list, so a `Debug` render
        // is acceptable.
        let error_msg = format!("{kind:?}");
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
            sync.clone(),
            Arc::clone(&label),
            crate::sync::progress::FileAction::Encrypt,
            "Encrypt",
        )),
        on_decrypt_progress: Some(build_crypto_callback(
            sync.clone(),
            Arc::clone(&label),
            crate::sync::progress::FileAction::Decrypt,
            "Decrypt",
        )),
        on_scan_progress: Some(build_scan_callback(sync.clone(), app.clone(), Arc::clone(&label))),
        on_fetch_state_progress: Some(build_fetch_callback(sync.clone(), app.clone(), Arc::clone(&label))),
        on_file_synced: Some(build_file_synced_callback(sync.clone(), Arc::clone(&label))),
        // Phase 2 / Task 2.7: per-file failure callback fired synchronously
        // by hcfs-client at the error site. We mutate the in-memory
        // progress tracker here; the bridge's `SyncEvent::FileFailed` arm
        // is the user-visible side (Tauri event emit).
        on_file_failed: Some(build_file_failed_callback(sync.clone(), Arc::clone(&label))),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    // ── TransferDirection ───────────────────────────────────────────

    #[test]
    fn transfer_direction_upload_produces_correct_strings() {
        let dir = TransferDirection::Upload;
        let (name, action) = match dir {
            TransferDirection::Upload => ("Upload", crate::sync::progress::FileAction::Upload),
            TransferDirection::Download => ("Download", crate::sync::progress::FileAction::Download),
        };
        assert_eq!(name, "Upload");
        assert_eq!(action, crate::sync::progress::FileAction::Upload);
    }

    #[test]
    fn transfer_direction_download_produces_correct_strings() {
        let dir = TransferDirection::Download;
        let (name, action) = match dir {
            TransferDirection::Upload => ("Upload", crate::sync::progress::FileAction::Upload),
            TransferDirection::Download => ("Download", crate::sync::progress::FileAction::Download),
        };
        assert_eq!(name, "Download");
        assert_eq!(action, crate::sync::progress::FileAction::Download);
    }

    #[tokio::test]
    async fn create_dir_all_async_creates_nested_directories() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let target = tmp.path().join("a/b/c/d");
        assert!(!target.exists());

        create_dir_all_async(target.clone()).await.expect("create");

        assert!(target.exists(), "nested dirs should be created");
        assert!(target.is_dir(), "leaf should be a directory");
    }

    #[tokio::test]
    async fn create_dir_all_async_is_idempotent() {
        // create_dir_all should succeed even if the dir already exists.
        // Documents the contract: callers don't need to guard with .exists().
        let tmp = tempfile::tempdir().expect("tempdir");
        let target = tmp.path().join("existing");
        std::fs::create_dir_all(&target).expect("pre-create");

        create_dir_all_async(target.clone()).await.expect("should succeed on existing dir");

        assert!(target.exists());
    }

    // ── Teardown helper tests ───────────────────────────────────────────

    /// Build a minimal `SyncRunner` suitable for unit tests that only
    /// exercise `loop_handle` / teardown logic (no real drives or watcher).
    fn test_sync_runner() -> Arc<SyncRunner> {
        use hcfs_client::engine::{NoopCallbacks, NoopEventHandler};
        Arc::new(SyncRunner::new(
            Arc::new(NoopEventHandler),
            Arc::new(NoopCallbacks),
            reqwest::Client::new(),
        ))
    }

    #[tokio::test]
    async fn wait_for_sync_loop_exit_returns_true_when_no_handle() {
        // When loop_handle is None (no loop running), should return true immediately.
        let sync = test_sync_runner();
        assert!(wait_for_sync_loop_exit(&sync, Duration::from_millis(100)).await);
    }

    #[tokio::test]
    async fn wait_for_sync_loop_exit_returns_true_on_clean_exit() {
        // When the loop task completes within the grace window, returns true.
        let sync = test_sync_runner();
        let handle = tokio::spawn(async { /* exits immediately */ });
        *sync.loop_handle.lock().await = Some(handle);
        assert!(wait_for_sync_loop_exit(&sync, Duration::from_millis(100)).await);
        // Handle should be consumed (taken)
        assert!(sync.loop_handle.lock().await.is_none());
    }

    #[tokio::test]
    async fn wait_for_sync_loop_exit_returns_false_on_timeout_and_restores_handle() {
        // When the loop task doesn't exit within grace, returns false and restores handle.
        let sync = test_sync_runner();
        let handle = tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(10)).await;
        });
        *sync.loop_handle.lock().await = Some(handle);
        assert!(!wait_for_sync_loop_exit(&sync, Duration::from_millis(50)).await);
        // Handle should be restored so abort_sync_loop can consume it
        assert!(sync.loop_handle.lock().await.is_some());
    }

    #[tokio::test]
    async fn abort_sync_loop_terminates_restored_handle() {
        // After wait_for_sync_loop_exit restores the handle on timeout,
        // abort_sync_loop should consume and abort it.
        let sync = test_sync_runner();
        let handle = tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(10)).await;
        });
        *sync.loop_handle.lock().await = Some(handle);
        // Grace window expires
        assert!(!wait_for_sync_loop_exit(&sync, Duration::from_millis(50)).await);
        // Now abort
        abort_sync_loop(&sync).await;
        assert!(sync.loop_handle.lock().await.is_none());
    }

    // ── remove_drive_inmemory tests ────────────────────────────────────

    #[tokio::test]
    async fn remove_drive_inmemory_cleans_up_registered_drive() {
        let sync = test_sync_runner();
        let label = "test-drive";

        let tmp = tempfile::tempdir().expect("tempdir");
        let sync_path = tmp.path().join("sync");
        let config_dir = tmp.path().join("config");
        std::fs::create_dir_all(&sync_path).expect("create sync dir");
        std::fs::create_dir_all(&config_dir).expect("create config dir");

        // Insert a drive slot with a real DriveManager.
        {
            let manager = DriveManager::new(sync_path.clone(), config_dir);
            let token = CancellationToken::new();
            let mut guard = sync.drives.lock().await;
            guard.insert(
                label.to_string(),
                DriveSlot {
                    manager: Arc::new(TokioMutex::new(manager)),
                    cancel_token: token,
                },
            );
        }

        // Seed ancillary state so removal has something to clean up.
        sync.register_label_root(label.to_string(), sync_path.clone());

        // Pre-conditions: drive and label root exist.
        assert!(sync.drives.lock().await.contains_key(label));

        let (remaining, removed_path) = remove_drive_inmemory(&sync, label).await;

        assert_eq!(remaining, 0, "map should be empty after removing the only drive");
        assert_eq!(
            removed_path.as_deref(),
            Some(sync_path.as_path()),
            "should return the sync path of the removed drive"
        );
        assert!(!sync.drives.lock().await.contains_key(label), "drive should no longer be in the map");
    }

    /// Regression test for fix 3 in the date-uploaded readiness PR.
    ///
    /// `remove_drive_inmemory` used to leave two per-label side maps
    /// untouched on each remove/re-add cycle: the synced-paths
    /// timestamp cache and the first-reconcile gate registry. Both
    /// leaks were silent (no functional bug surfaced) but they
    /// accumulated per label until process exit AND they could
    /// briefly surface stale upload dates after a remove-then-re-add
    /// because the cache entry survived. This test pins the cleanup.
    #[tokio::test]
    async fn remove_drive_inmemory_clears_synced_paths_cache_and_first_reconcile_gate() {
        use hcfs_client::engine::types::SyncedFileInfo;
        use std::collections::HashMap;
        use std::sync::Arc;

        let sync = test_sync_runner();
        let label = "leak-test";

        // Seed both side maps directly — `remove_drive_inmemory`
        // doesn't depend on the drive actually being registered for
        // the cleanup invariant to hold, and seeding lets the test
        // stay focused on the cleanup itself.
        sync.update_synced_paths_cache(
            label,
            HashMap::from([(
                "file.txt".to_string(),
                SyncedFileInfo {
                    path_hash: [0u8; 32],
                    arion_cid: Arc::from("cid-1"),
                    uploaded_at: 1_700_000_000,
                    updated_at: 1_700_000_100,
                },
            )]),
        );
        // Register the gate via the public API so we exercise the
        // production code path that `register_drive` uses.
        let _ = sync.first_reconcile_gate(label);

        // Pre-conditions: both side maps have an entry for the label.
        assert!(
            sync.get_cached_synced_paths(label).is_some(),
            "synced_paths_cache should have a pre-removal entry"
        );
        assert!(
            sync.first_reconcile.lock().expect("lock").contains_key(label),
            "first_reconcile gate map should have a pre-removal entry"
        );

        let _ = remove_drive_inmemory(&sync, label).await;

        assert!(
            sync.get_cached_synced_paths(label).is_none(),
            "synced_paths_cache must be cleared by remove_drive_inmemory"
        );
        assert!(
            !sync.first_reconcile.lock().expect("lock").contains_key(label),
            "first_reconcile gate map must be cleared by remove_drive_inmemory"
        );
    }

    #[tokio::test]
    async fn remove_drive_inmemory_cancels_token() {
        let sync = test_sync_runner();
        let label = "cancel-me";

        let tmp = tempfile::tempdir().expect("tempdir");
        let sync_path = tmp.path().join("sync");
        let config_dir = tmp.path().join("config");
        std::fs::create_dir_all(&sync_path).expect("create sync dir");
        std::fs::create_dir_all(&config_dir).expect("create config dir");

        let token = CancellationToken::new();
        let token_clone = token.clone();

        {
            let manager = DriveManager::new(sync_path.clone(), config_dir);
            let mut guard = sync.drives.lock().await;
            guard.insert(
                label.to_string(),
                DriveSlot {
                    manager: Arc::new(TokioMutex::new(manager)),
                    cancel_token: token,
                },
            );
        }

        assert!(!token_clone.is_cancelled(), "token should not be cancelled before removal");

        let _ = remove_drive_inmemory(&sync, label).await;

        assert!(token_clone.is_cancelled(), "token should be cancelled after removal");
    }

    #[tokio::test]
    async fn remove_drive_inmemory_returns_none_for_nonexistent_label() {
        let sync = test_sync_runner();

        let (remaining, removed_path) = remove_drive_inmemory(&sync, "nonexistent").await;

        assert_eq!(remaining, 0, "empty map has zero remaining");
        assert!(removed_path.is_none(), "nonexistent label should yield None path");
    }

    // ── clear_persisted_sync_state: data-loss regression ──────────────
    //
    // Without this cleanup, the sequence
    //   1. delete_remote_folder (wipes server, leaves local files)
    //   2. add_local_sync_folder for the same path
    // produces an empty `state.remote` paired with a stale `state.synced`,
    // which `SyncPlan::build` interprets as "the server side deleted these
    // files" → emits `local_deletes` → the user's local files are nuked
    // on the next sync cycle. Clearing the on-disk baseline on remove
    // forces a fresh start so the next sync uploads instead of deleting.

    #[test]
    fn clear_persisted_sync_state_removes_baseline_files() {
        let _home_guard = crate::test_helpers::HOME_LOCK.lock().unwrap();
        let tmp = tempfile::TempDir::new().unwrap();
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }

        let account = "5TestClearStateAccount";
        let label = "to-be-removed";

        let folder_dir = config_dir_for_folder(account, label).expect("folder_dir");
        std::fs::create_dir_all(&folder_dir).unwrap();
        let state_path = folder_dir.join("sync_state.json");
        let backup_path = folder_dir.join("sync_state.json.bak");
        std::fs::write(&state_path, br#"{"local":{},"remote":{},"synced":{}}"#).unwrap();
        std::fs::write(&backup_path, br#"{"local":{},"remote":{},"synced":{}}"#).unwrap();

        clear_persisted_sync_state(account, label);

        assert!(!state_path.exists(), "sync_state.json must be removed");
        assert!(!backup_path.exists(), "sync_state.json.bak must be removed");
    }

    #[test]
    fn clear_persisted_sync_state_tolerates_missing_files() {
        let _home_guard = crate::test_helpers::HOME_LOCK.lock().unwrap();
        let tmp = tempfile::TempDir::new().unwrap();
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }

        // Documents the "best-effort" contract: removing a drive that never
        // wrote any state (immediate cancel before first sync, or a label
        // that was paused-only) must not panic or surface an error.
        clear_persisted_sync_state("5NoSuchAccount", "label-that-never-synced");
    }

    // ── build_file_synced_callback timestamp plumbing ──────────────────
    //
    // These tests pin the contract the hcfs-client timestamp fix relies
    // on: when the server response includes authoritative timestamps,
    // they reach `synced_paths_cache` immediately (so the Files page
    // "DATE UPLOADED" column renders non-zero); when the response is
    // legacy (no timestamps), a previously-reconciled entry survives
    // via `upsert_synced_path`'s zero-guard.

    fn make_timestamps(c: i64, u: i64) -> hcfs_client::sync::FileTimestamps {
        hcfs_client::sync::FileTimestamps {
            created_at: c,
            updated_at: u,
        }
    }

    #[tokio::test]
    async fn build_file_synced_callback_writes_timestamps_to_cache() {
        let sync = test_sync_runner();
        let label: Arc<str> = Arc::from("test-drive");
        let callback = build_file_synced_callback(sync.clone(), Arc::clone(&label));

        // 32-byte hash keyed by 'a' so the hex decode succeeds.
        let fid = [0xAAu8; 32];
        let fid_hex = hex::encode(fid);
        let ts = make_timestamps(1_700_000_000, 1_700_000_100);

        callback("folder/file.txt", &fid_hex, "cid-1", "uploaded", Some(&ts));

        let cache = sync.get_cached_synced_paths(&label).expect("cache should have an entry for the label");
        let info = cache.get("folder/file.txt").expect("rel path should be present in cache");
        assert_eq!(info.uploaded_at, 1_700_000_000);
        assert_eq!(info.updated_at, 1_700_000_100);
        assert_eq!(&*info.arion_cid, "cid-1");
    }

    #[tokio::test]
    async fn build_file_synced_callback_preserves_prior_timestamps_when_none() {
        let sync = test_sync_runner();
        let label: Arc<str> = Arc::from("legacy-drive");

        // Seed the cache as if a reconcile had already populated good
        // timestamps for this rel_path. The legacy-server callback
        // below must NOT clobber these with zeros.
        let fid = [0xBBu8; 32];
        let mut prior: std::collections::HashMap<String, SyncedFileInfo> = std::collections::HashMap::new();
        prior.insert(
            "doc.txt".to_string(),
            SyncedFileInfo {
                path_hash: fid,
                arion_cid: Arc::from("cid-old"),
                uploaded_at: 1_600_000_000,
                updated_at: 1_600_000_100,
            },
        );
        sync.update_synced_paths_cache(&label, prior);

        let callback = build_file_synced_callback(sync.clone(), Arc::clone(&label));
        // Same file re-uploaded against a legacy server that omits
        // timestamps — callback receives `None`.
        callback("doc.txt", &hex::encode(fid), "cid-new", "uploaded", None);

        let cache = sync.get_cached_synced_paths(&label).expect("cache entry");
        let info = cache.get("doc.txt").expect("rel path");
        assert_eq!(info.uploaded_at, 1_600_000_000, "legacy callback must not clobber reconciled timestamps");
        assert_eq!(info.updated_at, 1_600_000_100);
        // arion_cid should still update (reflects the latest upload).
        assert_eq!(&*info.arion_cid, "cid-new");
    }

    #[tokio::test]
    async fn build_file_synced_callback_inserts_fresh_entry_without_timestamps() {
        // Legacy-server path for a file that has no prior cache entry:
        // the entry is still inserted (so sync_status flips to "synced"),
        // just with zero timestamps. Reconcile will backfill them.
        let sync = test_sync_runner();
        let label: Arc<str> = Arc::from("fresh-legacy-drive");
        let callback = build_file_synced_callback(sync.clone(), Arc::clone(&label));

        let fid = [0xCCu8; 32];
        callback("new.txt", &hex::encode(fid), "cid-a", "uploaded", None);

        let info = sync
            .get_cached_synced_paths(&label)
            .unwrap()
            .remove("new.txt")
            .expect("legacy-server upload should still create a cache entry");
        assert_eq!(info.uploaded_at, 0);
        assert_eq!(info.updated_at, 0);
        assert_eq!(&*info.arion_cid, "cid-a");
    }

    #[tokio::test]
    async fn build_file_synced_callback_ignores_empty_rel_path() {
        // Empty rel_path is the early-exit guard — don't touch the cache.
        let sync = test_sync_runner();
        let label: Arc<str> = Arc::from("guard-drive");
        let callback = build_file_synced_callback(sync.clone(), Arc::clone(&label));

        let fid = [0xDDu8; 32];
        let ts = make_timestamps(123, 456);
        callback("", &hex::encode(fid), "cid-x", "uploaded", Some(&ts));

        assert!(
            sync.get_cached_synced_paths(&label).is_none(),
            "empty rel_path must not create a cache entry"
        );
    }
}
