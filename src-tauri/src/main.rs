// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod builder_blocks;
mod commands;
mod constants;
mod events;
mod private_folder_sync;
mod ipfs;
mod public_folder_sync;
mod substrate_client;
mod sync_shared;
mod user_profile_sync;
mod utils;

use crate::commands::syncing::{cleanup_sync, initialize_sync, AppState, SyncState};
use crate::private_folder_sync::start_private_folder_sync_tauri;
use crate::ipfs::{get_ipfs_bandwidth, get_ipfs_node_info, get_ipfs_peers};
use crate::public_folder_sync::start_public_folder_sync_tauri;
use crate::sync_shared::{app_close, get_sync_status, get_sync_activity};
use crate::user_profile_sync::{get_user_synced_files, get_user_total_file_size};
use builder_blocks::{on_window_event::on_window_event, setup::setup};
use commands::accounts::{
    create_encryption_key, export_app_data, get_encryption_keys, import_app_data, import_key,
    reset_app,
};
use commands::ipfs_commands::{
    download_and_decrypt_file, encrypt_and_upload_file, read_file, write_file, delete_file,
    upload_file_public, download_file_public, wipe_s3_objects,
    encrypt_and_upload_folder, download_and_decrypt_folder, public_download_folder, public_upload_folder, list_folder_contents,
    remove_file_from_public_folder, add_file_to_public_folder, remove_file_from_private_folder, add_file_to_private_folder, add_folder_to_public_folder,
    remove_folder_from_public_folder, add_folder_to_private_folder, remove_folder_from_private_folder
};
use utils::file_operations::delete_and_unpin_file_by_name;
use commands::node::{get_current_setup_phase, start_ipfs_daemon, stop_ipfs_daemon};
use commands::substrate_tx::{
    get_sync_path, get_wss_endpoint, set_sync_path, test_wss_endpoint_command,
    transfer_balance_tauri, update_wss_endpoint_command,
};
use once_cell::sync::OnceCell;
use sqlx::sqlite::SqlitePool;
use std::sync::Arc;
use tauri::{Builder, Manager, Emitter}; // Add the Emitter trait
use tokio::sync::Mutex;
use std::sync::Mutex as StdMutex;

// Define our state structure for tracking sync status
struct TrayState {
    sync_percent: Option<u8>,
    recent_files: Vec<(String, String)>,
}

impl Default for TrayState {
    fn default() -> Self {
        Self {
            sync_percent: None,
            recent_files: Vec::new(),
        }
    }
}

// Register the new Tauri command so the frontend can invoke it.
pub static DB_POOL: OnceCell<SqlitePool> = OnceCell::new();

// Command to update sync status
#[tauri::command]
async fn update_tray_sync_status(
    app_handle: tauri::AppHandle, 
    percent: Option<u8>
) -> Result<(), String> {
    // Update state
    let state = app_handle.state::<Arc<StdMutex<TrayState>>>();
    if let Ok(mut state) = state.lock() {
        state.sync_percent = percent;
    }
    
    // Update window title to reflect sync status
    if let Some(main_window) = app_handle.get_webview_window("main") {
        let title = if let Some(100) = percent {
            "Hippius - Sync Complete".to_string()
        } else if let Some(p) = percent {
            format!("Hippius - Syncing {}%", p)
        } else {
            "Hippius".to_string()
        };
        
        let _ = main_window.set_title(&title);
    }
    
    // Update status window with sync information
    if let Some(status_window) = app_handle.get_webview_window("status-window") {
        let status = match percent {
            Some(100) => serde_json::json!({"status": "completed", "percent": 100}),
            Some(p) => serde_json::json!({"status": "syncing", "percent": p}),
            None => serde_json::json!({"status": "idle", "percent": null}),
        };
        
        // Use the emit method from the Emitter trait
        let _ = status_window.emit("sync-update", status);
    }
    
    // Update tray icon or notification here if needed
    
    println!("[Tray] Sync status updated: {:?}", percent);
    Ok(())
}

#[tauri::command]
async fn update_tray_files(
    app_handle: tauri::AppHandle,
    files: Vec<(String, String)>,
) -> Result<(), String> {
    // Store files in state
    let state = app_handle.state::<Arc<StdMutex<TrayState>>>();
    if let Ok(mut state) = state.lock() {
        state.recent_files = files.clone();
    }
    
    // Update status window with files information
    if let Some(status_window) = app_handle.get_webview_window("status-window") {
        let files_data = serde_json::json!({ "files": files });
        
        // Use the emit method from the Emitter trait
        let _ = status_window.emit("files-update", files_data);
    }
    
    // Update tray icon or notification here if needed
    
    println!("[Tray] Files updated: {} items", files.len());
    Ok(())
}

// Command to toggle main window visibility
#[tauri::command]
async fn toggle_main_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    Ok(())
}

// Command to quit the application
#[tauri::command]
async fn quit_app(app_handle: tauri::AppHandle) -> Result<(), String> {
    // Change emit_all to emit
    app_handle.emit("app-exit-requested", ()).unwrap_or_default();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        app_handle.exit(0);
    });
    Ok(())
}

