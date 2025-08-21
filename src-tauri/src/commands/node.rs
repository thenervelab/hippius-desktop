use once_cell::sync::OnceCell;
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};
use crate::constants::ipfs::{AppSetupPhase, APP_SETUP_EVENT, API_URL};
use crate::utils::binary::ensure_ipfs_binary;
use std::time::Duration;
use tokio::time::sleep;
use reqwest::Client;
use std::path::{Path, PathBuf};
use tokio::fs; // Changed from std::fs to tokio::fs for async operations
use std::fs::Permissions;

// For macOS/Linux permissions
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

static IPFS_HANDLE: OnceCell<Mutex<Option<tokio::process::Child>>> = OnceCell::new();
static CURRENT_SETUP_PHASE: OnceCell<Mutex<Option<AppSetupPhase>>> = OnceCell::new();

async fn emit_and_update_phase(app: AppHandle, phase: AppSetupPhase) -> AppHandle {
    let mutex = CURRENT_SETUP_PHASE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .await;
    {
        let mut guard = mutex;
        *guard = Some(phase.clone());
    }
    app.emit(APP_SETUP_EVENT, phase)
        .unwrap_or_else(|e| eprintln!("Emit failed: {e}"));
    app
}

#[tauri::command]
pub async fn get_current_setup_phase() -> Option<String> {
    let mutex = CURRENT_SETUP_PHASE.get_or_init(|| Mutex::new(None));
    let phase = mutex.lock().await;
    serde_json::to_string(&*phase).ok()
}

const SMALL_SLEEP: u64 = 4;
const LARGE_SLEEP: u64 = 15;

#[cfg(windows)]
pub fn spawn_ipfs_command(bin_path: &std::path::Path, args: &[&str]) -> tokio::process::Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = tokio::process::Command::new(bin_path);
    cmd.args(args)
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd
}

#[cfg(unix)]
pub fn spawn_ipfs_command(bin_path: &std::path::Path, args: &[&str]) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(bin_path);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd
}

async fn is_ipfs_api_up() -> bool {
    let client = Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let response = client.get(format!("{}/api/v0/version", API_URL)).send().await;
    matches!(response, Ok(resp) if resp.status().is_success())
}

#[tauri::command]
pub async fn start_ipfs_daemon(app: AppHandle) -> Result<(), String> {
    if let Some(lock) = IPFS_HANDLE.get() {
        let mut handle = lock.lock().await;
        if handle.is_some() {
            let _ = handle.as_mut().unwrap().kill().await;
            *handle = None;
        }
    }

    if let Some(mutex) = IPFS_HANDLE.get() {
        if mutex.lock().await.is_some() {
            println!("[IPFS] Daemon already running, skipping start");
            return Ok(());
        }
    }

    if is_ipfs_api_up().await {
        println!("[IPFS] Existing IPFS daemon detected on {}. Skipping start.", API_URL);
        emit_and_update_phase(app.clone(), AppSetupPhase::Ready).await;
        return Ok(());
    }

    sleep(Duration::from_secs(LARGE_SLEEP)).await;
    let app = emit_and_update_phase(app.clone(), AppSetupPhase::CheckingBinary).await;
    sleep(Duration::from_secs(SMALL_SLEEP)).await;

    let bin_path = ensure_ipfs_binary(app.clone())
        .await
        .map_err(|e| format!("Binary fetch failed: {e}"))?;
    ensure_ipfs_not_running(&bin_path).await?;
    let app = emit_and_update_phase(app.clone(), AppSetupPhase::InitializingRepo).await;
    crate::utils::binary::ensure_ipfs_repo_initialized(&bin_path)
        .map_err(|e| format!("IPFS repo init failed: {e}"))?;

    let app = emit_and_update_phase(app.clone(), AppSetupPhase::ConfiguringCors).await;
    configure_ipfs_cors(&bin_path).await?;
    sleep(Duration::from_secs(SMALL_SLEEP)).await;

    let app = emit_and_update_phase(app.clone(), AppSetupPhase::StartingDaemon).await;

    let mut cmd = spawn_ipfs_command(&bin_path, &["daemon"]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Spawn failed: {e}"))?;
    let stdout = child.stdout.take().expect("Failed to open stdout");
    let app_clone_for_stdout = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            println!("[ipfs stdout] {}", line);
            if line.contains("Swarm listening on") {
                emit_and_update_phase(app_clone_for_stdout.clone(), AppSetupPhase::ConnectingToNetwork).await;
            }
            if line.contains("Daemon is ready") || line.contains("API server listening") {
                sleep(Duration::from_secs(SMALL_SLEEP)).await;
                emit_and_update_phase(app_clone_for_stdout.clone(), AppSetupPhase::InitialisingDatabase).await;
                sleep(Duration::from_secs(SMALL_SLEEP)).await;
                emit_and_update_phase(app_clone_for_stdout.clone(), AppSetupPhase::SyncingData).await;
                sleep(Duration::from_secs(SMALL_SLEEP)).await;
                emit_and_update_phase(app_clone_for_stdout.clone(), AppSetupPhase::Ready).await;
            }
        }
    });

    // Check if AWS CLI installation should be skipped (to avoid repeated permission prompts)
    if !should_skip_aws_installation().await && !is_aws_cli_installed().await {
        println!("[AWS CLI] Not found. Installing...");
        match install_aws_cli().await {
            Ok(_) => {
                println!("[AWS CLI] Installed successfully.");
                mark_aws_installation_complete().await;
            },
            Err(e) => {
                eprintln!("[AWS CLI] Install failed: {}", e);
                // Mark to skip future attempts for this session to avoid repeated prompts
                mark_aws_installation_attempted().await;
            }
        }
    } else {
        println!("[AWS CLI] Installation check skipped or already installed.");
    }

    let mutex = IPFS_HANDLE.get_or_init(|| Mutex::new(None));
    let mut guard = mutex.lock().await;
    guard.replace(child);

    Ok(())
}

