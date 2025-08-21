use crate::utils::{
    accounts::{
        encrypt_file, decrypt_file
    },
    ipfs::{
        download_from_ipfs, download_from_ipfs_async, upload_to_ipfs, upload_to_ipfs_async, upload_bytes_to_ipfs,
    },
    file_operations::{request_erasure_storage, copy_to_sync_and_add_to_db, request_folder_storage, get_file_name_variations,
        request_file_storage , remove_from_sync_folder, copy_to_sync_folder, delete_and_unpin_user_file_records_from_folder}
};
use futures::TryFutureExt;
use uuid::Uuid;
use std::fs;
use reed_solomon_erasure::galois_8::ReedSolomon;
use sha2::{Digest, Sha256};
use tempfile::tempdir;
use crate::DB_POOL;
use crate::commands::types::*;
use crate::constants::folder_sync::{DEFAULT_K, DEFAULT_M, DEFAULT_CHUNK_SIZE};
use crate::sync_shared::{collect_files_recursively, collect_folders_recursively, collect_files_in_folder};
use std::path::{Path, PathBuf};
use base64::{Engine as _, engine::general_purpose};
use sqlx::Row;
use crate::utils::sync::get_public_sync_path;
use futures::{future, stream::{self, StreamExt}};
use std::sync::Arc;
use tokio::sync::Mutex;
use crate::utils::file_operations::sanitize_name;
use rayon::prelude::*;
use crate::utils::folder_tree::FolderNode;
use std::collections::HashMap;
use tauri::{AppHandle, Manager};
use crate::events::AppEvent;
use tauri::Emitter;
use tokio::process::Command;

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

// Drops the first segment and returns None if the remaining path is empty
fn normalize_subfolder_path(mut subfolder_path: Option<Vec<String>>) -> Option<Vec<String>> {
    if let Some(mut path) = subfolder_path.take() {
        // Drop the main/root folder name if present
        if !path.is_empty() {
            path.remove(0);
        }
        // Sanitize the remaining segments
        let cleaned: Vec<String> = path
            .into_iter()
            .map(|segment| sanitize_name(&segment))
            .filter(|s| !s.is_empty())
            .collect();
        if cleaned.is_empty() { None } else { Some(cleaned) }
    } else {
        None
    }
}

