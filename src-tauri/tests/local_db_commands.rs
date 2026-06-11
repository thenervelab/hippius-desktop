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

    // Per-account shape (owner, id): mirrors the production schema so the
    // preference-filtered unread-count query (owner-scoped subquery) resolves.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS notification_preferences (
            owner TEXT NOT NULL,
            id TEXT NOT NULL,
            label TEXT NOT NULL,
            description TEXT NOT NULL,
            enabled INTEGER DEFAULT 1,
            PRIMARY KEY (owner, id)
        )",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Seed default preferences for the `alice` account these tests use.
    sqlx::query(
        "INSERT INTO notification_preferences (owner, id, label, description, enabled) VALUES
         ('alice', 'credits', 'Credits', 'Account credit notifications', 1),
         ('alice', 'files', 'Files', 'File sync notifications', 1)",
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
        r"INSERT INTO notifications (
            user_address, notification_type, notification_subtype,
            title_text, is_unread, creation_time, is_deleted
        ) VALUES (?, ?, ?, ?, 1, ?, 0)",
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

    // Soft-delete all for alice + the system queue — mirrors
    // delete_all_notifications post-fix. The condition matches
    // list_notifications / unread_count_inner so the three queries
    // operate on the same row set.
    sqlx::query(
        "UPDATE notifications SET is_deleted = 1, \
         deleted_at = CAST(strftime('%s','now') * 1000 AS INTEGER) \
         WHERE (user_address = ? OR user_address = 'system') \
         AND is_deleted = 0",
    )
    .bind(alice)
    .execute(&pool)
    .await
    .unwrap();

    assert_eq!(count_notifications(&pool, alice).await, 0);
    assert_eq!(count_notifications(&pool, bob).await, 1);
}

/// Regression: system notifications (user_address = 'system') must be
/// soft-deleted along with the calling user's rows. They are part of
/// the same visible queue (list_notifications joins them in), so
/// "Delete All" must remove them too — otherwise an "Update Available"
/// system notification persists across deletes.
#[tokio::test]
async fn soft_delete_all_includes_system_rows() {
    let pool = setup_db().await;
    let alice = "alice";
    let bob = "bob";

    insert_notification(&pool, alice, None, None, "a1").await;
    insert_notification(&pool, "system", Some("Hippius"), Some("0.1.100"), "Update Available").await;
    insert_notification(&pool, bob, None, None, "b1").await;

    // Same SQL the production command runs.
    sqlx::query(
        "UPDATE notifications SET is_deleted = 1, \
         deleted_at = CAST(strftime('%s','now') * 1000 AS INTEGER) \
         WHERE (user_address = ? OR user_address = 'system') \
         AND is_deleted = 0",
    )
    .bind(alice)
    .execute(&pool)
    .await
    .unwrap();

    // What alice sees through list_notifications — both her rows and
    // system rows — must be empty.
    let (visible_for_alice,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM notifications \
         WHERE (user_address = ? OR user_address = 'system') AND is_deleted = 0",
    )
    .bind(alice)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(visible_for_alice, 0);

    // Bob — a different account — must be untouched. Multi-account
    // installs cannot cross-evict.
    assert_eq!(count_notifications(&pool, bob).await, 1);

    // The system row must be soft-deleted (is_deleted = 1), not
    // hard-deleted, so the "have we ever shown this version?" check
    // (`hippius_version_notification_exists`) keeps returning true and
    // the updater doesn't immediately re-insert the row.
    let (system_total,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM notifications WHERE user_address = 'system'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(system_total, 1, "system row should still exist (soft-deleted)");
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

// ── Welcome notification helper + cleanup ──────────────────────────────
//
// The welcome notification was previously created from two FE code
// paths (mnemonic login + OAuth callback) which both sent the bare
// subtype `"Welcome"`. The Rust-side dedup guard in `add_notification`
// used `starts_with("Welcome-")` (dash-suffix only) and also wasn't
// user-scoped, so on every login the FE successfully inserted a new
// row. Existing users accumulated dozens of welcomes in their local
// DB.
//
// The fix moved welcome creation into Rust via
// `ensure_welcome_notification(pool, user_address)`, which is:
// 1. user-scoped (per-user dedup)
// 2. matches bare `"Welcome"` AND `"Welcome-*"` to coexist with
//    legacy rows and future version bumps
// 3. idempotent by construction — repeat calls are no-ops
//
// A one-time startup cleanup (`cleanup_duplicate_welcome_notifications`)
// collapses the accumulated duplicates to the oldest per user so the
// timestamp used by `process_credit_events` for event filtering stays
// valid.
//
// These tests mirror those two helpers against the same in-memory
// schema. We copy the SQL instead of calling the production helpers
// directly because the helpers take a `&SqlitePool` and the test
// setup builds one; calling them via the test crate boundary would
// require the `lib` feature.

use tauri_project_lib::notifications::crud::{cleanup_duplicate_welcome_notifications, ensure_welcome_notification};

#[tokio::test]
async fn ensure_welcome_notification_inserts_when_absent() {
    let pool = setup_db().await;
    let alice = "alice-addr";

    ensure_welcome_notification(&pool, alice).await.unwrap();

    let (count,) = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications \
         WHERE user_address = ? AND notification_type = 'Hippius' \
         AND notification_subtype = 'Welcome-v1'",
    )
    .bind(alice)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn ensure_welcome_notification_is_idempotent() {
    let pool = setup_db().await;
    let alice = "alice-addr";

    // Call the helper three times in a row — only the first should
    // insert. This pins the "repeat login is a no-op" contract.
    ensure_welcome_notification(&pool, alice).await.unwrap();
    ensure_welcome_notification(&pool, alice).await.unwrap();
    ensure_welcome_notification(&pool, alice).await.unwrap();

    let (count,) = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications \
         WHERE user_address = ? AND notification_type = 'Hippius'",
    )
    .bind(alice)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1, "idempotent helper must not create duplicates");
}

