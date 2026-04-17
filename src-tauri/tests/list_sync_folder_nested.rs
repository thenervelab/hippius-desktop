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
    pool
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
    let root = list_sync_folder_grouped_inner(
        &state,
        ACCOUNT.into(),
        tmp.path().to_string_lossy().into(),
        None,
        Some(LABEL.into()),
    )
    .await
    .expect("root listing");
    assert_eq!(root.folders.len(), 1, "root folders: {:?}", root.folders.iter().map(|f| &f.name).collect::<Vec<_>>());
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

    let root = list_sync_folder_grouped_inner(
        &state,
        ACCOUNT.into(),
        tmp.path().to_string_lossy().into(),
        None,
        Some(LABEL.into()),
    )
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

    let root = list_sync_folder_grouped_inner(
        &state,
        ACCOUNT.into(),
        tmp.path().to_string_lossy().into(),
        None,
        Some(LABEL.into()),
    )
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
async fn pending_backfill_flag_reflects_db_state() {
    let tmp = tempfile::tempdir().unwrap();
    write_file(tmp.path(), "a.txt");

    let pool = make_pool().await;
    // NULL timestamp → backfill still pending.
    insert_sync_path(&pool, &tmp.path().to_string_lossy(), None).await;
    let state = make_state(pool);

    let listing = list_sync_folder_grouped_inner(
        &state,
        ACCOUNT.into(),
        tmp.path().to_string_lossy().into(),
        None,
        Some(LABEL.into()),
    )
    .await
    .expect("listing");

    assert!(listing.pending_backfill, "NULL column → FE banner should show");
}
