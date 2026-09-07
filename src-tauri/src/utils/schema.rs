//! SQLite schema initialization and migration.

use sqlx::sqlite::{SqliteConnection, SqlitePool};
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
    // Imperative CREATE TABLE statements (17 tables)
    "sync_paths",
    "sync_intent",
    "sync_file_failures",
    "folder_entries_local",
    "wss_endpoint",
    "security_scoped_bookmarks",
    "auth_session",
    "oauth_pending_states",
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
    "bridge_transactions",
    "credit_notification_flags",
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

/// Create or migrate every SQLite table the desktop backend relies on.
///
/// This is the single source of truth for the local schema — the project
/// maintains the database via this function instead of migration files (see
/// CLAUDE.md). Idempotent, so it is safe to run on every startup. The whole
/// initializer runs in one transaction so the ~30 CREATE/ALTER/INSERT
/// statements share a single commit-time fsync (≈10x faster cold-start on
/// WAL-mode SQLite). Legacy Nebula tables are dropped first, *outside* the
/// transaction, so that cleanup stays durable even if a later schema step
/// fails.
///
/// Each table (or cohesive group) is created/migrated by its own
/// `ensure_*` helper below, all sharing the one transaction — so this stays a
/// readable manifest while every individual table's DDL is auditable in
/// isolation. The set of tables created here is pinned by the
/// `ensure_table_schema_creates_all_expected_tables` smoke test.
///
/// # Errors
///
/// Returns `sqlx::Error` if any DDL/DML statement or the commit fails; the
/// transaction is rolled back, leaving the existing schema unchanged.
pub async fn ensure_table_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    // Drop legacy Nebula tables first, outside the schema-init transaction, so
    // the cleanup is durable even if a later schema step fails. Idempotent —
    // see `drop_legacy_nebula_tables` for sunset criteria.
    drop_legacy_nebula_tables(pool).await?;

    // Wrap the entire initializer in one transaction so all CREATE/ALTER/INSERT
    // statements share a single fsync at commit time instead of ~30 separate
    // ones (≈10x faster cold-start on WAL-mode SQLite). Every `ensure_*` helper
    // below runs against this shared transaction; `ensure_sync_paths` opens a
    // nested savepoint for its table rebuild (see
    // https://www.sqlite.org/lang_savepoint.html). `migrate_account_keys`
    // (called separately from `main.rs` after this returns) keeps its own
    // `pool.begin()`; it runs only when legacy 8-char owners exist and is
    // decoupled from the schema-init lifecycle.
    let mut tx = pool.begin().await?;

    // The `sub_accounts` table was created but never read or written (audit
    // R-35 / W-07): its `NOT NULL` plaintext `sub_account_seed_phrase` column
    // (default `encryption_version = 0`) was a latent footgun — a future writer
    // would default to storing seeds in plaintext, which `migrate_if_needed`
    // does not cover. Drop it. Safe and idempotent: no data was ever stored.
    sqlx::query("DROP TABLE IF EXISTS sub_accounts").execute(&mut *tx).await?;
    ensure_sync_paths(&mut tx).await?;
    ensure_sync_intent(&mut tx).await?;
    ensure_sync_file_failures(&mut tx).await?;
    ensure_folder_entries_local(&mut tx).await?;
    ensure_wss_endpoint(&mut tx).await?;
    ensure_security_scoped_bookmarks(&mut tx).await?;
    ensure_auth_session(&mut tx).await?;
    ensure_hcfs_config(&mut tx).await?;
    ensure_encryption_version_columns(&mut tx).await?;
    ensure_objectstore_auth(&mut tx).await?;
    ensure_device_settings(&mut tx).await?;
    ensure_migration_status(&mut tx).await?;
    ensure_notifications(&mut tx).await?;
    ensure_app_state(&mut tx).await?;
    ensure_notification_preferences(&mut tx).await?;
    ensure_address_book(&mut tx).await?;
    ensure_onboarding(&mut tx).await?;
    ensure_local_wallets(&mut tx).await?;
    ensure_user_preferences(&mut tx).await?;
    ensure_share_keystore(&mut tx).await?;
    ensure_share_origin(&mut tx).await?;
    ensure_bridge_transactions(&mut tx).await?;
    ensure_credit_notification_flags(&mut tx).await?;
    ensure_shared_link_history(&mut tx).await?;

    // No `bridge_transactions` helper by design: the first cut of the bridge
    // persisted a full per-account tx-history table, but the FE now mirrors
    // hippius-web's localStorage-backed tracking via `app/lib/bridge/
    // local-cache.ts` — there is no Rust writer left to populate it. Pre-existing
    // rows in upgraded installs are harmless; we leave them rather than running a
    // destructive DROP. If the bridge ever moves back to Rust persistence, add an
    // `ensure_bridge_transactions` helper here alongside the new writer.

    tx.commit().await?;
    Ok(())
}

