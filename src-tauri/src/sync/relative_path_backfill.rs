//! One-shot `relative_path` backfill for drives that were created before the
//! `relative_path` column existed on hcfs-server.
//!
//! PR 7 Task 7.3 of the hcfs nested-folder-browsing plan.
//!
//! # Why this exists
//!
//! Older clients uploaded file rows with `relative_path = NULL`. The
//! server-side browse endpoint (PR 4) now needs plaintext `relative_path` to
//! render nested folder listings, so every legacy row needs a one-shot
//! backfill. Rather than a mass server-side migration (which would require
//! decrypting per-user ciphertext server-side — impossible by design), the
//! desktop walks its own persisted `SyncState.path_index` (which is the
//! authoritative `path_hash → relative_path` map, kept locally and never
//! synced to server) and posts it to the `register_relative_paths` endpoint.
//! The server upserts the rows; entries for paths the server doesn't know
//! about are silently dropped.
//!
//! # State machine
//!
//! The backfill state lives in `sync_paths.relative_paths_backfilled_at`:
//!
//! - `NULL` → pending. Will retry on next launch.
//! - `Some(unix_epoch_seconds)` → done. Never retries again.
//!
//! A single successful pass sets the timestamp. Any transient failure
//! (network, server error, drive not yet unlocked) leaves the row NULL so
//! the next launch picks it up.
//!
//! # Why it runs on a detached task
//!
//! Drive init must not block on a potentially slow HTTP round-trip. We spawn
//! a background task from [`crate::sync::lifecycle::initialize_sync_inner`]
//! after the drive has transitioned to Active; any failure is logged and
//! forgotten — the next launch gets another chance.

use crate::app_state::AppState;
use crate::auth::account_key::account_key;
use crate::auth::tokens::get_api_token;
use crate::error::{AppError, Result};
use crate::sync::config::build_hcfs_config;
use crate::sync::mnemonic::folder_hash;
use crate::sync::remote::get_server_url;
use hcfs_client::client::HcfsClient;
use hcfs_shared::network::{MAX_REGISTER_RELATIVE_PATHS_BATCH, RegisterRelativePathEntry};
use sqlx::sqlite::SqlitePool;
use std::path::PathBuf;
use tracing::{debug, info, warn};

/// Outcome of a single backfill attempt for one drive.
///
/// Using a rich enum rather than `Result<(), AppError>` keeps the startup
/// dispatcher in `lifecycle.rs` honest: network-flavoured failures are
/// retryable and map to `RetryLater`, while truly unexpected conditions
/// (DB corruption, locked-out mutex) surface via the outer `Result::Err`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackfillOutcome {
    /// The flag was already set — this drive is done and will never retry.
    AlreadyDone,
    /// The drive wasn't unlocked or registered yet. Harmless — next launch
    /// or next `initialize_sync_inner` will trigger another attempt.
    NotReady,
    /// A transient failure (network error, server error, missing client
    /// config). Flag stays NULL so the next launch retries.
    RetryLater,
    /// Backfill posted every entry and the flag has been set. Never runs
    /// again for this drive.
    Completed { total_entries: u64, updated: u64, skipped: u64 },
}

