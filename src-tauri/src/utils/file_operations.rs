use crate::DB_POOL;
use crate::commands::syncing::{decrypt_phrase, load_encryption_key};
use crate::sync_shared::collect_files_recursively;
use crate::utils::sync::{get_private_sync_path, get_public_sync_path};
use hex;
use sp_core::Pair;
use sp_core::crypto::Ss58Codec;
use sp_core::sr25519;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

// Helper to generate all possible file name variations
#[allow(dead_code)]
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
    variations
        .into_iter()
        .filter(|v| seen.insert(v.clone()))
        .collect()
}

#[allow(dead_code)]
pub async fn unpin_user_file_by_name(file_name: &str, _seed_phrase: &str) -> Result<(), String> {
    if let Some(pool) = DB_POOL.get() {
        let variations = get_file_name_variations(file_name);
        let mut last_error = None;

        for variant in variations {
            let hashes_result = sqlx::query_as::<_, (String,)>(
                "SELECT file_hash FROM user_profiles WHERE file_name = ?",
            )
            .bind(&variant)
            .fetch_all(pool)
            .await;

            match hashes_result {
                Ok(hashes) if !hashes.is_empty() => {
                    if let Some((_file_hash,)) = hashes.first() {
                        // Also delete from file_paths table
                        let _ = sqlx::query("DELETE FROM file_paths WHERE file_name = ?")
                            .bind(variant)
                            .execute(pool)
                            .await;
                    }
                    return Err("Found empty hash result despite non-empty hashes".to_string());
                }
                Ok(_) => {}
                Err(e) => {
                    last_error = Some(format!("DB error for variant '{}': {}", variant, e));
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            format!(
                "No matching file found for '{}' or any of its variants",
                file_name
            )
        }))
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

pub async fn delete_and_unpin_user_file_records_by_name(
    file_name: &str,
    _seed_phrase: &str,
    is_public: bool,
    should_delete_folder: bool,
) -> Result<u64, String> {
    if let Some(pool) = DB_POOL.get() {
        let is_folder = sqlx::query_scalar::<_, bool>(
            "SELECT is_folder FROM user_profiles WHERE file_name = ? LIMIT 1",
        )
        .bind(file_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error (fetch is_folder): {e}"))?
        .unwrap_or(false);
        // Remove from sync folder
        remove_file_from_sync_and_db(file_name, is_public, is_folder, should_delete_folder).await;

        Ok(1)
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

#[tauri::command]
pub async fn delete_and_unpin_file_by_name(
    file_name: String,
    seed_phrase: String,
) -> Result<u64, String> {
    println!("[-] Deleting file by name '{}'", file_name);
    println!("file_name : {}", file_name);
    let mut is_public = false;
    if let Some(pool) = DB_POOL.get() {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT type FROM user_profiles WHERE file_name = ? LIMIT 1")
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
            eprintln!(
                "Failed to calculate local size for {}: {}",
                original_path.display(),
                e
            );
            0
        }
    };
    println!("File size in bytes: {}", file_size_in_bytes);
    if let Some(pool) = DB_POOL.get() {
        // Get sub-account to construct bucket_name
        let bucket_name = match sqlx::query_as::<_, (String,)>(
            "SELECT sub_account_seed_phrase FROM sub_accounts WHERE account_id = ? LIMIT 1",
        )
        .bind(account_id)
        .fetch_optional(pool)
        .await
        {
            Ok(Some((sub_account_seed_phrase,))) => {
                // Try to decrypt if we have a key, otherwise use as-is
                let maybe_key = load_encryption_key(pool).await;
                let phrase = if let Some(key) = &maybe_key {
                    decrypt_phrase(&sub_account_seed_phrase, key)
                        .unwrap_or_else(|| sub_account_seed_phrase.clone())
                } else {
                    sub_account_seed_phrase
                };
                // Convert seed phrase to SS58 address
                if let Ok((pair, _)) = sr25519::Pair::from_phrase(&phrase, None) {
                    let ss58 = pair.public().to_ss58check();
                    format!("{}-{}", ss58, if is_public { "public" } else { "private" })
                } else {
                    eprintln!("Failed to convert seed phrase to SS58 address");
                    String::new()
                }
            }
            _ => String::new(),
        };

        // Check if file already exists in user_profiles
        let exists: Option<(String,)> = sqlx::query_as(
            "SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1",
        )
        .bind(account_id)
        .bind(requested_file_name)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);

        if exists.is_none() {
            println!("inserted main_request_hash {:?}", request_cid);
            let source = dest_path_str_clone.clone();
            let _ = sqlx::query(
                    "INSERT INTO user_profiles (
                        owner, cid, file_hash, file_name, file_size_in_bytes, is_assigned, last_charged_at, 
                        main_req_hash, selected_validator, total_replicas, block_number, processed_timestamp, profile_cid, 
                        source, miner_ids, created_at, type, is_folder, bucket_name
                    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '', 5, 0, CURRENT_TIMESTAMP, '', ?, '[]', strftime('%s', 'now'), ?, ?, ?)"
                )
                .bind(account_id)
                .bind(metadata_cid)
                .bind(&file_hash)
                .bind(requested_file_name)
                .bind(file_size_in_bytes)
                .bind(false)
                .bind("s3")  
                .bind(source)   // source
                .bind(if is_public { "public" } else { "private" })  // type
                .bind(is_folder)
                .bind(bucket_name)
                .execute(pool)
                .await;

            // Also insert into file_paths table
            let _ = sqlx::query(
                    "INSERT INTO file_paths (file_name, file_hash, timestamp, path) VALUES (?, ?, ?, ?)"
                )
                .bind(requested_file_name)
                .bind(&file_hash)
                .bind(chrono::Utc::now().timestamp())
                .bind(&dest_path_str_clone)
                .execute(pool)
                .await;
        }
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
        } else if !dest_path.exists() {
            if let Err(e) = fs::copy(original_path, &dest_path) {
                eprintln!("Failed to copy file to sync folder: {}", e);
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

pub async fn remove_file_from_sync_and_db(
    file_name: &str,
    is_public: bool,
    is_folder: bool,
    should_delete_folder: bool,
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
    if !sync_file_path.exists() {
        let source = get_source_from_user_profiles(file_name, is_public)
            .await
            .unwrap_or_else(|| "Hippius".to_string());
        let _bucket_name = get_bucket_from_user_profiles(file_name, is_public)
            .await
            .unwrap_or_else(|| "Hippius".to_string());
        if source.starts_with("s3://") {
            let _ = execute_aws_s3_rm(&source.to_string(), is_folder).await;
        }
    } else {
        // Handle folder deletion
        if sync_file_path.is_dir() || is_folder {
            let mut files = Vec::new();
            let _ = collect_files_recursively(&sync_file_path, &mut files);

            if let Some(pool) = DB_POOL.get() {
                for file in &files {
                    if should_delete_folder {
                        if let Err(e) = fs::remove_file(file) {
                            eprintln!("Failed to remove file from sync folder: {}", e);
                        }
                    }
                }

                // Remove the folder record
                if let Err(e) =
                    sqlx::query("DELETE FROM user_profiles WHERE file_name = ? AND type = ?")
                        .bind(file_name)
                        .bind(if is_public { "public" } else { "private" })
                        .execute(pool)
                        .await
                {
                    eprintln!("Failed to remove folder from user_profiles DB: {}", e);
                }
            }

            if should_delete_folder {
                if let Err(e) = fs::remove_dir_all(&sync_file_path) {
                    eprintln!("Failed to remove folder from sync folder: {}", e);
                }
            }
        } else if should_delete_folder {
            if let Err(e) = fs::remove_file(&sync_file_path) {
                eprintln!("Failed to remove file from sync folder: {}", e);
            }

            if let Some(pool) = DB_POOL.get() {
                if let Err(e) =
                    sqlx::query("DELETE FROM user_profiles WHERE file_name = ? AND type = ?")
                        .bind(file_name)
                        .bind(if is_public { "public" } else { "private" })
                        .execute(pool)
                        .await
                {
                    eprintln!("Failed to remove file from user_profiles DB: {}", e);
                }
            }
        }
    }
}

pub async fn copy_to_sync_folder(
    original_path: &Path,
    folder_name: &str,
    account_id: &str,
    metadata_cid: &str,
    _request_cid: &str,
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
    let target_folder = sync_folder.join(
        subfolder_path
            .clone()
            .unwrap_or_else(|| folder_name.to_string()),
    );
    if !target_folder.exists() {
        let source = get_source_from_user_profiles(meta_folder_name, is_public)
            .await
            .unwrap_or_else(|| "Hippius".to_string());
        let _bucket_name = get_bucket_from_user_profiles(meta_folder_name, is_public)
            .await
            .unwrap_or_else(|| "Hippius".to_string());
        // Try S3 removal as fallback
        let s3_path = if let Some(sub_path) = &subfolder_path {
            if let Some(stripped) = sub_path.strip_prefix(&format!("{}/", folder_name)) {
                stripped.to_string()
            } else {
                sub_path.clone()
            }
        } else {
            String::new()
        };
        if source.starts_with("s3://") {
            let target_source = if !s3_path.is_empty() {
                format!("{}/{}", source.trim_end_matches('/'), s3_path)
            } else {
                source.clone()
            };
            let _ = execute_aws_s3_cp(
                &target_source,
                original_path.to_string_lossy().as_ref(),
                is_folder,
            )
            .await;
        }
    } else {
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
                eprintln!(
                    "Failed to calculate local size for {}: {}",
                    original_path.display(),
                    e
                );
                0
            }
        };
        println!("File size in bytes: {}", file_size_in_bytes);
        if let Some(pool) = DB_POOL.get() {
            // Get sub-account to construct bucket_name
            let bucket_name = match sqlx::query_as::<_, (String,)>(
                "SELECT sub_account_seed_phrase FROM sub_accounts WHERE account_id = ? LIMIT 1",
            )
            .bind(account_id)
            .fetch_optional(pool)
            .await
            {
                Ok(Some((sub_account_seed_phrase,))) => {
                    // Try to decrypt if we have a key, otherwise use as-is
                    let maybe_key = load_encryption_key(pool).await;
                    let phrase = if let Some(key) = &maybe_key {
                        decrypt_phrase(&sub_account_seed_phrase, key)
                            .unwrap_or_else(|| sub_account_seed_phrase.clone())
                    } else {
                        sub_account_seed_phrase
                    };
                    // Convert seed phrase to SS58 address
                    if let Ok((pair, _)) = sr25519::Pair::from_phrase(&phrase, None) {
                        let ss58 = pair.public().to_ss58check();
                        format!("{}-{}", ss58, if is_public { "public" } else { "private" })
                    } else {
                        eprintln!("Failed to convert seed phrase to SS58 address");
                        String::new()
                    }
                }
                _ => String::new(),
            };

            // Check if folder record already exists
            let exists: Option<(String,)> = sqlx::query_as(
                "SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? AND type = ? AND is_folder = ? LIMIT 1"
            )
            .bind(account_id)
            .bind(meta_folder_name)  // Use the actual folder name being inserted
            .bind(if is_public { "public" } else { "private" })
            .bind(is_folder)  // Also check if it's a folder
            .fetch_optional(pool)
            .await
            .unwrap_or(None);

            if exists.is_some() {
                // Update existing record
                let _ = sqlx::query(
                    "UPDATE user_profiles SET 
                        cid = ?, 
                        file_hash = ?, 
                        file_size_in_bytes = ?, 
                        main_req_hash = ?,
                        type = ?,
                        is_folder = ?,
                        bucket_name = ?,
                        processed_timestamp = CURRENT_TIMESTAMP
                    WHERE owner = ? AND file_name = ?",
                )
                .bind(metadata_cid)
                .bind(&file_hash)
                .bind(file_size_in_bytes)
                .bind("s3")
                .bind(if is_public { "public" } else { "private" })
                .bind(true)
                .bind(bucket_name)
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
                        source, miner_ids, created_at, type, is_folder, bucket_name
                    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, '', 5, 0, CURRENT_TIMESTAMP, '', ?, '[]', strftime('%s', 'now'), ?, ?, ?)"
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
                .bind(bucket_name)
                .execute(pool)
                .await;
            }
        }
        if is_folder {
            if !dest_path.exists() {
                if let Err(e) = std::fs::create_dir_all(&dest_path) {
                    eprintln!("Failed to create sync folder: {}", e);
                    return;
                }
            }
            copy_dir(original_path, &dest_path);
        } else if !dest_path.exists() {
            if let Err(e) = fs::copy(original_path, &dest_path) {
                eprintln!("Failed to copy file to sync folder: {}", e);
            }
        }
    }
}

pub async fn remove_from_sync_folder(
    file_name: &str,
    folder_name: &str,
    is_public: bool,
    is_folder: bool,
    _meta_folder_name: &str,
    _folder_manifest_cid: &str,
    _account_id: &str,
    _requested_cid: &str,
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
    println!("sync_file_path: {}", sync_file_path.exists());
    if !sync_file_path.exists() {
        // Try S3 removal as fallback
        let s3_path = if let Some(sub_path) = &subfolder_path {
            if let Some(stripped) = sub_path.strip_prefix(&format!("{}/", folder_name)) {
                stripped.to_string()
            } else {
                sub_path.clone()
            }
        } else {
            String::new()
        };

        let source = get_source_from_user_profiles(folder_name, is_public)
            .await
            .unwrap_or_else(|| "Hippius".to_string());
        let _bucket_name = get_bucket_from_user_profiles(folder_name, is_public)
            .await
            .unwrap_or_else(|| "Hippius".to_string());
        println!("s3_path : {}", s3_path);
        println!("subfolder_path: {:?}", subfolder_path);
        if source.starts_with("s3://") {
            let target_source = if !s3_path.is_empty() {
                if is_folder {
                    format!("{}/{}", source.trim_end_matches('/'), s3_path)
                } else {
                    format!("{}/{}/{}", source.trim_end_matches('/'), s3_path, file_name)
                }
            } else {
                format!("{}/{}", source, file_name)
            };
            println!("target_source : {}", target_source);
            if let Err(e) = execute_aws_s3_rm(&target_source, is_folder).await {
                eprintln!("Failed to remove file from S3: {}", e);
            }
        }
    } else {
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
                    if let Err(e) = fs::remove_file(file) {
                        eprintln!("Failed to remove file from sync folder: {}", e);
                    }
                }

                let folder_relative_path = PathBuf::from(folder_name).join(file_name);
                let folder_relative_path_str = folder_relative_path.to_string_lossy().to_string();
                if let Err(e) =
                    sqlx::query("DELETE FROM user_profiles WHERE file_name = ? AND type = ?")
                        .bind(&folder_relative_path_str)
                        .bind(if is_public { "public" } else { "private" })
                        .execute(pool)
                        .await
                {
                    eprintln!("Failed to remove folder from user_profiles DB: {}", e);
                }
            }

            if let Err(e) = fs::remove_dir_all(&sync_file_path) {
                eprintln!("Failed to remove folder from sync folder: {}", e);
            }
        } else if sync_file_path.exists() {
            if let Err(e) = fs::remove_file(&sync_file_path) {
                eprintln!("Failed to remove file from sync folder: {}", e);
            }
            if let Some(pool) = DB_POOL.get() {
                let file_relative_path = PathBuf::from(folder_name).join(file_name);
                let file_relative_path_str = file_relative_path.to_string_lossy().to_string();
                if let Err(e) =
                    sqlx::query("DELETE FROM user_profiles WHERE file_name = ? AND type = ?")
                        .bind(&file_relative_path_str)
                        .bind(if is_public { "public" } else { "private" })
                        .execute(pool)
                        .await
                {
                    eprintln!("Failed to remove file from user_profiles DB: {}", e);
                }
            }
        }
    }
}

