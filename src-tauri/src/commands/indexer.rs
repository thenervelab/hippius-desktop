//! Indexer API key command.
//!
//! Exposes the `INDEXER_API_KEY` environment variable to the frontend
//! so it can authenticate directly with the blockchain indexer service.

/// Return the indexer API key from the environment.
///
/// Fails if the variable is missing or empty so the frontend can
/// surface a clear error rather than making unauthorized requests.
#[tauri::command]
pub fn get_indexer_api_key() -> Result<String, String> {
    let key = std::env::var("INDEXER_API_KEY").map_err(|_| "INDEXER_API_KEY is not set".to_string())?;

    if key.trim().is_empty() {
        return Err("INDEXER_API_KEY is empty".to_string());
    }

    Ok(key)
}
