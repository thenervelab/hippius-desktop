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

    // Ensure the dist/aws binary is executable (we will execute it in-place with its side-by-side files)
    let aws_binary_in_dist = install_dir.join("aws").join("dist").join("aws");
    if aws_binary_in_dist.exists() {
        let mut perms = fs::metadata(&aws_binary_in_dist)
            .await
            .map_err(|e| format!("Failed to get metadata for aws binary: {}", e))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&aws_binary_in_dist, perms)
            .await
            .map_err(|e| format!("Failed to set permissions on aws binary: {}", e))?;
    }

    // Also place a user-accessible launcher into ~/.local/bin so `aws` is available in the shell
    // We create a tiny wrapper script that changes directory to the dist folder and execs the real binary.
    if let Some(home) = dirs::home_dir() {
        let user_bin = home.join(".local").join("bin");
        if let Err(e) = fs::create_dir_all(&user_bin).await {
            eprintln!("[AWS CLI] Warning: failed to ensure ~/.local/bin exists: {}", e);
        } else {
            let user_path_aws = user_bin.join("aws");
            // Overwrite any existing file
            if user_path_aws.exists() {
                let _ = fs::remove_file(&user_path_aws).await;
            }

            // Build wrapper script contents
            let dist_dir = install_dir.join("aws").join("dist");
            let wrapper = format!(
                "#!/usr/bin/env bash\ncd \"{}\" || exit 1\nAWS_PAGER=\"\" exec \"{}/aws\" \"$@\"\n",
                dist_dir.display(),
                dist_dir.display()
            );

            if let Err(e) = fs::write(&user_path_aws, wrapper.as_bytes()).await {
                eprintln!("[AWS CLI] Warning: failed to write wrapper to ~/.local/bin/aws: {}", e);
            } else {
                // Ensure executable
                if let Ok(meta) = fs::metadata(&user_path_aws).await {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o755);
                    let _ = fs::set_permissions(&user_path_aws, perms).await;
                }

                // Make sure current process can see ~/.local/bin first on PATH
                if let Ok(mut cur_path) = std::env::var("PATH") {
                    let user_bin_str = user_bin.to_string_lossy().to_string();
                    if !cur_path.split(':').any(|p| p == user_bin_str) {
                        cur_path = format!("{}:{}", user_bin_str, cur_path);
                        std::env::set_var("PATH", &cur_path);
                        println!("[AWS CLI] Added {} to PATH for current process", user_bin_str);
                    }
                }

                // Verify via the wrapper in ~/.local/bin directly
                let verify = Command::new(&user_path_aws)
                    .arg("--version")
                    .output()
                    .await;
                if let Ok(v) = verify {
                    if v.status.success() {
                        println!("[AWS CLI] Verified aws launcher in ~/.local/bin");
                    } else {
                        eprintln!("[AWS CLI] aws launcher in ~/.local/bin failed to run: {}", String::from_utf8_lossy(&v.stderr));
                    }
                }
            }
        }
    }

    println!("[AWS CLI] Installed successfully into user directory without sudo (Linux).");
    Ok(())
}

