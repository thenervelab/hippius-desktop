//! Nebula VPN subsystem — download, install, certificates, process lifecycle.
//!
//! The core implementation is in `core.rs` (moved from utils/nebula.rs).
//! `state.rs` holds the runtime state, `vpn.rs` holds the toggle command.

pub mod manager;
pub mod state;
pub mod vpn;
