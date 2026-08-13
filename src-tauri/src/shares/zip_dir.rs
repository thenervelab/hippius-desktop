//! Recursively pack a directory into a single `.zip` archive.
//!
//! The share engine ([`hcfs_client::client::share::create_share`]) shares one
//! byte stream with one filename — it has no folder concept. So a folder the
//! user right-clicks in Finder is collapsed into one `application/zip` blob and
//! shared like any other file. This module is that collapse step.
//!
//! Gated to macOS because the macOS Finder folder-share is its only consumer;
//! leaving it un-gated would make the whole module dead code on the Linux CI
//! job (the dispatcher that calls it is itself `#[cfg(target_os = "macos")]`).
//! The macOS CI job compiles and runs the tests below.

use std::fs;
use std::io::{Seek, Write};
use std::path::{Path, PathBuf};

use tempfile::NamedTempFile;
use zip::CompressionMethod;
use zip::write::{SimpleFileOptions, ZipWriter};

use crate::error::Result;

/// Pack every regular file under `src_dir` into a fresh temporary `.zip`,
/// returning the open [`NamedTempFile`].
///
/// The caller MUST keep the returned handle alive until the archive has been
/// read (e.g. streamed to the share engine): `NamedTempFile`'s `Drop` unlinks
/// the file, so dropping it early would delete the archive mid-upload.
pub(crate) fn zip_directory_to_temp(src_dir: &Path) -> Result<NamedTempFile> {
    // A named temp file (not an anonymous one) because the async share path
    // re-opens it by path on the tokio runtime rather than reusing this handle.
    let temp = tempfile::Builder::new().prefix("hippius-share-").suffix(".zip").tempfile()?;
    // Write through the file handle; the returned writer is the same `&File`,
    // discarded — `finish()` has already flushed the central directory to disk.
    zip_dir_into(src_dir, temp.as_file())?;
    Ok(temp)
}

/// Largest folder, in plaintext bytes, that may be shared as one zip.
///
/// The archive is built into a temp file before the upload starts, so an
/// unbounded walk fills the temp disk and begins a transfer the user can only
/// escape by quitting. The credit eligibility gate is a positive-balance floor,
/// not a byte budget, so nothing else bounds this.
///
/// Decimal GB, not GiB, so this renders as a round "2.0 GB" under the same SI
/// rule the frontend's `formatBytes` uses — the cap is shown to users in two
/// places (the modal's preflight line and this module's refusal message) and
/// they must not disagree by 7%.
pub(crate) const MAX_FOLDER_SHARE_BYTES: u64 = 2_000_000_000;

/// Largest entry count, for the same reason expressed in files rather than
/// bytes: a quarter-million tiny files is a slow walk and a zip central
/// directory nothing downstream wants to page through.
pub(crate) const MAX_FOLDER_SHARE_ENTRIES: u64 = 10_000;

/// Refuse a folder share that would exceed either limit, naming the actual
/// value so the user can act on it instead of guessing what "too large" means.
pub(crate) fn enforce_folder_share_limits(measured: DirMeasurement) -> Result<()> {
    if measured.total_bytes > MAX_FOLDER_SHARE_BYTES {
        return Err(crate::error::AppError::Validation(format!(
            "This folder is {} and can't be shared as a link (limit {}). Share a smaller folder, or share files individually.",
            format_size(measured.total_bytes),
            format_size(MAX_FOLDER_SHARE_BYTES),
        )));
    }

    if measured.file_count > MAX_FOLDER_SHARE_ENTRIES {
        return Err(crate::error::AppError::Validation(format!(
            "This folder has {} files and can't be shared as a link (limit {}). Share a smaller folder, or share files individually.",
            format_count(measured.file_count),
            format_count(MAX_FOLDER_SHARE_ENTRIES),
        )));
    }

    Ok(())
}

/// Render a count with thousands separators for a user-facing message.
///
/// Exists so the entry-limit message interpolates the CONSTANT rather than a
/// literal: a hardcoded "10,000" would keep telling users the old limit after
/// `MAX_FOLDER_SHARE_ENTRIES` is tuned, and a test asserting that literal would
/// stay green through exactly that edit.
fn format_count(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);

    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }

    out
}

