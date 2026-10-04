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
//! relative_path)`, an outside file by raw bytes, an in-drive folder mints
//! a live browsable link (one metadata POST), and an outside folder uploads a
//! copy of its files under the link's own key (`shares::outside_folder`). A
//! password-protected choice additionally wraps the key under a random
//! password (`#p=`).
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
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::app_state::AppState;
use crate::error::{AppError, Result};

use crate::finder_bridge::protocol::ClientMessage;
use crate::finder_bridge::resolve::{ShareTarget, resolve_share_target};
use crate::shares::commands::{ShareChoice, ShareLink};
use crate::shares::outside_folder::{OutsideFolderShare, SHARE_CANCELLED};
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

/// What the user confirmed in the chooser plus the handles that run the
/// mint: the progress sink and the modal's cancel token. Bundled so the mint
/// path stays within five parameters.
pub struct FinderMint {
    /// The expiry the user picked.
    pub ttl: ShareTtl,
    /// Anyone-with-the-link or password-protected.
    pub choice: ShareChoice,
    /// Encrypt/upload/finalize updates for the modal's bar.
    pub progress: Option<ShareProgressFn>,
    /// The modal's Cancel. Dropped-on-fire for single-request mints, handed
    /// into the upload for an outside folder (see [`share_for_path`]).
    pub cancel: CancellationToken,
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
    /// Size of the clicked file at the moment it was right-clicked, or the
    /// bytes an outside folder's copy would upload. `None` for an in-drive
    /// folder (its link moves no bytes), for an outside folder whose size
    /// could not be measured within `FOLDER_SIZE_BUDGET`, and for an
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
    /// The clicked path is a folder outside every drive, so confirming
    /// UPLOADS A COPY of it (removed when the link ends) rather than minting
    /// a live link. Rust decides this; the chooser only says so, because the
    /// live-link notice would be false for a copy.
    is_folder_copy: bool,
}

/// Size (files only) and mtime age of the clicked path, for the chooser.
///
/// Every field is best-effort: a failed stat degrades the chooser to what it
/// showed before rather than failing a share the user asked for. A directory
/// reports no size — `len()` on one is filesystem bookkeeping, not the number
/// a person expects to see next to a folder. A folder's size comes from
/// [`outside_folder_size`], and only for an outside folder.
fn source_stat(path: &Path) -> (Option<u64>, Option<u64>) {
    let Ok(meta) = std::fs::metadata(path) else {
        return (None, None);
    };
    let size = meta.is_file().then_some(meta.len());
    let age = meta.modified().ok().and_then(|m| m.elapsed().ok()).map(|d| d.as_secs());
    (size, age)
}

/// Route one inbound extension message. A badge query is answered from the
/// engine's in-memory state ([`super::badges`]); a click opens the share
/// chooser ([`handle_share`]). The two must never be confused: a query fires
/// for every row Finder scrolls past, a click is a user intent.
pub async fn handle(app: AppHandle, message: ClientMessage) {
    match message {
        ClientMessage::Share(clicked) => handle_share(app, clicked).await,
        ClientMessage::BadgeQuery(path) => super::badges::answer_badge_query(app, path).await,
    }
}

