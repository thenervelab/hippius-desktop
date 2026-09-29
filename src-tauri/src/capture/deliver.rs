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
}

/// Upload `file` into the destination's Captures folder and mint a link to it.
///
/// A failed upload is an `Err` and leaves `file` where it is: a long recording
/// must not be lost because the network dropped at the end. A failed LINK is
/// not an error — the capture is safely in the drive, and the notification
/// says the link could not be made rather than that the capture failed.
///
/// # Errors
///
/// Whatever the upload refused with, including `NotReady(StorageLimitReached)`
/// from the storage gate, which the UI answers with the plans dialog.
pub async fn deliver(state: &AppState, app: tauri::AppHandle, account_id: &str, destination: &CaptureDestination, file: &Path) -> Result<Delivered> {
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
        // upload shows in the sync queue straight away.
        if let Err(e) = crate::sync::control::trigger_sync_now(app.clone()).await {
            tracing::warn!(error = %e, "capture saved to the sync folder; sync not nudged");
        }
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

    let (share_url, link_error) = match crate::shares::commands::share_external_file(
        state,
        account_id,
        &placed,
        hcfs_client::client::share::ShareTtl::Never,
        crate::shares::commands::ShareChoice::Public,
        None,
    )
    .await
    {
        Ok(link) => (Some(link.share_url), None),
        Err(e) => {
            tracing::warn!(error = %e, "capture saved, but its share link could not be minted");
            (None, Some(e.to_string()))
        }
    };

    Ok(Delivered {
        file_name,
        drive_name: destination.display_name.clone(),
        share_url,
        link_error,
        via_sync,
    })
}

/// Move `file` into `dir` (created if needed) under a name nothing there has.
fn place_in_folder(dir: &Path, file: &Path) -> Result<std::path::PathBuf> {
    std::fs::create_dir_all(dir)?;
    let name = file
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::Other("Capture file has no name".into()))?;
    let target = free_name(dir, name, Path::exists);
    // A rename is atomic on one volume; the capture temp dir and the synced
    // folder can be on different ones, which is when it fails.
    if std::fs::rename(file, &target).is_err() {
        std::fs::copy(file, &target)?;
        std::fs::remove_file(file)?;
    }
    Ok(target)
}

/// `dir/name`, or the first of `name (2)`, `name (3)`… that `exists` says is free.
fn free_name(dir: &Path, name: &str, exists: impl Fn(&Path) -> bool) -> std::path::PathBuf {
    let first = dir.join(name);
    if !exists(&first) {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..=9_999)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !exists(p))
        .unwrap_or(first)
}

/// The notification a delivered capture posts: `(title, body)`.
pub fn delivered_notice(delivered: &Delivered) -> (String, String) {
    let saved = format!("{} is in {} → {CAPTURES_FOLDER}.", delivered.file_name, delivered.drive_name);
    if delivered.share_url.is_some() {
        ("Link copied".into(), saved)
    } else {
        ("Capture saved".into(), format!("{saved} The share link could not be created."))
    }
}

/// The notification a capture that could not be uploaded posts, naming where
/// the file still is so nothing is lost.
pub fn failed_notice(error: &AppError, kept_at: &Path) -> (String, String) {
    let reason = match error {
        AppError::NotReady(crate::error::NotReadyKind::StorageLimitReached) => "Your plan's storage is full.".to_string(),
        other => other.to_string(),
    };
    ("Capture not uploaded".into(), format!("{reason} It is saved at {}.", kept_at.display()))
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
        }
    }

    #[test]
    fn a_capture_never_overwrites_a_file_of_the_same_name() {
        let dir = Path::new("/drive/Captures");
        let taken = ["/drive/Captures/Shot.png", "/drive/Captures/Shot (2).png"];
        let exists = |p: &Path| taken.iter().any(|t| Path::new(t) == p);
        assert_eq!(free_name(dir, "Shot.png", exists), Path::new("/drive/Captures/Shot (3).png"));
        assert_eq!(free_name(dir, "Other.png", exists), Path::new("/drive/Captures/Other.png"));
        assert_eq!(
            free_name(dir, "README", |p| p == Path::new("/drive/Captures/README")),
            Path::new("/drive/Captures/README (2)")
        );
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
        assert_eq!(body, "Screenshot 2026-09-22 at 14.03.11.png is in Work → Captures.");
    }

    /// The capture is safe; only the link is missing, and the notice must
    /// not read as though the capture itself failed.
    #[test]
    fn a_missing_link_is_reported_as_saved_not_failed() {
        let (title, body) = delivered_notice(&delivered(None));
        assert_eq!(title, "Capture saved");
        assert!(body.contains("is in Work → Captures") && body.contains("could not be created"));
    }

    #[test]
    fn a_failed_upload_says_where_the_file_still_is() {
        let (title, body) = failed_notice(&AppError::Other("Network unreachable".into()), Path::new("/tmp/x/Shot.png"));
        assert_eq!(title, "Capture not uploaded");
        assert!(body.contains("Network unreachable") && body.contains("/tmp/x/Shot.png"));
    }

    #[test]
    fn a_full_plan_is_named_as_such() {
        let (_, body) = failed_notice(
            &AppError::NotReady(crate::error::NotReadyKind::StorageLimitReached),
            Path::new("/tmp/x/Shot.png"),
        );
        assert!(body.starts_with("Your plan's storage is full."), "{body}");
    }
}
