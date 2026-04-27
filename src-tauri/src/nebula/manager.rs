//! Nebula VPN management — download, install, configure, and lifecycle.
//!
//! Handles the full VPN lifecycle: downloading the Nebula binary from the
//! API, installing it with correct permissions, fetching certificates from
//! the CA, and starting/stopping the Nebula process. Permission escalation
//! (macOS osascript / Linux pkexec) only happens on explicit user toggle.

use crate::auth::tokens::get_api_token;
use anyhow::{Result, anyhow};
use chrono::{DateTime, Utc};
use reqwest::Client;
use reqwest::header::AUTHORIZATION;
use serde::{Deserialize, Serialize};
use serde_yaml;
use sqlx::Row;
use std::path::{Path, PathBuf};
use std::time::Duration;
use sysinfo::Networks;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tokio::fs;
use tracing::{debug, error, info, warn};

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};

#[cfg(target_os = "macos")]
mod macos_auth {
    use tracing::debug;

    /// Run a shell command with administrator privileges using
    /// osascript with a custom prompt. The dialog shows a
    /// standard macOS authentication window with our message.
    pub fn run_admin_shell(command: &str, prompt: &str) -> Result<(), String> {
        let escaped_cmd = command.replace('\\', "\\\\").replace('"', "\\\"");
        let escaped_prompt = prompt.replace('\\', "\\\\").replace('"', "\\\"");

        let script = format!(
            "do shell script \"{escaped_cmd}\" \
             with administrator privileges \
             with prompt \"{escaped_prompt}\""
        );

        debug!("Running admin command via osascript...");

        let output = std::process::Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| format!("Failed to run osascript: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let trimmed = stderr.trim();
            if trimmed.contains("User canceled") || trimmed.contains("user canceled") {
                return Err("User cancelled the authorization dialog".to_string());
            }
            return Err(format!(
                "Authorization failed: {}",
                if trimmed.is_empty() {
                    format!("exit code {:?}", output.status.code())
                } else {
                    trimmed.to_string()
                }
            ));
        }

        debug!("Admin command succeeded");
        Ok(())
    }
}

const NEBULA_GITHUB_API: &str = "https://api.github.com/repos/slackhq/nebula/releases/latest";
const NEBULA_VERSION_FILE: &str = "nebula_version.txt";
const HIPPIUS_API_BASE: &str = "https://api.hippius.com/api";

// Ping interval for keeping stats active (seconds)
const PING_INTERVAL_SECS: u64 = 10;

// State to share between setup commands
#[derive(Default)]
pub struct NebulaSetupState {
    pub latest_version: Option<String>,
    pub download_url: Option<String>,
    pub needs_update: bool,
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

#[derive(Debug, Deserialize, Clone)]
struct CertificateResponse {
    certificate_id: i64,
    ca: String,
    cert: String,
    key: String,
    #[expect(dead_code)]
    ip: String,
    config: String,
    is_active: Option<bool>,
    expires_at: Option<String>,
    created_at: Option<String>,
}

/// Get the Nebula binary directory in user's home
fn get_nebula_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("Could not find home directory"))?;
    Ok(home.join(".hippius").join("nebula"))
}

/// Get the Nebula config directory for a specific account
fn get_nebula_config_dir(account_id: &str) -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("Could not find home directory"))?;
    Ok(home.join(".hippius").join("nebula").join("config").join(account_id))
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

        _ => return Err(anyhow!("Unsupported OS/architecture: {os}/{arch}")),
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
async fn fetch_latest_release(client: &Client) -> Result<GitHubRelease> {
    let response = client
        .get(NEBULA_GITHUB_API)
        .header("User-Agent", "hippius-desktop")
        .timeout(Duration::from_secs(30))
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(anyhow!("Failed to fetch latest release: HTTP {}", response.status()));
    }

    let release: GitHubRelease = response.json().await?;
    Ok(release)
}

/// Extract ZIP archive
fn extract_zip(bytes: &[u8], target_dir: &Path) -> Result<()> {
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
            debug!("Extracted: {}", filename);
        }
    }

    Ok(())
}

/// Extract TAR.GZ archive
fn extract_tar_gz(bytes: &[u8], target_dir: &Path) -> Result<()> {
    use flate2::read::GzDecoder;
    use std::io::Cursor;
    use tar::Archive;

    let cursor = Cursor::new(bytes);
    let gz = GzDecoder::new(cursor);
    let mut archive = Archive::new(gz);

    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?;
        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| anyhow!("Invalid filename in archive"))?
            .to_string();

        // Extract nebula and nebula-cert binaries
        if filename == "nebula" || filename == "nebula-cert" {
            let outpath = target_dir.join(&filename);
            entry.unpack(&outpath)?;
            debug!("Extracted: {}", filename);
        }
    }

    Ok(())
}

// --- New Granular Commands ---

#[tauri::command]
pub async fn check_nebula_requirements(app: AppHandle) -> Result<(), String> {
    info!("Checking requirements...");

    // Check current installation
    let installed_version = check_nebula_installation().await.map_err(|e| e.to_string())?;

    // Fetch latest release
    let client = &app.state::<crate::app_state::AppState>().api_client;
    let latest_release = fetch_latest_release(client).await.map_err(|e| e.to_string())?;
    let latest_version = latest_release.tag_name.clone();

    debug!("Latest version: {}", latest_version);

    let mut needs_install = false;

    if installed_version.is_none() {
        info!("Not installed, will install");
        needs_install = true;
    } else if let Some(ref installed) = installed_version {
        let cert_binary_exists = get_nebula_cert_binary_path().map(|p| p.exists()).unwrap_or(false);

        if installed != &latest_version {
            info!("Update available: {} -> {}", installed, latest_version);
            needs_install = true;
        } else if !cert_binary_exists {
            info!("nebula-cert binary missing, will reinstall");
            needs_install = true;
        } else {
            debug!("Already up-to-date: {}", installed);
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
            .ok_or_else(|| format!("Asset not found: {asset_name}"))?;
        download_url = Some(asset.browser_download_url.clone());
    }

    // Update state
    {
        let app_state = app.state::<crate::app_state::AppState>();
        let mut setup = app_state.nebula.setup.lock().unwrap_or_else(|p| {
            tracing::warn!("Poisoned mutex recovered in nebula setup");
            p.into_inner()
        });
        setup.latest_version = Some(latest_version);
        setup.download_url = download_url;
        setup.needs_update = needs_install;
    }

    Ok(())
}

/// Derive the SHASUM256.txt URL from a Nebula asset download URL.
///
/// Input:  `https://github.com/slackhq/nebula/releases/download/v1.10.3/nebula-darwin.zip`
/// Output: `https://github.com/slackhq/nebula/releases/download/v1.10.3/SHASUM256.txt`
fn shasum_url_for_asset(asset_url: &str) -> Option<String> {
    let last_slash = asset_url.rfind('/')?;
    let base = &asset_url[..=last_slash];
    Some(format!("{base}SHASUM256.txt"))
}

/// Look up the expected SHA-256 digest for `asset_name` inside a
/// Nebula-style SHASUM256.txt file.
///
/// Accepts the standard shasum format: `<hex>  <filename>` (two spaces,
/// one per line). Any match on the filename wins; the hex is returned
/// lowercase.
fn parse_shasum_for_asset(shasum_contents: &str, asset_name: &str) -> Option<String> {
    for line in shasum_contents.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Split into (hex, filename). Most shasum tools emit two spaces;
        // some emit a single tab. Splitting on whitespace handles both.
        let mut parts = line.split_whitespace();
        let hex = parts.next()?;
        let name = parts.next()?;
        if name == asset_name {
            return Some(hex.to_ascii_lowercase());
        }
    }
    None
}

/// Compute the SHA-256 of a byte slice, returned as a lowercase hex string.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

