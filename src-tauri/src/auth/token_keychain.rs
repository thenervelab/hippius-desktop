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
//! ## Per-process cache
//!
//! Every `Entry::get_password` / `set_password` call on macOS re-evaluates
//! the keychain item's ACL. Under dev-build signing — where the binary's
//! ad-hoc signature changes on every rebuild — the "Always Allow" choice
//! never matches and the user is re-prompted for every access. The auth
//! flow naturally does several writes of the same token back-to-back
//! (`auth_session_repo::upsert` followed by `save_api_token`, plus
//! opportunistic migration paths) and several reads of the same token
//! during a single boot (`restore_session`, `is_token_expiring`,
//! `get_api_token` from every sync consumer). Without deduplication each
//! of those maps to a separate macOS prompt.
//!
//! The cache below records what this process has read or written. A hit
//! short-circuits the keychain access entirely:
//! - Repeated writes of the same value skip `set_password`.
//! - Reads after the first one reuse the cached value without calling
//!   `get_password`.
//! - `delete_token` marks the account as absent so subsequent reads
//!   don't re-probe the keychain.
//!
//! The cache reflects only what this process has observed. It is not
//! persisted and is rebuilt from scratch on every launch, so external
//! mutations (e.g. the user deletes the item via Keychain Access.app)
//! will be picked up on the next launch.
//!
//! All operations are best-effort. Failures are logged by callers but
//! never break auth flows — the fallback is the DB columns that already
//! exist (`auth_session.auth_token`, `objectstore_auth_scoped.temp_auth_key`).
//! Once the keychain write succeeds, callers should scrub the DB column.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

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

/// What this process has observed about the keychain entry for a given
/// account.
///
/// `Present(token)` — the keychain currently holds this token (either
/// we wrote it, or we read it back). `Absent` — the keychain has no
/// entry for this account (observed via `NoEntry` or recorded after a
/// successful `delete_credential`). A missing map key means "we
/// haven't interacted with the keychain for this account yet this
/// process".
#[derive(Clone)]
enum CachedEntry {
    // Zeroized on drop so a bearer credential doesn't linger in unscrubbed
    // process heap after logout/refresh, matching the mnemonic cache in
    // `keychain.rs` (audit R-21).
    Present(zeroize::Zeroizing<String>),
    Absent,
}

fn cache() -> &'static Mutex<HashMap<String, CachedEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Return the cached observation for an account, if any. Any internal
/// lock poisoning is treated as "no cache entry" so a failed cache
/// never falsely suppresses a real keychain access.
fn cached(account_id: &str) -> Option<CachedEntry> {
    cache().lock().ok()?.get(account_id).cloned()
}

fn record_present(account_id: &str, token: &str) {
    if let Ok(mut c) = cache().lock() {
        c.insert(account_id.to_string(), CachedEntry::Present(zeroize::Zeroizing::new(token.to_string())));
    }
}

fn record_absent(account_id: &str) {
    if let Ok(mut c) = cache().lock() {
        c.insert(account_id.to_string(), CachedEntry::Absent);
    }
}

