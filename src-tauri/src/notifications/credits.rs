//! Credit and sync notification helpers.
//!
//! Business logic for determining when to show low-credit warnings,
//! processing credit events, and creating sync completion notifications.

use crate::app_state::AppState;
use crate::error::AppError;

#[tauri::command]
pub async fn is_first_time(state: tauri::State<'_, AppState>) -> Result<bool, AppError> {
    let pool = state.pool()?;

    let row = sqlx::query_as::<_, (i32,)>("SELECT is_first_time FROM app_state WHERE id = 1")
        .fetch_optional(pool)
        .await?;

    Ok(row.is_none_or(|(v,)| v != 0))
}

/// Mark the first-time flag as seen (set to 0).
#[tauri::command]
pub async fn mark_first_time_seen(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let pool = state.pool()?;

    sqlx::query("UPDATE app_state SET is_first_time = 0 WHERE id = 1").execute(pool).await?;

    Ok(())
}

/// Get the is_above_half_credit flag.
#[tauri::command]
pub async fn get_is_above_half_credit(state: tauri::State<'_, AppState>) -> Result<bool, AppError> {
    let pool = state.pool()?;

    let row = sqlx::query_as::<_, (i32,)>("SELECT is_above_half_credit FROM app_state WHERE id = 1")
        .fetch_optional(pool)
        .await?;

    Ok(row.is_some_and(|(v,)| v != 0))
}

/// Update the is_above_half_credit flag.
#[tauri::command]
pub async fn update_is_above_half_credit(state: tauri::State<'_, AppState>, value: bool) -> Result<(), AppError> {
    let pool = state.pool()?;
    let val: i32 = i32::from(value);

    sqlx::query("UPDATE app_state SET is_above_half_credit = ? WHERE id = 1")
        .bind(val)
        .execute(pool)
        .await?;

    Ok(())
}

// ── Credit Notification Logic ───────────────────────────────────────────

const ONE_DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Result of checking whether a low-credit notification should be shown.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditNotificationCheck {
    /// If true, the frontend should show a low-credit notification.
    pub should_notify: bool,
    /// The credit balance that triggered the notification. Frontend formats the text.
    pub credit_balance: f64,
}

/// Check whether a low-credit notification should be shown and update
/// internal state (first-time flag, above-half-credit tracking).
///
/// Replaces the complex business logic tree in `useCreditsNotification.ts`.
/// All DB queries and decisions happen in Rust. The frontend just calls
/// this on credit balance change and acts on the result.
#[tauri::command]
pub async fn check_low_credit_notification(
    state: tauri::State<'_, AppState>,
    account_id: String,
    credit_balance_planck: String,
) -> Result<CreditNotificationCheck, AppError> {
    let pool = state.pool()?;
    // Convert planck to credit value for threshold comparison.
    // f64 precision is fine for comparing against 0.5.
    let planck: u128 = credit_balance_planck.parse().unwrap_or(0);
    let credit_balance = planck as f64 / 1e18;

    // Read both state flags in a single query (1 round-trip instead of 2)
    let (first_time, above_half) = sqlx::query_as::<_, (i32, i32)>(
        "SELECT is_first_time, is_above_half_credit FROM app_state WHERE id = 1",
    )
    .fetch_optional(pool)
    .await?
    .map_or((true, false), |(ft, ah)| (ft != 0, ah != 0));

    // Credits >= 0.5: update flags and return no notification
    if credit_balance >= 0.5 {
        if first_time {
            sqlx::query("UPDATE app_state SET is_first_time = 0 WHERE id = 1").execute(pool).await?;
        }
        if !above_half {
            sqlx::query("UPDATE app_state SET is_above_half_credit = 1 WHERE id = 1")
                .execute(pool)
                .await?;
        }
        return Ok(CreditNotificationCheck {
            should_notify: false,
            credit_balance: 0.0,
        });
    }

    // Credits < 0.5: mark first time seen
    if first_time {
        sqlx::query("UPDATE app_state SET is_first_time = 0 WHERE id = 1").execute(pool).await?;
    }

    // Check if there's already an active low-credit notification
    let active_count = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications WHERE notification_type = 'Credits' AND notification_subtype LIKE 'LowCreditWarning-%' AND is_deleted = 0",
    )
    .fetch_one(pool)
    .await?;

    if active_count.0 > 0 {
        // Already showing a notification — just update state
        if above_half {
            sqlx::query("UPDATE app_state SET is_above_half_credit = 0 WHERE id = 1")
                .execute(pool)
                .await?;
        }
        return Ok(CreditNotificationCheck {
            should_notify: false,
            credit_balance: 0.0,
        });
    }

    // No active notification — check one-per-day rule
    let last_deleted = sqlx::query_as::<_, (Option<i64>,)>(
        "SELECT deleted_at FROM notifications WHERE notification_type = 'Credits' AND notification_subtype LIKE 'LowCreditWarning-%' AND is_deleted = 1 ORDER BY deleted_at DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await?
    .and_then(|(v,)| v);

    let now = chrono::Utc::now().timestamp_millis();
    let can_notify = match last_deleted {
        None => true,
        Some(deleted_at) => (now - deleted_at) > ONE_DAY_MS,
    };

    // Update above-half state
    if above_half {
        sqlx::query("UPDATE app_state SET is_above_half_credit = 0 WHERE id = 1")
            .execute(pool)
            .await?;
    }

    if !can_notify {
        return Ok(CreditNotificationCheck {
            should_notify: false,
            credit_balance: 0.0,
        });
    }

    // Build notification data — frontend creates the notification via add_notification
    let _ = &account_id; // used for future per-user scoping
    Ok(CreditNotificationCheck {
        should_notify: true,
        credit_balance,
    })
}

