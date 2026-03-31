#[tauri::command]
pub fn get_indexer_api_key() -> Result<String, String> {
    let key =
        std::env::var("INDEXER_API_KEY").map_err(|_| "INDEXER_API_KEY is not set".to_string())?;

    if key.trim().is_empty() {
        return Err("INDEXER_API_KEY is empty".to_string());
    }

    Ok(key)
}
