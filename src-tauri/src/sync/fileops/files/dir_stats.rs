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
/// returned without descending the tree. Cache misses fall through to the
/// recursive walk and write the result back to the cache before returning.
pub(super) async fn dir_stats_recursive(path: &Path) -> (u64, u64) {
    // Cache lookup. Stat the directory once to learn its mtime; on match
    // skip the walk entirely.
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

    // Cache miss — walk the tree.
    let (size, count) = dir_stats_walk(path).await;

    // Store under the original mtime (if we got one). If mtime is None
    // we skip caching so the next call retries the walk.
    if let Some(mtime) = mtime
        && let Ok(mut cache) = dir_stats_cache().lock()
    {
        cache.insert(path.to_path_buf(), (mtime, size, count));
    }
    (size, count)
}

/// The pure recursive walk underpinning [`dir_stats_recursive`]. Split out so
/// the cache lookup wraps it without recursing through the cache lookup
/// itself (recursive calls always re-walk subdirectories — the cache would
/// add lock contention without reducing total work since the parent mtime
/// already validated the whole subtree).
async fn dir_stats_walk(path: &Path) -> (u64, u64) {
    let mut size: u64 = 0;
    let mut count: u64 = 0;
    let Ok(mut dir) = tokio::fs::read_dir(path).await else {
        return (0, 0);
    };
    while let Ok(Some(entry)) = dir.next_entry().await {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if meta.is_dir() {
            let (sub_size, sub_count) = Box::pin(dir_stats_walk(&entry.path())).await;
            size += sub_size;
            count += sub_count;
        } else {
            size += meta.len();
            count += 1;
        }
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
}
