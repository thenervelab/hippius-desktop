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
use crate::sync_shared::{app_close, get_sync_status,get_sync_activity};
use crate::user_profile_sync::{get_user_synced_files, get_user_total_file_size};
use builder_blocks::{on_window_event::on_window_event, setup::setup};
use commands::accounts::{
    create_encryption_key, export_app_data, get_encryption_keys, import_app_data, import_key,
    reset_app,
};
use commands::ipfs_commands::{
    download_and_decrypt_file, encrypt_and_upload_file, read_file, write_file,
    upload_file_public, download_file_public, 
    encrypt_and_upload_folder, download_and_decrypt_folder, public_download_folder, public_upload_folder, list_folder_contents,
    remove_file_from_public_folder, add_file_to_public_folder, remove_file_from_private_folder, add_file_to_private_folder, add_folder_to_public_folder,
    remove_folder_from_public_folder, add_folder_to_private_folder, remove_folder_from_private_folder
};
use utils::file_operations::delete_and_unpin_file_by_name;
use commands::node::{get_current_setup_phase, start_ipfs_daemon, stop_ipfs_daemon, reset_aws_installation_state};
use commands::substrate_tx::{
    get_sync_path, get_wss_endpoint, set_sync_path, test_wss_endpoint_command,
    transfer_balance_tauri, update_wss_endpoint_command,
};
use once_cell::sync::OnceCell;
use sqlx::sqlite::SqlitePool;
use std::sync::Arc;
use tauri::{AppHandle, Builder, Manager};
use tokio::sync::Mutex;

// Register the new  Tauri command so the frontend can invoke it.
pub static DB_POOL: OnceCell<SqlitePool> = OnceCell::new();

fn main() {
    sodiumoxide::init().unwrap();
    println!("[Main] Application starting...");

    let builder = Builder::default()
        .manage(Arc::new(AppState {
            sync: Mutex::new(SyncState::default()),
        }))
        // Remove tauri_plugin_process unless you specifically need it
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            println!("Another instance attempted to start");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            start_ipfs_daemon,
            stop_ipfs_daemon,
            get_current_setup_phase,
            reset_aws_installation_state,
            encrypt_and_upload_file,
            download_and_decrypt_file,
            upload_file_public,
            download_file_public,
            write_file,
            read_file,
            get_sync_path,
            set_sync_path,
            start_private_folder_sync_tauri,
            start_public_folder_sync_tauri,
            cleanup_sync,
            get_user_synced_files,
            get_sync_status,
            get_ipfs_node_info,
            get_ipfs_bandwidth,
            get_ipfs_peers,
            app_close,
            initialize_sync,
            delete_and_unpin_file_by_name,
            public_upload_folder,
            public_download_folder,
            encrypt_and_upload_folder,
            list_folder_contents,
            download_and_decrypt_folder,
            remove_file_from_public_folder,
            reset_app,
            add_file_to_public_folder,
            remove_file_from_private_folder,
            add_file_to_private_folder,
            create_encryption_key,
            get_encryption_keys,
            import_key,
            import_app_data,
            export_app_data,
            transfer_balance_tauri,
            get_user_total_file_size,
            get_wss_endpoint,
            update_wss_endpoint_command,
            test_wss_endpoint_command,
            add_folder_to_public_folder,
            remove_folder_from_public_folder,
            add_folder_to_private_folder,
            remove_folder_from_private_folder,
            get_sync_activity
        ]);

    let builder = setup(builder);
    let builder = on_window_event(builder);

    println!("[Main] Running Tauri application...");
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}