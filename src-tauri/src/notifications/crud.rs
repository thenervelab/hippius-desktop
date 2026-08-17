//! Local database commands for notifications, address book, onboarding,
//! user preferences, and app state.

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

/// Body text for the welcome notification. Owned in Rust so welcome creation
/// has a single source of truth rather than being duplicated across FE callers.
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
/// OR anything starting with `Welcome-`, so a user who already has a
/// bare-subtype row isn't shown a second welcome.
///
/// Returns `Ok(())` on both "inserted" and "already exists" paths.
/// DB errors propagate as `AppError::Db`; call sites treat this as
/// non-fatal (log and continue) because a failed welcome
/// notification must not block login.
pub async fn ensure_welcome_notification(pool: &sqlx::SqlitePool, user_address: &str) -> Result<(), AppError> {
    let existing: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM notifications \
         WHERE user_address = ? \
           AND notification_type = 'Hippius' \
           AND (notification_subtype = 'Welcome' OR notification_subtype LIKE 'Welcome-%') \
         LIMIT 1",
    )
    .bind(user_address)
    .fetch_optional(pool)
    .await?;

    if existing.is_some() {
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
/// Existing users can carry duplicate welcome rows in their local DB; this
/// helper hard-deletes the duplicates while preserving the earliest one so the
/// timestamp `process_credit_events` uses for event filtering stays valid.
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

/// Soft-deleted rows older than this are hard-deleted (except the latest
/// `LowCreditWarning-%` per user, which the one-per-day throttle reads).
pub const DELETED_NOTIFICATION_RETENTION_MS: i64 = 90 * 24 * 60 * 60 * 1000;

/// Hard-delete old soft-deleted notification rows. Keeps live rows and the
/// newest deleted `LowCreditWarning-%` per `user_address`.
pub async fn prune_deleted_notifications(pool: &sqlx::SqlitePool) -> Result<u64, AppError> {
    let cutoff = chrono::Utc::now().timestamp_millis() - DELETED_NOTIFICATION_RETENTION_MS;
    prune_deleted_notifications_before(pool, cutoff).await
}

pub(crate) async fn prune_deleted_notifications_before(pool: &sqlx::SqlitePool, cutoff_ms: i64) -> Result<u64, AppError> {
    let other = sqlx::query(
        "DELETE FROM notifications
          WHERE is_deleted = 1
            AND deleted_at IS NOT NULL
            AND deleted_at < ?
            AND (notification_subtype IS NULL OR notification_subtype NOT LIKE 'LowCreditWarning-%')",
    )
    .bind(cutoff_ms)
    .execute(pool)
    .await?;

    let warnings = sqlx::query(
        "DELETE FROM notifications
          WHERE is_deleted = 1
            AND deleted_at IS NOT NULL
            AND deleted_at < ?
            AND notification_subtype LIKE 'LowCreditWarning-%'
            AND id NOT IN (
                SELECT id FROM (
                    SELECT n.id FROM notifications n
                     WHERE n.is_deleted = 1
                       AND n.notification_subtype LIKE 'LowCreditWarning-%'
                       AND n.deleted_at = (
                           SELECT MAX(n2.deleted_at) FROM notifications n2
                            WHERE n2.user_address = n.user_address
                              AND n2.is_deleted = 1
                              AND n2.notification_subtype LIKE 'LowCreditWarning-%'
                       )
                )
            )",
    )
    .bind(cutoff_ms)
    .execute(pool)
    .await?;

    Ok(other.rows_affected() + warnings.rows_affected())
}

// ── Notification Commands ───────────────────────────────────────────────

/// Insert a new notification. Welcome notifications must be created
/// via [`ensure_welcome_notification`] — this command's dedup guard
/// suppresses any stray caller that tries to insert one via the IPC
/// path directly (defense-in-depth). Returns the new row id, or `0`
/// if the insert was skipped.
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
    // Scope the write to the signed-in account; never trust the caller-supplied
    // address. Mirrors list_notifications.
    let user_address = crate::notifications::session_scoped_notification_account(state.inner(), &user_address)?;
    let pool = state.pool()?;

    // User-scoped dedup for welcome notifications: match both the bare
    // `Welcome` subtype and `Welcome-%`, scoped by user_address so the guard
    // only collapses this user's duplicates. See `ensure_welcome_notification`
    // for the canonical path.
    if notification_type.as_deref() == Some("Hippius")
        && let Some(ref subtype) = notification_subtype
        && (subtype == "Welcome" || subtype.starts_with("Welcome-"))
    {
        let existing: Option<(i64,)> = sqlx::query_as(
            "SELECT 1 FROM notifications \
             WHERE user_address = ? \
               AND notification_type = 'Hippius' \
               AND (notification_subtype = 'Welcome' OR notification_subtype LIKE 'Welcome-%') \
             LIMIT 1",
        )
        .bind(&user_address)
        .fetch_optional(pool)
        .await?;

        if existing.is_some() {
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
    let user_address = state.current_account_id()?;
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
    let user_address = state.current_account_id()?;
    set_unread_flag_inner(state.pool()?, &user_address, id, 0).await?;
    Ok(())
}

/// Mark a single notification as unread. Scoped to the caller (see
/// `mark_notification_read`).
#[tauri::command]
pub async fn mark_notification_unread(state: tauri::State<'_, AppState>, id: i64) -> Result<(), AppError> {
    let user_address = state.current_account_id()?;
    set_unread_flag_inner(state.pool()?, &user_address, id, 1).await?;
    Ok(())
}

/// Mark all non-deleted notifications as read for a user (includes system).
#[tauri::command]
pub async fn mark_all_notifications_read(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let user_address = state.current_account_id()?;
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
    let user_address = state.current_account_id()?;
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
    let user_address = state.current_account_id()?;
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
    // Require an active session (audit NOTIF-2) so a logged-out/out-of-band
    // caller can't suppress an app-wide system notice (e.g. "Update Available").
    let _ = state.current_account_id()?;
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
/// of mirroring it.
///
/// Counts the unread notifications the user actually sees in the list: rows
/// whose `notification_type` is an ENABLED preference category, plus any
/// "Hippius" system notifications (always shown regardless of preferences).
/// This mirrors the frontend `buildNotificationView` (`type IN enabledTypes
/// OR type == 'Hippius'`) so the tray badge matches the main-window bell.
///
/// Defaults are seeded first (idempotent `INSERT OR IGNORE`) so the `enabled =
/// 1` set exists for a fresh account; only the tray popover polls this, so the
/// extra write is negligible. The earlier rule — `NOT IN (... enabled = 0)`,
/// "absent means enabled" — over-counted: notifications of types outside the
/// preference categories (e.g. non-Credits/Files) were tallied here but hidden
/// in the list, so the badge read higher than the visible unread count.
///
/// The preference subquery is scoped to `user_address` (the `owner` column) so
/// a category another account disabled cannot suppress this account's badge.
pub async fn unread_count_inner(pool: &sqlx::SqlitePool, user_address: &str) -> Result<i64, AppError> {
    seed_default_preferences(pool, user_address).await?;
    let (count,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM notifications \
         WHERE (user_address = ? OR user_address = 'system') \
         AND is_unread = 1 AND is_deleted = 0 \
         AND (notification_type = 'Hippius' \
              OR notification_type IN (SELECT label FROM notification_preferences WHERE owner = ? AND enabled = 1))",
    )
    .bind(user_address)
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
    let user_address = state.current_account_id()?;
    unread_count_inner(state.pool()?, &user_address).await
}

/// Check if a credit notification with the given timestamp already exists.
#[tauri::command]
pub async fn credit_already_notified(state: tauri::State<'_, AppState>, timestamp: String) -> Result<bool, AppError> {
    // Scope to the active account (audit NOTIF-1): credit notifications are
    // per-account, so an unscoped probe leaked one account's credit timing to
    // another and could wrongly suppress the caller's own notification.
    let user_address = state.current_account_id()?;
    let pool = state.pool()?;
    let subtype = format!("MintedAccountCredits-{timestamp}");

    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications WHERE user_address = ? AND notification_type = 'Credits' AND notification_subtype = ?",
    )
    .bind(&user_address)
    .bind(&subtype)
    .fetch_one(pool)
    .await?;

    Ok(row.0 > 0)
}

/// Check if a low-credit notification with the given subtype exists.
#[tauri::command]
pub async fn low_credit_subtype_exists(state: tauri::State<'_, AppState>, subtype: String) -> Result<bool, AppError> {
    // Scope to the active account (audit NOTIF-1).
    let user_address = state.current_account_id()?;
    let pool = state.pool()?;

    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications WHERE user_address = ? AND notification_type = 'Credits' AND notification_subtype = ?",
    )
    .bind(&user_address)
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
    let user_address = state.current_account_id()?;
    let pool = state.pool()?;
    Ok(crate::notifications::credits::active_low_credit_count(pool, &user_address).await? > 0)
}

/// Get the deleted_at timestamp of the caller's most recently deleted low-credit
/// warning. Scoped by the session account (see
/// `has_active_low_credit_notification`).
#[tauri::command]
pub async fn get_last_deleted_low_credit_time(state: tauri::State<'_, AppState>) -> Result<Option<i64>, AppError> {
    let user_address = state.current_account_id()?;
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

/// Hard-delete the active account's notifications. Scoped to the caller
/// (audit NOTIF-3) — the previous unscoped `DELETE FROM notifications` wiped
/// every account's history on a multi-account device. `'system'` rows are
/// preserved (app-wide notices, not the caller's to purge).
#[tauri::command]
pub async fn clear_all_notifications(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let user_address = state.current_account_id()?;
    info!("Clearing all notifications for the active account");
    let pool = state.pool()?;

    sqlx::query("DELETE FROM notifications WHERE user_address = ?")
        .bind(&user_address)
        .execute(pool)
        .await?;

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

/// Default notification categories, seeded per account on first use.
///
/// Each tuple is `(id, label, description)`. These live here rather than in the
/// schema because the rows are per-account and the account set isn't known at
/// schema-init time — the commands below seed them for the session account on
/// demand.
const DEFAULT_PREFERENCES: &[(&str, &str, &str)] = &[
    (
        "credits",
        "Credits",
        "Notifications for account credits, including low balance warnings and credit additions",
    ),
    (
        "files",
        "Files",
        "Notifications for file operations including sync completion and failures",
    ),
];

/// Seed the default preference rows for `owner` if absent.
///
/// Idempotent via `INSERT OR IGNORE` on the `(owner, id)` primary key, so a
/// user's existing toggles are never reset by a later seed call. Runs as a
/// single multi-row statement (one round-trip) because the read commands call
/// it on every preferences fetch — one statement, not one per default. (A
/// larger follow-up could move seeding to login and keep the reads pure.)
async fn seed_default_preferences(pool: &sqlx::SqlitePool, owner: &str) -> Result<(), AppError> {
    let rows = DEFAULT_PREFERENCES.iter().map(|_| "(?, ?, ?, ?, 1)").collect::<Vec<_>>().join(", ");
    let sql = format!("INSERT OR IGNORE INTO notification_preferences (owner, id, label, description, enabled) VALUES {rows}");
    let mut q = sqlx::query(&sql);
    for (id, label, description) in DEFAULT_PREFERENCES {
        q = q.bind(owner).bind(id).bind(label).bind(description);
    }
    q.execute(pool).await?;
    Ok(())
}

/// Account-scoped read of every preference row (defaults seeded first).
async fn get_preferences_inner(pool: &sqlx::SqlitePool, owner: &str) -> Result<Vec<NotificationPreference>, AppError> {
    seed_default_preferences(pool, owner).await?;
    let rows =
        sqlx::query_as::<_, (String, String, String, i32)>("SELECT id, label, description, enabled FROM notification_preferences WHERE owner = ?")
            .bind(owner)
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

/// Account-scoped preference toggle update (defaults seeded first so toggling a
/// not-yet-seeded category persists instead of being a silent no-op UPDATE).
async fn set_preferences_inner(pool: &sqlx::SqlitePool, owner: &str, preferences: &[PreferenceUpdate]) -> Result<(), AppError> {
    seed_default_preferences(pool, owner).await?;
    let mut tx = pool.begin().await?;
    for pref in preferences {
        let enabled_val: i32 = i32::from(pref.enabled);
        sqlx::query("UPDATE notification_preferences SET enabled = ? WHERE owner = ? AND id = ?")
            .bind(enabled_val)
            .bind(owner)
            .bind(&pref.id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Account-scoped labels of enabled categories (defaults seeded first).
async fn enabled_types_inner(pool: &sqlx::SqlitePool, owner: &str) -> Result<Vec<String>, AppError> {
    seed_default_preferences(pool, owner).await?;
    let rows = sqlx::query_as::<_, (String,)>("SELECT label FROM notification_preferences WHERE owner = ? AND enabled = 1")
        .bind(owner)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|(label,)| label).collect())
}

/// Get all notification preference entries for the active account.
#[tauri::command]
pub async fn get_local_notification_preferences(state: tauri::State<'_, AppState>) -> Result<Vec<NotificationPreference>, AppError> {
    let owner = state.current_account_id()?;
    get_preferences_inner(state.pool()?, &owner).await
}

/// Update notification preferences for the active account in a transaction.
#[tauri::command]
pub async fn update_local_notification_preferences(state: tauri::State<'_, AppState>, preferences: Vec<PreferenceUpdate>) -> Result<(), AppError> {
    let owner = state.current_account_id()?;
    set_preferences_inner(state.pool()?, &owner, &preferences).await
}

/// Get the labels of all enabled notification types for the active account.
#[tauri::command]
pub async fn get_local_enabled_notification_types(state: tauri::State<'_, AppState>) -> Result<Vec<String>, AppError> {
    let owner = state.current_account_id()?;
    enabled_types_inner(state.pool()?, &owner).await
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

    // The cross-account bug: one account's category toggle must not change
    // another account's preferences on a shared multi-account device.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn preferences_are_scoped_per_account() {
        let (_dir, pool) = fresh_pool().await;

        // A disables Credits.
        set_preferences_inner(
            &pool,
            "addrA",
            &[PreferenceUpdate {
                id: "credits".into(),
                enabled: false,
            }],
        )
        .await
        .unwrap();

        // A sees Credits disabled; B (defaults seeded on read) still enabled.
        let a = get_preferences_inner(&pool, "addrA").await.unwrap();
        assert!(
            !a.iter().find(|p| p.id == "credits").expect("A credits row").enabled,
            "A's Credits must be disabled"
        );
        let b = get_preferences_inner(&pool, "addrB").await.unwrap();
        assert!(
            b.iter().find(|p| p.id == "credits").expect("B credits row").enabled,
            "B's Credits must remain enabled (no cross-account leak)"
        );

        // The enabled-labels view used by the FE filter reflects the same scoping.
        let a_enabled = enabled_types_inner(&pool, "addrA").await.unwrap();
        assert!(!a_enabled.iter().any(|l| l == "Credits"), "A's enabled set must exclude Credits");
        let b_enabled = enabled_types_inner(&pool, "addrB").await.unwrap();
        assert!(b_enabled.iter().any(|l| l == "Credits"), "B's enabled set must include Credits");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn prune_deleted_keeps_live_and_latest_low_credit() {
        let (_dir, pool) = fresh_pool().await;
        let now = 1_800_000_000_000i64;
        let cutoff = now - 1_000;
        let old = cutoff - 50;

        sqlx::query(
            "INSERT INTO notifications (user_address, notification_type, notification_subtype, is_unread, is_deleted, deleted_at, creation_time)
             VALUES
               ('A', 'Files', 'FileSyncComplete-1', 0, 1, ?, 1),
               ('A', 'Hippius', 'Welcome', 1, 0, NULL, 2),
               ('A', 'Credits', 'LowCreditWarning-old', 0, 1, ?, 3),
               ('A', 'Credits', 'LowCreditWarning-new', 0, 1, ?, 4),
               ('B', 'Credits', 'LowCreditWarning-b', 0, 1, ?, 5)",
        )
        .bind(old)
        .bind(old)
        .bind(old + 10)
        .bind(old)
        .execute(&pool)
        .await
        .unwrap();

        let n = prune_deleted_notifications_before(&pool, cutoff).await.unwrap();
        assert!(n >= 1);

        let remaining: Vec<(String, String, i64)> =
            sqlx::query_as("SELECT user_address, notification_subtype, is_deleted FROM notifications ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap();
        let keys: Vec<(String, String, i64)> = remaining;
        assert!(
            keys.iter().any(|(u, s, d)| u == "A" && s == "Welcome" && *d == 0),
            "live welcome must remain: {keys:?}"
        );
        assert!(
            keys.iter().any(|(u, s, _)| u == "A" && s == "LowCreditWarning-new"),
            "latest A low-credit must remain: {keys:?}"
        );
        assert!(
            !keys.iter().any(|(u, s, _)| u == "A" && s == "LowCreditWarning-old"),
            "older A low-credit must go: {keys:?}"
        );
        assert!(
            keys.iter().any(|(u, s, _)| u == "B" && s == "LowCreditWarning-b"),
            "B's latest must remain: {keys:?}"
        );
        assert!(
            !keys.iter().any(|(u, s, _)| u == "A" && s == "FileSyncComplete-1"),
            "old soft-deleted Files row must go: {keys:?}"
        );
    }
}
