//! Walk a folder that lives outside every drive into the entries an
//! uploaded-copy folder link is built from
//! (`hcfs_client::client::folder_share::create_upload_folder_share`).
//!
//! Pure apart from reading the tree, so the rules (what is skipped, what is
//! kept, where the walk refuses) are unit-tested on a tempdir without a
//! server. The skip rules are the drive upload's own
//! ([`crate::sync::files::pathops::visible_children`]), not a second copy: a
//! folder shared here holds the same file set it would hold if uploaded into
//! a drive.
//!
//! The limits are hcfs-shared's, measured with hcfs-shared's own functions,
//! so every refusal here is one the client's plan (and the server) would make
//! anyway; doing it here only buys a sentence that names the item to fix,
//! before the storage gate or any request.
//!
//! Nothing visible is left out silently. An item the walk cannot read (a
//! folder it cannot list, a child it cannot examine) and a name that is not
//! valid UTF-8 (no spelling in a link's paths; APFS cannot create one) each
//! refuse the share, naming the item. Only hidden names, symlinks, special
//! files and an entry deleted mid-scan are skipped.
//!
//! Two names that become one path once Unicode-normalized (`é` composed and
//! decomposed) are NOT checked here. APFS, the volume Finder shares from, is
//! normalization-insensitive and cannot hold such a pair; on a volume that
//! can, the client refuses it in its request-free plan
//! (`FolderShareError::PathCollision`), and the caller maps that. Repeating
//! the client's raw-spelling comparison here would be a second copy that has
//! to stay byte-identical to it.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use hcfs_client::client::folder_share::UploadFolderEntry;
use hcfs_shared::path_validator::{self, PathValidationError};
use hcfs_shared::shares::{
    MAX_UPLOAD_FOLDER_SHARE_DIRS, MAX_UPLOAD_FOLDER_SHARE_DIRS_BYTES, MAX_UPLOAD_FOLDER_SHARE_FILE_CIPHERTEXT, MAX_UPLOAD_FOLDER_SHARE_FILES,
    drive_framed_ciphertext_size, upload_folder_share_dirs_bytes,
};
use unicode_normalization::UnicodeNormalization;

use crate::error::{AppError, Result};
use crate::shares::outside_folder::SHARE_CANCELLED;
use crate::sync::files::pathops::{VisibleKind, visible_children};

/// Bounds one scan enforces. A struct so tests can shrink them; production
/// always uses [`ScanLimits::SHARED_FOLDER`].
#[derive(Clone, Copy, Debug)]
pub(crate) struct ScanLimits {
    /// Most files one link holds.
    pub files: usize,
    /// Most directories one link holds, counting every ancestor of every
    /// entry (`hcfs_shared::shares::upload_folder_share_dir_closure`).
    pub dirs: usize,
    /// Byte budget of the empty directories' paths, as the open request
    /// sends them.
    pub dirs_bytes_budget: usize,
    /// Largest ciphertext of one file, in the drive framing.
    pub file_ciphertext: u64,
}

impl ScanLimits {
    pub(crate) const SHARED_FOLDER: Self = Self {
        files: MAX_UPLOAD_FOLDER_SHARE_FILES as usize,
        dirs: MAX_UPLOAD_FOLDER_SHARE_DIRS as usize,
        dirs_bytes_budget: MAX_UPLOAD_FOLDER_SHARE_DIRS_BYTES,
        file_ciphertext: MAX_UPLOAD_FOLDER_SHARE_FILE_CIPHERTEXT,
    };
}

/// The scanned folder: what to upload and what it will cost.
#[derive(Debug)]
pub(crate) struct FolderScan {
    /// Every file, plus every directory with nothing visible inside it.
    /// Paths are spelled exactly as the scan read them (no normalization),
    /// as `UploadFolderEntry` requires.
    pub entries: Vec<UploadFolderEntry>,
    pub file_count: usize,
    /// Plaintext bytes of every file, the size the `/can_upload` gate asks
    /// about (an uploaded copy bills plaintext).
    pub total_bytes: u64,
}

/// Scan `root` with the production limits on the blocking pool, stopping
/// the walk once this future is dropped.
///
/// The scan is up to 50,000 stats, so it never runs on an async worker or
/// the main thread. A blocking task cannot be aborted, so without the stop
/// flag a share cancelled mid-scan, or a chooser that stopped waiting for a
/// size, would leave the walk running to the end for nobody, and repeated
/// clicks would stack such walks on the pool.
///
/// # Errors
///
/// The outer error is the task failing (a panic, or the runtime shutting
/// down); the inner one is [`scan_folder`]'s.
pub(crate) async fn scan_until_dropped(root: PathBuf) -> std::result::Result<Result<FolderScan>, tokio::task::JoinError> {
    let stop = Arc::new(AtomicBool::new(false));
    let _stop_on_drop = StopOnDrop(Arc::clone(&stop));
    tokio::task::spawn_blocking(move || scan_folder(&root, &stop)).await
}

