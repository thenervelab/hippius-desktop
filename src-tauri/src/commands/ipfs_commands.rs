#![allow(unused_imports)]
use crate::commands::types::*;
use crate::{
    DB_POOL,
    utils::{
        accounts::decrypt_file,
        file_operations::{
            copy_to_sync_and_add_to_db, copy_to_sync_folder, remove_from_sync_folder,
        },
        ipfs::{download_from_ipfs, download_from_ipfs_async},
    },
};
use base64::{Engine as _, engine::general_purpose};
use fs_extra;
use futures::TryFutureExt;
use futures::stream::{self, StreamExt};
use reed_solomon_erasure::galois_8::ReedSolomon;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;
use tokio::process::Command;
use crate::utils::s3_client::make_s3_client;
use aws_sdk_s3::types::{ObjectIdentifier, Delete};
use tokio::{fs as async_fs, io::AsyncWriteExt, io::AsyncReadExt};
use tokio::fs::File;
use chrono::DateTime;

// Drops the first segment and returns None if the remaining path is empty
fn normalize_subfolder_path(mut subfolder_path: Option<Vec<String>>) -> Option<Vec<String>> {
    if let Some(mut path) = subfolder_path.take() {
        // Drop the main/root folder name if present
        if !path.is_empty() {
            path.remove(0);
        }
        // Sanitize the remaining segments
        let cleaned: Vec<String> = path.into_iter().filter(|s| !s.is_empty()).collect();
        if cleaned.is_empty() {
            None
        } else {
            Some(cleaned)
        }
    } else {
        None
    }
}

#[tauri::command]
pub async fn encrypt_and_upload_file(
    account_id: String,
    file_path: String,
) -> Result<String, String> {
    let path = std::path::PathBuf::from(&file_path);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    // Instead of writing Vec<u8>, we just use the existing file path
    copy_to_sync_and_add_to_db(&path, &account_id, "", "", false, false, &file_name, true).await;

    Ok(file_name)
}

#[tauri::command]
pub async fn download_and_decrypt_file(
    _account_id: String,
    _metadata_cid: String,
    output_file: String,
    _encryption_key: Option<String>,
    source: String,
    _main_req_hash: String,
) -> Result<(), String> {
    // ✅ If source exists locally, copy as before
    if Path::new(&source).exists() {
        println!("tried to copy directory locally");
        fs::copy(&source, &output_file).map_err(|e| {
            format!(
                "Failed to copy from '{}' to '{}': {}",
                source, output_file, e
            )
        })?;
        return Ok(());
    }

    // Parse the S3 source (e.g., s3://bucket-name/path/to/file)
    if !source.starts_with("s3://") {
        return Err(format!("Invalid S3 source path: {}", source));
    }

    let trimmed = source.trim_start_matches("s3://");
    let mut parts = trimmed.splitn(2, '/');
    let bucket = parts.next().ok_or("Missing bucket name in S3 path")?;
    let key = parts.next().ok_or("Missing key in S3 path")?;

    // Build S3 client with endpoint
    let client = make_s3_client().await;

    // Fetch object from S3
    let resp = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| format!("Failed to download from S3: {}", e))?;

    // Stream data to output file
    let mut body = resp.body;
    let mut file = tokio::fs::File::create(&output_file)
        .await
        .map_err(|e| format!("Failed to create output file: {}", e))?;

    while let Some(bytes) = body.try_next().await.map_err(|e| format!("Error reading stream: {}", e))? {
        file.write(&bytes)
            .await
            .map_err(|e| format!("Error writing file: {}", e))?;
    }

    file.flush()
        .await
        .map_err(|e| format!("Error flushing file: {}", e))?;

    println!(
        "Downloaded S3 object s3://{}/{} -> {} successfully",
        bucket, key, output_file
    );

    Ok(())
}


#[allow(dead_code)]
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
            let mut shards: Vec<Option<Vec<u8>>> = vec![None; m];
            for chunk in available_chunks {
                let data =
                    download_from_ipfs(&api_url, &chunk.cid.cid).map_err(|e| e.to_string())?;
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
                metadata
                    .erasure_coding
                    .encrypted_size
                    .saturating_sub(total_bytes_so_far)
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

        let mut encrypted_data = Vec::new();
        for chunk in reconstructed_chunks {
            encrypted_data.extend_from_slice(&chunk);
        }

        let decrypted_data =
            tauri::async_runtime::block_on(decrypt_file(&encrypted_data, encryption_key))?;

        let mut hasher = Sha256::new();
        hasher.update(&decrypted_data);
        let actual_hash = format!("{:x}", hasher.finalize());
        if actual_hash != *file_hash {
            return Err(format!(
                "Hash mismatch: expected {}, got {}",
                file_hash, actual_hash
            ));
        }

        std::fs::write(&output_path, &decrypted_data)
            .map_err(|e| format!("Failed to write output file: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Spawn blocking error: {}", e))?
}

#[tauri::command]
pub async fn encrypt_and_upload_folder(
    account_id: String,
    folder_path: String,
    _source: String,
) -> Result<String, String> {
    let folder_path = Path::new(&folder_path);

    if !folder_path.is_dir() {
        return Err("Provided path is not a directory".to_string());
    }

    let folder_name = folder_path
        .file_name()
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
        true,
    )
    .await;

    Ok(folder_name)
}

