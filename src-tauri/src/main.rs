// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod builder_blocks;
mod commands;
mod constants;
mod folder_sync;
mod substrate_client;
mod user_profile_sync;
mod user_storage_requests_sync;
mod utils;

use crate::folder_sync::{get_sync_status, start_folder_sync_tauri};
use crate::user_profile_sync::get_user_synced_files;
use crate::user_profile_sync::start_user_profile_sync_tauri;
use crate::user_storage_requests_sync::get_user_storage_requests;
use crate::user_storage_requests_sync::start_user_storage_requests_sync_tauri;
use builder_blocks::{on_window_event::on_window_event, setup::setup};
use commands::ipfs_commands::{
    download_and_decrypt_file, encrypt_and_upload_file, read_file, write_file,
    encrypt_and_upload_folder, list_folder_contents, download_and_decrypt_folder,
};
use commands::node::{get_current_setup_phase, start_ipfs_daemon, stop_ipfs_daemon};
use commands::substrate_tx::{get_sync_path, storage_request_tauri, storage_unpin_request_tauri};
use dirs;
use once_cell::sync::OnceCell;
use sqlx::sqlite::SqlitePool;
use tauri::{Builder, Manager};

pub static DB_POOL: OnceCell<SqlitePool> = OnceCell::new();

fn main() {
    sodiumoxide::init().unwrap();
    println!("[Main] Application starting...");

    let builder = Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            start_ipfs_daemon,
            stop_ipfs_daemon,
            get_current_setup_phase,
            encrypt_and_upload_file,
            download_and_decrypt_file,
            write_file,
            read_file,
            encrypt_and_upload_folder,
            list_folder_contents,
            download_and_decrypt_folder,
            storage_request_tauri,
            storage_unpin_request_tauri,
            get_sync_path,
            start_user_profile_sync_tauri,
            start_folder_sync_tauri,
            get_user_synced_files,
            start_user_storage_requests_sync_tauri,
            get_user_storage_requests,
            get_sync_status
        ]);

    let builder = setup(builder);
    let builder = on_window_event(builder);

    println!("[Main] Running Tauri application...");
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
