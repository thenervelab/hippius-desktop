//! Sync path CRUD — manages the `sync_paths` SQLite table.
//!
//! Maps local directories to labeled drive slots. Includes overlap validation
//! to prevent conflicting folder hierarchies.

use crate::auth::account_key::account_key;
use crate::error::Result;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::sqlite::SqlitePool;
use std::path::Path;
use tracing::{info, warn};

/// Parameters for registering or updating a sync folder via IPC.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSyncPathParams {
    pub path: String,
    pub is_public: bool,
    pub account_id: String,
    pub label: Option<String>,
}

/// Parameters for querying sync paths via IPC.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSyncPathParams {
    pub is_public: bool,
    pub account_id: Option<String>,
}

/// A configured sync path with its label and pause state.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncPathResult {
    pub path: String,
    pub is_public: bool,
    pub label: String,
    pub is_paused: bool,
}

/// Reject a new sync path if it overlaps (is a parent or child of) any existing sync path.
///
/// Async because `canonicalize` is a blocking syscall (`realpath`) that can take
/// 10–100 ms on a slow/network filesystem; running it on the tokio worker thread
/// blocks every other IPC handler. Falls back to the raw `Path` if the file
/// doesn't exist (e.g. during validation of a path the user just typed),
/// preserving the prefix-matching semantics tested by the unit tests below.
async fn validate_no_path_overlap(canonical_new: &Path, new_label: &str, existing: &[(String, String)]) -> Result<()> {
    for (label, path_str) in existing {
        if label == new_label {
            continue;
        }
        let existing_path = Path::new(path_str);
        let canonical_existing = tokio::fs::canonicalize(existing_path)
            .await
            .unwrap_or_else(|_| existing_path.to_path_buf());

        if canonical_new.starts_with(&canonical_existing) {
            return Err(crate::error::AppError::Validation(format!(
                "This folder is already being synced as part of '{label}'"
            )));
        }
        if canonical_existing.starts_with(canonical_new) {
            return Err(crate::error::AppError::Validation(format!(
                "This folder contains '{label}' which is already being synced separately. \
                 Remove it first if you want to sync the parent folder instead."
            )));
        }
    }
    Ok(())
}

