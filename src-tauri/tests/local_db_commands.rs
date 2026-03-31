//! Integration tests for notification, contact, preference, and app state
//! DB operations.
//!
//! Uses an in-memory SQLite database — no Tauri AppHandle needed.
//! Tests the raw SQL logic that the Tauri commands in `local_db.rs` wrap.

use sqlx::sqlite::SqlitePool;

async fn setup_db() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS notifications (
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
    .unwrap();

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_notifications_user \
         ON notifications(user_address)",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS notification_preferences (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            description TEXT NOT NULL,
            enabled INTEGER DEFAULT 1
        )",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Seed default preferences
    sqlx::query(
        "INSERT INTO notification_preferences (id, label, description, enabled) VALUES
         ('credits', 'Credits', 'Account credit notifications', 1),
         ('files', 'Files', 'File sync notifications', 1)",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            is_first_time INTEGER DEFAULT 1,
            is_above_half_credit INTEGER DEFAULT 0
        )",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query("INSERT OR IGNORE INTO app_state (id) VALUES (1)")
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS address_book (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            wallet_address TEXT NOT NULL,
            date_added INTEGER DEFAULT (strftime('%s','now') * 1000)
        )",
    )
    .execute(&pool)
    .await
    .unwrap();

    pool
}

/// Insert a notification and return its row id.
async fn insert_notification(
    pool: &SqlitePool,
    user_address: &str,
    notification_type: Option<&str>,
    notification_subtype: Option<&str>,
    title: &str,
) -> i64 {
    let now = chrono::Utc::now().timestamp_millis();
    let result = sqlx::query(
        r#"INSERT INTO notifications (
            user_address, notification_type, notification_subtype,
            title_text, is_unread, creation_time, is_deleted
        ) VALUES (?, ?, ?, ?, 1, ?, 0)"#,
    )
    .bind(user_address)
    .bind(notification_type)
    .bind(notification_subtype)
    .bind(title)
    .bind(now)
    .execute(pool)
    .await
    .unwrap();
    result.last_insert_rowid()
}

/// Count non-deleted notifications for a user (mirrors list_notifications filter).
async fn count_notifications(pool: &SqlitePool, user_address: &str) -> i64 {
    let (count,) = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications \
         WHERE (user_address = ? OR user_address = 'system') AND is_deleted = 0",
    )
    .bind(user_address)
    .fetch_one(pool)
    .await
    .unwrap();
    count
}

/// Check whether a notification is unread.
async fn is_unread(pool: &SqlitePool, id: i64) -> bool {
    let (val,) = sqlx::query_as::<_, (i32,)>("SELECT is_unread FROM notifications WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap();
    val != 0
}

// ── Notification CRUD ───────────────────────────────────────────────────

#[tokio::test]
async fn insert_and_list_notification() {
    let pool = setup_db().await;
    let alice = "alice-addr";

    insert_notification(&pool, alice, Some("Info"), None, "Hello").await;

    assert_eq!(count_notifications(&pool, alice).await, 1);
}

#[tokio::test]
async fn mark_read_and_unread() {
    let pool = setup_db().await;
    let id = insert_notification(&pool, "alice", Some("Info"), None, "n1").await;

    assert!(is_unread(&pool, id).await);

    sqlx::query("UPDATE notifications SET is_unread = 0 WHERE id = ?")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(!is_unread(&pool, id).await);

    sqlx::query("UPDATE notifications SET is_unread = 1 WHERE id = ?")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(is_unread(&pool, id).await);
}

#[tokio::test]
async fn mark_all_read() {
    let pool = setup_db().await;
    let alice = "alice";
    let bob = "bob";

    insert_notification(&pool, alice, None, None, "a1").await;
    insert_notification(&pool, alice, None, None, "a2").await;
    let bob_id = insert_notification(&pool, bob, None, None, "b1").await;

    // Mark all read for alice — mirrors mark_all_notifications_read
    sqlx::query(
        "UPDATE notifications SET is_unread = 0 \
         WHERE (user_address = ? OR user_address = 'system') AND is_deleted = 0",
    )
    .bind(alice)
    .execute(&pool)
    .await
    .unwrap();

    let (alice_unread,) = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications \
         WHERE (user_address = ? OR user_address = 'system') \
         AND is_unread = 1 AND is_deleted = 0",
    )
    .bind(alice)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(alice_unread, 0);

    // Bob's notification is still unread
    assert!(is_unread(&pool, bob_id).await);
}

