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
//! Windows has no count badge and the call is a logged no-op there.

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

/// Longest body we forward to the OS notification centre. Messages are
/// end-to-end encrypted; the notification centre's own store is not, so
/// only a preview leaves the app.
pub const NOTIFICATION_BODY_PREVIEW_CHARS: usize = 140;

/// One incoming message the webview considers notification-worthy (it has
/// already excluded the user's own messages and rooms with notifications
/// muted in the account's push rules).
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IncomingMessage {
    pub room_id: String,
    pub room_name: String,
    pub sender_name: String,
    pub body: String,
    /// Direct message (1:1) rather than a channel; changes the title.
    #[serde(default)]
    pub is_direct: bool,
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
    RoomVisible,
}

/// Pure policy: notify unless the preference is off, or the user is
/// already looking at the room (window focused AND that room open).
pub fn decide_notify(preference_enabled: bool, window_focused: bool, room_is_open: bool) -> NotifyOutcome {
    if !preference_enabled {
        return NotifyOutcome::PreferenceDisabled;
    }
    if window_focused && room_is_open {
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

fn main_window_focused(app: &AppHandle) -> bool {
    app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false)
}

/// Show an OS notification for a chat message, subject to policy.
#[tauri::command]
pub async fn chat_notify_message(app: AppHandle, state: tauri::State<'_, AppState>, message: IncomingMessage) -> Result<NotifyOutcome> {
    let owner = state.current_account_id()?;
    let enabled = chat_preference_enabled(state.pool()?, &owner).await?;
    let outcome = decide_notify(enabled, main_window_focused(&app), message.room_is_open);
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

/// Set the dock/taskbar unread badge and broadcast the count.
#[tauri::command]
pub async fn chat_set_unread_badge(app: AppHandle, count: u32) -> Result<()> {
    if let Some(win) = app.get_webview_window("main") {
        let value = if count == 0 { None } else { Some(i64::from(count)) };
        if let Err(e) = win.set_badge_count(value) {
            // Windows: unsupported by design. Log once per change at debug.
            debug!(error = %e, count, "chat: badge count not supported on this platform");
        }
    }
    if let Err(e) = app.emit(CHAT_UNREAD_CHANGED_EVENT, UnreadChanged { count }) {
        warn!(error = %e, "chat: failed to broadcast unread count");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_table() {
        assert_eq!(decide_notify(false, false, false), NotifyOutcome::PreferenceDisabled);
        assert_eq!(decide_notify(false, true, true), NotifyOutcome::PreferenceDisabled);
        assert_eq!(decide_notify(true, true, true), NotifyOutcome::RoomVisible);
        // Room open but window in the background: the user is not looking.
        assert_eq!(decide_notify(true, false, true), NotifyOutcome::Shown);
        // Window focused but a different room open.
        assert_eq!(decide_notify(true, true, false), NotifyOutcome::Shown);
    }

    fn msg(body: &str, is_direct: bool) -> IncomingMessage {
        IncomingMessage {
            room_id: "!r:hippius.com".into(),
            room_name: "#general".into(),
            sender_name: "Alice".into(),
            body: body.into(),
            is_direct,
            room_is_open: false,
        }
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

    #[test]
    fn incoming_message_wire_shape_is_camel_case() {
        let m: IncomingMessage =
            serde_json::from_str(r##"{"roomId":"!r:h","roomName":"#g","senderName":"A","body":"b","isDirect":true,"roomIsOpen":true}"##).unwrap();
        assert!(m.is_direct && m.room_is_open);
        let m: IncomingMessage = serde_json::from_str(r##"{"roomId":"!r:h","roomName":"#g","senderName":"A","body":"b"}"##).unwrap();
        assert!(!m.is_direct && !m.room_is_open);
    }
}
