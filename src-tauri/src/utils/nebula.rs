use anyhow::{Result, anyhow};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_yaml;
use sqlx::Row;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tokio::fs;
use sysinfo::Networks;
use std::sync::Mutex;
use once_cell::sync::Lazy;
use std::time::Duration;
use tokio::task::JoinHandle;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const NEBULA_GITHUB_API: &str = "https://api.github.com/repos/slackhq/nebula/releases/latest";
const NEBULA_VERSION_FILE: &str = "nebula_version.txt";

// Ping interval for keeping stats active (seconds)
const PING_INTERVAL_SECS: u64 = 10;

// State to share between setup commands
struct NebulaSetupState {
    latest_version: Option<String>,
    download_url: Option<String>,
    needs_update: bool,
}

static SETUP_STATE: Lazy<Mutex<NebulaSetupState>> = Lazy::new(|| {
    Mutex::new(NebulaSetupState {
        latest_version: None,
        download_url: None,
        needs_update: false,
    })
});

// Handle for the background ping task
static PING_TASK_HANDLE: Lazy<Mutex<Option<JoinHandle<()>>>> = Lazy::new(|| Mutex::new(None));

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
    #[serde(default)]
    ips: Vec<String>,
    #[serde(default)]
    networks: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct NebulaStats {
    udp_tx_bytes: f64,
    udp_rx_bytes: f64,
}

#[derive(Debug, Serialize)]
pub struct NebulaStatus {
    is_running: bool,
    has_interface: bool,
    message: String,
}

/// Struct to parse lighthouse hosts from config.yml
#[derive(Debug, Deserialize)]
struct NebulaConfig {
    lighthouse: Option<LighthouseConfig>,
}

