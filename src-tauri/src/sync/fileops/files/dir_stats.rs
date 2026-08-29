//! Cached recursive directory size/file-count stats for the folder listing.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

/// Process-wide cache for [`dir_stats_recursive`].
///
/// Keyed by absolute path. Each entry records the directory's mtime at the
/// time of the walk. On lookup, if the current mtime matches the cached
/// one, the cached `(size, count)` is returned without re-walking. Direct
/// children changing does bump that directory's mtime (APFS/ext4/NTFS),
/// but a parent is **not** stamped when a descendant in a subdirectory is
/// added or removed — so every code path that mutates the sync tree must
/// call [`invalidate_dir_stats_for_change`] rather than relying on mtime,
/// and a completed sync cycle that touched local files must call
/// [`invalidate_dir_stats_after_cycle`].
/// Pure file-content changes within an unmodified directory don't
/// invalidate the cache, but they don't change `count` and almost never
/// shift the displayed size by a meaningful amount.
///
/// **Symlinks**: `tokio::fs::metadata` follows symlinks. If a sync folder
/// contains a symlink whose target's directory mtime changes without the
/// symlink itself being touched, the cache will return stale stats. Sync
/// folders typically don't contain symlinks (they're user document
/// folders), so this is a documented limitation rather than a regression.
///
/// **Eviction**: bounded organically by the number of folders the user
/// browses — small in practice (sync roots + their subfolders, ~hundreds
/// of entries on a long session). No TTL or LRU cap. If usage patterns
/// change and the cache grows large, swap to `quick_cache` or wire a
/// per-drive cache that drops on `remove_drive`.
/// Cached `(mtime, size, count)` for each cached directory path.
type DirStatsEntry = (std::time::SystemTime, u64, u64);
type DirStatsMap = std::sync::Mutex<HashMap<std::path::PathBuf, DirStatsEntry>>;

static DIR_STATS_CACHE: OnceLock<DirStatsMap> = OnceLock::new();

fn dir_stats_cache() -> &'static DirStatsMap {
    DIR_STATS_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Recursively compute total size and file count within a directory.
/// Hidden files (starting with '.') are excluded.
///
/// Memoised by `(path, mtime)`. On a hit the cached `(size, count)` is
/// returned without descending the tree. A miss walks the tree once on a
/// blocking thread and inserts a cache entry for **every** subdirectory
/// so a later listing of a child does not re-walk.
pub(super) async fn dir_stats_recursive(path: &Path) -> (u64, u64) {
    let mtime = match tokio::fs::metadata(path).await {
        Ok(meta) => meta.modified().ok(),
        Err(_) => None,
    };
    if let Some(mtime) = mtime
        && let Ok(cache) = dir_stats_cache().lock()
        && let Some((cached_mtime, size, count)) = cache.get(path)
        && *cached_mtime == mtime
    {
        return (*size, *count);
    }

    let walk_root = path.to_path_buf();
    let Ok(filled) = tokio::task::spawn_blocking(move || dir_stats_walk_std(&walk_root)).await else {
        return (0, 0);
    };

    let root_stats = filled
        .iter()
        .find(|(p, _, _, _)| p == path)
        .map_or((0, 0), |(_, _, size, count)| (*size, *count));

    if let Ok(mut cache) = dir_stats_cache().lock() {
        for (p, dir_mtime, size, count) in filled {
            cache.insert(p, (dir_mtime, size, count));
        }
    }
    root_stats
}

/// Drop every cached entry whose path is `root` or a descendant. Called
/// from `remove_drive` so a re-add of the same path cannot reuse stale
/// stats from the previous drive.
pub(crate) fn invalidate_dir_stats_under(root: &Path) {
    let Ok(mut cache) = dir_stats_cache().lock() else {
        return;
    };
    cache.retain(|path, _| path != root && !path.starts_with(root));
}

