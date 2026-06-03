//! Local database commands for notifications, address book, onboarding,
//! user preferences, and app state.
//!
//! These commands replace the frontend's sql.js (WASM SQLite) databases:
//! `notificationsDb.ts`, `addressBookDb.ts`, `onboardingDb.ts`,
//! `userPreferencesDb.ts`, and the app_state table.

use crate::app_state::AppState;
use crate::error::AppError;
use tracing::info;

// ── Notification Types ──────────────────────────────────────────────────

/// A single in-app notification record, serialized to the frontend.
///
/// Notifications use soft-delete semantics: `is_deleted` hides them from
/// the UI while preserving the row for analytics and undo.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub id: i64,
    pub user_address: String,
    pub notification_type: Option<String>,
    pub notification_subtype: Option<String>,
    pub title_text: Option<String>,
    pub description: Option<String>,
    pub link_text: Option<String>,
    pub link: Option<String>,
    pub is_unread: bool,
    pub creation_time: Option<i64>,
    pub is_deleted: bool,
    pub deleted_at: Option<i64>,
    pub release_notes: Option<String>,
}

// ── Welcome notification constants ──────────────────────────────────────

/// Subtype for the one-time welcome notification. The `-v1` suffix keeps
/// the existing `LIKE 'Welcome-%'` matcher in
/// [`crate::notifications::credits::process_credit_events`] working, and
/// lets us bump the version if we ever want to re-show a new welcome
/// message to existing users (e.g. `Welcome-v2` after a major
/// onboarding redesign).
const WELCOME_SUBTYPE: &str = "Welcome-v1";

/// Title line shown at the top of the welcome notification card.
const WELCOME_TITLE: &str = "Hello from Hippius! Here's what's new!";

/// Body text for the welcome notification. Previously lived in the FE
/// `AccessKeyLoginForm.tsx` / `callback/page.tsx` callers that have now
/// been deleted in favour of Rust-owned welcome creation.
const WELCOME_DESCRIPTION: &str = "Welcome to Hippius! You're now part of a decentralised storage network. To get started, open the Files tab and upload your data. Each upload uses credits from your balance. You can check your remaining credits at any time in the billing tab, and top up when you need more. When you're ready, tap Check Out to launch your first storage session.";

/// Link label on the welcome notification's call-to-action button.
const WELCOME_LINK_TEXT: &str = "Check Out";

/// Route the welcome call-to-action button navigates to.
const WELCOME_LINK: &str = "/files";

/// Idempotently ensure the given user has exactly one welcome
/// notification.
///
/// Called from both [`crate::auth::login::login_with_mnemonic`] and
/// [`crate::auth::oauth::complete_oauth_flow`] on every successful
/// auth — the user-scoped dedup query makes repeat calls a no-op, so
/// there's no need for an `is_new` flag (which OAuth doesn't expose
/// anyway). The dedup is deliberately broad: matches bare `Welcome`
/// (legacy from the broken FE callers that wrote many duplicates
/// before this fix) OR anything starting with `Welcome-`, so an
/// existing-install user who already has the legacy bare-subtype
/// row isn't shown a second welcome after the upgrade.
///
/// Returns `Ok(())` on both "inserted" and "already exists" paths.
/// DB errors propagate as `AppError::Db`; call sites treat this as
/// non-fatal (log and continue) because a failed welcome
/// notification must not block login.
pub async fn ensure_welcome_notification(pool: &sqlx::SqlitePool, user_address: &str) -> Result<(), AppError> {
    let existing = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications \
         WHERE user_address = ? \
           AND notification_type = 'Hippius' \
           AND (notification_subtype = 'Welcome' OR notification_subtype LIKE 'Welcome-%')",
    )
    .bind(user_address)
    .fetch_one(pool)
    .await?;

    if existing.0 > 0 {
        return Ok(());
    }

    sqlx::query(
        r"
        INSERT INTO notifications (
            user_address, notification_type, notification_subtype,
            title_text, description, link_text, link,
            is_unread, creation_time, is_deleted, release_notes
        )
        VALUES (?, 'Hippius', ?, ?, ?, ?, ?, 1, CAST(strftime('%s','now') * 1000 AS INTEGER), 0, NULL)
        ",
    )
    .bind(user_address)
    .bind(WELCOME_SUBTYPE)
    .bind(WELCOME_TITLE)
    .bind(WELCOME_DESCRIPTION)
    .bind(WELCOME_LINK_TEXT)
    .bind(WELCOME_LINK)
    .execute(pool)
    .await?;

    info!(user_address = %user_address, "Created welcome notification");
    Ok(())
}

