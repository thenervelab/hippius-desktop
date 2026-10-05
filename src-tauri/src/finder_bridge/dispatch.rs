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
    /// Stops the chooser's scan of an outside folder. Fired when this
    /// request can no longer use the size: a newer click replaced its
    /// chooser, the confirm took it (the share scans again), or the chooser
    /// was closed. Without it the walk ran up to [`FOLDER_FACTS_BUDGET`]
    /// for nobody, and repeated clicks stacked walks on the blocking pool.
    pub scan_stop: CancellationToken,
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
    /// Size of the clicked file at the moment it was right-clicked. `None`
    /// for every folder and for an unreadable stat: an in-drive folder's
    /// link moves no bytes, and an outside folder's copy is measured after
    /// the chooser opens and arrives in `finder:share-facts`
    /// ([`FinderShareFacts`]).
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
    /// The clicked path is a folder. With `is_folder_copy` false it is in a
    /// drive and gets a live link, so the chooser words it as a folder, says
    /// the link shows the current contents, and waits with a spinner: the
    /// mint is one request with no upload to show progress for.
    is_folder: bool,
    /// The clicked path is a folder outside every drive, so confirming
    /// UPLOADS A COPY of it (removed when the link ends) rather than minting
    /// a live link. Rust decides this; the chooser only says so, because the
    /// live-link notice would be false for a copy.
    ///
    /// `None` when the drive roots could not be read, so nobody knows which
    /// it is: the chooser then shows neither notice, since either promise
    /// could be false. The confirm resolves the target again.
    is_folder_copy: Option<bool>,
}

/// Payload for `finder:share-facts`, the follow-up to `finder:share-choosing`
/// for a folder that will be uploaded as a copy. Scanning the folder can
/// take seconds, so the chooser opens first and this brings what the scan
/// found. Emitted only while `id` is still the latest click, so a replaced
/// chooser never shows another folder's size.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FinderShareFacts {
    /// The request this measures, as sent in `finder:share-choosing`.
    id: String,
    /// The bytes the copy would upload (and bill); `None` when the scan
    /// refused the folder or did not finish within [`FOLDER_FACTS_BUDGET`].
    size_bytes: Option<u64>,
    /// The share's own refusal of this folder (empty, too many items, a
    /// name a link cannot hold, ...), serialized as `{kind, message}`. The
    /// chooser shows the message verbatim and disables Confirm, since the
    /// confirm would refuse with the same sentence after the user chose.
    refusal: Option<AppError>,
}