/// How [`set_sync_path_internal`] resolves the drive label while it holds the
/// `BEGIN IMMEDIATE` write lock.
///
/// Modeling this as an enum — instead of the old implicit "the caller already
/// suffixed a unique label and passes it in" convention — is the F-1 fix.
/// `add_local_sync_folder` used to read existing labels, pick a unique one,
/// then call this function; but that read ran OUTSIDE this transaction, so two
/// concurrent adds both computed the same label and the second's
/// `ON CONFLICT DO UPDATE` silently rewrote the first drive's path (data loss).
/// `Allocate` moves the suffixing inside the lock; `Exact` keeps the upsert the
/// set/update callers depend on.
#[derive(Clone, Copy, Debug)]
pub(crate) enum LabelMode<'a> {
    /// Use this exact label, upserting the path if an `(owner, label)` row
    /// already exists — the set/update path (default drive, migration restore,
    /// explicit folder re-point).
    Exact(&'a str),
    /// Allocate a fresh, collision-free label by suffixing `base` against the
    /// labels read in THIS transaction, then plain-`INSERT`. The
    /// add-a-new-drive path — it never rewrites an existing drive's path.
    Allocate { base: &'a str },
}

/// Core DB upsert + macOS bookmark logic. Returns the label actually written
/// (for `Allocate`, the suffixed label such as `tags-2`).
pub(crate) async fn set_sync_path_internal(pool: &SqlitePool, account_id: &str, path: &str, is_public: bool, mode: LabelMode<'_>) -> Result<String> {
    let path_type = if is_public { "public" } else { "private" };
    let timestamp = Utc::now().timestamp();
    let owner = account_key(account_id);

    // Canonicalize the *new* path before taking the write lock. `realpath`
    // can take 10–100 ms on a slow volume; holding BEGIN IMMEDIATE across
    // that stalls every other SQLite writer. Existing-drive canonicalizes
    // stay inside the lock (there are a handful of them).
    let new_fs_path = Path::new(path);
    let canonical_new = tokio::fs::canonicalize(new_fs_path).await.unwrap_or_else(|_| new_fs_path.to_path_buf());

    // Run the overlap check, label allocation, and the writes inside ONE
    // `BEGIN IMMEDIATE` transaction so the read-then-act is serialized against
    // concurrent writers. A default `pool.begin()` is DEFERRED — it takes the
    // write lock only on the first write, leaving the SELECT-then-INSERT window
    // open — so we issue `BEGIN IMMEDIATE` to acquire the write lock up front.
    // All errors are routed through the inner block so the connection is never
    // returned to the pool with an open transaction (every path COMMITs or
    // ROLLBACKs).
    let mut conn = pool.acquire().await.map_err(crate::error::AppError::Db)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(crate::error::AppError::Db)?;

    let res: Result<String> = async {
        let rows = sqlx::query("SELECT label, path FROM sync_paths WHERE owner = ?")
            .bind(&owner)
            .fetch_all(&mut *conn)
            .await
            .map_err(crate::error::AppError::Db)?;

        let existing: Vec<(String, String)> = rows.iter().map(|r| (r.get("label"), r.get("path"))).collect();

        // Resolve the label UNDER the write lock. For `Allocate`, suffixing here
        // against this transaction's own read (not in the caller) is what closes
        // the F-1 TOCTOU: a concurrent add is serialized by `BEGIN IMMEDIATE`,
        // so it observes this row and picks the next suffix instead of colliding.
        let label: String = match mode {
            LabelMode::Exact(l) => l.to_string(),
            LabelMode::Allocate { base } => {
                let taken: std::collections::HashSet<String> = existing.iter().map(|(l, _)| l.clone()).collect();
                generate_unique_label_internal(&taken, base)
            }
        };

        validate_no_path_overlap(&canonical_new, &label, &existing).await?;

        match mode {
            LabelMode::Exact(_) => {
                // Adopt a pre-multi-drive ownerless row of this type so the
                // legacy default drive keeps its id across the migration.
                if let Ok(Some(legacy_id)) = sqlx::query_scalar::<_, i64>("SELECT id FROM sync_paths WHERE owner = '' AND type = ? LIMIT 1")
                    .bind(path_type)
                    .fetch_optional(&mut *conn)
                    .await
                    && let Err(e) = sqlx::query("REPLACE INTO sync_paths (id, owner, path, type, label, timestamp) VALUES (?, ?, ?, ?, ?, ?)")
                        .bind(legacy_id)
                        .bind(&owner)
                        .bind(path)
                        .bind(path_type)
                        .bind(&label)
                        .bind(timestamp)
                        .execute(&mut *conn)
                        .await
                {
                    warn!("Failed to replace legacy sync_paths row: {e}");
                }

                sqlx::query(
                    "INSERT INTO sync_paths (owner, path, type, label, timestamp) VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT(owner, label) DO UPDATE SET path=excluded.path, type=excluded.type, timestamp=excluded.timestamp",
                )
                .bind(&owner)
                .bind(path)
                .bind(path_type)
                .bind(&label)
                .bind(timestamp)
                .execute(&mut *conn)
                .await
                .map_err(crate::error::AppError::Db)?;
            }
            LabelMode::Allocate { .. } => {
                // Fresh drive: a plain INSERT. The label was just suffixed unique
                // against this transaction's own read, so it cannot conflict; the
                // UNIQUE(owner, label) constraint is the backstop that turns any
                // future regression into a hard error rather than a silent path
                // overwrite.
                sqlx::query("INSERT INTO sync_paths (owner, path, type, label, timestamp) VALUES (?, ?, ?, ?, ?)")
                    .bind(&owner)
                    .bind(path)
                    .bind(path_type)
                    .bind(&label)
                    .bind(timestamp)
                    .execute(&mut *conn)
                    .await
                    .map_err(crate::error::AppError::Db)?;
            }
        }
        Ok(label)
    }
    .await;

    // Commit or roll back, carrying the resolved label out on success.
    let committed: Result<String> = match res {
        Ok(label) => match sqlx::query("COMMIT").execute(&mut *conn).await {
            Ok(_) => Ok(label),
            Err(e) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                warn!("DB commit failed for owner {owner} type {path_type}: {e}");
                Err(crate::error::AppError::Db(e))
            }
        },
        Err(e) => {
            // Best-effort rollback; surface the original error regardless.
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(e)
        }
    };

    // Release the transaction's connection before store_bookmark acquires its
    // own from the pool (avoids contention on a small pool).
    drop(conn);

    let label = committed?;
    info!("Sync path for '{path_type}' set successfully in DB (label '{label}')");

    #[cfg(target_os = "macos")]
    {
        use crate::utils::bookmarks::store_bookmark;
        if let Err(e) = store_bookmark(pool, path, path_type).await {
            warn!("Failed to create security-scoped bookmark: {e}");
        }
    }

    Ok(label)
}

