use crate::utils::{
    accounts::{
        encrypt_file, decrypt_file
    },
    ipfs::{
        download_from_ipfs,upload_to_ipfs
    },
    file_operations::{request_erasure_storage, copy_to_sync_and_add_to_db, 
        request_file_storage , remove_from_sync_folder, copy_to_sync_folder}
};
use uuid::Uuid;
use std::fs;
use reed_solomon_erasure::galois_8::ReedSolomon;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use tempfile::tempdir;
use crate::DB_POOL;
use crate::commands::types::*;
use once_cell::sync::Lazy;
use tokio::sync::Mutex;
use crate::constants::folder_sync::{DEFAULT_K, DEFAULT_M, DEFAULT_CHUNK_SIZE};
use crate::sync_shared::collect_files_recursively;
use serde::{Deserialize, Serialize};
use std::path::Path;
use base64::decode;
use sqlx::Row;
use crate::utils::sync::get_public_sync_path;
use std::path::PathBuf;

// Helper function to format file sizes
fn format_file_size(size_bytes: usize) -> String {
    const UNITS: &[&str] = &["bytes", "KB", "MB", "GB", "TB"];
    let mut size = size_bytes as f64;
    let mut unit_index = 0;
    
    while size >= 1024.0 && unit_index < UNITS.len() - 1 {
        size /= 1024.0;
        unit_index += 1;
    }
    
    if unit_index == 0 {
        format!("{} {}", size_bytes, UNITS[unit_index])
    } else {
        format!("{:.1} {}", size, UNITS[unit_index])
    }
}

#[tauri::command]
pub async fn encrypt_and_upload_file(
    account_id: String,
    file_path: String,
    seed_phrase: String,
    encryption_key: Option<Vec<u8>>,
) -> Result<String, String> {
    println!("file path is {:?}", file_path.clone());    
    let api_url = "http://127.0.0.1:5001";
    let k = DEFAULT_K;
    let m = DEFAULT_M;
    let chunk_size = DEFAULT_CHUNK_SIZE; // 1MB
    let account_id_clone = account_id.clone();
    
    // Extract file name from file_path
    let file_name = Path::new(&file_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "Invalid file path, cannot extract file name".to_string())?;

    // Check if file already exists in DB for this account
    if let Some(pool) = DB_POOL.get() {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1"
        )
        .bind(&account_id)
        .bind(&file_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error: {e}"))?;
        if row.is_some() {
            return Err(format!("File '{}' already exists for this user.", file_name));
        }
    }

    let file_path_cloned = file_path.clone();
    let api_url_cloned = api_url.to_string();
    let encryption_key_cloned = encryption_key.clone();
    // Run blocking work and return file_name, metadata_cid, and chunk_pairs (filename,cid)
    let (file_name, metadata_cid, chunk_pairs) = tokio::task::spawn_blocking(move || {
        // Read file
        let file_data = fs::read(&file_path_cloned).map_err(|e| e.to_string())?;
        // Calculate original file hash
        let mut hasher = Sha256::new();
        hasher.update(&file_data);
        let original_file_hash = format!("{:x}", hasher.finalize());

        // Encrypt using centralized function
        let to_process = tauri::async_runtime::block_on(encrypt_file(&file_data, encryption_key_cloned))?;
        // Split into chunks
        let mut chunks = vec![];
        for i in (0..to_process.len()).step_by(chunk_size) {
            let mut chunk = to_process[i..std::cmp::min(i + chunk_size, to_process.len())].to_vec();
            if chunk.len() < chunk_size {
                chunk.resize(chunk_size, 0);
            }
            chunks.push(chunk);
        }
        // Erasure code each chunk
        let r = ReedSolomon::new(k, m - k).map_err(|e| format!("ReedSolomon error: {e}"))?;
        let temp_dir = tempdir().map_err(|e| e.to_string())?;
        let mut all_chunk_info = vec![];
        let mut chunk_pairs: Vec<(String,String)> = Vec::new();
        let file_id = Uuid::new_v4().to_string();
        for (orig_idx, chunk) in chunks.iter().enumerate() {
            // Split chunk into k sub-blocks
            let sub_block_size = (chunk.len() + k - 1) / k;
            let sub_blocks: Vec<Vec<u8>> = (0..k).map(|j| {
                let start = j * sub_block_size;
                let end = std::cmp::min(start + sub_block_size, chunk.len());
                let mut sub_block = chunk[start..end].to_vec();
                if sub_block.len() < sub_block_size {
                    sub_block.resize(sub_block_size, 0);
                }
                sub_block
            }).collect();
            // Prepare m shards
            let mut shards: Vec<Option<Vec<u8>>> = sub_blocks.into_iter().map(Some).collect();
            for _ in k..m {
                shards.push(Some(vec![0u8; sub_block_size]));
            }
            // Encode
            let mut shard_refs: Vec<_> = shards
                .iter_mut()
                .map(|x| x.as_mut().unwrap().as_mut_slice())
                .collect();
            r.encode(&mut shard_refs)
                .map_err(|e| format!("ReedSolomon encode error: {e}"))?;
            // Write and upload each shard
            for (share_idx, shard) in shard_refs.iter().enumerate() {
                let chunk_name = format!("{}_chunk_{}_{}.ec", file_id, orig_idx, share_idx);
                let chunk_path = temp_dir.path().join(&chunk_name);
                let mut f = fs::File::create(&chunk_path).map_err(|e| e.to_string())?;
                f.write_all(shard).map_err(|e| e.to_string())?;
                let cid = upload_to_ipfs(&api_url_cloned, chunk_path.to_str().unwrap()).map_err(|e| e.to_string())?;
                all_chunk_info.push(ChunkInfo {
                    name: chunk_name.clone(),
                    path: chunk_path.to_string_lossy().to_string(),
                    cid: CidInfo {
                        cid: cid.clone(),
                        filename: chunk_name.clone(),
                        size_bytes: shard.len(),
                        encrypted: true,
                        size_formatted: format_file_size(shard.len()),
                    },
                    original_chunk: orig_idx,
                    share_idx,
                    size: shard.len(),
                });
                chunk_pairs.push((chunk_name.clone(), cid.clone()));
            }
        }
        // Build metadata
        let file_name = std::path::Path::new(&file_path_cloned).file_name().unwrap().to_string_lossy().to_string();
        let file_extension = std::path::Path::new(&file_path_cloned).extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let encrypted_size = to_process.len();
        let metadata = Metadata {
            original_file: OriginalFileInfo {
                name: file_name.clone(),
                size: file_data.len(),
                hash: original_file_hash,
                extension: file_extension,
            },
            erasure_coding: ErasureCodingInfo {
                k,
                m,
                chunk_size,
                encrypted: true,
                file_id: file_id.clone(),
                encrypted_size,
            },
            chunks: all_chunk_info,
            metadata_cid: None,
        };
        // Write metadata to temp file
        let metadata_path = temp_dir.path().join(format!("{}_metadata.json", file_id));
        let metadata_json = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
        fs::write(&metadata_path, metadata_json.as_bytes()).map_err(|e| e.to_string())?;
        // Upload metadata
        let metadata_cid = upload_to_ipfs(&api_url_cloned, metadata_path.to_str().unwrap()).map_err(|e| e.to_string())?;
        Ok::<(String, String, Vec<(String,String)>), String>((file_name, metadata_cid, chunk_pairs))
    })
    .await
    .map_err(|e| e.to_string())??;

    // Build files array: metadata entry plus chunk entries
    let meta_filename = format!("{}{}", file_name, if file_name.ends_with(".ec_metadata") { "" } else { ".ec_metadata" });
    let mut files_for_storage = Vec::with_capacity(chunk_pairs.len() + 1);
    files_for_storage.push((meta_filename.clone(), metadata_cid.clone()));
    files_for_storage.extend(chunk_pairs);
    let storage_result = request_erasure_storage(&meta_filename.clone(), &files_for_storage, api_url, &seed_phrase).await;
    match &storage_result {
        Ok(res) => {
            copy_to_sync_and_add_to_db(Path::new(&file_path), &account_id,  &metadata_cid, &res, false, false, &meta_filename).await;
            println!("[encrypt_and_upload_file] : {}", res);
        },
        Err(e) => println!("[encrypt_and_upload_file] Storage request error: {}", e),
    }

    Ok(metadata_cid)
}

