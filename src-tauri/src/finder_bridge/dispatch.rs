//! Dispatch inbound Finder menu actions to the share engine (macOS).
//!
//! A click forwarded by the extension carries an absolute path. We resolve it
//! to its Hippius drive ([`super::resolve`]) and mint a share via the existing
//! engine: an in-drive file shares by `(label, relative_path)`, an outside file
//! by raw bytes, and a folder by zipping it into one blob. A private click also
//! wraps the key under a random password (`#p=`). On success we emit
//! `finder:share-created`, which the frontend copies + shows in the share modal.
//!
//! ## Security: socket peer trust (accepted risk)
//! The App Group socket ([`super::socket`]) is reachable by any local process
//! running as the logged-in user, and the accept loop does not authenticate the
//! peer's code signature. Such a process already has full read access to the
//! user's files, but it can additionally use *this* path to mint a public share
//! of an arbitrary file under the user's Hippius account and credits — a
//! confused-deputy escalation. Accepted for v1 (the bar is "a process already
//! running as you"); a follow-up should verify the connecting peer is the
//! codesigned extension (`LOCAL_PEERCRED` → pid → `SecCode` requirement).

use std::path::Path;

use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

use crate::app_state::AppState;
use crate::error::Result;
use crate::finder_bridge::protocol::ClientMessage;
use crate::finder_bridge::resolve::{resolve_share_target, ShareTarget};
use crate::shares::commands::ShareLink;

/// Payload for the `finder:share-created` event. Both public and private shares
/// surface through this one event; the frontend distinguishes them by whether
/// `password` is present (a private link is unopenable without it, so the FE
/// shows it next to the URL for the user to pass on out-of-band).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FinderShareCreated {
    share_token: String,
    share_url: String,
    expires_at: String,
    /// `Some` only for a password-protected (`#p=`) share — the randomly
    /// generated password. Omitted from the JSON for a public share.
    #[serde(skip_serializing_if = "Option::is_none")]
    password: Option<String>,
}

impl FinderShareCreated {
    /// A public (`#k=`) share carries no password.
    fn public(link: ShareLink) -> Self {
        Self {
            share_token: link.share_token,
            share_url: link.share_url,
            expires_at: link.expires_at,
            password: None,
        }
    }
}

/// Resolve a clicked path and mint a share; log the outcome and, on success,
/// emit `finder:share-created` for the frontend. A `SharePrivate` click wraps
/// the key under a random password (no prompt yet) and carries it in the
/// payload; the public verbs mint a `#k=` link with no password.
pub async fn handle(app: AppHandle, message: ClientMessage) {
    let (clicked, result) = match message {
        ClientMessage::Share(path) | ClientMessage::UploadShare(path) => {
            let created = share_for_path(&app, &path).await.map(FinderShareCreated::public);
            (path, created)
        }
        ClientMessage::SharePrivate(path) => {
            let created = share_private_for_path(&app, &path).await;
            (path, created)
        }
    };
    match result {
        Ok(created) => {
            // Log the token (non-secret), NEVER `share_url`: a public share's URL
            // carries the `#k=<key>` content key in its fragment, and the
            // support-log scrubber (`utils/logs.rs`) does not catch a base64url
            // fragment — logging the URL would ship the key in
            // `attach_logs_to_ticket` bundles, defeating the "key never leaves
            // the client" property.
            info!(
                share_token = %created.share_token,
                private = created.password.is_some(),
                path = %clicked.display(),
                "finder bridge: share link created"
            );
            // Target the main window only: a private share's payload carries the
            // generated `password`, which must not be delivered to the borderless
            // `tray-panel` webview. `FinderShareListener` runs only in main.
            let _ = app.emit_to("main", "finder:share-created", &created);
        }
        Err(error) => warn!(%error, path = %clicked.display(), "finder bridge: share failed"),
    }
}

/// Mint a share for `clicked`, then wrap its key under a freshly generated
/// random password into a `#p=` private link. Reuses [`share_for_path`] for the
/// in-drive/outside/file/folder resolution — the wrap is a pure post-step that
/// reads the just-stored key back from the keystore.
async fn share_private_for_path(app: &AppHandle, clicked: &Path) -> Result<FinderShareCreated> {
    let public = share_for_path(app, clicked).await?;
    let state = app.state::<AppState>();
    let private = crate::shares::commands::make_private(&state, public).await?;
    Ok(FinderShareCreated {
        share_token: private.link.share_token,
        share_url: private.link.share_url,
        expires_at: private.link.expires_at,
        password: Some(private.password),
    })
}

async fn share_for_path(app: &AppHandle, clicked: &Path) -> Result<ShareLink> {
    let state = app.state::<AppState>();
    let account_id = state.current_account_id()?;

    // A directory (in-drive or outside) is shared as one zip blob — the share
    // engine has no folder concept. Resolve file-vs-dir BEFORE the in-drive
    // check so an in-drive folder takes the zip path rather than
    // `share_synced_file`, which rejects directories.
    let metadata = tokio::fs::metadata(clicked).await?;
    if metadata.is_dir() {
        return crate::shares::commands::share_directory_as_zip(&state, &account_id, clicked).await;
    }

    let roots = crate::sync::paths::list_drive_roots(state.pool()?, &account_id).await?;
    match resolve_share_target(clicked, &roots) {
        // In-drive file: mint by (label, relative_path) and record a reshare origin.
        ShareTarget::InDrive { label, relative_path } => {
            crate::shares::commands::share_synced_file(&state, &account_id, &label, &relative_path).await
        }
        // Outside file: "upload & share" by streaming its bytes; no origin row.
        ShareTarget::Outside => crate::shares::commands::share_external_file(&state, &account_id, clicked).await,
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
