//! Devices: the phones and computers linked to the account (hcfs-server
//! `/v1/devices`).
//!
//! - [`registration`]: this computer registers itself, stays linked, follows
//!   its own renames, and signs out when another device unlinks it.
//! - [`commands`]: Settings › Devices (list, unlink).
//! - [`file_details`]: the file details panel's capture dates, camera and
//!   "Uploaded from" device.
//!
//! The pinned hcfs-client has no devices calls, so [`api`] and [`wire`] are
//! the desktop's own, read strictly (see `wire`).

pub mod api;
pub mod commands;
pub mod file_details;
pub mod registration;
pub mod store;
pub mod wire;
