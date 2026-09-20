//! Desktop-native surfaces for chat: OS notifications and the unread badge.
//!
//! The webview knows *what* happened (a decrypted message arrived in room
//! X from Y, the unread total is N); this module decides *whether the user
//! is told* and does the telling through the OS, so the policy — the
//! per-account "Chat" notification preference, focus suppression — lives in
//! Rust next to the other notification categories.
//!
//! Chat messages deliberately do **not** create rows in the in-app
//! `notifications` table: that list is for account events (credits, sync
//! outcomes), and one row per message would bury them. Unread state for
//! chat is the homeserver's (read receipts), mirrored here only as a badge
//! number.
//!
//! The badge uses the taskbar/dock badge count of the main window (macOS
//! dock, Linux launchers that honour `com.canonical.Unity.LauncherEntry`);
//! Windows has no count badge and the call is a logged no-op there. The
//! same count is mirrored into the main window's title (`(3) Hippius`), the
//! one place every platform's taskbar/switcher shows, and broadcast as
//! [`CHAT_UNREAD_CHANGED_EVENT`] for the tray popover.
//!
//! What counts as notification-worthy is decided here, not in the webview:
//! the webview only reports the Matrix facts (the server's push rules said
//! notify, whether that was a highlight/mention, whether the room is a
//! direct message) and [`decide_notify`] applies the desktop rule — Slack's
//! default — **mentions in channels, every message in a DM**, unless the
//! account's "Chat" preference is off or the user is already looking at the
//! room.

use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tracing::{debug, warn};

use crate::app_state::AppState;
use crate::error::{AppError, Result};

/// Preference row id in `notification_preferences` (seeded in
/// `notifications::crud::DEFAULT_PREFERENCES`).
pub const CHAT_PREFERENCE_ID: &str = "chat";

/// Event the frontend (main window and tray popover) receives whenever the
/// unread total changes, so any surface can mirror the badge.
pub const CHAT_UNREAD_CHANGED_EVENT: &str = "chat_unread_changed";

/// The main window's title as configured in `tauri.conf.json`
/// (`app.windows[0].title`). Pinned against the config file in tests so a
/// rename there cannot leave the unread-count title stale.
pub const APP_WINDOW_TITLE: &str = "Hippius";

/// Label of the main window (`tauri.conf.json` `app.windows[0].label`).
const MAIN_WINDOW_LABEL: &str = "main";

/// The window title for an unread count: `Hippius` at zero, `(N) Hippius`
/// otherwise — the convention Slack, Discord and Element desktop share, so
/// the count is read the same way in every taskbar and window switcher.
pub fn window_title(unread: u32) -> String {
    if unread == 0 {
        APP_WINDOW_TITLE.to_string()
    } else {
        format!("({unread}) {APP_WINDOW_TITLE}")
    }
}

/// Longest body we forward to the OS notification centre. Messages are
/// end-to-end encrypted; the notification centre's own store is not, so
/// only a preview leaves the app.
pub const NOTIFICATION_BODY_PREVIEW_CHARS: usize = 140;

/// One incoming message the webview reports. The webview has already
/// applied the Matrix-side facts only it can know — not our own message,
/// not a local echo, not history catching up, and the account's push rules
/// (which know muted rooms and keywords) said *notify*. Whether the user is
/// told is decided here.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IncomingMessage {
    pub room_id: String,
    pub room_name: String,
    pub sender_name: String,
    pub body: String,
    /// Direct message (1:1) rather than a channel; changes the title and
    /// makes every message notification-worthy.
    #[serde(default)]
    pub is_direct: bool,
    /// The push rules flagged it as a highlight: a mention of the user (or
    /// one of their keywords). A channel message notifies only when set.
    #[serde(default)]
    pub is_mention: bool,
    /// The user currently has this room open in the app.
    #[serde(default)]
    pub room_is_open: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnreadChanged {
    pub count: u32,
}

/// Why a message did or did not produce an OS notification. Returned to the
/// webview so its diagnostics view can say so, and pinned in tests.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NotifyOutcome {
    Shown,
    PreferenceDisabled,
    /// A channel message that mentions nobody: unread, but not interrupting.
    NotMentionOrDirect,
    RoomVisible,
}