#[tauri::command]
pub async fn encrypt_and_upload_file(
    account_id: String,
    file_path: String,
    seed_phrase: String,
    encryption_key: Option<String>,
) -> Result<String, String> {
    let path = std::path::PathBuf::from(&file_path);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    println!("Processing file: {:?}", file_name);

    // Instead of writing Vec<u8>, we just use the existing file path
    copy_to_sync_and_add_to_db(
        &path,
        &account_id,
        "",
        "",
        false,
        false,
        &file_name,
        true,
    )
    .await;

    println!("[encrypt_and_upload_file] Storage request successful");

    Ok(file_name)
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

    // Special handling when the 'CID' indicates S3 source
    if metadata_cid == "s3" {
        // Extract filename from the output path
        let file_name = std::path::Path::new(&output_file)
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("Failed to extract file name from output path")?
            .to_string();

        // Lookup source from user_profiles
        let pool = DB_POOL.get().ok_or("DB pool not initialized")?;
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT source FROM user_profiles WHERE file_name = ? ORDER BY id DESC LIMIT 1",
        )
        .bind(&file_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error while fetching source: {}", e))?;

        let source = match row {
            Some((src,)) => src,
            None => return Err(format!("No source found in DB for file '{}'", file_name)),
        };

        // If source exists locally, copy; otherwise pull from S3 using aws cli
        if std::path::Path::new(&source).exists() {
            std::fs::copy(&source, &output_file)
                .map_err(|e| format!("Failed to copy from '{}' to '{}': {}", source, output_file, e))?;
            println!("[download_and_decrypt_file] Copied locally from '{}' to '{}'", source, output_file);
            return Ok(());
        } else {
            // Execute: aws s3 cp <source> <output> --endpoint-url https://s3.hippius.com
            let status = Command::new("aws")
                .arg("s3")
                .arg("cp")
                .arg(&source)
                .arg(&output_file)
                .arg("--endpoint-url")
                .arg("https://s3.hippius.com")
                .status()
                .await
                .map_err(|e| format!("Failed to spawn aws s3 cp: {}", e))?;

            if !status.success() {
                return Err(format!(
                    "aws s3 cp failed for source '{}' to '{}' with status {:?}",
                    source, output_file, status.code()
                ));
            }

            println!(
                "[download_and_decrypt_file] Downloaded from S3 '{}' to '{}' via aws cli",
                source, output_file
            );
            return Ok(());
        }
    }

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
    println!("[download_and_decrypt_file] Downloaded metadata");
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

    let folder_name = folder_path.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();


    copy_to_sync_and_add_to_db(
        folder_path, 
        &account_id, 
        "", 
        "", 
        false, 
        true, 
        &folder_name, 
        true
    ).await;

    println!("[✔] Folder storage request successful");
    Ok(folder_name)
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
            file_name: format!("{}{}", file_name, ".ec_metadata"),
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
        .map_err(|e| format!("Failed to download folder manifest: {}", e))?;
    let file_entries: Vec<FileEntry> = serde_json::from_slice(&folder_manifest_bytes)
        .map_err(|e| format!("Failed to parse folder manifest (CID: {}): {}", folder_metadata_cid, e))?;
    println!("[i] Folder manifest contains {} entries.", file_entries.len());

    let output_root_path = Path::new(&output_dir).join(&folder_name);
    tokio::fs::create_dir_all(&output_root_path).await.map_err(|e| format!("Failed to create output directory: {}", e))?;

    stream::iter(file_entries)
        .for_each_concurrent(Some(8), |entry| {
            let api_url_clone = Arc::clone(&api_url);
            let output_root_clone = output_root_path.clone();
            let encryption_key_clone = encryption_key_bytes.as_ref().map(Arc::clone);

            async move {
                println!("[download_and_decrypt_folder] Processing entry with CID: {} to: {:?}", 
                    entry.cid, output_root_clone.join(&entry.file_name));

                // Check if the entry is a subfolder metadata (new hierarchical logic)
                if entry.file_name.ends_with(".folder.ec_metadata") {
                    let mut subfolder_name = entry.file_name.trim_end_matches(".s.folder.ec_metadata");
                    // Remove leading '.' and '.s' if present
                    let cleaned_name = subfolder_name.trim_end_matches(".folder.ec_metadata");
                    let subfolder_path = output_root_clone.join(cleaned_name);
                    if let Err(e) = tokio::fs::create_dir_all(&subfolder_path).await {
                        eprintln!("[!] Failed to create subfolder {}: {}", subfolder_name, e);
                        return;
                    }
                    // Recursively call download_and_decrypt_folder for subfolder
                    if let Err(e) = download_and_decrypt_folder(
                        String::new(), // _account_id not needed for recursion
                        entry.cid.clone(),
                        subfolder_name.to_string(),
                        output_root_clone.to_string_lossy().to_string(),
                        encryption_key_clone.as_ref().map(|k| base64::engine::general_purpose::STANDARD.encode(&**k)),
                    ).await {
                        eprintln!("[!] Failed to download/decrypt subfolder {}: {}", subfolder_name, e);
                    }
                } else if entry.file_name.ends_with(".ff.ec_metadata") {
                    // Handle regular file in root folder
                    let file_metadata_bytes = match download_from_ipfs_async(&api_url_clone, &entry.cid).await {
                        Ok(bytes) => bytes,
                        Err(e) => {
                            eprintln!("[!] Failed to download metadata for {} (CID: {}): {}", 
                                entry.file_name, entry.cid, e);
                            return;
                        }
                    };

                    let clean_file_name = entry.file_name.trim_end_matches(".ff.ec_metadata");
                    let output_file_path = output_root_clone.join(clean_file_name);

                    if let Some(parent) = output_file_path.parent() {
                        if let Err(e) = tokio::fs::create_dir_all(parent).await {
                            eprintln!("[!] Failed to create directory for {}: {}", clean_file_name, e);
                            return;
                        }
                    }

                    match reconstruct_and_decrypt_single_file(
                        file_metadata_bytes,
                        output_file_path.clone(),
                        api_url_clone,
                        encryption_key_clone,
                    ).await {
                        Ok(()) => println!("[✔] Successfully downloaded and decrypted {}", clean_file_name),
                        Err(e) => eprintln!("[!] Failed to download/decrypt {}: {}", clean_file_name, e),
                    }
                } else {
                    // Handle regular file in root folder
                    let file_metadata_bytes = match download_from_ipfs_async(&api_url_clone, &entry.cid).await {
                        Ok(bytes) => bytes,
                        Err(e) => {
                            eprintln!("[!] Failed to download metadata for {} (CID: {}): {}", 
                                entry.file_name, entry.cid, e);
                            return;
                        }
                    };

                    let clean_file_name = entry.file_name.trim_end_matches(".ff.ec_metadata");
                    let output_file_path = output_root_clone.join(clean_file_name);

                    if let Some(parent) = output_file_path.parent() {
                        if let Err(e) = tokio::fs::create_dir_all(parent).await {
                            eprintln!("[!] Failed to create directory for {}: {}", clean_file_name, e);
                            return;
                        }
                    }

                    match reconstruct_and_decrypt_single_file(
                        file_metadata_bytes,
                        output_file_path.clone(),
                        api_url_clone,
                        encryption_key_clone,
                    ).await {
                        Ok(()) => println!("[✔] Successfully downloaded and decrypted {}", clean_file_name),
                        Err(e) => eprintln!("[!] Failed to download/decrypt {}: {}", clean_file_name, e),
                    }
                }
            }
        }).await;

    println!("[✔] Folder download process complete.");
    Ok(())
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
                if bytes_collected == chunk_bytes_needed {
                    break;
                }
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


#[tauri::command]
pub async fn add_file_to_private_folder(
    account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    file_path: String,
    seed_phrase: String,
    encryption_key: Option<String>,
    subfolder_path: Option<Vec<String>>, 
) -> Result<String, String> {
    let path = std::path::PathBuf::from(&file_path);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    println!("[+] Adding file '{}' to folder '{}'", file_name, folder_name);

    let folder_name = sanitize_name(&folder_name);
    let normalized_subfolder = normalize_subfolder_path(subfolder_path.clone());
    let sanitized_folder_name = sanitize_name(&folder_name);

    let final_file_name = if file_name.ends_with(".ff.ec_metadata") {
        file_name.clone()
    } else {
        format!("{}.ff.ec_metadata", file_name)
    };
    let sanitized_file_name = sanitize_name(&final_file_name);

    // Build sync subfolder path (if any)
    let sync_subfolder_path = normalized_subfolder.as_ref().map(|path_vec| {
        let mut full_path = std::path::PathBuf::from(&sanitized_folder_name);
        for segment in path_vec {
            full_path.push(segment);
        }
        full_path.to_string_lossy().to_string()
    });

    // Use the original file path instead of writing file_data
    copy_to_sync_folder(
        &path,
        &sanitized_folder_name,
        &account_id,
        "",
        "",
        false,
        false,
        &folder_name,
        sync_subfolder_path,
    )
    .await;

    println!("[✔] Successfully added file. New folder manifest CID");
    Ok(folder_name)
}

#[tauri::command]
pub async fn remove_file_from_private_folder(
    account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    file_name: String,
    seed_phrase: String,
    subfolder_path: Option<Vec<String>>,
) -> Result<String, String> {
    println!("[+] Removing file '{}' from folder '{}'", file_name, folder_name);
    let folder_name = sanitize_name(&folder_name);
   

    let normalized_subfolder = normalize_subfolder_path(subfolder_path.clone());
    println!("subfolder_path: {:?} cid: {} normalized_subfolder: {:?}", 
        subfolder_path, folder_metadata_cid, normalized_subfolder);

    let final_file_name = if file_name.ends_with(".ff.ec_metadata") {
        file_name.clone()
    } else {
        format!("{}.ff.ec_metadata", file_name)
    };
    let sanitized_file_name = sanitize_name(&final_file_name);

    let sync_subfolder_path = normalized_subfolder.as_ref().map(|path_vec| {
        let mut full_path = std::path::PathBuf::from(&folder_name);
        for segment in path_vec {
            full_path.push(segment);
        }
        full_path.to_string_lossy().to_string()
    });

    remove_from_sync_folder(
        &sanitized_file_name,
        &folder_name,
        false,
        false,
        "",
        &folder_name,
        &account_id,
        "",
        sync_subfolder_path,
    ).await;

    println!("[✔] Successfully removed file.");
    Ok(folder_name) 
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
                    },
                    Err(e) => eprintln!("Failed to upload chunk {}: {}", chunk_name, e),
                }
            }
        }).await;
    
    let final_chunk_info = Arc::try_unwrap(all_chunk_info).map_err(|_| "Failed to unwrap Arc for chunk info".to_string())?.into_inner();
    let final_chunk_pairs = Arc::try_unwrap(chunk_pairs).map_err(|_| "Failed to unwrap Arc for chunk pairs".to_string())?.into_inner();

    Ok((final_chunk_info, final_chunk_pairs))
}

