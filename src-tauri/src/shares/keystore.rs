//! Persistent storage for share keys: maps `share_token → [u8; 32]`.
//!
//! Implements [`hcfs_client::client::share::ShareKeystore`] backed by the
//! desktop app's SQLite pool. The keystore is rebuilt on startup like
//! every other table (see `utils::schema::ensure_table_schema`) and
//! survives across app restarts so the user can still see filenames in
//! "My Shares" the next day.
//!
//! ## Async/sync bridge
//!
//! `ShareKeystore` is intentionally sync — hcfs-client wants to keep
//! WASM (IndexedDB) and native (sqlx) consumers symmetric without
//! forcing every caller into an async-trait dependency. Our pool is
//! async (`sqlx::sqlite::SqlitePool`), so each method routes its query
//! through `tokio::task::block_in_place` + `Handle::current().block_on`
//! — the documented pattern for running blocking work on a
//! multi-threaded tokio runtime.
//!
//! Verified at <https://docs.rs/tokio/latest/tokio/task/fn.block_in_place.html>:
//! `block_in_place` panics on a single-threaded runtime. Cargo.toml
//! enables tokio's `rt-multi-thread` feature and Tauri 2 commands run
//! on the multi-thread reactor, so the panic path is unreachable in
//! production. The unit tests below pin a multi-threaded flavor for
//! the same reason.

use hcfs_client::client::share::{ShareError, ShareKeystore};
use sqlx::sqlite::SqlitePool;
use std::collections::HashMap;
use std::future::Future;
use tokio::runtime::Handle;
use tokio::task::block_in_place;

/// SQLite-backed [`ShareKeystore`]. Cheap to clone — `SqlitePool`
/// is an `Arc` internally — so callers can stash a handle next to
/// their `HcfsClient` without worrying about lifetimes.
#[derive(Clone)]
pub struct SqliteShareKeystore {
    pool: SqlitePool,
}

impl SqliteShareKeystore {
    /// Build a keystore over an already-initialised pool. The
    /// `share_keystore` table must exist; `ensure_table_schema`
    /// creates it on every startup.
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

/// Run `fut` to completion from a sync context that lives inside a
/// tokio runtime. See module docs for the runtime-flavor contract.
fn run_sync<F: Future>(fut: F) -> F::Output {
    block_in_place(|| Handle::current().block_on(fut))
}

/// Map any sqlx-side failure into the `ShareError::Keystore` variant
/// the trait surfaces. We don't try to classify further — the caller
/// (hcfs-client) treats every keystore failure the same way.
fn map_db<E: std::fmt::Display>(e: E) -> ShareError {
    ShareError::Keystore(format!("sqlite: {e}"))
}

impl ShareKeystore for SqliteShareKeystore {
    fn put(&self, token: &str, share_key: &[u8; 32]) -> Result<(), ShareError> {
        let pool = self.pool.clone();
        let token = token.to_owned();
        // sqlx needs an owned `Vec<u8>` whose lifetime spans the await,
        // so we copy. The temporary heap allocation holds the secret
        // until this scope ends — which is the same trust boundary the
        // caller's `&[u8; 32]` already lives behind.
        let key_vec: Vec<u8> = share_key.to_vec();
        run_sync(async move {
            sqlx::query(
                "INSERT INTO share_keystore (share_token, share_key) \
                 VALUES (?, ?) \
                 ON CONFLICT(share_token) DO UPDATE SET share_key = excluded.share_key",
            )
            .bind(&token)
            .bind(&key_vec)
            .execute(&pool)
            .await
            .map(|_| ())
            .map_err(map_db)
        })
    }

    fn get(&self, token: &str) -> Result<Option<[u8; 32]>, ShareError> {
        let pool = self.pool.clone();
        let token = token.to_owned();
        let row: Option<Vec<u8>> = run_sync(async move {
            sqlx::query_scalar::<_, Vec<u8>>("SELECT share_key FROM share_keystore WHERE share_token = ?")
                .bind(&token)
                .fetch_optional(&pool)
                .await
                .map_err(map_db)
        })?;
        match row {
            None => Ok(None),
            Some(blob) => {
                // We don't try to zeroize the heap blob: sqlx and
                // SQLite both copy the bytes through buffers we don't
                // own (decode buffer → Vec, plus the WAL/page cache
                // mmap pages outside any allocator we control), so a
                // `Zeroizing` wrapper here would close the smallest
                // possible window and give a false sense of secrecy.
                // Treat the encrypted DB itself as the trust boundary.
                let arr: [u8; 32] = blob
                    .as_slice()
                    .try_into()
                    .map_err(|_| ShareError::Keystore(format!("share_keystore row has invalid key length {}", blob.len())))?;
                Ok(Some(arr))
            }
        }
    }