/// Size (files only) and mtime age of the clicked path, for the chooser.
///
/// Every field is best-effort: a failed stat degrades the chooser to what it
/// showed before rather than failing a share the user asked for. A directory
/// reports no size — `len()` on one is filesystem bookkeeping, not the number
/// a person expects to see next to a folder. A folder's size comes from
/// [`outside_folder_facts`], and only for an outside folder.
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
    let scan_stop = CancellationToken::new();
    let id = app.state::<AppState>().store_finder_share(PendingFinderShare {
        path: clicked.clone(),
        name: name.clone(),
        scan_stop: scan_stop.clone(),
    });
    // Bring the app forward so the chooser modal is visible immediately (the
    // modal lives in the main window).
    reveal_main_window(&app);
    // Gathered once, before the chooser opens, so it can show what it is
    // about to share. The size is logged too: truncated shares of
    // half-downloaded files were diagnosed from exactly this number. Only
    // a stat and a drive-roots query: the chooser must open promptly.
    let facts = chooser_facts(app.state::<AppState>().inner(), &clicked).await;
    // A later click can still be ready first. Its chooser must stay; this
    // request is dropped, since nobody can confirm a chooser that never
    // opened.
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
        is_folder = facts.is_folder,
        is_folder_copy = ?facts.is_folder_copy,
        "finder bridge: share requested; opening chooser",
    );
    // Target the main window only — `FinderShareListener` runs there, and the
    // borderless `tray-panel` webview must never drive the share modal.
    let choosing = FinderShareChoosing {
        id: id.clone(),
        name,
        size_bytes: facts.size_bytes,
        modified_secs_ago: facts.modified_secs_ago,
        is_folder: facts.is_folder,
        is_folder_copy: facts.is_folder_copy,
    };
    if let Err(error) = app.emit_to("main", "finder:share-choosing", &choosing) {
        warn!(request_id = %id, %error, "finder bridge: could not open the chooser");
        return;
    }

    // Sized after the chooser is up. This task is the click's own (the
    // socket loop spawns one per click), so the wait blocks nothing else.
    if facts.is_folder_copy != Some(true) {
        return;
    }
    let Some(folder_facts) = folder_facts_for_latest(app.state::<AppState>().inner(), &id, &clicked, &scan_stop).await else {
        info!(request_id = %id, "finder bridge: folder facts dropped; the request was replaced, confirmed or cancelled");
        return;
    };
    info!(
        request_id = %id,
        size_bytes = ?folder_facts.size_bytes,
        refused = folder_facts.refusal.is_some(),
        "finder bridge: outside folder measured for the chooser",
    );
    if let Err(error) = app.emit_to("main", "finder:share-facts", &folder_facts) {
        warn!(request_id = %id, %error, "finder bridge: could not bring the folder facts to the chooser");
    }
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
    // Matched in both spellings: a stored root that misses Finder's
    // canonical path would send an in-drive folder down the copy path.
    let roots = crate::sync::paths::with_canonical_roots(roots).await;
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

/// How long an outside folder's scan may run for the chooser. The chooser is
/// already open, so this only bounds the walk itself (a slow network volume
/// would otherwise hold a blocking-pool thread for nobody); past it the
/// chooser shows no size, and the confirm scans again.
const FOLDER_FACTS_BUDGET: std::time::Duration = std::time::Duration::from_secs(30);

/// What the chooser shows about the clicked path.
struct ChooserFacts {
    /// Bytes the share would move, when known.
    size_bytes: Option<u64>,
    /// Seconds since the clicked path was last modified, when known.
    modified_secs_ago: Option<u64>,
    /// The clicked path is a folder, in a drive or not.
    is_folder: bool,
    /// Confirming uploads a copy of an outside folder; `None` when that
    /// could not be told (see [`FinderShareChoosing::is_folder_copy`]).
    is_folder_copy: Option<bool>,
}

/// Where the clicked path sits relative to the account's drives, as far as
/// the chooser can tell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Placement {
    /// Under a registered drive root.
    InDrive,
    /// Under no registered drive root.
    Outside,
    /// The drive roots could not be read.
    Unknown,
}

/// Gather the facts the chooser opens with: no folder is sized here (see
/// [`folder_facts_for_latest`] for the one that is).
async fn chooser_facts(state: &AppState, clicked: &Path) -> ChooserFacts {
    let (size_bytes, modified_secs_ago) = source_stat(clicked);
    let is_folder = clicked.is_dir();
    let is_folder_copy = if is_folder {
        match placement(state, clicked).await {
            Placement::InDrive => Some(false),
            Placement::Outside => Some(true),
            Placement::Unknown => None,
        }
    } else {
        Some(false)
    };
    ChooserFacts {
        size_bytes,
        modified_secs_ago,
        is_folder,
        is_folder_copy,
    }
}

/// Where `clicked` sits among the account's drives. Any failure reads as
/// [`Placement::Unknown`] rather than either answer: guessing "inside"
/// would promise a live link for what may be a copy, and the reverse. The
/// confirm path resolves the target again with real errors.
async fn placement(state: &AppState, clicked: &Path) -> Placement {
    let Ok(account_id) = state.current_account_id() else {
        return Placement::Unknown;
    };
    let Ok(pool) = state.pool() else {
        return Placement::Unknown;
    };
    match crate::sync::paths::list_drive_roots(pool, &account_id).await {
        Ok(roots) => match resolve_share_target(clicked, &crate::sync::paths::with_canonical_roots(roots).await) {
            ShareTarget::InDrive { .. } => Placement::InDrive,
            ShareTarget::Outside => Placement::Outside,
        },
        Err(error) => {
            warn!(%error, "finder bridge: could not list drive roots for the chooser");
            Placement::Unknown
        }
    }
}

