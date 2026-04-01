//! Window close handler — graceful shutdown with VPN cleanup.
//!
//! Intercepts the close event to stop the Nebula VPN process before
//! the app exits. Without this, the VPN tunnel would remain active
//! as an orphaned process.

use tauri::{Builder, Manager, Wry};
use tracing::{debug, info, warn};

/// Register the window close handler on the Tauri builder.
///
/// Prevents the default close, stops Nebula, then exits cleanly.
pub fn on_window_event(builder: Builder<Wry>) -> Builder<Wry> {
    builder.on_window_event(|window, event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            info!("Close requested");
            api.prevent_close();
            let app_handle = window.app_handle().clone();

            tauri::async_runtime::spawn(async move {
                debug!("Stopping Nebula VPN...");
                // Stop Nebula before exiting
                let nebula_st = &app_handle.state::<crate::app_state::AppState>().nebula;
                if let Err(e) = crate::utils::nebula::stop_nebula(nebula_st).await {
                    warn!("Failed to stop Nebula: {}", e);
                }

                info!("Exiting application...");
                app_handle.exit(0);
            });
        }
    })
}
