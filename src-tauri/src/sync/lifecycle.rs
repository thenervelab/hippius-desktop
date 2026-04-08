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
/// a worker for hundreds of milliseconds on large caches. Offloading to
/// `spawn_blocking` keeps the runtime responsive.
///
/// The caller is responsible for guarding against missing paths; this
/// helper propagates `ENOENT` from libstd rather than hiding it.
async fn remove_dir_all_async(path: PathBuf) -> Result<()> {
    tokio::task::spawn_blocking(move || std::fs::remove_dir_all(path))
        .await
        .map_err(|e| crate::error::AppError::Other(format!("Join error removing directory: {e}")))??;
    Ok(())
}

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

    // 1. Generate unique label
    let owner = account_key(&account_id);
    let rows = sqlx::query("SELECT label FROM sync_paths WHERE owner = ?")
        .bind(&owner)
        .fetch_all(pool)
        .await
        .map_err(|e| crate::error::AppError::Other(format!("DB error: {e}")))?;
    use sqlx::Row;
    let existing: std::collections::HashSet<String> = rows.iter().map(|r| r.get::<String, _>("label")).collect();
    let mut label = folder_name.clone();
    let mut suffix = 2u32;
    while existing.contains(&label) {
        label = format!("{folder_name}-{suffix}");
        suffix += 1;
    }

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
    let _ = crate::sync::progress::remove_files_for_label(sync, label.to_string());

    (remaining, removed_path)
}

/// Pre-populate the synced-paths cache and store the manager in the drive
/// registry so the first sync cycle sees correct state immediately.
async fn register_drive(sync: &SyncRunner, manager: DriveManager, label: &str, sync_path: &str, folder_dir: &Path) {
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
    let mut guard = sync.drives.lock().await;
    guard.insert(
        label.to_string(),
        DriveSlot {
            manager: std::sync::Arc::new(TokioMutex::new(manager)),
            cancel_token: CancellationToken::new(),
        },
    );
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

    // If the login mnemonic is available, ensure the stored master matches.
    if let Some(imported) = existing_mnemonic
        && master_path.exists()
    {
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
        let (uid, mnem, is_new) =
            init_new_drive(&mut manager, label, master_path, drive_password, existing_mnemonic).await?;
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
fn spawn_folder_registration(server_url: &str, bearer_token: &str, label: &str, account_id: &str, fhash: &str, pool: &SqlitePool) {
    let config = build_hcfs_config(server_url, bearer_token, account_id, fhash);
    let reg_label = label.to_string();
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
        if let Ok(resp) = client.get::<serde_json::Value>("/api/billing/credits/balance/", &acct).await {
            let balance: f64 = resp.get("balance").and_then(|v| v.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0.0);
            if balance <= 0.0 {
                return Err(crate::error::AppError::Validation(
                    "Insufficient credits. Please add credits to your account before syncing.".into(),
                ));
            }
        }
    }

    teardown_previous_drive(sync, &label).await;

    // Load config (needs mnemonic to decrypt drive password)
    let mnemonic_for_config = if let Some(ref m) = existing_mnemonic {
        m.clone()
    } else {
        let guard = app_state.auth.lock()?;
        guard
            .mnemonic
            .as_deref()
            .ok_or_else(|| crate::error::AppError::Other("Mnemonic required to decrypt drive password".into()))?
            .to_owned()
    };
    let cfg = load_sync_config(pool, &account_id, &label, &mnemonic_for_config).await?;
    crate::sync::files::allow_asset_directory(&app, &cfg.sync_path);
    check_deleted_sync_dir(pool, &account_id, &label, &cfg.sync_path).await?;
    create_dir_all_async(PathBuf::from(&cfg.sync_path)).await?;

    let (_acct_dir, folder_dir, master_path) =
        prepare_config_dir(&account_id, &label, &cfg.sync_path, &cfg.drive_password, existing_mnemonic.as_deref())?;

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
        existing_mnemonic: existing_mnemonic.as_deref(),
    };
    let (manager, user_id, mnemonic, is_new_setup) =
        init_or_unlock_drive(manager, &label, &master_path, &cfg.drive_password, existing_mnemonic.as_deref(), &recovery_ctx).await?;
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
    register_drive(sync, manager, &label, &cfg.sync_path, &folder_dir).await;

    if start_loop {
        start_sync_loop(app.clone()).await;
    }
    info!(
        "Sync initialized successfully for '{}'. User ID: {}, New setup: {}",
        label, user_id, is_new_setup
    );
    spawn_folder_registration(&cfg.server_url, &bearer_token, &label, &account_id, &fhash, pool);

    // The user has just successfully started a drive — clear the persisted
    // user-stopped flag so a future cold start auto-inits cleanly. Best-
    // effort: a write failure is non-fatal because the in-memory status is
    // still set to Active below.
    if let Err(e) = crate::sync::status_state::write_user_stopped(pool, false).await {
        warn!("Failed to clear user-stopped flag after init: {e}");
    }
    crate::sync::status::set_status_and_emit(&app, &app_state, crate::sync::status_state::SyncEngineStatus::Active);

    Ok(InitSyncResult {
        user_id,
        // Unwrap Zeroizing at the IPC serialization boundary; the Zeroizing
        // copy is dropped (and scrubbed) immediately after the clone.
        mnemonic: mnemonic.map(|z| (*z).clone()),
        is_new_setup,
    })
}

