// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod builder_blocks;
mod commands;
mod constants;
mod events;
mod ipfs;
mod macos_bookmarks;
mod private_folder_sync;
mod public_folder_sync;
mod substrate_client;
mod sync_engine;
mod sync_shared;
mod user_profile_sync;
mod utils;

use crate::commands::syncing::{
    AppState, SyncState, cleanup_sync, get_bucket_policy, initialize_sync, set_bucket_policy,
    stop_sync_for_scope_command,
};
use crate::ipfs::{get_ipfs_bandwidth, get_ipfs_node_info, get_ipfs_peers};
use crate::private_folder_sync::start_private_folder_sync_tauri;
use crate::public_folder_sync::start_public_folder_sync_tauri;
use crate::sync_shared::{app_close, get_sync_activity};
use crate::user_profile_sync::{get_user_synced_files, get_user_total_file_size};
use builder_blocks::{on_window_event::on_window_event, setup::setup};
use commands::accounts::{
    create_encryption_key, export_app_data, get_all_subaccount_addresses, get_encryption_keys,
    import_app_data, import_key, reset_app,
};
use commands::objectstore_auth::{request_master_token_command, save_temp_auth_key_command, has_master_token_command};
use commands::ipfs_commands::{
    add_file_to_private_folder, add_file_to_public_folder, add_folder_to_private_folder,
    add_folder_to_public_folder, delete_file, download_and_decrypt_file,
    download_and_decrypt_folder, download_file_public, encrypt_and_upload_file,
    encrypt_and_upload_folder, list_folder_contents, public_download_folder, public_upload_folder,
    read_file, remove_file_from_private_folder, remove_file_from_public_folder,
    remove_folder_from_private_folder, remove_folder_from_public_folder, upload_file_public,
    wipe_s3_objects, write_file
};
use commands::substrate_tx::{
    get_sync_path, get_wss_endpoint, set_sync_path,
    transfer_balance_tauri, update_wss_endpoint_command,
};
use once_cell::sync::OnceCell;
use sqlx::sqlite::SqlitePool;
use std::sync::Arc;
use tauri::{Builder, Manager};
use tokio::sync::Mutex;
use utils::file_operations::delete_and_unpin_file_by_name;

// Register the new  Tauri command so the frontend can invoke it.
pub static DB_POOL: OnceCell<SqlitePool> = OnceCell::new();

fn main() {
    sodiumoxide::init().unwrap();
    println!("[Main] Application starting...");

    // Stop any running sync processes from previous instances
    println!("[Main] Stopping any running sync processes...");
    crate::sync_shared::stop_all_sync_processes();

    // Create app state
    let app_state = Arc::new(AppState {
        sync: Mutex::new(SyncState::default()),
    });

    let builder = Builder::default()
        .manage(app_state)
        // Remove tauri_plugin_process unless you specifically need it
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        // Single instance plugin with deep link integration - must be BEFORE deep_link plugin
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            println!("[SingleInstance] Another instance attempted to start with argv: {:?}", argv);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            encrypt_and_upload_file,
            download_and_decrypt_file,
            upload_file_public,
            download_file_public,
            write_file,
            delete_file,
            read_file,
            get_sync_path,
            set_sync_path,
            start_private_folder_sync_tauri,
            start_public_folder_sync_tauri,
            cleanup_sync,
            get_user_synced_files,
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
            get_all_subaccount_addresses,
            add_file_to_public_folder,
            remove_file_from_private_folder,
            add_file_to_private_folder,
            create_encryption_key,
            get_encryption_keys,
            import_key,
            wipe_s3_objects,
            import_app_data,
            export_app_data,
            transfer_balance_tauri,
            get_user_total_file_size,
            get_wss_endpoint,
            update_wss_endpoint_command,
            add_folder_to_public_folder,
            remove_folder_from_public_folder,
            add_folder_to_private_folder,
            remove_folder_from_private_folder,
            get_sync_activity,
            stop_sync_for_scope_command,
            set_bucket_policy,
            get_bucket_policy,
            utils::nebula::get_nebula_version,
            utils::nebula::check_nebula_update,
            utils::nebula::get_nebula_ip,
            utils::nebula::get_nebula_stats,
            utils::nebula::get_nebula_status,
            utils::nebula::get_nebula_binary_installed_status,
            commands::vpn_enabled::get_vpn_status,
            commands::vpn_enabled::toggle_vpn_status,
            utils::nebula::check_nebula_requirements,
            utils::nebula::download_nebula,
            utils::nebula::install_nebula,
            utils::nebula::verify_nebula,
            utils::nebula::finish_setup,
            utils::nebula::start_nebula,
        ]);

    let builder = setup(builder);
    let builder = on_window_event(builder);

    println!("[Main] Running Tauri application...");
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