/// Set or update a sync path for an account, expanding the asset protocol scope.
#[tauri::command]
pub async fn set_sync_path(
    state: tauri::State<'_, crate::app_state::AppState>,
    app_handle: tauri::AppHandle,
    params: SetSyncPathParams,
) -> Result<String> {
    info!(
        "Setting sync path for label '{}': path='{}', is_public={}",
        params.label.as_deref().unwrap_or("default"),
        params.path,
        params.is_public
    );
    // `set_sync_path` is a Tauri command that fires after the user has
    // already authenticated; login flows are the only writers to
    // `AuthInfo`. No need to touch active account state here.
    let pool = state.pool()?;
    let path_type = if params.is_public { "public" } else { "private" };
    // The command always targets an explicit label (or the default drive), so
    // it upserts via `Exact`; only the multi-drive add path needs `Allocate`.
    set_sync_path_internal(
        pool,
        &params.account_id,
        &params.path,
        params.is_public,
        LabelMode::Exact(params.label.as_deref().unwrap_or("default")),
    )
    .await?;

    crate::sync::files::allow_asset_directory(&app_handle, &params.path);

    info!("Sync path set successfully for label '{}'", params.label.as_deref().unwrap_or("default"));
    Ok(format!("Sync path for '{path_type}' set successfully."))
}

/// Fetch a single sync path by type for the given account.
pub async fn get_sync_path_internal(pool: &SqlitePool, is_public: bool, owner: &str) -> Result<SyncPathResult> {
    let path_type = if is_public { "public" } else { "private" };
    {
        let row = sqlx::query("SELECT path, label, is_paused FROM sync_paths WHERE owner = ? AND type = ? LIMIT 1")
            .bind(owner)
            .bind(path_type)
            .fetch_optional(pool)
            .await
            .map_err(crate::error::AppError::Db)?;

        if let Some(row) = row {
            let paused_int: i32 = row.try_get("is_paused").unwrap_or(0);
            return Ok(SyncPathResult {
                path: row.get("path"),
                is_public,
                label: row.try_get("label").unwrap_or_else(|_| "default".to_string()),
                is_paused: paused_int != 0,
            });
        }
    }

    // Legacy fallback: try migrating an ownerless row
    let legacy_row = sqlx::query("SELECT id, path FROM sync_paths WHERE owner = '' AND type = ? LIMIT 1")
        .bind(path_type)
        .fetch_optional(pool)
        .await
        .map_err(crate::error::AppError::Db)?;

    if let Some(legacy) = legacy_row {
        let has_scoped = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sync_paths WHERE owner = ? AND owner != ''")
            .bind(owner)
            .fetch_one(pool)
            .await
            .unwrap_or(1);

        if has_scoped == 0 {
            let legacy_id: i64 = legacy.get("id");
            let legacy_path: String = legacy.get("path");
            let timestamp = Utc::now().timestamp();

            if let Err(e) = sqlx::query("UPDATE sync_paths SET owner = ?, timestamp = ? WHERE id = ?")
                .bind(owner)
                .bind(timestamp)
                .bind(legacy_id)
                .execute(pool)
                .await
            {
                warn!("Failed to migrate legacy sync path: {e}");
            } else {
                info!("Migrated legacy {path_type} sync path for owner {owner}");
                return Ok(SyncPathResult {
                    path: legacy_path,
                    is_public,
                    label: "default".to_string(),
                    is_paused: false,
                });
            }
        }
    }

    // "Not configured yet" is a NotFound (the requested sync path doesn't
    // exist), NOT a NotReady: NotReady is silenced by the FE's
    // `isExpectedNoSessionError`, and this error must stay surfaced. NotFound
    // keeps the message verbatim while giving the FE a stable `kind`.
    Err(crate::error::AppError::NotFound(format!("{path_type} sync path not set yet")))
}

