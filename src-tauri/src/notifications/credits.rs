//! Credit and sync notification helpers.
//!
//! Business logic for determining when to show low-credit warnings,
//! processing credit events, and creating sync completion notifications.

use crate::app_state::AppState;
use crate::auth::account_key::account_key;
use crate::error::AppError;

// ── Per-account low-credit notification flags (audit NOTIF-4) ───────────────
//
// `is_first_time` / `is_above_half_credit` are keyed by `account_key(owner)` in
// the `credit_notification_flags` table, NOT a single global `app_state` row, so
// one account's state can't drive another's credit warnings on a shared device.
// A missing row means defaults: first-time = true, above-half = false.

/// Read `(is_first_time, is_above_half_credit)` for `owner`, defaulting a missing
/// row to `(true, false)`.
async fn read_flags(pool: &sqlx::SqlitePool, owner: &str) -> Result<(bool, bool), AppError> {
    let row = sqlx::query_as::<_, (i32, i32)>("SELECT is_first_time, is_above_half_credit FROM credit_notification_flags WHERE owner = ?")
        .bind(owner)
        .fetch_optional(pool)
        .await?;
    Ok(row.map_or((true, false), |(ft, ah)| (ft != 0, ah != 0)))
}

/// Mark `owner`'s first-time flag seen. The INSERT path leaves `is_above_half`
/// at its column default (0) for a brand-new account, which is correct.
async fn set_first_time_seen(pool: &sqlx::SqlitePool, owner: &str) -> Result<(), AppError> {
    sqlx::query("INSERT INTO credit_notification_flags (owner, is_first_time) VALUES (?, 0) ON CONFLICT(owner) DO UPDATE SET is_first_time = 0")
        .bind(owner)
        .execute(pool)
        .await?;
    Ok(())
}