#[tauri::command]
pub async fn download_nebula(app: AppHandle) -> Result<(), String> {
    let (needs_update, download_url, latest_version, client) = {
        let app_state = app.state::<crate::app_state::AppState>();
        let setup = app_state.nebula.setup.lock().unwrap_or_else(|p| {
            tracing::warn!("Poisoned mutex recovered in nebula setup");
            p.into_inner()
        });
        (
            setup.needs_update,
            setup.download_url.clone(),
            setup.latest_version.clone(),
            app_state.api_client.clone(),
        )
    };

    if needs_update && let (Some(url), Some(version)) = (download_url, latest_version) {
        info!("Downloading Nebula version {}", version);

        let nebula_dir = get_nebula_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&nebula_dir).await.map_err(|e| e.to_string())?;
        let temp_path = nebula_dir.join("temp_download.file");

        debug!("Downloading to temp file: {}", temp_path.display());

        let response = client
            .get(&url)
            .timeout(Duration::from_secs(300))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !response.status().is_success() {
            return Err(format!("Download failed: HTTP {}", response.status()));
        }

        let bytes = response.bytes().await.map_err(|e| e.to_string())?;

        // Integrity check: Nebula releases ship a `SHASUM256.txt` next to
        // every asset. We download it from the same release and verify the
        // bytes we just fetched before touching the filesystem. This is
        // the only defense against a compromised release asset or a TLS
        // MITM between us and the GitHub CDN — failure here MUST abort
        // the install, because the binary is later `chown root`/`chmod
        // u+s`-ed, and a mismatched binary would become setuid-root code
        // execution on the user's machine.
        let asset_name = get_asset_name().map_err(|e| e.to_string())?;
        let shasum_url = shasum_url_for_asset(&url)
            .ok_or_else(|| "Failed to derive SHASUM256.txt URL from asset URL".to_string())?;
        debug!("Fetching integrity manifest: {}", shasum_url);
        let shasum_resp = client
            .get(&shasum_url)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("Failed to fetch SHASUM256.txt: {e}"))?;
        if !shasum_resp.status().is_success() {
            return Err(format!(
                "Integrity check unavailable: SHASUM256.txt returned HTTP {}",
                shasum_resp.status()
            ));
        }
        let shasum_text = shasum_resp.text().await.map_err(|e| format!("Failed to read SHASUM256.txt body: {e}"))?;
        let expected = parse_shasum_for_asset(&shasum_text, &asset_name)
            .ok_or_else(|| format!("Integrity check failed: no entry for '{asset_name}' in SHASUM256.txt"))?;
        let actual = sha256_hex(&bytes);
        if actual != expected {
            // DO NOT write the tampered bytes to disk. Abort hard.
            error!("Nebula integrity check FAILED: expected {expected}, got {actual}");
            return Err(format!(
                "Nebula download integrity check failed — refusing to install. \
                 Expected SHA-256 {expected} from SHASUM256.txt, got {actual}."
            ));
        }
        info!("Nebula integrity check passed (SHA-256 match)");

        fs::write(&temp_path, bytes).await.map_err(|e| e.to_string())?;

        info!("Download complete");
    }

    Ok(())
}

#[cfg(test)]
mod integrity_tests {
    use super::*;