/// Fetch a single sync path via IPC.
#[tauri::command]
pub async fn get_sync_path(state: tauri::State<'_, crate::app_state::AppState>, params: GetSyncPathParams) -> Result<SyncPathResult> {
    let Some(account_id) = params.account_id.or_else(|| state.current_account_id().ok()) else {
        return Ok(SyncPathResult {
            path: String::new(),
            is_public: params.is_public,
            label: "default".to_string(),
            is_paused: false,
        });
    };
    let owner = account_key(&account_id);
    get_sync_path_internal(state.pool()?, params.is_public, &owner).await
}

/// Pure helper: pick the first non-conflicting label by appending a numeric
/// suffix when `base` already exists in `existing`.
///
/// Called by `set_sync_path_internal` under the write lock (`Allocate` mode) so
/// the folder-uniqueness loop has exactly one source of truth and runs inside
/// the same transaction as the insert — closing the F-1 TOCTOU.
pub(crate) fn generate_unique_label_internal(existing: &std::collections::HashSet<String>, base: &str) -> String {
    let mut label = base.to_string();
    let mut suffix = 2u32;
    while existing.contains(&label) {
        label = format!("{base}-{suffix}");
        suffix += 1;
    }
    label
}

#[cfg(test)]
mod label_tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn returns_base_when_no_conflict() {
        let existing = HashSet::new();
        assert_eq!(generate_unique_label_internal(&existing, "Photos"), "Photos");
    }

    #[test]
    fn appends_numeric_suffix_on_conflict() {
        let mut existing = HashSet::new();
        existing.insert("Photos".to_string());
        assert_eq!(generate_unique_label_internal(&existing, "Photos"), "Photos-2");
    }

    #[test]
    fn keeps_incrementing_until_free() {
        let mut existing = HashSet::new();
        existing.insert("Photos".to_string());
        existing.insert("Photos-2".to_string());
        existing.insert("Photos-3".to_string());
        assert_eq!(generate_unique_label_internal(&existing, "Photos"), "Photos-4");
    }
}

/// All configured drive roots for an account as `(label, on-disk path)`,
/// skipping the internal `migration` pseudo-drive. Used by the file-manager
/// bridge to register monitored roots and to resolve a clicked path to its
/// drive — `unix`-gated because that bridge (macOS + Linux) is its only caller
/// (un-gated it would be dead code on the Windows build).
#[cfg(any(unix, windows))]
pub(crate) async fn list_drive_roots(pool: &SqlitePool, account_id: &str) -> Result<Vec<(String, std::path::PathBuf)>> {
    let owner = account_key(account_id);
    let rows = sqlx::query("SELECT label, path FROM sync_paths WHERE owner = ? AND label != 'migration' ORDER BY label")
        .bind(&owner)
        .fetch_all(pool)
        .await?;
    Ok(rows
        .iter()
        .map(|row| (row.get::<String, _>("label"), std::path::PathBuf::from(row.get::<String, _>("path"))))
        .collect())
}

