use tauri::{Builder,  Wry};
use crate::commands::node::stop_ipfs_daemon;

pub fn on_window_event(builder: Builder<Wry>) -> Builder<Wry> {
    builder.on_window_event(|window, event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            #[cfg(not(target_os = "macos"))]
            {
                window.hide().unwrap();
            }

            #[cfg(target_os = "macos")]
            {
                tauri::AppHandle::hide(&window.app_handle()).unwrap();
            }
            api.prevent_close();
            tauri::async_runtime::spawn(async {
                stop_ipfs_daemon().await;
                std::process::exit(0);
            });
        }
        _ => {}
    })
}