#[tauri::command]
pub async fn download_and_decrypt_file(
    account_id: String,
    metadata_cid: String,
    output_file: String,
    encryption_key: Option<String>,
) -> Result<(), String> {
    // Define the API URL inside the function
    let api_url = "http://127.0.0.1:5001";
    
    let final_encryption_key = if let Some(key_b64) = encryption_key {
        println!("Received base64 encryption key: {}", key_b64);
        let decoded_key = decode(&key_b64)
            .map_err(|e| format!("Failed to decode base64 key: {}", e))?;
        println!("Decoded key bytes: {:?}", decoded_key);
        Some(decoded_key)
    } else {
        println!("No encryption key provided, will fetch from DB if needed.");
        None
    };

    tokio::task::spawn_blocking(move || {
        println!("metadata_cid is {}", metadata_cid);
        // Download metadata
        let metadata_bytes =
            download_from_ipfs(&api_url, &metadata_cid).map_err(|e| e.to_string())?;
        let metadata: Metadata =
            serde_json::from_slice(&metadata_bytes).map_err(|e| e.to_string())?;

        let k = metadata.erasure_coding.k;
        let m = metadata.erasure_coding.m;
        let chunk_size = metadata.erasure_coding.chunk_size;
        let file_hash = &metadata.original_file.hash;
        // Group chunks by original chunk index
        let mut chunk_map: std::collections::HashMap<usize, Vec<&ChunkInfo>> =
            std::collections::HashMap::new();
        for chunk in &metadata.chunks {
            chunk_map
                .entry(chunk.original_chunk)
                .or_default()
                .push(chunk);
        }

        let mut reconstructed_chunks = Vec::with_capacity(chunk_map.len());

        for orig_idx in 0..chunk_map.len() {
            let available_chunks = chunk_map.get(&orig_idx).ok_or("Missing chunk info")?;
            // Download shards into Vec<Option<Vec<u8>>>
            let mut shards: Vec<Option<Vec<u8>>> = vec![None; m];
            for chunk in available_chunks {
                let data = download_from_ipfs(&api_url, &chunk.cid.cid).map_err(|e| e.to_string())?;
                shards[chunk.share_idx] = Some(data);
            }

            // Check if we have enough
            let available_count = shards.iter().filter(|s| s.is_some()).count();
            if available_count < k {
                return Err(format!(
                    "Not enough shards for chunk {}: found {}, need {}",
                    orig_idx, available_count, k
                ));
            }

            // Reconstruct
            let r = ReedSolomon::new(k, m - k).map_err(|e| format!("ReedSolomon error: {e}"))?;
            r.reconstruct_data(&mut shards)
                .map_err(|e| format!("Reconstruction failed: {e}"))?;

            // Calculate how many bytes to take for this chunk
            let is_last_chunk = orig_idx == chunk_map.len() - 1;
            let encrypted_size = metadata.erasure_coding.encrypted_size;
            let chunk_bytes_needed = if !is_last_chunk {
                chunk_size
            } else {
                // For the last chunk, only take the remaining bytes needed
                let total_bytes_so_far: usize = chunk_size * orig_idx;
                encrypted_size.saturating_sub(total_bytes_so_far)
            };

            let mut chunk_data = Vec::with_capacity(chunk_bytes_needed);
            let mut bytes_collected = 0;
            for i in 0..k {
                if let Some(ref shard) = shards[i] {
                    let bytes_to_take =
                        std::cmp::min(chunk_bytes_needed - bytes_collected, shard.len());
                    chunk_data.extend_from_slice(&shard[..bytes_to_take]);
                    bytes_collected += bytes_to_take;
                    if bytes_collected == chunk_bytes_needed {
                        break;
                    }
                }
            }
            reconstructed_chunks.push(chunk_data);
        }

        // Combine chunks
        let mut encrypted_data = Vec::new();
        for chunk in reconstructed_chunks {
            encrypted_data.extend_from_slice(&chunk);
        }
        // Truncate to expected total
        let encrypted_size = metadata.erasure_coding.encrypted_size;
        if encrypted_data.len() > encrypted_size {
            encrypted_data.truncate(encrypted_size);
        }
        // Decrypt using centralized function
        let decrypted_data = tauri::async_runtime::block_on(decrypt_file(
            &encrypted_data,
            final_encryption_key.clone(),
        ))?;

        // Hash check
        let mut hasher = Sha256::new();
        hasher.update(&decrypted_data);
        let actual_hash = format!("{:x}", hasher.finalize());
        if actual_hash != *file_hash {
            return Err(format!(
                "Hash mismatch: expected {}, got {}",
                file_hash, actual_hash
            ));
        }
        // Save
        std::fs::write(output_file.clone(), decrypted_data).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        hasher.update(&encrypted_data);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn write_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upload_file_public(
    account_id: String,
    file_path: String,
    seed_phrase: String
) -> Result<String, String> {
    use std::path::Path;
    println!("[upload_file_public] file path is {:?}", file_path.clone());    
    let api_url = "http://127.0.0.1:5001";
    
    // Extract file name from file_path
    let file_name = Path::new(&file_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "Invalid file path, cannot extract file name".to_string())?;

    // Check if file already exists in DB for this account
    if let Some(pool) = DB_POOL.get() {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1"
        )
        .bind(&account_id)
        .bind(&file_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error: {e}"))?;
        if row.is_some() {
            return Err(format!("File '{}' already exists for this user.", file_name));
        }
    }

    let file_path_cloned = file_path.clone();
    let api_url_cloned = api_url.to_string();
    let file_cid = tokio::task::spawn_blocking(move || {
        upload_to_ipfs(&api_url_cloned, &file_path_cloned)
    })
    .await
    .map_err(|e| format!("Task spawn error: {}", e))?
    .map_err(|e| format!("Upload error: {}", e))?;

    println!("[upload_file_public] File CID: {}", file_cid);

    // Call request_file_storage and log its returned CID
    let storage_result = request_file_storage(&file_name.clone(), &file_cid, api_url, &seed_phrase).await;
    match &storage_result {
        Ok(res) => {
            copy_to_sync_and_add_to_db(Path::new(&file_path), &account_id, &file_cid, &res, true, false, &file_name).await;
            println!("[upload_file_public] Storage request result: {}", res);
        },
        Err(e) => println!("[upload_file_public] Storage request error: {}", e),
    }

    Ok(file_cid)
}

#[tauri::command]
pub async fn download_file_public(
    file_cid: String,
    output_file: String,
) -> Result<(), String> {
    let api_url = "http://127.0.0.1:5001";
    
    println!("[download_file_public] Downloading file with CID: {} to: {}", file_cid, output_file);
    
    let file_cid_cloned = file_cid.clone();
    let api_url_cloned = api_url.to_string();
    let file_data = tokio::task::spawn_blocking(move || {
        download_from_ipfs(&api_url_cloned, &file_cid_cloned)
    })
    .await
    .map_err(|e| format!("Task spawn error: {}", e))?
    .map_err(|e| format!("Failed to download file from IPFS: {}", e))?;
    
    // Save to output file
    std::fs::write(&output_file, file_data)
        .map_err(|e| format!("Failed to write file to {}: {}", output_file, e))?;
    
    println!("[download_file_public] Successfully downloaded file to: {}", output_file);
    Ok(())
}

#[tauri::command]
pub async fn public_upload_with_erasure(
    account_id: String,
    file_path: String,
    seed_phrase: String,
) -> Result<String, String> {
    use std::path::Path;
    println!("[upload_file_no_encrypt] file path is {:?}", file_path.clone());    
    let api_url = "http://127.0.0.1:5001";
    let k = DEFAULT_K;
    let m = DEFAULT_M;
    let chunk_size = DEFAULT_CHUNK_SIZE; // 1MB
    let account_id_clone = account_id.clone();
    
    // Extract file name from file_path
    let file_name = Path::new(&file_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "Invalid file path, cannot extract file name".to_string())?;

    // Check if file already exists in DB for this account
    if let Some(pool) = DB_POOL.get() {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1"
        )
        .bind(&account_id)
        .bind(&file_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error: {e}"))?;
        if row.is_some() {
            return Err(format!("File '{}' already exists for this user.", file_name));
        }
    }

    let file_path_cloned = file_path.clone();
    let api_url_cloned = api_url.to_string();
    // Run blocking work and return file_name, metadata_cid and chunk_pairs
    let (file_name, metadata_cid, chunk_pairs) = tokio::task::spawn_blocking(move || {
        // Read file
        let file_data = fs::read(&file_path_cloned).map_err(|e| e.to_string())?;
        // Calculate original file hash
        let mut hasher = Sha256::new();
        hasher.update(&file_data);
        let original_file_hash = format!("{:x}", hasher.finalize());

        // DO NOT ENCRYPT: use file_data directly
        let to_process = file_data;
        // Split into chunks
        let mut chunks = vec![];
        for i in (0..to_process.len()).step_by(chunk_size) {
            let mut chunk = to_process[i..std::cmp::min(i + chunk_size, to_process.len())].to_vec();
            if chunk.len() < chunk_size {
                chunk.resize(chunk_size, 0);
            }
            chunks.push(chunk);
        }
        // Erasure code each chunk
        let r = ReedSolomon::new(k, m - k).map_err(|e| format!("ReedSolomon error: {e}"))?;
        let temp_dir = tempdir().map_err(|e| e.to_string())?;
        let mut all_chunk_info = vec![];
        let mut chunk_pairs: Vec<(String,String)> = Vec::new();
        let file_id = Uuid::new_v4().to_string();
        for (orig_idx, chunk) in chunks.iter().enumerate() {
            // Split chunk into k sub-blocks
            let sub_block_size = (chunk.len() + k - 1) / k;
            let sub_blocks: Vec<Vec<u8>> = (0..k).map(|j| {
                let start = j * sub_block_size;
                let end = std::cmp::min(start + sub_block_size, chunk.len());
                let mut sub_block = chunk[start..end].to_vec();
                if sub_block.len() < sub_block_size {
                    sub_block.resize(sub_block_size, 0);
                }
                sub_block
            }).collect();
            // Prepare m shards
            let mut shards: Vec<Option<Vec<u8>>> = sub_blocks.into_iter().map(Some).collect();
            for _ in k..m {
                shards.push(Some(vec![0u8; sub_block_size]));
            }
            // Encode
            let mut shard_refs: Vec<_> = shards
                .iter_mut()
                .map(|x| x.as_mut().unwrap().as_mut_slice())
                .collect();
            r.encode(&mut shard_refs)
                .map_err(|e| format!("ReedSolomon encode error: {e}"))?;
            // Write and upload each shard
            for (share_idx, shard) in shard_refs.iter().enumerate() {
                let chunk_name = format!("{}_chunk_{}_{}.ec", file_id, orig_idx, share_idx);
                let chunk_path = temp_dir.path().join(&chunk_name);
                let mut f = fs::File::create(&chunk_path).map_err(|e| e.to_string())?;
                f.write_all(shard).map_err(|e| e.to_string())?;
                let cid = upload_to_ipfs(&api_url_cloned, chunk_path.to_str().unwrap()).map_err(|e| e.to_string())?;
                all_chunk_info.push(ChunkInfo {
                    name: chunk_name.clone(),
                    path: chunk_path.to_string_lossy().to_string(),
                    cid: CidInfo {
                        cid: cid.clone(),
                        filename: chunk_name.clone(),
                        size_bytes: shard.len(),
                        encrypted: false,
                        size_formatted: format_file_size(shard.len()),
                    },
                    original_chunk: orig_idx,
                    share_idx,
                    size: shard.len(),
                });
                chunk_pairs.push((chunk_name.clone(), cid.clone()));
            }
        }
        // Build metadata
        let file_name = std::path::Path::new(&file_path_cloned).file_name().unwrap().to_string_lossy().to_string();
        let file_extension = std::path::Path::new(&file_path_cloned).extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let encrypted_size = to_process.len();
        let metadata = Metadata {
            original_file: OriginalFileInfo {
                name: file_name.clone(),
                size: to_process.len(),
                hash: original_file_hash,
                extension: file_extension,
            },
            erasure_coding: ErasureCodingInfo {
                k,
                m,
                chunk_size,
                encrypted: false,
                file_id: file_id.clone(),
                encrypted_size,
            },
            chunks: all_chunk_info,
            metadata_cid: None,
        };
        // Write metadata to temp file
        let metadata_path = temp_dir.path().join(format!("{}_metadata.json", file_id));
        let metadata_json = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
        fs::write(&metadata_path, metadata_json.as_bytes()).map_err(|e| e.to_string())?;
        // Upload metadata
        let metadata_cid = upload_to_ipfs(&api_url_cloned, metadata_path.to_str().unwrap()).map_err(|e| e.to_string())?;
        Ok::<(String, String, Vec<(String,String)>), String>((file_name, metadata_cid, chunk_pairs))
    })
    .await
    .map_err(|e| e.to_string())??;

    // Build files array: metadata + chunks
    let meta_filename = format!("{}{}", file_name, if file_name.ends_with(".ec_metadata") { "" } else { ".ec_metadata" });
    let mut files_for_storage = Vec::with_capacity(chunk_pairs.len() + 1);
    files_for_storage.push((meta_filename.clone(), metadata_cid.clone()));
    files_for_storage.extend(chunk_pairs);

    let storage_result = request_erasure_storage(&meta_filename.clone(), &files_for_storage, api_url, &seed_phrase).await;
    match &storage_result {
        Ok(res) => {
            copy_to_sync_and_add_to_db(Path::new(&file_path), &account_id,  &metadata_cid, &res, true, false, &meta_filename).await;
            println!("[upload_file_no_encrypt] : {}", res);
        },
        Err(e) => println!("[upload_file_no_encrypt] Storage request error: {}", e),
    }

    Ok(metadata_cid)
}

#[tauri::command]
pub async fn public_download_with_erasure(
    account_id: String,
    metadata_cid: String,
    output_file: String,
) -> Result<(), String> {
    // Define the API URL inside the function
    let api_url = "http://127.0.0.1:5001";
    
    tokio::task::spawn_blocking(move || {
        // Download metadata
        let metadata_bytes =
            download_from_ipfs(&api_url, &metadata_cid).map_err(|e| e.to_string())?;
        let metadata: Metadata =
            serde_json::from_slice(&metadata_bytes).map_err(|e| e.to_string())?;

        let k = metadata.erasure_coding.k;
        let m = metadata.erasure_coding.m;
        let chunk_size = metadata.erasure_coding.chunk_size;
        let file_hash = &metadata.original_file.hash;
        // Group chunks by original chunk index
        let mut chunk_map: std::collections::HashMap<usize, Vec<&ChunkInfo>> =
            std::collections::HashMap::new();
        for chunk in &metadata.chunks {
            chunk_map
                .entry(chunk.original_chunk)
                .or_default()
                .push(chunk);
        }

        let mut reconstructed_chunks = Vec::with_capacity(chunk_map.len());

        for orig_idx in 0..chunk_map.len() {
            let available_chunks = chunk_map.get(&orig_idx).ok_or("Missing chunk info")?;
            // Download shards into Vec<Option<Vec<u8>>>
            let mut shards: Vec<Option<Vec<u8>>> = vec![None; m];
            for chunk in available_chunks {
                let data = download_from_ipfs(&api_url, &chunk.cid.cid).map_err(|e| e.to_string())?;
                shards[chunk.share_idx] = Some(data);
            }

            // Check if we have enough
            let available_count = shards.iter().filter(|s| s.is_some()).count();
            if available_count < k {
                return Err(format!(
                    "Not enough shards for chunk {}: found {}, need {}",
                    orig_idx, available_count, k
                ));
            }

            // Reconstruct
            let r = ReedSolomon::new(k, m - k).map_err(|e| format!("ReedSolomon error: {e}"))?;
            r.reconstruct_data(&mut shards)
                .map_err(|e| format!("Reconstruction failed: {e}"))?;

            // Calculate how many bytes to take for this chunk
            let is_last_chunk = orig_idx == chunk_map.len() - 1;
            let encrypted_size = metadata.erasure_coding.encrypted_size;
            let chunk_bytes_needed = if !is_last_chunk {
                chunk_size
            } else {
                // For the last chunk, only take the remaining bytes needed
                let total_bytes_so_far: usize = chunk_size * orig_idx;
                encrypted_size.saturating_sub(total_bytes_so_far)
            };

            let mut chunk_data = Vec::with_capacity(chunk_bytes_needed);
            let mut bytes_collected = 0;
            for i in 0..k {
                if let Some(ref shard) = shards[i] {
                    let bytes_to_take =
                        std::cmp::min(chunk_bytes_needed - bytes_collected, shard.len());
                    chunk_data.extend_from_slice(&shard[..bytes_to_take]);
                    bytes_collected += bytes_to_take;
                    if bytes_collected == chunk_bytes_needed {
                        break;
                    }
                }
            }
            reconstructed_chunks.push(chunk_data);
        }

        // Combine chunks
        let mut reconstructed_data = Vec::new();
        for chunk in reconstructed_chunks {
            reconstructed_data.extend_from_slice(&chunk);
        }
        // Truncate to expected total
        let encrypted_size = metadata.erasure_coding.encrypted_size;
        if reconstructed_data.len() > encrypted_size {
            reconstructed_data.truncate(encrypted_size);
        }
        // Hash check
        let mut hasher = Sha256::new();
        hasher.update(&reconstructed_data);
        let actual_hash = format!("{:x}", hasher.finalize());
        if actual_hash != *file_hash {
            return Err(format!(
                "Hash mismatch: expected {}, got {}",
                file_hash, actual_hash
            ));
        }
        // Save
        std::fs::write(output_file.clone(), reconstructed_data).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn encrypt_and_upload_folder(
    account_id: String,
    folder_path: String,
    seed_phrase: String,
    encryption_key: Option<Vec<u8>>,
) -> Result<String, String> {
    let api_url = "http://127.0.0.1:5001";
    
    let folder_path = Path::new(&folder_path);
    if !folder_path.is_dir() {
        return Err("Provided path is not a directory".to_string());
    }

    let folder_name = folder_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "Invalid folder path, cannot extract folder name".to_string())?;

    // Check if folder already exists in DB
    if let Some(pool) = DB_POOL.get() {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1"
        )
        .bind(&account_id)
        .bind(&folder_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error: {e}"))?;
        if row.is_some() {
            return Err(format!("Folder '{}' already exists for this user.", folder_name));
        }
    }

    // Clone data for thread-safe async block
    let folder_path_cloned = folder_path.to_path_buf();
    let api_url_cloned = api_url.to_string();
    let account_id_cloned = account_id.clone();
    let encryption_key_cloned = encryption_key.clone();
    let (folder_name, folder_metadata_cid, file_pairs) = tokio::task::spawn_blocking(move || {
        let mut file_entries = Vec::new();
        let mut files = Vec::new();
        let mut file_pairs: Vec<(String, String)> = Vec::new(); // Collect (filename, cid) pairs for storage request later
        let _ = collect_files_recursively(&folder_path_cloned, &mut files);

        let temp_dir = tempdir().map_err(|e| e.to_string())?;

        for file_path in files {
            let relative_path = file_path.strip_prefix(&folder_path_cloned)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .to_string();

            let file_data = fs::read(&file_path).map_err(|e| e.to_string())?;
            let file_size = file_data.len();

            // Hash original file
            let mut hasher = Sha256::new();
            hasher.update(&file_data);
            let original_file_hash = format!("{:x}", hasher.finalize());

            // Encrypt (blocking)
            let to_process = tauri::async_runtime::block_on(encrypt_file(&file_data, encryption_key_cloned.clone()))?;

            // Erasure coding
            let k = DEFAULT_K;
            let m = DEFAULT_M;
            let chunk_size = DEFAULT_CHUNK_SIZE;
            let mut chunks = vec![];

            for i in (0..to_process.len()).step_by(chunk_size) {
                let mut chunk = to_process[i..std::cmp::min(i + chunk_size, to_process.len())].to_vec();
                if chunk.len() < chunk_size {
                    chunk.resize(chunk_size, 0);
                }
                chunks.push(chunk);
            }

            let r = ReedSolomon::new(k, m - k).map_err(|e| format!("ReedSolomon error: {e}"))?;
            let mut all_chunk_info = vec![];
            let file_id = Uuid::new_v4().to_string();

            for (orig_idx, chunk) in chunks.iter().enumerate() {
                let sub_block_size = (chunk.len() + k - 1) / k;
                let sub_blocks: Vec<Vec<u8>> = (0..k).map(|j| {
                    let start = j * sub_block_size;
                    let end = std::cmp::min(start + sub_block_size, chunk.len());
                    let mut sub_block = chunk[start..end].to_vec();
                    if sub_block.len() < sub_block_size {
                        sub_block.resize(sub_block_size, 0);
                    }
                    sub_block
                }).collect();

                let mut shards: Vec<Option<Vec<u8>>> = sub_blocks.into_iter().map(Some).collect();
                for _ in k..m {
                    shards.push(Some(vec![0u8; sub_block_size]));
                }

                let mut shard_refs: Vec<_> = shards
                    .iter_mut()
                    .map(|x| x.as_mut().unwrap().as_mut_slice())
                    .collect();

                r.encode(&mut shard_refs).map_err(|e| format!("ReedSolomon encode error: {e}"))?;

                for (share_idx, shard) in shard_refs.iter().enumerate() {
                    let chunk_name = format!("{}_chunk_{}_{}.ec", file_id, orig_idx, share_idx);
                    let chunk_path = temp_dir.path().join(&chunk_name);

                    let mut f = fs::File::create(&chunk_path).map_err(|e| e.to_string())?;
                    f.write_all(shard).map_err(|e| e.to_string())?;

                    let cid = upload_to_ipfs(&api_url_cloned, chunk_path.to_str().unwrap())
                        .map_err(|e| e.to_string())?;

                    all_chunk_info.push(ChunkInfo {
                        name: chunk_name.clone(),
                        path: chunk_path.to_string_lossy().to_string(),
                        cid: CidInfo {
                            cid: cid.clone(),
                            filename: chunk_name.clone(),
                            size_bytes: shard.len(),
                            encrypted: true,
                            size_formatted: format_file_size(shard.len()),
                        },
                        original_chunk: orig_idx,
                        share_idx,
                        size: shard.len(),
                    });
                }
            }

            let file_extension = file_path.extension()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();

            let encrypted_size = to_process.len();
            let metadata = Metadata {
                original_file: OriginalFileInfo {
                    name: relative_path.clone(),
                    size: file_size,
                    hash: original_file_hash,
                    extension: file_extension,
                },
                erasure_coding: ErasureCodingInfo {
                    k,
                    m,
                    chunk_size,
                    encrypted: true,
                    file_id: file_id.clone(),
                    encrypted_size,
                },
                chunks: all_chunk_info,
                metadata_cid: None,
            };

            // --- Ensure per-file metadata file ends with .ec_metadata ---
            let meta_filename = if relative_path.ends_with(".ec_metadata") {
                relative_path.clone()
            } else {
                format!("{}.ec_metadata", relative_path)
            };
            let metadata_path = temp_dir.path().join(&meta_filename);
            let metadata_json = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
            fs::write(&metadata_path, metadata_json.as_bytes()).map_err(|e| e.to_string())?;

            let metadata_cid = upload_to_ipfs(
                &api_url_cloned,
                metadata_path.to_str().unwrap(),
            ).map_err(|e| e.to_string())?;

            file_entries.push(FileEntry {
                file_name: relative_path.clone(),
                file_size,
                cid: metadata_cid.clone(),
            });

            // collect for storage request: use meta_filename (with .ec_metadata)
            file_pairs.push((meta_filename, metadata_cid));
        }

        println!("[encrypt_and_upload_folder] ✅ Folder processing done");

        let folder_metadata_path = temp_dir.path().join("folder_metadata.json");
        let folder_metadata = serde_json::to_string_pretty(&file_entries)
            .map_err(|e| e.to_string())?;

        fs::write(&folder_metadata_path, folder_metadata.as_bytes())
            .map_err(|e| e.to_string())?;

        let folder_metadata_cid = upload_to_ipfs(
            &api_url_cloned,
            folder_metadata_path.to_str().unwrap(),
        ).map_err(|e| e.to_string())?;

        Ok::<(String, String, Vec<(String,String)>), String>((folder_name, folder_metadata_cid, file_pairs))
    })
    .await
    .map_err(|e| e.to_string())??;

    // Build files array: folder metadata + per-file metadata
    let mut files_for_storage = Vec::with_capacity(file_pairs.len() + 1);
    let meta_filename = format!("{}{}", folder_name, if folder_name.ends_with("-folder.ec_metadata") { "" } else { "-folder.ec_metadata" });
    files_for_storage.push((meta_filename.clone(), folder_metadata_cid.clone()));
    files_for_storage.extend(file_pairs);
    let storage_result = request_erasure_storage(&meta_filename.clone(), &files_for_storage, api_url, &seed_phrase).await;
    match &storage_result {
        Ok(res) => {
            copy_to_sync_and_add_to_db(Path::new(&folder_path), &account_id,  &folder_metadata_cid, &res, false, true, &meta_filename.clone()).await;
            println!("[encrypt_and_upload_file] : {}", res);
        },
        Err(e) => println!("[encrypt_and_upload_folder] Storage request error: {}", e),
    }

    Ok(folder_metadata_cid)
}

#[tauri::command]
pub async fn list_folder_contents(
    folder_name: String,
    folder_metadata_cid: String,
) -> Result<Vec<FileDetail>, String> {
    let api_url = "http://127.0.0.1:5001";
    let folder_metadata_cid_cloned = folder_metadata_cid.clone(); // Clone for use in closure
    
    // Run the blocking download_from_ipfs in a spawn_blocking task
    let metadata_bytes = tokio::task::spawn_blocking(move || {
        download_from_ipfs(api_url, &folder_metadata_cid_cloned)
            .map_err(|e| format!("Failed to download folder metadata for CID {}: {}", folder_metadata_cid_cloned, e))
    })
    .await
    .map_err(|e| format!("Failed to execute blocking task for CID {}: {}", folder_metadata_cid, e))??;

    // Parse the metadata into Vec<FileEntry>
    let file_entries: Vec<FileEntry> = serde_json::from_slice(&metadata_bytes)
        .map_err(|e| format!("Failed to parse folder metadata for CID {}: {}", folder_metadata_cid, e))?;
    
    // Get database pool
    let pool = DB_POOL.get().ok_or("DB pool not initialized")?;
    
    // For each file from IPFS, look up additional details from the database
    let mut files_in_folder = Vec::new();
    
    for file_entry in file_entries {
        // Query database for additional file details
        let db_row = sqlx::query(
            r#"
            SELECT 
                cid, 
                source, 
                file_hash, 
                miner_ids, 
                created_at, 
                last_charged_at,
                file_size_in_bytes
            FROM user_profiles 
            WHERE file_name = ?
            LIMIT 1
            "#
        )
        .bind(&file_entry.file_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB query failed for file {}: {}", file_entry.file_name, e))?;

        let file_detail = if let Some(row) = db_row {
            // File found in database, use DB data
            FileDetail {
                file_name: file_entry.file_name,
                cid: row.get::<Option<String>, _>("cid").unwrap_or(file_entry.cid),
                source: row.get::<Option<String>, _>("source").unwrap_or_default(),
                file_hash: row.get::<Option<String>, _>("file_hash").unwrap_or_default(),
                miner_ids: row.get::<Option<String>, _>("miner_ids").unwrap_or_default(),
                file_size: row.get::<Option<i64>, _>("file_size_in_bytes")
                    .map(|size| size as usize)
                    .unwrap_or(file_entry.file_size),
                created_at: row.get::<Option<i64>, _>("created_at").unwrap_or(0).to_string(),
                last_charged_at: row.get::<Option<i64>, _>("last_charged_at").unwrap_or(0).to_string(),
            }
        } else {
            // File not found in database, use IPFS data with defaults
            FileDetail {
                file_name: file_entry.file_name,
                cid: file_entry.cid,
                source: String::new(),
                file_hash: String::new(),
                miner_ids: String::new(),
                file_size: file_entry.file_size,
                created_at: 0.to_string(),
                last_charged_at: 0.to_string(),
            }
        };
        
        // Sanitize file_name for UI/consumer
        let mut file_detail = file_detail;
        file_detail.file_name = if file_detail.file_name.ends_with("-folder.ec_metadata") {
            file_detail.file_name.trim_end_matches("-folder.ec_metadata").to_string()
        } else if file_detail.file_name.ends_with("-folder") {
            file_detail.file_name.trim_end_matches("-folder").to_string()
        } else if file_detail.file_name.ends_with(".ec_metadata") {
            file_detail.file_name.trim_end_matches(".ec_metadata").to_string()
        } else {
            file_detail.file_name
        };
        files_in_folder.push(file_detail);
    }

    Ok(files_in_folder)
}

#[tauri::command]
pub async fn download_and_decrypt_folder(
    account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    output_dir: String,
    encryption_key: Option<String>,
) -> Result<(), String> {
    let api_url = "http://127.0.0.1:5001";
    let folder_metadata_cid_cloned = folder_metadata_cid.clone(); // Clone for use in closure

    // Run the blocking download_from_ipfs in a spawn_blocking task
    let metadata_bytes = tokio::task::spawn_blocking(move || {
        download_from_ipfs(api_url, &folder_metadata_cid_cloned)
            .map_err(|e| format!("Failed to download folder metadata for CID {}: {}", folder_metadata_cid_cloned, e))
    })
    .await
    .map_err(|e| format!("Failed to execute blocking task for CID {}: {}", folder_metadata_cid, e))??;

    // Parse the metadata into Vec<FileEntry>
    let file_entries: Vec<FileEntry> = serde_json::from_slice(&metadata_bytes)
        .map_err(|e| format!("Failed to parse folder metadata for CID {}: {}", folder_metadata_cid, e))?;

    // Create the output directory with the provided folder name
    let output_path = std::path::Path::new(&output_dir).join(&folder_name);
    if !output_path.exists() {
        fs::create_dir_all(&output_path)
            .map_err(|e| format!("Failed to create output directory {}: {}", output_path.display(), e))?;
    }

    for entry in file_entries {
        let output_file_path = output_path.join(&entry.file_name);
        if let Some(parent) = output_file_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent directory {}: {}", parent.display(), e))?;
        }
        download_and_decrypt_file(account_id.clone(), entry.cid, output_file_path.to_string_lossy().to_string(), encryption_key.clone()).await?;
    }

    Ok(())
}

#[tauri::command]
pub async fn public_upload_folder(
    account_id: String,
    folder_path: String,
    seed_phrase: String,
) -> Result<String, String> {
    let api_url = "http://127.0.0.1:5001";
    
    let folder_path = Path::new(&folder_path);
    if !folder_path.is_dir() {
        return Err("Provided path is not a directory".to_string());
    }

    let folder_name = folder_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "Invalid folder path, cannot extract folder name".to_string())?;

    // Check if folder already exists in DB
    if let Some(pool) = DB_POOL.get() {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1"
        )
        .bind(&account_id)
        .bind(&folder_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error: {e}"))?;
        if row.is_some() {
            return Err(format!("Folder '{}' already exists for this user.", folder_name));
        }
    }

    // Clone data for thread-safe async block
    let folder_path_cloned = folder_path.to_path_buf();
    let api_url_cloned = api_url.to_string();
    let account_id_cloned = account_id.clone();
    let (folder_name, folder_metadata_cid) = tokio::task::spawn_blocking(move || {
        let mut file_entries = Vec::new();
        let mut files = Vec::new();
        let _ = collect_files_recursively(&folder_path_cloned, &mut files);

        let temp_dir = tempdir().map_err(|e| e.to_string())?;

        for file_path in files {
            let relative_path = file_path.strip_prefix(&folder_path_cloned)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .to_string();

            let file_data = fs::read(&file_path).map_err(|e| e.to_string())?;
            let file_size = file_data.len();

            // Hash original file
            let mut hasher = Sha256::new();
            hasher.update(&file_data);
            let original_file_hash = format!("{:x}", hasher.finalize());

            // Upload file directly to IPFS (no encryption)
            let file_cid = upload_to_ipfs(&api_url_cloned, file_path.to_str().unwrap())
                .map_err(|e| e.to_string())?;

            file_entries.push(FileEntry {
                file_name: relative_path.clone(),
                file_size,
                cid: file_cid.clone(),
            });
        }

        println!("[public_upload_folder] ✅ Folder processing done");

        let folder_metadata_path = temp_dir.path().join("folder_metadata.json");
        let folder_metadata = serde_json::to_string_pretty(&file_entries)
            .map_err(|e| e.to_string())?;

        fs::write(&folder_metadata_path, folder_metadata.as_bytes())
            .map_err(|e| e.to_string())?;

        let folder_metadata_cid = upload_to_ipfs(
            &api_url_cloned,
            folder_metadata_path.to_str().unwrap(),
        ).map_err(|e| e.to_string())?;

        Ok::<(String, String), String>((folder_name, folder_metadata_cid))
    })
    .await
    .map_err(|e| e.to_string())??;

    let meta_folder_name = format!("{}{}", folder_name, if folder_name.ends_with("-folder") { "" } else { "-folder" });
    // Submit storage request
    let storage_result = request_file_storage(&meta_folder_name.clone(), &folder_metadata_cid, api_url, &seed_phrase).await;
    match &storage_result {
        Ok(res) => {
            copy_to_sync_and_add_to_db(Path::new(&folder_path), &account_id, &folder_metadata_cid, &res, true, true, &meta_folder_name.clone()).await;
            println!("[public_upload_folder] Storage request result: {}", res);
        },
        Err(e) => println!("[public_upload_folder] Storage request error: {}", e),
    }

    Ok(folder_metadata_cid)
}

#[tauri::command]
pub async fn public_download_folder(
    account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    output_dir: String,
) -> Result<(), String> {
    let api_url = "http://127.0.0.1:5001";
    let folder_metadata_cid_cloned = folder_metadata_cid.clone();

    // Download folder metadata
    let metadata_bytes = tokio::task::spawn_blocking(move || {
        download_from_ipfs(api_url, &folder_metadata_cid_cloned)
            .map_err(|e| format!("Failed to download folder metadata for CID {}: {}", folder_metadata_cid_cloned, e))
    })
    .await
    .map_err(|e| format!("Failed to execute blocking task for CID {}: {}", folder_metadata_cid, e))??;

    // Parse the metadata into Vec<FileEntry>
    let file_entries: Vec<FileEntry> = serde_json::from_slice(&metadata_bytes)
        .map_err(|e| format!("Failed to parse folder metadata for CID {}: {}", folder_metadata_cid, e))?;

    // Create the output directory with the provided folder name
    let output_path = std::path::Path::new(&output_dir).join(&folder_name);
    if !output_path.exists() {
        fs::create_dir_all(&output_path)
            .map_err(|e| format!("Failed to create output directory {}: {}", output_path.display(), e))?;
    }

    // Download each file
    for entry in file_entries {
        let output_file_path = output_path.join(&entry.file_name);
        if let Some(parent) = output_file_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent directory {}: {}", parent.display(), e))?;
        }
        download_file_public(entry.cid, output_file_path.to_string_lossy().to_string()).await?;
    }

    Ok(())
}

#[tauri::command]
pub async fn add_file_to_public_folder(
    account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    file_path: String,
    seed_phrase: String,
) -> Result<String, String> {
    let api_url = "http://127.0.0.1:5001";
    let file_path_obj = Path::new(&file_path);

    // Extract file name
    let file_name = file_path_obj
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "Invalid file path, cannot extract file name".to_string())?;

    // Check if file already exists
    let file_entries = list_folder_contents(folder_name.clone(), folder_metadata_cid.clone()).await?;
    if file_entries.iter().any(|entry| entry.file_name == file_name) {
        return Err(format!("File '{}' already exists in folder '{}'.", file_name, folder_name));
    }

    // Download existing folder metadata
    let metadata_bytes = tokio::task::spawn_blocking({
        let api_url = api_url.to_string();
        let folder_metadata_cid_clone = folder_metadata_cid.clone();
        move || {
            download_from_ipfs(&api_url, &folder_metadata_cid_clone)
                .map_err(|e| format!("Failed to download folder metadata for CID {}: {}", folder_metadata_cid_clone, e))
        }
    })
    .await
    .map_err(|e| format!("Failed to execute blocking task for CID {}: {}", folder_metadata_cid, e))??;

    let mut file_entries: Vec<FileEntry> = serde_json::from_slice(&metadata_bytes)
        .map_err(|e| format!("Failed to parse folder metadata for CID {}: {}", folder_metadata_cid, e))?;

    // Process the new file and update metadata in a single blocking task
    let (new_file_entry, new_file_pairs, new_folder_metadata_cid) = tokio::task::spawn_blocking({
        let api_url = api_url.to_string();
        let file_path_cloned = file_path.clone();
        let file_name_cloned = file_name.clone();
        move || {
            // Create temporary directory inside the blocking task
            let temp_dir = tempdir().map_err(|e| format!("Failed to create temporary directory: {}", e))?;
            let temp_dir_path = temp_dir.path().to_path_buf();

            // Read and upload the new file
            let file_data = fs::read(&file_path_cloned).map_err(|e| format!("Failed to read file {}: {}", file_path_cloned, e))?;
            let file_size = file_data.len();

            // Hash the file (for consistency, though unused)
            let _original_file_hash = {
                let mut hasher = Sha256::new();
                hasher.update(&file_data);
                format!("{:x}", hasher.finalize())
            };

            let file_cid = upload_to_ipfs(&api_url, &file_path_cloned)
                .map_err(|e| format!("Failed to upload file to IPFS: {}", e))?;
            let new_file_entry = FileEntry {
                file_name: file_name_cloned.clone(),
                file_size,
                cid: file_cid.clone(),
            };
            let files_for_storage = vec![(file_name_cloned.clone(), file_cid.clone())];

            // Update folder metadata
            file_entries.push(new_file_entry.clone());
            let folder_metadata_path = temp_dir_path.join("folder_metadata.json");
            let folder_metadata = serde_json::to_string_pretty(&file_entries)
                .map_err(|e| format!("Failed to serialize folder metadata: {}", e))?;
            fs::write(&folder_metadata_path, folder_metadata.as_bytes())
                .map_err(|e| format!("Failed to write folder metadata to {}: {}", folder_metadata_path.display(), e))?;

            let new_folder_metadata_cid = upload_to_ipfs(&api_url, folder_metadata_path.to_str().unwrap())
                .map_err(|e| format!("Failed to upload folder metadata to IPFS: {}", e))?;

            // Temporary directory is automatically cleaned up when temp_dir goes out of scope
            Ok::<_, String>((new_file_entry, files_for_storage, new_folder_metadata_cid))
        }
    })
    .await
    .map_err(|e| format!("Failed to execute blocking task for file upload: {}", e))??;

    // Prepare storage request
    let meta_filename = format!("{}{}", folder_name, if folder_name.ends_with("-folder") { "" } else { "-folder" });
    let mut files_for_storage = vec![(meta_filename.clone(), new_folder_metadata_cid.clone())];
    files_for_storage.extend(new_file_pairs);

    // Get the sync folder path
    let sync_folder = PathBuf::from(get_public_sync_path().await);
    let dest_path = sync_folder.join(&folder_name);

    // Submit storage request, handle RequestAlreadyExists
    println!("[add_file_to_public_folder] Submitting storage request for updated folder metadata: {}", meta_filename);
    let storage_result = request_file_storage(&meta_filename, &new_folder_metadata_cid, api_url, &seed_phrase).await
        .map_err(|e| {
            if e.contains("RequestAlreadyExists") {
                format!("Storage request already exists for folder '{}'. Please try again later or update the existing request.", folder_name)
            } else {
                format!("Failed to request file storage: {}", e)
            }
        })?;


    // Update the database with the new folder metadata
    copy_to_sync_folder(
        &file_path_obj, // Pass the original file path
        &folder_name, // Pass the folder name
        &account_id,
        &new_folder_metadata_cid,
        &storage_result,
        true,
        false, // This is a file, not a folder
        &file_name, // Use the actual file name
    ).await;

    println!("[add_file_to_public_folder] Storage request result: {}", storage_result);
    println!("[add_file_to_public_folder] New folder metadata CID: {}", new_folder_metadata_cid);

    Ok(new_folder_metadata_cid)
}

#[tauri::command]
pub async fn remove_file_from_public_folder(
    account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    file_name: String,
    seed_phrase: String,
) -> Result<String, String> {
    let api_url = "http://127.0.0.1:5001";
    let folder_metadata_cid_for_log = folder_metadata_cid.clone();

    // Download existing folder metadata
    let metadata_bytes = tokio::task::spawn_blocking({
        let api_url = api_url.to_string();
        let folder_metadata_cid_cloned = folder_metadata_cid.clone();
        move || {
            download_from_ipfs(&api_url, &folder_metadata_cid_cloned)
                .map_err(|e| format!("Failed to download folder metadata for CID {}: {}", folder_metadata_cid_cloned, e))
        }
    })
    .await
    .map_err(|e| format!("Failed to execute blocking task for CID {}: {}", folder_metadata_cid_for_log, e))??;

    let mut file_entries: Vec<FileEntry> = serde_json::from_slice(&metadata_bytes)
        .map_err(|e| format!("Failed to parse folder metadata for CID {}: {}", folder_metadata_cid, e))?;

    // Remove the file entry
    let initial_len = file_entries.len();
    file_entries.retain(|entry| entry.file_name != file_name);
    if file_entries.len() == initial_len {
        return Err(format!("File '{}' not found in folder '{}'.", file_name, folder_name));
    }

    // Process metadata update in a single blocking task
    let new_folder_metadata_cid = tokio::task::spawn_blocking({
        let api_url = api_url.to_string();
        move || {
            // Create temporary directory inside the blocking task
            let temp_dir = tempdir().map_err(|e| format!("Failed to create temporary directory: {}", e))?;
            let temp_dir_path = temp_dir.path().to_path_buf();

            // Update folder metadata
            let folder_metadata_path = temp_dir_path.join("folder_metadata.json");
            let folder_metadata = serde_json::to_string_pretty(&file_entries)
                .map_err(|e| format!("Failed to serialize folder metadata: {}", e))?;
            fs::write(&folder_metadata_path, folder_metadata.as_bytes())
                .map_err(|e| format!("Failed to write folder metadata to {}: {}", folder_metadata_path.display(), e))?;

            let new_folder_metadata_cid = upload_to_ipfs(&api_url, folder_metadata_path.to_str().unwrap())
                .map_err(|e| format!("Failed to upload folder metadata to IPFS: {}", e))?;

            // Temporary directory is automatically cleaned up when temp_dir goes out of scope
            Ok::<_, String>(new_folder_metadata_cid)
        }
    })
    .await
    .map_err(|e| format!("Failed to execute blocking task for metadata update: {}", e))??;

    // Prepare storage request
    let meta_filename = format!("{}{}", folder_name, if folder_name.ends_with("-folder") { "" } else { "-folder" });

    // Get the sync folder path
    let sync_folder = PathBuf::from(get_public_sync_path().await);
    let dest_path = sync_folder.join(&folder_name);

    // Update database to remove file
    if let Some(pool) = DB_POOL.get() {
        sqlx::query("DELETE FROM user_profiles WHERE owner = ? AND file_name = ?")
            .bind(&account_id)
            .bind(&file_name)
            .execute(pool)
            .await
            .map_err(|e| format!("DB error: {}", e))?;
    }

    // Remove the file from the sync directory
    let file_path = dest_path.join(&file_name);
    if file_path.exists() {
        fs::remove_file(&file_path)
            .map_err(|e| format!("Failed to remove file from sync directory {}: {}", file_path.display(), e))?;
    }

    // Submit storage request, handle RequestAlreadyExists
    println!(
        "[remove_file_from_public_folder] Submitting storage request for updated folder metadata: {}",
        meta_filename
    );
    let storage_result = request_file_storage(&meta_filename, &new_folder_metadata_cid, api_url, &seed_phrase).await
        .map_err(|e| {
            if e.contains("RequestAlreadyExists") {
                format!("Storage request already exists for folder '{}'. Please try again later or update the existing request.", folder_name)
            } else {
                format!("Failed to request file storage: {}", e)
            }
        })?;

    // Update database to remove file and remove the file from the sync directory
    remove_from_sync_folder(&file_name, &folder_name, true, false).await;

    println!("[remove_file_from_public_folder] Storage request result: {}", storage_result);
    println!(
        "[remove_file_from_public_folder] New folder metadata CID: {}",
        new_folder_metadata_cid
    );

    Ok(new_folder_metadata_cid)
}

#[tauri::command]
pub async fn add_file_to_private_folder(
    account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    file_path: String,
    seed_phrase: String,
    encryption_key: Option<Vec<u8>>,
) -> Result<String, String> {
    use std::path::Path;
    let api_url = "http://127.0.0.1:5001";
    let file_path_obj = Path::new(&file_path);

    // Extract file name
    let file_name = file_path_obj
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "Invalid file path, cannot extract file name".to_string())?;

    // Check if file already exists in folder
    let file_entries = list_folder_contents(folder_name.clone(), folder_metadata_cid.clone()).await?;
    if file_entries.iter().any(|entry| entry.file_name == file_name) {
        return Err(format!("File '{}' already exists in folder '{}'.", file_name, folder_name));
    }

    // Download and parse folder metadata
    let metadata_bytes = tokio::task::spawn_blocking({
        let api_url = api_url.to_string();
        let folder_metadata_cid_clone = folder_metadata_cid.clone();
        move || {
            download_from_ipfs(&api_url, &folder_metadata_cid_clone)
                .map_err(|e| format!("Failed to download folder metadata for CID {}: {}", folder_metadata_cid_clone, e))
        }
    })
    .await
    .map_err(|e| format!("Failed to execute blocking task for CID {}: {}", folder_metadata_cid, e))??;

    let mut file_entries: Vec<FileEntry> = serde_json::from_slice(&metadata_bytes)
        .map_err(|e| format!("Failed to parse folder metadata for CID {}: {}", folder_metadata_cid, e))?;

    // Encrypt, erasure-code, and upload the file, and create .ec_metadata
    let (new_file_entry, file_meta_pair) = tokio::task::spawn_blocking({
        let api_url = api_url.to_string();
        let file_path_cloned = file_path.clone();
        let file_name_cloned = file_name.clone();
        let encryption_key_cloned = encryption_key.clone();
        move || {
            let temp_dir = tempfile::tempdir().map_err(|e| format!("Failed to create temp dir: {}", e))?;
            let file_data = std::fs::read(&file_path_cloned).map_err(|e| format!("Failed to read file: {}", e))?;
            let file_size = file_data.len();

            // Hash original file
            let mut hasher = sha2::Sha256::new();
            hasher.update(&file_data);
            let original_file_hash = format!("{:x}", hasher.finalize());

            // Encrypt
            let to_process = tauri::async_runtime::block_on(crate::utils::accounts::encrypt_file(&file_data, encryption_key_cloned))?;

            // Erasure coding
            let k = DEFAULT_K;
            let m = DEFAULT_M;
            let chunk_size = DEFAULT_CHUNK_SIZE;
            let mut chunks = vec![];
            for i in (0..to_process.len()).step_by(chunk_size) {
                let mut chunk = to_process[i..std::cmp::min(i + chunk_size, to_process.len())].to_vec();
                if chunk.len() < chunk_size {
                    chunk.resize(chunk_size, 0);
                }
                chunks.push(chunk);
            }
            let r = reed_solomon_erasure::galois_8::ReedSolomon::new(k, m - k).map_err(|e| format!("ReedSolomon error: {e}"))?;
            let mut all_chunk_info = vec![];
            let file_id = uuid::Uuid::new_v4().to_string();
            for (orig_idx, chunk) in chunks.iter().enumerate() {
                let sub_block_size = (chunk.len() + k - 1) / k;
                let sub_blocks: Vec<Vec<u8>> = (0..k).map(|j| {
                    let start = j * sub_block_size;
                    let end = std::cmp::min(start + sub_block_size, chunk.len());
                    let mut sub_block = chunk[start..end].to_vec();
                    if sub_block.len() < sub_block_size {
                        sub_block.resize(sub_block_size, 0);
                    }
                    sub_block
                }).collect();
                let mut shards: Vec<Option<Vec<u8>>> = sub_blocks.into_iter().map(Some).collect();
                for _ in k..m {
                    shards.push(Some(vec![0u8; sub_block_size]));
                }
                let mut shard_refs: Vec<_> = shards.iter_mut().map(|x| x.as_mut().unwrap().as_mut_slice()).collect();
                r.encode(&mut shard_refs).map_err(|e| format!("ReedSolomon encode error: {e}"))?;
                for (share_idx, shard) in shard_refs.iter().enumerate() {
                    let chunk_name = format!("{}_chunk_{}_{}.ec", file_id, orig_idx, share_idx);
                    let chunk_path = temp_dir.path().join(&chunk_name);
                    let mut f = std::fs::File::create(&chunk_path).map_err(|e| e.to_string())?;
                    f.write_all(shard).map_err(|e| e.to_string())?;
                    let cid = crate::utils::ipfs::upload_to_ipfs(&api_url, chunk_path.to_str().unwrap()).map_err(|e| e.to_string())?;
                    all_chunk_info.push(crate::commands::types::ChunkInfo {
                        name: chunk_name.clone(),
                        path: chunk_path.to_string_lossy().to_string(),
                        cid: crate::commands::types::CidInfo {
                            cid: cid.clone(),
                            filename: chunk_name.clone(),
                            size_bytes: shard.len(),
                            encrypted: true,
                            size_formatted: crate::commands::ipfs_commands::format_file_size(shard.len()),
                        },
                        original_chunk: orig_idx,
                        share_idx,
                        size: shard.len(),
                    });
                }
            }
            let file_extension = std::path::Path::new(&file_path_cloned).extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let encrypted_size = to_process.len();
            let metadata = crate::commands::types::Metadata {
                original_file: crate::commands::types::OriginalFileInfo {
                    name: file_name_cloned.clone(),
                    size: file_size,
                    hash: original_file_hash,
                    extension: file_extension,
                },
                erasure_coding: crate::commands::types::ErasureCodingInfo {
                    k,
                    m,
                    chunk_size,
                    encrypted: true,
                    file_id: file_id.clone(),
                    encrypted_size,
                },
                chunks: all_chunk_info,
                metadata_cid: None,
            };
            // Write metadata to temp file
            let meta_filename = if file_name_cloned.ends_with(".ec_metadata") {
                file_name_cloned.clone()
            } else {
                format!("{}.ec_metadata", file_name_cloned)
            };
            let metadata_path = temp_dir.path().join(&meta_filename);
            let metadata_json = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
            std::fs::write(&metadata_path, metadata_json.as_bytes()).map_err(|e| e.to_string())?;
            let metadata_cid = crate::utils::ipfs::upload_to_ipfs(&api_url, metadata_path.to_str().unwrap()).map_err(|e| e.to_string())?;
            let file_entry = crate::commands::types::FileEntry {
                file_name: meta_filename.clone(), 
                file_size,
                cid: metadata_cid.clone(),
            };
            Ok::<_, String>((file_entry, (meta_filename, metadata_cid)))
        }
    })
    .await
    .map_err(|e| format!("Failed to execute blocking task for file upload: {}", e))??;

    // Update folder metadata
    file_entries.push(new_file_entry);
    let (new_folder_metadata_cid, files_for_storage) = tokio::task::spawn_blocking({
        let api_url = api_url.to_string();
        let file_meta_pair = file_meta_pair.clone();
        let file_entries = file_entries.clone();
        let folder_name = folder_name.clone();
        move || {
            let temp_dir = tempfile::tempdir().map_err(|e| format!("Failed to create temp dir: {}", e))?;
            let folder_metadata_path = temp_dir.path().join("folder_metadata.json");
            let folder_metadata = serde_json::to_string_pretty(&file_entries).map_err(|e| e.to_string())?;
            std::fs::write(&folder_metadata_path, folder_metadata.as_bytes()).map_err(|e| e.to_string())?;
            let folder_metadata_cid = crate::utils::ipfs::upload_to_ipfs(&api_url, folder_metadata_path.to_str().unwrap()).map_err(|e| e.to_string())?;
            // Build files_for_storage: folder metadata + file metadata
            let meta_filename = format!("{}{}", folder_name, if folder_name.ends_with("-folder.ec_metadata") { "" } else { "-folder.ec_metadata" });
            let mut files_for_storage = vec![(meta_filename, folder_metadata_cid.clone()), file_meta_pair];
            Ok::<_, String>((folder_metadata_cid, files_for_storage))
        }
    })
    .await
    .map_err(|e| format!("Failed to execute blocking task for folder metadata update: {}", e))??;

    // Submit storage request
    let meta_filename = format!("{}{}", folder_name, if folder_name.ends_with("-folder.ec_metadata") { "" } else { "-folder.ec_metadata" });
    let storage_result = request_erasure_storage(&meta_filename, &files_for_storage, api_url, &seed_phrase).await
        .map_err(|e| {
            if e.contains("RequestAlreadyExists") {
                format!("Storage request already exists for folder '{}'. Please try again later or update the existing request.", folder_name)
            } else {
                format!("Failed to request file storage: {}", e)
            }
        })?;

    // Sanitize folder_name for local sync folder usage
    let sanitized_folder_name = if folder_name.ends_with("-folder.ec_metadata") {
        folder_name.trim_end_matches("-folder.ec_metadata").to_string()
    } else if folder_name.ends_with("-folder") {
        folder_name.trim_end_matches("-folder").to_string()
    } else {
        folder_name.clone()
    };

    // Sanitize file_name for local sync file usage
    let sanitized_file_name = if file_name.ends_with(".ec_metadata") {
        file_name.trim_end_matches(".ec_metadata").to_string()
    } else {
        file_name.clone()
    };
    // Update the database and sync folder
    copy_to_sync_folder(
        file_path_obj,
        &sanitized_folder_name,
        &account_id,
        &new_folder_metadata_cid,
        &storage_result,
        false,
        false,
        &sanitized_file_name,
    ).await;

    Ok(new_folder_metadata_cid)
}

#[tauri::command]
pub async fn remove_file_from_private_folder(
    account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    file_name: String,
    seed_phrase: String,
) -> Result<String, String> {
    let api_url = "http://127.0.0.1:5001";
    let folder_metadata_cid_for_log = folder_metadata_cid.clone();

    // Download and parse folder metadata
    let metadata_bytes = tokio::task::spawn_blocking({
        let api_url = api_url.to_string();
        let folder_metadata_cid_cloned = folder_metadata_cid.clone();
        move || {
            download_from_ipfs(&api_url, &folder_metadata_cid_cloned)
                .map_err(|e| format!("Failed to download folder metadata for CID {}: {}", folder_metadata_cid_cloned, e))
        }
    })
    .await
    .map_err(|e| format!("Failed to execute blocking task for CID {}: {}", folder_metadata_cid_for_log, e))??;

    let mut file_entries: Vec<FileEntry> = serde_json::from_slice(&metadata_bytes)
        .map_err(|e| format!("Failed to parse folder metadata for CID {}: {}", folder_metadata_cid, e))?;

    // Remove the file entry
    let initial_len = file_entries.len();
    file_entries.retain(|entry| entry.file_name != file_name);
    if file_entries.len() == initial_len {
        return Err(format!("File '{}' not found in folder '{}'.", file_name, folder_name));
    }

    // Update folder metadata and upload
    let new_folder_metadata_cid = tokio::task::spawn_blocking({
        let api_url = api_url.to_string();
        let file_entries = file_entries.clone();
        move || {
            let temp_dir = tempfile::tempdir().map_err(|e| format!("Failed to create temp dir: {}", e))?;
            let folder_metadata_path = temp_dir.path().join("folder_metadata.json");
            let folder_metadata = serde_json::to_string_pretty(&file_entries).map_err(|e| e.to_string())?;
            std::fs::write(&folder_metadata_path, folder_metadata.as_bytes()).map_err(|e| e.to_string())?;
            let folder_metadata_cid = crate::utils::ipfs::upload_to_ipfs(&api_url, folder_metadata_path.to_str().unwrap()).map_err(|e| e.to_string())?;
            Ok::<_, String>(folder_metadata_cid)
        }
    })
    .await
    .map_err(|e| format!("Failed to execute blocking task for metadata update: {}", e))??;

    // Prepare storage request
    let meta_filename = format!("{}{}", folder_name, if folder_name.ends_with("-folder.ec_metadata") { "" } else { "-folder.ec_metadata" });
    let storage_result = request_erasure_storage(&meta_filename, &vec![(meta_filename.clone(), new_folder_metadata_cid.clone())], api_url, &seed_phrase).await
        .map_err(|e| {
            if e.contains("RequestAlreadyExists") {
                format!("Storage request already exists for folder '{}'. Please try again later or update the existing request.", folder_name)
            } else {
                format!("Failed to request file storage: {}", e)
            }
        })?;
    // Sanitize folder_name for local sync folder usage
    let sanitized_folder_name = if folder_name.ends_with("-folder.ec_metadata") {
        folder_name.trim_end_matches("-folder.ec_metadata").to_string()
    } else if folder_name.ends_with("-folder") {
        folder_name.trim_end_matches("-folder").to_string()
    } else {
        folder_name.clone()
    };

    // Sanitize file_name for local sync file usage
    let sanitized_file_name = if file_name.ends_with(".ec_metadata") {
        file_name.trim_end_matches(".ec_metadata").to_string()
    } else {
        file_name.clone()
    };
    // Remove the file from the sync directory and DB
    remove_from_sync_folder(&file_name, &folder_name, false, false).await;

    Ok(new_folder_metadata_cid)
}