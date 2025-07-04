use crate::utils::ipfs::pin_json_to_ipfs_local;
use crate::commands::substrate_tx::FileInputWrapper;
use crate::commands::substrate_tx::storage_unpin_request_tauri;
use crate::DB_POOL;
use crate::commands::substrate_tx::FileHashWrapper;

pub async fn request_file_storage(
    file_name: &str,
    file_cid: &str,
    api_url: &str,
) -> Result<String, String> {
    // 1. Create the JSON
    let json = serde_json::json!([{
        "filename": file_name,
        "cid": file_cid
    }]);
    let json_string = serde_json::to_string(&json).unwrap();

    // 2. Pin JSON to local IPFS node
    let json_cid = pin_json_to_ipfs_local(&json_string, api_url).await?;

    // 3. Construct FileInput
    let file_input = FileInputWrapper {
        file_hash: json_cid.as_bytes().to_vec(),
        file_name: file_name.as_bytes().to_vec(),
    };

    // 4. Call storage_request_tauri
    let result = crate::commands::substrate_tx::storage_request_tauri(
        vec![file_input],
        None,
    ).await?;

    Ok(result)
}

/// Unpins all user_profiles records with the given file name by calling storage_unpin_request_tauri
pub async fn unpin_user_file_by_name(file_name: &str) -> Result<(), String> {
    if let Some(pool) = DB_POOL.get() {
        // Fetch the main_req_hash for the file name
        let hashes: Vec<(String,)> = sqlx::query_as(
            "SELECT main_req_hash FROM user_profiles WHERE file_name = ?"
        )
        .bind(file_name)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("DB error (fetch): {e}"))?;

        if let Some((main_req_hash,)) = hashes.first() {
            // Wrap in FileHashWrapper
            let file_hash_wrapper = FileHashWrapper { file_hash: main_req_hash.as_bytes().to_vec() };
            // Call the unpin request
            let result = storage_unpin_request_tauri(file_hash_wrapper).await;
            match result {
                Ok(msg) => println!("[unpin_user_file_by_name] Unpin request result: {}", msg),
                Err(e) => println!("[unpin_user_file_by_name] Unpin request error: {}", e),
            }
        } else {
            println!("[unpin_user_file_by_name] No main_req_hash found for file '{}', nothing to unpin.", file_name);
        }
        Ok(())
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

/// Deletes all user_profiles records with the given file name and unpins the file.
/// Returns the number of deleted records or an error.
pub async fn delete_and_unpin_user_file_records_by_name(file_name: &str) -> Result<u64, String> {
    // Unpin first
    let unpin_result = unpin_user_file_by_name(file_name).await;
    if unpin_result.is_err() {
        return Err(format!("Unpin failed for '{}': {}", file_name, unpin_result.unwrap_err()));
    }
    if let Some(pool) = DB_POOL.get() {
        // Now, delete the records
        let result = sqlx::query(
            "DELETE FROM user_profiles WHERE file_name = ?"
        )
        .bind(file_name)
        .execute(pool)
        .await
        .map_err(|e| format!("DB error (delete): {e}"))?;

        println!("[delete_user_file_records_by_name] Deleted {} records for file '{}'", result.rows_affected(), file_name);

        Ok(result.rows_affected())
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}