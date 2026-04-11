//! Sole writer for the `auth_session` table.
//!
//! All other modules MUST go through these helpers — never raw SQL —
//! so that schema knowledge and ON CONFLICT semantics live in one
//! place. The `upsert` helper preserves `logout_time_minutes` via
//! `COALESCE` when the caller passes `None`, so a token refresh from
//! the sync engine doesn't reset the user's logout-timeout preference.

use crate::auth::account_key::account_key;
use crate::error::{AppError, Result};
use sqlx::sqlite::SqlitePool;

/// Parameters for an `auth_session` upsert.
///
/// `logout_time_minutes` is `Option<i64>`: pass `Some(_)` to set/overwrite,
/// pass `None` to preserve the existing value via SQL `COALESCE`.
#[derive(Debug)]
pub struct UpsertSession<'a> {
    pub substrate_address: &'a str,
    pub token: &'a str,
    pub token_expiry_ms: i64,
    pub user_id: Option<i64>,
    pub username: &'a str,
    pub provider: &'a str,
    pub logout_time_minutes: Option<i64>,
}

/// Full row payload returned by [`get_by_account`] / [`get_latest`].
#[derive(Debug, Clone)]
pub struct AuthSessionRow {
    pub auth_token: Option<String>,
    pub token_expiry: Option<i64>,
    pub user_id: Option<i64>,
    pub username: Option<String>,
    pub provider: Option<String>,
    pub substrate_address: Option<String>,
    pub logout_time_minutes: Option<i64>,
    pub last_login_at: Option<String>,
}

/// Upsert a session row, preserving `logout_time_minutes` when not provided.
pub async fn upsert(pool: &SqlitePool, params: UpsertSession<'_>) -> Result<()> {
    let owner = account_key(params.substrate_address);

    sqlx::query(
        r"
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
        ",
    )
    .bind(&owner)
    .bind(params.token)
    .bind(params.token_expiry_ms)
    .bind(params.user_id)
    .bind(params.username)
    .bind(params.provider)
    .bind(params.substrate_address)
    .bind(params.logout_time_minutes)
    .execute(pool)
    .await
    .map_err(|e| AppError::Other(format!("Failed to upsert auth_session: {e}")))?;

    Ok(())
}

/// Null out the credential fields for an account, preserving the row
/// (and `logout_time_minutes`) so the user's logout preference survives.
pub async fn clear(pool: &SqlitePool, account_id: &str) -> Result<()> {
    let owner = account_key(account_id);

    sqlx::query(
        r"
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
        ",
    )
    .bind(&owner)
    .execute(pool)
    .await?;

    Ok(())
}

/// Update only the `logout_time_minutes` preference column.
pub async fn update_logout_time(pool: &SqlitePool, account_id: &str, minutes: i64) -> Result<()> {
    let owner = account_key(account_id);

    sqlx::query(
        r"
        UPDATE auth_session SET
            logout_time_minutes = ?,
            updated_at = datetime('now')
        WHERE owner = ?
        ",
    )
    .bind(minutes)
    .bind(&owner)
    .execute(pool)
    .await?;

    Ok(())
}

/// Fetch the full row for a specific account, if any.
pub async fn get_by_account(pool: &SqlitePool, account_id: &str) -> Result<Option<AuthSessionRow>> {
    let owner = account_key(account_id);

    let row = sqlx::query_as::<
        _,
        (
            Option<String>,
            Option<i64>,
            Option<i64>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<String>,
        ),
    >(
        r"
        SELECT auth_token, token_expiry, user_id, username,
               provider, substrate_address, logout_time_minutes, last_login_at
        FROM auth_session
        WHERE owner = ?
        ",
    )
    .bind(&owner)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(
        |(auth_token, token_expiry, user_id, username, provider, substrate_address, logout_time_minutes, last_login_at)| AuthSessionRow {
            auth_token,
            token_expiry,
            user_id,
            username,
            provider,
            substrate_address,
            logout_time_minutes,
            last_login_at,
        },
    ))
}