/// Handle a "Share with Hippius" click: resolve the display name, park the path
/// in [`AppState`] under a fresh id, bring the app forward, and emit
/// `finder:share-choosing` so the app opens its share chooser. Deliberately does
/// NOT mint — the public/private decision now happens in the app, and minting is
/// deferred to [`super::commands::hcfs_finder_confirm_share`] once the user
/// confirms.
async fn handle_share(app: AppHandle, clicked: PathBuf) {
    let name = display_name(&clicked);
    let id = app.state::<AppState>().store_finder_share(PendingFinderShare {
        path: clicked.clone(),
        name: name.clone(),
    });
    // Bring the app forward so the chooser modal is visible immediately (the
    // modal lives in the main window).
    reveal_main_window(&app);
    // Gathered once, before the chooser opens, so it can show what it is
    // about to share. The size is logged too: truncated shares of
    // half-downloaded files were diagnosed from exactly this number.
    let facts = chooser_facts(app.state::<AppState>().inner(), &clicked).await;
    // Measuring a folder takes up to `FOLDER_SIZE_BUDGET`, so a later click
    // can be ready first. Its chooser must stay; this request is dropped,
    // since nobody can confirm a chooser that never opened.
    if !app.state::<AppState>().finder_share_is_latest(&id) {
        app.state::<AppState>().take_finder_share(&id);
        info!(request_id = %id, "finder bridge: a later click superseded this share; chooser not opened");
        return;
    }
    info!(
        request_id = %id,
        path = %clicked.display(),
        size_bytes = ?facts.size_bytes,
        modified_secs_ago = ?facts.modified_secs_ago,
        is_folder_copy = facts.is_folder_copy,
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
            size_bytes: facts.size_bytes,
            modified_secs_ago: facts.modified_secs_ago,
            is_folder_copy: facts.is_folder_copy,
        },
    );
}

/// Mint a share for a previously-parked path using the visibility the user chose
/// in the app. Public → a `#k=` link with no password; private → the same mint
/// wrapped under a freshly generated random password into a `#p=` link.
///
/// `mint.progress`, when `Some`, streams encrypt→upload→finalize updates to
/// the modal's bar; `mint.cancel` is the modal's Cancel (see
/// [`share_for_path`]).
///
/// The password (when the user chose a private share) is applied during the
/// mint itself, so there is no window in which an unintended public link
/// exists. The previous flow minted a public share and wrapped it afterwards,
/// which needed a compensating revoke whenever the wrap failed — that whole
/// branch is gone.
///
/// Public (not `pub(super)`) so the mock-server suite can drive a cancel
/// through the same path the confirm command takes.
///
/// # Errors
///
/// Whatever the chosen mint refuses with, plus a `Validation` carrying
/// [`SHARE_CANCELLED`] when the modal's Cancel fired.
pub async fn mint_confirmed(state: &AppState, clicked: &Path, mint: FinderMint) -> Result<ShareLink> {
    let is_private = matches!(mint.choice, ShareChoice::Private { .. });
    let link = share_for_path(state, clicked, mint).await?;
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

/// Mint a share for `clicked` by its shape: an in-drive file or folder, an
/// outside file, or an outside folder (uploaded as a copy). `mint.progress`,
/// when `Some`, is hcfs-client's encrypt→upload→finalize callback, forwarded
/// so the confirm modal can render a determinate bar during a slow upload.
async fn share_for_path(state: &AppState, clicked: &Path, mint: FinderMint) -> Result<ShareLink> {
    let account_id = state.current_account_id()?;

    // Resolve file-vs-dir BEFORE the in-drive check so an in-drive folder
    // takes the mint path rather than `share_synced_file`, which rejects
    // directories.
    let metadata = tokio::fs::metadata(clicked).await?;
    let roots = crate::sync::paths::list_drive_roots(state.pool()?, &account_id).await?;
    let FinderMint {
        ttl,
        choice,
        progress,
        cancel,
    } = mint;

    if metadata.is_dir() {
        // Resolving against `clicked` (canonical, from Finder) keeps a
        // non-canonical spelling from ever reaching either mint.
        return match resolve_share_target(clicked, &roots) {
            // A live browsable link: one metadata POST, nothing to stream,
            // and every gate lives inside `create_folder_share_inner`.
            ShareTarget::InDrive { label, relative_path } => {
                let mint = crate::shares::commands::create_folder_share_inner(state, &account_id, &label, &relative_path, ttl, choice);
                until_cancelled(&cancel, mint).await
            }
            // No drive a recipient could browse, so the files are uploaded
            // as a copy under the link's own key. The token goes INTO the
            // upload so the client can abort the half-built link on the
            // server; racing it here would drop the future before that
            // abort is sent.
            ShareTarget::Outside => {
                let request = OutsideFolderShare {
                    folder: clicked,
                    ttl,
                    choice,
                    progress,
                    cancel,
                };
                crate::shares::outside_folder::share_outside_folder(state, &account_id, request).await
            }
        };
    }

    match resolve_share_target(clicked, &roots) {
        // In-drive file: mint by (label, relative_path) and record a reshare origin.
        ShareTarget::InDrive { label, relative_path } => {
            let mint = crate::shares::commands::share_synced_file(state, &account_id, &label, &relative_path, ttl, choice, progress);
            until_cancelled(&cancel, mint).await
        }
        // Outside file: "upload & share" by streaming its bytes; no origin row.
        ShareTarget::Outside => {
            let mint = crate::shares::commands::share_external_file(state, &account_id, clicked, ttl, choice, progress);
            until_cancelled(&cancel, mint).await
        }
    }
}

/// Run a mint that has no cancel hook of its own, dropping it when the
/// modal's Cancel fires. Dropping aborts its in-flight request; whatever a
/// dropped file upload leaves behind is collected by the server's share
/// reaper.
async fn until_cancelled(cancel: &CancellationToken, mint: impl std::future::Future<Output = Result<ShareLink>>) -> Result<ShareLink> {
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(AppError::Validation(SHARE_CANCELLED.into())),
        minted = mint => minted,
    }
}

