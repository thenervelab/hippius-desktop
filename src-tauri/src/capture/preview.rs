//! The card that slides into the corner after a capture, like the macOS
//! screenshot thumbnail: a preview, the upload as it happens, and one click
//! to the folder it went into.
//!
//! Rust owns what the card says happened; `app/capture-preview` only draws it.

use std::path::PathBuf;

use serde::Serialize;

use super::session::CaptureKind;

/// Where the capture's upload is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum PreviewStatus {
    Uploading,
    /// In the drive. `link_copied` is false when the share link could not be
    /// minted; the file is saved either way.
    #[serde(rename_all = "camelCase")]
    Uploaded {
        link_copied: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        link_error: Option<String>,
    },
    /// In the drive's folder on this machine; the sync engine is uploading it,
    /// and the card follows that upload in the sync queue.
    #[serde(rename_all = "camelCase")]
    Syncing {
        link_copied: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        link_error: Option<String>,
    },
    /// Not uploaded. The file stays on disk, so Retry sends the same file.
    Failed {
        message: String,
    },
}

/// Everything the card shows, plus what its buttons need.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCard {
    /// Changes with every capture, so a late status for an older card is
    /// never painted over a newer one.
    pub id: u64,
    pub kind: CaptureKind,
    pub file_name: String,
    /// The drive's label, which is what "Show in folder" opens.
    pub drive_label: String,
    pub drive_name: String,
    /// Whether the drive is only on the server (not synced on this machine),
    /// which decides how the Drive page opens it.
    pub remote: bool,
    /// A small JPEG `data:` URL; `None` when no picture could be made.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    pub status: PreviewStatus,
    /// The link Copy link puts on the clipboard. Never sent to the card.
    #[serde(skip)]
    pub share_url: Option<String>,
    /// The capture on disk, kept until it uploads. Never sent to the card.
    #[serde(skip)]
    pub file_path: PathBuf,
}

impl PreviewCard {
    /// The card after its upload finished, if `id` is still this card.
    #[must_use]
    pub fn with_outcome(&self, id: u64, status: PreviewStatus, share_url: Option<String>) -> Option<Self> {
        (self.id == id).then(|| Self {
            status,
            share_url,
            ..self.clone()
        })
    }

    /// Whether Retry applies: only a failed upload has a file waiting.
    #[must_use]
    pub fn can_retry(&self) -> bool {
        matches!(self.status, PreviewStatus::Failed { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(id: u64) -> PreviewCard {
        PreviewCard {
            id,
            kind: CaptureKind::Recording,
            file_name: "Recording 2026-09-29 at 15.42.10.mp4".into(),
            drive_label: "Work".into(),
            drive_name: "Work".into(),
            remote: false,
            thumbnail: None,
            status: PreviewStatus::Uploading,
            share_url: None,
            file_path: PathBuf::from("/tmp/capture/Recording.mp4"),
        }
    }

    #[test]
    fn an_outcome_lands_only_on_its_own_card() {
        let done = PreviewStatus::Uploaded {
            link_copied: true,
            link_error: None,
        };
        let updated = card(2).with_outcome(2, done.clone(), Some("https://link".into())).unwrap();
        assert_eq!(updated.status, done);
        assert_eq!(updated.share_url.as_deref(), Some("https://link"));
        assert!(card(3).with_outcome(2, done, None).is_none());
    }

    #[test]
    fn only_a_failed_upload_can_be_retried() {
        assert!(!card(1).can_retry());
        let failed = card(1)
            .with_outcome(1, PreviewStatus::Failed { message: "offline".into() }, None)
            .unwrap();
        assert!(failed.can_retry());
    }

    /// The card reads this shape; the path and link never reach it.
    #[test]
    fn serialises_what_the_card_draws_and_nothing_else() {
        let mut c = card(7);
        c.share_url = Some("https://secret-link".into());
        c.status = PreviewStatus::Uploaded {
            link_copied: false,
            link_error: Some("no link".into()),
        };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "id": 7, "kind": "recording", "fileName": "Recording 2026-09-29 at 15.42.10.mp4",
                "driveLabel": "Work", "driveName": "Work", "remote": false,
                "status": { "state": "uploaded", "linkCopied": false, "linkError": "no link" }
            })
        );
        assert_eq!(
            serde_json::to_value(PreviewStatus::Failed { message: "x".into() }).unwrap(),
            serde_json::json!({ "state": "failed", "message": "x" })
        );
        assert_eq!(
            serde_json::to_value(PreviewStatus::Syncing {
                link_copied: true,
                link_error: None
            })
            .unwrap(),
            serde_json::json!({ "state": "syncing", "linkCopied": true })
        );
    }
}
