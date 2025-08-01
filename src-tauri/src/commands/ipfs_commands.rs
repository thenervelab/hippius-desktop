use crate::utils::{
    accounts::{
        encrypt_file, decrypt_file
    },
    ipfs::{
        download_from_ipfs, download_from_ipfs_async, upload_to_ipfs, upload_bytes_to_ipfs,
    },
    file_operations::{request_erasure_storage, copy_to_sync_and_add_to_db, request_folder_storage, get_file_name_variations,
        request_file_storage , remove_from_sync_folder, copy_to_sync_folder, delete_and_unpin_user_file_records_from_folder}
};
use uuid::Uuid;
use std::fs;
use reed_solomon_erasure::galois_8::ReedSolomon;
use sha2::{Digest, Sha256};
use tempfile::tempdir;
use crate::DB_POOL;
use crate::commands::types::*;
use crate::constants::folder_sync::{DEFAULT_K, DEFAULT_M, DEFAULT_CHUNK_SIZE};
use crate::sync_shared::collect_files_recursively;
use std::path::{Path, PathBuf};
use base64::{Engine as _, engine::general_purpose};
use sqlx::Row;
use crate::utils::sync::get_public_sync_path;
use futures::{future, stream::{self, StreamExt}};
use std::sync::Arc;
use tokio::sync::Mutex;
use crate::utils::file_operations::sanitize_name;

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
    file_data: Vec<u8>,
    file_name: String,
    seed_phrase: String,
    encryption_key: Option<String>,
) -> Result<String, String> {
    println!("Processing file: {:?}", file_name);
    let api_url = Arc::new("http://127.0.0.1:5001".to_string());
    let k = DEFAULT_K;
    let m = DEFAULT_M;
    let chunk_size = DEFAULT_CHUNK_SIZE;

    let encryption_key_bytes = if let Some(key_b64) = encryption_key {
        Some(general_purpose::STANDARD.decode(key_b64).map_err(|e| format!("Failed to decode base64 key: {}", e))?)
    } else {
        None
    };

    let original_file_size = file_data.len();
    let file_data_for_db_copy = file_data.clone();

    // Check if this file is already recorded in the sync database.
    if let Some(pool) = DB_POOL.get() {
        let is_synced: Option<(i32,)> = sqlx::query_as(
            "SELECT 1 FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private' LIMIT 1"
        )
        .bind(&account_id)
        .bind(&file_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error while checking sync status: {e}"))?;

        if is_synced.is_some() {
            let message = format!("File '{}' is already in sync DB, skipping upload.", file_name);
            println!("[encrypt_and_upload_file] {}", message);
            return Err(message);
        }
    }

    if let Some(pool) = DB_POOL.get() {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1",
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

    let (original_file_hash, encrypted_size, file_id, shards_to_upload) = tokio::task::spawn_blocking(move || {
        let mut hasher = Sha256::new();
        hasher.update(&file_data);
        let original_file_hash = format!("{:x}", hasher.finalize());
        println!("Original file size: {}, hash: {}", file_data.len(), original_file_hash);

        let to_process = tauri::async_runtime::block_on(encrypt_file(&file_data, encryption_key_bytes))?;
        let encrypted_size = to_process.len();
        println!("Encrypted data size: {}", encrypted_size);

        let chunks: Vec<Vec<u8>> = to_process.chunks(chunk_size).map(|c| {
            let mut chunk = c.to_vec();
            if chunk.len() < chunk_size { chunk.resize(chunk_size, 0); }
            chunk
        }).collect();
        
        let r = ReedSolomon::new(k, m - k).map_err(|e| format!("ReedSolomon error: {e}"))?;
        let file_id = Uuid::new_v4().to_string();
        let mut all_shards: Vec<(String, Vec<u8>, usize, usize)> = Vec::with_capacity(chunks.len() * m);

        for (orig_idx, chunk) in chunks.iter().enumerate() {
            let sub_block_size = (chunk.len() + k - 1) / k;
            let sub_blocks: Vec<Vec<u8>> = (0..k).map(|j| {
                let start = j * sub_block_size;
                let end = std::cmp::min(start + sub_block_size, chunk.len());
                let mut sub_block = chunk[start..end].to_vec();
                if sub_block.len() < sub_block_size { sub_block.resize(sub_block_size, 0); }
                sub_block
            }).collect();
            
            let mut shards_data: Vec<Option<Vec<u8>>> = sub_blocks.into_iter().map(Some).collect();
            for _ in k..m { shards_data.push(Some(vec![0u8; sub_block_size])); }
            
            let mut shard_refs: Vec<_> = shards_data.iter_mut().map(|x| x.as_mut().unwrap().as_mut_slice()).collect();
            r.encode(&mut shard_refs).map_err(|e| format!("ReedSolomon encode error: {e}"))?;
            
            for (share_idx, shard_data) in shard_refs.iter().enumerate() {
                let chunk_name = format!("{}_chunk_{}_{}.ec", file_id, orig_idx, share_idx);
                all_shards.push((chunk_name, shard_data.to_vec(), orig_idx, share_idx));
            }
        }
        
        Ok::<(String, usize, String, Vec<(String, Vec<u8>, usize, usize)>), String>((original_file_hash, encrypted_size, file_id, all_shards))
    }).await.map_err(|e| e.to_string())??;

    let all_chunk_info = Arc::new(Mutex::new(Vec::new()));
    let chunk_pairs = Arc::new(Mutex::new(Vec::new()));

    stream::iter(shards_to_upload)
        .for_each_concurrent(Some(10), |(chunk_name, shard_data, orig_idx, share_idx)| {
            let api_url_clone = Arc::clone(&api_url);
            let all_chunk_info_clone = Arc::clone(&all_chunk_info);
            let chunk_pairs_clone = Arc::clone(&chunk_pairs);

            async move {
                let shard_len = shard_data.len();
                match upload_bytes_to_ipfs(&api_url_clone, shard_data, &chunk_name).await {
                    Ok(cid) => {
                        let cid_info = CidInfo {
                            cid: cid.clone(), filename: chunk_name.clone(), size_bytes: shard_len,
                            encrypted: true, size_formatted: format_file_size(shard_len),
                        };
                        let chunk_info = ChunkInfo {
                            name: chunk_name.clone(), path: String::new(), cid: cid_info,
                            original_chunk: orig_idx, share_idx, size: shard_len,
                        };
                        all_chunk_info_clone.lock().await.push(chunk_info);
                        chunk_pairs_clone.lock().await.push((chunk_name, cid));
                    },
                    Err(e) => eprintln!("Failed to upload chunk {}: {}", chunk_name, e),
                }
            }
        }).await;

    let final_chunk_info = all_chunk_info.lock().await.clone();
    let final_chunk_pairs = chunk_pairs.lock().await.clone();
    let file_extension = Path::new(&file_name).extension().and_then(|s| s.to_str()).unwrap_or_default().to_string();

    let metadata = Metadata {
        original_file: OriginalFileInfo {
            name: file_name.clone(),
            size: original_file_size,
            hash: original_file_hash,
            extension: file_extension,
        },
        erasure_coding: ErasureCodingInfo { k, m, chunk_size, encrypted: true, file_id: file_id.clone(), encrypted_size },
        chunks: final_chunk_info,
        metadata_cid: None,
    };
    
    let metadata_json = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
    let metadata_filename = format!("{}_metadata.json", file_id);
    let metadata_cid = upload_bytes_to_ipfs(&api_url, metadata_json.as_bytes().to_vec(), &metadata_filename).await?;

    let meta_filename = format!("{}{}", file_name, ".ec_metadata");
    let mut files_for_storage = Vec::with_capacity(final_chunk_pairs.len() + 1);
    files_for_storage.push((meta_filename.clone(), metadata_cid.clone()));
    files_for_storage.extend(final_chunk_pairs);

    // Perform storage request and ensure it succeeds
    let res = request_erasure_storage(&meta_filename, &files_for_storage, &api_url, &seed_phrase)
        .await
        .map_err(|e| format!("Storage request failed: {}", e))?;
   
    let temp_dir = tempdir().map_err(|e| e.to_string())?;
    let temp_path = temp_dir.path().join(&file_name);
    tokio::fs::write(&temp_path, &file_data_for_db_copy).await.map_err(|e| e.to_string())?;
    copy_to_sync_and_add_to_db(&temp_path, &account_id, &metadata_cid, &res, false, false, &meta_filename, true).await;
    println!("[encrypt_and_upload_file] Storage request successful: {}", res);
    
    Ok(metadata_cid)
}

#[tauri::command]
pub async fn download_and_decrypt_file(
    _account_id: String,
    metadata_cid: String,
    output_file: String,
    encryption_key: Option<String>,
) -> Result<(), String> {
    println!("[download_and_decrypt_file] Downloading file with CID: {} to: {}", metadata_cid, output_file);
    let api_url = "http://127.0.0.1:5001".to_string(); // Convert to owned String

    let final_encryption_key = if let Some(key_b64) = encryption_key {
        let decoded_key = general_purpose::STANDARD.decode(&key_b64)
            .map_err(|e| format!("Failed to decode base64 key: {}", e))?;
        Some(decoded_key)
    } else {
        None
    };

    // First try to download as folder file metadata
    if let Ok(metadata_bytes) = download_from_ipfs_async(&api_url, &metadata_cid).await
        .map_err(|e| format!("Failed to download metadata: {}", e)) 
    {
        if let Ok(file_entry) = serde_json::from_slice::<FileEntry>(&metadata_bytes) {
            // This is a file from a folder, get the actual metadata
            let actual_metadata_bytes = download_from_ipfs_async(&api_url, &file_entry.cid).await
                .map_err(|e| format!("Failed to download file metadata: {}", e))?;
            let metadata: Metadata = serde_json::from_slice(&actual_metadata_bytes)
                .map_err(|e| format!("Failed to parse file metadata: {}", e))?;
            
            return reconstruct_and_decrypt_file(metadata, output_file, final_encryption_key, api_url).await;
        }
    }

    // If not a folder file, proceed with direct download
    let metadata_bytes = download_from_ipfs_async(&api_url, &metadata_cid).await
        .map_err(|e| format!("Failed to download metadata: {}", e))?;
    let metadata: Metadata = serde_json::from_slice(&metadata_bytes)
        .map_err(|e| format!("Failed to parse file metadata: {}", e))?;

    reconstruct_and_decrypt_file(metadata, output_file, final_encryption_key, api_url).await
}

async fn reconstruct_and_decrypt_file(
    metadata: Metadata,
    output_path: String,
    encryption_key: Option<Vec<u8>>,
    api_url: String, // Changed to owned String
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let k = metadata.erasure_coding.k;
        let m = metadata.erasure_coding.m;
        let chunk_size = metadata.erasure_coding.chunk_size;
        let file_hash = &metadata.original_file.hash;

        let mut chunk_map: std::collections::HashMap<usize, Vec<&ChunkInfo>> = std::collections::HashMap::new();
        for chunk in &metadata.chunks {
            chunk_map
                .entry(chunk.original_chunk)
                .or_default()
                .push(chunk);
        }

        let mut reconstructed_chunks = Vec::with_capacity(chunk_map.len());

        for orig_idx in 0..chunk_map.len() {
            let available_chunks = chunk_map.get(&orig_idx).ok_or("Missing chunk info")?;
            let mut shards: Vec<Option<Vec<u8>>> = vec![None; m];
            for chunk in available_chunks {
                let data = download_from_ipfs(&api_url, &chunk.cid.cid).map_err(|e| e.to_string())?;
                shards[chunk.share_idx] = Some(data);
            }

            let available_count = shards.iter().filter(|s| s.is_some()).count();
            if available_count < k {
                return Err(format!(
                    "Not enough shards for chunk {}: found {}, need {}",
                    orig_idx, available_count, k
                ));
            }

            let r = ReedSolomon::new(k, m - k).map_err(|e| format!("ReedSolomon error: {e}"))?;
            r.reconstruct_data(&mut shards)
                .map_err(|e| format!("Reconstruction failed: {e}"))?;

            let is_last_chunk = orig_idx == chunk_map.len() - 1;
            let chunk_bytes_needed = if !is_last_chunk {
                chunk_size
            } else {
                let total_bytes_so_far: usize = chunk_size * orig_idx;
                metadata.erasure_coding.encrypted_size.saturating_sub(total_bytes_so_far)
            };

            let mut chunk_data = Vec::with_capacity(chunk_bytes_needed);
            let mut bytes_collected = 0;
            for i in 0..k {
                if let Some(ref shard) = shards[i] {
                    let bytes_to_take = std::cmp::min(chunk_bytes_needed - bytes_collected, shard.len());
                    chunk_data.extend_from_slice(&shard[..bytes_to_take]);
                    bytes_collected += bytes_to_take;
                    if bytes_collected == chunk_bytes_needed {
                        break;
                    }
                }
            }
            println!("Chunk {}: reconstructed size {}, expected {}", orig_idx, chunk_data.len(), chunk_bytes_needed);
            reconstructed_chunks.push(chunk_data);
        }

        let mut encrypted_data = Vec::new();
        for chunk in reconstructed_chunks {
            encrypted_data.extend_from_slice(&chunk);
        }
        println!("Combined encrypted data size: {}, expected: {}", encrypted_data.len(), metadata.erasure_coding.encrypted_size);

        let decrypted_data = tauri::async_runtime::block_on(decrypt_file(
            &encrypted_data,
            encryption_key,
        ))?;
        println!("Decrypted data size: {}, expected original size: {}", decrypted_data.len(), metadata.original_file.size);

        let mut hasher = Sha256::new();
        hasher.update(&decrypted_data);
        let actual_hash = format!("{:x}", hasher.finalize());
        if actual_hash != *file_hash {
            return Err(format!(
                "Hash mismatch: expected {}, got {}",
                file_hash, actual_hash
            ));
        }

        std::fs::write(&output_path, &decrypted_data).map_err(|e| format!("Failed to write output file: {}", e))?;
        println!("File written to {} with size {}", output_path, decrypted_data.len());
        Ok(())
    })
    .await
    .map_err(|e| format!("Spawn blocking error: {}", e))?
}