#[tauri::command]
pub async fn download_and_decrypt_single_file(
    metadata_cid: String,
    output_file: String,
    api_url: Arc<String>,
    encryption_key: Option<Arc<Vec<u8>>>,
) -> Result<(), String> {
    let metadata_bytes = download_from_ipfs_async(&api_url, &metadata_cid).await
        .map_err(|e| format!("Failed to download metadata: {}", e))?;
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
                if bytes_collected == chunk_bytes_needed {
                    break;
                }
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

    tokio::fs::write(&output_file, &decrypted_data).await.map_err(|e| e.to_string())?;
    println!("[✔] Successfully downloaded and wrote file to {}", output_file);
    Ok(())
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
    seed_phrase: String,
) -> Result<String, String> {
    let path = std::path::PathBuf::from(&file_path);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    println!("[upload_file_public] processing file: {:?}", file_name);

    // Use existing file directly instead of writing from Vec<u8>
    copy_to_sync_and_add_to_db(
        &path,
        &account_id,
        "",
        "",
        true,
        false,
        &file_name,
        true,
    )
    .await;

    Ok(file_name)
}

#[tauri::command]
pub async fn download_file_public(
    file_cid: String,
    output_file: String,
) -> Result<(), String> {
    let api_url = "http://127.0.0.1:5001";
    
    println!("[download_file_public] Downloading file with CID: {} to: {}", file_cid, output_file);

    // Special handling when the 'CID' indicates S3 source
    if file_cid == "s3" {
        // Extract filename from the output path
        let file_name = std::path::Path::new(&output_file)
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("Failed to extract file name from output path")?
            .to_string();

        // Lookup source from user_profiles
        let pool = DB_POOL.get().ok_or("DB pool not initialized")?;
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT source FROM user_profiles WHERE file_name = ? ORDER BY id DESC LIMIT 1",
        )
        .bind(&file_name)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error while fetching source: {}", e))?;

        let source = match row {
            Some((src,)) => src,
            None => return Err(format!("No source found in DB for file '{}'", file_name)),
        };

        // If source exists locally, copy; otherwise pull from S3 using aws cli
        if std::path::Path::new(&source).exists() {
            std::fs::copy(&source, &output_file)
                .map_err(|e| format!("Failed to copy from '{}' to '{}': {}", source, output_file, e))?;
            println!("[download_file_public] Copied locally from '{}' to '{}'", source, output_file);
            return Ok(());
        } else {
            // Execute: aws s3 cp <source> <output> --endpoint-url https://s3.hippius.com
            let status = Command::new("aws")
                .arg("s3")
                .arg("cp")
                .arg(&source)
                .arg(&output_file)
                .arg("--endpoint-url")
                .arg("https://s3.hippius.com")
                .status()
                .await
                .map_err(|e| format!("Failed to spawn aws s3 cp: {}", e))?;

            if !status.success() {
                return Err(format!(
                    "aws s3 cp failed for source '{}' to '{}' with status {:?}",
                    source, output_file, status.code()
                ));
            }

            println!(
                "[download_file_public] Downloaded from S3 '{}' to '{}' via aws cli",
                source, output_file
            );
            return Ok(());
        }
    }
    
    // Default IPFS path for non-S3
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
    
    copy_to_sync_and_add_to_db(Path::new(&folder_path), &account_id, "", "", true, true, &folder_name.clone(), true).await;

    Ok(folder_name)
}

