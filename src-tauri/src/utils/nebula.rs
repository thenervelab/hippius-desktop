use anyhow::{Result, anyhow};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tokio::fs;
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const NEBULA_GITHUB_API: &str = "https://api.github.com/repos/slackhq/nebula/releases/latest";
const NEBULA_VERSION_FILE: &str = "nebula_version.txt";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NebulaSetupPhase {
    CheckingBinary,
    DownloadingNebula,
    InstallingNebula,
    VerifyingInstallation,
    Ready,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

/// Get the Nebula binary directory in user's home
fn get_nebula_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("Could not find home directory"))?;
    Ok(home.join(".hippius").join("nebula"))
}

/// Get the path to the Nebula binary
pub fn get_nebula_binary_path() -> Result<PathBuf> {
    let nebula_dir = get_nebula_dir()?;
    
    #[cfg(target_os = "windows")]
    {
        Ok(nebula_dir.join("nebula.exe"))
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        Ok(nebula_dir.join("nebula"))
    }
}

/// Determine the correct asset name based on OS and architecture
fn get_asset_name() -> Result<String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    
    let asset_name = match (os, arch) {
        // macOS
        ("macos", _) => "nebula-darwin.zip",
        
        // Windows
        ("windows", "x86_64") => "nebula-windows-amd64.zip",
        ("windows", "aarch64") => "nebula-windows-arm64.zip",
        
        // Linux
        ("linux", "x86_64") => "nebula-linux-amd64.tar.gz",
        ("linux", "aarch64") => "nebula-linux-arm64.tar.gz",
        ("linux", "x86") => "nebula-linux-386.tar.gz",
        ("linux", "arm") => "nebula-linux-arm-7.tar.gz",
        
        // FreeBSD
        ("freebsd", "x86_64") => "nebula-freebsd-amd64.tar.gz",
        ("freebsd", "aarch64") => "nebula-freebsd-arm64.tar.gz",
        
        _ => return Err(anyhow!("Unsupported OS/architecture: {}/{}", os, arch)),
    };
    
    Ok(asset_name.to_string())
}

/// Get the currently installed Nebula version
async fn get_installed_version() -> Option<String> {
    let version_file = get_nebula_dir().ok()?.join(NEBULA_VERSION_FILE);
    fs::read_to_string(version_file).await.ok()
}

/// Save the installed Nebula version
async fn save_installed_version(version: &str) -> Result<()> {
    let nebula_dir = get_nebula_dir()?;
    fs::create_dir_all(&nebula_dir).await?;
    
    let version_file = nebula_dir.join(NEBULA_VERSION_FILE);
    fs::write(version_file, version).await?;
    
    Ok(())
}

/// Check if Nebula is installed and get its version
pub async fn check_nebula_installation() -> Result<Option<String>> {
    let binary_path = get_nebula_binary_path()?;
    
    if !binary_path.exists() {
        return Ok(None);
    }
    
    // Return the saved version
    Ok(get_installed_version().await)
}

/// Fetch the latest Nebula release information from GitHub
async fn fetch_latest_release() -> Result<GitHubRelease> {
    let client = Client::builder()
        .user_agent("hippius-desktop")
        .timeout(Duration::from_secs(30))
        .build()?;
    
    let response = client
        .get(NEBULA_GITHUB_API)
        .send()
        .await?;
    
    if !response.status().is_success() {
        return Err(anyhow!("Failed to fetch latest release: HTTP {}", response.status()));
    }
    
    let release: GitHubRelease = response.json().await?;
    Ok(release)
}

/// Download and extract Nebula binary
async fn download_and_install_nebula(download_url: &str, version: &str) -> Result<()> {
    let nebula_dir = get_nebula_dir()?;
    fs::create_dir_all(&nebula_dir).await?;
    
    println!("[Nebula] Downloading from: {}", download_url);
    
    // Download the archive
    let client = Client::builder()
        .timeout(Duration::from_secs(300))
        .build()?;
    
    let response = client.get(download_url).send().await?;
    
    if !response.status().is_success() {
        return Err(anyhow!("Download failed: HTTP {}", response.status()));
    }
    
    let bytes = response.bytes().await?;
    
    // Determine archive type and extract
    let asset_name = get_asset_name()?;
    
    if asset_name.ends_with(".zip") {
        extract_zip(&bytes, &nebula_dir).await?;
    } else if asset_name.ends_with(".tar.gz") {
        extract_tar_gz(&bytes, &nebula_dir).await?;
    } else {
        return Err(anyhow!("Unsupported archive format"));
    }
    
    // Make binary executable on Unix
    #[cfg(unix)]
    {
        let binary_path = get_nebula_binary_path()?;
        if binary_path.exists() {
            let mut perms = fs::metadata(&binary_path).await?.permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&binary_path, perms).await?;
        }
    }
    
    // Save version
    save_installed_version(version).await?;
    
    println!("[Nebula] Installation complete: version {}", version);
    Ok(())
}