/// Measure an outside folder for request `id`, returning the facts only if
/// `id` is still the latest click once the scan is done. A newer click has
/// replaced the chooser by then, and these facts would land on it. `stop`
/// is the request's [`PendingFinderShare::scan_stop`]; once it fires there
/// is nobody to show the facts to, so nothing comes back.
async fn folder_facts_for_latest(state: &AppState, id: &str, folder: &Path, stop: &CancellationToken) -> Option<FinderShareFacts> {
    let (size_bytes, refusal) = match drive_holding_refusal(state, folder).await {
        Some(refusal) => (None, Some(refusal)),
        None => outside_folder_facts(folder, stop).await?,
    };
    state.finder_share_is_latest(id).then(|| FinderShareFacts {
        id: id.to_owned(),
        size_bytes,
        refusal,
    })
}

/// The share's refusal of a folder that holds a drive, so the chooser shows
/// it before the user confirms and no walk of that drive starts. Anything
/// short of a refusal (no account, a database error) reads as none: the
/// confirm checks again with real errors.
async fn drive_holding_refusal(state: &AppState, folder: &Path) -> Option<AppError> {
    let account_id = state.current_account_id().ok()?;
    match crate::shares::outside_folder::refuse_a_folder_holding_a_drive(state, &account_id, folder).await {
        Ok(()) => None,
        Err(refusal @ AppError::Validation(_)) => Some(refusal),
        Err(error) => {
            warn!(%error, "finder bridge: could not check the chooser's folder against the drives");
            None
        }
    }
}

/// Bytes an outside folder's copy would upload, or the share's refusal of
/// the folder. It is the same scan the share runs, so the number shown is
/// the number billed and the refusal is the one the confirm would give.
///
/// Bounded twice: the scan refuses past the link's file and directory caps,
/// and [`FOLDER_FACTS_BUDGET`] drops the scan's future, which stops the
/// walk too. Past the budget, or if the scan task dies, neither is known.
/// `None` when `stop` fired first (see [`facts_until_stopped`]).
async fn outside_folder_facts(folder: &Path, stop: &CancellationToken) -> Option<(Option<u64>, Option<AppError>)> {
    let scan = crate::shares::folder_scan::scan_until_dropped(folder.to_path_buf());
    facts_until_stopped(scan, stop).await
}

/// What [`crate::shares::folder_scan::scan_until_dropped`] resolves to.
type ScanOutcome = std::result::Result<Result<crate::shares::folder_scan::FolderScan>, tokio::task::JoinError>;

