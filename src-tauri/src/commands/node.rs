use once_cell::sync::OnceCell;
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};

use crate::constants::ipfs::{AppSetupPhase, APP_SETUP_EVENT};
use crate::utils::binary::ensure_ipfs_binary;
use std::time::Duration;
use tokio::time::sleep;

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

#[tauri::command]
pub async fn start_ipfs_daemon(app: AppHandle) -> Result<(), String> {
    let app = emit_and_update_phase(app, AppSetupPhase::CheckingBinary).await;

    let bin_path = ensure_ipfs_binary()
        .await
        .map_err(|e| format!("Binary fetch failed: {e}"))?;

    sleep(Duration::from_secs(8)).await;

    let app = emit_and_update_phase(app, AppSetupPhase::StartingDaemon).await;

    let mut child = Command::new(bin_path)
        .arg("daemon")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Spawn failed: {e}"))?;

    let stdout = child.stdout.take().unwrap();

    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            println!("[ipfs stdout] {}", line);
            if line.contains("Swarm listening on") {
                sleep(Duration::from_secs(8)).await;
                emit_and_update_phase(app.clone(), AppSetupPhase::ConnectingToNetwork).await;
            }

            if line.contains("Daemon is ready") || line.contains("API server listening") {
                sleep(Duration::from_secs(8)).await;
                emit_and_update_phase(app.clone(), AppSetupPhase::Ready).await;
            }
        }
    });

    let mutex = IPFS_HANDLE.get_or_init(|| Mutex::new(None));
    let mut guard = mutex.lock().await;
    guard.replace(child);

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