#[derive(Debug, Deserialize)]
struct LighthouseConfig {
    hosts: Option<Vec<String>>,
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

// --- New Granular Commands ---

#[tauri::command]
pub async fn check_nebula_requirements(app: AppHandle) -> Result<(), String> {
    println!("[Nebula] Checking requirements...");
    
    // Check current installation
    let installed_version = check_nebula_installation().await.map_err(|e| e.to_string())?;
    
    // Fetch latest release
    let latest_release = fetch_latest_release().await.map_err(|e| e.to_string())?;
    let latest_version = latest_release.tag_name.clone();
    
    println!("[Nebula] Latest version: {}", latest_version);
    
    let mut needs_install = false;
    
    if installed_version.is_none() {
        println!("[Nebula] Not installed, will install");
        needs_install = true;
    } else if let Some(ref installed) = installed_version {
        let cert_binary_exists = get_nebula_cert_binary_path()
            .map(|p| p.exists())
            .unwrap_or(false);

        if installed != &latest_version {
            println!("[Nebula] Update available: {} -> {}", installed, latest_version);
            needs_install = true;
        } else if !cert_binary_exists {
            println!("[Nebula] nebula-cert binary missing, will reinstall");
            needs_install = true;
        } else {
            println!("[Nebula] Already up-to-date: {}", installed);
        }
    }
    
    // Find asset URL if needed
    let mut download_url = None;
    if needs_install {
        let asset_name = get_asset_name().map_err(|e| e.to_string())?;
        let asset = latest_release
            .assets
            .iter()
            .find(|a| a.name == asset_name)
            .ok_or_else(|| format!("Asset not found: {}", asset_name))?;
        download_url = Some(asset.browser_download_url.clone());
    }
    
    // Update state
    {
        let mut state = SETUP_STATE.lock().unwrap();
        state.latest_version = Some(latest_version);
        state.download_url = download_url;
        state.needs_update = needs_install;
    }
    
    Ok(())
}

#[tauri::command]
pub async fn download_nebula(app: AppHandle) -> Result<(), String> {
    let (needs_update, download_url, latest_version) = {
        let state = SETUP_STATE.lock().unwrap();
        (state.needs_update, state.download_url.clone(), state.latest_version.clone())
    };
    
    if needs_update {
        if let (Some(url), Some(version)) = (download_url, latest_version) {
            // Check if temp file already exists (maybe from previous run?)
            // But we should re-download to be safe or check size. 
            // For now, just download.
            
            let nebula_dir = get_nebula_dir().map_err(|e| e.to_string())?;
            fs::create_dir_all(&nebula_dir).await.map_err(|e| e.to_string())?;
            let temp_path = nebula_dir.join("temp_download.file");
            
            println!("[Nebula] Downloading to temp file: {}", temp_path.display());
            
            let client = Client::builder()
                .timeout(Duration::from_secs(300))
                .build()
                .map_err(|e| e.to_string())?;
            
            let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
            
            if !response.status().is_success() {
                return Err(format!("Download failed: HTTP {}", response.status()));
            }
            
            let bytes = response.bytes().await.map_err(|e| e.to_string())?;
            fs::write(&temp_path, bytes).await.map_err(|e| e.to_string())?;
            
            println!("[Nebula] Download complete");
        }
    }
    
    Ok(())
}

#[tauri::command]
pub async fn install_nebula(app: AppHandle) -> Result<(), String> {
    let (needs_update, latest_version) = {
        let state = SETUP_STATE.lock().unwrap();
        (state.needs_update, state.latest_version.clone())
    };
    
    if needs_update {
        let nebula_dir = get_nebula_dir().map_err(|e| e.to_string())?;
        let temp_path = nebula_dir.join("temp_download.file");
        
        if temp_path.exists() {
             println!("[Nebula] Installing from temp file...");
             let bytes = fs::read(&temp_path).await.map_err(|e| e.to_string())?;
             
             // Determine archive type from asset name
             let asset_name = get_asset_name().map_err(|e| e.to_string())?;
             
             if asset_name.ends_with(".zip") {
                 extract_zip(&bytes, &nebula_dir).await.map_err(|e| e.to_string())?;
             } else if asset_name.ends_with(".tar.gz") {
                 extract_tar_gz(&bytes, &nebula_dir).await.map_err(|e| e.to_string())?;
             }
             
             // Cleanup
             let _ = fs::remove_file(temp_path).await;
             
             // Permissions
             #[cfg(unix)]
            {
                let binary_path = get_nebula_binary_path().map_err(|e| e.to_string())?;
                if binary_path.exists() {
                    let mut perms = fs::metadata(&binary_path).await.map_err(|e| e.to_string())?.permissions();
                    perms.set_mode(0o755);
                    fs::set_permissions(&binary_path, perms).await.map_err(|e| e.to_string())?;
                }
                
                let cert_binary_path = get_nebula_cert_binary_path().map_err(|e| e.to_string())?;
                if cert_binary_path.exists() {
                    let mut perms = fs::metadata(&cert_binary_path).await.map_err(|e| e.to_string())?.permissions();
                    perms.set_mode(0o755);
                    fs::set_permissions(&cert_binary_path, perms).await.map_err(|e| e.to_string())?;
                }
            }
            
            if let Some(v) = latest_version {
                save_installed_version(&v).await.map_err(|e| e.to_string())?;
            }
            
            // Grant permissions to the binary (required for TUN/TAP device creation)
            let binary_path = get_nebula_binary_path().map_err(|e| e.to_string())?;
            println!("[Nebula] Checking and granting permissions...");
            
            match check_permissions(&binary_path).await {
                Ok(has_perms) => {
                    if !has_perms {
                        println!("[Nebula] Binary needs permissions, requesting elevated access...");
                        if let Err(e) = grant_permissions(&binary_path).await {
                            eprintln!("[Nebula] Warning: Failed to grant permissions: {}. You may need to run the app with elevated privileges or grant permissions manually.", e);
                        } else {
                            println!("[Nebula] Permissions granted successfully");
                        }
                    } else {
                        println!("[Nebula] Binary already has required permissions");
                    }
                }
                Err(e) => {
                    eprintln!("[Nebula] Warning: Failed to check permissions: {}", e);
                }
            }
            
            // Update database to mark binary as installed
            let pool = crate::DB_POOL.get().ok_or("Database not initialized".to_string())?;
            if let Err(e) = sqlx::query(
                "UPDATE nebula_binary_status SET is_nebula_binary_installed = TRUE, last_updated = CURRENT_TIMESTAMP WHERE id = 1"
            )
            .execute(pool)
            .await {
                eprintln!("[Nebula] Failed to update binary installation status: {}", e);
            } else {
                println!("[Nebula] Binary installation status updated in database");
            }
        } else {
             return Err("Installation failed: Downloaded file not found".to_string());
        }
    } else {
        // Binary is already installed, update database status
        let pool = crate::DB_POOL.get().ok_or("Database not initialized".to_string())?;
        if let Err(e) = sqlx::query(
            "UPDATE nebula_binary_status SET is_nebula_binary_installed = TRUE, last_updated = CURRENT_TIMESTAMP WHERE id = 1"
        )
        .execute(pool)
        .await {
            eprintln!("[Nebula] Failed to update binary installation status: {}", e);
        } else {
            println!("[Nebula] Binary already installed, status updated in database");
        }
    }
    
    Ok(())
}

#[tauri::command]
pub async fn verify_nebula(app: AppHandle) -> Result<(), String> {
    // Verify binaries
    let binary_path = get_nebula_binary_path().map_err(|e| e.to_string())?;
    if !binary_path.exists() {
        return Err("Verification failed: Nebula binary not found".to_string());
    }
    
    // Check VPN status in DB
    let pool = crate::DB_POOL.get().ok_or("Database not initialized".to_string())?;
    
    let is_enabled: bool = sqlx::query("SELECT is_enabled FROM vpn_status WHERE id = 1")
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .map(|row| row.get("is_enabled"))
        .unwrap_or(false);

    if !is_enabled {
        println!("[Nebula] VPN is disabled in settings, skipping certificate setup");
        return Ok(());
    }
    
    // Check and grant permissions if needed
    println!("[Nebula] Verifying binary permissions...");
    match check_permissions(&binary_path).await {
        Ok(has_perms) => {
            if !has_perms {
                println!("[Nebula] Binary needs permissions, requesting elevated access...");
                if let Err(e) = grant_permissions(&binary_path).await {
                    eprintln!("[Nebula] Warning: Failed to grant permissions: {}. Nebula may fail to start.", e);
                } else {
                    println!("[Nebula] Permissions granted successfully");
                }
            } else {
                println!("[Nebula] Binary has required permissions");
            }
        }
        Err(e) => {
            eprintln!("[Nebula] Warning: Failed to check permissions: {}", e);
        }
    }
    
    // Setup certificates from API (using mock data for now)
    let config_dir = get_nebula_config_dir().map_err(|e| e.to_string())?;
    let ca_crt = config_dir.join("ca.crt");
    
    if !ca_crt.exists() {
        println!("[Nebula] Setting up certificates from API...");
        setup_nebula_from_api().await.map_err(|e| e.to_string())?;
    } else {
        println!("[Nebula] Certificates already exist, skipping setup");
    }
    
    Ok(())
}

/// Setup Nebula using certificates and config from API
/// For now, uses mock data until API is ready
async fn setup_nebula_from_api() -> Result<()> {
    let config_dir = get_nebula_config_dir()?;
    fs::create_dir_all(&config_dir).await?;
    
    println!("[Nebula] Using API credentials (mock data)");
    
    // Mock API response - replace this with actual API call later
    let ca_cert = r#"-----BEGIN NEBULA CERTIFICATE-----
CkEKD0hpcHBpdXNWTjEsIEluYyj+lZDJBjD+mKiUBzogi5DLE8kKgr6AJ0E3uSMc
mHwyFrvUMIOLzMDl+i0j+mxAARJAieLMGaFk9mYVA4Q46+GkDf6DTRp1hrtRL7w8
sQaU5S1vK2TWa1tI4wP89LdxHOfxgOEIvf5fpeYSIZdKTkRXCA==
-----END NEBULA CERTIFICATE-----
"#;
    
    let host_cert = r#"-----BEGIN NEBULA CERTIFICATE-----
CmwKDmhpcHBpdXMta2V5LTAxEgqfgICiBoCAgP4PKMGNtskGMMGn1MoGOiD2fxDq
doBwGRspvSSI19zszkw+uWbq756XkqQLqSOtREogyzVeS1g6yQLRYYTdGGQa+cp3
xp07HNvv7hAEZHy17OUSQDMCKFL5Es3zLHAjHIyXiuS1BVBvnytX/h1lxZlHzdDJ
Q5d7u2gTy459pq/7XVvl/Cf5T5MoxmCc/t/6lemM4QU=
-----END NEBULA CERTIFICATE-----
"#;
    
    let host_key = r#"-----BEGIN NEBULA X25519 PRIVATE KEY-----
+V3Z9jiGMdRF9hH16v9avHIVXlawg3FHZHlR5D69nB0=
-----END NEBULA X25519 PRIVATE KEY-----
"#;
    
    let nebula_ip = "100.64.0.31";
    
    // Write certificates
    let ca_crt_path = config_dir.join("ca.crt");
    let host_crt_path = config_dir.join("host.crt");
    let host_key_path = config_dir.join("host.key");
    
    fs::write(&ca_crt_path, ca_cert).await?;
    fs::write(&host_crt_path, host_cert).await?;
    fs::write(&host_key_path, host_key).await?;
    
    println!("[Nebula] Certificates written to: {}", config_dir.display());
    
    // Generate config file with correct paths
    let config_content = format!(r#"pki:
  ca: {}
  cert: {}
  key: {}

# Map lighthouse nebula IPs to their public IPs
static_host_map:
  "100.64.0.1": ["51.83.22.71:4242"]
  "100.64.0.2": ["139.99.219.137:4242"]
  "100.64.0.3": ["15.235.44.178:4242"]

lighthouse:
  am_lighthouse: false
  interval: 60
  hosts:
    - "100.64.0.1"
    - "100.64.0.2"
    - "100.64.0.3"

listen:
  host: 0.0.0.0
  port: 4242

punchy:
  punch: true
  respond: true

tun:
  disabled: false
  dev: nebula1
  drop_local_broadcast: false
  drop_multicast: false
  tx_queue: 500
  mtu: 1300

logging:
  level: info
  format: text

# Nebula overlay network firewall
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

    # HCC API Services
    - port: 9999
      proto: tcp
      host: any

    # Allow ICMP ping
    - port: any
      proto: icmp
      host: any
"#,
        ca_crt_path.display(),
        host_crt_path.display(),
        host_key_path.display()
    );
    
    let config_file = config_dir.join("config.yml");
    fs::write(&config_file, config_content.as_bytes()).await?;
    
    println!("[Nebula] Config file written: {}", config_file.display());
    println!("[Nebula] Node IP: {}", nebula_ip);
    
    Ok(())
}

#[tauri::command]
pub async fn finish_setup() -> Result<(), String> {
    // Try to start Nebula if enabled
    if let Err(e) = start_nebula_internal().await {
        println!("[Nebula] Failed to auto-start in finish_setup: {}", e);
        // We don't return error here to not block the UI flow, just log it
    }
    
    Ok(())
}

#[tauri::command]
pub async fn start_nebula() -> Result<(), String> {
    start_nebula_internal().await
}

pub async fn start_nebula_internal() -> Result<(), String> {
    println!("[Nebula] Attempting to start Nebula...");
    
    // Check DB status
    let pool = crate::DB_POOL.get().ok_or("Database not initialized".to_string())?;
    
    let is_enabled: bool = sqlx::query("SELECT is_enabled FROM vpn_status WHERE id = 1")
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .map(|row| row.get("is_enabled"))
        .unwrap_or(false);

    if !is_enabled {
        println!("[Nebula] VPN is disabled in settings, skipping startup");
        return Ok(());
    }

    if check_nebula_running().await.unwrap_or(false) {
        println!("[Nebula] Already running");
        // Start ping task even if already running (in case it was stopped)
        start_ping_task();
        return Ok(());
    }

    let binary_path = get_nebula_binary_path().map_err(|e| e.to_string())?;
    let config_dir = get_nebula_config_dir().map_err(|e| e.to_string())?;
    
    // Use config.yml (from API) instead of hostname-based config
    let config_file = config_dir.join("config.yml");

    if !config_file.exists() {
        return Err(format!("Config file not found: {}. Run verify_nebula first.", config_file.display()));
    }

    println!("[Nebula] Starting process: {} -config {}", binary_path.display(), config_file.display());

    // Spawn the process using setsid to detach it from our process tree
    // This prevents zombie processes when we kill it
    #[cfg(not(target_os = "windows"))]
    {
        use std::process::Stdio;
        
        // Use setsid to start nebula in its own session
        // This makes it independent of our process tree
        let child = std::process::Command::new("setsid")
            .arg(&binary_path)
            .arg("-config")
            .arg(&config_file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to spawn nebula with setsid: {}", e))?;
            
        println!("[Nebula] Started with PID: {}", child.id());
    }

    #[cfg(target_os = "windows")]
    {
        let child = std::process::Command::new(&binary_path)
            .arg("-config")
            .arg(&config_file)
            .spawn()
            .map_err(|e| format!("Failed to spawn nebula: {}", e))?;
            
        println!("[Nebula] Started with PID: {}", child.id());
    }

    // Start the background ping task to keep stats active
    start_ping_task();

    Ok(())
}

// --- End New Commands ---

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
    #[cfg(unix)]
    {
        // Use ps to check if nebula is running and NOT a zombie
        // This is more reliable than pgrep for detecting actual running processes
        let output = tokio::process::Command::new("ps")
            .args(&["-C", "nebula", "-o", "stat="])
            .output()
            .await?;
            
        if !output.status.success() {
            // No process found
            return Ok(false);
        }
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        
        // Check if any of the processes are NOT zombies
        // Zombie processes have 'Z' in their state
        for line in stdout.lines() {
            let state = line.trim();
            if !state.is_empty() && !state.contains('Z') {
                // Found a non-zombie nebula process
                return Ok(true);
            }
        }
        
        // All processes are zombies or no processes found
        Ok(false)
    }
    
    #[cfg(windows)]
    {
        Ok(false)
    }
}

/// Stop the Nebula process and the background ping task
pub async fn stop_nebula() -> Result<(), String> {
    println!("[Nebula] Stopping Nebula process...");
    
    // Stop the background ping task first
    stop_ping_task();
    
    #[cfg(unix)]
    {
        // Use pkill to terminate nebula process with exact name match
        let output = tokio::process::Command::new("pkill")
            .arg("-x")
            .arg("nebula")
            .output()
            .await
            .map_err(|e| format!("Failed to execute pkill: {}", e))?;
            
        if output.status.success() {
            println!("[Nebula] Termination signal sent, waiting for process to stop...");
            
            // Wait for the process to actually stop (up to 5 seconds)
            // Check every 100ms for faster response
            for i in 0..50 {
                tokio::time::sleep(Duration::from_millis(100)).await;
                
                if !check_nebula_running().await.unwrap_or(false) {
                    println!("[Nebula] Process stopped successfully after {} ms", (i + 1) * 100);
                    return Ok(());
                }
                
                if i == 49 {
                    eprintln!("[Nebula] Warning: Process may still be running after 5 seconds");
                }
            }
        } else {
            println!("[Nebula] No process found or already stopped");
        }
    }
    
    #[cfg(windows)]
    {
        // Windows implementation using taskkill
        let output = tokio::process::Command::new("taskkill")
            .args(&["/F", "/IM", "nebula.exe"])
            .output()
            .await
            .map_err(|e| format!("Failed to execute taskkill: {}", e))?;
            
        if output.status.success() {
            println!("[Nebula] Termination signal sent, waiting for process to stop...");
            
            // Wait for the process to actually stop (up to 5 seconds)
            for i in 0..50 {
                tokio::time::sleep(Duration::from_millis(100)).await;
                
                // On Windows, we'd need a proper check here
                // For now, just wait a bit
                if i == 49 {
                    println!("[Nebula] Process stopped successfully");
                }
            }
        } else {
            println!("[Nebula] No process found or already stopped");
        }
    }
    
    Ok(())
}

/// Read lighthouse IPs from the Nebula config file
async fn read_lighthouse_ips_from_config() -> Vec<String> {
    let config_dir = match get_nebula_config_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("[Nebula Ping] Failed to get config dir: {}", e);
            return Vec::new();
        }
    };
    
    let config_file = config_dir.join("config.yml");
    
    if !config_file.exists() {
        eprintln!("[Nebula Ping] Config file not found: {}", config_file.display());
        return Vec::new();
    }
    
    let content = match tokio::fs::read_to_string(&config_file).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Nebula Ping] Failed to read config file: {}", e);
            return Vec::new();
        }
    };
    
    let config: NebulaConfig = match serde_yaml::from_str(&content) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Nebula Ping] Failed to parse config file: {}", e);
            return Vec::new();
        }
    };
    
    config.lighthouse
        .and_then(|l| l.hosts)
        .unwrap_or_default()
}

