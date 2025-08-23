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

    sleep(Duration::from_secs(LARGE_SLEEP)).await;
    let app = emit_and_update_phase(app.clone(), AppSetupPhase::CheckingBinary).await;
    sleep(Duration::from_secs(SMALL_SLEEP)).await;

    // Ensure AWS CLI is available as part of CheckingBinary (no extra event)
    ensure_aws_cli_installed_blocking().await;

    // If an IPFS daemon is already up, skip starting and just move to final phases
    if is_ipfs_api_up().await {
        println!("[IPFS] Existing IPFS daemon detected on {}. Skipping start.", API_URL);
        sleep(Duration::from_secs(SMALL_SLEEP)).await;
        let app = emit_and_update_phase(app.clone(), AppSetupPhase::InitialisingDatabase).await;
        sleep(Duration::from_secs(SMALL_SLEEP)).await;
        let app = emit_and_update_phase(app.clone(), AppSetupPhase::SyncingData).await;
        sleep(Duration::from_secs(SMALL_SLEEP)).await;
        emit_and_update_phase(app.clone(), AppSetupPhase::Ready).await;
        return Ok(());
    }

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
        .args(&[
            "https://awscli.amazonaws.com/AWSCLIV2.msi",
            "-o",
            msi_path.to_str().unwrap(),
            "-L", // Follow redirects
            "-f", // Fail fast on server errors
            "--show-error",
        ])
        .output()
        .await
        .map_err(|e| format!("curl command failed: {}", e))?;

    if !output.status.success() {
        return Err("Internet connection required to download AWS CLI.".to_string());
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

// Install AWS CLI with retries (no event emission). Blocks until installed.
async fn ensure_aws_cli_installed_blocking() {
    if is_aws_cli_installed().await {
        println!("[AWS CLI] Already installed.");
        return;
    }

    let mut delay = Duration::from_secs(5);
    loop {
        println!("[AWS CLI] Installing...");
        #[cfg(target_os = "macos")]
        let res = {
            // Try installing from bundled resources first, then fall back to pkg-based flow
            match install_aws_cli_from_bundle_macos().await {
                Ok(()) => Ok(()),
                Err(e) => {
                    eprintln!(
                        "[AWS CLI] Bundled install unavailable or failed ({}). Falling back to pkg installer...",
                        e
                    );
                    install_aws_cli().await
                }
            }
        };
        #[cfg(not(target_os = "macos"))]
        let res = install_aws_cli().await;

        match res {
            Ok(_) => {
                if is_aws_cli_installed().await {
                    println!("[AWS CLI] Installed successfully.");
                    mark_aws_installation_complete().await;
                    break;
                } else {
                    eprintln!("[AWS CLI] Post-install check failed; retrying...");
                }
            }
            Err(e) => {
                eprintln!("[AWS CLI] Install failed: {}", e);
                mark_aws_installation_attempted().await;
            }
        }
        sleep(delay).await;
        delay = std::cmp::min(delay * 2, Duration::from_secs(60));
    }
}

#[cfg(target_os = "macos")]
async fn install_aws_cli_from_bundle_macos() -> Result<(), String> {
    // Determine architecture to pick the right resource folder
    let arch = String::from_utf8_lossy(
        &Command::new("uname")
            .arg("-m")
            .output()
            .await
            .map_err(|e| format!("uname -m command failed: {}", e))?
            .stdout,
    )
    .trim()
    .to_string();

    // Resolve the Resources directory of the .app bundle
    let resources_dir = macos_resources_dir().ok_or_else(|| "Failed to locate app Resources directory".to_string())?;

    // Layout options: prefer universal, otherwise arch-specific
    let candidates = [
        resources_dir.join("awscli-macos-universal").join("aws-cli"),
        if arch == "arm64" {
            resources_dir.join("awscli-macos-arm64").join("aws-cli")
        } else {
            resources_dir.join("awscli-macos-x64").join("aws-cli")
        },
    ];

    // Pick first existing source
    let source_dir = candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .ok_or_else(|| "Bundled AWS CLI not found in app resources".to_string())?;

    let home_dir = dirs::home_dir().ok_or("Could not find home directory")?;
    let target_root = home_dir.join(".aws-cli");
    let target_dir = target_root.join("aws-cli");

    // Copy recursively in a blocking task using std::fs
    tokio::task::spawn_blocking(move || {
        use std::fs;
        use std::io;
        fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> io::Result<()> {
            if !dst.exists() {
                fs::create_dir_all(dst)?;
            }
            for entry in fs::read_dir(src)? {
                let entry = entry?;
                let path = entry.path();
                let to_path = dst.join(entry.file_name());
                if path.is_dir() {
                    copy_dir_recursive(&path, &to_path)?;
                } else {
                    fs::create_dir_all(to_path.parent().unwrap())?;
                    fs::copy(&path, &to_path)?;
                }
            }
            Ok(())
        }
        copy_dir_recursive(&source_dir, &target_dir)
    })
    .await
    .map_err(|e| format!("task join error: {}", e))?
    .map_err(|e| format!("Failed to copy bundled AWS CLI: {}", e))?;

    // Ensure executables are marked executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let aws_bin = target_dir.join("aws");
        if aws_bin.exists() {
            if let Ok(meta) = tokio::fs::metadata(&aws_bin).await {
                let mut mode = meta.permissions().mode();
                // add user/group/other execute bits
                mode |= 0o111;
                let _ = tokio::fs::set_permissions(&aws_bin, std::fs::Permissions::from_mode(mode)).await;
            }
        }
        let completer = target_dir.join("aws_completer");
        if completer.exists() {
            if let Ok(meta) = tokio::fs::metadata(&completer).await {
                let mut mode = meta.permissions().mode();
                mode |= 0o111;
                let _ = tokio::fs::set_permissions(&completer, std::fs::Permissions::from_mode(mode)).await;
            }
        }
    }

    // Verify
    let aws_path = get_aws_binary_path().await?;
    let output = Command::new(&aws_path)
        .arg("--version")
        .output()
        .await
        .map_err(|e| format!("aws --version command failed: {}", e))?;
    if !output.status.success() {
        return Err("Bundled AWS CLI appears non-functional".to_string());
    }

    println!("[AWS CLI] Installed from bundled resources to {}", target_dir.display());
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_resources_dir() -> Option<std::path::PathBuf> {
    // Resolve .../MyApp.app/Contents/Resources relative to current_exe()
    let exe = std::env::current_exe().ok()?; // .../MyApp.app/Contents/MacOS/MyApp
    let macos_dir = exe.parent()?; // .../MyApp.app/Contents/MacOS
    let contents_dir = macos_dir.parent()?; // .../MyApp.app/Contents
    Some(contents_dir.join("Resources"))
}

async fn get_aws_binary_path() -> Result<PathBuf, String> {
    let base_dir = dirs::home_dir().ok_or("Could not find home directory")?.join(".aws-cli");

    #[cfg(target_os = "windows")]
    {
        Ok(base_dir.join("bin").join("aws.exe"))
    }
    #[cfg(target_os = "linux")]
    {
        Ok(base_dir.join("bin").join("aws"))
    }
    #[cfg(target_os = "macos")]
    {
        // The official installer for 'CurrentUserHomeDirectory' creates this specific sub-path.
        Ok(base_dir.join("aws-cli").join("aws"))
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        Err("Unsupported operating system for local AWS CLI management.".to_string())
    }
}

async fn is_aws_cli_installed() -> bool {
    // Try our managed local binary first.
    if let Ok(p) = get_aws_binary_path().await {
        if p.exists() {
            if Command::new(p).arg("--version").output().await.map_or(false, |o| o.status.success()) {
                return true;
            }
        }
    }

    // Fallback to system PATH for users who might have it installed via another method.
    Command::new("aws")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_or(false, |s| s.success())
}