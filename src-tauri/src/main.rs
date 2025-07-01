// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod builder_blocks;
mod commands;
mod constants;
mod utils;

use builder_blocks::{on_window_event::on_window_event, setup::setup};
use commands::node::{get_current_setup_phase, start_ipfs_daemon, stop_ipfs_daemon};
use utils::binary::{download_and_decrypt_file, encrypt_and_upload_file, write_file};

fn main() {
    sodiumoxide::init().unwrap();
    let builder = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            start_ipfs_daemon,
            stop_ipfs_daemon,
            get_current_setup_phase,
            encrypt_and_upload_file,
            download_and_decrypt_file,
            write_file,
        ]);
    let builder = setup(builder);
    let builder = on_window_event(builder);
    builder.run(tauri::generate_context!())
        .expect("error while running tauri application");
}