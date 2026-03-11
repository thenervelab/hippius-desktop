//! API token persistence.
//!
//! The Hippius API auth token is stored in the `objectstore_auth_scoped` table
//! (legacy name — predates the HCFS migration). The `temp_auth_key` column
//! holds the bearer token used for API calls, sync auth, and VPN auth.
//!
//! S3 master token functions are kept solely for the old-S3-to-HCFS migration
//! path (`commands/migration.rs`).

use crate::DB_POOL;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use sqlx::Row;

/// One hour in seconds — tokens expiring sooner than this are proactively refreshed.
pub const TOKEN_REFRESH_MARGIN_SECS: i64 = 3600;

const AUTH_ROW_ID: i64 = 1;
const DEFAULT_API_BASE: &str = "https://api.hippius.com/api";

// ── API Token (used everywhere) ─────────────────────────────────────────

/// Persist the API auth token for this account.
///
/// Used after login (mnemonic or OAuth) so that the sync engine, Nebula VPN,
/// and other subsystems can retrieve it later via [`get_api_token`].
pub async fn save_api_token(account_id: &str, token: &str) -> Result<(), String> {
    if let Some(pool) = DB_POOL.get() {
        sqlx::query(
            r#"
            INSERT INTO objectstore_auth_scoped (owner, temp_auth_key, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(owner) DO UPDATE SET temp_auth_key = excluded.temp_auth_key, updated_at = CURRENT_TIMESTAMP
            "#,
        )
        .bind(account_id)
        .bind(token)
        .execute(pool)
        .await
        .map_err(|e| format!("DB error saving API token: {}", e))?;
        Ok(())
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

/// Retrieve the API auth token for this account.
///
/// Returns the bearer token string or `None` if no token is stored.
/// Falls back to the legacy `objectstore_auth` table and auto-migrates.
pub async fn get_api_token(account_id: &str) -> Result<Option<String>, String> {
    if let Some(pool) = DB_POOL.get() {
        // Prefer scoped record
        let scoped =
            sqlx::query("SELECT temp_auth_key FROM objectstore_auth_scoped WHERE owner = ?")
                .bind(account_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("DB error fetching API token: {}", e))?;

        if let Some(row) = scoped {
            return Ok(row.get::<Option<String>, _>("temp_auth_key"));
        }

        // Legacy single-row fallback — auto-migrate
        let legacy = sqlx::query("SELECT temp_auth_key FROM objectstore_auth WHERE id = ?")
            .bind(AUTH_ROW_ID)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("DB error fetching API token: {}", e))?;
        if let Some(row) = legacy {
            if let Some(token) = row.get::<Option<String>, _>("temp_auth_key") {
                let _ = save_api_token(account_id, &token).await;
                let _ = sqlx::query("DELETE FROM objectstore_auth WHERE id = ?")
                    .bind(AUTH_ROW_ID)
                    .execute(pool)
                    .await;
                return Ok(Some(token));
            }
        }
        Ok(None)
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

/// Check if the stored auth token is expired or will expire within `margin_secs`.
///
/// Returns `true` if the token should be refreshed (expired, expiring soon, or no session).
/// Used by the sync loop to proactively refresh tokens before they cause 401 errors.
pub async fn is_token_expiring(account_id: &str, margin_secs: i64) -> bool {
    let pool = match DB_POOL.get() {
        Some(p) => p,
        None => return true,
    };
    let owner = crate::utils::account_key::account_key(account_id);
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

// ── S3 Master Token (migration only) ────────────────────────────────────
//
// These functions exist solely for `commands/migration.rs` which downloads
// files from the old S3 storage to migrate them into HCFS. They will be
// removed once the migration path is no longer needed.

/// Save S3 credentials for this account (migration use only).
pub async fn save_s3_credentials(
    account_id: &str,
    access_key_id: &str,
    secret: &str,
) -> Result<(), String> {
    if let Some(pool) = DB_POOL.get() {
        sqlx::query(
            r#"
            INSERT INTO objectstore_auth_scoped (owner, master_access_key_id, master_secret, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(owner) DO UPDATE SET
                master_access_key_id = excluded.master_access_key_id,
                master_secret = excluded.master_secret,
                updated_at = CURRENT_TIMESTAMP
            "#,
        )
        .bind(account_id)
        .bind(access_key_id)
        .bind(secret)
        .execute(pool)
        .await
        .map_err(|e| format!("DB error saving S3 credentials: {}", e))?;
        Ok(())
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

/// Retrieve S3 credentials for this account (migration use only).
pub async fn get_s3_credentials(account_id: &str) -> Result<Option<(String, String)>, String> {
    if let Some(pool) = DB_POOL.get() {
        let scoped = sqlx::query(
            "SELECT master_access_key_id, master_secret FROM objectstore_auth_scoped WHERE owner = ?",
        )
        .bind(account_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error fetching S3 credentials: {}", e))?;

        if let Some(r) = scoped {
            let access: Option<String> = r.get("master_access_key_id");
            let secret: Option<String> = r.get("master_secret");
            return Ok(match (access, secret) {
                (Some(a), Some(s)) if !a.is_empty() && !s.is_empty() => Some((a, s)),
                _ => None,
            });
        }

        // Legacy single-row fallback
        let row = sqlx::query(
            "SELECT master_access_key_id, master_secret FROM objectstore_auth WHERE id = ?",
        )
        .bind(AUTH_ROW_ID)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error fetching S3 credentials: {}", e))?;

        if let Some(r) = row {
            let access: Option<String> = r.get("master_access_key_id");
            let secret: Option<String> = r.get("master_secret");
            if let (Some(a), Some(s)) = (access, secret) {
                if !a.is_empty() && !s.is_empty() {
                    let _ = save_s3_credentials(account_id, &a, &s).await;
                    let _ = sqlx::query("DELETE FROM objectstore_auth WHERE id = ?")
                        .bind(AUTH_ROW_ID)
                        .execute(pool)
                        .await;
                    return Ok(Some((a, s)));
                }
            }
        }
        Ok(None)
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

/// Set AWS_* env vars from stored S3 credentials (migration use only).
pub async fn load_s3_credentials_into_env(account_id: &str) -> Result<(), String> {
    clear_s3_env();
    if let Some((access, secret)) = get_s3_credentials(account_id).await? {
        unsafe {
            std::env::set_var("AWS_ACCESS_KEY_ID", &access);
            std::env::set_var("AWS_SECRET_ACCESS_KEY", &secret);
            std::env::set_var("AWS_DEFAULT_REGION", "us-east-1");
        }
        Ok(())
    } else {
        Err("No stored S3 credentials".to_string())
    }
}

/// Ensure S3 env vars are set, fetching new credentials via the API token if needed
/// (migration use only).
pub async fn ensure_s3_credentials(account_id: &str) -> Result<(), String> {
    if load_s3_credentials_into_env(account_id).await.is_ok() {
        return Ok(());
    }

    let api_token = get_api_token(account_id)
        .await?
        .ok_or_else(|| "No stored S3 credentials and no API token available".to_string())?;

    let api_base =
        std::env::var("HIPPIUS_API_BASE_URL").unwrap_or_else(|_| DEFAULT_API_BASE.to_string());
    let url = format!(
        "{}/objectstore/master-tokens/",
        api_base.trim_end_matches('/')
    );

    #[derive(serde::Serialize)]
    struct CreateBody<'a> {
        name: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        expires_at: Option<&'a str>,
    }

    let body = CreateBody {
        name: "hippius-desktop",
        expires_at: None,
    };

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header(AUTHORIZATION, format!("Token {}", api_token))
        .header(CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to request S3 credentials: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "S3 credentials request failed (status {}): {}",
            status, text
        ));
    }

    #[derive(serde::Deserialize)]
    struct CredentialsResponse {
        #[serde(rename = "accessKeyId")]
        access_key_id: String,
        secret: String,
    }

    let parsed: CredentialsResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse S3 credentials response: {}", e))?;

    save_s3_credentials(account_id, &parsed.access_key_id, &parsed.secret).await?;
    load_s3_credentials_into_env(account_id).await
}

fn clear_s3_env() {
    unsafe {
        std::env::remove_var("AWS_ACCESS_KEY_ID");
        std::env::remove_var("AWS_SECRET_ACCESS_KEY");
    }
}