/// Fetch the most recently updated session row across all accounts.
/// Used by the boot path to find the last logged-in user.
pub async fn get_latest(pool: &SqlitePool) -> Result<Option<AuthSessionRow>> {
    let row = sqlx::query_as::<
        _,
        (
            Option<String>,
            Option<i64>,
            Option<i64>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<String>,
        ),
    >(
        r"
        SELECT auth_token, token_expiry, user_id, username,
               provider, substrate_address, logout_time_minutes, last_login_at
        FROM auth_session
        ORDER BY updated_at DESC
        LIMIT 1
        ",
    )
    .fetch_optional(pool)
    .await?;

    Ok(row.map(
        |(auth_token, token_expiry, user_id, username, provider, substrate_address, logout_time_minutes, last_login_at)| AuthSessionRow {
            auth_token,
            token_expiry,
            user_id,
            username,
            provider,
            substrate_address,
            logout_time_minutes,
            last_login_at,
        },
    ))
}

/// Token validity payload returned by [`get_token_and_expiry`].
///
/// The outer `Option` (the function return type) signals "row exists".
/// The fields here signal which columns have non-NULL values.
#[derive(Debug, Clone)]
pub struct TokenStatus {
    pub token: Option<String>,
    pub expiry_ms: Option<i64>,
}

