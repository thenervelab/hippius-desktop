//! OS keychain backend for the Hippius API bearer token.
//!
//! Parallel to [`crate::auth::keychain`] (which stores the master BIP-39
//! mnemonic) but scoped to a different service so the two credentials are
//! isolated in the OS store and can't be mixed up by a rogue lookup.
//!
//! Each account's token is stored under `(SERVICE, account_id)`. Callers
//! get a [`TokenKeychainResult`] that distinguishes "no entry stored for
//! this account" from "OS keychain itself is unavailable", mirroring the
//! mnemonic keychain module.
//!
//! ## Backends
//! - **macOS**: Keychain Services.
//! - **Windows**: Credential Manager (DPAPI).
//! - **Linux**: Secret Service via D-Bus. Falls back to
//!   [`TokenKeychainResult::Unavailable`] on headless / minimal-WM systems,
//!   which lets the caller keep using the SQLite DB as a fallback so the
//!   app stays functional without Secret Service.
//!
//! All operations are best-effort. Failures are logged by callers but
//! never break auth flows — the fallback is the DB columns that already
//! exist (`auth_session.auth_token`, `objectstore_auth_scoped.temp_auth_key`).
//! Once the keychain write succeeds, callers should scrub the DB column.

use keyring::Entry;

/// Service name registered in the OS keychain for API tokens. Distinct
/// from the mnemonic service (`com.hippius.desktop`) so a vault audit
/// tool can tell the two apart, and so a misdirected call can't read
/// one credential thinking it's the other.
const SERVICE: &str = "com.hippius.desktop.token";

/// Escape hatch for tests and headless CI. When set to any non-empty
/// value, every keychain call short-circuits to `Unavailable` so the
/// caller falls back to the SQLite column without touching the real
/// OS keychain. Set via `std::env::set_var` in test setup or export
/// in a CI environment where the keychain is unavailable or would
/// pollute developer state.
const DISABLE_ENV_VAR: &str = "HIPPIUS_DISABLE_TOKEN_KEYCHAIN";

fn keychain_disabled() -> bool {
    std::env::var_os(DISABLE_ENV_VAR).is_some_and(|v| !v.is_empty())
}

/// Result of a keychain load operation.
///
/// `Found`   — token bytes present for this account.
/// `NotFound` — the OS keychain is available but has no entry for this
///              account (expected for pre-update users and post-logout).
/// `Unavailable` — the OS keychain itself is inaccessible (Linux without
///              Secret Service, denied permission, etc.). Callers should
///              fall back to the SQLite path in this case.
#[derive(Debug)]
pub enum TokenKeychainResult<T> {
    Found(T),
    NotFound,
    Unavailable(String),
}

/// Store the API token for an account. Idempotent (overwrites existing entry).
pub fn store_token(account_id: &str, token: &str) -> Result<(), String> {
    if keychain_disabled() {
        return Err("token keychain disabled via HIPPIUS_DISABLE_TOKEN_KEYCHAIN".into());
    }
    Entry::new(SERVICE, account_id)
        .map_err(|e| format!("token keychain entry init failed: {e}"))?
        .set_password(token)
        .map_err(|e| format!("token keychain store failed: {e}"))
}

/// Load the API token for an account.
pub fn load_token(account_id: &str) -> TokenKeychainResult<String> {
    if keychain_disabled() {
        return TokenKeychainResult::Unavailable("disabled via HIPPIUS_DISABLE_TOKEN_KEYCHAIN".into());
    }
    let entry = match Entry::new(SERVICE, account_id) {
        Ok(e) => e,
        Err(e) => return TokenKeychainResult::Unavailable(format!("entry init: {e}")),
    };
    match entry.get_password() {
        Ok(pw) => TokenKeychainResult::Found(pw),
        Err(keyring::Error::NoEntry) => TokenKeychainResult::NotFound,
        Err(e) => TokenKeychainResult::Unavailable(format!("get_password: {e}")),
    }
}

/// Delete the entry for an account. Idempotent (no error if absent).
pub fn delete_token(account_id: &str) -> Result<(), String> {
    if keychain_disabled() {
        return Ok(());
    }
    let entry = Entry::new(SERVICE, account_id).map_err(|e| format!("token keychain entry init failed: {e}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("token keychain delete failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Touches the real OS keychain — pops a permission dialog on the
    /// first run on macOS, requires `gnome-keyring-daemon` on Linux.
    /// Run manually with `cargo test -- --ignored`.
    #[test]
    #[ignore = "touches the real OS keychain; run manually with --ignored"]
    fn store_load_delete_roundtrip() {
        const TEST_ACCOUNT: &str = "test-account-token-keychain-roundtrip";
        let test_token = "token_deadbeef_cafebabe_1234567890";

        let _ = delete_token(TEST_ACCOUNT); // clean slate

        store_token(TEST_ACCOUNT, test_token).expect("store should succeed");

        match load_token(TEST_ACCOUNT) {
            TokenKeychainResult::Found(loaded) => assert_eq!(loaded, test_token),
            other => panic!("expected Found, got {other:?}"),
        }

        delete_token(TEST_ACCOUNT).expect("delete should succeed");
        assert!(matches!(load_token(TEST_ACCOUNT), TokenKeychainResult::NotFound));
    }

    #[test]
    #[ignore = "touches the real OS keychain; run manually with --ignored"]
    fn load_returns_not_found_for_missing_entry() {
        const NEVER_STORED: &str = "test-account-token-never-stored-98765";
        let _ = delete_token(NEVER_STORED);
        assert!(matches!(load_token(NEVER_STORED), TokenKeychainResult::NotFound));
    }
}
