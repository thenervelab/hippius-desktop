use crate::commands::substrate_tx::SyncPathResult;
use crate::commands::substrate_tx::get_sync_path_internal;

pub async fn get_public_sync_path() -> Result<String, String> {
    match get_sync_path_internal(true).await {
        Ok(SyncPathResult { path, .. }) => Ok(path),
        Err(e) => Err(e),
    }
}

pub async fn get_private_sync_path() -> Result<String, String> {
    match get_sync_path_internal(false).await {
        Ok(SyncPathResult { path, .. }) => Ok(path),
        Err(e) => Err(e),
    }
}