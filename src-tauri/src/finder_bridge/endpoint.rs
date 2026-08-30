//! Per-OS address for the Finder/Explorer bridge transport.
//!
//! The bridge listens on a platform-native local transport; this module resolves
//! *where*. The address is the only thing that differs per OS — the wire codec
//! ([`super::protocol`]) and the server logic ([`super::socket`]) are shared.
//!
//! - **macOS:** a Unix-domain socket in the app's own directory
//!   (`~/.hippius/finder.sock`), deliberately NOT an App Group container. Since
//!   macOS 15 any non-sandboxed process that touches `~/Library/Group
//!   Containers/` trips the `kTCCServiceSystemPolicyAppData` consent prompt
//!   ("Hippius would like to access data from other apps"), and this app is
//!   non-sandboxed by design — `pluginkit(8)` calls fail from inside a sandbox
//!   (see `finder_bridge::enablement`). The container therefore cost one dialog
//!   on EVERY launch, with no entitlement to opt out of the service. The
//!   sandboxed extension reaches this path through the SBPL exceptions in
//!   `macos/FinderSync.entitlements` instead, which is what Google Drive's own
//!   Finder extension does — it claims no App Group at all. This path MUST stay
//!   byte-identical to `HippiusFinderSync.socketPath()` on the Swift side;
//!   pinned by `tests/finder_socket_pins.rs`.
//! - **Linux (and other unixes):** a per-user socket under `$XDG_RUNTIME_DIR`
//!   (tmpfs, `0700`, cleaned on logout), falling back to `~/.hippius/`.
//! - **Windows:** a named pipe `\\.\pipe\hippius-finder-<user>` (the pipe
//!   namespace is machine-global, so the user name scopes it per session).

use std::path::PathBuf;

use crate::finder_bridge::error::FinderBridgeError;

/// The app's own per-user state directory (alongside `logs/`, `preview-cache/`).
#[cfg(target_os = "macos")]
const HIPPIUS_DIR: &str = ".hippius";

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
        // No `$XDG_RUNTIME_DIR` equivalent on macOS, and the sandboxed extension
        // resolves the same path from the password database (`NSHomeDirectory()`
        // is container-redirected inside an .appex), so the real home is the one
        // location both ends can agree on without an App Group.
        let home = dirs::home_dir().ok_or(FinderBridgeError::NoEndpoint)?;
        Ok(Endpoint::Unix(home.join(HIPPIUS_DIR).join(SOCKET_FILE)))
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

    /// macOS resolves to the exact socket path the Finder extension expects. A
    /// drift here silently breaks the shipped macOS feature.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_endpoint_is_in_the_app_directory() {
        let Endpoint::Unix(path) = resolve().expect("home dir on a test host");
        let shown = path.to_string_lossy();
        assert!(shown.ends_with(".hippius/finder.sock"), "unexpected macOS socket path: {shown}");
    }

    /// The socket must never move back under `~/Library/Group Containers/`: the
    /// non-sandboxed app touching that tree is what raised a TCC "access data
    /// from other apps" prompt on every single launch.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_endpoint_avoids_the_group_container() {
        let Endpoint::Unix(path) = resolve().expect("home dir on a test host");
        let shown = path.to_string_lossy();
        assert!(
            !shown.contains("Group Containers"),
            "the bridge socket is back inside an App Group container ({shown}), which costs a TCC \
             consent prompt on every launch — see this module's docs"
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
