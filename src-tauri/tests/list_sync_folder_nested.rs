//! Regression tests for `list_sync_folder_grouped` — the fix for "subfolder
//! shows empty / console listing is flat" on multi-level folder uploads.
//!
//! What these guard:
//!
//! 1. **On-disk grouping** — when every file is present locally, the grouped
//!    listing returns subfolders as folders and direct children as files at
//!    each level, partitioned correctly.
//! 2. **Server-only overlay** — rel-paths the server knows about but the local
//!    device hasn't downloaded yet (the fresh-device / in-flight-download
//!    case the user actually reported) surface in the grouped listing with
//!    `sync_status="pending"`, so the FE doesn't render the subfolder as
//!    empty.
//! 3. **Dedup across disk + cache** — a file present both on disk and in the
//!    server cache appears exactly once. Without dedup, folders with on-disk
//!    descendants would double up as "synced" (from disk) and "pending"
//!    (from cache).
//! 4. **Prefix boundary** — the subfolder filter matches `prefix + "/"` and
//!    does NOT match sibling directories with the same prefix string
//!    ("docs" vs "docs2").
//! 5. **`pending_backfill` flag** — reads from
//!    `sync_paths.relative_paths_backfilled_at`. NULL → true (FE shows the
//!    indexing banner), non-NULL → false.
//! 6. **Missing subfolder directory** — on a device that hasn't downloaded
//!    a nested subtree yet, `list_sync_folder` returns `Vec::new()` for
//!    `!target.exists()`. The grouped listing overlays the server cache so
//!    the user still sees the structure.

use std::collections::HashMap;
use std::sync::Arc;

use hcfs_client::engine::types::SyncedFileInfo;
use sqlx::sqlite::SqlitePool;

use tauri_project_lib::app_state::AppState;
use tauri_project_lib::auth::state::AuthCapabilities;
use tauri_project_lib::sync::files::list_sync_folder_grouped_inner;

const ACCOUNT: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const LABEL: &str = "my-drive";

fn account_owner(account_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(account_id.as_bytes());
    hex::encode(&hasher.finalize()[..8])
}

async fn make_pool() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.expect("open pool");
    sqlx::query(
        "CREATE TABLE sync_paths (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL,
            path TEXT NOT NULL,
            type TEXT NOT NULL,
            label TEXT NOT NULL,
            timestamp INTEGER,
            is_paused INTEGER NOT NULL DEFAULT 0,
            relative_paths_backfilled_at INTEGER,
            UNIQUE(owner, label)
        )",
    )
    .execute(&pool)
    .await
    .expect("create sync_paths");
    // Mirror the production `folder_entries_local` schema (utils/schema.rs):
    // this device's cache of registered directories, including empty ones the
    // rel-path index can't represent. Composite PK = owner + label + path.
    sqlx::query(
        "CREATE TABLE folder_entries_local (
            owner         TEXT NOT NULL,
            label         TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            PRIMARY KEY (owner, label, relative_path)
        )",
    )
    .execute(&pool)
    .await
    .expect("create folder_entries_local");
    pool
}

/// Insert a `folder_entries_local` cache row for the default account/label.
async fn insert_folder_entry(pool: &SqlitePool, relative_path: &str) {
    insert_folder_entry_for_owner(pool, &account_owner(ACCOUNT), relative_path).await;
}

/// Insert a `folder_entries_local` cache row scoped to an explicit `owner` —
/// used to prove another account's registered folders never leak into this
/// account's listing.
async fn insert_folder_entry_for_owner(pool: &SqlitePool, owner: &str, relative_path: &str) {
    sqlx::query("INSERT INTO folder_entries_local (owner, label, relative_path) VALUES (?, ?, ?)")
        .bind(owner)
        .bind(LABEL)
        .bind(relative_path)
        .execute(pool)
        .await
        .expect("insert folder_entries_local");
}

async fn insert_sync_path(pool: &SqlitePool, path: &str, backfilled_at: Option<i64>) {
    sqlx::query(
        "INSERT INTO sync_paths (owner, path, type, label, timestamp, relative_paths_backfilled_at)
         VALUES (?, ?, 'private', ?, 0, ?)",
    )
    .bind(account_owner(ACCOUNT))
    .bind(path)
    .bind(LABEL)
    .bind(backfilled_at)
    .execute(pool)
    .await
    .expect("insert sync_path");
}

