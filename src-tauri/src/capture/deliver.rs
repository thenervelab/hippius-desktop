//! From a file on disk to a link on the clipboard.
//!
//! Every step reuses an existing path. For a drive synced on this machine the
//! capture is moved into its `Captures` folder and the sync engine uploads it,
//! like any file the user saves there: one row in the sync queue, and no
//! second copy synced back down (a direct upload into a synced drive was
//! downloaded straight back by the engine and listed twice). For a drive
//! that is only on the server, the upload is the remote file upload (same
//! drive resolution, storage gate and upload-widget rows as a dropped file).
//! The link is the "share any file on disk" path the Finder uses. Nothing here
//! bills or talks to the server itself.

use std::path::Path;

use hcfs_client::client::share::ShareProgressFn;
use serde::Serialize;

use super::destination::CaptureDestination;
use super::preview::FailureReason;
use crate::app_state::AppState;
use crate::error::{AppError, Result};

/// What happened to a capture once it was taken.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivered {
    pub file_name: String,
    /// The drive's display name, for "Saved to …".
    pub drive_name: String,
    /// The folder in the drive it went into (`Captures` unless changed).
    pub folder: String,
    /// `None` when the file was saved but the link could not be minted.
    pub share_url: Option<String>,
    /// Why the link is missing, in Rust's words, when it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_error: Option<String>,
    /// The file went into a synced folder and the sync engine uploads it;
    /// false when it was uploaded directly.
    pub via_sync: bool,
    /// The share's token, for Revoke on the card. Never sent anywhere.
    #[serde(skip)]
    pub share_token: Option<String>,
    /// The file on this machine after delivery: in the synced folder, or the
    /// temp copy a direct upload read from. Never sent anywhere.
    #[serde(skip)]
    pub placed: std::path::PathBuf,
}

/// Whether a direct upload's temp copy stays after the upload landed: while
/// it has no link, so the card's "Create link" has a file to make one from,
/// and for a screenshot, so the card's Edit has the picture to open (the
/// card removes it when it closes). A synced capture's copy is the drive's
/// own file, never the temp one.
#[must_use]
pub fn keep_temp_after_upload(via_sync: bool, has_link: bool, editable: bool) -> bool {
    !via_sync && (!has_link || editable)
}

/// The query parameter that tells the share page a load is the owner's own:
/// it records no view or viewer for it and takes the parameter out of the
/// address bar.
pub const OWNER_VIEW_PARAM: &str = "owner=1";

/// `url` as the app opens it for its owner: [`OWNER_VIEW_PARAM`] added to
/// the query, before the `#` fragment, which holds the link's key and is
/// left exactly as it is. Only for the app opening the link itself; a copied
/// link never carries it.
#[must_use]
pub fn owner_view_url(url: &str) -> String {
    let (base, fragment) = url.find('#').map_or((url, ""), |i| url.split_at(i));
    let separator = match base.find('?') {
        None => "?",
        Some(_) if base.ends_with('?') || base.ends_with('&') => "",
        Some(_) => "&",
    };
    format!("{base}{separator}{OWNER_VIEW_PARAM}{fragment}")
}

/// Where a capture is once it has been put in the drive, before any link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placed {
    /// The file on this machine: in the synced folder, or the temp copy a
    /// direct upload read from.
    pub placed: std::path::PathBuf,
    /// The file went into a synced folder and the sync engine uploads it;
    /// false when it was uploaded directly (and so is on the server now).
    pub via_sync: bool,
    /// Its name in the capture folder (a synced folder may have renamed it).
    pub file_name: String,
}

/// The destination drive's folder on this machine, where [`place`] moves a
/// capture for the sync engine to upload; `None` when the capture is
/// uploaded to the drive directly (a drive that is not synced here, a
/// paused one, or another account's).
///
/// # Errors
///
/// When the database cannot be read.
pub async fn local_root(state: &AppState, account_id: &str, destination: &CaptureDestination) -> Result<Option<std::path::PathBuf>> {
    if destination.owner_ss58.is_some() {
        return Ok(None);
    }
    super::destination::own_local_path(state.pool()?, account_id, &destination.label).await
}

/// Put `file` in the destination's capture folder: moved into the drive's
/// folder on this machine (the sync engine uploads it), or uploaded
/// directly to a drive that is only on the server.
///
/// A synced capture returns as soon as it is in the folder. The cycle that
/// uploads it is started, not waited for: waiting meant waiting for a whole
/// sync round of every drive, the upload included, and the card said
/// "Preparing upload" all that time although the sync queue already showed
/// the file synced. The card follows the engine instead (`spawn_sync_follow`).
///
/// A failed upload is an `Err` and leaves `file` where it is: a long recording
/// must not be lost because the network dropped at the end.
///
/// `backup`: the capture's link already made its own copy on the server, so
/// a direct upload here is its backup into the drive, and the upload list
/// says so ("Backing up to Drive") rather than showing a second upload.
///
/// # Errors
///
/// Whatever the upload refused with, including `NotReady(StorageLimitReached)`
/// from the storage gate, which the UI answers with the plans dialog.
pub async fn place(
    state: &AppState,
    app: tauri::AppHandle,
    account_id: &str,
    destination: &CaptureDestination,
    file: &Path,
    backup: bool,
) -> Result<Placed> {
    let local_root = local_root(state, account_id, destination).await?;

    // Read before the move, while the file is still the one recorded.
    let capture = tokio::task::spawn_blocking({
        let file = file.to_path_buf();
        move || super::recording_length::capture_for(&file)
    })
    .await
    .map_err(|e| AppError::Other(format!("capture length task failed: {e}")))?;

    let (placed, via_sync) = if let Some(root) = local_root {
        refuse_missing_root(&root)?;
        let config_dir = crate::sync::mnemonic::config_dir_for_folder(account_id, &destination.label)?;
        let placed = tokio::task::spawn_blocking({
            let file = file.to_path_buf();
            let dir = root.join(&destination.folder);
            move || {
                let placed = place_in_folder(&dir, &file)?;
                if let Some(capture) = capture {
                    declare_placed(&root, &config_dir, &placed, capture);
                }
                Ok::<_, AppError>(placed)
            }
        })
        .await
        .map_err(|e| AppError::Other(format!("capture move task failed: {e}")))??;
        // Start a cycle now rather than waiting for the watcher, so the
        // upload shows in the sync queue straight away. Not awaited: see above.
        tauri::async_runtime::spawn(async move {
            if let Err(e) = crate::sync::control::trigger_sync_now(app).await {
                tracing::warn!(error = %e, "capture saved to the sync folder; sync not nudged");
            }
        });
        (placed, true)
    } else {
        let source = file
            .to_str()
            .ok_or_else(|| AppError::Other("Capture path is not valid UTF-8".into()))?
            .to_string();
        let failures = crate::sync::remote_upload::upload_files_to_remote_folder_inner(
            state,
            app,
            account_id,
            &destination.label,
            destination.upload_folder(),
            &[source],
            destination.owner_ss58.clone(),
            destination.folder_hash.clone(),
            capture,
            backup,
        )
        .await?;
        if let Some(failure) = failures.into_iter().next() {
            return Err(failure.cause);
        }
        (file.to_path_buf(), false)
    };
    let file_name = placed
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::Other("Capture file has no name".into()))?
        .to_string();
    Ok(Placed { placed, via_sync, file_name })
}

