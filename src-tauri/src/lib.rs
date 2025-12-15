use once_cell::sync::OnceCell;
use sqlx::sqlite::SqlitePool;

pub mod sync_engine;
pub mod sync_shared;
pub mod constants;
pub mod utils;
pub mod user_profile_sync;
pub mod commands;
pub mod events;
pub mod substrate_client;
pub mod builder_blocks;
pub mod ipfs;
pub mod macos_bookmarks;
pub mod private_folder_sync;
pub mod public_folder_sync;

pub static DB_POOL: OnceCell<SqlitePool> = OnceCell::new();

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
