use base64::{engine::general_purpose, Engine as _};
use once_cell::sync::OnceCell;
use reqwest::blocking::multipart;
use reqwest::blocking::Client;
use serde_json;
use sha2::{Digest, Sha256};
use sodiumoxide::crypto::secretbox;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration as StdDuration;
use tokio::sync::Mutex;
use tokio::task;

use crate::constants::ipfs::KUBO_VERSION;

static DOWNLOAD_STATE: OnceCell<Mutex<Option<PathBuf>>> = OnceCell::new();

pub fn get_binary_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not find home directory".to_string())?;

    #[cfg(target_os = "windows")]
    let binary_name = "ipfs.exe";
    #[cfg(not(target_os = "windows"))]
    let binary_name = "ipfs";

    Ok(home.join(".hippius").join("bin").join(binary_name))
}

pub async fn ensure_ipfs_binary() -> Result<PathBuf, String> {
    let binary_path = get_binary_path()?;

    // If binary already exists, check if it's executable and valid
    if binary_path.exists() {
        // On non-Windows systems, check if the binary is executable
        #[cfg(not(target_os = "windows"))]
        {
            use std::os::unix::fs::PermissionsExt;
            let metadata = fs::metadata(&binary_path)
                .map_err(|e| format!("Failed to get binary metadata: {}", e))?;
            let permissions = metadata.permissions();

            // If not executable, try to set permissions
            if permissions.mode() & 0o111 == 0 {
                println!("IPFS binary exists but is not executable, setting permissions");
                fs::set_permissions(&binary_path, fs::Permissions::from_mode(0o755))
                    .map_err(|e| format!("Failed to set executable permissions: {}", e))?;
            }
        }

        // Try to run ipfs version to check if the binary is valid
        match std::process::Command::new(&binary_path)
            .arg("--version")
            .output()
        {
            Ok(_) => {
                println!("Valid IPFS binary found at {:?}", binary_path);
                return Ok(binary_path);
            }
            Err(e) => {
                println!("Binary exists but failed to execute: {}", e);
                // If version check fails, let's re-download the binary
                let _ = fs::remove_file(&binary_path);
            }
        }
    }

    // Create parent directories
    ensure_parent_directories(&binary_path)?;

    // Try to become the downloading thread
    let should_download = {
        let mut download_state = DOWNLOAD_STATE.get_or_init(|| Mutex::new(None)).lock().await;
        if download_state.is_none() {
            *download_state = Some(binary_path.clone());
            true
        } else {
            false
        }
    };

    if should_download {
        println!("Starting IPFS binary download");
        // We're the downloading thread
        let result = task::spawn_blocking(move || download_and_extract_binary(&binary_path))
            .await
            .map_err(|e| format!("Task join error: {}", e))??;

        // Clear the download state
        let mut download_state = DOWNLOAD_STATE.get().unwrap().lock().await;
        *download_state = None;

        return Ok(result);
    }

    // We're not the downloading thread, wait for the download to complete
    println!("Waiting for another thread to complete binary download");
    let mut attempts = 0;
    let max_attempts = 300; // Wait up to 30 seconds

    loop {
        if binary_path.exists() {
            return Ok(binary_path);
        }

        // Check if another thread is still downloading
        let is_downloading = {
            let download_state = DOWNLOAD_STATE.get().unwrap().lock().await;
            download_state.is_some()
        };

        if !is_downloading {
            // No one is downloading anymore, but the file doesn't exist
            return Err("Binary download failed or was canceled".to_string());
        }

        attempts += 1;
        if attempts > max_attempts {
            return Err("Timed out waiting for IPFS binary download".to_string());
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }
}

fn ensure_parent_directories(path: &PathBuf) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            println!("Creating directory: {:?}", parent);
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }
    }
    Ok(())
}

