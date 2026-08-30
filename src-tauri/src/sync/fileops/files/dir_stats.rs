//! Cached recursive directory size/file-count stats for the folder listing.

use super::pathops::is_engine_hidden_name;
use hcfs_client::drive::ExcludeRules;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Process-wide cache for [`dir_stats_recursive`].
///
/// Keyed by absolute path plus the ruleset the walk applied (see
/// [`DirStatsKey`]). Each entry records the directory's mtime at the
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
/// Cache key: the walked directory AND the ruleset it was walked under
/// ([`DirStatsExcludes::key`]).
///
/// The ruleset belongs in the key, not the payload: the same directory has
/// different totals under different exclude patterns, and editing
/// `.hippius/exclude` touches no directory's mtime, so a two-part key would
/// serve pre-exclusion totals for the rest of the session (H-110).
///
/// It belongs in the *map* key rather than a validity field alongside the
/// mtime, because a map keyed on the path alone holds exactly ONE ruleset's
/// answer per directory. The billing lag probe
/// (`storage_overview::local_bytes_for_paths`) walks the same drive roots
/// with no rules at all, so with a single slot the two callers overwrite
/// each other and every listing pays the full walk the memo exists to avoid.
/// Neither ever serves the other's numbers — a key mismatch is a miss, not a
/// wrong answer — but neither ever hits either.
///
/// The extra entries are bounded at one per live ruleset: a superseded
/// `.hippius/exclude` leaves entries behind until the next invalidation, and
/// any sync cycle that touches local files clears the whole map.
type DirStatsKey = (PathBuf, u64);
/// Cached `(mtime, size, count)` for each cached `(directory, ruleset)`.
type DirStatsEntry = (std::time::SystemTime, u64, u64);
type DirStatsMap = std::sync::Mutex<HashMap<DirStatsKey, DirStatsEntry>>;

/// Ruleset key for a walk with no exclusions — both a `None` `excludes` and
/// an empty pattern list. Reserved: [`DirStatsExcludes::key`] never returns
/// it for a non-empty list.
const NO_EXCLUDES_KEY: u64 = 0;

/// Exclusion context for a stats walk.
///
/// Folder rows must count what Drive shows, and Drive hides what the engine
/// skips — so the walk applies the same rules the listing tags rows with,
/// against paths relative to `root`.
///
/// Carries the raw patterns rather than a compiled [`ExcludeRules`]: the walk
/// runs on a blocking thread and `ExcludeRules` is not `Clone`, and compiling
/// there keeps the cache key and the rules provably derived from one list.
pub(crate) struct DirStatsExcludes<'a> {
    /// Drive root the walked paths are relativized against, in the LISTING
    /// form (never canonicalized) so the rules see the paths the user's
    /// patterns were written against.
    pub root: &'a Path,
    pub patterns: &'a [String],
}

impl DirStatsExcludes<'_> {
    /// Ruleset identity for the cache key.
    ///
    /// `root` is hashed as well as the patterns: it decides what each walked
    /// path is relativized to before matching, so the same patterns under a
    /// different root are a different ruleset with different answers and must
    /// not share an entry.
    ///
    /// `DefaultHasher` is adequate because this value never leaves the
    /// process — the cache is in memory, is never persisted, and is never
    /// compared against a key minted by another build — so std's "unstable
    /// across releases" caveat has nothing to bite. A collision would serve
    /// one ruleset's totals to another until that directory's mtime moves or
    /// something invalidates it; over the handful of rulesets alive in a
    /// session, 64 bits is a better trade than storing every pattern list in
    /// every cache entry.
    fn key(&self) -> u64 {
        if self.patterns.is_empty() {
            return NO_EXCLUDES_KEY;
        }
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.root.hash(&mut hasher);
        self.patterns.hash(&mut hasher);
        match hasher.finish() {
            // Nudge only the one value that would alias onto "no exclusions".
            // `| 1` would instead fold every even hash onto its odd
            // neighbour, halving the space for no gain.
            NO_EXCLUDES_KEY => 1,
            other => other,
        }
    }
}

static DIR_STATS_CACHE: OnceLock<DirStatsMap> = OnceLock::new();

fn dir_stats_cache() -> &'static DirStatsMap {
    DIR_STATS_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Recursively compute total size and file count within a directory.