/// A credit event to process for notifications.
#[derive(serde::Deserialize)]
pub struct CreditEventInput {
    pub timestamp: String,
    pub amount: String,
}

/// A notification to create from a credit event.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditEventNotification {
    pub subtype: String,
    /// Decimal credit amount (e.g., 1.5). Frontend formats the notification text.
    pub amount: f64,
}

/// Process credit events and return which ones need notifications.
///
/// Handles: welcome timestamp lookup, event filtering, dedup checking,
/// amount formatting. Replaces the event processing loop in
/// `useCreditsNotification.ts`.
#[tauri::command]
pub async fn process_credit_events(
    state: tauri::State<'_, AppState>,
    account_id: String,
    events: Vec<CreditEventInput>,
) -> Result<Vec<CreditEventNotification>, AppError> {
    let pool = state.pool()?;

    // Find welcome notification timestamp
    let welcome_row = sqlx::query_as::<_, (Option<i64>,)>(
        "SELECT creation_time FROM notifications WHERE user_address = ? AND notification_type = 'Hippius' AND notification_subtype LIKE 'Welcome-%' LIMIT 1",
    )
    .bind(&account_id)
    .fetch_optional(pool)
    .await?;

    let Some((Some(welcome_ms),)) = welcome_row else {
        return Ok(Vec::new());
    };

    // Pre-filter events by timestamp (no DB needed)
    let candidates: Vec<(&CreditEventInput, String)> = events
        .iter()
        .filter_map(|event| {
            let event_ms = chrono::DateTime::parse_from_rfc3339(&event.timestamp)
                .map(|d| d.timestamp_millis())
                .or_else(|_| event.timestamp.parse::<i64>())
                .unwrap_or(0);
            if event_ms <= welcome_ms {
                return None;
            }
            let subtype = format!("MintedAccountCredits-{}", event.timestamp);
            Some((event, subtype))
        })
        .collect();

    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    // Batch dedup: single query with IN clause instead of N per-event queries
    let placeholders: String = candidates.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let query_str = format!(
        "SELECT notification_subtype FROM notifications WHERE notification_subtype IN ({placeholders})"
    );
    let mut query = sqlx::query_scalar::<_, String>(&query_str);
    for (_, subtype) in &candidates {
        query = query.bind(subtype);
    }
    let existing: std::collections::HashSet<String> =
        query.fetch_all(pool).await?.into_iter().collect();

    // Build notifications, skipping already-existing subtypes
    let mut notifications = Vec::new();
    for (event, subtype) in candidates {
        if existing.contains(&subtype) {
            continue;
        }

        // Parse amount from raw blockchain value
        let clean_amount = event
            .amount
            .chars()
            .filter(char::is_ascii_digit)
            .collect::<String>();
        let amount: f64 = if clean_amount.is_empty() {
            0.0
        } else {
            clean_amount.parse::<f64>().unwrap_or(0.0) / 1e18
        };

        notifications.push(CreditEventNotification { subtype, amount });
    }

    Ok(notifications)
}

/// Create a sync completion notification with aggregated file details.
///
/// Called by the frontend after its 2-second debounce window closes.
/// Rust handles notification persistence in one call instead of the
/// frontend calling `add_notification` after manually aggregating.
#[tauri::command]
pub async fn create_sync_notification(
    state: tauri::State<'_, AppState>,
    user_address: String,
    description: String,
    file_details_json: String,
) -> Result<i64, AppError> {
    let pool = state.pool()?;
    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let subtype = format!("FileSyncComplete-{timestamp}");

    let id = sqlx::query(
        r"
        INSERT INTO notifications (
            user_address, notification_type, notification_subtype,
            title_text, description, link_text, link,
            is_unread, creation_time, is_deleted, release_notes
        )
        VALUES (?, 'Files', ?, 'Sync Complete', ?, 'View Files', '/files', 1, CAST(strftime('%s','now') * 1000 AS INTEGER), 0, ?)
        ",
    )
    .bind(&user_address)
    .bind(&subtype)
    .bind(&description)
    .bind(&file_details_json)
    .execute(pool)
    .await?
    .last_insert_rowid();

    Ok(id)
}

/// Persist multiple credit event notifications in a single call.
///
/// Replaces the `for` loop in `useCreditsNotification.ts` that called
/// `add_notification` per event. Returns the count of notifications added.
/// Input for creating a notification with frontend-formatted text.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationInput {
    pub subtype: String,
    pub title: String,
    pub description: String,
}

/// Persist multiple notifications in a single call.
#[tauri::command]
pub async fn create_credit_notifications(
    state: tauri::State<'_, AppState>,
    account_id: String,
    notifications: Vec<NotificationInput>,
) -> Result<u32, AppError> {
    let pool = state.pool()?;
    let mut count = 0u32;

    // Wrap all INSERTs in a single transaction (1 fsync instead of N)
    let mut tx = pool.begin().await?;
    for n in &notifications {
        sqlx::query(
            r"
            INSERT INTO notifications (
                user_address, notification_type, notification_subtype,
                title_text, description, link_text, link,
                is_unread, creation_time, is_deleted
            )
            VALUES (?, 'Credits', ?, ?, ?, 'Jump to Files', '/files', 1, CAST(strftime('%s','now') * 1000 AS INTEGER), 0)
            ",
        )
        .bind(&account_id)
        .bind(&n.subtype)
        .bind(&n.title)
        .bind(&n.description)
        .execute(&mut *tx)
        .await?;
        count += 1;
    }
    tx.commit().await?;

    Ok(count)
}