fn make_state(pool: SqlitePool) -> AppState {
    let s = AppState::new();
    s.set_pool(pool);
    s.set_active_account(ACCOUNT, AuthCapabilities::default()).expect("set account");
    s
}

/// Fake `SyncedFileInfo` builder — tests don't care about the hash/CID values,
/// only that the grouping logic partitions rel-paths correctly.
fn fake_info(tag: u8) -> SyncedFileInfo {
    SyncedFileInfo {
        path_hash: [tag; 32],
        arion_cid: Arc::from(format!("cid-{tag}")),
        uploaded_at: 0,
        updated_at: 0,
    }
}

fn seed_cache(state: &AppState, entries: &[&str]) {
    let mut map: HashMap<String, SyncedFileInfo> = HashMap::new();
    for (i, rel) in entries.iter().enumerate() {
        // Cast `i` to u8 — test fixtures use tiny sets so this never overflows.
        // Overflow would break nothing (fake_info bytes are opaque) but the
        // clippy lint fires on the truncation anyway.
        map.insert((*rel).to_string(), fake_info(u8::try_from(i).unwrap_or(u8::MAX)));
    }
    state.sync.update_synced_paths_cache(LABEL, map);
}

fn write_file(dir: &std::path::Path, rel: &str) {
    let path = dir.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("mkdir");
    }
    std::fs::write(&path, b"x").expect("write");
}

#[tokio::test]
async fn groups_disk_entries_by_level() {
    let tmp = tempfile::tempdir().unwrap();
    // Tree: a.txt, sub1/b.txt, sub1/sub2/c.txt
    write_file(tmp.path(), "a.txt");
    write_file(tmp.path(), "sub1/b.txt");
    write_file(tmp.path(), "sub1/sub2/c.txt");

    let pool = make_pool().await;
    insert_sync_path(&pool, &tmp.path().to_string_lossy(), Some(1_700_000_000)).await;
    let state = make_state(pool);
    seed_cache(&state, &["a.txt", "sub1/b.txt", "sub1/sub2/c.txt"]);

    // Root: folders=[sub1], files=[a.txt]
    let root = list_sync_folder_grouped_inner(&state, ACCOUNT.into(), tmp.path().to_string_lossy().into(), None, Some(LABEL.into()))
        .await
        .expect("root listing");
    assert_eq!(
        root.folders.len(),
        1,
        "root folders: {:?}",
        root.folders.iter().map(|f| &f.name).collect::<Vec<_>>()
    );
    assert_eq!(root.folders[0].name, "sub1");
    assert_eq!(root.files.len(), 1, "root files");
    assert_eq!(root.files[0].name, "a.txt");
    // Backfill done → banner stays hidden.
    assert!(!root.pending_backfill, "backfill should be completed");

    // sub1: folders=[sub2], files=[b.txt]
    let sub1 = list_sync_folder_grouped_inner(
        &state,
        ACCOUNT.into(),
        tmp.path().to_string_lossy().into(),
        Some("sub1".into()),
        Some(LABEL.into()),
    )
    .await
    .expect("sub1 listing");
    assert_eq!(sub1.folders.len(), 1);
    assert_eq!(sub1.folders[0].name, "sub2");
    assert_eq!(sub1.files.len(), 1);
    assert_eq!(sub1.files[0].name, "b.txt");

    // sub1/sub2: folders=[], files=[c.txt]
    let sub2 = list_sync_folder_grouped_inner(
        &state,
        ACCOUNT.into(),
        tmp.path().to_string_lossy().into(),
        Some("sub1/sub2".into()),
        Some(LABEL.into()),
    )
    .await
    .expect("sub2 listing");
    assert!(sub2.folders.is_empty());
    assert_eq!(sub2.files.len(), 1);
    assert_eq!(sub2.files[0].name, "c.txt");
}

