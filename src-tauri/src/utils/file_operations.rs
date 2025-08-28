use crate::commands::substrate_tx::{storage_unpin_request_tauri, FileHashWrapper, FileInputWrapper};
use crate::utils::ipfs::pin_json_to_ipfs_local;
use crate::utils::sync::{get_private_sync_path, get_public_sync_path};
use crate::DB_POOL;
use std::fs;
use std::path::{Path, PathBuf};
use crate::sync_shared::collect_files_recursively;
use hex;

use crate::sync_shared::insert_file_if_not_exists;
use std::sync::{Arc, Mutex};
use once_cell::sync::Lazy;
use tokio::time::{Duration, sleep};

// Helper to sanitize file/folder names for DB and filesystem operations
pub fn sanitize_name(name: &str) -> String {
    if name.ends_with(".s.folder.ec_metadata") {
        name.trim_end_matches(".s.folder.ec_metadata").to_string()
    } else if name.ends_with("-folder.ec_metadata") {
        name.trim_end_matches("-folder.ec_metadata").to_string()
    } else if name.ends_with(".folder.ec_metadata") {
        name.trim_end_matches(".folder.ec_metadata").to_string()
    } else if name.ends_with(".ff.ec_metadata") {
        name.trim_end_matches(".ff.ec_metadata").to_string()
    } else if name.ends_with(".s.folder") {
        name.trim_end_matches(".s.folder").to_string()
    } else if name.ends_with(".ec_metadata") {
        name.trim_end_matches(".ec_metadata").to_string()
    } else if name.ends_with(".ff") {
        name.trim_end_matches(".ff").to_string()
    } else if name.ends_with(".ec") {
        name.trim_end_matches(".ec").to_string()
    } else if name.ends_with("-folder") {
        name.trim_end_matches("-folder").to_string()
    } else if name.ends_with(".folder") {
        name.trim_end_matches(".folder").to_string()
    } else {
        name.to_string()
    }
}

// Helper to generate all possible file name variations
pub fn get_file_name_variations(base_name: &str) -> Vec<String> {
    let variations = vec![
        base_name.to_string(),
        format!("{}.ec_metadata", base_name),
        format!("{}.ff", base_name),
        format!("{}.ff.ec_metadata", base_name),
        format!("{}.ec", base_name),
        format!("{}-folder", base_name),
        format!("{}-folder.ec_metadata", base_name),
        format!("{}.folder.ec_metadata", base_name),
        format!("{}.folder", base_name),
    ];
    
    // Deduplicate while preserving order
    let mut seen = std::collections::HashSet::new();
    variations.into_iter().filter(|v| seen.insert(v.clone())).collect()
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

    // 4. Call storage_request_tauri
    crate::commands::substrate_tx::storage_request_tauri(
        vec![file_input],
        None,
        seed_phrase.to_string(),
    )
    .await?;

    Ok(json_cid)
}

