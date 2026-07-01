//! Dispatch inbound Finder menu actions to the share engine (macOS).
//!
//! A click forwarded by the extension carries an absolute path. We resolve it
//! to its Hippius drive ([`super::resolve`]) and mint a share via the existing
//! engine: an in-drive file shares by `(label, relative_path)`, an outside file
//! by raw bytes, and a folder by zipping it into one blob. A private click also
//! wraps the key under a random password (`#p=`).
//!
//! We bracket the mint with three frontend events so a slow share (a big file or
//! a folder-zip) is never silent: `finder:share-started` fires immediately (the
//! modal opens into a spinner and the app comes forward), then exactly one of
//! `finder:share-created` (success — copied + shown) or `finder:share-failed`
//! (the modal shows an error instead of a hung spinner).
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

/// Payload for `finder:share-started`, emitted the instant a Finder share begins
/// — before the (possibly many-second) encrypt+upload. A big file or a
/// folder-zip mints slowly, and the modal only opens on the *finished* link, so
/// without this the user sees nothing and assumes the click did nothing. The FE
/// opens the share modal into a spinner on this event.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FinderShareStarted {
    /// The clicked file/folder's display name, shown while the share runs.
    name: String,
    /// Whether this is a password-protected (`#p=`) share — lets the modal label
    /// the in-flight state without waiting for the outcome.
    private: bool,
}

/// Payload for `finder:share-failed`, emitted when the mint errors. Pairs with
/// the existing `warn!`: the log alone left the user staring at a spinner that
/// never resolved, so the FE turns this into the modal's error state.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FinderShareFailed {
    /// The clicked file/folder's display name.
    name: String,
    /// A user-facing failure message (the `AppError`'s `Display`).
    message: String,
}

/// Resolve a clicked path and mint a share, bracketing the mint with frontend
/// events so a slow share is never silent: emit `finder:share-started` (and
/// bring the app forward) BEFORE minting, then log the outcome and emit exactly
/// one of `finder:share-created` (success) or `finder:share-failed` (error). A
/// `SharePrivate` click wraps the key under a random password (no prompt yet)
/// and carries it in the created payload; the public verbs mint a `#k=` link
/// with no password.
pub async fn handle(app: AppHandle, message: ClientMessage) {
    // Announce the share and bring the app forward BEFORE the mint runs. The
    // mint (encrypt + upload, or zip-then-upload for a folder) can take many
    // seconds on a big target, and the modal only opens on the finished link —
    // so this early signal is what turns "nothing happened" into a spinner.
    let (clicked, is_private) = match &message {
        ClientMessage::Share(path) | ClientMessage::UploadShare(path) => (path.clone(), false),
        ClientMessage::SharePrivate(path) => (path.clone(), true),
    };
    let name = display_name(&clicked);
    reveal_main_window(&app);
    let _ = app.emit_to(
        "main",
        "finder:share-started",
        &FinderShareStarted { name: name.clone(), private: is_private },
    );

    let result = if is_private {
        share_private_for_path(&app, &clicked).await
    } else {
        share_for_path(&app, &clicked).await.map(FinderShareCreated::public)
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
        Err(error) => {
            warn!(%error, path = %clicked.display(), "finder bridge: share failed");
            // Surface the failure to the FE so the spinner opened by
            // `finder:share-started` resolves to an error state instead of
            // hanging. Best-effort like the success emit above.
            let _ = app.emit_to(
                "main",
                "finder:share-failed",
                &FinderShareFailed { name, message: error.to_string() },
            );
        }
    }
}

