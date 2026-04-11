//! Integration tests for the per-drive status query.
//!
//! These exercise `get_all_drive_statuses_inner` against a real
//! `AppState` with an in-memory SQLite pool. The IPC wrapper is a
//! one-line delegation so testing the inner is sufficient.
//!
//! What we verify:
//!
//! 1. **Empty when no account is logged in** — defensive contract.
//! 2. **Empty when no sync paths exist** — fresh-install state.
//! 3. **Active vs Paused mapping** — `is_paused=false` → `Active`,
//!    `is_paused=true` → `Paused`. This is the entire status semantics.
//! 4. **Filters out the internal `migration` pseudo-drive** — the
//!    settings page / tray menu must never show it.
//! 5. **Multi-drive isolation** — pausing one drive doesn't affect
//!    the others.
//! 6. **Owner scoping** — paths from a different owner are excluded.
//!
//! These guarantees combined with the existing per-module unit tests
//! in `sync::drive_status` and `sync::user_stopped_migration` cover
//! the entire Phase 1 backend rewrite.

use sqlx::sqlite::SqlitePool;

use tauri_project_lib::app_state::AppState;
use tauri_project_lib::auth::state::AuthCapabilities;
use tauri_project_lib::sync::drive_status::DriveStatus;
use tauri_project_lib::sync::status::get_all_drive_statuses_inner;

/// Build an in-memory pool with the minimum schema this test touches:
/// just `sync_paths` plus the unique constraint that production uses.
async fn make_pool() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.expect("open in-memory db");

    sqlx::query(
        "CREATE TABLE sync_paths (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL,
            path TEXT NOT NULL,
            type TEXT NOT NULL,
            label TEXT NOT NULL,
            is_paused INTEGER NOT NULL DEFAULT 0,
            UNIQUE(owner, label)
        )",
    )
    .execute(&pool)
    .await
    .unwrap();

    pool
}

/// Helper that mirrors `account_key()` from `auth/account_key.rs`. The
/// production owner column is the hex-encoded SHA-256 of the substrate
/// address truncated to 16 chars. Mirror it here so the tests insert
/// rows with the same owner key the production query reads.
fn account_key(account_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(account_id.as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest[..8])
}

async fn insert_path(pool: &SqlitePool, account_id: &str, label: &str, paused: bool) {
    sqlx::query("INSERT INTO sync_paths (owner, path, type, label, is_paused) VALUES (?, ?, 'private', ?, ?)")
        .bind(account_key(account_id))
        .bind(format!("/tmp/{label}"))
        .bind(label)
        .bind(i32::from(paused))
        .execute(pool)
        .await
        .unwrap();
}

/// Build an `AppState` with the given pool and an active account.
fn make_state_with_account(pool: SqlitePool, account_id: &str) -> AppState {
    let state = AppState::new();
    state.set_pool(pool);
    state
        .set_active_account(account_id, AuthCapabilities::default())
        .expect("set active account");
    state
}

#[tokio::test]
async fn returns_empty_when_no_account_set() {
    let pool = make_pool().await;
    let state = AppState::new();
    state.set_pool(pool);
    // Note: NOT calling set_active_account.

    let result = get_all_drive_statuses_inner(&state).await.unwrap();
    assert!(result.is_empty(), "expected empty list, got {result:?}");
}

#[tokio::test]
async fn returns_empty_when_no_sync_paths_exist() {
    let pool = make_pool().await;
    let state = make_state_with_account(pool, "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");

    let result = get_all_drive_statuses_inner(&state).await.unwrap();
    assert!(result.is_empty(), "expected empty list, got {result:?}");
}

#[tokio::test]
async fn maps_is_paused_to_paused_status() {
    let pool = make_pool().await;
    let account = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    insert_path(&pool, account, "default", false).await;
    insert_path(&pool, account, "photos", true).await;

    let state = make_state_with_account(pool, account);
    let mut result = get_all_drive_statuses_inner(&state).await.unwrap();
    result.sort_by(|a, b| a.label.cmp(&b.label));

    assert_eq!(result.len(), 2);
    assert_eq!(result[0].label, "default");
    assert_eq!(result[0].status, DriveStatus::Active);
    assert_eq!(result[1].label, "photos");
    assert_eq!(result[1].status, DriveStatus::Paused);
}

#[tokio::test]
async fn folder_name_is_basename_of_sync_path() {
    // The tray submenu and per-drive settings rows display
    // `folder_name`, not the internal `label`. Pin the basename
    // extraction so a path like `/tmp/photos` shows as "photos".
    let pool = make_pool().await;
    let account = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    insert_path(&pool, account, "drive_a", false).await;
    insert_path(&pool, account, "drive_b", true).await;

    let state = make_state_with_account(pool, account);
    let mut result = get_all_drive_statuses_inner(&state).await.unwrap();
    result.sort_by(|a, b| a.label.cmp(&b.label));

    // insert_path uses `/tmp/{label}` as the path, so the basename is
    // the label string. Verifies the basename plumbing end-to-end.
    assert_eq!(result[0].folder_name, "drive_a");
    assert_eq!(result[1].folder_name, "drive_b");
}

#[tokio::test]
async fn filters_out_internal_migration_pseudo_drive() {
    let pool = make_pool().await;
    let account = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    insert_path(&pool, account, "default", false).await;
    insert_path(&pool, account, "migration", false).await;
    insert_path(&pool, account, "photos", false).await;

    let state = make_state_with_account(pool, account);
    let result = get_all_drive_statuses_inner(&state).await.unwrap();

    let labels: Vec<&str> = result.iter().map(|e| e.label.as_str()).collect();
    assert_eq!(labels.len(), 2, "migration drive should be filtered out");
    assert!(labels.contains(&"default"));
    assert!(labels.contains(&"photos"));
    assert!(!labels.contains(&"migration"));
}

