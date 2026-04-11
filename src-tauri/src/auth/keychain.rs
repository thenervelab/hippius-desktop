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
//! All operations are best-effort. Failures are logged by callers but
//! never break login/restore/logout — the user falls back to the
//! existing `Restored` capability flow (re-enter seed phrase).

use keyring::Entry;
use zeroize::Zeroizing;

/// Service name registered in the OS keychain.
const SERVICE: &str = "com.hippius.desktop";

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

/// Store the master mnemonic for an account. Idempotent (overwrites
/// existing entry).
pub fn store_mnemonic(account_id: &str, mnemonic: &str) -> Result<(), String> {
    Entry::new(SERVICE, account_id)
        .map_err(|e| format!("keychain entry init failed: {e}"))?
        .set_password(mnemonic)
        .map_err(|e| format!("keychain store failed: {e}"))
}

/// Load the master mnemonic for an account.
///
/// Returns `Found` if present, `NotFound` if no entry exists for this
/// account, `Unavailable` if the OS keychain itself is inaccessible.
pub fn load_mnemonic(account_id: &str) -> KeychainResult<Zeroizing<String>> {
    let entry = match Entry::new(SERVICE, account_id) {
        Ok(e) => e,
        Err(e) => return KeychainResult::Unavailable(format!("entry init: {e}")),
    };
    match entry.get_password() {
        Ok(pw) => KeychainResult::Found(Zeroizing::new(pw)),
        Err(keyring::Error::NoEntry) => KeychainResult::NotFound,
        Err(e) => KeychainResult::Unavailable(format!("get_password: {e}")),
    }
}

/// Delete the entry for an account. Idempotent (no error if absent).
pub fn delete_mnemonic(account_id: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, account_id).map_err(|e| format!("keychain entry init failed: {e}"))?;
    match entry.delete_credential() {
        // `NoEntry` is treated the same as a successful delete — the
        // post-condition (no entry exists) is satisfied either way.
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed: {e}")),
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
        const TEST_ACCOUNT: &str = "test-account-keychain-roundtrip";
        let test_mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

        let _ = delete_mnemonic(TEST_ACCOUNT); // clean slate

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
        assert!(matches!(load_mnemonic(NEVER_STORED), KeychainResult::NotFound));
    }
}