/// Stop ALL drives. Used as **internal lifecycle cleanup** — not as a
/// user-initiated "stop sync" action. Call sites:
///
/// - `wallet-auth-context.tsx::initSync` runs `invoke("stop_sync")` as
///   defensive cleanup right before `tryAutoInitSync` on every login, so
///   any drives left over from a previous session are cleared.
/// - `auth/logout.rs::logout` calls it to drop drives during sign-out.
/// - `lifecycle.rs::reset_sync_data` calls it before wiping local state.
///
/// **None of these represent user intent to stop syncing.** This function
/// must NOT persist the user-stopped flag — that would cause auto-init to
/// bail on the very next call (which is what happens on every login).
/// The explicit user-pressed-Stop path lives in `stop_drive`, which is
/// the only place that writes `write_user_stopped(true)`.
///
/// Status emits are also intentionally absent: the engine status will be
/// re-derived on the next `get_sync_engine_status` query (driven by the
/// drives map and the auto-init latch), and emitting Stopping → Stopped
/// here would cause a brief alert flash on every login.
#[tauri::command]
pub async fn stop_sync(app: AppHandle) -> Result<()> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    // Reset the auto-init latch — a follow-up `auto_init_sync` is expected
    // (login, post-reset, and the splash-after-logout-then-login flow all
    // call this). Without resetting, `get_sync_engine_status` would jump
    // straight from Active → Stopped during the cleanup window because
    // the drives map is empty but the latch still says "auto init done".
    app_state.sync_status.reset_auto_init_complete();

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

    // Emit sync stopped event so frontend can reset UI state (tray icon, sync widget)
    let _ = app.emit(crate::sync::events::SYNC_STOPPED, ());

    // NOTE: deliberately no `set_status_and_emit(Stopped)` here — see the
    // function-level docstring. The engine status will be re-derived from
    // the drives map (now empty) by the next `get_sync_engine_status` call,
    // or pushed by the next `auto_init_sync` cycle.

    Ok(())
}

/// Stop a single drive by label. If no drives remain, also stops the sync loop.
/// Also removes the corresponding sync_paths DB row so the drive is not
/// resurrected on restart (prevents ghost sync paths).
#[tauri::command]
pub async fn stop_drive(app: AppHandle, label: String) -> Result<()> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    // Mark the engine as transitioning. The FE renders this as "Stopping…"
    // until the in-flight teardown finishes.
    crate::sync::status::set_status_and_emit(&app, &app_state, crate::sync::status_state::SyncEngineStatus::Stopping);

    let (remaining, _removed_path) = remove_drive_inmemory(sync, &label).await;

    // Wake any waiters in stop_drive_and_wait so they can re-check without
    // sleeping through the full polling interval.
    app_state.drive_removed_notify.notify_waiters();

    // Remove the DB row so the drive isn't resurrected on app restart.
    // Best-effort: if the account or pool isn't available, the in-memory
    // cleanup above still takes effect for this session.
    if let (Ok(pool), Ok(acct)) = (app_state.pool(), app_state.current_account_id())
        && let Err(e) = crate::sync::paths::remove_sync_path_internal(pool, &acct, &label).await
    {
        warn!("Failed to remove sync path for '{}' from DB: {e}", label);
    }

    // Persist the user's explicit Stop decision so it survives a restart.
    // Only persist when no drives remain — stopping a single drive in a
    // multi-drive setup is not the same as "user stopped sync entirely".
    if remaining == 0
        && let Ok(pool) = app_state.pool()
        && let Err(e) = crate::sync::status_state::write_user_stopped(pool, true).await
    {
        warn!("Failed to persist user-stopped flag: {e}");
    }

    if remaining == 0 {
        teardown_last_drive(sync, &app).await;
    }

    // Final status: Stopped if no drives remain, otherwise Active (the
    // remaining drives are still running).
    let new_status = if remaining == 0 {
        crate::sync::status_state::SyncEngineStatus::Stopped
    } else {
        crate::sync::status_state::SyncEngineStatus::Active
    };
    crate::sync::status::set_status_and_emit(&app, &app_state, new_status);

    info!("Stopped drive '{}', {} drives remaining", label, remaining);
    Ok(())
}