fn download_and_extract_binary(binary_path: &PathBuf) -> Result<PathBuf, String> {
    let download_url = get_download_url()?;
    println!("Downloading IPFS from: {}", download_url);

    // Ensure parent directories exist
    ensure_parent_directories(binary_path)?;

    // Set up reqwest client with timeout
    let client = reqwest::blocking::ClientBuilder::new()
        .timeout(StdDuration::from_secs(120)) // 2 minute timeout for large files
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Download the file
    println!("Starting download...");
    let response = client
        .get(&download_url)
        .send()
        .map_err(|e| format!("Failed to download IPFS: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download IPFS: HTTP status {}",
            response.status()
        ));
    }

    let content = response
        .bytes()
        .map_err(|e| format!("Failed to read response: {}", e))?;
    println!("Download complete: {} bytes", content.len());

    // Create a unique temporary directory
    let temp_dir = binary_path.with_extension(format!("tmp_{}", std::process::id()));
    if temp_dir.exists() {
        println!("Removing existing temp directory: {:?}", temp_dir);
        fs::remove_dir_all(&temp_dir)
            .map_err(|e| format!("Failed to remove old temporary directory: {}", e))?;
    }

    println!("Creating temp directory: {:?}", temp_dir);
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temporary directory: {}", e))?;

    println!("Extracting archive...");

    #[cfg(target_os = "windows")]
    {
        let temp_file = temp_dir.join("kubo.zip");
        fs::write(&temp_file, &content)
            .map_err(|e| format!("Failed to write temporary file: {}", e))?;

        let file =
            fs::File::open(&temp_file).map_err(|e| format!("Failed to open zip file: {}", e))?;

        let mut archive =
            zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip archive: {}", e))?;

        archive
            .extract(&temp_dir)
            .map_err(|e| format!("Failed to extract zip archive: {}", e))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let temp_file = temp_dir.join("kubo.tar.gz");
        println!("Writing downloaded archive to {:?}", temp_file);
        fs::write(&temp_file, &content)
            .map_err(|e| format!("Failed to write temporary file: {}", e))?;

        println!("Opening archive for extraction");
        let tar_gz =
            fs::File::open(&temp_file).map_err(|e| format!("Failed to open archive: {}", e))?;
        let tar = flate2::read::GzDecoder::new(tar_gz);
        let mut archive = tar::Archive::new(tar);

        println!("Extracting archive to {:?}", temp_dir);
        archive
            .unpack(&temp_dir)
            .map_err(|e| format!("Failed to extract archive: {}", e))?;
    }

    // Look for IPFS binary - check both direct path and in kubo subdirectory
    println!("Looking for IPFS binary...");
    let possible_paths = vec![
        temp_dir.join("ipfs"),
        temp_dir.join("kubo").join("ipfs"),
        temp_dir.join("go-ipfs").join("ipfs"),
    ];

    let source_binary = possible_paths
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| format!("IPFS binary not found after extraction in {:?}", temp_dir))?;

    println!("Found binary at {:?}", source_binary);

    // Remove existing binary if it exists
    if binary_path.exists() {
        println!("Removing existing binary");
        fs::remove_file(binary_path)
            .map_err(|e| format!("Failed to remove existing binary: {}", e))?;
    }

    println!(
        "Moving binary from {:?} to {:?}",
        source_binary, binary_path
    );

    // Copy instead of rename in case of cross-filesystem issues
    fs::copy(&source_binary, binary_path).map_err(|e| format!("Failed to copy binary: {}", e))?;

    println!("Cleaning up temporary directory");
    fs::remove_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to remove temporary directory: {}", e))?;

    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        println!("Setting executable permissions");
        fs::set_permissions(&binary_path, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to set executable permissions: {}", e))?;
    }

    // Verify the binary works
    match std::process::Command::new(&binary_path)
        .arg("--version")
        .output()
    {
        Ok(output) => {
            let version = String::from_utf8_lossy(&output.stdout);
            println!("IPFS binary installation complete: {}", version.trim());
        }
        Err(e) => {
            return Err(format!("Binary installed but failed to execute: {}", e));
        }
    }

    Ok(binary_path.clone())
}