#[tauri::command]
pub async fn download_and_decrypt_folder(
    _account_id: String,
    _folder_metadata_cid: String,
    folder_name: String,
    output_dir: String,
    _encryption_key: Option<String>,
    source: String,
    _main_req_hash: String,
) -> Result<(), String> {
    let source_path = Path::new(&source);
    let destination_path = Path::new(&output_dir).join(&folder_name);

    // ✅ Local copy logic remains unchanged
    if source_path.exists() && source_path.is_dir() {
        println!("tried to copy directory locally");
        let options = fs_extra::dir::CopyOptions::new().overwrite(true);
        fs_extra::dir::copy(source_path, &output_dir, &options)
            .map_err(|e| format!("Failed to copy directory locally: {}", e))?;
        return Ok(());
    }

    // ✅ Otherwise use S3 SDK (replaces `aws s3 cp --recursive`)
    if let Some(parent) = destination_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create output directory: {}", e))?;
    }
    // Parse S3 path like s3://bucket-name/folder/
    if !source.starts_with("s3://") {
        return Err(format!("Invalid S3 source path: {}", source));
    }

    let trimmed = source.trim_start_matches("s3://");
    let mut parts = trimmed.splitn(2, '/');
    let bucket = parts.next().ok_or("Missing bucket name in S3 path")?;
    let prefix = parts.next().unwrap_or("");

    // Build S3 client
    let client = make_s3_client().await;

    // ✅ List all objects under the folder prefix
    let mut continuation_token = None;

    loop {
        let resp = client
            .list_objects_v2()
            .bucket(bucket)
            .prefix(prefix)
            .set_continuation_token(continuation_token.clone())
            .send()
            .await
            .map_err(|e| format!("Failed to list S3 folder: {}", e))?;

            for object in resp.contents() {
                if let Some(key) = object.key() {
                    // Compute local path
                    let relative_path = key.strip_prefix(prefix).unwrap_or(key);
                    let local_path = destination_path.join(relative_path);

                    if let Some(parent) = local_path.parent() {
                        tokio::fs::create_dir_all(parent)
                            .await
                            .map_err(|e| format!("Failed to create folder {:?}: {}", parent, e))?;
                    }

                    // Download each file
                    let resp = client
                        .get_object()
                        .bucket(bucket)
                        .key(key)
                        .send()
                        .await
                        .map_err(|e| format!("Failed to download S3 object {}: {}", key, e))?;

                    let mut body = resp.body;
                    let mut file = tokio::fs::File::create(&local_path)
                        .await
                        .map_err(|e| format!("Failed to create file {:?}: {}", local_path, e))?;

                    while let Some(bytes) = body
                        .try_next()
                        .await
                        .map_err(|e| format!("Error reading S3 stream for {}: {}", key, e))?
                    {
                        file.write_all(&bytes)
                            .await
                            .map_err(|e| format!("Error writing to {:?}: {}", local_path, e))?;
                    }

                    file.flush()
                        .await
                        .map_err(|e| format!("Error flushing {:?}: {}", local_path, e))?;
                }
            }
        

        // Pagination support
        if resp.is_truncated.expect("Failed to get response") {
            continuation_token = resp.next_continuation_token().map(|s| s.to_string());
        } else {
            break;
        }
    }

    println!(
        "Successfully downloaded folder s3://{}/{} -> {:?}",
        bucket, prefix, destination_path
    );

    Ok(())
}


