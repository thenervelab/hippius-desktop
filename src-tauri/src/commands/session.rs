//! Session and wallet credential storage commands.
//!
//! These commands replace the frontend's IndexedDB-based `hippiusDesktopDB.ts`
//! and `sessionStore.ts` — all sensitive credential storage now lives in the
//! Rust-managed SQLite database at `~/.hippius/hippius.db`.
//!
//! Two tables back this module:
//! - **`wallet_store`** — AES-encrypted mnemonic + passcode hash (one row per account)
//! - **`auth_session`** — API token, expiry, provider, and user metadata
//!
//! The frontend calls these via Tauri IPC; no credential material ever resides
//! in browser storage.

use crate::utils::account_key::account_key;
use tracing::info;

/// Encrypted wallet record for a single account.
///
/// The `encrypted_mnemonic` is CryptoJS-compatible AES ciphertext (base64),
/// and `passcode_hash` is the SHA-256 hex digest of the user's passcode.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletRecord {
    pub encrypted_mnemonic: String,
    pub passcode_hash: String,
}

/// Persisted auth session for one account, restored at app boot.
///
/// All fields are optional because a logged-out session retains only
/// the `logout_time_minutes` preference (the rest are NULLed on logout).
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

/// Minimal token payload returned by [`get_auth_token`].
///
/// Includes only what the frontend needs for authenticated API requests,
/// omitting session metadata like provider or logout preferences.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiAuth {
    pub token: String,
    pub token_expiry: i64,
    pub user_id: Option<i64>,
    pub username: Option<String>,
}

/// Store an AES-encrypted mnemonic + passcode hash for the given account.
#[tauri::command]
pub async fn save_wallet(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    encrypted_mnemonic: String,
    passcode_hash: String,
) -> Result<(), String> {
    info!("Saving wallet credentials");
    let pool = state.pool()?;
    let owner = account_key(&account_id);

    sqlx::query(
        r"
        INSERT INTO wallet_store (owner, encrypted_mnemonic, passcode_hash, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(owner) DO UPDATE SET
            encrypted_mnemonic = excluded.encrypted_mnemonic,
            passcode_hash = excluded.passcode_hash,
            updated_at = datetime('now')
        ",
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
pub async fn get_wallet(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<Option<WalletRecord>, String> {
    let pool = state.pool()?;
    let owner = account_key(&account_id);

    let row = sqlx::query_as::<_, (String, String)>("SELECT encrypted_mnemonic, passcode_hash FROM wallet_store WHERE owner = ?")
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
pub async fn has_wallet(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<bool, String> {
    let pool = state.pool()?;
    let owner = account_key(&account_id);

    let row = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM wallet_store WHERE owner = ?")
        .bind(&owner)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("Failed to check wallet: {e}"))?;

    Ok(row.0 > 0)
}

/// Remove the wallet record for the given account.
#[tauri::command]
pub async fn clear_wallet(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<(), String> {
    info!("Clearing wallet credentials");
    let pool = state.pool()?;
    let owner = account_key(&account_id);

    sqlx::query("DELETE FROM wallet_store WHERE owner = ?")
        .bind(&owner)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to clear wallet: {e}"))?;

    Ok(())
}

/// Persist auth session (token, expiry, provider, etc.) for the given account.
///
/// This is the Rust equivalent of `sessionStore.setApiAuth()` + `saveSession()`.
/// Token is persisted immediately so the frontend can reference it right away.
#[tauri::command]
#[expect(clippy::too_many_arguments)] // Tauri IPC commands take individual params from frontend
pub async fn save_auth_session(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    auth_token: Option<String>,
    token_expiry: Option<i64>,
    user_id: Option<i64>,
    username: Option<String>,
    provider: Option<String>,
    substrate_address: Option<String>,
    logout_time_minutes: Option<i64>,
) -> Result<(), String> {
    info!("Saving auth session");
    let pool = state.pool()?;
    let owner = account_key(&account_id);

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
pub async fn get_auth_session(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<Option<AuthSession>, String> {
    let pool = state.pool()?;
    let owner = account_key(&account_id);

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
    .await
    .map_err(|e| format!("Failed to get auth session: {e}"))?;

    Ok(row.map(
        |(auth_token, token_expiry, user_id, username, provider, substrate_address, logout_time_minutes, last_login_at)| AuthSession {
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

/// Get auth token + validate expiry server-side. Returns `None` if expired or absent.
///
/// Replaces `sessionStore.getApiAuth()` — the frontend no longer checks expiry itself.
#[tauri::command]
pub async fn get_auth_token(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<Option<ApiAuth>, String> {
    let pool = state.pool()?;
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
pub async fn clear_auth_session(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<(), String> {
    info!("Clearing auth session");
    let pool = state.pool()?;
    let owner = account_key(&account_id);

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
    .await
    .map_err(|e| format!("Failed to clear auth session: {e}"))?;

    Ok(())
}

/// Server-side token expiry check. Returns `true` if the token exists and hasn't expired.
#[tauri::command]
pub async fn is_token_valid(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<bool, String> {
    let pool = state.pool()?;
    let owner = account_key(&account_id);

    let row = sqlx::query_as::<_, (Option<String>, Option<i64>)>("SELECT auth_token, token_expiry FROM auth_session WHERE owner = ?")
        .bind(&owner)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("Failed to check token validity: {e}"))?;

    let result = match row {
        Some((Some(_token), Some(expiry))) => {
            let now_ms = chrono::Utc::now().timestamp_millis();
            !(expiry > 0 && expiry < now_ms)
        }
        _ => false,
    };
    Ok(result)
}

/// Retrieve the most recently updated auth session (any account).
///
/// Used at app boot when we don't yet know which account was active.
/// Returns the session with the latest `updated_at` timestamp.
#[tauri::command]
pub async fn get_last_auth_session(state: tauri::State<'_, crate::app_state::AppState>) -> Result<Option<AuthSession>, String> {
    let pool = state.pool()?;

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
    .await
    .map_err(|e| format!("Failed to get last auth session: {e}"))?;

    Ok(row.map(
        |(auth_token, token_expiry, user_id, username, provider, substrate_address, logout_time_minutes, last_login_at)| AuthSession {
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

/// Update the logout timeout preference (minutes). Pass -1 for "never expire".
#[tauri::command]
pub async fn update_logout_time(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    logout_time_minutes: i64,
) -> Result<(), String> {
    let pool = state.pool()?;
    let owner = account_key(&account_id);

    sqlx::query(
        r"
        UPDATE auth_session SET
            logout_time_minutes = ?,
            updated_at = datetime('now')
        WHERE owner = ?
        ",
    )
    .bind(logout_time_minutes)
    .bind(&owner)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update logout time: {e}"))?;

    Ok(())
}

/// Save the API auth token for an account. Called by the frontend after login
/// so that Rust subsystems (sync, VPN) can retrieve it via `get_api_token`.
#[tauri::command]
pub async fn save_api_token_command(state: tauri::State<'_, crate::app_state::AppState>, account_id: String, token: String) -> Result<(), String> {
    info!("Saving API token");
    crate::utils::auth_tokens::save_api_token(state.pool()?, &account_id, &token).await
}
