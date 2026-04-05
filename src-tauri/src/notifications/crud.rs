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
#[expect(clippy::struct_field_names)] // field names match the DB schema and frontend API
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

// ── Notification Commands ───────────────────────────────────────────────

/// Insert a new notification. If notification_type is "Hippius" and subtype
/// matches "Welcome-*", skip if one already exists (prevents welcome duplicates).
/// Returns the new row id.
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

    if notification_type.as_deref() == Some("Hippius")
        && let Some(ref subtype) = notification_subtype
        && subtype.starts_with("Welcome-")
    {
        let existing =
            sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM notifications WHERE notification_type = 'Hippius' AND notification_subtype = ?")
                .bind(subtype)
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
pub async fn list_notifications(state: tauri::State<'_, AppState>, user_address: String, limit: Option<i64>) -> Result<Vec<Notification>, AppError> {
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

/// Mark a single notification as read.
#[tauri::command]
pub async fn mark_notification_read(state: tauri::State<'_, AppState>, id: i64) -> Result<(), AppError> {
    let pool = state.pool()?;

    sqlx::query("UPDATE notifications SET is_unread = 0 WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;

    Ok(())
}

/// Mark a single notification as unread.
#[tauri::command]
pub async fn mark_notification_unread(state: tauri::State<'_, AppState>, id: i64) -> Result<(), AppError> {
    let pool = state.pool()?;

    sqlx::query("UPDATE notifications SET is_unread = 1 WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;

    Ok(())
}

/// Mark all non-deleted notifications as read for a user (includes system).
#[tauri::command]
pub async fn mark_all_notifications_read(state: tauri::State<'_, AppState>, user_address: String) -> Result<(), AppError> {
    let pool = state.pool()?;

    sqlx::query("UPDATE notifications SET is_unread = 0 WHERE (user_address = ? OR user_address = 'system') AND is_deleted = 0")
        .bind(&user_address)
        .execute(pool)
        .await?;

    Ok(())
}

/// Soft-delete a single notification.
#[tauri::command]
pub async fn delete_notification(state: tauri::State<'_, AppState>, id: i64) -> Result<(), AppError> {
    let pool = state.pool()?;

    sqlx::query("UPDATE notifications SET is_deleted = 1, deleted_at = CAST(strftime('%s','now') * 1000 AS INTEGER) WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;

    Ok(())
}

/// Soft-delete all notifications for a user.
#[tauri::command]
pub async fn delete_all_notifications(state: tauri::State<'_, AppState>, user_address: String) -> Result<(), AppError> {
    let pool = state.pool()?;

    sqlx::query("UPDATE notifications SET is_deleted = 1, deleted_at = CAST(strftime('%s','now') * 1000 AS INTEGER) WHERE user_address = ?")
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

/// Get the count of unread, non-deleted notifications for a user.
///
/// Only counts notifications whose `notification_type` matches an enabled
/// preference label, plus any "Hippius" system notifications which are
/// always shown regardless of preferences.
#[tauri::command]
pub async fn get_unread_count(state: tauri::State<'_, AppState>, user_address: String) -> Result<i64, AppError> {
    let pool = state.pool()?;

    // Fetch enabled notification type labels (e.g. ["Credits"])
    let enabled: Vec<String> = sqlx::query_as::<_, (String,)>("SELECT label FROM notification_preferences WHERE enabled = 1")
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|(l,)| l)
        .collect();

    if enabled.is_empty() {
        // Only count system ("Hippius") notifications when no types enabled
        let row = sqlx::query_as::<_, (i64,)>(
            "SELECT COUNT(*) FROM notifications \
             WHERE (user_address = ? OR user_address = 'system') \
             AND is_unread = 1 AND is_deleted = 0 \
             AND notification_type = 'Hippius'",
        )
        .bind(&user_address)
        .fetch_one(pool)
        .await?;
        return Ok(row.0);
    }

    // Build placeholders for the IN clause
    let placeholders: Vec<&str> = enabled.iter().map(|_| "?").collect();
    let in_clause = placeholders.join(", ");
    let query = format!(
        "SELECT COUNT(*) FROM notifications \
         WHERE (user_address = ? OR user_address = 'system') \
         AND is_unread = 1 AND is_deleted = 0 \
         AND (notification_type IN ({in_clause}) OR notification_type = 'Hippius')"
    );

    let mut q = sqlx::query_as::<_, (i64,)>(&query).bind(&user_address);
    for label in &enabled {
        q = q.bind(label);
    }

    let row = q.fetch_one(pool).await?;

    Ok(row.0)
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

/// Check if there is any active (non-deleted) low-credit warning notification.
#[tauri::command]
pub async fn has_active_low_credit_notification(state: tauri::State<'_, AppState>) -> Result<bool, AppError> {
    let pool = state.pool()?;

    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications WHERE notification_type = 'Credits' AND notification_subtype LIKE 'LowCreditWarning-%' AND is_deleted = 0",
    )
    .fetch_one(pool)
    .await?;

    Ok(row.0 > 0)
}

/// Get the deleted_at timestamp of the most recently deleted low-credit warning.
#[tauri::command]
pub async fn get_last_deleted_low_credit_time(state: tauri::State<'_, AppState>) -> Result<Option<i64>, AppError> {
    let pool = state.pool()?;

    let row = sqlx::query_as::<_, (Option<i64>,)>(
        "SELECT deleted_at FROM notifications WHERE notification_type = 'Credits' AND notification_subtype LIKE 'LowCreditWarning-%' AND is_deleted = 1 ORDER BY deleted_at DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;

    Ok(row.and_then(|(v,)| v))
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
