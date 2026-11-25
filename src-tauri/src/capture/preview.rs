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

/// Why an upload failed, as far as the card's next step goes. Read back
/// from a kept failure's marker (`kept_failed`) after a restart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
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
    /// The link exists and was handed out (`copied` says whether it reached
    /// the clipboard) while the capture's copy behind it is still uploading,
    /// on a server that says "still uploading" to whoever opens it
    /// (`share_open_while_uploading`). It opens once the upload has finished.
    Uploading { copied: bool },
    /// A link handed out while uploading whose upload then failed: it was
    /// revoked and never opens. The card says so and offers Retry, which
    /// makes a new link (`mint_link`).
    Broken { message: String },
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
            Self::Uploading { copied: true } => Some("Link copied, uploading…"),
            Self::Uploading { copied: false } => Some("Link ready, uploading…"),
            Self::Broken { .. } => Some("Copied link won't open"),
        }
    }

    /// The link is still being made: not yet out ([`Self::Creating`]), or
    /// out while its upload runs ([`Self::Uploading`]). Nothing may be done
    /// to it meanwhile (revoke, a new link from an edit), and the card
    /// follows its upload.
    #[must_use]
    pub fn is_being_made(&self) -> bool {
        matches!(self, Self::Creating | Self::Uploading { .. })
    }

    /// Who can open the link and for how long, while there is one. A
    /// capture's link is public and never expires; the card says so, and
    /// its More menu opens Shared Links to change it.
    #[must_use]
    pub fn note(&self) -> Option<&'static str> {
        match self {
            Self::Public { .. } => Some(PUBLIC_LINK_NOTE),
            Self::Uploading { .. } => Some(UPLOADING_LINK_NOTE),
            Self::Broken { .. } => Some(BROKEN_LINK_NOTE),
            _ => None,
        }
    }
}

/// [`LinkState::note`] for a public link.
pub const PUBLIC_LINK_NOTE: &str = "Anyone with the link can view. Never expires.";

/// [`LinkState::note`] while a link that is out still uploads: the upload
/// runs in this app, so quitting it leaves a link that never opens.
pub const UPLOADING_LINK_NOTE: &str = "Keep Hippius open until the upload finishes.";

/// [`LinkState::note`] for a link whose upload failed after it was copied.
pub const BROKEN_LINK_NOTE: &str = "Its upload failed. Retry to make a new link.";

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
    /// Open this link's row in Shared Links, where who can open it and for
    /// how long are changed.
    pub manage_link: bool,
    /// Reveal the file in Finder / Explorer (a drive synced here).
    pub reveal: bool,
    /// Put a copy of the file on the Desktop: a file of this capture is on
    /// this computer (placed in its drive, kept for a link, or waiting to
    /// be sent again).
    pub save_to_desktop: bool,
    /// Open the storage plans in the main window: the upload failed because
    /// the plan is full, which Retry alone cannot fix, or a Free plan
    /// recording stopped at its length limit.
    pub upgrade: bool,
    /// Open the screenshot in the editor: a screenshot in the drive, with a
    /// file here to read, and no link being made from the unedited picture.
    pub edit: bool,
    /// Drag the picture into another app as the file itself: a file of this
    /// capture is on this computer (placed in its drive, kept for a link,
    /// or waiting to be sent again).
    pub drag_out: bool,
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
    /// [`LinkState::note`], sent so the card does not word it itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_note: Option<String>,
    pub actions: CardActions,
    /// The capture is in the drive and its link has settled: the card may
    /// slide away on its own. Worked out in [`PreviewCard::refreshed`].
    pub settled: bool,
    /// One line about the capture itself, in Rust's words: why a Free plan
    /// recording stopped on its own. Worked out in [`PreviewCard::refreshed`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
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
    /// A Free plan recording that stopped at its length limit
    /// (`capture::allowance`): the card says so and offers Upgrade, and
    /// stays until closed so the line is not missed. Never sent to the card.
    #[serde(skip)]
    pub stopped_at_free_limit: bool,
    /// How far the link being made has got, while it is
    /// [`LinkState::Creating`]. The card reads it only through `link_text`
    /// and `link_percent`. Never sent to the card.
    #[serde(skip)]
    pub link_progress: Option<LinkProgress>,
    /// The link's upload in percent while it is made, for the card's bar.
    /// Worked out in [`PreviewCard::refreshed`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_percent: Option<u8>,
}

