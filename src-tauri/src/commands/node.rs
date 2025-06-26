use once_cell::sync::OnceCell;
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};

use crate::constants::ipfs::{IpfsProgress, IPFS_NODE_SETUP_EVENT};
use crate::utils::binary::ensure_ipfs_binary;

static IPFS_HANDLE: OnceCell<Mutex<Option<tokio::process::Child>>> = OnceCell::new();

#[tauri::command]
pub async fn start_ipfs_daemon(app: AppHandle) -> Result<(), String> {
    app.emit(IPFS_NODE_SETUP_EVENT, IpfsProgress::CheckingBinary)
        .unwrap_or_else(|e| eprintln!("Emit failed: {e}"));

    let bin_path = ensure_ipfs_binary()
        .await
        .map_err(|e| format!("Binary fetch failed: {e}"))?;

    app.emit(IPFS_NODE_SETUP_EVENT, IpfsProgress::StartingDaemon)
        .unwrap_or_else(|e| eprintln!("Emit failed: {e}"));

    let mut child = Command::new(bin_path)
        .arg("daemon")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Spawn failed: {e}"))?;

    // Optional: monitor stdout
    let stdout = child.stdout.take().unwrap();
    let app_clone = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            println!("[ipfs stdout] {}", line);
            if line.contains("Swarm listening on") {
                app_clone
                    .emit(IPFS_NODE_SETUP_EVENT, IpfsProgress::ConnectingToNetwork)
                    .ok();
            }

            if line.contains("Daemon is ready") || line.contains("API server listening") {
                app_clone
                    .emit(IPFS_NODE_SETUP_EVENT, IpfsProgress::Ready)
                    .ok();
            }
        }
    });

    IPFS_HANDLE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .await
        .replace(child);

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
