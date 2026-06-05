//! In-app notifications — CRUD, credit alerts, and remote settings.

pub mod credits;
pub mod crud;
pub mod settings;

use crate::app_state::AppState;
use crate::error::AppError;

/// Resolve the account a notification *write* must target: always the
/// signed-in account, never a caller-supplied address.
///
/// The read path ([`crud::list_notifications`]) and the per-row mutation
/// commands already derive the account from the session and ignore any
/// caller-supplied ss58. The write commands ([`crud::add_notification`],
/// [`credits::create_sync_notification`], [`credits::create_credit_notifications`])
/// historically trusted a caller-supplied `user_address`, so an authenticated
/// caller could plant a notification row in another account's feed. This
/// returns the session account and ignores `claimed`, warning when they differ
/// so a genuine mismatch (a frontend bug or direct-IPC misuse) is diagnosable
/// (audit 2026-06-05, finding E1).
pub(crate) fn session_scoped_notification_account(state: &AppState, claimed: &str) -> Result<String, AppError> {
    let session = state.current_account_id()?;
    if !claimed.is_empty() && claimed != session {
        tracing::warn!(
            claimed = %claimed,
            "notifications: ignoring caller-supplied user_address; scoping the write to the session account"
        );
    }
    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::state::AuthCapabilities;

    #[test]
    fn scopes_write_to_session_account_overriding_mismatch() {
        let state = AppState::new();
        state.set_active_account("5Session", AuthCapabilities::None).expect("set session");

        // A matching claim resolves to the session account.
        assert_eq!(session_scoped_notification_account(&state, "5Session").unwrap(), "5Session");
        // A MISMATCHED claim still resolves to the session account — the caller
        // cannot redirect the write to another account's feed.
        assert_eq!(session_scoped_notification_account(&state, "5Attacker").unwrap(), "5Session");
        // An empty claim (frontend passed none) resolves to the session account.
        assert_eq!(session_scoped_notification_account(&state, "").unwrap(), "5Session");
    }

    #[test]
    fn errors_when_no_session() {
        let state = AppState::new();
        assert!(
            session_scoped_notification_account(&state, "5Anything").is_err(),
            "writing a notification with no signed-in account must error, not default to the caller's address"
        );
    }
}