#[allow(dead_code)]
async fn reconstruct_and_decrypt_single_file(
    metadata_bytes: Vec<u8>,
    output_path: PathBuf,
    api_url: Arc<String>,
    encryption_key: Option<Arc<Vec<u8>>>,
) -> Result<(), String> {
    let metadata: Metadata = serde_json::from_slice(&metadata_bytes)
        .map_err(|e| format!("Failed to parse file metadata: {}", e))?;

    if metadata.chunks.is_empty() {
        return Err(format!(
            "Cannot reconstruct file '{}': metadata contains no chunk information.",
            metadata.original_file.name
        ));
    }

    let k = metadata.erasure_coding.k;
    let m = metadata.erasure_coding.m;
    let chunk_size = metadata.erasure_coding.chunk_size;

    let mut chunk_map: std::collections::HashMap<usize, Vec<&ChunkInfo>> =
        std::collections::HashMap::new();
    for chunk in &metadata.chunks {
        chunk_map
            .entry(chunk.original_chunk)
            .or_default()
            .push(chunk);
    }

    let mut reconstructed_chunks_data = Vec::with_capacity(chunk_map.len());
    for orig_idx in 0..chunk_map.len() {
        let available_shards = chunk_map
            .get(&orig_idx)
            .ok_or("Missing chunk group in map")?;
        let mut shards: Vec<Option<Vec<u8>>> = vec![None; m];

        for shard_info in available_shards.iter() {
            let data = download_from_ipfs_async(&api_url, &shard_info.cid.cid)
                .await
                .map_err(|e| e.to_string())?;
            shards[shard_info.share_idx] = Some(data);
        }

        if shards.iter().filter(|s| s.is_some()).count() < k {
            return Err(format!("Not enough shards for chunk {}", orig_idx));
        }

        let r = ReedSolomon::new(k, m - k).map_err(|e| e.to_string())?;
        r.reconstruct_data(&mut shards)
            .map_err(|e| format!("Reconstruction failed: {}", e))?;

        let mut chunk_data = Vec::new();
        let mut bytes_collected = 0;
        let is_last_chunk = orig_idx == chunk_map.len() - 1;
        let chunk_bytes_needed = if !is_last_chunk {
            chunk_size
        } else {
            metadata
                .erasure_coding
                .encrypted_size
                .saturating_sub(chunk_size * orig_idx)
        };

        for i in 0..k {
            if let Some(shard) = &shards[i] {
                let bytes_to_take =
                    std::cmp::min(chunk_bytes_needed - bytes_collected, shard.len());
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
    let decrypted_data =
        decrypt_file(&encrypted_data, encryption_key.map(|k| (*k).clone())).await?;

    let actual_hash = format!("{:x}", Sha256::digest(&decrypted_data));
    if actual_hash != metadata.original_file.hash {
        return Err(format!("Hash mismatch for {}", metadata.original_file.name));
    }

    tokio::fs::write(&output_path, &decrypted_data)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn add_file_to_private_folder(
    account_id: String,
    _folder_metadata_cid: String,
    folder_name: String,
    file_path: String,
    _encryption_key: Option<String>,
    subfolder_path: Option<Vec<String>>,
) -> Result<String, String> {
    println!("[add_file_to_private_folder] Adding file: {}", file_path);
    let path = std::path::PathBuf::from(&file_path);

    #[allow(dead_code)]
    let _file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let normalized_subfolder = normalize_subfolder_path(subfolder_path.clone());

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
        false,
        false,
        &folder_name,
        sync_subfolder_path,
    )
    .await;

    Ok(folder_name)
}

#[tauri::command]
pub async fn remove_file_from_private_folder(
    account_id: String,
    _folder_metadata_cid: String,
    folder_name: String,
    file_name: String,
    subfolder_path: Option<Vec<String>>,
) -> Result<String, String> {
    println!(
        "[remove_file_from_private_folder] Removing file: {}",
        file_name
    );

    let normalized_subfolder = normalize_subfolder_path(subfolder_path.clone());

    let final_file_name = if file_name.ends_with(".ff.ec_metadata") {
        file_name.clone()
    } else {
        format!("{}.ff.ec_metadata", file_name)
    };

    let sync_subfolder_path = normalized_subfolder.as_ref().map(|path_vec| {
        let mut full_path = std::path::PathBuf::from(&folder_name);
        for segment in path_vec {
            full_path.push(segment);
        }
        full_path.to_string_lossy().to_string()
    });

    remove_from_sync_folder(
        &final_file_name,
        &folder_name,
        false,
        false,
        "",
        &folder_name,
        &account_id,
        "",
        sync_subfolder_path,
    )
    .await;

    Ok(folder_name)
}

#[tauri::command]
pub fn write_file(path: String, data: Vec<u8>) -> Result<(), String> {
    println!("[write_file] Writing file: {}", path);
    std::fs::write(path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
    println!("[delete_file] Deleting file: {}", path);

    let path_obj = Path::new(&path);
    let is_dir = path_obj.is_dir();

    if path_obj.exists() {
        // Local delete (non-async std::fs)
        if is_dir {
            std::fs::remove_dir_all(&path)
                .map_err(|e| format!("Failed to delete local directory: {}", e))
        } else {
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete local file: {}", e))
        }
    } else {
        // Remote delete from S3
        let client = make_s3_client().await;

        // Extract bucket and key from path
        let (bucket, key) = parse_s3_path(&path)?;

        println!("[delete_file] Deleting from S3 bucket: {}, key: {}", bucket, key);

        if is_dir {
            // For directories, list and batch delete
            let list_resp = client
                .list_objects_v2()
                .bucket(&bucket)
                .prefix(&key)
                .send()
                .await
                .map_err(|e| format!("Failed to list S3 objects: {}", e))?;

            let objects = list_resp.contents();

            if objects.is_empty() {
                println!("[delete_file] No objects found to delete in prefix: {}", key);
                return Ok(());
            }

            let delete_objects: Vec<ObjectIdentifier> = objects
            .iter()
            .filter_map(|obj| obj.key().and_then(|k| {
                match ObjectIdentifier::builder().key(k).build() {
                    Ok(identifier) => Some(identifier),
                    Err(_) => None,
                }
            }))
            .collect();
        
            let delete_req = Delete::builder()
                .set_objects(Some(delete_objects))
                .build()
                .map_err(|e| format!("Failed to build delete request: {}", e))?;

            client
                .delete_objects()
                .bucket(&bucket)
                .delete(delete_req)
                .send()
                .await
                .map_err(|e| format!("Failed to delete S3 objects: {}", e))?;

            Ok(())
        } else {
            // Delete single file
            client
                .delete_object()
                .bucket(&bucket)
                .key(&key)
                .send()
                .await
                .map_err(|e| format!("Failed to delete S3 object: {}", e))?;
            Ok(())
        }
    }
}

/// Parse an S3-style path into (bucket, key)
fn parse_s3_path(path: &str) -> Result<(String, String), String> {
    let path = path.trim_start_matches("s3://");

    let parts: Vec<&str> = path.splitn(2, '/').collect();
    if parts.len() != 2 {
        return Err("Invalid S3 path. Expected format: s3://bucket/key".into());
    }

    Ok((parts[0].to_string(), parts[1].to_string()))
}


#[tauri::command]
pub fn read_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upload_file_public(
    account_id: String,
    file_path: String,
) -> Result<String, String> {
    let path = std::path::PathBuf::from(&file_path);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    // Use existing file directly instead of writing from Vec<u8>
    copy_to_sync_and_add_to_db(&path, &account_id, "", "", true, false, &file_name, true).await;

    Ok(file_name)
}

#[tauri::command]
pub async fn download_file_public(
    _file_cid: String,
    output_file: String,
    source: String,
    _main_req_hash: String,
) -> Result<(), String> {
    // Check if the source is a local file
    if Path::new(&source).exists() {
        println!("[download_file_public] Copying file locally");
        std::fs::copy(&source, &output_file).map_err(|e| {
            format!(
                "[download_file_public] Failed to copy from '{}' to '{}': {}",
                source, output_file, e
            )
        })?;
        return Ok(());
    }

    // Otherwise, download from S3
    let client = make_s3_client().await;

    let parsed = source.trim_start_matches("s3://");
    let parts: Vec<&str> = parsed.splitn(2, '/').collect();
    if parts.len() != 2 {
        return Err(format!(
            "[download_file_public] Invalid S3 source path: '{}'",
            source
        ));
    }
    let bucket = parts[0];
    let key = parts[1];

    println!(
        "[download_file_public] Downloading from bucket '{}' with key '{}'",
        bucket, key
    );

    let resp = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| format!("[download_file_public] S3 download failed: {}", e))?;

    let mut data = resp.body.into_async_read();
    let mut buffer = Vec::new();
    data.read_to_end(&mut buffer)
        .await
        .map_err(|e| format!("[download_file_public] Failed to read S3 response: {}", e))?;

    let mut file =
        File::create(&output_file).map_err(|e| format!("[download_file_public] File error: {}", e)).await?;
    file.write_all(&buffer)
        .map_err(|e| format!("[download_file_public] Write error: {}", e)).await?;

    println!("[download_file_public] Download complete → {}", output_file);
    Ok(())
}

#[tauri::command]
pub async fn public_upload_folder(
    account_id: String,
    folder_path: String,
) -> Result<String, String> {
    let folder_path = Path::new(&folder_path);
    if !folder_path.is_dir() {
        return Err("Provided path is not a directory".to_string());
    }

    let folder_name = folder_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "Invalid folder path, cannot extract folder name".to_string())?;

    copy_to_sync_and_add_to_db(
        Path::new(&folder_path),
        &account_id,
        "",
        "",
        true,
        true,
        &folder_name.clone(),
        true,
    )
    .await;
    println!("[public_upload_folder] Folder uploaded successfully");
    Ok(folder_name)
}


#[tauri::command]
pub async fn public_download_folder(
    _account_id: String,
    _folder_metadata_cid: String,
    folder_name: String,
    output_dir: String,
    source: String,
    _main_req_hash: String,
) -> Result<(), String> {
    let source_path = Path::new(&source);
    let destination_path = Path::new(&output_dir).join(&folder_name);

    // If the source exists locally, copy it directly
    if source_path.exists() && source_path.is_dir() {
        println!("[public_download_folder] Copying local directory...");
        let options = fs_extra::dir::CopyOptions::new().overwrite(true);
        fs_extra::dir::copy(source_path, &output_dir, &options)
            .map_err(|e| format!("Failed to copy directory locally: {}", e))?;
        return Ok(());
    }

    // Otherwise, use S3 SDK to recursively download folder
    let client = make_s3_client().await;

    // Parse S3 URL: s3://bucket/prefix/
    let parsed = source.trim_start_matches("s3://");
    let parts: Vec<&str> = parsed.splitn(2, '/').collect();
    if parts.len() != 2 {
        return Err(format!(
            "[public_download_folder] Invalid S3 source path: '{}'",
            source
        ));
    }
    let bucket = parts[0];
    let prefix = parts[1].trim_end_matches('/');

    println!(
        "[public_download_folder] Downloading folder from S3 bucket '{}' prefix '{}'",
        bucket, prefix
    );

    let mut continuation_token = None;
    let mut total_files = 0;

    loop {
        let resp = client
            .list_objects_v2()
            .bucket(bucket)
            .prefix(prefix)
            .set_continuation_token(continuation_token.clone())
            .send()
            .await
            .map_err(|e| format!("Failed to list objects from S3: {}", e))?;

            for obj in resp.contents() {
                if let Some(key) = obj.key() {
                    // Skip if this is a "directory marker"
                    if key.ends_with('/') {
                        continue;
                    }

                    let relative_path = key.strip_prefix(prefix).unwrap_or(key);
                    let local_path = destination_path.join(relative_path.trim_start_matches('/'));

                    if let Some(parent_dir) = local_path.parent() {
                        async_fs::create_dir_all(parent_dir)
                            .await
                            .map_err(|e| format!("Failed to create local dir: {}", e))?;
                    }

                    println!("[public_download_folder] Downloading {}", key);

                    let get_resp = client
                        .get_object()
                        .bucket(bucket)
                        .key(key)
                        .send()
                        .await
                        .map_err(|e| format!("Failed to download '{}': {}", key, e))?;

                    let mut data = get_resp.body.into_async_read();
                    let mut file = async_fs::File::create(&local_path)
                        .await
                        .map_err(|e| format!("Failed to create file '{}': {}", local_path.display(), e))?;

                    tokio::io::copy(&mut data, &mut file)
                        .await
                        .map_err(|e| format!("Failed to write to '{}': {}", local_path.display(), e))?;

                    total_files += 1;
                }
            }
        

        // Check if there's more data to fetch
        continuation_token = resp.next_continuation_token().map(|s| s.to_string());
        if continuation_token.is_none() {
            break;
        }
    }

    println!(
        "[public_download_folder] ✅ Download complete. Total files: {}",
        total_files
    );

    Ok(())
}


#[tauri::command]
pub async fn list_folder_contents(
    account_id: String,
    scope: String,
    main_folder_name: String,
    subfolder_path: Option<Vec<String>>,
) -> Result<Vec<FileDetail>, String> {
    let sync_root = if scope == "public" {
        PathBuf::from(
            crate::utils::sync::get_public_sync_path()
                .await
                .map_err(|e| e.to_string())?,
        )
    } else {
        PathBuf::from(
            crate::utils::sync::get_private_sync_path()
                .await
                .map_err(|e| e.to_string())?,
        )
    };

    let mut local_path = sync_root.join(&main_folder_name);
    let normalized_subfolder_path = normalize_subfolder_path(subfolder_path.clone());
    if let Some(parts) = &normalized_subfolder_path {
        for part in parts {
            local_path.push(part);
        }
    }

    // If local folder exists, list it directly
    if local_path.is_dir() {
        return list_local_folder_contents(
            &local_path,
            &main_folder_name,
            &subfolder_path,
            scope,
        )
        .await;
    }

    // Otherwise list from S3
    let bucket_name = match crate::DB_POOL.get() {
        Some(pool) => {
            let file_type = if scope == "public" { "public" } else { "private" };
            match sqlx::query_scalar::<_, String>(
                "SELECT DISTINCT bucket_name FROM user_profiles 
                 WHERE file_name = ?1 AND type = ?2 AND bucket_name IS NOT NULL LIMIT 1",
            )
            .bind(&main_folder_name)
            .bind(file_type)
            .fetch_optional(pool)
            .await
            {
                Ok(Some(bucket)) => bucket,
                _ => format!("{}-{}", account_id, scope),
            }
        }
        None => format!("{}-{}", account_id, scope),
    };

    let client = make_s3_client().await;

    let path_parts = subfolder_path
        .as_ref()
        .filter(|paths| !paths.is_empty())
        .cloned()
        .unwrap_or_else(|| vec![main_folder_name.clone()]);
    let s3_prefix = format!("{}/", path_parts.join("/"));

    println!(
        "[list_folder_contents] Listing from S3 bucket '{}' with prefix '{}'",
        bucket_name, s3_prefix
    );

    // Paginated fetch
    let mut continuation_token = None;
    let mut all_objects = Vec::new();
    loop {
        let resp = client
            .list_objects_v2()
            .bucket(&bucket_name)
            .prefix(&s3_prefix)
            .set_continuation_token(continuation_token.clone())
            .send()
            .await
            .map_err(|e| format!("S3 list_objects_v2 failed: {}", e))?;

        all_objects.extend_from_slice(resp.contents());

        continuation_token = resp.next_continuation_token().map(|s| s.to_string());
        if continuation_token.is_none() {
            break;
        }
    }

    // === Parse S3 results ===
    let mut direct_files: Vec<FileDetail> = Vec::new();
    let mut folder_sizes: HashMap<String, u64> = HashMap::new();
    let mut folder_ipfs_hashes: HashMap<String, String> = HashMap::new();
    let mut file_items = Vec::new();

    for obj in all_objects {
        if let (Some(key), Some(size)) = (obj.key(), obj.size()) {
            if key.ends_with('/') {
                continue;
            }

            let ipfs_hash = obj
                .owner()
                .and_then(|o| o.id())
                .unwrap_or("pending")
                .to_string();

            if let Some(relative_path) = key.strip_prefix(&s3_prefix) {
                if relative_path.is_empty() {
                    continue;
                }

                if let Some(slash_index) = relative_path.find('/') {
                    let folder_name = &relative_path[..slash_index];
                    *folder_sizes.entry(folder_name.to_string()).or_insert(0) += size as u64;
                    if !ipfs_hash.is_empty() {
                        folder_ipfs_hashes.insert(folder_name.to_string(), ipfs_hash.clone());
                    }
                } else {
                    let last_modified = obj
                        .last_modified()
                        .map(|dt| dt.to_string())
                        .unwrap_or_else(|| "0".to_string());
                    file_items.push((
                        relative_path.to_string(),
                        size as u64,
                        ipfs_hash,
                        last_modified,
                    ));
                }
            }
        }
    }

    // === Build file entries ===
    for (relative_path, size, ipfs_hash, last_modified) in file_items {
        let s3_url = format!("s3://{}/{}{}", bucket_name, s3_prefix, relative_path);
        let src = s3_url.clone();

        let last_modified_ts = DateTime::parse_from_rfc3339(&last_modified)
            .map(|dt| dt.timestamp().to_string())
            .unwrap_or_else(|_| "0".to_string());

        let cid_hex = hex::encode(ipfs_hash.as_bytes());
        let file_hash_hex = cid_hex.clone();

        direct_files.push(FileDetail {
            file_name: relative_path,
            cid: if cid_hex.is_empty() {
                "pending".to_string()
            } else {
                cid_hex.clone()
            },
            source: src,
            file_hash: if file_hash_hex.is_empty() {
                "pending".to_string()
            } else {
                file_hash_hex
            },
            miner_ids: String::new(),
            file_size: size,
            created_at: last_modified_ts.clone(),
            last_charged_at: last_modified_ts,
            is_folder: false,
            main_req_hash: "s3".to_string(),
        });
    }

    // === Build folder entries ===
    for (folder_name, size) in folder_sizes {
        let folder_key = format!("{}{}/", s3_prefix, folder_name);
        let s3_url = format!("s3://{}/{}", bucket_name, folder_key);

        let ipfs_hash = folder_ipfs_hashes
            .get(&folder_name)
            .cloned()
            .unwrap_or_default();
        let cid_hex = hex::encode(ipfs_hash.as_bytes());
        let file_hash_hex = cid_hex.clone();

        direct_files.push(FileDetail {
            file_name: folder_name,
            cid: if cid_hex.is_empty() {
                "pending".to_string()
            } else {
                cid_hex.clone()
            },
            source: s3_url,
            file_hash: if file_hash_hex.is_empty() {
                "pending".to_string()
            } else {
                file_hash_hex
            },
            miner_ids: String::new(),
            file_size: size,
            created_at: "0".to_string(),
            last_charged_at: "0".to_string(),
            is_folder: true,
            main_req_hash: "s3".to_string(),
        });
    }

    // === Filter uploading or deleted files ===
    let mut uploading_or_deleted_paths = HashSet::new();

    let recent_items = if scope == "public" {
        crate::sync_shared::S3_PUBLIC_SYNC_STATE
            .lock()
            .unwrap()
            .recent_items
            .clone()
    } else {
        crate::sync_shared::S3_PRIVATE_SYNC_STATE
            .lock()
            .unwrap()
            .recent_items
            .clone()
    };

    for item in recent_items {
        if item.action == "uploading" || item.action == "deleted" {
            if let Some(relative_path) = extract_relative_path(&item.path, &sync_root) {
                uploading_or_deleted_paths.insert(relative_path);
            }
        }
    }

    let uploading_items = if scope == "public" {
        crate::sync_shared::S3_PUBLIC_SYNC_STATE
            .lock()
            .unwrap()
            .uploading_items
            .clone()
    } else {
        crate::sync_shared::S3_PRIVATE_SYNC_STATE
            .lock()
            .unwrap()
            .uploading_items
            .clone()
    };

    for item in uploading_items {
        if item.action == "uploading" || item.action == "deleted" {
            if let Some(relative_path) = extract_relative_path(&item.path, &sync_root) {
                uploading_or_deleted_paths.insert(relative_path);
            }
        }
    }

    let current_relative_path = match &subfolder_path {
        Some(parts) if !parts.is_empty() => {
            format!("{}/{}", main_folder_name, parts.join("/"))
        }
        _ => main_folder_name.clone(),
    };

    let filtered_files: Vec<FileDetail> = direct_files
        .into_iter()
        .filter(|file| {
            let file_relative_path = format!("{}/{}", current_relative_path, file.file_name);
            !uploading_or_deleted_paths.iter().any(|excluded| {
                if file.is_folder {
                    excluded.starts_with(&file_relative_path)
                } else {
                    excluded == &file_relative_path
                }
            })
        })
        .collect();

    Ok(filtered_files)
}

/// Lists the contents of a local directory and returns them as FileDetail objects
async fn list_local_folder_contents(
    local_path: &std::path::Path,
    main_folder_name: &str,
    subfolder_path: &Option<Vec<String>>,
    scope: String,
) -> Result<Vec<FileDetail>, String> {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    let mut result = Vec::new();

    // Helper to convert SystemTime to Unix timestamp string
    fn system_time_to_timestamp(time: SystemTime) -> String {
        time.duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_else(|_| "0".to_string())
    }

    // Read the directory entries
    let entries =
        fs::read_dir(local_path).map_err(|e| format!("Failed to read local directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Error reading directory entry: {}", e))?;
        let path = entry.path();
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| "Invalid file name".to_string())?
            .to_string();

        let metadata = fs::metadata(&path)
            .map_err(|e| format!("Failed to get metadata for {}: {}", path.display(), e))?;

        let is_dir = metadata.is_dir();
        let file_size = metadata.len();
        let modified_time = metadata
            .modified()
            .map(system_time_to_timestamp)
            .unwrap_or_else(|_| "0".to_string());

        // Build the source path relative to the main sync folder
        let mut source_path = main_folder_name.to_string();
        if let Some(parts) = subfolder_path {
            if !parts.is_empty() {
                source_path.push('/');
                source_path.push_str(&parts.join("/"));
            }
        }
        if !source_path.ends_with('/') {
            source_path.push('/');
        }
        source_path.push_str(&file_name);

        result.push(FileDetail {
            file_name: file_name.clone(),
            cid: "local".to_string(),
            source: path.to_string_lossy().to_string(),
            file_hash: "".to_string(),
            miner_ids: String::new(),
            file_size,
            created_at: modified_time.clone(),
            last_charged_at: modified_time,
            is_folder: is_dir,
            main_req_hash: "local".to_string(),
        });
    }

    // Get recent items from state to filter out uploading/deleted files
    let recent_items = if scope == "public" {
        crate::sync_shared::S3_PUBLIC_SYNC_STATE
            .lock()
            .unwrap()
            .recent_items
            .clone()
    } else {
        crate::sync_shared::S3_PRIVATE_SYNC_STATE
            .lock()
            .unwrap()
            .recent_items
            .clone()
    };

    let uploading_items = if scope == "public" {
        crate::sync_shared::S3_PUBLIC_SYNC_STATE
            .lock()
            .unwrap()
            .uploading_items
            .clone()
    } else {
        crate::sync_shared::S3_PRIVATE_SYNC_STATE
            .lock()
            .unwrap()
            .uploading_items
            .clone()
    };

    // Create sets of file names to exclude
    let mut uploading_or_deleted = std::collections::HashSet::new();
    for item in recent_items {
        if item.action == "uploading" || item.action == "deleted" {
            uploading_or_deleted.insert(item.path);
        }
    }

    for item in uploading_items {
        if item.action == "uploading" || item.action == "deleted" {
            uploading_or_deleted.insert(item.path);
        }
    }

    // Filter out files that are in the uploading or deleted state
    let mut filtered_files: Vec<FileDetail> = result
        .into_iter()
        .filter(|file| {
            !uploading_or_deleted.contains(&format!("{}{}", local_path.display(), file.file_name))
        })
        .collect();

    // Sort the results: directories first, then files, both alphabetically
    filtered_files.sort_by(|a, b| {
        if a.is_folder == b.is_folder {
            a.file_name.cmp(&b.file_name)
        } else if a.is_folder {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });

    Ok(filtered_files)
}

#[tauri::command]
pub async fn add_file_to_public_folder(
    account_id: String,
    folder_metadata_cid: String,
    folder_name: String,
    file_path: String,
    subfolder_path: Option<Vec<String>>,
) -> Result<String, String> {
    println!("[add_file_to_public_folder] Adding file: {}", file_path);
    let path = std::path::PathBuf::from(&file_path);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    println!(
        "[+] Adding file '{}' to folder '{}'",
        file_name, folder_name
    );

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
    subfolder_path: Option<Vec<String>>,
) -> Result<String, String> {
    println!(
        "[-] Removing file '{}' from folder '{}'",
        file_name, folder_name
    );
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
        &file_name,
        &folder_name,
        true,
        false,
        &file_name,
        "",
        &account_id,
        "",
        sync_subfolder_path,
    )
    .await;

    Ok(folder_name)
}

