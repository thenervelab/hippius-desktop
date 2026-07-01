//! App-scoped NetBird VPN for VM connections.
//!
//! This module embeds a NetBird **userspace** mesh peer inside the desktop
//! process so the app can reach Hippius VMs (hosted on HCCS miners, behind NAT)
//! over a self-hosted WireGuard overlay — **without** an OS TUN device, root, a
//! separate binary, or a privileged helper, and **without** touching any of the
//! app's regular network traffic (Hippius API, blockchain, hcfs sync, billing).
//!
//! Only connections explicitly opened via [`state::VpnState::open_vm_connection`]
//! traverse the overlay; each yields a `127.0.0.1:<port>` endpoint the app points
//! SSH/console at (via the cross-platform `start_proxy` primitive, not the
//! Unix-only `dial`).
//!
//! ## Engine abstraction
//!
//! The embedded client is hidden behind the [`engine::MeshEngine`] trait so the
//! command/state layer is unit-testable with a fake and the heavy Go/cgo
//! implementation is swappable + feature-gated:
//!
//! - [`engine::DisabledEngine`] — the default in builds without the `netbird-vpn`
//!   feature; every operation returns [`error::VpnError::UnsupportedBuild`]. This
//!   is the honest production behaviour until the real engine ships.
//! - `netbird_engine::NetbirdEngine` — behind `#[cfg(feature = "netbird-vpn")]`,
//!   drives the embedded `netbird-embed` userspace client (enroll, start,
//!   `start_proxy`); compiled only when that feature pulls the Go/cgo build.
//! - `fake_engine::FakeMeshEngine` — `#[cfg(test)]`, backs unit tests with a real
//!   localhost echo server so the connect → open-proxy → reach flow is exercised
//!   end-to-end with no Go, no network, no VM.
//!
//! See `docs/plans/2026-06-29-netbird-vpn-vm-connections.md`.

pub mod commands;
pub mod config;
pub mod engine;
pub mod error;
pub mod events;
pub mod state;

#[cfg(feature = "netbird-vpn")]
pub mod netbird_engine;

#[cfg(test)]
mod fake_engine;

pub use engine::{LocalEndpoint, MeshConfig, MeshStatus, MeshTarget};
pub use error::VpnError;
pub use state::VpnState;
