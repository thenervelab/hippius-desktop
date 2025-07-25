use crate::commands::substrate_tx::storage_unpin_request_tauri;
use crate::commands::substrate_tx::FileHashWrapper;
use crate::commands::substrate_tx::FileInputWrapper;
use crate::utils::ipfs::pin_json_to_ipfs_local;
use crate::utils::sync::{get_private_sync_path, get_public_sync_path};
use crate::DB_POOL;
use std::fs;
use std::path::{Path, PathBuf};
use crate::sync_shared::collect_files_recursively;
use hex;
use crate::ipfs::get_ipfs_file_size;
use crate::sync_shared::{RECENTLY_UPLOADED, insert_file_if_not_exists};
use crate::sync_shared::RECENTLY_UPLOADED_FOLDERS;
use tokio::time::Duration;
use tokio::time::sleep;

// Helper to sanitize file/folder names for DB and filesystem operations
fn sanitize_file_name(name: &str) -> String {
    if name.ends_with(".folder.ec_metadata") {
        name.trim_end_matches(".folder.ec_metadata").to_string()
    } else if name.ends_with(".folder") {
        name.trim_end_matches(".folder").to_string()
    } else if name.ends_with(".ec_metadata") {
        name.trim_end_matches(".ec_metadata").to_string()
    } else {
        name.to_string()
    }
}

fn build_storage_json(files: &[(String, String)]) -> String {
    let json_vec: Vec<_> = files
        .iter()
        .map(|(filename, cid)| serde_json::json!({
            "filename": filename,
            "cid": cid,
        }))
        .collect();
    serde_json::to_string(&serde_json::Value::Array(json_vec)).unwrap()
}

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
            println!("main_req_hash for unpinning {:?}",main_req_hash);
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

        // Sanitize file_name for local sync usage
        let sanitized_file_name = sanitize_file_name(file_name);
        // Delete from user_profiles
        let result1 = sqlx::query("DELETE FROM user_profiles WHERE file_name = ?")
            .bind(file_name)
            .execute(pool)
            .await
            .map_err(|e| format!("DB error (delete user_profiles): {e}"))?;

        // Delete from sync_folder_files (dynamic type)
        let result2 = sqlx::query("DELETE FROM sync_folder_files WHERE file_name = ? AND type = ?")
            .bind(&sanitized_file_name)
            .bind(if is_public { "public" } else { "private" })
            .execute(pool)
            .await
            .map_err(|e| format!("DB error (delete sync_folder_files): {e}"))?;

        // Remove from sync folder as well
        remove_file_from_sync_and_db(&sanitized_file_name, is_public, false).await;

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