/// `sync_paths` — create the table, add columns missing on older DBs, and swap
/// the table to a `UNIQUE(owner, label)` constraint when an older DDL is found.
///
/// The constraint swap recreates the table (SQLite cannot `ALTER TABLE DROP
/// CONSTRAINT`) inside a nested savepoint so a failed swap rolls back to the
/// savepoint without aborting the rest of schema init. Co-located here so the
/// column-add migrations and the swap that depends on them stay auditable
/// together.
async fn ensure_sync_paths(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
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
    .execute(&mut *conn)
    .await?;

    // Read sync_paths columns ONCE and reuse across the four column-add
    // migration blocks below. Saves three round-trips on every cold start.
    let sync_paths_cols = table_columns(&mut *conn, "sync_paths").await?;

    // Migration: add label column if missing (existing dev databases)
    if !sync_paths_cols.contains("label") {
        info!("Adding label column to sync_paths");
        sqlx::query("ALTER TABLE sync_paths ADD COLUMN label TEXT NOT NULL DEFAULT 'default'")
            .execute(&mut *conn)
            .await?;
    }

    // Migration: add is_paused column if missing (existing databases)
    if !sync_paths_cols.contains("is_paused") {
        info!("Adding is_paused column to sync_paths");
        sqlx::query("ALTER TABLE sync_paths ADD COLUMN is_paused INTEGER NOT NULL DEFAULT 0")
            .execute(&mut *conn)
            .await?;
    }

    // Migration: add `relative_paths_backfilled_at` column if missing.
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
            .execute(&mut *conn)
            .await?;
    }

    // Migration: add `folder_entries_backfilled_at` column if missing.
    //
    // Unix epoch timestamp marking when the one-shot folder-entity backfill
    // (Task 1.12) succeeded for this drive — registering every existing local
    // directory as a server folder entity so empty folders appear in the
    // Console. Exactly mirrors `relative_paths_backfilled_at` above: NULL means
    // "not yet backfilled", any non-NULL value is a set-once audit breadcrumb.
    // Kept as a separate flag because the two backfills run independently.
    if !sync_paths_cols.contains("folder_entries_backfilled_at") {
        info!("Adding folder_entries_backfilled_at column to sync_paths");
        sqlx::query("ALTER TABLE sync_paths ADD COLUMN folder_entries_backfilled_at INTEGER")
            .execute(&mut *conn)
            .await?;
    }

    // Migration: add the shared-drive member-identity columns if missing.
    //
    // A MEMBER drive (shared-drives phase 2) syncs another account's folder:
    // its WIRE identity on hcfs-server is the OWNER's ss58 plus the owner's
    // folder hash, which the local label cannot derive. Both columns NULL is
    // the own-drive shape (wire identity derived from the session account +
    // label, byte-identical to pre-shared-drives behavior); both set is the
    // member shape. Exactly one set is a corrupt row and
    // `sync::identity::resolve_drive_identity` fails closed on it.
    if !sync_paths_cols.contains("owner_ss58") {
        info!("Adding owner_ss58 column to sync_paths");
        sqlx::query("ALTER TABLE sync_paths ADD COLUMN owner_ss58 TEXT")
            .execute(&mut *conn)
            .await?;
    }
    if !sync_paths_cols.contains("wire_folder_hash") {
        info!("Adding wire_folder_hash column to sync_paths");
        sqlx::query("ALTER TABLE sync_paths ADD COLUMN wire_folder_hash TEXT")
            .execute(&mut *conn)
            .await?;
    }

    // Older DDLs (e.g. `UNIQUE(owner, type)`) get rebuilt to the correct
    // constraint — SQLite cannot ALTER a constraint in place.
    ensure_sync_paths_unique_constraint(&mut *conn).await?;
    Ok(())
}

/// Rebuild `sync_paths` with `UNIQUE(owner, label)` when an older DDL (e.g.
/// `UNIQUE(owner, type)`) is detected; no-op when the constraint is already
/// correct.
///
/// SQLite cannot `ALTER TABLE DROP CONSTRAINT`, so the table is recreated
/// inside a nested savepoint — `begin()` on a connection already in a
/// transaction issues a `SAVEPOINT`, so a failed swap rolls back to it without
/// aborting the rest of schema init. The copy MUST carry `is_paused`,
/// `relative_paths_backfilled_at`, `folder_entries_backfilled_at`, and the
/// shared-drive identity pair `owner_ss58` / `wire_folder_hash` (the caller's
/// ALTERs guarantee all five exist on the source) so a paused drive stays
/// paused, both one-shot backfill breadcrumbs survive, and a member drive
/// keeps its wire identity — omitting a column silently un-paused drives,
/// re-triggered a backfill, or would turn a member drive back into an own
/// drive on legacy `UNIQUE(owner, type)` DBs.
async fn ensure_sync_paths_unique_constraint(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    let table_sql = sqlx::query("SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_paths'")
        .fetch_optional(&mut *conn)
        .await?;
    let has_correct_constraint = table_sql
        .as_ref()
        .and_then(|row| row.try_get::<String, _>("sql").ok())
        .is_some_and(|sql| sql.contains("UNIQUE(owner, label)") || sql.contains("UNIQUE (owner, label)"));

    if has_correct_constraint {
        debug!("sync_paths already has UNIQUE(owner, label), skipping migration");
        return Ok(());
    }

    info!("Migrating sync_paths to add UNIQUE(owner, label) constraint");
    // Clean up any leftover temp table from a previous failed attempt
    sqlx::query("DROP TABLE IF EXISTS sync_paths_new").execute(&mut *conn).await?;

    // Nested savepoint so the swap is atomic without grabbing a second pool
    // connection (which would deadlock under contention and break the outer-tx
    // atomicity guarantee).
    let mut sp = conn.begin().await?;

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
            folder_entries_backfilled_at INTEGER,
            owner_ss58 TEXT,
            wire_folder_hash TEXT,
            UNIQUE(owner, label)
        )",
    )
    .execute(&mut *sp)
    .await?;

    // Copy data, skipping duplicates on (owner, label). If a user has both
    // public and private rows with the same owner and label='default', keep
    // only the private one (higher priority). OR IGNORE drops remaining dupes.
    sqlx::query(
        "INSERT OR IGNORE INTO sync_paths_new
             (id, owner, path, type, label, timestamp, is_paused, relative_paths_backfilled_at, folder_entries_backfilled_at, owner_ss58, wire_folder_hash)
         SELECT id, owner, path, type, label, timestamp, is_paused, relative_paths_backfilled_at, folder_entries_backfilled_at, owner_ss58, wire_folder_hash
         FROM sync_paths
         ORDER BY CASE type WHEN 'private' THEN 0 ELSE 1 END",
    )
    .execute(&mut *sp)
    .await?;

    sqlx::query("DROP TABLE sync_paths").execute(&mut *sp).await?;
    sqlx::query("ALTER TABLE sync_paths_new RENAME TO sync_paths").execute(&mut *sp).await?;

    sp.commit().await?;
    info!("sync_paths constraint migration completed");
    Ok(())
}

