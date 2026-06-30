//! Finder Sync extension ↔ desktop-app bridge (macOS).
//!
//! The native Finder Sync extension (`macos/HippiusFinder`) renders right-click
//! menus and status badges in Finder and forwards the clicked path to the
//! running Hippius app over a Unix-domain socket in the shared App Group
//! container. This module owns the desktop end of that channel.
//!
//! It is layered so the Linux CI `rust` job still compiles and exercises the
//! bug-prone part — the pure wire codec in [`protocol`] (`#[cfg(unix)]`, no
//! sockets, no async). The socket server and App Group container resolution
//! are macOS-only and land in later tasks behind `#[cfg(target_os = "macos")]`.

pub mod protocol;