/// One-time cleanup that collapses multiple welcome notifications per
/// user down to the oldest one. Runs from `main.rs` startup alongside
/// the other idempotent migrations.
///
/// This exists because the previous FE-driven welcome code was broken:
/// the dedup guard's `starts_with("Welcome-")` check didn't match the
/// bare `"Welcome"` subtype the FE actually sent, so every login
/// inserted a new row. Existing users could have dozens of welcome
/// notifications in their local DB; this helper hard-deletes the
/// duplicates while preserving the earliest one (so the timestamp
/// used by `process_credit_events` for event filtering stays valid).
pub async fn cleanup_duplicate_welcome_notifications(pool: &sqlx::SqlitePool) -> Result<(), AppError> {
    let deleted = sqlx::query(
        "DELETE FROM notifications \
         WHERE id NOT IN ( \
             SELECT MIN(id) FROM notifications \
             WHERE notification_type = 'Hippius' \
               AND (notification_subtype = 'Welcome' OR notification_subtype LIKE 'Welcome-%') \
             GROUP BY user_address \
         ) \
         AND notification_type = 'Hippius' \
         AND (notification_subtype = 'Welcome' OR notification_subtype LIKE 'Welcome-%')",
    )
    .execute(pool)
    .await?;

    let affected = deleted.rows_affected();
    if affected > 0 {
        info!(deleted = affected, "Cleaned up duplicate welcome notifications");
    }
    Ok(())
}

// ── Notification Commands ───────────────────────────────────────────────

/// Insert a new notification. Welcome notifications must be created
/// via [`ensure_welcome_notification`] — this command's dedup guard
/// suppresses any stray caller that tries to insert one via the IPC
/// path directly (defense-in-depth; the FE no longer does this).
/// Returns the new row id, or `0` if the insert was skipped.
#[tauri::command]
#[expect(clippy::too_many_arguments)] // Tauri IPC commands take individual params from frontend
pub async fn add_notification(
    state: tauri::State<'_, AppState>,
    user_address: String,
    notification_type: Option<String>,
    notification_subtype: Option<String>,
    title_text: Option<String>,
    description: Option<String>,
    link_text: Option<String>,
    link: Option<String>,
    creation_time: Option<i64>,
    release_notes: Option<String>,
) -> Result<i64, AppError> {
    let pool = state.pool()?;

    // User-scoped dedup for welcome notifications. The previous guard
    // only matched `starts_with("Welcome-")` and didn't filter by
    // user_address — both broken. See `ensure_welcome_notification`
    // for the canonical path.
    if notification_type.as_deref() == Some("Hippius")
        && let Some(ref subtype) = notification_subtype
        && (subtype == "Welcome" || subtype.starts_with("Welcome-"))
    {
        let existing = sqlx::query_as::<_, (i64,)>(
            "SELECT COUNT(*) FROM notifications \
             WHERE user_address = ? \
               AND notification_type = 'Hippius' \
               AND (notification_subtype = 'Welcome' OR notification_subtype LIKE 'Welcome-%')",
        )
        .bind(&user_address)
        .fetch_one(pool)
        .await?;

        if existing.0 > 0 {
            return Ok(0);
        }
    }

    let result = sqlx::query(
        r"
        INSERT INTO notifications (
            user_address, notification_type, notification_subtype,
            title_text, description, link_text, link,
            is_unread, creation_time, is_deleted, release_notes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, COALESCE(?, CAST(strftime('%s','now') * 1000 AS INTEGER)), 0, ?)
        ",
    )
    .bind(&user_address)
    .bind(&notification_type)
    .bind(&notification_subtype)
    .bind(&title_text)
    .bind(&description)
    .bind(&link_text)
    .bind(&link)
    .bind(creation_time)
    .bind(&release_notes)
    .execute(pool)
    .await?;

    Ok(result.last_insert_rowid())
}