#[tauri::command]
pub async fn encrypt_and_upload_folder(
    account_id: String,
    folder_path: String,
    seed_phrase: String,
    encryption_key: Option<String>,
) -> Result<String, String> {
    println!("[+] Starting encrypted upload for folder: {}", folder_path);
    let api_url = Arc::new("http://127.0.0.1:5001".to_string());
    let folder_path = Path::new(&folder_path);

    if !folder_path.is_dir() {
        return Err("Provided path is not a directory".to_string());
    }
    let folder_name = folder_path.file_name().and_then(|s| s.to_str()).unwrap_or_default().to_string();

    // Check if this folder is already recorded in the sync database.
    if let Some(pool) = DB_POOL.get() {
        let is_synced: Option<(i32,)> = sqlx::query_as(
            "SELECT 1 FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private' LIMIT 1"
        )
        .bind(&account_id)
        .bind(&folder_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error while checking sync status: {e}"))?;

        if is_synced.is_some() {
            let message = format!("Folder '{}' is already in sync DB, skipping upload.", folder_name);
            println!("[encrypt_and_upload_folder] {}", message);
            return Err(message);
        }
    }    
    
    if let Some(pool) = DB_POOL.get() {
        let row: Option<(String,)> = sqlx::query_as("SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1")
            .bind(&account_id)
            .bind(&folder_name)
            .fetch_optional(pool)
            .await.map_err(|e| format!("DB error: {e}"))?;
        if row.is_some() {
            return Err(format!("Folder '{}' already exists for this user.", folder_name));
        }
    }

    let mut files_to_process = Vec::new();
    collect_files_recursively(folder_path, &mut files_to_process).map_err(|e| e.to_string())?;
    println!("[i] Found {} files to process in folder.", files_to_process.len());

    let encryption_key_bytes = if let Some(key_b64) = encryption_key {
        Some(Arc::new(general_purpose::STANDARD.decode(&key_b64).map_err(|e| format!("Key decode error: {}", e))?))
    } else {
        None
    };

    let processing_results = Arc::new(Mutex::new(Vec::new()));
    stream::iter(files_to_process)
        .for_each_concurrent(Some(8), |file_path| {
            let api_url_clone = Arc::clone(&api_url);
            let encryption_key_clone = encryption_key_bytes.as_ref().map(Arc::clone);
            let results_clone = Arc::clone(&processing_results);
            let base_folder_path = folder_path.to_path_buf();

            async move {
                if let Err(e) = process_single_file_for_folder_upload(
                    file_path.clone(),
                    base_folder_path,
                    api_url_clone,
                    encryption_key_clone,
                    results_clone,
                ).await {
                    eprintln!("[!] Error processing file {:?}: {}", file_path.file_name().unwrap(), e);
                }
            }
        }).await;

    println!("[i] Aggregating processing results...");
    let final_results = Arc::try_unwrap(processing_results).map_err(|_| "Failed to unwrap Arc for processing results".to_string())?.into_inner();
    
    let mut file_manifest_entries = Vec::with_capacity(final_results.len());
    let mut all_files_for_storage: Vec<(String, String)> = Vec::new();

    for result in final_results {
        all_files_for_storage.extend(result.chunk_pairs);
        let storage_filename = format!("{}{}", result.file_entry.file_name, ".ec_metadata");
        all_files_for_storage.push((storage_filename.clone(), result.file_entry.cid.clone()));
        file_manifest_entries.push(result.file_entry);
    }

    let folder_manifest_json = serde_json::to_string_pretty(&file_manifest_entries)
        .map_err(|e| format!("Folder manifest serialization error: {}", e))?;
    let folder_manifest_cid = upload_bytes_to_ipfs(
        &api_url,
        folder_manifest_json.as_bytes().to_vec(),
        "folder.manifest.json"
    ).await?;
    println!("[✔] Uploaded folder manifest with CID: {}", folder_manifest_cid);

    let meta_folder_name = format!("{}{}", folder_name, ".folder.ec_metadata");
    all_files_for_storage.push((meta_folder_name.clone(), folder_manifest_cid.clone()));
    println!("folder_manifest_cid for encrypted folder: {}", folder_manifest_cid);
    // Perform storage request and ensure it succeeds
    let storage_result = request_erasure_storage(&meta_folder_name, &all_files_for_storage, &api_url, &seed_phrase)
        .await
        .map_err(|e| {
            eprintln!("[!] Folder storage request error: {}", e);
            format!("Folder storage request failed: {}", e)
        })?;
    copy_to_sync_and_add_to_db(
        folder_path, &account_id, &folder_manifest_cid, &storage_result, false, true, &meta_folder_name, true
    ).await;
    println!("[✔] Folder storage request successful: {}", storage_result);
    Ok(folder_manifest_cid)
}

async fn process_single_file_for_folder_upload(
    file_path: PathBuf,
    base_folder_path: PathBuf,
    api_url: Arc<String>,
    encryption_key: Option<Arc<Vec<u8>>>,
    results: Arc<Mutex<Vec<FileProcessingResult>>>,
) -> Result<(), String> {
    let k = DEFAULT_K;
    let m = DEFAULT_M;
    let chunk_size = DEFAULT_CHUNK_SIZE;

    let file_data = tokio::fs::read(&file_path).await.map_err(|e| e.to_string())?;
    let original_file_hash = format!("{:x}", Sha256::digest(&file_data));
    let encrypted_data = encrypt_file(&file_data, encryption_key.map(|k| (*k).clone())).await?;
    let encrypted_size = encrypted_data.len();
    
    let (uploaded_chunks_info, uploaded_chunk_pairs) = handle_erasure_coding_and_upload(
        encrypted_data, k, m, chunk_size, &api_url
    ).await?;

    let relative_path = file_path.strip_prefix(&base_folder_path).unwrap().to_str().unwrap().to_string();
    let file_name = file_path.file_name().unwrap().to_str().unwrap().to_string();
    
    let file_metadata = Metadata {
        original_file: OriginalFileInfo {
            name: format!("{}{}", file_name, ".ec_metadata"),
            size: file_data.len(),
            hash: original_file_hash,
            extension: file_path.extension().and_then(|s| s.to_str()).unwrap_or_default().to_string(),
        },
        erasure_coding: ErasureCodingInfo {
            k, m, chunk_size, encrypted: true, file_id: Uuid::new_v4().to_string(), encrypted_size
        },
        chunks: uploaded_chunks_info,
        metadata_cid: None,
    };

    let metadata_json = serde_json::to_string_pretty(&file_metadata).map_err(|e| e.to_string())?;
    let metadata_filename = format!("{}.file.metadata.json", Uuid::new_v4());
    let metadata_cid = upload_bytes_to_ipfs(
        &api_url,
        metadata_json.as_bytes().to_vec(),
        &metadata_filename
    ).await?;

    let result = FileProcessingResult {
        file_entry: FileEntry {
            file_name: format!("{}{}", relative_path, ".ec_metadata"),
            file_size: file_data.len(),
            cid: metadata_cid,
        },
        chunk_pairs: uploaded_chunk_pairs,
    };
    
    results.lock().await.push(result);
    println!("[✔] Finished processing file: {}", file_name);
    Ok(())
}

#[tauri::command]
pub async fn download_and_decrypt_folder(
    _account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    output_dir: String,
    encryption_key: Option<String>,
) -> Result<(), String> {
    println!("[+] Starting download for folder with manifest CID: {}", folder_metadata_cid);
    let api_url = Arc::new("http://127.0.0.1:5001".to_string());

    let encryption_key_bytes = if let Some(key_b64) = encryption_key {
        Some(Arc::new(general_purpose::STANDARD.decode(&key_b64).map_err(|e| format!("Key decode error: {}", e))?))
    } else {
        None
    };

    let folder_manifest_bytes = download_from_ipfs_async(&api_url, &folder_metadata_cid).await
        .map_err(|e| e.to_string())?;
    let file_entries: Vec<FileEntry> = serde_json::from_slice(&folder_manifest_bytes)
        .map_err(|e| format!("Failed to parse folder manifest (CID: {}): {}", folder_metadata_cid, e))?;
    println!("[i] Folder manifest contains {} files.", file_entries.len());

    let output_root_path = Path::new(&output_dir).join(&folder_name);
    tokio::fs::create_dir_all(&output_root_path).await.map_err(|e| e.to_string())?;

    stream::iter(file_entries)
        .for_each_concurrent(Some(8), |entry| {
            let api_url_clone = Arc::clone(&api_url);
            let output_root_clone = output_root_path.clone();
            let encryption_key_clone = encryption_key_bytes.as_ref().map(Arc::clone);

            async move {
                println!("[download_and_decrypt_folder] Downloading file with CID: {} to: {:?}", 
                    entry.cid, output_root_clone.join(&entry.file_name));
                
                // Download the file metadata
                let file_metadata_bytes = match download_from_ipfs_async(&api_url_clone, &entry.cid).await {
                    Ok(bytes) => bytes,
                    Err(e) => {
                        eprintln!("[!] Failed to download metadata for {} (CID: {}): {}", 
                            entry.file_name, entry.cid, e);
                        return;
                    }
                };

                let metadata: Metadata = match serde_json::from_slice(&file_metadata_bytes) {
                    Ok(meta) => meta,
                    Err(e) => {
                        eprintln!("[!] Failed to parse metadata for {} (CID: {}): {}", 
                            entry.file_name, entry.cid, e);
                        return;
                    }
                };

                // Handle the .ec_metadata extension and get original filename
                let original_file_name = if entry.file_name.ends_with(".ec_metadata") {
                    entry.file_name.trim_end_matches(".ec_metadata")
                } else if entry.file_name.ends_with(".ff") {
                    entry.file_name.trim_end_matches(".ff")
                } else {
                    &entry.file_name
                };

                // Use original extension from metadata if available
                let final_file_name = if !metadata.original_file.extension.is_empty() {
                    format!("{}.{}", original_file_name, metadata.original_file.extension)
                } else {
                    original_file_name.to_string()
                };

                let output_file_path = output_root_clone.join(&final_file_name);
                println!("[i] Processing file: {}", final_file_name);

                // Create parent directories if needed
                if let Some(parent) = output_file_path.parent() {
                    if let Err(e) = tokio::fs::create_dir_all(parent).await {
                        eprintln!("[!] Failed to create directory for {}: {}", final_file_name, e);
                        return;
                    }
                }
                

                match reconstruct_and_decrypt_single_file(
                    file_metadata_bytes,
                    output_file_path.clone(),
                    api_url_clone,
                    encryption_key_clone,
                ).await {
                    Ok(()) => println!("[✔] Successfully downloaded and decrypted {}", final_file_name),
                    Err(e) => eprintln!("[!] Failed to download/decrypt {}: {}", final_file_name, e),
                }
            }
        }).await;

    println!("[✔] Folder download process complete.");
    Ok(())
}

#[tauri::command]
pub async fn add_file_to_private_folder(
    account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    file_name: String,
    file_data: Vec<u8>,
    seed_phrase: String,
    encryption_key: Option<String>,
) -> Result<String, String> {
    println!("[+] Adding file '{}' to folder '{}'", file_name, folder_name);
    let api_url = Arc::new("http://127.0.0.1:5001".to_string());

    let manifest_bytes = download_from_ipfs_async(&api_url, &folder_metadata_cid).await
        .map_err(|e| e.to_string())?;
    let mut file_entries: Vec<FileEntry> = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("Could not parse existing folder manifest: {}", e))?;

    if file_entries.iter().any(|entry| entry.file_name == file_name) {
        return Err(format!("File '{}' already exists in folder '{}'.", file_name, folder_name));
    }

    let encryption_key_bytes = if let Some(key_b64) = encryption_key {
        Some(Arc::new(general_purpose::STANDARD.decode(&key_b64).map_err(|e| format!("Key decode error: {}", e))?))
    } else {
        None
    };

    let (new_file_entry, _new_chunk_pairs) =
        process_new_file_for_addition(file_name.clone(), file_data.clone(), &api_url, encryption_key_bytes).await?;

    file_entries.push(new_file_entry);
    let updated_manifest_json = serde_json::to_string_pretty(&file_entries).map_err(|e| e.to_string())?;
    let new_folder_manifest_cid = upload_bytes_to_ipfs(
        &api_url,
        updated_manifest_json.as_bytes().to_vec(),
        "folder.manifest.json"
    ).await?;
    
    delete_and_unpin_user_file_records_from_folder(&folder_name, &seed_phrase).await
        .map_err(|e| format!("Failed to request unpinning of old folder version: {}", e))?;

    let mut all_files_for_storage = build_complete_storage_list(file_entries, &api_url).await?;
    let meta_folder_name = format!("{}{}", folder_name, ".folder.ec_metadata");
    all_files_for_storage.push((meta_folder_name.clone(), new_folder_manifest_cid.clone()));

    let storage_result = request_erasure_storage(&meta_folder_name, &all_files_for_storage, &api_url, &seed_phrase).await?;

    // Sanitize names for local sync
    let sanitized_folder_name = sanitize_name(&folder_name);
    let sanitized_file_name = sanitize_name(&file_name);

    // Update the database and sync folder
    let temp_file = tempfile::NamedTempFile::new()
        .map_err(|e| format!("Failed to create temp file: {}", e))?;
    fs::write(temp_file.path(), &file_data)
        .map_err(|e| format!("Failed to write sync temp file: {}", e))?;
    
    println!("[+] Copying file to sync folder sanitized_folder_name {}, sanitized_file_name {}",sanitized_folder_name, sanitized_file_name);
    copy_to_sync_folder(
        temp_file.path(),
        &sanitized_folder_name,
        &account_id,
        &new_folder_manifest_cid,
        &storage_result,
        false,
        false,
        &meta_folder_name,
    )
    .await;
    println!("[✔] Successfully added file. New folder manifest CID: {}", new_folder_manifest_cid);
    Ok(new_folder_manifest_cid)
}

