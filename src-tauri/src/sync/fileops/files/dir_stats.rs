//! Cached recursive directory size/file-count stats for the folder listing.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

/// Process-wide cache for [`dir_stats_recursive`].
///
/// Keyed by absolute path. Each entry records the directory's mtime at the
/// time of the walk. On lookup, if the current mtime matches the cached
/// one, the cached `(size, count)` is returned without re-walking. APFS,
/// ext4, and NTFS all bump a directory's mtime on add/remove/rename of
/// children, which is the only invalidation case the file browser cares
/// about — pure file-content changes within an unmodified directory don't
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

/// Drop every cached entry whose path is `root` or a descendant.
///
/// Called from `remove_drive`, so a re-add of the same path cannot reuse
/// stale stats from the previous drive, and from every `add_file` /
/// `add_files` / `add_folder` copy, because the `(path, mtime)` key cannot
/// see a copy that lands inside the directory mtime's resolution.
///
/// `root` must be the path the frontend passed, not its canonical form —
/// the cache is keyed by whatever path the listing walked, and on macOS the
/// two differ (`/tmp` → `/private/tmp`).
pub(crate) fn invalidate_dir_stats_under(root: &Path) {
    let Ok(mut cache) = dir_stats_cache().lock() else {
        return;
    };
    cache.retain(|path, _| path != root && !path.starts_with(root));
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
        {
            let mut cache = dir_stats_cache().lock().expect("lock");
            cache.insert(dir.to_path_buf(), (mtime, bogus_size, bogus_count));
        }

        let (size, count) = dir_stats_recursive(dir).await;
        assert_eq!(size, bogus_size, "dir_stats_recursive must return the cached size on mtime match");
        assert_eq!(count, bogus_count, "dir_stats_recursive must return the cached count on mtime match");

        // Cleanup so this test doesn't pollute other tests' cache state.
        dir_stats_cache().lock().expect("lock").remove(dir);
    }

    /// On a fresh path the cache is empty; `dir_stats_recursive` must walk
    /// the tree and return real values. Pairs with the cache-hit test
    /// above to confirm the lookup path doesn't ALWAYS short-circuit.
    #[tokio::test]
    async fn dir_stats_recursive_walks_on_cache_miss() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();

        tokio::fs::write(dir.join("one.txt"), b"x").await.expect("write");
        tokio::fs::write(dir.join("two.txt"), b"yz").await.expect("write");

        let (size, count) = dir_stats_recursive(dir).await;
        assert_eq!(size, 3, "fresh walk must sum file bytes (1 + 2)");
        assert_eq!(count, 2, "fresh walk must count files");

        dir_stats_cache().lock().expect("lock").remove(dir);
    }

    #[tokio::test]
    async fn dir_stats_walk_caches_child_directories() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        let sub = root.join("sub");
        std::fs::create_dir(&sub).expect("mkdir sub");
        std::fs::write(sub.join("a.txt"), b"xyz").expect("write");

        let (size, count) = dir_stats_recursive(root).await;
        assert_eq!(size, 3);
        assert_eq!(count, 1);

        let sub_mtime = std::fs::metadata(&sub).expect("meta").modified().expect("mtime");
        {
            let cache = dir_stats_cache().lock().expect("lock");
            let (cached_mtime, cached_size, cached_count) = cache.get(&sub).expect("child must be cached by the parent walk");
            assert_eq!(*cached_mtime, sub_mtime);
            assert_eq!(*cached_size, 3);
            assert_eq!(*cached_count, 1);
        }

        // Prove the child entry is consulted: plant a bogus value under the
        // real mtime and re-query the child — must not re-walk.
        {
            let mut cache = dir_stats_cache().lock().expect("lock");
            cache.insert(sub.clone(), (sub_mtime, 42, 7));
        }
        let (size, count) = dir_stats_recursive(&sub).await;
        assert_eq!(size, 42);
        assert_eq!(count, 7);

        dir_stats_cache().lock().expect("lock").remove(root);
        dir_stats_cache().lock().expect("lock").remove(&sub);
    }

    #[tokio::test]
    async fn dir_stats_skips_dotfiles_and_dot_dirs() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        std::fs::write(root.join("visible.txt"), b"ab").expect("write");
        std::fs::write(root.join(".hidden"), b"xxxx").expect("write hidden");
        std::fs::create_dir(root.join(".git")).expect("mkdir .git");
        std::fs::write(root.join(".git").join("x"), b"yyyy").expect("write git");

        let (size, count) = dir_stats_recursive(root).await;
        assert_eq!(size, 2, "dotfiles and .git must not count");
        assert_eq!(count, 1);

        dir_stats_cache().lock().expect("lock").remove(root);
    }

    #[test]
    fn invalidate_dir_stats_under_drops_only_that_tree() {
        let keep = std::path::PathBuf::from("/b/other");
        let root = std::path::PathBuf::from("/a/drive");
        let child = root.join("sub");
        let now = std::time::SystemTime::now();
        {
            let mut cache = dir_stats_cache().lock().expect("lock");
            cache.insert(root.clone(), (now, 1, 1));
            cache.insert(child.clone(), (now, 2, 2));
            cache.insert(keep.clone(), (now, 3, 3));
        }
        invalidate_dir_stats_under(&root);
        let cache = dir_stats_cache().lock().expect("lock");
        assert!(!cache.contains_key(&root));
        assert!(!cache.contains_key(&child));
        assert!(cache.contains_key(&keep));
        drop(cache);
        dir_stats_cache().lock().expect("lock").remove(&keep);
    }
}
