//! API token persistence.
//!
//! The Hippius API auth token is stored in the `objectstore_auth_scoped` table
//! (legacy name — predates the HCFS migration). The `temp_auth_key` column
//! holds the bearer token used for API calls, sync auth, and VPN auth.

use std::sync::atomic::{AtomicBool, Ordering};

use sqlx::Row;
use sqlx::sqlite::SqlitePool;
use tracing::warn;

/// Four hours in seconds — tokens expiring sooner than this are proactively refreshed.
/// A wide margin compensates for server-side token revocation that may occur
/// before the stored expiry time (e.g., security rotations, billing events).
pub const TOKEN_REFRESH_MARGIN_SECS: i64 = 14400;

const AUTH_ROW_ID: i64 = 1;

/// Once set, skips the legacy `objectstore_auth` and `auth_session` fallback
/// queries in [`get_api_token`]. The migration only needs to run once per
/// process lifetime — after that the scoped table is authoritative.
static LEGACY_TOKEN_MIGRATED: AtomicBool = AtomicBool::new(false);

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

    // After the first full pass through the legacy fallback paths (whether or
    // not data was found), the scoped table is authoritative — skip the two
    // extra SQLite round-trips on every subsequent call.
    if LEGACY_TOKEN_MIGRATED.load(Ordering::Relaxed) {
        return Ok(None);
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
    // without populating objectstore_auth_scoped). Goes through the
    // repo so schema knowledge stays in one place.
    let token_row = crate::auth::auth_session_repo::get_token_and_expiry(pool, account_id)
        .await
        .map_err(|e| format!("DB error fetching auth_session token: {e}"))?;
    if let Some(crate::auth::auth_session_repo::TokenStatus { token: Some(token), .. }) = token_row {
        if let Err(e) = save_api_token(pool, account_id, &token).await {
            warn!("Failed to persist session token to scoped table: {e}");
        }
        return Ok(Some(token));
    }

    // We have now completed one full pass through both legacy fallback paths.
    // Mark as migrated so future calls skip straight to Ok(None) after stage 1.
    LEGACY_TOKEN_MIGRATED.store(true, Ordering::Relaxed);

    Ok(None)
}

/// Check if the stored auth token is expired or will expire within `margin_secs`.
///
/// Returns `true` if the token should be refreshed (expired, expiring soon, or no session).
/// Used by the sync loop to proactively refresh tokens before they cause 401 errors.
pub async fn is_token_expiring(pool: &SqlitePool, account_id: &str, margin_secs: i64) -> bool {
    match crate::auth::auth_session_repo::get_token_and_expiry(pool, account_id).await {
        Ok(Some(crate::auth::auth_session_repo::TokenStatus { expiry_ms: Some(expiry), .. })) => {
            let now = chrono::Utc::now().timestamp_millis();
            expiry - now < margin_secs * 1000
        }
        // No row, no expiry, or DB error → assume we need to refresh.
        _ => true,
    }
}
