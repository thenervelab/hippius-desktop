//! The card that slides into the corner after a capture, like the macOS
//! screenshot thumbnail: a preview, the upload as it happens, and one click
//! to the folder it went into.
//!
//! Rust owns what the card says happened; `app/capture-preview` only draws it.

use std::path::PathBuf;

use serde::Serialize;

use super::destination::CaptureDestination;
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
    /// Not uploaded. `message` is Rust's plain sentence; `reason` lets the
    /// card offer the right next step (an Upgrade button for a full plan).
    /// `retryable`: the file is waiting in the temp folder and Retry sends it
    /// again. A drive synced here retries on its own, so its card is not.
    #[serde(rename_all = "camelCase")]
    Failed {
        message: String,
        reason: FailureReason,
        retryable: bool,
    },
}

/// Why an upload failed, as far as the card's next step goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureReason {
    /// No network: retry when back online.
    Offline,
    /// The plan's storage is full: upgrade, not retry.
    StorageFull,
    /// Nobody has said where captures go yet: the file is kept on this
    /// machine and uploads once a folder is chosen. Not a failure, so the
    /// card waits rather than alarms, and its button asks for the folder.
    NeedsFolder,
    Other,
}

/// What the card says about the share link, in Rust's words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum LinkState {
    /// Copying links is off, or the upload has not finished yet.
    None,
    /// A public link exists; `copied` says whether it reached the clipboard.
    Public { copied: bool },
    /// The link could not be made; the file is in the drive regardless.
    Failed { message: String },
    /// The link was revoked from the card.
    Revoked,
    /// The link is being made. The card is not finished until it settles,
    /// so it never slides away before it can say the link was copied.
    Creating,
}

impl LinkState {
    /// The line the card shows about the link, or `None` for nothing.
    #[must_use]
    pub fn text(&self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::Public { copied: true } => Some("Public link copied"),
            Self::Public { copied: false } => Some("Public link ready"),
            Self::Failed { .. } => Some("No link yet"),
            Self::Revoked => Some("Link revoked"),
            Self::Creating => Some("Creating link…"),
        }
    }
}

/// Which buttons the card offers now. Rust decides; the card draws them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardActions {
    /// Send the kept file again (a failed direct upload).
    pub retry: bool,
    /// Throw a failed capture away (its file is deleted).
    pub discard: bool,
    /// Put the link on the clipboard again.
    pub copy_link: bool,
    /// Make a link: the file is in the drive but has none (the link failed,
    /// copying links is off, or it was revoked).
    pub mint_link: bool,
    /// Revoke the public link this capture made.
    pub revoke_link: bool,
    /// Reveal the file in Finder / Explorer (a drive synced here).
    pub reveal: bool,
    /// Open the storage plans in the main window: the upload failed because
    /// the plan is full, which Retry alone cannot fix.
    pub upgrade: bool,
    /// Open the screenshot in the editor: a screenshot in the drive, with a
    /// file here to read, and no link being made from the unedited picture.
    pub edit: bool,
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
    /// The file's path in the drive (`Captures/<name>`), which is how the
    /// sync engine's row for it is named; the card joins its percent on it.
    pub rel_path: String,
    pub link: LinkState,
    /// [`LinkState::text`], sent so the card does not word it itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_text: Option<String>,
    pub actions: CardActions,
    /// The capture is in the drive and its link has settled: the card may
    /// slide away on its own. Worked out in [`PreviewCard::refreshed`].
    pub settled: bool,
    /// The link Copy link puts on the clipboard. Never sent to the card.
    #[serde(skip)]
    pub share_url: Option<String>,
    /// The share's token, which Revoke needs. Never sent to the card.
    #[serde(skip)]
    pub share_token: Option<String>,
    /// The capture on disk, kept until it uploads. Never sent to the card.
    #[serde(skip)]
    pub file_path: PathBuf,
    /// Where the file ended up on this machine: the drive's synced folder,
    /// or the temp copy kept for a later link. Never sent to the card.
    #[serde(skip)]
    pub placed_path: Option<PathBuf>,
    /// The drive this capture was sent to. Retry sends it there again, even
    /// if the capture drive was changed since. Never sent to the card.
    #[serde(skip)]
    pub destination: CaptureDestination,
    /// No drive could be set up yet, so the capture was kept in a folder on
    /// this computer (`capture::setup`): Retry sets the drive up again
    /// rather than sending to `destination`, the file is the user's to keep
    /// (no Discard) and can be revealed, and the card is not brought back on
    /// the next capture, which makes its own attempt. Never sent to the card.
    #[serde(skip)]
    pub kept_locally: bool,
}