#[tokio::test]
async fn ensure_welcome_notification_is_user_scoped() {
    // Regression guard for the pre-fix dedup which was global, not
    // per-user: a welcome for alice must NOT suppress the welcome for
    // bob when bob logs in for the first time on a multi-account
    // install.
    let pool = setup_db().await;
    let alice = "alice-addr";
    let bob = "bob-addr";

    ensure_welcome_notification(&pool, alice).await.unwrap();
    ensure_welcome_notification(&pool, bob).await.unwrap();

    let (alice_count,) = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM notifications WHERE user_address = ? AND notification_type = 'Hippius'")
        .bind(alice)
        .fetch_one(&pool)
        .await
        .unwrap();
    let (bob_count,) = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM notifications WHERE user_address = ? AND notification_type = 'Hippius'")
        .bind(bob)
        .fetch_one(&pool)
        .await
        .unwrap();

    assert_eq!(alice_count, 1);
    assert_eq!(bob_count, 1);
}

#[tokio::test]
async fn ensure_welcome_notification_respects_legacy_bare_subtype() {
    // Upgrade path: an existing user has a legacy `"Welcome"` subtype
    // row from the broken FE code path. `ensure_welcome_notification`
    // must see it and NOT insert a second welcome (which would be a
    // visible UX regression for every upgrading user).
    let pool = setup_db().await;
    let alice = "alice-addr";
    insert_notification(&pool, alice, Some("Hippius"), Some("Welcome"), "Legacy welcome").await;

    ensure_welcome_notification(&pool, alice).await.unwrap();

    let (count,) = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications \
         WHERE user_address = ? AND notification_type = 'Hippius'",
    )
    .bind(alice)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1, "legacy welcome row must be recognised as already-present");
}

