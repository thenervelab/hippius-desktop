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

use serde::Serialize;

use super::destination::CaptureDestination;
use super::naming::CAPTURES_FOLDER;
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

/// Whether a direct upload's temp copy stays after the upload landed: only
/// while it has no link, so the card's "Create link" has a file to make one
/// from. A synced capture's copy is the drive's own file, never the temp one.
#[must_use]
pub fn keep_temp_after_upload(via_sync: bool, has_link: bool) -> bool {
    !via_sync && !has_link
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
    /// Its name in `Captures` (a synced folder may have renamed it).
    pub file_name: String,
}

/// Put `file` in the destination's Captures folder: moved into the drive's
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
/// # Errors
///
/// Whatever the upload refused with, including `NotReady(StorageLimitReached)`
/// from the storage gate, which the UI answers with the plans dialog.
pub async fn place(state: &AppState, app: tauri::AppHandle, account_id: &str, destination: &CaptureDestination, file: &Path) -> Result<Placed> {
    let local_root = if destination.owner_ss58.is_none() {
        super::destination::own_local_path(state.pool()?, account_id, &destination.label).await?
    } else {
        None
    };

    let (placed, via_sync) = if let Some(root) = local_root {
        let placed = tokio::task::spawn_blocking({
            let file = file.to_path_buf();
            move || place_in_folder(&root.join(CAPTURES_FOLDER), &file)
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
            Some(CAPTURES_FOLDER.to_string()),
            &[source],
            destination.owner_ss58.clone(),
            destination.folder_hash.clone(),
        )
        .await?;
        if let Some(failure) = failures.into_iter().next() {
            return Err(AppError::Other(failure.error));
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

/// What minting a placed capture's link came to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Minted {
    pub share_url: Option<String>,
    pub share_token: Option<String>,
    /// Why there is no link, in Rust's words, when there is none.
    pub link_error: Option<String>,
}

/// Mint the public link to a placed capture. A failed LINK is not an error:
/// the capture is safely in the drive, and the card says the link could not
/// be made rather than that the capture failed.
pub async fn link_for(state: &AppState, account_id: &str, destination: &CaptureDestination, placed: &Placed) -> Minted {
    let source = if placed.via_sync {
        LinkSource::Synced {
            label: destination.label.clone(),
            rel_path: super::preview::rel_path_for(&placed.file_name),
        }
    } else {
        LinkSource::External(placed.placed.clone())
    };
    match mint(state, account_id, &source).await {
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

impl Delivered {
    /// The broadcast and notification shape for a placed capture and its link.
    #[must_use]
    pub fn from_parts(placed: &Placed, minted: &Minted, drive_name: &str) -> Self {
        Self {
            file_name: placed.file_name.clone(),
            drive_name: drive_name.to_string(),
            share_url: minted.share_url.clone(),
            link_error: minted.link_error.clone(),
            via_sync: placed.via_sync,
            share_token: minted.share_token.clone(),
            placed: placed.placed.clone(),
        }
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
pub async fn mint(state: &AppState, account_id: &str, source: &LinkSource) -> std::result::Result<crate::shares::commands::ShareLink, String> {
    use crate::shares::commands::ShareChoice;
    use hcfs_client::client::share::ShareTtl;
    let minted = match source {
        LinkSource::Synced { label, rel_path } => {
            crate::shares::commands::share_synced_file(state, account_id, label, rel_path, ShareTtl::Never, ShareChoice::Public, None).await
        }
        LinkSource::External(path) => {
            crate::shares::commands::share_external_file(state, account_id, path, ShareTtl::Never, ShareChoice::Public, None).await
        }
    };
    minted.map_err(|e| {
        tracing::warn!(error = %e, "capture saved, but its share link could not be minted");
        link_failure_copy(&e)
    })
}

/// The sentence for a link that could not be made. Never reqwest's own words.
fn link_failure_copy(e: &AppError) -> String {
    match failure_reason(e) {
        FailureReason::Offline => "You're offline. Create the link when you're back online.".into(),
        FailureReason::StorageFull => STORAGE_FULL.into(),
        FailureReason::Other => "The link couldn't be created. Try again in a moment.".into(),
    }
}

pub const OFFLINE: &str = "You're offline. Retry when you're back online.";
pub const STORAGE_FULL: &str = "Storage is full. Upgrade your plan to upload this capture.";
const UPLOAD_FAILED: &str = "The capture couldn't be uploaded. Retry in a moment.";

/// What kind of failure `e` is, for the card's next step.
#[must_use]
pub fn failure_reason(e: &AppError) -> FailureReason {
    match e {
        AppError::NotReady(crate::error::NotReadyKind::StorageLimitReached) => FailureReason::StorageFull,
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
        FailureReason::StorageFull => STORAGE_FULL.into(),
        FailureReason::Other => match e {
            AppError::Validation(message) => message.clone(),
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

/// A transport failure: no route, no DNS, nothing answering. The same shapes
/// the sync widget reads as a network failure, plus the OS's own "network is
/// unreachable" / "no route" codes (51 and 65 on macOS, 101 and 113 on Linux,
/// 10051 and 10065 on Windows).
fn is_offline_shaped(message: &str) -> bool {
    let lower = message.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    lower.starts_with("network error:")
        || [
            "error sending request for url",
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
    let saved = format!("{} is in {} › {CAPTURES_FOLDER}.", delivered.file_name, delivered.drive_name);
    if delivered.share_url.is_some() {
        ("Link copied".into(), saved)
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
        "Hippius kept it and offers it again on your next capture."
    };
    ("Capture not uploaded".into(), format!("{reason} {next}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn delivered(share_url: Option<&str>) -> Delivered {
        Delivered {
            file_name: "Screenshot 2026-09-22 at 14.03.11.png".into(),
            drive_name: "Work".into(),
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

    #[test]
    fn a_delivered_capture_says_the_link_is_copied_and_where_the_file_went() {
        let (title, body) = delivered_notice(&delivered(Some("https://x/share/t#k=1")));
        assert_eq!(title, "Link copied");
        assert_eq!(body, "Screenshot 2026-09-22 at 14.03.11.png is in Work › Captures.");
    }

    /// The capture is safe; only the link is missing, and the notice must
    /// not read as though the capture itself failed.
    #[test]
    fn a_missing_link_is_reported_as_saved_not_failed() {
        let (title, body) = delivered_notice(&delivered(None));
        assert_eq!(title, "Capture saved");
        assert!(body.contains("is in Work › Captures") && body.contains("could not be created"));
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

    #[test]
    fn a_direct_upload_keeps_its_temp_copy_only_while_it_has_no_link() {
        assert!(keep_temp_after_upload(false, false));
        assert!(!keep_temp_after_upload(false, true));
        assert!(!keep_temp_after_upload(true, false));
        assert!(!keep_temp_after_upload(true, true));
    }
}
