//! Integration tests for wallet_store and auth_session CRUD operations.
//!
//! Uses an in-memory SQLite database — no Tauri AppHandle needed.
//! Tests the raw SQL logic that the Tauri commands wrap.

use sqlx::sqlite::SqlitePool;
use sqlx::Row;

async fn setup_db() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS wallet_store (
            owner TEXT PRIMARY KEY,
            encrypted_mnemonic TEXT NOT NULL,
            passcode_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
            user_id INTEGER,
            username TEXT,
            provider TEXT,
            substrate_address TEXT,
            logout_time_minutes INTEGER DEFAULT 1440,
            last_login_at TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(&pool)
    .await
    .unwrap();

    pool
}

fn account_key(account_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(account_id.as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest)[..8].to_string()
}

// ── Wallet Store Tests ─────────────────────────────────────────────────

#[tokio::test]
async fn test_save_and_get_wallet() {
    let pool = setup_db().await;
    let owner = account_key("test-account-1");

    // Save wallet
    sqlx::query(
        r#"
        INSERT INTO wallet_store (owner, encrypted_mnemonic, passcode_hash, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(owner) DO UPDATE SET
            encrypted_mnemonic = excluded.encrypted_mnemonic,
            passcode_hash = excluded.passcode_hash,
            updated_at = datetime('now')
        "#,
    )
    .bind(&owner)
    .bind("encrypted-data-abc")
    .bind("hash-xyz")
    .execute(&pool)
    .await
    .unwrap();

    // Get wallet
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT encrypted_mnemonic, passcode_hash FROM wallet_store WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_optional(&pool)
    .await
    .unwrap();

    let (mnemonic, hash) = row.unwrap();
    assert_eq!(mnemonic, "encrypted-data-abc");
    assert_eq!(hash, "hash-xyz");
}

#[tokio::test]
async fn test_upsert_wallet() {
    let pool = setup_db().await;
    let owner = account_key("test-account-2");

    // Initial insert
    sqlx::query(
        r#"
        INSERT INTO wallet_store (owner, encrypted_mnemonic, passcode_hash, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(owner) DO UPDATE SET
            encrypted_mnemonic = excluded.encrypted_mnemonic,
            passcode_hash = excluded.passcode_hash,
            updated_at = datetime('now')
        "#,
    )
    .bind(&owner)
    .bind("old-data")
    .bind("old-hash")
    .execute(&pool)
    .await
    .unwrap();

    // Upsert (update)
    sqlx::query(
        r#"
        INSERT INTO wallet_store (owner, encrypted_mnemonic, passcode_hash, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(owner) DO UPDATE SET
            encrypted_mnemonic = excluded.encrypted_mnemonic,
            passcode_hash = excluded.passcode_hash,
            updated_at = datetime('now')
        "#,
    )
    .bind(&owner)
    .bind("new-data")
    .bind("new-hash")
    .execute(&pool)
    .await
    .unwrap();

    let (mnemonic, hash) = sqlx::query_as::<_, (String, String)>(
        "SELECT encrypted_mnemonic, passcode_hash FROM wallet_store WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(mnemonic, "new-data");
    assert_eq!(hash, "new-hash");

    // Only one row
    let (count,) = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM wallet_store WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn test_has_wallet() {
    let pool = setup_db().await;
    let owner = account_key("test-account-3");

    // Should not exist
    let (count,) =
        sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM wallet_store WHERE owner = ?")
            .bind(&owner)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);

    // Insert
    sqlx::query(
        "INSERT INTO wallet_store (owner, encrypted_mnemonic, passcode_hash) VALUES (?, ?, ?)",
    )
    .bind(&owner)
    .bind("data")
    .bind("hash")
    .execute(&pool)
    .await
    .unwrap();

    // Should exist
    let (count,) =
        sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM wallet_store WHERE owner = ?")
            .bind(&owner)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(count > 0);
}

#[tokio::test]
async fn test_clear_wallet() {
    let pool = setup_db().await;
    let owner = account_key("test-account-4");

    sqlx::query(
        "INSERT INTO wallet_store (owner, encrypted_mnemonic, passcode_hash) VALUES (?, ?, ?)",
    )
    .bind(&owner)
    .bind("data")
    .bind("hash")
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query("DELETE FROM wallet_store WHERE owner = ?")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();

    let row = sqlx::query_as::<_, (String,)>(
        "SELECT encrypted_mnemonic FROM wallet_store WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_optional(&pool)
    .await
    .unwrap();

    assert!(row.is_none());
}

// ── Auth Session Tests ─────────────────────────────────────────────────

#[tokio::test]
async fn test_save_and_get_auth_session() {
    let pool = setup_db().await;
    let owner = account_key("test-account-5");
    let future_expiry: i64 = chrono::Utc::now().timestamp_millis() + 86_400_000; // +24h

    sqlx::query(
        r#"
        INSERT INTO auth_session (
            owner, auth_token, token_expiry, user_id, username,
            provider, substrate_address, logout_time_minutes,
            last_login_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(owner) DO UPDATE SET
            auth_token = excluded.auth_token,
            token_expiry = excluded.token_expiry,
            user_id = excluded.user_id,
            username = excluded.username,
            provider = excluded.provider,
            substrate_address = excluded.substrate_address,
            logout_time_minutes = COALESCE(excluded.logout_time_minutes, auth_session.logout_time_minutes),
            last_login_at = excluded.last_login_at,
            updated_at = datetime('now')
        "#,
    )
    .bind(&owner)
    .bind("test-token-123")
    .bind(future_expiry)
    .bind(42_i64)
    .bind("testuser")
    .bind("mnemonic")
    .bind("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY")
    .bind(1440_i64)
    .execute(&pool)
    .await
    .unwrap();

    let row = sqlx::query(
        r#"
        SELECT auth_token, token_expiry, user_id, username,
               provider, substrate_address, logout_time_minutes
        FROM auth_session WHERE owner = ?
        "#,
    )
    .bind(&owner)
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(row.get::<Option<String>, _>("auth_token").unwrap(), "test-token-123");
    assert_eq!(row.get::<Option<i64>, _>("token_expiry").unwrap(), future_expiry);
    assert_eq!(row.get::<Option<i64>, _>("user_id").unwrap(), 42);
    assert_eq!(row.get::<Option<String>, _>("username").unwrap(), "testuser");
    assert_eq!(row.get::<Option<String>, _>("provider").unwrap(), "mnemonic");
    assert_eq!(
        row.get::<Option<String>, _>("substrate_address").unwrap(),
        "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
    );
    assert_eq!(row.get::<Option<i64>, _>("logout_time_minutes").unwrap(), 1440);
}

#[tokio::test]
async fn test_get_auth_token_valid() {
    let pool = setup_db().await;
    let owner = account_key("test-account-6");
    let future_expiry: i64 = chrono::Utc::now().timestamp_millis() + 86_400_000;

    sqlx::query(
        "INSERT INTO auth_session (owner, auth_token, token_expiry, user_id, username) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&owner)
    .bind("valid-token")
    .bind(future_expiry)
    .bind(99_i64)
    .bind("alice")
    .execute(&pool)
    .await
    .unwrap();

    let row = sqlx::query_as::<_, (Option<String>, Option<i64>, Option<i64>, Option<String>)>(
        "SELECT auth_token, token_expiry, user_id, username FROM auth_session WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_optional(&pool)
    .await
    .unwrap();

    let (token, expiry, user_id, username) = row.unwrap();
    assert_eq!(token.unwrap(), "valid-token");
    let now_ms = chrono::Utc::now().timestamp_millis();
    assert!(expiry.unwrap() > now_ms, "Token should not be expired");
    assert_eq!(user_id.unwrap(), 99);
    assert_eq!(username.unwrap(), "alice");
}

#[tokio::test]
async fn test_get_auth_token_expired() {
    let pool = setup_db().await;
    let owner = account_key("test-account-7");
    let past_expiry: i64 = chrono::Utc::now().timestamp_millis() - 1000; // 1 second ago

    sqlx::query(
        "INSERT INTO auth_session (owner, auth_token, token_expiry) VALUES (?, ?, ?)",
    )
    .bind(&owner)
    .bind("expired-token")
    .bind(past_expiry)
    .execute(&pool)
    .await
    .unwrap();

    let row = sqlx::query_as::<_, (Option<String>, Option<i64>)>(
        "SELECT auth_token, token_expiry FROM auth_session WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_optional(&pool)
    .await
    .unwrap();

    let (token, expiry) = row.unwrap();
    assert!(token.is_some(), "Token should exist in DB");
    let now_ms = chrono::Utc::now().timestamp_millis();
    assert!(
        expiry.unwrap() < now_ms,
        "Token expiry should be in the past"
    );
}

#[tokio::test]
async fn test_clear_auth_session_preserves_logout_minutes() {
    let pool = setup_db().await;
    let owner = account_key("test-account-8");

    // Create session with custom logout time
    sqlx::query(
        r#"
        INSERT INTO auth_session (
            owner, auth_token, token_expiry, user_id, username,
            provider, substrate_address, logout_time_minutes,
            last_login_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        "#,
    )
    .bind(&owner)
    .bind("token")
    .bind(9999999999_i64)
    .bind(1_i64)
    .bind("bob")
    .bind("mnemonic")
    .bind("5GrwvaEF...")
    .bind(60_i64) // 1 hour
    .execute(&pool)
    .await
    .unwrap();

    // Clear session (simulates logout)
    sqlx::query(
        r#"
        UPDATE auth_session SET
            auth_token = NULL,
            token_expiry = NULL,
            user_id = NULL,
            username = NULL,
            provider = NULL,
            substrate_address = NULL,
            last_login_at = NULL,
            updated_at = datetime('now')
        WHERE owner = ?
        "#,
    )
    .bind(&owner)
    .execute(&pool)
    .await
    .unwrap();

    // Verify logout_time_minutes is preserved
    let row = sqlx::query(
        "SELECT auth_token, logout_time_minutes FROM auth_session WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_one(&pool)
    .await
    .unwrap();

    assert!(row.get::<Option<String>, _>("auth_token").is_none());
    assert_eq!(row.get::<Option<i64>, _>("logout_time_minutes").unwrap(), 60);
}

#[tokio::test]
async fn test_multi_account_isolation() {
    let pool = setup_db().await;
    let owner_a = account_key("account-alice");
    let owner_b = account_key("account-bob");

    // Save wallet for Alice
    sqlx::query(
        "INSERT INTO wallet_store (owner, encrypted_mnemonic, passcode_hash) VALUES (?, ?, ?)",
    )
    .bind(&owner_a)
    .bind("alice-mnemonic")
    .bind("alice-hash")
    .execute(&pool)
    .await
    .unwrap();

    // Save wallet for Bob
    sqlx::query(
        "INSERT INTO wallet_store (owner, encrypted_mnemonic, passcode_hash) VALUES (?, ?, ?)",
    )
    .bind(&owner_b)
    .bind("bob-mnemonic")
    .bind("bob-hash")
    .execute(&pool)
    .await
    .unwrap();

    // Verify isolation
    let alice = sqlx::query_as::<_, (String,)>(
        "SELECT encrypted_mnemonic FROM wallet_store WHERE owner = ?",
    )
    .bind(&owner_a)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(alice.0, "alice-mnemonic");

    let bob = sqlx::query_as::<_, (String,)>(
        "SELECT encrypted_mnemonic FROM wallet_store WHERE owner = ?",
    )
    .bind(&owner_b)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(bob.0, "bob-mnemonic");

    // Delete Alice doesn't affect Bob
    sqlx::query("DELETE FROM wallet_store WHERE owner = ?")
        .bind(&owner_a)
        .execute(&pool)
        .await
        .unwrap();

    let bob_still = sqlx::query_as::<_, (String,)>(
        "SELECT encrypted_mnemonic FROM wallet_store WHERE owner = ?",
    )
    .bind(&owner_b)
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(bob_still.is_some());
}

#[tokio::test]
async fn test_session_upsert_preserves_logout_minutes_when_null() {
    let pool = setup_db().await;
    let owner = account_key("test-account-9");

    // First insert with explicit logout_time_minutes
    sqlx::query(
        r#"
        INSERT INTO auth_session (
            owner, auth_token, logout_time_minutes, updated_at
        )
        VALUES (?, ?, ?, datetime('now'))
        "#,
    )
    .bind(&owner)
    .bind("token-1")
    .bind(60_i64)
    .execute(&pool)
    .await
    .unwrap();

    // Upsert with NULL logout_time_minutes — should preserve 60
    sqlx::query(
        r#"
        INSERT INTO auth_session (
            owner, auth_token, token_expiry, user_id, username,
            provider, substrate_address, logout_time_minutes,
            last_login_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(owner) DO UPDATE SET
            auth_token = excluded.auth_token,
            token_expiry = excluded.token_expiry,
            user_id = excluded.user_id,
            username = excluded.username,
            provider = excluded.provider,
            substrate_address = excluded.substrate_address,
            logout_time_minutes = COALESCE(excluded.logout_time_minutes, auth_session.logout_time_minutes),
            last_login_at = excluded.last_login_at,
            updated_at = datetime('now')
        "#,
    )
    .bind(&owner)
    .bind("token-2")
    .bind(None::<i64>) // token_expiry
    .bind(None::<i64>) // user_id
    .bind(None::<String>) // username
    .bind(None::<String>) // provider
    .bind(None::<String>) // substrate_address
    .bind(None::<i64>) // logout_time_minutes = NULL → COALESCE preserves existing
    .execute(&pool)
    .await
    .unwrap();

    let row = sqlx::query("SELECT auth_token, logout_time_minutes FROM auth_session WHERE owner = ?")
        .bind(&owner)
        .fetch_one(&pool)
        .await
        .unwrap();

    assert_eq!(row.get::<Option<String>, _>("auth_token").unwrap(), "token-2");
    assert_eq!(
        row.get::<Option<i64>, _>("logout_time_minutes").unwrap(),
        60,
        "logout_time_minutes should be preserved when excluded value is NULL"
    );
}
