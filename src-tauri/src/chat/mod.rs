//! Team chat: the Rust half of the desktop Matrix client.
//!
//! The Matrix client itself (sync, timeline, end-to-end encryption via the
//! Rust crypto WASM) runs in the webview — the same vendored-library
//! arrangement as the Polkadot JS API — because the SDK's crypto store,
//! sliding sync and room state machine have no Rust-side consumer here and
//! re-implementing them would be a second Matrix client to keep correct.
//! Everything that touches a secret, the OS, or the Hippius account lives
//! on this side:
//!
//! - [`config`]: the feature gate (decided from the release channel) and
//!   the fixed endpoints/constants, so the frontend carries no copy.
//! - [`keys`]: the secret-storage ("4S") key derived from the account
//!   mnemonic — the cross-client contract with the web console.
//! - [`session`]: the Matrix session (tokens, device) in the OS keyring,
//!   scoped to the active Hippius account, never in a webview store.
//! - [`sign_in`]: the OIDC authorization-code + PKCE bridge with the RFC
//!   8252 loopback redirect, token refresh and sign-out.
//! - [`backend`]: the Hippius-backend proxy calls that need the desktop's
//!   API token — GIF search (and the CDN download of a picked GIF, so it goes
//!   out as an encrypted attachment) and workspace invite links — with every
//!   status the UI branches on mapped to a typed outcome here.
//! - [`attachments`]: writing a decrypted attachment to the path the user
//!   chose (atomic, no silent overwrite); the download and decryption stay
//!   in the webview with the Matrix client that holds the keys.
//!
//! Notifications and the unread badge are wired through the existing
//! `notifications` / `tray` modules (see `notify`).

pub mod attachments;
pub mod backend;
pub mod config;
pub mod keys;
pub mod notify;
pub mod session;
pub mod sign_in;

pub use sign_in::ChatState;
