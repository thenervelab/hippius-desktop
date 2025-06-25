use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Builder, Manager, Wry,
};

pub fn add_system_tray(builder: Builder<Wry>) -> Builder<Wry> {
    builder
        .setup(|app| {
            let quit_i = MenuItem::with_id(app, "quit", "Quit Hippius", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit_i])?;

            #[cfg(not(target_os = "macos"))]
            let icon_path = "./icons/icon.png";

            #[cfg(target_os = "macos")]
            let icon_path = "./icons/black-outline-icon.png";

            let _tray = TrayIconBuilder::new()
                .tooltip("Hippius Cloud")
                .icon(Image::from_path(icon_path)?)
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click { button, .. } => {
                        let app = tray.app_handle();
                        match button {
                            MouseButton::Right => {}
                            MouseButton::Left => {
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
                            _ => {}
                        }
                    }
                    _ => {}
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        println!("quit menu item was clicked");
                        app.exit(0);
                    }
                    _ => {
                        println!("menu item {:?} not handled", event.id);
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
}
