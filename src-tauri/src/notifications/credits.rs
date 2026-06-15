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
    //
    // A malformed planck string must NOT fabricate a low-credit warning: the
    // old `.unwrap_or(0)` mapped garbage to 0 credits (< 0.5), which fell
    // straight into the notify branch. Mirror `billing::eligibility` — log and
    // skip (no notification) rather than invent a zero balance.
    let Ok(planck) = credit_balance_planck.parse::<u128>() else {
        tracing::warn!(balance = %credit_balance_planck, account_id = %account_id, "unparseable planck in low-credit check; skipping");
        return Ok(CreditNotificationCheck {
            should_notify: false,
            credit_balance: 0.0,
        });
    };
    let credit_balance = planck as f64 / 1e18;

    // Read both state flags in a single query (1 round-trip instead of 2)
    let (first_time, above_half) = sqlx::query_as::<_, (i32, i32)>("SELECT is_first_time, is_above_half_credit FROM app_state WHERE id = 1")
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

    // Check if there's already an active low-credit notification FOR THIS USER.
    // Scoping by user_address keeps account A's active warning from suppressing
    // account B's notification on a shared multi-account device.
    let active_count = active_low_credit_count(pool, &account_id).await?;

    if active_count > 0 {
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

    // No active notification — check the one-per-day rule, also scoped to this
    // user so account A's deletion timestamp can't throttle account B.
    let last_deleted = last_deleted_low_credit_at(pool, &account_id).await?;

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
    Ok(CreditNotificationCheck {
        should_notify: true,
        credit_balance,
    })
}

/// Count active (non-deleted) low-credit warnings for a single user.
///
/// Scoped by `user_address` so one account's warning never suppresses another's
/// on a shared multi-account install. `user_address` is the account's ss58
/// address — the same value bound as `user_address` everywhere in this table.
pub(crate) async fn active_low_credit_count(pool: &sqlx::SqlitePool, user_address: &str) -> Result<i64, AppError> {
    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM notifications \
         WHERE user_address = ? AND notification_type = 'Credits' \
         AND notification_subtype LIKE 'LowCreditWarning-%' AND is_deleted = 0",
    )
    .bind(user_address)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

/// `deleted_at` of the most recently deleted low-credit warning for a single
/// user, or `None` if this user has never deleted one. Drives the one-per-day
/// throttle; scoping prevents one account's deletion from throttling another.
pub(crate) async fn last_deleted_low_credit_at(pool: &sqlx::SqlitePool, user_address: &str) -> Result<Option<i64>, AppError> {
    let row = sqlx::query_as::<_, (Option<i64>,)>(
        "SELECT deleted_at FROM notifications \
         WHERE user_address = ? AND notification_type = 'Credits' \
         AND notification_subtype LIKE 'LowCreditWarning-%' AND is_deleted = 1 \
         ORDER BY deleted_at DESC LIMIT 1",
    )
    .bind(user_address)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(|(v,)| v))
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
    // Scope the dedup to THIS user: a `MintedAccountCredits-<timestamp>` subtype
    // can collide across accounts that received a credit in the same block, so
    // without `user_address = ?` account A's row would dedup away account B's
    // legitimate notification. account_id is the user_address (see the welcome
    // lookup above).
    let query_str = format!("SELECT notification_subtype FROM notifications WHERE user_address = ? AND notification_subtype IN ({placeholders})");
    let mut query = sqlx::query_scalar::<_, String>(&query_str).bind(&account_id);
    for (_, subtype) in &candidates {
        query = query.bind(subtype);
    }
    let existing: std::collections::HashSet<String> = query.fetch_all(pool).await?.into_iter().collect();

    // Build notifications, skipping already-existing subtypes
    let mut notifications = Vec::new();
    for (event, subtype) in candidates {
        if existing.contains(&subtype) {
            continue;
        }

        // Parse amount from raw blockchain value
        let clean_amount = event.amount.chars().filter(char::is_ascii_digit).collect::<String>();
        let amount: f64 = if clean_amount.is_empty() {
            0.0
        } else {
            clean_amount.parse::<f64>().unwrap_or(0.0) / 1e18
        };

        notifications.push(CreditEventNotification { subtype, amount });
    }

    Ok(notifications)
}

