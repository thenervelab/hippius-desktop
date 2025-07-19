use tauri::{
    Builder, Manager, Wry,
};
use sqlx::sqlite::SqlitePool;
use once_cell::sync::OnceCell;
use dirs;
use std::path::PathBuf;
use sqlx::Row;
use crate::{
    commands::node::start_ipfs_daemon,
    DB_POOL,
};

async fn ensure_table_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    // Define the expected table schemas
    const TABLE_SCHEMAS: &[(&str, &[(&str, &str)])] = &[
        (
            "user_profiles",
            &[
                ("id", "INTEGER PRIMARY KEY AUTOINCREMENT"),
                ("owner", "TEXT NOT NULL"),
                ("cid", "TEXT NOT NULL"),
                ("file_hash", "TEXT"),
                ("file_name", "TEXT"),
                ("file_size_in_bytes", "INTEGER"),
                ("is_assigned", "BOOLEAN"),
                ("last_charged_at", "INTEGER"),
                ("main_req_hash", "TEXT"),
                ("selected_validator", "TEXT"),
                ("total_replicas", "INTEGER"),
                ("block_number", "INTEGER NOT NULL"),
                ("processed_timestamp", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
                ("profile_cid", "TEXT"),
                ("source", "TEXT"),
                ("miner_ids", "TEXT"),
                ("created_at", "INTEGER"),
            ],
        ),
        (
            "sync_folder_files",
            &[
                ("id", "INTEGER PRIMARY KEY AUTOINCREMENT"),
                ("owner", "TEXT NOT NULL"),
                ("cid", "TEXT NOT NULL"),
                ("file_hash", "TEXT"),
                ("file_name", "TEXT"),
                ("file_size_in_bytes", "INTEGER"),
                ("is_assigned", "BOOLEAN"),
                ("last_charged_at", "INTEGER"),
                ("main_req_hash", "TEXT"),
                ("selected_validator", "TEXT"),
                ("total_replicas", "INTEGER"),
                ("block_number", "INTEGER NOT NULL"),
                ("processed_timestamp", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
                ("profile_cid", "TEXT"),
                ("source", "TEXT"),
                ("miner_ids", "TEXT"),
            ],
        ),
    ];

    for (table_name, columns) in TABLE_SCHEMAS {
        // Create table if it doesn't exist with basic structure
        let create_table = format!(
            "CREATE TABLE IF NOT EXISTS {} ({})",
            table_name,
            columns
                .iter()
                .map(|(name, typ)| format!("{} {}", name, typ))
                .collect::<Vec<_>>()
                .join(", ")
        );
        sqlx::query(&create_table).execute(pool).await?;

        // Check and add any missing columns
        let pragma_sql = format!("PRAGMA table_info({})", table_name);
        let columns_info = sqlx::query(&pragma_sql)
            .fetch_all(pool)
            .await?;

        for (column_name, column_type) in *columns {
            let column_exists = columns_info.iter().any(|row| {
                let name: String = row.get("name");
                name == *column_name
            });

            if !column_exists {
                println!("[Setup] Adding column {} to table {}", column_name, table_name);
                sqlx::query(
                    &format!("ALTER TABLE {} ADD COLUMN {} {}", table_name, column_name, column_type)
                )
                .execute(pool)
                .await?;
            }
        }
    }

    // Create other tables that don't need schema migration
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS encryption_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key_name TEXT NOT NULL UNIQUE,
            key BLOB NOT NULL
        )"
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sync_paths (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            type TEXT NOT NULL UNIQUE,
            timestamp INTEGER NOT NULL
        )"
    )
    .execute(pool)
    .await?;

    Ok(())
}

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

            // Ensure all tables and columns exist
            if let Err(e) = ensure_table_schema(&pool).await {
                eprintln!("[Setup] Failed to ensure table schema: {}", e);
                return;
            }

            println!("[Setup] Database initialized successfully");

            // Start IPFS daemon
            if let Err(e) = start_ipfs_daemon(handle).await {
                eprintln!("Failed to start IPFS daemon: {e:?}");
            }
        });
        
        Ok(())
    })
}