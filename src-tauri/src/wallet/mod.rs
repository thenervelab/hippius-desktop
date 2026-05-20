//! Local-wallet feature: persisted, password-encrypted Substrate wallets.
//!
//! The legacy `feature/wallet-updates` branch put this whole layer in TS
//! (sql.js for storage, CryptoJS for encryption, `@polkadot/keyring` for
//! address derivation). Per CLAUDE.md we keep persistence + crypto + key
//! derivation in Rust. The IPC surface in [`commands`] is the only thing the
//! FE talks to.

pub mod commands;
pub mod crypto;
pub mod repo;