/// F-1 regression tests: a same-basename second drive must never overwrite the
/// first drive's path (the silent-merge data-loss bug). These drive the real
/// `set_sync_path_internal` against a file-backed SQLite pool configured exactly
/// like production (`main.rs::build_pool`: WAL + `busy_timeout=5s`), so the
/// concurrency test exercises the same `BEGIN IMMEDIATE` serialization the app
/// relies on rather than a `:memory:` pool whose connections would each open a
/// private database.
#[cfg(test)]
mod set_path_tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
    use std::str::FromStr;

    async fn make_file_pool(dir: &std::path::Path) -> SqlitePool {
        let db = dir.join("hippius-test.db");
        let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", db.display()))
            .expect("connect opts")
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(std::time::Duration::from_secs(5));
        let pool = SqlitePoolOptions::new().max_connections(8).connect_with(opts).await.expect("pool");
        // Mirror the production `sync_paths` DDL (utils/schema.rs) incl. the
        // UNIQUE(owner, label) constraint the fix relies on as its backstop.
        sqlx::query(
            "CREATE TABLE sync_paths (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner TEXT NOT NULL DEFAULT '',
                path TEXT NOT NULL,
                type TEXT NOT NULL,
                label TEXT NOT NULL DEFAULT 'default',
                timestamp INTEGER NOT NULL,
                is_paused INTEGER NOT NULL DEFAULT 0,
                owner_ss58 TEXT,
                wire_folder_hash TEXT,
                UNIQUE(owner, label)
            )",
        )
        .execute(&pool)
        .await
        .expect("schema");
        pool
    }

    /// `(label, path)` rows for an account, label-sorted for deterministic asserts.
    async fn rows_for(pool: &SqlitePool, account_id: &str) -> Vec<(String, String)> {
        let owner = account_key(account_id);
        let rows = sqlx::query("SELECT label, path FROM sync_paths WHERE owner = ? ORDER BY label")
            .bind(&owner)
            .fetch_all(pool)
            .await
            .expect("rows");
        rows.iter().map(|r| (r.get("label"), r.get("path"))).collect()
    }

    // `unix`-gated to match `list_drive_roots` itself (its callers are the
    // macOS + Linux file-manager bridge); on Windows the fn does not exist.
    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn list_drive_roots_skips_migration_and_returns_label_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = make_file_pool(dir.path()).await;
        let acct = "5roots";
        set_sync_path_internal(&pool, acct, "/a/docs", false, LabelMode::Exact("docs"))
            .await
            .expect("docs");
        set_sync_path_internal(&pool, acct, "/a/pics", false, LabelMode::Exact("pics"))
            .await
            .expect("pics");
        set_sync_path_internal(&pool, acct, "/a/mig", false, LabelMode::Exact("migration"))
            .await
            .expect("migration");

        let roots = list_drive_roots(&pool, acct).await.expect("roots");
        assert_eq!(
            roots,
            vec![
                ("docs".to_string(), std::path::PathBuf::from("/a/docs")),
                ("pics".to_string(), std::path::PathBuf::from("/a/pics")),
            ],
            "the migration pseudo-drive is skipped; rows are (label, path), label-sorted"
        );
    }

    // The core fix: an `Allocate` add whose basename already exists must suffix
    // a fresh label AND leave the existing drive's path untouched. Pre-fix the
    // label was allocated in the caller and the write upserted, so the second
    // drive's path overwrote the first's, leaving one row.
    #[tokio::test]
    async fn allocate_suffixes_and_preserves_existing_drive() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = make_file_pool(dir.path()).await;
        let acct = "5acct";

        let l1 = set_sync_path_internal(&pool, acct, "/a/tags", false, LabelMode::Exact("tags"))
            .await
            .expect("first add");
        assert_eq!(l1, "tags");

        let l2 = set_sync_path_internal(&pool, acct, "/b/tags", false, LabelMode::Allocate { base: "tags" })
            .await
            .expect("second add");
        assert_eq!(l2, "tags-2", "a basename clash suffixes instead of overwriting");

        assert_eq!(
            rows_for(&pool, acct).await,
            vec![("tags".to_string(), "/a/tags".to_string()), ("tags-2".to_string(), "/b/tags".to_string())],
            "both drives survive with distinct labels and paths"
        );
    }

    // The TOCTOU: two concurrent same-basename adds must serialize under
    // BEGIN IMMEDIATE and produce two distinct drives, never one overwriting the
    // other. Pre-fix both reads observed an empty/identical label set outside
    // the write lock, both wrote the same label, and one row survived.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_allocate_yields_two_distinct_drives() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = make_file_pool(dir.path()).await;

        let (p1, p2) = (pool.clone(), pool.clone());
        let t1 = tokio::spawn(async move { set_sync_path_internal(&p1, "5acct", "/a/tags", false, LabelMode::Allocate { base: "tags" }).await });
        let t2 = tokio::spawn(async move { set_sync_path_internal(&p2, "5acct", "/b/tags", false, LabelMode::Allocate { base: "tags" }).await });
        let l1 = t1.await.expect("join 1").expect("add 1");
        let l2 = t2.await.expect("join 2").expect("add 2");

        assert_ne!(l1, l2, "concurrent adds must not resolve the same label");
        let mut labels = [l1, l2];
        labels.sort_unstable();
        assert_eq!(labels, ["tags".to_string(), "tags-2".to_string()]);

        let rows = rows_for(&pool, "5acct").await;
        assert_eq!(rows.len(), 2, "exactly two drives survive the race");
        let paths: std::collections::HashSet<&str> = rows.iter().map(|(_, p)| p.as_str()).collect();
        assert_eq!(paths.len(), 2, "two distinct paths survive — neither overwrote the other");
    }

    // `Exact` must keep its upsert: re-pointing an existing label updates that
    // row's path (the legitimate change-folder / migration path), not a new row.
    #[tokio::test]
    async fn exact_mode_repoints_existing_label_in_place() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = make_file_pool(dir.path()).await;
        let acct = "5acct";

        set_sync_path_internal(&pool, acct, "/a/docs", false, LabelMode::Exact("docs"))
            .await
            .expect("set");
        set_sync_path_internal(&pool, acct, "/b/docs", false, LabelMode::Exact("docs"))
            .await
            .expect("re-point");

        assert_eq!(
            rows_for(&pool, acct).await,
            vec![("docs".to_string(), "/b/docs".to_string())],
            "same label re-points to the new path in one row"
        );
    }
}

