use anyhow::{Result, anyhow};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tokio::fs;
use std::time::Duration;
use sysinfo::Networks;
use std::fs::File;
use std::io::{self, BufRead, BufReader};

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

#[derive(Debug, Deserialize)]
struct NebulaCert {
    details: NebulaCertDetails,
}

#[derive(Debug, Deserialize)]
struct NebulaCertDetails {
    ips: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct NebulaStats {
    udp_tx_bytes: u64,
    udp_rx_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct NebulaStatus {
    is_running: bool,
    has_interface: bool,
    message: String,
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

/// Get the path to the Nebula-cert binary
fn get_nebula_cert_binary_path() -> Result<PathBuf> {
    let nebula_dir = get_nebula_dir()?;
    
    #[cfg(target_os = "windows")]
    {
        Ok(nebula_dir.join("nebula-cert.exe"))
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        Ok(nebula_dir.join("nebula-cert"))
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
    
    // Make binaries executable on Unix
    #[cfg(unix)]
    {
        let binary_path = get_nebula_binary_path()?;
        if binary_path.exists() {
            let mut perms = fs::metadata(&binary_path).await?.permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&binary_path, perms).await?;
        }
        
        let cert_binary_path = get_nebula_cert_binary_path()?;
        if cert_binary_path.exists() {
            let mut perms = fs::metadata(&cert_binary_path).await?.permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&cert_binary_path, perms).await?;
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
        let filename = file.name().to_string();
        
        // Extract nebula and nebula-cert binaries
        #[cfg(target_os = "windows")]
        let is_binary = filename == "nebula.exe" || filename == "nebula-cert.exe";
        
        #[cfg(not(target_os = "windows"))]
        let is_binary = filename == "nebula" || filename == "nebula-cert";
        
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
            .to_string();
        
        // Extract nebula and nebula-cert binaries
        if filename == "nebula" || filename == "nebula-cert" {
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
            let cert_binary_exists = get_nebula_cert_binary_path()
                .map(|p| p.exists())
                .unwrap_or(false);

            if installed != &latest_version {
                println!("[Nebula] Update available: {} -> {}", installed, latest_version);
                true
            } else if !cert_binary_exists {
                println!("[Nebula] nebula-cert binary missing, will reinstall");
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
        
        // Verify nebula-cert was also extracted
        let cert_binary_path = get_nebula_cert_binary_path()?;
        if !cert_binary_path.exists() {
            eprintln!("[Nebula] Warning: nebula-cert binary not found at: {}", cert_binary_path.display());
            eprintln!("[Nebula] Certificate generation will not be available");
        } else {
            println!("[Nebula] nebula-cert binary verified: {}", cert_binary_path.display());
        }
    }
    
    // Generate certificates if they don't exist
    let config_dir = get_nebula_config_dir()?;
    let ca_crt = config_dir.join("ca.crt");
    
    // Get hostname for node name
    let hostname = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "node".to_string());

    if !ca_crt.exists() {
        println!("[Nebula] No CA certificate found, generating certificates...");
        
        // Generate CA certificate
        if let Err(e) = generate_ca_certificate("Hippius Network", 3650).await {
            eprintln!("[Nebula] Failed to generate CA certificate: {}", e);
            eprintln!("[Nebula] You can generate certificates manually later");
        } else {
            println!("[Nebula] CA certificate generated successfully");
            
            // Generate node certificate
            let node_ip = "192.168.100.2/24"; // Default IP, can be customized later
            if let Err(e) = generate_node_certificate(&hostname, node_ip, vec![], 365).await {
                eprintln!("[Nebula] Failed to generate node certificate: {}", e);
            } else {
                println!("[Nebula] Node certificate generated for: {}", hostname);
                
                // Generate config file
                if let Err(e) = generate_config_file(&hostname, None, false).await {
                    eprintln!("[Nebula] Failed to generate config file: {}", e);
                } else {
                    println!("[Nebula] Config file generated: {}.yml", hostname);
                }
            }
        }
    } else {
        println!("[Nebula] Certificates already exist, skipping generation");
    }
    
    // Skip automatic Nebula startup - let user start it manually
    println!("[Nebula] Skipping automatic startup - Nebula will need to be started manually");
    
    // Emit ready phase
    let _ = app.emit("app_setup_event", NebulaSetupPhase::Ready);
    
    Ok(())
}

/// Start the Nebula process
pub async fn start_nebula() -> Result<()> {
    // Check if already running
    if check_nebula_running().await? {
        println!("[Nebula] Already running");
        return Ok(());
    }

    let binary_path = get_nebula_binary_path()?;
    let hostname = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "node".to_string());
        
    let config_dir = get_nebula_config_dir()?;
    let config_path = config_dir.join(format!("{}.yml", hostname));
    
    if !binary_path.exists() || !config_path.exists() {
        return Err(anyhow!("Nebula binary or config not found"));
    }
    
    println!("[Nebula] Starting Nebula with config: {}", config_path.display());
    println!("[Nebula] Note: If Nebula fails to start, you may need to grant permissions:");
    println!("[Nebula]   Linux: sudo setcap cap_net_admin+ep ~/.hippius/nebula/nebula");
    println!("[Nebula]   macOS: sudo chown root ~/.hippius/nebula/nebula && sudo chmod u+s ~/.hippius/nebula/nebula");
    
    // Run directly - will fail if permissions not granted
    std::thread::spawn(move || {
        let status = std::process::Command::new(binary_path)
            .arg("-config")
            .arg(config_path)
            .status();
            
        match status {
            Ok(s) => {
                if s.success() {
                    println!("[Nebula] Process exited successfully");
                } else {
                    eprintln!("[Nebula] Process exited with error: {}", s);
                    eprintln!("[Nebula] You may need to grant permissions manually");
                }
            }
            Err(e) => eprintln!("[Nebula] Failed to start: {}", e),
        }
    });
    
    Ok(())
}

/// Check if the binary has required permissions
async fn check_permissions(binary_path: &Path) -> Result<bool> {
    #[cfg(target_os = "linux")]
    {
        // Check for cap_net_admin using getcap
        let output = tokio::process::Command::new("getcap")
            .arg(binary_path)
            .output()
            .await;
            
        match output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                Ok(stdout.contains("cap_net_admin"))
            }
            Err(_) => {
                // getcap might not be installed, assume false
                Ok(false)
            }
        }
    }
    
    #[cfg(target_os = "macos")]
    {
        // Check if owned by root and has setuid bit
        let metadata = fs::metadata(binary_path).await?;
        let mode = metadata.permissions().mode();
        let uid = metadata.uid();
        
        // 0 is root, 0o4000 is setuid
        Ok(uid == 0 && (mode & 0o4000) != 0)
    }
    
    #[cfg(target_os = "windows")]
    {
        // Windows handling is complex, assume true for now or implement check
        Ok(true)
    }
}

/// Grant required permissions to the binary
async fn grant_permissions(binary_path: &Path) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        println!("[Nebula] Requesting cap_net_admin via pkexec...");
        let status = std::process::Command::new("pkexec")
            .arg("setcap")
            .arg("cap_net_admin+ep")
            .arg(binary_path)
            .status()?;
            