/// Run a one-shot backfill for the drive with the given label.
///
/// See [module docs][self] for the full state machine.
///
/// Network and server errors become `Ok(RetryLater)` — only programmer
/// errors (DB corruption, poisoned mutexes, account key lookup failures)
/// surface as `Err(AppError)`. The caller-side spawn in
/// [`crate::sync::lifecycle::initialize_sync_inner`] relies on this so one
/// drive's flakiness doesn't take down the whole startup sweep.
pub async fn run_backfill_for_drive(state: &AppState, account_id: &str, label: &str) -> Result<BackfillOutcome> {
    let pool = state.pool()?.clone();
    let owner = account_key(account_id);

    // 1. Skip if the flag is already set. Cheap read so the detached task
    //    collapses into a no-op when an older invocation already won.
    if is_backfilled(&pool, &owner, label).await? {
        return Ok(BackfillOutcome::AlreadyDone);
    }

    // 2. Snapshot the drive's `path_index` off the in-memory registry. The
    //    per-drive lock is held only long enough to call `load_sync_state`,
    //    which spawns its own blocking task for the disk read — we don't
    //    block the sync engine on this.
    let Some(path_index) = snapshot_path_index(state, label).await else {
        debug!(label = %label, "backfill: drive not ready (no unlocked entry in registry)");
        return Ok(BackfillOutcome::NotReady);
    };

    if path_index.is_empty() {
        // An empty index is a legitimate "nothing to backfill" case — mark
        // the flag so we don't retry a no-op forever.
        info!(label = %label, "backfill: path_index empty; marking drive as backfilled");
        mark_backfilled(&pool, &owner, label).await?;
        return Ok(BackfillOutcome::Completed {
            total_entries: 0,
            updated: 0,
            skipped: 0,
        });
    }

    // 3. Build the one-shot HTTP client. If we can't (missing token, bad
    //    config, etc.) treat it as retryable — nothing about the drive
    //    itself is corrupt, the user just needs to log in again or wait.
    let client = match build_one_shot_client(&pool, account_id, label).await {
        Ok(c) => c,
        Err(e) => {
            warn!(label = %label, error = %e, "backfill: could not build HCFS client; will retry next launch");
            return Ok(BackfillOutcome::RetryLater);
        }
    };

    let folder_hash = folder_hash(label);

    // 4. Convert + chunk + POST.
    let entries = path_index_to_entries(&path_index, label);
    let total_entries = entries.len() as u64;
    let Ok((updated, skipped)) = submit_batches(&client, account_id, &folder_hash, entries, label).await else {
        return Ok(BackfillOutcome::RetryLater);
    };

    // 5. Set the flag so we never retry.
    mark_backfilled(&pool, &owner, label).await?;

    info!(
        label = %label,
        total = total_entries,
        updated,
        skipped,
        "backfill: completed relative_paths registration"
    );

    Ok(BackfillOutcome::Completed {
        total_entries,
        updated,
        skipped,
    })
}

/// Cheap read of the backfill timestamp column. `true` iff the row exists
/// AND the column is non-NULL. A missing row also returns `false` — the
/// caller will bail via `NotReady` on the subsequent drive lookup step.
pub async fn is_backfilled(pool: &SqlitePool, owner: &str, label: &str) -> Result<bool> {
    let row: Option<(Option<i64>,)> = sqlx::query_as("SELECT relative_paths_backfilled_at FROM sync_paths WHERE owner = ? AND label = ?")
        .bind(owner)
        .bind(label)
        .fetch_optional(pool)
        .await?;
    Ok(matches!(row, Some((Some(_),))))
}

/// Pull the `path_index` off the drive registered under `label`.
///
/// Returns `None` when the drive isn't in the map yet, isn't unlocked, or
/// its mutex is held by a sync in progress — all of which are expected
/// transient states that map to [`BackfillOutcome::NotReady`].
///
/// The returned map is a point-in-time snapshot. A concurrent sync may
/// rename or delete files after we take it; server-side the new
/// `path_hash` is unknown and the register call skips it, so such files
/// keep a stale `relative_path` until their next normal sync overwrites
/// it. That's acceptable because the one-shot backfill is strictly a
/// bootstrapping pass for pre-existing legacy rows — steady-state writes
/// are handled by `sync_async`.
async fn snapshot_path_index(state: &AppState, label: &str) -> Option<std::collections::HashMap<[u8; 32], PathBuf>> {
    let drive_arc = {
        let guard = state.sync.drives.lock().await;
        guard.get(label).map(|slot| slot.manager.clone())
    }?;
    // Short lock: only while `load_sync_state` reads the persisted state
    // (disk I/O runs on a blocking task inside hcfs-client). Dropping the
    // guard immediately after keeps upload/download on this drive
    // responsive during the HTTP round-trips that follow.
    let state_snapshot = {
        let manager = drive_arc.lock().await;
        if !manager.is_unlocked() {
            return None;
        }
        manager.load_sync_state().await.ok()?
    };
    Some(state_snapshot.path_index)
}