/// Render a byte count for a user-facing message.
///
/// Local rather than `billing::charts::format_bytes`, which is `pub(super)` to
/// its own module — widening a billing helper's visibility for one share
/// message would couple the two domains for no gain.
fn format_size(bytes: u64) -> String {
    // SI units (1000-based) to match the frontend's `formatBytes`, so the same
    // byte count never renders two different ways across the feature.
    const KB: u64 = 1000;
    const MB: u64 = KB * 1000;
    const GB: u64 = MB * 1000;

    match bytes {
        b if b >= GB => format!("{:.1} GB", b as f64 / GB as f64),
        b if b >= MB => format!("{:.1} MB", b as f64 / MB as f64),
        b if b >= KB => format!("{:.1} KB", b as f64 / KB as f64),
        b => format!("{b} bytes"),
    }
}

/// Delete stale `hippius-share-*.zip` archives left in the temp directory.
///
/// `NamedTempFile` unlinks on `Drop`, which covers the normal and error paths —
/// but not a crash, a SIGKILL, or a force-quit during a long upload. What is
/// left behind is the PLAINTEXT concatenation of a shared folder, up to the
/// size cap. Best-effort and non-fatal: called once at startup, and a failure to
/// read the temp dir or unlink a file just leaves the residue for next time.
///
/// Only files matching this module's own prefix and suffix are touched, so a
/// shared `/tmp` on Linux cannot lead us to delete another process's file.
pub fn sweep_stale_share_archives() {
    let Ok(entries) = fs::read_dir(std::env::temp_dir()) else {
        return;
    };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        // ASCII-case-insensitive on the extension: the tempfile crate writes
        // ".zip", but a case-preserving-but-insensitive filesystem can hand it
        // back differently, and a missed match only means stale residue stays.
        if !name.starts_with("hippius-share-") || !std::path::Path::new(name).extension().is_some_and(|e| e.eq_ignore_ascii_case("zip")) {
            continue;
        }

        if let Err(e) = fs::remove_file(entry.path()) {
            tracing::debug!(error = %e, file = name, "could not remove a stale share archive");
        }
    }
}

/// Whether the walk must leave this entry out of the archive.
///
/// Hidden entries are skipped to match the SYNC ENGINE, not merely for tidiness:
/// `sync::files::add`'s upload scan mirrors hcfs-client's
/// `drive::exclude::should_skip_path` and never uploads a dotfile, and the file
/// browser never lists one. So a hidden file inside a synced folder has never
/// been shown to the user in this app and has never left their machine.
/// Packing it into a share would publish `.env`, `.git/config` (which routinely
/// carries a credentialed remote), or `.ssh` behind a link the user believes
/// contains only what they can see. Skipping a hidden DIRECTORY drops its whole
/// subtree, matching the engine walk.
///
/// Non-UTF-8 names are skipped because zip entry names are strings — and
/// deliberately BEFORE the hidden check, mirroring the engine's `to_str()`
/// gating so the two agree entry for entry.
fn is_skipped_entry(name: Option<&str>) -> bool {
    match name {
        None => true,
        // A backslash is a legal filename byte on Unix but a PATH SEPARATOR to
        // some Windows zip extractors, which is the classic backslash zip-slip:
        // an entry named `..\..\evil.exe` can be written outside the
        // recipient's extraction directory. We control what goes into the
        // archive, so the cheap fix is to not put such a name in it.
        Some(name) => name.starts_with('.') || name.contains('\\'),
    }
}

/// Plaintext size and file count of what [`zip_dir_into`] would pack.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DirMeasurement {
    pub total_bytes: u64,
    pub file_count: u64,
}