/// Pure policy, in order: the preference is off → nothing; a channel
/// message without a mention → nothing (a DM always qualifies); the user is
/// already looking at the room (window focused AND that room open) →
/// nothing; otherwise notify.
pub fn decide_notify(preference_enabled: bool, message: &IncomingMessage, window_focused: bool) -> NotifyOutcome {
    if !preference_enabled {
        return NotifyOutcome::PreferenceDisabled;
    }
    if !(message.is_direct || message.is_mention) {
        return NotifyOutcome::NotMentionOrDirect;
    }
    if window_focused && message.room_is_open {
        return NotifyOutcome::RoomVisible;
    }
    NotifyOutcome::Shown
}

/// Title + body for the OS notification. A DM is "Sender"; a channel is
/// "Sender in #room". The body is a bounded preview on a char boundary.
pub fn render_notification(msg: &IncomingMessage) -> (String, String) {
    let title = if msg.is_direct {
        msg.sender_name.clone()
    } else {
        format!("{} in {}", msg.sender_name, msg.room_name)
    };
    let body: String = msg.body.chars().take(NOTIFICATION_BODY_PREVIEW_CHARS).collect();
    let body = if msg.body.chars().count() > NOTIFICATION_BODY_PREVIEW_CHARS {
        format!("{body}…")
    } else {
        body
    };
    (title, body)
}

/// Whether the account's "Chat" notification category is on. Absent rows
/// count as enabled — the seed runs on the preferences page, which the
/// user may never have opened, and the default there is enabled.
pub async fn chat_preference_enabled(pool: &sqlx::SqlitePool, owner: &str) -> Result<bool> {
    let row: Option<(i32,)> = sqlx::query_as("SELECT enabled FROM notification_preferences WHERE owner = ? AND id = ?")
        .bind(owner)
        .bind(CHAT_PREFERENCE_ID)
        .fetch_optional(pool)
        .await?;
    Ok(row.is_none_or(|(e,)| e != 0))
}

/// Write the account's "Chat" notification category. Upserts the row with
/// the same label/description the preferences page seeds, so a toggle from
/// the chat Preferences and one from Settings → Notifications land on the
/// same `(owner, "chat")` row — there is exactly one switch.
pub async fn set_chat_preference_enabled(pool: &sqlx::SqlitePool, owner: &str, enabled: bool) -> Result<()> {
    sqlx::query(
        "INSERT INTO notification_preferences (owner, id, label, description, enabled) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(owner, id) DO UPDATE SET enabled = excluded.enabled",
    )
    .bind(owner)
    .bind(CHAT_PREFERENCE_ID)
    .bind("Chat")
    .bind("Desktop notifications for new team chat messages and mentions")
    .bind(i32::from(enabled))
    .execute(pool)
    .await?;
    Ok(())
}

/// The chat Preferences dialog's notifications switch (read).
#[tauri::command]
pub async fn chat_get_notifications_enabled(state: tauri::State<'_, AppState>) -> Result<bool> {
    let owner = state.current_account_id()?;
    chat_preference_enabled(state.pool()?, &owner).await
}

/// The chat Preferences dialog's notifications switch (write).
#[tauri::command]
pub async fn chat_set_notifications_enabled(state: tauri::State<'_, AppState>, enabled: bool) -> Result<()> {
    let owner = state.current_account_id()?;
    set_chat_preference_enabled(state.pool()?, &owner, enabled).await
}

fn main_window_focused(app: &AppHandle) -> bool {
    app.get_webview_window(MAIN_WINDOW_LABEL)
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false)
}

/// Show an OS notification for a chat message, subject to policy.
#[tauri::command]
pub async fn chat_notify_message(app: AppHandle, state: tauri::State<'_, AppState>, message: IncomingMessage) -> Result<NotifyOutcome> {
    let owner = state.current_account_id()?;
    let enabled = chat_preference_enabled(state.pool()?, &owner).await?;
    let outcome = decide_notify(enabled, &message, main_window_focused(&app));
    if outcome != NotifyOutcome::Shown {
        debug!(?outcome, room = %message.room_id, "chat: notification suppressed");
        return Ok(outcome);
    }
    let (title, body) = render_notification(&message);
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| AppError::Other(format!("chat: OS notification failed: {e}")))?;
    Ok(NotifyOutcome::Shown)
}