#[tokio::test]
async fn server_only_entries_surface_when_disk_is_empty() {
    // Reproduces the reported bug: sync is in-flight, subfolder directory
    // doesn't exist locally yet, but the server-side index already knows the
    // files. The on-disk `list_sync_folder` would return empty; the grouped
    // listing must overlay the cache so the FE doesn't show an empty
    // folder.
    let tmp = tempfile::tempdir().unwrap();

    let pool = make_pool().await;
    insert_sync_path(&pool, &tmp.path().to_string_lossy(), Some(1_700_000_000)).await;
    let state = make_state(pool);
    // Server knows 3 files nested under sub1, none are on disk.
    seed_cache(&state, &["root.txt", "sub1/a.txt", "sub1/b.txt", "sub1/nested/c.txt"]);

    let root = list_sync_folder_grouped_inner(&state, ACCOUNT.into(), tmp.path().to_string_lossy().into(), None, Some(LABEL.into()))
        .await
        .expect("root listing");

    let folder_names: Vec<&str> = root.folders.iter().map(|f| f.name.as_str()).collect();
    assert!(folder_names.contains(&"sub1"), "sub1 should be visible server-side; got {folder_names:?}");
    let sub1 = root.folders.iter().find(|f| f.name == "sub1").expect("sub1");
    assert_eq!(sub1.sync_status, "pending", "server-only folder must flag as pending");
    // Aggregated count at this level: everything nested under "sub1/".
    assert_eq!(sub1.file_count, 3, "server-only folder should count all nested rel-paths");

    let file_names: Vec<&str> = root.files.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(file_names, vec!["root.txt"]);
    assert_eq!(root.files[0].sync_status, "pending");

    // Drilling into the (non-existent) sub1 directory still shows the two
    // direct children + one nested folder from the cache.
    let sub = list_sync_folder_grouped_inner(
        &state,
        ACCOUNT.into(),
        tmp.path().to_string_lossy().into(),
        Some("sub1".into()),
        Some(LABEL.into()),
    )
    .await
    .expect("sub1 listing");
    let folder_names: Vec<&str> = sub.folders.iter().map(|f| f.name.as_str()).collect();
    let file_names: Vec<&str> = sub.files.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(folder_names, vec!["nested"]);
    let mut file_names_sorted = file_names.clone();
    file_names_sorted.sort_unstable();
    assert_eq!(file_names_sorted, vec!["a.txt", "b.txt"]);
}

#[tokio::test]
async fn dedupes_entries_present_on_disk_and_in_cache() {
    // On-disk and in-cache overlap should not double-up. The on-disk entry
    // wins (its file_count/size comes from the local tree); the cache is
    // only used to fill in what's missing locally.
    let tmp = tempfile::tempdir().unwrap();
    write_file(tmp.path(), "a.txt");
    write_file(tmp.path(), "sub1/b.txt");

    let pool = make_pool().await;
    insert_sync_path(&pool, &tmp.path().to_string_lossy(), Some(1_700_000_000)).await;
    let state = make_state(pool);
    seed_cache(&state, &["a.txt", "sub1/b.txt"]);

    let root = list_sync_folder_grouped_inner(&state, ACCOUNT.into(), tmp.path().to_string_lossy().into(), None, Some(LABEL.into()))
        .await
        .expect("root listing");

    let folder_names: Vec<&str> = root.folders.iter().map(|f| f.name.as_str()).collect();
    let file_names: Vec<&str> = root.files.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(folder_names, vec!["sub1"]);
    assert_eq!(file_names, vec!["a.txt"]);
}

#[tokio::test]
async fn subfolder_prefix_is_boundary_safe() {
    // "docs" prefix must not match "docs2" siblings. Without `+ "/"`
    // normalisation this would lift "docs2/x.txt" into the "docs" listing.
    let tmp = tempfile::tempdir().unwrap();

    let pool = make_pool().await;
    insert_sync_path(&pool, &tmp.path().to_string_lossy(), Some(1_700_000_000)).await;
    let state = make_state(pool);
    seed_cache(&state, &["docs/in.txt", "docs2/out.txt"]);

    let docs = list_sync_folder_grouped_inner(
        &state,
        ACCOUNT.into(),
        tmp.path().to_string_lossy().into(),
        Some("docs".into()),
        Some(LABEL.into()),
    )
    .await
    .expect("docs listing");

    let file_names: Vec<&str> = docs.files.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(file_names, vec!["in.txt"], "docs2 must NOT leak into docs");
}

