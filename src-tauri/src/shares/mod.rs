//! File-sharing feature backend.
//!
//! Owns the persistent `share_token → share_key` map ([`keystore`])
//! and the Tauri command surface that wraps
//! [`hcfs_client::client::share`] for create / list / revoke. The
//! recipient side lives in `hippius-console`; this crate only handles
//! the sender flow.

pub mod capabilities;
pub mod client;
pub mod commands;
pub mod history;
pub mod keystore;
pub mod origin;
/// Folder→zip packing for the file-manager folder-share. `unix`-gated because
/// its sole consumer is the macOS + Linux shell-share bridge (`share_directory_as_zip`).
#[cfg(any(unix, windows))]
pub(crate) mod zip_dir;

pub use keystore::SqliteShareKeystore;
