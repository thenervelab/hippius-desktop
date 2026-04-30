//! Local-only sidecar that pins a `share_token` back to the file it
//! was minted from.
//!
//! ## Why this exists
//!
//! `share_keystore` only knows the per-share crypto key — it can't say
//! "this file is currently shared" or "reshare the same file with a
//! fresh TTL", because it has no idea which file `share_token` came
//! from. We could plumb `(folder_label, relative_path)` through
//! `ShareKeystore::put` upstream, but that trait is shared with the
//! WASM recipient (which doesn't have a sync folder concept) and the
//! data is desktop-only anyway. A sibling table is cheaper and keeps
//! the origin scoped to the device that minted the share.
//!
//! ## Lifecycle
//!
//! - Insert: `hcfs_create_share` calls [`record`] right after the
//!   server confirms the new token. A failure here is logged but does
//!   not fail the user-facing share — the link is already live, and
//!   the worst-case impact is that the per-file badge won't appear
//!   for this row.
//! - Delete: `hcfs_revoke_share` calls [`forget`] after `revoke_share`
//!   returns Ok. Idempotent: `DELETE … WHERE share_token = ?` is fine
//!   on an already-missing row.
//! - Drift cleanup: `hcfs_list_shares` calls [`prune`] every refresh,
//!   scoped by `owner`, so server-side TTL reaping is mirrored locally
//!   without growing this table forever.

use crate::error::Result;
use sqlx::sqlite::SqlitePool;
use std::collections::HashMap;
use tracing::warn;

/// One row of the sidecar, returned from [`fetch_for_tokens`]. Plain
/// `(folder_label, relative_path)` so the caller can either attach it
/// to the wire `ShareSummary` or feed it to a Reshare command.
#[derive(Debug, Clone)]
pub struct ShareOrigin {
    pub folder_label: String,
    pub relative_path: String,
}

/// Upsert the origin row for a freshly-minted share. Upsert (not
/// insert) so a Reshare flow that mints a new token over the same
/// `(label, rel)` is idempotent if the unique constraint ever
/// expands. The PK is `share_token` so the conflict target is stable
/// across schema tweaks.
///
/// `relative_path` is stored verbatim — whatever the FE handed in.
/// HFS+/APFS NFD ↔ NFC drift between the create-share path and a
/// later file-list lookup surfaces as a missing per-file badge,
/// never as a broken share or wrong file. Same posture as
/// `sync::files::resolve_file_path` — we accept the cosmetic miss
/// rather than carry a normalization invariant across modules.
///
/// # Errors
///
/// Returns `Err` if the SQLite write fails. The caller in
/// `hcfs_create_share` downgrades this to a warn-level log because
/// the share itself has already been created on the server — the
/// user-facing operation has already succeeded.
pub async fn record(
    pool: &SqlitePool,
    share_token: &str,
    owner: &str,
    folder_label: &str,
    relative_path: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO share_origin (share_token, owner, folder_label, relative_path) \
         VALUES (?, ?, ?, ?) \
         ON CONFLICT(share_token) DO UPDATE SET \
             owner = excluded.owner, \
             folder_label = excluded.folder_label, \
             relative_path = excluded.relative_path",
    )
    .bind(share_token)
    .bind(owner)
    .bind(folder_label)
    .bind(relative_path)
    .execute(pool)
    .await?;
    Ok(())
}

/// Remove the row for a revoked token. Idempotent — calling on a
/// missing token is a no-op.
///
/// # Errors
///
/// Returns `Err` only on a hard SQLite failure (not on a missing row).
pub async fn forget(pool: &SqlitePool, share_token: &str) -> Result<()> {
    sqlx::query("DELETE FROM share_origin WHERE share_token = ?")
        .bind(share_token)
        .execute(pool)
        .await?;
    Ok(())
}

/// Look up origin rows for a batch of tokens.
///
/// Issues a single `WHERE share_token IN (?, ?, …)` query — same trick
/// `SqliteShareKeystore::get_many` uses — so a 50-row "My Shares"
/// page costs one round-trip instead of fifty.
///
/// Tokens not present in the table simply don't appear in the returned
/// map; the caller decides whether that's a "key forgotten" row or a
/// legacy share created before this table existed.
///
/// # Errors
///
/// Returns `Err` on a hard SQLite failure.
pub async fn fetch_for_tokens(pool: &SqlitePool, tokens: &[&str]) -> Result<HashMap<String, ShareOrigin>> {
    if tokens.is_empty() {
        return Ok(HashMap::new());
    }
    // sqlx 0.8 doesn't expand `Vec<T>` into an IN-list (see
    // launchbadge/sqlx#875), so build placeholders by hand. The token
    // count is bounded by the upstream "My Shares" page size, which
    // is well below SQLite's 999-parameter ceiling.
    let placeholders = vec!["?"; tokens.len()].join(", ");
    let sql = format!(
        "SELECT share_token, folder_label, relative_path \
         FROM share_origin WHERE share_token IN ({placeholders})"
    );
    let mut q = sqlx::query_as::<_, (String, String, String)>(&sql);
    for t in tokens {
        q = q.bind(*t);
    }
    let rows = q.fetch_all(pool).await?;
    let mut map = HashMap::with_capacity(rows.len());
    for (token, folder_label, relative_path) in rows {
        map.insert(token, ShareOrigin { folder_label, relative_path });
    }
    Ok(map)
}