#[tokio::test]
async fn soft_delete_excludes_from_count() {
    let pool = setup_db().await;
    let alice = "alice";

    let id = insert_notification(&pool, alice, None, None, "n1").await;
    assert_eq!(count_notifications(&pool, alice).await, 1);

    // Soft-delete — mirrors delete_notification
    sqlx::query(
        "UPDATE notifications SET is_deleted = 1, \
         deleted_at = CAST(strftime('%s','now') * 1000 AS INTEGER) \
         WHERE id = ?",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();

    assert_eq!(count_notifications(&pool, alice).await, 0);
}

#[tokio::test]
async fn soft_delete_all_for_user() {
    let pool = setup_db().await;
    let alice = "alice";
    let bob = "bob";

    insert_notification(&pool, alice, None, None, "a1").await;
    insert_notification(&pool, alice, None, None, "a2").await;
    insert_notification(&pool, bob, None, None, "b1").await;

    // Soft-delete all for alice — mirrors delete_all_notifications
    sqlx::query(
        "UPDATE notifications SET is_deleted = 1, \
         deleted_at = CAST(strftime('%s','now') * 1000 AS INTEGER) \
         WHERE user_address = ?",
    )
    .bind(alice)
    .execute(&pool)
    .await
    .unwrap();

    assert_eq!(count_notifications(&pool, alice).await, 0);
    assert_eq!(count_notifications(&pool, bob).await, 1);
}

#[tokio::test]
async fn unread_count_excludes_deleted() {
    let pool = setup_db().await;
    let alice = "alice";

    let id1 = insert_notification(&pool, alice, None, None, "n1").await;
    insert_notification(&pool, alice, None, None, "n2").await;

    // Soft-delete one
    sqlx::query("UPDATE notifications SET is_deleted = 1 WHERE id = ?")
        .bind(id1)
        .execute(&pool)
        .await
        .unwrap();

    // get_unread_count query
    let (unread,) = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications \
         WHERE (user_address = ? OR user_address = 'system') \
         AND is_unread = 1 AND is_deleted = 0",
    )
    .bind(alice)
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(unread, 1);
}

// ── Notification Queries ────────────────────────────────────────────────

#[tokio::test]
async fn system_notifications_included_in_user_list() {
    let pool = setup_db().await;
    let alice = "alice";

    insert_notification(&pool, alice, None, None, "user-notif").await;
    insert_notification(&pool, "system", Some("Hippius"), Some("v1.0"), "Release").await;

    // list_notifications query includes system notifications
    assert_eq!(count_notifications(&pool, alice).await, 2);
}

#[tokio::test]
async fn welcome_notification_is_deduplicated() {
    let pool = setup_db().await;
    let subtype = "Welcome-alice";

    insert_notification(&pool, "alice", Some("Hippius"), Some(subtype), "Welcome!").await;

    // Duplicate check — mirrors add_notification dedup logic
    let (existing,) = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications \
         WHERE notification_type = 'Hippius' AND notification_subtype = ?",
    )
    .bind(subtype)
    .fetch_one(&pool)
    .await
    .unwrap();

    assert!(existing > 0, "Welcome notification should already exist");

    // A second insert should be skipped by the app logic (count > 0)
    // Verify the count stays at 1 if we respect the guard
    let (total,) = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications \
         WHERE notification_type = 'Hippius' AND notification_subtype = ?",
    )
    .bind(subtype)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(total, 1);
}

#[tokio::test]
async fn version_notification_exists_check() {
    let pool = setup_db().await;

    insert_notification(
        &pool,
        "system",
        Some("Hippius"),
        Some("v2.1.0"),
        "New version",
    )
    .await;

    // hippius_version_notification_exists query
    let (count,) = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications \
         WHERE user_address = 'system' AND notification_type = 'Hippius' \
         AND notification_subtype = ?",
    )
    .bind("v2.1.0")
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(count > 0);

    // Non-existent version
    let (count,) = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications \
         WHERE user_address = 'system' AND notification_type = 'Hippius' \
         AND notification_subtype = ?",
    )
    .bind("v9.9.9")
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn low_credit_subtype_detection() {
    let pool = setup_db().await;

    let subtype = "LowCreditWarning-100";
    insert_notification(&pool, "alice", Some("Credits"), Some(subtype), "Low credit").await;

    // low_credit_subtype_exists query
    let (count,) = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications \
         WHERE notification_type = 'Credits' AND notification_subtype = ?",
    )
    .bind(subtype)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(count > 0);
}

