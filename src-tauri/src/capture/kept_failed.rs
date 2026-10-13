//! Failed captures that outlive the app.
//!
//! A capture whose direct upload failed keeps its file in its own folder
//! under `~/.hippius/capture-tmp` and its card offers Retry (and Upgrade
//! when the plan is full). A closed card is parked in memory and comes back
//! on the next capture, but memory does not survive a restart: the file
//! stayed on disk forever with nothing offering it again.
//!
//! So a failed card also writes [`MARKER`] beside its file: who it belongs
//! to, where it was going and why it failed. At sign-in the newest one for
//! the account comes back as its card, and each later capture start brings
//! back the next one while none is parked. The marker goes once the capture
//! reaches the drive, and with the folder when the user discards it. Nothing
//! here ever deletes a capture.
//!
//! A failure is not the only way a capture is left behind: the app can quit
//! (or crash) while a recording records or a capture uploads. So a marker is
//! also written when a recording starts and when delivery starts, stamped
//! with this run of the app ([`KeptFailed::run`]). While this run lasts it is
//! skipped (the recording or upload is still going); after a restart it is
//! offered like any failure, with Retry.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::destination::CaptureDestination;
use super::preview::{FailureReason, PreviewCard, PreviewStatus};
use super::session::CaptureKind;

/// The marker's name inside a capture's own folder.
pub const MARKER: &str = "failed.json";

/// What a failed card needs to come back after a restart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptFailed {
    /// `account_key` of the account the capture was taken under.
    pub account: String,
    pub kind: CaptureKind,
    pub destination: CaptureDestination,
    pub message: String,
    pub reason: FailureReason,
    #[serde(default)]
    pub stopped_at_free_limit: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    /// No captures drive was set up when it was marked: its Retry asks
    /// where captures go (`setup::ensure`) rather than sending it to a drive
    /// that was only a placeholder name.
    #[serde(default)]
    pub awaiting_setup: bool,
    /// The run of the app still recording or uploading it ([`this_run`]),
    /// `None` once it failed. A marker of this run is never offered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
}

/// What a capture the app quit on says when it comes back.
pub const INTERRUPTED: &str = "Hippius closed before this was uploaded. Retry to upload it.";

/// This run of the app: its process and when it started, so a marker of a
/// run that ended is told apart from one whose capture is still going.
#[must_use]
pub fn this_run() -> &'static str {
    static RUN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    RUN.get_or_init(|| {
        let started = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        format!("{}-{started}", std::process::id())
    })
}

impl KeptFailed {
    /// The marker for a failed `card`, or `None` for a card that is not a
    /// kept failure (it uploaded, or its file is the user's own folder).
    #[must_use]
    pub fn from_card(account: &str, card: &PreviewCard) -> Option<Self> {
        if !card.is_parkable() {
            return None;
        }
        let PreviewStatus::Failed { message, reason, .. } = &card.status else {
            return None;
        };
        Some(Self {
            account: account.to_string(),
            kind: card.kind,
            destination: card.destination.clone(),
            message: message.clone(),
            reason: *reason,
            stopped_at_free_limit: card.stopped_at_free_limit,
            thumbnail: card.thumbnail.clone(),
            awaiting_setup: false,
            run: None,
        })
    }

    /// The marker for a capture this run is still recording or uploading:
    /// offered only if the app quits before it reaches the drive.
    #[must_use]
    pub fn in_flight(account: &str, kind: CaptureKind, destination: CaptureDestination, awaiting_setup: bool, thumbnail: Option<String>) -> Self {
        Self {
            account: account.to_string(),
            kind,
            destination,
            message: INTERRUPTED.into(),
            reason: FailureReason::Other,
            stopped_at_free_limit: false,
            thumbnail,
            awaiting_setup,
            run: Some(this_run().to_string()),
        }
    }

