//! Integration tests for auth token storage, fallback chains, and expiry logic.
//!
//! Uses an in-memory SQLite database — no Tauri AppHandle needed.
//! Tests the raw SQL logic that the Tauri commands wrap.

use sqlx::sqlite::SqlitePool;
use sqlx::Row;

async fn setup_db() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS objectstore_auth_scoped (
            owner TEXT PRIMARY KEY,
            api_token TEXT,
            master_access_key_id TEXT,
            master_secret TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        )",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS objectstore_auth (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            api_token TEXT,
            master_access_key_id TEXT,
            master_secret TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        )",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS auth_session (
            owner TEXT PRIMARY KEY,
            auth_token TEXT,
            token_expiry INTEGER,
            user_id TEXT,
            username TEXT,
            provider TEXT,
            substrate_address TEXT,
            logout_time_minutes INTEGER,
            last_login_at TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        )",
    )
    .execute(&pool)
    .await
    .unwrap();

    pool
}

fn account_key(account_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(account_id.as_bytes());
    hex::encode(&hash[..8])
}

// ── Token Storage ────────────────────────────────────────────────────

#[tokio::test]
async fn save_and_get_token_from_scoped_table() {
    let pool = setup_db().await;
    let owner = account_key("scoped-account-1");

    sqlx::query(
        "INSERT INTO objectstore_auth_scoped (owner, api_token) \
         VALUES (?, ?)",
    )
    .bind(&owner)
    .bind("scoped-token-abc")
    .execute(&pool)
    .await
    .unwrap();

    let row = sqlx::query(
        "SELECT api_token FROM objectstore_auth_scoped WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        row.get::<Option<String>, _>("api_token").unwrap(),
        "scoped-token-abc"
    );
}