/// Outcome of a sync cycle that is being surfaced as a persisted notification.
///
/// The frontend maps each `hcfs_sync_*` event to one of these so the Rust layer
/// can pick the right title, notification_subtype prefix, and description
/// framing. Adding a new variant is a backend-side change — the frontend only
/// picks from the variants defined here.
#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum SyncNotificationOutcome {
    /// The sync cycle completed with one or more transfers. Title: "Sync Complete".
    Success,
    /// The sync cycle surfaced a non-cancel error (network, auth, rate limit,
    /// etc.). Title: "Sync Failed". User-initiated cancels and stall-watchdog
    /// self-cancels never reach this variant — they are silenced at the bridge
    /// (see `sync::tauri_bridge::on_event::SyncError`).
    Error,
}

impl SyncNotificationOutcome {
    pub fn title(self) -> &'static str {
        match self {
            Self::Success => "Sync Complete",
            Self::Error => "Sync Failed",
        }
    }

    pub fn subtype_prefix(self) -> &'static str {
        match self {
            Self::Success => "FileSyncComplete",
            Self::Error => "FileSyncError",
        }
    }
}

/// Insert a sync notification row. Returns the new row's `id`.
///
/// Pure DB helper — no Tauri state dependency so integration tests can drive it
/// with an in-memory pool. The `#[tauri::command]` wrapper below just unwraps
/// the pool from `AppState`.
pub async fn create_sync_notification_inner(
    pool: &sqlx::sqlite::SqlitePool,
    user_address: &str,
    description: &str,
    file_details_json: &str,
    outcome: SyncNotificationOutcome,
) -> Result<i64, AppError> {
    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let subtype = format!("{}-{timestamp}", outcome.subtype_prefix());
    let title = outcome.title();

    let id = sqlx::query(
        r"
        INSERT INTO notifications (
            user_address, notification_type, notification_subtype,
            title_text, description, link_text, link,
            is_unread, creation_time, is_deleted, release_notes
        )
        VALUES (?, 'Files', ?, ?, ?, 'View Files', '/files', 1, CAST(strftime('%s','now') * 1000 AS INTEGER), 0, ?)
        ",
    )
    .bind(user_address)
    .bind(&subtype)
    .bind(title)
    .bind(description)
    .bind(file_details_json)
    .execute(pool)
    .await?
    .last_insert_rowid();

    Ok(id)
}