#[tokio::test]
async fn cleanup_collapses_duplicate_welcomes_keeping_oldest() {
    // Pre-fix users may have accumulated many welcome rows. The
    // startup migration must keep the OLDEST per user (so the
    // `creation_time` timestamp used by `process_credit_events` for
    // credit-event filtering stays valid) and hard-delete the rest.
    let pool = setup_db().await;
    let alice = "alice-addr";
    let bob = "bob-addr";

    // Insert 5 welcomes for alice with mixed subtypes (mirrors real
    // data: broken FE sent bare "Welcome" sometimes) and 3 for bob.
    for subtype in ["Welcome", "Welcome", "Welcome-v1", "Welcome", "Welcome-v1"] {
        insert_notification(&pool, alice, Some("Hippius"), Some(subtype), "Welcome").await;
    }
    for subtype in ["Welcome", "Welcome-v1", "Welcome"] {
        insert_notification(&pool, bob, Some("Hippius"), Some(subtype), "Welcome").await;
    }
    // Non-welcome notifications must not be touched.
    insert_notification(&pool, alice, Some("Credits"), Some("Topup"), "Topup").await;
    insert_notification(&pool, alice, None, None, "user-notif").await;

    cleanup_duplicate_welcome_notifications(&pool).await.unwrap();

    // Exactly one welcome per user after cleanup.
    let (alice_welcomes,) = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications \
         WHERE user_address = ? AND notification_type = 'Hippius' \
         AND (notification_subtype = 'Welcome' OR notification_subtype LIKE 'Welcome-%')",
    )
    .bind(alice)
    .fetch_one(&pool)
    .await
    .unwrap();
    let (bob_welcomes,) = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications \
         WHERE user_address = ? AND notification_type = 'Hippius' \
         AND (notification_subtype = 'Welcome' OR notification_subtype LIKE 'Welcome-%')",
    )
    .bind(bob)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(alice_welcomes, 1);
    assert_eq!(bob_welcomes, 1);

    // The surviving row must be the oldest (min id) per user.
    let (alice_min_id,) = sqlx::query_as::<_, (i64,)>(
        "SELECT id FROM notifications \
         WHERE user_address = ? AND notification_type = 'Hippius' \
         AND (notification_subtype = 'Welcome' OR notification_subtype LIKE 'Welcome-%')",
    )
    .bind(alice)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(alice_min_id, 1, "oldest welcome (id=1) must survive for alice");

    // Non-welcome notifications are untouched.
    let (alice_other,) = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications \
         WHERE user_address = ? AND (notification_type != 'Hippius' OR notification_type IS NULL)",
    )
    .bind(alice)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(alice_other, 2, "credits + user notif must survive cleanup");
}

#[tokio::test]
async fn cleanup_is_noop_when_no_duplicates() {
    // The startup cleanup runs on every launch — must be a no-op
    // after the first successful run (and on fresh installs).
    let pool = setup_db().await;
    let alice = "alice-addr";
    ensure_welcome_notification(&pool, alice).await.unwrap();

    let (before,) = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM notifications")
        .fetch_one(&pool)
        .await
        .unwrap();
    cleanup_duplicate_welcome_notifications(&pool).await.unwrap();
    let (after,) = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM notifications")
        .fetch_one(&pool)
        .await
        .unwrap();

    assert_eq!(before, after, "cleanup must not delete anything when there are no duplicates");
}