/// Drop every cached entry a mutation at `changed` makes stale: the subtree
/// rooted at `changed`, plus the exact entry for each ancestor directory up
/// to `sync_root` (inclusive).
///
/// Cache key is `(path, directory mtime)`. POSIX only stamps the directory
/// whose own entries changed, so deleting or creating `root/sub/a.txt`
/// updates `root/sub` but not `root`. A listing of `root` would keep serving
/// the pre-mutation totals for `sub` unless those ancestor keys are dropped.
/// The subtree sweep covers a removed directory (whose rows can never be
/// revalidated by mtime) and a destination directory an add merged into.
///
/// Ancestors are dropped by EXACT key, not by subtree: a sibling folder the
/// user already browsed is unaffected by a change elsewhere in the tree, and
/// re-walking it costs the walk this cache exists to avoid.
///
/// Every path that mutates the sync tree — `delete_files`, the `add_*`
/// commands — must call this; do not rely on parent mtime. Both arguments
/// must be the listing form (DB sync path + relative), never a canonicalized
/// target: `list_sync_folder` never canonicalizes, so on macOS a
/// `/private/var` key would miss every row a `/var` listing wrote.
pub(super) fn invalidate_dir_stats_for_change(sync_root: &Path, changed: &Path) {
    invalidate_dir_stats_under(changed);

    let Ok(mut cache) = dir_stats_cache().lock() else {
        return;
    };
    let mut ancestor = changed.parent();
    while let Some(path) = ancestor {
        if !path.starts_with(sync_root) {
            return;
        }
        cache.remove(path);
        if path == sync_root {
            return;
        }
        ancestor = path.parent();
    }
}

/// Drop the whole cache after a sync cycle that changed files on disk.
///
/// A cycle materializes and removes files at any depth, on any drive, and
/// only stamps the directories whose own entries changed — so every ancestor
/// above them would keep serving pre-cycle totals for the rest of the
/// session. The per-file `FileSyncedFn` callback has no cheap synchronous way
/// to resolve its drive's root path, so the memo is dropped wholesale rather
/// than left lying. Bounded: at most one clear per cycle that actually
/// touched local files, and the next listing refills it in one walk.
pub(in crate::sync) fn invalidate_dir_stats_after_cycle(files_downloaded: usize, files_deleted_locally: usize) {
    if files_downloaded == 0 && files_deleted_locally == 0 {
        return;
    }
    if let Ok(mut cache) = dir_stats_cache().lock() {
        cache.clear();
    }
}

/// The stats cache is process-wide, so tests that seed, clear, or assert on
/// it cannot interleave under cargo's parallel runner. Every such test in
/// this module and in the sibling `add`/`delete` modules holds this first.
/// A `tokio` mutex, not a `std` one: the async tests hold it across `.await`
/// and `clippy::await_holding_lock` is denied crate-wide.
#[cfg(test)]
pub(super) static CACHE_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Test-only cache probes and edits.
///
/// They exist so no assertion runs while a [`std::sync::MutexGuard`] on the
/// cache is alive: a failing assert would otherwise unwind through the guard,
/// poison the process-wide mutex, and turn every later test in the binary into
/// a false failure that hides the real one.
#[cfg(test)]
pub(super) mod test_access {
    use super::{DirStatsEntry, dir_stats_cache};
    use std::path::Path;

    pub(in crate::sync::fileops::files) fn is_cached(path: &Path) -> bool {
        dir_stats_cache().lock().is_ok_and(|cache| cache.contains_key(path))
    }

    pub(in crate::sync::fileops::files) fn read(path: &Path) -> Option<DirStatsEntry> {
        dir_stats_cache().lock().ok().and_then(|cache| cache.get(path).copied())
    }

    pub(in crate::sync::fileops::files) fn seed(path: &Path, mtime: std::time::SystemTime, size: u64, count: u64) {
        if let Ok(mut cache) = dir_stats_cache().lock() {
            cache.insert(path.to_path_buf(), (mtime, size, count));
        }
    }

    pub(in crate::sync::fileops::files) fn forget(paths: &[&Path]) {
        if let Ok(mut cache) = dir_stats_cache().lock() {
            for path in paths {
                cache.remove(*path);
            }
        }
    }
}

/// Iterative `std::fs` walk. Returns one `(path, mtime, size, count)`
/// per directory visited (including `root`). Hidden names are skipped.
/// A directory with no readable mtime is omitted from the fill list
/// (same "don't cache" rule as the old miss path).
fn dir_stats_walk_std(root: &Path) -> Vec<(std::path::PathBuf, std::time::SystemTime, u64, u64)> {
    let mut filled = Vec::new();
    walk_dir_std(root, &mut filled);
    filled
}

fn walk_dir_std(path: &Path, filled: &mut Vec<(std::path::PathBuf, std::time::SystemTime, u64, u64)>) -> (u64, u64) {
    let mut size: u64 = 0;
    let mut count: u64 = 0;
    let Ok(dir) = std::fs::read_dir(path) else {
        return (0, 0);
    };
    for entry in dir.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            let (sub_size, sub_count) = walk_dir_std(&entry.path(), filled);
            size += sub_size;
            count += sub_count;
        } else {
            size += meta.len();
            count += 1;
        }
    }
    if let Ok(mtime) = std::fs::metadata(path).and_then(|m| m.modified()) {
        filled.push((path.to_path_buf(), mtime, size, count));
    }
    (size, count)
}

