//! Real NetBird engine, backed by the embedded `netbird-embed` client
//! (NetBird's official `client/embed` in **userspace** mode).
//!
//! Compiled only under `#[cfg(feature = "netbird-vpn")]`, which also pulls the
//! `netbird-embed` crate (and, transitively, the Go/cgo build of NetBird +
//! wireguard-go). Default builds carry none of this and use
//! [`crate::vpn::engine::DisabledEngine`] instead.
//!
//! Userspace mode means **no OS TUN device, no root**: the embedded peer joins
//! the overlay in-process and `start_proxy` exposes a `127.0.0.1:<port>`
//! forward to a VM — only connections the app opens through that endpoint
//! traverse the mesh. `ClientOptions::no_userspace` is left `false`; setting it
//! would create a system TUN (and need elevation), which is deliberately not
//! wanted.

use std::sync::Mutex;

use crate::vpn::engine::{LocalEndpoint, MeshConfig, MeshEngine, MeshTarget};
use crate::vpn::error::VpnError;

/// Owns the embedded NetBird client across its connected lifetime. `None` until
/// [`connect`](MeshEngine::connect), `Some` while connected. `netbird_embed::
/// Client` carries `unsafe impl Send + Sync`, so guarding it with a `Mutex`
/// (for the connect/disconnect single-writer transition) is sound.
pub(crate) struct NetbirdEngine {
    client: Mutex<Option<netbird_embed::Client>>,
}

impl NetbirdEngine {
    pub(crate) fn new() -> Self {
        NetbirdEngine { client: Mutex::new(None) }
    }
}

impl MeshEngine for NetbirdEngine {
    fn connect(&self, cfg: MeshConfig) -> Result<(), VpnError> {
        let mut guard = self.client.lock().map_err(|_| VpnError::Engine("client lock poisoned".to_string()))?;
        if guard.is_some() {
            return Err(VpnError::AlreadyConnected);
        }

        // Userspace peer, setup-key enrollment. Everything else stays at the
        // crate defaults (notably `no_userspace = false`).
        let opts = netbird_embed::ClientOptions {
            management_url: Some(cfg.management_url),
            setup_key: Some(cfg.credential),
            device_name: Some(cfg.device_name),
            ..Default::default()
        };

        let client = netbird_embed::Client::new(opts).map_err(|e| VpnError::Enrollment(e.to_string()))?;
        client.start().map_err(|e| VpnError::Enrollment(e.to_string()))?;
        *guard = Some(client);
        Ok(())
    }

    fn disconnect(&self) -> Result<(), VpnError> {
        let mut guard = self.client.lock().map_err(|_| VpnError::Engine("client lock poisoned".to_string()))?;
        if let Some(client) = guard.take() {
            // Stop explicitly (graceful) before the value drops; `Drop` then
            // frees the Go-side handle. A stop error is non-fatal — we are
            // tearing down regardless, so log-and-continue rather than wedge.
            if let Err(e) = client.stop() {
                tracing::warn!(error = %e, "netbird client stop failed during disconnect");
            }
        }
        Ok(())
    }

    fn open_proxy(&self, target: &MeshTarget) -> Result<LocalEndpoint, VpnError> {
        let guard = self.client.lock().map_err(|_| VpnError::Engine("client lock poisoned".to_string()))?;
        let client = guard.as_ref().ok_or(VpnError::NotConnected)?;

        // `start_proxy` returns the loopback port forwarding to the mesh target.
        let spec = format!("{}:{}", target.address, target.port);
        let port = client.start_proxy(&spec).map_err(|e| VpnError::Proxy(e.to_string()))?;
        Ok(LocalEndpoint {
            host: "127.0.0.1".to_string(),
            port,
        })
    }

    fn close_proxy(&self, _endpoint: &LocalEndpoint) -> Result<(), VpnError> {
        // KNOWN UPSTREAM LIMITATION (tracked): `netbird-embed` 0.3 exposes
        // `start_proxy` but no matching stop — a single forward cannot be torn
        // down individually; all forwards are reaped only when the client stops
        // (`disconnect`). So this is a best-effort `Ok`: the `VpnState` registry
        // forgets the entry (and the FE drops its row), but the Go-side forward
        // and its loopback listener persist until disconnect. Repeated
        // open/close in one session therefore accumulates forwards until then.
        // Closing this needs an upstream per-proxy stop API (or vendoring the
        // crate to add one).
        Ok(())
    }
}