/// List notifications for a user (includes system notifications).
/// Soft-deleted notifications are excluded. Default limit is 50.
#[tauri::command]
pub async fn list_notifications(state: tauri::State<'_, AppState>, limit: Option<i64>) -> Result<Vec<Notification>, AppError> {
    // Scope to the session account, not a caller-supplied address — otherwise an
    // authenticated user could list another account's notifications by passing
    // its ss58. Matches the per-row mutation commands.
    let user_address = state.current_account_id().map_err(AppError::Other)?;
    let pool = state.pool()?;
    let limit = limit.unwrap_or(50);

    let rows = sqlx::query_as::<
        _,
        (
            i64,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            i32,
            Option<i64>,
            i32,
            Option<i64>,
            Option<String>,
        ),
    >(
        r"
        SELECT id, user_address, notification_type, notification_subtype,
               title_text, description, link_text, link,
               is_unread, creation_time, is_deleted, deleted_at, release_notes
        FROM notifications
        WHERE (user_address = ? OR user_address = 'system') AND is_deleted = 0
        ORDER BY creation_time DESC
        LIMIT ?
        ",
    )
    .bind(&user_address)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                user_address,
                notification_type,
                notification_subtype,
                title_text,
                description,
                link_text,
                link,
                is_unread,
                creation_time,
                is_deleted,
                deleted_at,
                release_notes,
            )| Notification {
                id,
                user_address,
                notification_type,
                notification_subtype,
                title_text,
                description,
                link_text,
                link,
                is_unread: is_unread != 0,
                creation_time,
                is_deleted: is_deleted != 0,
                deleted_at,
                release_notes,
            },
        )
        .collect())
}

/// Set the unread flag on one notification, scoped to the caller. Returns rows
/// affected — `0` means the `id` was not the caller's (nor a shared `'system'`
/// row), i.e. a blocked cross-account mutation. The scoping predicate lives here
/// so read/unread share exactly one definition.
async fn set_unread_flag_inner(pool: &sqlx::SqlitePool, user_address: &str, id: i64, is_unread: i64) -> Result<u64, AppError> {
    let r = sqlx::query("UPDATE notifications SET is_unread = ? WHERE id = ? AND (user_address = ? OR user_address = 'system')")
        .bind(is_unread)
        .bind(id)
        .bind(user_address)
        .execute(pool)
        .await?;
    Ok(r.rows_affected())
}

/// Soft-delete one notification, scoped to the caller. Returns rows affected
/// (`0` = not the caller's row).
async fn soft_delete_notification_inner(pool: &sqlx::SqlitePool, user_address: &str, id: i64) -> Result<u64, AppError> {
    let r = sqlx::query(
        "UPDATE notifications SET is_deleted = 1, deleted_at = CAST(strftime('%s','now') * 1000 AS INTEGER) \
         WHERE id = ? AND (user_address = ? OR user_address = 'system')",
    )
    .bind(id)
    .bind(user_address)
    .execute(pool)
    .await?;
    Ok(r.rows_affected())
}

/// Mark a single notification as read. Scoped to the caller so an `id`
/// belonging to another account is a no-op (no cross-account mutation); shared
/// `'system'` rows remain actionable, matching `list_notifications`/`mark_all`.
#[tauri::command]
pub async fn mark_notification_read(state: tauri::State<'_, AppState>, id: i64) -> Result<(), AppError> {
    let user_address = state.current_account_id().map_err(AppError::Other)?;
    set_unread_flag_inner(state.pool()?, &user_address, id, 0).await?;
    Ok(())
}

/// Mark a single notification as unread. Scoped to the caller (see
/// `mark_notification_read`).
#[tauri::command]
pub async fn mark_notification_unread(state: tauri::State<'_, AppState>, id: i64) -> Result<(), AppError> {
    let user_address = state.current_account_id().map_err(AppError::Other)?;
    set_unread_flag_inner(state.pool()?, &user_address, id, 1).await?;
    Ok(())
}

/// Mark all non-deleted notifications as read for a user (includes system).
#[tauri::command]
pub async fn mark_all_notifications_read(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let user_address = state.current_account_id().map_err(AppError::Other)?;
    let pool = state.pool()?;

    sqlx::query("UPDATE notifications SET is_unread = 0 WHERE (user_address = ? OR user_address = 'system') AND is_deleted = 0")
        .bind(&user_address)
        .execute(pool)
        .await?;

    Ok(())
}

/// Soft-delete a single notification. Scoped to the caller (see
/// `mark_notification_read`) so one account cannot delete another's row.
#[tauri::command]
pub async fn delete_notification(state: tauri::State<'_, AppState>, id: i64) -> Result<(), AppError> {
    let user_address = state.current_account_id().map_err(AppError::Other)?;
    soft_delete_notification_inner(state.pool()?, &user_address, id).await?;

    Ok(())
}

/// Soft-delete every notification visible to a user — both rows scoped
/// to their address AND `'system'` rows (Hippius update prompts and
/// other app-wide events). Mirrors the read-side filter in
/// `list_notifications` and `unread_count_inner`, which both pull
/// `user_address = ? OR user_address = 'system'`. Without this match,
/// "Delete All" silently misses what the list shows, and a deleted
/// "Update Available" notification re-surfaces on the next refresh.
#[tauri::command]
pub async fn delete_all_notifications(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let user_address = state.current_account_id().map_err(AppError::Other)?;
    let pool = state.pool()?;

    sqlx::query(
        "UPDATE notifications \
         SET is_deleted = 1, deleted_at = CAST(strftime('%s','now') * 1000 AS INTEGER) \
         WHERE (user_address = ? OR user_address = 'system') \
         AND is_deleted = 0",
    )
    .bind(&user_address)
    .execute(pool)
    .await?;

    Ok(())
}