/// Set `owner`'s above-half-credit flag.
async fn set_above_half(pool: &sqlx::SqlitePool, owner: &str, value: bool) -> Result<(), AppError> {
    sqlx::query("INSERT INTO credit_notification_flags (owner, is_above_half_credit) VALUES (?, ?) ON CONFLICT(owner) DO UPDATE SET is_above_half_credit = excluded.is_above_half_credit")
        .bind(owner)
        .bind(i32::from(value))
        .execute(pool)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn is_first_time(state: tauri::State<'_, AppState>) -> Result<bool, AppError> {
    let owner = account_key(&state.current_account_id()?);
    Ok(read_flags(state.pool()?, &owner).await?.0)
}

/// Mark the first-time flag as seen for the active account.
#[tauri::command]
pub async fn mark_first_time_seen(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let owner = account_key(&state.current_account_id()?);
    set_first_time_seen(state.pool()?, &owner).await
}

/// Get the is_above_half_credit flag for the active account.
#[tauri::command]
pub async fn get_is_above_half_credit(state: tauri::State<'_, AppState>) -> Result<bool, AppError> {
    let owner = account_key(&state.current_account_id()?);
    Ok(read_flags(state.pool()?, &owner).await?.1)
}

/// Update the is_above_half_credit flag for the active account.
#[tauri::command]
pub async fn update_is_above_half_credit(state: tauri::State<'_, AppState>, value: bool) -> Result<(), AppError> {
    let owner = account_key(&state.current_account_id()?);
    set_above_half(state.pool()?, &owner, value).await
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
/// All DB queries and decisions happen in Rust. The frontend just calls
/// this on credit balance change and acts on the result.
#[tauri::command]
pub async fn check_low_credit_notification(
    state: tauri::State<'_, AppState>,
    account_id: String,
    credit_balance_planck: String,
) -> Result<CreditNotificationCheck, AppError> {
    // Reads/mutates this account's notification state; authorize against the
    // session account so a caller can't drive another account's flags.
    let account_id = state.require_session_account(&account_id)?;
    let pool = state.pool()?;
    check_low_credit_notification_inner(pool, &account_id, &credit_balance_planck).await
}

/// Pool-scoped implementation of [`check_low_credit_notification`].
///
/// Extracted so integration-style tests can drive the decision against an
/// in-memory pool without constructing `AppState`.
pub(crate) async fn check_low_credit_notification_inner(
    pool: &sqlx::SqlitePool,
    account_id: &str,
    credit_balance_planck: &str,
) -> Result<CreditNotificationCheck, AppError> {
    // Convert planck to credit value for threshold comparison.
    // f64 precision is fine for comparing against 0.5.
    //
    // A malformed planck string must NOT fabricate a low-credit warning:
    // mapping garbage to 0 credits (< 0.5) would fall straight into the notify
    // branch. Mirror `billing::eligibility` — log and skip (no notification)
    // rather than invent a zero balance.
    let Ok(planck) = credit_balance_planck.parse::<u128>() else {
        tracing::warn!(balance = %credit_balance_planck, account_id = %account_id, "unparseable planck in low-credit check; skipping");
        return Ok(CreditNotificationCheck {
            should_notify: false,
            credit_balance: 0.0,
        });
    };
    let credit_balance = planck as f64 / 1e18;

    // Per-account flags (audit NOTIF-4), keyed by the validated session account.
    let owner = account_key(account_id);
    let (first_time, above_half) = read_flags(pool, &owner).await?;

    // Credits >= 0.5: update flags, retire any live warning as *read*, and
    // return no notification. Unread-clear (not `is_deleted = 1`) is load-bearing:
    // soft-delete stamps `last_deleted_low_credit_at` and starts the one-per-day
    // throttle, so a later dip today could not warn again.
    if credit_balance >= 0.5 {
        if first_time {
            set_first_time_seen(pool, &owner).await?;
        }
        if !above_half {
            set_above_half(pool, &owner, true).await?;
        }
        mark_low_credit_warnings_read(pool, account_id).await?;
        return Ok(CreditNotificationCheck {
            should_notify: false,
            credit_balance: 0.0,
        });
    }

    // Credits < 0.5: mark first time seen
    if first_time {
        set_first_time_seen(pool, &owner).await?;
    }

    // Check if there's already an active low-credit notification FOR THIS USER.
    // Scoping by user_address keeps account A's active warning from suppressing
    // account B's notification on a shared multi-account device.
    //
    // A top-up retires the warning as read (`is_deleted` stays 0), so
    // `active_count` is still > 0. Let a just-recovered `above_half` crossing
    // through — otherwise a later dip the same day could not notify. Opening
    // the warning while still low has `above_half == false` and still
    // suppresses, so it cannot spam a new row on every route change.
    let active_count = active_low_credit_count(pool, account_id).await?;

    if active_count > 0 && !above_half {
        // Already showing a notification — just update state
        return Ok(CreditNotificationCheck {
            should_notify: false,
            credit_balance: 0.0,
        });
    }

    // No active notification — check the one-per-day rule, also scoped to this
    // user so account A's deletion timestamp can't throttle account B.
    let last_deleted = last_deleted_low_credit_at(pool, account_id).await?;

    let now = chrono::Utc::now().timestamp_millis();
    let can_notify = match last_deleted {
        None => true,
        Some(deleted_at) => (now - deleted_at) > ONE_DAY_MS,
    };

    // Update above-half state
    if above_half {
        set_above_half(pool, &owner, false).await?;
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

/// Low-credit check that fetches the **live** balance server-side and then runs
/// the same decision as [`check_low_credit_notification`].
///
/// The FE used to pass `useUserCredits`'s cached planck, but that query is
/// `staleTime: Infinity` and is never invalidated — so a user who spent below
/// the threshold mid-session was never warned (audit R-08). This command takes
/// no FE-supplied balance: it fetches the balance from the billing API itself,
/// so the warning can never be decided against stale data.
#[tauri::command]
pub async fn check_low_credit_notification_live(state: tauri::State<'_, AppState>, account_id: String) -> Result<CreditNotificationCheck, AppError> {
    let account = state.require_session_account_typed(&account_id)?;
    let planck = crate::billing::credits::fetch_credit_balance_planck(&state, &account).await?;
    // Delegate to the existing decision (it re-validates the session account and
    // owns all the one-per-day / dedup / flag-state logic).
    check_low_credit_notification(state, account_id, planck).await
}

/// Mark live `LowCreditWarning-%` rows for `user_address` as read.
///
/// Used when the balance recovers to >= 0.5 HIP. Must not set `is_deleted`:
/// that is what [`last_deleted_low_credit_at`] reads for the one-per-day
/// throttle.
async fn mark_low_credit_warnings_read(pool: &sqlx::SqlitePool, user_address: &str) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE notifications SET is_unread = 0 \
         WHERE notification_subtype LIKE 'LowCreditWarning-%' \
           AND is_deleted = 0 \
           AND user_address = ?",
    )
    .bind(user_address)
    .execute(pool)
    .await?;
    Ok(())
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

/// Parse a credit-event timestamp (RFC3339 or epoch-millis string) to epoch
/// millis.
///
/// Returns `None` for an unparseable value so the caller can warn + skip
/// rather than silently coercing it to `0` — which sorts before every welcome
/// time and so would drop the event without a trace.
fn parse_event_timestamp_ms(timestamp: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .map(|d| d.timestamp_millis())
        .ok()
        .or_else(|| timestamp.parse::<i64>().ok())
}

/// Parse a raw planck credit amount (an unsigned integer string) into whole HIP.
///
/// Returns `None` for a value that is empty, signed, fractional, or otherwise
/// non-integer. Stripping non-digit characters would turn `"-5"` into `5` and
/// `"1.5"` into `15` — silently fabricating a wrong positive amount instead of
/// rejecting malformed input. A mint amount is an unsigned integer in planck, so
/// a sign or decimal point is malformed, not a value to coerce. Parsed as `u128`
/// (planck exceeds f64's exact-integer range) before the display divide.
fn parse_credit_amount_planck(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') || trimmed.contains('.') {
        return None;
    }
    let planck: u128 = trimmed.parse().ok()?;
    Some(planck as f64 / 1e18)
}

/// Process credit events and return which ones need notifications.
///
/// Handles: welcome timestamp lookup, event filtering, dedup checking,
/// amount formatting.
#[tauri::command]
pub async fn process_credit_events(
    state: tauri::State<'_, AppState>,
    account_id: String,
    events: Vec<CreditEventInput>,
) -> Result<Vec<CreditEventNotification>, AppError> {
    // Reads/dedups this account's notification rows; authorize against the
    // session account.
    let account_id = state.require_session_account(&account_id)?;
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
            let Some(event_ms) = parse_event_timestamp_ms(&event.timestamp) else {
                tracing::warn!(timestamp = %event.timestamp, "process_credit_events: skipping event with unparseable timestamp");
                return None;
            };
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

        // Parse amount from the raw planck value. A malformed amount (signed,
        // fractional, non-integer) is skipped with a warning rather than
        // emitting a notification asserting a credit value we know is wrong —
        // symmetric with the unparseable-timestamp skip above. This is the rare
        // defensive path; a real mint event carries a clean unsigned integer.
        let Some(amount) = parse_credit_amount_planck(&event.amount) else {
            tracing::warn!(amount = %event.amount, subtype = %subtype, "process_credit_events: skipping event with malformed credit amount");
            continue;
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
// snake_case, not lowercase: the single-word variants serialize identically
// either way, so the FE's existing "success"/"error" are unaffected, while a
// multi-word variant gets "folder_restored" rather than "folderrestored".
#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum SyncNotificationOutcome {
    /// The sync cycle completed with one or more transfers. Title: "Sync Complete".
    Success,
    /// The sync cycle surfaced a non-cancel error (network, auth, rate limit,
    /// etc.). Title: "Sync Failed". User-initiated cancels and stall-watchdog
    /// self-cancels never reach this variant — they are silenced at the bridge
    /// (see `sync::tauri_bridge::on_event::SyncError`).
    Error,
    /// The drive's folder was missing from the server and the engine
    /// re-registered it from this device, discarding the local baseline — so
    /// the whole drive re-uploads (`hcfs_folder_recovered`). Title: "Folder
    /// Restored".
    ///
    /// Neither existing variant can carry this: nothing failed, so "Sync
    /// Failed" would be a lie, and "Sync Complete" would bury a re-upload of
    /// the entire drive under a routine success. It is its own variant because
    /// the user needs to be able to tell this apart from an ordinary sync —
    /// the usual cause is deleting the folder from the web console, which the
    /// desktop then silently undoes.
    FolderRestored,
}

impl SyncNotificationOutcome {
    pub fn title(self) -> &'static str {
        match self {
            Self::Success => "Sync Complete",
            Self::Error => "Sync Failed",
            Self::FolderRestored => "Folder Restored",
        }
    }

    pub fn subtype_prefix(self) -> &'static str {
        match self {
            Self::Success => "FileSyncComplete",
            Self::Error => "FileSyncError",
            Self::FolderRestored => "FileSyncFolderRestored",
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
    // Scope the write to the signed-in account; never trust the caller-supplied
    // address.
    let user_address = crate::notifications::session_scoped_notification_account(state.inner(), &user_address)?;
    let pool = state.pool()?;
    create_sync_notification_inner(pool, &user_address, &description, &file_details_json, outcome).await
}

/// Persist multiple credit event notifications in a single call.
///
/// Returns the count of notifications added.
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
    // Scope the write to the signed-in account; never trust the caller-supplied
    // address.
    let account_id = crate::notifications::session_scoped_notification_account(state.inner(), &account_id)?;
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

    // ── SyncNotificationOutcome wire contract ───────────────────────
    //
    // The FE passes this outcome as a bare string over IPC (there is no
    // codegen across the boundary), so a rename here — or the `rename_all`
    // style drifting back to "lowercase", which would turn `FolderRestored`
    // into "folderrestored" — deserializes as an error INSIDE a Tauri event
    // listener, where the rejection is invisible and the notification is
    // simply never written. Pin the exact strings `useFilesNotification.ts`
    // sends, and the title/subtype each selects.
    #[test]
    fn outcome_deserializes_the_strings_the_frontend_sends() {
        let cases = [
            ("success", "Sync Complete", "FileSyncComplete"),
            ("error", "Sync Failed", "FileSyncError"),
            ("folder_restored", "Folder Restored", "FileSyncFolderRestored"),
        ];

        for (wire, title, prefix) in cases {
            let outcome: SyncNotificationOutcome =
                serde_json::from_str(&format!("\"{wire}\"")).unwrap_or_else(|e| panic!("the frontend sends {wire:?}, which must deserialize: {e}"));
            assert_eq!(outcome.title(), title, "title for {wire:?}");
            assert_eq!(outcome.subtype_prefix(), prefix, "subtype prefix for {wire:?}");
        }
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
    // warning must not suppress account B. Without a user_address predicate on
    // the COUNT(*), A's warning makes B's count non-zero and B is silently
    // denied a notification.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn active_low_credit_count_is_scoped_per_user() {
        let (_dir, pool) = fresh_pool().await;
        insert_low_credit(&pool, "addrA", 0, None).await;
        assert_eq!(active_low_credit_count(&pool, "addrA").await.unwrap(), 1);
        assert_eq!(active_low_credit_count(&pool, "addrB").await.unwrap(), 0);
    }

    // The one-per-day throttle must read each user's OWN deletion history, so
    // account A's deletion timestamp can't throttle account B.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn last_deleted_low_credit_is_scoped_per_user() {
        let (_dir, pool) = fresh_pool().await;
        insert_low_credit(&pool, "addrA", 1, Some(1_000_000)).await;
        assert_eq!(last_deleted_low_credit_at(&pool, "addrA").await.unwrap(), Some(1_000_000));
        assert_eq!(last_deleted_low_credit_at(&pool, "addrB").await.unwrap(), None);
    }

    // 1 HIP / 0.1 HIP in planck. Threshold is 0.5 HIP.
    const ABOVE_HALF_PLANCK: &str = "1000000000000000000";
    const BELOW_HALF_PLANCK: &str = "100000000000000000";

    async fn warning_unread_deleted(pool: &sqlx::SqlitePool, user: &str) -> (i64, i64) {
        sqlx::query_as::<_, (i64, i64)>(
            "SELECT is_unread, is_deleted FROM notifications \
             WHERE user_address = ? AND notification_subtype LIKE 'LowCreditWarning-%'",
        )
        .bind(user)
        .fetch_one(pool)
        .await
        .expect("warning row")
    }

    // H-016: topping up must retire the warning as READ, not deleted, so the
    // bell drops without starting the one-per-day throttle — a later dip the
    // same day can still notify.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recovering_above_half_marks_low_credit_warning_read_not_deleted() {
        let (_dir, pool) = fresh_pool().await;
        insert_low_credit(&pool, "addrA", 0, None).await;
        insert_low_credit(&pool, "addrB", 0, None).await;

        let recovered = check_low_credit_notification_inner(&pool, "addrA", ABOVE_HALF_PLANCK)
            .await
            .expect("recover");
        assert!(!recovered.should_notify, "a recovered balance must not raise a new warning");

        let (unread, deleted) = warning_unread_deleted(&pool, "addrA").await;
        assert_eq!(unread, 0, "top-up must clear unread so the bell drops");
        assert_eq!(deleted, 0, "must not soft-delete — that starts the one-per-day throttle");
        assert_eq!(
            last_deleted_low_credit_at(&pool, "addrA").await.unwrap(),
            None,
            "unread-clear must not stamp last_deleted_low_credit_at",
        );

        let (other_unread, other_deleted) = warning_unread_deleted(&pool, "addrB").await;
        assert_eq!(other_unread, 1, "another account's warning must stay unread");
        assert_eq!(other_deleted, 0);

        let dip = check_low_credit_notification_inner(&pool, "addrA", BELOW_HALF_PLANCK).await.expect("dip");
        assert!(dip.should_notify, "a later dip the same day must still be able to notify");
    }

    // Pin against a naive unread-only active-count: opening the warning while
    // still low (is_unread=0, is_deleted=0, never recovered) must not spawn a
    // new row on the next check — that would fire on every route change.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn read_warning_while_still_low_does_not_renotify() {
        let (_dir, pool) = fresh_pool().await;
        insert_low_credit(&pool, "addrA", 0, None).await;

        let first = check_low_credit_notification_inner(&pool, "addrA", BELOW_HALF_PLANCK)
            .await
            .expect("first low");
        assert!(!first.should_notify, "an existing live warning already covers this dip");

        sqlx::query("UPDATE notifications SET is_unread = 0 WHERE user_address = 'addrA'")
            .execute(&pool)
            .await
            .expect("user marked the warning read");

        let again = check_low_credit_notification_inner(&pool, "addrA", BELOW_HALF_PLANCK)
            .await
            .expect("still low");
        assert!(
            !again.should_notify,
            "reading the warning while still low must not re-notify on the next check"
        );
    }

    // -----------------------------------------------------------------------
    // Defensive credit-event timestamp / amount parsing
    // -----------------------------------------------------------------------

    #[test]
    fn parse_event_timestamp_accepts_rfc3339_and_epoch_millis() {
        // 2021-01-01T00:00:00Z = 1_609_459_200_000 ms.
        assert_eq!(parse_event_timestamp_ms("2021-01-01T00:00:00Z"), Some(1_609_459_200_000));
        assert_eq!(parse_event_timestamp_ms("1700000000000"), Some(1_700_000_000_000));
        // Negative epoch (pre-1970) is a valid i64, not silently zeroed.
        assert_eq!(parse_event_timestamp_ms("-5"), Some(-5));
    }

    #[test]
    fn parse_event_timestamp_rejects_garbage_instead_of_zeroing() {
        assert_eq!(parse_event_timestamp_ms(""), None);
        assert_eq!(parse_event_timestamp_ms("not-a-date"), None);
        assert_eq!(parse_event_timestamp_ms("12.5"), None);
    }

    #[test]
    fn parse_credit_amount_parses_unsigned_planck() {
        assert_eq!(parse_credit_amount_planck("5000000000000000000"), Some(5.0));
        assert_eq!(parse_credit_amount_planck("0"), Some(0.0));
        // Surrounding whitespace is tolerated (trimmed), unlike a sign/decimal.
        assert_eq!(parse_credit_amount_planck("  1000000000000000000  "), Some(1.0));
    }

    #[test]
    fn parse_credit_amount_rejects_signed_fractional_and_garbage() {
        // A digit-strip would mangle these; rejection is required:
        assert_eq!(parse_credit_amount_planck("-5"), None, "negative must not become +5");
        assert_eq!(parse_credit_amount_planck("1.5"), None, "fractional must not become 15");
        assert_eq!(parse_credit_amount_planck(""), None);
        assert_eq!(parse_credit_amount_planck("abc"), None);
        assert_eq!(parse_credit_amount_planck("12x34"), None);
    }
}
