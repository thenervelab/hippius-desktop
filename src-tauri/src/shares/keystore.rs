//! Persistent storage for share secrets: maps `share_token` to a
//! [`ShareSecret`], stored as a kind tag plus its bytes.
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

use hcfs_client::client::share::{ShareError, ShareKeystore, ShareSecret};
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

/// Column value for a public row. A `ShareSecret` variant is persisted as
/// this discriminator plus its bytes, so a private blob can never be read
/// back as a raw key (which would rebuild a password-free URL).
const KIND_PUBLIC: &str = "public";
/// Column value for a password-protected row.
const KIND_PRIVATE: &str = "private";
/// Column value for a link-secret folder link (`#s=`): the 32-byte link
/// secret. Its own kind, never `public`, so a link secret can never be read
/// back as a drive key and rebuilt into a `#k=` URL that opens nothing.
const KIND_FOLDER_LINK: &str = "folder_link";
/// Column value for a password-protected link-secret folder link (`#sp=`):
/// the link secret wrapped under the password.
const KIND_FOLDER_LINK_PRIVATE: &str = "folder_link_private";
/// Column value for a link-secret file link (`#s=` on `/share/`): the 32-byte
/// link secret. Its own kind, never `public` or `folder_link`: read back as
/// a share key it would rebuild a `#k=` URL that opens nothing, and read back
/// as a folder link secret it would reach a folder path (hcfs#1253).
const KIND_FILE_LINK: &str = "file_link";
/// Column value for a password-protected link-secret file link (`#sp=`): the
/// link secret wrapped under the password.
const KIND_FILE_LINK_PRIVATE: &str = "file_link_private";

/// Ends a token's opened file link share key (`shares::file_link_key`, the
/// `share_file_link_key` table) whenever its secret is replaced or forgotten.
const DELETE_FILE_LINK_KEY: &str = "DELETE FROM share_file_link_key WHERE share_token = ?";

/// The 32-byte payload of a `public`, `folder_link` or `file_link` row.
fn key_bytes(kind: &str, bytes: &[u8]) -> Result<[u8; 32], ShareError> {
    bytes
        .try_into()
        .map_err(|_| ShareError::Keystore(format!("share_keystore {kind} row has invalid key length {}", bytes.len())))
}

/// Rebuild a [`ShareSecret`] from a stored `(secret_kind, share_key)` pair.
///
/// A row whose kind and payload disagree is a hard error rather than a
/// best-effort coercion: silently treating an unreadable private row as
/// public is exactly the failure this type exists to prevent.
fn decode_secret(kind: &str, bytes: Vec<u8>) -> Result<ShareSecret, ShareError> {
    match kind {
        KIND_PUBLIC => {
            // We don't try to zeroize the heap blob: sqlx and SQLite both
            // copy the bytes through buffers we don't own (decode buffer →
            // Vec, plus the WAL/page cache mmap pages outside any allocator
            // we control), so a `Zeroizing` wrapper here would close the
            // smallest possible window and give a false sense of secrecy.
            // Treat the encrypted DB itself as the trust boundary.
            Ok(ShareSecret::Public(key_bytes(kind, &bytes)?))
        }
        KIND_PRIVATE => Ok(ShareSecret::Private(bytes)),
        KIND_FOLDER_LINK => Ok(ShareSecret::FolderLink(key_bytes(kind, &bytes)?)),
        KIND_FOLDER_LINK_PRIVATE => Ok(ShareSecret::FolderLinkPrivate(bytes)),
        KIND_FILE_LINK => Ok(ShareSecret::FileLink(key_bytes(kind, &bytes)?)),
        KIND_FILE_LINK_PRIVATE => Ok(ShareSecret::FileLinkPrivate(bytes)),
        other => Err(ShareError::Keystore(format!("share_keystore row has unknown secret_kind {other:?}"))),
    }
}