/// How far a capture's link has got while it is made. The link is the
/// capture's own encrypted copy, so for a recording this is most of the wait,
/// and the card says where it is rather than "Creating link…" for a minute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkProgress {
    /// The file is being read and encrypted for the link.
    Preparing,
    /// The link's copy is going up: `percent` of it, and roughly how many
    /// seconds are left once that can be told ([`upload_seconds_left`]).
    Uploading { percent: u8, seconds_left: Option<u64> },
    /// Every byte is up; the server is finishing the link.
    Finishing,
}

impl LinkProgress {
    /// The card's line about the link while it is made.
    #[must_use]
    pub fn text(self) -> String {
        match self {
            Self::Preparing => "Preparing link…".to_string(),
            Self::Uploading { percent, seconds_left: None } => format!("Uploading link {percent}%"),
            Self::Uploading {
                percent,
                seconds_left: Some(secs),
            } => format!("Uploading link {percent}%, {}", time_left(secs)),
            Self::Finishing => "Finishing link…".to_string(),
        }
    }

    /// The card's line while a link that is already out
    /// ([`LinkState::Uploading`]) still uploads: "Link copied, uploading
    /// 40%, about 30 s left".
    #[must_use]
    pub fn text_with_link_out(self, copied: bool) -> String {
        let lead = if copied { "Link copied" } else { "Link ready" };
        match self {
            Self::Preparing => format!("{lead}, uploading…"),
            Self::Uploading { percent, seconds_left: None } => format!("{lead}, uploading {percent}%"),
            Self::Uploading {
                percent,
                seconds_left: Some(secs),
            } => format!("{lead}, uploading {percent}%, {}", time_left(secs)),
            Self::Finishing => format!("{lead}, finishing upload…"),
        }
    }

    /// The card's bar: the upload's percent, full while finishing, none
    /// while preparing (nothing has been sent yet).
    #[must_use]
    pub fn percent(self) -> Option<u8> {
        match self {
            Self::Preparing => None,
            Self::Uploading { percent, .. } => Some(percent),
            Self::Finishing => Some(100),
        }
    }
}

/// `done` of `total` in whole percent, 0 to 100.
#[must_use]
pub fn percent_of(done: u64, total: u64) -> u8 {
    if total == 0 {
        return 100;
    }
    let pct = u128::from(done.min(total)) * 100 / u128::from(total);
    u8::try_from(pct).unwrap_or(100)
}

/// Whether `next` is worth a card update after `shown`: a new step, or a
/// new percent. The estimate rides along with those and never sends one of
/// its own, so the card hears of a recording's link a hundred times at most.
#[must_use]
pub fn link_progress_moved(shown: Option<LinkProgress>, next: LinkProgress) -> bool {
    match (shown, next) {
        (Some(LinkProgress::Uploading { percent: a, .. }), LinkProgress::Uploading { percent: b, .. }) => a != b,
        (Some(shown), next) => std::mem::discriminant(&shown) != std::mem::discriminant(&next),
        (None, _) => true,
    }
}

/// "about 25 s left" / "about 3 min left", rounded up so the estimate is not
/// beaten by a few seconds and then sits at zero.
#[must_use]
pub fn time_left(secs: u64) -> String {
    if secs < 10 {
        "a few seconds left".to_string()
    } else if secs < 60 {
        format!("about {} s left", secs.div_ceil(5) * 5)
    } else {
        format!("about {} min left", secs.div_ceil(60))
    }
}