/// Raises the walk's stop flag when the future awaiting it is dropped (or
/// completes, when the flag no longer matters).
struct StopOnDrop(Arc<AtomicBool>);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// Scan `root` with the production limits, giving up once `stop` is set.
/// Blocking; [`scan_until_dropped`] runs it off the async workers.
pub(crate) fn scan_folder(root: &Path, stop: &AtomicBool) -> Result<FolderScan> {
    scan_folder_with(root, &ScanLimits::SHARED_FOLDER, stop)
}

/// Scan `root` for an uploaded-copy link.
///
/// Paths are `/`-joined and relative to `root`; its own name is the link's
/// display name, not a path segment. A visible directory with no visible
/// children is kept as a `Dir` entry so the recipient still sees it. Every
/// other directory is implied by the entries under it.
///
/// # Errors
///
/// [`AppError::Validation`], naming the item where there is one, for an
/// unreadable directory, a name the link cannot hold (or a path too deep or
/// long), a file over the size cap, too many files, too many directories,
/// empty-folder names too long to send together, or a folder with no files;
/// [`SHARE_CANCELLED`] once `stop` is set.
pub(crate) fn scan_folder_with(root: &Path, limits: &ScanLimits, stop: &AtomicBool) -> Result<FolderScan> {
    let mut walk = Walk::new(limits);
    let mut pending = vec![(root.to_path_buf(), String::new())];

    while let Some((dir, relative)) = pending.pop() {
        // Checked per directory: one listing is the unit of work, and a
        // flat folder's listing is bounded by the file cap anyway.
        // Relaxed: the flag carries no data, only "stop soon".
        if stop.load(Ordering::Relaxed) {
            return Err(AppError::Validation(SHARE_CANCELLED.into()));
        }
        let mut children = visible_children(&dir).map_err(|e| unreadable(&relative, &e))?;
        if children.is_empty() {
            // The root itself is the link, not an entry of it.
            if !relative.is_empty() {
                walk.empty_dir(relative)?;
            }
            continue;
        }

        // Deterministic order, so a share of the same tree always declares
        // the same list.
        children.sort_by(|a, b| a.name.cmp(&b.name));
        for child in children {
            let child_relative = join(&relative, &child.name);
            match child.kind {
                VisibleKind::File { size } => walk.file(child_relative, child.path, size)?,
                VisibleKind::Dir => {
                    walk.enter_dir(&child_relative)?;
                    pending.push((child.path, child_relative));
                }
                VisibleKind::Unreadable { error } => return Err(unreadable(&child_relative, &error)),
                VisibleKind::NotText => return Err(not_text(&child_relative)),
            }
        }
    }

    walk.finish()
}

/// The scan in progress: what it has kept and what it has counted.
struct Walk<'l> {
    limits: &'l ScanLimits,
    scan: FolderScan,
    /// Every directory entered. Each visible directory is either listed
    /// (it is empty) or an ancestor of something listed, so this is exactly
    /// the closure `upload_folder_share_dir_closure` takes of what the scan
    /// sends. Counted as the walk goes, so a huge tree stops at the cap
    /// instead of being walked to the end first.
    dir_count: usize,
    /// `upload_folder_share_dirs_bytes` of the empty directories so far.
    /// The function is a sum over entries, so adding one at a time is the
    /// same measure.
    dirs_bytes: usize,
}

impl<'l> Walk<'l> {
    fn new(limits: &'l ScanLimits) -> Self {
        Self {
            limits,
            scan: FolderScan {
                entries: Vec::new(),
                file_count: 0,
                total_bytes: 0,
            },
            dir_count: 0,
            dirs_bytes: 0,
        }
    }

    fn file(&mut self, relative_path: String, source: PathBuf, size: u64) -> Result<()> {
        check_path(&relative_path)?;
        if drive_framed_ciphertext_size(size) > self.limits.file_ciphertext {
            return Err(too_large(&relative_path, self.limits.file_ciphertext));
        }
        if self.scan.file_count >= self.limits.files {
            return Err(AppError::Validation(format!(
                "This folder has more than {}, more than one link can hold. Share a smaller \
                 folder.",
                counted(self.limits.files, "file", "files")
            )));
        }
        self.scan.file_count += 1;
        self.scan.total_bytes = self.scan.total_bytes.saturating_add(size);
        self.scan.entries.push(UploadFolderEntry::File { relative_path, source, size });
        Ok(())
    }