/// Pause a sync folder: stop the drive in-memory and mark it as paused in the DB.
/// Unlike `stop_drive`, the DB row is preserved so the folder reappears on restart
/// (but won't auto-sync until resumed).
#[tauri::command]
pub async fn pause_drive(app: AppHandle, label: String) -> Result<()> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    let (remaining, _removed_path) = remove_drive_inmemory(sync, &label).await;

    // Wake any waiters in stop_drive_and_wait so they can re-check without
    // sleeping through the full polling interval.
    app_state.drive_removed_notify.notify_waiters();

    // Mark as paused in DB (keep the row, unlike stop_drive which deletes it)
    if let (Ok(pool), Ok(acct)) = (app_state.pool(), app_state.current_account_id())
        && let Err(e) = crate::sync::paths::set_sync_path_paused(pool, &acct, &label, true).await
    {
        warn!("Failed to mark '{}' as paused in DB: {e}", label);
    }

    if remaining == 0 {
        teardown_last_drive(sync, &app).await;
    }

    info!("Paused drive '{}', {} drives remaining", label, remaining);
    Ok(())
}

/// Resume a paused sync folder: clear the paused flag and re-initialize.
#[tauri::command]
pub async fn resume_drive(app: AppHandle, label: String, mnemonic: Option<String>) -> Result<()> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();

    let account_id = app_state.current_account_id()?;
    let pool = app_state.pool()?;

    // Clear the paused flag first
    crate::sync::paths::set_sync_path_paused(pool, &account_id, &label, false).await?;

    // Re-initialize the drive
    initialize_sync_inner(app.clone(), account_id, label.clone(), mnemonic, true, false).await?;

    info!("Resumed drive '{}'", label);
    Ok(())
}

/// Reset sync data for an account, clearing all local sync state.
/// This allows starting fresh without corrupted or stale sync data.
///
/// IMPORTANT: This does NOT delete files in the sync folder - only HCFS metadata.
/// Files on the server remain intact.
#[tauri::command]
pub async fn reset_sync_data(state: tauri::State<'_, crate::app_state::AppState>, app: AppHandle, account_id: String) -> Result<()> {
    info!("Resetting sync data for account: {}", account_id);

    // First stop all active syncs
    stop_sync(app.clone()).await?;

    // Get the account directory
    let acct_dir = account_dir(&account_id)?;

    debug!("Reset: Deleting account directory: {:?}", acct_dir);

    // Delete the entire account directory (contains sync state, encrypted mnemonic, etc.).
    // `remove_dir_all_async` offloads the blocking walk to `spawn_blocking` so the Tokio
    // runtime stays responsive on large caches.
    if acct_dir.exists() {
        remove_dir_all_async(acct_dir).await?;
        debug!("Reset: Deleted account directory");
    }

    // Also clear the hcfs_config from database so user goes through setup again
    let db = state.pool()?;
    let owner = account_key(&account_id);

    sqlx::query("DELETE FROM hcfs_config WHERE owner = ?").bind(&owner).execute(db).await?;

    debug!("Reset: Cleared database config");

    // Emit event so frontend knows to show setup UI
    let _ = app.emit(
        crate::sync::events::SYNC_RESET,
        crate::sync::events::SyncResetPayload {
            account_id: account_id.clone(),
            message: "Sync data has been reset. Please set up sync again.".to_string(),
        },
    );

    info!("Reset complete for account: {}", account_id);

    Ok(())
}

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

    // Stop existing drive (fire and forget if it doesn't exist)
    let _ = stop_drive(app.clone(), label.clone()).await;

    // Set the new sync path in the DB
    crate::sync::paths::set_sync_path_internal(pool, &account_id, &new_path, false, Some(&label)).await?;

    info!(label = %label, path = %new_path, "Sync folder changed, initializing new drive");

    // Initialize the drive with the new path
    initialize_sync(app, account_id, label, mnemonic).await
}