    fn forget(&self, token: &str) -> Result<(), ShareError> {
        let pool = self.pool.clone();
        let token = token.to_owned();
        run_sync(async move {
            sqlx::query("DELETE FROM share_keystore WHERE share_token = ?")
                .bind(&token)
                .execute(&pool)
                .await
                .map(|_| ())
                .map_err(map_db)
        })
    }
}

impl SqliteShareKeystore {
    /// Batched key lookup keyed by `share_token`.
    ///
    /// `ShareKeystore::get` is called once per row by hcfs-client (to
    /// decrypt filenames) AND once per row by `hcfs_list_shares` (to
    /// rebuild the share URL). For a "My Shares" page with N shares,
    /// the per-row `get` path issues 2·N sequential `block_in_place`
    /// round-trips, each acquiring a fresh sqlx connection from a
    /// pool with a small fixed cap. Halve that to N + 1 by issuing one
    /// `WHERE share_token IN (...)` query for the whole page.
    ///
    /// Mis-sized rows (which the DB-level `CHECK (length(share_key)
    /// = 32)` should already prevent at insert time) are silently
    /// skipped here — the per-row [`ShareKeystore::get`] would surface
    /// them as a `Keystore` error, but during a list-many we'd rather
    /// leave the URL unbuildable than fail the whole page.
    pub fn get_many(&self, tokens: &[&str]) -> Result<HashMap<String, [u8; 32]>, ShareError> {
        if tokens.is_empty() {
            return Ok(HashMap::new());
        }
        let pool = self.pool.clone();
        let owned: Vec<String> = tokens.iter().map(|s| (*s).to_string()).collect();
        run_sync(async move {
            // sqlx 0.8 doesn't expand a `Vec<T>` into an IN-list (see
            // launchbadge/sqlx#875), so we materialise placeholders by
            // hand. The placeholder count is bounded by the number of
            // active shares the server returned, which has its own
            // upstream cap, so we stay well below SQLite's 999-param
            // ceiling without an explicit guard.
            let placeholders = vec!["?"; owned.len()].join(", ");
            let sql = format!("SELECT share_token, share_key FROM share_keystore WHERE share_token IN ({placeholders})");
            let mut q = sqlx::query_as::<_, (String, Vec<u8>)>(&sql);
            for t in &owned {
                q = q.bind(t);
            }
            let rows = q.fetch_all(&pool).await.map_err(map_db)?;
            let mut map = HashMap::with_capacity(rows.len());
            for (token, blob) in rows {
                if let Ok(arr) = <[u8; 32]>::try_from(blob.as_slice()) {
                    map.insert(token, arr);
                }
            }
            Ok(map)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    use tempfile::TempDir;

    /// Build a tempfile-backed pool so `block_in_place + block_on` cannot
    /// race the in-memory connection lifecycle. `:memory:` URLs give each
    /// sqlx connection its own DB unless `cache=shared`, and the pool may
    /// cycle the connection across `block_on` boundaries — using a real
    /// file removes the ambiguity and matches how the desktop runs in
    /// production.
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
    async fn put_get_roundtrip() {
        let (_dir, pool) = fresh_pool().await;
        let ks = SqliteShareKeystore::new(pool);
        let key = [42u8; 32];
        ks.put("tok-1", &key).expect("put");
        assert_eq!(ks.get("tok-1").expect("get"), Some(key));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_missing_returns_none() {
        let (_dir, pool) = fresh_pool().await;
        let ks = SqliteShareKeystore::new(pool);
        assert_eq!(ks.get("nope").expect("get"), None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn put_replaces_existing_key() {
        let (_dir, pool) = fresh_pool().await;
        let ks = SqliteShareKeystore::new(pool);
        let k1 = [1u8; 32];
        let k2 = [2u8; 32];
        ks.put("tok", &k1).expect("put-1");
        ks.put("tok", &k2).expect("put-2");
        assert_eq!(ks.get("tok").expect("get"), Some(k2));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn forget_removes_row_and_is_idempotent() {
        let (_dir, pool) = fresh_pool().await;
        let ks = SqliteShareKeystore::new(pool);
        let key = [7u8; 32];
        ks.put("tok", &key).expect("put");
        ks.forget("tok").expect("forget");
        assert_eq!(ks.get("tok").expect("get"), None);
        ks.forget("tok").expect("forget-twice");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_many_returns_only_known_tokens() {
        let (_dir, pool) = fresh_pool().await;
        let ks = SqliteShareKeystore::new(pool);
        let k1 = [1u8; 32];
        let k3 = [3u8; 32];
        ks.put("tok-1", &k1).expect("put-1");
        ks.put("tok-3", &k3).expect("put-3");
        let map = ks.get_many(&["tok-1", "tok-2", "tok-3"]).expect("get_many");
        assert_eq!(map.get("tok-1"), Some(&k1));
        assert_eq!(map.get("tok-3"), Some(&k3));
        assert!(!map.contains_key("tok-2"), "missing tokens must not appear in the map");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_many_with_empty_input_avoids_db_round_trip() {
        let (_dir, pool) = fresh_pool().await;
        let ks = SqliteShareKeystore::new(pool);
        // Empty input must not build a `WHERE share_token IN ()` query
        // — that's invalid SQL. The early-return path is the contract.
        let map = ks.get_many(&[]).expect("get_many empty");
        assert!(map.is_empty());
    }

    /// The DB-level `CHECK (length(share_key) = 32)` is the last line
    /// of defence against a programming error that would otherwise
    /// surface as a confusing AEAD failure several layers up.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn db_check_rejects_wrong_length_key() {
        let (_dir, pool) = fresh_pool().await;
        let bad: Vec<u8> = vec![0u8; 31];
        let res = sqlx::query("INSERT INTO share_keystore (share_token, share_key) VALUES (?, ?)")
            .bind("tok")
            .bind(&bad)
            .execute(&pool)
            .await;
        assert!(res.is_err(), "DB CHECK should reject 31-byte key, got: {res:?}");
    }
}
