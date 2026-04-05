//! SQLite schema initialization and migration.

use sqlx::Row;
use sqlx::sqlite::SqlitePool;
use tracing::{debug, info, warn};

pub async fn ensure_table_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    // Define the expected table schemas (only tables still needed)
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
            "sub_accounts",
            &[
                ("id", "INTEGER PRIMARY KEY AUTOINCREMENT"),
                ("account_id", "TEXT NOT NULL"),
                ("sub_account_seed_phrase", "TEXT NOT NULL"),
                ("created_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
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
            columns.iter().map(|(name, typ)| format!("{name} {typ}")).collect::<Vec<_>>().join(", ")
        );
        sqlx::query(&create_table).execute(pool).await?;

        // Check and add any missing columns
        let pragma_sql = format!("PRAGMA table_info({table_name})");
        let columns_info = sqlx::query(&pragma_sql).fetch_all(pool).await?;

        for (column_name, column_type) in *columns {
            let column_exists = columns_info.iter().any(|row| {
                let name: String = row.get("name");
                name == *column_name
            });

            if !column_exists {
                info!("Adding column {} to table {}", column_name, table_name);
                sqlx::query(&format!("ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}"))
                    .execute(pool)
                    .await?;
            }
        }
    }

    // sync_paths table (kept for path storage)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sync_paths (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL DEFAULT '',
            path TEXT NOT NULL,
            type TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT 'default',
            timestamp INTEGER NOT NULL,
            is_paused INTEGER NOT NULL DEFAULT 0,
            UNIQUE(owner, label)
        )",
    )
    .execute(pool)
    .await?;

    // Migration: add label column if missing (existing dev databases)
    {
        let columns_info = sqlx::query("PRAGMA table_info(sync_paths)").fetch_all(pool).await?;
        let has_label = columns_info.iter().any(|row| row.get::<String, _>("name") == "label");
        if !has_label {
            info!("Adding label column to sync_paths");
            sqlx::query("ALTER TABLE sync_paths ADD COLUMN label TEXT NOT NULL DEFAULT 'default'")
                .execute(pool)
                .await?;
        }
    }

    // Migration: add is_paused column if missing (existing databases)
    {
        let columns_info = sqlx::query("PRAGMA table_info(sync_paths)").fetch_all(pool).await?;
        let has_is_paused = columns_info.iter().any(|row| row.get::<String, _>("name") == "is_paused");
        if !has_is_paused {
            info!("Adding is_paused column to sync_paths");
            sqlx::query("ALTER TABLE sync_paths ADD COLUMN is_paused INTEGER NOT NULL DEFAULT 0")
                .execute(pool)
                .await?;
        }
    }

    // Migration: ensure the table has UNIQUE(owner, label).
    // Old schemas may have UNIQUE(owner, type) inline, or a separate unique index
    // on (owner, type) from the main branch migration. Either way, if the DDL
    // doesn't contain UNIQUE(owner, label), we recreate the table.
    // SQLite doesn't support ALTER TABLE DROP CONSTRAINT, so we recreate.
    // Wrapped in a transaction so the table is never left in a broken state.
    {
        let table_sql = sqlx::query("SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_paths'")
            .fetch_optional(pool)
            .await?;
        let has_correct_constraint = table_sql
            .as_ref()
            .and_then(|row| row.try_get::<String, _>("sql").ok())
            .is_some_and(|sql| sql.contains("UNIQUE(owner, label)") || sql.contains("UNIQUE (owner, label)"));

        if has_correct_constraint {
            debug!("sync_paths already has UNIQUE(owner, label), skipping migration");
        } else {
            info!("Migrating sync_paths to add UNIQUE(owner, label) constraint");
            // Clean up any leftover temp table from a previous failed attempt
            sqlx::query("DROP TABLE IF EXISTS sync_paths_new").execute(pool).await?;

            // Run the entire swap inside a transaction
            let mut tx = pool.begin().await?;

            sqlx::query(
                "CREATE TABLE sync_paths_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner TEXT NOT NULL DEFAULT '',
                    path TEXT NOT NULL,
                    type TEXT NOT NULL,
                    label TEXT NOT NULL DEFAULT 'default',
                    timestamp INTEGER NOT NULL,
                    is_paused INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(owner, label)
                )",
            )
            .execute(&mut *tx)
            .await?;

            // Copy data, skipping duplicates on (owner, label).
            // If a user has both public and private rows with the same
            // owner and label='default', keep only the private one
            // (higher priority). OR IGNORE drops any remaining dupes.
            sqlx::query(
                "INSERT OR IGNORE INTO sync_paths_new
                     (id, owner, path, type, label, timestamp)
                 SELECT id, owner, path, type, label, timestamp
                 FROM sync_paths
                 ORDER BY CASE type WHEN 'private' THEN 0 ELSE 1 END",
            )
            .execute(&mut *tx)
            .await?;

            sqlx::query("DROP TABLE sync_paths").execute(&mut *tx).await?;

            sqlx::query("ALTER TABLE sync_paths_new RENAME TO sync_paths").execute(&mut *tx).await?;

            tx.commit().await?;
            info!("sync_paths constraint migration completed");
        }
    }

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS wss_endpoint (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            endpoint TEXT NOT NULL,
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

    // Wallet store — replaces frontend IndexedDB "wallet" table
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS wallet_store (
            owner TEXT PRIMARY KEY,
            encrypted_mnemonic TEXT NOT NULL,
            passcode_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(pool)
    .await?;

    // Auth session — replaces frontend IndexedDB "session" table + localStorage tokens
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS auth_session (
            owner TEXT PRIMARY KEY,
            auth_token TEXT,
            token_expiry INTEGER,
            user_id INTEGER,
            username TEXT,
            provider TEXT,
            substrate_address TEXT,
            logout_time_minutes INTEGER DEFAULT 1440,
            last_login_at TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(pool)
    .await?;

    // HCFS config table
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS hcfs_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL UNIQUE,
            server_url TEXT NOT NULL DEFAULT '',
            drive_password TEXT NOT NULL DEFAULT '',
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(pool)
    .await?;

    // Auth token + S3 credential tables (API auth token stored as temp_auth_key,
    // S3 credentials stored as master_access_key_id/master_secret for migration)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS objectstore_auth (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            temp_auth_key TEXT,
            master_access_key_id TEXT,
            master_secret TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS objectstore_auth_scoped (
            owner TEXT PRIMARY KEY,
            temp_auth_key TEXT,
            master_access_key_id TEXT,
            master_secret TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(pool)
    .await?;

    // Device settings table (singleton row, stores friendly device name)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS device_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            device_name TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(pool)
    .await?;

    // Seed with OS hostname if no row exists yet
    {
        let existing = sqlx::query("SELECT id FROM device_settings WHERE id = 1").fetch_optional(pool).await?;
        if existing.is_none() {
            let hostname = hostname::get().map_or_else(|_| "My Device".to_string(), |h| h.to_string_lossy().into_owned());
            sqlx::query("INSERT INTO device_settings (id, device_name) VALUES (1, ?)")
                .bind(&hostname)
                .execute(pool)
                .await?;
            info!("Device name seeded: {}", hostname);
        }
    }

    sqlx::query(
        r"
        CREATE TABLE IF NOT EXISTS migration_status (
            account_id TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'in_progress',
            total_files INTEGER NOT NULL DEFAULT 0,
            completed_files INTEGER NOT NULL DEFAULT 0,
            failed_files TEXT NOT NULL DEFAULT '[]',
            sync_path TEXT NOT NULL DEFAULT '',
            server_url TEXT NOT NULL DEFAULT '',
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        ",
    )
    .execute(pool)
    .await?;

    // Notifications (replaces frontend notificationsDb.ts)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_address TEXT NOT NULL,
            notification_type TEXT,
            notification_subtype TEXT,
            title_text TEXT,
            description TEXT,
            link_text TEXT,
            link TEXT,
            is_unread INTEGER DEFAULT 1,
            creation_time INTEGER,
            is_deleted INTEGER DEFAULT 0,
            deleted_at INTEGER,
            release_notes TEXT
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_address)")
        .execute(pool)
        .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_notifications_user_deleted ON notifications(user_address, is_deleted)")
        .execute(pool)
        .await?;

    // App state (singleton, replaces frontend app_state table)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            is_first_time INTEGER DEFAULT 1,
            is_above_half_credit INTEGER DEFAULT 0
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query("INSERT OR IGNORE INTO app_state (id, is_first_time, is_above_half_credit) VALUES (1, 1, 0)")
        .execute(pool)
        .await?;

    // Notification preferences (replaces frontend notification_preferences table)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS notification_preferences (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            description TEXT NOT NULL,
            enabled INTEGER DEFAULT 1
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "INSERT OR IGNORE INTO notification_preferences (id, label, description, enabled) VALUES ('credits', 'Credits', 'Account credit notifications', 1)",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "INSERT OR IGNORE INTO notification_preferences (id, label, description, enabled) VALUES ('files', 'Files', 'File sync notifications', 1)",
    )
    .execute(pool)
    .await?;

    // Address book (replaces frontend addressBookDb.ts)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS address_book (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            wallet_address TEXT NOT NULL,
            date_added INTEGER DEFAULT (strftime('%s','now') * 1000)
        )",
    )
    .execute(pool)
    .await?;

    // Onboarding (replaces frontend onboardingDb.ts)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS onboarding (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            is_done INTEGER DEFAULT 0
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query("INSERT OR IGNORE INTO onboarding (id, is_done) VALUES (1, 0)")
        .execute(pool)
        .await?;

    // User preferences (replaces frontend userPreferencesDb.ts)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS user_preferences (
            preference_key TEXT PRIMARY KEY,
            preference_value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )",
    )
    .execute(pool)
    .await?;

    Ok(())
}

