//! SQLite schema initialization and migration.

use sqlx::sqlite::SqlitePool;
use sqlx::{Acquire, Row};
use std::collections::HashSet;
use tracing::{debug, info, warn};

/// Names of every table `ensure_table_schema` is expected to create.
///
/// This list is the single source of truth used by the smoke test
/// [`tests::ensure_table_schema_creates_all_expected_tables`] to verify
/// that no table is silently dropped from the initializer. When adding a
/// new table to [`ensure_table_schema`], append its name here.
#[cfg(test)]
const EXPECTED_TABLES: &[&str] = &[
    // Declarative TABLE_SCHEMAS block (1 table)
    "sub_accounts",
    // Imperative CREATE TABLE statements (17 tables)
    "sync_paths",
    "sync_intent",
    "wss_endpoint",
    "security_scoped_bookmarks",
    "auth_session",
    "hcfs_config",
    "objectstore_auth",
    "objectstore_auth_scoped",
    "device_settings",
    "migration_status",
    "notifications",
    "app_state",
    "notification_preferences",
    "address_book",
    "onboarding",
    "user_preferences",
    "share_keystore",
    "share_origin",
    "shared_link_history",
    "local_wallets",
];

/// Read the column names of a table via `PRAGMA table_info(...)`.
///
/// Centralised so the per-column-existence migration blocks below all share
/// one PRAGMA round-trip per call site instead of running `PRAGMA table_info`
/// on the same table multiple times in a row.
async fn table_columns<'e, E>(executor: E, table: &str) -> Result<HashSet<String>, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let pragma_sql = format!("PRAGMA table_info({table})");
    let rows = sqlx::query(&pragma_sql).fetch_all(executor).await?;
    Ok(rows.iter().map(|row| row.get::<String, _>("name")).collect())
}

/// One-shot cleanup of the four legacy Nebula VPN tables that earlier releases
/// created in `ensure_table_schema`. Runs before the rest of schema bring-up so
/// a fresh schema is never observed alongside the dead tables, even
/// transiently. `DROP TABLE IF EXISTS` is idempotent — once an installed
/// binary has run this on its DB the call is a no-op forever.
///
/// TODO: delete this helper (and its call site in `ensure_table_schema`)
/// three minor releases after the Nebula removal ships, i.e. once the oldest
/// supported desktop version no longer creates these tables on first boot.
/// Behaviour covered by `tests::ensure_table_schema_drops_legacy_nebula_tables`.
async fn drop_legacy_nebula_tables(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    for table in ["vpn_status", "nebula_binary_status", "nebula_certificate", "autoconnect_vpn_enabled"] {
        sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(pool).await?;
    }
    Ok(())
}

