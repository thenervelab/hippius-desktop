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
use tokio::net::TcpStream;
use tokio::time::timeout;
use reqwest::Client;

static IPFS_HANDLE: OnceCell<Mutex<Option<tokio::process::Child>>> = OnceCell::new();

static CURRENT_SETUP_PHASE: OnceCell<Mutex<Option<AppSetupPhase>>> = OnceCell::new();

async fn emit_and_update_phase(app: AppHandle, phase: AppSetupPhase) -> AppHandle {
    let mutex = CURRENT_SETUP_PHASE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .await;

    {
        // Replace inside a block so the borrow ends before emit
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

// Helper to spawn IPFS commands with correct flags (no terminal popups on Windows)
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
    match response {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

#[tauri::command]
pub async fn start_ipfs_daemon(app: AppHandle) -> Result<(), String> {
    // Check if IPFS daemon is already running
    if IPFS_HANDLE.get().is_some() {
        let mutex = IPFS_HANDLE.get().unwrap();
        let guard = mutex.lock().await;
        if guard.is_some() {
            println!("[IPFS] Daemon already running, skipping start");
            return Ok(());
        }
    }

    // If a daemon is already running (e.g., from another process), skip starting a new one
    if is_ipfs_api_up().await {
        println!("[IPFS] Existing IPFS daemon detected on {}. Skipping start.", API_URL);
        emit_and_update_phase(app.clone(), AppSetupPhase::Ready).await;
        return Ok(());
    }

    sleep(Duration::from_secs(LARGE_SLEEP)).await;
    let app = emit_and_update_phase(app, AppSetupPhase::CheckingBinary).await;
    sleep(Duration::from_secs(SMALL_SLEEP)).await;

    let bin_path = ensure_ipfs_binary(app.clone())
        .await
        .map_err(|e| format!("Binary fetch failed: {e}"))?;

    let app = emit_and_update_phase(app, AppSetupPhase::InitializingRepo).await;
    crate::utils::binary::ensure_ipfs_repo_initialized(&bin_path)
        .map_err(|e| format!("IPFS repo init failed: {e}"))?;

    let app = emit_and_update_phase(app, AppSetupPhase::ConfiguringCors).await;
    configure_ipfs_cors(&bin_path).await?;
    sleep(Duration::from_secs(SMALL_SLEEP)).await;

    let app = emit_and_update_phase(app, AppSetupPhase::StartingDaemon).await;

    let mut cmd = spawn_ipfs_command(&bin_path, &["daemon"]);

    #[cfg(windows)]
    {
        cmd.stdin(Stdio::null())
           .stdout(Stdio::piped())
           .stderr(Stdio::piped());
    }
    
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.stdin(Stdio::null())
           .stdout(Stdio::piped())
           .stderr(Stdio::piped());
    }

    let mut child = cmd.spawn()
        .map_err(|e| format!("Spawn failed: {e}"))?;

    let stdout = child.stdout.take().unwrap();

    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            println!("[ipfs stdout] {}", line);

            if line.contains("Swarm listening on") {
                emit_and_update_phase(app.clone(), AppSetupPhase::ConnectingToNetwork).await;
            }

            if line.contains("Daemon is ready") || line.contains("API server listening") {
                sleep(Duration::from_secs(SMALL_SLEEP)).await;
                emit_and_update_phase(app.clone(), AppSetupPhase::InitialisingDatabase).await;
                sleep(Duration::from_secs(SMALL_SLEEP)).await;
                emit_and_update_phase(app.clone(), AppSetupPhase::SyncingData).await;
                sleep(Duration::from_secs(SMALL_SLEEP)).await;
                emit_and_update_phase(app.clone(), AppSetupPhase::Ready).await;
            }
        }
    });

    let mutex = IPFS_HANDLE.get_or_init(|| Mutex::new(None));
    let mut guard = mutex.lock().await;
    guard.replace(child);

    Ok(())
}

async fn configure_ipfs_cors(bin_path: &std::path::PathBuf) -> Result<(), String> {
    // First ensure no daemon is running
    let _ = spawn_ipfs_command(bin_path, &["shutdown"]).output().await;

    let cors_config = vec![
        ("Access-Control-Allow-Origin", "[\"http://localhost:3000\"]"),
        (
            "Access-Control-Allow-Methods",
            "[\"PUT\", \"GET\", \"POST\", \"OPTIONS\"]",
        ),
        ("Access-Control-Allow-Headers", "[\"Authorization\"]"),
    ];

    for (header, value) in cors_config {
        let output = spawn_ipfs_command(bin_path, &["config", "--json", &format!("API.HTTPHeaders.{}", header), value]).output().await.map_err(|e| format!("Failed to set CORS header {}: {}", header, e))?;

        if !output.status.success() {
            eprintln!(
                "Failed to set CORS header {}: {}",
                header,
                String::from_utf8_lossy(&output.stderr)
            );
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