/// The sync engine's row for a capture delivered through a synced folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncRow {
    /// No row: the cycle has not picked the file up yet.
    Absent,
    /// In the engine's queue, behind other files, not started.
    Queued,
    /// Being encrypted or uploaded.
    Working,
    Completed,
    /// The engine's own error text, which is never shown as it is.
    Failed(Option<String>),
}

/// Whether the engine's `engine_path` is the capture at `rel_path`
/// (`Captures/<name>`). The engine names a file by its path in the drive,
/// but a path can arrive with Windows separators, a leading slash, as an
/// absolute path ending in the drive path, or in another Unicode form (a
/// name typed on macOS can be decomposed: "é" as "e" plus an accent), so
/// both sides are compared in NFC, never trimmed of spaces.
#[must_use]
pub fn same_drive_path(engine_path: &str, rel_path: &str) -> bool {
    use unicode_normalization::UnicodeNormalization;
    let norm = |p: &str| -> String { p.replace('\\', "/").trim_start_matches('/').nfc().collect() };
    let engine = norm(engine_path);
    let ours = norm(rel_path);
    !ours.is_empty() && (engine == ours || engine.ends_with(&format!("/{ours}")))
}

/// What the engine says about the capture, from every place it says it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncFacts {
    /// The capture's row in the live session, if it has one.
    pub live: Option<SyncRow>,
    /// A finished upload of it since the capture was placed (completed rows
    /// leave the session for the engine's recent list).
    pub finished: bool,
    /// The engine's set of files it knows are on the server holds it: the
    /// upload was confirmed, whatever became of its row.
    pub on_server: bool,
}

impl SyncFacts {
    /// One answer from the three sources. The server's confirmation wins:
    /// a row can linger as "uploading" after the engine finished with it,
    /// and a row can be gone altogether once the session closes.
    #[must_use]
    pub fn row(&self) -> SyncRow {
        if self.on_server {
            return SyncRow::Completed;
        }
        match &self.live {
            Some(row) if *row != SyncRow::Absent => row.clone(),
            _ if self.finished => SyncRow::Completed,
            _ => SyncRow::Absent,
        }
    }
}

/// Whether the card's public link finishes it: the card is still syncing,
/// its link is public and the engine has not started on the file (no row
/// yet, or queued behind other files). Minting the link uploads the
/// capture's own encrypted copy, so the capture is on the server and
/// shareable; the drive copy follows whenever the engine gets to it. A card
/// whose file the engine is uploading right now shows that upload instead.
#[must_use]
pub fn link_finishes_card(card: &PreviewCard, row: &SyncRow) -> bool {
    matches!(card.status, PreviewStatus::Syncing { .. })
        && matches!(card.link, LinkState::Public { .. })
        && matches!(row, SyncRow::Absent | SyncRow::Queued)
}

/// What a syncing card becomes given the engine's row, or `None` when it
/// stays as it is. Rust follows the row by its path in the drive, so a
/// same-named file elsewhere never finishes this card, and the card no
/// longer depends on the row still being in the snapshot the widget reads.
#[must_use]
pub fn status_after_sync_row(card: &PreviewCard, row: &SyncRow) -> Option<PreviewStatus> {
    let (link_copied, link_error) = card.link_fields();
    let next = match row {
        SyncRow::Absent => return None,
        SyncRow::Queued | SyncRow::Working => PreviewStatus::Syncing { link_copied, link_error },
        SyncRow::Completed => PreviewStatus::Uploaded { link_copied, link_error },
        SyncRow::Failed(error) => {
            let (message, reason) = super::deliver::sync_failure_copy(error.as_deref());
            PreviewStatus::Failed {
                message,
                reason,
                retryable: false,
            }
        }
    };
    (next != card.status).then_some(next)
}

