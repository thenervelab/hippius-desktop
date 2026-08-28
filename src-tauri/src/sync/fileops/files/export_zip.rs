//! Store-only zip export of a folder inside a registered sync drive.
//!
//! "Download Folder" in the Files UI used to recursively copy a directory
//! tree via [`super::resolve::export_file`]. Product wants a single `.zip`
//! (same shape as the deleted share-time `zip_dir.rs` and the console
//! recipient download-all), not a loose tree. This command is that pack
//! step: walk the on-disk folder, write `CompressionMethod::Stored`
//! entries, skip Unix symlinks so a link cannot pull bytes from outside
//! the tree, and fail-closed on Windows junctions that escape the folder.
//!
//! Security gates match [`super::resolve::export_file`]: the `sync_path`
//! must be a `sync_paths` row for the active account, and
//! `relative_folder` must stay inside that root (`ensure_within` plus a
//! Normal-components-only check that rejects `..` before canonicalize).
//! The zip is written to a unique sibling `.part` and renamed onto the
//! user dest only after `finish`, so a pack error never truncates a
//! pre-existing file.

use super::pathops::ensure_within;
use super::resolve::require_registered_sync_path;
use crate::auth::account_key::account_key;
use crate::error::{AppError, Result};
use std::collections::HashSet;
use std::ffi::OsStr;
use std::io::{Seek, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tracing::info;
use zip::CompressionMethod;
use zip::write::{SimpleFileOptions, ZipWriter};

/// Pack `relative_folder` under a registered `sync_path` into `output_zip_path`.
///
/// The walk and zip write run on `spawn_blocking` so a large tree cannot
/// stall the Tokio runtime. Bytes land on a sibling `.part`; a failed
/// pack deletes that temp (best-effort) and leaves the user dest alone.
#[tauri::command]
pub async fn export_folder_zip(
    state: tauri::State<'_, crate::app_state::AppState>,
    sync_path: String,
    relative_folder: String,
    output_zip_path: String,
) -> Result<()> {
    let account_id = state.current_account_id()?;
    let owner = account_key(&account_id);
    export_folder_zip_inner(state.pool()?, &owner, sync_path, relative_folder, output_zip_path).await
}

/// Testable funnel: registered-path gate, then blocking pack.
async fn export_folder_zip_inner(
    pool: &sqlx::SqlitePool,
    owner: &str,
    sync_path: String,
    relative_folder: String,
    output_zip_path: String,
) -> Result<()> {
    require_registered_sync_path(pool, owner, &sync_path).await?;

    info!(relative_folder = %relative_folder, "Exporting synced folder as zip");

    tokio::task::spawn_blocking(move || {
        let source = resolve_folder_for_export(&sync_path, &relative_folder)?;
        zip_folder_store_only(&source, Path::new(&output_zip_path))
    })
    .await
    .map_err(|e| AppError::Other(format!("folder zip task failed to join: {e}")))?
}

/// Refuse a relative folder that is empty or that names anything other than
/// a clean drive-relative path (no `..`, `.`, prefixes, or NUL).
fn validate_relative_folder(relative_folder: &str) -> Result<&str> {
    let relative = relative_folder.trim_matches('/');
    if relative.is_empty() {
        return Err(AppError::Validation("relative_folder cannot be empty".into()));
    }
    if relative.contains('\0') || relative.contains('\\') {
        return Err(AppError::Validation("relative_folder contains an illegal character".into()));
    }
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(_) => {}
            _ => {
                return Err(AppError::Validation("relative_folder contains an illegal component".into()));
            }
        }
    }
    Ok(relative)
}

/// Resolve `relative_folder` to an on-disk directory inside `sync_path`.
///
/// `..` is rejected by [`validate_relative_folder`] before canonicalize, so
/// a relative path cannot walk out even when the resulting realpath would
/// still sit under the sync root (`a/../b`).
fn resolve_folder_for_export(sync_path: &str, relative_folder: &str) -> Result<PathBuf> {
    let relative = validate_relative_folder(relative_folder)?;
    let parent = Path::new(sync_path);
    let source = parent.join(relative);
    let source = ensure_within(parent, &source)?;
    if !source.is_dir() {
        return Err(AppError::Validation("relative_folder is not a directory".into()));
    }
    Ok(source)
}

