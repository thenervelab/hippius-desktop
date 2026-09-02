//! Durable persistence for per-file sync failures — the on-disk counterpart of
//! the in-memory [`super::failure_tracking::FileFailureState`].
//!
//! Rows are keyed by `(owner, label, relative_path)` and outlive the process,
//! so a "Failed" badge can show *why* a file failed in any listing view (Recent
//! Files, the Drive table, the tray) even after a restart or on a device that
//! only knows the file from the server. The in-memory state still drives the
//! live retry-threshold logic; this table is the source of truth the frontend
//! reads for display.
//!
//! `owner` is the hashed account key (`auth::account_key::account_key`), the
//! same scoping used by `sync_paths`, so a file's failure record is private to
//! the account that produced it.

use crate::error::Result;
use crate::sync::events::FileFailureKindPayload;
use serde::Serialize;
use sqlx::Row;
use sqlx::sqlite::SqlitePool;

/// A persisted failure row, shaped for the frontend.
///
/// `kind` is the stable `camelCase` discriminant the FE switches on (it mirrors
/// the serde tag of [`FileFailureKindPayload`], not the English Display text).
/// The typed detail columns are populated only for the variant that carries
/// them — e.g. `http_status` for `serverError`, `balance_cents` /
/// `required_cents` for `insufficientBalance`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFailureRecord {
    pub label: String,
    pub relative_path: String,
    pub file_name: String,
    pub kind: String,
    pub message: Option<String>,
    pub http_status: Option<i64>,
    pub balance_cents: Option<i64>,
    pub required_cents: Option<i64>,
    pub failure_count: i64,
    pub last_failed_at: i64,
}

/// Flattened column values for the kind-specific detail. Centralising this
/// mapping is the single point where the wire enum and the table layout meet,
/// so they cannot silently drift apart.
struct KindColumns {
    kind: &'static str,
    message: Option<String>,
    http_status: Option<i64>,
    balance_cents: Option<i64>,
    required_cents: Option<i64>,
}

/// Project a typed failure kind onto the flat columns the table stores.
///
/// `balance_cents` / `required_cents` are `u64` upstream; cents values are tiny
/// in practice, but we saturate on the (impossible) overflow rather than wrap
/// so a corrupt value can never read back negative.
fn kind_columns(kind: &FileFailureKindPayload) -> KindColumns {
    match kind {
        FileFailureKindPayload::InsufficientBalance {
            balance_cents,
            required_cents,
        } => KindColumns {
            kind: "insufficientBalance",
            message: None,
            http_status: None,
            balance_cents: Some(i64::try_from(*balance_cents).unwrap_or(i64::MAX)),
            required_cents: Some(i64::try_from(*required_cents).unwrap_or(i64::MAX)),
        },
        FileFailureKindPayload::ServerError { status } => KindColumns {
            kind: "serverError",
            message: None,
            http_status: Some(i64::from(*status)),
            balance_cents: None,
            required_cents: None,
        },
        FileFailureKindPayload::Network => KindColumns {
            kind: "network",
            message: None,
            http_status: None,
            balance_cents: None,
            required_cents: None,
        },
        FileFailureKindPayload::ChangedWhileUploading => KindColumns {
            kind: "changedWhileUploading",
            message: None,
            http_status: None,
            balance_cents: None,
            required_cents: None,
        },
        FileFailureKindPayload::Gone => KindColumns {
            kind: "gone",
            message: None,
            http_status: None,
            balance_cents: None,
            required_cents: None,
        },
        FileFailureKindPayload::Other { message } => KindColumns {
            kind: "other",
            message: Some(message.clone()),
            http_status: None,
            balance_cents: None,
            required_cents: None,
        },
    }
}