/// Declare `capture` for the capture just moved to `placed` in the synced
/// drive at `root`, so every upload of it tells the server what it is
/// (`recording_length`).
///
/// Right after the move, not before it: the name is only known once the move
/// has claimed it (`move_into` takes the next free one), and a declaration
/// for a guessed name would mark whatever file holds that name instead.
///
/// hcfs documents "declare before the file enters the sync root". This
/// relies instead on where hcfs reads the declaration at the pinned rev:
/// when it builds the file's upload manifest (`drive/upload.rs`), after the
/// scan, hash and encryption. Nothing orders the two, but a cycle that found
/// the file the moment it landed would still have all of that to do before
/// it looked, against one small file write here. Accepted: losing that race
/// means one recording uploads uncounted. One that cannot be written is
/// logged and the capture still syncs; the server then does not count it.
pub fn declare_placed(root: &Path, config_dir: &Path, placed: &Path, capture: hcfs_shared::network::Capture) {
    let Ok(relative) = placed.strip_prefix(root) else {
        tracing::warn!("capture: placed outside its drive's folder; not declared");
        return;
    };
    if let Err(e) = hcfs_client::drive::Drive::with_config_dir(root, config_dir).declare_capture(relative, capture) {
        tracing::warn!(error = %e, "capture: not declared; it syncs, and the server does not count it");
    }
}

/// What minting a placed capture's link came to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Minted {
    pub share_url: Option<String>,
    pub share_token: Option<String>,
    /// Why there is no link, in Rust's words, when there is none.
    pub link_error: Option<String>,
}

/// Mint the public link to a capture from its own file, BEFORE it is placed
/// (`commands::deliver_and_announce`): the link's upload then has the
/// connection to itself, where it used to share it with the drive's upload
/// of the same file (a synced drive) or wait for that upload to finish (a
/// drive only on the server). The file it records as the link's origin is
/// only known once placed, so [`remember_placed_origin`] does that after.
///
/// A failed LINK is not an error: the capture is still put in the drive, and
/// the card says the link could not be made rather than that the capture
/// failed. `progress` follows the link's upload for the card.
///
/// `on_link`, when given, is offered the link the moment it exists, while
/// the file is still uploading ([`mint_reporting_link`]); this still
/// returns only once the upload has finished or failed.
pub async fn link_from_file(state: &AppState, account_id: &str, file: &Path, progress: Option<ShareProgressFn>, on_link: Option<OnLink>) -> Minted {
    match mint_reporting_link(state, account_id, &LinkSource::External(file.to_path_buf()), progress, on_link).await {
        Ok(link) => Minted {
            share_url: Some(link.share_url),
            share_token: Some(link.share_token),
            link_error: None,
        },
        Err(message) => Minted {
            link_error: Some(message),
            ..Minted::default()
        },
    }
}

/// After a link made by [`link_from_file`], once the capture is placed:
/// record which file in the drive it is the link of (`shares::origin`), and
/// mark a synced file shared in Finder, as a link minted from the synced
/// file itself does (`create_share_inner`). That is how Drive, Insights, the
/// tray's Copy link and deleting the capture find the link by its path.
pub async fn remember_placed_origin(state: &AppState, account_id: &str, destination: &CaptureDestination, placed: &Placed, share_token: &str) {
    let rel_path = destination.rel_path(&placed.file_name);
    remember_origin(
        state,
        account_id,
        &LinkSource::External(placed.placed.clone()),
        &destination.label,
        &rel_path,
        share_token,
    )
    .await;
    if placed.via_sync {
        crate::finder_bridge::badges::push_from_state(state, &destination.label, &rel_path, crate::finder_bridge::protocol::BadgeState::Shared);
    }
}

impl Delivered {
    /// The broadcast and notification shape for a placed capture and its link.
    #[must_use]
    pub fn from_parts(placed: &Placed, minted: &Minted, destination: &CaptureDestination) -> Self {
        Self {
            file_name: placed.file_name.clone(),
            drive_name: destination.display_name.clone(),
            folder: destination.folder.clone(),
            share_url: minted.share_url.clone(),
            link_error: minted.link_error.clone(),
            via_sync: placed.via_sync,
            share_token: minted.share_token.clone(),
            placed: placed.placed.clone(),
        }
    }
}

/// After a capture's link is minted from its temp copy (a direct upload,
/// [`LinkSource::External`]): record which file in the drive it is the link
/// of, as a link made from a synced file records it (`shares::origin`). That
/// is how Drive, Insights and deleting the capture find the link by its path
/// rather than by its name. Best effort: the link is already out.
pub async fn remember_origin(state: &AppState, account_id: &str, source: &LinkSource, label: &str, rel_path: &str, share_token: &str) {
    let Ok(pool) = state.pool() else { return };
    let owner = crate::auth::account_key::account_key(account_id);
    if let Err(e) = record_origin(pool, &owner, source, label, rel_path, share_token).await {
        tracing::warn!(error = %e, "capture link's file not recorded; it is found by its name instead");
    }
}

/// [`remember_origin`] on a pool: only an external source is recorded here
/// (a synced file's share records its own origin when it is minted).
async fn record_origin(pool: &sqlx::SqlitePool, owner: &str, source: &LinkSource, label: &str, rel_path: &str, share_token: &str) -> Result<()> {
    match source {
        LinkSource::External(_) if !label.is_empty() && !rel_path.is_empty() => {
            crate::shares::origin::record(pool, share_token, owner, label, rel_path).await
        }
        _ => Ok(()),
    }
}

