//! Dispatch inbound Finder menu actions to the share engine (macOS).
//!
//! A "Share with Hippius" click forwarded by the extension carries an absolute
//! path but NOT a public/private choice — that decision moved into the app
//! (Google-Drive model). So [`handle`] does not mint: it resolves the display
//! name, parks the path in [`crate::app_state::AppState`] under a fresh id,
//! brings the app forward, and emits `finder:share-choosing{id,name}` to open
//! the share chooser. The user picks Anyone-with-the-link vs Password-protected
//! and confirms; the modal then calls [`super::commands::hcfs_finder_confirm_share`],
//! which takes the parked request back by id and mints via [`mint_confirmed`].
//!
//! Minting reuses the existing engine ([`super::resolve`] +
//! `crate::shares::commands`): an in-drive file shares by `(label,
//! relative_path)`, an outside file by raw bytes, and an in-drive folder mints
//! a live browsable link (one metadata POST — an outside folder has no drive
//! to browse and is refused). A password-protected choice additionally wraps
//! the key under a random password (`#p=`).
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

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

use crate::app_state::AppState;
use crate::error::{AppError, Result};

use crate::finder_bridge::protocol::ClientMessage;
use crate::finder_bridge::resolve::{ShareTarget, resolve_share_target};
use crate::shares::commands::{ShareChoice, ShareLink};
use hcfs_client::client::share::{ShareProgressFn, ShareTtl};

/// A "Share with Hippius" click parked in [`crate::app_state::AppState`] while
/// the app asks the user for the public/private choice. Holds the resolved path
/// and its display name; the confirm/cancel command takes it back by id (the id
/// itself is the map key, so it is not repeated here).
#[derive(Debug, Clone)]
pub struct PendingFinderShare {
    /// Absolute path the extension forwarded — minted only on confirm.
    pub path: PathBuf,
    /// The clicked file/folder's display name, shown in the chooser modal.
    pub name: String,
}

/// Payload for `finder:share-choosing`, emitted the instant a share is
/// requested from Finder — before anything is minted. Opens the app's share
/// chooser on the file so the user picks Anyone-with-the-link vs
/// Password-protected. The `id` is echoed back to
/// [`super::commands::hcfs_finder_confirm_share`] / `hcfs_finder_cancel_share`.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FinderShareChoosing {
    /// Opaque handle to the parked [`PendingFinderShare`]; the modal returns it
    /// verbatim so the backend mints the file it resolved (never one the
    /// renderer names).
    id: String,
    /// The clicked file/folder's display name, shown while choosing / minting.
    name: String,
    /// Size of the clicked file at the moment it was right-clicked. `None`
    /// for a directory (a folder share moves no bytes) and for an
    /// unreadable stat.
    ///
    /// The chooser shows this. It is the cheapest defence there is against
    /// sharing a file that has not finished arriving: on 2026-08-31 two zips
    /// were shared out of `~/Downloads` mid-download and both minted links to
    /// a 4 MiB prefix. Every byte-level check downstream was satisfied — the
    /// blobs were internally consistent — so the only thing that could have
    /// caught it was a human seeing "4.2 MB" next to a file they knew was
    /// 6.8 MB.
    size_bytes: Option<u64>,
    /// How long ago the clicked file was last modified, in seconds. `None`
    /// when unreadable or when the clock disagrees with the filesystem.
    ///
    /// A hint, never a gate. "Modified moments ago" is exactly as true of a
    /// still-downloading file as of one the user just saved on purpose, so
    /// the chooser cautions and lets them proceed.
    modified_secs_ago: Option<u64>,
}

/// Size (files only) and mtime age of the clicked path, for the chooser.
///
/// Every field is best-effort: a failed stat degrades the chooser to what it
/// showed before rather than failing a share the user asked for. A directory
/// reports no size — `len()` on one is filesystem bookkeeping, not the number
/// a person expects to see next to a folder.
fn source_stat(path: &Path) -> (Option<u64>, Option<u64>) {
    let Ok(meta) = std::fs::metadata(path) else {
        return (None, None);
    };
    let size = meta.is_file().then_some(meta.len());
    let age = meta.modified().ok().and_then(|m| m.elapsed().ok()).map(|d| d.as_secs());
    (size, age)
}