    /// Checked on the way in, so a refused name is reported as the folder
    /// itself (not the first file under it) and the walk never descends
    /// past the path validator's depth limit.
    fn enter_dir(&mut self, relative_path: &str) -> Result<()> {
        check_path(relative_path)?;
        if self.dir_count >= self.limits.dirs {
            return Err(AppError::Validation(format!(
                "This folder has more than {} inside it (counting every folder within \
                 a folder), more than one link can hold. Share a smaller folder.",
                counted(self.limits.dirs, "folder", "folders")
            )));
        }
        self.dir_count += 1;
        Ok(())
    }

    fn empty_dir(&mut self, relative_path: String) -> Result<()> {
        // The client sends the NFC form, so that is what the budget measures.
        let normalized: String = relative_path.nfc().collect();
        let bytes = upload_folder_share_dirs_bytes([normalized.as_str()]);
        self.dirs_bytes = self.dirs_bytes.saturating_add(bytes);
        if self.dirs_bytes > self.limits.dirs_bytes_budget {
            return Err(AppError::Validation(
                "This folder has too many empty folders with long names to share as one link. \
                 Remove some of the empty folders, or share a smaller folder."
                    .into(),
            ));
        }
        self.scan.entries.push(UploadFolderEntry::Dir { relative_path });
        Ok(())
    }

    fn finish(self) -> Result<FolderScan> {
        if self.scan.file_count == 0 {
            return Err(AppError::Validation(
                "This folder has no files to share. Hidden files, such as names starting with a \
                 dot, are not shared."
                    .into(),
            ));
        }
        Ok(self.scan)
    }
}

/// `relative` + `name`, spelled exactly as read: `UploadFolderEntry` tells
/// directories apart by their raw spelling, so nothing here may rewrite a
/// separator or normalize (unlike `remote_upload::wire_relative_path`, which
/// turns a backslash into a folder).
fn join(relative: &str, name: &str) -> String {
    if relative.is_empty() {
        name.to_owned()
    } else {
        format!("{relative}/{name}")
    }
}

/// Refuse a path the server's validator would. The validator accepts NFC
/// only and the client normalizes before validating, so this does too: a
/// decomposed name read from disk is fine.
fn check_path(raw: &str) -> Result<()> {
    let normalized: String = raw.nfc().collect();
    path_validator::validate(&normalized).map_err(|e| invalid_name(raw, &e))
}

/// The sentence for a path the link cannot hold. Exhaustive on purpose: a
/// new validator rule fails the build here instead of reaching the user as
/// the validator's own engineer-facing text.
fn invalid_name(raw: &str, error: &PathValidationError) -> AppError {
    const RENAME: &str = "Rename it and share the folder again.";
    let (reason, fix) = match error {
        PathValidationError::Backslash => ("its name contains a backslash (\\)", RENAME),
        PathValidationError::ControlCharacter => ("its name contains an invisible character, such as a line break", RENAME),
        PathValidationError::FormatCharacter => (
            "its name contains an invisible formatting character (some emoji, such as family \
             or flag emoji, are made with one)",
            RENAME,
        ),
        PathValidationError::SegmentTooLong(_) => ("its name is too long", RENAME),
        PathValidationError::TooLong(_) => (
            "its location inside the folder is too long",
            "Rename it or the folders it is in to something shorter, or share a folder closer \
             to it.",
        ),
        PathValidationError::TooDeep(_) => ("it is more than 64 folders deep", "Share a folder closer to it, or move it higher up."),
        // A name read from disk and normalized never has these; kept as a
        // sentence rather than a panic in case a filesystem surprises us.
        PathValidationError::Empty
        | PathValidationError::LeadingSlash
        | PathValidationError::TrailingSlash
        | PathValidationError::ParentSegment
        | PathValidationError::CurrentSegment
        | PathValidationError::EmptySegment
        | PathValidationError::NotNfc => ("a shared link cannot hold its name", RENAME),
    };
    AppError::Validation(format!("\u{201c}{}\u{201d} can't be shared: {reason}. {fix}", shown(raw)))
}

/// `path` as the dialog may show it: invisible characters become U+FFFD,
/// so the user sees where the bad character is, and a bidi override cannot
/// re-order the rest of our sentence.
fn shown(path: &str) -> String {
    path.chars()
        .map(|c| {
            let invisible = c.is_control() || path_validator::is_bidi_control(c) || path_validator::is_zero_width(c);
            if invisible { '\u{fffd}' } else { c }
        })
        .collect()
}