#[expect(
    clippy::too_many_lines,
    reason = "Large but straightforward schema initializer: declarative TABLE_SCHEMAS loop plus one complex sync_paths migration (label column, is_paused column, UNIQUE constraint recreation) that must stay co-located to be auditable in a single transaction. Coverage is provided by the `ensure_table_schema_creates_all_expected_tables` smoke test against EXPECTED_TABLES."
)]
pub async fn ensure_table_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    // Drop legacy Nebula tables first, outside the schema-init transaction, so
    // the cleanup is durable even if a later schema step fails. Idempotent —
    // see `drop_legacy_nebula_tables` for sunset criteria.
    drop_legacy_nebula_tables(pool).await?;

    // Wrap the entire initializer in one transaction so all CREATE/ALTER/INSERT
    // statements share a single fsync at commit time instead of ~30 separate
    // ones. On SQLite (especially WAL mode) this drops cold-start schema-init
    // latency by ~10x. The pre-existing inner sync_paths swap (line 218 in
    // history) now calls `tx.begin()` to nest as a savepoint — see
    // https://www.sqlite.org/lang_savepoint.html. `migrate_account_keys`
    // (called separately from `main.rs` after `ensure_table_schema` returns)
    // intentionally keeps its own `pool.begin()`; it runs only when legacy
    // 8-char owners exist and is decoupled from the schema-init lifecycle.
    let mut tx = pool.begin().await?;

    // Define the expected table schemas (only tables still needed)
    const TABLE_SCHEMAS: &[(&str, &[(&str, &str)])] = &[(
        "sub_accounts",
        &[
            ("id", "INTEGER PRIMARY KEY AUTOINCREMENT"),
            ("account_id", "TEXT NOT NULL"),
            ("sub_account_seed_phrase", "TEXT NOT NULL"),
            ("created_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
            ("encryption_version", "INTEGER NOT NULL DEFAULT 0"),
        ],
    )];

    for (table_name, columns) in TABLE_SCHEMAS {
        // Create table if it doesn't exist with basic structure
        let create_table = format!(
            "CREATE TABLE IF NOT EXISTS {} ({})",
            table_name,
            columns.iter().map(|(name, typ)| format!("{name} {typ}")).collect::<Vec<_>>().join(", ")
        );
        sqlx::query(&create_table).execute(&mut *tx).await?;

        // Check and add any missing columns
        let existing_cols = table_columns(&mut *tx, table_name).await?;

        for (column_name, column_type) in *columns {
            if !existing_cols.contains(*column_name) {
                info!("Adding column {} to table {}", column_name, table_name);
                sqlx::query(&format!("ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}"))
                    .execute(&mut *tx)
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
    .execute(&mut *tx)
    .await?;

    // Read sync_paths columns ONCE and reuse across the three column-add
    // migration blocks below. Saves three round-trips on every cold start.
    let sync_paths_cols = table_columns(&mut *tx, "sync_paths").await?;

    // Migration: add label column if missing (existing dev databases)
    if !sync_paths_cols.contains("label") {
        info!("Adding label column to sync_paths");
        sqlx::query("ALTER TABLE sync_paths ADD COLUMN label TEXT NOT NULL DEFAULT 'default'")
            .execute(&mut *tx)
            .await?;
    }

    // Migration: add is_paused column if missing (existing databases)
    if !sync_paths_cols.contains("is_paused") {
        info!("Adding is_paused column to sync_paths");
        sqlx::query("ALTER TABLE sync_paths ADD COLUMN is_paused INTEGER NOT NULL DEFAULT 0")
            .execute(&mut *tx)
            .await?;
    }

    // Migration: add `relative_paths_backfilled_at` column if missing (PR 7 Task 7.3).
    //
    // Unix epoch timestamp marking when the one-shot `relative_path` backfill
    // succeeded for this drive. NULL means "not yet backfilled"; any non-NULL
    // value is a set-once audit breadcrumb showing exactly when the backfill
    // completed. Chose `_at` over a boolean `_backfilled` flag so the retry
    // state machine is tiny (NULL vs set) while still giving us free
    // forensics if the server later reports a stale entry.
    if !sync_paths_cols.contains("relative_paths_backfilled_at") {
        info!("Adding relative_paths_backfilled_at column to sync_paths");
        sqlx::query("ALTER TABLE sync_paths ADD COLUMN relative_paths_backfilled_at INTEGER")
            .execute(&mut *tx)
            .await?;
    }

    // Migration: ensure the table has UNIQUE(owner, label).
    // Old schemas may have UNIQUE(owner, type) inline, or a separate unique index
    // on (owner, type) from the main branch migration. Either way, if the DDL
    // doesn't contain UNIQUE(owner, label), we recreate the table.
    // SQLite doesn't support ALTER TABLE DROP CONSTRAINT, so we recreate.
    // The whole swap nests as a savepoint inside the outer schema-init tx so
    // a failed swap rolls back to the savepoint without aborting the rest of
    // schema initialization.
    {
        let table_sql = sqlx::query("SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_paths'")
            .fetch_optional(&mut *tx)
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
            sqlx::query("DROP TABLE IF EXISTS sync_paths_new").execute(&mut *tx).await?;

            // Nested savepoint so the swap is atomic without grabbing a
            // second pool connection (which would deadlock under contention
            // and break the outer-tx atomicity guarantee).
            let mut sp = tx.begin().await?;

            sqlx::query(
                "CREATE TABLE sync_paths_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner TEXT NOT NULL DEFAULT '',
                    path TEXT NOT NULL,
                    type TEXT NOT NULL,
                    label TEXT NOT NULL DEFAULT 'default',
                    timestamp INTEGER NOT NULL,
                    is_paused INTEGER NOT NULL DEFAULT 0,
                    relative_paths_backfilled_at INTEGER,
                    UNIQUE(owner, label)
                )",
            )
            .execute(&mut *sp)
            .await?;

            // Copy data, skipping duplicates on (owner, label).
            // If a user has both public and private rows with the same
            // owner and label='default', keep only the private one
            // (higher priority). OR IGNORE drops any remaining dupes.
            //
            // `is_paused` and `relative_paths_backfilled_at` MUST be carried:
            // the ALTERs above guarantee both columns exist on the source
            // before this swap runs, so a paused drive stays paused and the
            // one-shot backfill breadcrumb is preserved. Omitting them (the
            // pre-fix bug) silently un-paused drives and re-triggered the
            // backfill on every DB created with the legacy `UNIQUE(owner,type)`.
            sqlx::query(
                "INSERT OR IGNORE INTO sync_paths_new
                     (id, owner, path, type, label, timestamp, is_paused, relative_paths_backfilled_at)
                 SELECT id, owner, path, type, label, timestamp, is_paused, relative_paths_backfilled_at
                 FROM sync_paths
                 ORDER BY CASE type WHEN 'private' THEN 0 ELSE 1 END",
            )
            .execute(&mut *sp)
            .await?;

            sqlx::query("DROP TABLE sync_paths").execute(&mut *sp).await?;

            sqlx::query("ALTER TABLE sync_paths_new RENAME TO sync_paths").execute(&mut *sp).await?;

            sp.commit().await?;
            info!("sync_paths constraint migration completed");
        }
    }

    // sync_intent — persistent upload-intent manifest for the sync widget.
    //
    // The sync widget previously reset progress on app restart after a partial
    // bulk upload (drag 10 GB → close at 5 GB → reopen shows "0 / 5 GB" instead
    // of "5 / 10 GB") because the in-memory snapshot was the only source of
    // truth. This table is the durable shadow: every queued file is recorded
    // here when its plan lands, and `completed_at_ms` is set when the file
    // finishes uploading. The composite primary key `(account_id, drive_label,
    // relative_path)` makes "same file enqueued twice for the same drive"
    // unrepresentable at the storage layer; subsequent tasks decide the
    // ON CONFLICT policy when wiring `record_plan`.
    //
    // `completed_at_ms` is NULLABLE on purpose: NULL is the canonical "still
    // pending" marker. The covering index `(account_id, drive_label,
    // completed_at_ms)` keeps the per-drive "pending count" and totals queries
    // (Task 2) off a full table scan as the table grows across long-running
    // sync sessions. `added_at_ms` is non-NULL so age-based prune policies have
    // a deterministic ordering key.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sync_intent (
            account_id      TEXT    NOT NULL,
            drive_label     TEXT    NOT NULL,
            relative_path   TEXT    NOT NULL,
            size_bytes      INTEGER NOT NULL,
            added_at_ms     INTEGER NOT NULL,
            completed_at_ms INTEGER,
            PRIMARY KEY (account_id, drive_label, relative_path)
        )",
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_sync_intent_drive
            ON sync_intent (account_id, drive_label, completed_at_ms)",
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS wss_endpoint (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            endpoint TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query("INSERT OR IGNORE INTO wss_endpoint (id, endpoint) VALUES (1, ?)")
        .bind(crate::blockchain::client::WSS_ENDPOINT)
        .execute(&mut *tx)
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
    .execute(&mut *tx)
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
    .execute(&mut *tx)
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
    .execute(&mut *tx)
    .await?;

    // Encryption-at-rest: add encryption_version to sub_accounts and hcfs_config.
    // ALTER TABLE ADD COLUMN is idempotent in SQLite — the "duplicate column"
    // error is expected and suppressed for databases that already have the column.
    for stmt in [
        "ALTER TABLE sub_accounts ADD COLUMN encryption_version INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE hcfs_config ADD COLUMN encryption_version INTEGER NOT NULL DEFAULT 0",
    ] {
        if let Err(e) = sqlx::query(stmt).execute(&mut *tx).await {
            let msg = e.to_string();
            if !msg.contains("duplicate column name") {
                warn!("Schema migration failed: {msg}");
            }
        }
    }

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
    .execute(&mut *tx)
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
    .execute(&mut *tx)
    .await?;

    // Device settings table (singleton row, stores friendly device name)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS device_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            device_name TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(&mut *tx)
    .await?;

    // Seed with OS hostname if no row exists yet
    {
        let existing = sqlx::query("SELECT id FROM device_settings WHERE id = 1")
            .fetch_optional(&mut *tx)
            .await?;
        if existing.is_none() {
            let hostname = hostname::get().map_or_else(|_| "My Device".to_string(), |h| h.to_string_lossy().into_owned());
            sqlx::query("INSERT INTO device_settings (id, device_name) VALUES (1, ?)")
                .bind(&hostname)
                .execute(&mut *tx)
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
    .execute(&mut *tx)
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
    .execute(&mut *tx)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_address)")
        .execute(&mut *tx)
        .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_notifications_user_deleted ON notifications(user_address, is_deleted)")
        .execute(&mut *tx)
        .await?;

    // Credit-dedup and low-credit-warning probes filter on
    // (notification_type, notification_subtype) with NO user_address predicate,
    // so neither user-keyed index above can serve them — every probe was a full
    // table scan. This composite index covers the `type = 'Credits' AND
    // subtype = ?` equality probes and the leading-column equality for the
    // `subtype LIKE 'LowCreditWarning-%'` prefix probes.
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_notifications_type_subtype ON notifications(notification_type, notification_subtype)")
        .execute(&mut *tx)
        .await?;

    // App state (singleton, replaces frontend app_state table)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            is_first_time INTEGER DEFAULT 1,
            is_above_half_credit INTEGER DEFAULT 0
        )",
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query("INSERT OR IGNORE INTO app_state (id, is_first_time, is_above_half_credit) VALUES (1, 1, 0)")
        .execute(&mut *tx)
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
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT OR IGNORE INTO notification_preferences (id, label, description, enabled) VALUES ('credits', 'Credits', 'Notifications for account credits, including low balance warnings and credit additions', 1)",
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT OR IGNORE INTO notification_preferences (id, label, description, enabled) VALUES ('files', 'Files', 'Notifications for file operations including sync completion and failures', 1)",
    )
    .execute(&mut *tx)
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
    .execute(&mut *tx)
    .await?;

    // Onboarding (replaces frontend onboardingDb.ts)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS onboarding (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            is_done INTEGER DEFAULT 0
        )",
    )
    .execute(&mut *tx)
    .await?;

    // Local wallets — per-logged-in-account scope via `owner`, mirroring
    // sync_paths. See src-tauri/src/wallet/{crypto,repo,commands}.rs.
    //
    // Migration policy: legacy installs had a global `local_wallets` table
    // with no `owner` column. We drop those rows wholesale on first boot of
    // this build rather than silently attributing them to whichever account
    // logs in first — the wallet password is the only thing that decrypts
    // the mnemonic and we cannot prove who that mnemonic belongs to. Users
    // must re-create or re-import after upgrading.
    let local_wallets_cols = table_columns(&mut *tx, "local_wallets").await?;
    if !local_wallets_cols.is_empty() && !local_wallets_cols.contains("owner") {
        info!("Dropping legacy unscoped local_wallets table; wallets must be re-created per-account");
        sqlx::query("DROP TABLE local_wallets").execute(&mut *tx).await?;
    }

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS local_wallets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL,
            name TEXT NOT NULL,
            address TEXT NOT NULL,
            encrypted_mnemonic TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
            UNIQUE(owner, address)
        )",
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query("INSERT OR IGNORE INTO onboarding (id, is_done) VALUES (1, 0)")
        .execute(&mut *tx)
        .await?;

    // User preferences (replaces frontend userPreferencesDb.ts)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS user_preferences (
            preference_key TEXT PRIMARY KEY,
            preference_value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )",
    )
    .execute(&mut *tx)
    .await?;

    // Per-share key material for the file-sharing feature. One row per
    // active share-token this device created. The
    // `CHECK (length(share_key) = 32)` is defence-in-depth: a wrong-sized
    // key would otherwise surface as an opaque AEAD failure several
    // layers up the stack — see crate::shares::keystore.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS share_keystore (
            share_token TEXT PRIMARY KEY,
            share_key BLOB NOT NULL CHECK (length(share_key) = 32),
            created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )",
    )
    .execute(&mut *tx)
    .await?;

    // Sidecar of `share_keystore` that records which local file each
    // share was minted from. We need this so the UI can answer two
    // questions the keystore can't: "is this file currently shared?"
    // (per-row badge in the file list) and "reshare the same file with
    // a fresh TTL" (the Reshare button on the My Shares page).
    //
    // Lives in the desktop and never leaves it: the server only sees
    // ciphertext, and exposing `(folder_label, relative_path)` upstream
    // would break the share_keystore trait we share with the WASM
    // recipient. `owner` is the same `account_key` hash `sync_paths`
    // uses, so a per-account prune in `hcfs_list_shares` can scope
    // safely without touching another account's rows.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS share_origin (
            share_token TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            folder_label TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS share_origin_owner_idx ON share_origin (owner, folder_label)")
        .execute(&mut *tx)
        .await?;

    // Per-device snapshot of share tokens that have left the active set
    // (expired server-side, revoked locally, or revoked from another
    // device). The composite PRIMARY KEY makes `record_event` idempotent
    // under repeat diffs without per-device coordination, and the
    // (account_id, ended_at) index keeps the DESC list query off a full
    // scan once the table grows. See `crate::shares::history` for the
    // module-level rationale and lifecycle.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS shared_link_history (
            account_id     TEXT NOT NULL,
            share_token    TEXT NOT NULL,
            filename       TEXT,
            folder_label   TEXT,
            relative_path  TEXT,
            plaintext_size INTEGER,
            mime_type      TEXT,
            created_at     TEXT NOT NULL,
            expires_at     TEXT NOT NULL,
            ended_at       TEXT NOT NULL,
            end_reason     TEXT NOT NULL,
            PRIMARY KEY (account_id, share_token)
        )",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS shared_link_history_account_ended_idx ON shared_link_history (account_id, ended_at DESC)")
        .execute(&mut *tx)
        .await?;

    // (Removed: `bridge_transactions` table. The first cut of the bridge
    // persisted a full per-account tx-history table here, but the FE now
    // mirrors hippius-web's localStorage-backed tracking via
    // `app/lib/bridge/local-cache.ts` — there is no Rust writer left to
    // populate this table. Pre-existing rows in upgraded installs are
    // harmless; we leave them in place rather than running a destructive
    // DROP. If the bridge ever moves back to Rust persistence the CREATE
    // can return alongside the new writer.)

    tx.commit().await?;
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
            // warn-level so we can see in production logs whether anyone
            // is still hitting the legacy migration path. Goal: see this
            // log stop firing for 30 days, then retire `account_key_legacy`
            // entirely. See `account_key_legacy` doc for sunset criteria.
            warn!(
                addr_prefix = %&substrate_address[..8.min(substrate_address.len())],
                legacy = %legacy,
                new_key = %new_key,
                "Hit legacy account key migration path — bake-time signal for retiring account_key_legacy"
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

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    /// Create a fresh in-memory SQLite pool for isolated schema tests.
    async fn temp_pool() -> SqlitePool {
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("failed to create in-memory SQLite pool")
    }

    /// Regression guard: verifies that [`ensure_table_schema`] creates every
    /// table listed in [`EXPECTED_TABLES`] and only those tables. Protects
    /// against silent drops during refactoring — the same class of bug that
    /// removed `sync_logic.rs`'s connectivity monitoring in the f13fbd75
    /// refactor and went unnoticed for weeks.
    ///
    /// If this test fails, either the initializer dropped a table or
    /// [`EXPECTED_TABLES`] is stale. Update whichever is wrong.
    #[tokio::test]
    async fn ensure_table_schema_creates_all_expected_tables() {
        let pool = temp_pool().await;

        ensure_table_schema(&pool).await.expect("ensure_table_schema failed on fresh DB");

        let rows = sqlx::query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .fetch_all(&pool)
            .await
            .expect("failed to list tables");

        let actual: HashSet<String> = rows.iter().map(|r| r.get::<String, _>("name")).collect();
        let expected: HashSet<String> = EXPECTED_TABLES.iter().map(|s| (*s).to_string()).collect();

        let missing: Vec<&String> = expected.difference(&actual).collect();
        let extra: Vec<&String> = actual.difference(&expected).collect();

        assert!(
            missing.is_empty() && extra.is_empty(),
            "Schema drift detected.\n  Missing (expected but not created): {missing:?}\n  Extra (created but not expected): {extra:?}\n  If a table was intentionally added/removed, update EXPECTED_TABLES."
        );
    }

    /// Calling [`ensure_table_schema`] twice must be a no-op on the second
    /// invocation. Startup can call it multiple times (splash screen,
    /// session restore), so idempotency is load-bearing.
    #[tokio::test]
    async fn ensure_table_schema_is_idempotent() {
        let pool = temp_pool().await;
        ensure_table_schema(&pool).await.expect("first call failed");
        ensure_table_schema(&pool).await.expect("second call failed");
        // Verify the table set is unchanged on the second run.
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .fetch_one(&pool)
            .await
            .expect("failed to count tables");
        assert_eq!(count as usize, EXPECTED_TABLES.len(), "table count changed across calls");
    }

    /// Names of the legacy Nebula tables earlier releases created in
    /// `ensure_table_schema`. Kept in sync with the array in
    /// [`drop_legacy_nebula_tables`] — if those names diverge, this test
    /// stops exercising the helper.
    const LEGACY_NEBULA_TABLES: &[&str] = &[
        "vpn_status",
        "nebula_binary_status",
        "nebula_certificate",
        "autoconnect_vpn_enabled",
    ];

    /// Regression guard for the one-shot Nebula drop. Without this test the
    /// helper could silently become a no-op (empty array, renamed tables,
    /// accidental short-circuit) and existing schema tests would still pass
    /// because they start from an empty DB. Pre-populates the four legacy
    /// tables, runs `ensure_table_schema`, and asserts the helper actually
    /// removed them while leaving the canonical schema intact.
    #[tokio::test]
    async fn ensure_table_schema_drops_legacy_nebula_tables() {
        let pool = temp_pool().await;

        // Minimal stand-in schemas — the test only cares about the table
        // *names* being dropped, not their original column shapes.
        for table in LEGACY_NEBULA_TABLES {
            sqlx::query(&format!("CREATE TABLE {table} (id INTEGER PRIMARY KEY)"))
                .execute(&pool)
                .await
                .unwrap_or_else(|e| panic!("failed to seed legacy table {table}: {e}"));
        }

        // Sanity: confirm the seed worked before relying on the post-condition.
        let seeded = list_user_tables(&pool).await;
        for table in LEGACY_NEBULA_TABLES {
            assert!(
                seeded.contains(*table),
                "test setup bug: legacy table `{table}` not seeded; present: {seeded:?}"
            );
        }

        ensure_table_schema(&pool).await.expect("ensure_table_schema failed");

        let after = list_user_tables(&pool).await;
        for table in LEGACY_NEBULA_TABLES {
            assert!(
                !after.contains(*table),
                "legacy Nebula table `{table}` survived ensure_table_schema; present: {after:?}"
            );
        }

        // Spot-check that ordinary bring-up still ran; an early-return bug in
        // `ensure_table_schema` would silently drop the legacy tables *and*
        // skip the rest of schema init.
        assert!(after.contains("sub_accounts"), "canonical schema missing after drop+init: {after:?}");
    }

    /// Helper: collect user (non-`sqlite_%`) table names from `sqlite_master`.
    async fn list_user_tables(pool: &SqlitePool) -> HashSet<String> {
        sqlx::query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .fetch_all(pool)
            .await
            .expect("failed to list tables")
            .iter()
            .map(|r| r.get::<String, _>("name"))
            .collect()
    }

    /// The `sync_paths` table must end up with the `label` and `is_paused`
    /// columns regardless of whether it was created fresh or migrated from
    /// an older schema. This guards the migration block at lines 133-154.
    #[tokio::test]
    async fn sync_paths_has_required_columns_after_schema_ensure() {
        let pool = temp_pool().await;
        ensure_table_schema(&pool).await.expect("ensure_table_schema failed");
        let cols = sqlx::query("PRAGMA table_info(sync_paths)")
            .fetch_all(&pool)
            .await
            .expect("PRAGMA failed");
        let names: HashSet<String> = cols.iter().map(|r| r.get::<String, _>("name")).collect();
        for required in ["owner", "path", "type", "label", "timestamp", "is_paused", "relative_paths_backfilled_at"] {
            assert!(names.contains(required), "sync_paths missing column `{required}`; present: {names:?}");
        }
    }

    /// The `UNIQUE(owner, label)` constraint-swap migration must PRESERVE the
    /// user's `is_paused` intent and the `relative_paths_backfilled_at` audit
    /// breadcrumb. The pre-fix swap copied neither (is_paused reset to its
    /// default 0; the backfill column was absent from the new table entirely),
    /// so a paused drive was silently un-paused and the one-shot backfill
    /// re-triggered on a DB created with the legacy `UNIQUE(owner, type)` DDL.
    #[tokio::test]
    async fn constraint_swap_preserves_is_paused_and_backfill_timestamp() {
        let pool = temp_pool().await;

        // Legacy schema: wrong constraint, but the columns already exist (an
        // installed user who paused a drive before the constraint migration).
        sqlx::query(
            "CREATE TABLE sync_paths (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner TEXT NOT NULL DEFAULT '',
                path TEXT NOT NULL,
                type TEXT NOT NULL,
                label TEXT NOT NULL DEFAULT 'default',
                timestamp INTEGER NOT NULL,
                is_paused INTEGER NOT NULL DEFAULT 0,
                relative_paths_backfilled_at INTEGER,
                UNIQUE(owner, type)
            )",
        )
        .execute(&pool)
        .await
        .expect("seed legacy sync_paths");
        sqlx::query(
            "INSERT INTO sync_paths (owner, path, type, label, timestamp, is_paused, relative_paths_backfilled_at)
             VALUES ('5Owner', '/data/Hippius', 'private', 'mylabel', 100, 1, 12345)",
        )
        .execute(&pool)
        .await
        .expect("seed paused row");

        ensure_table_schema(&pool).await.expect("ensure_table_schema failed");

        // Constraint was actually migrated.
        let ddl: String = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_paths'")
            .fetch_one(&pool)
            .await
            .expect("read migrated DDL");
        assert!(
            ddl.contains("UNIQUE(owner, label)") || ddl.contains("UNIQUE (owner, label)"),
            "migration must install UNIQUE(owner, label); got: {ddl}"
        );

        // ...and the user's pause intent + backfill breadcrumb survived it.
        let (is_paused, backfilled): (i64, Option<i64>) =
            sqlx::query_as("SELECT is_paused, relative_paths_backfilled_at FROM sync_paths WHERE owner = '5Owner'")
                .fetch_one(&pool)
                .await
                .expect("read migrated row");
        assert_eq!(is_paused, 1, "paused drive must stay paused across the constraint swap");
        assert_eq!(backfilled, Some(12345), "relative_paths_backfilled_at must survive the constraint swap");
    }

    /// The credit-dedup / low-credit probes filter on
    /// (notification_type, notification_subtype) with no user_address, so they
    /// need a composite index leading with those columns or they full-scan.
    #[tokio::test]
    async fn notifications_has_type_subtype_index() {
        let pool = temp_pool().await;
        ensure_table_schema(&pool).await.expect("ensure_table_schema failed");
        let idx: Option<String> =
            sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_notifications_type_subtype'")
                .fetch_optional(&pool)
                .await
                .expect("query index");
        assert_eq!(idx.as_deref(), Some("idx_notifications_type_subtype"));
    }
}
