//! Authentication, identity, and credential storage.
//!
//! Handles mnemonic/passcode login, OAuth flow, billing API auth,
//! key derivation, challenge-response signing, and session persistence.

pub mod account_key;
pub mod accounts;
pub mod billing_auth;
pub mod contacts;
pub mod login;
pub mod oauth;
pub mod service;
pub mod session;
pub mod ssh_keys;
pub mod state;
pub mod tokens;