/// "about": the cap is on ciphertext, so the largest file that fits is a
/// little under the cap, and the cap is binary gigabytes quoted as "GB".
fn too_large(relative_path: &str, max_ciphertext: u64) -> AppError {
    const GIB: u64 = 1024 * 1024 * 1024;
    AppError::Validation(format!(
        "\u{201c}{}\u{201d} is too large to share: one file in a shared folder can be at most \
         about {} GB.",
        shown(relative_path),
        max_ciphertext.div_ceil(GIB)
    ))
}

/// An unreadable item fails the share rather than being skipped: a link
/// silently missing a subfolder is worse than an error. On macOS the usual
/// cause is a privacy prompt the user declined.
///
/// The OS error goes to the log, not the dialog, where it would be
/// engineer-facing text. Logged here, once: this is a single refusal that
/// ends the scan, not a per-file event.
fn unreadable(relative: &str, error: &std::io::Error) -> AppError {
    tracing::warn!(path = %relative, error = %error, "outside-folder share scan: item unreadable");
    let place = if relative.is_empty() {
        "this folder".to_owned()
    } else {
        format!("\u{201c}{}\u{201d}", shown(relative))
    };
    AppError::Validation(format!(
        "Hippius can't read {place}. If macOS asked for access, allow it in System Settings \
         \u{2192} Privacy & Security \u{2192} Files and Folders, then share again."
    ))
}

/// A name that is not valid UTF-8 has no spelling in a link's paths, so
/// it is refused by name rather than left out. `relative` is already the
/// lossy form.
fn not_text(relative: &str) -> AppError {
    AppError::Validation(format!(
        "\u{201c}{}\u{201d} can't be shared: its name contains characters a shared link cannot \
         hold. Rename it and share the folder again.",
        shown(relative)
    ))
}

/// `count` followed by `one` or `many`, so a limit of one reads "1 file".
fn counted(count: usize, one: &str, many: &str) -> String {
    let noun = if count == 1 { one } else { many };
    format!("{} {noun}", grouped(count))
}

