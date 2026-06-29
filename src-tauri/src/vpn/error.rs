//! Typed error taxonomy for the VPN module.
//!
//! Follows the project error-category discipline (see the `wallet/` module): a
//! typed, `#[non_exhaustive]` enum with `thiserror`, propagated into
//! [`crate::error::AppError`] via `#[from]` rather than collapsing into
//! `AppError::Other(String)`. The command layer maps
//! [`VpnError::NotConnected`] to `AppError::NotReady(VpnNotConnected)` so the
//! frontend can render a "connect first" affordance via the structured
//! `subkind`, never via substring matching.

/// Failures from the embedded mesh engine and the VPN command layer.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum VpnError {
    /// The `netbird-vpn` Cargo feature is not compiled into this build, so no
    /// real mesh engine is available. Returned by `DisabledEngine`.
    #[error("VPN is not available in this build")]
    UnsupportedBuild,

    /// No desktop-peer credential is available yet. The credential is minted by
    /// the Hippius backend (setup key / JWT); until that endpoint exists,
    /// `config::resolve_mesh_config` returns this.
    #[error("VPN is not configured")]
    NotConfigured,

    /// A VM connection was requested before the mesh peer was connected.
    /// Mapped to `AppError::NotReady(VpnNotConnected)` at the command layer.
    #[error("VPN is not connected")]
    NotConnected,

    /// Connect was requested while already connected.
    #[error("VPN is already connected")]
    AlreadyConnected,

    /// The requested VM connection target failed validation (empty address,
    /// zero port, etc.).
    #[error("invalid VM connection target: {0}")]
    InvalidTarget(String),

    /// Enrolling the desktop peer into the overlay failed.
    #[error("mesh enrollment failed: {0}")]
    Enrollment(String),

    /// Standing up / tearing down a localhost proxy to a VM failed.
    #[error("mesh proxy error: {0}")]
    Proxy(String),

    /// A lower-level engine failure (e.g. a blocking engine task panicked).
    #[error("mesh engine error: {0}")]
    Engine(String),
}
