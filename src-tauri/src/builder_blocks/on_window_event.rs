use tauri::{Builder, Manager, Wry};

pub fn on_window_event(builder: Builder<Wry>) -> Builder<Wry> {
    builder.on_window_event(|window, event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            println!("[Window] Close requested");
            api.prevent_close();
            let app_handle = window.app_handle().clone();

            tauri::async_runtime::spawn(async move {
                println!("[Window] Stopping Nebula VPN...");
                // Stop Nebula before exiting
                if let Err(e) = crate::utils::nebula::stop_nebula().await {
                    eprintln!("[Window] Failed to stop Nebula: {}", e);
                }

                println!("[Window] Exiting application...");
                app_handle.exit(0);
            });
        }
    })
}
