//! File-manager extension ↔ desktop-app bridge.
//!
//! A native shell extension renders the right-click menu (macOS Finder Sync
//! extension today; Windows Explorer / Linux file managers next) and forwards
//! the clicked path to the running Hippius app over a platform transport — a
//! Unix-domain socket on macOS/Linux, a named pipe on Windows. This module owns
//! the desktop end of that channel.
//!
//! The shared, portable core — the wire codec ([`protocol`]), the transport
//! server ([`socket`]), path resolution ([`resolve`]), and endpoint resolution
//! ([`endpoint`]) — compiles and is tested on macOS, Linux, and Windows. The
//! active click→share plumbing ([`lifecycle`] / [`dispatch`]) is enabled by the
//! native shim per platform.

pub mod commands;
pub mod endpoint;
pub mod error;
pub mod protocol;
pub mod resolve;
pub mod socket;

/// Boot-time startup + inbound-click drain. Active on macOS + Linux (`unix` —
/// both drive the Unix-socket bridge); it stores the bridge in `AppState` and
/// runs inside the Tauri async runtime. Windows joins once its COM-DLL shim ships.
#[cfg(unix)]
pub mod lifecycle;

/// Inbound-click → share dispatch + drive-root registration. Portable (reaches
/// the platform-agnostic share engine); active on `unix` alongside `lifecycle`.
#[cfg(unix)]
pub mod dispatch;
