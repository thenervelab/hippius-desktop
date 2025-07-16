use crate::commands::substrate_tx::storage_unpin_request_tauri;
use crate::commands::substrate_tx::FileHashWrapper;
use crate::commands::substrate_tx::FileInputWrapper;
use crate::utils::ipfs::pin_json_to_ipfs_local;
use crate::DB_POOL;
use std::fs;
use std::path::{Path, PathBuf};
use crate::constants::substrate::SYNC_PATH;
use crate::folder_sync::insert_file_if_not_exists;


pub async fn request_file_storage(
    file_name: &str,
    file_cid: &str,
    api_url: &str,
    seed_phrase: &str,
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
        seed_phrase.to_string(),
    )
    .await?;

    Ok(result)
}

/// Unpins all user_profiles records with the given file name by calling storage_unpin_request_tauri
pub async fn unpin_user_file_by_name(file_name: &str, seed_phrase: &str) -> Result<(), String> {
    if let Some(pool) = DB_POOL.get() {
        // Fetch the main_req_hash for the file name
        let hashes: Vec<(String,)> =
            sqlx::query_as("SELECT main_req_hash FROM user_profiles WHERE file_name = ?")
                .bind(file_name)
                .fetch_all(pool)
                .await
                .map_err(|e| format!("DB error (fetch): {e}"))?;

        if let Some((main_req_hash,)) = hashes.first() {
            // Wrap in FileHashWrapper
            let file_hash_wrapper = FileHashWrapper {
                file_hash: main_req_hash.as_bytes().to_vec(),
            };
            // Call the unpin request
            let result =
                storage_unpin_request_tauri(file_hash_wrapper, seed_phrase.to_string()).await;
            match result {
                Ok(msg) => println!("{}", msg),
                Err(e) => println!("Unpin request error: {}", e),
            }
        } else {
            println!(
                "[unpin_user_file_by_name] No main_req_hash found for file '{}', nothing to unpin.",
                file_name
            );
        }
        Ok(())
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

/// Deletes all user_profiles records with the given file name and unpins the file.
/// Also deletes from sync_folder_files. Returns the total number of deleted records or an error.
pub async fn delete_and_unpin_user_file_records_by_name(
    file_name: &str,
    seed_phrase: &str,
) -> Result<u64, String> {
    // Unpin first
    let unpin_result = unpin_user_file_by_name(file_name, seed_phrase).await;
    if unpin_result.is_err() {
        return Err(format!(
            "Unpin failed for '{}': {}",
            file_name,
            unpin_result.unwrap_err()
        ));
    }
    if let Some(pool) = DB_POOL.get() {
        // Delete from user_profiles
        let result1 = sqlx::query("DELETE FROM user_profiles WHERE file_name = ?")
            .bind(file_name)
            .execute(pool)
            .await
            .map_err(|e| format!("DB error (delete user_profiles): {e}"))?;
        // Delete from sync_folder_files
        let result2 = sqlx::query("DELETE FROM sync_folder_files WHERE file_name = ?")
            .bind(file_name)
            .execute(pool)
            .await
            .map_err(|e| format!("DB error (delete sync_folder_files): {e}"))?;
        Ok(result1.rows_affected() + result2.rows_affected())
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

pub async fn copy_to_sync_and_add_to_db(original_path: &Path, account_id: &str) {
    // Define your sync folder path
    let sync_folder = PathBuf::from(SYNC_PATH); // Make sure SYNC_PATH is accessible here
    let file_name = match original_path.file_name() {
        Some(name) => name,
        None => return,
    };
    let sync_file_path = sync_folder.join(file_name);

    // Copy if not already exists
    if !sync_file_path.exists() {
        if let Err(e) = fs::copy(original_path, &sync_file_path) {
            eprintln!("Failed to copy file to sync folder: {}", e);
            return;
        }
    }

    // Add to DB (make sure insert_file_if_not_exists is async)
    if let Some(pool) = crate::DB_POOL.get() {
        insert_file_if_not_exists(pool, &sync_file_path, account_id).await;
    }
}