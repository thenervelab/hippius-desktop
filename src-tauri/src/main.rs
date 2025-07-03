// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod builder_blocks;
mod commands;
mod constants;
mod utils;

use builder_blocks::{on_window_event::on_window_event, setup::setup};
use commands::node::{get_current_setup_phase, start_ipfs_daemon, stop_ipfs_daemon};

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            start_ipfs_daemon,
            stop_ipfs_daemon,
            get_current_setup_phase
        ]);

    let builder = setup(builder);
    let builder = on_window_event(builder);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