/// `50000` as `50,000`, for a limit quoted to the user.
fn grouped(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

#[cfg(test)]
mod tests {
    use hcfs_shared::shares::upload_folder_share_dir_closure;

    use super::*;

    /// A stop flag nobody raises.
    static RUN: AtomicBool = AtomicBool::new(false);

    fn limits() -> ScanLimits {
        ScanLimits::SHARED_FOLDER
    }

    fn validation(err: &AppError) -> &str {
        match err {
            AppError::Validation(message) => message,
            other => panic!("expected a validation error, got {other:?}"),
        }
    }

    fn paths(scan: &FolderScan) -> Vec<String> {
        let mut out: Vec<String> = scan
            .entries
            .iter()
            .map(|e| match e {
                UploadFolderEntry::File { relative_path, .. } => format!("f:{relative_path}"),
                UploadFolderEntry::Dir { relative_path } => format!("d:{relative_path}"),
            })
            .collect();
        out.sort();
        out
    }

    /// `T2-KD/` holding `a.txt` (5 bytes), `sub/deeper/b.bin` (1,000 bytes)
    /// and an empty `empty/`: three directories once ancestors are counted.
    fn tree() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("T2-KD");
        std::fs::create_dir_all(root.join("sub/deeper")).expect("dirs");
        std::fs::create_dir_all(root.join("empty")).expect("empty dir");
        std::fs::write(root.join("a.txt"), b"hello").expect("a");
        std::fs::write(root.join("sub/deeper/b.bin"), vec![7u8; 1_000]).expect("b");
        (dir, root)
    }

    /// A scan nobody waits for any more (a cancelled share, a chooser past
    /// its budget) gives up instead of walking on through the tree.
    #[test]
    fn a_stopped_scan_gives_up() {
        let (_dir, root) = tree();
        let stop = AtomicBool::new(true);

        let err = scan_folder(&root, &stop).expect_err("stopped");

        assert_eq!(validation(&err), SHARE_CANCELLED);
    }

    /// Dropping the scan's future is what raises the flag the blocking walk
    /// reads: the walk itself cannot be dropped.
    #[test]
    fn dropping_the_scan_future_raises_the_stop_flag() {
        let stop = Arc::new(AtomicBool::new(false));
        drop(StopOnDrop(Arc::clone(&stop)));
        assert!(stop.load(Ordering::Relaxed));
    }

    /// The scan finishes when nobody stops it.
    #[tokio::test]
    async fn an_unstopped_scan_runs_off_the_async_worker() {
        let (_dir, root) = tree();
        let scan = scan_until_dropped(root).await.expect("joined").expect("scan");
        assert_eq!(scan.total_bytes, 1_005);
    }

    /// Paths are relative to the shared folder (its own name is the link's
    /// display name), files carry their size, and only EMPTY folders are
    /// listed: `sub/` and `sub/deeper/` are implied by `b.bin`. A folder
    /// holding only hidden names is empty to the link, as it is to a drive.
    #[test]
    fn lists_files_and_only_the_empty_folders() {
        let (_dir, root) = tree();
        std::fs::write(root.join(".DS_Store"), b"x").expect("hidden file");
        std::fs::create_dir_all(root.join(".git")).expect("hidden dir");
        std::fs::write(root.join(".git/config"), b"x").expect("file in hidden dir");
        std::fs::create_dir_all(root.join("only-hidden")).expect("dir");
        std::fs::write(root.join("only-hidden/.keep"), b"").expect("hidden child");

        let scan = scan_folder(&root, &RUN).expect("scan");
        assert_eq!(paths(&scan), vec!["d:empty", "d:only-hidden", "f:a.txt", "f:sub/deeper/b.bin"]);
        assert_eq!(scan.file_count, 2);
        assert_eq!(scan.total_bytes, 1_005);

        let sizes: Vec<(String, u64, PathBuf)> = scan
            .entries
            .iter()
            .filter_map(|e| match e {
                UploadFolderEntry::File { relative_path, source, size } => Some((relative_path.clone(), *size, source.clone())),
                UploadFolderEntry::Dir { .. } => None,
            })
            .collect();
        assert!(sizes.contains(&("a.txt".into(), 5, root.join("a.txt"))), "{sizes:?}");
        assert!(
            sizes.contains(&("sub/deeper/b.bin".into(), 1_000, root.join("sub/deeper/b.bin"))),
            "{sizes:?}"
        );
    }

    /// The same tree always declares the same list, whatever order the
    /// filesystem hands the names back in: each folder's files in name
    /// order, then its folders depth first, last name first (the walk is a
    /// stack). Enough names that `read_dir` order (hash order on APFS and
    /// ext4) is all but certain to differ from name order, so dropping the
    /// sort fails this.
    #[test]
    fn the_entry_order_is_exact() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("Order");
        let names = ["m", "c", "x", "a", "q", "f", "z", "b", "k", "t", "e", "w"];
        for name in names {
            std::fs::create_dir_all(root.join(format!("dir-{name}"))).expect("dir");
            std::fs::write(root.join(format!("dir-{name}/{name}.txt")), b"x").expect("nested file");
            std::fs::write(root.join(format!("{name}.txt")), b"x").expect("file");
        }

        let scan = scan_folder(&root, &RUN).expect("scan");
        let order: Vec<String> = scan
            .entries
            .iter()
            .map(|e| match e {
                UploadFolderEntry::File { relative_path, .. } => relative_path.clone(),
                UploadFolderEntry::Dir { relative_path } => format!("{relative_path}/"),
            })
            .collect();

        let mut sorted = names;
        sorted.sort_unstable();
        let mut expected: Vec<String> = sorted.iter().map(|n| format!("{n}.txt")).collect();
        expected.extend(sorted.iter().rev().map(|n| format!("dir-{n}/{n}.txt")));
        assert_eq!(order, expected);
    }

    /// A link is neither file nor folder to the walk, so a link to a file is
    /// not uploaded twice and a link back to the root is never followed.
    #[cfg(unix)]
    #[test]
    fn never_follows_symlinks() {
        let (_dir, root) = tree();
        std::os::unix::fs::symlink(root.join("a.txt"), root.join("alias.txt")).expect("file link");
        std::os::unix::fs::symlink(&root, root.join("loop")).expect("dir link");

        let scan = scan_folder(&root, &RUN).expect("scan");
        assert_eq!(paths(&scan), vec!["d:empty", "f:a.txt", "f:sub/deeper/b.bin"]);
    }

    #[test]
    fn refuses_a_folder_with_no_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("Nothing");
        std::fs::create_dir_all(root.join("also-empty")).expect("dirs");
        std::fs::write(root.join(".DS_Store"), b"x").expect("hidden only");

        let err = scan_folder(&root, &RUN).expect_err("no files");
        assert!(validation(&err).contains("no files"), "{err:?}");

        let bare = dir.path().join("Bare");
        std::fs::create_dir_all(&bare).expect("dir");
        let err = scan_folder(&bare, &RUN).expect_err("nothing at all");
        assert!(validation(&err).contains("no files"), "{err:?}");
    }

    /// The file cap counts files only, as the client and server do: a kept
    /// empty folder is not a file.
    #[test]
    fn refuses_past_the_file_cap_and_accepts_at_it() {
        let (_dir, root) = tree();
        let at_cap = ScanLimits { files: 2, ..limits() };
        assert!(scan_folder_with(&root, &at_cap, &RUN).is_ok(), "exactly at the cap");

        let past = ScanLimits { files: 1, ..limits() };
        let err = scan_folder_with(&root, &past, &RUN).expect_err("one past");
        let message = validation(&err);
        assert!(message.contains("more than 1 file,"), "{message}");
    }

    /// A limit of one reads "1 folder", not "1 folders".
    #[test]
    fn a_folder_cap_of_one_is_singular() {
        let (_dir, root) = tree();
        let past = ScanLimits { dirs: 1, ..limits() };
        let err = scan_folder_with(&root, &past, &RUN).expect_err("past the cap");
        let message = validation(&err);
        assert!(message.contains("more than 1 folder inside"), "{message}");
    }

    /// The real cap is 5 GiB of ciphertext, a little under 5 GiB of file,
    /// so the sentence says "about".
    #[test]
    fn the_size_cap_is_quoted_as_about_5_gb() {
        let err = too_large("big.mov", ScanLimits::SHARED_FOLDER.file_ciphertext);
        assert!(validation(&err).contains("at most about 5 GB."), "{err:?}");
    }

    /// Directories are counted with every ancestor (`sub` and `sub/deeper`
    /// both count although only `b.bin` names them), and the copy says
    /// folders, never files.
    #[test]
    fn refuses_past_the_folder_cap_counting_every_ancestor() {
        let (_dir, root) = tree();
        let at_cap = ScanLimits { dirs: 3, ..limits() };
        assert!(scan_folder_with(&root, &at_cap, &RUN).is_ok(), "empty, sub, sub/deeper");

        let past = ScanLimits { dirs: 2, ..limits() };
        let err = scan_folder_with(&root, &past, &RUN).expect_err("one past");
        let message = validation(&err);
        assert!(message.contains("more than 2 folders"), "{message}");
        assert!(!message.contains("file"), "a folder limit must not say files: {message}");
    }

    /// The walk's directory count is exactly hcfs-shared's closure of what
    /// the scan sends, the set the client and server count against the cap:
    /// a cap equal to the closure passes, one less refuses.
    #[test]
    fn the_folder_count_is_the_shared_closure() {
        let (_dir, root) = tree();
        std::fs::create_dir_all(root.join("x/y/z")).expect("deep empty");
        std::fs::create_dir_all(root.join("sub/side")).expect("empty beside a file's parent");
        std::fs::write(root.join("x/top.txt"), b"t").expect("file beside an empty chain");

        let scan = scan_folder(&root, &RUN).expect("scan");
        // Only the deepest empty folder of a chain is listed, once: `x` and
        // `x/y` are implied by it (and `x` by `x/top.txt` too).
        assert_eq!(
            paths(&scan),
            vec!["d:empty", "d:sub/side", "d:x/y/z", "f:a.txt", "f:sub/deeper/b.bin", "f:x/top.txt"]
        );

        let mut sent: Vec<&str> = Vec::new();
        for entry in &scan.entries {
            match entry {
                UploadFolderEntry::File { relative_path, .. } => {
                    if let Some((parent, _)) = relative_path.rsplit_once('/') {
                        sent.push(parent);
                    }
                }
                UploadFolderEntry::Dir { relative_path } => sent.push(relative_path),
            }
        }
        let closure = upload_folder_share_dir_closure(sent).expect("well under the cap").len();
        assert_eq!(closure, 7, "empty, sub, sub/deeper, sub/side, x, x/y, x/y/z");

        let at = ScanLimits { dirs: closure, ..limits() };
        assert!(scan_folder_with(&root, &at, &RUN).is_ok());
        let under = ScanLimits {
            dirs: closure - 1,
            ..limits()
        };
        assert!(scan_folder_with(&root, &under, &RUN).is_err());
    }

    /// A chain of empty folders beside a single file is one `Dir` entry,
    /// its deepest folder; the folders above it are implied.
    #[test]
    fn an_all_empty_chain_is_listed_once_by_its_deepest_folder() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("Chain");
        std::fs::create_dir_all(root.join("a/b/c")).expect("empty chain");
        std::fs::write(root.join("only.txt"), b"x").expect("file");

        let scan = scan_folder(&root, &RUN).expect("scan");
        assert_eq!(paths(&scan), vec!["d:a/b/c", "f:only.txt"]);
    }

    /// The per-file cap is on the ciphertext the drive framing produces,
    /// with hcfs-shared's own formula, and the refusal names the file.
    #[test]
    fn refuses_an_oversized_file_naming_it() {
        let (_dir, root) = tree();
        let fits = ScanLimits {
            file_ciphertext: drive_framed_ciphertext_size(1_000),
            ..limits()
        };
        assert!(scan_folder_with(&root, &fits, &RUN).is_ok(), "b.bin's ciphertext is exactly the cap");

        let over = ScanLimits {
            file_ciphertext: drive_framed_ciphertext_size(1_000) - 1,
            ..limits()
        };
        let err = scan_folder_with(&root, &over, &RUN).expect_err("one byte over");
        assert!(validation(&err).contains("\u{201c}sub/deeper/b.bin\u{201d}"), "{err:?}");
    }

    /// The empty folders' names travel in one request; their size is
    /// measured with hcfs-shared's own function.
    #[test]
    fn refuses_empty_folder_names_too_long_to_send_together() {
        let (_dir, root) = tree();
        std::fs::create_dir_all(root.join("another-empty")).expect("second empty dir");
        let budget = upload_folder_share_dirs_bytes(["another-empty", "empty"]);

        let at = ScanLimits {
            dirs_bytes_budget: budget,
            ..limits()
        };
        assert!(scan_folder_with(&root, &at, &RUN).is_ok());
        let under = ScanLimits {
            dirs_bytes_budget: budget - 1,
            ..limits()
        };
        let err = scan_folder_with(&root, &under, &RUN).expect_err("one byte over");
        assert!(validation(&err).contains("empty folders"), "{err:?}");
    }

    /// Names the link cannot hold are refused before anything uploads, each
    /// naming the item to rename. Invisible characters are shown as U+FFFD
    /// so the dialog shows where they are instead of hiding them.
    #[test]
    fn refuses_names_the_link_cannot_hold_naming_them() {
        let cases = [
            ("back\\slash.txt", "back\\slash.txt", "backslash"),
            ("line\nbreak.txt", "line\u{fffd}break.txt", "invisible character"),
            // Family emoji: three people joined by U+200D ZERO WIDTH JOINER.
            (
                "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}.jpg",
                "\u{1f468}\u{fffd}\u{1f469}\u{fffd}\u{1f467}.jpg",
                "emoji",
            ),
        ];
        for (name, shown, reason) in cases {
            let dir = tempfile::tempdir().expect("tempdir");
            let root = dir.path().join("Share");
            std::fs::create_dir_all(root.join("in")).expect("dir");
            std::fs::write(root.join("ok.txt"), b"x").expect("fine file");
            std::fs::write(root.join("in").join(name), b"x").expect("odd name");

            let err = scan_folder(&root, &RUN).expect_err(name);
            let message = validation(&err);
            assert!(message.contains(&format!("\u{201c}in/{shown}\u{201d}")), "{message}");
            assert!(message.contains(reason), "{message}");
            assert!(message.contains("Rename"), "{message}");
        }
    }

    /// A folder whose own name is invalid is named itself, not one of the
    /// files inside it, and the walk does not descend into it.
    #[test]
    fn an_invalid_folder_name_names_the_folder() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("Share");
        std::fs::create_dir_all(root.join("a\\b")).expect("dir");
        std::fs::write(root.join("a\\b/inner.txt"), b"x").expect("file");

        let err = scan_folder(&root, &RUN).expect_err("backslash folder");
        assert!(validation(&err).contains("\u{201c}a\\b\u{201d}"), "{err:?}");
    }

    /// 64 levels is the most a path may have: an empty folder 64 levels
    /// down is fine, a file inside it is one level too deep.
    #[test]
    fn refuses_an_item_deeper_than_the_path_limit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("Deep");
        let segments = vec!["d"; path_validator::MAX_DEPTH];
        let deepest = root.join(segments.join("/"));
        std::fs::create_dir_all(&deepest).expect("64 levels");
        std::fs::write(root.join("top.txt"), b"x").expect("a file");
        assert!(scan_folder(&root, &RUN).is_ok(), "an empty folder 64 levels down");

        std::fs::write(deepest.join("f.txt"), b"x").expect("65th level");
        let err = scan_folder(&root, &RUN).expect_err("65 levels");
        let message = validation(&err);
        assert!(message.contains("/d/f.txt\u{201d}"), "{message}");
        assert!(message.contains("64 folders deep"), "{message}");
    }

    /// macOS can hand back decomposed names; the validator only accepts
    /// NFC, so the scan validates the normalized form but sends the name
    /// spelled exactly as read, which the client requires.
    #[test]
    fn a_decomposed_name_passes_and_keeps_its_spelling() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("Share");
        let decomposed = "cafe\u{301}";
        std::fs::create_dir_all(root.join(decomposed).join("empty")).expect("dirs");
        std::fs::write(root.join(decomposed).join("menu.txt"), b"x").expect("file");
        let on_disk = std::fs::read_dir(&root)
            .expect("list")
            .map(|e| e.expect("entry").file_name().into_string().expect("utf-8"))
            .next()
            .expect("one child");

        let scan = scan_folder(&root, &RUN).expect("a decomposed name is valid once normalized");
        assert_eq!(paths(&scan), vec![format!("d:{on_disk}/empty"), format!("f:{on_disk}/menu.txt")]);
    }

    /// An unreadable subfolder fails the share and is named, rather than
    /// being silently left out of the link.
    #[cfg(unix)]
    #[test]
    fn an_unreadable_subfolder_fails_and_is_named() {
        use std::os::unix::fs::PermissionsExt;

        let (_dir, root) = tree();
        let locked = root.join("sub");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).expect("chmod");
        // Root ignores permissions; the case is unobservable there.
        let readable_anyway = std::fs::read_dir(&locked).is_ok();
        let result = scan_folder(&root, &RUN);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).expect("restore");
        if readable_anyway {
            return;
        }

        let err = result.expect_err("unreadable subfolder");
        let message = validation(&err);
        assert!(message.contains("\u{201c}sub\u{201d}"), "{message}");
        assert!(!message.contains("os error"), "no raw OS text in the dialog: {message}");
    }

    /// A folder that can be listed but not entered (read without search
    /// permission) lists its names but cannot stat them. Its children must
    /// fail the share by name, not vanish and leave the folder looking empty.
    #[cfg(unix)]
    #[test]
    fn a_child_that_cannot_be_examined_fails_and_is_named() {
        use std::os::unix::fs::PermissionsExt;

        let (_dir, root) = tree();
        let locked = root.join("sub");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o400)).expect("chmod");
        // Root ignores permissions; the case is unobservable there.
        let examinable_anyway = std::fs::symlink_metadata(locked.join("deeper")).is_ok();
        let result = scan_folder(&root, &RUN);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).expect("restore");
        if examinable_anyway {
            return;
        }

        let err = result.expect_err("a child that cannot be examined");
        let message = validation(&err);
        assert!(message.contains("\u{201c}sub/deeper\u{201d}"), "{message}");
        assert!(!message.contains("os error"), "no raw OS text in the dialog: {message}");
    }

    /// A name that is not valid UTF-8 has no spelling on the wire. It is
    /// refused by name (shown lossily) rather than silently left out. APFS
    /// cannot store such a name, so this only runs where the volume can.
    #[cfg(unix)]
    #[test]
    fn a_name_that_is_not_text_fails_and_is_named() {
        use std::os::unix::ffi::OsStrExt;

        let (_dir, root) = tree();
        let odd = std::ffi::OsStr::from_bytes(b"bad\xffname.txt");
        if std::fs::write(root.join(odd), b"x").is_err() {
            return;
        }

        let err = scan_folder(&root, &RUN).expect_err("non-UTF-8 name");
        let message = validation(&err);
        assert!(message.contains("\u{201c}bad\u{fffd}name.txt\u{201d}"), "{message}");
        assert!(message.contains("Rename"), "{message}");
    }

    /// The refusal for a non-UTF-8 name, checked where the volume cannot
    /// create one (macOS): it names the item and says what to do.
    #[test]
    fn a_name_that_is_not_text_reads_as_a_sentence() {
        let err = not_text("sub/bad\u{fffd}name.txt");
        let message = validation(&err);
        assert!(message.contains("\u{201c}sub/bad\u{fffd}name.txt\u{201d}"), "{message}");
        assert!(message.contains("Rename"), "{message}");
    }

    /// Limits are quoted the way a reader writes them.
    #[test]
    fn limits_are_quoted_with_thousands_separators() {
        assert_eq!(grouped(1), "1");
        assert_eq!(grouped(999), "999");
        assert_eq!(grouped(50_000), "50,000");
        assert_eq!(grouped(1_000_000), "1,000,000");
    }

    /// Reasons a real folder cannot reach on a test volume (a 255-byte name
    /// limit, a 1,024-byte path limit) still read as sentences, never as the
    /// validator's engineer-facing text.
    #[test]
    fn length_refusals_read_as_sentences() {
        let name = invalid_name("x/long", &PathValidationError::SegmentTooLong(300));
        assert!(validation(&name).contains("name is too long"), "{name:?}");
        let path = invalid_name("x/long", &PathValidationError::TooLong(2_000));
        assert!(validation(&path).contains("too long"), "{path:?}");
        for err in [&name, &path] {
            assert!(!validation(err).contains("relative_path"), "{err:?}");
        }
    }
}