/// Start the background ping task to keep VPN stats active
fn start_ping_task() {
    // Stop any existing ping task first
    stop_ping_task();
    
    let handle = tokio::spawn(async {
        println!("[Nebula Ping] Starting background ping task (interval: {}s)", PING_INTERVAL_SECS);
        
        // Wait a bit for Nebula to fully initialize
        tokio::time::sleep(Duration::from_secs(3)).await;
        
        // Read lighthouse IPs from config
        let lighthouse_ips = read_lighthouse_ips_from_config().await;
        
        if lighthouse_ips.is_empty() {
            eprintln!("[Nebula Ping] No lighthouse IPs found in config, ping task will not run");
            return;
        }
        
        println!("[Nebula Ping] Loaded {} lighthouse IPs from config: {:?}", lighthouse_ips.len(), lighthouse_ips);
        
        let mut lighthouse_index = 0;
        
        loop {
            // Rotate through lighthouse IPs
            let target_ip = &lighthouse_ips[lighthouse_index];
            lighthouse_index = (lighthouse_index + 1) % lighthouse_ips.len();
            
            // Perform ping
            #[cfg(unix)]
            {
                let _ = tokio::process::Command::new("ping")
                    .args(&["-c", "1", "-W", "2", target_ip])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .await;
            }
            
            #[cfg(windows)]
            {
                let _ = tokio::process::Command::new("ping")
                    .args(&["-n", "1", "-w", "2000", target_ip])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .await;
            }
            
            // Wait before next ping
            tokio::time::sleep(Duration::from_secs(PING_INTERVAL_SECS)).await;
        }
    });
    
    // Store the handle
    if let Ok(mut guard) = PING_TASK_HANDLE.lock() {
        *guard = Some(handle);
        println!("[Nebula Ping] Background ping task started");
    }
}

