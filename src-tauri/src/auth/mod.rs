//! Authentication, identity, and credential storage.
//!
//! Handles mnemonic/passcode login, OAuth flow, billing API auth,
//! key derivation, challenge-response signing, and session persistence.

pub mod account_key;
pub mod auth_session_repo;
pub mod billing_auth;
pub mod contacts;
pub mod keychain;
pub mod login;
pub mod logout;
pub mod oauth;
pub mod service;
pub mod session_restore;
pub mod ssh_keys;
pub mod state;
pub mod tokens;
