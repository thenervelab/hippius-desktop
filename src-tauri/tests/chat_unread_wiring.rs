//! Pins the chat unread-badge wiring: the badge/title reset on logout and
//! the IPC registration. Both are single call sites nothing else exercises
//! — a lost logout call leaves the previous account's `(3) Hippius` title
//! and dock badge on the login screen, and a dropped `generate_handler!`
//! entry only fails at runtime in the webview.

const MAIN_RS: &str = include_str!("../src/main.rs");
const LOGOUT_RS: &str = include_str!("../src/auth/logout.rs");

/// `logout_full` must reset the unread surfaces AFTER the session is
/// genuinely cleared (a failed `auth_logout_internal` leaves the user
/// signed in, so the badge must stay too).
#[test]
fn logout_full_clears_the_chat_unread_badge_after_auth_clear() {
    let body_start = LOGOUT_RS.find("pub async fn logout_full").expect("logout_full exists");
    let body = &LOGOUT_RS[body_start..];
    let auth_clear = body.find("auth_logout_internal(&state, &account_id).await?;").expect("logout_full clears auth");
    let badge = body
        .find("crate::chat::notify::clear_unread_badge(&app);")
        .expect("logout_full must reset the chat unread badge + window title");
    assert!(badge > auth_clear, "the badge reset must run after the session is cleared");
}

#[test]
fn unread_badge_commands_are_registered() {
    for cmd in [
        "chat::notify::chat_notify_message",
        "chat::notify::chat_set_unread_badge",
        "chat::notify::chat_get_unread_count",
        "chat::notify::chat_get_notifications_enabled",
        "chat::notify::chat_set_notifications_enabled",
    ] {
        assert!(MAIN_RS.contains(cmd), "{cmd} must be in generate_handler!");
    }
}
