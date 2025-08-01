use tauri::{
    Builder, Manager, Wry,
};
use sqlx::sqlite::SqlitePool;
use dirs;
use sqlx::Row;
use crate::{
    commands::node::start_ipfs_daemon,
    DB_POOL,
    constants::substrate::WSS_ENDPOINT,
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
                ("type", "TEXT DEFAULT 'public'"),
                ("is_folder", "BOOLEAN DEFAULT 0"),
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
                ("type", "TEXT"),
                ("is_folder", "BOOLEAN"),
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

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS wss_endpoint (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            endpoint TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

            // Set default values for existing records
            if let Err(e) = sqlx::query(
                r#"
                UPDATE user_profiles 
                SET type = CASE 
                    WHEN file_name LIKE '%.ec' OR file_name LIKE '%.ec_metadata' THEN 'private'
                    ELSE 'public'
                END,
                is_folder = CASE 
                    WHEN file_name LIKE '%.folder' OR file_name LIKE '%.folder.ec' THEN 1
                    ELSE 0
                END,
                source = COALESCE(source, 'Hippius')
                WHERE type IS NULL OR is_folder IS NULL OR source IS NULL
                "#
            ).execute(&pool).await {
                eprintln!("[Setup] Failed to update type, is_folder, and source columns in user_profiles: {}", e);
            }

            // Set default values for sync_folder_files
            if let Err(e) = sqlx::query(
                r#"
                UPDATE sync_folder_files 
                SET type = 'public',
                    is_folder = 0,
                    source = 'Hippius'
                WHERE type IS NULL OR is_folder IS NULL OR source IS NULL
                "#
            ).execute(&pool).await {
                eprintln!("[Setup] Failed to update default values in sync_folder_files: {}", e);
            }

            // Check if any encryption keys exist, create one if none found
            let key_exists: Option<(i64,)> = sqlx::query_as(
                "SELECT COUNT(*) as count FROM encryption_keys"
            )
            .fetch_optional(&pool)
            .await
            .unwrap_or(Some((0,)));

            if let Some((count,)) = key_exists {
                if count == 0 {
                    println!("[Setup] No encryption keys found, creating initial key...");
                    if let Err(e) = crate::utils::accounts::create_and_store_encryption_key().await {
                        eprintln!("[Setup] Failed to create initial encryption key: {}", e);
                    } else {
                        println!("[Setup] Initial encryption key created successfully");
                    }
                } else {
                    println!("[Setup] Found {} existing encryption key(s)", count);
                }
            }

            // Initialize WSS endpoint if it doesn't exist
            let endpoint_exists: Option<(i64,)> = sqlx::query_as(
                "SELECT COUNT(*) as count FROM wss_endpoint"
            )
            .fetch_optional(&pool)
            .await
            .unwrap_or(Some((0,)));

            if let Some((count,)) = endpoint_exists {
                if count == 0 {
                    println!("[Setup] No WSS endpoint found, creating default endpoint...");
                    if let Err(e) = sqlx::query(
                        "INSERT INTO wss_endpoint (id, endpoint) VALUES (1, ?)"
                    )
                    .bind(WSS_ENDPOINT)
                    .execute(&pool)
                    .await {
                        eprintln!("[Setup] Failed to create default WSS endpoint: {}", e);
                    } else {
                        println!("[Setup] Default WSS endpoint created successfully");
                    }
                } else {
                    println!("[Setup] WSS endpoint already exists");
                }
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