/// Hidden files (starting with '.') are excluded, and so is anything
/// `excludes` matches — pass the drive's patterns wherever the result is
/// shown next to a listing that hides them, or the folder row and the folder
/// view disagree (H-110).
///
/// Memoised by `(path, mtime, excludes)`. On a hit the cached `(size, count)`
/// is returned without descending the tree. A miss walks the tree once on a
/// blocking thread and inserts a cache entry for **every** subdirectory
/// so a later listing of a child does not re-walk.
pub(crate) async fn dir_stats_recursive(path: &Path, excludes: Option<&DirStatsExcludes<'_>>) -> (u64, u64) {
    let excludes_key = excludes.map_or(NO_EXCLUDES_KEY, DirStatsExcludes::key);
    let lookup = (path.to_path_buf(), excludes_key);
    let mtime = match tokio::fs::metadata(path).await {
        Ok(meta) => meta.modified().ok(),
        Err(_) => None,
    };
    if let Some(mtime) = mtime
        && let Ok(cache) = dir_stats_cache().lock()
        && let Some((cached_mtime, size, count)) = cache.get(&lookup)
        && *cached_mtime == mtime
    {
        return (*size, *count);
    }

    let walk_root = path.to_path_buf();
    // Owned copies: the walk runs on a blocking thread and cannot borrow the
    // caller's frame. The rules are compiled there, once per walk.
    let walk_excludes = excludes.map(|e| (e.root.to_path_buf(), e.patterns.to_vec()));
    let Ok(filled) = tokio::task::spawn_blocking(move || {
        let compiled = walk_excludes.map(|(root, patterns)| (root, super::exclude_match::rules_from_patterns(&patterns)));
        let ctx = compiled.as_ref().map(|(root, rules)| WalkExcludes { root, rules });
        dir_stats_walk_std(&walk_root, ctx.as_ref())
    })
    .await
    else {
        return (0, 0);
    };

    let root_stats = filled
        .iter()
        .find(|(p, _, _, _)| p == path)
        .map_or((0, 0), |(_, _, size, count)| (*size, *count));

    if let Ok(mut cache) = dir_stats_cache().lock() {
        for (p, dir_mtime, size, count) in filled {
            cache.insert((p, excludes_key), (dir_mtime, size, count));
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
    // Every ruleset's entry for those paths, not just the one the last walk
    // used: what changed on disk changed the totals under all of them.
    cache.retain(|(path, _), _| path.as_path() != root && !path.starts_with(root));
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
    // Collect the ancestors first so the cache is swept once. Under a
    // two-part key an ancestor could be dropped with a single `remove`; now
    // that a path can hold one entry per ruleset there is no single key to
    // remove, and one `retain` beats one full scan per ancestor.
    let mut ancestors: HashSet<&Path> = HashSet::new();
    let mut ancestor = changed.parent();
    while let Some(path) = ancestor {
        if !path.starts_with(sync_root) {
            break;
        }
        ancestors.insert(path);
        if path == sync_root {
            break;
        }
        ancestor = path.parent();
    }

    let Ok(mut cache) = dir_stats_cache().lock() else {
        return;
    };
    // Every ruleset's entry for those paths: the file that appeared or
    // vanished changed the totals under all of them.
    cache.retain(|(path, _), _| {
        let dropped = path.as_path() == changed || path.starts_with(changed) || ancestors.contains(path.as_path());
        !dropped
    });
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
    use super::{DirStatsEntry, NO_EXCLUDES_KEY, dir_stats_cache};
    use std::path::Path;

    /// True when the path holds an entry under ANY ruleset.
    pub(in crate::sync::fileops::files) fn is_cached(path: &Path) -> bool {
        dir_stats_cache()
            .lock()
            .is_ok_and(|cache| cache.keys().any(|(cached, _)| cached.as_path() == path))
    }

    pub(in crate::sync::fileops::files) fn read(path: &Path) -> Option<DirStatsEntry> {
        read_keyed(path, NO_EXCLUDES_KEY)
    }

    /// The entry a walk under `excludes_key` would hit, so a test can prove
    /// one ruleset's entry survived another ruleset's walk.
    pub(in crate::sync::fileops::files) fn read_keyed(path: &Path, excludes_key: u64) -> Option<DirStatsEntry> {
        dir_stats_cache()
            .lock()
            .ok()
            .and_then(|cache| cache.get(&(path.to_path_buf(), excludes_key)).copied())
    }

    /// Seeds under the "no exclusions" key, matching a
    /// `dir_stats_recursive(path, None)` lookup.
    pub(in crate::sync::fileops::files) fn seed(path: &Path, mtime: std::time::SystemTime, size: u64, count: u64) {
        seed_keyed(path, NO_EXCLUDES_KEY, mtime, size, count);
    }

    pub(in crate::sync::fileops::files) fn seed_keyed(path: &Path, excludes_key: u64, mtime: std::time::SystemTime, size: u64, count: u64) {
        if let Ok(mut cache) = dir_stats_cache().lock() {
            cache.insert((path.to_path_buf(), excludes_key), (mtime, size, count));
        }
    }

    /// Drops every ruleset's entry for each path.
    pub(in crate::sync::fileops::files) fn forget(paths: &[&Path]) {
        if let Ok(mut cache) = dir_stats_cache().lock() {
            cache.retain(|(cached, _), _| !paths.contains(&cached.as_path()));
        }
    }
}

/// Iterative `std::fs` walk. Returns one `(path, mtime, size, count)`
/// per directory visited (including `root`). Hidden names are skipped.
/// A directory with no readable mtime is omitted from the fill list
/// (same "don't cache" rule as the old miss path).
/// Borrowed exclusion context inside the blocking walk.
struct WalkExcludes<'a> {
    root: &'a Path,
    rules: &'a ExcludeRules,
}

impl WalkExcludes<'_> {
    /// Whether the walk should skip `path`. An entry outside `root` cannot be
    /// relativized, so it is kept — the rules describe drive-relative paths and
    /// have nothing to say about anything else.
    fn skips(&self, path: &Path, is_dir: bool) -> bool {
        let Ok(rel) = path.strip_prefix(self.root) else {
            return false;
        };
        // Forward slashes, always: the same string `listing.rs` tags its rows
        // against (`format!("{sub}/{name}")`) and `user_files.rs` walks with.
        // This is belt-and-braces rather than load-bearing — `globset`'s
        // `Candidate::new` rewrites every `is_separator` byte to `/` on
        // non-Unix targets (globset-0.4.18 `src/pathutil.rs::normalize_path`),
        // so a `to_string_lossy()` of the native `Path` would also match on
        // Windows. Building the drive-relative form here anyway keeps the
        // three walks textually identical instead of resting on a
        // dependency's internal normalisation.
        let rel = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
        super::exclude_match::path_is_excluded(self.rules, &rel, is_dir)
    }
}