/// How long the chooser waits for an outside folder's size before opening
/// without one. The modal must appear promptly after a right-click.
const FOLDER_SIZE_BUDGET: std::time::Duration = std::time::Duration::from_secs(2);

/// What the chooser shows about the clicked path.
struct ChooserFacts {
    /// Bytes the share would move, when known.
    size_bytes: Option<u64>,
    /// Seconds since the clicked path was last modified, when known.
    modified_secs_ago: Option<u64>,
    /// Confirming uploads a copy of an outside folder.
    is_folder_copy: bool,
}

/// Gather the chooser's facts. Only an outside folder is sized: it is the
/// only folder share that uploads (and bills) bytes.
async fn chooser_facts(state: &AppState, clicked: &Path) -> ChooserFacts {
    let (size_bytes, modified_secs_ago) = source_stat(clicked);
    let is_folder_copy = clicked.is_dir() && is_outside_every_drive(state, clicked).await;
    let size_bytes = if is_folder_copy {
        outside_folder_size(clicked).await
    } else {
        size_bytes
    };
    ChooserFacts {
        size_bytes,
        modified_secs_ago,
        is_folder_copy,
    }
}

/// Whether `clicked` resolves to no registered drive. Any failure reads as
/// "inside": the chooser then shows what it showed before, and the confirm
/// path resolves the target again with real errors.
async fn is_outside_every_drive(state: &AppState, clicked: &Path) -> bool {
    let Ok(account_id) = state.current_account_id() else {
        return false;
    };
    let Ok(pool) = state.pool() else {
        return false;
    };
    match crate::sync::paths::list_drive_roots(pool, &account_id).await {
        Ok(roots) => matches!(resolve_share_target(clicked, &roots), ShareTarget::Outside),
        Err(error) => {
            warn!(%error, "finder bridge: could not list drive roots for the chooser");
            false
        }
    }
}