/// Convert the raw `FileId → PathBuf` map into the wire format hcfs-client
/// expects. Non-UTF-8 paths are skipped with a warning — they would have
/// failed anywhere downstream anyway.
fn path_index_to_entries(path_index: &std::collections::HashMap<[u8; 32], PathBuf>, label: &str) -> Vec<RegisterRelativePathEntry> {
    let mut out = Vec::with_capacity(path_index.len());
    for (path_hash, rel_path) in path_index {
        match rel_path.to_str() {
            Some(s) if !s.is_empty() => out.push(RegisterRelativePathEntry {
                path_hash: *path_hash,
                relative_path: s.to_owned(),
            }),
            Some(_) => {
                // Empty relative_path — not something hcfs-client would
                // have produced, but guard anyway so the server isn't
                // handed an unbounded-length empty string.
                warn!(label = %label, "backfill: skipping entry with empty relative_path");
            }
            None => {
                warn!(label = %label, path = ?rel_path, "backfill: skipping non-UTF8 relative_path entry");
            }
        }
    }
    out
}

/// Post `entries` to the server in chunks of
/// [`MAX_REGISTER_RELATIVE_PATHS_BATCH`] and return the aggregate
/// `(updated, skipped)` totals. Per-entry errors are logged at warn level
/// but do not abort the sweep — they're individual row issues, not batch
/// failures. Network failures abort and propagate `Err`.
async fn submit_batches(
    client: &HcfsClient,
    account_id: &str,
    folder_hash: &str,
    entries: Vec<RegisterRelativePathEntry>,
    label: &str,
) -> std::result::Result<(u64, u64), hcfs_client::sync::SyncError> {
    let mut updated_total = 0u64;
    let mut skipped_total = 0u64;

    for chunk in entries.chunks(MAX_REGISTER_RELATIVE_PATHS_BATCH) {
        let batch: Vec<RegisterRelativePathEntry> = chunk.to_vec();
        let result = client.register_relative_paths(account_id, folder_hash, batch).await.inspect_err(|e| {
            warn!(label = %label, error = %e, "backfill: register_relative_paths failed; will retry next launch");
        })?;
        if !result.errors.is_empty() {
            warn!(
                label = %label,
                batch_updated = result.updated,
                batch_skipped = result.skipped,
                batch_errors = result.errors.len(),
                "backfill: server reported per-entry errors"
            );
        }
        updated_total += u64::from(result.updated);
        skipped_total += u64::from(result.skipped);
    }

    Ok((updated_total, skipped_total))
}

/// Stand up a fresh `HcfsClient` for the one-shot POST, sharing the same
/// connection parameters the sync engine would use. We do NOT reuse the
/// drive's own client because it lives behind the per-drive mutex —
/// grabbing it for the duration of the backfill would serialize against
/// in-progress syncs for no reason.
///
/// Server URL lookup and `HcfsClientConfig` construction are delegated to
/// the canonical helpers (`sync::remote::get_server_url`,
/// `sync::config::build_hcfs_config`) so this one-shot path can't silently
/// drift from the main sync engine's TLS/auth/billing-bypass behaviour.
async fn build_one_shot_client(pool: &SqlitePool, account_id: &str, label: &str) -> Result<HcfsClient> {
    let server_url = get_server_url(pool, account_id).await?;
    let bearer_token = get_api_token(pool, account_id)
        .await?
        .ok_or_else(|| AppError::Auth("No authentication token found. Please log in again.".into()))?;
    let config = build_hcfs_config(&server_url, &bearer_token, account_id, &folder_hash(label));
    HcfsClient::new(config).map_err(|e| AppError::Hcfs(format!("Failed to create HCFS client for backfill: {e}")))
}

