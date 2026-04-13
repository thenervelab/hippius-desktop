//! API token persistence.
//!
//! The Hippius API auth token is stored in the OS keychain whenever the
//! platform supports it (macOS Keychain, Windows Credential Manager,
//! Linux Secret Service). The legacy `objectstore_auth_scoped` table
//! remains as a fallback for Linux installations without Secret Service
//! and is auto-migrated to the keychain on first read when the OS store
//! is available. See [`crate::auth::token_keychain`] for the backend.

use std::sync::atomic::{AtomicBool, Ordering};

use sqlx::Row;
use sqlx::sqlite::SqlitePool;
use tracing::{debug, warn};

use crate::auth::token_keychain::{self, TokenKeychainResult};

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
/// Writes to the OS keychain first. On success, scrubs the plaintext
/// `objectstore_auth_scoped.temp_auth_key` column to NULL so the SQLite
/// database on disk never holds the current token. On keychain failure
/// (e.g. Linux without Secret Service, macOS Keychain locked), falls
/// back to plaintext DB storage so the app stays functional — the row
/// is tagged as such in a warn log so users on locked-down Linux boxes
/// can see what's happening.
pub async fn save_api_token(pool: &SqlitePool, account_id: &str, token: &str) -> Result<(), String> {
    let keychain_ok = match token_keychain::store_token(account_id, token) {
        Ok(()) => true,
        Err(e) => {
            warn!(
                error = %e,
                "OS keychain unavailable for token storage — falling back to SQLite plaintext column"
            );
            false
        }
    };

    // Always upsert the row so `updated_at` reflects the latest auth,
    // but only write the bearer token into `temp_auth_key` when the
    // keychain is unavailable. When the keychain path succeeds we
    // explicitly NULL the column so any previously-stored plaintext
    // token is scrubbed from disk as part of the same write.
    if keychain_ok {
        sqlx::query(
            r"
            INSERT INTO objectstore_auth_scoped (owner, temp_auth_key, updated_at)
            VALUES (?, NULL, CURRENT_TIMESTAMP)
            ON CONFLICT(owner) DO UPDATE SET temp_auth_key = NULL, updated_at = CURRENT_TIMESTAMP
            ",
        )
        .bind(account_id)
        .execute(pool)
        .await
        .map_err(|e| format!("DB error clearing plaintext API token: {e}"))?;
    } else {
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
    }
    Ok(())
}

/// Retrieve the API auth token for this account.
///
/// Returns the bearer token string or `None` if no token is stored.
///
/// Resolution order: OS keychain → `objectstore_auth_scoped` (plaintext
/// fallback or pre-update data) → legacy `objectstore_auth` → `auth_session`.
/// On a keychain miss with a plaintext fallback hit, the token is
/// transparently migrated into the keychain and the plaintext column is
/// scrubbed (a one-time upgrade step for every pre-keychain install).
pub async fn get_api_token(pool: &SqlitePool, account_id: &str) -> Result<Option<String>, String> {
    // 1. Prefer the OS keychain. This is the authoritative store on
    //    every platform where it is available.
    match token_keychain::load_token(account_id) {
        TokenKeychainResult::Found(token) if !token.is_empty() => return Ok(Some(token)),
        TokenKeychainResult::Found(_) | TokenKeychainResult::NotFound => {
            // Empty strings should never make it into the keychain, but
            // if they somehow did, treat them as a miss and fall through
            // to the DB path so we can recover a valid plaintext copy.
        }
        TokenKeychainResult::Unavailable(reason) => {
            debug!(reason = %reason, "OS keychain unavailable; reading token from SQLite fallback");
        }
    }

    // 2. Fall back to the plaintext scoped record.
    let scoped = sqlx::query("SELECT temp_auth_key FROM objectstore_auth_scoped WHERE owner = ?")
        .bind(account_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error fetching API token: {e}"))?;

    if let Some(row) = scoped
        && let Some(token) = row.get::<Option<String>, _>("temp_auth_key")
        && !token.is_empty()
    {
        // Opportunistic upgrade: if the keychain is available, move the
        // token out of the plaintext column before returning. Failures
        // are non-fatal — we still return the token so the caller's
        // request succeeds. The next call will retry the upgrade.
        if let Err(e) = token_keychain::store_token(account_id, &token) {
            debug!(error = %e, "keychain upgrade skipped; leaving plaintext column intact");
        } else if let Err(e) = sqlx::query(
            "UPDATE objectstore_auth_scoped SET temp_auth_key = NULL, updated_at = CURRENT_TIMESTAMP WHERE owner = ?",
        )
        .bind(account_id)
        .execute(pool)
        .await
        {
            warn!(error = %e, "Failed to scrub plaintext token after keychain upgrade");
        } else {
            debug!("Migrated API token from plaintext column to OS keychain");
        }
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