/// Soft-delete a system notification by its version (notification_subtype).
#[tauri::command]
pub async fn delete_system_notification_by_version(state: tauri::State<'_, AppState>, version: String) -> Result<(), AppError> {
    let pool = state.pool()?;

    sqlx::query(
        "UPDATE notifications SET is_deleted = 1, deleted_at = CAST(strftime('%s','now') * 1000 AS INTEGER) WHERE user_address = 'system' AND notification_subtype = ?",
    )
    .bind(&version)
    .execute(pool)
    .await?;

    Ok(())
}

/// Pool-scoped implementation of [`get_unread_count`], extracted so the
/// integration tests can exercise the production query directly instead
/// of mirroring it. Single round-trip via a correlated subquery so the
/// notification badge counter — which is polled on every screen — costs
/// one pool acquire and one prepared statement.
///
/// Counts notifications whose `notification_type` matches an enabled
/// preference label, plus any "Hippius" system notifications which are
/// always shown regardless of preferences.
pub async fn unread_count_inner(pool: &sqlx::SqlitePool, user_address: &str) -> Result<i64, AppError> {
    let (count,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM notifications \
         WHERE (user_address = ? OR user_address = 'system') \
         AND is_unread = 1 AND is_deleted = 0 \
         AND (notification_type = 'Hippius' \
              OR notification_type IN (SELECT label FROM notification_preferences WHERE enabled = 1))",
    )
    .bind(user_address)
    .fetch_one(pool)
    .await?;
    Ok(count)
}

/// Get the count of unread, non-deleted notifications for a user.
///
/// Thin IPC wrapper over [`unread_count_inner`] so the SQL is exercised
/// directly by the integration tests in `tests/local_db_commands.rs`.
#[tauri::command]
pub async fn get_unread_count(state: tauri::State<'_, AppState>) -> Result<i64, AppError> {
    // Session-scoped (see list_notifications) so one account can't read another's
    // unread count. unread_count_inner keeps its explicit-address param for tests.
    let user_address = state.current_account_id().map_err(AppError::Other)?;
    unread_count_inner(state.pool()?, &user_address).await
}

/// Check if a credit notification with the given timestamp already exists.
#[tauri::command]
pub async fn credit_already_notified(state: tauri::State<'_, AppState>, timestamp: String) -> Result<bool, AppError> {
    let pool = state.pool()?;
    let subtype = format!("MintedAccountCredits-{timestamp}");

    let row = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM notifications WHERE notification_type = 'Credits' AND notification_subtype = ?")
        .bind(&subtype)
        .fetch_one(pool)
        .await?;

    Ok(row.0 > 0)
}

/// Check if a low-credit notification with the given subtype exists.
#[tauri::command]
pub async fn low_credit_subtype_exists(state: tauri::State<'_, AppState>, subtype: String) -> Result<bool, AppError> {
    let pool = state.pool()?;

    let row = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM notifications WHERE notification_type = 'Credits' AND notification_subtype = ?")
        .bind(&subtype)
        .fetch_one(pool)
        .await?;

    Ok(row.0 > 0)
}

/// Check if there is any active (non-deleted) low-credit warning notification
/// FOR THE CALLER. Scoped by the session account so one account's warning never
/// leaks into another's gate. Shares the scoped query with
/// `check_low_credit_notification` via the `credits` helper.
#[tauri::command]
pub async fn has_active_low_credit_notification(state: tauri::State<'_, AppState>) -> Result<bool, AppError> {
    let user_address = state.current_account_id().map_err(AppError::Other)?;
    let pool = state.pool()?;
    Ok(crate::notifications::credits::active_low_credit_count(pool, &user_address).await? > 0)
}

/// Get the deleted_at timestamp of the caller's most recently deleted low-credit
/// warning. Scoped by the session account (see
/// `has_active_low_credit_notification`).
#[tauri::command]
pub async fn get_last_deleted_low_credit_time(state: tauri::State<'_, AppState>) -> Result<Option<i64>, AppError> {
    let user_address = state.current_account_id().map_err(AppError::Other)?;
    let pool = state.pool()?;
    crate::notifications::credits::last_deleted_low_credit_at(pool, &user_address).await
}