#[tauri::command]
pub async fn add_folder_to_public_folder(
    account_id: String,
    _folder_metadata_cid: String,
    folder_name: String,
    folder_path: String,
    subfolder_path: Option<Vec<String>>,
) -> Result<String, String> {
    println!(
        "[add_folder_to_public_folder] Adding folder: {}",
        folder_path
    );
    let folder_path_obj = Path::new(&folder_path);
    // Main logic
    let normalized_subfolder = normalize_subfolder_path(subfolder_path.clone());

    let sync_subfolder_path = normalized_subfolder.as_ref().map(|path_vec| {
        let mut full_path = std::path::PathBuf::from(&folder_name);
        for segment in path_vec {
            full_path.push(segment);
        }
        full_path.to_string_lossy().to_string()
    });
    println!("subfolder_path: {:?}", subfolder_path);
    println!("sync_subfolder_path: {:?}", sync_subfolder_path);
    copy_to_sync_folder(
        folder_path_obj,
        &folder_name,
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
    subfolder_path: Option<Vec<String>>,
) -> Result<String, String> {
    println!(
        "[-] Removing folder '{}' from folder '{}'",
        folder_to_remove, folder_name
    );
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
    )
    .await;

    Ok(folder_name)
}

#[tauri::command]
pub async fn add_folder_to_private_folder(
    account_id: String,
    _folder_metadata_cid: String,
    folder_name: String,
    folder_path: String,
    _encryption_key: Option<String>,
    subfolder_path: Option<Vec<String>>,
) -> Result<String, String> {
    println!(
        "[add_folder_to_private_folder] Adding folder: {}",
        folder_path
    );
    let folder_path_obj = Path::new(&folder_path);

    // --- Main logic ---
    let normalized_subfolder = normalize_subfolder_path(subfolder_path.clone());

    let sync_subfolder_path = normalized_subfolder.as_ref().map(|path_vec| {
        let mut full_path = std::path::PathBuf::from(&folder_name);
        for segment in path_vec {
            full_path.push(segment);
        }
        full_path.to_string_lossy().to_string()
    });

    copy_to_sync_folder(
        folder_path_obj,
        &folder_name,
        &account_id,
        "",
        "",
        false,
        true,
        &folder_name,
        sync_subfolder_path,
    )
    .await;

    Ok(folder_name)
}