/// Where a capture's link is made from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkSource {
    /// A file in a drive synced here, by its path in the drive: the share
    /// records its origin, so Drive shows the file as shared and its share
    /// dialog lists (and can revoke) the link.
    Synced { label: String, rel_path: String },
    /// A file on disk outside any synced folder (the temp copy of a direct
    /// upload), shared the way the Finder's "Share with Hippius" does.
    External(std::path::PathBuf),
}

/// Mint the capture's public, never-expiring link through the existing share
/// paths. The error is Rust's sentence for the card.
///
/// # Errors
///
/// The sentence the card shows when no link could be made.
pub async fn mint(
    state: &AppState,
    account_id: &str,
    source: &LinkSource,
    progress: Option<ShareProgressFn>,
) -> std::result::Result<crate::shares::commands::ShareLink, String> {
    mint_reporting_link(state, account_id, source, progress, None).await
}

/// A capture's link the moment it exists, before its file has finished
/// uploading: what [`mint_reporting_link`] hands to its `on_link`.
pub struct EarlyLink {
    pub share_url: String,
    pub share_token: String,
}

impl std::fmt::Debug for EarlyLink {
    // The URL carries the link's secret and the token opens the share.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EarlyLink { .. }")
    }
}

/// Offered a capture's link as soon as it exists (see [`EarlyLink`]), and
/// answers whether it handed the link out. Only a link handed out stops a
/// later failure from being retried: once someone may have it, a new link
/// would be a different one nobody was given. Called at most once per mint.
/// Cheap and panic-free, since it runs inside the upload.
pub type OnLink = std::sync::Arc<dyn Fn(EarlyLink) -> bool + Send + Sync>;

/// Whether the server answers someone who opens a link still uploading with
/// "still uploading" (`share_open_while_uploading`, `409 share_uploading`)
/// rather than the "not found" an older server gives. Only then is a
/// capture's link handed out before its upload ends. No answer reads as no.
pub async fn server_shows_uploading(state: &AppState, account_id: &str) -> bool {
    crate::shares::capabilities::fetch_capabilities(state, account_id)
        .await
        .is_ok_and(|caps| caps.share_open_while_uploading)
}

/// The card's (and notification's) sentence for a link that was copied
/// while its file uploaded, and whose upload then failed: hcfs-client
/// revoked it, so the copied link never opens.
pub const LINK_BROKEN: &str = "The link you copied won't open because its upload failed. Retry to make a new link.";

/// [`mint`], also offering the link to `on_link` the moment it exists, while
/// a large file is still uploading. Only for [`LinkSource::External`], the
/// capture's own file: a synced file's link is never offered to `on_link`,
/// and comes back only when the mint returns.
///
/// A failure before the link was handed out is tried again as in [`mint`].
/// One after `on_link` took it is not: that link is already out and is now
/// revoked, and a new one would be a different link nobody was given. It
/// comes back as [`LINK_BROKEN`].
///
/// # Errors
///
/// The sentence the card shows when no link could be made.
pub async fn mint_reporting_link(
    state: &AppState,
    account_id: &str,
    source: &LinkSource,
    progress: Option<ShareProgressFn>,
    on_link: Option<OnLink>,
) -> std::result::Result<crate::shares::commands::ShareLink, String> {
    use crate::shares::commands::ShareChoice;
    use hcfs_client::client::share::ShareTtl;
    use std::sync::atomic::{AtomicBool, Ordering};
    let reported = std::sync::Arc::new(AtomicBool::new(false));
    let mut attempt = 0;
    loop {
        let minted = match source {
            LinkSource::Synced { label, rel_path } => {
                crate::shares::commands::share_synced_file(state, account_id, label, rel_path, ShareTtl::Never, ShareChoice::Public, progress.clone())
                    .await
            }
            LinkSource::External(path) => {
                let report = on_link.clone().map(|on_link| {
                    let reported = reported.clone();
                    Box::new(move |link: &hcfs_client::client::share::ShareResult| {
                        let handed_out = on_link(EarlyLink {
                            share_url: link.share_url.clone(),
                            share_token: link.share_token.clone(),
                        });
                        // Read back on this same task once the mint returns.
                        reported.store(handed_out, Ordering::Relaxed);
                    }) as hcfs_client::client::share::ShareLinkFn
                });
                crate::shares::commands::share_external_file_reporting_link(
                    state,
                    account_id,
                    path,
                    ShareTtl::Never,
                    ShareChoice::Public,
                    progress.clone(),
                    report,
                )
                .await
            }
        };
        let e = match minted {
            Ok(link) => return Ok(link),
            Err(e) => e,
        };
        if reported.load(Ordering::Relaxed) {
            tracing::warn!(error = %e, "capture link was handed out, then its upload failed; the link is revoked");
            return Err(LINK_BROKEN.to_string());
        }
        let Some(wait) = mint_retry_after(failure_reason(&e), attempt) else {
            tracing::warn!(error = %e, "capture saved, but its share link could not be minted");
            return Err(link_failure_copy(&e));
        };
        tracing::info!(error = %e, attempt, "capture link not made yet; trying again");
        tokio::time::sleep(wait).await;
        attempt += 1;
    }
}

/// After a capture link made later (the card's "Create link", an edited
/// screenshot's new link): send its chat preview when Settings has "Show a
/// preview in chats" on, as a capture's first link does. In the background
/// and best-effort; the link is already out.
pub async fn spawn_preview_if_wanted(app: &tauri::AppHandle, state: &AppState, account_id: &str, source: &LinkSource, share_token: &str) {
    let Ok(pool) = state.pool() else { return };
    if !super::bar::load_options(pool).await.map_or(true, |o| o.chat_preview) {
        return;
    }
    let path = match source {
        LinkSource::External(path) => path.clone(),
        LinkSource::Synced { label, rel_path } => match super::destination::own_local_path(pool, account_id, label).await {
            Ok(Some(root)) => root.join(rel_path),
            _ => return,
        },
    };
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
        return;
    };
    crate::shares::preview::spawn_upload(app.clone(), account_id.to_owned(), share_token.to_owned(), path, file_name, false);
}

/// After a capture link made later (the card's "Create link", an edited
/// screenshot's new link): turn on its Insights, Comments and Reactions when
/// Settings has "Track views, comments and reactions" on, as a capture's
/// first link does. In the background and best-effort.
pub async fn spawn_link_settings(app: &tauri::AppHandle, state: &AppState, account_id: &str, share_token: &str) {
    let wanted = crate::shares::insights::for_capture(crate::shares::insights::captures_default(state).await);
    crate::shares::insights::spawn_apply(app, account_id, share_token, wanted);
}

