use crate::commands::node::stop_ipfs_daemon;
use tauri::{Builder, Manager, Wry};

pub fn on_window_event(builder: Builder<Wry>) -> Builder<Wry> {
    builder.on_window_event(|window, event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            println!("[Window] Close requested");
            api.prevent_close();
            let app_handle = window.app_handle().clone();
            
            tauri::async_runtime::spawn(async move {
                println!("[Window] Stopping IPFS daemon...");
                stop_ipfs_daemon().await;
                println!("[Window] Exiting application...");
                app_handle.exit(0);
            });
        }
        _ => {}
    })
}