// Recursively upload a folder for public upload, using .folder for root and .s.folder for all subfolders
fn upload_folder_recursive_public(
    folder_path: &Path,
    api_url: &str,
    is_root: bool,
    all_files: &mut Vec<(String, String)>,
) -> Result<(String, String, usize), String> {
    use std::fs;
    use crate::commands::types::FileEntry;
    use tempfile::tempdir;
    let mut file_entries = Vec::new();
    let mut files = Vec::new();
    let mut subfolders = Vec::new();

    // Collect files and subfolders
    for entry in fs::read_dir(folder_path).map_err(|e| format!("Failed to read dir: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();

        // Get file or folder name safely
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue, // skip if can't get valid name
        };
        
        // Skip hidden files/folders
        if name.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            subfolders.push(path);
        } else {
            files.push(path);
        }
    }

    // Upload files in this folder
    let mut total_size = 0usize;
    for file_path in &files {
        let file_name = file_path.file_name()
            .ok_or("Invalid file path".to_string())?
            .to_string_lossy();
        if file_name.ends_with(".folder") || file_name.ends_with(".s.folder") {
            continue;
        }
        let ipfs_name = if file_name.ends_with(".ff") {
            file_name.to_string()
        } else {
            format!("{}.ff", file_name)
        };
        let cid = upload_to_ipfs(api_url, file_path.to_str().unwrap())
            .map_err(|e| format!("Failed to upload file: {}", e))?;
        let file_size = file_path.metadata()
            .map_err(|e| format!("Failed to get file metadata: {}", e))?
            .len() as usize;
        file_entries.push(FileEntry {
            file_name: ipfs_name.clone(),
            file_size,
            cid: cid.clone(),
        });
        all_files.push((ipfs_name, cid));
        total_size += file_size;
    }

    // Recursively process subfolders
    for subfolder_path in &subfolders {
        let (meta_name, meta_cid, subfolder_size) = upload_folder_recursive_public(
            subfolder_path,
            api_url,
            false,
            all_files,
        )?;
        // Add subfolder metadata to this folder's entries
        file_entries.push(FileEntry {
            file_name: meta_name.clone(),
            file_size: subfolder_size,
            cid: meta_cid.clone(),
        });
        all_files.push((meta_name, meta_cid));
        total_size += subfolder_size;
    }

    // Write and upload metadata for this folder
    let metadata_name = if is_root {
        format!("{}.folder", folder_path.file_name().unwrap().to_string_lossy())
    } else {
        format!("{}.s.folder", folder_path.file_name().unwrap().to_string_lossy())
    };
    let temp_dir = tempdir().map_err(|e| format!("Failed to create temp dir: {}", e))?;
    let metadata_path = temp_dir.path().join("metadata.json");
    fs::write(&metadata_path, serde_json::to_vec(&file_entries)
        .map_err(|e| format!("Failed to serialize metadata: {}", e))?)
        .map_err(|e| format!("Failed to write metadata: {}", e))?;
    let metadata_cid = upload_to_ipfs(api_url, metadata_path.to_str().unwrap())
        .map_err(|e| format!("Failed to upload metadata: {}", e))?;
    Ok((metadata_name, metadata_cid, total_size))
}

