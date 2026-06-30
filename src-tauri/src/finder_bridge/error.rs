//! Typed error taxonomy for the Finder bridge.
//!
//! Follows the project's error-category discipline (mirrors `vpn/error.rs`): a
//! typed `#[non_exhaustive]` enum with `thiserror`. In Phase 1 the socket
//! server is a background task, so these surface via `tracing` logs rather than
//! a Tauri command return; the `#[from] AppError` wiring lands when a share
//! command first propagates it to the frontend.

use crate::finder_bridge::protocol::ProtocolError;

/// Failures from the Finder bridge socket server.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum FinderBridgeError {
    /// Binding the socket or creating its parent directory failed.
    #[error("finder bridge socket I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// A wire line from the extension failed to parse.
    #[error("finder bridge protocol error: {0}")]
    Protocol(#[from] ProtocolError),

    /// The macOS App Group container path could not be resolved (no home dir).
    #[error("could not resolve the App Group container path")]
    NoContainer,
}
