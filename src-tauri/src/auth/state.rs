//! In-memory auth state — keypair and addresses.

use sp_core::sr25519;
use zeroize::Zeroizing;

/// Cryptographic identity derived from the user's BIP-39 mnemonic at login.
///
/// Populated by `login_with_mnemonic` and cleared on logout. The sr25519
/// keypair is used to sign Substrate extrinsics; the addresses are
/// displayed in the UI and used for API authentication.
#[derive(Default)]
pub struct AuthInfo {
    pub sr25519_pair: Option<sr25519::Pair>,
    pub substrate_address: Option<String>,
    pub eth_address: Option<String>,
    /// Master BIP-39 mnemonic for the active session, cached in memory after
    /// `login_with_mnemonic`, `unlock_with_passcode`, or `set_session_mnemonic`.
    /// Wrapped in `Zeroizing` so the bytes are wiped from memory when the
    /// field is dropped or set to `None`.
    ///
    /// `None` for OAuth-only sessions before they generate a mnemonic, and
    /// immediately after a passcode-locked app restart (until the user
    /// re-unlocks).
    pub mnemonic: Option<Zeroizing<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_authinfo_has_no_mnemonic() {
        let auth = AuthInfo::default();
        assert!(auth.mnemonic.is_none());
        assert!(auth.substrate_address.is_none());
    }

    #[test]
    fn authinfo_can_cache_and_clear_mnemonic() {
        let mut auth = AuthInfo::default();
        let m = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        auth.mnemonic = Some(Zeroizing::new(m.to_string()));
        assert_eq!(auth.mnemonic.as_ref().map(|z| z.as_str()), Some(m));
        auth.mnemonic = None;
        assert!(auth.mnemonic.is_none());
    }
}
