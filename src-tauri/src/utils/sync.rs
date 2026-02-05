use crate::commands::substrate_tx::get_sync_path_internal;
use crate::commands::substrate_tx::SyncPathResult;
use crate::utils::account_key::account_key;
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

pub async fn get_public_sync_path() -> Result<String, String> {
    let account_id = current_account_id()?;
    let owner = account_key(&account_id);
    match get_sync_path_internal(true, &owner).await {
        Ok(SyncPathResult { path, .. }) => Ok(path),
        Err(e) => Err(e),
    }
}

pub async fn get_private_sync_path() -> Result<String, String> {
    let account_id = current_account_id()?;
    let owner = account_key(&account_id);
    match get_sync_path_internal(false, &owner).await {
        Ok(SyncPathResult { path, .. }) => Ok(path),
        Err(e) => Err(e),
    }
}