impl ShareKeystore for SqliteShareKeystore {
    fn put(&self, token: &str, secret: &ShareSecret) -> Result<(), ShareError> {
        let pool = self.pool.clone();
        let token = token.to_owned();
        // sqlx needs owned data whose lifetime spans the await, so we copy.
        // The temporary heap allocation holds the secret until this scope
        // ends — the same trust boundary the caller's reference already
        // lives behind.
        let (kind, bytes): (&str, Vec<u8>) = match secret {
            ShareSecret::Public(key) => (KIND_PUBLIC, key.to_vec()),
            ShareSecret::Private(blob) => (KIND_PRIVATE, blob.clone()),
            ShareSecret::FolderLink(secret) => (KIND_FOLDER_LINK, secret.to_vec()),
            ShareSecret::FolderLinkPrivate(blob) => (KIND_FOLDER_LINK_PRIVATE, blob.clone()),
            ShareSecret::FileLink(secret) => (KIND_FILE_LINK, secret.to_vec()),
            ShareSecret::FileLinkPrivate(blob) => (KIND_FILE_LINK_PRIVATE, blob.clone()),
        };
        run_sync(async move {
            // One transaction: a new secret and the end of the old one's
            // opened share key (`shares::file_link_key`) land together. A share
            // key opened under the previous secret belongs to that secret only.
            let mut tx = pool.begin().await.map_err(map_db)?;
            sqlx::query(
                "INSERT INTO share_keystore (share_token, secret_kind, share_key) \
                 VALUES (?, ?, ?) \
                 ON CONFLICT(share_token) DO UPDATE SET \
                     secret_kind = excluded.secret_kind, \
                     share_key   = excluded.share_key",
            )
            .bind(&token)
            .bind(kind)
            .bind(&bytes)
            .execute(&mut *tx)
            .await
            .map_err(map_db)?;
            sqlx::query(DELETE_FILE_LINK_KEY).bind(&token).execute(&mut *tx).await.map_err(map_db)?;
            tx.commit().await.map_err(map_db)
        })
    }

    fn get(&self, token: &str) -> Result<Option<ShareSecret>, ShareError> {
        let pool = self.pool.clone();
        let token = token.to_owned();
        let row: Option<(String, Vec<u8>)> = run_sync(async move {
            sqlx::query_as::<_, (String, Vec<u8>)>("SELECT secret_kind, share_key FROM share_keystore WHERE share_token = ?")
                .bind(&token)
                .fetch_optional(&pool)
                .await
                .map_err(map_db)
        })?;
        row.map(|(kind, bytes)| decode_secret(&kind, bytes)).transpose()
    }