/// Bytes an outside folder's copy would upload. It is the same scan the
/// share runs, so the number shown is the number billed.
///
/// Bounded twice: the scan refuses past the link's file and directory caps,
/// and the chooser stops waiting after [`FOLDER_SIZE_BUDGET`], which drops
/// the scan's future and so stops the walk too. A refusal (empty, too many
/// items) reads as "no size" here; the confirm reports it with its message.
async fn outside_folder_size(folder: &Path) -> Option<u64> {
    let scan = crate::shares::folder_scan::scan_until_dropped(folder.to_path_buf());
    match tokio::time::timeout(FOLDER_SIZE_BUDGET, scan).await {
        Ok(Ok(Ok(scan))) => Some(scan.total_bytes),
        _ => None,
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
            is_folder_copy: true,
        })
        .expect("serialize");
        let keys: BTreeSet<String> = json.as_object().expect("object").keys().cloned().collect();
        let expected: BTreeSet<String> = ["id", "name", "sizeBytes", "modifiedSecsAgo", "isFolderCopy"]
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(
            keys, expected,
            "finder:share-choosing wire keys drifted (FE FinderShareListener reads these)"
        );
        assert_eq!(json["id"], "req-1");
        assert_eq!(json["name"], "a.txt");
        assert_eq!(json["sizeBytes"], 6_765_321u64);
        assert_eq!(json["modifiedSecsAgo"], 3u64);
        assert_eq!(json["isFolderCopy"], true);
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
            is_folder_copy: false,
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
        // `elapsed()` returns Err when the filesystem stamps an mtime ahead of
        // the process clock — which some CI filesystems do — and production
        // reads that as "unknown" and simply shows no caution. Accept that
        // outcome rather than flake on it; the threshold decision itself is
        // pinned deterministically on the FE side, where
        // `RECENTLY_MODIFIED_SECS` is applied to a supplied number.
        if let Some(secs) = age {
            assert!(secs < 60, "a just-written file must look recent, got {secs}");
        }
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

    /// The chooser's number for an outside folder is the scan's total — the
    /// bytes the copy uploads and the gate bills — not a directory `len()`,
    /// and not counting the hidden files the share skips.
    #[tokio::test]
    async fn an_outside_folder_is_sized_by_the_share_scan() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("T2-KD");
        std::fs::create_dir_all(root.join("sub")).expect("dirs");
        std::fs::write(root.join("a.txt"), vec![0u8; 2_048]).expect("a");
        std::fs::write(root.join("sub/b.txt"), vec![0u8; 1_000]).expect("b");
        std::fs::write(root.join(".DS_Store"), vec![0u8; 9_999]).expect("hidden, not billed");

        assert_eq!(outside_folder_size(&root).await, Some(3_048));
    }

    /// A folder the share would refuse shows no size rather than "0 B". The
    /// confirm, not the chooser, explains the refusal.
    #[tokio::test]
    async fn a_folder_the_share_would_refuse_has_no_size() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(outside_folder_size(dir.path()).await, None);
    }

    /// A logged-in state whose only drive is rooted at `drive_root`, on an
    /// in-memory database holding just the columns `list_drive_roots` reads.
    async fn state_with_drive(drive_root: &Path) -> AppState {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory db");
        sqlx::query("CREATE TABLE sync_paths (owner TEXT NOT NULL, path TEXT NOT NULL, label TEXT NOT NULL)")
            .execute(&pool)
            .await
            .expect("sync_paths");
        let account = "5ChooserAcct";
        sqlx::query("INSERT INTO sync_paths (owner, path, label) VALUES (?, ?, 'docs')")
            .bind(crate::auth::account_key::account_key(account))
            .bind(drive_root.to_string_lossy().into_owned())
            .execute(&pool)
            .await
            .expect("drive row");

        let state = AppState::new();
        state.set_pool(pool);
        state
            .set_active_account(account, crate::auth::state::AuthCapabilities::default())
            .expect("account");
        state
    }

    /// A tree with a drive (holding a folder) beside an outside folder and
    /// an outside file, each with known bytes.
    fn drive_and_outside_tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("Drive/Photos")).expect("drive folder");
        std::fs::write(dir.path().join("Drive/Photos/p.jpg"), vec![0u8; 500]).expect("p");
        std::fs::create_dir_all(dir.path().join("Outside")).expect("outside folder");
        std::fs::write(dir.path().join("Outside/a.txt"), vec![0u8; 1_200]).expect("a");
        std::fs::write(dir.path().join("loose.zip"), vec![0u8; 7_000]).expect("file");
        dir
    }

    /// An in-drive folder mints a live link: no copy, and no size (nothing
    /// is uploaded).
    #[tokio::test]
    async fn the_chooser_treats_an_in_drive_folder_as_a_live_link() {
        let tree = drive_and_outside_tree();
        let state = state_with_drive(&tree.path().join("Drive")).await;

        let facts = chooser_facts(&state, &tree.path().join("Drive/Photos")).await;

        assert!(!facts.is_folder_copy);
        assert_eq!(facts.size_bytes, None);
    }

    /// A folder outside every drive is uploaded as a copy, sized by the scan.
    #[tokio::test]
    async fn the_chooser_treats_an_outside_folder_as_a_sized_copy() {
        let tree = drive_and_outside_tree();
        let state = state_with_drive(&tree.path().join("Drive")).await;

        let facts = chooser_facts(&state, &tree.path().join("Outside")).await;

        assert!(facts.is_folder_copy);
        assert_eq!(facts.size_bytes, Some(1_200));
    }

    /// A file is never a folder copy, wherever it lives; its size is its stat.
    #[tokio::test]
    async fn the_chooser_sizes_a_file_by_its_stat() {
        let tree = drive_and_outside_tree();
        let state = state_with_drive(&tree.path().join("Drive")).await;

        let facts = chooser_facts(&state, &tree.path().join("loose.zip")).await;

        assert!(!facts.is_folder_copy);
        assert_eq!(facts.size_bytes, Some(7_000));
    }

    #[test]
    fn source_stat_degrades_to_none_on_an_unreadable_path() {
        let (size, age) = source_stat(Path::new("/definitely/not/a/real/path.zip"));
        assert_eq!(size, None);
        assert_eq!(age, None);
    }

    /// Pin the deferred-mint invariant against a silent refactor: a click
    /// (`handle_share`) must PARK the request (`store_finder_share`) and emit
    /// `finder:share-choosing`, and must NOT mint — no `share_for_path` /
    /// `mint_confirmed` call in its body. A refactor that reintroduced eager
    /// minting here would put the public/private decision back in Finder,
    /// defeating the whole redesign. Source-text pin scoped to
    /// `handle_share`'s body (bounded at the next `async fn` so
    /// `mint_confirmed`/`share_for_path` definitions below don't match).
    #[test]
    fn handle_defers_mint_and_emits_choosing() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/finder_bridge/dispatch.rs")).expect("read dispatch.rs");
        // The router must send a click to `handle_share` and a badge query to
        // the badge feed — a query arriving in the share path would open the
        // chooser for every row Finder scrolls past.
        let router_at = src.find("pub async fn handle(").expect("handle fn exists");
        let router = &src[router_at..src[router_at..].find("\n}\n").expect("router closes") + router_at];
        assert!(
            router.contains("ClientMessage::Share(clicked) => handle_share("),
            "handle routes a click to handle_share"
        );
        assert!(
            router.contains("ClientMessage::BadgeQuery(path) => super::badges::answer_badge_query("),
            "handle routes a query to the badge feed"
        );

        let handle_at = src.find("async fn handle_share(").expect("handle_share fn exists");
        let after_handle = &src[handle_at + "async fn handle_share(".len()..];
        let next_fn = after_handle.find("async fn ").unwrap_or(after_handle.len());
        let body = &after_handle[..next_fn];
        assert!(
            body.contains("store_finder_share("),
            "handle must park the request via store_finder_share"
        );
        assert!(body.contains("\"finder:share-choosing\""), "handle must emit finder:share-choosing");
        let latest_at = body.find("finder_share_is_latest(").expect("handle must drop a superseded click");
        assert!(
            latest_at < body.find("\"finder:share-choosing\"").expect("emit"),
            "a superseded click is dropped before the emit, or its chooser replaces the newer one"
        );
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
