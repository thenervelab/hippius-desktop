//! From a file on disk to a link on the clipboard.
//!
//! Every step reuses an existing path: the upload is the remote file upload
//! (same drive resolution, storage gate and upload-widget rows as a dropped
//! file) and the link is the "share any file on disk" path the Finder uses.
//! Nothing here encrypts, bills or talks to the server itself.

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
    let file_name = file
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::Other("Capture file has no name".into()))?
        .to_string();
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

    let (share_url, link_error) = match crate::shares::commands::share_external_file(
        state,
        account_id,
        file,
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
    })
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
        }
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