    /// This marker once its delivery failed: why, and the drive it was
    /// being sent to when delivery got that far (`sent_to`). No longer of
    /// this run, so it is offered from now on, card or no card.
    #[must_use]
    pub fn failed(self, sent_to: Option<CaptureDestination>, message: String, reason: FailureReason) -> Self {
        Self {
            awaiting_setup: self.awaiting_setup && sent_to.is_none(),
            destination: sent_to.unwrap_or(self.destination),
            message,
            reason,
            run: None,
            ..self
        }
    }
}

/// The capture's own folder when `file` is directly inside a `capture-…`
/// folder of `root`, the only place a marker is ever written.
fn own_folder<'a>(root: &Path, file: &'a Path) -> Option<&'a Path> {
    file.parent().filter(|dir| is_own_dir(root, dir))
}

fn is_own_dir(root: &Path, dir: &Path) -> bool {
    dir.parent() == Some(root) && dir.file_name().is_some_and(|n| n.to_string_lossy().starts_with("capture-"))
}

/// Write (or rewrite) the marker for `file`.
pub fn write(root: &Path, file: &Path, kept: &KeptFailed) {
    if let Some(dir) = own_folder(root, file) {
        write_in(root, dir, kept);
    }
}

/// Write (or rewrite) the marker in capture folder `dir`, for the capture
/// that is (or will be) in it: a recording marks its folder as it starts.
pub fn write_in(root: &Path, dir: &Path, kept: &KeptFailed) {
    if !is_own_dir(root, dir) {
        return;
    }
    match serde_json::to_vec(kept) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(dir.join(MARKER), bytes) {
                tracing::warn!(error = %e, "failed capture: its marker could not be written");
            }
        }
        Err(e) => tracing::warn!(error = %e, "failed capture: its marker could not be made"),
    }
}

/// Remove the marker for `file`: the capture reached the drive.
pub fn clear(root: &Path, file: &Path) {
    if let Some(dir) = own_folder(root, file) {
        let _ = std::fs::remove_file(dir.join(MARKER));
    }
}

/// The capture file a marker sits beside: the folder's one file that is
/// not the marker or a leftover the recorder writes beside a recording.
fn capture_file(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    entries.flatten().map(|e| e.path()).find(|p| {
        p.is_file()
            && p.file_name().is_some_and(|n| {
                let n = n.to_string_lossy();
                n != MARKER && n != "poster.png" && !n.starts_with('.')
            })
            && p.extension()
                .is_some_and(|ext| ["png", "jpg", "jpeg", "mp4", "mov", "webm"].iter().any(|v| ext.eq_ignore_ascii_case(v)))
    })
}

/// What a recording that would not stop cleanly left in its folder, when
/// it is worth keeping: a video of at least `MIN_PARTIAL_BYTES` (the
/// recorder writes fragments as it goes, so it plays up to the last one).
#[must_use]
pub fn salvageable_recording(dir: &Path) -> Option<PathBuf> {
    let file = capture_file(dir)?;
    let video = file
        .file_name()
        .is_some_and(|n| super::recording_allowance::is_video_name(&n.to_string_lossy()));
    (video && !too_short_to_play(&file)).then_some(file)
}

/// A recording the app quit on before it held a single fragment: nothing
/// in it would play, so nothing is offered.
fn too_short_to_play(file: &Path) -> bool {
    let video = file
        .file_name()
        .is_some_and(|n| super::recording_allowance::is_video_name(&n.to_string_lossy()));
    video && std::fs::metadata(file).map_or(0, |m| m.len()) < super::recording::helper::MIN_PARTIAL_BYTES
}

/// Every kept failure of `account` under `root`, newest first, skipping
/// `except` (files a card already shows or holds parked) and captures this
/// run is still recording or uploading.
#[must_use]
pub fn list(root: &Path, account: &str, except: &[PathBuf]) -> Vec<(PathBuf, KeptFailed)> {
    list_for_run(root, account, except, this_run())
}