/// Set `relative_paths_backfilled_at` to the current Unix epoch. Idempotent
/// if the caller runs after another successful backfill — SQLite will just
/// overwrite the (older) timestamp, which is fine.
async fn mark_backfilled(pool: &SqlitePool, owner: &str, label: &str) -> Result<()> {
    let now = chrono::Utc::now().timestamp();
    let affected = sqlx::query("UPDATE sync_paths SET relative_paths_backfilled_at = ? WHERE owner = ? AND label = ?")
        .bind(now)
        .bind(owner)
        .bind(label)
        .execute(pool)
        .await?
        .rows_affected();
    if affected == 0 {
        // The row vanished between the flag-check and here — a logout or
        // remove_drive mid-backfill could do this. Log + move on; the
        // drive no longer exists so there's nothing to mark.
        debug!(label = %label, "backfill: row missing when marking; drive was removed concurrently");
    }
    Ok(())
}

/// Spawn the backfill as a detached tokio task.
///
/// Called from [`crate::sync::lifecycle::initialize_sync_inner`] at the end
/// of a successful drive init. We don't pre-check the `is_backfilled` flag
/// here — `run_backfill_for_drive` does it as its first step, and spawning
/// a tokio task + running one SELECT against an in-process SQLite pool is
/// sub-millisecond. Paying that for simpler wiring (no double gate, no
/// pre-check error-swallow branch) is a trade we take deliberately.
///
/// All failure modes are logged inside the task — the caller never awaits
/// it and never sees errors.
pub(crate) fn spawn_backfill(app: tauri::AppHandle, account_id: String, label: String) {
    tokio::spawn(async move {
        use tauri::Manager;
        let state = app.state::<AppState>();
        match run_backfill_for_drive(&state, &account_id, &label).await {
            Ok(BackfillOutcome::Completed {
                total_entries,
                updated,
                skipped,
            }) => {
                info!(
                    label = %label,
                    total = total_entries,
                    updated,
                    skipped,
                    "relative_paths backfill task finished"
                );
            }
            Ok(BackfillOutcome::AlreadyDone) => {
                debug!(label = %label, "relative_paths backfill: already done; skipping");
            }
            Ok(BackfillOutcome::NotReady) => {
                debug!(label = %label, "relative_paths backfill: drive not ready; will retry next launch");
            }
            Ok(BackfillOutcome::RetryLater) => {
                debug!(label = %label, "relative_paths backfill: transient failure; will retry next launch");
            }
            Err(e) => {
                warn!(label = %label, error = ?e, "relative_paths backfill: unexpected error");
            }
        }
    });
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use hcfs_shared::network::MAX_REGISTER_RELATIVE_PATHS_BATCH;
    use sqlx::sqlite::SqlitePoolOptions;

    /// Create a throwaway in-memory SQLite pool with the production schema
    /// applied, matching how real tests bootstrap the DB.
    async fn temp_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect sqlite::memory:");
        crate::utils::schema::ensure_table_schema(&pool).await.expect("schema");
        pool
    }

    /// Insert a sync_paths row with the given backfill-timestamp state.
    async fn insert_row(pool: &SqlitePool, owner: &str, label: &str, backfilled: Option<i64>) {
        sqlx::query(
            "INSERT INTO sync_paths (owner, path, type, label, timestamp, relative_paths_backfilled_at)
             VALUES (?, ?, 'private', ?, ?, ?)",
        )
        .bind(owner)
        .bind("/tmp/test-path")
        .bind(label)
        .bind(0i64)
        .bind(backfilled)
        .execute(pool)
        .await
        .expect("insert");
    }

    #[tokio::test]
    async fn is_backfilled_returns_true_when_timestamp_set() {
        let pool = temp_pool().await;
        insert_row(&pool, "owner-a", "default", Some(1_700_000_000)).await;
        assert!(is_backfilled(&pool, "owner-a", "default").await.unwrap());
    }

    #[tokio::test]
    async fn is_backfilled_returns_false_when_null() {
        let pool = temp_pool().await;
        insert_row(&pool, "owner-b", "default", None).await;
        assert!(!is_backfilled(&pool, "owner-b", "default").await.unwrap());
    }

    #[tokio::test]
    async fn is_backfilled_returns_false_when_row_missing() {
        let pool = temp_pool().await;
        // No row inserted.
        assert!(!is_backfilled(&pool, "ghost-owner", "ghost-label").await.unwrap());
    }

    #[tokio::test]
    async fn mark_backfilled_sets_non_null_timestamp() {
        let pool = temp_pool().await;
        insert_row(&pool, "owner-c", "default", None).await;

        assert!(!is_backfilled(&pool, "owner-c", "default").await.unwrap());
        mark_backfilled(&pool, "owner-c", "default").await.unwrap();
        assert!(is_backfilled(&pool, "owner-c", "default").await.unwrap());
    }

    #[tokio::test]
    async fn mark_backfilled_is_noop_when_row_missing() {
        let pool = temp_pool().await;
        // Must not error — the spawn-after-init task can race against
        // drive removal, and silently succeeding is the right behaviour.
        mark_backfilled(&pool, "nobody", "nowhere").await.unwrap();
    }

    #[test]
    fn path_index_to_entries_skips_empty_and_keeps_unicode() {
        let mut idx = std::collections::HashMap::new();
        idx.insert([1u8; 32], PathBuf::from("docs/readme.md"));
        idx.insert([2u8; 32], PathBuf::from(""));
        idx.insert([3u8; 32], PathBuf::from("café/résumé.txt"));

        let out = path_index_to_entries(&idx, "test-label");

        // Empty skipped; two valid entries survive.
        assert_eq!(out.len(), 2);
        let paths: std::collections::HashSet<&str> = out.iter().map(|e| e.relative_path.as_str()).collect();
        assert!(paths.contains("docs/readme.md"));
        assert!(paths.contains("café/résumé.txt"));
    }

    /// Regression guard for the chunking math: 501 entries must produce
    /// exactly two chunks, since `MAX_REGISTER_RELATIVE_PATHS_BATCH` is
    /// the server-enforced hard cap. A chunking off-by-one here would
    /// cause the server to reject the oversized batch and leave the
    /// backfill flag unset forever.
    #[test]
    fn chunking_respects_max_batch_size() {
        let entries: Vec<RegisterRelativePathEntry> = (0..501u32)
            .map(|i| RegisterRelativePathEntry {
                path_hash: [i as u8; 32],
                relative_path: format!("file_{i}.txt"),
            })
            .collect();

        let chunks: Vec<&[RegisterRelativePathEntry]> = entries.chunks(MAX_REGISTER_RELATIVE_PATHS_BATCH).collect();

        assert_eq!(
            chunks.len(),
            2,
            "501 entries should split into 2 chunks at cap {MAX_REGISTER_RELATIVE_PATHS_BATCH}"
        );
        assert_eq!(chunks[0].len(), MAX_REGISTER_RELATIVE_PATHS_BATCH);
        assert_eq!(chunks[1].len(), 1);
    }

    /// 1000 entries → exactly 2 full chunks (boundary check on the
    /// exact-multiple case that's a common off-by-one).
    #[test]
    fn chunking_produces_two_full_chunks_at_exact_double() {
        let entries: Vec<RegisterRelativePathEntry> = (0..1000u32)
            .map(|i| RegisterRelativePathEntry {
                path_hash: [0u8; 32],
                relative_path: format!("file_{i}"),
            })
            .collect();

        let chunks: Vec<_> = entries.chunks(MAX_REGISTER_RELATIVE_PATHS_BATCH).collect();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), MAX_REGISTER_RELATIVE_PATHS_BATCH);
        assert_eq!(chunks[1].len(), MAX_REGISTER_RELATIVE_PATHS_BATCH);
    }
}
