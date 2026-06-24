//! Sync lifecycle: init, stop, pause, resume, auto-init, change folder,
//! progress handler setup, and all supporting private helpers.

use notify::Watcher;
use serde::Serialize;
use tracing::{debug, error, info, warn};

use crate::auth::tokens::get_api_token;
use crate::error::Result;
use crate::sync::config::{
    build_hcfs_config, get_drive_password, get_hcfs_config_internal, get_sync_path_for_label, health_probe_url, load_sync_config,
    save_hcfs_config_internal,
};
use crate::sync::device::get_device_name_internal;
use crate::sync::folders::{get_all_sync_paths_internal, sanitize_label};
use crate::sync::mnemonic::{account_dir, config_dir_for_folder, derive_folder_mnemonic, ensure_derived_mnemonic, folder_hash, master_mnemonic_path};
use hcfs_client::engine::manager::DriveManager;
use hcfs_client::engine::runner::{DriveSlot, SyncRunner};
use hcfs_client::engine::types::build_synced_paths_from_state;
use sqlx::sqlite::SqlitePool;
use std::error::Error as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as TokioMutex;
use tokio_util::sync::CancellationToken;

mod callbacks;
pub use callbacks::build_file_synced_callback;
pub(crate) use callbacks::setup_progress_handlers;

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
    let account_id = state.require_session_account(&account_id)?;
    let pool = state.pool()?;

    // Enforce credit eligibility at the IPC boundary before any upload starts
    // (audit M-4 — parity with `add_local_sync_folder`; this path previously
    // relied only on `initialize_sync_inner`'s documented fail-open pre-init
    // balance check). Price by the recursive byte sum of the label's configured
    // folder when one is set, else fall back to the static FolderSync threshold.
    let bytes = match crate::sync::config::get_sync_path_for_label(pool, &account_id, &label).await {
        Ok(p) if !p.is_empty() => crate::sync::files::sum_regular_file_bytes(std::path::Path::new(&p)).await,
        _ => 0,
    };
    crate::billing::eligibility::require_eligible(
        &state,
        &account_id,
        crate::billing::eligibility::InsufficientCreditsAction::FolderSync,
        bytes,
    )
    .await?;

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
    initialize_sync_inner(app, account_id, label, mnemonic, true, false, None).await
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
    let account_id = state.require_session_account(&account_id)?;
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

    // Allocate a unique label AND persist the path atomically: the suffixing
    // happens inside set_sync_path_internal's `BEGIN IMMEDIATE` transaction, so
    // two concurrent adds of same-basename folders can't both compute the same
    // label and have the second silently overwrite the first drive's path (F-1).
    // Returns the label actually written (e.g. `tags-2` on a basename clash).
    let label = crate::sync::paths::set_sync_path_internal(pool, &account_id, &path, false, crate::sync::paths::LabelMode::Allocate { base: &folder_name }).await?;

    // Initialize sync for this drive (start_loop = true)
    initialize_sync_inner(app, account_id, label.clone(), mnemonic, true, false, None).await?;

    info!(label = %label, path = %path, "Local sync folder added");
    Ok(label)
}

/// a unique `user_id` on the server. This keeps folder namespaces isolated:
/// switching folders won't download files from the previous folder.
#[tauri::command]
pub async fn initialize_sync(app: tauri::AppHandle, account_id: String, label: String, existing_mnemonic: Option<String>) -> Result<InitSyncResult> {
    // FE entry that flows account_id into the secret-using inner; authorize
    // against the session. (Also reached from complete_migration_transition,
    // itself guarded, with the session account — the re-check is idempotent.)
    let account_id = {
        use tauri::Manager;
        app.state::<crate::app_state::AppState>().require_session_account(&account_id)?
    };
    initialize_sync_inner(app, account_id, label, existing_mnemonic, true, false, None).await
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
    } // release the tokio drives Mutex BEFORE the std::sync::Mutex calls below

    // discard_pending_activity_for_label and remove_state lock std::sync::Mutex
    // fields; holding the tokio drives guard across them risked stalling the
    // executor thread under contention (axiom rust_quality_74). The tokio guard
    // is dropped first now.
    sync.discard_pending_activity_for_label(label);
    sync.remove_state(label);
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

/// Max time `remove_drive` waits for an in-flight sync cycle to release the
/// per-drive manager lock before wiping the on-disk baseline. The cycle's
/// cancel token is already tripped, so it exits promptly; this is the
/// best-effort ceiling for a cycle mid-transfer (the cancel aborts the
/// transfer, then it saves partial state and releases). On timeout the wipe
/// proceeds anyway — a surviving stale baseline is the pre-fix state, not a
/// regression.
const GRACEFUL_DRIVE_SHUTDOWN: std::time::Duration = std::time::Duration::from_secs(5);

/// Block (bounded) until the in-flight holder of a per-drive manager lock
/// releases it. The sync cycle holds this lock across its cancel-path
/// `save_sync_state`, so any caller that then mutates the on-disk baseline
/// MUST drain it first — otherwise a late save re-creates the file the caller
/// just deleted (the `remove_drive` data-loss window). Returns `true` once the
/// lock drained, `false` on timeout. Generic over the guarded type so the
/// ordering is unit-testable without constructing a `DriveManager`.
async fn drain_drive_lock<T>(manager: Option<&Arc<TokioMutex<T>>>, timeout: std::time::Duration) -> bool {
    match manager {
        Some(m) => tokio::time::timeout(timeout, m.lock()).await.is_ok(),
        None => true,
    }
}

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