/// Stop the background ping task
fn stop_ping_task() {
    if let Ok(mut guard) = PING_TASK_HANDLE.lock() {
        if let Some(handle) = guard.take() {
            handle.abort();
            println!("[Nebula Ping] Background ping task stopped");
        }
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
    let config_dir = get_nebula_config_dir().map_err(|e| e.to_string())?;
    // Use host.crt from API instead of hostname-based cert
    let crt_path = config_dir.join("host.crt");
    
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
    
    // The output is an array of certificates
    let certs: Vec<NebulaCert> = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse certificate JSON: {}", e))?;
    
    let cert = certs.first()
        .ok_or_else(|| "No certificate found in output".to_string())?;
    
    // Try networks first (newer format), then fall back to ips (older format)
    let ip_cidr = cert.details.networks.first()
        .or_else(|| cert.details.ips.first())
        .ok_or_else(|| "No IP found in certificate".to_string())?;
    
    // Extract IP from CIDR notation (e.g., "100.64.0.31/10" -> "100.64.0.31")
    let ip = ip_cidr.split('/').next()
        .ok_or_else(|| "Invalid IP format in certificate".to_string())?;
    
    Ok(ip.to_string())
}

#[tauri::command]
pub async fn get_nebula_stats() -> Result<NebulaStats, String> {
    // Platform-specific implementations for accurate TUN interface statistics
    
    #[cfg(target_os = "linux")]
    {
        // Linux: Read directly from /sys/class/net (most reliable for TUN interfaces)
        let tx_bytes = read_sys_net_stat("nebula1", "tx_bytes").await?;
        let rx_bytes = read_sys_net_stat("nebula1", "rx_bytes").await?;
        
        let mb_tx = tx_bytes as f64 / (1024.0 * 1024.0);
        let mb_rx = rx_bytes as f64 / (1024.0 * 1024.0);
        
        
        Ok(NebulaStats {
            udp_tx_bytes: mb_tx,
            udp_rx_bytes: mb_rx,
        })
    }
    
    #[cfg(target_os = "macos")]
    {
        // macOS: Use netstat command for accurate stats
        match get_macos_interface_stats("utun").await {
            Ok((tx, rx)) => {
                let mb_tx = tx as f64 / (1024.0 * 1024.0);
                let mb_rx = rx as f64 / (1024.0 * 1024.0);
                
                println!("[Nebula Stats] TX: {} bytes ({:.3} MB), RX: {} bytes ({:.3} MB)", 
                         tx, mb_tx, rx, mb_rx);
                
                Ok(NebulaStats {
                    udp_tx_bytes: mb_tx,
                    udp_rx_bytes: mb_rx,
                })
            }
            Err(e) => {
                // Fallback to sysinfo if netstat fails
                println!("[Nebula Stats] netstat failed ({}), falling back to sysinfo", e);
                get_stats_via_sysinfo()
            }
        }
    }
    
    #[cfg(target_os = "windows")]
    {
        // Windows: Use sysinfo (works better on Windows than Linux for TUN)
        get_stats_via_sysinfo()
    }
    
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        // Other platforms: fallback to sysinfo
        get_stats_via_sysinfo()
    }
}

