use crate::app_state::AppState;

pub fn set_active_account(state: &AppState, account_id: &str) {
    let mut guard = state
        .active_account_id
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    *guard = Some(account_id.to_string());
}

pub fn current_account_id(state: &AppState) -> Result<String, String> {
    state
        .active_account_id
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .ok_or_else(|| "No active account set".to_string())
}
