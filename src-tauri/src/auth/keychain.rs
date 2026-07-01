//! OS keychain backend for storing the master BIP-39 mnemonic so
//! returning users don't have to re-enter their seed phrase to sign
//! blockchain extrinsics.
//!
//! Wraps the `keyring` crate. Each user's mnemonic is stored under
//! `(SERVICE, account_id)` so multiple Hippius accounts on one machine
//! stay isolated.
//!
//! ## Backends
//! - **macOS**: Keychain Services. First read may pop a one-time
//!   "Allow always" dialog; silent thereafter.
//! - **Windows**: Credential Manager (DPAPI). Encrypted with the user's
//!   Windows session keys; silent.
//! - **Linux**: Secret Service via D-Bus. Requires `gnome-keyring-daemon`
//!   or equivalent; falls back to `KeychainResult::Unavailable` on
//!   headless or minimal-WM systems.
//!
//! ## Per-process cache
//!
//! Mirrors the cache documented in [`crate::auth::token_keychain`].
//! Same motivation: dev-build signing doesn't preserve the macOS
//! "Always Allow" ACL across rebuilds, so every redundant keychain
//! touch re-prompts the user. The cache below records reads and writes
//! so a repeat of either is served from memory.
//!
//! All operations are best-effort. Failures are logged by callers but
//! never break login/restore/logout — the user falls back to the
//! existing `Restored` capability flow (re-enter seed phrase).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use keyring::Entry;
use zeroize::Zeroizing;

/// Service name registered in the OS keychain.
const SERVICE: &str = "com.hippius.desktop";

/// Escape hatch for tests and headless CI. When set to any non-empty value,
/// every keychain call short-circuits without touching the real OS keychain.
/// Parallels [`crate::auth::token_keychain`]'s `HIPPIUS_DISABLE_TOKEN_KEYCHAIN`
/// so a login/restore test (which writes the master mnemonic on success) can't
/// leave residue in the developer's macOS Keychain or pop a dialog.
const DISABLE_ENV_VAR: &str = "HIPPIUS_DISABLE_MNEMONIC_KEYCHAIN";

fn keychain_disabled() -> bool {
    std::env::var_os(DISABLE_ENV_VAR).is_some_and(|v| !v.is_empty())
}

/// What this process has observed about the keychain entry for a given
/// account. The mnemonic string is wrapped in [`Zeroizing`] so it is
/// scrubbed from memory when the cache entry is overwritten or the
/// process exits.
#[derive(Clone)]
enum CachedEntry {
    Present(Zeroizing<String>),
    Absent,
}

fn cache() -> &'static Mutex<HashMap<String, CachedEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached(account_id: &str) -> Option<CachedEntry> {
    cache().lock().ok()?.get(account_id).cloned()
}