/// Bring the main app window to the foreground so a Finder-initiated share is
/// visible right away (the share modal lives in the main window). Mirrors the
/// reopen path in `main.rs`. Best-effort: each step is a no-op if the window is
/// gone (shutdown) or already in that state.
fn reveal_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// The clicked path's file name for display in the share modal, falling back to
/// the full path when the path has no final component (e.g. `/`). See the
/// `std::path::Path::file_name` contract: a trailing slash still yields the leaf
/// (`/a/b/` → `b`), and only `/` or a `..`-terminated path yields `None`.
fn display_name(path: &Path) -> String {
    path.file_name()
        .map_or_else(|| path.display().to_string(), |name| name.to_string_lossy().into_owned())
}

/// Mint a share for `clicked`, then wrap its key under a freshly generated
/// random password into a `#p=` private link. Reuses [`share_for_path`] for the
/// in-drive/outside/file/folder resolution — the wrap is a pure post-step that
/// reads the just-stored key back from the keystore.
///
/// `make_private` upgrades an already-minted PUBLIC share, so if the wrap fails
/// the public token is already live on the server while the user asked for a
/// private share. We revoke that orphaned public share (best-effort) before
/// returning the error, so a failed private click never leaves an unintended
/// public link to the file behind.
async fn share_private_for_path(app: &AppHandle, clicked: &Path) -> Result<FinderShareCreated> {
    let public = share_for_path(app, clicked).await?;
    let state = app.state::<AppState>();
    // Capture the token before `make_private` consumes `public` — the error arm
    // needs it to revoke the orphaned public share.
    let public_token = public.share_token.clone();
    match crate::shares::commands::make_private(&state, public).await {
        Ok(private) => Ok(FinderShareCreated {
            share_token: private.link.share_token,
            share_url: private.link.share_url,
            expires_at: private.link.expires_at,
            password: Some(private.password),
        }),
        Err(error) => {
            if let Err(revoke_err) = crate::shares::commands::revoke_public_share(&state, &public_token).await {
                warn!(%revoke_err, share_token = %public_token, "finder bridge: could not revoke orphaned public share after private-wrap failure");
            }
            Err(error)
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn display_name_uses_the_file_basename() {
        assert_eq!(display_name(&PathBuf::from("/Users/me/Hippius/report.pdf")), "report.pdf");
    }

    #[test]
    fn display_name_of_a_directory_is_its_leaf() {
        assert_eq!(display_name(&PathBuf::from("/Users/me/Hippius/Photos")), "Photos");
        // A trailing slash does not add an empty final component (std contract).
        assert_eq!(display_name(&PathBuf::from("/Users/me/Photos/")), "Photos");
    }

    #[test]
    fn display_name_falls_back_to_full_path_when_no_leaf() {
        // `/` has no `file_name`; fall back to the whole path rather than "".
        assert_eq!(display_name(&PathBuf::from("/")), "/");
    }

    /// Pin the core feedback invariant against a silent refactor: `handle` must
    /// emit `finder:share-started` BEFORE the mint and, after it, both terminal
    /// events (`finder:share-created` on the Ok arm, `finder:share-failed` on the
    /// Err arm). A refactor that reordered or dropped one would reintroduce the
    /// "big-file share shows nothing / hangs on failure" bug. Source-text pin —
    /// scoped to `handle`'s definition onward so the module/fn doc mentions of the
    /// event names (which precede it) don't match.
    #[test]
    fn handle_emits_started_before_mint_then_a_terminal_event() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/finder_bridge/dispatch.rs")).expect("read dispatch.rs");
        let handle_at = src.find("pub async fn handle(").expect("handle fn exists");
        let body = &src[handle_at..];
        let started = body.find("\"finder:share-started\"").expect("must emit finder:share-started");
        let mint = body.find("let result =").expect("must run the mint into `let result`");
        let created = body.find("\"finder:share-created\"").expect("must emit finder:share-created");
        let failed = body.find("\"finder:share-failed\"").expect("must emit finder:share-failed");
        assert!(started < mint, "finder:share-started must be emitted before the mint runs");
        assert!(mint < created, "finder:share-created must come after the mint");
        assert!(mint < failed, "finder:share-failed must come after the mint");
    }
}
