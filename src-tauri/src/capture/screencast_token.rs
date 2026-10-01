//! Wayland: the ScreenCast portal's restore token, so a second recording of
//! the whole screen does not ask in the desktop's dialog again.
//!
//! The portal hands a token back with every session it may restore
//! (`PersistMode::ExplicitlyRevoked`, asked for monitors only), and the next
//! session started with it gets the same choice WITHOUT the dialog. That is
//! right only when there is nothing else to choose: with one display, the
//! screen is the screen. With two or more, the token is not sent, so the
//! user picks every time (a restored session would record the display
//! chosen last, unasked, with no way to pick the other). A window is always
//! chosen afresh (`linux_plan::portal_ask` never persists one).
//!
//! The token is device-wide (`user_preferences`, like the bar's options),
//! not per account: the desktop grants screen sharing to this app on this
//! machine, whoever is signed in to it. Each token is single use; the one
//! the latest session returned replaces it.

use sqlx::SqlitePool;

use super::screenshot::Selection;

const TOKEN_KEY: &str = "capture_screencast_restore_v1";

/// Whether a saved token is sent for `selection` with `displays` connected.
#[must_use]
pub const fn applies(selection: Selection, displays: usize) -> bool {
    matches!(selection, Selection::Screen { .. }) && displays == 1
}

/// The token to start a recording of `selection` with, when it applies.
pub async fn for_start(pool: &SqlitePool, selection: Selection, displays: usize) -> Option<String> {
    if !applies(selection, displays) {
        return None;
    }
    crate::utils::preferences::get_user_preference_internal(pool, TOKEN_KEY)
        .await
        .ok()
        .flatten()
        .filter(|t| !t.trim().is_empty())
}

/// Keep the token the portal returned for next time. Best effort: without
/// it the dialog simply shows again.
pub async fn remember(pool: &SqlitePool, token: Option<String>) {
    let Some(token) = token.filter(|t| !t.trim().is_empty()) else {
        return;
    };
    if let Err(e) = crate::utils::preferences::save_user_preference_internal(pool, TOKEN_KEY, &token).await {
        tracing::debug!(error = %e, "screen-sharing restore token not kept");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::geometry::LogicalRect;

    /// One display and the whole screen: nothing else to choose, so the
    /// dialog is skipped. Anything else asks again.
    #[test]
    fn a_token_is_sent_only_for_the_one_screen_there_is() {
        let screen = Selection::Screen { display_id: 0 };
        assert!(applies(screen, 1));
        assert!(!applies(screen, 2), "two displays: the user picks which");
        assert!(!applies(screen, 0), "no display known: ask");
        assert!(!applies(Selection::Window { window_id: 0 }, 1), "a window is chosen afresh");
        let area = Selection::Area {
            display_id: 0,
            rect: LogicalRect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
        };
        assert!(!applies(area, 1));
    }

    #[tokio::test]
    async fn the_latest_token_is_kept_and_sent_back() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("pool");
        crate::utils::schema::ensure_table_schema(&pool).await.expect("schema");
        let screen = Selection::Screen { display_id: 0 };
        assert_eq!(for_start(&pool, screen, 1).await, None);
        remember(&pool, Some("first".into())).await;
        remember(&pool, Some("second".into())).await;
        remember(&pool, Some("  ".into())).await;
        remember(&pool, None).await;
        assert_eq!(for_start(&pool, screen, 1).await.as_deref(), Some("second"));
        assert_eq!(for_start(&pool, screen, 2).await, None);
    }
}