pub async fn unpin_user_file_by_name(file_name: &str, seed_phrase: &str) -> Result<(), String> {
    if let Some(pool) = DB_POOL.get() {
        let variations = get_file_name_variations(file_name);
        let mut last_error = None;

        for variant in variations {
            let hashes_result = sqlx::query_as::<_, (String,)>(
                "SELECT file_hash FROM user_profiles WHERE file_name = ?"
            )
            .bind(&variant)
            .fetch_all(pool)
            .await;

            match hashes_result {
                Ok(hashes) if !hashes.is_empty() => {
                    if let Some((file_hash,)) = hashes.first() {                        
                        let file_hash_wrapper = FileHashWrapper {
                            file_hash: file_hash.as_bytes().to_vec(),
                        };
                        
                        return storage_unpin_request_tauri(file_hash_wrapper, seed_phrase.to_string(), variant.clone())
                            .await
                            .map(|_| ())
                            .map_err(|e| format!("Unpin request error for variant '{}': {}", variant, e));
                        
                        let result1 = sqlx::query("DELETE FROM user_profiles WHERE file_name = ?")
                            .bind(variant)
                            .execute(pool)
                            .await
                            .map_err(|e| format!("DB error (delete user_profiles): {e}"))?;

                        // Also delete from file_paths table
                        let _ = sqlx::query("DELETE FROM file_paths WHERE file_name = ?")
                            .bind(variant)
                            .execute(pool)
                            .await;
                    }
                    return Err("Found empty hash result despite non-empty hashes".to_string());
                },
                Ok(_) => {
                },
                Err(e) => {
                    last_error = Some(format!("DB error for variant '{}': {}", variant, e));
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            format!("No matching file found for '{}' or any of its variants", file_name)
        }))
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

pub async fn delete_and_unpin_user_file_records_by_name(
    file_name: &str,
    seed_phrase: &str,
    is_public: bool,
    should_delete_folder: bool,
) -> Result<u64, String> {
    if let Some(pool) = DB_POOL.get() {
        if let Err(e) = unpin_user_file_by_name(file_name, seed_phrase).await {
            println!(
                "[DB Cleanup] Warning: could not unpin '{}': {}. Proceeding with DB record deletion.",
                file_name, e
            );
        }

        let sanitized_file_name = sanitize_name(file_name);

        let is_folder = sqlx::query_scalar::<_, bool>(
            "SELECT is_folder FROM user_profiles WHERE file_name = ? LIMIT 1",
        )
        .bind(file_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error (fetch is_folder): {e}"))?
        .unwrap_or(false);

        let result = sqlx::query("DELETE FROM sync_folder_files WHERE file_name = ? AND type = ?")
            .bind(&sanitized_file_name)
            .bind(if is_public { "public" } else { "private" })
            .execute(pool)
            .await
            .map_err(|e| format!("DB error (delete sync_folder_files): {e}"))?;

        

        // Remove from sync folder
        remove_file_from_sync_and_db(&sanitized_file_name, is_public, is_folder, should_delete_folder).await;

        let total_deleted = result.rows_affected();
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
    delete_and_unpin_user_file_records_by_name(&file_name, &seed_phrase, is_public, true).await
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

pub async fn copy_to_sync_and_add_to_db(
    original_path: &Path,
    account_id: &str,
    metadata_cid: &str,
    request_cid: &str,
    is_public: bool,
    is_folder: bool,
    requested_file_name: &str,
    should_copy_folder: bool,
) {
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

    let file_name = original_path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let dest_path = sync_folder.join(&file_name);
    let dest_path_str = dest_path.to_string_lossy().to_string();
    let dest_path_str_clone = dest_path_str.clone();

    let cid_vec = metadata_cid.as_bytes().to_vec();
    let file_hash = hex::encode(cid_vec);

    // Calculate file/folder size locally
    let file_size_in_bytes = match calculate_local_size(original_path) {
        Ok(size) => size as i64,
        Err(e) => {
            eprintln!("Failed to calculate local size for {}: {}", original_path.display(), e);
            0
        }
    };
    println!("File size in bytes: {}", file_size_in_bytes);
    if let Some(pool) = DB_POOL.get() {
        // Check if file already exists in user_profiles
        let exists: Option<(String,)> = sqlx::query_as(
            "SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1"
        )
        .bind(account_id)
        .bind(&requested_file_name)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);

        if exists.is_none() {
            println!("inserted main_request_hash {:?}", request_cid);
            let mut source = "Hippius".to_string();
            let sanitize_name = sanitize_name(&dest_path_str_clone);
            source = dest_path_str_clone.clone();
            let _ = sqlx::query(
                "INSERT INTO user_profiles (
                    owner, cid, file_hash, file_name, file_size_in_bytes, is_assigned, last_charged_at, 
                    main_req_hash, selected_validator, total_replicas, block_number, processed_timestamp, profile_cid, 
                    source, miner_ids, created_at, type, is_folder
                ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '', 5, 0, CURRENT_TIMESTAMP, '', ?, '[]', strftime('%s', 'now'), ?, ?)"
            )
            .bind(account_id)
            .bind(metadata_cid)
            .bind(&file_hash)
            .bind(&requested_file_name)
            .bind(file_size_in_bytes)
            .bind(false)
            .bind("s3")  // main_req_hash
            .bind(source)   // source
            .bind(if is_public { "public" } else { "private" })  // type
            .bind(is_folder)
            .execute(pool)
            .await;

            // Also insert into file_paths table
            let _ = sqlx::query(
                "INSERT INTO file_paths (file_name, file_hash, timestamp, path) VALUES (?, ?, ?, ?)"
            )
            .bind(&requested_file_name)
            .bind(&file_hash)
            .bind(chrono::Utc::now().timestamp())
            .bind(&dest_path_str_clone)
            .execute(pool)
            .await;
        }

        // Add to sync_folder_files
        insert_file_if_not_exists(pool, &original_path, account_id, is_public, is_folder).await;
    }

    // Only copy files if should_copy_folder is true
    if should_copy_folder {
        if is_folder {
            if !dest_path.exists() {
                if let Err(e) = std::fs::create_dir_all(&dest_path) {
                    eprintln!("Failed to create sync folder: {}", e);
                    return;
                }
            }
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

}

// Helper function to calculate size of a file or directory
pub fn calculate_local_size(path: &Path) -> std::io::Result<u64> {
    if path.is_file() {
        return std::fs::metadata(path).map(|m| m.len());
    }

    let mut total_size = 0;
    if path.is_dir() {
        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                total_size += calculate_local_size(&path)?;
            } else {
                total_size += path.metadata()?.len();
            }
        }
    }
    Ok(total_size)
}

pub async fn remove_file_from_sync_and_db(file_name: &str, is_public: bool, is_folder: bool, should_delete_folder: bool) {
    // Choose sync folder path
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
    
    // --- Add paths to RECENTLY_DELETED before deletion ---
    let mut paths_to_delete = Vec::new();
    if sync_file_path.is_dir() || is_folder {
        paths_to_delete.push(sync_file_path.to_string_lossy().to_string());
        let mut files_in_folder = Vec::new();
        let _ = collect_files_recursively(&sync_file_path, &mut files_in_folder);
        for file in files_in_folder {
            paths_to_delete.push(file.to_string_lossy().to_string());
        }
    } else {
        paths_to_delete.push(sync_file_path.to_string_lossy().to_string());
    }


    // Handle folder deletion
    if sync_file_path.is_dir() || is_folder {
        let mut files = Vec::new();
        let _ = collect_files_recursively(&sync_file_path, &mut files);

        if let Some(pool) = DB_POOL.get() {
            for file in &files {
                if let Some(file_name_inner) = file.file_name().and_then(|s| s.to_str()) {
                    let relative_path = file.strip_prefix(&sync_folder).unwrap_or(file);
                    let relative_path_str = relative_path.to_string_lossy().to_string();
                    if let Err(e) = sqlx::query(
                        "DELETE FROM sync_folder_files WHERE file_name = ? AND type = ?"
                    )
                    .bind(&relative_path_str)
                    .bind(if is_public { "public" } else { "private" })
                    .execute(pool)
                    .await
                    {
                        eprintln!(
                            "Failed to remove file '{}' from sync_folder_files DB: {}",
                            relative_path_str, e
                        );
                    }
                }
                if should_delete_folder && file.exists() {
                    if let Err(e) = fs::remove_file(file) {
                        eprintln!("Failed to remove file from sync folder: {}", e);
                    }
                }
            }

            // Remove the folder record
            if let Err(e) = sqlx::query(
                "DELETE FROM sync_folder_files WHERE file_name = ? AND type = ?"
            )
            .bind(file_name)
            .bind(if is_public { "public" } else { "private" })
            .execute(pool)
            .await
            {
                eprintln!("Failed to remove folder from sync_folder_files DB: {}", e);
            }
        }

        if should_delete_folder && sync_file_path.exists() {
            if let Err(e) = fs::remove_dir_all(&sync_file_path) {
                eprintln!("Failed to remove folder from sync folder: {}", e);
            }
        }
    } else if should_delete_folder && sync_file_path.exists() {
        if let Err(e) = fs::remove_file(&sync_file_path) {
            eprintln!("Failed to remove file from sync folder: {}", e);
        }

        if let Some(pool) = DB_POOL.get() {
            if let Err(e) = sqlx::query(
                "DELETE FROM sync_folder_files WHERE file_name = ? AND type = ?"
            )
            .bind(file_name)
            .bind(if is_public { "public" } else { "private" })
            .execute(pool)
            .await
            {
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
    if files.is_empty() {
        return Err("files array cannot be empty".to_string());
    }

    let json_string = build_storage_json(files);

    let json_cid = pin_json_to_ipfs_local(&json_string, api_url).await?;

    let file_input = FileInputWrapper {
        file_hash: json_cid.as_bytes().to_vec(),
        file_name: file_name.as_bytes().to_vec(),
    };

    crate::commands::substrate_tx::storage_request_tauri(
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
    if files.is_empty() {
        return Err("files array cannot be empty".to_string());
    }

    let json_string = build_storage_json(files);

    let json_cid = pin_json_to_ipfs_local(&json_string, api_url).await?;

    let file_input = FileInputWrapper {
        file_hash: json_cid.as_bytes().to_vec(),
        file_name: file_name.as_bytes().to_vec(),
    };

    crate::commands::substrate_tx::storage_request_tauri(
        vec![file_input],
        None,
        seed_phrase.to_string(),
    )
    .await?;

    Ok(json_cid)
}

pub async fn copy_to_sync_folder(
    original_path: &Path,
    folder_name: &str,
    account_id: &str,
    metadata_cid: &str,
    request_cid: &str,
    is_public: bool,
    is_folder: bool,
    meta_folder_name: &str,
    subfolder_path: Option<String>,
) {
    // Choose sync folder path
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

    let target_folder = sync_folder.join(subfolder_path.unwrap_or_else(|| folder_name.to_string()));
    if !target_folder.exists() {
        if let Err(e) = std::fs::create_dir_all(&target_folder) {
            eprintln!("Failed to create target folder '{}': {}", target_folder.display(), e);
            return;
        }
    }

    let file_name = original_path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();
        let dest_path = target_folder.join(&file_name);

        // --- Track this file/folder to prevent redundant watcher events ---
        let dest_path_str = dest_path.to_string_lossy().to_string();
        let mut files_to_track = Vec::new();
    
        if is_folder {
            // If it's a folder, we also need to track all the files inside it.
            let mut files_in_folder = Vec::new();
            if collect_files_recursively(original_path, &mut files_in_folder).is_ok() {
                for file_path in &files_in_folder {
                    if let Ok(relative_path) = file_path.strip_prefix(original_path) {
                        let target_path = target_folder.join(relative_path);
                        files_to_track.push(target_path.to_string_lossy().to_string());
                    }
                }
            }
        } else {
            files_to_track.push(dest_path_str.clone());
        }
    
    let cid_vec = metadata_cid.as_bytes().to_vec();
    let file_hash = hex::encode(cid_vec);

    // Calculate file/folder size locally
    let file_size_in_bytes = match calculate_local_size(original_path) {
        Ok(size) => size as i64,
        Err(e) => {
            eprintln!("Failed to calculate local size for {}: {}", original_path.display(), e);
            0
        }
    };
    println!("File size in bytes: {}", file_size_in_bytes);
    if let Some(pool) = DB_POOL.get() {
        // Check if folder record already exists
        let exists: Option<(String,)> = sqlx::query_as(
            "SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1"
        )
        .bind(account_id)
        .bind(folder_name)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);

        if let Some(_) = exists {
            // Update existing record
            let _ = sqlx::query(
                "UPDATE user_profiles SET 
                    cid = ?, 
                    file_hash = ?, 
                    file_size_in_bytes = ?, 
                    main_req_hash = ?,
                    type = ?,
                    is_folder = ?,
                    processed_timestamp = CURRENT_TIMESTAMP
                WHERE owner = ? AND file_name = ?"
            )
            .bind(metadata_cid)
            .bind(&file_hash)
            .bind(file_size_in_bytes)
            .bind("s3")
            .bind(if is_public { "public" } else { "private" })
            .bind(true)
            .bind(account_id)
            .bind(meta_folder_name)
            .execute(pool)
            .await;
        } else {
            let source = target_folder.to_string_lossy().to_string();
            // Insert new record
            let _ = sqlx::query(
                "INSERT INTO user_profiles (
                    owner, cid, file_hash, file_name, file_size_in_bytes, is_assigned, last_charged_at, 
                    main_req_hash, selected_validator, total_replicas, block_number, processed_timestamp, profile_cid, 
                    source, miner_ids, created_at, type, is_folder
                ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '', 5, 0, CURRENT_TIMESTAMP, '', ?, '[]', strftime('%s', 'now'), ?, ?)"
            )
            .bind(account_id)
            .bind(metadata_cid)
            .bind(&file_hash)
            .bind(meta_folder_name)
            .bind(file_size_in_bytes)
            .bind(false)
            .bind("s3")
            .bind(source)
            .bind(if is_public { "public" } else { "private" })
            .bind(true)
            .execute(pool)
            .await;
        }

        let folder_relative_path = PathBuf::from(folder_name).join(&file_name);
        insert_file_if_not_exists(pool, &folder_relative_path, account_id, is_public, is_folder).await;
    }
    if is_folder {
        if !dest_path.exists() {
            if let Err(e) = std::fs::create_dir_all(&dest_path) {
                eprintln!("Failed to create sync folder: {}", e);
                return;
            }
        }
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

pub async fn remove_from_sync_folder(
    file_name: &str,
    folder_name: &str,
    is_public: bool,
    is_folder: bool,
    meta_folder_name: &str,
    folder_manifest_cid: &str,
    account_id: &str,
    requested_cid: &str,
    subfolder_path: Option<String>,
) {
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

    let target_folder = if let Some(ref subpath) = subfolder_path {
        sync_folder.join(subpath)
    } else {
        sync_folder.join(folder_name)
    };
    let sync_file_path = target_folder.join(file_name);

    // --- Add paths to RECENTLY_DELETED before deletion ---
    let mut paths_to_delete = Vec::new();
    if sync_file_path.is_dir() || is_folder {
        paths_to_delete.push(sync_file_path.to_string_lossy().to_string());
        let mut files_in_folder = Vec::new();
        let _ = collect_files_recursively(&sync_file_path, &mut files_in_folder);
        for file in files_in_folder {
            paths_to_delete.push(file.to_string_lossy().to_string());
        }
    } else {
        paths_to_delete.push(sync_file_path.to_string_lossy().to_string());
    }

    if sync_file_path.is_dir() || is_folder {
        let mut files = Vec::new();
        let _ = collect_files_recursively(&sync_file_path, &mut files);

        if let Some(pool) = DB_POOL.get() {
            for file in &files {
                if let Some(file_name_inner) = file.file_name().and_then(|s| s.to_str()) {
                    let relative_path = file.strip_prefix(&sync_folder).unwrap_or(file);
                    let relative_path_str = relative_path.to_string_lossy().to_string();
                    if let Err(e) = sqlx::query(
                        "DELETE FROM sync_folder_files WHERE file_name = ? AND type = ?"
                    )
                    .bind(&relative_path_str)
                    .bind(if is_public { "public" } else { "private" })
                    .execute(pool)
                    .await
                    {
                        eprintln!(
                            "Failed to remove file '{}' from sync_folder_files DB: {}",
                            relative_path_str, e
                        );
                    }
                }
                if file.exists() {
                    if let Err(e) = fs::remove_file(file) {
                        eprintln!("Failed to remove file from sync folder: {}", e);
                    }
                }
            }

            let folder_relative_path = PathBuf::from(folder_name).join(file_name);
            let folder_relative_path_str = folder_relative_path.to_string_lossy().to_string();
            if let Err(e) = sqlx::query(
                "DELETE FROM sync_folder_files WHERE file_name = ? AND type = ?"
            )
            .bind(&folder_relative_path_str)
            .bind(if is_public { "public" } else { "private" })
            .execute(pool)
            .await
            {
                eprintln!("Failed to remove folder from sync_folder_files DB: {}", e);
            }
        }

        if sync_file_path.exists() {
            if let Err(e) = fs::remove_dir_all(&sync_file_path) {
                eprintln!("Failed to remove folder from sync folder: {}", e);
            }
        }
    } else if sync_file_path.exists() {
        if let Err(e) = fs::remove_file(&sync_file_path) {
            eprintln!("Failed to remove file from sync folder: {}", e);
        }

        if let Some(pool) = DB_POOL.get() {
            let file_relative_path = PathBuf::from(folder_name).join(file_name);
            let file_relative_path_str = file_relative_path.to_string_lossy().to_string();
            if let Err(e) = sqlx::query(
                "DELETE FROM sync_folder_files WHERE file_name = ? AND type = ?"
            )
            .bind(&file_relative_path_str)
            .bind(if is_public { "public" } else { "private" })
            .execute(pool)
            .await
            {
                eprintln!("Failed to remove file from sync_folder_files DB: {}", e);
            }
        }
    }

    let cid_vec = folder_manifest_cid.as_bytes().to_vec();
    let file_hash = hex::encode(cid_vec);
    if let Some(pool) = DB_POOL.get() {
        // Check if folder record already exists
        let exists: Option<(String,)> = sqlx::query_as(
            "SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1"
        )
        .bind(account_id)
        .bind(meta_folder_name)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);

        if let Some(_) = exists {
            // Update existing record
            let _ = sqlx::query(
                "UPDATE user_profiles SET 
                    cid = ?, 
                    file_hash = ?, 
                    file_size_in_bytes = ?, 
                    main_req_hash = ?,
                    type = ?,
                    is_folder = ?,
                    processed_timestamp = CURRENT_TIMESTAMP
                WHERE owner = ? AND file_name = ?"
            )
            .bind(folder_manifest_cid)
            .bind(&file_hash)
            .bind(0)
            .bind("s3")
            .bind(if is_public { "public" } else { "private" })
            .bind(true)
            .bind(account_id)
            .bind(meta_folder_name)
            .execute(pool)
            .await;
        } else {
            let mut source = "Hippius".to_string();
            if Path::new(&target_folder).exists() {
                source =  target_folder.to_string_lossy().to_string()
            }
            // Insert new record
            let _ = sqlx::query(
                "INSERT INTO user_profiles (
                    owner, cid, file_hash, file_name, file_size_in_bytes, is_assigned, last_charged_at, 
                    main_req_hash, selected_validator, total_replicas, block_number, processed_timestamp, profile_cid, 
                    source, miner_ids, created_at, type, is_folder
                ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '', 5, 0, CURRENT_TIMESTAMP, '', ?, '[]', strftime('%s', 'now'), ?, ?)"
            )
            .bind(account_id)
            .bind(folder_manifest_cid)
            .bind(&file_hash)
            .bind(meta_folder_name)
            .bind(0)
            .bind(false)
            .bind("s3")
            .bind(source)
            .bind(if is_public { "public" } else { "private" })
            .bind(true)
            .execute(pool)
            .await;
        }
    }
}

pub async fn insert_file_if_not_exists_in_folder(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    file_path: &Path,
    account_id: &str,
    is_public: bool,
    is_folder: bool,
) {
    let file_name = file_path.to_string_lossy().to_string();
    let file_type = if is_public { "public" } else { "private" };
    let entry_type = if is_folder { "folder" } else { "file" };

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

pub async fn delete_and_unpin_user_file_records_from_folder(
    folder_name: &str,
    seed_phrase: &str,
) -> Result<u64, String> {
    if let Some(pool) = DB_POOL.get() {
        let _ = unpin_user_file_by_name(folder_name, seed_phrase)
            .await;

        let result = sqlx::query("DELETE FROM user_profiles WHERE file_name = ?")
            .bind(folder_name)
            .execute(pool)
            .await
            .map_err(|e| format!("DB error (delete user_profiles): {e}"))?;

        // Also delete from file_paths table
        let _ = sqlx::query("DELETE FROM file_paths WHERE file_name = ?")
            .bind(folder_name)
            .execute(pool)
            .await;

        let total_deleted = result.rows_affected();
        Ok(total_deleted)
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}