/// Read just the token + expiry for fast validity checks.
pub async fn get_token_and_expiry(pool: &SqlitePool, account_id: &str) -> Result<Option<TokenStatus>> {
    let owner = account_key(account_id);
    let row = sqlx::query_as::<_, (Option<String>, Option<i64>)>("SELECT auth_token, token_expiry FROM auth_session WHERE owner = ?")
        .bind(&owner)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(token, expiry_ms)| TokenStatus { token, expiry_ms }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create an in-memory pool with the auth_session schema. Mirrors the
    /// production CREATE in `utils/schema.rs::ensure_table_schema` so the
    /// repo functions see the columns they expect.
    async fn setup_db() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
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

    const ALICE: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const BOB: &str = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

    #[tokio::test]
    async fn upsert_writes_all_fields() {
        let pool = setup_db().await;
        let future_expiry: i64 = chrono::Utc::now().timestamp_millis() + 86_400_000;

        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "test-token-123",
                token_expiry_ms: future_expiry,
                user_id: Some(42),
                username: "testuser",
                provider: "mnemonic",
                logout_time_minutes: Some(1440),
            },
        )
        .await
        .unwrap();

        let row = get_by_account(&pool, ALICE).await.unwrap().unwrap();
        assert_eq!(row.auth_token.as_deref(), Some("test-token-123"));
        assert_eq!(row.token_expiry, Some(future_expiry));
        assert_eq!(row.user_id, Some(42));
        assert_eq!(row.username.as_deref(), Some("testuser"));
        assert_eq!(row.provider.as_deref(), Some("mnemonic"));
        assert_eq!(row.substrate_address.as_deref(), Some(ALICE));
        assert_eq!(row.logout_time_minutes, Some(1440));
    }

    #[tokio::test]
    async fn upsert_preserves_logout_minutes_when_none_passed() {
        // Critical invariant: a token-refresh upsert from the sync engine
        // (which doesn't know the user's preference) must NOT clobber the
        // logout_time_minutes the user previously set.
        let pool = setup_db().await;

        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "first-token",
                token_expiry_ms: 1,
                user_id: None,
                username: "u",
                provider: "mnemonic",
                logout_time_minutes: Some(60),
            },
        )
        .await
        .unwrap();

        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "refreshed-token",
                token_expiry_ms: 2,
                user_id: None,
                username: "u",
                provider: "mnemonic",
                logout_time_minutes: None, // refresh path: don't touch the preference
            },
        )
        .await
        .unwrap();

        let row = get_by_account(&pool, ALICE).await.unwrap().unwrap();
        assert_eq!(row.logout_time_minutes, Some(60), "COALESCE must preserve preference");
        assert_eq!(row.auth_token.as_deref(), Some("refreshed-token"), "token should be updated");
    }

    #[tokio::test]
    async fn upsert_overwrites_logout_minutes_when_some_passed() {
        let pool = setup_db().await;

        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "t",
                token_expiry_ms: 1,
                user_id: None,
                username: "u",
                provider: "mnemonic",
                logout_time_minutes: Some(60),
            },
        )
        .await
        .unwrap();

        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "t",
                token_expiry_ms: 1,
                user_id: None,
                username: "u",
                provider: "mnemonic",
                logout_time_minutes: Some(1440),
            },
        )
        .await
        .unwrap();

        let row = get_by_account(&pool, ALICE).await.unwrap().unwrap();
        assert_eq!(row.logout_time_minutes, Some(1440));
    }

    #[tokio::test]
    async fn clear_nulls_credentials_but_preserves_logout_minutes() {
        let pool = setup_db().await;

        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "token",
                token_expiry_ms: 9_999_999_999,
                user_id: Some(1),
                username: "bob",
                provider: "mnemonic",
                logout_time_minutes: Some(60),
            },
        )
        .await
        .unwrap();

        clear(&pool, ALICE).await.unwrap();

        let row = get_by_account(&pool, ALICE).await.unwrap().unwrap();
        assert!(row.auth_token.is_none(), "auth_token must be cleared");
        assert!(row.token_expiry.is_none());
        assert!(row.username.is_none());
        assert!(row.provider.is_none());
        assert!(row.substrate_address.is_none());
        assert_eq!(row.logout_time_minutes, Some(60), "logout preference must survive clear");
    }

    #[tokio::test]
    async fn get_token_and_expiry_returns_token_when_present() {
        let pool = setup_db().await;
        let future_expiry: i64 = chrono::Utc::now().timestamp_millis() + 86_400_000;

        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "valid-token",
                token_expiry_ms: future_expiry,
                user_id: Some(99),
                username: "alice",
                provider: "mnemonic",
                logout_time_minutes: Some(1440),
            },
        )
        .await
        .unwrap();

        let row = get_token_and_expiry(&pool, ALICE).await.unwrap().unwrap();
        assert_eq!(row.token.as_deref(), Some("valid-token"));
        assert_eq!(row.expiry_ms, Some(future_expiry));
    }

    #[tokio::test]
    async fn update_logout_time_only_touches_one_column() {
        let pool = setup_db().await;

        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "token",
                token_expiry_ms: 1,
                user_id: Some(1),
                username: "bob",
                provider: "mnemonic",
                logout_time_minutes: Some(60),
            },
        )
        .await
        .unwrap();

        update_logout_time(&pool, ALICE, -1).await.unwrap();

        let row = get_by_account(&pool, ALICE).await.unwrap().unwrap();
        assert_eq!(row.logout_time_minutes, Some(-1));
        assert_eq!(row.auth_token.as_deref(), Some("token"), "credentials must not be touched");
        assert_eq!(row.username.as_deref(), Some("bob"));
    }

    #[tokio::test]
    async fn multi_account_isolation() {
        let pool = setup_db().await;

        upsert(
            &pool,
            UpsertSession {
                substrate_address: ALICE,
                token: "alice-token",
                token_expiry_ms: 1,
                user_id: Some(1),
                username: "alice",
                provider: "mnemonic",
                logout_time_minutes: Some(60),
            },
        )
        .await
        .unwrap();

        upsert(
            &pool,
            UpsertSession {
                substrate_address: BOB,
                token: "bob-token",
                token_expiry_ms: 2,
                user_id: Some(2),
                username: "bob",
                provider: "oauth",
                logout_time_minutes: Some(1440),
            },
        )
        .await
        .unwrap();

        assert_eq!(
            get_by_account(&pool, ALICE).await.unwrap().unwrap().auth_token.as_deref(),
            Some("alice-token")
        );
        assert_eq!(
            get_by_account(&pool, BOB).await.unwrap().unwrap().auth_token.as_deref(),
            Some("bob-token")
        );

        // Clearing Alice doesn't affect Bob
        clear(&pool, ALICE).await.unwrap();
        assert_eq!(
            get_by_account(&pool, BOB).await.unwrap().unwrap().auth_token.as_deref(),
            Some("bob-token")
        );
    }
}