/// Record (or bump) a persisted failure for a file. Returns the new
/// `failure_count` after the upsert (1 on the first failure).
///
/// Keyed by `(owner, label, relative_path)`: a repeated failure of the same
/// file updates the latest kind/detail and increments the count rather than
/// inserting a duplicate row.
///
/// # Errors
/// Returns [`crate::error::AppError::Db`] if the database write fails.
pub async fn upsert_failure(
    pool: &SqlitePool,
    owner: &str,
    label: &str,
    relative_path: &str,
    file_name: &str,
    kind: &FileFailureKindPayload,
    now_ms: i64,
) -> Result<i64> {
    let cols = kind_columns(kind);
    let count: i64 = sqlx::query_scalar(
        "INSERT INTO sync_file_failures
            (owner, label, relative_path, file_name, kind, message, http_status,
             balance_cents, required_cents, failure_count, last_failed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(owner, label, relative_path) DO UPDATE SET
            file_name      = excluded.file_name,
            kind           = excluded.kind,
            message        = excluded.message,
            http_status    = excluded.http_status,
            balance_cents  = excluded.balance_cents,
            required_cents = excluded.required_cents,
            failure_count  = sync_file_failures.failure_count + 1,
            last_failed_at = excluded.last_failed_at
         RETURNING failure_count",
    )
    .bind(owner)
    .bind(label)
    .bind(relative_path)
    .bind(file_name)
    .bind(cols.kind)
    .bind(cols.message)
    .bind(cols.http_status)
    .bind(cols.balance_cents)
    .bind(cols.required_cents)
    .bind(now_ms)
    .fetch_one(pool)
    .await?;
    Ok(count)
}

/// Clear a single file's persisted failure — call when the file syncs
/// successfully or the user retries past it. No-op if no row exists.
///
/// # Errors
/// Returns [`crate::error::AppError::Db`] if the database write fails.
pub async fn clear_failure(pool: &SqlitePool, owner: &str, label: &str, relative_path: &str) -> Result<()> {
    sqlx::query("DELETE FROM sync_file_failures WHERE owner = ? AND label = ? AND relative_path = ?")
        .bind(owner)
        .bind(label)
        .bind(relative_path)
        .execute(pool)
        .await?;
    Ok(())
}

/// Clear every persisted failure for a drive — call on drive removal or a fully
/// successful sync cycle.
///
/// # Errors
/// Returns [`crate::error::AppError::Db`] if the database write fails.
pub async fn clear_failures_for_label(pool: &SqlitePool, owner: &str, label: &str) -> Result<()> {
    sqlx::query("DELETE FROM sync_file_failures WHERE owner = ? AND label = ?")
        .bind(owner)
        .bind(label)
        .execute(pool)
        .await?;
    Ok(())
}

/// Remember that the user dismissed these files from the Sync Issues dialog.
///
/// Stamps `dismissed_at` on the existing rows only: a file with no failure
/// row has nothing to be quiet about, and inventing a row would show a
/// "Failed" badge for a file that never failed. A repeat failure re-upserts
/// the row without touching the stamp; the row's deletion on success or
/// retry is what ends the dismissal.
///
/// # Errors
/// Returns [`crate::error::AppError::Db`] if the database write fails.
pub async fn mark_dismissed(pool: &SqlitePool, owner: &str, label: &str, relative_paths: &[String], now_ms: i64) -> Result<()> {
    for relative_path in relative_paths {
        sqlx::query("UPDATE sync_file_failures SET dismissed_at = ? WHERE owner = ? AND label = ? AND relative_path = ?")
            .bind(now_ms)
            .bind(owner)
            .bind(label)
            .bind(relative_path)
            .execute(pool)
            .await?;
    }
    Ok(())
}

/// Relative paths of a drive's dismissed failures — read at drive init to
/// reinstate them into the in-memory tracker.
///
/// # Errors
/// Returns [`crate::error::AppError::Db`] if the database read fails.
pub async fn list_dismissed_paths(pool: &SqlitePool, owner: &str, label: &str) -> Result<Vec<String>> {
    let paths = sqlx::query_scalar(
        "SELECT relative_path FROM sync_file_failures
         WHERE owner = ? AND label = ? AND dismissed_at IS NOT NULL
         ORDER BY relative_path",
    )
    .bind(owner)
    .bind(label)
    .fetch_all(pool)
    .await?;
    Ok(paths)
}

/// Read one file's persisted failure, if any — used to enrich a listing row.
///
/// # Errors
/// Returns [`crate::error::AppError::Db`] if the database read fails.
pub async fn get_failure(pool: &SqlitePool, owner: &str, label: &str, relative_path: &str) -> Result<Option<FileFailureRecord>> {
    let row = sqlx::query(
        "SELECT label, relative_path, file_name, kind, message, http_status,
                balance_cents, required_cents, failure_count, last_failed_at
         FROM sync_file_failures
         WHERE owner = ? AND label = ? AND relative_path = ?",
    )
    .bind(owner)
    .bind(label)
    .bind(relative_path)
    .fetch_optional(pool)
    .await?;
    Ok(row.as_ref().map(record_from_row))
}

/// All persisted failures for a drive, most-recent failure first — used by the
/// per-drive "retry all" surface and to bootstrap the FE map.
///
/// # Errors
/// Returns [`crate::error::AppError::Db`] if the database read fails.
pub async fn list_failures_for_label(pool: &SqlitePool, owner: &str, label: &str) -> Result<Vec<FileFailureRecord>> {
    let rows = sqlx::query(
        "SELECT label, relative_path, file_name, kind, message, http_status,
                balance_cents, required_cents, failure_count, last_failed_at
         FROM sync_file_failures
         WHERE owner = ? AND label = ?
         ORDER BY last_failed_at DESC",
    )
    .bind(owner)
    .bind(label)
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(record_from_row).collect())
}

