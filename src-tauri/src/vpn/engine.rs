//! The [`MeshEngine`] abstraction plus its plain data types and the default
//! (disabled) implementation.
//!
//! `MeshEngine` methods are **synchronous and blocking** on purpose: the real
//! NetBird implementation drives a Go/cgo client whose calls block the calling
//! thread, so the async layer ([`crate::vpn::state::VpnState`]) is responsible
//! for running them on `tokio::task::spawn_blocking`. Keeping the trait sync
//! also keeps it object-safe (`Arc<dyn MeshEngine>`) without pulling in
//! `async-trait`.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::vpn::error::VpnError;

/// Where to reach the mesh and how to authenticate the desktop peer.
///
/// Built internally by [`crate::vpn::config::resolve_mesh_config`] — never
/// deserialized from the frontend, because the credential is a secret minted by
/// the Hippius backend.
#[derive(Clone)]
pub struct MeshConfig {
    /// Self-hosted NetBird management server URL.
    pub management_url: String,
    /// Per-tenant enrollment credential (setup key or JWT). Treated as a
    /// secret: redacted from `Debug` and never logged.
    pub credential: String,
    /// Peer name for this desktop in the NetBird dashboard. Resolved from the
    /// app's device-name source (`sync::device::get_device_name_internal`) so it
    /// matches the identity the rest of the app maintains and the backend can
    /// locate the enrolled peer.
    pub device_name: String,
}

impl std::fmt::Debug for MeshConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the credential — Debug output can reach logs.
        f.debug_struct("MeshConfig")
            .field("management_url", &self.management_url)
            .field("credential", &"<redacted>")
            .field("device_name", &self.device_name)
            .finish()
    }
}

/// A single VM service to reach over the overlay.
#[derive(Debug, Clone, Deserialize)]
pub struct MeshTarget {
    /// Overlay address of the VM peer (the `nebula_ip` successor reported by
    /// the VM API).
    pub address: String,
    /// Service port on the VM (e.g. `22` for SSH).
    pub port: u16,
}

impl MeshTarget {
    /// Stable map key for the active-proxy registry. One forward per
    /// address+port pair.
    pub(crate) fn key(&self) -> String {
        format!("{}:{}", self.address, self.port)
    }

    /// Reject obviously malformed targets before they reach the engine.
    ///
    /// A zero port can never name a service, and an empty/whitespace address
    /// would produce a nonsensical proxy. This is a cheap guard, not a full
    /// hostname/IP grammar — the engine validates the address against the live
    /// overlay roster.
    pub(crate) fn validate(&self) -> Result<(), VpnError> {
        if self.address.trim().is_empty() {
            return Err(VpnError::InvalidTarget("address is empty".into()));
        }
        if self.address.contains(char::is_whitespace) {
            return Err(VpnError::InvalidTarget("address contains whitespace".into()));
        }
        if self.port == 0 {
            return Err(VpnError::InvalidTarget("port must be non-zero".into()));
        }
        Ok(())
    }
}

/// A localhost endpoint forwarding over the mesh to a [`MeshTarget`].
/// Serialized to the frontend, which renders `host:port` (e.g. an SSH command).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LocalEndpoint {
    pub host: String,
    pub port: u16,
}

/// Connection state of the embedded mesh peer.
///
/// Tagged wire form (`{"kind":"connected"}`) mirrors `sync::drive_status::
/// DriveStatus` so the frontend matches on `kind` and a future variant can be
/// added without breaking it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MeshStatus {
    Disconnected,
    Connecting,
    Connected,
    Error { message: String },
}

/// The embedded mesh peer. See the module docs for the sync/blocking contract.
pub(crate) trait MeshEngine: Send + Sync {
    /// Enroll + connect the desktop peer to the overlay.
    fn connect(&self, cfg: MeshConfig) -> Result<(), VpnError>;
    /// Leave the overlay and tear down any active proxies.
    fn disconnect(&self) -> Result<(), VpnError>;
    /// Stand up a localhost forward to `target` over the mesh; return the
    /// loopback endpoint to connect to.
    fn open_proxy(&self, target: &MeshTarget) -> Result<LocalEndpoint, VpnError>;
    /// Tear down a previously opened forward.
    fn close_proxy(&self, endpoint: &LocalEndpoint) -> Result<(), VpnError>;
}

/// The engine used when the `netbird-vpn` feature is absent: every operation
/// reports [`VpnError::UnsupportedBuild`]. `disconnect`/`close_proxy` are
/// no-op-`Ok` so teardown paths stay idempotent.
///
/// Constructed by [`default_engine`] only in non-feature builds, and by the
/// `state` unit tests in every config. In a `--features netbird-vpn` build of
/// the lib alone (no tests) it is therefore unreferenced — the cross-`cfg`
/// usage the dead-code lint can't see, so suppress it just for that case.
#[cfg_attr(feature = "netbird-vpn", allow(dead_code))]
pub(crate) struct DisabledEngine;

impl MeshEngine for DisabledEngine {
    fn connect(&self, _cfg: MeshConfig) -> Result<(), VpnError> {
        Err(VpnError::UnsupportedBuild)
    }
    fn disconnect(&self) -> Result<(), VpnError> {
        Ok(())
    }
    fn open_proxy(&self, _target: &MeshTarget) -> Result<LocalEndpoint, VpnError> {
        Err(VpnError::UnsupportedBuild)
    }
    fn close_proxy(&self, _endpoint: &LocalEndpoint) -> Result<(), VpnError> {
        Ok(())
    }
}

/// Whether this build carries a real mesh engine. Surfaced to the frontend in
/// the status response so the UI can show "VPN unavailable in this build"
/// instead of failing on connect.
pub(crate) const VPN_SUPPORTED: bool = cfg!(feature = "netbird-vpn");

/// Construct the engine for this build. `netbird-vpn` → the real embedded
/// NetBird engine; otherwise the disabled engine.
pub(crate) fn default_engine() -> Arc<dyn MeshEngine> {
    #[cfg(feature = "netbird-vpn")]
    {
        Arc::new(crate::vpn::netbird_engine::NetbirdEngine::new())
    }
    #[cfg(not(feature = "netbird-vpn"))]
    {
        Arc::new(DisabledEngine)
    }
}
