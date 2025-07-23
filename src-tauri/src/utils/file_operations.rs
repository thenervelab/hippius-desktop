use crate::commands::substrate_tx::storage_unpin_request_tauri;
use crate::commands::substrate_tx::FileHashWrapper;
use crate::commands::substrate_tx::FileInputWrapper;
use crate::utils::ipfs::pin_json_to_ipfs_local;
use crate::utils::sync::{get_private_sync_path, get_public_sync_path};
use crate::DB_POOL;
use std::fs;
use std::path::{Path, PathBuf};
use crate::folder_sync::collect_files_recursively;
use hex;
use crate::ipfs::get_ipfs_file_size;
use crate::sync_shared::{RECENTLY_UPLOADED, insert_file_if_not_exists};
use crate::sync_shared::RECENTLY_UPLOADED_FOLDERS;
use tokio::time::Duration;
use tokio::time::sleep;

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
    is_public: bool,
) -> Result<u64, String> {
    if let Some(pool) = DB_POOL.get() {
        // Call unpin_user_file_by_name after successful deletes
        unpin_user_file_by_name(file_name, seed_phrase)
            .await
            .map_err(|e| format!("Unpin failed for '{}': {}", file_name, e))?;

        // Delete from user_profiles
        let result1 = sqlx::query("DELETE FROM user_profiles WHERE file_name = ?")
            .bind(file_name)
            .execute(pool)
            .await
            .map_err(|e| format!("DB error (delete user_profiles): {e}"))?;

        // Delete from sync_folder_files (dynamic type)
        let result2 = sqlx::query("DELETE FROM sync_folder_files WHERE file_name = ? AND type = ?")
            .bind(file_name)
            .bind(if is_public { "public" } else { "private" })
            .execute(pool)
            .await
            .map_err(|e| format!("DB error (delete sync_folder_files): {e}"))?;

        // Remove from sync folder as well
        remove_file_from_sync_and_db(file_name, is_public, false).await;

        // Calculate total rows affected
        let total_deleted = result1.rows_affected() + result2.rows_affected();

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
    // Check sync_folder_files for the file's type
    let mut is_public = false;
    if let Some(pool) = DB_POOL.get() {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT type FROM sync_folder_files WHERE file_name = ? LIMIT 1"
        )
        .bind(&file_name)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);
        if let Some((file_type,)) = row {
            if file_type == "public" {
                is_public = true;
            }
        }
    }
    delete_and_unpin_user_file_records_by_name(&file_name, &seed_phrase, is_public).await
}

// Helper function for recursive directory copy
fn copy_dir(src: &Path, dst: &Path) {
    if let Ok(entries) = std::fs::read_dir(src) {
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = match path.file_name() {
                Some(name) => name,
                None => continue,
            };
            let dest_path = dst.join(file_name);
            if path.is_dir() {
                if let Err(e) = std::fs::create_dir_all(&dest_path) {
                    eprintln!("Failed to create subfolder: {}", e);
                    continue;
                }
                copy_dir(&path, &dest_path);
            } else if path.is_file() {
                if let Err(e) = std::fs::copy(&path, &dest_path) {
                    eprintln!("Failed to copy file to sync folder: {}", e);
                }
            }
        }
    }
}

