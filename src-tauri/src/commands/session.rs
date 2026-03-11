//! Session and wallet credential storage commands.
//!
//! These commands replace the frontend's IndexedDB-based `hippiusDesktopDB.ts`
//! and `sessionStore.ts` — all sensitive credential storage now lives in the
//! Rust-managed SQLite database at `~/.hippius/hippius.db`.

use crate::utils::account_key::account_key;
use crate::DB_POOL;

// ── Types ──────────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletRecord {
    pub encrypted_mnemonic: String,
    pub passcode_hash: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub auth_token: Option<String>,
    pub token_expiry: Option<i64>,
    pub user_id: Option<i64>,
    pub username: Option<String>,
    pub provider: Option<String>,
    pub substrate_address: Option<String>,
    pub logout_time_minutes: Option<i64>,
    pub last_login_at: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiAuth {
    pub token: String,
    pub token_expiry: i64,
    pub user_id: Option<i64>,
    pub username: Option<String>,
}

// ── Wallet Commands ────────────────────────────────────────────────────

/// Store an AES-encrypted mnemonic + passcode hash for the given account.
#[tauri::command]
pub async fn save_wallet(
    account_id: String,
    encrypted_mnemonic: String,
    passcode_hash: String,
) -> Result<(), String> {
    let pool = DB_POOL.get().ok_or("Database not initialized")?;
    let owner = account_key(&account_id);

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
    .bind(&encrypted_mnemonic)
    .bind(&passcode_hash)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to save wallet: {e}"))?;

    Ok(())
}

/// Retrieve the encrypted wallet record for the given account.
#[tauri::command]
pub async fn get_wallet(account_id: String) -> Result<Option<WalletRecord>, String> {
    let pool = DB_POOL.get().ok_or("Database not initialized")?;
    let owner = account_key(&account_id);

    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT encrypted_mnemonic, passcode_hash FROM wallet_store WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to get wallet: {e}"))?;

    Ok(row.map(|(encrypted_mnemonic, passcode_hash)| WalletRecord {
        encrypted_mnemonic,
        passcode_hash,
    }))
}

/// Check whether a wallet/passcode record exists for the given account.
#[tauri::command]
pub async fn has_wallet(account_id: String) -> Result<bool, String> {
    let pool = DB_POOL.get().ok_or("Database not initialized")?;
    let owner = account_key(&account_id);

    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM wallet_store WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("Failed to check wallet: {e}"))?;

    Ok(row.0 > 0)
}

/// Remove the wallet record for the given account.
#[tauri::command]
pub async fn clear_wallet(account_id: String) -> Result<(), String> {
    let pool = DB_POOL.get().ok_or("Database not initialized")?;
    let owner = account_key(&account_id);

    sqlx::query("DELETE FROM wallet_store WHERE owner = ?")
        .bind(&owner)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to clear wallet: {e}"))?;

    Ok(())
}

// ── Auth Session Commands ──────────────────────────────────────────────

/// Persist auth session (token, expiry, provider, etc.) for the given account.
///
/// This is the Rust equivalent of `sessionStore.setApiAuth()` + `saveSession()`.
/// Token is persisted immediately so the frontend can reference it right away.
#[tauri::command]
pub async fn save_auth_session(
    account_id: String,
    auth_token: Option<String>,
    token_expiry: Option<i64>,
    user_id: Option<i64>,
    username: Option<String>,
    provider: Option<String>,
    substrate_address: Option<String>,
    logout_time_minutes: Option<i64>,
) -> Result<(), String> {
    let pool = DB_POOL.get().ok_or("Database not initialized")?;
    let owner = account_key(&account_id);

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
    .bind(&auth_token)
    .bind(token_expiry)
    .bind(user_id)
    .bind(&username)
    .bind(&provider)
    .bind(&substrate_address)
    .bind(logout_time_minutes)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to save auth session: {e}"))?;

    Ok(())
}