/// The one writer of every unread surface: dock/taskbar badge, main window
/// title, the remembered count, and the cross-window broadcast. Called by
/// the webview through [`chat_set_unread_badge`] and by logout through
/// [`clear_unread_badge`], so a signed-out app never keeps a stale `(3)`.
pub fn apply_unread_badge(app: &AppHandle, count: u32) {
    let state = app.state::<AppState>();
    let previous = state.chat.unread.swap(count, Ordering::SeqCst);
    if let Some(win) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let value = if count == 0 { None } else { Some(i64::from(count)) };
        if let Err(e) = win.set_badge_count(value) {
            // Windows: unsupported by design. Log once per change at debug.
            debug!(error = %e, count, "chat: badge count not supported on this platform");
        }
        if let Err(e) = win.set_title(&window_title(count)) {
            warn!(error = %e, count, "chat: failed to set the window title");
        }
    }
    if previous != count {
        if let Err(e) = app.emit(CHAT_UNREAD_CHANGED_EVENT, UnreadChanged { count }) {
            warn!(error = %e, "chat: failed to broadcast unread count");
        }
    }
}

/// Reset every unread surface to zero. Logout calls this: the Matrix client
/// stops with the webview's provider, but the dock badge and window title
/// are OS state that nobody else would clear.
pub fn clear_unread_badge(app: &AppHandle) {
    apply_unread_badge(app, 0);
}

/// Set the dock/taskbar unread badge + window title and broadcast the count.
#[tauri::command]
pub async fn chat_set_unread_badge(app: AppHandle, count: u32) -> Result<()> {
    apply_unread_badge(&app, count);
    Ok(())
}