    #[test]
    fn sha256_hex_matches_known_vector() {
        // sha256("") — FIPS test vector
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn parse_shasum_two_spaces() {
        let text = "abc123  nebula-darwin.zip\ndef456  nebula-linux-amd64.tar.gz\n";
        assert_eq!(parse_shasum_for_asset(text, "nebula-darwin.zip"), Some("abc123".to_string()));
        assert_eq!(parse_shasum_for_asset(text, "nebula-linux-amd64.tar.gz"), Some("def456".to_string()));
    }

    #[test]
    fn parse_shasum_handles_tab_separator() {
        let text = "abcDEF\tnebula-darwin.zip\n";
        assert_eq!(parse_shasum_for_asset(text, "nebula-darwin.zip"), Some("abcdef".to_string()));
    }

    #[test]
    fn parse_shasum_missing_asset_returns_none() {
        let text = "abc  not-our-file.zip\n";
        assert_eq!(parse_shasum_for_asset(text, "nebula-darwin.zip"), None);
    }

    #[test]
    fn shasum_url_strips_asset_basename() {
        let url = "https://github.com/slackhq/nebula/releases/download/v1.10.3/nebula-darwin.zip";
        assert_eq!(
            shasum_url_for_asset(url).as_deref(),
            Some("https://github.com/slackhq/nebula/releases/download/v1.10.3/SHASUM256.txt")
        );
    }

    #[test]
    fn shasum_url_handles_trailing_slash_free_input() {
        // Defensive: a malformed URL without any '/' — None, not panic.
        assert_eq!(shasum_url_for_asset("no-slashes-here"), None);
    }
}

#[tauri::command]
pub async fn install_nebula(state: tauri::State<'_, crate::app_state::AppState>, _app: AppHandle) -> Result<(), String> {
    let pool = state.pool().map_err(|e| e.to_string())?;
    let (needs_update, latest_version) = {
        let setup = state.nebula.setup.lock().unwrap_or_else(|p| {
            tracing::warn!("Poisoned mutex recovered in nebula setup");
            p.into_inner()
        });
        (setup.needs_update, setup.latest_version.clone())
    };

    if needs_update {
        let nebula_dir = get_nebula_dir().map_err(|e| e.to_string())?;
        let temp_path = nebula_dir.join("temp_download.file");

        if temp_path.exists() {
            info!("Installing from temp file...");

            // Remove existing binaries before extraction.
            // Previous installs may have chown'd them to root (for setuid),
            // which prevents overwriting without elevated privileges.
            remove_existing_binaries(&nebula_dir).await;

            let bytes = fs::read(&temp_path).await.map_err(|e| e.to_string())?;

            // Determine archive type from asset name
            let asset_name = get_asset_name().map_err(|e| e.to_string())?;

            let asset_path = std::path::Path::new(&asset_name);
            if asset_path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("zip")) {
                let dir = nebula_dir.clone();
                tokio::task::spawn_blocking(move || extract_zip(&bytes, &dir))
                    .await
                    .map_err(|e| format!("Extract task panicked: {e}"))?
                    .map_err(|e| e.to_string())?;
            } else if asset_name.to_ascii_lowercase().ends_with(".tar.gz") {
                let dir = nebula_dir.clone();
                tokio::task::spawn_blocking(move || extract_tar_gz(&bytes, &dir))
                    .await
                    .map_err(|e| format!("Extract task panicked: {e}"))?
                    .map_err(|e| e.to_string())?;
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

            debug!("Binary installed with user permissions (0o755). Elevated permissions will be requested when VPN is enabled.");

            // Update database to mark binary as installed
            if let Err(e) =
                sqlx::query("UPDATE nebula_binary_status SET is_nebula_binary_installed = TRUE, last_updated = CURRENT_TIMESTAMP WHERE id = 1")
                    .execute(pool)
                    .await
            {
                error!("Failed to update binary installation status: {}", e);
            } else {
                debug!("Binary installation status updated in database");
            }
        } else {
            return Err("Installation failed: Downloaded file not found".to_string());
        }
    } else {
        // Binary is already installed, update database status
        if let Err(e) =
            sqlx::query("UPDATE nebula_binary_status SET is_nebula_binary_installed = TRUE, last_updated = CURRENT_TIMESTAMP WHERE id = 1")
                .execute(pool)
                .await
        {
            error!("Failed to update binary installation status: {}", e);
        } else {
            debug!("Binary already installed, status updated in database");
        }
    }

    Ok(())
}

/// Internal verify_nebula implementation that takes pool directly.
pub async fn verify_nebula_internal(client: &Client, pool: &sqlx::SqlitePool, account_id: &str) -> Result<(), String> {
    // Verify binaries
    let binary_path = get_nebula_binary_path().map_err(|e| e.to_string())?;
    if !binary_path.exists() {
        return Err("Verification failed: Nebula binary not found".to_string());
    }

    // Check VPN status in DB

    let is_enabled: bool = sqlx::query("SELECT is_enabled FROM vpn_status WHERE id = 1")
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .is_some_and(|row| row.get("is_enabled"));

    if !is_enabled {
        debug!("VPN is disabled in settings. Checking if we need to renew an existing certificate...");

        // Only renew if we already have a certificate locally.
        // We don't want to generate a new one if the user hasn't enabled VPN yet.
        let cert_exists = sqlx::query("SELECT 1 FROM nebula_certificate WHERE id = 1")
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .is_some();

        if cert_exists {
            info!("Found existing certificate, checking validity...");
            check_and_update_certificate(client, pool, account_id).await.map_err(|e| e.to_string())?;
        } else {
            debug!("No existing certificate found and VPN is disabled. Skipping certificate generation.");
        }

        return Ok(());
    }

    // Log permission status but don't escalate at startup.
    // Elevated permissions are requested when the user enables VPN.
    match check_permissions(&binary_path).await {
        Ok(has_perms) => {
            if has_perms {
                debug!("Binary has required permissions");
            } else {
                info!("Binary lacks elevated permissions. Will be requested when VPN is enabled.");
            }
        }
        Err(e) => {
            warn!("Failed to check permissions: {}", e);
        }
    }

    // Setup certificates from API
    info!("Checking certificate status...");
    check_and_update_certificate(client, pool, account_id).await.map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn verify_nebula(state: tauri::State<'_, crate::app_state::AppState>, _app: AppHandle) -> Result<(), String> {
    let account_id = state.current_account_id().map_err(|e| e.clone())?;
    verify_nebula_internal(&state.api_client, state.pool().map_err(|e| e.to_string())?, &account_id).await
}

/// Ensure the Nebula binary has elevated permissions required for VPN.
///
/// Called from `vpn::toggle_vpn_status` whenever the user enables the VPN.
/// Returns `Ok` if permissions are already present or were successfully
/// granted; returns `Err` if the user cancels the authorization dialog or
/// the binary is missing.
pub(crate) async fn ensure_vpn_permissions_internal() -> Result<(), String> {
    let binary_path = get_nebula_binary_path().map_err(|e| e.to_string())?;

    if !binary_path.exists() {
        return Err("Nebula binary not found. Please restart the app \
             to install it."
            .to_string());
    }

    let has_perms = check_permissions(&binary_path)
        .await
        .map_err(|e| format!("Failed to check permissions: {e}"))?;

    if has_perms {
        debug!("Binary already has elevated permissions");
        return Ok(());
    }

    info!("Requesting elevated permissions for VPN...");
    grant_permissions(&binary_path).await.map_err(|e| format!("{e}"))?;

    info!("VPN permissions granted successfully");
    Ok(())
}

async fn get_api_auth_header(pool: &sqlx::SqlitePool, account_id: &str) -> Result<String> {
    // The temp auth key (OAuth token) is used for Hippius API calls.
    // The master token is separate and used only for S3/Object Storage access.

    debug!("Getting API auth header for account: {}", account_id);

    let api_token = get_api_token(pool, account_id)
        .await
        .map_err(|e| {
            error!("Failed to get API token: {}", e);
            anyhow!(e)
        })?
        .ok_or_else(|| {
            error!("No API token found for account {}", account_id);
            anyhow!("No API token found for account {account_id}")
        })?;

    let auth_header = format!("Token {api_token}");
    debug!("Auth header set (length: {})", auth_header.len());
    Ok(auth_header)
}

async fn fetch_certificate_from_api(client: &Client, auth_header: &str) -> Result<Option<CertificateResponse>> {
    let url = format!("{HIPPIUS_API_BASE}/infrastructure/certificates/");
    let response = client.get(&url).header(AUTHORIZATION, auth_header).send().await?;
    if response.status() == 404 {
        return Ok(None);
    }

    if !response.status().is_success() {
        return Err(anyhow!("Failed to fetch certificate: {}", response.status()));
    }

    // The API might return a list or a single object?
    // User said "response is like: { ... }", implying a single object.
    // But endpoint is "..._list". Let's assume it returns a list and we take the first one,
    // OR it returns a single object.
    // Based on user example: { "certificate_id": 0 ... } it looks like a single object.
    // But if it's a list endpoint, maybe it returns [ { ... } ]?
    // I'll try to parse as single first, then list.

    let resp_status = response.status();
    let text = response.text().await?;
    debug!("Fetch certificate response: status={}, body_len={}", resp_status, text.len());

    if let Ok(cert) = serde_json::from_str::<CertificateResponse>(&text) {
        return Ok(Some(cert));
    }

    // Try list
    if let Ok(certs) = serde_json::from_str::<Vec<CertificateResponse>>(&text) {
        return Ok(certs.into_iter().next());
    }

    Err(anyhow!("Failed to parse certificate response: {text}"))
}

async fn request_certificate_from_api(client: &Client, auth_header: &str) -> Result<CertificateResponse> {
    let url = format!("{HIPPIUS_API_BASE}/infrastructure/certificates/request/");

    let response = client.post(&url).header(AUTHORIZATION, auth_header).send().await?;

    let status = response.status();
    debug!("Request certificate status: {}", status);

    if !status.is_success() {
        let error_body = response.text().await.unwrap_or_else(|_| "Could not read error body".to_string());
        let error_msg = format!("Failed to request certificate (status {status}): {error_body}");
        error!("{}", error_msg);
        return Err(anyhow!(error_msg));
    }

    let resp_status = status;
    let text = response.text().await?;
    debug!("Request certificate response: status={}, body_len={}", resp_status, text.len());

    let cert: CertificateResponse = serde_json::from_str(&text).map_err(|e| anyhow!("Failed to parse JSON: {e}"))?;
    info!("Certificate request successful");
    Ok(cert)
}

async fn renew_certificate_from_api(client: &Client, auth_header: &str) -> Result<CertificateResponse> {
    let url = format!("{HIPPIUS_API_BASE}/infrastructure/certificates/renew/");

    debug!("Renewing certificate from: {}", url);

    // Make POST request directly with auth header (same pattern as request_certificate_from_api)
    let response = client.post(&url).header(AUTHORIZATION, auth_header).send().await?;

    let status = response.status();
    debug!("Renew certificate status: {}", status);

    if !status.is_success() {
        let error_body = response.text().await.unwrap_or_else(|_| "Could not read error body".to_string());
        let error_msg = format!("Failed to renew certificate (status {status}): {error_body}");
        error!("{}", error_msg);
        return Err(anyhow!(error_msg));
    }

    let resp_status = status;
    let text = response.text().await?;
    debug!("Renew certificate response: status={}, body_len={}", resp_status, text.len());

    let cert: CertificateResponse = serde_json::from_str(&text).map_err(|e| anyhow!("Failed to parse JSON: {e}"))?;
    info!("Certificate renewal successful");
    Ok(cert)
}

async fn save_certificate_files(cert: &CertificateResponse, account_id: &str) -> Result<()> {
    let config_dir = get_nebula_config_dir(account_id)?;
    fs::create_dir_all(&config_dir).await?;

    // Save certificate files
    let ca_path = config_dir.join("ca.crt");
    let cert_path = config_dir.join("host.crt");
    let key_path = config_dir.join("host.key");

    fs::write(&ca_path, &cert.ca).await?;
    fs::write(&cert_path, &cert.cert).await?;
    fs::write(&key_path, &cert.key).await?;

    // Parse the config to update paths
    let mut config: serde_yaml::Value = serde_yaml::from_str(&cert.config).map_err(|e| anyhow!("Failed to parse config YAML: {e}"))?;

    // Update the pki paths in the config
    if let Some(pki) = config.get_mut("pki").and_then(|p| p.as_mapping_mut()) {
        pki.insert("ca".into(), ca_path.to_string_lossy().into_owned().into());
        pki.insert("cert".into(), cert_path.to_string_lossy().into_owned().into());
        pki.insert("key".into(), key_path.to_string_lossy().into_owned().into());
    }

    // Save the updated config
    let updated_config = serde_yaml::to_string(&config).map_err(|e| anyhow!("Failed to serialize updated config: {e}"))?;

    fs::write(config_dir.join("config.yml"), updated_config).await?;

    info!("Saved certificate files to {}", config_dir.display());
    Ok(())
}

async fn update_certificate_db(pool: &sqlx::SqlitePool, cert: &CertificateResponse) -> Result<()> {
    // We assume there's only one active certificate for the VPN
    sqlx::query(
        r"
        INSERT INTO nebula_certificate (id, certificate_id, expires_at, is_active, created_at, updated_at)
        VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            certificate_id = excluded.certificate_id,
            expires_at = excluded.expires_at,
            is_active = excluded.is_active,
            created_at = excluded.created_at,
            updated_at = CURRENT_TIMESTAMP
        ",
    )
    .bind(cert.certificate_id)
    .bind(&cert.expires_at)
    .bind(cert.is_active.unwrap_or(true))
    .bind(&cert.created_at)
    .execute(pool)
    .await?;

    Ok(())
}

#[expect(clippy::too_many_lines, reason = "certificate renewal flow with HTTP + DB + file I/O")]
pub async fn check_and_update_certificate(client: &Client, pool: &sqlx::SqlitePool, account_id: &str) -> Result<()> {
    let auth_header = get_api_auth_header(pool, account_id).await?;

    // Check DB for existing certificate
    let row = sqlx::query("SELECT expires_at FROM nebula_certificate WHERE id = 1")
        .fetch_optional(pool)
        .await?;

    let mut should_renew = false;
    let mut should_request = false;

    if let Some(row) = row {
        let expires_at_str: Option<String> = row.get("expires_at");
        if let Some(expires_at_str) = expires_at_str {
            if let Ok(expires_at) = DateTime::parse_from_rfc3339(&expires_at_str) {
                if Utc::now() > expires_at {
                    info!("Certificate expired at {}, renewing...", expires_at);
                    should_renew = true;
                } else {
                    debug!("Certificate valid until {}", expires_at);
                    // Check if files exist, if not, we might need to re-fetch or just warn
                    let config_dir = get_nebula_config_dir(account_id)?;
                    if !config_dir.join("host.crt").exists() {
                        info!("Certificate files missing but DB record exists. Re-fetching...");
                        // We can try to fetch the existing one
                        if let Some(cert) = fetch_certificate_from_api(client, &auth_header).await? {
                            save_certificate_files(&cert, account_id).await?;
                            update_certificate_db(pool, &cert).await?;
                        } else {
                            // If fetch fails (e.g. 404), maybe we need to request new?
                            warn!("Could not fetch existing certificate, requesting new one...");
                            should_request = true;
                        }
                    }
                }
            } else {
                warn!("Failed to parse expiration date, assuming expired/invalid");
                should_renew = true;
            }
        } else {
            debug!("Certificate record exists but no expiration date. Fetching from API...");
            if let Some(cert) = fetch_certificate_from_api(client, &auth_header).await? {
                save_certificate_files(&cert, account_id).await?;
                update_certificate_db(pool, &cert).await?;

                if let Some(expires_at_str) = &cert.expires_at
                    && let Ok(expires_at) = DateTime::parse_from_rfc3339(expires_at_str)
                    && Utc::now() > expires_at
                {
                    info!("Fetched certificate is expired, renewing...");
                    should_renew = true;
                }
            } else {
                warn!("Could not fetch certificate details from API. Renewing...");
                should_renew = true;
            }
        }
    } else {
        debug!("No certificate record in DB");
        // Check if we have one in API
        if let Some(cert) = fetch_certificate_from_api(client, &auth_header).await? {
            info!("Found existing certificate in API");
            save_certificate_files(&cert, account_id).await?;
            update_certificate_db(pool, &cert).await?;

            // recursive check to ensure it's not expired?
            // The fetch response should have expires_at.
            // If it's expired, we'll catch it on next run or we can check now.
            if let Some(expires_at_str) = &cert.expires_at
                && let Ok(expires_at) = DateTime::parse_from_rfc3339(expires_at_str)
                && Utc::now() > expires_at
            {
                info!("Fetched certificate is expired, renewing...");
                should_renew = true;
            }
        } else {
            info!("No certificate in API, requesting new one...");
            should_request = true;
        }
    }

    debug!("Status check complete. Renew: {}, Request: {}", should_renew, should_request);

    if should_renew {
        debug!("Calling renew_certificate_from_api...");

        // Try to renew first, but if it fails (e.g. 404 because cert is too old or gone),
        // fallback to requesting a new one.
        let cert_result = renew_certificate_from_api(client, &auth_header).await;

        let cert = match cert_result {
            Ok(c) => c,
            Err(e) => {
                warn!("Renewal failed: {}. Attempting to request a new certificate...", e);
                request_certificate_from_api(client, &auth_header).await?
            }
        };

        // Renew/Request response might not have expires_at, so we might need to fetch again
        let mut final_cert = cert;
        if final_cert.expires_at.is_none() {
            debug!("Renew/Request response missing expiration, fetching details...");
            if let Some(fetched) = fetch_certificate_from_api(client, &auth_header).await? {
                final_cert = fetched;
            }
        }

        save_certificate_files(&final_cert, account_id).await?;
        update_certificate_db(pool, &final_cert).await?;
        info!("Certificate renewed/requested successfully");
    } else if should_request {
        debug!("Calling request_certificate_from_api...");
        let cert = request_certificate_from_api(client, &auth_header).await?;

        let mut final_cert = cert;
        if final_cert.expires_at.is_none() {
            debug!("Request response missing expiration, fetching details...");
            if let Some(fetched) = fetch_certificate_from_api(client, &auth_header).await? {
                final_cert = fetched;
            }
        }

        save_certificate_files(&final_cert, account_id).await?;
        update_certificate_db(pool, &final_cert).await?;
        info!("Certificate requested successfully");
    }

    Ok(())
}

#[tauri::command]
pub async fn finish_setup(state: tauri::State<'_, crate::app_state::AppState>) -> Result<(), String> {
    let account_id = state.current_account_id().map_err(|e| e.clone())?;
    // Try to start Nebula if enabled
    if let Err(e) = start_nebula_internal(&state.nebula, state.pool().map_err(|e| e.to_string())?, &account_id).await {
        warn!("Failed to auto-start in finish_setup: {}", e);
        // We don't return error here to not block the UI flow, just log it
    }

    Ok(())
}

/// Run the full Nebula setup pipeline (check → download → install → verify
/// → finish) in a background tokio task.  Returns immediately so the splash
/// screen is never blocked by the download.
#[tauri::command]
pub async fn setup_nebula_background(app: AppHandle) -> Result<(), String> {
    let app_clone = app.clone();
    tokio::spawn(async move {
        info!("Background Nebula setup started");

        // 1. Check requirements
        if let Err(e) = run_check_nebula_requirements(&app_clone).await {
            warn!("Background Nebula check failed: {e}");
            return;
        }

        // 2. Download
        if let Err(e) = run_download_nebula(&app_clone).await {
            warn!("Background Nebula download failed: {e}");
            return;
        }

        // 3. Install
        let state = app_clone.state::<crate::app_state::AppState>();
        if let Err(e) = run_install_nebula(&state, &app_clone).await {
            warn!("Background Nebula install failed: {e}");
            return;
        }

        // 4. Verify
        if let Err(e) = run_verify_nebula(&state).await {
            warn!("Background Nebula verify failed: {e}");
            return;
        }

        // 5. Finish (auto-start if VPN enabled)
        if let Err(e) = run_finish_setup(&state).await {
            warn!("Background Nebula finish_setup failed: {e}");
            return;
        }

        info!("Background Nebula setup completed");
        let _ = app_clone.emit("nebula_setup_complete", ());
    });

    Ok(())
}

// --- Internal helpers for background setup (avoid tauri::State) ---

/// Preference key for the last GitHub release-info check. Stored as an
/// epoch-ms string so the value parses cleanly with `i64::from_str`.
const NEBULA_LAST_RELEASE_CHECK_KEY: &str = "nebula_last_release_check_ms";
/// Skip the unauthenticated GitHub API call if the last successful check
/// was less than this many milliseconds ago. 24 hours is comfortably
/// inside GitHub's 60 req/hour anonymous rate limit while still giving
/// users a same-day path to a new Nebula release.
const NEBULA_RELEASE_CHECK_TTL_MS: i64 = 24 * 60 * 60 * 1000;

async fn run_check_nebula_requirements(app: &AppHandle) -> Result<(), String> {
    let installed_version = check_nebula_installation().await.map_err(|e| e.to_string())?;

    // Skip the GitHub release probe entirely when (a) we already have a
    // working install and (b) we successfully checked GitHub within the
    // TTL window. This drops a per-launch unauthenticated `api.github.com`
    // call to once-per-day per user.
    let cert_binary_exists = get_nebula_cert_binary_path().map(|p| p.exists()).unwrap_or(false);
    if installed_version.is_some() && cert_binary_exists {
        let app_state = app.state::<crate::app_state::AppState>();
        if let Ok(pool) = app_state.pool()
            && let Ok(Some(last_str)) = crate::utils::preferences::get_user_preference_internal(pool, NEBULA_LAST_RELEASE_CHECK_KEY).await
            && let Ok(last_ms) = last_str.parse::<i64>()
        {
            let now_ms = chrono::Utc::now().timestamp_millis();
            if now_ms.saturating_sub(last_ms) < NEBULA_RELEASE_CHECK_TTL_MS {
                debug!(
                    age_hours = (now_ms - last_ms) / (60 * 60 * 1000),
                    "Skipping Nebula release check (cached result is fresh)"
                );
                return Ok(());
            }
        }
    }

    let client = &app.state::<crate::app_state::AppState>().api_client;
    let latest_release = fetch_latest_release(client).await.map_err(|e| e.to_string())?;
    let latest_version = latest_release.tag_name.clone();

    // Record the successful check timestamp so subsequent launches can
    // short-circuit until the TTL elapses.
    let app_state = app.state::<crate::app_state::AppState>();
    if let Ok(pool) = app_state.pool() {
        let now_ms = chrono::Utc::now().timestamp_millis().to_string();
        if let Err(e) = crate::utils::preferences::save_user_preference_internal(pool, NEBULA_LAST_RELEASE_CHECK_KEY, &now_ms).await {
            warn!(error = %e, "Failed to persist nebula_last_release_check_ms; next launch will re-fetch");
        }
    }

    let mut needs_install = false;
    if installed_version.is_none() {
        info!("Not installed, will install");
        needs_install = true;
    } else if let Some(ref installed) = installed_version {
        let cert_binary_exists = get_nebula_cert_binary_path().map(|p| p.exists()).unwrap_or(false);
        if installed != &latest_version {
            info!("Update available: {} -> {}", installed, latest_version);
            needs_install = true;
        } else if !cert_binary_exists {
            info!("nebula-cert binary missing, will reinstall");
            needs_install = true;
        }
    }

    let mut download_url = None;
    if needs_install {
        let asset_name = get_asset_name().map_err(|e| e.to_string())?;
        let asset = latest_release
            .assets
            .iter()
            .find(|a| a.name == asset_name)
            .ok_or_else(|| format!("Asset not found: {asset_name}"))?;
        download_url = Some(asset.browser_download_url.clone());
    }

    let app_state = app.state::<crate::app_state::AppState>();
    let mut setup = app_state.nebula.setup.lock().unwrap_or_else(|p| {
        warn!("Poisoned mutex recovered in nebula setup");
        p.into_inner()
    });
    setup.latest_version = Some(latest_version);
    setup.download_url = download_url;
    setup.needs_update = needs_install;

    Ok(())
}

async fn run_download_nebula(app: &AppHandle) -> Result<(), String> {
    let (needs_update, download_url, latest_version, client) = {
        let app_state = app.state::<crate::app_state::AppState>();
        let setup = app_state.nebula.setup.lock().unwrap_or_else(|p| {
            warn!("Poisoned mutex recovered in nebula setup");
            p.into_inner()
        });
        (
            setup.needs_update,
            setup.download_url.clone(),
            setup.latest_version.clone(),
            app_state.api_client.clone(),
        )
    };

    if needs_update && let (Some(url), Some(version)) = (download_url, latest_version) {
        info!("Downloading Nebula version {}", version);
        let nebula_dir = get_nebula_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&nebula_dir).await.map_err(|e| e.to_string())?;
        let temp_path = nebula_dir.join("temp_download.file");

        let response = client
            .get(&url)
            .timeout(Duration::from_secs(300))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !response.status().is_success() {
            return Err(format!("Download failed: HTTP {}", response.status()));
        }

        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        fs::write(&temp_path, bytes).await.map_err(|e| e.to_string())?;
        info!("Download complete");
    }

    Ok(())
}

async fn run_install_nebula(state: &crate::app_state::AppState, _app: &AppHandle) -> Result<(), String> {
    let pool = state.pool().map_err(|e| e.to_string())?;
    let (needs_update, latest_version) = {
        let setup = state.nebula.setup.lock().unwrap_or_else(|p| {
            warn!("Poisoned mutex recovered in nebula setup");
            p.into_inner()
        });
        (setup.needs_update, setup.latest_version.clone())
    };

    if needs_update {
        let nebula_dir = get_nebula_dir().map_err(|e| e.to_string())?;
        let temp_path = nebula_dir.join("temp_download.file");

        if temp_path.exists() {
            info!("Installing from temp file...");
            remove_existing_binaries(&nebula_dir).await;

            let bytes = fs::read(&temp_path).await.map_err(|e| e.to_string())?;
            let asset_name = get_asset_name().map_err(|e| e.to_string())?;

            let asset_path = std::path::Path::new(&asset_name);
            if asset_path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("zip")) {
                let dir = nebula_dir.clone();
                tokio::task::spawn_blocking(move || extract_zip(&bytes, &dir))
                    .await
                    .map_err(|e| format!("Extract task panicked: {e}"))?
                    .map_err(|e| e.to_string())?;
            } else if asset_name.to_ascii_lowercase().ends_with(".tar.gz") {
                let dir = nebula_dir.clone();
                tokio::task::spawn_blocking(move || extract_tar_gz(&bytes, &dir))
                    .await
                    .map_err(|e| format!("Extract task panicked: {e}"))?
                    .map_err(|e| e.to_string())?;
            }

            let _ = fs::remove_file(temp_path).await;

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

            if let Err(e) = sqlx::query(
                "UPDATE nebula_binary_status \
                 SET is_nebula_binary_installed = TRUE, \
                     last_updated = CURRENT_TIMESTAMP \
                 WHERE id = 1",
            )
            .execute(pool)
            .await
            {
                error!("Failed to update binary installation status: {e}");
            }
        } else {
            return Err("Installation failed: Downloaded file not found".to_string());
        }
    } else if let Err(e) = sqlx::query(
        "UPDATE nebula_binary_status \
         SET is_nebula_binary_installed = TRUE, \
             last_updated = CURRENT_TIMESTAMP \
         WHERE id = 1",
    )
    .execute(pool)
    .await
    {
        error!("Failed to update binary installation status: {e}");
    }