/// Retrieve the current auth session for the given account.
#[tauri::command]
pub async fn get_auth_session(account_id: String) -> Result<Option<AuthSession>, String> {
    let pool = DB_POOL.get().ok_or("Database not initialized")?;
    let owner = account_key(&account_id);

    let row = sqlx::query_as::<_, (
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
    )>(
        r#"
        SELECT auth_token, token_expiry, user_id, username,
               provider, substrate_address, logout_time_minutes, last_login_at
        FROM auth_session
        WHERE owner = ?
        "#,
    )
    .bind(&owner)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to get auth session: {e}"))?;

    Ok(row.map(
        |(auth_token, token_expiry, user_id, username, provider, substrate_address, logout_time_minutes, last_login_at)| {
            AuthSession {
                auth_token,
                token_expiry,
                user_id,
                username,
                provider,
                substrate_address,
                logout_time_minutes,
                last_login_at,
            }
        },
    ))
}

/// Get auth token + validate expiry server-side. Returns `None` if expired or absent.
///
/// Replaces `sessionStore.getApiAuth()` — the frontend no longer checks expiry itself.
#[tauri::command]
pub async fn get_auth_token(account_id: String) -> Result<Option<ApiAuth>, String> {
    let pool = DB_POOL.get().ok_or("Database not initialized")?;
    let owner = account_key(&account_id);

    let row = sqlx::query_as::<_, (Option<String>, Option<i64>, Option<i64>, Option<String>)>(
        "SELECT auth_token, token_expiry, user_id, username FROM auth_session WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to get auth token: {e}"))?;

    let Some((Some(token), Some(expiry), user_id, username)) = row else {
        return Ok(None);
    };

    // Check expiry
    let now_ms = chrono::Utc::now().timestamp_millis();
    if expiry > 0 && expiry < now_ms {
        return Ok(None);
    }

    Ok(Some(ApiAuth {
        token,
        token_expiry: expiry,
        user_id,
        username,
    }))
}

/// Wipe the auth session on logout. Preserves `logout_time_minutes` preference.
#[tauri::command]
pub async fn clear_auth_session(account_id: String) -> Result<(), String> {
    let pool = DB_POOL.get().ok_or("Database not initialized")?;
    let owner = account_key(&account_id);

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
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to clear auth session: {e}"))?;

    Ok(())
}

/// Server-side token expiry check. Returns `true` if the token exists and hasn't expired.
#[tauri::command]
pub async fn is_token_valid(account_id: String) -> Result<bool, String> {
    let result = get_auth_token(account_id).await?;
    Ok(result.is_some())
}

/// Retrieve the most recently updated auth session (any account).
///
/// Used at app boot when we don't yet know which account was active.
/// Returns the session with the latest `updated_at` timestamp.
#[tauri::command]
pub async fn get_last_auth_session() -> Result<Option<AuthSession>, String> {
    let pool = DB_POOL.get().ok_or("Database not initialized")?;

    let row = sqlx::query_as::<_, (
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
    )>(
        r#"
        SELECT auth_token, token_expiry, user_id, username,
               provider, substrate_address, logout_time_minutes, last_login_at
        FROM auth_session
        ORDER BY updated_at DESC
        LIMIT 1
        "#,
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to get last auth session: {e}"))?;

    Ok(row.map(
        |(auth_token, token_expiry, user_id, username, provider, substrate_address, logout_time_minutes, last_login_at)| {
            AuthSession {
                auth_token,
                token_expiry,
                user_id,
                username,
                provider,
                substrate_address,
                logout_time_minutes,
                last_login_at,
            }
        },
    ))
}

/// Update the logout timeout preference (minutes). Pass -1 for "never expire".
#[tauri::command]
pub async fn update_logout_time(
    account_id: String,
    logout_time_minutes: i64,
) -> Result<(), String> {
    let pool = DB_POOL.get().ok_or("Database not initialized")?;
    let owner = account_key(&account_id);

    sqlx::query(
        r#"
        UPDATE auth_session SET
            logout_time_minutes = ?,
            updated_at = datetime('now')
        WHERE owner = ?
        "#,
    )
    .bind(logout_time_minutes)
    .bind(&owner)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update logout time: {e}"))?;

    Ok(())
}