#[tauri::command]
pub async fn remove_file_from_private_folder(
    account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    file_name: String,
    seed_phrase: String,
) -> Result<String, String> {
    println!("[+] Removing file '{}' from folder '{}'", file_name, folder_name);
    let api_url = Arc::new("http://127.0.0.1:5001".to_string());

    let manifest_bytes = download_from_ipfs_async(&api_url, &folder_metadata_cid)
        .await
        .map_err(|e| e.to_string())?;

    let mut file_entries: Vec<FileEntry> = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("Failed to parse folder manifest: {}", e))?;

    let original_len = file_entries.len();

    // Match filename variations (same as public version)
    let file_name_variations = get_file_name_variations(&file_name);

    // Remove all matching variations
    file_entries.retain(|entry| !file_name_variations.contains(&entry.file_name));
    println!("{:?} , file_entries {:?}", file_name, file_entries);

    if file_entries.len() == original_len {
        return Err(format!("File '{}' (or its variations) not found in folder '{}'.", file_name, folder_name));
    }

    let updated_manifest_json = serde_json::to_string_pretty(&file_entries)
        .map_err(|e| e.to_string())?;

    let new_folder_manifest_cid = upload_bytes_to_ipfs(
        &api_url,
        updated_manifest_json.as_bytes().to_vec(),
        "folder.manifest.json",
    )
    .await?;

    delete_and_unpin_user_file_records_from_folder(&folder_name, &seed_phrase)
        .await
        .map_err(|e| format!("Failed to request unpinning of old folder version: {}", e))?;

    let mut all_files_for_storage = build_complete_storage_list(file_entries, &api_url).await?;
    let meta_folder_name = format!("{}{}", folder_name, ".folder.ec_metadata");
    all_files_for_storage.push((meta_folder_name.clone(), new_folder_manifest_cid.clone()));

    let storage_result =
        request_erasure_storage(&meta_folder_name, &all_files_for_storage, &api_url, &seed_phrase).await?;

    remove_from_sync_folder(
        &file_name,
        &folder_name,
        false,
        false,
        &meta_folder_name,
        &new_folder_manifest_cid,
        &account_id,
        &storage_result,
    )
    .await;

    println!(
        "[✔] Successfully removed file. New folder manifest CID: {}",
        new_folder_manifest_cid
    );

    Ok(new_folder_manifest_cid)
}

async fn handle_erasure_coding_and_upload(
    data_to_process: Vec<u8>,
    k: usize, m: usize, chunk_size: usize,
    api_url: &Arc<String>
) -> Result<(Vec<ChunkInfo>, Vec<(String, String)>), String> {

    let (_file_id, shards_to_upload) = tokio::task::spawn_blocking(move || {
        let r = ReedSolomon::new(k, m - k).map_err(|e| format!("ReedSolomon error: {e}"))?;
        let file_id = Uuid::new_v4().to_string();
        let mut all_shards: Vec<(String, Vec<u8>, usize, usize)> = Vec::new();

        let chunks: Vec<Vec<u8>> = data_to_process.chunks(chunk_size).map(|c| {
            let mut chunk = c.to_vec();
            if chunk.len() < chunk_size { chunk.resize(chunk_size, 0); }
            chunk
        }).collect();
        
        for (orig_idx, chunk) in chunks.iter().enumerate() {
            let sub_block_size = (chunk.len() + k - 1) / k;
            let sub_blocks: Vec<Vec<u8>> = (0..k).map(|j| {
                let start = j * sub_block_size;
                let end = std::cmp::min(start + sub_block_size, chunk.len());
                let mut sub_block = chunk[start..end].to_vec();
                if sub_block.len() < sub_block_size { sub_block.resize(sub_block_size, 0); }
                sub_block
            }).collect();
            
            let mut shards_data: Vec<Option<Vec<u8>>> = sub_blocks.into_iter().map(Some).collect();
            for _ in k..m { shards_data.push(Some(vec![0u8; sub_block_size])); }
            
            let mut shard_refs: Vec<_> = shards_data.iter_mut().map(|x| x.as_mut().unwrap().as_mut_slice()).collect();
            r.encode(&mut shard_refs).map_err(|e| format!("ReedSolomon encode error: {e}"))?;
            
            for (share_idx, shard_data) in shard_refs.iter().enumerate() {
                let chunk_name = format!("{}_chunk_{}_{}.ec", file_id, orig_idx, share_idx);
                all_shards.push((chunk_name, shard_data.to_vec(), orig_idx, share_idx));
            }
        }
        Ok::<(String, Vec<(String, Vec<u8>, usize, usize)>), String>((file_id, all_shards))
    }).await.map_err(|e| e.to_string())??;

    let all_chunk_info = Arc::new(Mutex::new(Vec::new()));
    let chunk_pairs = Arc::new(Mutex::new(Vec::new()));

    stream::iter(shards_to_upload)
        .for_each_concurrent(Some(10), |(chunk_name, shard_data, orig_idx, share_idx)| {
            let api_url_clone = Arc::clone(api_url);
            let all_chunk_info_clone = Arc::clone(&all_chunk_info);
            let chunk_pairs_clone = Arc::clone(&chunk_pairs);

            async move {
                let shard_len = shard_data.len();
                match upload_bytes_to_ipfs(&api_url_clone, shard_data, &chunk_name).await {
                    Ok(cid) => {
                        let info = ChunkInfo {
                            name: chunk_name.clone(),
                            path: String::new(),
                            cid: CidInfo { cid: cid.clone(), filename: chunk_name.clone(), size_bytes: shard_len, encrypted: true, size_formatted: format_file_size(shard_len) },
                            original_chunk: orig_idx, share_idx, size: shard_len,
                        };
                        all_chunk_info_clone.lock().await.push(info);
                        chunk_pairs_clone.lock().await.push((chunk_name, cid));
                    }
                    Err(e) => eprintln!("Failed to upload chunk {}: {}", chunk_name, e),
                }
            }
        }).await;
    
    let final_chunk_info = Arc::try_unwrap(all_chunk_info).map_err(|_| "Failed to unwrap Arc for chunk info".to_string())?.into_inner();
    let final_chunk_pairs = Arc::try_unwrap(chunk_pairs).map_err(|_| "Failed to unwrap Arc for chunk pairs".to_string())?.into_inner();

    Ok((final_chunk_info, final_chunk_pairs))
}

async fn reconstruct_and_decrypt_single_file(
    metadata_bytes: Vec<u8>,
    output_path: PathBuf,
    api_url: Arc<String>,
    encryption_key: Option<Arc<Vec<u8>>>,
) -> Result<(), String> {
    let metadata: Metadata = serde_json::from_slice(&metadata_bytes)
        .map_err(|e| format!("Failed to parse file metadata: {}", e))?;

    if metadata.chunks.is_empty() {
        return Err(format!("Cannot reconstruct file '{}': metadata contains no chunk information.", metadata.original_file.name));
    }

    let k = metadata.erasure_coding.k;
    let m = metadata.erasure_coding.m;
    let chunk_size = metadata.erasure_coding.chunk_size;

    let mut chunk_map: std::collections::HashMap<usize, Vec<&ChunkInfo>> = std::collections::HashMap::new();
    for chunk in &metadata.chunks {
        chunk_map.entry(chunk.original_chunk).or_default().push(chunk);
    }
    
    let mut reconstructed_chunks_data = Vec::with_capacity(chunk_map.len());
    for orig_idx in 0..chunk_map.len() {
        let available_shards = chunk_map.get(&orig_idx).ok_or("Missing chunk group in map")?;
        let mut shards: Vec<Option<Vec<u8>>> = vec![None; m];
        
        for shard_info in available_shards.iter() {
            let data = download_from_ipfs_async(&api_url, &shard_info.cid.cid).await.map_err(|e| e.to_string())?;
            shards[shard_info.share_idx] = Some(data);
        }

        if shards.iter().filter(|s| s.is_some()).count() < k {
            return Err(format!("Not enough shards for chunk {}", orig_idx));
        }
        
        let r = ReedSolomon::new(k, m - k).map_err(|e| e.to_string())?;
        r.reconstruct_data(&mut shards).map_err(|e| format!("Reconstruction failed: {}", e))?;
        
        let mut chunk_data = Vec::new();
        let mut bytes_collected = 0;
        let is_last_chunk = orig_idx == chunk_map.len() - 1;
        let chunk_bytes_needed = if !is_last_chunk {
            chunk_size
        } else {
            metadata.erasure_coding.encrypted_size.saturating_sub(chunk_size * orig_idx)
        };

        for i in 0..k {
            if let Some(shard) = &shards[i] {
                let bytes_to_take = std::cmp::min(chunk_bytes_needed - bytes_collected, shard.len());
                chunk_data.extend_from_slice(&shard[..bytes_to_take]);
                bytes_collected += bytes_to_take;
                if bytes_collected >= chunk_bytes_needed { break; }
            }
        }
        reconstructed_chunks_data.push(chunk_data);
    }

    let encrypted_data: Vec<u8> = reconstructed_chunks_data.into_iter().flatten().collect();
    let decrypted_data = decrypt_file(&encrypted_data, encryption_key.map(|k| (*k).clone())).await?;
    
    let actual_hash = format!("{:x}", Sha256::digest(&decrypted_data));
    if actual_hash != metadata.original_file.hash {
        return Err(format!("Hash mismatch for {}", metadata.original_file.name));
    }

    tokio::fs::write(&output_path, &decrypted_data).await.map_err(|e| e.to_string())?;
    println!("[✔] Successfully downloaded and wrote file to {}", output_path.display());
    Ok(())
}