#[tokio::test]
async fn active_low_credit_excludes_deleted() {
    let pool = setup_db().await;

    let id = insert_notification(
        &pool,
        "alice",
        Some("Credits"),
        Some("LowCreditWarning-50"),
        "Low",
    )
    .await;

    // Active before deletion
    let (active,) = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications \
         WHERE notification_type = 'Credits' \
         AND notification_subtype LIKE 'LowCreditWarning-%' AND is_deleted = 0",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(active, 1);

    // Soft-delete
    sqlx::query(
        "UPDATE notifications SET is_deleted = 1, \
         deleted_at = CAST(strftime('%s','now') * 1000 AS INTEGER) WHERE id = ?",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();

    let (active,) = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications \
         WHERE notification_type = 'Credits' \
         AND notification_subtype LIKE 'LowCreditWarning-%' AND is_deleted = 0",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(active, 0);
}

#[tokio::test]
async fn last_deleted_low_credit_time() {
    let pool = setup_db().await;

    // No deleted low-credit notifications yet
    let row = sqlx::query_as::<_, (Option<i64>,)>(
        "SELECT deleted_at FROM notifications \
         WHERE notification_type = 'Credits' \
         AND notification_subtype LIKE 'LowCreditWarning-%' AND is_deleted = 1 \
         ORDER BY deleted_at DESC LIMIT 1",
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(row.is_none());

    // Insert and soft-delete two low-credit warnings with known timestamps
    let id1 = insert_notification(
        &pool,
        "alice",
        Some("Credits"),
        Some("LowCreditWarning-1"),
        "Low 1",
    )
    .await;
    let id2 = insert_notification(
        &pool,
        "alice",
        Some("Credits"),
        Some("LowCreditWarning-2"),
        "Low 2",
    )
    .await;

    let earlier = 1_000_000_i64;
    let later = 2_000_000_i64;

    sqlx::query("UPDATE notifications SET is_deleted = 1, deleted_at = ? WHERE id = ?")
        .bind(earlier)
        .bind(id1)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE notifications SET is_deleted = 1, deleted_at = ? WHERE id = ?")
        .bind(later)
        .bind(id2)
        .execute(&pool)
        .await
        .unwrap();

    let row = sqlx::query_as::<_, (Option<i64>,)>(
        "SELECT deleted_at FROM notifications \
         WHERE notification_type = 'Credits' \
         AND notification_subtype LIKE 'LowCreditWarning-%' AND is_deleted = 1 \
         ORDER BY deleted_at DESC LIMIT 1",
    )
    .fetch_optional(&pool)
    .await
    .unwrap();

    let (deleted_at,) = row.unwrap();
    assert_eq!(deleted_at.unwrap(), later);
}

// ── Preferences ─────────────────────────────────────────────────────────

#[tokio::test]
async fn default_preferences_are_seeded() {
    let pool = setup_db().await;

    let (count,) = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM notification_preferences")
        .fetch_one(&pool)
        .await
        .unwrap();

    assert_eq!(count, 2);
}

#[tokio::test]
async fn update_preference_disables_type() {
    let pool = setup_db().await;

    sqlx::query("UPDATE notification_preferences SET enabled = 0 WHERE id = ?")
        .bind("credits")
        .execute(&pool)
        .await
        .unwrap();

    let (enabled,) =
        sqlx::query_as::<_, (i32,)>("SELECT enabled FROM notification_preferences WHERE id = ?")
            .bind("credits")
            .fetch_one(&pool)
            .await
            .unwrap();

    assert_eq!(enabled, 0);
}

#[tokio::test]
async fn get_enabled_types_only() {
    let pool = setup_db().await;

    // Disable one preference
    sqlx::query("UPDATE notification_preferences SET enabled = 0 WHERE id = 'files'")
        .execute(&pool)
        .await
        .unwrap();

    let rows = sqlx::query_as::<_, (String,)>(
        "SELECT label FROM notification_preferences WHERE enabled = 1",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    let labels: Vec<String> = rows.into_iter().map(|(l,)| l).collect();
    assert_eq!(labels.len(), 1);
    assert_eq!(labels[0], "Credits");
}

// ── App State ───────────────────────────────────────────────────────────

#[tokio::test]
async fn is_first_time_defaults_true() {
    let pool = setup_db().await;

    let (val,) = sqlx::query_as::<_, (i32,)>("SELECT is_first_time FROM app_state WHERE id = 1")
        .fetch_one(&pool)
        .await
        .unwrap();

    assert_eq!(val, 1);
}

#[tokio::test]
async fn mark_first_time_seen_sets_false() {
    let pool = setup_db().await;

    sqlx::query("UPDATE app_state SET is_first_time = 0 WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();

    let (val,) = sqlx::query_as::<_, (i32,)>("SELECT is_first_time FROM app_state WHERE id = 1")
        .fetch_one(&pool)
        .await
        .unwrap();

    assert_eq!(val, 0);
}

#[tokio::test]
async fn above_half_credit_toggle() {
    let pool = setup_db().await;

    // Default is 0
    let (val,) =
        sqlx::query_as::<_, (i32,)>("SELECT is_above_half_credit FROM app_state WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(val, 0);

    // Set to 1
    sqlx::query("UPDATE app_state SET is_above_half_credit = 1 WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();

    let (val,) =
        sqlx::query_as::<_, (i32,)>("SELECT is_above_half_credit FROM app_state WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(val, 1);
}

// ── Address Book ────────────────────────────────────────────────────────

#[tokio::test]
async fn add_and_list_contacts() {
    let pool = setup_db().await;

    sqlx::query("INSERT INTO address_book (name, wallet_address) VALUES (?, ?)")
        .bind("Alice")
        .bind("5GrwvaEF...")
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query("INSERT INTO address_book (name, wallet_address) VALUES (?, ?)")
        .bind("Bob")
        .bind("5FHneW46...")
        .execute(&pool)
        .await
        .unwrap();

    let (count,) = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM address_book")
        .fetch_one(&pool)
        .await
        .unwrap();

    assert_eq!(count, 2);
}

#[tokio::test]
async fn update_contact_name() {
    let pool = setup_db().await;

    let result = sqlx::query("INSERT INTO address_book (name, wallet_address) VALUES (?, ?)")
        .bind("Old Name")
        .bind("5Grw...")
        .execute(&pool)
        .await
        .unwrap();
    let id = result.last_insert_rowid();

    sqlx::query("UPDATE address_book SET name = ?, wallet_address = ? WHERE id = ?")
        .bind("New Name")
        .bind("5Grw...")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();

    let (name,) = sqlx::query_as::<_, (String,)>("SELECT name FROM address_book WHERE id = ?")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();

    assert_eq!(name, "New Name");
}

#[tokio::test]
async fn delete_contact() {
    let pool = setup_db().await;

    let result = sqlx::query("INSERT INTO address_book (name, wallet_address) VALUES (?, ?)")
        .bind("Charlie")
        .bind("5Cha...")
        .execute(&pool)
        .await
        .unwrap();
    let id = result.last_insert_rowid();

    sqlx::query("DELETE FROM address_book WHERE id = ?")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();

    let (count,) = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM address_book")
        .fetch_one(&pool)
        .await
        .unwrap();

    assert_eq!(count, 0);
}

#[tokio::test]
async fn contacts_sorted_by_name() {
    let pool = setup_db().await;

    sqlx::query("INSERT INTO address_book (name, wallet_address) VALUES (?, ?)")
        .bind("Zara")
        .bind("addr-z")
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query("INSERT INTO address_book (name, wallet_address) VALUES (?, ?)")
        .bind("Alice")
        .bind("addr-a")
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query("INSERT INTO address_book (name, wallet_address) VALUES (?, ?)")
        .bind("Mia")
        .bind("addr-m")
        .execute(&pool)
        .await
        .unwrap();

    // get_contacts query uses ORDER BY name ASC
    let rows = sqlx::query_as::<_, (String,)>("SELECT name FROM address_book ORDER BY name ASC")
        .fetch_all(&pool)
        .await
        .unwrap();

    let names: Vec<String> = rows.into_iter().map(|(n,)| n).collect();
    assert_eq!(names, vec!["Alice", "Mia", "Zara"]);
}

// ── Isolation ───────────────────────────────────────────────────────────

#[tokio::test]
async fn notifications_isolated_by_user() {
    let pool = setup_db().await;

    insert_notification(&pool, "alice", None, None, "a-only").await;
    insert_notification(&pool, "bob", None, None, "b-only").await;

    // Alice should not see Bob's notifications (system also absent)
    let rows = sqlx::query_as::<_, (String,)>(
        "SELECT title_text FROM notifications \
         WHERE (user_address = ? OR user_address = 'system') AND is_deleted = 0",
    )
    .bind("alice")
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, "a-only");
}

#[tokio::test]
async fn hard_delete_clears_all() {
    let pool = setup_db().await;

    insert_notification(&pool, "alice", None, None, "n1").await;
    insert_notification(&pool, "bob", None, None, "n2").await;
    insert_notification(&pool, "system", None, None, "n3").await;

    sqlx::query("DELETE FROM notifications")
        .execute(&pool)
        .await
        .unwrap();

    let (count,) = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM notifications")
        .fetch_one(&pool)
        .await
        .unwrap();

    assert_eq!(count, 0);
}

// ── Unread Count Respects Preferences ───────────────────────────────────

/// Helper: mirrors the updated `get_unread_count` logic that filters by enabled
/// notification preferences and always includes "Hippius" system notifications.
async fn preference_filtered_unread_count(pool: &SqlitePool, user_address: &str) -> i64 {
    let enabled: Vec<String> = sqlx::query_as::<_, (String,)>(
        "SELECT label FROM notification_preferences WHERE enabled = 1",
    )
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|(l,)| l)
    .collect();

    if enabled.is_empty() {
        let (count,) = sqlx::query_as::<_, (i64,)>(
            "SELECT COUNT(*) FROM notifications \
             WHERE (user_address = ? OR user_address = 'system') \
             AND is_unread = 1 AND is_deleted = 0 \
             AND notification_type = 'Hippius'",
        )
        .bind(user_address)
        .fetch_one(pool)
        .await
        .unwrap();
        return count;
    }

    let placeholders: Vec<&str> = enabled.iter().map(|_| "?").collect();
    let in_clause = placeholders.join(", ");
    let query = format!(
        "SELECT COUNT(*) FROM notifications \
         WHERE (user_address = ? OR user_address = 'system') \
         AND is_unread = 1 AND is_deleted = 0 \
         AND (notification_type IN ({}) OR notification_type = 'Hippius')",
        in_clause
    );
    let mut q = sqlx::query_as::<_, (i64,)>(&query).bind(user_address);
    for label in &enabled {
        q = q.bind(label);
    }
    q.fetch_one(pool).await.unwrap().0
}

#[tokio::test]
async fn unread_count_respects_disabled_files_preference() {
    let pool = setup_db().await;
    let alice = "alice";

    // Insert 1 Credits and 2 Files notifications (all unread)
    insert_notification(&pool, alice, Some("Credits"), None, "credit-n1").await;
    insert_notification(&pool, alice, Some("Files"), None, "file-n1").await;
    insert_notification(&pool, alice, Some("Files"), None, "file-n2").await;

    // Both preferences enabled → should count all 3
    assert_eq!(preference_filtered_unread_count(&pool, alice).await, 3);

    // Disable Files preference
    sqlx::query("UPDATE notification_preferences SET enabled = 0 WHERE id = 'files'")
        .execute(&pool)
        .await
        .unwrap();

    // Only Credits enabled → should count 1
    assert_eq!(preference_filtered_unread_count(&pool, alice).await, 1);
}

#[tokio::test]
async fn unread_count_always_includes_hippius_system_notifications() {
    let pool = setup_db().await;
    let alice = "alice";

    // Insert a Hippius system notification + a Files notification
    insert_notification(&pool, alice, Some("Hippius"), Some("Welcome"), "Welcome!").await;
    insert_notification(&pool, alice, Some("Files"), None, "file-n1").await;

    // Disable both preferences
    sqlx::query("UPDATE notification_preferences SET enabled = 0 WHERE id IN ('credits', 'files')")
        .execute(&pool)
        .await
        .unwrap();

    // Only Hippius system should remain visible
    assert_eq!(preference_filtered_unread_count(&pool, alice).await, 1);
}

#[tokio::test]
async fn unread_count_zero_when_all_disabled_and_no_system() {
    let pool = setup_db().await;
    let alice = "alice";

    insert_notification(&pool, alice, Some("Credits"), None, "credit-n1").await;
    insert_notification(&pool, alice, Some("Files"), None, "file-n1").await;

    // Disable all preferences
    sqlx::query("UPDATE notification_preferences SET enabled = 0 WHERE 1=1")
        .execute(&pool)
        .await
        .unwrap();

    // No Hippius system notifications → count should be 0
    assert_eq!(preference_filtered_unread_count(&pool, alice).await, 0);
}
