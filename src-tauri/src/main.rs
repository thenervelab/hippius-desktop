// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Modules are now in lib.rs
use tauri_project_lib::{
    builder_blocks, commands, constants, events, ipfs, macos_bookmarks,
    private_folder_sync, public_folder_sync, substrate_client, sync_engine,
    sync_shared, user_profile_sync, utils, DB_POOL
};

use tauri_project_lib::commands::syncing::{
    AppState, SyncState, cleanup_sync, get_bucket_policy, initialize_sync, set_bucket_policy,
    stop_sync_for_scope_command,
};

use tauri_project_lib::ipfs::{get_ipfs_bandwidth, get_ipfs_node_info, get_ipfs_peers};
use tauri_project_lib::private_folder_sync::start_private_folder_sync_tauri;
use tauri_project_lib::public_folder_sync::start_public_folder_sync_tauri;
use tauri_project_lib::sync_shared::{app_close, get_sync_activity};
use tauri_project_lib::user_profile_sync::{get_user_synced_files, get_user_total_file_size};
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
// DB_POOL is now in lib.rs

fn main() {
    sodiumoxide::init().unwrap();
    println!("[Main] Application starting...");

    // Stop any running sync processes from previous instances
    println!("[Main] Stopping any running sync processes...");
    tauri_project_lib::sync_shared::stop_all_sync_processes();

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
            tauri_project_lib::commands::ipfs_commands::encrypt_and_upload_file,
            tauri_project_lib::commands::ipfs_commands::download_and_decrypt_file,
            tauri_project_lib::commands::ipfs_commands::upload_file_public,
            tauri_project_lib::commands::ipfs_commands::download_file_public,
            tauri_project_lib::commands::ipfs_commands::write_file,
            tauri_project_lib::commands::ipfs_commands::delete_file,
            tauri_project_lib::commands::ipfs_commands::read_file,
            tauri_project_lib::commands::substrate_tx::get_sync_path,
            tauri_project_lib::commands::substrate_tx::set_sync_path,
            tauri_project_lib::private_folder_sync::start_private_folder_sync_tauri,
            tauri_project_lib::public_folder_sync::start_public_folder_sync_tauri,
            tauri_project_lib::commands::syncing::cleanup_sync,
            tauri_project_lib::user_profile_sync::get_user_synced_files,
            tauri_project_lib::ipfs::get_ipfs_node_info,
            tauri_project_lib::ipfs::get_ipfs_bandwidth,
            tauri_project_lib::ipfs::get_ipfs_peers,
            tauri_project_lib::sync_shared::app_close,
            tauri_project_lib::commands::syncing::initialize_sync,
            tauri_project_lib::utils::file_operations::delete_and_unpin_file_by_name,
            tauri_project_lib::commands::ipfs_commands::public_upload_folder,
            tauri_project_lib::commands::ipfs_commands::public_download_folder,
            tauri_project_lib::commands::ipfs_commands::encrypt_and_upload_folder,
            tauri_project_lib::commands::ipfs_commands::list_folder_contents,
            tauri_project_lib::commands::ipfs_commands::download_and_decrypt_folder,
            tauri_project_lib::commands::ipfs_commands::remove_file_from_public_folder,
            tauri_project_lib::commands::accounts::reset_app,
            tauri_project_lib::commands::accounts::get_all_subaccount_addresses,
            tauri_project_lib::commands::ipfs_commands::add_file_to_public_folder,
            tauri_project_lib::commands::ipfs_commands::remove_file_from_private_folder,
            tauri_project_lib::commands::ipfs_commands::add_file_to_private_folder,
            tauri_project_lib::commands::accounts::create_encryption_key,
            tauri_project_lib::commands::accounts::get_encryption_keys,
            tauri_project_lib::commands::accounts::import_key,
            tauri_project_lib::commands::ipfs_commands::wipe_s3_objects,
            tauri_project_lib::commands::accounts::import_app_data,
            tauri_project_lib::commands::accounts::export_app_data,
            tauri_project_lib::commands::substrate_tx::transfer_balance_tauri,
            tauri_project_lib::user_profile_sync::get_user_total_file_size,
            tauri_project_lib::commands::substrate_tx::get_wss_endpoint,
            tauri_project_lib::commands::substrate_tx::update_wss_endpoint_command,
            tauri_project_lib::commands::ipfs_commands::add_folder_to_public_folder,
            tauri_project_lib::commands::ipfs_commands::remove_folder_from_public_folder,
            tauri_project_lib::commands::ipfs_commands::add_folder_to_private_folder,
            tauri_project_lib::commands::ipfs_commands::remove_folder_from_private_folder,
            tauri_project_lib::sync_shared::get_sync_activity,
            tauri_project_lib::commands::syncing::stop_sync_for_scope_command,
            tauri_project_lib::commands::syncing::set_bucket_policy,
            tauri_project_lib::commands::syncing::get_bucket_policy,
            tauri_project_lib::utils::nebula::get_nebula_version,
            tauri_project_lib::utils::nebula::check_nebula_update,
            tauri_project_lib::commands::objectstore_auth::save_temp_auth_key_command,
            tauri_project_lib::commands::objectstore_auth::has_master_token_command,
            tauri_project_lib::commands::objectstore_auth::request_master_token_command
        ]);

    let builder = setup(builder);
    let builder = on_window_event(builder);

    println!("[Main] Running Tauri application...");
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
