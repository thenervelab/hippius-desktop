//! System tray menu data assembly.
//!
//! Renders a small struct for the frontend's `useTraySync` hook so the
//! tray icon can show "logged in / logged out" + a credits balance
//! without the frontend touching the DB or duplicating expiry logic.

use crate::auth::auth_session_repo;
use crate::error::Result;
use serde::Serialize;

/// Data needed to render the system tray menu.
///
/// All login status and credits checking is done in Rust. The frontend
/// just renders the tray from this data.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayMenuData {
    pub logged_in: bool,
    pub substrate_address: Option<String>,
    /// Raw credit balance. None if not logged in or fetch failed.
    pub credits: Option<f64>,
}

/// Return pre-computed data for the system tray menu.
///
/// Reads the most recently updated `auth_session` row via
/// [`auth_session_repo::get_latest`], validates token expiry, and
/// (when logged in) fetches the credits balance via the billing API.
#[tauri::command]
pub async fn get_tray_menu_data(state: tauri::State<'_, crate::app_state::AppState>) -> Result<TrayMenuData> {
    let pool = state.pool()?;
    let now_ms = chrono::Utc::now().timestamp_millis();

    let row = auth_session_repo::get_latest(pool).await?;

    let (logged_in, substrate_address) = match row {
        Some(r) => match r.auth_token {
            Some(ref token) if !token.is_empty() => {
                let valid = r.token_expiry.is_none_or(|e| e == 0 || e > now_ms);
                (valid, if valid { r.substrate_address } else { None })
            }
            _ => (false, None),
        },
        None => (false, None),
    };

    // The credits fetch needs a `SessionAccount` proof. `addr` is the auth_session
    // row's address; validate it against the active session before the token call
    // (a mismatch — or no live session — yields unknown credits, not a leak).
    let credits = match substrate_address.as_deref().and_then(|addr| state.require_session_account_typed(addr).ok()) {
        Some(account) => match crate::api::client::ApiClient::new(state.api_client.clone(), pool.clone())
            .get::<serde_json::Value>("/api/billing/credits/balance/", &account)
            .await
        {
            Ok(data) => {
                let balance = data.get("balance").and_then(|v| v.as_str()).unwrap_or("0");
                // `.ok()` not `.unwrap_or(0.0)`: a malformed balance is "unknown"
                // (None), not "zero credits" — matching the `Err(_) => None` arm.
                balance.parse::<f64>().ok()
            }
            Err(_) => None,
        },
        None => None,
    };

    Ok(TrayMenuData {
        logged_in,
        substrate_address,
        credits,
    })
}
