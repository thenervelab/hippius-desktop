// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod builder_blocks;
mod commands;
mod constants;
mod events;
mod hcfs_drive;
mod ipfs;
mod macos_bookmarks;
mod substrate_client;
mod sync_shared;
mod user_profile_sync;
mod utils;

use crate::commands::syncing::{initialize_sync, stop_sync, trigger_sync_now};
use crate::ipfs::{get_ipfs_bandwidth, get_ipfs_node_info, get_ipfs_peers};
use crate::sync_shared::{app_close, get_sync_activity, get_sync_status};
use crate::user_profile_sync::{get_user_synced_files, get_user_total_file_size};
use builder_blocks::{on_window_event::on_window_event, setup::setup};
use commands::accounts::{
    export_app_data, get_all_subaccount_addresses, import_app_data, reset_app,
};
use commands::file_commands::{add_file, add_folder, export_file, list_sync_folder, remove_file};
use commands::objectstore_auth::{
    has_master_token_command, request_master_token_command, save_temp_auth_key_command,
};
use commands::substrate_tx::{
    get_sync_path, get_wss_endpoint, set_sync_path, transfer_balance_tauri,
    update_wss_endpoint_command,
};
use once_cell::sync::OnceCell;
use sqlx::sqlite::SqlitePool;
use tauri::{Builder, Manager};

pub static DB_POOL: OnceCell<SqlitePool> = OnceCell::new();

fn load_env() {
    let _ = dotenvy::dotenv();
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let env_path = format!("{}/.env", manifest_dir);
    let _ = dotenvy::from_filename(env_path);
}

fn main() {
    load_env();
    println!("[Main] Application starting...");

    let builder = Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            println!(
                "[SingleInstance] Another instance attempted to start with argv: {:?}",
                argv
            );
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            // Sync control (hcfs-client)
            initialize_sync,
            stop_sync,
            trigger_sync_now,
            // Sync status
            get_sync_status,
            get_sync_activity,
            // File operations
            add_file,
            add_folder,
            remove_file,
            list_sync_folder,
            export_file,
            // App lifecycle
            app_close,
            // Substrate / blockchain
            get_sync_path,
            set_sync_path,
            transfer_balance_tauri,
            get_wss_endpoint,
            update_wss_endpoint_command,
            // Account management
            reset_app,
            get_all_subaccount_addresses,
            import_app_data,
            export_app_data,
            // User profile sync (blockchain)
            get_user_synced_files,
            get_user_total_file_size,
            // IPFS info
            get_ipfs_node_info,
            get_ipfs_bandwidth,
            get_ipfs_peers,
            // VPN / Nebula
            utils::nebula::get_nebula_version,
            utils::nebula::check_nebula_update,
            utils::nebula::get_nebula_ip,
            utils::nebula::get_nebula_stats,
            utils::nebula::get_nebula_status,
            utils::nebula::get_nebula_binary_installed_status,
            commands::vpn_enabled::get_vpn_status,
            commands::vpn_enabled::toggle_vpn_status,
            commands::vpn_enabled::get_autoconnect_status,
            commands::vpn_enabled::toggle_autoconnect_status,
            utils::nebula::check_nebula_requirements,
            utils::nebula::download_nebula,
            utils::nebula::install_nebula,
            utils::nebula::verify_nebula,
            utils::nebula::finish_setup,
            utils::nebula::start_nebula,
            // Indexer
            commands::indexer::get_indexer_api_key,
            // Object store auth
            save_temp_auth_key_command,
            has_master_token_command,
            request_master_token_command,
            // HCFS config commands
            commands::syncing::save_hcfs_config,
            commands::syncing::get_hcfs_config,
        ]);

    let builder = setup(builder);
    let builder = on_window_event(builder);

    println!("[Main] Running Tauri application...");
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
