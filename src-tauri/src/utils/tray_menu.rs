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
    /// The same balance as the billing API's exact decimal string (one
    /// credit is one dollar). The popover formats it as dollars with
    /// `formatBalanceUsd`, the formatter the Billing page uses, so the two
    /// cannot quote one account a cent apart; `credits` is an `f64` and
    /// would round before the cents are taken.
    pub balance: Option<String>,
    /// Who the account signs in as, for an OAuth account: `@handle` for
    /// GitHub, the email for Google / Apple, else the username. `None` for
    /// an access-key (mnemonic) account, which has no identity beyond its
    /// address, so the popover keeps the address + block layout.
    pub account_label: Option<String>,
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

/// Fetch the credit balance for `account` from the billing API, as the
/// API's own decimal string.
///
/// Returns `None` on any HTTP or parse failure: an unreachable or malformed
/// balance is "unknown", not "zero credits".
async fn fetch_credit_balance(api_client: &reqwest::Client, pool: &sqlx::SqlitePool, account: &crate::app_state::SessionAccount) -> Option<String> {
    match crate::api::client::ApiClient::new(api_client.clone(), pool.clone())
        .get::<serde_json::Value>("/api/billing/credits/balance/", account)
        .await
    {
        Ok(data) => parse_balance(&data),
        Err(_) => None,
    }
}

/// The `balance` field of a billing-API balance response, as a plain
/// decimal the popover's formatter reads. A missing field reads as zero (the
/// API omits it for an account that has never been funded); anything that is
/// not a number is unknown. A number the API writes another way (`0E-18`, a
/// sign, a JSON number) is rewritten digit for digit by [`plain_decimal`],
/// never through a float: the formatter only reads plain digits, and showed
/// "---" for an empty balance written as `0E-18`.
fn parse_balance(data: &serde_json::Value) -> Option<String> {
    match data.get("balance") {
        None | Some(serde_json::Value::Null) => Some("0".into()),
        Some(serde_json::Value::String(raw)) => plain_decimal(raw),
        Some(serde_json::Value::Number(n)) => plain_decimal(&n.to_string()),
        Some(_) => None,
    }
}