/// Auto-initialize all configured sync paths on login.
///
/// This replaces the 9-step `tryAutoInitSync()` orchestration that was in
/// TypeScript. All business logic (migration lock, mnemonic persistence,
/// path filtering, HCFS config check, sequential init) lives in Rust.
///
/// The user-stopped flag is read from `user_preferences.sync_user_stopped`
/// inside `auto_init_sync_inner` — the frontend no longer passes it.
#[tauri::command]
pub async fn auto_init_sync(
    app: AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    mnemonic: Option<String>,
) -> Result<AutoInitResult> {
    let result = auto_init_sync_inner(app.clone(), &state, account_id, mnemonic).await;

    // Always mark the auto-init latch — the FE's `get_sync_engine_status`
    // uses this to decide between `Initializing` and `Stopped`. The one
    // exception is the "migration in progress" early-return: that path is
    // transient and auto_init_sync will be called again after migration
    // completes, so we leave the latch alone in that single case.
    let migration_blocked = matches!(
        &result,
        Ok(r) if r.skipped_reason.as_deref() == Some("Migration in progress"),
    );
    if !migration_blocked {
        state.sync_status.mark_auto_init_complete();
    }

    // Map the inner result to a status and emit the change.
    let new_status = match &result {
        Ok(r) if r.any_initialized => crate::sync::status_state::SyncEngineStatus::Active,
        // Migration block is transient — leave the in-memory status alone
        // (it will be `Initializing` from the previous call) so the FE
        // doesn't briefly flash to `Stopped` mid-migration.
        Ok(_) if migration_blocked => state.sync_status.get(),
        // Anything else (no paths, no password, user stopped, all drive
        // inits failed, or an Err) means there's nothing live → Stopped.
        _ => crate::sync::status_state::SyncEngineStatus::Stopped,
    };
    crate::sync::status::set_status_and_emit(&app, &state, new_status);

    result
}

