// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    image::Image,
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager,
};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(not(target_os = "macos"))]
            let icon_path = "./icons/icon.png";

            #[cfg(target_os = "macos")]
            let icon_path = "./icons/black-outline-icon.png";

            let _tray = TrayIconBuilder::new()
                .icon(Image::from_path(icon_path)?)
                .icon_as_template(true)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button, .. } = event {
                        match button {
                            MouseButton::Right => {
                                let app = tray.app_handle();

                                #[cfg(not(target_os = "macos"))]
                                {
                                    if let Some(webview_window) = app.get_webview_window("main") {
                                        let _ = webview_window.show();
                                        let _ = webview_window.set_focus();
                                    }
                                }

                                #[cfg(target_os = "macos")]
                                {
                                    tauri::AppHandle::show(&app.app_handle()).unwrap();
                                }
                            }
                            // TODO - Show Menu when you click on left
                            _ => {}
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| match event {
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
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
    // tauri_project_lib::run()
}
