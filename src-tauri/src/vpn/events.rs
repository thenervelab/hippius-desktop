//! Event-name constants and payload structs emitted to the frontend.
//!
//! Pinned here next to where they cross the Tauri IPC boundary (same discipline
//! as `sync::events`), so the FE contract is one place. `app.emit` reaches every
//! window, including the tray popover.

use serde::Serialize;

use crate::vpn::engine::LocalEndpoint;

/// Fired whenever the mesh peer transitions state. Payload is the serialized
/// [`crate::vpn::engine::MeshStatus`] (tagged `{"kind":...}`).
pub const VPN_STATUS_CHANGED: &str = "vpn_status_changed";

/// Fired when a VM connection's localhost forward is ready.
pub const VPN_CONNECTION_READY: &str = "vpn_connection_ready";

/// Payload for [`VPN_CONNECTION_READY`]: the requested VM target plus the
/// loopback endpoint the app should connect to.
#[derive(Debug, Clone, Serialize)]
pub struct VpnConnectionReadyPayload {
    /// Overlay address of the VM that was reached.
    pub address: String,
    /// VM service port that was forwarded.
    pub port: u16,
    /// Localhost endpoint forwarding to the VM.
    pub endpoint: LocalEndpoint,
}