/// How long to wait before making a capture's link again after failed
/// attempt `attempt` (0 = the first), or `None` to give up. A request that
/// did not get through (offline, a server that did not answer, a dropped
/// connection) is often fine a second later, and without a link nothing is
/// copied or opened, so it is tried three times in all. A full drive is not
/// going to change in seconds, so it is never retried.
#[must_use]
pub fn mint_retry_after(reason: FailureReason, attempt: u32) -> Option<std::time::Duration> {
    const WAITS_MS: [u64; 2] = [1_000, 3_000];
    if reason == FailureReason::StorageFull {
        return None;
    }
    WAITS_MS
        .get(usize::try_from(attempt).ok()?)
        .map(|ms| std::time::Duration::from_millis(*ms))
}

/// The sentence for a link that could not be made. Never reqwest's own words.
/// Also the tray popover's "Copy link" failure copy (`shares::quick_link`).
#[must_use]
pub fn link_failure_copy(e: &AppError) -> String {
    match failure_reason(e) {
        FailureReason::Offline => "You're offline. Create the link when you're back online.".into(),
        FailureReason::StorageFull => STORAGE_FULL.into(),
        FailureReason::NeedsFolder | FailureReason::Other => "The link couldn't be created. Try again in a moment.".into(),
    }
}

pub const OFFLINE: &str = "You're offline. Retry when you're back online.";
pub const STORAGE_FULL: &str = "Storage is full. Upgrade your plan to upload this capture.";
const UPLOAD_FAILED: &str = "The capture couldn't be uploaded. Retry in a moment.";

/// What kind of failure `e` is, for the card's next step.
#[must_use]
pub fn failure_reason(e: &AppError) -> FailureReason {
    match e {
        // The free plan's recordings used up reads like a full plan: Upgrade
        // is the way on (Retry once an older recording is deleted).
        AppError::NotReady(
            crate::error::NotReadyKind::StorageLimitReached
            | crate::error::NotReadyKind::RecordingLimitReached
            | crate::error::NotReadyKind::RecordingTooLong,
        ) => FailureReason::StorageFull,
        other if is_offline_shaped(&other.to_string()) => FailureReason::Offline,
        _ => FailureReason::Other,
    }
}

/// The card's and the notification's sentence for a failed upload. A
/// transport error's own text ("Network unreachable (os error 51)") never
/// reaches the user; a refusal Rust already worded (a `Validation`) does.
#[must_use]
pub fn failure_copy(e: &AppError) -> String {
    match failure_reason(e) {
        FailureReason::Offline => OFFLINE.into(),
        FailureReason::StorageFull if matches!(e, AppError::NotReady(crate::error::NotReadyKind::RecordingLimitReached)) => {
            super::recording_allowance::LIMIT_KEPT.into()
        }
        FailureReason::StorageFull if matches!(e, AppError::NotReady(crate::error::NotReadyKind::RecordingTooLong)) => {
            crate::sync::events::recording_too_long_copy()
        }
        FailureReason::StorageFull => STORAGE_FULL.into(),
        FailureReason::NeedsFolder | FailureReason::Other => match e {
            AppError::Validation(message) => message.clone(),
            AppError::NotReady(crate::error::NotReadyKind::RecordingCountUnavailable) => super::recording_allowance::COUNT_UNAVAILABLE.into(),
            _ => UPLOAD_FAILED.into(),
        },
    }
}

/// The same classification for a sync-engine row's error text, which is all
/// the engine gives for a file it could not upload.
#[must_use]
pub fn sync_failure_copy(error: Option<&str>) -> (String, FailureReason) {
    let error = error.unwrap_or_default();
    let lower = error.to_ascii_lowercase();
    // The server's recording refusals, in the words Rust gave the row
    // (`FileFailureKindPayload::RecordingLimit`). Matched before the needles
    // below, which they do not contain, so they read as what they are rather
    // than "the sync queue will try again", which an upgrade alone fixes.
    if error == crate::sync::events::recording_limit_reached_copy() || error == crate::sync::events::recording_too_long_copy() {
        return (error.to_string(), FailureReason::StorageFull);
    }
    if ["returned 402", "status 402", "payment required", "storage limit", "quota"]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        (STORAGE_FULL.into(), FailureReason::StorageFull)
    } else if is_offline_shaped(error) {
        (OFFLINE.into(), FailureReason::Offline)
    } else {
        ("Couldn't upload yet. The sync queue will try again.".into(), FailureReason::Other)
    }
}

