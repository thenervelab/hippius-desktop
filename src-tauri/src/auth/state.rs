//! In-memory auth state — keypair and addresses.

use sp_core::sr25519;

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
}
