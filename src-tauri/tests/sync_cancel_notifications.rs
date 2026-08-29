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
//!    `SyncNotificationOutcome`. The bell/page list renders `title_text`,
//!    not the description, so a success row names the file (or the file
//!    count) from `release_notes` JSON. Error rows stay "Sync Failed".
//!    The `FileSyncComplete-`/`FileSyncError-` prefix still filters the
//!    notifications page; any drift here is a user-visible bug.

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

async fn fetch_title_description_subtype(pool: &SqlitePool, id: i64) -> (String, String, String) {
    sqlx::query_as("SELECT title_text, description, notification_subtype FROM notifications WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("fetch row")
}

/// The bell/page list renders `title_text`, not the description. One named
/// file in `release_notes` must surface the basename in the title; the
/// count sentence stays on the description.
#[tokio::test]
async fn success_notification_names_single_file_in_title() {
    let pool = setup_notifications_db().await;
    let details = r#"[{"fileName":"Vacation/IMG_1234.HEIC","totalBytes":1024,"action":"upload"}]"#;
    const DESCRIPTION: &str = "1 file uploaded.";

    let id = create_sync_notification_inner(&pool, "5Ft4uvTEST", DESCRIPTION, details, SyncNotificationOutcome::Success)
        .await
        .expect("insert success notification");

    let (title, description, subtype) = fetch_title_description_subtype(&pool, id).await;

    assert_eq!(title, "Synced IMG_1234.HEIC");
    assert_eq!(description, DESCRIPTION, "count sentence stays on the description");
    assert!(subtype.starts_with("FileSyncComplete-"), "unexpected subtype: {subtype}");
}

/// Several files cannot all fit in the title; pin the count copy so a
/// rewording is a deliberate test change, not a silent UI drift.
#[tokio::test]
async fn success_notification_counts_multiple_files_in_title() {
    let pool = setup_notifications_db().await;
    let details = r#"[
        {"fileName":"a.txt","totalBytes":1,"action":"upload"},
        {"fileName":"b.txt","totalBytes":1,"action":"upload"},
        {"fileName":"nested/c.txt","totalBytes":1,"action":"download"}
    ]"#;
    const DESCRIPTION: &str = "2 files uploaded, 1 file downloaded.";

    let id = create_sync_notification_inner(&pool, "5Ft4uvTEST", DESCRIPTION, details, SyncNotificationOutcome::Success)
        .await
        .expect("insert success notification");

    let (title, description, subtype) = fetch_title_description_subtype(&pool, id).await;

    assert_eq!(title, "Synced 3 files");
    assert_eq!(description, DESCRIPTION, "count sentence stays on the description");
    assert!(subtype.starts_with("FileSyncComplete-"), "unexpected subtype: {subtype}");
}

/// File details on an error row must not override the failure title — the
/// list would then look like a success.
#[tokio::test]
async fn error_notification_title_ignores_file_details() {
    let pool = setup_notifications_db().await;
    let details = r#"[{"fileName":"stuck.bin","totalBytes":8,"action":"upload"}]"#;

    let id = create_sync_notification_inner(
        &pool,
        "5Ft4uvTEST",
        r#"Sync failed for folder "docs": Rate limited, retry after 30s"#,
        details,
        SyncNotificationOutcome::Error,
    )
    .await
    .expect("insert error notification");

    let (title, _, subtype) = fetch_title_description_subtype(&pool, id).await;

    assert_eq!(title, "Sync Failed");
    assert!(subtype.starts_with("FileSyncError-"), "unexpected subtype: {subtype}");
}