async fn process_new_file_for_addition(
    file_name: String,
    file_data: Vec<u8>,
    api_url: &Arc<String>,
    encryption_key: Option<Arc<Vec<u8>>>,
) -> Result<(FileEntry, Vec<(String, String)>), String> {
    let k = DEFAULT_K;
    let m = DEFAULT_M;
    let chunk_size = DEFAULT_CHUNK_SIZE;

    let original_file_hash = format!("{:x}", Sha256::digest(&file_data));
    let encrypted_data = encrypt_file(&file_data, encryption_key.map(|k| (*k).clone())).await?;
    let encrypted_size = encrypted_data.len();

    let (uploaded_chunks_info, uploaded_chunk_pairs) = handle_erasure_coding_and_upload(
        encrypted_data, k, m, chunk_size, &api_url
    ).await?;

    let file_metadata = Metadata {
        original_file: OriginalFileInfo {
            name: file_name.clone(),
            size: file_data.len(),
            hash: original_file_hash,
            extension: Path::new(&file_name).extension().and_then(|s| s.to_str()).unwrap_or_default().to_string(),
        },
        erasure_coding: ErasureCodingInfo { k, m, chunk_size, encrypted: true, file_id: Uuid::new_v4().to_string(), encrypted_size },
        chunks: uploaded_chunks_info,
        metadata_cid: None,
    };
    let metadata_json = serde_json::to_string_pretty(&file_metadata).map_err(|e| e.to_string())?;
    let metadata_filename = format!("{}.file.metadata.json", Uuid::new_v4());
    let metadata_cid = upload_bytes_to_ipfs(api_url, metadata_json.as_bytes().to_vec(), &metadata_filename).await?;

    let new_file_entry = FileEntry {
        file_name,
        file_size: file_data.len(),
        cid: metadata_cid,
    };

    Ok((new_file_entry, uploaded_chunk_pairs))
}