/// Fallback stats reader using sysinfo crate
fn get_stats_via_sysinfo() -> Result<NebulaStats, String> {
    let networks = Networks::new_with_refreshed_list();
    
    let mut current_tx = 0;
    let mut current_rx = 0;
    
    // Look for nebula interface (nebula1, utun*, etc.)
    for (interface_name, data) in &networks {
        if interface_name.contains("nebula") || interface_name.contains("utun") {
            current_tx += data.transmitted();
            current_rx += data.received();
            println!("[Nebula Stats] Interface: {}, TX: {} bytes, RX: {} bytes", 
                     interface_name, data.transmitted(), data.received());
        }
    }
    
    let mb_tx = current_tx as f64 / (1024.0 * 1024.0);
    let mb_rx = current_rx as f64 / (1024.0 * 1024.0);
    
    println!("[Nebula Stats] Total TX: {:.3} MB, Total RX: {:.3} MB", mb_tx, mb_rx);
    
    Ok(NebulaStats {
        udp_tx_bytes: mb_tx,
        udp_rx_bytes: mb_rx,
    })
}

/// Read network statistics from /sys/class/net on Linux
#[cfg(target_os = "linux")]
async fn read_sys_net_stat(interface: &str, stat: &str) -> Result<u64, String> {
    let path = format!("/sys/class/net/{}/statistics/{}", interface, stat);
    
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => {
            content.trim().parse::<u64>()
                .map_err(|e| format!("Failed to parse {}: {}", stat, e))
        }
        Err(e) => {
            // Interface might not exist yet
            if e.kind() == std::io::ErrorKind::NotFound {
                Ok(0)
            } else {
                Err(format!("Failed to read {}: {}", path, e))
            }
        }
    }
}