async fn execute_aws_s3_rm(path: &str, is_folder: bool) -> Result<(), String> {
    // Get AWS binary path
    let aws_binary_path = match crate::commands::node::get_aws_binary_path().await {
        Ok(path) => path,
        Err(e) => {
            eprintln!("[execute_aws_s3_rm] Failed to get AWS binary path: {}", e);
            return Err("Failed to locate AWS CLI".to_string());
        }
    };

    // Construct dynamic PATH with OS-appropriate separator
    let path_separator = if cfg!(windows) { ";" } else { ":" };
    let dynamic_path = format!(
        "{}{}{}",
        aws_binary_path.parent().unwrap().to_string_lossy(),
        path_separator,
        std::env::var("PATH").unwrap_or_default()
    );

    let endpoint_url = "https://s3.hippius.com";

    let mut cmd = Command::new(&aws_binary_path);
    cmd.env("PATH", &dynamic_path);

    if is_folder {
        cmd.args([
            "s3",
            "rm",
            "--recursive",
            "--endpoint-url",
            endpoint_url,
            path,
        ]);
    } else {
        cmd.args(["s3", "rm", "--endpoint-url", endpoint_url, path]);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd.output().map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    println!("[AWS CLI] Command status: {}", output.status);
    if !stdout.is_empty() {
        println!("[AWS CLI] Output: {}", stdout);
    }
    if !stderr.is_empty() {
        println!("[AWS CLI] Error: {}", stderr);
    }

    if output.status.success() {
        Ok(())
    } else {
        Err(format!("Failed to delete from S3: {}", stderr))
    }
}

async fn execute_aws_s3_cp(source: &str, local_path: &str, is_folder: bool) -> Result<(), String> {
    // Get AWS binary path
    let aws_binary_path = match crate::commands::node::get_aws_binary_path().await {
        Ok(path) => path,
        Err(e) => {
            eprintln!("[execute_aws_s3_cp] Failed to get AWS binary path: {}", e);
            return Err("Failed to locate AWS CLI".to_string());
        }
    };

    // Construct dynamic PATH with OS-appropriate separator
    let path_separator = if cfg!(windows) { ";" } else { ":" };
    let dynamic_path = format!(
        "{}{}{}",
        aws_binary_path.parent().unwrap().to_string_lossy(),
        path_separator,
        std::env::var("PATH").unwrap_or_default()
    );
    println!("[execute_aws_s3_cp] Dynamic PATH: {}", dynamic_path);
    let endpoint_url = "https://s3.hippius.com";

    let destination = if is_folder {
        // For folders: source + folder_name + /
        let mut dest = source.to_string();

        // Remove trailing slashes from source
        while dest.ends_with('/') {
            dest.pop();
        }

        // Get the folder name from the local path
        let local_trimmed = local_path.trim_end_matches(['/', '\\']);
        if let Some(folder_name_os) = Path::new(local_trimmed).file_name() {
            let folder_name = folder_name_os.to_string_lossy();
            dest.push('/');
            dest.push_str(&folder_name);
            dest.push('/');
        } else {
            // Fallback: just ensure it ends with /
            if !dest.ends_with('/') {
                dest.push('/');
            }
        }
        dest
    } else {
        // For files: source + filename
        let mut dest = source.to_string();
        if !dest.ends_with('/') {
            dest.push('/');
        }
        if let Some(filename) = Path::new(local_path).file_name() {
            dest.push_str(&filename.to_string_lossy());
        }
        dest
    };

    let mut cmd = Command::new(&aws_binary_path);
    cmd.env("PATH", &dynamic_path);

    println!(
        "[AWS CLI] Uploading {} to {} (is_folder: {})",
        local_path, destination, is_folder
    );

    if is_folder {
        cmd.args([
            "s3",
            "cp",
            local_path,
            &destination,
            "--recursive",
            "--endpoint-url",
            endpoint_url,
        ]);
    } else {
        cmd.args([
            "s3",
            "cp",
            local_path,
            &destination,
            "--endpoint-url",
            endpoint_url,
        ]);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd.output().map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    println!("[AWS CLI] Command status: {}", output.status);
    if !stdout.is_empty() {
        println!("[AWS CLI] Output: {}", stdout);
    }
    if !stderr.is_empty() {
        println!("[AWS CLI] Error: {}", stderr);
    }

    if output.status.success() {
        Ok(())
    } else {
        Err(format!("Failed to upload to S3: {}", stderr))
    }
}

async fn get_source_from_user_profiles(file_name: &str, is_public: bool) -> Option<String> {
    if let Some(pool) = DB_POOL.get() {
        let file_type = if is_public { "public" } else { "private" };
        if let Ok(Some((source,))) = sqlx::query_as::<_, (String,)>(
            "SELECT source FROM user_profiles WHERE file_name = ? AND type = ?",
        )
        .bind(file_name)
        .bind(file_type)
        .fetch_optional(pool)
        .await
        {
            return Some(source);
        }
    }
    None
}

// Helper function to get bucket_name from user_profiles
async fn get_bucket_from_user_profiles(file_name: &str, is_public: bool) -> Option<String> {
    if let Some(pool) = DB_POOL.get() {
        let file_type = if is_public { "public" } else { "private" };
        if let Ok(Some((bucket_name,))) = sqlx::query_as::<_, (String,)>(
            "SELECT bucket_name FROM user_profiles WHERE file_name = ? AND type = ?",
        )
        .bind(file_name)
        .bind(file_type)
        .fetch_optional(pool)
        .await
        {
            return Some(bucket_name);
        }
    }
    None
}