fn dir_stats_walk_std(root: &Path, excludes: Option<&WalkExcludes<'_>>) -> Vec<(std::path::PathBuf, std::time::SystemTime, u64, u64)> {
    let mut filled = Vec::new();
    walk_dir_std(root, excludes, &mut filled);
    filled
}

fn walk_dir_std(
    path: &Path,
    excludes: Option<&WalkExcludes<'_>>,
    filled: &mut Vec<(std::path::PathBuf, std::time::SystemTime, u64, u64)>,
) -> (u64, u64) {
    let mut size: u64 = 0;
    let mut count: u64 = 0;
    let Ok(dir) = std::fs::read_dir(path) else {
        return (0, 0);
    };
    for entry in dir.flatten() {
        let name = entry.file_name();
        if is_engine_hidden_name(&name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        // Skip what the engine skips (hidden names) and what billing omits
        // (exclude patterns). An excluded directory is pruned whole.

        if let Some(ex) = excludes
            && ex.skips(&entry.path(), meta.is_dir())
        {
            continue;
        }
        if meta.is_dir() {
            let (sub_size, sub_count) = walk_dir_std(&entry.path(), excludes, filled);
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
    use super::test_access::{forget, is_cached, read, read_keyed, seed, seed_keyed};
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

        let (size, count) = dir_stats_recursive(dir, None).await;
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

        let (size, count) = dir_stats_recursive(dir, None).await;
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

        let (size, count) = dir_stats_recursive(root, None).await;
        assert_eq!(size, 3);
        assert_eq!(count, 1);

        let sub_mtime = std::fs::metadata(&sub).expect("meta").modified().expect("mtime");
        assert_eq!(read(&sub), Some((sub_mtime, 3, 1)), "child must be cached by the parent walk");

        // Prove the child entry is consulted: plant a bogus value under the
        // real mtime and re-query the child — must not re-walk.
        seed(&sub, sub_mtime, 42, 7);
        let (size, count) = dir_stats_recursive(&sub, None).await;
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

        let (size, count) = dir_stats_recursive(root, None).await;
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

        let (size, count) = dir_stats_recursive(root, None).await;
        assert_eq!((size, count), (9, 1));

        std::fs::remove_file(&file).expect("delete nested file");

        // Re-seed under the POST-delete mtimes so a filesystem that happens
        // to bump root mtime cannot make this pass via a cache miss. The
        // production bug is that Unix does *not* bump that mtime.
        let root_mtime = std::fs::metadata(root).expect("meta").modified().expect("mtime");
        let sub_mtime = std::fs::metadata(&sub).expect("meta").modified().expect("mtime");
        seed(root, root_mtime, 9, 1);
        seed(&sub, sub_mtime, 9, 1);

        let (size, count) = dir_stats_recursive(root, None).await;
        assert_eq!((size, count), (9, 1), "seeded cache must be consulted before invalidation");

        invalidate_dir_stats_for_change(root, &file);

        let (size, count) = dir_stats_recursive(root, None).await;
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

        let (size, count) = dir_stats_recursive(root, None).await;
        assert_eq!((size, count), (5, 1));

        let added = sub.join("b.txt");
        std::fs::write(&added, b"6789").expect("write 4 bytes");

        // Re-seed root under its CURRENT mtime: on Unix the add did not
        // stamp it, so this is what production holds after the upload.
        let root_mtime = std::fs::metadata(root).expect("meta").modified().expect("mtime");
        seed(root, root_mtime, 5, 1);

        let (size, count) = dir_stats_recursive(root, None).await;
        assert_eq!((size, count), (5, 1), "seeded cache must be consulted before invalidation");

        invalidate_dir_stats_for_change(root, &added);

        let (size, count) = dir_stats_recursive(root, None).await;
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

    /// H-110. The folder ROW's totals come from this walk while the folder
    /// VIEW hides excluded rows, so a walk that ignores the patterns reports
    /// "3 files" over a listing showing 1.
    #[tokio::test]
    async fn the_walk_skips_what_the_patterns_exclude() {
        let _cache_guard = CACHE_TEST_LOCK.lock().await;
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let root = tmp.path();
        std::fs::write(root.join("keep.txt"), b"12345").expect("write keep");
        std::fs::write(root.join("blob.bin"), b"0123456789").expect("write blob");

        let patterns = vec!["*.bin".to_string()];
        let excludes = DirStatsExcludes { root, patterns: &patterns };
        assert_eq!(
            dir_stats_recursive(root, Some(&excludes)).await,
            (5, 1),
            "an excluded file must not be counted in the folder row"
        );

        assert_eq!(
            dir_stats_recursive(root, None).await,
            (15, 2),
            "without patterns the same directory still counts everything"
        );
    }

    /// A nested pattern must match the same string `listing.rs` tags rows
    /// against — `format!("{sub}/{name}")`, forward slashes on every platform.
    /// Handing the rules a `Path`'s native form instead leaves this passing on
    /// Unix and failing on Windows, where the row and its own totals would
    /// then disagree.
    #[tokio::test]
    async fn a_nested_pattern_matches_the_listing_form_of_the_path() {
        let _cache_guard = CACHE_TEST_LOCK.lock().await;
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let root = tmp.path();
        let docs = root.join("docs");
        std::fs::create_dir(&docs).expect("mkdir docs");
        std::fs::write(docs.join("a.pdf"), b"12345678").expect("write pdf");
        std::fs::write(docs.join("b.txt"), b"123").expect("write txt");

        let patterns = vec!["docs/*.pdf".to_string()];
        let excludes = DirStatsExcludes { root, patterns: &patterns };
        assert_eq!(
            dir_stats_recursive(root, Some(&excludes)).await,
            (3, 1),
            "a slash-bearing pattern must match the nested file the listing hides"
        );
    }

    /// A directory pattern prunes the subtree, matching the engine: the
    /// contents of an excluded folder are excluded too.
    #[tokio::test]
    async fn a_directory_pattern_prunes_the_whole_subtree() {
        let _cache_guard = CACHE_TEST_LOCK.lock().await;
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let root = tmp.path();
        let build = root.join("build");
        std::fs::create_dir(&build).expect("mkdir build");
        std::fs::write(build.join("out.o"), b"12345678").expect("write out");
        std::fs::write(root.join("keep.txt"), b"123").expect("write keep");

        let patterns = vec!["build/".to_string()];
        let excludes = DirStatsExcludes { root, patterns: &patterns };
        assert_eq!(
            dir_stats_recursive(root, Some(&excludes)).await,
            (3, 1),
            "an excluded directory contributes neither its size nor its file count"
        );
    }

    /// The production shape: the listing walks a CHILD folder while the
    /// patterns stay drive-relative, so `excludes.root` is the drive and the
    /// walked directory is somewhere under it. Relativizing against the
    /// walked directory instead leaves every same-root test above passing
    /// while any pattern naming a folder silently stops matching — H-110
    /// again, one level down.
    #[tokio::test]
    async fn a_child_walk_relativizes_against_the_drive_root_not_the_walked_folder() {
        let _cache_guard = CACHE_TEST_LOCK.lock().await;
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let root = tmp.path();
        let docs = root.join("docs");
        std::fs::create_dir(&docs).expect("mkdir docs");
        std::fs::write(docs.join("a.pdf"), b"12345678").expect("write pdf");
        std::fs::write(docs.join("b.txt"), b"123").expect("write txt");

        let patterns = vec!["docs/*.pdf".to_string()];
        let excludes = DirStatsExcludes { root, patterns: &patterns };
        let stats = dir_stats_recursive(&docs, Some(&excludes)).await;
        forget(&[root, &docs]);

        assert_eq!(stats, (3, 1), "a nested walk must match on the path the listing tagged the row with");
    }

    /// The billing lag probe walks the same drive roots with no rules at all
    /// (`storage_overview::local_bytes_for_paths`). One entry per path would
    /// let the two callers overwrite each other on every refresh, so every
    /// listing would re-walk the drive the memo exists to spare it.
    #[tokio::test]
    async fn a_rule_less_walk_leaves_the_listings_entry_in_place() {
        let _cache_guard = CACHE_TEST_LOCK.lock().await;
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let root = tmp.path();
        std::fs::write(root.join("keep.txt"), b"12345").expect("write keep");
        std::fs::write(root.join("blob.bin"), b"0123456789").expect("write blob");

        let patterns = vec!["*.bin".to_string()];
        let excludes = DirStatsExcludes { root, patterns: &patterns };
        assert_eq!(dir_stats_recursive(root, Some(&excludes)).await, (5, 1), "warm the listing's entry");

        // Sentinel under the listing's ruleset: getting it back after the
        // rule-less walk proves the entry was never evicted or re-walked.
        let mtime = std::fs::metadata(root).expect("meta").modified().expect("mtime");
        seed_keyed(root, excludes.key(), mtime, 42, 7);

        let rule_less = dir_stats_recursive(root, None).await;
        let patterned = dir_stats_recursive(root, Some(&excludes)).await;
        forget(&[root]);

        assert_eq!(rule_less, (15, 2), "the rule-less caller gets its own totals, not the listing's");
        assert_eq!(patterned, (42, 7), "and must not have evicted the listing's entry to get them");
    }

    /// A file appearing or vanishing changes the totals under every ruleset,
    /// so invalidation cannot drop only the one the last walk happened to
    /// use — the others would keep serving pre-mutation numbers.
    #[test]
    fn change_invalidation_drops_every_ruleset_for_the_affected_paths() {
        let _cache_guard = CACHE_TEST_LOCK.blocking_lock();
        let sync_root = PathBuf::from("/rulesets/drive");
        let sub = sync_root.join("sub");
        let now = std::time::SystemTime::now();
        let other_ruleset = 7u64;
        seed(&sync_root, now, 1, 1);
        seed_keyed(&sync_root, other_ruleset, now, 2, 2);
        seed(&sub, now, 3, 3);
        seed_keyed(&sub, other_ruleset, now, 4, 4);

        invalidate_dir_stats_for_change(&sync_root, &sub.join("a.txt"));
        let leftovers = [
            read(&sync_root),
            read_keyed(&sync_root, other_ruleset),
            read(&sub),
            read_keyed(&sub, other_ruleset),
        ];

        assert_eq!(
            leftovers,
            [None, None, None, None],
            "a mutation retires the directory under every ruleset"
        );
    }

    /// Editing `.hippius/exclude` changes no directory's mtime, so the
    /// ruleset has to be part of the cache key or the listing serves the
    /// previous ruleset's totals for the rest of the session.
    #[tokio::test]
    async fn changing_the_patterns_does_not_serve_the_previous_totals() {
        let _cache_guard = CACHE_TEST_LOCK.lock().await;
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let root = tmp.path();
        std::fs::write(root.join("keep.txt"), b"12345").expect("write keep");
        std::fs::write(root.join("blob.bin"), b"0123456789").expect("write blob");

        let excluded = vec!["*.bin".to_string()];
        let warm = DirStatsExcludes { root, patterns: &excluded };
        assert_eq!(dir_stats_recursive(root, Some(&warm)).await, (5, 1), "warm the cache under *.bin");

        // The user clears the pattern. Nothing on disk moved.
        let cleared: Vec<String> = Vec::new();
        let after = DirStatsExcludes { root, patterns: &cleared };
        assert_eq!(
            dir_stats_recursive(root, Some(&after)).await,
            (15, 2),
            "clearing the pattern must re-walk, not reuse the *.bin totals"
        );
    }
}