impl PreviewCard {
    /// The card after its upload finished, if `id` is still this card.
    #[must_use]
    pub fn with_outcome(&self, id: u64, status: PreviewStatus, share_url: Option<String>) -> Option<Self> {
        (self.id == id).then(|| {
            Self {
                status,
                share_url,
                ..self.clone()
            }
            .refreshed()
        })
    }

    /// The card with its derived fields (link text, buttons) worked out
    /// again from its state. Every change to a card goes through this.
    #[must_use]
    pub fn refreshed(self) -> Self {
        let link_text = self.link.text().map(str::to_string);
        let actions = self.decide_actions();
        let settled = matches!(self.status, PreviewStatus::Uploaded { .. }) && self.link != LinkState::Creating;
        Self {
            link_text,
            actions,
            settled,
            ..self
        }
    }

    fn decide_actions(&self) -> CardActions {
        let in_drive = matches!(self.status, PreviewStatus::Uploaded { .. } | PreviewStatus::Syncing { .. });
        let has_link = self.share_url.is_some();
        let retryable = matches!(self.status, PreviewStatus::Failed { retryable: true, .. });
        let kept_here = self.kept_locally && matches!(self.status, PreviewStatus::Failed { .. });
        CardActions {
            retry: retryable,
            // A capture kept in the user's own folder is theirs, not a temp
            // copy to throw away.
            discard: retryable && !kept_here,
            copy_link: has_link,
            // The link is made from a file on this machine: the synced copy,
            // or the temp copy kept for exactly this.
            mint_link: in_drive && !has_link && self.placed_path.is_some() && self.link != LinkState::Creating,
            revoke_link: has_link && self.share_token.is_some(),
            reveal: !self.remote && (in_drive || kept_here) && self.placed_path.is_some(),
            upgrade: matches!(
                self.status,
                PreviewStatus::Failed {
                    reason: FailureReason::StorageFull,
                    ..
                }
            ),
            edit: self.kind == CaptureKind::Screenshot
                && in_drive
                && self.placed_path.is_some()
                && self.link != LinkState::Creating
                && super::editor::EditableFormat::from_name(&self.file_name).is_some(),
        }
    }

    /// The older `linkCopied` / `linkError` status fields, from [`LinkState`].
    #[must_use]
    pub fn link_fields(&self) -> (bool, Option<String>) {
        match &self.link {
            LinkState::Public { copied } => (*copied, None),
            LinkState::Failed { message } => (false, Some(message.clone())),
            LinkState::None | LinkState::Revoked | LinkState::Creating => (false, None),
        }
    }

    /// Whether Retry applies: only a failed upload has a file waiting.
    #[must_use]
    pub fn can_retry(&self) -> bool {
        self.decide_actions().retry
    }

    /// A failed capture whose file is still waiting: closing its card must
    /// not lose it (it comes back on the next capture).
    #[must_use]
    pub fn is_parkable(&self) -> bool {
        self.can_retry() && !self.kept_locally
    }

    /// Whether the card's own temp copy is no longer needed once the card
    /// goes: the upload landed, so the drive has the file.
    #[must_use]
    pub fn temp_copy_done_with(&self) -> bool {
        matches!(self.status, PreviewStatus::Uploaded { .. } | PreviewStatus::Syncing { .. })
    }
}

