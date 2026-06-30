//! Dispatch inbound Finder menu actions to the share engine (macOS).
//!
//! A click forwarded by the extension carries an absolute path. We resolve it
//! to its Hippius drive ([`super::resolve`]); for an in-drive file we mint a
//! share via the existing engine and emit `finder:share-created` to the
//! frontend (which copies the link + shows the share modal). Files outside a
//! drive, and folders, are handled in Phase 2C.

use std::path::Path;

use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use crate::finder_bridge::protocol::ClientMessage;
use crate::finder_bridge::resolve::{resolve_share_target, ShareTarget};
use crate::shares::commands::ShareLink;

/// Resolve a clicked path and mint a share; log the outcome and, on success,
/// emit `finder:share-created` for the frontend.
pub async fn handle(app: AppHandle, message: ClientMessage) {
    let clicked = match message {
        ClientMessage::Share(path) | ClientMessage::UploadShare(path) => path,
    };
    match share_for_path(&app, &clicked).await {
        Ok(link) => {
            info!(url = %link.share_url, path = %clicked.display(), "finder bridge: share link created");
            let _ = app.emit("finder:share-created", &link);
        }
        Err(error) => warn!(%error, path = %clicked.display(), "finder bridge: share failed"),
    }
}

async fn share_for_path(app: &AppHandle, clicked: &Path) -> Result<ShareLink> {
    let state = app.state::<AppState>();
    let account_id = state.current_account_id()?;
    let roots = crate::sync::paths::list_drive_roots(state.pool()?, &account_id).await?;
    match resolve_share_target(clicked, &roots) {
        ShareTarget::InDrive { label, relative_path } => {
            // create_share_inner rejects a directory, so a folder click surfaces
            // as a "Cannot share a directory" error here until Phase 2C adds the
            // zip path.
            crate::shares::commands::share_synced_file(&state, &account_id, &label, &relative_path).await
        }
        ShareTarget::Outside => Err(AppError::Other(
            "Sharing files outside a Hippius folder is not yet implemented (Phase 2C)".into(),
        )),
    }
}

/// Register the account's configured drive roots with the bridge so the Finder
/// extension shows "Share via Hippius" + badges inside synced folders.
/// Best-effort: a missing bridge or DB error is logged, not fatal.
pub async fn register_drive_roots(app: &AppHandle, account_id: &str) {
    let state = app.state::<AppState>();
    let Some(bridge) = state.finder_bridge().cloned() else {
        return;
    };
    let pool = match state.pool() {
        Ok(pool) => pool.clone(),
        Err(_) => return,
    };
    match crate::sync::paths::list_drive_roots(&pool, account_id).await {
        Ok(roots) => {
            for (_label, path) in roots {
                bridge.register_root(path);
            }
        }
        Err(error) => warn!(%error, "finder bridge: could not list drive roots to register"),
    }
}