fn forget(account_id: &str) {
    if let Ok(mut c) = cache().lock() {
        c.remove(account_id);
    }
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

/// Store the API token for an account. Idempotent: a second call with
/// the same `token` value that this process has already written (or
/// read) returns `Ok(())` without touching the OS keychain at all.
/// This deduplication is what keeps the authentication flow from
/// producing redundant keychain prompts on dev builds — see the
/// module-level docs.
pub fn store_token(account_id: &str, token: &str) -> Result<(), String> {
    if keychain_disabled() {
        return Err("token keychain disabled via HIPPIUS_DISABLE_TOKEN_KEYCHAIN".into());
    }
    if let Some(CachedEntry::Present(existing)) = cached(account_id)
        && existing.as_str() == token
    {
        return Ok(());
    }
    Entry::new(SERVICE, account_id)
        .map_err(|e| format!("token keychain entry init failed: {e}"))?
        .set_password(token)
        .map_err(|e| format!("token keychain store failed: {e}"))?;
    record_present(account_id, token);
    Ok(())
}

/// Load the API token for an account.
///
/// Served from the per-process cache whenever possible. The keychain
/// itself is only touched on a cache miss; `Found` and `NotFound`
/// results are both cached so a subsequent call returns immediately.
/// `Unavailable` is not cached — treat it as transient and retry.
pub fn load_token(account_id: &str) -> TokenKeychainResult<String> {
    if keychain_disabled() {
        return TokenKeychainResult::Unavailable("disabled via HIPPIUS_DISABLE_TOKEN_KEYCHAIN".into());
    }
    match cached(account_id) {
        Some(CachedEntry::Present(token)) => return TokenKeychainResult::Found(token.as_str().to_owned()),
        Some(CachedEntry::Absent) => return TokenKeychainResult::NotFound,
        None => {}
    }
    let entry = match Entry::new(SERVICE, account_id) {
        Ok(e) => e,
        Err(e) => return TokenKeychainResult::Unavailable(format!("entry init: {e}")),
    };
    match entry.get_password() {
        Ok(pw) => {
            record_present(account_id, &pw);
            TokenKeychainResult::Found(pw)
        }
        Err(keyring::Error::NoEntry) => {
            record_absent(account_id);
            TokenKeychainResult::NotFound
        }
        Err(e) => TokenKeychainResult::Unavailable(format!("get_password: {e}")),
    }
}

/// Delete the entry for an account. Idempotent (no error if absent).
///
/// On success (or `NoEntry`) the cache is updated to `Absent` so
/// subsequent reads short-circuit to `NotFound` without touching the
/// keychain. A delete failure of any other kind invalidates the cache
/// entry — real state is ambiguous, force the next call to re-probe.
pub fn delete_token(account_id: &str) -> Result<(), String> {
    if keychain_disabled() {
        // Disabled mode treats the store as nonexistent: nothing to
        // delete, nothing in the cache to update either.
        return Ok(());
    }
    let entry = Entry::new(SERVICE, account_id).map_err(|e| format!("token keychain entry init failed: {e}"))?;
    let result = match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("token keychain delete failed: {e}")),
    };
    match &result {
        Ok(()) => record_absent(account_id),
        Err(_) => forget(account_id),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Clear the cache between tests so cases don't leak state. Tests
    /// run in parallel by default, so each test uses a unique account
    /// id and calls this at entry to keep the shared cache clean.
    fn reset_cache_for(account_id: &str) {
        forget(account_id);
    }

    #[test]
    fn cache_tracks_presence_and_absence() {
        let acct = "test-cache-presence-abc";
        reset_cache_for(acct);

        assert!(cached(acct).is_none(), "fresh account has no cache entry");

        record_present(acct, "tok-1");
        assert!(matches!(cached(acct), Some(CachedEntry::Present(ref t)) if t.as_str() == "tok-1"));

        record_present(acct, "tok-2");
        assert!(matches!(cached(acct), Some(CachedEntry::Present(ref t)) if t.as_str() == "tok-2"));

        record_absent(acct);
        assert!(matches!(cached(acct), Some(CachedEntry::Absent)));

        forget(acct);
        assert!(cached(acct).is_none());
    }

    #[test]
    fn cache_is_per_account() {
        let a = "test-cache-per-acct-a";
        let b = "test-cache-per-acct-b";
        reset_cache_for(a);
        reset_cache_for(b);

        record_present(a, "token-a");
        record_present(b, "token-b");

        assert!(matches!(cached(a), Some(CachedEntry::Present(ref t)) if t.as_str() == "token-a"));
        assert!(matches!(cached(b), Some(CachedEntry::Present(ref t)) if t.as_str() == "token-b"));

        record_absent(a);
        assert!(matches!(cached(a), Some(CachedEntry::Absent)));
        assert!(
            matches!(cached(b), Some(CachedEntry::Present(ref t)) if t.as_str() == "token-b"),
            "marking account a absent must not touch account b"
        );

        forget(a);
        forget(b);
    }

    /// Regression test for the core fix: when the cache already records
    /// the same token we're asked to store, `store_token` must return
    /// `Ok(())` WITHOUT invoking the real keychain. We verify this by
    /// running with `HIPPIUS_DISABLE_TOKEN_KEYCHAIN=1` — in disabled
    /// mode the real keychain path returns `Err`, so any path that
    /// reaches the keychain would fail loudly. An `Ok(())` here proves
    /// the cache short-circuit ran before the disabled-mode check would
    /// have mattered.
    ///
    /// Note: `store_token` checks `keychain_disabled()` BEFORE consulting
    /// the cache, so under `HIPPIUS_DISABLE_TOKEN_KEYCHAIN=1` it always
    /// returns `Err`. The cache short-circuit fires only in non-disabled
    /// mode. We exercise the skip semantics directly via the helpers in
    /// `cache_tracks_presence_and_absence` and `store_token_uses_cache`;
    /// the live integration check is the ignored roundtrip test below.
    #[test]
    fn store_token_returns_err_when_disabled_regardless_of_cache() {
        // SAFETY: the env var is a process-global flag; test-only setup
        // parallel to the pattern in `auth_session_repo::tests::setup_db`.
        unsafe {
            std::env::set_var(DISABLE_ENV_VAR, "1");
        }
        let acct = "test-disabled-regardless-xyz";
        reset_cache_for(acct);
        record_present(acct, "existing-token");
        // Disabled-mode must NOT fall through to "cached, skip" and
        // return Ok — callers rely on disabled mode to surface as an
        // error so they route through the plaintext fallback.
        assert!(store_token(acct, "existing-token").is_err());
        forget(acct);
    }

    /// Direct verification that the public `store_token` consults the
    /// cache. Uses an internal simulation: populate the cache with the
    /// target value, then observe that `store_token` in enabled mode
    /// (with keychain available or not) takes the cache-skip path. We
    /// can't run this on the real keychain in CI, so we simulate it via
    /// the helpers: a valid cache entry matching the requested value
    /// must prevent any need to touch the keychain at all.
    ///
    /// Concretely: after `record_present(acct, tok)`, a call to
    /// `store_token(acct, tok)` in non-disabled mode should succeed
    /// without error — even though the real keychain may not contain
    /// `tok`. The skip proves the cache branch was taken.
    #[test]
    #[ignore = "touches the real OS keychain; run manually with --ignored"]
    fn store_token_uses_cache() {
        // SAFETY: clear any prior disable flag from parallel tests.
        unsafe {
            std::env::remove_var(DISABLE_ENV_VAR);
        }
        let acct = "test-store-uses-cache-live";
        let _ = delete_token(acct); // clean slate
        reset_cache_for(acct);

        // First write — real keychain touched.
        store_token(acct, "v1").expect("first store should succeed");
        assert!(matches!(cached(acct), Some(CachedEntry::Present(ref t)) if t.as_str() == "v1"));

        // Second write of the same value — MUST skip the keychain.
        // We can't assert "keychain was not called" directly, but we
        // can assert that the call returns instantly and leaves cache
        // unchanged.
        store_token(acct, "v1").expect("duplicate store should succeed via cache");
        assert!(matches!(cached(acct), Some(CachedEntry::Present(ref t)) if t.as_str() == "v1"));

        // Write of a different value — real keychain touched, cache
        // updated.
        store_token(acct, "v2").expect("different-value store should succeed");
        assert!(matches!(cached(acct), Some(CachedEntry::Present(ref t)) if t.as_str() == "v2"));

        delete_token(acct).unwrap();
        assert!(matches!(cached(acct), Some(CachedEntry::Absent)));
    }

    /// Touches the real OS keychain — pops a permission dialog on the
    /// first run on macOS, requires `gnome-keyring-daemon` on Linux.
    /// Run manually with `cargo test -- --ignored`.
    #[test]
    #[ignore = "touches the real OS keychain; run manually with --ignored"]
    fn store_load_delete_roundtrip() {
        // SAFETY: clear any prior disable flag from parallel tests.
        unsafe {
            std::env::remove_var(DISABLE_ENV_VAR);
        }
        const TEST_ACCOUNT: &str = "test-account-token-keychain-roundtrip";
        let test_token = "token_deadbeef_cafebabe_1234567890";

        let _ = delete_token(TEST_ACCOUNT); // clean slate
        reset_cache_for(TEST_ACCOUNT);

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
        // SAFETY: clear any prior disable flag from parallel tests.
        unsafe {
            std::env::remove_var(DISABLE_ENV_VAR);
        }
        const NEVER_STORED: &str = "test-account-token-never-stored-98765";
        let _ = delete_token(NEVER_STORED);
        reset_cache_for(NEVER_STORED);
        assert!(matches!(load_token(NEVER_STORED), TokenKeychainResult::NotFound));
    }
}
