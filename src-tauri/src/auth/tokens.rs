//! API token persistence.
//!
//! The Hippius API auth token is stored in the `objectstore_auth_scoped` table
//! (legacy name — predates the HCFS migration). The `temp_auth_key` column
//! holds the bearer token used for API calls, sync auth, and VPN auth.

use sqlx::Row;
use sqlx::sqlite::SqlitePool;
use tracing::warn;

/// Four hours in seconds — tokens expiring sooner than this are proactively refreshed.
/// A wide margin compensates for server-side token revocation that may occur
/// before the stored expiry time (e.g., security rotations, billing events).
pub const TOKEN_REFRESH_MARGIN_SECS: i64 = 14400;

const AUTH_ROW_ID: i64 = 1;

// ── API Token (used everywhere) ─────────────────────────────────────────

/// Persist the API auth token for this account.
///
/// Used after login (mnemonic or OAuth) so that the sync engine, Nebula VPN,
/// and other subsystems can retrieve it later via [`get_api_token`].
pub async fn save_api_token(pool: &SqlitePool, account_id: &str, token: &str) -> Result<(), String> {
    sqlx::query(
        r"
        INSERT INTO objectstore_auth_scoped (owner, temp_auth_key, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(owner) DO UPDATE SET temp_auth_key = excluded.temp_auth_key, updated_at = CURRENT_TIMESTAMP
        ",
    )
    .bind(account_id)
    .bind(token)
    .execute(pool)
    .await
    .map_err(|e| format!("DB error saving API token: {e}"))?;
    Ok(())
}

/// Retrieve the API auth token for this account.
///
/// Returns the bearer token string or `None` if no token is stored.
/// Falls back to the legacy `objectstore_auth` table (auto-migrates),
/// then to the `auth_session` table (auto-migrates).
pub async fn get_api_token(pool: &SqlitePool, account_id: &str) -> Result<Option<String>, String> {
    // Prefer scoped record
    let scoped = sqlx::query("SELECT temp_auth_key FROM objectstore_auth_scoped WHERE owner = ?")
        .bind(account_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error fetching API token: {e}"))?;

    if let Some(row) = scoped
        && let Some(token) = row.get::<Option<String>, _>("temp_auth_key")
    {
        return Ok(Some(token));
    }

    // Legacy single-row fallback — auto-migrate
    let legacy = sqlx::query("SELECT temp_auth_key FROM objectstore_auth WHERE id = ?")
        .bind(AUTH_ROW_ID)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error fetching API token: {e}"))?;
    if let Some(row) = legacy
        && let Some(token) = row.get::<Option<String>, _>("temp_auth_key")
    {
        if let Err(e) = save_api_token(pool, account_id, &token).await {
            warn!("Failed to migrate legacy API token: {e}");
        }
        if let Err(e) = sqlx::query("DELETE FROM objectstore_auth WHERE id = ?")
            .bind(AUTH_ROW_ID)
            .execute(pool)
            .await
        {
            warn!("Failed to delete legacy API token row: {e}");
        }
        return Ok(Some(token));
    }

    // Fall back to auth_session table (session restored from DB
    // without populating objectstore_auth_scoped)
    let owner = crate::auth::account_key::account_key(account_id);
    let session = sqlx::query("SELECT auth_token FROM auth_session WHERE owner = ? AND auth_token IS NOT NULL")
        .bind(&owner)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error fetching auth_session token: {e}"))?;
    if let Some(row) = session
        && let Some(token) = row.get::<Option<String>, _>("auth_token")
    {
        if let Err(e) = save_api_token(pool, account_id, &token).await {
            warn!("Failed to persist session token to scoped table: {e}");
        }
        return Ok(Some(token));
    }

    Ok(None)
}

/// Check if the stored auth token is expired or will expire within `margin_secs`.
///
/// Returns `true` if the token should be refreshed (expired, expiring soon, or no session).
/// Used by the sync loop to proactively refresh tokens before they cause 401 errors.
pub async fn is_token_expiring(pool: &SqlitePool, account_id: &str, margin_secs: i64) -> bool {
    let owner = crate::auth::account_key::account_key(account_id);
    let row = sqlx::query("SELECT token_expiry FROM auth_session WHERE owner = ?")
        .bind(&owner)
        .fetch_optional(pool)
        .await;

    match row {
        Ok(Some(r)) => {
            let expiry: Option<i64> = r.get("token_expiry");
            match expiry {
                Some(exp) => {
                    let now = chrono::Utc::now().timestamp_millis();
                    exp - now < margin_secs * 1000
                }
                None => true,
            }
        }
        _ => true,
    }
}