/// Check if a Hippius system notification with the given version already exists.
#[tauri::command]
pub async fn hippius_version_notification_exists(state: tauri::State<'_, AppState>, version: String) -> Result<bool, AppError> {
    let pool = state.pool()?;

    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications WHERE user_address = 'system' AND notification_type = 'Hippius' AND notification_subtype = ?",
    )
    .bind(&version)
    .fetch_one(pool)
    .await?;

    Ok(row.0 > 0)
}

/// Hard-delete all notifications. Intended for testing / reset.
#[tauri::command]
pub async fn clear_all_notifications(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    info!("Clearing all notifications");
    let pool = state.pool()?;

    sqlx::query("DELETE FROM notifications").execute(pool).await?;

    Ok(())
}

// ── Notification Preferences ────────────────────────────────────────────

/// A user-configurable notification category toggle (e.g. "Credits").
///
/// Enabled preferences gate which `notification_type` values appear in the
/// unread badge count and notification list. "Hippius" system notifications
/// bypass this filter and are always shown.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPreference {
    pub id: String,
    pub label: String,
    pub description: String,
    pub enabled: bool,
}

/// Payload for a single preference toggle update from the frontend.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceUpdate {
    pub id: String,
    pub enabled: bool,
}

/// Get all notification preference entries.
#[tauri::command]
pub async fn get_local_notification_preferences(state: tauri::State<'_, AppState>) -> Result<Vec<NotificationPreference>, AppError> {
    let pool = state.pool()?;

    let rows = sqlx::query_as::<_, (String, String, String, i32)>("SELECT id, label, description, enabled FROM notification_preferences")
        .fetch_all(pool)
        .await?;

    Ok(rows
        .into_iter()
        .map(|(id, label, description, enabled)| NotificationPreference {
            id,
            label,
            description,
            enabled: enabled != 0,
        })
        .collect())
}

/// Update notification preferences in a transaction.
#[tauri::command]
pub async fn update_local_notification_preferences(state: tauri::State<'_, AppState>, preferences: Vec<PreferenceUpdate>) -> Result<(), AppError> {
    let pool = state.pool()?;

    let mut tx = pool.begin().await?;

    for pref in &preferences {
        let enabled_val: i32 = i32::from(pref.enabled);
        sqlx::query("UPDATE notification_preferences SET enabled = ? WHERE id = ?")
            .bind(enabled_val)
            .bind(&pref.id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;

    Ok(())
}

/// Get the labels of all enabled notification types.
#[tauri::command]
pub async fn get_local_enabled_notification_types(state: tauri::State<'_, AppState>) -> Result<Vec<String>, AppError> {
    let pool = state.pool()?;

    let rows = sqlx::query_as::<_, (String,)>("SELECT label FROM notification_preferences WHERE enabled = 1")
        .fetch_all(pool)
        .await?;

    Ok(rows.into_iter().map(|(label,)| label).collect())
}

// ── App State ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    use tempfile::TempDir;

    async fn fresh_pool() -> (TempDir, sqlx::SqlitePool) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("test.db");
        let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", db_path.display()))
            .expect("opts")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.expect("pool");
        crate::utils::schema::ensure_table_schema(&pool).await.expect("schema");
        (dir, pool)
    }

    async fn insert_notif(pool: &sqlx::SqlitePool, user: &str) -> i64 {
        sqlx::query("INSERT INTO notifications (user_address, is_unread, is_deleted, creation_time) VALUES (?, 1, 0, 1)")
            .bind(user)
            .execute(pool)
            .await
            .expect("insert")
            .last_insert_rowid()
    }

    // A by-id mutation must not cross accounts: B cannot mark or delete A's
    // personal row (0 rows affected), but shared 'system' rows stay actionable
    // for everyone — matching list_notifications/mark_all visibility.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn by_id_mutations_are_scoped_to_caller() {
        let (_dir, pool) = fresh_pool().await;
        let a_id = insert_notif(&pool, "addrA").await;
        let sys_id = insert_notif(&pool, "system").await;

        // B cannot touch A's personal notification.
        assert_eq!(set_unread_flag_inner(&pool, "addrB", a_id, 0).await.unwrap(), 0);
        assert_eq!(soft_delete_notification_inner(&pool, "addrB", a_id).await.unwrap(), 0);
        // A can.
        assert_eq!(set_unread_flag_inner(&pool, "addrA", a_id, 0).await.unwrap(), 1);
        // System rows remain actionable by any account.
        assert_eq!(set_unread_flag_inner(&pool, "addrB", sys_id, 0).await.unwrap(), 1);
    }
}
