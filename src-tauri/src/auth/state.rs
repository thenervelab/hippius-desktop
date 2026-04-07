//! In-memory auth state — keypair and addresses.

use sp_core::sr25519;
use zeroize::Zeroizing;

/// What operations the active session can perform.
///
/// - `Full`: mnemonic-derived; can sign blockchain extrinsics, has the
///   sr25519 keypair in memory.
/// - `OAuthOnly`: OAuth-derived; substrate_address known but no private
///   key — cannot sign extrinsics.
/// - `Restored`: session restored on app boot but the OS keychain did
///   not have a usable mnemonic; same capability surface as `OAuthOnly`
///   plus the recovery path of "log out and re-enter your seed phrase."
///   See the per-variant doc on `Restored` for details.
/// - `None`: no active session.
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthCapabilities {
    /// No active session.
    #[default]
    None,
    /// Mnemonic-derived: can sign extrinsics, has full key material.
    Full,
    /// OAuth-only: substrate_address known, no private keys.
    OAuthOnly,
    /// Session restored from disk on app boot, but the OS keychain did
    /// not have a usable mnemonic for this account (first launch since
    /// keychain shipped, post-logout, Linux without Secret Service, or
    /// keychain corruption). The substrate_address is known but the
    /// sr25519 keypair is not available; signing operations return
    /// `NotReady(SigningKeyUnavailable)` until the user logs out and
    /// re-enters their seed phrase. See [`crate::auth::keychain`] and
    /// `docs/follow-ups/signing-after-restart.md`.
    Restored,
}

/// Cryptographic identity for the active user session.
///
/// Populated by login flows and cleared on logout. The exact set of
/// fields populated depends on `capabilities` — see [`AuthCapabilities`].
/// `substrate_address` is the single source of truth for "who is logged
/// in"; [`crate::app_state::AppState::current_account_id`] reads from it.
#[derive(Default)]
pub struct AuthInfo {
    /// What operations this session can perform. See [`AuthCapabilities`].
    pub capabilities: AuthCapabilities,
    /// sr25519 keypair for signing Substrate extrinsics. `Some` only when
    /// `capabilities == Full`.
    ///
    /// `sp_core::sr25519::Pair` is `pub struct Pair(schnorrkel::Keypair)`,
    /// and `schnorrkel::Keypair` (verified against schnorrkel 0.11.5)
    /// implements both `Zeroize` and `Drop`. The secret bytes are wiped
    /// from memory automatically when this field is set to `None` or
    /// when the containing `AuthInfo` is dropped — no extra newtype is
    /// required.
    pub sr25519_pair: Option<sr25519::Pair>,
    /// Active SS58 address. The single source of truth for the active
    /// account; `None` only when no user is logged in.
    pub substrate_address: Option<String>,
    /// Ethereum address for billing API auth. `Some` only when
    /// `capabilities == Full`.
    pub eth_address: Option<String>,
    /// Master BIP-39 mnemonic for the active session, cached in memory after
    /// `login_with_mnemonic` (mnemonic users) or `ensure_sync_mnemonic`
    /// (OAuth users on first sync). Wrapped in `Zeroizing` so the bytes
    /// are wiped from memory when the field is dropped or set to `None`.
    ///
    /// `None` for OAuth-only sessions before they generate a mnemonic, and
    /// for sessions restored from disk on app restart — the latter must
    /// re-enter their seed phrase before any signing operation will work.
    /// See `docs/follow-ups/signing-after-restart.md`.
    pub mnemonic: Option<Zeroizing<String>>,
}

impl AuthInfo {
    /// Cache a session mnemonic if it belongs to the currently active
    /// account. No-op if `substrate_address` doesn't match (multi-account
    /// safety: prevents a stale cache from one account leaking into another).
    pub fn cache_session_mnemonic(&mut self, account_id: &str, mnemonic: String) {
        if self.substrate_address.as_deref() == Some(account_id) {
            self.mnemonic = Some(Zeroizing::new(mnemonic));
        }
    }
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

    #[test]
    fn cache_session_mnemonic_writes_when_address_matches() {
        let mut auth = AuthInfo {
            substrate_address: Some("addr-A".to_string()),
            ..Default::default()
        };
        auth.cache_session_mnemonic("addr-A", "phrase".into());
        assert_eq!(auth.mnemonic.as_ref().map(|z| z.as_str()), Some("phrase"));
    }

    #[test]
    fn cache_session_mnemonic_skips_when_address_mismatches() {
        let mut auth = AuthInfo {
            substrate_address: Some("addr-A".to_string()),
            ..Default::default()
        };
        auth.cache_session_mnemonic("addr-B", "phrase".into());
        assert!(
            auth.mnemonic.is_none(),
            "must not cache cross-account mnemonic"
        );
    }

    #[test]
    fn cache_session_mnemonic_skips_when_no_active_account() {
        let mut auth = AuthInfo::default();
        auth.cache_session_mnemonic("addr-A", "phrase".into());
        assert!(
            auth.mnemonic.is_none(),
            "must not cache when no active account is set"
        );
    }

    #[test]
    fn default_capabilities_is_none() {
        assert_eq!(AuthInfo::default().capabilities, AuthCapabilities::None);
    }
}