#[tauri::command]
pub async fn public_download_folder(
    _account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    output_dir: String,
) -> Result<(), String> {
    public_download_folder_inner(
        &_account_id,
        &folder_metadata_cid,
        &folder_name,
        &output_dir,
    ).await
}

async fn public_download_folder_inner(
    _account_id: &str,
    folder_metadata_cid: &str,
    folder_name: &str,
    output_dir: &str,
) -> Result<(), String> {
    let api_url = "http://127.0.0.1:5001";
    
    // Download folder metadata (blocking for sync with legacy code)
    let metadata_bytes = tokio::task::spawn_blocking({
        let api_url = api_url.to_string();
        let folder_metadata_cid = folder_metadata_cid.to_string();
        move || {
            download_from_ipfs(&api_url, &folder_metadata_cid)
                .map_err(|e| format!("Failed to download folder metadata for CID {}: {}", folder_metadata_cid, e))
        }
    })
    .await
    .map_err(|e| format!("Failed to execute blocking task: {}", e))??;

    let file_entries: Vec<FileEntry> = serde_json::from_slice(&metadata_bytes)
        .map_err(|e| format!("Failed to parse folder metadata: {}", e))?;

    let output_path = std::path::Path::new(output_dir).join(folder_name);
    if !output_path.exists() {
        fs::create_dir_all(&output_path)
            .map_err(|e| format!("Failed to create output directory {}: {}", output_path.display(), e))?;
    }

    // Recursively process folder entries using public suffix conventions
    for entry in &file_entries {
        if entry.file_name.ends_with(".folder") || entry.file_name.ends_with(".s.folder") {
            // Subfolder: recursively download
            // Remove leading ".s" from subfolder name if present
            let mut subfolder_name = if entry.file_name.ends_with(".s.folder") {
                entry.file_name.strip_suffix(".s.folder").unwrap_or(&entry.file_name)
            } else {
                entry.file_name.strip_suffix(".folder").unwrap_or(&entry.file_name)
            };
            if let Some(stripped) = subfolder_name.strip_prefix(".s") {
                subfolder_name = stripped;
            }
            let subfolder_metadata_cid = &entry.cid;
            if let Err(e) = Box::pin(public_download_folder_inner(
                _account_id,
                subfolder_metadata_cid,
                subfolder_name,
                &output_path.to_string_lossy()
            )).await {
                eprintln!("[public_download_folder] Failed to download subfolder {}: {}", subfolder_name, e);
            }
        } else if entry.file_name.ends_with(".ff") {
            // Regular file
            let clean_file_name = entry.file_name.strip_suffix(".ff").unwrap_or(&entry.file_name);
            let output_file_path = output_path.join(clean_file_name);
            if let Some(parent) = output_file_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent directory {}: {}", parent.display(), e))?;
            }
            if let Err(e) = download_file_public(entry.cid.clone(), output_file_path.to_string_lossy().to_string()).await {
                eprintln!("[public_download_folder] Failed to download file {}: {}", clean_file_name, e);
            }
        } else {
            // Log or ignore unexpected entries
            println!("[public_download_folder] Skipping unknown entry: {}", entry.file_name);
        }
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
    subfolder_path: Option<Vec<String>>,
) -> Result<String, String> {
    use std::sync::Arc;

    let path = std::path::PathBuf::from(&file_path);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    println!("[+] Adding file '{}' to folder '{}'", file_name, folder_name);

    let api_url = Arc::new("http://127.0.0.1:5001".to_string());
    let folder_name = sanitize_name(&folder_name);
    let file_name = sanitize_name(&file_name);

    let normalized_subfolder = normalize_subfolder_path(subfolder_path.clone());
    println!(
        "[add_file_to_public_folder] subfolder_path: {:?}, cid: {}, normalized_subfolder: {:?}", 
        subfolder_path, folder_metadata_cid, normalized_subfolder
    );

    // Build sync subfolder path (if any)
    let sync_subfolder_path = normalized_subfolder.as_ref().map(|path_vec| {
        let mut full_path = std::path::PathBuf::from(&folder_name);
        for segment in path_vec {
            full_path.push(segment);
        }
        full_path.to_string_lossy().to_string()
    });

    // Use the original file path instead of writing file_data
    copy_to_sync_folder(
        &path,
        &folder_name,
        &account_id,
        "",
        "",
        true,
        false,
        &folder_name,
        sync_subfolder_path,
    )
    .await;

    println!("file added to folder successfully");

    Ok(folder_name)
}

