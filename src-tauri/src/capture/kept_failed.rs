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
        })
    }
}

/// The capture's own folder when `file` is directly inside a `capture-…`
/// folder of `root`, the only place a marker is ever written.
fn own_folder<'a>(root: &Path, file: &'a Path) -> Option<&'a Path> {
    let dir = file.parent()?;
    let ours = dir.parent() == Some(root) && dir.file_name().is_some_and(|n| n.to_string_lossy().starts_with("capture-"));
    ours.then_some(dir)
}

/// Write (or rewrite) the marker for `file`.
pub fn write(root: &Path, file: &Path, kept: &KeptFailed) {
    let Some(dir) = own_folder(root, file) else { return };
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

/// Every kept failure of `account` under `root`, newest first, skipping
/// `except` (files a card already shows or holds parked).
#[must_use]
pub fn list(root: &Path, account: &str, except: &[PathBuf]) -> Vec<(PathBuf, KeptFailed)> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut found: Vec<(std::time::SystemTime, PathBuf, KeptFailed)> = entries
        .flatten()
        .filter_map(|entry| {
            let dir = entry.path();
            let marker = dir.join(MARKER);
            let kept: KeptFailed = serde_json::from_slice(&std::fs::read(&marker).ok()?).ok()?;
            if kept.account != account {
                return None;
            }
            let file = capture_file(&dir)?;
            if except.contains(&file) {
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
            kept_locally: false,
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
}