fn get_download_url() -> Result<String, String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    let (os_name, arch_name, ext) = match (os, arch) {
        ("windows", "x86_64") => ("windows", "amd64", "zip"),
        ("windows", "aarch64") => ("windows", "arm64", "zip"),
        ("linux", "x86_64") => ("linux", "amd64", "tar.gz"),
        ("linux", "aarch64") => ("linux", "arm64", "tar.gz"),
        ("macos", "x86_64") => ("darwin", "amd64", "tar.gz"),
        ("macos", "aarch64") => ("darwin", "arm64", "tar.gz"),
        _ => return Err(format!("Unsupported platform: {}-{}", os, arch)),
    };

    Ok(format!(
        "https://github.com/ipfs/kubo/releases/download/v{}/kubo_v{}_{}-{}.{}",
        KUBO_VERSION, KUBO_VERSION, os_name, arch_name, ext
    ))
}

pub fn deterministic_key_for_account(account_id: &str) -> secretbox::Key {
    let mut hasher = Sha256::new();
    hasher.update(account_id.as_bytes());
    let hash = hasher.finalize();
    let mut key_bytes = [0u8; secretbox::KEYBYTES];
    key_bytes.copy_from_slice(&hash[..secretbox::KEYBYTES]);
    secretbox::Key(key_bytes)
}

pub fn upload_to_ipfs(
    api_url: &str,
    file_path: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let client = Client::new();

    // Read file data
    let mut file = fs::File::open(file_path)?;
    let mut file_data = Vec::new();
    file.read_to_end(&mut file_data)?;

    let part = multipart::Part::bytes(file_data)
        .file_name("file")
        .mime_str("application/octet-stream")?;
    let form = multipart::Form::new().part("file", part);

    let res = client
        .post(&format!("{}/api/v0/add", api_url))
        .multipart(form)
        .send()?
        .error_for_status()?;

    // Parse response
    let json: serde_json::Value = res.json()?;
    let cid = json["Hash"]
        .as_str()
        .ok_or("No Hash in IPFS response")?
        .to_string();

    // Pin the file to the local node
    let pin_url = format!("{}/api/v0/pin/add?arg={}", api_url, cid);
    let pin_res = client.post(&pin_url).send();
    match pin_res {
        Ok(resp) => {
            if resp.status().is_success() {
                println!("[IPFS] Successfully pinned CID: {}", cid);
            } else {
                println!(
                    "[IPFS] Failed to pin CID: {} (status: {})",
                    cid,
                    resp.status()
                );
            }
        }
        Err(e) => {
            println!("[IPFS] Error pinning CID {}: {}", cid, e);
        }
    }

    Ok(cid)
}

pub fn download_from_ipfs(api_url: &str, cid: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let client = Client::new();

    let res = client
        .post(&format!("{}/api/v0/cat?arg={}", api_url, cid))
        .send()?
        .error_for_status()?;

    let bytes = res.bytes()?.to_vec();
    Ok(bytes)
}

/// Encrypts file data for an account, prepending the nonce to the ciphertext.
pub fn encrypt_file_for_account(account_id: &str, file_data: &[u8]) -> Result<Vec<u8>, String> {
    let key = deterministic_key_for_account(account_id);
    let nonce = secretbox::gen_nonce();
    let encrypted_data = secretbox::seal(file_data, &nonce, &key);
    let mut result = nonce.0.to_vec();
    result.extend_from_slice(&encrypted_data);
    Ok(result)
}

/// Decrypts file data for an account, extracting the nonce and using the deterministic key.
pub fn decrypt_file_for_account(
    account_id: &str,
    encrypted_data: &[u8],
) -> Result<Vec<u8>, String> {
    if encrypted_data.len() < secretbox::NONCEBYTES {
        return Err("Encrypted data too short".to_string());
    }
    let (nonce_bytes, ciphertext) = encrypted_data.split_at(secretbox::NONCEBYTES);
    let key = deterministic_key_for_account(account_id);
    let nonce = secretbox::Nonce::from_slice(nonce_bytes).ok_or("Invalid nonce")?;
    secretbox::open(ciphertext, &nonce, &key).map_err(|_| "Decryption failed".to_string())
}
