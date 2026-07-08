//! Per-OS address for the Finder/Explorer bridge transport.
//!
//! The bridge listens on a platform-native local transport; this module resolves
//! *where*. The address is the only thing that differs per OS — the wire codec
//! ([`super::protocol`]) and the server logic ([`super::socket`]) are shared.
//!
//! - **macOS:** a Unix-domain socket inside the App Group container
//!   (`~/Library/Group Containers/<group>/finder.sock`) — the one directory the
//!   sandboxed Finder extension and the non-sandboxed app both reach. This path
//!   MUST stay byte-identical to `macos/group.env`, the
//!   `com.apple.security.application-groups` entry in `entitlements.plist`, and
//!   `macos/FinderSync.entitlements`, or the extension and app resolve different
//!   containers and never see each other's socket.
//! - **Linux (and other unixes):** a per-user socket under `$XDG_RUNTIME_DIR`
//!   (tmpfs, `0700`, cleaned on logout), falling back to `~/.hippius/`.
//! - **Windows:** a named pipe `\\.\pipe\hippius-finder-<user>` (the pipe
//!   namespace is machine-global, so the user name scopes it per session).

use std::path::PathBuf;

use crate::finder_bridge::error::FinderBridgeError;

/// The App Group identifier shared between the app and the macOS Finder
/// extension. See the byte-identical-copies note in the module docs.
#[cfg(target_os = "macos")]
const APP_GROUP: &str = "V28B5X732P.com.hippius.shared";

/// Filename of the bridge socket inside its directory (Unix platforms).
#[cfg(unix)]
const SOCKET_FILE: &str = "finder.sock";

/// Where the bridge transport listens, resolved per platform. A single-variant
/// enum on each OS (the other arm is compiled out), so matching it in the
/// transport is irrefutable per target rather than a fallible runtime check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Endpoint {
    /// A Unix-domain socket path (macOS App Group container / Linux XDG dir).
    #[cfg(unix)]
    Unix(PathBuf),
    /// A Windows named-pipe name (`\\.\pipe\…`).
    #[cfg(windows)]
    Pipe(String),
}

/// Resolve the platform bridge endpoint.
///
/// # Errors
/// [`FinderBridgeError::NoEndpoint`] if the base directory (home / XDG runtime
/// dir) cannot be resolved on a Unix platform.
pub fn resolve() -> Result<Endpoint, FinderBridgeError> {
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().ok_or(FinderBridgeError::NoEndpoint)?;
        Ok(Endpoint::Unix(home.join("Library").join("Group Containers").join(APP_GROUP).join(SOCKET_FILE)))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Prefer the XDG runtime dir (per-user tmpfs, auto-cleaned); fall back to
        // ~/.hippius when it is unset (some minimal login setups).
        let base = std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".hippius")))
            .ok_or(FinderBridgeError::NoEndpoint)?;
        Ok(Endpoint::Unix(base.join("hippius").join(SOCKET_FILE)))
    }
    #[cfg(windows)]
    {
        // The pipe namespace is machine-global; scope by user so two logged-in
        // users on one machine don't collide. Sanitize to a safe pipe-name leaf.
        let raw = std::env::var("USERNAME").unwrap_or_default();
        let user: String = raw.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
        let user = if user.is_empty() { "default".to_string() } else { user };
        Ok(Endpoint::Pipe(format!(r"\\.\pipe\hippius-finder-{user}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// macOS resolves to the exact App Group socket path the Finder extension
    /// expects. A drift here silently breaks the shipped macOS feature.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_endpoint_is_under_the_group_container() {
        let Endpoint::Unix(path) = resolve().expect("home dir on a test host");
        let shown = path.to_string_lossy();
        assert!(
            shown.ends_with("Library/Group Containers/V28B5X732P.com.hippius.shared/finder.sock"),
            "unexpected macOS socket path: {shown}"
        );
    }

    /// Linux resolves to a `hippius/finder.sock` under a runtime/home base.
    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn linux_endpoint_is_a_hippius_socket() {
        let Endpoint::Unix(path) = resolve().expect("XDG or home dir on a test host");
        let shown = path.to_string_lossy();
        assert!(shown.ends_with("hippius/finder.sock"), "unexpected linux socket path: {shown}");
    }

    /// Windows resolves to a user-scoped pipe under the pipe namespace.
    #[cfg(windows)]
    #[test]
    fn windows_endpoint_is_a_named_pipe() {
        let Endpoint::Pipe(name) = resolve().expect("username on a test host");
        assert!(name.starts_with(r"\\.\pipe\hippius-finder-"), "unexpected pipe name: {name}");
    }
}