        if !status.success() {
            return Err(anyhow!("Failed to set capabilities via pkexec"));
        }
    }
    
    #[cfg(target_os = "macos")]
    {
        println!("[Nebula] Requesting setuid via osascript...");
        let path_str = binary_path.to_str().ok_or_else(|| anyhow!("Invalid path"))?;
        let script = format!(
            "do shell script \"chown root '{0}' && chmod u+s '{0}'\" with administrator privileges",
            path_str
        );
        
        let status = std::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .status()?;
            
        if !status.success() {
            return Err(anyhow!("Failed to set setuid via osascript"));
        }
    }
    
    Ok(())
}

/// Check if Nebula is running
pub async fn check_nebula_running() -> Result<bool> {
    // Simple check using pgrep (linux/mac)
    #[cfg(unix)]
    {
        let output = tokio::process::Command::new("pgrep")
            .arg("-f")
            .arg("nebula")
            .output()
            .await?;
            
        Ok(output.status.success())
    }
    
    #[cfg(windows)]
    {
        Ok(false)
    }
}

#[tauri::command]
pub async fn get_nebula_version() -> Result<String, String> {
    check_nebula_installation()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Nebula not installed".to_string())
}

#[tauri::command]
pub async fn get_nebula_ip() -> Result<String, String> {
    let hostname = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "node".to_string());
        
    let config_dir = get_nebula_config_dir().map_err(|e| e.to_string())?;
    let crt_path = config_dir.join(format!("{}.crt", hostname));
    
    if !crt_path.exists() {
        return Err("Nebula certificate not found".to_string());
    }
    
    let nebula_cert_binary = get_nebula_cert_binary_path().map_err(|e| e.to_string())?;
    
    let output = tokio::process::Command::new(&nebula_cert_binary)
        .args(&[
            "print",
            "-json",
            "-path",
            crt_path.to_str().unwrap(),
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;
        
    if !output.status.success() {
        return Err(format!("Failed to read certificate: {}", String::from_utf8_lossy(&output.stderr)));
    }
    
    let cert: NebulaCert = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse certificate JSON: {}", e))?;
        
    cert.details.ips.first()
        .cloned()
        .ok_or_else(|| "No IP found in certificate".to_string())
}

#[tauri::command]
pub async fn get_nebula_stats() -> Result<NebulaStats, String> {
    // First check if Nebula is running
    let is_running = check_nebula_running()
        .await
        .unwrap_or(false);
    
    // If Nebula is not running, return zeros
    if !is_running {
        return Ok(NebulaStats {
            udp_tx_bytes: 0,
            udp_rx_bytes: 0,
        });
    }
    
    // First try reading from /proc/net/dev which is more reliable on Linux
    if let Ok(stats) = read_interface_stats("nebula1") {
        return Ok(stats);
    }
    
    // Fallback to sysinfo if the direct method fails
    let networks = Networks::new_with_refreshed_list();
    let mut tx_bytes = 0;
    let mut rx_bytes = 0;
    
    for (interface_name, data) in &networks {
        if interface_name.contains("nebula") {
            tx_bytes += data.transmitted();
            rx_bytes += data.received();
        }
    }
    
    Ok(NebulaStats {
        udp_tx_bytes: tx_bytes,
        udp_rx_bytes: rx_bytes,
    })
}

/// Read network interface statistics directly from /proc/net/dev on Linux
fn read_interface_stats(interface: &str) -> Result<NebulaStats, io::Error> {
    let file = File::open("/proc/net/dev")?;
    let reader = BufReader::new(file);
    
    let mut tx_bytes = 0;
    let mut rx_bytes = 0;
    
    for line in reader.lines() {
        let line = line?;
        let parts: Vec<&str> = line.split_whitespace().collect();
        
        if parts.len() >= 10 && parts[0].trim_end_matches(':') == interface {
            // Format: 
            // interface:   bytes    packets errs drop fifo frame compressed multicast    bytes    packets errs drop fifo colls carrier compressed
            rx_bytes = parts[1].parse().unwrap_or(0);
            tx_bytes = parts[9].parse().unwrap_or(0);
            break;
        }
    }
    
    Ok(NebulaStats {
        udp_tx_bytes: tx_bytes,
        udp_rx_bytes: rx_bytes,
    })
}

#[tauri::command]
pub async fn get_nebula_status() -> Result<NebulaStatus, String> {
    let is_running = check_nebula_running()
        .await
        .unwrap_or(false);
    
    // Only check for interface if Nebula is actually running
    let has_interface = if is_running {
        let networks = Networks::new_with_refreshed_list();
        networks.iter().any(|(name, _)| name.contains("nebula"))
    } else {
        false
    };
    
    let message = if is_running && has_interface {
        "Connected".to_string()
    } else if is_running {
        "Starting...".to_string()
    } else {
        "Not running - Start manually".to_string()
    };
    
    Ok(NebulaStatus {
        is_running,
        has_interface,
        message,
    })
}


/// Get the Nebula config directory
fn get_nebula_config_dir() -> Result<PathBuf> {
    // Use ~/.hippius/nebula/config on all platforms to avoid permission issues
    let home = dirs::home_dir().ok_or_else(|| anyhow!("Could not find home directory"))?;
    Ok(home.join(".hippius").join("nebula").join("config"))
}

/// Generate a Nebula CA certificate
pub async fn generate_ca_certificate(
    name: &str,
    duration_days: u32,
) -> Result<()> {
    let nebula_cert_binary = get_nebula_cert_binary_path()?;
    
    // Check if nebula-cert binary exists
    if !nebula_cert_binary.exists() {
        return Err(anyhow!(
            "nebula-cert binary not found at: {}. Please restart the app to download it.",
            nebula_cert_binary.display()
        ));
    }
    
    let config_dir = get_nebula_config_dir()?;
    
    // Ensure config directory exists
    println!("[Nebula] Creating config directory: {}", config_dir.display());
    fs::create_dir_all(&config_dir).await?;
    
    let ca_crt = config_dir.join("ca.crt");
    let ca_key = config_dir.join("ca.key");
    
    println!("[Nebula] Generating CA certificate: {}", name);
    println!("[Nebula] Using binary: {}", nebula_cert_binary.display());
    
    let output = tokio::process::Command::new(&nebula_cert_binary)
        .args(&[
            "ca",
            "-name",
            name,
            "-duration",
            &format!("{}h", duration_days * 24),
            "-out-crt",
            ca_crt.to_str().unwrap(),
            "-out-key",
            ca_key.to_str().unwrap(),
        ])
        .output()
        .await?;
    
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(anyhow!(
            "CA generation failed.\nStderr: {}\nStdout: {}", 
            stderr,
            stdout
        ));
    }
    
    println!("[Nebula] CA certificate generated successfully");
    println!("[Nebula]   Certificate: {}", ca_crt.display());
    println!("[Nebula]   Key: {}", ca_key.display());
    
    Ok(())
}

