use once_cell::sync::Lazy;
use std::sync::Mutex;

static ACTIVE_ACCOUNT_ID: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

pub fn set_active_account(account_id: &str) {
    let mut guard = ACTIVE_ACCOUNT_ID.lock().unwrap();
    *guard = Some(account_id.to_string());
}

pub fn current_account_id() -> Result<String, String> {
    ACTIVE_ACCOUNT_ID
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No active account set".to_string())
}
