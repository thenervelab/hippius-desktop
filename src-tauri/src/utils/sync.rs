use crate::commands::substrate_tx::{get_sync_path, SyncPathResult};
use crate::constants::substrate::{SYNC_PATH, SYNC_PATH_PRIVATE};
use crate::commands::substrate_tx::get_sync_path_internal;

pub async fn get_public_sync_path() -> String {
    match get_sync_path_internal(true).await {
        Ok(SyncPathResult { path, .. }) => path,
        Err(_) => SYNC_PATH.to_string(),
    }
}

pub async fn get_private_sync_path() -> String {
    match get_sync_path_internal(false).await {
        Ok(SyncPathResult { path, .. }) => path,
        Err(_) => SYNC_PATH_PRIVATE.to_string(),
    }
}


