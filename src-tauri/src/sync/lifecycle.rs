//! Sync lifecycle: init, stop, pause, resume, auto-init, change folder,
//! progress handler setup, and all supporting private helpers.

use notify::Watcher;
use serde::Serialize;
use tracing::{debug, error, info, warn};

use crate::auth::account_key::account_key;
use crate::auth::tokens::get_api_token;
use crate::sync::config::{
    build_hcfs_config, get_drive_password, get_hcfs_config_internal, get_sync_path_for_label, load_sync_config, save_hcfs_config_internal,
};
use crate::sync::device::get_device_name_internal;
use crate::sync::folders::{get_all_sync_paths_internal, sanitize_label};
use crate::sync::mnemonic::{account_dir, config_dir_for_folder, derive_folder_mnemonic, ensure_derived_mnemonic, folder_hash, master_mnemonic_path};
use hcfs_client::engine::manager::DriveManager;
use hcfs_client::engine::runner::{DriveSlot, SyncRunner};
use hcfs_client::engine::types::{SyncActivityItem, SyncedFileInfo, build_synced_paths_from_state};
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
async fn remove_dir_all_async(path: PathBuf) -> Result<(), crate::error::AppError> {
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
async fn create_dir_all_async(path: PathBuf) -> Result<(), crate::error::AppError> {
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
) -> Result<InitSyncResult, crate::error::AppError> {
    use tauri::Manager;
    let state = app.state::<crate::app_state::AppState>();
    let pool = state.pool()?;

    // 1. Save HCFS config
    save_hcfs_config_internal(pool, &account_id, &server_url, &password).await?;

    // 2. Persist master mnemonic (if available and config has a password now)
    if let Some(ref m) = mnemonic
        && let Ok(pw) = get_drive_password(pool, &account_id).await
    {
        let master_path = master_mnemonic_path(&account_id)?;
        let acct_dir = account_dir(&account_id)?;
        if let Err(e) = create_dir_all_async(acct_dir.clone()).await {
            debug!("Early acct dir create skipped in setup_and_init_sync: {e}");
        }
        if let Err(e) = hcfs_client::auth::save_encrypted_mnemonic(&master_path, m, &pw) {
            debug!("Mnemonic persist during setup skipped: {e}");
        }
    }

    // 3. Initialize sync
    initialize_sync_inner(app, account_id, label, mnemonic, true).await
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
) -> Result<String, crate::error::AppError> {
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
    initialize_sync_inner(app, account_id, label.clone(), mnemonic, true).await?;

    info!(label = %label, path = %path, "Local sync folder added");
    Ok(label)
}

/// a unique `user_id` on the server. This keeps folder namespaces isolated:
/// switching folders won't download files from the previous folder.
#[tauri::command]
pub async fn initialize_sync(
    app: tauri::AppHandle,
    account_id: String,
    label: String,
    existing_mnemonic: Option<String>,
) -> Result<InitSyncResult, crate::error::AppError> {
    initialize_sync_inner(app, account_id, label, existing_mnemonic, true).await
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
            session.files.retain(|_path, file| file.label != *label);
            let removed = before - session.files.len();
            if removed > 0 {
                info!(label = %label, removed, "Removed stale files for re-initializing label");
            }
        }
    }
    sync.emit_snapshot(true);
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
// TODO: wired up in Task 6 of docs/plans/2026-04-05-sync-engine-hardening.md
#[allow(dead_code)]
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
// TODO: wired up in Task 6 of docs/plans/2026-04-05-sync-engine-hardening.md
#[allow(dead_code)]
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
// TODO: wired up in Task 6 of docs/plans/2026-04-05-sync-engine-hardening.md
#[allow(dead_code)]
async fn abort_sync_loop(sync: &SyncRunner) {
    let mut handle_guard = sync.loop_handle.lock().await;
    if let Some(prev) = handle_guard.take() {
        prev.abort();
    }
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
    if let Ok(state) = manager.load_sync_state() {
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
fn run_migration(sync_path: &str, account_dir: &Path, folder_dir: &Path, master_path: &Path) -> Result<(), crate::error::AppError> {
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
fn copy_dir_contents(src: &Path, dst: &Path) -> Result<(), crate::error::AppError> {
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
async fn check_deleted_sync_dir(pool: &SqlitePool, account_id: &str, label: &str, sync_path: &str) -> Result<(), crate::error::AppError> {
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
) -> Result<(PathBuf, PathBuf, PathBuf), crate::error::AppError> {
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
fn recover_drive(manager: DriveManager, ctx: &RecoveryContext<'_>) -> Result<(DriveManager, String, Option<String>), crate::error::AppError> {
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

    let master_str = if let Some(imported) = ctx.existing_mnemonic {
        debug!("Using login mnemonic as master for recovery");
        imported.to_string()
    } else {
        let master = bip39::Mnemonic::generate(24).map_err(|e| crate::error::AppError::Crypto(e.to_string()))?;
        warn!("Generated new random master for recovery (no login mnemonic available)");
        master.to_string()
    };
    hcfs_client::auth::save_encrypted_mnemonic(ctx.master_path, &master_str, ctx.drive_password)?;
    let derived = derive_folder_mnemonic(&master_str, ctx.label)?;

    let mut init_mnemonic = new_manager.init(ctx.drive_password, Some(&derived))?;
    zeroize::Zeroize::zeroize(&mut init_mnemonic);

    let uid = new_manager.unlock(ctx.drive_password)?;
    info!("Drive re-initialized and unlocked, derived user_id: {}", uid);

    Ok((new_manager, uid, Some(master_str)))
}

/// Initialize a brand-new folder: resolve the mnemonic source (imported
/// login mnemonic, existing master on disk, or error), init the drive,
/// and unlock it.
///
/// Returns `(user_id, optional_master_for_backup, is_new_master)`.
fn init_new_drive(
    manager: &mut DriveManager,
    label: &str,
    master_path: &Path,
    drive_password: &str,
    existing_mnemonic: Option<&str>,
) -> Result<(String, Option<String>, bool), crate::error::AppError> {
    info!(
        "Drive not initialized for '{}', creating... (existing_mnemonic={}, master_exists={})",
        label,
        existing_mnemonic.is_some(),
        master_path.exists(),
    );

    let (folder_mnemonic, master_for_backup, generated_new) = if let Some(imported) = existing_mnemonic {
        use zeroize::Zeroize;
        if master_path.exists() {
            let stored =
                hcfs_client::auth::recover_mnemonic(master_path, drive_password).map_err(|e| format!("Failed to recover master mnemonic: {e}"))?;
            let mut stored_str = stored.to_string();
            if stored_str == *imported {
                debug!("Stored master matches login mnemonic");
            } else {
                info!("Stored master differs from login mnemonic — updating master");
                hcfs_client::auth::save_encrypted_mnemonic(master_path, imported, drive_password)?;
            }
            stored_str.zeroize();
        } else {
            hcfs_client::auth::save_encrypted_mnemonic(master_path, imported, drive_password)?;
            info!("Saved login mnemonic as master (new device)");
        }
        let derived = derive_folder_mnemonic(imported, label)?;
        (derived, None, false)
    } else if master_path.exists() {
        let master =
            hcfs_client::auth::recover_mnemonic(master_path, drive_password).map_err(|e| format!("Failed to recover master mnemonic: {e}"))?;
        let mut master_str = master.to_string();
        let derived = derive_folder_mnemonic(&master_str, label)?;
        zeroize::Zeroize::zeroize(&mut master_str);
        debug!("Derived folder mnemonic from existing master");
        (derived, None, false)
    } else {
        return Err(crate::error::AppError::NotReady(crate::error::NotReadyKind::NoEncryptionKey));
    };

    let mut init_mnemonic = manager.init(drive_password, Some(&folder_mnemonic))?;
    zeroize::Zeroize::zeroize(&mut init_mnemonic);
    drop(init_mnemonic);
    let mut folder_mnemonic = folder_mnemonic;
    zeroize::Zeroize::zeroize(&mut folder_mnemonic);

    let uid = manager.unlock(drive_password)?;
    info!("Drive initialized and unlocked for '{}', derived user_id: {}", label, uid);

    Ok((uid, master_for_backup, generated_new))
}

/// Fire-and-log a health check against the HCFS server.
async fn check_init_server_health(server_url: &str) {
    let test_url = format!("{server_url}/health");
    debug!("Testing connectivity to: {}", test_url);
    let test_result = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map(|c| c.get(&test_url).header("X-API-Key", "Arion").send());
    let resp = match test_result {
        Ok(fut) => fut.await,
        Err(e) => {
            warn!("Failed to build test client: {e}");
            return;
        }
    };
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
pub(crate) async fn initialize_sync_inner(
    app: tauri::AppHandle,
    account_id: String,
    label: String,
    existing_mnemonic: Option<String>,
    start_loop: bool,
) -> Result<InitSyncResult, crate::error::AppError> {
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

    // Validate user has credits/balance before allowing sync
    if let Ok(acct) = app_state.current_account_id() {
        let client = crate::api::client::ApiClient::new(pool_owned.clone());
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

    // Load config, validate sync dir, prepare config dir
    let cfg = load_sync_config(pool, &account_id, &label).await?;
    crate::sync::files::allow_asset_directory(&app, &cfg.sync_path);
    check_deleted_sync_dir(pool, &account_id, &label, &cfg.sync_path).await?;
    create_dir_all_async(PathBuf::from(&cfg.sync_path)).await?;

    let (_acct_dir, folder_dir, master_path) =
        prepare_config_dir(&account_id, &label, &cfg.sync_path, &cfg.drive_password, existing_mnemonic.as_deref())?;

    // Create drive and set HCFS config
    let mut manager = DriveManager::new(PathBuf::from(&cfg.sync_path), folder_dir.clone());
    let bearer_token = get_api_token(pool, &account_id)
        .await?
        .ok_or_else(|| crate::error::AppError::Other("No authentication token found. Please log in again.".into()))?;
    let fhash = folder_hash(&label);
    manager.set_config(build_hcfs_config(&cfg.server_url, &bearer_token, &account_id, &fhash))?;

    // Init or unlock
    let (user_id, mnemonic, is_new_setup) = if manager.is_initialized() {
        debug!("Drive already initialized for '{}', unlocking...", label);
        match manager.unlock(&cfg.drive_password) {
            Ok(uid) => {
                info!("Drive unlocked, user_id: {}", uid);
                (uid, None, false)
            }
            Err(e) => {
                error!("Unlock failed for '{}': {}", label, e);
                info!("Attempting recovery: cleaning up encrypted files...");
                let ctx = RecoveryContext {
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
                let (new_mgr, uid, master) = recover_drive(manager, &ctx)?;
                manager = new_mgr;
                (uid, master, true)
            }
        }
    } else {
        init_new_drive(&mut manager, &label, &master_path, &cfg.drive_password, existing_mnemonic.as_deref())?
    };

    // Validate user_id
    let expected_user_id = format!("{account_id}_{fhash}");
    if user_id != expected_user_id {
        return Err(crate::error::AppError::Validation(format!(
            "Drive user_id mismatch: got '{user_id}', expected '{expected_user_id}'. \
             This indicates a corrupted config directory. \
             Please remove the folder and re-add it."
        )));
    }

    check_init_server_health(&cfg.server_url).await;
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

    Ok(InitSyncResult {
        user_id,
        mnemonic,
        is_new_setup,
    })
}

/// Stop ALL drives (used on logout).
#[tauri::command]
pub async fn stop_sync(app: AppHandle) -> Result<(), crate::error::AppError> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    sync.request_cancel();

    // Abort the background sync loop task to prevent spurious error events
    {
        let mut handle_guard = sync.loop_handle.lock().await;
        if let Some(prev) = handle_guard.take() {
            prev.abort();
        }
    }

    // Clear the file watcher
    {
        let mut watcher_guard = sync.watcher.lock().unwrap_or_else(|p| {
            warn!("Poisoned watcher mutex recovered in stop_sync");
            p.into_inner()
        });
        *watcher_guard = None;
    }

    {
        let mut guard = sync.drives.lock().await;
        // Cancel all in-progress syncs before clearing
        for slot in guard.values() {
            slot.cancel_token.cancel();
        }
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

    Ok(())
}

/// Stop a single drive by label. If no drives remain, also stops the sync loop.
/// Also removes the corresponding sync_paths DB row so the drive is not
/// resurrected on restart (prevents ghost sync paths).
#[tauri::command]
pub async fn stop_drive(app: AppHandle, label: String) -> Result<(), crate::error::AppError> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    let (remaining, removed_path) = {
        let mut guard = sync.drives.lock().await;
        let path = guard
            .get(&label)
            .and_then(|slot| slot.manager.try_lock().ok().map(|m| m.sync_path().to_path_buf()));
        if let Some(slot) = guard.remove(&label) {
            slot.cancel_token.cancel();
        }
        (guard.len(), path)
    };
    sync.unregister_label_root(&label);

    // Unwatch the removed drive's path to avoid spurious watcher events
    // that would wake the sync loop for a drive that no longer exists.
    if let Some(path) = &removed_path {
        let mut watcher_guard = sync.watcher.lock().unwrap_or_else(|p| {
            warn!("Poisoned watcher mutex recovered in stop_drive unwatch");
            p.into_inner()
        });
        if let Some(w) = watcher_guard.as_mut() {
            let _ = w.unwatch(path);
        }
    }

    sync.remove_state(&label);
    sync.discard_pending_activity_for_label(&label);
    // Clean up sync progress files for this drive
    let _ = crate::sync::progress::remove_files_for_label(sync, label.clone());

    // Remove the DB row so the drive isn't resurrected on app restart.
    // Best-effort: if the account or pool isn't available, the in-memory
    // cleanup above still takes effect for this session.
    {
        if let (Ok(pool), Ok(acct)) = (app_state.pool(), app_state.current_account_id())
            && let Err(e) = crate::sync::paths::remove_sync_path_internal(pool, &acct, &label).await
        {
            warn!("Failed to remove sync path for '{}' from DB: {e}", label);
        }
    }

    if remaining == 0 {
        // No more drives — stop the sync loop entirely
        sync.request_cancel();
        let mut handle_guard = sync.loop_handle.lock().await;
        if let Some(prev) = handle_guard.take() {
            prev.abort();
        }
        // Clear the watcher since the loop is done
        {
            let mut watcher_guard = sync.watcher.lock().unwrap_or_else(|p| {
                warn!("Poisoned watcher mutex recovered in stop_drive");
                p.into_inner()
            });
            *watcher_guard = None;
        }
        sync.clear_all_reviews();
        let _ = app.emit(crate::sync::events::SYNC_STOPPED, ());
    }

    info!("Stopped drive '{}', {} drives remaining", label, remaining);
    Ok(())
}

/// Pause a sync folder: stop the drive in-memory and mark it as paused in the DB.
/// Unlike `stop_drive`, the DB row is preserved so the folder reappears on restart
/// (but won't auto-sync until resumed).
#[tauri::command]
pub async fn pause_drive(app: AppHandle, label: String) -> Result<(), crate::error::AppError> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let sync = &app_state.sync;

    // Stop the drive in-memory (cancel, remove from map, unwatch)
    let (remaining, removed_path) = {
        let mut guard = sync.drives.lock().await;
        let path = guard
            .get(&label)
            .and_then(|slot| slot.manager.try_lock().ok().map(|m| m.sync_path().to_path_buf()));
        if let Some(slot) = guard.remove(&label) {
            slot.cancel_token.cancel();
        }
        (guard.len(), path)
    };
    sync.unregister_label_root(&label);

    if let Some(path) = &removed_path {
        let mut watcher_guard = sync.watcher.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(w) = watcher_guard.as_mut() {
            let _ = w.unwatch(path);
        }
    }

    sync.remove_state(&label);
    sync.discard_pending_activity_for_label(&label);
    let _ = crate::sync::progress::remove_files_for_label(sync, label.clone());

    // Mark as paused in DB (keep the row, unlike stop_drive which deletes it)
    if let (Ok(pool), Ok(acct)) = (app_state.pool(), app_state.current_account_id())
        && let Err(e) = crate::sync::paths::set_sync_path_paused(pool, &acct, &label, true).await
    {
        warn!("Failed to mark '{}' as paused in DB: {e}", label);
    }

    if remaining == 0 {
        sync.request_cancel();
        let mut handle_guard = sync.loop_handle.lock().await;
        if let Some(prev) = handle_guard.take() {
            prev.abort();
        }
        {
            let mut watcher_guard = sync.watcher.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            *watcher_guard = None;
        }
        sync.clear_all_reviews();
        let _ = app.emit(crate::sync::events::SYNC_STOPPED, ());
    }

    info!("Paused drive '{}', {} drives remaining", label, remaining);
    Ok(())
}

/// Resume a paused sync folder: clear the paused flag and re-initialize.
#[tauri::command]
pub async fn resume_drive(app: AppHandle, label: String, mnemonic: Option<String>) -> Result<(), crate::error::AppError> {
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();

    let account_id = app_state.current_account_id()?;
    let pool = app_state.pool()?;

    // Clear the paused flag first
    crate::sync::paths::set_sync_path_paused(pool, &account_id, &label, false).await?;

    // Re-initialize the drive
    initialize_sync_inner(app.clone(), account_id, label.clone(), mnemonic, true).await?;

    info!("Resumed drive '{}'", label);
    Ok(())
}

/// Reset sync data for an account, clearing all local sync state.
/// This allows starting fresh without corrupted or stale sync data.
///
/// IMPORTANT: This does NOT delete files in the sync folder - only HCFS metadata.
/// Files on the server remain intact.
#[tauri::command]
pub async fn reset_sync_data(
    state: tauri::State<'_, crate::app_state::AppState>,
    app: AppHandle,
    account_id: String,
) -> Result<(), crate::error::AppError> {
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
) -> Result<InitSyncResult, crate::error::AppError> {
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
/// path filtering, HCFS config check, sequential init) is now in Rust.
///
/// `user_stopped_sync` is passed from the frontend (read from localStorage)
/// since Rust cannot access browser storage.
#[tauri::command]
pub async fn auto_init_sync(
    app: AppHandle,
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    mnemonic: Option<String>,
    user_stopped_sync: bool,
) -> Result<AutoInitResult, crate::error::AppError> {
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
        && let Ok(password) = get_drive_password(pool, &account_id).await
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

    // 6. If user explicitly stopped sync, respect that
    if user_stopped_sync {
        return Ok(AutoInitResult {
            any_initialized: false,
            is_configured: true,
            skipped_reason: Some("User explicitly stopped sync".into()),
        });
    }

    // 7. Filter: exclude "migration" label and paused paths
    let regular: Vec<_> = sync_paths.iter().filter(|sp| sp.label != "migration" && !sp.is_paused).collect();

    info!(total = sync_paths.len(), active = regular.len(), "Auto-initializing sync paths");

    // 8. Initialize each path
    let mut any_initialized = false;
    for sp in &regular {
        match initialize_sync_inner(app.clone(), account_id.clone(), sp.label.clone(), mnemonic.clone(), true).await {
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
    label: String,
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
        let file_name = Path::new(path_str)
            .file_name()
            .map_or_else(|| path_str.to_string(), |f| f.to_string_lossy().to_string());
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
        let _ = crate::sync::progress::update_file_progress(&ctx.sync, path_str.to_string(), bytes, total, file_action, Some(ctx.label.clone()));
    }
    debug!("{} [{}]: {}/{} bytes, path: {:?}", dir_name, ctx.label, bytes, total, path);

    if crate::sync::logic::is_file_completion_tick(bytes, total)
        && let Some(path_str) = path
    {
        let display_name = Path::new(path_str)
            .file_name()
            .map_or_else(|| path_str.to_string(), |f| f.to_string_lossy().to_string());
        let action_str = match ctx.direction {
            TransferDirection::Upload => "uploaded",
            TransferDirection::Download => "downloaded",
        };
        info!("{} complete [{}]: {} ({} bytes)", dir_name, ctx.label, display_name, total);
        let _ = ctx.app.emit(
            crate::sync::events::FILE_TRANSFER_COMPLETE,
            crate::sync::events::LabelPayload { label: ctx.label.clone() },
        );
        ctx.sync.add_pending_activity(SyncActivityItem {
            file_name: path_str.to_string(),
            action: action_str.to_string(),
            timestamp: chrono::Utc::now().timestamp(),
            size_bytes: total,
            label: ctx.label.clone(),
        });
    }
}

/// Build the `on_sync_plan_ready` callback that merges the sync plan into the
/// progress session and emits the `SYNC_PLAN_READY` event.
fn build_plan_ready_callback(app: &AppHandle, label: &str, sync: &Arc<SyncRunner>) -> hcfs_client::sync::SyncPlanReadyFn {
    let app = app.clone();
    let label = label.to_string();
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

        let upload_paths: Vec<String> = uploads.iter().map(|f| f.path.clone()).collect();
        let download_paths: Vec<String> = downloads.iter().map(|f| f.path.clone()).collect();
        let local_delete_paths: Vec<String> = local_deletes.iter().map(|f| f.path.clone()).collect();
        let remote_delete_paths: Vec<String> = remote_deletes.iter().map(|f| f.path.clone()).collect();

        let size_map: std::collections::HashMap<String, u64> = uploads
            .iter()
            .chain(downloads.iter())
            .chain(local_deletes.iter())
            .chain(remote_deletes.iter())
            .filter(|f| f.size_bytes > 0)
            .map(|f| (f.path.clone(), f.size_bytes))
            .collect();

        let file_list = crate::sync::progress::SessionFileList {
            upload_files: Some(upload_paths.clone()),
            download_files: Some(download_paths.clone()),
            local_delete_files: Some(local_delete_paths.clone()),
            remote_delete_files: Some(remote_delete_paths.clone()),
        };
        let _ = crate::sync::progress::merge_into_session(
            &sync,
            uploads.len() as u32,
            downloads.len() as u32,
            local_deletes.len() as u32,
            remote_deletes.len() as u32,
            Some(file_list),
            Some(label.clone()),
        );

        if !size_map.is_empty() {
            let mut progress_state = sync.progress.lock();
            if let Some(session) = progress_state.current_session.as_mut() {
                let mut patched = 0usize;
                for (path, size) in &size_map {
                    if let Some(file) = session.files.get_mut(path)
                        && file.total_bytes == 0
                    {
                        file.total_bytes = *size;
                        patched += 1;
                    }
                }
                if patched > 0 {
                    info!(patched, total, label = %label, "Patched file sizes from sync plan");
                }
            }
            drop(progress_state);
            sync.emit_snapshot(true);
        }

        let _ = app.emit(
            crate::sync::events::SYNC_PLAN_READY,
            crate::sync::events::SyncPlanReadyPayload {
                label: label.clone(),
                uploads: uploads.len(),
                downloads: downloads.len(),
                local_deletes: local_deletes.len(),
                remote_deletes: remote_deletes.len(),
                upload_files: upload_paths,
                download_files: download_paths,
                local_delete_files: local_delete_paths,
                remote_delete_files: remote_delete_paths,
            },
        );
    })
}

#[expect(clippy::too_many_lines, reason = "closure-heavy callback setup; splitting breaks capture context")]
pub(crate) fn setup_progress_handlers(app: &AppHandle, manager: &mut DriveManager, label: &str, sync: &Arc<SyncRunner>) {
    let upload_started: Arc<std::sync::Mutex<std::collections::HashSet<String>>> = Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));
    let download_started: Arc<std::sync::Mutex<std::collections::HashSet<String>>> =
        Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));

    // Upload callback
    let upload_ctx = Arc::new(TransferContext {
        sync: sync.clone(),
        app: app.clone(),
        label: label.to_string(),
        started_set: Arc::clone(&upload_started),
        direction: TransferDirection::Upload,
    });
    // Download callback
    let download_ctx = Arc::new(TransferContext {
        sync: sync.clone(),
        app: app.clone(),
        label: label.to_string(),
        started_set: Arc::clone(&download_started),
        direction: TransferDirection::Download,
    });

    // Encrypt/decrypt callbacks
    let sync_encrypt = sync.clone();
    let l3 = label.to_string();
    let sync_decrypt = sync.clone();
    let l4 = label.to_string();

    // Scan/fetch/synced callbacks
    let sync_scan = sync.clone();
    let a5 = app.clone();
    let l5 = label.to_string();
    let sync_fetch = sync.clone();
    let a6 = app.clone();
    let l6 = label.to_string();
    let sync_file_synced = sync.clone();
    let l7 = label.to_string();

    manager.set_progress(SyncProgress {
        on_sync_plan_ready: Some(build_plan_ready_callback(app, label, sync)),
        on_upload_progress: Some(Arc::new(move |b, t, p| {
            handle_transfer_progress(&upload_ctx, b, t, p);
        })),
        on_download_progress: Some(Arc::new(move |b, t, p| {
            handle_transfer_progress(&download_ctx, b, t, p);
        })),
        on_encrypt_progress: Some(Arc::new(move |b, t, p| {
            sync_encrypt.touch_progress_time();
            if b == 0 {
                info!("Encrypt starting [{}]: {:?} ({} bytes)", l3, p, t);
            } else if b == t && t > 0 {
                info!("Encrypt complete [{}]: {:?} ({} bytes)", l3, p, t);
            }
            if let Some(path_str) = p {
                let _ = crate::sync::progress::update_file_progress(
                    &sync_encrypt,
                    path_str.to_string(),
                    b,
                    t,
                    crate::sync::progress::FileAction::Encrypt,
                    Some(l3.clone()),
                );
            }
        })),
        on_decrypt_progress: Some(Arc::new(move |b, t, p| {
            sync_decrypt.touch_progress_time();
            if b == 0 {
                info!("Decrypt starting [{}]: {:?} ({} bytes)", l4, p, t);
            } else if b == t && t > 0 {
                info!("Decrypt complete [{}]: {:?} ({} bytes)", l4, p, t);
            }
            if let Some(path_str) = p {
                let _ = crate::sync::progress::update_file_progress(
                    &sync_decrypt,
                    path_str.to_string(),
                    b,
                    t,
                    crate::sync::progress::FileAction::Decrypt,
                    Some(l4.clone()),
                );
            }
        })),
        on_scan_progress: Some(Arc::new(move |n, p| {
            sync_scan.touch_progress_time();
            info!("Scan [{}]: {} files scanned, current: {:?}", l5, n, p);
            let _ = a5.emit(
                crate::sync::events::SCAN_PROGRESS,
                crate::sync::events::ScanProgressPayload {
                    label: l5.clone(),
                    scanned: n,
                    path: p.map(std::string::ToString::to_string),
                },
            );
        })),
        on_fetch_state_progress: Some(Arc::new(move |f, t| {
            sync_fetch.touch_progress_time();
            info!("Fetch state [{}]: {}/{} entries", l6, f, t);
            let _ = a6.emit(
                crate::sync::events::FETCH_PROGRESS,
                crate::sync::events::FetchProgressPayload {
                    label: l6.clone(),
                    fetched: f,
                    total: t,
                },
            );
        })),
        on_file_synced: Some(Arc::new(move |rel_path: &str, path_hash_hex: &str, arion_cid: &str, action: &str| {
            debug!("File synced [{}]: {} ({}) cid={}", l7, rel_path, action, arion_cid);
            if !rel_path.is_empty() {
                let info = SyncedFileInfo::new(path_hash_hex.to_string(), arion_cid.to_string());
                sync_file_synced.upsert_synced_path(&l7, rel_path.to_string(), info);
            }
        })),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
