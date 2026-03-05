use crate::DB_POOL;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use sqlx::Row;

const AUTH_ROW_ID: i64 = 1;
const DEFAULT_API_BASE: &str = "https://api.hippius.com/api";

/// Remove AWS env vars so the next account can set its own.
pub fn clear_objectstore_env() {
    unsafe {
        std::env::remove_var("AWS_ACCESS_KEY_ID");
        std::env::remove_var("AWS_SECRET_ACCESS_KEY");
    }
}

/// Persist a temp auth key (OAuth token) for this account.
///
/// **Usage**: This token is used for Hippius API authentication (Authorization: Token {temp_key})
/// **NOT for S3**: Use master token for S3/Object Storage access instead.
pub async fn save_temp_auth_key(account_id: &str, temp_key: &str) -> Result<(), String> {
    if let Some(pool) = DB_POOL.get() {
        sqlx::query(
            r#"
            INSERT INTO objectstore_auth_scoped (owner, temp_auth_key, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(owner) DO UPDATE SET temp_auth_key = excluded.temp_auth_key, updated_at = CURRENT_TIMESTAMP
            "#,
        )
        .bind(account_id)
        .bind(temp_key)
        .execute(pool)
        .await
        .map_err(|e| format!("DB error saving temp auth key: {}", e))?;
        Ok(())
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

/// Save the master token (S3 credentials) for this account.
///
/// **Usage**: This token is used for S3/Object Storage access (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
/// **NOT for API**: Use temp auth key for Hippius API authentication instead.
pub async fn save_master_token(
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
        .map_err(|e| format!("DB error saving master token: {}", e))?;

        log_masked("[Auth] Stored master token", access_key_id, true);
        Ok(())
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

/// Returns true if a non-empty master token is stored for this account (scoped or legacy).
pub async fn has_master_token(account_id: &str) -> Result<bool, String> {
    if let Some(pool) = DB_POOL.get() {
        // Scoped first
        if let Some(row) = sqlx::query(
            "SELECT master_access_key_id, master_secret FROM objectstore_auth_scoped WHERE owner = ?",
        )
        .bind(account_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error fetching master token: {}", e))?
        {
            let access: Option<String> = row.get("master_access_key_id");
            let secret: Option<String> = row.get("master_secret");
            if matches!((access.as_deref(), secret.as_deref()), (Some(a), Some(s)) if !a.is_empty() && !s.is_empty()) {
                return Ok(true);
            }
        }

        // Legacy single-row
        if let Some(row) = sqlx::query(
            "SELECT master_access_key_id, master_secret FROM objectstore_auth WHERE id = ?",
        )
        .bind(AUTH_ROW_ID)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error fetching master token: {}", e))?
        {
            let access: Option<String> = row.get("master_access_key_id");
            let secret: Option<String> = row.get("master_secret");
            if matches!((access.as_deref(), secret.as_deref()), (Some(a), Some(s)) if !a.is_empty() && !s.is_empty())
            {
                return Ok(true);
            }
        }
        Ok(false)
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

/// Get the temp auth key (OAuth token) for this account.
///
/// **Usage**: Use this for Hippius API authentication (Authorization: Token {temp_key})
/// **Returns**: OAuth token string or None if not found
pub async fn get_temp_auth_key(account_id: &str) -> Result<Option<String>, String> {
    if let Some(pool) = DB_POOL.get() {
        // Prefer scoped record, fall back to legacy single-row storage
        let scoped =
            sqlx::query("SELECT temp_auth_key FROM objectstore_auth_scoped WHERE owner = ?")
                .bind(account_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| format!("DB error fetching temp auth key: {}", e))?;

        if let Some(row) = scoped {
            return Ok(row.get::<Option<String>, _>("temp_auth_key"));
        }

        let legacy = sqlx::query("SELECT temp_auth_key FROM objectstore_auth WHERE id = ?")
            .bind(AUTH_ROW_ID)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("DB error fetching temp auth key: {}", e))?;
        if let Some(row) = legacy {
            if let Some(temp) = row.get::<Option<String>, _>("temp_auth_key") {
                // migrate legacy to scoped
                let _ = save_temp_auth_key(account_id, &temp).await;
                let _ = sqlx::query("DELETE FROM objectstore_auth WHERE id = ?")
                    .bind(AUTH_ROW_ID)
                    .execute(pool)
                    .await;
                return Ok(Some(temp));
            }
        }
        Ok(None)
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

/// Get the master token (S3 credentials) for this account.
///
/// **Usage**: Use this for S3/Object Storage access (AWS credentials)
/// **Returns**: Tuple of (access_key_id, secret) or None if not found
/// **NOT for API**: Use get_temp_auth_key for Hippius API authentication instead.
pub async fn get_master_token(account_id: &str) -> Result<Option<(String, String)>, String> {
    if let Some(pool) = DB_POOL.get() {
        // Prefer scoped record, fall back to legacy
        let scoped = sqlx::query(
            "SELECT master_access_key_id, master_secret FROM objectstore_auth_scoped WHERE owner = ?",
        )
        .bind(account_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error fetching master token: {}", e))?;

        if let Some(r) = scoped {
            let access: Option<String> = r.get("master_access_key_id");
            let secret: Option<String> = r.get("master_secret");
            return Ok(match (access, secret) {
                (Some(a), Some(s)) if !a.is_empty() && !s.is_empty() => Some((a, s)),
                _ => None,
            });
        }

        let row = sqlx::query(
            "SELECT master_access_key_id, master_secret FROM objectstore_auth WHERE id = ?",
        )
        .bind(AUTH_ROW_ID)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error fetching master token: {}", e))?;

        if let Some(r) = row {
            let access: Option<String> = r.get("master_access_key_id");
            let secret: Option<String> = r.get("master_secret");
            if let (Some(a), Some(s)) = (access, secret) {
                if !a.is_empty() && !s.is_empty() {
                    // migrate legacy to scoped for this account
                    let _ = save_master_token(account_id, &a, &s).await;
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

/// Set AWS_* env vars from the stored master token (if present).
pub async fn ensure_master_token_env(account_id: &str) -> Result<(), String> {
    clear_objectstore_env();
    if let Some((access, secret)) = get_master_token(account_id).await? {
        unsafe {
            std::env::set_var("AWS_ACCESS_KEY_ID", &access);
            std::env::set_var("AWS_SECRET_ACCESS_KEY", &secret);
            // Region is still required by the SDK even if endpoint overrides; keep default.
            std::env::set_var("AWS_DEFAULT_REGION", "us-east-1");
        }
        log_masked("[Auth] Loaded master token into AWS env", &access, false);
        Ok(())
    } else {
        Err("No stored master token".to_string())
    }
}

/// Ensure AWS_* env vars are set, fetching a new master token via the temp auth key if needed.
pub async fn ensure_master_token_or_fetch(account_id: &str) -> Result<(), String> {
    if ensure_master_token_env(account_id).await.is_ok() {
        return Ok(());
    }

    // Fallback: try to fetch a new master token using the stored temp auth key.
    let temp_key = get_temp_auth_key(account_id)
        .await?
        .ok_or_else(|| "No stored master token and no temp auth key available".to_string())?;

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
        .header(AUTHORIZATION, format!("Token {}", temp_key))
        .header(CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to request master token: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Master token request failed (status {}): {}",
            status, text
        ));
    }

    #[derive(serde::Deserialize)]
    struct MasterTokenResponse {
        #[serde(rename = "accessKeyId")]
        access_key_id: String,
        secret: String,
    }

    let parsed: MasterTokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse master token response: {}", e))?;

    save_master_token(account_id, &parsed.access_key_id, &parsed.secret).await?;
    ensure_master_token_env(account_id).await
}

fn log_masked(prefix: &str, access_key_id: &str, stored: bool) {
    // Avoid leaking secrets; only print a short fingerprint.
    let short = if access_key_id.len() > 8 {
        format!(
            "{}...{}",
            &access_key_id[..4],
            &access_key_id[access_key_id.len().saturating_sub(4)..]
        )
    } else {
        access_key_id.to_string()
    };
    let where_str = if stored { "db" } else { "env" };
    println!("{prefix} ({where_str}) access_key_id={short}");
}