#[tauri::command]
pub async fn remove_folder_from_private_folder(
    account_id: String,
    _folder_metadata_cid: String,
    folder_name: String,
    folder_to_remove: String,
    _encryption_key: Option<String>,
    subfolder_path: Option<Vec<String>>,
) -> Result<String, String> {
    println!(
        "[-] Removing private folder '{}' from folder '{}'",
        folder_to_remove, folder_name
    );
    // Main logic
    let normalized_subfolder = normalize_subfolder_path(subfolder_path.clone());

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
pub async fn wipe_s3_objects(account_id: String, scope: String) -> Result<(), String> {
    // Validate scope
    if scope != "public" && scope != "private" {
        return Err("Invalid scope. Must be 'public' or 'private'.".to_string());
    }

    // First, clean up local sync directory if it exists
    match get_sync_path(&scope).await {
        Ok(sync_path) => {
            println!(
                "[wipe_s3_objects] Cleaning up local sync directory: {}",
                sync_path.display()
            );
            if let Err(e) = delete_directory_contents(&sync_path) {
                eprintln!(
                    "[wipe_s3_objects] Warning: Failed to clean up local sync directory: {}",
                    e
                );
            } else {
                println!("[wipe_s3_objects] Successfully cleaned up local sync directory");
            }
        }
        Err(e) => {
            eprintln!("[wipe_s3_objects] Warning: Failed to get sync path: {}", e);
        }
    }

    // Clean up the database entries
    match delete_user_profiles_by_scope(&account_id, &scope).await {
        Ok(count) => {
            println!(
                "[wipe_s3_objects] Deleted {} {} records from user_profiles",
                count, scope
            );
        }
        Err(e) => {
            eprintln!("[wipe_s3_objects] Failed to clean up database: {}", e);
            return Err(format!("Failed to clean up database: {}", e));
        }
    }

    // Initialize AWS SDK client
    let client = make_s3_client().await;

    // List all buckets
    let mut bucket_names = match crate::sync_shared::list_all_buckets().await {
        Ok(names) => names,
        Err(e) => {
            eprintln!("[wipe_s3_objects] Failed to list buckets: {}", e);
            return Ok(());
        }
    };

    // Filter buckets based on scope
    if scope == "private" {
        bucket_names.retain(|name| name.ends_with("-private"));
    } else {
        bucket_names.retain(|name| !name.ends_with("-private"));
    }

    if bucket_names.is_empty() {
        println!("[wipe_s3_objects] No {} buckets found to clean up", scope);
        return Ok(());
    }

    println!(
        "[wipe_s3_objects] Found {} {} buckets to clean up",
        bucket_names.len(),
        scope
    );

    // Process each matching bucket using AWS SDK
    for bucket_name in bucket_names {
        println!(
            "[wipe_s3_objects] Removing all objects from bucket: {}",
            bucket_name
        );

        // Paginate through all objects in the bucket and delete them
        let mut continuation_token = None;
        loop {
            let resp = client
                .list_objects_v2()
                .bucket(&bucket_name)
                .set_continuation_token(continuation_token.clone())
                .send()
                .await
                .map_err(|e| format!("Failed to list objects in bucket '{}': {}", bucket_name, e))?;

            let objects= resp.contents();
            if !objects.is_empty() {
                let delete_keys: Vec<_> = objects
                    .iter()
                    .filter_map(|obj| {
                        obj.key().and_then(|k| {
                            aws_sdk_s3::types::ObjectIdentifier::builder()
                                .key(k)
                                .build()
                                .ok() 
                        })
                    })
                    .collect();
            
                if !delete_keys.is_empty() {
                    let delete_req = aws_sdk_s3::types::Delete::builder()
                        .set_objects(Some(delete_keys))
                        .build()
                        .map_err(|e| format!("Failed to build delete request: {}", e))?;
            
                    if let Err(e) = client
                        .delete_objects()
                        .bucket(&bucket_name)
                        .delete(delete_req)
                        .send()
                        .await
                    {
                        eprintln!(
                            "[wipe_s3_objects] Failed to delete objects from '{}': {}",
                            bucket_name, e
                        );
                        // Continue to next batch instead of failing
                    }
                }
            }
            
            
            if let Some(_truncated) = resp.is_truncated() {
                continuation_token = resp.next_continuation_token().map(|t| t.to_string());
            } else {
                break;
            }
        }

        println!(
            "[wipe_s3_objects] Successfully removed all objects from bucket: {}",
            bucket_name
        );
    }

    println!(
        "[wipe_s3_objects] Completed cleaning up {} buckets and database entries",
        scope
    );

    // Move any remaining uploading items to recent items with "deleted" status
    {
        let state = if scope == "public" {
            crate::sync_shared::S3_PUBLIC_SYNC_STATE.lock().unwrap()
        } else {
            crate::sync_shared::S3_PRIVATE_SYNC_STATE.lock().unwrap()
        };

        let uploading_items = state.uploading_items.clone();
        drop(state);

        for item in uploading_items {
            if item.scope == scope {
                let item_path = item.path.clone();
                let deleted_item = crate::sync_shared::RecentItem {
                    name: item.name,
                    scope: scope.clone(),
                    action: "deleted".to_string(),
                    kind: item.kind,
                    path: item_path.clone(),
                    timestamp: chrono::Utc::now().timestamp_millis(),
                };

                let mut state = if scope == "public" {
                    crate::sync_shared::S3_PUBLIC_SYNC_STATE.lock().unwrap()
                } else {
                    crate::sync_shared::S3_PRIVATE_SYNC_STATE.lock().unwrap()
                };

                state.recent_items.push_front(deleted_item);
                while state.recent_items.len() > crate::sync_shared::MAX_RECENT_ITEMS {
                    state.recent_items.pop_back();
                }

                state.uploading_items.retain(|i| i.path != item_path);
            }
        }
    }

    Ok(())
}

/// Deletes all user_profiles entries for a given account_id and scope
async fn delete_user_profiles_by_scope(account_id: &str, scope: &str) -> Result<u64, String> {
    let pool = DB_POOL.get().ok_or("Database pool not available")?;

    let result = sqlx::query("DELETE FROM user_profiles WHERE owner = ?1 AND type = ?2")
        .bind(account_id)
        .bind(scope)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to delete user_profiles: {}", e))?;

    Ok(result.rows_affected())
}

/// Gets the sync path based on scope (public/private)
async fn get_sync_path(scope: &str) -> Result<std::path::PathBuf, String> {
    let path_str = if scope == "public" {
        crate::utils::sync::get_public_sync_path().await
    } else if scope == "private" {
        crate::utils::sync::get_private_sync_path().await
    } else {
        return Err("Invalid scope. Must be 'public' or 'private'.".to_string());
    }?; // This will return early if there's an error

    Ok(std::path::PathBuf::from(path_str))
}

/// Deletes all files and directories in the given path
fn delete_directory_contents(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    if path.is_file() {
        return fs::remove_file(path)
            .map_err(|e| format!("Failed to delete file {}: {}", path.display(), e));
    }

    for entry in fs::read_dir(path)
        .map_err(|e| format!("Failed to read directory {}: {}", path.display(), e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.is_dir() {
            fs::remove_dir_all(&path)
                .map_err(|e| format!("Failed to remove directory {}: {}", path.display(), e))?;
        } else {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to remove file {}: {}", path.display(), e))?;
        }
    }

    Ok(())
}

fn extract_relative_path(full_path: &str, sync_root: &Path) -> Option<String> {
    let full_path = Path::new(full_path);

    if let Ok(relative) = full_path.strip_prefix(sync_root) {
        let relative_str = relative.to_string_lossy().replace('\\', "/");
        if !relative_str.is_empty() {
            return Some(relative_str);
        }
    }

    None
}