#[tokio::test]
async fn registered_empty_folder_surfaces_from_cache_overlay() {
    // The first-class-empty-folders core: a directory registered as a folder
    // entity (folder_entries_local row) but with NO file under it and NOT
    // materialized on this device's disk. The rel-path index can't represent
    // it (no file → no path_hash), so without the cache overlay it is invisible
    // here even though the server (and the web console) show it. The overlay
    // surfaces it as `pending` (registered elsewhere / not downloaded).
    let tmp = tempfile::tempdir().unwrap();

    let pool = make_pool().await;
    insert_sync_path(&pool, &tmp.path().to_string_lossy(), Some(1_700_000_000)).await;
    let state = make_state(pool.clone());
    // No files seeded, no on-disk dir — only the folder-entity cache row.
    insert_folder_entry(&pool, "Empty").await;

    let root = list_sync_folder_grouped_inner(&state, ACCOUNT.into(), tmp.path().to_string_lossy().into(), None, Some(LABEL.into()))
        .await
        .expect("root listing");

    let empty = root.folders.iter().find(|f| f.name == "Empty").unwrap_or_else(|| {
        panic!(
            "Empty folder must surface from cache; got {:?}",
            root.folders.iter().map(|f| &f.name).collect::<Vec<_>>()
        )
    });
    assert!(empty.is_folder, "cache overlay entry must be a folder");
    assert_eq!(empty.sync_status, "pending", "a registered folder not on local disk is pending");
    assert!(root.files.is_empty(), "overlay must not touch the files list");
}

#[tokio::test]
async fn on_disk_empty_folder_with_cache_entry_appears_once() {
    // Dedup: an empty directory present BOTH on disk and in the folder-entity
    // cache must appear exactly once — the on-disk entry wins (`synced`), the
    // cache overlay must not double it.
    let tmp = tempfile::tempdir().unwrap();
    std::fs::create_dir(tmp.path().join("Empty")).expect("mkdir Empty");

    let pool = make_pool().await;
    insert_sync_path(&pool, &tmp.path().to_string_lossy(), Some(1_700_000_000)).await;
    let state = make_state(pool.clone());
    insert_folder_entry(&pool, "Empty").await;

    let root = list_sync_folder_grouped_inner(&state, ACCOUNT.into(), tmp.path().to_string_lossy().into(), None, Some(LABEL.into()))
        .await
        .expect("root listing");

    let matches: Vec<&str> = root
        .folders
        .iter()
        .filter(|f| f.name == "Empty")
        .map(|f| f.sync_status.as_str())
        .collect();
    assert_eq!(
        matches,
        vec!["synced"],
        "on-disk empty folder must appear exactly once as synced (deduped against the cache overlay)"
    );
}

#[tokio::test]
async fn server_file_parent_folder_with_cache_entry_appears_once() {
    // Dedup on the OTHER axis: a folder that exists only because the rel-path
    // index has a server-only file under it (NOT on local disk, so it's NOT in
    // the disk-seeded `seen_names`) AND also has a folder_entries_local row.
    // The server-only-folder push (with its real nested file_count) must win;
    // the cache overlay must NOT add a second pending(0) row for the same name.
    let tmp = tempfile::tempdir().unwrap();

    let pool = make_pool().await;
    insert_sync_path(&pool, &tmp.path().to_string_lossy(), Some(1_700_000_000)).await;
    let state = make_state(pool.clone());
    // Server knows one file under "Reports/"; nothing is on disk.
    seed_cache(&state, &["Reports/q1.txt"]);
    // The same folder is also registered in the folder-entity cache.
    insert_folder_entry(&pool, "Reports").await;

    let root = list_sync_folder_grouped_inner(&state, ACCOUNT.into(), tmp.path().to_string_lossy().into(), None, Some(LABEL.into()))
        .await
        .expect("root listing");

    let reports: Vec<&_> = root.folders.iter().filter(|f| f.name == "Reports").collect();
    assert_eq!(
        reports.len(),
        1,
        "Reports must appear exactly once (server-only-folder push wins, not a duplicate cache row); got {:?}",
        root.folders.iter().map(|f| (&f.name, f.file_count)).collect::<Vec<_>>()
    );
    // The surviving row is the file-derived one: pending, with the real nested
    // count — proving the cache row didn't clobber it with a pending(0) dup.
    assert_eq!(reports[0].sync_status, "pending");
    assert_eq!(reports[0].file_count, 1, "file-derived nested count must survive, not a cache pending(0)");
}