/// Drop rows for `owner` whose `share_token` isn't in `active_tokens`.
///
/// Mirrors server-side TTL expiry into our local sidecar so the table
/// doesn't grow forever. Scoped by `owner` so a multi-account install
/// can't accidentally evict another account's rows.
///
/// `active_tokens` may be empty — that's the legitimate "this account
/// has zero active shares right now" case, which means every row for
/// this owner is stale and should go.
///
/// **Caller invariant:** `active_tokens` must enumerate ALL of the
/// owner's currently-active shares. The only caller today is
/// `hcfs_list_shares`, which fetches the complete unpaged list from
/// hcfs-server. If that ever paginates, this prune would over-evict to
/// a single page's worth of rows; switch to a TTL-based reaper before
/// crossing that boundary.
///
/// Logs at warn level on failure but never returns the error: this is
/// best-effort cleanup, never a reason to fail a user-facing list call.
pub async fn prune(pool: &SqlitePool, owner: &str, active_tokens: &[&str]) {
    let result = if active_tokens.is_empty() {
        sqlx::query("DELETE FROM share_origin WHERE owner = ?")
            .bind(owner)
            .execute(pool)
            .await
    } else {
        let placeholders = vec!["?"; active_tokens.len()].join(", ");
        let sql = format!("DELETE FROM share_origin WHERE owner = ? AND share_token NOT IN ({placeholders})");
        let mut q = sqlx::query(&sql).bind(owner);
        for t in active_tokens {
            q = q.bind(*t);
        }
        q.execute(pool).await
    };
    if let Err(e) = result {
        warn!(error = %e, "share_origin prune failed (non-fatal)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    use tempfile::TempDir;

    async fn fresh_pool() -> (TempDir, SqlitePool) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("test.db");
        let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", db_path.display()))
            .expect("opts")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.expect("pool");
        crate::utils::schema::ensure_table_schema(&pool).await.expect("schema");
        (dir, pool)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn record_then_fetch_returns_row() {
        let (_dir, pool) = fresh_pool().await;
        record(&pool, "tok-a", "owner1", "Drive", "sub/file.txt").await.expect("record");
        let map = fetch_for_tokens(&pool, &["tok-a"]).await.expect("fetch");
        let got = map.get("tok-a").expect("present");
        assert_eq!(got.folder_label, "Drive");
        assert_eq!(got.relative_path, "sub/file.txt");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn record_overwrites_on_same_token() {
        let (_dir, pool) = fresh_pool().await;
        record(&pool, "tok", "owner1", "Drive", "a.txt").await.expect("record-1");
        // Reshare flow: same token rebound to a new path. The conflict
        // resolution is last-write-wins upsert, NOT idempotent — a
        // re-record can change the row. Pin that here so a future
        // refactor that demotes upsert to plain INSERT fails this test.
        record(&pool, "tok", "owner1", "Drive", "b.txt").await.expect("record-2");
        let map = fetch_for_tokens(&pool, &["tok"]).await.expect("fetch");
        assert_eq!(map.get("tok").expect("present").relative_path, "b.txt");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn forget_is_idempotent_on_missing_token() {
        let (_dir, pool) = fresh_pool().await;
        forget(&pool, "never-existed").await.expect("forget-empty");
        record(&pool, "tok", "owner1", "Drive", "a.txt").await.expect("record");
        forget(&pool, "tok").await.expect("forget-existing");
        forget(&pool, "tok").await.expect("forget-twice");
        let map = fetch_for_tokens(&pool, &["tok"]).await.expect("fetch");
        assert!(map.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fetch_with_empty_input_does_not_query_db() {
        let (_dir, pool) = fresh_pool().await;
        // The helper must early-return — `WHERE share_token IN ()` is
        // invalid SQL and the unit test pins the contract.
        let map = fetch_for_tokens(&pool, &[]).await.expect("fetch-empty");
        assert!(map.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn prune_drops_only_inactive_rows_for_owner() {
        let (_dir, pool) = fresh_pool().await;
        record(&pool, "stale-1", "owner-A", "Drive", "x").await.expect("record-1");
        record(&pool, "live-1", "owner-A", "Drive", "y").await.expect("record-2");
        record(&pool, "stale-2", "owner-B", "Drive", "z").await.expect("record-3");
        prune(&pool, "owner-A", &["live-1"]).await;
        // owner-A keeps live-1 only.
        let a_map = fetch_for_tokens(&pool, &["stale-1", "live-1"]).await.expect("fetch-A");
        assert!(!a_map.contains_key("stale-1"));
        assert!(a_map.contains_key("live-1"));
        // owner-B is untouched even though we passed it no live tokens.
        let b_map = fetch_for_tokens(&pool, &["stale-2"]).await.expect("fetch-B");
        assert!(b_map.contains_key("stale-2"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn prune_with_no_active_tokens_clears_owner_only() {
        let (_dir, pool) = fresh_pool().await;
        record(&pool, "stale", "owner-A", "Drive", "x").await.expect("record-1");
        record(&pool, "kept", "owner-B", "Drive", "y").await.expect("record-2");
        // owner-A has zero active shares right now — every row should go.
        prune(&pool, "owner-A", &[]).await;
        let a_map = fetch_for_tokens(&pool, &["stale"]).await.expect("fetch-A");
        assert!(a_map.is_empty());
        let b_map = fetch_for_tokens(&pool, &["kept"]).await.expect("fetch-B");
        assert!(b_map.contains_key("kept"));
    }
}