/// Whether the walk must leave this entry out of the archive.
///
/// Same skip set as the deleted `shares/zip_dir.rs`: non-UTF-8 names (zip
/// entry names are strings), names containing `\\` (a Unix filename that
/// some Windows extractors treat as a separator — zip-slip), and hidden
/// entries (the file browser and sync engine never surface dotfiles, so
/// packing `.env` / `.hippius` would export data the user has not seen
/// in this app). A hidden directory drops its whole subtree.
fn is_skipped_entry(name: Option<&str>) -> bool {
    match name {
        None => true,
        Some(name) => name.starts_with('.') || name.contains('\\'),
    }
}

fn stored_options() -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        // Per-file ZIP64. Default `large_file: false` aborts a single
        // entry past 4 GiB with an opaque Io ("Large file option has not
        // been set"). Archive-level ZIP64 at `finish` is already automatic.
        .large_file(true)
}

/// Unique sibling of `output_zip` so two concurrent packs cannot share a
/// `.part` (same pattern as `cache_remote_file`).
fn unique_part_path(output_zip: &Path) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let mut name = output_zip.file_name().unwrap_or_else(|| OsStr::new("folder.zip")).to_os_string();
    name.push(format!(".{}.{n}.part", std::process::id()));
    output_zip.with_file_name(name)
}

/// Replace `dest` with the finished `part`.
///
/// Unix `rename` overwrites atomically. Windows cannot rename onto an
/// existing file, so dest is removed first — this is the *success* path
/// after the archive is fully written, never the error cleanup that must
/// leave dest byte-identical.
fn promote_part(part: &Path, dest: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    if dest.exists() {
        std::fs::remove_file(dest)?;
    }
    std::fs::rename(part, dest)
}

/// Write a store-only zip of `src_dir`'s contents to `output_zip`.
///
/// Entry names are relative to `src_dir` (the downloaded folder root), not
/// wrapped in an extra top-level folder. Empty directories are recorded as
/// zip directory entries so they survive a round-trip. The archive is
/// finished to a sibling `.part` and renamed onto `output_zip` only on
/// success; a pre-existing dest is never deleted on error. An output
/// whose canonical path sits under `src_dir` is refused so the walk
/// cannot archive the growing zip.
fn zip_folder_store_only(src_dir: &Path, output_zip: &Path) -> Result<()> {
    hcfs_client::drive::files::ensure_not_nested(src_dir, output_zip).map_err(|e| {
        if e.kind() == std::io::ErrorKind::InvalidInput {
            AppError::Validation("cannot save the zip inside the folder being packed".into())
        } else {
            AppError::Io(e)
        }
    })?;

    let part = unique_part_path(output_zip);
    let written = write_store_only_zip(src_dir, &part).and_then(|()| promote_part(&part, output_zip).map_err(AppError::from));
    if written.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    written
}

fn write_store_only_zip(src_dir: &Path, output_zip: &Path) -> Result<()> {
    let file = std::fs::File::create(output_zip)?;
    let mut zip = ZipWriter::new(file);
    let options = stored_options();
    pack_tree_into_zip(src_dir, &mut zip, options)?;
    zip.finish()?;
    Ok(())
}

struct PackWalk<'a, W: Write + Seek> {
    src_dir: &'a Path,
    zip: &'a mut ZipWriter<W>,
    options: SimpleFileOptions,
    stack: Vec<(PathBuf, String)>,
    visited: HashSet<PathBuf>,
}