/// Create a sync notification row.
///
/// `outcome` drives the title ("Sync Complete" vs. "Sync Failed") and the
/// `notification_subtype` prefix — so the notifications page can filter
/// success from failure without parsing the description string.
///
/// Called by the frontend after its aggregation window closes for the success
/// branch (see `useFilesNotification.ts`), and per-event for the error branch.
/// Rust owns notification persistence; the FE only formats the description.
#[tauri::command]
pub async fn create_sync_notification(
    state: tauri::State<'_, AppState>,
    user_address: String,
    description: String,
    file_details_json: String,
    outcome: SyncNotificationOutcome,
) -> Result<i64, AppError> {
    let pool = state.pool()?;
    create_sync_notification_inner(pool, &user_address, &description, &file_details_json, outcome).await
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

/// Pool-scoped implementation of [`create_credit_notifications`].
///
/// Uses a multi-row `INSERT … VALUES (…), (…), …` instead of N separate
/// INSERTs to avoid the per-row `Query` allocation + statement-cache lookup
/// inside the loop. Chunked to stay safely under SQLite's 32 766 default
/// `SQLITE_MAX_VARIABLE_NUMBER` — at 4 binds per row, 100 rows = 400 binds,
/// which leaves a generous margin even on platforms with the older 999 cap.
///
/// Extracted from the `#[tauri::command]` wrapper so the integration tests
/// can exercise it directly with a `&SqlitePool`.
pub async fn create_credit_notifications_inner(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    notifications: &[NotificationInput],
) -> Result<u32, AppError> {
    if notifications.is_empty() {
        return Ok(0);
    }

    let mut total = 0u32;

    // One transaction across all chunks so the whole call is one fsync.
    let mut tx = pool.begin().await?;

    const ROWS_PER_CHUNK: usize = 100;
    for chunk in notifications.chunks(ROWS_PER_CHUNK) {
        // Build the VALUES list once per chunk: "(?, 'Credits', ?, ?, ?, ...), (...), ..."
        // The four ? placeholders bind (user_address, subtype, title, description).
        // 'Credits', the static link fields, 1, the now-ms expression, and 0 are
        // baked into the SQL because they don't vary per row.
        let mut sql = String::from(
            "INSERT INTO notifications (\
                user_address, notification_type, notification_subtype, \
                title_text, description, link_text, link, \
                is_unread, creation_time, is_deleted\
             ) VALUES ",
        );
        for i in 0..chunk.len() {
            if i > 0 {
                sql.push_str(", ");
            }
            sql.push_str("(?, 'Credits', ?, ?, ?, 'Jump to Files', '/files', 1, CAST(strftime('%s','now') * 1000 AS INTEGER), 0)");
        }

        let mut q = sqlx::query(&sql);
        for n in chunk {
            q = q.bind(account_id).bind(&n.subtype).bind(&n.title).bind(&n.description);
        }
        q.execute(&mut *tx).await?;

        // chunk.len() always fits in u32 (capped at ROWS_PER_CHUNK = 100).
        total += u32::try_from(chunk.len()).unwrap_or(u32::MAX);
    }

    tx.commit().await?;
    Ok(total)
}

/// Persist multiple notifications in a single call.
///
/// Thin IPC wrapper over [`create_credit_notifications_inner`].
#[tauri::command]
pub async fn create_credit_notifications(
    state: tauri::State<'_, AppState>,
    account_id: String,
    notifications: Vec<NotificationInput>,
) -> Result<u32, AppError> {
    create_credit_notifications_inner(state.pool()?, &account_id, &notifications).await
}

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

    async fn insert_low_credit(pool: &sqlx::SqlitePool, user: &str, is_deleted: i64, deleted_at: Option<i64>) {
        sqlx::query(
            "INSERT INTO notifications (user_address, notification_type, notification_subtype, is_deleted, deleted_at, creation_time) \
             VALUES (?, 'Credits', 'LowCreditWarning-123', ?, ?, 1)",
        )
        .bind(user)
        .bind(is_deleted)
        .bind(deleted_at)
        .execute(pool)
        .await
        .expect("insert");
    }

    // The cross-account isolation property: account A's ACTIVE low-credit
    // warning must not suppress account B. Pre-fix the COUNT(*) had no
    // user_address predicate, so A's warning made B's count non-zero and B was
    // silently denied a notification.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn active_low_credit_count_is_scoped_per_user() {
        let (_dir, pool) = fresh_pool().await;
        insert_low_credit(&pool, "addrA", 0, None).await;
        assert_eq!(active_low_credit_count(&pool, "addrA").await.unwrap(), 1);
        assert_eq!(active_low_credit_count(&pool, "addrB").await.unwrap(), 0);
    }

    // The one-per-day throttle must read each user's OWN deletion history.
    // Pre-fix A's deletion timestamp fed B's throttle.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn last_deleted_low_credit_is_scoped_per_user() {
        let (_dir, pool) = fresh_pool().await;
        insert_low_credit(&pool, "addrA", 1, Some(1_000_000)).await;
        assert_eq!(last_deleted_low_credit_at(&pool, "addrA").await.unwrap(), Some(1_000_000));
        assert_eq!(last_deleted_low_credit_at(&pool, "addrB").await.unwrap(), None);
    }
}
