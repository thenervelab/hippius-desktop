use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Builder, Manager, Wry,
};
use sqlx::sqlite::SqlitePool;
use once_cell::sync::OnceCell;
use dirs;
use std::path::PathBuf;

use crate::{
    commands::node::start_ipfs_daemon,
    DB_POOL,
};

pub fn setup(builder: Builder<Wry>) -> Builder<Wry> {
    builder.setup(|app| {
        println!("[Setup] .setup() closure called in setup.rs");
        
        let quit_i = MenuItem::with_id(app, "quit", "Quit Hippius", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&quit_i])?;

        // Resolve icon path
        let icon_path = resolve_icon_path("icons/icon.png", &app.handle());

        // Debug: Log the resolved path
        println!("[Setup] Resolved icon path: {}", icon_path.display());

        let _tray = TrayIconBuilder::new()
            .tooltip("Hippius Cloud")
            .icon(Image::from_path(&icon_path)?)
            .icon_as_template(false)
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

        let handle = app.handle().clone();

        // Spawn async task for database initialization and IPFS daemon
        tauri::async_runtime::spawn(async move {
            println!("[Setup] async block started in setup.rs");
            
            // Database initialization
            let home_dir = dirs::home_dir().expect("Failed to get home directory");
            let db_dir = home_dir.join(".hippius");
            let db_path = db_dir.join("hippius.db");
            println!("[Setup] DB path: {}", db_path.display());

            std::fs::create_dir_all(&db_dir).expect("Failed to create .hippius directory");

            if !db_path.exists() {
                std::fs::File::create(&db_path).expect("Failed to create database file");
            }

            let db_url = format!("sqlite:{}", db_path.display());
            let pool = SqlitePool::connect(&db_url).await.unwrap();
            DB_POOL.set(pool.clone()).unwrap();

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS user_profiles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner TEXT NOT NULL,
                    cid TEXT NOT NULL,
                    file_hash TEXT,
                    file_name TEXT,
                    file_size_in_bytes INTEGER,
                    is_assigned BOOLEAN,
                    last_charged_at INTEGER,
                    main_req_hash TEXT,
                    selected_validator TEXT,
                    total_replicas INTEGER,
                    block_number INTEGER NOT NULL,
                    processed_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    profile_cid TEXT,
                    source TEXT,
                    miner_ids TEXT
                )"
            )
            .execute(&pool)
            .await
            .unwrap();

            println!("[Setup] Database initialized successfully");

            // Start IPFS daemon
            if let Err(e) = start_ipfs_daemon(handle).await {
                eprintln!("Failed to start IPFS daemon: {e:?}");
            }
        });
        
        Ok(())
    })
}

fn resolve_icon_path(filename: &str, app_handle: &tauri::AppHandle) -> PathBuf {
    // Try dev path for development
    let dev_dir = PathBuf::from("src-tauri");
    let dev_path = dev_dir.join(filename);
    println!("[Setup] Checking dev path: {}", dev_path.display());
    if dev_path.exists() {
        println!("[Setup] Using dev path: {}", dev_path.display());
        return dev_path;
    }

    // In production, use the resource directory
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .expect("Failed to resolve resource directory in production");
    let prod_path = resource_dir.join(filename);
    
    println!("[Setup] Resolved production path: {}", prod_path.display());

    if !prod_path.exists() {
        // Log resource directory contents for debugging
        if let Ok(entries) = std::fs::read_dir(&resource_dir) {
            for entry in entries {
                if let Ok(entry) = entry {
                    println!("[Setup] - {}", entry.path().display());
                }
            }
        }
        panic!(
            "[Setup] Icon not found at production path: {}. Ensure src-tauri/icons/icon.png is bundled in tauri.conf.json.",
            prod_path.display()
        );
    }
    
    println!("[Setup] Using production path: {}", prod_path.display());
    
    prod_path
}


// auto sync issue if file is not in db 
// is assigned should be true only when profile parsing 