    Ok(())
}

async fn run_verify_nebula(state: &crate::app_state::AppState) -> Result<(), String> {
    let pool = state.pool().map_err(|e| e.to_string())?;
    let account_id = state.current_account_id().map_err(|e| e.clone())?;
    verify_nebula_internal(&state.api_client, pool, &account_id).await
}

async fn run_finish_setup(state: &crate::app_state::AppState) -> Result<(), String> {
    let account_id = state.current_account_id().map_err(|e| e.clone())?;
    let pool = state.pool().map_err(|e| e.to_string())?;
    if let Err(e) = start_nebula_internal(&state.nebula, pool, &account_id).await {
        warn!("Failed to auto-start in finish_setup: {e}");
    }
    Ok(())
}

pub async fn start_nebula_internal(
    nebula_state: &crate::nebula::state::NebulaState,
    pool: &sqlx::SqlitePool,
    account_id: &str,
) -> Result<(), String> {
    info!("Attempting to start Nebula...");

    // Check DB status
    let is_enabled: bool = sqlx::query("SELECT is_enabled FROM vpn_status WHERE id = 1")
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .is_some_and(|row| row.get("is_enabled"));

    if !is_enabled {
        debug!("VPN is disabled in settings, skipping startup");
        return Ok(());
    }

    if check_nebula_running().await.unwrap_or(false) {
        debug!("Already running");
        // Start ping task even if already running (in case it was stopped)
        start_ping_task(nebula_state, account_id.to_string());
        return Ok(());
    }

    let binary_path = get_nebula_binary_path().map_err(|e| e.to_string())?;

    let config_dir = get_nebula_config_dir(account_id).map_err(|e| e.to_string())?;

    // Use config.yml (from API) instead of hostname-based config
    let config_file = config_dir.join("config.yml");

    if !config_file.exists() {
        return Err(format!("Config file not found: {}. Run verify_nebula first.", config_file.display()));
    }

    debug!("Starting process: {} -config {}", binary_path.display(), config_file.display());

    // Spawn the process using setsid to detach it from our process tree
    // This prevents zombie processes when we kill it
    #[cfg(target_os = "linux")]
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

        info!("Started with PID: {}", child.id());
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Stdio;

        // On macOS, start directly. setsid is not standard.
        // Use tokio::process::Command and persist the Child in NebulaState so
        // stop_nebula can kill+wait the process directly instead of polling
        // `ps` 50× over 5 seconds.
        let child = tokio::process::Command::new(&binary_path)
            .arg("-config")
            .arg(&config_file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(false)
            .spawn()
            .map_err(|e| format!("Failed to spawn nebula: {e}"))?;

        info!("Started with PID: {:?}", child.id());
        *nebula_state.child.lock().await = Some(child);
    }

    #[cfg(target_os = "windows")]
    {
        let child = std::process::Command::new(&binary_path)
            .arg("-config")
            .arg(&config_file)
            .spawn()
            .map_err(|e| format!("Failed to spawn nebula: {}", e))?;

        info!("Started with PID: {}", child.id());
    }

    // Start the background ping task to keep stats active
    start_ping_task(nebula_state, account_id.to_string());

    Ok(())
}