#[tokio::test]
async fn cache_overlay_is_owner_scoped() {
    // Another account's registered folder must never leak into this account's
    // listing — the overlay SELECT is scoped to account_key(account_id).
    let tmp = tempfile::tempdir().unwrap();

    let pool = make_pool().await;
    insert_sync_path(&pool, &tmp.path().to_string_lossy(), Some(1_700_000_000)).await;
    let state = make_state(pool.clone());
    insert_folder_entry_for_owner(&pool, "some-other-account-owner-hash", "Secret").await;

    let root = list_sync_folder_grouped_inner(&state, ACCOUNT.into(), tmp.path().to_string_lossy().into(), None, Some(LABEL.into()))
        .await
        .expect("root listing");

    let names: Vec<&str> = root.folders.iter().map(|f| f.name.as_str()).collect();
    assert!(!names.contains(&"Secret"), "another owner's folder leaked: {names:?}");
}

#[tokio::test]
async fn pending_backfill_flag_reflects_db_state() {
    let tmp = tempfile::tempdir().unwrap();
    write_file(tmp.path(), "a.txt");

    let pool = make_pool().await;
    // NULL timestamp → backfill still pending.
    insert_sync_path(&pool, &tmp.path().to_string_lossy(), None).await;
    let state = make_state(pool);

    let listing = list_sync_folder_grouped_inner(&state, ACCOUNT.into(), tmp.path().to_string_lossy().into(), None, Some(LABEL.into()))
        .await
        .expect("listing");

    assert!(listing.pending_backfill, "NULL column → FE banner should show");
}

/// Register a real `DriveManager` for `LABEL` whose config directory carries
/// an `exclude` file with `patterns`.
///
/// The listing reads exclude rules off the drive manager, so a fixture that
/// only seeds the synced-paths cache can never exercise them. Config dir is
/// `<sync-root>/.hippius` to match production — the listing skips `.`-prefixed
/// names, so the config directory does not show up as a folder.
async fn register_drive_with_excludes(state: &AppState, sync_root: &std::path::Path, patterns: &str) {
    use hcfs_client::engine::manager::DriveManager;
    use hcfs_client::engine::runner::DriveSlot;
    use tokio::sync::Mutex as TokioMutex;
    use tokio_util::sync::CancellationToken;

    let config_dir = sync_root.join(".hippius");
    std::fs::create_dir_all(&config_dir).expect("config dir");
    std::fs::write(config_dir.join("exclude"), patterns).expect("write exclude file");

    let manager = DriveManager::new(sync_root.to_path_buf(), config_dir);
    let mut guard = state.sync.drives.lock().await;
    guard.insert(
        LABEL.to_string(),
        DriveSlot {
            manager: Arc::new(TokioMutex::new(manager)),
            cancel_token: CancellationToken::new(),
            sync_path: sync_root.to_path_buf(),
        },
    );
}

