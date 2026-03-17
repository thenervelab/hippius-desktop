//! Local database commands for notifications, address book, onboarding,
//! user preferences, and app state.
//!
//! These commands replace the frontend's sql.js (WASM SQLite) databases:
//! `notificationsDb.ts`, `addressBookDb.ts`, `onboardingDb.ts`,
//! `userPreferencesDb.ts`, and the app_state table.

use crate::app_state::AppState;

// ── Notification Types ──────────────────────────────────────────────────

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

// ── Notification Commands ───────────────────────────────────────────────

/// Insert a new notification. If notification_type is "Hippius" and subtype
/// matches "Welcome-*", skip if one already exists (prevents welcome duplicates).
/// Returns the new row id.
#[tauri::command]
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
) -> Result<i64, String> {
    let pool = state.pool()?;

    // Prevent duplicate welcome notifications
    if notification_type.as_deref() == Some("Hippius") {
        if let Some(ref subtype) = notification_subtype {
            if subtype.starts_with("Welcome-") {
                let existing = sqlx::query_as::<_, (i64,)>(
                    "SELECT COUNT(*) FROM notifications WHERE notification_type = 'Hippius' AND notification_subtype = ?",
                )
                .bind(subtype)
                .fetch_one(pool)
                .await
                .map_err(|e| format!("Failed to check welcome notification: {e}"))?;

                if existing.0 > 0 {
                    return Ok(0);
                }
            }
        }
    }

    let result = sqlx::query(
        r#"
        INSERT INTO notifications (
            user_address, notification_type, notification_subtype,
            title_text, description, link_text, link,
            is_unread, creation_time, is_deleted, release_notes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, COALESCE(?, CAST(strftime('%s','now') * 1000 AS INTEGER)), 0, ?)
        "#,
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
    .await
    .map_err(|e| format!("Failed to add notification: {e}"))?;

    Ok(result.last_insert_rowid())
}

/// List notifications for a user (includes system notifications).
/// Soft-deleted notifications are excluded. Default limit is 50.
#[tauri::command]
pub async fn list_notifications(
    state: tauri::State<'_, AppState>,
    user_address: String,
    limit: Option<i64>,
) -> Result<Vec<Notification>, String> {
    let pool = state.pool()?;
    let limit = limit.unwrap_or(50);

    let rows = sqlx::query_as::<_, (
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
    )>(
        r#"
        SELECT id, user_address, notification_type, notification_subtype,
               title_text, description, link_text, link,
               is_unread, creation_time, is_deleted, deleted_at, release_notes
        FROM notifications
        WHERE (user_address = ? OR user_address = 'system') AND is_deleted = 0
        ORDER BY creation_time DESC
        LIMIT ?
        "#,
    )
    .bind(&user_address)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to list notifications: {e}"))?;

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
pub async fn mark_notification_read(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    let pool = state.pool()?;

    sqlx::query("UPDATE notifications SET is_unread = 0 WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to mark notification read: {e}"))?;

    Ok(())
}

/// Mark a single notification as unread.
#[tauri::command]
pub async fn mark_notification_unread(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    let pool = state.pool()?;

    sqlx::query("UPDATE notifications SET is_unread = 1 WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to mark notification unread: {e}"))?;

    Ok(())
}

/// Mark all non-deleted notifications as read for a user (includes system).
#[tauri::command]
pub async fn mark_all_notifications_read(state: tauri::State<'_, AppState>, user_address: String) -> Result<(), String> {
    let pool = state.pool()?;

    sqlx::query(
        "UPDATE notifications SET is_unread = 0 WHERE (user_address = ? OR user_address = 'system') AND is_deleted = 0",
    )
    .bind(&user_address)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to mark all notifications read: {e}"))?;

    Ok(())
}

/// Soft-delete a single notification.
#[tauri::command]
pub async fn delete_notification(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    let pool = state.pool()?;

    sqlx::query(
        "UPDATE notifications SET is_deleted = 1, deleted_at = CAST(strftime('%s','now') * 1000 AS INTEGER) WHERE id = ?",
    )
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to delete notification: {e}"))?;

    Ok(())
}

/// Soft-delete all notifications for a user.
#[tauri::command]
pub async fn delete_all_notifications(state: tauri::State<'_, AppState>, user_address: String) -> Result<(), String> {
    let pool = state.pool()?;

    sqlx::query(
        "UPDATE notifications SET is_deleted = 1, deleted_at = CAST(strftime('%s','now') * 1000 AS INTEGER) WHERE user_address = ?",
    )
    .bind(&user_address)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to delete all notifications: {e}"))?;

    Ok(())
}

/// Soft-delete a system notification by its version (notification_subtype).
#[tauri::command]
pub async fn delete_system_notification_by_version(state: tauri::State<'_, AppState>, version: String) -> Result<(), String> {
    let pool = state.pool()?;

    sqlx::query(
        "UPDATE notifications SET is_deleted = 1, deleted_at = CAST(strftime('%s','now') * 1000 AS INTEGER) WHERE user_address = 'system' AND notification_subtype = ?",
    )
    .bind(&version)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to delete system notification: {e}"))?;

    Ok(())
}