async fn is_ipfs_repo_locked(repo_path: &Path) -> bool {
    repo_path.join("repo.lock").exists()
}

async fn configure_ipfs_cors(bin_path: &PathBuf) -> Result<(), String> {
    ensure_ipfs_not_running(bin_path).await?;

    for _ in 0..3 {
        let _ = spawn_ipfs_command(bin_path, &["shutdown"]).output().await;
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    let ipfs_path = dirs::home_dir().unwrap().join(".ipfs");
    if is_ipfs_repo_locked(&ipfs_path).await {
        return Err("IPFS repository is locked by another process".to_string());
    }

    let cors_config = vec![
        ("API.HTTPHeaders.Access-Control-Allow-Origin", "[\"http://localhost:3000\"]"),
        ("API.HTTPHeaders.Access-Control-Allow-Methods", "[\"PUT\", \"GET\", \"POST\", \"OPTIONS\"]"),
        ("API.HTTPHeaders.Access-Control-Allow-Headers", "[\"Authorization\"]"),
    ];

    for (key, value) in cors_config {
        let output = spawn_ipfs_command(bin_path, &["config", "--json", key, value]).output().await.map_err(|e| format!("Failed to set CORS config {}: {}", key, e))?;
        if !output.status.success() {
            eprintln!("Failed to set CORS config {}: {}", key, String::from_utf8_lossy(&output.stderr));
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn stop_ipfs_daemon() {
    if let Some(lock) = IPFS_HANDLE.get() {
        let mut handle = lock.lock().await;
        if let Some(child) = handle.as_mut() {
            let _ = child.kill().await;
        }
        *handle = None;
    }
}

#[cfg(target_os = "macos")]
async fn ensure_ipfs_not_running(_bin_path: &Path) -> Result<(), String> {
    let output = Command::new("pkill").arg("-f").arg("ipfs daemon").output().await.map_err(|e| format!("Failed to kill IPFS processes: {}", e))?;
    if !output.status.success() && !output.stderr.is_empty() {
        eprintln!("pkill stderr: {}", String::from_utf8_lossy(&output.stderr));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
async fn ensure_ipfs_not_running(_bin_path: &Path) -> Result<(), String> {
    Ok(())
}

async fn get_system_architecture() -> Result<String, String> {
    let output = Command::new("uname").arg("-m").output().await.map_err(|e| format!("Failed to detect architecture: {}", e))?;
    if !output.status.success() { return Err("Failed to detect architecture".into()); }
    let arch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    match arch.as_str() {
        "x86_64" => Ok("x86_64".to_string()),
        "arm64" | "aarch64" => Ok("aarch64".to_string()),
        _ => Err(format!("Unsupported architecture: {}", arch)),
    }
}

#[cfg(target_os = "linux")]
async fn install_aws_cli() -> Result<(), String> {
    use tokio::fs;
    use tokio::process::Command;
    use std::os::unix::fs::PermissionsExt;

    let install_dir = dirs::home_dir().ok_or("Could not find home directory")?.join(".aws-cli");
    let bin_dir = install_dir.join("bin");

    fs::create_dir_all(&bin_dir).await.map_err(|e| format!("Failed to create bin dir: {}", e))?;

    let url = "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip";
    let zip_path = install_dir.join("awscliv2.zip");

    let output = Command::new("curl")
        .args(&["-L", url, "-o", zip_path.to_str().unwrap(), "-f", "--show-error"])
        .output()
        .await
        .map_err(|e| format!("Download command failed: {}", e))?;

    if !output.status.success() {
        return Err(format!("Failed to download AWS CLI: {}", String::from_utf8_lossy(&output.stderr)));
    }

    let output = Command::new("unzip")
        .args(&[zip_path.to_str().unwrap(), "-d", install_dir.to_str().unwrap()])
        .output()
        .await
        .map_err(|e| format!("Unzip command failed: {}", e))?;

    if !output.status.success() {
        return Err(format!("Failed to unzip AWS CLI: {}", String::from_utf8_lossy(&output.stderr)));
    }

    let aws_binary_src = install_dir.join("aws").join("dist").join("aws");
    let aws_binary_dest = bin_dir.join("aws");

    fs::copy(&aws_binary_src, &aws_binary_dest).await
        .map_err(|e| format!("Failed to copy aws binary: {}", e))?;

    let mut perms = fs::metadata(&aws_binary_dest)
    .await
    .map_err(|e| format!("Failed to get metadata for aws binary: {}", e))?
    .permissions();
    
    perms.set_mode(0o755);
    fs::set_permissions(&aws_binary_dest, perms)
    .await
    .map_err(|e| format!("Failed to set permissions on aws binary: {}", e))?;

    println!("[AWS CLI] Installed successfully into user directory without sudo (Linux).");
    Ok(())
}

#[cfg(target_os = "windows")]
async fn install_aws_cli() -> Result<(), String> {
    use tokio::fs;
    use tokio::process::Command;
    use std::path::Path;

    let install_dir = dirs::home_dir().ok_or("Could not find home directory")?.join(".aws-cli");
    let bin_dir = install_dir.join("bin");

    fs::create_dir_all(&bin_dir).await.map_err(|e| format!("Failed to create bin dir: {}", e))?;

    let url = "https://awscli.amazonaws.com/AWSCLIV2.msi";
    let msi_path = install_dir.join("AWSCLIV2.msi");

    let output = Command::new("curl")
        .args(&["-L", url, "-o", msi_path.to_str().unwrap(), "-f", "--show-error"])
        .output()
        .await
        .map_err(|e| format!("Download command failed: {}", e))?;

    if !output.status.success() {
        return Err(format!("Failed to download AWS CLI: {}", String::from_utf8_lossy(&output.stderr)));
    }

    // Use msiexec with target directory under user home (no admin required if writing there)
    let output = Command::new("msiexec")
        .args(&["/a", msi_path.to_str().unwrap(), "/qn", &format!("TARGETDIR={}", install_dir.to_str().unwrap())])
        .output()
        .await
        .map_err(|e| format!("MSI extraction failed: {}", e))?;

    if !output.status.success() {
        return Err(format!("Failed to extract AWS CLI MSI: {}", String::from_utf8_lossy(&output.stderr)));
    }

    let aws_binary_src = install_dir.join("AWSCLIV2").join("aws.exe");
    let aws_binary_dest = bin_dir.join("aws.exe");

    fs::copy(&aws_binary_src, &aws_binary_dest).await
        .map_err(|e| format!("Failed to copy aws.exe: {}", e))?;

    println!("[AWS CLI] Installed successfully into user directory without admin (Windows).");
    Ok(())
}

#[cfg(target_os = "macos")]
async fn install_aws_cli() -> Result<(), String> {
    use tokio::process::Command;
    use tokio::fs;

    println!("[AWS CLI] Checking for AWS CLI...");

    // First, check if AWS CLI is already installed
    if let Ok(output) = Command::new("which").arg("aws").output().await {
        if output.status.success() {
            println!("[AWS CLI] AWS CLI is already installed");
            return Ok(());
        }
    }

    // Check if Homebrew is installed
    let has_brew = Command::new("brew")
        .arg("--version")
        .output().await
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !has_brew {
        println!("[AWS CLI] Installing Homebrew without sudo...");
        // Install Homebrew in user's home directory (no sudo required)
        let output = Command::new("/bin/bash")
            .args(&["-c", r#"
                # Install Homebrew to ~/.homebrew
                git clone https://github.com/Homebrew/brew ~/.homebrew
                echo 'export PATH="$HOME/.homebrew/bin:$PATH"' >> ~/.zshrc
                echo 'export PATH="$HOME/.homebrew/bin:$PATH"' >> ~/.bashrc
                export PATH="$HOME/.homebrew/bin:$PATH"
            "#])
            .output()
            .await
            .map_err(|e| format!("Homebrew installation failed: {}", e))?;

        if !output.status.success() {
            return Err("Failed to install Homebrew".into());
        }
    }

    // Install AWS CLI using Homebrew (user installation, no sudo)
    println!("[AWS CLI] Installing AWS CLI via Homebrew...");
    
    // Use the user's Homebrew installation
    let brew_path = if has_brew {
        "brew".to_string()
    } else {
        // Use the newly installed Homebrew
        let home = dirs::home_dir().ok_or("Could not find home directory")?;
        home.join(".homebrew").join("bin").join("brew").to_str().unwrap().to_string()
    };

    let output = Command::new(&brew_path)
        .args(&["install", "awscli"])
        .output()
        .await
        .map_err(|e| format!("AWS CLI installation failed: {}", e))?;

    if output.status.success() {
        println!("[AWS CLI] AWS CLI installed successfully via Homebrew");
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Failed to install AWS CLI: {}", stderr))
    }
}

// Recursively search for a file named "aws" under a "bin" directory, with a max depth.
#[cfg(target_os = "macos")]
async fn find_aws_binary_recursively(root: &Path, max_depth: usize) -> Option<PathBuf> {
    use std::collections::VecDeque;
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
    queue.push_back((root.to_path_buf(), 0));
    while let Some((dir, depth)) = queue.pop_front() {
        if depth > max_depth { continue; }
        let mut rd = match tokio::fs::read_dir(&dir).await { Ok(r) => r, Err(_) => continue };
        while let Ok(Some(ent)) = rd.next_entry().await {
            let p = ent.path();
            if let Ok(ft) = ent.file_type().await {
                if ft.is_dir() {
                    queue.push_back((p.clone(), depth + 1));
                    // If this dir is named "bin", look for a child named "aws"
                    if p.file_name().map(|n| n == "bin").unwrap_or(false) {
                        let candidate = p.join("aws");
                        if candidate.exists() { return Some(candidate); }
                    }
                }
            }
        }
    }
    None
}

async fn get_aws_binary_path() -> Result<PathBuf, String> {
    let install_dir = dirs::home_dir().ok_or("Could not find home directory")?.join(".aws-cli");
    
    #[cfg(target_os = "windows")]
    {
        let binary_path = install_dir.join("bin").join("aws.exe");
        Ok(binary_path)
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let binary_path = install_dir.join("bin").join("aws");
        Ok(binary_path)
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    Err("Unsupported operating system for local AWS CLI management.".to_string())
}

// --- AWS Installation State Management ---
async fn get_aws_state_file() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".hippius").join("aws_install_state"))
}

async fn should_skip_aws_installation() -> bool {
    if let Some(state_file) = get_aws_state_file().await {
        if state_file.exists() {
            if let Ok(content) = fs::read_to_string(&state_file).await {
                return content.trim() == "completed" || content.trim() == "attempted";
            }
        }
    }
    false
}

async fn mark_aws_installation_complete() {
    if let Some(state_file) = get_aws_state_file().await {
        if let Some(parent) = state_file.parent() {
            let _ = fs::create_dir_all(parent).await;
        }
        let _ = fs::write(&state_file, "completed").await;
    }
}

async fn mark_aws_installation_attempted() {
    if let Some(state_file) = get_aws_state_file().await {
        if let Some(parent) = state_file.parent() {
            let _ = fs::create_dir_all(parent).await;
        }
        let _ = fs::write(&state_file, "attempted").await;
    }
}

#[tauri::command]
pub async fn reset_aws_installation_state() -> Result<(), String> {
    if let Some(state_file) = get_aws_state_file().await {
        if state_file.exists() {
            fs::remove_file(&state_file).await
                .map_err(|e| format!("Failed to reset AWS installation state: {}", e))?;
        }
    }
    println!("[AWS CLI] Installation state reset. AWS CLI will be checked again on next startup.");
    Ok(())
}

async fn is_aws_cli_installed() -> bool {
    let path = match get_aws_binary_path().await {
        Ok(p) => p,
        Err(_) => return false,
    };
    #[cfg(not(target_os = "windows"))]
    if !path.exists() { return false; }
    Command::new(path)
        .arg("--version")
        .stdout(Stdio::null()).stderr(Stdio::null())
        .status().await.map_or(false, |s| s.success())
}