pub async fn copy_to_sync_and_add_to_db(original_path: &Path, account_id: &str, metadata_cid: &str, request_cid: &str, is_public: bool, is_folder: bool) {    
    // Choose sync folder path based on is_public
    let sync_folder = if is_public {
        PathBuf::from(get_public_sync_path().await)
    } else {
        PathBuf::from(get_private_sync_path().await)
    };
    
    let file_name = original_path.file_name().unwrap().to_string_lossy().to_string();
    let dest_path = sync_folder.join(&file_name);
    
    // Track this file/folder and its contents (if folder) before copying
    let mut files_in_folder = Vec::new();
    if is_folder {
        let mut recently_uploaded_folders = RECENTLY_UPLOADED_FOLDERS.lock().unwrap();
        recently_uploaded_folders.insert(dest_path.to_string_lossy().to_string());
        
        // Collect all files in the folder and add to RECENTLY_UPLOADED
        collect_files_recursively(&original_path, &mut files_in_folder);
        let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
        for file_path in &files_in_folder {
            let file_path_str = sync_folder.join(file_path.strip_prefix(original_path).unwrap()).to_string_lossy().to_string();
            recently_uploaded.insert(file_path_str.clone());
            println!("[CopyToSync] Added file to recently uploaded: {}", file_path_str);
        }
    } else {
        let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
        recently_uploaded.insert(dest_path.to_string_lossy().to_string());
    }
    
    // Remove after 2 seconds
    let dest_path_str = dest_path.to_string_lossy().to_string();
    let files_to_remove = files_in_folder.iter()
        .map(|file_path| sync_folder.join(file_path.strip_prefix(original_path).unwrap()).to_string_lossy().to_string())
        .collect::<Vec<String>>();
    tokio::spawn(async move {
        sleep(Duration::from_secs(30)).await;
        if is_folder {
            let mut recently_uploaded_folders = RECENTLY_UPLOADED_FOLDERS.lock().unwrap();
            recently_uploaded_folders.remove(&dest_path_str);
            println!("[CopyToSync] Removed folder from recently uploaded: {}", dest_path_str);
            
            let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
            for file_path_str in files_to_remove {
                recently_uploaded.remove(&file_path_str);
                println!("[CopyToSync] Removed file from recently uploaded: {}", file_path_str);
            }
        } else {
            let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
            recently_uploaded.remove(&dest_path_str);
            println!("[CopyToSync] Removed file from recently uploaded: {}", dest_path_str);
        }
    });
    
    // Rest of existing copy logic...
    let cid_vec = metadata_cid.as_bytes().to_vec();
    let file_hash = hex::encode(cid_vec);

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
                ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '', 5, 0, 0, '', ?, 0)"
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

    // Add to sync_folder_files DB
    if let Some(pool) = crate::DB_POOL.get() {
        insert_file_if_not_exists(pool, &dest_path, account_id, is_public, is_folder).await;
    }
    
    // Copy if not already exists
    if is_folder {
        // Recursively copy the folder and its contents
        if !dest_path.exists() {
            if let Err(e) = std::fs::create_dir_all(&dest_path) {
                eprintln!("Failed to create sync folder: {}", e);
                return;
            }
        }
        // Recursively copy all files and subfolders
        copy_dir(original_path, &dest_path);
    } else {
        if !dest_path.exists() {
            if let Err(e) = fs::copy(original_path, &dest_path) {
                eprintln!("Failed to copy file to sync folder: {}", e);
                return;
            }
        }
    }
}

pub async fn remove_file_from_sync_and_db(file_name: &str, is_public: bool, is_folder: bool) {
    use std::fs;
    use std::path::PathBuf;

    let sync_folder = if is_public {
        PathBuf::from(get_public_sync_path().await)
    } else {
        PathBuf::from(get_private_sync_path().await)
    };
    let sync_file_path = sync_folder.join(file_name);

    // If it's a folder, recursively delete all files inside from DB and filesystem
    if sync_file_path.is_dir() || is_folder {
        // Recursively collect all files inside the folder
        let mut files = Vec::new();
        crate::folder_sync::collect_files_recursively(&sync_file_path, &mut files);

        if let Some(pool) = crate::DB_POOL.get() {
            for file in &files {
                if let Some(file_name) = file.file_name().and_then(|s| s.to_str()) {
                    // Remove from DB
                    if let Err(e) = sqlx::query("DELETE FROM sync_folder_files WHERE file_name = ? AND type = ?")
                        .bind(file_name)
                        .bind(if is_public { "public" } else { "private" })
                        .execute(pool)
                        .await {
                        eprintln!("Failed to remove file '{}' from sync_folder_files DB: {}", file_name, e);
                    }
                }
                // Remove from filesystem
                if file.exists() {
                    if let Err(e) = fs::remove_file(file) {
                        eprintln!("Failed to remove file from sync folder: {}", e);
                    }
                }
            }
        }
        // Remove the folder record from DB
        if let Some(pool) = crate::DB_POOL.get() {
            if let Err(e) = sqlx::query("DELETE FROM sync_folder_files WHERE file_name = ? AND type = ?")
                .bind(file_name)
                .bind(if is_public { "public" } else { "private" })
                .execute(pool)
                .await {
                eprintln!("Failed to remove folder from sync_folder_files DB: {}", e);
            }
        }
        // Remove the folder from filesystem
    if sync_file_path.exists() {
            if let Err(e) = fs::remove_dir_all(&sync_file_path) {
                eprintln!("Failed to remove folder from sync folder: {}", e);
            }
            }
        } else {
        // It's a file
        if sync_file_path.exists() {
            if let Err(e) = fs::remove_file(&sync_file_path) {
                eprintln!("Failed to remove file from sync folder: {}", e);
        }
    }
    // Remove from DB
    if let Some(pool) = crate::DB_POOL.get() {
        if let Err(e) = sqlx::query("DELETE FROM sync_folder_files WHERE file_name = ? AND type = ?")
            .bind(file_name)
            .bind(if is_public { "public" } else { "private" })
            .execute(pool)
            .await {
            eprintln!("Failed to remove file from sync_folder_files DB: {}", e);
            }
        }
    }
}