/// Get the count of unread, non-deleted notifications for a user (includes system).
#[tauri::command]
pub async fn get_unread_count(state: tauri::State<'_, AppState>, user_address: String) -> Result<i64, String> {
    let pool = state.pool()?;

    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications WHERE (user_address = ? OR user_address = 'system') AND is_unread = 1 AND is_deleted = 0",
    )
    .bind(&user_address)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to get unread count: {e}"))?;

    Ok(row.0)
}

/// Check if a credit notification with the given timestamp already exists.
#[tauri::command]
pub async fn credit_already_notified(state: tauri::State<'_, AppState>, timestamp: String) -> Result<bool, String> {
    let pool = state.pool()?;
    let subtype = format!("MintedAccountCredits-{}", timestamp);

    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications WHERE notification_type = 'Credits' AND notification_subtype = ?",
    )
    .bind(&subtype)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to check credit notification: {e}"))?;

    Ok(row.0 > 0)
}

/// Check if a low-credit notification with the given subtype exists.
#[tauri::command]
pub async fn low_credit_subtype_exists(state: tauri::State<'_, AppState>, subtype: String) -> Result<bool, String> {
    let pool = state.pool()?;

    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications WHERE notification_type = 'Credits' AND notification_subtype = ?",
    )
    .bind(&subtype)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to check low credit subtype: {e}"))?;

    Ok(row.0 > 0)
}

/// Check if there is any active (non-deleted) low-credit warning notification.
#[tauri::command]
pub async fn has_active_low_credit_notification(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let pool = state.pool()?;

    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications WHERE notification_type = 'Credits' AND notification_subtype LIKE 'LowCreditWarning-%' AND is_deleted = 0",
    )
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to check active low credit notification: {e}"))?;

    Ok(row.0 > 0)
}

/// Get the deleted_at timestamp of the most recently deleted low-credit warning.
#[tauri::command]
pub async fn get_last_deleted_low_credit_time(state: tauri::State<'_, AppState>) -> Result<Option<i64>, String> {
    let pool = state.pool()?;

    let row = sqlx::query_as::<_, (Option<i64>,)>(
        "SELECT deleted_at FROM notifications WHERE notification_type = 'Credits' AND notification_subtype LIKE 'LowCreditWarning-%' AND is_deleted = 1 ORDER BY deleted_at DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to get last deleted low credit time: {e}"))?;

    Ok(row.and_then(|(v,)| v))
}

/// Check if a Hippius system notification with the given version already exists.
#[tauri::command]
pub async fn hippius_version_notification_exists(state: tauri::State<'_, AppState>, version: String) -> Result<bool, String> {
    let pool = state.pool()?;

    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications WHERE user_address = 'system' AND notification_type = 'Hippius' AND notification_subtype = ?",
    )
    .bind(&version)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to check hippius version notification: {e}"))?;

    Ok(row.0 > 0)
}

/// Hard-delete all notifications. Intended for testing / reset.
#[tauri::command]
pub async fn clear_all_notifications(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let pool = state.pool()?;

    sqlx::query("DELETE FROM notifications")
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to clear all notifications: {e}"))?;

    Ok(())
}

// ── Notification Preferences ────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPreference {
    pub id: String,
    pub label: String,
    pub description: String,
    pub enabled: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceUpdate {
    pub id: String,
    pub enabled: bool,
}

/// Get all notification preference entries.
#[tauri::command]
pub async fn get_local_notification_preferences(state: tauri::State<'_, AppState>) -> Result<Vec<NotificationPreference>, String> {
    let pool = state.pool()?;

    let rows = sqlx::query_as::<_, (String, String, String, i32)>(
        "SELECT id, label, description, enabled FROM notification_preferences",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to get notification preferences: {e}"))?;

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
pub async fn update_local_notification_preferences(
    state: tauri::State<'_, AppState>,
    preferences: Vec<PreferenceUpdate>,
) -> Result<(), String> {
    let pool = state.pool()?;

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("Failed to begin transaction: {e}"))?;

    for pref in &preferences {
        let enabled_val: i32 = if pref.enabled { 1 } else { 0 };
        sqlx::query("UPDATE notification_preferences SET enabled = ? WHERE id = ?")
            .bind(enabled_val)
            .bind(&pref.id)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("Failed to update preference '{}': {e}", pref.id))?;
    }

    tx.commit()
        .await
        .map_err(|e| format!("Failed to commit transaction: {e}"))?;

    Ok(())
}

/// Get the labels of all enabled notification types.
#[tauri::command]
pub async fn get_local_enabled_notification_types(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let pool = state.pool()?;

    let rows = sqlx::query_as::<_, (String,)>(
        "SELECT label FROM notification_preferences WHERE enabled = 1",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to get enabled notification types: {e}"))?;

    Ok(rows.into_iter().map(|(label,)| label).collect())
}

// ── App State ───────────────────────────────────────────────────────────

/// Check if this is the user's first time opening the app.
#[tauri::command]
pub async fn is_first_time(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let pool = state.pool()?;

    let row = sqlx::query_as::<_, (i32,)>(
        "SELECT is_first_time FROM app_state WHERE id = 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to check first time: {e}"))?;

    Ok(row.map(|(v,)| v != 0).unwrap_or(true))
}