/// `sync_intent` — persistent upload-intent manifest for the sync widget.
///
/// This table is the durable shadow of the in-memory progress snapshot, so a
/// partial bulk upload survives an app restart (drag 10 GB → close at 5 GB →
/// reopen still shows "5 / 10 GB"). Every queued file is recorded here when
/// its plan lands, and `completed_at_ms` is set when the file finishes
/// uploading. The composite primary key `(account_id, drive_label,
/// relative_path)` makes "same file enqueued twice for the same drive"
/// unrepresentable at the storage layer.
///
/// `completed_at_ms` is NULLABLE on purpose: NULL is the canonical "still
/// pending" marker. The covering index `(account_id, drive_label,
/// completed_at_ms)` keeps the per-drive "pending count" and totals queries
/// off a full table scan as the table grows across long-running sync
/// sessions. `added_at_ms` is non-NULL so age-based prune policies have a
/// deterministic ordering key.
async fn ensure_sync_intent(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
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
    .execute(&mut *conn)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_sync_intent_drive
            ON sync_intent (account_id, drive_label, completed_at_ms)",
    )
    .execute(&mut *conn)
    .await?;

    // Covering for `totals_for_account` (4 Hz overlay SUM/COUNT).
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_sync_intent_account_bytes
            ON sync_intent (account_id, completed_at_ms, size_bytes)",
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// `sync_file_failures` — durable per-file sync-failure records so the FE can
/// show *why* a file failed (and offer retry) in any listing view, even across
/// restarts. Keyed by `(owner, label, relative_path)`; one row per file, bumped
/// on repeat failures and deleted on success. See `sync::failure_repo`.
async fn ensure_sync_file_failures(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sync_file_failures (
            owner          TEXT    NOT NULL,
            label          TEXT    NOT NULL,
            relative_path  TEXT    NOT NULL,
            file_name      TEXT    NOT NULL,
            kind           TEXT    NOT NULL,
            message        TEXT,
            http_status    INTEGER,
            balance_cents  INTEGER,
            required_cents INTEGER,
            failure_count  INTEGER NOT NULL DEFAULT 1,
            last_failed_at INTEGER NOT NULL,
            dismissed_at   INTEGER,
            PRIMARY KEY (owner, label, relative_path)
        )",
    )
    .execute(&mut *conn)
    .await?;

    // Migration: `dismissed_at` records that the user dismissed the file from
    // the Sync Issues dialog, so the dialog stays closed for it across
    // restarts. Nullable, so existing rows read as never dismissed.
    let cols = table_columns(&mut *conn, "sync_file_failures").await?;
    if !cols.contains("dismissed_at") {
        info!("Adding dismissed_at column to sync_file_failures");
        sqlx::query("ALTER TABLE sync_file_failures ADD COLUMN dismissed_at INTEGER")
            .execute(&mut *conn)
            .await?;
    }

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_sync_file_failures_drive
            ON sync_file_failures (owner, label, last_failed_at DESC)",
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// `folder_entries_local` — per-drive cache of the directory rel-paths this
/// device has registered with the server as first-class folder entities, so the
/// per-cycle reconcile can diff on-disk dirs against it without re-walking and
/// re-sending the whole tree every cycle.
///
/// Scoped by `owner` (the account-key hash) like every other per-drive
/// sync-state table — `sync_paths` (`UNIQUE(owner, label)`) and
/// `sync_file_failures` (`PRIMARY KEY (owner, label, relative_path)`) — because
/// a `label` is unique only *within* an account, and `sync_paths` rows survive
/// logout/login while the app supports account switching. Without `owner`, two
/// accounts on one device that both label a drive "docs" would share rows and
/// the Task 1.13 reconcile would read another account's cached folder set — the
/// cross-account-leak class previously fixed for `notification_preferences` and
/// `address_book`. The composite `PRIMARY KEY (owner, label, relative_path)`
/// also makes "the same directory registered twice for one drive"
/// unrepresentable, which the reconcile delta (register/unregister) relies on
/// for an exact diff. Read/write logic lands with the backfill (Task 1.12) and
/// reconcile (Task 1.13).
async fn ensure_folder_entries_local(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS folder_entries_local (
            owner         TEXT NOT NULL,
            label         TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            PRIMARY KEY (owner, label, relative_path)
        )",
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// `wss_endpoint` — singleton row holding the active blockchain WSS endpoint,
/// seeded with the compiled-in default on first run.
async fn ensure_wss_endpoint(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS wss_endpoint (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            endpoint TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(&mut *conn)
    .await?;

    sqlx::query("INSERT OR IGNORE INTO wss_endpoint (id, endpoint) VALUES (1, ?)")
        .bind(crate::blockchain::client::WSS_ENDPOINT)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// `security_scoped_bookmarks` — macOS file-access persistence (sandbox
/// security-scoped bookmark blobs keyed by path).
async fn ensure_security_scoped_bookmarks(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
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
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// `auth_session` + `oauth_pending_states` — the session store (replaces
/// the frontend IndexedDB "session" table + localStorage tokens; one row
/// per `owner` account key hash) and the restart-safe mirror of in-flight
/// OAuth CSRF states (audit M-2), grouped here because both belong to the
/// login/session domain.
async fn ensure_auth_session(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
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
    .execute(&mut *conn)
    .await?;

    // Pending OAuth flows (CSRF `state` → provider), persisted so an app
    // restart mid-login (auto-update on launch, crash, quit while the
    // browser tab is open) doesn't strand the callback: the in-memory
    // `OAuthState` map is rebuilt from these rows on the next
    // `complete_oauth_flow` (audit M-2). Rows carry a wall-clock
    // timestamp and expire via the same 5-minute TTL as the in-memory
    // entries. No secrets: the `state` value is a single-use random
    // nonce, useless without an in-flight browser session.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS oauth_pending_states (
            state TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL
        )",
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// `hcfs_config` — per-owner HCFS server URL and drive password.
async fn ensure_hcfs_config(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
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
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Encryption-at-rest: add `encryption_version` to `hcfs_config` on older DBs
/// (idempotent — "duplicate column" is expected and suppressed).
async fn ensure_encryption_version_columns(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    // ALTER TABLE ADD COLUMN is idempotent in SQLite — the "duplicate column"
    // error is expected and suppressed for databases that already have the column.
    // (`sub_accounts` was dropped — audit R-35 — so only `hcfs_config` remains.)
    if let Err(e) = sqlx::query("ALTER TABLE hcfs_config ADD COLUMN encryption_version INTEGER NOT NULL DEFAULT 0")
        .execute(&mut *conn)
        .await
    {
        let msg = e.to_string();
        if !msg.contains("duplicate column name") {
            warn!("Schema migration failed: {msg}");
        }
    }
    Ok(())
}

/// `objectstore_auth` + `objectstore_auth_scoped` — API auth token
/// (`temp_auth_key`) and S3 credentials, global and per-owner.
async fn ensure_objectstore_auth(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
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
    .execute(&mut *conn)
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
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// `device_settings` — singleton row holding the friendly device name, seeded
/// from the OS hostname on first run.
async fn ensure_device_settings(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    // Device settings table (singleton row, stores friendly device name)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS device_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            device_name TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(&mut *conn)
    .await?;

    // Seed with OS hostname if no row exists yet
    {
        let existing = sqlx::query("SELECT id FROM device_settings WHERE id = 1")
            .fetch_optional(&mut *conn)
            .await?;
        if existing.is_none() {
            let hostname = hostname::get().map_or_else(|_| "My Device".to_string(), |h| h.to_string_lossy().into_owned());
            sqlx::query("INSERT INTO device_settings (id, device_name) VALUES (1, ?)")
                .bind(&hostname)
                .execute(&mut *conn)
                .await?;
            info!("Device name seeded: {}", hostname);
        }
    }
    Ok(())
}

/// `migration_status` — per-account S3→HCFS migration progress record.
async fn ensure_migration_status(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
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
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// `notifications` — replaces frontend `notificationsDb.ts`, with the
/// user-keyed and `(type, subtype)` covering indexes the dedup/low-credit
/// probes need to avoid full table scans.
async fn ensure_notifications(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
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
    .execute(&mut *conn)
    .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_address)")
        .execute(&mut *conn)
        .await?;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_notifications_user_deleted ON notifications(user_address, is_deleted)")
        .execute(&mut *conn)
        .await?;

    // Credit-dedup and low-credit-warning probes filter on
    // (notification_type, notification_subtype) with NO user_address predicate,
    // so neither user-keyed index above can serve them — every probe was a full
    // table scan. This composite index covers the `type = 'Credits' AND
    // subtype = ?` equality probes and the leading-column equality for the
    // `subtype LIKE 'LowCreditWarning-%'` prefix probes.
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_notifications_type_subtype ON notifications(notification_type, notification_subtype)")
        .execute(&mut *conn)
        .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_notifications_user_list
            ON notifications (user_address, is_deleted, creation_time DESC)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
            ON notifications (user_address, is_deleted, is_unread)",
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// `app_state` — singleton app flags (`is_first_time`, `is_above_half_credit`),
/// seeded on first run.
async fn ensure_app_state(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    // App state (singleton, replaces frontend app_state table)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            is_first_time INTEGER DEFAULT 1,
            is_above_half_credit INTEGER DEFAULT 0
        )",
    )
    .execute(&mut *conn)
    .await?;

    sqlx::query("INSERT OR IGNORE INTO app_state (id, is_first_time, is_above_half_credit) VALUES (1, 1, 0)")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Per-account `notification_preferences` table, in one place so the fresh-DB
/// create and the legacy-table rebuild can never drift.
const NOTIFICATION_PREFERENCES_DDL: &str = "CREATE TABLE notification_preferences (
    owner TEXT NOT NULL,
    id TEXT NOT NULL,
    label TEXT NOT NULL,
    description TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    PRIMARY KEY (owner, id)
)";

/// `notification_preferences` — per-account notification-category toggles.
///
/// Scoped by `owner` (the session ss58 address, matching the sibling
/// `notifications` table) with a composite `(owner, id)` primary key so one
/// account's toggle can't change another account's preferences on a
/// multi-account device. The default `credits`/`files` rows are seeded
/// per-account on demand by the notification commands — NOT here — because the
/// account set isn't known at schema-init time.
///
/// One owning code path for the schema: if a table with an `owner` column
/// already exists we are current and do nothing. Otherwise — the table is
/// absent (fresh DB) or is the legacy global `id`-only table (upgrade) — we
/// (re)create it in the per-account shape. SQLite cannot add a column to a
/// primary key in place, so the legacy table must be dropped and rebuilt; this
/// runs in a nested savepoint (`begin()` on an in-transaction connection issues
/// a `SAVEPOINT`) so a failed rebuild rolls back without aborting schema init.
/// Legacy rows are dropped rather than migrated — they cannot be attributed to
/// a specific account, and the commands re-seed enabled defaults per account on
/// next use, so the only user-visible effect on upgrade is that a
/// previously-disabled category returns to enabled once.
async fn ensure_notification_preferences(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    if table_columns(&mut *conn, "notification_preferences").await?.contains("owner") {
        return Ok(());
    }

    info!("Creating/migrating notification_preferences to per-account (owner, id) scoping");
    let mut sp = conn.begin().await?;
    sqlx::query("DROP TABLE IF EXISTS notification_preferences").execute(&mut *sp).await?;
    sqlx::query(NOTIFICATION_PREFERENCES_DDL).execute(&mut *sp).await?;
    sp.commit().await?;
    Ok(())
}

/// `address_book` — replaces frontend `addressBookDb.ts`, plus the `owner`
/// column migration that scopes contacts per account.
async fn ensure_address_book(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    // Address book (replaces frontend addressBookDb.ts)
    //
    // `owner` scopes contacts to one account (account_key hash, same convention
    // as sync_paths). Pre-existing installs created the table without it; the
    // migration below adds it with DEFAULT '' so legacy rows are owner-empty
    // until the first account to open the address book claims them (see
    // `contacts::claim_legacy_contacts`).
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS address_book (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL,
            wallet_address TEXT NOT NULL,
            date_added INTEGER DEFAULT (strftime('%s','now') * 1000)
        )",
    )
    .execute(&mut *conn)
    .await?;

    // Migration: add `owner` to existing address_book tables. Without this the
    // four contacts IPCs queried the table globally — every account saw every
    // contact, and delete/update by `id` could hit another account's row (IDOR).
    if !table_columns(&mut *conn, "address_book").await?.contains("owner") {
        info!("Adding owner column to address_book");
        sqlx::query("ALTER TABLE address_book ADD COLUMN owner TEXT NOT NULL DEFAULT ''")
            .execute(&mut *conn)
            .await?;
    }
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_address_book_owner_name ON address_book (owner, name)")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// `onboarding` — singleton "is onboarding done" flag, seeded on first run.
async fn ensure_onboarding(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    // Onboarding (replaces frontend onboardingDb.ts)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS onboarding (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            is_done INTEGER DEFAULT 0
        )",
    )
    .execute(&mut *conn)
    .await?;

    sqlx::query("INSERT OR IGNORE INTO onboarding (id, is_done) VALUES (1, 0)")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// `local_wallets` — per-logged-in-account wallet store, scoped via `owner`
/// (mirrors `sync_paths`). See `src-tauri/src/wallet/{crypto,repo,commands}.rs`.
async fn ensure_local_wallets(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    // Migration policy: legacy installs had a global `local_wallets` table with
    // no `owner` column. We drop those rows wholesale on first boot of this build
    // rather than silently attributing them to whichever account logs in first —
    // the wallet password is the only thing that decrypts the mnemonic and we
    // cannot prove who that mnemonic belongs to. Users must re-create/re-import.
    let local_wallets_cols = table_columns(&mut *conn, "local_wallets").await?;
    if !local_wallets_cols.is_empty() && !local_wallets_cols.contains("owner") {
        info!("Dropping legacy unscoped local_wallets table; wallets must be re-created per-account");
        sqlx::query("DROP TABLE local_wallets").execute(&mut *conn).await?;
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
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// `user_preferences` — generic key/value store replacing frontend
/// `userPreferencesDb.ts`.
async fn ensure_user_preferences(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    // User preferences (replaces frontend userPreferencesDb.ts)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS user_preferences (
            preference_key TEXT PRIMARY KEY,
            preference_value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )",
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// `share_keystore` — per-share AEAD key material for the file-sharing feature.
///
/// The `CHECK (length(share_key) = 32)` is defence-in-depth: a wrong-sized
/// key would otherwise surface as an opaque AEAD failure several layers up the
/// stack — see `crate::shares::keystore`.
async fn ensure_share_keystore(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS share_keystore (
            share_token TEXT PRIMARY KEY,
            secret_kind TEXT NOT NULL DEFAULT 'public'
                        CHECK (secret_kind IN ('public', 'private')),
            share_key BLOB NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            -- A public row holds a raw 32-byte share key; a private row holds
            -- the password-wrapped blob, which is strictly longer. Checking
            -- `> 32` rather than the exact 89-byte framing keeps the constraint
            -- from breaking if hcfs-client ever versions the wrap format.
            CHECK (
                (secret_kind = 'public'  AND length(share_key) = 32)
             OR (secret_kind = 'private' AND length(share_key) > 32)
            )
        )",
    )
    .execute(&mut *conn)
    .await?;

    // Pre-`secret_kind` installs have `share_key BLOB CHECK (length = 32)`,
    // which cannot hold a wrapped blob and whose CHECK SQLite cannot drop in
    // place. Rebuild-and-copy is the only way to change it.
    //
    // Every surviving row is copied as 'public'. Shares that were made private
    // under the old Finder flow are indistinguishable here — nothing recorded
    // which ones they were, because that flow stored the raw key either way
    // (the defect this feature fixes). Those rows therefore keep offering a
    // password-free link until they age out. That is bounded and short: every
    // share minted before this release had a fixed 24-hour TTL, so the
    // exposure self-heals within a day of upgrading. Dropping the rows instead
    // would break Copy for legitimately public shares, which is the larger
    // harm for the same window.
    let columns = table_columns(&mut *conn, "share_keystore").await?;
    if !columns.iter().any(|c| c == "secret_kind") {
        sqlx::query(
            "CREATE TABLE share_keystore_rebuild (
                share_token TEXT PRIMARY KEY,
                secret_kind TEXT NOT NULL DEFAULT 'public'
                            CHECK (secret_kind IN ('public', 'private')),
                share_key BLOB NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (unixepoch()),
                CHECK (
                    (secret_kind = 'public'  AND length(share_key) = 32)
                 OR (secret_kind = 'private' AND length(share_key) > 32)
                )
            )",
        )
        .execute(&mut *conn)
        .await?;
        sqlx::query(
            "INSERT INTO share_keystore_rebuild (share_token, secret_kind, share_key, created_at) \
             SELECT share_token, 'public', share_key, created_at FROM share_keystore",
        )
        .execute(&mut *conn)
        .await?;
        sqlx::query("DROP TABLE share_keystore").execute(&mut *conn).await?;
        sqlx::query("ALTER TABLE share_keystore_rebuild RENAME TO share_keystore")
            .execute(&mut *conn)
            .await?;
    }

    Ok(())
}

/// `share_origin` — sidecar of `share_keystore` recording which local file each
/// share was minted from (never leaves the device).
///
/// Lets the UI answer "is this file currently shared?" and "reshare the same
/// file with a fresh TTL" — questions the keystore can't. `owner` is the same
/// `account_key` hash `sync_paths` uses, so a per-account prune in
/// `hcfs_list_shares` can scope safely without touching another account's rows.
async fn ensure_share_origin(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS share_origin (
            share_token TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            folder_label TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS share_origin_owner_idx ON share_origin (owner, folder_label)")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// `bridge_transactions` — locally-tracked Alpha↔hAlpha bridge submissions
/// (replaces the renderer's localStorage tracker, audit TSLOGIC-7). Owner-scoped
/// by `account_key`; the chain explorer reads are the authoritative status, this
/// just records what this device submitted (incl. a pending row until the chain
/// reflects it). The `(owner, created_at)` index keeps the DESC list off a scan.
async fn ensure_bridge_transactions(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS bridge_transactions (
            id              TEXT PRIMARY KEY,
            owner           TEXT NOT NULL,
            direction       TEXT NOT NULL,
            status          TEXT NOT NULL,
            amount          TEXT NOT NULL,
            sender          TEXT,
            recipient       TEXT,
            source_tx_hash  TEXT,
            deposit_id      TEXT,
            withdrawal_id   TEXT,
            created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
            error           TEXT
        )",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS bridge_transactions_owner_idx ON bridge_transactions (owner, created_at)")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// `credit_notification_flags` — per-account low-credit notification state
/// (`is_first_time`, `is_above_half_credit`), owner-scoped by `account_key`
/// (audit NOTIF-4). These were a single global `app_state` row, so on a
/// multi-account device one account's first-time/above-half state leaked into
/// another's credit warnings. A missing row means defaults (first_time=1,
/// above_half=0), so a brand-new account starts fresh without seeding.
async fn ensure_credit_notification_flags(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS credit_notification_flags (
            owner                TEXT PRIMARY KEY,
            is_first_time        INTEGER NOT NULL DEFAULT 1,
            is_above_half_credit INTEGER NOT NULL DEFAULT 0
        )",
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// `shared_link_history` — per-device snapshot of share tokens that have left
/// the active set (expired/revoked).
///
/// The composite PRIMARY KEY makes `record_event` idempotent under repeat
/// diffs without per-device coordination, and the `(account_id, ended_at)`
/// index keeps the DESC list query off a full scan as the table grows. See
/// `crate::shares::history` for the module-level rationale and lifecycle.
async fn ensure_shared_link_history(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
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
            -- NULL when the share never expired and was ended by revocation.
            expires_at     TEXT,
            ended_at       TEXT NOT NULL,
            end_reason     TEXT NOT NULL,
            PRIMARY KEY (account_id, share_token)
        )",
    )
    .execute(&mut *conn)
    .await?;

    // Installs predating expiry presets declared `expires_at TEXT NOT NULL`,
    // which cannot record a never-expiring share. SQLite has no ALTER TABLE
    // for dropping NOT NULL, so relax it by rebuild-and-copy. Existing rows
    // all carry a real timestamp (every share had a fixed 24-hour TTL back
    // then), so the copy is lossless.
    if column_is_not_null(&mut *conn, "shared_link_history", "expires_at").await? {
        sqlx::query(
            "CREATE TABLE shared_link_history_rebuild (
                account_id     TEXT NOT NULL,
                share_token    TEXT NOT NULL,
                filename       TEXT,
                folder_label   TEXT,
                relative_path  TEXT,
                plaintext_size INTEGER,
                mime_type      TEXT,
                created_at     TEXT NOT NULL,
                expires_at     TEXT,
                ended_at       TEXT NOT NULL,
                end_reason     TEXT NOT NULL,
                PRIMARY KEY (account_id, share_token)
            )",
        )
        .execute(&mut *conn)
        .await?;
        sqlx::query(
            "INSERT INTO shared_link_history_rebuild \
             SELECT account_id, share_token, filename, folder_label, relative_path, \
                    plaintext_size, mime_type, created_at, expires_at, ended_at, end_reason \
             FROM shared_link_history",
        )
        .execute(&mut *conn)
        .await?;
        sqlx::query("DROP TABLE shared_link_history").execute(&mut *conn).await?;
        sqlx::query("ALTER TABLE shared_link_history_rebuild RENAME TO shared_link_history")
            .execute(&mut *conn)
            .await?;
    }

    sqlx::query("CREATE INDEX IF NOT EXISTS shared_link_history_account_ended_idx ON shared_link_history (account_id, ended_at DESC)")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Whether `table.column` is declared `NOT NULL`.
///
/// Used to detect pre-migration table shapes that need a rebuild, since
/// SQLite cannot relax a NOT NULL constraint in place. Returns `false` for a
/// missing table or column — callers only use this to decide whether a
/// rebuild is *needed*, and a table that does not exist yet was just created
/// with the current shape.
async fn column_is_not_null(conn: &mut SqliteConnection, table: &str, column: &str) -> Result<bool, sqlx::Error> {
    // PRAGMA does not accept bound parameters for the table name, and `table`
    // is always a hard-coded literal at every call site — never user input.
    let rows: Vec<(String, i64)> = sqlx::query_as(&format!("SELECT name, \"notnull\" FROM pragma_table_info('{table}')"))
        .fetch_all(&mut *conn)
        .await?;
    Ok(rows.iter().any(|(name, notnull)| name == column && *notnull != 0))
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

            // Selection criterion: a table belongs here iff it BOTH (a) carries
            // an `owner` column keyed by the account hash AND (b) predates the
            // legacy 8-char key era, so it can actually hold a row under a legacy
            // `owner` that needs renaming.
            //
            // Excluded for (a): `notifications` (keyed by `user_address` = raw
            // ss58) and `user_preferences` (keyed by `preference_key`, a global
            // k/v store) have NO `owner` column, so `UPDATE … SET owner` errors
            // with "no such column: owner". Including them would make the
            // `?`-propagation below roll the migration back on that guaranteed
            // error EVERY run, permanently breaking every legacy account.
            //
            // Excluded for (b): `local_wallets` and `share_origin` DO have an
            // `owner` column, but both were introduced AFTER the legacy→16-char
            // migration shipped, so they only ever stored 16-char keys and hold
            // no legacy rows to rename. Deliberately omitted — do not "fix" the
            // list by adding them.
            let tables = ["auth_session", "objectstore_auth_scoped", "sync_paths", "address_book", "hcfs_config"];

            for table in tables {
                // Use explicit per-table queries to avoid SQL injection.
                let query = format!("UPDATE {table} SET owner = ? WHERE owner = ?");
                // Propagate any error via `?` so the whole transaction rolls
                // back. Every table in the list above carries an `owner` column
                // and is created by ensure_table_schema before this migration
                // runs (main.rs setup, guarded by the EXPECTED_TABLES test), so
                // an error here is a genuine failure — e.g. a UNIQUE(owner,
                // label) collision on sync_paths — not a missing table/column.
                // Propagating it (rather than swallowing) keeps the whole
                // migration atomic: swallowing would commit the other tables
                // and split one account across the legacy and new owner keys.
                let r = sqlx::query(&query).bind(&new_key).bind(&legacy).execute(&mut *tx).await?;
                if r.rows_affected() > 0 {
                    info!("Updated {} row(s) in {}", r.rows_affected(), table);
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

    /// Migration guard: a legacy `address_book` created before the `owner`
    /// column must gain it (DEFAULT '') when `ensure_table_schema` runs, and
    /// pre-existing rows keep `owner = ''` so the first account can later claim
    /// them (see `auth::contacts::claim_legacy_contacts`). Without the ALTER,
    /// the four contacts IPCs would query a non-existent column and fail.
    #[tokio::test]
    async fn address_book_owner_added_to_legacy_table() {
        let pool = temp_pool().await;

        // Legacy install: address_book WITHOUT the owner column, one seeded row.
        sqlx::query(
            "CREATE TABLE address_book (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                wallet_address TEXT NOT NULL,
                date_added INTEGER
            )",
        )
        .execute(&pool)
        .await
        .expect("create legacy table");
        sqlx::query("INSERT INTO address_book (name, wallet_address) VALUES ('Legacy', 'addrL')")
            .execute(&pool)
            .await
            .expect("seed legacy row");

        ensure_table_schema(&pool).await.expect("schema");

        // If the migration didn't add `owner`, this SELECT errors. The value
        // proves both the column's existence and its '' default (claimable).
        let (owner,): (String,) = sqlx::query_as("SELECT owner FROM address_book WHERE name = 'Legacy'")
            .fetch_one(&pool)
            .await
            .expect("legacy row must have an owner column after migration");
        assert_eq!(owner, "", "legacy rows must default to empty owner for first-account claim");
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

    #[tokio::test]
    async fn ensure_table_schema_creates_perf_indexes() {
        let pool = temp_pool().await;
        ensure_table_schema(&pool).await.expect("schema");
        let names: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'index'")
            .fetch_all(&pool)
            .await
            .expect("index list");
        for needed in [
            "idx_sync_intent_account_bytes",
            "idx_notifications_user_list",
            "idx_notifications_user_unread",
            "idx_address_book_owner_name",
        ] {
            assert!(names.iter().any(|n| n == needed), "missing index {needed} in {names:?}");
        }
    }

    /// Names of the legacy Nebula tables earlier releases created in
    /// `ensure_table_schema`. Kept in sync with the array in
    /// [`drop_legacy_nebula_tables`] — if those names diverge, this test
    /// stops exercising the helper.
    const LEGACY_NEBULA_TABLES: &[&str] = &["vpn_status", "nebula_binary_status", "nebula_certificate", "autoconnect_vpn_enabled"];

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
        assert!(after.contains("sync_paths"), "canonical schema missing after drop+init: {after:?}");
        // The dead `sub_accounts` table must NOT be (re)created (audit R-35).
        assert!(!after.contains("sub_accounts"), "dropped sub_accounts table was recreated: {after:?}");
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
        for required in [
            "owner",
            "path",
            "type",
            "label",
            "timestamp",
            "is_paused",
            "relative_paths_backfilled_at",
            "folder_entries_backfilled_at",
            "owner_ss58",
            "wire_folder_hash",
        ] {
            assert!(names.contains(required), "sync_paths missing column `{required}`; present: {names:?}");
        }
    }

    /// The `UNIQUE(owner, label)` constraint-swap migration must PRESERVE the
    /// user's `is_paused` intent and the `relative_paths_backfilled_at` audit
    /// breadcrumb across the table rebuild. If the swap dropped either, a paused
    /// drive would be silently un-paused and the one-shot backfill would
    /// re-trigger on a DB created with the legacy `UNIQUE(owner, type)` DDL.
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
                owner_ss58 TEXT,
                wire_folder_hash TEXT,
                UNIQUE(owner, type)
            )",
        )
        .execute(&pool)
        .await
        .expect("seed legacy sync_paths");
        sqlx::query(
            "INSERT INTO sync_paths (owner, path, type, label, timestamp, is_paused, relative_paths_backfilled_at, owner_ss58, wire_folder_hash)
             VALUES ('5Owner', '/data/Hippius', 'private', 'mylabel', 100, 1, 12345, '5DriveOwner', '0123456789abcdef')",
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

        // ...and the user's pause intent, backfill breadcrumb, and shared-drive
        // wire identity all survived it.
        type MigratedRow = (i64, Option<i64>, Option<String>, Option<String>);
        let (is_paused, backfilled, owner_ss58, wire_folder_hash): MigratedRow =
            sqlx::query_as("SELECT is_paused, relative_paths_backfilled_at, owner_ss58, wire_folder_hash FROM sync_paths WHERE owner = '5Owner'")
                .fetch_one(&pool)
                .await
                .expect("read migrated row");
        assert_eq!(is_paused, 1, "paused drive must stay paused across the constraint swap");
        assert_eq!(backfilled, Some(12345), "relative_paths_backfilled_at must survive the constraint swap");
        assert_eq!(owner_ss58.as_deref(), Some("5DriveOwner"), "owner_ss58 must survive the constraint swap");
        assert_eq!(
            wire_folder_hash.as_deref(),
            Some("0123456789abcdef"),
            "wire_folder_hash must survive the constraint swap — dropping it turns a member drive into an own drive"
        );
    }

    /// The credit-dedup / low-credit probes filter on
    /// (notification_type, notification_subtype) with no user_address, so they
    /// need a composite index leading with those columns or they full-scan.
    #[tokio::test]
    async fn notifications_has_type_subtype_index() {
        let pool = temp_pool().await;
        ensure_table_schema(&pool).await.expect("ensure_table_schema failed");
        let idx: Option<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_notifications_type_subtype'")
            .fetch_optional(&pool)
            .await
            .expect("query index");
        assert_eq!(idx.as_deref(), Some("idx_notifications_type_subtype"));
    }

    /// Regression pin: a per-table UPDATE failure during account-key migration
    /// must roll back the WHOLE transaction, not commit the tables that already
    /// succeeded. Forces a `UNIQUE(owner, label)` collision on `sync_paths`
    /// (updated AFTER `auth_session` in the loop) and asserts `auth_session`
    /// was not partially migrated — proving atomicity. Without it, a swallowed
    /// collision would commit anyway, splitting one account across the legacy
    /// and new owner keys.
    #[tokio::test]
    async fn account_key_migration_rolls_back_on_collision() {
        use crate::auth::account_key::{account_key, account_key_legacy};

        let pool = temp_pool().await;
        ensure_table_schema(&pool).await.expect("schema");

        let addr = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
        let legacy = account_key_legacy(addr);
        let new_key = account_key(addr);
        assert_ne!(legacy, new_key, "legacy and new keys must differ for the migration to trigger");

        // A legacy-keyed session is what makes the migration adopt this address.
        sqlx::query("INSERT INTO auth_session (owner, substrate_address) VALUES (?, ?)")
            .bind(&legacy)
            .bind(addr)
            .execute(&pool)
            .await
            .expect("seed legacy session");

        // sync_paths is updated after auth_session. Seed a legacy row AND a
        // new-key row sharing the label, so renaming the legacy row's owner to
        // new_key violates UNIQUE(owner, label) mid-transaction.
        sqlx::query("INSERT INTO sync_paths (owner, path, type, label, timestamp) VALUES (?, '/legacy', 'folder', 'L', 0)")
            .bind(&legacy)
            .execute(&pool)
            .await
            .expect("seed legacy sync_path");
        sqlx::query("INSERT INTO sync_paths (owner, path, type, label, timestamp) VALUES (?, '/new', 'folder', 'L', 0)")
            .bind(&new_key)
            .execute(&pool)
            .await
            .expect("seed colliding new-key sync_path");

        // The migration must surface the collision as Err...
        let result = migrate_account_keys(&pool).await;
        assert!(result.is_err(), "a UNIQUE collision must surface as Err, not a silent partial commit");

        // ...and auth_session (updated first) must be rolled back to the legacy
        // key — if it were new_key, the transaction had partially committed.
        let (owner,): (String,) = sqlx::query_as("SELECT owner FROM auth_session WHERE substrate_address = ?")
            .bind(addr)
            .fetch_one(&pool)
            .await
            .expect("session row still present");
        assert_eq!(owner, legacy, "auth_session must NOT be partially migrated when a later table collides");
    }

    /// Regression pin: the no-collision happy path must COMMIT — every
    /// owner-bearing table moves legacy→new. Only tables that actually have an
    /// `owner` column may be in the migration list; including a columnless
    /// table like `notifications`/`user_preferences` would make `?`-propagation
    /// roll the whole migration back every run on a guaranteed "no such column:
    /// owner" error, so a legacy account would never be migrated.
    #[tokio::test]
    async fn account_key_migration_commits_clean_owner_bearing_tables() {
        use crate::auth::account_key::{account_key, account_key_legacy};

        let pool = temp_pool().await;
        ensure_table_schema(&pool).await.expect("schema");

        let addr = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
        let legacy = account_key_legacy(addr);
        let new_key = account_key(addr);

        // Legacy-keyed rows across three owner-bearing tables, no collisions.
        sqlx::query("INSERT INTO auth_session (owner, substrate_address) VALUES (?, ?)")
            .bind(&legacy)
            .bind(addr)
            .execute(&pool)
            .await
            .expect("seed session");
        sqlx::query("INSERT INTO sync_paths (owner, path, type, label, timestamp) VALUES (?, '/p', 'folder', 'L', 0)")
            .bind(&legacy)
            .execute(&pool)
            .await
            .expect("seed sync_path");
        sqlx::query("INSERT INTO address_book (owner, name, wallet_address) VALUES (?, 'Alice', 'addr1')")
            .bind(&legacy)
            .execute(&pool)
            .await
            .expect("seed contact");

        // Must COMMIT, not roll back on a phantom columnless-table error.
        migrate_account_keys(&pool).await.expect("clean migration must commit");

        // Every owner-bearing table moved legacy → new_key.
        for (table, where_col, where_val) in [
            ("auth_session", "substrate_address", addr),
            ("sync_paths", "path", "/p"),
            ("address_book", "name", "Alice"),
        ] {
            let (owner,): (String,) = sqlx::query_as(&format!("SELECT owner FROM {table} WHERE {where_col} = ?"))
                .bind(where_val)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("row in {table} must exist: {e}"));
            assert_eq!(owner, new_key, "{table}.owner must be migrated to the new key");
        }
    }

    /// Schema pin for the first-class-empty-folders feature: the per-drive
    /// directory cache `folder_entries_local` and the `sync_paths`
    /// `folder_entries_backfilled_at` breadcrumb must both materialize from a
    /// fresh `ensure_table_schema` run.
    ///
    /// Exercises the SQLite contract this schema relies on, not Rust analogues
    /// (axiom 110): the composite `PRIMARY KEY (owner, label, relative_path)`
    /// raises a UNIQUE/PRIMARY KEY violation on a duplicate triple (SQLite
    /// `SQLITE_CONSTRAINT_PRIMARYKEY`, surfaced through `is_unique_violation`)
    /// while leaving a distinct rel-path, a distinct label, or — critically — the
    /// same `(label, relative_path)` under a DIFFERENT owner as separate rows
    /// (the account-scoping guard); and the nullable `INTEGER` column round-trips
    /// both a written timestamp and a NULL (the set-once "not yet backfilled"
    /// marker, mirroring `relative_paths_backfilled_at`).
    #[tokio::test]
    async fn folder_entries_local_table_and_backfill_flag_exist() {
        let pool = temp_pool().await;
        ensure_table_schema(&pool).await.expect("ensure_table_schema failed");

        // The table exists and accepts an (owner, label, relative_path) row.
        sqlx::query("INSERT INTO folder_entries_local (owner, label, relative_path) VALUES ('5Alice', 'docs', 'a/b')")
            .execute(&pool)
            .await
            .expect("folder_entries_local must accept an insert");

        // A distinct rel-path under the same drive, and a distinct label, are
        // separate rows — the PK is the (owner, label, relative_path) triple.
        sqlx::query("INSERT INTO folder_entries_local (owner, label, relative_path) VALUES ('5Alice', 'docs', 'a/c')")
            .execute(&pool)
            .await
            .expect("distinct relative_path under the same drive is a new row");
        sqlx::query("INSERT INTO folder_entries_local (owner, label, relative_path) VALUES ('5Alice', 'photos', 'a/b')")
            .execute(&pool)
            .await
            .expect("distinct label under the same owner is a new row");

        // Account-scoping guard: the SAME (label, relative_path) under a DIFFERENT
        // owner is a separate row, so two accounts that both label a drive "docs"
        // never share folder-cache rows (the cross-account leak this scoping
        // prevents).
        sqlx::query("INSERT INTO folder_entries_local (owner, label, relative_path) VALUES ('5Bob', 'docs', 'a/b')")
            .execute(&pool)
            .await
            .expect("same (label, relative_path) under a different owner is a new row");

        // Re-inserting the SAME (owner, label, relative_path) must be a UNIQUE/PK
        // violation specifically — not an incidental NOT NULL or other error.
        let dup = sqlx::query("INSERT INTO folder_entries_local (owner, label, relative_path) VALUES ('5Alice', 'docs', 'a/b')")
            .execute(&pool)
            .await;
        match dup {
            Err(sqlx::Error::Database(e)) => assert!(
                e.is_unique_violation(),
                "duplicate (owner, label, relative_path) must be a UNIQUE/PRIMARY KEY violation; got: {e}"
            ),
            other => panic!("expected a database unique violation on duplicate PK, got: {other:?}"),
        }

        // sync_paths gained the nullable folder_entries_backfilled_at column.
        let cols = sqlx::query("PRAGMA table_info(sync_paths)")
            .fetch_all(&pool)
            .await
            .expect("PRAGMA failed");
        let names: HashSet<String> = cols.iter().map(|r| r.get::<String, _>("name")).collect();
        assert!(
            names.contains("folder_entries_backfilled_at"),
            "sync_paths missing column `folder_entries_backfilled_at`; present: {names:?}"
        );

        // The column round-trips a written timestamp and a NULL.
        sqlx::query(
            "INSERT INTO sync_paths (owner, path, type, label, timestamp, folder_entries_backfilled_at)
             VALUES ('o', '/p1', 'private', 'set', 1, 4242)",
        )
        .execute(&pool)
        .await
        .expect("insert row with a set backfill timestamp");
        sqlx::query("INSERT INTO sync_paths (owner, path, type, label, timestamp) VALUES ('o', '/p2', 'private', 'unset', 2)")
            .execute(&pool)
            .await
            .expect("insert row leaving the backfill timestamp NULL");

        let set: Option<i64> = sqlx::query_scalar("SELECT folder_entries_backfilled_at FROM sync_paths WHERE label = 'set'")
            .fetch_one(&pool)
            .await
            .expect("read the set row");
        let unset: Option<i64> = sqlx::query_scalar("SELECT folder_entries_backfilled_at FROM sync_paths WHERE label = 'unset'")
            .fetch_one(&pool)
            .await
            .expect("read the unset row");
        assert_eq!(set, Some(4242), "a written backfill timestamp must round-trip");
        assert_eq!(unset, None, "an unwritten backfill timestamp must read back NULL");
    }
}
