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

use crate::auth::account_key::account_key;
use crate::error::AppError;
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
) -> Result<(), AppError> {
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
    .await?;

    Ok(())
}

/// Retrieve the encrypted wallet record for the given account.
#[tauri::command]
pub async fn get_wallet(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<Option<WalletRecord>, AppError> {
    let pool = state.pool()?;
    let owner = account_key(&account_id);

    let row = sqlx::query_as::<_, (String, String)>("SELECT encrypted_mnemonic, passcode_hash FROM wallet_store WHERE owner = ?")
        .bind(&owner)
        .fetch_optional(pool)
        .await?;

    Ok(row.map(|(encrypted_mnemonic, passcode_hash)| WalletRecord {
        encrypted_mnemonic,
        passcode_hash,
    }))
}

/// Check whether a wallet/passcode record exists for the given account.
#[tauri::command]
pub async fn has_wallet(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<bool, AppError> {
    let pool = state.pool()?;
    let owner = account_key(&account_id);

    let row = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM wallet_store WHERE owner = ?")
        .bind(&owner)
        .fetch_one(pool)
        .await?;

    Ok(row.0 > 0)
}

/// Remove the wallet record for the given account.
#[tauri::command]
pub async fn clear_wallet(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<(), AppError> {
    info!("Clearing wallet credentials");
    let pool = state.pool()?;
    let owner = account_key(&account_id);

    sqlx::query("DELETE FROM wallet_store WHERE owner = ?").bind(&owner).execute(pool).await?;

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
) -> Result<(), AppError> {
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
    .await?;

    Ok(())
}

/// Retrieve the current auth session for the given account.
#[tauri::command]
pub async fn get_auth_session(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<Option<AuthSession>, AppError> {
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
    .await?;

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
pub async fn get_auth_token(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<Option<ApiAuth>, AppError> {
    let pool = state.pool()?;
    let owner = account_key(&account_id);

    let row = sqlx::query_as::<_, (Option<String>, Option<i64>, Option<i64>, Option<String>)>(
        "SELECT auth_token, token_expiry, user_id, username FROM auth_session WHERE owner = ?",
    )
    .bind(&owner)
    .fetch_optional(pool)
    .await?;

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
pub async fn clear_auth_session(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<(), AppError> {
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
    .await?;

    Ok(())
}

/// Server-side token expiry check. Returns `true` if the token exists and hasn't expired.
#[tauri::command]
pub async fn is_token_valid(state: tauri::State<'_, crate::app_state::AppState>, account_id: String) -> Result<bool, AppError> {
    let pool = state.pool()?;
    let owner = account_key(&account_id);

    let row = sqlx::query_as::<_, (Option<String>, Option<i64>)>("SELECT auth_token, token_expiry FROM auth_session WHERE owner = ?")
        .bind(&owner)
        .fetch_optional(pool)
        .await?;

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
pub async fn get_last_auth_session(state: tauri::State<'_, crate::app_state::AppState>) -> Result<Option<AuthSession>, AppError> {
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
    .await?;

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

/// Result of session restoration, returned to the frontend for state setup.
///
/// The frontend reads localStorage (Rust can't), passes the OAuth data
/// to this command, and Rust makes all decisions about what's valid.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRestoreResult {
    pub authenticated: bool,
    pub substrate_address: Option<String>,
    pub auth_type: Option<String>,
    pub oauth_session: Option<serde_json::Value>,
    /// Milliseconds until logout. None = infinite / no timer.
    pub logout_time_ms: Option<i64>,
    /// Frontend should clear OAuth localStorage entries.
    pub should_clear_oauth: bool,
    /// true = initSync with mnemonic from Rust; false = initSync without mnemonic (or skip)
    pub needs_sync_mnemonic: bool,
    /// Where to navigate: "/" for home, "/login" for login, null for no navigation
    pub redirect_to: Option<String>,
}

/// Restore the user's session at app boot.
///
/// Replaces the 150-line boot cascade in `wallet-auth-context.tsx`.
/// Full logout: stops sync, clears auth state, clears sync progress.
///
/// Replaces the 3-sequential-invoke pattern in wallet-auth-context.tsx.
/// The frontend still needs to clear localStorage and React state.
#[tauri::command]
pub async fn logout_full(app: tauri::AppHandle, account_id: String) -> Result<(), AppError> {
    use tauri::Manager;
    info!(account_id = %account_id, "Full logout initiated");

    // 1. Stop sync engine
    if let Err(e) = crate::sync::lifecycle::stop_sync(app.clone()).await {
        tracing::warn!("stop_sync during logout failed: {e}");
    }

    // 2. Clear auth state
    let state = app.state::<crate::app_state::AppState>();
    if let Err(e) = crate::auth::login::auth_logout_internal(&state, &account_id).await {
        tracing::warn!("auth_logout during logout failed: {e}");
    }

    // 3. Clear sync progress data
    if let Err(e) = crate::sync::progress::clear_all_data(&state.sync) {
        tracing::warn!("sp_clear_all_data during logout failed: {e}");
    }

    Ok(())
}

/// The frontend reads localStorage OAuth data and passes it here.
/// Rust validates tokens, checks expiry, falls back to DB session,
/// and returns a structured result for the frontend to render.
#[tauri::command]
#[expect(
    clippy::too_many_lines,
    reason = "Linear multi-stage auth flow (OAuth JSON validation → DB fallback → result build). Splitting fragments the early-return error paths and has caused past regressions; tests/session_commands.rs provides integration coverage."
)]
pub async fn restore_session(
    state: tauri::State<'_, crate::app_state::AppState>,
    oauth_session_json: Option<String>,
    oauth_expiry_ms: Option<i64>,
) -> Result<SessionRestoreResult, AppError> {
    let pool = state.pool()?;
    let now_ms = chrono::Utc::now().timestamp_millis();

    // ── Try OAuth session first ─────────────────────────────────────────
    if let (Some(json), Some(expiry)) = (&oauth_session_json, oauth_expiry_ms) {
        if now_ms < expiry {
            match serde_json::from_str::<serde_json::Value>(json) {
                Ok(session_data) => {
                    let substrate_address = session_data.get("substrateAddress").and_then(|v| v.as_str()).map(String::from);

                    // Validate token in Rust DB
                    if let Some(ref addr) = substrate_address {
                        let owner = account_key(addr);
                        let token_row =
                            sqlx::query_as::<_, (Option<String>, Option<i64>)>("SELECT auth_token, token_expiry FROM auth_session WHERE owner = ?")
                                .bind(&owner)
                                .fetch_optional(pool)
                                .await?;

                        let token_valid = matches!(token_row, Some((Some(_), Some(exp))) if exp > now_ms);
                        if !token_valid {
                            info!("OAuth token expired in DB, clearing session");
                            return Ok(SessionRestoreResult {
                                authenticated: false,
                                substrate_address: None,
                                auth_type: None,
                                oauth_session: None,
                                logout_time_ms: None,
                                should_clear_oauth: true,
                                needs_sync_mnemonic: false,
                                redirect_to: Some("/login".into()),
                            });
                        }
                    }

                    let provider = session_data.get("provider").and_then(|v| v.as_str()).unwrap_or("oauth");
                    let auth_type = if provider == "mnemonic" { "mnemonic" } else { "oauth" };
                    let needs_mnemonic = provider != "mnemonic";

                    if let Some(ref addr) = substrate_address {
                        state.set_active_account(addr);
                    }
                    info!("Restoring OAuth session for {:?}", substrate_address);
                    return Ok(SessionRestoreResult {
                        authenticated: true,
                        substrate_address,
                        auth_type: Some(auth_type.into()),
                        oauth_session: Some(session_data),
                        logout_time_ms: None, // OAuth uses server-side 30-day expiry
                        should_clear_oauth: false,
                        needs_sync_mnemonic: needs_mnemonic,
                        redirect_to: None,
                    });
                }
                Err(e) => {
                    info!("Failed to parse OAuth session JSON: {e}");
                    // Fall through to DB session
                }
            }
        } else {
            info!("OAuth session expired");
        }
        // OAuth expired or invalid — tell frontend to clear localStorage
    }

    let should_clear = oauth_session_json.is_some();

    // ── Fall back to Rust DB session ────────────────────────────────────
    let row = sqlx::query_as::<_, (Option<String>, Option<i64>, Option<i64>, Option<String>, Option<String>, Option<String>, Option<i64>, Option<String>)>(
        "SELECT auth_token, token_expiry, user_id, username, provider, substrate_address, logout_time_minutes, last_login_at FROM auth_session ORDER BY updated_at DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;

    let Some((Some(auth_token), token_expiry, user_id, username, provider, substrate_address, logout_time_minutes, _last_login_at)) = row else {
        return Ok(SessionRestoreResult {
            authenticated: false,
            substrate_address: None,
            auth_type: None,
            oauth_session: None,
            logout_time_ms: None,
            should_clear_oauth: should_clear,
            needs_sync_mnemonic: false,
            redirect_to: None,
        });
    };

    // Check token expiry
    if let Some(expiry) = token_expiry
        && expiry > 0
        && expiry < now_ms
    {
        info!("DB session token expired, clearing");
        if let Some(ref addr) = substrate_address {
            let owner = account_key(addr);
            let _ = sqlx::query("UPDATE auth_session SET auth_token = NULL, token_expiry = NULL, user_id = NULL, username = NULL, provider = NULL, substrate_address = NULL WHERE owner = ?")
                    .bind(&owner)
                    .execute(pool)
                    .await;
        }
        return Ok(SessionRestoreResult {
            authenticated: false,
            substrate_address: None,
            auth_type: None,
            oauth_session: None,
            logout_time_ms: None,
            should_clear_oauth: should_clear,
            needs_sync_mnemonic: false,
            redirect_to: Some("/login".into()),
        });
    }

    // Valid session — build OAuth session object for frontend display
    let oauth_session = serde_json::json!({
        "token": auth_token,
        "userId": user_id.unwrap_or(0),
        "username": username.clone().unwrap_or_default(),
        "provider": provider.clone().unwrap_or_else(|| "mnemonic".into()),
        "expiresAt": token_expiry.and_then(|e| chrono::DateTime::from_timestamp_millis(e).map(|d| d.to_rfc3339())).unwrap_or_default(),
        "substrateAddress": substrate_address.clone(),
        "isNew": false,
    });

    let auth_type = if provider.as_deref() == Some("oauth") { "oauth" } else { "mnemonic" };
    let eff_minutes = logout_time_minutes.unwrap_or(1440);
    let logout_time_ms = if eff_minutes == -1 { None } else { Some(eff_minutes * 60_000) };

    if let Some(ref addr) = substrate_address {
        state.set_active_account(addr);
    }
    info!("Restoring DB session for {:?}", substrate_address);
    Ok(SessionRestoreResult {
        authenticated: true,
        substrate_address,
        auth_type: Some(auth_type.into()),
        oauth_session: Some(oauth_session),
        logout_time_ms,
        should_clear_oauth: should_clear,
        needs_sync_mnemonic: provider.as_deref() != Some("mnemonic"),
        redirect_to: Some("/".into()),
    })
}

/// Update the logout timeout preference (minutes). Pass -1 for "never expire".
#[tauri::command]
pub async fn update_logout_time(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    logout_time_minutes: i64,
) -> Result<(), AppError> {
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
    .await?;

    Ok(())
}

/// Save the API auth token for an account. Called by the frontend after login
/// so that Rust subsystems (sync, VPN) can retrieve it via `get_api_token`.
#[tauri::command]
pub async fn save_api_token_command(state: tauri::State<'_, crate::app_state::AppState>, account_id: String, token: String) -> Result<(), AppError> {
    info!("Saving API token");
    crate::auth::tokens::save_api_token(state.pool()?, &account_id, &token).await?;
    Ok(())
}

/// Data needed to render the system tray menu.
///
/// All login status and credits checking is done in Rust. The frontend
/// just renders the tray from this data.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayMenuData {
    pub logged_in: bool,
    pub substrate_address: Option<String>,
    /// Raw credit balance. None if not logged in or fetch failed.
    pub credits: Option<f64>,
}

/// Return pre-computed data for the system tray menu.
///
/// Checks login status by querying the auth session DB (no localStorage
/// needed). Fetches credits balance if logged in. Replaces the caching
/// and conditional checks in `useTraySync.ts`.
#[tauri::command]
pub async fn get_tray_menu_data(state: tauri::State<'_, crate::app_state::AppState>) -> Result<TrayMenuData, AppError> {
    let pool = state.pool()?;
    let now_ms = chrono::Utc::now().timestamp_millis();

    // Check for valid session
    let row = sqlx::query_as::<_, (Option<String>, Option<i64>, Option<String>)>(
        "SELECT auth_token, token_expiry, substrate_address FROM auth_session ORDER BY updated_at DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;

    let (logged_in, substrate_address) = match row {
        Some((Some(token), expiry, addr)) if !token.is_empty() => {
            let valid = expiry.is_none_or(|e| e == 0 || e > now_ms);
            (valid, if valid { addr } else { None })
        }
        _ => (false, None),
    };

    let credits = if let Some(ref addr) = substrate_address {
        match crate::api::client::ApiClient::new(pool.clone())
            .get::<serde_json::Value>("/api/billing/credits/balance/", addr)
            .await
        {
            Ok(data) => {
                let balance = data.get("balance").and_then(|v| v.as_str()).unwrap_or("0");
                Some(balance.parse::<f64>().unwrap_or(0.0))
            }
            Err(_) => None,
        }
    } else {
        None
    };

    Ok(TrayMenuData {
        logged_in,
        substrate_address,
        credits,
    })
}

/// Platform information for UI rendering decisions.
///
/// The frontend uses this instead of `navigator.platform` (deprecated)
/// for file manager labels, video codec support, etc.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    /// "macos", "windows", or "linux"
    pub os: String,
    /// "Finder", "Explorer", or "Files"
    pub file_manager_label: String,
    /// Whether MKV container is supported (false on macOS WKWebView)
    pub supports_mkv: bool,
    /// Whether 3GP container is supported (false on macOS WKWebView)
    pub supports_3gp: bool,
}

/// Return platform-specific info so the frontend doesn't need `navigator.platform`.
#[tauri::command]
pub fn get_platform_info() -> PlatformInfo {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };

    let file_manager_label = match os {
        "macos" => "Finder",
        "windows" => "Explorer",
        _ => "Files",
    };

    let is_macos = cfg!(target_os = "macos");

    PlatformInfo {
        os: os.to_string(),
        file_manager_label: file_manager_label.to_string(),
        supports_mkv: !is_macos,
        supports_3gp: !is_macos,
    }
}
