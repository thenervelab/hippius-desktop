use crate::commands::substrate_tx::storage_unpin_request_tauri;
use crate::commands::substrate_tx::FileHashWrapper;
use crate::commands::substrate_tx::FileInputWrapper;
use crate::utils::ipfs::pin_json_to_ipfs_local;
use crate::utils::sync::get_private_sync_path;
use crate::DB_POOL;
use std::fs;
use std::path::{Path, PathBuf};
use crate::folder_sync::insert_file_if_not_exists;
use hex;
use crate::ipfs::get_ipfs_file_size;

pub async fn request_file_storage(
    file_name: &str,
    file_cid: &str,
    api_url: &str,
    seed_phrase: &str,
) -> Result<String, String> {
    println!("orignal file hash is :{}", file_cid);
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

    // 4. Call storage_request_tauri (still call it for side effects, but ignore its result)
    let _ = crate::commands::substrate_tx::storage_request_tauri(
        vec![file_input],
        None,
        seed_phrase.to_string(),
    )
    .await?;

    Ok(json_cid)
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
            // 1. Create the JSON
            let json = serde_json::json!([{
                "filename": file_name,
                "cid": main_req_hash
            }]);
            let json_string = serde_json::to_string(&json).unwrap();
            let api_url = "http://127.0.0.1:5001";
            // 2. Pin JSON to local IPFS node
            let json_cid = pin_json_to_ipfs_local(&json_string, api_url).await?;

            // Wrap in FileHashWrapper
            let file_hash_wrapper = FileHashWrapper {
                file_hash: json_cid.as_bytes().to_vec(),
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

        // Remove from sync folder as well
        // We don't have account_id here, so pass empty string or refactor if needed
        crate::utils::file_operations::remove_file_from_sync_and_db(file_name, "").await;

        // Calculate total rows affected
        let total_deleted = result1.rows_affected() + result2.rows_affected();

        // Call unpin_user_file_by_name after successful deletes
        unpin_user_file_by_name(file_name, seed_phrase)
            .await
            .map_err(|e| format!("Unpin failed for '{}': {}", file_name, e))?;

        Ok(total_deleted)
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

#[tauri::command]
pub async fn delete_and_unpin_file_by_name(
    file_name: String,
    seed_phrase: String,
) -> Result<u64, String> {
    delete_and_unpin_user_file_records_by_name(&file_name, &seed_phrase).await
}

pub async fn copy_to_sync_and_add_to_db(original_path: &Path, account_id: &str, metadata_cid: &str, request_cid: &str) {
    // Define your sync folder path
    let sync_folder = PathBuf::from(get_private_sync_path().await);
    let file_name = match original_path.file_name() {
        Some(name) => name.to_string_lossy().to_string(),
        None => return,
    };
    let sync_file_path = sync_folder.join(&file_name);
    let cid_vec = metadata_cid.as_bytes().to_vec();
    let file_hash = hex::encode(cid_vec); // This is a String

    // Get file size from IPFS
    let file_size_in_bytes = match get_ipfs_file_size(metadata_cid).await {
        Ok(size) => size as i64,
        Err(e) => {
            eprintln!("Failed to get IPFS file size for {}: {}", metadata_cid, e);
            0
        }
    };
    println!("copy sync folder file size in bytes is : {}", file_size_in_bytes);
    if let Some(pool) = crate::DB_POOL.get() {
        // Check if file already exists in user_profiles for this account
        let exists: Option<(String,)> = sqlx::query_as(
            "SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1"
        )
        .bind(account_id)
        .bind(&file_name)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);

        if exists.is_none() {
            // Insert minimal record into user_profiles with is_assigned = false and file_hash set
            let _ = sqlx::query(
                "INSERT INTO user_profiles (
                    owner, cid, file_hash, file_name, file_size_in_bytes, is_assigned, last_charged_at, main_req_hash, selected_validator, total_replicas, block_number, profile_cid, source, miner_ids, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '', '', 0, 0, '', ?, 0)"
            )
            .bind(account_id)
            .bind(request_cid) // cid
            .bind(&file_hash)
            .bind(&file_name)
            .bind(file_size_in_bytes)
            .bind(false)
            .bind(request_cid) // main_req_hash
            .bind(file_size_in_bytes)
            .execute(pool)
            .await;
        }
    }

    // Copy if not already exists
    if !sync_file_path.exists() {
        if let Err(e) = fs::copy(original_path, &sync_file_path) {
            eprintln!("Failed to copy file to sync folder: {}", e);
            return;
        }
    }

    // Add to sync_folder_files DB (make sure insert_file_if_not_exists is async)
    if let Some(pool) = crate::DB_POOL.get() {
        insert_file_if_not_exists(pool, &sync_file_path, account_id).await;
    }
}

pub async fn remove_file_from_sync_and_db(file_name: &str, account_id: &str) {
    use std::fs;
    // Remove from sync folder
    let sync_folder = PathBuf::from(get_private_sync_path().await);
    let sync_file_path = sync_folder.join(file_name);
    if sync_file_path.exists() {
        if let Err(e) = fs::remove_file(&sync_file_path) {
            eprintln!("Failed to remove file from sync folder: {}", e);
        }
    }
    // Remove from DB
    if let Some(pool) = crate::DB_POOL.get() {
        if let Err(e) = sqlx::query("DELETE FROM sync_folder_files WHERE file_name = ? AND owner = ?")
            .bind(file_name)
            .bind(account_id)
            .execute(pool)
            .await {
            eprintln!("Failed to remove file from sync_folder_files DB: {}", e);
        }
    }
}