/// Measure `src_dir` using the SAME walk rules as [`zip_dir_into`]: symlinks and
/// non-UTF-8 names skipped, dotfiles included.
///
/// Deliberately NOT `sync::fileops::files::dir_stats::dir_stats_recursive`,
/// which answers a different question — it skips dotfiles and resolves symlinks
/// through `metadata()`. Reusing it would let the share preflight report a size
/// the cap then disagrees with, so the UI would call a folder shareable and the
/// mint would refuse it.
///
/// Synchronous like the packer; both callers already run it on a blocking
/// thread.
pub(crate) fn measure_directory(src_dir: &Path) -> Result<DirMeasurement> {
    let mut total_bytes: u64 = 0;
    let mut file_count: u64 = 0;

    let mut stack: Vec<PathBuf> = vec![src_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            if is_skipped_entry(entry.file_name().to_str()) {
                continue;
            }

            // `file_type` does not traverse symlinks, so a link matches neither
            // arm and is left out — mirroring the packer exactly.
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                stack.push(entry.path());
            } else if file_type.is_file() {
                total_bytes = total_bytes.saturating_add(entry.metadata()?.len());
                file_count += 1;

                // Stop as soon as the answer is decided. Past the cap the exact
                // total changes nothing — the share is refused either way — and
                // walking on turns a hostile or merely enormous tree into an
                // unbounded blocking-pool cost that any caller can trigger. The
                // returned totals are therefore a LOWER BOUND once
                // `within_limits` is false; the modal words them as "more than".
                if total_bytes > MAX_FOLDER_SHARE_BYTES || file_count > MAX_FOLDER_SHARE_ENTRIES {
                    return Ok(DirMeasurement { total_bytes, file_count });
                }
            }
        }
    }

    Ok(DirMeasurement { total_bytes, file_count })
}

