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
    /// Whether the *in-memory* session is hydrated for `substrate_address`.
    ///
    /// `logged_in` reflects the persisted `auth_session` row, which is valid
    /// from the moment the process starts — but account-scoped commands
    /// (`get_unread_count`, `get_recent_uploads`) authorize against in-memory
    /// `AuthInfo`, which only `restore_session` populates. The prewarmed tray
    /// popover polls from boot, so without this flag it fires those commands
    /// during the gap and they reject with `AppError::Auth`. The popover gates
    /// its scoped calls on `session_ready` so it waits out that gap instead.
    pub session_ready: bool,
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

    // `addr` is the auth_session row's address; validate it against the active
    // in-memory session. This same proof gates BOTH the credits fetch and
    // `session_ready`: it is `Some` only once `restore_session` has hydrated
    // `AuthInfo` with this account, which is exactly when the account-scoped
    // popover commands would authorize. Resolving it once avoids a second
    // auth-lock read and keeps the two answers from drifting.
    let session_account = match substrate_address.as_deref() {
        Some(addr) => match state.require_session_account_typed(addr) {
            Ok(account) => Some(account),
            // `session_ready` will be false, so the popover withholds its
            // scoped calls. `AppError::Auth` here is the expected boot gap
            // (AuthInfo not yet hydrated by restore_session); a `Lock`
            // (poisoned auth mutex) is abnormal. Either way, log the cause at
            // debug to keep the breadcrumb the FE's `.catch` console.error used
            // to provide before the gate skipped the call. The error Display is
            // a static, secret-free string (no address is logged).
            Err(e) => {
                tracing::debug!(error = %e, "tray popover session proof unavailable; session_ready=false");
                None
            }
        },
        None => None,
    };
    let session_ready = session_account.is_some();

    let credits = match session_account {
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
        session_ready,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drift guard for the IPC wire contract `useTrayPanelData.ts` gates on.
    /// The popover withholds its account-scoped calls until `sessionReady` is
    /// true, so a rename of the field (or of `serde(rename_all)`) would
    /// silently revive the boot-race `AppError::Auth` spam. Pinning the exact
    /// camelCase keys makes that break a failing test instead.
    #[test]
    fn serializes_session_ready_as_camel_case() {
        let data = TrayMenuData {
            logged_in: true,
            substrate_address: Some("5Frholdaddr".into()),
            credits: Some(12.5),
            session_ready: false,
        };
        let json = serde_json::to_value(&data).expect("serialize");
        assert_eq!(json["loggedIn"], true);
        assert_eq!(json["substrateAddress"], "5Frholdaddr");
        assert_eq!(json["credits"], 12.5);
        assert_eq!(json["sessionReady"], false);
    }
}
