//! Regression tests for the "false Sync Complete on user cancel" bug.
//!
//! Two behaviours are guarded here:
//!
//! 1. **Cancel marker alignment** — `CANCELLED_MARKER` must stay equal to the
//!    current `hcfs_client::sync::SyncError::Cancelled.to_string()`. The desktop
//!    bridge silences every `hcfs_sync_error` whose message matches this
//!    constant; upstream rewording would silently break the filter and cancels
//!    would start producing "Sync Failed" rows again. Pinned here so bumping
//!    the `hcfs-client` git rev fails fast if the wording drifts.
//! 2. **Outcome-typed notification rows** — `create_sync_notification_inner`
//!    must write distinct titles and subtype prefixes for each
//!    `SyncNotificationOutcome`. The FE relies on the title ("Sync Complete"
//!    vs. "Sync Failed") and the `FileSyncComplete-`/`FileSyncError-` prefix to
//!    filter the notifications page; any drift here is a user-visible bug.

use sqlx::sqlite::SqlitePool;
use tauri_project_lib::notifications::credits::{SyncNotificationOutcome, create_sync_notification_inner};
use tauri_project_lib::sync::events::CANCELLED_MARKER;

/// Mirrors `utils::schema::ensure_table_schema` for the `notifications` table,
/// scoped to what `create_sync_notification_inner` touches. Reusing the real
/// schema helper would pull in Tauri setup this test doesn't need.
async fn setup_notifications_db() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.expect("in-memory sqlite");
    sqlx::query(
        "CREATE TABLE notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_address TEXT NOT NULL,
            notification_type TEXT,
            notification_subtype TEXT,
            title_text TEXT,
            description TEXT,
            link_text TEXT,
            link TEXT,
            is_unread INTEGER DEFAULT 1,
            creation_time INTEGER,
            is_deleted INTEGER DEFAULT 0,
            deleted_at INTEGER,
            release_notes TEXT
        )",
    )
    .execute(&pool)
    .await
    .expect("create notifications table");
    pool
}

#[tokio::test]
async fn cancelled_marker_matches_upstream_stringification() {
    // The bridge filter uses equality, not substring match — if upstream adds a
    // suffix like "Operation cancelled by user (stall watchdog)", silencing
    // breaks. Catch that at build time.
    assert_eq!(hcfs_client::sync::SyncError::Cancelled.to_string(), CANCELLED_MARKER);
}

#[tokio::test]
async fn success_notification_uses_sync_complete_title() {
    let pool = setup_notifications_db().await;

    let id = create_sync_notification_inner(&pool, "5Ft4uvTEST", "1 file uploaded.", "", SyncNotificationOutcome::Success)
        .await
        .expect("insert success notification");

    let (title, subtype): (String, String) = sqlx::query_as("SELECT title_text, notification_subtype FROM notifications WHERE id = ?")
        .bind(id)
        .fetch_one(&pool)
        .await
        .expect("fetch row");

    assert_eq!(title, "Sync Complete");
    assert!(subtype.starts_with("FileSyncComplete-"), "unexpected subtype: {subtype}");
}

#[tokio::test]
async fn error_notification_uses_sync_failed_title_and_distinct_subtype() {
    let pool = setup_notifications_db().await;

    let id = create_sync_notification_inner(
        &pool,
        "5Ft4uvTEST",
        r#"Sync failed for folder "big folder copie 2": Rate limited, retry after 30s"#,
        "",
        SyncNotificationOutcome::Error,
    )
    .await
    .expect("insert error notification");

    let (title, subtype): (String, String) = sqlx::query_as("SELECT title_text, notification_subtype FROM notifications WHERE id = ?")
        .bind(id)
        .fetch_one(&pool)
        .await
        .expect("fetch row");

    assert_eq!(title, "Sync Failed");
    assert!(subtype.starts_with("FileSyncError-"), "unexpected subtype: {subtype}");
    // Subtype prefix must differ from success so the notifications page can
    // partition the list without parsing the description string.
    assert!(!subtype.starts_with("FileSyncComplete-"));
}