/// `raw` (an optional sign, digits with an optional point, an optional
/// `e`/`E` exponent) as a plain decimal: no exponent, no `+`, no leading or
/// trailing zeros beyond one before the point, and zero never negative.
/// `None` for anything else. Exact: the digits are moved, never computed.
fn plain_decimal(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let (negative, rest) = match raw.as_bytes().first()? {
        b'-' => (true, &raw[1..]),
        b'+' => (false, &raw[1..]),
        _ => (false, raw),
    };
    let (mantissa, exponent) = match rest.find(['e', 'E']) {
        Some(i) => (&rest[..i], rest[i + 1..].parse::<i32>().ok()?),
        None => (rest, 0),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    if whole.is_empty() && fraction.is_empty() {
        return None;
    }
    if !whole.bytes().chain(fraction.bytes()).all(|b| b.is_ascii_digit()) {
        return None;
    }
    // A huge exponent is not a balance; refuse it rather than allocate.
    if exponent.unsigned_abs() > 64 {
        return None;
    }
    let digits = format!("{whole}{fraction}");
    let point = i64::try_from(whole.len()).ok()? + i64::from(exponent);
    let (int_part, frac_part) = if point <= 0 {
        (String::new(), format!("{}{digits}", "0".repeat(usize::try_from(-point).ok()?)))
    } else if usize::try_from(point).ok()? >= digits.len() {
        (
            format!("{digits}{}", "0".repeat(usize::try_from(point).ok()? - digits.len())),
            String::new(),
        )
    } else {
        let at = usize::try_from(point).ok()?;
        (digits[..at].to_string(), digits[at..].to_string())
    };
    let int_part = int_part.trim_start_matches('0');
    let frac_part = frac_part.trim_end_matches('0');
    let int_part = if int_part.is_empty() { "0" } else { int_part };
    let zero = int_part == "0" && frac_part.is_empty();
    let sign = if negative && !zero { "-" } else { "" };
    Some(if frac_part.is_empty() {
        format!("{sign}{int_part}")
    } else {
        format!("{sign}{int_part}.{frac_part}")
    })
}

/// The label an OAuth account is known by, mirroring the main window's
/// `resolveAccountIdentity` (`app/components/dashboard-title-wrapper/
/// accountIdentity.ts`) so the popover and the sidebar card name one account
/// the same way: GitHub signs in as a handle, Google and Apple with an email,
/// and the username is the fallback. A placeholder email
/// (`@hippius.local`) counts as none.
///
/// `None` for an access-key account (`provider` absent or `"mnemonic"`): it
/// has no sign-in identity, and its address is what identifies it.
fn sign_in_label(provider: Option<&str>, username: Option<&str>, email: Option<&str>) -> Option<String> {
    let provider = provider.map(str::trim).filter(|p| !p.is_empty() && *p != "mnemonic")?;
    let username = username.map(str::trim).filter(|u| !u.is_empty());
    let handle = if provider == "github" {
        username.map(|u| format!("@{u}"))
    } else {
        crate::utils::display_email::display_email(email)
    };
    handle.or_else(|| username.map(str::to_string))
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
            let balance = match state.current_session_account() {
                Ok(account) => fetch_credit_balance(&state.api_client, pool, &account).await,
                Err(_) => None,
            };
            // A failed identity read degrades to the address layout this
            // tick rather than failing the whole popover refresh.
            let account_label = match auth_session_repo::get_identity(pool, &address).await {
                Ok(Some(id)) => sign_in_label(id.provider.as_deref(), id.username.as_deref(), id.email.as_deref()),
                Ok(None) => None,
                Err(e) => {
                    tracing::debug!(error = %e, "tray: could not read the sign-in identity");
                    None
                }
            };
            Ok(TrayMenuData {
                logged_in: true,
                substrate_address: Some(address),
                credits: balance.as_deref().and_then(|b| b.parse::<f64>().ok()),
                balance,
                account_label,
                session_ready: true,
            })
        }
        TrayAccountView::PersistedOnly(address) => Ok(TrayMenuData {
            logged_in: address.is_some(),
            substrate_address: address,
            credits: None,
            balance: None,
            account_label: None,
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
            balance: Some("12.5".into()),
            account_label: Some("a@b.com".into()),
            session_ready: false,
        };
        let json = serde_json::to_value(&data).expect("serialize");
        assert_eq!(json["loggedIn"], true);
        assert_eq!(json["substrateAddress"], "5Frholdaddr");
        assert_eq!(json["credits"], 12.5);
        assert_eq!(json["sessionReady"], false);
        assert_eq!(json["balance"], "12.5");
        assert_eq!(json["accountLabel"], "a@b.com");
    }

    /// The popover shows "Balance $x.yy" from this string, so it must be the
    /// API's exact decimal, not a float re-rendered (which would turn
    /// "737553.122357" into a value already rounded off by `f64`).
    #[test]
    fn balance_keeps_the_api_decimal_string() {
        let data = serde_json::json!({ "balance": "737553.122357" });
        assert_eq!(parse_balance(&data).as_deref(), Some("737553.122357"));
        assert_eq!(parse_balance(&serde_json::json!({})).as_deref(), Some("0"));
        assert_eq!(parse_balance(&serde_json::json!({ "balance": "n/a" })), None);
        assert_eq!(parse_balance(&serde_json::json!({ "balance": null })).as_deref(), Some("0"));
        assert_eq!(parse_balance(&serde_json::json!({ "balance": 0 })).as_deref(), Some("0"));
        assert_eq!(parse_balance(&serde_json::json!({ "balance": 12.5 })).as_deref(), Some("12.5"));
        assert_eq!(parse_balance(&serde_json::json!({ "balance": true })), None);
    }

    /// An empty balance written the way a decimal column prints it (`0E-18`)
    /// showed "---" in the popover: the formatter reads plain digits only.
    #[test]
    fn a_balance_in_any_number_form_becomes_a_plain_decimal() {
        for (raw, plain) in [
            ("0", "0"),
            ("0E-18", "0"),
            ("0e-18", "0"),
            ("-0", "0"),
            ("0.000000000000000000", "0"),
            ("1.5E+2", "150"),
            ("1.5e-3", "0.0015"),
            ("12E2", "1200"),
            ("-0.50", "-0.5"),
            ("+3.25", "3.25"),
            (".5", "0.5"),
            ("5.", "5"),
            ("007.10", "7.1"),
            ("737553.122357", "737553.122357"),
            (" 2 ", "2"),
        ] {
            assert_eq!(plain_decimal(raw).as_deref(), Some(plain), "{raw}");
        }
        for bad in ["", "-", ".", "e5", "1e", "1.2.3", "1,000", "abc", "1e999", "--1"] {
            assert_eq!(plain_decimal(bad), None, "{bad}");
        }
    }

    /// An access-key account keeps the address layout: it has no sign-in
    /// identity, and its stored username is not one the user chose.
    #[test]
    fn access_key_accounts_have_no_sign_in_label() {
        assert_eq!(sign_in_label(Some("mnemonic"), Some("user_5abc"), None), None);
        assert_eq!(sign_in_label(None, Some("user_5abc"), Some("a@b.com")), None);
    }

    /// Same resolution as the sidebar card's `resolveAccountIdentity`.
    #[test]
    fn oauth_accounts_are_named_by_how_they_sign_in() {
        assert_eq!(
            sign_in_label(Some("google"), Some("ahmad"), Some(" a@b.com ")).as_deref(),
            Some("a@b.com")
        );
        assert_eq!(sign_in_label(Some("apple"), Some("ahmad"), Some("a@b.com")).as_deref(), Some("a@b.com"));
        assert_eq!(sign_in_label(Some("github"), Some("octo"), Some("a@b.com")).as_deref(), Some("@octo"));
        // A placeholder email is not an address anyone can write to.
        assert_eq!(
            sign_in_label(Some("google"), Some("ahmad"), Some("user_5x@hippius.local")).as_deref(),
            Some("ahmad")
        );
        assert_eq!(sign_in_label(Some("oauth"), None, Some("a@b.com")).as_deref(), Some("a@b.com"));
        assert_eq!(sign_in_label(Some("google"), None, None), None);
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
