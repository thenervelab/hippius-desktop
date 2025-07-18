use tauri::{
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

            // Check if source column exists in user_profiles table, add if not
            let source_column_exists: Result<Option<i32>, _> = sqlx::query_scalar(
                "SELECT COUNT(*) FROM pragma_table_info('user_profiles') WHERE name = 'source'"
            )
            .fetch_optional(&pool)
            .await;

            match source_column_exists {
                Ok(Some(count)) if count == 0 => {
                    println!("[Setup] Adding 'source' column to user_profiles table");
                    sqlx::query("ALTER TABLE user_profiles ADD COLUMN source TEXT")
                        .execute(&pool)
                        .await
                        .unwrap_or_else(|e| {
                            eprintln!("[Setup] Failed to add source column: {}", e);
                        });
                }
                Ok(Some(_)) => {
                    println!("[Setup] 'source' column already exists in user_profiles table");
                }
                Err(e) => {
                    eprintln!("[Setup] Error checking for source column: {}", e);
                }
            }

            // Add sync_folder_files table with the same fields as user_profiles
            sqlx::query(
                "CREATE TABLE IF NOT EXISTS sync_folder_files (
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

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS encryption_keys (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    key_name TEXT NOT NULL UNIQUE,
                    key BLOB NOT NULL
                )"
            )
            .execute(&pool)
            .await
            .unwrap();

            sqlx::query(
                "CREATE TABLE IF NOT EXISTS sync_paths (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    path TEXT NOT NULL,
                    type TEXT NOT NULL UNIQUE, -- 'public' or 'private', only one of each
                    timestamp INTEGER NOT NULL
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