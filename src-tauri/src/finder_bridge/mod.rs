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
pub mod enablement;
pub mod endpoint;
pub mod error;
pub mod protocol;
pub mod resolve;
pub mod socket;

/// `--finder-share <path>` CLI mode: the Linux file-manager action files invoke
/// the main binary in this short-lived second mode to forward a click over the
/// bridge socket (the one-binary requirement — no separate helper). `unix` so it
/// compiles alongside the socket transport; only the Linux shims call it.
#[cfg(unix)]
pub mod cli;

/// Boot-time startup + inbound-click drain. Active on all desktop platforms
/// (macOS/Linux Unix-socket bridge + Windows named-pipe bridge); it stores the
/// bridge in `AppState` and runs inside the Tauri async runtime.
#[cfg(any(unix, windows))]
pub mod lifecycle;

/// Inbound-click → share dispatch + drive-root registration. Portable (reaches
/// the platform-agnostic share engine); active alongside `lifecycle`.
#[cfg(any(unix, windows))]
pub mod dispatch;