/// Write a deflate-compressed zip of `src_dir`'s contents into `writer`,
/// returning the finished writer (so an in-memory `Cursor` caller can recover
/// its bytes).
///
/// Two entries are deliberately skipped, each documented at its match arm:
/// symlinks (a link could point outside the tree, and a cycle would loop the
/// walk) and non-UTF-8 file names (zip entry names are strings). Empty
/// directories are not recorded — only files carry into the archive, and zip
/// readers reconstruct the directory structure from each file's `/`-joined
/// name.
fn zip_dir_into<W: Write + Seek>(src_dir: &Path, writer: W) -> Result<W> {
    let mut zip = ZipWriter::new(writer);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    // Explicit DFS stack of (absolute directory, its `/`-joined archive prefix)
    // rather than recursion, so deep trees can't overflow the call stack. Each
    // element owns its `PathBuf`/`String`, so nothing borrows across iterations.
    // Running totals so the cap is a real boundary rather than an advisory
    // pre-check. `measure_directory` runs first and refuses an oversized tree
    // up front, but the two are separate walks: anything written into the folder
    // in between — a concurrent download by the sync engine, a user drag —
    // would otherwise be packed uncounted, and the doc's promise that the temp
    // disk cannot be filled would not hold.
    let mut packed = DirMeasurement { total_bytes: 0, file_count: 0 };

    let mut stack: Vec<(PathBuf, String)> = vec![(src_dir.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        // Sort each directory's entries by name so the archive byte layout is
        // deterministic for a given tree (read_dir order is OS-dependent).
        let mut entries: Vec<fs::DirEntry> = fs::read_dir(&dir)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(std::fs::DirEntry::file_name);

        for entry in entries {
            let name_str = entry.file_name().to_str().map(str::to_owned);
            if is_skipped_entry(name_str.as_deref()) {
                // Non-UTF-8 (zip entry names are strings) or hidden (never
                // uploaded by the engine, never shown in the app). See
                // `is_skipped_entry`.
                continue;
            }
            let Some(name) = name_str else { continue };
            let archive_name = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            // `DirEntry::file_type` does NOT traverse symlinks (std: "will not
            // traverse symlinks if this entry points at a symlink"), so a symlink
            // reports neither `is_dir` nor `is_file` and falls through both arms —
            // it is left out of the archive. That is intentional: the target could
            // be outside the zipped tree (a data-exfil escape) and a cycle would
            // loop the walk forever. Pinned by `symlinks_are_skipped`.
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                stack.push((entry.path(), archive_name));
            } else if file_type.is_file() {
                packed.file_count += 1;
                packed.total_bytes = packed.total_bytes.saturating_add(entry.metadata()?.len());
                enforce_folder_share_limits(packed)?;

                zip.start_file(&archive_name, options)?;
                let mut file = fs::File::open(entry.path())?;
                std::io::copy(&mut file, &mut zip)?;
            }
        }
    }

    Ok(zip.finish()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read};
    use tempfile::TempDir;
    use zip::ZipArchive;

    /// Zip a tempdir tree into memory and read it back as `(name → bytes)` for
    /// files (directories are not emitted, so they never appear).
    fn zip_then_read(src: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
        let cursor = zip_dir_into(src, Cursor::new(Vec::new())).expect("zip");
        let mut archive = ZipArchive::new(Cursor::new(cursor.into_inner())).expect("read archive");
        let mut out = std::collections::BTreeMap::new();
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).expect("entry");
            if entry.is_file() {
                let name = entry.name().to_owned();
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).expect("read entry");
                out.insert(name, bytes);
            }
        }
        out
    }

    #[test]
    fn nested_tree_round_trips_with_slash_joined_names() {
        let dir = TempDir::new().expect("tempdir");
        fs::write(dir.path().join("a.txt"), b"alpha").expect("write a");
        fs::create_dir_all(dir.path().join("sub/deep")).expect("mkdir");
        fs::write(dir.path().join("sub/b.txt"), b"bravo").expect("write b");
        fs::write(dir.path().join("sub/deep/c.txt"), b"charlie").expect("write c");

        let got = zip_then_read(dir.path());

        let names: Vec<&String> = got.keys().collect();
        assert_eq!(names, vec!["a.txt", "sub/b.txt", "sub/deep/c.txt"], "entry names use '/' and cover the tree");
        assert_eq!(got["sub/deep/c.txt"], b"charlie");
    }

    /// zip-crate edge (axiom 110): an empty input directory must still produce
    /// a valid, zero-entry archive — `finish()` writes the central directory
    /// even with no files.
    #[test]
    fn empty_directory_produces_zero_entry_archive() {
        let dir = TempDir::new().expect("tempdir");
        let cursor = zip_dir_into(dir.path(), Cursor::new(Vec::new())).expect("zip");
        let archive = ZipArchive::new(Cursor::new(cursor.into_inner())).expect("read archive");
        assert_eq!(archive.len(), 0);
    }

    /// zip-crate edge (axiom 110): a zero-byte file is a real entry with empty
    /// content, not a dropped/dir entry.
    #[test]
    fn zero_byte_file_is_a_present_empty_entry() {
        let dir = TempDir::new().expect("tempdir");
        fs::write(dir.path().join("empty.bin"), b"").expect("write");

        let got = zip_then_read(dir.path());

        assert_eq!(got.len(), 1);
        assert_eq!(got["empty.bin"], Vec::<u8>::new());
    }

    /// A symlink must be skipped: its target could be outside the zipped tree
    /// (a data-exfil escape) and a self-referential link would loop the walk.
    #[cfg(unix)]
    #[test]
    fn symlinks_are_skipped() {
        let dir = TempDir::new().expect("tempdir");
        fs::write(dir.path().join("real.txt"), b"real").expect("write");
        std::os::unix::fs::symlink(dir.path().join("real.txt"), dir.path().join("link.txt")).expect("symlink");

        let got = zip_then_read(dir.path());

        assert_eq!(got.keys().collect::<Vec<_>>(), vec!["real.txt"], "the symlink must not be archived");
    }

    #[test]
    fn measure_counts_nested_files_and_bytes() {
        let dir = TempDir::new().expect("tempdir");
        fs::write(dir.path().join("a.txt"), b"12345").expect("write a");
        fs::create_dir(dir.path().join("sub")).expect("mkdir");
        fs::write(dir.path().join("sub/b.txt"), b"123").expect("write b");

        let measured = measure_directory(dir.path()).expect("measure");

        assert_eq!(measured.file_count, 2);
        assert_eq!(measured.total_bytes, 8);
    }

    /// A hidden file is never uploaded by the sync engine and never listed in
    /// the app, so publishing it in a share link would hand out data the user
    /// has never seen in Hippius. Both walks must leave it out, and must agree.
    #[test]
    fn dotfiles_are_excluded_from_the_archive_and_the_measurement() {
        let dir = TempDir::new().expect("tempdir");
        fs::write(dir.path().join(".env"), b"secret=1").expect("write dotfile");
        fs::write(dir.path().join("visible.txt"), b"ok").expect("write visible");

        let measured = measure_directory(dir.path()).expect("measure");
        let archived = zip_then_read(dir.path());

        assert_eq!(measured.file_count, 1, "only the visible file counts");
        assert_eq!(measured.total_bytes, 2);
        assert_eq!(archived.keys().collect::<Vec<_>>(), vec!["visible.txt"], ".env must not be published");
    }

    /// A hidden DIRECTORY takes its whole subtree with it — `.git/config` is the
    /// realistic payload, and it routinely carries a credentialed remote URL.
    #[test]
    fn a_hidden_directory_excludes_its_whole_subtree() {
        let dir = TempDir::new().expect("tempdir");
        fs::create_dir(dir.path().join(".git")).expect("mkdir");
        fs::write(dir.path().join(".git/config"), b"url = https://user:token@host").expect("write");
        fs::write(dir.path().join("README.md"), b"hi").expect("write");

        let measured = measure_directory(dir.path()).expect("measure");
        let archived = zip_then_read(dir.path());

        assert_eq!(measured.file_count, 1);
        assert_eq!(archived.keys().collect::<Vec<_>>(), vec!["README.md"], ".git contents must not be published");
    }

    /// The mirror of `symlinks_are_skipped`: what the packer leaves out must not
    /// be counted, or a link to a huge file would inflate the measurement.
    #[cfg(unix)]
    #[test]
    fn measure_skips_symlinks_because_the_archive_does() {
        let dir = TempDir::new().expect("tempdir");
        fs::write(dir.path().join("real.txt"), b"1234").expect("write real");
        std::os::unix::fs::symlink(dir.path().join("real.txt"), dir.path().join("link.txt")).expect("symlink");

        let measured = measure_directory(dir.path()).expect("measure");

        assert_eq!(measured.file_count, 1, "symlinks are skipped by zip_dir_into");
        assert_eq!(measured.total_bytes, 4);
    }

    /// The invariant that matters, asserted against the packer itself rather
    /// than against a second hand-maintained number that could drift from it.
    #[test]
    fn measure_agrees_with_the_archive_entry_count() {
        let dir = TempDir::new().expect("tempdir");
        // Includes a hidden entry on purpose: the invariant is that the two
        // walks agree, whatever the rule is, so the fixture must exercise it.
        fs::write(dir.path().join(".hidden"), b"a").expect("write hidden");
        fs::write(dir.path().join("plain.txt"), b"bb").expect("write plain");
        fs::create_dir(dir.path().join("nested")).expect("mkdir");
        fs::write(dir.path().join("nested/deep.bin"), b"ccc").expect("write deep");

        let measured = measure_directory(dir.path()).expect("measure");
        let archived = zip_then_read(dir.path());

        assert_eq!(measured.file_count as usize, archived.len());
        assert_eq!(measured.total_bytes, archived.values().map(|b| b.len() as u64).sum::<u64>());
    }

    #[test]
    fn limits_accept_a_folder_at_the_boundary() {
        let at_limit = DirMeasurement {
            total_bytes: MAX_FOLDER_SHARE_BYTES,
            file_count: MAX_FOLDER_SHARE_ENTRIES,
        };

        assert!(enforce_folder_share_limits(at_limit).is_ok(), "the limit itself is allowed");
    }

    #[test]
    fn limits_reject_an_oversized_folder_and_name_the_numbers() {
        let too_big = DirMeasurement {
            total_bytes: MAX_FOLDER_SHARE_BYTES + 1,
            file_count: 1,
        };

        let message = enforce_folder_share_limits(too_big).expect_err("must refuse").to_string();

        assert!(message.contains("2.0 GB"), "the message must state the limit, got: {message}");
    }

    #[test]
    fn limits_reject_too_many_entries() {
        let too_many = DirMeasurement {
            total_bytes: 1,
            file_count: MAX_FOLDER_SHARE_ENTRIES + 1,
        };

        let message = enforce_folder_share_limits(too_many).expect_err("must refuse").to_string();

        // Assert the CONSTANT is interpolated, not a literal — otherwise tuning
        // the cap leaves users being told the old number and this test green.
        assert!(
            message.contains(&format_count(MAX_FOLDER_SHARE_ENTRIES)),
            "the message must state the entry limit, got: {message}"
        );
    }

    #[test]
    fn the_sweep_removes_only_this_modules_own_archives() {
        // Uses the real temp dir (as production does) but with names unique to
        // this test, so a parallel test's archive is never a false positive.
        let temp = std::env::temp_dir();
        let ours = temp.join("hippius-share-sweeptest.zip");
        let theirs = temp.join("someone-elses-sweeptest.zip");
        fs::write(&ours, b"stale").expect("write ours");
        fs::write(&theirs, b"keep").expect("write theirs");

        sweep_stale_share_archives();

        assert!(!ours.exists(), "a stale hippius share archive must be removed");
        assert!(theirs.exists(), "an unrelated temp file must be left alone");
        let _ = fs::remove_file(&theirs);
    }

    /// A backslash in a filename is a path separator to some Windows
    /// extractors, so it must never reach the archive.
    #[cfg(unix)]
    #[test]
    fn a_backslash_filename_is_not_archived() {
        let dir = TempDir::new().expect("tempdir");
        fs::write(dir.path().join(r"..\..\evil.exe"), b"x").expect("write");
        fs::write(dir.path().join("safe.txt"), b"ok").expect("write");

        let archived = zip_then_read(dir.path());

        assert_eq!(archived.keys().collect::<Vec<_>>(), vec!["safe.txt"], "a backslash name must be skipped");
    }

    /// The pack must abort on its own totals, not trust the earlier measurement:
    /// the two are separate walks and the tree can grow in between.
    #[test]
    fn the_packer_refuses_a_tree_that_exceeds_the_entry_cap_mid_walk() {
        let dir = TempDir::new().expect("tempdir");
        for i in 0..=MAX_FOLDER_SHARE_ENTRIES {
            fs::write(dir.path().join(format!("f{i}.txt")), b"x").expect("write");
        }

        let err = zip_dir_into(dir.path(), Cursor::new(Vec::new())).expect_err("must refuse");

        assert!(err.to_string().contains("can't be shared"), "got: {err}");
    }

    /// A tree past the cap must stop the walk rather than count every entry:
    /// the verdict is already decided, and continuing is an unbounded cost a
    /// caller could trigger repeatedly.
    #[test]
    fn measuring_stops_once_the_cap_is_exceeded() {
        let dir = TempDir::new().expect("tempdir");
        // Comfortably past the entry cap so the exit must fire mid-walk.
        for i in 0..(MAX_FOLDER_SHARE_ENTRIES + 500) {
            fs::write(dir.path().join(format!("f{i}.txt")), b"x").expect("write");
        }

        let measured = measure_directory(dir.path()).expect("measure");

        assert!(measured.file_count <= MAX_FOLDER_SHARE_ENTRIES + 1, "the walk must stop at the cap, counted {}", measured.file_count);
        assert!(enforce_folder_share_limits(measured).is_err(), "the partial count must still refuse the share");
    }

    #[test]
    fn counts_render_with_thousands_separators() {
        assert_eq!(format_count(0), "0");
        assert_eq!(format_count(999), "999");
        assert_eq!(format_count(1_000), "1,000");
        assert_eq!(format_count(10_000), "10,000");
        assert_eq!(format_count(1_234_567), "1,234,567");
    }

    #[test]
    fn byte_sizes_render_in_the_largest_fitting_unit() {
        assert_eq!(format_size(512), "512 bytes");
        assert_eq!(format_size(2000), "2.0 KB");
        assert_eq!(format_size(3_000_000), "3.0 MB");
        assert_eq!(format_size(2_000_000_000), "2.0 GB");
    }

    proptest::proptest! {
        /// Round-trip: a set of top-level files written to disk survives
        /// zip-then-unzip with identical name→bytes mapping. The `BTreeMap`
        /// input dedups generated names, so each name maps to exactly one file.
        ///
        /// Names are LOWERCASE-only (`[a-z0-9_]`): this module is macOS-gated and
        /// runs on case-insensitive APFS, where `"ab"` and `"aB"` are the SAME
        /// on-disk file — so a mixed-case alphabet would generate two distinct
        /// map keys that collapse to one file, breaking the "N keys → N files"
        /// precondition (caught by the shrinker as `_EL`/`_El`). Restricting to a
        /// case-distinct alphabet keeps the precondition true on any filesystem.
        #[test]
        fn flat_files_round_trip(
            files in proptest::collection::btree_map(
                "[a-z0-9_]{1,8}",
                proptest::collection::vec(proptest::num::u8::ANY, 0..48),
                0..8,
            )
        ) {
            let dir = TempDir::new().expect("tempdir");
            for (name, bytes) in &files {
                fs::write(dir.path().join(name), bytes).expect("write");
            }
            let got = zip_then_read(dir.path());
            proptest::prop_assert_eq!(got, files);
        }
    }
}
