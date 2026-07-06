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

/// The account the tray popover reports, resolved from the active in-memory
/// session and the persisted fallback.
///
/// Modeled as an enum (not a bare `Option` plus flags) so the output states —
/// an active session vs. the display-only persisted fallback — are explicit
/// and the mapping to [`TrayMenuData`] is exhaustive.
#[derive(Debug, PartialEq, Eq)]
enum TrayAccountView {
    /// An active in-memory session exists. Credits are fetched for this
    /// account and `session_ready` is true — it is the account every other
    /// account-scoped surface uses, so the popover must mirror it.
    Active(String),
    /// No active session (the pre-`restore_session` boot gap, or logged out).
    /// The inner value is the persisted row's address when it is a
    /// currently-valid login (shown for display only), else `None`.
    /// Account-scoped calls stay withheld (`session_ready = false`).
    PersistedOnly(Option<String>),
}

/// Resolve which account the tray reports.
///
/// The active session WINS whenever present. On a multi-account device the
/// persisted "latest" row (ordered by `updated_at`) can be a *different*
/// account than the active session — a background token refresh on the other
/// account bumps its `updated_at` — and reporting that stale account is the
/// bug this guards against: the popover then validated the wrong account, fell
/// back to `session_ready = false`, and showed no credits / withheld uploads.
fn resolve_tray_account(active: Option<String>, persisted: Option<String>) -> TrayAccountView {
    match active {
        Some(address) => TrayAccountView::Active(address),
        None => TrayAccountView::PersistedOnly(persisted),
    }
}

/// The substrate address of the most-recently-updated `auth_session` row, but
/// only when that row is a currently-valid login: a non-empty token and an
/// unexpired `token_expiry`.
///
/// [`auth_session_repo::get_latest`] already resolves the token from the OS
/// keychain (the `auth_token` column is NULL for keychain-backed sessions), so
/// its resolved `auth_token` is the authoritative "is there a token" signal.
/// This is consulted only for the tray's boot-gap display fallback.
async fn valid_persisted_address(pool: &sqlx::SqlitePool, now_ms: i64) -> Result<Option<String>> {
    let Some(row) = auth_session_repo::get_latest(pool).await? else {
        return Ok(None);
    };
    let has_token = row.auth_token.as_deref().is_some_and(|t| !t.is_empty());
    let valid = has_token && row.token_expiry.is_none_or(|e| e == 0 || e > now_ms);
    Ok(if valid { row.substrate_address } else { None })
}

/// Fetch the raw credit balance for `account` from the billing API.
///
/// Returns `None` on any HTTP or parse failure: an unreachable or malformed
/// balance is "unknown", not "zero credits".
async fn fetch_credit_balance(api_client: &reqwest::Client, pool: &sqlx::SqlitePool, account: &crate::app_state::SessionAccount) -> Option<f64> {
    match crate::api::client::ApiClient::new(api_client.clone(), pool.clone())
        .get::<serde_json::Value>("/api/billing/credits/balance/", account)
        .await
    {
        Ok(data) => data.get("balance").and_then(|v| v.as_str()).unwrap_or("0").parse::<f64>().ok(),
        Err(_) => None,
    }
}

/// Return pre-computed data for the system tray popover.
///
/// Mirrors the **active in-memory session** — the account the rest of the app
/// (sync, credits, recent uploads) operates on. When no session is hydrated
/// yet (the boot gap before `restore_session`, or logged out) it falls back to
/// the most-recently-updated persisted `auth_session` row for a display-only
/// logged-in indicator, with `session_ready = false` so the popover withholds
/// its account-scoped calls.
#[tauri::command]
pub async fn get_tray_menu_data(state: tauri::State<'_, crate::app_state::AppState>) -> Result<TrayMenuData> {
    let pool = state.pool()?;

    // The active session is authoritative (see `resolve_tray_account`). `.ok()`
    // folds the "no active account" error into `None` — the expected boot-gap /
    // logged-out state, not a failure.
    let active = state.current_account_id().ok();

    // Consult the persisted row only without an active session: it is the
    // boot-gap display fallback, and skipping it in the steady state avoids the
    // per-poll OS-keychain read `get_latest` performs.
    let persisted = match &active {
        Some(_) => None,
        None => valid_persisted_address(pool, chrono::Utc::now().timestamp_millis()).await?,
    };

    match resolve_tray_account(active, persisted) {
        TrayAccountView::Active(address) => {
            // Re-mint the active account as the `SessionAccount` proof the
            // billing client requires. A logout landing between the two auth
            // reads degrades to `None` credits this tick; the next poll
            // corrects it.
            let credits = match state.current_session_account() {
                Ok(account) => fetch_credit_balance(&state.api_client, pool, &account).await,
                Err(_) => None,
            };
            Ok(TrayMenuData {
                logged_in: true,
                substrate_address: Some(address),
                credits,
                session_ready: true,
            })
        }
        TrayAccountView::PersistedOnly(address) => Ok(TrayMenuData {
            logged_in: address.is_some(),
            substrate_address: address,
            credits: None,
            session_ready: false,
        }),
    }
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

    /// The multi-account regression: a background token refresh on the *other*
    /// account makes the persisted "latest" row (ordered by `updated_at`) a
    /// DIFFERENT account than the active session. The popover must report the
    /// ACTIVE account, never the stale latest row — reporting the latter is
    /// what made credits show "—" and withheld the account-scoped uploads.
    #[test]
    fn active_session_wins_over_stale_persisted_row() {
        let view = resolve_tray_account(Some("active-acct".into()), Some("stale-latest-acct".into()));
        assert_eq!(view, TrayAccountView::Active("active-acct".into()));
    }

    #[test]
    fn active_session_used_when_no_persisted_row() {
        let view = resolve_tray_account(Some("active-acct".into()), None);
        assert_eq!(view, TrayAccountView::Active("active-acct".into()));
    }

    /// Boot gap: no active session hydrated yet, so fall back to the persisted
    /// row for a logged-in indicator (scoped calls stay withheld at the call
    /// site via `session_ready = false`).
    #[test]
    fn falls_back_to_persisted_display_during_boot_gap() {
        let view = resolve_tray_account(None, Some("persisted-acct".into()));
        assert_eq!(view, TrayAccountView::PersistedOnly(Some("persisted-acct".into())));
    }

    #[test]
    fn logged_out_when_no_active_and_no_valid_persisted() {
        let view = resolve_tray_account(None, None);
        assert_eq!(view, TrayAccountView::PersistedOnly(None));
    }
}