#[cfg(test)]
mod tests {
    use super::test_access::{forget, is_cached, read, seed};
    use super::*;

    /// `dir_stats_recursive` reads from `DIR_STATS_CACHE` when the
    /// directory's mtime matches the cached entry. We can't easily
    /// stage a "real" cache hit in a unit test (mtime resolution is OS
    /// timer-dependent), so this test takes the deterministic route:
    /// stat the temp dir to learn its mtime, write a deliberately wrong
    /// `(size, count)` into the cache under that mtime, and assert
    /// `dir_stats_recursive` returns the wrong cached value rather than
    /// re-walking the tree. Proves the cache lookup is consulted.
    #[tokio::test]
    async fn dir_stats_recursive_returns_cached_value_on_mtime_match() {
        let _cache_guard = CACHE_TEST_LOCK.lock().await;
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();

        // Create a tiny tree so a fresh walk would return non-zero values.
        tokio::fs::write(dir.join("a.txt"), b"hello world").await.expect("write a");
        tokio::fs::write(dir.join("b.txt"), b"goodbye").await.expect("write b");

        // Read the directory's actual mtime — that's the cache key.
        let mtime = tokio::fs::metadata(dir).await.expect("metadata").modified().expect("mtime");

        // Plant a deliberately wrong cached entry under this mtime.
        let bogus_size = 999_999_999u64;
        let bogus_count = 123u64;
        seed(dir, mtime, bogus_size, bogus_count);

        let (size, count) = dir_stats_recursive(dir).await;
        forget(&[dir]);

        assert_eq!(size, bogus_size, "dir_stats_recursive must return the cached size on mtime match");
        assert_eq!(count, bogus_count, "dir_stats_recursive must return the cached count on mtime match");
    }

    /// On a fresh path the cache is empty; `dir_stats_recursive` must walk
    /// the tree and return real values. Pairs with the cache-hit test
    /// above to confirm the lookup path doesn't ALWAYS short-circuit.
    #[tokio::test]
    async fn dir_stats_recursive_walks_on_cache_miss() {
        let _cache_guard = CACHE_TEST_LOCK.lock().await;
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();

        tokio::fs::write(dir.join("one.txt"), b"x").await.expect("write");
        tokio::fs::write(dir.join("two.txt"), b"yz").await.expect("write");

        let (size, count) = dir_stats_recursive(dir).await;
        forget(&[dir]);

        assert_eq!(size, 3, "fresh walk must sum file bytes (1 + 2)");
        assert_eq!(count, 2, "fresh walk must count files");
    }

    #[tokio::test]
    async fn dir_stats_walk_caches_child_directories() {
        let _cache_guard = CACHE_TEST_LOCK.lock().await;
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        let sub = root.join("sub");
        std::fs::create_dir(&sub).expect("mkdir sub");
        std::fs::write(sub.join("a.txt"), b"xyz").expect("write");

        let (size, count) = dir_stats_recursive(root).await;
        assert_eq!(size, 3);
        assert_eq!(count, 1);

        let sub_mtime = std::fs::metadata(&sub).expect("meta").modified().expect("mtime");
        assert_eq!(read(&sub), Some((sub_mtime, 3, 1)), "child must be cached by the parent walk");

        // Prove the child entry is consulted: plant a bogus value under the
        // real mtime and re-query the child — must not re-walk.
        seed(&sub, sub_mtime, 42, 7);
        let (size, count) = dir_stats_recursive(&sub).await;
        forget(&[root, &sub]);

        assert_eq!(size, 42);
        assert_eq!(count, 7);
    }

    #[tokio::test]
    async fn dir_stats_skips_dotfiles_and_dot_dirs() {
        let _cache_guard = CACHE_TEST_LOCK.lock().await;
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        std::fs::write(root.join("visible.txt"), b"ab").expect("write");
        std::fs::write(root.join(".hidden"), b"xxxx").expect("write hidden");
        std::fs::create_dir(root.join(".git")).expect("mkdir .git");
        std::fs::write(root.join(".git").join("x"), b"yyyy").expect("write git");

        let (size, count) = dir_stats_recursive(root).await;
        forget(&[root]);

        assert_eq!(size, 2, "dotfiles and .git must not count");
        assert_eq!(count, 1);
    }

    #[test]
    fn invalidate_dir_stats_under_drops_only_that_tree() {
        let _cache_guard = CACHE_TEST_LOCK.blocking_lock();
        let keep = std::path::PathBuf::from("/under/keep");
        let root = std::path::PathBuf::from("/under/drive");
        let child = root.join("sub");
        let now = std::time::SystemTime::now();
        seed(&root, now, 1, 1);
        seed(&child, now, 2, 2);
        seed(&keep, now, 3, 3);

        invalidate_dir_stats_under(&root);
        let (root_gone, child_gone, keep_kept) = (!is_cached(&root), !is_cached(&child), is_cached(&keep));
        forget(&[&keep]);

        assert!(root_gone);
        assert!(child_gone);
        assert!(keep_kept);
    }

