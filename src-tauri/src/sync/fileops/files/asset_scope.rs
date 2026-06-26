//! Tauri asset-protocol scope management for sync folders.
//!
//! Split from the former flat `files.rs`; see the parent `mod.rs` for the
//! re-export boundary that keeps `crate::sync::files::X` paths resolving.

use crate::auth::account_key::account_key;
use crate::error::Result;
use std::path::Path;
use tauri::Manager;
use tracing::{info, warn};

/// Allow the given directory (recursively) in the Tauri asset protocol scope
/// so the frontend can display files via `asset://localhost/...` URLs.
///
/// The static scope in `tauri.conf.json` only covers `$HOME/.hippius/**` (drive
/// metadata). User-chosen sync folders live elsewhere, so we expand the scope
/// at runtime whenever a sync path is configured or loaded.
pub fn allow_asset_directory(app: &tauri::AppHandle, path: &str) {
    let dir = Path::new(path);
    if !dir.exists() {
        info!("Skipping asset scope for non-existent path: {}", path);
        return;
    }
    match app.asset_protocol_scope().allow_directory(dir, true) {
        Ok(()) => info!("Asset protocol scope allowed for: {}", path),
        Err(e) => warn!("Failed to allow asset scope for '{}': {}", path, e),
    }
}

/// Tauri command to explicitly allow a directory in the asset protocol scope.
/// Called by the frontend at startup for every known sync path.
///
/// Gated (audit H-4): `path` MUST be a registered `sync_paths` row for the
/// active account. Without this an unauthenticated renderer could grant itself
/// recursive `asset://` read of any directory (e.g. `/` or `$HOME`), defeating
/// the `$HOME/.hippius/**` capability scope in `tauri.conf.json`. Internal
/// callers that already hold a server-trusted path (`set_sync_path`,
/// `initialize_sync_inner`) call `allow_asset_directory` directly and bypass
/// this gate by construction. Mirrors `export_file`'s registered-path gate.
#[tauri::command]
pub async fn allow_asset_scope(state: tauri::State<'_, crate::app_state::AppState>, app: tauri::AppHandle, path: String) -> Result<()> {
    let account_id = state.current_account_id()?;
    let owner = account_key(&account_id);
    let registered: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM sync_paths WHERE owner = ? AND path = ? LIMIT 1")
        .bind(&owner)
        .bind(&path)
        .fetch_optional(state.pool()?)
        .await?;
    if registered.is_none() {
        return Err(crate::error::AppError::Other(
            "path is not a registered sync folder for this account".into(),
        ));
    }
    allow_asset_directory(&app, &path);
    Ok(())
}
