//! Active account tracking helpers.
//!
//! Provides get/set for the currently logged-in account ID, used by
//! background tasks that need to know which user's data to operate on.

use crate::app_state::AppState;

/// Store the active account ID for background tasks to reference.
pub fn set_active_account(state: &AppState, account_id: &str) {
    let mut guard = state
        .active_account_id
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    *guard = Some(account_id.to_string());
}

/// Retrieve the active account ID, or error if no user is logged in.
pub fn current_account_id(state: &AppState) -> Result<String, String> {
    state
        .active_account_id
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .ok_or_else(|| "No active account set".to_string())
}
