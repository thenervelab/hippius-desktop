use crate::DB_POOL;
use sqlx::Row;

const AUTH_ROW_ID: i64 = 1;

pub async fn save_temp_auth_key(temp_key: &str) -> Result<(), String> {
    if let Some(pool) = DB_POOL.get() {
        sqlx::query(
            r#"
            INSERT INTO objectstore_auth (id, temp_auth_key, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET temp_auth_key = excluded.temp_auth_key, updated_at = CURRENT_TIMESTAMP
            "#,
        )
        .bind(AUTH_ROW_ID)
        .bind(temp_key)
        .execute(pool)
        .await
        .map_err(|e| format!("DB error saving temp auth key: {}", e))?;
        Ok(())
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

pub async fn save_master_token(access_key_id: &str, secret: &str) -> Result<(), String> {
    if let Some(pool) = DB_POOL.get() {
        sqlx::query(
            r#"
            INSERT INTO objectstore_auth (id, master_access_key_id, master_secret, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                master_access_key_id = excluded.master_access_key_id,
                master_secret = excluded.master_secret,
                updated_at = CURRENT_TIMESTAMP
            "#,
        )
        .bind(AUTH_ROW_ID)
        .bind(access_key_id)
        .bind(secret)
        .execute(pool)
        .await
        .map_err(|e| format!("DB error saving master token: {}", e))?;
        Ok(())
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

pub async fn get_temp_auth_key() -> Result<Option<String>, String> {
    if let Some(pool) = DB_POOL.get() {
        let row = sqlx::query("SELECT temp_auth_key FROM objectstore_auth WHERE id = ?")
            .bind(AUTH_ROW_ID)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("DB error fetching temp auth key: {}", e))?;
        Ok(row.and_then(|r| r.get::<Option<String>, _>("temp_auth_key")))
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

pub async fn get_master_token() -> Result<Option<(String, String)>, String> {
    if let Some(pool) = DB_POOL.get() {
        let row = sqlx::query(
            "SELECT master_access_key_id, master_secret FROM objectstore_auth WHERE id = ?",
        )
        .bind(AUTH_ROW_ID)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB error fetching master token: {}", e))?;

        Ok(row.and_then(|r| {
            let access: Option<String> = r.get("master_access_key_id");
            let secret: Option<String> = r.get("master_secret");
            match (access, secret) {
                (Some(a), Some(s)) if !a.is_empty() && !s.is_empty() => Some((a, s)),
                _ => None,
            }
        }))
    } else {
        Err("DB_POOL not initialized".to_string())
    }
}

/// Set AWS_* env vars from the stored master token (if present).
pub async fn ensure_master_token_env() -> Result<(), String> {
    if let Some((access, secret)) = get_master_token().await? {
        unsafe {
            std::env::set_var("AWS_ACCESS_KEY_ID", &access);
            std::env::set_var("AWS_SECRET_ACCESS_KEY", &secret);
            // Region is still required by the SDK even if endpoint overrides; keep default.
            std::env::set_var("AWS_DEFAULT_REGION", "us-east-1");
        }
        Ok(())
    } else {
        Err("No stored master token".to_string())
    }
}
