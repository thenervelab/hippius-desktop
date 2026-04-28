//! Integration coverage for the share keystore at the public-API
//! boundary (`crate::shares::SqliteShareKeystore`), exercised through
//! the `tauri_project_lib` library rather than from inside the source
//! tree.
//!
//! The lib-level unit tests in `src/shares/keystore.rs` cover the same
//! shape; this file exists so a refactor that accidentally narrows the
//! `pub use` re-exports gets a loud failure here instead of silently
//! breaking external test code.
//!
//! The network-bound roundtrip (Tauri command → real hcfs-server →
//! anonymous reqwest fetch → AEAD-decrypted plaintext compare) is
//! intentionally NOT in this file — it requires a running hcfs-server
//! and the protocol layer is already covered by hcfs-server's own
//! `tests/shares_routes.rs`. When we add a fake-axum harness or wire
//! a CI-side server, the right home for that test is a new
//! `tests/share_roundtrip.rs` with `#[ignore]` until the harness
//! exists.

use hcfs_client::client::share::ShareKeystore;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::str::FromStr;
use tauri_project_lib::shares::SqliteShareKeystore;
use tauri_project_lib::utils::schema::ensure_table_schema;
use tempfile::TempDir;

async fn fresh_pool() -> (TempDir, sqlx::SqlitePool) {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("integration.db");
    let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", db_path.display()))
        .expect("opts")
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.expect("pool");
    ensure_table_schema(&pool).await.expect("schema");
    (dir, pool)
}

/// End-to-end: a key written through the public `ShareKeystore` trait
/// is recoverable via the same trait, and `forget` actually removes
/// the row. The lib-level tests exercise the same path; this one
/// guards the `pub use` boundary so a future `pub(crate)` slip caught
/// at compile time here rather than at downstream-consumer time.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn share_keystore_round_trip_via_public_api() {
    let (_dir, pool) = fresh_pool().await;
    let ks = SqliteShareKeystore::new(pool);

    let token = "tok-integration";
    let key = [9u8; 32];

    ks.put(token, &key).expect("put");
    assert_eq!(ks.get(token).expect("get"), Some(key));

    ks.forget(token).expect("forget");
    assert_eq!(ks.get(token).expect("after-forget"), None);

    // Idempotent on a missing token — exercise the path the
    // hcfs-client `revoke_share` retry would hit if it tried to
    // forget a token we already cleaned up.
    ks.forget(token).expect("forget-twice");
}