/// A transport failure: no route, no DNS, nothing answering. The request-send
/// and connect shapes the sync widget also reads as a network failure, plus
/// the OS's own "network is unreachable" / "no route" codes (51 and 65 on
/// macOS, 101 and 113 on Linux, 10051 and 10065 on Windows). Not the widget's
/// broken-off download body: a capture card only uploads.
fn is_offline_shaped(message: &str) -> bool {
    let lower = message.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    lower.starts_with("network error:")
        || [
            "error sending request for url",
            // hcfs drops the URL since #608: `error sending request: <cause>`.
            "error sending request:",
            "error trying to connect",
            "connection refused",
            "connection reset",
            "dns error",
            "failed to lookup address",
            "network is unreachable",
            "network unreachable",
            "no route to host",
            "internet connection appears to be offline",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
        || ["51", "65", "101", "113", "10051", "10065"]
            .iter()
            .any(|code| lower.contains(&format!("(os error {code})")))
}

/// What a capture says when its drive's folder on this computer is gone.
pub const CAPTURES_FOLDER_MISSING: &str = "Your Captures folder was moved or deleted. Choose it again in Settings.";

/// Refuse to deliver into a synced drive whose folder is gone (moved,
/// renamed, deleted, or on a disk that is not plugged in).
///
/// Making it again would hand the sync engine an empty folder holding one
/// new capture, which it could read as every earlier capture deleted here,
/// and delete them from the server too. The drive was set up, so its folder
/// existed: first-time setup makes the folder before the drive is added
/// (`setup::add_drive`), so it never lands here.
///
/// # Errors
///
/// [`CAPTURES_FOLDER_MISSING`] when `root` is not a folder.
pub fn refuse_missing_root(root: &Path) -> Result<()> {
    if root.is_dir() {
        return Ok(());
    }
    tracing::warn!("capture not delivered: its drive's folder on this computer is gone; not making it again");
    Err(AppError::Validation(CAPTURES_FOLDER_MISSING.into()))
}

/// Whether delivery failed because the captures folder is gone.
#[must_use]
pub fn is_missing_root(e: &AppError) -> bool {
    matches!(e, AppError::Validation(message) if message == CAPTURES_FOLDER_MISSING)
}

/// Move `file` into `dir` (created if needed) under a name nothing there has.
///
/// Never overwrites: the name is claimed with a hard link, which fails when
/// the name exists, so a same-named file that appears between the check and
/// the move is kept (the next free name is taken instead). Across volumes
/// (the temp folder on the boot disk, the drive on an external one) the file
/// is copied first under a hidden name the sync engine skips, flushed, and
/// only then given its real name: a copy that fails half-way never leaves a
/// truncated capture under a real name for the engine to upload.
fn place_in_folder(dir: &Path, file: &Path) -> Result<std::path::PathBuf> {
    place_in_folder_with(dir, file, Path::exists, false, |from, to| std::fs::copy(from, to))
}

/// Keep a capture in `dir` on this computer, never overwriting: where a
/// capture waits while no drive can be set up (`capture::setup`).
///
/// # Errors
///
/// The move or copy failed; `file` is left where it was.
pub fn keep_in_folder(dir: &Path, file: &Path) -> Result<std::path::PathBuf> {
    place_in_folder(dir, file)
}

/// [`place_in_folder`] with the name check and the copy injected, and the
/// same-volume move skipped when `force_copy`, so tests can fail each step.
fn place_in_folder_with(
    dir: &Path,
    file: &Path,
    exists: impl Fn(&Path) -> bool,
    force_copy: bool,
    copy: impl Fn(&Path, &Path) -> std::io::Result<u64>,
) -> Result<std::path::PathBuf> {
    std::fs::create_dir_all(dir)?;
    let name = file
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::Other("Capture file has no name".into()))?;
    // Already there: a capture kept in the folder while no drive could be
    // set up, sent again once the folder became the drive's. Moving it onto
    // itself would only rename it to "name (2)".
    if file.parent() == Some(dir) {
        return Ok(file.to_path_buf());
    }

    if !force_copy {
        match move_into(dir, name, file, &exists) {
            Ok(target) => return Ok(target),
            Err(e) if !crosses_devices(&e) => return Err(e.into()),
            Err(_) => {}
        }
    }

    // Another volume: a hidden staging copy the engine never lists or uploads.
    let staging = dir.join(format!(".hippius-incoming-capture-{}.part", uuid::Uuid::new_v4().simple()));
    // Opened for writing: Windows refuses to flush a read-only handle
    // (FlushFileBuffers needs write access), so `File::open` failed here
    // with "Access is denied" on every cross-volume capture.
    let copied = copy(file, &staging).and_then(|_| std::fs::OpenOptions::new().write(true).open(&staging)?.sync_all());
    if let Err(e) = copied {
        let _ = std::fs::remove_file(&staging);
        return Err(e.into());
    }
    match move_into(dir, name, &staging, &exists) {
        Ok(target) => {
            // The capture is safely in the drive; a temp copy that will not
            // go away is only clutter, cleared with its folder later.
            if let Err(e) = std::fs::remove_file(file) {
                tracing::warn!(error = %e, "capture copied into the drive; its temp copy was not removed");
            }
            Ok(target)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&staging);
            Err(e.into())
        }
    }
}

/// Give `from` the first free `name` in `dir`, never replacing a file there,
/// and drop `from`'s old name. A cross-volume `from` is an error the caller
/// answers by copying.
fn move_into(dir: &Path, name: &str, from: &Path, exists: &impl Fn(&Path) -> bool) -> std::io::Result<std::path::PathBuf> {
    use std::io::{Error, ErrorKind};
    for _ in 0..MOVE_ATTEMPTS {
        let target = free_name(dir, name, exists).ok_or_else(|| Error::new(ErrorKind::AlreadyExists, "no free name for the capture"))?;
        match std::fs::hard_link(from, &target) {
            Ok(()) => {
                if let Err(e) = std::fs::remove_file(from) {
                    tracing::warn!(error = %e, "capture placed; its old name was not removed");
                }
                return Ok(target);
            }
            // Taken since the check: try the next free name.
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
            Err(e) if crosses_devices(&e) => return Err(e),
            // A volume without hard links (FAT, some network shares): a
            // rename, straight after seeing the name free, is the best left.
            Err(_) => {
                if target.exists() {
                    continue;
                }
                std::fs::rename(from, &target)?;
                return Ok(target);
            }
        }
    }
    Err(Error::new(ErrorKind::AlreadyExists, "no free name for the capture"))
}

const MOVE_ATTEMPTS: usize = 8;

/// A move that must be a copy: `from` and the target are on different volumes.
fn crosses_devices(e: &std::io::Error) -> bool {
    // EXDEV on Unix; ERROR_NOT_SAME_DEVICE (17) on Windows.
    let code = if cfg!(windows) { 17 } else { 18 };
    e.kind() == std::io::ErrorKind::CrossesDevices || e.raw_os_error() == Some(code)
}

/// `dir/name`, or the first of `name (2)`, `name (3)`… that `exists` says is
/// free; `None` when every one is taken (never an existing name to overwrite).
fn free_name(dir: &Path, name: &str, exists: impl Fn(&Path) -> bool) -> Option<std::path::PathBuf> {
    let first = dir.join(name);
    if !exists(&first) {
        return Some(first);
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..=9_999).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !exists(p))
}

/// The notification a delivered capture posts: `(title, body)`.
pub fn delivered_notice(delivered: &Delivered) -> (String, String) {
    let place = if delivered.folder.is_empty() {
        delivered.drive_name.clone()
    } else {
        format!("{} › {}", delivered.drive_name, delivered.folder)
    };
    let saved = format!("{} is in {place}.", delivered.file_name);
    if delivered.share_url.is_some() {
        ("Link copied".into(), saved)
    } else if delivered.link_error.as_deref() == Some(LINK_BROKEN) {
        // The link was copied while it uploaded, and is already in someone's
        // chat: "could not be created" would hide that it won't open.
        ("Capture saved".into(), format!("{saved} {LINK_BROKEN}"))
    } else {
        ("Capture saved".into(), format!("{saved} The share link could not be created."))
    }
}