/// H-069: a user-typed `*.bin` must match via ExcludeRules, not `==`.
/// H-045: matching *files* stay listed as `excluded`; matching *folders*
/// stay off Drive. Every source that feeds a row has to agree.
#[tokio::test]
async fn excluded_globs_are_hidden_from_every_source_the_grouped_listing_merges() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    // On disk: an excluded file at the root and nested, a near-miss that must
    // survive, an excluded directory with contents, and ordinary files.
    write_file(root, "notes.txt");
    write_file(root, "dump.bin");
    write_file(root, "dump.bin.bak");
    write_file(root, "sub/inner.bin");
    write_file(root, "sub/inner.txt");
    write_file(root, "node_modules/pkg/index.js");

    let pool = make_pool().await;
    insert_sync_path(&pool, &root.to_string_lossy(), Some(1_700_000_000)).await;
    let state = make_state(pool.clone());
    register_drive_with_excludes(&state, root, "*.bin\nnode_modules/\n").await;

    // Server-only sources: a root-level excluded file, an excluded file under
    // an otherwise legitimate folder, and a whole excluded tree that exists
    // nowhere on this device.
    seed_cache(
        &state,
        &[
            "notes.txt",
            "server-only.bin",
            "remote/keep.txt",
            "remote/drop.bin",
            "vendor/node_modules/lib/a.js",
        ],
    );
    // Cache-only folder rows: an excluded folder registered on another device
    // (never materialised here) alongside a legitimate one.
    insert_folder_entry(&pool, "node_modules").await;
    insert_folder_entry(&pool, "Reports").await;

    let root_listing = list_sync_folder_grouped_inner(&state, ACCOUNT.into(), root.to_string_lossy().into(), None, Some(LABEL.into()))
        .await
        .expect("root listing");

    let file_names: Vec<&str> = root_listing.files.iter().map(|f| f.name.as_str()).collect();
    let folder_names: Vec<&str> = root_listing.folders.iter().map(|f| f.name.as_str()).collect();

    assert!(
        file_names.contains(&"dump.bin"),
        "on-disk *.bin must stay visible as excluded: {file_names:?}"
    );
    assert_eq!(
        root_listing.files.iter().find(|f| f.name == "dump.bin").map(|f| f.sync_status.as_str()),
        Some("excluded"),
    );
    assert!(
        file_names.contains(&"server-only.bin"),
        "server-only *.bin must stay visible as excluded: {file_names:?}"
    );
    assert_eq!(
        root_listing
            .files
            .iter()
            .find(|f| f.name == "server-only.bin")
            .map(|f| f.sync_status.as_str()),
        Some("excluded"),
    );
    assert!(file_names.contains(&"notes.txt"), "unmatched files must stay: {file_names:?}");
    assert!(
        file_names.contains(&"dump.bin.bak"),
        "*.bin is an extension match, not a substring: {file_names:?}"
    );

    assert!(
        !folder_names.contains(&"node_modules"),
        "an excluded directory must not come back from disk or the folder-entity cache: {folder_names:?}"
    );
    assert!(folder_names.contains(&"sub"), "unmatched folders must stay: {folder_names:?}");
    assert!(folder_names.contains(&"Reports"), "the cache overlay must still work: {folder_names:?}");
    assert!(
        folder_names.contains(&"remote"),
        "a server-only folder with surviving children must stay: {folder_names:?}"
    );
    assert!(
        !folder_names.contains(&"vendor"),
        "a server-only folder whose every child is excluded must not appear: {folder_names:?}"
    );

    // Drilling in: the same rules apply one level down, from both sources.
    let sub = list_sync_folder_grouped_inner(
        &state,
        ACCOUNT.into(),
        root.to_string_lossy().into(),
        Some("sub".into()),
        Some(LABEL.into()),
    )
    .await
    .expect("sub listing");
    let sub_files: Vec<&str> = sub.files.iter().map(|f| f.name.as_str()).collect();
    assert!(sub_files.contains(&"inner.txt"), "unmatched nested file stays: {sub_files:?}");
    assert!(sub_files.contains(&"inner.bin"), "nested *.bin stays as excluded: {sub_files:?}");
    assert_eq!(
        sub.files.iter().find(|f| f.name == "inner.bin").map(|f| f.sync_status.as_str()),
        Some("excluded"),
    );

    let remote = list_sync_folder_grouped_inner(
        &state,
        ACCOUNT.into(),
        root.to_string_lossy().into(),
        Some("remote".into()),
        Some(LABEL.into()),
    )
    .await
    .expect("remote listing");
    let remote_files: Vec<&str> = remote.files.iter().map(|f| f.name.as_str()).collect();
    assert!(remote_files.contains(&"keep.txt"), "unmatched server-only file stays: {remote_files:?}");
    assert!(
        remote_files.contains(&"drop.bin"),
        "server-only excluded file stays as excluded: {remote_files:?}"
    );
    assert_eq!(
        remote.files.iter().find(|f| f.name == "drop.bin").map(|f| f.sync_status.as_str()),
        Some("excluded"),
    );
}