// --- End New Commands ---

/// Remove existing nebula binaries before re-extraction.
/// Previous installs may have chown'd them to root (setuid for TUN/TAP),
/// so a normal fs::remove_file will fail with "Permission denied".
/// On macOS we use the Security framework for native authorization; on Linux, pkexec rm.
async fn remove_existing_binaries(nebula_dir: &Path) {
    let binary_names: &[&str] = if cfg!(target_os = "windows") {
        &["nebula.exe", "nebula-cert.exe"]
    } else {
        &["nebula", "nebula-cert"]
    };

    for name in binary_names {
        let path = nebula_dir.join(name);
        if !path.exists() {
            continue;
        }

        // Try normal removal first (works if user-owned)
        if fs::remove_file(&path).await.is_ok() {
            debug!("Removed existing binary: {}", name);
            continue;
        }

        // Normal removal failed (likely root-owned), try elevated removal
        debug!("Binary {} is not user-writable, requesting elevated removal...", name);
        let path_str = path.to_string_lossy().to_string();

        #[cfg(target_os = "macos")]
        {
            let cmd = format!("/bin/rm -f '{}'", path_str.replace('\'', "'\\''"),);
            match macos_auth::run_admin_shell(
                &cmd,
                "Hippius needs to remove a previous VPN \
                 installation to complete the update.",
            ) {
                Ok(()) => {
                    debug!("Removed root-owned binary via elevated privileges: {}", name);
                }
                Err(e) => {
                    warn!("Could not authorize removal of {}: {}", name, e);
                }
            }
        }

        #[cfg(target_os = "linux")]
        {
            match std::process::Command::new("pkexec").arg("rm").arg("-f").arg(&path_str).status() {
                Ok(status) if status.success() => {
                    debug!("Removed root-owned binary via pkexec: {}", name);
                }
                Ok(_) => {
                    warn!("Failed to remove {} with pkexec", name);
                }
                Err(e) => {
                    warn!("Could not run pkexec to remove {}: {}", name, e);
                }
            }
        }
    }
}