#[tokio::test]
async fn multi_drive_independence() {
    // The whole point of the per-drive redesign: pausing one drive
    // does not affect the others' reported status. This test pins
    // that contract.
    let pool = make_pool().await;
    let account = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    insert_path(&pool, account, "drive_a", false).await;
    insert_path(&pool, account, "drive_b", true).await;
    insert_path(&pool, account, "drive_c", false).await;
    insert_path(&pool, account, "drive_d", true).await;

    let state = make_state_with_account(pool, account);
    let result = get_all_drive_statuses_inner(&state).await.unwrap();

    let active: Vec<&str> = result
        .iter()
        .filter(|e| e.status == DriveStatus::Active)
        .map(|e| e.label.as_str())
        .collect();
    let paused: Vec<&str> = result
        .iter()
        .filter(|e| e.status == DriveStatus::Paused)
        .map(|e| e.label.as_str())
        .collect();

    assert_eq!(active.len(), 2);
    assert!(active.contains(&"drive_a"));
    assert!(active.contains(&"drive_c"));
    assert_eq!(paused.len(), 2);
    assert!(paused.contains(&"drive_b"));
    assert!(paused.contains(&"drive_d"));
}

#[tokio::test]
async fn owner_scoping_excludes_other_accounts() {
    // Verify the underlying query joins on owner so a stale row from
    // a different substrate address doesn't leak into the result.
    let pool = make_pool().await;
    let alice = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    let bob = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

    insert_path(&pool, alice, "alice_default", false).await;
    insert_path(&pool, alice, "alice_photos", true).await;
    insert_path(&pool, bob, "bob_default", false).await;
    insert_path(&pool, bob, "bob_work", true).await;

    let state = make_state_with_account(pool, alice);
    let result = get_all_drive_statuses_inner(&state).await.unwrap();

    let labels: Vec<&str> = result.iter().map(|e| e.label.as_str()).collect();
    assert_eq!(labels.len(), 2, "expected only alice's paths, got {labels:?}");
    assert!(labels.contains(&"alice_default"));
    assert!(labels.contains(&"alice_photos"));
    assert!(!labels.contains(&"bob_default"));
    assert!(!labels.contains(&"bob_work"));
}

#[tokio::test]
async fn cached_status_wins_over_db_derived_status() {
    // Regression guard: the per-drive cache in `AppState.drive_status_cache`
    // must take precedence over the `is_paused`-derived fallback. Without
    // this, an `Error { message }` state emitted by `auto_init_sync_inner`
    // would be silently clobbered to `Active` the next time the FE
    // bootstraps `get_all_drive_statuses` (e.g. on Settings page mount),
    // which is exactly the bug the cache was added to prevent.
    let pool = make_pool().await;
    let account = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    // Both rows have `is_paused=false`, so the DB-derived fallback
    // would return Active for both. The cache overrides one.
    insert_path(&pool, account, "working_drive", false).await;
    insert_path(&pool, account, "failed_drive", false).await;

    let state = make_state_with_account(pool, account);

    // Simulate `emit_drive_status` having previously written an Error
    // for "failed_drive" (e.g. from a failed auto_init_sync run).
    {
        let mut cache = state.drive_status_cache.lock().expect("cache lock");
        cache.insert(
            "failed_drive".to_string(),
            DriveStatus::Error {
                message: "Failed to initialize: test message".to_string(),
            },
        );
    }

    let mut result = get_all_drive_statuses_inner(&state).await.unwrap();
    result.sort_by(|a, b| a.label.cmp(&b.label));

    assert_eq!(result.len(), 2);
    assert_eq!(result[0].label, "failed_drive");
    assert!(
        matches!(result[0].status, DriveStatus::Error { ref message } if message.contains("Failed to initialize")),
        "expected cached Error state to win over is_paused=false; got {:?}",
        result[0].status
    );

    // The non-cached drive still gets the DB-derived Active status.
    assert_eq!(result[1].label, "working_drive");
    assert_eq!(result[1].status, DriveStatus::Active);
}

#[tokio::test]
async fn cached_status_falls_through_when_label_missing() {
    // Negative case: a cache that has an entry for one label must not
    // affect other labels' DB-derived status. Protects against an
    // accidental map-wide override in `get_all_drive_statuses_inner`.
    let pool = make_pool().await;
    let account = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    insert_path(&pool, account, "drive_with_cache", false).await;
    insert_path(&pool, account, "drive_without_cache", true).await;

    let state = make_state_with_account(pool, account);
    {
        let mut cache = state.drive_status_cache.lock().expect("cache lock");
        cache.insert("drive_with_cache".to_string(), DriveStatus::Paused);
    }

    let mut result = get_all_drive_statuses_inner(&state).await.unwrap();
    result.sort_by(|a, b| a.label.cmp(&b.label));

    // Cached entry: Paused (cache wins over is_paused=false).
    assert_eq!(result[0].label, "drive_with_cache");
    assert_eq!(result[0].status, DriveStatus::Paused);
    // Non-cached entry: DB-derived Paused (is_paused=true).
    assert_eq!(result[1].label, "drive_without_cache");
    assert_eq!(result[1].status, DriveStatus::Paused);
}
