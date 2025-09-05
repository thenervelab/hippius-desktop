#![allow(unused_imports)]
use crate::{
    DB_POOL,
    utils::{
        accounts::{
            decrypt_file
        },
        ipfs::{
            download_from_ipfs, download_from_ipfs_async,
        },
        file_operations::{ copy_to_sync_and_add_to_db,
             remove_from_sync_folder, copy_to_sync_folder}
    }
};
use fs_extra;
use std::fs;
use reed_solomon_erasure::galois_8::ReedSolomon;
use sha2::{Digest, Sha256};
use crate::commands::types::*;
use std::path::{Path, PathBuf};
use base64::{Engine as _, engine::general_purpose};
use futures::stream::{self, StreamExt};
use std::sync::Arc;
use crate::utils::file_operations::sanitize_name;
use std::collections::HashMap;
use tauri::Manager;
use tokio::process::Command;
use crate::commands::node::get_aws_binary_path;
use std::collections::HashSet;

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
    _seed_phrase: String,
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
    source: String,
) -> Result<(), String> {
    println!("[download_and_decrypt_file] Downloading file with CID: {} to: {}", metadata_cid, output_file);
    let api_url = "http://127.0.0.1:5001".to_string(); // Convert to owned String

    // Dynamically get the AWS binary path
    let aws_binary_path = match get_aws_binary_path().await {
        Ok(path) => {
            println!("[download_and_decrypt_file] Found AWS binary at: {}", path.display());
            path
        }
        Err(e) => {
            eprintln!("[download_and_decrypt_file] Failed to get AWS binary path: {}, falling back to system PATH", e);
            // Fall back to checking system PATH with which crate
            if let Ok(path) = which::which(if cfg!(windows) { "aws.exe" } else { "aws" }) {
                println!("[download_and_decrypt_file] Found AWS in system PATH at: {}", path.display());
                path
            } else {
                eprintln!("[download_and_decrypt_file] AWS CLI not found in system PATH or custom location");
                return Err("AWS CLI not found".to_string());
            }
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

    let cid_hex = hex::encode(metadata_cid.as_bytes());
    let file_hash_hex = cid_hex.clone();

    // Check database for the file's source
    let pool = DB_POOL.get().ok_or("Database pool not initialized")?;
    let is_s3_source = sqlx::query_scalar::<_, String>(
        "SELECT main_req_hash FROM user_profiles WHERE cid = ?"
    )
    .bind(&file_hash_hex)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to query database: {}", e))?
    .map_or(false, |hash| hash == "s3");
    
    // Special handling when the 'CID' indicates S3 source
    if is_s3_source || metadata_cid == "s3" || metadata_cid == "local" {
        // If source exists locally, copy; otherwise pull from S3 using aws cli
        if Path::new(&source).exists() {
            std::fs::copy(&source, &output_file)
                .map_err(|e| format!("Failed to copy from '{}' to '{}': {}", source, output_file, e))?;
            println!("[download_and_decrypt_file] Copied locally from '{}' to '{}'", source, output_file);
            return Ok(());
        } else {
            // Execute: aws s3 cp <source> <output> --endpoint-url https://s3.hippius.com
            let status = Command::new(&aws_binary_path)
                .env("AWS_PAGER", "")
                .env("PATH", &dynamic_path)
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
    _seed_phrase: String,
    _source: String,
) -> Result<String, String> {
    println!("[+] Starting encrypted upload for folder: {}", folder_path);
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

#[tauri::command]
pub async fn download_and_decrypt_folder(
    _account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    output_dir: String,
    encryption_key: Option<String>,
    source: String,
) -> Result<(), String> {
    println!("[+] Starting download for folder with manifest CID: {}", folder_metadata_cid);

    let cid_hex = hex::encode(folder_metadata_cid.as_bytes());
    let folder_hash_hex = cid_hex.clone();

    // Check database for the file's source
    let pool = DB_POOL.get().ok_or("Database pool not initialized")?;
    let is_s3_source = sqlx::query_scalar::<_, String>(
        "SELECT main_req_hash FROM user_profiles WHERE cid = ?"
    )
    .bind(&folder_hash_hex)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to query database: {}", e))?
    .map_or(false, |hash| hash == "s3");    

    if is_s3_source || folder_metadata_cid == "s3" || folder_metadata_cid == "local" {
        println!("[+] Handling S3 folder download for source: {}", source);
        let source_path = Path::new(&source);
        let destination_path = Path::new(&output_dir).join(&folder_name);

        // Dynamically get the AWS binary path
        let aws_binary_path = match get_aws_binary_path().await {
            Ok(path) => {
                println!("[download_and_decrypt_folder] Found AWS binary at: {}", path.display());
                path
            }
            Err(e) => {
                eprintln!("[download_and_decrypt_folder] Failed to get AWS binary path: {}, falling back to system PATH", e);
                if let Ok(path) = which::which(if cfg!(windows) { "aws.exe" } else { "aws" }) {
                    println!("[download_and_decrypt_folder] Found AWS in system PATH at: {}", path.display());
                    path
                } else {
                    eprintln!("[download_and_decrypt_folder] AWS CLI not found in system PATH or custom location");
                    return Err("AWS CLI not found".to_string());
                }
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

        // First, check if the source path exists locally
        if source_path.exists() && source_path.is_dir() {
            println!("[i] Source folder exists locally at '{}'. Copying...", source);
            
            let options = fs_extra::dir::CopyOptions::new().overwrite(true);
            fs_extra::dir::copy(source_path, &output_dir, &options)
                .map_err(|e| format!("Failed to copy directory locally: {}", e))?;

            println!("[✔] Successfully copied folder from '{}' to '{}'", source, destination_path.display());
            return Ok(());
        } else {
            println!("[i] Source is an S3 path. Downloading with AWS CLI...");

            if let Some(parent) = destination_path.parent() {
                tokio::fs::create_dir_all(parent).await
                   .map_err(|e| format!("Failed to create output directory: {}", e))?;
           }

            let status = Command::new(&aws_binary_path)
                .env("AWS_PAGER", "")
                .env("PATH", &dynamic_path)
                .arg("s3")
                .arg("cp")
                .arg(&source) 
                .arg(&destination_path) 
                .arg("--recursive") 
                .arg("--endpoint-url")
                .arg("https://s3.hippius.com")
                .status()
                .await
                .map_err(|e| format!("Failed to spawn 'aws s3 cp --recursive': {}", e))?;

            if !status.success() {
                return Err(format!(
                    "aws s3 cp --recursive failed for source '{}' with status {:?}",
                    source, status.code()
                ));
            }

            println!("[✔] Successfully downloaded folder from S3 '{}' to '{}'", source, destination_path.display());
            return Ok(());
        }
    }

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
                    let subfolder_name = entry.file_name.trim_end_matches(".s.folder.ec_metadata");
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
                        String::new() // Pass an empty string as source is not needed for IPFS subfolder
                    ).await {
                        eprintln!("[!] Failed to download/decrypt subfolder {}: {}", subfolder_name, e);
                    }
                } else { // Combined the two identical `else if` and `else` blocks
                    // Handle regular file
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
    _folder_metadata_cid: String,
    folder_name: String,
    file_path: String,
    _seed_phrase: String,
    _encryption_key: Option<String>,
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
    _seed_phrase: String,
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

#[tauri::command]
pub fn write_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upload_file_public(
    account_id: String,
    file_path: String,
    _seed_phrase: String,
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
    source: String,
) -> Result<(), String> {
    let api_url = "http://127.0.0.1:5001";

    println!("[download_file_public] Start: file_cid='{}', output_file='{}'", file_cid, output_file);

    let cid_hex = hex::encode(file_cid.as_bytes());
    let file_hash_hex = cid_hex.clone();

    // Check database for the file's source
    let pool = DB_POOL.get().ok_or("Database pool not initialized")?;
    let is_s3_source = sqlx::query_scalar::<_, String>(
        "SELECT main_req_hash FROM user_profiles WHERE cid = ?"
    )
    .bind(&file_hash_hex)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to query database: {}", e))?
    .map_or(false, |hash| hash == "s3");    

    // Special handling when the 'CID' indicates S3 source
    if is_s3_source || file_cid == "s3" || file_cid == "local" {
        println!("[download_file_public] returned source='{}'", source);

        // Dynamically get the AWS binary path
        let aws_binary_path = match get_aws_binary_path().await {
            Ok(path) => {
                println!("[download_file_public] Found AWS binary at: {}", path.display());
                path
            }
            Err(e) => {
                eprintln!("[download_file_public] Failed to get AWS binary path: {}, falling back to system PATH", e);
                if let Ok(path) = which::which(if cfg!(windows) { "aws.exe" } else { "aws" }) {
                    println!("[download_file_public] Found AWS in system PATH at: {}", path.display());
                    path
                } else {
                    eprintln!("[download_file_public] AWS CLI not found in system PATH or custom location");
                    return Err("[download_file_public] AWS CLI not found".to_string());
                }
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

        // If source exists locally, copy; otherwise pull from S3 using aws cli
        let source_exists = Path::new(&source).exists();
        println!("[download_file_public] Source exists locally? {}", source_exists);
        if source_exists {
            std::fs::copy(&source, &output_file)
                .map_err(|e| format!("[download_file_public] Failed to copy from '{}' to '{}': {}", source, output_file, e))?;
            println!("[download_file_public] Copied locally from '{}' to '{}'. Done.", source, output_file);
            return Ok(());
        } else {
            // Execute: aws s3 cp <source> <output> --endpoint-url https://s3.hippius.com
            println!("[download_file_public] Invoking 'aws s3 cp' for source='{}' -> '{}'", source, output_file);
            let status = Command::new(&aws_binary_path)
                .env("AWS_PAGER", "")
                .env("PATH", &dynamic_path)
                .arg("s3")
                .arg("cp")
                .arg(&source) 
                .arg(&output_file) 
                .arg("--endpoint-url")
                .arg("https://s3.hippius.com")
                .status()
                .await
                .map_err(|e| format!("[download_file_public] Failed to spawn aws s3 cp (is AWS CLI on PATH?): {}", e))?;

            if !status.success() {
                return Err(format!(
                    "[download_file_public] aws s3 cp failed for source '{}' to '{}' with status {:?}",
                    source, output_file, status.code()
                ));
            }

            println!(
                "[download_file_public] Downloaded from S3 '{}' to '{}' via aws cli. Done.",
                source, output_file
            );
            return Ok(());
        }
    }
    
    // Default IPFS path for non-S3
    println!("[download_file_public] Proceeding with IPFS download. api_url='{}', cid='{}'", api_url, file_cid);
    let file_cid_cloned = file_cid.clone();
    let api_url_cloned = api_url.to_string();
    println!("[download_file_public] Spawning blocking task to download from IPFS");
    let file_data = tokio::task::spawn_blocking(move || {
        download_from_ipfs(&api_url_cloned, &file_cid_cloned)
    })
    .await
    .map_err(|e| format!("[download_file_public] Task join error during IPFS download: {}", e))?
    .map_err(|e| format!("[download_file_public] Failed to download file from IPFS (cid='{}'): {}", file_cid, e))?;
    println!("[download_file_public] IPFS download complete. Bytes received={}", file_data.len());
    
    println!("[download_file_public] Writing {} bytes to '{}'", file_data.len(), output_file);
    std::fs::write(&output_file, &file_data)
        .map_err(|e| format!("[download_file_public] Failed to write file to '{}': {}", output_file, e))?;
    
    println!("[download_file_public] Success: File written to '{}'", output_file);
    Ok(())
}

#[tauri::command]
pub async fn public_upload_folder(
    account_id: String,
    folder_path: String,
    _seed_phrase: String,
) -> Result<String, String> {
    
    let folder_path = Path::new(&folder_path);
    if !folder_path.is_dir() {
        return Err("Provided path is not a directory".to_string());
    }

    let folder_name = folder_path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "Invalid folder path, cannot extract folder name".to_string())?;
    
    copy_to_sync_and_add_to_db(Path::new(&folder_path), &account_id, "", "", true, true, &folder_name.clone(), true).await;

    Ok(folder_name)
}

#[tauri::command]
pub async fn public_download_folder(
    _account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    output_dir: String,
    source: String,
) -> Result<(), String> {
    let cid_hex = hex::encode(folder_metadata_cid.as_bytes());
    let folder_hash_hex = cid_hex.clone();

    // Check database for the file's source
    let pool = DB_POOL.get().ok_or("Database pool not initialized")?;
    let is_s3_source = sqlx::query_scalar::<_, String>(
        "SELECT main_req_hash FROM user_profiles WHERE cid = ?"
    )
    .bind(&folder_hash_hex)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to query database: {}", e))?
    .map_or(false, |hash| hash == "s3");
    
    if is_s3_source || folder_metadata_cid == "s3" || folder_metadata_cid == "local" {
        println!("[+] Handling S3 folder download for source: {}", source);
        let source_path = Path::new(&source);
        let destination_path = Path::new(&output_dir).join(&folder_name);

        // Dynamically get the AWS binary path
        let aws_binary_path = match get_aws_binary_path().await {
            Ok(path) => {
                println!("[public_download_folder] Found AWS binary at: {}", path.display());
                path
            }
            Err(e) => {
                eprintln!("[public_download_folder] Failed to get AWS binary path: {}, falling back to system PATH", e);
                if let Ok(path) = which::which(if cfg!(windows) { "aws.exe" } else { "aws" }) {
                    println!("[public_download_folder] Found AWS in system PATH at: {}", path.display());
                    path
                } else {
                    eprintln!("[public_download_folder] AWS CLI not found in system PATH or custom location");
                    return Err("[public_download_folder] AWS CLI not found".to_string());
                }
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

        // First, check if the source path exists locally
        if source_path.exists() && source_path.is_dir() {
            println!("[i] Source folder exists locally at '{}'. Copying...", source);
            
            let options = fs_extra::dir::CopyOptions::new().overwrite(true);
            fs_extra::dir::copy(source_path, &output_dir, &options)
                .map_err(|e| format!("Failed to copy directory locally: {}", e))?;

            println!("[✔] Successfully copied folder from '{}' to '{}'", source, destination_path.display());
            return Ok(());
        } else {
            // If it's not local, download from S3 using AWS CLI
            println!("[i] Source is an S3 path. Downloading with AWS CLI...");

            // Ensure the parent directory for the output exists
            if let Some(parent) = destination_path.parent() {
                tokio::fs::create_dir_all(parent).await
                   .map_err(|e| format!("Failed to create output directory: {}", e))?;
           }

            let status = Command::new(&aws_binary_path)
                .env("AWS_PAGER", "")
                .env("PATH", &dynamic_path)
                .arg("s3")
                .arg("cp")
                .arg(&source) 
                .arg(&destination_path) 
                .arg("--recursive") 
                .arg("--endpoint-url")
                .arg("https://s3.hippius.com")
                .status()
                .await
                .map_err(|e| format!("Failed to spawn 'aws s3 cp --recursive': {}", e))?;

            if !status.success() {
                return Err(format!(
                    "aws s3 cp --recursive failed for source '{}' with status {:?}",
                    source, status.code()
                ));
            }

            println!("[✔] Successfully downloaded folder from S3 '{}' to '{}'", source, destination_path.display());
            return Ok(());
        }
    }
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
            if let Err(e) = download_file_public(entry.cid.clone(), output_file_path.to_string_lossy().to_string(), "".to_string()).await {
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
pub async fn list_folder_contents(
    account_id: String,
    scope: String,
    main_folder_name: String,
    subfolder_path: Option<Vec<String>>,
) -> Result<Vec<FileDetail>, String> {
    println!("[ListFolderContents] Received main_folder_name: {:?}", main_folder_name);
    println!("[ListFolderContents] Received subfolder_path: {:?}", subfolder_path);
    
    // Fall back to S3 if local directory doesn't exist
    let bucket_name = format!("{}-{}", account_id, scope);
    let endpoint_url = "https://s3.hippius.com";

    let path_parts = subfolder_path
        .as_ref()
        .filter(|paths| !paths.is_empty())
        .cloned()
        .unwrap_or_else(|| vec![main_folder_name.clone()]);
    let s3_prefix = format!("{}/", path_parts.join("/"));
    let full_s3_uri_prefix = format!("s3://{}/{}", bucket_name, s3_prefix);

    println!("[ListFolderContents] Listing contents for: {}", full_s3_uri_prefix);

    async fn get_sync_root(scope: &str) -> Result<PathBuf, String> {
        if scope == "public" {
            crate::utils::sync::get_public_sync_path()
                .await
                .map(|s| PathBuf::from(s))
                .map_err(|e| e.to_string())
        } else {
            crate::utils::sync::get_private_sync_path()
                .await
                .map(|s| PathBuf::from(s))
                .map_err(|e| e.to_string())
        }
    }

    async fn db_lookup_path_by_name(file_name: &str) -> Option<String> {
        if let Some(pool) = crate::DB_POOL.get() {
            match sqlx::query_scalar::<_, String>(
                "SELECT path FROM file_paths WHERE file_name = ?1 ORDER BY timestamp DESC LIMIT 1",
            )
            .bind(file_name)
            .fetch_optional(pool)
            .await
            {
                Ok(opt) => opt,
                Err(_e) => None,
            }
        } else {
            None
        }
    }

    async fn resolve_source(
        _scope: &str,
        sync_root: &std::path::Path,
        main_folder_name: &str,
        subfolder_path: &Option<Vec<String>>,
        item_name: &str,
        fallback_s3: &str,
    ) -> String {
        use std::path::PathBuf;
        let local_prefix = match subfolder_path {
            Some(paths) if !paths.is_empty() => paths.join("/"),
            _ => main_folder_name.to_string(),
        };

        let candidate: PathBuf = sync_root.join(local_prefix).join(item_name);
        if candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }

        if let Some(p) = db_lookup_path_by_name(item_name).await { return p; }

        fallback_s3.to_string()
    }

    // Compute sync root once
    let sync_root = get_sync_root(&scope).await?;

    // Dynamically get the AWS binary path
    let aws_binary_path = match get_aws_binary_path().await {
        Ok(path) => {
            println!("[ListFolderContents] Found AWS binary at: {}", path.display());
            path
        }
        Err(e) => {
            eprintln!("[ListFolderContents] Failed to get AWS binary path: {}, falling back to system PATH", e);
            if let Ok(path) = which::which(if cfg!(windows) { "aws.exe" } else { "aws" }) {
                println!("[ListFolderContents] Found AWS in system PATH at: {}", path.display());
                path
            } else {
                eprintln!("[ListFolderContents] AWS CLI not found in system PATH or custom location");
                return Err("[ListFolderContents] AWS CLI not found".to_string());
            }
        }
    };

    // Construct dynamic PATH
    let path_separator = if cfg!(windows) { ";" } else { ":" };
    let dynamic_path = format!(
        "{}{}{}",
        aws_binary_path.parent().unwrap().to_string_lossy(),
        path_separator,
        std::env::var("PATH").unwrap_or_default()
    );

    // Execute aws s3api list-objects-v2 command with prefix
    let output = Command::new(&aws_binary_path)
        .env("AWS_PAGER", "")
        .env("PATH", &dynamic_path)
        .arg("s3api")
        .arg("list-objects-v2")
        .arg("--bucket")
        .arg(&bucket_name)
        .arg("--prefix")
        .arg(&s3_prefix)
        .arg("--endpoint-url")
        .arg(endpoint_url)
        .output()
        .await
        .map_err(|e| format!("Failed to execute aws command: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to list S3 folder contents: {}", stderr));
    }

    // Parse the JSON output
    let output_str = String::from_utf8_lossy(&output.stdout);
    let result: serde_json::Value = serde_json::from_str(&output_str)
        .map_err(|e| format!("Failed to parse AWS CLI output: {}", e))?;
    println!("[ListFolderContents] AWS CLI output: {}", result);
    
    let mut direct_files: Vec<FileDetail> = Vec::new();
    let mut subfolders: HashSet<String> = HashSet::new();

    // Process Contents (files) and extract subfolders
    if let Some(contents) = result["Contents"].as_array() {
        println!("[ListFolderContents] Found {} content items", contents.len());
        for item in contents {
            if let (Some(key), Some(size), Some(last_modified)) = (
                item["Key"].as_str(),
                item["Size"].as_u64(),
                item["LastModified"].as_str(),
            ) {
                // Skip the folder marker object itself
                if key.ends_with('/') { continue; }
                
                // Get relative path by removing the s3_prefix
                if let Some(relative_path) = key.strip_prefix(&s3_prefix) {
                    if relative_path.is_empty() { continue; }
                    
                    // Check if this is a direct file or inside a subfolder
                    if let Some(slash_index) = relative_path.find('/') {
                        // This is inside a subfolder - extract the folder name
                        let folder_name = &relative_path[..slash_index];
                        subfolders.insert(folder_name.to_string());
                    } else {
                        // This is a direct file
                        let s3_url = format!("s3://{}/{}", bucket_name, key);
                        let src = resolve_source(
                            &scope,
                            &sync_root,
                            &main_folder_name,
                            &subfolder_path,
                            relative_path,
                            &s3_url,
                        ).await;
                        
                        // Parse the last modified date
                        let last_modified_dt = chrono::DateTime::parse_from_rfc3339(last_modified)
                            .map(|dt| dt.timestamp().to_string())
                            .unwrap_or_else(|_| "0".to_string());
                        
                        // Get the IPFS hash from Owner.ID if available
                        let ipfs_hash = item["Owner"]
                            .as_object()
                            .and_then(|o| o.get("ID"))
                            .and_then(|id| id.as_str())
                            .unwrap_or("")
                            .to_string();
                        
                        direct_files.push(FileDetail {
                            file_name: relative_path.to_string(),
                            cid: if ipfs_hash.is_empty() { "s3".to_string() } else { ipfs_hash.clone() },
                            source: src,
                            file_hash: if ipfs_hash.is_empty() { "s3".to_string() } else { ipfs_hash.clone() }, 
                            miner_ids: String::new(),
                            file_size: size,
                            created_at: last_modified_dt.clone(),
                            last_charged_at: last_modified_dt,
                            is_folder: false,
                        });
                    }
                }
            }
        }
    } else {
        println!("[ListFolderContents] No Contents found in response");
    }

    // Add subfolders to the result
    for folder_name in subfolders {
        let folder_key = format!("{}{}/", s3_prefix, folder_name);
        let s3_url = format!("s3://{}/{}", bucket_name, folder_key);
        let src = resolve_source(
            &scope,
            &sync_root,
            &main_folder_name,
            &subfolder_path,
            &folder_name,
            &s3_url,
        ).await;
        
        direct_files.push(FileDetail {
            file_name: folder_name,
            cid: "s3".to_string(),
            source: src,
            file_hash: hex::encode(folder_key.as_bytes()),
            miner_ids: String::new(),
            file_size: 0, // Folders don't have size in S3
            created_at: "0".to_string(),
            last_charged_at: "0".to_string(),
            is_folder: true,
        });
    }
    
    println!("files are : {:?}", direct_files);
    Ok(direct_files)
}

async fn list_local_directory(
    dir_path: &Path,
    sync_root: &Path,
    _scope: &str,
    _main_folder_name: &str,
    _subfolder_path: Option<Vec<String>>,
) -> Result<Vec<FileDetail>, String> {
    use std::fs;
    use std::time::UNIX_EPOCH;
    
    let mut files = Vec::new();
    
    for entry in fs::read_dir(dir_path).map_err(|e| format!("Failed to read directory: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();
        let file_name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
            
        if file_name.starts_with('.') {
            continue; // Skip hidden files
        }
        
        let metadata = fs::metadata(&path).map_err(|e| format!("Failed to get metadata: {}", e))?;
        let is_folder = metadata.is_dir();
        
        // Get relative path from sync root
        let relative_path = path.strip_prefix(sync_root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
            
        // Get last modified time
        let modified = metadata.modified()
            .map(|t| t.duration_since(UNIX_EPOCH).map(|d| d.as_secs().to_string()).unwrap_or_default())
            .unwrap_or_default();
            
        files.push(FileDetail {
            file_name,
            cid: "s3".to_string(),
            source: path.to_string_lossy().to_string(),
            file_hash: hex::encode(relative_path.as_bytes()),
            miner_ids: String::new(),
            file_size: metadata.len(),
            created_at: modified.clone(),
            last_charged_at: modified,
            is_folder,
        });
    }
    
    Ok(files)
}

#[tauri::command]
pub async fn add_file_to_public_folder(
    account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    file_path: String,
    _seed_phrase: String,
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
    _folder_metadata_cid: String,
    folder_name: String,
    file_name: String,
    _seed_phrase: String,
    subfolder_path: Option<Vec<String>>,
) -> Result<String, String> {
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

#[tauri::command]
pub async fn add_folder_to_public_folder(
    account_id: String,
    _folder_metadata_cid: String,
    folder_name: String,
    folder_path: String,
    _seed_phrase: String,
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
    _folder_metadata_cid: String,
    folder_name: String,
    folder_to_remove: String,
    _seed_phrase: String,
    subfolder_path: Option<Vec<String>>,
) -> Result<String, String> {
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
    _folder_metadata_cid: String,
    folder_name: String,
    folder_path: String,
    _seed_phrase: String,
    _encryption_key: Option<String>,
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
    _folder_metadata_cid: String,
    folder_name: String,
    folder_to_remove: String,
    _seed_phrase: String,
    _encryption_key: Option<String>,
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

#[tauri::command]
pub async fn wipe_s3_objects(
    account_id: String,
    scope: String,
) -> Result<(), String> {
    let bucket_name = format!("{}-{}", account_id, scope);
    let s3_uri = format!("s3://{}", bucket_name);
    
    // Dynamically get the AWS binary path
    let aws_binary_path = match get_aws_binary_path().await {
        Ok(path) => {
            println!("[remove_s3_objects] Found AWS binary at: {}", path.display());
            path
        }
        Err(e) => {
            eprintln!("[remove_s3_objects] Failed to get AWS binary path: {}, falling back to system PATH", e);
            if let Ok(path) = which::which(if cfg!(windows) { "aws.exe" } else { "aws" }) {
                println!("[remove_s3_objects] Found AWS in system PATH at: {}", path.display());
                path
            } else {
                eprintln!("[remove_s3_objects] AWS CLI not found in system PATH or custom location");
                return Err("AWS CLI not found".to_string());
            }
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

    println!("[remove_s3_objects] Removing all objects from bucket: {}", bucket_name);
    
    let status = Command::new(&aws_binary_path)
        .env("AWS_PAGER", "")
        .env("PATH", &dynamic_path)
        .arg("s3")
        .arg("rm")
        .arg(&s3_uri)
        .arg("--recursive")
        .arg("--endpoint-url")
        .arg("https://s3.hippius.com")
        .status()
        .await
        .map_err(|e| format!("Failed to spawn 'aws s3 rm --recursive': {}", e))?;

    if !status.success() {
        return Err(format!(
            "aws s3 rm --recursive failed for bucket '{}' with status {:?}",
            bucket_name, status.code()
        ));
    }

    println!("[remove_s3_objects] Successfully removed all objects from bucket: {}", bucket_name);
    Ok(())
}