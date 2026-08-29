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

    // Credits >= 0.5: update flags, retire any live warning as *read* on the
    // crossing, and return no notification. Unread-clear (not `is_deleted = 1`) is load-bearing:
    // soft-delete stamps `last_deleted_low_credit_at` and starts the one-per-day
    // throttle, so a later dip today could not warn again.
    if credit_balance >= 0.5 {
        if first_time {
            set_first_time_seen(pool, &owner).await?;
        }
        // Retire the warning on the low -> healthy CROSSING only. Running it on
        // every healthy check would silently undo a user who reopened the
        // warning from the bell ("Mark as unread") to come back to it, and
        // would write on every route change for a perfectly healthy account.
        if !above_half {
            set_above_half(pool, &owner, true).await?;
            mark_low_credit_warnings_read(pool, account_id).await?;
        }
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
    /// The sync cycle completed with one or more transfers. Title: the file's
    /// name or the file count when the row carries a usable file list (see
    /// [`success_list_title`]), otherwise "Sync Complete".
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

    /// Title as the bell and the notifications page render it — those surfaces
    /// show `title_text` and nothing else, so this line is the whole of what a
    /// user reads about a row.
    ///
    /// Only a success draws on the file list (see [`success_list_title`]); error
    /// and restored titles stay fixed so a failure can never look like one.
    fn list_title(self, files: &SyncFileSummary<'_>) -> String {
        match self {
            Self::Success => success_list_title(files),
            Self::Error | Self::FolderRestored => self.title().to_string(),
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

/// The cycle's file list as it reached the notification row, plus how many
/// files the cycle actually touched.
///
/// The two are not redundant. `details_json` is capped twice on its way here —
/// `MAX_NOTIFICATION_FILES` in `collect_cycle_files_for_label`, then the
/// notification hook's own 200-entry aggregation buffer — so its length is a
/// floor on the cycle, never its size: a 5 000-file initial sync arrives as 200
/// entries. `file_count` is the hook's uncapped running total, which is what a
/// count in the title has to come from; `None` means the caller had no count to
/// offer and the list length is the best answer available.
pub struct SyncFileSummary<'a> {
    pub details_json: &'a str,
    pub file_count: Option<u32>,
}

/// One entry of the `release_notes` file list, reduced to what the title needs.
struct FileDetail {
    /// `None` when the entry carries no readable `fileName`.
    name: Option<String>,
    /// An upload or a download, as opposed to a local/remote delete.
    transferred: bool,
}

/// Title for a finished cycle.
///
/// Only uploads and downloads may lend their name to the title: "Synced
/// report.pdf" for a file the cycle *deleted* reads as a successful upload of a
/// file that is in fact gone, so a delete-only cycle keeps the generic title and
/// lets the description say what happened.
///
/// The single-file arm requires the count and the list to agree that there was
/// exactly one file. The list is a capped projection of session state, so one
/// entry alongside a count of five is a truncation rather than a one-file cycle,
/// and naming that entry would bury the other four.
fn success_list_title(files: &SyncFileSummary<'_>) -> String {
    let generic = SyncNotificationOutcome::Success.title().to_string();

    let details = parse_file_details(files.details_json);
    let transferred: Vec<&str> = details.iter().filter(|d| d.transferred).filter_map(|d| d.name.as_deref()).collect();
    if transferred.is_empty() {
        return generic;
    }

    let total = files.file_count.map_or(details.len(), |n| n as usize);
    match (total, transferred.as_slice()) {
        (1, [name]) => format!("Synced {name}"),
        (n, _) if n > 1 => format!("Synced {n} files"),
        _ => generic,
    }
}

/// Parse the `release_notes` array the notification hook sends. A non-array or
/// unparseable payload yields no entries, which keeps the generic title.
///
/// `action` holds hcfs-client's `FileAction` wire string; the exact spellings
/// are pinned by `sync::events::tests` (a drift there degrades every success
/// title to "Sync Complete" rather than mislabelling a delete as a transfer).
fn parse_file_details(details_json: &str) -> Vec<FileDetail> {
    let Ok(values) = serde_json::from_str::<Vec<serde_json::Value>>(details_json) else {
        return Vec::new();
    };
    values
        .iter()
        .map(|v| FileDetail {
            name: v.get("fileName").and_then(serde_json::Value::as_str).map(basename),
            transferred: matches!(v.get("action").and_then(serde_json::Value::as_str), Some("upload" | "download")),
        })
        .collect()
}

/// Last path segment of a drive-relative entry — nested files carry the whole
/// path, not the basename.
///
/// Splits on `\` as well because hcfs-client's own `extract_file_name` splits on
/// `/` first and hands a Windows-shaped path back whole. A POSIX name that
/// genuinely contains a backslash therefore shows only its tail, which is
/// cosmetic in a line the UI already ellipsises.
fn basename(path: &str) -> String {
    path.rsplit(['/', '\\']).next().filter(|s| !s.is_empty()).unwrap_or(path).to_string()
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
    files: SyncFileSummary<'_>,
    outcome: SyncNotificationOutcome,
) -> Result<i64, AppError> {
    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let subtype = format!("{}-{timestamp}", outcome.subtype_prefix());
    let title = outcome.list_title(&files);

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
    .bind(files.details_json)
    .execute(pool)
    .await?
    .last_insert_rowid();

    Ok(id)
}

/// Create a sync notification row.
///
/// `outcome` drives the title ("Sync Failed" vs. the success titles above) and
/// the `notification_subtype` prefix — so the notifications page can filter
/// success from failure without parsing the description string.
///
/// `file_count` is the cycle's uncapped file count, which only the success path
/// sends; omitting it falls back to the length of the (capped) file list. See
/// [`SyncFileSummary`] for why the two differ.
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
    file_count: Option<u32>,
) -> Result<i64, AppError> {
    // Scope the write to the signed-in account; never trust the caller-supplied
    // address.
    let user_address = crate::notifications::session_scoped_notification_account(state.inner(), &user_address)?;
    let pool = state.pool()?;
    let files = SyncFileSummary {
        details_json: &file_details_json,
        file_count,
    };
    create_sync_notification_inner(pool, &user_address, &description, files, outcome).await
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

    // ── Sync-complete list title ────────────────────────────────────
    //
    // The bell and the notifications page render `title_text` and nothing
    // else, so every one of these cases is the whole of what the user reads
    // about a finished cycle. The description (which only the detail pane
    // shows) is the FE's; the title is Rust's.

    fn title_for(details_json: &str, file_count: Option<u32>) -> String {
        SyncNotificationOutcome::Success.list_title(&SyncFileSummary { details_json, file_count })
    }

    fn upload(name: &str) -> serde_json::Value {
        serde_json::json!({ "fileName": name, "totalBytes": 1, "action": "upload" })
    }

    fn details(entries: &[serde_json::Value]) -> String {
        serde_json::Value::Array(entries.to_vec()).to_string()
    }

    #[test]
    fn one_transferred_file_is_named_by_its_basename() {
        // Nested entries carry the drive-relative path, not the basename.
        assert_eq!(
            title_for(&details(&[upload("Vacation/2024/IMG_1234.HEIC")]), Some(1)),
            "Synced IMG_1234.HEIC"
        );
        assert_eq!(title_for(&details(&[upload("report.pdf")]), Some(1)), "Synced report.pdf");
        assert_eq!(title_for(&details(&[upload(r"Vacation\IMG_1234.HEIC")]), Some(1)), "Synced IMG_1234.HEIC");
    }

    #[test]
    fn a_name_is_passed_through_verbatim() {
        // Punctuation, spaces and quotes are data, not markup: the title is
        // rendered as text and nothing here needs escaping or trimming.
        let odd = "Q3 report [v2] {draft} 100% — o'brien \"final\".pdf";
        assert_eq!(title_for(&details(&[upload(odd)]), Some(1)), format!("Synced {odd}"));

        // Truncation is the UI's job (both surfaces ellipsise); Rust must not
        // silently shorten a name the user would then fail to recognise.
        let long = format!("{}.bin", "a".repeat(250));
        assert_eq!(title_for(&details(&[upload(&long)]), Some(1)), format!("Synced {long}"));
    }

    #[test]
    fn a_directory_shaped_entry_keeps_its_whole_name() {
        // A trailing separator leaves no last segment to show; falling back to
        // the whole string beats an empty "Synced ".
        assert_eq!(title_for(&details(&[upload("Vacation/")]), Some(1)), "Synced Vacation/");
    }

    #[test]
    fn several_files_are_counted() {
        let three = details(&[upload("a.txt"), upload("b.txt"), upload("nested/c.txt")]);
        assert_eq!(title_for(&three, Some(3)), "Synced 3 files");
    }

    // The regression this guards: `file_details_json` is capped at
    // MAX_NOTIFICATION_FILES (and again by the hook's own buffer), so counting
    // its entries reports "Synced 200 files" for a 5 000-file initial sync —
    // a wrong number in the only line the list shows.
    #[test]
    fn the_count_comes_from_the_cycle_not_from_the_capped_list() {
        let capped: Vec<serde_json::Value> = (0..200).map(|i| upload(&format!("f{i}.bin"))).collect();
        assert_eq!(title_for(&details(&capped), Some(5_000)), "Synced 5000 files");
    }

    // A list of one next to a count of five is a truncation, not a one-file
    // cycle; naming that entry would bury the other four.
    #[test]
    fn a_single_name_needs_the_count_to_agree() {
        assert_eq!(title_for(&details(&[upload("a.txt")]), Some(5)), "Synced 5 files");
        assert_eq!(title_for(&details(&[upload("a.txt"), upload("b.txt")]), Some(1)), "Sync Complete");
    }

    // Deletes must never be phrased as "Synced <name>": the file is gone, and
    // the title would read as a successful upload of it.
    #[test]
    fn deletes_never_lend_their_name_to_the_title() {
        let deleted = serde_json::json!({ "fileName": "report.pdf", "totalBytes": 8, "action": "remote_delete" });
        assert_eq!(title_for(&details(&[deleted.clone()]), Some(1)), "Sync Complete");

        // A mixed cycle still counts every file it touched.
        assert_eq!(title_for(&details(&[upload("a.txt"), deleted]), Some(2)), "Synced 2 files");
    }

    #[test]
    fn an_unusable_file_list_keeps_the_generic_title() {
        for json in ["", "[]", "{}", "not json", r#"[{"totalBytes":1,"action":"upload"}]"#] {
            assert_eq!(title_for(json, None), "Sync Complete", "unexpected title for {json:?}");
        }
    }

    // The count is optional over IPC, so a caller that omits it (or a param
    // rename that silently drops it) degrades to the list length rather than
    // to no title at all.
    #[test]
    fn a_missing_count_falls_back_to_the_list_length() {
        assert_eq!(title_for(&details(&[upload("a.txt")]), None), "Synced a.txt");
        assert_eq!(title_for(&details(&[upload("a.txt"), upload("b.txt")]), None), "Synced 2 files");
    }

    // A failure that borrowed a filename from its file list would read as a
    // success in the list, which is the one thing the title must never do.
    #[test]
    fn only_the_success_outcome_takes_its_title_from_the_file_list() {
        let files = SyncFileSummary {
            details_json: &details(&[upload("stuck.bin")]),
            file_count: Some(1),
        };
        assert_eq!(SyncNotificationOutcome::Error.list_title(&files), "Sync Failed");
        assert_eq!(SyncNotificationOutcome::FolderRestored.list_title(&files), "Folder Restored");
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

    // The other half of the `active_count > 0 && !above_half` relaxation: the
    // dip after a top-up is let through the active-count guard, so the ONLY
    // thing stopping it from firing again on the very next poll is the
    // fall-through resetting `above_half` to false. Without that reset the
    // user gets a fresh warning row on every route change.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dip_after_a_top_up_notifies_once_not_on_every_check() {
        let (_dir, pool) = fresh_pool().await;
        insert_low_credit(&pool, "addrA", 0, None).await;

        check_low_credit_notification_inner(&pool, "addrA", ABOVE_HALF_PLANCK)
            .await
            .expect("top-up");

        let dip = check_low_credit_notification_inner(&pool, "addrA", BELOW_HALF_PLANCK).await.expect("dip");
        assert!(dip.should_notify, "the first dip after a top-up warns again");

        let again = check_low_credit_notification_inner(&pool, "addrA", BELOW_HALF_PLANCK)
            .await
            .expect("still low");
        assert!(
            !again.should_notify,
            "the dip must settle above_half back to false, or every later check raises another warning",
        );
    }

    // `mark_low_credit_warnings_read` runs on EVERY check with a healthy
    // balance, so a too-wide predicate silently marks the user's whole bell
    // read. The "credits just landed" row sits next to the warning in that
    // same bell — it is exactly what a widened UPDATE would swallow.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn top_up_only_retires_low_credit_warnings() {
        let (_dir, pool) = fresh_pool().await;
        insert_low_credit(&pool, "addrA", 0, None).await;
        insert_notification(&pool, "addrA", "Credits", "CreditsAdded-42").await;
        insert_notification(&pool, "addrA", "Files", "FileSyncComplete-7").await;

        check_low_credit_notification_inner(&pool, "addrA", ABOVE_HALF_PLANCK)
            .await
            .expect("top-up");

        for subtype in ["CreditsAdded-42", "FileSyncComplete-7"] {
            assert_eq!(
                unread_flag(&pool, "addrA", subtype).await,
                1,
                "{subtype} is not a low-credit warning and must stay unread after a top-up",
            );
        }
    }

    // "Mark as unread" is a real bell action (`mark_notification_unread`,
    // wired to the notification context menu and detail view). Clearing on
    // every healthy check — rather than on the low -> healthy crossing —
    // silently undoes the user on their next route change.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_steady_healthy_balance_does_not_re_read_a_reopened_warning() {
        let (_dir, pool) = fresh_pool().await;
        insert_low_credit(&pool, "addrA", 0, None).await;

        check_low_credit_notification_inner(&pool, "addrA", ABOVE_HALF_PLANCK)
            .await
            .expect("top-up");
        assert_eq!(warning_unread_deleted(&pool, "addrA").await.0, 0, "the crossing retires the warning");

        sqlx::query("UPDATE notifications SET is_unread = 1 WHERE user_address = 'addrA'")
            .execute(&pool)
            .await
            .expect("user reopened the warning from the bell");

        check_low_credit_notification_inner(&pool, "addrA", ABOVE_HALF_PLANCK)
            .await
            .expect("still healthy");
        assert_eq!(
            warning_unread_deleted(&pool, "addrA").await.0,
            1,
            "a steady healthy balance must leave the user's own unread state alone",
        );
    }

    async fn insert_notification(pool: &sqlx::SqlitePool, user: &str, kind: &str, subtype: &str) {
        sqlx::query(
            "INSERT INTO notifications (user_address, notification_type, notification_subtype, is_deleted, creation_time) \
             VALUES (?, ?, ?, 0, 1)",
        )
        .bind(user)
        .bind(kind)
        .bind(subtype)
        .execute(pool)
        .await
        .expect("insert");
    }

    async fn unread_flag(pool: &sqlx::SqlitePool, user: &str, subtype: &str) -> i64 {
        sqlx::query_as::<_, (i64,)>("SELECT is_unread FROM notifications WHERE user_address = ? AND notification_subtype = ?")
            .bind(user)
            .bind(subtype)
            .fetch_one(pool)
            .await
            .expect("notification row")
            .0
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
