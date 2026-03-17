use tauri::{Builder, Manager, Wry};
use tracing::{debug, info, warn};

pub fn on_window_event(builder: Builder<Wry>) -> Builder<Wry> {
    builder.on_window_event(|window, event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            info!("Close requested");
            api.prevent_close();
            let app_handle = window.app_handle().clone();

            tauri::async_runtime::spawn(async move {
                debug!("Stopping Nebula VPN...");
                // Stop Nebula before exiting
                if let Err(e) = crate::utils::nebula::stop_nebula().await {
                    warn!("Failed to stop Nebula: {}", e);
                }

                info!("Exiting application...");
                app_handle.exit(0);
            });
        }
    })
}