/// Look up the drive label for a given local sync-root `path`.
///
/// Used by IPC commands in `files.rs` (`add_file`, `add_folder`,
/// `add_files`) to resolve the FE-supplied `sync_path` into the
/// per-label key used by `UploadProcessingState` (and any other
/// per-drive state going forward).
///
/// Returns `Ok(Some(label))` when a row exists, `Ok(None)` when no
/// row matches — callers gracefully degrade to a no-op rather than
/// surfacing a hard error (the FE may have invoked this IPC during
/// a brief teardown window after the drive's row was removed).
///
/// # Errors
///
/// Returns `Err` only when the SQL query itself fails (DB locked,
/// connection lost). Missing rows are an `Ok(None)` outcome.
pub(crate) async fn label_for_sync_path(pool: &SqlitePool, account_id: &str, sync_path: &str) -> Result<Option<String>> {
    let owner = account_key(account_id);
    let label: Option<String> = sqlx::query_scalar("SELECT label FROM sync_paths WHERE owner = ? AND path = ? LIMIT 1")
        .bind(&owner)
        .bind(sync_path)
        .fetch_optional(pool)
        .await?;
    Ok(label)
}

/// Set the `is_paused` flag for a sync path in the DB.
///
/// `pub` (not `pub(crate)`) so the `drive_lifecycle_race` integration suite can
/// drive the REAL writer on the pause-producer side instead of a hand-rolled
/// `UPDATE`. That matters: the producer's `set_sync_path_paused(.., true)` and
/// `apply_init_commit`'s `set_sync_path_paused(.., false)` must resolve the same
/// `account_key`-hashed `owner` row, and only exercising the production writer
/// on both sides pins that agreement. `apply_init_commit` is the sole runtime
/// caller of the clearing direction; pause/resume own the rest.
pub async fn set_sync_path_paused(pool: &SqlitePool, account_id: &str, label: &str, paused: bool) -> Result<()> {
    let owner = account_key(account_id);
    let val: i32 = i32::from(paused);

    sqlx::query("UPDATE sync_paths SET is_paused = ? WHERE owner = ? AND label = ?")
        .bind(val)
        .bind(&owner)
        .bind(label)
        .execute(pool)
        .await?;

    Ok(())
}

