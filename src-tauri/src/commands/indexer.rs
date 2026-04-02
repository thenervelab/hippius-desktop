//! Indexer API key command.
//!
//! Exposes the `INDEXER_API_KEY` environment variable to the frontend
//! so it can authenticate directly with the blockchain indexer service.

use crate::error::AppError;

/// Return the indexer API key from the environment.
///
/// Fails if the variable is missing or empty so the frontend can
/// surface a clear error rather than making unauthorized requests.
#[tauri::command]
pub fn get_indexer_api_key() -> Result<String, AppError> {
    let key = std::env::var("INDEXER_API_KEY").map_err(|_| AppError::Validation("INDEXER_API_KEY is not set".into()))?;

    if key.trim().is_empty() {
        return Err(AppError::Validation("INDEXER_API_KEY is empty".into()));
    }

    Ok(key)
}
