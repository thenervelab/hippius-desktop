// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod builder_blocks;
mod commands;
mod constants;
mod folder_sync;
mod public_folder_sync;
mod substrate_client;
mod user_profile_sync;
mod sync_shared;
mod utils;
mod ipfs;

use crate::sync_shared::{get_sync_status, app_close};
use crate::folder_sync::{start_folder_sync_tauri};
use crate::public_folder_sync::start_public_folder_sync_tauri;
use crate::user_profile_sync::{get_user_synced_files, get_user_total_file_size};
use crate::user_profile_sync::start_user_profile_sync_tauri;
use crate::ipfs::{get_ipfs_node_info, get_ipfs_bandwidth, get_ipfs_peers};
use crate::commands::syncing::{initialize_sync, cleanup_sync, AppState, SyncState};
use builder_blocks::{on_window_event::on_window_event, setup::setup};
use commands::ipfs_commands::{
    download_and_decrypt_file, encrypt_and_upload_file, read_file, write_file,
    upload_file_public, download_file_public, public_download_with_erasure, public_upload_with_erasure,
    encrypt_and_upload_folder, download_and_decrypt_folder, public_download_folder, public_upload_folder, list_folder_contents,
    remove_file_from_public_folder, add_file_to_public_folder, remove_file_from_private_folder, add_file_to_private_folder
};
use commands::accounts::{create_encryption_key, get_encryption_keys, import_key};
use utils::file_operations::delete_and_unpin_file_by_name;
use commands::node::{get_current_setup_phase, start_ipfs_daemon, stop_ipfs_daemon};
use commands::substrate_tx::{get_sync_path, set_sync_path, transfer_balance_tauri, get_wss_endpoint, update_wss_endpoint_command, test_wss_endpoint_command};
use once_cell::sync::OnceCell;
use sqlx::sqlite::SqlitePool;
use tauri::{Builder, Manager};
use tokio::sync::Mutex;
use std::sync::Arc;

pub static DB_POOL: OnceCell<SqlitePool> = OnceCell::new();

fn main() {
    sodiumoxide::init().unwrap();
    println!("[Main] Application starting...");

    let builder = Builder::default()
        .manage(Arc::new(AppState {
            sync: Mutex::new(SyncState::default()),
        })) // Register AppState
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            start_ipfs_daemon,
            stop_ipfs_daemon,
            get_current_setup_phase,
            encrypt_and_upload_file,
            download_and_decrypt_file,
            upload_file_public,
            download_file_public,
            write_file,
            read_file,
            get_sync_path,
            set_sync_path,
            start_user_profile_sync_tauri,
            start_folder_sync_tauri,
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
            public_download_with_erasure,
            public_upload_with_erasure,
            public_upload_folder,
            public_download_folder,
            encrypt_and_upload_folder,
            list_folder_contents,
            download_and_decrypt_folder,
            remove_file_from_public_folder,
            add_file_to_public_folder,
            remove_file_from_private_folder,
            add_file_to_private_folder,
            create_encryption_key,
            get_encryption_keys,
            import_key,
            transfer_balance_tauri,
            get_user_total_file_size,
            get_wss_endpoint,
            update_wss_endpoint_command,
            test_wss_endpoint_command
        ]);

    let builder = setup(builder);
    let builder = on_window_event(builder);

    println!("[Main] Running Tauri application...");
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}