/// Extract ZIP archive
async fn extract_zip(bytes: &[u8], target_dir: &Path) -> Result<()> {
    use std::io::Cursor;
    use zip::ZipArchive;
    
    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor)?;
    
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let filename = file.name().to_string(); // Clone the filename
        
        // Only extract the nebula binary (or nebula.exe on Windows)
        #[cfg(target_os = "windows")]
        let is_binary = filename == "nebula.exe";
        
        #[cfg(not(target_os = "windows"))]
        let is_binary = filename == "nebula";
        
        if is_binary {
            let outpath = target_dir.join(&filename);
            let mut outfile = std::fs::File::create(&outpath)?;
            std::io::copy(&mut file, &mut outfile)?;
            println!("[Nebula] Extracted: {}", filename);
        }
    }
    
    Ok(())
}

/// Extract TAR.GZ archive
async fn extract_tar_gz(bytes: &[u8], target_dir: &Path) -> Result<()> {
    use flate2::read::GzDecoder;
    use tar::Archive;
    use std::io::Cursor;
    
    let cursor = Cursor::new(bytes);
    let gz = GzDecoder::new(cursor);
    let mut archive = Archive::new(gz);
    
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?;
        let filename = path.file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| anyhow!("Invalid filename in archive"))?
            .to_string(); // Clone the filename
        
        // Only extract the nebula binary
        if filename == "nebula" {
            let outpath = target_dir.join(&filename);
            entry.unpack(&outpath)?;
            println!("[Nebula] Extracted: {}", filename);
        }
    }
    
    Ok(())
}

/// Main function to ensure Nebula is installed and up-to-date
pub async fn ensure_nebula_installed(app: AppHandle) -> Result<()> {
    // Emit checking phase
    let _ = app.emit("app_setup_event", NebulaSetupPhase::CheckingBinary);
    
    println!("[Nebula] Checking installation...");
    
    // Check current installation
    let installed_version = check_nebula_installation().await?;
    
    // Fetch latest release
    println!("[Nebula] Fetching latest release information...");
    let latest_release = fetch_latest_release().await?;
    let latest_version = latest_release.tag_name.clone();
    
    println!("[Nebula] Latest version: {}", latest_version);
    
    // Determine if we need to install/update
    let needs_install = match installed_version {
        None => {
            println!("[Nebula] Not installed, will install");
            true
        }
        Some(ref installed) => {
            if installed != &latest_version {
                println!("[Nebula] Update available: {} -> {}", installed, latest_version);
                true
            } else {
                println!("[Nebula] Already up-to-date: {}", installed);
                false
            }
        }
    };
    
    if needs_install {
        // Find the correct asset
        let asset_name = get_asset_name()?;
        let asset = latest_release
            .assets
            .iter()
            .find(|a| a.name == asset_name)
            .ok_or_else(|| anyhow!("Asset not found: {}", asset_name))?;
        
        println!("[Nebula] Downloading asset: {}", asset.name);
        
        // Emit downloading phase
        let _ = app.emit("app_setup_event", NebulaSetupPhase::DownloadingNebula);
        
        // Download and install
        let _ = app.emit("app_setup_event", NebulaSetupPhase::InstallingNebula);
        download_and_install_nebula(&asset.browser_download_url, &latest_version).await?;
        
        // Verify installation
        let _ = app.emit("app_setup_event", NebulaSetupPhase::VerifyingInstallation);
        let binary_path = get_nebula_binary_path()?;
        
        if !binary_path.exists() {
            return Err(anyhow!("Installation verification failed: binary not found"));
        }
        
        println!("[Nebula] Installation verified successfully");
    }
    
    // Emit ready phase
    let _ = app.emit("app_setup_event", NebulaSetupPhase::Ready);
    
    Ok(())
}

#[tauri::command]
pub async fn get_nebula_version() -> Result<String, String> {
    check_nebula_installation()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Nebula not installed".to_string())
}

#[tauri::command]
pub async fn check_nebula_update() -> Result<Option<String>, String> {
    let installed = check_nebula_installation()
        .await
        .map_err(|e| e.to_string())?;
    
    let latest = fetch_latest_release()
        .await
        .map_err(|e| e.to_string())?
        .tag_name;
    
    match installed {
        Some(ref v) if v != &latest => Ok(Some(latest)),
        _ => Ok(None),
    }
}
