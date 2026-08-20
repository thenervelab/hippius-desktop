//! Shared drives (phase 2): grant-blob crypto and the invite/membership IPC
//! layer over hcfs-server's `/v1/drive-invites` + `/v1/drive-memberships` +
//! `/v1/drives/{fh}/members` endpoints (hcfs #348).
//!
//! `grant` owns the cross-client sealing contract (phase 3 console mirrors
//! it); `commands` owns the Tauri IPCs. The sync-engine half of the feature
//! (member drive init, wire-identity resolution) lives in `crate::sync` — this
//! module never touches the engine directly beyond calling its public
//! add/remove/init entry points.

pub mod grant;