    /// H-068: cache key is `(path, mtime)`. A parent directory's mtime does
    /// not change when a file is deleted from a *subdirectory*, so seeding
    /// root/ and root/sub/ then deleting root/sub/a.txt (9 B) must still
    /// drop 9 B from `dir_stats_recursive(root)` after ancestor invalidation
    /// — not because root mtime moved.
    #[tokio::test]
    async fn deleting_a_nested_file_drops_ancestor_dir_stats_without_root_mtime() {
        let _cache_guard = CACHE_TEST_LOCK.lock().await;
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        let sub = root.join("sub");
        std::fs::create_dir(&sub).expect("mkdir sub");
        let file = sub.join("a.txt");
        std::fs::write(&file, b"123456789").expect("write 9 bytes");

        let (size, count) = dir_stats_recursive(root).await;
        assert_eq!((size, count), (9, 1));

        std::fs::remove_file(&file).expect("delete nested file");

        // Re-seed under the POST-delete mtimes so a filesystem that happens
        // to bump root mtime cannot make this pass via a cache miss. The
        // production bug is that Unix does *not* bump that mtime.
        let root_mtime = std::fs::metadata(root).expect("meta").modified().expect("mtime");
        let sub_mtime = std::fs::metadata(&sub).expect("meta").modified().expect("mtime");
        seed(root, root_mtime, 9, 1);
        seed(&sub, sub_mtime, 9, 1);

        let (size, count) = dir_stats_recursive(root).await;
        assert_eq!((size, count), (9, 1), "seeded cache must be consulted before invalidation");

        invalidate_dir_stats_for_change(root, &file);

        let (size, count) = dir_stats_recursive(root).await;
        forget(&[root, &sub]);

        assert_eq!((size, count), (0, 0), "root totals must drop the deleted 9 B");
    }

    /// The add side of the same mtime hole: creating `root/sub/new.txt`
    /// stamps `root/sub` but not `root`, so a listing of `root` would keep
    /// reporting the pre-upload size for the `sub` folder row.
    #[tokio::test]
    async fn adding_a_nested_file_drops_ancestor_dir_stats_without_root_mtime() {
        let _cache_guard = CACHE_TEST_LOCK.lock().await;
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        let sub = root.join("sub");
        std::fs::create_dir(&sub).expect("mkdir sub");
        std::fs::write(sub.join("a.txt"), b"12345").expect("write 5 bytes");

        let (size, count) = dir_stats_recursive(root).await;
        assert_eq!((size, count), (5, 1));

        let added = sub.join("b.txt");
        std::fs::write(&added, b"6789").expect("write 4 bytes");

        // Re-seed root under its CURRENT mtime: on Unix the add did not
        // stamp it, so this is what production holds after the upload.
        let root_mtime = std::fs::metadata(root).expect("meta").modified().expect("mtime");
        seed(root, root_mtime, 5, 1);

        let (size, count) = dir_stats_recursive(root).await;
        assert_eq!((size, count), (5, 1), "seeded cache must be consulted before invalidation");

        invalidate_dir_stats_for_change(root, &added);

        let (size, count) = dir_stats_recursive(root).await;
        forget(&[root, &sub]);

        assert_eq!((size, count), (9, 2), "root totals must pick up the added 4 B");
    }

    #[test]
    fn change_invalidation_stops_at_the_sync_root() {
        let _cache_guard = CACHE_TEST_LOCK.blocking_lock();
        let above_root = std::path::PathBuf::from("/stops");
        let sync_root = std::path::PathBuf::from("/stops/drive");
        let sub = sync_root.join("sub");
        let now = std::time::SystemTime::now();
        seed(&sync_root, now, 1, 1);
        seed(&sub, now, 2, 2);
        seed(&above_root, now, 4, 4);

        invalidate_dir_stats_for_change(&sync_root, &sub.join("a.txt"));
        let (root_gone, sub_gone, above_kept) = (!is_cached(&sync_root), !is_cached(&sub), is_cached(&above_root));
        forget(&[&above_root]);

        assert!(root_gone);
        assert!(sub_gone);
        assert!(above_kept, "must not walk above the sync root into /Users or drive parents");
    }