/// The notification a capture that could not be uploaded posts. It says
/// where to act, never a path: the kept file is in a hidden folder, and the
/// card (or the next capture, which brings the card back) is where Retry is.
pub fn failed_notice(error: &AppError, card_showing: bool) -> (String, String) {
    let reason = failure_copy(error);
    let next = if card_showing {
        "Retry from the capture card."
    } else {
        "Hippius Drive kept it and offers it again on your next capture."
    };
    ("Capture not uploaded".into(), format!("{reason} {next}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A capture's link made from its temp copy records the file in the
    /// drive it belongs to, so it is found by its path (Insights, deleting
    /// the capture); a synced file's share records its own, elsewhere.
    #[tokio::test]
    async fn a_direct_uploads_link_records_its_file_in_the_drive() {
        let dir = tempfile::TempDir::new().unwrap();
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(dir.path().join("t.db"))
            .create_if_missing(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        crate::utils::schema::ensure_table_schema(&pool).await.unwrap();
        let external = LinkSource::External(std::path::PathBuf::from("/tmp/capture-1/Recording.mp4"));
        record_origin(&pool, "owner", &external, "Hippius Captures", "Captures/Recording.mp4", "tok-ext")
            .await
            .unwrap();
        let synced = LinkSource::Synced {
            label: "Hippius Captures".into(),
            rel_path: "Captures/Shot.png".into(),
        };
        record_origin(&pool, "owner", &synced, "Hippius Captures", "Captures/Shot.png", "tok-sync")
            .await
            .unwrap();
        let rows = crate::shares::origin::fetch_for_tokens(&pool, "owner", &["tok-ext", "tok-sync"])
            .await
            .unwrap();
        let ext = rows.get("tok-ext").expect("the direct upload's link is recorded");
        assert_eq!(
            (ext.folder_label.as_str(), ext.relative_path.as_str()),
            ("Hippius Captures", "Captures/Recording.mp4")
        );
        assert!(!rows.contains_key("tok-sync"), "a synced share records its own origin when minted");
    }

    /// The sentence for a copied link whose upload failed names the link
    /// the user already has, and the way on; it never reads like the link
    /// was simply not made.
    #[test]
    fn a_broken_link_is_told_apart_from_one_never_made() {
        assert!(LINK_BROKEN.contains("you copied"));
        assert!(LINK_BROKEN.contains("Retry"));
        let never = link_failure_copy(&AppError::Other("x".into()));
        assert_ne!(never, LINK_BROKEN);
        assert!(
            !format!(
                "{:?}",
                EarlyLink {
                    share_url: "https://h/share/t#s=secret".into(),
                    share_token: "t".into()
                }
            )
            .contains("secret")
        );
    }

    /// A recording kept back at the free limit says so and offers Upgrade
    /// (the plan-full reason); one whose count could not be read says that.
    #[test]
    fn a_recording_kept_back_at_the_free_limit_says_why() {
        let limit = AppError::NotReady(crate::error::NotReadyKind::RecordingLimitReached);
        assert_eq!(failure_reason(&limit), FailureReason::StorageFull);
        assert_eq!(failure_copy(&limit), super::super::recording_allowance::LIMIT_KEPT);
        let unknown = AppError::NotReady(crate::error::NotReadyKind::RecordingCountUnavailable);
        assert_eq!(failure_reason(&unknown), FailureReason::Other);
        assert_eq!(failure_copy(&unknown), super::super::recording_allowance::COUNT_UNAVAILABLE);
    }

    /// The owner's own open carries `owner=1` before the fragment, whatever
    /// the link already has in its query, and the key is untouched.
    #[test]
    fn the_owners_open_marks_the_query_and_keeps_the_key() {
        assert_eq!(
            owner_view_url("https://console.hippius.com/share/tok#k=AbC-_9"),
            "https://console.hippius.com/share/tok?owner=1#k=AbC-_9"
        );
        assert_eq!(
            owner_view_url("https://console.hippius.com/share/tok?lang=en#p=salt.key"),
            "https://console.hippius.com/share/tok?lang=en&owner=1#p=salt.key"
        );
        assert_eq!(
            owner_view_url("https://console.hippius.com/share/tok"),
            "https://console.hippius.com/share/tok?owner=1"
        );
        assert_eq!(owner_view_url("https://x/share/tok?#k=1"), "https://x/share/tok?owner=1#k=1");
        // A `?` inside the fragment is the key's, not a query.
        assert_eq!(owner_view_url("https://x/share/tok#k=a?b"), "https://x/share/tok?owner=1#k=a?b");
    }

    #[test]
    fn a_link_that_did_not_get_through_is_tried_three_times_in_all() {
        use std::time::Duration;
        for reason in [FailureReason::Offline, FailureReason::Other, FailureReason::NeedsFolder] {
            assert_eq!(mint_retry_after(reason, 0), Some(Duration::from_secs(1)), "{reason:?}");
            assert_eq!(mint_retry_after(reason, 1), Some(Duration::from_secs(3)), "{reason:?}");
            assert_eq!(mint_retry_after(reason, 2), None, "{reason:?}: three attempts in all");
        }
        assert_eq!(
            mint_retry_after(FailureReason::StorageFull, 0),
            None,
            "a full drive will not change in seconds"
        );
    }

    fn delivered(share_url: Option<&str>) -> Delivered {
        Delivered {
            file_name: "Screenshot 2026-09-22 at 14.03.11.png".into(),
            drive_name: "Work".into(),
            folder: "Captures".into(),
            share_url: share_url.map(str::to_string),
            link_error: share_url.is_none().then(|| "boom".into()),
            via_sync: false,
            share_token: None,
            placed: std::path::PathBuf::new(),
        }
    }

    #[test]
    fn a_capture_never_overwrites_a_file_of_the_same_name() {
        let dir = Path::new("/drive/Captures");
        let taken = ["/drive/Captures/Shot.png", "/drive/Captures/Shot (2).png"];
        let exists = |p: &Path| taken.iter().any(|t| Path::new(t) == p);
        assert_eq!(free_name(dir, "Shot.png", exists).unwrap(), Path::new("/drive/Captures/Shot (3).png"));
        assert_eq!(free_name(dir, "Other.png", exists).unwrap(), Path::new("/drive/Captures/Other.png"));
        assert_eq!(
            free_name(dir, "README", |p| p == Path::new("/drive/Captures/README")).unwrap(),
            Path::new("/drive/Captures/README (2)")
        );
        // Every name taken: no name, rather than the first one overwritten.
        assert_eq!(free_name(dir, "Shot.png", |_| true), None);
    }

    /// A same-named file that appears after the name was checked is kept.
    #[test]
    fn a_name_taken_after_the_check_is_not_overwritten() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("capture-x").join("Shot.png");
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        std::fs::write(&src, b"new").unwrap();
        let captures = tmp.path().join("Captures");
        std::fs::create_dir_all(&captures).unwrap();
        std::fs::write(captures.join("Shot.png"), b"arrived meanwhile").unwrap();
        // The check says every name is free, as if it ran before the other file landed.
        let placed = place_in_folder_with(&captures, &src, |_| false, false, |a, b| std::fs::copy(a, b));
        assert!(placed.is_err(), "no free name it could claim");
        assert_eq!(std::fs::read(captures.join("Shot.png")).unwrap(), b"arrived meanwhile");
        assert!(src.exists(), "the capture stays where it was, for Retry");
    }

    /// A copy across volumes that fails half-way leaves nothing under the
    /// capture's name, and no staging file either.
    #[test]
    fn a_failed_cross_volume_copy_leaves_no_partial_file() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("capture-x").join("Recording.mp4");
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        std::fs::write(&src, vec![7u8; 4096]).unwrap();
        let captures = tmp.path().join("Captures");
        let failing_copy = |_: &Path, to: &Path| {
            std::fs::write(to, b"half")?;
            Err(std::io::Error::other("volume unplugged"))
        };
        assert!(place_in_folder_with(&captures, &src, Path::exists, true, failing_copy).is_err());
        assert_eq!(std::fs::read_dir(&captures).unwrap().count(), 0, "nothing left in the drive");
        assert!(src.exists(), "the capture stays for Retry");
    }

    #[test]
    fn a_cross_volume_copy_lands_under_the_real_name() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("capture-x").join("Recording.mp4");
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        std::fs::write(&src, b"mp4").unwrap();
        let captures = tmp.path().join("Captures");
        let placed = place_in_folder_with(&captures, &src, Path::exists, true, |a, b| std::fs::copy(a, b)).unwrap();
        assert_eq!(placed, captures.join("Recording.mp4"));
        assert_eq!(std::fs::read(&placed).unwrap(), b"mp4");
        assert_eq!(std::fs::read_dir(&captures).unwrap().count(), 1, "the staging copy is gone");
        assert!(!src.exists());
    }

    #[test]
    fn a_capture_is_moved_into_the_synced_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("capture-x").join("Shot.png");
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        std::fs::write(&src, b"png").unwrap();
        let captures = tmp.path().join("Work").join("Captures");
        std::fs::create_dir_all(&captures).unwrap();
        std::fs::write(captures.join("Shot.png"), b"older").unwrap();

        let placed = place_in_folder(&captures, &src).unwrap();
        assert_eq!(placed, captures.join("Shot (2).png"));
        assert_eq!(std::fs::read(&placed).unwrap(), b"png");
        assert!(!src.exists(), "the temp copy is moved, not left behind");
        assert_eq!(std::fs::read(captures.join("Shot.png")).unwrap(), b"older");
    }

    /// A capture kept in the folder while no drive could be set up is sent
    /// again once that folder is the drive's: it stays as it is, not renamed.
    #[test]
    fn a_capture_already_in_the_folder_is_left_as_it_is() {
        let tmp = tempfile::tempdir().unwrap();
        let captures = tmp.path().join("Hippius").join("Captures");
        std::fs::create_dir_all(&captures).unwrap();
        let kept = captures.join("Shot.png");
        std::fs::write(&kept, b"png").unwrap();
        assert_eq!(place_in_folder(&captures, &kept).unwrap(), kept);
        assert_eq!(std::fs::read_dir(&captures).unwrap().count(), 1);
    }

    #[test]
    fn a_delivered_capture_says_the_link_is_copied_and_where_the_file_went() {
        let (title, body) = delivered_notice(&delivered(Some("https://x/share/t#k=1")));
        assert_eq!(title, "Link copied");
        assert_eq!(body, "Screenshot 2026-09-22 at 14.03.11.png is in Work › Captures.");
        // The captures drive keeps them at its root: the drive alone.
        let root = Delivered {
            drive_name: "Captures".into(),
            folder: String::new(),
            ..delivered(Some("https://x/share/t#k=1"))
        };
        assert_eq!(delivered_notice(&root).1, "Screenshot 2026-09-22 at 14.03.11.png is in Captures.");
    }

    /// The capture is safe; only the link is missing, and the notice must
    /// not read as though the capture itself failed.
    #[test]
    fn a_missing_link_is_reported_as_saved_not_failed() {
        let (title, body) = delivered_notice(&delivered(None));
        assert_eq!(title, "Capture saved");
        assert!(body.contains("is in Work › Captures") && body.contains("could not be created"));
    }

    /// A capture with no card whose link was copied while it uploaded, and
    /// whose upload then failed, says the copied link won't open: the link
    /// is already in someone's chat, so "could not be created" is wrong.
    #[test]
    fn a_copied_link_that_broke_says_so_in_the_notice() {
        let broken = Delivered {
            link_error: Some(LINK_BROKEN.into()),
            ..delivered(None)
        };
        let (title, body) = delivered_notice(&broken);
        assert_eq!(title, "Capture saved");
        assert_eq!(
            body,
            format!("Screenshot 2026-09-22 at 14.03.11.png is in Work › Captures. {LINK_BROKEN}")
        );
        assert!(!body.contains("could not be created"), "{body}");
    }

    /// The kept file is in a hidden folder; naming it helps nobody. The
    /// notice says where Retry is instead.
    #[test]
    fn a_failed_upload_notice_names_no_path_and_says_where_to_retry() {
        let e = AppError::Io(std::io::Error::other(
            "Network is unreachable (os error 51) at /Users/x/.hippius/capture-tmp",
        ));
        let (title, body) = failed_notice(&e, true);
        assert_eq!(title, "Capture not uploaded");
        assert_eq!(body, "You're offline. Retry when you're back online. Retry from the capture card.");
        let (_, body) = failed_notice(&AppError::Other("boom".into()), false);
        assert!(!body.contains('/'), "{body}");
        assert!(body.contains("next capture"), "{body}");
    }

    #[test]
    fn offline_and_a_full_plan_are_said_plainly() {
        for offline in [
            "error sending request for url (https://api.hippius.com/upload)",
            "Upload failed: error sending request: client error (Connect): tcp connect error: Host is down (os error 64)",
            "Network error: timed out",
            "dns error: failed to lookup address information",
            "Connection refused (os error 61)",
            "Network is unreachable (os error 51)",
            "No route to host (os error 65)",
            "An established connection failed (os error 10051)",
        ] {
            let e = AppError::Other(offline.into());
            assert_eq!(failure_reason(&e), FailureReason::Offline, "{offline}");
            assert_eq!(failure_copy(&e), "You're offline. Retry when you're back online.", "{offline}");
        }
        let full = AppError::NotReady(crate::error::NotReadyKind::StorageLimitReached);
        assert_eq!(failure_reason(&full), FailureReason::StorageFull);
        assert_eq!(failure_copy(&full), "Storage is full. Upgrade your plan to upload this capture.");
    }

    /// A raw error never reaches the card; a sentence Rust wrote does.
    #[test]
    fn other_failures_use_rusts_words_not_the_transport_ones() {
        let raw = AppError::Hcfs("upload: HTTP 500 Internal Server Error {\"detail\":\"x\"}".into());
        assert_eq!(failure_reason(&raw), FailureReason::Other);
        assert_eq!(failure_copy(&raw), "The capture couldn't be uploaded. Retry in a moment.");
        let worded = AppError::Validation("That drive is no longer available.".into());
        assert_eq!(failure_copy(&worded), "That drive is no longer available.");
        // "os error 5" (access denied) is not an offline code.
        assert_eq!(
            failure_reason(&AppError::Other("Access is denied. (os error 5)".into())),
            FailureReason::Other
        );
    }

    #[test]
    fn a_sync_row_error_is_classified_the_same_way() {
        assert_eq!(
            sync_failure_copy(Some("error sending request for url (https://x)")).1,
            FailureReason::Offline
        );
        assert_eq!(
            sync_failure_copy(Some("Server returned 402: storage limit")).1,
            FailureReason::StorageFull
        );
        let (copy, reason) = sync_failure_copy(None);
        assert_eq!(reason, FailureReason::Other);
        assert!(copy.contains("sync queue"), "{copy}");
    }

    /// The server refusing a recording (its row's text is Rust's copy for
    /// it) is offered Upgrade on the card, by either path the capture took.
    #[test]
    fn a_recording_the_server_refused_is_offered_upgrade() {
        let limit = crate::sync::events::recording_limit_reached_copy();
        let too_long = crate::sync::events::recording_too_long_copy();
        for copy in [&limit, &too_long] {
            assert_eq!(sync_failure_copy(Some(copy)), (copy.clone(), FailureReason::StorageFull));
        }

        // A direct upload hands back the typed refusal
        // (`remote_upload::upload_failure`, tested there).
        let limit = AppError::NotReady(crate::error::NotReadyKind::RecordingLimitReached);
        assert_eq!(failure_reason(&limit), FailureReason::StorageFull);
        assert_eq!(failure_copy(&limit), crate::capture::recording_allowance::LIMIT_KEPT);

        let long = AppError::NotReady(crate::error::NotReadyKind::RecordingTooLong);
        assert_eq!(failure_reason(&long), FailureReason::StorageFull);
        assert_eq!(failure_copy(&long), too_long);
    }

    /// A recording moved into a synced drive is declared under the name it
    /// landed with, so hcfs puts it on the upload's manifest. A taken name
    /// moves it to "name (2)", and the declaration follows the move, not
    /// the name the recording was made with.
    ///
    /// Reads hcfs-client's declaration files (`captures/*.json` in the config
    /// dir), which it does not publish: hcfs has no reader for them. A pin on
    /// purpose; an hcfs bump that changes the layout fails it here.
    #[test]
    fn a_placed_recording_is_declared_under_the_name_it_landed_with() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("drive");
        let config_dir = tmp.path().join("config");
        let folder = root.join("Captures");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("Recording.mp4"), b"an earlier file").unwrap();

        let src = tmp.path().join("Recording.mp4");
        std::fs::write(&src, b"recorded").unwrap();
        let placed = place_in_folder(&folder, &src).unwrap();
        assert_eq!(placed, folder.join("Recording (2).mp4"));

        let capture = hcfs_shared::network::Capture::Recording { duration_ms: 61_000 };
        declare_placed(&root, &config_dir, &placed, capture);

        let declarations: Vec<String> = std::fs::read_dir(config_dir.join("captures"))
            .unwrap()
            .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
            .collect();
        assert_eq!(declarations.len(), 1, "{declarations:?}");
        assert!(declarations[0].contains("Captures/Recording (2).mp4"), "{}", declarations[0]);
        assert!(declarations[0].contains("61000"), "{}", declarations[0]);
    }

    /// A file outside the drive's folder is not declared, and nothing fails:
    /// the capture still syncs.
    #[test]
    fn a_capture_outside_its_drive_is_not_declared() {
        let tmp = tempfile::tempdir().unwrap();
        let config_dir = tmp.path().join("config");
        let capture = hcfs_shared::network::Capture::Recording { duration_ms: 1 };
        declare_placed(&tmp.path().join("drive"), &config_dir, &tmp.path().join("elsewhere.mp4"), capture);
        assert!(!config_dir.join("captures").exists());
    }

    #[test]
    fn a_direct_upload_keeps_its_temp_copy_only_while_it_has_no_link() {
        assert!(keep_temp_after_upload(false, false, false));
        assert!(!keep_temp_after_upload(false, true, false));
        assert!(!keep_temp_after_upload(true, false, false));
        assert!(!keep_temp_after_upload(true, true, false));
    }

    /// A screenshot's card can open it in the editor, so its temp copy stays
    /// with the card even once it has a link. A synced one never needs it.
    #[test]
    fn a_direct_screenshot_keeps_its_temp_copy_for_the_editor() {
        assert!(keep_temp_after_upload(false, true, true));
        assert!(!keep_temp_after_upload(true, true, true));
        assert!(!keep_temp_after_upload(true, false, true));
    }

    /// A drive whose folder was moved or deleted is refused, never made
    /// again (an empty folder could read to the sync engine as every earlier
    /// capture deleted); a folder that is there takes the capture, its
    /// subfolder made as before.
    #[test]
    fn a_missing_captures_folder_is_refused_not_made_again() {
        let tmp = tempfile::tempdir().unwrap();
        let gone = tmp.path().join("Documents").join("Hippius Captures");
        let refused = refuse_missing_root(&gone).unwrap_err();
        assert!(is_missing_root(&refused));
        assert_eq!(failure_copy(&refused), CAPTURES_FOLDER_MISSING);
        assert!(!gone.exists(), "nothing was made");

        std::fs::create_dir_all(&gone).unwrap();
        refuse_missing_root(&gone).unwrap();
        let src = tmp.path().join("capture-x").join("Shot.png");
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        std::fs::write(&src, b"png").unwrap();
        let placed = place_in_folder(&gone.join("Work"), &src).unwrap();
        assert_eq!(placed, gone.join("Work").join("Shot.png"));
        assert!(!is_missing_root(&AppError::Validation("Something else.".into())));
    }
}
