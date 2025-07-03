// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod builder_blocks;
mod commands;
mod constants;
mod utils;
mod substrate_client;
mod user_profile_sync;
mod folder_sync;

use builder_blocks::{on_window_event::on_window_event, setup::setup};
use commands::node::{get_current_setup_phase, start_ipfs_daemon, stop_ipfs_daemon};
use commands::ipfs_commands::{download_and_decrypt_file, encrypt_and_upload_file, write_file, read_file};
use sqlx::sqlite::SqlitePool;
use once_cell::sync::OnceCell;
use constants::substrate::DEFAULT_ACCOUNT_ID;
use dirs;

static DB_POOL: OnceCell<SqlitePool> = OnceCell::new();

#[tokio::main]
async fn main() {
    sodiumoxide::init().unwrap();

    // Use home directory with .hippius folder
    let home_dir = dirs::home_dir().expect("Failed to get home directory");
    let db_dir = home_dir.join(".hippius");
    let db_path = db_dir.join("hippius.db");
    println!("DB path: {}", db_path.display());

    // Ensure the .hippius directory exists
    std::fs::create_dir_all(&db_dir).expect("Failed to create .hippius directory");

    let db_url = format!("sqlite:{}", db_path.display());
    
    // Create database file if it doesn't exist
    if !db_path.exists() {
        std::fs::File::create(&db_path).expect("Failed to create database file");
    }

    let pool = SqlitePool::connect(&db_url).await.unwrap();
    DB_POOL.set(pool.clone()).unwrap();
    
    // Create table if it doesn't exist
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS user_profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL,
            cid TEXT NOT NULL,
            file_hash TEXT,
            file_name TEXT,
            file_size_in_bytes INTEGER,
            is_assigned BOOLEAN,
            last_charged_at INTEGER,
            main_req_hash TEXT,
            selected_validator TEXT,
            total_replicas INTEGER,
            block_number INTEGER NOT NULL,
            processed_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            profile_cid TEXT
        )"
    ).execute(&pool).await.unwrap();

    // Set up Tauri
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            start_ipfs_daemon,
            stop_ipfs_daemon,
            get_current_setup_phase,
            encrypt_and_upload_file,
            download_and_decrypt_file,
            write_file,
            read_file,
        ]);
    let builder = setup(builder);
    let builder = on_window_event(builder);

    // Start the user profile sync (background task)
    println!("[UserProfileSync] Sync loop started for account: {}", DEFAULT_ACCOUNT_ID);
    user_profile_sync::start_user_profile_sync(DEFAULT_ACCOUNT_ID);

    folder_sync::start_folder_sync();

    builder.run(tauri::generate_context!())
        .expect("error while running tauri application");
}