/// The card's path in the drive for a file named `file_name` in the default
/// `Captures` folder. A card's own path comes from its destination
/// ([`CaptureDestination::rel_path`]), since the folder can be changed.
#[must_use]
pub fn rel_path_for(file_name: &str) -> String {
    format!("{}/{file_name}", super::naming::CAPTURES_FOLDER)
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
            rel_path: rel_path_for("Recording 2026-09-29 at 15.42.10.mp4"),
            link: LinkState::None,
            link_text: None,
            actions: CardActions::default(),
            settled: false,
            share_url: None,
            share_token: None,
            file_path: PathBuf::from("/tmp/capture/Recording.mp4"),
            placed_path: None,
            destination: CaptureDestination::own("Work", "Work"),
            kept_locally: false,
        }
        .refreshed()
    }

    fn syncing(copied: bool) -> PreviewCard {
        let mut c = card(9);
        c.link = LinkState::Public { copied };
        c.status = PreviewStatus::Syncing {
            link_copied: copied,
            link_error: None,
        };
        c.refreshed()
    }

    #[test]
    fn a_syncing_card_follows_the_engines_row() {
        let c = syncing(true);
        assert_eq!(status_after_sync_row(&c, &SyncRow::Absent), None);
        assert_eq!(status_after_sync_row(&c, &SyncRow::Working), None, "already syncing");
        assert_eq!(
            status_after_sync_row(&c, &SyncRow::Completed),
            Some(PreviewStatus::Uploaded {
                link_copied: true,
                link_error: None
            })
        );
        let Some(PreviewStatus::Failed { message, reason, retryable }) =
            status_after_sync_row(&c, &SyncRow::Failed(Some("error sending request for url (https://x)".into())))
        else {
            panic!("a failed row fails the card");
        };
        assert_eq!(reason, FailureReason::Offline);
        assert!(!retryable, "the sync queue retries it, not the card");
        assert!(!message.contains("https://"), "{message}");
    }

    /// The queue retried after a failure: the card goes back to syncing.
    #[test]
    fn a_failed_sync_that_the_queue_retries_goes_back_to_syncing() {
        let mut c = syncing(false);
        c.status = status_after_sync_row(&c, &SyncRow::Failed(None)).unwrap();
        assert_eq!(
            status_after_sync_row(&c, &SyncRow::Working),
            Some(PreviewStatus::Syncing {
                link_copied: false,
                link_error: None
            })
        );
    }

    /// Retry sends the capture where it was first sent.
    #[test]
    fn a_card_keeps_the_drive_its_capture_went_to() {
        let c = card(4).with_outcome(4, failed(true), None).unwrap();
        assert_eq!(c.destination.label, "Work");
        assert!(serde_json::to_value(&c).unwrap().get("destination").is_none(), "never sent to the card");
    }

    fn failed(retryable: bool) -> PreviewStatus {
        PreviewStatus::Failed {
            message: "offline".into(),
            reason: FailureReason::Offline,
            retryable,
        }
    }

    #[test]
    fn the_link_line_is_worded_by_rust() {
        assert_eq!(LinkState::Public { copied: true }.text(), Some("Public link copied"));
        assert_eq!(LinkState::Public { copied: false }.text(), Some("Public link ready"));
        assert_eq!(LinkState::None.text(), None);
        assert_eq!(LinkState::Revoked.text(), Some("Link revoked"));
        let mut c = card(1);
        c.link = LinkState::Public { copied: true };
        assert_eq!(c.refreshed().link_text.as_deref(), Some("Public link copied"));
    }

    #[test]
    fn the_card_offers_only_the_buttons_that_apply() {
        // Uploading: nothing yet.
        assert_eq!(card(1).actions, CardActions::default());

        // Uploaded to a synced drive with a link: copy, revoke, reveal.
        let mut c = card(1);
        c.placed_path = Some(PathBuf::from("/Users/x/Hippius/Work/Captures/Recording.mp4"));
        c.share_token = Some("tok".into());
        let c = c
            .with_outcome(
                1,
                PreviewStatus::Syncing {
                    link_copied: true,
                    link_error: None,
                },
                Some("https://link".into()),
            )
            .unwrap();
        assert_eq!(
            c.actions,
            CardActions {
                copy_link: true,
                revoke_link: true,
                reveal: true,
                ..CardActions::default()
            }
        );

        // Uploaded with no link: make one; a remote drive cannot be revealed.
        let mut c = card(2);
        c.remote = true;
        c.placed_path = Some(PathBuf::from("/tmp/capture/Recording.mp4"));
        let c = c
            .with_outcome(
                2,
                PreviewStatus::Uploaded {
                    link_copied: false,
                    link_error: Some("x".into()),
                },
                None,
            )
            .unwrap();
        assert_eq!(
            c.actions,
            CardActions {
                mint_link: true,
                ..CardActions::default()
            }
        );

        // A failed direct upload: retry or discard; a failed sync: nothing.
        let c = card(3).with_outcome(3, failed(true), None).unwrap();
        assert!(c.actions.retry && c.actions.discard && !c.actions.mint_link);
        assert!(c.is_parkable());
        let c = card(3).with_outcome(3, failed(false), None).unwrap();
        assert_eq!(c.actions, CardActions::default());
        assert!(!c.is_parkable());

        // A full plan: Upgrade as well as Retry; any other failure has none.
        let full = PreviewStatus::Failed {
            message: "Your storage is full.".into(),
            reason: FailureReason::StorageFull,
            retryable: true,
        };
        let c = card(5).with_outcome(5, full, None).unwrap();
        assert!(c.actions.upgrade && c.actions.retry);
        assert!(!card(6).with_outcome(6, failed(true), None).unwrap().actions.upgrade);
        let json = serde_json::to_value(c.actions).unwrap();
        assert_eq!(json["upgrade"], true, "sent as `upgrade`");
    }

    /// A capture kept on this computer because no drive could be set up:
    /// Retry and Reveal, plus Upgrade for a full plan; never Discard (it is
    /// the user's file in their own folder), and it is not parked to come
    /// back, since the next capture tries the setup again itself.
    #[test]
    fn a_capture_kept_on_this_computer_offers_retry_and_reveal_not_discard() {
        let mut c = card(4);
        c.kept_locally = true;
        c.placed_path = Some(PathBuf::from("/Users/a/Hippius/Captures/Shot.png"));
        c.status = PreviewStatus::Failed {
            message: "Saved on this computer in Hippius › Captures. Upgrade your plan to upload it and get a link.".into(),
            reason: FailureReason::StorageFull,
            retryable: true,
        };
        let c = c.refreshed();
        assert!(c.actions.retry && c.actions.reveal && c.actions.upgrade, "{:?}", c.actions);
        assert!(!c.actions.discard, "{:?}", c.actions);
        assert!(!c.is_parkable());
        assert!(!c.settled);
    }

    /// Edit is offered for a screenshot in the drive with a file here, never
    /// for a recording, before the file is placed, after a failure, or while
    /// its link is still being made from the unedited picture.
    #[test]
    fn only_a_placed_screenshot_can_be_edited() {
        let shot = |status: PreviewStatus, placed: bool, link: LinkState| {
            let mut c = card(4);
            c.kind = CaptureKind::Screenshot;
            c.file_name = "Screenshot 2026-10-05 at 10.00.00.png".into();
            c.placed_path = placed.then(|| PathBuf::from("/Users/x/Hippius/Work/Captures/Shot.png"));
            c.status = status;
            c.link = link;
            c.refreshed().actions.edit
        };
        let syncing = PreviewStatus::Syncing {
            link_copied: true,
            link_error: None,
        };
        let uploaded = PreviewStatus::Uploaded {
            link_copied: true,
            link_error: None,
        };
        assert!(shot(syncing.clone(), true, LinkState::Public { copied: true }));
        assert!(shot(uploaded.clone(), true, LinkState::None));
        assert!(!shot(uploaded.clone(), false, LinkState::None), "no file here to open");
        assert!(!shot(syncing, true, LinkState::Creating), "the link would be made from the old picture");
        assert!(!shot(PreviewStatus::Uploading, true, LinkState::None));
        assert!(!shot(failed(true), true, LinkState::None));
        let mut recording = card(5);
        recording.placed_path = Some(PathBuf::from("/x/Captures/Recording.mp4"));
        recording.status = uploaded;
        assert!(!recording.refreshed().actions.edit);
        assert_eq!(
            serde_json::to_value(CardActions {
                edit: true,
                ..CardActions::default()
            })
            .unwrap()["edit"],
            true
        );
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
        let failed = card(1).with_outcome(1, failed(true), None).unwrap();
        assert!(failed.can_retry());
    }

    /// The card reads this shape; the path and link never reach it.
    #[test]
    fn serialises_what_the_card_draws_and_nothing_else() {
        let mut c = card(7);
        c.share_url = Some("https://secret-link".into());
        c.share_token = Some("secret-token".into());
        c.placed_path = Some(PathBuf::from("/secret/path"));
        c.status = PreviewStatus::Uploaded {
            link_copied: false,
            link_error: Some("no link".into()),
        };
        c.link = LinkState::Public { copied: true };
        let v = serde_json::to_value(c.refreshed()).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "id": 7, "kind": "recording", "fileName": "Recording 2026-09-29 at 15.42.10.mp4",
                "driveLabel": "Work", "driveName": "Work", "remote": false,
                "status": { "state": "uploaded", "linkCopied": false, "linkError": "no link" },
                "relPath": "Captures/Recording 2026-09-29 at 15.42.10.mp4",
                "link": { "state": "public", "copied": true },
                "linkText": "Public link copied",
                "actions": {
                    "retry": false, "discard": false, "copyLink": true, "mintLink": false,
                    "revokeLink": true, "reveal": true, "upgrade": false, "edit": false
                },
                "settled": true
            })
        );
        assert_eq!(
            serde_json::to_value(failed(true)).unwrap(),
            serde_json::json!({ "state": "failed", "message": "offline", "reason": "offline", "retryable": true })
        );
        assert_eq!(
            serde_json::to_value(FailureReason::StorageFull).unwrap(),
            serde_json::json!("storageFull")
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

    // ── Following a synced capture (the card that stayed on "Preparing upload") ──

    const SHOT: &str = "Screenshot 2026-09-30 at 09.19.47.png";

    #[test]
    fn the_engines_path_is_matched_by_the_path_in_the_drive() {
        let rel = rel_path_for(SHOT);
        assert!(same_drive_path("Captures/Screenshot 2026-09-30 at 09.19.47.png", &rel), "spaces kept");
        assert!(
            same_drive_path("/Captures/Screenshot 2026-09-30 at 09.19.47.png", &rel),
            "a leading slash"
        );
        assert!(
            same_drive_path("Captures\\Screenshot 2026-09-30 at 09.19.47.png", &rel),
            "Windows separators"
        );
        assert!(
            same_drive_path("/Users/me/Archive/Captures/Screenshot 2026-09-30 at 09.19.47.png", &rel),
            "an absolute path ending in it"
        );
        assert!(
            !same_drive_path("Screenshot 2026-09-30 at 09.19.47.png", &rel),
            "the same name at the drive root is another file"
        );
        assert!(!same_drive_path("Old/Captures/Screenshot 2026-09-30 at 09.19.4.png", &rel));
        assert!(!same_drive_path("Captures/Screenshot 2026-09-30 at 09.19.47.png ", &rel), "never trimmed");
        assert!(!same_drive_path("anything", ""), "an empty path matches nothing");
    }

    /// A macOS name with an apostrophe and an accent, as Finder writes it
    /// (decomposed) and as Rust spells it (composed).
    #[test]
    fn a_unicode_name_matches_in_either_normal_form() {
        let composed = "Capture d\u{2019}\u{e9}cran 2026-09-30 \u{e0} 13.53.34.png";
        let decomposed = "Capture d\u{2019}e\u{301}cran 2026-09-30 a\u{300} 13.53.34.png";
        assert_ne!(composed, decomposed);
        assert!(same_drive_path(&format!("Captures/{decomposed}"), &rel_path_for(composed)));
        assert!(same_drive_path(&format!("Captures/{composed}"), &rel_path_for(decomposed)));
        assert!(
            !same_drive_path("Captures/Capture d'\u{e9}cran 2026-09-30 \u{e0} 13.53.34.png", &rel_path_for(composed)),
            "a straight quote is another name"
        );
    }

    #[test]
    fn the_engine_is_asked_in_every_place_it_answers() {
        // A completed row in the live session.
        let live = SyncFacts {
            live: Some(SyncRow::Completed),
            ..SyncFacts::default()
        };
        assert_eq!(live.row(), SyncRow::Completed);
        // The row already left the session: the finished list has it.
        let gone = SyncFacts {
            finished: true,
            ..SyncFacts::default()
        };
        assert_eq!(gone.row(), SyncRow::Completed);
        // No row anywhere, but the engine knows the server has it.
        let known = SyncFacts {
            on_server: true,
            ..SyncFacts::default()
        };
        assert_eq!(known.row(), SyncRow::Completed);
        // A row still saying "uploading" once the server confirmed it.
        let stale = SyncFacts {
            live: Some(SyncRow::Working),
            on_server: true,
            ..SyncFacts::default()
        };
        assert_eq!(stale.row(), SyncRow::Completed);
        // Still going, and not there yet.
        let working = SyncFacts {
            live: Some(SyncRow::Working),
            ..SyncFacts::default()
        };
        assert_eq!(working.row(), SyncRow::Working);
        assert_eq!(SyncFacts::default().row(), SyncRow::Absent);
        let failed = SyncFacts {
            live: Some(SyncRow::Failed(None)),
            ..SyncFacts::default()
        };
        assert_eq!(failed.row(), SyncRow::Failed(None));
    }

    #[test]
    fn a_row_that_finished_before_the_card_followed_it_still_finishes_the_card() {
        let c = syncing(true);
        let gone = SyncFacts {
            finished: true,
            ..SyncFacts::default()
        };
        assert_eq!(
            status_after_sync_row(&c, &gone.row()),
            Some(PreviewStatus::Uploaded {
                link_copied: true,
                link_error: None
            })
        );
        let done = c
            .with_outcome(9, status_after_sync_row(&c, &gone.row()).unwrap(), Some("https://l".into()))
            .unwrap();
        assert!(done.settled, "an uploaded card with its link may slide away");
        assert_eq!(done.link_text.as_deref(), Some("Public link copied"));
    }

    #[test]
    fn the_card_waits_for_its_link_before_it_is_finished() {
        let mut c = syncing(false);
        c.link = LinkState::Creating;
        c.status = PreviewStatus::Uploaded {
            link_copied: false,
            link_error: None,
        };
        let c = c.refreshed();
        assert!(!c.settled, "it must not slide away before it can say the link was copied");
        assert_eq!(c.link_text.as_deref(), Some("Creating link…"));
        assert!(!c.actions.mint_link, "no second link while one is being made");
        let mut copied = c.clone();
        copied.link = LinkState::Public { copied: true };
        assert!(copied.refreshed().settled);
    }

    #[test]
    fn a_public_link_finishes_a_card_the_engine_has_not_started() {
        let c = syncing(true);
        // Queued behind a long sync, or not picked up yet: the link's own
        // copy is on the server, so the card does not wait for the queue.
        assert!(link_finishes_card(&c, &SyncRow::Absent));
        assert!(link_finishes_card(&c, &SyncRow::Queued));
        // Its own upload running, done or failed: the engine's row decides.
        assert!(!link_finishes_card(&c, &SyncRow::Working));
        assert!(!link_finishes_card(&c, &SyncRow::Completed));
        assert!(!link_finishes_card(&c, &SyncRow::Failed(None)));
        // No link means no evidence the bytes reached the server.
        let mut no_link = syncing(false);
        no_link.link = LinkState::None;
        assert!(!link_finishes_card(&no_link, &SyncRow::Queued));
        let mut creating = syncing(false);
        creating.link = LinkState::Creating;
        assert!(!link_finishes_card(&creating, &SyncRow::Queued));
        let mut failed_link = syncing(false);
        failed_link.link = LinkState::Failed { message: "no".into() };
        assert!(!link_finishes_card(&failed_link, &SyncRow::Queued));
    }

    #[test]
    fn a_queued_card_keeps_syncing_until_its_link_or_its_upload_finishes_it() {
        let c = syncing(true);
        assert_eq!(status_after_sync_row(&c, &SyncRow::Queued), None, "still syncing");
    }
}