/// [`list`] as run `run` sees it, so tests can be a later run.
fn list_for_run(root: &Path, account: &str, except: &[PathBuf], run: &str) -> Vec<(PathBuf, KeptFailed)> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut found: Vec<(std::time::SystemTime, PathBuf, KeptFailed)> = entries
        .flatten()
        .filter_map(|entry| {
            let dir = entry.path();
            let marker = dir.join(MARKER);
            let kept: KeptFailed = serde_json::from_slice(&std::fs::read(&marker).ok()?).ok()?;
            if kept.account != account || kept.run.as_deref() == Some(run) {
                return None;
            }
            let file = capture_file(&dir)?;
            if except.contains(&file) || (kept.run.is_some() && too_short_to_play(&file)) {
                return None;
            }
            let at = std::fs::metadata(&marker).and_then(|m| m.modified()).ok()?;
            Some((at, file, kept))
        })
        .collect();
    found.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    found.into_iter().map(|(_, file, kept)| (file, kept)).collect()
}

/// The card a kept failure comes back as: failed, with Retry (and Upgrade
/// when the plan was full), sent to the drive it was going to.
#[must_use]
pub fn card(id: u64, file: &Path, kept: KeptFailed, remote: bool) -> Option<PreviewCard> {
    let file_name = file.file_name()?.to_str()?.to_string();
    Some(
        PreviewCard {
            id,
            kind: kept.kind,
            rel_path: kept.destination.rel_path(&file_name),
            file_name,
            drive_label: kept.destination.label.clone(),
            drive_name: kept.destination.display_name.clone(),
            remote,
            thumbnail: kept.thumbnail,
            status: PreviewStatus::Failed {
                message: kept.message,
                reason: kept.reason,
                retryable: true,
            },
            link: super::preview::LinkState::None,
            link_text: None,
            link_note: None,
            actions: super::preview::CardActions::default(),
            settled: false,
            notice: None,
            share_url: None,
            share_token: None,
            file_path: file.to_path_buf(),
            placed_path: None,
            destination: kept.destination,
            // Delivery asks where captures go for a card kept on this
            // computer (its Retry too), as it did before the restart.
            kept_locally: kept.awaiting_setup,
            stopped_at_free_limit: kept.stopped_at_free_limit,
        }
        .refreshed(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kept(account: &str) -> KeptFailed {
        KeptFailed {
            account: account.into(),
            kind: CaptureKind::Screenshot,
            destination: CaptureDestination::own("Hippius Captures", "Hippius Captures"),
            message: "Your storage is full.".into(),
            reason: FailureReason::StorageFull,
            stopped_at_free_limit: false,
            thumbnail: None,
            awaiting_setup: false,
            run: None,
        }
    }

    fn capture_in(root: &Path, dir: &str, name: &str) -> PathBuf {
        let dir = root.join(dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(name);
        std::fs::write(&file, b"pixels").unwrap();
        file
    }

    /// A failed capture's marker survives on disk, comes back as a failed
    /// card offering Retry and Upgrade for its own account only, and goes
    /// once the capture reaches the drive, leaving the file alone.
    #[test]
    fn a_failed_capture_comes_back_after_a_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let file = capture_in(root, "capture-1", "Screenshot 2026-10-01 at 10.00.00.png");
        write(root, &file, &kept("alice"));
        assert!(list(root, "bob", &[]).is_empty(), "another account's capture is not offered");
        let found = list(root, "alice", &[]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, file);
        assert!(
            list(root, "alice", std::slice::from_ref(&file)).is_empty(),
            "one already showing is skipped"
        );

        let (path, marker) = found.into_iter().next().unwrap();
        let card = card(9, &path, marker, false).unwrap();
        assert!(card.can_retry());
        assert!(card.is_parkable(), "closed again, it is parked again");
        assert!(card.actions.upgrade && card.actions.discard);
        assert_eq!(card.destination.label, "Hippius Captures");

        clear(root, &file);
        assert!(list(root, "alice", &[]).is_empty());
        assert!(file.exists(), "the capture itself is never removed");
    }

    /// Only a capture's own temp folder gets a marker, never a folder of
    /// the user's (a capture kept in their drive folder).
    #[test]
    fn a_marker_is_only_written_in_a_capture_temp_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mine = capture_in(&root.join("Documents"), "Hippius Captures", "Screenshot.png");
        write(root, &mine, &kept("alice"));
        assert!(!mine.with_file_name(MARKER).exists());
        let not_ours = capture_in(root, "other", "Screenshot.png");
        write(root, &not_ours, &kept("alice"));
        assert!(!not_ours.with_file_name(MARKER).exists());
    }

    /// A marker whose capture file is gone, or that cannot be read, offers
    /// nothing.
    #[test]
    fn a_marker_without_its_capture_offers_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let file = capture_in(root, "capture-2", "Recording 2026-10-01 at 10.00.00.mp4");
        write(root, &file, &kept("alice"));
        std::fs::remove_file(&file).unwrap();
        assert!(list(root, "alice", &[]).is_empty());
        let other = capture_in(root, "capture-3", "Screenshot.png");
        std::fs::write(other.with_file_name(MARKER), b"{not json").unwrap();
        assert!(list(root, "alice", &[]).is_empty());
    }

    /// Only a failure Retry can act on is kept: an uploaded card is not.
    #[test]
    fn only_a_retryable_failure_is_kept() {
        let tmp = tempfile::tempdir().unwrap();
        let file = capture_in(tmp.path(), "capture-4", "Screenshot.png");
        let failed = card(1, &file, kept("alice"), false).unwrap();
        assert_eq!(KeptFailed::from_card("alice", &failed), Some(kept("alice")));
        let uploaded = PreviewCard {
            status: PreviewStatus::Uploaded {
                link_copied: false,
                link_error: None,
            },
            ..failed
        }
        .refreshed();
        assert_eq!(KeptFailed::from_card("alice", &uploaded), None);
    }

    /// A recording or upload this run is still busy with is never offered
    /// (it is not finished, let alone failed); once the app has quit on it,
    /// the next run offers it with Retry and says why.
    #[test]
    fn a_capture_the_app_quit_on_comes_back_at_the_next_run() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let file = capture_in(root, "capture-5", "Recording 2026-10-01 at 10.00.00.mp4");
        std::fs::write(&file, vec![0u8; 64 * 1024]).unwrap();
        let destination = CaptureDestination::own("Hippius Captures", "Hippius Captures");
        write(
            root,
            &file,
            &KeptFailed::in_flight("alice", CaptureKind::Recording, destination, false, None),
        );
        assert!(list(root, "alice", &[]).is_empty(), "still recording or uploading in this run");

        let found = list_for_run(root, "alice", &[], "a later run");
        assert_eq!(found.len(), 1, "the next run offers it");
        let (path, marker) = found.into_iter().next().unwrap();
        assert_eq!(marker.message, INTERRUPTED);
        let card = card(3, &path, marker, false).unwrap();
        assert!(card.can_retry() && card.is_parkable());
        assert_eq!(card.kind, CaptureKind::Recording);

        // The upload then failed in this run: the failure replaces it and is
        // offered at once (the next capture, or sign-in).
        write(root, &file, &kept("alice"));
        assert_eq!(list(root, "alice", &[]).len(), 1);
        clear(root, &file);
        assert!(list_for_run(root, "alice", &[], "a later run").is_empty(), "delivered: nothing to offer");
    }

    /// A capture marked before any captures drive existed comes back asking
    /// where captures go, never sent to the placeholder drive name.
    #[test]
    fn a_capture_marked_before_setup_asks_for_the_folder_on_retry() {
        let tmp = tempfile::tempdir().unwrap();
        let file = capture_in(tmp.path(), "capture-6", "Screenshot.png");
        let destination = CaptureDestination::own("Hippius Captures", "Hippius Captures");
        let marker = KeptFailed::in_flight("alice", CaptureKind::Screenshot, destination, true, None);
        let card = card(4, &file, marker, false).unwrap();
        assert!(card.kept_locally, "delivery runs setup for it");
        assert!(card.can_retry());
    }

    /// A recording whose stop went wrong keeps a file that holds at least a
    /// fragment; a header with no picture, or no video at all, is not kept.
    #[test]
    fn a_recording_that_would_not_stop_is_salvaged_when_it_holds_a_fragment() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("capture-7");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(salvageable_recording(&dir), None, "nothing written");
        std::fs::write(dir.join("poster.png"), vec![0u8; 64 * 1024]).unwrap();
        let file = dir.join("Recording 2026-10-01 at 10.00.00.mp4");
        std::fs::write(&file, vec![0u8; 512]).unwrap();
        assert_eq!(salvageable_recording(&dir), None, "too small to hold a fragment");
        let size = usize::try_from(super::super::recording::helper::MIN_PARTIAL_BYTES).unwrap();
        std::fs::write(&file, vec![0u8; size]).unwrap();
        assert_eq!(salvageable_recording(&dir), Some(file));
    }

    /// An upload that fails after its card was closed or replaced still
    /// leaves its marker: it is offered on the next capture in this very
    /// run, going to the drive delivery chose, with the failure's words.
    #[test]
    fn a_failure_with_no_card_on_screen_is_still_offered() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let file = capture_in(root, "capture-8", "Recording 2026-10-01 at 10.00.00.mp4");
        std::fs::write(&file, vec![0u8; 64 * 1024]).unwrap();
        let placeholder = CaptureDestination::own("Hippius Captures", "Hippius Captures");
        let marked = KeptFailed::in_flight("alice", CaptureKind::Recording, placeholder, true, None);
        write(root, &file, &marked);
        assert!(list(root, "alice", &[]).is_empty());

        let chosen = CaptureDestination::own("Hippius Captures-2", "Hippius Captures");
        let failed = marked
            .clone()
            .failed(Some(chosen.clone()), "You're offline.".into(), FailureReason::Offline);
        write(root, &file, &failed);
        let found = list(root, "alice", &[]);
        assert_eq!(found.len(), 1, "offered again in this run");
        let kept = &found[0].1;
        assert_eq!(kept.destination, chosen);
        assert!(!kept.awaiting_setup, "the drive was set up by then");
        assert_eq!(kept.reason, FailureReason::Offline);

        // Failed before any drive was set up: Retry still asks for one.
        let early = marked.failed(None, "You're offline.".into(), FailureReason::Offline);
        assert!(early.awaiting_setup && early.run.is_none());
    }

    /// A recording marked as it started is offered after a quit only once
    /// it holds a fragment: one the app quit on in its first moment has
    /// nothing that would play.
    #[test]
    fn a_recording_quit_on_before_a_fragment_offers_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let file = capture_in(root, "capture-9", "Recording 2026-10-01 at 10.00.00.mp4");
        let dir = file.parent().unwrap();
        let destination = CaptureDestination::own("Hippius Captures", "Hippius Captures");
        write_in(
            root,
            dir,
            &KeptFailed::in_flight("alice", CaptureKind::Recording, destination, false, None),
        );
        assert!(list_for_run(root, "alice", &[], "a later run").is_empty(), "a header, no picture");
        std::fs::write(&file, vec![0u8; 64 * 1024]).unwrap();
        assert_eq!(list_for_run(root, "alice", &[], "a later run").len(), 1);
        write_in(root, &root.join("not-a-capture"), &kept("alice"));
        assert!(!root.join("not-a-capture").join(MARKER).exists());
    }
}
