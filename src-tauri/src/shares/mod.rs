//! File-sharing feature backend.
//!
//! Owns the persistent `share_token → share secret` map ([`keystore`])
//! and the Tauri command surface that wraps
//! [`hcfs_client::client::share`] for create / list / revoke. The
//! recipient side lives in `hippius-console`; this crate only handles
//! the sender flow.

pub mod capabilities;
pub mod client;
pub mod commands;
pub mod comment_crypto;
pub mod expiry_date;
pub(crate) mod file_link_key;
pub mod folder_insights;
pub(crate) mod folder_scan;
pub mod gate;
pub mod history;
pub mod insights;
pub mod insights_csv;
pub mod keystore;
pub mod link_activity;
pub mod link_alerts;
pub mod nda;
pub mod nda_records;
pub mod origin;
pub mod outside_folder;
pub(crate) mod owner_wrap;
pub mod preview;
pub mod quick_link;
pub mod recipients;
pub mod viewer_visits;

pub use keystore::SqliteShareKeystore;
