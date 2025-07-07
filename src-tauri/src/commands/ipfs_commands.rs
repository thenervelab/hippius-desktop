use crate::utils::{
    accounts::{
        encrypt_file_for_account, decrypt_file_for_account
    },
    ipfs::{
        download_from_ipfs,upload_to_ipfs
    },
    file_operations::request_file_storage
};
use uuid::Uuid;
use std::fs;
use reed_solomon_erasure::galois_8::ReedSolomon;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sodiumoxide::crypto::secretbox;
use std::io::{Read, Write};
use std::path::PathBuf;
use tempfile::tempdir;
use crate::DB_POOL;
use crate::commands::types::*;

#[tauri::command]
pub async fn encrypt_and_upload_file(
    account_id: String,
    file_path: String,
    api_url: String,
    k: Option<usize>,
    m: Option<usize>,
    chunk_size: Option<usize>,
    seed_phrase: String
) -> Result<String, String> {
    use std::path::Path;

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

    let k = k.unwrap_or(DEFAULT_K);
    let m = m.unwrap_or(DEFAULT_M);
    let chunk_size = chunk_size.unwrap_or(DEFAULT_CHUNK_SIZE);
    let file_path_cloned = file_path.clone();
    let api_url_cloned = api_url.clone();
    // Run blocking work and return file_name and metadata_cid
    let (file_name, metadata_cid) = tokio::task::spawn_blocking(move || {
        // Read file
        let file_data = fs::read(&file_path_cloned).map_err(|e| e.to_string())?;
        // Calculate original file hash
        let mut hasher = Sha256::new();
        hasher.update(&file_data);
        let _original_file_hash = format!("{:x}", hasher.finalize());

        // Encrypt using centralized function
        let to_process = encrypt_file_for_account(&account_id, &file_data)?;
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
                hash: String::new(), // Not used here
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
    println!("[encrypt_and_upload_file] Metadata CID: {}", metadata_cid);

    // Call request_file_storage and log its returned CID
    let storage_result = request_file_storage(&file_name, &metadata_cid, &api_url, &seed_phrase).await;
    match &storage_result {
        Ok(cid) => println!("[encrypt_and_upload_file] Storage request CID: {}", cid),
        Err(e) => println!("[encrypt_and_upload_file] Storage request error: {}", e),
    }
    storage_result
}

#[tauri::command]
pub async fn download_and_decrypt_file(
    account_id: String,
    metadata_cid: String,
    api_url: String,
    output_file: String,
) -> Result<(), String> {
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
        let decrypted_data = decrypt_file_for_account(&account_id, &encrypted_data)?;
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