/// Mark the first-time flag as seen (set to 0).
#[tauri::command]
pub async fn mark_first_time_seen(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let pool = state.pool()?;

    sqlx::query("UPDATE app_state SET is_first_time = 0 WHERE id = 1")
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to mark first time seen: {e}"))?;

    Ok(())
}

/// Get the is_above_half_credit flag.
#[tauri::command]
pub async fn get_is_above_half_credit(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let pool = state.pool()?;

    let row = sqlx::query_as::<_, (i32,)>(
        "SELECT is_above_half_credit FROM app_state WHERE id = 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to get is_above_half_credit: {e}"))?;

    Ok(row.map(|(v,)| v != 0).unwrap_or(false))
}

/// Update the is_above_half_credit flag.
#[tauri::command]
pub async fn update_is_above_half_credit(state: tauri::State<'_, AppState>, value: bool) -> Result<(), String> {
    let pool = state.pool()?;
    let val: i32 = if value { 1 } else { 0 };

    sqlx::query("UPDATE app_state SET is_above_half_credit = ? WHERE id = 1")
        .bind(val)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to update is_above_half_credit: {e}"))?;

    Ok(())
}

// ── Address Book ────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub id: i64,
    pub name: String,
    pub wallet_address: String,
    pub date_added: i64,
}

/// Add a contact to the address book.
#[tauri::command]
pub async fn add_contact(state: tauri::State<'_, AppState>, name: String, wallet_address: String) -> Result<i64, String> {
    let pool = state.pool()?;

    let result = sqlx::query("INSERT INTO address_book (name, wallet_address) VALUES (?, ?)")
        .bind(&name)
        .bind(&wallet_address)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to add contact: {e}"))?;

    Ok(result.last_insert_rowid())
}

/// Get all contacts, ordered by name ascending.
#[tauri::command]
pub async fn get_contacts(state: tauri::State<'_, AppState>) -> Result<Vec<Contact>, String> {
    let pool = state.pool()?;

    let rows = sqlx::query_as::<_, (i64, String, String, i64)>(
        "SELECT id, name, wallet_address, date_added FROM address_book ORDER BY name ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to get contacts: {e}"))?;

    Ok(rows
        .into_iter()
        .map(|(id, name, wallet_address, date_added)| Contact {
            id,
            name,
            wallet_address,
            date_added,
        })
        .collect())
}

/// Update a contact's name and wallet address.
#[tauri::command]
pub async fn update_contact(
    state: tauri::State<'_, AppState>,
    id: i64,
    name: String,
    wallet_address: String,
) -> Result<(), String> {
    let pool = state.pool()?;

    sqlx::query("UPDATE address_book SET name = ?, wallet_address = ? WHERE id = ?")
        .bind(&name)
        .bind(&wallet_address)
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to update contact: {e}"))?;

    Ok(())
}

/// Delete a contact from the address book.
#[tauri::command]
pub async fn delete_contact(state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    let pool = state.pool()?;

    sqlx::query("DELETE FROM address_book WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to delete contact: {e}"))?;

    Ok(())
}

// ── Onboarding ──────────────────────────────────────────────────────────

/// Check if onboarding is complete.
#[tauri::command]
pub async fn is_onboarding_done(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let pool = state.pool()?;

    let row = sqlx::query_as::<_, (i32,)>(
        "SELECT is_done FROM onboarding WHERE id = 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to check onboarding: {e}"))?;

    Ok(row.map(|(v,)| v != 0).unwrap_or(false))
}

/// Set the onboarding done flag. Inserts if no row exists.
#[tauri::command]
pub async fn set_onboarding_done(state: tauri::State<'_, AppState>, done: bool) -> Result<(), String> {
    let pool = state.pool()?;
    let val: i32 = if done { 1 } else { 0 };

    sqlx::query(
        "INSERT INTO onboarding (id, is_done) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET is_done = excluded.is_done",
    )
    .bind(val)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to set onboarding done: {e}"))?;

    Ok(())
}

// ── User Preferences ────────────────────────────────────────────────────

/// Get a user preference value by key. Returns None if the key doesn't exist.
#[tauri::command]
pub async fn get_user_preference(state: tauri::State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    let pool = state.pool()?;

    let row = sqlx::query_as::<_, (String,)>(
        "SELECT preference_value FROM user_preferences WHERE preference_key = ?",
    )
    .bind(&key)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to get user preference: {e}"))?;

    Ok(row.map(|(v,)| v))
}

/// Save a user preference (upsert). Timestamps with current epoch millis.
#[tauri::command]
pub async fn save_user_preference(state: tauri::State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    let pool = state.pool()?;

    sqlx::query(
        "INSERT OR REPLACE INTO user_preferences (preference_key, preference_value, updated_at) VALUES (?, ?, CAST(strftime('%s','now') * 1000 AS INTEGER))",
    )
    .bind(&key)
    .bind(&value)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to save user preference: {e}"))?;

    Ok(())
}