    /// A change in one branch says nothing about another branch's totals.
    /// Dropping ancestors by SUBTREE instead of by exact key would discard
    /// every folder the user already browsed on this drive, so each delete
    /// would force the full re-walk this cache exists to avoid.
    #[test]
    fn change_invalidation_keeps_sibling_subtrees_inside_the_sync_root() {
        let _cache_guard = CACHE_TEST_LOCK.blocking_lock();
        let sync_root = std::path::PathBuf::from("/siblings/drive");
        let touched = sync_root.join("docs");
        let sibling = sync_root.join("photos");
        let sibling_child = sibling.join("2024");
        let now = std::time::SystemTime::now();
        seed(&sync_root, now, 1, 1);
        seed(&touched, now, 2, 2);
        seed(&sibling, now, 3, 3);
        seed(&sibling_child, now, 4, 4);

        invalidate_dir_stats_for_change(&sync_root, &touched.join("a.txt"));
        let root_gone = !is_cached(&sync_root);
        let touched_gone = !is_cached(&touched);
        let sibling_kept = is_cached(&sibling);
        let sibling_child_kept = is_cached(&sibling_child);
        forget(&[&sibling, &sibling_child]);

        assert!(root_gone, "the ancestor's total changed");
        assert!(touched_gone, "the containing folder's total changed");
        assert!(sibling_kept, "an untouched sibling keeps its walk");
        assert!(sibling_child_kept, "and so does everything under it");
    }

    /// Deleting a DIRECTORY must also drop the rows for everything that was
    /// inside it — those paths are gone, so no future mtime check can ever
    /// retire them, and a same-named folder recreated later would inherit
    /// them if its mtime happened to match.
    #[test]
    fn change_invalidation_drops_the_removed_subtree() {
        let _cache_guard = CACHE_TEST_LOCK.blocking_lock();
        let sync_root = std::path::PathBuf::from("/subtree/drive");
        let removed = sync_root.join("docs");
        let removed_child = removed.join("2024");
        let now = std::time::SystemTime::now();
        seed(&sync_root, now, 1, 1);
        seed(&removed, now, 2, 2);
        seed(&removed_child, now, 3, 3);

        invalidate_dir_stats_for_change(&sync_root, &removed);
        let (removed_gone, child_gone, root_gone) = (!is_cached(&removed), !is_cached(&removed_child), !is_cached(&sync_root));

        assert!(removed_gone);
        assert!(child_gone);
        assert!(root_gone);
    }

    /// A path outside the drive must not walk the cache upward at all —
    /// otherwise a mutation under one drive would evict entries belonging
    /// to a directory it does not own.
    #[test]
    fn change_invalidation_ignores_a_path_outside_the_sync_root() {
        let _cache_guard = CACHE_TEST_LOCK.blocking_lock();
        let sync_root = std::path::PathBuf::from("/outside/drive");
        let other = std::path::PathBuf::from("/outside/other");
        let now = std::time::SystemTime::now();
        seed(&sync_root, now, 1, 1);
        seed(&other, now, 2, 2);

        invalidate_dir_stats_for_change(&sync_root, &other.join("deep").join("a.txt"));
        let (root_kept, other_kept) = (is_cached(&sync_root), is_cached(&other));
        forget(&[&sync_root, &other]);

        assert!(root_kept, "a change elsewhere must not evict this drive");
        assert!(other_kept, "and must not climb its own parents");
    }

    /// A sync cycle writes and removes files at any depth on any drive, so
    /// the totals it invalidates are not reachable from a single path. Only
    /// a cycle that actually touched local files pays the clear — an
    /// upload-only cycle must leave the memo intact.
    #[test]
    fn only_a_cycle_that_touched_local_files_clears_the_cache() {
        let _cache_guard = CACHE_TEST_LOCK.blocking_lock();
        let seeded = std::path::PathBuf::from("/cycle/drive");
        let now = std::time::SystemTime::now();

        seed(&seeded, now, 1, 1);
        invalidate_dir_stats_after_cycle(0, 0);
        let survives_upload_only = is_cached(&seeded);

        invalidate_dir_stats_after_cycle(1, 0);
        let cleared_by_download = !is_cached(&seeded);

        seed(&seeded, now, 1, 1);
        invalidate_dir_stats_after_cycle(0, 1);
        let cleared_by_local_delete = !is_cached(&seeded);

        forget(&[&seeded]);

        assert!(
            survives_upload_only,
            "an upload-only cycle changes nothing on disk that mtime does not already cover"
        );
        assert!(cleared_by_download, "a cycle that materialized a file must drop the pre-cycle totals");
        assert!(
            cleared_by_local_delete,
            "a cycle that removed a local file must drop the pre-cycle totals"
        );
    }
}