async fn build_complete_storage_list(
    entries: Vec<FileEntry>,
    api_url: &Arc<String>
) -> Result<Vec<(String, String)>, String> {
    let storage_list = Arc::new(Mutex::new(Vec::new()));

    stream::iter(entries)
        .for_each_concurrent(Some(8), |entry| {
            let api_url_clone = Arc::clone(api_url);
            let storage_list_clone = Arc::clone(&storage_list);

            async move {
                storage_list_clone.lock().await.push((entry.file_name.clone(), entry.cid.clone()));

                match download_from_ipfs_async(&api_url_clone, &entry.cid).await {
                    Ok(metadata_bytes) => {
                        if let Ok(metadata) = serde_json::from_slice::<Metadata>(&metadata_bytes) {
                            let mut pairs = Vec::new();
                            for chunk in metadata.chunks {
                                pairs.push((chunk.name, chunk.cid.cid));
                            }
                            storage_list_clone.lock().await.extend(pairs);
                        }
                    },
                    Err(e) => eprintln!("[!] Failed to get metadata for {} to build storage list: {}", entry.file_name, e)
                }
            }
        }).await;

    let final_list = Arc::try_unwrap(storage_list).map_err(|_| "Failed to unwrap Arc for storage list".to_string())?.into_inner();
    Ok(final_list)
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
    file_data: Vec<u8>,
    file_name: String,
    seed_phrase: String
) -> Result<String, String> {
    println!("[upload_file_public] processing file: {:?}", file_name);    
    let api_url = "http://127.0.0.1:5001";

    // Check if this file is already recorded in the sync database.
    if let Some(pool) = DB_POOL.get() {
        let is_synced: Option<(i32,)> = sqlx::query_as(
            "SELECT 1 FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public' LIMIT 1"
        )
        .bind(&account_id)
        .bind(&file_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error while checking sync status: {e}"))?;

        if is_synced.is_some() {
            let message = format!("File '{}' is already in sync DB, skipping upload.", file_name);
            println!("[upload_file_public] {}", message);
            return Err(message);
        }
    }
    
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

    let api_url_cloned = api_url.to_string();
    let file_data_clone = file_data.clone();
    let file_cid = tokio::task::spawn_blocking(move || {
        let temp_dir = tempdir().map_err(|e| e.to_string())?;
        let temp_path = temp_dir.path().join("upload_temp_file");
        fs::write(&temp_path, &file_data_clone).map_err(|e| e.to_string())?;
        
        let cid = upload_to_ipfs(&api_url_cloned, temp_path.to_str().unwrap())
            .map_err(|e| e.to_string())?;
        Ok::<String, String>(cid)
    })
    .await
    .map_err(|e| format!("Task spawn error: {}", e))??;

    println!("[upload_file_public] File CID: {}", file_cid);

    let storage_result = request_file_storage(&file_name.clone(), &file_cid, api_url, &seed_phrase).await;
    match &storage_result {
        Ok(res) => {
            let temp_dir = tempdir().map_err(|e| e.to_string())?;
            let temp_path = temp_dir.path().join(&file_name);
            fs::write(&temp_path, file_data).map_err(|e| e.to_string())?;
            
            copy_to_sync_and_add_to_db(&temp_path, &account_id, &file_cid, res, true, false, &file_name, true).await;
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
    
    std::fs::write(&output_file, file_data)
        .map_err(|e| format!("Failed to write file to {}: {}", output_file, e))?;
    
    println!("[download_file_public] Successfully downloaded file to: {}", output_file);
    Ok(())
}


#[tauri::command]
pub async fn public_upload_with_erasure(
    account_id: String,
    file_data: Vec<u8>,
    file_name: String,
    seed_phrase: String,
) -> Result<String, String> {
    println!("[public_upload_with_erasure] Processing file: {:?}", file_name);
    let api_url = Arc::new("http://127.0.0.1:5001".to_string());
    let k = DEFAULT_K;
    let m = DEFAULT_M;
    let chunk_size = DEFAULT_CHUNK_SIZE;

    // Check if this file is already recorded in the sync database.
    if let Some(pool) = DB_POOL.get() {
        let is_synced: Option<(i32,)> = sqlx::query_as(
            "SELECT 1 FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public' LIMIT 1"
        )
        .bind(&account_id)
        .bind(&file_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error while checking sync status: {e}"))?;

        if is_synced.is_some() {
            let message = format!("File '{}' is already in sync DB, skipping upload.", file_name);
            println!("[public_upload_with_erasure] {}", message);
            return Err(message);
        }
    }

    if let Some(pool) = DB_POOL.get() {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1",
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

    let file_data_arc = Arc::new(file_data.clone());
    let file_name_clone = file_name.clone();

    let (original_file_hash, file_id, erasure_shards_to_upload) = tokio::task::spawn_blocking(move || {
        let mut hasher = Sha256::new();
        hasher.update(&*file_data_arc);
        let original_file_hash = format!("{:x}", hasher.finalize());
        println!("Original file size: {}, hash: {}", file_data_arc.len(), original_file_hash);

        let chunks: Vec<Vec<u8>> = file_data_arc
            .chunks(chunk_size)
            .map(|chunk| {
                let mut c = chunk.to_vec();
                if c.len() < chunk_size {
                    c.resize(chunk_size, 0);
                }
                c
            })
            .collect();
        
        let r = ReedSolomon::new(k, m - k).map_err(|e| format!("ReedSolomon error: {e}"))?;
        let file_id = Uuid::new_v4().to_string();
        let mut all_shards: Vec<(String, Vec<u8>, usize, usize)> = Vec::with_capacity(chunks.len() * m);

        for (orig_idx, chunk) in chunks.iter().enumerate() {
            let sub_block_size = (chunk.len() + k - 1) / k;
            let sub_blocks: Vec<Vec<u8>> = (0..k).map(|j| {
                let start = j * sub_block_size;
                let end = std::cmp::min(start + sub_block_size, chunk.len());
                let mut sub_block = chunk[start..end].to_vec();
                if sub_block.len() < sub_block_size { sub_block.resize(sub_block_size, 0); }
                sub_block
            }).collect();
            
            let mut shards_data: Vec<Option<Vec<u8>>> = sub_blocks.into_iter().map(Some).collect();
            for _ in k..m { shards_data.push(Some(vec![0u8; sub_block_size])); }
            
            let mut shard_refs: Vec<_> = shards_data.iter_mut().map(|x| x.as_mut().unwrap().as_mut_slice()).collect();
            r.encode(&mut shard_refs).map_err(|e| format!("ReedSolomon encode error: {e}"))?;
            
            for (share_idx, shard) in shard_refs.iter().enumerate() {
                let chunk_name = format!("{}_chunk_{}_{}.ec", file_id, orig_idx, share_idx);
                all_shards.push((chunk_name, shard.to_vec(), orig_idx, share_idx));
            }
        }
        
        Ok::<(String, String, Vec<(String, Vec<u8>, usize, usize)>), String>((original_file_hash, file_id, all_shards))
    }).await.map_err(|e| e.to_string())??;

    let all_chunk_info = Arc::new(Mutex::new(Vec::new()));
    let chunk_pairs = Arc::new(Mutex::new(Vec::new()));
    
    let original_upload_future = upload_bytes_to_ipfs(&api_url, file_data.clone(), &file_name_clone);
    
    let shard_uploads_future = stream::iter(erasure_shards_to_upload).for_each_concurrent(
        Some(10),
        |(chunk_name, shard_data, orig_idx, share_idx)| {
            let api_url_clone = Arc::clone(&api_url);
            let all_chunk_info_clone = Arc::clone(&all_chunk_info);
            let chunk_pairs_clone = Arc::clone(&chunk_pairs);

            async move {
                let shard_len = shard_data.len();
                match upload_bytes_to_ipfs(&api_url_clone, shard_data, &chunk_name).await {
                    Ok(cid) => {
                        let info = ChunkInfo {
                            name: chunk_name.clone(),
                            path: String::new(),
                            cid: CidInfo {
                                cid: cid.clone(),
                                filename: chunk_name.clone(),
                                size_bytes: shard_len,
                                encrypted: false,
                                size_formatted: format_file_size(shard_len),
                            },
                            original_chunk: orig_idx,
                            share_idx,
                            size: shard_len,
                        };
                        all_chunk_info_clone.lock().await.push(info);
                        chunk_pairs_clone.lock().await.push((chunk_name, cid));
                    }
                    Err(e) => eprintln!("Failed to upload chunk {}: {}", chunk_name, e),
                }
            }
        },
    );

    let (original_file_cid_result, _) = future::join(original_upload_future, shard_uploads_future).await;
    let _original_file_cid = original_file_cid_result?;

    let final_chunk_info = all_chunk_info.lock().await.clone();
    
    let file_extension = Path::new(&file_name).extension().and_then(|s| s.to_str()).unwrap_or_default().to_string();
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
            encrypted: false,
            file_id: file_id.clone(),
            encrypted_size: file_data.len(),
        },
        chunks: final_chunk_info,
        metadata_cid: None,
    };

    let metadata_json = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
    let meta_filename_for_upload = format!("{}_metadata.json", file_id);
    let metadata_cid = upload_bytes_to_ipfs(&api_url, metadata_json.as_bytes().to_vec(), &meta_filename_for_upload).await?;

    let meta_filename_for_db = format!("{}{}", file_name, if file_name.ends_with(".ec_metadata") { "" } else { ".ec_metadata" });
    let mut files_for_storage = chunk_pairs.lock().await.clone();
    files_for_storage.push((meta_filename_for_db.clone(), metadata_cid.clone()));

    let storage_result = request_erasure_storage(&meta_filename_for_db, &files_for_storage, &api_url, &seed_phrase).await;
    match storage_result {
        Ok(res) => {
            let temp_dir = tempdir().map_err(|e| e.to_string())?;
            let temp_path = temp_dir.path().join(&file_name);
            fs::write(&temp_path, file_data).map_err(|e| e.to_string())?;
            copy_to_sync_and_add_to_db(
                &temp_path,
                &account_id,
                &metadata_cid,
                &res,
                true,
                false,
                &meta_filename_for_db,
                true,
            ).await;
            println!("[public_upload_with_erasure] Storage request result: {}", res);
        }
        Err(e) => println!("[public_upload_with_erasure] Storage request error: {}", e),
    }

    Ok(metadata_cid)
}

#[tauri::command]
pub async fn public_download_with_erasure(
    _account_id: String,
    metadata_cid: String,
    output_file: String,
) -> Result<(), String> {
    let api_url = "http://127.0.0.1:5001";

    tokio::task::spawn_blocking(move || {
        println!("Downloading metadata CID: {}", metadata_cid);
        let metadata_bytes = download_from_ipfs(&api_url, &metadata_cid).map_err(|e| e.to_string())?;
        let metadata: Metadata = serde_json::from_slice(&metadata_bytes).map_err(|e| e.to_string())?;
        println!("Metadata loaded: original size {}, stored size {}", metadata.original_file.size, metadata.erasure_coding.encrypted_size);

        let k = metadata.erasure_coding.k;
        let m = metadata.erasure_coding.m;
        let chunk_size = metadata.erasure_coding.chunk_size;
        let file_hash = &metadata.original_file.hash;

        let mut chunk_map: std::collections::HashMap<usize, Vec<&ChunkInfo>> = std::collections::HashMap::new();
        for chunk in &metadata.chunks {
            chunk_map
                .entry(chunk.original_chunk)
                .or_default()
                .push(chunk);
        }

        let mut reconstructed_chunks = Vec::with_capacity(chunk_map.len());

        for orig_idx in 0..chunk_map.len() {
            let available_chunks = chunk_map.get(&orig_idx).ok_or("Missing chunk info")?;
            let mut shards: Vec<Option<Vec<u8>>> = vec![None; m];
            for chunk in available_chunks {
                let data = download_from_ipfs(&api_url, &chunk.cid.cid).map_err(|e| e.to_string())?;
                shards[chunk.share_idx] = Some(data);
            }

            let available_count = shards.iter().filter(|s| s.is_some()).count();
            if available_count < k {
                return Err(format!(
                    "Not enough shards for chunk {}: found {}, need {}",
                    orig_idx, available_count, k
                ));
            }

            let r = ReedSolomon::new(k, m - k).map_err(|e| format!("ReedSolomon error: {e}"))?;
            r.reconstruct_data(&mut shards)
                .map_err(|e| format!("Reconstruction failed: {e}"))?;

            let is_last_chunk = orig_idx == chunk_map.len() - 1;
            let file_size = metadata.original_file.size;
            let chunk_bytes_needed = if !is_last_chunk {
                chunk_size
            } else {
                let total_bytes_so_far: usize = chunk_size * orig_idx;
                file_size.saturating_sub(total_bytes_so_far)
            };

            let mut chunk_data = Vec::with_capacity(chunk_bytes_needed);
            let mut bytes_collected = 0;
            for i in 0..k {
                if let Some(ref shard) = shards[i] {
                    let bytes_to_take = std::cmp::min(chunk_bytes_needed - bytes_collected, shard.len());
                    chunk_data.extend_from_slice(&shard[..bytes_to_take]);
                    bytes_collected += bytes_to_take;
                    if bytes_collected == chunk_bytes_needed {
                        break;
                    }
                }
            }
            println!("Chunk {}: reconstructed size {}, expected {}", orig_idx, chunk_data.len(), chunk_bytes_needed);
            reconstructed_chunks.push(chunk_data);
        }

        let mut reconstructed_data = Vec::new();
        for chunk in reconstructed_chunks {
            reconstructed_data.extend_from_slice(&chunk);
        }
        println!("Combined reconstructed data size: {}, expected: {}", reconstructed_data.len(), metadata.original_file.size);

        let mut hasher = Sha256::new();
        hasher.update(&reconstructed_data);
        let actual_hash = format!("{:x}", hasher.finalize());
        if actual_hash != *file_hash {
            return Err(format!(
                "Hash mismatch: expected {}, got {}",
                file_hash, actual_hash
            ));
        }

        std::fs::write(&output_file, &reconstructed_data).map_err(|e| format!("Failed to write output file: {}", e))?;
        println!("File written to {} with size {}", output_file, reconstructed_data.len());
        Ok(())
    })
    .await
    .map_err(|e| format!("Spawn blocking error: {}", e))?
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

    // Check if this folder is already recorded in the sync database.
    if let Some(pool) = DB_POOL.get() {
        let is_synced: Option<(i32,)> = sqlx::query_as(
            "SELECT 1 FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public' LIMIT 1"
        )
        .bind(&account_id)
        .bind(&folder_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error while checking sync status: {e}"))?;

        if is_synced.is_some() {
            let message = format!("Folder '{}' is already in sync DB, skipping upload.", folder_name);
            println!("[public_upload_folder_sync] {}", message);
            return Err(message);
        }
    }    

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

    let folder_path_cloned = folder_path.to_path_buf();
    let api_url_cloned = api_url.to_string();
    let (folder_name, folder_metadata_cid, file_cid_pairs) = tokio::task::spawn_blocking(move || {
        let mut file_entries = Vec::new();
        let mut files = Vec::new();
        let mut file_cid_pairs: Vec<(String, String)> = Vec::new();
        let _ = collect_files_recursively(&folder_path_cloned, &mut files).map_err(|e| e.to_string())?;
        let temp_dir = tempdir().map_err(|e| e.to_string())?;
        for file_path in files {
            let _relative_path = file_path.strip_prefix(&folder_path_cloned)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .to_string();
            let file_name = file_path
                .file_name()
                .ok_or_else(|| "Invalid file path".to_string())?
                .to_string_lossy()
                .to_string();

            let ipfs_file_name = format!("{}{}", file_name, if file_name.ends_with(".ff") { "" } else { ".ff" });
        
            let file_data = fs::read(&file_path).map_err(|e| e.to_string())?;
            let file_size = file_data.len();
            let mut hasher = Sha256::new();
            hasher.update(&file_data);
            let _original_file_hash = format!("{:x}", hasher.finalize());
            let file_cid = upload_to_ipfs(&api_url_cloned, file_path.to_str().unwrap())
                .map_err(|e| e.to_string())?;
            file_entries.push(FileEntry {
                file_name: ipfs_file_name.clone(),
                file_size,
                cid: file_cid.clone(),
            });
            file_cid_pairs.push((ipfs_file_name.clone(), file_cid.clone()));
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
        Ok::<(String, String, Vec<(String,String)>), String>((folder_name, folder_metadata_cid, file_cid_pairs))
    })
    .await
    .map_err(|e| e.to_string())??;
    let meta_folder_name = format!("{}{}", folder_name, if folder_name.ends_with(".folder") { "" } else { ".folder" });
    // Build files array: folder metadata + all file CIDs
    let mut files_for_storage = Vec::with_capacity(file_cid_pairs.len() + 1);
    files_for_storage.push((meta_folder_name.clone(), folder_metadata_cid.clone()));
    files_for_storage.extend(file_cid_pairs);
    // Submit storage request
    let storage_result = request_folder_storage(&meta_folder_name.clone(), &files_for_storage, api_url, &seed_phrase).await;
    match &storage_result {
        Ok(res) => {
            copy_to_sync_and_add_to_db(Path::new(&folder_path), &account_id, &folder_metadata_cid, &res, true, true, &meta_folder_name.clone(), true).await;
            println!("[public_upload_folder] Storage request result: {}", res);
        },
        Err(e) => println!("[public_upload_folder] Storage request error: {}", e),
    }
    Ok(folder_metadata_cid)
}

#[tauri::command]
pub async fn public_download_folder(
    _account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    output_dir: String,
) -> Result<(), String> {
    let api_url = "http://127.0.0.1:5001";
    let folder_metadata_cid_cloned = folder_metadata_cid.clone();

    let metadata_bytes = tokio::task::spawn_blocking(move || {
        download_from_ipfs(api_url, &folder_metadata_cid_cloned)
            .map_err(|e| format!("Failed to download folder metadata for CID {}: {}", folder_metadata_cid_cloned, e))
    })
    .await
    .map_err(|e| format!("Failed to execute blocking task for CID {}: {}", folder_metadata_cid, e))??;

    let file_entries: Vec<FileEntry> = serde_json::from_slice(&metadata_bytes)
        .map_err(|e| format!("Failed to parse folder metadata for CID {}: {}", folder_metadata_cid, e))?;

    let output_path = std::path::Path::new(&output_dir).join(&folder_name);
    if !output_path.exists() {
        fs::create_dir_all(&output_path)
            .map_err(|e| format!("Failed to create output directory {}: {}", output_path.display(), e))?;
    }

    for entry in file_entries {
        // Strip .ff extension from file name
        let file_name1 = entry.file_name.strip_suffix(".ff").unwrap_or(&entry.file_name);
        let file_name = file_name1.strip_suffix(".ff.ec_metadata").unwrap_or(&file_name1);
        let output_file_path = output_path.join(file_name);
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
    file_data: Vec<u8>,
    file_name: String,
    seed_phrase: String,
) -> Result<String, String> {
    let api_url = "http://127.0.0.1:5001";

    let file_entries_details = list_folder_contents(folder_name.clone(), folder_metadata_cid.clone()).await?;
    if file_entries_details.iter().any(|entry| entry.file_name == file_name) {
        return Err(format!("File '{}' already exists in folder '{}'.", file_name, folder_name));
    }

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

    let (_new_file_entry, new_file_pairs, new_folder_metadata_cid) = tokio::task::spawn_blocking({
        let api_url = api_url.to_string();
        let file_data_cloned = file_data.clone();
        let file_name_cloned = format!("{}{}", file_name.clone(), if file_name.clone().ends_with(".ff") { "" } else { ".ff" });
        move || {
            let temp_dir = tempdir().map_err(|e| format!("Failed to create temporary directory: {}", e))?;
            let temp_dir_path = temp_dir.path().to_path_buf();

            let temp_file_path = temp_dir_path.join(&file_name_cloned);
            fs::write(&temp_file_path, &file_data_cloned)
                .map_err(|e| format!("Failed to create temporary file: {}", e))?;
            
            let file_size = file_data_cloned.len();

            let _original_file_hash = {
                let mut hasher = Sha256::new();
                hasher.update(&file_data_cloned);
                format!("{:x}", hasher.finalize())
            };

            let file_cid = upload_to_ipfs(&api_url, temp_file_path.to_str().unwrap())
                .map_err(|e| format!("Failed to upload file to IPFS: {}", e))?;
            
            let new_file_entry = FileEntry {
                file_name: file_name_cloned.clone(),
                file_size,
                cid: file_cid.clone(),
            };
            let files_for_storage = vec![(file_name_cloned.clone(), file_cid.clone())];

            file_entries.push(new_file_entry.clone());
            let folder_metadata_path = temp_dir_path.join("folder_metadata.json");
            let folder_metadata = serde_json::to_string_pretty(&file_entries)
                .map_err(|e| format!("Failed to serialize folder metadata: {}", e))?;
            fs::write(&folder_metadata_path, folder_metadata.as_bytes())
                .map_err(|e| format!("Failed to write folder metadata to {}: {}", folder_metadata_path.display(), e))?;

            let new_folder_metadata_cid = upload_to_ipfs(&api_url, folder_metadata_path.to_str().unwrap())
                .map_err(|e| format!("Failed to upload folder metadata to IPFS: {}", e))?;

            Ok::<_, String>((new_file_entry, files_for_storage, new_folder_metadata_cid))
        }
    })
    .await
    .map_err(|e| format!("Failed to execute blocking task for file upload: {}", e))??;

    let meta_filename = format!("{}{}", folder_name, if folder_name.ends_with(".folder") { "" } else { ".folder" });
    let mut files_for_storage = vec![(meta_filename.clone(), new_folder_metadata_cid.clone())];
    files_for_storage.extend(new_file_pairs);

    let sync_folder = match get_public_sync_path().await {
        Ok(path) => PathBuf::from(path),
        Err(e) => return Err(format!("Failed to get public sync path: {}", e)),
    };

    println!("[add_file_to_public_folder] Submitting storage request for updated folder metadata: {}", meta_filename);

    let _unpin_result = delete_and_unpin_user_file_records_from_folder(&folder_name, &seed_phrase).await
    .map_err(|e| {
        if e.contains("RequestAlreadyExists") {
            format!("unpin request already exists for folder '{}'. Please try again later or update the existing request.", folder_name)
        } else {
            format!("Failed to request file storage: {}", e)
        }
    })?;

    // Submit storage request
    let storage_result = request_folder_storage(&meta_filename.clone(), &files_for_storage, api_url, &seed_phrase).await;
    match &storage_result {
        Ok(res) => {
            let temp_dir = tempdir().map_err(|e| e.to_string())?;
            let temp_path = temp_dir.path().join(&file_name);
            fs::write(&temp_path, file_data).map_err(|e| e.to_string())?;
            copy_to_sync_folder(
                &temp_path,
                &folder_name,
                &account_id,
                &new_folder_metadata_cid,
                &res,
                true,
                false,
                &meta_filename,
            ).await;
        
            println!("[add_file_to_public_folder] Storage request result: {}", res);
            println!("[add_file_to_public_folder] New folder metadata CID: {}", new_folder_metadata_cid);        
        },
        Err(e) => println!("[public_upload_folder] Storage request error: {}", e),
    }

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

    // Step 1: Download metadata
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

    let initial_len = file_entries.len();
    let file_name_variations = get_file_name_variations(&file_name);

    file_entries.retain(|entry| !file_name_variations.contains(&entry.file_name));
    println!("file_name {:?}, folder_name {:?}", file_name, folder_name);

    if file_entries.len() == initial_len {
        return Err(format!("File '{}' (or its variations) not found in folder '{}'.", file_name, folder_name));
    }

    // Step 2: Create new folder metadata and upload to IPFS
    let (new_folder_metadata_cid, file_cid_pairs) = tokio::task::spawn_blocking({
        let api_url = api_url.to_string();
        let file_entries_clone = file_entries.clone();
        move || {
            let temp_dir = tempdir().map_err(|e| format!("Failed to create temp dir: {}", e))?;
            let metadata_path = temp_dir.path().join("folder_metadata.json");

            let metadata_json = serde_json::to_string_pretty(&file_entries_clone)
                .map_err(|e| format!("Failed to serialize folder metadata: {}", e))?;
            fs::write(&metadata_path, metadata_json.as_bytes())
                .map_err(|e| format!("Failed to write metadata file: {}", e))?;

            let metadata_cid = upload_to_ipfs(&api_url, metadata_path.to_str().unwrap())
                .map_err(|e| format!("Failed to upload folder metadata: {}", e))?;

            let pairs = file_entries_clone
                .iter()
                .map(|entry| (entry.file_name.clone(), entry.cid.clone()))
                .collect::<Vec<(String, String)>>();

            Ok::<_, String>((metadata_cid, pairs))
        }
    })
    .await
    .map_err(|e| format!("Failed to spawn task for folder metadata update: {}", e))??;

    let meta_filename = format!("{}{}", folder_name, if folder_name.ends_with(".folder") { "" } else { ".folder" });

    println!(
        "[remove_file_from_public_folder] Submitting storage request for folder '{}'",
        meta_filename
    );

    // Step 3: Unpin old version
    let _unpin_result = delete_and_unpin_user_file_records_from_folder(&folder_name, &seed_phrase).await
        .map_err(|e| {
            if e.contains("RequestAlreadyExists") {
                format!("Unpin request already exists for '{}'", folder_name)
            } else {
                format!("Failed to unpin previous files: {}", e)
            }
        })?;

    // Step 4: Submit updated storage request with remaining files + metadata
    let mut files_for_storage = file_cid_pairs;
    files_for_storage.push((meta_filename.clone(), new_folder_metadata_cid.clone()));

    let storage_result = request_folder_storage(&meta_filename, &files_for_storage, api_url, &seed_phrase)
        .await
        .map_err(|e| format!("Failed to request folder storage: {}", e))?;

    // Step 5: Remove file from sync folder
    remove_from_sync_folder(
        &file_name,
        &folder_name,
        true,
        false,
        &meta_filename,
        &new_folder_metadata_cid,
        &account_id,
        &storage_result,
    )
    .await;

    println!("[remove_file_from_public_folder] ✅ Updated folder CID: {}", new_folder_metadata_cid);

    Ok(new_folder_metadata_cid)
}

#[tauri::command]
pub async fn encrypt_and_upload_file_sync(
    account_id: String,
    file_path: String,
    seed_phrase: String,
    encryption_key: Option<Vec<u8>>,
) -> Result<String, String> {
    println!("[encrypt_and_upload_file_sync] Processing file path: {:?}", file_path);
    let api_url = Arc::new("http://127.0.0.1:5001".to_string());
    let k = DEFAULT_K;
    let m = DEFAULT_M;
    let chunk_size = DEFAULT_CHUNK_SIZE;

    let file_path_p = Path::new(&file_path);
    let file_name = file_path_p
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Invalid file path, cannot extract file name".to_string())?
        .to_string();

    // Check if this file is already recorded in the sync database.
    if let Some(pool) = DB_POOL.get() {
        let is_synced: Option<(i32,)> = sqlx::query_as(
            "SELECT 1 FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private' LIMIT 1"
        )
        .bind(&account_id)
        .bind(&file_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error while checking sync status: {e}"))?;

        if is_synced.is_some() {
            let message = format!("File '{}' is already in sync DB, skipping upload.", file_name);
            println!("[encrypt_and_upload_file_sync] {}", message);
            return Err(message);
        }

        // Insert record into sync_folder_files
        sqlx::query(
            "INSERT INTO sync_folder_files (owner, cid, file_name, type, is_folder, block_number) VALUES (?, ?, ?, 'private', ?, 0)"
        )
        .bind(&account_id)
        .bind("pending")
        .bind(&file_name)
        .bind(false)
        .execute(pool)
        .await
        .map_err(|e| {
            eprintln!("[encrypt_and_upload_file_sync] Failed to insert record for '{}': {}", file_name, e);
            format!("DB error while inserting record: {}", e)
        })?;
        println!("[encrypt_and_upload_file_sync] Inserted record for '{}'", file_name);
    }

    if let Some(pool) = DB_POOL.get() {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1",
        )
        .bind(&account_id)
        .bind(&file_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| {
            // Remove record on error
            let _ = sqlx::query(
                "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'"
            )
            .bind(&account_id)
            .bind(&file_name)
            .execute(pool);
            format!("DB error: {e}")
        })?;
        if row.is_some() {
            // Remove record on error
            sqlx::query(
                "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'"
            )
            .bind(&account_id)
            .bind(&file_name)
            .execute(pool)
            .await
            .map_err(|e| format!("Failed to delete record for '{}': {}", file_name, e))?;
            return Err(format!("File '{}' already exists for this user.", file_name));
        }
    }

    let (file_data, original_file_hash, encrypted_size, file_id, shards_to_upload) = tokio::task::spawn_blocking({
        let file_path_clone = file_path.clone();
        move || {
            let file_data = std::fs::read(&file_path_clone).map_err(|e| e.to_string())?;
            
            let mut hasher = Sha256::new();
            hasher.update(&file_data);
            let original_file_hash = format!("{:x}", hasher.finalize());

            let to_process = tauri::async_runtime::block_on(encrypt_file(&file_data, encryption_key))?;
            let encrypted_size = to_process.len();
            
            let r = ReedSolomon::new(k, m - k).map_err(|e| format!("ReedSolomon error: {e}"))?;
            let file_id = Uuid::new_v4().to_string();
            let mut all_shards: Vec<(String, Vec<u8>)> = Vec::new();

            let chunks: Vec<Vec<u8>> = to_process.chunks(chunk_size).map(|c| {
                let mut chunk = c.to_vec();
                if chunk.len() < chunk_size { chunk.resize(chunk_size, 0); }
                chunk
            }).collect();
            
            for (orig_idx, chunk) in chunks.iter().enumerate() {
                let sub_block_size = (chunk.len() + k - 1) / k;
                let sub_blocks: Vec<Vec<u8>> = (0..k).map(|j| {
                    let start = j * sub_block_size;
                    let end = std::cmp::min(start + sub_block_size, chunk.len());
                    let mut sub_block = chunk[start..end].to_vec();
                    if sub_block.len() < sub_block_size { sub_block.resize(sub_block_size, 0); }
                    sub_block
                }).collect();
                
                let mut shards_data: Vec<Option<Vec<u8>>> = sub_blocks.into_iter().map(Some).collect();
                for _ in k..m { shards_data.push(Some(vec![0u8; sub_block_size])); }
                
                let mut shard_refs: Vec<_> = shards_data.iter_mut().map(|x| x.as_mut().unwrap().as_mut_slice()).collect();
                r.encode(&mut shard_refs).map_err(|e| format!("ReedSolomon encode error: {e}"))?;
                
                for (share_idx, shard_data) in shard_refs.iter().enumerate() {
                    let chunk_name = format!("{}_chunk_{}_{}.ec", file_id, orig_idx, share_idx);
                    all_shards.push((chunk_name, shard_data.to_vec()));
                }
            }

            Ok::<(Vec<u8>, String, usize, String, Vec<(String, Vec<u8>)>), String>((file_data, original_file_hash, encrypted_size, file_id, all_shards))
        }
    }).await.map_err(|e| {
        // Remove record on error
        if let Some(pool) = DB_POOL.get() {
            let _ = sqlx::query(
                "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'"
            )
            .bind(&account_id)
            .bind(&file_name)
            .execute(pool);
        }
        e.to_string()
    })??;

    let all_chunk_info = Arc::new(Mutex::new(Vec::new()));
    let chunk_pairs = Arc::new(Mutex::new(Vec::new()));

    stream::iter(shards_to_upload)
        .for_each_concurrent(Some(10), |(chunk_name, shard_data)| {
            let api_url_clone = Arc::clone(&api_url);
            let all_chunk_info_clone = Arc::clone(&all_chunk_info);
            let chunk_pairs_clone = Arc::clone(&chunk_pairs);

            async move {
                let shard_len = shard_data.len();
                match upload_bytes_to_ipfs(&api_url_clone, shard_data, &chunk_name).await {
                    Ok(cid) => {
                        let cid_info = CidInfo {
                            cid: cid.clone(),
                            filename: chunk_name.clone(),
                            size_bytes: shard_len,
                            encrypted: true,
                            size_formatted: format_file_size(shard_len),
                        };
                        let chunk_info = ChunkInfo {
                            name: chunk_name.clone(),
                            path: String::new(),
                            cid: cid_info,
                            original_chunk: 0,
                            share_idx: 0,
                            size: shard_len,
                        };
                        all_chunk_info_clone.lock().await.push(chunk_info);
                        chunk_pairs_clone.lock().await.push((chunk_name, cid));
                    },
                    Err(e) => eprintln!("[encrypt_and_upload_file_sync] Failed to upload chunk {}: {}", chunk_name, e),
                }
            }
        }).await;

    let final_chunk_info = all_chunk_info.lock().await.clone();
    let final_chunk_pairs = chunk_pairs.lock().await.clone();
    let file_extension = file_path_p.extension().and_then(|s| s.to_str()).unwrap_or_default().to_string();

    let metadata = Metadata {
        original_file: OriginalFileInfo {
            name: file_name.clone(),
            size: file_data.len(),
            hash: original_file_hash,
            extension: file_extension,
        },
        erasure_coding: ErasureCodingInfo { k, m, chunk_size, encrypted: true, file_id: file_id.clone(), encrypted_size },
        chunks: final_chunk_info,
        metadata_cid: None,
    };
    
    let metadata_json = serde_json::to_string_pretty(&metadata).map_err(|e| {
        // Remove record on error
        if let Some(pool) = DB_POOL.get() {
            let _ = sqlx::query(
                "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'"
            )
            .bind(&account_id)
            .bind(&file_name)
            .execute(pool);
        }
        e.to_string()
    })?;
    let metadata_filename = format!("{}_metadata.json", file_id);
    let metadata_cid = upload_bytes_to_ipfs(&api_url, metadata_json.as_bytes().to_vec(), &metadata_filename).await.map_err(|e| {
        // Remove record on error
        if let Some(pool) = DB_POOL.get() {
            let _ = sqlx::query(
                "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'"
            )
            .bind(&account_id)
            .bind(&file_name)
            .execute(pool);
        }
        e.to_string()
    })?;

    let meta_filename = format!("{}{}", file_name, ".ec_metadata");
    let mut files_for_storage = Vec::with_capacity(final_chunk_pairs.len() + 1);
    files_for_storage.push((meta_filename.clone(), metadata_cid.clone()));
    files_for_storage.extend(final_chunk_pairs);

    let storage_result = request_erasure_storage(&meta_filename, &files_for_storage, &api_url, &seed_phrase).await;
    match storage_result {
        Ok(res) => {
            copy_to_sync_and_add_to_db(file_path_p, &account_id, &metadata_cid, &res, false, false, &meta_filename, false).await;
            println!("[encrypt_and_upload_file_sync] Storage request successful: {}", res);
        },
        Err(e) => {
            // Remove record on error
            if let Some(pool) = DB_POOL.get() {
                sqlx::query(
                    "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'"
                )
                .bind(&account_id)
                .bind(&file_name)
                .execute(pool)
                .await
                .map_err(|e| format!("Failed to delete record for '{}': {}", file_name, e))?;
            }
            println!("[encrypt_and_upload_file_sync] Storage request error: {}", e);
            return Err(format!("Storage request error: {}", e));
        },
    }

    Ok(metadata_cid)
}

#[tauri::command]
pub async fn upload_file_public_sync(
    account_id: String,
    file_path: String,
    seed_phrase: String
) -> Result<String, String> {
    println!("[upload_file_public] file path is {:?}", file_path.clone());    
    let api_url = "http://127.0.0.1:5001";
    
    let file_name = Path::new(&file_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "Invalid file path, cannot extract file name".to_string())?;

    // Check if this file is already recorded in the sync database.
    if let Some(pool) = DB_POOL.get() {
        let is_synced: Option<(i32,)> = sqlx::query_as(
            "SELECT 1 FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public' LIMIT 1"
        )
        .bind(&account_id)
        .bind(&file_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error while checking sync status: {e}"))?;

        if is_synced.is_some() {
            let message = format!("File '{}' is already in sync DB, skipping upload.", file_name);
            println!("[upload_file_public_sync] {}", message);
            return Err(message);
        }

        // Insert record into sync_folder_files
        sqlx::query(
            "INSERT INTO sync_folder_files (owner, cid, file_name, type, is_folder, block_number) VALUES (?, ?, ?, 'public', ?, 0)"
        )
        .bind(&account_id)
        .bind("pending")
        .bind(&file_name)
        .bind(false)
        .execute(pool)
        .await
        .map_err(|e| {
            eprintln!("[upload_file_public_sync] Failed to insert record for '{}': {}", file_name, e);
            format!("DB error while inserting record: {}", e)
        })?;
        println!("[upload_file_public_sync] Inserted record for '{}'", file_name);
    }

    if let Some(pool) = DB_POOL.get() {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1"
        )
        .bind(&account_id)
        .bind(&file_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| {
            // Remove record on error
            let _ = sqlx::query(
                "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public'"
            )
            .bind(&account_id)
            .bind(&file_name)
            .execute(pool);
            format!("DB error: {e}")
        })?;
        if row.is_some() {
            // Remove record on error
            sqlx::query(
                "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public'"
            )
            .bind(&account_id)
            .bind(&file_name)
            .execute(pool)
            .await
            .map_err(|e| format!("Failed to delete record for '{}': {}", file_name, e))?;
            return Err(format!("File '{}' already exists for this user.", file_name));
        }
    }

    let file_path_cloned = file_path.clone();
    let api_url_cloned = api_url.to_string();
    let file_cid = tokio::task::spawn_blocking(move || {
        upload_to_ipfs(&api_url_cloned, &file_path_cloned)
    })
    .await
    .map_err(|e| {
        // Remove record on error
        if let Some(pool) = DB_POOL.get() {
            let _ = sqlx::query(
                "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public'"
            )
            .bind(&account_id)
            .bind(&file_name)
            .execute(pool);
        }
        format!("Task spawn error: {}", e)
    })?
    .map_err(|e| {
        // Remove record on error
        if let Some(pool) = DB_POOL.get() {
            let _ = sqlx::query(
                "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public'"
            )
            .bind(&account_id)
            .bind(&file_name)
            .execute(pool);
        }
        format!("Upload error: {}", e)
    })?;

    println!("[upload_file_public_sync] File CID: {}", file_cid);

    let storage_result = request_file_storage(&file_name.clone(), &file_cid, api_url, &seed_phrase).await;
    match &storage_result {
        Ok(res) => {
            copy_to_sync_and_add_to_db(Path::new(&file_path), &account_id, &file_cid, &res, true, false, &file_name, false).await;
            println!("[upload_file_public_sync] Storage request result: {}", res);
        },
        Err(e) => {
            // Remove record on error
            if let Some(pool) = DB_POOL.get() {
                sqlx::query(
                    "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public'"
                )
                .bind(&account_id)
                .bind(&file_name)
                .execute(pool)
                .await
                .map_err(|e| format!("Failed to delete record for '{}': {}", file_name, e))?;
            }
            println!("[upload_file_public_sync] Storage request error: {}", e);
            return Err(format!("Storage request error: {}", e));
        },
    }

    Ok(file_cid)
}

#[tauri::command]
pub async fn encrypt_and_upload_folder_sync(
    account_id: String,
    folder_path: String,
    seed_phrase: String,
    encryption_key: Option<Vec<u8>>,
) -> Result<String, String> {
    println!("[encrypt_and_upload_folder_sync] Encrypting and uploading folder: {}", folder_path);
    let api_url = Arc::new("http://127.0.0.1:5001".to_string());
    let k = DEFAULT_K;
    let m = DEFAULT_M;
    let chunk_size = DEFAULT_CHUNK_SIZE;

    let folder_path = Path::new(&folder_path);
    if !folder_path.is_dir() {
        return Err("Provided path is not a directory".to_string());
    }

    let folder_name = folder_path.file_name().and_then(|s| s.to_str()).unwrap_or_default().to_string();
    if folder_name.is_empty() {
        return Err("Invalid folder path, cannot extract folder name".to_string());
    }

    // Check if this folder is already recorded in the sync database.
    if let Some(pool) = DB_POOL.get() {
        let is_synced: Option<(i32,)> = sqlx::query_as(
            "SELECT 1 FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private' LIMIT 1"
        )
        .bind(&account_id)
        .bind(&folder_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error while checking sync status: {e}"))?;

        if is_synced.is_some() {
            let message = format!("Folder '{}' is already in sync DB, skipping upload.", folder_name);
            println!("[encrypt_and_upload_folder_sync] {}", message);
            return Err(message);
        }

        // Insert record into sync_folder_files
        sqlx::query(
            "INSERT INTO sync_folder_files (owner, cid, file_name, type, is_folder, block_number) VALUES (?, ?, ?, 'private', ?, 0)"
        )
        .bind(&account_id)
        .bind("pending")
        .bind(&folder_name)
        .bind(true)
        .execute(pool)
        .await
        .map_err(|e| {
            eprintln!("[encrypt_and_upload_folder_sync] Failed to insert record for '{}': {}", folder_name, e);
            format!("DB error while inserting record: {}", e)
        })?;
        println!("[encrypt_and_upload_folder_sync] Inserted record for '{}'", folder_name);
    }

    if let Some(pool) = DB_POOL.get() {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1",
        )
        .bind(&account_id)
        .bind(&folder_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| {
            // Remove record on error
            let _ = sqlx::query(
                "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'"
            )
            .bind(&account_id)
            .bind(&folder_name)
            .execute(pool);
            format!("DB error: {e}")
        })?;
        if row.is_some() {
            // Remove record on error
            sqlx::query(
                "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'"
            )
            .bind(&account_id)
            .bind(&folder_name)
            .execute(pool)
            .await
            .map_err(|e| format!("Failed to delete record for '{}': {}", folder_name, e))?;
            return Err(format!("Folder '{}' already exists for this user.", folder_name));
        }
    }

    let mut files_to_process = Vec::new();
    collect_files_recursively(folder_path, &mut files_to_process).map_err(|e| {
        // Remove record on error
        if let Some(pool) = DB_POOL.get() {
            let _ = sqlx::query(
                "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'"
            )
            .bind(&account_id)
            .bind(&folder_name)
            .execute(pool);
        }
        e.to_string()
    })?;
    println!("[encrypt_and_upload_folder_sync] Found {} files to process.", files_to_process.len());

    let encryption_key_arc = encryption_key.map(Arc::new);
    let processing_results = Arc::new(Mutex::new(Vec::new()));

    stream::iter(files_to_process)
        .for_each_concurrent(Some(8), |file_path| {
            let api_url_clone = Arc::clone(&api_url);
            let encryption_key_clone = encryption_key_arc.as_ref().map(Arc::clone);
            let results_clone = Arc::clone(&processing_results);
            let folder_path_clone = folder_path.to_path_buf();

            async move {
                let file_name_log = file_path.file_name().unwrap_or_default().to_string_lossy();
                println!("[+] Starting processing for file: {}", file_name_log);
                if let Err(e) = process_single_file_for_sync(
                    file_path.clone(),
                    folder_path_clone,
                    api_url_clone,
                    encryption_key_clone,
                    k, m, chunk_size,
                    results_clone,
                ).await {
                    eprintln!("[!] Error processing file {}: {}", file_name_log, e);
                }
            }
        }).await;

    println!("[encrypt_and_upload_folder_sync] Aggregating all results...");
    let final_results = Arc::try_unwrap(processing_results).unwrap().into_inner();
    
    let mut file_entries = Vec::with_capacity(final_results.len());
    let mut all_files_for_storage: Vec<(String, String)> = Vec::new();

    for result in final_results {
        file_entries.push(result.file_entry);
        all_files_for_storage.push((result.meta_filename, result.metadata_cid));
        all_files_for_storage.extend(result.chunk_pairs);
    }

    let folder_metadata_json = serde_json::to_string_pretty(&file_entries).map_err(|e| {
        // Remove record on error
        if let Some(pool) = DB_POOL.get() {
            let _ = sqlx::query(
                "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'"
            )
            .bind(&account_id)
            .bind(&folder_name)
            .execute(pool);
        }
        e.to_string()
    })?;
    let folder_metadata_filename = "folder_metadata.json";
    let folder_metadata_cid = upload_bytes_to_ipfs(&api_url, folder_metadata_json.as_bytes().to_vec(), folder_metadata_filename).await.map_err(|e| {
        // Remove record on error
        if let Some(pool) = DB_POOL.get() {
            let _ = sqlx::query(
                "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'"
            )
            .bind(&account_id)
            .bind(&folder_name)
            .execute(pool);
        }
        e.to_string()
    })?;
    println!("[encrypt_and_upload_folder_sync] Uploaded folder metadata with CID: {}", folder_metadata_cid);

    let meta_folder_name = format!("{}{}", folder_name, ".folder.ec_metadata");
    all_files_for_storage.push((meta_folder_name.clone(), folder_metadata_cid.clone()));

    let storage_result = request_erasure_storage(&meta_folder_name, &all_files_for_storage, &api_url, &seed_phrase).await;
    match storage_result {
        Ok(res) => {
            copy_to_sync_and_add_to_db(
                folder_path,
                &account_id,
                &folder_metadata_cid,
                &res,
                false,
                true,
                &meta_folder_name,
                false, 
            ).await;
            println!("[encrypt_and_upload_folder_sync] Storage request result: {}", res);
        }
        Err(e) => {
            // Remove record on error
            if let Some(pool) = DB_POOL.get() {
                sqlx::query(
                    "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'private'"
                )
                .bind(&account_id)
                .bind(&folder_name)
                .execute(pool)
                .await
                .map_err(|e| format!("Failed to delete record for '{}': {}", folder_name, e))?;
            }
            println!("[encrypt_and_upload_folder_sync] Storage request error: {}", e);
            return Err(format!("Storage request error: {}", e));
        },
    }

    Ok(folder_metadata_cid)
}

async fn process_single_file_for_sync(
    file_path: PathBuf,
    base_folder_path: PathBuf,
    api_url: Arc<String>,
    encryption_key: Option<Arc<Vec<u8>>>,
    k: usize,
    m: usize,
    chunk_size: usize,
    results: Arc<Mutex<Vec<FileProcessingResultSync>>>,
) -> Result<(), String> {
    let file_data = tokio::fs::read(&file_path).await.map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(&file_data);
    let original_file_hash = format!("{:x}", hasher.finalize());

    let to_process = encrypt_file(&file_data, encryption_key.map(|k| (*k).clone())).await?;
    
    let encrypted_size = to_process.len();
    
    let (file_id, shards_to_upload) = tokio::task::spawn_blocking(move || {
        let r = ReedSolomon::new(k, m - k).map_err(|e| format!("ReedSolomon error: {e}"))?;
        let file_id = Uuid::new_v4().to_string();
        let mut shards_to_upload: Vec<(String, Vec<u8>)> = Vec::new();

        let chunks: Vec<Vec<u8>> = to_process.chunks(chunk_size).map(|c| {
            let mut chunk = c.to_vec();
            if chunk.len() < chunk_size { chunk.resize(chunk_size, 0); }
            chunk
        }).collect();

        for (orig_idx, chunk) in chunks.iter().enumerate() {
            let sub_block_size = (chunk.len() + k - 1) / k;
            let sub_blocks: Vec<Vec<u8>> = (0..k).map(|j| {
                let start = j * sub_block_size;
                let end = std::cmp::min(start + sub_block_size, chunk.len());
                let mut sub_block = chunk[start..end].to_vec();
                if sub_block.len() < sub_block_size { sub_block.resize(sub_block_size, 0); }
                sub_block
            }).collect();
            
            let mut shards_data: Vec<Option<Vec<u8>>> = sub_blocks.into_iter().map(Some).collect();
            for _ in k..m { shards_data.push(Some(vec![0u8; sub_block_size])); }
            
            let mut shard_refs: Vec<_> = shards_data.iter_mut().map(|x| x.as_mut().unwrap().as_mut_slice()).collect();
            r.encode(&mut shard_refs).map_err(|e| format!("ReedSolomon encode error: {e}"))?;
            
            for (share_idx, shard_data) in shard_refs.iter().enumerate() {
                let chunk_name = format!("{}_chunk_{}_{}.ec", file_id, orig_idx, share_idx);
                shards_to_upload.push((chunk_name, shard_data.to_vec()));
            }
        }
        Ok::<(String, Vec<(String, Vec<u8>)>), String>((file_id, shards_to_upload))
    }).await.map_err(|e| e.to_string())??;

    let chunk_pairs = Arc::new(Mutex::new(Vec::new()));
    stream::iter(shards_to_upload)
        .for_each_concurrent(None, |(name, data)| {
            let api_url_clone = Arc::clone(&api_url);
            let pairs_clone = Arc::clone(&chunk_pairs);
            async move {
                match upload_bytes_to_ipfs(&api_url_clone, data, &name).await {
                    Ok(cid) => pairs_clone.lock().await.push((name, cid)),
                    Err(e) => eprintln!("Failed to upload shard {}: {}", name, e),
                }
            }
        }).await;
    
    let file_name_str = file_path.file_name().unwrap().to_string_lossy().to_string();
    let file_extension = file_path.extension().and_then(|s| s.to_str()).unwrap_or_default().to_string();
    
    let metadata = Metadata {
        original_file: OriginalFileInfo {
            name: file_name_str.clone(),
            size: file_data.len(),
            hash: original_file_hash,
            extension: file_extension
        },
        erasure_coding: ErasureCodingInfo {
            k, m, chunk_size, encrypted: true,
            file_id: file_id.clone(),
            encrypted_size,
        },
        chunks: vec![],
        metadata_cid: None,
    };
    
    let metadata_json = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
    let metadata_filename = format!("{}_metadata.json", file_id);
    let metadata_cid = upload_bytes_to_ipfs(&api_url, metadata_json.as_bytes().to_vec(), &metadata_filename).await?;

    let meta_filename_for_storage = format!("{}{}", file_name_str, ".ec_metadata");

    let result = FileProcessingResultSync {
        file_entry: FileEntry {
            file_name: meta_filename_for_storage.clone(),
            file_size: file_data.len(),
            cid: metadata_cid.clone(),
        },
        meta_filename: meta_filename_for_storage.clone(),
        metadata_cid,
        chunk_pairs: Arc::try_unwrap(chunk_pairs).unwrap().into_inner(),
    };
    
    results.lock().await.push(result);
    println!("[✔] Finished processing for file: {}", file_name_str);
    Ok(())
}

#[tauri::command]
pub async fn public_upload_folder_sync(
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

    // Check if this folder is already recorded in the sync database.
    if let Some(pool) = DB_POOL.get() {
        let is_synced: Option<(i32,)> = sqlx::query_as(
            "SELECT 1 FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public' LIMIT 1"
        )
        .bind(&account_id)
        .bind(&folder_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error while checking sync status: {e}"))?;

        if is_synced.is_some() {
            let message = format!("Folder '{}' is already in sync DB, skipping upload.", folder_name);
            println!("[public_upload_folder_sync] {}", message);
            return Err(message);
        }

        // Insert record into sync_folder_files
        sqlx::query(
            "INSERT INTO sync_folder_files (owner, cid, file_name, type, is_folder, block_number) VALUES (?, ?, ?, 'public', ?, 0)"
        )
        .bind(&account_id)
        .bind("pending")
        .bind(&folder_name)
        .bind(true)
        .execute(pool)
        .await
        .map_err(|e| {
            eprintln!("[public_upload_folder_sync] Failed to insert record for '{}': {}", folder_name, e);
            format!("DB error while inserting record: {}", e)
        })?;
        println!("[public_upload_folder_sync] Inserted record for '{}'", folder_name);
    }

    if let Some(pool) = DB_POOL.get() {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT file_name FROM user_profiles WHERE owner = ? AND file_name = ? LIMIT 1"
        )
        .bind(&account_id)
        .bind(&folder_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| {
            // Remove record on error
            let _ = sqlx::query(
                "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public'"
            )
            .bind(&account_id)
            .bind(&folder_name)
            .execute(pool);
            format!("DB error: {e}")
        })?;
        if row.is_some() {
            // Remove record on error
            sqlx::query(
                "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public'"
            )
            .bind(&account_id)
            .bind(&folder_name)
            .execute(pool)
            .await
            .map_err(|e| format!("Failed to delete record for '{}': {}", folder_name, e))?;
            return Err(format!("Folder '{}' already exists for this user.", folder_name));
        }
    }

    let folder_path_cloned = folder_path.to_path_buf();
    let api_url_cloned = api_url.to_string();
    let folder_name_cloned = folder_name.clone(); // Clone to avoid move
    let (folder_name_from_task, folder_metadata_cid, file_cid_pairs) = tokio::task::spawn_blocking(move || {
        let mut file_entries = Vec::new();
        let mut files = Vec::new();
        let mut file_cid_pairs: Vec<(String, String)> = Vec::new();
        let _ = collect_files_recursively(&folder_path_cloned, &mut files).map_err(|e| e.to_string())?;
        let temp_dir = tempdir().map_err(|e| e.to_string())?;
        for file_path in files {
            let relative_path = file_path.strip_prefix(&folder_path_cloned)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .to_string();
            let file_name = file_path
                .file_name()
                .ok_or_else(|| "Invalid file path".to_string())?
                .to_string_lossy()
                .to_string();

            let ipfs_file_name = format!("{}{}", file_name, if file_name.ends_with(".ff") { "" } else { ".ff" });
        
            let file_data = fs::read(&file_path).map_err(|e| e.to_string())?;
            let file_size = file_data.len();
            let mut hasher = Sha256::new();
            hasher.update(&file_data);
            let _original_file_hash = format!("{:x}", hasher.finalize());
            let file_cid = upload_to_ipfs(&api_url_cloned, file_path.to_str().unwrap())
                .map_err(|e| e.to_string())?;
            file_entries.push(FileEntry {
                file_name: relative_path,
                file_size,
                cid: file_cid.clone(),
            });
            file_cid_pairs.push((ipfs_file_name.clone(), file_cid.clone()));
        }
        println!("[public_upload_folder_sync] ✅ Folder processing done");
        let folder_metadata_path = temp_dir.path().join("folder_metadata.json");
        let folder_metadata = serde_json::to_string_pretty(&file_entries)
            .map_err(|e| e.to_string())?;
        fs::write(&folder_metadata_path, folder_metadata.as_bytes())
            .map_err(|e| e.to_string())?;
        let folder_metadata_cid = upload_to_ipfs(
            &api_url_cloned,
            folder_metadata_path.to_str().unwrap(),
        ).map_err(|e| e.to_string())?;
        Ok::<(String, String, Vec<(String,String)>), String>((folder_name_cloned, folder_metadata_cid, file_cid_pairs))
    })
    .await
    .map_err(|e| {
        // Remove record on error
        if let Some(pool) = DB_POOL.get() {
            let _ = sqlx::query(
                "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public'"
            )
            .bind(&account_id)
            .bind(&folder_name)
            .execute(pool);
        }
        e.to_string()
    })??;
    let meta_folder_name = format!("{}{}", folder_name_from_task, if folder_name_from_task.ends_with(".folder") { "" } else { ".folder" });
    // Build files array: folder metadata + all file CIDs
    let mut files_for_storage = Vec::with_capacity(file_cid_pairs.len() + 1);
    files_for_storage.push((meta_folder_name.clone(), folder_metadata_cid.clone()));
    files_for_storage.extend(file_cid_pairs);
    // Submit storage request
    let storage_result = request_folder_storage(&meta_folder_name.clone(), &files_for_storage, api_url, &seed_phrase).await;
    match &storage_result {
        Ok(res) => {
            copy_to_sync_and_add_to_db(Path::new(&folder_path), &account_id, &folder_metadata_cid, &res, true, true, &meta_folder_name.clone(), false).await;
            println!("[public_upload_folder_sync] Storage request result: {}", res);
        },
        Err(e) => {
            // Remove record on error
            if let Some(pool) = DB_POOL.get() {
                sqlx::query(
                    "DELETE FROM sync_folder_files WHERE owner = ? AND file_name = ? AND type = 'public'"
                )
                .bind(&account_id)
                .bind(&folder_name)
                .execute(pool)
                .await
                .map_err(|e| format!("Failed to delete record for '{}': {}", folder_name, e))?;
            }
            println!("[public_upload_folder_sync] Storage request error: {}", e);
            return Err(format!("Storage request error: {}", e));
        },
    }
    Ok(folder_metadata_cid)
}

#[tauri::command]
pub async fn list_folder_contents(
    folder_name: String,
    folder_metadata_cid: String,
) -> Result<Vec<FileDetail>, String> {
    let api_url = "http://127.0.0.1:5001";
    println!("[list_folder_contents] Downloading folder folder_name: {} for CID: {}", folder_name, folder_metadata_cid);
    let metadata_bytes = download_from_ipfs_async(api_url, &folder_metadata_cid)
        .await
        .map_err(|e| format!("Failed to download folder manifest for CID {}: {}", folder_metadata_cid, e))?;
    let file_entries = parse_folder_metadata(&metadata_bytes, &folder_metadata_cid).await?;

    let pool = DB_POOL.get().ok_or("DB pool not initialized")?;

    let folder_record = sqlx::query(
        r#"
        SELECT 
            source, 
            miner_ids, 
            created_at, 
            last_charged_at
        FROM user_profiles 
        WHERE file_name = ?
        LIMIT 1
        "#
    )
    .bind(&folder_name)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("DB query failed for folder {}: {}", folder_name, e))?;

    let files_in_folder: Vec<FileDetail> = file_entries
        .into_iter()
        .filter(|entry| !entry.file_name.ends_with(".ec"))
        .map(|file_entry| {
            let mut file_detail = if let Some(row) = &folder_record {
                FileDetail {
                    file_name: file_entry.file_name.clone(),
                    cid: file_entry.cid,
                    source: row.get::<Option<String>, _>("source").unwrap_or_default(),
                    file_hash: String::new(),
                    miner_ids: row.get::<Option<String>, _>("miner_ids").unwrap_or_default(),
                    file_size: file_entry.file_size.unwrap_or(0),
                    created_at: row.get::<Option<i64>, _>("created_at").unwrap_or(0).to_string(),
                    last_charged_at: row.get::<Option<i64>, _>("last_charged_at").unwrap_or(0).to_string(),
                }
            } else {
                FileDetail {
                    file_name: file_entry.file_name.clone(),
                    cid: file_entry.cid,
                    source: String::new(),
                    file_hash: String::new(),
                    miner_ids: String::new(),
                    file_size: file_entry.file_size.unwrap_or(0),
                    created_at: 0.to_string(),
                    last_charged_at: 0.to_string(),
                }
            };
            file_detail.file_name = clean_file_name(&file_detail.file_name);
            file_detail
        })
        .collect();

    Ok(files_in_folder)
}

async fn parse_folder_metadata(bytes: &[u8], original_cid: &str) -> Result<Vec<FolderFileEntry>, String> {
    if let Ok(folder_refs) = serde_json::from_slice::<Vec<FolderFileEntry>>(bytes) {
        if let Some(folder_metadata) = folder_refs.iter().find(|f| {
            f.file_name.ends_with(".folder") || 
            f.file_name.ends_with("-folder") ||
            f.file_name.ends_with(".folder.ec_metadata") ||
            f.file_name.ends_with("-folder.ec_metadata")
        }) {
            let api_url = "http://127.0.0.1:5001";
            let metadata_bytes = download_from_ipfs_async(api_url, &folder_metadata.cid)
                .await
                .map_err(|e| format!("Failed to download actual folder metadata from CID {}: {}", folder_metadata.cid, e))?;
            return serde_json::from_slice(&metadata_bytes)
                .map_err(|e| format!("Failed to parse actual folder metadata from CID {}: {}", folder_metadata.cid, e));
        }else {
            return Ok(folder_refs)
        }
    }

    Err(format!("Unknown folder metadata format for CID {}", original_cid))
}

fn clean_file_name(name: &str) -> String {
    if let Some(stripped) = name.strip_suffix(".ff.ec_metadata") {
        // Remove ".ff.ec_metadata" and add ".ec_metadata" back
        format!("{}.ec_metadata", stripped)
    } else if let Some(stripped) = name.strip_suffix(".ff") {
        // Just remove ".ff"
        stripped.to_string()
    } else {
        // Return as is if no matching suffix
        name.to_string()
    }
}