pub async fn copy_to_sync_and_add_to_db(original_path: &Path, account_id: &str, metadata_cid: &str, request_cid: &str, is_public: bool, is_folder: bool, requested_file_name: &str) {    
    // Choose sync folder path based on is_public
    let sync_folder = if is_public {
        match get_public_sync_path().await {
            Ok(path) => PathBuf::from(path),
            Err(e) => {
                eprintln!("Failed to get public sync path: {}", e);
                return;
            }
        }
    } else {
        match get_private_sync_path().await {
            Ok(path) => PathBuf::from(path),
            Err(e) => {
                eprintln!("Failed to get private sync path: {}", e);
                return;
            }
        }
    };
    
    let file_name = original_path.file_name().unwrap().to_string_lossy().to_string();
    let dest_path = sync_folder.join(&file_name);
    
    // Track this file/folder and its contents (if folder) before copying
    let mut files_in_folder = Vec::new();
    if is_folder {
        let mut recently_uploaded_folders = RECENTLY_UPLOADED_FOLDERS.lock().unwrap();
        recently_uploaded_folders.insert(dest_path.to_string_lossy().to_string());
        
        // Collect all files in the folder and add to RECENTLY_UPLOADED
        let _ = collect_files_recursively(&original_path, &mut files_in_folder);
        let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
        for file_path in &files_in_folder {
            let file_path_str = sync_folder.join(file_path.strip_prefix(original_path).unwrap()).to_string_lossy().to_string();
            recently_uploaded.insert(file_path_str.clone());
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
            let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
            for file_path_str in files_to_remove {
                recently_uploaded.remove(&file_path_str);
            }
        } else {
            let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
            recently_uploaded.remove(&dest_path_str);
        }
    });
    
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
    if let Some(pool) = crate::DB_POOL.get() {
        // Check if file already exists in user_profiles for this account
        let exists: Option<(String,)> = sqlx::query_as(
            "SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1"
        )
        .bind(account_id)
        .bind(&requested_file_name)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);
        println!("request_cid {:?}",request_cid);
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
            .bind(&requested_file_name)
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
        insert_file_if_not_exists(pool, &original_path, account_id, is_public, is_folder).await;
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

    // Choose sync folder path based on is_public
    let sync_folder = if is_public {
        match get_public_sync_path().await {
            Ok(path) => PathBuf::from(path),
            Err(e) => {
                eprintln!("Failed to get public sync path: {}", e);
                return;
            }
        }
    } else {
        match get_private_sync_path().await {
            Ok(path) => PathBuf::from(path),
            Err(e) => {
                eprintln!("Failed to get private sync path: {}", e);
                return;
            }
        }
    };
    let sync_file_path = sync_folder.join(file_name);

    // If it's a folder, recursively delete all files inside from DB and filesystem
    if sync_file_path.is_dir() || is_folder {
        // Recursively collect all files inside the folder
        let mut files = Vec::new();
        let _ = collect_files_recursively(&sync_file_path, &mut files);

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

pub async fn request_erasure_storage(
    file_name: &str,
    files: &[(String, String)],
    api_url: &str,
    seed_phrase: &str,
) -> Result<String, String> {
    println!("[request_erasure_storage] files: {:?}", files);
    if files.is_empty() {
        return Err("files array cannot be empty".to_string());
    }

    let json_string = build_storage_json(files);
    println!("[request_erasure_storage] JSON CID requesting is : {}", json_string);
    // 2. Pin JSON to local IPFS node
    let json_cid = pin_json_to_ipfs_local(&json_string, api_url).await?;
    println!("[request_erasure_storage] JSON CID requesting is : {}", json_cid);
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

pub async fn request_folder_storage(
    file_name: &str,
    files: &[(String, String)],
    api_url: &str,
    seed_phrase: &str,
) -> Result<String, String> {
    println!("[request_folder_storage] files: {:?}", files);
    if files.is_empty() {
        return Err("files array cannot be empty".to_string());
    }

    let json_string = build_storage_json(files);
    println!("[request_folder_storage] JSON CID requesting is : {}", json_string);
    // 2. Pin JSON to local IPFS node
    let json_cid = pin_json_to_ipfs_local(&json_string, api_url).await?;
    println!("[request_folder_storage] JSON CID requesting is : {}", json_cid);
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

pub async fn copy_to_sync_folder(original_path: &Path, folder_name: &str, account_id: &str, metadata_cid: &str, request_cid: &str, is_public: bool, is_folder: bool, requested_file_name: &str) {
    // Choose sync folder path based on is_public
    let sync_folder = if is_public {
        match get_public_sync_path().await {
            Ok(path) => PathBuf::from(path),
            Err(e) => {
                eprintln!("Failed to get public sync path: {}", e);
                return;
            }
        }
    } else {
        match get_private_sync_path().await {
            Ok(path) => PathBuf::from(path),
            Err(e) => {
                eprintln!("Failed to get private sync path: {}", e);
                return;
            }
        }
    };
    
    // Create the target folder path inside sync directory
    let target_folder = sync_folder.join(folder_name);
    
    // Ensure the target folder exists
    if !target_folder.exists() {
        if let Err(e) = std::fs::create_dir_all(&target_folder) {
            eprintln!("Failed to create target folder '{}': {}", folder_name, e);
            return;
        }
    }
    
    let file_name = original_path.file_name().unwrap().to_string_lossy().to_string();
    let dest_path = target_folder.join(&file_name);
    
    // Track this file/folder and its contents (if folder) before copying
    let mut files_in_folder = Vec::new();
    if is_folder {
        let mut recently_uploaded_folders = RECENTLY_UPLOADED_FOLDERS.lock().unwrap();
        recently_uploaded_folders.insert(dest_path.to_string_lossy().to_string());
        
        // Collect all files in the folder and add to RECENTLY_UPLOADED
        let _ = collect_files_recursively(&original_path, &mut files_in_folder);
        let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
        for file_path in &files_in_folder {
            let file_path_str = target_folder.join(file_path.strip_prefix(original_path).unwrap()).to_string_lossy().to_string();
            recently_uploaded.insert(file_path_str.clone());
        }
    } else {
        let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
        recently_uploaded.insert(dest_path.to_string_lossy().to_string());
    }
    
    // Remove after 30 seconds
    let dest_path_str = dest_path.to_string_lossy().to_string();
    let files_to_remove = files_in_folder.iter()
        .map(|file_path| target_folder.join(file_path.strip_prefix(original_path).unwrap()).to_string_lossy().to_string())
        .collect::<Vec<String>>();
    tokio::spawn(async move {
        sleep(Duration::from_secs(30)).await;
        if is_folder {
            let mut recently_uploaded_folders = RECENTLY_UPLOADED_FOLDERS.lock().unwrap();
            recently_uploaded_folders.remove(&dest_path_str);
            let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
            for file_path_str in files_to_remove {
                recently_uploaded.remove(&file_path_str);
            }
        } else {
            let mut recently_uploaded = RECENTLY_UPLOADED.lock().unwrap();
            recently_uploaded.remove(&dest_path_str);
        }
    });
    
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
    
    if let Some(pool) = crate::DB_POOL.get() {
        // Check if file already exists in user_profiles for this account
        let exists: Option<(String,)> = sqlx::query_as(
            "SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1"
        )
        .bind(account_id)
        .bind(&requested_file_name)
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
            .bind(&requested_file_name)
            .bind(file_size_in_bytes)
            .bind(false)
            .bind(request_cid) // main_req_hash
            .bind(file_size_in_bytes)
            .execute(pool)
            .await;
        }
    }

    // Add to sync_folder_files DB with folder path
    if let Some(pool) = crate::DB_POOL.get() {
        let folder_relative_path = PathBuf::from(folder_name).join(&file_name);
        insert_file_if_not_exists_in_folder(pool, &folder_relative_path, account_id, is_public, is_folder).await;
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

pub async fn remove_from_sync_folder(file_name: &str, folder_name: &str, is_public: bool, is_folder: bool) {
    use std::fs;
    use std::path::PathBuf;

    // Choose sync folder path based on is_public
    let sync_folder = if is_public {
        match get_public_sync_path().await {
            Ok(path) => PathBuf::from(path),
            Err(e) => {
                eprintln!("Failed to get public sync path: {}", e);
                return;
            }
        }
    } else {
        match get_private_sync_path().await {
            Ok(path) => PathBuf::from(path),
            Err(e) => {
                eprintln!("Failed to get private sync path: {}", e);
                return;
            }
        }
    };
    
    let target_folder = sync_folder.join(folder_name);
    let sync_file_path = target_folder.join(file_name);

    // If it's a folder, recursively delete all files inside from DB and filesystem
    if sync_file_path.is_dir() || is_folder {
        // Recursively collect all files inside the folder
        let mut files = Vec::new();
        let _ = collect_files_recursively(&sync_file_path, &mut files);

        if let Some(pool) = crate::DB_POOL.get() {
            for file in &files {
                if let Some(file_name_inner) = file.file_name().and_then(|s| s.to_str()) {
                    // Get relative path from sync folder for DB deletion
                    let relative_path = file.strip_prefix(&sync_folder).unwrap_or(file);
                    let relative_path_str = relative_path.to_string_lossy();
                    
                    // Remove from DB
                    if let Err(e) = sqlx::query("DELETE FROM sync_folder_files WHERE file_name = ? AND type = ?")
                        .bind(&relative_path_str)
                        .bind(if is_public { "public" } else { "private" })
                        .execute(pool)
                        .await {
                        eprintln!("Failed to remove file '{}' from sync_folder_files DB: {}", relative_path_str, e);
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
            let folder_relative_path = PathBuf::from(folder_name).join(file_name);
            let folder_relative_path_str = folder_relative_path.to_string_lossy();
            
            if let Err(e) = sqlx::query("DELETE FROM sync_folder_files WHERE file_name = ? AND type = ?")
                .bind(&folder_relative_path_str)
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
            let file_relative_path = PathBuf::from(folder_name).join(file_name);
            let file_relative_path_str = file_relative_path.to_string_lossy();
            
            if let Err(e) = sqlx::query("DELETE FROM sync_folder_files WHERE file_name = ? AND type = ?")
                .bind(&file_relative_path_str)
                .bind(if is_public { "public" } else { "private" })
                .execute(pool)
                .await {
                eprintln!("Failed to remove file from sync_folder_files DB: {}", e);
            }
        }
    }
}

// Helper function for inserting files with folder paths
async fn insert_file_if_not_exists_in_folder(pool: &sqlx::Pool<sqlx::Sqlite>, file_path: &Path, account_id: &str, is_public: bool, is_folder: bool) {
    let file_name = file_path.to_string_lossy().to_string();
    let file_type = if is_public { "public" } else { "private" };
    let entry_type = if is_folder { "folder" } else { "file" };

    // Check if the file already exists in the database
    let exists: Option<(String,)> = sqlx::query_as(
        "SELECT file_name FROM sync_folder_files WHERE file_name = ? AND type = ? AND owner = ? LIMIT 1"
    )
    .bind(&file_name)
    .bind(file_type)
    .bind(account_id)
    .fetch_optional(pool)
    .await
    .unwrap_or(None);

    if exists.is_none() {
        // Insert the file record
        let _ = sqlx::query(
            "INSERT INTO sync_folder_files (file_name, type, owner, entry_type, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .bind(&file_name)
        .bind(file_type)
        .bind(account_id)
        .bind(entry_type)
        .bind(chrono::Utc::now().timestamp())
        .execute(pool)
        .await;
    }
}

/// Deletes all user_profiles records with the given file name and unpins the file.
/// Also deletes from sync_folder_files. Returns the total number of deleted records or an error.
pub async fn delete_and_unpin_user_file_records_from_folder(
    folder_name: &str,
    seed_phrase: &str,
) -> Result<u64, String> {
    if let Some(pool) = DB_POOL.get() {
        // Call unpin_user_file_by_name after successful deletes
        unpin_user_file_by_name(folder_name, seed_phrase)
            .await
            .map_err(|e| format!("Unpin failed for '{}': {}", folder_name, e))?;

        // Delete from user_profiles
        let result1 = sqlx::query("DELETE FROM user_profiles WHERE file_name = ?")
            .bind(folder_name)
            .execute(pool)
            .await
            .map_err(|e| format!("DB error (delete user_profiles): {e}"))?;

        // Calculate total rows affected
        let total_deleted = result1.rows_affected();

        Ok(total_deleted)
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}