fn pack_tree_into_zip<W: Write + Seek>(src_dir: &Path, zip: &mut ZipWriter<W>, options: SimpleFileOptions) -> Result<()> {
    let src_canon = src_dir.canonicalize()?;
    let mut walk = PackWalk {
        src_dir,
        zip,
        options,
        stack: vec![(src_dir.to_path_buf(), String::new())],
        visited: HashSet::from([src_canon]),
    };
    while let Some((dir, prefix)) = walk.stack.pop() {
        pack_directory(&dir, &prefix, &mut walk)?;
    }
    Ok(())
}

/// Recurse into `child` only when it is a new canonical path inside `src_dir`.
///
/// Unix `file_type` already skips symlinks (neither dir nor file). Windows
/// NTFS junctions report as directories, so canonicalize + [`ensure_within`]
/// fail closed on an out-of-tree target. The visited set breaks a
/// junction cycle (A→B→A) that would otherwise walk forever.
fn push_directory_if_new(src_dir: &Path, child: &Path, visited: &mut HashSet<PathBuf>) -> Result<bool> {
    let canon = ensure_within(src_dir, child)?;
    Ok(visited.insert(canon))
}

fn pack_directory<W: Write + Seek>(dir: &Path, prefix: &str, walk: &mut PackWalk<'_, W>) -> Result<()> {
    // Explicit DFS rather than recursion so a deep tree cannot overflow
    // the blocking-pool thread's stack. Sort each directory so the
    // archive byte layout is deterministic (read_dir order is OS-dependent).
    let mut entries: Vec<std::fs::DirEntry> = std::fs::read_dir(dir)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);

    for entry in entries {
        let name_os = entry.file_name();
        if is_skipped_entry(name_os.to_str()) {
            continue;
        }
        let Some(name) = name_os.to_str() else { continue };
        let archive_name = if prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{prefix}/{name}")
        };

        // `DirEntry::file_type` does not traverse Unix symlinks, so a
        // link matches neither arm and is left out. Windows junctions
        // report as directories — `push_directory_if_new` contains them.
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            if !push_directory_if_new(walk.src_dir, &entry.path(), &mut walk.visited)? {
                continue;
            }
            walk.zip.add_directory(&archive_name, walk.options)?;
            walk.stack.push((entry.path(), archive_name));
        } else if file_type.is_file() {
            walk.zip.start_file(&archive_name, walk.options)?;
            let mut file = std::fs::File::open(entry.path())?;
            std::io::copy(&mut file, walk.zip)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePool;
    use std::collections::BTreeMap;
    use std::fs;
    use std::io::{Cursor, Read};
    use tempfile::TempDir;
    use zip::ZipArchive;

    const OWNER: &str = "owner-test";

    async fn pool_with_sync_path(path: &str) -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.expect("memory sqlite");
        sqlx::query("CREATE TABLE sync_paths (owner TEXT NOT NULL, path TEXT NOT NULL)")
            .execute(&pool)
            .await
            .expect("create sync_paths");
        sqlx::query("INSERT INTO sync_paths (owner, path) VALUES (?, ?)")
            .bind(OWNER)
            .bind(path)
            .execute(&pool)
            .await
            .expect("insert sync_paths");
        pool
    }

    async fn empty_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.expect("memory sqlite");
        sqlx::query("CREATE TABLE sync_paths (owner TEXT NOT NULL, path TEXT NOT NULL)")
            .execute(&pool)
            .await
            .expect("create sync_paths");
        pool
    }

    fn zip_then_read(src: &Path) -> (BTreeMap<String, Vec<u8>>, Vec<String>, Vec<CompressionMethod>) {
        let dir = TempDir::new().expect("tempdir");
        let zip_path = dir.path().join("out.zip");
        zip_folder_store_only(src, &zip_path).expect("zip");

        let file = fs::File::open(&zip_path).expect("open zip");
        let mut archive = ZipArchive::new(file).expect("read archive");
        let mut files = BTreeMap::new();
        let mut dirs = Vec::new();
        let mut methods = Vec::new();
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).expect("entry");
            methods.push(entry.compression());
            let name = entry.name().to_owned();
            if entry.is_dir() {
                dirs.push(name);
            } else {
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).expect("read entry");
                files.insert(name, bytes);
            }
        }
        (files, dirs, methods)
    }

    fn part_leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .expect("read_dir")
            .filter_map(std::io::Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".part"))
            .collect()
    }

    #[test]
    fn nested_tree_round_trips_with_slash_joined_names() {
        let dir = TempDir::new().expect("tempdir");
        fs::write(dir.path().join("a.txt"), b"alpha").expect("write a");
        fs::create_dir_all(dir.path().join("sub/deep")).expect("mkdir");
        fs::write(dir.path().join("sub/b.txt"), b"bravo").expect("write b");
        fs::write(dir.path().join("sub/deep/c.txt"), b"charlie").expect("write c");

        let (files, _dirs, _methods) = zip_then_read(dir.path());
        let names: Vec<&String> = files.keys().collect();
        assert_eq!(
            names,
            vec!["a.txt", "sub/b.txt", "sub/deep/c.txt"],
            "entry names are relative to the folder root"
        );
        assert_eq!(files["sub/deep/c.txt"], b"charlie");
    }

    #[test]
    fn empty_directories_are_recorded() {
        let dir = TempDir::new().expect("tempdir");
        fs::create_dir(dir.path().join("empty")).expect("mkdir");
        fs::write(dir.path().join("kept.txt"), b"ok").expect("write");

        let (files, dirs, _methods) = zip_then_read(dir.path());
        assert_eq!(files.keys().collect::<Vec<_>>(), vec!["kept.txt"]);
        assert!(
            dirs.iter().any(|name| name.trim_end_matches('/') == "empty"),
            "empty dir must be a zip directory entry, got {dirs:?}"
        );
    }

    #[test]
    fn entries_are_store_only() {
        let dir = TempDir::new().expect("tempdir");
        fs::write(dir.path().join("a.txt"), b"not worth deflating").expect("write");

        let (_files, _dirs, methods) = zip_then_read(dir.path());
        assert!(!methods.is_empty(), "expected at least one zip entry");
        assert!(
            methods.iter().all(|m| *m == CompressionMethod::Stored),
            "every entry must be Stored, got {methods:?}"
        );
    }

    /// A symlink must be skipped: its target could be outside the zipped
    /// tree (a data-exfil escape) and a self-referential link would loop
    /// the walk.
    #[cfg(unix)]
    #[test]
    fn symlinks_are_skipped() {
        let dir = TempDir::new().expect("tempdir");
        fs::write(dir.path().join("real.txt"), b"real").expect("write");
        std::os::unix::fs::symlink(dir.path().join("real.txt"), dir.path().join("link.txt")).expect("symlink");

        // A symlink pointing *outside* the tree must not pull those bytes in.
        let outside = TempDir::new().expect("outside");
        fs::write(outside.path().join("secret.txt"), b"secret").expect("write secret");
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), dir.path().join("escape.txt")).expect("symlink outside");
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape_dir")).expect("dir symlink");

        let (files, dirs, _methods) = zip_then_read(dir.path());
        assert_eq!(files.keys().collect::<Vec<_>>(), vec!["real.txt"], "symlinks must not be archived");
        assert!(!files.values().any(|b| b == b"secret"), "must not follow a link out of tree");
        assert!(
            !dirs.iter().any(|name| name.contains("escape")),
            "directory symlink must not become a zip directory, got {dirs:?}"
        );
    }

    #[test]
    fn hidden_dotfiles_and_dotdirs_are_skipped() {
        let dir = TempDir::new().expect("tempdir");
        fs::write(dir.path().join(".env"), b"SECRET=1").expect("write env");
        fs::create_dir(dir.path().join(".hippius")).expect("mkdir hidden");
        fs::write(dir.path().join(".hippius/config"), b"nope").expect("write hidden");
        fs::write(dir.path().join("visible.txt"), b"ok").expect("write visible");

        let (files, dirs, _methods) = zip_then_read(dir.path());
        assert_eq!(files.keys().collect::<Vec<_>>(), vec!["visible.txt"]);
        assert!(!files.keys().any(|name| name.contains(".env") || name.contains(".hippius")));
        assert!(!dirs.iter().any(|name| name.contains(".hippius")));
    }

    #[cfg(unix)]
    #[test]
    fn backslash_names_are_skipped() {
        let dir = TempDir::new().expect("tempdir");
        fs::write(dir.path().join("..\\..\\evil.exe"), b"bad").expect("write zip-slip name");
        fs::write(dir.path().join("ok.txt"), b"ok").expect("write ok");

        let (files, _dirs, _methods) = zip_then_read(dir.path());
        assert_eq!(files.keys().collect::<Vec<_>>(), vec!["ok.txt"]);
        assert!(!files.keys().any(|name| name.contains('\\') || name.contains("evil.exe")));
    }

    #[test]
    fn output_inside_src_dir_is_refused_and_does_not_recurse() {
        let dir = TempDir::new().expect("tempdir");
        fs::write(dir.path().join("a.txt"), b"alpha").expect("write");
        let dest = dir.path().join("out.zip");
        fs::write(&dest, b"KEEPME").expect("seed dest");

        let err = zip_folder_store_only(dir.path(), &dest).expect_err("must refuse nested dest");
        assert!(matches!(err, AppError::Validation(_)), "{err:?}");
        assert_eq!(fs::read(&dest).expect("dest remains"), b"KEEPME");
        assert!(part_leftovers(dir.path()).is_empty(), "no .part left inside src");
    }

    #[test]
    fn pack_error_leaves_existing_dest_byte_identical() {
        let tmp = TempDir::new().expect("tempdir");
        let dest = tmp.path().join("out.zip");
        fs::write(&dest, b"KEEPME").expect("seed dest");

        let missing = tmp.path().join("no-such-folder");
        zip_folder_store_only(&missing, &dest).expect_err("src missing");
        assert_eq!(fs::read(&dest).expect("dest remains"), b"KEEPME");
        assert!(part_leftovers(tmp.path()).is_empty(), "temp part must be deleted on error");
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_file_does_not_clobber_existing_dest() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().expect("tempdir");
        let src = tmp.path().join("src");
        fs::create_dir(&src).expect("mkdir");
        fs::write(src.join("ok.txt"), b"ok").expect("write");
        let locked = src.join("locked.txt");
        fs::write(&locked, b"secret").expect("write locked");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).expect("chmod");

        let dest = tmp.path().join("out.zip");
        fs::write(&dest, b"KEEPME").expect("seed dest");

        let err = zip_folder_store_only(&src, &dest);
        let _ = fs::set_permissions(&locked, fs::Permissions::from_mode(0o644));
        err.expect_err("unreadable file must fail the pack");
        assert_eq!(fs::read(&dest).expect("dest remains"), b"KEEPME");
        assert!(part_leftovers(tmp.path()).is_empty(), "temp part must be deleted on error");
    }

    #[test]
    fn out_of_tree_directory_is_refused() {
        let src = TempDir::new().expect("src");
        let outside = TempDir::new().expect("outside");
        let mut visited = HashSet::new();
        visited.insert(src.path().canonicalize().expect("canon src"));
        let err = push_directory_if_new(src.path(), outside.path(), &mut visited).expect_err("out of tree");
        assert!(matches!(err, AppError::Validation(_)), "{err:?}");
    }

    #[test]
    fn already_visited_canonical_path_is_not_walked_twice() {
        let src = TempDir::new().expect("src");
        let child = src.path().join("sub");
        fs::create_dir(&child).expect("mkdir");
        let mut visited = HashSet::new();
        visited.insert(src.path().canonicalize().expect("canon src"));
        assert!(push_directory_if_new(src.path(), &child, &mut visited).expect("first visit"));
        assert!(!push_directory_if_new(src.path(), &child, &mut visited).expect("second visit is a cycle"));
    }

    #[test]
    fn validate_relative_folder_rejects_dotdot() {
        for bad in ["..", "../outside", "a/../b", "./a", ""] {
            let err = validate_relative_folder(bad).expect_err("must reject");
            assert!(matches!(err, AppError::Validation(_)), "{bad:?} → {err:?}");
        }
    }

    #[test]
    fn validate_relative_folder_accepts_nested() {
        assert_eq!(validate_relative_folder("photos").expect("flat"), "photos");
        assert_eq!(validate_relative_folder("trips/photos").expect("nested"), "trips/photos");
        assert_eq!(validate_relative_folder("/photos/").expect("trimmed"), "photos");
    }

    #[tokio::test]
    async fn unregistered_sync_path_is_rejected() {
        let pool = empty_pool().await;
        let dir = TempDir::new().expect("tempdir");
        let err = export_folder_zip_inner(
            &pool,
            OWNER,
            dir.path().to_string_lossy().into_owned(),
            "photos".into(),
            dir.path().join("out.zip").to_string_lossy().into_owned(),
        )
        .await
        .expect_err("must reject");
        match err {
            AppError::Validation(msg) => {
                assert!(msg.contains("not a registered sync folder"), "unexpected message: {msg}");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn dotdot_relative_folder_is_rejected_before_zip() {
        let tmp = TempDir::new().expect("tempdir");
        let sync_root = tmp.path().join("sync");
        fs::create_dir_all(&sync_root).expect("mkdir sync");
        let pool = pool_with_sync_path(sync_root.to_str().expect("utf8 path")).await;

        let err = export_folder_zip_inner(
            &pool,
            OWNER,
            sync_root.to_string_lossy().into_owned(),
            "../outside".into(),
            tmp.path().join("out.zip").to_string_lossy().into_owned(),
        )
        .await
        .expect_err("must reject");
        match err {
            AppError::Validation(msg) => {
                assert!(msg.contains("illegal component"), "unexpected message: {msg}");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
        assert!(!tmp.path().join("out.zip").exists(), "no partial zip on reject");
    }

    #[tokio::test]
    async fn inner_zips_a_registered_folder() {
        let tmp = TempDir::new().expect("tempdir");
        let sync_root = tmp.path().join("sync");
        let photos = sync_root.join("photos");
        fs::create_dir_all(photos.join("sub")).expect("mkdir");
        fs::write(photos.join("a.txt"), b"alpha").expect("write");
        fs::write(photos.join("sub/b.txt"), b"bravo").expect("write");
        let pool = pool_with_sync_path(sync_root.to_str().expect("utf8 path")).await;

        let out = tmp.path().join("photos.zip");
        export_folder_zip_inner(
            &pool,
            OWNER,
            sync_root.to_string_lossy().into_owned(),
            "photos".into(),
            out.to_string_lossy().into_owned(),
        )
        .await
        .expect("zip");

        let file = fs::File::open(&out).expect("open zip");
        let mut archive = ZipArchive::new(file).expect("read archive");
        let mut names = Vec::new();
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).expect("entry");
            assert_eq!(entry.compression(), CompressionMethod::Stored);
            if entry.is_file() {
                names.push(entry.name().to_owned());
                if entry.name() == "a.txt" {
                    let mut buf = Vec::new();
                    entry.read_to_end(&mut buf).expect("read");
                    assert_eq!(buf, b"alpha");
                }
            }
        }
        names.sort();
        assert_eq!(names, vec!["a.txt".to_string(), "sub/b.txt".to_string()]);
    }

    /// Cursor round-trip used only to prove `pack_tree_into_zip` does not
    /// depend on a filesystem destination existing mid-write.
    #[test]
    fn pack_into_memory_cursor_is_a_valid_archive() {
        let dir = TempDir::new().expect("tempdir");
        fs::write(dir.path().join("only.txt"), b"x").expect("write");
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        pack_tree_into_zip(dir.path(), &mut zip, stored_options()).expect("pack");
        let cursor = zip.finish().expect("finish");
        let archive = ZipArchive::new(Cursor::new(cursor.into_inner())).expect("read");
        assert_eq!(archive.len(), 1);
    }
}
