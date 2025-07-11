// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod builder_blocks;
mod commands;
mod constants;
mod utils;
mod substrate_client;
mod user_profile_sync;
mod folder_sync;
mod user_storage_requests_sync;

use builder_blocks::{on_window_event::on_window_event, setup::setup};
use commands::node::{get_current_setup_phase, start_ipfs_daemon, stop_ipfs_daemon};
use commands::ipfs_commands::{download_and_decrypt_file, encrypt_and_upload_file, write_file, read_file};
use commands::substrate_tx::{storage_request_tauri, storage_unpin_request_tauri,get_sync_path};
use sqlx::sqlite::SqlitePool;
use once_cell::sync::OnceCell;
use dirs;
use tauri::{Manager, Builder};
use crate::user_profile_sync::start_user_profile_sync_tauri;
use crate::user_profile_sync::get_user_synced_files;
use crate::folder_sync::start_folder_sync_tauri;
use crate::user_storage_requests_sync::start_user_storage_requests_sync_tauri;
use crate::user_storage_requests_sync::get_user_storage_requests;

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
            storage_request_tauri,
            storage_unpin_request_tauri,
            get_sync_path,
            start_user_profile_sync_tauri,
            start_folder_sync_tauri,
            get_user_synced_files,
            start_user_storage_requests_sync_tauri,
            get_user_storage_requests
        ]);

    let builder = setup(builder);
    let builder = on_window_event(builder);

    println!("[Main] Running Tauri application...");
    builder.run(tauri::generate_context!())
        .expect("error while running tauri application");
}
