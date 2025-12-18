use crate::{DB_POOL, constants::substrate::WSS_ENDPOINT};
use dirs;
use sqlx::Row;
use sqlx::sqlite::SqlitePool;
use tauri::{Builder, Manager, Wry};
#[cfg(target_os = "linux")]
use tauri_plugin_deep_link::DeepLinkExt;

async fn ensure_table_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    // Drop faulty is_first_run table if it exists (old schema with CHECK (id = 1))
    let drop_faulty_table = r#"
    DROP TABLE IF EXISTS is_first_run;
    "#;
    sqlx::query(drop_faulty_table).execute(pool).await?;

    // Define the expected table schemas
    const TABLE_SCHEMAS: &[(&str, &[(&str, &str)])] = &[
        (
            "vpn_status",
            &[
                ("id", "INTEGER PRIMARY KEY CHECK (id = 1)"),
                ("is_enabled", "BOOLEAN NOT NULL DEFAULT FALSE"),
                ("last_updated", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
            ],
        ),
        (
            "nebula_binary_status",
            &[
                ("id", "INTEGER PRIMARY KEY CHECK (id = 1)"),
                ("is_nebula_binary_installed", "BOOLEAN NOT NULL DEFAULT FALSE"),
                ("last_updated", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
            ],
        ),
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
                ("bucket_name", "TEXT"),
            ],
        ),
        (
            "is_first_run",
            &[
                ("id", "INTEGER PRIMARY KEY AUTOINCREMENT"),
                ("scope", "TEXT UNIQUE NOT NULL DEFAULT 'private'"),
                ("is_started", "BOOLEAN NOT NULL DEFAULT TRUE"),
                ("is_completed", "BOOLEAN NOT NULL DEFAULT FALSE"),
                ("last_updated", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
            ],
        ),
        (
            "file_paths",
            &[
                ("id", "INTEGER PRIMARY KEY AUTOINCREMENT"),
                ("file_name", "TEXT NOT NULL"),
                ("file_hash", "TEXT NOT NULL"),
                ("timestamp", "INTEGER NOT NULL"),
                ("path", "TEXT NOT NULL"),
            ],
        ),
        (
            "sub_accounts",
            &[
                ("id", "INTEGER PRIMARY KEY AUTOINCREMENT"),
                ("account_id", "TEXT NOT NULL"),
                ("sub_account_seed_phrase", "TEXT NOT NULL"),
                ("created_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
            ],
        ),
        (
            "bucket_policies",
            &[
                ("id", "INTEGER PRIMARY KEY CHECK (id = 1)"),
                ("sync_policy", "TEXT NOT NULL DEFAULT 'upload_only' CHECK(sync_policy IN ('mirror_local_deletes', 'restore_from_remote', 'local_only_deletes', 'upload_only'))"),
                ("created_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
                ("updated_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
            ],
        ),
        (
            "objectstore_auth",
            &[
                ("id", "INTEGER PRIMARY KEY CHECK (id = 1)"),
                ("temp_auth_key", "TEXT"),
                ("master_access_key_id", "TEXT"),
                ("master_secret", "TEXT"),
                ("updated_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
            ],
        ),
        (
            "objectstore_auth_scoped",
            &[
                ("owner", "TEXT PRIMARY KEY"),
                ("temp_auth_key", "TEXT"),
                ("master_access_key_id", "TEXT"),
                ("master_secret", "TEXT"),
                ("updated_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
            ],
        ),
        (
            "nebula_certificate",
            &[
                ("id", "INTEGER PRIMARY KEY CHECK (id = 1)"),
                ("certificate_id", "INTEGER"),
                ("expires_at", "TEXT"),
                ("is_active", "BOOLEAN"),
                ("created_at", "TEXT"),
                ("updated_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
            ],
        ),
        (
            "autoconnect_vpn_enabled",
            &[
                ("id", "INTEGER PRIMARY KEY CHECK (id = 1)"),
                ("is_enabled", "BOOLEAN NOT NULL DEFAULT FALSE"),
                ("updated_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
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
        let columns_info = sqlx::query(&pragma_sql).fetch_all(pool).await?;

        for (column_name, column_type) in *columns {
            let column_exists = columns_info.iter().any(|row| {
                let name: String = row.get("name");
                name == *column_name
            });

            if !column_exists {
                println!(
                    "[Setup] Adding column {} to table {}",
                    column_name, table_name
                );
                sqlx::query(&format!(
                    "ALTER TABLE {} ADD COLUMN {} {}",
                    table_name, column_name, column_type
                ))
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
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sync_paths (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL,
            path TEXT NOT NULL,
            type TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            UNIQUE(owner, type)
        )",
    )
    .execute(pool)
    .await?;

    // Ensure owner column exists for legacy installs
    let cols = sqlx::query("PRAGMA table_info(sync_paths)")
        .fetch_all(pool)
        .await?;
    let has_owner = cols.iter().any(|row| {
        let name: String = row.get("name");
        name == "owner"
    });
    if !has_owner {
        sqlx::query("ALTER TABLE sync_paths ADD COLUMN owner TEXT NOT NULL DEFAULT ''")
            .execute(pool)
            .await?;
        // rebuild uniqueness via index
        let _ = sqlx::query(
            "CREATE UNIQUE INDEX IF NOT EXISTS sync_paths_owner_type_idx ON sync_paths(owner, type)",
        )
        .execute(pool)
        .await;
    }

    // If a legacy UNIQUE constraint exists on sync_paths.type, rebuild table to use UNIQUE(owner, type)
    migrate_sync_paths_unique_constraint(pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS wss_endpoint (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            endpoint TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(pool)
    .await?;

    // Per-account bucket policies
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS bucket_policies_scoped (
            owner TEXT PRIMARY KEY,
            sync_policy TEXT NOT NULL DEFAULT 'upload_only' CHECK(sync_policy IN ('mirror_local_deletes', 'restore_from_remote', 'local_only_deletes', 'upload_only')),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS file_paths (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_name TEXT NOT NULL,
            file_hash TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            path TEXT NOT NULL
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sub_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id TEXT NOT NULL,
            sub_account_seed_phrase TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS bucket_policies (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            sync_policy TEXT NOT NULL DEFAULT 'upload_only' CHECK(sync_policy IN ('mirror_local_deletes', 'restore_from_remote', 'local_only_deletes', 'upload_only')),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(pool)
    .await?;

    // Create security_scoped_bookmarks table for macOS file access persistence
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS security_scoped_bookmarks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            bookmark_data BLOB NOT NULL,
            scope_type TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "INSERT OR IGNORE INTO bucket_policies (id, sync_policy) 
         VALUES (1, 'upload_only')"
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TRIGGER IF NOT EXISTS update_bucket_policies_timestamp
        AFTER UPDATE ON bucket_policies
        BEGIN
            UPDATE bucket_policies SET updated_at = CURRENT_TIMESTAMP WHERE id = 1;
        END;"
    )
    .execute(pool)
    .await?;

    Ok(())
}

async fn migrate_sync_paths_unique_constraint(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    // Detect a legacy unique index on "type" only
    let index_rows = sqlx::query("PRAGMA index_list(sync_paths)")
        .fetch_all(pool)
        .await?;

    let mut has_legacy_unique = false;
    for row in index_rows {
        let unique: i64 = row.get("unique");
        let name: String = row.get("name");
        if unique == 1 {
            let cols = sqlx::query(&format!("PRAGMA index_info({})", name)).fetch_all(pool).await?;
            let col_names: Vec<String> = cols.into_iter().map(|r| r.get("name")).collect();
            if col_names.len() == 1 && col_names[0] == "type" {
                has_legacy_unique = true;
                break;
            }
        }
    }

    if !has_legacy_unique {
        return Ok(());
    }

    println!("[Setup] Migrating sync_paths to drop legacy UNIQUE(type) constraint");
    let mut tx = pool.begin().await?;

    // Ensure the new table exists with the correct schema
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sync_paths_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL DEFAULT '',
            path TEXT NOT NULL,
            type TEXT NOT NULL,
            timestamp INTEGER NOT NULL
        )",
    )
    .execute(&mut *tx)
    .await?;

    // Copy data; if owner column was absent, COALESCE to ''
    sqlx::query(
        "INSERT OR IGNORE INTO sync_paths_new (owner, path, type, timestamp)
         SELECT COALESCE(owner, ''), path, type, timestamp FROM sync_paths",
    )
    .execute(&mut *tx)
    .await?;

    // Replace old table
    sqlx::query("DROP TABLE IF EXISTS sync_paths").execute(&mut *tx).await?;
    sqlx::query("ALTER TABLE sync_paths_new RENAME TO sync_paths")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS sync_paths_owner_type_idx ON sync_paths(owner, type)",
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

pub fn setup(builder: Builder<Wry>) -> Builder<Wry> {
    builder.setup(|app| {
            println!("[Setup] .setup() closure called in setup.rs");

            // Register deep links for Linux at runtime (required for dev)
            #[cfg(target_os = "linux")]
            {
                println!("[Setup] Registering deep links for Linux...");
                match app.deep_link().register_all() {
                    Ok(_) => println!("[Setup] Deep links registered successfully for Linux"),
                    Err(e) => eprintln!("[Setup] Failed to register deep links: {}", e),
                }
            }

            let _handle = app.handle().clone();
            let win = app.get_webview_window("main").expect("main window not found");

            if let Some(m) = win.current_monitor()? {
                let phys   = m.size();
                let origin = m.position();        // PhysicalPosition<i32>

                let w = (phys.width as f64 * 0.8) as u32;
                let h = (phys.height as f64 * 0.9) as u32;

                let pos_x = origin.x + ((phys.width  as i32 - w as i32) / 2);
                let pos_y = origin.y + ((phys.height as i32 - h as i32) / 2);

                win.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: w, height: h }))?;
                win.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: pos_x, y: pos_y }))?;
                win.show()?;
            }
            // Spawn async task for Nebula installation, database initialization and IPFS daemon
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

                // Initialize VPN status if it doesn't exist
                let vpn_status_exists: Option<(i64,)> = sqlx::query_as(
                    "SELECT COUNT(*) as count FROM vpn_status"
                )
                .fetch_optional(&pool)
                .await
                .unwrap_or(Some((0,)));

                if let Some((count,)) = vpn_status_exists {
                    if count == 0 {
                        println!("[Setup] No VPN status found, creating default entry...");
                        if let Err(e) = sqlx::query(
                            "INSERT INTO vpn_status (id, is_enabled) VALUES (1, FALSE)"
                        )
                        .execute(&pool)
                        .await {
                            eprintln!("[Setup] Failed to create default VPN status: {}", e);
                        } else {
                            println!("[Setup] Default VPN status created successfully");
                        }
                    } else {
                        println!("[Setup] VPN status entry already exists");
                    }
                }

                // Check if autoconnect is enabled
                let autoconnect_enabled: bool = sqlx::query("SELECT is_enabled FROM autoconnect_vpn_enabled WHERE id = 1")
                    .fetch_optional(&pool)
                    .await
                    .unwrap_or(None)
                    .map(|row| row.get("is_enabled"))
                    .unwrap_or(false);

                if !autoconnect_enabled {
                    // Reset VPN status to FALSE on startup
                    println!("[Setup] Resetting VPN status to FALSE on startup...");
                    if let Err(e) = sqlx::query(
                        "UPDATE vpn_status SET is_enabled = FALSE WHERE id = 1"
                    )
                    .execute(&pool)
                    .await {
                        eprintln!("[Setup] Failed to reset VPN status: {}", e);
                    }
                } else {
                    println!("[Setup] Autoconnect enabled, skipping VPN status reset");
                }

                // Ensure Nebula is stopped
                println!("[Setup] Ensuring Nebula is stopped on startup...");
                if let Err(e) = crate::utils::nebula::stop_nebula().await {
                    eprintln!("[Setup] Failed to stop Nebula: {}", e);
                }

                // Initialize Nebula binary status if it doesn't exist
                let nebula_binary_status_exists: Option<(i64,)> = sqlx::query_as(
                    "SELECT COUNT(*) as count FROM nebula_binary_status"
                )
                .fetch_optional(&pool)
                .await
                .unwrap_or(Some((0,)));

                if let Some((count,)) = nebula_binary_status_exists {
                    if count == 0 {
                        println!("[Setup] No Nebula binary status found, creating default entry...");
                        if let Err(e) = sqlx::query(
                            "INSERT INTO nebula_binary_status (id, is_nebula_binary_installed) VALUES (1, FALSE)"
                        )
                        .execute(&pool)
                        .await {
                            eprintln!("[Setup] Failed to create default Nebula binary status: {}", e);
                        } else {
                            println!("[Setup] Default Nebula binary status created successfully");
                        }
                    } else {
                        println!("[Setup] Nebula binary status entry already exists");
                    }
                }

                // Initialize autoconnect VPN status if it doesn't exist
                let autoconnect_exists: Option<(i64,)> = sqlx::query_as(
                    "SELECT COUNT(*) as count FROM autoconnect_vpn_enabled"
                )
                .fetch_optional(&pool)
                .await
                .unwrap_or(Some((0,)));

                if let Some((count,)) = autoconnect_exists {
                    if count == 0 {
                        println!("[Setup] No autoconnect VPN status found, creating default entry...");
                        if let Err(e) = sqlx::query(
                            "INSERT INTO autoconnect_vpn_enabled (id, is_enabled) VALUES (1, FALSE)"
                        )
                        .execute(&pool)
                        .await {
                            eprintln!("[Setup] Failed to create default autoconnect VPN status: {}", e);
                        } else {
                            println!("[Setup] Default autoconnect VPN status created successfully");
                        }
                    } else {
                        println!("[Setup] Autoconnect VPN status entry already exists");
                    }
                }

                println!("[Setup] Database initialized successfully");

                // Nebula installation is now handled by the frontend splash screen
                // via granular commands (check_nebula_requirements, etc.)
            });
            Ok(())
        })
}