/// Clearing the pattern must bring the files straight back. The listing
/// re-reads `.hippius/exclude` on every call rather than holding a compiled
/// set, which is what lets `remove_exclude_pattern` plus a refresh be enough —
/// a cached ruleset here would leave the file hidden until restart.
#[tokio::test]
async fn clearing_the_pattern_restores_the_hidden_files() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_file(root, "dump.bin");
    write_file(root, "notes.txt");

    let pool = make_pool().await;
    insert_sync_path(&pool, &root.to_string_lossy(), Some(1_700_000_000)).await;
    let state = make_state(pool);
    register_drive_with_excludes(&state, root, "*.bin\n").await;
    seed_cache(&state, &["dump.bin", "notes.txt"]);

    let hidden = list_sync_folder_grouped_inner(&state, ACCOUNT.into(), root.to_string_lossy().into(), None, Some(LABEL.into()))
        .await
        .expect("listing with the rule");
    let with_rule: Vec<&str> = hidden.files.iter().map(|f| f.name.as_str()).collect();
    assert!(with_rule.contains(&"dump.bin"), "excluded file stays listed: {with_rule:?}");
    assert_eq!(
        hidden.files.iter().find(|f| f.name == "dump.bin").map(|f| f.sync_status.as_str()),
        Some("excluded"),
    );

    std::fs::write(root.join(".hippius").join("exclude"), "").expect("clear exclude file");

    let restored = list_sync_folder_grouped_inner(&state, ACCOUNT.into(), root.to_string_lossy().into(), None, Some(LABEL.into()))
        .await
        .expect("listing after clearing");
    let names: Vec<&str> = restored.files.iter().map(|f| f.name.as_str()).collect();
    assert!(names.contains(&"dump.bin"), "clearing the pattern must restore the file: {names:?}");
    assert_ne!(
        restored.files.iter().find(|f| f.name == "dump.bin").map(|f| f.sync_status.as_str()),
        Some("excluded"),
        "clearing the pattern must drop the excluded status",
    );
    assert!(names.contains(&"notes.txt"), "{names:?}");
}

/// H-063: UTF-8 hidden names (`.env.qa`, `.hidden`) stay off Drive because
/// the engine never uploads them. Listing one would pin it Pending forever.
/// File No matches the visible rows (H-082), not disk.
///
/// A skip toast is frontend — this test pins the backend contract: omit,
/// do not list-as-pending.
#[tokio::test]
async fn hidden_dotfiles_are_omitted_not_listed_pending() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_file(root, "keep.txt");
    write_file(root, ".env.qa");
    write_file(root, ".hidden");
    std::fs::create_dir(root.join(".hidden_dir")).expect("mkdir .hidden_dir");
    write_file(root, ".hidden_dir/inside.txt");

    let pool = make_pool().await;
    insert_sync_path(&pool, &root.to_string_lossy(), Some(1_700_000_000)).await;
    let state = make_state(pool);
    // Seed hidden names in the rel-path index too: the disk walk skips
    // them, so without an overlay skip they would reappear as Pending.
    seed_cache(&state, &["keep.txt", ".env.qa", ".hidden", ".hidden_dir/inside.txt"]);

    let listing = list_sync_folder_grouped_inner(&state, ACCOUNT.into(), root.to_string_lossy().into(), None, Some(LABEL.into()))
        .await
        .expect("listing");

    let file_names: Vec<&str> = listing.files.iter().map(|f| f.name.as_str()).collect();
    let folder_names: Vec<&str> = listing.folders.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(file_names, vec!["keep.txt"], "hidden files must not appear: {file_names:?}");
    assert!(
        folder_names.iter().all(|n| !n.starts_with('.')),
        "hidden folders must not appear: {folder_names:?}"
    );
    assert!(
        listing.files.iter().chain(listing.folders.iter()).all(|e| !e.name.starts_with('.')),
        "overlay must not resurrect a hidden rel-path as pending"
    );
}
