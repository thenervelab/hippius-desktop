//! Typed error taxonomy for the Finder bridge.
//!
//! Follows the project's error-category discipline (mirrors `vpn/error.rs`): a
//! typed `#[non_exhaustive]` enum with `thiserror`. In Phase 1 the socket
//! server is a background task, so these surface via `tracing` logs rather than
//! a Tauri command return; the `#[from] AppError` wiring lands when a share
//! command first propagates it to the frontend.

use crate::finder_bridge::protocol::ProtocolError;

/// Failures from the Finder bridge transport server.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum FinderBridgeError {
    /// Binding the socket/pipe or creating its parent directory failed.
    #[error("finder bridge transport I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// A wire line from the extension failed to parse.
    #[error("finder bridge protocol error: {0}")]
    Protocol(#[from] ProtocolError),

    /// The platform bridge endpoint could not be resolved — on Unix the base
    /// directory (home / `$XDG_RUNTIME_DIR`) was unavailable.
    #[error("could not resolve the bridge endpoint")]
    NoEndpoint,
}