#[tauri::command]
pub async fn remove_file_from_public_folder(
    account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    file_name: String,
    seed_phrase: String,
    subfolder_path: Option<Vec<String>>,
) -> Result<String, String> {
    let api_url = Arc::new("http://127.0.0.1:5001".to_string());
    let folder_name = sanitize_name(&folder_name);
    
    
    let normalized_subfolder = normalize_subfolder_path(subfolder_path.clone());

    // Remove from sync folder
    let sync_subfolder_path = normalized_subfolder.as_ref().map(|path_vec| {
        let mut full_path = std::path::PathBuf::from(&folder_name);
        for segment in path_vec {
            full_path.push(segment);
        }
        full_path.to_string_lossy().to_string()
    });

    let final_file_name = if file_name.ends_with(".ff") {
        file_name.clone()
    } else {
        format!("{}.ff", file_name)
    };

    remove_from_sync_folder(
        &final_file_name,
        &folder_name,
        true,
        false,
        &file_name,
        "",
        &account_id,
        "",
        sync_subfolder_path,
    ).await;
    
    Ok(folder_name)
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
        let mut shards_to_upload: Vec<(String, Vec<u8>, usize, usize)> = Vec::new();

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
                shards_to_upload.push((chunk_name, shard_data.to_vec(), orig_idx, share_idx));
            }
        }
        Ok::<(String, Vec<(String, Vec<u8>, usize, usize)>), String>((file_id, shards_to_upload))
    }).await.map_err(|e| e.to_string())??;

    let all_chunk_info = Arc::new(Mutex::new(Vec::new()));
    let chunk_pairs = Arc::new(Mutex::new(Vec::new()));

    stream::iter(shards_to_upload)
        .for_each_concurrent(None, |(name, data, orig_idx, share_idx)| {
            let api_url_clone = Arc::clone(&api_url);
            let chunk_info_clone = Arc::clone(&all_chunk_info);
            let pairs_clone = Arc::clone(&chunk_pairs);
            let data_clone = data.clone();
            async move {
                match upload_bytes_to_ipfs(&api_url_clone, data_clone, &name).await {
                    Ok(cid) => {
                        let chunk_info = ChunkInfo {
                            name: name.clone(),
                            path: String::new(),
                            cid: CidInfo {
                                cid: cid.clone(),
                                filename: name.clone(),
                                size_bytes: data.len(),
                                encrypted: true,
                                size_formatted: format_file_size(data.len()),
                            },
                            original_chunk: orig_idx,
                            share_idx,
                            size: data.len(),
                        };
                        chunk_info_clone.lock().await.push(chunk_info);
                        pairs_clone.lock().await.push((name, cid));
                    },
                    Err(e) => eprintln!("Failed to upload shard {}: {}", name, e),
                }
            }
        }).await;

    let file_name_str = file_path.file_name().unwrap().to_string_lossy().to_string();
    let file_extension = file_path.extension().and_then(|s| s.to_str()).unwrap_or_default().to_string();
    
    let final_chunk_info = all_chunk_info.lock().await.clone();
    
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
        chunks: final_chunk_info,
        metadata_cid: None,
    };
    
    let metadata_json = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
    let metadata_filename = format!("{}_metadata.json", file_id);
    let metadata_cid = upload_bytes_to_ipfs(&api_url, metadata_json.as_bytes().to_vec(), &metadata_filename).await?;

    let meta_filename_for_storage = format!("{}{}", file_name_str, ".ff.ec_metadata");

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
pub async fn list_folder_contents(
    folder_name: String,
    folder_metadata_cid: String,
    main_folder_name: Option<String>,
    mut subfolder_path: Option<Vec<String>>,
) -> Result<Vec<FileDetail>, String> {
    let api_url = "http://127.0.0.1:5001";
    println!("subfolder_path {:?}", subfolder_path);
    println!("[list_folder_contents] fetching folder folder_name: {} for CID: {}", folder_name, folder_metadata_cid);
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
    .bind(main_folder_name.as_ref().unwrap_or(&folder_name))
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("DB query failed for folder {}: {}", folder_name, e))?;
    println!("files_in_folder , {:?}", file_entries);
    let files_in_folder: Vec<FileDetail> = file_entries
        .into_iter()
        .filter(|entry| !entry.file_name.ends_with(".ec"))
        .map(|file_entry| {
            let mut file_detail = if let Some(row) = &folder_record {
                let mut source_path = row.get::<Option<String>, _>("source").unwrap_or_default();
                println!("source_path: {}", source_path);
                if source_path != "Hippius" {
                    // Build a base directory from source and sanitized subfolder path (excluding main folder)
                    let mut base_dir = PathBuf::from(&source_path);
                    if let Some(ref mut path_vector) = subfolder_path {
                        // If the first segment is main folder, drop it
                        if let Some(main) = main_folder_name.as_ref().or(Some(&folder_name)) {
                            if !path_vector.is_empty() && sanitize_name(&path_vector[0]) == sanitize_name(main) {
                                let _ = path_vector.remove(0);
                            }
                        } else if !path_vector.is_empty() {
                            let _ = path_vector.remove(0);
                        }
                        for segment in path_vector.iter() {
                            let sanitized_segment = sanitize_name(segment);
                            if !sanitized_segment.is_empty() {
                                base_dir.push(sanitized_segment);
                            }
                        }
                    }

                    // Append the sanitized entry name (works for files and folders)
                    let sanitized_entry_name = sanitize_name(&file_entry.file_name);
                    let candidate_path = base_dir.join(&sanitized_entry_name);
                    let candidate_str = candidate_path.to_string_lossy().to_string();
                    println!("constructed candidate path: {}", candidate_str);
                    if candidate_path.exists() {
                        source_path = candidate_str;
                    }else{
                        source_path = "Hippius".to_string()
                    }
                }
                FileDetail {
                    file_name: file_entry.file_name.clone(),
                    cid: file_entry.cid.clone(),
                    source: source_path,
                    file_hash: hex::encode(file_entry.cid),
                    miner_ids: row.get::<Option<String>, _>("miner_ids").unwrap_or_default(),
                    file_size: file_entry.file_size.unwrap_or(0),
                    created_at: row.get::<Option<i64>, _>("created_at").unwrap_or(0).to_string(),
                    last_charged_at: row.get::<Option<i64>, _>("last_charged_at").unwrap_or(0).to_string(),
                }
            } else {
                FileDetail {
                    file_name: file_entry.file_name.clone(),
                    cid: file_entry.cid.clone(),
                    source: "Hippius".to_string(),
                    file_hash: hex::encode(file_entry.cid),
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
            return Ok(folder_refs)
    }
    Err(format!("Unknown folder metadata format for CID {}", original_cid))
}

fn clean_file_name(name: &str) -> String {
    if let Some(stripped) = name.strip_suffix(".ff.ec_metadata") {
        // Remove ".ff.ec_metadata" and add ".ec_metadata" back
        format!("{}.ec_metadata", stripped)
    } else if let Some(stripped) = name.strip_suffix(".s.folder.ec_metadata") {
        // Remove ".s.folder.ec_metadata" and add ".ec_metadata" back
        format!("{}.folder", stripped)
    } else if let Some(stripped) = name.strip_suffix(".s.folder") {
        // Remove ".s.folder" and add ".folder" back
        format!("{}.folder", stripped)
    } else if let Some(stripped) = name.strip_suffix(".ff") {
        // Just remove ".ff"
        stripped.to_string()
    } else {
        // Return as is if no matching suffix
        name.to_string()
    }
}

#[tauri::command]
pub async fn add_folder_to_public_folder(
    account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    folder_path: String,
    seed_phrase: String,
    subfolder_path: Option<Vec<String>>,
) -> Result<String, String> {
    let folder_name = sanitize_name(&folder_name);
    let folder_path_obj = Path::new(&folder_path);


    // Main logic
    let normalized_subfolder = normalize_subfolder_path(subfolder_path.clone());

   
    let sanitized_folder_name = sanitize_name(&folder_name);
    let sync_subfolder_path = normalized_subfolder.as_ref().map(|path_vec| {
        let mut full_path = std::path::PathBuf::from(&sanitized_folder_name);
        for segment in path_vec {
            full_path.push(segment);
        }
        full_path.to_string_lossy().to_string()
    });

    copy_to_sync_folder(
        folder_path_obj,
        &sanitized_folder_name,
        &account_id,
        "",
        "",
        true,
        true,
        &folder_name,
        sync_subfolder_path,
    )
    .await;

    Ok(folder_name)
}

#[tauri::command]
pub async fn remove_folder_from_public_folder(
    account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    folder_to_remove: String,
    seed_phrase: String,
    subfolder_path: Option<Vec<String>>,
) -> Result<String, String> {
    use std::sync::Arc;
    let api_url = Arc::new("http://127.0.0.1:5001".to_string());
    let folder_name = sanitize_name(&folder_name);
    let folder_to_remove = sanitize_name(&folder_to_remove);

    // Main logic
    let normalized_subfolder = normalize_subfolder_path(subfolder_path.clone());

    let sanitized_folder_name = sanitize_name(&folder_name);
    let sync_subfolder_path = normalized_subfolder.as_ref().map(|path_vec| {
        let mut full_path = std::path::PathBuf::from(&sanitized_folder_name);
        for segment in path_vec {
            full_path.push(segment);
        }
        full_path.to_string_lossy().to_string()
    });

    remove_from_sync_folder(
        &folder_to_remove,
        &folder_name,
        true,
        true,
        &folder_name,
        "",
        &account_id,
        "",
        sync_subfolder_path,
    ).await;

    Ok(folder_name)
}

#[tauri::command]
pub async fn add_folder_to_private_folder(
    account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    folder_path: String,
    seed_phrase: String,
    encryption_key: Option<String>,
    subfolder_path: Option<Vec<String>>,
) -> Result<String, String> {
    println!("calling private folder add function");
    let folder_name = sanitize_name(&folder_name);
    let folder_path_obj = Path::new(&folder_path);

    // --- Main logic ---
    let normalized_subfolder = normalize_subfolder_path(subfolder_path.clone());

    let sanitized_folder_name = sanitize_name(&folder_name);
    let sync_subfolder_path = normalized_subfolder.as_ref().map(|path_vec| {
        let mut full_path = std::path::PathBuf::from(&sanitized_folder_name);
        for segment in path_vec {
            full_path.push(segment);
        }
        full_path.to_string_lossy().to_string()
    });

    copy_to_sync_folder(
        folder_path_obj,
        &sanitized_folder_name,
        &account_id,
        "",
        "",
        false,
        true,
        &folder_name,
        sync_subfolder_path,
    ).await;

    Ok(folder_name)
}

#[tauri::command]
pub async fn remove_folder_from_private_folder(
    account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    folder_to_remove: String,
    seed_phrase: String,
    encryption_key: Option<String>,
    subfolder_path: Option<Vec<String>>,
) -> Result<String, String> {
    let folder_name = sanitize_name(&folder_name);
    let folder_to_remove = sanitize_name(&folder_to_remove);

    // Main logic
    let normalized_subfolder = normalize_subfolder_path(subfolder_path.clone());

    let sanitized_folder_name = sanitize_name(&folder_name);
    let sync_subfolder_path = normalized_subfolder.as_ref().map(|path_vec| {
        let mut full_path = std::path::PathBuf::from(&sanitized_folder_name);
        for segment in path_vec {
            full_path.push(segment);
        }
        full_path.to_string_lossy().to_string()
    });

    remove_from_sync_folder(
        &folder_to_remove,
        &sanitized_folder_name,
        false,
        true,
        &folder_name,
        "",
        &account_id,
        "",
        sync_subfolder_path,
    )
    .await;

    Ok(folder_name)
}