pub async fn check_permissions(binary_path: &Path) -> Result<bool> {
    #[cfg(target_os = "linux")]
    {
        // Check for cap_net_admin using getcap
        let output = tokio::process::Command::new("getcap").arg(binary_path).output().await;

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
pub async fn grant_permissions(binary_path: &Path) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        debug!("Requesting cap_net_admin via pkexec...");
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
        debug!("Requesting setuid via native authorization...");
        let path_str = binary_path.to_str().ok_or_else(|| anyhow!("Invalid path"))?;

        let cmd = format!(
            "/usr/sbin/chown root '{}' && /bin/chmod u+s '{}'",
            path_str.replace('\'', "'\\''"),
            path_str.replace('\'', "'\\''"),
        );

        macos_auth::run_admin_shell(
            &cmd,
            "Hippius needs administrator access to configure \
             its VPN networking tools. This is required to \
             create secure network connections.",
        )
        .map_err(|e| anyhow!("{e}"))?;
    }

    Ok(())
}

/// Check if Nebula is running
pub async fn check_nebula_running() -> Result<bool> {
    #[cfg(unix)]
    {
        // Use ps to check if nebula is running and NOT a zombie
        // This is more reliable than pgrep for detecting actual running processes
        let output = tokio::process::Command::new("ps").args(["-C", "nebula", "-o", "stat="]).output().await?;

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
pub async fn stop_nebula(nebula_state: &crate::nebula::state::NebulaState) -> Result<(), String> {
    info!("Stopping Nebula process...");

    // Stop the background ping task first
    stop_ping_task(nebula_state);

    // Fast path: if we own the Child handle (macOS: nebula spawned directly
    // by us), kill+wait it directly. This skips the 50× `ps` polling that
    // the fallback path needs because the kernel signals us when our own
    // child exits.
    //
    // We extract the Child from under the lock in a small scoped block so
    // the MutexGuard is dropped before the kill+wait awaits — otherwise the
    // lock would be held for several seconds across the wait and serialize
    // every concurrent stop call.
    let owned_child = {
        let mut guard = nebula_state.child.lock().await;
        guard.take()
    };
    if let Some(mut child) = owned_child {
        debug!("Stopping nebula via owned Child handle");
        if let Err(e) = child.kill().await {
            warn!("Failed to send kill to nebula child: {e}");
        }
        match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
            Ok(Ok(status)) => {
                info!("Nebula child exited (status: {status})");
                return Ok(());
            }
            Ok(Err(e)) => {
                warn!("Nebula child wait failed: {e}");
                // Fall through to the pkill path in case the process is somehow
                // still around or the child handle was stale.
            }
            Err(_) => {
                warn!("Nebula child wait timed out after 5s; falling back to pkill");
                // Fall through.
            }
        }
    }

    #[cfg(unix)]
    {
        // Fallback: pkill + poll. Used when we don't own the Child (Linux
        // setsid path) or when the kill+wait above failed/timed out.
        let output = tokio::process::Command::new("pkill")
            .arg("-x")
            .arg("nebula")
            .output()
            .await
            .map_err(|e| format!("Failed to execute pkill: {e}"))?;

        if output.status.success() {
            debug!("Termination signal sent, waiting for process to stop...");

            // Wait for the process to actually stop (up to 5 seconds)
            // Check every 100ms for faster response
            for i in 0..50 {
                tokio::time::sleep(Duration::from_millis(100)).await;

                if !check_nebula_running().await.unwrap_or(false) {
                    info!("Process stopped successfully after {} ms", (i + 1) * 100);
                    return Ok(());
                }

                if i == 49 {
                    warn!("Process may still be running after 5 seconds");
                }
            }
        } else {
            debug!("No process found or already stopped");
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
            debug!("Termination signal sent, waiting for process to stop...");

            // Wait for the process to actually stop (up to 5 seconds)
            for i in 0..50 {
                tokio::time::sleep(Duration::from_millis(100)).await;

                // On Windows, we'd need a proper check here
                // For now, just wait a bit
                if i == 49 {
                    info!("Process stopped successfully");
                }
            }
        } else {
            debug!("No process found or already stopped");
        }
    }

    Ok(())
}

/// Read lighthouse IPs from the Nebula config file
async fn read_lighthouse_ips_from_config(account_id: &str) -> Vec<String> {
    let config_dir = match get_nebula_config_dir(account_id) {
        Ok(dir) => dir,
        Err(e) => {
            error!("Failed to get config dir: {}", e);
            return Vec::new();
        }
    };

    let config_file = config_dir.join("config.yml");

    if !config_file.exists() {
        warn!("Config file not found: {}", config_file.display());
        return Vec::new();
    }

    let content = match tokio::fs::read_to_string(&config_file).await {
        Ok(c) => c,
        Err(e) => {
            error!("Failed to read config file: {}", e);
            return Vec::new();
        }
    };

    let config: NebulaConfig = match serde_yaml::from_str(&content) {
        Ok(c) => c,
        Err(e) => {
            error!("Failed to parse config file: {}", e);
            return Vec::new();
        }
    };

    config.lighthouse.and_then(|l| l.hosts).unwrap_or_default()
}

/// Start the background ping task to keep VPN stats active.
///
/// Takes an owned `account_id: String` because the spawned task outlives
/// the caller's borrow. No pool needed — `read_lighthouse_ips_from_config`
/// reads from the filesystem only.
fn start_ping_task(nebula_state: &crate::nebula::state::NebulaState, account_id: String) {
    // Stop any existing ping task first
    stop_ping_task(nebula_state);

    let handle = tokio::spawn(async move {
        debug!("Starting background ping task (interval: {}s)", PING_INTERVAL_SECS);

        // Wait a bit for Nebula to fully initialize
        tokio::time::sleep(Duration::from_secs(3)).await;

        // Read lighthouse IPs from config
        let lighthouse_ips = read_lighthouse_ips_from_config(&account_id).await;

        if lighthouse_ips.is_empty() {
            warn!("No lighthouse IPs found in config, ping task will not run");
            return;
        }

        debug!("Loaded {} lighthouse IPs from config: {:?}", lighthouse_ips.len(), lighthouse_ips);

        let mut lighthouse_index = 0;

        loop {
            // Rotate through lighthouse IPs
            let target_ip = &lighthouse_ips[lighthouse_index];
            lighthouse_index = (lighthouse_index + 1) % lighthouse_ips.len();

            // Perform ping
            #[cfg(unix)]
            {
                let _ = tokio::process::Command::new("ping")
                    .args(["-c", "1", "-W", "2", target_ip])
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
    if let Ok(mut guard) = nebula_state.ping_handle.lock() {
        *guard = Some(handle);
        debug!("Background ping task started");
    }
}

/// Stop the background ping task
fn stop_ping_task(nebula_state: &crate::nebula::state::NebulaState) {
    if let Ok(mut guard) = nebula_state.ping_handle.lock()
        && let Some(handle) = guard.take()
    {
        handle.abort();
        debug!("Background ping task stopped");
    }
}

pub async fn get_nebula_ip_internal(account_id: &str) -> Result<String> {
    let config_dir = get_nebula_config_dir(account_id)?;
    // Use host.crt from API instead of hostname-based cert
    let crt_path = config_dir.join("host.crt");

    if !crt_path.exists() {
        return Err(anyhow!("Nebula certificate not found"));
    }

    let nebula_cert_binary = get_nebula_cert_binary_path()?;

    let output = tokio::process::Command::new(&nebula_cert_binary)
        .args([
            "print",
            "-json",
            "-path",
            crt_path.to_str().ok_or_else(|| anyhow!("Certificate path contains invalid UTF-8"))?,
        ])
        .output()
        .await?;

    if !output.status.success() {
        return Err(anyhow!("Failed to read certificate: {}", String::from_utf8_lossy(&output.stderr)));
    }

    // The output is an array of certificates
    let certs: Vec<NebulaCert> = serde_json::from_slice(&output.stdout).map_err(|e| anyhow!("Failed to parse certificate JSON: {e}"))?;

    let cert = certs.first().ok_or_else(|| anyhow!("No certificate found in output"))?;

    // Try networks first (newer format), then fall back to ips (older format)
    let ip_cidr = cert
        .details
        .networks
        .first()
        .or_else(|| cert.details.ips.first())
        .ok_or_else(|| anyhow!("No IP found in certificate"))?;

    // Extract IP from CIDR notation (e.g., "100.64.0.31/10" -> "100.64.0.31")
    let ip = ip_cidr.split('/').next().ok_or_else(|| anyhow!("Invalid IP format in certificate"))?;

    Ok(ip.to_string())
}

#[tauri::command]
pub async fn get_nebula_ip(state: tauri::State<'_, crate::app_state::AppState>) -> Result<String, String> {
    let account_id = state.current_account_id().map_err(|e| e.clone())?;
    get_nebula_ip_internal(&account_id).await.map_err(|e| e.to_string())
}

/// Tries to find the Nebula network interface by checking common names and IP ranges
async fn find_nebula_interface(search_ip: Option<&str>) -> Option<String> {
    let target_ip = search_ip.unwrap_or("100.64.");
    debug!("Searching for interface with IP: {}", target_ip);

    // First try to find by common interface names
    #[cfg(target_os = "linux")]
    {
        let common_names = ["tun0", "tun1", "tun2", "utun0", "utun1"];

        // Check each common name
        for iface in &common_names {
            if let Ok(_) = read_sys_net_stat(iface, "tx_bytes").await {
                debug!("Found interface by name: {}", iface);
                return Some(iface.to_string());
            }
        }
    }

    // If not found by name, try to find by IP range (Nebula uses 100.64.0.0/10 by default).
    // All shell-out probes below use `tokio::process::Command` with a short
    // timeout so a hung `ifconfig`/`netstat`/`ip` doesn't block the tokio
    // worker thread for the whole IPC handler.
    #[cfg(target_os = "linux")]
    {
        if let Some(output) = run_iface_probe("ip", &["-o", "-4", "addr", "show"]).await {
            for line in output.lines() {
                if line.contains(target_ip) {
                    // Extract interface name (it's the second field in the output)
                    if let Some(iface) = line.split_whitespace().nth(1) {
                        let iface = iface.trim_end_matches(':');
                        debug!("Found interface by IP range: {}", iface);
                        return Some(iface.to_string());
                    }
                }
            }
        }
    }

    // On macOS, try to find the interface with the Nebula IP
    #[cfg(target_os = "macos")]
    {
        // Method 1: ifconfig
        debug!("Trying ifconfig...");
        if let Some(output) = run_iface_probe("ifconfig", &["-a"]).await {
            let mut current_iface = None;

            for line in output.lines() {
                // Check for interface line (starts with non-whitespace)
                if !line.starts_with('\t') && !line.starts_with(' ') && line.contains(':') {
                    current_iface = Some(line.split(':').next().unwrap_or("").trim());
                }
                // Check for Nebula IP in the interface details
                else if let Some(iface) = current_iface
                    && line.contains(target_ip)
                {
                    debug!("Found interface by ifconfig: {}", iface);
                    return Some(iface.to_string());
                }
            }
        }

        // Method 2: netstat -rn (Routing table)
        // This is often more reliable for finding which interface hosts an IP
        debug!("Trying netstat -rn...");
        if let Some(output) = run_iface_probe("netstat", &["-rn", "-f", "inet"]).await {
            // Look for lines containing the IP
            // Example: 100.64.0.1/32      link#15            UCS             utun4
            // Or:      100.64.0.1         100.64.0.1         UH              utun4
            for line in output.lines() {
                if line.contains(target_ip) {
                    // The interface is usually the last column or one of the last
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if let Some(last) = parts.last()
                        && (last.starts_with("utun") || last.starts_with("tun"))
                    {
                        debug!("Found interface by netstat: {}", last);
                        return Some(last.to_string());
                    }
                    // Sometimes it's the second to last if there are flags
                    if parts.len() > 1 {
                        let second_last = parts[parts.len() - 2];
                        if second_last.starts_with("utun") || second_last.starts_with("tun") {
                            debug!("Found interface by netstat (2nd last): {}", second_last);
                            return Some(second_last.to_string());
                        }
                    }
                }
            }
        }
    }

    None
}

/// Run a network-interface probe (`ip` / `ifconfig` / `netstat`) with a 2 s
/// timeout, returning its stdout as a UTF-8 string on success.
///
/// Async + timeout keeps these calls from stalling the tokio worker thread
/// on a hung syscall, which `get_nebula_stats` was paying every UI tick.
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn run_iface_probe(program: &str, args: &[&str]) -> Option<String> {
    let fut = tokio::process::Command::new(program).args(args).output();
    match tokio::time::timeout(Duration::from_secs(2), fut).await {
        Ok(Ok(output)) => Some(String::from_utf8_lossy(&output.stdout).into_owned()),
        Ok(Err(e)) => {
            debug!("{program} probe failed: {e}");
            None
        }
        Err(_) => {
            warn!("{program} probe timed out after 2s");
            None
        }
    }
}

#[tauri::command]
pub async fn get_nebula_stats(state: tauri::State<'_, crate::app_state::AppState>) -> Result<NebulaStats, String> {
    // Try to get the Nebula IP from the certificate to help find the interface
    let account_id = state.current_account_id().ok();
    let nebula_ip = if let Some(ref id) = account_id {
        get_nebula_ip_internal(id).await.ok()
    } else {
        None
    };
    let search_ip = nebula_ip.as_deref();

    if let Some(ip) = search_ip {
        debug!("Retrieved Nebula IP: {}", ip);
    } else {
        debug!("Failed to retrieve Nebula IP from certificate, using default search");
    }

    // Try to find the Nebula interface dynamically
    if let Some(iface) = find_nebula_interface(search_ip).await {
        debug!("Using interface: {}", iface);

        // Try to read stats from the detected interface
        #[cfg(target_os = "linux")]
        {
            if let (Ok(tx_bytes), Ok(rx_bytes)) = tokio::join!(read_sys_net_stat(&iface, "tx_bytes"), read_sys_net_stat(&iface, "rx_bytes")) {
                let mb_tx = tx_bytes as f64 / (1024.0 * 1024.0);
                let mb_rx = rx_bytes as f64 / (1024.0 * 1024.0);

                let stats = NebulaStats {
                    udp_tx_bytes: mb_tx,
                    udp_rx_bytes: mb_rx,
                };

                debug!("{} - TX: {:.3} MB, RX: {:.3} MB", iface, stats.udp_tx_bytes, stats.udp_rx_bytes);

                return Ok(stats);
            }
        }

        #[cfg(target_os = "macos")]
        {
            if let Ok((tx_bytes, rx_bytes)) = get_macos_interface_stats(&iface, search_ip).await {
                let mb_tx = tx_bytes as f64 / (1024.0 * 1024.0);
                let mb_rx = rx_bytes as f64 / (1024.0 * 1024.0);

                let stats = NebulaStats {
                    udp_tx_bytes: mb_tx,
                    udp_rx_bytes: mb_rx,
                };

                debug!("{} - TX: {:.3} MB, RX: {:.3} MB", iface, stats.udp_tx_bytes, stats.udp_rx_bytes);

                return Ok(stats);
            }
        }
    }

    // Fall back to sysinfo if we couldn't determine the interface or read stats
    debug!("Could not determine Nebula interface, falling back to sysinfo");
    get_stats_via_sysinfo()
}

/// Fallback stats reader using sysinfo crate
fn get_stats_via_sysinfo() -> Result<NebulaStats, String> {
    let networks = Networks::new_with_refreshed_list();

    let mut current_tx = 0;
    let mut current_rx = 0;

    for (interface_name, data) in &networks {
        if interface_name.contains("nebula") || interface_name.contains("utun") {
            current_tx += data.transmitted();
            current_rx += data.received();
            debug!(
                "Interface: {}, TX: {} bytes, RX: {} bytes",
                interface_name,
                data.transmitted(),
                data.received()
            );
        }
    }

    let mb_tx = current_tx as f64 / (1024.0 * 1024.0);
    let mb_rx = current_rx as f64 / (1024.0 * 1024.0);

    debug!("Total TX: {:.3} MB, Total RX: {:.3} MB", mb_tx, mb_rx);

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
        Ok(content) => content.trim().parse::<u64>().map_err(|e| format!("Failed to parse {}: {}", stat, e)),
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
async fn get_macos_interface_stats(interface_prefix: &str, search_ip: Option<&str>) -> Result<(u64, u64), String> {
    // Run netstat -ibn to get interface statistics
    let output = tokio::process::Command::new("netstat")
        .args(["-ibn"])
        .output()
        .await
        .map_err(|e| format!("Failed to run netstat: {e}"))?;

    if !output.status.success() {
        return Err("netstat command failed".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Parse netstat output to find utun interface (Nebula uses utun on macOS)
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();

        // netstat format: Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes
        if parts.len() >= 7 && parts[0].starts_with(interface_prefix) {
            // Check if this is the Nebula interface by looking for the IP
            // The IP can be in different columns depending on output format
            let target_ip = search_ip.unwrap_or("100.64");
            let mut found_ip = false;

            for part in &parts {
                if part.starts_with(target_ip) {
                    found_ip = true;
                    break;
                }
            }

            if found_ip {
                // Ibytes is usually column 6 (0-indexed) or 7
                // Obytes is usually column 9 or 10
                // We need to be careful.
                // Standard format: Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
                // utun4 1300 <Link#15> ...
                // utun4 1300 100.64.0.1 100.64.0.1 ...

                // Let's try to find Ibytes and Obytes based on position relative to end if possible
                // Or just assume standard positions if we found the IP

                // Try standard positions first
                if parts.len() >= 10 {
                    let ibytes_res = parts[6].parse::<u64>();
                    let obytes_res = parts[9].parse::<u64>();

                    if let (Ok(ibytes), Ok(obytes)) = (ibytes_res, obytes_res) {
                        debug!("Found interface stats: {}, IP: {}, TX: {}, RX: {}", parts[0], target_ip, obytes, ibytes);
                        return Ok((obytes, ibytes)); // TX, RX
                    }
                }
            }
        }
    }

    Err("Nebula interface not found in netstat output".to_string())
}

#[tauri::command]
pub async fn get_nebula_status() -> Result<NebulaStatus, String> {
    let is_running = check_nebula_running().await.unwrap_or(false);

    let networks = Networks::new_with_refreshed_list();
    let has_interface = networks.iter().any(|(name, _)| name.contains("nebula"));

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

#[tauri::command]
pub async fn get_nebula_binary_installed_status(state: tauri::State<'_, crate::app_state::AppState>) -> Result<bool, String> {
    let pool = state.pool().map_err(|e| e.to_string())?;

    // First check if binary is installed
    let is_installed: bool = sqlx::query("SELECT is_nebula_binary_installed FROM nebula_binary_status WHERE id = 1")
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .is_some_and(|row| row.get("is_nebula_binary_installed"));

    if !is_installed {
        return Ok(false);
    }

    // Check if we have a valid certificate
    let cert_status = sqlx::query("SELECT expires_at, is_active FROM nebula_certificate WHERE id = 1")
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;

    if let Some(row) = cert_status {
        let expires_at_str: Option<String> = row.get("expires_at");
        let is_active: Option<bool> = row.get("is_active");

        // Check if certificate is active and not expired
        if is_active.unwrap_or(false) {
            if let Some(expires_at_str) = expires_at_str {
                if let Ok(expires_at) = chrono::DateTime::parse_from_rfc3339(&expires_at_str) {
                    let now = chrono::Utc::now();
                    // Convert expires_at to UTC for comparison
                    let expires_at_utc = expires_at.with_timezone(&chrono::Utc);
                    if expires_at_utc > now {
                        return Ok(true);
                    }
                    debug!("Certificate expired on: {}", expires_at);
                }
            } else {
                debug!("Certificate has no expiration date");
            }
        } else {
            debug!("Certificate is not active");
        }
    } else {
        debug!("No certificate found in database");
    }

    // If we get here, either:
    // 1. No certificate exists
    // 2. Certificate is expired
    // 3. Certificate is not active
    Ok(false)
}

pub async fn verify_nebula_setup(app: tauri::AppHandle) -> Result<(), String> {
    // Check if Nebula is installed
    if let Err(e) = crate::nebula::manager::check_nebula_installation().await {
        warn!("Nebula not installed: {}", e);
        return Err("Nebula installation verification failed".into());
    }

    // Verify Nebula (this will check and renew certificates if needed)
    use tauri::Manager;
    let app_state = app.state::<crate::app_state::AppState>();
    let pool = app_state.pool().map_err(|e| e.to_string())?;
    let account_id = app_state.current_account_id().map_err(|e| e.clone())?;
    if let Err(e) = crate::nebula::manager::verify_nebula_internal(&app_state.api_client, pool, &account_id).await {
        warn!("Nebula verification failed: {}", e);
        return Err("Nebula verification failed".into());
    }

    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nebula_binary_path_is_deterministic() {
        let path1 = get_nebula_binary_path().unwrap();
        let path2 = get_nebula_binary_path().unwrap();
        assert_eq!(path1, path2);
    }

    #[test]
    fn nebula_binary_path_ends_with_nebula() {
        let path = get_nebula_binary_path().unwrap();
        let file_name = path.file_name().unwrap().to_string_lossy().to_string();
        assert!(
            file_name == "nebula" || file_name == "nebula.exe",
            "Expected 'nebula' or 'nebula.exe', got '{file_name}'"
        );
    }

    #[test]
    fn nebula_dir_is_under_hippius() {
        let dir = get_nebula_dir().unwrap();
        let dir_str = dir.to_string_lossy().to_string();
        assert!(dir_str.contains(".hippius"), "Expected path to contain '.hippius', got '{dir_str}'");
    }

    #[test]
    fn nebula_config_dir_includes_account_id() {
        let dir = get_nebula_config_dir("test_account_123").unwrap();
        let dir_str = dir.to_string_lossy().to_string();
        assert!(
            dir_str.contains("test_account_123"),
            "Expected path to contain account ID, got '{dir_str}'"
        );
    }

    #[test]
    fn asset_name_is_valid_for_current_platform() {
        let name = get_asset_name().unwrap();
        assert!(name.starts_with("nebula-"), "Expected asset name to start with 'nebula-', got '{name}'");
        let p = std::path::Path::new(&name);
        let is_zip = p.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip"));
        let is_tar_gz = name.to_ascii_lowercase().ends_with(".tar.gz");
        assert!(is_zip || is_tar_gz, "Expected .zip or .tar.gz, got '{name}'");
    }
}