/// The last count set through [`chat_set_unread_badge`]. The tray popover
/// (a separate webview) seeds its mirror from this and then follows
/// [`CHAT_UNREAD_CHANGED_EVENT`].
#[tauri::command]
pub async fn chat_get_unread_count(state: tauri::State<'_, AppState>) -> Result<u32> {
    Ok(state.chat.unread.load(Ordering::SeqCst))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(body: &str, is_direct: bool) -> IncomingMessage {
        IncomingMessage {
            room_id: "!r:hippius.com".into(),
            room_name: "#general".into(),
            sender_name: "Alice".into(),
            body: body.into(),
            is_direct,
            is_mention: false,
            room_is_open: false,
        }
    }

    fn with(mut m: IncomingMessage, is_mention: bool, room_is_open: bool) -> IncomingMessage {
        m.is_mention = is_mention;
        m.room_is_open = room_is_open;
        m
    }

    #[test]
    fn preference_off_wins_over_everything() {
        assert_eq!(
            decide_notify(false, &with(msg("hi", true), true, false), false),
            NotifyOutcome::PreferenceDisabled
        );
        assert_eq!(
            decide_notify(false, &with(msg("hi", false), false, true), true),
            NotifyOutcome::PreferenceDisabled
        );
    }

    // Slack's default: a channel message notifies only when it mentions the
    // user; a DM always does. Neither the focus state nor the open room
    // rescues a plain channel message.
    #[test]
    fn channel_messages_notify_only_on_mention_dms_always() {
        assert_eq!(decide_notify(true, &msg("hi", false), false), NotifyOutcome::NotMentionOrDirect);
        assert_eq!(decide_notify(true, &with(msg("hi", false), true, false), false), NotifyOutcome::Shown);
        assert_eq!(decide_notify(true, &msg("hi", true), false), NotifyOutcome::Shown);
        assert_eq!(decide_notify(true, &with(msg("hi", true), true, false), false), NotifyOutcome::Shown);
    }

    #[test]
    fn visible_room_suppresses_only_when_window_is_focused() {
        // Focused AND that room open: the user is reading it.
        assert_eq!(decide_notify(true, &with(msg("hi", true), false, true), true), NotifyOutcome::RoomVisible);
        // Room open but window in the background: the user is not looking.
        assert_eq!(decide_notify(true, &with(msg("hi", true), false, true), false), NotifyOutcome::Shown);
        // Window focused but a different room open.
        assert_eq!(decide_notify(true, &with(msg("hi", true), false, false), true), NotifyOutcome::Shown);
    }

    #[test]
    fn window_title_carries_the_count_and_resets_at_zero() {
        assert_eq!(window_title(0), "Hippius");
        assert_eq!(window_title(1), "(1) Hippius");
        assert_eq!(window_title(42), "(42) Hippius");
    }

    // A rename in tauri.conf.json must reach the unread title too, or the
    // first message would swap the app's name in the taskbar.
    #[test]
    fn window_title_matches_tauri_conf() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let main = conf["app"]["windows"]
            .as_array()
            .unwrap()
            .iter()
            // The main window carries no explicit label: Tauri defaults it to "main".
            .find(|w| w.get("label").map_or(true, |l| l == MAIN_WINDOW_LABEL))
            .expect("main window in tauri.conf.json");
        assert_eq!(main["title"].as_str().unwrap(), APP_WINDOW_TITLE);
    }

    #[test]
    fn rendering_titles_and_bounded_preview() {
        assert_eq!(render_notification(&msg("hi", true)).0, "Alice");
        assert_eq!(render_notification(&msg("hi", false)).0, "Alice in #general");
        let long = "é".repeat(NOTIFICATION_BODY_PREVIEW_CHARS + 10);
        let (_, body) = render_notification(&msg(&long, false));
        assert_eq!(body.chars().count(), NOTIFICATION_BODY_PREVIEW_CHARS + 1);
        assert!(body.ends_with('…'));
        assert_eq!(render_notification(&msg("short", false)).1, "short");
    }

    #[tokio::test]
    async fn preference_absent_means_enabled_and_row_is_respected() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::utils::schema::ensure_table_schema(&pool).await.unwrap();
        assert!(chat_preference_enabled(&pool, "5Fowner").await.unwrap());
        sqlx::query("INSERT INTO notification_preferences (owner, id, label, description, enabled) VALUES ('5Fowner', 'chat', 'Chat', '', 0)")
            .execute(&pool)
            .await
            .unwrap();
        assert!(!chat_preference_enabled(&pool, "5Fowner").await.unwrap());
        // Another account's toggle does not leak.
        assert!(chat_preference_enabled(&pool, "5Fother").await.unwrap());
    }

    // The Preferences switch and the Settings → Notifications page must be
    // the same row: writing through the chat setter is read back by the
    // notification gate, flips both ways, and stays per-account.
    #[tokio::test]
    async fn set_preference_round_trips_and_is_account_scoped() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::utils::schema::ensure_table_schema(&pool).await.unwrap();
        set_chat_preference_enabled(&pool, "5Fowner", false).await.unwrap();
        assert!(!chat_preference_enabled(&pool, "5Fowner").await.unwrap());
        assert!(chat_preference_enabled(&pool, "5Fother").await.unwrap());
        // Upsert, not insert: a second write flips the same row.
        set_chat_preference_enabled(&pool, "5Fowner", true).await.unwrap();
        assert!(chat_preference_enabled(&pool, "5Fowner").await.unwrap());
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM notification_preferences WHERE owner = '5Fowner' AND id = 'chat'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn incoming_message_wire_shape_is_camel_case() {
        let m: IncomingMessage = serde_json::from_str(
            r##"{"roomId":"!r:h","roomName":"#g","senderName":"A","body":"b","isDirect":true,"isMention":true,"roomIsOpen":true}"##,
        )
        .unwrap();
        assert!(m.is_direct && m.is_mention && m.room_is_open);
        let m: IncomingMessage = serde_json::from_str(r##"{"roomId":"!r:h","roomName":"#g","senderName":"A","body":"b"}"##).unwrap();
        assert!(!m.is_direct && !m.is_mention && !m.room_is_open);
    }
}