/// Generate a Nebula node certificate
pub async fn generate_node_certificate(
    name: &str,
    ip: &str,
    groups: Vec<String>,
    duration_days: u32,
) -> Result<()> {
    let nebula_cert_binary = get_nebula_cert_binary_path()?;
    let config_dir = get_nebula_config_dir()?;
    
    let ca_crt = config_dir.join("ca.crt");
    let ca_key = config_dir.join("ca.key");
    let node_crt = config_dir.join(format!("{}.crt", name));
    let node_key = config_dir.join(format!("{}.key", name));
    
    if !ca_crt.exists() || !ca_key.exists() {
        return Err(anyhow!("CA certificate not found. Generate CA first."));
    }
    
    println!("[Nebula] Generating node certificate: {}", name);
    
    let duration_str = format!("{}h", duration_days * 24);
    let ca_crt_str = ca_crt.to_str().unwrap();
    let ca_key_str = ca_key.to_str().unwrap();
    let node_crt_str = node_crt.to_str().unwrap();
    let node_key_str = node_key.to_str().unwrap();
    
    let mut cmd = tokio::process::Command::new(&nebula_cert_binary);
    let mut args: Vec<&str> = vec![
        "sign",
        "-name",
        name,
        "-ip",
        ip,
        "-duration",
        &duration_str,
        "-ca-crt",
        ca_crt_str,
        "-ca-key",
        ca_key_str,
        "-out-crt",
        node_crt_str,
        "-out-key",
        node_key_str,
    ];
    
    // Add groups
    let group_strs: Vec<String> = groups.iter().map(|g| g.as_str().to_string()).collect();
    for group in &group_strs {
        args.push("-groups");
        args.push(group);
    }
    
    cmd.args(&args);
    
    let output = cmd.output().await?;
    
    if !output.status.success() {
        return Err(anyhow!("Node certificate generation failed: {}", 
            String::from_utf8_lossy(&output.stderr)));
    }
    
    println!("[Nebula] Node certificate generated successfully");
    println!("[Nebula]   Certificate: {}", node_crt.display());
    println!("[Nebula]   Key: {}", node_key.display());
    
    Ok(())
}