    fn forget(&self, token: &str) -> Result<(), ShareError> {
        let pool = self.pool.clone();
        let token = token.to_owned();
        run_sync(async move {
            let mut tx = pool.begin().await.map_err(map_db)?;
            sqlx::query("DELETE FROM share_keystore WHERE share_token = ?")
                .bind(&token)
                .execute(&mut *tx)
                .await
                .map_err(map_db)?;
            sqlx::query(DELETE_FILE_LINK_KEY).bind(&token).execute(&mut *tx).await.map_err(map_db)?;
            tx.commit().await.map_err(map_db)
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
    /// Rows the DB-level CHECK constraints should already have prevented
    /// (a mis-sized payload, an unknown `secret_kind`) are silently skipped
    /// here — the per-row [`ShareKeystore::get`] surfaces them as a
    /// `Keystore` error, but during a list-many we'd rather leave one row's
    /// URL unbuildable than fail the whole page. Skipping is safe in the
    /// direction that matters: a dropped row renders as "key not on this
    /// device", never as a public link to a private share.
    pub fn get_many(&self, tokens: &[&str]) -> Result<HashMap<String, ShareSecret>, ShareError> {
        if tokens.is_empty() {
            return Ok(HashMap::new());
        }
        let pool = self.pool.clone();
        let owned: Vec<String> = tokens.iter().map(|s| (*s).to_string()).collect();
        run_sync(async move {
            // sqlx 0.8 doesn't expand a `Vec<T>` into an IN-list, so we
            // materialise placeholders by hand. The placeholder count is
            // bounded by the number of active shares the server returned,
            // which has its own upstream cap, so we stay well below
            // SQLite's 999-param ceiling without an explicit guard.
            let placeholders = vec!["?"; owned.len()].join(", ");
            let sql = format!(
                "SELECT share_token, secret_kind, share_key FROM share_keystore \
                 WHERE share_token IN ({placeholders})"
            );
            let mut q = sqlx::query_as::<_, (String, String, Vec<u8>)>(&sql);
            for t in &owned {
                q = q.bind(t);
            }
            let rows = q.fetch_all(&pool).await.map_err(map_db)?;
            let mut map = HashMap::with_capacity(rows.len());
            for (token, kind, bytes) in rows {
                if let Ok(secret) = decode_secret(&kind, bytes) {
                    map.insert(token, secret);
                }
            }
            Ok(map)
        })
    }

    /// Every decodable stored secret, keyed by its plaintext token.
    ///
    /// Exists for the folder-share listing: the server returns only
    /// `token_hash` (blake3 hex) per row and never echoes a folder-share
    /// token after create, so matching listing rows to locally held tokens
    /// means hashing every stored token — there is no reverse lookup to
    /// batch on. The table holds one row per share this device minted, so
    /// the full scan is a page-sized read. File-share and folder-share
    /// tokens share this table; a file token's hash simply never appears
    /// in the folder listing, so scanning both kinds is harmless.
    ///
    /// Undecodable rows are skipped with the same safe-direction rationale
    /// as [`Self::get_many`]: a dropped row renders as "minted elsewhere",
    /// never as a public link to a private share.
    pub fn all_entries(&self) -> Result<Vec<(String, ShareSecret)>, ShareError> {
        let pool = self.pool.clone();
        run_sync(async move {
            let rows = sqlx::query_as::<_, (String, String, Vec<u8>)>("SELECT share_token, secret_kind, share_key FROM share_keystore")
                .fetch_all(&pool)
                .await
                .map_err(map_db)?;
            Ok(rows
                .into_iter()
                .filter_map(|(token, kind, bytes)| decode_secret(&kind, bytes).ok().map(|secret| (token, secret)))
                .collect())
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
        let secret = ShareSecret::Public([42u8; 32]);
        ks.put("tok-1", &secret).expect("put");
        assert_eq!(ks.get("tok-1").expect("get"), Some(secret));
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
        let k1 = ShareSecret::Public([1u8; 32]);
        let k2 = ShareSecret::Public([2u8; 32]);
        ks.put("tok", &k1).expect("put-1");
        ks.put("tok", &k2).expect("put-2");
        assert_eq!(ks.get("tok").expect("get"), Some(k2));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn forget_removes_row_and_is_idempotent() {
        let (_dir, pool) = fresh_pool().await;
        let ks = SqliteShareKeystore::new(pool);
        ks.put("tok", &ShareSecret::Public([7u8; 32])).expect("put");
        ks.forget("tok").expect("forget");
        assert_eq!(ks.get("tok").expect("get"), None);
        ks.forget("tok").expect("forget-twice");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_many_returns_only_known_tokens() {
        let (_dir, pool) = fresh_pool().await;
        let ks = SqliteShareKeystore::new(pool);
        let k1 = ShareSecret::Public([1u8; 32]);
        let k3 = ShareSecret::Public([3u8; 32]);
        ks.put("tok-1", &k1).expect("put-1");
        ks.put("tok-3", &k3).expect("put-3");
        let map = ks.get_many(&["tok-1", "tok-2", "tok-3"]).expect("get_many");
        assert_eq!(map.get("tok-1"), Some(&k1));
        assert_eq!(map.get("tok-3"), Some(&k3));
        assert!(!map.contains_key("tok-2"), "missing tokens must not appear in the map");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn all_entries_returns_every_row_with_its_kind() {
        let (_dir, pool) = fresh_pool().await;
        let ks = SqliteShareKeystore::new(pool);
        let public = ShareSecret::Public([1u8; 32]);
        let private = ShareSecret::Private(vec![2u8; 89]);
        ks.put("tok-pub", &public).expect("put public");
        ks.put("tok-priv", &private).expect("put private");

        let mut entries = ks.all_entries().expect("all_entries");
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(entries, vec![("tok-priv".to_string(), private), ("tok-pub".to_string(), public)]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn all_entries_on_an_empty_table_is_empty() {
        let (_dir, pool) = fresh_pool().await;
        let ks = SqliteShareKeystore::new(pool);
        assert!(ks.all_entries().expect("all_entries").is_empty());
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

    /// The DB-level length CHECK is the last line of defence against a
    /// programming error that would otherwise surface as a confusing AEAD
    /// failure several layers up.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn db_check_rejects_wrong_length_key() {
        let (_dir, pool) = fresh_pool().await;
        let bad: Vec<u8> = vec![0u8; 31];
        let res = sqlx::query("INSERT INTO share_keystore (share_token, secret_kind, share_key) VALUES (?, 'public', ?)")
            .bind("tok")
            .bind(&bad)
            .execute(&pool)
            .await;
        assert!(res.is_err(), "DB CHECK should reject 31-byte key, got: {res:?}");
    }

    /// A wrapped blob is longer than 32 bytes, so the public-row CHECK must
    /// not apply to it — otherwise password-protected shares could not be
    /// persisted at all.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn private_secret_round_trips_and_keeps_its_kind() {
        let (_dir, pool) = fresh_pool().await;
        let ks = SqliteShareKeystore::new(pool);
        // 89 bytes: the real wrapped-blob framing (1 + 16 + 24 + 32 + 16).
        let blob: Vec<u8> = (0..89u8).collect();
        let secret = ShareSecret::Private(blob);

        ks.put("tok-private", &secret).expect("put private");
        let read_back = ks.get("tok-private").expect("get").expect("row present");
        assert_eq!(read_back, secret);
        assert!(
            read_back.is_private(),
            "a private secret must never read back as public — that is what would \
             let a caller rebuild a password-free URL",
        );
    }

    /// Overwriting a token must replace the *kind* too, not just the bytes.
    /// A stale `secret_kind` would misinterpret the new payload.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn put_replaces_kind_as_well_as_bytes() {
        let (_dir, pool) = fresh_pool().await;
        let ks = SqliteShareKeystore::new(pool);
        let blob: Vec<u8> = vec![9u8; 89];

        ks.put("tok", &ShareSecret::Public([1u8; 32])).expect("put public");
        ks.put("tok", &ShareSecret::Private(blob.clone())).expect("put private");
        assert_eq!(ks.get("tok").expect("get"), Some(ShareSecret::Private(blob)));

        ks.put("tok", &ShareSecret::Public([2u8; 32])).expect("put public again");
        assert_eq!(ks.get("tok").expect("get"), Some(ShareSecret::Public([2u8; 32])));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_many_preserves_the_secret_kind_per_row() {
        let (_dir, pool) = fresh_pool().await;
        let ks = SqliteShareKeystore::new(pool);
        let public = ShareSecret::Public([1u8; 32]);
        let private = ShareSecret::Private(vec![2u8; 89]);
        ks.put("pub", &public).expect("put public");
        ks.put("priv", &private).expect("put private");

        let map = ks.get_many(&["pub", "priv"]).expect("get_many");
        assert_eq!(map.get("pub"), Some(&public));
        assert_eq!(map.get("priv"), Some(&private));
    }

    /// An unrecognised `secret_kind` must be an error, not a silent
    /// fallback to public — coercing an unknown row to a raw key is exactly
    /// the mistake the discriminator exists to prevent.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unknown_secret_kind_is_an_error_not_a_public_fallback() {
        assert!(decode_secret("public", vec![0u8; 32]).is_ok());
        assert!(decode_secret("private", vec![0u8; 89]).is_ok());

        let err = decode_secret("something-else", vec![0u8; 32]).unwrap_err();
        assert!(
            matches!(err, ShareError::Keystore(_)),
            "unknown kind must surface as a keystore error, got {err:?}",
        );
    }

    /// Upgrading an install created before `secret_kind` existed must keep
    /// every stored key readable. The old table had a
    /// `CHECK (length(share_key) = 32)` that SQLite cannot drop in place, so
    /// this exercises the rebuild-and-copy path in `ensure_share_keystore`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn legacy_rows_survive_the_secret_kind_migration() {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("legacy.db");
        let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", db_path.display()))
            .expect("opts")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.expect("pool");

        // Recreate the pre-migration table verbatim and seed a row.
        sqlx::query(
            "CREATE TABLE share_keystore (
                share_token TEXT PRIMARY KEY,
                share_key BLOB NOT NULL CHECK (length(share_key) = 32),
                created_at INTEGER NOT NULL DEFAULT (unixepoch())
            )",
        )
        .execute(&pool)
        .await
        .expect("legacy table");
        sqlx::query("INSERT INTO share_keystore (share_token, share_key) VALUES ('legacy', ?)")
            .bind(vec![5u8; 32])
            .execute(&pool)
            .await
            .expect("seed legacy row");

        crate::utils::schema::ensure_table_schema(&pool).await.expect("migrate");

        let ks = SqliteShareKeystore::new(pool.clone());
        assert_eq!(
            ks.get("legacy").expect("get"),
            Some(ShareSecret::Public([5u8; 32])),
            "a legacy row must survive as a public secret",
        );

        // And the rebuilt table must now accept a wrapped blob, which the
        // old CHECK would have rejected.
        ks.put("new-private", &ShareSecret::Private(vec![7u8; 89]))
            .expect("private put must work after migration");
        ks.put("new-file-link", &ShareSecret::FileLink([8u8; 32]))
            .expect("a file link must fit after migration");
        ks.put("new-file-link-p", &ShareSecret::FileLinkPrivate(vec![9u8; 89]))
            .expect("a private file link must fit after migration");
    }

    /// A link-secret folder link keeps its own kind, so it can never be read
    /// back as `Public` and rebuilt into a `#k=` link carrying the secret.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn folder_link_secrets_round_trip_and_keep_their_kind() {
        let (_dir, pool) = fresh_pool().await;
        let ks = SqliteShareKeystore::new(pool);
        let public = ShareSecret::FolderLink([4u8; 32]);
        let private = ShareSecret::FolderLinkPrivate(vec![5u8; 89]);
        ks.put("s", &public).expect("put folder link");
        ks.put("sp", &private).expect("put private folder link");

        assert_eq!(ks.get("s").expect("get"), Some(public.clone()));
        assert_eq!(ks.get("sp").expect("get"), Some(private.clone()));
        let many = ks.get_many(&["s", "sp"]).expect("get_many");
        assert_eq!(many.get("s"), Some(&public));
        assert_eq!(many.get("sp"), Some(&private));

        // Same bytes under the legacy kind would be a different secret.
        ks.put("s", &ShareSecret::Public([4u8; 32])).expect("put public");
        assert_eq!(ks.get("s").expect("get"), Some(ShareSecret::Public([4u8; 32])));
    }

    #[test]
    fn decode_secret_reads_each_folder_link_kind() {
        assert_eq!(
            decode_secret("folder_link", vec![1u8; 32]).expect("32"),
            ShareSecret::FolderLink([1u8; 32])
        );
        assert_eq!(
            decode_secret("folder_link_private", vec![1u8; 89]).expect("89"),
            ShareSecret::FolderLinkPrivate(vec![1u8; 89])
        );
        assert!(decode_secret("folder_link", vec![1u8; 31]).is_err(), "a link secret is exactly 32 bytes");
    }

    /// A row as a previous release's `put` wrote it, into whatever table is
    /// there. Not `put` itself: the previous release's CHECK refuses the new
    /// kinds, and its schema has no `share_file_link_key` table.
    async fn seed_row(pool: &SqlitePool, token: &str, kind: &str, bytes: &[u8]) -> Result<(), sqlx::Error> {
        sqlx::query("INSERT INTO share_keystore (share_token, secret_kind, share_key) VALUES (?, ?, ?)")
            .bind(token)
            .bind(kind)
            .bind(bytes)
            .execute(pool)
            .await
            .map(|_| ())
    }

    /// Upgrading an install whose CHECK names only `public` / `private` must
    /// keep every row and its kind, and then take the folder-link kinds.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_install_from_before_link_secrets_keeps_its_rows() {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("pre-link-secret.db");
        let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", db_path.display()))
            .expect("opts")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.expect("pool");

        // The table exactly as the previous release created it.
        sqlx::query(
            "CREATE TABLE share_keystore (
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
        .execute(&pool)
        .await
        .expect("previous table");
        seed_row(&pool, "pub", "public", &[6u8; 32]).await.expect("seed public");
        seed_row(&pool, "priv", "private", &[7u8; 89]).await.expect("seed private");
        assert!(
            seed_row(&pool, "link", "folder_link", &[8u8; 32]).await.is_err(),
            "the previous CHECK refuses a folder link: the reason for the rebuild"
        );

        crate::utils::schema::ensure_table_schema(&pool).await.expect("migrate");
        // A second start finds the new CHECK and leaves the table alone.
        crate::utils::schema::ensure_table_schema(&pool).await.expect("migrate again");

        let ks = SqliteShareKeystore::new(pool);
        assert_eq!(ks.get("pub").expect("get"), Some(ShareSecret::Public([6u8; 32])));
        assert_eq!(ks.get("priv").expect("get"), Some(ShareSecret::Private(vec![7u8; 89])));
        ks.put("link", &ShareSecret::FolderLink([8u8; 32]))
            .expect("folder link after the rebuild");
        ks.put("link-p", &ShareSecret::FolderLinkPrivate(vec![9u8; 89]))
            .expect("private folder link after the rebuild");
        assert_eq!(ks.get("link").expect("get"), Some(ShareSecret::FolderLink([8u8; 32])));
        ks.put("file", &ShareSecret::FileLink([3u8; 32])).expect("file link after the rebuild");
        ks.put("file-p", &ShareSecret::FileLinkPrivate(vec![4u8; 89]))
            .expect("private file link after the rebuild");
    }

    /// A link-secret file link keeps its own kind: read back as `Public` it
    /// would rebuild a `#k=` URL that opens nothing, and read back as a folder
    /// link secret it would reach a folder path.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn file_link_secrets_round_trip_and_keep_their_kind() {
        let (_dir, pool) = fresh_pool().await;
        let ks = SqliteShareKeystore::new(pool);
        let public = ShareSecret::FileLink([4u8; 32]);
        let private = ShareSecret::FileLinkPrivate(vec![5u8; 89]);
        ks.put("s", &public).expect("put file link");
        ks.put("sp", &private).expect("put private file link");

        assert_eq!(ks.get("s").expect("get"), Some(public.clone()));
        assert_eq!(ks.get("sp").expect("get"), Some(private.clone()));
        let many = ks.get_many(&["s", "sp"]).expect("get_many");
        assert_eq!(many.get("s"), Some(&public));
        assert_eq!(many.get("sp"), Some(&private));
        let mut all = ks.all_entries().expect("all_entries");
        all.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(all, vec![("s".to_string(), public), ("sp".to_string(), private)]);
    }

    #[test]
    fn decode_secret_reads_each_file_link_kind() {
        assert_eq!(decode_secret("file_link", vec![1u8; 32]).expect("32"), ShareSecret::FileLink([1u8; 32]));
        assert_eq!(
            decode_secret("file_link_private", vec![1u8; 89]).expect("89"),
            ShareSecret::FileLinkPrivate(vec![1u8; 89])
        );
        assert!(decode_secret("file_link", vec![1u8; 31]).is_err(), "a link secret is exactly 32 bytes");
    }

    /// The DB CHECK holds each file-link kind to its length, as it does the
    /// older kinds: a 32-byte secret, a longer wrapped blob.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn db_check_holds_the_file_link_kinds_to_their_lengths() {
        let (_dir, pool) = fresh_pool().await;
        for (kind, len) in [("file_link", 33usize), ("file_link", 31), ("file_link_private", 32)] {
            let res = sqlx::query("INSERT INTO share_keystore (share_token, secret_kind, share_key) VALUES (?, ?, ?)")
                .bind(format!("{kind}-{len}"))
                .bind(kind)
                .bind(vec![0u8; len])
                .execute(&pool)
                .await;
            assert!(res.is_err(), "{kind} with {len} bytes must be refused, got {res:?}");
        }
    }

    /// Upgrading an install whose CHECK names the folder-link kinds but not the
    /// file-link ones (the table the previous release created) must keep every
    /// row and its kind, and then take the file-link kinds.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_install_from_before_file_link_secrets_keeps_its_rows() {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("pre-file-link.db");
        let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", db_path.display()))
            .expect("opts")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.expect("pool");

        // The table exactly as the previous release created it.
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS share_keystore (
            share_token TEXT PRIMARY KEY,
            secret_kind TEXT NOT NULL DEFAULT 'public'
                        CHECK (secret_kind IN ('public', 'private', 'folder_link', 'folder_link_private')),
            share_key BLOB NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            CHECK (
                (secret_kind IN ('public', 'folder_link') AND length(share_key) = 32)
             OR (secret_kind IN ('private', 'folder_link_private') AND length(share_key) > 32)
            )
        )",
        )
        .execute(&pool)
        .await
        .expect("previous table");
        let seeded = [
            ("pub", ShareSecret::Public([6u8; 32])),
            ("priv", ShareSecret::Private(vec![7u8; 89])),
            ("folder", ShareSecret::FolderLink([8u8; 32])),
            ("folder-p", ShareSecret::FolderLinkPrivate(vec![9u8; 89])),
        ];
        for (token, secret) in &seeded {
            let (kind, bytes): (&str, &[u8]) = match secret {
                ShareSecret::Public(key) => ("public", key),
                ShareSecret::Private(blob) => ("private", blob),
                ShareSecret::FolderLink(key) => ("folder_link", key),
                ShareSecret::FolderLinkPrivate(blob) => ("folder_link_private", blob),
                ShareSecret::FileLink(_) | ShareSecret::FileLinkPrivate(_) => unreachable!("the previous release stored no file link"),
            };
            seed_row(&pool, token, kind, bytes).await.expect("seed");
        }
        let created_before: i64 = sqlx::query_scalar("SELECT created_at FROM share_keystore WHERE share_token = 'pub'")
            .fetch_one(&pool)
            .await
            .expect("created_at");
        assert!(
            seed_row(&pool, "file", "file_link", &[1u8; 32]).await.is_err(),
            "the previous CHECK refuses a file link: the reason for the rebuild"
        );

        crate::utils::schema::ensure_table_schema(&pool).await.expect("migrate");
        // A second start finds the new CHECK and leaves the table alone.
        crate::utils::schema::ensure_table_schema(&pool).await.expect("migrate again");

        let ks = SqliteShareKeystore::new(pool.clone());
        for (token, secret) in &seeded {
            assert_eq!(ks.get(token).expect("get").as_ref(), Some(secret), "{token} keeps its secret and kind");
        }
        let created_after: i64 = sqlx::query_scalar("SELECT created_at FROM share_keystore WHERE share_token = 'pub'")
            .fetch_one(&pool)
            .await
            .expect("created_at");
        assert_eq!(created_after, created_before, "the rebuild copies created_at");
        ks.put("file", &ShareSecret::FileLink([1u8; 32])).expect("file link after the rebuild");
        ks.put("file-p", &ShareSecret::FileLinkPrivate(vec![2u8; 89]))
            .expect("private file link after the rebuild");
        assert_eq!(ks.get("file").expect("get"), Some(ShareSecret::FileLink([1u8; 32])));
    }

    /// `share_file_link_key` exists after a fresh start and after an upgrade of
    /// a database from the previous release (keystore rows and no such table),
    /// a second start leaves it and its rows alone, and it takes only 32-byte
    /// keys.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_file_link_key_table_is_created_on_a_fresh_and_an_existing_database() {
        use crate::shares::file_link_key::FileLinkKeys;

        let (_fresh_dir, fresh) = fresh_pool().await;
        let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'share_file_link_key'")
            .fetch_one(&fresh)
            .await
            .expect("count");
        assert_eq!(exists, 1, "a fresh database has the table");

        let dir = TempDir::new().expect("tempdir");
        let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", dir.path().join("existing.db").display()))
            .expect("opts")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.expect("pool");
        sqlx::query(&crate::utils::schema::share_keystore_ddl("share_keystore"))
            .execute(&pool)
            .await
            .expect("an existing keystore");
        seed_row(&pool, "pub", "public", &[6u8; 32]).await.expect("seed");

        crate::utils::schema::ensure_table_schema(&pool).await.expect("upgrade");
        let ks = SqliteShareKeystore::new(pool.clone());
        let keys = FileLinkKeys::new(pool.clone());
        assert_eq!(ks.get("pub").expect("get"), Some(ShareSecret::Public([6u8; 32])), "keystore rows survive");
        ks.put("file", &ShareSecret::FileLink([1u8; 32])).expect("put");
        keys.keep("file", &[1u8; 32], &[3u8; 32]).await.expect("keep");

        crate::utils::schema::ensure_table_schema(&pool).await.expect("a second start");
        assert_eq!(keys.get("file").await.expect("read"), Some([3u8; 32]), "a second start keeps kept keys");

        let short = sqlx::query("INSERT INTO share_file_link_key (share_token, share_key) VALUES ('x', ?)")
            .bind(vec![0u8; 31])
            .execute(&pool)
            .await;
        assert!(short.is_err(), "the CHECK refuses a key that is not 32 bytes: {short:?}");
    }
}
