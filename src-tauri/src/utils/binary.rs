use base64::{engine::general_purpose, Engine as _};
use once_cell::sync::OnceCell;
use sha2::{Digest, Sha256};
use std::fs;
use crate::constants::ipfs::KUBO_VERSION;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration as StdDuration;
use tauri::Emitter;
use tokio::sync::Mutex;
use tokio::task;

static DOWNLOAD_STATE: OnceCell<Mutex<Option<PathBuf>>> = OnceCell::new();

pub fn get_binary_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not find home directory".to_string())?;

    #[cfg(target_os = "windows")]
    let binary_name = "ipfs.exe";
    #[cfg(not(target_os = "windows"))]
    let binary_name = "ipfs";

    Ok(home.join(".hippius").join("bin").join(binary_name))
}

pub async fn ensure_ipfs_binary(app: tauri::AppHandle) -> Result<PathBuf, String> {
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
                // Emit DownloadingBinary event even when binary exists (for frontend consistency)
                app.emit(
                    crate::constants::ipfs::APP_SETUP_EVENT,
                    crate::constants::ipfs::AppSetupPhase::DownloadingBinary,
                )
                .unwrap_or_else(|e| eprintln!("Emit failed: {e}"));
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
        // Emit DownloadingBinary event
        app.emit(
            crate::constants::ipfs::APP_SETUP_EVENT,
            crate::constants::ipfs::AppSetupPhase::DownloadingBinary,
        )
        .unwrap_or_else(|e| eprintln!("Emit failed: {e}"));

        println!("Starting IPFS binary download");
        // We're the downloading thread
        let result = task::spawn_blocking(move || download_and_extract_binary(&binary_path))
            .await
            .map_err(|e| format!("Task join error: {}", e))??;

        // Clear the download state
        let mut download_state = DOWNLOAD_STATE.get().unwrap().lock().await;
        *download_state = None;

        return Ok(result);
    } else {
        // Emit DownloadingBinary event
        app.emit(
            crate::constants::ipfs::APP_SETUP_EVENT,
            crate::constants::ipfs::AppSetupPhase::DownloadingBinary,
        )
        .unwrap_or_else(|e| eprintln!("Emit failed: {e}"));
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
    println!("Parent directories ensured for: {:?}", binary_path);

    // Set up reqwest client with timeout
    let client = reqwest::blocking::ClientBuilder::new()
        .timeout(StdDuration::from_secs(300)) // Increased to 5 minutes
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
    println!("HTTP client created");

    // Download the file
    println!("Starting download...");
    let response = client
        .get(&download_url)
        .send()
        .map_err(|e| format!("Failed to download IPFS: {}", e))?;

    println!("HTTP response status: {}", response.status());
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

        let file = fs::File::open(&temp_file)
            .map_err(|e| format!("Failed to open zip file: {}", e))?;

        let mut archive = zip::ZipArchive::new(file)
            .map_err(|e| format!("Failed to read zip archive: {}", e))?;

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
        let tar_gz = fs::File::open(&temp_file)
            .map_err(|e| format!("Failed to open archive: {}", e))?;
        let tar = flate2::read::GzDecoder::new(tar_gz);
        let mut archive = tar::Archive::new(tar);

        println!("Extracting archive to {:?}", temp_dir);
        archive
            .unpack(&temp_dir)
            .map_err(|e| format!("Failed to extract archive: {}", e))?;

    }

    // Look for IPFS binary
    println!("Looking for IPFS binary in {:?}", temp_dir);
    let possible_paths = vec![
        #[cfg(target_os = "windows")]
        temp_dir.join("ipfs.exe"),
        #[cfg(target_os = "windows")]
        temp_dir.join("kubo").join("ipfs.exe"),
        #[cfg(target_os = "windows")]
        temp_dir.join("go-ipfs").join("ipfs.exe"),
        #[cfg(target_os = "windows")]
        temp_dir.join(format!("kubo_v{}", KUBO_VERSION)).join("ipfs.exe"),
        #[cfg(target_os = "windows")]
        temp_dir.join("ipfs").join("ipfs.exe"), // Additional path
        #[cfg(not(target_os = "windows"))]
        temp_dir.join("ipfs"),
        #[cfg(not(target_os = "windows"))]
        temp_dir.join("kubo").join("ipfs"),
        #[cfg(not(target_os = "windows"))]
        temp_dir.join("go-ipfs").join("ipfs"),
    ];

    let source_binary = possible_paths.clone()
        .into_iter()
        .find(|path| {
            path.exists()
        })
        .ok_or_else(|| {
            format!(
                "IPFS binary not found after extraction in {:?}. Checked paths: {:?}",
                temp_dir, possible_paths.clone()
            )
        })?;


    // Remove existing binary if it exists
    if binary_path.exists() {
        fs::remove_file(binary_path)
            .map_err(|e| format!("Failed to remove existing binary: {}", e))?;
    }

    // Copy instead of rename in case of cross-filesystem issues
    fs::copy(&source_binary, binary_path).map_err(|e| format!("Failed to copy binary: {}", e))?;

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

/// Ensures the IPFS repo is initialized (i.e., ~/.ipfs/config exists). If not, runs 'ipfs init'.
pub fn ensure_ipfs_repo_initialized(bin_path: &PathBuf) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not find home directory".to_string())?;
    let repo_path = home.join(".ipfs").join("config");
    if repo_path.exists() {
        println!("IPFS repo already initialized at {:?}", repo_path);
        return Ok(());
    }
    println!("No IPFS repo found, running 'ipfs init'...");
    let output = Command::new(bin_path)
        .arg("init")
        .output()
        .map_err(|e| format!("Failed to run 'ipfs init': {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "'ipfs init' failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    println!("IPFS repo initialized successfully.");
    Ok(())
}