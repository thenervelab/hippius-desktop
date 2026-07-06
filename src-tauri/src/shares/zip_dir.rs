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
    let mut stack: Vec<(PathBuf, String)> = vec![(src_dir.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        // Sort each directory's entries by name so the archive byte layout is
        // deterministic for a given tree (read_dir order is OS-dependent).
        let mut entries: Vec<fs::DirEntry> = fs::read_dir(&dir)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(std::fs::DirEntry::file_name);

        for entry in entries {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                // Non-UTF-8 name: zip entry names are strings, so skip it. Mirrors
                // `finder_bridge::resolve::clean_relative`'s non-UTF-8 posture.
                continue;
            };
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