/// Seconds left for an upload `done` of `total` bytes into it, `elapsed`
/// after it started, at the rate so far. None until the rate means
/// something (at least two seconds and some bytes in), and once it is done.
#[must_use]
pub fn upload_seconds_left(done: u64, total: u64, elapsed: std::time::Duration) -> Option<u64> {
    const SETTLE: std::time::Duration = std::time::Duration::from_secs(2);
    if done == 0 || done >= total || elapsed < SETTLE {
        return None;
    }
    let rate = done as f64 / elapsed.as_secs_f64();
    let left = (total - done) as f64 / rate;
    // A rate this low would print a number nobody believes; say nothing.
    (left.is_finite() && left < 24.0 * 3600.0).then(|| left.ceil() as u64)
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
        // While the link is made its line says how far it has got; any other
        // state drops what the last upload reported.
        let progress = self.link.is_being_made().then_some(self.link_progress).flatten();
        let link_text = match (&self.link, progress) {
            (LinkState::Uploading { copied }, Some(p)) => Some(p.text_with_link_out(*copied)),
            (_, Some(p)) => Some(p.text()),
            (link, None) => link.text().map(str::to_string),
        };
        let link_percent = progress.and_then(LinkProgress::percent);
        let link_note = self.link.note().map(str::to_string);
        let actions = self.decide_actions();
        // A link still being made, or one that failed, holds the card: it
        // must stay up to say the link was copied, or to offer Create link.
        // A card explaining a stopped recording stays until it is closed:
        // sliding away on its own, the reason would go unread.
        let settled = matches!(self.status, PreviewStatus::Uploaded { .. })
            && !self.link.is_being_made()
            && !matches!(self.link, LinkState::Failed { .. } | LinkState::Broken { .. })
            && !self.stopped_at_free_limit;
        let notice = self.stopped_at_free_limit.then(|| super::allowance::FREE_LIMIT_NOTICE.to_string());
        Self {
            link_text,
            link_note,
            actions,
            settled,
            notice,
            link_percent,
            link_progress: progress,
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
            mint_link: in_drive && !has_link && self.placed_path.is_some() && !self.link.is_being_made(),
            // Not while its upload runs: Shared Links does not list it yet,
            // and a revoke would only turn that upload into a failure.
            revoke_link: has_link && self.share_token.is_some() && !self.link.is_being_made(),
            manage_link: has_link && self.share_token.is_some() && !self.link.is_being_made(),
            reveal: !self.remote && (in_drive || kept_here) && self.placed_path.is_some(),
            save_to_desktop: self.placed_path.is_some() || retryable,
            upgrade: self.stopped_at_free_limit
                || matches!(
                    self.status,
                    PreviewStatus::Failed {
                        reason: FailureReason::StorageFull,
                        ..
                    }
                ),
            edit: self.kind == CaptureKind::Screenshot
                && in_drive
                && self.placed_path.is_some()
                && !self.link.is_being_made()
                && super::editor::EditableFormat::from_name(&self.file_name).is_some(),
            drag_out: self.placed_path.is_some() || retryable,
        }
    }

    /// The older `linkCopied` / `linkError` status fields, from [`LinkState`].
    #[must_use]
    pub fn link_fields(&self) -> (bool, Option<String>) {
        match &self.link {
            LinkState::Public { copied } | LinkState::Uploading { copied } => (*copied, None),
            LinkState::Failed { message } | LinkState::Broken { message } => (false, Some(message.clone())),
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
            link_note: None,
            link_progress: None,
            link_percent: None,
            actions: CardActions::default(),
            settled: false,
            share_url: None,
            share_token: None,
            file_path: PathBuf::from("/tmp/capture/Recording.mp4"),
            placed_path: None,
            destination: CaptureDestination::own("Work", "Work"),
            kept_locally: false,
            stopped_at_free_limit: false,
            notice: None,
        }
        .refreshed()
    }

    /// A Free plan recording stopped at its limit: the card says why in
    /// Rust's words, offers Upgrade whatever the upload did, and does not
    /// slide away before the line is read.
    #[test]
    fn a_recording_stopped_at_the_free_limit_says_so_and_offers_upgrade() {
        let uploaded = || PreviewStatus::Uploaded {
            link_copied: true,
            link_error: None,
        };
        let plain = card(1).with_outcome(1, uploaded(), Some("https://x".into())).unwrap();
        assert!(plain.settled);
        assert_eq!(plain.notice, None);
        assert!(!plain.actions.upgrade);

        let capped = PreviewCard {
            stopped_at_free_limit: true,
            ..card(2)
        }
        .refreshed();
        assert_eq!(
            capped.notice.as_deref(),
            Some("Free recordings stop at 5 minutes. Upgrade for longer recordings.")
        );
        assert!(capped.actions.upgrade, "while uploading too");
        let done = capped.with_outcome(2, uploaded(), Some("https://x".into())).unwrap();
        assert!(done.actions.upgrade && done.actions.copy_link, "{:?}", done.actions);
        assert!(!done.settled, "it stays until closed");
        let json = serde_json::to_value(&done).unwrap();
        assert_eq!(json["notice"], super::super::allowance::FREE_LIMIT_NOTICE);
        assert!(json.get("stoppedAtFreeLimit").is_none(), "the flag itself stays in Rust");
        assert!(serde_json::to_value(&plain).unwrap().get("notice").is_none());
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
        // A public link says who can open it and that it never expires;
        // no other state has a link to describe.
        assert_eq!(LinkState::Public { copied: false }.note(), Some(PUBLIC_LINK_NOTE));
        for other in [
            LinkState::None,
            LinkState::Revoked,
            LinkState::Creating,
            LinkState::Failed { message: "x".into() },
        ] {
            assert_eq!(other.note(), None, "{other:?}");
        }
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

        // Uploaded to a synced drive with a link: copy, manage, revoke, reveal.
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
                drag_out: true,
                copy_link: true,
                revoke_link: true,
                manage_link: true,
                reveal: true,
                save_to_desktop: true,
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
                drag_out: true,
                mint_link: true,
                save_to_desktop: true,
                ..CardActions::default()
            }
        );

        // A failed direct upload: retry or discard; a failed sync: nothing.
        let c = card(3).with_outcome(3, failed(true), None).unwrap();
        assert!(c.actions.retry && c.actions.discard && !c.actions.mint_link);
        assert!(c.actions.save_to_desktop, "its file waits here, so it can be copied");
        assert!(c.is_parkable());
        assert!(c.actions.drag_out, "its file waits here, so it can be dragged out");
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
                "linkNote": "Anyone with the link can view. Never expires.",
                "actions": {
                    "dragOut": true,
                    "retry": false, "discard": false, "copyLink": true, "mintLink": false,
                    "revokeLink": true, "manageLink": true, "reveal": true, "saveToDesktop": true,
                    "upgrade": false, "edit": false
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

    /// A link that could not be made kept nothing on the clipboard and
    /// opened nothing: the card stays, saying so, with Create link.
    #[test]
    fn a_card_whose_link_failed_stays_up_with_create_link() {
        let mut c = syncing(false);
        c.status = PreviewStatus::Uploaded {
            link_copied: false,
            link_error: Some("The link couldn't be created. Try again in a moment.".into()),
        };
        c.link = LinkState::Failed {
            message: "The link couldn't be created. Try again in a moment.".into(),
        };
        // The capture is in the drive's folder on this computer, linkless.
        c.share_url = None;
        c.placed_path = Some(std::path::PathBuf::from("/drive/Captures/Shot.png"));
        let c = c.refreshed();
        assert!(!c.settled, "it must not slide away without a link");
        assert!(c.actions.mint_link, "Create link is offered");
        let mut none = c.clone();
        none.link = LinkState::None;
        assert!(none.refreshed().settled, "a capture with no link wanted may slide away");
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

    /// While a link is made the card says how far its upload has got, with
    /// a bar, and drops both the moment the link settles.
    #[test]
    fn a_link_being_made_shows_its_upload_and_then_lets_it_go() {
        let mut c = card(3);
        c.link = LinkState::Creating;
        c.link_progress = Some(LinkProgress::Preparing);
        let c = c.refreshed();
        assert_eq!(c.link_text.as_deref(), Some("Preparing link…"));
        assert_eq!(c.link_percent, None, "nothing sent yet, so no bar");

        let mut c = c;
        c.link_progress = Some(LinkProgress::Uploading {
            percent: 40,
            seconds_left: Some(28),
        });
        let c = c.refreshed();
        assert_eq!(c.link_text.as_deref(), Some("Uploading link 40%, about 30 s left"));
        assert_eq!(c.link_percent, Some(40));

        let mut c = c;
        c.link = LinkState::Public { copied: true };
        let c = c.refreshed();
        assert_eq!(c.link_text.as_deref(), Some("Public link copied"));
        assert_eq!(c.link_percent, None);
        assert_eq!(c.link_progress, None, "a settled link forgets the upload");
    }

    /// A link handed out before its upload ends says both on the card: that
    /// it was copied, and how far the upload behind it has got. It can be
    /// copied again, but not revoked or managed until the upload is done,
    /// and the card does not slide away meanwhile.
    #[test]
    fn a_link_out_before_its_upload_ends_says_copied_and_how_far() {
        let mut c = card(4);
        c.link = LinkState::Uploading { copied: true };
        c.share_url = Some("https://console.example/share/t#s=x".into());
        c.share_token = Some("t".into());
        c.link_progress = Some(LinkProgress::Uploading {
            percent: 40,
            seconds_left: Some(28),
        });
        let c = c.refreshed();
        assert_eq!(c.link_text.as_deref(), Some("Link copied, uploading 40%, about 30 s left"));
        assert_eq!(c.link_percent, Some(40), "the bar follows the upload");
        assert_eq!(c.link_note.as_deref(), Some(UPLOADING_LINK_NOTE));
        assert!(c.actions.copy_link, "Copy link works while it uploads");
        assert!(!c.actions.revoke_link && !c.actions.manage_link, "nothing is done to it mid-upload");
        assert!(!c.settled);
        assert_eq!(c.link_fields(), (true, None));

        let mut done = c;
        done.link = LinkState::Public { copied: true };
        done.status = PreviewStatus::Uploaded {
            link_copied: true,
            link_error: None,
        };
        let done = done.refreshed();
        assert_eq!(done.link_text.as_deref(), Some("Public link copied"));
        assert_eq!(done.link_progress, None, "a finished upload is forgotten");
        assert!(done.actions.revoke_link);
    }

    #[test]
    fn the_line_for_a_link_out_reads_plainly_at_every_step() {
        let up = |percent, seconds_left| LinkProgress::Uploading { percent, seconds_left };
        assert_eq!(LinkProgress::Preparing.text_with_link_out(true), "Link copied, uploading…");
        assert_eq!(up(0, None).text_with_link_out(true), "Link copied, uploading 0%");
        assert_eq!(up(73, Some(130)).text_with_link_out(true), "Link copied, uploading 73%, about 3 min left");
        assert_eq!(up(10, Some(4)).text_with_link_out(false), "Link ready, uploading 10%, a few seconds left");
        assert_eq!(LinkProgress::Finishing.text_with_link_out(true), "Link copied, finishing upload…");
        // The card is 316 pt wide and draws one line: the usual case fits.
        assert!(up(40, Some(28)).text_with_link_out(true).chars().count() <= 44);
    }

    /// A copied link whose upload then failed says the copied link won't
    /// open, keeps the card up, and offers a new link in Retry's place.
    #[test]
    fn a_copied_link_whose_upload_failed_says_it_wont_open_and_offers_retry() {
        let mut c = card(5);
        c.status = PreviewStatus::Uploaded {
            link_copied: false,
            link_error: Some("x".into()),
        };
        c.placed_path = Some(PathBuf::from("/drive/Captures/Recording.mp4"));
        c.link = LinkState::Broken { message: "x".into() };
        let c = c.refreshed();
        assert_eq!(c.link_text.as_deref(), Some("Copied link won't open"));
        assert_eq!(c.link_note.as_deref(), Some(BROKEN_LINK_NOTE));
        assert!(c.actions.mint_link, "Retry makes a new link");
        assert!(!c.actions.copy_link, "the revoked link is never copied again");
        assert!(!c.settled, "it stays up until the user has seen it");
        assert_eq!(c.link_fields(), (false, Some("x".into())));
    }

    #[test]
    fn the_time_left_is_rounded_up_and_said_plainly() {
        assert_eq!(time_left(3), "a few seconds left");
        assert_eq!(time_left(11), "about 15 s left");
        assert_eq!(time_left(55), "about 55 s left");
        assert_eq!(time_left(61), "about 2 min left");
        assert_eq!(LinkProgress::Finishing.text(), "Finishing link…");
        assert_eq!(LinkProgress::Finishing.percent(), Some(100));
    }

    #[test]
    fn the_estimate_waits_for_a_rate_and_stops_when_done() {
        use std::time::Duration;
        assert_eq!(upload_seconds_left(10, 100, Duration::from_secs(1)), None, "too early to tell");
        assert_eq!(upload_seconds_left(0, 100, Duration::from_secs(5)), None, "nothing sent yet");
        assert_eq!(upload_seconds_left(100, 100, Duration::from_secs(5)), None, "done");
        // 25 of 100 bytes in 5 s: 75 more at 5 bytes a second.
        assert_eq!(upload_seconds_left(25, 100, Duration::from_secs(5)), Some(15));
        assert_eq!(upload_seconds_left(1, u64::MAX, Duration::from_secs(5)), None, "no believable number");
    }

    #[test]
    fn the_card_hears_of_each_step_and_each_percent_once() {
        let up = |percent, seconds_left| LinkProgress::Uploading { percent, seconds_left };
        assert!(link_progress_moved(None, LinkProgress::Preparing));
        assert!(!link_progress_moved(Some(LinkProgress::Preparing), LinkProgress::Preparing));
        assert!(link_progress_moved(Some(LinkProgress::Preparing), up(0, None)));
        assert!(
            !link_progress_moved(Some(up(12, None)), up(12, Some(40))),
            "the estimate alone sends nothing"
        );
        assert!(link_progress_moved(Some(up(12, None)), up(13, Some(40))));
        assert!(link_progress_moved(Some(up(100, None)), LinkProgress::Finishing));
        assert_eq!(percent_of(0, 0), 100);
        assert_eq!(percent_of(1, 3), 33);
        assert_eq!(percent_of(7, 5), 100, "never past the whole");
        assert_eq!(percent_of(u64::MAX / 2, u64::MAX), 49);
    }
}