/// Get interface stats on macOS using netstat
#[cfg(target_os = "macos")]
async fn get_macos_interface_stats(interface_prefix: &str) -> Result<(u64, u64), String> {
    // Run netstat -ibn to get interface statistics
    let output = tokio::process::Command::new("netstat")
        .args(&["-ibn"])
        .output()
        .await
        .map_err(|e| format!("Failed to run netstat: {}", e))?;
    
    if !output.status.success() {
        return Err("netstat command failed".to_string());
    }
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    
    // Parse netstat output to find utun interface (Nebula uses utun on macOS)
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        
        // netstat format: Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes
        if parts.len() >= 10 && parts[0].starts_with(interface_prefix) {
            // Check if this is the Nebula interface by looking for the 100.64.x.x IP
            if parts.len() > 3 && parts[3].starts_with("100.64") {
                let ibytes = parts[6].parse::<u64>()
                    .map_err(|e| format!("Failed to parse ibytes: {}", e))?;
                let obytes = parts[9].parse::<u64>()
                    .map_err(|e| format!("Failed to parse obytes: {}", e))?;
                
                println!("[Nebula Stats] Found interface: {}, IP: {}", parts[0], parts[3]);
                return Ok((obytes, ibytes)); // TX, RX
            }
        }
    }
    
    Err("Nebula interface not found in netstat output".to_string())
}

#[tauri::command]
pub async fn get_nebula_status() -> Result<NebulaStatus, String> {
    let is_running = check_nebula_running()
        .await
        .unwrap_or(false);
    
    let networks = Networks::new_with_refreshed_list();
    let has_interface = networks.iter()
        .any(|(name, _)| name.contains("nebula"));
    
    let message = if is_running && has_interface {
        "Connected".to_string()
    } else if is_running && !has_interface {
        "Starting...".to_string()
    } else {
        "Not running - Click to start".to_string()
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

#[tauri::command]
pub async fn get_nebula_binary_installed_status() -> Result<bool, String> {
    let pool = crate::DB_POOL.get().ok_or("Database not initialized".to_string())?;
    
    let is_installed: bool = sqlx::query("SELECT is_nebula_binary_installed FROM nebula_binary_status WHERE id = 1")
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .map(|row| row.get("is_nebula_binary_installed"))
        .unwrap_or(false);
    
    Ok(is_installed)
}

// TODO ! : use api call to get certificate and config and update config file path before saving