/// Generate a basic Nebula config file
pub async fn generate_config_file(
    node_name: &str,
    lighthouse_ip: Option<&str>,
    is_lighthouse: bool,
) -> Result<()> {
    let config_dir = get_nebula_config_dir()?;
    let config_file = config_dir.join(format!("{}.yml", node_name));
    
    let ca_crt = config_dir.join("ca.crt");
    let node_crt = config_dir.join(format!("{}.crt", node_name));
    let node_key = config_dir.join(format!("{}.key", node_name));
    
    let config_content = if is_lighthouse {
        format!(r#"# Nebula Lighthouse Configuration
pki:
  ca: {}
  cert: {}
  key: {}

static_host_map:
  # Add your public IP here if this lighthouse is behind NAT
  # "192.168.100.1": ["public.ip.address:4242"]

lighthouse:
  am_lighthouse: true
  interval: 60

listen:
  host: 0.0.0.0
  port: 4242

punchy:
  punch: true
  respond: true

tun:
  dev: nebula1
  drop_local_broadcast: false
  drop_multicast: false

logging:
  level: info
  format: text

firewall:
  conntrack:
    tcp_timeout: 12m
    udp_timeout: 3m
    default_timeout: 10m

  outbound:
    - port: any
      proto: any
      host: any

  inbound:
    - port: any
      proto: any
      host: any

stats:
  listen: 127.0.0.1:4243
  path: /metrics
  namespace: nebula
  interval: 10s
"#,
            ca_crt.display(),
            node_crt.display(),
            node_key.display()
        )
    } else {
        let lighthouse_hosts = lighthouse_ip
            .map(|ip| format!("  - \"{}\"", ip))
            .unwrap_or_else(|| "  # - \"192.168.100.1\"".to_string());
        
        format!(r#"# Nebula Node Configuration
pki:
  ca: {}
  cert: {}
  key: {}

static_host_map:
  # Map lighthouse nebula IP to its public address
  # "192.168.100.1": ["lighthouse.public.ip:4242"]

lighthouse:
  am_lighthouse: false
  interval: 60
  hosts:
{}

listen:
  host: 0.0.0.0
  port: 4242

punchy:
  punch: true
  respond: true

tun:
  dev: nebula1
  drop_local_broadcast: false
  drop_multicast: false

logging:
  level: info
  format: text

firewall:
  conntrack:
    tcp_timeout: 12m
    udp_timeout: 3m
    default_timeout: 10m

  outbound:
    - port: any
      proto: any
      host: any

  inbound:
    - port: any
      proto: any
      host: any

stats:
  listen: 127.0.0.1:4243
  path: /metrics
  namespace: nebula
  interval: 10s
"#,
            ca_crt.display(),
            node_crt.display(),
            node_key.display(),
            lighthouse_hosts
        )
    };
    
    fs::write(&config_file, config_content.as_bytes()).await?;
    
    println!("[Nebula] Config file generated: {}", config_file.display());
    
    Ok(())
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