#[tokio::test]
async fn fallback_to_legacy_single_row() {
    let pool = setup_db().await;
    let owner = account_key("legacy-account-1");

    // Scoped table has no row for this owner
    let scoped = sqlx::query(
        "SELECT api_token FROM objectstore_auth_scoped WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(scoped.is_none(), "Scoped table should be empty");

    // Legacy single-row table has a token
    sqlx::query(
        "INSERT INTO objectstore_auth (id, api_token) VALUES (1, ?)",
    )
    .bind("legacy-token-xyz")
    .execute(&pool)
    .await
    .unwrap();

    let legacy = sqlx::query(
        "SELECT api_token FROM objectstore_auth WHERE id = 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        legacy.get::<Option<String>, _>("api_token").unwrap(),
        "legacy-token-xyz"
    );
}

// ── Token Fallback ───────────────────────────────────────────────────

#[tokio::test]
async fn fallback_to_auth_session() {
    let pool = setup_db().await;
    let owner = account_key("session-account-1");

    // Neither objectstore table has a token
    let scoped = sqlx::query(
        "SELECT api_token FROM objectstore_auth_scoped WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(scoped.is_none());

    let legacy = sqlx::query(
        "SELECT api_token FROM objectstore_auth WHERE id = 1",
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(legacy.is_none());

    // auth_session has a token
    sqlx::query(
        "INSERT INTO auth_session (owner, auth_token) VALUES (?, ?)",
    )
    .bind(&owner)
    .bind("session-fallback-token")
    .execute(&pool)
    .await
    .unwrap();

    let session = sqlx::query(
        "SELECT auth_token FROM auth_session WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        session.get::<Option<String>, _>("auth_token").unwrap(),
        "session-fallback-token"
    );
}

// ── Token Expiry ─────────────────────────────────────────────────────

const MARGIN_MS: i64 = 3_600_000; // 1 hour

fn is_expiring(expiry: Option<i64>) -> bool {
    match expiry {
        Some(exp) => {
            let now_ms = chrono::Utc::now().timestamp_millis();
            (exp - now_ms) < MARGIN_MS
        }
        None => true,
    }
}

#[tokio::test]
async fn token_not_expiring_when_far_future() {
    let pool = setup_db().await;
    let owner = account_key("expiry-far-future");
    let two_hours_out =
        chrono::Utc::now().timestamp_millis() + 2 * MARGIN_MS;

    sqlx::query(
        "INSERT INTO auth_session (owner, auth_token, token_expiry) \
         VALUES (?, ?, ?)",
    )
    .bind(&owner)
    .bind("far-future-token")
    .bind(two_hours_out)
    .execute(&pool)
    .await
    .unwrap();

    let row = sqlx::query(
        "SELECT token_expiry FROM auth_session WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_one(&pool)
    .await
    .unwrap();

    let expiry = row.get::<Option<i64>, _>("token_expiry");
    assert!(
        !is_expiring(expiry),
        "Token 2 hours out should not be expiring with 1-hour margin"
    );
}

#[tokio::test]
async fn token_expiring_when_within_margin() {
    let pool = setup_db().await;
    let owner = account_key("expiry-within-margin");
    let ten_minutes_out =
        chrono::Utc::now().timestamp_millis() + 600_000;

    sqlx::query(
        "INSERT INTO auth_session (owner, auth_token, token_expiry) \
         VALUES (?, ?, ?)",
    )
    .bind(&owner)
    .bind("soon-token")
    .bind(ten_minutes_out)
    .execute(&pool)
    .await
    .unwrap();

    let row = sqlx::query(
        "SELECT token_expiry FROM auth_session WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_one(&pool)
    .await
    .unwrap();

    let expiry = row.get::<Option<i64>, _>("token_expiry");
    assert!(
        is_expiring(expiry),
        "Token 10 min out should be expiring with 1-hour margin"
    );
}

#[tokio::test]
async fn token_expiring_when_already_expired() {
    let pool = setup_db().await;
    let owner = account_key("expiry-past");
    let one_hour_ago =
        chrono::Utc::now().timestamp_millis() - MARGIN_MS;

    sqlx::query(
        "INSERT INTO auth_session (owner, auth_token, token_expiry) \
         VALUES (?, ?, ?)",
    )
    .bind(&owner)
    .bind("expired-token")
    .bind(one_hour_ago)
    .execute(&pool)
    .await
    .unwrap();

    let row = sqlx::query(
        "SELECT token_expiry FROM auth_session WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_one(&pool)
    .await
    .unwrap();

    let expiry = row.get::<Option<i64>, _>("token_expiry");
    assert!(
        is_expiring(expiry),
        "Token in the past should be expiring"
    );
}

#[tokio::test]
async fn token_expiring_when_no_expiry_set() {
    let pool = setup_db().await;
    let owner = account_key("expiry-null");

    sqlx::query(
        "INSERT INTO auth_session (owner, auth_token) VALUES (?, ?)",
    )
    .bind(&owner)
    .bind("no-expiry-token")
    .execute(&pool)
    .await
    .unwrap();

    let row = sqlx::query(
        "SELECT token_expiry FROM auth_session WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_one(&pool)
    .await
    .unwrap();

    let expiry = row.get::<Option<i64>, _>("token_expiry");
    assert!(expiry.is_none(), "token_expiry should be NULL");
    assert!(
        is_expiring(expiry),
        "NULL expiry should be treated as expiring"
    );
}

#[tokio::test]
async fn token_expiring_when_no_session_row() {
    let pool = setup_db().await;
    let owner = account_key("expiry-missing");

    let row = sqlx::query(
        "SELECT token_expiry FROM auth_session WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_optional(&pool)
    .await
    .unwrap();

    assert!(row.is_none(), "No session row should exist");
    // No row means no expiry — treat as expiring
    let expiry: Option<i64> = None;
    assert!(
        is_expiring(expiry),
        "Missing session should be treated as expiring"
    );
}

// ── S3 Credentials ───────────────────────────────────────────────────

#[tokio::test]
async fn save_and_get_s3_credentials() {
    let pool = setup_db().await;
    let owner = account_key("s3-creds-1");

    sqlx::query(
        "INSERT INTO objectstore_auth_scoped \
         (owner, master_access_key_id, master_secret) \
         VALUES (?, ?, ?)",
    )
    .bind(&owner)
    .bind("AKIAIOSFODNN7EXAMPLE")
    .bind("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
    .execute(&pool)
    .await
    .unwrap();

    let row = sqlx::query(
        "SELECT master_access_key_id, master_secret \
         FROM objectstore_auth_scoped WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        row.get::<Option<String>, _>("master_access_key_id").unwrap(),
        "AKIAIOSFODNN7EXAMPLE"
    );
    assert_eq!(
        row.get::<Option<String>, _>("master_secret").unwrap(),
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    );
}

#[tokio::test]
async fn upsert_token_preserves_s3_credentials() {
    let pool = setup_db().await;
    let owner = account_key("s3-upsert-1");

    // Insert S3 credentials and an initial token
    sqlx::query(
        "INSERT INTO objectstore_auth_scoped \
         (owner, api_token, master_access_key_id, master_secret) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(&owner)
    .bind("old-api-token")
    .bind("AKID_KEEP")
    .bind("SECRET_KEEP")
    .execute(&pool)
    .await
    .unwrap();

    // Upsert only the api_token, preserving S3 credentials
    sqlx::query(
        r#"
        INSERT INTO objectstore_auth_scoped (owner, api_token)
        VALUES (?, ?)
        ON CONFLICT(owner) DO UPDATE SET
            api_token = excluded.api_token,
            updated_at = datetime('now')
        "#,
    )
    .bind(&owner)
    .bind("new-api-token")
    .execute(&pool)
    .await
    .unwrap();

    let row = sqlx::query(
        "SELECT api_token, master_access_key_id, master_secret \
         FROM objectstore_auth_scoped WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        row.get::<Option<String>, _>("api_token").unwrap(),
        "new-api-token",
        "api_token should be updated"
    );
    assert_eq!(
        row.get::<Option<String>, _>("master_access_key_id").unwrap(),
        "AKID_KEEP",
        "S3 access key should be preserved after token upsert"
    );
    assert_eq!(
        row.get::<Option<String>, _>("master_secret").unwrap(),
        "SECRET_KEEP",
        "S3 secret should be preserved after token upsert"
    );

    // Verify only one row exists
    let (count,) = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM objectstore_auth_scoped WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
}