/// Build a [`FileFailureRecord`] from a result row. The SELECT column order in
/// every query above must match the `get` indices here.
fn record_from_row(row: &sqlx::sqlite::SqliteRow) -> FileFailureRecord {
    FileFailureRecord {
        label: row.get("label"),
        relative_path: row.get("relative_path"),
        file_name: row.get("file_name"),
        kind: row.get("kind"),
        message: row.get("message"),
        http_status: row.get("http_status"),
        balance_cents: row.get("balance_cents"),
        required_cents: row.get("required_cents"),
        failure_count: row.get("failure_count"),
        last_failed_at: row.get("last_failed_at"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Self-contained in-memory pool with just this table created inline. The
    /// production DDL lives in `utils::schema::ensure_sync_file_failures` and is
    /// independently covered by the schema smoke test; keeping this test's setup
    /// local means it doesn't depend on the full schema bring-up.
    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.expect("open in-memory sqlite");
        sqlx::query(
            "CREATE TABLE sync_file_failures (
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
        .execute(&pool)
        .await
        .expect("create table");
        pool
    }

    /// One sample per [`FileFailureKindPayload`] variant.
    ///
    /// The wildcard-free `match` is the point: adding a variant fails to
    /// compile here until it is listed, which is what stops a new kind from
    /// silently reaching the table without a pinned discriminant.
    fn sample_of_every_kind() -> Vec<FileFailureKindPayload> {
        use FileFailureKindPayload as K;

        let all = vec![
            K::InsufficientBalance {
                balance_cents: 12,
                required_cents: 100,
            },
            K::ServerError { status: 500 },
            K::Network,
            K::ChangedWhileUploading,
            K::Gone,
            K::Other { message: "x".to_string() },
        ];
        for kind in &all {
            match kind {
                K::InsufficientBalance { .. } | K::ServerError { .. } | K::Network | K::ChangedWhileUploading | K::Gone | K::Other { .. } => {}
            }
        }
        all
    }

    /// IPC wire-contract guard: `kind_columns` is a SECOND, hand-written copy
    /// of the discriminants serde derives for the live `hcfs_file_failed`
    /// payload, and the FE's `fileFailure.ts` union switches on both without
    /// distinguishing them. The events.rs pin covers only the serde half, so a
    /// typo here would leave a persisted badge falling through to the generic
    /// "Sync failed. Please try again." with nothing failing.
    #[test]
    fn persisted_kind_matches_the_serde_tag_for_every_variant() {
        let tags: Vec<&str> = sample_of_every_kind()
            .iter()
            .map(|kind| {
                let wire = serde_json::to_value(kind).expect("serialize");
                let tag = wire["kind"].as_str().expect("tagged wire shape").to_string();
                assert_eq!(kind_columns(kind).kind, tag, "persisted kind drifted from the serde tag for {kind:?}");
                kind_columns(kind).kind
            })
            .collect();

        assert_eq!(
            tags,
            vec!["insufficientBalance", "serverError", "network", "changedWhileUploading", "gone", "other"],
            "these exact strings are the `FileFailureKind` union in app/lib/types/fileFailure.ts"
        );
    }

    #[tokio::test]
    async fn upsert_inserts_then_increments_and_keeps_latest_kind() {
        let pool = test_pool().await;
        let network = FileFailureKindPayload::Network;
        let server = FileFailureKindPayload::ServerError { status: 500 };

        let c1 = upsert_failure(&pool, "o", "drive", "a/b.txt", "b.txt", &network, 100).await.unwrap();
        assert_eq!(c1, 1, "first failure starts the count at 1");

        let c2 = upsert_failure(&pool, "o", "drive", "a/b.txt", "b.txt", &server, 200).await.unwrap();
        assert_eq!(c2, 2, "same file bumps rather than duplicating");

        let rec = get_failure(&pool, "o", "drive", "a/b.txt").await.unwrap().expect("row exists");
        assert_eq!(rec.failure_count, 2);
        assert_eq!(rec.kind, "serverError", "latest kind wins");
        assert_eq!(rec.http_status, Some(500));
        assert_eq!(rec.last_failed_at, 200);
    }

    #[tokio::test]
    async fn insufficient_balance_persists_typed_detail() {
        let pool = test_pool().await;
        let kind = FileFailureKindPayload::InsufficientBalance {
            balance_cents: 12,
            required_cents: 100,
        };
        upsert_failure(&pool, "o", "d", "f", "f", &kind, 1).await.unwrap();

        let rec = get_failure(&pool, "o", "d", "f").await.unwrap().unwrap();
        assert_eq!(rec.kind, "insufficientBalance");
        assert_eq!(rec.balance_cents, Some(12));
        assert_eq!(rec.required_cents, Some(100));
        assert_eq!(rec.http_status, None);
    }

    #[tokio::test]
    async fn clear_failure_removes_one_file_only() {
        let pool = test_pool().await;
        let k = FileFailureKindPayload::Network;
        upsert_failure(&pool, "o", "d", "keep.txt", "keep.txt", &k, 1).await.unwrap();
        upsert_failure(&pool, "o", "d", "drop.txt", "drop.txt", &k, 1).await.unwrap();

        clear_failure(&pool, "o", "d", "drop.txt").await.unwrap();

        assert!(get_failure(&pool, "o", "d", "drop.txt").await.unwrap().is_none());
        assert!(get_failure(&pool, "o", "d", "keep.txt").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn list_and_clear_for_label_are_scoped() {
        let pool = test_pool().await;
        let k = FileFailureKindPayload::Network;
        upsert_failure(&pool, "o", "alpha", "1", "1", &k, 100).await.unwrap();
        upsert_failure(&pool, "o", "alpha", "2", "2", &k, 200).await.unwrap();
        upsert_failure(&pool, "o", "beta", "3", "3", &k, 300).await.unwrap();

        let alpha = list_failures_for_label(&pool, "o", "alpha").await.unwrap();
        assert_eq!(alpha.len(), 2);
        assert_eq!(alpha[0].relative_path, "2", "ordered by last_failed_at DESC");

        clear_failures_for_label(&pool, "o", "alpha").await.unwrap();
        assert!(list_failures_for_label(&pool, "o", "alpha").await.unwrap().is_empty());
        assert_eq!(
            list_failures_for_label(&pool, "o", "beta").await.unwrap().len(),
            1,
            "other drives untouched"
        );
    }

    #[tokio::test]
    async fn failures_are_scoped_per_owner() {
        let pool = test_pool().await;
        let k = FileFailureKindPayload::Network;
        upsert_failure(&pool, "owner-a", "d", "f", "f", &k, 1).await.unwrap();

        assert!(get_failure(&pool, "owner-b", "d", "f").await.unwrap().is_none());
        assert!(get_failure(&pool, "owner-a", "d", "f").await.unwrap().is_some());
    }

    /// A dismissal must outlive the failure that follows it — the file keeps
    /// failing every cycle, and each failure re-upserts the row — but not the
    /// success that deletes the row.
    #[tokio::test]
    async fn a_dismissal_survives_a_repeat_failure_and_dies_with_the_row() {
        let pool = test_pool().await;
        let k = FileFailureKindPayload::Network;
        upsert_failure(&pool, "o", "d", "a", "a", &k, 1).await.unwrap();
        upsert_failure(&pool, "o", "d", "b", "b", &k, 1).await.unwrap();

        mark_dismissed(&pool, "o", "d", &["a".to_string()], 500).await.unwrap();
        assert_eq!(list_dismissed_paths(&pool, "o", "d").await.unwrap(), vec!["a"]);

        upsert_failure(&pool, "o", "d", "a", "a", &k, 600).await.unwrap();
        assert_eq!(
            list_dismissed_paths(&pool, "o", "d").await.unwrap(),
            vec!["a"],
            "a repeat failure keeps the dismissal"
        );

        clear_failure(&pool, "o", "d", "a").await.unwrap();
        assert!(list_dismissed_paths(&pool, "o", "d").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn dismissing_an_unknown_file_records_nothing() {
        let pool = test_pool().await;
        mark_dismissed(&pool, "o", "d", &["ghost".to_string()], 1).await.unwrap();
        assert!(list_dismissed_paths(&pool, "o", "d").await.unwrap().is_empty());
        assert!(
            get_failure(&pool, "o", "d", "ghost").await.unwrap().is_none(),
            "no row is conjured for it"
        );
    }

    #[tokio::test]
    async fn dismissals_are_scoped_per_owner_and_label() {
        let pool = test_pool().await;
        let k = FileFailureKindPayload::Network;
        upsert_failure(&pool, "o", "alpha", "a", "a", &k, 1).await.unwrap();
        upsert_failure(&pool, "o", "beta", "a", "a", &k, 1).await.unwrap();
        upsert_failure(&pool, "other", "alpha", "a", "a", &k, 1).await.unwrap();

        mark_dismissed(&pool, "o", "alpha", &["a".to_string()], 1).await.unwrap();

        assert_eq!(list_dismissed_paths(&pool, "o", "alpha").await.unwrap(), vec!["a"]);
        assert!(list_dismissed_paths(&pool, "o", "beta").await.unwrap().is_empty());
        assert!(list_dismissed_paths(&pool, "other", "alpha").await.unwrap().is_empty());
    }
}
