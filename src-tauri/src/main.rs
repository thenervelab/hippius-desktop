// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod blocks;

use crate::blocks::system_tray::add_system_tray;

fn main() {
    let builder = tauri::Builder::default();

    let builder = add_system_tray(builder);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