/// Run the chooser's `scan` within [`FOLDER_FACTS_BUDGET`] unless `stop`
/// fires first. A fired `stop` drops `scan`, and dropping the real scan
/// raises its walk's stop flag, so the blocking walk ends within one
/// directory instead of running out the budget for a chooser nobody sees.
async fn facts_until_stopped(
    scan: impl std::future::Future<Output = ScanOutcome>,
    stop: &CancellationToken,
) -> Option<(Option<u64>, Option<AppError>)> {
    let budgeted = tokio::select! {
        biased;
        () = stop.cancelled() => {
            info!("finder bridge: the chooser's folder scan stopped; its request is gone");
            return None;
        }
        budgeted = tokio::time::timeout(FOLDER_FACTS_BUDGET, scan) => budgeted,
    };
    Some(match budgeted {
        Ok(Ok(Ok(scan))) => (Some(scan.total_bytes), None),
        Ok(Ok(Err(refusal))) => (None, Some(refusal)),
        Ok(Err(error)) => {
            warn!(%error, "finder bridge: the chooser's folder scan task failed");
            (None, None)
        }
        Err(_elapsed) => {
            info!("finder bridge: the chooser's folder scan ran past its budget; no size shown");
            (None, None)
        }
    })
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
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

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
            is_folder: true,
            is_folder_copy: Some(true),
        })
        .expect("serialize");
        let keys: BTreeSet<String> = json.as_object().expect("object").keys().cloned().collect();
        let expected: BTreeSet<String> = ["id", "name", "sizeBytes", "modifiedSecsAgo", "isFolder", "isFolderCopy"]
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
        assert_eq!(json["isFolder"], true);
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
            is_folder: true,
            is_folder_copy: None,
        })
        .expect("serialize");
        assert!(json.get("sizeBytes").is_some_and(serde_json::Value::is_null));
        assert!(json.get("modifiedSecsAgo").is_some_and(serde_json::Value::is_null));
        // Unknown placement is an explicit null, which the FE tells apart
        // from an older backend's missing key (read as "not a copy").
        assert!(json.get("isFolderCopy").is_some_and(serde_json::Value::is_null));
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

    /// Wire-shape pin for `finder:share-facts`, the follow-up that brings an
    /// outside folder's size (or the share's refusal) to the open chooser.
    /// A drifted key would leave the chooser measuring forever.
    #[test]
    fn finder_share_facts_wire_shape() {
        use std::collections::BTreeSet;
        let sized = serde_json::to_value(FinderShareFacts {
            id: "req-1".into(),
            size_bytes: Some(3_048),
            refusal: None,
        })
        .expect("serialize");
        let keys: BTreeSet<String> = sized.as_object().expect("object").keys().cloned().collect();
        let expected: BTreeSet<String> = ["id", "sizeBytes", "refusal"].into_iter().map(String::from).collect();
        assert_eq!(
            keys, expected,
            "finder:share-facts wire keys drifted (FE FinderShareListener reads these)"
        );
        assert_eq!(sized["id"], "req-1");
        assert_eq!(sized["sizeBytes"], 3_048u64);
        assert!(sized["refusal"].is_null(), "no refusal is an explicit null");

        let refused = serde_json::to_value(FinderShareFacts {
            id: "req-2".into(),
            size_bytes: None,
            refusal: Some(AppError::Validation("This folder has no files to share.".into())),
        })
        .expect("serialize");
        assert!(refused["sizeBytes"].is_null());
        assert_eq!(refused["refusal"]["kind"], "Validation");
        assert_eq!(refused["refusal"]["message"], "This folder has no files to share.", "verbatim");
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

        let (size, refusal) = outside_folder_facts(&root, &CancellationToken::new()).await.expect("not stopped");
        assert_eq!(size, Some(3_048));
        assert!(refusal.is_none(), "{refusal:?}");
    }

    /// A folder the share would refuse shows no size rather than "0 B", and
    /// carries the share's own refusal so the chooser can say it before the
    /// user confirms.
    #[tokio::test]
    async fn a_folder_the_share_would_refuse_carries_the_refusal() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (size, refusal) = outside_folder_facts(dir.path(), &CancellationToken::new()).await.expect("not stopped");
        assert_eq!(size, None);
        assert!(
            matches!(&refusal, Some(AppError::Validation(m)) if m.contains("no files to share")),
            "{refusal:?}"
        );
    }

    /// The facts reach the chooser only while their click is the latest: a
    /// newer click has replaced the chooser, and the older folder's size
    /// would otherwise be shown next to the newer name.
    #[tokio::test]
    async fn folder_facts_are_dropped_once_a_later_click_replaces_the_chooser() {
        let tree = drive_and_outside_tree();
        let state = state_with_drive(&tree.path().join("Drive")).await;
        let folder = tree.path().join("Outside");
        let park = |state: &AppState| {
            let scan_stop = CancellationToken::new();
            let id = state.store_finder_share(PendingFinderShare {
                path: folder.clone(),
                name: "Outside".into(),
                scan_stop: scan_stop.clone(),
            });
            (id, scan_stop)
        };

        let (first, first_stop) = park(&state);
        let facts = folder_facts_for_latest(&state, &first, &folder, &first_stop).await.expect("latest");
        assert_eq!((facts.id.as_str(), facts.size_bytes), (first.as_str(), Some(1_200)));

        let (second, second_stop) = park(&state);
        assert!(
            folder_facts_for_latest(&state, &first, &folder, &first_stop).await.is_none(),
            "superseded"
        );
        assert!(folder_facts_for_latest(&state, &second, &folder, &second_stop).await.is_some());
    }

    /// A scan that never finishes on its own, standing in for the walk of
    /// a huge or slow folder. `dropped` goes up exactly when the future is
    /// dropped, as `StopOnDrop` raises the real walk's stop flag.
    fn endless_scan(dropped: &Arc<AtomicBool>) -> impl std::future::Future<Output = ScanOutcome> {
        struct FlagOnDrop(Arc<AtomicBool>);

        impl Drop for FlagOnDrop {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let guard = FlagOnDrop(Arc::clone(dropped));
        async move {
            let _guard = guard;
            std::future::pending().await
        }
    }

    /// A request that stops mid-scan (a newer click, the confirm, or the
    /// chooser closing) drops the scan at once, which stops the walk,
    /// instead of letting it run out its 30 s budget for nobody.
    #[tokio::test]
    async fn a_stopped_request_drops_its_folder_scan_at_once() {
        let dropped = Arc::new(AtomicBool::new(false));
        let stop = CancellationToken::new();
        let facts = facts_until_stopped(endless_scan(&dropped), &stop);
        let fire = async {
            tokio::task::yield_now().await;
            stop.cancel();
        };

        let (facts, ()) = tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(facts, fire) })
            .await
            .expect("the scan stops well inside its 30 s budget");

        assert!(facts.is_none(), "a stopped request has no facts to show");
        assert!(dropped.load(Ordering::SeqCst), "the scan future is dropped, which stops the walk");
    }

    /// Each way a click stops being able to use its chooser's size fires
    /// its scan stop: a newer click, the confirm taking it, a cancel.
    #[test]
    fn a_newer_click_a_confirm_or_a_cancel_stops_the_chooser_scan() {
        let state = AppState::new();
        let park = |state: &AppState| {
            let scan_stop = CancellationToken::new();
            let id = state.store_finder_share(PendingFinderShare {
                path: PathBuf::from("/x/Outside"),
                name: "Outside".into(),
                scan_stop: scan_stop.clone(),
            });
            (id, scan_stop)
        };

        let (_superseded, superseded_stop) = park(&state);
        let (taken, taken_stop) = park(&state);
        assert!(superseded_stop.is_cancelled(), "a newer click stops the older scan");
        assert!(!taken_stop.is_cancelled(), "the latest click keeps scanning");

        state.take_finder_share(&taken);
        assert!(taken_stop.is_cancelled(), "the confirm scans again, so the chooser's scan stops");

        let (cancelled, cancelled_stop) = park(&state);
        state.cancel_finder_share(&cancelled);
        assert!(cancelled_stop.is_cancelled(), "a closed chooser stops its scan");
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

        assert!(facts.is_folder, "the chooser words it as a folder link");
        assert_eq!(facts.is_folder_copy, Some(false));
        assert_eq!(facts.size_bytes, None);
    }

    /// Finder sends canonical paths; a drive stored through a symlink must
    /// still hold its folders, or an in-drive folder would be copied.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_chooser_matches_a_drive_stored_through_a_symlink() {
        let tree = drive_and_outside_tree();
        let linked = tree.path().join("linked");
        std::os::unix::fs::symlink(tree.path(), &linked).expect("symlink");
        let state = state_with_drive(&linked.join("Drive")).await;
        let clicked = std::fs::canonicalize(tree.path().join("Drive/Photos")).expect("canonical");

        let facts = chooser_facts(&state, &clicked).await;

        assert_eq!(facts.is_folder_copy, Some(false), "a live link, not a copy");
    }

    /// A folder that holds a drive is refused in the chooser, naming the
    /// drive folder, before any walk of it; a folder beside the drive is not.
    #[tokio::test]
    async fn the_chooser_refuses_a_folder_that_holds_a_drive() {
        let tree = drive_and_outside_tree();
        let state = state_with_drive(&tree.path().join("Drive")).await;

        let refusal = drive_holding_refusal(&state, tree.path()).await.expect("refused");
        let AppError::Validation(message) = refusal else {
            panic!("expected a sentence, got {refusal:?}");
        };
        assert!(message.contains("holds your Hippius drive folder \u{201c}Drive\u{201d}"), "{message}");
        assert!(drive_holding_refusal(&state, &tree.path().join("Outside")).await.is_none());
    }

    /// A folder outside every drive is uploaded as a copy. The chooser opens
    /// before it is sized: the scan can take seconds, and its total follows
    /// in `finder:share-facts`.
    #[tokio::test]
    async fn the_chooser_opens_on_an_outside_folder_before_it_is_sized() {
        let tree = drive_and_outside_tree();
        let state = state_with_drive(&tree.path().join("Drive")).await;

        let facts = chooser_facts(&state, &tree.path().join("Outside")).await;

        assert!(facts.is_folder);
        assert_eq!(facts.is_folder_copy, Some(true));
        assert_eq!(facts.size_bytes, None, "sized later, not before the chooser opens");
    }

    /// A file is never a folder copy, wherever it lives; its size is its stat.
    #[tokio::test]
    async fn the_chooser_sizes_a_file_by_its_stat() {
        let tree = drive_and_outside_tree();
        let state = state_with_drive(&tree.path().join("Drive")).await;

        let facts = chooser_facts(&state, &tree.path().join("loose.zip")).await;

        assert!(!facts.is_folder);
        assert_eq!(facts.is_folder_copy, Some(false));
        assert_eq!(facts.size_bytes, Some(7_000));
    }

    /// When the drive roots cannot be read, nobody knows whether the
    /// folder is in a drive. The chooser must then promise neither a live
    /// link nor an uploaded copy (either could be false), and size nothing:
    /// the confirm resolves the target again and reports real errors.
    #[tokio::test]
    async fn the_chooser_promises_nothing_when_the_drive_roots_are_unreadable() {
        let tree = drive_and_outside_tree();
        let state = state_with_drive(&tree.path().join("Drive")).await;
        sqlx::query("DROP TABLE sync_paths")
            .execute(state.pool().expect("pool"))
            .await
            .expect("drop");

        for folder in ["Drive/Photos", "Outside"] {
            let facts = chooser_facts(&state, &tree.path().join(folder)).await;

            assert!(facts.is_folder, "{folder} still reads as a folder");
            assert_eq!(facts.is_folder_copy, None, "{folder}: unknown, neither a copy nor a live link");
            assert_eq!(facts.size_bytes, None, "{folder}: nothing is sized");
        }
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
        let measure_at = body.find("folder_facts_for_latest(").expect("handle sizes an outside folder");
        assert!(
            body.find("\"finder:share-choosing\"").expect("emit") < measure_at,
            "the chooser opens before the folder is scanned, not after"
        );
        assert!(
            measure_at < body.find("\"finder:share-facts\"").expect("handle emits the facts"),
            "the facts are emitted from the latest-click check"
        );
        // A dropped emit leaves the chooser closed, or measuring forever,
        // with nothing in the support bundle to say why.
        assert!(!body.contains("let _ = app.emit_to("), "handle must log a failed emit, not discard it");
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