fn main() {
    // Force logs to standard output regardless of release mode
    #[cfg(not(debug_assertions))]
    {
        use std::io::Write;
        let stdout = std::io::stdout();
        let stderr = std::io::stderr();
        let _ = stdout.lock().flush();
        let _ = stderr.lock().flush();
    }

    // Add timestamp to make logs easier to follow
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default().as_secs();
    
    eprintln!("[{now}] === APPLICATION STARTING ===");
    println!("[{now}] === APPLICATION STARTING ===");
    
    sodiumoxide::init().unwrap();
    println!("[{now}] [Main] Application starting...");

    // Also log to a file for debugging
    let log_path = std::env::temp_dir().join("hippius-debug.log");
    eprintln!("[{now}] Writing logs to: {:?}", log_path);
    
    let log_message = format!("[{now}] Application starting\n");
    if let Err(e) = std::fs::write(&log_path, log_message) {
        eprintln!("[{now}] Failed to write to log file: {}", e);
    }

    // Create and manage the app
    let tray_state = Arc::new(StdMutex::new(TrayState::default()));

    // Clone log_path for the closure
    let log_path_clone = log_path.clone();

    let builder = Builder::default()
        .manage(Arc::new(AppState {
            sync: Mutex::new(SyncState::default()),
        }))
        .manage(tray_state)
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            println!("Another instance attempted to start");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            eprintln!("!!! SETUP FUNCTION CALLED !!!");
            println!("!!! SETUP FUNCTION CALLED !!!");

            // CRITICAL: Create a direct HTML window that should definitely work
            let html_content = r#"
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body {
                        background-color: #FF0000;
                        color: white;
                        font-family: sans-serif;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        height: 100vh;
                        margin: 0;
                        padding: 20px;
                        box-sizing: border-box;
                        text-align: center;
                    }
                    h1 { font-size: 24px; margin-bottom: 20px; }
                    .buttons {
                        display: flex;
                        gap: 10px;
                        margin-top: 20px;
                    }
                    button {
                        padding: 10px 20px;
                        background: white;
                        color: black;
                        border: none;
                        border-radius: 4px;
                        font-weight: bold;
                        cursor: pointer;
                    }
                </style>
            </head>
            <body>
                <h1>HIPPIUS STATUS WINDOW</h1>
                <div>Sync Status: <span id="status">Idle</span></div>
                <div class="buttons">
                    <button id="show-btn">Show Main</button>
                    <button id="quit-btn">Quit App</button>
                </div>
                <script>
                    // Add immediate visual indication
                    document.body.innerHTML += "<p>Window loaded at: " + new Date().toISOString() + "</p>";
                    
                    const { invoke } = window.__TAURI__.core;
                    
                    document.getElementById('show-btn').addEventListener('click', () => {
                        invoke('toggle_main_window');
                    });
                    
                    document.getElementById('quit-btn').addEventListener('click', () => {
                        invoke('quit_app');
                    });
                </script>
            </body>
            </html>
            "#;

            eprintln!("!!! CREATING DIRECT HTML WINDOW !!!");
            println!("!!! CREATING DIRECT HTML WINDOW !!!");
            
            // Try to create a window with inline HTML content
            match tauri::WebviewWindowBuilder::new(
                app,
                "direct-html-window", 
                tauri::WebviewUrl::External(url::Url::parse(&format!("data:text/html;charset=utf-8,{}", urlencoding::encode(html_content))).unwrap())
            )
            .title("Hippius Status")
            .inner_size(400.0, 300.0)
            .always_on_top(true)
            .resizable(false)
            .skip_taskbar(false)
            .decorations(true)  // Keep decorations for visibility
            .center()
            .build() {
                Ok(window) => {
                    eprintln!("!!! DIRECT HTML WINDOW CREATED SUCCESSFULLY !!!");
                    println!("!!! DIRECT HTML WINDOW CREATED SUCCESSFULLY !!!");
                    
                    // Ensure the window is visible
                    if let Err(e) = window.show() {
                        eprintln!("!!! FAILED TO SHOW WINDOW: {:?} !!!", e);
                    }
                    
                    // Position at bottom-right
                    if let Some(monitor) = window.current_monitor().ok().flatten() {
                        let size = monitor.size();
                        let pos = monitor.position();
                        let x = pos.x + size.width as i32 - 400;
                        let y = pos.y + size.height as i32 - 300;
                        if let Err(e) = window.set_position(tauri::Position::Physical(
                            tauri::PhysicalPosition { x, y }
                        )) {
                            eprintln!("!!! FAILED TO POSITION WINDOW: {:?} !!!", e);
                        }
                    }
                },
                Err(e) => {
                    eprintln!("!!! FAILED TO CREATE DIRECT HTML WINDOW: {:?} !!!", e);
                    println!("!!! FAILED TO CREATE DIRECT HTML WINDOW: {:?} !!!", e);
                },
            }
            
            // Continue with existing setup...
            // ... existing window creation code ...

            Ok(())
        });

    // ... existing code ...
}