/// Migrate account keys from the legacy 8-char format to the new 16-char format.
///
/// Scans `auth_session` for rows where `owner` matches the legacy hash of
/// `substrate_address`, then updates `owner` across all tables in a transaction.
/// No-op if already migrated or if no sessions exist.
pub async fn migrate_account_keys(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    use crate::auth::account_key::{account_key, account_key_legacy};

    // Find sessions that still use the legacy 8-char owner format
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT owner, substrate_address FROM auth_session WHERE substrate_address IS NOT NULL AND substrate_address != ''")
            .fetch_all(pool)
            .await?;

    for (owner, substrate_address) in &rows {
        let legacy = account_key_legacy(substrate_address);
        let new_key = account_key(substrate_address);

        // Only migrate if owner matches legacy format and differs from new
        if owner == &legacy && owner != &new_key {
            info!(
                "Migrating account key for {}: {} -> {}",
                &substrate_address[..8.min(substrate_address.len())],
                legacy,
                new_key
            );

            let mut tx = pool.begin().await?;

            // Update owner in all tables that use it
            let tables = [
                "auth_session",
                "objectstore_auth_scoped",
                "sync_paths",
                "user_preferences",
                "address_book",
                "notifications",
                "wallet_store",
                "hcfs_config",
            ];

            for table in tables {
                // Use explicit per-table queries to avoid SQL injection
                let query = format!("UPDATE {table} SET owner = ? WHERE owner = ?");
                let result = sqlx::query(&query).bind(&new_key).bind(&legacy).execute(&mut *tx).await;
                match result {
                    Ok(r) if r.rows_affected() > 0 => {
                        info!("Updated {} row(s) in {}", r.rows_affected(), table);
                    }
                    Ok(_) => {} // No rows to update in this table
                    Err(e) => {
                        // Table may not exist yet — non-fatal
                        warn!("Could not update {}: {}", table, e);
                    }
                }
            }

            tx.commit().await?;
        }
    }

    Ok(())
}