/// Handle a "Share with Hippius" click: resolve the display name, park the path
/// in [`AppState`] under a fresh id, bring the app forward, and emit
/// `finder:share-choosing` so the app opens its share chooser. Deliberately does
/// NOT mint — the public/private decision now happens in the app, and minting is
/// deferred to [`super::commands::hcfs_finder_confirm_share`] once the user
/// confirms.
pub async fn handle(app: AppHandle, message: ClientMessage) {
    let ClientMessage::Share(clicked) = message;
    let name = display_name(&clicked);
    let id = app.state::<AppState>().store_finder_share(PendingFinderShare {
        path: clicked.clone(),
        name: name.clone(),
    });
    // Bring the app forward so the chooser modal is visible immediately (the
    // modal lives in the main window).
    reveal_main_window(&app);
    // Stat once, here, so the chooser can show what it is about to share. The
    // size is logged too: the 2026-08-31 truncated shares were diagnosed from
    // exactly this number appearing as 4194304 in one log line and 6765321 in
    // the next, for the same path.
    let (size_bytes, modified_secs_ago) = source_stat(&clicked);
    info!(
        request_id = %id,
        path = %clicked.display(),
        size_bytes = ?size_bytes,
        modified_secs_ago = ?modified_secs_ago,
        "finder bridge: share requested; opening chooser",
    );
    // Target the main window only — `FinderShareListener` runs there, and the
    // borderless `tray-panel` webview must never drive the share modal.
    let _ = app.emit_to(
        "main",
        "finder:share-choosing",
        &FinderShareChoosing {
            id,
            name,
            size_bytes,
            modified_secs_ago,
        },
    );
}

