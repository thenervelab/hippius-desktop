use crate::utils::{
    accounts::{
        encrypt_file, decrypt_file
    },
    ipfs::{
        download_from_ipfs,upload_to_ipfs
    },
    file_operations::{request_file_storage, copy_to_sync_and_add_to_db}
};
use uuid::Uuid;
use std::fs;
use reed_solomon_erasure::galois_8::ReedSolomon;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::PathBuf;
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

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub file_name: String,
    pub file_size: usize,
    pub cid: String,
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
    // Run blocking work and return file_name and metadata_cid
    let (file_name, metadata_cid) = tokio::task::spawn_blocking(move || {
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
                    name: chunk_name,
                    cid,
                    original_chunk: orig_idx,
                    share_idx,
                    size: shard.len(),
                });
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
        Ok::<(String, String), String>((file_name, metadata_cid))
    })
    .await
    .map_err(|e| e.to_string())??;

    // Log the metadata CID
    println!(" Metadata CID: {}", metadata_cid);

    // Call request_file_storage and log its returned CID
    let storage_result = request_file_storage(&file_name, &metadata_cid, api_url, &seed_phrase).await;
    match &storage_result {
        Ok(res) => {
            copy_to_sync_and_add_to_db(Path::new(&file_path), &account_id,  &metadata_cid, &res, false, false).await;
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
                let data = download_from_ipfs(&api_url, &chunk.cid).map_err(|e| e.to_string())?;
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
        println!("Decrypted data: {}", decrypted_data.len());
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
    let storage_result = request_file_storage(&file_name, &file_cid, api_url, &seed_phrase).await;
    match &storage_result {
        Ok(res) => {
            copy_to_sync_and_add_to_db(Path::new(&file_path), &account_id, &file_cid, &res, true, false).await;
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
    // Run blocking work and return file_name and metadata_cid
    let (file_name, metadata_cid) = tokio::task::spawn_blocking(move || {
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
                    name: chunk_name,
                    cid,
                    original_chunk: orig_idx,
                    share_idx,
                    size: shard.len(),
                });
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
        Ok::<(String, String), String>((file_name, metadata_cid))
    })
    .await
    .map_err(|e| e.to_string())??;

    // Log the metadata CID
    println!("[upload_file_no_encrypt] Metadata CID: {}", metadata_cid);

    // Call request_file_storage and log its returned CID
    let storage_result = request_file_storage(&file_name, &metadata_cid, api_url, &seed_phrase).await;
    match &storage_result {
        Ok(res) => {
            copy_to_sync_and_add_to_db(Path::new(&file_path), &account_id,  &metadata_cid, &res, true, false).await;
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
                let data = download_from_ipfs(&api_url, &chunk.cid).map_err(|e| e.to_string())?;
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
    use std::path::Path;
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
    let (folder_name, folder_metadata_cid) = tokio::task::spawn_blocking(move || {
        let mut file_entries = Vec::new();
        let mut files = Vec::new();
        collect_files_recursively(&folder_path_cloned, &mut files);

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
                        name: chunk_name,
                        cid,
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

            let metadata_path = temp_dir.path().join(format!("{}_metadata.json", file_id));
            let metadata_json = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
            fs::write(&metadata_path, metadata_json.as_bytes()).map_err(|e| e.to_string())?;

            let metadata_cid = upload_to_ipfs(&api_url_cloned, metadata_path.to_str().unwrap())
                .map_err(|e| e.to_string())?;

            file_entries.push(FileEntry {
                file_name: relative_path,
                file_size,
                cid: metadata_cid,
            });
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

        Ok::<(String, String), String>((folder_name, folder_metadata_cid))
    })
    .await
    .map_err(|e| e.to_string())??;

    // Submit storage request
    let storage_result = request_file_storage(&folder_name, &folder_metadata_cid, api_url, &seed_phrase).await;
    match &storage_result {
        Ok(res) => {
            copy_to_sync_and_add_to_db(Path::new(&folder_path), &account_id,  &folder_metadata_cid, &res, false, true).await;
            println!("[encrypt_and_upload_file] : {}", res);
        },
        Err(e) => println!("[encrypt_and_upload_folder] Storage request error: {}", e),
    }

    Ok(folder_metadata_cid)
}

#[tauri::command]
pub async fn list_folder_contents(
    folder_metadata_cid: String
) -> Result<Vec<FileEntry>, String> {
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
    
    Ok(file_entries)
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
        collect_files_recursively(&folder_path_cloned, &mut files);

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
                file_name: relative_path,
                file_size,
                cid: file_cid,
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

    // Submit storage request
    let storage_result = request_file_storage(&folder_name, &folder_metadata_cid, api_url, &seed_phrase).await;
    match &storage_result {
        Ok(res) => {
            println!("is puiblic folder upload");
            copy_to_sync_and_add_to_db(Path::new(&folder_path), &account_id, &folder_metadata_cid, &res, true, true).await;
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