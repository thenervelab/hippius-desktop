//! Tauri IPC commands for the VM-connection VPN.
//!
//! These are thin wrappers: all logic lives in [`crate::vpn::state::VpnState`]
//! (unit-tested with a fake engine). Status-change events are NOT emitted here —
//! the `main.rs` bridge task forwards `VpnState` watch transitions to
//! `VPN_STATUS_CHANGED`, so success and error paths surface identically. Commands
//! emit only the `vpn_connection_ready` event and map [`VpnError`] to the
//! frontend's structured error shape (open failures are returned to the awaiting
//! caller, not also broadcast as an event). They are **always registered** —
//! even in builds without the `netbird-vpn` feature — so the FE IPC contract is
//! stable; the disabled engine simply returns `Vpn(UnsupportedBuild)`.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::watch;

use crate::app_state::AppState;
use crate::error::{AppError, NotReadyKind};
use crate::vpn::engine::{LocalEndpoint, MeshStatus, MeshTarget, VPN_SUPPORTED};
use crate::vpn::error::VpnError;
use crate::vpn::{config, events};

/// Forward `VpnState`'s status transitions to the FE as the single
/// `VPN_STATUS_CHANGED` emitter. Spawned once at startup (`main.rs`) with the
/// `VpnState` watch receiver. Status reaches the frontend from one place,
/// regardless of which command (or error path) caused the transition — the
/// commands themselves never emit status. `watch` coalesces, so the FE converges
/// on the latest state rather than seeing every intermediate one; that is fine
/// because the FE renders status as a level. `app.emit` reaches every window.
pub fn spawn_status_bridge(app: AppHandle, mut rx: watch::Receiver<MeshStatus>) {
    tauri::async_runtime::spawn(async move {
        // Mark the seeded initial value as seen so we emit only real transitions
        // (not the startup `Disconnected`).
        let _ = rx.borrow_and_update();
        while rx.changed().await.is_ok() {
            let status = rx.borrow_and_update().clone();
            let _ = app.emit(events::VPN_STATUS_CHANGED, status);
        }
    });
}

/// Status response: the mesh connection state plus whether this build carries a
/// real engine (so the FE can show "unavailable in this build" rather than
/// failing on connect). `MeshStatus` is flattened, yielding e.g.
/// `{"kind":"connected","supported":true}`.
#[derive(Debug, Serialize)]
pub struct VpnStatusInfo {
    #[serde(flatten)]
    pub status: MeshStatus,
    pub supported: bool,
}

/// One active VM forward, for `vpn_list_connections` — lets the FE rehydrate its
/// endpoint view on remount without reopening the proxy.
#[derive(Debug, Serialize)]
pub struct VpnConnectionInfo {
    pub address: String,
    pub port: u16,
    pub endpoint: LocalEndpoint,
}

/// Current VPN status. Never errors — safe to poll on mount.
#[tauri::command]
pub async fn vpn_status(state: State<'_, AppState>) -> Result<VpnStatusInfo, AppError> {
    Ok(VpnStatusInfo {
        status: state.vpn.status_snapshot(),
        supported: VPN_SUPPORTED,
    })
}

/// Connect the desktop peer to the overlay. Resolves the per-tenant credential
/// from the Hippius backend (currently `NotConfigured` until that ships). Status
/// transitions reach the FE via the bridge task, not this command.
#[tauri::command]
pub async fn vpn_connect(state: State<'_, AppState>) -> Result<(), AppError> {
    let cfg = config::resolve_mesh_config(&state).await?;
    state.vpn.connect(cfg).await?;
    Ok(())
}

/// Disconnect the desktop peer and tear down all VM forwards. Idempotent.
#[tauri::command]
pub async fn vpn_disconnect(state: State<'_, AppState>) -> Result<(), AppError> {
    state.vpn.disconnect().await?;
    Ok(())
}

/// Map an `open_vm_connection` failure to the frontend error shape.
///
/// `NotConnected` is a readiness precondition ("connect first"), not a generic
/// failure, so it becomes `NotReady(VpnNotConnected)` — the structured subkind
/// the FE dispatches on, never a substring of the message. Every other variant
/// keeps its typed `VpnError` source chain via `AppError::Vpn`. Pure (no `app`
/// handle) so the contract is unit-testable without a Tauri runtime.
fn map_open_error(e: VpnError) -> AppError {
    match e {
        VpnError::NotConnected => AppError::NotReady(NotReadyKind::VpnNotConnected),
        other => AppError::Vpn(other),
    }
}

/// Open (or reuse) a localhost forward to a VM service over the mesh.
/// Returns the loopback endpoint the app should connect to.
#[tauri::command]
pub async fn vpn_open_vm_connection(app: AppHandle, state: State<'_, AppState>, target: MeshTarget) -> Result<LocalEndpoint, AppError> {
    match state.vpn.open_vm_connection(&target).await {
        Ok(endpoint) => {
            let _ = app.emit(
                events::VPN_CONNECTION_READY,
                events::VpnConnectionReadyPayload {
                    address: target.address.clone(),
                    port: target.port,
                    endpoint: endpoint.clone(),
                },
            );
            Ok(endpoint)
        }
        // The error is returned to the awaiting caller (and surfaced by the FE's
        // catch handler), so we do NOT also emit a `vpn_error` event — that would
        // double-report once a listener exists.
        Err(e) => Err(map_open_error(e)),
    }
}

/// Close a previously opened VM forward. Idempotent.
#[tauri::command]
pub async fn vpn_close_vm_connection(state: State<'_, AppState>, target: MeshTarget) -> Result<(), AppError> {
    state.vpn.close_vm_connection(&target).await?;
    Ok(())
}

/// List the active VM forwards so the FE can rehydrate its endpoint view after a
/// remount (the open proxies persist in Rust; `vpn_connection_ready` only fires
/// at open time).
#[tauri::command]
pub async fn vpn_list_connections(state: State<'_, AppState>) -> Result<Vec<VpnConnectionInfo>, AppError> {
    Ok(state
        .vpn
        .list_connections()
        .into_iter()
        .map(|(target, endpoint)| VpnConnectionInfo {
            address: target.address,
            port: target.port,
            endpoint,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_connected_maps_to_notready_subkind() {
        // The load-bearing wire contract: a "connect first" precondition reaches
        // the FE as the structured NotReady(VpnNotConnected) subkind, not Vpn.
        let mapped = map_open_error(VpnError::NotConnected);
        assert!(matches!(mapped, AppError::NotReady(NotReadyKind::VpnNotConnected)));
    }

    #[test]
    fn other_vpn_errors_keep_their_typed_source() {
        // Everything else stays a typed VpnError under AppError::Vpn so the
        // `source()` chain and the stable `kind: "Vpn"` survive.
        for e in [
            VpnError::Proxy("boom".into()),
            VpnError::Enrollment("denied".into()),
            VpnError::UnsupportedBuild,
        ] {
            assert!(matches!(map_open_error(e), AppError::Vpn(_)));
        }
    }
}