/// Best-effort lookup of a label's on-disk sync path from the `sync_paths` DB
/// row. Used as the `path_hint` for [`remove_drive_inmemory`] so the file
/// watcher can be unwatched even when the per-drive lock is momentarily held.
async fn sync_path_for_label(app_state: &crate::app_state::AppState, account: &str, label: &str) -> Option<PathBuf> {
    let pool = app_state.pool().ok()?;
    crate::sync::folders::get_all_sync_paths_internal(pool, account)
        .await
        .ok()?
        .into_iter()
        .find(|p| p.label == label)
        .map(|p| PathBuf::from(p.path))
}

/// Remove a drive from the in-memory registry: cancel its token, unwatch
/// its path, and discard associated state. Returns `(remaining_count, removed_path)`.
/// Does NOT touch the database — the caller decides whether to delete or
/// mark-paused the DB row. `path_hint` is the DB-resolved sync path used when
/// the in-memory read can't get it (see below).
async fn remove_drive_inmemory(sync: &SyncRunner, label: &str, path_hint: Option<PathBuf>) -> (usize, Option<PathBuf>) {
    let (remaining, removed_path) = {
        let mut guard = sync.drives.lock().await;
        // Read the sync path for the unwatch below. `try_lock` returns None when
        // an in-flight reconcile holds the per-drive lock across its HTTP await;
        // fall back to the caller-supplied DB path so the watcher is still
        // unwatched — otherwise the OS watch leaks until app restart.
        let path = guard
            .get(label)
            .and_then(|slot| slot.manager.try_lock().ok().map(|m| m.sync_path().to_path_buf()))
            .or(path_hint);
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
                // Lock-free path for the watcher enumeration (hcfs-client
                // `collect_drive_paths`); equals `manager.sync_path()`.
                sync_path: PathBuf::from(sync_path),
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
                    // Carry the drive label (F35) so the FE scopes its
                    // metadata-stale clear to this drive instead of every drive.
                    let _ = app.emit(
                        crate::sync::events::ACTIVITY_UPDATED,
                        crate::sync::events::LabelPayload { label: label.clone() },
                    );
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
///
/// Best-effort diagnostic only — its result gates nothing; the real sync uses
/// hcfs-client's region-resolved requests. In region auto-detect mode there is
/// no single endpoint to probe, so the probe is skipped rather than building an
/// invalid relative URL (see [`health_probe_url`]).
async fn check_init_server_health(client: &reqwest::Client, server_url: &str) {
    let Some(test_url) = health_probe_url(server_url) else {
        debug!("Skipping init connectivity probe — drive uses region auto-detect");
        return;
    };
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
///
/// `lifecycle_snapshot` is the drive-lifecycle epoch this init commits
/// against. Callers that pre-clear `is_paused` under the label's commit
/// lock (`resume_drive`) MUST pass the snapshot captured inside that
/// locked block — a pause that fully completes between their critical
/// section and this function's entry then still supersedes the init.
/// All other callers pass `None` and the snapshot is taken here.
#[expect(clippy::too_many_lines, reason = "sequential drive-init steps read better inline than split across helpers")]
pub(crate) async fn initialize_sync_inner(
    app: tauri::AppHandle,
    account_id: String,
    label: String,
    existing_mnemonic: Option<String>,
    start_loop: bool,
    skip_credits_check: bool,
    lifecycle_snapshot: Option<u64>,
) -> Result<InitSyncResult> {
    use tauri::Manager;
    let label = sanitize_label(&label)?;
    let app_state = app.state::<crate::app_state::AppState>();

    // Resolve the drive-lifecycle epoch snapshot BEFORE any teardown or
    // other observable step of this init. Callers that pre-cleared
    // `is_paused` under the commit lock pass their own (earlier)
    // snapshot so the supersession window covers their critical section
    // too; everyone else snapshots at entry. The commit step at the end
    // re-checks it under the label's commit lock, so a pause/removal
    // that lands anywhere during this init — including its earliest
    // steps — bumps the epoch past this snapshot and the commit yields
    // instead of resurrecting the drive (see sync::lifecycle_guard).
    let lifecycle_snapshot = lifecycle_snapshot.unwrap_or_else(|| app_state.drive_lifecycle.snapshot(&label));

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
    if !skip_credits_check && let Ok(account) = app_state.current_session_account() {
        let client = crate::api::client::ApiClient::new(app_state.api_client.clone(), pool_owned.clone());
        match client
            .get::<crate::billing::credits::CreditBalanceResponse>("/api/billing/credits/balance/", &account)
            .await
        {
            Ok(resp) => {
                // Unparseable balance is inconclusive, not zero — see balance_blocks_sync.
                if balance_blocks_sync(resp.balance.as_deref()) {
                    return Err(crate::error::AppError::Validation(
                        "Insufficient credits. Please add credits to your account before syncing.".into(),
                    ));
                }
            }
            // Fail-open on a transport/HTTP/parse error: this pre-init gate is a
            // best-effort proactive check. The gated upload IPCs each call the
            // fail-closed `require_eligible`, and the per-file 402 path is the
            // authoritative backstop, so a server blip here must not block sync.
            // Log it so the skipped check is observable instead of silently dropped.
            Err(e) => {
                tracing::warn!(account = %account, error = %e, "credit pre-init balance check failed; proceeding (upload IPCs still enforce eligibility)");
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
        // `cfg.drive_password` is `Zeroizing<String>`; the context borrows it as
        // `&str` (it is never moved/owned here, so no second secret copy).
        drive_password: cfg.drive_password.as_str(),
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
        // Starting the sync loop must NOT block this init's return when a loop
        // is ALREADY running. In that case hcfs-client's `start_sync_loop`
        // takes the `hot_add_drives` path, whose `collect_drive_paths` awaits
        // EVERY registered drive's manager lock — and that lock is held for the
        // full duration of a peer drive's in-flight sync cycle (run_sync_cycle
        // holds `manager.lock()` across the whole transfer). Awaiting it here
        // stalled the entire `add_local_sync_folder` IPC — and its modal, whose
        // buttons are disabled while the call is pending — for the length of the
        // peer drive's sync: the reported "app freezes when a second folder is
        // added while one is already syncing". The new drive is already in
        // `sync.drives` (registered just above), so the running loop picks it up
        // on its next cycle regardless; spawn the hot-add so init can commit its
        // status and return immediately.
        //
        // When no loop is running yet, keep awaiting: creation is cheap (there
        // is no busy peer manager to wait on) and awaiting keeps the first
        // drive's watcher/loop deterministically up before init returns.
        //
        // Read `loop_handle` into a `let` so its guard drops at the semicolon,
        // before `start_sync_loop` re-locks `loop_handle` internally. The check
        // is a hint, not a guarantee: if the loop is torn down between here and
        // the spawned task running, `start_sync_loop` re-checks `loop_handle`
        // under its own lock and self-guards an empty drive map — safe either way.
        let loop_already_running = sync.loop_handle.lock().await.is_some();
        if loop_already_running {
            let app_for_hot_add = app.clone();
            tauri::async_runtime::spawn(async move {
                start_sync_loop(app_for_hot_add).await;
            });
        } else {
            start_sync_loop(app.clone()).await;
        }
    }
    info!(
        "Sync initialized successfully for '{}'. User ID: {}, New setup: {}",
        label, user_id, is_new_setup
    );
    spawn_folder_registration(&cfg.server_url, &bearer_token, &label, &account_id, &fhash, pool, &cfg.sync_path);

    // Commit: clear the persisted paused flag now that the drive is
    // running. Every resume surface funnels through this function, but
    // only `resume_drive` cleared the flag itself — a resume via the
    // plain `initialize_sync` IPC (the files-page DriveOnboarding panel)
    // left a *running* drive DB-flagged paused, so the next
    // `auto_init_sync` pass re-emitted `Paused` for it (~30 s after
    // resume, via the login retry ladder) and every restart booted it
    // paused again. Clearing at the funnel makes "successfully
    // initialized ⇒ is_paused = 0" hold for every entry point; the
    // UPDATE is a no-op for the already-cleared rows auto-init passes
    // through.
    //
    // Pause-wins guard: the commit re-checks the epoch snapshot taken at
    // the top of this function — atomically with the flag clear, under
    // the label's commit lock (see sync::lifecycle_guard). A pause or
    // removal landing ANYWHERE during this init bumps the epoch, so the
    // commit observes it and yields no matter where in the init window
    // the supersession landed — including before `register_drive`, the
    // gap the old "is our label still in the in-memory map" heuristic
    // could not see (PR #17). The per-drive Active emit (settings page,
    // tray submenu listeners) rides INSIDE the commit via the
    // `on_committed` hook, which runs while the commit lock is still
    // held: emitting after the lock dropped let a pause run to
    // completion in that gap and have its Paused emit overwritten by
    // the stale Active one — poisoning the status cache (which wins
    // over the DB on FE bootstrap) for the rest of the session.
    match crate::sync::lifecycle_guard::apply_init_commit(&app_state.drive_lifecycle, pool, &account_id, &label, lifecycle_snapshot, || {
        crate::sync::status::emit_drive_status(&app, &label, &cfg.sync_path, crate::sync::drive_status::DriveStatus::Active);
    })
    .await
    {
        Ok(crate::sync::lifecycle_guard::CommitOutcome::Committed) => { /* Active already emitted by the on_committed hook */ }
        Ok(crate::sync::lifecycle_guard::CommitOutcome::Superseded) => {
            // A pause/removal won. Undo OUR registration so the drive
            // doesn't run against the user's intent; the superseder
            // already emitted its own status, so emit nothing here.
            //
            // Terminal teardown, NOT `teardown_previous_drive`: that
            // helper is the cheap entry-teardown for an init that is
            // about to re-register everything — it drops the slot but
            // leaves the label root, the watcher path, the synced-paths
            // cache, and the first-reconcile gate behind, which here
            // would leak until the next lifecycle op because this init
            // re-registers nothing. Mirror `pause_drive`'s sequence
            // instead: resolve the path hint from the DB so the watcher
            // is unwatched even when the per-drive lock is held by an
            // in-flight reconcile, then do the full in-memory removal.
            // Unlike `pause_drive`, this teardown runs OUTSIDE the commit
            // lock: the lock exists solely to make the epoch check and the
            // `is_paused` write atomic, this arm writes no flag, and the
            // remaining unprotected-removal hazard is exactly the
            // identity-aware-teardown follow-up.
            let path_hint = sync_path_for_label(&app_state, &account_id, &label).await;
            let (remaining, _removed_path) = remove_drive_inmemory(sync, &label, path_hint).await;
            if remaining == 0 {
                // A superseding pause/removal of the LAST drive already
                // stopped the sync loop, but `start_sync_loop` above may
                // have restarted it over a now-empty map — re-stop it.
                teardown_last_drive(sync, &app).await;
            }
            info!(label = %label, "init superseded by pause/removal — torn down, is_paused untouched");
            return Err(crate::error::AppError::NotReady(crate::error::NotReadyKind::SupersededByPause));
        }
        Err(e) => {
            // Epoch was current but the flag clear failed: drive keeps
            // running (warn-and-continue, PR #17 posture); the stale flag
            // self-heals on the next successful init or explicit resume.
            // No Active emit fires on this path (the hook runs only after
            // a successful flag clear) — the status cache keeps agreeing
            // with the still-set DB flag instead of contradicting it.
            warn!(label = %label, error = %e, "Failed to clear is_paused after successful init");
        }
    }

    // One-shot `relative_path` backfill for this drive. The task itself
    // re-checks the `relative_paths_backfilled_at` flag as its first
    // step and returns `AlreadyDone` without any work if set — so the
    // call site stays dumb even under re-init storms.
    crate::sync::relative_path_backfill::spawn_backfill(app.clone(), account_id.clone(), label.clone());

    // Recovery is default-on: ensure this account's mnemonic is registered as a
    // read-only recovery principal, with no user action. Best-effort and guarded
    // to one success per account per session, so the per-drive funnel is a safe
    // call site even under re-init storms.
    crate::recovery_binding::spawn_default_recovery_binding(app.clone());

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

    // 0d. Bump every registered drive's lifecycle epoch so any in-flight
    //     init notices the logout/reset at its commit step and tears itself
    //     down instead of re-registering after this cleanup completes.
    //     No commit lock is taken: stop_sync never writes `is_paused` (the
    //     single-writer rule guards only that write), `bump` is atomic on
    //     its own std-mutexed map, and every later init commit re-checks
    //     the epoch UNDER the commit lock — so an unlocked bump is always
    //     observed by any commit that has not yet run. A commit whose
    //     epoch check already passed before the bump may still write
    //     `is_paused=false`; that is benign because stop_sync writes no
    //     `is_paused` state of its own (nothing to overwrite) and steps
    //     1–5 below tear down the registrations this bump covered.
    //     Labels are collected in one short `sync.drives` lock scope first
    //     (hierarchy: never acquire a commit lock while holding
    //     `sync.drives`). Because labels are sourced from `sync.drives`,
    //     an init still in its pre-register window at logout is NOT
    //     invalidated by this bump — it can register and commit after
    //     the cleanup completes. Known gap, tracked follow-up: source
    //     bump labels from the account's `sync_paths` rows instead
    //     (every init path persists its row before initializing), or
    //     add a global epoch component.
    let lifecycle_labels: Vec<String> = {
        let guard = sync.drives.lock().await;
        guard.keys().cloned().collect()
    };
    for label in &lifecycle_labels {
        app_state.drive_lifecycle.bump(label);
    }

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
/// Resolve which account a drive teardown scopes its `sync_paths` row delete
/// and on-disk baseline wipe to. The caller's explicit account (when known —
/// e.g. the `remove_sync_path` IPC carries it in its params) takes precedence
/// over the session's `current_account_id`, so a teardown that races an account
/// switch wipes the baseline for the account that actually owns the drive
/// rather than whichever account happens to be current. `None` means neither is
/// available and the persistent cleanup must be skipped (the caller logs it).
fn teardown_account(explicit: Option<String>, current: Option<String>) -> Option<String> {
    explicit.or(current)
}

/// Decide whether a fetched credit balance should BLOCK sync.
///
/// A balance that parses to `<= 0.0` blocks; a positive balance allows. An
/// UNPARSEABLE balance is INCONCLUSIVE and must NOT block (returns `false`):
/// the previous `parse().ok()).unwrap_or(0.0)` treated any value f64 couldn't
/// parse — a currency suffix like "10.00 USD", a localized "1.000,00", or a
/// future API format change — as zero, locking paying users out of sync. Fail
/// open on "unknown"; block only on a definitively non-positive balance.
fn balance_blocks_sync(raw_balance: Option<&str>) -> bool {
    match raw_balance.and_then(|s| s.trim().parse::<f64>().ok()) {
        Some(balance) => balance <= 0.0,
        None => false,
    }
}

/// Remove a drive for the session's current account.
///
/// Thin wrapper over [`remove_drive_for_account`] with no explicit account.
/// Internal callers that already hold the owning account (the
/// `remove_sync_path` IPC) call the inner form directly so the baseline wipe
/// stays account-correct even during an account switch.
#[tauri::command]
pub async fn remove_drive(app: AppHandle, label: String) -> Result<()> {
    remove_drive_for_account(app, label, None).await
}

/// Tear down a drive: cancel any in-flight sync, drop it from the in-memory
/// map, delete its `sync_paths` row, clear its intent rows, and wipe its
/// on-disk sync baseline — in that drain-then-wipe order. `explicit_account`
/// scopes the DB delete and baseline wipe: pass `Some` when the caller knows
/// the owning account, `None` to fall back to the current session account.
pub(crate) async fn remove_drive_for_account(app: AppHandle, label: String, explicit_account: Option<String>) -> Result<()> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    // Clone the per-drive manager Arc BEFORE teardown removes its slot, so we
    // can drain its lock further down before wiping the baseline (F09). Cheap
    // Arc bump; the brief map-lock is released immediately.
    let drive_manager = {
        let guard = sync.drives.lock().await;
        guard.get(&label).map(|slot| slot.manager.clone())
    };

    // Resolve the on-disk path from the DB so remove_drive_inmemory can unwatch
    // the folder even when the per-drive lock is held by an in-flight reconcile.
    let path_hint = match explicit_account.clone().or_else(|| app_state.current_account_id().ok()) {
        Some(acct) => sync_path_for_label(&app_state, &acct, &label).await,
        None => None,
    };
    // Lifecycle serialization (see sync::lifecycle_guard): bump the pause
    // epoch and run the teardown's superseding mutations — in-memory removal
    // and the `sync_paths` row delete — under the label's commit lock. An
    // in-flight init for this label must observe the epoch change at its
    // commit step and tear itself down instead of re-registering a zombie
    // drive for the row this function deletes (Task 2.5 consumes the bump).
    // Lock ordering: commit_lock(label) → sync.drives → progress std
    // mutexes; the manager-clone read above released its `sync.drives`
    // guard before this acquisition, so the hierarchy holds.
    let (remaining, acct, preparing_cleared) = {
        let commit_lock = app_state.drive_lifecycle.commit_lock(&label);
        let _guard = commit_lock.lock().await;
        app_state.drive_lifecycle.bump(&label);

        let (remaining, _removed_path) = remove_drive_inmemory(sync, &label, path_hint).await;

        // Drop the preparing override for this label so a remove during
        // the SyncStarted → plan_ready window cannot leave a stuck
        // "Preparing sync…" badge tied to a drive that no longer exists.
        //
        // Belt-and-suspenders with the `SyncError::Cancelled` arm in
        // `tauri_bridge.rs` — that arm also clears preparing for the
        // cancelled label, but the cancel SyncEvent is dispatched
        // asynchronously relative to this synchronous IPC and may not
        // have landed yet. Calling `clear` here is idempotent (second
        // call returns `false`), so the dual-path is cheap and covers
        // the race where the IPC returns before the bridge has seen the
        // cancel. Only the `clear` runs in here — the corresponding
        // `emit_snapshot` is a pure FE notification with no lifecycle
        // state to serialize, so it happens after the guard drops to
        // keep the locked region minimal.
        let preparing_cleared = app_state.preparing.clear(&label);

        // Delete the DB row so the drive isn't resurrected on app restart, and
        // drop the intent-manifest rows for this drive so the snapshot overlay
        // doesn't keep showing stale "X of Y" totals for a folder the user just
        // removed.
        //
        // Both calls share the same prerequisites (pool + account known) and
        // both are best-effort — failure here doesn't break sync correctness.
        // The intent manifest is a UX overlay; stale rows will be cleaned up by
        // the next manifest GC pass even if this call fails. `pause_drive`
        // deliberately does NOT clear intent because pause is reversible and the
        // in-flight totals must survive a resume.
        let acct = teardown_account(explicit_account, app_state.current_account_id().ok());
        if acct.is_none() {
            warn!(
                label = %label,
                "remove_drive: no account context — sync_paths row and on-disk baseline left intact; in-memory drive still removed",
            );
        }
        if let (Ok(pool), Some(acct)) = (app_state.pool(), acct.as_deref()) {
            if let Err(e) = crate::sync::paths::remove_sync_path_internal(pool, acct, &label).await {
                warn!("Failed to remove sync path for '{}' from DB: {e}", label);
            }

            // `IntentRepo::new` takes `SqlitePool` by value; the pool is internally
            // `Arc`-shaped so `.clone()` is just an `Arc` bump — no connection
            // pool duplication.
            let repo = crate::sync::intent::IntentRepo::new(pool.clone());
            if let Err(e) = repo.clear_drive(acct, &label).await {
                warn!("Failed to clear intent rows for drive '{}': {e}", label);
            }
        }

        // Tell the FE to drop this drive's entry from its per-drive
        // status map — INSIDE the locked region so emission order
        // matches serialization order: an in-flight init's Active emit
        // runs under this same lock (the commit's `on_committed` hook),
        // so this removal emit can never be overtaken by a stale Active
        // one that would re-insert the just-removed drive into the
        // status cache. `emit_drive_removed` is sync and only takes the
        // status-cache std mutex — a permitted leaf under the commit
        // lock (see the hierarchy in sync::lifecycle_guard).
        crate::sync::status::emit_drive_removed(&app, &label);

        (remaining, acct, preparing_cleared)
        // Guard drops here: the row delete + in-memory teardown are done.
        // The baseline drain below waits up to GRACEFUL_DRIVE_SHUTDOWN and
        // must not hold the commit lock across that window.
    };

    // Deferred from the locked block above: tell the FE the preparing
    // badge cleared. Snapshot emission can synchronously run FE-bound
    // serialization and progress-mutex work — none of it needs the
    // commit lock, so it must not extend the locked region.
    if preparing_cleared {
        sync.emit_snapshot(true);
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
    // Drain any in-flight cycle's per-drive lock before deleting the baseline:
    // the cancel above makes the cycle exit, but its cancel-path
    // save_sync_state runs UNDER this lock and is async relative to this IPC.
    // Without the drain, that late save can re-create sync_state.json right
    // after we delete it, resurrecting the stale `synced` tree this wipe exists
    // to remove (the data-loss path fixed in 17b8e159). Best-effort on timeout.
    if !drain_drive_lock(drive_manager.as_ref(), GRACEFUL_DRIVE_SHUTDOWN).await {
        warn!(
            "remove_drive: in-flight sync of '{}' did not release within the grace window; wiping baseline anyway",
            label
        );
    }
    if let Some(acct) = acct.as_deref() {
        clear_persisted_sync_state(acct, &label);
    }

    if remaining == 0 {
        teardown_last_drive(sync, &app).await;
    }

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

    // Capture pool/account up front: used both to mark the row paused AND to
    // resolve the sync path passed as a hint to remove_drive_inmemory, so the
    // watcher is unwatched even when the per-drive lock is held by an in-flight
    // reconcile (try_lock would otherwise return None and leak the watch).
    let pool_and_acct = match (app_state.pool(), app_state.current_account_id()) {
        (Ok(pool), Ok(acct)) => Some((pool, acct)),
        _ => None,
    };
    let path_hint = match &pool_and_acct {
        Some((_, acct)) => sync_path_for_label(&app_state, acct, &label).await,
        None => None,
    };

    // Lifecycle serialization (see sync::lifecycle_guard): bump the pause
    // epoch and perform BOTH superseding mutations — the in-memory removal
    // and the `is_paused=true` write — under the label's commit lock. An
    // in-flight init that snapshotted an older epoch then observes the bump
    // at its commit step and yields instead of resurrecting this drive.
    // Lock ordering: the commit lock is acquired BEFORE anything in this
    // function touches `sync.drives` (hierarchy: commit_lock(label) →
    // sync.drives → progress std mutexes — never the reverse).
    let remaining = {
        let commit_lock = app_state.drive_lifecycle.commit_lock(&label);
        let _guard = commit_lock.lock().await;
        app_state.drive_lifecycle.bump(&label);

        let (remaining, removed_path) = remove_drive_inmemory(sync, &label, path_hint).await;

        // Mark as paused in DB (keep the row, unlike stop_drive which deletes it).
        if let Some((pool, acct)) = &pool_and_acct
            && let Err(e) = crate::sync::paths::set_sync_path_paused(pool, acct, &label, true).await
        {
            warn!("Failed to mark '{}' as paused in DB: {e}", label);
        }

        // The per-drive status payload carries the on-disk path (the FE relies on it
        // to keep its drive entry hydrated — see `useDriveStatuses`). `removed_path`
        // is reliable thanks to the DB hint resolved above.
        let drive_path = removed_path.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();

        // Emit the per-drive Paused status INSIDE the locked region so
        // emission order matches serialization order: an in-flight
        // init's Active emit runs under this same lock (the commit's
        // `on_committed` hook), so this Paused emit can never be
        // overtaken by a stale Active one once the pause has won.
        // `emit_drive_status` is sync and only takes the status-cache
        // std mutex — a permitted leaf under the commit lock (see the
        // hierarchy in sync::lifecycle_guard).
        crate::sync::status::emit_drive_status(&app, &label, &drive_path, crate::sync::drive_status::DriveStatus::Paused);

        remaining
        // Guard drops here: the locked region is exactly the superseding
        // state writes plus their status emit. `teardown_last_drive`
        // below waits a bounded grace window for the sync loop and must
        // not stall other lifecycle ops.
    };

    if remaining == 0 {
        teardown_last_drive(sync, &app).await;
    }

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
    // Single-writer rule (sync::lifecycle_guard): every `is_paused` write
    // holds the label's commit lock. No bump — resume supersedes nothing.
    // The guard MUST drop before `initialize_sync_inner` runs: the init's
    // own commit step takes this same lock and would deadlock against us.
    let resume_snapshot = {
        let commit_lock = app_state.drive_lifecycle.commit_lock(&label);
        let _guard = commit_lock.lock().await;
        // Capture the lifecycle snapshot the init will commit against in
        // the SAME locked block as the pre-clear. A snapshot taken later
        // (at init entry) misses a pause that fully completes between
        // this block and the init's entry — the init would then commit
        // over the pause even though the user's last click was Pause.
        // Order within the block is irrelevant: pause/remove bump under
        // this same lock, so no bump can interleave with these two
        // statements; stop_sync's lock-free bump can only make this
        // snapshot stale (commit yields — stop wins), never fresher.
        let resume_snapshot = app_state.drive_lifecycle.snapshot(&label);
        crate::sync::paths::set_sync_path_paused(pool, &account_id, &label, false).await?;
        resume_snapshot
    };

    // Re-initialize the drive. `initialize_sync_inner` emits the
    // per-drive Active status on success. On failure, we must emit an
    // `Error` status ourselves — otherwise the `drive_status_cache`
    // retains whatever it held before this click (typically `Paused`
    // or a stale `Error`) while the DB already says `is_paused=false`.
    // The FE would then read a stale entry from `get_all_drive_statuses`
    // on its next mount/bootstrap.
    match initialize_sync_inner(
        app.clone(),
        account_id.clone(),
        label.clone(),
        mnemonic,
        true,
        false,
        Some(resume_snapshot),
    )
    .await
    {
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
    let account_id = state.require_session_account(&account_id)?;
    let pool = state.pool()?;

    // Tear down the existing drive (fire and forget if it doesn't exist) so we
    // can re-initialize it with the new path. Thread the explicit `account_id`
    // (parity with `remove_sync_path`) so the baseline wipe stays account-correct
    // if the session flips mid-call — the session-deriving `remove_drive` would
    // scope the wipe to the wrong account during an account switch, which is the
    // stale-baseline-survives precondition `clear_persisted_sync_state` guards.
    let _ = remove_drive_for_account(app.clone(), label.clone(), Some(account_id.clone())).await;

    // Set the new sync path in the DB
    crate::sync::paths::set_sync_path_internal(pool, &account_id, &new_path, false, crate::sync::paths::LabelMode::Exact(&label)).await?;

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
    // FE entry that flows account_id into the secret-using inner; authorize
    // against the session before it reaches the mnemonic/token paths.
    let account_id = state.require_session_account(&account_id)?;
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
    if let Ok(account) = state.current_session_account() {
        let pool_owned = state.pool()?.clone();
        let client = crate::api::client::ApiClient::new(state.api_client.clone(), pool_owned);
        match client
            .get::<crate::billing::credits::CreditBalanceResponse>("/api/billing/credits/balance/", &account)
            .await
        {
            Ok(resp) => {
                // Unparseable balance is inconclusive, not zero — see balance_blocks_sync.
                if balance_blocks_sync(resp.balance.as_deref()) {
                    return Err(crate::error::AppError::Validation(
                        "Insufficient credits. Please add credits to your account before syncing.".into(),
                    ));
                }
            }
            // Fail-open on transport/HTTP/parse error (per-drive init + per-file
            // 402 are the authoritative backstops), but log the skipped check.
            Err(e) => {
                tracing::warn!(account = %account, error = %e, "credit pre-init balance check failed in auto_init; proceeding");
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
            let result = initialize_sync_inner(app, account_id, label.clone(), Some(mnemonic), true, true, None).await;
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

#[cfg(test)]
mod tests {
    use super::callbacks::TransferDirection;
    use super::*;
    use std::time::Duration;

    // ── drain_drive_lock (F09: serialize baseline wipe vs in-flight cycle) ──

    /// The drain must not return until the in-flight lock holder releases —
    /// i.e. the baseline wipe is ordered AFTER the cycle's cancel-path save.
    /// The holder sets `saved` only just before dropping the guard, so a drain
    /// that genuinely waits observes `saved == true`; a drain that skipped the
    /// lock would race and see `false`.
    #[tokio::test]
    async fn drain_drive_lock_waits_for_holder_to_release() {
        let lock = Arc::new(TokioMutex::new(()));
        let saved = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (holding_tx, holding_rx) = tokio::sync::oneshot::channel();

        let holder = {
            let lock = Arc::clone(&lock);
            let saved = Arc::clone(&saved);
            tokio::spawn(async move {
                let guard = lock.lock().await;
                holding_tx.send(()).expect("signal that the lock is held");
                tokio::time::sleep(Duration::from_millis(50)).await;
                // Simulate the cancel-path save_sync_state running under the lock.
                saved.store(true, std::sync::atomic::Ordering::SeqCst);
                drop(guard);
            })
        };

        // Only start draining once the holder definitely holds the lock.
        holding_rx.await.expect("holder acquired the lock");
        assert!(drain_drive_lock(Some(&lock), Duration::from_secs(5)).await, "drain should succeed");
        assert!(
            saved.load(std::sync::atomic::Ordering::SeqCst),
            "drain must return only after the in-flight save completed"
        );
        holder.await.expect("holder task joined");
    }

    /// When the holder never releases, the drain returns `false` within the
    /// bound so `remove_drive` proceeds best-effort instead of hanging.
    #[tokio::test]
    async fn drain_drive_lock_times_out_when_holder_never_releases() {
        let lock = Arc::new(TokioMutex::new(()));
        let _held = Arc::clone(&lock).lock_owned().await; // held for the whole test
        assert!(!drain_drive_lock(Some(&lock), Duration::from_millis(50)).await, "must time out, not hang");
    }

    /// No drive in the map (already removed) → nothing to drain, returns true.
    #[tokio::test]
    async fn drain_drive_lock_none_is_immediately_true() {
        assert!(drain_drive_lock::<()>(None, Duration::from_secs(5)).await);
    }

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
                    sync_path: sync_path.clone(),
                },
            );
        }

        // Seed ancillary state so removal has something to clean up.
        sync.register_label_root(label.to_string(), sync_path.clone());

        // Pre-conditions: drive and label root exist.
        assert!(sync.drives.lock().await.contains_key(label));

        let (remaining, removed_path) = remove_drive_inmemory(&sync, label, None).await;

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

        let _ = remove_drive_inmemory(&sync, label, None).await;

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
                    sync_path: sync_path.clone(),
                },
            );
        }

        assert!(!token_clone.is_cancelled(), "token should not be cancelled before removal");

        let _ = remove_drive_inmemory(&sync, label, None).await;

        assert!(token_clone.is_cancelled(), "token should be cancelled after removal");
    }

    #[tokio::test]
    async fn remove_drive_inmemory_returns_none_for_nonexistent_label() {
        let sync = test_sync_runner();

        let (remaining, removed_path) = remove_drive_inmemory(&sync, "nonexistent", None).await;

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

    // teardown_account decides which account scopes the `sync_paths` row delete
    // and the on-disk baseline wipe. The explicit account (carried by the
    // `remove_sync_path` IPC) MUST win over the session's current account so a
    // teardown that races an account switch never wipes the wrong account's
    // baseline — the correctness bug this helper closes.
    #[test]
    fn teardown_account_prefers_explicit_over_current() {
        assert_eq!(
            teardown_account(Some("explicit".into()), Some("current".into())).as_deref(),
            Some("explicit"),
        );
    }

    #[test]
    fn teardown_account_falls_back_to_current_without_explicit() {
        assert_eq!(teardown_account(None, Some("current".into())).as_deref(), Some("current"));
        assert_eq!(teardown_account(Some("explicit".into()), None).as_deref(), Some("explicit"));
    }

    #[test]
    fn teardown_account_none_when_neither_available() {
        // No account context at all → the caller skips persistent cleanup and warns.
        assert_eq!(teardown_account(None, None), None);
    }

    // change_sync_folder holds an explicit account_id, so its teardown MUST go
    // through remove_drive_for_account (threading that account) and NOT the
    // session-deriving remove_drive wrapper — otherwise an account flip mid-call
    // would wipe the wrong account's baseline (or leave A's stale baseline alive
    // across a path change, the clear_persisted_sync_state data-loss precondition).
    // Static source assertion mirrors remove_sync_path_delegates_to_remove_drive_for_account.
    #[test]
    fn change_sync_folder_tears_down_with_explicit_account() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/lifecycle.rs")).expect("read lifecycle.rs");
        let sig = src.find("pub async fn change_sync_folder(").expect("change_sync_folder present");
        let body_start = src[sig..].find('{').expect("fn body opens") + sig;
        let mut depth = 0usize;
        let mut body_end = body_start;
        for (i, ch) in src[body_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        body_end = body_start + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &src[body_start..=body_end];
        assert!(
            body.contains("remove_drive_for_account(app.clone(), label.clone(), Some(account_id.clone()))"),
            "change_sync_folder must tear down via remove_drive_for_account with the explicit account",
        );
        assert!(
            !body.contains("remove_drive(app"),
            "change_sync_folder must NOT use the session-deriving remove_drive wrapper",
        );
    }

    // balance_blocks_sync must block only on a definitively non-positive value.
    #[test]
    fn balance_blocks_sync_only_on_nonpositive() {
        assert!(balance_blocks_sync(Some("0")));
        assert!(balance_blocks_sync(Some("0.0")));
        assert!(balance_blocks_sync(Some("-5")));
        assert!(!balance_blocks_sync(Some("5")));
        assert!(!balance_blocks_sync(Some("0.5")));
    }

    // The regression: an unparseable balance (currency suffix, localized decimal,
    // format change, empty, or absent) is INCONCLUSIVE and must NOT block — the
    // old unwrap_or(0.0) treated these as zero and locked paying users out.
    #[test]
    fn balance_blocks_sync_treats_unparseable_as_inconclusive() {
        assert!(!balance_blocks_sync(Some("1000.00 USD")));
        assert!(!balance_blocks_sync(Some("1.000,00")));
        assert!(!balance_blocks_sync(Some("")));
        assert!(!balance_blocks_sync(Some("   ")));
        assert!(!balance_blocks_sync(None));
    }

    // f64::from_str accepts "NaN"/"inf"/"-inf". Pin the resulting decisions:
    // NaN <= 0.0 is false (IEEE-754, every NaN comparison is false) so NaN fails
    // OPEN (no block — inconclusive); -inf is non-positive so it blocks; +inf allows.
    #[test]
    fn balance_blocks_sync_handles_float_specials() {
        assert!(!balance_blocks_sync(Some("NaN")));
        assert!(!balance_blocks_sync(Some("inf")));
        assert!(balance_blocks_sync(Some("-inf")));
    }

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

    /// Build a `tauri::test::MockRuntime` app handle for callbacks that
    /// now take `&AppHandle<R>` (Task 6 — intent-manifest wiring). The
    /// handle's only role in these tests is to satisfy the type system
    /// and the closure's per-fire `app.clone()`; the spawned
    /// `mark_intent_completed` lookup falls through the
    /// "no `AppState` managed" branch silently because the mock app
    /// hasn't called `manage()` on `AppState`. That's the exact
    /// fire-and-forget contract — the surrounding cache write +
    /// activity enqueue keep being the only behavior these tests assert
    /// on. The `test` feature on `tauri` is enabled via dev-deps only.
    fn mock_app_handle() -> tauri::AppHandle<tauri::test::MockRuntime> {
        tauri::test::mock_app().handle().clone()
    }

    #[tokio::test]
    async fn build_file_synced_callback_writes_timestamps_to_cache() {
        let sync = test_sync_runner();
        let label: Arc<str> = Arc::from("test-drive");
        let app = mock_app_handle();
        let callback = build_file_synced_callback(&app, sync.clone(), Arc::clone(&label));

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
        use hcfs_client::engine::types::SyncedFileInfo;
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

        let app = mock_app_handle();
        let callback = build_file_synced_callback(&app, sync.clone(), Arc::clone(&label));
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
        let app = mock_app_handle();
        let callback = build_file_synced_callback(&app, sync.clone(), Arc::clone(&label));

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
        let app = mock_app_handle();
        let callback = build_file_synced_callback(&app, sync.clone(), Arc::clone(&label));

        let fid = [0xDDu8; 32];
        let ts = make_timestamps(123, 456);
        callback("", &hex::encode(fid), "cid-x", "uploaded", Some(&ts));

        assert!(
            sync.get_cached_synced_paths(&label).is_none(),
            "empty rel_path must not create a cache entry"
        );
    }
}
