//! Global in-memory authentication state.
//!
//! Holds the derived sr25519 keypair and addresses for the currently
//! logged-in user. Populated by `login_with_mnemonic` / `unlock_with_passcode`,
//! cleared by `auth_logout`. The mnemonic itself is never stored here —
//! only the derived keypair.

use once_cell::sync::Lazy;
use sp_core::sr25519;
use std::sync::Mutex;

pub struct AuthState {
    pub sr25519_pair: Option<sr25519::Pair>,
    pub substrate_address: Option<String>,
    pub eth_address: Option<String>,
}

pub static AUTH_STATE: Lazy<Mutex<AuthState>> = Lazy::new(|| {
    Mutex::new(AuthState {
        sr25519_pair: None,
        substrate_address: None,
        eth_address: None,
    })
});