/// Delete a sync path row from the DB without stopping the drive.
pub(crate) async fn remove_sync_path_internal(pool: &SqlitePool, account_id: &str, label: &str) -> Result<()> {
    let owner = account_key(account_id);

    sqlx::query("DELETE FROM sync_paths WHERE owner = ? AND label = ?")
        .bind(&owner)
        .bind(label)
        .execute(pool)
        .await?;

    Ok(())
}

/// Remove a sync path and tear down the corresponding drive.
///
/// Delegates entirely to [`crate::sync::lifecycle::remove_drive_for_account`],
/// passing the caller's explicit `account_id` so the `sync_paths` row delete
/// AND the on-disk baseline wipe are both scoped to it and run in the safe
/// drain-then-wipe order. The previous implementation deleted the row here
/// first and then called `remove_drive`, which re-derived the account from the
/// session: during an account switch that wiped the baseline under the wrong
/// account, and a crash between the two left a stale baseline behind. The DB
/// delete is best-effort inside `remove_drive_for_account` (its long-standing
/// contract), so a rare pool failure no longer surfaces a distinct IPC error —
/// the drive is still removed in-memory and the FE updates via the
/// `hcfs_drive_removed` event.
#[tauri::command]
pub async fn remove_sync_path(app: tauri::AppHandle, account_id: String, label: String) -> Result<()> {
    use tauri::Manager;
    let account_id = app.state::<crate::app_state::AppState>().require_session_account(&account_id)?;
    info!("Removing sync path for label '{}', account '{}'", label, account_id);
    crate::sync::lifecycle::remove_drive_for_account(app, label.clone(), Some(account_id)).await?;
    info!("Sync path removed and drive torn down for label '{}'", label);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items.iter().map(|(l, p)| (l.to_string(), p.to_string())).collect()
    }

    /// Pin the taxonomy: an unconfigured sync path surfaces as `NotFound`
    /// (typed + surfaced), not the old catch-all `Other` nor the FE-silenced
    /// `NotReady`. A regression of either kind fails here.
    #[tokio::test]
    async fn get_sync_path_internal_unset_is_not_found() {
        let pool = SqlitePool::connect("sqlite::memory:").await.expect("open in-memory db");
        sqlx::query(
            "CREATE TABLE sync_paths (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner TEXT NOT NULL,
                path TEXT NOT NULL,
                type TEXT NOT NULL,
                label TEXT NOT NULL DEFAULT 'default',
                is_paused INTEGER NOT NULL DEFAULT 0,
                timestamp INTEGER NOT NULL DEFAULT 0,
                owner_ss58 TEXT,
                wire_folder_hash TEXT
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Empty table: no row for this owner and no legacy ownerless row, so
        // both lookups miss and the function reaches the "not set yet" branch.
        let Err(err) = get_sync_path_internal(&pool, true, "owner-with-no-paths").await else {
            panic!("an unconfigured sync path must error");
        };
        assert!(
            matches!(err, crate::error::AppError::NotFound(_)),
            "unset sync path must surface as NotFound, got {err:?}"
        );
    }

    /// Extract the `{ ... }` body of the first fn whose declaration contains
    /// `sig`, by brace matching. Mirrors the static-invariant test style in
    /// `sync::folders` for teardown-ordering contracts that are impractical to
    /// exercise through the Tauri IPC boundary in a unit test.
    fn fn_body<'a>(src: &'a str, sig: &str) -> &'a str {
        let sig_idx = src.find(sig).expect("fn declaration present");
        let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
        let mut depth = 0usize;
        let mut body_end = body_start;
        for (i, ch) in src[body_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        body_end = body_start + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        &src[body_start..=body_end]
    }

    // remove_sync_path MUST delegate teardown to remove_drive_for_account
    // (passing the caller's explicit account) and MUST NOT issue its own row
    // delete. A standalone delete here re-opened two bugs: the baseline wipe in
    // remove_drive then ran under `current_account_id()` (the wrong account
    // during an account switch), and a crash between the delete and the wipe
    // left a stale baseline behind.
    #[test]
    fn remove_sync_path_delegates_to_remove_drive_for_account() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/drive/paths.rs")).expect("read paths.rs");
        let body = fn_body(&src, "pub async fn remove_sync_path(");
        assert!(
            body.contains("remove_drive_for_account("),
            "remove_sync_path must delegate teardown to remove_drive_for_account",
        );
        assert!(
            !body.contains("sqlx::query"),
            "remove_sync_path must NOT run its own SQL — remove_drive_for_account owns the account-scoped, drain-then-wipe teardown",
        );
    }

    #[tokio::test]
    async fn sibling_paths_are_allowed() {
        let existing = pairs(&[("photos", "/home/user/Photos")]);
        assert!(
            validate_no_path_overlap(Path::new("/home/user/Documents"), "docs", &existing)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn child_of_existing_path_is_rejected() {
        let existing = pairs(&[("docs", "/home/user/Documents")]);
        let result = validate_no_path_overlap(Path::new("/home/user/Documents/Work"), "work", &existing).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("already being synced as part of"));
    }

    #[tokio::test]
    async fn parent_of_existing_path_is_rejected() {
        let existing = pairs(&[("work", "/home/user/Documents/Work")]);
        let result = validate_no_path_overlap(Path::new("/home/user/Documents"), "docs", &existing).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("already being synced separately"));
    }

    #[tokio::test]
    async fn same_label_skips_self() {
        let existing = pairs(&[("docs", "/home/user/Documents")]);
        assert!(
            validate_no_path_overlap(Path::new("/home/user/Documents/Work"), "docs", &existing)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn exact_same_path_different_label_is_rejected() {
        let existing = pairs(&[("docs", "/home/user/Documents")]);
        let result = validate_no_path_overlap(Path::new("/home/user/Documents"), "docs2", &existing).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn multiple_existing_paths_checked() {
        let existing = pairs(&[
            ("photos", "/home/user/Photos"),
            ("music", "/home/user/Music"),
            ("docs", "/home/user/Documents"),
        ]);
        let result = validate_no_path_overlap(Path::new("/home/user/Documents/Work"), "work", &existing).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn empty_existing_always_passes() {
        assert!(validate_no_path_overlap(Path::new("/home/user/Documents"), "docs", &[]).await.is_ok());
    }

    #[tokio::test]
    async fn error_message_includes_conflicting_label() {
        let existing = pairs(&[("my-photos", "/home/user/Photos")]);
        let result = validate_no_path_overlap(Path::new("/home/user/Photos/Vacation"), "vacation", &existing).await;
        assert!(result.unwrap_err().to_string().contains("my-photos"));
    }
}