/// Mint a share for a previously-parked path using the visibility the user chose
/// in the app. Public → a `#k=` link with no password; private → the same mint
/// wrapped under a freshly generated random password into a `#p=` link.
///
/// `progress`, when `Some`, streams encrypt→upload→finalize updates to the
/// modal's bar (see [`share_for_path`]).
///
/// The password (when the user chose a private share) is applied during the
/// mint itself, so there is no window in which an unintended public link
/// exists. The previous flow minted a public share and wrapped it afterwards,
/// which needed a compensating revoke whenever the wrap failed — that whole
/// branch is gone.
pub(super) async fn mint_confirmed(
    state: &AppState,
    clicked: &Path,
    ttl: ShareTtl,
    choice: ShareChoice,
    progress: Option<ShareProgressFn>,
) -> Result<ShareLink> {
    let is_private = matches!(choice, ShareChoice::Private { .. });
    let link = share_for_path(state, clicked, ttl, choice, progress).await?;
    info!(
        share_token = %link.share_token,
        path = %clicked.display(),
        is_private,
        "finder bridge: share link created",
    );
    Ok(link)
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

/// Mint a PUBLIC share for `clicked`, resolving its shape (in-drive file /
/// outside file / folder-as-zip) against the account's drive roots. `progress`,
/// when `Some`, is hcfs-client's encrypt→upload→finalize callback, forwarded so
/// the confirm modal can render a determinate bar during the (possibly slow)
/// upload of a big file or a zipped folder.
async fn share_for_path(
    state: &AppState,
    clicked: &Path,
    ttl: ShareTtl,
    choice: ShareChoice,
    progress: Option<ShareProgressFn>,
) -> Result<ShareLink> {
    let account_id = state.current_account_id()?;

    // Resolve file-vs-dir BEFORE the in-drive check so an in-drive folder
    // takes the mint path rather than `share_synced_file`, which rejects
    // directories.
    let metadata = tokio::fs::metadata(clicked).await?;
    let roots = crate::sync::paths::list_drive_roots(state.pool()?, &account_id).await?;
    if metadata.is_dir() {
        // An in-drive folder mints a live browsable link — one metadata POST,
        // so the mint ignores `progress` (there is nothing to stream) and the
        // gates all live inside `create_folder_share_inner`. Resolving against
        // `clicked` (canonical, from Finder) keeps a non-canonical spelling
        // from ever reaching the mint. An OUTSIDE folder has no drive whose
        // server state a recipient could browse; the zip fallback that used to
        // cover it is gone, so refuse with a message the modal can show.
        return match resolve_share_target(clicked, &roots) {
            ShareTarget::InDrive { label, relative_path } => {
                crate::shares::commands::create_folder_share_inner(state, &account_id, &label, &relative_path, ttl, choice).await
            }
            ShareTarget::Outside => Err(AppError::Validation(
                "Only folders inside a synced Hippius drive can be shared as a link.".into(),
            )),
        };
    }

    match resolve_share_target(clicked, &roots) {
        // In-drive file: mint by (label, relative_path) and record a reshare origin.
        ShareTarget::InDrive { label, relative_path } => {
            crate::shares::commands::share_synced_file(state, &account_id, &label, &relative_path, ttl, choice, progress).await
        }
        // Outside file: "upload & share" by streaming its bytes; no origin row.
        ShareTarget::Outside => crate::shares::commands::share_external_file(state, &account_id, clicked, ttl, choice, progress).await,
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

    /// Wire-shape pin for the `finder:share-choosing` payload the FE
    /// `FinderShareListener` reads. A serde rename here would leave the
    /// listener mapping `undefined` and a right-click doing nothing.
    #[test]
    fn finder_share_choosing_wire_shape() {
        use std::collections::BTreeSet;
        let json = serde_json::to_value(FinderShareChoosing {
            id: "req-1".into(),
            name: "a.txt".into(),
            size_bytes: Some(6_765_321),
            modified_secs_ago: Some(3),
        })
        .expect("serialize");
        let keys: BTreeSet<String> = json.as_object().expect("object").keys().cloned().collect();
        let expected: BTreeSet<String> = ["id", "name", "sizeBytes", "modifiedSecsAgo"].into_iter().map(String::from).collect();
        assert_eq!(
            keys, expected,
            "finder:share-choosing wire keys drifted (FE FinderShareListener reads these)"
        );
        assert_eq!(json["id"], "req-1");
        assert_eq!(json["name"], "a.txt");
        assert_eq!(json["sizeBytes"], 6_765_321u64);
        assert_eq!(json["modifiedSecsAgo"], 3u64);
    }

    /// An unreadable stat must degrade to nulls, not drop the keys — the FE
    /// distinguishes "no size available" from "size is zero", and a missing
    /// key would read as `undefined` on both.
    #[test]
    fn finder_share_choosing_carries_nulls_when_stat_is_unavailable() {
        let json = serde_json::to_value(FinderShareChoosing {
            id: "req-2".into(),
            name: "gone.txt".into(),
            size_bytes: None,
            modified_secs_ago: None,
        })
        .expect("serialize");
        assert!(json.get("sizeBytes").is_some_and(serde_json::Value::is_null));
        assert!(json.get("modifiedSecsAgo").is_some_and(serde_json::Value::is_null));
    }

    #[test]
    fn source_stat_reports_a_file_size_and_a_fresh_mtime() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("build.zip");
        std::fs::write(&file, vec![0u8; 2_048]).expect("write");

        let (size, age) = source_stat(&file);
        assert_eq!(size, Some(2_048), "a file reports its length");
        assert!(
            age.is_some_and(|secs| secs < 60),
            "a just-written file must look recently modified, got {age:?}",
        );
    }

    /// A folder share moves no bytes at mint time, so there is no size to
    /// show — and a directory's `len()` is filesystem bookkeeping, not
    /// anything a person would recognise.
    #[test]
    fn source_stat_reports_no_size_for_a_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (size, _age) = source_stat(dir.path());
        assert_eq!(size, None);
    }

    #[test]
    fn source_stat_degrades_to_none_on_an_unreadable_path() {
        let (size, age) = source_stat(Path::new("/definitely/not/a/real/path.zip"));
        assert_eq!(size, None);
        assert_eq!(age, None);
    }

    /// Pin the deferred-mint invariant against a silent refactor: `handle` must
    /// PARK the request (`store_finder_share`) and emit `finder:share-choosing`,
    /// and must NOT mint — no `share_for_path` / `mint_confirmed` call in its
    /// body. A refactor that reintroduced eager minting here would put the
    /// public/private decision back in Finder, defeating the whole redesign.
    /// Source-text pin scoped to `handle`'s body (bounded at the next `async fn`
    /// so `mint_confirmed`/`share_for_path` definitions below don't match).
    #[test]
    fn handle_defers_mint_and_emits_choosing() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/finder_bridge/dispatch.rs")).expect("read dispatch.rs");
        let handle_at = src.find("pub async fn handle(").expect("handle fn exists");
        let after_handle = &src[handle_at + "pub async fn handle(".len()..];
        let next_fn = after_handle.find("async fn ").map_or(after_handle.len(), |i| i);
        let body = &after_handle[..next_fn];
        assert!(
            body.contains("store_finder_share("),
            "handle must park the request via store_finder_share"
        );
        assert!(body.contains("\"finder:share-choosing\""), "handle must emit finder:share-choosing");
        assert!(
            !body.contains("mint_confirmed("),
            "handle must NOT mint — minting is deferred to the confirm command"
        );
        assert!(
            !body.contains("share_for_path("),
            "handle must NOT mint — minting is deferred to the confirm command"
        );
    }
}
