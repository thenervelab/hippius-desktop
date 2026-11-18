//! Making a synced drive's folder agree with a committed move, with no
//! second transfer.
//!
//! After the commit the server holds each copy in the destination and no
//! longer holds its source. A sync engine left alone would get there too:
//! the source drive's engine deletes each local source (remote delete), and
//! the destination's downloads each copy (remote add). That costs a full
//! download of everything moved, can trip the mass-delete hold on a large
//! move, and asks "Drive empty on Hippius?" when the move emptied a drive.
//!
//! So the desktop does on disk exactly what those cycles would end in, while
//! it holds the drives' sync locks (no cycle runs in between):
//!
//! - the destination file is put in place from plaintext already on this
//!   computer (the source file itself, or the copy downloaded to re-encrypt
//!   it). Its content is the copy's, so the destination engine's next scan
//!   finds local and remote with the same content hash, which hcfs's planner
//!   classifies as "both created, same content": no transfer, and the merge
//!   base is written with the server's revision (`update_synced_tree`);
//! - the source file is removed. Local and remote are then both gone, which
//!   the planner classifies as "both deleted": nothing to do, and the merge
//!   base entry is dropped.
//!
//! Every step is one the engines would take themselves, so stopping half
//! way (the app quits, a disk error) loses nothing: whatever was not done
//! here, the next cycles do. A source file that changed after it was read is
//! never touched (its engine raises the usual "changed here, deleted on
//! Hippius" question), and a destination path that is already taken is never
//! overwritten (its engine reconciles it against the server's copy).
//! Pinned against the pinned engine by `tests/drive_move_local_sync.rs`.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// What a file looked like when its bytes were read for the copy. A file
/// that no longer looks like this has changed since and is left alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileStamp {
    pub len: u64,
    pub modified: Option<SystemTime>,
}

impl FileStamp {
    pub fn of(path: &Path) -> Option<Self> {
        let meta = std::fs::symlink_metadata(path).ok()?;
        meta.is_file().then(|| Self {
            len: meta.len(),
            modified: meta.modified().ok(),
        })
    }
}

/// One moved file, as far as this computer is concerned.
#[derive(Clone, Debug)]
pub struct LocalFile {
    /// The source file's path in the source drive's folder, when its bytes
    /// were read from there, and how it looked then.
    pub source: Option<(String, FileStamp)>,
    /// The plaintext downloaded to re-encrypt it, when it was not read from
    /// the source folder.
    pub downloaded: Option<PathBuf>,
    /// The copy's path in the destination drive.
    pub dest_rel: String,
}

/// What [`place_after_commit`] did, for the log.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PlacementReport {
    /// Files put in place in the destination folder.
    pub placed: usize,
    /// Source files removed from the source folder.
    pub removed: usize,
    /// Files left for the engines (changed since read, or a taken path).
    pub left: usize,
}

/// The local side of a committed move. Either root may be absent (that
/// drive is not synced here). `moved_folders` are source-relative folders
/// the move carried whole; the ones left empty are removed.
pub fn place_after_commit(source_root: Option<&Path>, dest_root: Option<&Path>, files: &[LocalFile], moved_folders: &[String]) -> PlacementReport {
    let mut report = PlacementReport::default();
    for file in files {
        // The source as it was read, or nothing to act on.
        let source_abs = source_root.zip(file.source.as_ref()).and_then(|(root, (rel, stamp))| {
            let abs = root.join(rel);
            (FileStamp::of(&abs) == Some(*stamp)).then_some(abs)
        });
        let changed_source = file.source.is_some() && source_root.is_some() && source_abs.is_none();
        if changed_source {
            report.left += 1;
        }

        if let Some(dest_root) = dest_root {
            let dest_abs = dest_root.join(&file.dest_rel);
            let placed = if dest_abs.symlink_metadata().is_ok() {
                false
            } else if let Some(src) = &source_abs {
                put_in_place(src, &dest_abs)
            } else if let Some(downloaded) = &file.downloaded {
                put_in_place(downloaded, &dest_abs)
            } else {
                false
            };
            if placed {
                report.placed += 1;
            } else {
                report.left += 1;
            }
        }

        // Still there unless it was just moved into place: its content is on
        // Hippius as the copy, and both engines would remove it anyway.
        if let Some(src) = &source_abs
            && src.symlink_metadata().is_ok()
        {
            match std::fs::remove_file(src) {
                Ok(()) => report.removed += 1,
                Err(e) => tracing::debug!(error = %e, "drive move: could not remove a moved source file"),
            }
        } else if source_abs.is_some() {
            report.removed += 1;
        }
    }
    if let Some(root) = source_root {
        for folder in moved_folders {
            remove_empty_dirs(root, &root.join(folder));
        }
    }
    report
}

/// Move `from` to `to`, creating `to`'s folder. A rename when both are on
/// one volume (instant, and the bytes never move); otherwise a copy into a
/// hidden sibling the engine skips, then a rename, so a scan never sees a
/// half-written file. `from` is gone on success.
fn put_in_place(from: &Path, to: &Path) -> bool {
    let Some(dir) = to.parent() else { return false };
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    if std::fs::rename(from, to).is_ok() {
        return true;
    }
    let incoming = dir.join(format!(".hippius-incoming-{}", uuid::Uuid::new_v4()));
    let copied = std::fs::copy(from, &incoming).is_ok() && to.symlink_metadata().is_err() && std::fs::rename(&incoming, to).is_ok();
    if !copied {
        let _ = std::fs::remove_file(&incoming);
        return false;
    }
    let _ = std::fs::remove_file(from);
    true
}