fn record_present(account_id: &str, mnemonic: &str) {
    if let Ok(mut c) = cache().lock() {
        c.insert(account_id.to_string(), CachedEntry::Present(Zeroizing::new(mnemonic.to_string())));
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
/// Distinguishes "no entry stored for this account" from "OS keychain
/// itself is unavailable" so callers can dispatch:
/// - `Found` → use the mnemonic to rehydrate `AuthInfo`
/// - `NotFound` → first launch since keychain integration shipped, OR
///   user previously logged out from this device. Fall back to `Restored`.
/// - `Unavailable` → Linux without Secret Service, denied permission,
///   etc. Same fallback as `NotFound` but logged at warn level.
#[derive(Debug)]
pub enum KeychainResult<T> {
    Found(T),
    NotFound,
    Unavailable(String),
}

/// Store the master mnemonic for an account. Idempotent: a second call
/// with the same value that this process has already written (or read)
/// returns `Ok(())` without touching the OS keychain — see the
/// module-level docs for why this matters on dev builds.
pub fn store_mnemonic(account_id: &str, mnemonic: &str) -> Result<(), String> {
    // Disabled mode is a silent no-op: unlike the API token there is no DB
    // fallback to route to — keychain persistence is a pure convenience
    // (skip the seed-phrase re-prompt next launch), so "not persisted" is a
    // valid outcome the caller already treats as non-fatal.
    if keychain_disabled() {
        return Ok(());
    }
    if let Some(CachedEntry::Present(existing)) = cached(account_id)
        && existing.as_str() == mnemonic
    {
        return Ok(());
    }
    Entry::new(SERVICE, account_id)
        .map_err(|e| format!("keychain entry init failed: {e}"))?
        .set_password(mnemonic)
        .map_err(|e| format!("keychain store failed: {e}"))?;
    record_present(account_id, mnemonic);
    Ok(())
}

/// Load the master mnemonic for an account.
///
/// Served from the per-process cache whenever possible. The keychain
/// itself is only touched on a cache miss; `Found` and `NotFound` are
/// both cached so subsequent calls return without hitting the OS.
/// `Unavailable` is not cached — treat it as transient and retry.
///
/// Returns `Found` if present, `NotFound` if no entry exists for this
/// account, `Unavailable` if the OS keychain itself is inaccessible.
pub fn load_mnemonic(account_id: &str) -> KeychainResult<Zeroizing<String>> {
    if keychain_disabled() {
        return KeychainResult::Unavailable("disabled via HIPPIUS_DISABLE_MNEMONIC_KEYCHAIN".into());
    }
    match cached(account_id) {
        Some(CachedEntry::Present(m)) => return KeychainResult::Found(m),
        Some(CachedEntry::Absent) => return KeychainResult::NotFound,
        None => {}
    }
    let entry = match Entry::new(SERVICE, account_id) {
        Ok(e) => e,
        Err(e) => return KeychainResult::Unavailable(format!("entry init: {e}")),
    };
    match entry.get_password() {
        Ok(pw) => {
            record_present(account_id, &pw);
            KeychainResult::Found(Zeroizing::new(pw))
        }
        Err(keyring::Error::NoEntry) => {
            record_absent(account_id);
            KeychainResult::NotFound
        }
        Err(e) => KeychainResult::Unavailable(format!("get_password: {e}")),
    }
}

/// Delete the entry for an account. Idempotent (no error if absent).
///
/// On success (or `NoEntry`) the cache is updated to `Absent` so
/// subsequent reads short-circuit to `NotFound` without touching the
/// keychain. A delete failure of any other kind invalidates the cache
/// entry — the real keychain state is ambiguous, force the next call
/// to re-probe.
pub fn delete_mnemonic(account_id: &str) -> Result<(), String> {
    if keychain_disabled() {
        // Disabled mode treats the store as nonexistent: nothing to delete.
        return Ok(());
    }
    let entry = Entry::new(SERVICE, account_id).map_err(|e| format!("keychain entry init failed: {e}"))?;
    let result = match entry.delete_credential() {
        // `NoEntry` is treated the same as a successful delete — the
        // post-condition (no entry exists) is satisfied either way.
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed: {e}")),
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

    fn reset_cache_for(account_id: &str) {
        forget(account_id);
    }

    #[test]
    fn cache_tracks_presence_and_absence() {
        let acct = "test-mnemonic-cache-presence-abc";
        reset_cache_for(acct);

        assert!(cached(acct).is_none());

        record_present(acct, "phrase-one");
        assert!(matches!(cached(acct), Some(CachedEntry::Present(ref m)) if m.as_str() == "phrase-one"));

        record_present(acct, "phrase-two");
        assert!(matches!(cached(acct), Some(CachedEntry::Present(ref m)) if m.as_str() == "phrase-two"));

        record_absent(acct);
        assert!(matches!(cached(acct), Some(CachedEntry::Absent)));

        forget(acct);
        assert!(cached(acct).is_none());
    }

    #[test]
    fn cache_is_per_account() {
        let a = "test-mnemonic-cache-per-acct-a";
        let b = "test-mnemonic-cache-per-acct-b";
        reset_cache_for(a);
        reset_cache_for(b);

        record_present(a, "phrase-a");
        record_present(b, "phrase-b");

        assert!(matches!(cached(a), Some(CachedEntry::Present(ref m)) if m.as_str() == "phrase-a"));
        assert!(matches!(cached(b), Some(CachedEntry::Present(ref m)) if m.as_str() == "phrase-b"));

        record_absent(a);
        assert!(matches!(cached(a), Some(CachedEntry::Absent)));
        assert!(
            matches!(cached(b), Some(CachedEntry::Present(ref m)) if m.as_str() == "phrase-b"),
            "marking account a absent must not touch account b"
        );

        forget(a);
        forget(b);
    }

    /// The `HIPPIUS_DISABLE_MNEMONIC_KEYCHAIN` guard must make every public
    /// op a no-op that never touches the real OS keychain — store reports
    /// success without caching, load reports `Unavailable`, delete succeeds.
    /// This is the seam the `login_with_mnemonic` orchestration test relies on
    /// to run without leaving a master mnemonic in the developer's Keychain.
    ///
    /// Safe alongside the parallel non-ignored tests in this module: they only
    /// exercise the cache helpers, never the guarded store/load/delete fns, so
    /// the brief process-global flag window can't disturb them.
    #[test]
    fn disabled_flag_makes_every_op_a_noop() {
        let acct = "test-mnemonic-disabled-noop-acct";
        forget(acct);
        // SAFETY: process-global env mutation with a deterministic value,
        // restored before return — mirrors `token_keychain`'s disabled test.
        unsafe {
            std::env::set_var(DISABLE_ENV_VAR, "1");
        }

        // Store is a silent success that does NOT populate the cache — proof
        // it short-circuited before any keychain or cache write.
        assert!(store_mnemonic(acct, "phrase-should-not-persist").is_ok());
        assert!(cached(acct).is_none(), "disabled store must not touch the cache");

        assert!(
            matches!(load_mnemonic(acct), KeychainResult::Unavailable(_)),
            "disabled load must report Unavailable so restore falls back to re-prompt"
        );
        assert!(delete_mnemonic(acct).is_ok(), "disabled delete is a no-op success");

        // SAFETY: restore the process-global flag so later tests in this
        // binary see the default (enabled) state — mirrors `token_keychain`.
        unsafe {
            std::env::remove_var(DISABLE_ENV_VAR);
        }
        forget(acct);
    }

    /// Touches the real OS keychain — pops a permission dialog on the
    /// first run on macOS, requires `gnome-keyring-daemon` on Linux.
    /// Run manually with `cargo test -- --ignored`.
    #[test]
    #[ignore = "touches the real OS keychain; run manually with --ignored"]
    fn store_load_delete_roundtrip() {
        const TEST_ACCOUNT: &str = "test-account-keychain-roundtrip";
        let test_mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

        let _ = delete_mnemonic(TEST_ACCOUNT); // clean slate
        reset_cache_for(TEST_ACCOUNT);

        store_mnemonic(TEST_ACCOUNT, test_mnemonic).expect("store should succeed");

        match load_mnemonic(TEST_ACCOUNT) {
            KeychainResult::Found(loaded) => assert_eq!(loaded.as_str(), test_mnemonic),
            other => panic!("expected Found, got {other:?}"),
        }

        delete_mnemonic(TEST_ACCOUNT).expect("delete should succeed");
        assert!(matches!(load_mnemonic(TEST_ACCOUNT), KeychainResult::NotFound));
    }

    #[test]
    #[ignore = "touches the real OS keychain; run manually with --ignored"]
    fn load_returns_not_found_for_missing_entry() {
        const NEVER_STORED: &str = "test-account-never-stored-12345";
        let _ = delete_mnemonic(NEVER_STORED); // belt-and-suspenders
        reset_cache_for(NEVER_STORED);
        assert!(matches!(load_mnemonic(NEVER_STORED), KeychainResult::NotFound));
    }

    /// Verify the live roundtrip also exercises the cache: after a
    /// store, a load reads from the cache not the OS keychain, and
    /// after a delete the cache returns NotFound without re-probing.
    #[test]
    #[ignore = "touches the real OS keychain; run manually with --ignored"]
    fn cache_short_circuits_repeat_ops() {
        const ACCT: &str = "test-account-mnemonic-cache-live";
        let phrase = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";

        let _ = delete_mnemonic(ACCT);
        reset_cache_for(ACCT);

        // First store — real keychain write, cache populated.
        store_mnemonic(ACCT, phrase).unwrap();
        assert!(matches!(cached(ACCT), Some(CachedEntry::Present(_))));

        // Duplicate store — cache hit, no keychain write.
        store_mnemonic(ACCT, phrase).unwrap();

        // Load — cache hit, no keychain read.
        let KeychainResult::Found(loaded) = load_mnemonic(ACCT) else {
            panic!("expected Found");
        };
        assert_eq!(loaded.as_str(), phrase);

        // Delete — cache set to Absent, subsequent loads short-circuit.
        delete_mnemonic(ACCT).unwrap();
        assert!(matches!(cached(ACCT), Some(CachedEntry::Absent)));
        assert!(matches!(load_mnemonic(ACCT), KeychainResult::NotFound));
    }
}