#[cfg(target_os = "windows")]
async fn install_aws_cli() -> Result<(), String> {
    use std::io;

    // 1) Define install locations under the user's home directory
    let install_dir = dirs::home_dir()
        .ok_or("Could not find home directory")?
        .join(".aws-cli");
    let bin_dir = install_dir.join("bin");
    fs::create_dir_all(&bin_dir)
        .await
        .map_err(|e| format!("Failed to create directories: {}", e))?;

    // 2) Resolve Resources directory (dev or packaged) and log it
    let resources_dir = windows_resources_dir()
        .ok_or_else(|| "Failed to locate app Resources directory".to_string())?;
    println!("[AWS CLI][Windows] Using Resources dir: {}", resources_dir.display());

    // 3) Build expected source and log candidates
    let source_dir = resources_dir
        .join("awscli-windows")
        .join("AWSCLIV2");
    println!("[AWS CLI][Windows] Expecting bundled CLI at: {}", source_dir.display());

    if !source_dir.exists() {
        // Extra diagnostics: list the resources dir to help debugging
        eprintln!(
            "[AWS CLI][Windows] Bundled directory not found. Listing contents of {}:",
            resources_dir.display()
        );
        if let Ok(mut rd) = tokio::fs::read_dir(&resources_dir).await {
            while let Ok(Some(ent)) = rd.next_entry().await {
                eprintln!("  - {}", ent.path().display());
            }
        }
        return Err(format!(
            "Bundled AWS CLI not found at expected path: {}",
            source_dir.display()
        ));
    }

    // 4) Copy the entire AWSCLIV2 folder to ~/.aws-cli/AWSCLIV2 (so auxiliary files are preserved)
    let target_cli_dir = install_dir.join("AWSCLIV2");
    println!(
        "[AWS CLI][Windows] Installing bundled CLI to {}",
        target_cli_dir.display()
    );

    let src_clone = source_dir.clone();
    let dst_clone = target_cli_dir.clone();
    tokio::task::spawn_blocking(move || {
        use std::fs;
        // Fresh install: remove old target if it exists
        if dst_clone.exists() {
            let _ = fs::remove_dir_all(&dst_clone);
        }
        fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> io::Result<()> {
            std::fs::create_dir_all(dst)?;
            for entry in std::fs::read_dir(src)? {
                let entry = entry?;
                let path = entry.path();
                let to_path = dst.join(entry.file_name());
                if path.is_dir() {
                    copy_dir_recursive(&path, &to_path)?;
                } else {
                    std::fs::copy(&path, &to_path)?;
                }
            }
            Ok(())
        }
        copy_dir_recursive(&src_clone, &dst_clone)
    })
    .await
    .map_err(|e| format!("Task join error during copy: {}", e))?
    .map_err(|e| format!("Failed to copy bundled AWS CLI: {}", e))?;

    // 5) Ensure aws.exe is available at ~/.aws-cli/bin/aws.exe (the path used by get_aws_binary_path())
    let aws_binary_src = target_cli_dir.join("aws.exe");
    let aws_binary_dest = bin_dir.join("aws.exe");

    if !aws_binary_src.exists() {
        return Err(format!(
            "Copied CLI, but aws.exe missing at {}",
            aws_binary_src.display()
        ));
    }

    // Copy (overwrite) the launcher into bin
    if let Err(e) = tokio::fs::copy(&aws_binary_src, &aws_binary_dest).await {
        return Err(format!(
            "Failed to place aws.exe into bin ({} -> {}): {}",
            aws_binary_src.display(),
            aws_binary_dest.display(),
            e
        ));
    }

    // 6) Verify
    // Run from within the AWSCLIV2 folder so aws.exe can find its side-by-side DLLs
    println!(
        "[AWS CLI][Windows] Verifying installation (cwd={}): {}",
        target_cli_dir.display(),
        aws_binary_src.display()
    );

    // Use Windows-specific command creation to suppress terminal window
    let mut verify_cmd = Command::new(&aws_binary_src);
    verify_cmd
        .current_dir(&target_cli_dir)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // Add Windows-specific flags to suppress terminal window
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        verify_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let ok = verify_cmd
        .status()
        .await
        .map_or(false, |s| s.success());
    if !ok {
        return Err("aws.exe did not run successfully after install".to_string());
    }

    println!("[AWS CLI][Windows] Installed successfully from bundled resources.");
    Ok(())
}

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
            // Try installing from bundled resources first; if that fails, bubble the error up (no pkg fallback on macOS)
            match install_aws_cli_from_bundle_macos().await {
                Ok(()) => Ok(()),
                Err(e) => {
                    eprintln!(
                        "[AWS CLI] Bundled install unavailable or failed ({}). No pkg fallback configured on macOS.",
                        e
                    );
                    Err(e)
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
    // 1. Resolve the Resources directory of the .app bundle
    let resources_dir = macos_resources_dir()
        .ok_or_else(|| "Failed to locate app Resources directory".to_string())?;
    println!("[AWS CLI] Using Resources dir: {}", resources_dir.display());

    // 2. Define the source directory, pointing to the nested aws-cli folder
    let source_dir = resources_dir.join("resources").join("awscli-macos-universal").join("aws-cli");

    // 3. Check if the bundled directory actually exists
    if !source_dir.exists() {
        // Extra diagnostics
        eprintln!(
            "[AWS CLI] The bundled AWS CLI directory was not found at the expected path: {}",
            source_dir.display()
        );
        return Err("Bundled AWS CLI not found in app resources".to_string());
    }

    // 4. Define the target installation directory in the user's home folder
    let home_dir = dirs::home_dir().ok_or("Could not find home directory")?;
    let target_dir = home_dir.join(".aws-cli").join("aws-cli");

    // Ensure target parent directory exists
    if let Some(parent) = target_dir.parent() {
        tokio::fs::create_dir_all(parent).await
            .map_err(|e| format!("Failed to create target directory: {}", e))?;
    }

    // 5. Copy the bundled files recursively
    let src_clone = source_dir.clone();
    let dst_clone = target_dir.clone();
    tokio::task::spawn_blocking(move || {
        use std::fs;
        use std::io;

        if dst_clone.exists() {
            let _ = fs::remove_dir_all(&dst_clone);
        }
        
        fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
            fs::create_dir_all(dst)?;
            for entry in fs::read_dir(src)? {
                let entry = entry?;
                let path = entry.path();
                let to_path = dst.join(entry.file_name());
                if path.is_dir() {
                    copy_dir_recursive(&path, &to_path)?;
                } else {
                    fs::copy(&path, &to_path)?;
                }
            }
            Ok(())
        }
        copy_dir_recursive(&src_clone, &dst_clone)
    })
    .await
    .map_err(|e| format!("Task join error during copy: {}", e))?
    .map_err(|e| format!("Failed to copy bundled AWS CLI: {}", e))?;

    // 6. Define the path to the executable and make it executable
    let aws_bin = target_dir.join("aws");

    if aws_bin.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = tokio::fs::metadata(&aws_bin).await
                .map_err(|e| format!("Failed to get metadata for aws binary: {}", e))?;
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            tokio::fs::set_permissions(&aws_bin, perms).await
                .map_err(|e| format!("Failed to set permissions on aws binary: {}", e))?;
        }
    } else {
        return Err("Copied files, but the 'aws' executable is missing.".to_string());
    }

   // 7. Verify the installation
   let mut cmd = Command::new(&aws_bin);
   cmd.arg("--version");
   #[cfg(target_os = "windows")]
   {
       use std::os::windows::process::CommandExt;
       cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
   }

   let output = cmd.output().await.map_err(|e| format!("aws --version command failed after install: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Bundled AWS CLI appears non-functional: {}", stderr));
    }

    println!("[AWS CLI] Installed from bundled resources to {}", target_dir.display());

    // Also create a user-accessible launcher into ~/.local/bin so `aws` is available in the shell (macOS)
    if let Some(home) = dirs::home_dir() {
        let user_bin = home.join(".local").join("bin");
        if let Err(e) = tokio::fs::create_dir_all(&user_bin).await {
            eprintln!("[AWS CLI][macOS] Warning: failed to ensure ~/.local/bin exists: {}", e);
        } else {
            let user_path_aws = user_bin.join("aws");
            // Overwrite any existing file
            if user_path_aws.exists() {
                let _ = tokio::fs::remove_file(&user_path_aws).await;
            }

            // Build wrapper script contents to exec the installed binary
            let wrapper = format!(
                "#!/usr/bin/env bash\nAWS_PAGER=\"\" exec \"{}\" \"$@\"\n",
                target_dir.join("aws").display()
            );

            if let Err(e) = tokio::fs::write(&user_path_aws, wrapper.as_bytes()).await {
                eprintln!("[AWS CLI][macOS] Warning: failed to write wrapper to ~/.local/bin/aws: {}", e);
            } else {
                // Ensure executable
                if let Ok(meta) = tokio::fs::metadata(&user_path_aws).await {
                    let mut perms = meta.permissions();
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        perms.set_mode(0o755);
                    }
                    let _ = tokio::fs::set_permissions(&user_path_aws, perms).await;
                }

                // Make sure current process can see ~/.local/bin first on PATH
                if let Ok(mut cur_path) = std::env::var("PATH") {
                    let user_bin_str = user_bin.to_string_lossy().to_string();
                    if !cur_path.split(':').any(|p| p == user_bin_str) {
                        cur_path = format!("{}:{}", user_bin_str, cur_path);
                        std::env::set_var("PATH", &cur_path);
                        println!("[AWS CLI][macOS] Added {} to PATH for current process", user_bin_str);
                    }
                }

                // Persist PATH update for user shells (zsh): append to ~/.zprofile and ~/.zshrc if missing
                // This is idempotent and will not duplicate entries.
                {
                    use tokio::io::AsyncWriteExt;
                    let export_line = r#"export PATH="$HOME/.local/bin:$PATH""#;
                    let notice = "\n# Added by Hippius to expose aws in the shell\n";
                    let profiles = [home.join(".zprofile"), home.join(".zshrc")];
                    for path in &profiles {
                        let mut needs_write = true;
                        if let Ok(existing) = tokio::fs::read_to_string(path).await {
                            if existing.contains(export_line) {
                                needs_write = false;
                            }
                        }
                        if needs_write {
                            if let Ok(mut f) = tokio::fs::OpenOptions::new()
                                .create(true)
                                .append(true)
                                .open(path)
                                .await
                            {
                                let _ = f.write_all(notice.as_bytes()).await;
                                let _ = f.write_all(format!("{}\n", export_line).as_bytes()).await;
                                println!("[AWS CLI][macOS] Appended PATH export to {}", path.display());
                            } else {
                                eprintln!("[AWS CLI][macOS] Warning: could not open {} for appending PATH", path.display());
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_resources_dir() -> Option<std::path::PathBuf> {
    // In production, the resources are in a 'Resources' directory
    // next to the executable's directory (.../Contents/MacOS/app -> .../Contents/Resources)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(macos_dir) = exe.parent() {
            if let Some(contents_dir) = macos_dir.parent() {
                let resources = contents_dir.join("Resources");
                if resources.exists() {
                    return Some(resources);
                }
            }
        }
    }

    // In development, Tauri sets the working directory to `src-tauri`,
    // so we can resolve the path from there.
    if cfg!(debug_assertions) {
        if let Ok(cwd) = std::env::current_dir() {
            let dev_resources = cwd.join("resources");
            if dev_resources.exists() {
                return Some(dev_resources);
            }
        }
    }

    None
}

#[cfg(target_os = "windows")]
fn windows_resources_dir() -> Option<std::path::PathBuf> {
    // Packaged: Tauri places a `resources` folder next to the executable
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let packaged = exe_dir.join("resources");
            if packaged.exists() {
                return Some(packaged);
            }
        }
    }

    // Dev: try cwd/resources (when running `tauri dev` from src-tauri)
    if cfg!(debug_assertions) {
        if let Ok(cwd) = std::env::current_dir() {
            let dev_resources = cwd.join("resources");
            if dev_resources.exists() {
                return Some(dev_resources);
            }
        }
    }

    None
}

async fn get_aws_binary_path() -> Result<PathBuf, String> {
    let base_dir = dirs::home_dir().ok_or("Could not find home directory")?.join(".aws-cli");

    #[cfg(target_os = "windows")]
    {
        // Prefer running aws.exe from its installed folder with DLLs alongside it
        let primary = base_dir.join("AWSCLIV2").join("aws.exe");
        if primary.exists() {
            return Ok(primary);
        }
        // Fallback to legacy/bin location if present
        let fallback = base_dir.join("bin").join("aws.exe");
        Ok(fallback)
    }
    #[cfg(target_os = "linux")]
    {
        // Run the binary from its dist folder where its dependencies live
        Ok(base_dir.join("aws").join("dist").join("aws"))
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
            let mut cmd = Command::new(&p);
            cmd.arg("--version");
            // On Unix, ensure we run from the binary's parent so its relative resources are found
            #[cfg(unix)]
            if let Some(parent) = p.parent() {
                cmd.current_dir(parent);
            }
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }

            if cmd.output().await.map_or(false, |o| o.status.success()) {
                return true;
            }
        }
    }

    // Fallback to system PATH for users who might have it installed via another method.
    let mut cmd = Command::new("aws");
    cmd.arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    cmd.status().await.map_or(false, |s| s.success())
}