/// Remove `dir` and the folders under it that are empty, deepest first.
/// `remove_dir` only: a folder still holding anything (a hidden file, an
/// excluded one, a file that changed) stays, with its contents.
fn remove_empty_dirs(root: &Path, dir: &Path) {
    if !dir.starts_with(root) || dir == root {
        return;
    }
    let mut stack = vec![dir.to_path_buf()];
    let mut order = Vec::new();
    while let Some(next) = stack.pop() {
        let Ok(meta) = next.symlink_metadata() else { continue };
        if !meta.is_dir() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(&next) {
            for entry in entries.flatten() {
                if entry.file_type().is_ok_and(|t| t.is_dir()) {
                    stack.push(entry.path());
                }
            }
        }
        order.push(next);
    }
    for folder in order.into_iter().rev() {
        let _ = std::fs::remove_dir(folder);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, body: &str) -> FileStamp {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        FileStamp::of(&path).unwrap()
    }

    #[test]
    fn synced_to_synced_moves_the_file_itself() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let stamp = write(src.path(), "Trip/a.jpg", "a");
        let report = place_after_commit(
            Some(src.path()),
            Some(dst.path()),
            &[LocalFile {
                source: Some(("Trip/a.jpg".into(), stamp)),
                downloaded: None,
                dest_rel: "Albums/Trip/a.jpg".into(),
            }],
            &["Trip".into()],
        );
        assert_eq!(std::fs::read_to_string(dst.path().join("Albums/Trip/a.jpg")).unwrap(), "a");
        assert!(!src.path().join("Trip").exists(), "the emptied folder goes too");
        assert_eq!(report.placed, 1);
        assert_eq!(report.removed, 1);
    }

    #[test]
    fn a_source_changed_since_it_was_read_is_never_touched() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let stamp = write(src.path(), "a.txt", "read");
        std::fs::write(src.path().join("a.txt"), "edited after the read").unwrap();
        let report = place_after_commit(
            Some(src.path()),
            Some(dst.path()),
            &[LocalFile {
                source: Some(("a.txt".into(), stamp)),
                downloaded: None,
                dest_rel: "a.txt".into(),
            }],
            &[],
        );
        assert_eq!(std::fs::read_to_string(src.path().join("a.txt")).unwrap(), "edited after the read");
        assert!(!dst.path().join("a.txt").exists(), "the destination engine downloads the copy instead");
        assert_eq!(report.removed, 0);
    }

    #[test]
    fn a_taken_destination_is_never_overwritten() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let stamp = write(src.path(), "a.txt", "moved");
        write(dst.path(), "a.txt", "someone else's");
        let report = place_after_commit(
            Some(src.path()),
            Some(dst.path()),
            &[LocalFile {
                source: Some(("a.txt".into(), stamp)),
                downloaded: None,
                dest_rel: "a.txt".into(),
            }],
            &[],
        );
        assert_eq!(std::fs::read_to_string(dst.path().join("a.txt")).unwrap(), "someone else's");
        assert!(
            !src.path().join("a.txt").exists(),
            "the moved source still leaves: its content is the copy on Hippius"
        );
        assert_eq!(report.placed, 0);
    }

    #[test]
    fn a_browsed_source_places_the_downloaded_plaintext() {
        let dst = tempfile::tempdir().unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let downloaded = scratch.path().join("plain.tmp");
        std::fs::write(&downloaded, "copy").unwrap();
        let report = place_after_commit(
            None,
            Some(dst.path()),
            &[LocalFile {
                source: None,
                downloaded: Some(downloaded.clone()),
                dest_rel: "In/a.txt".into(),
            }],
            &[],
        );
        assert_eq!(std::fs::read_to_string(dst.path().join("In/a.txt")).unwrap(), "copy");
        assert!(!downloaded.exists());
        assert_eq!(report.placed, 1);
    }

    #[test]
    fn a_browsed_destination_only_removes_the_unchanged_source() {
        let src = tempfile::tempdir().unwrap();
        let stamp = write(src.path(), "F/a.txt", "a");
        write(src.path(), "F/.hidden", "kept");
        let report = place_after_commit(
            Some(src.path()),
            None,
            &[LocalFile {
                source: Some(("F/a.txt".into(), stamp)),
                downloaded: None,
                dest_rel: "a.txt".into(),
            }],
            &["F".into()],
        );
        assert!(!src.path().join("F/a.txt").exists());
        assert!(src.path().join("F/.hidden").exists(), "a folder holding anything else stays");
        assert_eq!(report.removed, 1);
    }

    #[test]
    fn empty_folder_removal_never_leaves_the_root() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("a/b")).unwrap();
        remove_empty_dirs(root.path(), root.path());
        assert!(root.path().join("a/b").exists(), "the root itself is never a moved folder");
        remove_empty_dirs(root.path(), &root.path().join("a"));
        assert!(!root.path().join("a").exists());
        assert!(root.path().exists());
    }
}