#[tokio::test]
async fn version_notification_exists_check() {
    let pool = setup_db().await;

    insert_notification(&pool, "system", Some("Hippius"), Some("v2.1.0"), "New version").await;

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

    let id = insert_notification(&pool, "alice", Some("Credits"), Some("LowCreditWarning-50"), "Low").await;

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
    let id1 = insert_notification(&pool, "alice", Some("Credits"), Some("LowCreditWarning-1"), "Low 1").await;
    let id2 = insert_notification(&pool, "alice", Some("Credits"), Some("LowCreditWarning-2"), "Low 2").await;

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

    let (enabled,) = sqlx::query_as::<_, (i32,)>("SELECT enabled FROM notification_preferences WHERE id = ?")
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

    let rows = sqlx::query_as::<_, (String,)>("SELECT label FROM notification_preferences WHERE enabled = 1")
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
    let (val,) = sqlx::query_as::<_, (i32,)>("SELECT is_above_half_credit FROM app_state WHERE id = 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(val, 0);

    // Set to 1
    sqlx::query("UPDATE app_state SET is_above_half_credit = 1 WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();

    let (val,) = sqlx::query_as::<_, (i32,)>("SELECT is_above_half_credit FROM app_state WHERE id = 1")
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

    sqlx::query("DELETE FROM notifications").execute(&pool).await.unwrap();

    let (count,) = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM notifications")
        .fetch_one(&pool)
        .await
        .unwrap();

    assert_eq!(count, 0);
}

// ── Unread Count Respects Preferences ───────────────────────────────────

/// Calls the production [`unread_count_inner`] directly so the three
/// preference tests below exercise the same SQL the IPC handler runs.
/// Previously this helper hand-rolled the query, which let the helper
/// drift independently from production — the whole point of extracting
/// the inner fn was to remove that hazard.
async fn preference_filtered_unread_count(pool: &SqlitePool, user_address: &str) -> i64 {
    tauri_project_lib::notifications::crud::unread_count_inner(pool, user_address)
        .await
        .unwrap()
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
async fn unread_count_excludes_types_outside_preference_categories() {
    let pool = setup_db().await;
    let alice = "alice";

    // Credits + Files are default preference categories (counted). A
    // notification whose type has no enabled preference row (here "VM") must
    // NOT be counted — it mirrors the frontend list, which shows only enabled
    // categories + Hippius. The old "absent means enabled" rule counted it, so
    // the tray badge read higher (e.g. "99+") than the 97 the bell list showed.
    insert_notification(&pool, alice, Some("Credits"), None, "credit-n1").await;
    insert_notification(&pool, alice, Some("Files"), None, "file-n1").await;
    insert_notification(&pool, alice, Some("VM"), None, "vm-n1").await;

    assert_eq!(preference_filtered_unread_count(&pool, alice).await, 2);
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

// ── create_credit_notifications: chunk boundary regression tests ────────

use tauri_project_lib::notifications::credits::{NotificationInput, create_credit_notifications_inner};

/// Build N synthetic notification inputs for boundary tests.
fn synthetic_notifications(n: usize) -> Vec<NotificationInput> {
    (0..n)
        .map(|i| NotificationInput {
            subtype: format!("subtype-{i}"),
            title: format!("title-{i}"),
            description: format!("description-{i}"),
        })
        .collect()
}

async fn count_credits_for(pool: &SqlitePool, account_id: &str) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM notifications WHERE user_address = ? AND notification_type = 'Credits'")
        .bind(account_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn create_credit_notifications_empty_input_is_noop() {
    let pool = setup_db().await;
    let alice = "alice";

    let inserted = create_credit_notifications_inner(&pool, alice, &[]).await.unwrap();
    assert_eq!(inserted, 0);
    assert_eq!(count_credits_for(&pool, alice).await, 0);
}

/// Boundary: at the chunk size (100) and just over it (101 → two chunks of
/// 100 + 1) we must still insert exactly the input count and use a single
/// transaction (so a failure in chunk 2 wouldn't leave chunk 1 committed).
#[tokio::test]
async fn create_credit_notifications_handles_chunk_boundaries() {
    let pool = setup_db().await;
    let alice = "alice";

    // Exactly one chunk worth.
    let inserted = create_credit_notifications_inner(&pool, alice, &synthetic_notifications(100))
        .await
        .unwrap();
    assert_eq!(inserted, 100);
    assert_eq!(count_credits_for(&pool, alice).await, 100);

    // Spans two chunks (100 + 1).
    let bob = "bob";
    let inserted = create_credit_notifications_inner(&pool, bob, &synthetic_notifications(101))
        .await
        .unwrap();
    assert_eq!(inserted, 101);
    assert_eq!(count_credits_for(&pool, bob).await, 101);

    // Multi-chunk: 250 = 2 × 100 + 50.
    let carol = "carol";
    let inserted = create_credit_notifications_inner(&pool, carol, &synthetic_notifications(250))
        .await
        .unwrap();
    assert_eq!(inserted, 250);
    assert_eq!(count_credits_for(&pool, carol).await, 250);
}