/// Inner body of `auto_init_sync` — returns the same shape as the public
/// command but doesn't touch `sync_status`. The outer wrapper handles all
/// status transitions and the auto-init latch so we can't forget on a new
/// return path.
async fn auto_init_sync_inner(
    app: AppHandle,
    state: &tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    mnemonic: Option<String>,
) -> Result<AutoInitResult> {
    use std::sync::atomic::Ordering;

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

    // 6. Respect the user-stopped flag from the persisted user_preferences
    //    table. This replaces the old `localStorage["hippius_sync_stopped"]`
    //    that the frontend used to pass via the `user_stopped_sync`
    //    parameter — that's now ignored.
    if crate::sync::status_state::read_user_stopped(pool).await.unwrap_or(false) {
        return Ok(AutoInitResult {
            any_initialized: false,
            is_configured: true,
            skipped_reason: Some("User explicitly stopped sync".into()),
        });
    }

    // 7. Filter: exclude "migration" label and paused paths
    let regular: Vec<_> = sync_paths.iter().filter(|sp| sp.label != "migration" && !sp.is_paused).collect();

    info!(total = sync_paths.len(), active = regular.len(), "Auto-initializing sync paths");

    // 8. Check credits once before the drive loop — balance doesn't change
    // between drives, so a single HTTP round-trip is sufficient.  If the
    // check fails we return early; individual `initialize_sync_inner` calls
    // below will skip the check via `skip_credits_check = true`.
    if let Ok(acct) = state.current_account_id() {
        let pool_owned = state.pool()?.clone();
        let client = crate::api::client::ApiClient::new(state.api_client.clone(), pool_owned);
        if let Ok(resp) = client.get::<serde_json::Value>("/api/billing/credits/balance/", &acct).await {
            let balance: f64 = resp.get("balance").and_then(|v| v.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0.0);
            if balance <= 0.0 {
                return Err(crate::error::AppError::Validation(
                    "Insufficient credits. Please add credits to your account before syncing.".into(),
                ));
            }
        }
    }

    // 9. Initialize each path (credits already validated above — skip per-drive check)
    let mut any_initialized = false;
    for sp in &regular {
        match initialize_sync_inner(app.clone(), account_id.clone(), sp.label.clone(), mnemonic.clone(), true, true).await {
            Ok(result) => {
                info!(label = %sp.label, user_id = %result.user_id, "Sync initialized");
                any_initialized = true;
            }
            Err(e) => {
                warn!(label = %sp.label, error = %e, "Failed to init sync");
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
    started_set: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
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
        // Compute file_name once; reused for both the start/resume log and
        // the completion log below to avoid a second `Path::new` allocation.
        let file_name = Path::new(path_str).file_name().and_then(|n| n.to_str()).unwrap_or(path_str);
        if let Ok(mut set) = ctx.started_set.lock()
            && set.insert(path_str.to_string())
        {
            if bytes > 0 {
                info!(
                    "{} resuming [{}]: {} from {} bytes ({} total)",
                    dir_name, ctx.label, file_name, bytes, total
                );
            } else {
                info!("{} started [{}]: {} ({} bytes)", dir_name, ctx.label, file_name, total);
            }
        }
        let _ = crate::sync::progress::update_file_progress(&ctx.sync, path_str, bytes, total, file_action, Some(&*ctx.label));

        if crate::sync::logic::is_file_completion_tick(bytes, total) {
            let action = match ctx.direction {
                TransferDirection::Upload => SyncActivityAction::Uploaded,
                TransferDirection::Download => SyncActivityAction::Downloaded,
            };
            info!("{} complete [{}]: {} ({} bytes)", dir_name, ctx.label, file_name, total);
            let _ = ctx.app.emit(
                crate::sync::events::FILE_TRANSFER_COMPLETE,
                crate::sync::events::LabelPayload {
                    label: ctx.label.to_string(),
                },
            );
            ctx.sync.add_pending_activity(SyncActivityItem {
                file_name: std::sync::Arc::from(path_str),
                action,
                timestamp: chrono::Utc::now().timestamp(),
                size_bytes: total,
                label: Arc::clone(&ctx.label),
            });
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

/// Build the `on_file_synced` callback that logs per-file completion
/// and updates the synced-paths cache.
fn build_file_synced_callback(sync: Arc<SyncRunner>, label: Arc<str>) -> hcfs_client::sync::FileSyncedFn {
    Arc::new(move |rel_path, path_hash_hex, arion_cid, action| {
        debug!("File synced [{label}]: {rel_path} ({action}) cid={arion_cid}");
        if rel_path.is_empty() {
            return;
        }
        // hcfs's `FileSyncedFn` callback passes `path_hash_hex` as a hex
        // string. `SyncedFileInfo::new` now wants the raw 32-byte hash, so
        // we decode here. A future hcfs PR could pass `&[u8; 32]` directly
        // to skip this round-trip.
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
        let info = SyncedFileInfo::new(path_hash_bytes, Arc::from(arion_cid));
        sync.upsert_synced_path(&label, rel_path.to_string(), info);
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

    let upload_started: Arc<std::sync::Mutex<std::collections::HashSet<String>>> = Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));
    let download_started: Arc<std::sync::Mutex<std::collections::HashSet<String>>> =
        Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));

    let upload_ctx = Arc::new(TransferContext {
        sync: sync.clone(),
        app: app.clone(),
        label: Arc::clone(&label),
        started_set: Arc::clone(&upload_started),
        direction: TransferDirection::Upload,
    });
    let download_ctx = Arc::new(TransferContext {
        sync: sync.clone(),
        app: app.clone(),
        label: Arc::clone(&label),
        started_set: Arc::clone(&download_started),
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

    // ── remove_dir_all_async helper ──────────────────────────────────────
    //
    // `remove_dir_all_async` is the shared helper called by `reset_sync_data`
    // (and future callers) to remove a directory tree off the Tokio runtime.
    // These tests exercise the helper directly so a regression that reverts
    // the `spawn_blocking` wrap, changes the error type, or swallows ENOENT
    // would fail here.

    #[tokio::test]
    async fn remove_dir_all_async_removes_nested_directory() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let target = tmp.path().join("to-delete");
        std::fs::create_dir_all(target.join("a/b/c")).expect("mkdirs");
        std::fs::write(target.join("a/b/c/file.bin"), [0u8; 1024]).expect("write");
        assert!(target.exists());

        remove_dir_all_async(target.clone()).await.expect("remove");

        assert!(!target.exists(), "target should be gone after async remove");
    }

    #[tokio::test]
    async fn remove_dir_all_async_is_ok_on_missing_path() {
        // `remove_dir_all` returns an error on missing path; document that the
        // helper propagates it so callers know to guard with `path.exists()` first.
        let tmp = tempfile::tempdir().expect("tempdir");
        let missing = tmp.path().join("does-not-exist");
        let result = remove_dir_all_async(missing).await;
        assert!(result.is_err(), "helper should surface ENOENT from libstd");
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
}
